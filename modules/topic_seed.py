"""A channel's past topics, read back from Supabase. READ ONLY.

``history/topics.json`` is the bot's memory of what each channel has already made, and it lives in the Actions
cache, which GitHub evicts after 7 days unused. A pause longer than a week, or a cache that failed to save, used
to make the bot forget everything it had made and pick the same topics again. Every video the pipeline makes
(uploaded, held for review or blocked by the publish gate) also has a ``videos`` row in Supabase with its
``topic`` and ``title`` (migration 0016 for the held ones), so the memory can be rebuilt from there.

This module only reads, with the same strict helper the rest of the bot uses (``SupabaseSync.select_strict``).
Nothing is ever written to Supabase from here. The caller (``TopicManager.seed_history_from_supabase``) merges
the result into the local file in its existing format, and treats ``None`` ("could not find out") as "carry on
with whatever the local history has".

Topics and titles are untrusted data: they are cleaned here (control characters and runs of whitespace out,
length capped) and are never logged or put in an event by anything in this path; only counts are.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
MAX_SEED_CHARS = 200
_COLUMNS = "video_id,topic,title,published_at,held_at,video_format,parent_video_id"
_ROW_LIMIT = "400"


def _when(value):
    """An aware UTC datetime from a database timestamp, or None."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _clean(value) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(_CONTROL.sub(" ", value).split())[:MAX_SEED_CHARS]


def _is_master(row: dict) -> bool:
    """A channel's own video, not a repurposed Short of it (the short's topic is its master's)."""
    return (row.get("video_format") or "long") != "short" and not row.get("parent_video_id")


def _read(sync, channel_id: str, cutoff: str) -> list:
    """The channel's videos made or held since ``cutoff``. The two time columns are different types (text and
    timestamptz), so each is its own query. A server that lacks a column (a migration not applied) is retried with
    the oldest, narrowest read; if that fails too the error propagates."""
    base = {"channel_id": f"eq.{channel_id}"}
    try:
        rows = []
        for column in ("published_at", "held_at"):
            rows += sync.select_strict("videos", {**base, "select": _COLUMNS, column: f"gte.{cutoff}",
                                                  "order": f"{column}.desc", "limit": _ROW_LIMIT})
        return rows
    except Exception:  # noqa: BLE001 - narrowed below; a second failure is the caller's
        return sync.select_strict("videos", {**base, "select": "video_id,topic,title,published_at",
                                             "published_at": f"gte.{cutoff}", "order": "published_at.desc",
                                             "limit": _ROW_LIMIT})


def recent_topics(sync, channel_id: str, *, days: int, limit: int, now=None):
    """``[{"topic", "date", "video_id"}]`` oldest first: this channel's last ``limit`` distinct topics made in
    the last ``days`` days, in the format ``topics.json`` keeps. An empty list means the channel has none; ``None``
    means Supabase is not configured or could not be read, which is not the same thing. Never raises."""
    if sync is None or not getattr(sync, "enabled", False):
        return None
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        raw = _read(sync, channel_id, cutoff)
    except Exception:  # noqa: BLE001 - the caller carries on with the local history
        return None

    best: dict = {}
    for row in raw:
        if not isinstance(row, dict) or not _is_master(row):
            continue
        topic = _clean(row.get("topic")) or _clean(row.get("title"))
        when = max((w for w in (_when(row.get("published_at")), _when(row.get("held_at"))) if w), default=None)
        if not topic or when is None or when < now - timedelta(days=days):
            continue
        key = topic.casefold()
        if key not in best or when > best[key][0]:
            best[key] = (when, topic, row.get("video_id"))
    newest = sorted(best.values(), key=lambda x: x[0])[-limit:]
    return [{"topic": t, "date": w.isoformat(), "video_id": v if isinstance(v, str) and v else None}
            for w, t, v in newest]


#: ``hold_detail.stage`` main.py writes for a run the fact-check stopped before the voice and the render.
BEFORE_RENDER = "before_render"


def held_before_render_topics(sync, channel_id: str, *, days: int, now=None):
    """This channel's topics of runs held before the render in the last ``days`` days, oldest first, distinct.

    A run held there never reaches ``register_topic``, so its topic is in no history file and the picker would
    propose it again. Its ``videos`` row (state ``blocked``, ``held_at``, ``hold_detail.stage``) already says so; this
    only reads it. A row that has since been uploaded (``published_at`` set) is a published video, not a held one,
    and is left to the published history. ``[]`` means none; ``None`` means Supabase is not configured or could not
    be read (a database without migration 0016 reads this way too), which is not the same thing. Never raises."""
    if days <= 0 or sync is None or not getattr(sync, "enabled", False):
        return None
    now = now or datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    try:
        raw = sync.select_strict("videos", {
            "channel_id": f"eq.{channel_id}", "select": "video_id,topic,published_at,held_at,hold_detail",
            "held_at": f"gte.{start.strftime('%Y-%m-%dT%H:%M:%SZ')}", "order": "held_at.desc", "limit": _ROW_LIMIT})
    except Exception:  # noqa: BLE001 - the caller carries on without the cooldown
        return None
    best: dict = {}
    for row in raw:
        if not isinstance(row, dict) or row.get("published_at"):
            continue
        detail = row.get("hold_detail")
        if not isinstance(detail, dict) or detail.get("stage") != BEFORE_RENDER:
            continue
        topic = _clean(row.get("topic"))
        when = _when(row.get("held_at"))
        if not topic or when is None or when < start:
            continue
        key = topic.casefold()
        if key not in best or when > best[key][0]:
            best[key] = (when, topic)
    return [t for _, t in sorted(best.values(), key=lambda x: x[0])]
