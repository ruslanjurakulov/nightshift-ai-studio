"""Creative OS timeline document v1 — load, validate, normalise, inspect.

A timeline is what a user edits in the studio (docs/CREATIVE_OS_PLAN.md §3.6):
a frame size and rate, tracks of clips that reference media-library assets by
id, text overlays and a captions track. It is stored as JSON (later as
append-only revisions, migration 0039) and rendered by the existing ffmpeg
engine through ``modules/timeline_render.py``.

The contract (JSON Schema twin: ``schemas/timeline.schema.json``; the
validator here is hand-written, like ``video_ir``'s, because ``jsonschema`` is
not a project dependency — tests keep the two in sync)::

    { version: 1, width, height, fps,
      tracks: [ { id, kind: "V"|"A"|"T", name?, clips: [...] } ],
      captions?: { style?: {...}, cues: [ { id, start_s, end_s, text } ] } }

    V clip: { id, asset_id, start_s, in_s, out_s, fit?, fade_in_s?, fade_out_s?,
              transition?: { type: "cut"|"dip_to_black"|"crossfade", duration_s },
              speed?: 0.5..2, audio?: bool }
    A clip: { id, asset_id, start_s, in_s, out_s, gain_db?, fade_in_s?, fade_out_s? }
    T clip: { id, start_s, end_s, text, font?, size?, color?, outline_color?,
              outline_width?, bold?, x?, y?, anchor?, fade_in_s?, fade_out_s? }

Rules this module keeps:

* **Assets are ids, never paths.** A document names ``asset_id`` (a uuid) and
  nothing else; turning an id into a file goes through an injected resolver,
  so the database layer decides what this organisation may use. An id the
  resolver does not return is refused — never skipped, never replaced.
* **One picture lane in v1.** Clips on a track may not overlap and there is at
  most one V track: picture-in-picture needs a different filter graph and is
  a later PR. Gaps in the picture render as black. The one exception is a
  cross-fade (below): two neighbouring V clips may share exactly its span.
* **Only deterministic transitions.** ``dip_to_black`` fades the previous clip
  out and this one in, inside their own spans, so no clip moves.
  ``crossfade`` blends the previous clip into this one: the clip STARTS
  ``duration_s`` (0.2-2 s) before the previous one ends, and that overlap is
  the dissolve. No material outside either clip's ``in_s``..``out_s`` is
  used (there are no hidden handles), so a cross-fade is never longer than
  either clip, and a clip's incoming and outgoing cross-fades never meet.
* **Times are seconds, normalised to milliseconds**, and the render cuts on
  the frame grid (``round(t * fps)``), so the same document always renders
  the same frames.
* **Speed changes how long a clip lasts, not what it shows.** ``in_s`` and
  ``out_s`` are SOURCE times; a V clip at ``speed`` 2 plays that range in
  half the time, so its end on the timeline is
  ``start_s + (out_s - in_s) / speed``. The range 0.5-2 is what one ffmpeg
  ``atempo`` stage keeps in tune, so a sped-up clip's own sound never needs
  a chain of filters to stay intelligible.
* **A video clip's own sound is opt-in** (``audio: true``) so documents
  written before it render exactly as they did. It follows the clip's trim
  and speed; a source with no sound track is silent, never an error.
"""

from __future__ import annotations

import copy
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

VERSION = 1
SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "timeline.schema.json"

KIND_V, KIND_A, KIND_T = "V", "A", "T"
TRACK_KINDS = (KIND_V, KIND_A, KIND_T)

#: Frame presets the studio offers. Width/height are what the document stores.
PRESETS: Dict[str, Tuple[int, int]] = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
}
FPS_VALUES = (24, 25, 30, 50, 60)
MIN_SIDE, MAX_SIDE = 16, 4096

#: Upper bounds that keep one document from tying up the render worker.
MAX_DURATION_S = 4 * 3600.0
MAX_TRACKS = 32
MAX_CLIPS_PER_TRACK = 2000
MAX_CUES = 5000
#: Every audio clip is one more input — one more open decoder — in the final
#: ffmpeg pass (render_spec._timeline_command), so they are counted per document.
MAX_AUDIO_CLIPS = 64
MAX_TOTAL_CLIPS = 5000
MAX_TEXT = 500
MAX_ID = 64
MAX_DOC_BYTES = 2_000_000

FITS = ("contain", "cover")
TRANSITIONS = ("cut", "dip_to_black", "crossfade")
#: A cross-fade's length: under 0.2 s it reads as a glitch, not a dissolve;
#: over 2 s both clips are half-visible for longer than a viewer will wait.
XFADE_MIN_S, XFADE_MAX_S = 0.2, 2.0
#: Times are milliseconds: a cross-fade's overlap must equal its duration to
#: within half of one (both validators use the same tolerance).
_XFADE_TOLERANCE = 0.0005
ANCHORS = ("top-left", "top", "top-right", "left", "center", "right",
           "bottom-left", "bottom", "bottom-right")
