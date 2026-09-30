"""The model registry file, its schema, and the rule that nothing in it is "available".

A model reaches a user only after a real probe (migration 0035). These tests
pin the Python half: the file validates against the schema itself, every
entry names an adapter that exists and can serve it, prices never appear
without a source, credit units are ones credit_prices accepts, and nothing a
file edit can add makes a model available.
"""

from __future__ import annotations

import copy
import json
import unittest

from modules import model_registry as reg
from modules.capabilities import ADAPTERS
from modules.capabilities.base import CAPABILITIES, CapabilityRequest


def doc():
    return json.loads(reg.REGISTRY_PATH.read_text())


def entry_by_id(d, mid):
    return next(m for m in d["models"] if m["id"] == mid)


class RegistryFileTests(unittest.TestCase):
    def test_the_shipped_registry_validates_against_its_schema(self):
        self.assertEqual(reg.validate(doc()), [])
        self.assertGreaterEqual(len(reg.load()), 20)

    def test_the_schema_uses_only_keywords_the_evaluator_enforces(self):
        # A keyword the evaluator ignores is a rule nobody enforces.
        self.assertEqual(reg.unsupported_keywords(reg.load_schema()), [])
        bad = copy.deepcopy(reg.load_schema())
        bad["$defs"]["model"]["properties"]["id"]["format"] = "hostname"
        self.assertIn("keywords the evaluator does not enforce", reg.validate(doc(), bad)[0])

    def test_schema_capability_enum_matches_the_capability_layer(self):
        self.assertEqual(tuple(reg.load_schema()["$defs"]["capability"]["enum"]), CAPABILITIES)

    def test_every_adapter_key_resolves_and_serves_its_capabilities(self):
        for e in reg.load().values():
            cls = ADAPTERS.get(e.adapter)
            self.assertIsNotNone(cls, f"{e.id}: adapter {e.adapter} does not exist")
            for cap in e.capabilities:
                self.assertIn(cap, cls.capabilities, f"{e.id}: {e.adapter} cannot do {cap}")

    def test_every_adapter_is_used_by_some_model(self):
        used = {e.adapter for e in reg.load().values()}
        self.assertEqual(sorted(set(ADAPTERS) - used), [])

    def test_imagen_is_not_offered_through_the_gemini_api(self):
        # Google shut Imagen down on the Gemini API (2026-08-17).
        self.assertFalse([e for e in reg.load().values() if e.vendor_model.startswith("imagen-")])

    def test_credit_units_are_valid_credit_prices_units_and_unique(self):
        units = []
        for m in doc()["models"]:
            units.append(m["credit_unit"])
            for k in (m["pricing"].get("variants") or {}).get("prices", {}):
                units.append(reg.credit_unit_for(m["id"], m["pricing"]["unit"], k))
        for u in units:
            self.assertRegex(u, reg.CREDIT_UNIT_RE)
        self.assertEqual(len(units), len(set(units)))

    def test_every_probe_is_a_request_its_own_entry_accepts(self):
        for e in reg.load().values():
            req = e.probe_request(voice_id="A" * 20, generated_image="https://probe.invalid/x.png")
            self.assertEqual(e.problems(req), [], e.id)

    def test_vendor_terms_gates_are_set_where_scouts_found_them(self):
        r = reg.load()
        self.assertEqual(r["luma-ray-3.2"].terms_gate, "written_consent_required")
        for mid, e in r.items():
            if e.provider == "elevenlabs":
                self.assertEqual(e.terms_gate, "plan_required:scale", mid)
            if e.provider == "bfl":
                self.assertEqual(e.api_exposure, "web_only", mid)
            if e.provider in ("runway", "ideogram"):
                self.assertIsNotNone(e.raw["attribution"], mid)
            if e.provider == "google":
                self.assertTrue(any("§20.d" in n for n in e.raw["terms_notes"]), mid)


