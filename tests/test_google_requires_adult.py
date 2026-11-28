"""Every model sold under the Gemini API terms is marked requires_adult, and the mark reaches the database.

The Gemini API Additional Terms (aistudio.google.com/docs/terms, "Effective March 23, 2026", read 2026-11-20): "You also will not
use the Services as part of a website, application, or other service (collectively, "API Clients") that is directed towards or is
likely to be accessed by individuals under the age of 18." The adult-attestation gate (requires_adult, stream S1) can only keep
those models from minors if every row carries the mark; a new Google row that forgets it would be sold to anyone.

Since 2026-11-28 this mark is also what the owner's clearance of Google's 18+ and consumer-use clauses rests on (gemini-3-pro-image
and gemini-nano-banana-2.1 lost their terms_gate on that reasoning: the 18+ attestation of 0192 is asked of every user). So it is a
pin for BR-832-02 (docs/security/LEDGER.md): nothing in the database refuses a sync that drops the flag, and this test is what fails
CI when a Google row loses it. The database-side guard is still open.
"""

import copy
import json
import unittest
from pathlib import Path

from modules import model_registry as reg

ROOT = Path(__file__).resolve().parent.parent
#: The one sentence CI prints when a Google row loses the mark: it names the gate that would quietly open, and the ledger row.
GATE = ("Gemini API terms are 18+ and the owner's 2026-11-28 clearance rests on the adult attestation (0192, requires_adult; "
        "BR-832-02): without the mark the next sync opens these rows to people who never confirmed their age")


def unmarked(models):
    return sorted(m["id"] for m in models if m.get("provider") == "google" and m.get("requires_adult") is not True)


class GoogleRowsRequireAnAdult(unittest.TestCase):
    def test_every_google_row_is_marked(self):
        google = {mid: e for mid, e in reg.load().items() if e.provider == "google"}
        self.assertTrue(google)
        self.assertEqual(unmarked([e.raw for e in google.values()]), [], GATE)

    def test_the_cleared_rows_are_marked(self):
        # The two rows whose terms_gate the owner cleared on 2026-11-28: their only 18+ gate is this flag.
        rows = reg.load()
        for mid in ("gemini-3-pro-image", "gemini-nano-banana-2.1"):
            self.assertIsNone(rows[mid].terms_gate, mid)
            self.assertIs(rows[mid].raw.get("requires_adult"), True, f"{mid}: {GATE}")

    def test_a_google_row_that_drops_the_mark_fails_with_the_gates_name(self):
        # The control: the check above would see a row that loses the key or turns it false (BR-832-02's repro).
        doc = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
        google = [m for m in doc["models"] if m["provider"] == "google"]
        for change in (lambda m: m.pop("requires_adult"), lambda m: m.__setitem__("requires_adult", False),
                       lambda m: m.__setitem__("requires_adult", "true")):
            models = copy.deepcopy(google)
            change(models[0])
            self.assertEqual(unmarked(models), [models[0]["id"]])
        with self.assertRaises(AssertionError) as e:
            models = copy.deepcopy(google)
            models[0].pop("requires_adult")
            self.assertEqual(unmarked(models), [], GATE)
        self.assertIn("adult attestation (0192, requires_adult; BR-832-02)", str(e.exception))

    def test_the_mark_is_synced_into_the_spec_the_gate_reads(self):
        rows = {r["id"]: r for r in reg.sync_rows(list(reg.load().values()))}
        for mid in ("gemini-nano-banana-2.1", "gemini-3-pro-image"):
            self.assertIs(rows[mid]["spec"]["requires_adult"], True, mid)


if __name__ == "__main__":
    unittest.main()