#: Fonts the render worker is expected to have (fonts-dejavu, fonts-liberation).
#: A closed list on purpose: libass silently substitutes a missing family.
FONTS = ("DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif")
GAIN_DB_MIN, GAIN_DB_MAX = -60.0, 12.0
SIZE_MIN, SIZE_MAX = 8, 512
OUTLINE_MAX = 20.0
#: Per-clip playback speed. One atempo stage covers exactly this range
#: (render_spec.SPEED_MIN/MAX are the same numbers; a test pins them).
SPEED_MIN, SPEED_MAX = 0.5, 2.0

ASSET_VIDEO, ASSET_IMAGE, ASSET_AUDIO = "video", "image", "audio"
#: Which asset kinds a clip on each track kind may use.
TRACK_ASSET_KINDS = {KIND_V: (ASSET_VIDEO, ASSET_IMAGE), KIND_A: (ASSET_AUDIO,)}

#: A pathological document must not become a megabyte of error text.
_MAX_REPORTED = 20

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

# Field lists — the schema's "required"/"properties" (tests pin them together).
_DOC_REQUIRED = ("version", "width", "height", "fps", "tracks")
_DOC_KEYS = _DOC_REQUIRED + ("captions",)
_TRACK_REQUIRED = ("id", "kind", "clips")
_TRACK_KEYS = _TRACK_REQUIRED + ("name",)
_MEDIA_REQUIRED = ("id", "asset_id", "start_s", "in_s", "out_s")
_V_CLIP_KEYS = _MEDIA_REQUIRED + ("fit", "fade_in_s", "fade_out_s", "transition", "speed", "audio")
_A_CLIP_KEYS = _MEDIA_REQUIRED + ("gain_db", "fade_in_s", "fade_out_s")
_T_REQUIRED = ("id", "start_s", "end_s", "text")
_TEXT_STYLE_KEYS = ("font", "size", "color", "outline_color", "outline_width", "bold")
_T_CLIP_KEYS = _T_REQUIRED + _TEXT_STYLE_KEYS + ("x", "y", "anchor", "fade_in_s", "fade_out_s")
_TRANSITION_KEYS = ("type", "duration_s")
_CAPTIONS_KEYS = ("style", "cues")
_CAPTION_STYLE_KEYS = _TEXT_STYLE_KEYS + ("y",)
_CUE_KEYS = ("id", "start_s", "end_s", "text")

#: Defaults normalise() fills in (and the schema documents).
TEXT_DEFAULTS = {"font": "DejaVu Sans", "size": 64, "color": "#FFFFFF",
                 "outline_color": "#000000", "outline_width": 3.0, "bold": False,
                 "x": 0.5, "y": 0.5, "anchor": "center", "fade_in_s": 0.0, "fade_out_s": 0.0}
CAPTION_STYLE_DEFAULTS = {"font": "DejaVu Sans", "size": 56, "color": "#FFFFFF",
                          "outline_color": "#000000", "outline_width": 3.0, "bold": True,
                          "y": 0.9}
V_DEFAULTS = {"fit": "contain", "fade_in_s": 0.0, "fade_out_s": 0.0,
              "transition": {"type": "cut", "duration_s": 0.0}, "speed": 1.0, "audio": False}
A_DEFAULTS = {"gain_db": 0.0, "fade_in_s": 0.0, "fade_out_s": 0.0}


class TimelineError(ValueError):
    """A timeline that cannot be rendered, with every reason found."""

    def __init__(self, problems: List[str]):
        self.problems = list(problems)
        super().__init__("invalid timeline: " + "; ".join(self.problems))


@dataclass(frozen=True)
class ResolvedAsset:
    """What the resolver knows about one asset: its kind (video, image,
    audio), the ABSOLUTE local file path the renderer reads (never a URL), and
    its duration (None for a still, or unknown). ``has_audio`` says whether a
    video carries a sound track (None = not known, treated as silent: an
    input with no audio stream would fail the whole mix)."""
    asset_id: str
    kind: str
    path: str
    duration_s: Optional[float] = None
    has_audio: Optional[bool] = None


#: asset_id → ResolvedAsset, or None when the asset does not exist or the
#: caller may not use it (the two are deliberately indistinguishable).
AssetResolver = Callable[[str], Optional[ResolvedAsset]]


# ── small predicates ────────────────────────────────────────────────────────

def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _ms(v: float) -> float:
    return round(float(v), 3)


def _where(track: dict, clip: Optional[dict] = None) -> str:
    t = f"track {track.get('id')!r}" if isinstance(track, dict) else "track"
    if clip is None:
        return t
    c = clip.get("id") if isinstance(clip, dict) else None
    return f"{t} clip {c!r}"


