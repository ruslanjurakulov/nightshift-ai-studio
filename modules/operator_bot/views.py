"""The operator bot's messages and keyboards.

Every function takes the sources and returns a :class:`Reply`: HTML text and an
inline keyboard. Rules the whole file keeps:

* Dynamic text is escaped with ``html_escape`` at the point it is interpolated,
  and free text is ``clip``-ped first. Nothing here prints a person's words:
  ids, counts, statuses, short codes, ages. The only strings that are not
  one of those are a failed worker's own ``detail`` (its scrubbed remedy line)
  and an audit row's ``target``; both are clipped, scrubbed and escaped.
* A read that hit its row limit says so ("list cut at N"): a cut list is a
  floor, never presented as the whole.
* A source that could not answer prints its neutral note, never a zero.
* Money is shown only as the sources hold it: a USD figure built from rows that
  were not all priced is labelled "at least", never a total.
* Each line is well-formed HTML on its own, so ``split_message`` may cut between
  any two lines.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from modules.operator_bot import analysis
from modules.operator_bot.config import OperatorConfig, STUCK_HEARTBEAT_MINUTES
from modules.operator_bot.i18n import DEFAULT_LANGUAGE, LANGUAGES, Raw, has, t
from modules.operator_bot.sources import OperatorSources, Section, age_label, parse_ts
from modules.tg_text import clip, html_escape, safe_id, short_id

# Alert kinds (short, because callback_data is limited to 64 bytes) and where
# each one points. The kind ids are stable identifiers (they travel in callback
# data and in /mute); what the owner reads for each comes from the copy table.
ALERT_KINDS = ("run", "stuck", "balance", "deploy", "worker", "approval", "audit", "payment", "marketing")
KIND_COMMAND = {
    "run": "errors", "stuck": "queue", "balance": "balance", "deploy": "deploys",
    "worker": "health", "approval": "approvals", "audit": "security", "payment": "payments",
    "marketing": "marketing",
}
KIND_PAGE = {
    "run": "errors", "stuck": "jobs", "balance": "billing", "worker": "integrations",
    "approval": "approvals", "audit": "audit", "marketing": "marketing",
}
#: Kinds with no page of their own that fall back to the GitHub Actions link (a
#: deploy). A kind in neither table has no Open button: a payment has no page
#: in the app, and a link is never guessed.
GITHUB_KINDS = ("deploy",)

#: The read-only commands, in menu order. What each one is described as comes
#: from the copy table (``cmddesc.<name>``).
COMMANDS = tuple((name, f"cmddesc.{name}") for name in (
    "health", "queue", "errors", "balance", "spend", "payments", "today", "users", "deploys",
    "approvals", "marketing", "security", "digest", "alerts", "status", "pending"))
READ_COMMANDS = tuple(name for name, _ in COMMANDS)


@dataclass
class Reply:
    text: str
    keyboard: list = field(default_factory=list)   # rows of button dicts
    parse_mode: Optional[str] = "HTML"

    def markup(self) -> Optional[dict]:
        return {"inline_keyboard": self.keyboard} if self.keyboard else None


# -- text helpers ----------------------------------------------------------

def b(text) -> Raw:
    return Raw(f"<b>{html_escape(text)}</b>")


def code(text) -> Raw:
    return Raw(f"<code>{html_escape(text)}</code>")


_NOTE_KEYS = {"not configured": "note.not_configured", "not set up yet": "note.not_set_up",
              "unavailable": "note.unavailable"}


def unknown(lang: str, sec: Section) -> Raw:
    """``unknown (<why>)`` in the owner's language: a source that could not answer."""
    why = t(lang, _NOTE_KEYS.get(sec.note or "unavailable", "note.unavailable"))
    return Raw(t(lang, "unknown", why=Raw(why)))


def status_word(lang: str, value) -> Raw:
    """A job / worker / run status in the owner's language when the table knows
    it; otherwise the raw value, made safe to print."""
    key = f"st.{safe_id(value, 32)}"
    return Raw(t(lang, key) if has(lang, key) else html_escape(safe_id(value, 32) or "?"))


def ago(lang: str, since: Optional[datetime], now: datetime) -> Raw:
    return Raw(t(lang, "ago", age=age_label(since, now)))


def cut(lang: str, sec: Section) -> Raw:
    """A suffix for a line built from a read that hit its row limit."""
    return Raw(t(lang, "cut", n=sec.cap) if getattr(sec, "cap", 0) else "")


def num(lang: str, value, digits: int = 0) -> str:
    """Neutral number format (thousands comma, dot decimal) in every language."""
    try:
        return f"{float(value):,.{digits}f}"
    except (TypeError, ValueError):
        return t(lang, "unknown_word")


def usd(value: float) -> str:
    return f"${value:,.2f}" if abs(value) >= 0.01 or value == 0 else f"${value:,.4f}"


# -- buttons ---------------------------------------------------------------

def cb(text: str, data: str) -> dict:
    assert len(data.encode()) <= 64, data
    return {"text": text, "callback_data": data}


def url_button(text: str, url: Optional[str]) -> Optional[dict]:
    return {"text": text, "url": url} if url else None


