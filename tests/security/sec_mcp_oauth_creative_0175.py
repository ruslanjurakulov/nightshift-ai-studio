"""Security-lab contract for migration 0175 (the Studio's generations for a connected assistant).

Kept in its own module, like sec_mcp_oauth_0093. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_mcp_oauth_creative_0175; sec_mcp_oauth_creative_0175.extend(TABLES, FUNCTIONS)
  * sec_scenario.py, after the OAuth seed:
        import sec_mcp_oauth_creative_0175; sec_mcp_oauth_creative_0175.seed(conn, sc)

Every new table is Service(): no API role reads or writes a row; the five doors (anon, a token hash) are the only way in. The named
attacks are in test_sec_mcp_oauth_creative.py, in a scratch database of its own.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import API, SERVICE, Service

    tables.update({
        "oauth_creative_quotes": Service(),
        "oauth_creative_jobs": Service(),
        "oauth_creative_rate_counters": Service(),
    })
    functions.update({
        # The MCP route's doors (anon key; the token's hash decides, through oauth_ctx).
        "oauth_creative_models": API,
        "oauth_media_list": API,
        "oauth_creative_quote": API,
        "oauth_creative_create": API,
        "oauth_creative_get": API,
        # Internal: called only inside the definer functions above.
        "oauth_creative_capabilities": SERVICE,
        "oauth_creative_limits": SERVICE,
        "oauth_creative_model_state": SERVICE,
        "oauth_creative_state_refusal": SERVICE,
        "oauth_creative_rate_take": SERVICE,
        "oauth_creative_rate_refusal": SERVICE,
        "oauth_creative_quote_json": SERVICE,
    })


def seed(conn, sc) -> None:
    """One row in each 0175 table, on the connection 0093's seed made for Alice: a quote, the generation it paid for, and a rate
    counter, so the isolation tests have something to attack."""
    import json

    from sec_db import as_superuser

    with as_superuser(conn) as s:
        if not s.value("select to_regclass('public.oauth_creative_jobs') is not null"):
            return
        grant = s.value("select id from public.oauth_grants where org_id = %s order by created_at limit 1", [sc.alice.org])
        if grant is None:
            return
        job = s.value(
            "insert into public.creative_jobs (org_id, capability, requested_model, routed_model, params, status, quoted_credits, "
            "requested_by) values (%s, 't2i', 'scenario-img', 'scenario-img', %s::jsonb, 'queued', 3, %s) returning id",
            [sc.alice.org, json.dumps({"prompt": "scenario"}), sc.alice.actor.uid])
        quote = s.value(
            "insert into public.oauth_creative_quotes (grant_id, org_id, capability, model, params, credits, quote, expires_at, job_id) "
            "values (%s, %s, 't2i', 'scenario-img', %s::jsonb, 3, '{}'::jsonb, now() + interval '15 minutes', %s) returning id",
            [grant, sc.alice.org, json.dumps({"prompt": "scenario"}), job])
        s.rows("insert into public.oauth_creative_jobs (job_id, grant_id, org_id, quote_id, idem_key, quoted_credits) "
               "values (%s, %s, %s, %s, 'scenario', 3) returning 1", [job, grant, sc.alice.org, quote])
        s.rows("insert into public.oauth_creative_rate_counters (grant_id, bucket, minute, count) "
               "values (%s, 'quote', date_trunc('minute', now()), 1) returning 1", [grant])
