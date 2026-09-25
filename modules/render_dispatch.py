"""Pick the render backend for a run, and never let the choice break it.

`config.RENDER_BACKEND` (env `CHRONOS_RENDER_BACKEND`) has named two renderers
since roadmap #49, but nothing read it: the MoviePy compositor always ran and
the ffmpeg backend (`modules/render_spec.py` + `modules/render_backend.py`)
never did. This module is the one place that reads it.

* ``"moviepy"`` (the default, and any unknown value) — the existing
  `Compositor.render`, exactly as before.
* ``"ffmpeg"`` — build a `RenderSpec` from the SAME inputs the MoviePy path
  gets (the audio timeline's real section durations, each section's cut
  interval, the b-roll pool ordered by `broll_match`, the narration mix and the
  Whisper `.srt`) and render it with `render_backend.render`. The spec model has
  no Ken Burns motion and no word-level highlighted captions — stills are held,
  and the `.srt` is burnt in line by line — so it is opt-in.

Whatever goes wrong on the ffmpeg path — an exception, an invalid spec, a
missing ffmpeg, a missing or empty output file — is logged as a warning and the
MoviePy compositor renders instead. A run never fails because the operator
chose the experimental backend. The caller learns which backend actually
produced the file (and why a fallback happened), so it can say so in the log
and in the `render.completed` event.

A presenter overlay is MoviePy-only today; a run with a presenter therefore
renders with MoviePy even when ffmpeg was requested, rather than silently
dropping the presenter.

Scene-level render (roadmap PR 1.3, ``modules/scene_render.py``) sits in front
of both, behind its own flag ``CHRONOS_SCENE_RENDER=1`` (default off — with the
flag unset nothing below changes). When on and the run has a Video IR project,
each scene is rendered (or reused from the render cache) and the final video is
assembled from the scene files; ``render_backend`` is then ``"scenes"``. Any
failure — no IR, a scene without measured times, a presenter, an ffmpeg error —
is logged and the configured backend renders exactly as it would have, with
``render_backend_requested="scenes"`` and the reason in
``render_fallback_reason``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Optional

from modules import broll_match
from modules.render_spec import KIND_COLOR, KIND_IMAGE, KIND_VIDEO, RenderSpec, Segment

logger = logging.getLogger(__name__)

BACKEND_MOVIEPY = "moviepy"
BACKEND_FFMPEG = "ffmpeg"
BACKEND_SCENES = "scenes"

_VIDEO_SUFFIXES = (".mp4", ".mov", ".avi", ".webm", ".mkv")
_MIN_SEGMENT_S = 0.1  # the compositor drops slivers shorter than this too


@dataclass(frozen=True)
class RenderResult:
    """Which file was produced, by which backend, and — when the requested
    backend was not the one that rendered — why."""
    video_path: Path
    backend: str
    requested: str
    fallback_reason: Optional[str] = None
    #: Scene-render counts (``SceneRenderResult.to_metadata``) when the scene
    #: path produced the video — scene ids and numbers only, no paths.
    scene_render: Optional[dict] = None

    def to_metadata(self) -> dict:
        meta = {"render_backend": self.backend, "render_backend_requested": self.requested}
        if self.fallback_reason:
            meta["render_fallback_reason"] = self.fallback_reason
        if self.scene_render is not None:
            meta["scene_render"] = self.scene_render
        return meta


def requested_backend(value: Optional[str] = None) -> str:
    """Normalise the configured backend. Anything but "ffmpeg" means MoviePy,
    so a typo in the env var keeps today's renderer rather than failing."""
    if value is None:
        try:
            import config

            value = getattr(config, "RENDER_BACKEND", BACKEND_MOVIEPY)
        except Exception:
            value = BACKEND_MOVIEPY
    v = str(value or "").strip().lower()
    return BACKEND_FFMPEG if v == BACKEND_FFMPEG else BACKEND_MOVIEPY


def _section_pool(
    video_paths: list,
    image_paths: list,
    section_keywords: list,
    clip_terms: Optional[dict],
) -> list:
    """The source order one section's cuts are filled from — the compositor's
    `_ordered_pool`, minus its random shuffle: videos ranked by relevance to the
    section when both signals exist, images after them. Deterministic, so the
    same inputs always describe the same video."""
    videos = [Path(p) for p in (video_paths or [])]
    if section_keywords and clip_terms:
        candidates = [{"path": str(p), "keyword": clip_terms.get(str(p), "")} for p in videos]
        videos = [Path(c["path"]) for c in broll_match.rank_clips(candidates, section_keywords)]
    return videos + [Path(p) for p in (image_paths or [])]


