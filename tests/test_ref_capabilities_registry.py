"""The registry's inputs.ref_capabilities is the adapter's reference_capabilities, for every image model (0235's refs path).

film_price (supabase/migrations/0235_film_operator_preview.sql, `-- 0235 (refs path)`) can only read the registry spec, but the
adapter decides at submit: creative_adapters refuses reference pictures on any capability its adapter does not list in
reference_capabilities, and film_take_job makes every key frame as t2i. A registry that said t2i where the adapter does not (or the
other way round) would let the quote price, and Start hold, a film whose first take is then refused; or refuse a film that would work.

What would break, and which test says so:
* an image model with no inputs.ref_capabilities (the quote reads a missing field as "no references", rule 4, so it must be stated);
* a field that differs from what the model's adapter really sends references on, for any image entry;
* the loader accepting such a drift (modules/model_registry.py's cross check is what stops a bad file at sync time);
* the OpenAI image models (the first key-frame choice) ever reading as taking references from words.
"""

import copy
import json
import unittest
from pathlib import Path

from modules import model_registry as reg
from modules.capabilities import ADAPTERS

ROOT = Path(__file__).resolve().parent.parent
DOC = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
IMAGE = [m for m in DOC["models"] if m["output"] == "image"]


def adapter_refs(m):
    return [c for c in getattr(ADAPTERS[m["adapter"]], "reference_capabilities", ()) if c in m["capabilities"]]


class RefCapabilitiesMatchTheAdapter(unittest.TestCase):
    def test_every_image_model_states_exactly_what_its_adapter_sends_references_on(self):
        self.assertTrue(IMAGE)
        for m in IMAGE:
            with self.subTest(m["id"]):
                self.assertIn("ref_capabilities", m["inputs"], "a missing field reads as 'no references' in the quote: state it")
                self.assertEqual(sorted(m["inputs"]["ref_capabilities"]), sorted(adapter_refs(m)))

    def test_no_model_that_is_not_an_image_model_claims_references(self):
        for m in DOC["models"]:
            if m["output"] != "image":
                self.assertNotIn("ref_capabilities", m["inputs"], m["id"])

    def test_the_openai_image_models_take_references_only_on_edit(self):
        openai = [m for m in IMAGE if m["adapter"] == "image.openai"]
        self.assertTrue(openai)
        for m in openai:
            self.assertEqual(m["inputs"]["ref_capabilities"], ["edit"], m["id"])

    def test_the_gemini_models_s10_is_enabling_take_references_from_words(self):
        """The owner cleared Gemini image's terms; GeminiImageAdapter and the Interactions adapter send references on t2i and edit, so
        a film with references on these key-frame models is priced (and its take sends them)."""
        by_id = {m["id"]: m for m in IMAGE}
        for mid in ("gemini-3-pro-image", "gemini-nano-banana-2.1"):
            self.assertIn(mid, by_id)
            self.assertEqual(sorted(by_id[mid]["inputs"]["ref_capabilities"]), ["edit", "t2i"], mid)
        for m in IMAGE:
            if m["adapter"] in ("image.gemini", "image.gemini_interactions"):
                self.assertEqual(sorted(m["inputs"]["ref_capabilities"]), ["edit", "t2i"], m["id"])

    def test_the_loader_refuses_a_drift_either_way_and_a_missing_field(self):
        self.assertEqual(reg.validate(DOC), [])
        mid = next(m["id"] for m in IMAGE if m["adapter"] == "image.openai")
        for change in (["t2i", "edit"], [], None):
            doc = copy.deepcopy(DOC)
            m = next(x for x in doc["models"] if x["id"] == mid)
            if change is None:
                del m["inputs"]["ref_capabilities"]
            else:
                m["inputs"]["ref_capabilities"] = change
            with self.subTest(change=change):
                errors = reg.validate(doc)
                self.assertTrue(any(mid in e and "ref_capabilities" in e for e in errors), errors)

    def test_the_sync_carries_the_field_into_the_database_spec(self):
        rows = {r["id"]: r for r in reg.sync_rows(list(reg.load().values()))}
        for m in IMAGE:
            if m["id"] in rows:
                self.assertEqual(rows[m["id"]]["spec"]["inputs"]["ref_capabilities"], m["inputs"]["ref_capabilities"], m["id"])


if __name__ == "__main__":
    unittest.main()
