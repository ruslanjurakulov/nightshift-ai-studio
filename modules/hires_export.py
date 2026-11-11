"""1440p and 4K editor exports (migration 0132, docs/HIRES_EXPORT.md): the tiers, their length caps and their render budgets.

Owner decision 2026-11-11: offer them, give the worker more render time for them, charge credits in proportion to render time; exports up to
1080p stay free. This module holds the numbers the worker (``modules/editor_export.py``), the preset list (``modules/export_presets.py``) and
the tests share. The database has its own copy of the tiers and caps (0132 ``editor_export_hires_terms`` and the CHECK
``editor_exports_hires_terms``) and the Command Center another (``command-center/lib/hiresExport/limits.ts``); a parity test pins the three.

Tiers are by PIXELS, so a frame and its 9:16 twin are the same tier:

* up to 1920x1080 (2 073 600 px): free, no tier, every rule as before;
* up to 2560x1440 (3 686 400 px): ``1440p``, at most ``MAX_S['1440p']`` seconds;
* up to 3840x2160 (8 294 400 px): ``2160p`` (4K), at most ``MAX_S['2160p']`` seconds and ``MAX_FPS['2160p']`` fps.

Why a length cap at all: the media worker renders ONE export at a time for every organization (``editor_export.ExportService``), and a 4K
render takes several times its own length (measured: docs/HIRES_EXPORT.md). A 30-minute 4K export would hold everyone's queue for hours.

Why a bigger time budget: ``render_timeout_s`` of the free exports (3 x length + 120 s) was set from 1080p; a 4K render of a phone-like
60 fps source needs more than that and would be killed as ``timed_out`` after the person waited. The factors below are the measured cost
per second with a margin; the cap (``RENDER_TIMEOUT_MAX_S``, 90 minutes) still applies. Only an export whose row carries a paid hi-res
FRAME (0132) gets them: a project whose own document is 4K (another tool can save one) keeps the free exports' budget, as before.

The switch: ``NIGHTSHIFT_HIRES_EXPORT`` (default off), read by the worker and the Command Center under the same name. Off, the worker
refuses a hi-res frame row (``hires_off``) before reading any file, and the editor does not offer the frames.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Optional

from modules import timeline as tl

FLAG = "NIGHTSHIFT_HIRES_EXPORT"

#: Up to this many pixels an export is free (1920x1080 either way up).
FREE_MAX_PX = 1920 * 1080
#: The 1440p tier ends here (2560x1440 either way up); the 4K tier ends at 3840x2160.
TIER_1440P_MAX_PX = 2560 * 1440
TIER_2160P_MAX_PX = 3840 * 2160
TIERS = ("1440p", "2160p")

#: The longest paid export of each tier, in seconds of output (0132 has the same numbers, in the function and in the CHECK).
MAX_S = {"1440p": 300.0, "2160p": 180.0}
#: The fastest frame rate of each tier. 4K is 30 at most: a 9:16 4K60 render with a cross-fade of a 16:9 4K60 source (fit "cover")
#: failed under the worker's 2 GiB address-space limit ("out of memory", four runs of four) and passed at 30 fps, with the
#: large-frame rules on (docs/HIRES_EXPORT.md, "Memory"). A 60 fps project is refused for 4K, never rendered at 30 instead
#: (CLAUDE.md rule 4: no silent quality fallback). 1440p60 passed every case, cross-fades and 9:16 included.
MAX_FPS = {"1440p": 60, "2160p": 30}

#: The worker's wall-clock budget of a paid export: RENDER_TIMEOUT_PER_S[tier] x length + RENDER_TIMEOUT_BASE_S, never more than
#: RENDER_TIMEOUT_MAX_S. Measured with the bundled ffmpeg 7.0.2 through editor_export.run_export on a phone-like 60 fps noisy H.264
#: source at the frame's own size, on a 4-core box (docs/HIRES_EXPORT.md, "Measurements"): the dearest render of a tier on a box that
#: was not swamped by other work was 5.34 s per output second at 1440p (9:16, 60 fps, a cross-fade) and 9.82 at 4K (9:16, 30 fps, a
#: cross-fade). Each factor is about 1.3x that; the 3 s per second of the free exports would have killed both. At the caps a paid
#: export may hold the ONE export worker for 37 minutes (1440p, 300 s) or 38 minutes (4K, 180 s) before it is stopped.
RENDER_TIMEOUT_PER_S = {"1440p": 7.0, "2160p": 12.0}
RENDER_TIMEOUT_BASE_S = tl.RENDER_TIMEOUT_BASE_S
RENDER_TIMEOUT_MAX_S = tl.RENDER_TIMEOUT_MAX_S


def enabled(env: Mapping[str, str]) -> bool:
    """Is a hi-res frame rendered (worker) or offered (web) here? ``on`` / ``1`` / ``true`` / ``yes``; anything else is off."""
    return str(env.get(FLAG, "") or "").strip().lower() in ("on", "1", "true", "yes")


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def tier(width: Any, height: Any) -> Optional[str]:
    """``'1440p'`` / ``'2160p'`` for a paid frame, None for a free one (or for anything that is not two positive integers). A frame
    above 3840x2160 pixels has no tier either: no list holds one, and it is never sold."""
    if not (_is_int(width) and _is_int(height)) or width <= 0 or height <= 0:
        return None
    px = width * height
    if px <= FREE_MAX_PX:
        return None
    if px <= TIER_1440P_MAX_PX:
        return "1440p"
    if px <= TIER_2160P_MAX_PX:
        return "2160p"
    return None


def length_problem(width: Any, height: Any, length_s: Any) -> Optional[str]:
    """Why a video of ``length_s`` seconds cannot be exported paid in this frame (its tier's cap), or None."""
    t = tier(width, height)
    if t is None:
        return None
    try:
        length = float(length_s)
    except (TypeError, ValueError):
        return f"{t}: the length is not a number"
    if not math.isfinite(length) or length > MAX_S[t] + 1e-9:
        return f"{t}: an export in this frame is at most {MAX_S[t]:g} s long"
    return None


def fps_problem(width: Any, height: Any, fps: Any) -> Optional[str]:
    """Why a document at ``fps`` cannot be exported paid in this frame (its tier's fastest rate), or None."""
    t = tier(width, height)
    if t is None:
        return None
    if not (_is_int(fps) or isinstance(fps, float)) or isinstance(fps, bool) or not math.isfinite(float(fps)):
        return f"{t}: the frame rate is not a number"
    if fps > MAX_FPS[t]:
        return f"{t}: an export in this frame is at most {MAX_FPS[t]} fps"
    return None


def render_timeout_s(width: Any, height: Any, length_s: Any) -> float:
    """The wall-clock budget of a paid export in this frame. A free frame gets the free exports' budget (``timeline.render_timeout_s``);
    NaN, infinity or garbage get the cap, never no limit."""
    try:
        length = float(length_s)
    except (TypeError, ValueError):
        length = 0.0
    # Before max(): max(0.0, nan) is 0.0, which would turn "not a number" into the shortest budget instead of the cap.
    if not math.isfinite(length):
        return RENDER_TIMEOUT_MAX_S
    length = max(0.0, length)
    t = tier(width, height)
    if t is None:
        return tl.render_timeout_s(length)
    return min(RENDER_TIMEOUT_MAX_S, RENDER_TIMEOUT_PER_S[t] * length + RENDER_TIMEOUT_BASE_S)


__all__ = ["FLAG", "FREE_MAX_PX", "MAX_FPS", "MAX_S", "RENDER_TIMEOUT_BASE_S", "RENDER_TIMEOUT_MAX_S", "RENDER_TIMEOUT_PER_S", "TIERS",
           "TIER_1440P_MAX_PX", "TIER_2160P_MAX_PX", "enabled", "fps_problem", "length_problem", "render_timeout_s", "tier"]
