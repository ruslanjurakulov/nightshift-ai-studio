"""Tests for Remotion as a scene-level backend (modules/scene_remotion.py +
the wiring in modules/scene_render.py).

What is pinned here:
  * Remotion is available only with CHRONOS_REMOTION=1 AND an installed engine
    (node/npx + video-engine/node_modules); default: ffmpeg only;
  * when available, recipes that prefer Remotion (graphic cards, map_zoom) route
    to it and footage/Ken Burns recipes stay on ffmpeg;
  * the cache key differs by backend, and a Remotion scene's ffmpeg fallback is
    keyed exactly like the same scene planned without Remotion (shared entry);
  * a Remotion failure renders THAT scene with ffmpeg, never raises into the
    pipeline, and the metadata records the backend per scene + the fallbacks;
  * the adapter hands Remotion the scene re-timed to its frame window, insists
    on the exact frame count and normalises the clip (real ffmpeg);
  * optionally, a real small Remotion render (opt-in: video-engine's
    node_modules installed and CHRONOS_REMOTION_BROWSER set).
"""

import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from modules import remotion_renderer, render_dispatch, scene_remotion, scene_render, video_ir
from modules.video_ir import AssetRef, AudioRef, Scene, Shot, VideoProject

try:
    import imageio_ffmpeg

    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:  # pragma: no cover - imageio-ffmpeg ships with moviepy
    FFMPEG = None

BOTH = ("remotion", "ffmpeg")


def _project(root: Path, *, recipes=None, times=((0, 4), (4, 9), (9, 12)), audio_s=12.0,
             assets=None, scene_assets=None, width=320, height=180):
    if assets is None:
        p = root / "a.jpg"
        if not p.exists():
            p.write_bytes(b"image a")
        assets = [AssetRef(id="a_a", kind="image", path=str(p))]
    scene_assets = scene_assets if scene_assets is not None else {0: ("a_a",), 2: ("a_a",)}
    recipes = recipes or {1: "quote_card"}
    scenes = tuple(
        Scene(id=video_ir.scene_id(i), index=i, narration=f"scene {i}", start_s=t[0], end_s=t[1],
              shot=Shot(recipe=recipes.get(i, "slow_push")),
              asset_ids=tuple(scene_assets.get(i, ())))
        for i, t in enumerate(times))
    audio = root / "audio.mp3"
    if not audio.exists():
        audio.write_bytes(b"audio")
    return VideoProject(slug="demo", width=width, height=height, fps=30,
                        audio=AudioRef(path=str(audio), duration_s=audio_s),
                        scenes=scenes, assets=tuple(assets))


class Renderer:
    """Fake scene renderer for one backend: counts calls, optionally fails."""

    def __init__(self, name, fail=False):
        self.name, self.fail, self.calls = name, fail, []

    def __call__(self, job, project, out_path):
        self.calls.append(job.scene_id)
        if self.fail:
            raise scene_remotion.SceneRemotionError("engine exploded")
        Path(out_path).write_bytes(f"{self.name} {job.scene_id} {job.key}".encode())
        return out_path


def fake_assemble(project, jobs, output_path, *, subtitles_path=None):
    Path(output_path).write_bytes(b"|".join(Path(j.path).read_bytes() for j in jobs))
    return output_path


class _Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / "out" / "final_video.mp4"

    def tearDown(self):
        self.tmp.cleanup()


