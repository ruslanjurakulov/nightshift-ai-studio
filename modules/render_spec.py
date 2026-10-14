"""Declarative render spec + an ffmpeg command builder.

Why this exists (Phase 1 evidence)
----------------------------------
The render-stability investigation (Phase 1) found the memory/■process problem
was moviepy's, not Python's: MoviePy 1.0.3 keeps every source clip's decoder
alive for the whole render because composed clips pull frames lazily, so a
twelve-clip 1080p render sat near 1 GB with orphaned ffmpeg children (see
tests/test_compositor_readers.py). The durable fix is to stop composing in
Python at all and hand a *description* of the video to ffmpeg, which streams it
segment by segment without holding twelve decoders open.

This module is that description — a **declarative RenderSpec** — plus the
translation of a spec into an ffmpeg invocation. It is deliberately split from
execution:

  * The spec, its validation, and its serialization are pure and fully tested
    here.
  * `build_ffmpeg_command` returns the argument list for the standard
    concat-demuxer + audio-mux pattern; it runs nothing.
  * Actually executing that command (and normalising segments so the concat
    demuxer accepts them — same codec/size/fps) is the ffmpeg **backend**, a
    deliberate follow-up that needs ffmpeg present to validate end to end.
    Until then moviepy remains the live renderer; this ships the foundation the
    backend is built on, the way the other decision layers landed first.

Timeline extension (Creative OS, modules/timeline_render.py)
------------------------------------------------------------
A user timeline needs four things the pipeline's concat model never did: a
trim point into a source clip, more than one audio file (music under a
voice-over, each with its own gain, fades and start), text overlays, and
segment lengths that are exact in frames. Each is an OPTIONAL field whose
default is today's behaviour, and nothing new is emitted unless a field is
set — so a spec the pipeline builds serialises and renders to the same
argv, byte for byte, as before (tests/test_render_spec_legacy.py pins that
against the argv captured from the code before this extension):

  * ``Segment.in_s`` / ``fit`` / ``fade_in_s`` / ``fade_out_s`` — trim,
    cover-crop instead of letterbox, and fades from/to black.
  * ``RenderSpec.frame_exact`` — segment lengths are ``round(duration * fps)``
    frames (``-frames:v``) instead of ``-t``. Measured with ffmpeg 7 at 30 fps:
    a 1.067 s colour segment came out 33 frames (not 32) and an input-seeked
    clip one frame short, while ``-frames:v`` concatenated to the exact total.
  * ``RenderSpec.audio_tracks`` — replaces the single ``audio_path`` (they are
    mutually exclusive): each track is trimmed, gained, faded and delayed,
    then ``amix``-ed without normalisation and cut to the video's length.
  * ``RenderSpec.overlays`` — text, written by ``ass_captions`` to one ASS
    file the backend burns in with the same ``subtitles`` filter.
  * ``Segment.speed`` / ``AudioTrack.speed`` — play a source faster or
    slower (0.5-2). The picture is retimed with ``setpts`` before it is
    fitted and resampled to the output rate; the sound with one ``atempo``
    stage, which keeps its pitch. Text never reaches a filter graph: it goes
    into the ASS file, escaped by ``ass_captions.escape_text``.
  * ``Segment.clip_s`` / ``offset_s`` / ``seed`` / ``xfade`` — a cross-fade.
    A clip that dissolves into the next is rendered as pieces: each piece is
    ``duration`` seconds of a clip ``clip_s`` long, starting ``offset_s``
    into it (fades and a still's move are computed over the whole clip, so
    they carry on across the cut), and the overlap is one segment whose
    ``xfade`` is the incoming clip's head — the backend blends the two with
    ffmpeg ``xfade``. The picture stays a concatenation of exactly the
    timeline's frames, so nothing else in the render changes.
    ``Segment.xfade_style`` is which ``xfade`` transition does the blend (one of
    ``XFADE_STYLES``; the default ``fade`` is the plain dissolve, and a segment
    without a style serialises and renders exactly as before).
  * ``AudioTrack.crossfade_s`` — this track is joined to the one before it
    with ``acrossfade`` over that many seconds (a cross-fade between two
    clips that both play their own sound).
  * ``AudioTrack.duck_*`` — music ducking. While any of ``duck_spans`` (where
    speech plays, merged by the caller) is on, the track is lowered by exactly
    ``duck_db``: down over ``duck_attack_s`` ending where the span starts,
    back up over ``duck_release_s`` from where it ends. It is one ``volume``
    filter with a time expression — numbers this code formats, never text
    from a document — placed after the track's delay, so ``t`` is output time.
    A sidechain compressor was not used: it lowers by a ratio of whatever the
    speech level happens to be, so "12 dB" would mean something different on
    every clip, and a track's gain would change what it does.
  * ``TextOverlay.caption_style`` / ``highlight_color`` - a caption cue in one
    of the ten ready-made animated styles (modules/caption_styles.py); the ASS
    file gets the style's own tags for it, from a closed list and clamped
    numbers. Absent = the plain overlay, byte for byte.
  * ``RenderSpec.picture_overlays`` — a picture or a video laid over the
    composited picture for a span of frames (picture-in-picture, a sticker, a
    logo): placed by its centre, sized by its width, with an opacity. They
    are inputs of the final pass (``picture_overlay_inputs`` /
    ``picture_overlay_filters``), below the text. Every number in the filter
    graph is formatted here from a validated float; a document's text never
    reaches it.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

from modules import caption_styles, ffmpeg_limits, speed_ramp

#: The ONE quality encode of a render (the final pass). These are libx264's own
#: defaults — what this backend always encoded with implicitly — spelled out so
#: that the quality of the output is a decision in the code, not an accident of
#: the encoder's build. Segment normalisation writes a fast intermediate
#: instead (render_backend.INTERMEDIATE_X264), so this is not paid twice.
FINAL_X264: tuple = ("-preset", "medium", "-crf", "23")


def final_x264(spec: "RenderSpec") -> tuple:
    """FINAL_X264 for this render. A timeline whose frame is larger than
    2560x1440 also shortens libx264's lookahead to 20 frames (medium's is
    40): at 4K the default does not fit the export's memory limit
    (ffmpeg_limits.LARGE_OUTPUT_PX, BR-L-014). The pipeline's renders and
    ordinary timelines keep exactly FINAL_X264."""
    if spec.frame_exact and spec.width * spec.height > ffmpeg_limits.LARGE_OUTPUT_PX:
        return FINAL_X264 + ("-rc-lookahead", "20")
    return FINAL_X264

#: The largest frame, in pixels, ffmpeg may decode for a timeline (an editor
#: export reads library media members uploaded): a still, and a video frame.
#: The same numbers as media_library.MAX_PIXELS / VIDEO_MAX_PIXELS / MAX_SIDE
#: (a test pins them equal): the upload probe only sees a video's first
#: frames, and a stream can switch to a bigger frame at a later keyframe
#: (BR-L-004), so the decoder itself refuses it.
DECODE_MAX_PIXELS = 100_000_000
DECODE_VIDEO_MAX_PIXELS = 8192 * 4352
DECODE_MAX_SIDE = 16384
#: libavcodec's ff_get_buffer checks ``FFALIGN(width, STRIDE_ALIGN) * height``
#: against ``-max_pixels``; STRIDE_ALIGN is 64 on an AVX-512 build (the
#: bundled ffmpeg 7.0.2), 32 or 16 on others.
DECODE_ROW_ALIGN = 64


def decoder_max_pixels(pixels: int, max_side: int = DECODE_MAX_SIDE) -> int:
    """The ``-max_pixels`` value that lets the decoder take every frame the
    upload check accepts (BR-L-009). The check accepts ``w*h <= pixels`` with
    ``h <= max_side``; the decoder counts the width rounded up to 64, at most
    ``(w + 63) * h = w*h + 63*h``. Measured with the real cap: a 10000x10000
    JPEG (the exact cap, accepted at upload) was refused by a bare
    ``-max_pixels 100000000``, as 10048 x 10000. The headroom is at most
    1 032 192 px (1 % of the still cap), and only ever that one row padding."""
    return int(pixels) + (DECODE_ROW_ALIGN - 1) * int(max_side)


#: Before every input of a timeline command: ffmpeg may open the ``file`` protocol and
#: nothing else. A library file is a stranger's bytes; a container that names another
#: input (an HLS playlist, a concat script, an ``http:`` or ``tcp:`` url) must not make
#: the render open it. The upload probe and thumbnail commands pin the same
#: whitelist (media_library); the concat list of the final pass is a ``file`` too.
INPUT_PROTOCOLS = ("-protocol_whitelist", "file")


def cap_inputs(cmd: List[str], *, video_inputs: Sequence[str] = (),
               out_pixels: Optional[int] = None) -> List[str]:
    """``cmd`` as an editor export runs it: before every ``-i``, the
    protocol whitelist (``INPUT_PROTOCOLS``), the decoder's frame cap
    (``-max_pixels``: the video cap for an input in ``video_inputs``, the
    still cap for any other) and its thread count; the
    filter graphs' thread counts after the program name, and the encoder's
    before the output (ffmpeg_limits: the footprint must not grow with the
    host's cores under the child's memory limit). A frame the cap
    refuses is not skipped: ``render_backend._run`` reads ffmpeg's stderr and
    fails the command (ffmpeg_limits.REFUSAL_MARKERS; ``-xerror`` is not used,
    it also failed damaged-but-playable clips, BR-L-008). Only timeline
    commands are capped: the pipeline's own renders keep their byte-pinned
    argv (tests/test_render_spec_legacy.py)."""
    videos = set(video_inputs)
    out: List[str] = [cmd[0], *ffmpeg_limits.thread_options()]
    for i, tok in enumerate(cmd[1:-1], start=1):
        if tok == "-i":
            src = cmd[i + 1]
            cap = DECODE_VIDEO_MAX_PIXELS if src in videos else DECODE_MAX_PIXELS
            out += ["-max_pixels", str(decoder_max_pixels(cap)), *ffmpeg_limits.decode_thread_options(),
                    *INPUT_PROTOCOLS]
        out.append(tok)
    # The encoder's threads, right before the output (the last argument).
    return out + [*ffmpeg_limits.encode_thread_options(out_pixels=out_pixels), cmd[-1]]

KIND_VIDEO = "video"
KIND_IMAGE = "image"
KIND_COLOR = "color"   # a solid-colour placeholder segment (no source file)
_KINDS = (KIND_VIDEO, KIND_IMAGE, KIND_COLOR)

FIT_CONTAIN = "contain"   # letter/pillar-box inside the frame (the original behaviour)
FIT_COVER = "cover"       # fill the frame, cropping the overflow
FIT_BLUR = "blur"         # the whole picture over a blurred, enlarged copy of itself
FITS = (FIT_CONTAIN, FIT_COVER, FIT_BLUR)

#: A segment's colour grade, ffmpeg ``eq`` (brightness added to the luma, contrast
#: around mid-grey, saturation on the chroma); the neutral triple is "no change".
#: modules/timeline.py GRADE_RANGES are the same numbers; a test pins them.
GRADE_RANGES = {"brightness": (-1.0, 1.0), "contrast": (0.0, 2.0), "saturation": (0.0, 3.0)}
GRADE_NEUTRAL = {"brightness": 0.0, "contrast": 1.0, "saturation": 1.0}

#: ffmpeg ``xfade`` transitions a cross-fade may use. modules/timeline.py holds the
#: same list (a test pins them). The name is the only thing of it that reaches a
#: filter graph, and only if it is in this tuple (render_backend checks again).
XFADE_STYLES = ("fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight",
                "slideleft", "slideright", "slideup", "slidedown", "circleopen",
                "circleclose", "radial", "zoomin",
                "wipeup", "wipedown", "smoothleft", "smoothright", "smoothup",
                "smoothdown", "vertopen", "vertclose", "horzopen", "horzclose",
                "diagtl", "diagtr", "diagbl", "diagbr", "wipetl",
                "wipetr", "wipebl", "wipebr", "squeezeh", "squeezev",
                "pixelize", "hblur", "distance")
XFADE_DEFAULT_STYLE = "fade"

#: Picture overlays (a picture or video laid over the picture; modules/timeline.py
#: holds the same numbers, a test pins them). Each is an extra input and a
#: filter chain in the final pass, so they are counted; a video overlay also
#: keeps a decoder open for its whole span, hence the smaller cap.
MAX_PICTURE_OVERLAYS = 16
MAX_PICTURE_VIDEOS = 4
PICTURE_W_MIN, PICTURE_W_MAX = 0.05, 1.0
PICTURE_KINDS = ("video", "image")

#: Text looks (modules/timeline.py holds the same numbers, a test pins them).
SHADOW_MAX = 20.0
BOX_OPACITY_DEFAULT = 0.7
_HEX = re.compile(r"#[0-9a-fA-F]{6}")

#: Entrance / exit animations (modules/timeline.py holds the same lists and
#: numbers, a test pins them). The name picks the ASS tags or filter written, so
#: only a name on the list ever reaches either.
ANIM_OUT = ("fade", "slide-up", "slide-down", "slide-left", "slide-right", "pop")
ANIM_IN = ANIM_OUT + ("typewriter",)
ANIM_MIN_S, ANIM_MAX_S, ANIM_DEFAULT_S = 0.1, 2.0, 0.4
ANIM_SLIDE = 0.15
ANIM_POP_FROM = 0.6

#: Clip effects (modules/timeline.py holds the same lists and numbers; a test pins
#: them). Only a name on FILTERS and formatted numbers reach a filter graph.
FILTERS = ("mono", "sepia", "vintage", "cinematic", "cool", "warm", "high-contrast")
BLUR_MAX = 30.0
ROTATIONS = (0, 90, 180, 270)

#: A speed curve / interpolated slow motion (modules/timeline.py holds the same
#: numbers; a test pins them).
RAMP_MIN_POINTS, RAMP_MAX_POINTS = 2, 6
INTERP_MAX_FPS = 120

#: Stabilisation budget (modules/timeline.py holds the same numbers).
STABILIZE_MAX_S = 120.0

#: A clip's crop rectangle / free angle (modules/timeline.py holds the same numbers).
CROP_MIN = 0.05
ANGLE_MAX = 180.0

#: An overlay's chroma key (modules/timeline.py holds the same numbers).
CHROMA_SIMILARITY_MIN, CHROMA_SIMILARITY_MAX, CHROMA_SIMILARITY_DEFAULT = 0.01, 0.6, 0.15
CHROMA_BLEND_MAX, CHROMA_BLEND_DEFAULT = 0.5, 0.1

#: A clip's move: zoom window range (modules/timeline.py holds the same numbers).
MOVE_ZOOM_MIN, MOVE_ZOOM_MAX = 1.0, 4.0

#: Text overlay anchors: which point of the text box sits at (x, y). The ASS
#: \an numpad code for each is in ass_captions.ANCHOR_AN.
ANCHORS = ("top-left", "top", "top-right", "left", "center", "right",
           "bottom-left", "bottom", "bottom-right")

#: Playback speed bounds (modules/timeline.py offers exactly this range). A sound
#: outside 0.5-2 goes through chained ``atempo`` stages, each within it.
SPEED_MIN, SPEED_MAX = 0.25, 4.0


def _speed_ok(v) -> bool:
    return _finite(v) and SPEED_MIN <= v <= SPEED_MAX


def _finite(v) -> bool:
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:   # an int too large for a float
        return False


def _put_if(d: dict, key: str, value, default) -> None:
    # New fields are serialised only when set, so a pre-timeline spec's dict
    # is exactly what it always was (it is compared and cached elsewhere).
    if value != default:
        d[key] = value


def _anims_to_dict(obj, d: dict) -> None:
    """The animation fields of a TextOverlay / PictureOverlay, only when set."""
    for key in ("anim_in", "anim_out"):
        if getattr(obj, key) is not None:
            d[key] = getattr(obj, key)
            d[key + "_s"] = getattr(obj, key + "_s")


def _anims_from_dict(d: dict) -> dict:
    out = {}
    for key in ("anim_in", "anim_out"):
        if d.get(key) is not None:
            out[key] = str(d[key])
            out[key + "_s"] = float(d[key + "_s"] if d.get(key + "_s") is not None else ANIM_DEFAULT_S)
    return out


def _anim_problems(name: str, o, allowed_in: Sequence[str], span: Tuple[float, float]) -> List[str]:
    problems: List[str] = []
    total = 0.0
    for key, allowed in (("anim_in", allowed_in), ("anim_out", ANIM_OUT)):
        v = getattr(o, key)
        dur = getattr(o, key + "_s")
        if v is None:
            continue
        if v not in allowed:
            problems.append(f"{name} has unknown {key} {v!r}")
        if not (_finite(dur) and ANIM_MIN_S <= dur <= ANIM_MAX_S):
            problems.append(f"{name} {key}_s must be from {ANIM_MIN_S:g} to {ANIM_MAX_S:g}")
        else:
            total += dur
    if total:
        # The OTHER side's plain fade is an animation too (a fade-out becomes an exit at e - fade_out_s,
        # cutting a long entrance short): it counts against the time the item is shown.
        for key, fade in (("anim_in", "fade_in_s"), ("anim_out", "fade_out_s")):
            f = getattr(o, fade, 0.0)
            if getattr(o, key) is None and _finite(f) and f > 0:
                total += f
    if total and all(_finite(v) for v in span) and total > span[1] - span[0] + 1e-9:
        problems.append(f"{name} animations and fades are longer than it is shown")
    return problems


@dataclass(frozen=True)
class ClipEffects:
    """A clip's look beyond the colour grade (see modules/timeline.py): a named
    colour ``filter`` at ``filter_strength``, ``vignette`` / ``sharpen`` /
    ``grain`` (0-1), ``blur`` (a sigma in output pixels), mirror and a turn in
    quarter steps. Every default is "off"; a segment without effects has
    ``effects=None`` and renders the command it always did."""
    filter: Optional[str] = None
    filter_strength: float = 1.0
    vignette: float = 0.0
    blur: float = 0.0
    sharpen: float = 0.0
    grain: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    rotate: int = 0

    @property
    def active(self) -> bool:
        return self != ClipEffects()

    @property
    def geometric(self) -> bool:
        return bool(self.flip_h or self.flip_v or self.rotate)

    def to_dict(self) -> dict:
        d: dict = {}
        base = ClipEffects()
        for key in ("filter", "filter_strength", "vignette", "blur", "sharpen", "grain",
                    "flip_h", "flip_v", "rotate"):
            _put_if(d, key, getattr(self, key), getattr(base, key))
        return d

    @staticmethod
    def from_dict(d: dict) -> "ClipEffects":
        base = ClipEffects()
        return ClipEffects(
            filter=(str(d["filter"]) if d.get("filter") is not None else None),
            filter_strength=float(d["filter_strength"] if d.get("filter_strength") is not None
                                  else base.filter_strength),
            vignette=float(d.get("vignette") or 0.0), blur=float(d.get("blur") or 0.0),
            sharpen=float(d.get("sharpen") or 0.0), grain=float(d.get("grain") or 0.0),
            flip_h=bool(d.get("flip_h", False)), flip_v=bool(d.get("flip_v", False)),
            rotate=int(d.get("rotate") or 0),
        )


@dataclass(frozen=True)
class ClipMove:
    """Two keyframes of a window onto the fitted picture: ``zoom`` (1 = all of
    it) and the window's centre (fractions of the picture), from the clip's
    first frame to its last, linear in frames. Equal points = no motion."""
    from_zoom: float = 1.0
    from_x: float = 0.5
    from_y: float = 0.5
    to_zoom: float = 1.0
    to_x: float = 0.5
    to_y: float = 0.5

    @property
    def still(self) -> bool:
        """True when the window never moves; at zoom 1 centred it is the whole picture."""
        return (self.from_zoom, self.from_x, self.from_y) == (self.to_zoom, self.to_x, self.to_y)

    @property
    def neutral(self) -> bool:
        return self.still and self.from_zoom == 1.0

    def to_dict(self) -> dict:
        return {"from": {"zoom": self.from_zoom, "x": self.from_x, "y": self.from_y},
                "to": {"zoom": self.to_zoom, "x": self.to_x, "y": self.to_y}}

    @staticmethod
    def from_dict(d: dict) -> "ClipMove":
        def pt(key):
            p = d.get(key) or {}
            return (float(p.get("zoom", 1.0)), float(p.get("x", 0.5)), float(p.get("y", 0.5)))
        a, b = pt("from"), pt("to")
        return ClipMove(*a, *b)


def _move_problems(name: str, mv: ClipMove) -> List[str]:
    problems: List[str] = []
    for label, zoom, x, y in (("from", mv.from_zoom, mv.from_x, mv.from_y),
                              ("to", mv.to_zoom, mv.to_x, mv.to_y)):
        if not (_finite(zoom) and MOVE_ZOOM_MIN <= zoom <= MOVE_ZOOM_MAX):
            problems.append(f"{name} move {label} zoom must be from {MOVE_ZOOM_MIN:g} to {MOVE_ZOOM_MAX:g}")
        if not (_finite(x) and _finite(y) and 0 <= x <= 1 and 0 <= y <= 1):
            problems.append(f"{name} move {label} centre must be fractions of the picture (0..1)")
    return problems


def _effects_problems(name: str, fx: ClipEffects) -> List[str]:
    problems: List[str] = []
    if fx.filter is not None and fx.filter not in FILTERS:
        problems.append(f"{name} has unknown filter {fx.filter!r}")
    for key in ("filter_strength", "vignette", "sharpen", "grain"):
        v = getattr(fx, key)
        if not (_finite(v) and 0 <= v <= 1):
            problems.append(f"{name} {key} must be from 0 to 1 (got {v})")
    if not (_finite(fx.blur) and 0 <= fx.blur <= BLUR_MAX):
        problems.append(f"{name} blur must be from 0 to {BLUR_MAX:g} (got {fx.blur})")
    for key in ("flip_h", "flip_v"):
        if not isinstance(getattr(fx, key), bool):
            problems.append(f"{name} {key} must be true or false")
    if not (isinstance(fx.rotate, int) and not isinstance(fx.rotate, bool) and fx.rotate in ROTATIONS):
        problems.append(f"{name} rotate must be one of {list(ROTATIONS)}")
    return problems


@dataclass(frozen=True)
class SpeedCurve:
    """A clip's speed ramp (modules/speed_ramp.py): ``points`` are ``(at, speed)``
    with ``at`` a fraction 0-1 of the source range, which is ``range_s`` long."""
    points: Tuple[Tuple[float, float], ...]
    range_s: float

    def absolute(self) -> List[Tuple[float, float]]:
        return speed_ramp.absolute(self.points, self.range_s)

    def to_dict(self) -> dict:
        return {"points": [[a, s] for a, s in self.points], "range_s": self.range_s}

    @staticmethod
    def from_dict(d: dict) -> "SpeedCurve":
        return SpeedCurve(tuple((float(a), float(s)) for a, s in (d.get("points") or [])),
                          float(d.get("range_s") or 0.0))


def _curve_problems(name: str, c: SpeedCurve) -> List[str]:
    pts = c.points
    if not (RAMP_MIN_POINTS <= len(pts) <= RAMP_MAX_POINTS):
        return [f"{name} speed curve needs {RAMP_MIN_POINTS} to {RAMP_MAX_POINTS} points"]
    if not all(len(p) == 2 and all(_finite(v) for v in p) for p in pts) or not (_finite(c.range_s) and c.range_s > 0):
        return [f"{name} speed curve has a non-finite number"]
    problems: List[str] = []
    if pts[0][0] != 0 or pts[-1][0] != 1 or any(b[0] <= a[0] for a, b in zip(pts, pts[1:])):
        problems.append(f"{name} speed curve must run from 0 to 1 in increasing order")
    if not all(SPEED_MIN <= s <= SPEED_MAX for _a, s in pts):
        problems.append(f"{name} speed curve speeds must be from {SPEED_MIN:g} to {SPEED_MAX:g}")
    return problems


def interp_fps(min_speed: float, fps: int) -> int:
    """The frame rate slow motion is interpolated up to: enough that every output
    frame of the slowest part is a distinct source-rate frame, at most INTERP_MAX_FPS."""
    return int(min(INTERP_MAX_FPS, math.ceil(int(fps) / float(min_speed))))


@dataclass(frozen=True)
class ClipCrop:
    """A rectangle of the source picture kept before the fit, as fractions of it
    (taken after the turn and mirror). The whole picture is ``(0, 0, 1, 1)``."""
    x: float = 0.0
    y: float = 0.0
    w: float = 1.0
    h: float = 1.0

    def to_dict(self) -> dict:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}

    @staticmethod
    def from_dict(d: dict) -> "ClipCrop":
        return ClipCrop(float(d.get("x", 0.0)), float(d.get("y", 0.0)), float(d.get("w", 1.0)),
                        float(d.get("h", 1.0)))


def _crop_problems(name: str, c: ClipCrop) -> List[str]:
    problems: List[str] = []
    for key in ("x", "y"):
        v = getattr(c, key)
        if not (_finite(v) and 0 <= v <= 1):
            problems.append(f"{name} crop {key} must be from 0 to 1")
    for key in ("w", "h"):
        v = getattr(c, key)
        if not (_finite(v) and CROP_MIN <= v <= 1):
            problems.append(f"{name} crop {key} must be from {CROP_MIN:g} to 1")
    if not problems and (c.x + c.w > 1 + 1e-9 or c.y + c.h > 1 + 1e-9):
        problems.append(f"{name} crop goes past the picture")
    return problems


@dataclass(frozen=True)
class Segment:
    """One timeline segment. `path` is a pre-normalised clip/image file, or None
    for a solid-colour placeholder. `duration` is the seconds it occupies.

    The rest are timeline options whose defaults are the original behaviour:
    ``in_s`` seeks that far into a video source (trim), ``fit`` chooses
    letterbox (contain) or crop (cover) for a video, ``fade_in_s`` /
    ``fade_out_s`` fade the picture from / to black inside the segment, and
    ``speed`` plays a video source that much faster (``duration`` stays the
    segment's length in the OUTPUT; it shows ``duration * speed`` seconds of
    the source from ``in_s``)."""
    duration: float
    path: Optional[str] = None
    kind: str = KIND_VIDEO
    in_s: float = 0.0
    fit: str = FIT_CONTAIN
    fade_in_s: float = 0.0
    fade_out_s: float = 0.0
    speed: float = 1.0
    #: A piece of a longer clip (frame_exact only): the clip is ``clip_s``
    #: seconds long and this segment is ``duration`` seconds of it from
    #: ``offset_s``. 0 = the segment is the whole clip (the original model).
    clip_s: float = 0.0
    offset_s: float = 0.0
    #: The Ken Burns seed of the clip this piece belongs to, so every piece
    #: of one still moves the same way ('' = the backend's own per-segment seed).
    seed: str = ""
    #: A cross-fade: this segment (the outgoing clip's last ``duration``
    #: seconds) dissolves into ``xfade`` (the incoming clip's first ones).
    xfade: Optional["Segment"] = None
    #: Which ``xfade`` transition blends this segment into ``xfade``.
    xfade_style: str = XFADE_DEFAULT_STYLE
    #: The picture's colour grade (``eq``); the defaults change nothing and
    #: add no filter, so a segment without it is the one it always was.
    brightness: float = 0.0
    contrast: float = 1.0
    saturation: float = 1.0
    #: Filters, vignette, blur, mirror, turn (None = none).
    effects: Optional[ClipEffects] = None
    #: A Ken Burns style move over the fitted picture (None = none; a still
    #: then keeps its automatic slow zoom).
    move: Optional[ClipMove] = None
    #: Play the source range backwards / hold its first frame (video only).
    reverse: bool = False
    freeze: bool = False
    #: Keep a rectangle of the source (None = all of it) / turn the fitted
    #: picture by this many degrees clockwise about its centre (0 = no turn).
    crop: Optional[ClipCrop] = None
    angle: float = 0.0
    #: A speed ramp instead of one ``speed`` (``speed`` is then 1) and smoother
    #: slow motion by motion-compensated interpolation (only below speed 1).
    curve: Optional[SpeedCurve] = None
    interpolate: bool = False
    #: Smooth camera shake (vidstab, two passes, else deshake). Video only.
    stabilize: bool = False

    @property
    def graded(self) -> bool:
        """True when the colour grade changes the picture."""
        return (self.brightness, self.contrast, self.saturation) != (0.0, 1.0, 1.0)

    def to_dict(self) -> dict:
        d = {"duration": self.duration, "path": self.path, "kind": self.kind}
        _put_if(d, "in_s", self.in_s, 0.0)
        _put_if(d, "fit", self.fit, FIT_CONTAIN)
        _put_if(d, "fade_in_s", self.fade_in_s, 0.0)
        _put_if(d, "fade_out_s", self.fade_out_s, 0.0)
        _put_if(d, "speed", self.speed, 1.0)
        _put_if(d, "clip_s", self.clip_s, 0.0)
        _put_if(d, "offset_s", self.offset_s, 0.0)
        _put_if(d, "seed", self.seed, "")
        _put_if(d, "brightness", self.brightness, 0.0)
        _put_if(d, "contrast", self.contrast, 1.0)
        _put_if(d, "saturation", self.saturation, 1.0)
        if self.effects is not None:
            d["effects"] = self.effects.to_dict()
        if self.move is not None:
            d["move"] = self.move.to_dict()
        _put_if(d, "reverse", self.reverse, False)
        _put_if(d, "freeze", self.freeze, False)
        if self.crop is not None:
            d["crop"] = self.crop.to_dict()
        _put_if(d, "angle", self.angle, 0.0)
        if self.curve is not None:
            d["curve"] = self.curve.to_dict()
        _put_if(d, "interpolate", self.interpolate, False)
        _put_if(d, "stabilize", self.stabilize, False)
        if self.xfade is not None:
            d["xfade"] = self.xfade.to_dict()
        _put_if(d, "xfade_style", self.xfade_style, XFADE_DEFAULT_STYLE)
        return d

    @staticmethod
    def from_dict(d: dict) -> "Segment":
        x = d.get("xfade")
        return Segment(
            duration=float(d.get("duration") or 0.0),
            path=(d.get("path") or None),
            kind=str(d.get("kind") or KIND_VIDEO),
            in_s=float(d.get("in_s") or 0.0),
            fit=str(d.get("fit") or FIT_CONTAIN),
            fade_in_s=float(d.get("fade_in_s") or 0.0),
            fade_out_s=float(d.get("fade_out_s") or 0.0),
            speed=float(d.get("speed") or 1.0),
            clip_s=float(d.get("clip_s") or 0.0),
            offset_s=float(d.get("offset_s") or 0.0),
            seed=str(d.get("seed") or ""),
            brightness=float(d.get("brightness") or 0.0),
            contrast=float(1.0 if d.get("contrast") is None else d["contrast"]),
            saturation=float(1.0 if d.get("saturation") is None else d["saturation"]),
            effects=(ClipEffects.from_dict(d["effects"]) if isinstance(d.get("effects"), dict) else None),
            move=(ClipMove.from_dict(d["move"]) if isinstance(d.get("move"), dict) else None),
            reverse=bool(d.get("reverse", False)), freeze=bool(d.get("freeze", False)),
            crop=(ClipCrop.from_dict(d["crop"]) if isinstance(d.get("crop"), dict) else None),
            angle=float(d.get("angle") or 0.0),
            curve=(SpeedCurve.from_dict(d["curve"]) if isinstance(d.get("curve"), dict) else None),
            interpolate=bool(d.get("interpolate", False)), stabilize=bool(d.get("stabilize", False)),
            xfade=Segment.from_dict(x) if isinstance(x, dict) else None,
            xfade_style=str(d.get("xfade_style") or XFADE_DEFAULT_STYLE),
        )

    @property
    def full_s(self) -> float:
        """The length of the clip this segment belongs to (its own when whole)."""
        return self.clip_s if self.clip_s > 0 else self.duration


@dataclass(frozen=True)
class AudioTrack:
    """One audio file placed on the output timeline: ``duration_s`` seconds of
    the source from ``in_s``, starting at ``start_s`` of the video, at
    ``gain_db``, with linear fades inside that span. At ``speed`` the source
    range plays in ``duration_s / speed`` seconds (pitch kept); the fades are
    measured on the output, after the speed change."""
    path: str
    duration_s: float
    start_s: float = 0.0
    in_s: float = 0.0
    gain_db: float = 0.0
    fade_in_s: float = 0.0
    fade_out_s: float = 0.0
    speed: float = 1.0
    #: Joined to the PREVIOUS track in the list with ``acrossfade`` over this
    #: many seconds (0 = mixed on its own, the original model).
    crossfade_s: float = 0.0
    #: Ducking (see the module docstring): how far the track is lowered, how
    #: fast, and where. No spans = no ducking = the original filter graph.
    duck_db: float = 0.0
    duck_attack_s: float = 0.0
    duck_release_s: float = 0.0
    duck_spans: Tuple[Tuple[float, float], ...] = ()
    #: Play the trimmed source backwards (the clip's own sound under ``reverse``).
    reverse: bool = False
    #: Clean-up before the gain: FFT noise reduction, then single-pass loudness
    #: normalisation (see audio_track_filter).
    denoise: bool = False
    loudnorm: bool = False
    #: A speed ramp's sound: the trimmed source is cut into ``len(tempos)`` equal
    #: slices, slice ``j`` played at ``tempos[j]`` (``speed`` is then 1).
    tempos: Tuple[float, ...] = ()

    @property
    def output_s(self) -> float:
        """How long the track sounds in the output."""
        if self.tempos:
            return sum((self.duration_s / len(self.tempos)) / t for t in self.tempos)
        return self.duration_s / self.speed if self.speed else self.duration_s

    def to_dict(self) -> dict:
        d = {"path": self.path, "duration_s": self.duration_s, "start_s": self.start_s,
             "in_s": self.in_s, "gain_db": self.gain_db, "fade_in_s": self.fade_in_s,
             "fade_out_s": self.fade_out_s}
        _put_if(d, "speed", self.speed, 1.0)
        _put_if(d, "crossfade_s", self.crossfade_s, 0.0)
        _put_if(d, "reverse", self.reverse, False)
        _put_if(d, "denoise", self.denoise, False)
        _put_if(d, "loudnorm", self.loudnorm, False)
        if self.tempos:
            d["tempos"] = list(self.tempos)
        if self.duck_spans:
            d["duck_db"] = self.duck_db
            d["duck_attack_s"] = self.duck_attack_s
            d["duck_release_s"] = self.duck_release_s
            d["duck_spans"] = [[a, b] for a, b in self.duck_spans]
        return d

    @staticmethod
    def from_dict(d: dict) -> "AudioTrack":
        return AudioTrack(
            path=str(d.get("path") or ""),
            duration_s=float(d.get("duration_s") or 0.0),
            start_s=float(d.get("start_s") or 0.0),
            in_s=float(d.get("in_s") or 0.0),
            gain_db=float(d.get("gain_db") or 0.0),
            fade_in_s=float(d.get("fade_in_s") or 0.0),
            fade_out_s=float(d.get("fade_out_s") or 0.0),
            speed=float(d.get("speed") or 1.0),
            crossfade_s=float(d.get("crossfade_s") or 0.0),
            duck_db=float(d.get("duck_db") or 0.0),
            duck_attack_s=float(d.get("duck_attack_s") or 0.0),
            duck_release_s=float(d.get("duck_release_s") or 0.0),
            duck_spans=tuple((float(a), float(b)) for a, b in (d.get("duck_spans") or [])),
            reverse=bool(d.get("reverse", False)),
            denoise=bool(d.get("denoise", False)), loudnorm=bool(d.get("loudnorm", False)),
            tempos=tuple(float(t) for t in (d.get("tempos") or [])),
        )


@dataclass(frozen=True)
class TextOverlay:
    """Text burnt into the picture from ``start_s`` to ``end_s``. ``x``/``y``
    are fractions of the frame where the ``anchor`` point of the text box
    sits; ``size`` and ``outline_width`` are output pixels. Later overlays
    draw on top of earlier ones."""
    start_s: float
    end_s: float
    text: str
    font: str = "DejaVu Sans"
    size: int = 64
    color: str = "#FFFFFF"
    outline_color: str = "#000000"
    outline_width: float = 3.0
    bold: bool = False
    x: float = 0.5
    y: float = 0.5
    anchor: str = "center"
    fade_in_s: float = 0.0
    fade_out_s: float = 0.0
    #: Looks (off by default; a text without them is written to the ASS file as
    #: it always was): a soft black drop shadow ``shadow`` pixels down and to the
    #: right, and a box of ``box_color`` at ``box_opacity`` behind the text
    #: INSTEAD of its outline (libass draws one or the other).
    shadow: float = 0.0
    box_color: Optional[str] = None
    box_opacity: float = BOX_OPACITY_DEFAULT
    #: Entrance / exit animation (None = none: the overlay is the one it was).
    anim_in: Optional[str] = None
    anim_out: Optional[str] = None
    anim_in_s: float = ANIM_DEFAULT_S
    anim_out_s: float = ANIM_DEFAULT_S
    #: An animated caption style (modules/caption_styles.py STYLE_IDS) and its
    #: highlight colour: ass_captions writes such a cue with the style's own
    #: tags instead of the plain overlay. None = the plain overlay it always was.
    caption_style: Optional[str] = None
    highlight_color: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"start_s": self.start_s, "end_s": self.end_s, "text": self.text,
             "font": self.font, "size": self.size, "color": self.color,
             "outline_color": self.outline_color, "outline_width": self.outline_width,
             "bold": self.bold, "x": self.x, "y": self.y, "anchor": self.anchor,
             "fade_in_s": self.fade_in_s, "fade_out_s": self.fade_out_s}
        _put_if(d, "shadow", self.shadow, 0.0)
        if self.box_color is not None:
            d["box_color"] = self.box_color
            d["box_opacity"] = self.box_opacity
        _anims_to_dict(self, d)
        _put_if(d, "caption_style", self.caption_style, None)
        _put_if(d, "highlight_color", self.highlight_color, None)
        return d

    @staticmethod
    def from_dict(d: dict) -> "TextOverlay":
        base = TextOverlay(0.0, 0.0, "")
        return TextOverlay(
            start_s=float(d.get("start_s") or 0.0),
            end_s=float(d.get("end_s") or 0.0),
            text=str(d.get("text") or ""),
            font=str(d.get("font") or base.font),
            size=int(d.get("size") or base.size),
            color=str(d.get("color") or base.color),
            outline_color=str(d.get("outline_color") or base.outline_color),
            outline_width=float(d.get("outline_width") if d.get("outline_width") is not None
                                else base.outline_width),
            bold=bool(d.get("bold", False)),
            x=float(d.get("x") if d.get("x") is not None else base.x),
            y=float(d.get("y") if d.get("y") is not None else base.y),
            anchor=str(d.get("anchor") or base.anchor),
            fade_in_s=float(d.get("fade_in_s") or 0.0),
            fade_out_s=float(d.get("fade_out_s") or 0.0),
            shadow=float(d.get("shadow") or 0.0),
            box_color=(str(d["box_color"]) if d.get("box_color") is not None else None),
            box_opacity=float(d["box_opacity"] if d.get("box_opacity") is not None
                              else BOX_OPACITY_DEFAULT),
            **_anims_from_dict(d),
            caption_style=(str(d["caption_style"]) if d.get("caption_style") is not None else None),
            highlight_color=(str(d["highlight_color"]) if d.get("highlight_color") is not None
                             else None),
        )


@dataclass(frozen=True)
class PictureOverlay:
    """A picture (``image``) or video laid over the composited picture from
    ``start_s`` to ``end_s`` of the output. ``x`` / ``y`` are where the CENTRE
    of the overlay sits, ``w`` its width, all as fractions of the frame (so
    the same overlay fits any resolution); its height follows its own aspect
    ratio. ``opacity`` 1 is opaque (a PNG keeps its own transparency
    underneath). A video overlay plays from its first frame, silent. Later
    overlays are drawn on top of earlier ones."""
    path: str
    kind: str
    start_s: float
    end_s: float
    x: float = 0.5
    y: float = 0.5
    w: float = 0.3
    opacity: float = 1.0
    #: Entrance / exit animation (None = none; a typewriter is for text only).
    anim_in: Optional[str] = None
    anim_out: Optional[str] = None
    anim_in_s: float = ANIM_DEFAULT_S
    anim_out_s: float = ANIM_DEFAULT_S
    #: End keyframe: where the centre, width and opacity are at ``end_s`` (None =
    #: unchanged). Linear from the values above at ``start_s``.
    to_x: Optional[float] = None
    to_y: Optional[float] = None
    to_w: Optional[float] = None
    to_opacity: Optional[float] = None
    #: Chroma key: pixels near this colour (``#RRGGBB``) become transparent
    #: (None = none).
    chroma_color: Optional[str] = None
    chroma_similarity: float = CHROMA_SIMILARITY_DEFAULT
    chroma_blend: float = CHROMA_BLEND_DEFAULT

    @property
    def moves(self) -> bool:
        return any(v is not None for v in (self.to_x, self.to_y, self.to_w, self.to_opacity))

    def to_dict(self) -> dict:
        d = {"path": self.path, "kind": self.kind, "start_s": self.start_s,
             "end_s": self.end_s, "x": self.x, "y": self.y, "w": self.w,
             "opacity": self.opacity}
        _anims_to_dict(self, d)
        for key in ("to_x", "to_y", "to_w", "to_opacity"):
            if getattr(self, key) is not None:
                d[key] = getattr(self, key)
        if self.chroma_color is not None:
            d["chroma_color"] = self.chroma_color
            d["chroma_similarity"] = self.chroma_similarity
            d["chroma_blend"] = self.chroma_blend
        return d

    @staticmethod
    def from_dict(d: dict) -> "PictureOverlay":
        def num(key, default):
            return float(d[key]) if d.get(key) is not None else default
        return PictureOverlay(
            path=str(d.get("path") or ""),
            kind=str(d.get("kind") or KIND_IMAGE),
            start_s=num("start_s", 0.0), end_s=num("end_s", 0.0),
            x=num("x", 0.5), y=num("y", 0.5), w=num("w", 0.3), opacity=num("opacity", 1.0),
            **_anims_from_dict(d),
            **{k: float(d[k]) for k in ("to_x", "to_y", "to_w", "to_opacity") if d.get(k) is not None},
            **({"chroma_color": str(d["chroma_color"]),
                "chroma_similarity": float(d.get("chroma_similarity", CHROMA_SIMILARITY_DEFAULT)),
                "chroma_blend": float(d.get("chroma_blend", CHROMA_BLEND_DEFAULT))}
               if d.get("chroma_color") is not None else {}),
        )


def segment_frames(duration: float, fps: int) -> int:
    """A segment's length in whole frames under ``frame_exact`` (at least 1)."""
    return max(1, int(round(float(duration) * int(fps))))


