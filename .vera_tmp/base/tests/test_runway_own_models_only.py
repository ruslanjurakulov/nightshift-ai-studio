"""Through Runway's API we sell only Runway's own models.

Runway's API also resells other makers' models (Magnific's upscaler, Kling, Veo, Seedance, MiniMax, Wan, Grok).
Bought through Runway, each one carries Runway's margin under ours, so the person pays a middleman twice; the
owner's rule (2026-11-13) is to wire such a model through its maker's own API instead. What would break without
this test: a third-party model added on a Runway adapter going on sale with nobody having decided it.
"""

import unittest

from modules import model_registry as reg

#: Runway's own models, by the vendor id its API takes. Adding one here is a decision that it is Runway-made.
RUNWAY_MADE = {"gen4.5", "gen4_turbo"}


class RunwayOwnModelsOnly(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def runway_entries(self):
        return [e for e in self.r.values() if e.adapter.startswith("video.runway") or e.provider == "runway"]

    def test_every_runway_entry_is_runway_made_or_gated(self):
        seen = self.runway_entries()
        self.assertTrue(seen, "no Runway entry found: the test would pass vacuously")
        for e in seen:
            if e.vendor_model not in RUNWAY_MADE:
                self.assertTrue(e.terms_gate, f"{e.id} resells {e.vendor_model} through Runway without a gate")

    def test_the_magnific_upscaler_through_runway_is_gated_and_says_why(self):
        e = self.r["runway-video-upscale"]
        self.assertEqual(e.vendor_model, "magnific_video_upscaler_creative")
        self.assertEqual(e.terms_gate, "terms_review_required")
        notes = " ".join(e.raw["terms_notes"])
        self.assertIn("only Runway's own models", notes)
        self.assertIn("own API instead", notes)
        self.assertIsNot(e.raw.get("operator_preview", False), True)

    def test_the_gate_reaches_the_database_row(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        self.assertEqual(rows["runway-video-upscale"]["spec"]["terms_gate"], "terms_review_required")


if __name__ == "__main__":
    unittest.main()