def open_button(lang: str, page: str, url: Optional[str]) -> Optional[dict]:
    """The deep-link button for a page (``btn.open_<page>``)."""
    return url_button(t(lang, f"btn.open_{page}"), url)


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
#: the groups; each button runs one read-only command. Labels: ``cmd.<name>``;
#: group names: ``grp.<group>``.
MENU_GROUPS = (
    ("live", ("health", "queue", "errors")),
    ("money", ("balance", "spend", "payments")),
    ("activity", ("today", "users", "deploys", "approvals", "marketing")),
    ("reports", ("security", "digest", "alerts")),
    ("original", ("status", "channels", "pending")),
)


def menu_keyboard(lang: str = DEFAULT_LANGUAGE) -> list:
    rows = [[cb(t(lang, f"cmd.{name}"), f"c:{name}") for name in names] for _g, names in MENU_GROUPS]
    rows.append(language_row())
    return rows


def language_row() -> list:
    """One button per language, each labelled in its own language."""
    return [cb(t(code_, "lang.name"), f"l:{code_}") for code_ in LANGUAGES]


def _with_menu(lang: str, rows: list, extra_links: Optional[list] = None, again: Optional[str] = None) -> list:
    """Buttons for one view: its own rows, deep links, then Refresh (run the
    same command again) and Menu."""
    out = [r for r in rows if r]
    links = [x for x in (extra_links or []) if x]
    if links:
        out.append(links)
    out.append(([cb(t(lang, "btn.refresh"), f"c:{again}")] if again else []) + [cb(t(lang, "btn.menu"), "c:menu")])
    return out


def _nav(lang: str, *names: str) -> list:
    """A row of buttons that run other commands (labelled ``cmd.<name>``)."""
    return [cb(t(lang, f"cmd.{n}"), f"c:{n}") for n in names]


# -- menu / help -----------------------------------------------------------

def view_menu(cfg: OperatorConfig, lang: str = DEFAULT_LANGUAGE) -> Reply:
    groups = [t(lang, "menu.group", group=t(lang, f"grp.{g}"),
                items=", ".join(t(lang, f"cmd.{n}").lower() for n in names))
              for g, names in MENU_GROUPS]
    return Reply("\n".join([t(lang, "menu.title"), *groups, t(lang, "menu.hint")]), menu_keyboard(lang))


def view_help(lang: str = DEFAULT_LANGUAGE) -> Reply:
    lines = [t(lang, "help.title"), t(lang, "help.readonly")]
    lines += [f"/{name} — {t(lang, key)}" for name, key in COMMANDS]
    lines += [t(lang, k) for k in (
        "help.channels", "help.menu", "help.language", "help.safe", "help.mute", "help.unmute", "help.viewonly")]
    lines.append(t(lang, "help.kinds", kinds=", ".join(ALERT_KINDS)))
    return Reply("\n".join(lines), [language_row(), [cb(t(lang, "btn.menu"), "c:menu")]])


def view_language(cfg: OperatorConfig, lang: str = DEFAULT_LANGUAGE, changed: bool = False) -> Reply:
    lines = []
    if changed:
        lines.append(t(lang, "language.set", name=t(lang, "lang.name")))
    lines.append(t(lang, "language.current", name=t(lang, "lang.name")))
    lines.append(t(lang, "language.choose"))
    return Reply("\n".join(lines), [language_row(), [cb(t(lang, "btn.menu"), "c:menu")]])


# -- /health ---------------------------------------------------------------

