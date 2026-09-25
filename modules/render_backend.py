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
import hashlib
import logging
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, List, Optional, Sequence

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
    *, seed: Optional[str] = None, x264: Sequence[str] = (),
) -> None:
    """Render one timeline segment to a uniform silent H.264 clip of its
    duration. A colour placeholder is generated; an image gets the Ken Burns
    move ``ken_burns_style(seed)`` (held static if that ffmpeg run fails); a
    video is trimmed and fitted. Audio is dropped here — the spec muxes one
    narration track over the whole concatenation.

    ``x264`` is the encoder settings (``INTERMEDIATE_X264`` from ``render``);
    empty means libx264's defaults — the command this backend always ran."""
    dur = f"{max(0.001, seg.duration):.3f}"
    common = ["-c:v", "libx264", *x264, "-pix_fmt", "yuv420p", "-r", str(fps)]

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
#: The files are larger (~2-5x) but live only in the render's temp dir.
INTERMEDIATE_X264: tuple = ("-preset", "ultrafast", "-crf", "12")
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


def _normalize_all(ffmpeg: str, spec: RenderSpec, tmpdir: Path, jobs: int,
                   timings: RenderTimings) -> List[Segment]:
    """Every segment → ``seg_NNNN.mp4``, in parallel when ``jobs`` > 1.

    Any failure of the parallel path — a segment, the pool itself — is logged
    and the whole stage is redone one segment at a time with the old encode
    settings: exactly the path this backend always ran. Only a failure there
    raises (and render_dispatch then falls back to MoviePy, as before)."""
    outs = [tmpdir / f"seg_{i:04d}.mp4" for i in range(len(spec.segments))]

    def task(i: int, x264: Sequence[str]) -> Callable[[], None]:
        seg = spec.segments[i]
        return lambda: _normalize_segment(ffmpeg, seg, outs[i], spec.width, spec.height,
                                          spec.fps, seed=f"{i}:{seg.path}", x264=x264)

    t0 = time.monotonic()
    try:
        tasks = [task(i, INTERMEDIATE_X264) for i in range(len(outs))]
        if jobs > 1:
            timings.segment_s = run_pool(tasks, jobs)
        else:
            timings.segment_s = _run_sequential(tasks)
        timings.mode, timings.jobs = ("parallel" if jobs > 1 else "sequential"), jobs
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


def render(spec: RenderSpec, *, ffmpeg: Optional[str] = None, workdir: Optional[str] = None,
           jobs: Optional[int] = None, timings: Optional[RenderTimings] = None) -> str:
    """Render `spec` to `spec.output_path` via ffmpeg and return that path.

    Normalises every segment (``jobs`` at once; default ``render_jobs``),
    concatenates them, muxes `audio_path`, and burns `subtitle_path` when set.
    Raises RenderBackendError on an invalid spec or an ffmpeg failure — never a
    silent empty file. ``timings`` (optional) is filled in; the same numbers are
    logged as one ``ffmpeg render timing:`` line.
    """
    problems = validate(spec)
    if problems:
        raise RenderBackendError("invalid render spec: " + "; ".join(problems))

    ffmpeg = ffmpeg or resolve_ffmpeg()
    Path(spec.output_path).parent.mkdir(parents=True, exist_ok=True)
    timings = timings if timings is not None else RenderTimings()
    timings.segments = len(spec.segments)
    jobs = render_jobs(len(spec.segments)) if jobs is None else max(1, int(jobs))
    t_start = time.monotonic()

    tmp_ctx = tempfile.TemporaryDirectory(dir=workdir) if workdir else tempfile.TemporaryDirectory()
    with tmp_ctx as tmp:
        tmpdir = Path(tmp)
        normalized = _normalize_all(ffmpeg, spec, tmpdir, jobs, timings)

        norm_spec = replace(spec, segments=normalized)
        concat_path = tmpdir / "concat.txt"
        concat_path.write_text("\n".join(concat_list_lines(norm_spec)) + "\n", encoding="utf-8")

        cmd = build_ffmpeg_command(norm_spec, str(concat_path))
        cmd[0] = ffmpeg  # the builder emits a literal "ffmpeg"; use the resolved binary
        t0 = time.monotonic()
        _run(cmd)
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
