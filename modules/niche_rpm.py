"""Niche RPM intelligence — which niche is actually worth making videos in.

The single highest-value decision the studio makes is *what to make a video
about*. This module ranks the niches the system has already published in by how
they have actually performed, so that decision can be informed by measured
results instead of a guess.

What it will and will not claim
-------------------------------
Two hard rules, both the project's standing constraints:

* **RPM (revenue per 1,000 views) is reported only when revenue is supplied.**
  Nightshift has no monetary scope yet (see roadmap #71), so unless a caller
  passes real per-video revenue, ``rpm_usd`` is ``None`` — "not measured",
  never a fabricated 0.0. A niche with no revenue data is not a niche that
  earns nothing; it is a niche whose earnings are unknown.
* **An absent signal is ``None``, not zero.** A niche with no views data has
  ``avg_views=None``. The overall ``score`` is ``None`` when *nothing*
  measurable exists for a niche — such a niche ranks as "insufficient data",
  it does not lose to a niche that measured badly.

This module is **advisory**. It computes a ranking and never changes niche
selection on its own — wiring a run to prefer the top niche is a later, separate
decision, exactly as the publish score is advisory to the gate. Nothing here
publishes, spends, or overrides the niche precedence in modules/series.py.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NicheSignal:
    """What is measured for one niche. Every performance figure is Optional:
    ``None`` means "not enough data", distinct from a measured low value."""

    niche: str
    video_count: int
    avg_views: Optional[float] = None
    avg_ctr: Optional[float] = None            # impression CTR, 0..1
    rpm_usd: Optional[float] = None            # only when revenue is supplied
    revenue_usd: Optional[float] = None        # summed, only when supplied
    score: Optional[float] = None              # 0..1 composite, None if no signal

    @property
    def has_signal(self) -> bool:
        return self.score is not None

    def to_dict(self) -> dict:
        return {
            "niche": self.niche,
            "video_count": self.video_count,
            "avg_views": self.avg_views,
            "avg_ctr": self.avg_ctr,
            "rpm_usd": self.rpm_usd,
            "revenue_usd": self.revenue_usd,
            "score": self.score,
        }


def _mean(values: list[float]) -> Optional[float]:
    """Mean of the present values, or None when there are none. `None` entries
    are skipped rather than counted as zero."""
    present = [v for v in values if v is not None]
    return sum(present) / len(present) if present else None


def _normalize(value: Optional[float], lo: float, hi: float) -> Optional[float]:
    """Scale `value` into 0..1 given the observed [lo, hi] range. None in →
    None out. A flat range (hi == lo) maps every present value to 0.5 — no
    niche is favoured on a dimension that did not vary."""
    if value is None:
        return None
    if hi <= lo:
        return 0.5
    return max(0.0, min(1.0, (value - lo) / (hi - lo)))


def evaluate_niches(
    videos: list[dict],
    metrics_by_video: dict,
    niche_of_video: Callable[[dict], Optional[str]],
    revenue_by_video: Optional[dict] = None,
) -> dict:
    """Aggregate published videos into a per-niche picture.

    * ``videos`` — rows with at least ``video_id``.
    * ``metrics_by_video`` — video_id → a metrics dict (views, impression_ctr,
      …) or None. A missing/None entry contributes no signal, never a zero.
    * ``niche_of_video`` — resolves a video row to its niche (the caller maps
      through the channel registry, since videos are stored per channel). A
      video whose niche can't be resolved is skipped.
    * ``revenue_by_video`` — optional video_id → USD. Only when present does a
      niche get an ``rpm_usd``; otherwise it stays None ("not measured").

    Returns niche → NicheSignal. Never raises: a bad row is skipped and logged.
    """
    buckets: dict[str, dict] = {}
    for row in videos or []:
        try:
            vid = str(row.get("video_id") or "").strip()
            if not vid:
                continue
            niche = niche_of_video(row)
            if not niche:
                continue
            b = buckets.setdefault(niche, {"count": 0, "views": [], "ctr": [], "revenue": [], "rev_views": []})
            b["count"] += 1
            metrics = metrics_by_video.get(vid) if metrics_by_video else None
            views = _num(metrics.get("views")) if isinstance(metrics, dict) else None
            ctr = _num(metrics.get("impression_ctr")) if isinstance(metrics, dict) else None
            b["views"].append(views)
            b["ctr"].append(ctr)
            if revenue_by_video and vid in revenue_by_video:
                rev = _num(revenue_by_video.get(vid))
                if rev is not None:
                    b["revenue"].append(rev)
                    # Views paired with this revenue, for a real RPM denominator.
                    if views is not None:
                        b["rev_views"].append(views)
        except Exception as e:  # one malformed row must not sink the ranking
            logger.warning("Skipping a video in niche RPM aggregation (%s: %s)", type(e).__name__, e)

    # First pass: per-niche raw aggregates.
    raw: dict[str, dict] = {}
    for niche, b in buckets.items():
        avg_views = _mean(b["views"])
        avg_ctr = _mean(b["ctr"])
        revenue_sum = sum(b["revenue"]) if b["revenue"] else None
        rev_views_sum = sum(b["rev_views"]) if b["rev_views"] else 0
        rpm = (revenue_sum / rev_views_sum * 1000.0) if (revenue_sum is not None and rev_views_sum > 0) else None
        raw[niche] = {
            "count": b["count"], "avg_views": avg_views, "avg_ctr": avg_ctr,
            "revenue_sum": revenue_sum, "rpm": rpm,
        }

    # Second pass: normalize each dimension across niches, then score.
    views_vals = [r["avg_views"] for r in raw.values() if r["avg_views"] is not None]
    rpm_vals = [r["rpm"] for r in raw.values() if r["rpm"] is not None]
    v_lo, v_hi = (min(views_vals), max(views_vals)) if views_vals else (0.0, 0.0)
    r_lo, r_hi = (min(rpm_vals), max(rpm_vals)) if rpm_vals else (0.0, 0.0)

    signals: dict[str, NicheSignal] = {}
    for niche, r in raw.items():
        # RPM, where known, is the point of the exercise, so it dominates;
        # CTR and views inform when revenue is absent. Only dimensions that
        # actually have a value contribute — a None never counts as 0.
        parts: list[tuple[float, float]] = []  # (weight, normalized 0..1)
        n_rpm = _normalize(r["rpm"], r_lo, r_hi)
        n_views = _normalize(r["avg_views"], v_lo, v_hi)
        n_ctr = r["avg_ctr"] if r["avg_ctr"] is not None else None  # already 0..1
        if n_rpm is not None:
            parts.append((0.6, n_rpm))
        if n_ctr is not None:
            parts.append((0.25, min(1.0, max(0.0, n_ctr))))
        if n_views is not None:
            parts.append((0.15, n_views))
        score = (sum(w * v for w, v in parts) / sum(w for w, _ in parts)) if parts else None
        signals[niche] = NicheSignal(
            niche=niche, video_count=r["count"], avg_views=r["avg_views"],
            avg_ctr=r["avg_ctr"], rpm_usd=r["rpm"], revenue_usd=r["revenue_sum"],
            score=score,
        )
    return signals


def rank_niches(signals: dict) -> list:
    """Niches ordered best-first, in three honest tiers:

      2. **Measured earnings** — a real ``rpm_usd`` (revenue was supplied),
         sorted by RPM. Because the objective is money, a niche we KNOW earns
         outranks one we only know gets views — that is the whole point.
      1. **Engagement only** — a ``score`` from views/CTR but no revenue data,
         sorted by score.
      0. **Insufficient data** — no signal at all, sorted by sample size then
         name. "Unknown", never "worst".

    Comparing a revenue niche against a views-only niche is apples-to-oranges;
    tiering makes that explicit instead of hiding it inside one number that a
    lone RPM would wash out to neutral."""
    def key(s: NicheSignal):
        if s.rpm_usd is not None:
            tier, primary = 2, s.rpm_usd
        elif s.score is not None:
            tier, primary = 1, s.score
        else:
            tier, primary = 0, 0.0
        return (tier, primary, s.video_count, s.niche)

    return sorted(signals.values(), key=key, reverse=True)


def recommend_niche(signals: dict, *, min_videos: int = 3) -> Optional[str]:
    """The best niche backed by at least `min_videos` measured videos, or None.

    None is the honest answer when nothing has enough data behind it — the
    caller then keeps its existing niche choice rather than acting on noise. A
    single strong-looking video is not a trend."""
    ranked = [s for s in rank_niches(signals) if s.has_signal and s.video_count >= max(1, min_videos)]
    return ranked[0].niche if ranked else None


def tier_of(signal: NicheSignal) -> int:
    """The honest tier a niche ranks in: 2 = measured earnings (a real RPM),
    1 = engagement only (views/CTR, no revenue), 0 = insufficient data. Mirrors
    the tiering in `rank_niches` so the Command Center can label each niche the
    same way the ranking sorts them."""
    if signal.rpm_usd is not None:
        return 2
    if signal.score is not None:
        return 1
    return 0


def evaluate_by_channel_niche(
    videos: list,
    metrics_by_video: dict,
    channel_niche: dict,
    revenue_by_video: Optional[dict] = None,
) -> dict:
    """Convenience wrapper over `evaluate_niches` for the cross-channel case,
    where a video's niche is its channel's niche.

    ``channel_niche`` maps channel_id -> niche. A video whose channel is not in
    the map (or maps to an empty niche) is skipped, exactly as an unresolved
    niche is skipped in `evaluate_niches`. This is the aggregation the roadmap's
    niche-RPM decision needs: niches live at the channel level, so ranking them
    means bucketing every channel's videos by the niche its channel runs."""
    def niche_of(video: dict) -> Optional[str]:
        return (channel_niche or {}).get(video.get("channel_id")) or None

    return evaluate_niches(videos, metrics_by_video, niche_of, revenue_by_video=revenue_by_video)


def summarize(signals: dict, *, top_n: int = 8) -> dict:
    """Metadata for a single `niche.rpm` advisory event: the ranked niches
    (best first, each tagged with its tier), the recommended niche, and honest
    counts. Capped to `top_n` so the event stays small."""
    ranked = rank_niches(signals)
    return {
        "niches": [{**s.to_dict(), "tier": tier_of(s)} for s in ranked[:top_n]],
        "best_niche": recommend_niche(signals),
        "measured_count": sum(1 for s in signals.values() if s.has_signal),
        "niche_count": len(signals),
    }


def _num(value) -> Optional[float]:
    """Coerce to float, or None. Empty string / None / non-numeric → None, so an
    unmeasured field never becomes 0.0."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
