"""Run checkpoint: recording each completed stage so a crashed run can resume by
reusing on-disk artifacts instead of re-paying for them. The two rules under
test are that a checkpoint never lies about what exists (a stage is resumable
only when its files are still there) and that recording never raises."""

import json
import tempfile
import unittest
from pathlib import Path

from modules import run_checkpoint as rc


class RecordAndLoadTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _touch(self, slug: str, name: str) -> Path:
        p = self.root / slug / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x")
        return p

    def test_load_missing_is_none(self):
        self.assertIsNone(rc.load("nope", root=self.root))

    def test_record_creates_and_loads(self):
        script = self._touch("s1", "script.json")
        rc.record_stage("s1", rc.STAGE_SCRIPT, topic="Rome", channel_id="c1",
                        artifacts={"script_json": str(script)}, root=self.root)
        cp = rc.load("s1", root=self.root)
        self.assertIsNotNone(cp)
        self.assertEqual(cp.slug, "s1")
        self.assertEqual(cp.topic, "Rome")
        self.assertEqual(cp.channel_id, "c1")
        self.assertTrue(cp.stage_completed(rc.STAGE_SCRIPT))

    def test_stages_accumulate_across_calls(self):
        self._touch("s2", "script.json")
        self._touch("s2", "audio.wav")
        rc.record_stage("s2", rc.STAGE_SCRIPT,
                        artifacts={"script_json": str(self.root / "s2" / "script.json")}, root=self.root)
        rc.record_stage("s2", rc.STAGE_VOICE,
                        artifacts={"audio": str(self.root / "s2" / "audio.wav")}, root=self.root)
        cp = rc.load("s2", root=self.root)
        self.assertEqual(set(cp.stages), {rc.STAGE_SCRIPT, rc.STAGE_VOICE})

    def test_topic_and_channel_fill_once_then_preserved(self):
        rc.record_stage("s3", rc.STAGE_SCRIPT, topic="First", channel_id="c1", root=self.root)
        # A later record with a different topic must not overwrite the first.
        rc.record_stage("s3", rc.STAGE_VOICE, topic="Second", channel_id="c2", root=self.root)
        cp = rc.load("s3", root=self.root)
        self.assertEqual(cp.topic, "First")
        self.assertEqual(cp.channel_id, "c1")

    def test_corrupt_checkpoint_loads_as_none(self):
        p = rc.checkpoint_path("bad", root=self.root)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{ not json")
        self.assertIsNone(rc.load("bad", root=self.root))

    def test_empty_checkpoint_loads_as_none(self):
        p = rc.checkpoint_path("empty", root=self.root)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("   ")
        self.assertIsNone(rc.load("empty", root=self.root))

    def test_artifact_paths_are_stringified(self):
        script = self._touch("s4", "script.json")
        rc.record_stage("s4", rc.STAGE_SCRIPT, artifacts={"script_json": script}, root=self.root)  # a Path, not str
        raw = json.loads(rc.checkpoint_path("s4", root=self.root).read_text())
        self.assertIsInstance(raw["stages"][rc.STAGE_SCRIPT]["artifacts"]["script_json"], str)

    def test_none_artifact_value_dropped(self):
        rc.record_stage("s5", rc.STAGE_SCRIPT, artifacts={"script_json": None}, root=self.root)
        cp = rc.load("s5", root=self.root)
        self.assertEqual(cp.stages[rc.STAGE_SCRIPT]["artifacts"], {})


class ResumabilityTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_resumable_only_when_files_present(self):
        script = self.root / "s1" / "script.json"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("{}")
        rc.record_stage("s1", rc.STAGE_SCRIPT, artifacts={"script_json": str(script)}, root=self.root)
        cp = rc.load("s1", root=self.root)
        self.assertTrue(cp.can_resume_stage(rc.STAGE_SCRIPT))
        # Delete the artifact — the checkpoint must no longer claim it is resumable.
        script.unlink()
        cp2 = rc.load("s1", root=self.root)
        self.assertTrue(cp2.stage_completed(rc.STAGE_SCRIPT))       # still recorded
        self.assertFalse(cp2.artifacts_present(rc.STAGE_SCRIPT))    # but files are gone
        self.assertFalse(cp2.can_resume_stage(rc.STAGE_SCRIPT))

    def test_stage_with_no_artifacts_is_vacuously_present(self):
        rc.record_stage("s2", rc.STAGE_MEDIA, root=self.root)  # a stage that left no reusable file
        cp = rc.load("s2", root=self.root)
        self.assertTrue(cp.can_resume_stage(rc.STAGE_MEDIA))

    def test_uncompleted_stage_not_resumable(self):
        rc.record_stage("s3", rc.STAGE_SCRIPT, root=self.root)
        cp = rc.load("s3", root=self.root)
        self.assertFalse(cp.can_resume_stage(rc.STAGE_RENDER))
        self.assertIsNone(cp.artifact(rc.STAGE_RENDER, "video"))

    def test_resumable_stages_lists_present_only(self):
        script = self.root / "s4" / "script.json"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("{}")
        rc.record_stage("s4", rc.STAGE_SCRIPT, artifacts={"script_json": str(script)}, root=self.root)
        rc.record_stage("s4", rc.STAGE_RENDER, artifacts={"video": str(self.root / "s4" / "gone.mp4")}, root=self.root)
        cp = rc.load("s4", root=self.root)
        self.assertIn(rc.STAGE_SCRIPT, cp.resumable_stages())
        self.assertNotIn(rc.STAGE_RENDER, cp.resumable_stages())


class LifecycleTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_clear_removes_checkpoint(self):
        rc.record_stage("s1", rc.STAGE_SCRIPT, root=self.root)
        self.assertIsNotNone(rc.load("s1", root=self.root))
        rc.clear("s1", root=self.root)
        self.assertIsNone(rc.load("s1", root=self.root))

    def test_clear_missing_is_noop(self):
        rc.clear("never", root=self.root)  # must not raise

    def test_mark_complete_sets_flag(self):
        rc.record_stage("s2", rc.STAGE_SCRIPT, root=self.root)
        rc.mark_complete("s2", root=self.root)
        self.assertTrue(rc.load("s2", root=self.root).completed)

    def test_latest_incomplete_picks_most_recent_unfinished(self):
        rc.record_stage("old", rc.STAGE_SCRIPT, root=self.root)
        rc.record_stage("new", rc.STAGE_SCRIPT, root=self.root)
        # Force a strictly-later updated_at on "new" so ordering is unambiguous.
        cp_new = rc.load("new", root=self.root)
        cp_new.updated_at = "2999-01-01T00:00:00+00:00"
        rc._write(cp_new, root=self.root)
        picked = rc.latest_incomplete(root=self.root)
        self.assertIsNotNone(picked)
        self.assertEqual(picked.slug, "new")

    def test_latest_incomplete_skips_completed(self):
        rc.record_stage("done", rc.STAGE_SCRIPT, root=self.root)
        rc.mark_complete("done", root=self.root)
        self.assertIsNone(rc.latest_incomplete(root=self.root))

    def test_latest_incomplete_empty_root_is_none(self):
        self.assertIsNone(rc.latest_incomplete(root=self.root / "does-not-exist"))


if __name__ == "__main__":
    unittest.main()
