"""Re-package underperformers — spot published videos whose click-through is
well below what this channel normally earns, and flag them for a new title and
thumbnail.

The single biggest lever on a video that already exists is its packaging: the
title and thumbnail decide the click, and a video with a good topic but a weak
package quietly underperforms forever. YouTube itself rewards re-packaging — a
refreshed thumbnail on an old video routinely revives it. This module finds the
candidates; refreshing them is a human/Command-Center decision.

Two design rules the project holds everywhere:

- **Advisory, never automatic.** This only *identifies and reports* candidates
  (a `repackage.suggested` event). It never edits a live video's title or
  thumbnail on its own — changing what the audience already sees is a human
  call. Like `publish.score` and `niche.rpm`, it informs; it does not act.
- **Relative to the channel, and null ≠ 0.** "Underperforming" is measured
  against the channel's OWN median CTR, not a hardcoded number — channels differ
  in baseline, and the stored CTR's scale (fraction vs percent) must not matter.
  A video with unknown CTR is never called an underperformer (we don't invent a
  0 for missing data), and there must be enough measured videos to know what
  "normal" is before anything is flagged at all.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Optional

logger = logging.getLogger(__name__)

# A video younger than this hasn't had a fair chance yet; older than this and a
# repackage is rarely worth it. Both in days.
DEFAULT_MIN_AGE_DAYS = 7
DEFAULT_MAX_AGE_DAYS = 120
# Below this many impressions the CTR is too noisy to judge — not enough data.
DEFAULT_MIN_IMPRESSIONS = 500
# A video is a candidate when its CTR is below this fraction of the channel
# median. 0.6 = "noticeably below typical", not merely a hair under.
DEFAULT_RATIO = 0.6
# Need at least this many measured videos to establish a channel baseline. With
# fewer, there is no honest "normal" to compare against, so nothing is flagged.
DEFAULT_MIN_BASELINE = 3


@dataclass(frozen=True)
class RepackageCandidate:
    video_id: str
    title: str
    age_days: int
    views: Optional[int]
    impressions: Optional[int]
    ctr: float
    channel_median_ctr: float
    reason: str

    def to_dict(self) -> dict:
        return {
            "video_id": self.video_id,
            "title": self.title,
            "age_days": self.age_days,
            "views": self.views,
            "impressions": self.impressions,
            "ctr": self.ctr,
            "channel_median_ctr": self.channel_median_ctr,
            "reason": self.reason,
        }


def _parse_dt(value) -> Optional[datetime]:
    """Parse an ISO8601 timestamp to an aware UTC datetime, or None."""
    if not value:
        return None
    try:
        s = str(value).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _age_days(published_at, now: datetime) -> Optional[int]:
    dt = _parse_dt(published_at)
    if dt is None:
        return None
    return max(0, (now - dt).days)


def _num(value) -> Optional[float]:
    """A finite number, or None. Never coerces None/'' to 0 — a missing metric
    stays missing (null ≠ 0)."""
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def find_candidates(
    videos: list,
    metrics_by_id: dict,
    *,
    now: Optional[datetime] = None,
    min_age_days: int = DEFAULT_MIN_AGE_DAYS,
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
    min_impressions: int = DEFAULT_MIN_IMPRESSIONS,
    ratio: float = DEFAULT_RATIO,
    min_baseline: int = DEFAULT_MIN_BASELINE,
) -> list:
    """Return the underperforming long-form videos worth re-packaging, worst
    (lowest CTR) first.

    `videos` are StateStore video rows; `metrics_by_id` maps video_id → its
    latest metrics snapshot (or is missing/None when unmeasured). A video is
    eligible for the baseline (and for candidacy) only when it is long-form, old
    enough but not too old, and has a known CTR over enough impressions. If
    fewer than `min_baseline` videos clear that bar there is no channel norm to
    compare against and the result is empty — never a guess.
    """
    now = now or datetime.now(timezone.utc)

    eligible = []  # (video_row, ctr, impressions, views, age_days)
    for v in videos or []:
        if (v.get("video_format") or "long") == "short":
            continue  # a Short's packaging is a different game; not repackaged here
        age = _age_days(v.get("published_at"), now)
        if age is None or age < min_age_days or age > max_age_days:
            continue
        m = metrics_by_id.get(v.get("video_id")) if metrics_by_id else None
        ctr = _num(m.get("impression_ctr")) if m else None
        impressions = _num(m.get("impressions")) if m else None
        # null ≠ 0: an unmeasured video is not an underperformer, it is unknown.
        if ctr is None or impressions is None or impressions < min_impressions:
            continue
        views = _num(m.get("views")) if m else None
        eligible.append((v, ctr, impressions, views, age))

    if len(eligible) < min_baseline:
        return []

    channel_median = median(ctr for (_v, ctr, _i, _vw, _a) in eligible)
    if channel_median <= 0:
        return []  # a degenerate baseline can't define "below normal"

    threshold = ratio * channel_median
    candidates = []
    for (v, ctr, impressions, views, age) in eligible:
        if ctr < threshold:
            pct = round(100 * ctr / channel_median)
            candidates.append(RepackageCandidate(
                video_id=v.get("video_id", ""),
                title=v.get("title", ""),
                age_days=age,
                views=int(views) if views is not None else None,
                impressions=int(impressions),
                ctr=ctr,
                channel_median_ctr=channel_median,
                reason=(f"CTR is {pct}% of the channel median over {int(impressions)} "
                        f"impressions — a new title/thumbnail may lift it"),
            ))
    candidates.sort(key=lambda c: c.ctr)  # worst first
    return candidates


def summarize(candidates: list) -> dict:
    """A small metadata dict for a single roll-up event."""
    return {
        "count": len(candidates),
        "video_ids": [c.video_id for c in candidates],
        "worst": candidates[0].to_dict() if candidates else None,
    }
