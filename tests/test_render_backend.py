"""Tests for modules.render_backend — the executing ffmpeg backend (roadmap #49).

The pure spec maths live in tests/test_render_spec.py. Here we prove the
backend actually produces a playable file: a real ffmpeg render runs when the
bundled binary is available (skipped only if it truly isn't), plus the pure
seams (spec builder, invalid-spec guard) that need no ffmpeg.
"""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import render_backend
from modules.render_spec import KIND_COLOR, KIND_IMAGE, KIND_VIDEO, RenderSpec, Segment


def _ffmpeg_available() -> bool:
    exe = render_backend.resolve_ffmpeg()
    return bool(exe) and (exe == "ffmpeg" and shutil.which("ffmpeg") or Path(exe).exists())


def _probe(path) -> dict:
    """Decode `path` fully with ffmpeg and report its real video frame count and
    the container duration (seconds) — measured, not trusted from metadata."""
    exe = render_backend.resolve_ffmpeg()
    proc = subprocess.run([exe, "-hide_banner", "-i", str(path), "-map", "0:v:0", "-f", "null", "-"],
                          capture_output=True, text=True)
    err = proc.stderr
    frames = [int(m) for m in re.findall(r"frame=\s*(\d+)", err)]
    h, m, s = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err).groups()
    return {"frames": frames[-1] if frames else 0,
            "duration": int(h) * 3600 + int(m) * 60 + float(s)}


