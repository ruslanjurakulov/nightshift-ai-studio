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
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

#: The ONE quality encode of a render (the final pass). These are libx264's own
#: defaults — what this backend always encoded with implicitly — spelled out so
#: that the quality of the output is a decision in the code, not an accident of
#: the encoder's build. Segment normalisation writes a fast intermediate
#: instead (render_backend.INTERMEDIATE_X264), so this is not paid twice.
FINAL_X264: tuple = ("-preset", "medium", "-crf", "23")

#: The largest frame, in pixels, ffmpeg may decode for a timeline (an editor
#: export reads library media members uploaded). The same number as
#: media_library.MAX_PIXELS (a test pins them equal): the upload probe only
#: sees a video's first frames, and a stream can switch to a bigger frame at a
#: later keyframe (BR-L-004), so the decoder itself refuses it.
DECODE_MAX_PIXELS = 100_000_000


def cap_inputs(cmd: List[str], *, fail_on_error: bool = False) -> List[str]:
    """``cmd`` with ``-max_pixels DECODE_MAX_PIXELS`` before every ``-i``
    (input options apply to the next input only) and, with
    ``fail_on_error``, ``-xerror`` so a refused frame fails the run instead of
    being skipped. Only timeline commands are capped: the pipeline's own
    renders keep their byte-pinned argv (tests/test_render_spec_legacy.py)."""
    cap = ["-max_pixels", str(int(DECODE_MAX_PIXELS))]
    out: List[str] = [cmd[0], "-xerror"] if fail_on_error else [cmd[0]]
    for tok in cmd[1:]:
        if tok == "-i":
            out += cap
        out.append(tok)
    return out

KIND_VIDEO = "video"
KIND_IMAGE = "image"
KIND_COLOR = "color"   # a solid-colour placeholder segment (no source file)
_KINDS = (KIND_VIDEO, KIND_IMAGE, KIND_COLOR)

FIT_CONTAIN = "contain"   # letter/pillar-box inside the frame (the original behaviour)
FIT_COVER = "cover"       # fill the frame, cropping the overflow
FITS = (FIT_CONTAIN, FIT_COVER)

#: Text overlay anchors: which point of the text box sits at (x, y). The ASS
#: \an numpad code for each is in ass_captions.ANCHOR_AN.
ANCHORS = ("top-left", "top", "top-right", "left", "center", "right",
           "bottom-left", "bottom", "bottom-right")

#: Playback speed bounds. ffmpeg's atempo takes 0.5-100 per stage, but below
#: 0.5 it needs chained stages and above 2 speech stops being followable;
#: modules/timeline.py offers exactly this range.
SPEED_MIN, SPEED_MAX = 0.5, 2.0


def _speed_ok(v) -> bool:
    return _finite(v) and SPEED_MIN <= v <= SPEED_MAX


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _put_if(d: dict, key: str, value, default) -> None:
    # New fields are serialised only when set, so a pre-timeline spec's dict
    # is exactly what it always was (it is compared and cached elsewhere).
    if value != default:
        d[key] = value


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
        if self.xfade is not None:
            d["xfade"] = self.xfade.to_dict()
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
            xfade=Segment.from_dict(x) if isinstance(x, dict) else None,
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

    @property
    def output_s(self) -> float:
        """How long the track sounds in the output."""
        return self.duration_s / self.speed if self.speed else self.duration_s

    def to_dict(self) -> dict:
        d = {"path": self.path, "duration_s": self.duration_s, "start_s": self.start_s,
             "in_s": self.in_s, "gain_db": self.gain_db, "fade_in_s": self.fade_in_s,
             "fade_out_s": self.fade_out_s}
        _put_if(d, "speed", self.speed, 1.0)
        _put_if(d, "crossfade_s", self.crossfade_s, 0.0)
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

    def to_dict(self) -> dict:
        return {"start_s": self.start_s, "end_s": self.end_s, "text": self.text,
                "font": self.font, "size": self.size, "color": self.color,
                "outline_color": self.outline_color, "outline_width": self.outline_width,
                "bold": self.bold, "x": self.x, "y": self.y, "anchor": self.anchor,
                "fade_in_s": self.fade_in_s, "fade_out_s": self.fade_out_s}

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
        )

    @property
    def uses_timeline_features(self) -> bool:
        """True when the final pass needs the filter-graph command (several
        audio tracks and/or text overlays) rather than the original one."""
        return bool(self.audio_tracks or self.overlays)


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
    if not _speed_ok(seg.speed):
        problems.append(f"{name} speed must be from {SPEED_MIN:g} to {SPEED_MAX:g} "
                        f"(got {seg.speed})")
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
    cmd += ["-r", str(spec.fps), "-c:v", "libx264", *FINAL_X264, "-pix_fmt", "yuv420p"]
    if spec.audio_path:
        cmd += ["-c:a", "aac", "-shortest"]
    cmd.append(spec.output_path)
    # A timeline with no audio track or overlay takes this path too: its
    # inputs are the render's own intermediates, capped all the same.
    return cap_inputs(cmd) if spec.frame_exact else cmd


def _quote_filter_path(path: str) -> str:
    return "'" + str(path).replace("'", r"'\''") + "'"


def _t(x: float) -> str:
    # One fixed format for every time in a filter graph: the same spec must
    # always produce the same argv (tests pin it), whatever float noise.
    return f"{float(x):.3f}"


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
    if track.speed != 1.0:
        chain.append(f"atempo={_t(track.speed)}")
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

    graph: List[str] = []
    burn: List[str] = []
    if spec.subtitle_path:
        burn.append("subtitles=" + _quote_filter_path(spec.subtitle_path))
    if spec.overlays:
        burn.append("subtitles=" + _quote_filter_path(overlay_path))
    video_out = "0:v"
    if burn:
        graph.append("[0:v]" + ",".join(burn) + "[vout]")
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
    cmd += ["-r", str(spec.fps), "-c:v", "libx264", *FINAL_X264, "-pix_fmt", "yuv420p"]
    if labels:
        cmd += ["-c:a", "aac"]
    cmd.append(spec.output_path)
    # Audio tracks are read as [n:a] only, so no picture of theirs is decoded;
    # the cap is there anyway, on every input. No -xerror: a damaged audio
    # frame is skipped, as it always was.
    return cap_inputs(cmd)

