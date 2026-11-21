"""Tests for modules.fact_checker — the advisory fact-checking engine.

`generate_with_retry` is always mocked here — these tests must never make a
live Gemini call.
"""

import json
import unittest
from unittest.mock import MagicMock, patch

from modules.fact_checker import (
    describe_response_shape,
    MAX_BATCH_SIZE,
    FactCheckResult,
    fact_check_claims,
)


def _response(text: str) -> MagicMock:
    resp = MagicMock()
    resp.text = text
    return resp


def _results_json(items: list[dict]) -> str:
    return json.dumps({"results": items}, ensure_ascii=False)


class FactCheckCleanBatchTests(unittest.TestCase):
    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_mixed_verdicts_set_requires_human_review_correctly(self, mock_gen, mock_make_client):
        claims = ["The sky is blue.", "The moon is made of cheese.", "Unclear claim."]
        mock_gen.return_value = _response(_results_json([
            {"index": 0, "verdict": "likely_accurate", "reasoning": "Well established."},
            {"index": 1, "verdict": "likely_inaccurate", "reasoning": "Contradicts basic astronomy."},
            {"index": 2, "verdict": "unverifiable", "reasoning": "Too vague to check."},
        ]))

        results = fact_check_claims(claims)

        self.assertEqual(len(results), 3)
        self.assertEqual(mock_gen.call_count, 1)

        self.assertEqual(results[0].verdict, "likely_accurate")
        self.assertFalse(results[0].requires_human_review)

        self.assertEqual(results[1].verdict, "likely_inaccurate")
        self.assertTrue(results[1].requires_human_review)

        self.assertEqual(results[2].verdict, "unverifiable")
        self.assertTrue(results[2].requires_human_review)

        # requires_human_review is False only for likely_accurate.
        for r in results:
            self.assertEqual(r.requires_human_review, r.verdict != "likely_accurate")

        # Order matches input order, and claim text is preserved.
        self.assertEqual([r.claim for r in results], claims)

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_invalid_verdict_string_is_clamped_to_unverifiable(self, mock_gen, mock_make_client):
        claims = ["Some claim."]
        mock_gen.return_value = _response(_results_json([
            {"index": 0, "verdict": "TOTALLY_TRUE_TRUST_ME", "reasoning": "n/a"},
        ]))

        results = fact_check_claims(claims)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].verdict, "unverifiable")
        self.assertTrue(results[0].requires_human_review)

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_empty_input_makes_no_api_call(self, mock_gen, mock_make_client):
        results = fact_check_claims([])
        self.assertEqual(results, [])
        mock_gen.assert_not_called()


