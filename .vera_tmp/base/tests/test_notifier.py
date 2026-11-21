import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import modules.notifier as notifier
from modules.notifier import Notifier, build_pending_approval_summary, slugify
from modules.pipeline_stages import PipelineStage, PipelineRun, StageTransition


def _iso(minutes_ago: int = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _make_run(run_id, topic, current_stage, human_approved=False, history=None):
    return PipelineRun(
        run_id=run_id,
        topic=topic,
        current_stage=current_stage,
        history=history or [],
        human_approved=human_approved,
    )


class FakePipeline:
    def __init__(self, runs):
        self._runs = runs

    def list_runs(self):
        return self._runs


class BuildPendingApprovalSummaryTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.output_dir = Path(self._tmpdir.name) / "output"
        self._orig_output_dir = notifier.OUTPUT_DIR
        notifier.OUTPUT_DIR = self.output_dir

    def tearDown(self):
        notifier.OUTPUT_DIR = self._orig_output_dir
        self._tmpdir.cleanup()

    def test_no_pending_runs_returns_empty_string(self):
        runs = [
            _make_run("r1", "Approved topic", PipelineStage.HUMAN_APPROVAL, human_approved=True),
            _make_run("r2", "Still researching", PipelineStage.RESEARCH),
        ]
        summary = build_pending_approval_summary(pipeline=FakePipeline(runs))
        self.assertEqual(summary, "")

    def test_one_pending_run_includes_run_id_and_topic(self):
        history = [
            StageTransition(stage=PipelineStage.TOPIC, timestamp=_iso(120)),
            StageTransition(stage=PipelineStage.HUMAN_APPROVAL, timestamp=_iso(30)),
        ]
        run = _make_run("run-abc123", "The Lost City of Z", PipelineStage.HUMAN_APPROVAL, history=history)
        summary = build_pending_approval_summary(pipeline=FakePipeline([run]))
        self.assertIn("run-abc123", summary)
        self.assertIn("The Lost City of Z", summary)
        self.assertIn("waiting", summary)

    def test_pending_run_with_flagged_fact_check_mentions_flag_count(self):
        history = [StageTransition(stage=PipelineStage.HUMAN_APPROVAL, timestamp=_iso(5))]
        topic = "Genghis Khan's Lost Tomb"
        run = _make_run("run-xyz", topic, PipelineStage.HUMAN_APPROVAL, history=history)

        fc_dir = self.output_dir / slugify(topic)
        fc_dir.mkdir(parents=True)
        (fc_dir / "fact_check.json").write_text(json.dumps([
            {"claim": "X happened in 1200", "verdict": "likely_inaccurate", "reasoning": "disputed", "requires_human_review": True},
            {"claim": "Y is well documented", "verdict": "likely_accurate", "reasoning": "consistent", "requires_human_review": False},
        ]))

        summary = build_pending_approval_summary(pipeline=FakePipeline([run]))
        self.assertIn("1/2 claim(s) flagged", summary)

    def test_pending_run_without_fact_check_file_does_not_crash_or_mention_flags(self):
        history = [StageTransition(stage=PipelineStage.HUMAN_APPROVAL, timestamp=_iso(5))]
        run = _make_run("run-nofc", "No fact check yet", PipelineStage.HUMAN_APPROVAL, history=history)
        summary = build_pending_approval_summary(pipeline=FakePipeline([run]))
        self.assertIn("run-nofc", summary)
        self.assertNotIn("flagged", summary)

    def test_default_constructs_pipeline_state_machine_when_none_injected(self):
        with patch("modules.notifier.PipelineStateMachine") as MockPSM:
            instance = MockPSM.return_value
            instance.list_runs.return_value = []
            summary = build_pending_approval_summary()
            MockPSM.assert_called_once_with()
            self.assertEqual(summary, "")


class NotifierTestCase(unittest.TestCase):
    def test_empty_summary_is_a_noop(self):
        n = Notifier()
        self.assertEqual(n.send(""), {})
        self.assertEqual(n.send("   \n  "), {})

    @patch.dict("os.environ", {}, clear=True)
    def test_log_channel_always_succeeds_without_env_var(self):
        n = Notifier()
        result = n.send("1 run(s) pending human approval:\n  r1 — Some Topic")
        self.assertEqual(result, {"log": True})

    @patch.dict("os.environ", {}, clear=True)
    def test_slack_channel_skipped_when_no_webhook_url(self):
        n = Notifier()
        with patch("modules.notifier.requests.post") as mock_post:
            result = n.send("summary text")
            mock_post.assert_not_called()
            self.assertNotIn("slack", result)
            self.assertEqual(result["log"], True)

    @patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.example/T000/B000/xxx"})
    def test_slack_channel_succeeds_on_200(self):
        mock_response = MagicMock(status_code=200)
        with patch("modules.notifier.requests.post", return_value=mock_response) as mock_post:
            n = Notifier()
            result = n.send("summary text")
            mock_post.assert_called_once_with(
                "https://hooks.slack.example/T000/B000/xxx",
                json={"text": "summary text"},
                timeout=10,
            )
            self.assertEqual(result["slack"], True)
            self.assertEqual(result["log"], True)

    @patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.example/T000/B000/xxx"})
    def test_slack_channel_reports_failure_on_non_2xx_without_raising(self):
        mock_response = MagicMock(status_code=500)
        with patch("modules.notifier.requests.post", return_value=mock_response):
            n = Notifier()
            result = n.send("summary text")
            self.assertEqual(result["slack"], False)

    @patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.example/T000/B000/xxx"})
    def test_slack_channel_reports_failure_on_request_exception_without_raising(self):
        import requests as real_requests
        with patch("modules.notifier.requests.post", side_effect=real_requests.ConnectionError("boom")):
            n = Notifier()
            try:
                result = n.send("summary text")
            except Exception as e:  # pragma: no cover - the point of this test is that this never happens
                self.fail(f"Notifier.send() raised {e!r} instead of reporting failure")
            self.assertEqual(result["slack"], False)


if __name__ == "__main__":
    unittest.main()
