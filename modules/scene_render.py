"""Scene-level render + render cache (roadmap Y3 / PR 1.3).

Until now a video was rendered in one pass: any change — one bad clip, one
re-generated scene — re-rendered the whole thing. This module renders a Video
IR project (``modules/video_ir.py``) **scene by scene**, caches each scene's
``.mp4`` under a content key, and assembles the final video from the pieces:

    for each scene:  key = hash(what decides its pixels)
                     output/<slug>/scenes/<scene_id>-<key>.mp4 exists? → reuse
                     else → render it (ffmpeg today)
    concat the scene files + mux the narration + burn the subtitles

So re-running after one scene changed re-renders only that scene (the log says
which were hits and which were misses) and re-encodes the final assembly.

Timing
------
Audio is the master clock. Each scene occupies its IR ``start_s``/``end_s``
window, snapped to the frame grid (so per-scene rounding never accumulates into
drift). The first scene starts at 0 and each scene extends to the next scene's
start, the last one to the end of the narration — so a leading silence, a gap
between sections or a tail is covered by the adjacent scene, never dropped, and
the assembled picture is as long as the narration. A scene without measured
times (``null``) cannot be placed: the whole scene render is refused
(:class:`SceneRenderError`) and the caller falls back to the one-pass renderer.

What decides a scene's key
--------------------------
``narration`` · each asset's id **and** content identity (``sha256`` when the IR
has it, else path + size + mtime) · ``shot.recipe`` (as the backend executes it)
· the frame-snapped duration · ``width``/``height``/``fps`` · the cut interval ·
``style`` · the backend that renders it · :data:`CACHE_VERSION` (bumped when
the rendering itself changes).
Change any of these and the scene is a miss; change none and it is a hit.

Backends per scene
------------------
:func:`choose_backend` decides who renders a scene; :data:`SCENE_RENDERERS`
maps a backend name to its renderer: ffmpeg, and Remotion
(``modules/scene_remotion.py`` around ``remotion_renderer.render_scene``).
Remotion is only *available* when ``CHRONOS_REMOTION=1`` and the engine is
installed (:func:`available_backends`); then the recipes that prefer it
(graphic cards, ``map_zoom``, ``parallax``, ``archival_reveal``) go to it and
everything else stays on ffmpeg. Its clips are frame-exact to the scene window
and re-encoded like ffmpeg's, so the assembly is unchanged.

Per-scene fallback: when Remotion fails for a scene, that scene is rendered
with ffmpeg as the recipe's ``fallback`` (its own cache entry, keyed with
backend ``ffmpeg``) and the run goes on; which backend rendered each scene,
and which scenes fell back, is in the render metadata. The key a scene is
cached under always names the backend and the recipe that actually rendered
it, so a clip from one backend is never reused for the other.

Safety
------
Nothing here is on by default: ``render_dispatch`` only calls it when
``CHRONOS_SCENE_RENDER=1``, and any exception it raises there falls back to the
existing renderer. Files are written to a temporary name and renamed into place
only after ffmpeg succeeded, so a killed render never leaves a half-written
scene that a later run would mistake for a cache hit.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional

from modules.render_spec import KIND_COLOR, KIND_IMAGE, KIND_VIDEO, RenderSpec, Segment

logger = logging.getLogger(__name__)

#: Bump when the way a scene is rendered changes, so old cache entries miss.
CACHE_VERSION = 1
SCENES_DIRNAME = "scenes"
FLAG_ENV = "CHRONOS_SCENE_RENDER"
_TRUTHY = ("1", "true", "yes", "on")

BACKEND_FFMPEG = "ffmpeg"
BACKEND_REMOTION = "remotion"

DEFAULT_CUT_S = 5.0
_MIN_SEGMENT_S = 0.1
_VIDEO_SUFFIXES = (".mp4", ".mov", ".avi", ".webm", ".mkv")


class SceneRenderError(RuntimeError):
    """The project cannot be rendered scene by scene (the caller falls back)."""


def is_enabled(value: Optional[str] = None) -> bool:
    """True only when ``CHRONOS_SCENE_RENDER`` is truthy. Default off."""
    if value is None:
        value = os.environ.get(FLAG_ENV, "")
    return str(value or "").strip().lower() in _TRUTHY


# ── backend per scene (extension point) ─────────────────────────────────────

def choose_backend(scene, available: Iterable[str] = (BACKEND_FFMPEG,)) -> str:
    """Which backend renders ``scene``.

    The recipe's catalogue entry (``modules/shot_recipes.py``) names the
    backends designed to execute it, preferred first; the first one that is
    ``available`` AND has a renderer in :data:`SCENE_RENDERERS` wins, else
    ffmpeg. With the defaults (only ffmpeg available) every scene — including
    graphic recipes like ``quote_card`` — renders with ffmpeg; when
    :func:`available_backends` includes Remotion (``CHRONOS_REMOTION=1`` and
    an installed engine) the recipes that prefer it route to it.
    """
    have = {str(b).strip().lower() for b in (available or ())}
    try:
        from modules import shot_recipes

        recipe = shot_recipes.get(getattr(getattr(scene, "shot", None), "recipe", None))
    except Exception:
        recipe = None
    if recipe is not None:
        for backend in recipe.backends:
            if backend in have and backend in SCENE_RENDERERS:
                return backend
    return BACKEND_FFMPEG


# ── scene windows, segments and keys ────────────────────────────────────────

@dataclass(frozen=True)
class SceneJob:
    """One scene, resolved: its frame-snapped window, the segments that fill
    it, its cache key and where its file lives."""
    scene_id: str
    index: int
    start_frame: int
    end_frame: int
    fps: int
    segments: tuple
    backend: str
    key: str
    path: Path
    #: For a non-ffmpeg job: the same scene on ffmpeg with the recipe's
    #: fallback (its own key/path) — rendered when this job's backend fails.
    fallback: Optional["SceneJob"] = None
    #: Remotion props sources for this scene (``claims``/``map``/``lower_third``
    #: from graphic_recipes' ``scene_graphics.json``); None for ffmpeg jobs.
    graphics: Optional[dict] = None

    @property
    def duration_s(self) -> float:
        return (self.end_frame - self.start_frame) / float(self.fps)


def _frame(t: float, fps: int) -> int:
    return int(round(float(t) * fps))


def scene_windows(project) -> List[tuple]:
    """``[(scene, start_frame, end_frame), ...]`` covering 0 → end of narration
    with no gaps. Raises SceneRenderError when a scene has no measured times or
    a window would be empty."""
    fps = int(project.fps)
    scenes = sorted(project.scenes, key=lambda s: s.index)
    if not scenes:
        raise SceneRenderError("project has no scenes")
    for s in scenes:
        if s.start_s is None or s.end_s is None:
            raise SceneRenderError(f"scene {s.id} has no measured start/end")
    end_s = max(s.end_s for s in scenes)
    if project.audio.duration_s is not None:
        end_s = max(end_s, float(project.audio.duration_s))
    out = []
    for i, s in enumerate(scenes):
        start = 0 if i == 0 else _frame(s.start_s, fps)
        end = _frame(scenes[i + 1].start_s, fps) if i + 1 < len(scenes) else _frame(end_s, fps)
        if end <= start:
            raise SceneRenderError(f"scene {s.id} has an empty window ({start}..{end} frames)")
        out.append((s, start, end))
    return out


def _kind_for(path: str) -> str:
    return KIND_VIDEO if Path(path).suffix.lower() in _VIDEO_SUFFIXES else KIND_IMAGE


def _usable_assets(project, scene) -> List:
    """The scene's assets that exist on disk, in IR order."""
    out = []
    for aid in scene.asset_ids:
        a = project.asset(aid)
        if a is None or not a.path or a.kind == "audio":
            continue
        if Path(a.path).is_file():
            out.append(a)
        else:
            logger.warning("Scene %s: asset %s is missing on disk — skipped", scene.id, aid)
    return out


