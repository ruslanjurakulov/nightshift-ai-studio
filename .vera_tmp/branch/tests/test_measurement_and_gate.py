"""Phase 6: cost, A/B, retention and the pre-publish gate.

The gate tests are the important ones here. It is the only component in Nightshift
that can stop a publish, so what it must never do matters more than what it
does: it must never allow something that was previously blocked, and it must
never block because one of its own checkers broke.
"""

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from modules import publish_gate
from modules.ab_testing import (
    MIN_PER_VARIANT,
    VARIANT_A,
    VARIANT_B,
    choose_variant,
    variant_performance,
)
from modules.cost_ledger import (
    GEMINI_INPUT_TOKENS,
    RENDER_SECONDS,
    TTS_CHARACTERS,
    CostLedger,
    unit_price,
)
from modules.retention_analyzer import RetentionAnalyzer, analyze_curve


def script(**over):
    """A minimally valid script the gate should accept."""
    return SimpleNamespace(
        topic=over.get("topic", "A Real Topic"),
        title=over.get("title", "A Perfectly Ordinary Title"),
        title_ab=over.get("title_ab", "The Other Title"),
        description=over.get("description", "A description."),
        sections=over.get(
            "sections",
            [
                SimpleNamespace(narration="Something happens."),
                SimpleNamespace(narration="Then something else does."),
            ],
        ),
    )


def channel(gate: dict | None = None):
    return SimpleNamespace(agent=SimpleNamespace(publish_gate=gate or {}))


class NoDuplicates:
    def check(self, topic):
        return SimpleNamespace(is_duplicate=False, needs_review=False)


class AlwaysDuplicate:
    def check(self, topic):
        return SimpleNamespace(is_duplicate=True, needs_review=False)


class BrokenOriginality:
    def check(self, topic):
        raise RuntimeError("model failed to load")


# ---------------------------------------------------------------------------
# Cost ledger
# ---------------------------------------------------------------------------


class CostLedgerTestCase(unittest.TestCase):
    def test_quantities_are_recorded_without_a_price(self):
        # The whole point: we always know the quantity, we rarely know the price.
        ledger = CostLedger(channel_id="chronos-finance", slug="a-slug")
        env = {k: v for k, v in os.environ.items() if not k.startswith("CHRONOS_PRICE_")}
        with patch.dict(os.environ, env, clear=True):
            ledger.add(TTS_CHARACTERS, 4200, stage="voice")
        self.assertEqual(ledger.entries[0].quantity, 4200)
        self.assertIsNone(ledger.entries[0].estimated_usd)

    def test_a_configured_rate_prices_the_entry(self):
        ledger = CostLedger()
        with patch.dict(os.environ, {"CHRONOS_PRICE_TTS_CHARACTERS": "0.00003"}, clear=False):
            ledger.add(TTS_CHARACTERS, 1000)
        self.assertAlmostEqual(ledger.entries[0].estimated_usd, 0.03, places=6)

    def test_a_malformed_rate_leaves_the_entry_unpriced(self):
        # Better to say "unknown" than to record a number nobody meant.
        with patch.dict(os.environ, {"CHRONOS_PRICE_RENDER_SECONDS": "free!"}, clear=False):
            self.assertIsNone(unit_price(RENDER_SECONDS))

    def test_total_is_unknown_when_any_entry_is_unpriced(self):
        # A partial sum would read as the run's cost while omitting part of it.
        ledger = CostLedger()
        with patch.dict(os.environ, {"CHRONOS_PRICE_TTS_CHARACTERS": "0.00003"}, clear=False):
            ledger.add(TTS_CHARACTERS, 1000)
            ledger.add(RENDER_SECONDS, 120)  # no rate configured
        self.assertIsNone(ledger.total_usd())

    def test_bad_quantities_are_dropped_not_raised(self):
        ledger = CostLedger()
        ledger.add(RENDER_SECONDS, "not a number")
        ledger.add(RENDER_SECONDS, -5)
        self.assertEqual(ledger.entries, [])

    def test_gemini_usage_records_nothing_when_the_response_reports_none(self):
        # An invented token count is worse than a gap in the data.
        ledger = CostLedger()
        ledger.add_gemini_usage(SimpleNamespace())
        self.assertEqual(ledger.entries, [])

    def test_gemini_usage_records_what_the_response_reports(self):
        ledger = CostLedger()
        ledger.add_gemini_usage(
            SimpleNamespace(
                usage_metadata=SimpleNamespace(prompt_token_count=900, candidates_token_count=300)
            )
        )
        units = {e.unit: e.quantity for e in ledger.entries}
        self.assertEqual(units[GEMINI_INPUT_TOKENS], 900)

    def test_flush_writes_every_entry_and_survives_a_broken_store(self):
        from modules.state_store import StateStore

        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(db_path=Path(tmp) / "chronos.db")
            try:
                ledger = CostLedger(channel_id="extinct-world", slug="s")
                ledger.add(RENDER_SECONDS, 90, stage="render")
                ledger.add(TTS_CHARACTERS, 500, stage="voice")
                self.assertEqual(ledger.flush(store, video_id="v1"), 2)
                rows = store.list_video_costs(video_id="v1")
                self.assertEqual({r["unit"] for r in rows}, {RENDER_SECONDS, TTS_CHARACTERS})
                self.assertEqual(rows[0]["channel_id"], "extinct-world")
            finally:
                store.close()

        class Broken:
            def record_video_cost(self, **kw):
                raise RuntimeError("disk full")

        ledger = CostLedger()
        ledger.add(RENDER_SECONDS, 1)
        self.assertEqual(ledger.flush(Broken(), video_id="v1"), 0)  # must not raise


