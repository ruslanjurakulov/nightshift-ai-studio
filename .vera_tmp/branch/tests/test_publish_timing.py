"""Publish-time optimizer: recommend the hour/weekday from when the channel's
best-performing videos went out. Rules under test: performance is views-per-day
(age can't fool it), unmeasured videos never vote (null ≠ 0), a slot needs a
minimum sample before it is trusted, and thin history yields no recommendation."""

import unittest
from datetime import datetime, timedelta, timezone

from modules import publish_timing as pt

NOW = datetime(2026, 9, 12, 12, 0, tzinfo=timezone.utc)


def _v(vid, dt, fmt="long"):
    return {"video_id": vid, "title": vid, "published_at": dt.isoformat(), "video_format": fmt}


def _at(hour, weekday_offset=0):
    # A datetime at a given UTC hour; base day 2026-09-07 is a Monday.
    base = datetime(2026, 9, 7, hour, 0, tzinfo=timezone.utc) + timedelta(days=weekday_offset)
    return base


class AnalyzeTestCase(unittest.TestCase):
    def test_recommends_the_best_hour(self):
        videos, metrics = [], {}
        # Three videos at 18h with high views/day, three at 3h with low.
        for i in range(3):
            videos.append(_v(f"hi{i}", _at(18) - timedelta(weeks=i)))
            metrics[f"hi{i}"] = {"views": 10000}
            videos.append(_v(f"lo{i}", _at(3) - timedelta(weeks=i)))
            metrics[f"lo{i}"] = {"views": 100}
        report = pt.analyze(videos, metrics, now=NOW, min_samples=3)
        self.assertEqual(report.best_hour_utc, 18)

    def test_views_per_day_not_raw_views(self):
        # An old low-rate video must not beat a young high-rate one on raw totals.
        videos = [
            _v("old", datetime(2025, 1, 1, 9, tzinfo=timezone.utc)),   # ~600 days old
            _v("old2", datetime(2025, 1, 2, 9, tzinfo=timezone.utc)),
            _v("old3", datetime(2025, 1, 3, 9, tzinfo=timezone.utc)),
            _v("new", NOW - timedelta(days=2)),                        # 2 days old
            _v("new2", NOW - timedelta(days=2)),
            _v("new3", NOW - timedelta(days=2)),
        ]
        # 'old' bucket hour=9 has big totals; 'new' bucket has smaller totals but
        # far higher per-day rate.
        metrics = {"old": {"views": 50000}, "old2": {"views": 50000}, "old3": {"views": 50000},
                   "new": {"views": 8000}, "new2": {"views": 8000}, "new3": {"views": 8000}}
        report = pt.analyze(videos, metrics, now=NOW, min_samples=3)
        new_hour = (NOW - timedelta(days=2)).hour
        self.assertEqual(report.best_hour_utc, new_hour)  # rate wins over totals

    def test_unmeasured_videos_do_not_vote(self):
        videos = [_v(f"m{i}", _at(20) - timedelta(weeks=i)) for i in range(3)]
        metrics = {"m0": {"views": 5000}, "m1": {"views": 5000}}  # m2 unmeasured
        report = pt.analyze(videos, metrics, now=NOW, min_samples=3)
        # Only 2 measured at hour 20 → below min_samples → no recommendation.
        self.assertIsNone(report.best_hour_utc)
        self.assertEqual(report.samples, 2)

    def test_below_min_samples_no_recommendation(self):
        videos = [_v("a", _at(10)), _v("b", _at(11))]
        metrics = {"a": {"views": 1000}, "b": {"views": 1000}}
        report = pt.analyze(videos, metrics, now=NOW, min_samples=3)
        self.assertFalse(report.has_recommendation)

    def test_weekday_recommendation(self):
        videos, metrics = [], {}
        # Three Saturdays (weekday 5) strong, three Mondays (weekday 0) weak.
        for i in range(3):
            videos.append(_v(f"sat{i}", _at(12, weekday_offset=5) - timedelta(weeks=i)))
            metrics[f"sat{i}"] = {"views": 9000}
            videos.append(_v(f"mon{i}", _at(12, weekday_offset=0) - timedelta(weeks=i)))
            metrics[f"mon{i}"] = {"views": 200}
        report = pt.analyze(videos, metrics, now=NOW, min_samples=3)
        self.assertEqual(report.best_weekday, 5)
        self.assertEqual(report.best_weekday_name, "Sat")

    def test_shorts_excluded(self):
        videos = [_v(f"s{i}", _at(15), fmt="short") for i in range(3)]
        metrics = {f"s{i}": {"views": 9000} for i in range(3)}
        report = pt.analyze(videos, metrics, now=NOW, min_samples=3)
        self.assertFalse(report.has_recommendation)

    def test_bad_timestamp_skipped(self):
        videos = [{"video_id": "bad", "published_at": "nope", "video_format": "long"}]
        report = pt.analyze(videos, {"bad": {"views": 1000}}, now=NOW)
        self.assertEqual(report.samples, 0)

    def test_empty_inputs(self):
        self.assertFalse(pt.analyze([], {}, now=NOW).has_recommendation)
        self.assertFalse(pt.analyze(None, None, now=NOW).has_recommendation)

    def test_report_is_utc_and_serializable(self):
        report = pt.analyze([], {}, now=NOW)
        d = report.to_dict()
        self.assertEqual(d["timezone"], "UTC")
        self.assertIn("hour_scores", d)


