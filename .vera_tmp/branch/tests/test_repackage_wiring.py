"""The repackage advisory, wired through the intelligence poller: it reads the
channel's videos and their latest metrics, flags below-median CTR videos, and is
called by run_all. Uses a real in-memory StateStore with mocked network clients,
so no live API calls."""

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

from modules.intelligence_poller import IntelligencePoller
from modules.state_store import StateStore


def _days_ago(n):
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


class SuggestRepackagesTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self._tmp.name) / "t.db")

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def _poller(self):
        return IntelligencePoller(
            state_store=self.store,
            analytics_client=MagicMock(),
            competitor_monitor=MagicMock(),
            trend_detector=MagicMock(),
        )

    def _add(self, vid, ctr, impressions, days_old=30):
        self.store.record_video(video_id=vid, topic="T", title=vid, published_at=_days_ago(days_old))
        self.store.record_metrics_snapshot(
            video_id=vid, snapshot_date=_days_ago(1), views=1000,
            impressions=impressions, impression_ctr=ctr)

    def test_flags_below_median_and_returns_count(self):
        self._add("a", 0.10, 2000)
        self._add("b", 0.10, 2000)
        self._add("c", 0.10, 2000)
        self._add("weak", 0.03, 2000)
        self.assertEqual(self._poller().suggest_repackages(), 1)

    def test_no_candidates_returns_zero(self):
        self._add("a", 0.10, 2000)
        self._add("b", 0.10, 2000)
        self._add("c", 0.10, 2000)
        self.assertEqual(self._poller().suggest_repackages(), 0)

    def test_empty_store_is_zero(self):
        self.assertEqual(self._poller().suggest_repackages(), 0)

    def test_run_all_reports_repackage_candidates(self):
        self._add("a", 0.10, 2000)
        self._add("b", 0.10, 2000)
        self._add("c", 0.10, 2000)
        self._add("weak", 0.03, 2000)
        summary = self._poller().run_all()
        self.assertIn("repackage_candidates", summary)
        self.assertEqual(summary["repackage_candidates"], 1)


if __name__ == "__main__":
    unittest.main()
