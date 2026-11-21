"""Ordinary offline contract behavior with synthetic immutable server records."""
from dataclasses import FrozenInstanceError, replace
import hashlib
import socket
import unittest
from unittest.mock import Mock, patch

from modules.brain_admission_contract import (
    Admission, ApprovalSnapshot, Proposal, Purpose, TrustedScope, check_admission,
)
from modules.series_provider_selection import select_series_generator


# NS-379's bounded ASCII/integer golden projection; not a full Brain manifest.
PLAN = (
    b'{"duration_ms":10000,"model":"synthetic-model-a@1",'
    b'"quoted_credit_hundredths":1200,"scene_count":2}'
)
SCOPE = TrustedScope("synthetic-tenant", "synthetic-project", "synthetic-task")


def proposal(**changes):
    return replace(Proposal(
        scope=SCOPE, plan_revision=1, provider="gemini",
        model_revision="synthetic-model-a@1", quote_ref="synthetic-quote-1",
        quote_version="synthetic-price-v1", policy_version="synthetic-policy-v1",
        expires_at=2000, purpose=Purpose.GENERATION_PROPOSAL, plan_bytes=PLAN,
    ), **changes)


class BrainAdmissionContractTests(unittest.TestCase):
    def setUp(self):
        self.network = patch.object(socket, "create_connection", side_effect=AssertionError("offline test"))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.request = proposal()
        self.approval = ApprovalSnapshot(self.request, "synthetic-human")

    def check(self, request=None, approval=None, **kwargs):
        return check_admission(
            SCOPE, self.request if request is None else request,
            self.approval if approval is None else approval, now=kwargs.get("now", 1000),
        )

    def test_matching_record_is_only_eligible_for_further_review(self):
        self.assertEqual(self.check(), Admission.ELIGIBLE_FOR_REVIEW)
        self.assertEqual({v.value for v in Admission}, {
            "review_only", "renewed_human_approval_required", "eligible_for_further_review",
        })

    def test_each_trusted_tenant_project_task_reference_is_bound(self):
        for field in ("tenant_ref", "project_ref", "task_ref"):
            with self.subTest(field=field):
                edited = replace(self.request, scope=replace(SCOPE, **{field: "synthetic-other"}))
                self.assertEqual(self.check(edited), Admission.RENEW_APPROVAL)
                # Even two matching snapshots cannot replace server-derived scope.
                self.assertEqual(self.check(edited, ApprovalSnapshot(edited, "synthetic-human")), Admission.RENEW_APPROVAL)

    def test_changed_provider_model_plan_quote_or_policy_needs_approval(self):
        edits = {
            "provider": "openai", "model_revision": "synthetic-model-b@1",
            "plan_revision": 2, "quote_ref": "synthetic-quote-2",
            "quote_version": "synthetic-price-v2", "policy_version": "synthetic-policy-v2",
            "expires_at": 2100,
        }
        for field, value in edits.items():
            with self.subTest(field=field):
                self.assertEqual(self.check(replace(self.request, **{field: value})), Admission.RENEW_APPROVAL)

    def test_ns379_model_count_duration_and_both_cost_directions_are_bound(self):
        self.assertEqual(hashlib.sha256(PLAN).hexdigest(), "424fb795fac8b0714d517b3a3c11fb416acdd7f64f7ea80296f57869f05ee783")
        edits = ((b'synthetic-model-a@1', b'synthetic-model-b@1'),
                 (b'"scene_count":2', b'"scene_count":3'),
                 (b'10000', b'11000'), (b'1200', b'1300'), (b'1200', b'1100'))
        for old, new in edits:
            with self.subTest(change=new):
                candidate = replace(self.request, plan_bytes=PLAN.replace(old, new))
                self.assertEqual(self.check(candidate), Admission.RENEW_APPROVAL)
        self.assertEqual(self.approval.proposal.plan_bytes, PLAN)

    def test_expiration_at_and_after_deadline_requires_renewal(self):
        self.assertEqual(self.check(now=1999), Admission.ELIGIBLE_FOR_REVIEW)
        for now in (2000, 2001):
            with self.subTest(now=now):
                self.assertEqual(self.check(now=now), Admission.RENEW_APPROVAL)

    def test_missing_approval_never_makes_an_eligible_proposal(self):
        self.assertEqual(check_admission(SCOPE, self.request, None, now=1000), Admission.RENEW_APPROVAL)

    def test_new_matching_human_snapshot_only_restores_review_eligibility(self):
        candidate = proposal(plan_revision=2, model_revision="synthetic-model-b@1",
                             quote_ref="synthetic-quote-2", policy_version="synthetic-policy-v2")
        renewed = ApprovalSnapshot(candidate, "synthetic-human")
        self.assertEqual(self.check(candidate, renewed), Admission.ELIGIBLE_FOR_REVIEW)

    def test_audience_result_stays_review_only_with_or_without_snapshot(self):
        audience = proposal(purpose=Purpose.AUDIENCE_REVIEW)
        for approval in (None, self.approval, ApprovalSnapshot(audience, "synthetic-human")):
            with self.subTest(approval=approval is not None):
                self.assertEqual(check_admission(SCOPE, audience, approval, now=1000), Admission.REVIEW_ONLY)

    def test_review_approval_cannot_be_reused_for_generation_proposal(self):
        audience = proposal(purpose=Purpose.AUDIENCE_REVIEW)
        self.assertEqual(self.check(approval=ApprovalSnapshot(audience, "synthetic-human")), Admission.RENEW_APPROVAL)

    def test_snapshots_are_immutable_and_bytes_are_not_reserialized(self):
        with self.assertRaises(FrozenInstanceError):
            self.request.plan_revision = 2
        with self.assertRaises(FrozenInstanceError):
            self.approval.human_ref = "synthetic-other"
        with self.assertRaises(FrozenInstanceError):
            SCOPE.tenant_ref = "synthetic-other"
        with self.assertRaises(ValueError):
            proposal(plan_bytes=bytearray(PLAN))
        # Different opaque bytes require review; this module never normalizes JSON.
        self.assertEqual(self.check(proposal(plan_bytes=PLAN + b' ')), Admission.RENEW_APPROVAL)

    def test_unavailable_reference_or_expiry_is_not_eligible(self):
        for changes in ({"quote_version": ""}, {"model_revision": ""},
                        {"policy_version": ""}, {"expires_at": 0}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                proposal(**changes)

    def test_selector_is_unchanged_and_no_callable_is_invoked(self):
        fake_provider = Mock()
        selected = select_series_generator(fake_provider)
        self.assertIs(selected, fake_provider)
        self.assertEqual(self.check(), Admission.ELIGIBLE_FOR_REVIEW)
        self.assertEqual(self.check(proposal(plan_revision=2)), Admission.RENEW_APPROVAL)
        self.assertEqual(self.check(proposal(purpose=Purpose.AUDIENCE_REVIEW)), Admission.REVIEW_ONLY)
        fake_provider.assert_not_called()


if __name__ == "__main__":
    unittest.main()