@dataclass(frozen=True)
class RenderSpec:
    """A complete, serialisable description of one video render — the data an
    ffmpeg backend needs, and nothing about how moviepy would build it."""
    output_path: str
    width: int = 1920
    height: int = 1080
    fps: int = 30
    segments: List[Segment] = field(default_factory=list)
    audio_path: Optional[str] = None
    subtitle_path: Optional[str] = None
    #: Timeline options (see the module docstring); defaults = original behaviour.
    frame_exact: bool = False
    audio_tracks: List[AudioTrack] = field(default_factory=list)
    overlays: List[TextOverlay] = field(default_factory=list)
    #: Pictures / videos laid over the picture (see PictureOverlay).
    picture_overlays: List[PictureOverlay] = field(default_factory=list)

    @property
    def total_duration(self) -> float:
        return round(sum(max(0.0, s.duration) for s in self.segments), 3)

    @property
    def video_length_s(self) -> float:
        """The rendered picture's true length: whole frames under
        ``frame_exact``, else the sum of the segment durations."""
        if self.frame_exact and self.fps > 0:
            return sum(segment_frames(s.duration, self.fps) for s in self.segments) / self.fps
        return self.total_duration

    def to_dict(self) -> dict:
        d = {
            "output_path": self.output_path,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "segments": [s.to_dict() for s in self.segments],
            "audio_path": self.audio_path,
            "subtitle_path": self.subtitle_path,
        }
        _put_if(d, "frame_exact", self.frame_exact, False)
        if self.audio_tracks:
            d["audio_tracks"] = [t.to_dict() for t in self.audio_tracks]
        if self.overlays:
            d["overlays"] = [o.to_dict() for o in self.overlays]
        if self.picture_overlays:
            d["picture_overlays"] = [o.to_dict() for o in self.picture_overlays]
        return d

    @staticmethod
    def from_dict(d: dict) -> "RenderSpec":
        return RenderSpec(
            output_path=str(d.get("output_path") or ""),
            width=int(d.get("width") or 1920),
            height=int(d.get("height") or 1080),
            fps=int(d.get("fps") or 30),
            segments=[Segment.from_dict(s) for s in (d.get("segments") or [])],
            audio_path=(d.get("audio_path") or None),
            subtitle_path=(d.get("subtitle_path") or None),
            frame_exact=bool(d.get("frame_exact", False)),
            audio_tracks=[AudioTrack.from_dict(t) for t in (d.get("audio_tracks") or [])],
            overlays=[TextOverlay.from_dict(o) for o in (d.get("overlays") or [])],
            picture_overlays=[PictureOverlay.from_dict(o)
                              for o in (d.get("picture_overlays") or [])],
        )

    @property
    def uses_timeline_features(self) -> bool:
        """True when the final pass needs the filter-graph command (several
        audio tracks and/or text overlays) rather than the original one."""
        return bool(self.audio_tracks or self.overlays or self.picture_overlays)


