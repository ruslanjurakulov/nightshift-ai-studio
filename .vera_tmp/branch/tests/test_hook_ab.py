"""First-30s (hook) A/B, decided on retention.

Mirrors the thumbnail A/B discipline but on average_view_duration_seconds:
alternation without a verdict, lean-with-explore once decided, a winner only
above MIN_PER_VARIANT measured videos and MIN_LIFT relative difference, and an
unpolled video is unknown (excluded), never zero seconds."""

import unittest

from modules import hook_ab
from modules.ab_testing import EXPLORE_EVERY, MIN_PER_VARIANT


def _vid(vid, variant):
    return {"video_id": vid, "hook_variant": variant}


def _snap(vid, retention, date="2026-09-01"):
    return {"video_id": vid, "average_view_duration_seconds": retention, "snapshot_date": date}


class ChooseHookTestCase(unittest.TestCase):
    def test_alternates_without_verdict(self):
        self.assertEqual([hook_ab.choose_hook(i) for i in range(4)], ["A", "B", "A", "B"])

    def test_bad_count_defaults_safely(self):
        self.assertEqual(hook_ab.choose_hook("nope"), "A")
        self.assertEqual(hook_ab.choose_hook(-3), "A")

    def test_leans_to_winner_but_explores(self):
        result = hook_ab.HookResult(
            a=hook_ab.HookStats("A", 5, 40.0), b=hook_ab.HookStats("B", 5, 50.0),
            winner="B", reason="B holds longer",
        )
        self.assertEqual(hook_ab.choose_hook(0, result), "B")
        # the explore slot ships the challenger
        self.assertEqual(hook_ab.choose_hook(EXPLORE_EVERY - 1, result), "A")


class HookPerformanceTestCase(unittest.TestCase):
    def _dataset(self, retention_by_variant):
        videos, snaps = [], []
        for variant, sec in retention_by_variant.items():
            for i in range(MIN_PER_VARIANT):
                vid = f"{variant}{i}"
                videos.append(_vid(vid, variant))
                snaps.append(_snap(vid, sec))
        return videos, snaps

    def test_no_winner_below_min_per_variant(self):
        videos = [_vid("a0", "A")]
        snaps = [_snap("a0", 40.0)]
        r = hook_ab.hook_performance(videos, snaps)
        self.assertIsNone(r.winner)

    def test_longer_retention_wins(self):
        videos, snaps = self._dataset({"A": 30.0, "B": 45.0})  # 50% longer
        r = hook_ab.hook_performance(videos, snaps)
        self.assertEqual(r.winner, "B")

    def test_tie_under_floor(self):
        videos, snaps = self._dataset({"A": 40.0, "B": 41.0})  # ~2.5% apart
        r = hook_ab.hook_performance(videos, snaps)
        self.assertIsNone(r.winner)

    def test_unpolled_video_is_not_zero(self):
        videos, snaps = self._dataset({"A": 30.0, "B": 45.0})
        videos.append(_vid("bx", "B"))  # no snapshot → unknown, not 0s
        r = hook_ab.hook_performance(videos, snaps)
        self.assertEqual(r.b.videos, MIN_PER_VARIANT)  # the unpolled one isn't counted
        self.assertEqual(r.winner, "B")


if __name__ == "__main__":
    unittest.main()
