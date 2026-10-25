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

GROK = ("grok-imagine-video-1.5", "grok-imagine-video-1.5-lite", "grok-imagine-image-2.0")

#: Every adapter finds a key, so the only reason a model is not probed is its terms gate.
ENV = {name: "k" * 24 for cls in ADAPTERS.values() for name in cls.key_env}


class SelectTests(unittest.TestCase):
    def setUp(self):
        self.entries = list(reg.registry().values())
        self.gated = {e.id for e in self.entries if e.terms_gate}
        #: past an announced shutdown date (registry ``shutdown``): --all leaves them out too, a probe by name does not
        self.shut = {e.id for e in self.entries if e.shut_down()}
        self.clear = {e.id for e in self.entries if not e.terms_gate and not e.shut_down()}

    def test_the_registry_has_both_kinds(self):
        self.assertTrue(self.gated and self.clear)
        self.assertIn("seedance-2.0", self.gated)
        for mid in GROK:
            self.assertEqual(reg.get(mid).terms_gate, "terms_review_required", mid)   # xAI terms were not readable
            self.assertIn(mid, self.gated)
        self.assertIn("luma-ray-3.2", self.gated)

    def test_all_never_spends_on_a_model_past_its_announced_shutdown_date_and_a_named_one_comes_back(self):
        self.assertTrue({"veo-3.1", "veo-3.1-fast", "veo-3.1-lite"} <= self.shut)
        chosen = {e.id for e in probe_models.select(self.entries, [], None, True)}
        self.assertFalse(chosen & self.shut, chosen & self.shut)
        for cap in ("t2v", "i2v"):
            self.assertFalse({e.id for e in probe_models.select(self.entries, [], cap, True)} & self.shut, cap)
        for mid in ("veo-3.1", "veo-3.1-fast", "veo-3.1-lite"):
            named = {e.id for e in probe_models.select(self.entries, [mid], None, True)}
            self.assertEqual(named, self.clear | {mid}, mid)
            self.assertEqual([e.id for e in probe_models.select(self.entries, [mid], None, False)], [mid])
        left = {e.id for e in probe_models.shutdown_left_out(self.entries, ["veo-3.1"], None, True)}
        self.assertEqual(left, {i for i in self.shut if not reg.get(i).terms_gate} - {"veo-3.1"})
        self.assertEqual(probe_models.shutdown_left_out(self.entries, [], None, False), [])

    def test_all_skips_every_gated_model_and_keeps_every_clear_one(self):
        chosen = {e.id for e in probe_models.select(self.entries, [], None, True)}
        self.assertEqual(chosen, self.clear)

    def test_all_leaves_out_every_grok_entry_and_a_named_one_comes_back(self):
        chosen = {e.id for e in probe_models.select(self.entries, [], None, True)}
        self.assertFalse(chosen & set(GROK), chosen & set(GROK))
        for mid in GROK:
            named = {e.id for e in probe_models.select(self.entries, [mid], None, True)}
            self.assertEqual(named, self.clear | {mid}, mid)
        # by capability too: the xai video and image entries stay out of --all --capability runs
        for cap in ("t2v", "i2v", "t2i"):
            self.assertFalse({e.id for e in probe_models.select(self.entries, [], cap, True)} & set(GROK), cap)

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
        for mid in ("seedance-2.0", "seedream-4.5", "luma-ray-3.2", *GROK):
            self.assertIn(f"gated {mid}", text)             # said in the log, nothing else about it
            self.assertNotIn(f"ok {mid}", text)

    def test_naming_a_grok_model_probes_it_and_only_it(self):
        for mid in GROK:
            _, called, _ = self.run_main(["--model", mid])
            self.assertEqual(called, [mid], mid)

    def test_an_all_run_never_calls_a_past_shutdown_model_says_so_and_a_named_probe_marks_only_that_adapter(self):
        _, called, text = self.run_main(["--all", "--brief"])
        self.assertFalse(set(called) & {"veo-3.1", "veo-3.1-fast", "veo-3.1-lite"})
        for mid in ("veo-3.1", "veo-3.1-fast", "veo-3.1-lite"):
            self.assertIn(f"shutdown {mid}", text)
            self.assertNotIn(f"ok {mid}", text)
        _, called, _ = self.run_main(["--model", "veo-3.1-lite"])
        self.assertEqual(called, ["veo-3.1-lite"])
        out = io.StringIO()
        probe_models.main(["--dry-run", "--all"], env={}, db=mock.Mock(), stream=out)
        self.assertIn("SKIP veo-3.1: past its announced shutdown date 2026-10-22; name it with --model to probe it", out.getvalue())
        self.assertNotRegex(out.getvalue(), r"(?m)^veo-3\.1 ")

    def test_naming_a_gated_model_probes_it(self):
        _, called, _ = self.run_main(["--model", "seedance-2.0"])
        self.assertEqual(called, ["seedance-2.0"])

    def test_the_dry_run_lists_no_gated_model_under_all_and_says_why(self):
        out = io.StringIO()
        probe_models.main(["--dry-run", "--all"], env={}, db=mock.Mock(), stream=out)
        text = out.getvalue()
        self.assertNotRegex(text, r"(?m)^seedance-2\.0 ")
        self.assertIn("SKIP seedance-2.0: terms gate written_consent_required is open", text)
        self.assertIn("SKIP grok-imagine-video-1.5: terms gate terms_review_required is open", text)
        for mid in GROK:
            self.assertNotRegex(text, rf"(?m)^{mid.replace('.', chr(92) + '.')} ")


class WorkflowTests(unittest.TestCase):
    def test_the_workflow_runs_all_for_an_empty_model_and_reports_the_gated_ones_it_did_not_call(self):
        from pathlib import Path

        text = (Path(__file__).resolve().parent.parent / ".github" / "workflows" / "probe_models.yml").read_text()
        self.assertIn("args+=(--all)", text)                          # the empty input still means --all ...
        self.assertIn("gated (terms not cleared, not called)", text)   # ... which now leaves gated models out, loudly
        self.assertIn("^(ok|failed|skipped|gated|shutdown) ", text)


if __name__ == "__main__":
    unittest.main()
