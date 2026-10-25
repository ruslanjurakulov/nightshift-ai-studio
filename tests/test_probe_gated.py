"""``--all`` never makes a paid call to a model whose vendor terms are not cleared.

The "Probe models" workflow runs ``--all`` when its model input is empty. Before
this rule that meant one real, paid call to every registry model, gated ones
(Luma, Kling, ElevenLabs, the ByteDance/xAI first-party entries) included. A
gated model is now probed only when it is NAMED (``--model``).
"""

from __future__ import annotations

import io
import unittest
from unittest import mock

from modules import model_registry as reg
from modules.capabilities import ADAPTERS
from tools import probe_models

#: Every adapter finds a key, so the only reason a model is not probed is its terms gate.
ENV = {name: "k" * 24 for cls in ADAPTERS.values() for name in cls.key_env}


class SelectTests(unittest.TestCase):
    def setUp(self):
        self.entries = list(reg.registry().values())
        self.gated = {e.id for e in self.entries if e.terms_gate}
        self.clear = {e.id for e in self.entries if not e.terms_gate}

    def test_the_registry_has_both_kinds(self):
        self.assertTrue(self.gated and self.clear)
        self.assertIn("seedance-2.0", self.gated)
        self.assertIn("luma-ray-3.2", self.gated)

    def test_all_skips_every_gated_model_and_keeps_every_clear_one(self):
        chosen = {e.id for e in probe_models.select(self.entries, [], None, True)}
        self.assertEqual(chosen, self.clear)

    def test_a_gated_model_is_probed_when_named_even_with_all(self):
        chosen = {e.id for e in probe_models.select(self.entries, ["seedance-2.0"], None, True)}
        self.assertEqual(chosen, self.clear | {"seedance-2.0"})
        self.assertEqual([e.id for e in probe_models.select(self.entries, ["seedance-2.0"], None, False)], ["seedance-2.0"])

    def test_the_capability_filter_does_not_let_a_gated_model_back_in(self):
        chosen = {e.id for e in probe_models.select(self.entries, [], "t2v", True)}
        self.assertFalse(chosen & self.gated)

    def test_the_skipped_gated_models_are_reported(self):
        left = {e.id for e in probe_models.gated_left_out(self.entries, ["luma-ray-3.2"], None, True)}
        self.assertEqual(left, self.gated - {"luma-ray-3.2"})
        self.assertEqual(probe_models.gated_left_out(self.entries, [], None, False), [])


class MainTests(unittest.TestCase):
    def run_main(self, argv):
        out, called = io.StringIO(), []
        db = mock.Mock()
        db.record.return_value = 1
        db.sync.return_value = 0

        def fake_probe(entry, **kw):
            called.append(entry.id)
            return probe_models.ProbeResult(entry.id, True, latency_ms=1, output_bytes=1)

        with mock.patch.object(probe_models, "run_probe", side_effect=fake_probe), \
                mock.patch("requests.Session.request", side_effect=AssertionError("network")):
            code = probe_models.main(argv, env=ENV, db=db, stream=out)
        return code, called, out.getvalue()

    def test_a_paid_all_run_never_calls_a_gated_model(self):
        code, called, text = self.run_main(["--all", "--brief"])
        self.assertEqual(code, 0)
        gated = {e.id for e in reg.registry().values() if e.terms_gate}
        self.assertTrue(called)
        self.assertFalse(set(called) & gated, set(called) & gated)
        for mid in ("seedance-2.0", "seedream-4.5", "luma-ray-3.2"):
            self.assertIn(f"gated {mid}", text)             # said in the log, nothing else about it
            self.assertNotIn(f"ok {mid}", text)

    def test_naming_a_gated_model_probes_it(self):
        _, called, _ = self.run_main(["--model", "seedance-2.0"])
        self.assertEqual(called, ["seedance-2.0"])

    def test_the_dry_run_lists_no_gated_model_under_all_and_says_why(self):
        out = io.StringIO()
        probe_models.main(["--dry-run", "--all"], env={}, db=mock.Mock(), stream=out)
        text = out.getvalue()
        self.assertNotRegex(text, r"(?m)^seedance-2\.0 ")
        self.assertIn("SKIP seedance-2.0: terms gate written_consent_required is open", text)


class WorkflowTests(unittest.TestCase):
    def test_the_workflow_runs_all_for_an_empty_model_and_reports_the_gated_ones_it_did_not_call(self):
        from pathlib import Path

        text = (Path(__file__).resolve().parent.parent / ".github" / "workflows" / "probe_models.yml").read_text()
        self.assertIn("args+=(--all)", text)                          # the empty input still means --all ...
        self.assertIn("gated (terms not cleared, not called)", text)   # ... which now leaves gated models out, loudly
        self.assertIn("^(ok|failed|skipped|gated) ", text)


if __name__ == "__main__":
    unittest.main()
