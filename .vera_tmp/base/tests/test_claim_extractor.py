"""Tests for modules.claim_extractor — heuristic claim extraction.

No Gemini call is involved in this module's extraction path (sentence-
splitting, not an LLM pass), so nothing here mocks generate_with_retry.
"""

import unittest
from dataclasses import dataclass, field

from modules.claim_extractor import extract_claims
from modules.fact_checker import fact_check_claims


# --- Minimal fakes matching the real Script/ScriptSection shape ------------
#
# Mirrors modules.script_engine.ScriptSection / Script closely enough for
# extract_claims's duck-typing (full_narration() / clean_narration()) to
# exercise the same path it would against the real classes, without
# importing script_engine itself (kept independent, same loose-coupling
# stance fact_checker.py documents for its own input contract).

@dataclass
class FakeSection:
    narration: str

    def clean_narration(self) -> str:
        return self.narration.strip()


@dataclass
class FakeScript:
    sections: list = field(default_factory=list)

    def full_narration(self) -> str:
        return "\n\n".join(s.clean_narration() for s in self.sections)


class SentenceExtractionTests(unittest.TestCase):
    def test_several_clear_factual_sentences_extract_separately(self):
        script = FakeScript(sections=[
            FakeSection(
                "The Titanic sank in 1912 after striking an iceberg. "
                "Over 1500 passengers died in the disaster. "
                "The wreck was discovered in 1985 by Robert Ballard."
            ),
        ])

        claims = extract_claims(script)

        self.assertEqual(claims, [
            "The Titanic sank in 1912 after striking an iceberg.",
            "Over 1500 passengers died in the disaster.",
            "The wreck was discovered in 1985 by Robert Ballard.",
        ])

    def test_claims_span_multiple_sections(self):
        script = FakeScript(sections=[
            FakeSection("The pyramid was built over twenty years by skilled laborers."),
            FakeSection("Archaeologists found gold artifacts inside the tomb chamber."),
        ])

        claims = extract_claims(script)

        self.assertEqual(claims, [
            "The pyramid was built over twenty years by skilled laborers.",
            "Archaeologists found gold artifacts inside the tomb chamber.",
        ])


class AbbreviationAndDecimalTests(unittest.TestCase):
    def test_abbreviation_and_decimal_do_not_cause_spurious_split(self):
        script = FakeScript(sections=[
            FakeSection("Dr. Smith found 3.5 million artifacts at the site."),
        ])

        claims = extract_claims(script)

        self.assertEqual(claims, [
            "Dr. Smith found 3.5 million artifacts at the site.",
        ])

    def test_multiple_abbreviations_and_decimals_across_sentences(self):
        script = FakeScript(sections=[
            FakeSection(
                "Prof. Lin estimated the treasure at 2.3 billion dollars. "
                "The U.S. later disputed that figure entirely."
            ),
        ])

        claims = extract_claims(script)

        self.assertEqual(claims, [
            "Prof. Lin estimated the treasure at 2.3 billion dollars.",
            "The U.S. later disputed that figure entirely.",
        ])


class NonClaimFilterTests(unittest.TestCase):
    def test_pure_questions_are_filtered_out(self):
        script = FakeScript(sections=[
            FakeSection(
                "But who hid the treasure? "
                "We'll get to that at the very end. "
                "The ship carried over 200 crew members aboard."
            ),
        ])

        claims = extract_claims(script)

        # The question is dropped outright; "We'll get to that..." is
        # filtered by the documented CTA/open-loop phrase heuristic even
        # though it doesn't end in "?". Only the factual sentence remains.
        self.assertEqual(claims, [
            "The ship carried over 200 crew members aboard.",
        ])
        self.assertFalse(any(c.endswith("?") for c in claims))

    def test_short_fragments_are_filtered_out(self):
        script = FakeScript(sections=[
            FakeSection("Wow. No way. The battle lasted three full days across the valley."),
        ])

        claims = extract_claims(script)

        self.assertEqual(claims, [
            "The battle lasted three full days across the valley.",
        ])

    def test_cta_phrases_are_filtered_out(self):
        script = FakeScript(sections=[
            FakeSection(
                "The empire collapsed within a single decade of the invasion. "
                "Don't forget to subscribe and hit the bell for more history."
            ),
        ])

        claims = extract_claims(script)

        self.assertEqual(claims, [
            "The empire collapsed within a single decade of the invasion.",
        ])


class EmptyInputTests(unittest.TestCase):
    def test_empty_script_returns_empty_list(self):
        self.assertEqual(extract_claims(FakeScript(sections=[])), [])

    def test_whitespace_only_script_returns_empty_list(self):
        script = FakeScript(sections=[FakeSection("   \n\n  ")])
        self.assertEqual(extract_claims(script), [])

    def test_empty_string_input_returns_empty_list(self):
        self.assertEqual(extract_claims(""), [])

    def test_none_input_returns_empty_list(self):
        self.assertEqual(extract_claims(None), [])

    def test_plain_string_input_is_accepted_directly(self):
        claims = extract_claims("The bridge collapsed after only six months of use.")
        self.assertEqual(claims, [
            "The bridge collapsed after only six months of use.",
        ])


class FactCheckerInteropTests(unittest.TestCase):
    """Confirm extract_claims's output feeds cleanly into fact_check_claims.

    No live Gemini call is made or needed here — fact_check_claims itself
    only makes an API call when given a non-empty claims list, so this just
    confirms the empty-input contract lines up without mocking anything.
    """

    def test_output_type_matches_fact_check_claims_input_contract(self):
        script = FakeScript(sections=[
            FakeSection("The comet passed within 500000 kilometers of Earth."),
        ])

        claims = extract_claims(script)

        self.assertIsInstance(claims, list)
        self.assertTrue(all(isinstance(c, str) for c in claims))

    def test_empty_claims_list_short_circuits_fact_check_with_no_api_call(self):
        # extract_claims on an empty script returns [], and fact_check_claims
        # is documented to return [] for empty input without calling the
        # API — so this exercises the real integration path with no mocking
        # required.
        claims = extract_claims(FakeScript(sections=[]))
        self.assertEqual(fact_check_claims(claims), [])


if __name__ == "__main__":
    unittest.main()
