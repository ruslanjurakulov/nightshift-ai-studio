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


if __name__ == "__main__":
    unittest.main()
