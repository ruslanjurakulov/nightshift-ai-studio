"""describe on Claude and on GPT (modules/capabilities/describe_llm.py): the same rules as the Gemini describe, the vendor's own
documented call, the key in a header only, a named failure for every way a call fails, and never another vendor (CLAUDE.md 1, 4, 6).

Fake sessions only: no network, no key, no paid call."""

from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    AdapterError,
    CapabilityRequest,
)
from modules.capabilities.image import DESCRIBE_SYSTEM
from tests.test_capabilities import FakeResp, FakeSession
from tests.test_creative_media_inputs import PNG

AKEY = "sk-ant-TOPSECRET-describe-0123456789abcdef"
OKEY = "sk-proj-TOPSECRET-describe-0123456789abcdef"
ENV = {"ANTHROPIC_API_KEY": AKEY, "OPENAI_API_KEY": OKEY}
CLAUDE, GPT = "claude-sonnet-5-5", "gpt-6-luna"


def claude_answer(*texts, stop="end_turn"):
    return {"model": CLAUDE, "stop_reason": stop,
            "content": [{"type": "thinking", "thinking": ""}] + [{"type": "text", "text": t} for t in texts]}


def gpt_answer(*texts):
    return {"model": GPT, "output": [{"type": "reasoning", "summary": []},
                                     {"type": "message", "content": [{"type": "output_text", "text": t} for t in texts]}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pic = Path(self.tmp.name) / "source.png"
        self.pic.write_bytes(PNG)

    def tearDown(self):
        self.tmp.cleanup()

    def req(self, **kw):
        return CapabilityRequest("describe", input_images=(str(self.pic),), **kw)

    def adapter(self, key, routes, env=ENV):
        return build_adapter(key, env=env, session=FakeSession(routes))

    def code(self, key, model, resp, routes_match):
        a = self.adapter(key, [("POST", routes_match, resp)])
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), model)
        self.assertNotIn(AKEY, str(cm.exception))
        self.assertNotIn(OKEY, str(cm.exception))
        return cm.exception.code


class Claude(Base):
    def test_the_documented_messages_request_carries_the_picture_and_the_rules(self):
        a = self.adapter("image.anthropic_describe", [("POST", "/v1/messages", FakeResp(200, claude_answer("A cat on a mat.")))])
        task = a.submit(self.req(output_language="uz", end_user="u_1a2b3c"), CLAUDE)
        method, url, kw = a.session.calls[0]
        self.assertEqual((method, url), ("POST", "https://api.anthropic.com/v1/messages"))
        self.assertEqual(kw["headers"]["x-api-key"], AKEY)
        self.assertEqual(kw["headers"]["anthropic-version"], "2026-10-21")
        self.assertNotIn("Authorization", kw["headers"])
        self.assertNotIn("x-goog-api-key", kw["headers"])
        body = kw["json"]
        self.assertEqual((body["model"], body["system"]), (CLAUDE, DESCRIBE_SYSTEM))
        image, ask = body["messages"][0]["content"]
        self.assertEqual(image["source"], {"type": "base64", "media_type": "image/png", "data": base64.b64encode(PNG).decode()})
        self.assertIn("Uzbek", ask["text"])
        self.assertEqual(body["metadata"], {"user_id": "u_1a2b3c"})
        for gone in ("temperature", "top_p", "top_k"):    # refused with a 400 on API version 2026-10-21
            self.assertNotIn(gone, body)
        self.assertEqual((task.outputs[0].mime, task.outputs[0].data), ("text/plain", b"A cat on a mat."))

    def test_every_failure_is_named_and_never_carries_the_key(self):
        m = "/v1/messages"
        self.assertEqual(self.code("image.anthropic_describe", CLAUDE, FakeResp(401, {"error": {"type": "authentication_error",
                                                                                                "message": AKEY}}), m), E_AUTH)
        self.assertEqual(self.code("image.anthropic_describe", CLAUDE, FakeResp(402, {"error": {"type": "billing_error"}}), m), E_QUOTA)
        self.assertEqual(self.code("image.anthropic_describe", CLAUDE, FakeResp(429, {"error": {"type": "rate_limit_error"}}), m),
                         E_RATE_LIMITED)
        self.assertEqual(self.code("image.anthropic_describe", CLAUDE, FakeResp(529, {"error": {"type": "overloaded_error"}}), m),
                         E_UNAVAILABLE)
        self.assertEqual(self.code("image.anthropic_describe", CLAUDE, FakeResp(200, claude_answer(stop="refusal")), m), E_POLICY)
        self.assertEqual(self.code("image.anthropic_describe", CLAUDE, FakeResp(200, claude_answer()), m), E_BAD_RESPONSE)
        # Cut off mid-sentence: never a finished (and charged) description.
        self.assertEqual(self.code("image.anthropic_describe", CLAUDE,
                                   FakeResp(200, claude_answer("A cat on a", stop="max_tokens")), m), E_BAD_RESPONSE)