def view_health(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [t(lang, "health.title")]

    site = ops.site()
    if not site.ok:
        lines.append(t(lang, "health.site_unknown", why=unknown(lang, site)))
    else:
        bad = [r for r in site.data if r["status"] is None or not (200 <= r["status"] < 400)]
        if bad:
            lines.append(t(lang, "health.site_down", pages=", ".join(
                f"{r['path']} {r['status'] if r['status'] else t(lang, 'health.no_answer')}" for r in bad)))
        else:
            lines.append(t(lang, "health.site_ok", n=len(site.data)))

    workers = ops.workers()
    if not workers.ok:
        lines.append(t(lang, "health.workers_unknown", why=unknown(lang, workers)))
    else:
        rows = analysis.classify_workers(workers.data, now)
        if not rows:
            lines.append(t(lang, "health.workers_none"))
        for w in rows[:8]:
            tag = status_word(lang, "stale") if w["stale"] else status_word(lang, w.get("state") or "?")
            beat = ago(lang, None if w["age_s"] is None else now - timedelta(seconds=w["age_s"]), now)
            extra = ""
            if w.get("state") == "failed" and w.get("detail"):
                extra = " — " + clip(w["detail"], 100)
            lines.append(t(lang, "health.worker_line", id=code(safe_id(w.get("worker_id"))),
                           kind=w.get("kind") or "?", tag=Raw(f"<b>{tag}</b>"),
                           beat=beat, extra=extra))

    dep = ops.deploys()
    if not dep.ok:
        lines.append(t(lang, "health.deploys_unknown", why=unknown(lang, dep)))
    else:
        lines.extend(_deploy_summary_lines(lang, dep.data, now))

    lines.append(t(lang, "health.disk"))
    kb = _with_menu(
        lang, [_nav(lang, "queue", "deploys")],
        [open_button(lang, "integrations", app_link(cfg, "integrations"))],
        again="health",
    )
    return Reply("\n".join(lines), kb)


def _run_word(run: dict) -> str:
    if run.get("status") != "completed":
        return str(run.get("status") or "?")
    return str(run.get("conclusion") or "unknown")


def _deploy_summary_lines(lang: str, data: list, now: datetime) -> list[str]:
    lines = []
    for wf in data:
        label = t(lang, f"wf.{wf['label']}") if has(lang, f"wf.{wf['label']}") else wf["label"].capitalize()
        if not wf.get("ok"):
            lines.append(t(lang, "deploys.unknown", label=label))
            continue
        run = analysis.latest_run(wf["runs"])
        if run is None:
            lines.append(t(lang, "deploys.none", label=label))
            continue
        word = _run_word(run)
        mark = Raw(t(lang, "deploys.failed_mark")) if word in ("failure", "timed_out", "startup_failure") \
            else status_word(lang, word)
        lines.append(t(lang, "deploys.line", label=label, mark=mark, sha=code(safe_id(run.get("sha"), 7)),
                       when=ago(lang, parse_ts(run.get("at")), now)))
    return lines


# -- /queue ----------------------------------------------------------------

def _job_line(lang: str, r: dict, now: datetime, name: str, stuck_ids: set) -> str:
    started = parse_ts(r.get("started_at")) or parse_ts(r.get("created_at"))
    beat = parse_ts(r.get("heartbeat_at"))
    bits = [t(lang, f"queue.{name}", id=code(safe_id(r.get("id"), 12)))]
    if r.get("channel_id"):
        bits.append(html_escape(safe_id(r.get("channel_id"))))
    if r.get("capability"):
        bits.append(html_escape(safe_id(r.get("capability"), 32)))
    bits.append(f"{status_word(lang, r.get('status') or '?')} {html_escape(age_label(started, now))}")
    if beat is not None and r.get("status") != "queued":
        bits.append(t(lang, "queue.beat", when=ago(lang, beat, now)))
    if r.get("id") in stuck_ids:
        bits.append(t(lang, "queue.stuck_mark"))
    return "• " + " · ".join(bits)


def view_queue(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    since = now - timedelta(hours=1)
    lines = [t(lang, "queue.title")]

    rj = ops.render_jobs(since)
    if not rj.ok:
        lines.append(t(lang, "queue.render_unknown", why=unknown(lang, rj)))
    else:
        c = analysis.classify_render_jobs(rj.data, now, cfg)
        stuck_ids = {r["id"] for r in c["stuck"]}
        lines.append(t(lang, "queue.render", running=len(c["running"]), queued=len(c["queued"]),
                       stuck=len(c["stuck"]), cut=cut(lang, rj)))
        for r in (c["running"] + c["queued"])[:8]:
            lines.append(_job_line(lang, r, now, "run", stuck_ids))

    cj = ops.creative_jobs(since)
    if not cj.ok:
        lines.append(t(lang, "queue.creative_unknown", why=unknown(lang, cj)))
    else:
        c = analysis.classify_creative_jobs(cj.data, now, cfg)
        stuck_ids = {r["id"] for r in c["stuck"]}
        lines.append(t(lang, "queue.creative", running=len(c["running"]), queued=len(c["queued"]),
                       stuck=len(c["stuck"]), cut=cut(lang, cj)))
        for r in (c["running"] + c["queued"])[:8]:
            lines.append(_job_line(lang, r, now, "job", stuck_ids))
    lines.append(t(lang, "queue.legend", beat=STUCK_HEARTBEAT_MINUTES, wait=cfg.stuck_minutes))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "errors", "health")],
        [open_button(lang, "jobs", app_link(cfg, "jobs"))], again="queue"))


# -- /errors ---------------------------------------------------------------

def _grouped(lang: str, counter, limit: int = 6) -> str:
    items = counter.most_common(limit)
    text = ", ".join(f"{safe_id(k, 40)} ×{v}" for k, v in items)
    more = len(counter) - len(items)
    return text + (t(lang, "errors.more", n=more) if more > 0 else "")


def view_errors(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    since = now - timedelta(hours=24)
    lines = [t(lang, "errors.title")]

    rj = ops.render_jobs(since)
    if not rj.ok:
        lines.append(t(lang, "errors.render_unknown", why=unknown(lang, rj)))
    else:
        failed = analysis.classify_render_jobs(rj.data, now, cfg)["failed"]
        failed = [r for r in failed if (parse_ts(r.get("finished_at")) or now) >= since]
        if not failed:
            lines.append(t(lang, "errors.render_none"))
        else:
            lines.append(t(lang, "errors.render", n=len(failed),
                           groups=_grouped(lang, analysis.count_by(failed, "channel_id")), cut=cut(lang, rj)))
            lines.append(t(lang, "errors.ids", ids=", ".join(f"#{safe_id(r['id'], 12)}" for r in failed[:8])))

    cj = ops.creative_jobs(since)
    if not cj.ok:
        lines.append(t(lang, "errors.creative_unknown", why=unknown(lang, cj)))
    else:
        failed = analysis.classify_creative_jobs(cj.data, now, cfg)["failed"]
        failed = [r for r in failed if (parse_ts(r.get("finished_at")) or now) >= since]
        if not failed:
            lines.append(t(lang, "errors.creative_none"))
        else:
            lines.append(t(lang, "errors.creative", n=len(failed),
                           groups=_grouped(lang, analysis.count_by(failed, "error_code")), cut=cut(lang, cj)))

    ev = ops.events(since, ("render.failed", "upload.failed", "short.failed", "repair.failed"))
    if not ev.ok:
        lines.append(t(lang, "errors.events_unknown", why=unknown(lang, ev)))
    else:
        counts = analysis.event_counts(ev.data)
        what = ", ".join(f"{k} ×{v}" for k, v in sorted(counts.items())) if counts else t(lang, "errors.events_none")
        lines.append(t(lang, "errors.events", what=what, cut=cut(lang, ev)))
    lines.append(t(lang, "errors.footer"))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "queue", "health")],
        [open_button(lang, "errors", app_link(cfg, "errors"))], again="errors"))


