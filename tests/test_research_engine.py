"""Tests for modules.research_engine.

These tests never make a live Gemini call — generate_with_retry is always
mocked, so no network access or API key is required to run this file.
"""

import json
import logging
import unittest
from unittest.mock import MagicMock, patch

from modules.research_engine import ResearchBrief, ResearchFact, research_topic


def _mock_response(text: str) -> MagicMock:
    response = MagicMock()
    response.text = text
    return response


class TestResearchTopicCleanResponse(unittest.TestCase):
    def test_multiple_facts_at_different_confidence_levels(self):
        payload = {
            "key_facts": [
                {"claim": "The library burned in antiquity.", "confidence": "high", "caveat": None},
                {"claim": "It housed roughly 400,000 scrolls.", "confidence": "medium", "caveat": "estimate varies widely by source"},
                {"claim": "A named scribe catalogued it alone.", "confidence": "low", "caveat": "single detail, unverified"},
            ],
            "open_questions": ["Whether the fire was deliberate or accidental is disputed."],
            "suggested_angle": "Frame it as an unsolved-mystery whodunit around the fire.",
        }

        with patch(
            "modules.research_engine.make_client", return_value=MagicMock()
        ), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response(json.dumps(payload)),
        ) as mock_gen:
            brief = research_topic("The Library of Alexandria")

        self.assertIsInstance(brief, ResearchBrief)
        self.assertEqual(brief.topic, "The Library of Alexandria")
        self.assertEqual(len(brief.key_facts), 3)

        self.assertEqual(brief.key_facts[0].confidence, "high")
        self.assertIsNone(brief.key_facts[0].caveat)

        self.assertEqual(brief.key_facts[1].confidence, "medium")
        self.assertEqual(brief.key_facts[1].caveat, "estimate varies widely by source")

        self.assertEqual(brief.key_facts[2].confidence, "low")
        self.assertEqual(brief.key_facts[2].caveat, "single detail, unverified")

        self.assertEqual(len(brief.open_questions), 1)
        self.assertTrue(brief.suggested_angle)
        self.assertTrue(mock_gen.called)

    def test_handles_fenced_json(self):
        payload = {
            "key_facts": [{"claim": "X happened.", "confidence": "high", "caveat": None}],
            "open_questions": [],
            "suggested_angle": "Angle.",
        }
        fenced = f"```json\n{json.dumps(payload)}\n```"

        with patch("modules.research_engine.make_client", return_value=MagicMock()), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response(fenced),
        ):
            brief = research_topic("Some Topic")

        self.assertEqual(len(brief.key_facts), 1)
        self.assertEqual(brief.key_facts[0].claim, "X happened.")


class TestConfidenceClamping(unittest.TestCase):
    def test_invalid_confidence_is_clamped_to_low_and_logged(self):
        payload = {
            "key_facts": [
                {"claim": "Something is asserted very firmly.", "confidence": "certain", "caveat": None},
            ],
            "open_questions": [],
            "suggested_angle": "",
        }

        with patch("modules.research_engine.make_client", return_value=MagicMock()), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response(json.dumps(payload)),
        ):
            with self.assertLogs("modules.research_engine", level="WARNING") as cm:
                brief = research_topic("Some Topic")

        self.assertEqual(brief.key_facts[0].confidence, "low")
        self.assertTrue(
            any("invalid confidence" in msg.lower() for msg in cm.output)
        )

    def test_missing_confidence_is_clamped_to_low(self):
        payload = {
            "key_facts": [{"claim": "No confidence given.", "caveat": None}],
            "open_questions": [],
            "suggested_angle": "",
        }

        with patch("modules.research_engine.make_client", return_value=MagicMock()), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response(json.dumps(payload)),
        ):
            with self.assertLogs("modules.research_engine", level="WARNING"):
                brief = research_topic("Some Topic")

        self.assertEqual(brief.key_facts[0].confidence, "low")


