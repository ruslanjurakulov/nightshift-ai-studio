"""Owner e-mail: the operator alerts and the daily digest, as a second sink.

WHAT IT IS. The alert engine (modules/operator_bot/alerts.py) already reads every
source with the service key, decides what is news and applies mute and quiet
hours. This module is the engine's second way out, beside Telegram: the same
detected events (plus two the bot does not announce: a payment received and a new
account) become a short e-mail to the platform owner and admins, and one digest a
day at OPERATOR_DIGEST_HOUR. docs/OWNER_EMAIL.md has the design and the reasons.

OFF unless the server variable NIGHTSHIFT_OWNER_EMAIL is exactly ``on`` AND the
sender is configured (RESEND_API_KEY, NIGHTSHIFT_EMAIL_FROM). Nothing is read,
sent or recorded otherwise.

WHO GETS IT. Only the addresses of people who are on the platform roster as owner
or admin AND whose e-mail Supabase Auth has confirmed, read here on the server
(:class:`OwnerDirectory`). Never an argument, an environment value typed in a
browser, a customer, or an unconfirmed invitation (``app_members.email`` is not
read at all: it is what somebody typed, not what was verified). No such person ->
nothing is sent and nothing is recorded.

THE RESTRAINT, on top of what the engine already does (same dedupe semantics,
same mute, same quiet hours with critical exempt, same hourly figure):
* its OWN ledger, ``operator.mail`` rows (store.py), so an e-mail that failed is
  not forgotten and one that was sent is not repeated, whatever Telegram did;
* a failed delivery backs the whole sink off (5 minutes, doubling, up to an hour) and ends the pass; per alert at
  most MAX_ATTEMPTS failed tries per window (its cooldown), after which it is tried again, not dropped; a refused
  key (401 / 403) marks no alert at all; every attempt counts against its hourly budget (problems, critical, and
  news with a small budget of its own) so a down provider cannot become a storm;
* after two failures in a row Telegram is told once a day (kind ``email``), and /alerts shows the state;
* a ledger that cannot be written is remembered in memory (bounded), a ledger
  that cannot be read sends nothing (the engine never calls us without a state);
* the first pass only records what already exists, then sends one "on" e-mail (retried until it has gone out);
* nothing here ever raises into the alert loop (:meth:`OwnerMail.run` catches).

WHAT IS IN A MAIL. The alert lines the bot already shows (ids, counts, amounts,
fixed words), each stripped of markup, scrubbed (tg_text.sanitize_outgoing: e-mail
addresses, tokens, key shapes), clipped and HTML-escaped again. Subjects carry no
amount, id or name. No customer name or address is ever selected, so none can
appear. The footer says why the mail was sent and how to pause it.

Logs carry counts and machine codes: never an address, a key, a subject or a body.
"""

from __future__ import annotations

import html
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from modules import email_notify as mail
from modules.operator_bot import analysis, owner_digest, views
from modules.operator_bot.alerts import EVENT_WINDOW, PAYMENT_WINDOW, SEVERITY_ORDER, Alert
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.i18n import DEFAULT_LANGUAGE, t
from modules.operator_bot.sources import OperatorSources, parse_ts
from modules.operator_bot.store import MAIL_ARMED, MAIL_BASELINE, MAIL_SINK, AlertState
from modules.tg_text import safe_id, sanitize_outgoing, short_id

logger = logging.getLogger(__name__)

#: The one switch: the variable must be exactly this (not "ON", not "true", not " on").
SWITCH = "NIGHTSHIFT_OWNER_EMAIL"
SWITCH_ON = "on"

#: Alert kinds the owner can have by e-mail. ``signup`` exists only here.
MAIL_KINDS = ("payment", "signup", "run", "stuck", "worker", "deploy", "marketing", "balance", "audit", "approval",
              "pipeline", "health")
#: What an unset OWNER_EMAIL_KINDS means: the owner's list (payments, sign-ups,
#: system problems). Balances, audit events and approvals are opt-in by name.
DEFAULT_KINDS = ("payment", "signup", "run", "stuck", "worker", "deploy", "marketing", "pipeline", "health")
#: Kinds whose INFO-severity alerts are wanted as news (a payment received, a new
#: account). Any other info alert (a draft waiting, a post sent) is not e-mailed.
INFO_KINDS = ("payment", "signup", "pipeline", "health")