def _segment_problems(name: str, seg: Segment, frame_exact: bool) -> List[str]:
    problems: List[str] = []
    if seg.duration <= 0:
        problems.append(f"{name} has non-positive duration {seg.duration}")
    if seg.kind not in _KINDS:
        problems.append(f"{name} has unknown kind {seg.kind!r}")
    if seg.kind in (KIND_VIDEO, KIND_IMAGE) and not seg.path:
        problems.append(f"{name} is a {seg.kind} but has no path")
    if not _finite(seg.in_s) or seg.in_s < 0:
        problems.append(f"{name} has a negative or non-finite in_s {seg.in_s}")
    if seg.fit not in FITS:
        problems.append(f"{name} has unknown fit {seg.fit!r}")
    for field_name in ("fade_in_s", "fade_out_s", "clip_s", "offset_s"):
        v = getattr(seg, field_name)
        if not _finite(v) or v < 0:
            problems.append(f"{name} has a negative or non-finite {field_name} {v}")
    for field_name, (lo, hi) in GRADE_RANGES.items():
        v = getattr(seg, field_name)
        if not _finite(v) or not lo <= v <= hi:
            problems.append(f"{name} {field_name} must be from {lo:g} to {hi:g} (got {v})")
    if not _speed_ok(seg.speed):
        problems.append(f"{name} speed must be from {SPEED_MIN:g} to {SPEED_MAX:g} "
                        f"(got {seg.speed})")
    if seg.effects is not None:
        problems.extend(_effects_problems(name, seg.effects))
    if seg.curve is not None:
        problems.extend(_curve_problems(name, seg.curve))
        if seg.speed != 1.0:
            problems.append(f"{name} has a speed curve and a speed")
        if seg.reverse or seg.freeze:
            problems.append(f"{name} has a speed curve with reverse or freeze")
        if seg.kind != KIND_VIDEO:
            problems.append(f"{name} speed curve is for video, not a {seg.kind}")
    if seg.interpolate:
        slowest = seg.speed if seg.curve is None else min((s for _a, s in seg.curve.points), default=1.0)
        if seg.kind != KIND_VIDEO or seg.reverse or seg.freeze or not slowest < 1.0:
            problems.append(f"{name} interpolate is for forward slow motion of a video")
    if seg.stabilize and (seg.kind != KIND_VIDEO or seg.freeze):
        problems.append(f"{name} stabilize is for moving video (not a picture or a frozen frame)")
    if seg.crop is not None:
        problems.extend(_crop_problems(name, seg.crop))
    if not (_finite(seg.angle) and -ANGLE_MAX <= seg.angle <= ANGLE_MAX):
        problems.append(f"{name} angle must be from {-ANGLE_MAX:g} to {ANGLE_MAX:g}")
    if seg.reverse and seg.freeze:
        problems.append(f"{name} cannot be both reversed and frozen")
    if seg.freeze and seg.speed != 1.0:
        problems.append(f"{name} is frozen, which has no speed")
    if (seg.reverse or seg.freeze) and seg.kind != KIND_VIDEO:
        problems.append(f"{name} reverse and freeze are for video, not a {seg.kind}")
    if seg.reverse and not frame_exact:
        problems.append(f"{name} is reversed, which needs frame_exact")
    if seg.move is not None:
        problems.extend(_move_problems(name, seg.move))
        if not frame_exact:
            problems.append(f"{name} has a move, which needs frame_exact")
    if seg.xfade_style not in XFADE_STYLES:
        problems.append(f"{name} has unknown cross-fade style {seg.xfade_style!r}")
    elif seg.xfade_style != XFADE_DEFAULT_STYLE and seg.xfade is None:
        problems.append(f"{name} has a cross-fade style but no cross-fade")
    if (seg.clip_s or seg.offset_s or seg.xfade is not None) and not frame_exact:
        # Pieces are cut by frame number; without the frame grid a cut would drift.
        problems.append(f"{name} is a piece of a clip or a cross-fade, which needs frame_exact")
    if (_finite(seg.clip_s) and _finite(seg.offset_s) and seg.clip_s > 0
            and seg.offset_s + seg.duration > seg.clip_s + 1e-6):
        problems.append(f"{name} runs past the end of its clip ({seg.offset_s} + {seg.duration} s "
                        f"of {seg.clip_s} s)")
    if (_finite(seg.fade_in_s) and _finite(seg.fade_out_s) and _finite(seg.clip_s)
            and seg.fade_in_s + seg.fade_out_s > seg.full_s + 1e-9):
        problems.append(f"{name} fades ({seg.fade_in_s} + {seg.fade_out_s} s) "
                        f"are longer than the segment ({seg.full_s} s)")
    return problems


