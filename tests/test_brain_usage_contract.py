"""Synthetic provider-neutral observations only; stdlib, no transport or SDK."""
from dataclasses import FrozenInstanceError, fields
import unittest

from modules.brain_usage_contract import (
    DISJOINT_V1, ModelIdentity, TokenCounts, normalize_usage,
)


class BrainUsageContractTests(unittest.TestCase):
    def setUp(self):
        self.identity = ModelIdentity("fake-provider", "requested@r1", "actual@r2")

    def test_measured_zero_is_distinct_from_missing(self):
        measured = normalize_usage(self.identity, outcome="success",
                                   counts=TokenCounts(uncached_input=0), semantics=DISJOINT_V1)
        missing = normalize_usage(self.identity, outcome="success")
        self.assertEqual((measured.status, measured.counts.uncached_input), ("reported", 0))
        self.assertEqual((missing.status, missing.counts.uncached_input), ("unknown", None))
        self.assertIsNone(measured.counts.visible_output)

    def test_every_counter_rejects_noninteger_negative_and_boolean(self):
        for field in fields(TokenCounts):
            for value in (-1, 1.0, "1", True, False):
                with self.subTest(field=field.name, value=value):
                    with self.assertRaisesRegex(ValueError, "invalid_token_count"):
                        TokenCounts(**{field.name: value})

    def test_disjoint_buckets_and_independent_total_are_never_added(self):
        counts = TokenCounts(11, 7, 3, 5, 2, 99)
        result = normalize_usage(self.identity, outcome="success", counts=counts,
                                 semantics=DISJOINT_V1)
        self.assertEqual(result.counts, counts)
        self.assertEqual(result.counts.reported_total, 99)

    def test_missing_total_stays_unknown_even_with_all_buckets(self):
        result = normalize_usage(self.identity, outcome="success",
                                 counts=TokenCounts(11, 7, 3, 5, 2), semantics=DISJOINT_V1)
        self.assertIsNone(result.counts.reported_total)

    def test_inclusive_or_missing_semantics_do_not_guess_a_mapping(self):
        for semantics in (None, "input-includes-cache", "output-includes-reasoning", "disjoint-v2"):
            with self.subTest(semantics=semantics):
                result = normalize_usage(self.identity, outcome="success",
                                         counts=TokenCounts(uncached_input=9), semantics=semantics)
                self.assertEqual(result.status, "unknown")
                self.assertEqual(result.counts, TokenCounts())

    def test_unknown_submitted_failure_never_becomes_zero_or_reported(self):
        result = normalize_usage(self.identity, outcome="ambiguous_failure",
                                 counts=TokenCounts(reported_total=0), semantics=DISJOINT_V1)
        self.assertEqual((result.status, result.reason), ("unknown", "ambiguous_failure"))
        self.assertIsNone(result.counts.reported_total)

    def test_known_failure_only_preserves_explicit_measurements(self):
        known = normalize_usage(self.identity, outcome="known_failure",
                                counts=TokenCounts(reported_total=4), semantics=DISJOINT_V1)
        missing = normalize_usage(self.identity, outcome="known_failure")
        self.assertEqual(known.counts.reported_total, 4)
        self.assertIsNone(missing.counts.reported_total)

    def test_provider_and_both_revisions_are_preserved_without_substitution(self):
        result = normalize_usage(self.identity, outcome="success")
        self.assertIs(result.identity, self.identity)
        self.assertEqual(result.identity.resolved_model_revision, "actual@r2")
        absent = ModelIdentity("fake", "requested@r1")
        self.assertIsNone(normalize_usage(absent, outcome="success").identity.resolved_model_revision)

    def test_invalid_identity_outcome_and_untyped_payload_are_rejected(self):
        for args in (("", "r"), ("p", " "), ("p", "r", "")):
            with self.assertRaises(ValueError):
                ModelIdentity(*args)
        for kwargs in ({"outcome": "timeout"}, {"outcome": "success", "counts": {"input": 1}}):
            with self.assertRaises(ValueError):
                normalize_usage(self.identity, **kwargs)

    def test_receipt_is_immutable_and_contains_no_response_or_error_text_slot(self):
        result = normalize_usage(self.identity, outcome="success")
        with self.assertRaises(FrozenInstanceError):
            result.status = "reported"
        self.assertEqual({f.name for f in fields(result)},
                         {"identity", "outcome", "counts", "semantics", "status", "reason"})


if __name__ == "__main__":
    unittest.main()
