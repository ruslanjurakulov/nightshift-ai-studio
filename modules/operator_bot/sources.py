"""Where the operator bot's answers come from: the system's own state, read-only.

Four kinds of source, none of them new:

* Supabase tables the platform already writes (render_jobs, creative_jobs,
  worker_status 0045, provider_balances 0012, creative_job_costs 0037,
  publish_approvals 0009, app_audit_log 0008, system_events, organizations),
  read with the service key by the same SupabaseSync client the pipeline uses.
  Reads never select a free-text column: no `params`, no `error`, no topic, no
  e-mail. The operator sees ids, statuses, counts and short codes.
* GitHub Actions run status (the repository's own, via the job token).
* The public pages of the site (a GET, status code only).

Every read returns a :class:`Section`. A source that cannot answer says WHY in a
neutral word ("not configured", "not set up yet", "unavailable") and never
raises and never reads as zero: an unknown is not a measurement (CLAUDE.md #5).
No call here writes anything, spends anything or reaches a paid provider.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from modules.log_redaction import describe_http_error
from modules.operator_bot.config import OperatorConfig

logger = logging.getLogger(__name__)

#: The organization every pre-0018 channel belongs to; it is the operator's own,
#: not a sign-up.
DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001"

CREATIVE_ACTIVE = ("queued", "planning", "running", "provider_pending", "processing", "rendering")

#: Audit actions worth a push, each of which the app really writes today
#: (command-center lib/server/audit callers and the SQL functions that insert
#: into app_audit_log). `role.` / `member.` prefixes are matched too so a role
#: change is covered the day one is logged; none is today.
SECURITY_AUDIT_ACTIONS = (
    "api_key.create", "api_key.revoke", "api_key.access",
    "mcp.connect", "mcp.disconnect", "mcp.disconnect_all",
    "secret.write", "variable.write",
    "channel.youtube.disconnect",
    "billing.settings", "api.monthly_limit", "api.activate",
    "model.availability",
)
SECURITY_AUDIT_PREFIXES = ("role.", "member.")

GITHUB_WORKFLOWS = (("deploy_web.yml", "deploy"), ("tests.yml", "tests"), ("frontend.yml", "frontend"))
SITE_PAGES = ("/", "/pricing", "/login", "/signup")


@dataclass
class Section:
    """One source's answer. ``ok`` False means the data is UNKNOWN, with a
    neutral ``note`` that is safe to print."""

    ok: bool
    data: Any = None
    note: str = ""

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
            out = Section(True, rows)
        except SupabaseReadError as e:
            out = Section.fail("not set up yet" if e.table_missing else "unavailable")
            logger.warning("operator read of %s failed (%s)", table, e.detail)
        except Exception as e:  # a fake or an unexpected shape — never raise
            logger.warning("operator read of %s failed (%s)", table, type(e).__name__)
            out = Section.fail("unavailable")
        self._cache[key] = out
        return out

    # -- queue ------------------------------------------------------------

    def render_jobs(self, since: datetime) -> Section:
        """Queued + running jobs, and anything that finished since ``since``.
        No `params`, no `error` column: both can carry a person's words."""
        return self._read("render_jobs", {
            "select": "id,channel_id,kind,status,attempts,max_attempts,heartbeat_at,started_at,finished_at,created_at",
            "or": f"(status.in.(queued,running),finished_at.gte.{iso(since)})",
            "order": "created_at.desc", "limit": "500",
        })

    def creative_jobs(self, since: datetime) -> Section:
        active = ",".join(CREATIVE_ACTIVE)
        return self._read("creative_jobs", {
            "select": "id,capability,status,attempts,heartbeat_at,started_at,finished_at,created_at,error_code,charged_credits",
            "or": f"(status.in.({active}),finished_at.gte.{iso(since)})",
            "order": "created_at.desc", "limit": "500",
        })

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

    def audit(self, since: datetime) -> Section:
        # actor_email is never selected.
        sec = self._read("app_audit_log", {
            "select": "id,at,action,target,channel_id",
            "at": f"gte.{iso(since)}", "order": "at.desc", "limit": "300",
        })
        if not sec.ok:
            return sec
        rows = [r for r in sec.data or []
                if str(r.get("action") or "") in SECURITY_AUDIT_ACTIONS
                or str(r.get("action") or "").startswith(SECURITY_AUDIT_PREFIXES)]
        return Section(True, rows)

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
