"""Security-lab contract for migration 0034 (plans, entitlements, credit lots).

Kept in its own module so the plans work reads as one piece. Two hooks wire
it in:

  * sec_expectations.py, at the bottom:
        import sec_plans_0034; sec_plans_0034.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_plans_0034.seed(conn, sc)

The attacks are in test_sec_plans.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    # Imported here, not at the top: sec_expectations imports this module at
    # its end, when these names already exist.
    from sec_expectations import HELPER, SERVICE, USER, Org, Public, Service

    tables.update({
        # The price list: plans, what each unlocks, how long a lot lives.
        # Public (the /pricing page reads it signed out); only a platform
        # owner/admin writes it (RLS), which the attacks check.
        "plans": Public(anon=True),
        "entitlement_keys": Public(anon=True),
        "plan_entitlements": Public(anon=True),
        "credit_lot_policies": Public(anon=True),
        # The organization's own billing state: its viewers read, nobody writes.
        "subscriptions": Org(),
        "credit_lots": Org(),
        # Internal lot bookkeeping.
        "credit_hold_lots": Service(),
        "credit_lot_moves": Service(),
    })

    functions.update({
        # pure helpers a platform admin's config write evaluates
        "entitlement_value_valid": HELPER,
        "model_tier_rank": HELPER,
        # reads; each checks membership / platform admin itself
        "org_plan": USER,
        "org_entitlements": USER,
        "has_entitlement": USER,
        "entitlement_int": USER,
        "model_tier_allowed": USER,
        "org_run_slots": USER,
        "billing_summary": USER,
        # the webhook and the worker (service role)
        "upsert_subscription": SERVICE,
        "grant_subscription_credits": SERVICE,
        "expire_credit_lots": SERVICE,
        # internal: nobody through the API
        "org_plan_internal": SERVICE,
        "org_entitlements_internal": SERVICE,
        "entitlement_int_internal": SERVICE,
        "has_entitlement_internal": SERVICE,
        "billing_may_read": SERVICE,
        "credit_lot_expiry": SERVICE,
        "credit_lot_move": SERVICE,
        "credit_lots_add_locked": SERVICE,
        "credit_lots_spend_locked": SERVICE,
        "credit_lots_hold_locked": SERVICE,
        "credit_lots_capture_locked": SERVICE,
        "credit_lots_release_locked": SERVICE,
        "credit_lots_restore_locked": SERVICE,
        "credit_expire_lots_locked": SERVICE,
        "render_job_priority": SERVICE,
    })


def seed(conn, sc) -> None:
    """Alice is on Creator, Bob on Pro — through the webhook's own functions,
    as the service role. Their welcome grant, the 500-credit seed grant and the
    open hold already made lots, hold allocations and moves."""
    from sec_db import SERVICE as SERVICE_ACTOR, acting

    for tenant, plan, sub in ((sc.alice, "creator", "sub_01seclab0000000000000000aa"),
                              (sc.bob, "pro", "sub_01seclab0000000000000000bb")):
        with acting(conn, SERVICE_ACTOR, commit=True) as s:
            s.value(
                "select public.upsert_subscription(%s, %s, %s, %s, null, 'active', now() - interval '1 day', "
                "now() + interval '29 days', false, null, now())",
                [tenant.org, sub, f"ctm_01seclab0000000000000000{tenant.key}{tenant.key}", plan])
            s.value(
                "select public.grant_subscription_credits(%s, %s, %s, now() - interval '1 day', now() + interval '29 days', %s)",
                [tenant.org, sub, plan, f"txn_01seclab0000000000000000{tenant.key}{tenant.key}"])
