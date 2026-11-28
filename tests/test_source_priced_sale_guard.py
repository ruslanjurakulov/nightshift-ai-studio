"""No model priced by the length of a member's upload goes on sale while that
length can lie (BR-L-211, BR-L-212).

Every model below is billed per second of a SOURCE file: the database reads
the quantity from ``media_assets.duration_s`` (0050 ``creative_source_seconds``,
0052, 0072, 0100) or prices a character swap off the same column (0137). That
column is the container header, and the upscale's frame ceiling read the same
header: a forged file is billed by the vendor for more than the member paid.
Today every such model carries a ``terms_gate``, which 0035 turns into "never
beta or ga", so nobody can buy one. This test keeps that true until the
ledger rows say the lie is closed; once a row is ``fixed`` its check stops.

The family is derived, not listed: a capability whose input is a media file
(``base.FILE_INPUT``) on a model priced per second. A registry-file test cannot
see the owner clearing a gate in the database (0227 ``owner_accept_model_terms``);
that path is the owner's own act and is named in the ledger row.
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from modules.capabilities import base

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "schemas" / "model_registry.json"
LEDGER = ROOT / "docs" / "security" / "LEDGER.md"
MIGRATIONS = ROOT / "supabase" / "migrations"
FINDINGS = ("BR-L-211", "BR-L-212")


def _models():
    return json.loads(REGISTRY.read_text(encoding="utf-8"))["models"]


def source_priced(models):
    """Models billed per second of a file the member uploaded."""
    return [m for m in models if set(m["capabilities"]) & base.FILE_INPUT and m["pricing"]["unit"] == "second"]


def sellable(m) -> bool:
    # 0035 refuses lifecycle beta/ga for a model with any terms_gate; without
    # one, a model is on sale as soon as the owner prices it. 0035 reads an
    # empty gate as no gate, so "" is on sale too, not only a missing key.
    return not m.get("terms_gate")


def ledger_status(finding: str) -> str:
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in line.split("|")]
        if len(cells) > 5 and cells[1] == finding:
            return cells[5]
    raise AssertionError(f"{finding} is not in docs/security/LEDGER.md; this guard cannot tell whether it is open")


def is_open(status: str) -> bool:
    # Only a row that says it is fixed lets a model go on sale: anything else
    # (open, latent, wontfix, a typo) keeps the guard on, and "partially"
    # anywhere is still a hole (the summary counts it as open).
    s = status.strip().lower()
    return not s.startswith("fixed") or "partially" in s


# Any spelling Postgres accepts for a definition: without "or replace", without
# the schema, quoted, or with spaces around the dot. A later file written one of
# those ways is the function the database runs, and must not be skipped for an
# older one (Lens round 3, 6; Lens on #966 for the spaces).
_DEFINES_CREATIVE_PRICE = re.compile(
    r'create\s+(or\s+replace\s+)?function\s+("?public"?\s*\.\s*)?"?creative_price"?\s*\(', re.I)
_SOURCE_SECOND_CAPS = re.compile(
    r"if cap in \(([^)]*)\) then\s*\n\s*--[^\n]*\n\s*qty := public\.creative_source_seconds")


def source_second_caps(migrations: Path):
    """The capabilities the CURRENT ``creative_price`` prices by
    ``creative_source_seconds``: read from the last migration that defines the
    function, because that definition is the one the database runs. When that
    file no longer matches, the guard fails rather than reading an older one,
    which would vouch for a function that has been replaced."""
    files = [f for f in sorted(migrations.glob("*.sql"))
             if _DEFINES_CREATIVE_PRICE.search(f.read_text(encoding="utf-8"))]
    if not files:
        raise AssertionError("no migration defines public.creative_price: revisit this guard")
    last = files[-1]
    found = _SOURCE_SECOND_CAPS.findall(last.read_text(encoding="utf-8"))
    if not found:
        raise AssertionError(f"{last.name} is the latest creative_price and no longer prices by "
                             "creative_source_seconds in the shape this guard reads: revisit the guard")
    return last.name, set(re.findall(r"'([a-z_]+)'", found[-1]))


class SourcePricedSaleGuard(unittest.TestCase):
    def test_fix_br_l_211_and_br_l_212_before_selling_a_model_priced_by_its_source_length(self):
        family = source_priced(_models())
        self.assertTrue(family, "no source-priced model found: the derivation broke, not the rule")
        for finding in FINDINGS:
            if not is_open(ledger_status(finding)):
                continue
            for m in family:
                with self.subTest(finding=finding, model=m["id"]):
                    self.assertFalse(
                        sellable(m),
                        f"{m['id']} is priced per second of the member's upload and has no terms_gate, so it can be "
                        f"sold while {finding} is open in docs/security/LEDGER.md. Fix {finding} first (count the "
                        f"frames / measure the length the vendor bills), mark the row fixed, then clear the gate.")

    def test_every_model_that_starts_from_a_file_is_classified(self):
        # A file-input model priced in another unit escapes the family above
        # silently: decide whether its quantity is the source length, then
        # extend source_priced() rather than this exception.
        for m in _models():
            if set(m["capabilities"]) & base.FILE_INPUT:
                with self.subTest(model=m["id"]):
                    self.assertEqual(m["pricing"]["unit"], "second",
                                     f"{m['id']} starts from a file but is priced per {m['pricing']['unit']}: "
                                     "classify it for BR-L-211 / BR-L-212 in tests/test_source_priced_sale_guard.py")

    def test_the_databases_source_second_capabilities_are_in_the_family(self):
        # The latest creative_price names, in SQL, which capabilities read
        # creative_source_seconds. Each must be one the derivation covers.
        name, caps = source_second_caps(MIGRATIONS)
        self.assertTrue(caps)
        self.assertLessEqual(caps, set(base.FILE_INPUT), f"{name} prices {sorted(caps - base.FILE_INPUT)} "
                                                         "by source seconds, outside base.FILE_INPUT")

    def test_the_ledger_status_parser_reads_the_status_column(self):
        self.assertTrue(is_open("open"))
        self.assertTrue(is_open("open (latent: every affected model carries a terms gate)"))
        self.assertTrue(is_open("partially fixed (docs fixed)"))
        self.assertTrue(is_open("fixed, partially"))
        self.assertTrue(is_open("Fixed (PARTIALLY: the ingest half)"))
        self.assertTrue(is_open("wontfix"), "only a fixed row may let a source-priced model go on sale")
        self.assertTrue(is_open("fxied"))
        self.assertTrue(is_open(""))
        self.assertFalse(is_open("fixed"))
        self.assertFalse(is_open("Fixed"))
        self.assertFalse(is_open(" FIXED (0230)"))


class SaleGuardHelpers(unittest.TestCase):
    def test_an_empty_terms_gate_is_on_sale(self):
        # 0035: coalesce(terms_gate, '') = '' is "no gate".
        self.assertTrue(sellable({"terms_gate": ""}))
        self.assertTrue(sellable({"terms_gate": None}))
        self.assertTrue(sellable({}))
        self.assertFalse(sellable({"terms_gate": "terms_review_required"}))

    def _migrations(self, files):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: [p.unlink() for p in d.iterdir()] and d.rmdir())
        for name, body in files.items():
            (d / name).write_text(body, encoding="utf-8")
        return d

    SHAPED = ("create or replace function public.creative_price(p_org uuid) returns int as $$\n"
              "  if cap in ('dub', 'captions') then\n"
              "    -- The file's measured length, from the database.\n"
              "    qty := public.creative_source_seconds(p_org, p_params);\n$$;\n")

    def test_the_latest_creative_price_is_the_one_read(self):
        d = self._migrations({"0100_a.sql": self.SHAPED,
                              "0200_b.sql": self.SHAPED.replace("'dub', 'captions'", "'video_upscale'"),
                              "0300_c.sql": "-- mentions public.creative_price only in a comment\n"})
        self.assertEqual(source_second_caps(d), ("0200_b.sql", {"video_upscale"}))

    def test_every_spelling_of_a_definition_is_the_latest_one(self):
        for head in ("create function public.creative_price(",
                     "CREATE OR REPLACE FUNCTION creative_price (",
                     'create or replace function public."creative_price"(',
                     'create function "creative_price"(',
                     # A quoted schema is as valid as a quoted name (Lens on #955).
                     'create or replace function "public"."creative_price"(',
                     'CREATE FUNCTION "public".creative_price(',
                     # Whitespace around the dot is as valid to Postgres (Lens on #966).
                     'create or replace function public . creative_price(',
                     'create function "public" ."creative_price" ('):
            with self.subTest(head=head):
                d = self._migrations({"0100_a.sql": self.SHAPED,
                                      "0200_b.sql": head + "p_org uuid) returns int as $$ select 1 $$;\n"})
                with self.assertRaises(AssertionError) as e:
                    source_second_caps(d)
                self.assertIn("0200_b.sql", str(e.exception))

    def test_a_call_or_a_comment_is_not_a_definition(self):
        d = self._migrations({"0100_a.sql": self.SHAPED,
                              "0200_b.sql": "select public.creative_price(null);\n"
                                            "-- create or replace public.creative_price later\n"
                                            "create function public.creative_price_v2(x int) returns int "
                                            "as $$ select 1 $$;\n"})
        self.assertEqual(source_second_caps(d), ("0100_a.sql", {"dub", "captions"}))

    def test_a_latest_creative_price_without_the_shape_fails_instead_of_reading_an_older_one(self):
        d = self._migrations({"0100_a.sql": self.SHAPED,
                              "0200_b.sql": "create or replace function public.creative_price(p_org uuid) "
                                            "returns int as $$ select 1 $$;\n"})
        with self.assertRaises(AssertionError) as e:
            source_second_caps(d)
        self.assertIn("0200_b.sql", str(e.exception))


if __name__ == "__main__":
    unittest.main()
