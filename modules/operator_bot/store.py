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

Why this and not a migration: merging a migration to main applies it to the live
database automatically. Reusing the feed means this feature adds no SQL at all.
The cost is that these rows also show on the Alerts page; they carry only ids
and kind names.

A store that cannot be read answers None, and the engine then sends NOTHING:
without memory it could not tell a new alert from one it already sent, and
a monitor that repeats itself is worse than one that waits.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional, Protocol

from modules.operator_bot.sources import iso, parse_ts

logger = logging.getLogger(__name__)

LOOKBACK = timedelta(hours=48)
MUTE_FOR = timedelta(hours=24)
KIND_PREFIX = "operator."


@dataclass
class AlertState:
    #: (at, key, alert kind, delivered) for each operator.alert row
    alerts: list = field(default_factory=list)
    #: alert kind (or "all") -> mute end, only those still in the future
    mutes: dict = field(default_factory=dict)
    digest_dates: set = field(default_factory=set)
    #: True when the baseline marker exists at ANY age: the 48-hour window above
    #: would otherwise forget it, and a quiet system would "start for the first
    #: time" again every two days.
    baseline_seen: bool = False

    def last_seen(self, key: str) -> Optional[datetime]:
        times = [a[0] for a in self.alerts if a[1] == key]
        return max(times) if times else None

    def delivered_since(self, since: datetime) -> int:
        return sum(1 for at, _k, _kind, delivered in self.alerts if delivered and at >= since)

    def is_muted(self, kind: str) -> bool:
        return kind in self.mutes or "all" in self.mutes

    @property
    def armed(self) -> bool:
        """True once the first run has left its baseline marker."""
        return self.baseline_seen or any(a[1] == "baseline" for a in self.alerts)


class AlertStore(Protocol):
    def load(self, now: datetime) -> Optional[AlertState]: ...
    def record_alert(self, key: str, kind: str, delivered: bool, severity: str = "info",
                     channel_id: Optional[str] = None) -> bool: ...
    def record_mute(self, kind: str, until: datetime) -> bool: ...
    def record_unmute(self, kind: str) -> bool: ...
    def record_digest(self, date: str) -> bool: ...


def replay(rows: list, now: datetime, baseline_seen: bool = False) -> AlertState:
    """Build the state from alert_events rows (any order)."""
    state = AlertState(baseline_seen=baseline_seen)
    mutes: dict = {}
    for row in sorted(rows, key=lambda r: str(r.get("at") or "")):
        kind = str(row.get("kind") or "")
        at = parse_ts(row.get("at"))
        title = str(row.get("title") or "")
        if kind == "operator.alert" and at:
            state.alerts.append((at, title, str(row.get("body") or ""), bool(row.get("delivered"))))
        elif kind == "operator.mute":
            until = parse_ts(row.get("body"))
            if until:
                mutes[title] = until
        elif kind == "operator.unmute":
            mutes.pop(title, None)
        elif kind == "operator.digest":
            state.digest_dates.add(title)
    state.mutes = {k: v for k, v in mutes.items() if v > now}
    return state


class SupabaseAlertStore:
    """The durable store, on the service-key client the pipeline already uses."""

    def __init__(self, sync):
        self.sync = sync

    @property
    def durable(self) -> bool:
        return bool(self.sync is not None and getattr(self.sync, "enabled", False))

    def load(self, now: datetime) -> Optional[AlertState]:
        if not self.durable:
            return None
        from modules.supabase_sync import SupabaseReadError

        try:
            rows = self.sync.select_strict("alert_events", {
                "select": "at,kind,title,body,delivered",
                "kind": f"like.{KIND_PREFIX}*", "at": f"gte.{iso(now - LOOKBACK)}",
                "order": "at.desc", "limit": "2000",
            })
            marker = self.sync.select_strict("alert_events", {
                "select": "at", "kind": "eq.operator.alert", "title": "eq.baseline", "limit": "1",
            })
        except SupabaseReadError as e:
            logger.warning("operator alert state unreadable (%s)", e.detail)
            return None
        except Exception as e:
            logger.warning("operator alert state unreadable (%s)", type(e).__name__)
            return None
        return replay(rows, now, baseline_seen=bool(marker))

    def _write(self, kind: str, title: str, body: str = "", severity: str = "info",
               channel_id: Optional[str] = None, delivered: bool = False) -> bool:
        if not self.durable:
            return False
        row = {"kind": kind, "severity": severity, "title": title[:200], "body": body[:300],
               "delivered": delivered}
        if channel_id:
            row["channel_id"] = channel_id
        return self.sync.upsert("alert_events", [row]) > 0

    def record_alert(self, key, kind, delivered, severity="info", channel_id=None) -> bool:
        return self._write("operator.alert", key, kind, severity, channel_id, delivered)

    def record_mute(self, kind, until) -> bool:
        return self._write("operator.mute", kind, iso(until))

    def record_unmute(self, kind) -> bool:
        return self._write("operator.unmute", kind)

    def record_digest(self, date) -> bool:
        return self._write("operator.digest", date)


class MemoryAlertStore:
    """In-memory store for tests and for a dry run with no database."""

    durable = True

    def __init__(self, now_fn=None):
        self.rows: list = []
        self.fail_load = False
        self.fail_write = False
        self._now = now_fn or (lambda: datetime.now(timezone.utc))

    def load(self, now):
        return None if self.fail_load else replay(self.rows, now)

    def _add(self, kind, title, body="", delivered=False) -> bool:
        if self.fail_write:
            return False
        self.rows.append({"at": iso(self._now()), "kind": kind, "title": title, "body": body,
                          "delivered": delivered})
        return True

    def record_alert(self, key, kind, delivered, severity="info", channel_id=None) -> bool:
        return self._add("operator.alert", key, kind, delivered)

    def record_mute(self, kind, until) -> bool:
        return self._add("operator.mute", kind, iso(until))

    def record_unmute(self, kind) -> bool:
        return self._add("operator.unmute", kind)

    def record_digest(self, date) -> bool:
        return self._add("operator.digest", date)
