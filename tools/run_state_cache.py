#!/usr/bin/env python3
"""Carry a run's small resume state across GitHub Actions runs.

    python tools/run_state_cache.py import   # before main.py: .run_state/ -> output/
    python tools/run_state_cache.py export   # after main.py:  output/ -> .run_state/

Why
---
Resume state lives in ``output/<slug>/``: the run checkpoint (whose
``created_at`` is the run epoch every per-run ledger keys on), the paid
provider-task ledger, the upload-attempt ledger and the saved script. A GitHub
Actions job starts from a clean checkout, so without this a scheduled run that
died mid-generation or mid-upload forgot all of it and the next attempt paid
again — or could upload again.

``.github/workflows/daily_video.yml`` persists the ``.run_state/`` directory
with ``actions/cache`` (the same pattern as ``history/``), one cache line per
channel. This tool is the narrow bridge between that directory and
``output/``:

* **Allowlist only.** Exactly the four files in :data:`STATE_FILES` are ever
  copied. Rendered video, audio, images and thumbnails are not — nor is any
  credential: ``youtube_token*.json`` / ``client_secret.json`` live at the
  repository root, outside ``output/<slug>/``, and are additionally refused by
  name (:data:`NEVER_COPY`).
* **Only runs that can still be resumed.** A run is exported only when its
  checkpoint exists (a published run clears it), is not marked complete, and
  was updated within :data:`MAX_AGE_DAYS`. A published run therefore leaves
  nothing behind, and a long-dead run ages out.
* **Bounded.** At most :data:`MAX_RUNS` runs, each file at most
  :data:`MAX_FILE_BYTES` — so the cache is at most ~``MAX_RUNS × 4 × 1 MB`` and
  in practice a few dozen KB (a checkpoint and the ledgers are ~1–3 KB each,
  a script ~10–40 KB).
* **Import never overwrites.** A run that already has an ``output/<slug>/``
  directory (a local run, one published there) is newer than the cache and is
  left untouched.
* **Never fails the job.** Every problem is printed as a warning and the exit
  code is 0 — the worst case is the old behaviour (a fresh run).

Stale state cannot leak into a new run even when it *is* restored: every
ledger is keyed on the run epoch (``run_checkpoint.run_epoch``), and a
published run clears its checkpoint, so the next run of the same topic gets a
new epoch and ignores older ledgers. The export filter above is a second,
independent guard.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.provider_tasks import LEDGER_FILENAME  # noqa: E402
from modules.run_checkpoint import CHECKPOINT_FILENAME  # noqa: E402
from modules.upload_idempotency import ATTEMPT_FILENAME  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "output"
DEFAULT_STATE = REPO_ROOT / ".run_state"

SCRIPT_FILENAME = "script.json"   # main.py: OUTPUT_DIR / slug / "script.json"

#: The only files ever copied, in either direction. project.json (the Video IR)
#: is deliberately absent: it is rebuilt every run and nothing reads it back on
#: resume. Media is absent: it is large, and a checkpoint stage whose files are
#: gone is simply not resumable (run_checkpoint never trusts a missing file).
STATE_FILES = (CHECKPOINT_FILENAME, LEDGER_FILENAME, ATTEMPT_FILENAME, SCRIPT_FILENAME)

#: Credential files. They never sit in output/<slug>/, but they are refused by
#: name anyway so no future allowlist edit can ever cache one.
NEVER_COPY = re.compile(r"^(youtube_token.*|client_secret.*)\.json$", re.IGNORECASE)

MAX_RUNS = 10
MAX_AGE_DAYS = 7
MAX_FILE_BYTES = 1_000_000
MANIFEST = "manifest.json"

# main.py's slugify(): [a-z0-9-], at most 50 chars. Anything else (a dot-dir,
# "..", a path separator) is never read or written.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def _warn(msg: str) -> None:
    print(f"run-state cache: warning: {msg}")


def _parse_iso(value) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _checkpoint(run_dir: Path) -> Optional[dict]:
    try:
        raw = json.loads((run_dir / CHECKPOINT_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _resumable(root: Path, *, now: Optional[datetime], max_age_days: int) -> list:
    """``(updated_at, run_dir)`` for every run under ``root`` worth carrying to
    the next job: a readable checkpoint that is not complete and was updated
    within ``max_age_days``. Unsorted, uncapped. Never raises."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=max_age_days)
    found = []
    try:
        children = sorted(root.iterdir()) if root.is_dir() else []
    except OSError as e:
        _warn(f"cannot list {root}: {e}")
        return []
    for child in children:
        if child.is_symlink() or not child.is_dir() or not _SLUG_RE.match(child.name):
            continue
        cp = _checkpoint(child)
        if cp is None or cp.get("completed"):
            continue   # no checkpoint = published (cleared) or never started
        updated = _parse_iso(cp.get("updated_at")) or _parse_iso(cp.get("created_at"))
        if updated is None or updated < cutoff:
            continue   # too old to resume: a fresh run is the safe choice
        found.append((updated, child))
    return found


