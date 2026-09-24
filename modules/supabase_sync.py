"""Supabase sync — mirror the local SQLite state into hosted Postgres so the
Command Center (a separate Next.js app on Vercel) can read real data.

Why this exists
---------------
The Python bot's state lives in `history/chronos.db`, which on the scheduled
GitHub Actions runners exists only for the life of one job (saved/restored via
`actions/cache`). Nothing outside CI can read it, so a hosted dashboard can't
show real data. This module mirrors the same rows into a Supabase Postgres
project; the Command Center then reads (and, via Supabase Realtime, live-
subscribes to) that hosted copy.

Configuration (both required to do anything):
  SUPABASE_URL          e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  the service-role key (server-side only — never ship it
                        to the browser; the dashboard uses the anon key)

When either is unset the sync is DISABLED and every method is a no-op returning
0. That is the graceful default: the bot runs exactly as before, entirely
local, until you create a Supabase project and set the two secrets. Apply
`supabase/schema.sql` to the project once (see docs/SUPABASE.md) before enabling.

Guarantees
----------
Like event_log, this never raises into the pipeline: a Supabase outage, a bad
key, or a network error is logged and swallowed, and the local DB remains the
source of truth. Writes use PostgREST upserts (idempotent), so re-running a
sync against unchanged data is safe and produces no duplicates.
"""

from __future__ import annotations

import logging
import os

import requests

logger = logging.getLogger(__name__)

_TIMEOUT = 15  # seconds — a slow Supabase must not hang a scheduled job for long.

# Each mirrored table and the column(s) PostgREST upserts on. These conflict
# targets must match the UNIQUE/PRIMARY KEY constraints in supabase/schema.sql.
_UPSERT_TABLES = {
    "videos": "video_id",
    "metrics_snapshots": "video_id,snapshot_date",
    "feedback_signals": "video_id,signal,analyzed_date",
    "topic_performance": "topic",
    "competitor_snapshots": "video_id,polled_date",
    "trending_snapshots": "video_id,polled_date,region_code",
    "content_queue": "entry_id",
    "pipeline_runs": "run_id",
    "channels": "channel_id",
    "channel_credentials": "channel_id,provider",
    "channel_topic_performance": "channel_id,topic",
    "retention_points": "video_id,elapsed_ratio,measured_date",
}

#: video_costs is append-only and has no natural key — a run that was retried
#: cost real money twice, and an upsert would collapse that into one charge.
_APPEND_TABLES = ("video_costs",)


