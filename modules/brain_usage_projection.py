"""Pure candidate quantities from explicitly declared usage contracts.

No vendor payloads, prices, ledger calls or persistence. Evidence and mapping
references are injected assertions, NOT authenticated provenance. A future trusted
consumer must qualify them independently before treating any row as accounting.
"""
from dataclasses import dataclass, fields
from typing import Literal, Optional, Tuple

from modules.brain_usage_contract import (
    DISJOINT_V1, ModelIdentity, TokenCounts, UsageObservation, normalize_usage,
)

COMPONENTS = ("uncached_input", "cache_read", "cache_write", "visible_output", "reasoning")


def _reference(value):
    if type(value) is not str or not value.strip():
        raise ValueError("reference_required")


@dataclass(frozen=True)
class EvidenceReference:
    """Declared source binding only; this class does not verify its issuer."""
    provider: str
    resolved_model_revision: str
    evidence_ref: str
    mapper_revision: str

    def __post_init__(self):
        for field in fields(self):
            _reference(getattr(self, field.name))


@dataclass(frozen=True)
class CounterBinding:
    counter: str
    unit: str
    required: bool

    def __post_init__(self):
        if self.counter not in COMPONENTS:
            raise ValueError("component_required")
        _reference(self.unit)
        if type(self.required) is not bool:
            raise ValueError("required_must_be_boolean")


@dataclass(frozen=True)
class ProjectionContract:
    """Synthetic/injected mapping declaration; does not register ledger units."""
    provider: str
    resolved_model_revision: str
    mapper_revision: str
    mapping_ref: str
    semantics: str
    bindings: Tuple[CounterBinding, ...]

    def __post_init__(self):
        for name in ("provider", "resolved_model_revision", "mapper_revision", "mapping_ref"):
            _reference(getattr(self, name))
        if self.semantics != DISJOINT_V1:
            raise ValueError("disjoint_contract_required")
        if type(self.bindings) is not tuple or not self.bindings:
            raise ValueError("immutable_bindings_required")
        if any(type(b) is not CounterBinding for b in self.bindings):
            raise ValueError("invalid_binding")
        if len({b.counter for b in self.bindings}) != len(self.bindings):
            raise ValueError("duplicate_counter")
        if len({b.unit for b in self.bindings}) != len(self.bindings):
            raise ValueError("duplicate_unit")


@dataclass(frozen=True)
class CandidateQuantity:
    counter: str
    unit: str
    quantity: int


@dataclass(frozen=True)
class UsageProjection:
    observation: UsageObservation
    evidence: Optional[EvidenceReference]
    mapping_ref: str
    rows: Tuple[CandidateQuantity, ...]
    gaps: Tuple[str, ...]
    coverage: Literal["unknown", "partial", "complete_for_declared_contract"]
    projected_component_tokens: Optional[int]


def project_usage(observation: UsageObservation, contract: ProjectionContract, *,
                  evidence: Optional[EvidenceReference] = None) -> UsageProjection:
    """Project disjoint components, preserving unknown and integer precision.

    `projected_component_tokens` sums projected rows only, not total usage or
    money. None means no rows; measured zeros may sum to zero. Reported total is
    retained in observation only and never added, subtracted or inferred.
    Completeness describes this declared component contract, not price coverage,
    provider provenance, durable recording, a quote or authorization to spend.
    """
    if type(observation) is not UsageObservation or type(contract) is not ProjectionContract:
        raise ValueError("typed_input_required")
    if type(observation.identity) is not ModelIdentity or type(observation.counts) is not TokenCounts:
        raise ValueError("invalid_observation")
    identity = observation.identity
    ModelIdentity(identity.provider, identity.requested_model_revision, identity.resolved_model_revision)
    counts = TokenCounts(**{f.name: getattr(observation.counts, f.name) for f in fields(TokenCounts)})
    canonical = normalize_usage(identity, outcome=observation.outcome,
                                counts=counts, semantics=observation.semantics)
    # Normalized unknown receipts retain their original reason; validate that
    # reason against a reachable normalizer outcome without fabricating counts.
    if observation.status == "unknown":
        allowed = {"usage_unreported", "counting_semantics_unverified", "ambiguous_failure"}
        if (counts != TokenCounts() or observation.semantics is not None
                or observation.reason not in allowed
                or (observation.outcome == "ambiguous_failure") != (observation.reason == "ambiguous_failure")):
            raise ValueError("inconsistent_observation")
    elif canonical != observation:
        raise ValueError("inconsistent_observation")
    if evidence is not None and type(evidence) is not EvidenceReference:
        raise ValueError("typed_evidence_required")

    def unavailable(reason):
        return UsageProjection(observation, evidence, contract.mapping_ref, (), (reason,), "unknown", None)

    if observation.status == "unknown":
        return unavailable(observation.reason)
    if evidence is None:
        return unavailable("evidence_unavailable")
    if identity.resolved_model_revision is None:
        return unavailable("resolved_revision_unavailable")
    if (identity.provider != contract.provider
            or identity.resolved_model_revision != contract.resolved_model_revision
            or evidence.provider != identity.provider
            or evidence.resolved_model_revision != identity.resolved_model_revision
            or evidence.mapper_revision != contract.mapper_revision):
        return unavailable("provenance_binding_mismatch")

    bindings = {b.counter: b for b in contract.bindings}
    rows, gaps = [], []
    for counter in COMPONENTS:
        value, binding = getattr(counts, counter), bindings.get(counter)
        if binding is None:
            if value is not None:
                gaps.append("unmapped:" + counter)
        elif value is None:
            if binding.required:
                gaps.append("missing:" + counter)
        else:
            rows.append(CandidateQuantity(counter, binding.unit, value))
    # A diagnostic total alone must never become a projected component or zero.
    coverage = "unknown" if not rows else "partial" if gaps else "complete_for_declared_contract"
    if not rows and not gaps:
        gaps.append("components_unreported")
    return UsageProjection(observation, evidence, contract.mapping_ref, tuple(rows), tuple(gaps),
                           coverage, sum(r.quantity for r in rows) if rows else None)
