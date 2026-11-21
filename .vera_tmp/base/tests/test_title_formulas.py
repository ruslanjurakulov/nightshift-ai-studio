"""Title formula library: classify a title into a proven shape, rank the
shapes by the channel's OWN measured CTR, and seed the planner with the best
ones. The rules under test are that ranking uses only measured titles (null ≠
0), needs a minimum sample per shape, and that seeding leads the planner's
candidate list without dropping the model's titles."""

import unittest

from modules import title_formulas as tf
from modules.title_planner import plan_titles


def _v(vid, title, fmt="long"):
    return {"video_id": vid, "title": title, "video_format": fmt}


def _m(ctr, impressions=2000):
    return {"impression_ctr": ctr, "impressions": impressions}


class ClassifyTestCase(unittest.TestCase):
    def test_recognises_each_shape(self):
        self.assertEqual(tf.classify_title("7 Secrets of Rome"), "number")
        self.assertEqual(tf.classify_title("Why Did Rome Fall?"), "question")
        self.assertEqual(tf.classify_title("The Dark Truth About Rome"), "negativity")
        self.assertEqual(tf.classify_title("The Untold Story of Rome"), "curiosity")
        self.assertEqual(tf.classify_title("The Most Incredible Roman Story"), "superlative")
        self.assertEqual(tf.classify_title("Rome, Explained"), "authority")

    def test_unknown_is_other(self):
        self.assertEqual(tf.classify_title("Rome"), "other")
        self.assertEqual(tf.classify_title(""), "other")


class RankTestCase(unittest.TestCase):
    def test_ranks_by_mean_ctr_with_enough_samples(self):
        videos = [
            _v("a", "The Untold Story of Rome"),   # curiosity, high
            _v("b", "The Untold Story of Egypt"),  # curiosity, high
            _v("c", "Rome, Explained"),            # authority, low
            _v("d", "Egypt, Explained"),           # authority, low
        ]
        metrics = {"a": _m(0.12), "b": _m(0.10), "c": _m(0.03), "d": _m(0.04)}
        stats = tf.rank_formulas_by_ctr(videos, metrics, min_samples=2)
        kinds = [s.kind for s in stats]
        self.assertEqual(kinds[0], "curiosity")   # best CTR first
        self.assertIn("authority", kinds)

    def test_unmeasured_titles_do_not_vote(self):
        # null ≠ 0: a title with no metrics contributes nothing, not a zero.
        videos = [_v("a", "The Untold Story of Rome"), _v("b", "The Untold Story of Egypt"),
                  _v("unknown", "The Dark Truth About Atlantis")]
        metrics = {"a": _m(0.10), "b": _m(0.10)}  # 'unknown' has none
        stats = tf.rank_formulas_by_ctr(videos, metrics, min_samples=2)
        self.assertEqual([s.kind for s in stats], ["curiosity"])

    def test_below_min_samples_excluded(self):
        videos = [_v("a", "The Untold Story of Rome"), _v("b", "The Untold Story of Egypt"),
                  _v("c", "5 Secrets of Mars")]
        metrics = {"a": _m(0.10), "b": _m(0.10), "c": _m(0.20)}
        stats = tf.rank_formulas_by_ctr(videos, metrics, min_samples=2)
        # 'number' has only one sample → not ranked, despite its high CTR.
        self.assertNotIn("number", [s.kind for s in stats])

    def test_low_impressions_excluded(self):
        videos = [_v("a", "The Untold Story of Rome"), _v("b", "The Untold Story of Egypt")]
        metrics = {"a": _m(0.10, impressions=50), "b": _m(0.10, impressions=50)}
        self.assertEqual(tf.rank_formulas_by_ctr(videos, metrics), [])

    def test_no_history_is_empty(self):
        self.assertEqual(tf.rank_formulas_by_ctr([], {}), [])
        self.assertEqual(tf.rank_formulas_by_ctr(None, None), [])


class SeedAndApplyTestCase(unittest.TestCase):
    def test_apply_formula_fills_topic(self):
        self.assertIn("Rome", tf.apply_formula("curiosity", "Rome"))
        self.assertEqual(tf.apply_formula("nonsense-kind", "Rome"), "")
        self.assertEqual(tf.apply_formula("curiosity", ""), "")

    def test_seed_titles_one_per_kind_deduped(self):
        seeds = tf.seed_titles("Rome", ("curiosity", "authority", "curiosity"))
        self.assertEqual(len(seeds), 2)  # dupe kind collapses
        self.assertTrue(all("Rome" in s for s in seeds))

    def test_seed_titles_empty_kinds(self):
        self.assertEqual(tf.seed_titles("Rome", ()), ())


class PlannerSeedingTestCase(unittest.TestCase):
    def test_seed_leads_candidates_without_model(self):
        seeds = tf.seed_titles("Rome", ("curiosity",))
        plan = plan_titles("Rome", seed_titles=seeds)  # no gen → heuristic
        self.assertEqual(plan.chosen, seeds[0])          # seed leads
        self.assertIn(seeds[0], plan.candidates)

    def test_no_seed_is_unchanged_behaviour(self):
        plan = plan_titles("Rome")
        self.assertTrue(plan.chosen)  # still produces a heuristic title

    def test_seed_does_not_drop_model_titles(self):
        def fake_gen(prompt, system):
            return '{"titles": ["Model Title One", "Model Title Two"], "thumbnail_concept": "x"}'
        seeds = tf.seed_titles("Rome", ("curiosity",))
        plan = plan_titles("Rome", gen=fake_gen, seed_titles=seeds)
        self.assertEqual(plan.chosen, seeds[0])                 # seed leads
        self.assertIn("Model Title One", plan.candidates)       # model kept
        self.assertEqual(plan.source, "gemini")


if __name__ == "__main__":
    unittest.main()