def scene_segments(assets: List, frames: int, fps: int, cut_s: float) -> List[Segment]:
    """Fill ``frames`` frames with cuts of ``cut_s`` seconds cycling through
    ``assets`` (the IR already ordered them by relevance). Worked in whole
    frames so the cuts add up to the scene window exactly. No usable asset →
    one colour placeholder, never an empty scene. A final sliver shorter than
    0.1 s is folded into the previous cut."""
    if cut_s is None or not (cut_s > 0):
        cut_s = DEFAULT_CUT_S
    frames, fps = int(frames), int(fps)
    if not assets:
        return [Segment(duration=round(frames / fps, 6), path=None, kind=KIND_COLOR)]
    cut_f = max(1, int(round(cut_s * fps)))
    sliver_f = max(1, int(round(_MIN_SEGMENT_S * fps)))
    counts: List[int] = []
    left = frames
    while left > 0:
        n = min(cut_f, left)
        if n < sliver_f and counts:
            counts[-1] += n
        else:
            counts.append(n)
        left -= n
    segs = []
    for i, n in enumerate(counts):
        a = assets[i % len(assets)]
        segs.append(Segment(duration=round(n / fps, 6), path=str(a.path), kind=_kind_for(a.path)))
    return segs


def segment_frames(seg: Segment, fps: int) -> int:
    """The whole number of frames a segment built by scene_segments spans."""
    return max(1, int(round(seg.duration * fps)))


