"""Spend overview (roadmap #53) — pure, offline.

Pins the ledger's discipline across the aggregation: USD only when priced
(null ≠ 0), a unit that is partly unpriced reports no dollars, "videos
remaining" appears only when a ceiling AND a real average exist, and the
All-Accounts total sums only the channels with a known spend."""

import unittest
from datetime import datetime, timezone

from modules import spend_overview as so

NOW = datetime(2026, 6, 15, tzinfo=timezone.utc)
IN_MONTH = "2026-06-10T00:00:00+00:00"
LAST_MONTH = "2026-05-20T00:00:00+00:00"


class _FakeStore:
    def __init__(self, rows_by_channel):
        self._rows = rows_by_channel

    def list_video_costs(self, channel_id=None, limit=100):
        return self._rows.get(channel_id, [])


def _row(video_id, unit, quantity, usd, recorded_at=IN_MONTH):
    return {"video_id": video_id, "unit": unit, "quantity": quantity,
            "estimated_usd": usd, "recorded_at": recorded_at}


class UnitBreakdownTestCase(unittest.TestCase):
    def test_unpriced_unit_reports_quantity_not_dollars(self):
        rows = [
            _row("v1", "gemini_input_tokens", 1000, 0.05),
            _row("v1", "gemini_input_tokens", 2000, 0.10),
            _row("v1", "higgsfield_tokens", 50, None),   # unpriced
        ]
        units = {u.unit: u for u in so.unit_breakdown(rows)}
        self.assertEqual(units["gemini_input_tokens"].usd, 0.15)
        self.assertEqual(units["gemini_input_tokens"].quantity, 3000)
        self.assertIsNone(units["higgsfield_tokens"].usd)       # null, not 0
        self.assertEqual(units["higgsfield_tokens"].quantity, 50)

    def test_one_unpriced_entry_nulls_the_whole_unit(self):
        rows = [_row("v1", "render_seconds", 30, 0.30), _row("v2", "render_seconds", 30, None)]
        units = {u.unit: u for u in so.unit_breakdown(rows)}
        self.assertIsNone(units["render_seconds"].usd)  # partial sum would mislead
        self.assertEqual(units["render_seconds"].quantity, 60)


class ChannelOverviewTestCase(unittest.TestCase):
    def test_spend_avg_and_videos_remaining(self):
        rows = [
            _row("v1", "gemini_input_tokens", 1000, 1.0),
            _row("v2", "gemini_input_tokens", 1000, 1.0),
        ]
        store = _FakeStore({"ch1": rows})
        ov = so.channel_overview(store, "ch1", ceiling_usd=10.0, name="Alpha", now=NOW)
        self.assertEqual(ov.spent_usd, 2.0)
        self.assertEqual(ov.video_count, 2)
        self.assertEqual(ov.avg_cost_usd, 1.0)          # 2 usd / 2 videos
        self.assertEqual(ov.videos_remaining, 8)        # (10 - 2) // 1
        self.assertIsNotNone(ov.projected_usd)          # straight-line to month end
        self.assertFalse(ov.has_unpriced)

    def test_last_month_rows_excluded(self):
        rows = [_row("v1", "x", 1, 5.0, recorded_at=LAST_MONTH)]
        ov = so.channel_overview(_FakeStore({"ch1": rows}), "ch1", now=NOW)
        self.assertIsNone(ov.spent_usd)                 # nothing this month
        self.assertEqual(ov.video_count, 0)

    def test_unpriced_channel_has_no_spend_or_remaining(self):
        rows = [_row("v1", "higgsfield_tokens", 100, None)]
        ov = so.channel_overview(_FakeStore({"ch1": rows}), "ch1", ceiling_usd=10.0, now=NOW)
        self.assertIsNone(ov.spent_usd)                 # unknown, never 0
        self.assertIsNone(ov.avg_cost_usd)
        self.assertIsNone(ov.videos_remaining)          # can't divide by unknown avg
        self.assertTrue(ov.has_unpriced)
        self.assertEqual(ov.video_count, 1)             # quantity still tracked


class AllAccountsTestCase(unittest.TestCase):
    def test_totals_sum_known_spend_only(self):
        store = _FakeStore({
            "ch1": [_row("a", "u", 1, 3.0)],
            "ch2": [_row("b", "u", 1, 2.0)],
            "ch3": [_row("c", "higgsfield_tokens", 9, None)],   # unpriced
        })
        channels = [
            {"channel_id": "ch1", "name": "Alpha"},
            {"channel_id": "ch2", "name": "Beta", "spend_ceiling_usd": 10.0},
            {"channel_id": "ch3", "name": "Gamma"},
        ]
        agg = so.all_accounts_overview(store, channels, now=NOW)
        self.assertEqual(agg.total_spent_usd, 5.0)      # 3 + 2; ch3 unknown, excluded
        self.assertEqual(agg.channel_count, 3)
        self.assertTrue(agg.any_unpriced)
        self.assertEqual(agg.channels[0].channel_id, "ch1")  # biggest spend first

    def test_all_unpriced_total_is_none(self):
        store = _FakeStore({"ch1": [_row("a", "higgsfield_tokens", 1, None)]})
        agg = so.all_accounts_overview(store, [{"channel_id": "ch1"}], now=NOW)
        self.assertIsNone(agg.total_spent_usd)          # "not measured", never 0
        summary = so.summarize(agg)
        self.assertIsNone(summary["total_spent_usd"])
        self.assertEqual(summary["channel_count"], 1)


if __name__ == "__main__":
    unittest.main()
