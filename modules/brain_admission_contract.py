"""Offline Brain admission contract; never a dispatch or authorization backend.

Inputs must already come from trusted server records. This module cannot prove
identity, human approval provenance, model qualification or current membership.
It compares immutable snapshots only and is deliberately unwired. Canonical
plan bytes belong to #795's future authoritative canonicalizer, not this file.
"""
from dataclasses import dataclass
from enum import Enum

from modules.series_provider_selection import Provider


class Purpose(str, Enum):
    GENERATION_PROPOSAL = "generation_proposal"
    AUDIENCE_REVIEW = "audience_review"


class Admission(str, Enum):
    REVIEW_ONLY = "review_only"
    RENEW_APPROVAL = "renewed_human_approval_required"
    ELIGIBLE_FOR_REVIEW = "eligible_for_further_review"


def _references(*values: str) -> None:
    if any(type(value) is not str or not value.strip() for value in values):
        raise ValueError("reference_required")


@dataclass(frozen=True)
class TrustedScope:
    """Derived by a future server caller, never copied from model output."""

    tenant_ref: str
    project_ref: str
    task_ref: str

    def __post_init__(self) -> None:
        _references(self.tenant_ref, self.project_ref, self.task_ref)


@dataclass(frozen=True)
class Proposal:
    scope: TrustedScope
    plan_revision: int
    provider: Provider
    model_revision: str
    quote_ref: str
    quote_version: str
    policy_version: str
    expires_at: int  # UTC epoch seconds, provided by trusted caller
    purpose: Purpose
    plan_bytes: bytes  # opaque frozen semantic bytes; no JSON reserialization

    def __post_init__(self) -> None:
        if type(self.scope) is not TrustedScope or type(self.purpose) is not Purpose:
            raise ValueError("binding_required")
        _references(self.model_revision, self.quote_ref, self.quote_version, self.policy_version)
        if type(self.provider) is not str or self.provider not in ("gemini", "openai", "claude"):
            raise ValueError("provider_required")
        if type(self.plan_revision) is not int or self.plan_revision < 1:
            raise ValueError("revision_required")
        if type(self.expires_at) is not int or self.expires_at < 1:
            raise ValueError("expiry_required")
        if type(self.plan_bytes) is not bytes or not self.plan_bytes:
            raise ValueError("immutable_plan_bytes_required")


@dataclass(frozen=True)
class ApprovalSnapshot:
    """Read-only view of a trusted human approval; never creates/persists one."""

    proposal: Proposal
    human_ref: str

    def __post_init__(self) -> None:
        if type(self.proposal) is not Proposal:
            raise ValueError("proposal_required")
        _references(self.human_ref)


def check_admission(
    trusted_scope: TrustedScope,
    request: Proposal,
    approval: ApprovalSnapshot | None,
    *,
    now: int,
) -> Admission:
    """Return a review classification, with no execution-capable result.

    Equality binds every field, including expiry, purpose and opaque plan bytes.
    Even a matching human snapshot must pass future live domain/policy checks.
    No callback/client/selector is accepted, so this check cannot invoke one.
    """
    if type(trusted_scope) is not TrustedScope or type(request) is not Proposal:
        raise ValueError("binding_required")
    if approval is not None and type(approval) is not ApprovalSnapshot:
        raise ValueError("approval_snapshot_required")
    if type(now) is not int or now < 0:
        raise ValueError("clock_required")
    if request.purpose is Purpose.AUDIENCE_REVIEW:
        return Admission.REVIEW_ONLY
    if (
        request.scope != trusted_scope
        or request.expires_at <= now
        or approval is None
        or approval.proposal != request
    ):
        return Admission.RENEW_APPROVAL
    return Admission.ELIGIBLE_FOR_REVIEW
