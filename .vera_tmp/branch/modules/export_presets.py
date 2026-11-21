"""Export presets: a closed, data-driven list of frame shapes the editor offers
for an export (YouTube wide, vertical for Shorts / Reels / TikTok, square, a
4:5 feed shape).

A preset is a label's worth of PARAMETERS and nothing else: a frame size, a
default frame rate and a recommended length. It is not a new render path. Choosing
one only writes ``width`` / ``height`` into the timeline document; the rate is the
document's own ``fps``, which the editor's rate picker (24, 25, 30 or 60) writes
on its own, so a 1080p project at 60 fps is still "YouTube 1080p". The
document then goes through exactly what any document goes through:
``timeline.validate`` (every frame, fps and render-budget rule), the same
``timeline_render`` layout, the same ``render_backend`` commands under the same
``ffmpeg_limits`` (address-space limit, thread caps, decoder pixel cap,
``-protocol_whitelist file``, wall-clock budget). Nothing here builds an ffmpeg
argument, reads a file, or touches the database.

The list lives in ``schemas/export_presets.json`` and is checked on load against
the limits it must never exceed, so a typo in the data (an odd side, a 4K
frame, a ten-hour cap) fails at once instead of at a member's export:

* the frame is even-sided (H.264 4:2:0), inside ``timeline.MIN_SIDE`` /
  ``MAX_SIDE`` and no bigger than ``timeline.LARGE_FRAME_PX`` (1440p), which is
  also ``ffmpeg_limits.LARGE_OUTPUT_PX`` — EXCEPT a 4K frame of the paid tier
  (migration 0132, ``modules/hires_export.py``): a frame above 1080p must be
  one of the paid tiers, and its recommended length must be at most its tier's
  hard cap (``hires_export.MAX_S``: 300 s at 1440p, 180 s at 4K), so the
  advice can never be longer than what the export accepts;
* the frame rate is one of ``timeline.FPS_VALUES``;
* the recommended length is at most ``editor_export.EXPORT_MAX_S`` (the export's
  own cap, the database's too), and a full-length video at the preset's frame
  AND THE FASTEST RATE A DOCUMENT MAY HAVE (``max(timeline.FPS_VALUES)``, 60: the
  rate is chosen apart from the frame) stays inside the library's decode budget
  (``media_library.DECODE_BUDGET_PX``).

1440p and 4K (migration 0132): four presets above 1080p, each a frame and its
9:16 twin. They are PAID (credits per started output minute, the database's
price row), offered only in "Sizes to export" while ``NIGHTSHIFT_HIRES_EXPORT``
is on, never in the format picker (a project's own frame is exported free, so a
4K project frame would be a free 4K export), capped in length, and rendered
with their tier's time budget (``hires_export``). Above 1440p every export is in
the large-frame regime (no blur or zoom past 2 on a cross-fade, no
interpolation, a 0.7 s reverse at 4K60). A new format is still a new migration
on purpose (the database's own copy of this list, ``editor_export_frame``, is
compared id for id by tests/test_editor_hires_export_migration.py).

The recommended length is advice, not a refusal: a vertical project that was
already 4 minutes long exported before presets existed and must keep doing so.
The caps in the data are this project's own conservative numbers, not a claim
about any platform's rules (those change without notice and were not checked).

The Command Center has a twin of this list (``lib/editorExportPresets.ts``); a
test compares the two to the JSON.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from modules import editor_export, ffmpeg_limits, hires_export
from modules import media_library as ml
from modules import timeline as tl

PRESETS_PATH = Path(__file__).resolve().parent.parent / "schemas" / "export_presets.json"
VERSION = 1
_ID = re.compile(r"^[a-z0-9_]{1,32}$")
_KEYS = ("id", "width", "height", "fps", "max_duration_s")
#: The only frames above 1440p a preset may be: the 4K frame and its 9:16 twin, the sizes whose renders were measured under
#: ffmpeg_limits.CHILD_MEM_BYTES with the large-frame rules (docs/HIRES_EXPORT.md). Another big frame is not "4K" because it is big.
MEASURED_4K = ((3840, 2160), (2160, 3840))


class UnknownPreset(ValueError):
    """The id is not one of the closed list (or is not even a string)."""


class PresetDataError(ValueError):
    """The presets file breaks a rule above; the message says which."""


@dataclass(frozen=True)
class Preset:
    id: str
    width: int
    height: int
    #: The format's usual rate (shown beside it); the export's rate is the document's own ``fps``.
    fps: int
    #: Longer than this, the picker says the video is long for the format.
    #: Advice: the export itself is only ever refused by the export's own limits.
    max_duration_s: float


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def parse_preset(raw: Any) -> Preset:
    """One entry of the file as a Preset, or PresetDataError."""
    if not isinstance(raw, dict):
        raise PresetDataError("a preset must be an object")
    pid = raw.get("id")
    where = f"preset {pid!r}"
    if set(raw) != set(_KEYS):
        raise PresetDataError(f"{where}: keys must be exactly {', '.join(_KEYS)}")
    if not isinstance(pid, str) or not _ID.match(pid):
        raise PresetDataError(f"{where}: id must be 1-32 characters of a-z, 0-9 and _")
    w, h, fps, cap = raw["width"], raw["height"], raw["fps"], raw["max_duration_s"]
    for name, side in (("width", w), ("height", h)):
        if not (_is_int(side) and tl.MIN_SIDE <= side <= tl.MAX_SIDE and side % 2 == 0):
            raise PresetDataError(f"{where}: {name} must be an even integer from {tl.MIN_SIDE} to {tl.MAX_SIDE}")
    largest = min(tl.LARGE_FRAME_PX, ffmpeg_limits.LARGE_OUTPUT_PX)
    paid = hires_export.tier(w, h)
    if w * h > largest and (w, h) not in MEASURED_4K:
        raise PresetDataError(f"{where}: the frame is at most {largest} pixels (1440p), or exactly 3840x2160 / 2160x3840: "
                              "the 4K frames measured under the worker's memory limit (paid, migration 0132)")
    if w * h > hires_export.FREE_MAX_PX and paid is None:
        raise PresetDataError(f"{where}: a frame above 1080p must be one of the paid tiers")
    if paid is not None and _is_number(cap) and cap > hires_export.MAX_S[paid]:
        raise PresetDataError(f"{where}: a {paid} export is at most {hires_export.MAX_S[paid]:g} s long, so its "
                              "max_duration_s cannot be longer")
    if not (_is_int(fps) and fps in tl.FPS_VALUES):
        raise PresetDataError(f"{where}: fps must be one of {', '.join(map(str, tl.FPS_VALUES))}")
    if not (_is_number(cap) and 0 < cap <= editor_export.EXPORT_MAX_S):
        raise PresetDataError(f"{where}: max_duration_s must be above 0 and at most "
                              f"{editor_export.EXPORT_MAX_S:g} (the export's own cap)")
    if ml.decode_work(w, h, max(tl.FPS_VALUES), cap) > ml.DECODE_BUDGET_PX:
        raise PresetDataError(f"{where}: a video of max_duration_s at this frame passes the library's decode budget")
    return Preset(pid, w, h, fps, float(cap))


def load(path: Path = PRESETS_PATH) -> Dict[str, Preset]:
    """The presets by id, in file order. Raises PresetDataError for anything
    that is not the documented shape, a duplicate id, or two presets of the
    same frame (the picker tells them apart by the document's frame alone, the
    rate being chosen on its own, so they must differ)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise PresetDataError(f"cannot read the presets file ({type(e).__name__})") from None
    if not isinstance(data, dict) or set(data) != {"version", "presets"} or data["version"] != VERSION:
        raise PresetDataError(f"the presets file must be an object with version {VERSION} and presets")
    if not isinstance(data["presets"], list) or not data["presets"]:
        raise PresetDataError("presets must be a non-empty list")
    out: Dict[str, Preset] = {}
    frames = set()
    for raw in data["presets"]:
        p = parse_preset(raw)
        if p.id in out:
            raise PresetDataError(f"duplicate preset id {p.id!r}")
        if (p.width, p.height) in frames:
            raise PresetDataError(f"preset {p.id!r} repeats another preset's frame")
        frames.add((p.width, p.height))
        out[p.id] = p
    return out