class AvailabilityTestCase(_Tmp):
    def fake_engine(self):
        engine = self.root / "video-engine"
        (engine / "node_modules" / "remotion").mkdir(parents=True)
        (engine / "node_modules" / "@remotion" / "cli").mkdir(parents=True)
        (engine / "src").mkdir()
        (engine / "src" / "index.ts").write_text("")
        return engine

    def test_default_off(self):
        with mock.patch.dict(os.environ, {"CHRONOS_REMOTION": ""}):
            self.assertFalse(scene_remotion.available())
            self.assertEqual(scene_render.available_backends(), ("ffmpeg",))

    def test_flag_on_needs_the_installed_engine_and_node(self):
        engine = self.fake_engine()
        which = lambda name: f"/usr/bin/{name}"  # noqa: E731
        with mock.patch.dict(os.environ, {"CHRONOS_REMOTION": "1"}), \
                mock.patch.object(remotion_renderer, "ENGINE_DIR", engine), \
                mock.patch("shutil.which", which):
            self.assertTrue(scene_remotion.available())
            self.assertEqual(scene_render.available_backends(), BOTH)
        with mock.patch.dict(os.environ, {"CHRONOS_REMOTION": "1"}), \
                mock.patch.object(remotion_renderer, "ENGINE_DIR", self.root / "nowhere"), \
                mock.patch("shutil.which", which):
            self.assertFalse(scene_remotion.available())
        with mock.patch.dict(os.environ, {"CHRONOS_REMOTION": "1"}), \
                mock.patch.object(remotion_renderer, "ENGINE_DIR", engine), \
                mock.patch("shutil.which", lambda name: None):
            self.assertFalse(scene_remotion.available())


class BackendChoiceTestCase(unittest.TestCase):
    def test_remotion_recipes_route_to_remotion_when_available(self):
        for recipe in ("quote_card", "stat_counter", "chapter_card", "title_card", "timeline",
                       "evidence_card", "map_zoom"):
            scene = Scene(id="s000", index=0, shot=Shot(recipe=recipe))
            self.assertEqual(scene_render.choose_backend(scene, BOTH), "remotion", recipe)
            self.assertEqual(scene_render.choose_backend(scene), "ffmpeg", recipe)
        for recipe in ("slow_push", "slow_pull", "broll_cut", "lateral_pan", None, "bogus"):
            scene = Scene(id="s000", index=0, shot=Shot(recipe=recipe))
            self.assertEqual(scene_render.choose_backend(scene, BOTH), "ffmpeg", recipe)


class CacheKeyTestCase(_Tmp):
    def test_key_differs_by_backend_and_fallback_shares_the_ffmpeg_entry(self):
        p = _project(self.root)
        with_r = scene_render.plan_jobs(p, self.root / "scenes", available=BOTH)
        without = scene_render.plan_jobs(p, self.root / "scenes", available=("ffmpeg",))
        self.assertEqual([j.backend for j in with_r], ["ffmpeg", "remotion", "ffmpeg"])
        self.assertEqual([j.backend for j in without], ["ffmpeg"] * 3)
        self.assertNotEqual(with_r[1].key, without[1].key)
        self.assertNotEqual(with_r[1].path, without[1].path)
        # Scenes that stay on ffmpeg keep their key.
        self.assertEqual(with_r[0].key, without[0].key)
        self.assertEqual(with_r[2].key, without[2].key)
        # The fallback is the ffmpeg plan of the same scene: one cache entry.
        fb = with_r[1].fallback
        self.assertEqual((fb.backend, fb.key, fb.path), ("ffmpeg", without[1].key, without[1].path))
        self.assertEqual((fb.start_frame, fb.end_frame), (with_r[1].start_frame, with_r[1].end_frame))
        self.assertIsNone(with_r[0].fallback)

    def test_ffmpeg_key_names_the_recipe_it_executes(self):
        # ffmpeg cannot execute quote_card; what it renders is the fallback.
        kw = dict(narration="n", assets=[], duration_s=3.0, width=320, height=180, fps=30,
                  cut_s=5.0, style=None, backend="ffmpeg")
        p = _project(self.root, recipes={1: "quote_card"})
        job = scene_render.plan_jobs(p, self.root, available=("ffmpeg",))[1]
        expected = scene_render.cache_key(**{**kw, "narration": "scene 1", "duration_s": 5.0,
                                             "recipe": "slow_push"})
        self.assertEqual(job.key, expected)