def _fields(obj, allowed, required, where, problems) -> bool:
    if not isinstance(obj, dict):
        problems.append(f"{where} must be an object")
        return False
    for k in required:
        if k not in obj:
            problems.append(f"{where}: {k} is missing")
    for k in obj:
        if k not in allowed:
            problems.append(f"{where}: {k} is not a known field")
    return True


def _num_in(obj, key, lo, hi, where, problems, *, exclusive_lo=False) -> None:
    if key not in obj:
        return  # a missing required key is reported by _fields
    v = obj[key]
    ok = _is_num(v) and (v > lo if exclusive_lo else v >= lo) and v <= hi
    if not ok:
        rng = f"{'>' if exclusive_lo else '>='} {lo:g} and <= {hi:g}"
        problems.append(f"{where}: {key} must be a number {rng} (got {v!r})")


def _text(obj, key, where, problems) -> None:
    if key not in obj:
        return
    v = obj[key]
    if not isinstance(v, str) or not v.strip() or len(v) > MAX_TEXT:
        problems.append(f"{where}: {key} must be non-empty text of at most {MAX_TEXT} characters")


def _text_style(obj, where, problems) -> None:
    if "font" in obj and obj["font"] not in FONTS:
        problems.append(f"{where}: font must be one of {list(FONTS)}")
    if "size" in obj and not (_is_int(obj["size"]) and SIZE_MIN <= obj["size"] <= SIZE_MAX):
        problems.append(f"{where}: size must be an integer from {SIZE_MIN} to {SIZE_MAX}")
    for k in ("color", "outline_color"):
        if k in obj and not (isinstance(obj[k], str) and _HEX_RE.match(obj[k])):
            problems.append(f"{where}: {k} must be a #RRGGBB colour")
    _num_in(obj, "outline_width", 0, OUTLINE_MAX, where, problems)
    if "bold" in obj and not isinstance(obj["bold"], bool):
        problems.append(f"{where}: bold must be true or false")


# ── validation ──────────────────────────────────────────────────────────────

def validate(doc: Any) -> List[str]:
    """Every reason ``doc`` is not a renderable timeline v1, as readable
    strings naming the track and clip. Empty list = valid. Pure; resolves no
    asset (that is :func:`resolve_assets`)."""
    problems: List[str] = []
    if not _fields(doc, _DOC_KEYS, _DOC_REQUIRED, "timeline", problems):
        return problems
    if doc.get("version") != VERSION:
        problems.append(f"timeline: version must be {VERSION} (got {doc.get('version')!r})")
    for k in ("width", "height"):
        v = doc.get(k)
        if not (_is_int(v) and MIN_SIDE <= v <= MAX_SIDE and v % 2 == 0):
            problems.append(f"timeline: {k} must be an even integer from {MIN_SIDE} to "
                            f"{MAX_SIDE} (H.264 4:2:0 needs even sides; got {v!r})")
    fps = doc.get("fps")
    if fps not in FPS_VALUES or not _is_int(fps):
        problems.append(f"timeline: fps must be one of {list(FPS_VALUES)} (got {fps!r})")
        fps = None

    ids: Dict[str, str] = {}

    def claim(ident, where):
        if not (isinstance(ident, str) and _ID_RE.match(ident)):
            problems.append(f"{where}: id must be 1-{MAX_ID} letters, digits, '_' or '-'")
        elif ident in ids:
            problems.append(f"{where}: id {ident!r} is already used by {ids[ident]}")
        else:
            ids[ident] = where

    tracks = doc.get("tracks")
    if not isinstance(tracks, list):
        problems.append("timeline: tracks must be a list")
        tracks = []
    elif len(tracks) > MAX_TRACKS:
        problems.append(f"timeline: at most {MAX_TRACKS} tracks")
    v_tracks = 0
    for ti, track in enumerate(tracks):
        where = f"tracks[{ti}]"
        if not _fields(track, _TRACK_KEYS, _TRACK_REQUIRED, where, problems):
            continue
        where = _where(track)
        claim(track.get("id"), where)
        kind = track.get("kind")
        if kind not in TRACK_KINDS:
            problems.append(f"{where}: kind must be one of {list(TRACK_KINDS)}")
            continue
        if kind == KIND_V:
            v_tracks += 1
        if "name" in track and not (isinstance(track["name"], str) and len(track["name"]) <= 100):
            problems.append(f"{where}: name must be text of at most 100 characters")
        clips = track.get("clips")
        if not isinstance(clips, list):
            problems.append(f"{where}: clips must be a list")
            continue
        if len(clips) > MAX_CLIPS_PER_TRACK:
            problems.append(f"{where}: at most {MAX_CLIPS_PER_TRACK} clips per track")
            continue
        for ci, clip in enumerate(clips):
            cwhere = f"{where} clips[{ci}]"
            if isinstance(clip, dict) and "id" in clip:
                cwhere = _where(track, clip)
            if kind == KIND_T:
                _validate_text_clip(clip, cwhere, problems, claim)
            else:
                _validate_media_clip(clip, kind, cwhere, fps, problems, claim)
    if v_tracks > 1:
        problems.append("timeline: only one video (V) track is supported — overlapping "
                        "video (picture-in-picture) is not available yet")
    counted = [t for t in tracks if isinstance(t, dict) and isinstance(t.get("clips"), list)]
    # A video clip that plays its own sound is one more audio input too.
    n_audio = sum(len(t["clips"]) for t in counted if t.get("kind") == KIND_A)
    n_audio += sum(1 for t in counted if t.get("kind") == KIND_V
                   for c in t["clips"] if isinstance(c, dict) and c.get("audio") is True)
    if n_audio > MAX_AUDIO_CLIPS:
        problems.append(f"timeline: at most {MAX_AUDIO_CLIPS} audio clips in one timeline "
                        f"(got {n_audio}) — join short pieces into one file")
    if sum(len(t["clips"]) for t in counted) > MAX_TOTAL_CLIPS:
        problems.append(f"timeline: at most {MAX_TOTAL_CLIPS} clips in one timeline")

    captions = doc.get("captions")
    if captions is not None:
        _validate_captions(captions, problems, claim)

    if problems:
        return problems
    # Semantic checks need a structurally valid document.
    found = overlaps(doc)
    for ov in found[:_MAX_REPORTED]:
        problems.append(f"track {ov[0]!r}: clips {ov[1]!r} and {ov[2]!r} overlap "
                        f"({ov[3]:.3f}-{ov[4]:.3f} s) — move one to another track")
    if len(found) > _MAX_REPORTED:
        problems.append(f"... and {len(found) - _MAX_REPORTED} more overlaps")
    problems.extend(_transition_problems(doc))
    total = duration_s(doc)
    if total <= 0:
        problems.append("timeline: nothing to render — add a clip, a text or a caption")
    elif total > MAX_DURATION_S:
        problems.append(f"timeline: longer than {MAX_DURATION_S / 3600:g} hours ({total:.3f} s)")
    return problems


