"""Tests for modules.director — the cinematic shot planner (Nightshift blueprint)."""

import unittest

from modules import director
from modules import minimax_broll


def _sec(name, narration, section_type="story"):
    return {"name": name, "narration": narration, "type": section_type}


class PlanVideoTestCase(unittest.TestCase):
    def test_empty_sections_yield_empty_plan(self):
        self.assertEqual(director.plan_video([]), [])
        self.assertEqual(director.plan_video(None), [])

    def test_hook_reveal_close_are_distinct_beats(self):
        sections = [
            _sec("hook", "A shocking opening", "hook"),
            _sec("body", "Some background context."),
            _sec("twist", "Then we finally reveal the secret."),
            _sec("outro", "Subscribe for more."),
        ]
        plans = director.plan_video(sections, visual_style="dark cinematic")
        self.assertEqual(len(plans), 4)
        self.assertEqual(plans[0].shot_type, "reveal opening")   # hook
        self.assertEqual(plans[2].shot_type, "dramatic reveal")  # reveal cue
        self.assertEqual(plans[3].shot_type, "resolution")       # close cue
        # Channel style flows into mood/lighting.
        self.assertIn("dark cinematic", plans[0].mood)

    def test_body_alternates_establishing_and_detail(self):
        sections = [_sec("h", "hook", "hook")] + [_sec(f"s{i}", "plain body text") for i in range(4)]
        plans = director.plan_video(sections)
        body = [p.shot_type for p in plans[1:]]
        # even indices establishing, odd indices detail — never all identical
        self.assertIn("establishing", body)
        self.assertIn("detail", body)

    def test_cinematic_style_is_nonempty_prompt_suffix(self):
        plans = director.plan_video([_sec("h", "hook", "hook")])
        style = director.cinematic_style(plans[0])
        self.assertTrue(style)
        self.assertIn("slow push-in", style)

    def test_style_map_keys_by_section_index(self):
        plans = director.plan_video([_sec("h", "x", "hook"), _sec("b", "y")])
        m = director.style_map(plans)
        self.assertEqual(set(m.keys()), {0, 1})
        self.assertTrue(all(isinstance(v, str) and v for v in m.values()))

    def test_summarize_shape(self):
        plans = director.plan_video([_sec("h", "x", "hook"), _sec("b", "y")])
        summary = director.summarize(plans)
        self.assertEqual(summary["scenes"], 2)
        self.assertEqual(summary["shots"][0]["scene"], 1)
        self.assertIn("camera", summary["shots"][0])


class BrollStyleThreadingTestCase(unittest.TestCase):
    def test_style_for_enriches_the_prompt(self):
        sections = [{"keywords": ["roman ruins"], "duration": 6}]
        specs = minimax_broll.select_specs(
            sections, "Rome", max_clips=1, style_for=lambda i: "slow push-in, low-key")
        self.assertEqual(len(specs), 1)
        self.assertIn("slow push-in, low-key", specs[0].prompt)

    def test_no_style_for_keeps_default_prompt(self):
        sections = [{"keywords": ["roman ruins"], "duration": 6}]
        specs = minimax_broll.select_specs(sections, "Rome", max_clips=1)
        self.assertIn("cinematic, documentary, realistic", specs[0].prompt)

    def test_style_for_exception_falls_back_safely(self):
        sections = [{"keywords": ["x"], "duration": 6}]
        def boom(i):
            raise RuntimeError("bad")
        specs = minimax_broll.select_specs(sections, "T", max_clips=1, style_for=boom)
        # Still produced a spec with the default style, never raised.
        self.assertEqual(len(specs), 1)
        self.assertIn("cinematic, documentary, realistic", specs[0].prompt)


if __name__ == "__main__":
    unittest.main()
