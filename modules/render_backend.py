"""ffmpeg render backend — executes a RenderSpec (roadmap #49).

Phase 1 found MoviePy holds every source decoder open for the whole render
(~1 GB, orphaned ffmpeg children on a twelve-clip 1080p job). The durable fix,
which `modules/render_spec.py` describes declaratively, is to stop composing in
Python and let ffmpeg stream the timeline segment by segment. That module ships
the spec, its validation, and the command builder — all pure. This is the part
that was deferred: the backend that actually runs it.

`render()` normalises each segment to one uniform codec/size/fps clip (so the
concat demuxer accepts them), concatenates them, muxes the audio, optionally
burns subtitles, and encodes H.264/AAC. Each ffmpeg process holds one source
decoder, never twelve; a bounded pool (``render_jobs``: CPU count, capped by
MemAvailable, ``NIGHTSHIFT_RENDER_JOBS``) runs a few segment processes at
once, each a fast near-lossless intermediate, and the one quality encode is
the final pass. ffmpeg is resolved from the imageio-ffmpeg binary MoviePy
already depends on, so no system install is required.

It is a real, runnable renderer for the concat model (stock/AI b-roll + still
images + colour fills + one narration track + a subtitle file). Stills get the
compositor's Ken Burns motion (`ken_burns_filter`: the same four moves, zoom
and pan amounts and overscan, as ffmpeg `zoompan`/`crop` expressions), and the
subtitle file may be the word-highlighted `.ass` from `modules/ass_captions.py`
— so the look matches MoviePy's. It stays an opt-in alternative
(`config.RENDER_BACKEND`); the MoviePy compositor is still the default.
"""

from __future__ import annotations

import concurrent.futures
import functools
import hashlib
import logging
import math
import os
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, List, Optional, Sequence

from modules import ass_captions, ffmpeg_limits, shape_art, speed_ramp
from modules.render_spec import (
    FIT_BLUR,
    FIT_COVER,
    KIND_COLOR,
    KIND_IMAGE,
    KIND_VIDEO,
    RenderSpec,
    XFADE_STYLES,
    Segment,
    build_ffmpeg_command,
    cap_inputs,
    concat_list_lines,
    _quote_filter_path,
    interp_fps,
    segment_frames,
    validate,
)

logger = logging.getLogger(__name__)

#: The timeline text overlays' ASS file, written in the render's temp dir.
OVERLAY_FILENAME = "overlays.ass"


class RenderBackendError(RuntimeError):
    """A render failed — ffmpeg missing, a bad segment, or a non-zero exit."""


class RenderTimeout(RenderBackendError):
    """The render ran past its wall-clock limit; the ffmpeg running was killed.
    Never retried or fallen back from: the next attempt would hang the same way."""


class RenderRefused(RenderBackendError):
    """ffmpeg refused a frame of a member's media: over the decoder's size cap
    (a stream that switches to a bigger frame, BR-L-004), or no memory for it
    under the child's limit (a big coded frame behind a small crop window,
    BR-L-007). Never retried: the same file is refused the same way."""


def resolve_ffmpeg() -> str:
    """Path to an ffmpeg binary. Prefers the imageio-ffmpeg binary MoviePy
    already installs; falls back to `ffmpeg` on PATH."""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # pragma: no cover - only when imageio-ffmpeg is absent
        return "ffmpeg"


def _run(cmd: List[str], deadline: Optional[float] = None) -> None:
    """Run one ffmpeg command, raising RenderBackendError with its stderr tail
    on failure. Never leaks a process — subprocess.run waits and reaps.

    ``deadline`` (a ``time.monotonic()`` instant) bounds it: a render that
    hangs — a source that decodes forever, a filter that never ends — used to
    keep its export's heartbeat alive indefinitely. Past the deadline the
    process is killed, reaped, and RenderTimeout is raised.

    Only an editor export passes a deadline, and its commands decode library
    media members uploaded, so they run under ffmpeg_limits: an address-space
    limit and two threads (BR-L-007), and a frame the decoder refuses, for
    its size or for want of memory, fails the command with RenderRefused
    instead of being skipped (no ``-xerror``, which also failed damaged but
    playable clips, BR-L-008). The pipeline's renders (no deadline) make
    exactly the call they always made."""
    if deadline is None:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        returncode, stderr = proc.returncode, proc.stderr
    else:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RenderTimeout("the render ran past its time limit")
        out = ffmpeg_limits.run(cmd, timeout_s=remaining)
        if out.timed_out:
            raise RenderTimeout("the render ran past its time limit")
        if out.refused:
            tail = out.tail.strip().splitlines()[-4:]
            raise RenderRefused("ffmpeg refused a frame (over the size cap, or out of memory "
                                f"under the limit): {' / '.join(tail)}")
        returncode, stderr = out.returncode, out.tail
    if returncode != 0:
        tail = (stderr or "").strip().splitlines()[-8:]
        raise RenderBackendError(
            f"ffmpeg exited {returncode}: {' / '.join(tail) or 'no stderr'}"
        )


def grade_filter(seg: Segment) -> str:
    """The ffmpeg ``eq`` filter for a segment's colour grade, followed by its
    colour and texture effects ('' when it has neither — then NO filter is
    added and the command is the one it always was). ``format=yuv420p`` first:
    eq works on the Y/U/V planes (brightness and contrast on the luma,
    saturation on the chroma); a still read as RGB would otherwise reach it as
    GBR planes and be graded per channel. The numbers come from validated
    floats and are formatted here, never pasted from a document."""
    parts: List[str] = []
    if seg.graded:
        parts.append(f"format=yuv420p,eq=brightness={seg.brightness:.3f}"
                     f":contrast={seg.contrast:.3f}:saturation={seg.saturation:.3f}")
    if seg.effects is not None and seg.effects.active:
        parts.extend(effect_filters(seg.effects))
    return ",".join(parts)


# ── clip effects ────────────────────────────────────────────────────────────
#
# A named colour look is a set of control points per channel (``curves``), moved
# from "no change" toward the look by the strength; mono and sepia are a hue /
# channel-mix filter moved the same way. Control points are x/y pairs in 0..1.

VIGNETTE_MAX_ANGLE = 0.7
_FILTER_CURVES = {
    # lifted blacks, a warm cast, highlights a little dull
    "vintage": {"r": ((0.0, 0.08), (0.5, 0.53), (1.0, 0.96)),
                "g": ((0.0, 0.05), (0.5, 0.48), (1.0, 0.90)),
                "b": ((0.0, 0.12), (0.5, 0.44), (1.0, 0.76))},
    # teal in the shadows, orange in the highlights
    "cinematic": {"r": ((0.0, 0.0), (0.3, 0.22), (0.7, 0.78), (1.0, 1.0)),
                  "g": ((0.0, 0.02), (0.5, 0.5), (1.0, 0.97)),
                  "b": ((0.0, 0.06), (0.3, 0.36), (0.7, 0.62), (1.0, 0.9))},
    "cool": {"r": ((0.0, 0.0), (1.0, 0.88)), "b": ((0.0, 0.06), (1.0, 1.0))},
    "warm": {"r": ((0.0, 0.04), (1.0, 1.0)), "b": ((0.0, 0.0), (1.0, 0.86))},
    "high-contrast": {"all": ((0.0, 0.0), (0.25, 0.15), (0.75, 0.87), (1.0, 1.0))},
}
#: The classic sepia matrix (rows r, g, b of the output over r, g, b of the input).
_SEPIA = ((0.393, 0.769, 0.189), (0.349, 0.686, 0.168), (0.272, 0.534, 0.131))


