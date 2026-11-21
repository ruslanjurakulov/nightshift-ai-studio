"""Adaptive strategy — what a channel should emphasise changes as it grows.

A brand-new channel and a channel with a year of history should not be written
the same way. A launch channel needs broad-appeal, proven formats and the
strongest possible hooks to earn its first audience; a growing channel should
double down on what is already working and build bingeable series; an
established channel can afford depth and a signature angle its subscribers came
for. This maps a channel's own scale (how many videos it has published, and how
old it is) to a short strategy note that is appended to the script prompt.

Rules, matching the rest of the pipeline:

- **Advisory prompt text, degrade-safe.** It only ever ADDS a guidance paragraph
  to the writer's prompt; it never replaces the channel's own strategy or the
  shared retention rules, and an unknown/zero scale yields the launch note (the
  safe default for a channel we know nothing about) — never an empty gap that
  silently changes nothing about how a new channel is treated.
- **Pure and deterministic.** Scale in → the same phase and note out; no state,
  no network, fully unit-testable.
"""

from __future__ import annotations

from typing import Optional

PHASE_LAUNCH = "launch"
PHASE_GROWTH = "growth"
PHASE_AUTHORITY = "authority"

# Thresholds. A channel is in launch until it has both a handful of videos and a
# few weeks of history; growth until it is well-established; authority after.
LAUNCH_MAX_VIDEOS = 10
LAUNCH_MAX_AGE_DAYS = 30
GROWTH_MAX_VIDEOS = 100
GROWTH_MAX_AGE_DAYS = 180

_FRAGMENTS = {
    PHASE_LAUNCH: (
        "Channel stage: LAUNCH (few videos so far). Prioritise the broadest-appeal "
        "angle on this topic and the strongest possible hook in the first line — the "
        "goal is to earn a first audience, so favour proven, accessible framing over "
        "niche depth."
    ),
    PHASE_GROWTH: (
        "Channel stage: GROWTH. Double down on what is already working for this "
        "channel and build toward a bingeable, consistent style — reinforce the "
        "channel's recurring angle rather than experimenting widely."
    ),
    PHASE_AUTHORITY: (
        "Channel stage: AUTHORITY (established). Subscribers came for this channel's "
        "signature take, so lead with depth and a distinctive angle only this channel "
        "would bring; a strong hook still matters, but you can trade some breadth for "
        "the authoritative treatment the audience expects."
    ),
}


def phase_for(published_count, age_days: Optional[float] = None) -> str:
    """The lifecycle phase for a channel of this scale.

    A channel is only past a stage once it has cleared BOTH the video-count and
    (when known) the age bar for it — a channel that posted 50 videos in its
    first week is still finding its footing, and a year-old channel with 5 videos
    still needs launch-stage broad appeal. Unknown/zero scale → launch."""
    try:
        videos = int(published_count)
    except (TypeError, ValueError):
        videos = 0
    if videos < 0:
        videos = 0

    def old_enough(bar: float) -> bool:
        # Age gates only when known; without an age we judge on video count alone.
        return age_days is None or age_days >= bar

    if videos < LAUNCH_MAX_VIDEOS or not old_enough(LAUNCH_MAX_AGE_DAYS):
        return PHASE_LAUNCH
    if videos < GROWTH_MAX_VIDEOS or not old_enough(GROWTH_MAX_AGE_DAYS):
        return PHASE_GROWTH
    return PHASE_AUTHORITY


def strategy_fragment(phase: str) -> str:
    """The prompt note for a phase, or "" for an unrecognised phase."""
    return _FRAGMENTS.get(phase, "")


def adaptive_strategy(published_count, age_days: Optional[float] = None) -> str:
    """The strategy note to append to a script prompt for a channel of this
    scale. Never empty for a real scale (a new channel gets the launch note)."""
    return strategy_fragment(phase_for(published_count, age_days))