def _content_id(asset) -> str:
    """What identifies an asset's content: its sha256 when known, else its
    path + size + mtime (so a file replaced in place still invalidates)."""
    if asset.sha256:
        return "sha256:" + asset.sha256
    try:
        st = Path(asset.path).stat()
        return f"file:{asset.path}:{st.st_size}:{st.st_mtime_ns}"
    except OSError:
        return f"file:{asset.path}:missing"


def cache_key(*, narration: str, assets: List, recipe: Optional[str], duration_s: float,
              width: int, height: int, fps: int, cut_s: float, style: Optional[str],
              backend: str, graphics: Optional[Mapping] = None) -> str:
    """A short, stable hash of everything that decides a scene's pixels.
    ``graphics`` (Remotion props data) joins the key only when present, so
    keys without it are unchanged."""
    payload = {
        "v": CACHE_VERSION,
        "narration": narration or "",
        "assets": [[a.id, _content_id(a)] for a in assets],
        "recipe": recipe,
        "duration_s": round(float(duration_s), 3),
        "size": [int(width), int(height)],
        "fps": int(fps),
        "cut_s": round(float(cut_s), 3),
        "style": style,
        "backend": backend,
    }
    if graphics:
        payload["graphics"] = graphics
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _executed_recipe(recipe: Optional[str], backend: str) -> Optional[str]:
    """The recipe ``backend`` actually executes for ``recipe``: itself when the
    backend is designed for it (or it is unknown), else its fallback chain."""
    try:
        from modules import shot_recipes

        r = shot_recipes.get(recipe)
        if r is None or backend in r.backends:
            return recipe
        return shot_recipes.resolve_for_backends(recipe, (backend,))
    except Exception:
        return recipe