def _kind_for(path: Path) -> str:
    return KIND_VIDEO if path.suffix.lower() in _VIDEO_SUFFIXES else KIND_IMAGE


def build_spec(
    *,
    output_path: Path,
    script,
    audio_path: Path,
    video_paths: list,
    image_paths: list,
    section_timeline: list,
    subtitle_path: Optional[Path] = None,
    clip_terms: Optional[dict] = None,
    width: int = 1920,
    height: int = 1080,
    fps: int = 30,
) -> RenderSpec:
    """A RenderSpec for the same video the MoviePy compositor would build.

    Sections are laid end to end with the durations measured from the real
    narration (`section_timeline`, the audio master clock), each cut every
    `section.cut_interval` seconds from its relevance-ordered pool. Stills are
    only offered to "story" sections (the hook stays on motion footage), as in
    the compositor. With no footage at all a section is filled with colour
    placeholders, never left empty. Pure — touches no disk.
    """
    segments: list = []
    sections = list(getattr(script, "sections", None) or [])
    for i, section in enumerate(sections):
        if i >= len(section_timeline or []):
            break
        entry = section_timeline[i]
        sec_dur = (float(entry["end_ms"]) - float(entry["start_ms"])) / 1000.0
        if sec_dur <= 0:
            continue
        images = image_paths if getattr(section, "section_type", "story") == "story" else []
        pool = _section_pool(video_paths, images, list(getattr(section, "keywords", None) or []),
                             clip_terms)
        try:
            cut = float(getattr(section, "cut_interval", 5.0) or 5.0)
        except (TypeError, ValueError):
            cut = 5.0
        if cut <= 0:
            cut = 5.0

        elapsed = 0.0
        idx = 0
        while elapsed < sec_dur:
            dur = min(cut, sec_dur - elapsed)
            if dur < _MIN_SEGMENT_S:
                # Fold the sliver into the previous cut so the section still
                # spans exactly its measured duration.
                if segments:
                    last = segments[-1]
                    segments[-1] = Segment(duration=round(last.duration + dur, 3),
                                           path=last.path, kind=last.kind)
                break
            if pool:
                src = pool[idx % len(pool)]
                segments.append(Segment(duration=round(dur, 3), path=str(src), kind=_kind_for(src)))
            else:
                segments.append(Segment(duration=round(dur, 3), path=None, kind=KIND_COLOR))
            idx += 1
            elapsed += dur

    return RenderSpec(
        output_path=str(output_path),
        width=width,
        height=height,
        fps=fps,
        segments=segments,
        audio_path=str(audio_path) if audio_path else None,
        subtitle_path=str(subtitle_path) if subtitle_path else None,
    )


def _render_ffmpeg(spec: RenderSpec) -> Path:
    """Run the ffmpeg backend and insist on a real file at the end."""
    from modules import render_backend

    out = Path(render_backend.render(spec))
    if not out.exists() or out.stat().st_size <= 0:
        raise render_backend.RenderBackendError(f"ffmpeg backend produced no output at {out}")
    return out


def _render_scenes(*, ir_project, output_path: Path, script, presenter_path,
                   scene_renderer: Optional[Callable]) -> RenderResult:
    """The scene-level path. Raises on anything that stops it; the caller falls back."""
    from modules import scene_render

    if presenter_path is not None:
        raise RuntimeError("presenter overlay is only supported by the moviepy backend")
    if ir_project is None:
        raise RuntimeError("no Video IR project for this run")
    cut_intervals = {}
    for i, section in enumerate(getattr(script, "sections", None) or []):
        try:
            cut_intervals[i] = float(getattr(section, "cut_interval", None) or 0) or None
        except (TypeError, ValueError):
            cut_intervals[i] = None
    result = (scene_renderer or scene_render.render_project)(
        ir_project, output_path, cut_intervals=cut_intervals)
    out = Path(result.video_path)
    if not out.exists() or out.stat().st_size <= 0:
        raise RuntimeError(f"no output file at {out}")
    logger.info("Render backend used: scenes (%s)", out)
    return RenderResult(out, BACKEND_SCENES, BACKEND_SCENES, scene_render=result.to_metadata())


