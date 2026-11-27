"""supabase/migrations/0219_oauth_creative_operator_models.sql — the operator route for connected assistants.

SQL does not run in this suite (tests/security/test_sec_oauth_creative_operator.py does that, against a real Postgres); these pin
what must never change by accident: the operator route is exactly the operator's own organization (credits_exempt, i.e.
default_org_id()); a ByteDance model is refused before anything else, for every organization; every other organization gets 0191's
judgement, called as it is; the operator route skips only the two third-party gates and keeps every other one; the three doors are
0192's / 0191's bodies plus marked hunks, and the md5 in the drift guard and the rollback is each body's own; create re-asks the
judgement and refuses a quote whose route changed; the job and the audit row record the route; the rollback puts the earlier bodies
back byte for byte; the number is listed and documented.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0219_oauth_creative_operator_models.sql").read_text(encoding="utf-8")
SQL_0191 = (MIG / "0191_mcp_oauth_creative.sql").read_text(encoding="utf-8")
SQL_0192 = (MIG / "0192_adult_attestation.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0219_oauth_creative_operator_models.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

#: name -> (the file whose body it replaces, md5 before, md5 after)
REPLACED = {
    "oauth_creative_models": (SQL_0192, "beafb530957690f51366c995468ad36f", "3c19fec218d8b140008495a635e57317"),
    "oauth_creative_quote": (SQL_0192, "e3340606260711781f202aff7abdcdee", "13c960060df92c6e250c6f5e95dddab9"),
    "oauth_creative_create": (SQL_0191, "527ce6685df6651507bb9fbd186a1c0c", "86e36ace55f20829fa7c4da91f9eef9f"),
}
STATE_0191 = "45811a3b219fa2414b3820c34ee247de"


def definition(name: str, sql: str = SQL) -> str:
    ms = re.findall(rf"^create or replace function public\.{name}\(.*?^\$\$;$", sql, re.S | re.M)
    assert ms, name
    return ms[-1]


def body(name: str, sql: str = SQL) -> str:
    return definition(name, sql).split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(name: str, sql: str = SQL) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body(name, sql)).encode()).hexdigest()


def squash(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def code(text: str) -> str:
    """text without its -- comments, squashed: what Postgres runs."""
    return squash("\n".join(ln.split("--", 1)[0] for ln in text.splitlines()))


def unmarked(text: str) -> list:
    """The lines of a body that are not comments, squashed, for a line-level comparison of two bodies."""
    return [squash(ln.split("--", 1)[0]) for ln in text.splitlines() if squash(ln.split("--", 1)[0])]


class TheOperatorRoute(unittest.TestCase):
    def test_the_operator_is_exactly_the_credits_exempt_organization(self):
        self.assertEqual(squash(body("oauth_creative_operator_org")), "select public.credits_exempt(p_org)")
        self.assertIn("select p_org is not distinct from public.default_org_id()",
                      squash((MIG / "0020_credits.sql").read_text(encoding="utf-8")))

    def test_bytedance_is_refused_first_for_every_organization(self):
        state = body("oauth_creative_org_model_state")
        first = state.index("public.oauth_creative_bytedance(mdl)")
        self.assertLess(first, state.index("public.oauth_creative_model_state(cap, mdl)"))
        self.assertLess(first, state.index("public.oauth_creative_operator_org(p_org)"))
        b = squash(body("oauth_creative_bytedance"))
        for needle in ("'(seedance|seedream)'", "lower(m.provider) in ('bytedance', 'byteplus')",
                       "m.adapter ~* '^(video[.]seedance|image[.]seedream)'", "m.spec ->> 'vendor_model'"):
            self.assertIn(needle, b, needle)

    def test_everyone_else_gets_0191s_answer_word_for_word(self):
        state = code(body("oauth_creative_org_model_state"))
        self.assertIn("v := public.oauth_creative_model_state(cap, mdl); "
                      "if v <> 'not_offered' or not public.oauth_creative_operator_org(p_org) then return v; end if;", state)
        # 0191's judgement is not replaced, and the guard insists on its body.
        self.assertNotIn("create or replace function public.oauth_creative_model_state(", SQL)
        self.assertEqual(pg_md5("oauth_creative_model_state", SQL_0191), STATE_0191)
        self.assertIn(f"'{STATE_0191}', '{STATE_0191}', '0191'", SQL)

    def test_the_operator_route_skips_only_the_two_third_party_gates(self):
        state = code(body("oauth_creative_org_model_state"))
        route = state.split("return v; end if;", 1)[1]
        # Kept: the API's capabilities (never captions), blocked countries, the acknowledgement, the owner's switch, on sale on the web.
        for needle in ("cap = any (public.oauth_creative_capabilities())", "'captions' = any (r.capabilities)",
                       "r.spec ? 'blocked_countries'", "return 'acknowledgement_required'", "to_jsonb(r) -> 'requires_acknowledgement'",
                       "public.model_is_available(r.id)", "return 'temporarily_off'", "public.sellable_models(cap, 'web')"):
            self.assertIn(needle, route, needle)
        # Skipped: the per-model assistant switch and the 'mcp' surface. Nothing else is read.
        self.assertNotIn("mcp_oauth_exposure", route)
        self.assertNotIn("'mcp'", route)
        self.assertNotIn("api_exposure", route)
        self.assertTrue(route.rstrip().endswith("return 'ok_operator'; end"), route[-80:])

    def test_every_door_asks_the_org_aware_judgement_and_never_0191s_directly(self):
        for name in REPLACED:
            b = body(name)
            self.assertIn("public.oauth_creative_org_model_state(v_org, ", b, name)
            self.assertNotIn("public.oauth_creative_model_state(", b, name)

    def test_only_the_operators_workspace_lists_from_the_web(self):
        b = squash(body("oauth_creative_models"))
        self.assertIn("v_op := public.oauth_creative_operator_org(v_org);", b)
        self.assertIn("from public.sellable_models(v_cap, case when v_op then 'web' else 'mcp' end) s", b)
        self.assertIn("'operator_only', not x.via_mcp,", b)
        self.assertIn("'availability_note', 'Operator workspace only (first-party use).'", b)
        # Still the model's shape only: no price, terms notes or vendor id (Lens on 0191).
        for leak in ("'pricing'", "'terms_notes'", "'vendor_model'", "'api_documented'", "s.spec)", "credits_per_unit"):
            self.assertNotIn(leak, b, leak)


class TheRecord(unittest.TestCase):
    def test_both_tables_record_the_route_additively(self):
        for t in ("oauth_creative_quotes", "oauth_creative_jobs"):
            self.assertIn(f"alter table public.{t} add column if not exists exposure text not null default 'mcp';", CODE)
            self.assertIn(f"alter table public.{t} add constraint {t}_exposure_check check (exposure in ('mcp', 'operator'));", CODE)
        self.assertNotRegex(CODE, r"drop column|drop table|alter column")

    def test_the_quote_stores_the_route_it_was_priced_by(self):
        b = squash(body("oauth_creative_quote"))
        self.assertIn("v_exp := case when v_state = 'ok_operator' then 'operator' else 'mcp' end;", b)
        self.assertIn("credits, quote, expires_at, exposure)", b)
        self.assertIn("'quote_ttl_seconds')::integer), v_exp)", b)
        self.assertIn("case when v_exp = 'operator' then jsonb_build_object('operator_only', true) else '{}'::jsonb end", b)

    def test_create_re_asks_and_refuses_a_quote_whose_route_changed_before_any_hold(self):
        b = body("oauth_creative_create")
        sb = squash(b)
        self.assertIn("v_state := public.oauth_creative_org_model_state(v_org, q.capability, q.model);", sb)
        self.assertIn("if (case when v_state = 'ok_operator' then 'operator' else 'mcp' end) is distinct from q.exposure then", sb)
        self.assertIn("'quote_exposure_changed'", sb)
        self.assertLess(b.index("'quote_exposure_changed'"), b.index("public.create_creative_job("))
        # No silent swap: exactly the quoted model, params and credits, as 0191.
        self.assertIn("public.create_creative_job(v_org, q.capability, q.model, q.params, 'exact', v_key, q.credits)", sb)
        self.assertIn("credit_ref, quoted_credits, exposure) values (j.id, v_grant, v_org, q.id, v_idem, j.credit_ref, j.quoted_credits, q.exposure);", sb)
        self.assertIn("'exposure', q.exposure), null);", sb)


class HouseStyle(unittest.TestCase):
    def test_no_backslash_survives_the_live_apply_path(self):
        # The Supabase MCP apply_migration path turned backslash escapes in SQL text
        # into real characters when 0218 went live, which changed bodies and their md5s.
        # A regex that needs one uses a bracket class instead ([.] and [[:space:]]).
        for label, text in (("migration", SQL), ("rollback", ROLLBACK)):
            self.assertNotIn(chr(92), text, label)

    def test_each_door_is_the_earlier_body_plus_marked_hunks(self):
        for name, (src, before, after) in REPLACED.items():
            self.assertEqual(pg_md5(name, src), before, name)
            self.assertEqual(pg_md5(name), after, name)
            self.assertIn(f"'{before}', '{after}'", SQL, name)
            self.assertIn(after, ROLLBACK, name)
            self.assertIn(before, ROLLBACK, name)
            old, new = unmarked(body(name, src)), unmarked(body(name))
            # Every line of the earlier body that is gone was replaced inside a hunk this file marks "0219".
            gone = [ln for ln in old if ln not in new]
            self.assertLessEqual(len(gone), 12, (name, gone))
            self.assertIn("0219", definition(name), name)

    def test_the_rollback_puts_the_earlier_bodies_back_byte_for_byte_and_keeps_the_record(self):
        for name, (src, before, _after) in REPLACED.items():
            self.assertEqual(definition(name, ROLLBACK), definition(name, src), name)
            self.assertEqual(pg_md5(name, ROLLBACK), before, name)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertNotRegex(ROLLBACK, r"drop table|drop column")
        for helper in ("oauth_creative_org_model_state(uuid, text, text)", "oauth_creative_bytedance(text)", "oauth_creative_operator_org(uuid)"):
            self.assertIn(f"drop function if exists public.{helper};", ROLLBACK)

    def test_the_doors_stay_anons_and_the_helpers_nobodys(self):
        sigs = ("public.oauth_creative_models(text, text, text)", "public.oauth_creative_quote(text, text, text, jsonb, text)",
                "public.oauth_creative_create(text, uuid, text, text)")
        for sig in sigs:
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", CODE)
            self.assertIn(f"grant execute on function {sig} to anon;", CODE)
        self.assertEqual(len(re.findall(r"^grant ", CODE, re.M)), len(sigs))
        for helper in ("oauth_creative_operator_org(uuid)", "oauth_creative_bytedance(text)", "oauth_creative_org_model_state(uuid, text, text)"):
            self.assertIn(f"revoke all on function public.{helper} from public, anon, authenticated, service_role;", CODE)

    def test_the_migration_writes_no_model_data_and_publishes_nothing(self):
        self.assertNotRegex(CODE, r"update public\.model_registry|sync_model_registry|insert into public\.model_registry")
        self.assertNotRegex(CODE, r"insert into public\.credit_prices|update public\.credit_prices")
        for word in ("privacy", "publish", "youtube"):
            self.assertNotIn(word, CODE.lower(), word)

    def test_applied_as_one_transaction_with_a_verify_query_and_a_schema_reload(self):
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify", "NOT CHANGED", "REPLACES", "WHY."):
            self.assertIn(needle, SQL)
        self.assertIn("set local lock_timeout", CODE)
        self.assertTrue(SQL.rstrip().endswith("notify pgrst, 'reload schema';"))

    def test_the_number_is_unique_and_documented(self):
        self.assertEqual(len(list(MIG.glob("0219_*.sql"))), 1)
        for needle in ("(0219)", "0219_oauth_creative_operator_models.sql", "rollback_0219_oauth_creative_operator_models.sql"):
            self.assertTrue(needle in MIGRATIONS_DOC, f"docs/MIGRATIONS.md names {needle}")


if __name__ == "__main__":
    unittest.main()
