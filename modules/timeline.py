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
      captions?: { style?: {...,  preset?: <one of caption_styles.STYLE_IDS>,
                              highlight_color?: "#RRGGBB"},
                   cues: [ { id, start_s, end_s, text } ] },
      overlays?: [ { id, asset_id, start_s, end_s, x?, y?, w?, opacity? } ] }

    V clip: { id, asset_id, start_s, in_s, out_s, fit?, fade_in_s?, fade_out_s?,
              transition?: { type: "cut"|"dip_to_black"|"crossfade", duration_s,
                             style?: <one of XFADE_STYLES, crossfade only> },
              speed?: 0.5..2, audio?: bool,
              grade?: { brightness: -1..1, contrast: 0..2, saturation: 0..3 },
              filter?, filter_strength?, vignette?, blur?, sharpen?, grain?,
              flip_h?, flip_v?, rotate?,
              move?: { from: {zoom?, x?, y?}, to: {zoom?, x?, y?} } }
    A track: { ..., role?: "music"|"speech", duck?: { amount_db, attack_s?, release_s? } }
    A clip: { id, asset_id, start_s, in_s, out_s, gain_db?, fade_in_s?, fade_out_s? }
    T clip: { id, start_s, end_s, text, font?, size?, color?, outline_color?,
              outline_width?, bold?, shadow?, box_color?, box_opacity?, x?, y?,
              anchor?, fade_in_s?, fade_out_s?,
              anim_in?, anim_out?, anim_in_s?, anim_out_s? }
    overlay: { id, asset_id, start_s, end_s, x?: 0..1, y?: 0..1, w?: 0.05..1,
               opacity?: 0..1, anim_in?, anim_out?, anim_in_s?, anim_out_s?,
               move?: { to: {x?, y?, w?, opacity?} } }
               (a picture or video over the picture; see below)

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
* **A cross-fade has a style from a closed list.** ``transition.style`` (only on
  a ``crossfade``) names one of ``XFADE_STYLES``: ffmpeg ``xfade`` transitions
  that cost the same as the plain blend (``fade``, the default, is the
  dissolve every older document renders; a ``fade`` written out is dropped by
  ``normalise`` so it is the same document). The style changes how the two
  pictures are mixed over the cross-fade's span and nothing else: the layout,
  the length and the sound (always an equal-gain blend) are the same for every
  style. Only the name is stored; ffmpeg's ``custom`` transition (an
  expression) is not on the list.
* **Text looks are fields, not effects.** A text clip may carry ``shadow``
  (0-20 px, a soft black drop shadow), ``box_color`` (a ``#RRGGBB`` box drawn
  behind the text instead of its outline) and ``box_opacity`` (0-1, only with
  a ``box_color``). A text without them renders the ASS file it always did.
* **Entrance and exit animations are named, closed and short.** A text clip
  or an overlay may carry ``anim_in`` / ``anim_out`` (one of ``ANIM_IN`` /
  ``ANIM_OUT``) and ``anim_in_s`` / ``anim_out_s`` (``ANIM_MIN_S``-``ANIM_MAX_S``
  seconds, ``ANIM_DEFAULT_S`` when absent; a duration without its animation is
  refused). ``fade`` fades the alpha; ``slide-up|down|left|right`` moves the
  item that way by ``ANIM_SLIDE`` of the frame while it fades; ``pop`` scales it
  from ``ANIM_POP_FROM`` to full size while it fades; ``typewriter`` (text, in
  only) reveals the characters one by one. In and out together never take
  longer than the item is shown. On a text, ``anim_in`` replaces ``fade_in_s``
  (and ``anim_out`` ``fade_out_s``): giving both is refused rather than guessed.
  Without any of these fields every item renders as it always did.
* **Times are seconds, normalised to milliseconds**, and the render cuts on
  the frame grid (``round(t * fps)``), so the same document always renders
  the same frames.
* **Speed changes how long a clip lasts, not what it shows.** ``in_s`` and
  ``out_s`` are SOURCE times; a V clip at ``speed`` 2 plays that range in
  half the time, so its end on the timeline is
  ``start_s + (out_s - in_s) / speed``. The range 0.5-2 is what one ffmpeg
  ``atempo`` stage keeps in tune, so a sped-up clip's own sound never needs
  a chain of filters to stay intelligible.
* **Ducking is a track option, not an effect on a clip.** An A track may carry
  ``duck: {amount_db, attack_s?, release_s?}``: while speech plays, that
  track's sound is lowered by ``amount_db`` (an exact amount, not a
  compressor's ratio), reaching it ``attack_s`` before the speech starts and
  coming back over ``release_s`` after it ends. Speech is every A track whose
  ``role`` is ``"speech"`` and every video clip that plays its own sound.
  The envelope comes from where those clips sit on the timeline, so the same
  document always renders the same sound. A speech track cannot itself be
  ducked, which keeps "who lowers whom" a one-way question.
* **Colour is a per-clip grade, not a filter chain.** ``grade`` holds exactly
  three numbers that map one-to-one onto ffmpeg's ``eq`` filter (brightness
  -1..1 added to the luma, contrast 0..2 around mid-grey, saturation 0..3 on
  the chroma; 0 / 1 / 1 is "no change"). A clip without ``grade`` — every
  older document — renders exactly the command it always did; a neutral
  ``grade`` is dropped by ``normalise`` for the same reason. It applies to
  the picture only (bars of a ``contain`` fit and fades to black stay black)
  and to stills as well as video.
* **Effects are named, closed and clamped.** A V clip may carry ``filter`` (one
  of ``FILTERS``: a colour look) with ``filter_strength`` (0-1, 1 when absent,
  needs a ``filter``), ``vignette`` / ``sharpen`` / ``grain`` (0-1), ``blur`` (a
  Gaussian sigma in output pixels, 0-``BLUR_MAX``), ``flip_h`` / ``flip_v``
  (mirror) and ``rotate`` (0, 90, 180 or 270 degrees clockwise). Rotation and
  mirroring happen on the source before it is fitted to the frame (so a 90-degree
  turn of a landscape clip is fitted as a portrait picture); the colour and
  texture effects run on the fitted picture, after ``grade`` and before the
  bars of a ``contain`` fit are added (bars stay black). They apply to stills
  as well as video, on both sides of a cross-fade. Every value that means "off"
  (no ``filter``, 0, ``false``, 0 degrees) is dropped by ``normalise``, and a
  clip without effects renders the command it always did.
