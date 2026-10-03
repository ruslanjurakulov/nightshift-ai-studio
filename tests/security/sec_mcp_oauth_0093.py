"""Security-lab contract for migration 0093 (MCP over OAuth).

Kept in its own module, like sec_router_0075. One hook wires it in:

  * sec_expectations.py, at the bottom:
        import sec_mcp_oauth_0093; sec_mcp_oauth_0093.extend(TABLES, FUNCTIONS)

Every OAuth table is Service(): no API role reads or writes a row; the
functions below (security definer) are the only way in. The named attacks are
in test_sec_mcp_oauth.py, in a scratch database of their own.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import API, SERVICE, USER, Service

    tables.update({
        "oauth_settings": Service(),
        "oauth_clients": Service(),
        "oauth_auth_requests": Service(),
        "oauth_grants": Service(),
        "oauth_codes": Service(),
        "oauth_tokens": Service(),
        "oauth_runs": Service(),
        "oauth_rate_counters": Service(),
    })
    functions.update({
        # The server's routes (anon key; the secret in the call decides).
        "oauth_register_client": API,
        "oauth_exchange_code": API,
        "oauth_refresh": API,
        "oauth_revoke_token": API,
        "oauth_check": API,
        "oauth_create_video": API,
        "oauth_get_job": API,
        "oauth_get_balance": API,
        # The signed-in person, their own rows only.
        "oauth_begin_authorization": USER,
        "oauth_decide_authorization": USER,
        "oauth_my_grants": USER,
        "oauth_revoke_grant": USER,
        "oauth_revoke_all_grants": USER,
        "oauth_set_grant_limit": USER,
        # Internal: called only inside the definer functions above.
        "oauth_ctx": SERVICE,
        "oauth_token_state": SERVICE,
        "oauth_endpoint_scope": SERVICE,
        "oauth_limits": SERVICE,
        "oauth_scopes_supported": SERVICE,
        "oauth_redirect_uri_ok": SERVICE,
        "oauth_month_start": SERVICE,
        "oauth_grant_month_credits": SERVICE,
        "oauth_workspace": SERVICE,
        "oauth_revoke_grant_locked": SERVICE,
        "oauth_gc": SERVICE,
        "oauth_rate_take": SERVICE,
    })
