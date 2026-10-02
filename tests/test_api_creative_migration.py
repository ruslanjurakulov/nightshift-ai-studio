"""Migration 0062 (creative generations through the public API), read as text.

0062 replaces two functions — api_begin, which every API entry point starts
from, and api_auth — and CLAUDE.md forbids a `create or replace` that drops an
earlier check. So each is pinned to its latest earlier definition (0042),
identical once the documented additions are taken away, and every string
literal of the old body must still be in the new one. The database-side
behaviour is attacked in tests/security/test_sec_api_creative.py.
"""

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
M42 = (MIGRATIONS / "0042_web_api_hardening.sql").read_text()
M62 = (MIGRATIONS / "0062_api_creative.sql").read_text()


def definition(src: str, name: str) -> str:
    found = re.findall(r"^create or replace function public\.%s\(.*?^\$\$;\n" % name, src, re.S | re.M)
    assert found, f"{name} is not defined"
    return found[-1]


def literals(sql: str) -> list:
    code = "\n".join(re.sub(r"--.*$", "", line) for line in sql.split("\n"))
    return re.findall(r"'((?:[^']|'')*)'", code)


def without(sql: str, *parts: str) -> str:
    for p in parts:
        assert sql.count(p) == 1, p
        sql = sql.replace(p, "")
    return sql


SCOPE_CHECK = """
    -- 0062: what this key may do. A key made before 0062 (scopes null) keeps
    -- the three scopes it always had and nothing new; an endpoint with no
    -- scope of its own is refused, never allowed.
    v_scope := public.api_endpoint_scope(p_endpoint);
    if v_scope is not null and not (v_scope = any (coalesce(k.scopes, public.api_legacy_scopes()))) then
      return public.api_finish(ctx, public.api_err(403, 'insufficient_scope',
        format('This key does not have the %s scope.', v_scope),
        jsonb_build_object('required_scope', v_scope)));
    end if;
"""

ENTRY = ["api_creative_quote", "api_creative_create", "api_creative_get"]
OK_CHECK = "begin\n  if not (ctx ->> 'ok')::boolean then\n    return ctx;\n  end if;\n"


class ReplacedFunctionsTestCase(unittest.TestCase):
    def test_api_begin_is_0042s_body_plus_exactly_the_documented_additions(self):
        old, new = definition(M42, "api_begin"), definition(M62, "api_begin")
        # The additions, taken out of the new body, leave 0042's body byte for byte.
        back = new
        for a, b in [
            ("  v_rpm    integer;\n  v_scope  text;\n", ""),
            ("  v_rpm := least(lim.rpm, coalesce(k.rpm_limit, lim.rpm));\n", ""),
            ("'rpm', v_rpm, 'concurrency', lim.concurrency,\n    'scopes', to_jsonb(coalesce(k.scopes, public.api_legacy_scopes())),",
             "'rpm', lim.rpm, 'concurrency', lim.concurrency,"),
            ("'remaining', greatest(0, v_rpm - v_used)", "'remaining', greatest(0, lim.rpm - v_used)"),
            ("if v_used > v_rpm then", "if v_used > lim.rpm then"),
            ("on usage tier %s.', v_rpm, v_tier),", "on usage tier %s.', lim.rpm, v_tier),"),
            (SCOPE_CHECK, ""),
        ]:
            self.assertEqual(back.count(a), 1, a)
            back = back.replace(a, b)
        self.assertEqual(back, old)

    def test_api_begin_keeps_every_check_and_message_it_had(self):
        old, new = literals(definition(M42, "api_begin")), literals(definition(M62, "api_begin"))
        for lit in old:
            self.assertIn(lit, new, f"0062's api_begin dropped {lit!r}")
        for must in ("invalid_api_key", "api_not_activated", "rate_limit_exceeded", "key_owner_not_admin", "internal_error"):
            self.assertIn(must, new)

    def test_api_begin_checks_the_scope_after_the_creator_and_before_use(self):
        fn = definition(M62, "api_begin")
        self.assertLess(fn.index("key_owner_not_admin"), fn.index("v_scope := public.api_endpoint_scope(p_endpoint);"))
        self.assertLess(fn.index("v_scope := public.api_endpoint_scope(p_endpoint);"), fn.index("update public.api_keys set last_used_at"))
        self.assertIn("coalesce(k.scopes, public.api_legacy_scopes())", fn)

    def test_api_auth_is_0042s_body_plus_the_keys_scopes(self):
        old, new = definition(M42, "api_auth"), definition(M62, "api_auth")
        back = new.replace("jsonb_build_object('id', k.id, 'name', k.name, 'scopes', ctx -> 'scopes')",
                           "jsonb_build_object('id', k.id, 'name', k.name)")
        self.assertEqual(back, old)

    def test_the_replaced_functions_keep_their_grants(self):
        self.assertRegex(M62, r"grant execute on function public\.api_auth\(text, text\) to anon;")
        self.assertRegex(M62, r"revoke all on function public\.api_begin\(text, text, text\) from public, anon, authenticated, service_role;")
        self.assertNotRegex(M62, r"grant execute on function public\.api_begin")


