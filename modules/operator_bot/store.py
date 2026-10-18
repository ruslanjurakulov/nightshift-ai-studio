"""Alert memory: what was already sent, what is muted, when the digest last ran.

No new table. The platform already has a durable operator alert feed,
``alert_events`` (migration 0010; platform owner/admin read it on the Alerts
page, the service key writes it, ``provider_balance`` already does). The bot
keeps its state there as rows with ``kind`` starting ``operator.``:

  operator.alert    one per alert considered. title = the dedupe key,
                    body = the alert kind, delivered = true when it reached
                    Telegram (false when it was only marked as seen: the first
                    run's baseline, or an alert that arrived while muted).
  operator.mute     title = alert kind or ``all``, body = the ISO time it lasts until
  operator.unmute   title = alert kind or ``all``
  operator.digest   title = the local date the daily digest went out
  operator.language title = the language code the owner picked with /language
  operator.mail     the owner's e-mail copy of an alert (modules/operator_bot/owner_mail.py):
                    title = the dedupe key, body = ``<alert kind>:<outcome>`` with the
                    outcome sent | seen | retry. ``mail:baseline`` is the marker that the first
                    e-mail pass has happened, ``mail:armed`` the "on" e-mail once it went out,
                    ``mail:sink`` one failed delivery (body: closed code), which is what drives the
                    sink-level backoff and the outage note

Why this and not a migration: merging a migration to main applies it to the live
database automatically. Reusing the feed means this feature adds no SQL at all.
The cost is that these rows also show on the Alerts page; they carry only ids
and kind names.

Who may write this table matters, because the bot trusts what it reads back.
alert_events_insert (0033) lets anyone who can view a channel insert rows with
that channel_id and ANY kind, title and body. So the bot's own rows are all
written with channel_id NULL (RLS lets only a platform admin or the service key
write those), it reads ONLY channel_id IS NULL rows, replay ignores any row that
still carries a channel, and a mute is capped at 24 hours from the moment it was
written no matter what its body says. A tenant who forges an `operator.mute`
or an `operator.alert` row therefore changes nothing the bot believes.

A store that cannot be read answers None, and the engine then sends NOTHING:
without memory it could not tell a new alert from one it already sent, and
a monitor that repeats itself is worse than one that waits.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional, Protocol

from modules.operator_bot.i18n import LANGUAGES
from modules.operator_bot.sources import iso, parse_ts

logger = logging.getLogger(__name__)

LOOKBACK = timedelta(hours=48)
MUTE_FOR = timedelta(hours=24)
KIND_PREFIX = "operator."
#: The e-mail ledger's rows: the marker of the first pass, and the outcomes a row may carry.
MAIL_BASELINE = "mail:baseline"
MAIL_ARMED = "mail:armed"
MAIL_SINK = "mail:sink"
MAIL_OUTCOMES = ("sent", "seen", "retry")
PAGE = 1000
MAX_PAGES = 5


@dataclass
class AlertState:
    #: (at, key, alert kind, delivered, severity) for each operator.alert row
    alerts: list = field(default_factory=list)
    #: alert kind (or "all") -> mute end, only those still in the future
    mutes: dict = field(default_factory=dict)
    digest_dates: set = field(default_factory=set)
    #: True when the baseline marker exists at ANY age: the 48-hour window above
    #: would otherwise forget it, and a quiet system would "start for the first
    #: time" again every two days.
    baseline_seen: bool = False
    #: (at, key, alert kind, outcome, severity) for each operator.mail row: the
    #: owner's e-mail ledger, kept apart from ``alerts`` so a failed or switched-off
    #: e-mail never changes what Telegram thinks it has sent.
    mails: list = field(default_factory=list)
    #: The e-mail ledger's own first-pass marker, at ANY age (like ``baseline_seen``).
    mail_baseline_seen: bool = False
    #: False when the e-mail ledger's marker could not be read (the read is non-fatal for Telegram, but
    #: the e-mail side cannot tell a first pass from a later one, so it sends nothing).
    mail_state_known: bool = True
    #: set once the sink has merged what it could not write into ``mails`` for this pass (idempotence)
    mail_merged: bool = False

    def mails_since(self, since: datetime, klass: str) -> int:
        """E-mail attempts (sent or not: a failing sender must not lift the cap) since ``since`` in one
        budget class: ``critical``, ``info`` (news: a payment received, a new account) or ``warn`` (the
        rest), so news cannot starve a problem. The marker, the "on" mail, the failure rows and the
        digest (keys ``mail:*`` and ``digest:*``) are not alerts and do not use a budget."""
        def klass_of(sev: str) -> str:
            return "critical" if sev == "critical" else "info" if sev == "info" else "warn"

        return sum(1 for at, key, _kind, outcome, sev in self.mails
                   if outcome in ("sent", "retry") and at >= since and klass_of(sev) == klass
                   and not key.startswith(("mail:", "digest:")))

    def mail_health(self) -> Optional[tuple]:
        """The owner e-mail's state from its ledger: ``("failing", closed code, last failure, count)`` when
        deliveries failed since the last one that went out, ``("ok", None, last sent, 0)``, or None when
        the ledger has nothing (the feature is off or has not run)."""
        sent = max((m[0] for m in self.mails if m[3] == "sent"), default=None)
        fails = sorted((m for m in self.mails if m[1] == MAIL_SINK and (sent is None or m[0] > sent)),
                       key=lambda m: m[0])
        if fails:
            return "failing", fails[-1][2], fails[-1][0], len(fails)
        return ("ok", None, sent, 0) if sent else None

    def last_seen(self, key: str) -> Optional[datetime]:
        times = [a[0] for a in self.alerts if a[1] == key]
        return max(times) if times else None

    def delivered_since(self, since: datetime, critical: bool) -> int:
        """Alerts delivered since ``since``, counting only critical ones when
        ``critical`` is true and only the others when it is false: the two have
        separate budgets, so a flood of one cannot starve the other."""
        return sum(1 for at, _k, _kind, delivered, sev in self.alerts
                   if delivered and at >= since and (sev == "critical") == critical)

    def is_muted(self, kind: str, severity: str = "warn") -> bool:
        """A mute of this kind silences it at any severity. ``all`` silences
        everything EXCEPT critical alerts: a blanket mute must not hide a dead
        worker or a security event."""
        return kind in self.mutes or ("all" in self.mutes and severity != "critical")

    @property
    def armed(self) -> bool:
        """True once the first run has left its baseline marker."""
        return self.baseline_seen or any(a[1] == "baseline" for a in self.alerts)


class AlertStore(Protocol):
    def load(self, now: datetime, mail: bool = False) -> Optional[AlertState]: ...
    def record_alert(self, key: str, kind: str, delivered: bool, severity: str = "info",
                     channel_id: Optional[str] = None) -> bool: ...
    def record_mute(self, kind: str, until: datetime) -> bool: ...
    def record_unmute(self, kind: str) -> bool: ...
    def record_digest(self, date: str) -> bool: ...
    def record_mail(self, key: str, kind: str, outcome: str, severity: str = "info") -> bool: ...
    def load_language(self) -> Optional[str]: ...
    def record_language(self, code: str) -> bool: ...


#: How far ahead of "now" a row's timestamp may be before it is ignored. The
#: owner's own rows are stamped by the database, so a future one is not hers.
CLOCK_SKEW = timedelta(minutes=5)


def pick_language(rows: list, now: Optional[datetime] = None) -> Optional[str]:
    """The newest language the owner chose, from ``operator.language`` rows, or
    None. Like every other row the bot trusts, one that carries a channel is not
    the bot's (anyone who can see a channel can insert such a row), a code
    outside LANGUAGES is ignored, and so is a row dated in the future: it would
    otherwise be the "newest" for ever and pin the language."""
    now = now or datetime.now(timezone.utc)
    best = None
    for row in rows:
        if row.get("kind", "operator.language") != "operator.language":
            continue
        if row.get("channel_id") not in (None, ""):
            continue
        code = str(row.get("title") or "").strip()
        at = parse_ts(row.get("at"))
        if at is not None and at > now + CLOCK_SKEW:
            continue
        if code in LANGUAGES and at is not None and (best is None or at >= best[0]):
            best = (at, code)
    return best[1] if best else None


def replay(rows: list, now: datetime, baseline_seen: bool = False, mail_baseline_seen: bool = False,
           mail_state_known: bool = True) -> AlertState:
    """Build the state from alert_events rows (any order).

    Defensive about what the table may hold: a row that carries a channel is not
    the bot's and is skipped; a timestamp in the future counts as now; a mute
    lasts at most 24 hours from when it was written, whatever its body says."""
    state = AlertState(baseline_seen=baseline_seen, mail_baseline_seen=mail_baseline_seen,
                       mail_state_known=mail_state_known)
    mutes: dict = {}
    for row in sorted(rows, key=lambda r: str(r.get("at") or "")):
        if row.get("channel_id") not in (None, ""):
            continue
        kind = str(row.get("kind") or "")
        at = parse_ts(row.get("at"))
        if at is not None and at > now:
            at = now
        title = str(row.get("title") or "")
        if kind == "operator.alert" and at:
            state.alerts.append((at, title, str(row.get("body") or ""), bool(row.get("delivered")),
                                 str(row.get("severity") or "")))
        elif kind == "operator.mute" and at:
            until = parse_ts(row.get("body"))
            if until:
                mutes[title] = min(until, at + MUTE_FOR)
        elif kind == "operator.unmute":
            mutes.pop(title, None)
        elif kind == "operator.digest":
            state.digest_dates.add(title)
        elif kind == "operator.mail" and at:
            alert_kind, _, outcome = str(row.get("body") or "").rpartition(":")
            if outcome in MAIL_OUTCOMES:
                state.mails.append((at, title, alert_kind, outcome, str(row.get("severity") or "")))
                if title == MAIL_BASELINE:
                    state.mail_baseline_seen = True
    state.mutes = {k: v for k, v in mutes.items() if v > now}
    return state


class SupabaseAlertStore:
    """The durable store, on the service-key client the pipeline already uses."""

    def __init__(self, sync, now_fn=None):
        self.sync = sync
        self._now = now_fn or (lambda: datetime.now(timezone.utc))

    @property
    def durable(self) -> bool:
        return bool(self.sync is not None and getattr(self.sync, "enabled", False))

    def load(self, now: datetime, mail: bool = False) -> Optional[AlertState]:
        """The alert state. ``mail`` asks for the e-mail ledger's first-pass marker too, which is a read
        only the owner e-mail needs; when that one read fails the state is still returned (Telegram is
        not held hostage by an optional feature) with ``mail_state_known`` False."""
        if not self.durable:
            return None
        from modules.supabase_sync import SupabaseReadError

        try:
            rows = []
            for page in range(MAX_PAGES):
                chunk = self.sync.select_strict("alert_events", {
                    "select": "at,kind,title,body,delivered,severity,channel_id",
                    "kind": f"like.{KIND_PREFIX}*", "channel_id": "is.null",
                    "at": f"gte.{iso(now - LOOKBACK)}",
                    "order": "at.desc", "limit": str(PAGE), "offset": str(page * PAGE),
                })
                rows.extend(chunk)
                if len(chunk) < PAGE:
                    break
            else:
                # More rows than the pages cover: the oldest dedupe keys would be
                # forgotten and alerts repeated. Better to say nothing.
                logger.warning("operator alert state exceeds %d rows — nothing is sent", MAX_PAGES * PAGE)
                return None
            marker = self.sync.select_strict("alert_events", {
                "select": "at", "kind": "eq.operator.alert", "title": "eq.baseline",
                "channel_id": "is.null", "limit": "1",
            })
        except SupabaseReadError as e:
            logger.warning("operator alert state unreadable (%s)", e.detail)
            return None
        except Exception as e:
            logger.warning("operator alert state unreadable (%s)", type(e).__name__)
            return None
        mail_marker, known = [], True
        if mail:
            try:
                mail_marker = self.sync.select_strict("alert_events", {
                    "select": "at", "kind": "eq.operator.mail", "title": f"eq.{MAIL_BASELINE}",
                    "channel_id": "is.null", "limit": "1",
                })
            except Exception as e:  # noqa: BLE001 - optional feature: Telegram carries on, the e-mail waits
                known = False
                logger.warning("owner e-mail ledger marker unreadable (%s)", type(e).__name__)
        return replay(rows, now, baseline_seen=bool(marker), mail_baseline_seen=bool(mail_marker),
                      mail_state_known=known)

    def load_language(self) -> Optional[str]:
        """The chosen language (the newest channel-less row, at any age), or None
        when none was chosen or the read fails — the caller then uses the default."""
        if not self.durable:
            return None
        try:
            # Only rows whose title is a language we speak, so junk rows with a
            # NULL channel cannot crowd the real choice out of the page; a few
            # more than one are read because the newest may be a future-dated row
            # that pick_language ignores.
            rows = self.sync.select_strict("alert_events", {
                "select": "at,kind,title,channel_id", "kind": "eq.operator.language",
                "title": f"in.({','.join(LANGUAGES)})",
                "channel_id": "is.null", "order": "at.desc", "limit": "50",
            })
        except Exception as e:
            logger.warning("operator language unreadable (%s)", type(e).__name__)
            return None
        return pick_language(rows, self._now())

    def record_language(self, code) -> bool:
        return code in LANGUAGES and self._write("operator.language", code)

    def _write(self, kind: str, title: str, body: str = "", severity: str = "info",
               delivered: bool = False) -> bool:
        if not self.durable:
            return False
        # channel_id is deliberately absent (NULL): see the module docstring. An
        # alert about a customer's channel must not become readable on, or
        # writable from, that customer's Alerts page.
        row = {"kind": kind, "severity": severity, "title": title[:200], "body": body[:300],
               "delivered": delivered}
        return self.sync.upsert("alert_events", [row]) > 0

    def record_alert(self, key, kind, delivered, severity="info", channel_id=None) -> bool:
        # `channel_id` is accepted for the interface and never stored.
        return self._write("operator.alert", key, kind, severity, delivered)

    def record_mute(self, kind, until) -> bool:
        return self._write("operator.mute", kind, iso(until))

    def record_unmute(self, kind) -> bool:
        return self._write("operator.unmute", kind)

    def record_digest(self, date) -> bool:
        return self._write("operator.digest", date)

    def record_mail(self, key, kind, outcome, severity="info") -> bool:
        return outcome in MAIL_OUTCOMES and self._write("operator.mail", key, f"{kind}:{outcome}", severity,
                                                         outcome == "sent")


class MemoryAlertStore:
    """In-memory store for tests and for a dry run with no database."""

    durable = True

    def __init__(self, now_fn=None):
        self.rows: list = []
        self.fail_load = False
        self.fail_write = False
        #: the e-mail ledger's marker read fails (the rest of the state still loads)
        self.fail_mail_marker = False
        self._now = now_fn or (lambda: datetime.now(timezone.utc))

    def load(self, now, mail=False):
        return None if self.fail_load else replay(self.rows, now, mail_state_known=not (mail and self.fail_mail_marker))

    def _add(self, kind, title, body="", delivered=False, severity="info") -> bool:
        if self.fail_write:
            return False
        self.rows.append({"at": iso(self._now()), "kind": kind, "title": title, "body": body,
                          "delivered": delivered, "severity": severity})
        return True

    def record_alert(self, key, kind, delivered, severity="info", channel_id=None) -> bool:
        return self._add("operator.alert", key, kind, delivered, severity)

    def record_mute(self, kind, until) -> bool:
        return self._add("operator.mute", kind, iso(until))

    def record_unmute(self, kind) -> bool:
        return self._add("operator.unmute", kind)

    def record_digest(self, date) -> bool:
        return self._add("operator.digest", date)

    def record_mail(self, key, kind, outcome, severity="info") -> bool:
        return outcome in MAIL_OUTCOMES and self._add("operator.mail", key, f"{kind}:{outcome}", outcome == "sent", severity)

    def load_language(self):
        return None if self.fail_load else pick_language(self.rows, self._now())

    def record_language(self, code) -> bool:
        return code in LANGUAGES and self._add("operator.language", code)
