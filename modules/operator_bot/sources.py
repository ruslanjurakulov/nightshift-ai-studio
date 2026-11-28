"""Where the operator bot's answers come from: the system's own state, read-only.

Four kinds of source, none of them new:

* Supabase tables the platform already writes (render_jobs, creative_jobs,
  worker_status 0045, provider_balances 0012, creative_job_costs 0037,
  publish_approvals 0009, app_audit_log 0008, payment_events 0021, system_events,
  videos 0016, organizations),
  read with the service key by the same SupabaseSync client the pipeline uses.
  Reads select no person's free text: no job `params` or `error`, no topic, no
  e-mail, no audit actor or detail. What is selected is ids, statuses, counts and
  short codes, plus two short strings that are clipped and escaped before they are
  shown: a worker's own `detail` (its scrubbed remedy line) and an audit row's
  `target` (an id or a variable name).
* ONE database function, ``operator_marketing_summary()`` (migration 0109): the
  brand-channel poster's tables grant the service key nothing, so the counts come
  from a definer function that returns numbers, kinds and closed codes and never
  a post's words, link, media or chat. Read like a table: a function the database
  does not have yet reads as "not set up yet".
* GitHub Actions run status (the repository's own, via the job token): the deploy, tests and frontend
  workflows, and the daily video workflow's runs and the failed jobs of one run (names only).
* The reliability reads (``channels``, ``recent_videos``, ``recent_storyboards``, ``run_events``,
  ``doctor_results``): the operator's own channels' schedule, the video, held and storyboard rows their runs
  write, and the scheduled readiness check's verdict rows. Ids, states, times and one fixed word (a hold's
  cause); never a title, a script, a gate verdict or an event's metadata.
* The film reads (``film_events``, ``film_segments``, the ``security_events`` fallback kind
  ``film.segment_skipped``, migrations 0166/0171, and ``film_sweep_status()``, 0212): ids, statuses, times,
  an organization id, and single numbers or closed words picked out of an event's detail by PostgREST's path
  select. Never a prompt, a scene, the database's message text or a customer's name.
* The film spend reads (``film_segments`` → ``film_takes`` → ``creative_jobs.film_take_id`` →
  ``creative_job_costs``, migrations 0171 and 0037, and ``model_registry``'s reviewed vendor figure, 0035): per film
  with an open or recently settled segment, its takes' kind, attempt and status, their jobs' model ids, and each cost
  row's quantity, unit and USD. Ids, closed words, small numbers and money; never a prompt, a model's parameters, an
  error text or a price source.
* The public pages of the site (a GET, status code only).

Every read returns a :class:`Section`. A source that cannot answer says WHY in a
neutral word ("not configured", "not set up yet", "unavailable") and never
raises and never reads as zero: an unknown is not a measurement (CLAUDE.md #5).
No call here writes anything, spends anything or reaches a paid provider.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from modules.log_redaction import describe_http_error
from modules.operator_bot.config import OperatorConfig

logger = logging.getLogger(__name__)

#: The organization every pre-0018 channel belongs to; it is the operator's own,
#: not a sign-up.
DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001"

#: The worker_status row the bot service writes about itself (migration 0045).
BOT_WORKER_ID = "operator-bot"

#: videos.publish_state values (migration 0016) of a run that did NOT upload.
HELD_STATES = ("held", "awaiting_approval", "repaired_awaiting_review", "blocked")
#: What a held row's ``hold_detail.cause`` may say (modules/held_video.HOLD_CAUSES): a fixed word, never text.
HOLD_CAUSES = ("upload_failed", "quota_exceeded", "upload_limit_exceeded", "token_expired")
#: What a held row's ``hold_detail.stage`` may say: only the early fact-check stop writes one (main.py
#: ``_hold_before_render``): the run was held before its video was made, so no cut exists.
HOLD_STAGES = ("before_render",)

CREATIVE_ACTIVE = ("queued", "planning", "running", "provider_pending", "processing", "rendering")

#: Audit actions worth a push: only those a PLATFORM OPERATOR performs (setup
#: secrets and variables, provider billing settings, model availability, and the
#: owner actions of migration 0107: a credit grant or its reversal, a price
#: change, the second-factor gate). The
#: customer-triggered ones (api_key.*, mcp.*, api.*, channel.youtube.disconnect)
#: are ordinary tenant activity that any signed-in customer can generate, so they
#: are not alerts. `role.` / `member.` prefixes are matched too so a role change
#: is covered the day one is logged (0107 writes member.add / member.role /
#: member.remove from owner_add_member, owner_set_member_role and
#: owner_remove_member). Only rows with no channel
#: count: an operator action is not about a customer's channel.
SECURITY_AUDIT_ACTIONS = (
    "secret.write", "variable.write", "billing.settings", "model.availability",
    "credits.grant", "credits.reverse", "credits.price", "security.gate",
)
SECURITY_AUDIT_PREFIXES = ("role.", "member.")

GITHUB_WORKFLOWS = (("deploy_web.yml", "deploy"), ("tests.yml", "tests"), ("frontend.yml", "frontend"))
#: The daily video workflow, read separately from the three above: its runs are about production, not code, and
#: they are listed on every branch and for every event (a manual dispatch is a run too).
DAILY_VIDEO_WORKFLOW = "daily_video.yml"
#: How many runs of it are listed (the API's maximum): the hourly schedule makes ~24 a day, so this reaches back
#: about four days; a slot older than the list says "cannot tell" (reliability._run_view).
RUNS_PER_PAGE = 100
#: system_events that prove a run began or ended for a channel (modules/event_log.py). Nothing else counts:
#: the intelligence poll also writes per-channel events, and those are not a video.
RUN_EVENTS = ("system.started", "render.completed", "upload.completed", "video.published", "publish.held",
              "publish.blocked", "upload.failed", "storyboard.ready")
_CHANNEL_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,38}")
#: The only database functions the bot may call (each takes no argument and only reads). A new one is a deliberate
#: addition here, reviewed with its migration; anything else is refused before a request is made.
_READ_FUNCTIONS = frozenset({"operator_marketing_summary", "film_sweep_status"})

#: 0171's open segment statuses: a segment in one of these still holds a customer's credits.
FILM_OPEN_STATUSES = ("queued", "running", "draining")
#: The two film_events 0171 writes that need a person: a settle whose hold could no longer pay a charge
#: (``detail.not_captured``), and a segment the claim or the sweep had to skip.
FILM_ALERT_EVENTS = ("segment_settled", "segment_skipped")
#: The security_events kind 0171's film_record_skip writes when even its film_events row could not be written.
FILM_SKIP_SECURITY_KIND = "film.segment_skipped"

#: film_takes statuses (0166) after which a take's vendor call, if it made one, is over: its cost row should exist.
FILM_TAKE_DONE = ("completed", "failed", "superseded", "skipped")
#: How many ids go into one ``in.(...)`` filter: a uuid is 36 characters, so a chunk stays far inside any URL limit.
IN_CHUNK = 50

SITE_PAGES = ("/", "/pricing", "/login", "/signup")


@dataclass
class Section:
    """One source's answer. ``ok`` False means the data is UNKNOWN, with a
    neutral ``note`` that is safe to print."""

    ok: bool
    data: Any = None
    note: str = ""
    #: The row limit this read hit, or 0. A cut read is never a measurement of
    #: "all": the view says "showing the newest N" instead of presenting it whole.
    cap: int = 0

    @classmethod
    def fail(cls, note: str) -> "Section":
        return cls(False, None, note)


def parse_ts(value) -> Optional[datetime]:
    """An aware UTC datetime from a database timestamp, or None."""
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00").replace(" ", "T", 1)
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def age_label(since: Optional[datetime], now: datetime) -> str:
    """``3m``, ``2h 5m``, ``1d 4h`` — or ``?`` when the time is unknown."""
    if since is None:
        return "?"
    secs = max(0, int((now - since).total_seconds()))
    mins = secs // 60
    if mins < 1:
        return f"{secs}s"
    if mins < 60:
        return f"{mins}m"
    hours, mins = divmod(mins, 60)
    if hours < 24:
        return f"{hours}h {mins}m"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours}h"


class OperatorSources:
    """All reads, behind small methods the views and the alert detector share.

    ``sync`` is a SupabaseSync (or a fake with ``enabled`` and ``select_strict``);
    ``http_get(url, headers, timeout) -> (status|None, json|None)`` is the one
    network primitive (a fake in tests); ``now`` returns an aware datetime."""

    def __init__(self, sync, http_get: Callable, cfg: OperatorConfig,
                 now: Optional[Callable[[], datetime]] = None, github_token: str = ""):
        self.sync = sync
        self.http_get = http_get
        self.cfg = cfg
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._github_token = github_token or ""
        self._cache: dict = {}
        self._jobs_cache: dict = {}

    def now(self) -> datetime:
        return self._now()

    def reset(self) -> None:
        """Forget cached reads. A long-running server calls this per command,
        so an answer is never older than the question."""
        self._cache.clear()

    # -- plumbing ---------------------------------------------------------

    def _read(self, table: str, params: dict) -> Section:
        if self.sync is None or not getattr(self.sync, "enabled", False):
            return Section.fail("not configured")
        key = (table, tuple(sorted(params.items())))
        if key in self._cache:
            return self._cache[key]
        from modules.supabase_sync import SupabaseReadError

        try:
            rows = self.sync.select_strict(table, params)
            limit = int(params.get("limit") or 0)
            out = Section(True, rows, cap=limit if limit and len(rows) >= limit else 0)
        except SupabaseReadError as e:
            out = Section.fail("not set up yet" if e.table_missing else "unavailable")
            logger.warning("operator read of %s failed (%s)", table, e.detail)
        except Exception as e:  # a fake or an unexpected shape — never raise
            logger.warning("operator read of %s failed (%s)", table, type(e).__name__)
            out = Section.fail("unavailable")
        self._cache[key] = out
        return out

    def _rpc(self, name: str, needs_ok: bool = True) -> Section:
        """One argument-less database function, cached like a table read. Never
        raises; the answer must be a JSON object that says ``ok`` (``needs_ok``
        False: any JSON object, for a function whose answer has no such key)."""
        if name not in _READ_FUNCTIONS:
            logger.warning("operator refused to call %s: not a read function of the bot", name[:40])
            return Section.fail("unavailable")
        if self.sync is None or not getattr(self.sync, "enabled", False):
            return Section.fail("not configured")
        key = ("rpc", name)
        if key in self._cache:
            return self._cache[key]
        from modules.supabase_sync import SupabaseReadError

        try:
            call = getattr(self.sync, "rpc_strict", None)
            data = call(name, {}) if call is not None else None
            good = isinstance(data, dict) and (data.get("ok") is True or not needs_ok)
            out = Section(True, data) if good else Section.fail("unavailable")
        except SupabaseReadError as e:
            out = Section.fail("not set up yet" if e.function_missing else "unavailable")
            # A function the database does not have yet is the normal state before its migration: not a warning every pass.
            (logger.info if e.function_missing else logger.warning)("operator call of %s failed (%s)", name, e.detail)
        except Exception as e:  # a fake or an unexpected shape - never raise
            logger.warning("operator call of %s failed (%s)", name, type(e).__name__)
            out = Section.fail("unavailable")
        self._cache[key] = out
        return out

    # -- queue ------------------------------------------------------------

    ACTIVE_LIMIT = 200
    RECENT_LIMIT = 500

    def _jobs(self, table: str, columns: str, active: str, since: datetime) -> Section:
        """Active jobs, OLDEST first (a stuck job is an old one: a newest-first
        cut would drop exactly the rows that matter), plus everything that
        finished since ``since``, newest first. ``cap`` says which was cut."""
        act = self._read(table, {"select": columns, "status": f"in.({active})",
                                 "order": "created_at.asc", "limit": str(self.ACTIVE_LIMIT)})
        rec = self._read(table, {"select": columns, "finished_at": f"gte.{iso(since)}",
                                 "order": "finished_at.desc", "limit": str(self.RECENT_LIMIT)})
        if not act.ok:
            return act
        if not rec.ok:
            return rec
        seen, rows = set(), []
        for r in list(act.data or []) + list(rec.data or []):
            if r.get("id") not in seen:
                seen.add(r.get("id"))
                rows.append(r)
        return Section(True, rows, cap=act.cap or rec.cap)

    def render_jobs(self, since: datetime) -> Section:
        """Queued + running jobs, and anything that finished since ``since``.
        No `params`, no `error` column: both can carry a person's words."""
        return self._jobs(
            "render_jobs",
            "id,channel_id,kind,status,attempts,max_attempts,heartbeat_at,started_at,finished_at,created_at",
            "queued,running", since)

    def creative_jobs(self, since: datetime) -> Section:
        return self._jobs(
            "creative_jobs",
            "id,capability,status,attempts,heartbeat_at,started_at,finished_at,created_at,error_code,charged_credits",
            ",".join(CREATIVE_ACTIVE), since)

    def workers(self) -> Section:
        return self._read("worker_status", {
            "select": "worker_id,kind,state,detail,version,started_at,updated_at",
            "order": "updated_at.desc", "limit": "50",
        })

    # -- money ------------------------------------------------------------

    def balances(self) -> Section:
        sec = self._read("provider_balances", {
            "select": "provider,metric,remaining,total,unit,tier,resets_at,checked_at",
            "order": "checked_at.desc", "limit": "100",
        })
        if not sec.ok:
            return sec
        latest: dict = {}
        for row in sec.data or []:
            latest.setdefault((row.get("provider"), row.get("metric")), row)
        return Section(True, list(latest.values()))

    def credits_captured(self, since: datetime) -> Section:
        """Credits spent on completed creative jobs (a count of credits, not
        money: what they are worth in USD is the Margin page's job)."""
        return self._read("creative_jobs", {
            "select": "charged_credits,finished_at",
            "status": "eq.completed", "finished_at": f"gte.{iso(since)}",
            "order": "finished_at.desc", "limit": "5000",
        })

    def creative_costs(self, since: datetime) -> Section:
        return self._read("creative_job_costs", {
            "select": "provider,usd_estimate,recorded_at",
            "recorded_at": f"gte.{iso(since)}", "order": "recorded_at.desc", "limit": "5000",
        })

    PAYMENTS_LIMIT = 1000

    def payment_events(self, since: datetime) -> Section:
        """Payment-provider events received since ``since`` (0021, service role
        only). Ids, type, status, amount and time: NOT `detail` (free text),
        not the organization, not the provider's transaction or adjustment id,
        and there is no customer column at all."""
        return self._read("payment_events", {
            "select": "event_id,event_type,status,amount_minor,currency,received_at",
            "received_at": f"gte.{iso(since)}", "order": "received_at.desc",
            "limit": str(self.PAYMENTS_LIMIT),
        })

    # -- videos -----------------------------------------------------------

    def held_videos(self) -> Section:
        """Runs that did not upload (held, awaiting approval, repaired, blocked
        by the gate), newest first. Ids and states: no title, no topic, no
        `hold_detail` beyond the one fixed word of its stage (``hold_stage``)."""
        params = {
            "select": "video_id,channel_id,publish_state,held_at",
            "publish_state": f"in.({','.join(HELD_STATES)})", "published_at": "is.null",
            "order": "held_at.desc", "limit": "200",
        }
        # The stage is ONE fixed word inside hold_detail, read through PostgREST's path select so the gate
        # verdict next to it is never read; a server that refuses the syntax gets the plain read (as in
        # ``recent_videos``): the counts must not depend on it.
        sec = self._read("videos", {**params, "select": params["select"] + ",hold_stage:hold_detail->>stage"})
        if not sec.ok:
            sec = self._read("videos", params)
        if not sec.ok:
            return sec
        rows = [{**r, "hold_stage": r.get("hold_stage") if r.get("hold_stage") in HOLD_STAGES else None}
                for r in sec.data or [] if r.get("publish_state") in HELD_STATES]
        return Section(True, rows, cap=sec.cap)

    def videos_published(self, since: datetime) -> Section:
        return self._read("videos", {
            "select": "video_id,published_at", "published_at": f"gte.{iso(since)}",
            "order": "published_at.desc", "limit": "1000",
        })

    # -- activity ---------------------------------------------------------

    def events(self, since: datetime, names: tuple) -> Section:
        return self._read("system_events", {
            "select": "event,video_id,ts",
            "event": f"in.({','.join(names)})", "ts": f"gte.{iso(since)}",
            "order": "ts.desc", "limit": "2000",
        })

    def signups(self, since: datetime) -> Section:
        """New accounts, as organizations created since ``since`` (every sign-up
        creates one; migration 0027's welcome grant fires on it). Counts only:
        no name, no slug, no person."""
        sec = self._read("organizations", {
            "select": "id,created_at", "created_at": f"gte.{iso(since)}",
            "order": "created_at.desc", "limit": "5000",
        })
        if not sec.ok:
            return sec
        return Section(True, [r for r in sec.data or [] if r.get("id") != DEFAULT_ORG_ID])

    def publish_approvals(self) -> Section:
        return self._read("publish_approvals", {
            "select": "id,channel_id,status,requested_at",
            "status": "eq.pending", "order": "requested_at.desc", "limit": "100",
        })

    def runs_awaiting_approval(self) -> Section:
        # run_id only: `topic` is the video's subject, which is content.
        return self._read("pipeline_runs", {
            "select": "run_id,started_at,updated_at",
            "current_stage": "eq.HUMAN_APPROVAL", "human_approved": "eq.false",
            "order": "updated_at.desc", "limit": "50",
        })

    def marketing_summary(self) -> Section:
        """The brand-channel poster at a glance: counts by status, the week's
        count against its cap, the switch, the last sent post and the last
        failure (migration 0109). Counts, kinds and closed codes only."""
        return self._rpc("operator_marketing_summary")

    # -- film studio (0166, 0171, 0212) -----------------------------------

    FILM_EVENTS_LIMIT = 300

    def film_alert_events(self, since: datetime) -> Section:
        """The settles that left a charge uncaptured and the skipped segments since ``since``, newest first.

        Two reads, so a busy day of ordinary settles can never push a ``not_captured`` one out of the row limit: the
        database is asked only for settles whose detail HAS that key. From ``detail`` only four values are picked out
        by path (segment id, the uncaptured amount, the call and the SQLSTATE); the database's own ``message`` beside
        them is never read, because it can quote a row."""
        cols = ("id,film_id,org_id,event,created_at,segment_id:detail->>segment_id,"
                "not_captured:detail->>not_captured,call:detail->>call,sqlstate:detail->>sqlstate")
        common = {"select": cols, "created_at": f"gte.{iso(since)}", "order": "created_at.desc",
                  "limit": str(self.FILM_EVENTS_LIMIT)}
        settled = self._read("film_events", {**common, "event": "eq.segment_settled",
                                             "detail->>not_captured": "not.is.null"})
        skipped = self._read("film_events", {**common, "event": "eq.segment_skipped"})
        if not settled.ok:
            return settled
        if not skipped.ok:
            return skipped
        # Belt and braces for a source that ignored a filter: each read keeps only its own event, each row once.
        seen, rows = set(), []
        for event, sec in (("segment_settled", settled), ("segment_skipped", skipped)):
            for r in sec.data or []:
                if r.get("event") == event and r.get("id") not in seen:
                    seen.add(r.get("id"))
                    rows.append(r)
        return Section(True, rows, cap=settled.cap or skipped.cap)

    def film_skip_fallbacks(self, since: datetime) -> Section:
        """0171's fallback record of a skipped segment (``security_events`` kind ``film.segment_skipped``): its id,
        time, target (the segment id) and two closed values of its detail. Never the actor columns, never the
        message."""
        sec = self._read("security_events", {
            "select": "id,at,kind,target,call:detail->>call,sqlstate:detail->>sqlstate",
            "kind": f"eq.{FILM_SKIP_SECURITY_KIND}", "at": f"gte.{iso(since)}", "order": "at.desc", "limit": "100",
        })
        if not sec.ok:
            return sec
        return Section(True, [r for r in sec.data or [] if r.get("kind") == FILM_SKIP_SECURITY_KIND], cap=sec.cap)

    def film_open_segments(self) -> Section:
        """Segments that still hold credits, OLDEST first (a stuck one is an old one). Id, status, the four
        timestamps and the organization: no film, no quote, no money columns."""
        sec = self._read("film_segments", {
            "select": "id,org_id,status,created_at,claimed_at,heartbeat_at,updated_at",
            "status": f"in.({','.join(FILM_OPEN_STATUSES)})", "order": "created_at.asc", "limit": "200",
        })
        if not sec.ok:
            return sec
        return Section(True, [r for r in sec.data or [] if r.get("status") in FILM_OPEN_STATUSES], cap=sec.cap)

    FILM_SPEND_SEGMENTS_LIMIT = 200
    FILM_SPEND_ROWS_LIMIT = 2000

    def film_spend(self, since: datetime) -> Section:
        """What each film with an open segment, or one settled since ``since``, has cost at its vendors so far: a cost
        row's own ``usd_estimate`` where one was recorded, else its quantity times the registry's figure (an
        estimate), else unknown (never 0), with its takes. Data: one dict per film, see
        :func:`modules.operator_bot.analysis.film_spend_rollup`. Read-only; any read that fails makes the whole
        answer unknown (a partial sum is not "this film's cost")."""
        cols = "film_id,org_id,status,settled_at"
        lim = str(self.FILM_SPEND_SEGMENTS_LIMIT)
        open_ = self._read("film_segments", {"select": cols, "status": f"in.({','.join(FILM_OPEN_STATUSES)})",
                                             "order": "created_at.asc", "limit": lim})
        if not open_.ok:
            return open_
        done = self._read("film_segments", {"select": cols, "settled_at": f"gte.{iso(since)}",
                                            "order": "settled_at.desc", "limit": lim})
        if not done.ok:
            return done
        films: dict = {}
        for r in list(open_.data or []) + list(done.data or []):
            # Belt and braces for a source that ignored a filter: only a live segment or one settled in the window.
            settled = parse_ts(r.get("settled_at"))
            if r.get("status") in FILM_OPEN_STATUSES or (settled is not None and settled >= since):
                fid = str(r.get("film_id") or "")
                if fid:
                    films.setdefault(fid, r.get("org_id"))
        out = self._film_costs(films)
        if out.ok and (open_.cap or done.cap):
            out.cap = out.cap or open_.cap or done.cap
        return out

    def film_spend_for(self, film_id: str) -> Section:
        """The same answer for one named film, whatever its segments (tools/film_spend.py)."""
        sec = self._read("films", {"select": "id,org_id", "id": f"eq.{film_id}", "limit": "1"})
        if not sec.ok:
            return sec
        rows = [r for r in sec.data or [] if str(r.get("id")) == film_id]
        if not rows:
            return Section.fail("not found")
        return self._film_costs({film_id: rows[0].get("org_id")})

    def _in_chunks(self, table: str, select: str, column: str, ids, extra: Optional[dict] = None) -> Section:
        rows, cap = [], 0
        ids = sorted({str(i) for i in ids if i})
        for n in range(0, len(ids), IN_CHUNK):
            sec = self._read(table, {"select": select, column: f"in.({','.join(ids[n:n + IN_CHUNK])})",
                                     **(extra or {}), "limit": str(self.FILM_SPEND_ROWS_LIMIT)})
            if not sec.ok:
                return sec
            rows += list(sec.data or [])
            cap = cap or sec.cap
        return Section(True, rows, cap=cap)

    def _film_costs(self, films: dict) -> Section:
        from modules.operator_bot import analysis

        if not films:
            return Section(True, [])
        takes = self._in_chunks("film_takes", "id,film_id,org_id,kind,attempt,status,created_at", "film_id", films,
                                {"order": "created_at.asc"})
        if not takes.ok:
            return takes
        take_rows = [r for r in takes.data if str(r.get("film_id")) in films]
        jobs = self._in_chunks("creative_jobs", "id,film_take_id,routed_model,requested_model", "film_take_id",
                               [r.get("id") for r in take_rows])
        if not jobs.ok:
            return jobs
        take_ids = {str(r.get("id")) for r in take_rows}
        job_rows = [r for r in jobs.data if str(r.get("film_take_id")) in take_ids]
        costs = self._in_chunks("creative_job_costs", "job_id,quantity,unit,usd_estimate,price_source", "job_id",
                                [r.get("id") for r in job_rows])
        if not costs.ok:
            return costs
        job_ids = {str(r.get("id")) for r in job_rows}
        cost_rows = [r for r in costs.data if str(r.get("job_id")) in job_ids]
        # The adapters record a quantity in the vendor's unit and leave usd_estimate NULL by design
        # (modules/creative_adapters.py, RegistryAdapter.usage): the dollars come from the registry's reviewed figure,
        # picked out of spec by path so nothing else of the spec is read. Only the prices and their unit.
        models = {analysis.film_job_model(r) for r in job_rows} - {""}
        # variant_prices: spec.pricing.variants.prices ({"1K": 0.067, "4K": 0.15, ...}, a figure or null per variant).
        figures = self._in_chunks("model_registry", "id,usd_per_unit:spec->pricing->>provider_usd_per_unit,"
                                  "price_unit:spec->pricing->>unit,variant_prices:spec->pricing->variants->prices",
                                  "id", models) if models else Section(True, [])
        if not figures.ok:
            return figures
        figure_rows = [r for r in figures.data if str(r.get("id")) in models]
        rolled = analysis.film_spend_rollup(films, take_rows, job_rows, cost_rows, figure_rows)
        return Section(True, rolled, cap=takes.cap or jobs.cap or costs.cap or figures.cap)

    def film_sweep_status(self) -> Section:
        """Whether the film sweep ran (0212): per runner its last run, the open segment count and ``overdue``
        (true / false / null = never recorded). A database without 0212 reads as "not set up yet"."""
        return self._rpc("film_sweep_status", needs_ok=False)

    def audit(self, since: datetime) -> Section:
        """Operator-level audit events only, filtered by the database (a Python
        filter after a row limit would let ordinary activity push the rows that
        matter out of the page). Rows about a customer's channel are excluded:
        an operator action has no channel. The actor is never selected."""
        names = ",".join(SECURITY_AUDIT_ACTIONS)
        prefixes = ",".join(f"action.like.{p}*" for p in SECURITY_AUDIT_PREFIXES)
        sec = self._read("app_audit_log", {
            "select": "id,at,action,target",
            "channel_id": "is.null",
            "or": f"(action.in.({names}),{prefixes})",
            "at": f"gte.{iso(since)}", "order": "at.desc", "limit": "300",
        })
        if not sec.ok:
            return sec
        # Belt and braces for a source that ignored the filter.
        rows = [r for r in sec.data or []
                if (str(r.get("action") or "") in SECURITY_AUDIT_ACTIONS
                    or str(r.get("action") or "").startswith(SECURITY_AUDIT_PREFIXES))
                and r.get("channel_id") in (None, "")]
        return Section(True, rows, cap=sec.cap)

    # -- the schedule: what should exist, and what does (reliability.py) ---------

    def channels(self) -> Section:
        """The operator's own channels with the settings the scheduler reads (status, schedule, verification)
        and nothing else: the database is asked for the default organization's rows only, so a customer's
        channel is never fetched. The credential column is a reference plus public facts, never a token."""
        return self._read("channels", {
            "select": "channel_id,status,schedule_config,credential_ref,org_id,created_at,updated_at",
            "org_id": f"eq.{DEFAULT_ORG_ID}", "limit": "200",
        })

    def recent_videos(self, since: datetime, channel_ids: list) -> Section:
        """The named channels' videos made or held since ``since``, repurposed Shorts included (migration 0080
        stores each as a row of its own): the caller keeps the masters (``reliability.is_master``). There is no
        server-side ``parent_video_id`` filter on purpose: the daily mirror upserts that column as an empty string,
        not NULL, and ``is.null`` would match none of the masters; at most 20 Shorts per master fit the row limit.
        A day of slack is read and the caller filters exactly: the two time columns are text and timestamptz and do
        not compare alike. Ids, channel, state, format, times and the cause of a hold: no title, no topic, no gate
        verdict. The channel list is part of the query, so other organizations' videos never fill the row limit."""
        ids = [c for c in channel_ids if isinstance(c, str) and _CHANNEL_ID.fullmatch(c)]
        if not ids:
            return Section(True, [])
        base = "video_id,channel_id,publish_state,published_at,held_at,video_format,parent_video_id"
        slack, chans = iso(since - timedelta(days=1)), f"in.({','.join(ids)})"

        def read(select: str):
            common = {"select": select, "channel_id": chans}
            return (self._read("videos", {**common, "published_at": f"gte.{slack}",
                                          "order": "published_at.desc", "limit": "300"}),
                    self._read("videos", {**common, "held_at": f"gte.{slack}",
                                          "order": "held_at.desc", "limit": "300"}))

        # The cause of a hold is ONE fixed word inside the hold_detail JSON; PostgREST's path select hands back
        # just that word, so the gate verdict next to it is never read. If a server refuses the path syntax the
        # read is repeated without it: the evidence (the dead-man's whole job) must not depend on it, and only
        # the "upload failed" alert is lost.
        pub, held = read(base + ",hold_cause:hold_detail->>cause,hold_stage:hold_detail->>stage")
        if not pub.ok or not held.ok:
            pub, held = read(base)
        if not pub.ok or not held.ok:
            return pub if not pub.ok else held
        seen, rows = set(), []
        for r in list(pub.data or []) + list(held.data or []):
            if r.get("video_id") not in seen:
                seen.add(r.get("video_id"))
                cause, stage = r.get("hold_cause"), r.get("hold_stage")
                rows.append({**r, "hold_cause": cause if cause in HOLD_CAUSES else None,
                             "hold_stage": stage if stage in HOLD_STAGES else None})
        return Section(True, rows, cap=pub.cap or held.cap)

    def channel_named(self, channel_id: str) -> Section:
        """Whether a ``channels`` row with this id exists in ANY organization (the id is the table's primary key):
        the id and nothing else. The registry's default channel is the operator's only when no row owns the id."""
        if not _CHANNEL_ID.fullmatch(channel_id or ""):
            return Section(True, [])
        sec = self._read("channels", {"select": "channel_id", "channel_id": f"eq.{channel_id}", "limit": "1"})
        if not sec.ok:
            return sec
        return Section(True, [r for r in sec.data or [] if r.get("channel_id") == channel_id])

    def recent_storyboards(self, since: datetime, channel_ids: list) -> Section:
        """Storyboards (migration 0057) the named channels' runs stopped at since ``since``: a run that planned a
        video and waits for a person. Id, channel, status and time; never the scenes, the script or the title."""
        ids = [c for c in channel_ids if isinstance(c, str) and _CHANNEL_ID.fullmatch(c)]
        if not ids:
            return Section(True, [])
        return self._read("storyboards", {
            "select": "id,channel_id,status,created_at", "channel_id": f"in.({','.join(ids)})",
            "created_at": f"gte.{iso(since - timedelta(days=1))}", "order": "created_at.desc", "limit": "100",
        })

    def run_events(self, since: datetime, channel_ids: list) -> Section:
        """The run-lifecycle events of the named channels since ``since``: name, time and channel. Never
        `metadata`, which carries titles and error text. The channel list is part of the query, so a busy
        customer cannot push an operator's evidence out of the row limit. These events reach Supabase only when
        the intelligence poll mirrors them (once a day), so they can RESCUE a verdict but never prove a run
        did not happen: the video, held and storyboard rows are written by the run itself."""
        ids = [c for c in channel_ids if isinstance(c, str) and _CHANNEL_ID.fullmatch(c)]
        if not ids:
            return Section(True, [])
        sec = self._read("system_events", {
            "select": "event,ts,channel_id",
            "event": f"in.({','.join(RUN_EVENTS)})", "channel_id": f"in.({','.join(ids)})",
            "ts": f"gte.{iso(since - timedelta(minutes=1))}", "order": "ts.desc", "limit": "2000",
        })
        if not sec.ok:
            return sec
        # Belt and braces for a source that ignored the filter: only run events, only the named channels.
        rows = [r for r in sec.data or [] if r.get("event") in RUN_EVENTS and r.get("channel_id") in ids]
        return Section(True, rows, cap=sec.cap)

    def slot_attempts(self, since: datetime, channel_ids: list) -> Section:
        """The scheduler's attempt records (``schedule.attempt``, written by tools/slot_guard.py when a scheduled
        run starts) for the named channels since ``since``: key, channel and the closed metadata (slot start, attempt
        number, cap). They say a run STARTED, never that a video exists, so they are not slot evidence; the dead-man
        reads them only to say that a slot used all its attempts."""
        ids = [c for c in channel_ids if isinstance(c, str) and _CHANNEL_ID.fullmatch(c)]
        if not ids:
            return Section(True, [])
        return self._read("system_events", {
            "select": "event_key,channel_id,metadata", "event": "eq.schedule.attempt",
            "channel_id": f"in.({','.join(ids)})", "ts": f"gte.{iso(since)}", "order": "ts.desc", "limit": "200",
        })

    def doctor_results(self, since: datetime) -> Section:
        """The scheduled readiness check's own rows (tools/doctor_report.py): title ``ok`` or ``fail``,
        body the failing checks' names. The bot's rows carry no channel; one that does is not the bot's."""
        return self._read("alert_events", {
            "select": "at,title,body", "kind": "eq.operator.doctor", "channel_id": "is.null",
            "at": f"gte.{iso(since)}", "order": "at.desc", "limit": "50",
        })

    def _github_get(self, url: str):
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if self._github_token:
            headers["Authorization"] = f"Bearer {self._github_token}"
        return self.http_get(url, headers, 10)

    def daily_video_runs(self) -> Section:
        """The newest runs of the daily video workflow, on any branch, scheduled or dispatched. Ids, event,
        state, times and a short commit: nothing a person typed (the dispatch inputs are not selected)."""
        repo = self.cfg.github_repo
        if not repo:
            return Section.fail("not configured")
        key = ("gh_runs", DAILY_VIDEO_WORKFLOW)
        if key in self._cache:
            return self._cache[key]
        status, body = self._github_get(
            f"https://api.github.com/repos/{repo}/actions/workflows/{DAILY_VIDEO_WORKFLOW}/runs?per_page={RUNS_PER_PAGE}")
        runs = (body or {}).get("workflow_runs") if isinstance(body, dict) else None
        if status != 200 or not isinstance(runs, list):
            out = Section.fail("unavailable")
        else:
            out = Section(True, [{
                "id": r.get("id"), "number": r.get("run_number"), "event": r.get("event"),
                "status": r.get("status"), "conclusion": r.get("conclusion"),
                "sha": str(r.get("head_sha") or "")[:7],
                "created_at": r.get("created_at"), "started_at": r.get("run_started_at") or r.get("created_at"),
                "updated_at": r.get("updated_at"),
            } for r in runs if isinstance(r, dict)])
        self._cache[key] = out
        return out

    def run_jobs(self, run_id) -> Section:
        """Which jobs of one finished run failed and at which step: the matrix job is named after its
        channel (``make-video (default)``). A finished run never changes, so the answer is kept for the
        life of the process (bounded)."""
        repo = self.cfg.github_repo
        rid = str(run_id or "")
        if not repo or not rid.isdigit():
            return Section.fail("not configured")
        if rid in self._jobs_cache:
            return self._jobs_cache[rid]
        status, body = self._github_get(f"https://api.github.com/repos/{repo}/actions/runs/{rid}/jobs?per_page=30")
        jobs = (body or {}).get("jobs") if isinstance(body, dict) else None
        if status != 200 or not isinstance(jobs, list):
            return Section.fail("unavailable")            # not kept: asked again next pass
        slim = []
        for j in jobs:
            if not isinstance(j, dict):
                continue
            step = next((x.get("name") for x in j.get("steps") or []
                         if isinstance(x, dict) and x.get("conclusion") == "failure"), None)
            slim.append({"name": j.get("name"), "conclusion": j.get("conclusion"), "step": step})
        out = Section(True, slim)
        if len(self._jobs_cache) >= 50:
            self._jobs_cache.clear()
        self._jobs_cache[rid] = out
        return out

    # -- outside ----------------------------------------------------------

    def site(self) -> Section:
        base = self.cfg.app_url
        if not base:
            return Section.fail("not configured")
        results = []
        for path in SITE_PAGES:
            status, _ = self.http_get(base + path, None, 8)
            results.append({"path": path, "status": status})
        return Section(True, results)

    def deploys(self) -> Section:
        repo = self.cfg.github_repo
        if not repo:
            return Section.fail("not configured")
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if self._github_token:
            headers["Authorization"] = f"Bearer {self._github_token}"
        out = []
        answered = False
        for fname, label in GITHUB_WORKFLOWS:
            url = f"https://api.github.com/repos/{repo}/actions/workflows/{fname}/runs?branch=main&per_page=3"
            status, body = self.http_get(url, headers, 10)
            runs = (body or {}).get("workflow_runs") if isinstance(body, dict) else None
            if status != 200 or not isinstance(runs, list):
                out.append({"label": label, "ok": False})
                continue
            answered = True
            slim = [{
                "id": r.get("id"), "status": r.get("status"), "conclusion": r.get("conclusion"),
                "sha": str(r.get("head_sha") or "")[:7],
                "at": r.get("updated_at") or r.get("created_at"),
            } for r in runs[:3] if isinstance(r, dict)]
            out.append({"label": label, "ok": True, "runs": slim})
        return Section(True, out) if answered else Section.fail("unavailable")


def default_http_get(url: str, headers: Optional[dict], timeout: float):
    """The one real network primitive: ``(status|None, json|None)``. The
    exception text is never kept (a requests error quotes the URL)."""
    try:
        import requests

        resp = requests.get(url, headers=headers or {}, timeout=timeout, allow_redirects=True, stream=True)
        status = resp.status_code
        body = None
        if "json" in (resp.headers.get("Content-Type") or "") and status == 200:
            try:
                body = resp.json()
            except Exception:
                body = None
        resp.close()
        return status, body
    except Exception as e:
        logger.warning("operator http check failed (%s)", describe_http_error(e))
        return None, None
