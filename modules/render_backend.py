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

It is a real, runnable renderer for the concat model (stock/AI b-roll + still
images + colour fills + one narration track + a subtitle file). Stills get the
compositor's Ken Burns motion (`ken_burns_filter`: the same four moves, zoom
and pan amounts and overscan, as ffmpeg `zoompan`/`crop` expressions), and the
subtitle file may be the word-highlighted `.ass` from `modules/ass_captions.py`
— so the look matches MoviePy's. It stays an opt-in alternative
(`config.RENDER_BACKEND`); the MoviePy compositor is still the default.
"""

from __future__ import annotations

import hashlib
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


# ── Ken Burns on stills ─────────────────────────────────────────────────────
#
# The MoviePy compositor animates every still (Compositor._ken_burns_clip):
# cover-scale the image to COVER_OVERSCAN × the frame, then per frame crop a
# window and resize it to the frame. These mirror its constants — a test pins
# them to the compositor's, so the two renderers cannot drift apart silently.
KEN_BURNS_ZOOM = 0.12    # fraction zoomed over a clip's life (zoom_in / zoom_out)
KEN_BURNS_PAN = 0.30     # fraction of the scaled width traversed on a pan
KEN_BURNS_PAN_ZOOM = 1.06
COVER_OVERSCAN = 1.15
KEN_BURNS_STYLES = ("zoom_in", "zoom_out", "pan_left", "pan_right")


def ken_burns_style(seed: str) -> str:
    """The move for one still. MoviePy picks at random; here it is a stable
    hash of the segment, so the same inputs always render the same video (and
    a cached scene stays valid)."""
    digest = hashlib.sha1(str(seed).encode("utf-8")).digest()
    return KEN_BURNS_STYLES[digest[0] % len(KEN_BURNS_STYLES)]


def ken_burns_filter(style: str, width: int, height: int, fps: int, frames: float) -> str:
    """The -vf chain that animates one still image like the compositor does.

    ``frames`` is the clip's length in frames (duration × fps, may be
    fractional) — MoviePy's ``progress = t / duration`` is ``n / frames`` for
    output frame ``n``, clamped to 1. The chain never decides how many frames
    come out: the caller's ``-t`` / ``-frames:v`` does, exactly as for the old
    static hold, so segment lengths (the audio master clock) are unchanged.

    The image is decoded and scaled ONCE, then repeated by ``loop`` (a looped
    ``-loop 1`` input would decode and rescale the file every frame):

    * zoom_in / zoom_out — centre-crop the overscanned image to exactly
      overscan × frame, then ``zoompan`` a window of frame / zoom (MoviePy's
      ``int(W / zoom)``) about the centre, zoom 1 → 1.12 or 1.12 → 1.
    * pan_left / pan_right — a fixed frame/1.06 window whose centre moves
      across 30 % of the scaled width, its position clamped inside the image
      (the compositor's clamp), then scaled to the frame.
    """
    w, h, fps = int(width), int(height), int(fps)
    ow, oh = int(round(w * COVER_OVERSCAN)), int(round(h * COVER_OVERSCAN))
    span = max(float(frames), 1.0)
    base = (f"scale={ow}:{oh}:force_original_aspect_ratio=increase:flags=lanczos")
    # settb first: the still arrives in the image demuxer's 1/25 s timebase,
    # where N/fps timestamps round and a pan would gain or lose a frame at -t.
    loop = f"loop=loop=-1:size=1,settb=1/{fps},setpts=N"
    if style in ("zoom_in", "zoom_out"):
        p = f"min(1,on/{span:.6f})"
        zoom = (f"(1+{KEN_BURNS_ZOOM}*{p})" if style == "zoom_in"
                else f"(1+{KEN_BURNS_ZOOM}-{KEN_BURNS_ZOOM}*{p})")
        return (f"{base},crop={ow}:{oh},{loop},"
                f"zoompan=z='{COVER_OVERSCAN}*{zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2'"
                f":d=1:s={w}x{h}:fps={fps}")
    p = f"min(1,n/{span:.6f})"
    half = KEN_BURNS_PAN / 2
    centre = (f"(0.5+{half}-{KEN_BURNS_PAN}*{p})" if style == "pan_left"
              else f"(0.5-{half}+{KEN_BURNS_PAN}*{p})")
    fw, fh = int(w / KEN_BURNS_PAN_ZOOM), int(h / KEN_BURNS_PAN_ZOOM)
    return (f"{base},{loop},"
            f"crop=w={fw}:h={fh}:x='clip(trunc(iw*{centre})-{fw // 2},0,iw-ow)':y='(ih-oh)/2',"
            f"scale={w}:{h}:flags=lanczos")


def _static_image_cmd(ffmpeg: str, path: str, dur: str, width: int, height: int,
                      fps: int, common: List[str], out_path: Path) -> List[str]:
    return [ffmpeg, "-y", "-loop", "1", "-i", path, "-t", dur,
            "-vf", _scale_pad(width, height, fps), *common, str(out_path)]


def _normalize_segment(
    ffmpeg: str, seg: Segment, out_path: Path, width: int, height: int, fps: int,
    *, seed: Optional[str] = None,
) -> None:
    """Render one timeline segment to a uniform silent H.264 clip of its
    duration. A colour placeholder is generated; an image gets the Ken Burns
    move ``ken_burns_style(seed)`` (held static if that ffmpeg run fails); a
    video is trimmed and fitted. Audio is dropped here — the spec muxes one
    narration track over the whole concatenation."""
    dur = f"{max(0.001, seg.duration):.3f}"
    common = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps)]

    if seg.kind == KIND_COLOR or not seg.path:
        cmd = [ffmpeg, "-y", "-f", "lavfi", "-i",
               f"color=c=black:s={width}x{height}:r={fps}:d={dur}", *common, str(out_path)]
    elif seg.kind == KIND_IMAGE:
        style = ken_burns_style(seed if seed is not None else seg.path)
        # Same "-t dur" as the static hold: the frame count is the one the
        # old path produced, only the pixels move.
        vf = ken_burns_filter(style, width, height, fps, float(dur) * fps)
        try:
            _run([ffmpeg, "-y", "-i", seg.path, "-t", dur, "-vf", vf, *common, str(out_path)])
            return
        except RenderBackendError as e:
            logger.warning("Ken Burns (%s) failed for %s — holding the still instead: %s",
                           style, Path(seg.path).name, e)
        cmd = _static_image_cmd(ffmpeg, seg.path, dur, width, height, fps, common, out_path)
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
            _normalize_segment(ffmpeg, seg, out, spec.width, spec.height, spec.fps,
                               seed=f"{i}:{seg.path}")
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
