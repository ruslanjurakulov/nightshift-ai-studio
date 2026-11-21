"""Synthetic quote values only, not published rates or spending authority."""
from dataclasses import asdict, replace
import unittest
from unittest.mock import patch

from modules.brain_admission_contract import Admission, ApprovalSnapshot, Proposal, Purpose, TrustedScope
from modules.brain_usage_contract import ModelIdentity
from modules.brain_usage_summary import DeclaredUsageStep, summarize_proposal_usage
from modules.brain_plan_cost_preview import SuppliedStepQuote, preview_plan_costs


class PlanCostPreviewTests(unittest.TestCase):
    def setUp(self):
        self.scope = TrustedScope("fixture-tenant", "fixture-project", "fixture-task")
        self.plan = Proposal(self.scope, 2, "gemini", "fixture-model@1", "fixture-quote", "q2", "policy1",
                             100, Purpose.GENERATION_PROPOSAL, b"opaque fixture plan")
        self.identity = ModelIdentity("gemini", "requested@1", "resolved@1")
        self.usage = summarize_proposal_usage("fixture-proposal",
            (DeclaredUsageStep("plan", self.identity), DeclaredUsageStep("review", self.identity)), ())
        self.approval = ApprovalSnapshot(self.plan, "fixture-human")

    def quote(self, ref, amount, **changes):
        return SuppliedStepQuote(**dict(dict(proposal=self.plan, usage_proposal_ref=self.usage.proposal_ref,
            step_ref=ref, identity=self.identity, expires_at=90, amount_micro_usd=amount), **changes))

    def preview(self, quotes=(), **changes):
        kwargs = dict(plan=self.plan, usage=self.usage, quotes=quotes, trusted_scope=self.scope,
                      approval=self.approval, now=50)
        kwargs.update(changes)
        return preview_plan_costs(**kwargs)

    def test_current_quotes_sum_exactly_but_remain_separate_from_actual_cost_and_usage(self):
        large = 2**80 + 1
        p = self.preview((self.quote("plan", large), self.quote("review", 3)))
        self.assertEqual((p.quote_coverage, p.declared_step_total_micro_usd),
                         ("complete_for_declared_usage_steps", large + 3))
        self.assertIs(p.actual_usage, self.usage)
        self.assertEqual(p.actual_usage.coverage, "unknown")
        self.assertEqual((p.actual_cost_status, p.actual_cost_micro_usd, p.spending),
                         ("unknown", None, "not_performed"))
        self.assertEqual(p.review, Admission.ELIGIBLE_FOR_REVIEW)

    def test_missing_quote_keeps_known_subtotal_but_no_total(self):
        p = self.preview((self.quote("plan", 7),))
        self.assertEqual((p.quote_coverage, p.known_quote_subtotal_micro_usd, p.declared_step_total_micro_usd),
                         ("partial", 7, None))
        self.assertEqual(p.steps[1].status, "missing_quote")
        self.assertIsNone(p.steps[1].supplied_micro_usd)

    def test_explicit_zero_is_not_unknown_amount_or_missing_quote(self):
        p = self.preview((self.quote("plan", 0), self.quote("review", None)))
        self.assertEqual((p.known_quote_subtotal_micro_usd, p.quote_coverage), (0, "partial"))
        self.assertEqual([s.status for s in p.steps], ["supplied_current_quote", "amount_unknown"])
        self.assertIsNone(p.declared_step_total_micro_usd)
        self.assertIsNone(p.actual_cost_micro_usd)

    def test_no_quote_and_no_declared_steps_never_default_to_zero_or_complete(self):
        for usage in (self.usage, summarize_proposal_usage("empty", (), ())):
            p = self.preview(usage=usage)
            self.assertEqual(p.quote_coverage, "unknown")
            self.assertIsNone(p.known_quote_subtotal_micro_usd)
            self.assertIsNone(p.declared_step_total_micro_usd)

    def test_every_plan_snapshot_or_quote_version_change_stays_stale(self):
        for change in ({"plan_revision": 3}, {"quote_version": "q3"}, {"quote_ref": "other"},
                       {"policy_version": "other-policy"}, {"plan_bytes": b"changed plan"},
                       {"model_revision": "other-model"}, {"scope": replace(self.scope, project_ref="other")}):
            with self.subTest(change=change):
                q = self.quote("plan", 9, proposal=replace(self.plan, **change))
                p = self.preview((q,))
                self.assertEqual((p.steps[0].status, p.steps[0].supplied_micro_usd, p.steps[0].current_micro_usd),
                                 ("version_mismatch", 9, None))

    def test_quote_and_plan_expiry_at_boundary_are_preserved(self):
        q = self.quote("plan", 4, expires_at=50)
        p = self.preview((q,))
        self.assertEqual(p.steps[0].status, "quote_expired")
        self.assertIsNone(p.known_quote_subtotal_micro_usd)
        plan = replace(self.plan, expires_at=50)
        q = self.quote("plan", 4, proposal=plan)
        p = self.preview((q,), plan=plan)
        self.assertEqual(p.steps[0].status, "plan_expired")
        self.assertEqual(p.review, Admission.RENEW_APPROVAL)

    def test_quote_usage_reference_and_model_attribution_must_match(self):
        for change in ({"usage_proposal_ref": "other"}, {"identity": replace(self.identity, provider="other")}):
            p = self.preview((self.quote("plan", 5, **change),))
            self.assertEqual(p.steps[0].status, "usage_binding_mismatch")
            self.assertIsNone(p.steps[0].current_micro_usd)

    def test_review_classification_does_not_change_into_dispatch_permission(self):
        p = self.preview((self.quote("plan", 2),), approval=None)
        self.assertEqual((p.review, p.steps[0].status, p.spending),
                         (Admission.RENEW_APPROVAL, "supplied_current_quote", "not_performed"))
        plan = replace(self.plan, purpose=Purpose.AUDIENCE_REVIEW)
        p = self.preview((self.quote("plan", 2, proposal=plan),), plan=plan)
        self.assertEqual((p.review, p.spending), (Admission.REVIEW_ONLY, "not_performed"))

    def test_summary_has_no_plan_revision_binding_and_limitation_cannot_disappear(self):
        p = self.preview((self.quote("plan", 2), self.quote("review", 3)))
        self.assertEqual(p.limitations, ("usage_plan_version_binding_unavailable", "plan_step_membership_not_verified"))
        self.assertEqual((p.plan_revision, p.quote_version, p.policy_version), (2, "q2", "policy1"))
        self.assertEqual(p.provenance, "not_verified_by_preview")

    def test_invalid_money_and_expiry_are_rejected_without_coercion(self):
        for value in (-1, True, False, 1.2, "3", float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.quote("plan", value)
        for expiry in (None, True, 0, "90"):
            with self.assertRaises(ValueError):
                self.quote("plan", 1, expires_at=expiry)

    def test_undeclared_or_duplicate_quote_is_not_silently_selected(self):
        q = self.quote("plan", 1)
        for quotes in ((q, q), (self.quote("undeclared", 1),)):
            with self.assertRaises(ValueError):
                self.preview(quotes)

    def test_order_is_declared_order_and_inputs_unchanged_without_any_io_or_dispatch(self):
        quotes = (self.quote("review", 4), self.quote("plan", 3))
        before = (asdict(self.plan), asdict(self.usage), tuple(asdict(q) for q in quotes))
        with patch("builtins.open", side_effect=AssertionError("no IO")), \
             patch("os.getenv", side_effect=AssertionError("no config")), \
             patch("socket.socket", side_effect=AssertionError("no provider")), \
             patch("modules.cost_ledger.CostLedger.add", side_effect=AssertionError("no ledger")), \
             patch("modules.cost_ledger.CostLedger.flush", side_effect=AssertionError("no write")), \
             patch("modules.series_provider_selection.select_series_generator", side_effect=AssertionError("no selection")):
            p = self.preview(quotes)
        self.assertEqual([s.step_ref for s in p.steps], ["plan", "review"])
        self.assertEqual(p, self.preview(tuple(reversed(quotes))))
        self.assertEqual(before, (asdict(self.plan), asdict(self.usage), tuple(asdict(q) for q in quotes)))


if __name__ == "__main__":
    unittest.main()
