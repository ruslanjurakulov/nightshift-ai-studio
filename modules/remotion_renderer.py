"""Remotion scene renderer — the third render backend (roadmap Y5 / PR 3.2).

Renders ONE Video IR scene to an ``.mp4`` with the Remotion project in
``video-engine/`` (composition ``Scene``). Meant for motion-graphics scenes
(title/chapter/quote cards, stat counters, parallax, archival reveals); b-roll
stays on the ffmpeg backend.

Contract
--------
``render_scene(scene_dict, context, out_path) -> Optional[Path]``

* ``scene_dict`` — one IR scene (``modules/video_ir.py`` shape: ``id``,
  ``index``, ``name``, ``type``, ``narration``, ``start_s``, ``end_s``,
  ``shot{recipe,…}``, ``asset_ids``…).
* ``context`` — render context: ``width``, ``height``, ``fps``,
  ``assets_base_dir`` (served as Remotion's ``--public-dir``; asset paths are
  made relative to it), and optionally ``style`` (a
  ``style_presets.StyleBible`` or its dict), ``words`` (``[{text,start_s,end_s}]``
  on the project clock — trimmed to the scene here), ``assets``
  (``[{id,kind,path}]``), ``transition``, ``claims`` (``[{id,text,status}]``
  — ``claim_scenes.annotate_scenes`` rows, for ``evidence_card``; filtered to
  the scene's ``claim_ids``), ``map`` (``{focus:{x,y}, label}`` for
  ``map_zoom``) and ``lower_third`` (``{name, label}``).

Safety
------
* **Off by default.** Nothing runs unless ``CHRONOS_REMOTION=1``.
* **Never raises.** Every failure (flag off, unknown timing, no Node, engine not
  installed, timeout, non-zero exit, empty output) logs a warning and returns
  None, so the caller falls back to another backend.
* **Timeout-guarded** (``CHRONOS_REMOTION_TIMEOUT`` seconds, default 600) and
  ``--concurrency=1`` (GitHub Actions: 2 CPUs, exit-143 history).
* **No install at run time.** ``video-engine/node_modules`` must already exist
  (``npm ci`` in the workflow); this module never runs npm install.
* **Browser.** ``CHRONOS_REMOTION_BROWSER`` may point at a local
  Chrome/Chromium (headless shell) binary; otherwise Remotion uses its own.

Not wired into ``main.py`` yet: that lands with the IR scene-render path.
"""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, List, Mapping, Optional

logger = logging.getLogger(__name__)

ENGINE_DIR = Path(__file__).resolve().parent.parent / "video-engine"
ENTRY_POINT = "src/index.ts"
COMPOSITION_ID = "Scene"
DEFAULT_TIMEOUT_S = 600.0
_TRUTHY = ("1", "true", "yes", "on")
# How much of the tool's stderr goes into a warning (it can be long).
_STDERR_TAIL = 800


def enabled() -> bool:
    """True only when ``CHRONOS_REMOTION`` is set to a truthy value."""
    return os.environ.get("CHRONOS_REMOTION", "").strip().lower() in _TRUTHY


def _timeout_s() -> float:
    raw = os.environ.get("CHRONOS_REMOTION_TIMEOUT", "").strip()
    try:
        value = float(raw) if raw else DEFAULT_TIMEOUT_S
    except ValueError:
        return DEFAULT_TIMEOUT_S
    return value if value > 0 else DEFAULT_TIMEOUT_S


def _browser_executable() -> Optional[str]:
    """The configured Chromium binary, when set and present on disk."""
    raw = os.environ.get("CHRONOS_REMOTION_BROWSER", "").strip()
    if not raw:
        return None
    if not Path(raw).is_file():
        logger.warning("remotion: CHRONOS_REMOTION_BROWSER does not point at a file; using Remotion's own browser")
        return None
    return raw


def _engine_installed() -> bool:
    """True when ``npm ci`` has run in ``video-engine/``."""
    return (ENGINE_DIR / "node_modules" / "remotion").is_dir()


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def scene_duration_s(scene: Mapping) -> Optional[float]:
    """``end_s - start_s``; None when either is unknown or the span is not
    positive. Unknown is never treated as 0."""
    start, end = _num(scene.get("start_s")), _num(scene.get("end_s"))
    if start is None or end is None:
        return None
    d = end - start
    return d if d > 0 else None


