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
    # one, a model is on sale as soon as the owner prices it.
    return m.get("terms_gate") is None


def ledger_status(finding: str) -> str:
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in line.split("|")]
        if len(cells) > 5 and cells[1] == finding:
            return cells[5]
    raise AssertionError(f"{finding} is not in docs/security/LEDGER.md; this guard cannot tell whether it is open")


def is_open(status: str) -> bool:
    # "partially fixed" is still a hole (the summary counts it as open).
    return not re.match(r"^(fixed|wontfix)\b", status)


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
        pattern = re.compile(r"if cap in \(([^)]*)\) then\s*\n\s*--[^\n]*\n\s*qty := public\.creative_source_seconds")
        latest = None
        for f in sorted(MIGRATIONS.glob("*.sql")):
            found = pattern.findall(f.read_text(encoding="utf-8"))
            if found:
                latest = (f.name, found[-1])
        self.assertIsNotNone(latest, "no migration prices by creative_source_seconds any more: revisit this guard")
        caps = set(re.findall(r"'([a-z_]+)'", latest[1]))
        self.assertTrue(caps)
        self.assertLessEqual(caps, set(base.FILE_INPUT), f"{latest[0]} prices {sorted(caps - base.FILE_INPUT)} "
                                                         "by source seconds, outside base.FILE_INPUT")

    def test_the_ledger_status_parser_reads_the_status_column(self):
        self.assertTrue(is_open("open"))
        self.assertTrue(is_open("partially fixed (docs fixed)"))
        self.assertFalse(is_open("fixed"))
        self.assertFalse(is_open("wontfix"))


if __name__ == "__main__":
    unittest.main()
