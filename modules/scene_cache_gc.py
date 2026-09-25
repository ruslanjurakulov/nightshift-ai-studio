"""Garbage collection for the scene render cache (``output/<slug>/scenes``).

``modules/scene_render.py`` caches each scene as ``<scene_id>-<key>.mp4``; a
changed scene gets a new key and a new file, and nothing ever removed the old
one — so every edit of a scene left a dead ``.mp4`` behind for good. This module
is the cleanup, called once after a *successful* scene render + assembly:

1. **Stale keys** — a file of a scene that is in the current project but whose
   key is not the one the project uses now is deleted (that scene's pixels have
   changed; the old file can never be a cache hit again).
2. **Leftover temp files** — ``.tmp-<pid>-<name>`` files a killed render left
   (``scene_render._tmp_path``). Deleted when the process that wrote them is
   gone, or when they are older than ``tmp_grace_s`` whatever the pid says (a
   recycled pid must not pin them forever). A live writer's fresh temp file is
   never touched.
3. **Optional caps**, off unless configured: ``max_age_s`` deletes cache files
   not modified for that long; ``max_bytes`` then deletes the oldest ones until
   the directory's cached ``.mp4`` total fits. From the environment:
   ``CHRONOS_SCENE_CACHE_MAX_AGE_DAYS`` and ``CHRONOS_SCENE_CACHE_MAX_MB``.
   Unset/blank means *no cap* — it is not the same as ``0``, which is a real
   cap (keep nothing beyond the files in use).

Files in use — the paths of the jobs just assembled — are never deleted by any
rule, even when they alone exceed a cap. Only regular files directly inside the
scenes directory whose names match the cache/temp patterns are candidates;
anything else there is left alone. Files of scene ids the current project no
longer has are removed only by the optional caps (rule 3).

Cleanup is best effort: :func:`cleanup` never raises into the render pipeline;
a failure is logged (counts and file names only) and the render stands.

Not covered: two processes rendering the *same* slug at once with different
scene content — one's cleanup can delete a file the other is about to
assemble; that render then fails and falls back like any other failure.
"""

from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional

logger = logging.getLogger(__name__)

MAX_MB_ENV = "CHRONOS_SCENE_CACHE_MAX_MB"
MAX_AGE_DAYS_ENV = "CHRONOS_SCENE_CACHE_MAX_AGE_DAYS"

#: Temp files older than this are removed even when their pid looks alive.
DEFAULT_TMP_GRACE_S = 6 * 3600.0

#: ``<scene_id>-<16 hex key>.mp4`` — scene_render.plan_jobs' naming.
_CACHE_RE = re.compile(r"^(?P<scene_id>.+)-(?P<key>[0-9a-f]{16})\.mp4$")
#: ``.tmp-<pid>-<final name>`` — scene_render._tmp_path's naming.
_TMP_RE = re.compile(r"^\.tmp-(?P<pid>\d+)-.+$")


@dataclass
class GcReport:
    """What one cleanup did. ``deleted`` holds file names, never full paths."""
    deleted: List[str] = field(default_factory=list)
    freed_bytes: int = 0
    errors: int = 0


def _env_number(name: str) -> Optional[float]:
    """A non-negative number from the environment, or None when unset/blank or
    invalid (an invalid value disables the cap rather than guessing one)."""
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return None
    try:
        value = float(str(raw).strip())
    except ValueError:
        logger.warning("Scene cache GC: ignoring %s (not a number)", name)
        return None
    if value < 0 or value != value:  # negative or NaN
        logger.warning("Scene cache GC: ignoring %s (must be >= 0)", name)
        return None
    return value


def caps_from_env() -> dict:
    """``{"max_bytes": ..., "max_age_s": ...}`` from the environment; each is
    None (no cap) unless its variable holds a number >= 0."""
    mb = _env_number(MAX_MB_ENV)
    days = _env_number(MAX_AGE_DAYS_ENV)
    return {"max_bytes": None if mb is None else int(mb * 1024 * 1024),
            "max_age_s": None if days is None else days * 86400.0}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True   # exists, owned by someone else
    except OSError:
        return True   # unknown — be conservative, the age rule still applies
    return True


