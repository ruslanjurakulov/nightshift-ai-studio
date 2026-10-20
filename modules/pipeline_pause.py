"""``NIGHTSHIFT_PIPELINE_PAUSED``: what the owner's pause switch means, decided in ONE place.

The scheduler (tools/list_channels.py) stops scheduling when it is on; the operator bot
(modules/operator_bot/config.py) stops raising dead-man alerts and says "paused" instead of MISSING; the scheduled
doctor (tools/doctor.py) reports it. All three read it through this module, so the word list cannot drift between
them: a pause the scheduler obeys but the bot does not understand is a "No video" alarm for a slot that was stopped
on purpose.

No imports beyond the standard library, so the doctor (which must stay import-light) and the bot can use it.
"""

from __future__ import annotations

import os
import sys

PAUSE_ENV = "NIGHTSHIFT_PIPELINE_PAUSED"
_RUNNING_WORDS = frozenset({"", "0", "false", "no", "off"})
_PAUSE_WORDS = frozenset({"1", "true", "yes", "on"})


def _pause_value(env=None) -> str:
    raw = str((os.environ if env is None else env).get(PAUSE_ENV, "") or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        raw = raw[1:-1]  # one pair of surrounding quotes: a pasted "true" means true
    return raw.strip().lower()


def pause_state(env=None) -> str:
    """``running`` | ``paused`` | ``unrecognised`` (which still means paused: see :func:`pipeline_paused`).

    Silent: a caller that only reports the state (the doctor) must not print the scheduler's warning again."""
    raw = _pause_value(env)
    if raw in _RUNNING_WORDS:
        return "running"
    return "paused" if raw in _PAUSE_WORDS else "unrecognised"


def pipeline_paused(env=None) -> bool:
    """Is the pause for scheduled operator runs on? Fails CLOSED.

    Only ``""/0/false/no/off`` (case-insensitive, trimmed, one pair of quotes
    stripped) mean "run". ANYTHING else pauses — ``1/true/yes/on``, but also a
    typo or garbage. The person who set the variable meant to stop something;
    an unreadable instruction to stop is not a licence to spend (CLAUDE.md rule
    4: no video is the better failure, and ``normalize_status`` likewise reads an
    unknown channel status as PAUSED). An unrecognised value is said out loud —
    never echoed — so a typo is noticed and fixed rather than quietly obeyed.
    """
    state = pause_state(env)
    if state == "unrecognised":
        msg = (
            f"{PAUSE_ENV} has an unrecognised value - treating as PAUSED. "
            "Accepted: true/1/yes/on (pause) or false/0/no/off/unset (run)."
        )
        print(f"warning: {msg}", file=sys.stderr)
        print(f"::warning::{msg}", file=sys.stderr)
    return state != "running"
