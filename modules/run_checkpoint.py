"""Run checkpoint — record each completed pipeline stage so a crashed run can
resume instead of paying for everything again.

A single video run walks Topic → Research → Script → Audio → Media → Subtitles →
Thumbnails → Render → Upload. The two expensive-and-fragile ends are the Gemini
generation up front (topic + research + script) and the MoviePy render near the
bottom, which has been killed mid-run before. When a run dies after the script
was written, re-running from scratch pays for the same Gemini calls again for a
script that is already sitting on disk.

This module writes a small JSON checkpoint next to a run's artifacts
(`output/<slug>/checkpoint.json`) recording, per stage, when it completed and
which files it produced. On a later run, `--resume` reads it and reuses what is
still on disk — today that means loading the saved `script.json` and skipping
the paid generation stages entirely (the existing `--script-file` reuse path).

Three guarantees, matching the rest of the pipeline:

1. **Never raises, never changes behavior.** Recording a checkpoint is pure
   bookkeeping; any IO failure is swallowed with a warning and the run proceeds
   exactly as if this module were not here. `--resume` off ⇒ byte-for-byte the
   old flow.

2. **A checkpoint never lies about what exists.** A stage counts as resumable
   only when it was recorded complete AND every artifact file it named is still
   on disk. A cleaned `output/` directory can't trick a resume into skipping a
   stage whose files are gone.

3. **No secrets.** Only stage names, timestamps and artifact *paths* are
   written — never tokens, keys, or script content.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import OUTPUT_DIR

logger = logging.getLogger(__name__)

CHECKPOINT_FILENAME = "checkpoint.json"

# Canonical stage names recorded in a checkpoint. These mirror the pipeline
# stages in main.py; the ordering is documentation only — resume decisions are
# made per stage by "is it complete and are its files present", never by index.
STAGE_SCRIPT = "script"
STAGE_VOICE = "voice"
STAGE_MEDIA = "media"
STAGE_SUBTITLES = "subtitles"
STAGE_THUMBNAILS = "thumbnails"
STAGE_RENDER = "render"
STAGE_UPLOAD = "upload"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Checkpoint:
    """The recorded progress of one run, keyed by its output slug."""

    slug: str
    topic: str = ""
    channel_id: str = ""
    created_at: str = ""
    updated_at: str = ""
    completed: bool = False
    # stage name -> {"at": iso, "artifacts": {key: path}}
    stages: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "slug": self.slug,
            "topic": self.topic,
            "channel_id": self.channel_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "completed": self.completed,
            "stages": self.stages,
        }

    @staticmethod
    def from_dict(d: dict) -> "Checkpoint":
        return Checkpoint(
            slug=d.get("slug", ""),
            topic=d.get("topic", ""),
            channel_id=d.get("channel_id", ""),
            created_at=d.get("created_at", ""),
            updated_at=d.get("updated_at", ""),
            completed=bool(d.get("completed", False)),
            stages=dict(d.get("stages", {})),
        )

    # -- queries (pure; safe to call on any loaded checkpoint) --------------

    def stage_completed(self, stage: str) -> bool:
        """True if `stage` was recorded complete. Says nothing about whether its
        files still exist — see `artifacts_present`/`can_resume_stage`."""
        return stage in self.stages

    def artifacts_present(self, stage: str) -> bool:
        """True if every artifact path recorded for `stage` still exists on
        disk. A stage recorded with no artifacts is vacuously present (it left
        no reusable file — e.g. a stage that only made API calls)."""
        entry = self.stages.get(stage)
        if entry is None:
            return False
        artifacts = entry.get("artifacts") or {}
        for p in artifacts.values():
            try:
                if not Path(p).exists():
                    return False
            except (TypeError, ValueError, OSError):
                return False
        return True

    def can_resume_stage(self, stage: str) -> bool:
        """A stage is safe to skip on resume only when it completed AND all its
        artifacts are still on disk."""
        return self.stage_completed(stage) and self.artifacts_present(stage)

    def artifact(self, stage: str, key: str) -> Optional[str]:
        """The recorded path for one artifact of a stage, or None."""
        entry = self.stages.get(stage) or {}
        return (entry.get("artifacts") or {}).get(key)

    def resumable_stages(self) -> list:
        """Every recorded stage whose artifacts are all still present, in the
        order they were recorded."""
        return [s for s in self.stages if self.can_resume_stage(s)]


# -- IO helpers (module-level; each swallows its own errors) ----------------

def checkpoint_path(slug: str, root: Optional[Path] = None) -> Path:
    base = Path(root) if root is not None else OUTPUT_DIR
    return base / slug / CHECKPOINT_FILENAME


def load(slug: str, root: Optional[Path] = None) -> Optional[Checkpoint]:
    """Load the checkpoint for `slug`, or None if it is missing or unreadable.
    Never raises — an unreadable checkpoint simply means "cannot resume"."""
    path = checkpoint_path(slug, root)
    try:
        if not path.exists():
            return None
        raw = path.read_text(encoding="utf-8").strip()
        if not raw:
            return None
        return Checkpoint.from_dict(json.loads(raw))
    except Exception as e:
        logger.warning("Could not read checkpoint %s (%s: %s) — treating as no checkpoint",
                       path, type(e).__name__, e)
        return None


def record_stage(
    slug: str,
    stage: str,
    *,
    topic: str = "",
    channel_id: str = "",
    artifacts: Optional[dict] = None,
    root: Optional[Path] = None,
) -> Optional[Checkpoint]:
    """Mark `stage` complete for this run and persist. Loads-or-creates the
    checkpoint, so stages accumulate across calls. Returns the updated
    Checkpoint, or None if persistence failed (the caller ignores the result —
    a failed record must never break the run).

    Artifact *paths* only. Absolute paths are stored as-is; a Path is coerced to
    str. `topic`/`channel_id` fill in on first write and are left alone after."""
    try:
        cp = load(slug, root) or Checkpoint(slug=slug, created_at=_now_iso())
        if topic and not cp.topic:
            cp.topic = topic
        if channel_id and not cp.channel_id:
            cp.channel_id = channel_id
        safe_artifacts = {}
        for key, value in (artifacts or {}).items():
            if value is None:
                continue
            safe_artifacts[str(key)] = str(value)
        cp.stages[stage] = {"at": _now_iso(), "artifacts": safe_artifacts}
        cp.updated_at = _now_iso()
        _write(cp, root)
        return cp
    except Exception as e:
        logger.warning("Could not record checkpoint stage %r for %r (%s: %s) — continuing",
                       stage, slug, type(e).__name__, e)
        return None


def run_epoch(slug: str, root: Optional[Path] = None) -> str:
    """A stable identity for the current run of ``slug``: the checkpoint's
    ``created_at``, or "" when there is no readable checkpoint.

    It survives crashes and ``--resume`` (the checkpoint is kept for any run that
    did not publish) and changes once a run publishes (``clear`` drops the
    checkpoint, so the next run gets a new one). Per-run ledgers — provider
    tasks, upload attempts — key on it so a later run of the same topic never
    inherits an earlier run's state. Never raises."""
    cp = load(slug, root)
    return (cp.created_at or "") if cp is not None else ""


