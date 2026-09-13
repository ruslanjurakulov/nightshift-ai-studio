"""Sponsorship pricing (roadmap #72) — pure, offline.

The rules that keep the price honest: it is CPM × measured average views, in
USD; a video with unknown views is skipped (null ≠ 0), Shorts don't count
toward the integrated-slot's reach, a slot needs a minimum number of measured
videos before any price is offered, and with no CPM configured the price is
None ("rate unset"), never a guessed number."""

import unittest

from modules import sponsorship as sp


def _vid(video_id, fmt="long"):
    return {"video_id": video_id, "video_format": fmt}


class AverageViewsTestCase(unittest.TestCase):
    def test_mean_over_known_views_only(self):
        videos = [_vid("a"), _vid("b"), _vid("c")]
        metrics = {"a": {"views": 1000}, "b": {"views": 3000}, "c": {}}  # c unmeasured
        avg, n = sp.average_long_form_views(videos, metrics)
        self.assertEqual(avg, 2000.0)   # (1000+3000)/2 — c is skipped, not a 0
        self.assertEqual(n, 2)

    def test_shorts_excluded(self):
        videos = [_vid("a"), _vid("s", fmt="short")]
        metrics = {"a": {"views": 500}, "s": {"views": 999999}}
        avg, n = sp.average_long_form_views(videos, metrics)
        self.assertEqual(avg, 500.0)
        self.assertEqual(n, 1)

    def test_none_when_nothing_measured(self):
        avg, n = sp.average_long_form_views([_vid("a")], {"a": {}})
        self.assertIsNone(avg)
        self.assertEqual(n, 0)


class EstimateTestCase(unittest.TestCase):
    def _videos(self, n):
        return [_vid(str(i)) for i in range(n)]

    def _metrics(self, n, views):
        return {str(i): {"views": views} for i in range(n)}

    def test_price_is_cpm_times_reach(self):
        est = sp.estimate(self._videos(4), self._metrics(4, 2000), cpm_usd=25.0)
        # 2000 / 1000 * 25 = 50.0
        self.assertEqual(est.price_usd, 50.0)
        self.assertEqual(est.average_views, 2000.0)
        self.assertEqual(est.measured_videos, 4)
        self.assertEqual(est.cpm_usd, 25.0)
        self.assertEqual(est.currency, "USD")
        self.assertTrue(est.has_price)

    def test_no_price_below_min_videos(self):
        est = sp.estimate(self._videos(2), self._metrics(2, 2000), cpm_usd=25.0, min_videos=3)
        self.assertIsNone(est.price_usd)
        self.assertFalse(est.has_price)
        self.assertIn("needs 3", est.reason)

    def test_no_price_without_cpm(self):
        est = sp.estimate(self._videos(4), self._metrics(4, 2000), cpm_usd=None)
        self.assertIsNone(est.price_usd)          # rate unset — never a guess
        self.assertEqual(est.average_views, 2000.0)  # reach still reported
        self.assertFalse(est.has_price)
        self.assertIn("CPM", est.reason)

    def test_no_price_without_reach(self):
        est = sp.estimate([_vid("a")], {"a": {}}, cpm_usd=25.0)
        self.assertIsNone(est.average_views)
        self.assertIsNone(est.price_usd)
        self.assertEqual(est.measured_videos, 0)


class CpmConfigTestCase(unittest.TestCase):
    def test_env_parsing(self):
        import os
        from unittest.mock import patch

        with patch.dict(os.environ, {"CHRONOS_SPONSORSHIP_CPM_USD": "30"}):
            self.assertEqual(sp.sponsorship_cpm(), 30.0)
        with patch.dict(os.environ, {"CHRONOS_SPONSORSHIP_CPM_USD": ""}, clear=False):
            os.environ.pop("CHRONOS_SPONSORSHIP_CPM_USD", None)
            self.assertIsNone(sp.sponsorship_cpm())
        with patch.dict(os.environ, {"CHRONOS_SPONSORSHIP_CPM_USD": "abc"}):
            self.assertIsNone(sp.sponsorship_cpm())     # non-numeric → None, not 0
        with patch.dict(os.environ, {"CHRONOS_SPONSORSHIP_CPM_USD": "-5"}):
            self.assertIsNone(sp.sponsorship_cpm())     # negative → None


if __name__ == "__main__":
    unittest.main()