def _validate_media_clip(clip, kind, where, fps, problems, claim) -> None:
    keys = _V_CLIP_KEYS if kind == KIND_V else _A_CLIP_KEYS
    if not _fields(clip, keys, _MEDIA_REQUIRED, where, problems):
        return
    claim(clip.get("id"), where)
    aid = clip.get("asset_id")
    if not (isinstance(aid, str) and _UUID_RE.match(aid)):
        problems.append(f"{where}: asset_id must be a uuid (got {aid!r})")
    for k in ("start_s", "in_s", "out_s"):
        _num_in(clip, k, 0, MAX_DURATION_S, where, problems)
    for k in ("fade_in_s", "fade_out_s"):
        _num_in(clip, k, 0, MAX_DURATION_S, where, problems)
    speed = 1.0
    if kind == KIND_V and "speed" in clip:
        _num_in(clip, "speed", SPEED_MIN, SPEED_MAX, where, problems)
        speed = clip["speed"] if (_is_num(clip["speed"]) and SPEED_MIN <= clip["speed"] <= SPEED_MAX) else None
    if kind == KIND_V and "audio" in clip and not isinstance(clip["audio"], bool):
        problems.append(f"{where}: audio must be true or false")
    ins, outs = clip.get("in_s"), clip.get("out_s")
    if _is_num(ins) and _is_num(outs) and speed:
        # How long the clip lasts ON THE TIMELINE: the source range at its speed.
        length = _ms((_ms(outs) - _ms(ins)) / speed)
        if _ms(outs) - _ms(ins) <= 0:
            problems.append(f"{where}: out_s ({outs}) must be greater than in_s ({ins})")
        elif fps and round(length * fps) < 1:
            problems.append(f"{where}: shorter than one frame at {fps} fps")
        elif (_is_num(clip.get("fade_in_s", 0)) and _is_num(clip.get("fade_out_s", 0))
              and clip.get("fade_in_s", 0) + clip.get("fade_out_s", 0) > length + 1e-9):
            problems.append(f"{where}: fade_in_s + fade_out_s is longer than the clip ({length:.3f} s)")
    if kind == KIND_V:
        if "fit" in clip and clip["fit"] not in FITS:
            problems.append(f"{where}: fit must be one of {list(FITS)}")
        if "transition" in clip:
            tr = clip["transition"]
            if _fields(tr, _TRANSITION_KEYS, _TRANSITION_KEYS, f"{where} transition", problems):
                if tr.get("type") not in TRANSITIONS:
                    problems.append(f"{where}: transition type must be one of {list(TRANSITIONS)}")
                if tr.get("type") == "crossfade":
                    _num_in(tr, "duration_s", XFADE_MIN_S, XFADE_MAX_S, f"{where} transition", problems)
                else:
                    _num_in(tr, "duration_s", 0, 10.0, f"{where} transition", problems)
    else:
        _num_in(clip, "gain_db", GAIN_DB_MIN, GAIN_DB_MAX, where, problems)


