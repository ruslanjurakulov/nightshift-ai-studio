"""Real-process regressions for worker RSS contaminating decoder accounting.

No database, provider, credential or production file is used. Imported by the
unit-suite bridge so these checks also run in the ordinary GitHub Tests job.
"""

import concurrent.futures
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from modules import ffmpeg_limits as fl
from modules import media_library as ml


@unittest.skipUnless(sys.platform == "linux", "Linux media-worker process accounting")
class DecoderRssTests(unittest.TestCase):
    def test_busy_worker_heap_is_not_decoder_memory(self):
        padding = bytearray(160 * 1024 ** 2)
        out = fl.run([sys.executable, "-I", "-S", "-c", "pass"], timeout_s=10)
        self.assertTrue(out.ok, out)
        self.assertGreater(out.peak_rss_bytes, 0)
        self.assertLess(out.peak_rss_bytes, 96 * 1024 ** 2)
        self.assertEqual(len(padding), 160 * 1024 ** 2)

    def test_concurrent_decoders_keep_independent_peaks(self):
        def run(mib):
            return fl.run([sys.executable, "-I", "-S", "-c",
                           f"import time; b=bytearray({mib}*1024**2); time.sleep(.1)"],
                          timeout_s=10)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            heavy, light = list(pool.map(run, [160, 0]))
        self.assertTrue(heavy.ok, heavy)
        self.assertTrue(light.ok, light)
        self.assertGreater(heavy.peak_rss_bytes, 150 * 1024 ** 2)
        self.assertLess(light.peak_rss_bytes, 96 * 1024 ** 2)

    def test_actual_large_decoder_is_still_rejected(self):
        # This is a real allocation, not a fabricated Outcome. The early crop
        # refusal must survive removal of the unrelated worker footprint.
        with mock.patch.object(ml, "RSS_BASE_BYTES", 96 * 1024 ** 2):
            result = ml.run_tool([sys.executable, "-I", "-S", "-c",
                                  "b=bytearray(160*1024**2)"], lambda: None,
                                 timeout_s=10, frame_px=4096)
        self.assertEqual(result, ml.REFUSED_EXIT)

    def test_small_video_survives_a_busy_worker(self):
        try:
            import imageio_ffmpeg
            exe = imageio_ffmpeg.get_ffmpeg_exe()
        except ImportError:
            exe = shutil.which("ffmpeg")
        if not exe:
            self.skipTest("real ffmpeg is unavailable")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "synthetic.mp4"
            thumb = Path(directory) / "thumbnail.jpg"
            subprocess.run([exe, "-hide_banner", "-nostdin", "-loglevel", "error",
                            "-f", "lavfi", "-i", "color=s=64x64:r=10:d=0.3",
                            "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p",
                            str(source)], check=True, capture_output=True, timeout=30)
            padding = bytearray(320 * 1024 ** 2)
            with mock.patch.object(ml, "RSS_BASE_BYTES", 256 * 1024 ** 2):
                result = ml.run_tool(ml.thumbnail_command(exe, source, thumb, "video/mp4", .3),
                                     lambda: None, timeout_s=30, frame_px=4096)
            self.assertEqual(result, 0)
            self.assertGreater(thumb.stat().st_size, 0)
            self.assertEqual(len(padding), 320 * 1024 ** 2)


if __name__ == "__main__":
    unittest.main()
