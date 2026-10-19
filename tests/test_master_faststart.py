"""The master render and the Short are written with moov first (+faststart).

Instagram refuses an MP4 whose moov atom sits at the end, and the social probe
reports every such file as ``not_faststart``. moviepy's ``write_videofile``
leaves moov at the end unless ffmpeg is told otherwise, so both encodes pass
``ffmpeg_params=["-movflags", "+faststart"]``.

The source checks run everywhere (compositor imports moviepy at module level,
so it cannot be imported in a bare container). The real-render check runs only
where moviepy and ffmpeg exist, i.e. CI.

Nothing here touches ``cut_sha256``: it is computed after the render, so a new
video is hashed in its final form. Existing videos are never remuxed in place.
"""

import ast
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FASTSTART = ["-movflags", "+faststart"]


def _write_videofile_calls(relpath):
    tree = ast.parse((ROOT / relpath).read_text(encoding="utf-8"))
    return [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "write_videofile"
    ]


def _top_level_boxes(path):
    """Names of the top-level MP4 boxes, in file order."""
    data = Path(path).read_bytes()
    boxes, pos = [], 0
    while pos + 8 <= len(data):
        size = int.from_bytes(data[pos:pos + 4], "big")
        boxes.append(data[pos + 4:pos + 8].decode("latin-1"))
        if size == 1:
            size = int.from_bytes(data[pos + 8:pos + 16], "big")
        if size < 8:
            break
        pos += size
    return boxes


class WriteVideofileKwargTestCase(unittest.TestCase):
    def _assert_faststart(self, relpath):
        calls = _write_videofile_calls(relpath)
        self.assertEqual(len(calls), 1, f"expected exactly one write_videofile in {relpath}")
        kwargs = {kw.arg: kw.value for kw in calls[0].keywords}
        self.assertIn("ffmpeg_params", kwargs, f"{relpath} lost +faststart: Instagram would refuse it")
        params = ast.literal_eval(kwargs["ffmpeg_params"])
        self.assertEqual(params[params.index("-movflags"):][:2], FASTSTART)

    def test_the_master_encode_is_moov_first(self):
        self._assert_faststart("modules/compositor.py")

    def test_the_short_encode_is_moov_first(self):
        self._assert_faststart("modules/shorts.py")


class RealRenderTestCase(unittest.TestCase):
    def test_render_short_puts_moov_before_mdat_and_keeps_audio(self):
        try:
            import imageio_ffmpeg
            import moviepy.editor  # noqa: F401
        except Exception:
            self.skipTest("moviepy/ffmpeg not installed")
        from PIL import Image

        from modules import shorts

        # compositor.py installs this alias in production, before shorts runs.
        if not hasattr(Image, "ANTIALIAS"):
            Image.ANTIALIAS = Image.LANCZOS
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "src.mp4", Path(tmp) / "short.mp4"
            subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error",
                 "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=10:d=1",
                 "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
                check=True,
            )
            self.assertIsNotNone(shorts.render_short(src, out, 1.0))
            boxes = _top_level_boxes(out)
            self.assertIn("moov", boxes)
            self.assertLess(boxes.index("moov"), boxes.index("mdat"))
            probe = subprocess.run([ffmpeg, "-i", str(out)], capture_output=True, text=True).stderr
            self.assertIn("Audio:", probe)


if __name__ == "__main__":
    unittest.main()
