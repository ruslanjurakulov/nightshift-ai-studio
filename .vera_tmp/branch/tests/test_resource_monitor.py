"""Tests for modules.resource_monitor — the memory diagnostic.

Its whole job is to survive being wrong: two runs died with no diagnosis, and
a diagnostic that can raise would turn a survivable render into a failed one.
So most of these test the failure paths.
"""

import logging
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from modules.resource_monitor import (
    MAX_CHILDREN_NAMED,
    ChildProcess,
    MemorySampler,
    _page_size_bytes,
    child_processes,
    current_stage,
    describe_children,
    describe_usage,
    mark_stage,
    process_rss_mb,
    system_memory_mb,
)


def _write(directory: str, name: str, text: str) -> Path:
    path = Path(directory) / name
    path.write_text(text)
    return path


STATUS = "Name:\tpython\nVmPeak:\t 2000000 kB\nVmRSS:\t 1048576 kB\nThreads:\t4\n"
MEMINFO = "MemTotal:        7000000 kB\nMemFree:          100000 kB\nMemAvailable:    2048000 kB\n"


class ProcReadingTests(unittest.TestCase):
    def test_rss_and_system_memory_are_read_in_mb(self):
        with TemporaryDirectory() as d:
            status = _write(d, "status", STATUS)
            meminfo = _write(d, "meminfo", MEMINFO)
            self.assertAlmostEqual(process_rss_mb(status), 1024.0)
            total, available = system_memory_mb(meminfo)
            self.assertAlmostEqual(total, 7000000 / 1024)
            self.assertAlmostEqual(available, 2000.0)

    def test_a_missing_file_is_none_not_an_exception(self):
        missing = Path("/nonexistent/proc/status")
        self.assertIsNone(process_rss_mb(missing))
        self.assertEqual(system_memory_mb(missing), (None, None))
        self.assertIsNone(describe_usage(missing, missing))

    def test_an_absent_or_unparseable_key_is_none(self):
        with TemporaryDirectory() as d:
            self.assertIsNone(process_rss_mb(_write(d, "a", "Threads:\t4\n")))
            self.assertIsNone(process_rss_mb(_write(d, "b", "VmRSS:\tlots kB\n")))
            self.assertIsNone(process_rss_mb(_write(d, "c", "VmRSS:\n")))

    def test_unknown_is_named_never_reported_as_zero(self):
        # A 0 here would read as "no memory used", which is the opposite of
        # what an unreadable value means.
        with TemporaryDirectory() as d:
            status = _write(d, "status", STATUS)
            partial = _write(d, "meminfo", "MemTotal:        7000000 kB\n")
            line = describe_usage(status, partial)
            self.assertIn("unknown available", line)
            self.assertNotIn("0 MB available", line)

    def test_a_readable_line_names_both_the_process_and_the_machine(self):
        with TemporaryDirectory() as d:
            line = describe_usage(_write(d, "s", STATUS), _write(d, "m", MEMINFO))
            self.assertIn("process RSS 1024 MB", line)
            self.assertIn("2000 MB available", line)


class MemorySamplerTests(unittest.TestCase):
    def test_it_records_a_peak_and_a_floor_and_logs_a_summary(self):
        with self.assertLogs("modules.resource_monitor", level=logging.INFO) as logs:
            with MemorySampler("render", interval=3600) as sampler:
                pass
        self.assertTrue(any("Memory summary for render" in m for m in logs.output))
        # This test runs on Linux in CI; where /proc is absent both stay None
        # and the sampler is silent, which is also correct.
        if sampler.peak_rss_mb is not None:
            self.assertGreater(sampler.peak_rss_mb, 0)

    def test_the_thread_does_not_outlive_the_block(self):
        with MemorySampler("render", interval=0.01) as sampler:
            pass
        self.assertIsNone(sampler._thread)

    def test_a_sample_never_raises(self):
        # The one thing this module must not do is take the render down with it.
        sampler = MemorySampler("render")
        with patch("modules.resource_monitor.process_rss_mb", side_effect=OSError("boom")):
            sampler.sample()  # must not propagate
        self.assertIsNone(sampler.peak_rss_mb)

    def test_no_proc_means_no_thread_and_no_noise(self):
        with patch("modules.resource_monitor.describe_usage", return_value=None):
            with MemorySampler("render", interval=0.01) as sampler:
                self.assertIsNone(sampler._thread)


PAGE_SIZE = _page_size_bytes() or 4096


def _stat_line(pid: int, comm: str, ppid: int, rss_mb: float) -> str:
    """A /proc/<pid>/stat line with the three fields the module reads.

    The rest are zeroes: their values are never looked at, only their count,
    because rss is positional (field 24) and a short line must be rejected
    rather than misread.
    """
    pages = int(rss_mb * 1024 * 1024 / PAGE_SIZE)
    fields = ["S", str(ppid)] + ["0"] * 19 + [str(pages)]
    return f"{pid} ({comm}) " + " ".join(fields) + "\n"