def _validate_timed_text(obj, where, problems) -> None:
    for k in ("start_s", "end_s"):
        _num_in(obj, k, 0, MAX_DURATION_S, where, problems)
    s, e = obj.get("start_s"), obj.get("end_s")
    if _is_num(s) and _is_num(e) and _ms(e) <= _ms(s):
        problems.append(f"{where}: end_s ({e}) must be greater than start_s ({s})")
    _text(obj, "text", where, problems)


def _validate_text_clip(clip, where, problems, claim) -> None:
    if not _fields(clip, _T_CLIP_KEYS, _T_REQUIRED, where, problems):
        return
    claim(clip.get("id"), where)
    _validate_timed_text(clip, where, problems)
    _text_style(clip, where, problems)
    for k in ("x", "y"):
        _num_in(clip, k, 0, 1, where, problems)
    if "anchor" in clip and clip["anchor"] not in ANCHORS:
        problems.append(f"{where}: anchor must be one of {list(ANCHORS)}")
    for k in ("fade_in_s", "fade_out_s"):
        _num_in(clip, k, 0, MAX_DURATION_S, where, problems)
    s, e = clip.get("start_s"), clip.get("end_s")
    fi, fo = clip.get("fade_in_s", 0), clip.get("fade_out_s", 0)
    if all(_is_num(v) for v in (s, e, fi, fo)) and e > s and fi + fo > (e - s) + 1e-9:
        problems.append(f"{where}: fade_in_s + fade_out_s is longer than the text is shown")


def _validate_captions(captions, problems, claim) -> None:
    if not _fields(captions, _CAPTIONS_KEYS, ("cues",), "captions", problems):
        return
    style = captions.get("style")
    if style is not None and _fields(style, _CAPTION_STYLE_KEYS, (), "captions style", problems):
        _text_style(style, "captions style", problems)
        _num_in(style, "y", 0, 1, "captions style", problems)
    cues = captions.get("cues")
    if not isinstance(cues, list):
        problems.append("captions: cues must be a list")
        return
    if len(cues) > MAX_CUES:
        problems.append(f"captions: at most {MAX_CUES} cues")
        return
    for i, cue in enumerate(cues):
        where = f"captions cues[{i}]"
        if not _fields(cue, _CUE_KEYS, _CUE_KEYS, where, problems):
            continue
        where = f"caption {cue.get('id')!r}"
        claim(cue.get("id"), where)
        _validate_timed_text(cue, where, problems)


# ── inspection (on a structurally valid document) ───────────────────────────

def clip_speed(clip: dict) -> float:
    """A media clip's playback speed (1 when it has none)."""
    v = clip.get("speed", 1.0)
    return float(v) if _is_num(v) and v > 0 else 1.0


def clip_end_s(clip: dict) -> float:
    """Where a clip ends on the timeline, in seconds (ms-rounded): a text's
    ``end_s``, or a media clip's start plus its source range at its speed."""
    if "end_s" in clip:
        return _ms(clip["end_s"])
    return _ms(_ms(clip["start_s"]) + (_ms(clip["out_s"]) - _ms(clip["in_s"])) / clip_speed(clip))


def _spans(doc: dict):
    """(lane id, item id, start, end) for every timed item, per lane, sorted."""
    lanes: List[Tuple[str, List[Tuple[float, float, str]]]] = []
    for track in doc.get("tracks") or []:
        items = sorted((_ms(c["start_s"]), clip_end_s(c), str(c["id"]))
                       for c in track.get("clips") or [])
        lanes.append((str(track["id"]), items))
    cues = ((doc.get("captions") or {}).get("cues")) or []
    if cues:
        lanes.append(("captions", sorted((_ms(c["start_s"]), _ms(c["end_s"]), str(c["id"]))
                                         for c in cues)))
    return lanes


def duration_s(doc: dict) -> float:
    """The timeline's length: where its last clip, text or caption ends."""
    ends = [end for _lane, items in _spans(doc) for (_s, end, _i) in items]
    return max(ends) if ends else 0.0


