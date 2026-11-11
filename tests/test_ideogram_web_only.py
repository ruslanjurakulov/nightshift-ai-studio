"""Ideogram stays inside the Studio: its Developer API Agreement 2.3.3 forbids
providing the Ideogram API, or access to the Ideogram model, to third parties.
Selling generations in our own app fits 2.1(b); our public API and MCP would
pass it on, so every Ideogram entry is api_exposure web_only
(docs/research/monitoring-claims-2026-11-10.md)."""
import unittest

from modules import model_registry as reg

IDEOGRAM = ("ideogram-3", "ideogram-4", "ideogram-upscale")


class IdeogramIsWebOnly(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_every_ideogram_entry_is_web_only(self):
        found = [mid for mid, e in self.r.items() if e.provider == "ideogram"]
        self.assertEqual(sorted(found), sorted(IDEOGRAM))
        for mid in found:
            self.assertEqual(self.r[mid].api_exposure, "web_only", mid)

    def test_the_reason_is_written_on_each_entry(self):
        for mid in IDEOGRAM:
            notes = " ".join(self.r[mid].raw["terms_notes"])
            self.assertIn("2.3.3", notes, mid)
            self.assertIn("third parties", notes, mid)

    def test_the_flag_reaches_the_database_row(self):
        # sellable_models(capability, 'api') hides web_only rows from the API and MCP (docs/API.md).
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in IDEOGRAM:
            self.assertEqual(rows[mid]["spec"]["api_exposure"], "web_only", mid)

    def test_the_attribution_duty_is_kept(self):
        for mid in IDEOGRAM:
            self.assertEqual((self.r[mid].raw.get("attribution") or {}).get("text"), "Powered by Ideogram", mid)


if __name__ == "__main__":
    unittest.main()
