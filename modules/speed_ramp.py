"""Speed ramps: the arithmetic of a clip whose speed changes while it plays.

A ramp is a few ``(position, speed)`` points over a clip's source range, with
the speed moving linearly between them (a smooth ramp, not steps). The picture
is retimed with one ``setpts`` expression; the sound, which ffmpeg can only
speed up by a constant per filter, follows in equal slices of the source range
that each play at the speed that makes the slice last exactly as long as the
picture does there. This module is pure (no ffmpeg, no document): the document
validators, the render spec and the filter graph all read the SAME numbers
from it, so the clip's length on the timeline is one function.

Playing a source second ``u`` at speed ``s(u)`` takes ``1 / s(u)`` seconds, so
the output time of source time ``t`` is ``T(t) = integral(du / s(u))``. For a
linear piece ``s(u) = s0 + k (u - t0)`` that is ``ln(s(t)/s0) / k`` (``(t - t0) / s0``
when ``k`` is 0) -- closed form, no stepping.
"""

from __future__ import annotations

import math
from typing import List, Sequence, Tuple

Point = Tuple[float, float]   # (source seconds from the range's start, speed)

#: Below this a piece is "constant speed" (the log form divides by k).
_FLAT = 1e-6
#: Audio is cut into this many slices at most, each at least this long.
SLICES_MAX = 16
SLICE_MIN_S = 0.5


def absolute(points: Sequence[Tuple[float, float]], range_s: float) -> List[Point]:
    """``(at, speed)`` with ``at`` a fraction 0-1 of the range -> source seconds."""
    return [(float(a) * float(range_s), float(s)) for a, s in points]


def _piece_length(t0: float, s0: float, t1: float, s1: float) -> float:
    if abs(s1 - s0) < _FLAT:
        return (t1 - t0) / s0
    return (t1 - t0) / (s1 - s0) * math.log(s1 / s0)


def out_length(pts: Sequence[Point]) -> float:
    """How long the whole range lasts at the ramp's speeds, in seconds."""
    return sum(_piece_length(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:]))


def out_time(pts: Sequence[Point], t: float) -> float:
    """The output time at which source time ``t`` (0 to the range) is shown."""
    acc = 0.0
    for a, b in zip(pts, pts[1:]):
        if t <= b[0]:
            s = a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0])
            return acc + _piece_length(a[0], a[1], t, s)
        acc += _piece_length(a[0], a[1], b[0], b[1])
    return acc


def speed_at(pts: Sequence[Point], t: float) -> float:
    for a, b in zip(pts, pts[1:]):
        if t <= b[0]:
            return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0])
    return pts[-1][1]


def min_speed(pts: Sequence[Point]) -> float:
    return min(s for _t, s in pts)


def setpts_expression(pts: Sequence[Point]) -> str:
    """The ``setpts`` expression that maps a frame's source time to its output
    time, ``T(t)`` above, in units of the stream's time base. Every number is a
    float formatted here (6 decimals); ``t`` is the frame's time in seconds from
    the first one."""
    t = "((PTS-STARTPTS)*TB)"
    pieces: List[Tuple[float, str]] = []
    acc = 0.0
    for a, b in zip(pts, pts[1:]):
        (t0, s0), (t1, s1) = a, b
        if abs(s1 - s0) < _FLAT:
            body = f"{acc:.6f}+({t}-{t0:.6f})/{s0:.6f}"
        else:
            k = (s1 - s0) / (t1 - t0)
            body = f"{acc:.6f}+log(({s0:.6f}+({k:.6f})*({t}-{t0:.6f}))/{s0:.6f})/({k:.6f})"
        pieces.append((t1, body))
        acc += _piece_length(t0, s0, t1, s1)
    last_t, last_s = pts[-1]
    expr = f"{acc:.6f}+({t}-{last_t:.6f})/{last_s:.6f}"   # past the range: the last speed goes on
    for t1, body in reversed(pieces):
        expr = f"if(lt({t},{t1:.6f}),{body},{expr})"
    return f"({expr})/TB"


def slice_count(range_s: float) -> int:
    return max(2, min(SLICES_MAX, int(round(float(range_s) / SLICE_MIN_S))))


def slice_tempos(pts: Sequence[Point], range_s: float, n: int) -> List[float]:
    """For each of ``n`` equal slices of the source range, the constant tempo
    that makes it last exactly as long as the ramp's picture does there (so the
    sound is on the picture at every slice boundary)."""
    step = float(range_s) / n
    out = []
    for j in range(n):
        d = out_time(pts, (j + 1) * step) - out_time(pts, j * step)
        out.append(step / d)
    return out
