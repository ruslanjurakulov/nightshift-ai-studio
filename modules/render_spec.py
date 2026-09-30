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
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional

#: The ONE quality encode of a render (the final pass). These are libx264's own
#: defaults — what this backend always encoded with implicitly — spelled out so
#: that the quality of the output is a decision in the code, not an accident of
#: the encoder's build. Segment normalisation writes a fast intermediate
#: instead (render_backend.INTERMEDIATE_X264), so this is not paid twice.
FINAL_X264: tuple = ("-preset", "medium", "-crf", "23")

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
    letterbox (contain) or crop (cover) for a video, and ``fade_in_s`` /
    ``fade_out_s`` fade the picture from / to black inside the segment."""
    duration: float
    path: Optional[str] = None
    kind: str = KIND_VIDEO
    in_s: float = 0.0
    fit: str = FIT_CONTAIN
    fade_in_s: float = 0.0
    fade_out_s: float = 0.0

    def to_dict(self) -> dict:
        d = {"duration": self.duration, "path": self.path, "kind": self.kind}
        _put_if(d, "in_s", self.in_s, 0.0)
        _put_if(d, "fit", self.fit, FIT_CONTAIN)
        _put_if(d, "fade_in_s", self.fade_in_s, 0.0)
        _put_if(d, "fade_out_s", self.fade_out_s, 0.0)
        return d

    @staticmethod
    def from_dict(d: dict) -> "Segment":
        return Segment(
            duration=float(d.get("duration") or 0.0),
            path=(d.get("path") or None),
            kind=str(d.get("kind") or KIND_VIDEO),
            in_s=float(d.get("in_s") or 0.0),
            fit=str(d.get("fit") or FIT_CONTAIN),
            fade_in_s=float(d.get("fade_in_s") or 0.0),
            fade_out_s=float(d.get("fade_out_s") or 0.0),
        )


@dataclass(frozen=True)
class AudioTrack:
    """One audio file placed on the output timeline: ``duration_s`` seconds of
    the source from ``in_s``, starting at ``start_s`` of the video, at
    ``gain_db``, with linear fades inside that span."""
    path: str
    duration_s: float
    start_s: float = 0.0
    in_s: float = 0.0
    gain_db: float = 0.0
    fade_in_s: float = 0.0
    fade_out_s: float = 0.0

    def to_dict(self) -> dict:
        return {"path": self.path, "duration_s": self.duration_s, "start_s": self.start_s,
                "in_s": self.in_s, "gain_db": self.gain_db, "fade_in_s": self.fade_in_s,
                "fade_out_s": self.fade_out_s}

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
        if seg.duration <= 0:
            problems.append(f"segment {i} has non-positive duration {seg.duration}")
        if seg.kind not in _KINDS:
            problems.append(f"segment {i} has unknown kind {seg.kind!r}")
        if seg.kind in (KIND_VIDEO, KIND_IMAGE) and not seg.path:
            problems.append(f"segment {i} is a {seg.kind} but has no path")
        if not _finite(seg.in_s) or seg.in_s < 0:
            problems.append(f"segment {i} has a negative or non-finite in_s {seg.in_s}")
        if seg.fit not in FITS:
            problems.append(f"segment {i} has unknown fit {seg.fit!r}")
        for name in ("fade_in_s", "fade_out_s"):
            v = getattr(seg, name)
            if not _finite(v) or v < 0:
                problems.append(f"segment {i} has a negative or non-finite {name} {v}")
        if (_finite(seg.fade_in_s) and _finite(seg.fade_out_s)
                and seg.fade_in_s + seg.fade_out_s > seg.duration + 1e-9):
            problems.append(f"segment {i} fades ({seg.fade_in_s} + {seg.fade_out_s} s) "
                            f"are longer than the segment ({seg.duration} s)")
    if spec.audio_path and spec.audio_tracks:
        problems.append("audio_path and audio_tracks are mutually exclusive — "
                        "put the narration in audio_tracks")
    for i, t in enumerate(spec.audio_tracks):
        if not t.path:
            problems.append(f"audio track {i} has no path")
        nums = ("duration_s", "start_s", "in_s", "gain_db", "fade_in_s", "fade_out_s")
        if not all(_finite(getattr(t, n)) for n in nums):
            problems.append(f"audio track {i} has a non-finite number")
            continue
        if t.duration_s <= 0:
            problems.append(f"audio track {i} has non-positive duration {t.duration_s}")
        if t.start_s < 0 or t.in_s < 0 or t.fade_in_s < 0 or t.fade_out_s < 0:
            problems.append(f"audio track {i} has a negative start, in point or fade")
        if t.fade_in_s + t.fade_out_s > t.duration_s + 1e-9:
            problems.append(f"audio track {i} fades are longer than the track")
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
    return cmd


def _quote_filter_path(path: str) -> str:
    return "'" + str(path).replace("'", r"'\''") + "'"


def _t(x: float) -> str:
    # One fixed format for every time in a filter graph: the same spec must
    # always produce the same argv (tests pin it), whatever float noise.
    return f"{float(x):.3f}"


def audio_track_filter(track: AudioTrack, input_index: int, label: str) -> str:
    """The filter chain placing one audio track: cut ``duration_s`` from
    ``in_s``, one sample format for every input (so amix never guesses),
    gain, fades inside the span, then delay to ``start_s``."""
    chain = [
        f"atrim=start={_t(track.in_s)}:duration={_t(track.duration_s)}",
        "asetpts=PTS-STARTPTS",
        "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    ]
    if track.gain_db:
        chain.append(f"volume={_t(track.gain_db)}dB")
    if track.fade_in_s > 0:
        chain.append(f"afade=t=in:st=0:d={_t(track.fade_in_s)}")
    if track.fade_out_s > 0:
        chain.append(f"afade=t=out:st={_t(track.duration_s - track.fade_out_s)}"
                     f":d={_t(track.fade_out_s)}")
    delay_ms = int(round(track.start_s * 1000))
    if delay_ms > 0:
        chain.append(f"adelay=delays={delay_ms}:all=1")
    return f"[{input_index}:a]" + ",".join(chain) + f"[{label}]"


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
    for i, track in enumerate(spec.audio_tracks):
        label = f"a{i}"
        graph.append(audio_track_filter(track, i + 1, label))
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
    return cmd

