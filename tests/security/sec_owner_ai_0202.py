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


def seed(conn, sc) -> None:
    """One finished owner turn (no text: the table holds none), so the isolation suite attacks a real row of a closed table.
    Dated two days back: outside the 24-hour window, so the cap tests count only the rows they insert."""
    from sec_db import as_superuser

    with as_superuser(conn, commit=True) as s:
        s.rows("insert into public.owner_ai_turns (user_id, model, outcome, chars_in, created_at, finished_at) "
               "values (%s, 'anthropic-claude-sonnet-5-5', 'answered', 12, now() - interval '2 days', now() - interval '2 days') returning 1", [sc.operator.uid])
