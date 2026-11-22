"""Security-lab contract for migration 0211 (one storyboard plan at a time per Nightshift AI conversation).

Wired in at the bottom of sec_expectations.py, like sec_owner_ai_history_0209. The lease table is closed (RLS on, an author-only
SELECT policy as a second wall, no grant): only the 0211 functions touch it. Behaviour: tests/security/test_sec_brain_plan_lease.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({
        "ai_chat_plan_leases": Service(),
    })
    functions.update({
        "ai_chat_plan_begin": USER,
        "ai_chat_plan_end": USER,
        "ai_chat_plan_state": USER,
        # The plan's BRIEF write, only while the caller's attempt still holds the lease (Breach BR-S1-08).
        "ai_chat_plan_save_brief": USER,
        # The shared guard (author, still an editor, not handed off): internal, called inside begin and end.
        "ai_chat_plan_session": SERVICE,
    })


def seed(conn, sc) -> None:
    """One finished lease on Alice's and on Bob's seeded conversation (sec_ai_chat_0199), so the isolation suite attacks real rows of
    the closed table. Written as the database owner: no API role can write it (the point of the attacks)."""
    from sec_db import as_superuser

    with as_superuser(conn, commit=True) as s:
        for t in (sc.alice, sc.bob):
            s.rows("insert into public.ai_chat_plan_leases (session_id, created_by, proposal_id, scenario_index, attempt, state, "
                   "expires_at, finished_at) values (%s, %s, 1, 0, 1, 'done', now(), now()) returning 1",
                   [t.ai_chat_session, t.actor.uid])
