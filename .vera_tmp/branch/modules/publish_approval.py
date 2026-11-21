"""Two-person publish approval — the pipeline side (migration 0009).

Migration ``0009_publish_approvals`` delivered the ``publish_approvals`` table,
its RLS (a valid approval has ``decided_by <> requested_by`` — a second admin,
never the requester), and the Command Center plumbing, but deliberately left the
pipeline half for later: nothing in the bot consulted an approved row before a
video could go public. This module is that half.

It is a **guard**, and a fail-safe one. Uploads are private by default across
the schedule, the dispatch and ``config.YOUTUBE_PRIVACY``, so the only way a run
puts a video PUBLIC is an explicit ``privacy=public``. For a channel that has
turned on ``require_two_person_publish``, that public step must be authorised by
an approved ``publish_approvals`` row whose ``video_ref`` names this run; without
one, the caller holds the video for review exactly as auto-publish-off does.

Fail-safe means: any doubt resolves to "not approved". A disabled Supabase, a
network error, a malformed row — each returns False, so the guard never lets a
video go public because a *check* failed. Nothing here raises.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable, Optional

logger = logging.getLogger(__name__)


def _matches(video_ref, refs_lower: set[str]) -> bool:
    """Whether an approval's ``video_ref`` authorises a run identified by any of
    ``refs_lower`` (this run's slug and topic, lower-cased).

    A null/blank ``video_ref`` is deliberately NOT a blanket approval: it would
    silently authorise every future public run on the channel. An approval must
    name the content it approves, so a second admin signs off on THIS video, not
    on a standing permission. Autonomous runs (whose topic the AI picks) are
    private by default and simply stay held — which is the safe outcome.
    """
    if video_ref is None:
        return False
    vr = str(video_ref).strip().lower()
    return bool(vr) and vr in refs_lower


def _parse_ts(value) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def has_approved(
    channel_id: str,
    *,
    slug: Optional[str] = None,
    topic: Optional[str] = None,
    sync=None,
    not_before: Optional[str] = None,
) -> bool:
    """True when an approved ``publish_approvals`` row authorises this run to go
    public. False on any doubt (disabled sync, no row, network/parse failure).

    ``slug`` and ``topic`` identify the run; an approval authorises it when its
    ``video_ref`` matches either (case-insensitive). ``sync`` is an optional
    injected SupabaseSync (for tests); the default builds one from the
    environment.

    ``not_before`` (ISO time): when this run's cut last changed after review —
    a targeted scene repair (``scene_repair.repaired_at``). An approval decided
    before it approved a cut that no longer exists and does not count; one with
    no ``decided_at`` cannot be shown to be newer and does not count either. An
    unparseable ``not_before`` means nothing counts (fail-safe).
    """
    cutoff = None
    if not_before:
        cutoff = _parse_ts(not_before)
        if cutoff is None:
            return False
    refs_lower = {str(r).strip().lower() for r in (slug, topic) if r and str(r).strip()}
    if not refs_lower:
        # Nothing to match an approval against — treat as unapproved rather than
        # guess. A public run always has at least a slug, so this is only the
        # pathological empty case.
        return False
    try:
        client = sync
        if client is None:
            from modules.supabase_sync import SupabaseSync
            client = SupabaseSync()
        if not getattr(client, "enabled", False):
            return False
        rows: Iterable[dict] = client.select(
            "publish_approvals",
            {
                "channel_id": f"eq.{channel_id}",
                "status": "eq.approved",
                "select": "video_ref,decided_by,requested_by,decided_at",
            },
        )
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            decided = row.get("decided_by")
            requested = row.get("requested_by")
            # The DB RLS already enforces this, but a publish decision is never
            # trusted to a single source: a real two-person approval has a
            # decider who exists and is not the requester.
            if not decided or decided == requested:
                continue
            if cutoff is not None:
                decided_at = _parse_ts(row.get("decided_at")) if row.get("decided_at") else None
                if decided_at is None or decided_at < cutoff:
                    continue
            if _matches(row.get("video_ref"), refs_lower):
                return True
        return False
    except Exception as e:  # never let a check failure become a publish
        logger.warning(
            "publish_approval check failed (%s: %s) — treating as NOT approved",
            type(e).__name__, e,
        )
        return False
