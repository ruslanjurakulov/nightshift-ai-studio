"""No model whose vendor's terms need written consent can reach anyone outside our own web app.

A terms gate records that a vendor's terms forbid something until the vendor agrees in writing (Recraft gave that for assistants;
Luma's API Terms of Use §5 items 4 and 5 ask for it before Output or access is offered to third parties). luma-ray-3.2 sat at
api_exposure "any" while its own entry said exactly that, because the two fields were never checked against each other. These
tests make the registry file refuse that combination, whoever edits it next.
"""

import json
import pathlib
import unittest

REGISTRY = json.loads((pathlib.Path(__file__).resolve().parent.parent / "schemas" / "model_registry.json").read_text())
MODELS = REGISTRY["models"]
#: Exposures that hand a vendor's model to someone other than a person in our own Studio.
OUTSIDE_WEB = {"any", "web_mcp"}


class TermsGateExposure(unittest.TestCase):
    def test_a_model_that_needs_written_consent_is_offered_only_in_the_web_studio(self):
        leaking = sorted(
            m["id"] for m in MODELS if m.get("terms_gate") == "written_consent_required" and m.get("api_exposure") in OUTSIDE_WEB
        )
        self.assertEqual(leaking, [], "written consent is required first; set api_exposure to web_only and cite the clause")

    def test_no_model_with_any_terms_gate_is_switched_on_for_assistants(self):
        on = sorted(m["id"] for m in MODELS if m.get("terms_gate") and m.get("mcp_oauth_exposure") is True)
        self.assertEqual(on, [], "a terms-gated model cannot be offered to a connected assistant")

    def test_luma_ray_cites_the_api_terms_that_need_consent(self):
        ray = next(m for m in MODELS if m["id"] == "luma-ray-3.2")
        self.assertEqual(ray["api_exposure"], "web_only")
        self.assertTrue(any("lumalabs.ai/legal/api-terms-of-use" in n for n in ray["terms_notes"]))


if __name__ == "__main__":
    unittest.main()