# -- /balance, /spend ------------------------------------------------------

def _low_threshold() -> float:
    from modules import provider_balance
    return provider_balance.low_credit_threshold()


def view_balance(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE, low: Optional[float] = None) -> Reply:
    now, cfg = ops.now(), ops.cfg
    low = _low_threshold() if low is None else low
    lines = [t(lang, "balance.title")]
    sec = ops.balances()
    if not sec.ok:
        lines.append(t(lang, "balance.unknown", why=unknown(lang, sec)))
    else:
        rows = analysis.balance_flags(sec.data, low)
        if not rows:
            lines.append(t(lang, "balance.none"))
        for r in sorted(rows, key=lambda x: str(x.get("provider"))):
            rem, tot = r["remaining_n"], analysis._num(r.get("total"))
            lines.append(t(
                lang, "balance.line", provider=safe_id(r.get("provider"), 24), metric=safe_id(r.get("metric"), 24),
                remaining=t(lang, "unknown_word") if rem is None else num(lang, rem),
                of=t(lang, "balance.of", total=num(lang, tot)) if tot is not None else "",
                unit=safe_id(r.get("unit"), 12),
                tier=f" ({clip(r.get('tier'), 24)})" if r.get("tier") else "",
                flag=Raw(t(lang, "balance.low_flag", threshold=num(lang, low))) if r["low"] else "",
                checked=ago(lang, parse_ts(r.get("checked_at")), now)))
        lines.append(t(lang, "balance.footer"))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "spend")], [open_button(lang, "billing", app_link(cfg, "billing"))], again="balance"))


def _cost_line(lang: str, label: str, sec: Section, since: datetime) -> str:
    if not sec.ok:
        return t(lang, "cost.unknown_src", label=label, why=unknown(lang, sec))
    rows = [r for r in sec.data if (parse_ts(r.get("recorded_at")) or since) >= since]
    s = analysis.summarize_costs(rows)
    if s["rows"] == 0:
        return t(lang, "cost.none", label=label)
    capped = Raw(t(lang, "cost.cut")) if len(sec.data) >= 5000 else ""
    if s["usd"] is None:
        return t(lang, "cost.all_unpriced", label=label, n=s["unpriced"], cut=capped)
    if s["complete"]:
        return t(lang, "cost.complete", label=label, usd=usd(s["usd"]), n=s["priced"], cut=capped)
    return t(lang, "cost.partial", label=label, usd=usd(s["usd"]), n=s["unpriced"], cut=capped)


def view_spend(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    day = now.astimezone(cfg.tz).replace(hour=0, minute=0, second=0, microsecond=0)
    week = now - timedelta(days=7)
    lines = [t(lang, "spend.title")]
    costs = ops.creative_costs(week)
    lines.append(_cost_line(lang, t(lang, "spend.today"), costs, day))
    lines.append(_cost_line(lang, t(lang, "spend.days7"), costs, week))
    cap = ops.credits_captured(week)
    if cap.ok:
        today_rows = [r for r in cap.data if (parse_ts(r.get("finished_at")) or week) >= day]
        lines.append(t(lang, "spend.credits", today=num(lang, analysis.sum_credits(today_rows)),
                       week=num(lang, analysis.sum_credits(cap.data)), cut=cut(lang, cap)))
    else:
        lines.append(t(lang, "spend.credits_unknown", why=unknown(lang, cap)))
    lines.append(t(lang, "spend.revenue"))
    lines.append(t(lang, "spend.footer"))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "balance")], [open_button(lang, "margin", app_link(cfg, "margin"))], again="spend"))


# -- /today, /users --------------------------------------------------------

