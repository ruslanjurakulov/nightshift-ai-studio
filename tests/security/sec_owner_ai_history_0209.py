"""Security-lab contract for migration 0209 (the owner's Nightshift AI conversation history).

Wired in at the bottom of sec_expectations.py and sec_scenario.py, like sec_owner_ai_0203.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER, Service

    tables.update({
        # The owner's questions and the AI's answers: RLS on, no policy, no grant. Only the 0209 functions reach them.
        "owner_ai_sessions": Service(),
        "owner_ai_messages": Service(),
    })
    functions.update({
        "owner_ai_turn_save": USER,
        "owner_ai_session_list": USER,
        "owner_ai_session_messages": USER,
        "owner_ai_session_rename": USER,
        "owner_ai_session_delete": USER,
    })


def seed(conn, sc) -> None:
    """One owner conversation holding one saved turn, so the isolation suite attacks real rows of closed tables. Its 0203 turn is
    dated two days back, like 0203's own seed, so the cap tests count only the rows they insert."""
    from sec_db import as_superuser

    with as_superuser(conn, commit=True) as s:
        tid = s.value("insert into public.owner_ai_turns (user_id, model, outcome, chars_in, created_at, finished_at) "
                      "values (%s, 'anthropic-claude-sonnet-5-5', 'answered', 27, now() - interval '2 days', now() - interval '2 days') "
                      "returning id", [sc.operator.uid])
        sid = s.value("insert into public.owner_ai_sessions (user_id, title) values (%s, 'Seeded owner chat') returning id",
                      [sc.operator.uid])
        s.rows("insert into public.owner_ai_messages (session_id, turn_id, role, text, as_of, model) values "
               "(%s, %s, 'owner', 'How many signups this week?', null, null), "
               "(%s, %s, 'ai', 'Twelve.', null, 'anthropic-claude-sonnet-5-5') returning 1", [sid, tid, sid, tid])