class RenderProjectTestCase(_Tmp):
    def run_once(self, project, remotion):
        self.ffmpeg = Renderer("ffmpeg")
        return scene_render.render_project(
            project, self.out, renderers={"ffmpeg": self.ffmpeg, "remotion": remotion},
            assemble_fn=fake_assemble)

    def test_graphic_scene_renders_with_remotion(self):
        remotion = Renderer("remotion")
        r = self.run_once(_project(self.root), remotion)
        self.assertEqual(remotion.calls, ["s001"])
        self.assertEqual(self.ffmpeg.calls, ["s000", "s002"])
        meta = r.to_metadata()
        self.assertEqual(meta["backend_by_scene"],
                         {"s000": "ffmpeg", "s001": "remotion", "s002": "ffmpeg"})
        self.assertEqual(meta["fallback_scene_ids"], [])
        self.assertEqual(meta["scene_backends"], ["ffmpeg", "remotion"])
        self.assertIn(b"remotion s001", self.out.read_bytes())

    def test_remotion_failure_falls_back_to_ffmpeg_for_that_scene_only(self):
        broken = Renderer("remotion", fail=True)
        r = self.run_once(_project(self.root), broken)
        self.assertEqual(broken.calls, ["s001"])
        self.assertEqual(self.ffmpeg.calls, ["s000", "s001", "s002"])
        meta = r.to_metadata()
        self.assertEqual(meta["backend_by_scene"]["s001"], "ffmpeg")
        self.assertEqual(meta["fallback_scene_ids"], ["s001"])
        self.assertEqual(r.fallbacks, {"s001": "remotion"})
        self.assertEqual(r.cache_misses, ["s000", "s001", "s002"])
        # The assembly used the fallback clip; nothing sits under the Remotion key.
        self.assertEqual(self.out.read_bytes().count(b"ffmpeg s001"), 1)
        job = scene_render.plan_jobs(_project(self.root), self.out.parent / "scenes",
                                     available=BOTH)[1]
        self.assertFalse(job.path.exists())
        self.assertTrue(job.fallback.path.exists())
        self.assertEqual(sorted(p.name for p in (self.out.parent / "scenes").iterdir()
                                if p.name.startswith(".tmp")), [])

        # Next run: Remotion is tried again (its key is still a miss) …
        remotion = Renderer("remotion")
        r2 = self.run_once(_project(self.root), remotion)
        self.assertEqual(remotion.calls, ["s001"])
        self.assertEqual(r2.to_metadata()["backend_by_scene"]["s001"], "remotion")
        self.assertEqual(r2.cache_hits, ["s000", "s002"])
        # … and a run where it fails again reuses the cached ffmpeg fallback.
        (self.out.parent / "scenes" / job.path.name).unlink()
        r3 = self.run_once(_project(self.root), Renderer("remotion", fail=True))
        self.assertEqual(self.ffmpeg.calls, [])
        self.assertEqual(r3.cache_hits, ["s000", "s001", "s002"])
        self.assertEqual(r3.fallbacks, {"s001": "remotion"})

    def test_ffmpeg_failure_still_raises_to_the_dispatcher(self):
        class Broken(Renderer):
            def __call__(self, job, project, out_path):
                raise RuntimeError("ffmpeg broke")

        with self.assertRaises(RuntimeError):
            scene_render.render_project(_project(self.root), self.out,
                                        renderers={"ffmpeg": Broken("ffmpeg")},
                                        assemble_fn=fake_assemble)

    def test_default_renderers_follow_availability(self):
        ffmpeg, remotion = Renderer("ffmpeg"), Renderer("remotion")
        fake = {"ffmpeg": ffmpeg, "remotion": remotion}
        with mock.patch.dict(scene_render.SCENE_RENDERERS, fake), \
                mock.patch.object(scene_remotion, "available", return_value=False):
            r = scene_render.render_project(_project(self.root), self.out, assemble_fn=fake_assemble)
        self.assertEqual(remotion.calls, [])
        self.assertEqual(set(r.backends.values()), {"ffmpeg"})
        with mock.patch.dict(scene_render.SCENE_RENDERERS, fake), \
                mock.patch.object(scene_remotion, "available", return_value=True):
            r = scene_render.render_project(_project(self.root), self.out, assemble_fn=fake_assemble)
        self.assertEqual(remotion.calls, ["s001"])
        self.assertEqual(r.backends["s001"], "remotion")

    def test_dispatch_records_the_fallback_in_render_metadata(self):
        def scenes(project, output_path, **kw):
            return scene_render.render_project(
                project, output_path,
                renderers={"ffmpeg": Renderer("ffmpeg"), "remotion": Renderer("remotion", fail=True)},
                assemble_fn=fake_assemble, **kw)

        res = render_dispatch.render_video(
            moviepy_render=lambda: self.fail("moviepy must not run"),
            output_path=self.out, script=None, audio_path=None, video_paths=[], image_paths=[],
            section_timeline=[], backend="moviepy", ir_project=_project(self.root),
            scene_render_enabled=True, scene_renderer=scenes)
        self.assertEqual(res.backend, "scenes")
        meta = res.to_metadata()["scene_render"]
        self.assertEqual(meta["fallback_scene_ids"], ["s001"])
        self.assertEqual(meta["backend_by_scene"]["s001"], "ffmpeg")