# ---------------------------------------------------------------------------
# A/B
# ---------------------------------------------------------------------------


def video(video_id, variant):
    return {"video_id": video_id, "thumbnail_variant": variant}


def snap(video_id, ctr, date="2026-09-01", impressions=1000):
    return {
        "video_id": video_id,
        "snapshot_date": date,
        "impression_ctr": ctr,
        "impressions": impressions,
    }


class ABTestingTestCase(unittest.TestCase):
    def test_variants_alternate_until_there_is_a_verdict(self):
        # Both arms have to fill up, or the experiment never concludes.
        self.assertEqual([choose_variant(n) for n in range(4)], ["A", "B", "A", "B"])

    def test_a_winner_is_favoured_but_the_loser_is_still_explored(self):
        videos = [video(f"a{i}", "A") for i in range(6)] + [video(f"b{i}", "B") for i in range(6)]
        snapshots = [snap(f"a{i}", 0.10) for i in range(6)] + [snap(f"b{i}", 0.05) for i in range(6)]
        result = variant_performance(videos, snapshots)
        self.assertEqual(result.winner, VARIANT_A)

        picks = [choose_variant(n, result) for n in range(10)]
        self.assertIn(VARIANT_A, picks)
        # A locked-in winner stops being an experiment; some traffic keeps testing.
        self.assertIn(VARIANT_B, picks)

    def test_no_winner_below_the_evidence_floor(self):
        videos = [video("a1", "A"), video("b1", "B")]
        snapshots = [snap("a1", 0.20), snap("b1", 0.02)]
        result = variant_performance(videos, snapshots)
        self.assertIsNone(result.winner)
        self.assertIn(str(MIN_PER_VARIANT), result.reason)

    def test_a_small_gap_is_a_tie_not_a_winner(self):
        videos = [video(f"a{i}", "A") for i in range(6)] + [video(f"b{i}", "B") for i in range(6)]
        snapshots = [snap(f"a{i}", 0.101) for i in range(6)] + [snap(f"b{i}", 0.100) for i in range(6)]
        result = variant_performance(videos, snapshots)
        self.assertIsNone(result.winner)
        self.assertIn("tie", result.reason)

    def test_unmeasured_videos_are_excluded_not_counted_as_zero(self):
        # A video nobody polled has unknown CTR. Treating it as 0% would drag
        # whichever arm happens to be newer.
        videos = [video(f"a{i}", "A") for i in range(6)]
        snapshots = [snap(f"a{i}", 0.10) for i in range(3)]
        result = variant_performance(videos, snapshots)
        self.assertEqual(result.a.videos, 3)

    def test_selection_survives_nonsense_input(self):
        self.assertEqual(choose_variant("not a number"), VARIANT_A)
        self.assertEqual(choose_variant(-3), VARIANT_A)


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------