#: The most speech spans one track's envelope may carry: the expression grows
#: with each, and a document has at most 64 audio inputs to be speech.
MAX_DUCK_SPANS = 128
DUCK_DB_MAX = 60.0
DUCK_RAMP_MIN_S, DUCK_RAMP_MAX_S = 0.01, 10.0


def _duck_problems(i: int, t: AudioTrack) -> List[str]:
    if not t.duck_spans:
        if t.duck_db or t.duck_attack_s or t.duck_release_s:
            return [f"audio track {i} has ducking settings but no speech to duck under"]
        return []
    problems: List[str] = []
    if not (0 < t.duck_db <= DUCK_DB_MAX):
        problems.append(f"audio track {i} duck amount must be above 0 and at most "
                        f"{DUCK_DB_MAX:g} dB")
    for name, v in (("attack", t.duck_attack_s), ("release", t.duck_release_s)):
        if not (DUCK_RAMP_MIN_S <= v <= DUCK_RAMP_MAX_S):
            problems.append(f"audio track {i} duck {name} must be from {DUCK_RAMP_MIN_S:g} to "
                            f"{DUCK_RAMP_MAX_S:g} s")
    if len(t.duck_spans) > MAX_DUCK_SPANS:
        problems.append(f"audio track {i} has more than {MAX_DUCK_SPANS} speech spans to duck under")
    elif not all(len(sp) == 2 and all(_finite(x) for x in sp) and 0 <= sp[0] < sp[1]
                 for sp in t.duck_spans):
        problems.append(f"audio track {i} duck spans must be finite (start, end) pairs, end after start")
    return problems


