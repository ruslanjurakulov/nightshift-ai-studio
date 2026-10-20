"""Catch-up and once-per-slot for the scheduled runs. Reliability only: it adds no publishing power.

Why this exists. ``daily_video.yml`` fires hourly and ``tools/list_channels.py`` picks the channels whose
``publish_hour_utc`` equals the CURRENT UTC hour. GitHub's cron is best effort: a run delayed past the top of the
hour (or dropped) used to skip that channel's whole day, and nothing noticed but the dead-man alert. Two rules
close that, and a third makes them safe to combine:

* **Catch-up.** A channel whose slot hour passed within the last ``NIGHTSHIFT_CATCHUP_HOURS`` hours (default 1,
  0 disables, at most 6) and whose slot has no evidence of a run is due now. A late or lost cron heals itself.
* **Once per slot.** A channel whose slot already has evidence (a video, held or blocked row, a storyboard
  waiting for a person, a run event) is not scheduled again, at its exact hour either. Evidence is the dead-man
  switch's own (``operator_bot.reliability.Evidence``), read through the same helpers, so "a run happened" means
  the same to both.
* **Fail safe.** When that evidence cannot be read, an unknown never starts a run: the exact-hour behaviour is
  exactly what it always was, and a catch-up is NOT started (a paid run must not rest on a guess).

What this cannot see, said plainly: a run that is still rendering has written no row yet. The workflow therefore
serialises runs of one channel and slot (``concurrency`` in daily_video.yml) and re-asks this question in the run
itself (``tools/slot_guard.py``) once it holds the group, which is after the first run has finished and written
its row. A run that died before writing any row leaves no trace here, so the next hourly run inside the window
tries again; that retry is the catch-up working, and ``NIGHTSHIFT_CATCHUP_HOURS=0`` turns it off.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

CATCHUP_ENV = "NIGHTSHIFT_CATCHUP_HOURS"
#: One hour is what a late or dropped cron needs: the next hourly run is the catch-up. A wider window only buys more
#: paid retries of a run that died before it wrote any row (an OOM, a timeout, a provider outage), which this module
#: cannot tell from "never started"; widen it deliberately once the spend guards (CHRONOS_PRICE_*) are set.
DEFAULT_CATCHUP_HOURS = 1
MAX_CATCHUP_HOURS = 6
#: Words that plainly mean "off". Anything else that is not a number is garbage and gets the default.
_OFF_WORDS = frozenset({"off", "false", "no", "none", "disabled", "disable"})

WORKED, UNWORKED, UNKNOWN = "worked", "unworked", "unknown"


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
