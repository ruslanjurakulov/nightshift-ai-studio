"""Every model sold under the Gemini API terms is marked requires_adult, and the mark reaches the database.

The Gemini API Additional Terms (aistudio.google.com/docs/terms, "Effective March 23, 2026", read 2026-11-20): "You also will not
use the Services as part of a website, application, or other service (collectively, "API Clients") that is directed towards or is
likely to be accessed by individuals under the age of 18." The adult-attestation gate (requires_adult, stream S1) can only keep
those models from minors if every row carries the mark; a new Google row that forgets it would be sold to anyone.
"""

import unittest

from modules import model_registry as reg


class GoogleRowsRequireAnAdult(unittest.TestCase):
    def test_every_google_row_is_marked(self):
        google = {mid: e for mid, e in reg.load().items() if e.provider == "google"}
        self.assertTrue(google)
        unmarked = sorted(mid for mid, e in google.items() if e.raw.get("requires_adult") is not True)
        self.assertEqual(unmarked, [], "Gemini API terms are 18+: mark these rows requires_adult")

    def test_the_mark_is_synced_into_the_spec_the_gate_reads(self):
        rows = {r["id"]: r for r in reg.sync_rows(list(reg.load().values()))}
        self.assertIs(rows["gemini-nano-banana-2.1"]["spec"]["requires_adult"], True)


if __name__ == "__main__":
    unittest.main()
