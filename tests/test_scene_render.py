"""Tests for modules.scene_render — scene-level render + render cache (PR 1.3).

What is pinned here:
  * scene windows follow the IR's measured times, snapped to frames, covering
    0 → end of narration with no gaps; a scene without times is refused;
  * the cache key changes with each input that decides a scene's pixels, and
    only with those;
  * a re-run reuses every cached scene, and after ONE scene changes only that
    scene is rendered again (proved by counting renderer calls);
  * a failed scene render never leaves a file a later run would reuse;
  * graphic recipes still go to ffmpeg unless Remotion is available;
  * render_dispatch: flag off → untouched; flag on → scenes backend; any
    failure → the configured backend renders, with the reason recorded;
  * with a real ffmpeg (imageio-ffmpeg): the assembled video is as long as the
    narration (within 0.5 s — in fact frame-exact) and carries the audio.
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import render_dispatch, scene_render, video_ir
from modules.render_spec import KIND_COLOR
from modules.video_ir import AssetRef, AudioRef, Scene, Shot, VideoProject

try:
    import imageio_ffmpeg

    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:  # pragma: no cover - imageio-ffmpeg ships with moviepy
    FFMPEG = None


def _project(root: Path, *, narrations=("one", "two", "three"), times=((0, 4), (4, 9), (9, 12)),
             audio_s=12.0, fps=30, assets=None, scene_assets=None, recipes=None, subs=None):
    if assets is None:
        assets = []
        for name in ("a", "b"):
            p = root / f"{name}.jpg"
            if not p.exists():
                p.write_bytes(f"image {name}".encode())
            assets.append(AssetRef(id=f"a_{name}", kind="image", path=str(p)))
    scene_assets = scene_assets or {0: ("a_a",), 1: ("a_b",), 2: ("a_a", "a_b")}
    scenes = tuple(
        Scene(id=video_ir.scene_id(i), index=i, narration=n, start_s=t[0], end_s=t[1],
              shot=Shot(recipe=(recipes or {}).get(i, "slow_push")),
              asset_ids=tuple(scene_assets.get(i, ())))
        for i, (n, t) in enumerate(zip(narrations, times)))
    audio = root / "audio.mp3"
    if not audio.exists():
        audio.write_bytes(b"audio")
    return VideoProject(slug="demo", width=320, height=180, fps=fps,
                        audio=AudioRef(path=str(audio), duration_s=audio_s),
                        subtitles_path=subs, scenes=scenes, assets=tuple(assets))


class CountingRenderer:
    """Fake scene renderer: writes a small file, counts calls per scene."""

    def __init__(self, fail_on=()):
        self.calls = []
        self.fail_on = set(fail_on)

    def __call__(self, job, project, out_path):
        self.calls.append(job.scene_id)
        Path(out_path).write_bytes(b"partial")
        if job.scene_id in self.fail_on:
            raise RuntimeError("boom")
        Path(out_path).write_bytes(f"scene {job.scene_id} {job.key}".encode())
        return out_path


def fake_assemble(project, jobs, output_path, *, subtitles_path=None):
    Path(output_path).write_bytes(b"".join(Path(j.path).read_bytes() for j in jobs))
    return output_path


class WindowsTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_windows_follow_measured_times_and_cover_the_narration(self):
        p = _project(self.root, times=((0.5, 4.013), (4.2, 9.0), (9.0, 11.5)), audio_s=12.0)
        wins = [(s.id, a, b) for s, a, b in scene_render.scene_windows(p)]
        # Leading silence → first scene; gap 4.013..4.2 → previous scene; tail → last scene.
        self.assertEqual(wins, [("s000", 0, 126), ("s001", 126, 270), ("s002", 270, 360)])

    def test_null_times_refuse_scene_render(self):
        p = _project(self.root, times=((0, 4), (None, None), (9, 12)))
        with self.assertRaises(scene_render.SceneRenderError):
            scene_render.scene_windows(p)

    def test_segments_are_frame_exact(self):
        assets = list(_project(self.root).assets)
        segs = scene_render.scene_segments(assets, 137, 30, 2.0)
        self.assertEqual(sum(scene_render.segment_frames(s, 30) for s in segs), 137)
        self.assertEqual([Path(s.path).name for s in segs][:3], ["a.jpg", "b.jpg", "a.jpg"])
        # A sliver (< 0.1 s) is folded into the previous cut, never its own shot.
        segs = scene_render.scene_segments(assets, 61, 30, 2.0)
        self.assertEqual([scene_render.segment_frames(s, 30) for s in segs], [61])

    def test_no_usable_asset_is_a_colour_fill_not_an_empty_scene(self):
        segs = scene_render.scene_segments([], 90, 30, 5.0)
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0].kind, KIND_COLOR)
        self.assertEqual(scene_render.segment_frames(segs[0], 30), 90)


class CacheKeyTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.assets = [AssetRef(id="a_x", kind="image", path=str(self.root / "x.jpg"),
                                sha256="abc")]
        self.base = dict(narration="n", assets=self.assets, recipe="slow_push", duration_s=4.0,
                         width=1920, height=1080, fps=30, cut_s=5.0, style=None, backend="ffmpeg")

    def tearDown(self):
        self.tmp.cleanup()

    def test_stable(self):
        self.assertEqual(scene_render.cache_key(**self.base), scene_render.cache_key(**self.base))

    def test_every_input_changes_the_key(self):
        k0 = scene_render.cache_key(**self.base)
        changes = {
            "narration": "other", "recipe": "parallax", "duration_s": 4.1, "width": 1280,
            "height": 720, "fps": 25, "cut_s": 3.0, "style": "dark", "backend": "remotion",
            "assets": [AssetRef(id="a_x", kind="image", path=self.assets[0].path, sha256="def")],
        }
        for name, value in changes.items():
            with self.subTest(changed=name):
                self.assertNotEqual(scene_render.cache_key(**{**self.base, name: value}), k0)

    def test_without_sha256_the_file_itself_decides(self):
        f = self.root / "clip.jpg"
        f.write_bytes(b"one")
        a = AssetRef(id="a_c", kind="image", path=str(f))
        k1 = scene_render.cache_key(**{**self.base, "assets": [a]})
        f.write_bytes(b"a different, longer file")
        k2 = scene_render.cache_key(**{**self.base, "assets": [a]})
        self.assertNotEqual(k1, k2)


class CacheBehaviourTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / "out" / "final_video.mp4"

    def tearDown(self):
        self.tmp.cleanup()

    def run_once(self, project, renderer):
        return scene_render.render_project(project, self.out,
                                           renderers={"ffmpeg": renderer},
                                           assemble_fn=fake_assemble)

    def test_first_run_misses_then_everything_hits(self):
        p = _project(self.root)
        first = CountingRenderer()
        r1 = self.run_once(p, first)
        self.assertEqual(first.calls, ["s000", "s001", "s002"])
        self.assertEqual((r1.cache_hits, r1.cache_misses), ([], ["s000", "s001", "s002"]))
        names = sorted(f.name for f in (self.out.parent / "scenes").iterdir())
        self.assertEqual(len(names), 3)
        self.assertTrue(all(n.startswith(("s000-", "s001-", "s002-")) and n.endswith(".mp4")
                            for n in names))

        second = CountingRenderer()
        r2 = self.run_once(p, second)
        self.assertEqual(second.calls, [])
        self.assertEqual(r2.cache_hits, ["s000", "s001", "s002"])
        self.assertEqual(r2.to_metadata()["cache_misses"], 0)
        self.assertTrue(self.out.exists())

    def test_only_the_changed_scene_is_rendered_again(self):
        self.run_once(_project(self.root), CountingRenderer())
        changed = _project(self.root, narrations=("one", "two, rewritten", "three"))
        again = CountingRenderer()
        r = self.run_once(changed, again)
        self.assertEqual(again.calls, ["s001"])
        self.assertEqual(r.cache_hits, ["s000", "s002"])
        self.assertEqual(r.to_metadata()["rendered_scene_ids"], ["s001"])

    def test_a_changed_asset_rerenders_only_the_scenes_that_use_it(self):
        self.run_once(_project(self.root), CountingRenderer())
        (self.root / "b.jpg").write_bytes(b"a re-generated image b, different bytes")
        again = CountingRenderer()
        self.run_once(_project(self.root), again)
        self.assertEqual(again.calls, ["s001", "s002"])   # s000 uses only a.jpg

    def test_changed_timing_rerenders_the_scenes_whose_window_moved(self):
        self.run_once(_project(self.root), CountingRenderer())
        again = CountingRenderer()
        self.run_once(_project(self.root, times=((0, 4), (4, 9.5), (9.5, 12))), again)
        self.assertEqual(again.calls, ["s001", "s002"])

    def test_a_failed_scene_leaves_nothing_to_reuse(self):
        p = _project(self.root)
        with self.assertRaises(RuntimeError):
            self.run_once(p, CountingRenderer(fail_on={"s001"}))
        scenes = self.out.parent / "scenes"
        self.assertEqual(sorted(f.name[:4] for f in scenes.iterdir()), ["s000"])
        retry = CountingRenderer()
        self.run_once(p, retry)
        self.assertEqual(retry.calls, ["s001", "s002"])

    def test_invalid_ir_is_refused(self):
        p = _project(self.root, scene_assets={0: ("a_missing",)})
        with self.assertRaises(scene_render.SceneRenderError):
            self.run_once(p, CountingRenderer())


class BackendChoiceTestCase(unittest.TestCase):
    def test_everything_renders_with_ffmpeg_today(self):
        for recipe in ("slow_push", "broll_cut", "quote_card", "stat_counter", None, "bogus"):
            scene = Scene(id="s000", index=0, shot=Shot(recipe=recipe))
            self.assertEqual(scene_render.choose_backend(scene), "ffmpeg")
        # Remotion is registered but not available unless CHRONOS_REMOTION=1.
        with mock.patch.dict(os.environ, {"CHRONOS_REMOTION": ""}):
            self.assertEqual(scene_render.available_backends(), ("ffmpeg",))

    def test_hook_routes_graphic_recipes_once_remotion_is_registered(self):
        with mock.patch.dict(scene_render.SCENE_RENDERERS, {"remotion": lambda *a: None}):
            quote = Scene(id="s000", index=0, shot=Shot(recipe="quote_card"))
            footage = Scene(id="s001", index=1, shot=Shot(recipe="broll_cut"))
            avail = ("remotion", "ffmpeg")
            self.assertEqual(scene_render.choose_backend(quote, avail), "remotion")
            self.assertEqual(scene_render.choose_backend(quote), "ffmpeg")   # not available
            # broll_cut lists ffmpeg first — footage stays on ffmpeg.
            self.assertEqual(scene_render.choose_backend(footage, avail), "ffmpeg")


class FlagTestCase(unittest.TestCase):
    def test_default_off(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CHRONOS_SCENE_RENDER", None)
            self.assertFalse(scene_render.is_enabled())
        for v in ("1", "true", "YES", "on"):
            self.assertTrue(scene_render.is_enabled(v))
        for v in ("", "0", "no", "off", "2"):
            self.assertFalse(scene_render.is_enabled(v))


class DispatchTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.moviepy_calls = 0

    def tearDown(self):
        self.tmp.cleanup()

    def moviepy(self):
        self.moviepy_calls += 1
        out = self.root / "moviepy.mp4"
        out.write_bytes(b"moviepy")
        return out

    def dispatch(self, **kw):
        args = dict(moviepy_render=self.moviepy, output_path=self.root / "final_video.mp4",
                    script=None, audio_path=None, video_paths=[], image_paths=[],
                    section_timeline=[], backend="moviepy", ir_project=_project(self.root))
        args.update(kw)
        return render_dispatch.render_video(**args)

    def fake_scenes(self, project, output_path, **kw):
        self.scene_calls = getattr(self, "scene_calls", 0) + 1
        Path(output_path).write_bytes(b"scenes")
        return scene_render.SceneRenderResult(video_path=Path(output_path), scenes=3,
                                              cache_hits=["s000"], cache_misses=["s001", "s002"])

    def test_flag_off_is_the_old_path(self):
        with mock.patch.dict(os.environ, {"CHRONOS_SCENE_RENDER": ""}):
            res = self.dispatch(scene_renderer=self.fake_scenes)
        self.assertFalse(hasattr(self, "scene_calls"))
        self.assertEqual(self.moviepy_calls, 1)
        self.assertEqual(res.to_metadata(),
                         {"render_backend": "moviepy", "render_backend_requested": "moviepy"})

    def test_flag_on_renders_scenes(self):
        with mock.patch.dict(os.environ, {"CHRONOS_SCENE_RENDER": "1"}):
            res = self.dispatch(scene_renderer=self.fake_scenes)
        self.assertEqual(self.moviepy_calls, 0)
        meta = res.to_metadata()
        self.assertEqual((meta["render_backend"], meta["render_backend_requested"]),
                         ("scenes", "scenes"))
        self.assertEqual(meta["scene_render"]["cache_hits"], 1)
        self.assertEqual(meta["scene_render"]["rendered_scene_ids"], ["s001", "s002"])
        self.assertNotIn("render_fallback_reason", meta)

    def test_any_failure_falls_back_to_the_configured_backend(self):
        def broken(*a, **kw):
            raise RuntimeError("ffmpeg exploded")

        cases = {
            "renderer raised": dict(scene_renderer=broken),
            "no IR": dict(scene_renderer=self.fake_scenes, ir_project=None),
            "presenter": dict(scene_renderer=self.fake_scenes,
                              presenter_path=self.root / "p.mp4"),
            "real renderer, IR without times": dict(
                ir_project=_project(self.root, times=((0, 4), (None, None), (9, 12)))),
        }
        for name, kw in cases.items():
            with self.subTest(name):
                self.moviepy_calls = 0
                res = self.dispatch(scene_render_enabled=True, **kw)
                self.assertEqual(self.moviepy_calls, 1)
                meta = res.to_metadata()
                self.assertEqual(meta["render_backend"], "moviepy")
                self.assertEqual(meta["render_backend_requested"], "scenes")
                self.assertTrue(meta["render_fallback_reason"].startswith("scenes: "))

    def test_fallback_to_ffmpeg_when_ffmpeg_is_configured(self):
        def fake_ffmpeg(spec):
            Path(spec.output_path).write_bytes(b"ffmpeg")
            return spec.output_path

        from modules.script_engine import Script, ScriptSection
        script = Script(topic="t", title="T", title_ab="", description="", tags=[],
                        hook_sentence="", sections=[ScriptSection(
                            name="a", narration="a", duration_hint=5, section_type="story",
                            cut_interval=5.0, keywords=[])],
                        thumbnail_prompt_a="", thumbnail_prompt_b="",
                        thumbnail_overlay_text="", open_loops=[])
        res = self.dispatch(scene_render_enabled=True, ir_project=None, backend="ffmpeg",
                            script=script, section_timeline=[{"start_ms": 0, "end_ms": 5000}],
                            ffmpeg_render=fake_ffmpeg)
        self.assertEqual(res.backend, "ffmpeg")
        self.assertEqual(res.requested, "scenes")
        self.assertEqual(self.moviepy_calls, 0)


def _ffmpeg(*args):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", *args], check=True, capture_output=True)


def _probe(path):
    """(frame count, seconds, has audio stream) of a real file."""
    frames, secs = imageio_ffmpeg.count_frames_and_secs(str(path))
    info = subprocess.run([FFMPEG, "-i", str(path)], capture_output=True, text=True).stderr
    return frames, secs, "Audio:" in info


@unittest.skipIf(FFMPEG is None, "no ffmpeg binary")
class RealRenderTestCase(unittest.TestCase):
    """Small real renders: 320x180 @ 30 fps, a few seconds."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.narration_s = 7.3
        _ffmpeg("-f", "lavfi", "-i", f"sine=frequency=440:duration={self.narration_s}",
                str(self.root / "audio.mp3"))
        _ffmpeg("-f", "lavfi", "-i", "testsrc=s=320x240:d=1.5:r=25", str(self.root / "clip.mp4"))
        _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=200x100", "-frames:v", "1",
                str(self.root / "still.png"))
        self.subs = self.root / "subs.srt"
        self.subs.write_text("1\n00:00:00,000 --> 00:00:02,000\nHello\n", encoding="utf-8")
        self.assets = [
            AssetRef(id="a_clip", kind="video", path=str(self.root / "clip.mp4")),
            AssetRef(id="a_still", kind="image", path=str(self.root / "still.png")),
        ]
        self.out = self.root / "out" / "final_video.mp4"

    def tearDown(self):
        self.tmp.cleanup()

    def project(self, narrations=("one", "two", "three")):
        return _project(self.root, narrations=narrations,
                        times=((0.0, 2.437), (2.437, 5.1), (5.1, self.narration_s)),
                        audio_s=self.narration_s, assets=self.assets,
                        scene_assets={0: ("a_clip",), 1: ("a_still", "a_clip"), 2: ()},
                        subs=str(self.subs))

    def test_assembled_video_matches_the_narration(self):
        r = scene_render.render_project(self.project(), self.out, cut_intervals={1: 1.0})
        self.assertEqual(r.cache_misses, ["s000", "s001", "s002"])
        frames, secs, has_audio = _probe(self.out)
        self.assertLessEqual(abs(secs - self.narration_s), 0.5)
        self.assertEqual(frames, round(self.narration_s * 30))   # frame-exact, in fact
        self.assertTrue(has_audio)
        scene_frames = sorted((f.name[:4], _probe(f)[0])
                              for f in (self.out.parent / "scenes").iterdir())
        self.assertEqual(scene_frames, [("s000", 73), ("s001", 80), ("s002", 66)])

    def test_real_rerender_touches_only_the_changed_scene(self):
        scene_render.render_project(self.project(), self.out)
        real = scene_render.SCENE_RENDERERS["ffmpeg"]
        calls = []

        def counting(job, project, out_path):
            calls.append(job.scene_id)
            return real(job, project, out_path)

        r = scene_render.render_project(self.project(("one", "TWO", "three")), self.out,
                                        renderers={"ffmpeg": counting})
        self.assertEqual(calls, ["s001"])
        self.assertEqual(r.cache_hits, ["s000", "s002"])
        frames, secs, _ = _probe(self.out)
        self.assertLessEqual(abs(secs - self.narration_s), 0.5)

    def test_dispatch_end_to_end_with_the_flag(self):
        res = render_dispatch.render_video(
            moviepy_render=lambda: self.fail("moviepy must not run"),
            output_path=self.out, script=None, audio_path=None, video_paths=[],
            image_paths=[], section_timeline=[], backend="moviepy",
            ir_project=self.project(), scene_render_enabled=True)
        self.assertEqual(res.backend, "scenes")
        self.assertEqual(res.video_path, self.out)
        self.assertLessEqual(abs(_probe(self.out)[1] - self.narration_s), 0.5)


if __name__ == "__main__":
    unittest.main()