def _ffmpeg(*args):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", *args], check=True, capture_output=True)


def _size(path):
    info = subprocess.run([FFMPEG, "-i", str(path)], capture_output=True, text=True).stderr
    return info


@unittest.skipIf(FFMPEG is None, "no ffmpeg binary")
class AdapterTestCase(_Tmp):
    """scene_remotion.render_scene with a fake Remotion and a real ffmpeg."""

    def setUp(self):
        super().setUp()
        _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=200x100", "-frames:v", "1",
                str(self.root / "still.png"))
        assets = [AssetRef(id="a_still", kind="image", path=str(self.root / "still.png"))]
        # IR times a fraction of a frame off the grid; the first scene starts late.
        self.project = _project(self.root, assets=assets, scene_assets={1: ("a_still",)},
                                times=((0.4, 2.437), (2.437, 5.1), (5.1, 7.3)), audio_s=7.3)
        self.job = scene_render.plan_jobs(self.project, self.root / "scenes", available=BOTH)[1]
        self.seen = {}

    def fake_remotion(self, frames=None, fail=False):
        def render(scene, context, out_path):
            self.seen.update(scene=scene, context=context,
                             public=sorted(p.name for p in Path(context["assets_base_dir"]).iterdir()))
            if fail:
                return None
            n = frames if frames is not None else round((scene["end_s"] - scene["start_s"]) * 30)
            _ffmpeg("-f", "lavfi", "-i", f"testsrc=s={context['width']}x{context['height']}:r=30",
                    "-frames:v", str(n), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out_path))
            return Path(out_path)
        return render

    def test_frame_exact_clip_from_the_window(self):
        out = self.root / "s001.mp4"
        scene_remotion.render_scene(self.job, self.project, out, remotion_render=self.fake_remotion())
        want = self.job.end_frame - self.job.start_frame
        self.assertEqual(want, 80)
        self.assertEqual(scene_remotion.count_frames(FFMPEG, out), want)
        self.assertIn("320x180", _size(out))
        self.assertNotIn("Audio:", _size(out))
        scene = self.seen["scene"]
        self.assertEqual(round(scene["start_s"] * 30), self.job.start_frame)
        self.assertEqual(round(scene["end_s"] * 30), self.job.end_frame)
        self.assertEqual(scene["shot"]["recipe"], "quote_card")
        ctx = self.seen["context"]
        self.assertEqual((ctx["width"], ctx["height"], ctx["fps"]), (320, 180, 30))
        self.assertEqual(ctx["assets"], [{"id": "a_still", "kind": "image", "path": "asset00.png"}])
        self.assertEqual(self.seen["public"], ["asset00.png"])

    def test_first_scene_starts_at_zero_on_the_project_clock(self):
        first = scene_render.plan_jobs(self.project, self.root / "scenes", available=BOTH)[0]
        scene_remotion.render_scene(first, self.project, self.root / "s000.mp4",
                                    remotion_render=self.fake_remotion())
        self.assertEqual(self.seen["scene"]["start_s"], 0.0)

    def test_wrong_frame_count_is_a_failure_not_a_stretch(self):
        with self.assertRaises(scene_remotion.SceneRemotionError):
            scene_remotion.render_scene(self.job, self.project, self.root / "x.mp4",
                                        remotion_render=self.fake_remotion(frames=79))
        self.assertFalse((self.root / "x.mp4").exists())

    def test_no_output_is_a_failure(self):
        with self.assertRaises(scene_remotion.SceneRemotionError):
            scene_remotion.render_scene(self.job, self.project, self.root / "x.mp4",
                                        remotion_render=self.fake_remotion(fail=True))

    def test_flag_off_the_real_renderer_declines_and_the_scene_falls_back(self):
        with mock.patch.dict(os.environ, {"CHRONOS_REMOTION": ""}):
            with self.assertRaises(scene_remotion.SceneRemotionError):
                scene_remotion.render_scene(self.job, self.project, self.root / "x.mp4")

    def test_count_frames_unknown_is_none(self):
        bogus = self.root / "bogus.mp4"
        bogus.write_bytes(b"not a video")
        self.assertIsNone(scene_remotion.count_frames(FFMPEG, bogus))


