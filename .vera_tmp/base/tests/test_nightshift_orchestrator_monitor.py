import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / "tools" / "nightshift_orchestrator_monitor.py"
spec = importlib.util.spec_from_file_location("nightshift_monitor", PATH)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)

class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.pr = {"state": "open", "draft": False, "merged_at": None}

    def test_no_checks_cannot_pass(self):
        self.assertEqual(monitor.classify(self.pr, {}, {})[0], "NO_EVIDENCE")

    def test_draft_blocks_success(self):
        self.assertEqual(monitor.classify({**self.pr, "draft": True}, {"check_runs": [{"status": "completed", "conclusion": "success"}]}, {})[0], "REVIEW_PENDING")

    def test_failed_workflow_blocks(self):
        self.assertEqual(monitor.classify(self.pr, {}, {"workflow_runs": [{"status": "completed", "conclusion": "failure"}]})[0], "CI_FAILED")

    def test_pending_blocks(self):
        self.assertEqual(monitor.classify(self.pr, {"check_runs": [{"status": "in_progress", "conclusion": None}]}, {})[0], "CI_RUNNING")

    def test_success_not_sql_acceptance(self):
        self.assertEqual(monitor.classify(self.pr, {"check_runs": [{"status": "completed", "conclusion": "success"}]}, {})[0], "REVIEW_READY")

    def test_evaluate_never_automerge(self):
        sha = "a" * 40
        def fake(path, token):
            if "/pulls/" in path:
                return {**self.pr, "head": {"sha": sha}}
            return {"check_runs": []} if "/check-runs" in path else {"workflow_runs": []}
        result = monitor.evaluate("example/repo", 647, "dummy", fake)
        self.assertEqual(result["status"], "NO_EVIDENCE")
        self.assertFalse(result["auto_merge"])
        self.assertFalse(result["sql_security_accepted"])

if __name__ == "__main__":
    unittest.main()