def view_today(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    day = now.astimezone(cfg.tz).replace(hour=0, minute=0, second=0, microsecond=0)
    lines = [t(lang, "today.title", tz=str(day.tzinfo))]
    ev = ops.events(day, ("render.completed", "video.published", "publish.held", "publish.blocked",
                          "render.failed", "upload.failed"))
    if not ev.ok:
        lines.append(t(lang, "today.videos_unknown", why=unknown(lang, ev)))
    else:
        c = analysis.event_counts(ev.data)
        lines.append(t(lang, "today.videos", made=c.get("render.completed", 0), published=c.get("video.published", 0),
                       held=c.get("publish.held", 0), blocked=c.get("publish.blocked", 0),
                       failed=c.get("render.failed", 0) + c.get("upload.failed", 0), cut=cut(lang, ev)))
    rj = ops.render_jobs(day)
    if rj.ok:
        c = analysis.classify_render_jobs(rj.data, now, cfg)
        done = [r for r in c["succeeded"] if (parse_ts(r.get("finished_at")) or day) >= day]
        bad = [r for r in c["failed"] if (parse_ts(r.get("finished_at")) or day) >= day]
        lines.append(t(lang, "today.render", ok=len(done), failed=len(bad), running=len(c["running"]),
                       queued=len(c["queued"]), cut=cut(lang, rj)))
    else:
        lines.append(t(lang, "queue.render_unknown", why=unknown(lang, rj)))
    cj = ops.creative_jobs(day)
    if cj.ok:
        c = analysis.classify_creative_jobs(cj.data, now, cfg)
        done = [r for r in c["completed"] if (parse_ts(r.get("finished_at")) or day) >= day]
        bad = [r for r in c["failed"] if (parse_ts(r.get("finished_at")) or day) >= day]
        lines.append(t(lang, "today.creative", ok=len(done), failed=len(bad), cut=cut(lang, cj)))
    else:
        lines.append(t(lang, "queue.creative_unknown", why=unknown(lang, cj)))
    su = ops.signups(day)
    lines.append(t(lang, "today.accounts", n=len(su.data), cut=cut(lang, su)) if su.ok
                 else t(lang, "today.accounts_unknown", why=unknown(lang, su)))
    lines.append(t(lang, "today.footer"))
    return Reply("\n".join(lines), _with_menu(lang, [_nav(lang, "users", "errors")], again="today"))


def view_users(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [t(lang, "users.title")]
    sec = ops.signups(now - timedelta(days=30))
    if not sec.ok:
        lines.append(t(lang, "users.unknown", why=unknown(lang, sec)))
    else:
        stamps = [parse_ts(r.get("created_at")) for r in sec.data]
        stamps = [s for s in stamps if s]

        def since(delta):
            return sum(1 for s in stamps if s >= now - delta)

        capped = Raw(t(lang, "users.cut")) if len(sec.data) >= 5000 else ""
        lines.append(t(lang, "users.h24", n=since(timedelta(hours=24))))
        lines.append(t(lang, "users.d7", n=since(timedelta(days=7))))
        lines.append(t(lang, "users.d30", n=len(stamps), cut=capped))
        lines.append(t(lang, "users.footer"))
    return Reply("\n".join(lines), _with_menu(lang, [_nav(lang, "today")], again="users"))


# -- /deploys, /approvals, /security ---------------------------------------

def view_deploys(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [t(lang, "deploys.title")]
    dep = ops.deploys()
    if not dep.ok:
        lines.append(t(lang, "deploys.github_unknown", why=unknown(lang, dep)))
    else:
        for wf in dep.data:
            label = t(lang, f"wf.{wf['label']}") if has(lang, f"wf.{wf['label']}") else wf["label"].capitalize()
            if not wf.get("ok"):
                lines.append(t(lang, "deploys.unknown", label=label))
                continue
            lines.append(b(label))
            for r in wf["runs"]:
                lines.append(t(lang, "deploys.run", sha=code(safe_id(r.get("sha"), 7)),
                               word=status_word(lang, _run_word(r)), when=ago(lang, parse_ts(r.get("at")), now)))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "health")], [open_button(lang, "deploys", github_actions_link(cfg))], again="deploys"))


def view_approvals(ops: OperatorSources, held: Optional[list] = None, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [t(lang, "approvals.title")]
    pa = ops.publish_approvals()
    if not pa.ok:
        lines.append(t(lang, "approvals.pa_unknown", why=unknown(lang, pa)))
    elif not pa.data:
        lines.append(t(lang, "approvals.pa_none"))
    else:
        lines.append(t(lang, "approvals.pa", n=len(pa.data)))
        for r in pa.data[:8]:
            lines.append(t(lang, "approvals.pa_line", channel=safe_id(r.get("channel_id")),
                           waiting=age_label(parse_ts(r.get("requested_at")), now)))
    runs = ops.runs_awaiting_approval()
    if not runs.ok:
        lines.append(t(lang, "approvals.runs_unknown", why=unknown(lang, runs)))
    elif not runs.data:
        lines.append(t(lang, "approvals.runs_none"))
    else:
        lines.append(t(lang, "approvals.runs", n=len(runs.data)))
        for r in runs.data[:8]:
            lines.append(t(lang, "approvals.run_line", id=code(safe_id(r.get("run_id"), 40)),
                           age=age_label(parse_ts(r.get("updated_at")), now)))
    if held is not None:
        lines.append(t(lang, "approvals.held", n=len(held)))
    lines.append(t(lang, "approvals.footer"))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "pending")], [open_button(lang, "approvals", app_link(cfg, "approvals"))], again="approvals"))


