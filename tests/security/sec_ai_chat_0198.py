"""Security-lab contract and seed for migration 0198 (Nightshift AI / Nightshift Brain).

Alice and Bob each own one conversation with one message. The lab's workspaces are on the free plan, which has no Nightshift AI, so
the seed writes them as the database owner (the only shortcut taken); test_sec_ai_chat.py grants a plan cap inside its own rolled-back
transactions and calls the functions as the person. The isolation tests then attack real rows of both tables (Person("created_by")).
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Person, Service

    tables.update({
        "ai_chat_sessions": Person(col="created_by"),
        "ai_chat_messages": Person(col="created_by", keep=("session_id",)),
        # The metering (no text) and the owner's knobs: RLS on, no policy, no grant.
        "ai_chat_calls": Service(),
        "ai_chat_pilot_orgs": Service(),
        "ai_chat_settings": Service(),
        "ai_chat_plan_caps": Service(),
    })
    functions.update({
        "ai_chat_start": USER,
        "ai_chat_reserve_turn": USER,
        "ai_chat_finish_turn": USER,
        "ai_chat_record_handoff": USER,
        "ai_chat_save_brief": USER,
        "ai_chat_quota": USER,
        "ai_chat_set_model": USER,
        "ai_chat_set_plan_cap": USER,
        "ai_chat_set_limits": USER,
        "ai_chat_usage": USER,
        "ai_chat_owner_settings": USER,
        "ai_chat_used": SERVICE,
        "ai_chat_cap": SERVICE,
        "ai_chat_trial_left": SERVICE,
        "ai_chat_set_pilot": USER,
    })


def seed(conn, sc) -> None:
    from sec_db import as_superuser

    with as_superuser(conn, commit=True) as s:
        for t in (sc.alice, sc.bob):
            sid = s.value("insert into public.ai_chat_sessions (org_id, channel_id, created_by, model) "
                          "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5') returning id", [t.org, t.channel, t.actor.uid])
            s.rows("insert into public.ai_chat_messages (session_id, created_by, role, content) values (%s, %s, 'user', %s) returning 1",
                   [sid, t.actor.uid, f"a video plan of {t.key}"])
            s.rows("insert into public.ai_chat_calls (org_id, user_id, session_id, model, outcome) "
                   "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'ok') returning 1", [t.org, t.actor.uid, sid])
            t.ai_chat_session = str(sid)
        # One pilot row for the closed-table attacks, on the operator's own workspace (credits-exempt: Business's cap already),
        # so no tenant's cap moves.
        s.rows("insert into public.ai_chat_pilot_orgs (org_id) values (public.default_org_id()) on conflict do nothing returning 1")
