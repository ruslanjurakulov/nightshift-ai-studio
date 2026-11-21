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
        "owner_ai_session_create": USER,
        "owner_ai_session_list": USER,
        "owner_ai_session_messages": USER,
        "owner_ai_message_append": USER,
        "owner_ai_session_rename": USER,
        "owner_ai_session_delete": USER,
    })


def seed(conn, sc) -> None:
    """One owner conversation with a question and an answer, so the isolation suite attacks real rows of closed tables."""
    from sec_db import as_superuser

    with as_superuser(conn, commit=True) as s:
        sid = s.value("insert into public.owner_ai_sessions (user_id, title) values (%s, 'Seeded owner chat') returning id",
                      [sc.operator.uid])
        s.rows("insert into public.owner_ai_messages (session_id, role, text, model) values "
               "(%s, 'owner', 'How many signups this week?', 'anthropic-claude-sonnet-5-5'), "
               "(%s, 'ai', 'Twelve.', 'anthropic-claude-sonnet-5-5') returning 1", [sid, sid])
