"""ffmpeg render backend — executes a RenderSpec (roadmap #49).

Phase 1 found MoviePy holds every source decoder open for the whole render
(~1 GB, orphaned ffmpeg children on a twelve-clip 1080p job). The durable fix,
which `modules/render_spec.py` describes declaratively, is to stop composing in
Python and let ffmpeg stream the timeline segment by segment. That module ships
the spec, its validation, and the command builder — all pure. This is the part
that was deferred: the backend that actually runs it.

`render()` normalises each segment to one uniform codec/size/fps clip (so the
concat demuxer accepts them), concatenates them, muxes the audio, optionally
burns subtitles, and encodes H.264/AAC — holding **one** ffmpeg process at a
time, never twelve decoders. ffmpeg is resolved from the imageio-ffmpeg binary
MoviePy already depends on, so no system install is required.

It is a real, runnable renderer for the concat model (stock/AI b-roll + Ken
Burns-free images + colour fills + one narration track + a subtitle file). It
does NOT reproduce MoviePy's per-frame Ken Burns motion or word-level
highlighted captions, so it is offered as an opt-in alternative
(`config.RENDER_BACKEND`), not a silent replacement — the MoviePy compositor
stays the default until a spec model that carries those effects exists.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import List, Optional

from modules.render_spec import (
    KIND_COLOR,
    KIND_IMAGE,
    KIND_VIDEO,
    RenderSpec,
    Segment,
    build_ffmpeg_command,
    concat_list_lines,
    validate,
)

logger = logging.getLogger(__name__)


class RenderBackendError(RuntimeError):
    """A render failed — ffmpeg missing, a bad segment, or a non-zero exit."""


def resolve_ffmpeg() -> str:
    """Path to an ffmpeg binary. Prefers the imageio-ffmpeg binary MoviePy
    already installs; falls back to `ffmpeg` on PATH."""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # pragma: no cover - only when imageio-ffmpeg is absent
        return "ffmpeg"


def _run(cmd: List[str]) -> None:
    """Run one ffmpeg command, raising RenderBackendError with its stderr tail
    on failure. Never leaks a process — subprocess.run waits and reaps."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-8:]
        raise RenderBackendError(
            f"ffmpeg exited {proc.returncode}: {' / '.join(tail) or 'no stderr'}"
        )


def _scale_pad(width: int, height: int, fps: int) -> str:
    """A filter that fits any source into width×height without distortion
    (letter/pillar-boxed) at the target fps — the normalisation the concat
    demuxer needs so segments share codec, size and rate."""
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps}"
    )


def _normalize_segment(
    ffmpeg: str, seg: Segment, out_path: Path, width: int, height: int, fps: int
) -> None:
    """Render one timeline segment to a uniform silent H.264 clip of its
    duration. A colour placeholder is generated; an image is held for the
    duration; a video is trimmed and fitted. Audio is dropped here — the spec
    muxes one narration track over the whole concatenation."""
    dur = f"{max(0.001, seg.duration):.3f}"
    common = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps)]

    if seg.kind == KIND_COLOR or not seg.path:
        cmd = [ffmpeg, "-y", "-f", "lavfi", "-i",
               f"color=c=black:s={width}x{height}:r={fps}:d={dur}", *common, str(out_path)]
    elif seg.kind == KIND_IMAGE:
        cmd = [ffmpeg, "-y", "-loop", "1", "-i", seg.path, "-t", dur,
               "-vf", _scale_pad(width, height, fps), *common, str(out_path)]
    else:  # KIND_VIDEO
        # -stream_loop -1: a source shorter than its slot is looped (as the
        # MoviePy compositor does with vc.loop) instead of yielding a short
        # clip that would drift every later cut off the audio timeline.
        cmd = [ffmpeg, "-y", "-stream_loop", "-1", "-i", seg.path, "-t", dur, "-an",
               "-vf", _scale_pad(width, height, fps), *common, str(out_path)]
    _run(cmd)


def render(spec: RenderSpec, *, ffmpeg: Optional[str] = None, workdir: Optional[str] = None) -> str:
    """Render `spec` to `spec.output_path` via ffmpeg and return that path.

    Normalises every segment, concatenates them, muxes `audio_path`, and burns
    `subtitle_path` when set. Raises RenderBackendError on an invalid spec or an
    ffmpeg failure — never a silent empty file.
    """
    problems = validate(spec)
    if problems:
        raise RenderBackendError("invalid render spec: " + "; ".join(problems))

    ffmpeg = ffmpeg or resolve_ffmpeg()
    Path(spec.output_path).parent.mkdir(parents=True, exist_ok=True)

    tmp_ctx = tempfile.TemporaryDirectory(dir=workdir) if workdir else tempfile.TemporaryDirectory()
    with tmp_ctx as tmp:
        tmpdir = Path(tmp)
        normalized: List[Segment] = []
        for i, seg in enumerate(spec.segments):
            out = tmpdir / f"seg_{i:04d}.mp4"
            _normalize_segment(ffmpeg, seg, out, spec.width, spec.height, spec.fps)
            normalized.append(Segment(duration=seg.duration, path=str(out), kind=KIND_VIDEO))

        norm_spec = replace(spec, segments=normalized)
        concat_path = tmpdir / "concat.txt"
        concat_path.write_text("\n".join(concat_list_lines(norm_spec)) + "\n", encoding="utf-8")

        cmd = build_ffmpeg_command(norm_spec, str(concat_path))
        cmd[0] = ffmpeg  # the builder emits a literal "ffmpeg"; use the resolved binary
        _run(cmd)

    logger.info("ffmpeg backend rendered %s (%d segments, %.1fs)",
                spec.output_path, len(spec.segments), spec.total_duration)
    return spec.output_path


def simple_spec(
    output_path: str,
    segments: List[tuple],
    *,
    audio_path: Optional[str] = None,
    subtitle_path: Optional[str] = None,
    width: int = 1920,
    height: int = 1080,
    fps: int = 30,
) -> RenderSpec:
    """Build a RenderSpec from `(path_or_None, duration[, kind])` tuples — the
    convenience the concat case wants. A None path becomes a colour placeholder.
    """
    segs: List[Segment] = []
    for item in segments:
        path = item[0]
        duration = float(item[1])
        kind = item[2] if len(item) > 2 else (KIND_VIDEO if path else KIND_COLOR)
        segs.append(Segment(duration=duration, path=path, kind=kind))
    return RenderSpec(
        output_path=output_path, width=width, height=height, fps=fps,
        segments=segs, audio_path=audio_path, subtitle_path=subtitle_path,
    )
