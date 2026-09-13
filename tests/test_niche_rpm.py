"""Niche RPM intelligence pins the two constraints that make it honest: an
absent signal is None (never a fabricated 0), and RPM exists only when real
revenue is supplied. The ranking and recommendation follow from those."""

import unittest

from modules.niche_rpm import (
    NicheSignal,
    evaluate_by_channel_niche,
    evaluate_niches,
    rank_niches,
    recommend_niche,
    summarize,
    tier_of,
)


def _niche_of(row):
    return row.get("niche")


class EvaluateNichesTestCase(unittest.TestCase):
    def test_absent_metrics_are_none_not_zero(self):
        videos = [{"video_id": "a", "niche": "history"}, {"video_id": "b", "niche": "history"}]
        # No metrics at all for either video.
        signals = evaluate_niches(videos, {}, _niche_of)
        s = signals["history"]
        self.assertEqual(s.video_count, 2)
        self.assertIsNone(s.avg_views)     # not 0.0
        self.assertIsNone(s.avg_ctr)
        self.assertIsNone(s.rpm_usd)
        self.assertIsNone(s.score)         # no signal → unknown, not "worst"
        self.assertFalse(s.has_signal)

    def test_rpm_only_when_revenue_supplied(self):
        videos = [{"video_id": "a", "niche": "finance"}]
        metrics = {"a": {"views": 10000, "impression_ctr": 0.08}}
        # Without revenue → no RPM.
        no_rev = evaluate_niches(videos, metrics, _niche_of)["finance"]
        self.assertIsNone(no_rev.rpm_usd)
        self.assertIsNone(no_rev.revenue_usd)
        self.assertIsNotNone(no_rev.score)  # views+ctr still give a score
        # With revenue → real RPM = revenue / views * 1000.
        with_rev = evaluate_niches(videos, metrics, _niche_of, revenue_by_video={"a": 50.0})["finance"]
        self.assertAlmostEqual(with_rev.rpm_usd, 50.0 / 10000 * 1000)  # $5 RPM
        self.assertEqual(with_rev.revenue_usd, 50.0)

    def test_partial_metrics_average_skips_missing(self):
        videos = [
            {"video_id": "a", "niche": "space"},
            {"video_id": "b", "niche": "space"},
        ]
        metrics = {"a": {"views": 1000}, "b": {}}  # b has no views
        s = evaluate_niches(videos, metrics, _niche_of)["space"]
        self.assertEqual(s.avg_views, 1000.0)  # averaged over the one present, not (1000+0)/2

    def test_unresolvable_niche_is_skipped(self):
        videos = [{"video_id": "a", "niche": None}, {"video_id": "b", "niche": "history"}]
        signals = evaluate_niches(videos, {}, _niche_of)
        self.assertIn("history", signals)
        self.assertNotIn(None, signals)

    def test_malformed_row_does_not_crash(self):
        videos = [{"video_id": "a", "niche": "history"}, {"no_id": True}, None]
        signals = evaluate_niches(videos, {}, _niche_of)  # must not raise
        self.assertEqual(signals["history"].video_count, 1)


