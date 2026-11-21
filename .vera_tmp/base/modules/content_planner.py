"""Content Planner — a lightweight topic queue sitting *before* the real
approval pipeline even starts.

A prior audit of this project found that content planning / a content
calendar was entirely absent from the codebase: no file, no queue, no
calendar of any kind existed anywhere. This module fills that gap.

Where this sits relative to ``pipeline_stages.py``
----------------------------------------------------
``pipeline_stages.PipelineStateMachine`` enforces the *approval chain* for a
topic that has already been chosen and is being worked on: Topic -> Research
-> Script -> Fact Check -> Human Approval -> Publish. It answers "is this run
allowed to move to the next stage yet?".

This module answers a different, earlier question: "what topic should we
attempt next?" ``ContentPlanner`` is a simple FIFO queue of candidate topics
— things worth making a video about — collected from wherever they come
from (a manual add, a `ContentOpportunity` produced by
``content_opportunity.ContentOpportunityEngine``, a Gemini brainstorm pick,
etc.), each carrying a lightweight lifecycle status:
``queued`` → ``reserved`` (a run claimed it) → ``rendered`` (its video is on
disk) → ``published`` (upload succeeded), with ``skipped`` for a hard-blocked
duplicate and ``rejected`` for a topic the selection gate refused to use
(``modules/topic_gate.py``: off the channel's niche, needs a human, or stale),
which carries one closed reason word and is never served again. It is
deliberately NOT a strict state machine — nothing here
*enforces* the ordering, and callers advance an entry as far as their run
actually got — just a durable list with dedup, a "give me the next thing to
work on" accessor, and honest status: a run advances an entry to ``published``
only on a real upload success, never the moment the topic is picked. Once a topic is pulled off this queue,
``topic_manager.py`` checks it (dedup, niche gate) and reserves it, and
``main.py`` hands the run to ``PipelineStateMachine.start_run()``; none of that
hand-off lives in this module.

Decoupling from ``content_opportunity.ContentOpportunity``
------------------------------------------------------------
``enqueue_opportunity()`` accepts anything duck-typed with ``.topic``,
``.source``, and ``.rationale`` attributes. It deliberately does NOT import
the real ``ContentOpportunity`` dataclass, to avoid a hard dependency on a
sibling module the same way ``content_opportunity.py`` itself avoids
importing its own siblings' dataclasses (``VideoSnapshot``, ``DemandSignal``,
etc.) and instead works off plain dicts. This keeps the two modules
mergeable independently regardless of merge order.

Dedup scope — exact-string, queued-only (NOT semantic)
----------------------------------------------------------
``enqueue()`` refuses to create a second ``"queued"`` entry for a topic
string that already has a ``"queued"`` entry, using plain exact string
equality. This is intentionally NOT semantic/near-duplicate detection —
catching "The Fall of Rome" vs. "Rome's Collapse" as the same topic is a
job for ``modules/originality_engine.py``, which already does semantic
similarity checking via model2vec. That module needs a model load and
(depending on configuration) network access; making a topic *queue insert*
depend on that is a deliberate choice NOT made here. Wiring
``originality_engine`` in as a stronger pre-enqueue (or pre-publish) check
is an explicit follow-up, not part of this module.

Dedup only ever considers *currently-queued* entries, never
``"published"`` or ``"skipped"`` ones — a topic that was already published
(or skipped) must remain re-enqueue-able later (e.g. a yearly recurring
topic, or a topic worth retrying after being skipped for an unrelated
reason). Blocking re-enqueue forever after a single publish/skip is
explicitly NOT the intent.

PERSISTENCE NOTE: like ``pipeline_stages.py``, this module uses its own
minimal JSON-file store as a deliberate placeholder, not a new
``state_store`` table. Simple write-through (read on each call, write on
each mutation) is plenty at this project's scale. If/when the shared
``state_store`` module needs to take over storage duties project-wide, this
class's persistence can be swapped out behind its stable public API
(``enqueue``, ``enqueue_opportunity``, ``next_topic``, ``mark_published``,
``mark_skipped``, ``list_entries``) — mirroring the same swap already
flagged in ``pipeline_stages.py``.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Union

from config import HISTORY_DIR

logger = logging.getLogger(__name__)

# Mirrors modules.channels.DEFAULT_CHANNEL_ID, kept local so the queue has no
# import dependency on the channel model.
DEFAULT_CHANNEL_ID = "default"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class CalendarEntry:
    """One queued (or resolved) topic candidate in the content calendar."""

    entry_id: str
    topic: str
    added_at: str
    source: str
    rationale: str = ""
    # Lifecycle: "queued" → "reserved" (a run claimed it and is attempting it)
    # → "rendered" (its video exists on disk) → "published" (upload succeeded).
    # "skipped" is the dead end for a hard-blocked duplicate. An entry ends at
    # the furthest state its run actually reached: a run that renders but cannot
    # upload leaves "rendered" (a real video awaiting a human), never a false
    # "published". A run that dies before rendering leaves "reserved" — visibly
    # stuck, which is the honest record, not silently marked done.
    #
    # "rejected" is the dead end for a topic the selection gate refused
    # (modules/topic_gate.py), with ``reject_reason`` one of its closed words.
    # It is never served again, and an entry that was rejected for what the
    # topic IS (off_niche, needs_human) also stops the same text being queued a
    # second time - see ContentPlanner.enqueue.
    status: str = "queued"  # queued | reserved | rendered | published | skipped | rejected
    channel_id: str = DEFAULT_CHANNEL_ID
    reject_reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "CalendarEntry":
        return CalendarEntry(
            entry_id=d["entry_id"],
            topic=d["topic"],
            added_at=d["added_at"],
            source=d.get("source", ""),
            rationale=d.get("rationale", ""),
            status=d.get("status", "queued"),
            # Entries written before Phase 5 have no channel — they are the
            # default channel's, which is what the backfill says everywhere else.
            channel_id=d.get("channel_id") or DEFAULT_CHANNEL_ID,
            reject_reason=d.get("reject_reason") or "",
        )


#: Reasons that are a judgement about the TOPIC itself. A topic rejected for one
#: of these is not queued a second time by the trend poll: it would only be
#: rejected again, and the model-assisted check would be paid for again. "stale"
#: is about the entry's age, so the same topic may legitimately come back.
TOPIC_REJECTION_REASONS = ("off_niche", "needs_human")
#: Every reason ``mark_rejected`` accepts. Mirrors modules/topic_gate.REASONS;
#: kept here as a literal so the queue has no import dependency on the gate.
REJECT_REASONS = TOPIC_REJECTION_REASONS + ("stale",)


class ContentPlanner:
    """A durable FIFO queue of candidate video topics awaiting a real run.

    Persistence is a simple write-through JSON file (read on each call,
    written on each mutation) — deliberately lightweight, mirroring the
    same choice (and the same "placeholder, not a new state_store table"
    caveat) made in ``pipeline_stages.PipelineStateMachine``. Fine at this
    project's scale (a handful of queued topics at a time, single process).
    """

    def __init__(
        self,
        store_path: Optional[Union[Path, str]] = None,
        channel_id: str = DEFAULT_CHANNEL_ID,
    ):
        """`channel_id` is the channel this planner enqueues for and, unless a
        caller asks otherwise, the only channel it reads back. One shared file
        holds every channel's entries; the filtering is what keeps a Finance
        topic from ever being handed to the History pipeline."""
        self.channel_id = channel_id
        self.store_path = (
            Path(store_path) if store_path is not None else (HISTORY_DIR / "content_calendar.json")
        )

    # -- storage -----------------------------------------------------

    def _load_all(self) -> dict:
        if not self.store_path.exists():
            return {}
        raw = self.store_path.read_text().strip()
        if not raw:
            return {}
        data = json.loads(raw)
        return {entry_id: CalendarEntry.from_dict(ed) for entry_id, ed in data.items()}

    def _save_all(self, entries: dict) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        serializable = {entry_id: entry.to_dict() for entry_id, entry in entries.items()}
        self.store_path.write_text(json.dumps(serializable, indent=2, ensure_ascii=False))

    # -- public API ----------------------------------------------------

    def enqueue(self, topic: str, source: str = "manual", rationale: str = "") -> CalendarEntry:
        """Add `topic` to the queue with status="queued".

        Dedup is exact-string match against currently-``"queued"`` entries
        only (see module docstring for why this is not semantic, and why
        ``"published"``/``"skipped"`` entries never block re-enqueueing).
        If a matching queued entry already exists, that existing entry is
        returned unchanged instead of creating a duplicate.
        """
        entries = self._load_all()
        for entry in entries.values():
            # Dedup is per channel: two channels may legitimately both queue
            # "The Fall of Rome" — they are different videos.
            if (
                entry.topic == topic
                and entry.status == "queued"
                and entry.channel_id == self.channel_id
            ):
                logger.info("Duplicate queued topic %r — reusing entry %s", topic, entry.entry_id)
                return entry
            # A topic the gate rejected for what it IS stays rejected: the poll
            # that found it trending will find it again tomorrow.
            if (
                entry.topic == topic
                and entry.status == "rejected"
                and entry.reject_reason in TOPIC_REJECTION_REASONS
                and entry.channel_id == self.channel_id
            ):
                logger.info("Topic %r was rejected (%s) by the selection gate - not queueing it again (entry %s)",
                            topic, entry.reject_reason, entry.entry_id)
                return entry

        entry_id = uuid.uuid4().hex[:12]
        entry = CalendarEntry(
            entry_id=entry_id,
            topic=topic,
            added_at=_now_iso(),
            source=source,
            rationale=rationale,
            status="queued",
            channel_id=self.channel_id,
        )
        entries[entry_id] = entry
        self._save_all(entries)
        return entry

    def enqueue_opportunity(self, opportunity) -> CalendarEntry:
        """Convenience wrapper around `enqueue()` for a ContentOpportunity-
        shaped object.

        Duck-typed: accepts anything with `.topic`, `.source`, and
        `.rationale` attributes. Does NOT import the real
        `content_opportunity.ContentOpportunity` dataclass — see module
        docstring.
        """
        return self.enqueue(
            topic=opportunity.topic,
            source=f"content_opportunity:{opportunity.source}",
            rationale=opportunity.rationale,
        )

    def next_topic(self, skip=()) -> Optional[CalendarEntry]:
        """Return the oldest still-`"queued"` entry (FIFO by `added_at`), or
        None if the queue is empty. Peeking only — does not mutate status.

        `skip` is a collection of entry ids to pass over: how a caller moves on
        to the next candidate when it has set one aside for this run without
        changing it (the selection gate could not confirm it this time).
        """
        skip = set(skip)
        queued = [
            e
            for e in self._load_all().values()
            if e.status == "queued" and e.channel_id == self.channel_id and e.entry_id not in skip
        ]
        if not queued:
            return None
        return min(queued, key=lambda e: e.added_at)

    def _set_status(self, entry_id: str, status: str) -> CalendarEntry:
        entries = self._load_all()
        entry = entries.get(entry_id)
        if entry is None:
            raise ValueError(f"No such calendar entry: {entry_id!r}")
        entry.status = status
        entries[entry_id] = entry
        self._save_all(entries)
        return entry

    def reserve(self, entry_id: str) -> CalendarEntry:
        """Claim `entry_id` for a run that is about to attempt it: status
        "reserved". This is what `next_topic` + `reserve` replace the old
        pick-time `mark_published` with — the entry is not "done" the moment it
        is chosen, only claimed. `next_topic` returns "queued" entries only, so
        a reserved entry is never handed to a second run. Raises ValueError for
        an unknown id."""
        return self._set_status(entry_id, "reserved")

    def mark_rendered(self, entry_id: str) -> CalendarEntry:
        """Mark `entry_id` as "rendered": its video exists on disk. Reached
        whether or not the upload later succeeds, so a video that is rendered
        but blocked or fails to upload is honestly "rendered", not "published".
        Raises ValueError for an unknown id."""
        return self._set_status(entry_id, "rendered")

    def mark_published(self, entry_id: str) -> CalendarEntry:
        """Mark `entry_id` as "published" — the upload actually succeeded. Called
        at real upload success, never at pick time. Raises ValueError for an
        unknown id."""
        return self._set_status(entry_id, "published")

    def mark_skipped(self, entry_id: str, reason: str = "") -> CalendarEntry:
        """Mark `entry_id` as "skipped", appending `reason` (if given) to its
        rationale. Raises ValueError for an unknown id.
        """
        entries = self._load_all()
        entry = entries.get(entry_id)
        if entry is None:
            raise ValueError(f"No such calendar entry: {entry_id!r}")
        entry.status = "skipped"
        if reason:
            entry.rationale = f"{entry.rationale} [skipped: {reason}]".strip()
        entries[entry_id] = entry
        self._save_all(entries)
        return entry

    def mark_rejected(self, entry_id: str, reason: str) -> CalendarEntry:
        """Mark `entry_id` as "rejected" with one closed `reason` word
        (REJECT_REASONS): the selection gate refused to use this topic, and it
        is never served again. The word is also appended to the rationale as
        "[rejected: <reason>]" so the mirrored queue shows it without a schema
        change. Raises ValueError for an unknown id or a reason outside the
        closed set - a free-text reason here would be a log line pretending to
        be state."""
        if reason not in REJECT_REASONS:
            raise ValueError(f"Unknown rejection reason: {reason!r} (expected one of {REJECT_REASONS})")
        entries = self._load_all()
        entry = entries.get(entry_id)
        if entry is None:
            raise ValueError(f"No such calendar entry: {entry_id!r}")
        entry.status = "rejected"
        entry.reject_reason = reason
        entry.rationale = f"{entry.rationale} [rejected: {reason}]".strip()
        entries[entry_id] = entry
        self._save_all(entries)
        return entry

    def list_entries(
        self, status: Optional[str] = None, channel_id: Optional[str] = ""
    ) -> list:
        """Entries oldest first, optionally filtered by `status`.

        `channel_id` defaults to this planner's own channel. Pass None for
        every channel — what the Supabase mirror does, so the Command Center can
        show one channel or all of them.
        """
        entries = list(self._load_all().values())
        wanted = self.channel_id if channel_id == "" else channel_id
        if wanted is not None:
            entries = [e for e in entries if e.channel_id == wanted]
        if status is not None:
            entries = [e for e in entries if e.status == status]
        entries.sort(key=lambda e: e.added_at)
        return entries