* **A move is two keyframes, linear between them.** A V clip's ``move`` has a
  ``from`` and a ``to`` point, each a window onto the FITTED picture: ``zoom``
  (``MOVE_ZOOM_MIN``-``MOVE_ZOOM_MAX``, 1 = the whole picture, 2 = the middle
  quarter) and the window's centre ``x`` / ``y`` (0-1; defaults 1 / 0.5 / 0.5).
  The centre is held where the window stays inside the picture. The window
  travels from ``from`` on the clip's first frame to ``to`` on its last, in
  steps of whole frames. A still with a ``move`` has THAT move instead of the
  automatic slow zoom it otherwise gets (a ``move`` whose two points are equal
  is a still that does not move at all); a video clip with an unmoving move is
  unchanged. An overlay's ``move: {to: {...}}`` moves its centre (``x``,
  ``y``), width (``w``) and ``opacity`` from the overlay's own values to the
  given ones over its ``start_s``..``end_s``; an entrance / exit animation adds
  to it. Animated opacity is the one part that costs real time (a per-pixel
  expression on the overlay), except a move to or from 0, which is a fade.
* **Overlays are a layer above the picture, not a second picture lane.**
  ``overlays`` is a top-level list (so "one V track" stays true): each one is
  a picture or a video (``asset_id``) shown from ``start_s`` to ``end_s`` over
  the composited picture, its CENTRE at (``x``, ``y``) and its width ``w``,
  all fractions of the frame (so the same document fits any resolution; the
  height follows the file's own aspect ratio), at ``opacity``. A picture
  keeps its own transparency; a video plays from its first frame and is
  never heard. They may overlap in time (that is stacking; the list order is
  the layering, later on top) and sit under the texts and captions. They do
  NOT lengthen the timeline: what runs past the picture's end is cut, and an
  overlay of opacity 0 renders nothing. A video overlay must be at least as
  long as its span (nothing loops or freezes). Neutral — no ``overlays``, or an
  empty list, which ``normalise`` drops — renders the commands it always did.
  At most ``MAX_OVERLAYS`` overlays and ``MAX_OVERLAY_VIDEOS`` of them videos:
  each is an input of the final pass. Its ``asset_id`` is checked like a
  clip's, in every layer (the database's editor_doc_problem sees ``asset_id``
  at any depth).
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

from modules import caption_styles

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
#: The largest frame an export renders: 4K UHD in either orientation (a
#: 4096-px side is fine on a narrower frame). Larger frames do not fit the
#: export's per-process memory limit in libx264's final pass (BR-L-014:
#: 4096x2304 needed 2212 MB, 4096x4096 3849 MB), and at 60 fps for the
#: longest export they would pass the library's decode budget (BR-L-017).
MAX_FRAME_PIXELS = 3840 * 2160

#: Upper bounds that keep one document from tying up the render worker.
MAX_DURATION_S = 4 * 3600.0
MAX_TRACKS = 32
MAX_CLIPS_PER_TRACK = 2000
MAX_CUES = 5000
#: Every audio clip is one more input — one more open decoder — in the final
#: ffmpeg pass (render_spec._timeline_command), so they are counted per document.
MAX_AUDIO_CLIPS = 64
MAX_TOTAL_CLIPS = 5000
#: Picture overlays (render_spec.MAX_PICTURE_* are the same numbers; a test pins
#: them). Each is one more input and filter chain in the final pass; a video
#: keeps a decoder open for its whole span.
MAX_OVERLAYS = 16
#: An overlay whose opacity goes from one visible value to another during a move rewrites its alpha
#: plane per pixel and frame (``geq``): measured 3.6x slower for one video overlay, 13x for four, and
#: out of memory at 4K60. A move to or from nothing is a cheap fade and is not counted.
MAX_PARTIAL_OPACITY_MOVES = 2
MAX_OVERLAY_VIDEOS = 4
OVERLAY_W_MIN, OVERLAY_W_MAX = 0.05, 1.0
MAX_TEXT = 500
MAX_ID = 64
MAX_DOC_BYTES = 2_000_000

FITS = ("contain", "cover")
#: A clip's colour grade (ffmpeg ``eq`` brightness / contrast / saturation, each
#: at its own range; render_spec.GRADE_* are the same numbers, a test pins them).
#: Wider than that the picture is a flat colour: brightness +-1 is white / black,
#: contrast 0 is a flat grey, saturation 0 is monochrome (3 is eq's own ceiling).
GRADE_RANGES = {"brightness": (-1.0, 1.0), "contrast": (0.0, 2.0), "saturation": (0.0, 3.0)}
GRADE_NEUTRAL = {"brightness": 0.0, "contrast": 1.0, "saturation": 1.0}
TRANSITIONS = ("cut", "dip_to_black", "crossfade")
#: ffmpeg ``xfade`` transitions a cross-fade may use (render_spec.XFADE_STYLES is
#: the same list, a test pins them). A closed whitelist: the name goes into a
#: filter graph, so it is never free text, and ``custom`` (an expression) is
#: not on it. Every one of these is a per-pixel mix of two frames that costs
#: about what the plain ``fade`` does (measured, tests/test_editor_transitions.py).
XFADE_STYLES = ("fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight",
                "slideleft", "slideright", "slideup", "slidedown", "circleopen",
                "circleclose", "radial", "zoomin",
                "wipeup", "wipedown", "smoothleft", "smoothright", "smoothup",
                "smoothdown", "vertopen", "vertclose", "horzopen", "horzclose",
                "diagtl", "diagtr", "diagbl", "diagbr", "wipetl",
                "wipetr", "wipebl", "wipebr", "squeezeh", "squeezev",
                "pixelize", "hblur", "distance")
