"""Retention analysis — where viewers actually leave.

Why this matters more than the aggregate
-----------------------------------------
The feedback loop scores *topics*: it can tell you "Roman history does 1.4x your
channel average". It cannot tell you that half your audience leaves 20 seconds
in, which is a script problem, not a topic problem — and a script problem is the
one you can fix on the very next video.

`averageViewDuration` was already polled and is still just one number. The
retention *curve* says where the number came from. This module turns the curve
into the two facts a writer can act on:

* **The hook holds or it doesn't.** Retention in the first ~10% of a video is
  the hook's own score.
* **The biggest cliff.** The single largest drop between adjacent points, and
  where it happens.

Both are rendered into a short prompt block for the script engine, in the same
style as `performance_analyzer` and `feedback_engine`: real numbers framed as
context, never as a template to copy. Below the evidence floor it returns "" so
appending it is always safe.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

#: Curves needed before any advice is rendered. One video's curve is that
#: video's story; it is not a pattern.
MIN_CURVES = 3
#: Points needed within one curve before it is usable at all.
MIN_POINTS = 5
#: Everything up to this share of the video counts as "the hook".
HOOK_RATIO = 0.10
#: A cliff smaller than this is ordinary decay, not a moment worth naming.
MIN_CLIFF_DROP = 0.08


@dataclass(frozen=True)
class RetentionInsight:
    video_id: str
    #: Share of viewers still watching at the end of the hook window (0.0-1.0).
    hook_retention: Optional[float]
    #: Where the largest single drop starts, as a share of the video.
    cliff_at: Optional[float]
    #: How large that drop is, in share-of-audience points.
    cliff_drop: Optional[float]
    points: int


def analyze_curve(video_id: str, curve: list) -> Optional[RetentionInsight]:
    """Turn one video's stored curve into an insight, or None when too thin.

    `curve` is the rows from `StateStore.retention_curve`, ordered through the
    video. A curve with almost no points describes nothing, so it produces
    nothing rather than a confident-looking number from two samples.
    """
    points = [
        (float(p["elapsed_ratio"]), float(p["watch_ratio"]))
        for p in (curve or [])
        if p.get("watch_ratio") is not None and p.get("elapsed_ratio") is not None
    ]
    if len(points) < MIN_POINTS:
        return None
    points.sort(key=lambda p: p[0])

    hook = None
    for ratio, watch in points:
        if ratio <= HOOK_RATIO:
            hook = watch
        else:
            break

    cliff_at, cliff_drop = None, 0.0
    for (ratio_a, watch_a), (_, watch_b) in zip(points, points[1:]):
        drop = watch_a - watch_b
        if drop > cliff_drop:
            cliff_drop, cliff_at = drop, ratio_a

    return RetentionInsight(
        video_id=video_id,
        hook_retention=round(hook, 4) if hook is not None else None,
        cliff_at=round(cliff_at, 4) if cliff_at is not None and cliff_drop >= MIN_CLIFF_DROP else None,
        cliff_drop=round(cliff_drop, 4) if cliff_drop >= MIN_CLIFF_DROP else None,
        points=len(points),
    )


class RetentionAnalyzer:
    """Reads stored curves for one channel and renders writer-facing context.

    Same dependency-injection shape as PerformanceAnalyzer: `state_store`
    defaults to the real one but accepts a fake, and every read degrades to
    empty rather than raising.
    """

    def __init__(self, state_store=None, channel_id: str | None = None):
        self.channel_id = channel_id
        if state_store is not None:
            self.state_store = state_store
        else:
            try:
                from modules.state_store import StateStore

                self.state_store = StateStore()
            except Exception:
                logger.warning(
                    "Failed to construct default StateStore; RetentionAnalyzer will "
                    "produce no retention context",
                    exc_info=True,
                )
                self.state_store = None

    def insights(self, limit: int = 20) -> list:
        """Insights for this channel's most recent videos that have a curve."""
        if self.state_store is None:
            return []
        try:
            videos = self.state_store.list_videos(limit=limit, channel_id=self.channel_id)
        except Exception:
            logger.warning("Failed to list videos for retention analysis", exc_info=True)
            return []

        out = []
        for video in videos:
            video_id = video.get("video_id")
            if not video_id:
                continue
            try:
                curve = self.state_store.retention_curve(video_id)
            except Exception:
                logger.warning("Failed reading retention curve for %s", video_id, exc_info=True)
                continue
            insight = analyze_curve(video_id, curve)
            if insight is not None:
                out.append(insight)
        return out

    def as_prompt_text(self, limit: int = 20) -> str:
        """Retention context for the script prompt, or "" when there is too
        little to say.

        Deliberately short and specific: one line about whether the hook holds,
        one about where people leave. A writer can act on both.
        """
        insights = self.insights(limit=limit)
        if len(insights) < MIN_CURVES:
            return ""

        hooks = [i.hook_retention for i in insights if i.hook_retention is not None]
        cliffs = [i.cliff_at for i in insights if i.cliff_at is not None]
        if not hooks:
            return ""

        mean_hook = sum(hooks) / len(hooks)
        lines = [
            f"Measured audience retention across this channel's last {len(insights)} video(s) "
            "(real YouTube data, not an estimate):",
            f"- {mean_hook:.0%} of viewers are still watching at the end of the hook "
            f"(first {HOOK_RATIO:.0%} of the video).",
        ]
        if cliffs:
            mean_cliff = sum(cliffs) / len(cliffs)
            lines.append(
                f"- The largest drop-off typically begins around {mean_cliff:.0%} through the video."
            )
            lines.append(
                "Write so that the section at that point earns its place: land an open loop or a "
                "reveal there rather than a recap."
            )
        if mean_hook < 0.7:
            lines.append(
                "The hook is losing most of the audience before the story starts — open harder and "
                "later in the action."
            )
        return "\n".join(lines)