def overlaps(doc: dict) -> List[Tuple[str, str, str, float, float]]:
    """``(track id, clip a, clip b, from_s, to_s)`` for every pair of items on
    the same track (or among the captions) that are on screen at once.
    Touching (one ends where the next starts) is not an overlap, and neither
    is a cross-fade's own overlap with the clip before it."""
    blended = {(str(t["id"]), str(p["id"]), str(c["id"]))
               for t in doc.get("tracks") or [] if t.get("kind") == KIND_V
               for p, c, _d in crossfades(t)}
    found = []
    for lane, items in _spans(doc):
        for i, (s1, e1, id1) in enumerate(items):
            for s2, e2, id2 in items[i + 1:]:
                if s2 >= e1:
                    break  # sorted by start: nothing later can overlap this one
                if (lane, id1, id2) in blended:
                    continue
                found.append((lane, id1, id2, s2, min(e1, e2)))
    return found


def _sorted_clips(track: dict) -> List[dict]:
    return sorted(track.get("clips") or [], key=lambda c: (_ms(c["start_s"]), str(c["id"])))


def crossfade_s(clip: dict) -> float:
    """A V clip's cross-fade from the clip before it, in seconds (0 = none)."""
    tr = clip.get("transition") or {}
    if tr.get("type") != "crossfade" or not _is_num(tr.get("duration_s")):
        return 0.0
    return _ms(tr["duration_s"])


def crossfades(track: dict) -> List[Tuple[dict, dict, float]]:
    """``(previous clip, clip, seconds)`` for every cross-fade on a V track
    that is laid out as one: the clip starts exactly its duration before the
    previous clip (by start time) ends. Anything else is a problem
    :func:`validate` reports, not a cross-fade."""
    out = []
    clips = _sorted_clips(track)
    for i, clip in enumerate(clips):
        d = crossfade_s(clip)
        if i == 0 or d <= 0:
            continue
        prev = clips[i - 1]
        if abs((clip_end_s(prev) - _ms(clip["start_s"])) - d) < _XFADE_TOLERANCE:
            out.append((prev, clip, d))
    return out


def gaps(doc: dict, track_id: Optional[str] = None) -> List[Tuple[str, float, float]]:
    """``(track id, from_s, to_s)`` for every stretch of a track (by default the
    V track) with nothing on it, up to the end of the timeline. In the video
    lane a gap renders as black; in an audio lane as silence."""
    total = duration_s(doc)
    out = []
    for track in doc.get("tracks") or []:
        if track_id is None and track.get("kind") != KIND_V:
            continue
        if track_id is not None and track.get("id") != track_id:
            continue
        cursor = 0.0
        for s, e, _cid in sorted((_ms(c["start_s"]), clip_end_s(c), str(c["id"]))
                                 for c in track.get("clips") or []):
            if s > cursor:
                out.append((str(track["id"]), cursor, s))
            cursor = max(cursor, e)
        if cursor < total:
            out.append((str(track["id"]), cursor, total))
    return out


def effective_fades(track: dict) -> Dict[str, Tuple[float, float]]:
    """clip id → (fade in, fade out) seconds for a V track after transitions:
    a ``dip_to_black`` of d seconds into clip B fades B in over d/2 and — when
    A ends exactly where B starts — A out over d/2. A clip's own fades still
    apply; the longer of the two wins."""
    clips = sorted(track.get("clips") or [], key=lambda c: (_ms(c["start_s"]), str(c["id"])))
    fades = {str(c["id"]): [float(c.get("fade_in_s", 0) or 0), float(c.get("fade_out_s", 0) or 0)]
             for c in clips}
    for i, clip in enumerate(clips):
        tr = clip.get("transition") or {}
        if tr.get("type") != "dip_to_black" or not tr.get("duration_s"):
            continue
        half = float(tr["duration_s"]) / 2
        cid = str(clip["id"])
        fades[cid][0] = max(fades[cid][0], half)
        if i > 0 and clip_end_s(clips[i - 1]) == _ms(clip["start_s"]):
            pid = str(clips[i - 1]["id"])
            fades[pid][1] = max(fades[pid][1], half)
    return {k: (round(v[0], 3), round(v[1], 3)) for k, v in fades.items()}


def _crossfade_problems(track: dict) -> List[str]:
    """A cross-fade needs a clip before it that it overlaps by exactly its
    duration, may not be longer than either clip, and may not run into the
    clip's other cross-fade (no material outside in..out exists to show)."""
    problems = []
    clips = _sorted_clips(track)
    laid = {str(c["id"]) for _p, c, _d in crossfades(track)}
    into: Dict[str, float] = {}
    out_of: Dict[str, float] = {}
    for i, clip in enumerate(clips):
        d = crossfade_s(clip)
        if d <= 0:
            continue
        where = _where(track, clip)
        if i == 0:
            problems.append(f"{where}: a cross-fade needs a clip before it")
            continue
        prev = clips[i - 1]
        if str(clip["id"]) not in laid:
            problems.append(f"{where}: a {d:.3f} s cross-fade must start {d:.3f} s before clip "
                            f"{prev['id']!r} ends (it starts "
                            f"{clip_end_s(prev) - _ms(clip['start_s']):.3f} s before)")
            continue
        for c in (prev, clip):
            length = clip_end_s(c) - _ms(c["start_s"])
            if d > length + 1e-9:
                problems.append(f"{where}: the cross-fade ({d:.3f} s) is longer than clip "
                                f"{c['id']!r} ({length:.3f} s)")
        into[str(clip["id"])] = d
        out_of[str(prev["id"])] = d
    for clip in clips:
        cid = str(clip["id"])
        a, b = into.get(cid, 0.0), out_of.get(cid, 0.0)
        length = clip_end_s(clip) - _ms(clip["start_s"])
        if a and b and a + b > length + 1e-9:
            problems.append(f"{_where(track, clip)}: its cross-fades ({a:.3f} + {b:.3f} s) are "
                            f"longer than the clip ({length:.3f} s)")
    return problems


