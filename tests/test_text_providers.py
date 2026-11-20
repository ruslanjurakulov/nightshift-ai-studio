"""modules/text_providers: one request, the text or a named failure, and never another provider (CLAUDE.md rules 1, 4, 6)."""

import unittest

import requests

from modules import text_providers as tp

KEY = "sk-test-0123456789abcdef0123456789"


class Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class Session:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def post(self, url, **kw):
        self.calls.append((url, kw))
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


def anthropic_ok(text="plan"):
    return Resp(200, {"model": "claude-sonnet-5-5", "stop_reason": "end_turn",
                      "content": [{"type": "thinking", "thinking": ""}, {"type": "text", "text": text}],
                      "usage": {"input_tokens": 10, "output_tokens": 5}})


def openai_ok(text="plan"):
    return Resp(200, {"model": "gpt-6-luna", "output": [
        {"type": "reasoning"}, {"type": "message", "content": [{"type": "output_text", "text": text}]}],
        "usage": {"input_tokens": 10, "output_tokens": 5}})


class TextProviderTests(unittest.TestCase):
    def call(self, provider, *answers, env=None, **kw):
        s = Session(*answers)
        env = {tp.key_env(provider): KEY} if env is None else env
        return tp.call(provider, "outline a series", env=env, session=s, **kw), s

    def fails(self, provider, answer):
        with self.assertRaises(tp.TextProviderError) as cm:
            self.call(provider, answer)
        self.assertNotIn(KEY, str(cm.exception))
        return cm.exception.code

    def test_a_missing_key_fails_before_any_request(self):
        s = Session()
        for p in ("anthropic", "openai"):
            with self.assertRaises(tp.TextProviderError) as cm:
                tp.call(p, "x", env={}, session=s)
            self.assertEqual(cm.exception.code, tp.E_NOT_CONFIGURED)
        self.assertEqual(s.calls, [])

    def test_anthropic_sends_the_key_in_a_header_with_the_pinned_version_and_reads_only_text_blocks(self):
        got, s = self.call("anthropic", anthropic_ok("hello"), safety_id="org_1")
        url, kw = s.calls[0]
        self.assertEqual(url, "https://api.anthropic.com/v1/messages")
        self.assertEqual(kw["headers"]["x-api-key"], KEY)
        self.assertEqual(kw["headers"]["anthropic-version"], "2026-10-21")
        self.assertNotIn(KEY, url)
        self.assertEqual(kw["json"]["model"], "claude-sonnet-5-5")
        self.assertEqual(kw["json"]["metadata"], {"user_id": "org_1"})
        for gone in ("temperature", "top_p", "top_k", "thinking"):   # 400 on version 2026-10-21
            self.assertNotIn(gone, kw["json"])
        self.assertEqual(got.text, "hello")
        self.assertEqual(got.usage, {"input_tokens": 10, "output_tokens": 5})

    def test_openai_uses_the_responses_api_and_reads_output_text(self):
        got, s = self.call("openai", openai_ok("hi"), safety_id="org_1")
        url, kw = s.calls[0]
        self.assertEqual(url, "https://api.openai.com/v1/responses")
        self.assertEqual(kw["headers"]["Authorization"], f"Bearer {KEY}")
        self.assertEqual(kw["json"]["safety_identifier"], "org_1")
        self.assertIs(kw["json"]["store"], False)
        self.assertEqual(got.text, "hi")

    def test_a_bad_key_and_a_spent_balance_are_different_failures(self):
        self.assertEqual(self.fails("openai", Resp(401, {"error": {"message": f"Incorrect API key {KEY}"}})), tp.E_AUTH)
        self.assertEqual(self.fails("openai", Resp(429, {"error": {"code": "insufficient_quota"}})), tp.E_QUOTA)
        self.assertEqual(self.fails("openai", Resp(429, {"error": {"type": "insufficient_quota"}})), tp.E_QUOTA)
        self.assertEqual(self.fails("openai", Resp(429, {"error": {"code": "rate_limit_exceeded"}})), tp.E_RATE_LIMITED)
        self.assertEqual(self.fails("anthropic", Resp(401, {"error": {"type": "authentication_error"}})), tp.E_AUTH)
        self.assertEqual(self.fails("anthropic", Resp(402, {"error": {"type": "billing_error"}})), tp.E_QUOTA)
        self.assertEqual(self.fails("anthropic", Resp(429, {"error": {"type": "rate_limit_error"}})), tp.E_RATE_LIMITED)
        self.assertEqual(self.fails("anthropic", Resp(529, {"error": {"type": "overloaded_error"}})), tp.E_UNAVAILABLE)
        self.assertEqual(self.fails("anthropic", Resp(400, {"error": {"type": "invalid_request_error"}})), tp.E_BAD_REQUEST)
        self.assertEqual(self.fails("anthropic", Resp(400, {"error": {"type": "invalid_request_error", "message":
                         "This API key is not scoped to a workspace, so this request must include ..."}})), tp.E_AUTH)

    def test_a_timeout_is_unavailable_and_is_not_retried(self):
        with self.assertRaises(tp.TextProviderError) as cm:
            self.call("anthropic", requests.Timeout("slow"))
        self.assertEqual(cm.exception.code, tp.E_UNAVAILABLE)

    def test_a_refusal_or_an_empty_answer_is_never_returned_as_text(self):
        self.assertEqual(self.fails("anthropic", Resp(200, {"stop_reason": "refusal", "content": []})), tp.E_REFUSED)
        self.assertEqual(self.fails("anthropic", Resp(200, {"stop_reason": "end_turn", "content": []})), tp.E_BAD_RESPONSE)
        self.assertEqual(self.fails("openai", Resp(200, {"output": [{"type": "message", "content": [
            {"type": "refusal", "refusal": "no"}]}]})), tp.E_REFUSED)
        self.assertEqual(self.fails("openai", Resp(200, None)), tp.E_BAD_RESPONSE)
        self.assertEqual(self.fails("anthropic", Resp(200, {"stop_reason": "max_tokens",
                                                            "content": [{"type": "text", "text": "half"}]})), tp.E_BAD_RESPONSE)
        self.assertEqual(self.fails("openai", Resp(200, dict(openai_ok()._body, status="incomplete"))), tp.E_BAD_RESPONSE)

    def test_a_failed_call_never_tries_another_provider(self):
        s = Session(Resp(500, {}), openai_ok())
        gen = tp.generate_for("anthropic", env={"ANTHROPIC_API_KEY": KEY, "OPENAI_API_KEY": KEY}, session=s)
        with self.assertRaises(tp.TextProviderError):
            gen("x")
        self.assertEqual(len(s.calls), 1)
        self.assertTrue(s.calls[0][0].startswith("https://api.anthropic.com/"))

    def test_every_code_names_a_remedy(self):
        for code in (tp.E_NOT_CONFIGURED, tp.E_AUTH, tp.E_QUOTA, tp.E_RATE_LIMITED, tp.E_UNAVAILABLE, tp.E_REFUSED,
                     tp.E_BAD_REQUEST, tp.E_BAD_RESPONSE):
            self.assertTrue(tp.REMEDIES[code])


if __name__ == "__main__":
    unittest.main()