XFADE_DEFAULT_STYLE = "fade"
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
ROLES = ("music", "speech")
#: Ducking limits. Under 1 dB nobody hears it; over 40 dB the track is gone,
#: which is what the track's own gain is for. An attack under 50 ms is faster
#: than the audio frames the volume filter re-evaluates at, so it would step.
DUCK_DB_MIN, DUCK_DB_MAX = 1.0, 40.0
DUCK_ATTACK_MIN_S, DUCK_ATTACK_MAX_S = 0.05, 2.0
DUCK_RELEASE_MIN_S, DUCK_RELEASE_MAX_S = 0.1, 5.0
DUCK_DEFAULTS = {"attack_s": 0.3, "release_s": 0.8}
SIZE_MIN, SIZE_MAX = 8, 512
OUTLINE_MAX = 20.0
#: A text's drop shadow offset, in output pixels (render_spec.SHADOW_MAX is the
#: same number); over 20 px the shadow is a second, detached text.
SHADOW_MAX = 20.0
#: A text's box opacity when ``box_color`` is set without one.
BOX_OPACITY_DEFAULT = 0.7
#: Per-clip playback speed. One atempo stage covers exactly this range
#: (render_spec.SPEED_MIN/MAX are the same numbers; a test pins them).
SPEED_MIN, SPEED_MAX = 0.5, 2.0

#: Entrance / exit animations of a text or an overlay (render_spec.ANIM_* are
#: the same lists; a test pins them). The name decides which filter or ASS tag
#: is written, so it is never free text. Slides are named by the direction the
#: item MOVES (``slide-up`` enters from below, leaves upwards).
ANIM_OUT = ("fade", "slide-up", "slide-down", "slide-left", "slide-right", "pop")
ANIM_IN = ANIM_OUT + ("typewriter",)
ANIM_MIN_S, ANIM_MAX_S, ANIM_DEFAULT_S = 0.1, 2.0, 0.4
#: How far a slide travels (a fraction of the frame's width or height) and the
#: size a pop starts from / ends at.
ANIM_SLIDE = 0.15
ANIM_POP_FROM = 0.6
#: A typewriter text writes one ASS event per step; this many per document keeps
#: the subtitle file (and libass) small however long the document is.
MAX_TYPEWRITER_TEXTS = 20

#: Clip effects (render_spec.FILTERS / EFFECT_* are the same; a test pins them).
#: The name picks the filter written, so it is never free text.
FILTERS = ("mono", "sepia", "vintage", "cinematic", "cool", "warm", "high-contrast")
UNIT_EFFECTS = ("vignette", "sharpen", "grain")      # 0..1, 0 = off
BLUR_MAX = 30.0                                       # Gaussian sigma, output pixels
#: A cross-fade renders its two clips in one ffmpeg run, and above 1440p that run already needs ~1.75 of
#: the worker's 2 GiB address space (4K60, measured with ffmpeg 5.1.1 and 7.0.2). A Gaussian blur on top
#: failed it ("Cannot allocate memory", exit 187): with 7.0.2 at every sigma tried (5, 10, 15, 20, 30), with
#: 5.1.1 from sigma 30 (up to 20 passed) and, with 5.1.1, a blur of 5 or more together with a zoom to 2
#: or more. So a cross-faded clip in such a frame takes no blur at all. The other effects (look, sharpen,
#: grain, vignette, turns) passed with both builds. render_backend.LARGE_OUTPUT_PX is the same 2560x1440.
LARGE_FRAME_PX = 2560 * 1440
XFADE_LARGE_BLUR_MAX = 0.0
#: The same for a move that zooms: the fitted picture is scaled up to ``zoom`` x the frame every frame, and
#: on a cross-faded 4K60 clip a zoom of 3 failed it with ffmpeg 7.0.2 (up to 2 passed with both builds; 4
#: passed with 5.1.1 alone, and any zoom passes on a single clip).
XFADE_LARGE_ZOOM_MAX = 2.0
ROTATIONS = (0, 90, 180, 270)
_EFFECT_KEYS = ("filter", "filter_strength", "vignette", "blur", "sharpen", "grain",
                "flip_h", "flip_v", "rotate")

#: A clip's move (render_spec.MOVE_* are the same; a test pins them).
MOVE_ZOOM_MIN, MOVE_ZOOM_MAX = 1.0, 4.0
MOVE_POINT_DEFAULTS = {"zoom": 1.0, "x": 0.5, "y": 0.5}
_MOVE_POINT_KEYS = tuple(MOVE_POINT_DEFAULTS)
#: What an overlay's ``move.to`` may change.
_OVERLAY_MOVE_KEYS = ("x", "y", "w", "opacity")

ASSET_VIDEO, ASSET_IMAGE, ASSET_AUDIO = "video", "image", "audio"
#: Which asset kinds an overlay may use (a picture or a video, never a sound).
OVERLAY_ASSET_KINDS = (ASSET_VIDEO, ASSET_IMAGE)
#: Which asset kinds a clip on each track kind may use.
TRACK_ASSET_KINDS = {KIND_V: (ASSET_VIDEO, ASSET_IMAGE), KIND_A: (ASSET_AUDIO,)}

#: A pathological document must not become a megabyte of error text.
_MAX_REPORTED = 20

#: The patterns are the schema's (a test pins them equal), and are used with
#: ``fullmatch``: ``$`` also matches before a trailing newline, so "c1\n" would pass
#: ``match`` here and fail the web validator (JavaScript's ``$`` does not).
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

# Field lists — the schema's "required"/"properties" (tests pin them together).
_DOC_REQUIRED = ("version", "width", "height", "fps", "tracks")
_DOC_KEYS = _DOC_REQUIRED + ("captions", "overlays")
_TRACK_REQUIRED = ("id", "kind", "clips")
_TRACK_KEYS = _TRACK_REQUIRED + ("name",)
_A_TRACK_KEYS = _TRACK_KEYS + ("role", "duck")
_DUCK_REQUIRED = ("amount_db",)
_DUCK_KEYS = _DUCK_REQUIRED + ("attack_s", "release_s")
_MEDIA_REQUIRED = ("id", "asset_id", "start_s", "in_s", "out_s")
_V_CLIP_KEYS = _MEDIA_REQUIRED + ("fit", "fade_in_s", "fade_out_s", "transition", "speed", "audio",
                                  "grade", "move") + _EFFECT_KEYS
_GRADE_KEYS = tuple(GRADE_RANGES)
_A_CLIP_KEYS = _MEDIA_REQUIRED + ("gain_db", "fade_in_s", "fade_out_s")
_T_REQUIRED = ("id", "start_s", "end_s", "text")
_TEXT_STYLE_KEYS = ("font", "size", "color", "outline_color", "outline_width", "bold")
#: Looks only a text clip has (the captions' style has none: it stays as it is).
_TEXT_LOOK_KEYS = ("shadow", "box_color", "box_opacity")
_ANIM_KEYS = ("anim_in", "anim_out", "anim_in_s", "anim_out_s")
_T_CLIP_KEYS = (_T_REQUIRED + _TEXT_STYLE_KEYS + _TEXT_LOOK_KEYS
                + ("x", "y", "anchor", "fade_in_s", "fade_out_s") + _ANIM_KEYS)
