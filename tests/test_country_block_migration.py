"""Migration 0142 (docs/GEO_BLOCK.md "What it cannot do"): a model whose registry entry carries blocked_countries cannot be beta or ga.

Static pins on the file and its rollback. The behaviour (every caller refused, a sync refused whole, hidden and disabled allowed, the
pre-check, a replay, the rollback and re-apply) is proved against a real Postgres in tests/security/test_sec_country_block.py.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIG = ROOT / "supabase" / "migrations" / "0142_country_block_before_sale.sql"
TEXT = MIG.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0142_country_block_before_sale.sql").read_text(encoding="utf-8")
RULE = "coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb)"


def code(text: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


class CountryBlockMigration(unittest.TestCase):
    def test_it_adds_one_check_and_nothing_else(self):
        body = code(TEXT)
        self.assertEqual(re.findall(r"add constraint (\w+)", body), ["model_registry_countries_before_sale"])
        self.assertIn("check (availability not in ('beta', 'ga')\n         or " + RULE + " = '[]'::jsonb)", body)
        for forbidden in (r"\bcreate (or replace )?function\b", r"\bcreate policy\b", r"\bgrant\b", r"\brevoke\b", r"\bcreate trigger\b",
                          r"\bupdate public\.", r"\binsert into\b", r"\bdelete from\b"):
            self.assertNotRegex(body, forbidden)

    def test_it_is_idempotent_guarded_and_checks_its_end_state(self):
        body = code(TEXT)
        self.assertIn("drop constraint if exists model_registry_countries_before_sale", body)
        self.assertIn("'0142 needs 0035_model_registry.sql", body)
        self.assertIn("are on sale and carry blocked_countries", body)              # the pre-check names them
        self.assertIn("0142 end state", body)
        self.assertIn("c.convalidated", body)

    def test_the_file_says_it_is_applied_as_one_transaction_and_what_to_verify(self):
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "LIVE ON APPLY", "rollback_0142_country_block_before_sale.sql"):
            self.assertIn(needle, TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))

    def test_its_number_is_free_on_every_branch_it_names(self):
        self.assertEqual(sorted(p.name for p in MIG.parent.glob("0142_*.sql")), [MIG.name])
        for taken in ("0140", "0141", "0143"):
            self.assertIn(taken, TEXT)

    def test_the_rollback_is_one_transaction_and_drops_only_the_check(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertEqual(re.findall(r"drop constraint if exists (\w+)", code(ROLLBACK)), ["model_registry_countries_before_sale"])

    def test_the_docs_and_the_registry_say_why(self):
        mig_doc = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("(0142)", mig_doc)
        geo = (ROOT / "docs" / "GEO_BLOCK.md").read_text(encoding="utf-8")
        self.assertIn("The database does not check the country.", geo)
        self.assertNotIn("in front of\nevery call that prices, holds or queues anything.", geo)


if __name__ == "__main__":
    unittest.main()