def _picture_overlay_problems(spec: RenderSpec) -> List[str]:
    problems: List[str] = []
    pics = spec.picture_overlays
    if len(pics) > MAX_PICTURE_OVERLAYS:
        return [f"at most {MAX_PICTURE_OVERLAYS} picture overlays (got {len(pics)})"]
    if sum(1 for o in pics if o.kind == KIND_VIDEO) > MAX_PICTURE_VIDEOS:
        problems.append(f"at most {MAX_PICTURE_VIDEOS} video overlays")
    for i, o in enumerate(pics):
        name = f"picture overlay {i}"
        if o.kind not in PICTURE_KINDS:
            problems.append(f"{name} must be an image or a video (got {o.kind!r})")
        if not isinstance(o.path, str) or not o.path:
            problems.append(f"{name} has no path")
        nums = (o.start_s, o.end_s, o.x, o.y, o.w, o.opacity)
        if not all(_finite(v) for v in nums):
            problems.append(f"{name} has a non-finite number")
            continue
        if o.start_s < 0 or o.end_s <= o.start_s:
            problems.append(f"{name} must end after it starts")
        elif spec.fps > 0 and _frame_of(o.end_s, spec.fps) <= _frame_of(o.start_s, spec.fps):
            problems.append(f"{name} is shorter than one frame")
        if not (0 <= o.x <= 1 and 0 <= o.y <= 1):
            problems.append(f"{name} position must be fractions of the frame (0..1)")
        if not PICTURE_W_MIN <= o.w <= PICTURE_W_MAX:
            problems.append(f"{name} width must be from {PICTURE_W_MIN:g} to {PICTURE_W_MAX:g} "
                            "of the frame")
        if not 0 <= o.opacity <= 1:
            problems.append(f"{name} opacity must be from 0 to 1")
        problems.extend(_anim_problems(name, o, ANIM_OUT, (o.start_s, o.end_s)))
        if o.chroma_color is not None:
            if not (isinstance(o.chroma_color, str) and _HEX.fullmatch(o.chroma_color)):
                problems.append(f"{name} chroma colour must be a #RRGGBB colour")
            if not (_finite(o.chroma_similarity)
                    and CHROMA_SIMILARITY_MIN <= o.chroma_similarity <= CHROMA_SIMILARITY_MAX):
                problems.append(f"{name} chroma similarity must be from {CHROMA_SIMILARITY_MIN:g} "
                                f"to {CHROMA_SIMILARITY_MAX:g}")
            if not (_finite(o.chroma_blend) and 0 <= o.chroma_blend <= CHROMA_BLEND_MAX):
                problems.append(f"{name} chroma blend must be from 0 to {CHROMA_BLEND_MAX:g}")
        for key, lo, hi in (("to_x", 0, 1), ("to_y", 0, 1), ("to_opacity", 0, 1),
                            ("to_w", PICTURE_W_MIN, PICTURE_W_MAX)):
            v = getattr(o, key)
            if v is not None and not (_finite(v) and lo <= v <= hi):
                problems.append(f"{name} {key} must be from {lo:g} to {hi:g}")
    return problems


