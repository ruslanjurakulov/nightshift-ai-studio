"""Security-lab contract for migration 0183 (the owner analytics hub's costs, balances and the owner's monthly cost entries).

Wired in at the bottom of sec_expectations.py and seeded from sec_scenario.build_scenario(), like sec_owner_analytics_0182.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({
        # The owner's own monthly costs: RLS on, no policy, no grant; only owner_analytics_cost_add / _delete write it.
        "owner_cost_entries": Service(),
    })
    functions.update({
        "owner_analytics_provider_spend": USER,
        "owner_analytics_balances": USER,
        "owner_analytics_balance_enter": USER,
        "owner_analytics_cost_add": USER,
        "owner_analytics_cost_delete": USER,
        "owner_analytics_costs": USER,
        "owner_analytics_try_instant": SERVICE,
    })


def seed(conn, sc) -> None:
    """One cost entry, written the only way one can be: the owner, in their own session."""
    from sec_db import acting

    with acting(conn, sc.operator, commit=True) as s:
        out = s.run("select public.owner_analytics_cost_add(date_trunc('month', now())::date, 'infrastructure', 1, 'lab')")
    assert out.ok, out