class FactCheckSplitRetryTests(unittest.TestCase):
    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_mismatched_indices_trigger_split_and_retry(self, mock_gen, mock_make_client):
        claims = ["Claim A.", "Claim B.", "Claim C.", "Claim D."]

        # First call: missing index 3 entirely (mismatched/missing indices).
        bad_first = _response(_results_json([
            {"index": 0, "verdict": "likely_accurate", "reasoning": "ok"},
            {"index": 1, "verdict": "likely_accurate", "reasoning": "ok"},
            {"index": 2, "verdict": "likely_accurate", "reasoning": "ok"},
        ]))
        # Retry calls: one per half (2 claims each), both clean.
        left_half = _response(_results_json([
            {"index": 0, "verdict": "likely_accurate", "reasoning": "ok"},
            {"index": 1, "verdict": "likely_accurate", "reasoning": "ok"},
        ]))
        right_half = _response(_results_json([
            {"index": 0, "verdict": "likely_inaccurate", "reasoning": "no"},
            {"index": 1, "verdict": "unverifiable", "reasoning": "??"},
        ]))
        mock_gen.side_effect = [bad_first, left_half, right_half]

        results = fact_check_claims(claims)

        self.assertEqual(mock_gen.call_count, 3)
        # The retry calls must use a smaller batch than the original 4.
        for call in mock_gen.call_args_list[1:]:
            prompt = call.args[2]
            payload = json.loads(prompt.split("\n\n", 1)[1])
            self.assertLess(len(payload["claims"]), 4)
            self.assertEqual(len(payload["claims"]), 2)

        self.assertEqual(len(results), 4)
        self.assertEqual([r.claim for r in results], claims)
        self.assertEqual(results[0].verdict, "likely_accurate")
        self.assertEqual(results[1].verdict, "likely_accurate")
        self.assertEqual(results[2].verdict, "likely_inaccurate")
        self.assertEqual(results[3].verdict, "unverifiable")

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_malformed_json_triggers_retry_then_safe_default_if_still_bad(self, mock_gen, mock_make_client):
        claims = ["Claim A.", "Claim B."]

        malformed = _response("this is not { valid json at all")
        # After split, one half resolves cleanly, the other is still malformed.
        left_half_ok = _response(_results_json([
            {"index": 0, "verdict": "likely_accurate", "reasoning": "ok"},
        ]))
        right_half_still_bad = _response("still not json")
        mock_gen.side_effect = [malformed, left_half_ok, right_half_still_bad]

        results = fact_check_claims(claims)

        self.assertEqual(mock_gen.call_count, 3)
        self.assertEqual(len(results), 2)

        self.assertEqual(results[0].verdict, "likely_accurate")
        self.assertFalse(results[0].requires_human_review)

        # The still-malformed half never got a further split (retry only
        # happens once) — it falls back to the safe-default sentinel rather
        # than raising.
        self.assertEqual(results[1].claim, "Claim B.")
        self.assertEqual(results[1].verdict, "unverifiable")
        self.assertTrue(results[1].requires_human_review)

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_never_raises_on_persistently_malformed_response(self, mock_gen, mock_make_client):
        claims = ["Claim A.", "Claim B.", "Claim C."]
        mock_gen.return_value = _response("garbage, not json")

        # Should not raise despite every call returning garbage.
        results = fact_check_claims(claims)

        self.assertEqual(len(results), 3)
        for r in results:
            self.assertEqual(r.verdict, "unverifiable")
            self.assertTrue(r.requires_human_review)


class FactCheckForgivingIndexTests(unittest.TestCase):
    """The readings added after a real run flagged 37/37 claims.

    Every batch of that run came back unusable, down to batches of three, so the
    gate blocked a video whose claims had never actually been judged. These are
    the shapes the parser now accepts — each still order-independent, none able
    to mark a claim accurate that the model did not.
    """

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_string_indices_are_accepted(self, mock_gen, mock_make_client):
        mock_gen.return_value = _response(_results_json([
            {"index": "0", "verdict": "likely_accurate", "reasoning": "ok"},
            {"index": "1", "verdict": "unverifiable", "reasoning": "hmm"},
        ]))
        results = fact_check_claims(["a", "b"])
        self.assertEqual(mock_gen.call_count, 1)  # no split-and-retry needed
        self.assertEqual([r.verdict for r in results], ["likely_accurate", "unverifiable"])

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_one_based_indices_are_shifted_not_rejected(self, mock_gen, mock_make_client):
        mock_gen.return_value = _response(_results_json([
            {"index": 1, "verdict": "likely_accurate", "reasoning": "first claim"},
            {"index": 2, "verdict": "likely_inaccurate", "reasoning": "second claim"},
        ]))
        results = fact_check_claims(["a", "b"])
        self.assertEqual(mock_gen.call_count, 1)
        # Shifted, not reordered: index 1 is the first claim.
        self.assertEqual(results[0].verdict, "likely_accurate")
        self.assertEqual(results[1].verdict, "likely_inaccurate")

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_missing_indices_fall_back_to_position(self, mock_gen, mock_make_client):
        mock_gen.return_value = _response(_results_json([
            {"verdict": "likely_accurate", "reasoning": "first"},
            {"verdict": "unverifiable", "reasoning": "second"},
        ]))
        results = fact_check_claims(["a", "b"])
        self.assertEqual([r.verdict for r in results], ["likely_accurate", "unverifiable"])

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_a_partial_answer_is_not_matched_by_position(self, mock_gen, mock_make_client):
        # Two claims, one result. Position cannot say WHICH claim was answered,
        # so this batch must not resolve — it must split instead. (Each half is
        # then a batch of one, where one result is unambiguous; that is the
        # split-and-retry working, not a positional guess.)
        mock_gen.return_value = _response(_results_json([
            {"verdict": "likely_accurate", "reasoning": "only one"},
        ]))
        fact_check_claims(["a", "b"])
        self.assertGreater(mock_gen.call_count, 1, "the mismatched batch should have split")

    def test_a_bool_is_never_read_as_an_index(self):
        # bool is an int in Python, so True would silently mean index 1.
        from modules.fact_checker import _coerce_index

        self.assertIsNone(_coerce_index(True))
        self.assertIsNone(_coerce_index(False))
        self.assertEqual(_coerce_index(0), 0)
        self.assertEqual(_coerce_index("2"), 2)
        self.assertEqual(_coerce_index(" 3 "), 3)
        self.assertIsNone(_coerce_index("two"))
        self.assertIsNone(_coerce_index(None))

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_unusable_indices_with_a_full_count_fall_back_to_position(self, mock_gen, mock_make_client):
        # Indices present but meaningless (bools), one result per claim: this is
        # the positional path, and it resolves rather than blocking the publish.
        mock_gen.return_value = _response(_results_json([
            {"index": True, "verdict": "likely_accurate", "reasoning": "first"},
            {"index": False, "verdict": "unverifiable", "reasoning": "second"},
        ]))
        results = fact_check_claims(["a", "b"])
        self.assertEqual([r.verdict for r in results], ["likely_accurate", "unverifiable"])