def _transition_problems(doc: dict) -> List[str]:
    problems = []
    for track in doc.get("tracks") or []:
        if track.get("kind") != KIND_V:
            continue
        problems.extend(_crossfade_problems(track))
        fades = effective_fades(track)
        for clip in track.get("clips") or []:
            fi, fo = fades[str(clip["id"])]
            length = clip_end_s(clip) - _ms(clip["start_s"])
            if fi + fo > length + 1e-9:
                problems.append(f"{_where(track, clip)}: its fades and transitions "
                                f"({fi:.3f} + {fo:.3f} s) are longer than the clip ({length:.3f} s)")
    return problems


# ── normalisation / loading ─────────────────────────────────────────────────

def normalise(doc: dict) -> dict:
    """A canonical copy of a VALID document: defaults filled in, times rounded
    to milliseconds, asset ids lower-case, clips and cues sorted by start (then
    id). Track order is kept — it is the layering of text tracks. Two documents
    that mean the same thing normalise to the same dict."""
    out = {"version": VERSION, "width": doc["width"], "height": doc["height"],
           "fps": doc["fps"], "tracks": []}
    for track in doc["tracks"]:
        kind = track["kind"]
        t = {"id": track["id"], "kind": kind, "clips": []}
        if "name" in track:
            t["name"] = track["name"]
        for clip in track["clips"]:
            if kind == KIND_T:
                c = {**copy.deepcopy(TEXT_DEFAULTS), **copy.deepcopy(clip)}
                for k in ("start_s", "end_s", "fade_in_s", "fade_out_s", "x", "y"):
                    c[k] = _ms(c[k])
                c["outline_width"] = float(c["outline_width"])
            else:
                defaults = V_DEFAULTS if kind == KIND_V else A_DEFAULTS
                c = {**copy.deepcopy(defaults), **copy.deepcopy(clip)}
                c["asset_id"] = c["asset_id"].lower()
                for k in ("start_s", "in_s", "out_s", "fade_in_s", "fade_out_s"):
                    c[k] = _ms(c[k])
                if kind == KIND_V:
                    c["transition"] = {"type": c["transition"]["type"],
                                       "duration_s": _ms(c["transition"]["duration_s"])}
                    c["speed"] = _ms(c["speed"])
                else:
                    c["gain_db"] = _ms(c["gain_db"])
            t["clips"].append(c)
        t["clips"].sort(key=lambda c: (c["start_s"], c["id"]))
        out["tracks"].append(t)
    if doc.get("captions") is not None:
        style = {**CAPTION_STYLE_DEFAULTS, **(doc["captions"].get("style") or {})}
        style["y"] = _ms(style["y"])
        style["outline_width"] = float(style["outline_width"])
        cues = sorted(({"id": c["id"], "start_s": _ms(c["start_s"]), "end_s": _ms(c["end_s"]),
                        "text": c["text"]} for c in doc["captions"]["cues"]),
                      key=lambda c: (c["start_s"], c["id"]))
        out["captions"] = {"style": style, "cues": cues}
    return out


def _reject_constant(name):
    raise ValueError(f"{name} is not a number a timeline can use")


def load(data: Union[str, bytes, dict]) -> dict:
    """Parse (when given JSON text), validate and normalise a timeline.
    Raises :class:`TimelineError` listing every problem. NaN/Infinity, which
    Python's json accepts by default, are refused."""
    if isinstance(data, (str, bytes)):
        if len(data) > MAX_DOC_BYTES:
            raise TimelineError([f"timeline: larger than {MAX_DOC_BYTES} bytes"])
        try:
            data = json.loads(data, parse_constant=_reject_constant)
        except (ValueError, RecursionError) as e:
            raise TimelineError([f"timeline: not valid JSON ({type(e).__name__})"]) from None
    problems = validate(data)
    if problems:
        raise TimelineError(problems)
    return normalise(data)


