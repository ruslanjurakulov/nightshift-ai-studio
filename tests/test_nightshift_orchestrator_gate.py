import importlib.util
import pathlib
import unittest
file = pathlib.Path(__file__).resolve().parents[1]/"tools"/"nightshift_orchestrator_gate.py"
spec = importlib.util.spec_from_file_location("gate",file)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class GateTests(unittest.TestCase):
    def setUp(self): self.report={"status":"REVIEW_READY","control_mode":"READ_ONLY"}
    def test_never_deploys_on_ci_success(self):
        self.assertFalse(gate.decision(self.report,"deploy","production",True)["allowed"])
    def test_never_dispatches_paid_task_implicitly(self):
        self.assertFalse(gate.decision(self.report,"codex_task","staging",True)["allowed"])
    def test_fails_on_pending(self):
        self.assertEqual(gate.decision({**self.report,"status":"CI_RUNNING"},"codex_task","staging")["reason"],"not_review_ready")
    def test_rejects_untrusted_report(self):
        self.assertEqual(gate.decision({**self.report,"control_mode":"AUTO"},"deploy","production",True)["reason"],"untrusted_report")
    def test_rejects_invalid_target(self):
        self.assertEqual(gate.decision(self.report,"deploy","wrong",True)["reason"],"invalid_target")

if __name__=="__main__":unittest.main()
