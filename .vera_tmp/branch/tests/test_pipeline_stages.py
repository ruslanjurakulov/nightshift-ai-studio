"""Tests for modules.pipeline_stages — the Topic->...->Publish state machine.

Every test uses a tempdir-backed store_path; the real history/ directory is
never touched.
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from modules.pipeline_stages import (
    PipelineStage,
    PipelineStateMachine,
    StageTransition,
    PipelineRun,
)


class PipelineStagesTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="pipeline_stages_test_")
        self.store_path = Path(self.tmpdir) / "pipeline_runs.json"
        self.sm = PipelineStateMachine(store_path=self.store_path)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # -- basic lifecycle --------------------------------------------------

    def test_start_run_creates_run_at_topic(self):
        run = self.sm.start_run("The Fall of Constantinople")
        self.assertEqual(run.current_stage, PipelineStage.TOPIC)
        self.assertEqual(run.topic, "The Fall of Constantinople")
        self.assertFalse(run.human_approved)
        self.assertIsNone(run.approved_by)
        self.assertEqual(len(run.history), 1)
        self.assertIsInstance(run.history[0], StageTransition)

    def test_legal_full_sequence_succeeds(self):
        run = self.sm.start_run("Topic A")
        run_id = run.run_id

        self.sm.advance(run_id, PipelineStage.RESEARCH)
        self.sm.advance(run_id, PipelineStage.SCRIPT)
        self.sm.advance(run_id, PipelineStage.FACT_CHECK)
        run = self.sm.advance(run_id, PipelineStage.HUMAN_APPROVAL)
        self.assertEqual(run.current_stage, PipelineStage.HUMAN_APPROVAL)

        run = self.sm.approve(run_id, approved_by="ruslan")
        self.assertTrue(run.human_approved)
        self.assertEqual(run.approved_by, "ruslan")
        self.assertIsNotNone(run.approved_at)

        run = self.sm.advance(run_id, PipelineStage.PUBLISH)
        self.assertEqual(run.current_stage, PipelineStage.PUBLISH)
        self.assertTrue(run.human_approved)
        self.assertEqual(run.approved_by, "ruslan")

    # -- illegal transitions ------------------------------------------------

    def test_skipping_a_stage_raises(self):
        run = self.sm.start_run("Topic B")
        with self.assertRaises(ValueError):
            self.sm.advance(run.run_id, PipelineStage.SCRIPT)  # skips RESEARCH

    def test_moving_backward_raises(self):
        run = self.sm.start_run("Topic C")
        self.sm.advance(run.run_id, PipelineStage.RESEARCH)
        self.sm.advance(run.run_id, PipelineStage.SCRIPT)
        with self.assertRaises(ValueError):
            self.sm.advance(run.run_id, PipelineStage.RESEARCH)  # backward

    def test_advance_past_publish_raises(self):
        run = self.sm.start_run("Topic D")
        run_id = run.run_id
        self.sm.advance(run_id, PipelineStage.RESEARCH)
        self.sm.advance(run_id, PipelineStage.SCRIPT)
        self.sm.advance(run_id, PipelineStage.FACT_CHECK)
        self.sm.advance(run_id, PipelineStage.HUMAN_APPROVAL)
        self.sm.approve(run_id, approved_by="ruslan")
        self.sm.advance(run_id, PipelineStage.PUBLISH)
        with self.assertRaises(ValueError):
            self.sm.advance(run_id, PipelineStage.PUBLISH)  # already published

    def test_publish_without_approval_raises(self):
        run = self.sm.start_run("Topic E")
        run_id = run.run_id
        self.sm.advance(run_id, PipelineStage.RESEARCH)
        self.sm.advance(run_id, PipelineStage.SCRIPT)
        self.sm.advance(run_id, PipelineStage.FACT_CHECK)
        self.sm.advance(run_id, PipelineStage.HUMAN_APPROVAL)
        # No approve() call.
        with self.assertRaises(ValueError):
            self.sm.advance(run_id, PipelineStage.PUBLISH)

        # Confirm the run truly did not move and is not marked approved.
        run = self.sm.get_run(run_id)
        self.assertEqual(run.current_stage, PipelineStage.HUMAN_APPROVAL)
        self.assertFalse(run.human_approved)

    def test_approve_before_human_approval_stage_raises(self):
        run = self.sm.start_run("Topic F")
        run_id = run.run_id
        # Still at TOPIC.
        with self.assertRaises(ValueError):
            self.sm.approve(run_id, approved_by="ruslan")

        self.sm.advance(run_id, PipelineStage.RESEARCH)
        with self.assertRaises(ValueError):
            self.sm.approve(run_id, approved_by="ruslan")

        self.sm.advance(run_id, PipelineStage.SCRIPT)
        self.sm.advance(run_id, PipelineStage.FACT_CHECK)
        with self.assertRaises(ValueError):
            self.sm.approve(run_id, approved_by="ruslan")

        run = self.sm.get_run(run_id)
        self.assertFalse(run.human_approved)

    def test_approve_after_publish_raises(self):
        run = self.sm.start_run("Topic G")
        run_id = run.run_id
        self.sm.advance(run_id, PipelineStage.RESEARCH)
        self.sm.advance(run_id, PipelineStage.SCRIPT)
        self.sm.advance(run_id, PipelineStage.FACT_CHECK)
        self.sm.advance(run_id, PipelineStage.HUMAN_APPROVAL)
        self.sm.approve(run_id, approved_by="ruslan")
        self.sm.advance(run_id, PipelineStage.PUBLISH)
        with self.assertRaises(ValueError):
            self.sm.approve(run_id, approved_by="someone_else")

    def test_unknown_run_id_raises(self):
        with self.assertRaises(ValueError):
            self.sm.advance("nonexistent-run-id", PipelineStage.RESEARCH)
        with self.assertRaises(ValueError):
            self.sm.approve("nonexistent-run-id", approved_by="ruslan")

    # -- persistence ---------------------------------------------------

    def test_persistence_round_trip_across_instances(self):
        run = self.sm.start_run("Persisted Topic")
        run_id = run.run_id
        self.sm.advance(run_id, PipelineStage.RESEARCH)

        second_sm = PipelineStateMachine(store_path=self.store_path)
        fetched = second_sm.get_run(run_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.current_stage, PipelineStage.RESEARCH)
        self.assertEqual(fetched.topic, "Persisted Topic")

        all_runs = second_sm.list_runs()
        self.assertEqual(len(all_runs), 1)
        self.assertEqual(all_runs[0].run_id, run_id)

    def test_empty_or_missing_store_returns_cleanly(self):
        missing_path = Path(self.tmpdir) / "does_not_exist_yet.json"
        sm = PipelineStateMachine(store_path=missing_path)
        self.assertEqual(sm.list_runs(), [])
        self.assertIsNone(sm.get_run("anything"))

    def test_get_run_missing_id_returns_none(self):
        self.sm.start_run("Topic H")
        self.assertIsNone(self.sm.get_run("some-other-run-id"))


if __name__ == "__main__":
    unittest.main()
