"""The default poll and the widened poll, day by day, on a fake clock: the Python decision engines must not be able to tell them apart.

What would break without this: the default poll reads a video only at calendar ages 0 and 1 (published since yesterday). If the
widened poll files its readings of ages 2 or 3 where latest_metrics() sees them, a two-day window taken at age 3 is divided by 3
days: in the reviewer's simulation the same video read 1800 views a day under the default poll and 311 under the widened one.
This runs one video through ages 0..40 under both polls (each with its own database) and compares, every day, what the readers see.
"""

import datetime as dt
import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import modules.intelligence_poller as ip
from modules.performance_analyzer import PerformanceAnalyzer
from modules.state_store import StateStore

D0 = dt.date(2026, 9, 1)


class _Clock:
    today = D0


class _FakeDate(dt.date):
    @classmethod
    def today(cls):
        return cls(_Clock.today.year, _Clock.today.month, _Clock.today.day)


class _FakeDateTime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(_Clock.today.year, _Clock.today.month, _Clock.today.day, 20, 0)


def _daily(age: int) -> float:
    return 0 if age < 0 else 1000 * 0.7 ** age + 50


class _Analytics:
    """YouTube's answer for 'yesterday through today' on the fake day: two days of views, so it falls with the video's age."""

    def video_performance(self, video_id, start, end):
        age = (_Clock.today - D0).days
        return {"views": int(_daily(age) + _daily(age - 1)), "likes": 5, "comments": 1,
                "estimatedMinutesWatched": 10.0, "averageViewDuration": 40.0}

    def video_ctr(self, video_id, start, end):
        return {"impressions": 1000, "impressionClickThroughRate": 0.05}

    def video_retention(self, video_id, start, end):
        return [{"elapsedVideoTimeRatio": 0.01, "audienceWatchRatio": 1.0}]


class DefaultAndWidenedPollsLookTheSameToTheReaders(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        ip.reset_run_clock()
        self.addCleanup(ip.reset_run_clock)
        patcher = patch.multiple(ip, date=_FakeDate, datetime=_FakeDateTime)
        patcher.start()
        self.addCleanup(patcher.stop)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.default = self._world("default.db")
        self.widened = self._world("widened.db")

    def _world(self, name):
        store = StateStore(Path(self._tmp.name) / name)
        self.addCleanup(store.close)
        store.record_video(video_id="vid", title="t", topic="x", published_at=dt.datetime(2026, 9, 1, 10, 0).isoformat())
        poller = ip.IntelligencePoller(state_store=store, analytics_client=_Analytics(),
                                       competitor_monitor=MagicMock(), trend_detector=MagicMock())
        return store, poller

    @staticmethod
    def _seen(store):
        m = store.latest_metrics("vid")
        retention_dates = [r[0] for r in store.conn.execute(
            "select distinct measured_date from retention_points order by 1")]
        return (
            m and (m["snapshot_date"], m["views"], m["likes"], m["watch_time_minutes"], m["impression_ctr"]),
            [(p.video_id, p.latest_views, p.views_per_day) for p in PerformanceAnalyzer(store).analyze_videos()],
            retention_dates,
            [r["snapshot_date"] for r in store.metrics_history("vid")],
            store.retention_curve("vid"),
        )

    def test_every_day_from_publishing_to_day_forty_both_polls_show_the_readers_the_same_thing(self):
        (default_store, default_poller), (wide_store, wide_poller) = self.default, self.widened
        widened_late_rows = 0
        for age in range(0, 41):
            _Clock.today = D0 + dt.timedelta(days=age)
            default_poller.poll_own_channel_metrics()
            wide_poller.poll_own_channel_metrics(days=60, max_calls=600, max_seconds=600)
            self.assertEqual(self._seen(wide_store), self._seen(default_store), f"day {age}")
            widened_late_rows = wide_store.conn.execute("select count(*) from metrics_snapshots_late").fetchone()[0]
        # The control: the widened poll really did read the video on the days the default poll did not.
        self.assertEqual(widened_late_rows, 39)     # days 2..40
        self.assertEqual(default_store.conn.execute("select count(*) from metrics_snapshots_late").fetchone()[0], 0)
        self.assertEqual(wide_store.newest_metrics("vid")["snapshot_date"], (D0 + dt.timedelta(days=40)).isoformat())
        self.assertEqual(default_store.newest_metrics("vid")["snapshot_date"], (D0 + dt.timedelta(days=1)).isoformat())

    def test_the_values_the_readers_see_are_the_default_polls_own_day_one_numbers(self):
        _Clock.today = D0
        self.default[1].poll_own_channel_metrics()
        _Clock.today = D0 + dt.timedelta(days=1)
        self.default[1].poll_own_channel_metrics()
        snapshot_date, views, *_ = self._seen(self.default[0])[0]
        self.assertEqual(snapshot_date, (D0 + dt.timedelta(days=1)).isoformat())
        self.assertGreater(views, 1000)      # a young video: two days of real views, not a trickle

    def test_age_two_and_three_are_late_for_the_widened_poll_and_never_read_by_the_default_one(self):
        for age in (2, 3):
            _Clock.today = D0 + dt.timedelta(days=age)
            self.assertEqual(self.default[1].poll_own_channel_metrics(), 0, age)
            self.widened[1].poll_own_channel_metrics(days=60, max_calls=600, max_seconds=600)
        self.assertIsNone(self.default[0].latest_metrics("vid"))
        self.assertIsNone(self.widened[0].latest_metrics("vid"))
        self.assertEqual(self.widened[0].conn.execute("select count(*) from metrics_snapshots_late").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