def new_timeline(preset: str = "16:9", fps: int = 30) -> dict:
    """An empty, valid-shaped document for a studio preset (9:16, 16:9, 1:1)."""
    if preset not in PRESETS:
        raise TimelineError([f"unknown preset {preset!r} — use one of {list(PRESETS)}"])
    if fps not in FPS_VALUES:
        raise TimelineError([f"fps must be one of {list(FPS_VALUES)}"])
    width, height = PRESETS[preset]
    return {"version": VERSION, "width": width, "height": height, "fps": fps,
            "tracks": [{"id": "v1", "kind": KIND_V, "clips": []}]}


# ── edits ───────────────────────────────────────────────────────────────────

def split_clip(doc: dict, clip_id: str, at_s: float, new_id: str) -> dict:
    """A copy of ``doc`` with media clip ``clip_id`` cut in two at timeline time
    ``at_s``: the first part keeps the id, its fade-in and transition; the
    second (``new_id``) continues from the same source point with the fade-out.
    The timeline's length and every other clip are unchanged; for a video,
    a split on the frame grid plays the same source frames as before. Both
    halves keep the clip's speed and sound: ``at_s`` is timeline time, so the
    source cut is ``in_s + (at_s - start_s) * speed``."""
    out = copy.deepcopy(doc)
    for track in out.get("tracks") or []:
        for i, clip in enumerate(track.get("clips") or []):
            if clip.get("id") != clip_id:
                continue
            if track.get("kind") == KIND_T:
                raise TimelineError([f"clip {clip_id!r} is text — change its times instead"])
            start, end = _ms(clip["start_s"]), clip_end_s(clip)
            at = _ms(at_s)
            if not start < at < end:
                raise TimelineError([f"split point {at} s is not inside clip {clip_id!r} "
                                     f"({start}-{end} s)"])
            cut = _ms(_ms(clip["in_s"]) + (at - start) * clip_speed(clip))
            if not _ms(clip["in_s"]) < cut < _ms(clip["out_s"]):
                raise TimelineError([f"split point {at} s is too close to an end of clip {clip_id!r}"])
            second = copy.deepcopy(clip)
            second.update(id=new_id, start_s=at, in_s=cut, fade_in_s=0.0)
            second.pop("transition", None)
            clip.update(out_s=cut, fade_out_s=0.0)
            track["clips"].insert(i + 1, second)
            return out
    raise TimelineError([f"no clip {clip_id!r} in this timeline"])


# ── assets ──────────────────────────────────────────────────────────────────

def _local_path(path) -> bool:
    return (isinstance(path, str) and path.startswith("/")
            and not any(ord(ch) < 32 or ord(ch) == 127 for ch in path))


def asset_ids(doc: dict) -> List[str]:
    """Every asset id the document uses, lower-case, sorted, once each."""
    return sorted({str(c["asset_id"]).lower() for t in doc.get("tracks") or []
                   for c in t.get("clips") or [] if "asset_id" in c})


def resolve_assets(doc: dict, resolver: AssetResolver) -> Dict[str, ResolvedAsset]:
    """Look up every asset through ``resolver`` (once each, in sorted order) and
    check each clip against what came back. Raises :class:`TimelineError` for
    an asset the resolver does not return — unknown, deleted or another
    organisation's, which it must not distinguish — for the wrong kind of
    asset on a track, and for a clip reaching past the end of its source.
    Anything the resolver itself raises (a database outage) propagates as is:
    that is not a problem with the timeline."""
    found: Dict[str, ResolvedAsset] = {}
    problems: List[str] = []
    for aid in asset_ids(doc):
        asset = resolver(aid)
        if asset is None:
            problems.append(f"asset {aid} is not available (unknown, deleted, or not in "
                            "this organization)")
            continue
        found[aid] = asset
    for track in doc.get("tracks") or []:
        allowed = TRACK_ASSET_KINDS.get(track.get("kind"))
        if not allowed:
            continue
        for clip in track.get("clips") or []:
            asset = found.get(str(clip["asset_id"]).lower())
            if asset is None:
                continue
            where = _where(track, clip)
            if asset.kind not in allowed:
                problems.append(f"{where}: asset {asset.asset_id} is {asset.kind!r}; a "
                                f"{track['kind']} track takes {' or '.join(allowed)}")
                continue
            if not _local_path(asset.path):
                # The path reaches ffmpeg as an input and a concat-list line: a
                # URL or protocol ("http:", "concat:") would make it fetch, and
                # a newline would add list directives. Storage paths are
                # absolute local files, so anything else is a resolver bug.
                problems.append(f"{where}: asset {asset.asset_id} has no local file to render from")
                continue
            dur = asset.duration_s
            if asset.kind != ASSET_IMAGE and dur is not None and _ms(clip["out_s"]) > _ms(dur) + 0.001:
                problems.append(f"{where}: out_s {clip['out_s']} is past the end of asset "
                                f"{asset.asset_id} ({dur} s)")
    if problems:
        raise TimelineError(problems)
    return found
