"""Tests for modules.render_dispatch — which backend renders, and the fallback.

The contract under test: `config.RENDER_BACKEND` picks the renderer; "moviepy"
(the default) is exactly the old compositor call; "ffmpeg" builds a RenderSpec
from the same inputs and, on ANY failure, falls back to the compositor so a run
never breaks. The ffmpeg backend is mocked in the dispatch tests; one real
render (skipped without an ffmpeg binary) proves the wiring end to end.
"""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import render_backend, render_dispatch
from modules.render_spec import KIND_COLOR, KIND_IMAGE, KIND_VIDEO
from modules.script_engine import Script, ScriptSection


def _script(*sections):
    return Script(
        topic="t", title="T", title_ab="", description="", tags=[], hook_sentence="",
        sections=list(sections), thumbnail_prompt_a="", thumbnail_prompt_b="",
        thumbnail_overlay_text="", open_loops=[],
    )


def _section(name, stype="story", cut=5.0, keywords=None):
    return ScriptSection(name=name, narration=f"{name} narration", duration_hint=10,
                         section_type=stype, cut_interval=cut, keywords=list(keywords or []))


def _timeline(*durations_ms):
    out, t = [], 0
    for i, d in enumerate(durations_ms):
        out.append({"section": f"s{i}", "start_ms": t, "end_ms": t + d})
        t += d
    return out


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.moviepy_out = self.dir / "moviepy.mp4"
        self.moviepy_calls = 0

    def tearDown(self):
        self.tmp.cleanup()

    def moviepy_render(self):
        self.moviepy_calls += 1
        self.moviepy_out.write_bytes(b"moviepy")
        return self.moviepy_out

    def dispatch(self, **kw):
        args = dict(
            moviepy_render=self.moviepy_render,
            output_path=self.dir / "final_video.mp4",
            script=_script(_section("hook", "hook", 2.0), _section("story")),
            audio_path=self.dir / "a.mp3",
            video_paths=[], image_paths=[],
            section_timeline=_timeline(4000, 6000),
        )
        args.update(kw)
        return render_dispatch.render_video(**args)


class RequestedBackendTestCase(unittest.TestCase):
    def test_only_ffmpeg_selects_ffmpeg(self):
        self.assertEqual(render_dispatch.requested_backend("ffmpeg"), "ffmpeg")
        self.assertEqual(render_dispatch.requested_backend(" FFmpeg "), "ffmpeg")
        for v in ("moviepy", "", "ffmepg", "remotion"):
            self.assertEqual(render_dispatch.requested_backend(v), "moviepy")

    def test_reads_config_when_not_given(self):
        with mock.patch("config.RENDER_BACKEND", "ffmpeg"):
            self.assertEqual(render_dispatch.requested_backend(), "ffmpeg")
        with mock.patch("config.RENDER_BACKEND", "moviepy"):
            self.assertEqual(render_dispatch.requested_backend(), "moviepy")


