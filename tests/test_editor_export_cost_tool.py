"""Tests for tools/editor_export_cost.py — the measurement-only editor export cost tool.

The report logic is tested with a fake renderer (no ffmpeg). The documents the
tool renders are checked against the REAL timeline validator, so a limit that
moves cannot quietly turn the measurement into a pile of failed exports. One
test renders for real and is skipped without ffmpeg."""

import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from modules import timeline as tl
from tools import editor_export_cost as ec


def doc_for(aspect="16:9", effect="plain", length=20.0):
    return ec.build_doc(ec.Case(aspect, effect, length))


class DocumentsTestCase(unittest.TestCase):
    def test_every_case_is_a_valid_timeline_at_the_lengths_the_tool_allows(self):
        # A case the validator refuses would measure a failed export, not a render.
        for length in (ec.MIN_LENGTH_S, ec.DEFAULT_LENGTH_S, 33.0, 90.0, ec.MAX_LENGTH_S):
            for aspect in ec.ASPECTS:
                for effect in ec.EFFECTS:
                    with self.subTest(length=length, aspect=aspect, effect=effect):
                        norm = tl.load(doc_for(aspect, effect, length))
                        self.assertLessEqual(tl.duration_s(norm), 1800.0)

    def test_the_timeline_is_as_long_as_asked(self):
        for length in (10.0, 20.0, 33.0, 90.0):
            for effect in ec.EFFECTS:
                got = tl.duration_s(tl.load(doc_for(effect=effect, length=length)))
                # A cross-faded or ramped clip lands on a millisecond grid, not on the second.
                self.assertAlmostEqual(got, length, delta=0.1, msg=(length, effect))

    def test_the_frame_is_the_aspect_the_editor_offers(self):
        for aspect, (w, h) in tl.PRESETS.items():
            d = doc_for(aspect)
            self.assertEqual((d["width"], d["height"]), (w, h))
        self.assertEqual(set(ec.ASPECTS), set(tl.PRESETS))

    def test_each_set_adds_one_thing_to_the_plain_timeline(self):
        plain = doc_for(effect="plain")
        self.assertNotIn("captions", plain)
        v = plain["tracks"][0]["clips"]
        self.assertFalse(any("transition" in c or "speed_curve" in c for c in v))
        self.assertTrue(all(c["audio"] for c in v))  # the clips' own sound is part of the base

        caps = doc_for(effect="captions")
        self.assertGreaterEqual(len(caps["captions"]["cues"]), 5)
        self.assertEqual(caps["tracks"], plain["tracks"])

        trans = doc_for(effect="transitions")["tracks"][0]["clips"]
        self.assertEqual([c.get("transition", {}).get("type") for c in trans],
                         [None] + ["crossfade"] * (len(trans) - 1))
        self.assertGreater(len({c["transition"].get("style", "fade") for c in trans[1:]}), 1)

        ramp = doc_for(effect="speed_curve")["tracks"][0]["clips"]
        self.assertTrue(all(c["speed_curve"] == ec.SPEED_CURVE for c in ramp))
        self.assertLessEqual(max(c["out_s"] for c in ramp), ec.SOURCE_S)

    def test_documents_name_two_assets_by_id_and_no_path(self):
        text = json.dumps(doc_for(effect="transitions"))
        self.assertNotIn("/", text)
        ids = {c["asset_id"] for t in doc_for()["tracks"] for c in t["clips"]}
        self.assertEqual(ids, {ec.VIDEO_ID, ec.MUSIC_ID})


class ArgumentsTestCase(unittest.TestCase):
    def test_unknown_names_and_out_of_range_values_are_refused(self):
        self.assertEqual(ec.check_args(ec.ASPECTS, ec.EFFECTS, 20, 1), [])
        self.assertTrue(ec.check_args(["4:3"], ["plain"], 20, 1))
        self.assertTrue(ec.check_args(["16:9"], ["glitter"], 20, 1))
        self.assertTrue(ec.check_args(["16:9"], ["plain"], ec.MIN_LENGTH_S - 1, 1))
        self.assertTrue(ec.check_args(["16:9"], ["plain"], ec.MAX_LENGTH_S + 1, 1))
        self.assertTrue(ec.check_args(["16:9"], ["plain"], 20, 0))
        self.assertTrue(ec.check_args(["16:9"], ["plain"], 20, ec.MAX_REPEAT + 1))

    def test_main_refuses_bad_arguments_before_doing_anything(self):
        with mock.patch.object(ec, "make_sources") as made, redirect_stderr(io.StringIO()):
            self.assertEqual(ec.main(["--aspects", "4:3"]), 2)
        made.assert_not_called()


