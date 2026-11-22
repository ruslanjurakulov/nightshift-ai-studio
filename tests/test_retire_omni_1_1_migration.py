"""0222 retires gemini-omni-1.1-flash, and writes nothing else.

Google routes that id to gemini-omni-1.2-flash from 2026-12-03 (docs/studio/S10_GOOGLE_MODELS.md). Selling it after that would be a
silent substitute (CLAUDE.md rule 4). These pin what the file may touch (one column of one row), that the registry still agrees
with it, and that the rollback can only hide the model, never sell it. tests/security/test_sec_retire_omni_1_1.py runs it on Postgres.
"""

import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIG = (ROOT / "supabase" / "migrations" / "0222_retire_gemini_omni_1_1.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0222_retire_gemini_omni_1_1.sql").read_text(encoding="utf-8")
MID = "gemini-omni-1.1-flash"


def code(text):
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("--"))


class RetireOmni11(unittest.TestCase):
    def test_the_only_write_is_this_models_availability_set_to_disabled(self):
        c = code(MIG)
        writes = re.findall(r"(?i)\b(insert\s+into|update|delete\s+from|truncate|alter|create|drop|grant|revoke)\b\s+([\w.]+)", c)
        self.assertEqual(writes, [("update", "public.model_registry")], writes)
        self.assertIn("set availability = 'disabled' where id = mid and availability <> 'disabled'", c)
        self.assertIn(f"mid  constant text := '{MID}'", c)

    def test_it_checks_its_own_end_state_on_every_surface(self):
        c = code(MIG)
        for surface in ("web", "api", "mcp"):
            self.assertIn(f"public.sellable_models(null, '{surface}') s where s.id = mid", c)
        self.assertIn("is not disabled", c)

    def test_the_registry_row_still_says_why_and_stays_gated(self):
        reg = {m["id"]: m for m in json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
        m = reg[MID]
        # The vendor's announced date stays the vendor's (the schema: never a guess); 0222 is what retires it before then.
        self.assertEqual(m["shutdown"]["on"], "2026-12-03")
        self.assertEqual(m["shutdown"]["replacement"], "gemini-omni-1.2-flash")
        self.assertTrue(m.get("terms_gate"), "the row must stay terms-gated")
        self.assertNotIn("gemini-omni-1.2-flash", reg, "1.2 waits for the owner's terms decisions and a probe (S10)")

    def test_the_rollback_only_hides_it(self):
        c = code(ROLLBACK)
        self.assertEqual(re.findall(r"(?i)\b(insert\s+into|update|delete\s+from|alter|create|drop|grant|revoke)\b", c), ["update"])
        self.assertIn(f"set availability = 'hidden' where id = '{MID}' and availability = 'disabled'", c)
        self.assertNotRegex(c, r"'(beta|ga)'")


if __name__ == "__main__":
    unittest.main()
