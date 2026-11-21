"""Tests for modules/publish_score.py.

The load-bearing property is honesty: a dimension with no signal scores None
(not 0), the overall is computed only over scored dimensions, and the module
never claims to be the publish gate.
"""

import ast
import unittest
from pathlib import Path
from types import SimpleNamespace

from modules.publish_score import (
    DO_NOT_PUBLISH,
    HEURISTIC,
    IMPROVE,
    INSUFFICIENT,
    MEASURED,
    NONE,
    READY,
    PublishScore,
    ScoreInputs,
    evaluate,
    inputs_from_script,
)


def _dim(score: PublishScore, key: str):
    return next(d for d in score.dimensions if d.key == key)


class HeuristicDimensionsTestCase(unittest.TestCase):
    def test_strong_content_scores_high(self):
        r = evaluate(ScoreInputs(
            hook="Why nobody noticed this 500-year-old mistake?",
            title="The 500-Year-Old Mistake Nobody Noticed",
            description="A deep dive into the overlooked error that shaped history, " * 4,
            tags=("history", "mystery", "documentary", "facts", "ancient"),
            cta="Subscribe and watch the next one.",
            thumbnail_text="500-YEAR LIE",
        ))
        for key in ("hook", "seo", "cta", "thumbnail"):
            d = _dim(r, key)
            self.assertEqual(d.confidence, HEURISTIC)
            self.assertIsNotNone(d.score)
            self.assertGreaterEqual(d.score, 70)

    def test_missing_content_scores_none_not_zero(self):
        r = evaluate(ScoreInputs())  # nothing at all
        for key in ("hook", "seo", "cta", "thumbnail"):
            d = _dim(r, key)
            self.assertIsNone(d.score)  # None, never 0
            self.assertEqual(d.confidence, NONE)


class PredictionDimensionsTestCase(unittest.TestCase):
    def test_absent_signals_are_none(self):
        r = evaluate(ScoreInputs(hook="Why this?"))
        for key in ("retention", "ctr", "competition"):
            self.assertIsNone(_dim(r, key).score)
            self.assertEqual(_dim(r, key).confidence, NONE)

    def test_present_signals_are_measured(self):
        r = evaluate(ScoreInputs(
            hook="Why this?",
            past_retention_pct=50.0,
            past_ctr_pct=8.0,
            competitor_saturation=0.2,
        ))
        for key in ("retention", "ctr", "competition"):
            d = _dim(r, key)
            self.assertEqual(d.confidence, MEASURED)
            self.assertIsNotNone(d.score)
        # 50% retention → strong; 0.2 saturation → high opportunity.
        self.assertGreaterEqual(_dim(r, "retention").score, 80)
        self.assertGreaterEqual(_dim(r, "competition").score, 70)


class OverallAndVerdictTestCase(unittest.TestCase):
    def test_overall_only_uses_scored_dimensions(self):
        # Only content present → 4 of 7 dimensions inform the overall.
        r = evaluate(ScoreInputs(
            hook="Why nobody noticed this 500-year-old mistake?",
            title="The 500-Year-Old Mistake Nobody Noticed",
            description="x" * 200,
            tags=("a", "b", "c", "d", "e"),
            cta="Subscribe and watch the next one.",
            thumbnail_text="500-YEAR LIE",
        ))
        self.assertEqual(r.dims_total, 7)
        self.assertEqual(r.dims_scored, 4)
        self.assertIsNotNone(r.overall)
        self.assertEqual(r.verdict, READY)

    def test_insufficient_data_when_nothing_scored(self):
        r = evaluate(ScoreInputs())
        self.assertEqual(r.dims_scored, 0)
        self.assertIsNone(r.overall)
        self.assertEqual(r.verdict, INSUFFICIENT)

    def test_weak_content_does_not_publish(self):
        r = evaluate(ScoreInputs(hook="stuff", title="ok", cta="", thumbnail_text=""))
        # A bare hook + tiny title, nothing else — overall low.
        self.assertIn(r.verdict, {IMPROVE, DO_NOT_PUBLISH})

    def test_recommendations_collected_for_weak_dims(self):
        r = evaluate(ScoreInputs(hook="stuff"))
        self.assertTrue(any(r.notes))  # at least one "how to improve" note

    def test_metadata_shape(self):
        r = evaluate(ScoreInputs(hook="Why this?", past_retention_pct=40.0))
        md = r.to_metadata()
        self.assertEqual(set(md), {"overall", "verdict", "dims_scored", "dims_total", "dimensions"})
        self.assertIn("hook", md["dimensions"])
        self.assertEqual(md["dimensions"]["ctr"]["score"], None)


class InputsFromScriptTestCase(unittest.TestCase):
    def test_maps_real_script_fields(self):
        script = SimpleNamespace(
            hook_sentence="Why nobody noticed this?",
            title="The Thing Nobody Noticed",
            description="d" * 150,
            tags=["a", "b", "c"],
            thumbnail_overlay_text="NEVER NOTICED",
        )
        inp = inputs_from_script(script, past_retention_pct=45.0)
        self.assertEqual(inp.hook, "Why nobody noticed this?")
        self.assertEqual(inp.title, "The Thing Nobody Noticed")
        self.assertEqual(inp.tags, ("a", "b", "c"))
        self.assertEqual(inp.thumbnail_text, "NEVER NOTICED")
        self.assertEqual(inp.past_retention_pct, 45.0)
        # No cta field on this script → empty (→ a None cta dimension downstream).
        self.assertEqual(inp.cta, "")
        self.assertIsNone(inp.past_ctr_pct)

    def test_missing_fields_are_safe(self):
        inp = inputs_from_script(SimpleNamespace())
        self.assertEqual(inp.hook, "")
        self.assertEqual(inp.tags, ())
        r = evaluate(inp)  # must not raise on an empty script
        self.assertEqual(r.verdict, INSUFFICIENT)


class MainWiringIsAdvisoryTestCase(unittest.TestCase):
    """publish_score must be emitted in main.py, and it must NOT sit inside the
    gate's allow/deny branches — it is advisory and always runs, never gates."""

    def setUp(self):
        main_path = Path(__file__).resolve().parent.parent / "main.py"
        self.tree = ast.parse(main_path.read_text())

    def _publish_score_emit(self):
        for node in ast.walk(self.tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "emit"
                and node.args
                and isinstance(node.args[0], ast.Attribute)
                and node.args[0].attr == "PUBLISH_SCORE"
            ):
                return node
        return None

    def _ancestors(self, target, node=None, trail=()):
        node = node or self.tree
        if node is target:
            return trail
        for child in ast.iter_child_nodes(node):
            found = self._ancestors(target, child, trail + (node,))
            if found is not None:
                return found
        return None

    def test_publish_score_is_emitted(self):
        self.assertIsNotNone(self._publish_score_emit(), "main.py must emit events.PUBLISH_SCORE")

    def test_emit_is_not_gated_on_gate_allowed(self):
        emit = self._publish_score_emit()
        self.assertIsNotNone(emit)
        ancestors = self._ancestors(emit)
        gated = [
            a for a in ancestors
            if isinstance(a, ast.If) and "gate.allowed" in ast.unparse(a.test)
        ]
        self.assertEqual(
            gated, [],
            "PUBLISH_SCORE must be advisory — emitted regardless of gate.allowed, "
            "never from inside a gate branch",
        )


if __name__ == "__main__":
    unittest.main()
