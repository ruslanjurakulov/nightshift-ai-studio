"""Security-lab contract for migration 0184 (frozen exchange rates for the owner's income register)."""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER, Service

    tables.update({
        # The owner's frozen rates: RLS on, no policy, no grant; only owner_analytics_fx_set / _delete write it.
        "owner_fx_rates": Service(),
    })
    functions.update({
        "owner_analytics_fx_set": USER,
        "owner_analytics_fx_delete": USER,
        "owner_analytics_fx_rates": USER,
    })


def seed(conn, sc) -> None:
    """One frozen rate, set the only way one can be: the owner, in their own session."""
    from sec_db import acting

    with acting(conn, sc.operator, commit=True) as s:
        out = s.run("select public.owner_analytics_fx_set('2026-10-01', 'USD', 1, 'lab')")
    assert out.ok, out
