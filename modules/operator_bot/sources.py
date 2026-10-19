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
HOLD_CAUSES = ("upload_failed",)

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
#: system_events that prove a run began or ended for a channel (modules/event_log.py). Nothing else counts:
#: the intelligence poll also writes per-channel events, and those are not a video.
RUN_EVENTS = ("system.started", "render.completed", "upload.completed", "video.published", "publish.held",
              "publish.blocked", "upload.failed", "storyboard.ready")
_CHANNEL_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,38}")
#: The only database functions the bot may call (each takes no argument and only reads). A new one is a deliberate
#: addition here, reviewed with its migration; anything else is refused before a request is made.
_READ_FUNCTIONS = frozenset({"operator_marketing_summary"})

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

    def _rpc(self, name: str) -> Section:
        """One argument-less database function, cached like a table read. Never
        raises; the answer must be a JSON object that says ``ok``."""
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
            out = Section(True, data) if isinstance(data, dict) and data.get("ok") is True else Section.fail("unavailable")
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
        `hold_detail`."""
        sec = self._read("videos", {
            "select": "video_id,channel_id,publish_state,held_at",
            "publish_state": f"in.({','.join(HELD_STATES)})", "published_at": "is.null",
            "order": "held_at.desc", "limit": "200",
        })
        if not sec.ok:
            return sec
        return Section(True, [r for r in sec.data or [] if r.get("publish_state") in HELD_STATES], cap=sec.cap)

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
        """The named channels' videos made or held since ``since`` (a day of slack is read and the caller
        filters exactly: the two time columns are text and timestamptz and do not compare alike). Ids,
        channel, state, times: no title, no topic, no hold detail. The channel list is part of the query, so
        other organizations' videos never fill the row limit."""
        ids = [c for c in channel_ids if isinstance(c, str) and _CHANNEL_ID.fullmatch(c)]
        if not ids:
            return Section(True, [])
        sel = "video_id,channel_id,publish_state,published_at,held_at,hold_detail"
        slack, chans = iso(since - timedelta(days=1)), f"in.({','.join(ids)})"
        pub = self._read("videos", {"select": sel, "channel_id": chans, "published_at": f"gte.{slack}",
                                    "order": "published_at.desc", "limit": "300"})
        held = self._read("videos", {"select": sel, "channel_id": chans, "held_at": f"gte.{slack}",
                                     "order": "held_at.desc", "limit": "300"})
        if not pub.ok or not held.ok:
            return pub if not pub.ok else held
        seen, rows = set(), []
        for r in list(pub.data or []) + list(held.data or []):
            if r.get("video_id") not in seen:
                seen.add(r.get("video_id"))
                # `hold_detail` is read for ONE fixed word, the cause of a hold (a failed upload), and dropped
                # at once: its gate verdict and everything else stay out of memory and out of every message.
                detail = r.get("hold_detail") if isinstance(r.get("hold_detail"), dict) else {}
                cause = detail.get("cause")
                rows.append({**{k: v for k, v in r.items() if k != "hold_detail"},
                             "hold_cause": cause if cause in HOLD_CAUSES else None})
        return Section(True, rows, cap=pub.cap or held.cap)

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
            f"https://api.github.com/repos/{repo}/actions/workflows/{DAILY_VIDEO_WORKFLOW}/runs?per_page=30")
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