def validate(spec: RenderSpec) -> List[str]:
    """Problems that would make this spec un-renderable, as human-readable
    strings. Empty list means the spec is well-formed. Pure — checks the data,
    touches no disk."""
    problems: List[str] = []
    if not spec.output_path:
        problems.append("output_path is empty")
    if spec.width <= 0 or spec.height <= 0:
        problems.append("width and height must be positive")
    if spec.fps <= 0:
        problems.append("fps must be positive")
    if not spec.segments:
        problems.append("no segments — nothing to render")
    for i, seg in enumerate(spec.segments):
        problems.extend(_segment_problems(f"segment {i}", seg, spec.frame_exact))
        if seg.xfade is not None:
            x = seg.xfade
            problems.extend(_segment_problems(f"segment {i} cross-fade", x, spec.frame_exact))
            if x.xfade is not None:
                problems.append(f"segment {i} cross-fade cannot itself cross-fade")
            if any(s.kind == KIND_COLOR or not s.path for s in (seg, x)):
                problems.append(f"segment {i} cross-fade needs a picture on both sides")
            if _finite(x.duration) and abs(x.duration - seg.duration) > 1e-6:
                problems.append(f"segment {i} cross-fade sides must be equally long")
    if spec.audio_path and spec.audio_tracks:
        problems.append("audio_path and audio_tracks are mutually exclusive — "
                        "put the narration in audio_tracks")
    for i, t in enumerate(spec.audio_tracks):
        if not t.path:
            problems.append(f"audio track {i} has no path")
        nums = ("duration_s", "start_s", "in_s", "gain_db", "fade_in_s", "fade_out_s", "speed",
                "crossfade_s", "duck_db", "duck_attack_s", "duck_release_s")
        if not all(_finite(getattr(t, n)) for n in nums):
            problems.append(f"audio track {i} has a non-finite number")
            continue
        if t.duration_s <= 0:
            problems.append(f"audio track {i} has non-positive duration {t.duration_s}")
        if t.start_s < 0 or t.in_s < 0 or t.fade_in_s < 0 or t.fade_out_s < 0:
            problems.append(f"audio track {i} has a negative start, in point or fade")
        if not _speed_ok(t.speed):
            problems.append(f"audio track {i} speed must be from {SPEED_MIN:g} to {SPEED_MAX:g}")
            continue
        if t.tempos and (len(t.tempos) > speed_ramp.SLICES_MAX or t.speed != 1.0
                         or not all(_finite(x) and SPEED_MIN <= x <= SPEED_MAX for x in t.tempos)):
            problems.append(f"audio track {i} has bad speed-ramp tempos (at most {speed_ramp.SLICES_MAX}, "
                            f"each from {SPEED_MIN:g} to {SPEED_MAX:g}, with speed 1)")
            continue
        if t.fade_in_s + t.fade_out_s > t.output_s + 1e-9:
            problems.append(f"audio track {i} fades are longer than the track")
        if t.crossfade_s < 0 or (t.crossfade_s > 0 and i == 0):
            problems.append(f"audio track {i} cross-fade needs a track before it")
        elif t.crossfade_s > 0:
            prev = spec.audio_tracks[i - 1]
            if t.crossfade_s > t.output_s + 1e-9 or (
                    _finite(prev.output_s) and t.crossfade_s > prev.output_s + 1e-9):
                problems.append(f"audio track {i} cross-fade is longer than a track it joins")
        problems.extend(_duck_problems(i, t))
    for i, o in enumerate(spec.overlays):
        if not str(o.text or "").strip():
            problems.append(f"overlay {i} has no text")
        if not (_finite(o.start_s) and _finite(o.end_s)) or o.start_s < 0 or o.end_s <= o.start_s:
            problems.append(f"overlay {i} must end after it starts")
        if o.anchor not in ANCHORS:
            problems.append(f"overlay {i} has unknown anchor {o.anchor!r}")
        if not (_finite(o.x) and _finite(o.y) and 0 <= o.x <= 1 and 0 <= o.y <= 1):
            problems.append(f"overlay {i} position must be fractions of the frame (0..1)")
        if not isinstance(o.size, int) or isinstance(o.size, bool) or o.size <= 0:
            problems.append(f"overlay {i} size must be a positive integer")
        if not (_finite(o.shadow) and 0 <= o.shadow <= SHADOW_MAX):
            problems.append(f"overlay {i} shadow must be from 0 to {SHADOW_MAX:g}")
        if o.box_color is not None and not (isinstance(o.box_color, str)
                                            and _HEX.fullmatch(o.box_color)):
            problems.append(f"overlay {i} box_color must be a #RRGGBB colour")
        if not (_finite(o.box_opacity) and 0 <= o.box_opacity <= 1):
            problems.append(f"overlay {i} box_opacity must be from 0 to 1")
        problems.extend(_anim_problems(f"overlay {i}", o, ANIM_IN, (o.start_s, o.end_s)))
        for anim, fade in (("anim_in", "fade_in_s"), ("anim_out", "fade_out_s")):
            if getattr(o, anim) is not None and _finite(getattr(o, fade)) and getattr(o, fade) > 0:
                problems.append(f"overlay {i} has {anim} and {fade}: use one of them")
        if o.caption_style is not None and not caption_styles.is_style(o.caption_style):
            problems.append(f"overlay {i} caption_style must be one of {list(caption_styles.STYLE_IDS)}")
        if o.highlight_color is not None and not (isinstance(o.highlight_color, str)
                                                  and _HEX.fullmatch(o.highlight_color)):
            problems.append(f"overlay {i} highlight_color must be a #RRGGBB colour")
    problems.extend(_picture_overlay_problems(spec))
    return problems


def concat_list_lines(spec: RenderSpec) -> List[str]:
    """The lines of an ffmpeg concat-demuxer list file for this spec's segments.

    Each file-backed segment becomes a `file '<path>'` + `duration <d>` pair,
    and every file is listed **exactly once**. Colour placeholders carry no
    file, so they are skipped here — the backend generates them as `color=`
    inputs separately; a spec of only placeholders yields no lines (the caller
    then knows to build a colour-only clip instead).

    The files must be pre-normalised video clips already cut to their
    segment's length (render_backend does this). For such clips the demuxer
    plays each file in full and `duration` only pins where the next file's
    timestamps start, so the output is exactly the sum of the segments.

    This list used to repeat the last file, after the concat demuxer's
    image-slideshow quirk (a lone still's final `duration` is ignored). That
    workaround does not apply to video clips: it played the last clip twice,
    so a silent 2.3 s render came out ~3.6 s (with narration `-shortest` only
    hid it when the audio was the shorter stream). It was not even exact for
    stills — measured with ffmpeg 7, the repeat stretched a 3.0 s two-image
    list to 3.9 s — which is why stills are normalised to video first."""
    lines: List[str] = []
    for seg in spec.segments:
        if seg.kind == KIND_COLOR or not seg.path:
            continue
        safe = seg.path.replace("'", r"'\''")
        lines.append(f"file '{safe}'")
        lines.append(f"duration {max(0.0, seg.duration):.3f}")
    return lines


def build_ffmpeg_command(spec: RenderSpec, concat_list_path: str,
                         overlay_path: Optional[str] = None) -> List[str]:
    """The ffmpeg argument list for the standard concat-demuxer + audio-mux
    render of `spec`, reading its segment list from `concat_list_path`.

    Returns args only — it executes nothing. The pattern is the textbook one:
    concat the (pre-normalised) segments into the video track, optionally mux one
    audio file, optionally burn subtitles, and encode H.264/AAC at the spec's
    fps. Segment normalisation and actually running this belong to the backend.

    A spec with ``audio_tracks`` or ``overlays`` gets the filter-graph command
    (:func:`_timeline_command`); ``overlay_path`` is where the backend wrote the
    overlays' ASS file. Every other spec takes the original path below,
    unchanged.
    """
    if spec.uses_timeline_features:
        return _timeline_command(spec, concat_list_path, overlay_path)
    cmd: List[str] = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list_path]
    if spec.audio_path:
        cmd += ["-i", spec.audio_path]
    if spec.subtitle_path:
        subs = spec.subtitle_path.replace("'", r"'\''")
        cmd += ["-vf", f"subtitles='{subs}'"]
    cmd += ["-r", str(spec.fps), "-c:v", "libx264", *final_x264(spec), "-pix_fmt", "yuv420p"]
    if spec.audio_path:
        cmd += ["-c:a", "aac", "-shortest"]
    cmd.append(spec.output_path)
    # A timeline with no audio track or overlay takes this path too: its
    # inputs are the render's own intermediates, capped all the same.
    return cap_inputs(cmd, out_pixels=spec.width * spec.height) if spec.frame_exact else cmd


