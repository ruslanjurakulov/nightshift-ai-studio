"""State durability — a local backup of the history, and a health signal for
whether it is safely mirrored off the ephemeral box.

The pipeline's history (published videos and their metrics) lives in a SQLite
StateStore inside a container that is reclaimed on restart. `supabase_sync`
already mirrors that history to Supabase when configured; this module adds two
things around it:

1. **A plain-JSON snapshot** — `write_snapshot` dumps the video history and each
   video's latest metrics to one file, a portable backup that survives outside
   the DB and can be inspected or archived. Read-only over the store; never
   writes to it.
2. **A mirror-health check** — `check_mirrored` compares the local video count
   to what Supabase holds and flags a gap, so an operator learns *before* a
   restart that the ephemeral history is not yet safe. Advisory only.

Both are best-effort and never raise: a durability check must never be the
reason a run or a poll fails. Nothing here deletes or overwrites history.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def snapshot(store, *, channel_id: Optional[str] = None, limit: int = 100000) -> dict:
    """A read-only snapshot of the video history and each video's latest
    metrics, as a plain dict. `channel_id` scopes it; None takes every channel.
    Never raises — a read failure yields an empty snapshot."""
    taken_at = datetime.now(timezone.utc).isoformat()
    videos = []
    try:
        videos = store.list_videos(limit=limit, channel_id=channel_id)
    except Exception as e:
        logger.warning("Durability snapshot could not read videos (%s: %s)", type(e).__name__, e)
        videos = []

    metrics = {}
    for v in videos:
        vid = v.get("video_id")
        if not vid:
            continue
        try:
            m = store.latest_metrics(vid)
        except Exception:
            m = None
        if m is not None:
            metrics[vid] = m

    return {
        "taken_at": taken_at,
        "channel_id": channel_id,
        "video_count": len(videos),
        "videos": videos,
        "latest_metrics": metrics,
    }


def write_snapshot(store, path, *, channel_id: Optional[str] = None) -> Optional[int]:
    """Write a JSON snapshot to `path`. Returns the number of videos written, or
    None if it could not be written. Never raises — a backup failure must not
    break the caller."""
    try:
        snap = snapshot(store, channel_id=channel_id)
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(snap, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        logger.info("Durability snapshot written: %s (%d videos)", p, snap["video_count"])
        return snap["video_count"]
    except Exception as e:
        logger.warning("Could not write durability snapshot to %s (%s: %s)",
                       path, type(e).__name__, e)
        return None


@dataclass(frozen=True)
class DurabilityReport:
    local_videos: int
    remote_videos: Optional[int]      # None = couldn't read the remote
    mirror_configured: bool

    @property
    def mirrored(self) -> bool:
        """True only when the remote is readable AND holds at least as many
        videos as the local store. An unreadable remote is *unknown*, not
        mirrored — it never reports safety it can't confirm."""
        return self.remote_videos is not None and self.remote_videos >= self.local_videos

    @property
    def gap(self) -> Optional[int]:
        """How many local videos are not yet reflected remotely, or None when
        the remote is unknown."""
        if self.remote_videos is None:
            return None
        return max(0, self.local_videos - self.remote_videos)

    def to_dict(self) -> dict:
        return {
            "local_videos": self.local_videos,
            "remote_videos": self.remote_videos,
            "mirror_configured": self.mirror_configured,
            "mirrored": self.mirrored,
            "gap": self.gap,
        }


def check_mirrored(store, sync=None, *, channel_id: Optional[str] = None) -> DurabilityReport:
    """Compare local video count to Supabase's, flagging an unmirrored gap.

    `sync` is a SupabaseSync (or anything with `.configured` and
    `.select(table, params)`); None or an unconfigured sync means the remote is
    unknown. Advisory only, never raises."""
    try:
        local = len(store.list_videos(limit=100000, channel_id=channel_id))
    except Exception as e:
        logger.warning("Durability check could not count local videos (%s: %s)", type(e).__name__, e)
        local = 0

    configured = bool(getattr(sync, "configured", False)) if sync is not None else False
    remote = None
    if configured:
        try:
            # Uploaded rows only: a held run's row (modules/held_video.py) has
            # no local counterpart by design, and counting it would hide a
            # real unmirrored gap.
            rows = sync.select("videos", {"select": "video_id", "published_at": "not.is.null"})
            remote = len(rows or [])
        except Exception as e:
            logger.warning("Durability check could not read remote videos (%s: %s)",
                           type(e).__name__, e)
            remote = None

    return DurabilityReport(local_videos=local, remote_videos=remote, mirror_configured=configured)


def run_durability_check(store, sync=None, *, snapshot_path=None,
                         channel_id: Optional[str] = None) -> DurabilityReport:
    """The entrypoint a scheduled backup job / the Command Center calls: write a
    JSON snapshot (when `snapshot_path` is given), check the mirror, and emit one
    `durability.check`. Returns the report. Advisory and never raises — it does
    not touch `intelligence_poller.run_all`, so it stays independent of the
    per-run poll. Wiring it into an actual schedule is a deliberate follow-up."""
    report = check_mirrored(store, sync, channel_id=channel_id)
    backed_up = None
    if snapshot_path is not None:
        backed_up = write_snapshot(store, snapshot_path, channel_id=channel_id)
    try:
        from modules import event_log as events

        meta = report.to_dict()
        if backed_up is not None:
            meta["snapshot_videos"] = backed_up
        events.emit(events.DURABILITY_CHECK, agent="durability",
                    status=events.STATUS_COMPLETED if report.mirrored else events.STATUS_FAILED,
                    channel_id=channel_id, metadata=meta)
        if not report.mirrored and report.mirror_configured:
            logger.warning("Durability: %s local video(s) not yet mirrored to Supabase",
                           report.gap)
    except Exception:
        logger.exception("Durability event emit failed; the check itself is unaffected")
    return report