class RankAndRecommendTestCase(unittest.TestCase):
    def test_revenue_niche_ranks_above_views_only(self):
        videos = [
            {"video_id": "h1", "niche": "history"}, {"video_id": "h2", "niche": "history"},
            {"video_id": "h3", "niche": "history"},
            {"video_id": "f1", "niche": "finance"}, {"video_id": "f2", "niche": "finance"},
            {"video_id": "f3", "niche": "finance"},
        ]
        metrics = {
            "h1": {"views": 50000}, "h2": {"views": 60000}, "h3": {"views": 55000},
            "f1": {"views": 8000}, "f2": {"views": 9000}, "f3": {"views": 8500},
        }
        # Finance earns real money; history has views but no revenue data.
        revenue = {"f1": 120.0, "f2": 130.0, "f3": 125.0}
        signals = evaluate_niches(videos, metrics, _niche_of, revenue_by_video=revenue)
        ranked = rank_niches(signals)
        self.assertEqual(ranked[0].niche, "finance")  # RPM dominates
        self.assertEqual(recommend_niche(signals, min_videos=3), "finance")

    def test_none_score_sorts_last(self):
        signals = {
            "known": NicheSignal("known", video_count=5, score=0.4),
            "unknown": NicheSignal("unknown", video_count=99, score=None),
        }
        ranked = rank_niches(signals)
        self.assertEqual(ranked[0].niche, "known")   # measured beats unknown
        self.assertEqual(ranked[-1].niche, "unknown")  # even with more videos

    def test_recommend_none_when_insufficient_data(self):
        # A single video is a data point, not a trend.
        videos = [{"video_id": "a", "niche": "history"}]
        metrics = {"a": {"views": 999999}}
        signals = evaluate_niches(videos, metrics, _niche_of)
        self.assertIsNone(recommend_niche(signals, min_videos=3))

    def test_recommend_none_on_empty(self):
        self.assertIsNone(recommend_niche({}))


class ByChannelNicheTestCase(unittest.TestCase):
    def test_buckets_videos_by_their_channel_niche(self):
        videos = [
            {"video_id": "a", "channel_id": "ch1"},
            {"video_id": "b", "channel_id": "ch1"},
            {"video_id": "c", "channel_id": "ch2"},
        ]
        metrics = {"a": {"views": 1000}, "b": {"views": 3000}, "c": {"views": 500}}
        channel_niche = {"ch1": "history", "ch2": "finance"}
        signals = evaluate_by_channel_niche(videos, metrics, channel_niche)
        self.assertEqual(signals["history"].video_count, 2)
        self.assertEqual(signals["history"].avg_views, 2000.0)
        self.assertEqual(signals["finance"].video_count, 1)

    def test_unknown_channel_is_skipped(self):
        videos = [{"video_id": "a", "channel_id": "ch1"}, {"video_id": "b", "channel_id": "ghost"}]
        metrics = {"a": {"views": 10}, "b": {"views": 20}}
        signals = evaluate_by_channel_niche(videos, metrics, {"ch1": "history"})
        self.assertIn("history", signals)
        self.assertEqual(len(signals), 1)   # ghost channel's video contributes nothing


class SummarizeTestCase(unittest.TestCase):
    def test_tiers_and_ranking_in_summary(self):
        videos = [{"video_id": f"h{i}", "channel_id": "ch1"} for i in range(3)] + [
            {"video_id": f"f{i}", "channel_id": "ch2"} for i in range(3)
        ]
        metrics = {v["video_id"]: {"views": 1000} for v in videos}
        # Only finance has revenue → tier 2 (measured earnings) and best_niche.
        revenue = {f"f{i}": 20.0 for i in range(3)}
        signals = evaluate_by_channel_niche(
            videos, metrics, {"ch1": "history", "ch2": "finance"}, revenue_by_video=revenue
        )
        summary = summarize(signals)
        self.assertEqual(summary["niche_count"], 2)
        self.assertEqual(summary["best_niche"], "finance")   # the one we KNOW earns
        # ranked best-first, each tagged with its tier
        self.assertEqual(summary["niches"][0]["niche"], "finance")
        self.assertEqual(summary["niches"][0]["tier"], 2)

    def test_tier_of_levels(self):
        self.assertEqual(tier_of(NicheSignal(niche="a", video_count=1, rpm_usd=5.0, score=0.5)), 2)
        self.assertEqual(tier_of(NicheSignal(niche="a", video_count=1, score=0.5)), 1)
        self.assertEqual(tier_of(NicheSignal(niche="a", video_count=1)), 0)

    def test_empty_summary(self):
        s = summarize({})
        self.assertEqual(s["niche_count"], 0)
        self.assertEqual(s["niches"], [])
        self.assertIsNone(s["best_niche"])


if __name__ == "__main__":
    unittest.main()
