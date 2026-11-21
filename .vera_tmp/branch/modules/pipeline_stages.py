"""Pipeline stage state machine — structural enforcement of the approval chain.

This module encodes, as executable state, the project's non-negotiable rule:

    Topic -> Research -> Script -> Fact Check -> Human Approval -> Publish

Automation may prepare and analyze content at every stage, but the final
PUBLISH transition is an irreversible, real-world action (an upload to
YouTube). This state machine makes it structurally impossible to reach
PUBLISH without both (a) passing through every earlier stage in order, and
(b) an explicit, separately-recorded human approval. Sequence order alone
is never sufficient to reach PUBLISH — see `advance()` below.

STATUS: this is the record of how far a run got, not the thing that stops an
upload. main.py advances every run to HUMAN_APPROVAL and nothing calls
`approve()` (tools/approve_run.py only records it by hand); the upload path
never reads this state. What can hold or block a real upload is
modules/publish_gate.py and, for a channel that requires two people,
modules/publish_approval.py.

PERSISTENCE NOTE: This module uses its own minimal JSON-file store
(`PipelineStateMachine`), not modules/state_store.py. The public API
(`start_run`, `advance`, `approve`, `get_run`, `list_runs`) is intended to
remain stable if the storage is ever moved there.
"""

from __future__ import annotations

import enum
import json
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import HISTORY_DIR

# Mirrors modules.channels.DEFAULT_CHANNEL_ID, kept local so the state machine
# has no import dependency on the channel model.
DEFAULT_CHANNEL_ID = "default"


class PipelineStage(enum.Enum):
    """Ordered stages of the content pipeline.

    Declaration order below *is* the enforced order — PipelineStateMachine
    walks `list(PipelineStage)` to determine what "the next stage" means for
    any given run, so this order is not just documentation, it is the
    mechanism that "no skipping ahead" is built on.
    """

    TOPIC = "topic"
    RESEARCH = "research"
    SCRIPT = "script"
    FACT_CHECK = "fact_check"
    HUMAN_APPROVAL = "human_approval"
    PUBLISH = "publish"


# Declared order, computed once from the enum's own declaration order.
_STAGE_ORDER = list(PipelineStage)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class StageTransition:
    stage: PipelineStage
    timestamp: str
    note: str = ""

    def to_dict(self) -> dict:
        return {"stage": self.stage.value, "timestamp": self.timestamp, "note": self.note}

    @staticmethod
    def from_dict(d: dict) -> "StageTransition":
        return StageTransition(
            stage=PipelineStage(d["stage"]),
            timestamp=d["timestamp"],
            note=d.get("note", ""),
        )


@dataclass
class PipelineRun:
    run_id: str
    topic: str
    current_stage: PipelineStage
    history: list = field(default_factory=list)  # list[StageTransition]
    human_approved: bool = False
    approved_by: Optional[str] = None
    approved_at: Optional[str] = None
    channel_id: str = DEFAULT_CHANNEL_ID

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "topic": self.topic,
            "current_stage": self.current_stage.value,
            "history": [t.to_dict() for t in self.history],
            "human_approved": self.human_approved,
            "approved_by": self.approved_by,
            "approved_at": self.approved_at,
            "channel_id": self.channel_id,
        }

    @staticmethod
    def from_dict(d: dict) -> "PipelineRun":
        return PipelineRun(
            run_id=d["run_id"],
            topic=d["topic"],
            current_stage=PipelineStage(d["current_stage"]),
            history=[StageTransition.from_dict(t) for t in d.get("history", [])],
            human_approved=d.get("human_approved", False),
            approved_by=d.get("approved_by"),
            approved_at=d.get("approved_at"),
            # Runs recorded before Phase 5 belong to the default channel.
            channel_id=d.get("channel_id") or DEFAULT_CHANNEL_ID,
        )


