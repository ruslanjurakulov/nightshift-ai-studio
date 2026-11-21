"""Adaptive strategy: map a channel's scale (published count + age) to a
lifecycle phase and a script-prompt note. Rules under test: a channel must clear
BOTH the count and age bar to advance, an unknown/new channel gets the launch
note (never an empty gap), and the note is appended to the prompt only when
given."""

import unittest

from modules import strategy as st
from modules.script_engine import ScriptEngine


class PhaseTestCase(unittest.TestCase):
    def test_new_channel_is_launch(self):
        self.assertEqual(st.phase_for(0), st.PHASE_LAUNCH)
        self.assertEqual(st.phase_for(3, age_days=5), st.PHASE_LAUNCH)

    def test_needs_both_bars_to_leave_launch(self):
        # 50 videos but only a week old → still launch (age bar not cleared).
        self.assertEqual(st.phase_for(50, age_days=7), st.PHASE_LAUNCH)
        # A year old but only 5 videos → still launch (count bar not cleared).
        self.assertEqual(st.phase_for(5, age_days=400), st.PHASE_LAUNCH)

    def test_growth_phase(self):
        self.assertEqual(st.phase_for(30, age_days=60), st.PHASE_GROWTH)

    def test_needs_both_bars_to_reach_authority(self):
        # 200 videos but under 6 months → growth, not authority.
        self.assertEqual(st.phase_for(200, age_days=90), st.PHASE_GROWTH)
        self.assertEqual(st.phase_for(200, age_days=400), st.PHASE_AUTHORITY)

    def test_age_unknown_judges_on_count(self):
        self.assertEqual(st.phase_for(50, age_days=None), st.PHASE_GROWTH)
        self.assertEqual(st.phase_for(200, age_days=None), st.PHASE_AUTHORITY)

    def test_bad_count_is_launch(self):
        self.assertEqual(st.phase_for("nonsense"), st.PHASE_LAUNCH)
        self.assertEqual(st.phase_for(-5), st.PHASE_LAUNCH)


class FragmentTestCase(unittest.TestCase):
    def test_each_phase_has_a_note(self):
        for phase in (st.PHASE_LAUNCH, st.PHASE_GROWTH, st.PHASE_AUTHORITY):
            self.assertTrue(st.strategy_fragment(phase))

    def test_unknown_phase_empty(self):
        self.assertEqual(st.strategy_fragment("nope"), "")

    def test_adaptive_never_empty_for_real_scale(self):
        self.assertIn("LAUNCH", st.adaptive_strategy(0))
        self.assertIn("GROWTH", st.adaptive_strategy(30, age_days=60))
        self.assertIn("AUTHORITY", st.adaptive_strategy(300, age_days=400))


class PromptWiringTestCase(unittest.TestCase):
    def test_note_appended_when_given(self):
        note = st.adaptive_strategy(0)
        prompt = ScriptEngine._build_prompt("Rome", strategy_note=note)
        self.assertIn("LAUNCH", prompt)

    def test_no_note_leaves_prompt_clean(self):
        prompt = ScriptEngine._build_prompt("Rome")
        self.assertNotIn("Channel stage", prompt)


if __name__ == "__main__":
    unittest.main()
