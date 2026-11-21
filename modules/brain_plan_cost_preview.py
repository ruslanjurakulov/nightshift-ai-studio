"""Pure quoted-cost preview over existing Proposal and ProposalUsageSummary.

Quotes are explicit injected assertions, not authenticated prices or permission.
Amounts use integer micro-USD (an existing provider accounting representation),
never conversions from usage. No rate, quote, expiry or amount default is chosen.
Opaque plan bytes are compared by existing contracts, never parsed or rewritten.
"""
from dataclasses import dataclass
from typing import Literal, Optional, Tuple

from modules.brain_admission_contract import (
    Admission, ApprovalSnapshot, Proposal, TrustedScope, check_admission,
)
from modules.brain_usage_contract import ModelIdentity
from modules.brain_usage_summary import ProposalUsageSummary, UsageStepSummary


@dataclass(frozen=True)
class SuppliedStepQuote:
    """One amount in the proposal's quote/version batch, bound to its snapshot."""
    proposal: Proposal
    usage_proposal_ref: str
    step_ref: str
    identity: ModelIdentity
    expires_at: int
    amount_micro_usd: Optional[int]

    def __post_init__(self):
        if type(self.proposal) is not Proposal or type(self.identity) is not ModelIdentity:
            raise ValueError("typed_binding_required")
        for value in (self.usage_proposal_ref, self.step_ref):
            if type(value) is not str or not value.strip():
                raise ValueError("reference_required")
        if type(self.expires_at) is not int or self.expires_at < 1:
            raise ValueError("explicit_expiry_required")
        if self.amount_micro_usd is not None and (type(self.amount_micro_usd) is not int or self.amount_micro_usd < 0):
            raise ValueError("invalid_quote_amount")


@dataclass(frozen=True)
class PlannedStepCost:
    step_ref: str
    identity: ModelIdentity
    status: Literal["missing_quote", "version_mismatch", "usage_binding_mismatch", "plan_expired",
                    "quote_expired", "amount_unknown", "supplied_current_quote"]
    quote_ref: Optional[str]
    quote_version: Optional[str]
    quote_plan_revision: Optional[int]
    quote_expires_at: Optional[int]
    supplied_micro_usd: Optional[int]
    current_micro_usd: Optional[int]


@dataclass(frozen=True)
class PlanCostPreview:
    plan_revision: int
    quote_ref: str
    quote_version: str
    policy_version: str
    review: Admission
    actual_usage: ProposalUsageSummary
    steps: Tuple[PlannedStepCost, ...]
    quote_coverage: Literal["unknown", "partial", "complete_for_declared_usage_steps"]
    known_quote_subtotal_micro_usd: Optional[int]
    declared_step_total_micro_usd: Optional[int]
    limitations: Tuple[str, ...] = ("usage_plan_version_binding_unavailable", "plan_step_membership_not_verified")
    actual_cost_status: Literal["unknown"] = "unknown"
    actual_cost_micro_usd: None = None
    spending: Literal["not_performed"] = "not_performed"
    provenance: Literal["not_verified_by_preview"] = "not_verified_by_preview"


def preview_plan_costs(plan: Proposal, usage: ProposalUsageSummary,
                       quotes: Tuple[SuppliedStepQuote, ...], *, trusted_scope: TrustedScope,
                       approval: Optional[ApprovalSnapshot], now: int) -> PlanCostPreview:
    """Present supplied quotes separately from actual usage and review status.

    Existing summary has no plan revision or authoritative plan-step binding;
    totals apply ONLY to its declared steps. Limits stay explicit even when every
    quote matches. Existing admission returns review classifications, never spend
    permission. No quote issuer, human approval or usage provenance is verified.
    """
    review = check_admission(trusted_scope, plan, approval, now=now)
    if type(usage) is not ProposalUsageSummary or type(quotes) is not tuple:
        raise ValueError("typed_inputs_required")
    if type(usage.steps) is not tuple or usage.declared_steps != len(usage.steps):
        raise ValueError("invalid_declared_steps")
    declared = {}
    for step in usage.steps:
        if type(step) is not UsageStepSummary or step.step_ref in declared:
            raise ValueError("invalid_declared_steps")
        declared[step.step_ref] = step
    supplied = {}
    for quote in quotes:
        if type(quote) is not SuppliedStepQuote:
            raise ValueError("typed_quote_required")
        if quote.step_ref not in declared:
            raise ValueError("undeclared_quote")
        if quote.step_ref in supplied:
            raise ValueError("duplicate_quote")
        supplied[quote.step_ref] = quote
    rows = []
    for step in usage.steps:
        quote = supplied.get(step.step_ref)
        if quote is None:
            rows.append(PlannedStepCost(step.step_ref, step.identity, "missing_quote", None, None, None, None, None, None))
            continue
        if quote.proposal != plan:
            status = "version_mismatch"
        elif quote.usage_proposal_ref != usage.proposal_ref or quote.identity != step.identity:
            status = "usage_binding_mismatch"
        elif plan.expires_at <= now:
            status = "plan_expired"
        elif quote.expires_at <= now:
            status = "quote_expired"
        elif quote.amount_micro_usd is None:
            status = "amount_unknown"
        else:
            status = "supplied_current_quote"
        rows.append(PlannedStepCost(step.step_ref, step.identity, status, quote.proposal.quote_ref,
                                   quote.proposal.quote_version, quote.proposal.plan_revision, quote.expires_at,
                                   quote.amount_micro_usd,
                                   quote.amount_micro_usd if status == "supplied_current_quote" else None))
    amounts = [row.current_micro_usd for row in rows if row.current_micro_usd is not None]
    complete = bool(rows) and len(amounts) == len(rows)
    subtotal = sum(amounts) if amounts else None
    coverage = "complete_for_declared_usage_steps" if complete else "partial" if amounts else "unknown"
    return PlanCostPreview(plan.plan_revision, plan.quote_ref, plan.quote_version, plan.policy_version, review,
                           usage, tuple(rows), coverage, subtotal, subtotal if complete else None)
