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
* **It cannot fail the workflow open.** If the registry raises, it falls back
  to the default channel — the single channel this bot has always published —
  rather than emitting an empty matrix that would silently stop production, or
  every channel it half-read. That fallback is loud, and the global pause
  below still beats it.
* **Pausing means pausing.** A registry that LOADED and has no operator channel
  active (every one paused, or its schedule off) is an operator decision, so
  the matrix is empty on purpose. Before this, that case re-added the legacy
  ``default`` channel (Chronos, the operator's test channel), so pausing Chronos
  in the Command Center never stopped a scheduled run and there was no way to
  stop the whole pipeline. "Cannot read the registry" and "read it, everything
  is paused" are different facts and are handled differently.

``NIGHTSHIFT_PIPELINE_PAUSED`` (repo variable, see docs/VIDEO_GO_LIVE.md) is the
one global switch for scheduled runs. It is an environment variable and not a
database flag on purpose: it must still work when Supabase is the thing that is
down, and it must not depend on the registry that the fallback distrusts.

`--due-hour` filters to channels whose `schedule.publish_hour_utc` matches. A
channel with no hour set is treated as due at the default 15:00 UTC slot, which
is when the workflow has always run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.channel_credentials import env_var_name  # noqa: E402
from modules.channels import DEFAULT_CHANNEL_ID, ChannelRegistry, legacy_default_channel  # noqa: E402

DEFAULT_HOUR_UTC = 15

PAUSE_ENV = "NIGHTSHIFT_PIPELINE_PAUSED"
_PAUSED_WORDS = frozenset({"1", "true", "yes", "on"})
_RUNNING_WORDS = frozenset({"", "0", "false", "no", "off"})


def pipeline_paused(env=None) -> bool:
    """Is the global kill switch for scheduled runs on?

    Only ``1/true/yes/on`` (any case, surrounding space ignored) pause. Anything
    else — unset, empty, ``false``, a typo, garbage — means NOT paused. The
    switch is an explicit opt-in to stopping production: a mangled value must
    not silently stop a pipeline the owner believes is running, which is the
    failure the dead-man alert exists to catch. The cost of that choice is that
    a typo does not pause, so an unrecognised non-empty value is said out loud
    (never echoed) instead of being swallowed.
    """
    raw = str((os.environ if env is None else env).get(PAUSE_ENV, "") or "").strip().lower()
    if raw in _PAUSED_WORDS:
        return True
    if raw not in _RUNNING_WORDS:
        print(
            f"warning: {PAUSE_ENV} is set to a value that is not 1/true/yes/on — "
            "treating the pipeline as NOT paused. Set it to true to pause.",
            file=sys.stderr,
        )
    return False


def due_channels(due_hour: int | None = None, registry=None) -> list[dict]:
    if pipeline_paused():
        print(f"note: pipeline paused by {PAUSE_ENV} — nothing is scheduled", file=sys.stderr)
        return []

    try:
        registry = registry or ChannelRegistry()
        channels = registry.active()
    except Exception as e:
        # Only the exception TYPE: a message from a failed Supabase call can carry
        # a URL or a key fragment, and this goes into the workflow log.
        print(
            f"warning: channel registry UNREADABLE ({type(e).__name__}) — FALLING BACK to the "
            "legacy default channel 'default'. Pausing a channel in the Command Center does NOT "
            f"stop this run while the registry is unreadable; set {PAUSE_ENV}=true to stop it.",
            file=sys.stderr,
        )
        channels = [legacy_default_channel()]

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

    if due_hour is not None:
        channels = [
            c
            for c in channels
            if (c.schedule.publish_hour_utc if c.schedule.publish_hour_utc is not None else DEFAULT_HOUR_UTC)
            == due_hour
        ]

    return [_row(c) for c in channels]


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
    parser.add_argument("--only", default=None,
                        help="Exactly this channel, whatever its schedule (an explicit manual run)")
    args = parser.parse_args()

    if args.only:
        try:
            row = resolve_only(args.only)
        except (KeyError, ValueError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        print(json.dumps({"include": [row]}))
        return 0

    if args.all:
        rows = [
            {"channel_id": str(c.channel_id), "name": c.name, "niche": c.niche,
             "status": c.status, "verified": c.is_verified}
            for c in ChannelRegistry().list()
        ]
    else:
        rows = due_channels(args.due_hour)
        _warn_about_shared_voices()

    print(json.dumps({"include": rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
