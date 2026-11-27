"""No ByteDance model ever reaches a connected assistant or the public API.

BytePlus's service terms §4.2.3 forbid re-integrating its video API into an AI content-creation tool (docs/FILM_STUDIO.md, "Models";
Scout 2026-11-14). An assistant connector (MCP) and the public developer API are both that kind of re-integration, so a Seedance or
Seedream model is web only in the registry file, never switched on for assistants, and migration 0219 refuses every one of them to
every connected assistant in the database, the operator's own workspace included (tests/security/test_sec_oauth_creative_operator.py
proves it on a real PostgreSQL). These pin the file side, so a registry edit cannot quietly reopen it.
"""

import copy
import json
import unittest
from pathlib import Path

from modules import model_registry

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
BY_ID = {m["id"]: m for m in REGISTRY["models"]}


def bytedance_models():
    return [m for m in REGISTRY["models"] if model_registry.is_bytedance(m)]


class NoByteDanceForAssistants(unittest.TestCase):
    def test_every_bytedance_model_is_found_by_every_name_it_has(self):
        ids = {m["id"] for m in bytedance_models()}
        # The id, the provider and the adapter each find them; the list is not empty, so the test below is not vacuous.
        self.assertTrue({"seedance-1.5-pro", "seedance-2.0", "seedream-5.0-pro"} <= ids, ids)
        for m in REGISTRY["models"]:
            named = ("seedance" in m["id"] or "seedream" in m["id"] or m["provider"] in ("bytedance", "byteplus")
                     or m["adapter"].startswith(("video.seedance", "image.seedream")))
            self.assertEqual(model_registry.is_bytedance(m), named, m["id"])

    def test_no_bytedance_model_is_exposed_past_the_web_or_switched_on_for_assistants(self):
        for m in bytedance_models():
            self.assertEqual(m["api_exposure"], "web_only", m["id"])
            self.assertNotIn(m["api_exposure"], ("any", "web_mcp"), m["id"])
            self.assertIsNot(m.get("mcp_oauth_exposure"), True, m["id"])

    def test_seedance_1_5_pro_is_web_only_and_says_why(self):
        # It was the one ByteDance model with api_exposure "any" (the public API and the 'mcp' surface): 0219's change.
        m = BY_ID["seedance-1.5-pro"]
        self.assertEqual(m["api_exposure"], "web_only")
        self.assertIn("§4.2.3", " ".join(m["terms_notes"]))

    def test_the_validator_refuses_a_bytedance_model_opened_to_the_api_or_an_assistant(self):
        for change in ({"api_exposure": "any"}, {"api_exposure": "web_mcp"}, {"api_exposure": "web_mcp", "mcp_oauth_exposure": True}):
            doc = copy.deepcopy(REGISTRY)
            target = next(m for m in doc["models"] if m["id"] == "seedance-1.5-pro")
            target.update(change)
            problems = model_registry.validate(doc)
            self.assertTrue(any("ByteDance" in p and p.startswith("seedance-1.5-pro") for p in problems), (change, problems))

    def test_the_validator_finds_a_renamed_bytedance_model_by_its_provider(self):
        doc = copy.deepcopy(REGISTRY)
        target = next(m for m in doc["models"] if m["id"] == "seedance-1.5-pro")
        self.assertTrue(model_registry.is_bytedance({**target, "id": "bd-video", "adapter": "video.other", "vendor_model": "x"}))
        self.assertTrue(model_registry.is_bytedance({"id": "x", "provider": "acme", "adapter": "video.seedance2", "vendor_model": "x"}))
        self.assertTrue(model_registry.is_bytedance({"id": "x", "provider": "acme", "adapter": "image.x", "vendor_model": "Seedream-9"}))
        self.assertFalse(model_registry.is_bytedance({"id": "minimax-h3", "provider": "minimax", "adapter": "video.minimax",
                                                      "vendor_model": "MiniMax-H3"}))

    def test_the_registry_as_shipped_passes_the_validator(self):
        self.assertEqual(model_registry.validate(REGISTRY), [])


if __name__ == "__main__":
    unittest.main()
