"""Supabase sync — mirror the local SQLite state into hosted Postgres so the
Command Center (a separate Next.js app) can read real data.

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

import hashlib
import logging
import os
import re
from decimal import Decimal

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
#: Its rows get a deterministic ``row_key`` (migration 0106, see
#: ``video_cost_row_keys``) and are sent with on_conflict=row_key +
#: ignore-duplicates: a row already mirrored is left alone, a new row is added,
#: and two genuinely identical rows stay two (their occurrence index differs).
_APPEND_TABLES = ("video_costs",)

#: Rows per request of the video_costs mirror. A whole history in one request can
#: outgrow PostgREST's body limit or the 15 s timeout; ignore-duplicates makes a
#: retried or repeated chunk harmless.
_VIDEO_COSTS_CHUNK = 2000

#: PostgREST / Postgres codes that mean "the schema lacks what the write names":
#: the row_key column (PGRST204, 42703) or the unique index on it (42P10), or the
#: table itself. Anything else (a timeout, a 5xx, a bad key) is not that.
_SCHEMA_MISSING_CODES = ("PGRST204", "42703", "42P10", "PGRST205", "42P01")

#: The conflict target of the video_costs mirror: a plain UNIQUE index on
#: video_costs(row_key) created by migration 0106.
_VIDEO_COSTS_CONFLICT = "row_key"

#: Separates the fields of a row_key's source text. A control character that no
#: cost field holds, so "a|b" + "c" can never read as "a" + "b|c".
_KEY_SEP = "\x1f"

#: PostgREST / Postgres codes for "this table does not exist" — a deployment
#: where the migration that creates it has not been applied yet.
_TABLE_MISSING_CODES = ("PGRST205", "42P01")
#: ... and for "this function does not exist" (PostgREST: not in the schema
#: cache; Postgres: undefined function).
_FUNCTION_MISSING_CODES = ("PGRST202", "42883")
#: What a function name may look like when it is put in a URL path.
_FUNCTION_NAME = re.compile(r"[a-z_][a-z0-9_]*")


def _canonical_quantity(value) -> str:
    """A quantity as plain decimal text with no exponent and no trailing zeros
    (0.00001, 100, 2.5), rounded to the 15 significant digits Postgres keeps
    when it turns a double into a number. The SQL in docs/sql/dedupe-video-costs.sql
    writes the same text with ``trim_scale(quantity::numeric)::text``, so a key
    computed here and one computed there are the same string."""
    try:
        text = format(Decimal("%.15g" % float(value)).normalize(), "f")
    except (TypeError, ValueError, ArithmeticError):
        return str(value)
    return "0" if text in ("-0", "") else text


def video_cost_group(row: dict) -> str:
    """The fields that make two video_costs rows "the same charge": which
    channel, video, slug, unit and stage, when it was recorded and how much.
    NULL and '' read the same."""
    parts = (
        row.get("channel_id"), row.get("video_id"), row.get("slug"), row.get("unit"),
        row.get("stage"), row.get("recorded_at"),
    )
    return _KEY_SEP.join("" if p is None else str(p) for p in parts) + _KEY_SEP + _canonical_quantity(row.get("quantity"))


def video_cost_row_key(row: dict, occurrence: int = 0) -> str:
    """Deterministic ``row_key`` of a video_costs row: ``v1:`` + sha256 over the
    group (video_cost_group) and its ``occurrence`` index — 0 for the first row of
    a group, 1 for the next identical one, and so on. The same row always gets
    the same key, a different row a different key. sha256 rather than sha1
    because Postgres has sha256() built in (the owner's one-time SQL script needs
    to compute the same key without an extension)."""
    text = f"{video_cost_group(row)}{_KEY_SEP}{int(occurrence)}"
    return "v1:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def video_cost_rows_with_keys(rows: list[dict]) -> list[dict]:
    """The rows as the mirror sends them: the local ``id`` dropped and a
    ``row_key`` added. Rows identical in every keyed field (one flush of the cost
    ledger can record two equal entries) are told apart by an occurrence index
    that follows the local ``id`` order, so the Nth identical row has the same
    key on every run. Rows without an ``id`` keep the order given."""
    ordered = sorted(
        range(len(rows)),
        key=lambda i: (rows[i].get("id") is None, rows[i].get("id") if rows[i].get("id") is not None else 0, i),
    )
    seen: dict[str, int] = {}
    out: list[dict] = []
    for i in ordered:
        row = rows[i]
        group = video_cost_group(row)
        n = seen.get(group, 0)
        seen[group] = n + 1
        keyed = {k: v for k, v in row.items() if k != "id"}
        keyed["row_key"] = video_cost_row_key(row, n)
        out.append(keyed)
    return out


class SupabaseReadError(RuntimeError):
    """A ``select_strict`` read that did not answer with rows. ``detail`` is
    safe to log: an HTTP status and a PostgREST code, never body text or a key."""

    def __init__(self, table: str, status: int | None = None, code: str = ""):
        self.table = table
        self.status = status
        self.code = code
        self.detail = ", ".join(x for x in (f"HTTP {status}" if status else "", code) if x) or "no answer"
        super().__init__(f"Supabase read of {table} failed ({self.detail})")

    @property
    def table_missing(self) -> bool:
        return self.code in _TABLE_MISSING_CODES

    @property
    def function_missing(self) -> bool:
        return self.code in _FUNCTION_MISSING_CODES


class SupabaseSync:
    def __init__(self, url: str | None = None, service_key: str | None = None):
        self.url = (url if url is not None else os.getenv("SUPABASE_URL", "")).rstrip("/")
        self.service_key = service_key if service_key is not None else os.getenv("SUPABASE_SERVICE_KEY", "")
        self.enabled = bool(self.url and self.service_key)
        #: (HTTP status or None, PostgREST code or exception name) of the last
        #: failed upsert, None after a success. Lets a caller tell "the schema is
        #: missing" from "the network is down".
        self.last_failure: tuple | None = None
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
        self.last_failure = None
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
                self.last_failure = (resp.status_code, self._error_code(resp))
                return 0
            return len(rows)
        except Exception as e:
            logger.warning("Supabase upsert into %s errored (%s: %s)", table, type(e).__name__, e)
            self.last_failure = (None, type(e).__name__)
            return 0

    @staticmethod
    def _error_code(resp) -> str:
        """The PostgREST error code of a failed response, or "" (never raises)."""
        try:
            body = resp.json()
            raw = str(body.get("code") or "") if isinstance(body, dict) else ""
            return raw if raw.isalnum() and len(raw) <= 16 else ""
        except Exception:
            return ""

    def insert_new(self, table: str, rows: list[dict], on_conflict: str) -> list[dict] | None:
        """Insert the rows whose conflict key is new and return exactly those
        (PostgREST answers ignore-duplicates + return=representation with the
        rows it inserted). None when disabled or on any failure — the caller
        cannot tell new from seen, and must act as if nothing was claimed.
        Never raises."""
        if not self.enabled:
            return None
        if not rows:
            return []
        try:
            resp = requests.post(
                f"{self.url}/rest/v1/{table}",
                params={"on_conflict": on_conflict},
                json=rows,
                headers=self._headers({"Prefer": "resolution=ignore-duplicates,return=representation"}),
                timeout=_TIMEOUT,
            )
            if resp.status_code >= 300:
                logger.warning("Supabase insert into %s failed: HTTP %s", table, resp.status_code)
                return None
            data = resp.json()
            return data if isinstance(data, list) else None
        except Exception as e:
            logger.warning("Supabase insert into %s errored (%s)", table, type(e).__name__)
            return None

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

    def select_strict(self, table: str, params: dict | None = None) -> list[dict]:
        """Like ``select``, but a failed read raises ``SupabaseReadError``
        instead of reading as "no rows" — for a caller that must tell "this
        channel has none" from "we could not find out" (modules/dna_render.py).
        Disabled returns []."""
        if not self.enabled:
            return []
        try:
            resp = requests.get(
                f"{self.url}/rest/v1/{table}",
                params={"select": "*", **(params or {})},
                headers=self._headers(),
                timeout=_TIMEOUT,
            )
        except Exception as e:
            raise SupabaseReadError(table, None, type(e).__name__) from None
        if resp.status_code >= 300:
            code = ""
            try:
                body = resp.json()
                raw = str(body.get("code") or "") if isinstance(body, dict) else ""
                code = raw if raw.isalnum() and len(raw) <= 16 else ""
            except Exception:
                pass
            raise SupabaseReadError(table, resp.status_code, code)
        try:
            data = resp.json()
        except Exception:
            raise SupabaseReadError(table, resp.status_code, "not json") from None
        if not isinstance(data, list):
            raise SupabaseReadError(table, resp.status_code, "not a list")
        return data

    def rpc_strict(self, name: str, body: dict | None = None):
        """Call one database function with the service key and return its JSON
        answer. A failure raises ``SupabaseReadError`` (``function_missing`` is
        true for a function the database does not have yet), so a caller can
        tell "not applied yet" from "could not find out". Disabled returns None.
        ``name`` is a code constant, never user input; the body is never logged."""
        if not _FUNCTION_NAME.fullmatch(name or ""):
            raise ValueError("rpc_strict needs a plain function name")
        if not self.enabled:
            return None
        try:
            resp = requests.post(
                f"{self.url}/rest/v1/rpc/{name}",
                json=body or {},
                headers=self._headers(),
                timeout=_TIMEOUT,
            )
        except Exception as e:
            raise SupabaseReadError(name, None, type(e).__name__) from None
        if resp.status_code >= 300:
            code = ""
            try:
                parsed = resp.json()
                raw = str(parsed.get("code") or "") if isinstance(parsed, dict) else ""
                code = raw if raw.isalnum() and len(raw) <= 16 else ""
            except Exception:
                pass
            raise SupabaseReadError(name, resp.status_code, code)
        try:
            return resp.json()
        except Exception:
            raise SupabaseReadError(name, resp.status_code, "not json") from None

    # -- high-level --------------------------------------------------------

    def mirror_from_store(self, store, events_limit: int = 500, is_operator=None) -> dict:
        """Mirror the current local state into Supabase and return per-table
        counts. Reads through the given StateStore. Never raises.

        ``is_operator(channel_id)`` decides whose provider USD the cost mirror
        sends (see ``mirror_costs``); without it no cost row carries USD.

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

        # -- costs (append-only; keyed so a re-sent row is ignored) --
        try:
            counts["video_costs"] = self._mirror_video_costs(store, usd_visible=self._usd_policy(is_operator))
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
                sent = self.upsert("channels", rows, on_conflict=_UPSERT_TABLES["channels"])
                if not sent and rows:
                    # A database without migration 0018 has no org_id column and
                    # PostgREST rejects the whole batch for it. Retry without the
                    # column: the rows then land exactly as they did before, and
                    # 0018's backfill puts them in the default org when applied.
                    legacy = [{k: v for k, v in r.items() if k != "org_id"} for r in rows]
                    sent = self.upsert("channels", legacy, on_conflict=_UPSERT_TABLES["channels"])
                counts["channels"] = sent
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
        non-secret reference object — see modules/channels.CredentialRef.

        `org_id` is the default organization (migration 0018): the bot only
        bootstraps the operator's own registry, never a tenant's channels, so
        naming it explicitly is the truth rather than a guess."""
        from modules.channels import DEFAULT_ORG_ID

        d = channel.to_dict()
        return {
            "channel_id": d["channel_id"],
            "org_id": DEFAULT_ORG_ID,
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

    def mirror_costs(self, store, since_iso: str | None = None, is_operator=None) -> int:
        """Mirror ONLY the local cost ledger (``video_costs``) — what the queue
        worker calls after each job so the VPS's ``history/chronos.db`` reaches
        Supabase (the Billing page, ``owner_provider_spend``). Not
        ``mirror_from_store``: that also upserts videos, topic performance and
        the rest from this machine's database, which on the worker is not the
        freshest copy of those and must not overwrite the Actions poll's.

        Idempotent (rows carry a deterministic ``row_key`` and are sent with
        ignore-duplicates), so a repeated or overlapping send adds nothing.
        ``since_iso`` limits the send to rows recorded at or after it; a whole
        ``recorded_at`` group is always in or out together, so row keys do not
        change.

        Privacy: what a provider charged is the operator's margin, not a
        customer's business (see ``_usd_policy``). ``is_operator(channel_id)``
        says which channels are the operator's own: True keeps the USD, False
        sends the row with ``estimated_usd`` None (units, quantities and stages
        are kept), and a channel it cannot decide (it raises or answers None)
        has its rows SKIPPED this time, because ignore-duplicates would lock a
        wrongly-nulled row in for good; the next job sends them. With no
        ``is_operator`` every row is sent without USD. The ``row_key`` does not
        include the USD, so keys are unaffected.

        Returns the rows sent; 0 when disabled or on any failure. Never raises."""
        if not self.enabled:
            return 0

        try:
            return self._mirror_video_costs(store, since_iso=since_iso, usd_visible=self._usd_policy(is_operator))
        except Exception as e:
            logger.warning("video_costs mirror failed (%s) — the local ledger is intact; the next job retries",
                           type(e).__name__)
            return 0

    @staticmethod
    def _usd_policy(is_operator):
        """``channel_id -> True | False | None`` for the cost mirror: True = the
        operator's own channel (USD is sent), False = anyone else's (sent with
        USD None), None = could not be decided (row not sent now). No test
        given = nobody's USD is sent."""
        def policy(channel_id):
            if is_operator is None:
                return False
            try:
                verdict = is_operator(str(channel_id or ""))
            except Exception:
                return None
            return None if verdict is None else bool(verdict)

        return policy

    def _mirror_video_costs(self, store, since_iso: str | None = None, usd_visible=None) -> int:
        """Send every local video_costs row with its ``row_key``, in chunks,
        ignoring the ones Supabase already has (so the nightly re-send of history
        adds nothing). Returns the number of rows SENT successfully; the count is
        not the number inserted, Supabase silently skips the ones it has.

        On a failed chunk the table is abandoned for this run (the rest would
        meet the same fate) and the warning says why. There is deliberately no
        fallback to a plain insert: that is the old behaviour and it would store
        every row once more. Ignore-duplicates makes the next run's re-send of
        the same chunks harmless, and the local DB keeps every row meanwhile."""
        local = store.list_video_costs(limit=100000)
        if since_iso:
            local = [r for r in local if str(r.get("recorded_at") or "") >= since_iso]
        # Default-deny: with no policy, no row carries a USD figure (what a provider
        # charged is the operator's, never a customer's); undecidable channels wait.
        policy = usd_visible if usd_visible is not None else self._usd_policy(None)
        decided = []
        for r in local:
            verdict = policy(r.get("channel_id"))
            if verdict is None:
                continue
            decided.append(r if verdict else {**r, "estimated_usd": None})
        local = decided
        rows = video_cost_rows_with_keys(local)
        sent = 0
        for i in range(0, len(rows), _VIDEO_COSTS_CHUNK):
            chunk = rows[i:i + _VIDEO_COSTS_CHUNK]
            n = self.upsert("video_costs", chunk, on_conflict=_VIDEO_COSTS_CONFLICT, ignore_duplicates=True)
            if n:
                sent += n
                continue
            status, code = self.last_failure or (None, "")
            if code in _SCHEMA_MISSING_CODES:
                logger.warning(
                    "video_costs not mirrored this run (%d local rows kept locally): the database refused the "
                    "write (HTTP %s %s), so migration 0106_video_costs_idempotent.sql is probably not applied "
                    "yet. Nothing was inserted without its row_key, so no row can be duplicated; the next run retries.",
                    len(rows), status, code)
            else:
                logger.warning(
                    "video_costs mirror stopped after %d of %d rows (HTTP %s %s): a failed or timed-out request, "
                    "not a missing migration. Re-sending is safe (ignore-duplicates); the next run retries.",
                    sent, len(rows), status or "-", code or "no answer")
            break
        if rows and sent == len(rows):
            logger.info("video_costs mirror: sent %d rows (already-known rows are ignored by Supabase)", sent)
        return sent

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
