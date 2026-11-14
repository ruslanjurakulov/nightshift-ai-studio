"""Registry corrections of 2026-11-11, each read on the maker's own page that day
(docs/research/registry-corrections-2026-11-11.md). These tests pin them so a later edit
cannot quietly undo one:

* api_exposure web_only where the maker's terms bar handing the API or model to third
  parties (Runway, Kling, Alibaba Model Studio, ElevenLabs OEM, BytePlus), each with the
  clause, its section and the date it was read in terms_notes (like tests/test_ideogram_web_only.py);
* the same terms_gate for every live entry under the same vendor terms (BFL, Google Gemini
  API, BytePlus): the stricter reading the gated siblings already had;
* the prices the makers' pricing pages state, with source_url and as_of, still unconfirmed;
* Gemini Omni 1.1 silently served by 1.2 at 1.2's price from 2026-12-03, the day its sale ends.

No network, no database, no key.
"""
import unittest
from datetime import date

from modules import model_registry as reg

READ = "2026-11-11"

#: Entry -> (section, words of the clause) that must be in its terms_notes.
WEB_ONLY = {
    **{mid: ("§1.3(a)", "except as permitted through the APIs") for mid in
       ("runway-gen4.5", "runway-gen4-turbo", "runway-video-upscale")},
    **{mid: ("3.3", "provide these resources to others for use") for mid in ("kling-v2.6", "kling-v3")},
    **{mid: ("§4.48.1(d)(v)", "resell Model Studio or AI models provided through Model Studio") for mid in
       ("wan-2.7", "wan-3.0")},
    **{mid: ("§2.B(a)", "who will itself Make Available") for mid in
       ("elevenlabs-v4", "elevenlabs-v3", "elevenlabs-multilingual-v2", "elevenlabs-flash-v2.5", "elevenlabs-sfx",
        "elevenlabs-voice-changer", "elevenlabs-dubbing-v2", "elevenlabs-dubbing-v1")},
    "seedance-1.0-pro": ("6.2(1)", "MaaS"),
}

#: The only entries still offered to the API, and why they were not changed here.
STILL_ANY = {
    "openai-gpt-image-2": "openai.com/policies/* answered 403 on 2026-11-11: nothing could be quoted",
    "openai-gpt-image-2.5-flare": "same",
    "openai-gpt-image-2.5-sunburst": "same",
    "luma-ray-3.2": "Luma's terms were not re-read on 2026-11-11",
    "seedance-1.5-pro": "past its shutdown (2026-11-11): not sold at all",
    # Added after the review (0176): our own engine; the MCP Studio tools offer it like the web Studio does. Its transcription is
    # ElevenLabs Scribe (terms-gated plan_required:scale like every ElevenLabs entry); an API customer receives a rendered video,
    # never Scribe itself, and whether OEM Terms §2.B(a) still asks for web_only is the owner's decision (its terms_notes).
    "nightshift-voice-explainer": "our own engine (voice_explainer, 0176), its transcription terms-gated; web_only is an owner decision",
}

#: Entries whose terms_gate changed from null on 2026-11-11 (each takes the model off sale).
NEWLY_GATED = {
    "flux-2-pro": "terms_review_required",
    "flux-2-max": "terms_review_required",
    "flux-2-flex": "terms_review_required",
    "flux-3-video": "terms_review_required",
    "gemini-3.1-flash-image": "terms_review_required",
    "gemini-3.1-flash-lite-image": "terms_review_required",
    "gemini-3-pro-image": "terms_review_required",
    "gemini-3.6-flash": "terms_review_required",
    "seedance-1.0-pro": "written_consent_required",
}


