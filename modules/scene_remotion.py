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
from pathlib import Path
from typing import Callable, List, Optional

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


def _stage_assets(assets: List, public_dir: Path) -> List[dict]:
    """Expose the scene's asset files inside ``public_dir`` (Remotion's
    --public-dir, which it copies into its bundle — so never a whole output
    tree). Hard link when possible, else copy. Returns ``[{id,kind,path}]``
    with paths relative to ``public_dir``."""
    out = []
    for i, a in enumerate(assets):
        src = Path(a.path)
        name = f"asset{i:02d}{src.suffix.lower()}"
        dst = public_dir / name
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
        out.append({"id": a.id, "kind": a.kind, "path": name})
    return out


def render_scene(job, project, out_path, *, ffmpeg: Optional[str] = None,
                 remotion_render: Optional[Callable] = None) -> Path:
    """Render ``job`` (a ``scene_render.SceneJob``) with Remotion to
    ``out_path``: a silent H.264 clip of exactly the job's frame count at the
    project's width/height/fps. Raises SceneRemotionError on any failure.
    ``remotion_render`` is injectable for tests (default
    ``remotion_renderer.render_scene``)."""
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
        public = Path(tmp) / "public"
        public.mkdir()
        try:
            assets = _stage_assets(scene_render._usable_assets(project, scene), public)
        except OSError as exc:
            raise SceneRemotionError(f"scene {job.scene_id}: could not stage assets "
                                     f"({type(exc).__name__})") from None
        context = {"width": w, "height": h, "fps": fps,
                   "assets_base_dir": str(public), "assets": assets}
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
