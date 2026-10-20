#!/usr/bin/env python3
"""Ask, inside the run, whether this channel's slot has already been worked. Exit 3 = skip, 0 = go.

    python tools/slot_guard.py --channel default --slot-start 2026-10-20T15:00:00Z [--catchup]

daily_video.yml's ``resolve`` job decides which channels to run, but a job then waits in the
``concurrency`` group of its channel and slot (one run at a time), and by the time it holds the group
the run that was ahead of it has finished and written its video, held or blocked row. Asking again here,
once, before ``main.py`` spends anything, is what turns "serialised" into "not run twice". Only the
SCHEDULE calls this: a manual dispatch that names a channel is an explicit instruction and always runs.

A job that waited in the group can start up to an hour after the resolver chose it, so the guard first asks
again what the resolver asked: is the pipeline paused (``NIGHTSHIFT_PIPELINE_PAUSED``, fails closed) and is the
channel still ACTIVE, schedule on, verified and the operator's own. Either no -> exit 3, whatever the kind of run.
An unreadable registry is an unknown (below), not a no.

The answer then comes from the dead-man switch's evidence (modules/schedule_catchup.py):

* evidence in the slot            -> exit 3, nothing is spent;
* every source answered, none     -> exit 0, the run goes ahead;
* a source could not be read      -> exit 0 for an exact-hour run (as it has always been), exit 3 for a
  ``--catchup`` run: an unknown must never start a paid catch-up. A ``::warning::`` says which.

The log carries the channel id, the slot time and fixed words, never a title or a message from Supabase.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules import schedule_catchup  # noqa: E402
from tools.list_channels import pipeline_paused  # noqa: E402

GO, SKIP = 0, 3


def still_scheduled(channel_id: str, registry=None):
    """True / False when the registry says whether the scheduler would still run this channel, None when that
    cannot be told (Supabase not configured, or the strict read of ``channels`` failed: the registry itself
    swallows an outage and would synthesize an ACTIVE ``default``, which is not an answer)."""
    try:
        if registry is None:
            from modules.channels import ChannelRegistry, _parse_rows
            from modules.supabase_sync import SupabaseSync

            sync = SupabaseSync()
            if not sync.enabled:
                return None
            # ONE strict read, and the decision is made from exactly those rows (the registry's own parser). A
            # second, forgiving read (``ChannelRegistry()``) that failed between the two requests would leave only
            # the synthesized ``default``, and a channel that is there would read as deleted.
            registry = ChannelRegistry(_parse_rows(sync.select_strict("channels"), source="supabase"))
        c = registry.get(channel_id)
        return bool(c.is_runnable and c.is_operators)
    except KeyError:
        return False                               # absent from the rows the strict read returned: it is gone
    except Exception as e:  # noqa: BLE001 - an unreadable registry is an unknown
        schedule_catchup.warn(f"slot guard: the schedule of {channel_id} could not be read ({type(e).__name__}).")
        return None


def decide(channel_id: str, slot_start: str, catchup: bool, sync=None, now=None, evidence=None,
           registry=None) -> int:
    if pipeline_paused():
        print(f"{channel_id}: the pipeline is paused (NIGHTSHIFT_PIPELINE_PAUSED) - nothing was run or spent.")
        return SKIP
    scheduled = still_scheduled(channel_id, registry)
    if scheduled is False:
        print(f"{channel_id}: the channel is no longer scheduled (paused, schedule off or not verified) - "
              "nothing was run or spent.")
        return SKIP
    if scheduled is None and catchup:
        return SKIP                                # an unknown never starts a catch-up (already said, if it was read)

    start = None
    try:
        start = datetime.fromisoformat(str(slot_start).replace("Z", "+00:00"))
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    if start is None:
        schedule_catchup.warn("slot guard: the slot start is not a time - " + ("not running a catch-up." if catchup
                              else "running at the exact hour as usual."))
        return SKIP if catchup else GO

    now = now or datetime.now(timezone.utc)
    configured = True
    try:
        ev = evidence
        if ev is None:
            if sync is None:
                from modules.supabase_sync import SupabaseSync

                sync = SupabaseSync()
            configured = bool(getattr(sync, "enabled", False))
            ev = schedule_catchup.read_evidence(sync, now)
        state = schedule_catchup.slot_state(ev, channel_id, start)
    except Exception as e:  # noqa: BLE001 - a broken guard is an unknown, never a crash
        schedule_catchup.warn(f"slot guard: evidence UNREADABLE ({type(e).__name__}).")
        state = schedule_catchup.UNKNOWN
        configured = False                                   # already said

    if state == schedule_catchup.WORKED:
        print(f"{channel_id}: the {start:%Y-%m-%d %H}:00 UTC slot already has a run - nothing to do.")
        return SKIP
    if state == schedule_catchup.UNKNOWN:
        if configured:
            schedule_catchup.warn(f"slot guard: run evidence UNREADABLE for {channel_id} - "
                                  + ("NOT running a catch-up." if catchup else "running at the exact hour as usual."))
        return SKIP if catchup else GO
    return GO


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Skip a scheduled run whose slot was already worked")
    parser.add_argument("--channel", required=True)
    parser.add_argument("--slot-start", required=True, help="UTC time of the slot, e.g. 2026-10-20T15:00:00Z")
    parser.add_argument("--catchup", action="store_true", help="this run is a catch-up: an unknown means skip")
    args = parser.parse_args(argv)
    return decide(args.channel, args.slot_start, args.catchup)


if __name__ == "__main__":
    raise SystemExit(main())
