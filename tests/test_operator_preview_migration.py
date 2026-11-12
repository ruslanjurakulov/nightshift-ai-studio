"""supabase/migrations/0139_operator_preview.sql — the operator may try a hidden model in the exempt organization.

SQL does not run in this suite (tests/security/test_sec_operator_preview.py does that, against a real Postgres). These pin what must not
change by accident: creative_price is 0125's body plus exactly the listed hunks (undo them and the rest is 0125's text byte for byte), the
rule is all four conditions joined by `and`, the money functions are not replaced, the drift guard, the end state and the rollback name
the hashes recomputed from the files, the grants, and the registry field that turns a preview on.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0139_operator_preview.sql").read_text(encoding="utf-8")
OLD_TEXT = (MIG / "0125_model_shutdown.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0139_operator_preview.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
OLD = bodies(OLD_TEXT)

#: (0125's text, 0139's text): every difference between the two creative_price bodies. Nothing else may differ.
HUNKS = [
    ("  variant jsonb := '{}'::jsonb;\nbegin\n",
     "  variant jsonb := '{}'::jsonb;\n"
     "  -- 0139: whether this quote is an operator preview (see creative_operator_preview).\n"
     "  m_avail text;\n"
     "  preview boolean := false;\n"
     "begin\n"),
    ("  select true, r.credit_unit, r.entitlement, r.spec\n"
     "    into m_found, m_unit, m_ent, m_spec\n"
     "    from public.model_registry r\n"
     "   where r.id = mdl\n"
     "     and r.availability in ('beta', 'ga')\n",
     "  select true, r.credit_unit, r.entitlement, r.spec, r.availability\n"
     "    into m_found, m_unit, m_ent, m_spec, m_avail\n"
     "    from public.model_registry r\n"
     "   where r.id = mdl\n"
     "     -- 0139: or a hidden model the registry marks operator_preview, for a platform admin in the operator's own credits-exempt\n"
     "     -- organization only (creative_operator_preview). Everyone else is answered exactly as before: model_not_sellable.\n"
     "     and (r.availability in ('beta', 'ga') or public.creative_operator_preview(p_org, r.availability, r.spec))\n"),
    ("    perform public.creative_refuse('model_not_sellable',\n"
     "      format('%s is not available for %s', mdl, cap));\n"
     "  end if;\n",
     "    perform public.creative_refuse('model_not_sellable',\n"
     "      format('%s is not available for %s', mdl, cap));\n"
     "  end if;\n"
     "  -- 0139: a model that is not beta or ga got here only through creative_operator_preview.\n"
     "  preview := m_avail not in ('beta', 'ga');\n"),
    ("  if coalesce(m_ent, 'any') not in ('any', 'paid') then\n",
     "  -- 0139: a plan entitlement is what a customer's plan buys; the operator's own organization has no plan, and its preview is not a sale.\n"
     "  if not preview and coalesce(m_ent, 'any') not in ('any', 'paid') then\n"),
    ("  if m_unit is not null then\n"
     "    select * into rate from public.credit_prices where unit = m_unit;\n"
     "  end if;\n",
     "  if m_unit is not null then\n"
     "    select * into rate from public.credit_prices where unit = m_unit;\n"
     "  end if;\n"
     "  -- 0139: a preview with no credit price is priced at the vendor's own cost (1 credit = 1 US cent, the convention of\n"
     "  -- docs/sql/prices_2026_10_01.sql, no margin) from the reviewed registry figure, for the job's record only: the exempt\n"
     "  -- organization holds and pays nothing (reserve_credits answers exempt). No credit_prices row is written, so nothing goes on\n"
     "  -- sale. A figure the registry does not state, or prices by variant, stays unpriced.\n"
     "  if preview and m_unit is not null and rate.unit is null\n"
     "     and jsonb_typeof(m_spec -> 'pricing') = 'object'\n"
     "     and not (m_spec -> 'pricing' ? 'variants')\n"
     "     and jsonb_typeof(m_spec -> 'pricing' -> 'provider_usd_per_unit') = 'number'\n"
     "     and (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric > 0\n"
     "     and (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric <= 100 then\n"
     "    rate.unit := m_unit;\n"
     "    rate.credits_per_unit := (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric * 100;\n"
     "    rate.margin := 0;\n"
     "  end if;\n"),
    ("    -- The resolution and soundtrack this price is for (0070).\n"
     "    || variant;\n",
     "    -- The resolution and soundtrack this price is for (0070).\n"
     "    || variant\n"
     "    -- 0139: a preview says so, and the Studio shows it as the operator's record, never as a price on sale.\n"
     "    || case when preview then jsonb_build_object('preview', true) else '{}'::jsonb end;\n"),
]

CP_0125 = "e0c4a7806642086398558cf322c95a0d"


class OperatorPreviewMigration(unittest.TestCase):
    def test_it_replaces_creative_price_only_and_adds_the_rule_and_the_list(self):
        self.assertEqual(set(NEW), {"creative_operator_preview", "operator_preview_models", "creative_price"})
        # The money path is the normal one: the job and quote functions, the hold, the capture and the floor are not replaced.
        for name in ("create_creative_job", "quote_creative_job", "reserve_credits", "capture_credits", "release_credits",
                     "creative_platform_reserve", "sellable_models", "api_creative_model_ok", "route_model"):
            self.assertNotIn(f"function public.{name}(", CODE, name)
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy", "create table"):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_creative_price_is_0125s_body_plus_exactly_the_hunks(self):
        new, old = NEW["creative_price"], OLD["creative_price"]
        self.assertEqual(md5_of(old), CP_0125)
        for before, after in HUNKS:
            self.assertEqual(new.count(after), 1, after[:60])
            self.assertEqual(old.count(before), 1, before[:60])
            new = new.replace(after, before)
        self.assertEqual(new, old, "creative_price differs from 0125's beyond the listed hunks")
        # 0124's switch and 0125's date are kept (tests/test_model_shutdown.py asks every later creative_price for both).
        for guard in ("model_is_available(mdl)", "not public.model_past_shutdown(r.spec)", "r.verified_at is not null"):
            self.assertIn(guard, NEW["creative_price"])

    def test_the_rule_is_all_four_conditions_and_json_true_only(self):
        rule = body(NEW["creative_operator_preview"])
        for cond in ("p_availability = 'hidden'", "p_spec -> 'operator_preview' = 'true'::jsonb", "public.is_platform_admin()",
                     "public.credits_exempt(p_org)", "public.is_org_member(p_org)"):
            self.assertIn(cond, rule)
        self.assertNotRegex(rule, r"\bor\b")
        self.assertRegex(rule, re.compile(r"coalesce\(.*, false\)\s*$", re.S))
        self.assertIn("language sql stable set search_path = public, pg_temp", NEW["creative_operator_preview"])
        self.assertNotIn("security definer", NEW["creative_operator_preview"])

    def test_the_list_asks_what_the_quote_asks_and_shows_only_the_public_half(self):
        lst = NEW["operator_preview_models"]
        self.assertIn("language plpgsql stable security definer set search_path = public, pg_temp", lst)
        for cond in ("public.creative_operator_preview(p_org, m.availability, m.spec)", "m.verified_at is not null",
                     "m.verified_probe_id is not null", "public.model_is_available(m.id)", "not public.model_past_shutdown(m.spec)"):
            self.assertIn(cond, lst)
        for secret in ("provider_usd_per_unit", "'vendor_model'", "'terms_gate'", "'terms_notes'", "'probe'", "'operator_preview'"):
            self.assertNotIn(secret, lst.split("from public.model_registry", 1)[0])
        # The same public keys sellable_models gives, no more.
        keys = lambda fn: set(re.findall(r"'([a-z_]+)', m\.spec", fn))
        self.assertEqual(keys(lst), keys(OLD["sellable_models"]))

    def test_grants(self):
        self.assertIn("revoke all on function public.creative_operator_preview(uuid, text, jsonb) from public, anon, authenticated, service_role;", CODE)
        self.assertNotIn("grant execute on function public.creative_operator_preview", CODE)
        self.assertIn("revoke all on function public.operator_preview_models(uuid) from public, anon, service_role;\n"
                      "grant execute on function public.operator_preview_models(uuid) to authenticated;", CODE)
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;", CODE)
        self.assertNotIn("grant execute on function public.creative_price", CODE)

    def test_the_drift_guard_the_end_state_and_the_rollback_carry_the_hashes_of_the_files(self):
        for name in NEW:
            self.assertGreaterEqual(NEW_TEXT.count(md5_of(NEW[name])), 2, f"{name}: the guard and the end state")
        self.assertIn(f"array['{CP_0125}', '{md5_of(NEW['creative_price'])}']", NEW_TEXT)
        self.assertIn(f"array['{md5_of(NEW['creative_price'])}', '{CP_0125}']", ROLLBACK_TEXT)
        self.assertIn("0139 found a creative_price() that is neither 0125''s body nor 0139''s", NEW_TEXT)
        self.assertLess(NEW_TEXT.index("0139 needs 0125_model_shutdown.sql"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.index("0139 found a creative_price()"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.rindex("create or replace function"), NEW_TEXT.index("The end state, asserted inside the transaction"))
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        self.assertIn("APPLY AS ONE TRANSACTION", NEW_TEXT)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", NEW_TEXT)

    def test_the_rollback_restores_0125s_text_byte_for_byte_and_drops_the_two_functions(self):
        rb = bodies(ROLLBACK_TEXT)
        self.assertEqual(set(rb), {"creative_price"})
        self.assertEqual(rb["creative_price"], OLD["creative_price"])
        self.assertIn("drop function if exists public.operator_preview_models(uuid);", ROLLBACK_TEXT)
        self.assertIn("drop function if exists public.creative_operator_preview(uuid, text, jsonb);", ROLLBACK_TEXT)
        self.assertIn("rollback 0139 found a creative_price() that is neither 0139''s body nor 0125''s", ROLLBACK_TEXT)
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)

    def test_the_number_is_unique_and_the_lab_knows_it_sits_on_0125(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0139"), 1)
        self.assertIn("0138", numbers)
        lab = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
        for needle in ("def take_off_0139(", "def put_back_0139(", "ON_0125 = (MIGRATION_0139.name,)"):
            self.assertIn(needle, lab)
        expect = (ROOT / "tests" / "security" / "sec_expectations.py").read_text(encoding="utf-8")
        self.assertIn('"creative_operator_preview": SERVICE,', expect)
        self.assertIn('"operator_preview_models": USER,', expect)


class RegistryField(unittest.TestCase):
    def test_the_schema_takes_operator_preview_as_a_boolean(self):
        schema = json.loads((ROOT / "schemas" / "model_registry.schema.json").read_text(encoding="utf-8"))
        props = schema["$defs"]["model"]["properties"]
        self.assertEqual(props["operator_preview"]["type"], "boolean")


if __name__ == "__main__":
    unittest.main()
