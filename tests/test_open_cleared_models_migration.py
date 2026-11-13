"""supabase/migrations/0163_open_cleared_models.sql — the nine cleared, verified, priced models go on sale (beta) at 2.5x their vendor figure.

SQL does not run in this suite (tests/security/test_sec_open_cleared_models.py runs the file, the quotes and the rollback on a real
Postgres). These pin, from the files alone, what would cost money or break the owner's legal gate if it changed by accident:

* the nine are exactly the registry entries a sale is possible for today (no terms gate, a vendor figure for every priced variant, not past
  a shutdown, web only), and no terms-gated entry is named anywhere in the file;
* every price is the registry's own figure in cents at the 1.5 policy margin, so no unit sells below its vendor figure, every variant a
  quote can read has its own row, and a variant model's base row is its default variant's figure;
* the reviewed file carries the entitlement the database opens (null), the rollback restores the tiers the migration read, and deletes
  only the rows the migration wrote;
* the free sign-up credits the exposure statement is computed from are still 100;
* the Privacy Policy names the three vendors in every language;
* the file writes rows and nothing else: no function, policy, grant or constraint.
"""

import json
import re
import unittest
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
TEXT = (MIG / "0163_open_cleared_models.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0163_open_cleared_models.sql").read_text(encoding="utf-8")
REGISTRY = {m["id"]: m for m in json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
CODE = "\n".join(line.split("--", 1)[0] for line in TEXT.splitlines())
NINE = ("ideogram-3", "ideogram-4", "ideogram-4.5", "minimax-h3", "minimax-h3-highspeed", "minimax-h3-lite", "minimax-h3-max",
        "runway-gen4.5", "runway-gen4-turbo")
MARGIN = Decimal("1.5")


def _json_block(text, name):
    m = re.search(name + r" constant jsonb := \$json\$(.*?)\$json\$::jsonb;", text, re.S)
    assert m, name
    return json.loads(m.group(1), parse_float=Decimal, parse_int=Decimal)


MODELS = _json_block(TEXT, "models")
PRICES = _json_block(TEXT, "prices")


def figure(entry, variant):
    pricing = entry["pricing"]
    v = pricing["provider_usd_per_unit"] if variant is None else (pricing.get("variants") or {}).get("prices", {}).get(variant)
    return None if v is None else Decimal(str(v))


def past(entry, today="2026-11-13"):
    on = (entry.get("shutdown") or {}).get("on")
    return bool(on) and on <= today


def openable_from_the_file(entry):
    """What a sale needs that the reviewed file can show (verification is the database's: the migration refuses an unverified one)."""
    if entry.get("terms_gate") or entry.get("registry_only") or past(entry) or entry.get("api_exposure") != "web_only":
        return False
    if entry.get("blocked_countries"):
        return False
    variants = (entry["pricing"].get("variants") or {}).get("prices")
    if figure(entry, None) is None:
        return False
    return variants is None or all(v is not None for v in variants.values())


class TheNine(unittest.TestCase):
    def test_the_file_opens_exactly_the_entries_a_sale_is_possible_for(self):
        self.assertEqual(tuple(m["id"] for m in MODELS), NINE)
        self.assertEqual(sorted(i for i, e in REGISTRY.items() if openable_from_the_file(e)), sorted(NINE))

    def test_no_terms_gated_entry_is_named_anywhere_in_the_file(self):
        gated = [i for i, e in REGISTRY.items() if e.get("terms_gate")]
        self.assertGreaterEqual(len(gated), 60)
        for i in gated:
            self.assertNotRegex(TEXT, r"(?<![a-z0-9.-])" + re.escape(i) + r"(?![a-z0-9.-])", i)

    def test_each_model_is_the_call_the_registry_makes(self):
        for m in MODELS:
            e = REGISTRY[m["id"]]
            self.assertEqual((m["adapter"], m["vendor_model"], m["credit_unit"]), (e["adapter"], e["vendor_model"], e["credit_unit"]), m["id"])
            self.assertEqual(m["by"], (e["pricing"].get("variants") or {}).get("by"), m["id"])
            self.assertEqual(sorted(m["caps"]), sorted(e["capabilities"]), m["id"])
            self.assertNotIn("vendor_model_by_capability", e, m["id"])
            if m["by"] == "resolution":
                self.assertEqual(m["default"], e["default_resolution"], m["id"])
            if m["by"] == "quality":
                # creative_price settles on medium when no quality is named
                self.assertEqual(m["default"], "medium")
                self.assertIn("medium", e["qualities"])

    def test_the_file_refuses_what_it_cannot_see_in_the_registry(self):
        for phrase in ("verified_at is null or r.verified_probe_id is null", "spec ->> 'terms_gate'", "blocked_countries",
                       "model_past_shutdown(r.spec)", "r.availability = 'disabled'", "<> 'web_only'",
                       "r.capabilities @> want and r.capabilities <@ want", "r.spec ? 'vendor_model_by_capability'"):
            self.assertIn(phrase, CODE, phrase)


class Prices(unittest.TestCase):
    def test_every_price_is_the_registry_figure_in_cents_at_the_policy_margin(self):
        self.assertIn("c_margin constant numeric := 1.5;", CODE)
        for p in PRICES:
            e = REGISTRY[p["model"]]
            self.assertEqual(p["usd"], figure(e, p["variant"]), p["unit"])
            self.assertEqual(p["credits"], p["usd"] * 100, p["unit"])
            self.assertLessEqual(len(p["note"]), 300, p["unit"])
            self.assertTrue(p["note"].startswith("0163:"), p["unit"])

    def test_no_unit_sells_below_its_vendor_figure_and_the_note_says_what_it_sells_at(self):
        for p in PRICES:
            sold = p["credits"] * (1 + MARGIN)
            self.assertGreaterEqual(sold, p["usd"] * 100 * Decimal("2.5"), p["unit"])
            self.assertIn(f"Sold {sold.normalize():f} credits", p["note"], p["unit"])

    def test_every_variant_a_quote_can_read_has_its_own_row(self):
        units = {p["unit"] for p in PRICES}
        for m in MODELS:
            e = REGISTRY[m["id"]]
            self.assertIn(e["credit_unit"], units, m["id"])
            for v in ((e["pricing"].get("variants") or {}).get("prices") or {}):
                # model_registry.credit_unit_for / creative_price: <unit>_<variant>, anything not [a-z0-9] as _
                self.assertIn(e["credit_unit"] + "_" + re.sub(r"[^a-z0-9]", "_", v.lower()), units, (m["id"], v))
        self.assertEqual(len(units), len(PRICES), "a unit is priced twice")

    def test_a_variant_models_base_row_is_its_default_variants_figure(self):
        for m in MODELS:
            if m["by"] is None:
                continue
            base = next(p for p in PRICES if p["unit"] == m["credit_unit"])
            default = next(p for p in PRICES if p["model"] == m["id"] and p["variant"] == m["default"])
            self.assertEqual(base["credits"], default["credits"], m["id"])


class EntitlementAndRollback(unittest.TestCase):
    def test_the_reviewed_file_carries_the_entitlement_the_database_opens(self):
        for i in NINE:
            self.assertIsNone(REGISTRY[i]["entitlement"], i)
        self.assertIn("set entitlement = null", CODE)

    def test_the_rollback_restores_the_tiers_the_migration_read_and_deletes_only_its_own_rows(self):
        tiers = json.loads(re.search(r"tiers constant jsonb := \$json\$(.*?)\$json\$::jsonb;", ROLLBACK, re.S).group(1))
        self.assertEqual(tiers, {m["id"]: m["tier"] for m in MODELS})
        rates = json.loads(re.search(r"rates constant jsonb := \$json\$(.*?)\$json\$::jsonb;", ROLLBACK, re.S).group(1),
                           parse_float=Decimal, parse_int=Decimal)
        self.assertEqual(rates, {p["unit"]: p["credits"] for p in PRICES})
        self.assertIn("cp.note like '0163:%'", ROLLBACK)
        self.assertIn("cp.margin = 1.5", ROLLBACK)
        self.assertIn("'hidden'", ROLLBACK)

    def test_the_file_writes_rows_and_nothing_else(self):
        for pattern in (r"\bcreate\s+(or\s+replace\s+)?function\b", r"\bgrant\b", r"\brevoke\b", r"\balter\s+table\b",
                        r"\bcreate\s+policy\b", r"\bcreate\s+table\b", r"\bdelete\s+from\b", r"\bupdate\s+public\.credit_prices\b"):
            self.assertNotRegex(CODE, re.compile(pattern, re.I), pattern)
        self.assertEqual(re.findall(r"insert into public\.(\w+)", CODE), ["credit_prices"])
        self.assertEqual(re.findall(r"update public\.(\w+)", CODE), ["model_registry"])


class Exposure(unittest.TestCase):
    def test_the_free_credits_the_exposure_is_computed_from_are_still_100(self):
        # The PR and the header say: 100 welcome credits buy at most US$0.40 of vendor cost at 2.5x. A change to the grant changes that.
        latest = [p for p in sorted(MIG.glob("*.sql")) if "create or replace function public.grant_welcome_credits()" in p.read_text(encoding="utf-8")][-1]
        self.assertIn("welcome_credits constant numeric := 100;", latest.read_text(encoding="utf-8"), latest.name)
        worst = Decimal(100) / (1 + MARGIN) / 100
        self.assertEqual(worst, Decimal("0.4"))
        self.assertIn("at most US$0.40 of vendor cost per account", TEXT)


class TheLab(unittest.TestCase):
    """tests/security/test_sec_open_cleared_models.py runs where only tests/security/requirements.txt is installed (no `requests`), so
    it must not import modules.model_registry (its adapters import requests: a failed import stopped collection of the whole lab, CI
    run 43514470759). It builds the sync row itself; these keep that copy equal to the real one."""

    LAB = (ROOT / "tests" / "security" / "test_sec_open_cleared_models.py").read_text(encoding="utf-8")

    def test_the_lab_file_does_not_import_the_pipeline(self):
        self.assertNotRegex(self.LAB, r"(?m)^\s*(from|import)\s+modules\b")

    def test_the_lab_builds_the_row_sync_rows_builds(self):
        import ast
        import sys
        sys.path.insert(0, str(ROOT))
        from modules import model_registry as reg

        cols = re.search(r"^_COLUMNS = (\(.*?\))$", self.LAB, re.M).group(1)
        self.assertEqual(ast.literal_eval(cols), reg._COLUMNS)
        # The helper's own source, from this repository's test file (the lab module itself needs psycopg, which this suite may lack).
        ns = {"REGISTRY": REGISTRY, "_COLUMNS": reg._COLUMNS}
        exec(re.search(r"(?ms)^def _sync_row\(mid\):\n.*?(?=^\n)", self.LAB).group(0), ns)  # noqa: S102
        for row in reg.sync_rows([reg.get(i) for i in NINE]):
            self.assertEqual(ns["_sync_row"](row["id"]), row, row["id"])


class PrivacyPolicy(unittest.TestCase):
    def test_every_language_names_the_three_vendors_and_their_training_use(self):
        for loc, word in (("en", "improve"), ("ru", "улучшения"), ("uz", "yaxshilash")):
            text = (ROOT / "command-center" / "lib" / "legal-docs" / f"{loc}.ts").read_text(encoding="utf-8")
            row = next((ln for ln in text.splitlines() if "Ideogram, MiniMax, Runway" in ln), None)
            self.assertIsNotNone(row, loc)
            self.assertIn(word, row, loc)


if __name__ == "__main__":
    unittest.main()
