"""Structural checks that main.py wires the run checkpoint in: run() takes a
`resume` flag, records stages through the checkpoint, reuses a saved script on
resume, and clears the checkpoint on a successful publish. Parsed, not imported,
so it runs without MoviePy."""

import ast
import unittest
from pathlib import Path

MAIN = Path(__file__).resolve().parent.parent / "main.py"


class ResumeWiringTestCase(unittest.TestCase):
    def setUp(self):
        self.tree = ast.parse(MAIN.read_text())
        self.calls = [n for n in ast.walk(self.tree) if isinstance(n, ast.Call)]

    def _run_func(self):
        for node in ast.walk(self.tree):
            if isinstance(node, ast.FunctionDef) and node.name == "run":
                return node
        return None

    def test_run_has_resume_param(self):
        run = self._run_func()
        self.assertIsNotNone(run)
        params = {a.arg for a in run.args.args} | {a.arg for a in run.args.kwonlyargs}
        self.assertIn("resume", params)

    def test_checkpoint_module_imported(self):
        imported = set()
        for node in ast.walk(self.tree):
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    imported.add(alias.name)
        self.assertIn("run_checkpoint", imported)

    def _attr_chain(self, call):
        # e.g. run_checkpoint.record_stage -> ("run_checkpoint", "record_stage")
        func = call.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            return (func.value.id, func.attr)
        return (None, None)

    def test_records_stages_and_clears(self):
        checkpoint_methods = {m for (mod, m) in map(self._attr_chain, self.calls)
                              if mod == "run_checkpoint"}
        # The stage recorder and the on-success cleanup must both be wired.
        self.assertIn("record_stage", checkpoint_methods)
        self.assertIn("clear", checkpoint_methods)

    def test_resume_reuses_saved_script(self):
        # The resume path must consult can_resume_stage / the saved-script
        # artifact, so it only skips generation when the file is really there.
        attrs = {a.attr for a in ast.walk(self.tree) if isinstance(a, ast.Attribute)}
        self.assertTrue(
            {"can_resume_stage", "latest_incomplete"} & attrs,
            "resume must query the checkpoint before reusing artifacts",
        )

    def test_run_resumed_event_is_emitted(self):
        attrs = {a.attr for a in ast.walk(self.tree) if isinstance(a, ast.Attribute)}
        self.assertIn("RUN_RESUMED", attrs)


if __name__ == "__main__":
    unittest.main()
