"""Gemini's per-day quota is an ending, not a traceback.

Evidence: Actions run 40051405982 (the scheduled Chronos run of 24 Oct, step "Run Chronos bot") died with the
SDK's raw ``ClientError: 429 RESOURCE_EXHAUSTED ... generate_content_free_tier_requests, limit: 20, model:
gemini-3.6-flash ... Generate content requests per day limit exceeded on Free Tier ... retryDelay 18573s`` and
``Process completed with exit code 1``.

Diagnosis (from the first half of that traceback): the call was ``topic_manager._generate_topic`` ->
``generate_with_retry``, i.e. it DID go through the shared handling. That handling recognised the per-day quota
(its log line is just above the traceback) and refused to retry, but then re-raised the SDK's error, and nothing
between it and ``__main__`` turned that into an ending. No call site bypasses it: ``client.models.generate_content``
is called in exactly one place (pinned below).

What is pinned, and what would break:

  * a per-day 429 is never retried, and produces ONE log line naming the model, the retry-after and the fix ..
        TheDailyQuotaIsOneLogLineAndNeverRetried
  * a per-minute 429 and a 503 are retried as before; other errors still raise the SDK's own error ........
        EverythingElseIsAsItWas
  * every stage that calls Gemini reaches that handling, and a stage that already degrades still does ......
        EveryCallSiteIsRoutedAndKeepsItsDegrade
  * no code calls ``generate_content`` anywhere else, so none can bypass it ................................
        NothingBypassesTheSharedHandling
  * the run ends with exit 80 (not a traceback), the runners read it, the worker's message is coded ........
        TheRunEndsWithTheCodeTheRunnersRead
"""

from __future__ import annotations

import io
import logging
import re
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from google.genai import errors as genai_errors  # noqa: E402

from modules import gemini_client, gemini_stages  # noqa: E402
from modules.gemini_stages import GeminiDailyQuotaError, model_for  # noqa: E402


def quota_error(*, per_day=True, model="gemini-3.6-flash", retry="18573s"):
    """The 429 body of the failed run, field for field (the free tier's per-day quota)."""
    quota_id = ("GenerateRequestsPerDayPerProjectPerModel-FreeTier" if per_day
                else "GenerateRequestsPerMinutePerProjectPerModel-FreeTier")
    details = [
        {"@type": "type.googleapis.com/google.rpc.Help", "links": [{"url": "https://ai.google.dev/gemini-api/docs/rate-limits"}]},
        {"@type": "type.googleapis.com/google.rpc.QuotaFailure",
         "violations": [{"quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                         "quotaId": quota_id, "quotaDimensions": {"location": "global", "model": model},
                         "quotaValue": "20"}]},
    ]
    if retry:
        details.append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry})
    return genai_errors.ClientError(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
                                                    "message": "You exceeded your current quota", "details": details}})


class FakeClient:
    """``client.models.generate_content`` answering from a script: an exception is raised, anything else returned."""

    def __init__(self, *outcomes, text="ok"):
        self.outcomes, self.calls, self.text = list(outcomes), [], text
        self.models = SimpleNamespace(generate_content=self._generate)

    def _generate(self, model, contents, config=None):
        self.calls.append(SimpleNamespace(model=model, contents=contents, config=config))
        outcome = self.outcomes.pop(0) if self.outcomes else SimpleNamespace(text=self.text)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def no_sleep():
    return patch("modules.gemini_client.time.sleep", side_effect=AssertionError("a per-day quota must not wait"))


class Base(unittest.TestCase):
    def setUp(self):
        gemini_stages.reset()
        self.addCleanup(gemini_stages.reset)


