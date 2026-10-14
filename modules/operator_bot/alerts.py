"""Proactive alerts: what is worth interrupting the owner for, and how not to
overdo it.

Detection is pure over the sources (:func:`detect`). Delivery is
:class:`AlertEngine`, which is where the restraint lives:

* **Dedupe.** Every alert has a stable key (``run:123``, ``worker:nightshift-01``).
  A key already seen is not sent again: for a one-off event (a failed job) for
  the 48 hours the store remembers, for a standing condition (a low balance, a
  silent worker) until its cooldown has passed.
* **Rate limit.** At most ``max_alerts_per_hour`` non-critical alerts an hour,
  and (separately, so neither starves the other) at most MAX_CRITICAL_PER_HOUR
  critical ones. Alerts of one kind in one pass are merged into one message, so
  a burst reads as one line list, not a stack of pings.
* **Quiet hours.** Only ``critical`` alerts (a worker gone silent, a security
  event) get through; the rest are held, NOT dropped: they are not recorded, so
  they go out after the window if they still apply.
* **Mute.** The Mute button silences one kind for 24 hours, or ``all`` for
  everything except critical alerts. Muted alerts are recorded as seen, so a
  mute never becomes a flood when it ends.
* **First run.** The first pass only records what already exists, and says so
  once, so turning the bot on does not announce the last day's history.
* **No memory, no message.** If the state cannot be read the engine sends
  nothing (modules/operator_bot/store.py).

An alert's text is built from ids, counts and fixed words only: a failed job is
"Render job #123 failed — <channel id>", never its log. Sending uses
``TelegramControl.send`` (scrubbed, split, never raising).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable, Optional

from modules.operator_bot import analysis
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.sources import OperatorSources, parse_ts
from modules.operator_bot.store import AlertState, AlertStore, MUTE_FOR
from modules.operator_bot import views
from modules.tg_text import html_escape, safe_id

logger = logging.getLogger(__name__)

#: How far back a one-off event (a failed job, a new approval) is still news.
#: Longer than the longest sensible quiet window, so a failure at 23:00 is
#: reported at 07:00.
EVENT_WINDOW = timedelta(hours=12)
#: Standing-condition cooldowns, minutes.
BALANCE_COOLDOWN = 12 * 60
WORKER_COOLDOWN = 3 * 60
STUCK_COOLDOWN = 6 * 60
CREATIVE_BURST = 3          # failures of one error code within the hour
CREATIVE_COOLDOWN = 3 * 60
#: A silent worker whose last word is older than this is gone, not lost
#: (e.g. an old container id); the table keeps such rows for two weeks.
WORKER_LOST_MAX_AGE = timedelta(hours=24)

#: Critical alerts are not subject to quiet hours, mutes of "all" or the normal
#: hourly budget, but they are not unlimited: a flood of forged or merely noisy
#: events must not become a flood of pings. Generous and finite; the rest wait.
MAX_CRITICAL_PER_HOUR = 20

SEVERITY_ORDER = {"critical": 0, "warn": 1, "info": 2}


@dataclass(frozen=True)
class Alert:
    kind: str                       # one of views.ALERT_KINDS
    key: str                        # stable dedupe key
    severity: str                   # info | warn | critical
    line: str                       # one HTML-safe line
    channel_id: Optional[str] = None
    cooldown_min: int = 0           # 0 = one-off: never repeat while remembered


# -- detection -------------------------------------------------------------

def detect(ops: OperatorSources, low_credits: Optional[float] = None) -> list[Alert]:
    """Every alert that applies right now. A source that cannot answer yields
    nothing: an unreadable table is not an incident, and `/health` says so."""
    now, cfg = ops.now(), ops.cfg
    if low_credits is None:
        from modules import provider_balance
        low_credits = provider_balance.low_credit_threshold()
    since = now - EVENT_WINDOW
    out: list[Alert] = []

    rj = ops.render_jobs(since)
    if rj.ok:
        c = analysis.classify_render_jobs(rj.data, now, cfg)
        for r in c["failed"]:
            if (parse_ts(r.get("finished_at")) or now) < since:
                continue
            ch = safe_id(r.get("channel_id"))
            out.append(Alert("run", f"run:{safe_id(r.get('id'), 20)}", "warn",
                             f"Render job #{html_escape(safe_id(r.get('id'), 20))} failed — {html_escape(ch)}"
                             f" (attempt {html_escape(r.get('attempts'))}/{html_escape(r.get('max_attempts'))})",
                             ch or None))
        for r in c["stuck"]:
            ch = safe_id(r.get("channel_id"))
            out.append(Alert("stuck", f"stuck:{safe_id(r.get('id'), 20)}", "warn",
                             f"Render job #{html_escape(safe_id(r.get('id'), 20))} is stuck "
                             f"({html_escape(r.get('status'))}, {html_escape(views.age_label(parse_ts(r.get('created_at')), now))}) — {html_escape(ch)}",
                             ch or None, STUCK_COOLDOWN))

    cj = ops.creative_jobs(now - timedelta(hours=1))
    if cj.ok:
        c = analysis.classify_creative_jobs(cj.data, now, cfg)
        recent = [r for r in c["failed"] if (parse_ts(r.get("finished_at")) or now) >= now - timedelta(hours=1)]
        for code, n in analysis.count_by(recent, "error_code").items():
            if n >= CREATIVE_BURST:
                out.append(Alert("run", f"creative:{safe_id(code, 40)}", "warn",
                                 f"{n} creative jobs failed in the last hour — {html_escape(safe_id(code, 40))}",
                                 None, CREATIVE_COOLDOWN))
        for r in c["stuck"]:
            out.append(Alert("stuck", f"stuck:job:{safe_id(r.get('id'), 40)}", "warn",
                             f"Creative job {html_escape(safe_id(r.get('id'), 8))} is stuck "
                             f"({html_escape(r.get('status'))}, {html_escape(views.age_label(parse_ts(r.get('created_at')), now))})",
                             None, STUCK_COOLDOWN))

    bal = ops.balances()
    if bal.ok:
        for r in analysis.balance_flags(bal.data, low_credits):
            if r["low"]:
                out.append(Alert("balance", f"balance:{safe_id(r.get('provider'), 24)}", "warn",
                                 f"{html_escape(safe_id(r.get('provider'), 24))} {html_escape(safe_id(r.get('metric'), 24))} low: "
                                 f"{views._n(r['remaining_n'])} left (threshold {views._n(low_credits)})",
                                 None, BALANCE_COOLDOWN))

    dep = ops.deploys()
    if dep.ok:
        for wf in dep.data:
            if not wf.get("ok"):
                continue
            run = analysis.latest_run(wf["runs"])
            if run and run.get("conclusion") in ("failure", "timed_out", "startup_failure"):
                label = wf["label"]
                out.append(Alert("deploy", f"{'deploy' if label == 'deploy' else 'ci:' + label}:{safe_id(run.get('id'), 20)}",
                                 "warn",
                                 f"{html_escape('Deploy' if label == 'deploy' else 'CI ' + label)} failed on main — "
                                 f"{html_escape(safe_id(run.get('sha'), 7))}"))

    ws = ops.workers()
    if ws.ok:
        rows = analysis.classify_workers(ws.data, now)
        fresh_kinds = {w.get("kind") for w in rows if w.get("state") in ("running", "starting") and not w["stale"]}
        for w in rows:
            wid = safe_id(w.get("worker_id"), 60)
            age = w["age_s"]
            if w["stale"] and w.get("kind") not in fresh_kinds and age is not None \
                    and timedelta(seconds=age) <= WORKER_LOST_MAX_AGE:
                out.append(Alert("worker", f"worker:{wid}", "critical",
                                 f"Worker {html_escape(wid)} ({html_escape(w.get('kind'))}) lost its heartbeat — "
                                 f"last report {html_escape(views.age_label(now - timedelta(seconds=age), now))} ago",
                                 None, WORKER_COOLDOWN))
            elif w.get("state") == "failed" and age is not None and age <= 3600:
                out.append(Alert("worker", f"worker:{wid}:failed", "critical",
                                 f"Worker {html_escape(wid)} ({html_escape(w.get('kind'))}) reported FAILED",
                                 None, WORKER_COOLDOWN))

    pa = ops.publish_approvals()
    if pa.ok:
        for r in pa.data:
            ch = safe_id(r.get("channel_id"))
            out.append(Alert("approval", f"approval:{safe_id(r.get('id'), 40)}", "info",
                             f"New publish approval waiting — {html_escape(ch)}", ch or None))

    au = ops.audit(since)
    if au.ok:
        for r in au.data:
            tgt = f" → {html_escape(safe_id(r.get('target'), 40))}" if r.get("target") else ""
            out.append(Alert("audit", f"audit:{safe_id(r.get('id'), 40)}", "critical",
                             f"Security event {html_escape(safe_id(r.get('action'), 40))}{tgt}",
                             safe_id(r.get("channel_id")) or None))
    return out


# -- composition -----------------------------------------------------------

def compose(kind: str, alerts: list[Alert], cfg: OperatorConfig, held_back: int = 0) -> views.Reply:
    """One message for the alerts of one kind: a severity-led header, one line
    each, and buttons — Open (deep link), Mute 24h, Details."""
    top = min(alerts, key=lambda a: SEVERITY_ORDER.get(a.severity, 9)).severity
    tag = {"critical": "CRITICAL", "warn": "WARN"}.get(top, "INFO")
    label = views.KIND_LABEL.get(kind, kind)
    lines = [f"<b>{tag} — {html_escape(label)}</b>"]
    lines += [f"• {a.line}" for a in alerts[:10]]
    if len(alerts) > 10:
        lines.append(f"+{len(alerts) - 10} more")
    if held_back:
        lines.append(f"{held_back} further alert(s) held back by the hourly limit.")
    channels = {a.channel_id for a in alerts if a.channel_id}
    channel = channels.pop() if len(channels) == 1 else None
    page = views.KIND_PAGE.get(kind)
    open_btn = (views.url_button("Open", views.app_link(cfg, page, channel)) if page
                else views.url_button("Open", views.github_actions_link(cfg)))
    row = [b for b in (open_btn,) if b] + [
        views.cb("Mute 24h", f"a:mute:{kind}"),
        views.cb("Details", f"d:{kind}"),
    ]
    return views.Reply("\n".join(lines), [row])


# -- delivery --------------------------------------------------------------

@dataclass
class TickReport:
    state: str = "ok"            # ok | no_state | not_configured
    baseline: bool = False
    detected: int = 0
    sent: int = 0
    muted: int = 0
    deduped: int = 0
    quiet_held: int = 0
    rate_held: int = 0
    digest_sent: bool = False
    send_failed: int = 0


class AlertEngine:
    def __init__(self, ops: OperatorSources, store: AlertStore, control, cfg: OperatorConfig,
                 low_credits: Optional[float] = None, held_fn: Optional[Callable[[], list]] = None):
        self.ops, self.store, self.control, self.cfg = ops, store, control, cfg
        self.low_credits = low_credits
        self.held_fn = held_fn

    def tick(self) -> TickReport:
        rep = TickReport()
        if not getattr(self.control, "enabled", False):
            rep.state = "not_configured"
            return rep
        now = self.ops.now()
        state = self.store.load(now)
        if state is None:
            rep.state = "no_state"
            return rep

        self.ops.reset()
        found = detect(self.ops, self.low_credits)
        rep.detected = len(found)

        if not state.armed:
            return self._baseline(found, rep)

        quiet = self.cfg.in_quiet_hours(now)
        fresh = []
        for a in found:
            if self._deduped(a, state, now):
                rep.deduped += 1
            elif state.is_muted(a.kind, a.severity):
                rep.muted += 1
                self.store.record_alert(a.key, a.kind, False, a.severity, a.channel_id)
            elif quiet and a.severity != "critical":
                rep.quiet_held += 1
            else:
                fresh.append(a)

        # Critical and other alerts have separate hourly budgets, so a flood of
        # one cannot starve the other (and neither is unlimited).
        hour_ago = now - timedelta(hours=1)
        budget = max(0, self.cfg.max_alerts_per_hour - state.delivered_since(hour_ago, critical=False))
        crit_budget = max(0, MAX_CRITICAL_PER_HOUR - state.delivered_since(hour_ago, critical=True))
        fresh.sort(key=lambda a: (SEVERITY_ORDER.get(a.severity, 9), a.key))
        chosen, held = [], 0
        for a in fresh:
            if a.severity == "critical":
                if crit_budget > 0:
                    chosen.append(a)
                    crit_budget -= 1
                else:
                    held += 1
            elif budget > 0:
                chosen.append(a)
                budget -= 1
            else:
                held += 1
        rep.rate_held = held

        by_kind: dict = {}
        for a in chosen:
            by_kind.setdefault(a.kind, []).append(a)
        for i, (kind, items) in enumerate(by_kind.items()):
            reply = compose(kind, items, self.cfg, held_back=held if i == 0 else 0)
            if self.control.send(self.control.chat_id, reply.text, parse_mode=reply.parse_mode,
                                 reply_markup=reply.markup()):
                rep.sent += len(items)
                for a in items:
                    self.store.record_alert(a.key, a.kind, True, a.severity, a.channel_id)
            else:
                rep.send_failed += len(items)

        self._maybe_digest(state, now, quiet, rep)
        return rep

    def _deduped(self, a: Alert, state: AlertState, now: datetime) -> bool:
        seen = state.last_seen(a.key)
        if seen is None:
            return False
        return a.cooldown_min <= 0 or now - seen < timedelta(minutes=a.cooldown_min)

    def _baseline(self, found: list[Alert], rep: TickReport) -> TickReport:
        """First run: announce once, then mark what exists as seen."""
        rep.baseline = True
        ok = self.control.send(
            self.control.chat_id,
            "<b>Operator alerts are on</b>\n"
            f"{len(found)} existing item(s) were marked as seen: you will hear about new ones only.\n"
            "Each alert has Open, Mute 24h and Details buttons.",
            parse_mode="HTML", reply_markup={"inline_keyboard": [[views.cb("Menu", "c:menu")]]})
        # Nothing is recorded unless the announcement went out: the marker row
        # is what makes the next pass "armed", and a failed send must be retried
        # rather than silently skipped.
        if ok:
            for a in found:
                self.store.record_alert(a.key, a.kind, False, a.severity, a.channel_id)
            self.store.record_alert("baseline", "baseline", False)
        else:
            rep.send_failed += 1
        return rep

    def _maybe_digest(self, state: AlertState, now: datetime, quiet: bool, rep: TickReport) -> None:
        h = self.cfg.digest_hour
        if h is None or quiet:
            return
        local_hour, date = self.cfg.local_hour(now), self.cfg.local_date(now)
        # From the chosen hour on, once per local date, and never in quiet hours:
        # a digest hour inside the quiet window goes out when the window ends.
        if local_hour < h or date in state.digest_dates:
            return
        reply = send_digest_reply(self.ops, self.held_fn)
        if self.control.send(self.control.chat_id, reply.text, parse_mode=reply.parse_mode,
                             reply_markup=reply.markup()):
            self.store.record_digest(date)
            rep.digest_sent = True


def send_digest_reply(ops: OperatorSources, held_fn: Optional[Callable[[], list]] = None) -> views.Reply:
    ops.reset()
    held = None
    if held_fn is not None:
        try:
            held = held_fn()
        except Exception:
            held = None
    return views.view_digest(ops, held)


# -- mute (the one safe write the bot does) --------------------------------

def mute(store: AlertStore, kind: str, now: datetime) -> Optional[datetime]:
    """Silence ``kind`` (or ``all``) for 24 hours. Returns when it ends, or None
    when the mute could not be recorded."""
    if kind != "all" and kind not in views.ALERT_KINDS:
        return None
    until = now + MUTE_FOR
    return until if store.record_mute(kind, until) else None


def unmute(store: AlertStore, kind: str) -> bool:
    if kind != "all" and kind not in views.ALERT_KINDS:
        return False
    return store.record_unmute(kind)