def curve(pairs, date="2026-09-01"):
    return [
        {"elapsed_ratio": r, "watch_ratio": w, "measured_date": date} for r, w in pairs
    ]


class RetentionTestCase(unittest.TestCase):
    def test_a_thin_curve_produces_nothing(self):
        # Two samples describe nothing; a confident number from them would be
        # worse than silence.
        self.assertIsNone(analyze_curve("v1", curve([(0.0, 1.0), (0.5, 0.4)])))

    def test_the_hook_and_the_biggest_cliff_are_found(self):
        insight = analyze_curve(
            "v1",
            curve([(0.0, 1.0), (0.05, 0.9), (0.10, 0.85), (0.20, 0.80), (0.30, 0.40), (0.50, 0.35)]),
        )
        self.assertIsNotNone(insight)
        self.assertAlmostEqual(insight.hook_retention, 0.85)
        self.assertAlmostEqual(insight.cliff_at, 0.20)
        self.assertAlmostEqual(insight.cliff_drop, 0.40, places=6)

    def test_ordinary_decay_is_not_reported_as_a_cliff(self):
        insight = analyze_curve(
            "v1", curve([(0.0, 1.0), (0.1, 0.98), (0.2, 0.96), (0.3, 0.94), (0.4, 0.92)])
        )
        self.assertIsNone(insight.cliff_at)

    def test_prompt_text_is_empty_below_the_evidence_floor(self):
        class Store:
            def list_videos(self, limit=100, channel_id=None):
                return [{"video_id": "v1"}]

            def retention_curve(self, video_id):
                return curve([(i / 10, 1 - i / 20) for i in range(8)])

        analyzer = RetentionAnalyzer(state_store=Store(), channel_id="default")
        # One curve is one video's story, not a channel pattern.
        self.assertEqual(analyzer.as_prompt_text(), "")

    def test_prompt_text_names_the_hook_and_the_drop(self):
        class Store:
            def list_videos(self, limit=100, channel_id=None):
                return [{"video_id": f"v{i}"} for i in range(4)]

            def retention_curve(self, video_id):
                return curve([(0.0, 1.0), (0.05, 0.7), (0.10, 0.6), (0.2, 0.55), (0.3, 0.2), (0.4, 0.18)])

        text = RetentionAnalyzer(state_store=Store()).as_prompt_text()
        self.assertIn("still watching at the end of the hook", text)
        self.assertIn("drop-off", text)
        # Below 70% retention at the hook, the advice is explicit.
        self.assertIn("open harder", text)

    def test_a_broken_store_produces_no_context_rather_than_raising(self):
        class Store:
            def list_videos(self, limit=100, channel_id=None):
                raise RuntimeError("db gone")

        self.assertEqual(RetentionAnalyzer(state_store=Store()).as_prompt_text(), "")


# ---------------------------------------------------------------------------
# Publish gate — the only thing here that can stop an upload
# ---------------------------------------------------------------------------