class Gpt(Base):
    def test_the_documented_responses_request_carries_the_picture_and_the_rules(self):
        a = self.adapter("image.openai_describe", [("POST", "/v1/responses", FakeResp(200, gpt_answer("A red apple.")))])
        task = a.submit(self.req(end_user="u_1a2b3c"), GPT)
        method, url, kw = a.session.calls[0]
        self.assertEqual((method, url), ("POST", "https://api.openai.com/v1/responses"))
        self.assertEqual(kw["headers"]["Authorization"], f"Bearer {OKEY}")
        self.assertNotIn("x-goog-api-key", kw["headers"])
        body = kw["json"]
        self.assertEqual((body["model"], body["instructions"]), (GPT, DESCRIBE_SYSTEM))
        image, ask = body["input"][0]["content"]
        self.assertEqual(image["image_url"], "data:image/png;base64," + base64.b64encode(PNG).decode())
        self.assertEqual(ask["type"], "input_text")
        self.assertEqual(body["safety_identifier"], "u_1a2b3c")
        self.assertIs(body["store"], False)          # the customer's picture is not kept at the vendor
        self.assertEqual(task.outputs[0].data, b"A red apple.")

    def test_a_spent_balance_and_a_rate_limit_are_different_failures(self):
        m = "/v1/responses"
        self.assertEqual(self.code("image.openai_describe", GPT, FakeResp(429, {"error": {"code": "insufficient_quota"}}), m), E_QUOTA)
        self.assertEqual(self.code("image.openai_describe", GPT, FakeResp(429, {"error": {"code": "rate_limit_exceeded"}}), m),
                         E_RATE_LIMITED)
        self.assertEqual(self.code("image.openai_describe", GPT, FakeResp(401, {"error": {"message": OKEY}}), m), E_AUTH)
        refusal = {"output": [{"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}]}
        self.assertEqual(self.code("image.openai_describe", GPT, FakeResp(200, refusal), m), E_POLICY)
        cut = dict(gpt_answer("A red"), status="incomplete", incomplete_details={"reason": "max_output_tokens"})
        self.assertEqual(self.code("image.openai_describe", GPT, FakeResp(200, cut), m), E_BAD_RESPONSE)
        filtered = dict(gpt_answer(), status="incomplete", incomplete_details={"reason": "content_filter"})
        self.assertEqual(self.code("image.openai_describe", GPT, FakeResp(200, filtered), m), E_POLICY)

    def test_an_email_is_never_sent_as_the_safety_identifier(self):
        a = self.adapter("image.openai_describe", [("POST", "/v1/responses", FakeResp(200, gpt_answer("x y z")))])
        a.submit(self.req(end_user="alice@example.com"), GPT)
        self.assertNotIn("safety_identifier", a.session.calls[0][2]["json"])


class Both(Base):
    def test_no_key_fails_before_any_call_and_never_reaches_another_vendor(self):
        for key, model in (("image.anthropic_describe", CLAUDE), ("image.openai_describe", GPT)):
            a = self.adapter(key, [], env={"GEMINI_API_KEY": "AIzaSyOTHER-vendor-key-0123456789"})
            with self.assertRaises(AdapterError) as cm:
                a.submit(self.req(), model)
            self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
            self.assertEqual(a.session.calls, [])

    def test_a_url_is_never_fetched(self):
        for key, model in (("image.anthropic_describe", CLAUDE), ("image.openai_describe", GPT)):
            a = self.adapter(key, [])
            with self.assertRaises(AdapterError) as cm:
                a.submit(CapabilityRequest("describe", input_images=("https://evil.test/x.png",)), model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
            self.assertEqual(a.session.calls, [])

    def test_the_registry_rows_are_hidden_web_only_text_models_probed_with_the_frame(self):
        for mid, adapter, unit in (("anthropic-claude-sonnet-5-5", "image.anthropic_describe", "model_anthropic_claude_sonnet_5_5_request"),
                                   ("openai-gpt-6-luna", "image.openai_describe", "model_openai_gpt_6_luna_request")):
            e = reg.get(mid)
            self.assertEqual((e.adapter, e.capabilities, e.output, e.credit_unit), (adapter, ("describe",), "text", unit))
            self.assertEqual(e.raw["api_exposure"], "web_only")
            self.assertIsNone(e.raw["pricing"]["provider_usd_per_unit"])     # prices live in the database only
            req = e.probe_request(generated_image="/tmp/probe_frame.png")
            self.assertEqual((req.capability, req.input_images), ("describe", ("/tmp/probe_frame.png",)))


if __name__ == "__main__":
    unittest.main()
