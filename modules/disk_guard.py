"""Free-disk precheck and old-run pruning for the pipeline worker.

A render writes several GB under ``output/<slug>/`` and nothing ever removes a
finished or held run, so a long-lived worker volume fills up and a run dies
mid-render after the script and voice were already paid for (CLAUDE.md #6: check
before spending). Two small, isolated pieces:

* :func:`require_free_disk` - raise :class:`InsufficientDisk` when the volume
  holding ``output/`` has less than :data:`MIN_FREE_BYTES` (5 GB) free. main.py
  calls it at the start of every video run (``_preflight_disk``), before anything
  is spent, with the threshold :func:`configured_min_bytes` reads from
  ``NIGHTSHIFT_MIN_FREE_DISK_GB``.
* :func:`prune_old_runs` / the CLI (``python -m modules.disk_guard --prune-days
  30``) - delete the run folders of runs that were **published** and have not
  been touched for N days. A dry run unless ``--apply`` is given; nothing
  schedules it.

What "published" means is read from state the pipeline really leaves behind
(main.py, after a successful upload): the run's ``checkpoint.json`` is cleared
(``run_checkpoint.clear``), and ``upload_attempt.json`` records ``state:
uploaded`` with a video id (``upload_idempotency``). A folder that has the
upload record, no checkpoint and a rendered ``.mp4`` is a finished run.

A run that was held, blocked, is awaiting approval or whose upload failed keeps
its checkpoint (with the render stage) and is **never** selected unless
``--include-held`` is passed: its master may still be needed for approval, a
re-upload or a paid download. Pruning also only looks at direct children of the
output directory, never follows a symlink, never touches a folder with a
``.keep`` file, and never a run that has not rendered (that is resumable).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
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
#: Overrides the threshold above, in GB (a number, fractions allowed). Unset or blank is the default;
#: ``0`` turns the check off on purpose; anything unreadable (a word, a negative number) is the default.
MIN_FREE_ENV = "NIGHTSHIFT_MIN_FREE_DISK_GB"
#: --prune-days below this is refused: a held video can wait for approval and a
#: paid download is cut from the master in its run folder.
MIN_PRUNE_DAYS = 7
DEFAULT_PRUNE_DAYS = 30
KEEP_MARKER = ".keep"
CHECKPOINT = "checkpoint.json"          # run_checkpoint.CHECKPOINT_FILENAME
UPLOAD_ATTEMPT = "upload_attempt.json"  # upload_idempotency.ATTEMPT_FILENAME
STAGE_RENDER = "render"                 # run_checkpoint.STAGE_RENDER


class InsufficientDisk(RuntimeError):
    """Not enough free disk to start a run. The message names the remedy and
    carries only sizes and a path - never a secret."""

    def __init__(self, free: int, needed: int, path: Path):
        self.free = free
        self.needed = needed
        self.path = Path(path)
        super().__init__(
            f"only {free / GB:.1f} GB free on the volume holding {self.path} "
            f"(a run needs at least {needed / GB:g} GB). Fix: free space with "
            f"`python -m modules.disk_guard --prune-days {DEFAULT_PRUNE_DAYS}` (dry run; add "
            f"--apply to delete) or `docker system prune`, then start the run again"
        )


def free_bytes(path: Path) -> int:
    """Free bytes on the filesystem that holds ``path`` (its nearest existing parent)."""
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p).free


def configured_min_bytes(environ=None) -> int:
    """The free space a run needs: ``NIGHTSHIFT_MIN_FREE_DISK_GB`` in bytes, else :data:`MIN_FREE_BYTES`.

    A typo must not silently disable the guard, so only an explicit ``0`` does that: a non-number,
    a negative number or ``nan``/``inf`` is logged (the value is never echoed) and the default applies."""
    raw = str((os.environ if environ is None else environ).get(MIN_FREE_ENV, "") or "").strip()
    if not raw:
        return MIN_FREE_BYTES
    try:
        gb = float(raw)
    except ValueError:
        gb = math.nan
    if not math.isfinite(gb) or gb < 0:
        logger.warning("%s is not a non-negative number of GB - using the default of %d GB", MIN_FREE_ENV,
                       MIN_FREE_BYTES // GB)
        return MIN_FREE_BYTES
    return int(gb * GB)


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


def _read_json(path: Path) -> Optional[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return None
    return data if isinstance(data, dict) else None


def _has_render(run: Path) -> bool:
    try:
        return any(p.is_file() and not p.is_symlink() for p in run.rglob("*.mp4"))
    except OSError:
        return False


def classify(run: Path) -> Optional[str]:
    """``"published"``, ``"held"`` or None (leave it alone), from the state the
    pipeline leaves in the folder."""
    attempt = _read_json(run / UPLOAD_ATTEMPT)
    uploaded = bool(attempt and attempt.get("state") == "uploaded" and attempt.get("video_id"))
    checkpoint_path = run / CHECKPOINT
    if uploaded and not checkpoint_path.exists() and _has_render(run):
        return "published"
    cp = _read_json(checkpoint_path)
    if cp is not None and not uploaded:
        stages = cp.get("stages") if isinstance(cp.get("stages"), dict) else {}
        if STAGE_RENDER in stages:
            return "held"  # rendered, never uploaded: held, blocked, awaiting approval, upload failed
    return None


def find_prunable(output_dir: Path, older_than_days: float, *, now: Optional[float] = None,
                  include_held: bool = False) -> List[RunDir]:
    """Run folders under ``output_dir`` that were published (and, only with
    ``include_held``, rendered but never uploaded) and whose newest file is
    older than ``older_than_days``. Oldest first."""
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
        kind = classify(run)
        if kind is None or (kind == "held" and not include_held):
            continue
        try:
            age = (now - _newest_mtime(run)) / 86400.0
        except OSError:
            continue
        if age >= older_than_days:
            reason = "published" if kind == "published" else "held / not uploaded"
            out.append(RunDir(run, age, _size(run), reason))
    out.sort(key=lambda r: -r.age_days)
    return out


def prune_old_runs(output_dir: Path, older_than_days: float, *, apply: bool = False,
                   now: Optional[float] = None, include_held: bool = False,
                   rmtree: Callable = shutil.rmtree) -> List[RunDir]:
    """List (and, with ``apply=True``, delete) the prunable runs. Returns what was
    selected; a folder that cannot be removed is logged and skipped."""
    chosen = find_prunable(output_dir, older_than_days, now=now, include_held=include_held)
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
        description="Free-disk check and pruning of old published run folders. Never scheduled.")
    ap.add_argument("--output-dir", default=None, help="default: the pipeline's output/ folder")
    ap.add_argument("--prune-days", type=float, default=None, metavar="N",
                    help=f"list published runs untouched for N days (N >= {MIN_PRUNE_DAYS})")
    ap.add_argument("--include-held", action="store_true",
                    help="ALSO select rendered-but-never-uploaded runs (held, blocked, awaiting approval, "
                         "upload failed): their master may still be needed")
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
        runs = prune_old_runs(out_dir, args.prune_days, apply=args.apply, include_held=args.include_held)
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
