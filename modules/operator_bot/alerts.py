"""Proactive alerts: what is worth interrupting the owner for, and how not to
overdo it.

Payment problems (a rejected, failed or refunded provider event) are one more
kind, ``payment``: one alert per event and outcome, ids shortened, no free text.

The brand-channel poster is another, ``marketing``, and INFORMATION ONLY: a
count of drafts waiting for the owner, a post that ended ``dead`` or ``failed``
(with the named fix), a post that was sent (its kind and time). Never a post's
words, link, media or chat id; deciding stays in the app behind the second
factor, and there is no button here that could (modules/operator_bot/router.py).

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
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Callable, Optional

from modules.operator_bot import analysis
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.i18n import DEFAULT_LANGUAGE, t
from modules.operator_bot.sources import BOT_WORKER_ID, OperatorSources, age_label, parse_ts
from modules.operator_bot.store import AlertState, AlertStore, MUTE_FOR
from modules.operator_bot import views
from modules.tg_text import safe_id, short_id

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
#: How far back a payment problem is still news. Inside the 48 hours the store
#: remembers, so an alert already sent is never sent a second time.
PAYMENT_WINDOW = timedelta(hours=24)
#: A silent worker whose last word is older than this is gone, not lost
#: (e.g. an old container id); the table keeps such rows for two weeks.
WORKER_LOST_MAX_AGE = timedelta(hours=24)
#: A send result (sent, failed, dead) is news for this long; inside the 48 hours
#: the store remembers, so it is announced once.
MARKETING_WINDOW = timedelta(hours=24)
#: Dedupe-key prefix of the drafts-waiting alert and of its silent markers
#: (``marketing:drafts:<count>[:<epoch>]``); see ``AlertEngine._gate_marketing_drafts``.
MARKETING_DRAFTS = "marketing:drafts:"

#: Critical alerts are not subject to quiet hours, mutes of "all" or the normal
#: hourly budget, but they are not unlimited: a flood of forged or merely noisy
#: events must not become a flood of pings. Generous and finite; the rest wait.
MAX_CRITICAL_PER_HOUR = 20
#: Rows the store refused that are remembered in memory (see AlertEngine), and for how long.
MAX_UNRECORDED = 500
LOOKBACK_UNRECORDED = timedelta(hours=48)

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

def detect(ops: OperatorSources, low_credits: Optional[float] = None, lang: str = DEFAULT_LANGUAGE) -> list[Alert]:
    """Every alert that applies right now, worded in ``lang``. A source that
    cannot answer yields nothing: an unreadable table is not an incident, and
    `/health` says so. The dedupe keys never depend on the language."""
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
                             t(lang, "alert.render_failed", id=safe_id(r.get("id"), 20), channel=ch,
                               attempt=r.get("attempts"), max=r.get("max_attempts")),
                             ch or None))
        for r in c["stuck"]:
            ch = safe_id(r.get("channel_id"))
            out.append(Alert("stuck", f"stuck:{safe_id(r.get('id'), 20)}", "warn",
                             t(lang, "alert.render_stuck", id=safe_id(r.get("id"), 20),
                               status=views.status_word(lang, r.get("status")),
                               age=age_label(parse_ts(r.get("created_at")), now), channel=ch),
                             ch or None, STUCK_COOLDOWN))

    cj = ops.creative_jobs(now - timedelta(hours=1))
    if cj.ok:
        c = analysis.classify_creative_jobs(cj.data, now, cfg)
        recent = [r for r in c["failed"] if (parse_ts(r.get("finished_at")) or now) >= now - timedelta(hours=1)]
        for code, n in analysis.count_by(recent, "error_code").items():
            if n >= CREATIVE_BURST:
                out.append(Alert("run", f"creative:{safe_id(code, 40)}", "warn",
                                 t(lang, "alert.creative_burst", n=n, code=safe_id(code, 40)),
                                 None, CREATIVE_COOLDOWN))
        for r in c["stuck"]:
            out.append(Alert("stuck", f"stuck:job:{safe_id(r.get('id'), 40)}", "warn",
                             t(lang, "alert.creative_stuck", id=safe_id(r.get("id"), 8),
                               status=views.status_word(lang, r.get("status")),
                               age=age_label(parse_ts(r.get("created_at")), now)),
                             None, STUCK_COOLDOWN))

    bal = ops.balances()
    if bal.ok:
        for r in analysis.balance_flags(bal.data, low_credits):
            if r["low"]:
                out.append(Alert("balance", f"balance:{safe_id(r.get('provider'), 24)}", "warn",
                                 t(lang, "alert.balance_low", provider=safe_id(r.get("provider"), 24),
                                   metric=safe_id(r.get("metric"), 24), left=views.num(lang, r["remaining_n"]),
                                   threshold=views.num(lang, low_credits)),
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
                                 t(lang, "alert.deploy_failed" if label == "deploy" else "alert.ci_failed",
                                   workflow=label, sha=safe_id(run.get("sha"), 7))))

    ws = ops.workers()
    if ws.ok:
        rows = analysis.classify_workers(ws.data, now)
        # The bot's own row is kind "other", shared with the e-mail worker: it
        # must not hide that worker's silence, nor be hidden by it.
        fresh_kinds = {w.get("kind") for w in rows if w.get("state") in ("running", "starting")
                       and not w["stale"] and w.get("worker_id") != BOT_WORKER_ID}
        for w in rows:
            wid = safe_id(w.get("worker_id"), 60)
            age = w["age_s"]
            if w["stale"] and (w.get("kind") not in fresh_kinds or w.get("worker_id") == BOT_WORKER_ID) \
                    and age is not None and timedelta(seconds=age) <= WORKER_LOST_MAX_AGE:
                out.append(Alert("worker", f"worker:{wid}", "critical",
                                 t(lang, "alert.worker_lost", id=wid, kind=w.get("kind"),
                                   age=age_label(now - timedelta(seconds=age), now)),
                                 None, WORKER_COOLDOWN))
            elif w.get("state") == "failed" and age is not None and age <= 3600:
                out.append(Alert("worker", f"worker:{wid}:failed", "critical",
                                 t(lang, "alert.worker_failed", id=wid, kind=w.get("kind")),
                                 None, WORKER_COOLDOWN))

    pa = ops.publish_approvals()
    if pa.ok:
        for r in pa.data:
            ch = safe_id(r.get("channel_id"))
            out.append(Alert("approval", f"approval:{safe_id(r.get('id'), 40)}", "info",
                             t(lang, "alert.approval", channel=ch), ch or None))

    pay = ops.payment_events(now - PAYMENT_WINDOW)
    if pay.ok:
        out += _payment_alerts(pay.data, now, lang)

    mk = ops.marketing_summary()
    if mk.ok:
        out += _marketing_alerts(mk.data, now, lang)

    au = ops.audit(since)
    if au.ok:
        for r in au.data:
            tgt = f" → {safe_id(r.get('target'), 40)}" if r.get("target") else ""
            out.append(Alert("audit", f"audit:{safe_id(r.get('id'), 40)}", "critical",
                             t(lang, "alert.security", action=safe_id(r.get("action"), 40), target=tgt),
                             safe_id(r.get("channel_id")) or None))
    return out


def _payment_alerts(rows, now: datetime, lang: str) -> list[Alert]:
    """Payment problems as alerts. A bug here must not silence the other kinds."""
    out: list[Alert] = []
    try:
        c = analysis.classify_payments(rows, now - PAYMENT_WINDOW)
        # Rejected = paid but not credited (or a refund not applied): a person
        # must act. Failed = the provider retries. A refund or chargeback that
        # was applied is news, not an emergency. One alert per event and
        # outcome; the key holds only the tail of the provider's id.
        for outcome, severity, copy in (("rejected", "critical", "alert.payment_rejected"),
                                        ("failed", "warn", "alert.payment_failed"),
                                        ("refunds", "warn", "alert.payment_refund")):
            for r in c[outcome]:
                tail = safe_id(r.get("event_id"), 200)[-8:]
                if not tail:
                    continue
                out.append(Alert("payment", f"payment:{tail}:{outcome}", severity,
                                 t(lang, copy, id=short_id(r.get("event_id")),
                                   kind=views.payment_kind_word(lang, r.get("event_type")),
                                   amount=views.money(lang, r.get("amount_minor"), r.get("currency")))))
    except Exception as e:  # noqa: BLE001 - a malformed row must not end the pass
        logger.warning("payment alerts skipped (%s)", type(e).__name__)
        return []
    return out


def _marketing_alerts(summary, now: datetime, lang: str) -> list[Alert]:
    """The poster's three kinds of news, from counts and closed codes only. A
    bug here must not silence the other kinds."""
    out: list[Alert] = []
    try:
        st = analysis.marketing_state(summary)
        drafts = st["counts"]["draft"]
        if drafts:
            out.append(Alert("marketing", f"marketing:drafts:{drafts}", "info",
                             t(lang, "alert.marketing_draft_one" if drafts == 1 else "alert.marketing_drafts", n=drafts)))
        fail = st["failure"]
        if fail and fail["at"] is not None and now - MARKETING_WINDOW <= fail["at"] <= now + timedelta(minutes=5):
            stamp = int(fail["at"].timestamp())
            kind = views.marketing_kind_word(lang, fail["kind"])
            if fail["status"] == "dead":
                # CRITICAL: a post that may be live on the channel and could be sent again by mistake must not wait
                # for quiet hours or the hourly budget (the hourly cap of critical alerts still applies).
                out.append(Alert("marketing", f"marketing:dead:{stamp}", "critical",
                                 t(lang, "alert.marketing_dead", kind=kind, when=views.marketing_time(fail["at"]))))
            else:
                out.append(Alert("marketing", f"marketing:failed:{stamp}", "warn",
                                 t(lang, "alert.marketing_failed", kind=kind, code=views.code(fail["code"] or "?"),
                                   fix=views.marketing_fix(lang, fail["code"]), when=views.marketing_time(fail["at"]))))
        if st["sent_at"] is not None and now - MARKETING_WINDOW <= st["sent_at"] <= now + timedelta(minutes=5):
            out.append(Alert("marketing", f"marketing:sent:{int(st['sent_at'].timestamp())}", "info",
                             t(lang, "alert.marketing_sent", kind=views.marketing_kind_word(lang, st["sent_kind"]),
                               when=views.marketing_time(st["sent_at"]))))
    except Exception as e:  # noqa: BLE001 - a malformed answer must not end the pass
        logger.warning("marketing alerts skipped (%s)", type(e).__name__)
        return []
    return out


def last_draft_count(state: AlertState) -> int:
    """The drafts-waiting count last seen (announced, muted or silently noted), 0 when none or after a zero."""
    best, count = None, 0
    for at, key, _kind, _delivered, _sev in state.alerts:
        if key.startswith(MARKETING_DRAFTS):
            try:
                n = int(key[len(MARKETING_DRAFTS):].split(":")[0])
            except ValueError:
                continue
            if best is None or at >= best:
                best, count = at, n
    return count


# -- composition -----------------------------------------------------------

def compose(kind: str, alerts: list[Alert], cfg: OperatorConfig, held_back: int = 0,
            lang: str = DEFAULT_LANGUAGE) -> views.Reply:
    """One message for the alerts of one kind: a severity-led header, one line
    each, and buttons — Open (deep link), Mute 24h, Details."""
    top = min(alerts, key=lambda a: SEVERITY_ORDER.get(a.severity, 9)).severity
    lines = [t(lang, "alert.header", sev=t(lang, f"sev.{top}"), label=views.kind_label(lang, kind))]
    lines += [f"• {a.line}" for a in alerts[:10]]
    if len(alerts) > 10:
        lines.append(t(lang, "alert.more", n=len(alerts) - 10))
    if held_back:
        lines.append(t(lang, "alert.held_back", n=held_back))
    channels = {a.channel_id for a in alerts if a.channel_id}
    channel = channels.pop() if len(channels) == 1 else None
    page = views.KIND_PAGE.get(kind)
    open_btn = (views.url_button(t(lang, "btn.open"), views.app_link(cfg, page, channel)) if page
                else views.url_button(t(lang, "btn.open"), views.github_actions_link(cfg))
                if kind in views.GITHUB_KINDS else None)
    row = [x for x in (open_btn,) if x] + [
        views.cb(t(lang, "btn.mute24"), f"a:mute:{kind}"),
        views.cb(t(lang, "btn.details"), f"d:{kind}"),
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
    #: The owner e-mail sink's pass (modules/operator_bot/owner_mail.py), None while it is off.
    mail: Optional[object] = None


class AlertEngine:
    def __init__(self, ops: OperatorSources, store: AlertStore, control, cfg: OperatorConfig,
                 low_credits: Optional[float] = None, held_fn: Optional[Callable[[], list]] = None,
                 owner_mail=None):
        self.ops, self.store, self.control, self.cfg = ops, store, control, cfg
        self.low_credits = low_credits
        self.held_fn = held_fn
        #: The e-mail sink beside Telegram (owner_mail.OwnerMail), or None: off. It sees the same
        #: detected events and the same alert state, and has a ledger of its own.
        self.owner_mail = owner_mail
        # What this process sent or marked whose row the store did not take (a
        # failed write). The store is the memory of record, but a write that
        # fails must not make the next pass send the same alert again and again,
        # nor lift the hourly cap: these are merged into the state read from the
        # store until the store has the row. Bounded, and only ever in memory.
        self._unrecorded: list = []
        self._digest_unrecorded: set = set()
        self._baseline_unrecorded = False

    def tick(self) -> TickReport:
        rep = TickReport()
        if not getattr(self.control, "enabled", False):
            rep.state = "not_configured"
            return rep
        now = self.ops.now()
        state = self.store.load(now, mail=True) if self.owner_mail is not None else self.store.load(now)
        if state is None:
            rep.state = "no_state"
            return rep

        self._merge_unrecorded(state, now)
        self.ops.reset()
        lang = self._language()
        found = detect(self.ops, self.low_credits, lang)
        if self.owner_mail is not None:
            # One info note per day while the owner's e-mail is failing, through the same restraint as any alert.
            found = found + self.owner_mail.outage_alerts(state, now, lang)
        rep.detected = len(found)

        try:
            return self._telegram(found, state, rep, lang, now)
        finally:
            # The e-mail copy runs after Telegram (a slow mail provider must not delay a ping) and on its own
            # ledger: it neither waits for Telegram's baseline nor changes what Telegram records. It never raises.
            if self.owner_mail is not None:
                rep.mail = self.owner_mail.run(found, state, now, lang)

    def _telegram(self, found: list, state: AlertState, rep: TickReport, lang: str, now: datetime) -> TickReport:
        if not state.armed:
            return self._baseline(found, rep, lang, now)
        found = self._gate_marketing_drafts(found, state, now)

        quiet = self.cfg.in_quiet_hours(now)
        fresh = []
        for a in found:
            if self._deduped(a, state, now):
                rep.deduped += 1
            elif state.is_muted(a.kind, a.severity):
                rep.muted += 1
                self._record(a, False, now)
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
            reply = compose(kind, items, self.cfg, held_back=held if i == 0 else 0, lang=lang)
            if self.control.send(self.control.chat_id, reply.text, parse_mode=reply.parse_mode,
                                 reply_markup=reply.markup()):
                rep.sent += len(items)
                for a in items:
                    self._record(a, True, now)
            else:
                rep.send_failed += len(items)

        self._maybe_digest(state, now, quiet, rep, lang)
        return rep

    def _gate_marketing_drafts(self, found: list, state: AlertState, now: datetime) -> list:
        """Announce drafts waiting only when their count RISES above the last count seen.

        A key per count with a cooldown would swallow a NEW draft after 1 -> 0 -> 1 within a day, and would announce
        "1 post is waiting" because the owner approved one of two (their own action). So the memory is the count: every
        change is recorded (silently when it does not rise), 0 clears it, and a rise is announced under a fresh key.
        Nothing is repeated while the count stays the same; /marketing and /approvals show what waits."""
        mk = self.ops.marketing_summary()
        if not mk.ok:
            return found
        n = analysis.marketing_state(mk.data)["counts"]["draft"]
        if n is None:
            return found
        last = last_draft_count(state)
        rest = [a for a in found if not a.key.startswith(MARKETING_DRAFTS)]
        if n == last:
            return rest
        stamped = f"{MARKETING_DRAFTS}{n}:{int(now.timestamp())}"
        if n > last:
            mine = [a for a in found if a.key == f"{MARKETING_DRAFTS}{n}"]
            return rest + [replace(a, key=stamped) for a in mine]
        self._record(Alert("marketing", stamped, "info", ""), False, now)      # fell: remember it, say nothing
        return rest

    def _language(self) -> str:
        """The owner's chosen language, else the configured default."""
        try:
            return self.store.load_language() or self.cfg.language
        except Exception:
            return self.cfg.language

    def _deduped(self, a: Alert, state: AlertState, now: datetime) -> bool:
        seen = state.last_seen(a.key)
        if seen is None:
            return False
        return a.cooldown_min <= 0 or now - seen < timedelta(minutes=a.cooldown_min)

    def _record(self, a: Alert, delivered: bool, now: datetime) -> None:
        """Write the alert's row; when the store refuses, remember it here."""
        if self.store.record_alert(a.key, a.kind, delivered, a.severity, a.channel_id) is False:
            self._unrecorded.append((now, a.key, a.kind, delivered, a.severity))
            del self._unrecorded[:-MAX_UNRECORDED]

    def _merge_unrecorded(self, state: AlertState, now: datetime) -> None:
        keep = []
        for at, key, kind, delivered, sev in self._unrecorded:
            if now - at > LOOKBACK_UNRECORDED:
                continue
            if any(a[1] == key and a[0] >= at - timedelta(minutes=1) for a in state.alerts):
                continue                  # the store has it now
            keep.append((at, key, kind, delivered, sev))
            state.alerts.append((at, key, kind, delivered, sev))
        self._unrecorded = keep
        if self._baseline_unrecorded:
            state.baseline_seen = True

    def _baseline(self, found: list[Alert], rep: TickReport, lang: str = DEFAULT_LANGUAGE,
                  now: Optional[datetime] = None) -> TickReport:
        """First run: announce once, then mark what exists as seen."""
        rep.baseline = True
        ok = self.control.send(
            self.control.chat_id,
            t(lang, "alert.armed", n=len(found)),
            parse_mode="HTML", reply_markup={"inline_keyboard": [[views.cb(t(lang, "btn.menu"), "c:menu")]]})
        # Nothing is recorded unless the announcement went out: the marker row
        # is what makes the next pass "armed", and a failed send must be retried
        # rather than silently skipped.
        if ok:
            now = now or self.ops.now()
            for a in found:
                self._record(a, False, now)
            if self.store.record_alert("baseline", "baseline", False) is False:
                self._baseline_unrecorded = True    # announced once; do not announce again
        else:
            rep.send_failed += 1
        return rep

    def _maybe_digest(self, state: AlertState, now: datetime, quiet: bool, rep: TickReport,
                      lang: str = DEFAULT_LANGUAGE) -> None:
        h = self.cfg.digest_hour
        if h is None or quiet:
            return
        local_hour, date = self.cfg.local_hour(now), self.cfg.local_date(now)
        # From the chosen hour on, once per local date, and never in quiet hours:
        # a digest hour inside the quiet window goes out when the window ends.
        if local_hour < h or date in state.digest_dates or date in self._digest_unrecorded:
            return
        reply = send_digest_reply(self.ops, self.held_fn, lang)
        if self.control.send(self.control.chat_id, reply.text, parse_mode=reply.parse_mode,
                             reply_markup=reply.markup()):
            if self.store.record_digest(date) is False:
                self._digest_unrecorded.add(date)
                if len(self._digest_unrecorded) > 7:
                    self._digest_unrecorded.discard(min(self._digest_unrecorded))
            rep.digest_sent = True


def send_digest_reply(ops: OperatorSources, held_fn: Optional[Callable[[], list]] = None,
                      lang: str = DEFAULT_LANGUAGE) -> views.Reply:
    ops.reset()
    held = None
    try:
        held = held_fn() if held_fn is not None else held_runs(ops)
    except Exception:
        held = None
    return views.view_digest(ops, held, lang)


def held_runs(ops: OperatorSources) -> Optional[list]:
    """Runs waiting for a person's decision, from Supabase; None when unknown."""
    sec = ops.held_videos()
    return analysis.review_queue(sec.data) if sec.ok else None


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
