"""The spend ceiling protects real money with two guarantees: it never blocks on
missing price data (unknown spend is a floor, not a stop), and it is off unless a
channel sets a ceiling. `should_block_run` fires only when a KNOWN spend meets a
set ceiling."""

import unittest

from modules.budget import (
    BudgetStatus,
    channel_spend_usd,
    check_budget,
    month_start_iso,
    should_block_run,
)


class _FakeStore:
    def __init__(self, rows):
        self._rows = rows

    def list_video_costs(self, channel_id=None, limit=1000):
        return [r for r in self._rows if channel_id is None or r.get("channel_id") == channel_id]


class ChannelSpendTestCase(unittest.TestCase):
    def test_sums_priced_counts_unpriced_separately(self):
        store = _FakeStore([
            {"channel_id": "c", "estimated_usd": 1.5, "recorded_at": "2026-09-01"},
            {"channel_id": "c", "estimated_usd": 2.25, "recorded_at": "2026-09-02"},
            {"channel_id": "c", "estimated_usd": None, "recorded_at": "2026-09-03"},
        ])
        spent, priced, unpriced = channel_spend_usd(store, "c")
        self.assertEqual(spent, 3.75)   # only priced entries, never counting None as 0 in the price sense
        self.assertEqual(priced, 2)
        self.assertEqual(unpriced, 1)

    def test_since_filter(self):
        store = _FakeStore([
            {"channel_id": "c", "estimated_usd": 5.0, "recorded_at": "2026-08-15"},
            {"channel_id": "c", "estimated_usd": 3.0, "recorded_at": "2026-09-10"},
        ])
        spent, _, _ = channel_spend_usd(store, "c", since_iso="2026-09-01")
        self.assertEqual(spent, 3.0)  # August spend excluded

    def test_read_failure_is_zero_not_crash(self):
        class Boom:
            def list_video_costs(self, **kw):
                raise RuntimeError("db down")
        spent, priced, unpriced = channel_spend_usd(Boom(), "c")
        self.assertEqual((spent, priced, unpriced), (0.0, 0, 0))


class CheckBudgetTestCase(unittest.TestCase):
    def test_no_ceiling_never_exceeded(self):
        store = _FakeStore([{"channel_id": "c", "estimated_usd": 999.0, "recorded_at": "2026-09-01"}])
        status = check_budget(store, "c", None)
        self.assertIsNone(status.ceiling_usd)
        self.assertFalse(status.exceeded)
        self.assertFalse(should_block_run(status))  # unmetered channel runs

    def test_under_ceiling_runs(self):
        store = _FakeStore([{"channel_id": "c", "estimated_usd": 4.0, "recorded_at": "2026-09-01"}])
        status = check_budget(store, "c", 10.0)
        self.assertFalse(status.exceeded)
        self.assertEqual(status.remaining_usd, 6.0)
        self.assertFalse(should_block_run(status))

    def test_at_or_over_ceiling_blocks(self):
        store = _FakeStore([{"channel_id": "c", "estimated_usd": 10.0, "recorded_at": "2026-09-01"}])
        status = check_budget(store, "c", 10.0)
        self.assertTrue(status.exceeded)     # spent >= ceiling
        self.assertTrue(should_block_run(status))

    def test_unknown_spend_never_blocks(self):
        # All costs unpriced → known spend is 0, so even a tiny ceiling is not
        # exceeded: a data gap must never stop production.
        store = _FakeStore([
            {"channel_id": "c", "estimated_usd": None, "recorded_at": "2026-09-01"},
            {"channel_id": "c", "estimated_usd": None, "recorded_at": "2026-09-02"},
        ])
        status = check_budget(store, "c", 0.01)
        self.assertFalse(status.exceeded)
        self.assertTrue(status.has_unpriced)
        self.assertFalse(should_block_run(status))

    def test_month_start_iso_is_first_of_month(self):
        import datetime
        iso = month_start_iso(datetime.datetime(2026, 9, 12, 15, 30, tzinfo=datetime.timezone.utc))
        self.assertTrue(iso.startswith("2026-09-01T00:00:00"))


class AgentConfigCeilingTestCase(unittest.TestCase):
    def test_ceiling_roundtrips_and_defaults_none(self):
        from modules.channels import AgentConfig
        self.assertIsNone(AgentConfig().spend_ceiling_usd)
        self.assertIsNone(AgentConfig.from_dict({}).spend_ceiling_usd)
        cfg = AgentConfig.from_dict({"spend_ceiling_usd": 25})
        self.assertEqual(cfg.spend_ceiling_usd, 25.0)
        self.assertEqual(AgentConfig.from_dict(cfg.to_dict()).spend_ceiling_usd, 25.0)

    def test_malformed_ceiling_is_none(self):
        from modules.channels import AgentConfig
        self.assertIsNone(AgentConfig.from_dict({"spend_ceiling_usd": "abc"}).spend_ceiling_usd)
        self.assertIsNone(AgentConfig.from_dict({"spend_ceiling_usd": -5}).spend_ceiling_usd)  # non-positive → no ceiling


if __name__ == "__main__":
    unittest.main()
