"""supabase/migrations/0149_preview_price_by_resolution.sql — an operator preview priced by resolution takes that resolution's cost.

SQL does not run in this suite (tests/security/test_sec_preview_price_by_resolution.py does that, against a real Postgres). These pin
what must not change by accident: creative_price is 0139's body plus exactly the two listed hunks (undo them and the rest is 0139's
text byte for byte), the preview rule and the money functions are not replaced, the drift guard, the end state and the rollback name
the hashes recomputed from the files, the grants, the lab knows the chain, and the registry entries that this file turns on.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import model_registry as reg

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0149_preview_price_by_resolution.sql").read_text(encoding="utf-8")
OLD_TEXT = (MIG / "0139_operator_preview.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0149_preview_price_by_resolution.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
OLD = bodies(OLD_TEXT)
CP_0139 = "ae28b700503542701ee0ac63a67df36e"

#: (0139's text, 0149's text): every difference between the two creative_price bodies. Nothing else may differ.
HUNKS = [
    ("  m_avail text;\n"
     "  preview boolean := false;\n"
     "begin\n",
     "  m_avail text;\n"
     "  preview boolean := false;\n"
     "  -- 0149: the vendor's figure for exactly the setting a preview is quoted at, and that figure as a number.\n"
     "  vusd    jsonb;\n"
     "  vcost   numeric;\n"
     "begin\n"),
    ("  -- sale. A figure the registry does not state, or prices by variant, stays unpriced.\n"
     "  if preview and m_unit is not null and rate.unit is null\n"
     "     and jsonb_typeof(m_spec -> 'pricing') = 'object'\n"
     "     and not (m_spec -> 'pricing' ? 'variants')\n"
     "     and jsonb_typeof(m_spec -> 'pricing' -> 'provider_usd_per_unit') = 'number'\n"
     "     and (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric > 0\n"
     "     and (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric <= 100 then\n"
     "    rate.unit := m_unit;\n"
     "    rate.credits_per_unit := (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric * 100;\n"
     "    rate.margin := 0;\n"
     "  end if;\n",
     "  -- sale. A figure the registry does not state stays unpriced.\n"
     "  -- 0149: the figure is the one for exactly what is quoted. A model without variants states one (provider_usd_per_unit). A\n"
     "  -- model priced by resolution states one per resolution (pricing.variants.prices), and the figure is vres's: the resolution the\n"
     "  -- video settings above settled on (the request's, else the model's pinned default_resolution), which the job then carries and\n"
     "  -- the worker sends. A resolution without its own figure is unpriced: never another resolution's figure, never\n"
     "  -- provider_usd_per_unit. Any other variants.by (quality, audio, resolution_audio, upscale_target ...) stays unpriced.\n"
     "  if preview and m_unit is not null and rate.unit is null\n"
     "     and jsonb_typeof(m_spec -> 'pricing') = 'object' then\n"
     "    vusd := case\n"
     "              when not (m_spec -> 'pricing' ? 'variants') then m_spec -> 'pricing' -> 'provider_usd_per_unit'\n"
     "              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'resolution' and vres is not null\n"
     "                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vres\n"
     "            end;\n"
     "    -- A figure that is not a JSON number is never cast: the CASE decides the order, not an `and`.\n"
     "    vcost := case when jsonb_typeof(vusd) = 'number' then (vusd #>> '{}')::numeric end;\n"
     "    if vcost > 0 and vcost <= 100 then\n"
     "      rate.unit := m_unit;\n"
     "      rate.credits_per_unit := vcost * 100;\n"
     "      rate.margin := 0;\n"
     "    end if;\n"
     "  end if;\n"),
]


class PreviewPriceByResolutionMigration(unittest.TestCase):
    def test_it_replaces_creative_price_only(self):
        self.assertEqual(set(NEW), {"creative_price"})
        # The rule of who may preview, the list, and the money path are not replaced: only the rate a preview is quoted at.
        for name in ("creative_operator_preview", "operator_preview_models", "create_creative_job", "quote_creative_job",
                     "reserve_credits", "capture_credits", "release_credits", "creative_platform_reserve", "sellable_models",
                     "creative_params_problem", "api_creative_model_ok", "route_model"):
            self.assertNotIn(f"function public.{name}(", CODE, name)
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy",
                     "create table"):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_creative_price_is_0139s_body_plus_exactly_the_two_hunks(self):
        new, old = NEW["creative_price"], OLD["creative_price"]
        self.assertEqual(md5_of(old), CP_0139)
        for before, after in HUNKS:
            self.assertEqual(new.count(after), 1, after[:60])
            self.assertEqual(old.count(before), 1, before[:60])
            new = new.replace(after, before)
        self.assertEqual(new, old, "creative_price differs from 0139's beyond the listed hunks")
        for guard in ("model_is_available(mdl)", "not public.model_past_shutdown(r.spec)", "r.verified_at is not null",
                      "public.creative_operator_preview(p_org, r.availability, r.spec)", "preview := m_avail not in ('beta', 'ga');"):
            self.assertIn(guard, NEW["creative_price"])

    def test_the_preview_rate_takes_only_the_flat_figure_or_the_quoted_resolutions(self):
        cp = NEW["creative_price"]
        rate = cp[cp.index("    vusd := case"):cp.index("    vcost := case")]
        # Two sources and no fallback: a CASE without ELSE is NULL, and NULL is unpriced.
        self.assertEqual(rate.count("when "), 2)
        self.assertNotIn("else", rate)
        self.assertIn("->> 'by' = 'resolution' and vres is not null", rate)
        self.assertIn("-> 'prices' -> vres", rate)
        # vres is the one the 0070 video settings settled on (the request's, else the pinned default): the same as every quote.
        self.assertIn("vres := coalesce(p_params ->> 'resolution', nullif(m_spec ->> 'default_resolution', ''));", cp)
        self.assertEqual(cp.count("vres :="), 1, "the preview never picks a resolution of its own")
        # The 0139 conversion: x 100, no margin, 0 < figure <= 100.
        self.assertIn("    if vcost > 0 and vcost <= 100 then\n      rate.unit := m_unit;\n"
                      "      rate.credits_per_unit := vcost * 100;\n      rate.margin := 0;\n", cp)
        # The preview rate is read only for a preview with no credit price of its own.
        self.assertIn("  if preview and m_unit is not null and rate.unit is null\n", cp)
        self.assertLess(cp.index("select * into rate from public.credit_prices where unit = m_unit;"), cp.index("vusd := case"))

    def test_grants(self):
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      CODE)
        self.assertNotIn("grant ", CODE.lower())

    def test_the_drift_guard_the_end_state_and_the_rollback_carry_the_hashes_of_the_files(self):
        new_md5 = md5_of(NEW["creative_price"])
        self.assertGreaterEqual(NEW_TEXT.count(new_md5), 3, "the guard, the end state and the verify query")
        self.assertIn(f"array['{CP_0139}', '{new_md5}']", NEW_TEXT)
        self.assertIn(f"array['{new_md5}', '{CP_0139}']", ROLLBACK_TEXT)
        self.assertIn("0149 found a creative_price() that is neither 0139''s body nor 0149''s", NEW_TEXT)
        self.assertLess(NEW_TEXT.index("0149 needs 0139_operator_preview.sql"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.index("0149 found a creative_price()"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.rindex("create or replace function"), NEW_TEXT.index("The end state, asserted inside the transaction"))
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify", "LIVE ON APPLY"):
            self.assertIn(needle, NEW_TEXT)
        lab = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
        self.assertIn(f'CREATIVE_PRICE_0149 = "{new_md5}"', lab)

    def test_the_rollback_restores_0139s_text_byte_for_byte(self):
        rb = bodies(ROLLBACK_TEXT)
        self.assertEqual(set(rb), {"creative_price"})
        self.assertEqual(rb["creative_price"], OLD["creative_price"])
        self.assertIn("rollback 0149 found a creative_price() that is neither 0149''s body nor 0139''s", ROLLBACK_TEXT)
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      ROLLBACK_TEXT)
        self.assertNotIn("drop function", ROLLBACK_TEXT.lower())
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)

    def test_the_number_is_unique_and_the_lab_knows_it_sits_on_0139(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0149"), 1)
        self.assertIn("0139", numbers)
        lab = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
        # 0153 sits on 0149's creative_price, so ON_0139 lists it after 0149 (ON_0149).
        for needle in ("def take_off_0149(", "def put_back_0149(", "ON_0139 = (MIGRATION_0149.name, *ON_0149)",
                       "ON_0125 = (MIGRATION_0139.name, *ON_0139)"):
            self.assertIn(needle, lab)
        # take_off_0139 takes 0149 off first, and put_back_0139 puts it back: 0139's rollback and replay refuse 0149's body.
        off = lab[lab.index("def take_off_0139("):lab.index("def put_back_0139(")]
        self.assertLess(off.index("take_off_0149(session)"), off.index("rollback_0139_body()"))
        on = lab[lab.index("def put_back_0139("):lab.index("CREATIVE_PRICE_0149 =")]
        self.assertIn("put_back_0149(session)", on)


class TheMiniMaxVideoEntriesItTurnsOn(unittest.TestCase):
    """The registry side: every entry marked operator_preview is one 0149 (or 0139) can price, so none is a dead end in the Studio."""

    def setUp(self):
        self.r = reg.load()

    def test_every_preview_entry_has_a_figure_the_preview_rate_can_read(self):
        marked = [e for e in self.r.values() if e.raw.get("operator_preview") is True]
        self.assertTrue(marked)
        for e in marked:
            p = e.raw["pricing"]
            v = p.get("variants")
            if not v:
                self.assertIsInstance(p["provider_usd_per_unit"], (int, float), e.id)
                self.assertTrue(0 < p["provider_usd_per_unit"] <= 100, e.id)
                continue
            if v["by"] == "quality":
                continue            # 0153's: tests/test_preview_price_by_quality_migration.py
            # by resolution, with the pinned resolution priced: a Studio request names none, so that is the one quoted
            self.assertEqual(v["by"], "resolution", e.id)
            self.assertIsNotNone(e.default_resolution, e.id)
            for res in e.resolutions:
                fig = v["prices"].get(res)
                self.assertIsInstance(fig, (int, float), f"{e.id} {res}")
                self.assertTrue(0 < fig <= 100, f"{e.id} {res}")


if __name__ == "__main__":
    unittest.main()
