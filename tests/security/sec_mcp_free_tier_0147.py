"""Security-lab contract for migration 0147 (MCP over OAuth on every plan; one rate unit per tool call).

Wired in at the bottom of sec_expectations.py and in sec_scenario.py, like the other per-migration files:

    import sec_mcp_free_tier_0147; sec_mcp_free_tier_0147.extend(TABLES, FUNCTIONS)
    import sec_mcp_free_tier_0147; sec_mcp_free_tier_0147.seed(conn, sc)

One new table, Service(): oauth_check_credits holds one credit per (connection, request id) that oauth_check counted and let
through; no API role reads or writes it (RLS on, every privilege revoked, service_role included, like every 0093 table). Three new
functions, all internal (no API role may call them): oauth_check_credit_put (called by oauth_check), oauth_check_credit_take
(called by oauth_ctx) and oauth_vendor_callbacks_only, which generates oauth_clients.vendor (the registration's
class: every redirect URI an AI vendor's own callback). The nine 0093 functions and the two 0042 functions it replaces keep their 0093 / 0042 declarations.
The named attacks are in test_sec_mcp_free_tier.py, in a scratch database of its own.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, Service

    tables.update({
        "oauth_check_credits": Service(),
    })
    functions.update({
        "oauth_check_credit_put": SERVICE,
        "oauth_check_credit_take": SERVICE,
        # The registration class (a generated column of oauth_clients reads it): immutable, internal.
        "oauth_vendor_callbacks_only": SERVICE,
    })


def seed(conn, sc) -> None:
    """One credit for the scenario's connection (0093's seed), so the isolation tests attack a table with a row in it."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        if not s.value("select to_regclass('public.oauth_check_credits') is not null"):
            return
        grant = s.value("select g.id from public.oauth_grants g join public.oauth_clients c on c.client_id = g.client_id "
                        "where c.client_name = 'Scenario app' order by g.created_at limit 1")
        if grant is None:
            return
        s.rows("insert into public.oauth_check_credits (grant_id, request_id) values (%s, 'req_ScenarioCredit0000000001') "
               "on conflict do nothing returning 1", [grant])
