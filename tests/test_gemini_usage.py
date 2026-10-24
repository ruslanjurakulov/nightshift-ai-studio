"""How many Gemini requests a run makes, per stage: counted, logged once, never in the way.

Why: nobody could say how many requests one run makes or which stage spends them, so nobody could say how far
a 20-requests-a-day free tier is from enough. Every real attempt is counted at the one place that makes them
(``generate_with_retry``), retries included, keyed by stage and model.

Pinned, and what would break:

  * every attempt counts, retries included, under its own stage and model ................. EveryAttemptIsCounted
  * threads cannot lose a count ........................................................... TheCounterIsThreadSafe
  * the counter never raises and holds no prompt, response or key ......................... TheCounterIsHarmless
  * one summary line and one event at the end of a run; nothing for a run with no request . TheRunReport
  * the count is NOT a cost-ledger entry (an unpriced entry would charge the whole hold) .. NotInTheCostLedger
"""

from __future__ import annotations

import logging
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from google.genai import errors as genai_errors  # noqa: E402

from modules import cost_ledger, event_log, gemini_client, gemini_stages  # noqa: E402
from modules.gemini_stages import model_for  # noqa: E402
from tests.test_gemini_quota import FakeClient, quota_error  # noqa: E402


def row(stage, model="gemini-3.6-flash", requests=1, quota=0):
    return {"stage": stage, "model": model, "requests": requests, "daily_quota_errors": quota}


class Base(unittest.TestCase):
    def setUp(self):
        gemini_stages.reset()
        self.addCleanup(gemini_stages.reset)


class EveryAttemptIsCounted(Base):
    def test_a_success_is_one_request_under_its_stage_and_model(self):
        gemini_client.generate_with_retry(FakeClient(), model_for("script"), "p")
        self.assertEqual(gemini_stages.snapshot(), [row("script")])

    def test_retries_are_real_attempts_and_count(self):
        client = FakeClient(genai_errors.ServerError(503, {"error": {"code": 503, "status": "UNAVAILABLE"}}),
                            quota_error(per_day=False, retry="1s"))
        with patch("modules.gemini_client.time.sleep"):
            gemini_client.generate_with_retry(client, model_for("fact_check"), "p")
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(gemini_stages.snapshot(), [row("fact_check", requests=3)])

    def test_an_attempt_that_raises_something_else_still_counts(self):
        client = FakeClient(ConnectionError("reset"))
        with self.assertRaises(ConnectionError):
            gemini_client.generate_with_retry(client, model_for("research"), "p")
        self.assertEqual(gemini_stages.snapshot(), [row("research")])

    def test_stages_and_models_are_counted_apart(self):
        with patch.dict("config.GEMINI_STAGE_MODELS", {"script": "big-model"}):
            for stage, times in (("topic_pick", 2), ("script", 1), ("fact_check", 3)):
                for _ in range(times):
                    gemini_client.generate_with_retry(FakeClient(), model_for(stage), "p")
        self.assertEqual(gemini_stages.snapshot(), [row("fact_check", requests=3), row("script", "big-model"),
                                                    row("topic_pick", requests=2)])

    def test_the_daily_quota_error_is_recorded_beside_its_request(self):
        with self.assertRaises(gemini_stages.GeminiDailyQuotaError), self.assertLogs("modules.gemini_client", "ERROR"):
            gemini_client.generate_with_retry(FakeClient(quota_error()), model_for("topic_pick"), "p")
        self.assertEqual(gemini_stages.snapshot(), [row("topic_pick", quota=1)])

    def test_a_caller_that_names_no_stage_is_counted_as_unlabelled(self):
        gemini_client.generate_with_retry(FakeClient(), "gemini-plain-string", "p")
        self.assertEqual(gemini_stages.snapshot(), [row(gemini_stages.UNLABELLED, "gemini-plain-string")])