_TRANSITION_KEYS = ("type", "duration_s")
_TRANSITION_ALLOWED = _TRANSITION_KEYS + ("style",)
_CAPTIONS_KEYS = ("style", "cues")
#: ``preset`` is one of caption_styles.STYLE_IDS (an animated style); absent = the
#: plain caption every older document has. ``highlight_color`` is the second
#: colour a style may draw (the lit word, the box, the glow).
_CAPTION_STYLE_KEYS = _TEXT_STYLE_KEYS + ("y", "preset", "highlight_color")
_CUE_KEYS = ("id", "start_s", "end_s", "text")
_OVERLAY_REQUIRED = ("id", "asset_id", "start_s", "end_s")
_OVERLAY_KEYS = _OVERLAY_REQUIRED + ("x", "y", "w", "opacity") + _ANIM_KEYS + ("move",)

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
#: An overlay's defaults: the middle of the frame, a third of its width, opaque.
OVERLAY_DEFAULTS = {"x": 0.5, "y": 0.5, "w": 0.3, "opacity": 1.0}


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
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:
        # An int too large for a float (reachable only by writing the database
        # directly): not a number a timeline can use, never an exception.
        return False


def _shown(v, limit: int = 60) -> str:
    """``repr`` for an error message, cut short (a 4000-digit int is not a message)."""
    try:
        s = repr(v)
    except ValueError:
        # An int of more than 4300 digits has no repr (Python's int-to-str limit).
        return "<a number too large to show>"
    return s if len(s) <= limit else s[:limit - 3] + "..."


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _in_range(v) -> bool:
    """A time the document may hold (0 to MAX_DURATION_S): safe to do arithmetic on."""
    return _is_num(v) and 0 <= v <= MAX_DURATION_S


def _ms(v: float) -> float:
    return round(float(v), 3)


def _where(track: dict, clip: Optional[dict] = None) -> str:
    t = f"track {_shown(track.get('id'), 200)}" if isinstance(track, dict) else "track"
    if clip is None:
        return t
    c = clip.get("id") if isinstance(clip, dict) else None
    return f"{t} clip {_shown(c, 200)}"


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
        problems.append(f"{where}: {key} must be a number {rng} (got {_shown(v)})")


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
        if k in obj and not (isinstance(obj[k], str) and _HEX_RE.fullmatch(obj[k])):
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
    ver = doc.get("version")
    # `true == 1` and `1.0 == 1` in Python; the document's version is the integer 1.
    if not _is_int(ver) or ver != VERSION:
        problems.append(f"timeline: version must be {VERSION} (got {_shown(doc.get('version'))})")
    for k in ("width", "height"):
        v = doc.get(k)
        if not (_is_int(v) and MIN_SIDE <= v <= MAX_SIDE and v % 2 == 0):
            problems.append(f"timeline: {k} must be an even integer from {MIN_SIDE} to "
                            f"{MAX_SIDE} (H.264 4:2:0 needs even sides; got {_shown(v)})")
    w, h = doc.get("width"), doc.get("height")
    if _is_int(w) and _is_int(h) and w * h > MAX_FRAME_PIXELS:
        problems.append(f"timeline: the frame is at most {MAX_FRAME_PIXELS} pixels (3840x2160 or "
                        f"2160x3840; got {_shown(w)}x{_shown(h)})")
    fps = doc.get("fps")
    if fps not in FPS_VALUES or not _is_int(fps):
        problems.append(f"timeline: fps must be one of {list(FPS_VALUES)} (got {_shown(fps)})")
        fps = None

    ids: Dict[str, str] = {}

    def claim(ident, where):
        if not (isinstance(ident, str) and _ID_RE.fullmatch(ident)):
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
        is_audio = isinstance(track, dict) and track.get("kind") == KIND_A
        if not _fields(track, _A_TRACK_KEYS if is_audio else _TRACK_KEYS, _TRACK_REQUIRED,
                       where, problems):
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
        if kind == KIND_A:
            _validate_audio_track_options(track, where, problems)
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

    n_type = sum(1 for t in counted if t.get("kind") == KIND_T
                 for c in t["clips"] if isinstance(c, dict) and c.get("anim_in") == "typewriter")
    if n_type > MAX_TYPEWRITER_TEXTS:
        problems.append(f"timeline: at most {MAX_TYPEWRITER_TEXTS} typewriter texts (got {n_type})")

    captions = doc.get("captions")
    if captions is not None:
        _validate_captions(captions, problems, claim)
    if "overlays" in doc:
        _validate_overlays(doc["overlays"], fps, problems, claim)

    if problems:
        return problems
    # Semantic checks need a structurally valid document.
    # One past the limit is enough to say "and more": 5000 captions on one span
    # are 12.5 million pairs, and listing them all took seconds and a gigabyte.
    found = overlaps(doc, limit=_MAX_REPORTED + 1)
    for ov in found[:_MAX_REPORTED]:
        problems.append(f"track {ov[0]!r}: clips {ov[1]!r} and {ov[2]!r} overlap "
                        f"({ov[3]:.3f}-{ov[4]:.3f} s) — move one to another track")
    if len(found) > _MAX_REPORTED:
        problems.append("... and more overlaps")
    problems.extend(_transition_problems(doc))
    total = duration_s(doc)
    if total <= 0:
        problems.append("timeline: nothing to render — add a clip, a text or a caption")
    elif total > MAX_DURATION_S:
        problems.append(f"timeline: longer than {MAX_DURATION_S / 3600:g} hours ({total:.3f} s)")
    return problems