def mark_complete(slug: str, root: Optional[Path] = None) -> None:
    """Flag the run as finished (published or intentionally held). A completed
    checkpoint is skipped by `latest_incomplete`, so it never lures a bare
    `--resume` into re-opening a run that already succeeded."""
    try:
        cp = load(slug, root)
        if cp is None:
            return
        cp.completed = True
        cp.updated_at = _now_iso()
        _write(cp, root)
    except Exception as e:
        logger.warning("Could not mark checkpoint %r complete (%s: %s)", slug, type(e).__name__, e)


def clear(slug: str, root: Optional[Path] = None) -> None:
    """Delete the checkpoint file. Called on a fully finished run so a later
    unrelated run for the same topic starts clean. Missing file is fine."""
    try:
        path = checkpoint_path(slug, root)
        if path.exists():
            path.unlink()
    except Exception as e:
        logger.warning("Could not clear checkpoint %r (%s: %s)", slug, type(e).__name__, e)


def latest_incomplete(root: Optional[Path] = None) -> Optional[Checkpoint]:
    """The most recently updated checkpoint that is not marked complete, so a
    bare `--resume` (no topic given) can pick up the last failed run. Returns
    None when there is nothing to resume. Never raises."""
    base = Path(root) if root is not None else OUTPUT_DIR
    best: Optional[Checkpoint] = None
    try:
        if not base.exists():
            return None
        for child in base.iterdir():
            if not child.is_dir():
                continue
            cp = load(child.name, root)
            if cp is None or cp.completed:
                continue
            if best is None or (cp.updated_at or "") > (best.updated_at or ""):
                best = cp
    except Exception as e:
        logger.warning("Could not scan for resumable runs (%s: %s)", type(e).__name__, e)
        return None
    return best


def _write(cp: Checkpoint, root: Optional[Path] = None) -> None:
    path = checkpoint_path(cp.slug, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cp.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