def render_video(
    *,
    moviepy_render: Callable[[], Path],
    output_path: Path,
    script,
    audio_path: Path,
    video_paths: list,
    image_paths: list,
    section_timeline: list,
    subtitle_path: Optional[Path] = None,
    clip_terms: Optional[dict] = None,
    presenter_path: Optional[Path] = None,
    backend: Optional[str] = None,
    width: int = 1920,
    height: int = 1080,
    fps: int = 30,
    ffmpeg_render: Optional[Callable[[RenderSpec], Path]] = None,
    ir_project=None,
    scene_render_enabled: Optional[bool] = None,
    scene_renderer: Optional[Callable] = None,
) -> RenderResult:
    """Render the video with the configured backend, falling back to MoviePy.

    With ``CHRONOS_SCENE_RENDER=1`` (or ``scene_render_enabled=True``) and an
    ``ir_project``, the scene-level renderer is tried first; on any failure the
    configured backend below renders instead. ``scene_renderer`` is injectable
    for tests (default ``scene_render.render_project``).

    `moviepy_render` is the existing compositor call, deferred; it runs when
    MoviePy was requested, when the ffmpeg path cannot be used, and when it
    fails for any reason. A MoviePy failure is NOT caught here — that is the
    renderer the pipeline has always had, and its errors mean what they always
    meant. `ffmpeg_render` is injectable for tests.
    """
    if scene_render_enabled is None:
        from modules import scene_render

        scene_render_enabled = scene_render.is_enabled()
    if scene_render_enabled:
        try:
            return _render_scenes(ir_project=ir_project, output_path=output_path, script=script,
                                  presenter_path=presenter_path, scene_renderer=scene_renderer)
        except Exception as e:
            scene_reason = f"scenes: {type(e).__name__}: {e}"[:500]
            logger.warning("Scene-level render not used (%s) — rendering with the configured "
                           "backend instead", scene_reason)
        result = _render_configured(
            moviepy_render=moviepy_render, output_path=output_path, script=script,
            audio_path=audio_path, video_paths=video_paths, image_paths=image_paths,
            section_timeline=section_timeline, subtitle_path=subtitle_path,
            clip_terms=clip_terms, presenter_path=presenter_path, backend=backend,
            width=width, height=height, fps=fps, ffmpeg_render=ffmpeg_render)
        reason = "; ".join(r for r in (scene_reason, result.fallback_reason) if r)
        return replace(result, requested=BACKEND_SCENES, fallback_reason=reason[:1000])

    return _render_configured(
        moviepy_render=moviepy_render, output_path=output_path, script=script,
        audio_path=audio_path, video_paths=video_paths, image_paths=image_paths,
        section_timeline=section_timeline, subtitle_path=subtitle_path,
        clip_terms=clip_terms, presenter_path=presenter_path, backend=backend,
        width=width, height=height, fps=fps, ffmpeg_render=ffmpeg_render)


def _render_configured(
    *,
    moviepy_render: Callable[[], Path],
    output_path: Path,
    script,
    audio_path: Path,
    video_paths: list,
    image_paths: list,
    section_timeline: list,
    subtitle_path: Optional[Path],
    clip_terms: Optional[dict],
    presenter_path: Optional[Path],
    backend: Optional[str],
    width: int,
    height: int,
    fps: int,
    ffmpeg_render: Optional[Callable[[RenderSpec], Path]],
) -> RenderResult:
    """The configured one-pass backend (moviepy or ffmpeg), exactly as before."""
    requested = requested_backend(backend)
    if requested != BACKEND_FFMPEG:
        # Returned as the compositor gave it — this path is byte-for-byte
        # today's behaviour.
        path = moviepy_render()
        logger.info("Render backend used: moviepy")
        return RenderResult(path, BACKEND_MOVIEPY, requested)

    reason: Optional[str] = None
    if presenter_path is not None:
        reason = "presenter overlay is only supported by the moviepy backend"
    else:
        try:
            spec = build_spec(
                output_path=output_path, script=script, audio_path=audio_path,
                video_paths=video_paths, image_paths=image_paths,
                section_timeline=section_timeline, subtitle_path=subtitle_path,
                clip_terms=clip_terms, width=width, height=height, fps=fps,
            )
            logger.info("Rendering with the ffmpeg backend: %d segment(s), %.1fs",
                        len(spec.segments), spec.total_duration)
            out = Path((ffmpeg_render or _render_ffmpeg)(spec))
            if not out.exists() or out.stat().st_size <= 0:
                raise RuntimeError(f"no output file at {out}")
            logger.info("Render backend used: ffmpeg (%s)", out)
            return RenderResult(out, BACKEND_FFMPEG, requested)
        except Exception as e:
            reason = f"{type(e).__name__}: {e}"[:500]

    logger.warning("ffmpeg render backend not used (%s) — falling back to the moviepy compositor",
                   reason)
    path = moviepy_render()
    logger.info("Render backend used: moviepy (fallback from ffmpeg)")
    return RenderResult(path, BACKEND_MOVIEPY, requested, fallback_reason=reason)