def plan_jobs(project, scenes_dir: Path, *, cut_intervals: Optional[Mapping] = None,
              style: Optional[str] = None,
              available: Iterable[str] = (BACKEND_FFMPEG,),
              graphics: Optional[Mapping] = None) -> List[SceneJob]:
    """Resolve every scene into a :class:`SceneJob`. Pure apart from stat-ing
    asset files. ``cut_intervals`` is ``{scene index: seconds}`` (the script
    section's ``cut_interval``); missing → 5 s. ``graphics`` is
    ``{scene_id: scene_graphics.json entry}`` — Remotion jobs carry (and are
    keyed by) their scene's props data; ffmpeg jobs ignore it."""
    from modules import graphic_recipes

    fps = int(project.fps)
    jobs = []
    for scene, start, end in scene_windows(project):
        dur = (end - start) / float(fps)
        cut = (cut_intervals or {}).get(scene.index) or DEFAULT_CUT_S
        try:
            cut = float(cut)
        except (TypeError, ValueError):
            cut = DEFAULT_CUT_S
        assets = _usable_assets(project, scene)
        backend = choose_backend(scene, available)
        segments = tuple(scene_segments(assets, end - start, fps, cut))

        props = graphic_recipes.render_context((graphics or {}).get(scene.id))
        props = props if graphic_recipes.has_props(props) else None

        def job_for(b: str, fallback=None) -> SceneJob:
            data = props if b != BACKEND_FFMPEG else None
            key = cache_key(narration=scene.narration, assets=assets,
                            recipe=_executed_recipe(scene.shot.recipe, b),
                            duration_s=dur, width=project.width, height=project.height, fps=fps,
                            cut_s=cut, style=style, backend=b, graphics=data)
            return SceneJob(scene_id=scene.id, index=scene.index, start_frame=start,
                            end_frame=end, fps=fps, segments=segments, backend=b, key=key,
                            path=Path(scenes_dir) / f"{scene.id}-{key}.mp4", fallback=fallback,
                            graphics=data)

        fallback = job_for(BACKEND_FFMPEG) if backend != BACKEND_FFMPEG else None
        jobs.append(job_for(backend, fallback))
    return jobs


# ── rendering ───────────────────────────────────────────────────────────────

def _valid_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _tmp_path(final: Path) -> Path:
    # Same directory (so the rename is atomic), still an .mp4 for ffmpeg's muxer.
    return final.with_name(f".tmp-{os.getpid()}-{final.name}")


def _concat_lines(paths: List) -> List[str]:
    """A concat-demuxer list of whole files, each played exactly once (unlike
    render_spec.concat_list_lines, which repeats the last file for its
    duration-directive quirk — harmless under ``-shortest`` with audio, but it
    would lengthen a silent scene clip)."""
    return ["file '" + str(p).replace("'", r"'\''") + "'" for p in paths]


def _normalize_cmd(ffmpeg: str, seg: Segment, out: Path, width: int, height: int,
                   fps: int) -> List[str]:
    """One segment → a uniform silent H.264 clip of EXACTLY its frame count
    (``-frames:v``), fitted to width×height at fps — render_backend's
    normalisation, frame-exact."""
    from modules import render_backend

    n = segment_frames(seg, fps)
    dur = f"{n / fps + 1.0 / fps:.6f}"   # input limit with a frame of headroom
    common = ["-frames:v", str(n), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps), "-an"]
    vf = render_backend._scale_pad(width, height, fps)
    if seg.kind == KIND_COLOR or not seg.path:
        return [ffmpeg, "-y", "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={fps}:d={dur}",
                *common, str(out)]
    if seg.kind == KIND_IMAGE:
        return [ffmpeg, "-y", "-loop", "1", "-t", dur, "-i", seg.path, "-vf", vf, *common, str(out)]
    # A source shorter than its slot is looped, as the one-pass renderers do.
    return [ffmpeg, "-y", "-stream_loop", "-1", "-i", seg.path, "-vf", vf, *common, str(out)]