@unittest.skipIf(FFMPEG is None, "no ffmpeg binary")
class BundleOnceTestCase(_Tmp):
    """render_project bundles the engine once for all its Remotion scenes and
    renders each from that bundle (Remotion itself faked, real ffmpeg)."""

    def setUp(self):
        super().setUp()
        _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=200x100", "-frames:v", "1",
                str(self.root / "still.png"))
        assets = [AssetRef(id="a_still", kind="image", path=str(self.root / "still.png"))]
        # Three graphic scenes (Remotion) around one footage scene (ffmpeg).
        self.project = _project(self.root, assets=assets,
                                recipes={0: "title_card", 1: "quote_card", 3: "chapter_card"},
                                times=((0, 1), (1, 2), (2, 3), (3, 4)), audio_s=4.0,
                                scene_assets={0: ("a_still",), 2: ("a_still",), 3: ("a_still",)})
        self.bundles, self.renders = [], []

    def fake_bundle(self, fail=False):
        def bundle(out_dir, *, public_dir=None):
            out_dir = Path(out_dir)
            self.bundles.append({"out_dir": out_dir, "public": sorted(
                p.relative_to(public_dir).as_posix() for p in Path(public_dir).rglob("*") if p.is_file())})
            if fail:
                return None
            out_dir.mkdir()
            (out_dir / "index.html").write_text("")
            return out_dir
        return bundle

    def fake_render(self, fail_ids=()):
        def render(scene, context, out_path):
            self.renders.append({"id": scene["id"], "context": dict(context),
                                 "bundle_alive": bool(context.get("serve_url"))
                                 and Path(context["serve_url"], "index.html").is_file()})
            if scene["id"] in fail_ids:
                return None
            n = round((scene["end_s"] - scene["start_s"]) * 30)
            _ffmpeg("-f", "lavfi", "-i", f"testsrc=s={context['width']}x{context['height']}:r=30",
                    "-frames:v", str(n), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out_path))
            return Path(out_path)
        return render

    def run_project(self, bundle, render, renderers=None):
        self.ffmpeg = Renderer("ffmpeg")
        renderers = renderers or {"ffmpeg": self.ffmpeg, "remotion": scene_render.render_scene_remotion}
        with mock.patch.object(remotion_renderer, "bundle", side_effect=bundle), \
                mock.patch.object(remotion_renderer, "render_scene", side_effect=render):
            return scene_render.render_project(self.project, self.out, renderers=renderers,
                                               assemble_fn=fake_assemble)

    def test_one_bundle_serves_every_remotion_scene(self):
        r = self.run_project(self.fake_bundle(), self.fake_render())
        self.assertEqual(len(self.bundles), 1)
        self.assertEqual(self.bundles[0]["public"],
                         ["scene000/asset00.png", "scene002/asset00.png"])
        self.assertEqual([x["id"] for x in self.renders], ["s000", "s001", "s003"])
        bundle_dir = self.bundles[0]["out_dir"]
        for x in self.renders:
            self.assertEqual(x["context"]["serve_url"], str(bundle_dir))
            self.assertTrue(x["bundle_alive"])
        self.assertEqual(self.renders[0]["context"]["assets"],
                         [{"id": "a_still", "kind": "image", "path": "scene000/asset00.png"}])
        self.assertEqual(self.renders[1]["context"]["assets"], [])
        self.assertEqual(self.renders[2]["context"]["assets"],
                         [{"id": "a_still", "kind": "image", "path": "scene002/asset00.png"}])
        meta = r.to_metadata()
        self.assertEqual(meta["backend_by_scene"],
                         {"s000": "remotion", "s001": "remotion", "s002": "ffmpeg", "s003": "remotion"})
        self.assertEqual(meta["fallback_scene_ids"], [])
        # Frame-exact clips, as without the bundle.
        for job in scene_render.plan_jobs(self.project, self.out.parent / "scenes", available=BOTH):
            if job.backend == "remotion":
                self.assertEqual(scene_remotion.count_frames(FFMPEG, job.path), 30)
        # The bundle (and its staged public dir) is gone after the run.
        self.assertFalse(bundle_dir.parent.exists())

    def test_bundle_failure_renders_each_scene_on_its_own(self):
        r = self.run_project(self.fake_bundle(fail=True), self.fake_render())
        self.assertEqual(len(self.bundles), 1)
        self.assertFalse(self.bundles[0]["out_dir"].parent.exists())
        self.assertEqual([x["id"] for x in self.renders], ["s000", "s001", "s003"])
        for x in self.renders:
            self.assertNotIn("serve_url", x["context"])
        # Per-scene staging, exactly as before.
        self.assertEqual(self.renders[0]["context"]["assets"],
                         [{"id": "a_still", "kind": "image", "path": "asset00.png"}])
        self.assertEqual(set(r.backends.values()), {"remotion", "ffmpeg"})
        self.assertEqual(r.fallbacks, {})

    def test_bundle_that_raises_is_contained(self):
        def explode(out_dir, *, public_dir=None):
            raise RuntimeError("bundler exploded")

        r = self.run_project(explode, self.fake_render())
        self.assertEqual([x["id"] for x in self.renders], ["s000", "s001", "s003"])
        self.assertEqual(r.fallbacks, {})

    def test_failed_scene_falls_back_to_ffmpeg_and_the_bundle_is_still_removed(self):
        r = self.run_project(self.fake_bundle(), self.fake_render(fail_ids=("s001",)))
        self.assertEqual(len(self.bundles), 1)
        self.assertEqual(r.fallbacks, {"s001": "remotion"})
        self.assertEqual(self.ffmpeg.calls, ["s001", "s002"])
        self.assertFalse(self.bundles[0]["out_dir"].parent.exists())

    def test_ffmpeg_error_still_raises_and_the_bundle_is_removed(self):
        class Broken(Renderer):
            def __call__(self, job, project, out_path):
                raise RuntimeError("ffmpeg broke")

        with self.assertRaises(RuntimeError):
            self.run_project(self.fake_bundle(), self.fake_render(),
                             renderers={"ffmpeg": Broken("ffmpeg"),
                                        "remotion": scene_render.render_scene_remotion})
        self.assertEqual(len(self.bundles), 1)
        self.assertFalse(self.bundles[0]["out_dir"].parent.exists())

    def test_no_bundle_when_every_remotion_scene_is_cached(self):
        self.run_project(self.fake_bundle(), self.fake_render())
        self.bundles.clear(), self.renders.clear()
        r = self.run_project(self.fake_bundle(), self.fake_render())
        self.assertEqual(self.bundles, [])
        self.assertEqual(self.renders, [])
        self.assertEqual(len(r.cache_hits), 4)

    def test_only_uncached_remotion_scenes_are_bundled(self):
        self.run_project(self.fake_bundle(), self.fake_render())
        job = scene_render.plan_jobs(self.project, self.out.parent / "scenes", available=BOTH)[3]
        job.path.unlink()
        self.bundles.clear(), self.renders.clear()
        self.run_project(self.fake_bundle(), self.fake_render())
        self.assertEqual(len(self.bundles), 1)
        self.assertEqual(self.bundles[0]["public"], ["scene000/asset00.png"])
        self.assertEqual([x["id"] for x in self.renders], ["s003"])

    def test_injected_remotion_renderer_is_never_bundled_for(self):
        fake = Renderer("remotion")
        self.run_project(self.fake_bundle(), self.fake_render(),
                         renderers={"ffmpeg": Renderer("ffmpeg"), "remotion": fake})
        self.assertEqual(self.bundles, [])
        self.assertEqual(fake.calls, ["s000", "s001", "s003"])

    def test_no_bundle_without_remotion_available(self):
        self.run_project(self.fake_bundle(), self.fake_render(),
                         renderers={"ffmpeg": Renderer("ffmpeg")})
        self.assertEqual(self.bundles, [])


