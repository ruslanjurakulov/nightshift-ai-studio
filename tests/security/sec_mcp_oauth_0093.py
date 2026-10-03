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


def seed(conn, sc) -> None:
    """One row in every OAuth table, so the isolation tests have something to
    attack: a client, a consent request, a grant of Alice's with a code, a
    token pair, a run and a rate counter."""
    import hashlib
    import uuid

    from sec_db import as_superuser

    def h(label):
        return hashlib.sha256(f"scenario-oauth-{label}".encode()).hexdigest()

    with as_superuser(conn) as s:
        if not s.value("select to_regclass('public.oauth_grants') is not null"):
            return
        client = s.value("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) "
                         "values ('Scenario app', array['https://claude.ai/api/mcp/auth_callback'], %s) returning client_id", [h("ip")])
        s.rows("insert into public.oauth_auth_requests (secret_hash, user_id, org_id, client_id, redirect_uri, code_challenge, scopes, resource) "
               "values (%s, %s, %s, %s, 'https://claude.ai/api/mcp/auth_callback', %s, array['videos:read'], 'https://nightshift-ai.studio/api/mcp') returning 1",
               [h("req"), sc.alice.actor.uid, sc.alice.org, client, "A" * 43])
        grant = s.value("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits, activated_at) "
                        "values (%s, %s, %s, array['videos:read'], 'https://nightshift-ai.studio/api/mcp', 100, now()) returning id",
                        [sc.alice.actor.uid, sc.alice.org, client])
        s.rows("insert into public.oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource) "
               "values (%s, %s, %s, 'https://claude.ai/api/mcp/auth_callback', %s, 'https://nightshift-ai.studio/api/mcp') returning 1",
               [h("code"), grant, client, "A" * 43])
        s.rows("insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values (%s, %s, 'access', now() + interval '1 hour') returning 1",
               [h("at"), grant])
        s.rows("insert into public.oauth_runs (grant_id, org_id, idem_key, fingerprint, credit_ref, channel_id) "
               "values (%s, %s, 'seed', 'fp', %s, %s) returning 1",
               [grant, sc.alice.org, f"rj-oa-{uuid.uuid4().hex}", sc.alice.channel])
        s.rows("insert into public.oauth_rate_counters (grant_id, minute, count) values (%s, date_trunc('minute', now()), 1) returning 1", [grant])