def _delete(path: Path, size: int, report: GcReport) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError as exc:
        report.errors += 1
        logger.warning("Scene cache GC: could not delete %s (%s)", path.name, type(exc).__name__)
        return
    report.deleted.append(path.name)
    report.freed_bytes += max(0, size)


def collect(scenes_dir, keep: Iterable, *, max_bytes: Optional[int] = None,
            max_age_s: Optional[float] = None, tmp_grace_s: float = DEFAULT_TMP_GRACE_S,
            now: Optional[float] = None) -> GcReport:
    """Delete stale scene-cache files in ``scenes_dir``; see the module doc.

    ``keep`` is the paths in use (``[job.path for job in jobs]``); their scene
    ids define which scenes' stale keys are collected. May raise OSError on an
    unreadable directory — :func:`cleanup` is the never-raising entry point."""
    scenes_dir = Path(scenes_dir)
    report = GcReport()
    if not scenes_dir.is_dir():
        return report
    now = time.time() if now is None else float(now)
    keep_names = {Path(p).name for p in keep}
    current_ids = set()
    for name in keep_names:
        m = _CACHE_RE.match(name)
        if m:
            current_ids.add(m.group("scene_id"))

    cached = []   # (mtime, size, path) of cache files not in use
    for entry in os.scandir(scenes_dir):
        try:
            if not entry.is_file(follow_symlinks=False):
                continue
            st = entry.stat(follow_symlinks=False)
        except OSError:
            report.errors += 1
            continue
        name, path = entry.name, Path(entry.path)
        if name in keep_names:
            continue
        tmp = _TMP_RE.match(name)
        if tmp:
            if not _pid_alive(int(tmp.group("pid"))) or now - st.st_mtime > tmp_grace_s:
                _delete(path, st.st_size, report)
            continue
        m = _CACHE_RE.match(name)
        if not m:
            continue   # not ours — never touched
        if m.group("scene_id") in current_ids:
            _delete(path, st.st_size, report)   # same scene, key no longer used
            continue
        cached.append((st.st_mtime, st.st_size, path))

    if max_age_s is not None:
        young = []
        for mtime, size, path in cached:
            if now - mtime > max_age_s:
                _delete(path, size, report)
            else:
                young.append((mtime, size, path))
        cached = young

    if max_bytes is not None:
        in_use = 0
        for name in keep_names:
            try:
                in_use += (scenes_dir / name).stat().st_size
            except OSError:
                pass
        total = in_use + sum(size for _, size, _ in cached)
        for mtime, size, path in sorted(cached, key=lambda c: (c[0], c[2].name)):
            if total <= max_bytes:
                break
            before = len(report.deleted)
            _delete(path, size, report)
            if len(report.deleted) > before:
                total -= size
    return report


def keep_paths(jobs) -> List[Path]:
    """Every cache path the plan still uses: each job's own path plus its
    ``fallback`` job's path (a Remotion scene's ffmpeg fallback is kept so a
    later Remotion failure reuses it instead of re-rendering)."""
    paths = []
    for job in jobs:
        while job is not None:
            paths.append(job.path)
            job = getattr(job, "fallback", None)
    return paths


def cleanup(scenes_dir, jobs, **overrides) -> Optional[GcReport]:
    """Best-effort cleanup after a successful scene render + assembly. Caps come
    from the environment unless passed. Never raises; returns None on failure."""
    try:
        caps = caps_from_env()
        caps.update(overrides)
        report = collect(scenes_dir, keep_paths(jobs), **caps)
        if report.deleted or report.errors:
            logger.info("Scene cache GC: deleted %d file(s), freed %.1f MB, %d error(s)",
                        len(report.deleted), report.freed_bytes / (1024 * 1024), report.errors)
        return report
    except Exception as exc:  # cleanup must never break a finished render
        logger.warning("Scene cache GC skipped: %s", type(exc).__name__)
        return None
