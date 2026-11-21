"""Security-lab contract and seed for migration 0197 (Nightshift AI: the Studio's planning chat).

Alice and Bob each own one conversation with one message, written the only way a row can be: by their own calls of
ai_chat_start() and ai_chat_reserve_turn(). The isolation tests then attack real rows of both tables (Person("created_by")):
nobody but the author reads them, not even the operator, and no API role writes them. test_sec_ai_chat.py attacks the functions.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Person, Service

    tables.update({
        "ai_chat_sessions": Person(col="created_by"),
        "ai_chat_messages": Person(col="created_by", keep=("session_id",)),
        # The metering (no text) and the owner's knobs: RLS on, no policy, no grant.
        "ai_chat_calls": Service(),
        "ai_chat_limits": Service(),
    })
    functions.update({
        "ai_chat_start": USER,
        "ai_chat_reserve_turn": USER,
        "ai_chat_finish_turn": USER,
        "ai_chat_quota": USER,
        "ai_chat_set_limits": USER,
        "ai_chat_usage": USER,
        "ai_chat_used": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import acting

    for t in (sc.alice, sc.bob):
        with acting(conn, t.actor, commit=True) as s:
            sid = s.value("select public.ai_chat_start(%s, %s, 'anthropic-claude-sonnet-5-5')", [t.org, t.channel])
            s.value("select public.ai_chat_reserve_turn(%s, %s)", [sid, f"a video plan of {t.key}"])
            t.ai_chat_session = str(sid)
