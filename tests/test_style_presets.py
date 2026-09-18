"""Tests for modules.style_presets — the visual style preset library."""

import unittest

from modules import style_presets as sp


class CatalogTestCase(unittest.TestCase):
    def test_ids_and_names_are_unique_and_nonempty(self):
        ids = [p.id for p in sp.PRESETS]
        names = [p.name for p in sp.PRESETS]
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual(len(set(names)), len(names))
        for p in sp.PRESETS:
            self.assertTrue(p.id and p.name and p.directive and p.mood)
            # ids are slug-shaped so the frontend and pipeline agree
            self.assertRegex(p.id, r"^[a-z0-9-]+$")

    def test_catalog_dicts_round_trip(self):
        cat = sp.catalog()
        self.assertEqual(len(cat), len(sp.PRESETS))
        self.assertEqual(set(cat[0].keys()), {"id", "name", "directive", "mood"})


class GetTestCase(unittest.TestCase):
    def test_by_id_and_by_name_case_insensitive(self):
        self.assertIs(sp.get("cinematic-noir"), sp.get("Cinematic Noir"))
        self.assertEqual(sp.get("CINEMATIC-NOIR").id, "cinematic-noir")
        self.assertIsNone(sp.get("does-not-exist"))
        self.assertIsNone(sp.get(""))


class ExpandTestCase(unittest.TestCase):
    def test_expands_a_known_preset(self):
        out = sp.expand("neon-cyber")
        self.assertIn("cyberpunk", out)
        self.assertNotEqual(out, "neon-cyber")

    def test_leaves_freeform_style_unchanged(self):
        freeform = "warm sepia, vintage film grain, 1970s"
        self.assertEqual(sp.expand(freeform), freeform)

    def test_empty_in_empty_out(self):
        self.assertEqual(sp.expand(""), "")
        self.assertEqual(sp.expand(None), "")


if __name__ == "__main__":
    unittest.main()
