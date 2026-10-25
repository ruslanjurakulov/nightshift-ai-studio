"""Tests for modules/state_store.py — uses a throwaway temp SQLite file per test."""

import tempfile
import unittest
from pathlib import Path

from modules.state_store import StateStore


class StateStoreTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_chronos.db"

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_table_creation_is_idempotent(self):
        store1 = StateStore(self.db_path)
        store1.close()
        # Reopening against the same file must not raise, and schema must
        # still be usable (CREATE TABLE IF NOT EXISTS re-runs cleanly).
        store2 = StateStore(self.db_path)
        store2.record_video(video_id="v1", title="Idempotent Test")
        self.assertIsNotNone(store2.get_video("v1"))
        store2.close()

    def test_insert_and_read_video(self):
        with StateStore(self.db_path) as store:
            store.record_video(
                video_id="abc123",
                topic="The Mystery of Roanoke",
                title="What Really Happened to Roanoke?",
                slug="roanoke-mystery",
                published_at="2026-01-15T10:00:00",
                privacy="private",
                category_id="28",
                local_path="/output/roanoke.mp4",
            )
            video = store.get_video("abc123")
            self.assertIsNotNone(video)
            self.assertEqual(video["video_id"], "abc123")
            self.assertEqual(video["topic"], "The Mystery of Roanoke")
            self.assertEqual(video["title"], "What Really Happened to Roanoke?")
            self.assertEqual(video["slug"], "roanoke-mystery")
            self.assertEqual(video["privacy"], "private")
            self.assertEqual(video["category_id"], "28")
            self.assertEqual(video["local_path"], "/output/roanoke.mp4")

    def test_list_videos(self):
        with StateStore(self.db_path) as store:
            store.record_video(video_id="v1", title="First", published_at="2026-01-01T00:00:00")
            store.record_video(video_id="v2", title="Second", published_at="2026-02-01T00:00:00")
            store.record_video(video_id="v3", title="Third", published_at="2026-03-01T00:00:00")

            all_videos = store.list_videos()
            self.assertEqual(len(all_videos), 3)
            # Most recently published first.
            self.assertEqual(all_videos[0]["video_id"], "v3")

            recent = store.list_videos(since="2026-02-01T00:00:00")
            self.assertEqual({v["video_id"] for v in recent}, {"v2", "v3"})

            limited = store.list_videos(limit=1)
            self.assertEqual(len(limited), 1)

    def test_metrics_snapshots_ordered_history(self):
        with StateStore(self.db_path) as store:
            store.record_video(video_id="v1", title="Test Video")
            store.record_metrics_snapshot(
                video_id="v1", snapshot_date="2026-01-03", views=300, likes=30,
                comment_count=3, watch_time_minutes=15.0, average_view_duration_seconds=45.0,
            )
            store.record_metrics_snapshot(
                video_id="v1", snapshot_date="2026-01-01", views=100, likes=10,
                comment_count=1, watch_time_minutes=5.0, average_view_duration_seconds=30.0,
            )
            store.record_metrics_snapshot(
                video_id="v1", snapshot_date="2026-01-02", views=200, likes=20,
                comment_count=2, watch_time_minutes=10.0, average_view_duration_seconds=40.0,
            )

            history = store.metrics_history("v1")
            self.assertEqual(len(history), 3)
            self.assertEqual(
                [row["snapshot_date"] for row in history],
                ["2026-01-01", "2026-01-02", "2026-01-03"],
            )
            self.assertEqual(history[0]["views"], 100)
            self.assertEqual(history[-1]["views"], 300)

    def test_latest_metrics_returns_most_recent(self):
        with StateStore(self.db_path) as store:
            store.record_video(video_id="v1", title="Test Video")
            store.record_metrics_snapshot(video_id="v1", snapshot_date="2026-01-01", views=100)
            store.record_metrics_snapshot(video_id="v1", snapshot_date="2026-01-05", views=500)
            store.record_metrics_snapshot(video_id="v1", snapshot_date="2026-01-03", views=300)

            latest = store.latest_metrics("v1")
            self.assertIsNotNone(latest)
            self.assertEqual(latest["snapshot_date"], "2026-01-05")
            self.assertEqual(latest["views"], 500)

    def test_metrics_snapshot_upsert_same_date(self):
        with StateStore(self.db_path) as store:
            store.record_video(video_id="v1", title="Test Video")
            store.record_metrics_snapshot(video_id="v1", snapshot_date="2026-01-01", views=100)
            store.record_metrics_snapshot(video_id="v1", snapshot_date="2026-01-01", views=150)

            history = store.metrics_history("v1")
            self.assertEqual(len(history), 1)
            self.assertEqual(history[0]["views"], 150)

    def test_metrics_snapshot_stores_none_as_null_not_zero(self):
        with StateStore(self.db_path) as store:
            store.record_video(video_id="v1", title="Test Video")
            store.record_metrics_snapshot(
                video_id="v1", snapshot_date="2026-01-01", views=None, likes=None, comment_count=None,
                watch_time_minutes=None, average_view_duration_seconds=None,
            )
            row = store.latest_metrics("v1")
            for column in ("views", "likes", "comment_count", "watch_time_minutes", "average_view_duration_seconds"):
                self.assertIsNone(row[column], column)

    def test_an_unmeasured_repoll_of_the_same_day_keeps_the_earlier_measurement(self):
        # A second poll on a day when YouTube returned nothing must not wipe what the first one measured.
        with StateStore(self.db_path) as store:
            store.record_video(video_id="v1", title="Test Video")
            store.record_metrics_snapshot(
                video_id="v1", snapshot_date="2026-01-01", views=100, likes=7, comment_count=3,
                watch_time_minutes=50.0, average_view_duration_seconds=30.0,
            )
            store.record_metrics_snapshot(
                video_id="v1", snapshot_date="2026-01-01", views=None, likes=None, comment_count=None,
                watch_time_minutes=None, average_view_duration_seconds=None,
            )
            row = store.latest_metrics("v1")
            self.assertEqual(
                (row["views"], row["likes"], row["comment_count"], row["watch_time_minutes"],
                 row["average_view_duration_seconds"]),
                (100, 7, 3, 50.0, 30.0),
            )

    def test_a_measured_zero_does_overwrite_an_earlier_value(self):
        # Only None means "not measured"; 0 is a reading and wins.
        with StateStore(self.db_path) as store:
            store.record_video(video_id="v1", title="Test Video")
            store.record_metrics_snapshot(video_id="v1", snapshot_date="2026-01-01", views=100, likes=7)
            store.record_metrics_snapshot(video_id="v1", snapshot_date="2026-01-01", views=0, likes=0)
            row = store.latest_metrics("v1")
            self.assertEqual((row["views"], row["likes"]), (0, 0))

    def test_nonexistent_video_returns_none_or_empty(self):
        with StateStore(self.db_path) as store:
            self.assertIsNone(store.get_video("does-not-exist"))
            self.assertIsNone(store.latest_metrics("does-not-exist"))
            self.assertEqual(store.metrics_history("does-not-exist"), [])
            self.assertEqual(store.list_videos(), [])

    # -- competitor snapshots -------------------------------------------------

    def test_competitor_snapshot_insert_and_list(self):
        with StateStore(self.db_path) as store:
            store.record_competitor_snapshot(
                video_id="c1", channel_id="UCabc", polled_date="2026-01-01",
                title="Rival video", view_count=1000, view_velocity=41.7,
            )
            rows = store.list_competitor_snapshots()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["video_id"], "c1")
            self.assertEqual(rows[0]["view_velocity"], 41.7)

    def test_competitor_snapshot_upsert_same_date(self):
        with StateStore(self.db_path) as store:
            store.record_competitor_snapshot(video_id="c1", channel_id="UCabc", polled_date="2026-01-01", view_count=1000)
            store.record_competitor_snapshot(video_id="c1", channel_id="UCabc", polled_date="2026-01-01", view_count=2000)
            rows = store.list_competitor_snapshots()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["view_count"], 2000)

    def test_competitor_snapshot_filters_by_channel(self):
        with StateStore(self.db_path) as store:
            store.record_competitor_snapshot(video_id="c1", channel_id="UCabc", polled_date="2026-01-01")
            store.record_competitor_snapshot(video_id="c2", channel_id="UCdef", polled_date="2026-01-01")
            rows = store.list_competitor_snapshots(channel_id="UCabc")
            self.assertEqual([r["video_id"] for r in rows], ["c1"])

    def test_competitor_snapshot_filters_by_since(self):
        with StateStore(self.db_path) as store:
            store.record_competitor_snapshot(video_id="c1", channel_id="UCabc", polled_date="2026-01-01")
            store.record_competitor_snapshot(video_id="c2", channel_id="UCabc", polled_date="2026-01-05")
            rows = store.list_competitor_snapshots(since="2026-01-03")
            self.assertEqual([r["video_id"] for r in rows], ["c2"])

    # -- trending snapshots -----------------------------------------------------

    def test_trending_snapshot_insert_and_list(self):
        with StateStore(self.db_path) as store:
            store.record_trending_snapshot(video_id="t1", polled_date="2026-01-01", title="Trending!", region_code="US")
            rows = store.list_trending_snapshots()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["region_code"], "US")

    def test_trending_snapshot_same_video_multiple_regions(self):
        with StateStore(self.db_path) as store:
            store.record_trending_snapshot(video_id="t1", polled_date="2026-01-01", region_code="US")
            store.record_trending_snapshot(video_id="t1", polled_date="2026-01-01", region_code="GB")
            rows = store.list_trending_snapshots()
            self.assertEqual(len(rows), 2)

    def test_trending_snapshot_upsert_same_video_date_region(self):
        with StateStore(self.db_path) as store:
            store.record_trending_snapshot(video_id="t1", polled_date="2026-01-01", region_code="US", view_count=100)
            store.record_trending_snapshot(video_id="t1", polled_date="2026-01-01", region_code="US", view_count=200)
            rows = store.list_trending_snapshots()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["view_count"], 200)

    # -- demand signals -----------------------------------------------------

    def test_demand_signal_insert_and_list(self):
        with StateStore(self.db_path) as store:
            store.record_demand_signal(topic_phrase="cover Genghis Khan", mention_count=5, polled_date="2026-01-01", example_comment_ids="0,3,7")
            rows = store.list_demand_signals()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["mention_count"], 5)

    def test_demand_signal_append_only_no_upsert(self):
        # Unlike the snapshot tables, repeated polls on the same date are
        # NOT collapsed — each poll's clustering result is kept.
        with StateStore(self.db_path) as store:
            store.record_demand_signal(topic_phrase="cover Genghis Khan", mention_count=5, polled_date="2026-01-01")
            store.record_demand_signal(topic_phrase="cover Genghis Khan", mention_count=7, polled_date="2026-01-01")
            rows = store.list_demand_signals()
            self.assertEqual(len(rows), 2)

    def test_demand_signal_filters_by_since(self):
        with StateStore(self.db_path) as store:
            store.record_demand_signal(topic_phrase="a", mention_count=1, polled_date="2026-01-01")
            store.record_demand_signal(topic_phrase="b", mention_count=1, polled_date="2026-01-05")
            rows = store.list_demand_signals(since="2026-01-03")
            self.assertEqual([r["topic_phrase"] for r in rows], ["b"])

    # -- feedback signals --------------------------------------------------

    def test_feedback_signal_insert_and_list(self):
        with StateStore(self.db_path) as store:
            store.record_feedback_signal(
                video_id="v1", signal="HIGH_RETENTION", analyzed_date="2026-01-01",
                topic="Rome", metric_value=120.0, channel_baseline=75.0, detail="1.60x channel average",
            )
            rows = store.list_feedback_signals()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["signal"], "HIGH_RETENTION")
            self.assertEqual(rows[0]["topic"], "Rome")

    def test_feedback_signal_upserts_on_same_video_signal_date(self):
        with StateStore(self.db_path) as store:
            store.record_feedback_signal(video_id="v1", signal="HIGH_RETENTION", analyzed_date="2026-01-01", metric_value=100.0)
            store.record_feedback_signal(video_id="v1", signal="HIGH_RETENTION", analyzed_date="2026-01-01", metric_value=200.0)
            rows = store.list_feedback_signals()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["metric_value"], 200.0)

    def test_feedback_signal_filters_by_since(self):
        with StateStore(self.db_path) as store:
            store.record_feedback_signal(video_id="v1", signal="LOW_ENGAGEMENT", analyzed_date="2026-01-01")
            store.record_feedback_signal(video_id="v2", signal="HIGH_ENGAGEMENT", analyzed_date="2026-01-05")
            rows = store.list_feedback_signals(since="2026-01-03")
            self.assertEqual([r["video_id"] for r in rows], ["v2"])

    # -- topic performance -------------------------------------------------

    def test_topic_performance_upsert_and_get(self):
        with StateStore(self.db_path) as store:
            store.upsert_topic_performance(topic="Rome", score=88.0, videos_analyzed=3, updated_at="2026-01-01", reason="strong")
            row = store.get_topic_performance("Rome")
            self.assertEqual(row["score"], 88.0)
            self.assertEqual(row["videos_analyzed"], 3)
            self.assertIsNone(store.get_topic_performance("Nonexistent"))

    def test_topic_performance_upsert_overwrites(self):
        with StateStore(self.db_path) as store:
            store.upsert_topic_performance(topic="Rome", score=50.0, videos_analyzed=1, updated_at="2026-01-01")
            store.upsert_topic_performance(topic="Rome", score=90.0, videos_analyzed=4, updated_at="2026-01-05", reason="improved")
            row = store.get_topic_performance("Rome")
            self.assertEqual(row["score"], 90.0)
            self.assertEqual(row["videos_analyzed"], 4)
            self.assertEqual(len(store.list_topic_performance()), 1)

    def test_topic_performance_list_orders_by_score_desc(self):
        with StateStore(self.db_path) as store:
            store.upsert_topic_performance(topic="Low", score=20.0, videos_analyzed=1, updated_at="2026-01-01")
            store.upsert_topic_performance(topic="High", score=95.0, videos_analyzed=1, updated_at="2026-01-01")
            store.upsert_topic_performance(topic="Mid", score=55.0, videos_analyzed=1, updated_at="2026-01-01")
            rows = store.list_topic_performance()
            self.assertEqual([r["topic"] for r in rows], ["High", "Mid", "Low"])


if __name__ == "__main__":
    unittest.main()
