import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tools.approve_run as approve_run
from modules.pipeline_stages import PipelineStage, PipelineStateMachine


class ApproveRunCLITestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.store_path = Path(self._tmpdir.name) / "runs.json"
        self.output_dir = Path(self._tmpdir.name) / "output"

        self._orig_output_dir = approve_run.OUTPUT_DIR
        self._orig_psm = approve_run.PipelineStateMachine
        approve_run.OUTPUT_DIR = self.output_dir
        approve_run.PipelineStateMachine = lambda: self._orig_psm(store_path=self.store_path)

        self.pipeline = self._orig_psm(store_path=self.store_path)

    def tearDown(self):
        approve_run.OUTPUT_DIR = self._orig_output_dir
        approve_run.PipelineStateMachine = self._orig_psm
        self._tmpdir.cleanup()

    def _advance_to_human_approval(self, topic="Test topic"):
        run = self.pipeline.start_run(topic)
        for stage in (PipelineStage.RESEARCH, PipelineStage.SCRIPT, PipelineStage.FACT_CHECK, PipelineStage.HUMAN_APPROVAL):
            self.pipeline.advance(run.run_id, stage)
        return run

    def _run_cli(self, argv):
        sys.argv = ["approve_run.py"] + argv
        buf = StringIO()
        with redirect_stdout(buf):
            try:
                approve_run.main()
            except SystemExit:
                pass
        return buf.getvalue()

    def test_list_shows_pending_run(self):
        run = self._advance_to_human_approval()
        output = self._run_cli(["--list"])
        self.assertIn(run.run_id, output)
        self.assertIn("pending", output)

    def test_list_pending_excludes_approved_runs(self):
        run = self._advance_to_human_approval()
        self.pipeline.approve(run.run_id, approved_by="tester")
        output = self._run_cli(["--list-pending"])
        self.assertIn("No runs pending approval", output)

    def test_list_pending_includes_unapproved_runs(self):
        run = self._advance_to_human_approval()
        output = self._run_cli(["--list-pending"])
        self.assertIn(run.run_id, output)

    def test_approve_sets_human_approved_and_prints_disclaimer(self):
        run = self._advance_to_human_approval()
        output = self._run_cli(["--approve", run.run_id, "--approved-by", "ruslan"])
        self.assertIn("human_approved=True", output)
        self.assertIn("does NOT publish", output)

        reloaded = self.pipeline.get_run(run.run_id)
        self.assertTrue(reloaded.human_approved)
        self.assertEqual(reloaded.approved_by, "ruslan")

    def test_approve_without_approved_by_errors(self):
        run = self._advance_to_human_approval()
        with self.assertRaises(SystemExit):
            sys.argv = ["approve_run.py", "--approve", run.run_id]
            approve_run.main()

    def test_approve_unknown_run_id_errors_cleanly(self):
        buf = StringIO()
        with redirect_stdout(StringIO()), self.assertRaises(SystemExit):
            sys.argv = ["approve_run.py", "--approve", "does-not-exist", "--approved-by", "x"]
            approve_run.main()

    def test_show_includes_flagged_fact_check_results(self):
        run = self._advance_to_human_approval(topic="Genghis Khan's Lost Tomb")
        slug = approve_run.slugify(run.topic)
        fc_dir = self.output_dir / slug
        fc_dir.mkdir(parents=True)
        (fc_dir / "fact_check.json").write_text(json.dumps([
            {"claim": "X happened in 1200", "verdict": "likely_inaccurate", "reasoning": "disputed", "requires_human_review": True},
            {"claim": "Y is well documented", "verdict": "likely_accurate", "reasoning": "consistent", "requires_human_review": False},
        ]))

        output = self._run_cli(["--show", run.run_id])
        self.assertIn("1/2 claim(s) flagged", output)
        self.assertIn("X happened in 1200", output)
        self.assertNotIn("Y is well documented", output)  # only flagged claims are printed in detail

    def test_show_with_no_fact_check_file_does_not_crash(self):
        run = self._advance_to_human_approval()
        output = self._run_cli(["--show", run.run_id])
        self.assertIn("no results found", output)

    def test_show_unknown_run_id_errors_cleanly(self):
        with redirect_stdout(StringIO()), self.assertRaises(SystemExit):
            sys.argv = ["approve_run.py", "--show", "does-not-exist"]
            approve_run.main()

    def test_list_with_no_runs_at_all(self):
        output = self._run_cli(["--list"])
        self.assertIn("No runs recorded yet", output)


if __name__ == "__main__":
    unittest.main()
