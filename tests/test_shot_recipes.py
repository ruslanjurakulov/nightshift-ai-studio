"""Tests for modules.shot_recipes (the closed recipe catalogue + chooser), the
style bible on modules.style_presets, and Director Mode's recipe field."""

import json
import unittest
from pathlib import Path

from modules import director
from modules import shot_recipes as sr
from modules import style_presets as sp

ROOT = Path(__file__).resolve().parents[1]


def _ir_scene(i, name, narration, stype="story", start=None, end=None):
    """A scene in the Video IR contract shape."""
    return {
        "id": f"s{i:03d}", "index": i, "name": name, "type": stype,
        "narration": narration, "start_s": start, "end_s": end,
        "shot": {"recipe": None, "camera": "", "lighting": "", "mood": ""},
        "element_ids": [], "asset_ids": [], "claim_ids": [],
    }


class CatalogTestCase(unittest.TestCase):
    def test_ids_unique_slug_shaped_and_complete(self):
        ids = [r.id for r in sr.RECIPES]
        self.assertEqual(len(ids), len(set(ids)))
        for r in sr.RECIPES:
            self.assertRegex(r.id, r"^[a-z][a-z0-9_]*$")
            self.assertIn(r.kind, sr.KINDS)
            self.assertTrue(r.description)
            self.assertTrue(r.backends)
            self.assertTrue(set(r.backends) <= set(sr.BACKENDS), r.id)
            self.assertLessEqual(r.min_s, r.max_s)
            self.assertTrue(set(r.beats) <= set(sr.BEATS), r.id)
            self.assertTrue(set(r.contexts) <= set(sr.CONTENT_CONTEXTS), r.id)
            if r.requires_context:
                self.assertTrue(r.contexts, r.id)

    def test_roadmap_recipes_present(self):
        for rid in ("slow_push", "slow_pull", "parallax", "archival_reveal", "map_zoom",
                    "quote_card", "stat_counter", "chapter_card", "title_card", "crossfade"):
            self.assertTrue(sr.is_valid(rid), rid)

    def test_every_fallback_chain_ends_at_a_universal_recipe(self):
        universal = set(sr.BACKENDS)
        for r in sr.RECIPES:
            seen, cur = set(), r
            while not universal.issubset(cur.backends):
                self.assertIsNotNone(cur.fallback, f"{r.id} has no fallback")
                self.assertNotIn(cur.id, seen)
                seen.add(cur.id)
                cur = sr.get(cur.fallback)
                self.assertIsNotNone(cur)
                self.assertNotEqual(cur.kind, sr.KIND_TRANSITION)

    def test_default_recipe_is_universal(self):
        self.assertEqual(set(sr.get(sr.DEFAULT_RECIPE).backends), set(sr.BACKENDS))

    def test_get_normalize_and_catalog(self):
        self.assertEqual(sr.get(" Slow_Push ").id, "slow_push")
        self.assertIsNone(sr.get("explode_zoom"))
        self.assertIsNone(sr.get(None))
        self.assertEqual(sr.normalize("explode_zoom"), sr.DEFAULT_RECIPE)
        self.assertEqual(sr.normalize("quote_card"), "quote_card")
        cat = sr.catalog()
        self.assertEqual(len(cat), len(sr.RECIPES))
        json.dumps(cat)  # serialisable
        self.assertEqual(set(sr.ids(sr.KIND_TRANSITION)), {"crossfade", "dip_to_black", "hard_cut"})

    def test_resolve_for_backends(self):
        self.assertEqual(sr.resolve_for_backends("stat_counter", ["remotion"]), "stat_counter")
        self.assertEqual(sr.resolve_for_backends("stat_counter", ["ffmpeg"]), "slow_push")
        self.assertEqual(sr.resolve_for_backends("archival_reveal", ["ffmpeg"]), "archival_reveal")
        self.assertEqual(sr.resolve_for_backends("parallax", ["moviepy"]), "slow_push")
        self.assertEqual(sr.resolve_for_backends("nope", ["ffmpeg"]), "slow_push")
        self.assertEqual(sr.resolve_for_backends("parallax", []), sr.DEFAULT_RECIPE)