class TheDailyQuotaIsOneLogLineAndNeverRetried(Base):
    def run_it(self, error, model=None):
        client = FakeClient(error)
        with no_sleep(), self.assertLogs("modules.gemini_client", "INFO") as logs, \
                self.assertRaises(GeminiDailyQuotaError) as raised:
            gemini_client.generate_with_retry(client, model or model_for("topic_pick"), "prompt")
        return client, raised.exception, logs

    def test_it_is_not_retried_and_waits_for_nothing(self):
        client, _, _ = self.run_it(quota_error())
        self.assertEqual(len(client.calls), 1, "a per-day quota does not clear by waiting: one request, no retry")

    def test_one_log_line_names_the_model_the_retry_after_and_the_fix(self):
        _, err, logs = self.run_it(quota_error())
        self.assertEqual(len(logs.records), 1, "one line for the event")
        record = logs.records[0]
        self.assertEqual(record.levelno, logging.ERROR)
        self.assertIsNone(record.exc_info, "a line, not a traceback")
        line = record.getMessage()
        self.assertIn("gemini-3.6-flash", line)
        self.assertIn("18573s", line)
        self.assertIn("5h 09m", line)
        self.assertIn("GEMINI_MODEL_TOPIC", line, "the fix names the variable of the stage that hit it")
        self.assertIn("billing", line)
        self.assertEqual(str(err), line)

    def test_the_error_carries_the_facts_and_chains_the_sdks_error(self):
        _, err, _ = self.run_it(quota_error())
        self.assertEqual((err.model, err.retry_after_s, err.stage), ("gemini-3.6-flash", 18573.0, "topic_pick"))
        self.assertIsInstance(err.__cause__, genai_errors.ClientError)

    def test_the_model_google_names_wins_over_the_one_requested(self):
        _, err, _ = self.run_it(quota_error(model="gemini-3.6-flash"), model="gemini-some-other")
        self.assertEqual(err.model, "gemini-3.6-flash")

    def test_a_missing_retry_after_is_said_not_invented(self):
        _, err, logs = self.run_it(quota_error(retry=None))
        self.assertIsNone(err.retry_after_s)
        self.assertIn("no retry-after was given", logs.records[0].getMessage())

    def test_the_line_never_carries_what_is_not_a_model_id(self):
        key_like = "AIzaSyD-this-is-not-a-model-and-looks-like-a-key"
        _, err, logs = self.run_it(quota_error(model=key_like), model=key_like)
        self.assertNotIn(key_like, logs.records[0].getMessage())
        self.assertEqual(err.model, gemini_stages.UNRECOGNISED_MODEL)

    def test_the_quota_is_counted_once_beside_the_request(self):
        self.run_it(quota_error())
        self.assertEqual(gemini_stages.snapshot(),
                         [{"stage": "topic_pick", "model": "gemini-3.6-flash", "requests": 1, "daily_quota_errors": 1}])