class ScopesTestCase(unittest.TestCase):
    def test_every_endpoint_that_exists_is_mapped_to_a_scope(self):
        endpoints = set(re.findall(r"api_begin\(p_key_hash, '([a-z_.]+)'", M42 + M62))
        self.assertGreaterEqual(len(endpoints), 14)
        mapping = definition(M62, "api_endpoint_scope")
        for ep in endpoints:
            self.assertIn(f"when '{ep}' then", mapping, ep)

    def test_an_unmapped_endpoint_is_closed_and_only_me_is_open(self):
        mapping = definition(M62, "api_endpoint_scope")
        self.assertIn("else 'none'", mapping)
        self.assertEqual(re.findall(r"when '([a-z_.]+)' then null", mapping), ["me"])

    def test_the_scope_names_match_between_the_check_and_the_mapping(self):
        valid = set(re.findall(r"'([a-z]+:[a-z]+)'", definition(M62, "api_scopes_valid")))
        mapped = set(re.findall(r"then '([a-z]+:[a-z]+)'", definition(M62, "api_endpoint_scope")))
        legacy = set(re.findall(r"'([a-z]+:[a-z]+)'", definition(M62, "api_legacy_scopes")))
        self.assertEqual(valid, mapped)
        self.assertTrue(legacy < valid)
        self.assertFalse(legacy & {"creative:quote", "creative:create", "creative:read"},
                         "a key made before 0062 must not gain the right to spend credits")

    def test_a_key_made_before_0062_gains_no_scope(self):
        self.assertRegex(M62, r"alter table public\.api_keys add column if not exists scopes text\[\];")
        # scopes are only ever written for ONE named key, never in bulk
        for stmt in re.findall(r"update public\.api_keys\s+set scopes.*?;", M62, re.S):
            self.assertRegex(stmt, r"where id = ", stmt)
        self.assertNotIn("scopes text[] not null", M62)


