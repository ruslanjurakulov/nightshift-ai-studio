"""Quota allocator: split a day's upload budget across channels by measured
performance while reserving a baseline for each. Rules under test: the result is
whole numbers summing to exactly the budget, stronger channels get more, a new
(unmeasured) channel still gets its baseline (null ≠ 0), and views-per-day keeps
an old catalogue from dominating."""

import unittest
from datetime import datetime, timedelta, timezone

from modules import quota_allocator as qa

NOW = datetime(2026, 9, 12, tzinfo=timezone.utc)


class AllocateTestCase(unittest.TestCase):
    def test_sums_to_exact_budget(self):
        out = qa.allocate({"a": 5.0, "b": 3.0, "c": 1.0}, 10)
        self.assertEqual(sum(out.values()), 10)

    def test_stronger_channel_gets_more(self):
        out = qa.allocate({"a": 10.0, "b": 1.0}, 12, min_per_channel=1)
        self.assertGreater(out["a"], out["b"])

    def test_baseline_reserved_for_zero_score(self):
        # A new channel (score 0) still gets its reserved slot.
        out = qa.allocate({"strong": 100.0, "newbie": 0.0}, 10, min_per_channel=1)
        self.assertGreaterEqual(out["newbie"], 1)
        self.assertEqual(sum(out.values()), 10)

    def test_all_zero_scores_split_evenly(self):
        out = qa.allocate({"a": 0.0, "b": 0.0, "c": 0.0}, 9)
        self.assertEqual(out, {"a": 3, "b": 3, "c": 3})

    def test_more_channels_than_slots(self):
        out = qa.allocate({"a": 1.0, "b": 1.0, "c": 1.0}, 2, min_per_channel=1)
        self.assertEqual(sum(out.values()), 2)          # exact
        self.assertTrue(all(v in (0, 1) for v in out.values()))

    def test_zero_budget_is_all_zero(self):
        self.assertEqual(qa.allocate({"a": 5.0}, 0), {"a": 0})

    def test_no_channels(self):
        self.assertEqual(qa.allocate({}, 10), {})

    def test_negative_scores_treated_as_zero(self):
        out = qa.allocate({"a": -5.0, "b": 4.0}, 10, min_per_channel=1)
        self.assertGreater(out["b"], out["a"])
        self.assertEqual(sum(out.values()), 10)


class PerformanceScoresTestCase(unittest.TestCase):
    def _v(self, vid, days_old, fmt="long"):
        return {"video_id": vid, "published_at": (NOW - timedelta(days=days_old)).isoformat(),
                "video_format": fmt}

    def test_views_per_day_not_raw_views(self):
        videos_by_channel = {
            "old": [self._v("o1", 100)],   # 10000 views over 100 days = 100/day
            "new": [self._v("n1", 2)],     # 1000 views over 2 days = 500/day
        }
        metrics = {"o1": {"views": 10000}, "n1": {"views": 1000}}
        scores = qa.performance_scores(videos_by_channel, metrics, now=NOW)
        self.assertGreater(scores["new"], scores["old"])  # rate beats total

    def test_unmeasured_channel_scores_zero(self):
        videos_by_channel = {"measured": [self._v("m1", 10)], "empty": []}
        scores = qa.performance_scores(videos_by_channel, {"m1": {"views": 1000}}, now=NOW)
        self.assertEqual(scores["empty"], 0.0)
        self.assertGreater(scores["measured"], 0.0)

    def test_shorts_ignored(self):
        videos_by_channel = {"c": [self._v("s1", 10, fmt="short")]}
        scores = qa.performance_scores(videos_by_channel, {"s1": {"views": 99999}}, now=NOW)
        self.assertEqual(scores["c"], 0.0)


class _FakeStore:
    def __init__(self, videos_by_channel, metrics):
        self._v = videos_by_channel
        self._m = metrics

    def list_videos(self, limit=100, channel_id=None):
        return self._v.get(channel_id, [])

    def latest_metrics(self, video_id):
        return self._m.get(video_id)


class RecommendAllocationTestCase(unittest.TestCase):
    def test_end_to_end(self):
        vbc = {
            "a": [{"video_id": "a1", "published_at": (NOW - timedelta(days=5)).isoformat(),
                   "video_format": "long"}],
            "b": [{"video_id": "b1", "published_at": (NOW - timedelta(days=5)).isoformat(),
                   "video_format": "long"}],
        }
        store = _FakeStore(vbc, {"a1": {"views": 10000}, "b1": {"views": 500}})
        out = qa.recommend_allocation(store, ["a", "b"], 10, now=NOW)
        self.assertEqual(sum(out.values()), 10)
        self.assertGreater(out["a"], out["b"])

    def test_read_failure_scores_zero_but_still_allocates(self):
        class Boom:
            def list_videos(self, limit=100, channel_id=None):
                raise RuntimeError("db down")
            def latest_metrics(self, video_id):
                return None
        out = qa.recommend_allocation(Boom(), ["a", "b"], 4, now=NOW)
        self.assertEqual(sum(out.values()), 4)  # even split, never raises


class RecommendWithScoresAndSummaryTestCase(unittest.TestCase):
    def _store(self):
        vbc = {
            "a": [{"video_id": "a1", "published_at": (NOW - timedelta(days=5)).isoformat(),
                   "video_format": "long"}],
            "b": [{"video_id": "b1", "published_at": (NOW - timedelta(days=5)).isoformat(),
                   "video_format": "long"}],
            "c": [],   # new channel, no videos → score 0, keeps its baseline
        }
        return _FakeStore(vbc, {"a1": {"views": 10000}, "b1": {"views": 2000}})

    def test_scores_and_allocation_returned_together(self):
        scores, allocation = qa.recommend_with_scores(self._store(), ["a", "b", "c"], 12, now=NOW)
        self.assertEqual(sum(allocation.values()), 12)
        self.assertGreater(scores["a"], scores["b"])
        self.assertEqual(scores["c"], 0.0)          # unmeasured, not negative
        self.assertGreaterEqual(allocation["c"], 1)  # baseline reserved

    def test_summary_shape_and_shares(self):
        scores, allocation = qa.recommend_with_scores(self._store(), ["a", "b", "c"], 12, now=NOW)
        summary = qa.summarize(scores, allocation, total_slots=12,
                               names={"a": "Alpha", "b": "Beta", "c": "Gamma"})
        self.assertEqual(summary["total_slots"], 12)
        self.assertEqual(summary["channel_count"], 3)
        rows = {r["channel_id"]: r for r in summary["channels"]}
        self.assertEqual(rows["a"]["name"], "Alpha")
        self.assertGreater(rows["a"]["slots"], rows["b"]["slots"])
        # share is a fraction of the total measured performance; channel c has
        # no measured views so it accounts for 0% of it — yet still gets a
        # reserved baseline slot (slots ≥ 1, share 0.0, not negative).
        self.assertEqual(rows["c"]["share"], 0.0)
        self.assertGreaterEqual(rows["c"]["slots"], 1)
        self.assertAlmostEqual(sum(r["share"] for r in summary["channels"] if r["share"] is not None), 1.0, places=3)

    def test_summary_all_unmeasured_shares_are_none(self):
        scores = {"a": 0.0, "b": 0.0}
        allocation = qa.allocate(scores, 4)
        summary = qa.summarize(scores, allocation, total_slots=4)
        self.assertTrue(all(r["share"] is None for r in summary["channels"]))
        self.assertEqual(sum(r["slots"] for r in summary["channels"]), 4)


if __name__ == "__main__":
    unittest.main()
