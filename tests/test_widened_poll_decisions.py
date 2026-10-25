"""The opt-in wider poll (NIGHTSHIFT_METRICS_POLL_DAYS) must not change what the decision engines read.

What would break without this: every reader that turns a snapshot into a rate divides `views` by the days since publishing and
treats it as a lifetime total. A snapshot is YouTube's TWO-DAY window. By default the newest snapshot is early-life, so the
division roughly works; with the poll widened a 60-day-old video gets a snapshot dated today holding two days of views, divided
by 60 (the same 100 views read 100.0/day for a 1-day-old video and 1.67/day for a 60-day-old one). StateStore.latest_metrics()
therefore returns only early-life readings, and an all-NULL row (a quiet video, nothing from YouTube) never hides a real one.
"""

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from modules import publish_timing, quota_allocator, sponsorship
from modules.feedback_engine import FeedbackEngine
from modules.performance_analyzer import PerformanceAnalyzer
from modules.state_store import StateStore

NOW = datetime(2026, 10, 25, 12, 0, 0)
AGES = (1, 10, 60, 90)


def _day(n_days_ago: int) -> str:
    return (NOW - timedelta(days=n_days_ago)).date().isoformat()


class WidenedReadingsDoNotMoveDecisions(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self._tmp.name) / "t.db")
        for age in AGES:
            published = NOW - timedelta(days=age)
            self.store.record_video(
                video_id=f"v{age}", topic=f"topic {age}", title=f"Title {age}", published_at=published.isoformat(),
            )
            # The reading the default poll takes: the day after publishing.
            self.store.record_metrics_snapshot(
                video_id=f"v{age}", snapshot_date=_day(age - 1), views=100 * (1 + age % 3), likes=10, comment_count=2,
                watch_time_minutes=40.0, average_view_duration_seconds=30.0, impressions=1000, impression_ctr=0.05,
            )

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def widen(self):
        """What the widened poll adds for videos past their first days: a fresh two-day-window reading on each of the last
        five days, filed as `late`. Plus an all-NULL row for a quiet video dated today, in the main table (what the
        previous release wrote, and so what an existing database may already hold)."""
        for age in (a for a in AGES if a > 5):   # a video younger than that is polled by the default poll too
            for back in range(0, 5):
                self.store.record_metrics_snapshot(
                    video_id=f"v{age}", snapshot_date=_day(back), views=7 + back, likes=1, comment_count=0,
                    watch_time_minutes=3.0, average_view_duration_seconds=20.0, impressions=90, impression_ctr=0.01,
                    late=True,
                )
        self.store.record_metrics_snapshot(
            video_id="v10", snapshot_date=_day(0), views=None, likes=None, comment_count=None, watch_time_minutes=None,
            average_view_duration_seconds=None, impressions=None, impression_ctr=None,
        )

    def readings(self):
        videos = self.store.list_videos(limit=100)
        metrics = {v["video_id"]: self.store.latest_metrics(v["video_id"]) for v in videos}
        return videos, {k: v for k, v in metrics.items() if v is not None}

    def decisions(self):
        videos, metrics = self.readings()
        analysis = [
            (p.video_id, p.latest_views, p.views_per_day)
            for p in PerformanceAnalyzer(self.store).analyze_videos()
        ]
        records = [
            (r.video_id, r.views_per_day, r.engagement_rate, r.retention_seconds)
            for r in FeedbackEngine(self.store)._gather(100)
        ]
        scores = quota_allocator.performance_scores({"c": videos}, metrics, now=NOW.replace(tzinfo=timezone.utc))
        timing = publish_timing.analyze(videos, metrics, now=NOW.replace(tzinfo=timezone.utc), min_samples=1)
        sponsor = sponsorship.average_long_form_views(videos, metrics)
        return {
            "metrics": metrics,
            "analysis": sorted(analysis),
            "feedback": sorted(records),
            "quota": scores,
            "timing": (timing.best_hour_utc, timing.best_weekday_name, timing.samples),
            "sponsor": sponsor,
        }

    def test_the_fixture_actually_reads_something(self):
        d = self.decisions()
        self.assertEqual(sorted(d["metrics"]), sorted(f"v{a}" for a in AGES))
        self.assertEqual(len(d["analysis"]), len(AGES))
        self.assertGreater(d["quota"]["c"], 0)

    def test_every_decision_reader_gives_the_same_answer_with_and_without_widened_readings(self):
        before = self.decisions()
        self.widen()
        self.assertEqual(self.decisions(), before)

    def test_without_the_early_life_rule_the_widened_readings_would_have_moved_them(self):
        # The control: the newest snapshot of any age (what latest_metrics used to be) does change the answer, so the test
        # above is not passing for lack of anything to detect.
        self.widen()
        newest = {a: self.store.newest_metrics(f"v{a}") for a in AGES}
        early = {a: self.store.latest_metrics(f"v{a}") for a in AGES}
        for age in (10, 60, 90):
            self.assertNotEqual(newest[age]["snapshot_date"], early[age]["snapshot_date"], age)
            self.assertEqual(newest[age]["snapshot_date"], _day(0))
            self.assertEqual(early[age]["snapshot_date"], _day(age - 1))

    def test_the_mirror_still_copies_the_newest_reading_late_ones_included(self):
        # The dashboard reads Supabase, so the mirror must carry the late readings the decision readers never see.
        from modules.supabase_sync import SupabaseSync

        self.widen()
        sync = SupabaseSync.__new__(SupabaseSync)
        rows = {r["video_id"]: r for r in sync._gather_metrics(self.store)}
        for age in (10, 60, 90):
            self.assertEqual(rows[f"v{age}"]["snapshot_date"], _day(0), age)
        self.assertNotIn("id", {k for r in rows.values() for k in r})
        self.assertEqual(rows["v10"]["views"], 7)       # v10's all-NULL row of the same day is nobody's reading
        self.assertEqual(rows["v1"]["snapshot_date"], _day(0))   # a young video: its own early row, as before


if __name__ == "__main__":
    unittest.main()
