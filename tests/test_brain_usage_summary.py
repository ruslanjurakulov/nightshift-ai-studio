"""Synthetic multi-step acceptance of existing projections; no real accounting."""
from dataclasses import asdict, replace
import json
import unittest
from unittest.mock import patch

from modules.brain_usage_contract import DISJOINT_V1, ModelIdentity, TokenCounts, normalize_usage
from modules.brain_usage_projection import CounterBinding, EvidenceReference, ProjectionContract, project_usage
from modules.brain_usage_summary import DeclaredUsageStep, StepUsageReceipt, summarize_proposal_usage


class ProposalUsageSummaryTests(unittest.TestCase):
    def setUp(self):
        self.model = ModelIdentity("fixture", "requested@1", "resolved@2")

    def step(self, ref, model=None):
        return DeclaredUsageStep(ref, model or self.model)

    def receipt(self, ref, counts=None, model=None, outcome="success"):
        model = model or self.model
        contract = ProjectionContract(model.provider, model.resolved_model_revision or "unresolved",
                                      "mapper@1", "mapping@1", DISJOINT_V1,
                                      (CounterBinding("uncached_input", "fixture_input", True),
                                       CounterBinding("visible_output", "fixture_output", True)))
        evidence = EvidenceReference(model.provider, model.resolved_model_revision or "unresolved", "evidence:" + ref, "mapper@1")
        projection = project_usage(normalize_usage(model, outcome=outcome, counts=counts, semantics=DISJOINT_V1),
                                   contract, evidence=evidence)
        return StepUsageReceipt(ref, projection)

    def counter(self, summary, name, group=0):
        return next(c for c in summary.models[group].counters if c.counter == name)

    def test_known_zero_and_missing_receipt_keep_declared_denominator(self):
        s = summarize_proposal_usage("proposal", (self.step("plan"), self.step("review")),
                                     (self.receipt("plan", TokenCounts(uncached_input=0, visible_output=2)),))
        c = self.counter(s, "uncached_input")
        self.assertEqual((c.known_subtotal, c.observed_steps, c.declared_steps, c.complete), (0, 1, 2, False))
        self.assertEqual((s.coverage, s.received_steps, s.declared_steps), ("partial", 1, 2))
        self.assertEqual(s.gaps, ("review:receipt_unavailable",))
        self.assertEqual(s.models[0].step_refs, ("plan", "review"))
        self.assertIsNone(s.steps[1].projection)

    def test_complete_declared_usage_never_becomes_complete_cost(self):
        s = summarize_proposal_usage("p", (self.step("a"), self.step("b")),
            (self.receipt("a", TokenCounts(uncached_input=2, visible_output=3)),
             self.receipt("b", TokenCounts(uncached_input=5, visible_output=0))))
        self.assertEqual(s.coverage, "complete_for_declared_steps_and_contracts")
        self.assertEqual((self.counter(s, "uncached_input").known_subtotal,
                          self.counter(s, "uncached_input").complete), (7, True))
        self.assertEqual((s.pricing, s.estimated_usd, s.accounting, s.provenance),
                         ("unknown", None, "not_performed", "not_verified_by_summary"))
        self.assertIsNone(self.counter(s, "reported_total").known_subtotal)

    def test_all_unknown_and_empty_proposal_do_not_fabricate_zero(self):
        for steps, receipts in (((self.step("a"),), ()),
                                ((self.step("a"),), (self.receipt("a"),)), ((), ())):
            s = summarize_proposal_usage("p", steps, receipts)
            self.assertEqual(s.coverage, "unknown")
            self.assertIsNone(s.estimated_usd)
            for group in s.models:
                self.assertTrue(all(c.known_subtotal is None and not c.complete for c in group.counters))
        self.assertEqual(s.gaps, ("steps_not_declared",))

    def test_models_and_both_revisions_are_never_blended(self):
        models = (self.model, replace(self.model, provider="other"),
                  replace(self.model, resolved_model_revision="resolved@3"),
                  replace(self.model, requested_model_revision="requested@alias"))
        steps = tuple(self.step(str(i), m) for i, m in enumerate(models))
        receipts = tuple(self.receipt(str(i), TokenCounts(uncached_input=i, visible_output=0), m)
                         for i, m in enumerate(models))
        s = summarize_proposal_usage("p", steps, receipts)
        self.assertEqual(tuple(g.identity for g in s.models), models)
        self.assertEqual([self.counter(s, "uncached_input", i).known_subtotal for i in range(4)], [0, 1, 2, 3])

    def test_mismatched_attribution_and_undeclared_or_duplicate_receipts_are_rejected(self):
        receipt = self.receipt("a", TokenCounts(uncached_input=1))
        for steps, receipts in (((self.step("a", replace(self.model, provider="other")),), (receipt,)),
                                ((self.step("b"),), (receipt,)),
                                ((self.step("a"),), (receipt, receipt))):
            with self.assertRaises(ValueError):
                summarize_proposal_usage("p", steps, receipts)
        with self.assertRaisesRegex(ValueError, "duplicate_step"):
            summarize_proposal_usage("p", (self.step("a"), self.step("a")), ())

    def test_declared_order_is_stable_independent_of_receipt_order(self):
        steps = (self.step("a"), self.step("b"))
        receipts = (self.receipt("b", TokenCounts(uncached_input=2)), self.receipt("a", TokenCounts(uncached_input=1)))
        self.assertEqual(summarize_proposal_usage("p", steps, receipts),
                         summarize_proposal_usage("p", steps, tuple(reversed(receipts))))

    def test_partial_mapping_does_not_erase_measured_counter_or_claim_full_coverage(self):
        receipt = self.receipt("a", TokenCounts(uncached_input=3, visible_output=4, cache_read=0))
        s = summarize_proposal_usage("p", (self.step("a"),), (receipt,))
        self.assertEqual(s.coverage, "partial")
        self.assertEqual((self.counter(s, "cache_read").known_subtotal,
                          self.counter(s, "cache_read").complete), (0, True))
        self.assertEqual(s.gaps, ("a:unmapped:cache_read",))
        self.assertIs(s.steps[0].projection, receipt.projection)

    def test_ambiguous_failure_remains_unknown_beside_measured_step(self):
        s = summarize_proposal_usage("p", (self.step("a"), self.step("b")),
            (self.receipt("a", TokenCounts(uncached_input=4, visible_output=1)),
             self.receipt("b", TokenCounts(reported_total=0), outcome="ambiguous_failure")))
        self.assertEqual((s.coverage, self.counter(s, "uncached_input").observed_steps), ("partial", 1))
        self.assertIn("b:ambiguous_failure", s.gaps)
        self.assertIsNone(self.counter(s, "reported_total").known_subtotal)

    def test_integer_subtotals_are_exact_and_totals_never_added_to_components(self):
        large = 2**80 + 1
        s = summarize_proposal_usage("p", (self.step("a"), self.step("b")),
            (self.receipt("a", TokenCounts(uncached_input=large, visible_output=2, reported_total=99)),
             self.receipt("b", TokenCounts(uncached_input=3, visible_output=1, reported_total=7))))
        self.assertEqual(self.counter(s, "uncached_input").known_subtotal, large + 3)
        self.assertEqual(self.counter(s, "reported_total").known_subtotal, 106)
        self.assertEqual(self.counter(s, "visible_output").known_subtotal, 3)

    def test_json_presentation_keeps_null_cost_and_unknown_counter_with_evidence(self):
        receipt = self.receipt("a", TokenCounts(uncached_input=0))
        s = summarize_proposal_usage("p", (self.step("a"),), (receipt,))
        wire = json.loads(json.dumps(asdict(s), allow_nan=False))
        self.assertIsNone(wire["estimated_usd"])
        output = next(c for c in wire["models"][0]["counters"] if c["counter"] == "visible_output")
        self.assertIsNone(output["known_subtotal"])
        self.assertEqual(wire["steps"][0]["projection"]["evidence"]["evidence_ref"], "evidence:a")
        self.assertEqual(wire["provenance"], "not_verified_by_summary")

    def test_no_io_pricing_ledger_or_provider_and_inputs_unchanged(self):
        steps = (self.step("a"),)
        receipts = (self.receipt("a", TokenCounts(uncached_input=1)),)
        before = (asdict(steps[0]), asdict(receipts[0]))
        with patch("builtins.open", side_effect=AssertionError("no IO")), \
             patch("os.getenv", side_effect=AssertionError("no config")), \
             patch("socket.socket", side_effect=AssertionError("no provider")), \
             patch("modules.cost_ledger.CostLedger.add", side_effect=AssertionError("no ledger")), \
             patch("modules.cost_ledger.CostLedger.flush", side_effect=AssertionError("no writes")):
            s = summarize_proposal_usage("p", steps, receipts)
        self.assertEqual(s.declared_steps, 1)
        self.assertEqual(before, (asdict(steps[0]), asdict(receipts[0])))

    def test_unresolved_model_with_missing_usage_keeps_unknown_revision(self):
        model = replace(self.model, resolved_model_revision=None)
        s = summarize_proposal_usage("p", (self.step("a", model),), ())
        self.assertIsNone(s.models[0].identity.resolved_model_revision)
        self.assertEqual(s.coverage, "unknown")


if __name__ == "__main__":
    unittest.main()
