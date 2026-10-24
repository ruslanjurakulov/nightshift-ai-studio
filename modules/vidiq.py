"""vidIQ research & scoring — advisory keyword/title intelligence.

Scope, stated up front
----------------------
vidIQ is used here for **research and scoring only** — never as a second content
pipeline. This module turns vidIQ-shaped data (keyword volume/competition,
title scores) into a ranked recommendation for a human or the topic/title
planner to *consult*. Like `modules/niche_rpm.py` and `modules/publish_score.py`
it INFORMS; it never selects a topic, edits a title, or gates a publish on its
own. The pipeline's own generators stay exactly as they are.

The tested core is pure
-----------------------
The ranking heuristics (`opportunity_score`, `rank_keywords`, `rank_titles`)
operate on plain values, so they are fully unit-testable and deterministic, and
they hold the project's data honesty rules: an unknown metric is `None`, never a
fabricated `0`, and a keyword whose opportunity can't be computed is left out of
the ranking rather than ranked as the worst.

Fetching is a seam
------------------
`VidIQClient` is a Protocol so the fetch transport is injected. `VidIQResearcher`
is off unless given a client — with no client every method is a safe no-op, so an
unconfigured deployment behaves exactly as before. The concrete transport is
`modules/vidiq_client.py` (a `VIDIQ_ACCESS_TOKEN`-backed HTTP adapter), which
`IntelligencePoller.research_vidiq` injects only when vidIQ is enabled.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional, Protocol

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Keyword:
    """A vidIQ keyword result. `search_volume` and `competition` are the two
    vidIQ surfaces on a 0-100 scale; either may be None when vidIQ didn't
    return it — unknown, never assumed zero."""
    term: str
    search_volume: Optional[float] = None
    competition: Optional[float] = None
    related: tuple = field(default_factory=tuple)


def _norm_0_100(value: Optional[float]) -> Optional[float]:
    """Clamp a 0-100 metric into 0..1, or None when it's unknown/unparseable."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v < 0:
        v = 0.0
    if v > 100:
        v = 100.0
    return v / 100.0


def opportunity_score(kw: Keyword) -> Optional[float]:
    """vidIQ's classic opportunity heuristic: reward search volume, penalise
    competition. Returns a 0..1 score, or None when either input is unknown —
    a missing metric makes the opportunity genuinely unknown, not zero.

    score = volume_norm * (1 - competition_norm)
    """
    vol = _norm_0_100(kw.search_volume)
    comp = _norm_0_100(kw.competition)
    if vol is None or comp is None:
        return None
    return round(vol * (1.0 - comp), 6)


def rank_keywords(keywords: list) -> list:
    """Keywords ranked by opportunity, best first. A keyword whose opportunity
    can't be computed (a missing metric) is excluded rather than ranked as the
    worst — an unknown is not a bad score. Ties break by higher raw volume,
    then alphabetically, so the order is deterministic."""
    scored = []
    for kw in keywords or []:
        s = opportunity_score(kw)
        if s is None:
            continue
        scored.append((kw, s))
    scored.sort(
        key=lambda pair: (-pair[1], -(pair[0].search_volume or 0.0), pair[0].term)
    )
    return scored


def best_keywords(keywords: list, k: int = 5) -> list:
    """The top-k keyword terms by opportunity (strings). Fewer than k when the
    pool has fewer computable ones; empty when none can be scored."""
    if k <= 0:
        return []
    return [kw.term for kw, _ in rank_keywords(keywords)[:k]]


@dataclass(frozen=True)
class TitleScore:
    title: str
    #: vidIQ's title score, 0-100, or None when it wasn't returned.
    score: Optional[float] = None


def rank_titles(titles: list) -> list:
    """Titles ranked by vidIQ score, best first. Unscored titles are excluded
    (unknown, not zero). Deterministic: ties break alphabetically."""
    scored = [(t, float(t.score)) for t in (titles or []) if t.score is not None]
    scored.sort(key=lambda pair: (-pair[1], pair[0].title))
    return scored


