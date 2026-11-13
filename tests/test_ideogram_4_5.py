"""Ideogram 4.5 (text to image) through a fake HTTP session: nothing here touches a network or spends.

What would break: the quoted tier not reaching the vendor (Ideogram renders and bills ``high`` when ``quality``
is left out, more than the medium tier a Studio quote names by default), an unknown tier quietly replaced by
another, a shape or reference picture silently dropped, the key leaking into a stored message, or a refusal
read with the wrong remedy (docs/research/ideogram-4-5-2026-11-13.md)."""
from __future__ import annotations

import json
import unittest

from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    T2I,
    AdapterError,
    CapabilityRequest,
)

SECRET = "ideo-live-TOPSECRET-0123456789abcdef"
ENV = {"IDEOGRAM_API_KEY": SECRET}
URL = "https://api.ideogram.ai/v2/image/generate/ideogram-4-5"


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body
        self.text = body if isinstance(body, str) else json.dumps(body) if body is not None else ""

    def json(self):
        return json.loads(self.text)


class Session:
    def __init__(self, resp):
        self.resp = resp
        self.calls = []

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        return self.resp


OK = {"generation_kind": "sampling", "generation_id": "g1", "seed": 7,
      "data": [{"prompt": "p", "resolution": "2048x2048", "is_image_safe": True, "seed": 7,
                "url": "https://ideogram.ai/api/images/ephemeral/x.png"}]}


def make(resp=None, env=ENV):
    s = Session(resp if resp is not None else Resp(200, OK))
    return build_adapter("image.ideogram_v4_5", env=env, session=s), s


def ask(quality="medium", **kw):
    return CapabilityRequest(capability=T2I, prompt=kw.pop("prompt", "a poster that says HELLO"), quality=quality, **kw)


class RequestShape(unittest.TestCase):
    def test_posts_the_documented_form_with_the_key_in_the_header_only(self):
        a, s = make()
        task = a.submit(ask("medium"), "ideogram-4-5")
        self.assertEqual(len(s.calls), 1)
        method, url, kw = s.calls[0]
        self.assertEqual((method, url), ("POST", URL))
        self.assertEqual(kw["headers"], {"Api-Key": SECRET})
        self.assertNotIn(SECRET, url)
        self.assertIsNone(kw["json"])
        self.assertEqual(kw["files"], {"prompt": (None, "a poster that says HELLO"), "quality": (None, "medium"),
                                       "num_images": (None, "1")})
        self.assertEqual(task.outputs[0].url, OK["data"][0]["url"])
        self.assertIsNone(task.task_id)

    def test_each_tier_is_sent_as_the_vendors_own_value(self):
        for tier, vendor in (("low", "low"), ("medium", "medium"), ("high", "high")):
            with self.subTest(tier=tier):
                a, s = make()
                a.submit(ask(tier), "ideogram-4-5")
                self.assertEqual(s.calls[0][2]["files"]["quality"], (None, vendor))

    def test_no_size_is_sent_so_the_vendors_documented_auto_runs(self):
        a, s = make()
        a.submit(ask("low"), "ideogram-4-5")
        self.assertNotIn("size", s.calls[0][2]["files"])
        self.assertNotIn("aspect_ratio", s.calls[0][2]["files"])


class RefusedBeforeAnythingIsSent(unittest.TestCase):
    def assertRefused(self, request, vendor_model="ideogram-4-5", fragment=""):
        a, s = make()
        with self.assertRaises(AdapterError) as ctx:
            a.submit(request, vendor_model)
        self.assertEqual(ctx.exception.code, E_BAD_REQUEST)
        self.assertTrue(ctx.exception.not_accepted)
        self.assertIn(fragment, ctx.exception.message)
        self.assertEqual(s.calls, [])

    def test_a_missing_tier_is_refused_not_left_to_the_vendors_high(self):
        self.assertRefused(ask(None), fragment="bills high")

    def test_an_unknown_tier_is_refused_not_replaced(self):
        # very_low is a real vendor value, but "requires source images" and is not what was priced.
        for tier in ("very_low", "ultra", "MEDIUM"):
            with self.subTest(tier=tier):
                self.assertRefused(ask(tier), fragment="not an Ideogram 4.5 tier")

    def test_a_shape_is_refused_rather_than_dropped(self):
        self.assertRefused(ask("medium", aspect_ratio="16:9"), fragment="shapes are not wired")

    def test_a_reference_picture_is_refused_rather_than_dropped(self):
        self.assertRefused(ask("medium", input_images=("/tmp/ref.png",)), fragment="text to image only")

    def test_an_empty_prompt_and_a_stale_vendor_model_are_refused(self):
        self.assertRefused(ask("medium", prompt="   "), fragment="prompt is empty")
        self.assertRefused(ask("medium"), vendor_model="ideogram-4", fragment="not the Ideogram 4.5 endpoint")

    def test_no_key_is_refused_before_any_call(self):
        a, s = make(env={})
        with self.assertRaises(AdapterError) as ctx:
            a.submit(ask("medium"), "ideogram-4-5")
        self.assertTrue(ctx.exception.not_accepted)
        self.assertEqual(s.calls, [])

    def test_problems_names_the_same_refusals_for_the_registry_entry(self):
        entry = reg.load()["ideogram-4.5"]
        a, _ = make()
        self.assertEqual(a.problems(entry.probe_request(), entry), [])
        self.assertTrue(any("bills high" in p for p in a.problems(ask(None), entry)))
        self.assertTrue(a.problems(ask("ultra"), entry))
        self.assertTrue(a.problems(ask("medium", aspect_ratio="1:1"), entry))