class TheCounterIsThreadSafe(Base):
    def test_no_count_is_lost_across_threads(self):
        threads, per_thread = 16, 500

        def work():
            for _ in range(per_thread):
                gemini_stages.note_request("script", "gemini-3.6-flash")
                gemini_stages.note_daily_quota("script", "gemini-3.6-flash")

        pool = [threading.Thread(target=work) for _ in range(threads)]
        for t in pool:
            t.start()
        for t in pool:
            t.join()
        self.assertEqual(gemini_stages.snapshot(), [row("script", requests=threads * per_thread, quota=threads * per_thread)])


class TheCounterIsHarmless(Base):
    def test_it_never_raises(self):
        for stage, model in ((None, None), (object(), object()), ("script", b"bytes"), ("", "")):
            gemini_stages.note_request(stage, model)
            gemini_stages.note_daily_quota(stage, model)
        self.assertIsInstance(gemini_stages.snapshot(), list)
        with patch.object(gemini_stages._COUNTER, "_lock", None):        # a broken lock must not break a request
            gemini_stages.note_request("script", "gemini-3.6-flash")
            self.assertEqual(gemini_stages.snapshot(), [])

    def test_a_failing_counter_does_not_break_the_request(self):
        with patch("modules.gemini_stages.label_model", side_effect=RuntimeError("boom")):
            response = gemini_client.generate_with_retry(FakeClient(), model_for("script"), "p")
        self.assertEqual(response.text, "ok")

    def test_it_holds_labels_and_numbers_only(self):
        secret_prompt = "SECRET-PROMPT-TEXT AIzaSyD-key"
        gemini_client.generate_with_retry(FakeClient(text="SECRET-RESPONSE"), model_for("script"), secret_prompt)
        rendered = repr(gemini_stages.snapshot()) + gemini_stages.summary_line()
        self.assertNotIn("SECRET", rendered)
        self.assertNotIn("AIza", rendered)
        for r in gemini_stages.snapshot():
            self.assertEqual(set(r), {"stage", "model", "requests", "daily_quota_errors"})

    def test_a_model_that_is_not_an_id_is_not_printed(self):
        gemini_stages.note_request("script", "AIzaSyD-pasted-key-value")
        self.assertNotIn("AIza", gemini_stages.summary_line())
        self.assertIn(gemini_stages.UNRECOGNISED_MODEL, gemini_stages.summary_line())

    def test_reset_starts_a_run_from_zero(self):
        gemini_stages.note_request("script", "gemini-3.6-flash")
        gemini_stages.reset()
        self.assertEqual(gemini_stages.snapshot(), [])
        self.assertIsNone(gemini_stages.summary_line())