class PublishGateTestCase(unittest.TestCase):
    def _video(self, tmp, size=200_000):
        path = Path(tmp) / "final_video.mp4"
        path.write_bytes(b"0" * size)
        return path

    def test_a_good_video_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(),
                video_path=self._video(tmp),
                fact_results=[],
                channel=channel(),
                originality=NoDuplicates(),
            )
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.blocks, [])

    def test_a_duplicate_topic_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(),
                video_path=self._video(tmp),
                fact_results=[],
                channel=channel(),
                originality=AlwaysDuplicate(),
            )
        self.assertFalse(decision.allowed)
        self.assertIn("duplicate_topic", decision.blocks)

    def test_flagged_claims_block(self):
        flagged = [SimpleNamespace(requires_human_review=True)]
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(),
                video_path=self._video(tmp),
                fact_results=flagged,
                channel=channel(),
                originality=NoDuplicates(),
            )
        self.assertFalse(decision.allowed)
        self.assertIn("fact_check_flagged:1", decision.blocks)

    def test_an_over_long_title_blocks(self):
        # YouTube rejects it outright, so publishing would fail anyway — better
        # to say so before spending the upload.
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(title="x" * 150),
                video_path=self._video(tmp),
                fact_results=[],
                channel=channel(),
                originality=NoDuplicates(),
            )
        self.assertIn("title_over_100_chars", decision.blocks)

    def test_a_missing_or_tiny_render_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(),
                video_path=Path(tmp) / "nope.mp4",
                fact_results=[],
                channel=channel(),
                originality=NoDuplicates(),
            )
            self.assertIn("rendered_file_missing", decision.blocks)

            decision = publish_gate.evaluate(
                script=script(),
                video_path=self._video(tmp, size=10),
                fact_results=[],
                channel=channel(),
                originality=NoDuplicates(),
            )
            self.assertIn("rendered_file_too_small", decision.blocks)

    def test_a_broken_checker_blocks_by_default(self):
        # A duplicate check that could not run is not evidence the topic is
        # original. With block_on_duplicate on (the default) the video is held
        # for a human rather than passed unchecked; a channel that only wants a
        # warning turns block_on_duplicate off (covered in
        # GateFailsClosedWhenAConfiguredCheckCannotRun).
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(),
                video_path=self._video(tmp),
                fact_results=[],
                channel=channel(),
                originality=BrokenOriginality(),
            )
        self.assertFalse(decision.allowed)
        self.assertTrue(any(b.startswith("originality_errored") for b in decision.blocks))

    def test_a_fact_check_that_never_ran_blocks_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(),
                video_path=self._video(tmp),
                fact_results=None,
                channel=channel(),
                originality=NoDuplicates(),
            )
        self.assertFalse(decision.allowed)
        self.assertIn("fact_check_not_run", decision.blocks)

    def test_a_channel_can_disable_the_gate_entirely(self):
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(title="x" * 150),
                video_path=Path(tmp) / "nope.mp4",
                fact_results=[SimpleNamespace(requires_human_review=True)],
                channel=channel({"enabled": False}),
                originality=AlwaysDuplicate(),
            )
        self.assertTrue(decision.allowed)
        self.assertIn("gate_disabled_for_channel", decision.warnings)

    def test_one_check_can_be_downgraded_without_disabling_the_rest(self):
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(),
                video_path=self._video(tmp),
                fact_results=[SimpleNamespace(requires_human_review=True)],
                channel=channel({"block_on_fact_check": False}),
                originality=AlwaysDuplicate(),
            )
        # Fact-check demoted to a warning; the duplicate still blocks.
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.blocks, ["duplicate_topic"])
        self.assertIn("fact_check_flagged:1", decision.warnings)

    def test_a_config_typo_leaves_the_check_on(self):
        # Only an explicit boolean false disables anything.
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(),
                video_path=self._video(tmp),
                fact_results=[],
                channel=channel({"enabled": "no"}),
                originality=AlwaysDuplicate(),
            )
        self.assertFalse(decision.allowed)

    def test_metadata_carries_no_script_text(self):
        # The event stream must not become a place scripts or claims leak into.
        flagged = [SimpleNamespace(requires_human_review=True, claim="a secret-looking claim")]
        with tempfile.TemporaryDirectory() as tmp:
            decision = publish_gate.evaluate(
                script=script(title="Some Distinctive Title"),
                video_path=self._video(tmp),
                fact_results=flagged,
                channel=channel(),
                originality=NoDuplicates(),
            )
        payload = str(decision.to_metadata())
        self.assertNotIn("Some Distinctive Title", payload)
        self.assertNotIn("a secret-looking claim", payload)


