"""Tests for modules/intelligence_poller.py.

Uses a real StateStore against a tempdir SQLite file (to exercise the real
write path) plus fake/mock AnalyticsClient, CompetitorMonitor, and
TrendDetector so no live API calls are ever made.
"""

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules.intelligence_poller import IntelligencePoller
from modules.state_store import StateStore
from modules.video_snapshot import VideoSnapshot


class IntelligencePollerTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_chronos.db"
        self.store = StateStore(self.db_path)

    def tearDown(self):
        self.store.close()
        self._tmpdir.cleanup()

    def _make_poller(self, analytics_client=None, competitor_monitor=None, trend_detector=None):
        return IntelligencePoller(
            state_store=self.store,
            analytics_client=analytics_client if analytics_client is not None else MagicMock(),
            competitor_monitor=competitor_monitor if competitor_monitor is not None else MagicMock(),
            trend_detector=trend_detector if trend_detector is not None else MagicMock(),
        )

    # -- poll_own_channel_metrics -----------------------------------------

    def test_poll_own_channel_metrics_writes_snapshot_per_video(self):
        self.store.record_video(video_id="v1", title="First", published_at="2026-01-01T00:00:00")
        self.store.record_video(video_id="v2", title="Second", published_at="2026-01-02T00:00:00")

        analytics = MagicMock()
        analytics.video_performance.return_value = {
            "views": 100,
            "likes": 10,
            "comments": 2,
            "estimatedMinutesWatched": 50.0,
            "averageViewDuration": 30.0,
        }
        poller = self._make_poller(analytics_client=analytics)

        written = poller.poll_own_channel_metrics(days=None)

        self.assertEqual(written, 2)
        self.assertEqual(analytics.video_performance.call_count, 2)
        for video_id in ("v1", "v2"):
            latest = self.store.latest_metrics(video_id)
            self.assertIsNotNone(latest)
            self.assertEqual(latest["views"], 100)
            self.assertEqual(latest["likes"], 10)
            self.assertEqual(latest["comment_count"], 2)
            self.assertEqual(latest["watch_time_minutes"], 50.0)
            self.assertEqual(latest["average_view_duration_seconds"], 30.0)

    def test_poll_own_channel_metrics_one_failure_does_not_stop_others(self):
        self.store.record_video(video_id="good1", title="Good1", published_at="2026-01-01T00:00:00")
        self.store.record_video(video_id="bad", title="Bad", published_at="2026-01-02T00:00:00")
        self.store.record_video(video_id="good2", title="Good2", published_at="2026-01-03T00:00:00")

        def side_effect(video_id, start_date, end_date):
            if video_id == "bad":
                raise RuntimeError("simulated API failure (e.g. video too new)")
            return {"views": 5, "likes": 1, "comments": 0}

        analytics = MagicMock()
        analytics.video_performance.side_effect = side_effect
        poller = self._make_poller(analytics_client=analytics)

        written = poller.poll_own_channel_metrics(days=None)

        # Two of three videos succeeded; the failing one contributed nothing
        # but did not abort the loop.
        self.assertEqual(written, 2)
        self.assertEqual(analytics.video_performance.call_count, 3)
        self.assertIsNotNone(self.store.latest_metrics("good1"))
        self.assertIsNotNone(self.store.latest_metrics("good2"))
        self.assertIsNone(self.store.latest_metrics("bad"))

    def test_poll_own_channel_metrics_empty_store_is_zero_without_error(self):
        analytics = MagicMock()
        poller = self._make_poller(analytics_client=analytics)

        written = poller.poll_own_channel_metrics()

        self.assertEqual(written, 0)
        analytics.video_performance.assert_not_called()

    # -- poll_competitors -------------------------------------------------

    def test_poll_competitors_returns_mock_data_on_success(self):
        snapshot = VideoSnapshot(
            video_id="cv1",
            channel_id="chan1",
            title="Competitor Video",
            published_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
            view_count=1000,
            like_count=50,
            comment_count=5,
        )
        competitor_monitor = MagicMock()
        competitor_monitor.poll.return_value = {"chan1": [snapshot]}
        poller = self._make_poller(competitor_monitor=competitor_monitor)

        result = poller.poll_competitors(["chan1"])

        competitor_monitor.poll.assert_called_once_with(["chan1"])
        self.assertEqual(result, {"chan1": [snapshot]})

    def test_poll_competitors_persists_snapshot_with_view_velocity(self):
        snapshot = VideoSnapshot(
            video_id="cv2", channel_id="chan1", title="Rival",
            published_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
            view_count=1000, like_count=50, comment_count=5,
        )
        competitor_monitor = MagicMock()
        competitor_monitor.poll.return_value = {"chan1": [snapshot]}
        poller = self._make_poller(competitor_monitor=competitor_monitor)

        poller.poll_competitors(["chan1"])

        rows = self.store.list_competitor_snapshots(channel_id="chan1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["video_id"], "cv2")
        self.assertEqual(rows[0]["view_count"], 1000)
        self.assertGreater(rows[0]["view_velocity"], 0)

    def test_poll_competitors_returns_empty_dict_on_failure(self):
        competitor_monitor = MagicMock()
        competitor_monitor.poll.side_effect = RuntimeError("quota exceeded")
        poller = self._make_poller(competitor_monitor=competitor_monitor)

        result = poller.poll_competitors(["chan1"])

        self.assertEqual(result, {})

    # -- poll_trends --------------------------------------------------------

    def test_poll_trends_returns_mock_data_on_success(self):
        snapshot = VideoSnapshot(
            video_id="tv1",
            channel_id="chan2",
            title="Trending Video",
            published_at=datetime(2026, 8, 2, tzinfo=timezone.utc),
            view_count=99999,
            like_count=5000,
            comment_count=200,
        )
        trend_detector = MagicMock()
        trend_detector.trending.return_value = [snapshot]
        poller = self._make_poller(trend_detector=trend_detector)

        result = poller.poll_trends(region_code="US", category_id="24")

        trend_detector.trending.assert_called_once_with(region_code="US", category_id="24")
        self.assertEqual(result, [snapshot])

    def test_poll_trends_persists_snapshot(self):
        snapshot = VideoSnapshot(
            video_id="tv2", channel_id="chan2", title="Trending",
            published_at=datetime(2026, 8, 2, tzinfo=timezone.utc),
            view_count=99999, like_count=5000, comment_count=200,
        )
        trend_detector = MagicMock()
        trend_detector.trending.return_value = [snapshot]
        poller = self._make_poller(trend_detector=trend_detector)

        poller.poll_trends(region_code="US", category_id="24")

        rows = self.store.list_trending_snapshots()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["video_id"], "tv2")
        self.assertEqual(rows[0]["region_code"], "US")
        self.assertEqual(rows[0]["category_id"], "24")

    def test_poll_trends_returns_empty_list_on_failure(self):
        trend_detector = MagicMock()
        trend_detector.trending.side_effect = RuntimeError("network error")
        poller = self._make_poller(trend_detector=trend_detector)

        result = poller.poll_trends()

        self.assertEqual(result, [])

    # -- run_all -----------------------------------------------------------

    def test_run_all_calls_all_three_and_returns_summary_shape(self):
        # run_all() uses poll_own_channel_metrics()'s default `days=1` window,
        # so the fixture video must be recently published to be picked up.
        recent_published_at = datetime.now().isoformat()
        self.store.record_video(video_id="v1", title="First", published_at=recent_published_at)

        analytics = MagicMock()
        analytics.video_performance.return_value = {"views": 10, "likes": 1, "comments": 0}

        competitor_monitor = MagicMock()
        competitor_monitor.poll.return_value = {"chanA": [], "chanB": []}

        trend_detector = MagicMock()
        trend_detector.trending.return_value = [MagicMock(), MagicMock(), MagicMock()]

        poller = self._make_poller(
            analytics_client=analytics,
            competitor_monitor=competitor_monitor,
            trend_detector=trend_detector,
        )

        summary = poller.run_all(competitor_channel_ids=["chanA", "chanB"])

        analytics.video_performance.assert_called()
        competitor_monitor.poll.assert_called_once_with(["chanA", "chanB"])
        trend_detector.trending.assert_called_once()

        # trend_detector's mock returns bare MagicMocks (not real VideoSnapshot
        # instances), which is deliberate here — it proves persistence failing
        # on unexpected shapes is caught and skipped rather than propagating,
        # not that anything got written. See test_poll_trends_returns_mock_data_on_success
        # and test_poll_competitors_returns_mock_data_on_success below for the
        # positive persistence path with real VideoSnapshot data.
        self.assertEqual(
            summary,
            {
                "own_metrics_written": 1,
                "competitor_channels_polled": 2,
                "competitor_snapshots_written": 0,
                "trending_videos_found": 3,
                "trending_snapshots_written": 0,
                # Advisory repackage pass runs too; with one measured video there
                # is no channel baseline, so it flags nothing.
                "repackage_candidates": 0,
                # Advisory spend forecast runs too; with no priced spend this
                # month it projects 0.0 (a real, known number), so ready is True.
                "spend_forecast_ready": True,
                # Advisory publish-time pass runs too; one video clears no slot's
                # sample threshold, so no recommendation.
                "publish_timing_ready": False,
                # Revenue tracking is off by default (monetary scope is opt-in),
                # so the pass returns early without measuring anything.
                "revenue_tracked": False,
            },
        )

    # -- track_revenue (roadmap #71) --------------------------------------

    def test_track_revenue_off_by_default_makes_no_api_call(self):
        # Monetary scope is opt-in; with it disabled the pass returns early and
        # never hits the API (so an un-consented channel isn't spammed with 403s).
        self.store.record_video(video_id="v1", title="First", published_at="2026-01-01T00:00:00")
        analytics = MagicMock()
        poller = self._make_poller(analytics_client=analytics)

        with patch("config.REVENUE_TRACKING_ENABLED", False):
            self.assertFalse(poller.track_revenue())
        analytics.video_revenue.assert_not_called()

    def test_track_revenue_measures_and_emits_when_enabled(self):
        self.store.record_video(video_id="v1", title="First", published_at="2026-01-01T00:00:00")
        self.store.record_video(video_id="v2", title="Second", published_at="2026-01-02T00:00:00")

        analytics = MagicMock()
        analytics.video_revenue.side_effect = lambda vid, s, e: {
            "v1": {"estimatedRevenue": 12.0, "views": 1000},
            "v2": {"estimatedRevenue": 3.0, "views": 3000},
        }[vid]
        poller = self._make_poller(analytics_client=analytics)

        with patch("config.REVENUE_TRACKING_ENABLED", True), \
                patch("modules.event_log.emit") as emit:
            self.assertTrue(poller.track_revenue())

        self.assertEqual(analytics.video_revenue.call_count, 2)
        emit.assert_called_once()
        event_name = emit.call_args.args[0]
        meta = emit.call_args.kwargs["metadata"]
        self.assertEqual(event_name, "revenue.tracked")
        self.assertEqual(meta["total_usd"], 15.0)
        self.assertEqual(meta["measured_count"], 2)
        self.assertEqual(meta["currency"], "USD")

    def test_track_revenue_unmonetized_channel_reports_no_revenue(self):
        # Enabled, but the channel is not in YPP: every video_revenue returns {}.
        # The pass still emits an honest empty report — never a fabricated $0.
        self.store.record_video(video_id="v1", title="First", published_at="2026-01-01T00:00:00")
        analytics = MagicMock()
        analytics.video_revenue.return_value = {}
        poller = self._make_poller(analytics_client=analytics)

        with patch("config.REVENUE_TRACKING_ENABLED", True), \
                patch("modules.event_log.emit") as emit:
            self.assertFalse(poller.track_revenue())

        emit.assert_called_once()
        self.assertIsNone(emit.call_args.kwargs["metadata"]["total_usd"])

    def test_run_all_without_competitor_channel_ids_skips_competitor_poll(self):
        competitor_monitor = MagicMock()
        trend_detector = MagicMock()
        trend_detector.trending.return_value = []
        poller = self._make_poller(competitor_monitor=competitor_monitor, trend_detector=trend_detector)

        summary = poller.run_all()

        competitor_monitor.poll.assert_not_called()
        self.assertEqual(summary["competitor_channels_polled"], 0)


if __name__ == "__main__":
    unittest.main()
