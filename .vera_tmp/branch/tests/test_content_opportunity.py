"""Unit tests for modules.content_opportunity (stdlib unittest, no mocking)."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Ensure the project root (parent of this tests/ dir) is importable regardless
# of how the test runner was invoked.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.content_opportunity import ContentOpportunity, ContentOpportunityEngine


def _iso_hours_ago(hours: float) -> str:
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.isoformat().replace("+00:00", "Z")


class TestNormalizationEdgeCases(unittest.TestCase):
    def test_empty_inputs_return_empty_list(self):
        engine = ContentOpportunityEngine()
        self.assertEqual(engine.rank([], []), [])

    def test_empty_trend_only_demand(self):
        engine = ContentOpportunityEngine()
        demand = [{"topic_phrase": "Space Exploration", "mention_count": 12}]
        results = engine.rank([], demand)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].source, "demand")

    def test_single_item_trend_list_no_zero_division(self):
        engine = ContentOpportunityEngine()
        trend = [
            {
                "video_id": "v1",
                "title": "Lone Wolf Documentary",
                "view_count": 5000,
                "published_at": _iso_hours_ago(5),
            }
        ]
        results = engine.rank(trend, [])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].source, "trend")
        self.assertGreaterEqual(results[0].score, 0.0)
        self.assertLessEqual(results[0].score, 1.0)

    def test_single_item_demand_list_no_zero_division(self):
        engine = ContentOpportunityEngine()
        demand = [{"topic_phrase": "Volcano Facts", "mention_count": 7}]
        results = engine.rank([], demand)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].source, "demand")


class TestSingleSourceRuns(unittest.TestCase):
    def test_trend_only_run_produces_sensible_opportunities(self):
        engine = ContentOpportunityEngine()
        trend = [
            {
                "video_id": "v1",
                "title": "Why Rome Fell Overnight",
                "view_count": 200000,
                "published_at": _iso_hours_ago(2),  # fast velocity
            },
            {
                "video_id": "v2",
                "title": "Slow Cooking Tutorial",
                "view_count": 2000,
                "published_at": _iso_hours_ago(20),  # slow velocity
            },
        ]
        results = engine.rank(trend, [])
        self.assertEqual(len(results), 2)
        for r in results:
            self.assertIsInstance(r, ContentOpportunity)
            self.assertEqual(r.source, "trend")
        # Faster-growing video should outrank the slower one.
        self.assertEqual(results[0].topic, "Why Rome Fell Overnight")
        self.assertGreater(results[0].score, results[1].score)

    def test_demand_only_run_produces_sensible_opportunities(self):
        engine = ContentOpportunityEngine()
        demand = [
            {"topic_phrase": "Haunted Castles of Europe", "mention_count": 80},
            {"topic_phrase": "Basic Knitting Patterns", "mention_count": 3},
        ]
        results = engine.rank([], demand)
        self.assertEqual(len(results), 2)
        for r in results:
            self.assertEqual(r.source, "demand")
        self.assertEqual(results[0].topic, "Haunted Castles of Europe")
        self.assertGreater(results[0].score, results[1].score)

    def test_trend_only_fallback_to_percentile_when_no_published_at(self):
        engine = ContentOpportunityEngine()
        trend = [
            {"video_id": "v1", "title": "Big Hit Video", "view_count": 100000, "published_at": ""},
            {"video_id": "v2", "title": "Small Video", "view_count": 100, "published_at": ""},
        ]
        results = engine.rank(trend, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].topic, "Big Hit Video")
        # Fallback rationale should mention raw view count, not "views/hr".
        self.assertIn("views", results[0].rationale)
        self.assertNotIn("views/hr", results[0].rationale)


class TestRationaleContainsRealNumbers(unittest.TestCase):
    def test_trend_rationale_contains_velocity_number(self):
        engine = ContentOpportunityEngine()
        trend = [
            {
                "video_id": "v1",
                "title": "Meteor Shower Tonight",
                "view_count": 60000,
                "published_at": _iso_hours_ago(2),  # -> 30,000 views/hr
            },
            {
                "video_id": "v2",
                "title": "Gardening Basics",
                "view_count": 500,
                "published_at": _iso_hours_ago(5),
            },
        ]
        results = engine.rank(trend, [])
        top = next(r for r in results if r.topic == "Meteor Shower Tonight")
        self.assertIn("30,000 views/hr", top.rationale)

    def test_demand_rationale_contains_mention_count(self):
        engine = ContentOpportunityEngine()
        demand = [
            {"topic_phrase": "AI Takes Over Jobs", "mention_count": 42},
            {"topic_phrase": "Sourdough Bread Tips", "mention_count": 2},
        ]
        results = engine.rank([], demand)
        top = next(r for r in results if r.topic == "AI Takes Over Jobs")
        self.assertIn("42 comments/searches", top.rationale)


class TestBothSourceMatching(unittest.TestCase):
    def setUp(self):
        self.trend = [
            {
                "video_id": "v1",
                "title": "Ancient Rome Secrets Revealed",
                "view_count": 100000,
                "published_at": _iso_hours_ago(2),  # 50,000 views/hr — top of batch
            },
            {
                "video_id": "v2",
                "title": "Modern Cooking Tips",
                "view_count": 1000,
                "published_at": _iso_hours_ago(10),  # 100 views/hr — bottom of batch
            },
        ]
        self.demand = [
            {"topic_phrase": "Ancient Rome Secrets", "mention_count": 50},  # matches v1
            {"topic_phrase": "Knitting Patterns", "mention_count": 5},  # unmatched
        ]

    def test_matching_topic_gets_source_both(self):
        engine = ContentOpportunityEngine(match_threshold=0.6)
        results = engine.rank(self.trend, self.demand)
        matched = [r for r in results if r.source == "both"]
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0].topic, "Ancient Rome Secrets Revealed")
        # Rationale should cite both the real trend and demand numbers.
        self.assertIn("50,000 views/hr", matched[0].rationale)
        self.assertIn("50 comments/searches", matched[0].rationale)

    def test_matched_score_beats_single_source_alternatives(self):
        engine = ContentOpportunityEngine(match_threshold=0.6)
        results = engine.rank(self.trend, self.demand)
        by_topic = {r.topic: r for r in results}

        matched = by_topic["Ancient Rome Secrets Revealed"]
        trend_only = by_topic["Modern Cooking Tips"]
        demand_only = by_topic["Knitting Patterns"]

        self.assertEqual(matched.source, "both")
        self.assertEqual(trend_only.source, "trend")
        self.assertEqual(demand_only.source, "demand")

        self.assertGreater(matched.score, trend_only.score)
        self.assertGreater(matched.score, demand_only.score)

    def test_unmatched_topics_below_threshold_stay_single_source(self):
        # Set an extremely high threshold so nothing can match.
        engine = ContentOpportunityEngine(match_threshold=0.99)
        results = engine.rank(self.trend, self.demand)
        sources = {r.source for r in results}
        self.assertNotIn("both", sources)
        self.assertEqual(len(results), 4)  # 2 trend + 2 demand, all single-source


class TestCustomWeights(unittest.TestCase):
    def test_pure_trend_weighting_ranks_by_trend_only(self):
        trend = [
            {
                "video_id": "v1",
                "title": "Highest Velocity Topic",
                "view_count": 300000,
                "published_at": _iso_hours_ago(1),  # 300,000/hr
            },
            {
                "video_id": "v2",
                "title": "Mid Velocity Topic",
                "view_count": 10000,
                "published_at": _iso_hours_ago(2),  # 5,000/hr
            },
            {
                "video_id": "v3",
                "title": "Lowest Velocity Topic",
                "view_count": 100,
                "published_at": _iso_hours_ago(10),  # 10/hr
            },
        ]
        # Demand signals deliberately ordered to REVERSE the ranking if honored.
        demand = [
            {"topic_phrase": "Unrelated Phrase One", "mention_count": 1000},
            {"topic_phrase": "Unrelated Phrase Two", "mention_count": 1},
        ]

        engine = ContentOpportunityEngine(trend_weight=1.0, demand_weight=0.0)
        results = engine.rank(trend, demand)
        trend_topics_in_order = [r.topic for r in results if r.source == "trend"]
        self.assertEqual(
            trend_topics_in_order,
            ["Highest Velocity Topic", "Mid Velocity Topic", "Lowest Velocity Topic"],
        )
        # With demand_weight=0.0, demand-only opportunities must score exactly 0.
        demand_only = [r for r in results if r.source == "demand"]
        for r in demand_only:
            self.assertEqual(r.score, 0.0)

    def test_invalid_negative_weight_raises(self):
        with self.assertRaises(ValueError):
            ContentOpportunityEngine(trend_weight=-0.5, demand_weight=0.5)

    def test_invalid_zero_sum_weight_raises(self):
        with self.assertRaises(ValueError):
            ContentOpportunityEngine(trend_weight=0.0, demand_weight=0.0)


class TestMaxResultsTruncation(unittest.TestCase):
    def test_max_results_truncates_to_requested_count(self):
        engine = ContentOpportunityEngine()
        trend = [
            {
                "video_id": f"v{i}",
                "title": f"Topic Number {i}",
                "view_count": (i + 1) * 1000,
                "published_at": _iso_hours_ago(1),
            }
            for i in range(15)
        ]
        results = engine.rank(trend, [], max_results=5)
        self.assertEqual(len(results), 5)
        # Highest view_count (v14, 15000) should be first since velocity is
        # directly proportional to view_count (all published 1 hour ago).
        self.assertEqual(results[0].topic, "Topic Number 14")


if __name__ == "__main__":
    unittest.main()