MAX_ATTEMPTS = 3
#: Per alert: attempts are spaced this far apart, at most MAX_ATTEMPTS inside one window, and a window is the
#: alert's own cooldown (REARM_MIN for a one-off alert). When it has passed the alert may be tried again: an
#: outage that outlasts the attempts delays a mail, it does not drop it for good.
RETRY_AFTER = timedelta(minutes=15)
REARM_MIN = 180
#: Sink level: after a failed delivery nothing is sent until this has passed, doubling per failure in a row
#: up to the maximum. A refused key (401 / 403) is the same state: a configuration problem, not a verdict on
#: any alert, so no alert is marked dead for it.
SINK_BACKOFF = timedelta(minutes=5)
SINK_BACKOFF_MAX = timedelta(minutes=60)
#: Failures in a row (since the last mail that went out) after which Telegram is told once a day.
OUTAGE_AFTER = 2
AUTH_REFUSED = ("http_401", "http_403")
#: Budgets per hour of attempts. Warn-level problems use the engine's OPERATOR_ALERT_MAX_PER_HOUR; news (a
#: payment received, a new account) has its own small one, so six sign-ups can never hold back a failed job.
MAX_INFO_PER_HOUR = 3
#: Critical mails have a budget of their own so a flood of the rest cannot starve them
#: (alerts.MAX_CRITICAL_PER_HOUR is the same idea; this one is lower: it is a mailbox).
MAX_CRITICAL_PER_HOUR = 10
#: What this process tried to record and the store refused (bounded, memory only).
MAX_UNRECORDED = 500
LOOKBACK_UNRECORDED = timedelta(hours=48)
#: Lines in one mail, and what is read from the roster / sent per pass.
MAX_LINES = 10
MAX_RECIPIENTS = 3
MAX_EXTRAS = 50
ADDRESS_CACHE = timedelta(minutes=10)
#: The whole roster-to-address lookup gets this long; whatever was confirmed by then is used, uncached.
LOOKUP_DEADLINE_S = 20.0

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_ADDRESS = re.compile(r"[^@\s<>\"',;()\[\]\\]{1,64}@[A-Za-z0-9.\-]{1,190}\.[A-Za-z]{2,24}")


# -- configuration ----------------------------------------------------------

def parse_kinds(raw: Optional[str]) -> frozenset:
    """``OWNER_EMAIL_KINDS``: comma-separated kind names. Unknown names are dropped; an
    empty or wholly unknown value means the default list (a typo must not silence
    everything, and ``off`` is the switch's job, not this list's)."""
    names = {part.strip().lower() for part in str(raw or "").split(",")}
    picked = frozenset(n for n in names if n in MAIL_KINDS)
    return picked or frozenset(DEFAULT_KINDS)


def transport_from_env(env: Mapping[str, str]) -> Optional[Any]:
    """The sender the owner configured, or None. ``resend`` is the default (the
    same transport as the customer e-mail worker, modules/email_notify.py); ``fake``
    writes to a folder and sends nothing (local runs and tests)."""
    kind = (env.get("NIGHTSHIFT_EMAIL_TRANSPORT") or "resend").strip().lower()
    if kind == "fake":
        return mail.FakeTransport(Path((env.get("NIGHTSHIFT_EMAIL_FAKE_DIR") or "output/email-fake").strip()))
    if kind == "resend":
        key = (env.get("RESEND_API_KEY") or "").strip()
        sender = mail.clean_line(env.get("NIGHTSHIFT_EMAIL_FROM"), 200)
        if key and sender:
            return mail.ResendTransport(key, sender)
    return None


# -- who gets it ------------------------------------------------------------

def _fetch_auth_user(sync, user_id: str) -> Optional[dict]:
    """One account from Supabase Auth's admin endpoint (service key). None on any
    failure; nothing about the request or the answer is logged."""
    url, key = getattr(sync, "url", ""), getattr(sync, "service_key", "")
    if not url or not key:
        return None
    try:
        import requests  # noqa: PLC0415

        r = requests.get(f"{url}/auth/v1/admin/users/{user_id}", timeout=10,
                         headers={"apikey": key, "Authorization": f"Bearer {key}"})
        body = r.json() if r.status_code == 200 else None
    except Exception as e:  # noqa: BLE001 - the text of a requests error can quote the URL
        logger.warning("owner e-mail: account lookup failed (%s)", type(e).__name__)
        return None
    return body if isinstance(body, dict) else None