class FactCheckShapeReportTests(unittest.TestCase):
    """The diagnosis line. It must say which failure it was — and quote none of it."""

    def test_each_failure_names_itself(self):
        self.assertIn("not parseable as JSON", describe_response_shape("nonsense", 2))
        # No list anywhere: 'results' holds an object and nothing else is a list.
        self.assertIn("no usable list of results",
                      describe_response_shape('{"results": {}}', 2))
        # Two candidates, so choosing one would be a guess.
        self.assertIn("no unambiguous choice",
                      describe_response_shape('{"a": [1], "b": [2]}', 2))

    def test_a_non_standard_envelope_is_named_in_the_diagnosis(self):
        # These two now parse, so the line reports the counts — but it says
        # which wrapper it had to read, because that is the thing worth fixing
        # in the prompt.
        self.assertIn("a bare top-level list", describe_response_shape("[1, 2]", 2))
        self.assertIn("'verdicts'", describe_response_shape('{"verdicts": []}', 2))
        # The expected envelope is unremarkable and goes unmentioned.
        plain = describe_response_shape(_results_json([{"index": 0}]), 1)
        self.assertNotIn("read from", plain)

        one_based = _results_json([
            {"index": 1, "verdict": "likely_accurate", "reasoning": "x"},
            {"index": 2, "verdict": "likely_accurate", "reasoning": "x"},
        ])
        described = describe_response_shape(one_based, 2)
        self.assertIn("2 result(s) for 2 claim(s)", described)
        self.assertIn("[1, 2]", described)

    def test_it_never_quotes_the_claim_or_the_reasoning(self):
        # This string is logged, so it may describe the response and never
        # reproduce it: claims come from a generated script.
        payload = _results_json([
            {"index": 9, "verdict": "SECRET-VERDICT", "reasoning": "SECRET-REASONING"},
        ])
        described = describe_response_shape(payload, 1)
        self.assertNotIn("SECRET-VERDICT", described)
        self.assertNotIn("SECRET-REASONING", described)


