"""supabase/migrations/0230_geo_gate_allow_list.sql — the country gate reads an allow-list vendor's own list (BR-S6-03-DB).

SQL runs in tests/security/test_sec_geo_allowlist_0230.py (a real Postgres). These pin what must not drift by accident: the gate is
0208's body plus exactly one marked hunk (undo it and the rest is 0208's text byte for byte), so RU is still country_blocked and no
claim still country_unverified; the hashes in the drift guard, the end state, the rollback and the lab are the ones recomputed from
the files; the rollback puts 0208's body back verbatim; no model id is written in the SQL (the registry says which list a model
has); every Google registry row carries its allow-list, equal to the web's GOOGLE_AVAILABLE_REGIONS and disjoint from its
deny-list; and neither file holds a backslash (the live apply path once rewrote them).
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

from modules import model_registry

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0230_geo_gate_allow_list.sql").read_text(encoding="utf-8")
T208 = (MIG / "0208_geo_gate_and_image_size_price.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0230_geo_gate_allow_list.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
EXPECT = (ROOT / "tests" / "security" / "sec_expectations.py").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
LEDGER = (ROOT / "docs" / "security" / "LEDGER.md").read_text(encoding="utf-8")
BLOCKED_TS = (ROOT / "command-center" / "lib" / "geo" / "blocked.ts").read_text(encoding="utf-8")
REGISTRY = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())

GATE_0208 = "71468a6f60d2659cd44199a3c834dc69"
GATE_0230 = "3f2e4d767f9d53de505aacb29e7141f9"


def gate(text):
    return re.search(r"(?ms)^create or replace function public\.creative_jobs_geo_gate\(\).*?^\$\$;\n", text).group(0)


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"[ \t\n\r\f\v]+", " ", b).encode()).hexdigest()


def ts_list(name):
    block = BLOCKED_TS[BLOCKED_TS.index(f"export const {name}"):]
    return sorted(re.findall(r'"([A-Z]{2})"', block[:block.index("];")]))


#: The one hunk, as 0230 writes it on 0208's body (declarations, the select, the allow-list read).
HUNKS = [
    ("  c   text;\nbegin\n", "  c   text;\n  -- 0230\n  al   jsonb;\n  prov text;\nbegin\n"),
    ("  select r.spec -> 'blocked_countries' into lst from public.model_registry r where r.id = m;\n",
     "  select r.spec -> 'blocked_countries', r.spec -> 'available_countries', r.provider into lst, al, prov\n"
     "    from public.model_registry r where r.id = m;\n"),
]


class Body(unittest.TestCase):
    def test_the_hashes_are_the_ones_recomputed_from_the_files(self):
        self.assertEqual(md5_of(gate(T208)), GATE_0208)
        self.assertEqual(md5_of(gate(NEW_TEXT)), GATE_0230)
        self.assertEqual(md5_of(gate(ROLLBACK)), GATE_0208)
        for text in (NEW_TEXT, ROLLBACK):
            self.assertIn(GATE_0208, text)
            self.assertIn(GATE_0230, text)
        self.assertIn(f'GEO_GATE_0208 = "{GATE_0208}"', LAB)
        self.assertIn(f'GEO_GATE_0230 = "{GATE_0230}"', LAB)

    def test_the_gate_is_0208s_body_plus_one_marked_hunk(self):
        new = gate(NEW_TEXT)
        start = new.index("  -- 0230 (BR-S6-03)")
        end = new.index("  return new;\nend\n$$;")
        hunk = new[start:end]
        undone = new[:start] + new[end:]
        for before, after in HUNKS:
            self.assertIn(after, undone)
            undone = undone.replace(after, before)
        self.assertEqual(undone, gate(T208))
        # The two 0208 refusals come first, in order, so the answers 0208 gave for no claim and a blocked country stay.
        self.assertLess(new.index("'country_unverified'"), new.index("'country_blocked'"))
        self.assertLess(new.index("'country_blocked'"), start)
        self.assertIn("if al is not null or prov = 'google' then", hunk)
        self.assertIn("if al is null or jsonb_typeof(al) <> 'array' or not (al ? c) then", hunk)
        self.assertIn("perform public.creative_refuse('country_unverified',", hunk)
        self.assertNotIn("return new", hunk)

    def test_the_rollback_puts_0208s_body_back_byte_for_byte(self):
        self.assertEqual(gate(ROLLBACK), gate(T208))
        self.assertIn("'rollback 0230 end state: creative_jobs_geo_gate() is not 0208''s body'", ROLLBACK)
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;"))

    def test_no_model_id_is_written_in_the_sql(self):
        for m in REGISTRY:
            self.assertNotIn(f"'{m['id']}'", CODE, m["id"])

    def test_no_backslash_survives_the_live_apply_path(self):
        self.assertNotIn("\\", NEW_TEXT)
        self.assertNotIn("\\", ROLLBACK)

    def test_definer_pinned_and_closed(self):
        self.assertIn("language plpgsql security definer set search_path = public, pg_temp as $$", gate(NEW_TEXT))
        self.assertIn("revoke all on function public.creative_jobs_geo_gate() from public, anon, authenticated, service_role;", NEW_TEXT)
        self.assertNotRegex(CODE, r"(?i)grant\s+execute")

    def test_guarded_one_transaction_with_an_end_state_and_a_verify_block(self):
        self.assertIn("0230 needs 0208", NEW_TEXT)
        self.assertIn("0230 found a creative_jobs_geo_gate() that is neither 0208''s body nor 0230''s", NEW_TEXT)
        self.assertLess(NEW_TEXT.index("0230 found a creative_jobs_geo_gate()"), NEW_TEXT.index("create or replace function"))
        self.assertIn("set local lock_timeout", NEW_TEXT)
        self.assertIn("0230 end state:", NEW_TEXT)
        self.assertIn("-- Verify", NEW_TEXT)
        # Additive: no table, no column, nothing dropped, no data written.
        self.assertNotRegex(CODE, r"(?i)\b(create table|alter table|drop |insert into|update public|delete from)")

    def test_no_later_migration_replaces_the_gate(self):
        later = [p.name for p in MIG.glob("*.sql") if p.name > "0209" and p.name != "0230_geo_gate_allow_list.sql"
                 and "function public.creative_jobs_geo_gate()" in p.read_text(encoding="utf-8")]
        self.assertEqual(later, [], "a later body of the gate needs its md5 in 0230's guard and the rollback")


class Registry(unittest.TestCase):
    def test_every_google_row_carries_googles_own_list_equal_to_the_web(self):
        google = [m for m in REGISTRY if m["provider"] == "google"]
        self.assertTrue(google)
        avail = ts_list("GOOGLE_AVAILABLE_REGIONS")
        for m in google:
            self.assertEqual(sorted(m["available_countries"]), avail, m["id"])
            self.assertFalse(set(m["available_countries"]) & set(m["blocked_countries"]), m["id"])

    def test_the_codes_the_lab_attacks_with_are_on_neither_list(self):
        for m in REGISTRY:
            for code in ("EU", "AP", "QQ", "ZZ"):
                self.assertNotIn(code, m.get("available_countries", []), m["id"])
                self.assertNotIn(code, m.get("blocked_countries", []), m["id"])

    def test_the_validator_refuses_a_google_row_without_its_allow_list(self):
        doc = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
        g = next(m for m in doc["models"] if m["provider"] == "google")
        del g["available_countries"]
        self.assertIn(f"{g['id']}: a google model with blocked_countries needs available_countries (Google's own list)",
                      model_registry.validate(doc))

    def test_the_validator_refuses_a_code_on_both_lists_and_an_allow_list_alone(self):
        doc = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
        g = next(m for m in doc["models"] if m["provider"] == "google")
        g["available_countries"] = [*g["available_countries"], "RU"]
        self.assertIn(f"{g['id']}: available_countries and blocked_countries share a code", model_registry.validate(doc))
        doc = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
        other = next(m for m in doc["models"] if m["provider"] != "google" and not m.get("blocked_countries"))
        other["available_countries"] = ["UZ"]
        self.assertIn(f"{other['id']}: available_countries needs blocked_countries", model_registry.validate(doc))

    def test_the_sync_carries_the_allow_list_into_spec(self):
        rows = {r["id"]: r for r in model_registry.sync_rows(list(model_registry.registry().values()))}
        for m in REGISTRY:
            if m["provider"] == "google" and m["id"] in rows:
                self.assertEqual(rows[m["id"]]["spec"]["available_countries"], m["available_countries"], m["id"])


class Wiring(unittest.TestCase):
    def test_lab_ledger_and_docs_name_it(self):
        self.assertIn("def put_back_0230(", LAB)
        self.assertIn("put_back_0230(conn)", LAB[LAB.index("def put_back_0208("):LAB.index("def put_back_0230(")])
        self.assertIn("import sec_geo_allowlist_0230", EXPECT)
        self.assertTrue((ROOT / "tests" / "security" / "test_sec_geo_allowlist_0230.py").is_file())
        self.assertIn("| BR-S6-03-DB |", LEDGER)
        self.assertIn("(0230)", DOCS)
        self.assertIn("rollback_0230_geo_gate_allow_list.sql", DOCS)

    def test_the_number_is_unique(self):
        self.assertEqual([p.name for p in MIG.glob("0230_*.sql")], ["0230_geo_gate_allow_list.sql"])


if __name__ == "__main__":
    unittest.main()
