"""Export presets: a closed, data-driven list of frame shapes the editor offers
for an export (YouTube wide, vertical for Shorts / Reels / TikTok, square, a
4:5 feed shape).

A preset is a label's worth of PARAMETERS and nothing else: a frame size, a
frame rate and a recommended length. It is not a new render path. Choosing one
only writes ``width`` / ``height`` / ``fps`` into the timeline document, and the
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
  also ``ffmpeg_limits.LARGE_OUTPUT_PX``: a preset never puts an export into the
  large-frame regime that needs the memory guards;
* the frame rate is one of ``timeline.FPS_VALUES``;
* the recommended length is at most ``editor_export.EXPORT_MAX_S`` (the export's
  own cap, the database's too), and a full-length video at the preset's frame
  stays inside the library's decode budget (``media_library.DECODE_BUDGET_PX``).

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

from modules import editor_export, ffmpeg_limits
from modules import media_library as ml
from modules import timeline as tl

PRESETS_PATH = Path(__file__).resolve().parent.parent / "schemas" / "export_presets.json"
VERSION = 1
_ID = re.compile(r"^[a-z0-9_]{1,32}$")
_KEYS = ("id", "width", "height", "fps", "max_duration_s")


class UnknownPreset(ValueError):
    """The id is not one of the closed list (or is not even a string)."""


class PresetDataError(ValueError):
    """The presets file breaks a rule above; the message says which."""


@dataclass(frozen=True)
class Preset:
    id: str
    width: int
    height: int
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
    if w * h > largest:
        raise PresetDataError(f"{where}: the frame is at most {largest} pixels (1440p); a bigger one needs "
                              "the large-frame memory guards a preset must not depend on")
    if not (_is_int(fps) and fps in tl.FPS_VALUES):
        raise PresetDataError(f"{where}: fps must be one of {', '.join(map(str, tl.FPS_VALUES))}")
    if not (_is_number(cap) and 0 < cap <= editor_export.EXPORT_MAX_S):
        raise PresetDataError(f"{where}: max_duration_s must be above 0 and at most "
                              f"{editor_export.EXPORT_MAX_S:g} (the export's own cap)")
    if ml.decode_work(w, h, fps, cap) > ml.DECODE_BUDGET_PX:
        raise PresetDataError(f"{where}: a video of max_duration_s at this frame passes the library's decode budget")
    return Preset(pid, w, h, fps, float(cap))


def load(path: Path = PRESETS_PATH) -> Dict[str, Preset]:
    """The presets by id, in file order. Raises PresetDataError for anything
    that is not the documented shape, a duplicate id, or two presets that are
    the same frame at the same rate (the picker tells them apart by the
    document's frame, so they must differ)."""
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
        if (p.width, p.height, p.fps) in frames:
            raise PresetDataError(f"preset {p.id!r} repeats another preset's frame and rate")
        frames.add((p.width, p.height, p.fps))
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
    """A copy of ``doc`` with the preset's frame size and rate and nothing else
    changed. It is NOT validated here: pass it to ``timeline.validate`` /
    ``timeline.load`` like any document (``problems`` below does)."""
    p = get(preset_id, presets)
    out = copy.deepcopy(dict(doc))
    out["width"], out["height"], out["fps"] = p.width, p.height, p.fps
    return out


def problems(doc: Mapping[str, Any], preset_id: Any, presets: Optional[Mapping[str, Preset]] = None) -> List[str]:
    """Why ``doc`` could not be exported at this preset: every rule of the
    timeline validator, applied to the document with the preset's frame. The
    recommended length is not one of them (see ``long_for``)."""
    return tl.validate(apply(doc, preset_id, presets))


def preset_of(doc: Mapping[str, Any], presets: Optional[Mapping[str, Preset]] = None) -> Optional[Preset]:
    """The preset a document's frame and rate are exactly, or None (a custom
    size, or a document from another tool: no preset is shown as chosen)."""
    table = presets if presets is not None else load()
    key = (doc.get("width"), doc.get("height"), doc.get("fps"))
    for p in table.values():
        if key == (p.width, p.height, p.fps):
            return p
    return None


def long_for(duration_s: float, preset: Preset) -> bool:
    """Is a video this long past the preset's recommended length?"""
    return duration_s > preset.max_duration_s


__all__ = ["PRESETS_PATH", "Preset", "PresetDataError", "UnknownPreset", "apply", "get", "load", "long_for",
           "parse_preset", "preset_of", "problems"]
