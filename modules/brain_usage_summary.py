"""Offline proposal usage presentation; no prices, I/O or accounting authority.

Consumes existing projections without remapping them. Declared steps define the
coverage denominator, including missing receipts. Counter subtotals contain only
observed tokens for one exact model identity, never an estimate of missing usage.
"""
from dataclasses import dataclass, fields
from typing import Literal, Optional, Tuple

from modules.brain_usage_contract import ModelIdentity, TokenCounts
from modules.brain_usage_projection import UsageProjection


@dataclass(frozen=True)
class DeclaredUsageStep:
    step_ref: str
    identity: ModelIdentity


@dataclass(frozen=True)
class StepUsageReceipt:
    step_ref: str
    projection: UsageProjection


@dataclass(frozen=True)
class UsageStepSummary:
    step_ref: str
    identity: ModelIdentity
    projection: Optional[UsageProjection]
    coverage: Literal["unknown", "partial", "complete_for_declared_contract"]
    gaps: Tuple[str, ...]


@dataclass(frozen=True)
class CounterUsageSummary:
    counter: str
    known_subtotal: Optional[int]
    observed_steps: int
    declared_steps: int
    complete: bool


@dataclass(frozen=True)
class ModelUsageSummary:
    identity: ModelIdentity
    step_refs: Tuple[str, ...]
    counters: Tuple[CounterUsageSummary, ...]


@dataclass(frozen=True)
class ProposalUsageSummary:
    proposal_ref: str
    declared_steps: int
    received_steps: int
    steps: Tuple[UsageStepSummary, ...]
    models: Tuple[ModelUsageSummary, ...]
    coverage: Literal["unknown", "partial", "complete_for_declared_steps_and_contracts"]
    gaps: Tuple[str, ...]
    pricing: Literal["unknown"] = "unknown"
    estimated_usd: None = None
    accounting: Literal["not_performed"] = "not_performed"
    provenance: Literal["not_verified_by_summary"] = "not_verified_by_summary"


def _reference(value):
    if type(value) is not str or not value.strip():
        raise ValueError("reference_required")


def summarize_proposal_usage(proposal_ref: str, steps: Tuple[DeclaredUsageStep, ...],
                             receipts: Tuple[StepUsageReceipt, ...]) -> ProposalUsageSummary:
    """Aggregate observations by model, retaining every declared step and gap.

    Receipt/reference equality is not issuer verification or durable deduplication.
    Duplicate or undeclared receipts are rejected rather than silently selected.
    Completeness concerns declared projections only, never cost or provenance.
    Counter completeness is separate: all observed counters may be known while a
    projection has an unmapped component. Reported totals remain independent.
    """
    _reference(proposal_ref)
    if type(steps) is not tuple or type(receipts) is not tuple:
        raise ValueError("immutable_inputs_required")
    declared = {}
    for step in steps:
        if type(step) is not DeclaredUsageStep or type(step.identity) is not ModelIdentity:
            raise ValueError("invalid_step")
        _reference(step.step_ref)
        ModelIdentity(step.identity.provider, step.identity.requested_model_revision,
                      step.identity.resolved_model_revision)
        if step.step_ref in declared:
            raise ValueError("duplicate_step")
        declared[step.step_ref] = step
    received = {}
    for receipt in receipts:
        if type(receipt) is not StepUsageReceipt or type(receipt.projection) is not UsageProjection:
            raise ValueError("invalid_receipt")
        if receipt.step_ref not in declared:
            raise ValueError("undeclared_receipt")
        if receipt.step_ref in received:
            raise ValueError("duplicate_receipt")
        if receipt.projection.observation.identity != declared[receipt.step_ref].identity:
            raise ValueError("step_identity_mismatch")
        received[receipt.step_ref] = receipt.projection

    summaries, grouped = [], {}
    for step in steps:
        projection = received.get(step.step_ref)
        summary = UsageStepSummary(step.step_ref, step.identity, projection,
                                   projection.coverage if projection is not None else "unknown",
                                   projection.gaps if projection is not None else ("receipt_unavailable",))
        summaries.append(summary)
        grouped.setdefault(step.identity, []).append(summary)

    models = []
    for identity, group in grouped.items():
        counters = []
        for field in fields(TokenCounts):
            values = []
            for step in group:
                if step.projection is not None:
                    value = getattr(step.projection.observation.counts, field.name)
                    if value is not None:
                        # Keep integer precision; do not let presentation coerce
                        # an invalid projection counter into a measured quantity.
                        if type(value) is not int or value < 0:
                            raise ValueError("invalid_projected_count")
                        values.append(value)
            counters.append(CounterUsageSummary(field.name, sum(values) if values else None,
                                                len(values), len(group), len(values) == len(group)))
        models.append(ModelUsageSummary(identity, tuple(s.step_ref for s in group), tuple(counters)))
    if summaries and all(s.coverage == "complete_for_declared_contract" for s in summaries):
        coverage = "complete_for_declared_steps_and_contracts"
    elif any(s.coverage != "unknown" for s in summaries):
        coverage = "partial"
    else:
        coverage = "unknown"
    gaps = tuple(s.step_ref + ":" + gap for s in summaries for gap in s.gaps)
    if not summaries:
        gaps = ("steps_not_declared",)
    return ProposalUsageSummary(proposal_ref, len(steps), len(receipts), tuple(summaries),
                                tuple(models), coverage, gaps)