class TheRunReport(Base):
    def test_the_summary_line_has_stage_model_requests_and_the_quota_errors(self):
        for _ in range(2):
            gemini_stages.note_request("topic_pick", "gemini-3.6-flash")
        gemini_stages.note_request("script", "gemini-3.6-flash")
        gemini_stages.note_daily_quota("script", "gemini-3.6-flash")
        self.assertEqual(
            gemini_stages.summary_line(),
            "Gemini requests this run: 3 (script gemini-3.6-flash x1, topic_pick gemini-3.6-flash x2); "
            "daily-quota errors: script gemini-3.6-flash x1")

    def test_a_clean_run_is_logged_at_info_and_recorded_as_a_completed_event(self):
        gemini_stages.note_request("script", "gemini-3.6-flash")
        with patch.object(event_log, "emit") as emit, self.assertLogs("modules.gemini_stages", "INFO") as logs:
            gemini_stages.report_run(channel_id="news")
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(logs.records[0].levelno, logging.INFO)
        args, kwargs = emit.call_args
        self.assertEqual(args[0], event_log.GEMINI_USAGE)
        self.assertEqual(kwargs["channel_id"], "news")
        self.assertEqual(kwargs["status"], event_log.STATUS_COMPLETED)
        self.assertEqual(kwargs["metadata"], {"requests": 1, "daily_quota_errors": 0, "stages": [row("script")]})

    def test_a_run_that_hit_the_daily_quota_is_a_warning_in_both_places(self):
        gemini_stages.note_request("topic_pick", "gemini-3.6-flash")
        gemini_stages.note_daily_quota("topic_pick", "gemini-3.6-flash")
        with patch.object(event_log, "emit") as emit, self.assertLogs("modules.gemini_stages", "INFO") as logs:
            gemini_stages.report_run()
        self.assertEqual(logs.records[0].levelno, logging.WARNING)
        self.assertEqual(emit.call_args.kwargs["status"], event_log.STATUS_WARNING)
        self.assertEqual(emit.call_args.kwargs["metadata"]["daily_quota_errors"], 1)

    def test_a_run_with_no_request_logs_and_records_nothing(self):
        with patch.object(event_log, "emit") as emit, self.assertNoLogs("modules.gemini_stages", "DEBUG"):
            gemini_stages.report_run(channel_id="news")
        emit.assert_not_called()

    def test_reporting_never_raises_even_when_the_event_store_is_down(self):
        gemini_stages.note_request("script", "gemini-3.6-flash")
        with patch.object(event_log, "emit", side_effect=RuntimeError("db down")):
            gemini_stages.report_run()

    def test_the_event_metadata_survives_the_events_secret_filter(self):
        gemini_stages.note_request("script", "gemini-3.6-flash")
        meta = {"requests": 1, "daily_quota_errors": 0, "stages": gemini_stages.snapshot()}
        self.assertNotIn("[redacted]", event_log._sanitize(meta))

    def test_the_end_of_a_run_in_main_reports_and_the_start_resets(self):
        import main

        gemini_stages.note_request("script", "gemini-3.6-flash")        # left over from an earlier run in this process
        seen = {}

        def run_that_asks(**kwargs):
            seen["at_start"] = gemini_stages.snapshot()
            gemini_stages.note_request("topic_pick", "gemini-3.6-flash")

        wrapped = main._flush_costs_on_exit(run_that_asks)
        with patch.object(gemini_stages, "report_run") as report:
            wrapped()
        self.assertEqual(seen["at_start"], [], "a new run starts from zero")
        report.assert_called_once()
        self.assertEqual(gemini_stages.snapshot(), [row("topic_pick")], "the report happens at the end, not at once")

    def test_the_report_still_happens_when_the_run_raises(self):
        import main

        def dies(**kwargs):
            raise RuntimeError("the run failed")

        with patch.object(gemini_stages, "report_run") as report, self.assertRaises(RuntimeError):
            main._flush_costs_on_exit(dies)()
        report.assert_called_once()

    def test_a_ledger_gives_the_event_its_channel(self):
        import main

        def run_with_ledger(**kwargs):
            main._RUN_COSTS.append(cost_ledger.CostLedger(channel_id="news"))

        with patch.object(gemini_stages, "report_run") as report:
            main._flush_costs_on_exit(run_with_ledger)()
        self.assertEqual(report.call_args.kwargs, {"channel_id": "news"})


class NotInTheCostLedger(unittest.TestCase):
    def test_the_ledger_has_no_request_unit_and_an_unpriced_unit_would_unprice_the_run(self):
        ledger = cost_ledger.CostLedger()
        ledger.add(cost_ledger.GEMINI_INPUT_TOKENS, 100)
        with patch.dict("os.environ", {"CHRONOS_PRICE_GEMINI_INPUT_TOKENS": "0.000001"}):
            priced = cost_ledger.CostLedger()
            priced.add(cost_ledger.GEMINI_INPUT_TOKENS, 100)
            self.assertIsNotNone(priced.total_usd())
            priced.add("gemini_requests", 7)           # what recording the count there would do
            self.assertIsNone(priced.total_usd(), "the run's total would become unknown")
        self.assertNotIn("gemini_requests", vars(cost_ledger).values())


if __name__ == "__main__":
    unittest.main()
