#!/usr/bin/env python3
"""Emit the channels a scheduled run should cover, as a GitHub Actions matrix.

    python tools/list_channels.py --due-hour 15
    -> {"include": [{"channel_id": "default", "name": "Nightshift", "niche": "..."}]}

The daily workflow calls this once, then fans out one job per returned channel
with ``fail-fast: false``, so a credential failure on one channel cannot cancel
another channel's video.

Three safety properties matter here:

* **It never returns a PAUSED channel.** `ChannelRegistry.active()` filters on
  status AND schedule.enabled, so pausing a channel in the Command Center is
  what actually stops it being scheduled.
* **It schedules only the operator's own channels.** A scheduled run carries
  no credit hold, so the operator pays for it. A customer organization's
  channel runs when the Command Center names it (``--only``) together with the
  reservation that pays for it, never on the schedule.
* **A registry that raises still fails open.** If the registry (or the cheap
  preflight read of the `channels` table, see ``_preflight``) raises, it falls
  back to the default channel — the single channel this bot has always
  published — rather than emitting an empty matrix that would silently stop
  production. That is the owner's documented choice and it is loud (stderr
  warning plus an Actions ``::warning::`` annotation, exception type only).
  Reversing it to fail-closed is an owner decision, not made here.
* **Pausing means pausing.** A registry that LOADED and has no operator channel
  active (every one paused, or its schedule off) is an operator decision, so
  the matrix is empty on purpose. Before this, that case re-added the legacy
  ``default`` channel (Chronos, the operator's test channel), so pausing Chronos
  in the Command Center never stopped a scheduled run.

Known limit, said plainly: ``ChannelRegistry`` itself never raises on a Supabase
outage. ``_load_from_supabase`` (and ``SupabaseSync.select``) swallow the error
and return no rows, and ``_load`` then synthesizes ``default`` as ACTIVE. So
without the preflight an outage looks like "an empty table", and a channel pause
stored in the database is invisible while Supabase is down. The preflight makes
that outage loud; only ``NIGHTSHIFT_PIPELINE_PAUSED`` actually stops it.

``NIGHTSHIFT_PIPELINE_PAUSED`` (repo variable, see docs/VIDEO_GO_LIVE.md) pauses
the scheduled operator runs (its meaning is modules/pipeline_pause.py, shared with the
operator bot and the doctor, so they cannot drift). It is an environment variable and not a database
flag on purpose: it must still work when Supabase is the thing that is down.
It does not stop manual runs, the Command Center, paid API runs, the queue
worker, or a run already in progress.

`--due-hour` filters to channels whose `schedule.publish_hour_utc` matches. A
channel with no hour set is treated as due at the default 15:00 UTC slot, which
is when the workflow has always run.

Catch-up and once-per-slot (modules/schedule_catchup.py): GitHub's cron can be
late or drop a run, which used to skip a channel's whole day. With ``--due-hour``
a channel is ALSO due when its slot hour passed within the last
``NIGHTSHIFT_CATCHUP_HOURS`` hours (default 3, 0 = off, max 6) and its slot has
no evidence of a run; a channel whose slot already has evidence is not scheduled
again, at its exact hour either. Evidence is the dead-man switch's own, read from
Supabase. It can only REDUCE or LATE-START work, never add publishing power (the
schedule still forces ``--privacy private``), and it never overrides a pause: the
global switch returns before any of it, only channels ``registry.active()`` already
let through are candidates, and an unreadable registry (the default-channel
fallback) gets no catch-up. When the evidence cannot be read an unknown starts
nothing: the exact hour behaves as it always did, a catch-up does not happen, and a
``::warning::`` says so.

Backup ticks: the workflow ticks several times an hour because GitHub drops most cron ticks (see
modules/schedule_catchup.py). ``--tick <cron>`` names the cron entry that fired; any entry other than the original
``0 * * * *`` is a BACKUP, and a backup tick never starts anything on an unknown: at its exact hour it hands out a
slot only on readable evidence that the slot is free (as a catch-up does), and with an unreadable registry it hands
out nothing. The original tick behaves exactly as before.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.channel_credentials import env_var_name  # noqa: E402
from modules import schedule_catchup  # noqa: E402
from modules.channels import DEFAULT_CHANNEL_ID, ChannelRegistry, legacy_default_channel  # noqa: E402
# The pause semantics live in one module the operator bot and the doctor read too, so they cannot drift.
from modules.pipeline_pause import PAUSE_ENV, pipeline_paused  # noqa: E402,F401

DEFAULT_HOUR_UTC = 15


def _preflight(sync=None) -> None:
    """Make a Supabase outage loud. Raises when the `channels` read fails.

    ``ChannelRegistry`` swallows a failed read and falls back to a synthesized
    ``default``; this read is strict so the outage is seen. Skipped when
    Supabase is not configured (local runs, tests), where there is nothing to
    read and "no rows" is the honest answer, except in GitHub Actions: there
    the scheduled run MEANS to read the pauses stored in the database, so an
    unset secret is said, because every pause set in the Command Center is
    invisible to it (the fallback is the default channel, fail-open).

    An EMPTY ``channels`` table is said too: migration 0001 seeds ``default``,
    so no rows almost always means the secrets point at the wrong project.
    Scheduling is unchanged (fail-open to the default channel); this only makes
    the likely mistake visible. Both warnings go to stderr, never to the matrix.
    """
    if sync is None:
        from modules.supabase_sync import SupabaseSync

        sync = SupabaseSync()
    if not getattr(sync, "enabled", False):
        if os.environ.get("GITHUB_ACTIONS"):
            print("::warning::Supabase is not configured - channel pauses cannot be read", file=sys.stderr)
        return
    if not sync.select_strict("channels"):
        msg = (
            "the channels table is EMPTY - migration 0001 seeds 'default', so SUPABASE_URL probably points at the "
            "wrong project. Channel pauses stored in the database are not being read; scheduling falls back to "
            "the default channel."
        )
        print(f"warning: {msg}", file=sys.stderr)
        print(f"::warning::{msg}", file=sys.stderr)


def _hour(c) -> int:
    return c.schedule.publish_hour_utc if c.schedule.publish_hour_utc is not None else DEFAULT_HOUR_UTC


def _slot_row(c, start: datetime, catchup: bool) -> dict:
    """A matrix row plus the slot it is for. ``slot_date`` names the concurrency group (one channel, one slot,
    one run at a time) and ``slot_start``/``catchup`` go to tools/slot_guard.py, which asks again once the run
    holds the group."""
    row = _row(c)
    row["slot_start"] = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    row["slot_date"] = start.strftime("%Y-%m-%d")
    row["catchup"] = catchup
    return row


def _scheduled_rows(channels, due_hour: int, now, evidence, evidence_sync, window: int,
                    backup: bool = False, attempts=None, cap: int | None = None) -> list[dict]:
    """The rows for one hour: each channel at its exact hour, plus the ones inside the catch-up window, minus the
    slots that already have evidence. See modules/schedule_catchup.py for why an unknown starts nothing. A BACKUP
    tick's exact-hour row is strict like a catch-up's (``catchup`` True: the guard in the run also needs readable
    evidence), and an unknown there starts nothing.

    The attempt cap (``NIGHTSHIFT_SLOT_MAX_ATTEMPTS``) is applied here too: a slot that has used its attempts is not
    handed out, whatever tick asks. ``attempts`` is ``schedule_catchup.read_attempts`` (None = unknown, the default
    reads it with ``evidence_sync``). An unknown count starts no catch-up and no backup tick's run; the original
    tick's exact hour goes ahead as it always did and the guard in the run then claims the attempt."""
    now = now or datetime.now(timezone.utc)
    cap = schedule_catchup.max_attempts() if cap is None else cap
    gap = schedule_catchup.attempt_gap()
    ref = schedule_catchup.reference_hour(now, due_hour)
    candidates = []
    for c in channels:
        late = schedule_catchup.lateness(due_hour, _hour(c))
        if late == 0 or 1 <= late <= window:
            candidates.append((c, late))
    if not candidates:
        return []

    ev, configured = evidence, evidence is not None
    if ev is None:
        if evidence_sync is None:
            from modules.supabase_sync import SupabaseSync

            evidence_sync = SupabaseSync()
        configured = bool(getattr(evidence_sync, "enabled", False))   # not configured = a local run: nothing to say
        try:
            ev = schedule_catchup.read_evidence(evidence_sync, now)
        except Exception as e:  # noqa: BLE001 - an unreadable source is an unknown, never a stop
            schedule_catchup.warn(f"slot evidence UNREADABLE ({type(e).__name__}) - treating every slot as unknown.")

    if attempts is None:
        if evidence_sync is None:
            from modules.supabase_sync import SupabaseSync

            evidence_sync = SupabaseSync()
        attempts = schedule_catchup.read_attempts(evidence_sync, now)

    rows, unknown_exact, unknown_late = [], [], []
    for c, late in candidates:
        cid, start = str(c.channel_id), ref - timedelta(hours=late)
        state = schedule_catchup.slot_state(ev, cid, start)
        used = schedule_catchup.attempts_used(attempts, cid, start)
        if state == schedule_catchup.WORKED:
            print(f"note: {cid} already has a run for its {start:%Y-%m-%d %H}:00 UTC slot - not scheduled again",
                  file=sys.stderr)
        elif used is not None and used >= cap:
            print(f"note: {cid} slot {start:%Y-%m-%d %H}:00 UTC used its {used} attempt(s) and has no video - "
                  "not scheduled again (run it by hand)", file=sys.stderr)
        elif schedule_catchup.gap_passed(attempts, cid, start, now, gap) is False:
            print(f"note: {cid} slot {start:%Y-%m-%d %H}:00 UTC had an attempt less than {int(gap.total_seconds() // 60)} "
                  "minutes ago and no video - waiting before another", file=sys.stderr)
        elif late == 0 and not backup:
            if state == schedule_catchup.UNKNOWN or used is None:
                unknown_exact.append(cid)
            rows.append(_slot_row(c, start, False))      # the exact hour, as it has always been
        elif state == schedule_catchup.UNKNOWN or used is None:
            unknown_late.append(cid)
        elif late == 0:
            # A backup tick at the exact hour: a free slot, readable evidence, and a slot that was ever the channel's
            # to produce (the dead-man's rule, as for a catch-up): a channel created or edited at 22:30 with hour 22
            # must not get an unplanned paid run from the 22:45 backup tick.
            if schedule_catchup.was_expected(ev, cid, start):
                rows.append(_slot_row(c, start, True))
        elif schedule_catchup.was_expected(ev, cid, start):
            print(f"note: {cid} missed its {start:%Y-%m-%d %H}:00 UTC slot ({late}h ago) - catching up",
                  file=sys.stderr)
            rows.append(_slot_row(c, start, True))
    if configured and unknown_exact:
        schedule_catchup.warn(
            "run evidence or attempt count UNREADABLE for " + ", ".join(unknown_exact) + " - running at the exact hour as usual; "
            "a run already made for this slot cannot be seen.")
    if configured and unknown_late:
        schedule_catchup.warn(
            "run evidence or attempt count UNREADABLE for " + ", ".join(unknown_late) + " - NOT catching up (an unknown must "
            "not start a paid run).")
    # The exact hour is the schedule; a catch-up is the exception. If a run is cut short, the schedule's own
    # channels (matrix order is run order, max-parallel 1) have already had their turn.
    return sorted(rows, key=lambda r: r["catchup"])


