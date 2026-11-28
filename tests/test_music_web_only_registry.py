"""A music entry in schemas/model_registry.json is web_only (BR-S6-06), as captions and the picture and video ops are.

0250's sellable_models lists music on the web only, whatever a row's api_exposure says; this is the registry's half of the same rule,
so that an entry which claims the developer API ('any') or our connector ('web_mcp') for music fails validation before any sync.
"""

import copy
import json
import unittest

from modules import model_registry as reg

MUSIC_IDS = [m["id"] for m in json.loads(reg.REGISTRY_PATH.read_text())["models"] if "music" in m["capabilities"]]


class MusicIsAWebTool(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads(reg.REGISTRY_PATH.read_text())

    def mutated(self, mid, exposure):
        doc = copy.deepcopy(self.doc)
        next(m for m in doc["models"] if m["id"] == mid)["api_exposure"] = exposure
        return reg.validate(doc)

    def test_the_shipped_music_entries_are_web_only_and_valid(self):
        self.assertTrue(MUSIC_IDS)
        self.assertEqual(reg.validate(self.doc), [])
        for m in self.doc["models"]:
            if "music" in m["capabilities"]:
                self.assertEqual(m["api_exposure"], "web_only", m["id"])

    def test_a_music_entry_that_claims_the_api_or_the_connector_is_refused(self):
        for mid in MUSIC_IDS:
            for exposure in ("any", "web_mcp"):
                errors = self.mutated(mid, exposure)
                self.assertTrue(any("music is a web tool: api_exposure must be web_only" in e for e in errors), (mid, exposure, errors))

    def test_a_music_entry_without_api_exposure_is_refused_by_the_schema_and_by_the_rule(self):
        for mid in MUSIC_IDS:
            doc = copy.deepcopy(self.doc)
            del next(m for m in doc["models"] if m["id"] == mid)["api_exposure"]
            self.assertTrue(reg.validate(doc), mid)                      # the schema requires the key
            # And the music rule on its own (it runs after the schema), so loosening the schema can never let a default through.
            entry = next(m for m in doc["models"] if m["id"] == mid)
            self.assertTrue(reg.music_exposure_refused(entry), mid)

    def test_the_rule_accepts_exactly_web_only(self):
        base = {"capabilities": ["music"]}
        self.assertTrue(reg.music_exposure_refused(base))                 # missing
        for value in ("any", "web_mcp", "WEB_ONLY", "", None):
            self.assertTrue(reg.music_exposure_refused({**base, "api_exposure": value}), value)
        self.assertFalse(reg.music_exposure_refused({**base, "api_exposure": "web_only"}))
        self.assertFalse(reg.music_exposure_refused({"capabilities": ["t2i"]}))   # not music: other rules decide

    def test_web_only_is_the_only_value_the_rule_accepts(self):
        for mid in MUSIC_IDS:
            self.assertFalse(any("music is a web tool" in e for e in self.mutated(mid, "web_only")), mid)


if __name__ == "__main__":
    unittest.main()