if __name__ == "__main__":
    unittest.main()


class NextPublishSlotTestCase(unittest.TestCase):
    """Turning the advisory hour/weekday into a concrete future 'publish at'."""

    # 2026-09-14 is a Monday; use a fixed reference for determinism.
    MON_10 = datetime(2026, 9, 14, 10, 0, tzinfo=timezone.utc)

    def test_no_recommendation_returns_none(self):
        self.assertIsNone(pt.next_publish_slot(pt.TimingReport(), now=self.MON_10))

    def test_hour_only_today_when_still_ahead(self):
        report = pt.TimingReport(best_hour_utc=14)
        slot = pt.next_publish_slot(report, now=self.MON_10)
        self.assertEqual((slot.year, slot.month, slot.day, slot.hour), (2026, 9, 14, 14))

    def test_hour_only_rolls_to_tomorrow_when_passed(self):
        report = pt.TimingReport(best_hour_utc=8)  # already 10:00 now
        slot = pt.next_publish_slot(report, now=self.MON_10)
        self.assertEqual((slot.month, slot.day, slot.hour), (9, 15, 8))

    def test_weekday_and_hour_finds_that_weekday(self):
        # best_weekday 5 = Saturday; from Monday the coming Saturday.
        report = pt.TimingReport(best_hour_utc=9, best_weekday=5)
        slot = pt.next_publish_slot(report, now=self.MON_10)
        self.assertEqual(slot.weekday(), 5)
        self.assertEqual((slot.day, slot.hour), (19, 9))  # Sat 2026-09-19

    def test_same_weekday_past_hour_rolls_a_week(self):
        # Monday recommended at 08:00, but it is already Monday 10:00 → next Monday.
        report = pt.TimingReport(best_hour_utc=8, best_weekday=0)
        slot = pt.next_publish_slot(report, now=self.MON_10)
        self.assertEqual(slot.weekday(), 0)
        self.assertEqual((slot.day, slot.hour), (21, 8))  # next Monday

    def test_always_future_and_utc(self):
        report = pt.TimingReport(best_hour_utc=10, best_weekday=0)  # exactly now
        slot = pt.next_publish_slot(report, now=self.MON_10)
        self.assertGreater(slot, self.MON_10)
        self.assertEqual(slot.tzinfo, timezone.utc)

    def test_naive_now_is_treated_as_utc(self):
        naive = datetime(2026, 9, 14, 10, 0)
        slot = pt.next_publish_slot(pt.TimingReport(best_hour_utc=14), now=naive)
        self.assertEqual(slot.hour, 14)
        self.assertIsNotNone(slot.tzinfo)