def _style_dict(style: Any) -> Optional[dict]:
    if style is None:
        return None
    if isinstance(style, Mapping):
        return dict(style)
    to_dict = getattr(style, "to_dict", None)
    if callable(to_dict):
        try:
            d = to_dict()
            return d if isinstance(d, dict) else None
        except Exception:  # noqa: BLE001
            return None
    return None


def _scene_words(words: Any, start: float, end: float) -> List[dict]:
    """Words overlapping [start, end), well-formed ones only."""
    out: List[dict] = []
    for w in words or ():
        if not isinstance(w, Mapping):
            continue
        ws, we = _num(w.get("start_s")), _num(w.get("end_s"))
        text = w.get("text")
        if ws is None or we is None or not isinstance(text, str) or not text.strip():
            continue
        if we > start and ws < end:
            out.append({"text": text.strip(), "start_s": ws, "end_s": we})
    return out


def _scene_assets(assets: Any, base: Optional[Path]) -> List[dict]:
    """Assets with a path usable by ``staticFile``: relative to ``base``. An
    absolute path outside ``base`` (or with no base) is dropped, not guessed."""
    out: List[dict] = []
    for a in assets or ():
        if not isinstance(a, Mapping):
            continue
        path = a.get("path")
        if not isinstance(path, str) or not path.strip():
            continue
        p = Path(path)
        if p.is_absolute():
            if base is None:
                logger.warning("remotion: asset %s has an absolute path and no assets_base_dir; skipped", a.get("id"))
                continue
            try:
                rel = p.resolve().relative_to(base.resolve())
            except ValueError:
                logger.warning("remotion: asset %s is outside assets_base_dir; skipped", a.get("id"))
                continue
            path = rel.as_posix()
        elif ".." in p.parts:
            logger.warning("remotion: asset %s path escapes assets_base_dir; skipped", a.get("id"))
            continue
        out.append({"id": str(a.get("id") or ""), "kind": str(a.get("kind") or ""), "path": path})
    return out


def _scene_claims(claims: Any, scene: Mapping) -> Optional[List[dict]]:
    """The scene's claims for ``evidence_card``: the context's ``claims`` (else
    the scene's own ``claims``), limited to ``scene.claim_ids`` when it lists
    any. The status is passed through as given — a missing one stays missing
    (the card shows it as unknown), never defaulted to a verdict. None when
    no claims were supplied at all."""
    source = claims if claims is not None else scene.get("claims")
    if not isinstance(source, (list, tuple)):
        return None
    ids = {str(i) for i in (scene.get("claim_ids") or ()) if i is not None}
    out: List[dict] = []
    for c in source:
        if not isinstance(c, Mapping):
            continue
        text = c.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        cid = c.get("id")
        if ids and (cid is None or str(cid) not in ids):
            continue
        status = c.get("status")
        out.append({
            "id": str(cid) if cid is not None else None,
            "text": text.strip(),
            "status": status if isinstance(status, str) else None,
        })
    return out


def _map_spec(spec: Any) -> Optional[dict]:
    """``{focus:{x,y}|None, label|None}``; a focus needs two finite numbers
    (a pin is never placed at a guessed point)."""
    if not isinstance(spec, Mapping):
        return None
    focus = spec.get("focus")
    fx = fy = None
    if isinstance(focus, Mapping):
        fx, fy = _num(focus.get("x")), _num(focus.get("y"))
    ok = fx is not None and fy is not None and math.isfinite(fx) and math.isfinite(fy)
    label = spec.get("label")
    return {
        "focus": {"x": fx, "y": fy} if ok else None,
        "label": label.strip() if isinstance(label, str) and label.strip() else None,
    }


def _lower_third(spec: Any) -> Optional[dict]:
    if not isinstance(spec, Mapping):
        return None
    name = spec.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    label = spec.get("label")
    return {"name": name.strip(), "label": label.strip() if isinstance(label, str) and label.strip() else None}