class SupabaseSync:
    def __init__(self, url: str | None = None, service_key: str | None = None):
        self.url = (url if url is not None else os.getenv("SUPABASE_URL", "")).rstrip("/")
        self.service_key = service_key if service_key is not None else os.getenv("SUPABASE_SERVICE_KEY", "")
        self.enabled = bool(self.url and self.service_key)
        if not self.enabled:
            logger.info(
                "SupabaseSync disabled (SUPABASE_URL / SUPABASE_SERVICE_KEY not set) — "
                "running local-only; nothing is mirrored to the Command Center"
            )

    # -- low-level ---------------------------------------------------------

    def _headers(self, extra: dict | None = None) -> dict:
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": "application/json",
        }
        if extra:
            headers.update(extra)
        return headers

    def upsert(
        self,
        table: str,
        rows: list[dict],
        on_conflict: str | None = None,
        ignore_duplicates: bool = False,
    ) -> int:
        """Upsert `rows` into `table` via PostgREST. Returns the number sent (0
        when disabled, empty, or on any failure). Never raises.

        `ignore_duplicates=True` inserts only rows whose conflict key is new and
        leaves an existing row exactly as it is — for tables where a human's
        decision on a row must never be overwritten by the bot (learnings)."""
        if not self.enabled or not rows:
            return 0
        params = {}
        resolution = "ignore-duplicates" if ignore_duplicates else "merge-duplicates"
        prefer = f"resolution={resolution},return=minimal"
        if on_conflict:
            params["on_conflict"] = on_conflict
        try:
            resp = requests.post(
                f"{self.url}/rest/v1/{table}",
                params=params,
                json=rows,
                headers=self._headers({"Prefer": prefer}),
                timeout=_TIMEOUT,
            )
            if resp.status_code >= 300:
                logger.warning("Supabase upsert into %s failed: HTTP %s %s", table, resp.status_code, resp.text[:300])
                return 0
            return len(rows)
        except Exception as e:
            logger.warning("Supabase upsert into %s errored (%s: %s)", table, type(e).__name__, e)
            return 0

    def update(self, table: str, filters: dict, values: dict) -> bool:
        """PATCH the rows of `table` matching PostgREST `filters` (e.g.
        {"status": "eq.pending"}) with `values`. Returns True on success, False
        when disabled, unfiltered, or on any failure. Never raises.

        Refuses an empty filter: an unfiltered PATCH would rewrite every row."""
        if not self.enabled or not filters or not values:
            return False
        try:
            resp = requests.patch(
                f"{self.url}/rest/v1/{table}",
                params=filters,
                json=values,
                headers=self._headers({"Prefer": "return=minimal"}),
                timeout=_TIMEOUT,
            )
            if resp.status_code >= 300:
                logger.warning("Supabase update of %s failed: HTTP %s %s", table, resp.status_code, resp.text[:300])
                return False
            return True
        except Exception as e:
            logger.warning("Supabase update of %s errored (%s: %s)", table, type(e).__name__, e)
            return False

    def select(self, table: str, params: dict | None = None) -> list[dict]:
        """Read rows from `table` via PostgREST. Returns [] when disabled or on
        any failure. Never raises.

        The read counterpart of `upsert` — added so configuration the Command
        Center writes (channels) can be read back by the bot. Data still flows
        one way for *state*: the bot owns videos/metrics/events and only writes
        those; it only ever reads configuration.
        """
        if not self.enabled:
            return []
        try:
            resp = requests.get(
                f"{self.url}/rest/v1/{table}",
                params={"select": "*", **(params or {})},
                headers=self._headers(),
                timeout=_TIMEOUT,
            )
            if resp.status_code >= 300:
                logger.warning(
                    "Supabase select from %s failed: HTTP %s %s", table, resp.status_code, resp.text[:300]
                )
                return []
            data = resp.json()
            return data if isinstance(data, list) else []
        except Exception as e:
            logger.warning("Supabase select from %s errored (%s: %s)", table, type(e).__name__, e)
            return []

    # -- high-level --------------------------------------------------------

    def mirror_from_store(self, store, events_limit: int = 500) -> dict:
        """Mirror the current local state into Supabase and return per-table
        counts. Reads through the given StateStore. Never raises.

        Stateful tables are upserted on their natural keys (idempotent).
        Append-only system_events are upserted on a synthetic `event_key` built
        from the local row id + timestamp, so re-syncing the same events does
        not create duplicates.
        """
        if not self.enabled:
            return {}

        counts: dict[str, int] = {}

        # -- stateful tables (natural-key upserts) --
        readers = {
            "videos": lambda: store.list_videos(limit=100000),
            "metrics_snapshots": None,  # no bulk lister; handled below
            "feedback_signals": lambda: store.list_feedback_signals(limit=100000),
            "topic_performance": lambda: store.list_topic_performance(limit=100000),
            "channel_topic_performance": lambda: store.list_channel_topic_performance(limit=100000),
            "competitor_snapshots": lambda: store.list_competitor_snapshots(limit=100000),
            "trending_snapshots": lambda: store.list_trending_snapshots(limit=100000),
        }
        for table, reader in readers.items():
            if reader is None:
                continue
            try:
                rows = [self._strip_local_id(r) for r in reader()]
            except Exception as e:
                logger.warning("Failed reading %s for Supabase mirror (%s: %s)", table, type(e).__name__, e)
                continue
            counts[table] = self.upsert(table, rows, on_conflict=_UPSERT_TABLES[table])

        # -- metrics snapshots: gather per video (no bulk lister exists) --
        try:
            metrics_rows = self._gather_metrics(store)
            counts["metrics_snapshots"] = self.upsert(
                "metrics_snapshots", metrics_rows, on_conflict=_UPSERT_TABLES["metrics_snapshots"]
            )
        except Exception as e:
            logger.warning("Failed gathering metrics_snapshots for mirror (%s: %s)", type(e).__name__, e)

        # -- costs (append-only: no upsert, so a retried run shows both charges) --
        try:
            rows = [self._strip_local_id(r) for r in store.list_video_costs(limit=100000)]
            counts["video_costs"] = self.upsert("video_costs", rows)
        except Exception as e:
            logger.warning("Failed mirroring video_costs (%s: %s)", type(e).__name__, e)

        # -- retention curves --
        try:
            rows = self._gather_retention(store)
            counts["retention_points"] = self.upsert(
                "retention_points", rows, on_conflict=_UPSERT_TABLES["retention_points"]
            )
        except Exception as e:
            logger.warning("Failed mirroring retention_points (%s: %s)", type(e).__name__, e)

        # -- events (append-only, synthetic-key upsert) --
        try:
            events = store.list_events(limit=events_limit)
            event_rows = [self._event_row(e) for e in events]
            counts["system_events"] = self.upsert("system_events", event_rows, on_conflict="event_key")
        except Exception as e:
            logger.warning("Failed mirroring system_events (%s: %s)", type(e).__name__, e)

        logger.info("Supabase mirror complete: %s", counts)
        return counts

    def mirror_planner_and_runs(self, planner=None, machine=None) -> dict:
        """Mirror the two pieces of operational state the bot keeps on disk —
        ContentPlanner's queue and PipelineStateMachine's runs — into Supabase
        so the Command Center can see them.

        Purely additive observability: nothing reads these rows back into the
        pipeline, and the publish path is untouched. `human_approved` is
        mirrored as the audit-trail flag it already is; mirroring it does not
        gate anything.

        Constructs its own ContentPlanner / PipelineStateMachine when none is
        injected (tests inject fakes). Never raises — a failure here must not
        affect the poll that called it.
        """
        if not self.enabled:
            return {}

        counts: dict[str, int] = {}

        # -- content queue --
        try:
            if planner is None:
                from modules.content_planner import ContentPlanner

                planner = ContentPlanner()
            # Every channel's entries — the Command Center filters, the mirror does not.
            rows = [self._queue_row(e) for e in planner.list_entries(channel_id=None)]
            counts["content_queue"] = self.upsert(
                "content_queue", rows, on_conflict=_UPSERT_TABLES["content_queue"]
            )
        except Exception as e:
            logger.warning("Failed mirroring content_queue (%s: %s)", type(e).__name__, e)

        # -- pipeline runs --
        try:
            if machine is None:
                from modules.pipeline_stages import PipelineStateMachine

                machine = PipelineStateMachine()
            rows = [self._run_row(r) for r in machine.list_runs()]
            counts["pipeline_runs"] = self.upsert(
                "pipeline_runs", rows, on_conflict=_UPSERT_TABLES["pipeline_runs"]
            )
        except Exception as e:
            logger.warning("Failed mirroring pipeline_runs (%s: %s)", type(e).__name__, e)

        logger.info("Supabase operational mirror complete: %s", counts)
        return counts

    def mirror_channels(self, registry=None) -> dict:
        """Mirror channel *configuration presence* and *credential health* so
        the Command Center can render a real Channels view.

        Two deliberate asymmetries:

        * **Config flows UI -> Supabase -> bot**, not back. This method only
          bootstraps the `channels` table when it is empty (so a deployment
          that has never used the management UI still sees its real default
          channel instead of a blank page). Once rows exist, they are the
          source of truth and are left alone — mirroring a stale local
          channels.json over a Command Center edit would silently undo it.
        * **Credential health flows bot -> Supabase**, always. Only the server
          can see the token files, and only *status* is written:
          `channel_credentials` has no column that could hold a token. See
          modules/channel_credentials.py.

        Never raises.
        """
        if not self.enabled:
            return {}

        counts: dict[str, int] = {}
        try:
            if registry is None:
                from modules.channels import ChannelRegistry

                registry = ChannelRegistry(sync=self)
            channels = registry.list()
        except Exception as e:
            logger.warning("Failed loading channels for mirror (%s: %s)", type(e).__name__, e)
            return counts

        # -- bootstrap channel rows only when the table is empty --
        try:
            if not self.select("channels", {"select": "channel_id", "limit": "1"}):
                rows = [self._channel_row(c) for c in channels]
                counts["channels"] = self.upsert(
                    "channels", rows, on_conflict=_UPSERT_TABLES["channels"]
                )
        except Exception as e:
            logger.warning("Failed bootstrapping channels (%s: %s)", type(e).__name__, e)

        # -- credential health (status only, never a token) --
        try:
            from modules.channel_credentials import credential_status

            rows = [credential_status(c).to_dict() for c in channels]
            counts["channel_credentials"] = self.upsert(
                "channel_credentials", rows, on_conflict=_UPSERT_TABLES["channel_credentials"]
            )
        except Exception as e:
            logger.warning("Failed mirroring channel_credentials (%s: %s)", type(e).__name__, e)

        logger.info("Supabase channel mirror complete: %s", counts)
        return counts

    @staticmethod
    def _channel_row(channel) -> dict:
        """One ChannelContext as a `channels` row. `credential_ref` is the
        non-secret reference object — see modules/channels.CredentialRef."""
        d = channel.to_dict()
        return {
            "channel_id": d["channel_id"],
            "name": d["name"],
            "niche": d["niche"],
            "status": d["status"],
            "agent_config": d["agent_config"],
            "schedule_config": d["schedule_config"],
            "credential_ref": d["credential_ref"],
            "created_at": d["created_at"] or None,
            "updated_at": d["updated_at"] or None,
        }

    @staticmethod
    def _queue_row(entry) -> dict:
        """One CalendarEntry as a content_queue row."""
        d = entry.to_dict() if hasattr(entry, "to_dict") else dict(entry)
        return {
            "entry_id": d.get("entry_id"),
            "topic": d.get("topic"),
            "added_at": d.get("added_at"),
            "source": d.get("source") or None,
            "rationale": d.get("rationale") or None,
            "status": d.get("status") or "queued",
            "channel_id": d.get("channel_id") or "default",
        }

    @staticmethod
    def _run_row(run) -> dict:
        """One PipelineRun as a pipeline_runs row. `started_at` / `updated_at`
        are the first and last real stage-transition timestamps, so the Command
        Center can order runs without inventing a clock."""
        d = run.to_dict() if hasattr(run, "to_dict") else dict(run)
        history = d.get("history") or []
        stamps = [t.get("timestamp") for t in history if isinstance(t, dict) and t.get("timestamp")]
        stamps.sort()
        return {
            "run_id": d.get("run_id"),
            "topic": d.get("topic"),
            "current_stage": d.get("current_stage"),
            "human_approved": bool(d.get("human_approved", False)),
            "approved_by": d.get("approved_by"),
            "approved_at": d.get("approved_at"),
            "history": history,
            "started_at": stamps[0] if stamps else None,
            "updated_at": stamps[-1] if stamps else None,
            "channel_id": d.get("channel_id") or "default",
        }

    @staticmethod
    def _strip_local_id(row: dict) -> dict:
        """Drop the SQLite autoincrement `id` — Supabase rows are keyed on their
        natural columns, not the local rowid."""
        return {k: v for k, v in row.items() if k != "id"}

    @staticmethod
    def _event_row(row: dict) -> dict:
        # channel_id rides along untouched: null stays null, and null means
        # "global" in this table (see supabase/migrations/0001_multi_channel.sql).
        out = {k: v for k, v in row.items() if k != "id"}
        out["event_key"] = f"{row.get('ts', '')}|{row.get('event', '')}|{row.get('id', '')}"
        return out

    def _gather_retention(self, store) -> list[dict]:
        """Every video's most recent retention curve. StateStore exposes the
        curve per video rather than a bulk lister, so walk the videos — the same
        shape as _gather_metrics below."""
        rows: list[dict] = []
        for video in store.list_videos(limit=100000):
            vid = video.get("video_id")
            if not vid:
                continue
            rows.extend(self._strip_local_id(p) for p in store.retention_curve(vid))
        return rows

    def _gather_metrics(self, store) -> list[dict]:
        """Collect every video's latest metrics snapshot. StateStore exposes
        latest_metrics(video_id) rather than a bulk lister, so walk the videos.
        (Command Center charts read the full history from Supabase; this v1
        mirrors the latest snapshot per video, which is what the tiles need.)"""
        rows: list[dict] = []
        for video in store.list_videos(limit=100000):
            vid = video.get("video_id")
            if not vid:
                continue
            metrics = store.latest_metrics(vid)
            if metrics:
                rows.append(self._strip_local_id(metrics))
        return rows
