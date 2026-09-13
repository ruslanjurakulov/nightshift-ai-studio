"""Tests for modules.render_backend — the executing ffmpeg backend (roadmap #49).

The pure spec maths live in tests/test_render_spec.py. Here we prove the
backend actually produces a playable file: a real ffmpeg render runs when the
bundled binary is available (skipped only if it truly isn't), plus the pure
seams (spec builder, invalid-spec guard) that need no ffmpeg.
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from modules import render_backend
from modules.render_spec import KIND_COLOR, KIND_IMAGE, KIND_VIDEO, RenderSpec, Segment


def _ffmpeg_available() -> bool:
    exe = render_backend.resolve_ffmpeg()
    return bool(exe) and (exe == "ffmpeg" and shutil.which("ffmpeg") or Path(exe).exists())


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


if __name__ == "__main__":
    unittest.main()
