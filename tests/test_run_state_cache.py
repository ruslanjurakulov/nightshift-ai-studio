"""Run state carried across GitHub Actions runs (tools/run_state_cache.py).

The load-bearing properties:
  * an unfinished run's checkpoint + ledgers + script survive a clean checkout,
    so the next job polls the paid task and reconciles the upload;
  * a run that already PUBLISHED leaves nothing behind, and even a stale ledger
    that does come back is ignored — the run epoch changed;
  * nothing but the four allowlisted JSON files is ever copied: no media, no
    Video IR, never a token or client-secret file;
  * the cache is bounded (age, count, file size) and never fails the job;
  * the workflow restores before main.py and saves after it, even on failure.
"""

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import yaml

from modules import provider_tasks as pt
from modules import run_checkpoint
from modules import upload_idempotency as ui
from tools import run_state_cache as rsc

REPO = Path(__file__).resolve().parent.parent
WORKFLOW = REPO / ".github" / "workflows" / "daily_video.yml"


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.output = base / "output"
        self.state = base / ".run_state"
        self.output.mkdir()

    # A job that died mid-generation AND mid-upload: script written, a paid
    # task submitted but never settled, an insert sent that never reported back.
    def crashed_run(self, slug="topic", channel="chan"):
        run_dir = self.output / slug
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "script.json").write_text('{"title": "t"}')
        run_checkpoint.record_stage(slug, run_checkpoint.STAGE_SCRIPT, topic=slug,
                                    channel_id=channel, root=self.output,
                                    artifacts={"script_json": str(run_dir / "script.json")})
        ledger = pt.TaskLedger.open(slug, root=self.output)
        ledger.record_submitted(provider="minimax", model="H", task_id="paid-1",
                                section_index=0, phash="abc")
        attempt = ui.begin(slug, channel, root=self.output)
        attempt.mark_started()
        (run_dir / "final_video.mp4").write_bytes(b"video")
        (run_dir / "project.json").write_text("{}")
        return attempt.marker

    def new_runner(self):
        """A fresh GitHub-hosted job: output/ is gone, .run_state was restored."""
        shutil.rmtree(self.output)
        self.output.mkdir()
        return rsc.import_state(self.state, self.output)

    def publish(self, slug="topic"):
        run_checkpoint.clear(slug, root=self.output)


class CrossRunResumeTestCase(Base):
    def test_an_unfinished_run_resumes_on_the_next_job(self):
        marker = self.crashed_run()
        self.assertEqual(rsc.export_state(self.output, self.state), ["topic"])
        self.assertEqual(self.new_runner(), ["topic"])

        ledger = pt.TaskLedger.open("topic", root=self.output)
        self.assertEqual(ledger.find("minimax", "s000", "abc").task_id, "paid-1")
        attempt = ui.begin("topic", "chan", root=self.output)
        self.assertTrue(attempt.needs_lookup)
        self.assertEqual(attempt.marker, marker)
        cp = run_checkpoint.load("topic", self.output)
        self.assertTrue(cp.can_resume_stage(run_checkpoint.STAGE_SCRIPT))

    def test_only_the_allowlisted_files_travel(self):
        self.crashed_run()
        (self.output / "topic" / "youtube_token.json").write_text('{"token": "x"}')
        (self.output / "topic" / "client_secret.json").write_text('{"secret": "x"}')
        rsc.export_state(self.output, self.state)
        carried = sorted(p.name for p in (self.state / "topic").iterdir())
        self.assertEqual(carried, sorted(rsc.STATE_FILES))
        for name in ("final_video.mp4", "project.json", "youtube_token.json", "client_secret.json"):
            self.assertNotIn(name, carried)
        top = sorted(p.name for p in self.state.iterdir())
        self.assertEqual(top, [rsc.MANIFEST, "topic"])

    def test_the_allowlist_can_never_name_a_credential(self):
        for name in rsc.STATE_FILES:
            self.assertIsNone(rsc.NEVER_COPY.match(name))
        for name in ("youtube_token.json", "youtube_token_finance.json", "client_secret.json"):
            self.assertIsNotNone(rsc.NEVER_COPY.match(name))


class StaleStateTestCase(Base):
    def test_a_published_run_leaves_nothing_in_the_cache(self):
        self.crashed_run()
        rsc.export_state(self.output, self.state)
        self.new_runner()
        self.publish()   # the next job finished it
        self.assertEqual(rsc.export_state(self.output, self.state), [])
        self.assertFalse((self.state / "topic").exists())
        self.assertEqual(self.new_runner(), [])

    def test_stale_ledgers_from_a_published_run_are_ignored_even_if_restored(self):
        old_marker = self.crashed_run()
        stale = {n: (self.output / "topic" / n).read_text()
                 for n in (pt.LEDGER_FILENAME, ui.ATTEMPT_FILENAME)}
        self.publish()
        shutil.rmtree(self.output)
        self.output.mkdir()
        # Worst case: an older cache brought the ledgers back without the
        # checkpoint, and a new run of the same topic starts.
        (self.output / "topic").mkdir()
        for name, body in stale.items():
            (self.output / "topic" / name).write_text(body)
        with patch.object(run_checkpoint, "_now_iso", return_value="2099-01-01T00:00:00+00:00"):
            run_checkpoint.record_stage("topic", run_checkpoint.STAGE_SCRIPT, root=self.output)
        self.assertIsNone(pt.TaskLedger.open("topic", root=self.output)
                          .find("minimax", "s000", "abc"))
        attempt = ui.begin("topic", "chan", root=self.output)
        self.assertFalse(attempt.needs_lookup)
        self.assertNotEqual(attempt.marker, old_marker)

    def test_a_ledger_is_never_adopted_without_a_checkpoint(self):
        self.crashed_run()
        self.publish()
        self.assertEqual(pt.TaskLedger.open("topic", root=self.output).tasks, [])

    def test_a_run_older_than_the_age_limit_is_dropped(self):
        self.crashed_run()
        later = datetime.now(timezone.utc) + timedelta(days=rsc.MAX_AGE_DAYS + 1)
        self.assertEqual(rsc.export_state(self.output, self.state, now=later), [])
        rsc.export_state(self.output, self.state)
        shutil.rmtree(self.output)
        self.output.mkdir()
        self.assertEqual(rsc.import_state(self.state, self.output, now=later), [])

    def test_a_completed_checkpoint_is_not_carried(self):
        self.crashed_run()
        run_checkpoint.mark_complete("topic", root=self.output)
        self.assertEqual(rsc.export_state(self.output, self.state), [])


