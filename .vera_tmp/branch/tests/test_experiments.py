"""modules/experiments.py — one read-side shape over the existing A/B tests.

Pinned: the verdict is the underlying module's own (never a second opinion),
thin data is "running", a sub-floor gap is "inconclusive" — never a guessed
winner — and an unmeasured video is not a sample.
"""

import unittest
from unittest.mock import MagicMock

from modules import experiments as ex
from modules.ab_testing import MIN_PER_VARIANT, variant_performance_n
from modules.hook_ab import hook_performance


def _thumb_rows(ctr_a, ctr_b, n_a=MIN_PER_VARIANT, n_b=MIN_PER_VARIANT):
    videos, snaps = [], []
    for arm, ctr, n in (("A", ctr_a, n_a), ("B", ctr_b, n_b)):
        for i in range(n):
            vid = f"{arm}{i}"
            videos.append({"video_id": vid, "thumbnail_variant": arm})
            snaps.append({"video_id": vid, "snapshot_date": "2026-09-01", "impression_ctr": ctr,
                          "impressions": 100})
    return videos, snaps


def _hook_rows(sec_a, sec_b, n_a=MIN_PER_VARIANT, n_b=MIN_PER_VARIANT):
    videos, snaps = [], []
    for arm, sec, n in (("A", sec_a, n_a), ("B", sec_b, n_b)):
        for i in range(n):
            vid = f"h{arm}{i}"
            videos.append({"video_id": vid, "hook_variant": arm})
            snaps.append({"video_id": vid, "snapshot_date": "2026-09-01",
                          "average_view_duration_seconds": sec})
    return videos, snaps


class ThumbnailExperimentTests(unittest.TestCase):
    def test_thin_data_is_running_with_no_winner_and_no_effect(self):
        videos, snaps = _thumb_rows(0.02, 0.09, n_a=MIN_PER_VARIANT, n_b=MIN_PER_VARIANT - 1)
        e = ex.thumbnail_experiment(videos, snaps)
        self.assertEqual(e.status, ex.STATUS_RUNNING)
        self.assertIsNone(e.winner)
        self.assertIsNone(e.effect)
        self.assertEqual(e.samples, 2 * MIN_PER_VARIANT - 1)

    def test_a_gap_under_the_lift_floor_is_inconclusive_not_a_winner(self):
        videos, snaps = _thumb_rows(0.050, 0.052)
        e = ex.thumbnail_experiment(videos, snaps)
        self.assertEqual(e.status, ex.STATUS_INCONCLUSIVE)
        self.assertIsNone(e.winner)
        self.assertAlmostEqual(e.effect, 0.04, places=4)

    def test_decided_matches_the_pipelines_own_verdict(self):
        videos, snaps = _thumb_rows(0.04, 0.06)
        e = ex.thumbnail_experiment(videos, snaps, channel_id="history")
        self.assertEqual(e.status, ex.STATUS_DECIDED)
        self.assertTrue(e.decided)
        self.assertEqual(e.winner, variant_performance_n(videos, snaps, ("A", "B")).winner)
        self.assertEqual(e.winner, "B")
        self.assertAlmostEqual(e.effect, 0.5, places=4)
        self.assertEqual(e.id, "history:thumbnail_title")
        self.assertEqual(e.metric, "impression_ctr")
        self.assertEqual(e.min_sample, MIN_PER_VARIANT)

    def test_unmeasured_videos_are_not_samples(self):
        videos, snaps = _thumb_rows(0.04, 0.06)
        for s in snaps[:2]:
            s["impression_ctr"] = None  # polled views, CTR unknown
        e = ex.thumbnail_experiment(videos, snaps)
        a = next(v for v in e.variants if v.label == "A")
        self.assertEqual(a.samples, MIN_PER_VARIANT - 2)
        self.assertEqual(e.status, ex.STATUS_RUNNING)

    def test_zero_ctr_runner_up_is_inconclusive(self):
        videos, snaps = _thumb_rows(0.0, 0.06)
        e = ex.thumbnail_experiment(videos, snaps)
        self.assertEqual(e.status, ex.STATUS_INCONCLUSIVE)
        self.assertIsNone(e.effect)


class HookExperimentTests(unittest.TestCase):
    def test_running_inconclusive_decided(self):
        v, s = _hook_rows(100.0, 150.0, n_b=1)
        self.assertEqual(ex.hook_experiment(v, s).status, ex.STATUS_RUNNING)

        v, s = _hook_rows(100.0, 105.0)
        e = ex.hook_experiment(v, s)
        self.assertEqual(e.status, ex.STATUS_INCONCLUSIVE)
        self.assertIsNone(e.winner)

        v, s = _hook_rows(100.0, 150.0)
        e = ex.hook_experiment(v, s)
        self.assertEqual(e.status, ex.STATUS_DECIDED)
        self.assertEqual(e.winner, hook_performance(v, s).winner)
        self.assertEqual(e.metric, "average_view_duration_seconds")

    def test_to_dict_keeps_unknown_values_as_none(self):
        e = ex.hook_experiment([], [])
        d = e.to_dict()
        self.assertEqual(d["status"], ex.STATUS_RUNNING)
        self.assertEqual([x["value"] for x in d["variants"]], [None, None])
        self.assertIsNone(d["effect"])


class ChannelReadoutTests(unittest.TestCase):
    def test_reads_the_store_and_returns_both(self):
        videos, snaps = _thumb_rows(0.04, 0.06)
        by_id = {s["video_id"]: s for s in snaps}
        store = MagicMock()
        store.list_videos.return_value = videos
        store.latest_metrics.side_effect = lambda vid: by_id.get(vid)
        out = ex.experiments_for_channel("history", store=store)
        self.assertEqual([e.kind for e in out], [ex.KIND_THUMBNAIL, ex.KIND_HOOK])
        store.list_videos.assert_called_once_with(limit=100000, channel_id="history")

    def test_a_broken_store_never_raises(self):
        store = MagicMock()
        store.list_videos.side_effect = RuntimeError("db locked")
        self.assertEqual(ex.experiments_for_channel("history", store=store), [])


if __name__ == "__main__":
    unittest.main()
