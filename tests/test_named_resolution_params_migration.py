"""supabase/migrations/0156_named_resolution_params.sql — a request may name a model's own resolution, sold only at its own variant's price.

SQL does not run in this suite (tests/security/test_sec_named_resolution_params.py does that, against a real Postgres). These pin what
must not change by accident: the file replaces exactly creative_params_problem (0126's body plus one hunk) and creative_price (0153's
body plus one hunk), undoing each hunk gives the old text byte for byte; the params check's resolution shape is the registry schema's own
pattern, so every name the registry lists passes it and nothing else does; the list of names "accepted before 0156" in creative_price is
0126's list exactly; the drift guards, the end state, the rollback and the lab name the hashes recomputed from the files; the grants; the
lab knows the chain.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0156_named_resolution_params.sql").read_text(encoding="utf-8")
PP_TEXT = (MIG / "0126_region_edit_run.sql").read_text(encoding="utf-8")
CP_TEXT = (MIG / "0153_preview_price_by_quality.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0156_named_resolution_params.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
PP_0126 = "6e815ae544cbb23d7f03845465f8ce6a"
CP_0153 = "28130a014027e6ad0b7876a78d69a396"
OLD_RE = "^(480|540|720|1080|1440|2160)p$"
NEW_RE = "^([0-9]{3,4}p|[24]k)$"

PP_HUNK = (
    "    if jsonb_typeof(p_params -> 'resolution') <> 'string'\n"
    "       or (p_params ->> 'resolution') !~ '^(480|540|720|1080|1440|2160)p$' then\n"
    "      return 'resolution must be one of 480p 540p 720p 1080p 1440p 2160p';\n"
    "    end if;\n",
    "    -- 0156: the shape of a resolution name in the registry (the resolution pattern of schemas/model_registry.schema.json), so a model's own\n"
    "    -- names (MiniMax H3's 768p and 2k, Vidu's 2k, LTX's 4k ...) reach creative_price. There a name the model does not list is refused\n"
    "    -- (0070), and a name this list did not take before 0156 is sold only at its own variant's price (0156).\n"
    "    if jsonb_typeof(p_params -> 'resolution') <> 'string'\n"
    "       or (p_params ->> 'resolution') !~ '^([0-9]{3,4}p|[24]k)$' then\n"
    "      return 'resolution must be a resolution the model lists (such as 720p, 768p, 1080p, 2k or 4k)';\n"
    "    end if;\n",
)
CP_ANCHOR = "  end if;\n  if m_unit is not null then\n    select * into rate from public.credit_prices where unit = m_unit;\n"


def cp_hunk():
    cp = NEW["creative_price"]
    a = cp.index("  -- 0156: creative_params_problem now takes")
    b = cp.index("  if m_unit is not null then\n    select * into rate")
    return cp[a:b]


class NamedResolutionParamsMigration(unittest.TestCase):
    def test_it_replaces_the_two_functions_only_and_writes_nothing(self):
        self.assertEqual(set(NEW), {"creative_params_problem", "creative_price"})
        for name in ("creative_operator_preview", "create_creative_job", "quote_creative_job", "reserve_credits", "capture_credits",
                     "release_credits", "sellable_models", "route_model", "creative_quantity", "finish_creative_job",
                     "creative_regions_problem"):
            self.assertNotIn(f"function public.{name}(", CODE, name)
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy",
                     "create table", "grant "):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_creative_params_problem_is_0126s_body_plus_exactly_the_resolution_hunk(self):
        old = bodies(PP_TEXT)["creative_params_problem"]
        self.assertEqual(md5_of(old), PP_0126)
        before, after = PP_HUNK
        new = NEW["creative_params_problem"]
        self.assertEqual(new.count(after), 1)
        self.assertEqual(old.count(before), 1)
        self.assertEqual(new.replace(after, before), old, "creative_params_problem differs from 0126's beyond the resolution hunk")
        # still immutable, reads no table, and keeps 0126's region lines (tests/test_region_edit_run_migration.py pins the same)
        self.assertIn("language plpgsql immutable set search_path = public, pg_temp as", new)
        self.assertNotRegex("\n".join(ln.split("--", 1)[0] for ln in new.splitlines()).lower(), r"\b(from|join)\s+public\.\w+")
        self.assertIn("creative_regions_problem", new)

    def test_creative_price_is_0153s_body_plus_exactly_the_one_refusal(self):
        old = bodies(CP_TEXT)["creative_price"]
        self.assertEqual(md5_of(old), CP_0153)
        hunk = cp_hunk()
        new = NEW["creative_price"]
        self.assertEqual(new.count(hunk), 1)
        self.assertEqual(new.replace(hunk, ""), old, "creative_price differs from 0153's beyond the 0156 refusal")
        # It sits after 0070's video settings (so `variant` is settled and an unlisted name was refused there first) and before any rate
        # is read (so neither a credit_prices row nor the preview figure can sell the name).
        self.assertIn(CP_ANCHOR, new)
        self.assertLess(new.index("perform public.creative_refuse('invalid_params',\n        format('%s does not offer %s', mdl, "
                                  "p_params ->> 'resolution'));"), new.index(hunk))
        self.assertLess(new.index("variant := jsonb_strip_nulls("), new.index(hunk))
        self.assertLess(new.index(hunk), new.index("select * into rate from public.credit_prices where unit = m_unit;"))
        self.assertLess(new.index(hunk), new.index("vusd := case"))
        code = "\n".join(ln.split("--", 1)[0] for ln in hunk.splitlines())
        # The names accepted before 0156 are 0126's list, character for character: no other name is grandfathered.
        self.assertIn(f"(p_params ->> 'resolution') !~ '{OLD_RE}'", code)
        self.assertIn(f"!~ '{OLD_RE}'", body(bodies(PP_TEXT)["creative_params_problem"]))
        # Only a quote priced by the resolution's own variant passes; no setting is chosen or changed here (rule 4: never mapped).
        self.assertIn("and not (variant ? 'resolution') then", code)
        self.assertNotRegex(code, r"\b(vres|m_unit|variant|rate|tier)\s*:=")
        self.assertIn("perform public.creative_refuse('unpriced',", code)
        self.assertIn("if cap not in ('t2v', 'i2v') then\n      perform public.creative_refuse('invalid_params',", code)
        for guard in ("model_is_available(mdl)", "not public.model_past_shutdown(r.spec)", "r.verified_at is not null",
                      "public.creative_operator_preview(p_org, r.availability, r.spec)"):
            self.assertIn(guard, new)

    def test_the_params_shape_is_the_registry_schemas_and_every_listed_name_fits_it(self):
        schema = json.loads((ROOT / "schemas" / "model_registry.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema["$defs"]["resolution"]["pattern"], NEW_RE, "the database and the registry schema disagree on a name")
        self.assertIn(f"!~ '{NEW_RE}'", NEW["creative_params_problem"])
        shape = re.compile(NEW_RE)
        registry = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
        models = registry["models"] if isinstance(registry, dict) else registry
        names = {r for m in models for r in (m.get("resolutions") or [])}
        names |= {m["default_resolution"] for m in models if m.get("default_resolution")}
        for m in models:
            v = (m.get("pricing") or {}).get("variants") or {}
            if v.get("by") == "resolution":
                names |= set(v.get("prices") or {})
        self.assertTrue({"768p", "2k", "4k"} <= names, names)
        for n in sorted(names):
            self.assertRegex(n, shape, n)
        # Every name accepted before still is; a wrong case or a bare number is not (never read as another name).
        for n in ("480p", "540p", "720p", "1080p", "1440p", "2160p"):
            self.assertRegex(n, shape)
        for n in ("2K", "768P", "768", "8k", "1k", "99p", "12345p", "768p ", ""):
            self.assertIsNone(shape.match(n), n)

    def test_grants(self):
        for sig in ("creative_params_problem(text, jsonb)", "creative_price(uuid, text, text, jsonb)"):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", CODE)
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", ROLLBACK_TEXT)

    def test_the_drift_guards_the_end_state_the_rollback_and_the_lab_carry_the_hashes_of_the_files(self):
        pp, cp = md5_of(NEW["creative_params_problem"]), md5_of(NEW["creative_price"])
        for h in (pp, cp):
            self.assertGreaterEqual(NEW_TEXT.count(h), 3, "the guard, the end state and the verify query")
        self.assertIn(f"array['{PP_0126}', '{pp}']", NEW_TEXT)
        self.assertIn(f"array['{CP_0153}', '{cp}']", NEW_TEXT)
        self.assertIn(f"array['{pp}', '{PP_0126}']", ROLLBACK_TEXT)
        self.assertIn(f"array['{cp}', '{CP_0153}']", ROLLBACK_TEXT)
        # 0149's creative_price is NOT accepted: this file was written on 0153's.
        self.assertNotIn("728241a09e56f65e19efc460afea7355", CODE)
        self.assertIn("0156 found a creative_params_problem() that is neither 0126''s body nor 0156''s", NEW_TEXT)
        self.assertIn("0156 found a creative_price() that is neither 0153''s body nor 0156''s", NEW_TEXT)
        first = NEW_TEXT.index("create or replace function")
        self.assertLess(NEW_TEXT.index("0156 needs 0126_region_edit_run.sql and 0153_preview_price_by_quality.sql"), first)
        self.assertLess(NEW_TEXT.index("0156 found a creative_price()"), first)
        self.assertLess(NEW_TEXT.rindex("create or replace function"), NEW_TEXT.index("The end state, asserted inside the transaction"))
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify", "LIVE ON APPLY", "THE EVIDENCE",
                       "THE DIAGNOSIS"):
            self.assertIn(needle, NEW_TEXT)
        self.assertIn(f'CREATIVE_PRICE_0156 = "{cp}"', LAB)
        self.assertIn(f'CREATIVE_PARAMS_PROBLEM_0156 = "{pp}"', LAB)

    def test_the_rollback_restores_0126s_and_0153s_text_byte_for_byte(self):
        rb = bodies(ROLLBACK_TEXT)
        self.assertEqual(set(rb), {"creative_params_problem", "creative_price"})
        self.assertEqual(rb["creative_params_problem"], bodies(PP_TEXT)["creative_params_problem"])
        self.assertEqual(rb["creative_price"], bodies(CP_TEXT)["creative_price"])
        self.assertIn("rollback 0156 found a creative_params_problem() that is neither 0156''s body nor 0126''s", ROLLBACK_TEXT)
        self.assertIn("rollback 0156 found a creative_price() that is neither 0156''s body nor 0153''s", ROLLBACK_TEXT)
        self.assertNotIn("drop function", ROLLBACK_TEXT.lower())
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)

    def test_the_number_is_unique_and_the_lab_knows_it_sits_on_0153(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0156"), 1)
        for n in ("0126", "0153"):
            self.assertIn(n, numbers)
        for needle in ("def take_off_0156(", "def put_back_0156(", "ON_0153 = (MIGRATION_0156.name,)",
                       "ON_0149 = (MIGRATION_0153.name, *ON_0153)", "ON_0139 = (MIGRATION_0149.name, *ON_0149)"):
            self.assertIn(needle, LAB)
        # take_off_0153 takes 0156 off first and put_back_0153 puts it back: 0153's rollback and replay refuse 0156's body.
        off = LAB[LAB.index("def take_off_0153("):LAB.index("def put_back_0153(")]
        self.assertLess(off.index("take_off_0156(session)"), off.index("rollback_0153_body()"))
        on = LAB[LAB.index("def put_back_0153("):LAB.index("CREATIVE_PRICE_0156 =")]
        self.assertIn("put_back_0156(session)", on)
        # The chain is still found from 0156's body (has_0149 / has_0153 compare their own hashes only).
        off49 = LAB[LAB.index("def take_off_0149("):LAB.index("def put_back_0149(")]
        self.assertIn("if has_0153(session) or has_0156(session):", off49)
        off39 = LAB[LAB.index("def take_off_0139("):LAB.index("def put_back_0139(")]
        self.assertIn("if has_0149(session) or has_0153(session) or has_0156(session):", off39)

    def test_the_known_gap_0149_pinned_is_now_a_real_test(self):
        lab_test = (ROOT / "tests" / "security" / "test_sec_preview_price_by_resolution.py").read_text(encoding="utf-8")
        self.assertIn("def test_a_named_768p_or_2k_reaches_its_own_figure(", lab_test)
        self.assertNotIn("pytest.mark.xfail", lab_test)

    def test_the_docs_describe_it(self):
        docs = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("## A model's own resolution names (0156)", docs)
        self.assertIn("rollback_0156_named_resolution_params.sql", docs)


if __name__ == "__main__":
    unittest.main()