def _validate_audio_track_options(track, where, problems) -> None:
    """``role`` and ``duck`` of an A track (see the module docstring)."""
    if "role" in track and track["role"] not in ROLES:
        problems.append(f"{where}: role must be one of {list(ROLES)}")
    if "duck" not in track:
        return
    duck = track["duck"]
    dwhere = f"{where} duck"
    if _fields(duck, _DUCK_KEYS, _DUCK_REQUIRED, dwhere, problems):
        _num_in(duck, "amount_db", DUCK_DB_MIN, DUCK_DB_MAX, dwhere, problems)
        _num_in(duck, "attack_s", DUCK_ATTACK_MIN_S, DUCK_ATTACK_MAX_S, dwhere, problems)
        _num_in(duck, "release_s", DUCK_RELEASE_MIN_S, DUCK_RELEASE_MAX_S, dwhere, problems)
    if track.get("role") == "speech":
        problems.append(f"{where}: a speech track cannot be lowered under speech (remove duck "
                        "or set role to music)")


def _validate_media_clip(clip, kind, where, fps, problems, claim) -> None:
    keys = _V_CLIP_KEYS if kind == KIND_V else _A_CLIP_KEYS
    if not _fields(clip, keys, _MEDIA_REQUIRED, where, problems):
        return
    claim(clip.get("id"), where)
    aid = clip.get("asset_id")
    if not (isinstance(aid, str) and _UUID_RE.fullmatch(aid)):
        problems.append(f"{where}: asset_id must be a uuid (got {_shown(aid, 200)})")
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
    # Range first, derived maths after: an out_s of 1e308 is already reported above, and
    # `round(length * fps)` of it is an OverflowError, not a problem (a crash that left an
    # export stuck rendering).
    if _in_range(ins) and _in_range(outs) and speed:
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
        if "grade" in clip and _fields(clip["grade"], _GRADE_KEYS, _GRADE_KEYS,
                                       f"{where} grade", problems):
            for k, (lo, hi) in GRADE_RANGES.items():
                _num_in(clip["grade"], k, lo, hi, f"{where} grade", problems)
        _validate_effects(clip, where, problems)
        if "move" in clip:
            _validate_clip_move(clip["move"], where, problems)
        if "transition" in clip:
            tr = clip["transition"]
            if _fields(tr, _TRANSITION_ALLOWED, _TRANSITION_KEYS, f"{where} transition", problems):
                if tr.get("type") not in TRANSITIONS:
                    problems.append(f"{where}: transition type must be one of {list(TRANSITIONS)}")
                if "style" in tr:
                    if not (isinstance(tr["style"], str) and tr["style"] in XFADE_STYLES):
                        problems.append(f"{where} transition: style must be one of the {len(XFADE_STYLES)} "
                                        "blend styles in schemas/timeline.schema.json")
                    elif tr.get("type") != "crossfade":
                        problems.append(f"{where} transition: a style is only for a crossfade")
                if tr.get("type") == "crossfade":
                    _num_in(tr, "duration_s", XFADE_MIN_S, XFADE_MAX_S, f"{where} transition", problems)
                else:
                    _num_in(tr, "duration_s", 0, 10.0, f"{where} transition", problems)
    else:
        _num_in(clip, "gain_db", GAIN_DB_MIN, GAIN_DB_MAX, where, problems)


def _validate_move_point(point, where, problems) -> None:
    if not _fields(point, _MOVE_POINT_KEYS, (), where, problems):
        return
    _num_in(point, "zoom", MOVE_ZOOM_MIN, MOVE_ZOOM_MAX, where, problems)
    for k in ("x", "y"):
        _num_in(point, k, 0, 1, where, problems)


def _validate_clip_move(move, where, problems) -> None:
    if not _fields(move, ("from", "to"), ("from", "to"), f"{where} move", problems):
        return
    for k in ("from", "to"):
        if k in move:
            _validate_move_point(move[k], f"{where} move {k}", problems)


def _validate_overlay_move(move, where, problems) -> None:
    if not _fields(move, ("to",), ("to",), f"{where} move", problems) or "to" not in move:
        return
    to = move["to"]
    twhere = f"{where} move to"
    if not _fields(to, _OVERLAY_MOVE_KEYS, (), twhere, problems):
        return
    if not to:
        problems.append(f"{twhere}: give at least one of {list(_OVERLAY_MOVE_KEYS)}")
    for k in ("x", "y", "opacity"):
        _num_in(to, k, 0, 1, twhere, problems)
    _num_in(to, "w", OVERLAY_W_MIN, OVERLAY_W_MAX, twhere, problems)


def _validate_effects(clip, where, problems) -> None:
    """The effect fields of a V clip (see the module docstring)."""
    if "filter" in clip and not (isinstance(clip["filter"], str) and clip["filter"] in FILTERS):
        problems.append(f"{where}: filter must be one of {list(FILTERS)}")
    _num_in(clip, "filter_strength", 0, 1, where, problems)
    if "filter_strength" in clip and "filter" not in clip:
        problems.append(f"{where}: filter_strength needs a filter")
    for k in UNIT_EFFECTS:
        _num_in(clip, k, 0, 1, where, problems)
    _num_in(clip, "blur", 0, BLUR_MAX, where, problems)
    for k in ("flip_h", "flip_v"):
        if k in clip and not isinstance(clip[k], bool):
            problems.append(f"{where}: {k} must be true or false")
    # 90.0 is accepted as 90: the TypeScript twin cannot tell them apart after JSON.parse, so the two
    # validators agree by both taking the whole number (normalise writes it as an int).
    if "rotate" in clip and not (_is_num(clip["rotate"]) and clip["rotate"] == int(clip["rotate"])
                                 and int(clip["rotate"]) in ROTATIONS):
        problems.append(f"{where}: rotate must be one of {list(ROTATIONS)}")


def _validate_timed_text(obj, where, problems) -> None:
    for k in ("start_s", "end_s"):
        _num_in(obj, k, 0, MAX_DURATION_S, where, problems)
    s, e = obj.get("start_s"), obj.get("end_s")
    if _is_num(s) and _is_num(e) and _ms(e) <= _ms(s):
        problems.append(f"{where}: end_s ({e}) must be greater than start_s ({s})")
    _text(obj, "text", where, problems)