def due_channels(due_hour: int | None = None, registry=None, sync=None, now=None, evidence=None,
                 evidence_sync=None, backup_tick: bool = False, attempts=None) -> list[dict]:
    """``sync`` is only the registry preflight's. The slot evidence comes from ``evidence`` (an already-read
    ``reliability.Evidence``, for tests) or is read with ``evidence_sync`` (default: Supabase from the environment).
    ``backup_tick`` marks a scheduled tick that is not the original cron entry (see the module docstring)."""
    if pipeline_paused():
        print(f"note: pipeline paused by {PAUSE_ENV} — nothing is scheduled", file=sys.stderr)
        return []

    fell_back = False
    try:
        if registry is None:
            _preflight(sync)
            registry = ChannelRegistry()
        channels = registry.active()
    except Exception as e:
        # Only the exception TYPE: a message from a failed Supabase call can carry
        # a URL or a key fragment, and this goes into the workflow log.
        msg = (
            f"channel registry UNREADABLE ({type(e).__name__}) - FALLING BACK to the "
            "legacy default channel 'default'. Pausing a channel in the Command Center does NOT "
            f"stop this run while the registry is unreadable; set {PAUSE_ENV}=true to stop it."
        )
        print(f"warning: {msg}", file=sys.stderr)
        print(f"::warning::{msg}", file=sys.stderr)
        channels = [legacy_default_channel()]
        fell_back = True

    # A scheduled run carries no credit hold, so it is the operator's to pay
    # for: only the operator's own channels are scheduled. A customer's channel
    # runs when the Command Center names it (--only) with the hold that pays
    # for it. Before this, a customer who set their verified channel ACTIVE got
    # a daily video on the operator's runner and provider keys, uncharged.
    customers = [c for c in channels if not c.is_operators]
    if customers:
        print(
            "note: not scheduling "
            + ", ".join(str(c.channel_id) for c in customers)
            + " — a customer organization's channel runs only when started from the Command Center, "
            "which reserves the credits that pay for it.",
            file=sys.stderr,
        )
    channels = [c for c in channels if c.is_operators]

    if not channels:
        # The registry loaded and no operator channel is active: someone paused
        # them all (or switched their schedules off). That is a decision, so the
        # matrix is empty on purpose — re-adding `default` here made Chronos
        # impossible to pause.
        print("note: all operator channels paused — nothing is scheduled", file=sys.stderr)
        return []

    if due_hour is None:
        start = (now or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
        return [_slot_row(c, start, False) for c in channels]

    if fell_back and backup_tick:
        # A guess is not positive knowledge: only the original tick may act on it, so four ticks an hour cannot
        # become four runs while the registry is down.
        print("note: registry unreadable - a backup tick starts nothing (the original hourly tick still does)",
              file=sys.stderr)
        return []
    if fell_back:
        # The fallback channel is a guess, not a schedule: exactly the old behaviour, no catch-up and no evidence
        # read (a Supabase that cannot serve the registry is not going to serve that either).
        start = schedule_catchup.reference_hour(now or datetime.now(timezone.utc), due_hour)
        return [_slot_row(c, start, False) for c in channels if _hour(c) == due_hour]
    return _scheduled_rows(channels, due_hour, now, evidence, evidence_sync, schedule_catchup.catchup_hours(),
                           backup_tick, attempts)


def _row(c) -> dict:
    """One matrix entry.

    `token_secret` is the name of the GitHub secret holding THIS channel's
    YouTube token, derived by the same function the publishing side uses to
    read it (``channel_credentials.env_var_name``) so the two cannot drift.
    The workflow indexes ``secrets[...]`` with it, which is what lets a channel
    upload to its own account instead of the default channel's.

    It is a secret *name*, never a value: nothing secret is emitted here, and
    this output is printed into the workflow log.
    """
    operators = bool(getattr(c, "is_operators", False))
    return {
        "channel_id": str(c.channel_id),
        "name": c.name,
        "niche": c.niche,
        # The legacy default (YOUTUBE_TOKEN_JSON) is the operator's own channel only: a customer
        # channel carrying the id `default` is never it (BR-L-110).
        "is_default": operators and str(c.channel_id) == str(DEFAULT_CHANNEL_ID),
        # Does the operator's own organization own it? Only these channels may
        # read a token from the worker's environment (BR-G-002); everyone
        # else's token is their own Vault connection.
        "is_operators": operators,
        # A secret name only for the operator's own channels. A customer
        # channel's id can normalise to the name of an operator's secret
        # (BR-L-080), so no name is ever emitted for it and the workflow's
        # token step does not run for it.
        "token_secret": env_var_name(c) if operators else "",
    }


_TOKEN_SECRET = re.compile(r"CHRONOS_YT_TOKEN_[A-Z0-9_]+")


def token_rows(registry=None, sync=None) -> list[dict]:
    """The scheduled operator channels whose YouTube token the doctor must prove: ``channel_id`` and the NAME of
    the secret holding the token, from the function the publishing side reads it with
    (``channel_credentials.env_var_name``), so the two cannot drift.

    Active, schedule-enabled channels of the operator's own organization, other than the legacy default (its
    token is ``YOUTUBE_TOKEN_JSON`` and the doctor proves that one already). A customer's token is its Vault
    connection, never a secret here. Names only: nothing secret is read or returned. Raises when the registry is
    unreadable (the same strict read ``due_channels`` uses), so an outage is never mistaken for "no channels"."""
    if registry is None:
        _preflight(sync)
        registry = ChannelRegistry()
    return [
        {"channel_id": str(c.channel_id), "token_secret": env_var_name(c)}
        for c in registry.active()
        if c.is_operators and str(c.channel_id) != str(DEFAULT_CHANNEL_ID)
    ]


def token_slot_lines(slots: int, registry=None, sync=None) -> list[str]:
    """``KEY=value`` lines for ``$GITHUB_OUTPUT``: ``rows`` (the whole list as one line of JSON) and ``name0`` ..
    ``name<slots-1>`` (the first channels' secret names, blank when there is no such channel). The doctor
    workflow indexes ``secrets[...]`` with the names, because Actions cannot enumerate secrets; a name is a
    ``CHRONOS_YT_TOKEN_<REF>`` string or blank, never a value."""
    rows = token_rows(registry=registry, sync=sync)
    names = [r["token_secret"] if _TOKEN_SECRET.fullmatch(r["token_secret"]) else "" for r in rows[:slots]]
    names += [""] * (slots - len(names))
    return ["rows=" + json.dumps(rows, separators=(",", ":"))] + [f"name{i}={n}" for i, n in enumerate(names)]


def resolve_only(channel_id: str, registry=None) -> dict:
    """The matrix row for one explicitly named channel, or an error.

    An operator naming a channel outranks its schedule — but not its existence:
    an unknown id raises (KeyError) rather than resolving to whichever channel
    happens to be first. Nor its verification: naming a channel by hand must not
    be the way around the check, or the check is decoration — the dispatch
    dropdown lists every channel, drafts included (ValueError).

    Shared by the workflow's ``--only`` and the queue worker
    (tools/queue_worker.py), so both refuse the same channels for the same
    reason and both read the token from the same secret name.
    """
    c = (registry or ChannelRegistry()).get(channel_id)
    if not c.is_verified:
        raise ValueError(
            f"channel {channel_id!r} has never been confirmed against YouTube. "
            "Open it in the Command Center and confirm the channel before running it."
        )
    return _row(c)


def _warn_about_shared_voices() -> None:
    """Say so when two channels narrate in the same ElevenLabs voice.

    Not fatal — the videos still render, and stopping production over a
    cosmetic collision would be the wrong trade. But two channels in one voice
    sound like one channel with two names, and nothing else in the system would
    ever mention it.
    """
    try:
        collisions = ChannelRegistry().voice_collisions()
    except Exception:
        return
    for voice, ids in collisions.items():
        print(
            f"warning: ElevenLabs voice {voice} is used by {', '.join(ids)} — "
            "give each channel its own voice so they do not sound identical.",
            file=sys.stderr,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="List channels due for a scheduled run")
    parser.add_argument("--due-hour", type=int, default=None, help="Only channels scheduled at this UTC hour")
    parser.add_argument("--all", action="store_true", help="Every channel, including PAUSED ones")
    parser.add_argument("--tick", default=None, metavar="CRON",
                        help="With --due-hour: the cron entry that fired (github.event.schedule). Any entry other "
                             "than the original hourly one is a backup tick, which never starts a run on an unknown")
    parser.add_argument("--only", default=None,
                        help="Exactly this channel, whatever its schedule (an explicit manual run)")
    parser.add_argument("--token-slots", type=int, default=None, metavar="N",
                        help="Print GITHUB_OUTPUT lines (rows, name0..nameN-1) naming the token secrets of the "
                             "scheduled operator channels, for the scheduled doctor")
    args = parser.parse_args()

    if args.token_slots is not None:
        try:
            lines = token_slot_lines(args.token_slots)
        except Exception as e:
            # Exception type only: a failed Supabase call can carry a URL or a key fragment. Empty rows tell the
            # doctor "could not be listed" (a warning), which is not the same as "no channels".
            msg = f"channel registry UNREADABLE ({type(e).__name__}) - the doctor cannot name the scheduled channels' token secrets."
            print(f"warning: {msg}", file=sys.stderr)
            print(f"::warning::{msg}", file=sys.stderr)
            lines = ["rows="] + [f"name{i}=" for i in range(args.token_slots)]
        print("\n".join(lines))
        return 0

    if args.only:
        try:
            row = resolve_only(args.only)
        except (KeyError, ValueError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        row.update(slot_start=start.strftime("%Y-%m-%dT%H:%M:%SZ"), slot_date=start.strftime("%Y-%m-%d"),
                   catchup=False)
        print(json.dumps({"include": [row]}))
        return 0

    if args.all:
        rows = [
            {"channel_id": str(c.channel_id), "name": c.name, "niche": c.niche,
             "status": c.status, "verified": c.is_verified}
            for c in ChannelRegistry().list()
        ]
    else:
        rows = due_channels(args.due_hour, backup_tick=schedule_catchup.is_backup_tick(args.tick))
        if rows:  # nothing scheduled (paused) is not worth another Supabase read
            _warn_about_shared_voices()

    print(json.dumps({"include": rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