class OwnerDirectory:
    """The confirmed e-mail addresses of the platform's owners and admins.

    The roster (``app_members``) is read for ``user_id``, ``role`` and ``created_at`` only; the address
    comes from Supabase Auth for that user id, and only when Auth says it is confirmed. The roster's own
    ``email`` column is never selected. Owners come first, then oldest first, so the same few people are
    chosen on every pass when there are more than MAX_RECIPIENTS."""

    def __init__(self, sync, now: Callable[[], datetime], fetch_user: Optional[Callable[[str], Optional[dict]]] = None,
                 monotonic: Callable[[], float] = time.monotonic):
        self.sync = sync
        self._now = now
        self._fetch = fetch_user or (lambda uid: _fetch_auth_user(sync, uid))
        self._monotonic = monotonic
        self._cached: Optional[tuple] = None

    def addresses(self) -> list:
        now = self._now()
        if self._cached is not None and now - self._cached[0] < ADDRESS_CACHE:
            return list(self._cached[1])
        found, complete = self._read(now)
        self._cached = (now, found) if complete else None   # a failed or cut-short lookup is asked again next pass
        return list(found)

    def _read(self, now: datetime) -> tuple:
        """(addresses, complete). Nobody and incomplete when the roster cannot be read."""
        try:
            rows = self.sync.select_strict("app_members", {
                "select": "user_id,role,created_at", "role": "in.(owner,admin)", "user_id": "not.is.null",
                "order": "role.desc,created_at.asc", "limit": "50"})
        except Exception as e:  # noqa: BLE001
            logger.warning("owner e-mail: roster unreadable (%s)", type(e).__name__)
            return [], False
        # The database is asked for the order, and the order is applied again here: the same people are chosen
        # on every pass whatever the database answered ("owner" before "admin", then oldest first).
        people = sorted((r for r in rows or [] if isinstance(r, dict) and r.get("role") in ("owner", "admin")),
                        key=lambda r: (r.get("role") != "owner", str(r.get("created_at") or ""), str(r.get("user_id") or "")))
        started, out = self._monotonic(), []
        for row in people:
            if self._monotonic() - started > LOOKUP_DEADLINE_S:
                logger.warning("owner e-mail: account lookup ran out of time")
                return out, False
            uid = str(row.get("user_id") or "").lower()
            if not _UUID.fullmatch(uid):
                continue
            address = self._confirmed(self._fetch(uid), uid, now)
            if address and address not in out:
                out.append(address)
            if len(out) >= MAX_RECIPIENTS:
                break
        return out, True

    @staticmethod
    def _confirmed(user, uid: str, now: datetime) -> Optional[str]:
        if not isinstance(user, dict) or str(user.get("id") or "").lower() != uid:
            return None
        if not user.get("email_confirmed_at"):
            return None
        banned = parse_ts(user.get("banned_until"))
        if banned is not None and banned > now:
            return None
        address = str(user.get("email") or "").strip().lower()
        return address if len(address) <= 254 and _ADDRESS.fullmatch(address) else None


# -- the e-mail itself ------------------------------------------------------

def plain(value: Any, limit: int = 300) -> str:
    """A bot line as plain text: markup out, entities decoded, one line, scrubbed."""
    text = html.unescape(re.sub(r"<[^>]*>", "", str(value or "")))
    return sanitize_outgoing(mail.clean_line(text, limit))


def group_of(a: Alert) -> str:
    """Which e-mail an alert belongs to: one mail per group per pass."""
    if a.kind == "payment":
        return "payment_in" if a.key.endswith(":paid") else "payment_problem"
    return a.kind


def _link(op_cfg: OperatorConfig, page: Optional[str]) -> Optional[str]:
    return views.app_link(op_cfg, page) if page else None