class PexelsCostTestCase(unittest.TestCase):
    """The Pexels quota is spent per search, so searches are what is counted."""

    def _fetcher(self, tmp):
        from modules import media_fetcher as mf

        with patch.object(mf, "OUTPUT_DIR", Path(tmp)):
            return mf.MediaFetcher("a-slug")

    def test_every_search_is_counted_including_a_failed_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            fetcher = self._fetcher(tmp)
            self.assertEqual(fetcher.searches_made, 0)

            class FakeResponse:
                def raise_for_status(self):
                    return None

                def json(self):
                    return {"videos": [], "photos": []}

            class FailingResponse(FakeResponse):
                def raise_for_status(self):
                    raise RuntimeError("429")

            responses = [FakeResponse(), FailingResponse(), FakeResponse()]
            fetcher.session = SimpleNamespace(get=lambda *a, **kw: responses.pop(0))

            fetcher._pexels_video_search("rome")
            with self.assertRaises(RuntimeError):
                fetcher._pexels_video_search("rome")
            fetcher._pexels_photo_search("rome")

            # Three requests were issued; a rejected one still consumed quota,
            # so counting only the successes would understate the real cost.
            self.assertEqual(fetcher.searches_made, 3)


if __name__ == "__main__":
    unittest.main()


class OriginalityErrors:
    """An originality engine that cannot load its model — the constrained-runner
    case the gate used to wave through as a warning."""

    def check(self, topic):
        raise RuntimeError("model load failed")


class GateFailsClosedWhenAConfiguredCheckCannotRun(unittest.TestCase):
    """A check you told the gate to block on, when it cannot run, blocks.

    Before this, a fact-check that never produced a verdict (None) and an
    originality engine that failed to load were both downgraded to warnings —
    so a video with no fact-check and no duplicate-check at all still came back
    allowed. That is the "unknown read as passed" the gate exists to prevent.
    The severity now follows the same config flag as a check that ran and failed:
    strict when you asked for strictness, a warning when you only asked for one.
    A blocked video is never lost — it stays private on disk for a human.
    """

    def _video(self, tmp):
        path = Path(tmp) / "final_video.mp4"
        path.write_bytes(b"0" * 200_000)
        return path

    def test_a_fact_check_that_did_not_run_blocks_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = publish_gate.evaluate(
                script=script(), video_path=self._video(tmp),
                fact_results=None, channel=channel(), originality=NoDuplicates(),
            )
        self.assertFalse(d.allowed)
        self.assertIn("fact_check_not_run", d.blocks)

    def test_a_missing_fact_check_is_a_warning_when_the_channel_turned_it_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = publish_gate.evaluate(
                script=script(), video_path=self._video(tmp), fact_results=None,
                channel=channel({"block_on_fact_check": False}), originality=NoDuplicates(),
            )
        self.assertTrue(d.allowed)
        self.assertIn("fact_check_not_run", d.warnings)

    def test_an_originality_engine_that_errors_blocks_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = publish_gate.evaluate(
                script=script(), video_path=self._video(tmp), fact_results=[],
                channel=channel(), originality=OriginalityErrors(),
            )
        self.assertFalse(d.allowed)
        self.assertTrue(any(b.startswith("originality_errored") for b in d.blocks))

    def test_an_originality_error_is_a_warning_when_duplicate_blocking_is_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = publish_gate.evaluate(
                script=script(), video_path=self._video(tmp), fact_results=[],
                channel=channel({"block_on_duplicate": False}), originality=OriginalityErrors(),
            )
        self.assertTrue(d.allowed)
        self.assertTrue(any(w.startswith("originality_errored") for w in d.warnings))

    def test_both_checks_missing_does_not_come_back_allowed(self):
        # The exact hole Codex reported: neither control present, yet allowed=True.
        with tempfile.TemporaryDirectory() as tmp:
            d = publish_gate.evaluate(
                script=script(), video_path=self._video(tmp), fact_results=None,
                channel=channel(), originality=OriginalityErrors(),
            )
        self.assertFalse(d.allowed)