def _validate_anims(obj, where, problems, *, text: bool) -> None:
    """``anim_in`` / ``anim_out`` and their durations (see the module docstring).
    Pure shape and range; the span check needs the item's times."""
    names = {"anim_in": ANIM_IN if text else ANIM_OUT, "anim_out": ANIM_OUT}
    for key, allowed in names.items():
        if key in obj and not (isinstance(obj[key], str) and obj[key] in allowed):
            problems.append(f"{where}: {key} must be one of {list(allowed)}")
        dur = key + "_s"
        _num_in(obj, dur, ANIM_MIN_S, ANIM_MAX_S, where, problems)
        if dur in obj and key not in obj:
            problems.append(f"{where}: {dur} needs {key}")
    s, e = obj.get("start_s"), obj.get("end_s")
    spans = [obj.get(k + "_s", ANIM_DEFAULT_S) for k in ("anim_in", "anim_out") if k in obj]
    if spans and all(_is_num(v) for v in spans) and _in_range(s) and _in_range(e) and e > s \
            and sum(spans) > _ms(e) - _ms(s) + 1e-9:
        problems.append(f"{where}: the animations ({sum(spans):g} s) are longer than the item is shown")


def _validate_text_clip(clip, where, problems, claim) -> None:
    if not _fields(clip, _T_CLIP_KEYS, _T_REQUIRED, where, problems):
        return
    claim(clip.get("id"), where)
    _validate_timed_text(clip, where, problems)
    _text_style(clip, where, problems)
    for k in ("x", "y"):
        _num_in(clip, k, 0, 1, where, problems)
    _num_in(clip, "shadow", 0, SHADOW_MAX, where, problems)
    if "box_color" in clip and not (isinstance(clip["box_color"], str)
                                    and _HEX_RE.fullmatch(clip["box_color"])):
        problems.append(f"{where}: box_color must be a #RRGGBB colour")
    _num_in(clip, "box_opacity", 0, 1, where, problems)
    if "box_opacity" in clip and "box_color" not in clip:
        problems.append(f"{where}: box_opacity needs a box_color")
    if "anchor" in clip and clip["anchor"] not in ANCHORS:
        problems.append(f"{where}: anchor must be one of {list(ANCHORS)}")
    for k in ("fade_in_s", "fade_out_s"):
        _num_in(clip, k, 0, MAX_DURATION_S, where, problems)
    _validate_anims(clip, where, problems, text=True)
    for anim, fade in (("anim_in", "fade_in_s"), ("anim_out", "fade_out_s")):
        if anim in clip and _is_num(clip.get(fade)) and clip[fade] > 0:
            problems.append(f"{where}: {anim} and {fade} both set — use one (a fade is an animation)")
    s, e = clip.get("start_s"), clip.get("end_s")
    fi, fo = clip.get("fade_in_s", 0), clip.get("fade_out_s", 0)
    if all(_is_num(v) for v in (s, e, fi, fo)) and e > s and fi + fo > (e - s) + 1e-9:
        problems.append(f"{where}: fade_in_s + fade_out_s is longer than the text is shown")
    # An animation on one side and a plain fade on the other: the fade becomes an animation too, so a
    # long entrance would be cut short by the exit that starts at end_s - fade_out_s.
    if ("anim_in" in clip) != ("anim_out" in clip):
        mixed = [clip.get(k + "_s", ANIM_DEFAULT_S) for k in ("anim_in", "anim_out") if k in clip]
        side = "fade_out_s" if "anim_in" in clip else "fade_in_s"
        other = clip.get(side, 0)
        if (all(_is_num(v) for v in (s, e, other, *mixed)) and e > s and other > 0
                and sum(mixed) + other > _ms(e) - _ms(s) + 1e-9):
            problems.append(f"{where}: the animation ({sum(mixed):g} s) and {side} ({other:g} s) "
                            f"are longer than the text is shown")


def _validate_overlays(overlays, fps, problems, claim) -> None:
    """``overlays`` (see the module docstring). Each is judged on its own: they
    may overlap, so there is nothing to compare between them."""
    if not isinstance(overlays, list):
        problems.append("overlays must be a list")
        return
    if len(overlays) > MAX_OVERLAYS:
        problems.append(f"overlays: at most {MAX_OVERLAYS}")
        return
    for i, ov in enumerate(overlays):
        where = f"overlays[{i}]"
        if not _fields(ov, _OVERLAY_KEYS, _OVERLAY_REQUIRED, where, problems):
            continue
        where = f"overlay {ov.get('id')!r}"
        claim(ov.get("id"), where)
        aid = ov.get("asset_id")
        if not (isinstance(aid, str) and _UUID_RE.fullmatch(aid)):
            problems.append(f"{where}: asset_id must be a uuid (got {_shown(aid)})")
        for k in ("start_s", "end_s"):
            _num_in(ov, k, 0, MAX_DURATION_S, where, problems)
        s, e = ov.get("start_s"), ov.get("end_s")
        if _in_range(s) and _in_range(e):   # arithmetic only on times the document may hold
            if _ms(e) <= _ms(s):
                problems.append(f"{where}: end_s ({_shown(e)}) must be greater than start_s ({_shown(s)})")
            elif fps and round(_ms(e) * fps) - round(_ms(s) * fps) < 1:
                problems.append(f"{where}: shorter than one frame at {fps} fps")
        for k in ("x", "y", "opacity"):
            _num_in(ov, k, 0, 1, where, problems)
        _num_in(ov, "w", OVERLAY_W_MIN, OVERLAY_W_MAX, where, problems)
        _validate_anims(ov, where, problems, text=False)
        if "move" in ov:
            _validate_overlay_move(ov["move"], where, problems)
    slow = sum(1 for ov in overlays if _partial_opacity_move(ov))
    if slow > MAX_PARTIAL_OPACITY_MOVES:
        problems.append(f"overlays: at most {MAX_PARTIAL_OPACITY_MOVES} may change opacity between two visible "
                        f"values during a move (got {slow}) — fade to or from 0, or keep the opacity")


def _partial_opacity_move(ov) -> bool:
    """True for an overlay whose ``move.to.opacity`` is a different visible value from its ``opacity``."""
    if not isinstance(ov, dict) or not isinstance(ov.get("move"), dict):
        return False
    to = ov["move"].get("to")
    start = ov.get("opacity", 1.0)
    end = to.get("opacity") if isinstance(to, dict) else None
    return _is_num(start) and _is_num(end) and start > 0 and end > 0 and start != end