def _compose(lang: str, op_cfg: OperatorConfig, *, to: str, subject: str, title: str, lines: list,
             heading: str = "", more: Optional[list] = None, open_url: Optional[str] = None) -> mail.Message:
    """Plain text and simple HTML for the same content: a list, and optionally a second
    list under a heading (the digest's "needs attention"). Every dynamic string is
    reduced to plain text first and escaped for the HTML; the links are built from the
    validated app origin only."""
    e = html.escape
    manage = _link(op_cfg, "alerts")
    reason, pause = plain(t(lang, "ownermail.reason"), 400), plain(t(lang, "ownermail.pause"), 400)
    open_label, manage_label = t(lang, "btn.open"), t(lang, "ownermail.manage")
    body = [plain(x) for x in lines]
    after = [plain(x) for x in (more or [])]
    head = plain(heading, 80)

    def ul(items: list) -> str:
        rows = "".join(f'<li style="margin:0 0 8px 0;">{e(x)}</li>' for x in items)
        return f'<ul style="font-size:15px;line-height:1.5;margin:0 0 16px 0;padding-left:20px;">{rows}</ul>'

    text = [title, "", *[f"- {x}" for x in body]]
    inner = f'<h1 style="font-size:20px;line-height:1.3;margin:0 0 14px 0;">{e(title)}</h1>{ul(body)}'
    if after:
        text += ["", head, *[f"- {x}" for x in after]]
        inner += f'<h2 style="font-size:16px;margin:0 0 8px 0;">{e(head)}</h2>{ul(after)}'
    if open_url:
        text += ["", f"{open_label}: {open_url}"]
        inner += f'<a href="{e(open_url, quote=True)}" style="{mail._STYLE_BTN}">{e(open_label)}</a>'
    text += ["", "--", reason, pause]
    footer = f"{e(reason)}<br>{e(pause)}"
    if manage:
        text.append(f"{manage_label}: {manage}")
        footer += f'<br><a href="{e(manage, quote=True)}" style="color:#6b6b76;">{e(manage_label)}</a>'
    return mail.Message(to=to, subject=mail.clean_line(sanitize_outgoing(subject), 120), text="\n".join(text),
                        html=mail._page(lang, {}, title, inner, footer))


def render_alerts(lang: str, op_cfg: OperatorConfig, group: str, alerts: list, to: str) -> mail.Message:
    """One e-mail for the alerts of one group: a subject without any id, amount or name."""
    top = min(alerts, key=lambda a: SEVERITY_ORDER.get(a.severity, 9)).severity
    label = plain(t(lang, f"ownermail.subject_{group}", n=len(alerts)), 80)
    subject = f"{plain(t(lang, 'sev.critical'), 20)} · {label}" if top == "critical" else label
    lines = [a.line for a in alerts[:MAX_LINES]]
    if len(alerts) > MAX_LINES:
        lines.append(t(lang, "alert.more", n=len(alerts) - MAX_LINES))
    page = views.KIND_PAGE.get(alerts[0].kind)
    return _compose(lang, op_cfg, to=to, subject=subject, title=subject, lines=lines, open_url=_link(op_cfg, page))


def render_digest(lang: str, op_cfg: OperatorConfig, digest: owner_digest.Digest, to: str) -> mail.Message:
    subject = plain(t(lang, "ownermail.subject_digest", date=digest.date), 80)
    return _compose(lang, op_cfg, to=to, subject=subject, title=subject,
                    lines=[t(lang, "ownermail.dg_day", date=digest.date, tz=str(op_cfg.tz))] + digest.lines,
                    heading=t(lang, "ownermail.dg_attention"), more=digest.attention,
                    open_url=_link(op_cfg, "home"))


# -- the sink ---------------------------------------------------------------

@dataclass
class MailReport:
    state: str = "ok"          # ok | no_recipients | backoff | unknown | error
    baseline: bool = False
    sent: int = 0              # alerts whose e-mail went out
    failed: int = 0            # alerts whose e-mail did not
    deduped: int = 0
    muted: int = 0
    quiet_held: int = 0
    rate_held: int = 0
    digest_sent: bool = False
    failing: Optional[str] = None      # the closed code of the delivery that failed in this pass


