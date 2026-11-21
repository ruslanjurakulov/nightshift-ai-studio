"""Tests for modules/performance_analyzer.py.

Uses a real StateStore against a tempdir SQLite file, seeded via its actual
record_video/record_metrics_snapshot methods (pure local computation over
real rows, no mocking of the analysis itself) -- matching the style of
tests/test_topic_recommender.py and tests/test_intelligence_poller.py.
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from modules.performance_analyzer import PerformanceAnalyzer, VideoPerformance
from modules.state_store import StateStore


class PerformanceAnalyzerTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_chronos.db"
        self.store = StateStore(self.db_path)

    def tearDown(self):
        self.store.close()
        self._tmpdir.cleanup()

    def _make_analyzer(self, state_store=None):
        return PerformanceAnalyzer(state_store=state_store if state_store is not None else self.store)

    # -- empty database ------------------------------------------------- #

    def test_empty_database_analyze_videos_returns_empty_list(self):
        analyzer = self._make_analyzer()
        self.assertEqual(analyzer.analyze_videos(), [])

    def test_empty_database_average_views_per_day_returns_zero(self):
        analyzer = self._make_analyzer()
        self.assertEqual(analyzer.average_views_per_day(), 0.0)

    def test_empty_database_prompt_text_returns_empty_string(self):
        analyzer = self._make_analyzer()
        self.assertEqual(analyzer.analyze_videos_as_prompt_text(), "")

    # -- video with no metrics yet is omitted, not an error --------------- #

    def test_video_with_no_metrics_is_omitted(self):
        self.store.record_video(
            video_id="v_no_metrics",
            topic="Lost Cities",
            title="The Lost City of Z",
            published_at="2026-08-20T00:00:00",
        )
        analyzer = self._make_analyzer()
        results = analyzer.analyze_videos()
        self.assertEqual(results, [])

    def test_video_with_no_metrics_alongside_video_with_metrics(self):
        self.store.record_video(
            video_id="v_no_metrics",
            topic="Lost Cities",
            title="The Lost City of Z",
            published_at="2026-08-20T00:00:00",
        )
        self.store.record_video(
            video_id="v_has_metrics",
            topic="Ancient Rome",
            title="Fall of Rome",
            published_at="2026-08-20T00:00:00",
        )
        self.store.record_metrics_snapshot(
            video_id="v_has_metrics",
            snapshot_date="2026-08-25",
            views=500,
            likes=20,
            comment_count=5,
            watch_time_minutes=100.0,
            average_view_duration_seconds=60.0,
        )
        analyzer = self._make_analyzer()
        results = analyzer.analyze_videos()
        video_ids = [vp.video_id for vp in results]
        self.assertIn("v_has_metrics", video_ids)
        self.assertNotIn("v_no_metrics", video_ids)

    # -- views_per_day arithmetic ------------------------------------------ #

    def test_views_per_day_computed_correctly_for_n_days(self):
        self.store.record_video(
            video_id="v1",
            topic="Ancient Rome",
            title="Fall of Rome",
            published_at="2026-08-20T00:00:00",
        )
        # Published 2026-08-20, measured 2026-08-25 -> 5 elapsed days.
        self.store.record_metrics_snapshot(
            video_id="v1",
            snapshot_date="2026-08-25",
            views=500,
            likes=20,
            comment_count=5,
            watch_time_minutes=100.0,
            average_view_duration_seconds=60.0,
        )
        analyzer = self._make_analyzer()
        results = analyzer.analyze_videos()
        self.assertEqual(len(results), 1)
        vp = results[0]
        self.assertIsInstance(vp, VideoPerformance)
        self.assertEqual(vp.latest_views, 500)
        self.assertAlmostEqual(vp.views_per_day, 500 / 5)
        self.assertEqual(vp.topic, "Ancient Rome")
        self.assertEqual(vp.latest_watch_time_minutes, 100.0)
        self.assertEqual(vp.latest_average_view_duration_seconds, 60.0)

    def test_same_day_published_video_does_not_raise_and_is_smoothed(self):
        self.store.record_video(
            video_id="v_same_day",
            topic="Breaking News Topic",
            title="Just Published",
            published_at="2026-08-25T00:00:00",
        )
        self.store.record_metrics_snapshot(
            video_id="v_same_day",
            snapshot_date="2026-08-25",
            views=42,
            likes=1,
            comment_count=0,
            watch_time_minutes=5.0,
            average_view_duration_seconds=30.0,
        )
        analyzer = self._make_analyzer()
        # Should not raise ZeroDivisionError.
        results = analyzer.analyze_videos()
        self.assertEqual(len(results), 1)
        # Day-zero smoothing: denominator floored to 1, so views_per_day == views.
        self.assertAlmostEqual(results[0].views_per_day, 42.0)

    # -- top_performers / underperformers ---------------------------------- #

    def _seed_five_videos(self):
        # views_per_day, by construction (published same day as measured,
        # so denominator is floored to 1 and views_per_day == views):
        # v1: 100, v2: 200, v3: 300, v4: 400, v5: 500
        for i, views in enumerate([100, 200, 300, 400, 500], start=1):
            vid = f"v{i}"
            self.store.record_video(
                video_id=vid,
                topic=f"Topic {i}",
                title=f"Title {i}",
                published_at="2026-08-25T00:00:00",
            )
            self.store.record_metrics_snapshot(
                video_id=vid,
                snapshot_date="2026-08-25",
                views=views,
                likes=0,
                comment_count=0,
                watch_time_minutes=0.0,
                average_view_duration_seconds=0.0,
            )

    def test_top_performers_sorted_and_sliced(self):
        self._seed_five_videos()
        analyzer = self._make_analyzer()
        top = analyzer.top_performers(n=2)
        self.assertEqual([vp.video_id for vp in top], ["v5", "v4"])

    def test_underperformers_sorted_and_sliced(self):
        self._seed_five_videos()
        analyzer = self._make_analyzer()
        bottom = analyzer.underperformers(n=2)
        self.assertEqual([vp.video_id for vp in bottom], ["v1", "v2"])

    def test_top_and_underperformers_are_mirrors(self):
        self._seed_five_videos()
        analyzer = self._make_analyzer()
        all_ranked = analyzer.analyze_videos()
        self.assertEqual(len(all_ranked), 5)

        top = analyzer.top_performers(n=5)
        bottom = analyzer.underperformers(n=5)

        self.assertEqual(top, all_ranked)
        # underperformers is ascending-by-views_per_day; reversing it gives
        # descending order, i.e. the same order as top_performers.
        self.assertEqual(list(reversed(bottom)), top)

    # -- average_views_per_day ---------------------------------------------- #

    def test_average_views_per_day(self):
        self._seed_five_videos()
        analyzer = self._make_analyzer()
        avg = analyzer.average_views_per_day()
        self.assertAlmostEqual(avg, (100 + 200 + 300 + 400 + 500) / 5)

    # -- prompt text rendering ------------------------------------------------ #

    def test_prompt_text_below_threshold_returns_empty_string(self):
        self.store.record_video(
            video_id="only_one",
            topic="Solo Topic",
            title="Solo Title",
            published_at="2026-08-20T00:00:00",
        )
        self.store.record_metrics_snapshot(
            video_id="only_one",
            snapshot_date="2026-08-25",
            views=500,
            likes=0,
            comment_count=0,
            watch_time_minutes=0.0,
            average_view_duration_seconds=0.0,
        )
        analyzer = self._make_analyzer()
        # Exactly one video with metrics -- below the documented threshold of 2.
        self.assertEqual(len(analyzer.analyze_videos()), 1)
        self.assertEqual(analyzer.analyze_videos_as_prompt_text(), "")

    def test_prompt_text_at_threshold_returns_content(self):
        self.store.record_video(
            video_id="v_a",
            topic="Solo Topic A",
            title="Solo Title A",
            published_at="2026-08-20T00:00:00",
        )
        self.store.record_metrics_snapshot(
            video_id="v_a",
            snapshot_date="2026-08-25",
            views=500,
            likes=0,
            comment_count=0,
            watch_time_minutes=0.0,
            average_view_duration_seconds=0.0,
        )
        self.store.record_video(
            video_id="v_b",
            topic="Solo Topic B",
            title="Solo Title B",
            published_at="2026-08-20T00:00:00",
        )
        self.store.record_metrics_snapshot(
            video_id="v_b",
            snapshot_date="2026-08-25",
            views=1000,
            likes=0,
            comment_count=0,
            watch_time_minutes=0.0,
            average_view_duration_seconds=0.0,
        )
        analyzer = self._make_analyzer()
        # Exactly two videos with metrics -- at the documented threshold.
        self.assertEqual(len(analyzer.analyze_videos()), 2)
        text = analyzer.analyze_videos_as_prompt_text()
        self.assertNotEqual(text, "")
        self.assertIn("Solo Topic B", text)  # higher views/day -> top performer
        self.assertIn("200.0", text)  # 1000 views / 5 days = 200.0 views/day
        self.assertIn("not a formula to copy", text)

    def test_prompt_text_includes_topic_and_views_per_day(self):
        self.store.record_video(
            video_id="v1",
            topic="Ancient Rome Secrets",
            title="The Fall of Rome",
            published_at="2026-08-20T00:00:00",
        )
        self.store.record_metrics_snapshot(
            video_id="v1",
            snapshot_date="2026-08-25",
            views=500,
            likes=0,
            comment_count=0,
            watch_time_minutes=0.0,
            average_view_duration_seconds=0.0,
        )
        self.store.record_video(
            video_id="v2",
            topic="Medieval Mysteries",
            title="Castles Explained",
            published_at="2026-08-20T00:00:00",
        )
        self.store.record_metrics_snapshot(
            video_id="v2",
            snapshot_date="2026-08-25",
            views=250,
            likes=0,
            comment_count=0,
            watch_time_minutes=0.0,
            average_view_duration_seconds=0.0,
        )
        analyzer = self._make_analyzer()
        text = analyzer.analyze_videos_as_prompt_text()
        self.assertIn("Ancient Rome Secrets", text)
        self.assertIn("100.0", text)  # 500 / 5 = 100.0 views/day

    # -- defensive degradation ---------------------------------------------- #

    def test_state_store_construction_failure_degrades_gracefully(self):
        with patch("modules.state_store.StateStore") as MockStateStore:
            MockStateStore.side_effect = RuntimeError("simulated disk failure")
            analyzer = PerformanceAnalyzer(state_store=None)

        self.assertIsNone(analyzer.state_store)
        self.assertEqual(analyzer.analyze_videos(), [])
        self.assertEqual(analyzer.top_performers(), [])
        self.assertEqual(analyzer.underperformers(), [])
        self.assertEqual(analyzer.average_views_per_day(), 0.0)
        self.assertEqual(analyzer.analyze_videos_as_prompt_text(), "")

    def test_injected_state_store_that_raises_on_every_call_degrades_gracefully(self):
        class RaisingStateStore:
            def list_videos(self, limit=100, since=None):
                raise RuntimeError("simulated query failure")

            def latest_metrics(self, video_id):
                raise RuntimeError("simulated query failure")

        analyzer = PerformanceAnalyzer(state_store=RaisingStateStore())

        self.assertEqual(analyzer.analyze_videos(), [])
        self.assertEqual(analyzer.top_performers(), [])
        self.assertEqual(analyzer.underperformers(), [])
        self.assertEqual(analyzer.average_views_per_day(), 0.0)
        self.assertEqual(analyzer.analyze_videos_as_prompt_text(), "")


if __name__ == "__main__":
    unittest.main()