def _validate_captions(captions, problems, claim) -> None:
    if not _fields(captions, _CAPTIONS_KEYS, ("cues",), "captions", problems):
        return
    style = captions.get("style")
    if style is not None and _fields(style, _CAPTION_STYLE_KEYS, (), "captions style", problems):
        _text_style(style, "captions style", problems)
        _num_in(style, "y", 0, 1, "captions style", problems)
        if "preset" in style and not caption_styles.is_style(style["preset"]):
            problems.append(f"captions style: preset must be one of {list(caption_styles.STYLE_IDS)}")
        if "highlight_color" in style and not (isinstance(style["highlight_color"], str)
                                               and _HEX_RE.fullmatch(style["highlight_color"])):
            problems.append("captions style: highlight_color must be a #RRGGBB colour")
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
        where = f"caption {_shown(cue.get('id'), 200)}"
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


def overlaps(doc: dict, limit: Optional[int] = None) -> List[Tuple[str, str, str, float, float]]:
    """``(track id, clip a, clip b, from_s, to_s)`` for every pair of items on
    the same track (or among the captions) that are on screen at once.
    Touching (one ends where the next starts) is not an overlap, and neither
    is a cross-fade's own overlap with the clip before it. With ``limit`` the
    search stops at that many pairs (the first ones, in the usual order)."""
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
                if limit is not None and len(found) >= limit:
                    return found
    return found


def _sorted_clips(track: dict) -> List[dict]:
    return sorted(track.get("clips") or [], key=lambda c: (_ms(c["start_s"]), str(c["id"])))


def crossfade_s(clip: dict) -> float:
    """A V clip's cross-fade from the clip before it, in seconds (0 = none)."""
    tr = clip.get("transition") or {}
    if tr.get("type") != "crossfade" or not _is_num(tr.get("duration_s")):
        return 0.0
    return _ms(tr["duration_s"])


def crossfade_style(clip: dict) -> str:
    """A V clip's cross-fade style (``fade`` when it has none, or it is not a
    cross-fade: a style on a cut is a problem :func:`validate` reports)."""
    tr = clip.get("transition") or {}
    st = tr.get("style")
    if tr.get("type") == "crossfade" and isinstance(st, str) and st in XFADE_STYLES:
        return st
    return XFADE_DEFAULT_STYLE


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


def speech_spans(doc: dict, sounding: Optional[Callable[[dict], bool]] = None
                 ) -> List[Tuple[float, float]]:
    """``(start, end)`` of every stretch of speech on the timeline, sorted: the
    clips of every A track whose role is ``speech``, and every V clip that
    plays its own sound (``audio: true``). ``sounding`` narrows the V clips to
    those whose source is known to carry sound (the render passes it; a
    silent file has nothing to duck under)."""
    out: List[Tuple[float, float]] = []
    for track in doc.get("tracks") or []:
        kind = track.get("kind")
        for clip in track.get("clips") or []:
            if kind == KIND_A and track.get("role") == "speech":
                out.append((_ms(clip["start_s"]), clip_end_s(clip)))
            elif kind == KIND_V and clip.get("audio") is True and (sounding is None or sounding(clip)):
                out.append((_ms(clip["start_s"]), clip_end_s(clip)))
    return sorted(out)


def merge_spans(spans: List[Tuple[float, float]], gap_s: float) -> List[Tuple[float, float]]:
    """Spans (sorted by start) joined when the silence between two is shorter
    than ``gap_s``. Used with attack + release: a pause too short for the
    music to come back up would only make it pump, so it stays down."""
    out: List[List[float]] = []
    for s, e in sorted(spans):
        if out and s - out[-1][1] < gap_s:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(a, b) for a, b in out]


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


def _large_frame_crossfade_problems(doc: dict, track: dict) -> List[str]:
    """Effects a cross-fade on a frame above 1440p cannot afford (see ``LARGE_FRAME_PX``)."""
    w, h = doc.get("width"), doc.get("height")
    if not (_is_int(w) and _is_int(h) and w * h > LARGE_FRAME_PX):
        return []
    problems, seen = [], set()
    for prev, clip, _d in crossfades(track):
        for c in (prev, clip):
            cid = str(c["id"])
            blur = c.get("blur")
            if cid not in seen and _is_num(blur) and blur > XFADE_LARGE_BLUR_MAX:
                seen.add(cid)
                problems.append(f"{_where(track, c)}: blur is not offered on a cross-faded clip in a frame above "
                                f"1440p ({w}x{h}) — the render would run out of memory; remove the blur, the "
                                f"cross-fade or lower the frame size")
            move = c.get("move")
            zooms = [p.get("zoom", 1.0) for p in (move.get("from"), move.get("to")) if isinstance(p, dict)] \
                if isinstance(move, dict) else []
            if cid + ":zoom" not in seen and any(_is_num(z) and z > XFADE_LARGE_ZOOM_MAX for z in zooms):
                seen.add(cid + ":zoom")
                problems.append(f"{_where(track, c)}: a zoom above {XFADE_LARGE_ZOOM_MAX:g} is not offered on a "
                                f"cross-faded clip in a frame above 1440p ({w}x{h}) — the render would run out "
                                f"of memory; lower the zoom, remove the cross-fade or lower the frame size")
    return problems