class ApiExposure(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_each_entry_whose_terms_bar_third_parties_is_web_only_with_the_clause_quoted(self):
        for mid, (section, words) in WEB_ONLY.items():
            with self.subTest(mid=mid):
                e = self.r[mid]
                self.assertEqual(e.api_exposure, "web_only")
                notes = e.raw["terms_notes"]
                self.assertTrue(any(section in n and words in n for n in notes), notes)     # the clause, quoted
                self.assertTrue(any(f"read {READ}" in n for n in notes), notes)             # when it was read
                self.assertIn("web_only", " ".join(notes))
                self.assertTrue(all(len(n) <= 300 for n in notes))                          # what the schema allows

    def test_only_the_entries_with_a_stated_reason_are_still_offered_to_the_api(self):
        self.assertEqual({mid for mid, e in self.r.items() if e.api_exposure == "any"}, set(STILL_ANY))

    def test_the_flag_reaches_the_database_row(self):
        # sellable_models(capability, 'api') hides web_only rows from the API and MCP (docs/API.md).
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in WEB_ONLY:
            self.assertEqual(rows[mid]["spec"]["api_exposure"], "web_only", mid)

    def test_runway_attribution_links_where_its_terms_say(self):
        # Terms of Use §1: "prominently display 'Powered by Runway' and link to runway.com".
        for mid in ("runway-gen4.5", "runway-gen4-turbo", "runway-video-upscale"):
            self.assertEqual(self.r[mid].raw["attribution"], {"text": "Powered by Runway", "url": "https://runway.com"}, mid)
            self.assertNotIn("runwayml.com", " ".join(self.r[mid].raw["terms_notes"]), mid)


class GatesUnderTheSameTerms(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_the_entries_that_changed_gate_are_exactly_these(self):
        for mid, gate in NEWLY_GATED.items():
            self.assertEqual(self.r[mid].terms_gate, gate, mid)
            self.assertIn("was null", " ".join(self.r[mid].raw["terms_notes"]), mid)

    def test_every_live_entry_under_one_vendors_terms_carries_a_gate(self):
        # The past-shutdown entries (Veo 3.1, Seedance 1.5 Pro) are not sold at all and were left as they are.
        today = date(2026, 11, 11)
        for provider in ("bfl", "google", "bytedance"):
            live = [e for e in self.r.values() if e.provider == provider and not e.shut_down(today)]
            self.assertTrue(live, provider)
            for e in live:
                self.assertTrue(e.terms_gate, f"{provider}: {e.id} is ungated")

    def test_the_bfl_gate_quotes_the_training_licence_for_every_flux_model(self):
        for mid in ("flux-2-pro", "flux-2-max", "flux-2-flex", "flux-3-video"):
            notes = " ".join(self.r[mid].raw["terms_notes"])
            self.assertIn("2(b)", notes, mid)
            self.assertIn("may use Inputs and Outputs to train", notes, mid)
            self.assertIn("Last Revised on August 4, 2026", notes, mid)
        for mid in ("flux-3-image", "flux-3-image-klein"):
            self.assertNotIn("with no gate", " ".join(self.r[mid].raw["terms_notes"]), mid)

    def test_the_google_gate_quotes_the_age_and_consumer_clauses(self):
        for mid in ("gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-3.6-flash"):
            notes = " ".join(self.r[mid].raw["terms_notes"])
            self.assertIn("You must be 18 years of age or older to use the APIs", notes, mid)
            self.assertIn("not for consumer use", notes, mid)
            self.assertIn("Effective March 23, 2026", notes, mid)

    def test_the_byteplus_gate_on_the_pipeline_default_does_not_touch_the_pipeline(self):
        import config
        e = self.r["seedance-1.0-pro"]
        self.assertEqual(e.vendor_model, config.SEEDANCE_MODEL)     # the pipeline reads config, never the gate
        self.assertIn("Effective: Sep 30, 2026", " ".join(e.raw["terms_notes"]))


class Prices(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def pricing(self, mid):
        p = self.r[mid].raw["pricing"]
        self.assertEqual(p["as_of"], READ, mid)
        self.assertFalse(p["confirmed"], mid)          # a page figure, not yet the probe's billed amount
        return p

    def test_flux_3_video_is_priced_by_band_from_the_pricing_page(self):
        p = self.pricing("flux-3-video")
        self.assertEqual((p["provider_usd_per_unit"], p["source_url"]), (0.15, "https://bfl.ai/pricing"))
        self.assertEqual(p["variants"], {"by": "resolution", "prices": {"720p": 0.15, "1080p": 0.24}})
        self.assertIn("HD$0.15/s", p["note"])
        self.assertIn("FHD$0.24/s", p["note"])

    def test_elevenlabs_prices_are_the_api_pricing_page(self):
        for mid, price, words in (("elevenlabs-scribe-v2", 0.0000556, "$0.20 Price per hour"),
                                  ("elevenlabs-v4", 0.00008, "$0.08 Price per 1K characters"),
                                  ("elevenlabs-v3", 0.00008, "$0.08 Price per 1K characters")):
            p = self.pricing(mid)
            self.assertEqual((p["provider_usd_per_unit"], p["source_url"]), (price, "https://elevenlabs.io/pricing/api"), mid)
            self.assertIn(words, p["note"], mid)
        self.assertGreaterEqual(0.0000556 * 3600, 0.20)   # rounded up, never below the hourly rate

    def test_kling_2_6_is_the_720p_silent_rate_the_adapter_asks_for(self):
        p = self.pricing("kling-v2.6")
        self.assertEqual((p["provider_usd_per_unit"], p["source_url"]),
                         (0.042, "https://kling.ai/document-api/pricing/base/video"))
        self.assertIn("0.3 Units ($0.042) /s", p["note"])
        self.assertIn("mode std", p["note"])

    def test_hailuo_2_3_is_billed_per_clip_and_no_per_second_figure_is_claimed(self):
        p = self.pricing("minimax-hailuo-2.3")
        self.assertIsNone(p["provider_usd_per_unit"])
        self.assertEqual(p["source_url"], "https://platform.minimax.io/docs/pricing/overview")
        for clip in ("$0.28 per 768P, 6s video", "$0.56 per 768P, 10s video", "$0.49 per 1080P, 6s video"):
            self.assertIn(clip, p["note"])


class GeminiOmniRoutesTo12(unittest.TestCase):
    def setUp(self):
        self.e = reg.load()["gemini-omni-1.1-flash"]

    def test_the_shutdown_fields_end_the_sale_on_the_routing_day_and_name_1_2(self):
        s = self.e.raw["shutdown"]
        self.assertEqual((s["on"], s["replacement"]), ("2026-12-03", "gemini-omni-1.2-flash"))
        self.assertFalse(self.e.shut_down(date(2026, 12, 2)))
        self.assertTrue(self.e.shut_down(date(2026, 12, 3)))

    def test_the_price_note_says_calls_are_served_and_billed_as_1_2_from_that_day(self):
        note = self.e.raw["pricing"]["note"]
        self.assertIn("From 2026-12-03", note)
        self.assertIn("billed at gemini-omni-1.2-flash rates", note)
        self.assertIn("$12/1M video", note)
        self.assertIn("ESTIMATE", note)
        self.assertIn("automatically routing API requests to gemini-omni-1.2-flash", self.e.raw["api_documented"]["note"])
        self.assertTrue(any(n.startswith("Silent routing:") for n in self.e.raw["terms_notes"]))


if __name__ == "__main__":
    unittest.main()