def _lerp(a: float, b: float, k: float) -> float:
    return a + (b - a) * k


def _curve(points, k: float) -> str:
    return " ".join(f"{x:.3f}/{_lerp(x, y, k):.3f}" for x, y in points)


def colour_filter(name: str, k: float) -> str:
    """The filter chain of a named look at strength ``k`` (0..1)."""
    if name == "mono":
        return f"hue=s={1.0 - k:.3f}"
    if name == "sepia":
        ident = ((1, 0, 0), (0, 1, 0), (0, 0, 1))
        keys = ("rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb")
        vals = [_lerp(ident[i][j], _SEPIA[i][j], k) for i in range(3) for j in range(3)]
        return "colorchannelmixer=" + ":".join(f"{n}={v:.3f}" for n, v in zip(keys, vals)) + ",format=yuv420p"
    curves = _FILTER_CURVES.get(name)
    if curves is None:
        raise ValueError(f"unknown filter {name!r}")
    args = ":".join(f"{ch if ch != 'all' else 'master'}='{_curve(pts, k)}'" for ch, pts in curves.items())
    return f"curves={args},format=yuv420p"


def effect_filters(fx) -> List[str]:
    """The colour and texture filters of a clip's effects, in the order they run
    (look, blur, sharpen, grain, vignette). The geometric ones are
    :func:`geometry_filter`. Only listed names and formatted numbers are written."""
    out: List[str] = []
    if fx.filter is not None and fx.filter_strength > 0:
        out.append(colour_filter(fx.filter, fx.filter_strength))
    if fx.blur > 0:
        out.append(f"gblur=sigma={fx.blur:.2f}")
    if fx.sharpen > 0:
        out.append(f"unsharp=5:5:{1.5 * fx.sharpen:.2f}:5:5:0")
    if fx.grain > 0:
        # A fixed seed: random grain would make the same document a different video each time.
        out.append(f"noise=alls={int(round(30 * fx.grain))}:allf=t:all_seed=1234")
    if fx.vignette > 0:
        # A SMALLER lens angle is a weaker vignette (0 = none; measured, tests pin it):
        # 0.7 rad takes a mid-grey frame's corners to about a third of their level.
        out.append(f"vignette=angle={VIGNETTE_MAX_ANGLE * fx.vignette:.4f}")
    return out


def geometry_filter(seg: Segment) -> str:
    """``transpose / hflip / vflip / crop,`` for a clip's turn, mirror and crop
    ('' without them, so the chain is the one it was). It runs on the SOURCE,
    before the fit, so a quarter turn is fitted as the portrait picture it has
    become and a crop is what gets fitted. Turn first, then mirror, then the
    crop rectangle of the picture as turned (even pixel sizes, rounded down,
    so 4:2:0 never gets an odd window)."""
    fx = seg.effects
    steps: List[str] = []
    if fx is not None and fx.geometric:
        steps = {90: ["transpose=1"], 180: ["hflip", "vflip"], 270: ["transpose=2"]}.get(fx.rotate, [])
        if fx.flip_h:
            steps.append("hflip")
        if fx.flip_v:
            steps.append("vflip")
    c = seg.crop
    if c is not None and (c.x, c.y, c.w, c.h) != (0.0, 0.0, 1.0, 1.0):
        steps.append(f"crop=w='max(2,trunc(iw*{c.w:.4f}/2)*2)':h='max(2,trunc(ih*{c.h:.4f}/2)*2)'"
                     f":x='trunc(iw*{c.x:.4f}/2)*2':y='trunc(ih*{c.y:.4f}/2)*2'")
    return ",".join(steps) + "," if steps else ""


def angle_filter(seg: Segment, width: int, height: int) -> str:
    """``,rotate=...`` that turns the FITTED picture ``seg.angle`` degrees clockwise
    about its centre inside the frame ('' for no turn): the frame keeps its size,
    what leaves it is cut, and what the turn uncovers is black."""
    if not seg.angle:
        return ""
    return f",rotate=a={math.radians(seg.angle):.6f}:ow={int(width)}:oh={int(height)}:c=black:bilinear=1"


def sar_filter(seg: Segment) -> str:
    """``,setsar=1`` after the fit of a clip that is turned a quarter or cropped: the
    scaler's rounding leaves the picture a pixel shape such as 405:404
    (measured), and a player would stretch it. Nothing is added for a clip that
    is neither, so every older chain is the one it was."""
    if seg.fit == FIT_BLUR:
        return ""  # the blur chain squares its own pixels
    fx = seg.effects
    c = seg.crop
    cropped = c is not None and (c.x, c.y, c.w, c.h) != (0.0, 0.0, 1.0, 1.0)
    return ",setsar=1" if cropped or (fx is not None and fx.rotate in (90, 270)) else ""


def _then(grade: str) -> str:
    """``,<grade>`` for appending to a chain ('' for no grade)."""
    return "," + grade if grade else ""


def _scale_pad(width: int, height: int, fps: int, grade: str = "") -> str:
    """A filter that fits any source into width×height without distortion
    (letter/pillar-boxed) at the target fps — the normalisation the concat
    demuxer needs so segments share codec, size and rate. A colour ``grade``
    goes BEFORE the pad, so the bars stay black (the preview's CSS filter
    does not reach the empty part of the box either)."""
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"{grade + ',' if grade else ''}"
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


def move_filter(mv, width: int, height: int, frames: int) -> str:
    """``,scale...,crop...`` that moves a window over the FITTED picture ('' for
    a move that does not move at zoom 1). The window is ``frame / zoom`` at a
    centre given as fractions of the picture; both go linearly from the first
    keyframe on frame 0 to the second on the clip's last frame (``frames`` long,
    so the progress is ``n / (frames - 1)``). The picture is scaled up to
    ``zoom`` times the frame each frame (``eval=frame``, exact sizes, so the zoom
    is smooth) and the window cut out of it; the centre is held where the window
    stays inside the picture. Every number is formatted from a validated float."""
    if mv.neutral:
        return ""
    last = max(int(frames) - 1, 1)
    p = f"min(1,n/{last})"

    def lerp(a: float, b: float) -> str:
        return f"{a:.4f}" if a == b else f"({a:.4f}+({b - a:.4f})*{p})"
    z = lerp(mv.from_zoom, mv.to_zoom)
    cx, cy = lerp(mv.from_x, mv.to_x), lerp(mv.from_y, mv.to_y)
    w, h = int(width), int(height)
    # A window that only pans is cut from one fixed-size picture: scaled once.
    eval_mode = "init" if mv.from_zoom == mv.to_zoom else "frame"
    return (f",scale=w='trunc({w}*{z}/2)*2':h='trunc({h}*{z}/2)*2':eval={eval_mode}:flags=bicubic"
            f",crop={w}:{h}:x='clip({cx},0.5/{z},1-0.5/{z})*iw-ow/2'"
            f":y='clip({cy},0.5/{z},1-0.5/{z})*ih-oh/2'")