class TestMalformedResponse(unittest.TestCase):
    def test_non_json_response_returns_empty_valid_brief(self):
        with patch("modules.research_engine.make_client", return_value=MagicMock()), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response("Sorry, I can't help with that right now."),
        ):
            with self.assertLogs("modules.research_engine", level="ERROR"):
                brief = research_topic("Broken Topic")

        self.assertIsInstance(brief, ResearchBrief)
        self.assertEqual(brief.topic, "Broken Topic")
        self.assertEqual(brief.key_facts, [])
        self.assertEqual(brief.open_questions, [])
        self.assertEqual(brief.suggested_angle, "")

    def test_truncated_json_returns_empty_valid_brief(self):
        truncated = '{"key_facts": [{"claim": "Cut off mid'

        with patch("modules.research_engine.make_client", return_value=MagicMock()), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response(truncated),
        ):
            with self.assertLogs("modules.research_engine", level="ERROR"):
                brief = research_topic("Truncated Topic")

        self.assertEqual(brief.key_facts, [])
        self.assertEqual(brief.suggested_angle, "")


class TestEmptyArrays(unittest.TestCase):
    def test_empty_key_facts_and_open_questions_are_handled_cleanly(self):
        payload = {"key_facts": [], "open_questions": [], "suggested_angle": "No strong facts recalled."}

        with patch("modules.research_engine.make_client", return_value=MagicMock()), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response(json.dumps(payload)),
        ):
            brief = research_topic("Obscure Topic")

        self.assertEqual(brief.key_facts, [])
        self.assertEqual(brief.open_questions, [])
        self.assertEqual(brief.suggested_angle, "No strong facts recalled.")

    def test_missing_keys_entirely_default_to_empty(self):
        with patch("modules.research_engine.make_client", return_value=MagicMock()), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response("{}"),
        ):
            brief = research_topic("Sparse Topic")

        self.assertEqual(brief.key_facts, [])
        self.assertEqual(brief.open_questions, [])
        self.assertEqual(brief.suggested_angle, "")


class TestStructuredOutputPath(unittest.TestCase):
    """Roadmap #50: with the flag on, the brief is built from response.parsed
    and the request carries the JSON-mode config — no regex extraction runs."""

    def test_structured_path_reads_parsed_and_passes_json_config(self):
        payload = {
            "key_facts": [
                {"claim": "Y happened.", "confidence": "medium", "caveat": "approximate date"},
            ],
            "open_questions": ["Was it deliberate?"],
            "suggested_angle": "A slow-burn reveal.",
        }
        response = MagicMock()
        response.parsed = payload
        response.text = "IRRELEVANT — must not be parsed when .parsed is present"
        sentinel_config = object()

        with patch("modules.research_engine.GEMINI_STRUCTURED_OUTPUT", True), patch(
            "modules.research_engine.json_config", return_value=sentinel_config
        ) as mock_cfg, patch(
            "modules.research_engine.make_client", return_value=MagicMock()
        ), patch(
            "modules.research_engine.generate_with_retry", return_value=response
        ) as mock_gen:
            brief = research_topic("The Antikythera Mechanism", niche="ancient tech")

        self.assertEqual(len(brief.key_facts), 1)
        self.assertEqual(brief.key_facts[0].confidence, "medium")
        self.assertEqual(brief.key_facts[0].caveat, "approximate date")
        self.assertTrue(mock_cfg.called)
        # The JSON-mode config, not the plain system config, reached the call.
        self.assertIs(mock_gen.call_args.args[3], sentinel_config)

    def test_falls_back_to_text_path_when_json_config_unavailable(self):
        # json_config returning None (no genai types) must NOT strand the call
        # in structured mode — it drops back to the system-instruction config
        # and text extraction, so the brief is still built.
        payload = {
            "key_facts": [{"claim": "Z.", "confidence": "low", "caveat": None}],
            "open_questions": [],
            "suggested_angle": "angle",
        }
        with patch("modules.research_engine.GEMINI_STRUCTURED_OUTPUT", True), patch(
            "modules.research_engine.json_config", return_value=None
        ), patch(
            "modules.research_engine.make_client", return_value=MagicMock()
        ), patch(
            "modules.research_engine.generate_with_retry",
            return_value=_mock_response(json.dumps(payload)),
        ):
            brief = research_topic("Topic")

        self.assertEqual(len(brief.key_facts), 1)
        self.assertEqual(brief.key_facts[0].confidence, "low")


class TestNoSourcesField(unittest.TestCase):
    def test_dataclasses_have_no_sources_field(self):
        fact_fields = ResearchFact.__dataclass_fields__.keys()
        brief_fields = ResearchBrief.__dataclass_fields__.keys()
        self.assertNotIn("sources", fact_fields)
        self.assertNotIn("citations", fact_fields)
        self.assertNotIn("sources", brief_fields)
        self.assertNotIn("citations", brief_fields)


if __name__ == "__main__":
    unittest.main()
