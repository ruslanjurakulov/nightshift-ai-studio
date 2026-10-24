"""Performance Analyzer — turns captured post-publication metrics history
into actual analysis.

Context
-------
A prior implementation report found that "post-publication performance
analysis" was capture without analysis: `modules/intelligence_poller.py`'s
`poll_own_channel_metrics()` writes rows into `StateStore`'s
`metrics_snapshots` table, but nothing anywhere read that history back and
turned it into any insight — no averages, no "what performed well," nothing.
This module is that missing read side: `PerformanceAnalyzer` pulls
`StateStore.list_videos()` and, for each video, its `latest_metrics()`
snapshot, and turns the pair into ranked, explainable `VideoPerformance`
records.

The `views_per_day` metric and its "as-of" date
-------------------------------------------------
`views_per_day` is deliberately computed as
`latest_views / days_between(published_at, snapshot_date)` — using the date
the metrics were actually *measured* (`latest_metrics()`'s `snapshot_date`),
not "today" (`datetime.now()`). Two reasons:

1. Correctness: the poller's cadence can lag behind "now" (a video might not
   have been re-polled in days). Dividing by elapsed time since the last
   actual measurement gives the true average rate as of that measurement;
   dividing by time since "now" would silently understate the rate for any
   video whose latest snapshot is stale, without that staleness being
   visible anywhere in the number.
2. Determinism/testability: it makes the computation a pure function of
   persisted data, not of wall-clock time at analysis time — the same
   database always produces the same `views_per_day` no matter when
   `analyze_videos()` is called.

Day-zero smoothing
--------------------
A video whose metrics were captured on the same calendar day it was
published has zero elapsed days, which would divide by zero. Rather than
special-case that video out of the ranking (it may well be a real early
signal worth surfacing), the elapsed-days denominator is floored at 1. This
is a deliberate smoothing, not a claim that the video has genuinely been
live for a full day — treat `views_per_day` for a same-day video as "views
so far," not a stable per-day rate; it will typically fall once more days
of denominator accrue in later snapshots.

Honesty-preserving framing
-----------------------------
`analyze_videos_as_prompt_text()` follows the same posture as
`modules/topic_recommender.py`'s `suggest_topics_as_prompt_text()` and
`modules/script_engine.py`'s `_format_research_notes()`: the numbers
rendered are real (persisted metrics, not invented), but the text is
explicit that this is past-performance context to consider, not a formula
whoever reads the prompt (Gemini, a human) must follow. What made one video
perform well is never guaranteed to transfer to the next topic, and this
module does not claim otherwise.

Dependency injection
---------------------
`PerformanceAnalyzer.__init__(state_store=None)` mirrors
`TopicRecommender`: `state_store` defaults to constructing a real
`StateStore()`, wrapped in try/except so a construction failure (e.g. no
writable DB path) logs a warning and degrades to `self.state_store = None`
rather than raising. Every public method is defensive end-to-end after
that: any state-store failure is logged as a warning and degrades to the
method's documented empty/zero value (`[]` or `0.0` or `""`), never
propagates.

What informs a real run is done by the callers, not by this module:
`modules/topic_manager.py` and `modules/script_engine.py` put
`analyze_videos_as_prompt_text()` into their prompts — the same split as
`topic_recommender.py`'s relationship to `topic_manager.py`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime

logger = logging.getLogger(__name__)

# Below this many videos with metrics, "past performance" isn't a pattern
# yet -- it's a single (or zero) data point. analyze_videos_as_prompt_text()
# returns "" below this threshold rather than presenting one video's numbers
# as if they meant something.
_MIN_VIDEOS_FOR_PROMPT_TEXT = 2


@dataclass
class VideoPerformance:
    """One video's latest known performance, as computed from persisted
    `StateStore` data."""

    video_id: str
    topic: str
    title: str
    published_at: str
    latest_views: int
    latest_watch_time_minutes: float
    latest_average_view_duration_seconds: float
    views_per_day: float


def _parse_date(value: str) -> date | None:
    """Best-effort parse of a `published_at` / `snapshot_date` string (both
    are free-form TEXT columns in `StateStore`) into a `date`.

    Handles a bare date ("2026-01-01"), a full ISO datetime
    ("2026-01-01T00:00:00"), and a trailing "Z" (not accepted by
    `datetime.fromisoformat` on older Pythons). Returns None rather than
    raising on anything unparseable, so one malformed timestamp can't take
    down analysis of every other video.
    """
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        pass
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _views_per_day(views: int, published_at: str, snapshot_date: str) -> float | None:
    """`views / max(1, days between published_at and snapshot_date)`.

    Returns None (rather than 0.0) when either date is unparseable, so the
    caller can skip a video it genuinely can't compute a rate for instead of
    silently reporting a misleading zero.
    """
    published = _parse_date(published_at)
    measured = _parse_date(snapshot_date)
    if published is None or measured is None:
        return None
    elapsed_days = (measured - published).days
    # Day-zero smoothing: a same-day (or, defensively, a negative/clock-skew)
    # gap is floored to 1 day rather than dividing by zero -- see module
    # docstring "Day-zero smoothing" for why this is a deliberate choice,
    # not a claim of a real 24-hour rate.
    denominator = max(1, elapsed_days)
    return views / denominator


class PerformanceAnalyzer:
    """Reads persisted video + metrics history via `StateStore` and turns it
    into ranked `VideoPerformance` insight.

    Dependency injection mirrors `modules/topic_recommender.py`'s
    `TopicRecommender`: `state_store` defaults to constructing the real
    thing, but accepts an injected fake/mock so tests never touch a real
    database unintentionally.
    """

    def __init__(self, state_store=None, channel_id: str | None = None):
        # `channel_id` scopes every read to one channel. None keeps the
        # pre-multi-channel behaviour: analyse every video in the store.
        self.channel_id = channel_id
        if state_store is not None:
            self.state_store = state_store
        else:
            try:
                from modules.state_store import StateStore

                self.state_store = StateStore()
            except Exception:
                logger.warning(
                    "Failed to construct default StateStore; PerformanceAnalyzer "
                    "will degrade to no analysis until a working store is available",
                    exc_info=True,
                )
                self.state_store = None

    # -- analysis ---------------------------------------------------------- #

    def analyze_videos(self, limit: int = 50, since: str | None = None) -> list[VideoPerformance]:
        """Read up to `limit` videos (optionally restricted to those
        published on/after `since`) and their latest metrics, and return
        `VideoPerformance` records sorted descending by `views_per_day`.

        A video with no metrics snapshot yet is omitted, not an error --
        that's the expected, common state for a just-published or
        not-yet-polled video, so it is skipped silently rather than logged
        as a warning.

        Never raises: any `state_store` failure is logged as a warning and
        degrades to `[]`.
        """
        if self.state_store is None:
            return []

        try:
            videos = self.state_store.list_videos(
                limit=limit, since=since, channel_id=self.channel_id
            )
        except Exception:
            logger.warning("Failed to list videos from state store; returning no analysis", exc_info=True)
            return []

        results: list[VideoPerformance] = []
        for video in videos:
            video_id = video.get("video_id")
            if not video_id:
                continue

            try:
                metrics = self.state_store.latest_metrics(video_id)
            except Exception:
                logger.warning(
                    "Failed to fetch latest metrics for %s; skipping this video", video_id, exc_info=True
                )
                continue

            if metrics is None:
                # No snapshot yet -- expected and common, not an error.
                continue

            views = int(metrics.get("views") or 0)
            vpd = _views_per_day(
                views=views,
                published_at=video.get("published_at") or "",
                snapshot_date=metrics.get("snapshot_date") or "",
            )
            if vpd is None:
                logger.warning(
                    "Could not compute views_per_day for %s (unparseable date); skipping", video_id
                )
                continue

            results.append(
                VideoPerformance(
                    video_id=video_id,
                    topic=video.get("topic") or "",
                    title=video.get("title") or "",
                    published_at=video.get("published_at") or "",
                    latest_views=views,
                    latest_watch_time_minutes=float(metrics.get("watch_time_minutes") or 0.0),
                    latest_average_view_duration_seconds=float(
                        metrics.get("average_view_duration_seconds") or 0.0
                    ),
                    views_per_day=vpd,
                )
            )

        results.sort(key=lambda vp: vp.views_per_day, reverse=True)
        return results

    def top_performers(
        self, n: int = 5, limit: int = 50, since: str | None = None
    ) -> list[VideoPerformance]:
        """The `n` highest `views_per_day` videos. Convenience wrapper over
        `analyze_videos()`."""
        return self.analyze_videos(limit=limit, since=since)[:n]

    def underperformers(
        self, n: int = 5, limit: int = 50, since: str | None = None
    ) -> list[VideoPerformance]:
        """The `n` lowest `views_per_day` videos, among those that actually
        have metrics. A video with zero snapshots yet is "no data" (already
        omitted by `analyze_videos()`), not "underperforming" -- it never
        appears here."""
        analyzed = self.analyze_videos(limit=limit, since=since)
        if not analyzed:
            return []
        return analyzed[-n:][::-1]

    def average_views_per_day(self, limit: int = 50, since: str | None = None) -> float:
        """Mean `views_per_day` across all analyzed videos. `0.0` on an
        empty result -- never raises, never divides by zero."""
        analyzed = self.analyze_videos(limit=limit, since=since)
        if not analyzed:
            return 0.0
        return sum(vp.views_per_day for vp in analyzed) / len(analyzed)

    # -- prompt rendering -------------------------------------------------- #

    def analyze_videos_as_prompt_text(
        self, limit: int = 50, since: str | None = None, top_n: int = 3
    ) -> str:
        """Render `top_performers(top_n, ...)` as a short block of text
        suitable for appending to a topic-selection or script-writing
        prompt.

        Returns "" when fewer than 2 videos have metrics -- one data point
        isn't a pattern, and presenting a single video's numbers as "past
        performance context" would overstate what one sample can tell
        anyone. This also means a caller can always safely append this
        string to a prompt with no awkward empty-section artifact.

        Framed explicitly as context, not a formula to copy -- same spirit
        as `modules/topic_recommender.py`'s `suggest_topics_as_prompt_text()`
        and `modules/script_engine.py`'s `_format_research_notes()`: these
        are real numbers from real published videos, but what (if anything)
        to take from them stays a judgment call downstream. A topic that
        performed well before is not guaranteed to perform well again, and
        this text does not claim otherwise.
        """
        try:
            analyzed = self.analyze_videos(limit=limit, since=since)
        except Exception:
            logger.warning("analyze_videos_as_prompt_text failed; returning no text", exc_info=True)
            return ""

        if len(analyzed) < _MIN_VIDEOS_FOR_PROMPT_TEXT:
            return ""

        top = analyzed[:top_n]
        lines = [
            "Past video performance, for context only -- not a formula to copy "
            "(what worked before is not guaranteed to work again; use your judgment):"
        ]
        for vp in top:
            lines.append(
                f'- "{vp.topic}" ({vp.title}) — {vp.views_per_day:.1f} views/day '
                f"(latest: {vp.latest_views} views, published {vp.published_at})"
            )
        return "\n".join(lines)
