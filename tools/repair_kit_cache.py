#!/usr/bin/env python3
"""Keep an unfinished run's media across GitHub Actions runs, so it can be repaired.

    python tools/repair_kit_cache.py export   # after main.py:  output/ -> .repair_kit/
    python tools/repair_kit_cache.py import   # before a repair: .repair_kit/ -> output/

Why
---
A targeted scene repair (``modules/scene_repair.py``) keeps every scene it is
not repairing exactly as it was — which needs that scene's footage, the
narration and the subtitles on disk. ``tools/run_state_cache.py`` deliberately
carries only small JSON ledgers, never media, so on a GitHub-hosted runner a
repair would always stop at its preflight. This is the opt-in companion that
carries a *repair kit*: the files one run's Video IR references.

* **Opt-in.** ``daily_video.yml`` exports only when the repo VARIABLE
  ``CHRONOS_REPAIR_KIT`` is ``true``, and restores only on a repair run. With it
  unset, nothing here runs and nothing is cached.
* **One run, bounded.** Only the newest unfinished run (the same freshness
  filter as the run-state cache: a checkpoint that is not complete and was
  updated within 7 days), and only when all its files fit in
  :data:`MAX_KIT_BYTES`. A published run clears its checkpoint, so it leaves no
  kit — a published video is never repaired.
* **Allowlist by reference.** Exactly ``project.json``, ``fact_check.json`` and
  the files the IR points at (narration audio, subtitles, each video/image
  asset) — and only those that resolve to a regular file inside
  ``output/<slug>/``. No symlink is followed, nothing outside the run directory
  is read, and credential file names are refused outright (they never live
  there anyway).
* **Import never overwrites**, and only fills in a run whose checkpoint the
  run-state cache already restored — a kit without its run is ignored.
* **Never fails the job.** Problems are printed as warnings; exit code 0.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Iterable, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools import run_state_cache as rsc  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "output"
DEFAULT_KIT = REPO_ROOT / ".repair_kit"

#: Largest kit carried. Stock b-roll is the bulk; a run over this keeps no kit
#: (its repair then fails at preflight, naming why) rather than crowding the
#: repository's 10 GB Actions cache.
MAX_KIT_BYTES = 1_500_000_000
MANIFEST = "manifest.json"
FIXED_FILES = ("project.json", "fact_check.json")


def _warn(msg: str) -> None:
    print(f"repair kit: warning: {msg}")


def _inside(path: Path, run_dir: Path) -> Optional[str]:
    """``path`` relative to ``run_dir`` (posix), when it is a regular,
    non-symlinked file inside it; else None."""
    try:
        if path.is_symlink() or not path.is_file():
            return None
        rel = path.resolve().relative_to(run_dir.resolve())
    except (OSError, ValueError):
        return None
    parts = rel.parts
    if not parts or any(p in ("", ".", "..") for p in parts):
        return None
    if any(p.is_symlink() for p in [run_dir.joinpath(*parts[:i]) for i in range(1, len(parts))]):
        return None
    if rsc.NEVER_COPY.match(parts[-1]):
        return None
    return PurePosixPath(*parts).as_posix()


def _relocated(value, slug: str, run_dir: Path) -> Optional[Path]:
    if not value:
        return None
    p = Path(str(value))
    if p.exists():
        return p
    parts = p.parts
    if slug in parts:
        i = len(parts) - 1 - parts[::-1].index(slug)
        rest = parts[i + 1:]
        if rest and ".." not in rest:
            return run_dir.joinpath(*rest)
    return p


def kit_files(run_dir: Path) -> List[str]:
    """The run-relative paths a repair of ``run_dir`` needs. Never raises."""
    slug = run_dir.name
    out: List[str] = []
    try:
        project = json.loads((run_dir / "project.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return out
    if not isinstance(project, dict):
        return out
    candidates = [run_dir / name for name in FIXED_FILES]
    audio = project.get("audio")
    if isinstance(audio, dict):
        candidates.append(_relocated(audio.get("path"), slug, run_dir))
    candidates.append(_relocated(project.get("subtitles_path"), slug, run_dir))
    for a in project.get("assets") or []:
        if isinstance(a, dict) and a.get("kind") in ("video", "image", "audio"):
            candidates.append(_relocated(a.get("path"), slug, run_dir))
    for c in candidates:
        if c is None:
            continue
        rel = _inside(c, run_dir)
        if rel and rel not in out:
            out.append(rel)
    return out


def _place(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dst)      # same filesystem: no second copy of the footage
    except OSError:
        shutil.copyfile(src, dst)


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def export_kit(output_dir: Path = DEFAULT_OUTPUT, kit_dir: Path = DEFAULT_KIT, *,
               now: Optional[datetime] = None, max_bytes: int = MAX_KIT_BYTES) -> Optional[str]:
    """Rebuild ``kit_dir`` from the newest unfinished run in ``output_dir``
    that has a Video IR. Returns its slug, or None when no kit was written
    (then ``kit_dir`` is left absent, so the save step has nothing to store)."""
    staging = kit_dir.with_name(kit_dir.name + ".staging")
    try:
        _remove(staging)
        chosen = None
        for run_dir in rsc.resumable_runs(output_dir, now=now, max_runs=rsc.MAX_RUNS):
            if (run_dir / "project.json").is_file():
                chosen = run_dir
                break
        if chosen is None:
            _remove(kit_dir)
            return None
        files = kit_files(chosen)
        total = sum((chosen / f).stat().st_size for f in files)
        if total > max_bytes:
            _warn(f"run {chosen.name} needs {total} bytes, over the {max_bytes}-byte cap — no kit kept")
            _remove(kit_dir)
            return None
        for rel in files:
            _place(chosen / rel, staging / chosen.name / rel)
        manifest = {"version": 1, "slug": chosen.name, "files": files, "bytes": total,
                    "exported_at": (now or datetime.now(timezone.utc)).isoformat()}
        (staging / MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        _remove(kit_dir)
        staging.rename(kit_dir)
        return chosen.name
    except Exception as e:   # never fail the job over a convenience cache
        _warn(f"export failed ({type(e).__name__}: {e})")
        try:
            _remove(staging)
        except OSError:
            pass
        return None


def import_kit(kit_dir: Path = DEFAULT_KIT, output_dir: Path = DEFAULT_OUTPUT) -> List[str]:
    """Copy a restored kit's files into ``output_dir/<slug>/`` — only for a run
    whose unfinished checkpoint is already there, never over an existing file.
    Returns the files placed (run-relative)."""
    placed: List[str] = []
    try:
        manifest = json.loads((kit_dir / MANIFEST).read_text(encoding="utf-8"))
        slug = str(manifest.get("slug") or "")
        if not rsc._SLUG_RE.match(slug):
            _warn("manifest names no valid run")
            return placed
        run_dir = output_dir / slug
        cp = rsc._checkpoint(run_dir)
        if cp is None or cp.get("completed"):
            print(f"repair kit: run {slug} has no unfinished checkpoint here — kit ignored")
            return placed
        src_root = kit_dir / slug
        for rel in manifest.get("files") or []:
            parts = PurePosixPath(str(rel)).parts
            if (not parts or PurePosixPath(str(rel)).is_absolute()
                    or any(p in ("", ".", "..") for p in parts) or rsc.NEVER_COPY.match(parts[-1])):
                _warn(f"refusing kit entry {rel!r}")
                continue
            src, dst = src_root.joinpath(*parts), run_dir.joinpath(*parts)
            if src.is_symlink() or not src.is_file() or dst.exists() or dst.is_symlink():
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            placed.append(str(rel))
    except FileNotFoundError:
        print("repair kit: none restored")
    except Exception as e:
        _warn(f"import failed ({type(e).__name__}: {e})")
    return placed


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("direction", choices=["import", "export"])
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--kit", type=Path, default=DEFAULT_KIT)
    args = parser.parse_args(list(argv) if argv is not None else None)
    if args.direction == "import":
        files = import_kit(args.kit, args.output)
        print(f"repair kit: restored {len(files)} file(s)")
    else:
        slug = export_kit(args.output, args.kit)
        print(f"repair kit: kept media of run {slug}" if slug else "repair kit: nothing kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