def _quote_filter_path(path: str) -> str:
    return "'" + str(path).replace("'", r"'\''") + "'"


def _frame_of(t: float, fps: int) -> int:
    """The output frame a time falls on (the frame grid of ``frame_exact``)."""
    return int(round(float(t) * int(fps)))


def _t(x: float) -> str:
    # One fixed format for every time in a filter graph: the same spec must
    # always produce the same argv (tests pin it), whatever float noise.
    return f"{float(x):.3f}"


#: FFT noise reduction with noise tracking, tuned for a steady background hiss
#: below about -35 dB (a quiet room: measured -20 dB or more on 0.005-0.02 white
#: noise, the tone beside it untouched; steady noise louder than that is left
#: mostly alone), and single-pass EBU R128 loudness normalisation (integrated
#: -16 LUFS, true peak -1.5 dB, range 11 LU).
DENOISE_FILTER = "afftdn=nr=12:nf=-40:tn=1:tr=1"
LOUDNORM_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11"


def tempo_chain(speed: float) -> str:
    """``atempo=...`` stages that play sound ``speed`` times faster with its pitch
    kept. One stage covers 0.5-2 (the string older documents had); outside it the
    speed is split into stages that each do, so it works on every ffmpeg."""
    stages: List[float] = []
    s = float(speed)
    while s > 2.0 + 1e-9:
        stages.append(2.0)
        s /= 2.0
    while s < 0.5 - 1e-9:
        stages.append(0.5)
        s /= 0.5
    if abs(s - 1.0) > 1e-9 or not stages:
        stages.append(s)
    return ",".join(f"atempo={_t(x)}" for x in stages)


def audio_track_filter(track: AudioTrack, input_index: int, label: str, *,
                       delay: bool = True) -> str:
    """The filter chain placing one audio track: cut ``duration_s`` from
    ``in_s``, change its tempo when it has a speed (one ``atempo`` stage,
    pitch kept), one sample format for every input (so amix never guesses),
    gain, fades inside the span it sounds for, then delay to ``start_s``
    (``delay`` False: the caller places it — a cross-faded run is delayed
    once, after its tracks are joined)."""
    chain = [
        f"atrim=start={_t(track.in_s)}:duration={_t(track.duration_s)}",
        "asetpts=PTS-STARTPTS",
    ]
    if track.reverse:
        chain += ["areverse", "asetpts=PTS-STARTPTS"]
    if track.speed != 1.0:
        chain.append(tempo_chain(track.speed))
    ramp = ""
    if track.tempos:
        # A speed ramp's sound: asplit the trimmed source into equal slices, each at its own
        # tempo, and join them. The slices are labelled from this track's label (unique).
        n = len(track.tempos)
        step = track.duration_s / n
        chain.append(f"asplit={n}" + "".join(f"[{label}i{j}]" for j in range(n)))
        parts = [",".join(chain)]
        for j, tempo in enumerate(track.tempos):
            parts.append(f"[{label}i{j}]atrim=start={_t(j * step)}:duration={_t(step)},"
                         f"asetpts=PTS-STARTPTS,{tempo_chain(tempo)}[{label}o{j}]")
        ramp = (f"[{input_index}:a]" + ";".join(parts) + ";"
                + "".join(f"[{label}o{j}]" for j in range(n)) + f"concat=n={n}:v=0:a=1")
        chain = []
    if track.denoise:
        chain.append(DENOISE_FILTER)
    if track.loudnorm:
        # loudnorm works at 192 kHz and hands that on: aformat below brings it back to 48 kHz.
        chain.append(LOUDNORM_FILTER)
    chain.append("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo")
    if track.gain_db:
        chain.append(f"volume={_t(track.gain_db)}dB")
    if track.fade_in_s > 0:
        chain.append(f"afade=t=in:st=0:d={_t(track.fade_in_s)}")
    if track.fade_out_s > 0:
        chain.append(f"afade=t=out:st={_t(track.output_s - track.fade_out_s)}"
                     f":d={_t(track.fade_out_s)}")
    delay_ms = int(round(track.start_s * 1000))
    if delay and delay_ms > 0:
        chain.append(f"adelay=delays={delay_ms}:all=1")
    if ramp:
        return ramp + "," + ",".join(chain) + f"[{label}]"
    return f"[{input_index}:a]" + ",".join(chain) + f"[{label}]"


def _ramp_term(span: Tuple[float, float], attack_s: float, release_s: float) -> str:
    """How far one speech span has pulled the track down, 0..1, at time ``t``:
    rising over ``attack_s`` up to the span's start, 1 inside, falling over
    ``release_s`` after its end. Only + - * / min and clip: no ffmpeg-only
    syntax the tests could not evaluate."""
    start, end = span
    rise = start - attack_s
    up = f"(t-{_t(rise)})" if rise >= 0 else f"(t+{_t(-rise)})"
    down = f"({_t(end + release_s)}-t)"
    return f"clip(min({up}/{_t(attack_s)},{down}/{_t(release_s)}),0,1)"


def duck_expression(track: AudioTrack) -> str:
    """The ``volume`` expression of a ducked track: 1 outside speech, the
    linear gain of ``-duck_db`` inside it, ramped between. Where two spans'
    ramps meet, the deeper one wins (``max``)."""
    depth = [_ramp_term(sp, track.duck_attack_s, track.duck_release_s) for sp in track.duck_spans]
    deepest = depth[-1]
    for term in reversed(depth[:-1]):
        deepest = f"max({term},{deepest})"
    lowered = 1.0 - 10 ** (-track.duck_db / 20.0)
    return f"1-{lowered:.4f}*{deepest}"


def audio_duck_filter(track: AudioTrack, source: str, label: str) -> str:
    """``[source]volume=...[label]``: the ducking envelope, evaluated per audio
    frame (``eval=frame``), applied after the track's delay."""
    return f"[{source}]volume=volume='{duck_expression(track)}':eval=frame[{label}]"


def audio_runs(tracks: List[AudioTrack]) -> List[List[int]]:
    """Track indexes grouped into runs joined by cross-fades: a track with
    ``crossfade_s`` belongs to the run of the track before it."""
    runs: List[List[int]] = []
    for i, t in enumerate(tracks):
        if t.crossfade_s > 0 and runs:
            runs[-1].append(i)
        else:
            runs.append([i])
    return runs


def audio_run_filters(tracks: List[AudioTrack], run: List[int], label: str) -> List[str]:
    """The filter chains for one run: a single track is placed as always; a
    cross-faded run is each track's chain (undelayed), joined pairwise by
    ``acrossfade`` (linear both ways — the outgoing sound fades out exactly
    as the incoming one fades in), then delayed once to the first track's
    start. Inputs are 1-based (input 0 is the picture)."""
    head = run[0]
    if len(run) == 1:
        return [audio_track_filter(tracks[head], head + 1, label)]
    out = [audio_track_filter(tracks[i], i + 1, f"s{i}", delay=False) for i in run]
    prev = f"s{head}"
    for i in run[1:]:
        out.append(f"[{prev}][s{i}]acrossfade=d={_t(tracks[i].crossfade_s)}:c1=tri:c2=tri[x{i}]")
        prev = f"x{i}"
    delay_ms = int(round(tracks[head].start_s * 1000))
    out.append(f"[{prev}]" + (f"adelay=delays={delay_ms}:all=1" if delay_ms > 0 else "anull")
               + f"[{label}]")
    return out


def picture_overlay_inputs(spec: RenderSpec) -> List[str]:
    """The ffmpeg input arguments of the picture overlays, in order (they come
    after the audio tracks). A picture is read once (one frame, held by the
    filter graph); a video is read for the length of its span, and its sound
    is switched off (``-an``): an overlay is never heard."""
    out: List[str] = []
    for o in spec.picture_overlays:
        if o.kind == KIND_VIDEO:
            frames = _frame_of(o.end_s, spec.fps) - _frame_of(o.start_s, spec.fps)
            out += ["-an", "-t", _t(frames / spec.fps), "-i", o.path]
        else:
            out += ["-i", o.path]
    return out


