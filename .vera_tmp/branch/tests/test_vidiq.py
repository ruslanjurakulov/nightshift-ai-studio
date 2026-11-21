"""vidIQ research & scoring.

The rules under test: the opportunity heuristic rewards volume and penalises
competition; an unknown metric leaves the opportunity None (never a fabricated
0) and drops that keyword from the ranking rather than ranking it worst; title
ranking is by real vidIQ score only; the researcher is a safe no-op with no
client and never raises; and nothing here selects or gates — it only returns
rankings and emits advisory events."""

import unittest

from modules import vidiq


def _kw(term, volume=None, competition=None):
    return vidiq.Keyword(term=term, search_volume=volume, competition=competition)


class OpportunityTestCase(unittest.TestCase):
    def test_high_volume_low_competition_scores_high(self):
        strong = vidiq.opportunity_score(_kw("a", volume=90, competition=10))
        weak = vidiq.opportunity_score(_kw("b", volume=20, competition=80))
        self.assertGreater(strong, weak)

    def test_unknown_metric_is_none_not_zero(self):
        self.assertIsNone(vidiq.opportunity_score(_kw("a", volume=None, competition=10)))
        self.assertIsNone(vidiq.opportunity_score(_kw("a", volume=50, competition=None)))

    def test_clamps_out_of_range(self):
        # 120 volume clamps to 100, -5 competition clamps to 0 → full opportunity.
        self.assertEqual(vidiq.opportunity_score(_kw("a", volume=120, competition=-5)), 1.0)

    def test_zero_competition_keeps_full_volume(self):
        self.assertEqual(vidiq.opportunity_score(_kw("a", volume=50, competition=0)), 0.5)


class RankKeywordsTestCase(unittest.TestCase):
    def test_ranks_best_first_and_excludes_uncomputable(self):
        kws = [
            _kw("weak", volume=20, competition=80),
            _kw("strong", volume=90, competition=10),
            _kw("unknown", volume=None, competition=50),
        ]
        ranked = vidiq.rank_keywords(kws)
        self.assertEqual([kw.term for kw, _ in ranked], ["strong", "weak"])
        # the uncomputable keyword is absent, not ranked last as zero
        self.assertNotIn("unknown", [kw.term for kw, _ in ranked])

    def test_deterministic_on_ties(self):
        a = vidiq.rank_keywords([_kw("b", 50, 50), _kw("a", 50, 50)])
        b = vidiq.rank_keywords([_kw("a", 50, 50), _kw("b", 50, 50)])
        self.assertEqual([k.term for k, _ in a], [k.term for k, _ in b])

    def test_best_keywords_limit(self):
        kws = [_kw(t, 90, 10) for t in ("a", "b", "c")]
        self.assertEqual(len(vidiq.best_keywords(kws, k=2)), 2)
        self.assertEqual(vidiq.best_keywords(kws, k=0), [])
        self.assertEqual(vidiq.best_keywords([], k=3), [])


class RankTitlesTestCase(unittest.TestCase):
    def test_ranks_by_score_and_excludes_unscored(self):
        titles = [
            vidiq.TitleScore("low", 30),
            vidiq.TitleScore("high", 88),
            vidiq.TitleScore("unscored", None),
        ]
        self.assertEqual(vidiq.best_title(titles), "high")
        self.assertEqual([t.title for t, _ in vidiq.rank_titles(titles)], ["high", "low"])

    def test_best_title_none_when_all_unscored(self):
        self.assertIsNone(vidiq.best_title([vidiq.TitleScore("x", None)]))
        self.assertIsNone(vidiq.best_title([]))


class _FakeClient:
    def __init__(self, keywords=None, title_scores=None):
        self._keywords = keywords or []
        self._title_scores = title_scores or {}

    def keyword_research(self, seed):
        return self._keywords

    def score_title(self, title):
        return self._title_scores.get(title)


class ResearcherTestCase(unittest.TestCase):
    def test_disabled_without_client_is_noop(self):
        r = vidiq.VidIQResearcher(client=None)
        self.assertFalse(r.enabled)
        self.assertEqual(r.research("space"), [])
        self.assertEqual(r.score_titles(["a", "b"]), [])

    def test_research_ranks_from_client(self):
        client = _FakeClient(keywords=[
            {"term": "roman empire", "volume": 90, "competition": 20},
            {"term": "roman roads", "volume": 30, "competition": 70},
        ])
        r = vidiq.VidIQResearcher(client=client)
        self.assertTrue(r.enabled)
        ranked = r.research("rome")
        self.assertEqual(ranked[0][0].term, "roman empire")

    def test_score_titles_ranks_and_excludes_unscored(self):
        client = _FakeClient(title_scores={"A shocking find": 80, "meh": 20})
        r = vidiq.VidIQResearcher(client=client)
        ranked = r.score_titles(["A shocking find", "meh", "unknown"])
        self.assertEqual(ranked[0][0].title, "A shocking find")
        self.assertNotIn("unknown", [t.title for t, _ in ranked])

    def test_client_failure_is_swallowed(self):
        class Boom:
            def keyword_research(self, seed):
                raise RuntimeError("vidIQ 503")

            def score_title(self, title):
                raise RuntimeError("vidIQ 503")

        r = vidiq.VidIQResearcher(client=Boom())
        self.assertEqual(r.research("x"), [])
        self.assertEqual(r.score_titles(["x"]), [])


class SummaryTestCase(unittest.TestCase):
    def test_research_summary_shape(self):
        ranked = vidiq.rank_keywords([_kw("a", 90, 10), _kw("b", 40, 40)])
        s = vidiq.summarize_research(ranked)
        self.assertEqual(s["keywords_scored"], 2)
        self.assertEqual(s["best"], "a")
        self.assertEqual(len(s["top"]), 2)

    def test_empty_summaries(self):
        self.assertIsNone(vidiq.summarize_research([])["best"])
        self.assertIsNone(vidiq.summarize_titles([])["best"])


if __name__ == "__main__":
    unittest.main()