class EverythingElseIsAsItWas(Base):
    def test_a_per_minute_429_is_retried_after_the_servers_delay(self):
        client = FakeClient(quota_error(per_day=False, retry="2s"))
        with patch("modules.gemini_client.time.sleep") as sleep:
            response = gemini_client.generate_with_retry(client, model_for("script"), "p")
        self.assertEqual(response.text, "ok")
        self.assertEqual(len(client.calls), 2)
        sleep.assert_called_once_with(2.0)

    def test_a_503_is_retried(self):
        client = FakeClient(genai_errors.ServerError(503, {"error": {"code": 503, "status": "UNAVAILABLE"}}))
        with patch("modules.gemini_client.time.sleep"):
            gemini_client.generate_with_retry(client, model_for("script"), "p")
        self.assertEqual(len(client.calls), 2)

    def test_a_per_minute_429_that_never_clears_raises_the_sdks_own_error_after_all_attempts(self):
        always = [quota_error(per_day=False, retry="1s") for _ in range(gemini_client.GEMINI_MAX_RETRIES)]
        client = FakeClient(*always)
        with patch("modules.gemini_client.time.sleep"), \
                self.assertRaises(genai_errors.ClientError) as raised:
            gemini_client.generate_with_retry(client, model_for("script"), "p")
        self.assertNotIsInstance(raised.exception, GeminiDailyQuotaError)
        self.assertEqual(len(client.calls), gemini_client.GEMINI_MAX_RETRIES)

    def test_a_bad_request_is_not_retried_and_raises_the_sdks_error(self):
        client = FakeClient(genai_errors.ClientError(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT"}}))
        with no_sleep(), self.assertRaises(genai_errors.ClientError):
            gemini_client.generate_with_retry(client, model_for("script"), "p")
        self.assertEqual(len(client.calls), 1)

    def test_the_sdk_is_handed_a_plain_string_model(self):
        client = FakeClient()
        gemini_client.generate_with_retry(client, model_for("script"), "p")
        self.assertIs(type(client.calls[0].model), str)


# ── every call site, with a fake client and the REAL shared handling ──────────────────────────────────────


def bare_topic_manager(client):
    from modules.topic_manager import TopicManager

    tm = TopicManager.__new__(TopicManager)
    tm.client, tm.channel, tm.costs = client, None, None
    tm._gate_calls, tm.channel_id = 0, None
    tm._build_prompt = lambda niche, rejected=(): "pick a topic"
    return tm


class EveryCallSiteIsRoutedAndKeepsItsDegrade(Base):
    """For each stage: the daily quota reaches the shared handling (one request, counted under the stage's own
    label with the model that stage uses), and a stage that degrades on any model failure still degrades."""

    def counted(self, stage):
        rows = [r for r in gemini_stages.snapshot() if r["stage"] == stage]
        self.assertEqual([(r["model"], r["requests"], r["daily_quota_errors"]) for r in rows],
                         [("gemini-3.6-flash", 1, 1)], gemini_stages.snapshot())

    def spent(self):
        return FakeClient(quota_error())

    def test_topic_pick_is_mandatory_so_the_error_reaches_main(self):
        tm = bare_topic_manager(self.spent())
        with no_sleep(), self.assertRaises(GeminiDailyQuotaError):
            tm._generate_topic("history")
        self.counted("topic_pick")

    def test_topic_gate_is_optional_so_it_defers_and_does_not_crash(self):
        tm = bare_topic_manager(self.spent())
        with no_sleep(), self.assertLogs("modules.topic_manager", "WARNING"):
            self.assertIsNone(tm._ask_on_niche("Some topic", "history"))
        self.counted("topic_gate")

    def test_research_raises_to_main_which_continues_without_notes(self):
        from modules import research_engine

        with patch("modules.research_engine.make_client", return_value=self.spent()), no_sleep(), \
                self.assertRaises(GeminiDailyQuotaError):
            research_engine.research_topic("Stonehenge")
        self.counted("research")
        self.assertIn("except Exception as e:\n            logger.warning(\"Research engine failed", (ROOT / "main.py").read_text())

    def test_script_is_mandatory_so_the_error_reaches_main(self):
        from modules.script_engine import ScriptEngine

        fake_pa = MagicMock()
        fake_pa.analyze_videos_as_prompt_text.return_value = ""
        with patch("modules.script_engine.make_client", return_value=self.spent()), \
                patch("modules.script_engine.PerformanceAnalyzer", return_value=fake_pa):
            engine = ScriptEngine()
        with no_sleep(), self.assertRaises(GeminiDailyQuotaError):
            engine._gen("write it")
        self.counted("script")

    def test_fact_check_raises_to_main_which_goes_on_to_the_gate_as_not_run(self):
        from modules import fact_checker

        with patch("modules.fact_checker.make_client", return_value=self.spent()), no_sleep(), \
                self.assertRaises(GeminiDailyQuotaError):
            fact_checker.fact_check_claims(["Rome was founded in 753 BC."])
        self.counted("fact_check")

    def test_grounding_judge_goes_through_the_shared_handling(self):
        from modules import grounding

        with patch("modules.gemini_client.make_client", return_value=self.spent()), no_sleep(), \
                self.assertRaises(GeminiDailyQuotaError):
            grounding._default_generate("judge these")
        self.counted("grounding")

    def test_packaging_repair_degrades_to_the_plain_hold(self):
        import main
        from modules import packaging_repair

        def run_generate(**kwargs):
            return kwargs["generate"]("rewrite the title")

        with patch("modules.gemini_client.make_client", return_value=self.spent()), no_sleep(), \
                patch.object(main.packaging_repair, "enabled", return_value=True), \
                patch.object(main.packaging_repair, "repair_packaging", side_effect=run_generate), \
                self.assertLogs("chronos", "WARNING"):
            result = main._repair_packaging(MagicMock(), MagicMock(), "t", "slug", MagicMock(), None, [], [], MagicMock(), None)
        self.assertIsNone(result, "no repair, so the run is held exactly as it was without one")
        self.counted(packaging_repair.STAGE)

    def test_comment_classification_falls_back_to_the_neutral_sentinel(self):
        from modules import comment_intelligence

        with no_sleep(), self.assertLogs("modules.comment_intelligence", "WARNING"):
            results = comment_intelligence._classify_batch(self.spent(), [{"id": 0, "text": "great video"}],
                                                           allow_retry=False)
        self.assertEqual(len(results), 1)
        self.counted("comment_intel")

    def test_comment_reply_drafting_fails_the_draft_and_releases_the_hold(self):
        from modules import comment_replies

        with patch("modules.gemini_client.make_client", return_value=self.spent()), no_sleep(), \
                self.assertRaises(GeminiDailyQuotaError):
            comment_replies.gemini_drafter("draft a reply")
        self.counted("comment_replies")
        self.assertIn("except Exception as e:", (ROOT / "modules" / "comment_replies.py").read_text())

    def test_video_critic_asks_through_the_shared_handling_with_its_own_stage(self):
        from modules import video_critic

        with no_sleep(), self.assertRaises(GeminiDailyQuotaError):
            video_critic._ask(self.spent(), model_for("video_critic"), b"\xff\xd8\xff", "look at this")
        self.counted("video_critic")
        src = (ROOT / "modules" / "video_critic.py").read_text()
        self.assertIn('model = model_for("video_critic")', src)
        self.assertIn("except Exception as e:\n            report.sheets_failed += 1", src, "a failed sheet degrades")

    def test_every_stage_label_the_code_uses_is_a_known_stage(self):
        used = set()
        for path in [ROOT / "main.py", *sorted((ROOT / "modules").glob("*.py"))]:
            used |= set(re.findall(r'model_for\("([a-z_]+)"\)', path.read_text()))
        used.add("packaging_repair")                      # main.py passes packaging_repair.STAGE
        self.assertEqual(sorted(used), sorted(gemini_stages.STAGE_GROUP), "a stage with no call site, or a call "
                         "site with a stage the table does not know")


class NothingBypassesTheSharedHandling(unittest.TestCase):
    def test_generate_content_is_called_in_exactly_one_place(self):
        offenders = []
        for folder in ("modules", "tools", "."):
            for path in sorted((ROOT / folder).glob("*.py")):
                if folder == "." and path.name != "main.py":
                    continue
                if path.name == "gemini_client.py":
                    continue
                text = path.read_text()
                if re.search(r"\.generate_content(?:_stream)?\s*\(", text):
                    offenders.append(str(path.relative_to(ROOT)))
        self.assertEqual(offenders, [], "these call the SDK directly, past generate_with_retry's quota handling")

    def test_every_generate_with_retry_call_names_a_stage_through_model_for(self):
        calls = []
        for path in [ROOT / "main.py", *sorted((ROOT / "modules").glob("*.py")), *sorted((ROOT / "tools").glob("*.py"))]:
            if path.name in ("gemini_client.py", "gemini_stages.py"):
                continue
            for lineno, line in enumerate(path.read_text().splitlines(), 1):
                if "generate_with_retry(" in line and "import" not in line and "def " not in line:
                    calls.append((path.name, lineno, line.strip()))
        self.assertGreaterEqual(len(calls), 9)
        for name, lineno, line in calls:
            # video_critic._ask receives the model its caller resolved with model_for("video_critic").
            if name == "video_critic.py":
                continue
            # main.py's call wraps its arguments over two lines.
            ok = "model_for(" in line or (name == "main.py" and line.endswith("generate_with_retry("))
            self.assertTrue(ok, f"{name}:{lineno} passes a model that no stage chose: {line}")


# ── the ending ────────────────────────────────────────────────────────────────────────────────────────


def run_main_block(run_side_effect, argv=("main.py", "--no-upload")):
    """Execute the real ``if __name__ == "__main__":`` block of main.py with ``run`` replaced."""
    import main

    source = (ROOT / "main.py").read_text()
    tail = source[source.index('if __name__ == "__main__":'):]
    namespace = dict(vars(main), __name__="__main__", run=MagicMock(side_effect=run_side_effect))
    out, err = io.StringIO(), io.StringIO()
    with patch.object(sys, "argv", list(argv)), redirect_stdout(out), redirect_stderr(err):
        try:
            exec(compile(tail, str(ROOT / "main.py"), "exec"), namespace)
        except SystemExit as exit_:
            return exit_.code, out.getvalue() + err.getvalue()
    return None, out.getvalue() + err.getvalue()


class TheRunEndsWithTheCodeTheRunnersRead(unittest.TestCase):
    def test_the_code_is_free_and_does_not_clash(self):
        from modules import budget, publish_gate, storyboard_review

        taken = {0, 1, 2, 3, 4, 254, storyboard_review.PAUSED_EXIT, budget.BUDGET_STOP_EXIT,
                 publish_gate.HELD_BEFORE_RENDER_EXIT}
        self.assertEqual(gemini_stages.GEMINI_QUOTA_EXIT, 80)
        self.assertNotIn(gemini_stages.GEMINI_QUOTA_EXIT, taken)

    def test_main_exits_80_and_prints_no_traceback(self):
        code, output = run_main_block(GeminiDailyQuotaError("gemini-3.6-flash", 18573.0, "topic_pick"))
        self.assertEqual(code, 80)
        self.assertNotIn("Traceback", output)

    def test_other_exceptions_are_still_raised_not_turned_into_the_quota_exit(self):
        with self.assertRaises(RuntimeError):
            run_main_block(RuntimeError("something else"))

    def test_the_sdks_raw_429_is_no_longer_what_leaves_the_retry_handling(self):
        with no_sleep(), self.assertRaises(GeminiDailyQuotaError):
            gemini_client.generate_with_retry(FakeClient(quota_error()), model_for("topic_pick"), "p")

    def test_the_actions_step_stays_red_with_the_remedy_and_the_hold_is_released_by_the_failure(self):
        flow = (ROOT / ".github" / "workflows" / "daily_video.yml").read_text()
        marker = f'if [ "$rc" -eq {gemini_stages.GEMINI_QUOTA_EXIT} ]; then'
        self.assertIn(marker, flow)
        block = flow[flow.index(marker):flow.index('exit "$rc"', flow.index(marker))]
        self.assertIn("::error", block)
        self.assertIn("billing", block)
        self.assertNotIn("paused=true", block, "unlike 75/78/79 this is an outage: the step must not go green")
        self.assertNotIn("exit 0", block)

    def test_the_worker_fails_the_job_with_a_quota_code_and_says_nothing_was_charged(self):
        from tools import queue_worker

        self.assertEqual(queue_worker.GEMINI_QUOTA_EXIT, gemini_stages.GEMINI_QUOTA_EXIT)
        from modules import render_error

        header = "main.py exited with code 80: Gemini's daily request quota is used up; nothing was charged"
        self.assertEqual(render_error.classify(header, ["ERROR whatever"]), render_error.PROVIDER_QUOTA)
        self.assertEqual(render_error.classify("main.py exited with code 800: x", []), render_error.UNKNOWN)
        self.assertEqual(render_error.classify("main.py exited with code 8: x", []), render_error.UNKNOWN)


if __name__ == "__main__":
    unittest.main()
