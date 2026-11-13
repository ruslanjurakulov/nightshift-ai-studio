"""supabase/migrations/0153_preview_price_by_quality.sql — an operator preview priced by quality takes that tier's vendor cost.

SQL does not run in this suite (tests/security/test_sec_preview_price_by_quality.py does that, against a real Postgres). These pin
what must not change by accident: creative_price is 0149's body plus exactly the two listed hunks (undo them and the rest is 0149's
text byte for byte), the preview rule and the money functions are not replaced, the tier is the one the quote already settled on
(never a preview default of its own), the drift guard, the end state and the rollback name the hashes recomputed from the files, the
grants, the lab knows the chain, and no registry entry is marked operator_preview unless the preview rate can price it.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import model_registry as reg

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0153_preview_price_by_quality.sql").read_text(encoding="utf-8")
OLD_TEXT = (MIG / "0149_preview_price_by_resolution.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0153_preview_price_by_quality.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
OLD = bodies(OLD_TEXT)
CP_0149 = "728241a09e56f65e19efc460afea7355"

#: (0149's text, 0153's text): every difference between the two creative_price bodies. Nothing else may differ.
HUNKS = [
    ("  -- provider_usd_per_unit. Any other variants.by (quality, audio, resolution_audio, upscale_target ...) stays unpriced.\n",
     "  -- provider_usd_per_unit. Any other variants.by (audio, resolution_audio, upscale_target ...) stays unpriced.\n"
     "  -- 0153: a model priced by quality states one figure per tier (pricing.variants.prices), and the figure is tier's: the tier the\n"
     "  -- quality settings above settled on (the request's, else medium when it names none), the one the quote names, the job carries and\n"
     "  -- the worker sends. A tier without its own figure is unpriced: never another tier's figure, never provider_usd_per_unit.\n"),
    ("              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'resolution' and vres is not null\n"
     "                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vres\n"
     "            end;\n",
     "              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'resolution' and vres is not null\n"
     "                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vres\n"
     "              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' and tier is not null\n"
     "                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> tier\n"
     "            end;\n"),
]


class PreviewPriceByQualityMigration(unittest.TestCase):
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

    def test_creative_price_is_0149s_body_plus_exactly_the_two_hunks(self):
        new, old = NEW["creative_price"], OLD["creative_price"]
        self.assertEqual(md5_of(old), CP_0149)
        for before, after in HUNKS:
            self.assertEqual(new.count(after), 1, after[:60])
            self.assertEqual(old.count(before), 1, before[:60])
            new = new.replace(after, before)
        self.assertEqual(new, old, "creative_price differs from 0149's beyond the listed hunks")
        for guard in ("model_is_available(mdl)", "not public.model_past_shutdown(r.spec)", "r.verified_at is not null",
                      "public.creative_operator_preview(p_org, r.availability, r.spec)", "preview := m_avail not in ('beta', 'ga');"):
            self.assertIn(guard, NEW["creative_price"])

    def test_the_preview_rate_takes_the_flat_figure_the_quoted_resolutions_or_the_quoted_tiers_and_nothing_else(self):
        cp = NEW["creative_price"]
        rate = cp[cp.index("    vusd := case"):cp.index("    vcost := case")]
        # Three sources and no fallback: a CASE without ELSE is NULL, and NULL is unpriced.
        self.assertEqual(rate.count("when "), 3)
        self.assertNotIn("else", rate)
        self.assertIn("->> 'by' = 'quality' and tier is not null", rate)
        self.assertIn("-> 'prices' -> tier", rate)
        # tier is the one the quality settings (0060) settled on for every quote: the request's, else medium. The preview never picks a
        # tier of its own (it would quote one tier and the worker would send another).
        self.assertIn("tier := coalesce(p_params ->> 'quality', 'medium');", cp)
        self.assertEqual(cp.count("tier :="), 1, "the preview never picks a tier of its own")
        settle = cp.index("tier := coalesce(p_params ->> 'quality', 'medium');")
        self.assertLess(cp.index("if cap in ('t2i', 'edit') and m_unit is not null"), settle)
        self.assertLess(settle, cp.index("vusd := case"))
        # The 0139 conversion, 0149's lines: x 100, no margin, 0 < figure <= 100, cast only a JSON number.
        self.assertIn("    vcost := case when jsonb_typeof(vusd) = 'number' then (vusd #>> '{}')::numeric end;\n", cp)
        self.assertIn("    if vcost > 0 and vcost <= 100 then\n      rate.unit := m_unit;\n"
                      "      rate.credits_per_unit := vcost * 100;\n      rate.margin := 0;\n", cp)
        # The preview rate is read only for a preview with no credit price of its own (the tier's unit).
        self.assertIn("  if preview and m_unit is not null and rate.unit is null\n", cp)
        self.assertLess(cp.index("select * into rate from public.credit_prices where unit = m_unit;"), cp.index("vusd := case"))
        # The quote still names the tier it is for.
        self.assertIn("case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end", cp)

    def test_grants(self):
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      CODE)
        self.assertNotIn("grant ", CODE.lower())

    def test_the_drift_guard_the_end_state_and_the_rollback_carry_the_hashes_of_the_files(self):
        new_md5 = md5_of(NEW["creative_price"])
        self.assertGreaterEqual(NEW_TEXT.count(new_md5), 3, "the guard, the end state and the verify query")
        self.assertIn(f"array['{CP_0149}', '{new_md5}']", NEW_TEXT)
        self.assertIn(f"array['{new_md5}', '{CP_0149}']", ROLLBACK_TEXT)
        # 0139's body is NOT accepted: this file was written on 0149's, and applying it on 0139's would skip 0149's hunks unseen.
        self.assertNotIn("ae28b700503542701ee0ac63a67df36e", CODE)
        self.assertIn("0153 found a creative_price() that is neither 0149''s body nor 0153''s", NEW_TEXT)
        self.assertLess(NEW_TEXT.index("0153 needs 0149_preview_price_by_resolution.sql"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.index("0153 found a creative_price()"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.rindex("create or replace function"), NEW_TEXT.index("The end state, asserted inside the transaction"))
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify", "LIVE ON APPLY"):
            self.assertIn(needle, NEW_TEXT)
        lab = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
        self.assertIn(f'CREATIVE_PRICE_0153 = "{new_md5}"', lab)

    def test_the_rollback_restores_0149s_text_byte_for_byte(self):
        rb = bodies(ROLLBACK_TEXT)
        self.assertEqual(set(rb), {"creative_price"})
        self.assertEqual(rb["creative_price"], OLD["creative_price"])
        self.assertIn("rollback 0153 found a creative_price() that is neither 0153''s body nor 0149''s", ROLLBACK_TEXT)
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      ROLLBACK_TEXT)
        self.assertNotIn("drop function", ROLLBACK_TEXT.lower())
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)

    def test_the_number_is_unique_and_the_lab_knows_it_sits_on_0149(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0153"), 1)
        self.assertIn("0149", numbers)
        lab = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
        # 0155 sits on 0153's creative_price, so ON_0149 lists it after 0153 (ON_0153).
        for needle in ("def take_off_0153(", "def put_back_0153(", "ON_0149 = (MIGRATION_0153.name, *ON_0153)",
                       "ON_0139 = (MIGRATION_0149.name, *ON_0149)", "ON_0125 = (MIGRATION_0139.name, *ON_0139)"):
            self.assertIn(needle, lab)
        # take_off_0149 takes 0153 off first, and put_back_0149 puts it back: 0149's rollback and replay refuse 0153's body.
        off = lab[lab.index("def take_off_0149("):lab.index("def put_back_0149(")]
        self.assertLess(off.index("take_off_0153(session)"), off.index("rollback_0149_body()"))
        on = lab[lab.index("def put_back_0149("):lab.index("CREATIVE_PRICE_0153 =")]
        self.assertIn("put_back_0153(session)", on)
        # take_off_0139 must still find the chain when the live body is 0153's (has_0149 compares 0149's hash only).
        off39 = lab[lab.index("def take_off_0139("):lab.index("def put_back_0139(")]
        self.assertIn("if has_0149(session) or has_0153(session) or has_0155(session)", off39)


#: Every entry the registry marks operator_preview today. A new one is a decision (a hidden model the operator can run in the Studio),
#: so it is added here on purpose, with its figure.
PREVIEW_SET = {"minimax-h3", "minimax-h3-highspeed", "minimax-h3-lite", "minimax-h3-max", "runway-gen4.5", "runway-gen4-turbo",
               "grounded-image-1.0", "ideogram-3", "ideogram-4", "ideogram-4.5"}

#: The image models the owner asked to preview. The vendor states no per-image figure for any of them (2026-11-13): OpenAI bills GPT
#: Image 2.5 by token ("The GPT Image 2 calculator does not estimate GPT-Image-2.5 token consumption"), so neither is marked and
#: neither is given a guessed figure. Ideogram's API price table is drawn in the browser, behind a script a plain fetch is refused; the
#: owner read it there on 2026-11-13 (3.0 and 4.0 Turbo, the speed the adapter sends: US$0.03 an image), so Ideogram 3 and 4 carry that
#: flat figure, labelled an estimate, and are marked. Ideogram 4.5 is priced by the tier it is sent (Low / Medium / High 1K/2K: US$0.03 /
#: 0.06 / 0.10, read the same way), so it carries one figure per tier. This test still holds every marked one to a figure the preview
#: rate can use.
ASKED = ("openai-gpt-image-2.5-flare", "openai-gpt-image-2.5-sunburst", "ideogram-3", "ideogram-4", "ideogram-4.5")


def _figure_ok(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and 0 < x <= 100


class NoPreviewIsADeadEnd(unittest.TestCase):
    """The registry side: every entry marked operator_preview is one 0139, 0149 or 0153 can price at what the Studio sends."""

    def setUp(self):
        self.r = reg.load()

    def test_the_preview_set_is_the_reviewed_one(self):
        self.assertEqual({e.id for e in self.r.values() if e.raw.get("operator_preview") is True}, PREVIEW_SET)

    def test_every_tier_of_a_quality_priced_preview_has_its_own_figure(self):
        for e in self.r.values():
            if e.raw.get("operator_preview") is not True:
                continue
            v = (e.raw.get("pricing") or {}).get("variants") or {}
            if v.get("by") != "quality":
                continue
            # A Studio request may name no tier: medium is what the quote then settles on, so medium must be offered and priced.
            self.assertIn("medium", e.qualities, e.id)
            for q in e.qualities:
                self.assertTrue(_figure_ok(v["prices"].get(q)), f"{e.id} {q}")

    def test_the_asked_for_image_models_are_not_marked_while_their_vendor_states_no_figure(self):
        for mid in ASKED:
            e = self.r[mid]
            p = e.raw["pricing"]
            v = p.get("variants") or {}
            if v.get("by") == "quality":
                resolves = "medium" in e.qualities and all(_figure_ok(v["prices"].get(q)) for q in e.qualities)
            else:
                resolves = not v and _figure_ok(p.get("provider_usd_per_unit"))
            if e.raw.get("operator_preview") is True:
                self.assertTrue(resolves, f"{mid} is marked operator_preview but every preview quote of it would be refused unpriced")


if __name__ == "__main__":
    unittest.main()
