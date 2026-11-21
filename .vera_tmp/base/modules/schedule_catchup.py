"""Catch-up and once-per-slot for the scheduled runs. Reliability only: it adds no publishing power.

Why this exists. ``daily_video.yml`` fires hourly and ``tools/list_channels.py`` picks the channels whose
``publish_hour_utc`` equals the CURRENT UTC hour. GitHub's cron is best effort: a run delayed past the top of the
hour (or dropped) used to skip that channel's whole day, and nothing noticed but the dead-man alert. Two rules
close that, and a third makes them safe to combine:

* **Catch-up.** A channel whose slot hour passed within the last ``NIGHTSHIFT_CATCHUP_HOURS`` hours (default 3,
  0 disables, at most 6) and whose slot has no evidence of a run is due now. A late or lost cron heals itself.
* **Once per slot.** A channel whose slot already has evidence (a video, held or blocked row, a storyboard
  waiting for a person, a run event) is not scheduled again, at its exact hour either. Evidence is the dead-man
  switch's own (``operator_bot.reliability.Evidence``), read through the same helpers, so "a run happened" means
  the same to both.
* **Fail safe.** When that evidence cannot be read, an unknown never starts a run: the exact-hour behaviour is
  exactly what it always was, and a catch-up is NOT started (a paid run must not rest on a guess).

* **Backup ticks.** GitHub guarantees nothing about its cron (over seven weeks about one hourly tick in four was
  delivered, at random minutes, with gaps of up to a day), so ``daily_video.yml`` ticks four times an hour: the
  original ``0 * * * *`` (``PRIMARY_CRON``) and backups. Every tick asks the same questions, so any tick that
  lands in a slot's window finds it. The original tick keeps the exact-hour behaviour it always had, including
  going ahead when the evidence cannot be read. A BACKUP tick never does: it hands a slot out only on positive
  knowledge that the slot is free (readable evidence, none in the slot), exactly as a catch-up does, so an
  outage cannot turn four ticks an hour into four runs. At most once per slot is unchanged: the evidence check
  here, the concurrency group of the slot and the guard in the run (``tools/slot_guard.py``).

What this cannot see, said plainly: a run that is still rendering has written no row yet. The workflow therefore
serialises runs of one channel and slot (``concurrency`` in daily_video.yml) and re-asks this question in the run
itself (``tools/slot_guard.py``) once it holds the group, which is after the first run has finished and written
its row. A run that died before writing any row leaves no trace here, so the next hourly run inside the window
tries again; that retry is the catch-up working, and ``NIGHTSHIFT_CATCHUP_HOURS=0`` turns it off. A retry is a fresh run (the scheduled run
does not pass ``--resume``), so it pays again: with more ticks and a wider window the number of retries is CAPPED per
slot (``NIGHTSHIFT_SLOT_MAX_ATTEMPTS``, default 2, at most 4; ``claim_attempt``), enforced by the resolver and again
by the guard in the run (see docs/VIDEO_GO_LIVE.md section 9).
"""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timedelta, timezone

CATCHUP_ENV = "NIGHTSHIFT_CATCHUP_HOURS"
#: Three hours: GitHub delivered about one hourly tick in four over seven weeks of this repo's own history, and with
#: one hour of catch-up under half of all slots had a tick in their window (three hours: about four in five; six:
#: about 24 in 25). A late run publishes at an odd hour, which is acceptable for a private-first video; it spends
#: no more than the slot's own run would (one per channel and slot, and the evidence check below stops a second).
#: The price of a wider window is more retries of a run that died before it wrote any row (an OOM, a timeout, a
#: provider outage), which this module cannot tell from "never started"; 0 switches the catch-up off, 6 is the cap.
DEFAULT_CATCHUP_HOURS = 3
MAX_CATCHUP_HOURS = 6
#: The cron entry that has always been in daily_video.yml. Its tick is the one that may start the exact hour when the
#: evidence cannot be read; every other entry is a backup (tests/test_schedule_workflow.py pins the workflow to this).
PRIMARY_CRON = "0 * * * *"
#: Words that plainly mean "off". Anything else that is not a number is garbage and gets the default.
_OFF_WORDS = frozenset({"off", "false", "no", "none", "disabled", "disable"})

