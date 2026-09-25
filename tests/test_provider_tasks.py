"""Provider task persistence: a paid generation job is never paid for twice.

The load-bearing properties:
  * a submitted task id is on disk before polling starts;
  * a retry of the same run polls an unfinished task instead of re-submitting;
  * a clip that already finished (and is on disk) is reused with no request;
  * a changed prompt, a provider-reported failure, or a different run epoch
    means a fresh submit — the ledger never reuses the wrong clip;
  * clients that do not opt in (and MagicMocks) keep the one-shot path.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import MagicMock, patch

from modules import minimax_broll as mb
from modules import provider_tasks as pt
from modules import run_checkpoint


def _spec(i=0, prompt="ruins at dawn"):
    return mb.GenerationSpec(prompt=prompt, duration_seconds=6, section_index=i, keyword="ruins")


class FakeResumableClient:
    """Split submit/resume client that records every call."""

    supports_task_resume = True

    def __init__(self, outcomes=None, task_ids=None):
        self.submits = []
        self.resumes = []
        self._outcomes = list(outcomes or [])
        self._task_ids = list(task_ids or ["task-1", "task-2", "task-3"])

    def submit(self, spec):
        self.submits.append(spec)
        return self._task_ids.pop(0)

    def resume(self, task_id, out_path):
        self.resumes.append(task_id)
        state = self._outcomes.pop(0) if self._outcomes else pt.OUTCOME_SUCCEEDED
        if state == pt.OUTCOME_SUCCEEDED:
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            Path(out_path).write_bytes(b"clip")
            return pt.TaskOutcome(state, Path(out_path))
        return pt.TaskOutcome(state)

    def generate(self, spec, out_path):   # pragma: no cover - must not be used
        raise AssertionError("a resumable client goes through submit/resume")


class HelpersTestCase(unittest.TestCase):
    def test_scene_id_matches_the_ir_contract(self):
        self.assertEqual(pt.scene_id(0), "s000")
        self.assertEqual(pt.scene_id(17), "s017")

    def test_prompt_hash_is_stable_and_sensitive(self):
        a = pt.prompt_hash("minimax", "H3", _spec())
        self.assertEqual(a, pt.prompt_hash("MiniMax", "H3", _spec()))
        self.assertNotEqual(a, pt.prompt_hash("minimax", "H3", _spec(prompt="other")))
        self.assertNotEqual(a, pt.prompt_hash("minimax", "H4", _spec()))
        self.assertNotEqual(a, pt.prompt_hash("kling", "H3", _spec()))
        self.assertEqual(len(a), 16)

    def test_magicmock_is_not_mistaken_for_opting_in(self):
        self.assertFalse(pt.supports_resume(MagicMock()))
        self.assertTrue(pt.supports_resume(FakeResumableClient()))


class LedgerTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        run_checkpoint.record_stage("topic", run_checkpoint.STAGE_SCRIPT, root=self.root)

    def test_submitted_task_is_persisted_without_the_prompt(self):
        ledger = pt.TaskLedger.open("topic", root=self.root)
        ledger.record_submitted(provider="minimax", model="H3", task_id="t-9",
                                section_index=3, phash="abc")
        raw = json.loads(pt.ledger_path("topic", self.root).read_text())
        self.assertEqual(raw["tasks"][0]["task_id"], "t-9")
        self.assertEqual(raw["tasks"][0]["scene_id"], "s003")
        self.assertEqual(raw["tasks"][0]["status"], pt.STATUS_SUBMITTED)
        self.assertNotIn("prompt", raw["tasks"][0])
        again = pt.TaskLedger.open("topic", root=self.root)
        self.assertEqual(again.find("minimax", "s003", "abc").task_id, "t-9")

    def test_another_runs_tasks_are_ignored(self):
        ledger = pt.TaskLedger.open("topic", root=self.root)
        ledger.record_submitted(provider="minimax", model="H3", task_id="t-1",
                                section_index=0, phash="abc")
        # The run published: its checkpoint is cleared; the next run is new.
        run_checkpoint.clear("topic", root=self.root)
        run_checkpoint.record_stage("topic", run_checkpoint.STAGE_SCRIPT, root=self.root)
        with patch.object(run_checkpoint, "run_epoch", return_value="a-new-epoch"):
            fresh = pt.TaskLedger.open("topic", root=self.root)
        self.assertIsNone(fresh.find("minimax", "s000", "abc"))

    def test_corrupt_ledger_is_treated_as_empty(self):
        path = pt.ledger_path("topic", self.root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json")
        self.assertEqual(pt.TaskLedger.open("topic", root=self.root).tasks, [])

    def test_in_memory_ledger_writes_nothing(self):
        ledger = pt.TaskLedger.open(None)
        ledger.record_submitted(provider="minimax", model="", task_id="t", section_index=0, phash="h")
        self.assertIsNotNone(ledger.find("minimax", "s000", "h"))


class GenerateBrollTrackedTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        run_checkpoint.record_stage("topic", run_checkpoint.STAGE_SCRIPT, root=self.root)
        self.sections = [{"keywords": ["hook"], "duration": 5}, {"keywords": ["ruins"], "duration": 20}]
        patches = [
            patch("config.MINIMAX_BROLL_ENABLED", True),
            patch("config.MINIMAX_BROLL_MAX_CLIPS", 2),
            patch("config.OUTPUT_DIR", self.root),
            patch("modules.provider_tasks.ledger_path",
                  lambda slug, root=None: self.root / slug / pt.LEDGER_FILENAME),
            patch("modules.run_checkpoint.run_epoch",
                  lambda slug, root=None: run_checkpoint.load(slug, self.root).created_at),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _fetcher(self):
        from modules.media_fetcher import MediaFetcher
        f = MediaFetcher.__new__(MediaFetcher)
        f.slug = "topic"
        f.video_dir = self.root / "topic" / "media" / "videos"
        f.video_terms = {}
        return f

    def test_fresh_run_submits_and_records_each_task(self):
        client = FakeResumableClient()
        fetcher = self._fetcher()
        result = fetcher.generate_broll(self.sections, "History", client=client)
        # Provenance (PR 1.2): each clip is tied to the paid task that made it.
        self.assertEqual(
            {fetcher.provenance[p]["task_id"] for p in result.by_section.values()},
            {"task-1", "task-2"})
        self.assertEqual(len(client.submits), 2)
        self.assertEqual(result.generated, 2)
        self.assertEqual(result.reused, 0)
        self.assertEqual(result.newly_generated, 2)
        self.assertEqual(result.to_dict()["task_ids"], {"s000": "task-1", "s001": "task-2"})
        tasks = json.loads((self.root / "topic" / pt.LEDGER_FILENAME).read_text())["tasks"]
        self.assertEqual({t["status"] for t in tasks}, {pt.STATUS_SUCCEEDED})

    def test_a_crash_while_polling_is_resumed_by_polling_not_resubmitting(self):
        crashing = FakeResumableClient()
        crashing.resume = MagicMock(side_effect=KeyboardInterrupt)
        with self.assertRaises(KeyboardInterrupt):
            self._fetcher().generate_broll(self.sections[:1], "History", client=crashing)
        self.assertEqual(len(crashing.submits), 1)   # paid once

        retry = FakeResumableClient(task_ids=["must-not-be-used"])
        result = self._fetcher().generate_broll(self.sections[:1], "History", client=retry)
        self.assertEqual(retry.submits, [])           # never paid again
        self.assertEqual(retry.resumes, ["task-1"])   # polled the original job
        self.assertEqual(result.generated, 1)
        self.assertEqual(result.newly_generated, 1)  # the crashed run never got to count it

    def test_a_poll_timeout_keeps_the_task_for_the_next_attempt(self):
        first = FakeResumableClient(outcomes=[pt.OUTCOME_PENDING])
        result = self._fetcher().generate_broll(self.sections[:1], "History", client=first)
        self.assertEqual(result.generated, 0)   # this attempt fell back to stock
        second = FakeResumableClient(task_ids=["must-not-be-used"])
        self._fetcher().generate_broll(self.sections[:1], "History", client=second)
        self.assertEqual(second.submits, [])
        self.assertEqual(second.resumes, ["task-1"])

    def test_a_finished_clip_on_disk_is_reused_without_any_request(self):
        self._fetcher().generate_broll(self.sections, "History", client=FakeResumableClient())
        again = FakeResumableClient()
        result = self._fetcher().generate_broll(self.sections, "History", client=again)
        self.assertEqual(again.submits, [])
        self.assertEqual(again.resumes, [])
        self.assertEqual(result.generated, 2)
        self.assertEqual(result.reused, 2)
        self.assertEqual(result.newly_generated, 0)

    def test_a_provider_reported_failure_is_submitted_afresh(self):
        self._fetcher().generate_broll(self.sections[:1], "History",
                                       client=FakeResumableClient(outcomes=[pt.OUTCOME_FAILED]))
        again = FakeResumableClient(task_ids=["task-new"])
        result = self._fetcher().generate_broll(self.sections[:1], "History", client=again)
        self.assertEqual(len(again.submits), 1)
        self.assertEqual(result.task_ids, {0: "task-new"})

    def test_a_changed_prompt_is_a_new_clip(self):
        self._fetcher().generate_broll(self.sections[:1], "History",
                                       client=FakeResumableClient(outcomes=[pt.OUTCOME_PENDING]))
        again = FakeResumableClient(task_ids=["task-other"])
        self._fetcher().generate_broll(self.sections[:1], "Geography", client=again)
        self.assertEqual(len(again.submits), 1)

    def test_a_failed_submit_records_nothing(self):
        client = FakeResumableClient()
        client.submit = lambda spec: None
        result = self._fetcher().generate_broll(self.sections[:1], "History", client=client)
        self.assertEqual(result.generated, 0)
        self.assertFalse((self.root / "topic" / pt.LEDGER_FILENAME).exists())


class ClientSplitTestCase(unittest.TestCase):
    """The real clients: submit → resume, and resume alone makes no POST."""

    class _Resp:
        def __init__(self, payload=None, chunks=None):
            self._payload = payload or {}
            self._chunks = chunks or []

        def raise_for_status(self):
            pass

        def json(self):
            return self._payload

        def iter_content(self, chunk_size=0):
            return iter(self._chunks)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def test_generic_client_resume_polls_without_submitting(self):
        from modules import video_providers as vp
        cfg = vp.VideoProviderConfig(name="T", api_key="k", base_url="https://x",
                                     model="m", submit_path="/s", query_path="/j/{id}")
        client = vp.GenericAsyncVideoClient(cfg)
        client.session = mock.Mock()
        client.session.post.side_effect = AssertionError("resume must not submit")
        client.session.get.side_effect = [
            self._Resp({"status": "completed", "url": "https://cdn/x.mp4"}),
            self._Resp(chunks=[b"\x00\x01"]),
        ]
        with tempfile.TemporaryDirectory() as d:
            outcome = client.resume("job-7", Path(d) / "c.mp4")
            self.assertEqual(outcome.state, pt.OUTCOME_SUCCEEDED)
            self.assertTrue(outcome.path.exists())

    def test_generic_client_network_blip_is_pending_not_failed(self):
        from modules import video_providers as vp
        cfg = vp.VideoProviderConfig(name="T", api_key="k", base_url="https://x",
                                     model="m", submit_path="/s", query_path="/j/{id}")
        client = vp.GenericAsyncVideoClient(cfg)
        client.session = mock.Mock()
        client.session.get.side_effect = ConnectionError("reset")
        self.assertEqual(client.resume("job-7", Path("/tmp/none.mp4")).state, pt.OUTCOME_PENDING)

    def test_minimax_resume_and_failure_states(self):
        from modules.minimax_client import MiniMaxClient
        client = MiniMaxClient(api_key="k")
        client.session = mock.Mock()
        client.session.post.side_effect = AssertionError("resume must not submit")
        client.session.get.return_value = self._Resp({"status": "Fail"})
        self.assertEqual(client.resume("t", Path("/tmp/none.mp4")).state, pt.OUTCOME_FAILED)
        self.assertTrue(pt.supports_resume(client))

    def test_resume_without_a_key_makes_no_request(self):
        from modules.minimax_client import MiniMaxClient
        client = MiniMaxClient(api_key="")
        client.session = mock.Mock()
        client.session.get.side_effect = AssertionError("no network without a key")
        self.assertEqual(client.resume("t", Path("/tmp/none.mp4")).state, pt.OUTCOME_PENDING)
        self.assertIsNone(client.submit(_spec()))


if __name__ == "__main__":
    unittest.main()