class DispatchTestCase(_Base):
    def test_default_moviepy_never_touches_ffmpeg(self):
        ffmpeg = mock.Mock()
        res = self.dispatch(backend="moviepy", ffmpeg_render=ffmpeg)
        ffmpeg.assert_not_called()
        self.assertEqual(self.moviepy_calls, 1)
        self.assertEqual(res.backend, "moviepy")
        self.assertEqual(res.video_path, self.moviepy_out)
        self.assertIsNone(res.fallback_reason)
        self.assertEqual(res.to_metadata(),
                         {"render_backend": "moviepy", "render_backend_requested": "moviepy"})

    def test_moviepy_return_value_is_passed_through_untouched(self):
        sentinel = object()
        res = render_dispatch.render_video(
            moviepy_render=lambda: sentinel, output_path=self.dir / "x.mp4", script=_script(),
            audio_path=None, video_paths=[], image_paths=[], section_timeline=[],
            backend="moviepy")
        self.assertIs(res.video_path, sentinel)

    def test_ffmpeg_success_skips_moviepy(self):
        def fake_ffmpeg(spec):
            Path(spec.output_path).write_bytes(b"ffmpeg")
            return spec.output_path

        res = self.dispatch(backend="ffmpeg", ffmpeg_render=fake_ffmpeg)
        self.assertEqual(self.moviepy_calls, 0)
        self.assertEqual(res.backend, "ffmpeg")
        self.assertEqual(res.video_path, self.dir / "final_video.mp4")
        self.assertEqual(res.to_metadata()["render_backend"], "ffmpeg")
        self.assertNotIn("render_fallback_reason", res.to_metadata())

    def test_ffmpeg_exception_falls_back_to_moviepy(self):
        boom = mock.Mock(side_effect=render_backend.RenderBackendError("ffmpeg exited 1: bad"))
        with self.assertLogs("modules.render_dispatch", level="WARNING"):
            res = self.dispatch(backend="ffmpeg", ffmpeg_render=boom)
        boom.assert_called_once()
        self.assertEqual(self.moviepy_calls, 1)
        self.assertEqual(res.backend, "moviepy")
        self.assertEqual(res.requested, "ffmpeg")
        self.assertIn("RenderBackendError", res.fallback_reason)
        self.assertEqual(res.to_metadata()["render_backend_requested"], "ffmpeg")

    def test_any_exception_type_falls_back(self):
        res = self.dispatch(backend="ffmpeg", ffmpeg_render=mock.Mock(side_effect=MemoryError()))
        self.assertEqual(res.backend, "moviepy")
        self.assertIn("MemoryError", res.fallback_reason)

    def test_missing_output_falls_back(self):
        # The backend "succeeds" but no file exists — never ship a phantom path.
        res = self.dispatch(backend="ffmpeg",
                            ffmpeg_render=lambda spec: str(self.dir / "nothing.mp4"))
        self.assertEqual(res.backend, "moviepy")
        self.assertEqual(self.moviepy_calls, 1)
        self.assertIn("no output", res.fallback_reason)

    def test_empty_output_falls_back(self):
        def empty(spec):
            Path(spec.output_path).write_bytes(b"")
            return spec.output_path

        res = self.dispatch(backend="ffmpeg", ffmpeg_render=empty)
        self.assertEqual(res.backend, "moviepy")

    def test_invalid_spec_falls_back_through_the_real_backend(self):
        # No timeline -> no segments -> render_backend.validate rejects it
        # before any ffmpeg process is started.
        with mock.patch.object(render_backend, "_run") as run:
            res = self.dispatch(backend="ffmpeg", section_timeline=[])
        run.assert_not_called()
        self.assertEqual(res.backend, "moviepy")
        self.assertIn("invalid render spec", res.fallback_reason)

    def test_missing_ffmpeg_binary_falls_back(self):
        with mock.patch.object(render_backend, "resolve_ffmpeg",
                               return_value=str(self.dir / "no-such-ffmpeg")):
            res = self.dispatch(backend="ffmpeg")
        self.assertEqual(res.backend, "moviepy")
        self.assertEqual(self.moviepy_calls, 1)
        self.assertTrue(res.fallback_reason)

    def test_presenter_keeps_moviepy_without_trying_ffmpeg(self):
        ffmpeg = mock.Mock()
        res = self.dispatch(backend="ffmpeg", ffmpeg_render=ffmpeg,
                            presenter_path=self.dir / "presenter.mp4")
        ffmpeg.assert_not_called()
        self.assertEqual(res.backend, "moviepy")
        self.assertIn("presenter", res.fallback_reason)

    def test_moviepy_failure_is_not_swallowed(self):
        def broken():
            raise RuntimeError("compositor died")

        with self.assertRaises(RuntimeError):
            render_dispatch.render_video(
                moviepy_render=broken, output_path=self.dir / "x.mp4", script=_script(),
                audio_path=None, video_paths=[], image_paths=[], section_timeline=[],
                backend="moviepy")


