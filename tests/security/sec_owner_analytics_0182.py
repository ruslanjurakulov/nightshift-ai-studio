"""Security-lab contract for migration 0182 (the owner analytics hub's reads and its export log).

Wired in at the bottom of sec_expectations.py:

    import sec_owner_analytics_0182; sec_owner_analytics_0182.extend(TABLES, FUNCTIONS)

A signed-in user may EXECUTE the reads (the Command Center calls them with the owner's own session, never the service key), so
USER here means "the function refuses everyone but the platform OWNER itself" — test_sec_owner_analytics.py is the proof, with
the arithmetic. owner_analytics_sales_all() is internal: no API role may execute it.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({
        # Who exported what: RLS on, no policy, no grant. Only owner_analytics_record_export() writes it.
        "owner_analytics_exports": Service(),
        # The owner's internal / test workspaces: closed like the log; only owner_analytics_set_internal() writes it.
        "owner_analytics_internal_orgs": Service(),
    })
    functions.update({
        "owner_analytics_is_owner": USER,
        "owner_analytics_sales_all": SERVICE,
        "owner_analytics_money": USER,
        "owner_analytics_people": USER,
        "owner_analytics_activity": USER,
        "owner_analytics_jobs": USER,
        "owner_analytics_record_export": USER,
        "owner_analytics_export_log": USER,
        "owner_analytics_set_internal": USER,
        "owner_analytics_internal_list": USER,
        "owner_analytics_internal_org_ids": SERVICE,
    })


def seed(conn, sc) -> None:
    """One export record, written the only way one can be: the owner, in their own session, through
    owner_analytics_record_export (the isolation tests then prove nobody reads, inserts, updates or deletes it directly)."""
    from sec_db import acting

    with acting(conn, sc.operator, commit=True) as s:
        out = s.run("select public.owner_analytics_record_export('revenue', 'csv', now() - interval '30 days', now(), false)")
    assert out.ok, out
    # And one flagged workspace (tenant B's, as a stand-in for a demo account), flagged the same way.
    with acting(conn, sc.operator, commit=True) as s:
        out = s.run("select public.owner_analytics_set_internal(%s, true, 'lab: demo workspace')", [sc.bob.org])
    assert out.ok, out