def view_security(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    now, cfg = ops.now(), ops.cfg
    lines = [t(lang, "security.title")]
    sec = ops.audit(now - timedelta(hours=24))
    if not sec.ok:
        lines.append(t(lang, "security.unknown", why=unknown(lang, sec)))
    elif not sec.data:
        lines.append(t(lang, "security.none"))
    else:
        for r in sec.data[:12]:
            tgt = f" → {safe_id(r.get('target'), 40)}" if r.get("target") else ""
            lines.append(t(lang, "security.line", action=code(safe_id(r.get("action"), 40)), target=tgt,
                           when=ago(lang, parse_ts(r.get("at")), now)))
        if len(sec.data) > 12:
            lines.append(t(lang, "security.more", n=len(sec.data) - 12))
        if sec.cap:
            lines.append(cut(lang, sec).strip())
    lines.append(t(lang, "security.footer"))
    return Reply("\n".join(lines), _with_menu(
        lang, [], [open_button(lang, "audit", app_link(cfg, "audit"))], again="security"))


# -- /marketing (information only) -------------------------------------------

def marketing_kind_word(lang: str, kind) -> str:
    """news | showcase | price in the owner's language; a kind this code does not
    know yet is "other" (it is still a post, never hidden); no kind is "unknown"."""
    if kind in analysis.MARKETING_KINDS or kind == analysis.MARKETING_OTHER_KIND:
        return t(lang, f"mk.{kind}")
    return t(lang, "unknown_word")


def marketing_fix(lang: str, code) -> Raw:
    """The named fix for a closed error code (the same sentences the app's page
    gives); a code outside the closed list gets no invented advice."""
    return Raw(t(lang, f"mkfix.{code}") if code in analysis.MARKETING_ERROR_CODES else t(lang, "mkfix.unknown"))


def marketing_time(at: Optional[datetime]) -> str:
    """A neutral UTC stamp (``2026-10-18 15:30 UTC``), or ``?`` when unknown."""
    return at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if at else "?"


def view_marketing(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    """The brand-channel poster, counts only: posts by status, this week against
    the cap, the switch, the last send. Nothing a post says is shown, and nothing
    here approves, edits or sends: that is the app's page, behind the second
    factor. A database without migration 0109 says "not available yet"."""
    now, cfg = ops.now(), ops.cfg
    lines = [t(lang, "marketing.title")]
    sec = ops.marketing_summary()
    if not sec.ok:
        lines.append(t(lang, "marketing.not_available") if sec.note == "not set up yet"
                     else t(lang, "marketing.unknown", why=unknown(lang, sec)))
    else:
        st = analysis.marketing_state(sec.data)
        lines.append(t(lang, "marketing.switch_unknown" if st["enabled"] is None
                       else "marketing.switch_on" if st["enabled"] else "marketing.switch_off"))
        lines.append(t(lang, "marketing.week",
                       used=num(lang, st["used"]) if st["used"] is not None else t(lang, "unknown_word"),
                       cap=num(lang, st["cap"]) if st["cap"] is not None else t(lang, "unknown_word")))
        lines.append(t(lang, "marketing.counts", **{
            k: num(lang, v) if v is not None else t(lang, "unknown_word") for k, v in st["counts"].items()}))
        last = analysis.marketing_last_result(st)
        if last is None:
            lines.append(t(lang, "marketing.last_none"))
        elif last["status"] == "sent":
            lines.append(t(lang, "marketing.last_sent", kind=marketing_kind_word(lang, last["kind"]),
                           when=ago(lang, last["at"], now)))
        else:
            lines.append(t(lang, "marketing.last_failed", status=t(lang, f"mkst.{last['status']}"),
                           code=code(last["code"] or "?"), when=ago(lang, last["at"], now),
                           fix=marketing_fix(lang, last["code"])))
    lines.append(t(lang, "marketing.footer"))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "approvals")], [open_button(lang, "marketing", app_link(cfg, "marketing"))],
        again="marketing"))


# -- /payments, /status, /pending ------------------------------------------

#: Currencies whose smallest unit is the whole unit (amount_minor is not cents).
ZERO_DECIMAL = ("JPY", "KRW", "VND", "CLP", "UGX", "PYG")


def money(lang: str, amount_minor, currency) -> str:
    """``12.50 USD`` from the provider's lowest-denomination amount, or the
    unknown word when either part is missing."""
    cur = safe_id(currency, 3).upper()
    try:
        minor = int(amount_minor)
    except (TypeError, ValueError, OverflowError):
        return t(lang, "unknown_word")
    if not cur or minor < 0:
        return t(lang, "unknown_word")
    if cur in ZERO_DECIMAL:
        return f"{minor:,} {cur}"
    return f"{minor // 100:,}.{minor % 100:02d} {cur}"


def payment_kind_word(lang: str, event_type) -> str:
    return t(lang, f"pk.{analysis.payment_kind(event_type)}")


def _short_ids(lang: str, rows: list, limit: int = 8) -> str:
    ids = [short_id(r.get("event_id")) or "?" for r in rows[:limit]]
    more = len(rows) - len(ids)
    return ", ".join(ids) + (t(lang, "errors.more", n=more) if more > 0 else "")


