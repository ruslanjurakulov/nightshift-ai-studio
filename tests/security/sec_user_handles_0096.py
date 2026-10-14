"""Security-lab contract for migration 0096 (the unique @username).

Hooked in like sec_friend_invites_0092:

  * sec_expectations.py, at the bottom:
        import sec_user_handles_0096; sec_user_handles_0096.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario():
        sec_user_handles_0096.seed(conn, sc)

user_handles is declared Service(): the isolation tests then prove that a
customer, a stranger and the anon key read none of ANOTHER person's row and
cannot insert, update or delete any. That a person reads their OWN row is a
property the generic kinds cannot express, so test_sec_user_handles.py proves it.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import PRICE_LIST, SERVICE, USER, Service

    tables.update({"user_handles": Service()})
    functions.update({
        # the signed-in person: ask whether a handle is free, set or change their own
        "handle_available": USER,
        "set_handle": USER,
        # the sign-up form asks signed out: one boolean (or NULL), rate-limited platform-wide
        "handle_available_public": PRICE_LIST,
        # the rules, pure: run by the table's CHECK as its owner, callable by nobody
        "handle_format_ok": SERVICE,
        "handle_reserved": SERVICE,
        "handle_valid": SERVICE,
    })


def seed(conn, sc) -> None:
    """Alice has a handle (written by the database owner, as only set_handle()
    may write it). Bob and the stranger have none, so the isolation tests' "a
    customer reads none of another's rows" and their clone-a-row attacks have a
    row to aim at."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        s.rows("insert into public.user_handles (user_id, handle) values (%s, %s) returning 1",
               [sc.alice.actor.uid, "alice.lab"])