def _fake_proc(directory: str, processes: list[tuple[int, str, int, float]]) -> Path:
    root = Path(directory)
    for pid, comm, ppid, rss_mb in processes:
        proc_dir = root / str(pid)
        proc_dir.mkdir()
        (proc_dir / "stat").write_text(_stat_line(pid, comm, ppid, rss_mb))
    (root / "meminfo").write_text(MEMINFO)  # a non-numeric entry, to be skipped
    return root


class ChildProcessTests(unittest.TestCase):
    """The 3.8 GB burst is invisible in the parent's RSS, so children are the
    measurement. These check that the tree is walked, not just its first level.
    """

    def test_every_descendant_is_counted_not_only_direct_children(self):
        with TemporaryDirectory() as d:
            root = _fake_proc(d, [
                (100, "python3", 1, 900),
                (200, "ffmpeg", 100, 400),
                (300, "ffmpeg", 200, 250),   # a grandchild, e.g. behind a wrapper
                (400, "unrelated", 1, 8000),  # not ours at any depth
            ])
            found = child_processes(100, root)
            self.assertEqual([c.pid for c in found], [200, 300])
            self.assertAlmostEqual(found[0].rss_mb, 400, delta=1)

    def test_the_heaviest_child_is_named_first(self):
        # The listing is truncated from the tail, so the tail must be the cheap end.
        with TemporaryDirectory() as d:
            root = _fake_proc(d, [
                (100, "python3", 1, 900),
                (200, "ffmpeg", 100, 50),
                (300, "ffmpeg", 100, 700),
            ])
            self.assertEqual([c.pid for c in child_processes(100, root)], [300, 200])

    def test_a_name_with_spaces_and_parens_is_read_whole(self):
        with TemporaryDirectory() as d:
            root = _fake_proc(d, [
                (100, "python3", 1, 900),
                (200, "ffmpeg (x264)", 100, 120),
            ])
            found = child_processes(100, root)
            self.assertEqual(found[0].name, "ffmpeg (x264)")
            self.assertAlmostEqual(found[0].rss_mb, 120, delta=1)

    def test_a_process_that_exits_mid_scan_is_skipped_not_fatal(self):
        # The listing and the read are not atomic; ffmpeg processes here are
        # short-lived by hypothesis, so this is the common case, not the rare one.
        with TemporaryDirectory() as d:
            root = _fake_proc(d, [(100, "python3", 1, 900), (200, "ffmpeg", 100, 120)])
            (root / "300").mkdir()  # a pid dir whose stat never appears
            (root / "400").mkdir()
            (root / "400" / "stat").write_text("400 (truncated) S 100\n")
            self.assertEqual([c.pid for c in child_processes(100, root)], [200])

    def test_no_proc_at_all_is_empty_not_an_exception(self):
        self.assertEqual(child_processes(100, Path("/nonexistent/proc")), [])

    def test_a_parent_cycle_terminates_the_walk_instead_of_hanging_it(self):
        # A scan is not atomic: reading pid 200 before it is reparented and pid
        # 100 after can produce a table where each claims the other as parent.
        # Without the visited set that is an infinite loop inside the render.
        with TemporaryDirectory() as d:
            root = _fake_proc(d, [
                (100, "python3", 200, 900),  # claims its own child as parent
                (200, "ffmpeg", 100, 10),
                (300, "ffmpeg", 200, 10),
            ])
            self.assertEqual(sorted(c.pid for c in child_processes(100, root)), [200, 300])


class DescribeChildrenTests(unittest.TestCase):
    def test_it_names_each_pid_its_rss_the_count_and_the_ffmpeg_share(self):
        line = describe_children([
            ChildProcess(4211, "ffmpeg", 402.0),
            ChildProcess(4219, "convert", 88.0),
        ])
        self.assertIn("2 child process(es) (1 ffmpeg)", line)
        self.assertIn("totalling 490 MB", line)
        self.assertIn("ffmpeg pid 4211 RSS 402 MB", line)
        self.assertIn("convert pid 4219 RSS 88 MB", line)

    def test_a_long_list_is_truncated_but_the_count_is_never_lost(self):
        # Sixty spawns is one of the hypotheses; the count has to survive it
        # even when the per-pid listing does not.
        children = [ChildProcess(1000 + i, "ffmpeg", float(60 - i)) for i in range(60)]
        line = describe_children(children)
        self.assertIn("60 child process(es) (60 ffmpeg)", line)
        self.assertIn(f"+{60 - MAX_CHILDREN_NAMED} more", line)

    def test_none_is_said_out_loud_rather_than_left_blank(self):
        self.assertEqual(describe_children([]), "no child processes")

    def test_an_unreadable_rss_is_named_unknown_not_zero(self):
        self.assertIn("RSS unknown", describe_children([ChildProcess(1, "ffmpeg", None)]))