def get(preset_id: Any, presets: Optional[Mapping[str, Preset]] = None) -> Preset:
    """The preset with exactly this id. Anything else (unknown, wrong case,
    padded, not a string) is refused: the set is closed."""
    table = presets if presets is not None else load()
    if not isinstance(preset_id, str) or preset_id not in table:
        raise UnknownPreset("not an export preset")
    return table[preset_id]


def apply(doc: Mapping[str, Any], preset_id: Any, presets: Optional[Mapping[str, Preset]] = None) -> dict:
    """A copy of ``doc`` with the preset's frame size and nothing else changed
    (its ``fps`` is the document's own: the rate is chosen apart from the frame).
    It is NOT validated here: pass it to ``timeline.validate`` /
    ``timeline.load`` like any document (``problems`` below does)."""
    p = get(preset_id, presets)
    out = copy.deepcopy(dict(doc))
    out["width"], out["height"] = p.width, p.height
    return out


def problems(doc: Mapping[str, Any], preset_id: Any, presets: Optional[Mapping[str, Preset]] = None) -> List[str]:
    """Why ``doc`` could not be exported at this preset: every rule of the
    timeline validator, applied to the document with the preset's frame. The
    recommended length is not one of them (see ``long_for``)."""
    return tl.validate(apply(doc, preset_id, presets))


def preset_of(doc: Mapping[str, Any], presets: Optional[Mapping[str, Preset]] = None) -> Optional[Preset]:
    """The preset a document's frame is exactly, at whatever rate, or None (a
    custom size, or a document from another tool: no preset is shown as chosen)."""
    table = presets if presets is not None else load()
    key = (doc.get("width"), doc.get("height"))
    for p in table.values():
        if key == (p.width, p.height):
            return p
    return None


def long_for(duration_s: float, preset: Preset) -> bool:
    """Is a video this long past the preset's recommended length?"""
    return duration_s > preset.max_duration_s


def is_paid(preset: Preset) -> bool:
    """A frame above 1080p (migration 0132): sold by the minute, capped in length, behind NIGHTSHIFT_HIRES_EXPORT."""
    return hires_export.tier(preset.width, preset.height) is not None


def free(presets: Optional[Mapping[str, Preset]] = None) -> Dict[str, Preset]:
    """The presets an export is free in (up to 1080p): the format picker's list."""
    table = presets if presets is not None else load()
    return {k: p for k, p in table.items() if not is_paid(p)}


__all__ = ["PRESETS_PATH", "Preset", "PresetDataError", "UnknownPreset", "apply", "free", "get", "is_paid", "load", "long_for",
           "parse_preset", "preset_of", "problems"]
