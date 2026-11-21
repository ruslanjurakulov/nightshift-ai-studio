"""Offline usage normalization; no adapter, admission or charging authority.

Only synthetic/already-normalized observations belong here, never vendor payloads.
DISJOINT_V1 declares uncached input, cache read, cache write, visible output and
reasoning as mutually exclusive buckets. Inclusive vendor counters need a separate
verified mapping. Reported total is independent: it is never inferred or summed.
"""
from dataclasses import dataclass, fields
from typing import Literal, Optional

DISJOINT_V1 = "disjoint-v1"
Outcome = Literal["success", "known_failure", "ambiguous_failure"]


@dataclass(frozen=True)
class ModelIdentity:
    provider: str
    requested_model_revision: str
    resolved_model_revision: Optional[str] = None

    def __post_init__(self):
        for value in (self.provider, self.requested_model_revision):
            if type(value) is not str or not value.strip():
                raise ValueError("identity_required")
        value = self.resolved_model_revision
        if value is not None and (type(value) is not str or not value.strip()):
            raise ValueError("invalid_resolved_revision")


@dataclass(frozen=True)
class TokenCounts:
    uncached_input: Optional[int] = None
    cache_read: Optional[int] = None
    cache_write: Optional[int] = None
    visible_output: Optional[int] = None
    reasoning: Optional[int] = None
    reported_total: Optional[int] = None

    def __post_init__(self):
        for field in fields(self):
            value = getattr(self, field.name)
            # bool, floats and numeric strings are not measured integer counts.
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError("invalid_token_count")


@dataclass(frozen=True)
class UsageObservation:
    identity: ModelIdentity
    outcome: Outcome
    counts: TokenCounts
    semantics: Optional[str]
    status: Literal["reported", "unknown"]
    reason: Optional[str]


def normalize_usage(identity: ModelIdentity, *, outcome: Outcome,
                    counts: Optional[TokenCounts] = None,
                    semantics: Optional[str] = None) -> UsageObservation:
    """Preserve explicit measurements, never infer usage from success or failure.

    A caller declaration is not provider provenance verification. This contract
    cannot establish billable usage, retry safety, permission or settlement.
    """
    if type(identity) is not ModelIdentity:
        raise ValueError("identity_required")
    if outcome not in ("success", "known_failure", "ambiguous_failure"):
        raise ValueError("invalid_outcome")
    if counts is not None and type(counts) is not TokenCounts:
        raise ValueError("invalid_counts")
    reason = None
    if outcome == "ambiguous_failure":
        reason = "ambiguous_failure"
    elif counts is None or all(getattr(counts, f.name) is None for f in fields(counts)):
        reason = "usage_unreported"
    elif semantics != DISJOINT_V1:
        reason = "counting_semantics_unverified"
    if reason is not None:
        return UsageObservation(identity, outcome, TokenCounts(), None, "unknown", reason)
    return UsageObservation(identity, outcome, counts, DISJOINT_V1, "reported", None)