def best_title(titles: list) -> Optional[str]:
    """The highest-scoring title, or None when none carries a score. Advisory —
    the caller decides whether to use it; it never overrides the planner."""
    ranked = rank_titles(titles)
    return ranked[0][0].title if ranked else None


def summarize_research(ranked_keywords: list, limit: int = 10) -> dict:
    """Metadata for one `vidiq.research` event."""
    top = ranked_keywords[:limit]
    return {
        "keywords_scored": len(ranked_keywords),
        "top": [{"term": kw.term, "opportunity": score} for kw, score in top],
        "best": top[0][0].term if top else None,
    }


def summarize_titles(ranked_titles: list) -> dict:
    """Metadata for one `vidiq.scored` event."""
    return {
        "titles_scored": len(ranked_titles),
        "best": ranked_titles[0][0].title if ranked_titles else None,
        "best_score": ranked_titles[0][1] if ranked_titles else None,
    }


class VidIQClient(Protocol):
    """The fetch seam. A real adapter (VIDIQ_ACCESS_TOKEN-backed HTTP, or an
    MCP-backed one) implements these; tests inject a fake. Implementations
    should return [] / None on failure rather than raise."""

    def keyword_research(self, seed: str) -> list: ...

    def score_title(self, title: str) -> Optional[float]: ...


class VidIQResearcher:
    """Advisory researcher. Off unless a client is supplied; with none, every
    method is a safe no-op so an unconfigured deployment is unchanged. It emits
    one advisory event per pass and never gates, selects, or edits anything."""

    def __init__(self, client: Optional[VidIQClient] = None, channel_id: Optional[str] = None):
        self.client = client
        self.channel_id = channel_id

    @property
    def enabled(self) -> bool:
        return self.client is not None

    def research(self, seed: str) -> list:
        """Ranked keyword opportunities for `seed`, and one `vidiq.research`
        event. Returns [] when disabled or on any failure. Never raises."""
        if not self.enabled:
            return []
        try:
            from modules import event_log as events

            raw = self.client.keyword_research(seed) or []
            keywords = [k if isinstance(k, Keyword) else _coerce_keyword(k) for k in raw]
            ranked = rank_keywords(keywords)
            events.emit(events.VIDIQ_RESEARCH, agent="vidiq", status=events.STATUS_COMPLETED,
                        channel_id=self.channel_id, metadata=summarize_research(ranked))
            return ranked
        except Exception:
            logger.exception("vidIQ research pass failed; recommending nothing")
            return []

    def score_titles(self, titles: list) -> list:
        """Rank candidate title strings by vidIQ's title score, and emit one
        `vidiq.scored` event. Returns [] when disabled or on failure. Advisory:
        the planner is free to ignore the ranking. Never raises."""
        if not self.enabled:
            return []
        try:
            from modules import event_log as events

            scored = []
            for title in titles or []:
                score = self.client.score_title(title)
                scored.append(TitleScore(title=title, score=score))
            ranked = rank_titles(scored)
            events.emit(events.VIDIQ_SCORED, agent="vidiq", status=events.STATUS_COMPLETED,
                        channel_id=self.channel_id, metadata=summarize_titles(ranked))
            return ranked
        except Exception:
            logger.exception("vidIQ title-scoring pass failed; scoring nothing")
            return []


def _coerce_keyword(data) -> Keyword:
    """Best-effort mapping of a raw dict result into a Keyword. Unknown fields
    stay None; never raises."""
    if not isinstance(data, dict):
        return Keyword(term=str(data))
    return Keyword(
        term=str(data.get("term") or data.get("keyword") or ""),
        search_volume=data.get("search_volume", data.get("volume")),
        competition=data.get("competition"),
        related=tuple(data.get("related") or ()),
    )
