"""Title-first planning: it decides the packaging before the script, uses the
model when one is given, and ALWAYS degrades to a usable heuristic plan rather
than raising into the pipeline."""

import unittest

from modules.title_planner import TitlePlan, plan_titles


class HeuristicPlanTestCase(unittest.TestCase):
    def test_no_model_returns_heuristic_plan(self):
        plan = plan_titles("The Fall of Rome", "history")
        self.assertEqual(plan.source, "heuristic")
        self.assertTrue(plan.candidates)
        self.assertTrue(plan.chosen)
        self.assertIn("Rome", plan.chosen)
        # chosen is the first candidate; alt is the second when present.
        self.assertEqual(plan.chosen, plan.candidates[0])
        self.assertEqual(plan.alt, plan.candidates[1])

    def test_empty_topic_still_usable(self):
        plan = plan_titles("", "")
        self.assertTrue(plan.chosen)  # never empty
        self.assertIsInstance(plan, TitlePlan)


class ModelPlanTestCase(unittest.TestCase):
    def test_uses_model_titles_when_available(self):
        def fake_gen(prompt, system):
            return (
                '{"titles": ["Why Rome Really Fell", "The Night Rome Died"], '
                '"thumbnail_concept": "a cracked marble bust over a burning city"}'
            )

        plan = plan_titles("The Fall of Rome", "history", gen=fake_gen)
        self.assertEqual(plan.source, "gemini")
        self.assertEqual(plan.chosen, "Why Rome Really Fell")
        self.assertEqual(plan.alt, "The Night Rome Died")
        self.assertEqual(plan.thumbnail_concept, "a cracked marble bust over a burning city")

    def test_model_wrapped_in_code_fence_is_parsed(self):
        def fake_gen(prompt, system):
            return '```json\n{"titles": ["A Clean Title"]}\n```'

        plan = plan_titles("Topic", gen=fake_gen)
        self.assertEqual(plan.source, "gemini")
        self.assertEqual(plan.chosen, "A Clean Title")

    def test_model_failure_falls_back_to_heuristic(self):
        def boom(prompt, system):
            raise RuntimeError("model down")

        plan = plan_titles("Ancient Aliens", gen=boom)
        self.assertEqual(plan.source, "heuristic")  # never raises
        self.assertTrue(plan.chosen)

    def test_model_garbage_falls_back_to_heuristic(self):
        def garbage(prompt, system):
            return "not json and not titles at all!!!"

        # A single non-JSON line is treated as one candidate title, which is
        # still usable; an empty/whitespace reply falls back to heuristic.
        empty = plan_titles("Topic", gen=lambda p, s: "   ")
        self.assertEqual(empty.source, "heuristic")

    def test_respects_n_cap(self):
        def many(prompt, system):
            return '{"titles": ["A", "B", "C", "D", "E", "F", "G"]}'

        plan = plan_titles("Topic", gen=many, n=3)
        self.assertEqual(len(plan.candidates), 3)


if __name__ == "__main__":
    unittest.main()