class OwnerMail:
    def __init__(self, ops: OperatorSources, store, transport, directory: OwnerDirectory, cfg: OperatorConfig,
                 kinds: frozenset = frozenset(DEFAULT_KINDS), held_fn: Optional[Callable[[], Optional[list]]] = None):
        self.ops, self.store, self.transport, self.directory, self.cfg = ops, store, transport, directory, cfg
        self.kinds = kinds
        self.held_fn = held_fn
        self._unrecorded: list = []
        self._baseline_unrecorded = False

    @classmethod
    def from_env(cls, ops: OperatorSources, store, sync, cfg: OperatorConfig, env: Mapping[str, str],
                 held_fn: Optional[Callable[[], Optional[list]]] = None) -> Optional["OwnerMail"]:
        """The sink, or None when it is off. Says which NAMES are missing, never a value."""
        if env.get(SWITCH) != SWITCH_ON:
            return None
        transport = transport_from_env(env)
        if transport is None:
            logger.info("owner e-mail: %s is on but the sender is not configured: set RESEND_API_KEY and "
                        "NIGHTSHIFT_EMAIL_FROM", SWITCH)
            return None
        directory = OwnerDirectory(sync, ops.now)
        logger.info("owner e-mail: on (via %s)", transport.name)
        return cls(ops, store, transport, directory, cfg, parse_kinds(env.get("OWNER_EMAIL_KINDS")), held_fn)

    # -- what could be mailed

    def wants(self, a: Alert) -> bool:
        return a.kind in self.kinds and (a.severity != "info" or a.kind in INFO_KINDS)

    def extra_alerts(self, now: datetime, lang: str) -> list:
        """The two events the Telegram bot does not announce: a payment received and a new account."""
        out: list = []
        try:
            pay = self.ops.payment_events(now - PAYMENT_WINDOW)
            if pay.ok:
                for r in analysis.classify_payments(pay.data, now - PAYMENT_WINDOW)["paid"][:MAX_EXTRAS]:
                    tail = safe_id(r.get("event_id"), 200)[-8:]
                    if tail:
                        out.append(Alert("payment", f"payment:{tail}:paid", "info", t(
                            lang, "ownermail.payment_paid", id=short_id(r.get("event_id")),
                            amount=views.money(lang, r.get("amount_minor"), r.get("currency")),
                            when=views.ago(lang, parse_ts(r.get("received_at")), now))))
            su = self.ops.signups(now - EVENT_WINDOW)
            if su.ok:
                for r in (su.data or [])[:MAX_EXTRAS]:
                    org = safe_id(r.get("id"), 40)
                    if org:
                        out.append(Alert("signup", f"signup:{org}", "info", t(
                            lang, "ownermail.signup_line", id=short_id(org),
                            when=views.ago(lang, parse_ts(r.get("created_at")), now))))
        except Exception as e:  # noqa: BLE001 - a malformed row must not end the pass
            logger.warning("owner e-mail: extra alerts skipped (%s)", type(e).__name__)
            return []
        return out

    # -- ledger

    def _record(self, a_key: str, kind: str, outcome: str, severity: str, now: datetime) -> None:
        if self.store.record_mail(a_key, kind, outcome, severity) is False:
            self._unrecorded.append((now, a_key, kind, outcome, severity))
            del self._unrecorded[:-MAX_UNRECORDED]

    def _merge_unrecorded(self, state: AlertState, now: datetime) -> None:
        if state.mail_merged:
            return
        state.mail_merged = True
        keep = []
        for at, key, kind, outcome, sev in self._unrecorded:
            if now - at > LOOKBACK_UNRECORDED:
                continue
            if any(m[1] == key and m[3] == outcome and m[0] >= at - timedelta(minutes=1) for m in state.mails):
                continue                       # the store has it now
            keep.append((at, key, kind, outcome, sev))
            state.mails.append((at, key, kind, outcome, sev))
        self._unrecorded = keep
        if self._baseline_unrecorded:
            state.mail_baseline_seen = True

    def _deduped(self, key: str, cooldown_min: int, state: AlertState, now: datetime) -> bool:
        """True when this key must not be mailed now: it was sent (or marked seen) and its cooldown has not
        passed, or its failed attempts inside the current window are used up or too recent."""
        rows = sorted((m for m in state.mails if m[1] == key), key=lambda m: m[0])
        if not rows:
            return False
        ok = [m[0] for m in rows if m[3] in ("sent", "seen")]
        last_ok = max(ok) if ok else None
        if last_ok is not None and (cooldown_min <= 0 or now - last_ok < timedelta(minutes=cooldown_min)):
            return True
        window = timedelta(minutes=cooldown_min if cooldown_min > 0 else REARM_MIN)
        bad = [m for m in rows if m[3] == "retry" and (last_ok is None or m[0] > last_ok) and now - m[0] < window]
        if len(bad) >= MAX_ATTEMPTS:
            return True
        return bool(bad) and now - bad[-1][0] < RETRY_AFTER

    @staticmethod
    def _failures(state: AlertState) -> list:
        """Failed deliveries (sink rows) since the last mail that went out, oldest first."""
        sent = max((m[0] for m in state.mails if m[3] == "sent"), default=None)
        return sorted((m for m in state.mails if m[1] == MAIL_SINK and (sent is None or m[0] > sent)),
                      key=lambda m: m[0])

    def _sink_wait(self, state: AlertState, now: datetime) -> bool:
        """True while the sink is backing off after failed deliveries (doubling, up to SINK_BACKOFF_MAX)."""
        fails = self._failures(state)
        if not fails:
            return False
        wait = min(SINK_BACKOFF * 2 ** (len(fails) - 1), SINK_BACKOFF_MAX)
        return now - fails[-1][0] < wait

    def outage_alerts(self, state: AlertState, now: datetime, lang: str) -> list:
        """One info alert per local date while deliveries keep failing, for the Telegram path (its dedupe,
        mute and quiet hours apply). It names a closed code, never a message or an address."""
        try:
            self._merge_unrecorded(state, now)
            fails = self._failures(state)
            if len(fails) < OUTAGE_AFTER:
                return []
            code = safe_id(fails[-1][2], 40) or "unknown"
            return [Alert("email", f"email:outage:{self.cfg.local_date(now)}", "info",
                          t(lang, "ownermail.outage", code=code))]
        except Exception as e:  # noqa: BLE001
            logger.warning("owner e-mail: outage note skipped (%s)", type(e).__name__)
            return []

    # -- delivery

    def deliver(self, build: Callable[[str], mail.Message], recipients: list) -> tuple:
        """Send one message to each recipient. Returns (outcome, code): ``sent`` when at least one went out
        (the others are not retried: that would mail the first twice), ``config`` when every refusal was the
        provider rejecting our key (401 / 403), else ``retry``. Never raises."""
        sent, code = 0, None
        refused = 0
        for address in recipients:
            try:
                self.transport.send(build(address))
                sent += 1
            except mail.TransportError as e:
                code = e.code
                refused += 1 if e.code in AUTH_REFUSED else 0
            except Exception as e:  # noqa: BLE001
                code = "send_" + type(e).__name__.lower()[:20]
        if sent:
            return "sent", None
        return ("config" if refused == len(recipients) else "retry"), code

    def run(self, found: list, state: AlertState, now: datetime, lang: str = DEFAULT_LANGUAGE) -> MailReport:
        """One pass over what the engine detected. Never raises."""
        try:
            return self._run(found, state, now, lang)
        except Exception as e:  # noqa: BLE001 - the alert loop must not die of an e-mail
            logger.warning("owner e-mail pass failed (%s)", type(e).__name__)
            return MailReport(state="error")

    def _fail(self, outcome: str, code: Optional[str], items: list, now: datetime, rep: MailReport) -> None:
        """A delivery failed: remember it at sink level (the backoff and the outage note read it) and, for a
        failure that may be about the message, per alert. A refused key marks no alert."""
        code = safe_id(code, 40) or "unknown"
        rep.failing = code
        self._record(MAIL_SINK, code, "retry", "info", now)
        if outcome == "retry":
            for a in items:
                self._record(a.key, a.kind, "retry", a.severity, now)
        rep.failed += len(items)
        logger.warning("owner e-mail: not sent (%s)", code)

    def _run(self, found: list, state: AlertState, now: datetime, lang: str) -> MailReport:
        rep = MailReport()
        if not state.mail_state_known:
            rep.state = "unknown"           # the ledger's marker could not be read: not a first pass, not a later one
            return rep
        self._merge_unrecorded(state, now)
        everything = list(found) + self.extra_alerts(now, lang)

        if not state.mail_baseline_seen:
            return self._baseline(everything, state, now, lang, rep)

        if self._sink_wait(state, now):
            rep.state = "backoff"
            return rep

        quiet = self.cfg.in_quiet_hours(now)
        fresh: list = []
        for a in (x for x in everything if self.wants(x)):
            if self._deduped(a.key, a.cooldown_min, state, now):
                rep.deduped += 1
            elif state.is_muted(a.kind, a.severity):
                rep.muted += 1
                self._record(a.key, a.kind, "seen", a.severity, now)
            elif quiet and a.severity != "critical":
                rep.quiet_held += 1
            else:
                fresh.append(a)

        hour_ago = now - timedelta(hours=1)
        budgets = {"critical": MAX_CRITICAL_PER_HOUR - state.mails_since(hour_ago, "critical"),
                   "info": MAX_INFO_PER_HOUR - state.mails_since(hour_ago, "info"),
                   "warn": self.cfg.max_alerts_per_hour - state.mails_since(hour_ago, "warn")}
        fresh.sort(key=lambda a: (SEVERITY_ORDER.get(a.severity, 9), a.key))
        chosen: list = []
        for a in fresh:
            klass = "critical" if a.severity == "critical" else "info" if a.severity == "info" else "warn"
            if budgets[klass] > 0:
                budgets[klass] -= 1
                chosen.append(a)
            else:
                rep.rate_held += 1

        armed_due = not any(m[1] == MAIL_ARMED and m[3] == "sent" for m in state.mails)
        due_digest = self._digest_due(state, now, quiet)
        if not chosen and not due_digest and not armed_due:
            return rep
        recipients = self.directory.addresses()
        if not recipients:
            rep.state = "no_recipients"
            logger.info("owner e-mail: no confirmed owner or admin address; nothing sent")
            return rep

        if armed_due and not self._send_armed(lang, recipients, now, rep):
            return rep
        groups: dict = {}
        for a in chosen:
            groups.setdefault(group_of(a), []).append(a)
        for group, items in groups.items():
            outcome, code = self.deliver(lambda to, g=group, i=items: render_alerts(lang, self.cfg, g, i, to), recipients)
            if outcome != "sent":
                self._fail(outcome, code, items, now, rep)
                return rep                      # the provider or the key is down: the rest waits for the next pass
            for a in items:
                self._record(a.key, a.kind, "sent", a.severity, now)
            rep.sent += len(items)

        if due_digest:
            self._send_digest(now, lang, recipients, rep)
        return rep

    def _send_armed(self, lang: str, recipients: list, now: datetime, rep: MailReport) -> bool:
        """The "on" mail, repeated (with the sink's backoff) until it has gone out once."""
        title = plain(t(lang, "ownermail.subject_armed"), 80)
        line = t(lang, "ownermail.armed")
        outcome, code = self.deliver(lambda to: _compose(
            lang, self.cfg, to=to, subject=title, title=title, lines=[line], open_url=_link(self.cfg, "alerts")), recipients)
        if outcome != "sent":
            self._fail(outcome, code, [], now, rep)
            return False
        self._record(MAIL_ARMED, "armed", "sent", "info", now)
        rep.sent += 1
        return True

    def _digest_due(self, state: AlertState, now: datetime, quiet: bool) -> Optional[str]:
        """The key of today's digest when it is time, else None. From OPERATOR_DIGEST_HOUR
        on, once per local date, never in quiet hours (it goes out when the window ends)."""
        h = self.cfg.digest_hour
        if h is None or quiet or self.cfg.local_hour(now) < h:
            return None
        key = f"digest:{self.cfg.local_date(now)}"
        return None if self._deduped(key, 0, state, now) else key

    def _send_digest(self, now: datetime, lang: str, recipients: list, rep: MailReport) -> None:
        key = f"digest:{self.cfg.local_date(now)}"
        held = None
        try:
            held = self.held_fn() if self.held_fn is not None else _held(self.ops)
        except Exception:  # noqa: BLE001
            held = None
        digest = owner_digest.build(self.ops, lang, held)
        outcome, code = self.deliver(lambda to: render_digest(lang, self.cfg, digest, to), recipients)
        if outcome == "sent":
            self._record(key, "digest", "sent", "info", now)
            rep.digest_sent = True
        else:
            self._fail(outcome, code, [Alert("digest", key, "info", "")], now, rep)

    def _baseline(self, everything: list, state: AlertState, now: datetime, lang: str, rep: MailReport) -> MailReport:
        """First pass: what exists is marked seen (no history is announced). The marker is written only when
        there is somebody to tell, so a missing address does not use the first pass up. The "on" mail follows
        in the same pass and, if it fails, on later ones until it has gone out."""
        rep.baseline = True
        recipients = self.directory.addresses()
        if not recipients:
            rep.state = "no_recipients"
            logger.info("owner e-mail: no confirmed owner or admin address; waiting")
            return rep
        for a in everything:
            self._record(a.key, a.kind, "seen", a.severity, now)
        if self.store.record_mail(MAIL_BASELINE, "baseline", "seen", "info") is False:
            self._baseline_unrecorded = True
        self._send_armed(lang, recipients, now, rep)
        return rep


def _held(ops: OperatorSources) -> Optional[list]:
    sec = ops.held_videos()
    return analysis.review_queue(sec.data) if sec.ok else None