WORKED, UNWORKED, UNKNOWN = "worked", "unworked", "unknown"

# -- the attempt cap -----------------------------------------------------------------------------------------------
#: A scheduled slot may START the pipeline at most this many times (a run that wrote no video, held or blocked row
#: is otherwise retried by every later tick in the window, and a retry is a fresh run that pays again).
ATTEMPT_ENV = "NIGHTSHIFT_SLOT_MAX_ATTEMPTS"
DEFAULT_MAX_ATTEMPTS = 2
MAX_MAX_ATTEMPTS = 4
#: Minimum minutes between two attempts of one slot (since the previous claim's time). Without it a dead credential or
#: a provider outage burns every attempt within one tick or two (ticks are 15 minutes apart) and the slot is dead
#: before anyone can fix the cause; with it the attempts are spread across the catch-up window.
GAP_ENV = "NIGHTSHIFT_SLOT_MIN_ATTEMPT_GAP_MINUTES"
DEFAULT_ATTEMPT_GAP_MINUTES = 60
MIN_ATTEMPT_GAP_MINUTES, MAX_ATTEMPT_GAP_MINUTES = 10, 180
CLAIMED, DENIED = "claimed", "denied"          # claim_attempt's answers; UNKNOWN is the third
_ATTEMPT_KEY = re.compile(r"slot-attempt:(?P<channel>[a-z0-9][a-z0-9-]{1,38}):(?P<slot>[0-9TZ:-]{20}):(?P<n>[1-9])")
_ATTEMPT_ROWS_LIMIT = 1000


def warn(message: str) -> None:
    """Said the way list_channels says everything: plain for the log, ``::warning::`` for the run summary."""
    print(f"warning: {message}", file=sys.stderr)
    print(f"::warning::{message}", file=sys.stderr)