class SceneReadingTestCase(unittest.TestCase):
    def test_duration_from_ir_times(self):
        self.assertEqual(sr.scene_duration(_ir_scene(0, "a", "x", start=1.5, end=6.5)), 5.0)

    def test_duration_null_is_unknown_not_zero(self):
        self.assertIsNone(sr.scene_duration(_ir_scene(0, "a", "x")))
        self.assertIsNone(sr.scene_duration(_ir_scene(0, "a", "x", start=0.0, end=None)))
        self.assertIsNone(sr.scene_duration(_ir_scene(0, "a", "x", start=5.0, end=5.0)))

    def test_duration_falls_back_to_hint(self):
        self.assertEqual(sr.scene_duration({"duration_hint": 12}), 12.0)
        self.assertIsNone(sr.scene_duration({"duration_hint": 0}))

    def test_contexts(self):
        ctx = lambda t, **k: sr.scene_contexts({"narration": t, **k})  # noqa: E731
        self.assertIn(sr.CTX_NUMERIC, ctx("Sales fell 40% in a year"))
        self.assertIn(sr.CTX_NUMERIC, ctx("It cost $5 million"))
        self.assertIn(sr.CTX_QUOTE, ctx('He wrote "we will never go back there" and left'))
        self.assertNotIn(sr.CTX_QUOTE, ctx('a "short" word'))
        self.assertIn(sr.CTX_GEOGRAPHY, ctx("twenty miles off the coast"))
        self.assertNotIn(sr.CTX_GEOGRAPHY, ctx("mapping the problem"))
        self.assertIn(sr.CTX_ARCHIVAL, ctx("back in December 1900"))
        self.assertNotIn(sr.CTX_ARCHIVAL, ctx("a documentary"))
        self.assertIn(sr.CTX_CHAPTER, ctx("x", name="Chapter 2: the storm"))
        self.assertIn(sr.CTX_TITLE, ctx("x", type="title"))
        self.assertEqual(ctx("plain words"), ())


class ChooserTestCase(unittest.TestCase):
    def test_always_returns_a_scene_recipe(self):
        for scene in ({}, {"narration": None}, _ir_scene(0, "", ""), object()):
            rid = sr.choose_recipe(scene)
            self.assertTrue(sr.is_valid(rid))
            self.assertNotEqual(sr.get(rid).kind, sr.KIND_TRANSITION)

    def test_content_picks_graphic_when_it_fits(self):
        s = _ir_scene(3, "numbers", "Revenue grew 300% that year.", start=10, end=16)
        self.assertEqual(sr.choose_recipe(s, index=3, total=8), "stat_counter")
        q = _ir_scene(3, "q", 'She said "nothing will ever be the same" that night.', start=0, end=8)
        self.assertEqual(sr.choose_recipe(q, index=3, total=8), "quote_card")
        c = _ir_scene(4, "Chapter 2", "The storm.", start=0, end=5)
        self.assertEqual(sr.choose_recipe(c, index=4, total=8), "chapter_card")

    def test_long_scene_never_becomes_a_graphic_card(self):
        s = _ir_scene(3, "numbers", "Revenue grew 300% that year.", start=0, end=45)
        rid = sr.choose_recipe(s, index=3, total=8)
        self.assertEqual(sr.get(rid).kind, sr.KIND_MOTION)

    def test_beat_drives_generic_motion(self):
        self.assertEqual(sr.choose_recipe(_ir_scene(0, "hook", "Plain words.", "hook")), "slow_push")
        close = _ir_scene(5, "outro", "Plain words.", start=0, end=20)
        self.assertEqual(sr.choose_recipe(close, index=5, total=6), "slow_pull")

    def test_previous_recipe_is_not_repeated(self):
        s = _ir_scene(0, "hook", "Plain words.", "hook")
        self.assertEqual(sr.choose_recipe(s), "slow_push")
        self.assertNotEqual(sr.choose_recipe(s, previous="slow_push"), "slow_push")

    def test_footage_recipe_only_with_known_video(self):
        s = _ir_scene(2, "b", "Plain words.", start=0, end=30)
        self.assertNotEqual(sr.choose_recipe(s, index=2, total=5), "broll_cut")
        self.assertEqual(sr.choose_recipe(s, index=2, total=5, asset_kind="video"), "broll_cut")
        # an image-only recipe is never picked for footage
        img_only = {r.id for r in sr.RECIPES if r.media == (sr.MEDIA_IMAGE,)}
        for prev in (None, "broll_cut"):
            rid = sr.choose_recipe(s, index=2, total=5, asset_kind="video", previous=prev)
            self.assertNotIn(rid, img_only)

    def test_style_preference_breaks_ties(self):
        s = _ir_scene(2, "b", "Plain words.", start=0, end=30)
        plain = sr.choose_recipe(s, index=2, total=5)
        prefer = sr.choose_recipe(s, index=2, total=5, style={"preferred_recipes": ["parallax"]})
        self.assertEqual(plain, "slow_push")
        self.assertEqual(prefer, "parallax")
        # Unknown ids in a style are ignored, not raised on.
        self.assertEqual(sr.choose_recipe(s, index=2, total=5, style={"preferred_recipes": ["zap", 3]}), plain)

    def test_assign_recipes_deterministic_and_never_repeats(self):
        scenes = [_ir_scene(i, f"n{i}", "Plain words.", "hook" if i == 0 else "story",
                            start=i * 30.0, end=(i + 1) * 30.0) for i in range(12)]
        a = sr.assign_recipes(scenes)
        b = sr.assign_recipes(scenes)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 12)
        for x, y in zip(a, a[1:]):
            self.assertNotEqual(x, y)
        self.assertEqual(sr.assign_recipes([]), [])
        self.assertEqual(sr.assign_recipes(None), [])

    def test_choose_transition(self):
        self.assertEqual(sr.choose_transition(0), "hard_cut")
        self.assertEqual(sr.choose_transition(3), sr.DEFAULT_TRANSITION)
        self.assertEqual(sr.choose_transition(3, {"transition": "dip_to_black"}), "dip_to_black")
        self.assertEqual(sr.choose_transition(3, {"transition": "slow_push"}), sr.DEFAULT_TRANSITION)
        self.assertEqual(sr.choose_transition(3, sp.get("neon-cyber").bible), "hard_cut")


