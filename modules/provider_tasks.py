"""Provider task ledger — remember every paid generation task a run submitted.

Why this exists
---------------
Text-to-video providers (MiniMax, and the generic async providers in
``modules/video_providers.py``) work in two halves: a *submit* that starts a
billable job and returns a ``task_id``, then a *poll* that waits for the clip.
The submit is where the money goes. Before this module the ``task_id`` lived
only in memory, so a run that died while polling (the render host killed, a
timeout, a crash further down) forgot it — and the next attempt paid to
generate the very same clip again.

This module writes each submitted task to ``output/<slug>/provider_tasks.json``
the moment the provider hands back its id, *before* polling starts. On a later
attempt of the same run (``--resume``, or simply re-running the same topic) an
unfinished task for the same scene and the same prompt is **polled instead of
re-submitted**, and a clip that already finished and is still on disk is reused
without any request at all.

Keys
----
A task is identified by ``(provider, scene_id, prompt_hash)``:

* ``scene_id`` is ``f"s{section_index:03d}"`` — the same scene id the Video IR
  uses, so a ledger entry joins its IR scene (and an IR asset's ``task_id``
  joins its ledger entry).
* ``prompt_hash`` covers everything that decides what the provider renders
  (provider, model, prompt, negative prompt, duration). If any of it changed,
  it is a different clip and a new submit is correct.

Run identity
------------
Entries belong to one *run*, identified by the run checkpoint's ``created_at``
(``run_checkpoint.run_epoch``). A fully published run clears its checkpoint, so
the next run of the same topic gets a new epoch and starts with an empty ledger
— it never inherits another run's tasks.

Guarantees, matching the rest of the pipeline
---------------------------------------------
* **Never raises.** Every read/write failure is logged and swallowed; the worst
  case is the old behaviour (a fresh submit).
* **No secrets.** Only provider name, model, task id, scene id, a prompt *hash*,
  timestamps, status and a local file path are written — never a key, never the
  prompt text.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

LEDGER_FILENAME = "provider_tasks.json"
LEDGER_VERSION = 1

#: Ledger statuses. ``submitted`` means "paid for, outcome not yet known" — the
#: one state a later attempt must poll rather than re-submit.
STATUS_SUBMITTED = "submitted"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"

#: What a client's ``resume()`` reports back.
OUTCOME_SUCCEEDED = "succeeded"   # clip downloaded to disk
OUTCOME_FAILED = "failed"         # the provider said the job failed
OUTCOME_PENDING = "pending"       # not finished / could not tell — keep polling next time


def scene_id(section_index: int) -> str:
    """The Video IR scene id for a script section index (``s000``, ``s001``…)."""
    return f"s{int(section_index):03d}"


def prompt_hash(provider: str, model: str, spec) -> str:
    """A short, stable hash of everything that decides the rendered clip.

    Reads ``prompt``/``negative_prompt``/``duration_seconds`` from a
    ``GenerationSpec`` (or anything shaped like it). The prompt text itself is
    never stored — only this digest."""
    payload = {
        "provider": (provider or "").strip().lower(),
        "model": model or "",
        "prompt": getattr(spec, "prompt", "") or "",
        "negative_prompt": getattr(spec, "negative_prompt", "") or "",
        "duration_seconds": getattr(spec, "duration_seconds", None),
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class TaskOutcome:
    """The result of polling (and, on success, downloading) one provider task."""

    state: str                     # one of OUTCOME_*
    path: Optional[Path] = None    # set only when state == succeeded


@dataclass
class ProviderTask:
    provider: str
    model: str
    task_id: str
    scene_id: str
    section_index: int
    prompt_hash: str
    submitted_at: str
    status: str = STATUS_SUBMITTED
    updated_at: str = ""
    local_path: Optional[str] = None

    @staticmethod
    def from_dict(d: dict) -> Optional["ProviderTask"]:
        try:
            return ProviderTask(
                provider=str(d["provider"]),
                model=str(d.get("model") or ""),
                task_id=str(d["task_id"]),
                scene_id=str(d["scene_id"]),
                section_index=int(d["section_index"]),
                prompt_hash=str(d["prompt_hash"]),
                submitted_at=str(d.get("submitted_at") or ""),
                status=str(d.get("status") or STATUS_SUBMITTED),
                updated_at=str(d.get("updated_at") or ""),
                local_path=(str(d["local_path"]) if d.get("local_path") else None),
            )
        except (KeyError, TypeError, ValueError):
            return None

    def clip_on_disk(self) -> Optional[Path]:
        """The downloaded clip, when this task succeeded and the file is still
        there and non-empty; otherwise None."""
        if self.status != STATUS_SUCCEEDED or not self.local_path:
            return None
        try:
            p = Path(self.local_path)
            return p if p.exists() and p.stat().st_size > 0 else None
        except OSError:
            return None


def ledger_path(slug: str, root: Optional[Path] = None) -> Path:
    if root is None:
        from config import OUTPUT_DIR
        root = OUTPUT_DIR
    return Path(root) / slug / LEDGER_FILENAME


@dataclass
class TaskLedger:
    """The per-run ledger. ``slug=None`` keeps it in memory only (used when the
    caller has no run slug, e.g. a unit test fetcher) — same API, nothing
    written."""

    slug: Optional[str] = None
    root: Optional[Path] = None
    run_epoch: str = ""
    tasks: list = field(default_factory=list)

    # -- IO -----------------------------------------------------------------

    @classmethod
    def open(cls, slug: Optional[str], *, root: Optional[Path] = None) -> "TaskLedger":
        """Load the ledger for this run, or start an empty one. Entries from a
        different run epoch (a previous, finished run of the same topic) are
        dropped. Never raises."""
        epoch = ""
        if slug:
            try:
                from modules import run_checkpoint
                epoch = run_checkpoint.run_epoch(slug, root)
            except Exception as e:   # never let bookkeeping sink the media stage
                logger.warning("Could not read the run epoch for %r (%s: %s)",
                               slug, type(e).__name__, e)
        ledger = cls(slug=slug, root=root, run_epoch=epoch)
        if not slug:
            return ledger
        path = ledger_path(slug, root)
        try:
            if not path.exists():
                return ledger
            raw = json.loads(path.read_text(encoding="utf-8") or "{}")
        except Exception as e:
            logger.warning("Could not read provider task ledger %s (%s: %s) — starting empty",
                           path, type(e).__name__, e)
            return ledger
        if not isinstance(raw, dict) or str(raw.get("run_epoch") or "") != epoch:
            # Another run's tasks: never poll or reuse them for this one.
            return ledger
        for item in raw.get("tasks") or []:
            task = ProviderTask.from_dict(item) if isinstance(item, dict) else None
            if task is not None:
                ledger.tasks.append(task)
        return ledger

    def _save(self) -> None:
        if not self.slug:
            return
        path = ledger_path(self.slug, self.root)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            body = {
                "version": LEDGER_VERSION,
                "slug": self.slug,
                "run_epoch": self.run_epoch,
                "tasks": [asdict(t) for t in self.tasks],
            }
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(body, indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)   # atomic: a crash never leaves half a ledger
        except Exception as e:
            logger.warning("Could not write provider task ledger %s (%s: %s) — continuing",
                           path, type(e).__name__, e)

    # -- queries --------------------------------------------------------------

    def find(self, provider: str, scene: str, phash: str) -> Optional[ProviderTask]:
        """The most recent task for this provider + scene + prompt, or None."""
        provider = (provider or "").strip().lower()
        for task in reversed(self.tasks):
            if task.provider == provider and task.scene_id == scene and task.prompt_hash == phash:
                return task
        return None

    # -- writes ---------------------------------------------------------------

    def record_submitted(self, *, provider: str, model: str, task_id: str,
                         section_index: int, phash: str) -> ProviderTask:
        """Persist a freshly submitted (i.e. paid-for) task immediately."""
        now = _now_iso()
        task = ProviderTask(
            provider=(provider or "").strip().lower(), model=model or "",
            task_id=str(task_id), scene_id=scene_id(section_index),
            section_index=int(section_index), prompt_hash=phash,
            submitted_at=now, status=STATUS_SUBMITTED, updated_at=now,
        )
        self.tasks.append(task)
        self._save()
        return task

    def record_outcome(self, task: ProviderTask, outcome: TaskOutcome) -> None:
        """Fold a poll outcome into the task. ``pending`` keeps it ``submitted``
        so the next attempt polls it again rather than paying for a new one."""
        if outcome.state == OUTCOME_SUCCEEDED and outcome.path is not None:
            task.status = STATUS_SUCCEEDED
            task.local_path = str(outcome.path)
        elif outcome.state == OUTCOME_FAILED:
            task.status = STATUS_FAILED
        else:
            task.status = STATUS_SUBMITTED
        task.updated_at = _now_iso()
        self._save()


def supports_resume(client) -> bool:
    """True when ``client`` exposes the split submit/resume API.

    Extension point: a provider client opts in by setting the class attribute
    ``supports_task_resume = True`` and implementing ``submit(spec) ->
    Optional[str]`` and ``resume(task_id, out_path) -> TaskOutcome``. A client
    without it (or a test double) keeps the one-shot ``generate(spec, out_path)``
    path and is simply not persisted. The ``is True`` check is deliberate: a
    ``MagicMock`` answers every attribute and must not be mistaken for opting in.
    """
    return getattr(client, "supports_task_resume", False) is True