class BuildSpecTestCase(unittest.TestCase):
    def build(self, script, timeline, videos=(), images=(), terms=None, srt=None):
        return render_dispatch.build_spec(
            output_path=Path("/out/final_video.mp4"), script=script,
            audio_path=Path("/a.mp3"), video_paths=[Path(v) for v in videos],
            image_paths=[Path(i) for i in images], section_timeline=timeline,
            subtitle_path=srt, clip_terms=terms, width=640, height=360, fps=24)

    def test_durations_follow_the_audio_timeline(self):
        script = _script(_section("hook", "hook", 2.0), _section("a"), _section("b"))
        timeline = _timeline(5300, 12000, 7400)
        spec = self.build(script, timeline, videos=["/v1.mp4", "/v2.mp4"])
        self.assertAlmostEqual(spec.total_duration, 24.7, places=2)
        self.assertEqual((spec.width, spec.height, spec.fps), (640, 360, 24))
        self.assertEqual(spec.audio_path, "/a.mp3")
        # hook cuts every 2s: 2 + 2 + 1.3
        self.assertEqual([s.duration for s in spec.segments[:3]], [2.0, 2.0, 1.3])

    def test_no_footage_means_colour_placeholders(self):
        spec = self.build(_script(_section("a")), _timeline(7000))
        self.assertTrue(spec.segments)
        self.assertTrue(all(s.kind == KIND_COLOR and s.path is None for s in spec.segments))
        self.assertEqual(render_backend.validate(spec), [])

    def test_hook_gets_no_stills_story_does(self):
        script = _script(_section("hook", "hook", 2.0), _section("story", cut=5.0))
        spec = self.build(script, _timeline(4000, 10000), images=["/i1.jpg"])
        hook = spec.segments[:2]
        story = spec.segments[2:]
        self.assertTrue(all(s.kind == KIND_COLOR for s in hook))
        self.assertTrue(all(s.kind == KIND_IMAGE and s.path == "/i1.jpg" for s in story))

    def test_videos_are_ranked_by_section_keywords(self):
        script = _script(_section("s", keywords=["lighthouse storm"], cut=5.0))
        terms = {"/beach.mp4": "calm beach", "/light.mp4": "lighthouse storm night"}
        spec = self.build(script, _timeline(5000), videos=["/beach.mp4", "/light.mp4"],
                          terms=terms)
        self.assertEqual(spec.segments[0].path, "/light.mp4")
        self.assertEqual(spec.segments[0].kind, KIND_VIDEO)

    def test_sliver_is_folded_into_previous_cut(self):
        spec = self.build(_script(_section("s", cut=5.0)), _timeline(10050))
        self.assertEqual(len(spec.segments), 2)
        self.assertAlmostEqual(spec.total_duration, 10.05, places=3)

    def test_zero_length_sections_are_skipped(self):
        spec = self.build(_script(_section("a"), _section("b")), _timeline(0, 3000))
        self.assertAlmostEqual(spec.total_duration, 3.0)

    def test_subtitle_path_is_carried(self):
        spec = self.build(_script(_section("a")), _timeline(3000), srt=Path("/s.srt"))
        self.assertEqual(spec.subtitle_path, "/s.srt")


def _ffmpeg_available() -> bool:
    exe = render_backend.resolve_ffmpeg()
    return bool(exe) and bool(exe == "ffmpeg" and shutil.which("ffmpeg") or Path(exe).exists())


def _probe_duration(ffmpeg: str, path: Path) -> float:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", proc.stderr)
    assert m, proc.stderr
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg binary not available")
class RealFfmpegDispatchTestCase(_Base):
    def test_renders_pipeline_shaped_inputs_with_ffmpeg(self):
        ff = render_backend.resolve_ffmpeg()
        d = self.dir
        audio = d / "final_audio.mp3"
        subprocess.run([ff, "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
                        "-c:a", "libmp3lame", str(audio)], check=True, capture_output=True)
        # A 1-second clip under a 2-second cut: it must loop, not come up short.
        clip = d / "clip.mp4"
        subprocess.run([ff, "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=12:duration=1",
                        "-pix_fmt", "yuv420p", str(clip)], check=True, capture_output=True)
        try:
            from PIL import Image
        except Exception:
            self.skipTest("PIL not available")
        img = d / "still.png"
        Image.new("RGB", (200, 120), (30, 60, 90)).save(img)
        srt = d / "subtitles.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:01,500\nhello there\n\n", encoding="utf-8")

        script = _script(_section("hook", "hook", 2.0), _section("story", cut=5.0))
        res = self.dispatch(
            backend="ffmpeg", audio_path=audio, video_paths=[clip], image_paths=[img],
            section_timeline=_timeline(2000, 2000), subtitle_path=srt,
            width=320, height=240, fps=12,
        )
        self.assertEqual(res.backend, "ffmpeg", res.fallback_reason)
        self.assertEqual(self.moviepy_calls, 0)
        self.assertTrue(res.video_path.exists())
        self.assertAlmostEqual(_probe_duration(ff, res.video_path), 4.0, delta=0.5)


if __name__ == "__main__":
    unittest.main()
