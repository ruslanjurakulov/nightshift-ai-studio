#!/usr/bin/env python3
"""Emit the channels a scheduled run should cover, as a GitHub Actions matrix.

    python tools/list_channels.py --due-hour 15
    -> {"include": [{"channel_id": "default", "name": "Nightshift", "niche": "..."}]}

The daily workflow calls this once, then fans out one job per returned channel
with ``fail-fast: false``, so a credential failure on one channel cannot cancel
another channel's video.

Two safety properties matter here:

* **It never returns a PAUSED channel.** `ChannelRegistry.active()` filters on
  status AND schedule.enabled, so pausing a channel in the Command Center is
  what actually stops it being scheduled.
* **It cannot fail the workflow open.** If the registry cannot be loaded at
  all, it falls back to the default channel — the single channel this bot has
  always published — rather than emitting an empty matrix that would silently
  stop production, or every channel it half-read.

`--due-hour` filters to channels whose `schedule.publish_hour_utc` matches. A
channel with no hour set is treated as due at the default 15:00 UTC slot, which
is when the workflow has always run.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.channel_credentials import env_var_name  # noqa: E402
from modules.channels import DEFAULT_CHANNEL_ID, ChannelRegistry, legacy_default_channel  # noqa: E402

DEFAULT_HOUR_UTC = 15


def due_channels(due_hour: int | None = None, registry=None) -> list[dict]:
    try:
        registry = registry or ChannelRegistry()
        channels = registry.active()
    except Exception as e:  # pragma: no cover - defensive, see module docstring
        print(f"warning: channel registry unavailable ({type(e).__name__}: {e})", file=sys.stderr)
        channels = [legacy_default_channel()]

    if not channels:
        print("warning: no active channels resolved — falling back to the default", file=sys.stderr)
        channels = [legacy_default_channel()]

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
    return {
        "channel_id": str(c.channel_id),
        "name": c.name,
        "niche": c.niche,
        "is_default": str(c.channel_id) == str(DEFAULT_CHANNEL_ID),
        "token_secret": env_var_name(c),
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
