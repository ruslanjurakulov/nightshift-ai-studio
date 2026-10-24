"""Content-Opportunity Engine — blends trend and audience-demand signals into a
ranked, explainable list of video topic candidates.

This module is intentionally decoupled from any sibling "trend detector" or
"audience demand" module that may be developed in parallel on other branches.
Rather than importing dataclasses like ``VideoSnapshot`` or ``DemandSignal``
from those modules (which do not exist in this worktree and would break the
build), this engine accepts **plain dicts** for both of its inputs. Each
input dict is loosely compatible with what those sibling dataclasses would
produce via ``dataclasses.asdict()`` — i.e. if/when this module is wired up
to the real pipeline, the caller can simply do
``ContentOpportunityEngine().rank([asdict(s) for s in snapshots], ...)``
with no adapter code required, as long as the field names below are present.

Expected input shapes
----------------------
``trend_snapshots: list[dict]`` — each dict must contain at least:
    - ``video_id``: str
    - ``title``: str
    - ``view_count``: int
    - ``published_at``: str, ISO 8601 (e.g. "2026-08-30T12:00:00Z" or
      "2026-08-30T12:00:00+00:00"). Used to compute a view-velocity figure
      (views per hour since publish). If missing/unparseable, the trend
      score falls back to a raw ``view_count`` percentile within the batch.

``demand_signals: list[dict]`` — each dict must contain at least:
    - ``topic_phrase``: str
    - ``mention_count``: int

Both input lists may be empty (or contain a single item); the engine never
divides by zero and simply returns an empty (or appropriately degenerate)
result in those cases.

This module does not read ``trend_detector`` / ``audience_demand`` output
itself. ``modules/topic_recommender.py`` feeds it persisted snapshots and
``modules/topic_manager.py`` uses the ranking in the topic prompt; neither
step lives here.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #

@dataclass
class ContentOpportunity:
    """A single ranked, explainable video topic candidate."""

    topic: str
    score: float
    source: str  # "trend" | "demand" | "both"
    rationale: str


@dataclass
class _TrendCandidate:
    """Internal bookkeeping for one trend-side topic candidate."""

    title: str
    view_count: int
    velocity: Optional[float]  # views/hour, if computable
    raw_score: float = 0.0  # 0-1, normalized within batch
    percentile_used: bool = False


@dataclass
class _DemandCandidate:
    """Internal bookkeeping for one demand-side topic candidate."""

    topic_phrase: str
    mention_count: int
    raw_score: float = 0.0  # 0-1, normalized within batch


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _parse_iso8601(value: str) -> Optional[datetime]:
    """Best-effort ISO8601 parser tolerant of a trailing 'Z'. Returns None on failure."""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _hours_since(published_at: Optional[datetime], now: datetime) -> Optional[float]:
    if published_at is None:
        return None
    delta_hours = (now - published_at).total_seconds() / 3600.0
    if delta_hours <= 0:
        # Published in the future (bad data) or this instant — not usable
        # for a velocity computation; treat as unavailable.
        return None
    return delta_hours


def _min_max_normalize(values: list[float]) -> list[float]:
    """Normalize a list of numbers to the 0-1 range. Handles 0/1-length lists
    and the all-equal case without dividing by zero.
    """
    if not values:
        return []
    if len(values) == 1:
        return [1.0]
    lo, hi = min(values), max(values)
    if hi == lo:
        return [1.0 for _ in values]
    span = hi - lo
    return [(v - lo) / span for v in values]


def _percentile_rank(values: list[float], index: int) -> float:
    """Fraction of values in the list that are <= values[index], as a 0-1 score.
    Used as the "raw view_count percentile within the batch" fallback.
    """
    if len(values) <= 1:
        return 1.0
    target = values[index]
    count_le = sum(1 for v in values if v <= target)
    return count_le / len(values)


def _format_int(n: float) -> str:
    return f"{int(round(n)):,}"


# --------------------------------------------------------------------------- #
# Engine
# --------------------------------------------------------------------------- #

class ContentOpportunityEngine:
    """Blends trend and audience-demand signals into ranked, explainable
    content opportunities.

    Parameters
    ----------
    trend_weight, demand_weight:
        Relative weights used to blend the two normalized 0-1 signal scores
        into a single opportunity score. Both must be non-negative and must
        sum to a positive number (i.e. at least one of them must be > 0).
    match_threshold:
        Minimum ``difflib.SequenceMatcher`` similarity ratio (0-1) for a
        trend title and a demand phrase to be considered "the same topic"
        and merged into a single ``source="both"`` opportunity.
    """

    def __init__(
        self,
        trend_weight: float = 0.5,
        demand_weight: float = 0.5,
        match_threshold: float = 0.6,
    ):
        if trend_weight < 0 or demand_weight < 0:
            raise ValueError(
                f"trend_weight and demand_weight must be non-negative, "
                f"got trend_weight={trend_weight}, demand_weight={demand_weight}"
            )
        if trend_weight + demand_weight <= 0:
            raise ValueError(
                "trend_weight + demand_weight must sum to a positive number, "
                f"got {trend_weight + demand_weight}"
            )
        self.trend_weight = trend_weight
        self.demand_weight = demand_weight
        self.match_threshold = match_threshold

    # -- scoring -------------------------------------------------------- #

    def _score_trend_candidates(
        self, trend_snapshots: list[dict], now: datetime
    ) -> list[_TrendCandidate]:
        candidates: list[_TrendCandidate] = []
        velocities: list[Optional[float]] = []

        for snap in trend_snapshots:
            view_count = int(snap.get("view_count", 0))
            published_at = _parse_iso8601(snap.get("published_at", ""))
            hours = _hours_since(published_at, now)
            velocity = (view_count / hours) if hours else None
            velocities.append(velocity)
            candidates.append(
                _TrendCandidate(
                    title=snap.get("title", ""),
                    view_count=view_count,
                    velocity=velocity,
                )
            )

        if not candidates:
            return candidates

        # If every candidate has a computable velocity, normalize on velocity.
        # Otherwise fall back to raw view_count percentile for ALL candidates
        # (keeps the batch's scores mutually comparable on one consistent basis).
        if all(v is not None for v in velocities):
            normalized = _min_max_normalize([v for v in velocities])  # type: ignore[misc]
            for cand, score in zip(candidates, normalized):
                cand.raw_score = score
                cand.percentile_used = False
        else:
            view_counts = [float(c.view_count) for c in candidates]
            for i, cand in enumerate(candidates):
                cand.raw_score = _percentile_rank(view_counts, i)
                cand.percentile_used = True

        return candidates

    def _score_demand_candidates(self, demand_signals: list[dict]) -> list[_DemandCandidate]:
        candidates = [
            _DemandCandidate(
                topic_phrase=sig.get("topic_phrase", ""),
                mention_count=int(sig.get("mention_count", 0)),
            )
            for sig in demand_signals
        ]
        if not candidates:
            return candidates

        mention_counts = [float(c.mention_count) for c in candidates]
        normalized = _min_max_normalize(mention_counts)
        for cand, score in zip(candidates, normalized):
            cand.raw_score = score
        return candidates

    # -- rationale -------------------------------------------------------- #

    @staticmethod
    def _trend_rationale(cand: _TrendCandidate) -> str:
        if cand.velocity is not None:
            return (
                f"view velocity {_format_int(cand.velocity)} views/hr "
                f"(score {cand.raw_score:.2f} of batch max)"
            )
        return (
            f"{_format_int(cand.view_count)} views, "
            f"in the top {int(round((1 - cand.raw_score) * 100))}% "
            f"of this batch by raw view count"
        )

    @staticmethod
    def _demand_rationale(cand: _DemandCandidate) -> str:
        return f"mentioned in {cand.mention_count} comments/searches"

    # -- matching --------------------------------------------------------- #

    def _similarity(self, a: str, b: str) -> float:
        return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()

    # -- public API --------------------------------------------------------- #

    def rank(
        self,
        trend_snapshots: list[dict],
        demand_signals: list[dict],
        max_results: int = 10,
    ) -> list[ContentOpportunity]:
        """Score, match, and rank topic candidates from both input streams.

        Returns the top ``max_results`` :class:`ContentOpportunity` items,
        sorted descending by ``score``. Empty inputs (either or both lists)
        return ``[]`` without raising.
        """
        now = datetime.now(timezone.utc)
        trend_candidates = self._score_trend_candidates(trend_snapshots, now)
        demand_candidates = self._score_demand_candidates(demand_signals)

        matched_demand_indices: set[int] = set()
        opportunities: list[ContentOpportunity] = []

        # Trend candidates: try to find a matching demand candidate.
        for t_cand in trend_candidates:
            best_idx: Optional[int] = None
            best_sim = 0.0
            for i, d_cand in enumerate(demand_candidates):
                if i in matched_demand_indices:
                    continue
                sim = self._similarity(t_cand.title, d_cand.topic_phrase)
                if sim > best_sim:
                    best_sim = sim
                    best_idx = i

            if best_idx is not None and best_sim >= self.match_threshold:
                d_cand = demand_candidates[best_idx]
                matched_demand_indices.add(best_idx)
                blended = (
                    self.trend_weight * t_cand.raw_score
                    + self.demand_weight * d_cand.raw_score
                ) / (self.trend_weight + self.demand_weight)
                rationale = (
                    f"{self._trend_rationale(t_cand)}; {self._demand_rationale(d_cand)} "
                    f"(matched trend/demand topics at {best_sim:.0%} text similarity)"
                )
                opportunities.append(
                    ContentOpportunity(
                        topic=t_cand.title,
                        score=blended,
                        source="both",
                        rationale=rationale,
                    )
                )
            else:
                score = (self.trend_weight * t_cand.raw_score) / (
                    self.trend_weight + self.demand_weight
                )
                opportunities.append(
                    ContentOpportunity(
                        topic=t_cand.title,
                        score=score,
                        source="trend",
                        rationale=self._trend_rationale(t_cand),
                    )
                )

        # Remaining, unmatched demand candidates stand on their own.
        for i, d_cand in enumerate(demand_candidates):
            if i in matched_demand_indices:
                continue
            score = (self.demand_weight * d_cand.raw_score) / (
                self.trend_weight + self.demand_weight
            )
            opportunities.append(
                ContentOpportunity(
                    topic=d_cand.topic_phrase,
                    score=score,
                    source="demand",
                    rationale=self._demand_rationale(d_cand),
                )
            )

        opportunities.sort(key=lambda o: o.score, reverse=True)
        return opportunities[:max_results]
