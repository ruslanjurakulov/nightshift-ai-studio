"""Sponsorship pricing — what one integrated sponsor slot on this channel is
worth (roadmap #72).

Direct ad revenue (AdSense) is small on a young channel; a sponsor reading an
integration into the video is the realistic path to the revenue goal. The one
number that conversation needs is a *price*, and sponsors price the way media
buyers everywhere do — a **CPM** (cost per 1,000 views) against the channel's
real reach:

    price_usd = average_views_per_video / 1000 × sponsorship_cpm_usd

The rules match the rest of the money layer:

* **USD only.** No invented currency conversion.
* **The CPM is operator-configured** (``CHRONOS_SPONSORSHIP_CPM_USD``). With no
  rate set, ``price_usd`` is ``None`` — "rate unset", shown honestly — never a
  guessed sponsorship CPM. A made-up price is worse than no price: someone would
  quote it to a real sponsor.
* **null ≠ 0.** Average views is computed only over videos with a *known* view
  count; a video with unmeasured views contributes nothing (it is not a 0-view
  video). A channel with no measured views yields ``average_views = None`` and
  ``price_usd = None`` — "not enough data", never $0. And a slot needs a minimum
  number of measured videos before a price is offered — one upload is not reach.
* **Advisory.** It emits ``sponsorship.estimate`` for a human to use in an
  actual negotiation. It never contacts a sponsor, sells a slot, or commits to a
  price. Pure — no network, no disk.

Only long-form videos count toward reach: a Short's view count is a different
audience and a different product from the integrated slot being priced.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

#: Env var carrying the sponsorship CPM in USD per 1,000 views. Distinct from
#: the AdSense RPM the channel *earns* — this is what a sponsor *pays*, which is
#: typically many times higher, so it is a separate, deliberately-set rate.
_CPM_ENV = "CHRONOS_SPONSORSHIP_CPM_USD"

#: Measured videos required before a price is offered — one upload is not reach.
DEFAULT_MIN_VIDEOS = 3


def sponsorship_cpm() -> Optional[float]:
    """The configured sponsorship CPM (USD per 1,000 views), or None when the
    operator has not set one. None is a real answer — "we do not claim a rate" —
    and callers must not substitute 0."""
    raw = os.getenv(_CPM_ENV, "").strip()
    if not raw:
        return None
    try:
        cpm = float(raw)
    except ValueError:
        logger.warning(
            "Ignoring %s=%r — not a number, so no sponsorship price is offered "
            "rather than a wrong one", _CPM_ENV, raw,
        )
        return None
    return cpm if cpm >= 0 else None


@dataclass(frozen=True)
class SponsorshipEstimate:
    """A suggested price for one integrated sponsor slot. Every money field is
    Optional: ``None`` means "not enough data / rate unset", never a measured 0."""

    average_views: Optional[float] = None   # over measured long-form videos
    measured_videos: int = 0
    cpm_usd: Optional[float] = None          # the configured sponsorship CPM
    price_usd: Optional[float] = None        # avg_views/1000 × cpm, when both known
    currency: str = "USD"
    reason: str = ""

    @property
    def has_price(self) -> bool:
        return self.price_usd is not None

    def to_dict(self) -> dict:
        return {
            "average_views": self.average_views,
            "measured_videos": self.measured_videos,
            "cpm_usd": self.cpm_usd,
            "price_usd": self.price_usd,
            "currency": self.currency,
            "reason": self.reason,
        }


def _num(value) -> Optional[float]:
    """Coerce to a finite, non-negative float, or None. Empty / None /
    non-numeric / inf / nan / negative → None, so an unmeasured or nonsensical
    view count never becomes 0.0."""
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")) or f < 0:
        return None
    return f


def average_long_form_views(videos: list, metrics_by_video: dict) -> tuple[Optional[float], int]:
    """Mean views over the channel's long-form videos that have a KNOWN view
    count, plus how many contributed. A Short is excluded (different product); a
    video with unmeasured views is skipped (null ≠ 0). Returns (None, 0) when
    nothing is measurable."""
    views: list[float] = []
    for v in videos or []:
        if (v.get("video_format") or "long") == "short":
            continue
        m = metrics_by_video.get(v.get("video_id")) if metrics_by_video else None
        n = _num(m.get("views")) if isinstance(m, dict) else None
        if n is None:            # unmeasured — contributes nothing, not a 0
            continue
        views.append(n)
    if not views:
        return None, 0
    return sum(views) / len(views), len(views)


def estimate(
    videos: list,
    metrics_by_video: dict,
    *,
    cpm_usd: Optional[float] = None,
    min_videos: int = DEFAULT_MIN_VIDEOS,
) -> SponsorshipEstimate:
    """Price one integrated sponsor slot from the channel's measured reach.

    ``cpm_usd`` defaults to the operator-configured rate; pass it explicitly to
    model a specific offer. A price is produced only when a rate is set AND at
    least ``min_videos`` long-form videos have a known view count — otherwise
    the estimate carries ``price_usd = None`` and a reason, never a guess.
    """
    cpm = cpm_usd if cpm_usd is not None else sponsorship_cpm()
    avg_views, measured = average_long_form_views(videos, metrics_by_video)

    if avg_views is None or measured < max(1, min_videos):
        return SponsorshipEstimate(
            average_views=avg_views, measured_videos=measured, cpm_usd=cpm,
            reason=(
                f"needs {min_videos} long-form videos with known views; "
                f"have {measured}"
            ),
        )
    if cpm is None:
        return SponsorshipEstimate(
            average_views=round(avg_views, 1), measured_videos=measured, cpm_usd=None,
            reason=f"set {_CPM_ENV} to price a slot; reach is {avg_views:.0f} avg views",
        )

    price = round(avg_views / 1000.0 * cpm, 2)
    return SponsorshipEstimate(
        average_views=round(avg_views, 1),
        measured_videos=measured,
        cpm_usd=cpm,
        price_usd=price,
        reason=f"${cpm:.2f} CPM × {avg_views:.0f} avg views over {measured} video(s)",
    )


def summarize(est: SponsorshipEstimate) -> dict:
    """Metadata for a single ``sponsorship.estimate`` event."""
    return est.to_dict()
