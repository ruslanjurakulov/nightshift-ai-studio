"""Retention diagnosis — which LEVER the audience curve points at.

``retention_analyzer`` says *how much* of the hook survives and where the
biggest drop is; ``scene_retention`` says *which scene* loses viewers fastest.
Neither says what to change. A writer fixes a hook by rewriting it, fixes a slide
by cutting, fixes a cliff by repairing one scene — and when viewers who click
stay to the end, no edit helps: the title and thumbnail promise is the lever.
This module reads one video's curve and routes to exactly one of those.

Three separate problems, measured separately
--------------------------------------------
* **Hook leak.** Share of the audience lost in the first ``HOOK_WINDOW_S`` (30)
  ABSOLUTE seconds. Absolute on purpose: ``retention_analyzer.HOOK_RATIO`` is 10%
  of the video (60 s of a 10-minute video, 3 minutes of a 30-minute one), which
  stops describing "the hook" as videos get long. That constant is left alone —
  prompts and learnings depend on it — and this is reported beside it.
  ``hook_loss`` is in audience points (0.25 = a quarter of ALL starting viewers
  left); ``hook_loss_share`` is the same loss as a share of the viewers still
  watching where the window starts, and is what the thresholds read.
* **Cliffs.** The ``TOP_CLIFFS`` steepest single steps between adjacent measured
  points (see below), each with the scene it falls in and a short excerpt.
* **Slide.** The average loss through the middle of the video: from the end of
  the hook window to the start of the last ``SLIDE_TAIL_FRACTION`` (20%) of the
  video. ``slide_per_min`` is audience points lost per minute across that span;
  ``slide_per_tenth`` is the same loss per 10% of the video's length, and is what
  the thresholds read, because per minute a 60-minute video would always look
  flat next to a 5-minute one. It is an endpoint average — ``(R(30 s) -
  R(80%)) / span`` — not a fit, and negative when the curve rises (rewatches).

Verdict (closed set, first rule that holds)
-------------------------------------------
1. ``insufficient_data`` when there is no usable curve or no known duration.
2. ``hook`` — ``hook_loss_share >= HOOK_STEEP_MIN_LOSS``. The earliest lever
   wins: nothing later matters if most viewers are gone before the story starts.
3. ``pacing`` — the slide is steady (``slide_per_tenth >= SLIDE_STEADY_MIN``) or
   there is a cliff in the middle of the video (after the hook window, before the
   last fifth). Cliffs in the last fifth are viewers finishing, not a scene to fix.
4. ``packaging`` — hook known and ``<= HOOK_HEALTHY_MAX_LOSS``, slide known and
   ``<= SLIDE_FLAT_MAX``, and no mid-video cliff: the people who click stay, so
   the lever is who clicks (title, thumbnail), not the video.
5. ``healthy`` — hook and slide both known, nothing crossed a threshold, but the
   picture is not clean enough to call it a packaging problem.
6. ``insufficient_data`` otherwise: a hook or slide that cannot be measured is
   never read as fine, so a missing piece can never become ``packaging``.

The thresholds are our own starting points, not calibrated against this
channel's history; they are named constants so a measurement PR can move them.

Honesty rules (CLAUDE.md #5)
----------------------------
* **Unknown stays unknown.** Everything that cannot be measured is ``None`` — not
  0, not a guess. ``cliffs`` is ``None`` when they could not be looked for and
  ``()`` when they were looked for and none qualified.
* **Never assume the start.** YouTube reports the curve from 1% of the video, so
  on a 10-minute video the first point is at 6 s. The hook loss is measured from
  the FIRST MEASURED point (``hook_from_s``), never from an invented 100% at 0 s;
  it is therefore a lower bound when ``hook_from_s`` is above 0. Fewer than
  ``MIN_HOOK_SPAN_S`` seconds between that point and the window end is unknown.
* **Interpolate, never extrapolate** (``scene_retention.interpolate``); a curve
  that does not reach 30 s or the start of the last fifth leaves that metric None.
* **The excerpt is the opening of the scene's narration**, not the exact words at
  the moment: the Video IR stores no word timings, and guessing a position inside
  the scene from character counts would be an assumption dressed as a quote.

What a cliff is
---------------
A step between two adjacent measured points that loses at least ``CLIFF_MIN_DROP``
audience points AND does so at least ``CLIFF_RATE_MULTIPLE`` times faster (per
minute) than the curve's median step. The rate test is what makes the answer the
same whether YouTube returned 100 points or 20; the size floor stops noise on a
nearly flat curve from qualifying. Cliffs are ranked by that rate, then by size,
then earliest. A rise is never a cliff.

Language: nothing here reads words. The excerpt is any language, passed through
after removing markup and capping its length.

Pure, no network, never raises: malformed input degrades to unknown. Read-only —
nothing in the pipeline depends on it yet.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, List, Mapping, Optional, Sequence, Tuple

from modules.retention_analyzer import MIN_POINTS
# The private helpers are shared on purpose: the same number/id rules as the
# per-scene mapping, so a scene is named identically in both and the two cannot
# drift on what counts as a number.
from modules.scene_retention import (
    _EPS, _num, _round, _scene_id, _str, clean_curve, interpolate, median, video_duration,
)

logger = logging.getLogger(__name__)

VERDICT_PACKAGING = "packaging"
VERDICT_HOOK = "hook"
VERDICT_PACING = "pacing"
VERDICT_HEALTHY = "healthy"
VERDICT_INSUFFICIENT = "insufficient_data"
VERDICTS = (VERDICT_PACKAGING, VERDICT_HOOK, VERDICT_PACING, VERDICT_HEALTHY, VERDICT_INSUFFICIENT)

#: The hook is the first this-many seconds of the video, absolute.
HOOK_WINDOW_S = 30.0
#: The measured part of the hook window must span at least this many seconds
#: (first measured point to the window end), else the leak is unknown: a curve
#: whose first point is already at 28 s says nothing about the first 30.
MIN_HOOK_SPAN_S = 10.0
#: Hook loss share at or below this is a healthy hook ...
HOOK_HEALTHY_MAX_LOSS = 0.30
#: ... and at or above this a steep one. Between the two: neither.
HOOK_STEEP_MIN_LOSS = 0.45

#: The slide ends where the last this-share of the video starts.
SLIDE_TAIL_FRACTION = 0.20
#: The slide's span (hook end to tail start) must be at least this long.
MIN_SLIDE_SPAN_S = 30.0
#: Audience points lost per 10% of the video: at or below is a flat slide ...
SLIDE_FLAT_MAX = 0.02
#: ... at or above is a steady one (>= 35 points gone over the middle 70%).
SLIDE_STEADY_MIN = 0.05

#: How many cliffs are reported.
TOP_CLIFFS = 5
#: A cliff loses at least this many audience points in one step ...
CLIFF_MIN_DROP = 0.03
#: ... and at least this many times the median step's loss rate per minute.
CLIFF_RATE_MULTIPLE = 4.0

#: Excerpts are capped at this many characters, the ellipsis included.
EXCERPT_MAX_CHARS = 120
#: Only this much of a narration is ever scanned: a scene's text can be a whole
#: chapter and the excerpt needs its opening.
_EXCERPT_SCAN_CHARS = 2000

ZONE_HOOK = "hook"
ZONE_MID = "mid"
ZONE_END = "end"

_TAG = re.compile(r"<[^>]{0,300}>")
#: Narration directives such as ``[PAUSE:2]``: markup, not words.
_DIRECTIVE = re.compile(r"\[[^\]\n]{0,80}\]")
_MARKUP_CHARS = dict.fromkeys(map(ord, "*_#`~<>|\\{}[]"), None)
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Cliff:
    #: Start / end of the step, seconds into the video, and the start's ratio.
    at_s: float
    end_s: float
    at_ratio: float
    #: Audience points lost across the step (always > 0).
    size: float
    #: ``size`` per minute of video.
    rate_per_min: float
    retention_before: float
    retention_after: float
    #: "hook" (before ``HOOK_WINDOW_S``), "mid", or "end" (last fifth), judged
    #: at the step's midpoint.
    zone: str
    #: The scene holding the step's midpoint; None without real scene times.
    scene_id: Optional[str]
    scene_index: Optional[int]
    #: Opening of that scene's narration; text only, length-capped.
    excerpt: Optional[str]

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass(frozen=True)
class RetentionDiagnosis:
    verdict: str
    #: Why the verdict is ``insufficient_data`` (a code); None otherwise.
    reason: Optional[str]
    #: Which findings the verdict rests on, e.g. ``("hook_healthy", "slide_flat")``.
    signals: Tuple[str, ...]
    duration_s: Optional[float]
    #: Usable measured points after cleaning.
    curve_points: int
    hook_window_s: float
    #: Where the hook loss is measured from (first measured point) and its value.
    hook_from_s: Optional[float]
    hook_start_retention: Optional[float]
    hook_end_retention: Optional[float]
    #: Audience points lost over the hook window (negative = the curve rose).
    hook_loss: Optional[float]
    #: ``hook_loss`` as a share of the viewers still watching at ``hook_from_s``.
    hook_loss_share: Optional[float]
    slide_from_s: Optional[float]
    slide_to_s: Optional[float]
    slide_loss: Optional[float]
    slide_per_min: Optional[float]
    slide_per_tenth: Optional[float]
    #: Steepest first; ``()`` = looked for, none qualified; None = not measurable.
    cliffs: Optional[Tuple[Cliff, ...]]

    def to_dict(self) -> dict:
        out = dict(self.__dict__)
        out["signals"] = list(self.signals)
        out["cliffs"] = None if self.cliffs is None else [c.to_dict() for c in self.cliffs]
        return out


def _unknown(reason: str, duration: Optional[float] = None, points: int = 0) -> RetentionDiagnosis:
    return RetentionDiagnosis(
        verdict=VERDICT_INSUFFICIENT, reason=reason, signals=(), duration_s=duration,
        curve_points=points, hook_window_s=HOOK_WINDOW_S, hook_from_s=None,
        hook_start_retention=None, hook_end_retention=None, hook_loss=None,
        hook_loss_share=None, slide_from_s=None, slide_to_s=None, slide_loss=None,
        slide_per_min=None, slide_per_tenth=None, cliffs=None,
    )


def _curve(points) -> List[Tuple[float, float]]:
    """The newest curve, sorted, without values that cannot be retention: a
    negative watch ratio or a position past the end of the video is a bad row,
    not a measurement (and must not be read as 0, which would be a fake cliff)."""
    if points is None or isinstance(points, (str, bytes)) or not isinstance(points, Iterable):
        return []
    kept = [(r, w) for r, w in clean_curve(points) if w >= 0 and r <= 1.0 + _EPS]
    return kept if len(kept) >= MIN_POINTS else []


def clean_excerpt(text) -> Optional[str]:
    """Text-only, whitespace-collapsed, length-capped; None when nothing is left.
    Tags and ``[DIRECTIVES]`` are removed, markdown punctuation dropped, control
    characters turned into spaces. Words are never inspected."""
    if not isinstance(text, str):
        return None
    s = _TAG.sub(" ", text[:_EXCERPT_SCAN_CHARS])
    s = _DIRECTIVE.sub(" ", s)
    s = s.translate(_MARKUP_CHARS)
    s = "".join(
        " " if unicodedata.category(ch) == "Cc" else ("" if unicodedata.category(ch) == "Cs" else ch)
        for ch in s
    )
    s = _WHITESPACE.sub(" ", s).strip()
    if not s:
        return None
    if len(s) > EXCERPT_MAX_CHARS:
        s = s[: EXCERPT_MAX_CHARS - 1].rstrip() + "…"
    return s


def _scene_windows(scenes) -> list:
    """``(start, end, id, index, narration)`` for scenes with real times."""
    if not isinstance(scenes, (list, tuple)):
        return []
    out = []
    for position, scene in enumerate(scenes):
        if not isinstance(scene, Mapping):
            continue
        start, end = _num(scene.get("start_s")), _num(scene.get("end_s"))
        if start is None or end is None or start < 0 or end <= start:
            continue
        idx = scene.get("index")
        index = idx if isinstance(idx, int) and not isinstance(idx, bool) else position
        out.append((start, end, _scene_id(scene, position), index, scene.get("narration")))
    out.sort(key=lambda w: (w[0], w[3]))
    return out


def _scene_at(windows: list, t: float):
    for window in windows:
        if window[0] <= t < window[1]:
            return window
    return None


def _cliffs(curve, duration, windows, slide_to_s) -> Tuple[Cliff, ...]:
    steps = []
    for (r0, w0), (r1, w1) in zip(curve, curve[1:]):
        # ratios are strictly increasing (clean_curve) and duration > 0, so dt > 0
        dt = (r1 - r0) * duration
        steps.append((r0 * duration, r1 * duration, r0, w0, w1, (w0 - w1) / (dt / 60.0)))
    typical = median([s[5] for s in steps])
    baseline = max(typical, 0.0) if typical is not None else 0.0
    found = []
    for t0, t1, r0, w0, w1, rate in steps:
        size = w0 - w1
        if round(size, 6) < CLIFF_MIN_DROP or rate < CLIFF_RATE_MULTIPLE * baseline:
            continue
        found.append((t0, t1, r0, w0, w1, size, rate))
    found.sort(key=lambda s: (-round(s[6], 6), -round(s[5], 6), s[0]))
    out = []
    for t0, t1, r0, w0, w1, size, rate in found[:TOP_CLIFFS]:
        mid = (t0 + t1) / 2.0
        zone = ZONE_HOOK if mid < HOOK_WINDOW_S else (ZONE_END if mid > slide_to_s else ZONE_MID)
        scene = _scene_at(windows, mid)
        out.append(Cliff(
            at_s=_round(t0), end_s=_round(t1), at_ratio=_round(r0), size=_round(size),
            rate_per_min=_round(rate), retention_before=_round(w0), retention_after=_round(w1),
            zone=zone,
            scene_id=scene[2] if scene else None,
            scene_index=scene[3] if scene else None,
            excerpt=clean_excerpt(scene[4]) if scene else None,
        ))
    return tuple(out)


def _diagnose(points, duration_s, scenes) -> RetentionDiagnosis:
    duration = _num(duration_s)
    if duration is not None and duration <= 0:
        duration = None
    curve = _curve(points)
    if not curve:
        return _unknown("no_curve", duration)
    if duration is None:
        return _unknown("no_duration", None, len(curve))

    first_ratio, first_value = curve[0]
    first_s = first_ratio * duration

    hook_from = hook_start = hook_end = hook_loss = hook_share = None
    end_value = interpolate(curve, HOOK_WINDOW_S / duration)
    if end_value is not None and HOOK_WINDOW_S - first_s >= MIN_HOOK_SPAN_S:
        hook_from, hook_start, hook_end = first_s, first_value, end_value
        hook_loss = first_value - end_value
        # rounded before any threshold: 1 - 0.55 must count as exactly 0.45
        hook_share = round(hook_loss / first_value, 6) if first_value > 0 else None

    slide_to = (1.0 - SLIDE_TAIL_FRACTION) * duration
    slide_loss = slide_min = slide_tenth = None
    slide_start = slide_end = None
    if slide_to - HOOK_WINDOW_S >= MIN_SLIDE_SPAN_S:
        slide_start = interpolate(curve, HOOK_WINDOW_S / duration)
        slide_end = interpolate(curve, slide_to / duration)
    if slide_start is not None and slide_end is not None:
        span = slide_to - HOOK_WINDOW_S
        slide_loss = slide_start - slide_end
        slide_min = slide_loss / (span / 60.0)
        slide_tenth = round(slide_loss * 0.1 * duration / span, 6)

    cliffs = _cliffs(curve, duration, _scene_windows(scenes), slide_to)
    mid_cliff = any(c.zone == ZONE_MID for c in cliffs)

    signals: list = []
    reason = None
    if hook_share is not None and hook_share >= HOOK_STEEP_MIN_LOSS:
        verdict, signals = VERDICT_HOOK, ["hook_steep"]
    elif mid_cliff or (slide_tenth is not None and slide_tenth >= SLIDE_STEADY_MIN):
        verdict = VERDICT_PACING
        if mid_cliff:
            signals.append("mid_cliff")
        if slide_tenth is not None and slide_tenth >= SLIDE_STEADY_MIN:
            signals.append("slide_steady")
    elif hook_share is None or slide_tenth is None:
        verdict = VERDICT_INSUFFICIENT
        reason = "hook_and_slide_unknown" if hook_share is None and slide_tenth is None else (
            "hook_unknown" if hook_share is None else "slide_unknown")
    elif hook_share <= HOOK_HEALTHY_MAX_LOSS and slide_tenth <= SLIDE_FLAT_MAX:
        verdict, signals = VERDICT_PACKAGING, ["hook_healthy", "slide_flat"]
    else:
        verdict = VERDICT_HEALTHY
        signals = ["no_threshold_crossed"]

    return RetentionDiagnosis(
        verdict=verdict, reason=reason, signals=tuple(signals), duration_s=_round(duration),
        curve_points=len(curve), hook_window_s=HOOK_WINDOW_S,
        hook_from_s=_round(hook_from), hook_start_retention=_round(hook_start),
        hook_end_retention=_round(hook_end), hook_loss=_round(hook_loss),
        hook_loss_share=_round(hook_share),
        slide_from_s=None if slide_loss is None else HOOK_WINDOW_S,
        slide_to_s=None if slide_loss is None else _round(slide_to),
        slide_loss=_round(slide_loss), slide_per_min=_round(slide_min),
        slide_per_tenth=_round(slide_tenth), cliffs=cliffs,
    )


def diagnose(
    points: Optional[Iterable[Mapping]],
    duration_s: Optional[float],
    scenes: Optional[Sequence[Mapping]] = None,
) -> RetentionDiagnosis:
    """Diagnose one video.

    ``points``: its retention rows as stored (``elapsed_ratio``, ``watch_ratio``,
    ``measured_date``); ``duration_s``: the rendered video's length in seconds;
    ``scenes``: Video IR scenes (``id``, ``index``, ``start_s``, ``end_s``,
    ``narration``), optional. Never raises.
    """
    try:
        return _diagnose(points, duration_s, scenes)
    except Exception:
        logger.warning("retention_diagnosis: failed; the video reads as insufficient_data", exc_info=True)
        return _unknown("error")


def for_video(manifest: Optional[Mapping], points: Optional[Iterable[Mapping]]) -> RetentionDiagnosis:
    """Diagnose from a stored Video IR (``videos.manifest``): duration and scenes
    come from it. Without a manifest the duration is unknown."""
    try:
        if not isinstance(manifest, Mapping):
            return diagnose(points, None, None)
        raw = manifest.get("scenes")
        scenes = [s for s in raw if isinstance(s, Mapping)] if isinstance(raw, (list, tuple)) else []
        return diagnose(points, video_duration(manifest, scenes), scenes)
    except Exception:
        logger.warning("retention_diagnosis: manifest unreadable", exc_info=True)
        return _unknown("error")