def render_scene_ffmpeg(job: SceneJob, project, out_path: Path, *, ffmpeg: Optional[str] = None) -> Path:
    """Render one scene's segments to a silent H.264 clip of exactly the
    scene's frame count, one ffmpeg process at a time. Raises on failure."""
    from modules import render_backend

    ffmpeg = ffmpeg or render_backend.resolve_ffmpeg()
    out_path = Path(out_path)
    w, h, fps = int(project.width), int(project.height), int(project.fps)
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i, seg in enumerate(job.segments):
            part = Path(tmp) / f"seg_{i:04d}.mp4"
            render_backend._run(_normalize_cmd(ffmpeg, seg, part, w, h, fps))
            parts.append(part)
        if len(parts) == 1:
            shutil.move(str(parts[0]), str(out_path))   # tmp may be another filesystem
        else:
            lst = Path(tmp) / "concat.txt"
            lst.write_text("\n".join(_concat_lines(parts)) + "\n", encoding="utf-8")
            # Identical encodes → stream copy, no second generation loss.
            render_backend._run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                                 "-c", "copy", str(out_path)])
    return out_path


def render_scene_remotion(job: SceneJob, project, out_path: Path) -> Path:
    """Render one scene with Remotion (``modules/scene_remotion.py``); raises
    on failure — render_project then renders the scene with ffmpeg."""
    from modules import scene_remotion

    return scene_remotion.render_scene(job, project, out_path)


#: backend name → ``fn(job, project, out_path) -> Path``. See choose_backend;
#: a registered backend is only used when it is also available.
SCENE_RENDERERS: Dict[str, Callable] = {BACKEND_FFMPEG: render_scene_ffmpeg,
                                        BACKEND_REMOTION: render_scene_remotion}


def available_backends() -> tuple:
    """The backends that can render right now: ffmpeg always; Remotion only
    with ``CHRONOS_REMOTION=1`` and an installed engine (default: ffmpeg only)."""
    from modules import scene_remotion

    if scene_remotion.available():
        return (BACKEND_REMOTION, BACKEND_FFMPEG)
    return (BACKEND_FFMPEG,)