class ReportLogicTestCase(unittest.TestCase):
    def test_per_minute_scales_and_unknown_stays_unknown(self):
        self.assertEqual(ec.per_minute(10, 20), 30.0)
        self.assertIsNone(ec.per_minute(None, 20))
        self.assertIsNone(ec.per_minute(10, None))
        self.assertIsNone(ec.per_minute(10, 0))
        self.assertEqual(ec.per_minute(0, 20), 0.0)  # a measured zero is still a number

    def test_only_finished_exports_count_and_the_median_is_taken(self):
        case = ec.Case("9:16", "plain", 30.0)
        runs = [{"status": "done", "wall_s": 10.0, "cpu_s": 20.0, "peak_rss_mb": 500.0, "output_mb": 3.0},
                {"status": "done", "wall_s": 90.0, "cpu_s": 40.0, "peak_rss_mb": 700.0, "output_mb": 3.0},
                {"status": "done", "wall_s": 20.0, "cpu_s": 30.0, "peak_rss_mb": 600.0, "output_mb": 3.0},
                {"status": "failed", "reason": "timed_out", "wall_s": 999.0, "cpu_s": 999.0}]
        row = ec.summarise(case, 30.0, runs)
        self.assertEqual((row["runs"], row["ok_runs"]), (4, 3))
        self.assertEqual(row["wall_s_per_min"], 40.0)   # median 20 s (not the mean 40) over 30 s -> 40 s/min
        self.assertEqual(row["cpu_s_per_min"], 60.0)
        self.assertEqual(row["peak_rss_mb"], 600.0)     # not scaled by length
        self.assertEqual(row["output_mb_per_min"], 6.0)
        self.assertEqual(row["failed"], ["timed_out"])

    def test_a_case_that_never_finished_has_no_numbers_not_zeros(self):
        runs = [{"status": "failed", "reason": "render_failed", "wall_s": 3.0, "cpu_s": 2.0}, {"status": "failed"}]
        row = ec.summarise(ec.Case("1:1", "captions", 20.0), 20.0, runs)
        for key in ("wall_s_per_min", "cpu_s_per_min", "peak_rss_mb", "output_mb_per_min"):
            self.assertIsNone(row[key], key)
        self.assertEqual(row["ok_runs"], 0)
        self.assertEqual(row["failed"], ["failed", "render_failed"])

    def test_an_unmeasured_value_of_a_finished_run_is_skipped_not_averaged_in_as_zero(self):
        runs = [{"status": "done", "wall_s": 10.0, "cpu_s": 10.0, "peak_rss_mb": None, "output_mb": None}]
        row = ec.summarise(ec.Case("1:1", "plain", 10.0), 10.0, runs)
        self.assertEqual(row["wall_s_per_min"], 60.0)
        self.assertIsNone(row["peak_rss_mb"])
        self.assertIsNone(row["output_mb_per_min"])

    def test_the_matrix_runs_every_case_repeat_times_with_a_fake_renderer(self):
        calls = []

        def fake(case):
            calls.append(case)
            return {"status": "done", "wall_s": 5.0, "cpu_s": 10.0, "peak_rss_mb": 400.0, "output_mb": 1.0}

        cases = ec.plan(["16:9", "9:16"], ["plain", "speed_curve"], 20.0)
        rows = ec.run_matrix(cases, fake, 3)
        self.assertEqual(len(calls), 4 * 3)
        self.assertEqual([(r["aspect"], r["effect"]) for r in rows],
                         [("16:9", "plain"), ("16:9", "speed_curve"), ("9:16", "plain"), ("9:16", "speed_curve")])
        # The length the per-minute numbers are scaled by is the validated timeline's, not the request.
        for r in rows:
            self.assertAlmostEqual(r["output_s"], 20.0, delta=0.1)
            self.assertEqual(r["ok_runs"], 3)
            self.assertAlmostEqual(r["wall_s_per_min"], 5.0 * 60 / r["output_s"], places=1)

    def test_the_length_the_numbers_are_scaled_by_is_the_validated_timelines(self):
        # 61 cross-faded clips land on a millisecond grid: 300.02 s, not the 300 s asked for.
        case = ec.Case("1:1", "transitions", 300.0)
        want = tl.duration_s(tl.load(ec.build_doc(case)))
        self.assertNotEqual(want, 300.0)
        row = ec.run_matrix([case], lambda c: {"status": "done", "wall_s": 1.0}, 1)[0]
        self.assertEqual(row["output_s"], want)

    def test_markdown_shows_n_a_for_unknowns_and_never_a_path(self):
        rows = [ec.summarise(ec.Case("1:1", "plain", 20.0), 20.0, [{"status": "failed", "reason": "timed_out"}])]
        report = {"skipped": False, "length_s": 20.0, "repeat": 1, "rows": rows,
                  "environment": {"ffmpeg": "ffmpeg version x", "cpu_count": 4}}
        md = ec.render_markdown(report)
        self.assertIn("| 1:1 | plain | 20.0 | n/a | n/a | n/a | n/a | 0/1 (timed_out) |", md)

    def test_the_environment_block_names_no_host_user_or_path(self):
        with mock.patch.object(ec.subprocess, "run", side_effect=OSError):
            env = ec.collect_environment("/nowhere/ffmpeg")
        self.assertEqual(set(env), {"ffmpeg", "cpu_count", "memory_total_mb", "python", "os",
                                    "load_average_1m_at_start", "load_average_1m_at_end",
                                    "child_address_space_mb", "decoder_threads", "encoder_threads"})
        self.assertIsNone(env["ffmpeg"])  # unknown, not a guess


