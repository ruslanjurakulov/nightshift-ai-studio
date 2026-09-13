"""First-30-seconds (hook) A/B — decided on retention, not click-through.

Why a separate module from ab_testing.py
-----------------------------------------
The thumbnail/title A/B is judged on impression CTR — the lever that decides
whether someone *clicks*. The opening hook is a different lever: it decides
whether someone who clicked *stays*. So it is judged on a retention signal
(`average_view_duration_seconds`, the same honest proxy feedback_engine and
retention_analyzer already use), never on CTR. Same discipline otherwise: strict
alternation until there is evidence, then lean to the winner while still
exploring, and never name a winner below `MIN_PER_VARIANT` measured videos or
below `MIN_LIFT` relative difference.

Scope note
----------
This is the selection + readback layer. Making it live end-to-end also needs
(a) a `hook_variant` column on the videos table (a migration), (b) the script
engine producing a second opening, and (c) the render shipping the chosen hook —
and a real render to validate. Those are a deliberate follow-up; this layer,
pure and fully unit-tested, is shipped first (as broll_match and the quota
allocator were), reusing the ab_testing thresholds so the two experiments stay
in step.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from modules.ab_testing import EXPLORE_EVERY, MIN_LIFT, MIN_PER_VARIANT, VARIANT_A, VARIANT_B

#: The metrics-snapshot field that stands in for early retention. Seconds a
#: viewer stays on average — unknown (None) when unpolled, never assumed zero.
RETENTION_FIELD = "average_view_duration_seconds"


@dataclass(frozen=True)
class HookStats:
    variant: str
    videos: int
    #: Mean retention seconds across measured videos, or None when none measured.
    mean_retention_seconds: Optional[float]


@dataclass(frozen=True)
class HookResult:
    a: HookStats
    b: HookStats
    #: "A", "B", or None — None means "not enough evidence", never a tie.
    winner: Optional[str]
    reason: str

    @property
    def decided(self) -> bool:
        return self.winner is not None


def choose_hook(published_count: int, result: Optional[HookResult] = None) -> str:
    """Which opening the next video should ship. Strict alternation until a
    verdict, then lean to the winner while keeping one in `EXPLORE_EVERY` on the
    challenger — a hook that stops working must be able to lose its crown."""
    try:
        count = int(published_count)
    except (TypeError, ValueError):
        count = 0
    if count < 0:
        count = 0

    if result is None or not result.decided:
        return VARIANT_A if count % 2 == 0 else VARIANT_B

    explore = count % EXPLORE_EVERY == (EXPLORE_EVERY - 1)
    loser = VARIANT_B if result.winner == VARIANT_A else VARIANT_A
    return loser if explore else str(result.winner)


def hook_performance(videos: list, snapshots: list) -> HookResult:
    """Compare the two hooks on real retention, or say there isn't enough.

    `videos` carry `hook_variant`; `snapshots` carry `average_view_duration_seconds`.
    Latest snapshot per video only; a video with no measured retention is
    excluded (unknown), never counted as zero seconds.
    """
    latest: dict = {}
    for snap in snapshots or []:
        video_id = snap.get("video_id")
        if not video_id:
            continue
        seen = latest.get(video_id)
        if seen is None or str(snap.get("snapshot_date", "")) > str(seen.get("snapshot_date", "")):
            latest[video_id] = snap

    buckets: dict = {VARIANT_A: [], VARIANT_B: []}
    for video in videos or []:
        variant = (video.get("hook_variant") or "").upper()
        if variant not in buckets:
            continue
        snap = latest.get(video.get("video_id"))
        if not snap:
            continue
        retention = snap.get(RETENTION_FIELD)
        if retention is None:
            continue  # measured views but no retention figure — unknown, not zero
        buckets[variant].append(float(retention))

    stats = {v: _stats(v, rows) for v, rows in buckets.items()}
    a, b = stats[VARIANT_A], stats[VARIANT_B]

    if a.videos < MIN_PER_VARIANT or b.videos < MIN_PER_VARIANT:
        return HookResult(
            a=a, b=b, winner=None,
            reason=(
                f"needs {MIN_PER_VARIANT} measured videos per hook; "
                f"A has {a.videos}, B has {b.videos}"
            ),
        )
    if a.mean_retention_seconds is None or b.mean_retention_seconds is None:
        return HookResult(a=a, b=b, winner=None, reason="no retention measured yet")

    high = max(a.mean_retention_seconds, b.mean_retention_seconds)
    low = min(a.mean_retention_seconds, b.mean_retention_seconds)
    if low <= 0:
        return HookResult(a=a, b=b, winner=None, reason="a hook measured zero retention")
    lift = (high - low) / low
    if lift < MIN_LIFT:
        return HookResult(
            a=a, b=b, winner=None,
            reason=f"only {lift:.0%} apart; under the {MIN_LIFT:.0%} floor this is a tie",
        )

    winner = VARIANT_A if a.mean_retention_seconds >= b.mean_retention_seconds else VARIANT_B
    return HookResult(
        a=a, b=b, winner=winner,
        reason=f"hook {winner} holds viewers {lift:.0%} longer over {a.videos + b.videos} measured videos",
    )


def _stats(variant: str, rows: list) -> HookStats:
    if not rows:
        return HookStats(variant=variant, videos=0, mean_retention_seconds=None)
    return HookStats(
        variant=variant,
        videos=len(rows),
        mean_retention_seconds=round(sum(rows) / len(rows), 3),
    )