def view_payments(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    """Payment events from the provider's webhook: counts by outcome and the
    latest few. Ids are shortened; amount, currency, kind, status and time are
    all that is shown (no `detail`, no customer, no organization)."""
    now = ops.now()
    lines = [t(lang, "payments.title")]
    sec = ops.payment_events(now - timedelta(days=7))
    if not sec.ok:
        lines.append(t(lang, "payments.unknown", why=unknown(lang, sec)))
    else:
        week_start = now - timedelta(days=7)
        rows = sorted((r for r in sec.data or [] if (parse_ts(r.get("received_at")) or week_start) >= week_start),
                      key=lambda r: str(r.get("received_at") or ""), reverse=True)
        if not rows:
            lines.append(t(lang, "payments.none"))
        else:
            for label, delta in (("payments.p24", timedelta(hours=24)), ("payments.p7", timedelta(days=7))):
                c = analysis.classify_payments(rows, now - delta)
                lines.append(t(lang, "payments.counts", period=t(lang, label), paid=len(c["paid"]),
                               rejected=len(c["rejected"]), failed=len(c["failed"]),
                               refunds=len(c["refunds"]), cut=cut(lang, sec)))
            c = analysis.classify_payments(rows, week_start)
            for key, name in (("rejected", "attention"), ("failed", "failed"), ("refunds", "refunds")):
                if c[key]:
                    lines.append(t(lang, f"payments.{name}", n=len(c[key]), ids=_short_ids(lang, c[key])))
                elif key == "rejected":
                    lines.append(t(lang, "payments.attention_none"))
            latest = [r for r in rows if r.get("status") not in ("duplicate", "ignored")][:8]
            if latest:
                lines.append(t(lang, "payments.latest"))
            for r in latest:
                lines.append(t(lang, "payments.line", id=code(short_id(r.get("event_id")) or "?"),
                               kind=payment_kind_word(lang, r.get("event_type")),
                               status=status_word(lang, r.get("status")),
                               amount=money(lang, r.get("amount_minor"), r.get("currency")),
                               when=ago(lang, parse_ts(r.get("received_at")), now)))
        lines.append(t(lang, "payments.footer"))
    return Reply("\n".join(lines), _with_menu(lang, [_nav(lang, "spend", "errors")], again="payments"))


def view_status(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    """The library at a glance, from Supabase: held, blocked, published, and
    what waits for a person. Counts only."""
    now, cfg = ops.now(), ops.cfg
    lines = [t(lang, "status.title")]
    held = ops.held_videos()
    if not held.ok:
        lines.append(t(lang, "status.videos_unknown", why=unknown(lang, held)))
    else:
        lines.append(t(lang, "status.held", n=len(analysis.review_queue(held.data)), cut=cut(lang, held)))
        lines.append(t(lang, "status.blocked", n=len(held.data) - len(analysis.review_queue(held.data))))
    pub = ops.videos_published(now - timedelta(days=7))
    if not pub.ok:
        lines.append(t(lang, "status.published_unknown", why=unknown(lang, pub)))
    else:
        stamps = [parse_ts(r.get("published_at")) for r in pub.data or []]
        lines.append(t(lang, "status.published", day=sum(1 for s in stamps if s and s >= now - timedelta(hours=24)),
                       week=sum(1 for s in stamps if s and s >= now - timedelta(days=7)), cut=cut(lang, pub)))
    pa, runs = ops.publish_approvals(), ops.runs_awaiting_approval()
    waiting = (len(pa.data) if pa.ok else 0) + (len(runs.data) if runs.ok else 0)
    lines.append(t(lang, "digest.waiting", n=waiting,
                   partial=Raw(t(lang, "digest.partial")) if not (pa.ok and runs.ok) else ""))
    lines.append(t(lang, "status.footer"))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "pending", "approvals")], [open_button(lang, "dashboard", app_link(cfg, "home"))],
        again="status"))


def view_pending(ops: OperatorSources, lang: str = DEFAULT_LANGUAGE) -> Reply:
    """Runs that did not upload, newest first: short id, channel, state, age.
    No title or topic (that is the video's content)."""
    now, cfg = ops.now(), ops.cfg
    lines = [t(lang, "pending.v_title")]
    sec = ops.held_videos()
    if not sec.ok:
        lines.append(t(lang, "pending.v_unknown", why=unknown(lang, sec)))
    else:
        queue = analysis.review_queue(sec.data)
        if not queue:
            lines.append(t(lang, "pending.v_none"))
        else:
            counts = analysis.count_by(queue, "publish_state")
            lines.append(t(lang, "pending.v_count", n=len(queue), held=counts.get("held", 0),
                           awaiting=counts.get("awaiting_approval", 0),
                           repaired=counts.get("repaired_awaiting_review", 0), cut=cut(lang, sec)))
            for r in queue[:10]:
                lines.append(t(lang, "pending.v_line", id=code(safe_id(r.get("video_id"), 12) or "?"),
                               channel=safe_id(r.get("channel_id")), state=status_word(lang, r.get("publish_state")),
                               age=age_label(parse_ts(r.get("held_at")), now)))
            if len(queue) > 10:
                lines.append(t(lang, "pending.v_more", n=len(queue) - 10))
        blocked = len(sec.data) - len(queue)
        if blocked:
            lines.append(t(lang, "pending.v_blocked", n=blocked))
    lines.append(t(lang, "pending.v_footer"))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "approvals")], [open_button(lang, "approvals", app_link(cfg, "approvals"))], again="pending"))


# -- /digest ---------------------------------------------------------------

