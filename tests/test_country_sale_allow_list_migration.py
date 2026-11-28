"""Migration 0238: a model with a country list may go on sale only with its vendor's allow-list, and only behind 0230's gate.

Static pins on the file, its rollback, the two gate rollbacks it orders, the registry rows it was written for and the docs. The
behaviour (beta with both lists, refused with a deny-list only, the drift guard, replay, rollback) runs against a real Postgres in
tests/security/test_sec_country_sale_0238.py.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIG = ROOT / "supabase" / "migrations" / "0238_country_list_sale_needs_allow_list.sql"
TEXT = MIG.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0238_country_list_sale_needs_allow_list.sql").read_text(encoding="utf-8")
T0142 = (ROOT / "supabase" / "migrations" / "0142_country_block_before_sale.sql").read_text(encoding="utf-8")
RB0230 = (ROOT / "docs" / "sql" / "rollback_0230_geo_gate_allow_list.sql").read_text(encoding="utf-8")
RB0208 = (ROOT / "docs" / "sql" / "rollback_0208_geo_gate_and_image_size_price.sql").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
LEDGER = (ROOT / "docs" / "security" / "LEDGER.md").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
EXPECT = (ROOT / "tests" / "security" / "sec_expectations.py").read_text(encoding="utf-8")
REGISTRY = {m["id"]: m for m in json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
CLEARED = ("gemini-3-pro-image", "gemini-nano-banana-2.1")

GATE_0230 = "6a7b6f2b075c4775ee83808932f88bd0"
FOLD_GATE_0230 = "6d28388da6b6b927b0da500524fe0325"
CLAIM_0208 = "6cb8abcd7ab3dff8fb2a4ce33afa58d6"
FP_SQL = "md5(regexp_replace(regexp_replace({}, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))"
CHECK_0142 = ("alter table public.model_registry add constraint model_registry_countries_before_sale\n"
              "  check (availability not in ('beta', 'ga')\n"
              "         or coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) = '[]'::jsonb);")
ALLOW = "coalesce(jsonb_typeof(spec -> 'available_countries') = 'array' and spec -> 'available_countries' <> '[]'::jsonb, false)"


def code(text: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


class TheFile(unittest.TestCase):
    def test_it_replaces_one_check_and_nothing_else(self):
        body = code(TEXT)
        self.assertEqual(re.findall(r"add constraint (\w+)", body), ["model_registry_countries_before_sale"])
        self.assertEqual(re.findall(r"drop constraint if exists (\w+)", body), ["model_registry_countries_before_sale"])
        self.assertIn("check (availability not in ('beta', 'ga')\n"
                      "         or coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) = '[]'::jsonb\n"
                      "         or " + ALLOW + ");", body)
        for forbidden in (r"\bcreate (or replace )?function\b", r"\bcreate policy\b", r"\bgrant\b", r"\brevoke\b",
                          r"\bcreate trigger\b", r"\bupdate public\.", r"\binsert into\b", r"\bdelete from\b", r"availability\s*="):
            self.assertNotRegex(body, forbidden)

    def test_the_allow_list_test_cannot_be_null(self):
        # A CHECK passes on NULL: a bare `jsonb_typeof(...) = 'array' and ...` is NULL for a row with no allow-list, which would let a
        # deny-list-only row on sale. Every copy of the test (pre-check, CHECK, end state, Verify) is the coalesced one.
        self.assertEqual(TEXT.count(ALLOW), 4)
        bare = "(jsonb_typeof(spec -> 'available_countries') = 'array' and"
        self.assertEqual(TEXT.count(bare), TEXT.count("coalesce" + bare))

    def test_it_refuses_unless_0230s_gate_is_live(self):
        body = code(TEXT)
        self.assertEqual(body.count(FP_SQL.format("p.prosrc")), 2)            # the gate and the claim reader
        self.assertIn(f"fp is distinct from '{GATE_0230}' or fold is distinct from '{FOLD_GATE_0230}'", body)
        self.assertIn(f"cl is distinct from '{CLAIM_0208}'", body)
        self.assertIn("t.tgfoid = 'public.creative_jobs_geo_gate()'::regprocedure and not t.tgisinternal and t.tgenabled = 'O'", body)
        for bit in ("1) = 1", "2) = 2", "4) = 4", "16) = 16"):
            self.assertIn(f"(t.tgtype::int & {bit}", body)
        self.assertIn("proconfig = array['search_path=public, pg_temp']", body)
        # The guard runs before the CHECK is touched.
        self.assertLess(body.index("0238 found a creative_jobs_geo_gate()"), body.index("drop constraint if exists"))
        self.assertIn("0238 end state: creative_jobs_geo_gate() is not 0230''s body", body)

    def test_the_hashes_are_0230s(self):
        mig0230 = (ROOT / "supabase" / "migrations" / "0230_geo_gate_allow_list.sql").read_text(encoding="utf-8")
        for h in (GATE_0230, FOLD_GATE_0230, CLAIM_0208):
            self.assertIn(h, mig0230)
            self.assertIn(h, TEXT)
        self.assertIn(f'GEO_GATE_0230 = "{FOLD_GATE_0230}"', LAB)

    def test_no_backslash_and_no_double_dash_in_a_literal(self):
        for text in (TEXT, ROLLBACK):
            self.assertNotIn("\\", text)
            lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("--")]
            self.assertNotIn("--", "\n".join(ln.split(" -- ", 1)[0] for ln in lines))
        self.assertNotIn("\\", RB0230)

    def test_no_model_id_is_written_in_the_sql(self):
        for mid in REGISTRY:
            self.assertNotIn(f"'{mid}'", code(TEXT), mid)
            self.assertNotIn(f"'{mid}'", code(ROLLBACK), mid)

    def test_the_header_says_live_evidence_diagnosis_change_and_ends_on_a_verify_query(self):
        for needle in ("LIVE ON APPLY", "EVIDENCE.", "DIAGNOSIS.", "CHANGE (one CHECK", "APPLY AS ONE TRANSACTION",
                       "WHAT TO VERIFY BEFORE YOU APPLY", "rollback_0238_country_list_sale_needs_allow_list.sql",
                       "IF THE GATE GOES AWAY LATER", "WHAT ELSE REFUSES A COUNTRY-LISTED ROW"):
            self.assertIn(needle, TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))
        tail = TEXT.rstrip().splitlines()
        last_code = max(i for i, ln in enumerate(tail) if ln.strip() and not ln.startswith("--"))
        self.assertTrue(all(ln.startswith("--") for ln in tail[last_code + 1:] if ln.strip()))
        self.assertIn("-- Verify (the SQL editor, after applying", "\n".join(tail[last_code + 1:]))

    def test_its_number_is_its_own(self):
        self.assertEqual(sorted(p.name for p in MIG.parent.glob("0238_*.sql")), [MIG.name])


class TheRollbacks(unittest.TestCase):
    def test_the_rollback_puts_0142s_check_back_verbatim(self):
        self.assertIn(CHECK_0142, T0142)
        self.assertIn(CHECK_0142, ROLLBACK)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertNotIn("available_countries", code(ROLLBACK).split("-- 0142's CHECK, verbatim.")[-1].split("do $$")[0])

    def test_the_rollback_refuses_while_a_country_listed_row_is_on_sale_before_it_changes_anything(self):
        body = code(ROLLBACK)
        self.assertLess(body.index("these models are on sale and carry blocked_countries"), body.index("drop constraint"))

    def test_the_gate_rollbacks_refuse_while_a_country_listed_row_is_on_sale(self):
        for text, tag in ((RB0230, "rollback 0230"), (RB0208, "rollback 0208")):
            body = code(text)
            msg = f"{tag}: these models are on sale with a country list"
            self.assertIn(msg, body)
            first_change = min(body.index(w) for w in ("create or replace function", "drop trigger", "drop function") if w in body)
            self.assertLess(body.index(msg), first_change, tag)
            self.assertIn("rollback_0238_country_list_sale_needs_allow_list.sql first", body)
            # Only while 0238's CHECK is the live one: with 0142's no such row can be on sale.
            self.assertLess(body.index("position('available_countries' in pg_get_constraintdef(oid)) > 0"), body.index(msg), tag)


class TheRegistry(unittest.TestCase):
    def test_the_cleared_rows_keep_every_other_gate(self):
        for mid in CLEARED:
            m = REGISTRY[mid]
            with self.subTest(mid=mid):
                self.assertIsNone(m["terms_gate"])
                # An operator preview since 0243, which teaches creative_price's preview fallback the figure of the requested
                # size (before it, a dead end: tests/test_preview_price_by_image_size_migration.py; the lab measures both).
                self.assertIs(m["operator_preview"], True)
                self.assertEqual(m["pricing"]["variants"]["by"], "image_size")
                self.assertIs(m["requires_adult"], True)
                self.assertEqual(m["api_exposure"], "web_only")
                self.assertTrue(m["blocked_countries"] and m["available_countries"])
                self.assertNotIn("availability", m)                   # the database's, never the file's
                self.assertNotIn("mcp_oauth_exposure", m)
                notes = " ".join(m["terms_notes"])
                for needle in ("Owner decision 2026-11-28", "age clause (18+) and Use Restrictions", "§20.d",
                               "Europe included", "Still OPEN after 2026-11-28", "§17.a", "§4(a)", "web_only"):
                    self.assertIn(needle, notes)

    def test_every_other_google_row_keeps_its_terms_gate(self):
        for mid, m in REGISTRY.items():
            if m["provider"] == "google" and mid not in CLEARED:
                self.assertTrue(m.get("terms_gate"), mid)

    def test_no_row_has_a_deny_list_without_a_gate_or_an_allow_list(self):
        for mid, m in REGISTRY.items():
            if m.get("blocked_countries"):
                self.assertTrue(m.get("terms_gate") or m.get("available_countries"), mid)


class TheDocsAndTheLab(unittest.TestCase):
    def test_migrations_md_records_the_decision_and_the_order(self):
        self.assertIn("(0238)", DOCS)
        section = DOCS[DOCS.index("behind 0230's gate (0238)"):]
        for needle in ("Owner decision, 2026-11-28", "Europe included", "§17.a", "§4(a)", "Order of undoing",
                       "rollback_0238_country_list_sale_needs_allow_list.sql", "Film Studio take"):
            self.assertIn(needle, section)

    def test_the_lab_takes_0238_off_before_the_gate_and_puts_it_back_after(self):
        self.assertIn("    take_off_0238(conn)", LAB[LAB.index("def take_off_0208("):LAB.index("def put_back_0208(")])
        self.assertIn("    put_back_0238(conn)\n", LAB[LAB.index("def put_back_0230("):LAB.index("MIGRATION_0238 =")])
        # In ON_0156, ON_0139 and ON_0124 (a sequence that leaves 0230 out leaves 0238 out, and puts it back last).
        self.assertGreaterEqual(LAB.count('"0238_country_list_sale_needs_allow_list.sql"'), 3)
        self.assertIn("import sec_country_sale_0238", EXPECT)

    def test_the_ledger_row_says_what_is_pinned_and_what_is_open(self):
        row = next(ln for ln in LEDGER.splitlines() if ln.startswith("| BR-832-02 |"))
        self.assertIn("tests/test_google_requires_adult.py", row)
        self.assertIn("open", row)


if __name__ == "__main__":
    unittest.main()