class EntryPointsTestCase(unittest.TestCase):
    def test_every_entry_point_starts_from_the_key_and_stops_when_it_refuses(self):
        for name in ENTRY:
            fn = definition(M62, name)
            self.assertRegex(fn, r"ctx\s+jsonb := public\.api_begin\(p_key_hash, 'creative\.[a-z]+', p_request_id\);", name)
            self.assertIn("if not (ctx ->> 'ok')::boolean then\n    return ctx;\n  end if;", fn, name)

    def test_the_organization_is_the_keys_never_a_parameter(self):
        for name in ENTRY:
            header = re.search(r"function public\.%s\((.*?)\)\s+returns" % name, definition(M62, name), re.S).group(1)
            self.assertNotIn("p_org", header, name)
            self.assertIn("(ctx ->> 'org_id')::uuid", definition(M62, name))

    def test_each_entry_point_is_anon_only(self):
        for name in ENTRY:
            self.assertRegex(M62, r"grant execute on function public\.%s\([^)]*\) to anon;" % name)
            self.assertNotRegex(M62, r"grant execute on function public\.%s\([^)]*\) to [^;]*authenticated" % name)

    def test_create_uses_the_uis_function_and_moves_no_credit_itself(self):
        fn = definition(M62, "api_creative_create")
        self.assertIn("public.create_creative_job(v_org, v_cap, v_model, v_p,", fn)
        for forbidden in ("reserve_credits", "capture_credits", "release_credits", "credit_reservations",
                          "credit_transactions", "update public.creative_jobs", "insert into public.creative_jobs"):
            self.assertNotIn(forbidden, fn, forbidden)

    def test_create_requires_an_idempotency_key_and_max_credits(self):
        fn = definition(M62, "api_creative_create")
        self.assertIn("if p_idem_key is null then", fn)
        self.assertIn("idempotency_key_required", fn)
        self.assertIn("if p_max_credits is null or p_max_credits < 0 then", fn)
        self.assertIn("max_credits_required", fn)
        # ... and both are checked before anything is claimed or held
        self.assertLess(fn.index("max_credits_required"), fn.index("api_idem_begin"))
        self.assertLess(fn.index("api_idem_begin"), fn.index("create_creative_job"))

    def test_the_jobs_idempotency_key_is_namespaced_by_the_api_key(self):
        fn = definition(M62, "api_creative_create")
        self.assertIn("v_idem := 'api-' || encode(sha256(convert_to(v_key::text || ':' || p_idem_key, 'UTF8')), 'hex');", fn)

    def test_the_model_must_be_sellable_on_the_api_surface(self):
        self.assertIn("sellable_models(p_capability, 'api')", definition(M62, "api_creative_model_ok"))
        for name in ("api_creative_quote", "api_creative_create"):
            self.assertIn("public.api_creative_model_ok(v_cap, v_model)", definition(M62, name), name)

    def test_a_quote_does_not_show_the_organizations_balance(self):
        self.assertIn("v_q - 'available'", definition(M62, "api_creative_quote"))

    def test_a_key_reads_only_its_own_jobs_in_its_own_organization(self):
        fn = definition(M62, "api_creative_get")
        for part in ("a.key_id = (ctx ->> 'key_id')::uuid", "a.org_id = c.org_id", "c.org_id = (ctx ->> 'org_id')::uuid"):
            self.assertIn(part, fn)

    def test_a_failure_is_structured_and_the_work_is_in_a_block(self):
        for name in ENTRY:
            fn = definition(M62, name)
            self.assertIn("exception when others then", fn, name)
            self.assertRegex(fn, r"api_err\(500, 'internal_error',\n\s+'The request failed inside the database\. Nothing was created or charged; retry with backoff\.'\)", name)

    def test_the_job_json_has_no_internals(self):
        fn = definition(M62, "api_creative_job_json")
        for internal in ("worker_id", "provider_task_id", "credit_ref", "route", "params", "payer", "org_id", "requested_by", "request_hash"):
            self.assertNotIn(f"'{internal}'", fn, internal)


class PrivilegesTestCase(unittest.TestCase):
    def test_the_helpers_are_not_callable_by_any_api_role(self):
        for name, sig in [("api_scopes_valid", "text[]"), ("api_legacy_scopes", ""), ("api_endpoint_scope", "text"),
                          ("api_creative_month_credits", "uuid"), ("api_creative_model_ok", "text, text"),
                          ("api_creative_job_json", "public.creative_jobs"), ("api_creative_refusal", "text, text, text")]:
            self.assertIn(f"revoke all on function public.{name}({sig}) from public, anon, authenticated, service_role;", M62, name)
            self.assertNotRegex(M62, r"grant execute on function public\.%s\(" % name)

    def test_the_console_calls_are_for_signed_in_users_and_check_the_role_themselves(self):
        for name in ("create_scoped_api_key", "set_api_key_access"):
            self.assertRegex(M62, r"grant execute on function public\.%s\([^)]*\) to authenticated;" % name)
            self.assertNotRegex(M62, r"grant execute on function public\.%s\([^)]*\) to [^;]*(anon|service_role)" % name)
            self.assertIn("is_org_member(", definition(M62, name))
            self.assertIn("'admin'", definition(M62, name))

    def test_the_link_table_has_rls_and_no_write_grant(self):
        self.assertIn("alter table public.api_creative_jobs enable row level security;", M62)
        self.assertIn("revoke all on public.api_creative_jobs from public, anon, authenticated, service_role;", M62)
        self.assertRegex(M62, r"grant select on public\.api_creative_jobs to authenticated, service_role;")
        self.assertNotRegex(M62, r"grant (insert|update|delete)[^;]*api_creative_jobs")

    def test_the_key_hash_stays_unreadable(self):
        self.assertNotIn("key_hash", re.search(r"grant select \(([^)]*)\) on public\.api_keys", M62).group(1))

    def test_every_function_has_a_pinned_search_path(self):
        for m in re.finditer(r"create or replace function public\.(\w+)\((.*?)\$\$", M62, re.S):
            self.assertIn("set search_path = public, pg_temp", m.group(2), m.group(1))


if __name__ == "__main__":
    unittest.main()
