"""Security-lab contract for migration 0103 (the retention e-mails and the
"video ready" notification).

Wired in at the bottom of sec_expectations.py, like sec_notify_0064:

    import sec_retention_0103; sec_retention_0103.extend(TABLES, FUNCTIONS)

The two tables are closed to every API role (no grant, no policy): they are
reached only through the functions, so the unsubscribe token never leaves the
database except in email_claim_*, which only the service key may call. The named
attacks are in test_sec_retention.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import HELPER_ANON, SERVICE, USER, Service

    tables.update({
        "email_preferences": Service(),
        "email_deliveries": Service(),
    })
    functions.update({
        "email_prefs_get": USER,
        "email_prefs_set": USER,
        "email_worker_online": USER,
        # The signed-out one-click opt-out: the token is the authority.
        "email_unsubscribe": HELPER_ANON,
        # The worker's functions and the digest they call: the service key only.
        "email_claim_ready": SERVICE,
        "email_claim_weekly": SERVICE,
        "email_complete": SERVICE,
        "email_weekly_digest": SERVICE,
    })


def seed(conn, sc) -> None:
    """One row in each closed table, so the isolation tests' insert attacks have
    something to clone. Dana (a plain member of the operator's organization) is
    used so Alice's and Bob's own rows stay exactly as the named tests expect:
    nothing stored, defaults applying. Written as the database owner: no API
    role can write either table."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        s.rows("insert into public.email_preferences (user_id, ready_enabled, locale) values (%s, true, 'en') returning 1",
               [sc.dana.uid])
        s.rows("insert into public.email_deliveries (user_id, kind, ref, status, error_code, done_at) "
               "values (%s, 'weekly', 'seed', 'skipped', 'nothing_to_say', now()) returning 1", [sc.dana.uid])
