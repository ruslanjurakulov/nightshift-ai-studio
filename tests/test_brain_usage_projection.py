"""Synthetic declared mappings only; no authority, ledger or vendor access."""
from dataclasses import fields, replace
import unittest
from unittest.mock import patch

from modules.brain_usage_contract import DISJOINT_V1, ModelIdentity, TokenCounts, UsageObservation, normalize_usage
from modules.brain_usage_projection import (
    CounterBinding, EvidenceReference, ProjectionContract, UsageProjection, project_usage,
)


class UsageProjectionTests(unittest.TestCase):
    def setUp(self):
        self.identity = ModelIdentity("synthetic", "requested@1", "resolved@2")
        self.evidence = EvidenceReference("synthetic", "resolved@2", "fixture-evidence", "mapper@3")
        self.contract = ProjectionContract("synthetic", "resolved@2", "mapper@3", "mapping@4",
                                           DISJOINT_V1, (CounterBinding("uncached_input", "fixture_input", True),
                                                         CounterBinding("visible_output", "fixture_output", True)))

    def observation(self, counts=None, outcome="success", semantics=DISJOINT_V1):
        return normalize_usage(self.identity, outcome=outcome, counts=counts, semantics=semantics)

    def project(self, counts, **kwargs):
        return project_usage(self.observation(counts, **kwargs), self.contract, evidence=self.evidence)

    def test_measured_zero_is_a_row_but_missing_required_counter_is_a_gap(self):
        p = self.project(TokenCounts(uncached_input=0))
        self.assertEqual([(r.counter, r.quantity) for r in p.rows], [("uncached_input", 0)])
        self.assertEqual((p.projected_component_tokens, p.coverage), (0, "partial"))
        self.assertEqual(p.gaps, ("missing:visible_output",))
        self.assertIsNone(p.observation.counts.visible_output)

    def test_disjoint_addition_preserves_integer_precision_and_ignores_reported_total(self):
        large = 2**80 + 1
        p = self.project(TokenCounts(uncached_input=large, visible_output=3, reported_total=99))
        self.assertEqual(p.projected_component_tokens, large + 3)
        self.assertIs(type(p.projected_component_tokens), int)
        self.assertEqual(p.observation.counts.reported_total, 99)
        self.assertEqual(p.coverage, "complete_for_declared_contract")
        self.assertNotIn("reported_total", [r.counter for r in p.rows])

    def test_unknown_usage_and_ambiguous_failure_never_become_zero(self):
        for observation in (self.observation(), self.observation(TokenCounts(reported_total=0), "ambiguous_failure")):
            with self.subTest(reason=observation.reason):
                p = project_usage(observation, self.contract, evidence=self.evidence)
                self.assertEqual((p.rows, p.coverage, p.projected_component_tokens), ((), "unknown", None))

    def test_inclusive_or_unavailable_semantics_stay_unknown(self):
        for semantics in (None, "input-includes-cache", "output-includes-reasoning"):
            with self.subTest(semantics=semantics):
                p = self.project(TokenCounts(uncached_input=4), semantics=semantics)
                self.assertEqual(p.coverage, "unknown")
                self.assertEqual(p.rows, ())

    def test_unmapped_measured_cache_or_reasoning_is_preserved_and_marks_partial(self):
        p = self.project(TokenCounts(uncached_input=3, visible_output=4, cache_read=2, reasoning=0))
        self.assertEqual(p.gaps, ("unmapped:cache_read", "unmapped:reasoning"))
        self.assertEqual((p.observation.counts.cache_read, p.observation.counts.reasoning), (2, 0))
        self.assertEqual((p.coverage, p.projected_component_tokens), ("partial", 7))

    def test_all_five_declared_components_are_added_once_without_total(self):
        names = ("uncached_input", "cache_read", "cache_write", "visible_output", "reasoning")
        contract = replace(self.contract, bindings=tuple(CounterBinding(n, "fixture_" + n, True) for n in names))
        observation = self.observation(TokenCounts(11, 7, 3, 5, 2, 999))
        p = project_usage(observation, contract, evidence=self.evidence)
        self.assertEqual([r.counter for r in p.rows], list(names))
        self.assertEqual((p.projected_component_tokens, p.coverage, p.gaps),
                         (28, "complete_for_declared_contract", ()))

    def test_projection_never_reads_price_or_calls_a_ledger_or_transport(self):
        observation = self.observation(TokenCounts(uncached_input=2, visible_output=3))
        with patch("os.getenv", side_effect=AssertionError("environment forbidden")), \
             patch("modules.cost_ledger.CostLedger.add", side_effect=AssertionError("ledger forbidden")), \
             patch("modules.cost_ledger.CostLedger.flush", side_effect=AssertionError("write forbidden")), \
             patch("socket.create_connection", side_effect=AssertionError("network forbidden")), \
             patch("socket.socket", side_effect=AssertionError("transport forbidden")):
            p = project_usage(observation, self.contract, evidence=self.evidence)
        self.assertEqual(p.projected_component_tokens, 5)

    def test_no_residual_is_inferred_from_diagnostic_total(self):
        p = self.project(TokenCounts(reported_total=9))
        self.assertEqual((p.rows, p.coverage, p.projected_component_tokens), ((), "unknown", None))
        self.assertEqual(p.observation.counts.reported_total, 9)
        self.assertEqual(p.gaps, ("missing:uncached_input", "missing:visible_output"))

    def test_missing_optional_counter_is_complete_only_for_declared_contract(self):
        contract = replace(self.contract, bindings=(self.contract.bindings[0],
                           CounterBinding("visible_output", "fixture_output", False)))
        p = project_usage(self.observation(TokenCounts(uncached_input=2)), contract, evidence=self.evidence)
        self.assertEqual((p.coverage, p.gaps), ("complete_for_declared_contract", ()))
        self.assertIsNone(p.observation.counts.visible_output)

    def test_matching_provider_is_insufficient_without_resolved_revision_and_evidence(self):
        observation = self.observation(TokenCounts(uncached_input=1, visible_output=1))
        p = project_usage(observation, self.contract)
        self.assertEqual((p.rows, p.gaps), ((), ("evidence_unavailable",)))
        for identity in (replace(self.identity, resolved_model_revision=None),
                         replace(self.identity, resolved_model_revision="other@revision"),
                         replace(self.identity, provider="other-provider")):
            p = project_usage(replace(observation, identity=identity), self.contract, evidence=self.evidence)
            self.assertEqual((p.rows, p.coverage), ((), "unknown"))
            self.assertEqual(p.observation.identity, identity)

    def test_evidence_provider_revision_and_mapper_bindings_are_separate_checks(self):
        observation = self.observation(TokenCounts(uncached_input=1))
        for change in ({"provider": "other"}, {"resolved_model_revision": "other@2"}, {"mapper_revision": "other@3"}):
            evidence = replace(self.evidence, **change)
            p = project_usage(observation, self.contract, evidence=evidence)
            self.assertEqual((p.rows, p.gaps), ((), ("provenance_binding_mismatch",)))
            self.assertIs(p.evidence, evidence)

    def test_known_failure_preserves_explicit_measured_quantities_only(self):
        p = self.project(TokenCounts(uncached_input=2, visible_output=0), outcome="known_failure")
        self.assertEqual((p.coverage, p.projected_component_tokens), ("complete_for_declared_contract", 2))
        self.assertEqual([r.quantity for r in p.rows], [2, 0])

    def test_inconsistent_direct_dataclass_cannot_claim_reported_usage(self):
        unknown = self.observation()
        invalid = (replace(unknown, status="reported"), replace(unknown, reason="made_up"),
                   UsageObservation(self.identity, "success", TokenCounts(uncached_input=1), None, "reported", None))
        for observation in invalid:
            with self.assertRaises(ValueError):
                project_usage(observation, self.contract, evidence=self.evidence)

    def test_invalid_counts_fail_before_projection(self):
        for counter in fields(TokenCounts):
            for value in (-1, True, 1.5, "2"):
                with self.subTest(counter=counter.name, value=value):
                    with self.assertRaises(ValueError):
                        self.project(TokenCounts(**{counter.name: value}))

    def test_mapping_rejects_total_inclusive_semantics_and_duplicate_unit_or_counter(self):
        with self.assertRaises(ValueError):
            CounterBinding("reported_total", "fixture_total", True)
        with self.assertRaises(ValueError):
            replace(self.contract, semantics="inclusive")
        for bindings in ((self.contract.bindings[0], self.contract.bindings[0]),
                         (self.contract.bindings[0], CounterBinding("reasoning", "fixture_input", True))):
            with self.assertRaises(ValueError):
                replace(self.contract, bindings=bindings)

    def test_projection_exposes_no_quote_price_or_write_interface_and_is_deterministic(self):
        observation = self.observation(TokenCounts(uncached_input=0, visible_output=0))
        first = project_usage(observation, self.contract, evidence=self.evidence)
        self.assertEqual(first, project_usage(observation, self.contract, evidence=self.evidence))
        self.assertEqual({f.name for f in fields(UsageProjection)},
                         {"observation", "evidence", "mapping_ref", "rows", "gaps", "coverage", "projected_component_tokens"})
        self.assertEqual((first.projected_component_tokens, first.coverage), (0, "complete_for_declared_contract"))


if __name__ == "__main__":
    unittest.main()
