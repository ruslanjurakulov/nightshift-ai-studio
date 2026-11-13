"""Migration 0147 (MCP over OAuth on every plan; spend-limit remedies; one rate unit per tool call), pinned as text.

What would break, and which test says so:

* a replaced function that drifted from the body it was written on (a check of 0093's or 0042's silently dropped):
  every replaced function must be its latest earlier body plus exactly the hunks listed here, byte for byte;
* the plan gate surviving somewhere (a Free workspace refused at one door while the rest let it in): no function
  0147 defines may name the `mcp` entitlement or answer `subscription_required`;
* the rate credit turning into a free pass: the credit is put only after oauth_check counted and admitted the
  request, only for the route's request-id shape, and taken with one DELETE ... RETURNING younger than a minute;
* md5 pins that no longer describe the file, a rollback that does not put the old bodies back verbatim, a table
  an API role can read.

The lab (tests/security/test_sec_mcp_free_tier.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0042 = (MIG / "0042_web_api_hardening.sql").read_text(encoding="utf-8")
M0093 = (MIG / "0093_mcp_oauth.sql").read_text(encoding="utf-8")
M0147 = (MIG / "0147_mcp_free_tier.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0147_mcp_free_tier.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")


def definition(text: str, name: str) -> str:
    """`create or replace function public.<name>(` up to the `$$;` that closes its body."""
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def body(defn: str) -> str:
    return defn.split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(defn: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body(defn)).encode()).hexdigest()


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


NO_PLAN_CHECK = "  -- 0147: no plan check: every plan may connect an app (credits and the connection's own limit bound it).\n"

# name -> (the migration whose body it is built on, [(old, new), ...]); each old text occurs exactly once in that body.
HUNKS = {
    "oauth_ctx": ("0093", [
        ("  v_used := public.oauth_rate_take(v_grant);\n",
         "  -- 0147: the MCP route's oauth_check already took this request's unit and left a credit for its request id,\n"
         "  -- so the first call of that request reads this minute's count instead of taking a second unit (with two\n"
         "  -- units per tool call, 120 a minute meant about 60 tool calls). The test below stays `>`, so the call the\n"
         "  -- check admitted is not refused for the check's own unit; any other call is counted as before.\n"
         "  if public.oauth_check_credit_take(v_grant, p_request_id) then\n"
         "    select coalesce(max(c.count), 0) into v_used from public.oauth_rate_counters c\n"
         "     where c.grant_id = v_grant and c.minute = v_minute;\n"
         "  else\n"
         "    v_used := public.oauth_rate_take(v_grant);\n"
         "  end if;\n"),
        ("    -- MCP over OAuth is a subscription feature, checked live on every call.\n"
         "    if not public.has_entitlement_internal(v_org, 'mcp') then\n"
         "      return public.api_finish(ctx, public.api_err(403, 'subscription_required',\n"
         "        'Connected apps need a paid plan. This connection is paused until the workspace has one.'));\n"
         "    end if;\n",
         "    -- 0147: no plan check. Every plan may connect an app; a video it makes is held through reserve_credits\n"
         "    -- (insufficient_credits when the workspace has too few) and capped by the connection's monthly limit.\n"),
    ]),
    "oauth_check": ("0093", [
        ("  return public.api_ok(jsonb_build_object('resource', st -> 'resource', 'scopes', st -> 'scopes',\n"
         "    'entitled', public.has_entitlement_internal((st ->> 'org_id')::uuid, 'mcp')));\n",
         "  -- 0147: only a check that was counted and let through leaves a credit, so a refused or invalid check\n"
         "  -- gives nothing away. `entitled` is always true now (every plan may connect); kept for the answer's shape.\n"
         "  perform public.oauth_check_credit_put((st ->> 'grant_id')::uuid, p_request_id);\n"
         "  return public.api_ok(jsonb_build_object('resource', st -> 'resource', 'scopes', st -> 'scopes',\n"
         "    'entitled', true));\n"),
    ]),
    "oauth_begin_authorization": ("0093", [
        ("  if not public.has_entitlement_internal(v_org, 'mcp') then\n"
         "    -- Free: no screen to approve and no code, ever.\n"
         "    return jsonb_build_object('ok', true, 'entitled', false, 'client_name', c.client_name,\n"
         "                              'workspace_name', v_name, 'plan', v_plan);\n"
         "  end if;\n",
         "  -- 0147: every plan may approve, Free included. `entitled` below stays true for the consent page's shape.\n"),
    ]),
    "oauth_decide_authorization": ("0093", [
        ("  if not public.has_entitlement_internal(r.org_id, 'mcp') then\n"
         "    return jsonb_build_object('ok', false, 'error', 'subscription_required');\n"
         "  end if;\n", NO_PLAN_CHECK),
    ]),
    "oauth_exchange_code": ("0093", [
        ("  if not public.has_entitlement_internal(g.org_id, 'mcp') then\n"
         "    return jsonb_build_object('ok', false, 'error', 'subscription_required');\n"
         "  end if;\n", NO_PLAN_CHECK),
    ]),
    "oauth_refresh": ("0093", [
        ("  -- A lapsed plan cannot refresh. The token is not spent: renewing the plan and\n"
         "  -- trying again works without reconnecting.\n"
         "  if not public.has_entitlement_internal(g.org_id, 'mcp') then\n"
         "    return jsonb_build_object('ok', false, 'error', 'subscription_required');\n"
         "  end if;\n", NO_PLAN_CHECK),
    ]),
    "oauth_my_grants": ("0093", [
        ("  return coalesce((\n",
         "  -- 0147: the plan never pauses a connection any more; `status` stays for the list's shape.\n"
         "  return coalesce((\n"),
        ("'status', case when public.has_entitlement_internal(g.org_id, 'mcp') then 'active' else 'paused_plan' end)",
         "'status', 'active')"),
    ]),
    "oauth_limits": ("0093", [
        ("    'register_per_ip_hour', 10, 'register_global_hour', 300, 'max_clients', 20000)\n",
         "    'register_per_ip_hour', 10, 'register_global_hour', 300, 'max_clients', 20000,\n"
         "    -- 0147: a registration whose every redirect URI is an AI vendor's own callback (oauth_vendor_callbacks_only) is its\n"
         "    -- own class: the vendor's shared servers register for every person (Claude on each fresh connection), so 10 an\n"
         "    -- address throttled the 11th person an hour. Hourly ceiling x the collector's 24 hours stays under the class's row cap.\n"
         "    'register_vendor_per_ip_hour', 300, 'register_vendor_global_hour', 2000, 'max_vendor_clients', 60000)\n"),
    ]),
    "oauth_register_client": ("0093", [
        ("  v_id    uuid;\nbegin\n", "  v_id    uuid;\n  v_vendor boolean;\nbegin\n"),
        ("  v_uris := array(select distinct x from unnest(p_redirect_uris) x order by 1);\n",
         "  v_uris := array(select distinct x from unnest(p_redirect_uris) x order by 1);\n"
         "  -- 0147: the class this registration is counted in (the same test as oauth_clients.vendor, which is generated from it).\n"
         "  v_vendor := public.oauth_vendor_callbacks_only(v_uris);\n"),
        ("  if (select count(*) from public.oauth_clients where ip_hash = v_ip and created_at > now() - interval '1 hour')\n"
         "       >= (lim ->> 'register_per_ip_hour')::int\n"
         "     or (select count(*) from public.oauth_clients where created_at > now() - interval '1 hour')\n"
         "       >= (lim ->> 'register_global_hour')::int then\n",
         "  -- 0147: each class has its own per-address and hourly budgets, so a flood of one cannot spend the other's.\n"
         "  if (select count(*) from public.oauth_clients where ip_hash = v_ip and vendor = v_vendor and created_at > now() - interval '1 hour')\n"
         "       >= (lim ->> case when v_vendor then 'register_vendor_per_ip_hour' else 'register_per_ip_hour' end)::int\n"
         "     or (select count(*) from public.oauth_clients where vendor = v_vendor and created_at > now() - interval '1 hour')\n"
         "       >= (lim ->> case when v_vendor then 'register_vendor_global_hour' else 'register_global_hour' end)::int then\n"),
        ("  if (select count(*) from public.oauth_clients) >= (lim ->> 'max_clients')::int then\n",
         "  if (select count(*) from public.oauth_clients where vendor = v_vendor)\n"
         "       >= (lim ->> case when v_vendor then 'max_vendor_clients' else 'max_clients' end)::int then\n"),
    ]),
    "api_create_video": ("0042", [
        ("'This video would take the organization past its monthly API spend limit.',",
         "'This video would take the organization past its monthly API spend limit. An owner or admin can raise it in the Developer console: Developers → Usage and billing → Monthly spend limit (up to the usage tier''s cap; paying more into the API balance raises the tier).',"),
        ("'This video would take this key past its own monthly spend limit.',",
         "'This video would take this key past its own monthly spend limit. An owner or admin can raise or remove it in the Developer console: Developers → API keys → Set limit on this key.',"),
    ]),
    "api_request_download": ("0042", [
        ("'This download would take the organization past its monthly API spend limit.',",
         "'This download would take the organization past its monthly API spend limit. An owner or admin can raise it in the Developer console: Developers → Usage and billing → Monthly spend limit (up to the usage tier''s cap; paying more into the API balance raises the tier).',"),
        ("'This download would take this key past its own monthly spend limit.',",
         "'This download would take this key past its own monthly spend limit. An owner or admin can raise or remove it in the Developer console: Developers → API keys → Set limit on this key.',"),
    ]),
}
SOURCES = {"0042": M0042, "0093": M0093}
NEW_FUNCTIONS = ("oauth_check_credit_put", "oauth_check_credit_take", "oauth_vendor_callbacks_only")

# md5 of each body as PostgreSQL stores it (white space runs read as one space): before (the earlier body) and after.
PINS = {
    "oauth_ctx": ("bcd7e88f9a62af2ebdf3623dca73c014", None),
    "oauth_check": ("43271cf097d7e56cada31febe5eb0efe", None),
    "oauth_begin_authorization": ("df8f5a04ee8ee2188502ad3c69382d52", None),
    "oauth_decide_authorization": ("84227fee357456de62c5b22e7a4d30d6", None),
    "oauth_exchange_code": ("991015aa1d7bf75ad9396382b55c9e07", None),
    "oauth_refresh": ("5e6602cf0b679ccc06b151a1c3c2c7f4", None),
    "oauth_my_grants": ("1ce7826facd2f15a241d594bbed9768c", None),
    "oauth_limits": ("26991d89b0f198dd4016b5156a8b0be1", None),
    "oauth_register_client": ("4ca23a05570337e930413dd109b7c78c", None),
    "api_create_video": ("c054107143ba7bbfaaaff861d5575ecb", None),
    "api_request_download": ("b89909c57a27a5ab7d0fa3368f1a3677", None),
}


def rebuilt(name: str) -> str:
    src, hunks = HUNKS[name]
    out = definition(SOURCES[src], name)
    for old, new in hunks:
        assert out.count(old) == 1, (name, old)
        out = out.replace(old, new)
    return out


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_each_replaced_function_is_its_latest_body_plus_the_listed_hunks(self):
        for name in HUNKS:
            self.assertEqual(definition(M0147, name), rebuilt(name), name)

    def test_no_migration_between_the_source_and_0147_redefines_them(self):
        for name, (src, _) in HUNKS.items():
            later = [p.name for p in sorted(MIG.glob("*.sql"))
                     if src < p.name[:4] < "0147" and re.search(rf"create or replace function public\.{name}\(", p.read_text(encoding="utf-8"))]
            self.assertEqual(later, [], f"{name} was redefined after {src}: rebuild 0147 on the newer body")

    def test_it_defines_exactly_the_replaced_functions_and_the_two_credit_helpers(self):
        defined = re.findall(r"create or replace function public\.(\w+)\(", code(M0147))
        self.assertEqual(sorted(defined), sorted([*HUNKS, *NEW_FUNCTIONS]))

    def test_the_md5_pins_describe_the_bodies_in_the_files(self):
        for name, (before, _) in PINS.items():
            self.assertEqual(pg_md5(definition(SOURCES[HUNKS[name][0]], name)), before, name)
            self.assertIn(before, M0147, f"{name}: the drift guard does not name the earlier body's md5")
            self.assertIn(pg_md5(definition(M0147, name)), M0147, f"{name}: the drift guard / end state does not name 0147's md5")
        for name in NEW_FUNCTIONS:
            self.assertIn(pg_md5(definition(M0147, name)), M0147, name)


class EveryPlanMayConnect(unittest.TestCase):
    def test_no_function_of_0147_names_the_plan_gate(self):
        for name in HUNKS:
            if name.startswith("oauth_"):
                text = code(definition(M0147, name))
                self.assertNotIn("has_entitlement", text, name)
                self.assertNotIn("subscription_required", text, name)
                self.assertNotIn("paused_plan", text, name)

    def test_the_entitlement_is_retired_to_planned_and_true_for_every_plan(self):
        sql = code(M0147)
        self.assertRegex(sql, r"update public\.entitlement_keys\s+set status = 'planned', default_value = 'true'::jsonb,[\s\S]*?where key = 'mcp';")
        self.assertIn("update public.plan_entitlements set value = 'true'::jsonb where key = 'mcp'", sql)

    def test_the_credit_rule_is_untouched_create_video_still_holds_through_reserve_credits(self):
        # oauth_create_video is 0094's (not replaced here): the credit check before any spend is reserve_credits.
        self.assertNotRegex(code(M0147), r"function public\.oauth_create_video\(")
        latest = (MIG / "0094_extra_credits_toggle.sql").read_text(encoding="utf-8")
        cv = definition(latest, "oauth_create_video")
        self.assertIn("public.reserve_credits(v_org, v_ref, v_price)", cv)
        self.assertIn("'insufficient_credits'", cv)


class OneUnitPerToolCall(unittest.TestCase):
    def test_the_check_puts_a_credit_only_after_it_counted_and_admitted_the_request(self):
        chk = definition(M0147, "oauth_check")
        self.assertLess(chk.index("then\n    return public.api_err(429"), chk.index("oauth_check_credit_put("))
        self.assertLess(chk.index("public.oauth_rate_take("), chk.index("oauth_check_credit_put("))
        self.assertLess(chk.index("return public.api_err(401"), chk.index("oauth_check_credit_put("))

    def test_the_put_keeps_only_the_routes_request_id_shape_and_prunes_that_grant(self):
        put = code(definition(M0147, "oauth_check_credit_put"))
        self.assertIn("'^req_[A-Za-z0-9]{24}$'", put)
        self.assertIn("on conflict (grant_id, request_id) do nothing", put)
        self.assertRegex(put, r"delete from public\.oauth_check_credits c where c\.grant_id = p_grant and c\.created_at < now\(\) - interval '2 minutes'")

    def test_the_take_is_one_atomic_delete_returning_of_a_credit_younger_than_a_minute(self):
        take = code(definition(M0147, "oauth_check_credit_take"))
        self.assertEqual(len(re.findall(r"\bdelete from\b", take)), 1)
        self.assertRegex(take, r"delete from public\.oauth_check_credits c\s+where c\.grant_id = p_grant and c\.request_id = p_request_id "
                               r"and c\.created_at > now\(\) - interval '1 minute'\s+returning true into v_taken;")
        self.assertNotRegex(take, r"\bselect\b[^;]*from public\.oauth_check_credits")

    def test_the_free_read_does_not_increment_and_every_other_check_still_runs(self):
        ctx = code(definition(M0147, "oauth_ctx"))
        free = ctx[ctx.index("oauth_check_credit_take"):ctx.index("v_used := public.oauth_rate_take")]
        self.assertNotIn("insert", free)
        self.assertNotIn("update", free)
        self.assertIn("if v_used > v_rpm then", ctx)
        for still in ("public.oauth_token_state(p_hash)", "'not_available_for_connected_apps'", "'workspace_access_lost'",
                      "'insufficient_scope'", "public.is_org_member(v_org, 'admin')"):
            self.assertIn(still, ctx, still)

    def test_the_table_is_closed_to_every_api_role_and_dies_with_its_grant(self):
        self.assertIn("alter table public.oauth_check_credits enable row level security;", M0147)
        self.assertIn("revoke all on table public.oauth_check_credits from public, anon, authenticated, service_role;", M0147)
        self.assertRegex(M0147, r"grant_id\s+uuid not null references public\.oauth_grants \(id\) on delete cascade deferrable initially deferred")
        self.assertIn("primary key (grant_id, request_id)", M0147)
        self.assertNotRegex(code(M0147), r"grant [a-z, ]+ on (table )?public\.oauth_check_credits")

    def test_the_helpers_are_internal_and_the_replaced_functions_keep_their_grants(self):
        for sig in ("oauth_check_credit_put(uuid, text)", "oauth_check_credit_take(uuid, text)", "oauth_ctx(text, text, text)",
                    "oauth_limits()", "oauth_vendor_callbacks_only(text[])"):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", M0147)
            self.assertNotRegex(M0147, rf"grant execute on function public\.{re.escape(sig)}")
        for sig, role in (("oauth_check(text, text)", "anon"), ("oauth_register_client(text, text[], text)", "anon"), ("oauth_exchange_code(text, uuid, text, text, text, text, text)", "anon"),
                          ("oauth_refresh(text, uuid, text, text, text)", "anon"),
                          ("api_create_video(text, text, jsonb, text, text, text)", "anon"),
                          ("api_request_download(text, text, text, text, text, text)", "anon"),
                          ("oauth_begin_authorization(uuid, text, text, text, text, text, text, text)", "authenticated"),
                          ("oauth_decide_authorization(text, boolean, numeric, text)", "authenticated"),
                          ("oauth_my_grants()", "authenticated")):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", M0147, sig)
            self.assertIn(f"grant execute on function public.{sig} to {role};", M0147, sig)


class VendorRegistrations(unittest.TestCase):
    """A vendor's shared server registers for every person: its class has its own budgets, the ordinary class keeps 0093's."""

    def test_the_ordinary_class_keeps_0093s_numbers_and_the_vendor_class_is_bounded_by_its_row_cap(self):
        lim = definition(M0147, "oauth_limits")
        self.assertIn("'register_per_ip_hour', 10, 'register_global_hour', 300, 'max_clients', 20000,", lim)
        nums = dict((k, int(v)) for k, v in re.findall(r"'(register_vendor_per_ip_hour|register_vendor_global_hour|max_vendor_clients)', (\d+)", lim))
        self.assertEqual(nums, {"register_vendor_per_ip_hour": 300, "register_vendor_global_hour": 2000, "max_vendor_clients": 60000})
        # A flood held at the hourly ceiling for the collector's 24 hours cannot fill the class.
        self.assertLess(nums["register_vendor_global_hour"] * 24, nums["max_vendor_clients"])
        self.assertIn("c2.created_at < now() - interval '24 hours'", definition(M0093, "oauth_gc"))
        self.assertNotRegex(code(M0147), r"function public\.oauth_gc\(")

    def test_the_class_is_generated_from_the_stored_uris_and_every_uri_must_be_a_vendor_callback(self):
        self.assertIn("add column if not exists vendor boolean generated always as (public.oauth_vendor_callbacks_only(redirect_uris)) stored", M0147)
        fn = code(definition(M0147, "oauth_vendor_callbacks_only"))
        self.assertIn("language sql immutable", fn)
        self.assertIn("not exists (", fn)
        for exact in ("'https://claude.ai/api/mcp/auth_callback'", "'https://chatgpt.com/connector_platform_oauth_redirect'",
                      "'^https://chatgpt\\.com/connector/oauth/[A-Za-z0-9_-]{1,64}$'",
                      "'https://grok.com/connectors-oauth-exchange-code/'",
                      "'^https://oauth-redirect\\.googleusercontent\\.com/[ra]/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'"):
            self.assertIn(exact, fn)

    def test_every_count_of_the_registration_is_per_class(self):
        reg = code(definition(M0147, "oauth_register_client"))
        counts = re.findall(r"select count\(\*\) from public\.oauth_clients([^)]*)\)", reg)
        self.assertEqual(len(counts), 3)
        for where in counts:
            self.assertIn("vendor = v_vendor", where)


class SpendLimitRemedies(unittest.TestCase):
    def test_each_spend_limit_refusal_names_where_it_is_raised(self):
        for codename in ("monthly_limit_reached", "key_limit_reached"):
            msgs = re.findall(rf"api_err\(\d{{3}}, '{codename}',\s*'((?:[^']|'')*)'", M0147)
            self.assertEqual(len(msgs), 2, codename)
            for m in msgs:
                self.assertIn("Developer console: Developers → ", m)


class Rollback(unittest.TestCase):
    def test_puts_every_earlier_body_back_verbatim(self):
        for name, (src, _) in HUNKS.items():
            self.assertEqual(definition(ROLLBACK, name), definition(SOURCES[src], name), name)

    def test_drops_the_credits_restores_the_entitlement_and_runs_as_one_transaction(self):
        self.assertIn("drop table if exists public.oauth_check_credits;", ROLLBACK)
        self.assertIn("drop function if exists public.oauth_check_credit_put(uuid, text);", ROLLBACK)
        self.assertIn("drop function if exists public.oauth_check_credit_take(uuid, text);", ROLLBACK)
        self.assertIn("set status = 'enforced'", ROLLBACK)
        self.assertIn("value = 'false'::jsonb where key = 'mcp' and plan_id = 'free'", ROLLBACK)
        self.assertTrue(ROLLBACK.lstrip().splitlines()[0].startswith("-- rollback_0147"))
        self.assertIn("\nbegin;\n", ROLLBACK)
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;"))

    def test_the_migration_is_documented(self):
        self.assertIn("0147_mcp_free_tier.sql", MIGRATIONS_DOC)
        self.assertIn("rollback_0147_mcp_free_tier.sql", MIGRATIONS_DOC)
        self.assertIn("test_sec_mcp_free_tier.py", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
