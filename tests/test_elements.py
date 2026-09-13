"""Tests for modules.elements (Character Bible) + AgentConfig round-trip."""

import unittest

from modules import elements as E
from modules.channels import AgentConfig


CONFIG_ELEMENTS = [
    {"kind": "character", "name": "Chronos", "description": "a hooded time guide with a glowing hourglass",
     "aliases": ["the guide"]},
    {"kind": "location", "name": "Ancient Library", "description": "a vast candlelit archive"},
    {"name": "no-kind", "description": "defaults to character"},   # kind omitted
    {"description": "no name — dropped"},                           # invalid
    "junk",                                                          # invalid
]


class LoadElementsTestCase(unittest.TestCase):
    def test_loads_valid_and_drops_invalid(self):
        els = E.load_elements(CONFIG_ELEMENTS)
        names = [e.name for e in els]
        self.assertEqual(names, ["Chronos", "Ancient Library", "no-kind"])
        self.assertEqual(els[0].kind, "character")
        self.assertEqual(els[1].kind, "location")
        self.assertEqual(els[2].kind, "character")  # omitted kind defaults

    def test_empty_config_is_empty(self):
        self.assertEqual(E.load_elements(None), [])
        self.assertEqual(E.load_elements([]), [])


class DetectTestCase(unittest.TestCase):
    def setUp(self):
        self.els = E.load_elements(CONFIG_ELEMENTS)

    def test_detects_by_name_and_alias(self):
        matched = E.detect("Then Chronos opened the door.", self.els)
        self.assertEqual([e.name for e in matched], ["Chronos"])
        # alias match
        matched2 = E.detect("the guide vanished", self.els)
        self.assertEqual([e.name for e in matched2], ["Chronos"])

    def test_no_match_returns_empty(self):
        self.assertEqual(E.detect("a plain sentence about nothing", self.els), [])

    def test_consistency_prompt_uses_descriptions(self):
        matched = E.detect("Inside the Ancient Library, Chronos waited.", self.els)
        prompt = E.consistency_prompt(matched)
        self.assertIn("Chronos", prompt)
        self.assertIn("glowing hourglass", prompt)
        self.assertIn("Ancient Library", prompt)

    def test_empty_consistency_prompt_when_none(self):
        self.assertEqual(E.consistency_prompt([]), "")

    def test_scene_style_combines_detect_and_prompt(self):
        style = E.scene_style("Chronos speaks", self.els)
        self.assertIn("Chronos", style)

    def test_summarize_counts_and_applied(self):
        applied = {0: ["Chronos"], 1: ["Chronos", "Ancient Library"], 2: []}
        summary = E.summarize(self.els, applied)
        self.assertEqual(summary["defined"], 3)
        self.assertEqual(summary["by_kind"]["character"], 2)
        self.assertEqual(summary["by_kind"]["location"], 1)
        self.assertEqual(summary["applied"], ["Ancient Library", "Chronos"])
        self.assertEqual(summary["scenes_touched"], 2)


class AgentConfigElementsTestCase(unittest.TestCase):
    def test_elements_roundtrip_through_dict(self):
        cfg = AgentConfig.from_dict({"elements": CONFIG_ELEMENTS})
        # invalid entries dropped, three kept
        self.assertEqual(len(cfg.elements), 3)
        self.assertEqual(cfg.elements[0]["name"], "Chronos")
        # round-trips
        again = AgentConfig.from_dict(cfg.to_dict())
        self.assertEqual(len(again.elements), 3)
        self.assertEqual(again.elements[1]["kind"], "location")

    def test_absent_elements_is_empty_tuple(self):
        cfg = AgentConfig.from_dict({})
        self.assertEqual(cfg.elements, ())


if __name__ == "__main__":
    unittest.main()
