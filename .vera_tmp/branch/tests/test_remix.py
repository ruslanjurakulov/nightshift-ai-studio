"""Viral Remix eligibility gate.

The rules under test are the legal boundary the code enforces: compilation is
confined to the channel's OWN catalogue; commentary needs an ASSERTED rights
basis and never assumes fair use; licensed/CC-BY material must carry an
attribution; and every eligible plan still requires the pre-publish gate — remix
can never weaken or skip it."""

import unittest

from modules import remix
from modules.channels import AgentConfig


def _src(rights="none", origin="external", creator=None, title="Clip", url=None):
    return remix.RemixSource(
        source_id="s1", title=title, rights=rights, origin=origin, creator=creator, url=url
    )


class CompilationTestCase(unittest.TestCase):
    def test_owned_own_catalog_is_allowed(self):
        v = remix.evaluate_eligibility(
            _src(rights=remix.RIGHTS_OWNED, origin=remix.ORIGIN_OWN_CATALOG),
            remix.MODE_COMPILATION,
        )
        self.assertTrue(v.allowed)
        self.assertFalse(v.requires_attribution)
        self.assertTrue(v.gate_required)

    def test_compilation_refuses_external_source(self):
        v = remix.evaluate_eligibility(
            _src(rights=remix.RIGHTS_OWNED, origin=remix.ORIGIN_EXTERNAL),
            remix.MODE_COMPILATION,
        )
        self.assertFalse(v.allowed)

    def test_compilation_refuses_non_owned_rights(self):
        v = remix.evaluate_eligibility(
            _src(rights=remix.RIGHTS_LICENSED, origin=remix.ORIGIN_OWN_CATALOG),
            remix.MODE_COMPILATION,
        )
        self.assertFalse(v.allowed)


class CommentaryTestCase(unittest.TestCase):
    def test_refuses_source_with_no_rights_basis(self):
        v = remix.evaluate_eligibility(_src(rights=remix.RIGHTS_NONE), remix.MODE_COMMENTARY)
        self.assertFalse(v.allowed)
        self.assertIn("rights basis", v.reason)

    def test_owned_commentary_needs_no_attribution(self):
        v = remix.evaluate_eligibility(
            _src(rights=remix.RIGHTS_OWNED), remix.MODE_COMMENTARY
        )
        self.assertTrue(v.allowed)
        self.assertFalse(v.requires_attribution)

    def test_cc_by_requires_a_named_creator(self):
        without = remix.evaluate_eligibility(
            _src(rights=remix.RIGHTS_CC_BY, creator=None), remix.MODE_COMMENTARY
        )
        self.assertFalse(without.allowed)
        self.assertTrue(without.requires_attribution)

        with_creator = remix.evaluate_eligibility(
            _src(rights=remix.RIGHTS_CC_BY, creator="Jane Doe"), remix.MODE_COMMENTARY
        )
        self.assertTrue(with_creator.allowed)
        self.assertTrue(with_creator.requires_attribution)

    def test_licensed_requires_a_named_creator(self):
        v = remix.evaluate_eligibility(
            _src(rights=remix.RIGHTS_LICENSED, creator=""), remix.MODE_COMMENTARY
        )
        self.assertFalse(v.allowed)


class UnknownModeTestCase(unittest.TestCase):
    def test_unknown_mode_is_refused(self):
        v = remix.evaluate_eligibility(_src(rights=remix.RIGHTS_OWNED), "mashup")
        self.assertFalse(v.allowed)


class AttributionTestCase(unittest.TestCase):
    def test_owned_needs_no_line(self):
        self.assertIsNone(remix.attribution_line(_src(rights=remix.RIGHTS_OWNED)))

    def test_cc_by_line_names_creator_and_licence(self):
        line = remix.attribution_line(
            _src(rights=remix.RIGHTS_CC_BY, creator="Jane Doe", title="Old Rome", url="http://x")
        )
        self.assertIn("Jane Doe", line)
        self.assertIn("CC BY", line)
        self.assertIn("http://x", line)

    def test_no_creator_yields_no_line(self):
        self.assertIsNone(remix.attribution_line(_src(rights=remix.RIGHTS_LICENSED, creator=None)))


class BuildPlanTestCase(unittest.TestCase):
    def test_ineligible_source_has_no_plan(self):
        self.assertIsNone(remix.build_plan(_src(rights=remix.RIGHTS_NONE), remix.MODE_COMMENTARY))

    def test_plan_always_requires_the_gate(self):
        plan = remix.build_plan(
            _src(rights=remix.RIGHTS_OWNED, origin=remix.ORIGIN_OWN_CATALOG),
            remix.MODE_COMPILATION,
        )
        self.assertIsNotNone(plan)
        self.assertTrue(plan.gate_required)
        self.assertTrue(plan.to_dict()["gate_required"])

    def test_licensed_plan_carries_the_attribution(self):
        plan = remix.build_plan(
            _src(rights=remix.RIGHTS_LICENSED, creator="ACME", title="Doc"),
            remix.MODE_COMMENTARY,
        )
        self.assertIsNotNone(plan)
        self.assertIsNotNone(plan.attribution)
        self.assertIn("ACME", plan.attribution)

    def test_owned_commentary_plan_has_no_attribution(self):
        plan = remix.build_plan(_src(rights=remix.RIGHTS_OWNED), remix.MODE_COMMENTARY)
        self.assertIsNotNone(plan)
        self.assertIsNone(plan.attribution)


class ConfigTestCase(unittest.TestCase):
    def test_remix_is_off_by_default(self):
        self.assertFalse(AgentConfig().remix_enabled)

    def test_only_explicit_true_opts_in(self):
        self.assertFalse(AgentConfig.from_dict({}).remix_enabled)
        self.assertFalse(AgentConfig.from_dict({"remix_enabled": "yes"}).remix_enabled)
        self.assertTrue(AgentConfig.from_dict({"remix_enabled": True}).remix_enabled)

    def test_round_trips_through_dict(self):
        cfg = AgentConfig(remix_enabled=True)
        self.assertTrue(AgentConfig.from_dict(cfg.to_dict()).remix_enabled)


if __name__ == "__main__":
    unittest.main()