def _overlay_anim_filters(o: PictureOverlay, t_start: float, t_end: float,
                          spec: RenderSpec) -> Tuple[str, str, str]:
    """``(filters, x term, y term)`` for an overlay's entrance and exit: the
    filters are appended to its chain (after the shift to its first frame, so
    ``t`` is output time), the terms are added to the overlay's centre. Every
    animation fades the alpha plane (``fade ... alpha=1`` on the YUVA picture);
    a slide also offsets the centre by ``ANIM_SLIDE`` of the frame, a pop also
    scales the picture about its centre from ``ANIM_POP_FROM``. Only names on
    ``ANIM_IN`` / ``ANIM_OUT`` and formatted numbers are written."""
    filters = ""
    move_x = move_y = ""
    scale_terms: List[str] = []
    dist_x, dist_y = ANIM_SLIDE * spec.width, ANIM_SLIDE * spec.height
    # The end keyframe: linear over the whole span (``span`` is 0..1 at ``t``).
    span_s = max(t_end - t_start, 1e-3)
    span = f"clip((t-{t_start:.3f})/{span_s:.3f},0,1)"
    if o.to_x is not None and o.to_x != o.x:
        move_x += f"+({(o.to_x - o.x) * spec.width:.3f})*{span}"
    if o.to_y is not None and o.to_y != o.y:
        move_y += f"+({(o.to_y - o.y) * spec.height:.3f})*{span}"
    if o.to_w is not None and o.to_w != o.w:
        scale_terms.append(f"(({o.w:.4f}+({o.to_w - o.w:.4f})*{span})/{max(o.w, o.to_w):.4f})")
    if o.to_opacity is not None and o.to_opacity != o.opacity:
        # A move to or from nothing is a fade (cheap); anything else rewrites the
        # alpha plane per pixel with the time (geq): exact, but slow on a big overlay.
        if o.opacity <= 0:
            filters += f",fade=t=in:st={t_start:.3f}:d={span_s:.3f}:alpha=1"
        elif o.to_opacity <= 0:
            filters += f",fade=t=out:st={t_start:.3f}:d={span_s:.3f}:alpha=1"
        else:
            top = max(o.opacity, o.to_opacity)
            m0, m1 = o.opacity / top, o.to_opacity / top
            filters += (",geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*("
                        f"{m0:.4f}+({m1 - m0:.4f})*clip((T-{t_start:.3f})/{span_s:.3f},0,1))'")
    for key, entering in (("anim_in", True), ("anim_out", False)):
        kind = getattr(o, key)
        if kind is None:
            continue
        if kind not in (ANIM_IN if entering else ANIM_OUT) or kind == "typewriter":
            raise ValueError(f"unknown picture animation {kind!r}")
        d = float(getattr(o, key + "_s"))
        t0 = t_start if entering else t_end - d
        filters += (f",fade=t={'in' if entering else 'out'}:st={t0:.3f}:d={d:.3f}:alpha=1")
        progress = f"clip((t-{t0:.3f})/{d:.3f},0,1)"
        if kind in _SLIDE_DIRECTIONS:
            vx, vy = _SLIDE_DIRECTIONS[kind]
            # entering: from -v*dist to 0; leaving: from 0 to +v*dist
            amount = f"(1-{progress})" if entering else progress
            sign = "-" if entering else "+"
            if vx:
                move_x += f"{sign}({vx * dist_x:.3f})*{amount}"
            if vy:
                move_y += f"{sign}({vy * dist_y:.3f})*{amount}"
        elif kind == "pop":
            small = 1.0 - ANIM_POP_FROM
            scale_terms.append(f"(1-{small:.3f}*(1-{progress}))" if entering
                               else f"(1-{small:.3f}*{progress})")
    if scale_terms:
        factor = "*".join(scale_terms)
        filters += (f",scale=w='max(2,trunc(iw*{factor}/2)*2)':h='max(2,trunc(ih*{factor}/2)*2)'"
                    ":eval=frame")
    return filters, move_x, move_y


#: Direction each slide moves (x, y); the same table the ASS writer has.
_SLIDE_DIRECTIONS = {"slide-up": (0, -1), "slide-down": (0, 1), "slide-left": (-1, 0),
                     "slide-right": (1, 0)}


def picture_overlay_filters(spec: RenderSpec, first_input: int, source: str
                            ) -> Tuple[List[str], str]:
    """The filter-graph parts that lay the picture overlays over ``source`` (a
    label such as ``[0:v]``) and the label of the result.

    Per overlay: the picture is scaled to ``w`` of the frame width (inside a
    box twice the frame's height, so a very tall picture cannot ask for an
    enormous frame), its alpha multiplied by the opacity, converted to the YUV
    with alpha that ``overlay`` blends in (BT.709 in an HD frame: the matrix a
    player assumes for it) and shifted to start on the frame ``start_s`` falls
    on. ``overlay`` then puts its centre where ``x`` / ``y`` say, for those
    frames only (``enable`` with half-frame margins, so float noise at a frame
    edge cannot move it). A picture is cut to its first frame and held for the
    span by ``tpad``, so it is decoded and converted once, not per frame.
    Every number is formatted here; the input's path is an argument, never
    part of the graph."""
    fps = int(spec.fps)
    box_h = max(2, int(spec.height) * 2)
    hd = spec.height >= 720 or spec.width >= 1280
    matrix = "out_color_matrix=bt709:out_range=tv:" if hd else ""
    parts: List[str] = []
    for k, o in enumerate(spec.picture_overlays):
        first = _frame_of(o.start_s, fps)
        last = _frame_of(o.end_s, fps)          # the first frame it is NOT shown on
        # The widest the picture ever is: a move to a bigger width scales DOWN from it.
        wide = max(o.w, o.to_w) if o.to_w is not None else o.w
        op_static = max(o.opacity, o.to_opacity) if o.to_opacity is not None else o.opacity
        box_w = max(2, int(round(wide * spec.width)) // 2 * 2)
        fit = (f"scale={box_w}:{box_h}:force_original_aspect_ratio=decrease"
               ":force_divisible_by=2:flags=bicubic")
        yuva = f"scale={matrix}flags=bicubic,format=yuva420p"
        key = ""
        keyed_still = False
        if o.chroma_color is not None:
            # Keyed on the source (before it is scaled): YUVA out, which the scaler and the
            # opacity / alpha steps below keep. The colour is a validated #RRGGBB, written as 0xRRGGBB.
            if not _HEX.fullmatch(o.chroma_color):
                raise ValueError(f"unknown chroma colour {o.chroma_color!r}")
            keyer = (f"chromakey=color=0x{o.chroma_color[1:].upper()}:similarity={o.chroma_similarity:.3f}"
                     f":blend={o.chroma_blend:.3f}")
            if o.kind == KIND_VIDEO:
                key = keyer + ","
            else:
                keyed_still = True
        # An opaque video stays in its own YUV: no round trip through RGB.
        if o.kind == KIND_VIDEO and op_static >= 1.0:
            colour = f"{key}{fit},format=yuva420p"
        elif op_static >= 1.0:
            colour = f"{key}{fit},format=rgba,{yuva}"
        else:
            colour = f"{key}{fit},format=rgba,colorchannelmixer=aa={op_static:.3f},{yuva}"
        src = f"[{first_input + k}:v]"
        if o.kind == KIND_VIDEO:
            chain = f"setpts=PTS-STARTPTS,fps={fps},{colour}"
        elif keyed_still:
            # chromakey WRITES the alpha (opaque everywhere but the keyed colour), so a picture
            # with transparency of its own would lose it. The key's alpha is multiplied by the
            # picture's own, on its one frame, and merged back onto the colours.
            parts.append(f"{src}trim=end_frame=1,setpts=PTS-STARTPTS,fps={fps},format=rgba,"
                         f"split=3[ca{k}][cb{k}][cc{k}]")
            parts.append(f"[ca{k}]{keyer},format=yuva420p,alphaextract[ka{k}]")
            parts.append(f"[cb{k}]alphaextract[oa{k}]")
            parts.append(f"[ka{k}][oa{k}]blend=all_mode=multiply,format=gray[ma{k}]")
            src = f"[cc{k}][ma{k}]"
            # (the frame rate is set before the split: fps after alphamerge emits nothing for
            # one frame, measured)
            chain = f"alphamerge,{colour},tpad=stop={last - first - 1}:stop_mode=clone"
        else:
            chain = (f"trim=end_frame=1,setpts=PTS-STARTPTS,{colour},fps={fps},"
                     f"tpad=stop={last - first - 1}:stop_mode=clone")
        chain += f",setpts=PTS+{first}/({fps}*TB)"
        move_x = move_y = ""
        if o.anim_in is not None or o.anim_out is not None or o.moves:
            extra, move_x, move_y = _overlay_anim_filters(o, first / fps, last / fps, spec)
            chain += extra
        parts.append(f"{src}{chain}[p{k}]")
        lo, hi = (first - 0.5) / fps, (last - 0.5) / fps
        out = f"[pv{k}]"
        parts.append(f"{source}[p{k}]overlay=x='round({o.x * spec.width:.3f}{move_x}-w/2)'"
                     f":y='round({o.y * spec.height:.3f}{move_y}-h/2)'"
                     f":enable='between(t,{lo:.6f},{hi:.6f})':eof_action=pass{out}")
        source = out
    return parts, source


def _timeline_command(spec: RenderSpec, concat_list_path: str,
                      overlay_path: Optional[str]) -> List[str]:
    """The final pass for a timeline spec: one filter graph that burns the
    subtitle file and/or text overlays into the concatenated picture and mixes
    every audio track, cut to the picture's exact length.

    ``amix`` runs with ``normalize=0``: by default it divides every input by
    the number of inputs, so adding a music track would quietly halve the
    voice-over. No ``-shortest`` either — the mix is padded with silence and
    trimmed to the video, so the picture (the timeline) decides the length."""
    if spec.overlays and not overlay_path:
        raise ValueError("a spec with text overlays needs the overlay file path")
    cmd: List[str] = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list_path]
    for track in spec.audio_tracks:
        cmd += ["-i", track.path]
    # The picture overlays' inputs follow the audio tracks (whose indexes
    # stay 1..n), so a spec without them is the command it always was.
    cmd += picture_overlay_inputs(spec)

    graph: List[str] = []
    burn: List[str] = []
    if spec.subtitle_path:
        burn.append("subtitles=" + _quote_filter_path(spec.subtitle_path))
    if spec.overlays:
        burn.append("subtitles=" + _quote_filter_path(overlay_path))
    video_out = "0:v"
    picture = "[0:v]"
    if spec.picture_overlays:
        # Over the picture, under the text: a title stays readable on a sticker.
        parts, picture = picture_overlay_filters(spec, 1 + len(spec.audio_tracks), picture)
        graph.extend(parts)
        video_out = picture
    if burn:
        graph.append(picture + ",".join(burn) + "[vout]")
        video_out = "[vout]"
    labels = []
    for run in audio_runs(spec.audio_tracks):
        label = f"a{run[0]}"
        graph.extend(audio_run_filters(spec.audio_tracks, run, label))
        if spec.audio_tracks[run[0]].duck_spans:
            # After the run's delay, so `t` in the envelope is output time.
            graph.append(audio_duck_filter(spec.audio_tracks[run[0]], label, f"{label}d"))
            label = f"{label}d"
        labels.append(f"[{label}]")
    if labels:
        graph.append("".join(labels)
                     + f"amix=inputs={len(labels)}:duration=longest:normalize=0,"
                     + f"apad,atrim=end={spec.video_length_s:.6f}[aout]")

    if graph:
        cmd += ["-filter_complex", ";".join(graph)]
    cmd += ["-map", video_out]
    if labels:
        cmd += ["-map", "[aout]"]
    cmd += ["-r", str(spec.fps), "-c:v", "libx264", *final_x264(spec), "-pix_fmt", "yuv420p"]
    if labels:
        cmd += ["-c:a", "aac"]
    cmd.append(spec.output_path)
    # Audio tracks are read as [n:a] only, so no picture of theirs is decoded;
    # the cap is there anyway, on every input. No -xerror: a damaged audio
    # frame is skipped, as it always was. A video overlay is held to the video
    # decoder cap, a picture to the still one.
    return cap_inputs(cmd, out_pixels=spec.width * spec.height,
                      video_inputs=[o.path for o in spec.picture_overlays if o.kind == KIND_VIDEO])

