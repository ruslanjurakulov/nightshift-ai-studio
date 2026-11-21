"""Tests for the ffmpeg backend's parallel segment stage and its timings.

What is pinned here:
  * how many segments normalise at once (``render_jobs``): the env override,
    the CPU and segment caps, the memory guard, and that nothing makes it < 1;
  * ``run_pool`` reports per-task times in TASK order whatever order the tasks
    finish in, never exceeds its job count, holds back under low memory, and
    on a failure waits for the tasks in flight before raising;
  * ``render``: the concat list follows the spec order even when segments
    finish in reverse; any failure of the parallel path redoes the stage one
    segment at a time with the old encode settings; a failure there still
    raises (render_dispatch then falls back to MoviePy, as before);
  * segments are a fast intermediate and the final pass is the one quality
    encode (render_spec.FINAL_X264);
  * with a real ffmpeg: jobs=1 and jobs=3 produce the same file, frame-exact;
  * scene_render: a scene's segments use the same pool, and fall back to one
    at a time;
  * the ``ffmpeg render timing:`` line round-trips through the benchmark
    tool's parser, with unknowns as None, never 0.
"""

import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from modules import render_backend, render_spec, scene_render
from modules.render_spec import KIND_COLOR, KIND_IMAGE, Segment
from tools import render_benchmark


def _ffmpeg_available() -> bool:
    exe = render_backend.resolve_ffmpeg()
    return bool(exe) and (exe == "ffmpeg" and shutil.which("ffmpeg") or Path(exe).exists())


def _no_memory_cap():
    return None


class RenderJobsTestCase(unittest.TestCase):
    def jobs(self, n, env="", cpu=4, avail=None):
        return render_backend.render_jobs(n, env=env, cpu_count=cpu, available_mb=lambda: avail)

    def test_default_is_the_cpu_count_capped_by_segments(self):
        self.assertEqual(self.jobs(46, cpu=4), 4)
        self.assertEqual(self.jobs(2, cpu=4), 2)
        self.assertEqual(self.jobs(0, cpu=4), 1)

    def test_env_overrides_and_one_means_the_old_serial_path(self):
        self.assertEqual(self.jobs(46, env="2", cpu=8), 2)
        self.assertEqual(self.jobs(46, env=" 1 ", cpu=8), 1)
        self.assertEqual(self.jobs(3, env="16", cpu=8), 3)

    def test_a_bad_env_value_keeps_the_default(self):
        for bad in ("0", "-3", "four", "2.5"):
            with self.subTest(bad=bad), self.assertLogs("modules.render_backend", "WARNING"):
                self.assertEqual(self.jobs(46, env=bad, cpu=4), 4)

    def test_memory_guard_caps_the_pool(self):
        per, reserve = render_backend.MEM_PER_JOB_MB, render_backend.MEM_RESERVE_MB
        self.assertEqual(self.jobs(46, cpu=8, avail=reserve + 2 * per + 10), 2)
        self.assertEqual(self.jobs(46, cpu=8, avail=reserve - 500), 1)   # never below 1
        self.assertEqual(self.jobs(46, cpu=4, avail=None), 4)            # unknown: no cap
        self.assertEqual(self.jobs(46, cpu=4, avail=64000), 4)