def _make_tone(ffmpeg: str, path: Path, seconds: float) -> None:
    render_backend._run([ffmpeg, "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                         "-c:a", "pcm_s16le", str(path)])


class SimpleSpecTestCase(unittest.TestCase):
    def test_builds_segments_and_infers_kind(self):
        spec = render_backend.simple_spec(
            "/tmp/out.mp4",
            [("/clip.mp4", 3.0), (None, 1.5), ("/img.jpg", 2.0, KIND_IMAGE)],
            audio_path="/a.mp3",
            fps=24,
        )
        self.assertEqual(spec.fps, 24)
        self.assertEqual(spec.audio_path, "/a.mp3")
        self.assertEqual(spec.segments[0].kind, KIND_VIDEO)   # a path -> video
        self.assertEqual(spec.segments[1].kind, KIND_COLOR)   # None -> colour
        self.assertEqual(spec.segments[2].kind, KIND_IMAGE)   # explicit kind kept
        self.assertAlmostEqual(spec.total_duration, 6.5)


class InvalidSpecTestCase(unittest.TestCase):
    def test_render_rejects_an_invalid_spec(self):
        spec = RenderSpec(output_path="", segments=[])  # no output, no segments
        with self.assertRaises(render_backend.RenderBackendError):
            render_backend.render(spec)


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg binary not available")
class RealRenderTestCase(unittest.TestCase):
    def test_renders_colour_segments_to_a_playable_file(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "out.mp4"
            spec = render_backend.simple_spec(
                str(out),
                [(None, 0.5, KIND_COLOR), (None, 0.5, KIND_COLOR)],
                width=320, height=240, fps=12,
            )
            result = render_backend.render(spec)
            self.assertEqual(result, str(out))
            self.assertTrue(out.exists())
            self.assertGreater(out.stat().st_size, 0)

    def test_renders_an_image_segment(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("PIL not available")
        with tempfile.TemporaryDirectory() as d:
            img = Path(d) / "bg.png"
            Image.new("RGB", (200, 120), (10, 20, 40)).save(img)
            out = Path(d) / "img.mp4"
            spec = render_backend.simple_spec(
                str(out), [(str(img), 0.6, KIND_IMAGE)], width=320, height=240, fps=12,
            )
            render_backend.render(spec)
            self.assertTrue(out.exists() and out.stat().st_size > 0)

    def test_silent_render_duration_is_exact(self):
        # 1.0 s + 1.3 s = 2.3 s = 23 frames at 10 fps. The concat list used to
        # repeat the last file, so this came out ~3.6 s (36 frames).
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "silent.mp4"
            spec = render_backend.simple_spec(
                str(out), [(None, 1.0, KIND_COLOR), (None, 1.3, KIND_COLOR)],
                width=160, height=120, fps=10,
            )
            render_backend.render(spec)
            got = _probe(out)
            self.assertEqual(got["frames"], 23)
            self.assertAlmostEqual(got["duration"], 2.3, delta=0.05)

    def test_single_segment_render_duration_is_exact(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "one.mp4"
            spec = render_backend.simple_spec(str(out), [(None, 1.5, KIND_COLOR)],
                                              width=160, height=120, fps=10)
            render_backend.render(spec)
            self.assertEqual(_probe(out)["frames"], 15)

    def test_render_with_longer_audio_keeps_video_duration(self):
        # Narration longer than the picture: -shortest must stop at the video's
        # true end (2.3 s), not at a doubled last segment.
        with tempfile.TemporaryDirectory() as d:
            ffmpeg = render_backend.resolve_ffmpeg()
            tone = Path(d) / "tone.wav"
            _make_tone(ffmpeg, tone, 5.0)
            out = Path(d) / "voiced.mp4"
            spec = render_backend.simple_spec(
                str(out), [(None, 1.0, KIND_COLOR), (None, 1.3, KIND_COLOR)],
                audio_path=str(tone), width=160, height=120, fps=10,
            )
            render_backend.render(spec)
            got = _probe(out)
            self.assertEqual(got["frames"], 23)
            self.assertAlmostEqual(got["duration"], 2.3, delta=0.1)

    def test_render_with_matching_audio_is_exact(self):
        with tempfile.TemporaryDirectory() as d:
            ffmpeg = render_backend.resolve_ffmpeg()
            tone = Path(d) / "tone.wav"
            _make_tone(ffmpeg, tone, 2.3)
            out = Path(d) / "matched.mp4"
            spec = render_backend.simple_spec(
                str(out), [(None, 1.0, KIND_COLOR), (None, 1.3, KIND_COLOR)],
                audio_path=str(tone), width=160, height=120, fps=10,
            )
            render_backend.render(spec)
            got = _probe(out)
            self.assertEqual(got["frames"], 23)
            self.assertAlmostEqual(got["duration"], 2.3, delta=0.1)

    def test_mixed_kinds_silent_render_duration_is_exact(self):
        # Video (longer source, trimmed) + still image + colour, no audio.
        try:
            from PIL import Image
        except Exception:
            self.skipTest("PIL not available")
        with tempfile.TemporaryDirectory() as d:
            ffmpeg = render_backend.resolve_ffmpeg()
            src = Path(d) / "src.mp4"
            render_backend._run([ffmpeg, "-y", "-f", "lavfi", "-i", "testsrc=s=200x100:r=25:d=4",
                                 "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)])
            img = Path(d) / "still.png"
            Image.new("RGB", (90, 160), (200, 30, 30)).save(img)
            out = Path(d) / "mixed.mp4"
            spec = render_backend.simple_spec(
                str(out), [(str(src), 1.2), (str(img), 0.8, KIND_IMAGE), (None, 0.5, KIND_COLOR)],
                width=160, height=120, fps=10,
            )
            render_backend.render(spec)
            got = _probe(out)
            self.assertEqual(got["frames"], 25)   # 1.2 + 0.8 + 0.5 = 2.5 s
            self.assertAlmostEqual(got["duration"], 2.5, delta=0.05)


class KenBurnsFilterTestCase(unittest.TestCase):
    """The ffmpeg still-image motion mirrors Compositor._ken_burns_clip."""

    def test_constants_are_the_compositors(self):
        try:
            from modules import compositor
        except Exception:
            self.skipTest("moviepy not importable here")
        self.assertEqual(render_backend.KEN_BURNS_ZOOM, compositor.KEN_BURNS_ZOOM)
        self.assertEqual(render_backend.KEN_BURNS_PAN, compositor.KEN_BURNS_PAN)
        self.assertEqual(render_backend.COVER_OVERSCAN, compositor.COVER_OVERSCAN)

    def test_style_is_stable_and_uses_every_move(self):
        self.assertEqual(render_backend.ken_burns_style("3:/a.jpg"),
                         render_backend.ken_burns_style("3:/a.jpg"))
        seen = {render_backend.ken_burns_style(f"{i}:/img.jpg") for i in range(64)}
        self.assertEqual(seen, set(render_backend.KEN_BURNS_STYLES))

    def test_zoom_moves_between_1_and_1_12_about_the_centre(self):
        vf = render_backend.ken_burns_filter("zoom_in", 1920, 1080, 30, 150)
        # Overscan 1.15 cover, centre-cropped to exactly 1.15 × frame, then one
        # zoompan frame per input frame at the output size.
        self.assertIn("scale=2208:1242:force_original_aspect_ratio=increase", vf)
        self.assertIn("crop=2208:1242", vf)
        self.assertIn("z='1.15*(1+0.12*min(1,on/150.000000))'", vf)
        self.assertIn(":d=1:s=1920x1080:fps=30", vf)
        self.assertIn("x='iw/2-iw/zoom/2'", vf)
        out = render_backend.ken_burns_filter("zoom_out", 1920, 1080, 30, 150)
        self.assertIn("z='1.15*(1+0.12-0.12*min(1,on/150.000000))'", out)

    def test_pan_is_a_fixed_1_06_window_crossing_30_percent(self):
        vf = render_backend.ken_burns_filter("pan_left", 1920, 1080, 30, 45.5)
        self.assertIn("crop=w=1811:h=1018:", vf)       # int(1920/1.06), int(1080/1.06)
        self.assertIn("x='clip(trunc(iw*(0.5+0.15-0.3*min(1,n/45.500000)))-905,0,iw-ow)'", vf)
        self.assertTrue(vf.endswith("scale=1920:1080:flags=lanczos"))
        right = render_backend.ken_burns_filter("pan_right", 1920, 1080, 30, 45.5)
        self.assertIn("(0.5-0.15+0.3*min(1,n/45.500000))", right)

    def test_the_filter_never_decides_the_frame_count(self):
        # Segment length is the caller's -t / -frames:v, exactly as for the
        # static hold — the audio master clock must not move.
        for style in render_backend.KEN_BURNS_STYLES:
            vf = render_backend.ken_burns_filter(style, 320, 240, 10, 12)
            self.assertNotIn("trim", vf)
            self.assertIn("loop=loop=-1:size=1,settb=1/10,setpts=N", vf)

    def test_a_failed_move_holds_the_still_instead_of_failing(self):
        calls = []

        def fake_run(cmd):
            calls.append(cmd)
            if any("loop=loop" in str(a) for a in cmd):
                raise render_backend.RenderBackendError("zoompan unavailable")

        seg = Segment(duration=1.0, path="/img.png", kind=KIND_IMAGE)
        with mock.patch.object(render_backend, "_run", side_effect=fake_run):
            with self.assertLogs("modules.render_backend", "WARNING"):
                render_backend._normalize_segment("ffmpeg", seg, Path("/tmp/x.mp4"), 320, 240, 10)
        self.assertEqual(len(calls), 2)
        self.assertIn("-loop", calls[1])                 # the old static hold
        self.assertIn(render_backend._scale_pad(320, 240, 10), calls[1])


def _frames_of(ffmpeg, path) -> list:
    """Every decoded frame of a small clip as raw RGB bytes."""
    proc = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
                           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    return proc.stdout


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg binary not available")
class RealKenBurnsTestCase(unittest.TestCase):
    def setUp(self):
        try:
            from PIL import Image, ImageDraw
        except Exception:
            self.skipTest("PIL not available")
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.ffmpeg = render_backend.resolve_ffmpeg()
        # Odd, non-16:9 sizes on purpose: the scale/crop rounding must still fit.
        self.images = {}
        for name, size in {"wide": (401, 151), "tall": (91, 161)}.items():
            im = Image.new("RGB", size, (20, 20, 20))
            d = ImageDraw.Draw(im)
            for x in range(0, size[0], 9):
                d.line([x, 0, x, size[1]], fill=(250, 250, 250), width=2)
            d.ellipse([size[0] // 3, size[1] // 3, size[0] // 2, size[1] // 2], fill=(200, 40, 40))
            path = self.dir / f"{name}.png"
            im.save(path)
            self.images[name] = str(path)

    def tearDown(self):
        self.tmp.cleanup()

    def _render(self, style, img, dur, fps, out):
        vf = render_backend.ken_burns_filter(style, 160, 120, fps, float(dur) * fps)
        render_backend._run([self.ffmpeg, "-y", "-i", img, "-t", dur, "-vf", vf,
                             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps), str(out)])

    def test_every_move_keeps_the_static_holds_frame_count(self):
        common = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10"]
        for dur in ("1.234", "2.017", "0.350"):
            old = self.dir / "old.mp4"
            render_backend._run(render_backend._static_image_cmd(
                self.ffmpeg, self.images["wide"], dur, 160, 120, 10, common, old))
            want = _probe(old)["frames"]
            for style in render_backend.KEN_BURNS_STYLES:
                for name, img in self.images.items():
                    with self.subTest(dur=dur, style=style, image=name):
                        out = self.dir / f"{style}-{name}.mp4"
                        self._render(style, img, dur, 10, out)
                        self.assertEqual(_probe(out)["frames"], want)

    def test_the_picture_actually_moves(self):
        for style in render_backend.KEN_BURNS_STYLES:
            with self.subTest(style=style):
                out = self.dir / f"{style}.mp4"
                self._render(style, self.images["wide"], "1.000", 10, out)
                raw = _frames_of(self.ffmpeg, out)
                size = 160 * 120 * 3
                self.assertEqual(len(raw), 10 * size)
                self.assertNotEqual(raw[:size], raw[-size:])

    def test_full_render_of_stills_is_frame_exact(self):
        out = self.dir / "stills.mp4"
        spec = render_backend.simple_spec(
            str(out), [(self.images["wide"], 1.234, KIND_IMAGE), (self.images["tall"], 0.9, KIND_IMAGE),
                       (None, 0.4, KIND_COLOR)],
            width=160, height=120, fps=10)
        render_backend.render(spec)
        got = _probe(out)
        self.assertEqual(got["frames"], 12 + 9 + 4)


if __name__ == "__main__":
    unittest.main()
