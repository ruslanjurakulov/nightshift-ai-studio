"""Synthetic adapters only; reuse the existing series planner fixture and network fence."""
import unittest
from unittest.mock import Mock

from modules.series_provider_selection import (
    PLANNING_CAPABILITY, PlanningAdapter, PlanningSelectionError, select_series_generator,
)
from modules.series_planner import SeriesPlanError
from tests.test_series_planner import Gen, NoNetwork, answer, plan


def registered(provider, generate, *, model_ref="synthetic-pinned-revision", capabilities=None):
    return PlanningAdapter(provider, model_ref, generate,
                           frozenset({PLANNING_CAPABILITY}) if capabilities is None else capabilities)


class SeriesProviderSelectionTests(NoNetwork):
    def test_gemini_default_is_the_original_callable_without_invoking_it(self):
        gemini = Mock()
        self.assertIs(select_series_generator(gemini), gemini)
        gemini.assert_not_called()

    def test_default_does_not_select_an_external_registration(self):
        gemini, external = Mock(), Mock()
        adapters = {"openai": registered("openai", external)}
        self.assertIs(select_series_generator(gemini, adapters=adapters), gemini)
        gemini.assert_not_called()
        external.assert_not_called()

    def test_each_explicit_provider_uses_one_call_and_the_existing_parser_and_vetting(self):
        outcomes = []
        for provider in ("gemini", "openai", "claude"):
            with self.subTest(provider=provider):
                generators = {name: Gen(answer(3)) for name in ("gemini", "openai", "claude")}
                adapters = {name: registered(name, generators[name]) for name in ("openai", "claude")}
                generate = select_series_generator(generators["gemini"], provider=provider, adapters=adapters)
                result = plan(generate=generate)
                outcomes.append(result.to_dict())
                self.assertFalse(result.fact_checked)
                self.assertEqual(result.plan_calls_made, 1)
                self.assertEqual(len(generators[provider].calls), 1)
                self.assertEqual(generators[provider].calls[0][1], "series_plan")
                self.assertTrue(all(not g.calls for name, g in generators.items() if name != provider))
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(outcomes[1], outcomes[2])

    def test_missing_external_adapter_does_not_fall_back_to_gemini(self):
        gemini = Mock()
        for provider in ("openai", "claude"):
            with self.subTest(provider=provider), self.assertRaises(PlanningSelectionError) as caught:
                select_series_generator(gemini, provider=provider)
            self.assertEqual(caught.exception.code, "model_unavailable")
        gemini.assert_not_called()

    def test_unknown_names_and_aliases_do_not_choose_a_provider(self):
        gemini = Mock()
        for provider in ("", "anthropic", "OpenAI", "gemini "):
            with self.subTest(provider=provider), self.assertRaises(PlanningSelectionError) as caught:
                select_series_generator(gemini, provider=provider)
            self.assertEqual(caught.exception.code, "model_unavailable")
        gemini.assert_not_called()

    def test_provider_binding_and_exact_model_reference_are_required(self):
        gemini, external = Mock(), Mock()
        for adapter in (registered("claude", external), registered("openai", external, model_ref="")):
            with self.assertRaises(PlanningSelectionError) as caught:
                select_series_generator(gemini, provider="openai", adapters={"openai": adapter})
            self.assertEqual(caught.exception.code, "model_unavailable")
        external.assert_not_called()
        gemini.assert_not_called()

    def test_undeclared_planning_capability_is_closed_before_generation(self):
        gemini, external = Mock(), Mock()
        with self.assertRaises(PlanningSelectionError) as caught:
            select_series_generator(gemini, provider="openai", adapters={
                "openai": registered("openai", external, capabilities=frozenset()),
            })
        self.assertEqual(caught.exception.code, "policy_denied")
        external.assert_not_called()
        gemini.assert_not_called()

    def test_selected_failure_keeps_existing_planner_error_and_never_tries_another_provider(self):
        gemini, claude = Mock(), Mock()
        failed = Mock(side_effect=RuntimeError("synthetic outage"))
        generate = select_series_generator(gemini, provider="openai", adapters={
            "openai": registered("openai", failed), "claude": registered("claude", claude),
        })
        with self.assertRaises(SeriesPlanError) as caught:
            plan(generate=generate)
        self.assertEqual(caught.exception.code, "generate_failed")
        self.assertEqual(failed.call_count, 1)
        gemini.assert_not_called()
        claude.assert_not_called()

    def test_selected_output_still_has_to_pass_the_existing_schema(self):
        gemini = Mock()
        external = Gen("not JSON")
        generate = select_series_generator(gemini, provider="claude", adapters={"claude": registered("claude", external)})
        with self.assertRaises(SeriesPlanError):
            plan(generate=generate)
        self.assertEqual(len(external.calls), 1)
        gemini.assert_not_called()


if __name__ == "__main__":
    unittest.main()
