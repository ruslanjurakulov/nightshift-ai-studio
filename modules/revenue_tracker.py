"""Revenue tracking — what each video actually earned (roadmap #71).

The project's objective is money, and until now nothing read it back: the
pipeline could measure views, CTR and retention, but never a dollar. This turns
YouTube Analytics' **estimatedRevenue** — the real figure Google reports to the
channel owner, in USD — into a per-video and per-channel picture, and a real
RPM (revenue per 1,000 views) computed from measured revenue over measured
views.

Three rules, all standing constraints of this project:

* **USD, and only USD.** estimatedRevenue is reported in USD; this module never
  invents a currency conversion. `currency` is always ``"USD"`` — a follow-up
  can localize for display, but the stored figure is the one the API gave.
* **null ≠ 0.** A video with no reported revenue — unmonetized, too new, outside
  YPP, or the monetary scope not granted — has ``revenue_usd = None``. Its
  earnings are *unknown*, not zero: it is excluded from totals and from RPM,
  never counted as a $0 earner that would drag an average down. A channel that
  reports no revenue at all yields a report with ``total_usd = None`` (and
  ``measured_count = 0``), which reads honestly as "not measured" rather than
  "earned nothing".
* **Advisory.** This computes a summary and emits ``revenue.tracked`` for a
  human/Command Center to read. It never gates a publish, changes niche
  selection, or spends — exactly like the publish score and niche RPM. It is
  pure: it touches no network and no disk, so it is fully testable offline.

The raw rows it consumes come from ``AnalyticsClient.video_revenue`` /
``channel_revenue`` (keys ``estimatedRevenue`` and ``views``). Feeding this
module's per-video revenue map into ``modules/niche_rpm.py`` (its
``revenue_by_video`` argument) so niche ranking uses real RPM is the intended
next step — kept separate because it needs the revenue persisted, which is a
later, deliberate decision.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

CURRENCY_USD = "USD"

#: The Analytics metric key that carries revenue, in USD.
REVENUE_KEY = "estimatedRevenue"
#: The views key paired with it, for the RPM denominator.
VIEWS_KEY = "views"

#: How many top earners the event summary lists (the full per-video list stays
#: on the report object; the event metadata is kept small).
_SUMMARY_TOP_N = 5


@dataclass(frozen=True)
class VideoRevenue:
    """One video's earnings. Every money/rate field is Optional: ``None`` means
    "not measured", which is never the same as a measured zero."""

    video_id: str
    revenue_usd: Optional[float] = None   # None = unknown earnings, never 0
    views: Optional[int] = None
    rpm_usd: Optional[float] = None       # revenue / views × 1000, when both known

    @property
    def measured(self) -> bool:
        return self.revenue_usd is not None

    def to_dict(self) -> dict:
        return {
            "video_id": self.video_id,
            "revenue_usd": self.revenue_usd,
            "views": self.views,
            "rpm_usd": self.rpm_usd,
        }


@dataclass(frozen=True)
class RevenueReport:
    """A channel's revenue picture, best-earner first. Totals are over the
    *measured* videos only; a video with unknown revenue is not a $0 earner."""

    videos: tuple = ()
    total_usd: Optional[float] = None       # sum over measured videos, None if none
    measured_count: int = 0
    video_count: int = 0
    channel_rpm_usd: Optional[float] = None  # total_usd / measured views × 1000
    currency: str = CURRENCY_USD

    @property
    def has_revenue(self) -> bool:
        return self.total_usd is not None

    @property
    def top_earner(self) -> Optional[VideoRevenue]:
        for v in self.videos:            # videos are sorted measured-first, desc
            if v.measured:
                return v
        return None

    def to_dict(self) -> dict:
        return {
            "videos": [v.to_dict() for v in self.videos],
            "total_usd": self.total_usd,
            "measured_count": self.measured_count,
            "video_count": self.video_count,
            "channel_rpm_usd": self.channel_rpm_usd,
            "currency": self.currency,
        }


def _num(value) -> Optional[float]:
    """Coerce to a finite float, or None. Empty string / None / non-numeric /
    inf / nan → None, so an unmeasured field never becomes 0.0. Negative
    revenue (which the API should never send) is also treated as unmeasured."""
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):   # nan / inf
        return None
    return f


def _int(value) -> Optional[int]:
    f = _num(value)
    return int(f) if f is not None else None


def revenue_from_row(row) -> Optional[float]:
    """The USD revenue in an Analytics revenue row, or None when absent.

    Guards against a negative value (never expected from the API) by treating it
    as unmeasured rather than as a real loss that would distort a total."""
    if not isinstance(row, dict):
        return None
    rev = _num(row.get(REVENUE_KEY))
    if rev is None or rev < 0:
        return None
    return round(rev, 6)


def _views_of(row, fallback) -> Optional[int]:
    """Views for a video: the revenue row's own ``views`` if present, else the
    fallback (a metrics dict carrying ``views``, or a bare number)."""
    if isinstance(row, dict):
        v = _int(row.get(VIEWS_KEY))
        if v is not None:
            return v
    if isinstance(fallback, dict):
        return _int(fallback.get(VIEWS_KEY))
    return _int(fallback)


def build_report(revenue_rows: dict, views_by_video: Optional[dict] = None) -> RevenueReport:
    """Turn ``{video_id: analytics_revenue_row}`` into a RevenueReport.

    * ``revenue_rows`` — video_id → the dict returned by
      ``AnalyticsClient.video_revenue`` (``estimatedRevenue``, ``views``). An
      empty dict / a row with no revenue key contributes an *unmeasured* video,
      not a zero.
    * ``views_by_video`` — optional video_id → views (a bare number or a metrics
      dict with ``views``), used only when a revenue row omits its own views, so
      RPM can still be computed from the metrics snapshot the poller already has.

    RPM is revenue / views × 1000, only when revenue is known and views > 0.
    Never raises: a malformed row is skipped and logged.
    """
    views_by_video = views_by_video or {}
    videos: list[VideoRevenue] = []
    for vid, row in (revenue_rows or {}).items():
        try:
            video_id = str(vid or "").strip()
            if not video_id:
                continue
            rev = revenue_from_row(row)
            views = _views_of(row, views_by_video.get(video_id))
            rpm = (rev / views * 1000.0) if (rev is not None and views and views > 0) else None
            videos.append(VideoRevenue(
                video_id=video_id,
                revenue_usd=rev,
                views=views,
                rpm_usd=round(rpm, 4) if rpm is not None else None,
            ))
        except Exception as e:  # one bad row must not sink the report
            logger.warning("Skipping a video in revenue tracking (%s: %s)", type(e).__name__, e)

    measured = [v for v in videos if v.measured]
    total_usd = round(sum(v.revenue_usd or 0.0 for v in measured), 6) if measured else None
    measured_views = sum(v.views for v in measured if v.views and v.views > 0)
    channel_rpm = (
        round(total_usd / measured_views * 1000.0, 4)
        if (total_usd is not None and measured_views > 0)
        else None
    )

    # Best-earner first: measured videos by revenue desc, then the unmeasured
    # (ordered by id) so the report lists everything without ranking a gap.
    videos.sort(key=lambda v: (v.measured, v.revenue_usd or 0.0, v.video_id), reverse=True)

    return RevenueReport(
        videos=tuple(videos),
        total_usd=total_usd,
        measured_count=len(measured),
        video_count=len(videos),
        channel_rpm_usd=channel_rpm,
        currency=CURRENCY_USD,
    )


def summarize(report: RevenueReport) -> dict:
    """Compact metadata for one ``revenue.tracked`` event: the totals and the
    top few earners, not every video (the full list can be large)."""
    top = [v.to_dict() for v in report.videos if v.measured][:_SUMMARY_TOP_N]
    return {
        "total_usd": report.total_usd,
        "channel_rpm_usd": report.channel_rpm_usd,
        "measured_count": report.measured_count,
        "video_count": report.video_count,
        "currency": report.currency,
        "top_earners": top,
    }
