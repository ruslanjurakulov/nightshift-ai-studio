"""Tests for modules/topic_recommender.py.

Uses a real StateStore against a tempdir SQLite file (to exercise the real
read path) plus a real ContentOpportunityEngine (pure computation, no
external calls needed), matching the style of tests/test_intelligence_poller.py.
"""

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from modules.content_opportunity import ContentOpportunityEngine
from modules.state_store import StateStore
from modules.topic_recommender import TopicRecommender


class TopicRecommenderTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_chronos.db"
        self.store = StateStore(self.db_path)

    def tearDown(self):
        self.store.close()
        self._tmpdir.cleanup()

    def _make_recommender(self, state_store=None, engine=None):
        return TopicRecommender(
            state_store=state_store if state_store is not None else self.store,
            engine=engine if engine is not None else ContentOpportunityEngine(),
        )

    # -- empty database ------------------------------------------------- #

    def test_empty_database_returns_empty_list(self):
        recommender = self._make_recommender()
        self.assertEqual(recommender.suggest_topics(), [])

    def test_empty_database_returns_empty_prompt_text(self):
        recommender = self._make_recommender()
        self.assertEqual(recommender.suggest_topics_as_prompt_text(), "")

    # -- basic ranking from trending + demand ---------------------------- #

    def test_trending_and_demand_rows_produce_ranked_result(self):
        recent = datetime.now(timezone.utc) - timedelta(hours=2)
        self.store.record_trending_snapshot(
            video_id="tv1",
            polled_date=datetime.now(timezone.utc).date().isoformat(),
            title="Ancient Roman Mysteries",
            view_count=120000,
            like_count=8000,
            comment_count=500,
            published_at=recent.isoformat(),
            region_code="US",
            category_id="24",
        )
        self.store.record_demand_signal(
            topic_phrase="Ancient Roman Mysteries",
            mention_count=15,
            polled_date=datetime.now(timezone.utc).date().isoformat(),
            example_comment_ids="c1,c2",
        )

        recommender = self._make_recommender()
        results = recommender.suggest_topics(limit=5)

        self.assertTrue(len(results) >= 1)
        self.assertEqual(results[0].topic, "Ancient Roman Mysteries")
        self.assertEqual(results[0].source, "both")

    # -- competitor snapshots contribute to the trend side --------------- #

    def test_competitor_snapshots_merge_into_trend_side(self):
        recent = datetime.now(timezone.utc) - timedelta(hours=3)
        self.store.record_competitor_snapshot(
            video_id="cv1",
            channel_id="rival_channel",
            polled_date=datetime.now(timezone.utc).date().isoformat(),
            title="Forbidden Pyramid Chambers",
            view_count=50000,
            like_count=3000,
            comment_count=100,
            published_at=recent.isoformat(),
            view_velocity=16666.0,
        )

        recommender = self._make_recommender()
        results = recommender.suggest_topics(limit=5)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].topic, "Forbidden Pyramid Chambers")
        # Competitor-only, no matching demand row -> trend-derived candidate.
        self.assertEqual(results[0].source, "trend")

    # -- prompt text rendering -------------------------------------------- #

    def test_prompt_text_includes_topic_score_and_rationale(self):
        recent = datetime.now(timezone.utc) - timedelta(hours=1)
        self.store.record_trending_snapshot(
            video_id="tv2",
            polled_date=datetime.now(timezone.utc).date().isoformat(),
            title="Lost Civilizations Explained",
            view_count=60000,
            like_count=4000,
            comment_count=250,
            published_at=recent.isoformat(),
            region_code="US",
            category_id="24",
        )

        recommender = self._make_recommender()
        text = recommender.suggest_topics_as_prompt_text(limit=5)

        self.assertIn("Lost Civilizations Explained", text)
        self.assertIn("score", text)
        self.assertIn("views/hr", text)
        self.assertIn("not mandatory", text)

    # -- since filtering ---------------------------------------------------- #

    def test_since_filters_out_older_rows(self):
        today = datetime.now(timezone.utc).date()
        old_date = (today - timedelta(days=30)).isoformat()
        recent_date = today.isoformat()

        self.store.record_trending_snapshot(
            video_id="old_vid",
            polled_date=old_date,
            title="Old Stale Topic",
            view_count=10000,
            published_at=(datetime.now(timezone.utc) - timedelta(days=30, hours=1)).isoformat(),
            region_code="US",
        )
        self.store.record_trending_snapshot(
            video_id="new_vid",
            polled_date=recent_date,
            title="Fresh Recent Topic",
            view_count=10000,
            published_at=(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
            region_code="US",
        )

        recommender = self._make_recommender()
        cutoff = (today - timedelta(days=1)).isoformat()
        results = recommender.suggest_topics(limit=10, since=cutoff)

        topics = [r.topic for r in results]
        self.assertIn("Fresh Recent Topic", topics)
        self.assertNotIn("Old Stale Topic", topics)

    # -- defensive degradation -------------------------------------------- #

    def test_state_store_construction_failure_degrades_gracefully(self):
        with patch("modules.state_store.StateStore") as MockStateStore:
            MockStateStore.side_effect = RuntimeError("simulated disk failure")
            recommender = TopicRecommender(state_store=None, engine=ContentOpportunityEngine())

        self.assertEqual(recommender.suggest_topics(), [])
        self.assertEqual(recommender.suggest_topics_as_prompt_text(), "")

    def test_state_store_query_failure_degrades_gracefully(self):
        class RaisingStateStore:
            def list_trending_snapshots(self, since=None, limit=200):
                raise RuntimeError("simulated query failure")

            def list_competitor_snapshots(self, channel_id=None, since=None, limit=200):
                raise RuntimeError("simulated query failure")

            def list_demand_signals(self, since=None, limit=200):
                raise RuntimeError("simulated query failure")

        recommender = TopicRecommender(
            state_store=RaisingStateStore(), engine=ContentOpportunityEngine()
        )

        self.assertEqual(recommender.suggest_topics(), [])
        self.assertEqual(recommender.suggest_topics_as_prompt_text(), "")


if __name__ == "__main__":
    unittest.main()