class RunnerTestCase(unittest.TestCase):
    CASE = ec.Case("16:9", "plain", 20.0)

    def run_with(self, **kw):
        with mock.patch.object(ec.subprocess, "run", **kw):
            return ec.subprocess_runner(Path("/m"), "ffmpeg", None)(self.CASE)

    def test_a_case_that_crashes_or_prints_nothing_readable_is_a_failure_with_no_timing(self):
        for out in (mock.Mock(returncode=1, stdout='{"status": "done", "wall_s": 1}\n'),
                    mock.Mock(returncode=0, stdout="not json\n"),
                    mock.Mock(returncode=0, stdout="[1, 2]\n"),
                    mock.Mock(returncode=0, stdout="")):
            got = self.run_with(return_value=out)
            self.assertEqual(got, {"status": "failed", "reason": "case_crashed"})

    def test_a_case_that_outlives_the_tools_budget_is_a_failure(self):
        got = self.run_with(side_effect=ec.subprocess.TimeoutExpired("x", 1))
        self.assertEqual(got, {"status": "failed", "reason": "tool_timeout"})

    def test_the_last_line_is_the_answer(self):
        got = self.run_with(return_value=mock.Mock(returncode=0, stdout='noise\n{"status": "done", "wall_s": 2.5}\n'))
        self.assertEqual(got, {"status": "done", "wall_s": 2.5})

    def test_peak_memory_is_megabytes_and_unknown_when_not_reported(self):
        with mock.patch.object(ec.resource, "getrusage", return_value=mock.Mock(ru_maxrss=2048000)):  # 2048000 kB on Linux, bytes on macOS
            with mock.patch.object(ec.sys, "platform", "linux"):
                self.assertEqual(ec._peak_child_rss_mb(), 2000.0)
            with mock.patch.object(ec.sys, "platform", "darwin"):
                self.assertEqual(ec._peak_child_rss_mb(), 2.0)
        with mock.patch.object(ec.resource, "getrusage", return_value=mock.Mock(ru_maxrss=0)):
            self.assertIsNone(ec._peak_child_rss_mb())


class SkipTestCase(unittest.TestCase):
    def test_without_ffmpeg_it_says_so_measures_nothing_and_writes_a_skipped_report(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(ec.shutil, "which", return_value=None), \
                mock.patch.object(ec, "make_sources") as made, mock.patch.object(ec, "subprocess_runner") as runner:
            out = Path(tmp) / "cost.json"
            md = Path(tmp) / "cost.md"
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = ec.main(["--out-json", str(out), "--out-md", str(md)])
            self.assertEqual(code, 0)
            self.assertIn("SKIPPED", buf.getvalue())
            made.assert_not_called()
            runner.assert_not_called()
            report = json.loads(out.read_text())
            self.assertTrue(report["skipped"])
            self.assertNotIn("rows", report)  # no numbers at all, not zeros
            self.assertIn("SKIPPED", md.read_text())

    def test_plan_mode_needs_no_ffmpeg(self):
        with mock.patch.object(ec.shutil, "which", return_value=None), redirect_stdout(io.StringIO()) as buf:
            self.assertEqual(ec.main(["--plan", "--aspects", "9:16", "--effects", "plain"]), 0)
        self.assertIn("9:16", buf.getvalue())


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class RealRenderTestCase(unittest.TestCase):
    def test_one_case_goes_through_the_real_export_path_and_is_measured(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            ec.make_sources(shutil.which("ffmpeg"), work, ec.MIN_LENGTH_S)
            run = ec.subprocess_runner(work, shutil.which("ffmpeg"), shutil.which("ffprobe"))
            got = run(ec.Case("1:1", "captions", ec.MIN_LENGTH_S))
        self.assertEqual(got["status"], "done", got)
        self.assertIsNone(got["reason"])
        self.assertGreater(got["wall_s"], 0)
        self.assertGreater(got["cpu_s"], 0)
        self.assertGreater(got["peak_rss_mb"], 1)
        self.assertGreater(got["output_mb"], 0)
        if got.get("output_probe_s") is not None:
            self.assertAlmostEqual(got["output_probe_s"], ec.MIN_LENGTH_S, delta=0.2)


if __name__ == "__main__":
    unittest.main()
