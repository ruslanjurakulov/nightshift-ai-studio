"""Security-lab contract for migration 0064 (in-app notifications).

Kept in its own module, like sec_storyboard_0057. Three hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_notify_0064; sec_notify_0064.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the storyboards are seeded:
        sec_notify_0064.seed(conn, sc)
  * test_sec_isolation.py skips the "platform admin reads every tenant" check
    for a table declared operator_reads=False: an inbox is one person's own.

Nothing here writes a notification by hand. Rows appear the way production
creates them: the pipeline inserts a storyboard (service key) and the trigger
tells the organization's members. The seed only proves that happened, so the
isolation tests' positive control (a tenant reads its own rows) is not
vacuous. The named attacks are in test_sec_notifications.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org

    tables.update({
        # The person's own inbox: rows are scoped by organization AND by user,
        # and not even a platform admin reads another person's.
        "notifications": Org(operator_reads=False),
    })
    functions.update({
        "mark_notification_read": USER,
        "mark_all_notifications_read": USER,
        # Written only by the triggers; nobody may call them.
        "notification_emit": SERVICE,
        "notification_emit_org": SERVICE,
        "notification_emit_org_role": SERVICE,
        "notification_low_credits_threshold": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import as_superuser

    with as_superuser(conn, commit=False) as s:
        for t in sc.tenants():
            n = s.value(
                "select count(*) from public.notifications "
                "where org_id = %s and user_id = %s and kind = 'storyboard_ready'",
                [t.org, t.actor.uid])
            if n != 1:
                raise AssertionError(
                    f"seed: expected the storyboard trigger to tell {t.actor.email} once, got {n}")
