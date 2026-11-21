"""B-roll matching: score a stock clip against a section's keywords and assign
the most relevant clip to each section. Rules under test: relevance is a clean
overlap score, ranking is by relevance, assignment never reuses a clip while
unused ones remain, every section is covered when clips allow, and it is
deterministic."""

import unittest

from modules import broll_match as bm


def _clip(keyword, tags=None):
    return {"keyword": keyword, "tags": tags or []}


class RelevanceTestCase(unittest.TestCase):
    def test_full_overlap(self):
        self.assertEqual(bm.relevance(_clip("volcano eruption"), ["volcano", "eruption"]), 1.0)

    def test_no_overlap(self):
        self.assertEqual(bm.relevance(_clip("calm beach"), ["volcano", "lava"]), 0.0)

    def test_partial_overlap(self):
        # clip terms {ancient, rome}; section {rome, empire} → share 'rome',
        # min set size 2 → 0.5
        self.assertEqual(bm.relevance(_clip("ancient rome"), ["rome", "empire"]), 0.5)

    def test_tags_contribute(self):
        clip = _clip("city", tags=["lava", "volcano"])
        self.assertGreater(bm.relevance(clip, ["volcano"]), 0.0)

    def test_stopwords_ignored(self):
        self.assertEqual(bm.relevance(_clip("the eruption of the volcano"), ["eruption"]), 1.0)

    def test_empty_inputs(self):
        self.assertEqual(bm.relevance(_clip(""), ["x"]), 0.0)
        self.assertEqual(bm.relevance(_clip("x"), []), 0.0)
        self.assertEqual(bm.relevance("not a dict", ["x"]), 0.0)


class RankTestCase(unittest.TestCase):
    def test_ranks_by_relevance(self):
        clips = [_clip("calm beach"), _clip("volcano lava"), _clip("city street")]
        ranked = bm.rank_clips(clips, ["volcano", "eruption"])
        self.assertEqual(ranked[0]["keyword"], "volcano lava")

    def test_stable_on_ties(self):
        clips = [_clip("a"), _clip("b")]  # both zero relevance
        self.assertEqual(bm.rank_clips(clips, ["z"]), clips)

    def test_empty(self):
        self.assertEqual(bm.rank_clips([], ["x"]), [])


class AssignTestCase(unittest.TestCase):
    def test_best_pairing_first(self):
        sections = [["volcano", "lava"], ["ocean", "waves"]]
        clips = [_clip("ocean waves"), _clip("volcano eruption lava")]
        out = bm.assign_clips_to_sections(sections, clips)
        self.assertEqual(out[0]["keyword"], "volcano eruption lava")
        self.assertEqual(out[1]["keyword"], "ocean waves")

    def test_no_clip_reused_while_unused_remain(self):
        sections = [["volcano"], ["volcano"]]  # both want the same thing
        clips = [_clip("volcano eruption"), _clip("calm beach")]
        out = bm.assign_clips_to_sections(sections, clips)
        # One section gets the volcano clip; the other still gets a (different) clip.
        self.assertIsNotNone(out[0])
        self.assertIsNotNone(out[1])
        self.assertNotEqual(out[0]["keyword"], out[1]["keyword"])

    def test_coverage_even_with_zero_matches(self):
        sections = [["quantum"], ["mesopotamia"]]
        clips = [_clip("cats"), _clip("dogs")]
        out = bm.assign_clips_to_sections(sections, clips)
        self.assertTrue(all(c is not None for c in out))  # no black frames

    def test_more_sections_than_clips(self):
        sections = [["a"], ["b"], ["c"]]
        clips = [_clip("a")]
        out = bm.assign_clips_to_sections(sections, clips)
        self.assertEqual(sum(1 for c in out if c is not None), 1)  # only one clip to give

    def test_empty_inputs(self):
        self.assertEqual(bm.assign_clips_to_sections([], [_clip("x")]), [])
        self.assertEqual(bm.assign_clips_to_sections([["x"]], []), [None])

    def test_deterministic(self):
        sections = [["volcano"], ["ocean"], ["city"]]
        clips = [_clip("city street"), _clip("volcano lava"), _clip("ocean waves")]
        first = bm.assign_clips_to_sections(sections, clips)
        second = bm.assign_clips_to_sections(sections, clips)
        self.assertEqual([c["keyword"] for c in first], [c["keyword"] for c in second])


if __name__ == "__main__":
    unittest.main()
