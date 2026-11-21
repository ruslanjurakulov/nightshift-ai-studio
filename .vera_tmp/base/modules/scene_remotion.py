"""Remotion as a scene-level backend (roadmap PR 3.2 wiring).

``modules/scene_render.py`` renders a Video IR project scene by scene; this
module is the adapter that lets one of those scenes be rendered by the Remotion
project in ``video-engine/`` (via :func:`modules.remotion_renderer.render_scene`)
instead of ffmpeg:

    job (frame window) → IR scene dict re-timed to that exact window
                       → remotion_renderer.render_scene(...)   (a raw .mp4)
                       → frame count must equal the window, exactly
                       → re-encoded like an ffmpeg scene clip (silent H.264,
                         width×height, fps, -frames:v N) so the concat in
                         scene_render.assemble sees uniform pieces

Timing
------
The audio is the master clock. scene_render gives every scene a frame-snapped
window (``start_frame``..``end_frame``) that tiles the narration with no gaps;
the IR's own ``start_s``/``end_s`` can be a fraction of a frame off it (and the
first scene's window starts at 0). So the scene handed to Remotion carries
``start_s = start_frame / fps`` and ``end_s = end_frame / fps``: the engine's
``calculateMetadata`` then yields exactly ``end_frame - start_frame`` frames.
The output is counted anyway; any other count is a failure (never padded or
trimmed into place), and the caller falls back to ffmpeg for that scene.

Availability
------------
:func:`available` is true only when ``CHRONOS_REMOTION`` is on (default off),
Node/npx are on PATH and ``video-engine`` has its dependencies installed. It
never installs anything.

One bundle per run
------------------
``remotion render src/index.ts`` re-bundles the whole project (webpack + a copy
of the public dir) for every scene. :func:`prepare_bundle` stages the assets of
every Remotion scene about to be rendered into ONE public dir
(``<public>/sceneNNN/assetNN.ext``), runs ``remotion bundle`` once (the public
dir is baked into the bundle, so it must be complete first) and returns a
:class:`RemotionBundle`; :func:`render_scene` with ``bundle=`` then renders
from that directory. scene_render does this once per ``render_project`` run and
removes the bundle afterwards (:meth:`RemotionBundle.close`). When bundling
fails, :func:`prepare_bundle` returns None and every scene takes the
per-scene path above — nothing else changes (and a failed scene still falls
back to ffmpeg).

Failures
--------
:func:`render_scene` raises :class:`SceneRemotionError` on any failure — it is
only ever called by scene_render, which catches it and renders the scene with
ffmpeg (the recipe's fallback). It writes nothing at ``out_path`` unless the
whole scene succeeded; intermediate files live in a temporary directory.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

_FRAME_RE = re.compile(r"frame=\s*(\d+)")
_PROBE_TIMEOUT_S = 300


class SceneRemotionError(RuntimeError):
    """This scene could not be rendered with Remotion (the caller falls back)."""


def available() -> bool:
    """True when a scene may be sent to Remotion: ``CHRONOS_REMOTION`` is on,
    ``node``/``npx`` are on PATH and ``video-engine/node_modules`` has Remotion
    and its CLI. Never raises."""
    try:
        from modules import remotion_renderer as rr

        if not rr.enabled():
            return False
        if not (shutil.which("node") and shutil.which("npx")):
            return False
        mods = rr.ENGINE_DIR / "node_modules"
        return ((mods / "remotion").is_dir() and (mods / "@remotion" / "cli").is_dir()
                and (rr.ENGINE_DIR / rr.ENTRY_POINT).is_file())
    except Exception:  # noqa: BLE001 — availability is a yes/no, never an error
        return False


def count_frames(ffmpeg: str, path) -> Optional[int]:
    """Decoded video frames in ``path``, or None when it cannot be read.
    Unknown is never 0."""
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", str(path), "-map", "0:v:0", "-vf", "null",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=_PROBE_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    hits = _FRAME_RE.findall(proc.stderr or "")
    return int(hits[-1]) if hits else None


def scene_dict_for_window(scene, start_frame: int, end_frame: int, fps: int) -> dict:
    """The IR scene as a dict, re-timed to its frame window on the project clock."""
    d = scene.to_dict()
    d["start_s"] = start_frame / float(fps)
    d["end_s"] = end_frame / float(fps)
    return d


def _stage_assets(assets: List, public_dir: Path, subdir: str = "") -> List[dict]:
    """Expose the scene's asset files inside ``public_dir`` (Remotion's
    --public-dir, which it copies into its bundle — so never a whole output
    tree), under ``subdir`` when given. Hard link when possible, else copy.
    Returns ``[{id,kind,path}]`` with paths relative to ``public_dir``."""
    target = public_dir / subdir if subdir else public_dir
    target.mkdir(parents=True, exist_ok=True)
    out = []
    for i, a in enumerate(assets):
        src = Path(a.path)
        name = f"asset{i:02d}{src.suffix.lower()}"
        dst = target / name
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
        out.append({"id": a.id, "kind": a.kind, "path": f"{subdir}/{name}" if subdir else name})
    return out


class RemotionBundle:
    """One prebuilt Remotion bundle shared by the scenes of a run: the bundle
    directory, the public dir baked into it and each scene's staged assets.
    :meth:`close` removes all of it (idempotent, never raises)."""

    def __init__(self, root: Path, serve_dir: Path, public_dir: Path, assets: Dict[str, List[dict]]):
        self.root = Path(root)
        self.serve_dir = Path(serve_dir)
        self.public_dir = Path(public_dir)
        self.assets = dict(assets)

    def covers(self, scene_id: str) -> bool:
        """True when ``scene_id``'s assets were staged before bundling (only
        those scenes can render from this bundle)."""
        return scene_id in self.assets

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self) -> "RemotionBundle":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def prepare_bundle(jobs: Iterable, project, *,
                   bundler: Optional[Callable] = None) -> Optional[RemotionBundle]:
    """Stage the assets of every job in ``jobs`` (the Remotion scenes about to
    be rendered) into one public dir and bundle the engine once. Returns a
    :class:`RemotionBundle` (the caller closes it), or None when there is
    nothing to bundle or bundling failed — then scenes render per scene as
    before. Never raises. ``bundler(out_dir, public_dir=...) -> Optional[Path]``
    is injectable for tests (default ``remotion_renderer.bundle``)."""
    root = None
    try:
        from modules import remotion_renderer, scene_render

        jobs = [j for j in jobs if project.scene(j.scene_id) is not None]
        if not jobs:
            return None
        root = Path(tempfile.mkdtemp(prefix="remotion-bundle-"))
        public = root / "public"
        public.mkdir()
        staged: Dict[str, List[dict]] = {}
        for i, job in enumerate(jobs):
            if job.scene_id in staged:
                continue
            scene = project.scene(job.scene_id)
            try:
                staged[job.scene_id] = _stage_assets(scene_render._usable_assets(project, scene),
                                                     public, f"scene{i:03d}")
            except OSError as exc:
                # This scene takes the per-scene path (and its own error there).
                logger.warning("remotion: could not stage assets of scene %s for the bundle (%s)",
                               job.scene_id, type(exc).__name__)
        if not staged:
            shutil.rmtree(root, ignore_errors=True)
            return None
        t0 = time.monotonic()
        serve = (bundler or remotion_renderer.bundle)(root / "bundle", public_dir=public)
        if serve is None or not remotion_renderer.is_bundle(serve):
            logger.warning("remotion: could not bundle the engine once; rendering %d scene(s) "
                           "one by one", len(staged))
            shutil.rmtree(root, ignore_errors=True)
            return None
        logger.info("remotion: bundled once in %.1fs for %d scene(s)",
                    time.monotonic() - t0, len(staged))
        return RemotionBundle(root, Path(serve), public, staged)
    except Exception as exc:  # noqa: BLE001 — no bundle just means per-scene renders
        logger.warning("remotion: bundle preparation failed (%s); rendering scenes one by one",
                       type(exc).__name__)
        if root is not None:
            shutil.rmtree(root, ignore_errors=True)
        return None


def render_scene(job, project, out_path, *, ffmpeg: Optional[str] = None,
                 remotion_render: Optional[Callable] = None,
                 bundle: Optional[RemotionBundle] = None) -> Path:
    """Render ``job`` (a ``scene_render.SceneJob``) with Remotion to
    ``out_path``: a silent H.264 clip of exactly the job's frame count at the
    project's width/height/fps. Raises SceneRemotionError on any failure.
    With a ``bundle`` that covers this scene, it renders from that prebuilt
    bundle (its assets are already inside); otherwise it stages the assets
    and lets Remotion bundle for this scene alone. ``remotion_render`` is
    injectable for tests (default ``remotion_renderer.render_scene``)."""
    from modules import remotion_renderer, render_backend, scene_render

    scene = project.scene(job.scene_id)
    if scene is None:
        raise SceneRemotionError(f"scene {job.scene_id} is not in the project")
    fps = int(project.fps)
    w, h = int(project.width), int(project.height)
    frames = int(job.end_frame) - int(job.start_frame)
    if frames <= 0:
        raise SceneRemotionError(f"scene {job.scene_id} has an empty window")
    ffmpeg = ffmpeg or render_backend.resolve_ffmpeg()
    render = remotion_render or remotion_renderer.render_scene
    out_path = Path(out_path)

    with tempfile.TemporaryDirectory(prefix="scene-remotion-") as tmp:
        if bundle is not None and bundle.covers(job.scene_id):
            context = {"width": w, "height": h, "fps": fps,
                       "assets_base_dir": str(bundle.public_dir),
                       "assets": [dict(a) for a in bundle.assets[job.scene_id]],
                       "serve_url": str(bundle.serve_dir)}
        else:
            public = Path(tmp) / "public"
            public.mkdir()
            try:
                assets = _stage_assets(scene_render._usable_assets(project, scene), public)
            except OSError as exc:
                raise SceneRemotionError(f"scene {job.scene_id}: could not stage assets "
                                         f"({type(exc).__name__})") from None
            context = {"width": w, "height": h, "fps": fps,
                       "assets_base_dir": str(public), "assets": assets}
        # claims / map / lower_third from scene_graphics.json (graphic_recipes).
        context.update(getattr(job, "graphics", None) or {})
        raw = Path(tmp) / "remotion.mp4"
        got = render(scene_dict_for_window(scene, job.start_frame, job.end_frame, fps), context, raw)
        if got is None or not Path(got).is_file() or Path(got).stat().st_size == 0:
            raise SceneRemotionError(f"scene {job.scene_id}: Remotion produced no video")
        n = count_frames(ffmpeg, got)
        if n != frames:
            raise SceneRemotionError(f"scene {job.scene_id}: Remotion rendered {n} frame(s), "
                                     f"the window needs {frames}")
        # Same encode as scene_render's ffmpeg clips, so the concat is uniform.
        render_backend._run([
            ffmpeg, "-y", "-i", str(got), "-vf", render_backend._scale_pad(w, h, fps),
            "-frames:v", str(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-an", str(out_path)])
    n = count_frames(ffmpeg, out_path)
    if n != frames:
        raise SceneRemotionError(f"scene {job.scene_id}: normalised clip has {n} frame(s), "
                                 f"expected {frames}")
    return out_path
