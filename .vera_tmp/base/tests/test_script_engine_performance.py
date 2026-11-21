"""Tests for the PerformanceAnalyzer wiring in modules/script_engine.py —
the script writer receiving this channel's own past-performance numbers as
optional context (mirrors how topic_manager.py uses the same analyzer).

PerformanceAnalyzer is mocked here (its own behavior is covered by
tests/test_performance_analyzer.py) so these tests isolate the wiring: that
the rendered context is appended to the Gemini prompt when present, omitted
when empty, and that a construction or call failure degrades to a script
written without it rather than raising.

PerformanceAnalyzer MUST be mocked even where a test doesn't assert on it:
an unmocked ScriptEngine() constructs a real PerformanceAnalyzer, which opens
the actual project history/chronos.db as a side effect — exactly what these
tempdir-free tests must avoid.
"""

import unittest
from unittest.mock import MagicMock, patch

from modules.script_engine import ScriptEngine

_PAYLOAD = (
    '{"title": "T", "title_ab": "TA", "description": "D", "tags": [], '
    '"hook_sentence": "H", "thumbnail_prompt_a": "A", '
    '"thumbnail_prompt_b": "B", "thumbnail_overlay_text": "O", '
    '"open_loops": [], "sections": []}'
)


def _mock_response(payload_json: str) -> MagicMock:
    response = MagicMock()
    response.text = payload_json
    return response


class ScriptEnginePerformanceContextTestCase(unittest.TestCase):
    def _run_generate(self, analyzer_factory):
        """Build a ScriptEngine with make_client/generate_with_retry mocked and
        PerformanceAnalyzer replaced by analyzer_factory (a `patch` side_effect
        or return_value), then call generate() and hand back the prompt that
        reached Gemini.
        """
        mock_gen = _mock_response(_PAYLOAD)
        with patch("modules.script_engine.make_client", return_value=MagicMock()), \
             analyzer_factory() as _, \
             patch("modules.script_engine.generate_with_retry", return_value=mock_gen) as gen:
            engine = ScriptEngine()
            engine.generate("The Fall of Constantinople")
        return engine, gen.call_args[0][2]

    def test_performance_context_is_appended_when_present(self):
        fake_pa = MagicMock()
        fake_pa.analyze_videos_as_prompt_text.return_value = (
            "Past video performance, for context only -- not a formula to copy:\n"
            '- "Ancient Rome Secrets" (The Fall of Rome) — 100.0 views/day'
        )
        _, prompt = self._run_generate(
            lambda: patch("modules.script_engine.PerformanceAnalyzer", return_value=fake_pa)
        )
        self.assertIn("Ancient Rome Secrets", prompt)
        self.assertIn("not a formula to copy", prompt)

    def test_empty_performance_context_appends_nothing(self):
        fake_pa = MagicMock()
        fake_pa.analyze_videos_as_prompt_text.return_value = ""
        engine, prompt = self._run_generate(
            lambda: patch("modules.script_engine.PerformanceAnalyzer", return_value=fake_pa)
        )
        # The base topic prompt is still there, with no trailing performance block.
        self.assertIn("The Fall of Constantinople", prompt)
        self.assertNotIn("views/day", prompt)
        self.assertIsNotNone(engine.performance_analyzer)

    def test_construction_failure_degrades_to_no_context(self):
        engine, prompt = self._run_generate(
            lambda: patch(
                "modules.script_engine.PerformanceAnalyzer",
                side_effect=RuntimeError("disk full"),
            )
        )
        self.assertIsNone(engine.performance_analyzer)
        self.assertIn("The Fall of Constantinople", prompt)
        self.assertNotIn("views/day", prompt)

    def test_call_failure_degrades_to_no_context(self):
        fake_pa = MagicMock()
        fake_pa.analyze_videos_as_prompt_text.side_effect = RuntimeError("query blew up")
        _, prompt = self._run_generate(
            lambda: patch("modules.script_engine.PerformanceAnalyzer", return_value=fake_pa)
        )
        # generate() must not raise; the prompt is just the base topic prompt.
        self.assertIn("The Fall of Constantinople", prompt)
        self.assertNotIn("views/day", prompt)


if __name__ == "__main__":
    unittest.main()