def _render_job(job: SceneJob, project, renderers: Mapping[str, Callable]) -> None:
    render = renderers.get(job.backend) or renderers[BACKEND_FFMPEG]
    job.path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path(job.path)
    try:
        out = Path(render(job, project, tmp))
        if not _valid_file(out):
            raise SceneRenderError(f"scene {job.scene_id}: renderer produced no output")
        os.replace(out, job.path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def assemble(project, jobs: List[SceneJob], output_path: Path, *,
             subtitles_path: Optional[str] = None, ffmpeg: Optional[str] = None) -> Path:
    """Concatenate the scene files, mux the narration and burn the subtitles
    into ``output_path`` (written atomically). Raises on failure."""
    from modules import render_backend

    audio = project.audio.path
    if not audio or not Path(audio).is_file():
        raise SceneRenderError("narration audio is missing — nothing to mux")
    subs = subtitles_path if subtitles_path and Path(subtitles_path).is_file() else None
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_out = _tmp_path(output_path)
    ffmpeg = ffmpeg or render_backend.resolve_ffmpeg()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            lst = Path(tmp) / "scenes.txt"
            lst.write_text("\n".join(_concat_lines([j.path for j in jobs])) + "\n", encoding="utf-8")
            cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-i", str(audio),
                   "-map", "0:v:0", "-map", "1:a:0"]
            if subs:
                cmd += ["-vf", "subtitles='" + subs.replace("'", r"'\''") + "'"]
            cmd += ["-r", str(project.fps), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", str(tmp_out)]
            render_backend._run(cmd)
        if not _valid_file(tmp_out):
            raise SceneRenderError("assembly produced no output")
        os.replace(tmp_out, output_path)
    finally:
        try:
            tmp_out.unlink()
        except OSError:
            pass
    return output_path


@dataclass
class SceneRenderResult:
    video_path: Path
    scenes: int = 0
    cache_hits: List[str] = field(default_factory=list)
    cache_misses: List[str] = field(default_factory=list)
    backends: Dict[str, str] = field(default_factory=dict)
    #: scene id → the backend that failed for it (the scene then used ffmpeg).
    fallbacks: Dict[str, str] = field(default_factory=dict)

    def to_metadata(self) -> dict:
        """Scene ids, backend names and counts only — no paths."""
        return {"scenes": self.scenes, "cache_hits": len(self.cache_hits),
                "cache_misses": len(self.cache_misses),
                "rendered_scene_ids": list(self.cache_misses),
                "scene_backends": sorted(set(self.backends.values())),
                "backend_by_scene": dict(self.backends),
                "fallback_scene_ids": sorted(self.fallbacks)}


def _hit_or_render(job: SceneJob, project, renderers: Mapping[str, Callable],
                   result: SceneRenderResult) -> None:
    if _valid_file(job.path):
        result.cache_hits.append(job.scene_id)
        logger.info("Scene %s: cache hit (%s, %s)", job.scene_id, job.key, job.backend)
        return
    logger.info("Scene %s: cache miss (%s) — rendering %.2fs with %s",
                job.scene_id, job.key, job.duration_s, job.backend)
    _render_job(job, project, renderers)
    result.cache_misses.append(job.scene_id)


def render_project(project, output_path, *, scenes_dir=None,
                   cut_intervals: Optional[Mapping] = None, style: Optional[str] = None,
                   renderers: Optional[Mapping[str, Callable]] = None,
                   assemble_fn: Optional[Callable] = None,
                   graphics: Optional[Mapping] = None) -> SceneRenderResult:
    """Render ``project`` scene by scene (reusing cached scenes) and assemble
    ``output_path``. ``scenes_dir`` defaults to ``<output dir>/scenes``
    (``output/<slug>/scenes`` for the pipeline's ``final_video.mp4``).
    ``renderers``/``assemble_fn`` are injectable for tests. Raises on failure —
    the caller (render_dispatch) owns the fallback."""
    output_path = Path(output_path)
    scenes_dir = Path(scenes_dir) if scenes_dir else output_path.parent / SCENES_DIRNAME
    problems = project.validate()
    if problems:
        raise SceneRenderError("invalid Video IR: " + "; ".join(problems[:3]))
    if renderers is None:
        renderers, available = dict(SCENE_RENDERERS), available_backends()
    else:
        renderers = dict(renderers)
        available = tuple(renderers)
    if graphics is None:
        # graphic_recipes' props sources, next to project.json (output/<slug>/).
        from modules import graphic_recipes
        graphics = graphic_recipes.load_sidecar(scenes_dir.parent / graphic_recipes.SIDECAR_FILENAME)
    jobs = plan_jobs(project, scenes_dir, cut_intervals=cut_intervals, style=style,
                     available=available, graphics=graphics)
    result = SceneRenderResult(video_path=output_path, scenes=len(jobs))
    used = []
    for job in jobs:
        try:
            _hit_or_render(job, project, renderers, result)
        except Exception as e:
            if job.fallback is None:
                raise
            # One scene's Remotion failure never stops the run: this scene
            # renders with ffmpeg (the recipe's fallback), under its own key.
            logger.warning("Scene %s: %s failed (%s) — rendering it with %s instead",
                           job.scene_id, job.backend, f"{type(e).__name__}: {e}"[:300],
                           job.fallback.backend)
            result.fallbacks[job.scene_id] = job.backend
            job = job.fallback
            _hit_or_render(job, project, renderers, result)
        result.backends[job.scene_id] = job.backend
        used.append(job)
    jobs = used
    logger.info("Scene render: %d scene(s), %d cache hit(s), %d rendered %s",
                len(jobs), len(result.cache_hits), len(result.cache_misses), result.cache_misses)
    (assemble_fn or assemble)(project, jobs, output_path, subtitles_path=project.subtitles_path)
    if not _valid_file(output_path):
        raise SceneRenderError(f"no assembled video at {output_path}")
    from modules import scene_cache_gc  # best effort: stale keys/temp files; never raises
    scene_cache_gc.cleanup(scenes_dir, jobs)
    return result