def build_props(scene: Mapping, context: Mapping) -> dict:
    """The ``--props`` payload for the ``Scene`` composition (see
    ``video-engine/src/types.ts``). Pure."""
    ctx = context or {}
    base_raw = ctx.get("assets_base_dir") or ctx.get("assetsBaseDir")
    base = Path(base_raw) if isinstance(base_raw, (str, os.PathLike)) and str(base_raw) else None
    start = _num(scene.get("start_s"))
    end = _num(scene.get("end_s"))
    props: dict = {
        "scene": dict(scene),
        "width": int(_num(ctx.get("width")) or 1920),
        "height": int(_num(ctx.get("height")) or 1080),
        "fps": _num(ctx.get("fps")) or 30,
        "assetsBaseDir": str(base) if base else "",
        "style": _style_dict(ctx.get("style")),
        "words": _scene_words(ctx.get("words"), start, end) if start is not None and end is not None else [],
        "assets": _scene_assets(ctx.get("assets"), base),
        "transition": ctx.get("transition") if isinstance(ctx.get("transition"), str) else None,
        "claims": _scene_claims(ctx.get("claims"), scene),
        "map": _map_spec(ctx.get("map")),
        "lowerThird": _lower_third(ctx.get("lower_third")),
    }
    return props


def build_command(
    npx: str,
    props_path: Path,
    out_path: Path,
    *,
    public_dir: Optional[Path] = None,
    browser: Optional[str] = None,
) -> List[str]:
    """The ``npx remotion render`` argument list (runs nothing)."""
    cmd = [
        npx, "--no-install", "remotion", "render", ENTRY_POINT, COMPOSITION_ID, str(out_path),
        f"--props={props_path}",
        "--concurrency=1",
        "--overwrite",
        "--log=error",
    ]
    if public_dir is not None:
        cmd.append(f"--public-dir={public_dir}")
    if browser:
        cmd.append(f"--browser-executable={browser}")
    return cmd


def render_scene(scene_dict: Mapping, context: Mapping, out_path) -> Optional[Path]:
    """Render one IR scene to ``out_path``. Returns the path on success, None on
    any failure or when disabled. Never raises."""
    try:
        return _render_scene(scene_dict, context, Path(out_path))
    except Exception as exc:  # noqa: BLE001 — a backend never breaks the run
        logger.warning("remotion: render failed unexpectedly (%s)", type(exc).__name__)
        return None


def _render_scene(scene: Mapping, context: Mapping, out_path: Path) -> Optional[Path]:
    if not enabled():
        logger.debug("remotion: disabled (set CHRONOS_REMOTION=1 to enable)")
        return None
    if not isinstance(scene, Mapping):
        logger.warning("remotion: scene is not a mapping; skipped")
        return None
    sid = str(scene.get("id") or "?")
    if scene_duration_s(scene) is None:
        logger.warning("remotion: scene %s has unknown start_s/end_s; skipped", sid)
        return None
    npx = shutil.which("npx")
    if not npx:
        logger.warning("remotion: npx not found on PATH; skipped scene %s", sid)
        return None
    if not _engine_installed():
        logger.warning("remotion: video-engine dependencies not installed (run `npm ci` in video-engine/); skipped")
        return None

    props = build_props(scene, context or {})
    public_dir = Path(props["assetsBaseDir"]) if props["assetsBaseDir"] else None
    if public_dir is not None and not public_dir.is_dir():
        logger.warning("remotion: assets_base_dir does not exist; skipped scene %s", sid)
        return None

    out_path = out_path.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="remotion-props-") as tmp:
        props_path = Path(tmp) / f"{sid}.json"
        props_path.write_text(json.dumps(props), encoding="utf-8")
        cmd = build_command(npx, props_path, out_path, public_dir=public_dir, browser=_browser_executable())
        timeout = _timeout_s()
        try:
            proc = subprocess.run(
                cmd, cwd=str(ENGINE_DIR), capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            logger.warning("remotion: scene %s timed out after %.0fs", sid, timeout)
            return None
        except OSError as exc:
            logger.warning("remotion: could not start renderer for scene %s (%s)", sid, type(exc).__name__)
            return None

    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-_STDERR_TAIL:].strip()
        logger.warning("remotion: scene %s exited %s: %s", sid, proc.returncode, tail)
        return None
    if not out_path.is_file() or out_path.stat().st_size == 0:
        logger.warning("remotion: scene %s produced no output file", sid)
        return None
    return out_path