class PipelineStateMachine:
    """Enforces the Topic -> ... -> Publish approval chain for pipeline runs.

    Persistence is a simple write-through JSON file (read on each call,
    written on each mutation). This is intentionally minimal — a placeholder
    until the shared `state_store` module (being built on a sibling branch)
    merges and can take over storage duties. Fine at this project's scale
    (a handful of runs at a time, single process).
    """

    def __init__(self, store_path: Optional[Path] = None, channel_id: str = DEFAULT_CHANNEL_ID):
        """`channel_id` is the channel new runs are started for. Approval and
        stage transitions are addressed by run_id and so are unaffected by it;
        one file holds every channel's runs."""
        self.channel_id = channel_id
        self.store_path = Path(store_path) if store_path is not None else (HISTORY_DIR / "pipeline_runs.json")

    # -- storage -----------------------------------------------------

    def _load_all(self) -> dict:
        if not self.store_path.exists():
            return {}
        raw = self.store_path.read_text().strip()
        if not raw:
            return {}
        data = json.loads(raw)
        return {run_id: PipelineRun.from_dict(rd) for run_id, rd in data.items()}

    def _save_all(self, runs: dict) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        serializable = {run_id: run.to_dict() for run_id, run in runs.items()}
        self.store_path.write_text(json.dumps(serializable, indent=2, ensure_ascii=False))

    # -- public API ----------------------------------------------------

    def start_run(self, topic: str, channel_id: Optional[str] = None) -> PipelineRun:
        """Create a new pipeline run at PipelineStage.TOPIC and persist it.

        `channel_id` defaults to the machine's own channel, so an existing
        single-argument caller records a default-channel run exactly as before.
        """
        run_id = uuid.uuid4().hex[:12]
        run = PipelineRun(
            run_id=run_id,
            topic=topic,
            current_stage=PipelineStage.TOPIC,
            history=[StageTransition(stage=PipelineStage.TOPIC, timestamp=_now_iso(), note="run started")],
            channel_id=channel_id or self.channel_id,
        )
        runs = self._load_all()
        runs[run_id] = run
        self._save_all(runs)
        return run

    def advance(self, run_id: str, to_stage: PipelineStage, note: str = "") -> PipelineRun:
        """Advance a run to `to_stage`.

        Rejects (raises ValueError) any transition that is not exactly the
        next stage in the declared PipelineStage order — no skipping ahead,
        no moving backward, no advancing a run already at PUBLISH.

        Special case: advancing INTO PipelineStage.PUBLISH additionally,
        independently requires `run.human_approved is True`. This check is
        never implied by sequence order alone — even a run correctly sitting
        at HUMAN_APPROVAL with PUBLISH as its rightful next stage cannot
        advance to PUBLISH without having gone through `approve()` first.
        """
        runs = self._load_all()
        run = runs.get(run_id)
        if run is None:
            raise ValueError(f"No such pipeline run: {run_id!r}")

        current_index = _STAGE_ORDER.index(run.current_stage)
        try:
            target_index = _STAGE_ORDER.index(to_stage)
        except ValueError:
            raise ValueError(f"Unknown pipeline stage: {to_stage!r}")

        if target_index != current_index + 1:
            raise ValueError(
                f"Illegal stage transition for run {run_id!r}: "
                f"cannot advance from {run.current_stage.value!r} to {to_stage.value!r}. "
                f"The next legal stage is "
                + (
                    _STAGE_ORDER[current_index + 1].value
                    if current_index + 1 < len(_STAGE_ORDER)
                    else "none (run is already at the final stage)"
                )
                + "."
            )

        if to_stage == PipelineStage.PUBLISH and not run.human_approved:
            raise ValueError(
                f"Cannot advance run {run_id!r} to PUBLISH: human approval has not been "
                "granted. Call PipelineStateMachine.approve() while the run is at "
                "HUMAN_APPROVAL before advancing to PUBLISH."
            )

        run.current_stage = to_stage
        run.history.append(StageTransition(stage=to_stage, timestamp=_now_iso(), note=note))
        runs[run_id] = run
        self._save_all(runs)
        return run

    def approve(self, run_id: str, approved_by: str) -> PipelineRun:
        """Grant human approval for a run.

        This is the ONLY method in this class that may set
        `run.human_approved = True`. Requires the run to currently be at
        PipelineStage.HUMAN_APPROVAL; raises ValueError otherwise, since
        approval cannot be meaningfully granted before the run has actually
        reached the human-approval step.
        """
        runs = self._load_all()
        run = runs.get(run_id)
        if run is None:
            raise ValueError(f"No such pipeline run: {run_id!r}")

        if run.current_stage != PipelineStage.HUMAN_APPROVAL:
            raise ValueError(
                f"Cannot approve run {run_id!r}: run is at stage "
                f"{run.current_stage.value!r}, not {PipelineStage.HUMAN_APPROVAL.value!r}."
            )

        run.human_approved = True
        run.approved_by = approved_by
        run.approved_at = _now_iso()
        runs[run_id] = run
        self._save_all(runs)
        return run

    def get_run(self, run_id: str) -> Optional[PipelineRun]:
        runs = self._load_all()
        return runs.get(run_id)

    def list_runs(self, channel_id: Optional[str] = None) -> list:
        """Every run, or only one channel's when `channel_id` is given.

        Unfiltered by default: the Supabase mirror wants all of them, and a
        caller that predates channels expects all of them.
        """
        runs = list(self._load_all().values())
        if channel_id is not None:
            runs = [r for r in runs if r.channel_id == channel_id]
        return runs