class FactCheckEnvelopeTests(unittest.TestCase):
    """The wrappers that cost run #8.

    That run flagged 29 of 29 claims. The batch of 29 came back as a bare
    top-level list; the batch of 14 came back under 'claims', the key the
    *request* had used. Both carried real verdicts, and both were thrown away.
    """

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_a_bare_top_level_list_is_read(self, mock_gen, mock_make_client):
        mock_gen.return_value = _response(json.dumps([
            {"index": 0, "verdict": "likely_accurate", "reasoning": "ok"},
            {"index": 1, "verdict": "likely_inaccurate", "reasoning": "no"},
        ]))
        results = fact_check_claims(["a", "b"])
        self.assertEqual(mock_gen.call_count, 1)  # no split-and-retry
        self.assertEqual([r.verdict for r in results],
                         ["likely_accurate", "likely_inaccurate"])

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_the_request_key_echoed_back_is_read(self, mock_gen, mock_make_client):
        mock_gen.return_value = _response(json.dumps({"claims": [
            {"index": 0, "verdict": "likely_accurate", "reasoning": "ok"},
            {"index": 1, "verdict": "unverifiable", "reasoning": "hmm"},
        ]}))
        results = fact_check_claims(["a", "b"])
        self.assertEqual(mock_gen.call_count, 1)
        self.assertEqual([r.verdict for r in results],
                         ["likely_accurate", "unverifiable"])

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_two_list_valued_keys_are_refused_rather_than_guessed(
            self, mock_gen, mock_make_client):
        # Picking one of these would be invention, so the batch splits and
        # then falls back to the safe default.
        mock_gen.return_value = _response(json.dumps({
            "drafts": [{"index": 0, "verdict": "likely_accurate"}],
            "final": [{"index": 0, "verdict": "likely_inaccurate"}],
        }))
        results = fact_check_claims(["a", "b"])
        self.assertTrue(all(r.verdict == "unverifiable" for r in results))
        self.assertTrue(all(r.requires_human_review for r in results))

    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_a_bare_list_still_cannot_invent_a_missing_answer(
            self, mock_gen, mock_make_client):
        # One result for two claims. The envelope is now readable, which does
        # not make the answer complete: the batch must still split rather than
        # map that single verdict onto both claims.
        mock_gen.return_value = _response(json.dumps([
            {"index": 0, "verdict": "likely_accurate", "reasoning": "ok"},
        ]))
        results = fact_check_claims(["a", "b"])
        self.assertEqual(len(results), 2)
        self.assertGreater(mock_gen.call_count, 1)  # refused as a batch of two


class FactCheckBatchingMathTests(unittest.TestCase):
    @patch("modules.fact_checker.make_client")
    @patch("modules.fact_checker.generate_with_retry")
    def test_seventy_claims_split_into_expected_batch_chunks(self, mock_gen, mock_make_client):
        claims = [f"Claim number {i}." for i in range(70)]

        # Build one canned clean response per call, sized to whatever batch
        # it receives.
        def side_effect(client, model, prompt, config=None):
            payload = json.loads(prompt.split("\n\n", 1)[1])
            n = len(payload["claims"])
            items = [
                {"index": i, "verdict": "likely_accurate", "reasoning": "ok"}
                for i in range(n)
            ]
            return _response(_results_json(items))

        mock_gen.side_effect = side_effect

        results = fact_check_claims(claims)

        self.assertEqual(len(results), 70)
        # ceil(70 / MAX_BATCH_SIZE) batches expected.
        expected_calls = -(-70 // MAX_BATCH_SIZE)
        self.assertEqual(mock_gen.call_count, expected_calls)

        seen_sizes = []
        for call in mock_gen.call_args_list:
            prompt = call.args[2]
            payload = json.loads(prompt.split("\n\n", 1)[1])
            seen_sizes.append(len(payload["claims"]))
            self.assertLessEqual(len(payload["claims"]), MAX_BATCH_SIZE)

        self.assertEqual(sum(seen_sizes), 70)


class FactCheckResultDataclassTests(unittest.TestCase):
    def test_dataclass_fields(self):
        r = FactCheckResult(
            claim="x", verdict="likely_accurate", reasoning="y",
            requires_human_review=False,
        )
        self.assertEqual(r.claim, "x")
        self.assertEqual(r.verdict, "likely_accurate")
        self.assertEqual(r.reasoning, "y")
        self.assertFalse(r.requires_human_review)


if __name__ == "__main__":
    unittest.main()
