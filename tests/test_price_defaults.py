"""docs/sql/prices_defaults_2026_10_03.sql — the owner-apply file that gives every
chargeable unit without a price a starting value.

No database, no network: the file is parsed as text. What must hold:

* it is an insert into credit_prices that can never overwrite (``on conflict
  (unit) do nothing``) and contains no other statement;
* it does not repeat a unit the earlier price files / migrations seed (it would
  be a silent no-op or, worse, a second opinion on a price already chosen);
* every number is positive, every note fits credit_prices_note_check, and the
  ``est.:`` notes are exactly the declared guesses;
* every unit in it is one the code can actually charge (the registry's credit
  units and their priced variants, or a product unit a migration reads), so no
  row is dead weight;
* every chargeable registry unit is either seeded somewhere or on a short,
  reasoned list of units left unpriced on purpose, so a new model cannot slip
  in without a price or a decision.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from modules import model_registry as reg

ROOT = Path(__file__).resolve().parent.parent
SQL = ROOT / "docs" / "sql"
MIGRATIONS = ROOT / "supabase" / "migrations"
DEFAULTS = SQL / "prices_defaults_2026_10_03.sql"

#: Earlier files that seed credit_prices, in apply order.
EARLIER_SEEDS = (
    SQL / "prices_2026_10_01.sql",
    SQL / "prices_corrections_2026_10_01.sql",
    MIGRATIONS / "0030_paid_downloads.sql",
    MIGRATIONS / "0070_video_price_variants.sql",
)

UNIT_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")  # credit_prices_unit_check
ROW_RE = re.compile(
    r"\(\s*'(?P<unit>[a-z0-9_]+)'\s*,\s*(?P<rate>[0-9]+(?:\.[0-9]+)?)\s*,\s*(?P<margin>[0-9]+(?:\.[0-9]+)?)\s*,"
    r"\s*'(?P<note>(?:[^']|'')*)'\s*\)"
)

#: The units this file prices, and the ones it guesses (their note says est.:).
EXPECTED_COUNT = 11
EXPECTED_ESTIMATES = {
    "model_openai_gpt_image_2_5_flare_image_low",
    "model_openai_gpt_image_2_5_sunburst_image_low",
    "model_elevenlabs_scribe_v2_second",
    "repurpose_clip",
}

#: Chargeable units left without a price ON PURPOSE, each with the reason.
UNPRICED_ON_PURPOSE = {
    "video_minute": "held back (Lens-380): publishes the public rate and starts paid runs; owner applies when ready",
    "reply_draft": "held back (Lens-380): the comment inbox is the last deploy step",
    "scene_regenerate": "held back (Lens-380): the worker and 0076/0085 first",
    "scene_regenerate_clip_kling": "held back (Lens-380): per-clip unit loses money on a long clip",
    "scene_regenerate_clip_veo": "held back (Lens-380): per-clip unit loses money on a long clip",
    "scene_regenerate_clip_seedance": "held back (Lens-380): per-clip unit loses money on a long clip",
    "scene_regenerate_clip_wan": "held back (Lens-380): per-clip unit loses money on a long clip",
    "scene_regenerate_clip_minimax": "its default model has no price in the repository",
    "scene_regenerate_clip_higgsfield": "its default model has no price in the repository",
    "model_seedance_1_5_pro_second_480p_silent": "registry: no price read, not sold",
    "model_seedance_1_5_pro_second_480p_audio": "registry: no price read, not sold",
    "model_seedance_1_5_pro_second_1080p_silent": "registry: no price read, not sold",
    "usd": "pricing a ledger unit changes run settlement (metered vs hold): owner policy",
    "gemini_input_tokens": "ledger unit: owner policy",
    "gemini_output_tokens": "ledger unit: owner policy",
    "tts_characters": "ledger unit: owner policy",
    "render_seconds": "ledger unit: owner policy",
    "pexels_requests": "ledger unit: owner policy",
    "upload_bytes": "ledger unit: owner policy",
    "video_gen_clips": "ledger unit: owner policy",
    "image_generations": "ledger unit: owner policy",
    "vision_calls": "ledger unit: owner policy",
}


def _strip_comments(sql: str) -> str:
    return "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))


def _statements(code: str) -> list:
    """Split on ';' outside single-quoted strings ('' escapes a quote)."""
    out, cur, quoted = [], [], False
    for ch in code:
        if ch == "'":
            quoted = not quoted
        if ch == ";" and not quoted:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return out


def _rows(path: Path):
    return [m.groupdict() for m in ROW_RE.finditer(_strip_comments(path.read_text()))]


def _seeded_units() -> set:
    """Units an earlier file inserts or updates: any quoted unit literal at the
    start of a values tuple, or named by an `update ... where unit = '<u>'`."""
    out = set()
    for path in EARLIER_SEEDS:
        text = _strip_comments(path.read_text())
        out.update(m.group(1) for m in re.finditer(r"\(\s*'([a-z0-9_]+)'\s*,\s*[0-9]", text))
        out.update(m.group(1) for m in re.finditer(r"where unit = '([a-z0-9_]+)'", text))
    return out


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", text.lower())


def _registry_units() -> dict:
    """Every credit unit a registry model can be quoted at, as migrations
    0060 / 0070 / 0052 / 0084's creative_price builds them: the base unit
    (sellable_models joins on it), a tier per quality, a variant per priced
    setting, a target per video-upscale resolution. A variant the registry
    states as null ("no price read") is listed too: it is a unit the quote
    would ask for."""
    units = {}
    for m in reg.models():
        base = m.credit_unit
        units[base] = m.id
        variants = m.raw["pricing"].get("variants") or {}
        by = variants.get("by")
        if by == "quality":
            for tier in m.qualities:
                units[f"{base}_{_slug(tier)}"] = m.id
        elif by in ("audio", "resolution_audio") or (by == "resolution" and m.default_resolution):
            for key in variants.get("prices", {}):
                units[f"{base}_{_slug(key)}"] = m.id
        elif by == "upscale_target":
            for target in m.upscale_targets:
                units[f"{base}_{_slug(target)}"] = m.id
    return units


def _scene_providers() -> list:
    text = (MIGRATIONS / "0076_scene_regenerate.sql").read_text()
    m = re.search(r"provider in \(([^)]*)\)", text)
    assert m, "0076 no longer lists its providers"
    return re.findall(r"'([a-z0-9]+)'", m.group(1))


def _product_units() -> set:
    """Units a migration reads by name, outside the registry."""
    return {"video_minute", "job_minimum", "scene_regenerate", "repurpose_clip", "reply_draft"} | {
        f"scene_regenerate_clip_{p}" for p in _scene_providers()
    }


class PriceDefaultsFile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = DEFAULTS.read_text()
        cls.code = _strip_comments(cls.text)
        cls.rows = _rows(DEFAULTS)

    def test_one_insert_that_never_overwrites(self):
        statements = [s.strip() for s in _statements(self.code) if s.strip()]
        self.assertEqual(len(statements), 1, "the file is a single statement")
        stmt = re.sub(r"\s+", " ", statements[0].lower())
        self.assertTrue(stmt.startswith("insert into public.credit_prices (unit, credits_per_unit, margin, note) values"))
        self.assertTrue(stmt.endswith("on conflict (unit) do nothing"))
        for word in ("update ", "delete ", "drop ", "truncate ", "alter ", "grant ", "revoke ", "do update"):
            self.assertNotIn(word, stmt)

    def test_every_tuple_parsed(self):
        # A tuple the regex skipped (a typo in a number, a stray quote) would
        # silently be unpriced: count the opening quotes of unit names.
        opened = re.findall(r"^\s*\('([^']*)'", self.code, flags=re.M)
        self.assertEqual(len(opened), len(self.rows))
        self.assertEqual(sorted(opened), sorted(r["unit"] for r in self.rows))

    def test_total_and_no_duplicates(self):
        units = [r["unit"] for r in self.rows]
        self.assertEqual(len(units), len(set(units)), "a unit appears twice")
        self.assertEqual(len(units), EXPECTED_COUNT)

    def test_numbers_are_positive_and_notes_fit(self):
        for r in self.rows:
            self.assertRegex(r["unit"], UNIT_RE)
            self.assertGreater(float(r["rate"]), 0, r["unit"])
            self.assertGreater(float(r["margin"]), 0, r["unit"])
            self.assertLessEqual(float(r["margin"]), 10, r["unit"])  # credit_prices_margin_check
            note = r["note"].replace("''", "'")
            self.assertTrue(note.strip(), r["unit"])
            self.assertLessEqual(len(note), 300, f"{r['unit']}: credit_prices_note_check")
            # numeric(18,8): the rate must fit eight decimals
            self.assertLessEqual(len(r["rate"].partition(".")[2]), 8, r["unit"])

    def test_estimates_are_marked_and_only_those(self):
        marked = {r["unit"] for r in self.rows if r["note"].startswith("est.:")}
        self.assertEqual(marked, EXPECTED_ESTIMATES)

    def test_does_not_repeat_an_earlier_seed(self):
        clash = {r["unit"] for r in self.rows} & _seeded_units()
        self.assertEqual(clash, set(), "already priced by an earlier file or migration")

    def test_applies_after_the_other_price_files(self):
        names = sorted(p.name for p in SQL.glob("prices_*.sql"))
        self.assertEqual(names[-1], DEFAULTS.name)

    def test_every_unit_is_one_the_code_can_charge(self):
        chargeable = set(_registry_units()) | _product_units()
        stray = {r["unit"] for r in self.rows} - chargeable
        self.assertEqual(stray, set(), "a row nothing would ever read")

    def test_product_units_are_read_by_name_in_the_migrations(self):
        reads = {
            "video_minute": "0041_run_billing_hardening.sql",
            "scene_regenerate": "0076_scene_regenerate.sql",
            "repurpose_clip": "0080_repurpose.sql",
            "reply_draft": "0081_comment_inbox.sql",
        }
        for unit, migration in reads.items():
            self.assertIn(f"unit = '{unit}'", (MIGRATIONS / migration).read_text(), unit)
        self.assertIn("'scene_regenerate_clip_' ||", (MIGRATIONS / "0076_scene_regenerate.sql").read_text())

    def test_quality_tiers_match_what_the_registry_sells(self):
        tiers = {u for u, _ in _registry_units().items() if re.search(r"_image_(low|medium|high)$", u)}
        self.assertEqual(len(tiers), 9)
        self.assertTrue(tiers <= {r["unit"] for r in self.rows})

    def test_every_chargeable_unit_is_priced_or_left_unpriced_on_purpose(self):
        priced = _seeded_units() | {r["unit"] for r in self.rows}
        ledger = {
            "gemini_input_tokens", "gemini_output_tokens", "tts_characters", "render_seconds", "pexels_requests",
            "upload_bytes", "video_gen_clips", "image_generations", "vision_calls", "usd",
        }
        chargeable = set(_registry_units()) | _product_units() | ledger
        missing = chargeable - priced - set(UNPRICED_ON_PURPOSE)
        self.assertEqual(missing, set(), "chargeable units with no price and no stated reason")
        # And a unit cannot be both priced and "on purpose" unpriced.
        self.assertEqual(set(UNPRICED_ON_PURPOSE) & priced, set())
        # The reasoned list names real units only.
        self.assertEqual(set(UNPRICED_ON_PURPOSE) - chargeable, set())

    def test_ledger_units_here_match_the_code(self):
        from modules import cost_ledger as cl

        in_code = {cl.GEMINI_INPUT_TOKENS, cl.GEMINI_OUTPUT_TOKENS, cl.TTS_CHARACTERS, cl.RENDER_SECONDS,
                   cl.PEXELS_REQUESTS, cl.UPLOAD_BYTES, cl.VIDEO_GEN_CLIPS, cl.IMAGE_GENERATIONS, cl.VISION_CALLS}
        listed = {u for u, why in UNPRICED_ON_PURPOSE.items() if why.startswith("ledger unit")}
        self.assertEqual(in_code, listed)

    def test_held_rows_are_only_comments(self):
        held = [u for u, why in UNPRICED_ON_PURPOSE.items() if why.startswith("held back")]
        self.assertEqual(len(held), 7)
        for unit in held:
            self.assertNotIn(f"('{unit}'", self.code, f"{unit} must not be applied by this file")
            self.assertRegex(self.text, rf"(?m)^--\s+\('{unit}'", f"{unit} should stay visible as a commented row")


if __name__ == "__main__":
    unittest.main()
