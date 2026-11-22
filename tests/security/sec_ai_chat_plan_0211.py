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
        # The shared guard (author, still an editor, not handed off): internal, called inside begin and end.
        "ai_chat_plan_session": SERVICE,
    })