class VendorAnswers(unittest.TestCase):
    def code_for(self, status, body):
        a, _ = make(Resp(status, body))
        with self.assertRaises(AdapterError) as ctx:
            a.submit(ask("medium"), "ideogram-4-5")
        return ctx.exception

    def test_documented_errors_map_to_their_remedy(self):
        cases = [
            (401, {"detail": "Unauthorized"}, E_AUTH),
            (402, {"error": "no credits", "reject_reason": "insufficient_funds"}, E_QUOTA),
            (429, {"error": "too many", "reject_reason": "inflight_limit", "max_inflight_requests": 10,
                   "task_completion_speed": "fast"}, E_RATE_LIMITED),
            # A 429 that is the account's cap, not the moment's: retrying only fails again.
            (429, {"error": "cap", "reject_reason": "daily_limit"}, E_QUOTA),
            (402, {"error": "x", "reject_reason": "subscription_required"}, E_QUOTA),
            (422, {"detail": "The prompt did not pass safety checks"}, E_POLICY),
            (400, {"detail": "Invalid input provided"}, E_BAD_REQUEST),
            (503, "Service Unavailable", E_UNAVAILABLE),
        ]
        for status, body, code in cases:
            with self.subTest(status=status, body=body):
                self.assertEqual(self.code_for(status, body).code, code)

    def test_an_echoed_key_never_reaches_the_message(self):
        e = self.code_for(401, {"detail": f"bad key {SECRET}"})
        self.assertNotIn(SECRET, e.message)
        self.assertNotIn(SECRET, str(e))

    def test_an_unsafe_image_is_a_policy_refusal(self):
        body = {"generation_id": "g", "seed": 1,
                "data": [{"prompt": "p", "resolution": "1024x1024", "is_image_safe": False, "seed": 1, "url": ""}]}
        self.assertEqual(self.code_for(200, body).code, E_POLICY)

    def test_a_2xx_without_an_image_says_the_vendor_may_have_billed(self):
        for body in ({"generation_id": "g", "seed": 1}, {"generation_id": "g", "seed": 1, "data": []},
                     {"data": [{"is_image_safe": True, "url": None}]}):
            with self.subTest(body=body):
                e = self.code_for(200, body)
                self.assertEqual(e.code, E_BAD_RESPONSE)
                self.assertFalse(e.not_accepted)


class RegistryEntry(unittest.TestCase):
    def test_priced_per_tier_from_the_owners_reading_and_marked_an_estimate(self):
        e = reg.load()["ideogram-4.5"]
        p = e.raw["pricing"]
        self.assertEqual(p["variants"], {"by": "quality", "prices": {"low": 0.03, "medium": 0.06, "high": 0.10}})
        self.assertEqual(p["provider_usd_per_unit"], p["variants"]["prices"]["medium"])
        self.assertFalse(p["confirmed"])
        self.assertIn("ESTIMATE", p["note"])
        self.assertEqual((p["source_url"], p["as_of"]), ("https://ideogram.ai/pricing/?pricing_tab=api", "2026-11-13"))

    def test_hidden_operator_preview_only_and_probed_at_the_cheapest_tier(self):
        e = reg.load()["ideogram-4.5"]
        self.assertIs(e.raw["operator_preview"], True)
        self.assertEqual(e.api_exposure, "web_only")
        self.assertEqual(e.capabilities, (T2I,))
        self.assertEqual(e.qualities, ("low", "medium", "high"))
        self.assertEqual(e.raw["probe"]["quality"], "low")
        self.assertNotIn("availability", e.raw)
        self.assertEqual(reg.credit_unit_for("ideogram-4.5", "image"), e.credit_unit)


if __name__ == "__main__":
    unittest.main()
