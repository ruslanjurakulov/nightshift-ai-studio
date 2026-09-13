"""Publish-time optimizer — recommend the hour and weekday to publish, learned
from when THIS channel's best-performing videos went out.

Publishing into a dead slot wastes the crucial first-hour velocity YouTube uses
to decide whether to push a video. The right slot is the one where this
channel's own audience has historically shown up. This reads the channel's
publish history and its views, and recommends the hour-of-day and day-of-week
that correlate with the strongest performance.

The rules, matching the rest of the intelligence layer:

- **Performance as views-per-day, not raw views — so age can't fool it.** An old
  video has more total views simply for being old; dividing by its age in days
  gives a rate that is comparable across the catalogue. A video with unknown
  views contributes nothing (null ≠ 0), and a slot needs a minimum number of
  videos before it is trusted — one lucky upload does not crown an hour.
- **Advisory, and honest about timezone.** It emits a recommendation for the
  scheduler/human to use; it never reschedules or holds a run on its own. Times
  are computed in **UTC** (that is what the stored timestamps are); offsetting to
  the audience's local timezone is a follow-up, and the report says so.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_MIN_SAMPLES = 3

_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


@dataclass(frozen=True)
class TimingReport:
    best_hour_utc: Optional[int] = None
    best_weekday: Optional[int] = None          # 0=Mon … 6=Sun
    best_weekday_name: str = ""
    samples: int = 0
    hour_scores: dict = field(default_factory=dict)     # hour -> mean views/day
    weekday_scores: dict = field(default_factory=dict)  # weekday -> mean views/day
    timezone: str = "UTC"

    def to_dict(self) -> dict:
        return {
            "best_hour_utc": self.best_hour_utc,
            "best_weekday": self.best_weekday,
            "best_weekday_name": self.best_weekday_name,
            "samples": self.samples,
            "hour_scores": self.hour_scores,
            "weekday_scores": self.weekday_scores,
            "timezone": self.timezone,
        }

    @property
    def has_recommendation(self) -> bool:
        return self.best_hour_utc is not None or self.best_weekday is not None


def _parse_dt(value) -> Optional[datetime]:
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


def _num(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _best_bucket(buckets: dict, min_samples: int):
    """(key, mean) of the bucket with the highest mean among those meeting
    min_samples, plus the full {key: mean} map. Returns (None, {}) when none
    qualify."""
    qualified = {k: mean(vals) for k, vals in buckets.items() if len(vals) >= min_samples}
    if not qualified:
        return None, {}
    best = max(qualified, key=qualified.get)
    return best, {k: round(v, 3) for k, v in qualified.items()}


def analyze(
    videos: list,
    metrics_by_id: dict,
    *,
    now: Optional[datetime] = None,
    min_samples: int = DEFAULT_MIN_SAMPLES,
) -> TimingReport:
    """Recommend the publish hour (UTC) and weekday from the channel's history.

    Each long-form video with a parseable publish time and a known view count
    contributes its views-per-day to the hour bucket and the weekday bucket it
    was published in. The best hour and weekday are the highest-mean buckets that
    clear `min_samples`. Insufficient data → an empty report (no recommendation),
    never a guess."""
    now = now or datetime.now(timezone.utc)
    hour_buckets: dict = {}
    weekday_buckets: dict = {}
    samples = 0

    for v in videos or []:
        if (v.get("video_format") or "long") == "short":
            continue
        dt = _parse_dt(v.get("published_at"))
        if dt is None:
            continue
        m = metrics_by_id.get(v.get("video_id")) if metrics_by_id else None
        views = _num(m.get("views")) if m else None
        if views is None:            # null ≠ 0: unmeasured videos don't vote
            continue
        age_days = max(1.0, (now - dt).total_seconds() / 86400.0)
        vpd = views / age_days
        hour_buckets.setdefault(dt.hour, []).append(vpd)
        weekday_buckets.setdefault(dt.weekday(), []).append(vpd)
        samples += 1

    best_hour, hour_scores = _best_bucket(hour_buckets, min_samples)
    best_weekday, weekday_scores = _best_bucket(weekday_buckets, min_samples)
    return TimingReport(
        best_hour_utc=best_hour,
        best_weekday=best_weekday,
        best_weekday_name=_WEEKDAYS[best_weekday] if best_weekday is not None else "",
        samples=samples,
        hour_scores=hour_scores,
        weekday_scores=weekday_scores,
        timezone="UTC",
    )


def next_publish_slot(report: TimingReport, now: Optional[datetime] = None) -> Optional[datetime]:
    """The next UTC datetime that matches the report's recommended slot, at or
    after `now` — turning the advisory hour/weekday into a concrete "publish at".

    This is what lets a scheduler act on "publish when the audience is online":
    hand the returned datetime to YouTube's `status.publishAt` (scheduled
    upload) instead of publishing immediately. It stays advisory in spirit —
    the caller decides whether to schedule or publish now, and the pre-publish
    gate still runs either way.

    Returns None when there is no usable hour to target (no recommendation, or a
    weekday-only report), so the caller cleanly falls back to publishing now.
    Rules:
      * hour known, no weekday → the next occurrence of that hour (today if it
        is still ahead, else tomorrow);
      * hour + weekday known → the next occurrence of that weekday at that hour;
      * a slot exactly at or before `now` rolls forward, so the result is always
        strictly in the future.
    """
    if report is None or report.best_hour_utc is None:
        return None
    hour = int(report.best_hour_utc)
    if not (0 <= hour <= 23):
        return None

    now = now or datetime.now(timezone.utc)
    now = now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)

    weekday = report.best_weekday
    if weekday is None:
        candidate = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    days_ahead = (int(weekday) - now.weekday()) % 7
    candidate = (now + timedelta(days=days_ahead)).replace(
        hour=hour, minute=0, second=0, microsecond=0
    )
    if candidate <= now:
        candidate += timedelta(days=7)
    return candidate


def summarize(report: TimingReport) -> dict:
    """Metadata for a single advisory event."""
    return report.to_dict()
