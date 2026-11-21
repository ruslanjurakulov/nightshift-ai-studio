"""Spend forecast: a straight-line projection of month-end spend from
month-to-date spend. Advisory — it forecasts and flags an on-track-to-blow
ceiling, but never blocks. Rules: unknown projection never counts as exceeding,
and the projection is None (not a fabricated number) when no time has elapsed."""

import unittest
from datetime import datetime, timezone

from modules.budget import SpendForecast, forecast_month_end, project_spend


class _FakeStore:
    def __init__(self, rows):
        self._rows = rows

    def list_video_costs(self, channel_id=None, limit=1000):
        return [r for r in self._rows if channel_id is None or r.get("channel_id") == channel_id]


class ProjectSpendTestCase(unittest.TestCase):
    def test_straight_line(self):
        # $30 over 10 days of a 30-day month → $90 projected.
        self.assertEqual(project_spend(30.0, 10, 30), 90.0)

    def test_zero_elapsed_is_none(self):
        self.assertIsNone(project_spend(30.0, 0, 30))

    def test_bad_inputs_none(self):
        self.assertIsNone(project_spend("x", 10, 30))
        self.assertIsNone(project_spend(1.0, 10, 0))


class ForecastMonthEndTestCase(unittest.TestCase):
    def _store(self, *amounts, month="2026-09"):
        return _FakeStore([
            {"channel_id": "c", "estimated_usd": a, "recorded_at": f"{month}-05T00:00:00"}
            for a in amounts
        ])

    def test_projects_month_end(self):
        now = datetime(2026, 9, 10, tzinfo=timezone.utc)  # 10 days elapsed of 30
        store = self._store(10.0, 20.0)                   # $30 month-to-date
        fc = forecast_month_end(store, "c", ceiling_usd=None, now=now)
        self.assertEqual(fc.spent_usd, 30.0)
        self.assertEqual(fc.elapsed_days, 10)
        self.assertEqual(fc.days_in_month, 30)
        self.assertEqual(fc.projected_usd, 90.0)
        self.assertFalse(fc.projected_exceeds)  # no ceiling

    def test_flags_on_track_to_blow_ceiling(self):
        now = datetime(2026, 9, 10, tzinfo=timezone.utc)
        store = self._store(30.0)                          # $30 in 10 days → $90 projected
        fc = forecast_month_end(store, "c", ceiling_usd=50.0, now=now)
        self.assertTrue(fc.projected_exceeds)              # 90 >= 50

    def test_under_pace_does_not_flag(self):
        now = datetime(2026, 9, 10, tzinfo=timezone.utc)
        store = self._store(5.0)                           # $5 in 10 days → $15 projected
        fc = forecast_month_end(store, "c", ceiling_usd=100.0, now=now)
        self.assertFalse(fc.projected_exceeds)

    def test_unknown_projection_never_exceeds(self):
        # A forecast with no elapsed days can't project; it must not false-alarm.
        fc = SpendForecast(channel_id="c", spent_usd=0.0, elapsed_days=0, days_in_month=30,
                           projected_usd=None, ceiling_usd=1.0, has_unpriced=False)
        self.assertFalse(fc.projected_exceeds)

    def test_serializable(self):
        now = datetime(2026, 9, 10, tzinfo=timezone.utc)
        d = forecast_month_end(self._store(10.0), "c", ceiling_usd=50.0, now=now).to_dict()
        self.assertEqual(set(d) >= {"projected_usd", "ceiling_usd", "projected_exceeds"}, True)

    def test_read_failure_is_safe(self):
        class Boom:
            def list_video_costs(self, channel_id=None, limit=1000):
                raise RuntimeError("db down")
        fc = forecast_month_end(Boom(), "c", ceiling_usd=10.0,
                                now=datetime(2026, 9, 10, tzinfo=timezone.utc))
        self.assertEqual(fc.spent_usd, 0.0)  # degrades to zero, never raises


if __name__ == "__main__":
    unittest.main()