def view_digest(ops: OperatorSources, held: Optional[list] = None, lang: str = DEFAULT_LANGUAGE) -> Reply:
    """The daily summary: one line per area, each the headline of its command."""
    now, cfg = ops.now(), ops.cfg
    day = now.astimezone(cfg.tz).replace(hour=0, minute=0, second=0, microsecond=0)
    since24 = now - timedelta(hours=24)
    lines = [t(lang, "digest.title", date=cfg.local_date(now))]

    site = ops.site()
    if site.ok:
        bad = [r for r in site.data if r["status"] is None or not (200 <= r["status"] < 400)]
        lines.append(t(lang, "digest.site_down", pages=", ".join(r["path"] for r in bad)) if bad
                     else t(lang, "digest.site_ok"))
    else:
        lines.append(t(lang, "digest.site_unknown", why=unknown(lang, site)))

    workers = ops.workers()
    if workers.ok:
        ws = analysis.classify_workers(workers.data, now)
        stale = [w for w in ws if w["stale"] or w.get("state") == "failed"]
        lines.append(t(lang, "digest.workers_attention", n=len(ws), bad=len(stale)) if stale
                     else t(lang, "digest.workers_fine", n=len(ws)))
    else:
        lines.append(t(lang, "digest.workers_unknown", why=unknown(lang, workers)))

    rj, cj = ops.render_jobs(since24), ops.creative_jobs(since24)

    def fin(rs):
        return [r for r in rs if (parse_ts(r.get("finished_at")) or since24) >= since24]

    if rj.ok:
        c = analysis.classify_render_jobs(rj.data, now, cfg)
        lines.append(t(lang, "digest.render", ok=len(fin(c["succeeded"])), failed=len(fin(c["failed"])),
                       stuck=len(c["stuck"]), cut=cut(lang, rj)))
    else:
        lines.append(t(lang, "queue.render_unknown", why=unknown(lang, rj)))
    if cj.ok:
        c = analysis.classify_creative_jobs(cj.data, now, cfg)
        lines.append(t(lang, "digest.creative", ok=len(fin(c["completed"])), failed=len(fin(c["failed"])),
                       cut=cut(lang, cj)))
    else:
        lines.append(t(lang, "queue.creative_unknown", why=unknown(lang, cj)))

    ev = ops.events(day, ("render.completed", "video.published", "publish.held"))
    if ev.ok:
        c = analysis.event_counts(ev.data)
        lines.append(t(lang, "digest.videos", made=c.get("render.completed", 0),
                       published=c.get("video.published", 0), held=c.get("publish.held", 0)))
    su = ops.signups(since24)
    lines.append(t(lang, "digest.accounts", n=len(su.data)) if su.ok
                 else t(lang, "today.accounts_unknown", why=unknown(lang, su)))

    bal = ops.balances()
    if bal.ok:
        flagged = [r for r in analysis.balance_flags(bal.data, _low_threshold()) if r["low"]]
        lines.append(t(lang, "digest.balances_low", who=", ".join(safe_id(r["provider"]) for r in flagged)) if flagged
                     else t(lang, "digest.balances_ok"))
    else:
        lines.append(t(lang, "digest.balances_unknown", why=unknown(lang, bal)))

    costs = ops.creative_costs(since24)
    lines.append(_cost_line(lang, t(lang, "digest.cost"), costs, since24))

    pa, runs = ops.publish_approvals(), ops.runs_awaiting_approval()
    waiting = (len(pa.data) if pa.ok else 0) + (len(runs.data) if runs.ok else 0)
    lines.append(t(lang, "digest.waiting", n=waiting,
                   partial=Raw(t(lang, "digest.partial")) if not (pa.ok and runs.ok) else ""))
    if held is not None:
        lines.append(t(lang, "digest.held", n=len(held)))

    dep = ops.deploys()
    if dep.ok:
        lines.extend(_deploy_summary_lines(lang, dep.data, now))
    return Reply("\n".join(lines), _with_menu(
        lang, [_nav(lang, "health", "errors")],
        [open_button(lang, "dashboard", app_link(cfg, "home"))], again="digest"))


# -- /alerts ---------------------------------------------------------------

def view_alerts(cfg: OperatorConfig, state, now: datetime, lang: str = DEFAULT_LANGUAGE) -> Reply:
    """Alert settings and mutes. ``state`` is an AlertState, or None when the
    alert memory could not be read."""
    lines = [t(lang, "alerts.title")]
    q = cfg.quiet_hours
    lines.append(t(lang, "alerts.quiet", start=f"{q[0]:02d}", end=f"{q[1]:02d}", tz=str(cfg.tz)) if q
                 else t(lang, "alerts.quiet_off"))
    lines.append(t(lang, "alerts.digest", hour=f"{cfg.digest_hour:02d}", tz=str(cfg.tz))
                 if cfg.digest_hour is not None else t(lang, "alerts.digest_off"))
    lines.append(t(lang, "alerts.limit", n=cfg.max_alerts_per_hour))
    if state is None:
        lines.append(t(lang, "alerts.memory_unavailable"))
    else:
        if state.mutes:
            for kind, until in sorted(state.mutes.items()):
                try:
                    local = until.astimezone(cfg.tz).strftime("%H:%M")
                except (OverflowError, ValueError):
                    local = "?"
                lines.append(t(lang, "alerts.muted", kind=kind_label(lang, kind), until=local, tz=str(cfg.tz)))
        else:
            lines.append(t(lang, "alerts.muted_none"))
        recent = [a for a in sorted(state.alerts, key=lambda a: a[0], reverse=True) if a[3]][:5]
        if recent:
            lines.append(t(lang, "alerts.last_sent"))
            lines += [t(lang, "alerts.last_line", key=code(safe_id(a[1], 40)), when=ago(lang, a[0], now))
                      for a in recent]
    rows = [[cb(t(lang, "btn.mute_kind", kind=kind_label(lang, k)), f"a:mute:{k}") for k in ALERT_KINDS[i:i + 2]]
            for i in range(0, len(ALERT_KINDS), 2)]
    rows.append([cb(t(lang, "btn.mute_all"), "a:mute:all"), cb(t(lang, "btn.unmute_all"), "a:unmute:all")])
    return Reply("\n".join(lines), _with_menu(lang, rows, again="alerts"))


def kind_label(lang: str, kind: str) -> str:
    """What an alert kind (or ``all``) is called in the owner's language."""
    key = f"kind.{safe_id(kind, 16)}"
    return t(lang, key) if has(lang, key) else safe_id(kind, 16)
