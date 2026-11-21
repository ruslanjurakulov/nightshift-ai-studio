"""Security-lab contract for migration 0202 (the owner's Nightshift AI: its turn log and daily cap).

Wired in at the bottom of sec_expectations.py, like sec_owner_brain_0197.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER, Service

    tables.update({
        # The owner AI's metering (no question, no answer): RLS on, no policy, no grant.
        "owner_ai_turns": Service(),
    })
    functions.update({
        "owner_ai_reserve_turn": USER,
        "owner_ai_finish_turn": USER,
    })