class RunPoolTestCase(unittest.TestCase):
    def test_times_come_back_in_task_order_whatever_finishes_first(self):
        finished = []

        def task(i, delay):
            def run():
                time.sleep(delay)
                finished.append(i)
            return run

        delays = [0.30, 0.20, 0.10, 0.0]
        times = render_backend.run_pool([task(i, d) for i, d in enumerate(delays)], 4,
                                        available_mb=_no_memory_cap)
        self.assertEqual(finished, [3, 2, 1, 0])          # really finished in reverse
        self.assertEqual(len(times), 4)
        self.assertGreater(times[0], times[3])            # ...but reported in task order

    def _max_in_flight(self, jobs, avail):
        lock, state = threading.Lock(), {"now": 0, "max": 0}

        def run():
            with lock:
                state["now"] += 1
                state["max"] = max(state["max"], state["now"])
            time.sleep(0.05)
            with lock:
                state["now"] -= 1

        render_backend.run_pool([run] * 8, jobs, available_mb=lambda: avail)
        return state["max"]

    def test_never_more_than_jobs_in_flight(self):
        self.assertLessEqual(self._max_in_flight(3, None), 3)

    def test_low_memory_holds_new_tasks_back(self):
        self.assertEqual(self._max_in_flight(4, render_backend.MEM_RESERVE_MB - 1), 1)

    def test_a_failure_waits_for_the_tasks_in_flight_then_raises(self):
        done = []

        def slow():
            time.sleep(0.2)
            done.append("slow")

        def bad():
            raise render_backend.RenderBackendError("boom")

        with self.assertRaises(render_backend.RenderBackendError):
            render_backend.run_pool([slow, bad, slow, slow, slow, slow], 2,
                                    available_mb=_no_memory_cap)
        # The first slow task was in flight when `bad` failed: it finished
        # (its ffmpeg reaped) before run_pool raised. No new task started.
        self.assertEqual(done, ["slow"])