class StyleBibleTestCase(unittest.TestCase):
    def test_every_preset_has_a_well_formed_bible(self):
        for p in sp.PRESETS:
            b = p.bible
            self.assertIsNotNone(b, p.id)
            self.assertIn(b.caption_style, sp.CAPTION_STYLES)
            self.assertEqual(sr.get(b.transition).kind, sr.KIND_TRANSITION, p.id)
            for rid in b.preferred_recipes:
                self.assertTrue(sr.is_valid(rid), (p.id, rid))
            pal = b.palette_dict()
            self.assertEqual(set(pal), {"background", "primary", "accent", "text"})
            for c in pal.values():
                self.assertRegex(c, r"^#[0-9a-fA-F]{6}$")
            self.assertTrue(b.heading_font and b.body_font)
        self.assertIn(sp.DEFAULT_BIBLE.caption_style, sp.CAPTION_STYLES)

    def test_resolves_by_id_name_and_expanded_directive(self):
        p = sp.get("golden-epic")
        self.assertIs(sp.style_bible("golden-epic"), p.bible)
        self.assertIs(sp.style_bible("Golden Epic"), p.bible)
        self.assertIs(sp.style_bible(sp.expand("golden-epic")), p.bible)

    def test_freeform_and_empty_get_default(self):
        for v in ("warm sepia, film grain", "", None, 42):
            self.assertIs(sp.style_bible(v), sp.DEFAULT_BIBLE)

    def test_to_dict_is_json_and_catalog_unchanged(self):
        d = sp.style_bible("neon-cyber").to_dict()
        json.dumps(d)
        self.assertEqual(d["palette"]["background"], "#0b1026")
        self.assertEqual(set(sp.catalog()[0]), {"id", "name", "directive", "mood"})


class DirectorRecipeTestCase(unittest.TestCase):
    def _demo(self):
        return json.loads((ROOT / "samples" / "demo_script.json").read_text())["sections"]

    def test_every_shot_has_a_catalogue_recipe_and_no_repeats(self):
        for style in ("", sp.expand("golden-epic"), sp.expand("neon-cyber"), "free text look"):
            plans = director.plan_video(self._demo(), style)
            recipes = [p.recipe for p in plans]
            for r in recipes:
                self.assertTrue(sr.is_valid(r))
                self.assertNotEqual(sr.get(r).kind, sr.KIND_TRANSITION)
            for a, b in zip(recipes, recipes[1:]):
                self.assertNotEqual(a, b)
            self.assertEqual(plans[0].transition, "hard_cut")
            for p in plans[1:]:
                self.assertEqual(sr.get(p.transition).kind, sr.KIND_TRANSITION)

    def test_deterministic(self):
        a = director.plan_video(self._demo(), "dark cinematic")
        b = director.plan_video(self._demo(), "dark cinematic")
        self.assertEqual(a, b)

    def test_style_bible_transition_flows_through(self):
        plans = director.plan_video(self._demo(), sp.expand("mystery-dark"))
        self.assertEqual(plans[1].transition, "dip_to_black")

    def test_recipe_map_and_summary(self):
        plans = director.plan_video(self._demo())
        m = director.recipe_map(plans)
        self.assertEqual(set(m), set(range(len(plans))))
        self.assertEqual(director.summarize(plans)["shots"][0]["recipe"], plans[0].recipe)

    def test_script_section_objects_are_supported(self):
        from modules.script_engine import ScriptSection
        secs = [ScriptSection(name="hook", narration="It cost 40% more.", duration_hint=6, section_type="hook"),
                ScriptSection(name="b", narration="Plain words.", duration_hint=30)]
        plans = director.plan_video(secs)
        self.assertEqual(plans[0].recipe, "stat_counter")
        self.assertTrue(sr.is_valid(plans[1].recipe))

    def test_legacy_positional_construction_still_works(self):
        p = director.ShotPlan(0, "n", "t", "c", "l", "li", "m", "mo")
        self.assertEqual(p.recipe, sr.DEFAULT_RECIPE)


if __name__ == "__main__":
    unittest.main()
