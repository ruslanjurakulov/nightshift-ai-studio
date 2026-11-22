"""A vendor price rise the registry knows about must have its dated credit price written down (owner decision D7).

Our customer price must never fall below the vendor's cost, not even for a day. The vendor's cost lives in
schemas/model_registry.json (``pricing.changes``: an announced, dated rate change); the database cannot read that file, so this test
is the check. It fails when a model carries a dated change and docs/MIGRATIONS.md does not hold the credit_price_schedule row
(migration 0224) for each of the model's credit units at that exact moment, or holds one that scales the live rate by less than the
largest rise among the rates (if the live rate covers today's cost, a factor at least as large covers the new cost).

It checks what is documented, not what the owner ran: the live database is not reachable from here. The SQL editor query in the
document's step 3 is how the owner checks the row exists.
"""

from __future__ import annotations

import copy
import json
import re
import unittest
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

from modules import model_registry as reg

ROOT = Path(__file__).resolve().parent.parent
DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
REGISTRY = json.loads(reg.REGISTRY_PATH.read_text(encoding="utf-8"))

INSERT_RE = re.compile(r"insert into public\.credit_price_schedule\b.*?;$", re.S | re.I | re.M)


def documented_rows():
    """(unit, effective_at, factor) for every documented schedule insert that scales the live rate."""
    out = []
    for stmt in INSERT_RE.findall(DOC):
        unit = re.search(r"where unit = '([a-z0-9_]+)'", stmt)
        at = re.search(r"'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)'", stmt)
        factor = re.search(r"credits_per_unit \* \(([0-9.]+) / ([0-9.]+)\)", stmt)
        if unit and at and factor:
            out.append((unit.group(1), at.group(1), Fraction(factor.group(1)) / Fraction(factor.group(2))))
    return out


def units_of(m):
    variants = (m["pricing"].get("variants") or {}).get("prices") or {}
    return [m["credit_unit"]] + [reg.credit_unit_for(m["id"], m["pricing"]["unit"], k) for k in variants]


def changes():
    return [(m, c) for m in REGISTRY["models"] for c in (m["pricing"].get("changes") or ())]


class DatedVendorPrices(unittest.TestCase):
    def test_every_dated_vendor_change_has_its_schedule_row_documented(self):
        rows = documented_rows()
        for m, change in changes():
            rise = max(Fraction(str(r["to"])) / Fraction(str(r["from"])) for r in change["rates"].values())
            for unit in units_of(m):
                found = [f for u, at, f in rows if u == unit and at == change["effective_at"]]
                self.assertTrue(found, f"{m['id']}: no credit_price_schedule row for {unit} at {change['effective_at']} in "
                                       "docs/MIGRATIONS.md: the price would stay below the new cost from that moment")
                if rise > 1:
                    # A cut needs no row to stay above cost; a rise does, and by at least its own size.
                    self.assertGreaterEqual(min(found), rise, f"{m['id']}: {unit} is scaled by {min(found)}, the cost by {rise}")

    def test_d7_gemini_3_6_flash_doubles_at_2027_01_01_utc(self):
        # aistudio.google.com/docs/pricing, read 2026-11-22: the facts D7 rests on, pinned so an edit to the file is a decision.
        m = next(x for x in REGISTRY["models"] if x["id"] == "gemini-3.6-flash")
        (change,) = m["pricing"]["changes"]
        self.assertEqual(change["effective_at"], "2027-01-01T00:00:00Z")
        self.assertEqual(change["rates"], {"input_usd_per_1m_tokens": {"from": 0.75, "to": 1.5},
                                           "output_usd_per_1m_tokens": {"from": 3.75, "to": 7.5}})
        self.assertEqual(m["credit_unit"], "model_gemini_3_6_flash_request")
        # Still no per-request figure claimed: a token-billed model has none (CLAUDE.md #5).
        self.assertIsNone(m["pricing"]["provider_usd_per_unit"])
        self.assertIn(("model_gemini_3_6_flash_request", "2027-01-01T00:00:00Z", Fraction(2)), documented_rows())

    def test_the_parser_sees_a_missing_or_short_row(self):
        # The positive control: without the document's row, or with a factor below the rise, the main test would fail.
        self.assertTrue(documented_rows())
        self.assertEqual([r for r in documented_rows() if r[0] == "model_nobody_request"], [])
        short = INSERT_RE.findall(DOC)[0].replace("(1.50 / 0.75)", "(1.20 / 0.75)")
        f = re.search(r"credits_per_unit \* \(([0-9.]+) / ([0-9.]+)\)", short)
        self.assertLess(Fraction(f.group(1)) / Fraction(f.group(2)), 2)

    def test_the_moment_is_utc_and_on_the_calendar(self):
        for m, change in changes():
            at = datetime.strptime(change["effective_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            self.assertGreater(at.year, 2000, m["id"])


class ChangesValidation(unittest.TestCase):
    def mutate(self, f):
        d = copy.deepcopy(REGISTRY)
        f(next(x for x in d["models"] if x["id"] == "gemini-3.6-flash")["pricing"]["changes"][0])
        return reg.validate(d)

    def test_the_shipped_change_validates(self):
        self.assertEqual(reg.validate(copy.deepcopy(REGISTRY)), [])

    def test_a_date_off_the_calendar_is_refused(self):
        self.assertTrue(any("not on the calendar" in e for e in self.mutate(lambda c: c.update(effective_at="2027-02-30T00:00:00Z"))))

    def test_a_local_time_is_refused(self):
        # The schedule row is written in UTC: a moment with an offset (or none) would be read in some other zone.
        self.assertTrue(self.mutate(lambda c: c.update(effective_at="2027-01-01T00:00:00+05:00")))

    def test_a_change_that_changes_nothing_is_refused(self):
        def same(c):
            c["rates"] = {"input_usd_per_1m_tokens": {"from": 0.75, "to": 0.75}}
        self.assertTrue(any("changes no rate" in e for e in self.mutate(same)))

    def test_a_rate_from_nothing_is_refused(self):
        def zero(c):
            c["rates"]["input_usd_per_1m_tokens"]["from"] = 0
        self.assertTrue(any("above 0" in e for e in self.mutate(zero)))

    def test_a_change_without_its_source_is_refused(self):
        self.assertTrue(self.mutate(lambda c: c.pop("source_url")))
        self.assertTrue(self.mutate(lambda c: c.pop("evidence")))


if __name__ == "__main__":
    unittest.main()
