"""Tests for modules/intelligence_poller.py.

Uses a real StateStore against a tempdir SQLite file (to exercise the real
write path) plus fake/mock AnalyticsClient, CompetitorMonitor, and
TrendDetector so no live API calls are ever made.
"""

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules.intelligence_poller import (
    ANALYTICS_CALLS_PER_VIDEO,
    MAX_ANALYTICS_CALLS_PER_POLL,
    MAX_METRICS_POLL_SECONDS,
    DEFAULT_POLL_DAYS,
    EARLY_LIFE_DAYS,
    reset_run_clock,
    METRICS_POLL_DAYS_ENV,
    IntelligencePoller,
    metrics_poll_options,
)
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
            latest = self.store.newest_metrics(video_id)
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
        self.assertIsNotNone(self.store.newest_metrics("good1"))
        self.assertIsNotNone(self.store.newest_metrics("good2"))
        self.assertIsNone(self.store.newest_metrics("bad"))

    def test_poll_own_channel_metrics_empty_store_is_zero_without_error(self):
        analytics = MagicMock()
        poller = self._make_poller(analytics_client=analytics)

        written = poller.poll_own_channel_metrics()

        self.assertEqual(written, 0)
        analytics.video_performance.assert_not_called()

    def _poll_one(self, performance, ctr=None, expect_written=1):
        self.store.record_video(video_id="v1", title="First", published_at="2026-01-01T00:00:00")
        analytics = MagicMock()
        analytics.video_performance.return_value = performance
        analytics.video_ctr.return_value = {} if ctr is None else ctr
        analytics.video_retention.return_value = []
        written = self._make_poller(analytics_client=analytics).poll_own_channel_metrics(days=None)
        self.assertEqual(written, expect_written)
        return self.store.newest_metrics("v1")

    def test_a_video_youtube_has_no_row_for_yet_gets_no_snapshot_at_all(self):
        # video_performance returns {} (and the CTR report too) when YouTube has no row for the window. Zeros were read
        # downstream as "measured, nobody watched"; an all-NULL row dated today would be the NEWEST snapshot and hide an
        # earlier real one from latest_metrics() and every decision reader. So nothing is written.
        self.assertIsNone(self._poll_one({}, expect_written=0))

    def test_a_video_with_only_a_click_through_reading_still_gets_a_row(self):
        row = self._poll_one({}, ctr={"impressions": 1000, "impressionClickThroughRate": 0.04})
        self.assertEqual((row["impressions"], row["impression_ctr"]), (1000, 0.04))
        self.assertIsNone(row["views"])

    def test_a_zero_youtube_did_return_stays_a_zero(self):
        row = self._poll_one({"views": 0, "likes": 0, "comments": 0, "estimatedMinutesWatched": 0.0,
                              "averageViewDuration": 0.0})
        self.assertEqual((row["views"], row["likes"], row["comment_count"]), (0, 0, 0))
        self.assertEqual((row["watch_time_minutes"], row["average_view_duration_seconds"]), (0.0, 0.0))

    def test_only_the_metrics_missing_from_the_response_are_null(self):
        row = self._poll_one({"views": 42, "likes": 5})
        self.assertEqual((row["views"], row["likes"]), (42, 5))
        self.assertIsNone(row["comment_count"])
        self.assertIsNone(row["watch_time_minutes"])
        self.assertIsNone(row["average_view_duration_seconds"])

    def test_an_unparseable_metric_is_null_rather_than_losing_the_snapshot_or_becoming_zero(self):
        row = self._poll_one({"views": "n/a", "likes": 3, "estimatedMinutesWatched": float("nan")})
        self.assertIsNone(row["views"])
        self.assertEqual(row["likes"], 3)
        self.assertIsNone(row["watch_time_minutes"])

    def test_infinity_is_not_a_measurement_in_any_column(self):
        # int(float("inf")) raises OverflowError; a float inf would be stored and then break the mirror's JSON.
        row = self._poll_one({"views": float("inf"), "likes": "1e999", "comments": float("-inf"),
                              "estimatedMinutesWatched": float("inf"), "averageViewDuration": "inf", "shares": 1},
                             ctr={"impressions": 5})
        for column in ("views", "likes", "comment_count", "watch_time_minutes", "average_view_duration_seconds"):
            self.assertIsNone(row[column], column)

    def test_a_boolean_or_an_out_of_range_number_is_not_a_count(self):
        # True is 1 in Python and 2**70 would not fit the integer column; YouTube sends neither.
        row = self._poll_one({"views": True, "likes": 2**70, "comments": -1, "estimatedMinutesWatched": False,
                              "averageViewDuration": 12.5}, ctr={"impressions": 2**31})
        for column in ("views", "likes", "comment_count", "watch_time_minutes", "impressions"):
            self.assertIsNone(row[column], column)
        self.assertEqual(row["average_view_duration_seconds"], 12.5)

    def test_the_int32_edges_are_accepted(self):
        row = self._poll_one({"views": 2**31 - 1, "likes": 0, "comments": 1})
        self.assertEqual((row["views"], row["likes"]), (2**31 - 1, 0))

    def test_a_negative_figure_is_not_a_measurement(self):
        row = self._poll_one({"views": 5, "estimatedMinutesWatched": -1.5, "averageViewDuration": -0.5})
        self.assertEqual(row["views"], 5)
        self.assertIsNone(row["watch_time_minutes"])
        self.assertIsNone(row["average_view_duration_seconds"])

    def test_zero_and_negative_zero_floats_are_measured_zeros(self):
        row = self._poll_one({"views": 5, "estimatedMinutesWatched": 0.0, "averageViewDuration": -0.0})
        self.assertEqual((row["watch_time_minutes"], row["average_view_duration_seconds"]), (0.0, 0.0))

    def test_numeric_strings_and_floats_from_the_api_are_still_read(self):
        row = self._poll_one({"views": "100", "likes": 10.0, "comments": 2, "estimatedMinutesWatched": "50.5",
                              "averageViewDuration": 30})
        self.assertEqual((row["views"], row["likes"], row["comment_count"]), (100, 10, 2))
        self.assertEqual((row["watch_time_minutes"], row["average_view_duration_seconds"]), (50.5, 30.0))

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
                # Advisory sponsorship pass runs too; one measured video is under
                # the reach threshold and no CPM is set, so no price.
                "sponsorship_ready": False,
                # Revenue tracking is off by default (monetary scope is opt-in),
                # so the pass returns early without measuring anything.
                "revenue_tracked": False,
                # vidIQ research is off by default (no token / opt-in), so the
                # pass returns early and recommends nothing.
                "vidiq_researched": False,
            },
        )

    # -- estimate_sponsorship (roadmap #72) -------------------------------

    def test_estimate_sponsorship_prices_slot_when_reach_and_cpm(self):
        for i in range(3):
            self.store.record_video(video_id=f"v{i}", title=f"V{i}",
                                    published_at="2026-01-01T00:00:00")
            self.store.record_metrics_snapshot(video_id=f"v{i}", snapshot_date="2026-01-02", views=2000)

        poller = self._make_poller()
        with patch("modules.sponsorship.sponsorship_cpm", return_value=25.0), \
                patch("modules.event_log.emit") as emit:
            self.assertTrue(poller.estimate_sponsorship())

        emit.assert_called_once()
        self.assertEqual(emit.call_args.args[0], "sponsorship.estimate")
        meta = emit.call_args.kwargs["metadata"]
        self.assertEqual(meta["price_usd"], 50.0)   # 2000/1000 * 25
        self.assertEqual(meta["cpm_usd"], 25.0)
        self.assertEqual(meta["currency"], "USD")

    def test_estimate_sponsorship_no_cpm_reports_reach_without_price(self):
        for i in range(3):
            self.store.record_video(video_id=f"v{i}", title=f"V{i}",
                                    published_at="2026-01-01T00:00:00")
            self.store.record_metrics_snapshot(video_id=f"v{i}", snapshot_date="2026-01-02", views=2000)

        poller = self._make_poller()
        with patch("modules.sponsorship.sponsorship_cpm", return_value=None), \
                patch("modules.event_log.emit") as emit:
            self.assertFalse(poller.estimate_sponsorship())

        emit.assert_called_once()
        self.assertIsNone(emit.call_args.kwargs["metadata"]["price_usd"])

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

    # -- research_vidiq (roadmap #75) -------------------------------------

    def _poller_with_niche(self, niche):
        channel = MagicMock()
        channel.channel_id = "chan-1"
        channel.niche = niche
        return IntelligencePoller(
            state_store=self.store,
            analytics_client=MagicMock(),
            competitor_monitor=MagicMock(),
            trend_detector=MagicMock(),
            channel=channel,
        )

    def test_research_vidiq_disabled_returns_false(self):
        poller = self._poller_with_niche("history mysteries")
        with patch("modules.vidiq_client.make_client", return_value=None):
            self.assertFalse(poller.research_vidiq())

    def test_research_vidiq_no_niche_skips(self):
        poller = self._poller_with_niche("   ")
        client = MagicMock()
        with patch("modules.vidiq_client.make_client", return_value=client):
            self.assertFalse(poller.research_vidiq())
        client.keyword_research.assert_not_called()

    def test_research_vidiq_emits_and_returns_true_when_configured(self):
        poller = self._poller_with_niche("roman history")
        client = MagicMock()
        client.keyword_research.return_value = [
            {"term": "roman roads", "search_volume": 80, "competition": 20},
        ]
        with patch("modules.vidiq_client.make_client", return_value=client), patch(
            "modules.event_log.emit"
        ) as emit:
            result = poller.research_vidiq()
        self.assertTrue(result)
        client.keyword_research.assert_called_once_with("roman history")
        emit.assert_called_once()
        self.assertEqual(emit.call_args.kwargs["channel_id"], "chan-1")


