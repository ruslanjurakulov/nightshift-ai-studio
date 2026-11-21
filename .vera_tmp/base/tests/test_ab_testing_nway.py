"""N-way (3+ arm) thumbnail A/B — widening the two-arm test.

The rules under test mirror the binary A/B: round-robin fill with no verdict,
lean-to-winner-but-keep-exploring with one, a winner named only when two arms
clear MIN_PER_VARIANT and the best beats the runner-up by MIN_LIFT, and an
unmeasured video is unknown (excluded) rather than a zero. Plus the thumbnail
generator gives each arm a distinct look and never KeyErrors on an odd label."""

import unittest

from modules import ab_testing as ab
from modules.thumbnail_generator import _style_for, _VARIANT_STYLE


def _vid(vid, variant):
    return {"video_id": vid, "thumbnail_variant": variant}


def _snap(vid, ctr, date="2026-09-01", impressions=1000):
    return {"video_id": vid, "impression_ctr": ctr, "snapshot_date": date, "impressions": impressions}


class ChooseVariantNTestCase(unittest.TestCase):
    def test_round_robin_without_verdict(self):
        arms = ["A", "B", "C"]
        picks = [ab.choose_variant_n(i, arms) for i in range(6)]
        self.assertEqual(picks, ["A", "B", "C", "A", "B", "C"])

    def test_empty_variants_falls_back_to_A(self):
        self.assertEqual(ab.choose_variant_n(3, []), "A")

    def test_dedupes_and_uppercases(self):
        self.assertEqual(ab.choose_variant_n(0, ["a", "A", "b"]), "A")
        self.assertEqual(ab.choose_variant_n(1, ["a", "A", "b"]), "B")

    def test_leans_to_winner_but_keeps_exploring(self):
        arms = ["A", "B", "C"]
        result = ab.MultiABResult(stats={}, winner="B", reason="B wins")
        # explore slot (count % EXPLORE_EVERY == EXPLORE_EVERY-1) picks a challenger
        explore = ab.choose_variant_n(ab.EXPLORE_EVERY - 1, arms, result)
        self.assertNotEqual(explore, "B")
        # a non-explore slot ships the winner
        self.assertEqual(ab.choose_variant_n(0, arms, result), "B")


class VariantPerformanceNTestCase(unittest.TestCase):
    def _dataset(self, ctr_by_variant):
        videos, snaps = [], []
        for variant, ctr in ctr_by_variant.items():
            for i in range(ab.MIN_PER_VARIANT):
                vid = f"{variant}{i}"
                videos.append(_vid(vid, variant))
                snaps.append(_snap(vid, ctr))
        return videos, snaps

    def test_no_winner_below_two_measured_arms(self):
        videos, snaps = self._dataset({"A": 0.05})  # only one arm has data
        r = ab.variant_performance_n(videos, snaps, ["A", "B", "C"])
        self.assertIsNone(r.winner)
        self.assertFalse(r.decided)

    def test_best_of_three_wins_when_lift_clears_floor(self):
        videos, snaps = self._dataset({"A": 0.04, "B": 0.10, "C": 0.05})
        r = ab.variant_performance_n(videos, snaps, ["A", "B", "C"])
        self.assertEqual(r.winner, "B")  # 0.10 vs runner-up 0.05 → 100% lift

    def test_tie_when_top_two_within_floor(self):
        videos, snaps = self._dataset({"A": 0.100, "B": 0.101, "C": 0.02})
        r = ab.variant_performance_n(videos, snaps, ["A", "B", "C"])
        self.assertIsNone(r.winner)

    def test_unmeasured_video_is_not_a_zero(self):
        videos, snaps = self._dataset({"A": 0.04, "B": 0.10})
        # add a C video with NO snapshot — must not count as 0 CTR nor as measured
        videos.append(_vid("Cx", "C"))
        r = ab.variant_performance_n(videos, snaps, ["A", "B", "C"])
        self.assertEqual(r.stats["C"].videos, 0)
        self.assertIsNone(r.stats["C"].mean_ctr)


class ThumbnailStyleTestCase(unittest.TestCase):
    def test_each_known_arm_is_distinct(self):
        accents = {v: _style_for(v)["accent"] for v in ("A", "B", "C", "D")}
        self.assertEqual(len(set(accents.values())), 4)

    def test_a_and_b_unchanged(self):
        self.assertEqual(_style_for("A")["bg"], (20, 10, 40))
        self.assertEqual(_style_for("B")["accent"], (255, 68, 68))

    def test_unknown_label_never_crashes(self):
        style = _style_for("Z")
        self.assertIn("accent", style)
        self.assertIn(style["accent"], [s["accent"] for s in _VARIANT_STYLE.values()])


if __name__ == "__main__":
    unittest.main()
