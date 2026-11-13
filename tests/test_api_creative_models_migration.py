"""supabase/migrations/0162_api_creative_models.sql — the MCP Studio tools' two read-only API functions.

SQL does not run in this suite (tests/security/test_sec_mcp_studio_tools.py does that, against a real Postgres); these pin what must
never change by accident: two volatile SECURITY DEFINER functions with a pinned search_path and nothing else; the anon role only (the
API's door), never authenticated or service_role; api_begin first, with the scope that gates them (creative:quote, creative:read);
nothing that holds, charges or writes; the model list is the API's sellable set narrowed by create's own entitlement rule and carries
no price; a generation's files are read only for a job THIS key started (api_creative_get's rule, word for word); the md5 in the drift
guard and in the rollback is each body's own; the number is unique and documented.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0162_api_creative_models.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0162_api_creative_models.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
SIGS = {
    "api_creative_models": "public.api_creative_models(text, text, text)",
    "api_creative_job_files": "public.api_creative_job_files(text, uuid, text)",
}


def definition(name: str, sql: str = SQL) -> str:
    m = re.search(rf"^create or replace function public\.{name}\(.*?^\$\$;$", sql, re.S | re.M)
    assert m, name
    return m.group(0)


def body(name: str, sql: str = SQL) -> str:
    return definition(name, sql).split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(name: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body(name)).encode()).hexdigest()


class ApiCreativeModelsMigration(unittest.TestCase):
    def test_two_functions_and_nothing_else(self):
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", CODE), list(SIGS))
        self.assertNotRegex(CODE, r"create table|alter table|create (unique )?index|drop |create (or replace )?view|create policy|create trigger")

    def test_volatile_definers_with_a_pinned_search_path(self):
        # volatile, like every api_* entry point: api_begin counts the request and api_finish logs it.
        for name in SIGS:
            head = definition(name).split("as $$", 1)[0]
            self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp", head, name)

    def test_the_anon_role_only(self):
        for sig in SIGS.values():
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", CODE)
            self.assertIn(f"grant execute on function {sig} to anon;", CODE)
            self.assertNotRegex(CODE, rf"grant execute on function {re.escape(sig)} to (authenticated|service_role)")

    def test_api_begin_first_with_the_scope_that_gates_each(self):
        models = body("api_creative_models")
        self.assertIn("ctx    jsonb := public.api_begin(p_key_hash, 'creative.quote', p_request_id);", models)
        self.assertIn("ctx := ctx || jsonb_build_object('endpoint', 'creative.models');", models)
        files = body("api_creative_job_files")
        self.assertIn("ctx     jsonb := public.api_begin(p_key_hash, 'creative.get', p_request_id);", files)
        for name in SIGS:
            inside = body(name).split("\nbegin\n", 1)[1]
            self.assertTrue(inside.lstrip().startswith("if not (ctx ->> 'ok')::boolean then\n    return ctx;"), name)
        # api_endpoint_scope (0062) and oauth_endpoint_scope (0093) are not replaced: the scopes are theirs.
        self.assertNotIn("api_endpoint_scope", CODE)
        self.assertNotIn("oauth_endpoint_scope", CODE)

    def test_read_only_nothing_held_or_charged(self):
        for name in SIGS:
            low = body(name).lower()
            for verb in ("insert into", "update public", "delete from", "truncate", "perform ", "set_config",
                         "create_creative_job", "reserve_credits", "capture", "release", "grant_credits"):
                self.assertNotIn(verb, low, f"{name}: {verb}")

    def test_the_model_list_is_the_api_sellable_set_narrowed_by_creates_entitlement_rule_and_has_no_price(self):
        b = body("api_creative_models")
        self.assertIn("from public.sellable_models(v_cap, 'api') s", b)
        self.assertIn("where coalesce(s.entitlement, 'any') = 'any'\n          or (s.entitlement = 'paid' and v_paid);", b)
        self.assertIn("v_paid := public.credits_exempt(v_org)\n                or exists (select 1 from public.credit_transactions t where t.org_id = v_org and t.kind = 'purchase');", b)
        # The same two branches as creative_price's entitlement check, in the latest body that has them (0156).
        price = (MIG / "0156_named_resolution_params.sql").read_text(encoding="utf-8")
        self.assertIn("if not preview and coalesce(m_ent, 'any') not in ('any', 'paid') then", price)
        self.assertIn("where t.org_id = p_org and t.kind = 'purchase') then", price)
        for priced in ("credits_per_unit", "margin", "credit_unit", "price"):
            self.assertNotIn(priced, re.sub(r"--.*", "", b), priced)
        self.assertIn("'spec', s.spec - 'api_exposure'", b)

    def test_files_only_for_a_job_this_key_started_like_api_creative_get(self):
        files = body("api_creative_job_files")
        get = body("api_creative_get", (MIG / "0062_api_creative.sql").read_text(encoding="utf-8"))
        rule = (
            "    select c.* into j\n"
            "      from public.creative_jobs c\n"
            "      join public.api_creative_jobs a on a.job_id = c.id\n"
            "     where c.id = p_job_id\n"
            "       and a.key_id = (ctx ->> 'key_id')::uuid\n"
            "       and a.org_id = c.org_id\n"
            "       and c.org_id = (ctx ->> 'org_id')::uuid;\n"
        )
        self.assertIn(rule, files)
        self.assertIn(rule, get)
        self.assertIn("where m.id = any (j.result_asset_ids)\n       and m.org_id = j.org_id\n       and m.deleted_at is null\n       and m.storage = 'local';", files)
        self.assertIn("public.api_ok(public.api_creative_job_json(j) || jsonb_build_object('files', v_files))", files)

    def test_the_drift_guard_and_the_rollback_carry_each_bodys_own_md5(self):
        for name, sig in SIGS.items():
            h = pg_md5(name)
            self.assertIn(f"where p.oid = to_regprocedure('{sig}');\n  if h is not null and h <> '{h}' then", SQL, name)
            self.assertIn(f"where p.oid = to_regprocedure('{sig}');\n  if h is not null and h <> '{h}' then", ROLLBACK, name)
            self.assertIn(f"drop function if exists {sig};", ROLLBACK)

    def test_the_rollback_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)

    def test_the_number_is_unique_and_documented(self):
        numbers = [p.name[:4] for p in MIG.glob("*.sql")]
        self.assertEqual(numbers.count("0162"), 1)
        self.assertIn("## The MCP Studio tools' model list and result files (0162)", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