class MetricsPollWindowTestCase(unittest.TestCase):
    """NIGHTSHIFT_METRICS_POLL_DAYS: the opt-in wider own-channel poll and its Analytics call cap."""

    def setUp(self):
        reset_run_clock()
        self.addCleanup(reset_run_clock)
        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self._tmpdir.name) / "test_chronos.db")

    def tearDown(self):
        self.store.close()
        self._tmpdir.cleanup()

    def _make_poller(self, analytics_client):
        return IntelligencePoller(
            state_store=self.store,
            analytics_client=analytics_client,
            competitor_monitor=MagicMock(),
            trend_detector=MagicMock(),
        )

    def _store_videos_published(self, *days_ago):
        now = datetime.now()
        ids = []
        for n in days_ago:
            vid = f"v{n}d"
            ids.append(vid)
            self.store.record_video(video_id=vid, title=vid, published_at=(now - timedelta(days=n)).isoformat())
        return ids

    def _analytics(self):
        analytics = MagicMock()
        analytics.video_performance.return_value = {"views": 10}
        analytics.video_ctr.return_value = {}
        analytics.video_retention.return_value = []
        return analytics

    def test_an_empty_poll_leaves_the_earlier_real_snapshot_as_the_one_readers_see(self):
        self.store.record_video(video_id="v1", title="First", published_at=datetime.now().isoformat())
        self.store.record_metrics_snapshot(video_id="v1", snapshot_date=datetime.now().date().isoformat(),
                                           views=50, impression_ctr=0.05)
        yesterday = (datetime.now().date() - timedelta(days=1)).isoformat()
        self.store.record_metrics_snapshot(video_id="v1", snapshot_date=yesterday, views=20)
        analytics = self._analytics()
        analytics.video_performance.return_value = {}
        analytics.video_ctr.return_value = {}
        self.assertEqual(self._make_poller(analytics_client=analytics).poll_own_channel_metrics(days=30, max_calls=600), 0)
        self.assertEqual(self.store.latest_metrics("v1")["views"], 50)
        self.assertEqual(len(self.store.metrics_history("v1")), 2)

    def test_an_empty_video_costs_two_calls_and_no_retention_call(self):
        self.store.record_video(video_id="v1", title="First", published_at=datetime.now().isoformat())
        analytics = self._analytics()
        analytics.video_performance.return_value = {}
        poller = self._make_poller(analytics_client=analytics)
        poller.poll_own_channel_metrics(days=30, max_calls=600)
        self.assertEqual(poller.last_analytics_calls, 2)
        analytics.video_retention.assert_not_called()

    def test_an_empty_variable_leaves_the_options_empty_so_the_call_is_the_old_one(self):
        for env in ({}, {METRICS_POLL_DAYS_ENV: ""}, {METRICS_POLL_DAYS_ENV: "   "}):
            self.assertEqual(metrics_poll_options(env), {}, env)

    def test_a_valid_number_of_days_widens_the_poll_and_sets_the_cap(self):
        for raw, days in (("1", 1), ("7", 7), (" 30 ", 30), ("90", 90)):
            reset_run_clock()
            with patch("modules.intelligence_poller.time.monotonic", lambda: 1000.0):
                got = metrics_poll_options({METRICS_POLL_DAYS_ENV: raw})
            self.assertEqual(got,
                             {"days": days, "max_calls": MAX_ANALYTICS_CALLS_PER_POLL,
                              "max_seconds": MAX_METRICS_POLL_SECONDS}, raw)

    def test_a_bad_value_is_ignored_loudly_never_clamped(self):
        # 365 clamped to 90 would still widen a quota-bound job on a typo; ignoring it keeps today's behaviour.
        for raw in ("0", "91", "365", "-3", "abc", "7.5", "1e2", "7 days", "٣"):
            with self.assertLogs("modules.intelligence_poller", level="WARNING") as logs:
                self.assertEqual(metrics_poll_options({METRICS_POLL_DAYS_ENV: raw}), {}, raw)
            self.assertIn(METRICS_POLL_DAYS_ENV, logs.output[0])
            self.assertIn("1 to 90", logs.output[0])

    def test_a_huge_bad_value_is_logged_truncated(self):
        with self.assertLogs("modules.intelligence_poller", level="WARNING") as logs:
            metrics_poll_options({METRICS_POLL_DAYS_ENV: "x" * 5000})
        self.assertLess(len(logs.output[0]), 400)
        self.assertIn("x" * 40, logs.output[0])
        self.assertNotIn("x" * 41, logs.output[0])

    def test_an_absurdly_long_number_is_a_bad_value_not_a_crash(self):
        # int() raises ValueError past 4300 digits; the poll must still start.
        with self.assertLogs("modules.intelligence_poller", level="WARNING"):
            self.assertEqual(metrics_poll_options({METRICS_POLL_DAYS_ENV: "9" * 5000}), {})

    def test_the_options_read_the_process_environment_by_default(self):
        with patch.dict("os.environ", {METRICS_POLL_DAYS_ENV: "21"}):
            self.assertEqual(metrics_poll_options()["days"], 21)
        with patch.dict("os.environ", {}, clear=False):
            os.environ.pop(METRICS_POLL_DAYS_ENV, None)
            self.assertEqual(metrics_poll_options(), {})

    def test_run_all_with_the_variable_empty_makes_the_unchanged_call(self):
        # Byte-for-byte: no days, no cap, and list_videos gets no limit either.
        self._store_videos_published(0)
        poller = self._make_poller(analytics_client=self._analytics())
        env = {k: v for k, v in os.environ.items() if k != METRICS_POLL_DAYS_ENV}
        with patch.dict("os.environ", env, clear=True), \
                patch.object(poller, "poll_own_channel_metrics", wraps=poller.poll_own_channel_metrics) as poll, \
                patch.object(self.store, "list_videos", wraps=self.store.list_videos) as listing:
            poller.run_all()
        poll.assert_called_once_with()
        listing.assert_any_call(
            since=(datetime.now().date() - timedelta(days=1)).isoformat(), channel_id=None)

    def test_run_all_with_the_variable_set_reads_that_many_days_under_the_cap(self):
        self._store_videos_published(0)
        poller = self._make_poller(analytics_client=self._analytics())
        with patch.dict("os.environ", {METRICS_POLL_DAYS_ENV: "30"}), \
                patch.object(poller, "poll_own_channel_metrics", wraps=poller.poll_own_channel_metrics) as poll, \
                patch.object(self.store, "list_videos", wraps=self.store.list_videos) as listing:
            poller.run_all()
        poll.assert_called_once_with(days=30, max_calls=MAX_ANALYTICS_CALLS_PER_POLL,
                                     max_seconds=MAX_METRICS_POLL_SECONDS)
        listing.assert_any_call(
            since=(datetime.now().date() - timedelta(days=30)).isoformat(), channel_id=None,
            limit=MAX_ANALYTICS_CALLS_PER_POLL // ANALYTICS_CALLS_PER_VIDEO + 1)

    def test_the_default_poll_reads_only_the_newest_videos_and_the_widened_one_reads_the_window(self):
        ids = self._store_videos_published(0, 5, 20, 40)
        analytics = self._analytics()
        poller = self._make_poller(analytics_client=analytics)
        self.assertEqual(poller.poll_own_channel_metrics(), 1)
        self.assertEqual([c.args[0] for c in analytics.video_performance.call_args_list], [ids[0]])
        analytics.reset_mock()
        self.assertEqual(poller.poll_own_channel_metrics(days=30, max_calls=600), 3)
        self.assertEqual(sorted(c.args[0] for c in analytics.video_performance.call_args_list), sorted(ids[:3]))

    def test_calls_are_counted_three_per_video_and_reset_each_poll(self):
        self._store_videos_published(0, 1)   # early-life videos: all three calls each
        poller = self._make_poller(analytics_client=self._analytics())
        poller.poll_own_channel_metrics(days=30, max_calls=600)
        self.assertEqual(poller.last_analytics_calls, 2 * ANALYTICS_CALLS_PER_VIDEO)
        poller.poll_own_channel_metrics(days=30, max_calls=600)
        self.assertEqual(poller.last_analytics_calls, 2 * ANALYTICS_CALLS_PER_VIDEO)

    def test_a_video_whose_first_call_fails_is_counted_as_the_one_call_that_was_made(self):
        self._store_videos_published(0)
        analytics = self._analytics()
        analytics.video_performance.side_effect = RuntimeError("quota")
        poller = self._make_poller(analytics_client=analytics)
        self.assertEqual(poller.poll_own_channel_metrics(days=30, max_calls=600), 0)
        self.assertEqual(poller.last_analytics_calls, 1)
        analytics.video_ctr.assert_not_called()

    def test_the_hard_cap_stops_before_a_video_that_would_exceed_it_newest_first_and_says_so(self):
        ids = self._store_videos_published(0, 1, 2, 3, 4)
        analytics = self._analytics()
        poller = self._make_poller(analytics_client=analytics)
        with self.assertLogs("modules.intelligence_poller", level="WARNING") as logs:
            written = poller.poll_own_channel_metrics(days=30, max_calls=7)
        self.assertEqual(written, 2)                     # 2 videos = 6 calls; a third would make 9 > 7
        self.assertEqual(poller.last_analytics_calls, 6)
        self.assertLessEqual(poller.last_analytics_calls, 7)
        self.assertEqual([c.args[0] for c in analytics.video_performance.call_args_list], ids[:2])
        self.assertEqual(len(logs.output), 1, "one warning when the cap is hit, not one per skipped video")
        message = logs.output[0]
        self.assertIn("cap reached", message)
        self.assertIn(METRICS_POLL_DAYS_ENV, message)
        self.assertIn("skipped at least", message)

    def test_a_cap_that_is_exactly_enough_polls_everything_without_a_warning(self):
        self._store_videos_published(0, 1)
        poller = self._make_poller(analytics_client=self._analytics())
        with self.assertLogs("modules.intelligence_poller", level="INFO") as logs:
            self.assertEqual(poller.poll_own_channel_metrics(days=30, max_calls=6), 2)
        self.assertFalse([l for l in logs.output if "WARNING" in l])
        self.assertTrue([l for l in logs.output if "2 video(s) polled" in l and "6 Analytics call(s) (cap 6)" in l])

    def test_the_cap_also_bounds_how_many_videos_are_read_from_the_store(self):
        # list_videos defaults to 100 rows; a widened poll asks for one more than the cap allows so it can see the overflow.
        self._store_videos_published(0, 1, 2, 3)
        analytics = self._analytics()
        poller = self._make_poller(analytics_client=analytics)
        with self.assertLogs("modules.intelligence_poller", level="WARNING"):
            poller.poll_own_channel_metrics(days=30, max_calls=6)      # limit 3 rows, room for 2 videos
        self.assertEqual(analytics.video_performance.call_count, 2)

    def test_a_widened_poll_reads_the_retention_curve_only_for_young_videos(self):
        # A late curve would replace the early one retention_curve() hands to hook_ab, and is ~100 stored points a day.
        ids = self._store_videos_published(0, EARLY_LIFE_DAYS, EARLY_LIFE_DAYS + 1, 40)
        analytics = self._analytics()
        poller = self._make_poller(analytics_client=analytics)
        poller.poll_own_channel_metrics(days=60, max_calls=600)
        self.assertEqual(sorted(c.args[0] for c in analytics.video_retention.call_args_list), sorted(ids[:2]))
        self.assertEqual(analytics.video_performance.call_count, 4)
        self.assertEqual(poller.last_analytics_calls, 2 * 3 + 2 * 2)

    def test_a_widened_poll_files_an_older_videos_reading_apart_so_no_decision_reader_sees_it(self):
        ids = self._store_videos_published(0, EARLY_LIFE_DAYS, EARLY_LIFE_DAYS + 1, 40)
        analytics = self._analytics()
        self._make_poller(analytics_client=analytics).poll_own_channel_metrics(days=60, max_calls=600)
        young, boundary, older, old = ids
        for vid in (young, boundary):
            self.assertIsNotNone(self.store.latest_metrics(vid), vid)
            self.assertEqual(len(self.store.metrics_history(vid)), 1, vid)
        for vid in (older, old):
            self.assertIsNone(self.store.latest_metrics(vid), vid)
            self.assertEqual(self.store.metrics_history(vid), [], vid)
            self.assertEqual(self.store.newest_metrics(vid)["views"], 10, vid)   # still there for the mirror

    def test_the_default_poll_never_files_anything_as_late(self):
        # An old video reached only by an explicit window with no cap (days=None) is still stored the way it always was.
        ids = self._store_videos_published(40)
        self._make_poller(analytics_client=self._analytics()).poll_own_channel_metrics(days=None)
        self.assertIsNotNone(self.store.latest_metrics(ids[0]))

    def test_early_life_is_exactly_what_the_default_poll_reads(self):
        # The default poll reads a video at calendar ages 0..DEFAULT_POLL_DAYS (published since today - 1 day). An age it
        # never reads must not reach the decision readers: a two-day window taken at age 3 would be divided by 3 days.
        self.assertEqual(DEFAULT_POLL_DAYS, 1)
        self.assertEqual(EARLY_LIFE_DAYS, DEFAULT_POLL_DAYS)
        ids = self._store_videos_published(0, 1, 2, 3)
        default_reads = self._analytics()
        self._make_poller(analytics_client=default_reads).poll_own_channel_metrics()
        self.assertEqual(sorted(c.args[0] for c in default_reads.video_performance.call_args_list), sorted(ids[:2]))
        self._make_poller(analytics_client=self._analytics()).poll_own_channel_metrics(days=30, max_calls=600)
        for vid in ids[:2]:
            self.assertIsNotNone(self.store.latest_metrics(vid), vid)
        for vid in ids[2:]:
            self.assertIsNone(self.store.latest_metrics(vid), vid)
            self.assertIsNotNone(self.store.newest_metrics(vid), vid)

    def test_the_default_poll_still_reads_every_curve(self):
        self._store_videos_published(0)
        analytics = self._analytics()
        self._make_poller(analytics_client=analytics).poll_own_channel_metrics()
        self.assertEqual(analytics.video_retention.call_count, 1)

    def test_a_video_with_an_unreadable_publish_date_keeps_its_curve(self):
        self.store.record_video(video_id="odd", title="odd", published_at="2026-13-45")
        analytics = self._analytics()
        self._make_poller(analytics_client=analytics).poll_own_channel_metrics(days=None, max_calls=600)
        self.assertEqual(analytics.video_retention.call_count, 1)

    def test_the_time_budget_stops_the_poll_with_a_warning_that_names_the_variable(self):
        ids = self._store_videos_published(0, 1, 2, 3)
        analytics = self._analytics()
        poller = self._make_poller(analytics_client=analytics)
        clock = iter([0.0, 1.0, 2.0, 700.0, 701.0, 702.0, 703.0, 704.0, 705.0, 706.0])
        with patch("modules.intelligence_poller.time.monotonic", lambda: next(clock)), \
                self.assertLogs("modules.intelligence_poller", level="WARNING") as logs:
            written = poller.poll_own_channel_metrics(days=30, max_calls=600, max_seconds=600)
        self.assertEqual(written, 2)
        self.assertEqual([c.args[0] for c in analytics.video_performance.call_args_list], ids[:2])
        self.assertEqual(len(logs.output), 1)
        self.assertIn("budget 600 s", logs.output[0])
        self.assertIn(METRICS_POLL_DAYS_ENV, logs.output[0])

    def test_no_time_budget_means_no_clock_stop(self):
        self._store_videos_published(0, 1)
        with patch("modules.intelligence_poller.time.monotonic", lambda: 10**9):
            self.assertEqual(self._make_poller(analytics_client=self._analytics()).poll_own_channel_metrics(days=30), 2)

    def test_the_budget_default_is_ten_minutes_and_travels_with_the_options(self):
        self.assertEqual(MAX_METRICS_POLL_SECONDS, 600)
        with patch("modules.intelligence_poller.time.monotonic", lambda: 1000.0):
            self.assertEqual(metrics_poll_options({METRICS_POLL_DAYS_ENV: "7"})["max_seconds"], 600)

    def test_the_ten_minutes_are_one_budget_for_the_whole_run_not_one_per_channel(self):
        # The default channel's poll and every other channel's draw on the same clock, so three channels cannot add up to the
        # job's 30 minutes.
        env = {METRICS_POLL_DAYS_ENV: "7"}
        for now, left in ((1000.0, 600), (1200.0, 400), (1599.0, 1), (1600.0, 0), (5000.0, 0)):
            with patch("modules.intelligence_poller.time.monotonic", lambda now=now: now):
                self.assertEqual(metrics_poll_options(env)["max_seconds"], left, now)

    def test_a_budget_already_spent_stops_the_next_channels_poll_before_its_first_video(self):
        self._store_videos_published(0, 1)
        analytics = self._analytics()
        clock = iter([0.0, 5.0] + [5.0] * 50)
        with patch("modules.intelligence_poller.time.monotonic", lambda: next(clock)), \
                self.assertLogs("modules.intelligence_poller", level="WARNING") as logs:
            written = self._make_poller(analytics_client=analytics).poll_own_channel_metrics(
                days=30, max_calls=600, max_seconds=0.0)
        self.assertEqual(written, 0)
        analytics.video_performance.assert_not_called()
        self.assertEqual(len(logs.output), 1)

    def test_the_run_clock_does_not_start_when_the_variable_is_empty(self):
        with patch("modules.intelligence_poller.time.monotonic", lambda: 50.0):
            self.assertEqual(metrics_poll_options({}), {})
        with patch("modules.intelligence_poller.time.monotonic", lambda: 5000.0):
            self.assertEqual(metrics_poll_options({METRICS_POLL_DAYS_ENV: "7"})["max_seconds"], 600)

    def test_the_budget_warning_names_the_first_skipped_video_ids_and_nothing_else(self):
        ids = self._store_videos_published(*range(0, 12))          # v0d (newest) .. v11d
        poller = self._make_poller(analytics_client=self._analytics())
        clock = iter([0.0, 1.0] + [700.0] * 200)                   # one video polled, then over budget
        with patch("modules.intelligence_poller.time.monotonic", lambda: next(clock)), \
                self.assertLogs("modules.intelligence_poller", level="WARNING") as logs:
            poller.poll_own_channel_metrics(days=30, max_calls=600, max_seconds=600)
        self.assertEqual(len(logs.output), 1)
        self.assertIn("skipped 11 older one(s), first " + ", ".join(ids[1:6]) + ", ...", logs.output[0])
        self.assertNotIn(ids[6], logs.output[0])

    def test_the_call_cap_warning_names_skipped_ids_too(self):
        ids = self._store_videos_published(0, 1, 2)
        poller = self._make_poller(analytics_client=self._analytics())
        with self.assertLogs("modules.intelligence_poller", level="WARNING") as logs:
            poller.poll_own_channel_metrics(days=30, max_calls=4)       # one video fits (3 calls), the second would not
        self.assertIn("first " + ids[1], logs.output[0])

    def test_a_store_list_cut_at_its_limit_is_reported_even_when_quota_errors_keep_the_call_cap_unreached(self):
        # Every video fails on its first call, so each costs 1 call and the cap (6 calls) is never reached; the store
        # returns cap/3 + 1 = 3 rows. Without a check the videos past those 3 would be dropped without a word.
        self._store_videos_published(0, 1, 2, 3, 4)
        analytics = self._analytics()
        analytics.video_performance.side_effect = RuntimeError("quota")
        poller = self._make_poller(analytics_client=analytics)
        with self.assertLogs("modules.intelligence_poller", level="WARNING") as logs:
            poller.poll_own_channel_metrics(days=30, max_calls=6)
        cut = [line for line in logs.output if "hold at least 3 video(s)" in line]
        self.assertEqual(len(cut), 1)
        self.assertIn(METRICS_POLL_DAYS_ENV, cut[0])
        self.assertEqual(poller.last_analytics_calls, 3)

    def test_a_list_that_is_not_cut_gets_no_such_warning(self):
        self._store_videos_published(0, 1)
        poller = self._make_poller(analytics_client=self._analytics())
        with self.assertLogs("modules.intelligence_poller", level="INFO") as logs:
            poller.poll_own_channel_metrics(days=30, max_calls=600)
        self.assertFalse([line for line in logs.output if "at least" in line])

    def test_the_default_poll_has_no_cap_and_logs_no_summary(self):
        self._store_videos_published(0)
        poller = self._make_poller(analytics_client=self._analytics())
        with self.assertNoLogs("modules.intelligence_poller", level="INFO"):
            poller.poll_own_channel_metrics()


if __name__ == "__main__":
    unittest.main()