def _newest(found: list, max_runs: int) -> List[Path]:
    found = sorted(found, key=lambda t: t[0], reverse=True)
    return [p for _, p in found[:max(0, max_runs)]]


def resumable_runs(root: Path, *, now: Optional[datetime] = None,
                   max_runs: int = MAX_RUNS, max_age_days: int = MAX_AGE_DAYS) -> List[Path]:
    """The resumable run directories under ``root``, newest first, at most
    ``max_runs``. Never raises."""
    return _newest(_resumable(root, now=now, max_age_days=max_age_days), max_runs)


def _copy_state(src_dir: Path, dst_dir: Path, *, overwrite: bool) -> List[str]:
    copied = []
    for name in STATE_FILES:
        if NEVER_COPY.match(name):   # defence in depth; STATE_FILES never matches
            continue
        src, dst = src_dir / name, dst_dir / name
        try:
            if not src.is_file() or src.is_symlink():
                continue
            if src.stat().st_size > MAX_FILE_BYTES:
                _warn(f"skipping {src} (larger than {MAX_FILE_BYTES} bytes)")
                continue
            if dst.exists() and not overwrite:
                continue
            dst_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            copied.append(name)
        except OSError as e:
            _warn(f"could not copy {src}: {e}")
    return copied


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def export_state(output_dir: Path = DEFAULT_OUTPUT, state_dir: Path = DEFAULT_STATE, *,
                 now: Optional[datetime] = None) -> List[str]:
    """Rebuild ``state_dir`` for the cache save.

    ``output/`` is the truth for every run it has a directory for: a run that
    published in this job (checkpoint cleared) or aged out is dropped. A run
    that is only in ``state_dir`` (restored, but this job never reached the
    import, or made a different video) is kept while it is still resumable, so
    a job that dies early does not wipe another run's state.

    A manifest is always written, so the cache step always has something to
    save and the newest cache entry reflects the newest truth. Returns the
    exported slugs."""
    exported: List[str] = []
    staging = state_dir.with_name(state_dir.name + ".staging")
    try:
        _remove(staging)
        staging.mkdir(parents=True)
        try:
            in_output = {c.name for c in output_dir.iterdir() if c.is_dir()} if output_dir.is_dir() else set()
        except OSError:
            in_output = set()
        found = _resumable(output_dir, now=now, max_age_days=MAX_AGE_DAYS)
        found += [(t, p) for t, p in _resumable(state_dir, now=now, max_age_days=MAX_AGE_DAYS)
                  if p.name not in in_output]
        for run_dir in _newest(found, MAX_RUNS):
            if _copy_state(run_dir, staging / run_dir.name, overwrite=True):
                exported.append(run_dir.name)
        manifest = {
            "version": 1,
            "exported_at": (now or datetime.now(timezone.utc)).isoformat(),
            "runs": exported,
        }
        (staging / MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        _remove(state_dir)
        staging.rename(state_dir)
    except Exception as e:   # never fail the job over bookkeeping
        _warn(f"export failed ({type(e).__name__}: {e})")
        return []
    return exported


def import_state(state_dir: Path = DEFAULT_STATE, output_dir: Path = DEFAULT_OUTPUT, *,
                 now: Optional[datetime] = None) -> List[str]:
    """Copy restored run state back into ``output_dir``, applying the same
    freshness filter as export. A run that already has a directory in
    ``output_dir`` is left alone entirely — what is on disk (a local run, a
    run published there) is newer than any cache. Returns the imported slugs."""
    imported: List[str] = []
    try:
        for run_dir in resumable_runs(state_dir, now=now):
            dest = output_dir / run_dir.name
            if dest.exists() or dest.is_symlink():
                continue
            if _copy_state(run_dir, dest, overwrite=False):
                imported.append(run_dir.name)
    except Exception as e:
        _warn(f"import failed ({type(e).__name__}: {e})")
    return imported


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("direction", choices=["import", "export"])
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    args = parser.parse_args(list(argv) if argv is not None else None)
    if args.direction == "import":
        slugs = import_state(args.state, args.output)
        print(f"run-state cache: restored {len(slugs)} unfinished run(s): {', '.join(slugs) or '-'}")
    else:
        slugs = export_state(args.output, args.state)
        print(f"run-state cache: saved {len(slugs)} unfinished run(s): {', '.join(slugs) or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