def _real_engine_ready() -> bool:
    import shutil

    mods = remotion_renderer.ENGINE_DIR / "node_modules"
    browser = os.environ.get("CHRONOS_REMOTION_BROWSER", "").strip()
    return bool(shutil.which("npx") and (mods / "remotion").is_dir()
                and (mods / "@remotion" / "cli").is_dir() and browser and Path(browser).is_file())


@unittest.skipIf(FFMPEG is None or not _real_engine_ready(),
                 "opt-in: needs `npm ci` in video-engine/ and CHRONOS_REMOTION_BROWSER "
                 "pointing at a local Chromium headless shell")
class RealRemotionTestCase(_Tmp):
    """One small real render: 320x180 @ 30 fps, a quote card between two
    ffmpeg scenes. Opt-in (never downloads a browser)."""

    def test_real_scene_render_with_remotion(self):
        _ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=4.2", str(self.root / "audio.mp3"))
        _ffmpeg("-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1",
                str(self.root / "still.png"))
        assets = [AssetRef(id="a_still", kind="image", path=str(self.root / "still.png"))]
        project = _project(self.root, assets=assets, scene_assets={0: ("a_still",), 2: ("a_still",)},
                           times=((0.0, 1.0), (1.0, 3.1), (3.1, 4.2)), audio_s=4.2)
        project = replace(project, scenes=tuple(
            replace(s, narration='"Nothing on this island is ever lost," the keeper wrote.') if s.index == 1 else s
            for s in project.scenes))
        with mock.patch.dict(os.environ, {"CHRONOS_REMOTION": "1"}), \
                mock.patch.object(remotion_renderer, "bundle", wraps=remotion_renderer.bundle) as spy:
            self.assertIn("remotion", scene_render.available_backends())
            r = scene_render.render_project(project, self.out)
        # Bundled once for the run, rendered from that bundle, then removed.
        self.assertEqual(spy.call_count, 1)
        bundle_dir = Path(spy.call_args.args[0])
        self.assertFalse(bundle_dir.parent.exists())
        meta = r.to_metadata()
        self.assertEqual(meta["fallback_scene_ids"], [])
        self.assertEqual(meta["backend_by_scene"],
                         {"s000": "ffmpeg", "s001": "remotion", "s002": "ffmpeg"})
        frames = {f.name[:4]: scene_remotion.count_frames(FFMPEG, f)
                  for f in (self.out.parent / "scenes").iterdir()}
        self.assertEqual(frames, {"s000": 30, "s001": 63, "s002": 33})
        self.assertEqual(imageio_ffmpeg.count_frames_and_secs(str(self.out))[0], 126)


if __name__ == "__main__":
    unittest.main()
