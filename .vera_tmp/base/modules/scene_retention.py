"""Scene-level retention — which scene the audience left in.

Roadmap Q8 / PR 5.1. `retention_analyzer` says *where through the video*
viewers leave ("the biggest cliff starts around 40%"). A writer or a director
cannot act on a percentage; they act on a scene. The Video IR (migration 0013)
gives every scene its REAL ``start_s``/``end_s`` on the narration audio, and the
rendered video is exactly as long as that audio (the compositor sets the final
clip's duration to the audio's), so a point of the YouTube curve at
``elapsed_ratio`` sits at ``elapsed_ratio * duration`` seconds — inside exactly
one scene.

Per scene this yields:

* ``retention_start`` / ``retention_end`` — share of viewers still watching at
  the scene's first and last second, linearly interpolated between the two
  measured points around it;
* ``drop`` — ``start - end``, in share-of-audience points (negative when the
  curve rises, e.g. rewatches);
* ``drop_per_min`` — the same, per minute of scene. Worst scenes are RANKED on
  this, not on ``drop``: a long scene loses more viewers simply by being long,
  and a ranking on raw drop would only rediscover the longest scenes.

Honesty rules (CLAUDE.md #5)
----------------------------
* **Unknown stays unknown.** A scene without real times, a video whose duration
  is unknown, or a curve with fewer than ``retention_analyzer.MIN_POINTS``
  measured points yields ``None`` values — never 0.
* **Interpolate, never extrapolate.** YouTube reports the curve from 1% of the
  video onwards, so the first second of the first scene lies BEFORE the first
  measured point: its start retention is unknown, and so are its drop and rank.
  Filling that gap with "100% at 0 s" would be an assumption rendered as a
  measurement.
* Only the curve's newest ``measured_date`` is used (the same rule as
  ``StateStore.retention_curve``) — two snapshots of one curve are not two
  curves.

The TypeScript twin is ``command-center/lib/sceneRetention.ts``; both are
checked against the same cases in ``samples/scene_retention_cases.json``.

Pure and never raises: malformed input degrades to "unknown".
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Iterable, List, Mapping, Optional, Sequence, Tuple

from modules.retention_analyzer import MIN_POINTS

logger = logging.getLogger(__name__)

#: A ratio this close outside the measured range still counts as inside it —
#: float rounding of ``end_s / duration`` must not turn the last scene's end
#: (exactly 100%) into "past the curve".
_EPS = 1e-6
#: Decimal places the public values are rounded to.
_DIGITS = 4


@dataclass(frozen=True)
class SceneRetention:
    scene_id: str
    index: int
    type: Optional[str]
    recipe: Optional[str]
    start_s: Optional[float]
    end_s: Optional[float]
    #: Share of viewers still watching at the scene's start / end (0.0-1.0+).
    retention_start: Optional[float]
    retention_end: Optional[float]
    #: retention_start - retention_end, share-of-audience points.
    drop: Optional[float]
    #: drop per minute of scene.
    drop_per_min: Optional[float]
    #: 1 = the scene that loses viewers fastest; None when drop_per_min is.
    rank: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "scene_id": self.scene_id, "index": self.index, "type": self.type,
            "recipe": self.recipe, "start_s": self.start_s, "end_s": self.end_s,
            "retention_start": self.retention_start, "retention_end": self.retention_end,
            "drop": self.drop, "drop_per_min": self.drop_per_min, "rank": self.rank,
        }


def _num(value) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _str(value) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _round(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value, _DIGITS)


def clean_curve(points: Optional[Iterable[Mapping]]) -> List[Tuple[float, float]]:
    """The newest measured curve as sorted ``(elapsed_ratio, watch_ratio)``
    pairs, or ``[]`` when it has fewer than MIN_POINTS usable points.

    Rows without a measured ``watch_ratio`` are dropped (not read as 0). When
    rows span several ``measured_date`` values only the newest date is kept; a
    repeated ratio keeps its last row.
    """
    rows = [p for p in (points or []) if isinstance(p, Mapping)]
    dates = [str(p.get("measured_date")) for p in rows if p.get("measured_date")]
    if dates:
        newest = max(dates)
        rows = [p for p in rows if not p.get("measured_date") or str(p.get("measured_date")) == newest]
    by_ratio = {}
    for p in rows:
        ratio, watch = _num(p.get("elapsed_ratio")), _num(p.get("watch_ratio"))
        if ratio is None or watch is None or ratio < 0:
            continue
        by_ratio[ratio] = watch
    curve = sorted(by_ratio.items())
    return curve if len(curve) >= MIN_POINTS else []


def interpolate(curve: Sequence[Tuple[float, float]], ratio: Optional[float]) -> Optional[float]:
    """Retention at ``ratio``, linearly interpolated between the measured points
    around it; None outside the measured range (never extrapolated)."""
    if not curve or ratio is None:
        return None
    lo_r, hi_r = curve[0][0], curve[-1][0]
    if ratio < lo_r - _EPS or ratio > hi_r + _EPS:
        return None
    if ratio <= lo_r:
        return curve[0][1]
    if ratio >= hi_r:
        return curve[-1][1]
    for (r0, w0), (r1, w1) in zip(curve, curve[1:]):
        if r0 <= ratio <= r1:
            if r1 == r0:
                return w1
            return w0 + (w1 - w0) * (ratio - r0) / (r1 - r0)
    return None  # unreachable for a sorted curve; unknown rather than a guess


def video_duration(manifest: Optional[Mapping], scenes: Optional[Sequence[Mapping]] = None) -> Optional[float]:
    """The rendered video's length in seconds, or None when unknown.

    The IR's measured audio duration first; otherwise the last scene's real end
    — the same timeline the IR itself derives the audio duration from when the
    mixer did not report one. Never a word-count estimate.
    """
    try:
        audio = (manifest or {}).get("audio") if isinstance(manifest, Mapping) else None
        d = _num(audio.get("duration_s")) if isinstance(audio, Mapping) else None
        if d is not None and d > 0:
            return d
        ends = [_num(s.get("end_s")) for s in (scenes or []) if isinstance(s, Mapping)]
        ends = [e for e in ends if e is not None and e > 0]
        return max(ends) if ends else None
    except Exception:
        return None


def _scene_id(scene: Mapping, position: int) -> str:
    sid = _str(scene.get("id"))
    return sid or f"s{position:03d}"


def _recipe(scene: Mapping) -> Optional[str]:
    shot = scene.get("shot")
    return _str(shot.get("recipe")) if isinstance(shot, Mapping) else None


def rank_scenes(rows: Sequence[SceneRetention]) -> List[SceneRetention]:
    """``rows`` with ``rank`` set: 1 = fastest loss per minute, then larger raw
    drop, then earlier scene. Scenes with an unknown rate stay unranked."""
    known = [r for r in rows if r.drop_per_min is not None]
    order = sorted(known, key=lambda r: (-r.drop_per_min, -(r.drop or 0.0), r.index))
    rank_of = {id(r): i + 1 for i, r in enumerate(order)}
    return [
        SceneRetention(**{**r.__dict__, "rank": rank_of.get(id(r))}) for r in rows
    ]


def map_scenes(
    scenes: Optional[Sequence[Mapping]],
    points: Optional[Iterable[Mapping]],
    duration_s: Optional[float],
) -> List[SceneRetention]:
    """Map a retention curve onto scene windows. One entry per scene, in order;
    every value None where it cannot be measured. Never raises."""
    try:
        curve = clean_curve(points)
        duration = _num(duration_s)
        if duration is not None and duration <= 0:
            duration = None
        out = []
        for position, scene in enumerate(scenes or []):
            if not isinstance(scene, Mapping):
                continue
            start, end = _num(scene.get("start_s")), _num(scene.get("end_s"))
            r_start = r_end = drop = rate = None
            if curve and duration is not None and start is not None and end is not None and end > start:
                r_start = interpolate(curve, start / duration)
                r_end = interpolate(curve, end / duration)
                if r_start is not None and r_end is not None:
                    drop = r_start - r_end
                    rate = drop / ((end - start) / 60.0)
            idx = scene.get("index")
            out.append(SceneRetention(
                scene_id=_scene_id(scene, position),
                index=int(idx) if isinstance(idx, int) and not isinstance(idx, bool) else position,
                type=_str(scene.get("type")), recipe=_recipe(scene),
                start_s=start, end_s=end,
                retention_start=_round(r_start), retention_end=_round(r_end),
                drop=_round(drop), drop_per_min=_round(rate),
            ))
        return rank_scenes(out)
    except Exception:
        logger.warning("scene_retention: mapping failed; every scene reads as unknown", exc_info=True)
        return []


def for_video(manifest: Optional[Mapping], points: Optional[Iterable[Mapping]]) -> List[SceneRetention]:
    """Scene retention for one video from its stored Video IR (``videos.manifest``)
    and its retention rows. [] when there is no manifest."""
    if not isinstance(manifest, Mapping):
        return []
    scenes = [s for s in (manifest.get("scenes") or []) if isinstance(s, Mapping)]
    return map_scenes(scenes, points, video_duration(manifest, scenes))


def has_data(rows: Sequence[SceneRetention]) -> bool:
    """True when at least one scene has a measured drop rate."""
    return any(r.drop_per_min is not None for r in rows or [])


def median(values: Sequence[float]) -> Optional[float]:
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2
