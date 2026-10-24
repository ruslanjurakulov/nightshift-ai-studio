"""Topic Recommender — reads persisted intelligence data back out and turns
it into ranked, explainable topic suggestions.

Context
-------
A prior audit found the "continuous intelligence" system was built but its
feedback loop was never closed: `modules/content_opportunity.py`'s
`ContentOpportunityEngine` (fully built, well tested) had zero callers, and
the trend/competitor/demand data `modules/intelligence_poller.py` computes
was being persisted via `modules/state_store.py` and then never read back.
This module is the missing read side: `TopicRecommender.suggest_topics()`
pulls the three persisted tables (`trending_snapshots`, `competitor_snapshots`,
`demand_signals`) back out of `StateStore` and feeds them through
`ContentOpportunityEngine.rank()` to produce ranked, explainable topic
candidates.

Combining trending + competitor snapshots
------------------------------------------
`ContentOpportunityEngine.rank()` takes a single `trend_snapshots` list.
Both `trending_snapshots` (YouTube's trending feed) and `competitor_snapshots`
(specific channels this bot tracks) are, at heart, the same kind of signal:
"a video that is getting real attention on YouTube right now," just sourced
differently — one from the platform-wide trending feed, the other from
targeted competitor polling. Both `StateStore.list_trending_snapshots()` and
`StateStore.list_competitor_snapshots()` return rows with the `video_id`,
`title`, `view_count`, `published_at` shape `ContentOpportunityEngine`
documents as its `trend_snapshots` input, so concatenating the two lists is
a direct, adapter-free way to let the engine score both sources on one
consistent basis, and the ranked output's `rationale` explains *why* each
entry scored the way it did regardless of which table it came from.

`topic_manager.py` is what closes the loop: it builds a recommender and puts
`suggest_topics_as_prompt_text()` into the topic prompt. None of that wiring
lives in this module, which only provides the read-and-rank capability.

Defensive posture
------------------
This is meant to sit next to Gemini topic generation as *inspiration*, never
as a hard dependency. In practice the underlying tables will very often be
empty (the scheduled poller that populates them has no confirmed successful
run yet), and even once it does run, a state-store construction/query
failure must never be able to take down topic selection. So every entry
point here is defensive end-to-end: any failure anywhere in the read/rank
path is logged as a warning and degrades to `[]` (or `""` for the prompt-text
variant) rather than raising — the same posture as
`modules/topic_manager.py`'s `_safe_originality_check` and
`modules/intelligence_poller.py`'s per-sub-call try/except.
"""

from __future__ import annotations

import logging

from modules.content_opportunity import ContentOpportunity, ContentOpportunityEngine

logger = logging.getLogger(__name__)


class TopicRecommender:
    """Reads persisted trend/competitor/demand data via `StateStore` and
    ranks it into topic suggestions via `ContentOpportunityEngine`.

    Dependency injection mirrors the pattern used throughout this codebase
    (see `modules/intelligence_poller.py`): `state_store` and `engine` each
    default to constructing the real thing, but accept an injected
    fake/mock so tests never touch a real database or perform live
    computation unintentionally.
    """

    def __init__(self, state_store=None, engine=None, channel_id: str | None = None):
        # `channel_id` scopes the two channel-owned inputs — this channel's own
        # competitors and its own audience's requests. Trending stays global on
        # purpose (see suggest_topics). None keeps the pre-multi-channel
        # behaviour: every row, unscoped.
        self.channel_id = channel_id
        if state_store is not None:
            self.state_store = state_store
        else:
            try:
                from modules.state_store import StateStore

                self.state_store = StateStore()
            except Exception:
                logger.warning(
                    "Failed to construct default StateStore; TopicRecommender will "
                    "degrade to no suggestions until a working store is available",
                    exc_info=True,
                )
                self.state_store = None

        self.engine = engine if engine is not None else ContentOpportunityEngine()

    # -- ranking -------------------------------------------------------- #

    def suggest_topics(self, limit: int = 5, since: str | None = None) -> list[ContentOpportunity]:
        """Read persisted trend/competitor/demand data and rank it into
        topic suggestions.

        `since` (ISO date/datetime string, matching `StateStore`'s own
        filtering) is passed through to all three underlying reads to
        narrow the window considered.

        Never raises: any failure reading from `state_store` or ranking via
        `engine` is logged as a warning and degrades to `[]`. This matters
        in practice — the poller that populates these tables has likely
        never had a confirmed successful run against real credentials yet,
        so an empty database is the common case, not the exceptional one.
        """
        if self.state_store is None:
            return []

        try:
            trending = self.state_store.list_trending_snapshots(since=since)
        except Exception:
            logger.warning("Failed to list trending snapshots; treating as empty", exc_info=True)
            trending = []

        # Competitors and audience demand belong to a channel; trending above
        # does not. YouTube's trending list is region-wide public data, the same
        # rows whichever channel reads them, so scoping it would filter nothing
        # and only pretend to isolate something.
        try:
            competitors = self.state_store.list_competitor_snapshots(
                since=since, chronos_channel_id=self.channel_id
            )
        except Exception:
            logger.warning("Failed to list competitor snapshots; treating as empty", exc_info=True)
            competitors = []

        try:
            demand = self.state_store.list_demand_signals(since=since, channel_id=self.channel_id)
        except Exception:
            logger.warning("Failed to list demand signals; treating as empty", exc_info=True)
            demand = []

        combined_trends = list(trending) + list(competitors)
        if not combined_trends and not demand:
            return []

        try:
            return self.engine.rank(combined_trends, demand, max_results=limit)
        except Exception:
            logger.warning("ContentOpportunityEngine.rank failed; returning no suggestions", exc_info=True)
            return []

    # -- prompt rendering -------------------------------------------------- #

    def suggest_topics_as_prompt_text(self, limit: int = 5, since: str | None = None) -> str:
        """Render `suggest_topics()`'s output as a short block of text
        suitable for appending to a Gemini prompt.

        This is deliberately framed as informational inspiration, never as
        a directive — matching `modules/script_engine.py`'s
        `_format_research_notes()`: the header explicitly says "not
        mandatory, use your judgment," and nothing here tells Gemini what
        topic it must pick. The underlying data is real (persisted trend/
        competitor/demand signals), but whether and how to use it stays a
        judgment call for whoever reads the prompt, same as research notes
        are framed as unverified inspiration rather than verified fact.

        Returns "" when there is nothing to suggest, so a caller that
        simply appends this string to an existing prompt gets a true
        no-op rather than an awkward empty section header.
        """
        try:
            opportunities = self.suggest_topics(limit=limit, since=since)
        except Exception:
            logger.warning("suggest_topics_as_prompt_text failed; returning no text", exc_info=True)
            return ""

        if not opportunities:
            return ""

        lines = [
            "Trending/audience-requested topics worth considering "
            "(not mandatory — use your judgment):"
        ]
        for opp in opportunities:
            source_label = {
                "both": "both trend and demand",
                "trend": "trend only",
                "demand": "demand only",
            }.get(opp.source, opp.source)
            lines.append(
                f'- "{opp.topic}" (score {opp.score:.2f}, {source_label} — {opp.rationale})'
            )
        return "\n".join(lines)
