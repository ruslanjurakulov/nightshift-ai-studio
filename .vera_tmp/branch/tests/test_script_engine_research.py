"""Tests for the ResearchBrief -> prompt wiring in modules.script_engine.

Scope is deliberately narrow: only the new `research_brief` parameter and
the `_format_research_notes` / `_build_prompt` helpers it introduces. This
file does not attempt to cover ScriptEngine.generate()'s pre-existing
(previously untested) behavior beyond a regression guard that the prompt is
unchanged when `research_brief` is omitted.

generate_with_retry is always mocked, matching modules/test_research_engine.py
— no network access or API key is required to run this file.
"""

import unittest
from unittest.mock import MagicMock, patch

from modules.research_engine import ResearchBrief, ResearchFact
from modules.script_engine import ScriptEngine, _format_research_notes


class TestBuildPromptBackwardCompatible(unittest.TestCase):
    def test_no_research_brief_matches_prior_prompt_shape(self):
        """Regression guard: omitting research_brief must not change the
        prompt at all versus the pre-existing (no-research-brief) behavior."""
        prompt_without_default = ScriptEngine._build_prompt("The Roman Empire")
        prompt_without_explicit_none = ScriptEngine._build_prompt(
            "The Roman Empire", research_brief=None
        )

        self.assertEqual(prompt_without_default, prompt_without_explicit_none)
        self.assertNotIn("Research notes", prompt_without_default)
        self.assertIn("Topic: The Roman Empire", prompt_without_default)
        self.assertTrue(
            prompt_without_default.endswith(
                "Include at least 6 sections, 2 open loops, and multiple "
                "[PAUSE], [SFX], [MUSIC] cues."
            )
        )


class TestBuildPromptWithResearchBrief(unittest.TestCase):
    def test_facts_confidence_and_angle_appear_in_prompt(self):
        brief = ResearchBrief(
            topic="The Library of Alexandria",
            key_facts=[
                ResearchFact(claim="The library burned in antiquity.", confidence="high"),
                ResearchFact(
                    claim="It housed roughly 400,000 scrolls.",
                    confidence="medium",
                    caveat="estimate varies widely by source",
                ),
            ],
            open_questions=["Whether the fire was deliberate or accidental is disputed."],
            suggested_angle="Frame it as an unsolved-mystery whodunit around the fire.",
        )

        prompt = ScriptEngine._build_prompt("The Library of Alexandria", research_brief=brief)

        self.assertIn("Research notes (unverified", prompt)
        self.assertIn("The library burned in antiquity.", prompt)
        self.assertIn("[high]", prompt)
        self.assertIn("It housed roughly 400,000 scrolls.", prompt)
        self.assertIn("[medium]", prompt)
        self.assertIn("estimate varies widely by source", prompt)
        self.assertIn(
            "Whether the fire was deliberate or accidental is disputed.", prompt
        )
        self.assertIn(
            "Frame it as an unsolved-mystery whodunit around the fire.", prompt
        )

    def test_prompt_does_not_claim_facts_are_verified(self):
        brief = ResearchBrief(
            topic="X",
            key_facts=[ResearchFact(claim="Something happened.", confidence="high")],
        )
        prompt = ScriptEngine._build_prompt("X", research_brief=brief)

        self.assertIn("unverified", prompt.lower())
        self.assertIn("verify anything", prompt.lower())


class TestFormatResearchNotesEdgeCases(unittest.TestCase):
    def test_none_brief_returns_empty_string(self):
        self.assertEqual(_format_research_notes(None), "")

    def test_empty_brief_does_not_crash_and_is_sensible(self):
        brief = ResearchBrief(topic="Obscure Topic")  # empty key_facts, open_questions, angle

        notes = _format_research_notes(brief)

        self.assertIsInstance(notes, str)
        self.assertIn("Research notes", notes)
        # No facts, no questions, no angle recalled -> none of those sections'
        # substantive content should be fabricated.
        self.assertNotIn("Suggested editorial angle", notes)
        self.assertNotIn("Open questions", notes)


class TestGenerateStillWorksWithoutResearchBrief(unittest.TestCase):
    def _mock_response(self, payload_json: str) -> MagicMock:
        response = MagicMock()
        response.text = payload_json
        return response

    def test_generate_without_research_brief_unchanged(self):
        payload = (
            '{"title": "T", "title_ab": "TA", "description": "D", "tags": [], '
            '"hook_sentence": "H", "thumbnail_prompt_a": "A", '
            '"thumbnail_prompt_b": "B", "thumbnail_overlay_text": "O", '
            '"open_loops": [], "sections": []}'
        )
        fake_pa = MagicMock()
        fake_pa.analyze_videos_as_prompt_text.return_value = ""
        with patch("modules.script_engine.make_client", return_value=MagicMock()), patch(
            "modules.script_engine.PerformanceAnalyzer", return_value=fake_pa
        ), patch(
            "modules.script_engine.generate_with_retry",
            return_value=self._mock_response(payload),
        ) as mock_gen:
            engine = ScriptEngine()
            script = engine.generate("Some Topic")

        self.assertEqual(script.title, "T")
        self.assertTrue(mock_gen.called)
        # The prompt passed to Gemini must not mention research notes.
        called_prompt = mock_gen.call_args[0][2]
        self.assertNotIn("Research notes", called_prompt)

    def test_generate_with_research_brief_includes_notes_in_call(self):
        payload = (
            '{"title": "T", "title_ab": "TA", "description": "D", "tags": [], '
            '"hook_sentence": "H", "thumbnail_prompt_a": "A", '
            '"thumbnail_prompt_b": "B", "thumbnail_overlay_text": "O", '
            '"open_loops": [], "sections": []}'
        )
        brief = ResearchBrief(
            topic="Some Topic",
            key_facts=[ResearchFact(claim="A recalled claim.", confidence="low")],
            suggested_angle="A recalled angle.",
        )
        fake_pa = MagicMock()
        fake_pa.analyze_videos_as_prompt_text.return_value = ""
        with patch("modules.script_engine.make_client", return_value=MagicMock()), patch(
            "modules.script_engine.PerformanceAnalyzer", return_value=fake_pa
        ), patch(
            "modules.script_engine.generate_with_retry",
            return_value=self._mock_response(payload),
        ) as mock_gen:
            engine = ScriptEngine()
            engine.generate("Some Topic", research_brief=brief)

        called_prompt = mock_gen.call_args[0][2]
        self.assertIn("A recalled claim.", called_prompt)
        self.assertIn("[low]", called_prompt)
        self.assertIn("A recalled angle.", called_prompt)


if __name__ == "__main__":
    unittest.main()
