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
"""

from __future__ import annotations

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


@dataclass(frozen=True)
class Segment:
    """One timeline segment. `path` is a pre-normalised clip/image file, or None
    for a solid-colour placeholder. `duration` is the seconds it occupies."""
    duration: float
    path: Optional[str] = None
    kind: str = KIND_VIDEO

    def to_dict(self) -> dict:
        return {"duration": self.duration, "path": self.path, "kind": self.kind}

    @staticmethod
    def from_dict(d: dict) -> "Segment":
        return Segment(
            duration=float(d.get("duration") or 0.0),
            path=(d.get("path") or None),
            kind=str(d.get("kind") or KIND_VIDEO),
        )


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

    @property
    def total_duration(self) -> float:
        return round(sum(max(0.0, s.duration) for s in self.segments), 3)

    def to_dict(self) -> dict:
        return {
            "output_path": self.output_path,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "segments": [s.to_dict() for s in self.segments],
            "audio_path": self.audio_path,
            "subtitle_path": self.subtitle_path,
        }

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
        )


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


def build_ffmpeg_command(spec: RenderSpec, concat_list_path: str) -> List[str]:
    """The ffmpeg argument list for the standard concat-demuxer + audio-mux
    render of `spec`, reading its segment list from `concat_list_path`.

    Returns args only — it executes nothing. The pattern is the textbook one:
    concat the (pre-normalised) segments into the video track, optionally mux one
    audio file, optionally burn subtitles, and encode H.264/AAC at the spec's
    fps. Segment normalisation and actually running this belong to the backend.
    """
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