class ParallelRenderTestCase(unittest.TestCase):
    """render() with the ffmpeg calls mocked: order, fallback, encode settings."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.spec = render_backend.simple_spec(
            str(self.dir / "out.mp4"),
            [(f"/src/{i}.mp4", 1.0) for i in range(5)], width=320, height=180, fps=10)
        self.final_cmds = []

    def tearDown(self):
        self.tmp.cleanup()

    def fake_run(self, cmd):
        # Only the final pass reaches _run here (segments are mocked below).
        self.final_cmds.append(cmd)
        lst = Path(cmd[cmd.index("-i") + 1])
        self.concat = lst.read_text()
        Path(cmd[-1]).write_bytes(b"video")

    def test_concat_order_is_the_spec_order_even_when_segments_finish_in_reverse(self):
        order = []

        def fake_norm(ffmpeg, seg, out, w, h, fps, *, seed=None, x264=()):
            time.sleep(0.05 * (5 - int(Path(seg.path).stem)))
            order.append(int(Path(seg.path).stem))
            Path(out).write_bytes(b"x")

        with mock.patch.object(render_backend, "_normalize_segment", side_effect=fake_norm), \
                mock.patch.object(render_backend, "_run", side_effect=self.fake_run):
            timings = render_backend.RenderTimings()
            render_backend.render(self.spec, ffmpeg="ffmpeg", jobs=5, timings=timings)
        self.assertNotEqual(order, sorted(order))
        files = re.findall(r"seg_(\d{4})\.mp4", self.concat)
        self.assertEqual(files, ["0000", "0001", "0002", "0003", "0004"])
        self.assertEqual((timings.mode, timings.jobs, timings.segments), ("parallel", 5, 5))
        self.assertEqual(len(timings.segment_s), 5)
        self.assertIsNotNone(timings.final_s)
        self.assertIsNone(timings.concat_s)  # inside the final pass: not measured, not 0

    def test_segments_are_the_fast_intermediate_and_the_final_pass_the_quality_encode(self):
        seen = []

        def fake_norm(ffmpeg, seg, out, w, h, fps, *, seed=None, x264=()):
            seen.append(tuple(x264))

        with mock.patch.object(render_backend, "_normalize_segment", side_effect=fake_norm), \
                mock.patch.object(render_backend, "_free_mb", return_value=50000.0), \
                mock.patch.object(render_backend, "_run", side_effect=self.fake_run):
            render_backend.render(self.spec, ffmpeg="ffmpeg", jobs=2)
        self.assertEqual(set(seen), {render_backend.INTERMEDIATE_X264})
        self.assertIn("ultrafast", render_backend.INTERMEDIATE_X264)
        cmd = self.final_cmds[0]
        i = cmd.index("libx264")
        self.assertEqual(tuple(cmd[i + 1:i + 5]), render_spec.FINAL_X264)
        self.assertEqual(render_spec.FINAL_X264, ("-preset", "medium", "-crf", "23"))

    def test_a_failed_segment_redoes_the_stage_serially_with_the_old_settings(self):
        calls = []
        lock = threading.Lock()

        def fake_norm(ffmpeg, seg, out, w, h, fps, *, seed=None, x264=()):
            with lock:
                calls.append((int(Path(seg.path).stem), tuple(x264)))
            if x264 and seg.path.endswith("/2.mp4"):
                raise render_backend.RenderBackendError("segment 2 failed in parallel")

        with mock.patch.object(render_backend, "_normalize_segment", side_effect=fake_norm), \
                mock.patch.object(render_backend, "_run", side_effect=self.fake_run):
            timings = render_backend.RenderTimings()
            with self.assertLogs("modules.render_backend", "WARNING") as logs:
                render_backend.render(self.spec, ffmpeg="ffmpeg", jobs=3, timings=timings)
        self.assertIn("one segment at a time", "\n".join(logs.output))
        legacy = [c for c in calls if c[1] == render_backend.LEGACY_X264]
        self.assertEqual([i for i, _ in legacy], [0, 1, 2, 3, 4])  # every one, in order
        self.assertEqual((timings.mode, timings.jobs), ("fallback", 1))
        self.assertEqual(len(timings.segment_s), 5)
        self.assertEqual(len(self.final_cmds), 1)

    def test_a_broken_pool_falls_back_too(self):
        with mock.patch.object(render_backend, "run_pool", side_effect=RuntimeError("no threads")), \
                mock.patch.object(render_backend, "_normalize_segment") as norm, \
                mock.patch.object(render_backend, "_run", side_effect=self.fake_run):
            with self.assertLogs("modules.render_backend", "WARNING"):
                render_backend.render(self.spec, ffmpeg="ffmpeg", jobs=4)
        self.assertEqual(norm.call_count, 5)
        self.assertTrue(all(c.kwargs["x264"] == render_backend.LEGACY_X264
                            for c in norm.call_args_list))

    def test_a_failure_in_the_serial_fallback_still_raises(self):
        def always_fails(*a, **k):
            raise render_backend.RenderBackendError("bad source")

        with mock.patch.object(render_backend, "_normalize_segment", side_effect=always_fails), \
                mock.patch.object(render_backend, "_run", side_effect=self.fake_run):
            with self.assertLogs("modules.render_backend", "WARNING"), \
                    self.assertRaises(render_backend.RenderBackendError):
                render_backend.render(self.spec, ffmpeg="ffmpeg", jobs=3)
        self.assertEqual(self.final_cmds, [])

    def test_jobs_one_never_touches_the_pool(self):
        with mock.patch.object(render_backend, "run_pool") as pool, \
                mock.patch.object(render_backend, "_normalize_segment"), \
                mock.patch.object(render_backend, "_run", side_effect=self.fake_run):
            timings = render_backend.RenderTimings()
            render_backend.render(self.spec, ffmpeg="ffmpeg", jobs=1, timings=timings)
        pool.assert_not_called()
        self.assertEqual(timings.mode, "sequential")


class DiskGuardTestCase(unittest.TestCase):
    def spec(self, seconds, w=1920, h=1080):
        return render_backend.simple_spec("/o.mp4", [("/a.mp4", seconds)], width=w, height=h)

    def test_enough_room_uses_the_fast_intermediate(self):
        got = render_backend.intermediate_x264(self.spec(195), Path("/tmp"),
                                               free_mb=lambda p: 20000.0)
        self.assertEqual(got, render_backend.INTERMEDIATE_X264)

    def test_a_full_disk_keeps_the_compact_old_settings(self):
        with self.assertLogs("modules.render_backend", "WARNING"):
            got = render_backend.intermediate_x264(self.spec(900), Path("/tmp"),
                                                   free_mb=lambda p: 3000.0)
        self.assertEqual(got, render_backend.LEGACY_X264)

    def test_the_need_scales_with_the_frame_size(self):
        # 900 s at 480x270 needs 1/16 of the 1080p estimate: 450 MB < 3000 MB.
        got = render_backend.intermediate_x264(self.spec(900, 480, 270), Path("/tmp"),
                                               free_mb=lambda p: 3000.0)
        self.assertEqual(got, render_backend.INTERMEDIATE_X264)

    def test_unknown_free_space_or_an_error_never_raises(self):
        spec = self.spec(60)
        self.assertEqual(render_backend.intermediate_x264(spec, Path("/tmp"), free_mb=lambda p: None),
                         render_backend.INTERMEDIATE_X264)

        def boom(p):
            raise OSError("statvfs")
        self.assertEqual(render_backend.intermediate_x264(spec, Path("/tmp"), free_mb=boom),
                         render_backend.INTERMEDIATE_X264)


class TimingLineTestCase(unittest.TestCase):
    def test_round_trips_through_the_benchmark_parser(self):
        t = render_backend.RenderTimings(segments=46, jobs=4, mode="parallel", normalize_s=120.456,
                                         segment_s=[2.0, 4.0], final_s=210.0, total_s=331.2)
        line = "2026-09-25 10:00:00,000 [INFO] modules.render_backend: " + t.log_line()
        got = render_benchmark.parse_render_timing(line)
        self.assertEqual(got["segments"], 46)
        self.assertEqual(got["render_jobs"], 4)
        self.assertEqual(got["render_mode"], "parallel")
        self.assertEqual(got["normalize_s"], 120.46)
        self.assertEqual(got["normalize_avg_s"], 3.0)
        self.assertEqual(got["final_s"], 210.0)
        self.assertEqual(got["ffmpeg_total_s"], 331.2)
        self.assertIsNone(got["concat_s"])        # "na" → None, never 0

    def test_unmeasured_values_are_na_not_zero(self):
        line = render_backend.RenderTimings(segments=3).log_line()
        self.assertIn("normalize_avg_s=na", line)
        self.assertIn("final_s=na", line)
        self.assertNotIn("=0.00", line)


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg binary not available")
class RealParallelRenderTestCase(unittest.TestCase):
    def setUp(self):
        try:
            from PIL import Image, ImageDraw
        except Exception:
            self.skipTest("PIL not available")
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.ffmpeg = render_backend.resolve_ffmpeg()
        im = Image.new("RGB", (300, 200), (30, 60, 90))
        ImageDraw.Draw(im).ellipse([80, 40, 200, 160], fill=(240, 200, 20))
        self.img = str(self.dir / "still.png")
        im.save(self.img)
        self.clip = str(self.dir / "clip.mp4")
        render_backend._run([self.ffmpeg, "-y", "-f", "lavfi", "-i", "testsrc=s=200x100:r=25:d=0.8",
                             "-c:v", "libx264", "-pix_fmt", "yuv420p", self.clip])

    def tearDown(self):
        self.tmp.cleanup()

    def _render(self, jobs):
        out = self.dir / f"out_j{jobs}.mp4"
        spec = render_backend.simple_spec(
            str(out), [(self.img, 1.234, KIND_IMAGE), (self.clip, 1.3), (None, 0.4, KIND_COLOR),
                       (self.img, 0.9, KIND_IMAGE), (self.clip, 0.5)],
            width=160, height=120, fps=10)
        render_backend.render(spec, jobs=jobs)
        return out

    def _framemd5(self, path):
        proc = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
                               "-map", "0:v:0", "-f", "framemd5", "-"], capture_output=True, text=True)
        return [line.split(",")[-1].strip() for line in proc.stdout.splitlines()
                if line and not line.startswith("#")]

    def test_one_job_and_three_jobs_render_the_same_video_frame_exact(self):
        one, three = self._render(1), self._render(3)
        a, b = self._framemd5(one), self._framemd5(three)
        self.assertEqual(len(a), 12 + 13 + 4 + 9 + 5)
        self.assertEqual(a, b)


class ScenePoolTestCase(unittest.TestCase):
    def _job(self, n):
        return scene_render.SceneJob(
            scene_id="s000", index=0, start_frame=0, end_frame=30 * n, fps=30,
            segments=tuple(Segment(duration=1.0, path=f"/v{i}.mp4") for i in range(n)),
            backend="ffmpeg", key="k", path=Path("/unused.mp4"))

    def _render(self, job, fake_run, jobs):
        project = mock.Mock(width=320, height=180, fps=30)
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(render_backend, "_run", side_effect=fake_run), \
                mock.patch.object(render_backend, "render_jobs", return_value=jobs):
            out = Path(d) / "scene.mp4"
            scene_render.render_scene_ffmpeg(job, project, out, ffmpeg="ffmpeg")
            return out.is_file()

    def test_scene_segments_run_in_the_pool_and_concat_in_order(self):
        concat = {}

        def fake_run(cmd):
            if "concat" in cmd:
                concat["list"] = Path(cmd[cmd.index("-i") + 1]).read_text()
            else:
                time.sleep(0.02 * (3 - int(cmd[cmd.index("-i") + 1][2])))
            Path(cmd[-1]).write_bytes(b"clip")

        with mock.patch.object(render_backend, "run_pool", wraps=render_backend.run_pool) as pool:
            self.assertTrue(self._render(self._job(3), fake_run, 3))
        pool.assert_called_once()
        self.assertEqual(re.findall(r"seg_(\d{4})", concat["list"]), ["0000", "0001", "0002"])

    def test_a_pool_failure_renders_the_scene_one_segment_at_a_time(self):
        seen = []

        def fake_run(cmd):
            seen.append(cmd[-1])
            Path(cmd[-1]).write_bytes(b"clip")

        with mock.patch.object(render_backend, "run_pool", side_effect=RuntimeError("pool")), \
                self.assertLogs("modules.scene_render", "WARNING"):
            self.assertTrue(self._render(self._job(3), fake_run, 3))
        self.assertEqual([Path(p).name for p in seen[:3]],
                         ["seg_0000.mp4", "seg_0001.mp4", "seg_0002.mp4"])


class BenchmarkRowsTestCase(unittest.TestCase):
    def test_rows_show_na_without_a_timing_line(self):
        md = render_benchmark.render_markdown({"backend_requested": "moviepy", "repeat": 1,
                                               "exit_code": 0})
        self.assertIn("| ffmpeg: normalize segments (total) | n/a |", md)
        self.assertIn("| ffmpeg: concat | n/a |", md)
        self.assertIn("| ffmpeg: segments / workers / mode | n/a |", md)

    def test_rows_with_a_timing_line(self):
        log = ("2026-09-25 10:00:00,000 [INFO] modules.render_backend: ffmpeg render timing: "
               "segments=46 jobs=4 mode=parallel normalize_s=95.10 normalize_avg_s=7.90 "
               "concat_s=na final_s=260.00 total_s=355.40\n")
        r = render_benchmark.parse_run_log(log)
        md = render_benchmark.render_markdown({"backend_requested": "ffmpeg", "repeat": 1,
                                               "exit_code": 0, **r})
        self.assertIn("| ffmpeg: normalize segments (total) | 95.1 s |", md)
        self.assertIn("| ffmpeg: normalize per segment (avg) | 7.9 s |", md)
        self.assertIn("| ffmpeg: concat | n/a (inside final pass) |", md)
        self.assertIn("| ffmpeg: final pass (concat + captions + audio + encode) | 260.0 s |", md)
        self.assertIn("| ffmpeg: segments / workers / mode | 46 / 4 / parallel |", md)

    def test_last_timing_line_wins_and_garbage_is_none(self):
        log = ("ffmpeg render timing: segments=3 jobs=1 mode=sequential normalize_s=1.00 final_s=2.00\n"
               "ffmpeg render timing: segments=5 jobs=x mode=fallback normalize_s=oops final_s=na\n")
        r = render_benchmark.parse_render_timing(log)
        self.assertEqual(r["segments"], 5)
        self.assertEqual(r["render_mode"], "fallback")
        self.assertIsNone(r["render_jobs"])
        self.assertIsNone(r["normalize_s"])
        self.assertIsNone(r["final_s"])


if __name__ == "__main__":
    unittest.main()
