"""Viral Remix — pick the most compelling moments and schedule them (roadmap #43).

`modules/remix.py` is the gatekeeper: it says whether a source may be remixed at
all, from the rights the operator asserts, and refuses anything with no basis.
This module is the layer on top: given an ELIGIBLE source and its
transcript/scene segments, it selects the few moments most likely to hold a
Shorts viewer and lays them out on a publishing cadence (e.g. one every 12
hours), so a "best fantastic-film moments" or "useful podcast cut" channel posts
a planned sequence rather than a random dump.

The boundaries, unchanged from remix.py:

- **It runs only for a rights-clean source.** `plan_shorts` calls
  `remix.build_plan` first; a source with no asserted rights basis yields
  ``None`` (blocked) and no segments are produced. This module never assumes a
  right, never downloads, never renders, never uploads — it plans.
- **null ≠ 0.** A segment's ``score`` is the caller's impact signal (retention,
  replays, an emphasis heuristic — whatever the caller measured). A segment with
  an unknown score is ranked *below* any measured one, never treated as a
  measured zero.
- **Sized for Shorts.** Only segments that fit the clip-length window are
  eligible, and picked segments never overlap, so the sequence is a set of
  distinct moments, not the same beat twice.

Executing the plan — cutting the clips and actually scheduling the uploads —
stays with the pipeline, exactly as remix.py's plan does; this is the pure,
testable decision layer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from modules import remix

#: A Short is short: clips outside this window are not considered (a 3-second
#: fragment has no room to land; a 90-second one is not a Short).
SHORTS_MIN_SECONDS = 8.0
SHORTS_MAX_SECONDS = 60.0

#: Default cadence between scheduled Shorts, in hours.
DEFAULT_INTERVAL_HOURS = 12


@dataclass(frozen=True)
class SourceSegment:
    """One candidate moment from the source: a start/end (seconds into the
    source) and its text, plus an optional impact ``score`` the caller measured.
    ``score`` is Optional so an unmeasured segment stays 'unknown', not 0."""

    start: float
    end: float
    text: str = ""
    score: Optional[float] = None

    @property
    def length(self) -> float:
        return round(max(0.0, self.end - self.start), 3)

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end, "text": self.text,
                "length": self.length, "score": self.score}


@dataclass(frozen=True)
class ScheduledClip:
    """A selected moment placed in the sequence: its rank (0 = strongest), the
    segment, and when to publish it (UTC ISO string)."""

    sequence: int
    segment: SourceSegment
    publish_at: str

    def to_dict(self) -> dict:
        return {"sequence": self.sequence, "publish_at": self.publish_at,
                **self.segment.to_dict()}


@dataclass(frozen=True)
class RemixShortsPlan:
    """An eligible remix plan plus the scheduled clips it should produce."""

    base: dict                              # remix.RemixPlan.to_dict()
    clips: tuple = ()                       # ScheduledClip, strongest first
    interval_hours: int = DEFAULT_INTERVAL_HOURS

    @property
    def clip_count(self) -> int:
        return len(self.clips)

    def to_dict(self) -> dict:
        return {
            "base": self.base,
            "interval_hours": self.interval_hours,
            "clip_count": self.clip_count,
            "clips": [c.to_dict() for c in self.clips],
        }


def _fits(seg: SourceSegment) -> bool:
    return SHORTS_MIN_SECONDS <= seg.length <= SHORTS_MAX_SECONDS


def _overlaps(a: SourceSegment, b: SourceSegment) -> bool:
    return a.start < b.end and b.start < a.end


def select_segments(segments: List[SourceSegment], *, max_clips: int) -> List[SourceSegment]:
    """The strongest non-overlapping, Shorts-sized moments, best first.

    Ranked by measured impact (``score`` desc; an unmeasured segment ranks below
    every measured one — null ≠ 0), then by length and earliest start as tie-
    breakers. Greedy: the strongest segment is taken, then the next strongest
    that doesn't overlap it, up to ``max_clips``. Returns [] when nothing fits or
    the budget is non-positive."""
    if max_clips <= 0:
        return []
    eligible = [s for s in (segments or []) if _fits(s)]
    if not eligible:
        return []

    def rank_key(s: SourceSegment):
        measured = s.score is not None
        return (measured, s.score if measured else 0.0, s.length, -s.start)

    ranked = sorted(eligible, key=rank_key, reverse=True)
    chosen: List[SourceSegment] = []
    for seg in ranked:
        if any(_overlaps(seg, c) for c in chosen):
            continue
        chosen.append(seg)
        if len(chosen) >= max_clips:
            break
    return chosen


def _as_utc(dt: Optional[datetime]) -> datetime:
    if dt is None:
        return datetime.now(timezone.utc)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def schedule_clips(selected: List[SourceSegment], *, start_time: Optional[datetime] = None,
                   interval_hours: int = DEFAULT_INTERVAL_HOURS) -> List[ScheduledClip]:
    """Place the selected moments on a cadence: the strongest goes out first (at
    ``start_time``, default now), the next one ``interval_hours`` later, and so
    on. A non-positive interval collapses to publishing them all at once, which a
    caller can detect and reject — the honest result rather than a silent gap."""
    base = _as_utc(start_time)
    step = max(0, int(interval_hours))
    clips: List[ScheduledClip] = []
    for i, seg in enumerate(selected or []):
        when = base + timedelta(hours=step * i)
        clips.append(ScheduledClip(sequence=i, segment=seg, publish_at=when.isoformat()))
    return clips


def plan_shorts(
    source: remix.RemixSource,
    mode: str,
    segments: List[SourceSegment],
    *,
    max_clips: int = 3,
    start_time: Optional[datetime] = None,
    interval_hours: int = DEFAULT_INTERVAL_HOURS,
) -> Optional[RemixShortsPlan]:
    """A scheduled-Shorts remix plan for an ELIGIBLE source, or ``None`` when the
    source is blocked for rights (delegated to ``remix.build_plan``).

    Selects the strongest Shorts-sized moments and schedules them on the cadence.
    Produces a plan only — no download, no render, no upload — and the plan's
    output still faces the pre-publish gate, exactly as ``remix.build_plan`` says.
    """
    base_plan = remix.build_plan(source, mode)
    if base_plan is None:
        return None
    selected = select_segments(segments, max_clips=max_clips)
    clips = schedule_clips(selected, start_time=start_time, interval_hours=interval_hours)
    return RemixShortsPlan(base=base_plan.to_dict(), clips=tuple(clips), interval_hours=int(interval_hours))


def summarize(plan: RemixShortsPlan) -> dict:
    """Metadata for a ``remix.planned`` event."""
    return plan.to_dict()
