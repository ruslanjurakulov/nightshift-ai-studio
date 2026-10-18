"""Free-disk precheck and old-run pruning for the pipeline worker.

A render writes several GB under ``output/<slug>/`` and nothing ever removes a
finished or held run, so a long-lived worker volume fills up and a run dies
mid-render after the script and voice were already paid for (CLAUDE.md #6: check
before spending). Two small, isolated pieces:

* :func:`require_free_disk` - raise :class:`InsufficientDisk` when the volume
  holding ``output/`` has less than :data:`MIN_FREE_BYTES` (5 GB) free. main.py
  can call it at run start; nothing here is wired in by itself.
* :func:`prune_old_runs` / the CLI (``python -m modules.disk_guard --prune-days
  30``) - delete the run folders of runs that finished (or rendered and were
  held) and have not been touched for N days. A dry run unless ``--apply``
  is given; nothing schedules it.

Pruning only ever looks at direct children of the output directory that hold a
``checkpoint.json`` (so it cannot touch a shared folder), never follows a
symlink, never touches a folder with a ``.keep`` file, and never a run that
has not rendered yet (that is a resumable run, not a finished one).
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

GB = 1024 ** 3
#: A run is refused below this much free space on the output volume.
MIN_FREE_BYTES = 5 * GB
#: --prune-days below this is refused: a held video can wait for approval and a
#: paid download is cut from the master in its run folder.
MIN_PRUNE_DAYS = 7
DEFAULT_PRUNE_DAYS = 30
KEEP_MARKER = ".keep"
CHECKPOINT = "checkpoint.json"
STAGE_RENDER = "render"


class InsufficientDisk(RuntimeError):
    """Not enough free disk to start a run. The message names the remedy and
    carries only sizes and a path - never a secret."""

    def __init__(self, free: int, needed: int, path: Path):
        self.free = free
        self.needed = needed
        self.path = Path(path)
        super().__init__(
            f"only {free / GB:.1f} GB free on the volume holding {self.path} "
            f"(a run needs at least {needed / GB:.0f} GB). Fix: free space with "
            f"`python -m modules.disk_guard --prune-days {DEFAULT_PRUNE_DAYS}` (dry run; add "
            f"--apply to delete) or `docker system prune`, then start the run again"
        )


def free_bytes(path: Path) -> int:
    """Free bytes on the filesystem that holds ``path`` (its nearest existing parent)."""
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p).free


def require_free_disk(path: Path, min_bytes: int = MIN_FREE_BYTES,
                      free_fn: Callable[[Path], int] = free_bytes) -> int:
    """Return the free bytes, or raise :class:`InsufficientDisk` below ``min_bytes``."""
    free = int(free_fn(Path(path)))
    if free < min_bytes:
        raise InsufficientDisk(free, min_bytes, Path(path))
    return free


# -- pruning ----------------------------------------------------------------

@dataclass(frozen=True)
class RunDir:
    path: Path
    age_days: float
    size_bytes: int
    reason: str


def _newest_mtime(root: Path) -> float:
    newest = root.stat().st_mtime
    for p in root.rglob("*"):
        try:
            newest = max(newest, p.lstat().st_mtime)
        except OSError:
            continue
    return newest


def _size(root: Path) -> int:
    total = 0
    for p in root.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                total += p.lstat().st_size
        except OSError:
            continue
    return total


def _finished_reason(run: Path) -> Optional[str]:
    """Why this folder counts as a finished/held run, or None (leave it alone)."""
    try:
        cp = json.loads((run / CHECKPOINT).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(cp, dict):
        return None
    stages = cp.get("stages") if isinstance(cp.get("stages"), dict) else {}
    if cp.get("completed") is True:
        return "finished"
    if STAGE_RENDER in stages:
        return "rendered, not completed (held)"
    return None


def find_prunable(output_dir: Path, older_than_days: float, *, now: Optional[float] = None) -> List[RunDir]:
    """Run folders under ``output_dir`` that finished/were held and are older than
    ``older_than_days`` by their newest file. Oldest first."""
    if older_than_days < MIN_PRUNE_DAYS:
        raise ValueError(f"refusing to prune runs younger than {MIN_PRUNE_DAYS} days")
    now = time.time() if now is None else now
    out: List[RunDir] = []
    root = Path(output_dir)
    if not root.is_dir():
        return out
    for run in sorted(root.iterdir()):
        if run.is_symlink() or not run.is_dir() or run.name.startswith("."):
            continue
        if (run / KEEP_MARKER).exists():
            continue
        reason = _finished_reason(run)
        if reason is None:
            continue
        try:
            age = (now - _newest_mtime(run)) / 86400.0
        except OSError:
            continue
        if age >= older_than_days:
            out.append(RunDir(run, age, _size(run), reason))
    out.sort(key=lambda r: -r.age_days)
    return out


def prune_old_runs(output_dir: Path, older_than_days: float, *, apply: bool = False,
                   now: Optional[float] = None, rmtree: Callable = shutil.rmtree) -> List[RunDir]:
    """List (and, with ``apply=True``, delete) the prunable runs. Returns what was
    selected; a folder that cannot be removed is logged and skipped."""
    chosen = find_prunable(output_dir, older_than_days, now=now)
    if apply:
        kept: List[RunDir] = []
        for r in chosen:
            try:
                rmtree(r.path)
                kept.append(r)
            except OSError as e:
                logger.warning("could not remove %s (%s)", r.path.name, type(e).__name__)
        return kept
    return chosen


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m modules.disk_guard",
        description="Free-disk check and pruning of old finished/held run folders. Never scheduled.")
    ap.add_argument("--output-dir", default=None, help="default: the pipeline's output/ folder")
    ap.add_argument("--prune-days", type=float, default=None, metavar="N",
                    help=f"list finished/held runs untouched for N days (N >= {MIN_PRUNE_DAYS})")
    ap.add_argument("--apply", action="store_true", help="actually delete (default is a dry run)")
    args = ap.parse_args(argv)

    if args.output_dir:
        out_dir = Path(args.output_dir)
    else:
        from config import OUTPUT_DIR  # noqa: PLC0415 - keep import cost off the library path
        out_dir = Path(OUTPUT_DIR)

    free = free_bytes(out_dir)
    print(f"free on the output volume: {free / GB:.1f} GB (a run needs {MIN_FREE_BYTES / GB:.0f} GB)")
    if args.prune_days is None:
        return 0 if free >= MIN_FREE_BYTES else 1
    try:
        runs = prune_old_runs(out_dir, args.prune_days, apply=args.apply)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    verb = "removed" if args.apply else "would remove"
    for r in runs:
        print(f"  {verb} {r.path.name}  ({r.reason}, {r.age_days:.0f} days, {r.size_bytes / GB:.2f} GB)")
    total = sum(r.size_bytes for r in runs)
    print(f"{verb} {len(runs)} run folder(s), {total / GB:.2f} GB"
          + ("" if args.apply else "; dry run - add --apply to delete"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
