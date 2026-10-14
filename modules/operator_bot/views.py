"""The operator bot's messages and keyboards.

Every function takes the sources and returns a :class:`Reply`: HTML text and an
inline keyboard. Rules the whole file keeps:

* Dynamic text is escaped with ``html_escape`` at the point it is interpolated,
  and free text is ``clip``-ped first. In practice nothing here prints free
  text: ids, counts, statuses, short codes, ages.
* A source that could not answer prints its neutral note, never a zero.
* Money is shown only as the sources hold it: a USD figure built from rows that
  were not all priced is labelled "at least", never a total.
* Each line is well-formed HTML on its own, so ``split_message`` may cut between
  any two lines.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from modules.operator_bot import analysis
from modules.operator_bot.config import OperatorConfig, STUCK_HEARTBEAT_MINUTES
from modules.operator_bot.sources import OperatorSources, Section, age_label, parse_ts
from modules.tg_text import clip, html_escape, safe_id

# Alert kinds (short, because callback_data is limited to 64 bytes) and where
# each one points.
ALERT_KINDS = ("run", "stuck", "balance", "deploy", "worker", "approval", "audit")
KIND_LABEL = {
    "run": "failed runs", "stuck": "stuck jobs", "balance": "low balances",
    "deploy": "deploy / CI", "worker": "worker heartbeat", "approval": "approvals",
    "audit": "security events",
}
KIND_COMMAND = {
    "run": "errors", "stuck": "queue", "balance": "balance", "deploy": "deploys",
    "worker": "health", "approval": "approvals", "audit": "security",
}
KIND_PAGE = {
    "run": "errors", "stuck": "jobs", "balance": "billing", "worker": "integrations",
    "approval": "approvals", "audit": "audit",
}

#: command name (and callback target) -> one-line description, in menu order.
COMMANDS = (
    ("health", "site, workers, last deploy"),
    ("queue", "running and stuck jobs"),
    ("errors", "failures in the last 24 hours"),
    ("balance", "provider balances"),
    ("spend", "provider cost, today and 7 days"),
    ("today", "videos made, published, held"),
    ("users", "new sign-ups (counts only)"),
    ("deploys", "last deploys and CI"),
    ("approvals", "waiting for a person"),
    ("security", "recent security-relevant events"),
    ("digest", "the daily summary, now"),
    ("alerts", "alert settings and mutes"),
)
READ_COMMANDS = tuple(name for name, _ in COMMANDS)


@dataclass
class Reply:
    text: str
    keyboard: list = field(default_factory=list)   # rows of button dicts
    parse_mode: Optional[str] = "HTML"

    def markup(self) -> Optional[dict]:
        return {"inline_keyboard": self.keyboard} if self.keyboard else None


# -- buttons ---------------------------------------------------------------

def cb(text: str, data: str) -> dict:
    assert len(data.encode()) <= 64, data
    return {"text": text, "callback_data": data}


def url_button(text: str, url: Optional[str]) -> Optional[dict]:
    return {"text": text, "url": url} if url else None


_CHANNEL = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def app_link(cfg: OperatorConfig, section: str, channel: Optional[str] = None) -> Optional[str]:
    """A deep link into the Command Center, or None when OPERATOR_APP_URL is not
    set (a link is never guessed). ``all-channels`` is the aggregate view."""
    if not cfg.app_url:
        return None
    ch = channel if channel and _CHANNEL.match(channel) else "all-channels"
    return f"{cfg.app_url}/{ch}/{section}"


def github_actions_link(cfg: OperatorConfig, workflow: str = "deploy_web.yml") -> Optional[str]:
    return f"https://github.com/{cfg.github_repo}/actions/workflows/{workflow}" if cfg.github_repo else None


#: The main menu, grouped: one row per group, in this order. The menu text names
#: the groups; each button runs one read-only command.
MENU_GROUPS = (
    ("Live", (("Health", "health"), ("Queue", "queue"), ("Errors", "errors"))),
    ("Money", (("Balance", "balance"), ("Spend", "spend"))),
    ("Activity", (("Today", "today"), ("Users", "users"), ("Deploys", "deploys"), ("Approvals", "approvals"))),
    ("Reports", (("Security", "security"), ("Digest", "digest"), ("Alerts", "alerts"))),
    ("Original", (("Status", "status"), ("Channels", "channels"), ("Held", "pending"))),
)


def menu_keyboard() -> list:
    return [[cb(label, f"c:{name}") for label, name in buttons] for _group, buttons in MENU_GROUPS]


def _with_menu(rows: list, extra_links: Optional[list] = None, again: Optional[str] = None) -> list:
    """Buttons for one view: its own rows, deep links, then Refresh (run the
    same command again) and Menu."""
    out = [r for r in rows if r]
    links = [b for b in (extra_links or []) if b]
    if links:
        out.append(links)
    out.append(([cb("Refresh", f"c:{again}")] if again else []) + [cb("Menu", "c:menu")])
    return out


def _b(text) -> str:
    return f"<b>{html_escape(text)}</b>"


def _c(text) -> str:
    return f"<code>{html_escape(text)}</code>"


def _unknown(sec: Section) -> str:
    return f"unknown ({html_escape(sec.note or 'unavailable')})"


def _n(value, digits: int = 0) -> str:
    try:
        return f"{float(value):,.{digits}f}"
    except (TypeError, ValueError):
        return "unknown"


def _usd(value: float) -> str:
    return f"${value:,.2f}" if abs(value) >= 0.01 or value == 0 else f"${value:,.4f}"


# -- menu / help -----------------------------------------------------------

def view_menu(cfg: OperatorConfig) -> Reply:
    groups = [f"{html_escape(group)}: {html_escape(', '.join(label.lower() for label, _ in buttons))}"
              for group, buttons in MENU_GROUPS]
    return Reply(
        "\n".join([_b("Nightshift operator"), *groups,
                   "Tap a button, or type a command. Read-only: nothing here publishes, spends or approves."]),
        menu_keyboard(),
    )


def view_help() -> Reply:
    lines = [_b("Nightshift operator — commands"), "Read-only:"]
    lines += [f"/{name} — {html_escape(desc)}" for name, desc in COMMANDS]
    lines += [
        "/status — video count",
        "/channels — channels and autonomy",
        "/pending — videos held for review",
        "/menu — buttons",
        "Safe:",
        "/mute [kind|all] — silence alerts for 24 hours",
        "/unmute [kind|all]",
        "Requests (still pass the publish gate, nothing runs from here):",
        "/publish &lt;video_id&gt;, /pause &lt;channel_id&gt;, /resume &lt;channel_id&gt;",
        f"Alert kinds: {html_escape(', '.join(ALERT_KINDS))}",
    ]
    return Reply("\n".join(lines), [[cb("Menu", "c:menu")]])


# -- /health ---------------------------------------------------------------

def view_health(ops: OperatorSources) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [_b("Health")]

    site = ops.site()
    if not site.ok:
        lines.append(f"Site: {_unknown(site)}")
    else:
        bad = [r for r in site.data if r["status"] is None or not (200 <= r["status"] < 400)]
        if bad:
            lines.append("Site: <b>DOWN</b> — " + html_escape(", ".join(
                f"{r['path']} {r['status'] if r['status'] else 'no answer'}" for r in bad)))
        else:
            lines.append(f"Site: OK ({len(site.data)}/{len(site.data)} pages answer)")

    workers = ops.workers()
    if not workers.ok:
        lines.append(f"Workers: {_unknown(workers)}")
    else:
        rows = analysis.classify_workers(workers.data, now)
        if not rows:
            lines.append("Workers: none has ever reported (worker off, or migration 0045 not applied)")
        for w in rows[:8]:
            tag = "STALE" if w["stale"] else str(w.get("state") or "?")
            beat = "?" if w["age_s"] is None else age_label(now - timedelta(seconds=w["age_s"]), now)
            extra = ""
            if w.get("state") == "failed" and w.get("detail"):
                extra = " — " + clip(w["detail"], 100)
            lines.append(f"• {_c(safe_id(w.get('worker_id')))} {html_escape(w.get('kind') or '?')}: "
                         f"<b>{html_escape(tag)}</b>, reported {html_escape(beat)} ago{html_escape(extra)}")

    dep = ops.deploys()
    if not dep.ok:
        lines.append(f"Deploys / CI: {_unknown(dep)}")
    else:
        lines.extend(_deploy_summary_lines(dep.data, now))

    lines.append("Disk: not reported (the workers send state and heartbeat only)")
    kb = _with_menu(
        [[cb("Queue", "c:queue"), cb("Deploys", "c:deploys")]],
        [url_button("Open integrations", app_link(cfg, "integrations"))],
        again="health",
    )
    return Reply("\n".join(lines), kb)


def _run_word(run: dict) -> str:
    if run.get("status") != "completed":
        return str(run.get("status") or "?")
    return str(run.get("conclusion") or "unknown")


def _deploy_summary_lines(data: list, now: datetime) -> list[str]:
    lines = []
    for wf in data:
        label = wf["label"]
        if not wf.get("ok"):
            lines.append(f"{html_escape(label.capitalize())}: unknown (GitHub did not answer)")
            continue
        run = analysis.latest_run(wf["runs"])
        if run is None:
            lines.append(f"{html_escape(label.capitalize())}: no finished run yet")
            continue
        word = _run_word(run)
        mark = "<b>FAILED</b>" if word in ("failure", "timed_out", "startup_failure") else html_escape(word)
        lines.append(f"{html_escape(label.capitalize())}: {mark} {_c(safe_id(run.get('sha'), 7))}, "
                     f"{html_escape(age_label(parse_ts(run.get('at')), now))} ago")
    return lines


# -- /queue ----------------------------------------------------------------

def _job_line(r: dict, now: datetime, name: str, stuck_ids: set) -> str:
    started = parse_ts(r.get("started_at")) or parse_ts(r.get("created_at"))
    beat = parse_ts(r.get("heartbeat_at"))
    bits = [f"{name} {_c(safe_id(r.get('id'), 12))}"]
    if r.get("channel_id"):
        bits.append(html_escape(safe_id(r.get("channel_id"))))
    if r.get("capability"):
        bits.append(html_escape(safe_id(r.get("capability"), 32)))
    bits.append(f"{html_escape(r.get('status') or '?')} {html_escape(age_label(started, now))}")
    if beat is not None and r.get("status") != "queued":
        bits.append(f"beat {html_escape(age_label(beat, now))} ago")
    if r.get("id") in stuck_ids:
        bits.append("<b>STUCK</b>")
    return "• " + " · ".join(bits)


def view_queue(ops: OperatorSources) -> Reply:
    now, cfg = ops.now(), ops.cfg
    since = now - timedelta(hours=1)
    lines = [_b("Queue")]

    rj = ops.render_jobs(since)
    if not rj.ok:
        lines.append(f"Render jobs: {_unknown(rj)}")
    else:
        c = analysis.classify_render_jobs(rj.data, now, cfg)
        stuck_ids = {r["id"] for r in c["stuck"]}
        lines.append(f"Render jobs: {len(c['running'])} running, {len(c['queued'])} queued, "
                     f"{len(c['stuck'])} stuck")
        for r in (c["running"] + c["queued"])[:8]:
            lines.append(_job_line(r, now, "run", stuck_ids))

    cj = ops.creative_jobs(since)
    if not cj.ok:
        lines.append(f"Creative jobs: {_unknown(cj)}")
    else:
        c = analysis.classify_creative_jobs(cj.data, now, cfg)
        stuck_ids = {r["id"] for r in c["stuck"]}
        lines.append(f"Creative jobs: {len(c['running'])} running, {len(c['queued'])} queued, "
                     f"{len(c['stuck'])} stuck")
        for r in (c["running"] + c["queued"])[:8]:
            lines.append(_job_line(r, now, "job", stuck_ids))
    lines.append(f"Stuck = no heartbeat for {STUCK_HEARTBEAT_MINUTES} min, or queued over {cfg.stuck_minutes} min.")
    return Reply("\n".join(lines), _with_menu(
        [[cb("Errors", "c:errors"), cb("Health", "c:health")]],
        [url_button("Open jobs", app_link(cfg, "jobs"))], again="queue"))


# -- /errors ---------------------------------------------------------------

def _grouped(counter, limit: int = 6) -> str:
    items = counter.most_common(limit)
    text = ", ".join(f"{safe_id(k, 40)} ×{v}" for k, v in items)
    more = len(counter) - len(items)
    return text + (f", +{more} more" if more > 0 else "")


def view_errors(ops: OperatorSources) -> Reply:
    now, cfg = ops.now(), ops.cfg
    since = now - timedelta(hours=24)
    lines = [_b("Errors — last 24 hours")]

    rj = ops.render_jobs(since)
    if not rj.ok:
        lines.append(f"Render jobs: {_unknown(rj)}")
    else:
        failed = analysis.classify_render_jobs(rj.data, now, cfg)["failed"]
        failed = [r for r in failed if (parse_ts(r.get("finished_at")) or now) >= since]
        if not failed:
            lines.append("Render jobs: none failed")
        else:
            lines.append(f"Render jobs: {len(failed)} failed — {html_escape(_grouped(analysis.count_by(failed, 'channel_id')))}")
            lines.append("ids: " + html_escape(", ".join(f"#{safe_id(r['id'], 12)}" for r in failed[:8])))

    cj = ops.creative_jobs(since)
    if not cj.ok:
        lines.append(f"Creative jobs: {_unknown(cj)}")
    else:
        failed = analysis.classify_creative_jobs(cj.data, now, cfg)["failed"]
        failed = [r for r in failed if (parse_ts(r.get("finished_at")) or now) >= since]
        if not failed:
            lines.append("Creative jobs: none failed")
        else:
            lines.append(f"Creative jobs: {len(failed)} failed — {html_escape(_grouped(analysis.count_by(failed, 'error_code')))}")

    ev = ops.events(since, ("render.failed", "upload.failed", "short.failed", "repair.failed"))
    if not ev.ok:
        lines.append(f"Pipeline events: {_unknown(ev)}")
    else:
        counts = analysis.event_counts(ev.data)
        lines.append("Pipeline events: " + (html_escape(", ".join(f"{k} ×{v}" for k, v in sorted(counts.items())))
                                            if counts else "none failed"))
    lines.append("No error text is shown here, only ids and codes. The Errors page has the detail.")
    return Reply("\n".join(lines), _with_menu(
        [[cb("Queue", "c:queue"), cb("Health", "c:health")]],
        [url_button("Open errors", app_link(cfg, "errors"))], again="errors"))


# -- /balance, /spend ------------------------------------------------------

def _low_threshold() -> float:
    from modules import provider_balance
    return provider_balance.low_credit_threshold()


def view_balance(ops: OperatorSources, low: Optional[float] = None) -> Reply:
    now, cfg = ops.now(), ops.cfg
    low = _low_threshold() if low is None else low
    lines = [_b("Provider balances")]
    sec = ops.balances()
    if not sec.ok:
        lines.append(f"Balances: {_unknown(sec)}")
    else:
        rows = analysis.balance_flags(sec.data, low)
        if not rows:
            lines.append("No balance snapshot yet (the Provider Balances workflow records them every 6 hours).")
        for r in sorted(rows, key=lambda x: str(x.get("provider"))):
            rem, tot = r["remaining_n"], analysis._num(r.get("total"))
            of = f" of {_n(tot)}" if tot is not None else ""
            tier = f" ({html_escape(clip(r.get('tier'), 24))})" if r.get("tier") else ""
            flag = f" — <b>LOW</b> (threshold {_n(low)})" if r["low"] else ""
            checked = age_label(parse_ts(r.get("checked_at")), now)
            lines.append(f"• {html_escape(safe_id(r.get('provider'), 24))} {html_escape(safe_id(r.get('metric'), 24))}: "
                         f"{'unknown' if rem is None else _n(rem)}{html_escape(of)} {html_escape(safe_id(r.get('unit'), 12))}"
                         f"{tier}{flag} · checked {html_escape(checked)} ago")
        lines.append("Only providers with a balance API appear here; the others are on the Billing page.")
    return Reply("\n".join(lines), _with_menu(
        [[cb("Spend", "c:spend")]], [url_button("Open billing", app_link(cfg, "billing"))], again="balance"))


def _cost_line(label: str, sec: Section, since: datetime) -> str:
    if not sec.ok:
        return f"{label}: {_unknown(sec)}"
    rows = [r for r in sec.data if (parse_ts(r.get("recorded_at")) or since) >= since]
    s = analysis.summarize_costs(rows)
    if s["rows"] == 0:
        return f"{label}: no cost rows"
    capped = " (list cut at 5,000 rows)" if len(sec.data) >= 5000 else ""
    if s["usd"] is None:
        return f"{label}: unknown — {s['unpriced']} cost row(s), none priced{capped}"
    if s["complete"]:
        return f"{label}: {_usd(s['usd'])} ({s['priced']} priced rows){capped}"
    return f"{label}: at least {_usd(s['usd'])} — {s['unpriced']} row(s) unpriced, so not a total{capped}"


def view_spend(ops: OperatorSources) -> Reply:
    now, cfg = ops.now(), ops.cfg
    day = now.astimezone(cfg.tz).replace(hour=0, minute=0, second=0, microsecond=0)
    week = now - timedelta(days=7)
    lines = [_b("Spend — provider cost")]
    costs = ops.creative_costs(week)
    lines.append(html_escape(_cost_line("Today", costs, day)))
    lines.append(html_escape(_cost_line("7 days", costs, week)))
    cap = ops.credits_captured(week)
    if cap.ok:
        today_rows = [r for r in cap.data if (parse_ts(r.get("finished_at")) or week) >= day]
        lines.append(f"Credits captured (completed creative jobs): today {_n(analysis.sum_credits(today_rows))}, "
                     f"7 days {_n(analysis.sum_credits(cap.data))}")
    else:
        lines.append(f"Credits captured: {_unknown(cap)}")
    lines.append("Revenue in USD is not computed here: it needs the operator session "
                 "(the Margin report is platform-admin only). Open it below.")
    lines.append("Costs are the recorded estimates of creative jobs; pipeline-run costs live in the cost ledger.")
    return Reply("\n".join(lines), _with_menu(
        [[cb("Balance", "c:balance")]], [url_button("Open margin", app_link(cfg, "margin"))], again="spend"))


# -- /today, /users --------------------------------------------------------

def view_today(ops: OperatorSources) -> Reply:
    now, cfg = ops.now(), ops.cfg
    day = now.astimezone(cfg.tz).replace(hour=0, minute=0, second=0, microsecond=0)
    lines = [f"<b>Today — since 00:00 {html_escape(str(day.tzinfo))}</b>"]
    ev = ops.events(day, ("render.completed", "video.published", "publish.held", "publish.blocked",
                          "render.failed", "upload.failed"))
    if not ev.ok:
        lines.append(f"Videos: {_unknown(ev)}")
    else:
        c = analysis.event_counts(ev.data)
        lines.append(f"Videos made {c.get('render.completed', 0)} · published {c.get('video.published', 0)} · "
                     f"held {c.get('publish.held', 0)} · blocked by the gate {c.get('publish.blocked', 0)} · "
                     f"failed {c.get('render.failed', 0) + c.get('upload.failed', 0)}")
    rj = ops.render_jobs(day)
    if rj.ok:
        c = analysis.classify_render_jobs(rj.data, now, cfg)
        done = [r for r in c["succeeded"] if (parse_ts(r.get("finished_at")) or day) >= day]
        bad = [r for r in c["failed"] if (parse_ts(r.get("finished_at")) or day) >= day]
        lines.append(f"Render jobs: {len(done)} succeeded, {len(bad)} failed, {len(c['running'])} running, "
                     f"{len(c['queued'])} queued")
    else:
        lines.append(f"Render jobs: {_unknown(rj)}")
    cj = ops.creative_jobs(day)
    if cj.ok:
        c = analysis.classify_creative_jobs(cj.data, now, cfg)
        done = [r for r in c["completed"] if (parse_ts(r.get("finished_at")) or day) >= day]
        bad = [r for r in c["failed"] if (parse_ts(r.get("finished_at")) or day) >= day]
        lines.append(f"Creative jobs: {len(done)} completed, {len(bad)} failed")
    else:
        lines.append(f"Creative jobs: {_unknown(cj)}")
    su = ops.signups(day)
    lines.append(f"New accounts: {len(su.data)}" if su.ok else f"New accounts: {_unknown(su)}")
    lines.append("Video counts come from the mirrored event log; a run whose events were not mirrored is not counted.")
    return Reply("\n".join(lines), _with_menu([[cb("Users", "c:users"), cb("Errors", "c:errors")]], again="today"))


def view_users(ops: OperatorSources) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [_b("New accounts")]
    sec = ops.signups(now - timedelta(days=30))
    if not sec.ok:
        lines.append(f"Sign-ups: {_unknown(sec)}")
    else:
        stamps = [parse_ts(r.get("created_at")) for r in sec.data]
        stamps = [s for s in stamps if s]

        def since(delta):
            return sum(1 for s in stamps if s >= now - delta)

        capped = " (list cut at 5,000)" if len(sec.data) >= 5000 else ""
        lines.append(f"Last 24 hours: {since(timedelta(hours=24))}")
        lines.append(f"Last 7 days: {since(timedelta(days=7))}")
        lines.append(f"Last 30 days: {len(stamps)}{capped}")
        lines.append("Counted as organizations created (one per sign-up). Counts only: no names, no e-mails.")
    return Reply("\n".join(lines), _with_menu([[cb("Today", "c:today")]], again="users"))


# -- /deploys, /approvals, /security ---------------------------------------

def view_deploys(ops: OperatorSources) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [_b("Deploys and CI (main)")]
    dep = ops.deploys()
    if not dep.ok:
        lines.append(f"GitHub: {_unknown(dep)}")
    else:
        for wf in dep.data:
            if not wf.get("ok"):
                lines.append(f"{html_escape(wf['label'].capitalize())}: unknown (GitHub did not answer)")
                continue
            lines.append(_b(wf["label"].capitalize()))
            for r in wf["runs"]:
                lines.append(f"• {_c(safe_id(r.get('sha'), 7))} {html_escape(_run_word(r))} · "
                             f"{html_escape(age_label(parse_ts(r.get('at')), now))} ago")
    return Reply("\n".join(lines), _with_menu(
        [[cb("Health", "c:health")]], [url_button("Open deploys", github_actions_link(cfg))], again="deploys"))


def view_approvals(ops: OperatorSources, held: Optional[list] = None) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [_b("Waiting for a person")]
    pa = ops.publish_approvals()
    if not pa.ok:
        lines.append(f"Publish approvals: {_unknown(pa)}")
    elif not pa.data:
        lines.append("Publish approvals: none pending")
    else:
        lines.append(f"Publish approvals: {len(pa.data)} pending")
        for r in pa.data[:8]:
            lines.append(f"• {html_escape(safe_id(r.get('channel_id')))} · "
                         f"{html_escape(age_label(parse_ts(r.get('requested_at')), now))} waiting")
    runs = ops.runs_awaiting_approval()
    if not runs.ok:
        lines.append(f"Runs at human approval: {_unknown(runs)}")
    elif not runs.data:
        lines.append("Runs at human approval: none")
    else:
        lines.append(f"Runs at human approval: {len(runs.data)}")
        for r in runs.data[:8]:
            lines.append(f"• {_c(safe_id(r.get('run_id'), 40))} · "
                         f"{html_escape(age_label(parse_ts(r.get('updated_at')), now))}")
    if held is not None:
        lines.append(f"Held for review (auto-publish off): {len(held)}")
    lines.append("Deciding happens in the app. Nothing here approves or publishes.")
    return Reply("\n".join(lines), _with_menu(
        [[cb("Held", "c:pending")]], [url_button("Open approvals", app_link(cfg, "approvals"))], again="approvals"))


def view_security(ops: OperatorSources) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [_b("Security-relevant events — 24 hours")]
    sec = ops.audit(now - timedelta(hours=24))
    if not sec.ok:
        lines.append(f"Audit log: {_unknown(sec)}")
    elif not sec.data:
        lines.append("None.")
    else:
        for r in sec.data[:12]:
            tgt = f" → {html_escape(safe_id(r.get('target'), 40))}" if r.get("target") else ""
            lines.append(f"• {_c(safe_id(r.get('action'), 40))}{tgt} · "
                         f"{html_escape(age_label(parse_ts(r.get('at')), now))} ago")
        if len(sec.data) > 12:
            lines.append(f"+{len(sec.data) - 12} more")
    lines.append("Actors are not shown (no e-mails). The Audit page names them.")
    return Reply("\n".join(lines), _with_menu([], [url_button("Open audit", app_link(cfg, "audit"))], again="security"))


# -- /digest ---------------------------------------------------------------

def view_digest(ops: OperatorSources, held: Optional[list] = None) -> Reply:
    """The daily summary: one line per area, each the headline of its command."""
    now, cfg = ops.now(), ops.cfg
    day = now.astimezone(cfg.tz).replace(hour=0, minute=0, second=0, microsecond=0)
    since24 = now - timedelta(hours=24)
    lines = [f"<b>Daily digest — {html_escape(cfg.local_date(now))}</b>"]

    site = ops.site()
    if site.ok:
        bad = [r for r in site.data if r["status"] is None or not (200 <= r["status"] < 400)]
        lines.append("Site: " + ("<b>DOWN</b> " + html_escape(", ".join(r["path"] for r in bad)) if bad else "OK"))
    else:
        lines.append(f"Site: {_unknown(site)}")

    workers = ops.workers()
    if workers.ok:
        ws = analysis.classify_workers(workers.data, now)
        stale = [w for w in ws if w["stale"] or w.get("state") == "failed"]
        lines.append(f"Workers: {len(ws)} reporting" + (f", <b>{len(stale)} need attention</b>" if stale else ", all fine"))
    else:
        lines.append(f"Workers: {_unknown(workers)}")

    rj, cj = ops.render_jobs(since24), ops.creative_jobs(since24)
    if rj.ok:
        c = analysis.classify_render_jobs(rj.data, now, cfg)
        fin = lambda rs: [r for r in rs if (parse_ts(r.get("finished_at")) or since24) >= since24]
        lines.append(f"Render jobs (24h): {len(fin(c['succeeded']))} ok, {len(fin(c['failed']))} failed, "
                     f"{len(c['stuck'])} stuck now")
    else:
        lines.append(f"Render jobs: {_unknown(rj)}")
    if cj.ok:
        c = analysis.classify_creative_jobs(cj.data, now, cfg)
        fin = lambda rs: [r for r in rs if (parse_ts(r.get("finished_at")) or since24) >= since24]
        lines.append(f"Creative jobs (24h): {len(fin(c['completed']))} completed, {len(fin(c['failed']))} failed")
    else:
        lines.append(f"Creative jobs: {_unknown(cj)}")

    ev = ops.events(day, ("render.completed", "video.published", "publish.held"))
    if ev.ok:
        c = analysis.event_counts(ev.data)
        lines.append(f"Videos today: made {c.get('render.completed', 0)}, published {c.get('video.published', 0)}, "
                     f"held {c.get('publish.held', 0)}")
    su = ops.signups(since24)
    lines.append(f"New accounts (24h): {len(su.data)}" if su.ok else f"New accounts: {_unknown(su)}")

    bal = ops.balances()
    if bal.ok:
        flagged = [r for r in analysis.balance_flags(bal.data, _low_threshold()) if r["low"]]
        lines.append("Balances: " + (f"<b>LOW</b> — {html_escape(', '.join(safe_id(r['provider']) for r in flagged))}"
                                     if flagged else "none low"))
    else:
        lines.append(f"Balances: {_unknown(bal)}")

    costs = ops.creative_costs(since24)
    lines.append(html_escape(_cost_line("Provider cost (24h)", costs, since24)))

    pa, runs = ops.publish_approvals(), ops.runs_awaiting_approval()
    waiting = (len(pa.data) if pa.ok else 0) + (len(runs.data) if runs.ok else 0)
    lines.append(f"Waiting for a person: {waiting}" + ("" if pa.ok and runs.ok else " (some sources unknown)"))
    if held is not None:
        lines.append(f"Held for review: {len(held)}")

    dep = ops.deploys()
    if dep.ok:
        lines.extend(_deploy_summary_lines(dep.data, now))
    return Reply("\n".join(lines), _with_menu(
        [[cb("Health", "c:health"), cb("Errors", "c:errors")]],
        [url_button("Open dashboard", app_link(cfg, "home"))], again="digest"))


# -- /alerts ---------------------------------------------------------------

def view_alerts(cfg: OperatorConfig, state, now: datetime) -> Reply:
    """Alert settings and mutes. ``state`` is an AlertState, or None when the
    alert memory could not be read."""
    lines = [_b("Alerts")]
    q = cfg.quiet_hours
    lines.append("Quiet hours: " + (f"{q[0]:02d}:00–{q[1]:02d}:00 {html_escape(str(cfg.tz))}, critical alerts still go"
                                    if q else "off"))
    lines.append("Daily digest: " + (f"{cfg.digest_hour:02d}:00 {html_escape(str(cfg.tz))}"
                                     if cfg.digest_hour is not None else "off"))
    lines.append(f"Limit: {cfg.max_alerts_per_hour} non-critical alerts an hour")
    if state is None:
        lines.append("Alert memory: unavailable — no alert is sent until it is readable")
    else:
        if state.mutes:
            for kind, until in sorted(state.mutes.items()):
                local = until.astimezone(cfg.tz).strftime("%H:%M")
                lines.append(f"Muted: {html_escape(kind)} until {local} {html_escape(str(cfg.tz))}")
        else:
            lines.append("Muted: nothing")
        recent = [a for a in sorted(state.alerts, key=lambda a: a[0], reverse=True) if a[3]][:5]
        if recent:
            lines.append("Last sent:")
            lines += [f"• {_c(safe_id(a[1], 40))} · {html_escape(age_label(a[0], now))} ago" for a in recent]
    rows = [[cb(f"Mute {k}", f"a:mute:{k}") for k in ALERT_KINDS[i:i + 3]] for i in range(0, len(ALERT_KINDS), 3)]
    rows.append([cb("Mute all 24h", "a:mute:all"), cb("Unmute all", "a:unmute:all")])
    return Reply("\n".join(lines), _with_menu(rows, again="alerts"))