class StageTests(unittest.TestCase):
    def tearDown(self):
        mark_stage(None)

    def test_the_stage_in_flight_is_readable_and_clearable(self):
        mark_stage("encode")
        self.assertEqual(current_stage(), "encode")
        mark_stage(None)
        self.assertIsNone(current_stage())

    def test_a_sampler_never_leaves_a_stale_stage_behind(self):
        # A label that outlived its block would attribute the next block's
        # spike to the wrong phase, which is worse than having no label.
        with MemorySampler("render", interval=3600):
            mark_stage("encode")
        self.assertIsNone(current_stage())

    def test_marking_a_stage_never_raises(self):
        with patch("modules.resource_monitor.describe_usage", side_effect=OSError("boom")):
            mark_stage("encode")  # must not propagate


class SamplerAttributionTests(unittest.TestCase):
    """What the summary has to answer: how many children, how heavy, when."""

    def tearDown(self):
        mark_stage(None)

    def test_it_records_the_peak_child_count_and_the_stage_that_held_it(self):
        sampler = MemorySampler("render")
        with patch("modules.resource_monitor.child_processes") as children:
            children.return_value = [ChildProcess(1, "ffmpeg", 100.0)]
            mark_stage("build clip pool")
            sampler.sample()
            children.return_value = [
                ChildProcess(2, "ffmpeg", 900.0), ChildProcess(3, "ffmpeg", 800.0),
            ]
            mark_stage("encode")
            sampler.sample()
        self.assertEqual(sampler.peak_children, 2)
        self.assertEqual(sampler.peak_children_stage, "encode")
        self.assertEqual(sampler.peak_child_rss_mb, 1700.0)
        self.assertEqual(sampler.peak_child_rss_stage, "encode")

    def test_pids_that_come_and_go_are_still_counted_in_the_total(self):
        # A reader respawned per seek never shows more than one live process at
        # a time, and would be invisible to a concurrent count alone.
        sampler = MemorySampler("render")
        with patch("modules.resource_monitor.child_processes") as children:
            for pid in range(10, 40):
                children.return_value = [ChildProcess(pid, "ffmpeg", 50.0)]
                sampler.sample()
        self.assertEqual(sampler.peak_children, 1)
        self.assertEqual(len(sampler.child_pids_seen), 30)
        self.assertEqual(len(sampler.ffmpeg_pids_seen), 30)

    def test_the_sample_line_carries_the_stage_and_the_children(self):
        with self.assertLogs("modules.resource_monitor", level=logging.INFO) as logs:
            sampler = MemorySampler("render")
            with patch(
                "modules.resource_monitor.child_processes",
                return_value=[ChildProcess(4211, "ffmpeg", 402.0)],
            ):
                mark_stage("encode")
                sampler.sample()
        during = [m for m in logs.output if "Memory during render" in m]
        self.assertTrue(during)
        self.assertIn("[encode]", during[-1])
        self.assertIn("ffmpeg pid 4211 RSS 402 MB", during[-1])

    def test_a_sample_survives_an_unreadable_process_table(self):
        sampler = MemorySampler("render")
        with patch(
            "modules.resource_monitor.child_processes", side_effect=OSError("boom")
        ):
            sampler.sample()  # must not propagate
        self.assertEqual(sampler.peak_children, 0)

    def test_the_summary_reports_children_even_when_nothing_else_is_readable(self):
        sampler = MemorySampler("render")
        with patch("modules.resource_monitor.process_rss_mb", return_value=None), \
                patch("modules.resource_monitor.system_memory_mb", return_value=(None, None)), \
                patch(
                    "modules.resource_monitor.child_processes",
                    return_value=[ChildProcess(4211, "ffmpeg", 402.0)],
                ):
            sampler.sample()
            with self.assertLogs("modules.resource_monitor", level=logging.INFO) as logs:
                sampler._log_summary()
        self.assertTrue(any("1 distinct child pid(s) seen" in m for m in logs.output))


class WhisperModelReleaseTests(unittest.TestCase):
    """The model must not still be resident during the render.

    whisper pulls in torch, which is too heavy to require here, so the module
    is stubbed when it is genuinely absent. CI installs the real one and this
    then runs against it.
    """

    @staticmethod
    def _subtitle_generator():
        if "whisper" not in sys.modules:
            try:
                import whisper  # noqa: F401
            except ImportError:
                stub = types.ModuleType("whisper")
                stub.Whisper = type("Whisper", (), {})
                stub.load_model = lambda name: stub.Whisper()
                sys.modules["whisper"] = stub
        from modules.subtitle_generator import SubtitleGenerator
        return SubtitleGenerator

    def test_releasing_drops_the_model(self):
        gen = self._subtitle_generator()("slug-under-test")
        gen._model = object()
        gen.release_model()
        self.assertIsNone(gen._model)

    def test_releasing_twice_and_releasing_unused_are_both_no_ops(self):
        gen = self._subtitle_generator()("slug-under-test")
        gen.release_model()  # never loaded
        self.assertIsNone(gen._model)
        gen._model = object()
        gen.release_model()
        gen.release_model()
        self.assertIsNone(gen._model)


if __name__ == "__main__":
    unittest.main()