class BoundsAndSafetyTestCase(Base):
    def test_at_most_max_runs_newest_first(self):
        for i in range(rsc.MAX_RUNS + 3):
            self.crashed_run(slug=f"topic-{i:02d}")
        exported = rsc.export_state(self.output, self.state)
        self.assertEqual(len(exported), rsc.MAX_RUNS)
        self.assertIn(f"topic-{rsc.MAX_RUNS + 2:02d}", exported)   # the newest
        self.assertNotIn("topic-00", exported)

    def test_an_oversized_file_is_skipped(self):
        self.crashed_run()
        (self.output / "topic" / "script.json").write_bytes(b"x" * (rsc.MAX_FILE_BYTES + 1))
        rsc.export_state(self.output, self.state)
        self.assertFalse((self.state / "topic" / "script.json").exists())
        self.assertTrue((self.state / "topic" / run_checkpoint.CHECKPOINT_FILENAME).exists())

    def test_odd_directory_names_are_never_read_or_written(self):
        self.crashed_run()
        rsc.export_state(self.output, self.state)
        (self.state / "topic").rename(self.state / "..hidden")
        shutil.rmtree(self.output)
        self.output.mkdir()
        self.assertEqual(rsc.import_state(self.state, self.output), [])
        self.assertEqual(list(self.output.iterdir()), [])

    def test_import_never_touches_a_run_already_on_disk(self):
        self.crashed_run()
        rsc.export_state(self.output, self.state)
        self.publish()   # on this machine the run already published
        self.assertEqual(rsc.import_state(self.state, self.output), [])
        self.assertIsNone(run_checkpoint.load("topic", self.output))

    def test_a_job_that_died_before_import_keeps_the_restored_state(self):
        self.crashed_run()
        rsc.export_state(self.output, self.state)
        shutil.rmtree(self.output)   # this job never imported; output/ is empty
        self.output.mkdir()
        self.assertEqual(rsc.export_state(self.output, self.state), ["topic"])

    def test_a_manifest_is_always_written(self):
        self.assertEqual(rsc.export_state(self.output, self.state), [])
        manifest = json.loads((self.state / rsc.MANIFEST).read_text())
        self.assertEqual(manifest["runs"], [])

    def test_missing_directories_and_the_cli_never_fail(self):
        missing = self.output / "nope"
        self.assertEqual(rsc.import_state(missing, self.output), [])
        self.assertEqual(rsc.main(["import", "--state", str(missing), "--output", str(self.output)]), 0)
        self.assertEqual(rsc.main(["export", "--state", str(self.state), "--output", str(missing)]), 0)


class WorkflowTestCase(unittest.TestCase):
    def setUp(self):
        self.wf = yaml.safe_load(WORKFLOW.read_text())
        self.steps = self.wf["jobs"]["make-video"]["steps"]
        self.names = [s.get("name", "") for s in self.steps]

    def step(self, name):
        return self.steps[self.names.index(name)]

    def test_restored_before_main_and_saved_after_even_on_failure(self):
        restore = self.names.index("Restore run state (resume ledgers, this channel)")
        load = self.names.index("Load run state into output/")
        run = self.names.index("Run Chronos bot")
        collect = self.names.index("Collect run state (unfinished runs only)")
        save = self.names.index("Save run state (this channel)")
        self.assertLess(restore, load)
        self.assertLess(load, run)
        self.assertLess(run, collect)
        self.assertLess(collect, save)
        for name in ("Collect run state (unfinished runs only)", "Save run state (this channel)"):
            self.assertTrue(self.step(name)["if"].startswith("always()"))

    def test_cache_is_per_channel_and_holds_only_the_state_dir(self):
        restore = self.step("Restore run state (resume ledgers, this channel)")["with"]
        save = self.step("Save run state (this channel)")["with"]
        self.assertEqual(restore["path"], ".run_state")
        self.assertEqual(save["path"], ".run_state")
        self.assertEqual(restore["key"], save["key"])
        self.assertIn("${{ matrix.channel_id }}.", restore["restore-keys"])
        self.assertTrue(restore["key"].startswith(restore["restore-keys"]))
        for w in (restore, save):
            self.assertNotIn("token", w["path"])
            self.assertNotIn("secret", w["path"])

    def test_resume_is_opt_in(self):
        resume = self.wf[True]["workflow_dispatch"]["inputs"]["resume"]
        self.assertIs(resume["default"], False)
        run = self.step("Run Chronos bot")["run"]
        self.assertIn('"${INPUT_RESUME:-}" = "true"', run)


if __name__ == "__main__":
    unittest.main()