class ValidationRejectsTests(unittest.TestCase):
    def mutate(self, mid, fn):
        d = doc()
        fn(entry_by_id(d, mid))
        return reg.validate(d)

    def assertRejected(self, errors, fragment):
        self.assertTrue(any(fragment in e for e in errors), errors)

    def test_availability_cannot_be_typed_into_the_file(self):
        # The database owns availability and verification (CLAUDE.md #5).
        for field, value in (("availability", "ga"), ("verified_at", "2026-09-30T00:00:00Z")):
            errs = self.mutate("veo-3.1", lambda m, f=field, v=value: m.__setitem__(f, v))
            self.assertRejected(errs, f"unknown field {field}")

    def test_a_price_without_source_and_date_is_refused(self):
        def f(m):
            m["pricing"].update(provider_usd_per_unit=0.5, source_url=None, as_of=None)
        self.assertRejected(self.mutate("kling-v3", f), "needs source_url and as_of")

    def test_a_credit_unit_credit_prices_would_refuse_is_refused(self):
        self.assertRejected(self.mutate("veo-3.1", lambda m: m.__setitem__("credit_unit", "model:veo-3.1:second")),
                            "credit_unit")

    def test_unknown_adapter_is_refused(self):
        self.assertRejected(self.mutate("veo-3.1", lambda m: m.__setitem__("adapter", "video.nope")),
                            "does not exist")

    def test_adapter_that_cannot_serve_the_capability_is_refused(self):
        self.assertRejected(self.mutate("runway-gen4.5", lambda m: m.__setitem__("adapter", "video.bfl")),
                            "cannot serve")

    def test_duplicate_id_is_refused(self):
        d = doc()
        d["models"].append(copy.deepcopy(d["models"][0]))
        self.assertTrue(any("duplicate id" in e for e in reg.validate(d)))

    def test_price_variant_must_be_an_offered_resolution(self):
        def f(m):
            m["pricing"]["variants"]["prices"]["8k"] = 1.0
        self.assertTrue(self.mutate("veo-3.1", f))

    def test_entitlement_category_must_match_output(self):
        self.assertRejected(self.mutate("veo-3.1", lambda m: m.__setitem__("entitlement", "models_image:basic")),
                            "entitlement category")

    def test_unknown_terms_gate_is_refused(self):
        self.assertTrue(self.mutate("luma-ray-3.2", lambda m: m.__setitem__("terms_gate", "ok_trust_me")))

    def test_probe_the_entry_itself_would_refuse_is_refused(self):
        self.assertRejected(self.mutate("veo-3.1", lambda m: m["probe"].__setitem__("duration_s", 5)),
                            "probe request is not servable")

    def test_i2v_without_image_refs_is_refused(self):
        self.assertRejected(self.mutate("veo-3.1", lambda m: m["inputs"].__setitem__("image_refs_max", 0)),
                            "image_refs_max")


class CapabilityDetectionTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_runway_text_to_video_takes_only_its_two_ratios(self):
        e = self.r["runway-gen4.5"]
        self.assertTrue(e.problems(CapabilityRequest("t2v", "x", aspect_ratio="1:1", duration_s=5)))
        self.assertEqual(e.problems(CapabilityRequest("i2v", "x", aspect_ratio="1:1", duration_s=5,
                                                       input_images=("https://a/b.png",))), [])

    def test_a_setting_the_model_does_not_take_is_refused_not_ignored(self):
        e = self.r["flux-3-video"]            # no confirmed duration field
        self.assertTrue(any("duration" in p for p in e.problems(CapabilityRequest("t2v", "x", duration_s=5))))
        g = self.r["gemini-2.5-flash-image"]  # no image sizes
        self.assertTrue(g.problems(CapabilityRequest("t2i", "x", image_size="4K")))

    def test_prompt_limit_counts_utf16_units(self):
        e = self.r["runway-gen4.5"]             # 1000 UTF-16 units
        emoji = "\U0001F600" * 501              # 1002 units, 501 code points
        self.assertTrue(any("longer" in p for p in e.problems(CapabilityRequest("t2v", emoji, duration_s=5))))

    def test_audio_on_a_silent_model_is_refused(self):
        e = self.r["seedance-1.0-pro"]
        self.assertTrue(e.problems(CapabilityRequest("t2v", "x", duration_s=5, audio=True)))


class SyncRowsTests(unittest.TestCase):
    def test_sync_never_carries_availability_or_verification(self):
        for row in reg.sync_rows(list(reg.load().values())):
            for banned in ("availability", "verified_at", "verified_by", "verified_probe_id"):
                self.assertNotIn(banned, row)
                self.assertNotIn(banned, row["spec"])
            self.assertIn("vendor_model", row["spec"])
            self.assertIn("terms_gate", row["spec"])


if __name__ == "__main__":
    unittest.main()
