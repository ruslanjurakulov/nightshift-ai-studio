"""supabase/migrations/0175_mcp_oauth_creative.sql — the Studio's generations for an AI assistant connected with OAuth.

SQL does not run in this suite (tests/security/test_sec_mcp_oauth_creative.py does that, against a real Postgres); these pin what
must never change by accident: every model is OFF for assistants unless the registry file says so for that model, and no model does
yet; the switch is JSON true only; the three replaced 0093 bodies are 0093's plus marked hunks, and the md5 in the drift guard and the
rollback is each body's own; create takes a quote id and an idempotency key and nothing that could differ from the quote; the five
doors open with oauth_ctx (a connection's), never api_begin (which would also admit an API key); the API key's creative endpoints stay
off the token allow-list; the number is listed and documented.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0175_mcp_oauth_creative.sql").read_text(encoding="utf-8")
SQL_0093 = (MIG / "0093_mcp_oauth.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0175_mcp_oauth_creative.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
REGISTRY = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
OPERATIONS_TS = (ROOT / "command-center" / "lib" / "api" / "operations.ts").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

#: The models a reviewed change has switched on for connected assistants, each with the vendor terms that allow it. Empty: every
#: model is off until a separate review of its vendor's terms says "the same end user, through their own assistant" is allowed.
#: Adding an id here is that review's change, never a default.
REVIEWED_FOR_ASSISTANTS: dict = {}

DOORS = {
    "oauth_creative_models": ("public.oauth_creative_models(text, text, text)", "oauth.creative.models"),
    "oauth_media_list": ("public.oauth_media_list(text, text, integer, text)", "oauth.media.list"),
    "oauth_creative_quote": ("public.oauth_creative_quote(text, text, text, jsonb, text)", "oauth.creative.quote"),
    "oauth_creative_create": ("public.oauth_creative_create(text, uuid, text, text)", "oauth.creative.create"),
    "oauth_creative_get": ("public.oauth_creative_get(text, uuid, text)", "oauth.creative.get"),
}
REPLACED = {
    "oauth_scopes_supported": ("b1cdcf014109e5902d0e6d9f05767186", "3ef7e3154b00584e7625225d20dfa705"),
    "oauth_endpoint_scope": ("ade9dedd7a1058b4938e9df7e8bd1b87", "8d0d2c6e236fde2b82aed988a7e7f377"),
    "oauth_grant_month_credits": ("6329f5ed73f203e67e31e885238fa1ab", "4a3f226949bf5b91529a4e60d943fff3"),
}


def definition(name: str, sql: str = SQL) -> str:
    m = re.search(rf"^create or replace function public\.{name}\(.*?^\$\$;$", sql, re.S | re.M)
    assert m, name
    return m.group(0)


def body(name: str, sql: str = SQL) -> str:
    return definition(name, sql).split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(name: str, sql: str = SQL) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body(name, sql)).encode()).hexdigest()


def squash(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


class EveryModelIsOff(unittest.TestCase):
    def test_no_model_in_the_registry_is_offered_to_assistants_without_a_review(self):
        on = sorted(m["id"] for m in REGISTRY["models"] if m.get("mcp_oauth_exposure") is True)
        self.assertEqual(on, sorted(REVIEWED_FOR_ASSISTANTS), "a model offered to connected assistants needs its vendor-terms review here")

    def test_the_migration_turns_nothing_on(self):
        self.assertNotRegex(CODE, r"update public\.model_registry|sync_model_registry|insert into public\.model_registry")
        self.assertNotRegex(CODE, r"mcp_oauth_exposure'\s*,\s*'true'|'\{\"mcp_oauth_exposure\": true")

    def test_only_json_true_switches_a_model_on(self):
        state = body("oauth_creative_model_state")
        self.assertIn("(r.spec -> 'mcp_oauth_exposure') is distinct from 'true'::jsonb", state)
        # The switch is its own: api_exposure (the developer API's) is never read as an assistant's permission.
        self.assertNotIn("api_exposure", state)

    def test_the_gate_refuses_what_an_assistant_cannot_honour(self):
        state = squash(body("oauth_creative_model_state"))
        self.assertIn("r.spec ? 'blocked_countries'", state)
        self.assertIn("'acknowledgement_required'", state)
        self.assertIn("to_jsonb(r) -> 'requires_acknowledgement'", state)  # 0174's column, read without naming it
        self.assertIn("sellable_models(cap, 'web')", state)
        self.assertIn("'captions' = any (r.capabilities)", state)

    def test_the_capabilities_are_the_apis(self):
        sql_caps = re.findall(r"'([a-z_0-9]+)'", body("oauth_creative_capabilities"))
        m = re.search(r"export const API_CREATIVE_CAPABILITIES = \[(.*?)\]", OPERATIONS_TS, re.S)
        self.assertIsNotNone(m)
        self.assertEqual(sql_caps, re.findall(r'"([a-z_0-9]+)"', m.group(1)))
        self.assertNotIn("captions", sql_caps)


class TheMoney(unittest.TestCase):
    def test_create_takes_a_quote_and_a_key_and_nothing_that_could_differ_from_the_quote(self):
        head = definition("oauth_creative_create").split("returns", 1)[0]
        self.assertEqual(squash(head), "create or replace function public.oauth_creative_create(p_token_hash text, p_quote_id uuid, p_idem_key text, p_request_id text default null)")

    def test_create_runs_the_studios_own_function_with_the_quote_as_max_credits(self):
        b = squash(body("oauth_creative_create"))
        self.assertIn("public.create_creative_job(v_org, q.capability, q.model, q.params, 'exact', v_key, q.credits)", b)
        self.assertIn("if v_price is distinct from q.credits then", b)
        self.assertIn("if j.quoted_credits is distinct from q.credits then", b)
        self.assertIn("where id = p_quote_id and grant_id = v_grant and org_id = v_org for update", b)
        self.assertIn("q.expires_at <= now()", b)
        self.assertIn("public.oauth_grant_month_credits(v_grant)", b)
        self.assertIn("public.credit_account_lock(v_org)", b)
        # The connection's own idempotency namespace, long enough for 0036's key rule.
        self.assertIn("v_key := 'oa-' || encode(sha256(convert_to(v_grant::text || ':' || v_idem, 'UTF8')), 'hex')", b)
        # The same audit row the API path writes, under the action the list has.
        self.assertIn("'creative.generate'", b)
        self.assertIn("'via', 'mcp_oauth'", b)

    def test_create_comes_before_its_audit_and_link_rows_and_the_limit_before_the_hold(self):
        b = body("oauth_creative_create")
        self.assertLess(b.index("oauth_grant_month_credits(v_grant)"), b.index("public.create_creative_job("))
        self.assertLess(b.index("public.create_creative_job("), b.index("insert into public.oauth_creative_jobs"))

    def test_the_month_counts_videos_and_generations(self):
        b = squash(body("oauth_grant_month_credits"))
        self.assertIn("from public.oauth_runs r where r.grant_id = p_grant", b)
        self.assertIn("from public.oauth_creative_jobs c where c.grant_id = p_grant", b)
        self.assertIn("when 'open' then cr.amount when 'captured' then coalesce(cr.captured, cr.amount) else 0 end", b)

    def test_no_price_is_computed_here(self):
        # The quote is creative_price's: no rate table, margin or rounding of our own.
        for word in ("credit_prices", "margin", "credits_round_up", "credits_per_unit *"):
            self.assertNotIn(word, CODE, word)


class TheDoors(unittest.TestCase):
    def test_each_door_opens_with_oauth_ctx_never_api_begin(self):
        for name, (_sig, endpoint) in DOORS.items():
            b = body(name)
            self.assertIn(f"public.oauth_ctx(p_token_hash, '{endpoint}', p_request_id)", b, name)
            self.assertNotIn("api_begin(", b, name)

    def test_the_anon_role_only(self):
        for sig, _e in DOORS.values():
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", CODE)
            self.assertIn(f"grant execute on function {sig} to anon;", CODE)
        self.assertEqual(len(re.findall(r"^grant ", CODE, re.M)), len(DOORS))

    def test_the_allow_list_is_0093s_plus_the_five_doors_behind_studio_create(self):
        new = set(re.findall(r"when '([a-z.]+)' then '([a-z:]+)'", body("oauth_endpoint_scope")))
        old = set(re.findall(r"when '([a-z.]+)' then '([a-z:]+)'", body("oauth_endpoint_scope", SQL_0093)))
        self.assertEqual(new - old, {(e, "studio:create") for _s, e in DOORS.values()})
        self.assertTrue(old <= new)
        self.assertNotIn("else", squash(body("oauth_endpoint_scope")).replace("case p_endpoint", ""))
        for api_endpoint in ("creative.quote", "creative.create", "creative.get", "creative.models"):
            self.assertNotIn(f"'{api_endpoint}'", body("oauth_endpoint_scope"))

    def test_studio_create_is_a_new_permission(self):
        self.assertIn("'studio:create'", body("oauth_scopes_supported"))
        self.assertIn("cardinality(scopes) between 1 and 4", CODE)

    def test_record_tables_are_closed_to_every_api_role(self):
        for t in ("oauth_creative_quotes", "oauth_creative_jobs", "oauth_creative_rate_counters"):
            self.assertIn(f"alter table public.{t} enable row level security;", CODE)
            self.assertIn(f"revoke all on table public.{t} from public, anon, authenticated, service_role;", CODE)
        self.assertNotIn("create policy", CODE)


class HouseStyle(unittest.TestCase):
    def test_the_drift_guard_names_0093s_body_and_this_files_own(self):
        for name, (before, after) in REPLACED.items():
            self.assertEqual(pg_md5(name, SQL_0093), before, name)
            self.assertEqual(pg_md5(name), after, name)
            self.assertIn(f"'{before}', '{after}'", SQL, name)
            self.assertIn(after, ROLLBACK, name)
            self.assertIn(before, ROLLBACK, name)

    def test_the_rollback_puts_0093s_bodies_back_byte_for_byte_and_keeps_the_record(self):
        for name, (before, _after) in REPLACED.items():
            self.assertEqual(pg_md5(name, ROLLBACK), before, name)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertNotRegex(ROLLBACK, r"drop table")
        self.assertIn("studio:create", ROLLBACK)

    def test_applied_as_one_transaction_with_a_verify_query(self):
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify"):
            self.assertIn(needle, SQL)
        self.assertIn("set local lock_timeout", CODE)

    def test_the_number_is_unique_and_documented(self):
        self.assertEqual(len(list(MIG.glob("0175_*.sql"))), 1)
        self.assertIn("(0175)", MIGRATIONS_DOC)
        self.assertIn("0175_mcp_oauth_creative.sql", MIGRATIONS_DOC)

    def test_create_creative_job_is_not_replaced(self):
        # 0174 (PR #780) replaces it; this file must only call it.
        self.assertNotIn("create or replace function public.create_creative_job", SQL)
        self.assertNotIn("create or replace function public.creative_price", SQL)
        self.assertNotIn("create or replace function public.sellable_models", SQL)


if __name__ == "__main__":
    unittest.main()
