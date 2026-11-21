"""Tests for modules/feedback_engine.py — the closed feedback loop.

Uses a real tempdir StateStore seeded with real video + metrics rows via its
actual record_video/record_metrics_snapshot methods, so the signal derivation
and scoring run as pure computation over real persisted data (matching the
style of tests/test_performance_analyzer.py). No metric is invented.
"""

import tempfile
import unittest
from pathlib import Path

from modules.feedback_engine import FeedbackEngine
from modules.state_store import StateStore


class FeedbackEngineTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_chronos.db"
        self.store = StateStore(self.db_path)

    def tearDown(self):
        self.store.close()
        self._tmpdir.cleanup()

    def _seed(self, video_id, topic, published, snapshot, views, likes, comments, avd):
        self.store.record_video(video_id=video_id, topic=topic, title=topic, published_at=published)
        self.store.record_metrics_snapshot(
            video_id=video_id,
            snapshot_date=snapshot,
            views=views,
            likes=likes,
            comment_count=comments,
            watch_time_minutes=0.0,
            average_view_duration_seconds=avd,
        )

    def _seed_high_and_low(self):
        # A "Rome" video, 10 days, 1000 views -> 100 views/day, high engagement
        # and retention; a "Egypt" video, 10 days, 100 views -> 10 views/day,
        # low on every dimension. Channel averages sit between them, so A lands
        # above the +20% band on all three and B below the -20% band on all three.
        self._seed("A", "Rome", "2026-08-20T00:00:00", "2026-08-30", 1000, 100, 50, 120.0)
        self._seed("B", "Egypt", "2026-08-20T00:00:00", "2026-08-30", 100, 1, 0, 30.0)

    # -- empty / insufficient ---------------------------------------------

    def test_empty_store_scores_nothing(self):
        summary = FeedbackEngine(state_store=self.store).run()
        self.assertEqual(summary, {"videos_analyzed": 0, "signals_recorded": 0, "topics_scored": 0})

    def test_single_video_is_below_channel_average_threshold(self):
        self._seed("only", "Rome", "2026-08-20T00:00:00", "2026-08-30", 500, 10, 5, 60.0)
        summary = FeedbackEngine(state_store=self.store).run()
        # One video with metrics is analyzed, but there's no channel average to
        # compare it against, so nothing is scored or signalled.
        self.assertEqual(summary["videos_analyzed"], 1)
        self.assertEqual(summary["signals_recorded"], 0)
        self.assertEqual(summary["topics_scored"], 0)
        self.assertEqual(self.store.list_topic_performance(), [])

    # -- real signal derivation -------------------------------------------

    def test_high_and_low_videos_produce_opposite_signals(self):
        self._seed_high_and_low()
        summary = FeedbackEngine(state_store=self.store).run()

        self.assertEqual(summary["videos_analyzed"], 2)
        self.assertEqual(summary["signals_recorded"], 6)  # 3 high (A) + 3 low (B)
        self.assertEqual(summary["topics_scored"], 2)

        signals = {(s["video_id"], s["signal"]) for s in self.store.list_feedback_signals()}
        self.assertIn(("A", "HIGH_VIEW_VELOCITY"), signals)
        self.assertIn(("A", "HIGH_ENGAGEMENT"), signals)
        self.assertIn(("A", "HIGH_RETENTION"), signals)
        self.assertIn(("B", "LOW_VIEW_VELOCITY"), signals)
        self.assertIn(("B", "LOW_ENGAGEMENT"), signals)
        self.assertIn(("B", "LOW_RETENTION"), signals)

    def test_topic_scores_reflect_relative_performance(self):
        self._seed_high_and_low()
        FeedbackEngine(state_store=self.store).run()

        rome = self.store.get_topic_performance("Rome")
        egypt = self.store.get_topic_performance("Egypt")
        self.assertIsNotNone(rome)
        self.assertIsNotNone(egypt)
        # 50 == channel average; the over-performer is well above it, the
        # under-performer well below.
        self.assertGreater(rome["score"], 50)
        self.assertLess(egypt["score"], 50)
        self.assertGreater(rome["score"], egypt["score"])
        # The stored reason is generated from the real ratios, not a canned string.
        self.assertIn("channel avg", rome["reason"])
        self.assertIn("video(s)", rome["reason"])

    def test_rerun_same_day_overwrites_not_duplicates(self):
        self._seed_high_and_low()
        engine = FeedbackEngine(state_store=self.store)
        engine.run()
        first = len(self.store.list_feedback_signals())
        engine.run()  # same analyzed_date -> upserts, no growth
        self.assertEqual(len(self.store.list_feedback_signals()), first)
        self.assertEqual(len(self.store.list_topic_performance()), 2)

    # -- prompt rendering --------------------------------------------------

    def test_prompt_text_empty_before_any_run(self):
        self.assertEqual(FeedbackEngine(state_store=self.store).topic_scores_as_prompt_text(), "")

    def test_prompt_text_lists_scored_topics_after_run(self):
        self._seed_high_and_low()
        engine = FeedbackEngine(state_store=self.store)
        engine.run()
        text = engine.topic_scores_as_prompt_text()
        self.assertIn("Rome", text)
        self.assertIn("Egypt", text)
        self.assertIn("not a rule", text)  # honesty framing present

    # -- defensive degradation --------------------------------------------

    def test_construction_failure_degrades_to_noop(self):
        from unittest.mock import patch

        with patch("modules.state_store.StateStore", side_effect=RuntimeError("disk full")):
            engine = FeedbackEngine(state_store=None)
        self.assertIsNone(engine.state_store)
        self.assertEqual(engine.run(), {"videos_analyzed": 0, "signals_recorded": 0, "topics_scored": 0})
        self.assertEqual(engine.topic_scores_as_prompt_text(), "")

    def test_injected_store_that_raises_degrades_to_noop(self):
        class RaisingStore:
            def list_videos(self, limit=100, since=None):
                raise RuntimeError("query failure")

            def list_topic_performance(self, limit=200):
                raise RuntimeError("query failure")

        engine = FeedbackEngine(state_store=RaisingStore())
        self.assertEqual(engine.run(), {"videos_analyzed": 0, "signals_recorded": 0, "topics_scored": 0})
        self.assertEqual(engine.topic_scores_as_prompt_text(), "")


if __name__ == "__main__":
    unittest.main()