def _transition_problems(doc: dict) -> List[str]:
    problems = []
    for track in doc.get("tracks") or []:
        if track.get("kind") != KIND_V:
            continue
        problems.extend(_crossfade_problems(track))
        problems.extend(_large_frame_crossfade_problems(doc, track))
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
        if kind == KIND_A:
            if "role" in track:
                t["role"] = track["role"]
            if "duck" in track:
                d = {**DUCK_DEFAULTS, **track["duck"]}
                t["duck"] = {"amount_db": _ms(d["amount_db"]), "attack_s": _ms(d["attack_s"]),
                             "release_s": _ms(d["release_s"])}
        for clip in track["clips"]:
            if kind == KIND_T:
                c = {**copy.deepcopy(TEXT_DEFAULTS), **copy.deepcopy(clip)}
                for k in ("start_s", "end_s", "fade_in_s", "fade_out_s", "x", "y"):
                    c[k] = _ms(c[k])
                c["outline_width"] = float(c["outline_width"])
                # The looks are "off" by default: a text without them (or with
                # a zero shadow) is the text it was before they existed.
                if "shadow" in c:
                    c["shadow"] = _ms(c["shadow"])
                    if c["shadow"] == 0:
                        del c["shadow"]
                if "box_color" in c:
                    c["box_opacity"] = _ms(c.get("box_opacity", BOX_OPACITY_DEFAULT))
                _normalise_anims(c)
            else:
                defaults = V_DEFAULTS if kind == KIND_V else A_DEFAULTS
                c = {**copy.deepcopy(defaults), **copy.deepcopy(clip)}
                c["asset_id"] = c["asset_id"].lower()
                for k in ("start_s", "in_s", "out_s", "fade_in_s", "fade_out_s"):
                    c[k] = _ms(c[k])
                if kind == KIND_V:
                    tr_in = c["transition"]
                    c["transition"] = {"type": tr_in["type"], "duration_s": _ms(tr_in["duration_s"])}
                    if tr_in.get("style", XFADE_DEFAULT_STYLE) != XFADE_DEFAULT_STYLE:
                        c["transition"]["style"] = tr_in["style"]   # "fade" is no style: the cross-fade it was
                    c["speed"] = _ms(c["speed"])
                    if "grade" in c:
                        c["grade"] = {k: _ms(c["grade"][k]) for k in GRADE_RANGES}
                        if c["grade"] == GRADE_NEUTRAL:
                            del c["grade"]   # no change: the clip is the one it was without it
                    _normalise_effects(c)
                    if "move" in c:
                        c["move"] = {k: {**MOVE_POINT_DEFAULTS, **c["move"][k]} for k in ("from", "to")}
                        for k in ("from", "to"):
                            c["move"][k] = {n: _ms(v) for n, v in c["move"][k].items()}
                else:
                    c["gain_db"] = _ms(c["gain_db"])
            t["clips"].append(c)
        t["clips"].sort(key=lambda c: (c["start_s"], c["id"]))
        out["tracks"].append(t)
    if doc.get("captions") is not None:
        given = doc["captions"].get("style") or {}
        # A style named by preset supplies the fields the document leaves out
        # (its own font, size, colours, position); without one this is exactly
        # the style every older document gets.
        preset = (caption_styles.defaults_for(given["preset"], doc["width"], doc["height"])
                  if given.get("preset") else {})
        style = {**CAPTION_STYLE_DEFAULTS, **preset, **given}
        style["y"] = _ms(style["y"])
        style["outline_width"] = float(style["outline_width"])
        cues = sorted(({"id": c["id"], "start_s": _ms(c["start_s"]), "end_s": _ms(c["end_s"]),
                        "text": c["text"]} for c in doc["captions"]["cues"]),
                      key=lambda c: (c["start_s"], c["id"]))
        out["captions"] = {"style": style, "cues": cues}
    if doc.get("overlays"):
        # The list order is the layering: kept, not sorted. An empty list is
        # the document without the field, so it is dropped.
        out["overlays"] = []
        for ov in doc["overlays"]:
            o = {**OVERLAY_DEFAULTS, **copy.deepcopy(ov)}
            o["asset_id"] = o["asset_id"].lower()
            for k in ("start_s", "end_s", "x", "y", "w", "opacity"):
                o[k] = _ms(o[k])
            _normalise_anims(o)
            if "move" in o:
                o["move"] = {"to": {k: _ms(v) for k, v in o["move"]["to"].items()}}
            out["overlays"].append(o)
    return out


def _normalise_effects(c: dict) -> None:
    """Round the effect numbers and drop every one that means "off", so a clip
    that says "no effect" is the clip that never mentioned one."""
    for k in (*UNIT_EFFECTS, "blur", "filter_strength"):
        if k in c:
            c[k] = _ms(c[k])
    for k in (*UNIT_EFFECTS, "blur"):
        if c.get(k) == 0:
            del c[k]
    if "filter" in c:
        if c.get("filter_strength", 1.0) == 0:
            del c["filter"]
            c.pop("filter_strength", None)
        elif c.get("filter_strength") == 1.0:
            del c["filter_strength"]
    for k in ("flip_h", "flip_v"):
        if c.get(k) is False:
            del c[k]
    if "rotate" in c:
        c["rotate"] = int(c["rotate"])
    if c.get("rotate") == 0:
        del c["rotate"]


def _normalise_anims(item: dict) -> None:
    """Fill the duration of each animation that is named (the item is valid:
    a duration without its name was refused)."""
    for key in ("anim_in", "anim_out"):
        if key in item:
            item[key + "_s"] = _ms(item.get(key + "_s", ANIM_DEFAULT_S))


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
            if "move" in clip:
                # The move goes on across the cut: the first half ends where the second
                # begins, at the window the whole move had reached.
                frac = (at - start) / (end - start)
                a = {**MOVE_POINT_DEFAULTS, **clip["move"]["from"]}
                b = {**MOVE_POINT_DEFAULTS, **clip["move"]["to"]}
                mid = {k: _ms(a[k] + (b[k] - a[k]) * frac) for k in MOVE_POINT_DEFAULTS}
                clip["move"] = {"from": clip["move"]["from"], "to": mid}
                second["move"] = {"from": dict(mid), "to": second["move"]["to"]}
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
    ids = {str(c["asset_id"]).lower() for t in doc.get("tracks") or []
           for c in t.get("clips") or [] if "asset_id" in c}
    ids.update(str(o["asset_id"]).lower() for o in doc.get("overlays") or [] if "asset_id" in o)
    return sorted(ids)


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
    videos = 0
    for ov in doc.get("overlays") or []:
        asset = found.get(str(ov["asset_id"]).lower())
        if asset is None:
            continue
        where = f"overlay {ov['id']!r}"
        if asset.kind not in OVERLAY_ASSET_KINDS:
            problems.append(f"{where}: asset {asset.asset_id} is {asset.kind!r}; an overlay "
                            f"takes {' or '.join(OVERLAY_ASSET_KINDS)}")
            continue
        if not _local_path(asset.path):
            problems.append(f"{where}: asset {asset.asset_id} has no local file to render from")
            continue
        if asset.kind == ASSET_VIDEO:
            videos += 1
            dur = asset.duration_s
            if dur is not None and _ms(ov["end_s"]) - _ms(ov["start_s"]) > _ms(dur) + 0.001:
                problems.append(f"{where}: runs {_ms(_ms(ov['end_s']) - _ms(ov['start_s']))} s but "
                                f"video {asset.asset_id} is only {dur} s long")
    if videos > MAX_OVERLAY_VIDEOS:
        problems.append(f"timeline: at most {MAX_OVERLAY_VIDEOS} video overlays (got {videos})")
    if problems:
        raise TimelineError(problems)
    return found
