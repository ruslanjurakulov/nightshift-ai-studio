"""Tests for tools/unit_economics.py — "1 video = $X" from the cost ledger.

The number is meant to become a price, so the tests pin the ways it could be
quietly wrong: a partially priced video dragging the median down, an unknown
turning into $0, one video split in two, or the wrong env var being named.
"""

import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from modules import cost_ledger
from tools import unit_economics as ue

NOW = datetime(2026, 9, 24, tzinfo=timezone.utc)


def ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


def priced_video(slug, usd, days=1.0, channel="ch1"):
    return [
        {"slug": slug, "video_id": "", "channel_id": channel, "unit": "gemini_input_tokens",
         "quantity": 10_000, "stage": "script", "estimated_usd": usd * 0.25, "recorded_at": ago(days)},
        {"slug": slug, "video_id": "", "channel_id": channel, "unit": "tts_characters",
         "quantity": 9_000, "stage": "voice", "estimated_usd": usd * 0.75, "recorded_at": ago(days)},
    ]


PARTIAL = [
    {"slug": "p", "channel_id": "ch1", "unit": "gemini_input_tokens", "quantity": 10_000,
     "stage": "script", "estimated_usd": 0.01, "recorded_at": ago(1)},
    {"slug": "p", "channel_id": "ch1", "unit": "render_seconds", "quantity": 600,
     "stage": "render", "estimated_usd": None, "recorded_at": ago(1)},
]


class PercentileTest(unittest.TestCase):
    def test_matches_the_dashboard_definition(self):
        self.assertIsNone(ue.percentile([], 0.5))
        self.assertEqual(ue.percentile([10, 20, 30, 40, 50], 0.75), 40)
        self.assertAlmostEqual(ue.percentile(list(range(1, 11)), 0.9), 9.1)
        self.assertAlmostEqual(ue.percentile([1, 2], 0.5), 1.5)


class SummarizeTest(unittest.TestCase):
    def test_median_and_p90_over_fully_priced_videos(self):
        rows = [r for i, usd in enumerate(range(1, 11)) for r in priced_video(f"v{i}", usd, 1 + i * 0.1)]
        s = ue.summarize(rows, now=NOW)
        self.assertEqual(s["sample_size"], 10)
        self.assertAlmostEqual(s["median_per_video"], 5.5)
        self.assertAlmostEqual(s["p90_per_video"], 9.1)

    def test_partially_priced_video_is_excluded_and_counted(self):
        s = ue.summarize(priced_video("a", 3) + priced_video("b", 5) + PARTIAL, now=NOW)
        self.assertEqual((s["priced_videos"], s["partial_videos"]), (2, 1))
        # Only 3 and 5: the partial video's $0.01 floor must not pull the median down.
        self.assertAlmostEqual(s["median_per_video"], 4)
        partial = next(v for v in s["videos"] if v["slug"] == "p")
        self.assertIsNone(partial["usd"])
        self.assertAlmostEqual(partial["priced_usd"], 0.01)

    def test_all_partial_reads_unknown_not_zero(self):
        s = ue.summarize(PARTIAL, now=NOW)
        self.assertIsNone(s["median_per_video"])
        self.assertIsNone(s["p90_per_video"])
        self.assertEqual(s["drivers"], [])
        self.assertIn("—", ue.format_report(s))
        self.assertNotIn("$0.00", ue.format_report(s))

    def test_unpriced_units_name_the_ledgers_own_env_var(self):
        s = ue.summarize(PARTIAL, now=NOW)
        self.assertEqual(s["unpriced"], [{
            "unit": "render_seconds", "env_var": "CHRONOS_PRICE_RENDER_SECONDS",
            "videos": 1, "quantity": 600.0,
        }])
        # The name must be the one unit_price() actually reads.
        with patch.dict(os.environ, {s["unpriced"][0]["env_var"]: "0.001"}):
            self.assertEqual(cost_ledger.unit_price("render_seconds"), 0.001)

    def test_empty_ledger(self):
        s = ue.summarize([], now=NOW)
        self.assertEqual(s["sample_size"], 0)
        self.assertIsNone(s["median_per_minute"])
        self.assertIn("No video recorded a cost", ue.format_report(s))

    def test_per_minute_needs_a_priced_video_with_a_known_length(self):
        rows = priced_video("a", 6) + priced_video("b", 10) + priced_video("c", 1)
        durations = [
            {"slug": "a", "channel_id": "ch1", "duration_s": 360},
            {"slug": "b", "channel_id": "ch1", "duration_s": 300},
            {"slug": "c", "channel_id": "ch1", "duration_s": None},
        ]
        s = ue.summarize(rows, durations, now=NOW)
        self.assertEqual(s["minute_sample"], 2)
        self.assertAlmostEqual(s["median_per_minute"], 1.5)

    def test_held_run_and_its_repair_are_one_video(self):
        rows = [
            {"slug": "s", "video_id": "", "channel_id": "ch1", "unit": "tts_characters",
             "quantity": 100, "stage": "voice", "estimated_usd": 1.0, "recorded_at": ago(2)},
            {"slug": "s", "video_id": None, "channel_id": "ch1", "unit": "render_seconds",
             "quantity": 50, "stage": "repair_render", "estimated_usd": 0.5, "recorded_at": ago(1)},
        ]
        s = ue.summarize(rows, now=NOW)
        self.assertEqual(s["sample_size"], 1)
        self.assertAlmostEqual(s["videos"][0]["usd"], 1.5)

    def test_window_and_most_recent_cap(self):
        rows = priced_video("old", 100, 45) + [r for n in (1, 2, 3, 4) for r in priced_video(f"n{n}", n, n)]
        s = ue.summarize(rows, window_days=30, max_videos=3, now=NOW)
        self.assertEqual([v["slug"] for v in s["videos"]], ["n1", "n2", "n3"])

    def test_drivers_split_media_by_provider_and_rank_by_cost(self):
        rows = priced_video("a", 1) + [
            {"slug": "a", "channel_id": "ch1", "unit": "video_gen_clips", "quantity": 4,
             "stage": "broll:minimax", "estimated_usd": 2.0, "recorded_at": ago(1)},
        ]
        s = ue.summarize(rows, now=NOW)
        self.assertEqual(s["drivers"][0]["key"], "video_gen_clips:minimax")
        self.assertAlmostEqual(s["drivers"][0]["share"], 2 / 3)
        self.assertIsNone(ue.provider_of("script"))

    def test_rows_without_video_or_slug_are_counted_not_invented(self):
        s = ue.summarize([{"unit": "tts_characters", "quantity": 5, "estimated_usd": 0.1,
                           "recorded_at": ago(1)}], now=NOW)
        self.assertEqual((s["sample_size"], s["unattributed_rows"]), (0, 1))


class PriceEnvVarTest(unittest.TestCase):
    def test_convention(self):
        self.assertEqual(cost_ledger.price_env_var("tts_characters"), "CHRONOS_PRICE_TTS_CHARACTERS")


if __name__ == "__main__":
    unittest.main()
