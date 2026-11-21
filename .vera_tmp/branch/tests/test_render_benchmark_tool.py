"""Tests for tools/render_benchmark.py — the benchmark workflow's helpers."""

import json
import tempfile
import unittest
from pathlib import Path

from tools import render_benchmark as rb

TIME_V = """\tCommand being timed: "python main.py --script-file bench/script.json --no-upload"
\tUser time (seconds): 300.12
\tElapsed (wall clock) time (h:mm:ss or m:ss): 1:02:03.5
\tMaximum resident set size (kbytes): 2048000
\tExit status: 0
"""

LOG = """2026-09-24 07:18:40,553 [INFO] modules.render_dispatch: Rendering with the ffmpeg backend: 46 segment(s), 179.4s
2026-09-24 07:19:49,518 [INFO] modules.render_dispatch: Render backend used: ffmpeg (/out/final_video.mp4)
2026-09-24 07:19:49,521 [INFO] chronos: Video: /out/final_video.mp4 (render backend: ffmpeg)
"""

FALLBACK_LOG = """2026-09-24 07:00:00,000 [INFO] modules.render_dispatch: Rendering with the ffmpeg backend: 3 segment(s), 9.0s
2026-09-24 07:00:01,000 [WARNING] modules.render_dispatch: ffmpeg render backend not used (RenderBackendError: ffmpeg exited 1: x) — falling back to the moviepy compositor
2026-09-24 07:00:02,000 [INFO] modules.compositor: Starting render for: slug
2026-09-24 07:00:30,000 [INFO] modules.render_dispatch: Render backend used: moviepy (fallback from ffmpeg)
2026-09-24 07:00:30,500 [INFO] chronos: Video: /out/final_video.mp4 (render backend: moviepy)
"""


class RepeatedScriptTestCase(unittest.TestCase):
    def test_repeats_sections_and_keeps_one_hook(self):
        data = json.loads(rb.DEMO_SCRIPT.read_text(encoding="utf-8"))
        n = len(data["sections"])
        out = rb.repeated_script(data, 3)
        self.assertEqual(len(out["sections"]), 3 * n)
        self.assertEqual(sum(1 for s in out["sections"] if s["type"] == "hook"),
                         sum(1 for s in data["sections"] if s["type"] == "hook"))
        self.assertEqual(len({s["name"] for s in out["sections"]}), 3 * n)
        self.assertEqual(len(data["sections"]), n)  # input untouched

    def test_repeat_is_clamped(self):
        data = {"sections": [{"name": "a", "type": "hook"}]}
        self.assertEqual(len(rb.repeated_script(data, 0)["sections"]), 1)
        self.assertEqual(len(rb.repeated_script(data, 99)["sections"]), rb.MAX_REPEAT)


class ParseTestCase(unittest.TestCase):
    def test_time_v(self):
        r = rb.parse_time_v(TIME_V)
        self.assertEqual(r["max_rss_mb"], 2000.0)
        self.assertEqual(r["wall_s"], 3723.5)
        self.assertEqual(r["time_exit_status"], 0)
        self.assertIsNone(r["signal"])

    def test_time_v_signal_and_missing(self):
        r = rb.parse_time_v("\tCommand terminated by signal 9\n")
        self.assertEqual(r["signal"], 9)
        self.assertIsNone(r["max_rss_mb"])  # unknown stays null, never 0

    def test_mem_samples(self):
        r = rb.parse_mem_samples("7000000\n5000000\n6000000\n", mem_total_kb=8 * 1024 * 1024)
        self.assertEqual(r["peak_system_used_mb"], round((8388608 - 5000000) / 1024, 1))
        self.assertEqual(r["baseline_system_used_mb"], round((8388608 - 7000000) / 1024, 1))
        self.assertEqual(r["mem_samples"], 3)
        self.assertIsNone(rb.parse_mem_samples("", 1000)["peak_system_used_mb"])

    def test_run_log(self):
        r = rb.parse_run_log(LOG)
        self.assertEqual(r["backend_used"], "ffmpeg")
        self.assertIsNone(r["fallback_reason"])
        self.assertEqual(r["render_s"], 69.0)

    def test_run_log_fallback(self):
        r = rb.parse_run_log(FALLBACK_LOG)
        self.assertEqual(r["backend_used"], "moviepy")
        self.assertIn("RenderBackendError", r["fallback_reason"])
        self.assertEqual(r["render_s"], 30.5)

    def test_markdown_marks_unknowns(self):
        md = rb.render_markdown({"backend_requested": "moviepy", "repeat": 1, "exit_code": 143})
        self.assertIn("| Exit code | 143 |", md)
        self.assertIn("| Peak RSS (largest single process) | n/a |", md)


class MainTestCase(unittest.TestCase):
    def test_report_writes_files_without_a_video(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "time.txt").write_text(TIME_V)
            (d / "run.log").write_text(LOG)
            rc = rb.main(["report", "--time-file", str(d / "time.txt"), "--log", str(d / "run.log"),
                          "--video", str(d / "missing.mp4"), "--exit-code", "0",
                          "--backend", "ffmpeg", "--repeat", "2",
                          "--out-md", str(d / "s.md"), "--out-json", str(d / "r.json")])
            self.assertEqual(rc, 0)
            data = json.loads((d / "r.json").read_text())
            self.assertEqual(data["backend_used"], "ffmpeg")
            self.assertIsNone(data["output_mb"])
            self.assertIn("Render benchmark", (d / "s.md").read_text())


if __name__ == "__main__":
    unittest.main()