def _scale_crop(width: int, height: int, fps: int, grade: str = "") -> str:
    """Fill width×height, cropping the overflow (a timeline clip's
    ``fit: cover`` — e.g. 16:9 footage in a 9:16 frame without bars). A colour
    ``grade`` runs last, on the frames that are kept (after the fps cut)."""
    return (f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},fps={fps}" + _then(grade))


#: How small the blurred background is made before it is blurred and enlarged
#: again: a heavy blur of a one-eighth picture costs almost nothing and looks the
#: same as a heavy blur of the full one.
BLUR_FIT_SHRINK = 8
BLUR_FIT_SIGMA = 3


def _scale_blur(width: int, height: int, fps: int, grade: str = "", tag: str = "") -> str:
    """The whole picture, centred (as ``contain``), over a blurred copy of itself
    that fills the frame (a timeline clip's ``fit: blur``): no black bars. The
    background is the picture scaled to cover the frame, shrunk, blurred and
    enlarged; the colour ``grade`` and effects run on the composed frame, so
    the background is graded with the picture. One simple filter graph, so
    it goes wherever the other fits' chains go. ``tag`` makes the pad labels
    unique when two of these share one graph (the two sides of a cross-fade)."""
    sw = max(2, width // BLUR_FIT_SHRINK // 2 * 2)
    sh = max(2, height // BLUR_FIT_SHRINK // 2 * 2)
    bg, fg, bb, fs = f"bg{tag}", f"fg{tag}", f"bb{tag}", f"fs{tag}"
    return (f"split=2[{bg}][{fg}];"
            f"[{bg}]scale={sw}:{sh}:force_original_aspect_ratio=increase,crop={sw}:{sh},"
            f"gblur=sigma={BLUR_FIT_SIGMA},scale={width}:{height}:flags=bicubic[{bb}];"
            f"[{fg}]scale={width}:{height}:force_original_aspect_ratio=decrease[{fs}];"
            f"[{bb}][{fs}]overlay=x=(W-w)/2:y=(H-h)/2:format=yuv420,format=yuv420p,fps={fps},setsar=1"
            + _then(grade))


def _fit_for(seg: Segment):
    """The chain builder of a segment's fit."""
    if seg.fit == FIT_COVER:
        return _scale_crop
    if seg.fit == FIT_BLUR:
        return _scale_blur
    return _scale_pad


def _fade_filters(seg: Segment, length_s: float) -> str:
    """``,fade=...`` for a segment's fades from/to black ('' when it has none,
    so a pipeline segment's filter is unchanged). ``length_s`` is the clip's
    real length, so the fade-out ends on its last frame."""
    out = ""
    if seg.fade_in_s > 0:
        out += f",fade=t=in:st=0:d={seg.fade_in_s:.3f}"
    if seg.fade_out_s > 0:
        out += f",fade=t=out:st={max(0.0, length_s - seg.fade_out_s):.3f}:d={seg.fade_out_s:.3f}"
    return out


def _piece_trim(seg: Segment, fps: int) -> str:
    """``,trim=...`` that keeps a piece of a clip from its offset ('' for a
    whole clip, so its filter is unchanged). It runs AFTER the clip's own
    filters, so fades and a still's move are where they would be in the
    whole clip; ``-frames:v`` then takes the piece's length."""
    k = int(round(seg.offset_s * fps))
    return f",trim=start_frame={k},setpts=PTS-STARTPTS" if k > 0 else ""


def _static_image_cmd(ffmpeg: str, path: str, dur: str, width: int, height: int,
                      fps: int, common: List[str], out_path: Path, *,
                      length: Optional[List[str]] = None, extra_vf: str = "",
                      fill: bool = False, grade: str = "", pre: str = "") -> List[str]:
    """The still held without a move. ``fill`` crops the middle to cover the
    frame (a timeline's stills, as the Ken Burns move that this stands in for
    does); the default letter/pillar-boxes it, as the pipeline always has."""
    fit = _scale_crop if fill else _scale_pad
    return [ffmpeg, "-y", "-loop", "1", "-i", path, *(length or ["-t", dur]),
            "-vf", pre + fit(width, height, fps, grade) + extra_vf, *common, str(out_path)]


def segment_commands(
    ffmpeg: str, seg: Segment, out_path: Path, width: int, height: int, fps: int,
    *, seed: Optional[str] = None, x264: Sequence[str] = (), frame_exact: bool = False,
) -> List[List[str]]:
    """The ffmpeg command(s) that normalise one segment — pure, runs nothing.
    Usually one; a still gets two: the Ken Burns move, then the static hold
    that is run only if the move fails.

    Without the timeline options (``frame_exact`` and the Segment's
    ``in_s``/``fit``/fades at their defaults) these are exactly the commands
    this backend always ran. ``frame_exact`` replaces ``-t``/``d=`` with
    ``-frames:v round(duration*fps)``: measured at 30 fps, a 1.067 s colour
    segment gave 33 frames and an input-seeked clip one frame short, which
    would drift every later cut of a timeline off its audio.

    A timeline's commands (``frame_exact``, and every cross-fade) read library
    media members uploaded, so each input gets the decoder's frame cap (the
    video cap for a clip, the still cap for a picture, BR-L-004 / BR-L-010)
    and two decoder threads (BR-L-007), and ``_run`` fails the command on a
    refused frame: skipped, it would leave a short clip, or under
    ``-stream_loop -1`` a clip whose every frame is refused would loop until
    the export's time limit. The pipeline's commands are unchanged."""
    cmds = _segment_commands(ffmpeg, seg, out_path, width, height, fps,
                             seed=seed, x264=x264, frame_exact=frame_exact)
    if frame_exact or seg.xfade is not None:
        videos = [s.path for s in (seg, seg.xfade) if s is not None and s.path and s.kind == KIND_VIDEO]
        return [cap_inputs(c, video_inputs=videos, out_pixels=width * height) for c in cmds]
    return cmds


def _segment_commands(
    ffmpeg: str, seg: Segment, out_path: Path, width: int, height: int, fps: int,
    *, seed: Optional[str] = None, x264: Sequence[str] = (), frame_exact: bool = False,
) -> List[List[str]]:
    if seg.xfade is not None:
        return _xfade_commands(ffmpeg, seg, out_path, width, height, fps,
                               seed=seed, x264=x264)
    dur = f"{max(0.001, seg.duration):.3f}"
    common = ["-c:v", "libx264", *x264, "-pix_fmt", "yuv420p", "-r", str(fps)]
    frames = segment_frames(seg.duration, fps)
    length = ["-frames:v", str(frames)] if frame_exact else ["-t", dur]
    # A piece of a clip is filtered as the whole clip (its fades end on the
    # clip's last frame, a still's move spans the clip), then trimmed.
    full = segment_frames(seg.clip_s, fps) if frame_exact and seg.clip_s > 0 else frames
    length_s = full / fps if frame_exact else float(dur)
    fades = _fade_filters(seg, length_s) + (_piece_trim(seg, fps) if frame_exact else "")

    if seg.kind == KIND_COLOR or not seg.path:
        # A black placeholder needs no fade: it already is black.
        if frame_exact:
            return [[ffmpeg, "-y", "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={fps}",
                     *length, *common, str(out_path)]]
        return [[ffmpeg, "-y", "-f", "lavfi", "-i",
                 f"color=c=black:s={width}x{height}:r={fps}:d={dur}", *common, str(out_path)]]
    if seg.kind == KIND_IMAGE and seg.move is not None:
        # The document's own move replaces the automatic slow zoom: the still is
        # filled to the frame, then the window travels. The plain hold is the
        # fallback, as for the automatic move.
        grade = grade_filter(seg)
        pre = geometry_filter(seg)
        mv = move_filter(seg.move, width, height, full)
        ang = sar_filter(seg) + angle_filter(seg, width, height)
        hold = _static_image_cmd(ffmpeg, seg.path, dur, width, height, fps, common, out_path,
                                 length=length, extra_vf=ang + fades, fill=True, grade=grade, pre=pre)
        vf = pre + _scale_crop(width, height, fps, grade) + ang + mv + fades
        return [[ffmpeg, "-y", "-loop", "1", "-i", seg.path, *length, "-vf", vf, *common, str(out_path)], hold]
    if seg.kind == KIND_IMAGE:
        style = ken_burns_style(seed if seed is not None else seg.path)
        # Same length as the static hold: the frame count is the one the
        # old path produced, only the pixels move.
        grade = grade_filter(seg)
        pre = geometry_filter(seg)     # turn / mirror the picture before it is scaled and moved
        ang = sar_filter(seg) + angle_filter(seg, width, height)
        vf = pre + ken_burns_filter(style, width, height, fps,
                                    float(full) if frame_exact else float(dur) * fps) + _then(grade) + ang + fades
        hold = _static_image_cmd(ffmpeg, seg.path, dur, width, height, fps, common, out_path,
                                 length=length if frame_exact else None, extra_vf=ang + fades,
                                 fill=frame_exact, grade=grade, pre=pre)
        return [[ffmpeg, "-y", "-i", seg.path, *length, "-vf", vf, *common, str(out_path)], hold]
    # KIND_VIDEO. -stream_loop -1: a source shorter than its slot is looped (as
    # the MoviePy compositor does with vc.loop) instead of yielding a short
    # clip that would drift every later cut off the audio timeline. -ss before
    # -i is an input seek, frame-accurate when transcoding, and the output's
    # timestamps start at 0 — so the fades above are relative to the cut.
    inputs, chain = _video_source(seg, width, height, fps, full, stab=stab_filter(ffmpeg, seg, out_path.parent))
    return [[ffmpeg, "-y", *inputs, *length, "-an",
             "-vf", (chain
                     + (move_filter(seg.move, width, height, full) if seg.move is not None else "")
                     + fades),
             *common,
             str(out_path)]]


# ── stabilisation ───────────────────────────────────────────────────────────
#
# vidstab is two passes over the clip: detect the motion of every source frame
# into a ``.trf`` file, then apply a smoothed path. The detect pass is its own
# command (segment_prepasses), run before the segment's; the transform sits in
# the segment's chain right after the turn / crop, on the SOURCE frames. Without
# the vidstab filters the single-pass, built-in ``deshake`` is used (weaker).

STAB_SHAKINESS = 5
STAB_ACCURACY = 15
STAB_SMOOTHING = 15


@functools.lru_cache(maxsize=8)
def stabilizer(ffmpeg: str) -> str:
    """``"vidstab"`` when this ffmpeg has both vidstab filters, else ``"deshake"``."""
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True,
                             timeout=30).stdout or ""
    except Exception:
        return "deshake"
    return "vidstab" if ("vidstabdetect" in out and "vidstabtransform" in out) else "deshake"


def _source_range_s(seg: Segment) -> float:
    """Seconds of the SOURCE a segment's clip plays (its range)."""
    if seg.curve is not None:
        return seg.curve.range_s
    return seg.full_s * seg.speed


def stab_trf_path(seg: Segment, workdir: Path) -> Path:
    """Where the detect pass for this clip's source range is kept: named by what
    it analysed, so every piece of a cross-faded clip shares one."""
    key = hashlib.sha1(
        f"{seg.path}|{seg.in_s:.3f}|{_source_range_s(seg):.3f}|{geometry_filter(seg)}".encode()).hexdigest()[:16]
    return Path(workdir) / f"stab-{key}.trf"


def stab_filter(ffmpeg: str, seg: Segment, workdir: Path) -> str:
    """``<transform>,`` for a stabilised video segment ('' otherwise: the chain is
    the one it was)."""
    if not seg.stabilize or seg.kind != KIND_VIDEO or not seg.path:
        return ""
    if stabilizer(ffmpeg) == "vidstab":
        return (f"vidstabtransform=input={_quote_filter_path(str(stab_trf_path(seg, workdir)))}"
                f":smoothing={STAB_SMOOTHING}:optzoom=1:interpol=bicubic,")
    return "deshake=rx=32:ry=32:edge=3,"


def segment_prepasses(ffmpeg: str, seg: Segment, out_path: Path, width: int, height: int,
                      ) -> List[tuple]:
    """``(trf path, part path, command)`` for each vidstab detect pass this
    segment needs (its own clip and, for a cross-fade, the incoming one), pure.
    The command writes ``part`` (the caller renames it to ``trf``)."""
    out = []
    for s in (seg, seg.xfade):
        if s is None or not s.stabilize or s.kind != KIND_VIDEO or not s.path:
            continue
        if stabilizer(ffmpeg) != "vidstab":
            continue
        trf = stab_trf_path(s, out_path.parent)
        part = trf.with_name(f"{trf.name}.{os.getpid()}-{threading.get_ident()}.part")
        seek = ["-ss", f"{s.in_s:.3f}"] if s.in_s > 0 else []
        cmd = [ffmpeg, "-y", *seek, "-t", f"{_source_range_s(s):.3f}", "-i", s.path, "-an", "-vf",
               geometry_filter(s) + f"vidstabdetect=shakiness={STAB_SHAKINESS}:accuracy={STAB_ACCURACY}"
               f":result={_quote_filter_path(str(part))}", "-f", "null", "-"]
        out.append((trf, part, cap_inputs(cmd, video_inputs=[s.path], out_pixels=width * height)))
    return out


def _video_source(seg: Segment, width: int, height: int, fps: int, full: int,
                  tag: str = "", stab: str = "") -> tuple:
    """``(input args, filter chain)`` that read a video clip and bring it to the
    output frame: forward (retimed first, then fitted — the chain this backend
    always had), reversed, or one held frame.

    Reverse fits the picture to the output size and rate FIRST and reverses
    after, so the frames ffmpeg holds in memory are output-sized (the document
    caps the range for that, timeline.REVERSE_MAX_BYTES), then retimes and
    resamples. It reads only the range (``-t``): a reversed clip is not looped.
    A frozen clip keeps its first frame and repeats it for the rest of the clip."""
    seek = ["-ss", f"{seg.in_s:.3f}"] if seg.in_s > 0 else []
    fit = _fit_for(seg)
    grade = grade_filter(seg)
    framed = (_scale_blur(width, height, fps, grade, tag) if fit is _scale_blur
              else fit(width, height, fps, grade)) + angle_filter(seg, width, height)
    geo = geometry_filter(seg)
    sar = sar_filter(seg)
    if seg.freeze:
        return ([*seek, "-i", seg.path],
                f"{geo}trim=end_frame=1,setpts=PTS-STARTPTS,{framed},"
                f"tpad=stop={max(full - 1, 0)}:stop_mode=clone{sar}")
    geo += stab                                # the transform runs on the source frames, after the turn / crop
    if seg.reverse:
        span = full / fps * seg.speed          # seconds of SOURCE the clip plays
        return ([*seek, "-t", f"{span:.3f}", "-i", seg.path],
                f"{geo}{framed},reverse,setpts=(PTS-STARTPTS)/{float(seg.speed):.3f},fps={fps}{sar}")
    if seg.interpolate:
        # Slow motion made smoother: fit to the output frame, make in-between frames up to a rate
        # where every output frame of the slowest part is a different one, THEN retime and sample.
        slowest = seg.speed if seg.curve is None else min(s for _a, s in seg.curve.points)
        return (["-stream_loop", "-1", *seek, "-i", seg.path],
                f"{geo}{framed},format=yuv420p,minterpolate=fps={interp_fps(slowest, fps)}"
                ":mi_mode=mci:mc_mode=aobmc:vsbmc=1,"
                + retime_filter(seg).rstrip(",") + f",fps={fps}{sar}")
    return (["-stream_loop", "-1", *seek, "-i", seg.path],
            retime_filter(seg) + geo + framed + sar)


def _xfade_side(seg: Segment, width: int, height: int, fps: int, seed: str,
                hold: bool, tag: str = "", stab: str = "") -> tuple:
    """(input args, filter chain) for one side of a cross-fade: the clip's
    usual normalisation over the whole clip, cut to this piece, and pinned
    to one frame rate, time base and pixel format — xfade refuses two inputs
    that differ in any of them (a still's pan reaches it at the still's own
    rate otherwise)."""
    full = segment_frames(seg.full_s, fps)
    tail = (_fade_filters(seg, full / fps) + _piece_trim(seg, fps)
            + f",settb=1/{fps},fps={fps},format=yuv420p")
    grade = grade_filter(seg)
    mv = move_filter(seg.move, width, height, full) if seg.move is not None else ""
    ang = sar_filter(seg) + angle_filter(seg, width, height)
    if seg.kind == KIND_IMAGE and seg.move is not None:
        return (["-loop", "1", "-i", seg.path],
                geometry_filter(seg) + _scale_crop(width, height, fps, grade) + ang + mv + tail)
    if seg.kind == KIND_IMAGE:
        if hold:
            # A timeline's still fills the frame in the move, so it does held too.
            return (["-loop", "1", "-i", seg.path],
                    geometry_filter(seg) + _scale_crop(width, height, fps, grade) + ang + tail)
        return (["-i", seg.path],
                geometry_filter(seg) + ken_burns_filter(ken_burns_style(seed), width, height, fps, float(full))
                + _then(grade) + ang + tail)
    inputs, chain = _video_source(seg, width, height, fps, full, tag, stab)
    return inputs, chain + mv + tail


def _xfade_commands(ffmpeg: str, seg: Segment, out_path: Path, width: int, height: int,
                    fps: int, *, seed: Optional[str] = None,
                    x264: Sequence[str] = ()) -> List[List[str]]:
    """The command(s) for a cross-fade segment: the outgoing clip's last
    frames (``seg``) dissolve into the incoming clip's first ones
    (``seg.xfade``) with ffmpeg ``xfade``, exactly ``round(duration * fps)``
    frames. Two decoders at once, for this segment only. Every number in the
    graph is formatted here from validated floats; nothing from a document
    reaches it as text (paths are -i arguments, never in the graph).
    With a still on either side there is a second command, both stills held
    without the Ken Burns move, run only if the first fails."""
    x = seg.xfade
    style = seg.xfade_style
    if style not in XFADE_STYLES:
        # Defence in depth (render_spec.validate refuses it first): only a name
        # from the closed list ever reaches the filter graph.
        raise ValueError(f"unknown cross-fade style {style!r}")
    frames = segment_frames(seg.duration, fps)
    seed_a = seg.seed or (seed if seed is not None else str(seg.path))
    seed_b = x.seed or f"{seed_a}:xfade"
    common = ["-c:v", "libx264", *x264, "-pix_fmt", "yuv420p", "-r", str(fps)]

    def cmd(hold: bool) -> List[str]:
        ia, ca = _xfade_side(seg, width, height, fps, seed_a, hold, "a", stab_filter(ffmpeg, seg, out_path.parent))
        ib, cb = _xfade_side(x, width, height, fps, seed_b, hold, "b", stab_filter(ffmpeg, x, out_path.parent))
        graph = (f"[0:v]{ca}[xa];[1:v]{cb}[xb];"
                 f"[xa][xb]xfade=transition={style}:duration={frames / fps:.6f}:offset=0[xv]")
        return [ffmpeg, "-y", *ia, *ib, "-filter_complex", graph, "-map", "[xv]",
                "-frames:v", str(frames), "-an", *common, str(out_path)]

    if KIND_IMAGE in (seg.kind, x.kind):
        return [cmd(False), cmd(True)]
    return [cmd(False)]


def retime_filter(seg: Segment) -> str:
    """``setpts=...,`` that retimes a video segment: its speed curve when it has
    one (one expression, modules/speed_ramp.py), else its constant speed ('' at 1)."""
    if seg.curve is not None:
        return f"setpts='{speed_ramp.setpts_expression(seg.curve.absolute())}',"
    return speed_filter(seg.speed)


def speed_filter(speed: float) -> str:
    """``setpts=...,`` that plays a video ``speed`` times faster ('' at 1, so a
    pipeline segment's filter is unchanged). It runs before the fit's
    ``fps=``: the retimed stream is resampled to the output rate (frames
    dropped when faster, repeated when slower), so ``-frames:v`` still cuts
    the segment to exactly its frames. STARTPTS: after an input seek the first
    frame's timestamp is not always 0, and dividing an offset would shift the
    cut."""
    if speed == 1.0:
        return ""
    return f"setpts=(PTS-STARTPTS)/{float(speed):.3f},"


def _normalize_segment(
    ffmpeg: str, seg: Segment, out_path: Path, width: int, height: int, fps: int,
    *, seed: Optional[str] = None, x264: Sequence[str] = (), frame_exact: bool = False,
    deadline: Optional[float] = None,
) -> None:
    """Render one timeline segment to a uniform silent H.264 clip of its
    duration. A colour placeholder is generated; an image gets the Ken Burns
    move ``ken_burns_style(seed)`` (held static if that ffmpeg run fails); a
    video is trimmed and fitted. Audio is dropped here — the spec muxes one
    narration track over the whole concatenation.

    ``x264`` is the encoder settings (``INTERMEDIATE_X264`` from ``render``);
    empty means libx264's defaults — the command this backend always ran."""
    cmds = segment_commands(ffmpeg, seg, out_path, width, height, fps,
                            seed=seed, x264=x264, frame_exact=frame_exact)
    # Only a timeline export passes a deadline; every other caller (and the
    # tests that stand in for _run) makes exactly the call it always made.
    run = _run if deadline is None else (lambda c: _run(c, deadline=deadline))
    for trf, part, detect in segment_prepasses(ffmpeg, seg, out_path, width, height):
        # vidstab's first pass. No quiet fallback if it fails: the clip was asked to be steadied.
        if trf.exists() and trf.stat().st_size > 0:
            continue
        run(detect)
        os.replace(part, trf)
    if len(cmds) == 2 and seg.path:
        # A still (or a cross-fade with one): the Ken Burns move, else held.
        move, hold = cmds
        try:
            run(move)
            return
        except (RenderTimeout, RenderRefused):
            # The hold reads the same picture: it would be refused too.
            raise
        except RenderBackendError as e:
            logger.warning("Ken Burns (%s) failed for %s — holding the still instead: %s",
                           ken_burns_style(seed if seed is not None else seg.path),
                           Path(seg.path).name, e)
        run(hold)
        return
    run(cmds[0])


# ── segment normalisation: one fast intermediate, a bounded worker pool ─────
#
# Measured on a 60 s 1080p30 sample (12 cuts: 4K + HD clips, Ken Burns stills,
# word-highlighted .ass, narration) with the bundled ffmpeg on 4 cores: the
# render took 74 s, 41 s of it normalising segments and 33 s in the final
# pass. Decoding, scaling and the Ken Burns filters were cheap (0.4-1.8 s per
# 5 s cut to a null sink); a medium-preset x264 encode was most of every
# segment — and the final pass then decoded that and encoded every frame
# AGAIN at the same settings. So the segments are now a near-lossless,
# ultrafast intermediate and the quality encode happens once, in the final
# pass (render_spec.FINAL_X264, unchanged). With cheap encodes the segments
# are short, mostly single-threaded ffmpeg runs, so several run at once.

#: Segment encode: ultrafast is ~4x cheaper than medium here, and at crf 12 it
#: is visually lossless, so the final pass starts from better pixels than the
#: medium/crf 23 segments it used to re-encode (one lossy generation, not two).
#: The price is disk: measured 372 MB for the 60 s sample (13.7 MB with the
#: old settings), all of it in the render's temp dir. crf 17 / 20 were tried
#: and are worse on every axis — their artefacts cost the final encode more
#: than the smaller files save (final pass 37.8 s / 68.7 s vs 36.7 s, and a
#: lower SSIM) — so the guard below, not a higher crf, is what bounds disk.
INTERMEDIATE_X264: tuple = ("-preset", "ultrafast", "-crf", "12")
#: Disk guard: bytes per second of 1080p video the intermediate may need
#: (6.2 MB/s measured on grainy footage, with headroom) and scaled by pixel
#: count for other sizes. Less free space than that → the old compact settings.
INTERMEDIATE_MB_PER_S_1080P = 8.0
#: A segment with film grain is ~13x bigger (measured, crf 12 ultrafast: 42.7 MB/s at 1080p30 and
#: 73 MB/s at 1080p60 with ``noise alls=15``; ~15x at alls=30, because noise cannot be predicted),
#: so its seconds are charged this many times over in the disk guard.
GRAIN_DISK_FACTOR = 12.0
#: The segment encode the backend ran before (libx264 defaults). The
#: sequential fallback uses it, so a fallback is exactly the old path.
LEGACY_X264: tuple = ()

JOBS_ENV = "NIGHTSHIFT_RENDER_JOBS"
#: Memory guard. A 1080p normalise holding a 4K decoder and an ultrafast x264
#: measured well under 400 MB; 700 MB per job leaves headroom for a larger
#: source. The reserve is what the rest of the pipeline (and the runner) keeps.
MEM_PER_JOB_MB = 700
MEM_RESERVE_MB = 1536


def _available_mb() -> Optional[float]:
    try:
        from modules import resource_monitor

        return resource_monitor.system_memory_mb()[1]
    except Exception:
        return None


def render_jobs(n_tasks: int, *, env: Optional[str] = None, cpu_count: Optional[int] = None,
                available_mb: Optional[Callable[[], Optional[float]]] = None) -> int:
    """How many segments to normalise at once.

    ``NIGHTSHIFT_RENDER_JOBS`` when it is a positive integer (1 = the old
    one-at-a-time path), else the CPU count — never more than there are
    segments, and never more than fit in MemAvailable above the reserve
    (unknown memory → no memory cap). Always at least 1. Never raises."""
    n = max(1, int(n_tasks or 1))
    raw = os.environ.get(JOBS_ENV, "") if env is None else env
    jobs = None
    if str(raw or "").strip():
        try:
            jobs = int(str(raw).strip())
        except ValueError:
            jobs = None
        if jobs is None or jobs < 1:
            logger.warning("%s=%r is not a positive integer — using the default", JOBS_ENV, raw)
            jobs = None
    if jobs is None:
        jobs = cpu_count if cpu_count is not None else (os.cpu_count() or 1)
    jobs = max(1, min(int(jobs), n))
    avail = (available_mb or _available_mb)()
    if avail is not None:
        fit = int((avail - MEM_RESERVE_MB) // MEM_PER_JOB_MB)
        jobs = max(1, min(jobs, fit))
    return jobs


def run_pool(tasks: Sequence[Callable[[], None]], jobs: int, *,
             available_mb: Optional[Callable[[], Optional[float]]] = None) -> List[float]:
    """Run ``tasks`` with at most ``jobs`` in flight and return each task's wall
    seconds, in TASK order (completion order never matters: every task writes
    its own file). A new task is not started while MemAvailable is below the
    reserve and another one is still running.

    On the first failure no new task starts, the ones in flight are waited for
    (their ffmpeg children exit and are reaped — nothing orphaned), and the
    exception is raised."""
    probe = available_mb or _available_mb
    times: List[Optional[float]] = [None] * len(tasks)

    def timed(i: int) -> None:
        t0 = time.monotonic()
        tasks[i]()
        times[i] = round(time.monotonic() - t0, 3)

    jobs = max(1, int(jobs))
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs,
                                               thread_name_prefix="ffmpeg-seg") as pool:
        running: set = set()
        error: Optional[BaseException] = None
        for i in range(len(tasks)):
            while running and (len(running) >= jobs or _memory_low(probe)):
                done, running = concurrent.futures.wait(
                    running, return_when=concurrent.futures.FIRST_COMPLETED)
                error = error or _first_error(done)
                if error:
                    break
            if error:
                break
            running.add(pool.submit(timed, i))
        if running:
            done, _ = concurrent.futures.wait(running)
            error = error or _first_error(done)
        if error:
            raise error
    return [t if t is not None else 0.0 for t in times]


def _memory_low(probe) -> bool:
    try:
        avail = probe()
    except Exception:
        return False
    return avail is not None and avail < MEM_RESERVE_MB + MEM_PER_JOB_MB


def _first_error(done) -> Optional[BaseException]:
    for f in done:
        e = f.exception()
        if e is not None:
            return e
    return None


# ── timings ─────────────────────────────────────────────────────────────────

TIMING_PREFIX = "ffmpeg render timing:"


@dataclass
class RenderTimings:
    """Where one render's wall time went. None = not measured (e.g. concat,
    which runs inside the final pass), never 0."""
    segments: int = 0
    jobs: Optional[int] = None
    mode: Optional[str] = None           # parallel | sequential | fallback
    normalize_s: Optional[float] = None  # wall time of the whole normalise stage
    segment_s: List[float] = field(default_factory=list)  # each segment's own wall time
    concat_s: Optional[float] = None
    final_s: Optional[float] = None      # concat + captions + audio mux + the quality encode
    total_s: Optional[float] = None

    @property
    def normalize_avg_s(self) -> Optional[float]:
        return round(sum(self.segment_s) / len(self.segment_s), 3) if self.segment_s else None

    def log_line(self) -> str:
        """One stable ``key=value`` line; tools/render_benchmark.py parses it."""
        def v(x):
            if x is None:
                return "na"
            return f"{x:.2f}" if isinstance(x, float) else str(x)
        return (f"{TIMING_PREFIX} segments={self.segments} jobs={v(self.jobs)} "
                f"mode={v(self.mode)} normalize_s={v(self.normalize_s)} "
                f"normalize_avg_s={v(self.normalize_avg_s)} concat_s={v(self.concat_s)} "
                f"final_s={v(self.final_s)} total_s={v(self.total_s)}")


def intermediate_x264(spec: RenderSpec, tmpdir: Path, *,
                      free_mb: Optional[Callable[[Path], Optional[float]]] = None) -> tuple:
    """The segment encode for this render: the fast intermediate when the temp
    dir has room for it, else the old compact settings (slower, never a
    full-disk failure halfway through a long render). Never raises."""
    try:
        grain_s = sum(float(seg.duration) for seg in spec.segments
                      if getattr(seg, "effects", None) is not None and seg.effects.grain > 0)
        need = ((spec.total_duration + (GRAIN_DISK_FACTOR - 1) * grain_s) * INTERMEDIATE_MB_PER_S_1080P
                * (spec.width * spec.height) / (1920 * 1080))
        free = (free_mb or _free_mb)(Path(tmpdir))
    except Exception:
        return INTERMEDIATE_X264
    if free is not None and free < need:
        logger.warning("Only %.0f MB free for ffmpeg intermediates (up to %.0f MB needed) — "
                       "encoding segments with the compact settings instead", free, need)
        return LEGACY_X264
    return INTERMEDIATE_X264


def _free_mb(path: Path) -> Optional[float]:
    try:
        st = os.statvfs(str(path))
        return st.f_bavail * st.f_frsize / 1048576.0
    except (OSError, AttributeError):
        return None


def _normalize_all(ffmpeg: str, spec: RenderSpec, tmpdir: Path, jobs: int,
                   timings: RenderTimings, deadline: Optional[float] = None) -> List[Segment]:
    """Every segment → ``seg_NNNN.mp4``, in parallel when ``jobs`` > 1.

    Any failure of the parallel path — a segment, the pool itself — is logged
    and the whole stage is redone one segment at a time with the old encode
    settings: exactly the path this backend always ran. Only a failure there
    raises (and render_dispatch then falls back to MoviePy, as before)."""
    outs = [tmpdir / f"seg_{i:04d}.mp4" for i in range(len(spec.segments))]

    def task(i: int, x264: Sequence[str]) -> Callable[[], None]:
        seg = spec.segments[i]
        # Only a timeline spec passes frame_exact: a pipeline render makes
        # exactly the call it always made.
        extra = {"frame_exact": True} if spec.frame_exact else {}
        if deadline is not None:
            extra["deadline"] = deadline
        # A piece of a cross-faded clip carries its clip's seed, so every
        # piece of one still makes the same move.
        return lambda: _normalize_segment(ffmpeg, seg, outs[i], spec.width, spec.height,
                                          spec.fps, seed=seg.seed or f"{i}:{seg.path}",
                                          x264=x264, **extra)

    t0 = time.monotonic()
    try:
        x264 = intermediate_x264(spec, tmpdir)
        tasks = [task(i, x264) for i in range(len(outs))]
        if jobs > 1:
            timings.segment_s = run_pool(tasks, jobs)
        else:
            timings.segment_s = _run_sequential(tasks)
        timings.mode, timings.jobs = ("parallel" if jobs > 1 else "sequential"), jobs
    except (RenderTimeout, RenderRefused):
        # Out of time: redoing the stage one segment at a time would only
        # run past the limit again. Refused: the same file is refused again.
        raise
    except Exception as e:
        logger.warning("ffmpeg segment normalisation (%d job(s)) failed (%s) — redoing it "
                       "one segment at a time", jobs, f"{type(e).__name__}: {e}"[:300])
        for p in outs:
            try:
                p.unlink()
            except OSError:
                pass
        timings.segment_s = _run_sequential([task(i, LEGACY_X264) for i in range(len(outs))])
        timings.mode, timings.jobs = "fallback", 1
    timings.normalize_s = round(time.monotonic() - t0, 3)
    return [Segment(duration=seg.duration, path=str(outs[i]), kind=KIND_VIDEO)
            for i, seg in enumerate(spec.segments)]


def _run_sequential(tasks: Sequence[Callable[[], None]]) -> List[float]:
    times = []
    for t in tasks:
        t0 = time.monotonic()
        t()
        times.append(round(time.monotonic() - t0, 3))
    return times


def draw_shapes(spec: RenderSpec, workdir: Path) -> list:
    """The spec's picture overlays with every drawn shape written to a PNG in ``workdir`` and its
    ``path`` set to that file (the filter graph only ever sees a path this function made; the
    shape's own values, text included, are rasterised here). Drawn at the widest the shape ever is
    (a move to a bigger ``w`` scales DOWN from it), for the spec's frame."""
    out = []
    for k, o in enumerate(spec.picture_overlays):
        if o.shape is None:
            out.append(o)
            continue
        wide = max(o.w, o.to_w) if o.to_w is not None else o.w
        path = Path(workdir) / f"shape-{k}.png"
        try:
            shape_art.write_png(o.shape, wide, spec.width, spec.height, path)
        except shape_art.ShapeArtError as e:
            raise RenderBackendError(str(e)) from None
        out.append(replace(o, path=str(path)))
    return out


def _file_pixels(path: str) -> int:
    """Pixels of a picture file (its header only), 0 when it cannot be read as one."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return int(im.size[0]) * int(im.size[1])
    except Exception:   # not a picture, a bomb, missing: the decoder's own limits and errors come first
        return 0


def check_layers_fit(spec: RenderSpec) -> None:
    """With drawn shapes in the spec (their PNGs written), refuse an export whose layers would not fit the
    final pass's memory, with the numbers, before any segment is encoded. The validators judge a document
    without its files (a picture is charged its box); here the files are known: a picture is charged its box or
    its own pixels, whichever is more (four 16 MP photos shrunk to a corner need ~80 MiB each, not their box's
    ~30), a shape its PNG. A video overlay is charged its box."""
    if not any(o.shape is not None for o in spec.picture_overlays):
        return
    pixels = []
    for o in spec.picture_overlays:
        if o.shape is not None:
            pixels.append(_file_pixels(o.path))
            continue
        wide = max(o.w, o.to_w) if o.to_w is not None else o.w
        box = shape_art.picture_pixels({"w": wide}, spec.width, spec.height)
        pixels.append(max(box, _file_pixels(o.path)) if o.kind != KIND_VIDEO else box)
    need = shape_art.memory_estimate_for_pixels(spec.width, spec.height, pixels)
    budget = shape_art.memory_budget_bytes()
    if need > budget:
        raise RenderBackendError(
            f"the shapes and pictures would need about {need / shape_art.MIB:.0f} MB to render in a "
            f"{spec.width}x{spec.height} frame, but {budget / shape_art.MIB:.0f} MB is the most the export has — "
            "use smaller pictures (their own pixels count), or fewer or smaller shapes (memory)")


def render(spec: RenderSpec, *, ffmpeg: Optional[str] = None, workdir: Optional[str] = None,
           jobs: Optional[int] = None, timings: Optional[RenderTimings] = None,
           timeout_s: Optional[float] = None) -> str:
    """Render `spec` to `spec.output_path` via ffmpeg and return that path.

    Normalises every segment (``jobs`` at once; default ``render_jobs``),
    concatenates them, muxes `audio_path`, and burns `subtitle_path` when set.
    Raises RenderBackendError on an invalid spec or an ffmpeg failure — never a
    silent empty file. ``timings`` (optional) is filled in; the same numbers are
    logged as one ``ffmpeg render timing:`` line.

    ``timeout_s`` bounds the whole render's wall time: every ffmpeg it starts
    shares one deadline, the one running when it passes is killed, the temp
    directory is removed, and RenderTimeout is raised. None = no limit (the
    pipeline's renders, unchanged).
    """
    problems = validate(spec)
    if problems:
        raise RenderBackendError("invalid render spec: " + "; ".join(problems))

    ffmpeg = ffmpeg or resolve_ffmpeg()
    if spec.overlays and not ass_captions.has_libass(ffmpeg):
        # Checked before any segment is encoded: a timeline's titles and
        # captions are part of the video — rendering without them would be a
        # silent quality fallback. Say what fixes it instead.
        raise RenderBackendError(
            "this ffmpeg build has no libass 'subtitles' filter, so the timeline's text "
            "overlays and captions cannot be burnt in — install an ffmpeg built with libass")
    Path(spec.output_path).parent.mkdir(parents=True, exist_ok=True)
    timings = timings if timings is not None else RenderTimings()
    timings.segments = len(spec.segments)
    jobs = render_jobs(len(spec.segments)) if jobs is None else max(1, int(jobs))
    t_start = time.monotonic()
    deadline = t_start + float(timeout_s) if timeout_s is not None else None

    tmp_ctx = tempfile.TemporaryDirectory(dir=workdir) if workdir else tempfile.TemporaryDirectory()
    with tmp_ctx as tmp:
        tmpdir = Path(tmp)
        # Drawn before any segment is encoded: a shape that cannot be drawn (no font, a Pillow error)
        # is refused up front, not after the minutes the segments take.
        if any(o.shape is not None for o in spec.picture_overlays):
            spec = replace(spec, picture_overlays=draw_shapes(spec, tmpdir))
            check_layers_fit(spec)
        normalized = (_normalize_all(ffmpeg, spec, tmpdir, jobs, timings) if deadline is None
                      else _normalize_all(ffmpeg, spec, tmpdir, jobs, timings, deadline))

        norm_spec = replace(spec, segments=normalized)
        concat_path = tmpdir / "concat.txt"
        concat_path.write_text("\n".join(concat_list_lines(norm_spec)) + "\n", encoding="utf-8")

        overlay_path = None
        if spec.overlays:
            overlay_path = tmpdir / OVERLAY_FILENAME
            overlay_path.write_text(
                ass_captions.build_overlay_ass(spec.overlays, width=spec.width, height=spec.height),
                encoding="utf-8")
        cmd = build_ffmpeg_command(norm_spec, str(concat_path),
                                   str(overlay_path) if overlay_path else None)
        cmd[0] = ffmpeg  # the builder emits a literal "ffmpeg"; use the resolved binary
        t0 = time.monotonic()
        if deadline is None:
            _run(cmd)
        else:
            _run(cmd, deadline=deadline)
        timings.final_s = round(time.monotonic() - t0, 3)
    timings.total_s = round(time.monotonic() - t_start, 3)

    logger.info("ffmpeg backend rendered %s (%d segments, %.1fs)",
                spec.output_path, len(spec.segments), spec.total_duration)
    logger.info(timings.log_line())
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