def catchup_hours(env=None, say=warn) -> int:
    """How many hours after its slot a channel may still be caught up. 0 = off.

    Unset or empty is the default. ``off``/``false``/``no`` mean 0. A number above the maximum is clamped to it
    and a value that is not a whole number (or is negative) is the default, each with a warning that never echoes
    the value: a typo is noticed rather than quietly obeyed."""
    raw = str((os.environ if env is None else env).get(CATCHUP_ENV, "") or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        raw = raw[1:-1].strip()
    if raw == "":
        return DEFAULT_CATCHUP_HOURS
    if raw.lower() in _OFF_WORDS:
        return 0
    try:
        value = int(raw)
    except ValueError:
        value = None
    if value is None or value < 0:
        say(f"{CATCHUP_ENV} is not a whole number of hours - using the default of {DEFAULT_CATCHUP_HOURS}. "
            f"Use 0 to switch the catch-up off, or 1-{MAX_CATCHUP_HOURS}.")
        return DEFAULT_CATCHUP_HOURS
    if value > MAX_CATCHUP_HOURS:
        say(f"{CATCHUP_ENV} is above the maximum - using {MAX_CATCHUP_HOURS}.")
        return MAX_CATCHUP_HOURS
    return value


def is_backup_tick(cron) -> bool:
    """Is this scheduled tick one of the backups? ``cron`` is the cron entry that fired (``github.event.schedule``):
    None means the run is not a scheduled tick at all (a test, a direct call), which is the original behaviour.
    Anything that is not exactly the original entry, an empty value included, is a backup: when in doubt a tick
    needs positive knowledge before it starts a paid run."""
    if cron is None:
        return False
    return str(cron).strip() != PRIMARY_CRON


def reference_hour(now: datetime, due_hour: int) -> datetime:
    """The start of the most recent UTC hour equal to ``due_hour`` that is not after ``now``. The workflow reads
    the hour with ``date -u`` and this module reads the clock a moment later; if the hour turned in between, the
    hour the workflow asked about is still the one that is meant."""
    now = now.astimezone(timezone.utc)
    ref = now.replace(minute=0, second=0, microsecond=0)
    return ref - timedelta(hours=(ref.hour - due_hour) % 24)


def lateness(due_hour: int, slot_hour: int) -> int:
    """Whole hours between a channel's slot hour and the hour being resolved (0 = its exact hour)."""
    return (due_hour - slot_hour) % 24


def _no_http(url, headers, timeout):
    """OperatorSources can ask GitHub for the run list; the scheduler must not, and does not need to."""
    return None, None


def read_evidence(sync, now: datetime):
    """The dead-man's ``Evidence`` over Supabase, or None when Supabase is not configured at all (a local run,
    a test): there is then nothing to read and nothing to say. Reads only; never raises (an unreadable source
    shows up as ``ev.known`` False, which the verdicts below treat as an unknown)."""
    if sync is None or not getattr(sync, "enabled", False):
        return None
    from modules.operator_bot.config import OperatorConfig
    from modules.operator_bot.reliability import Evidence
    from modules.operator_bot.sources import OperatorSources

    ops = OperatorSources(sync, _no_http, OperatorConfig.from_env(), now=lambda: now)
    return Evidence(ops, now)


def slot_state(ev, channel_id: str, start: datetime) -> str:
    """``worked`` (evidence inside the slot), ``unworked`` (every source answered and none has any) or
    ``unknown``. Positive evidence counts even when another source failed; absence counts only when the whole
    reading is complete and the channel is one the reading covered."""
    from modules.operator_bot.reliability import slot_worked

    if ev is None:
        return UNKNOWN
    if slot_worked(ev.stamps(channel_id), start):
        return WORKED
    if not ev.known or channel_id not in {c.channel_id for c in ev.sched}:
        return UNKNOWN
    return UNWORKED


def was_expected(ev, channel_id: str, start: datetime) -> bool:
    """Was this slot ever the channel's to produce? Not when the channel was created or edited after the slot
    began and has produced nothing (the dead-man's rule): switching a channel on, or changing its hour, at 15:30
    must not start the 14:00 slot that passed before the change."""
    from modules.operator_bot.reliability import due

    for c in ev.sched:
        if c.channel_id == channel_id:
            return due(c, start, ev.stamps(channel_id))
    return False


# -- attempts: the durable "a scheduled run started" record --------------------------------------------------------

def max_attempts(env=None, say=warn) -> int:
    """How many scheduled attempts one channel slot may have. Unset or empty is 2; a value that is not a whole number
    of 1 or more (0 and negatives included: "no cap" is not an option) is 2 with a warning that never echoes it;
    above 4 is 4 with a warning."""
    raw = str((os.environ if env is None else env).get(ATTEMPT_ENV, "") or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        raw = raw[1:-1].strip()
    if raw == "":
        return DEFAULT_MAX_ATTEMPTS
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value < 1:
        say(f"{ATTEMPT_ENV} is not a whole number of attempts from 1 to {MAX_MAX_ATTEMPTS} - "
            f"using the default of {DEFAULT_MAX_ATTEMPTS}.")
        return DEFAULT_MAX_ATTEMPTS
    if value > MAX_MAX_ATTEMPTS:
        say(f"{ATTEMPT_ENV} is above the maximum - using {MAX_MAX_ATTEMPTS}.")
        return MAX_MAX_ATTEMPTS
    return value


def slot_iso(start: datetime) -> str:
    return start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def attempt_key(channel_id: str, start: datetime, n: int) -> str:
    """The primary key of attempt ``n`` of a slot in ``system_events``: claiming a number is inserting its key, and
    the database lets exactly one inserter win, so two jobs can never both hold the same attempt."""
    return f"slot-attempt:{channel_id}:{slot_iso(start)}:{n}"


def attempt_gap(env=None, say=warn) -> timedelta:
    """Minimum time between two attempts of one slot. Unset or empty is 60 minutes; a value that is not a whole number
    is the default with a warning that never echoes it; a number outside 10..180 is clamped to the nearest bound,
    also with a warning."""
    raw = str((os.environ if env is None else env).get(GAP_ENV, "") or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        raw = raw[1:-1].strip()
    if raw == "":
        return timedelta(minutes=DEFAULT_ATTEMPT_GAP_MINUTES)
    try:
        value = int(raw)
    except ValueError:
        say(f"{GAP_ENV} is not a whole number of minutes - using the default of {DEFAULT_ATTEMPT_GAP_MINUTES}.")
        return timedelta(minutes=DEFAULT_ATTEMPT_GAP_MINUTES)
    if not MIN_ATTEMPT_GAP_MINUTES <= value <= MAX_ATTEMPT_GAP_MINUTES:
        say(f"{GAP_ENV} is outside {MIN_ATTEMPT_GAP_MINUTES}-{MAX_ATTEMPT_GAP_MINUTES} - using the nearest limit.")
        value = min(max(value, MIN_ATTEMPT_GAP_MINUTES), MAX_ATTEMPT_GAP_MINUTES)
    return timedelta(minutes=value)


def parse_ts(raw, fallback: datetime) -> datetime:
    """A ``system_events.ts`` as a UTC time. The column is text and the rows mix naive ``isoformat()`` strings
    (the mirror's) with ``...Z`` ones (the attempt claims'): both are UTC. A value that cannot be read is
    ``fallback``, which callers pass as "now", so it counts as JUST CLAIMED (fail-closed)."""
    try:
        t = datetime.fromisoformat(str(raw).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return fallback
    return t.replace(tzinfo=timezone.utc) if t.tzinfo is None else t.astimezone(timezone.utc)


def read_attempts(sync, now: datetime):
    """``{(channel_id, slot iso): (attempts so far, time of the latest claim)}`` for the last 48 hours, or None when
    it cannot be told (Supabase not configured, a failed read, or a read that hit its row limit and may have cut
    rows). A claim whose time cannot be read counts as made just now. Reads only; never raises. An unknown is
    not zero: callers that would start a paid run on it do not."""
    if sync is None or not getattr(sync, "enabled", False):
        return None
    from modules.event_log import SLOT_ATTEMPT

    since = (now - timedelta(hours=48)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        rows = sync.select_strict("system_events", {
            "select": "event_key,channel_id,ts", "event": f"eq.{SLOT_ATTEMPT}", "ts": f"gte.{since}",
            "limit": str(_ATTEMPT_ROWS_LIMIT)})
    except Exception:  # noqa: BLE001 - an unreadable source is an unknown
        return None
    if len(rows) >= _ATTEMPT_ROWS_LIMIT:
        return None
    out: dict = {}
    for r in rows:
        m = _ATTEMPT_KEY.fullmatch(str(r.get("event_key") or ""))
        if m:
            key = (m["channel"], m["slot"])
            n, last = out.get(key, (0, None))
            when = parse_ts(r.get("ts"), now)
            out[key] = (n + 1, when if last is None or when > last else last)
    return out


def attempts_used(attempts, channel_id: str, start: datetime):
    """Attempts the slot has used, or None when ``attempts`` (read_attempts) is unknown."""
    return None if attempts is None else attempts.get((channel_id, slot_iso(start)), (0, None))[0]


def gap_passed(attempts, channel_id: str, start: datetime, now: datetime, gap: timedelta):
    """Has the minimum gap passed since the slot's latest attempt? True when it has none; None when the attempts are
    unknown. A latest claim in the future of ``now`` (clock skew) has not passed."""
    if attempts is None:
        return None
    n, last = attempts.get((channel_id, slot_iso(start)), (0, None))
    return True if not n or last is None else now - last >= gap


def claim_attempt(sync, channel_id: str, start: datetime, cap: int, now: datetime):
    """Take the next attempt number of a slot, atomically. Returns ``(CLAIMED, n)``, ``(DENIED, cap)`` when the slot
    has used all its attempts, or ``(UNKNOWN, 0)`` when the claim could not be made (not configured, a failed
    write): then nothing is known to have been recorded. Never raises.

    The row is closed: event name, key, time, channel, and metadata with the slot start, the attempt number and the cap.
    No script, title, prompt or person."""
    if sync is None or not getattr(sync, "enabled", False):
        return UNKNOWN, 0
    from modules.event_log import SLOT_ATTEMPT

    stamp = now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        for n in range(1, cap + 1):
            row = {"event_key": attempt_key(channel_id, start, n), "event": SLOT_ATTEMPT, "ts": stamp,
                   "channel_id": channel_id, "metadata": {"slot_start": slot_iso(start), "attempt": n, "cap": cap}}
            got = sync.insert_new("system_events", [row], on_conflict="event_key")
            if got is None:
                return UNKNOWN, 0
            if got:
                return CLAIMED, n
        return DENIED, cap
    except Exception:  # noqa: BLE001
        return UNKNOWN, 0
