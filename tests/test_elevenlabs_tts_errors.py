"""ElevenLabs text-to-speech refusals, each mapped to the fix it needs (CLAUDE.md rules 4 and 6).

What would break without these: ElevenLabs answers an account that is out of characters with HTTP 401
``quota_exceeded``, the same status as a wrong key; read by status alone, an empty balance is reported as
"replace the key", and the operator replaces a key that is fine. And a voice the account does not have must
end the job with "pick another voice": no other voice is ever asked for in its place.

Driven through a fake HTTP session: nothing here reaches ElevenLabs or spends anything.
"""

from __future__ import annotations

import json
import unittest

from modules.capabilities import build_adapter
from modules.capabilities.audio import elevenlabs_error_code
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    AdapterError,
    CapabilityRequest,
)
from tests.test_capabilities import FakeResp, FakeSession

KEY = "xi-test-key-0123456789abcdef"
VOICE = "pNInz6obpgDQGcFmaJgB"
OTHER_VOICE = "nPczCjzI2devNBz1zQrb"
ENV = {"ELEVENLABS_API_KEY": KEY}


def detail(code: str, *, legacy: bool = False, message: str = "") -> dict:
    """ElevenLabs' error body: ``detail.code`` today, ``detail.status`` on the older shape."""
    return {"detail": {"status": code, "message": message}} if legacy else \
        {"detail": {"type": "x", "code": code, "message": message}}


def tts(resp: FakeResp):
    session = FakeSession([("POST", "/v1/text-to-speech/", resp)])
    a = build_adapter("audio.elevenlabs_tts", env=ENV, session=session)
    with_err = None
    try:
        a.submit(CapabilityRequest("tts", "Salom", voice_id=VOICE), "eleven_multilingual_v2")
    except AdapterError as e:
        with_err = e
    return with_err, session


class ElevenLabsCodeTests(unittest.TestCase):
    def test_reads_the_code_and_the_legacy_status(self):
        self.assertEqual(elevenlabs_error_code(json.dumps(detail("voice_not_found"))), "voice_not_found")
        self.assertEqual(elevenlabs_error_code(json.dumps(detail("quota_exceeded", legacy=True))), "quota_exceeded")
        self.assertEqual(elevenlabs_error_code("not json"), "")
        self.assertEqual(elevenlabs_error_code(json.dumps({"detail": [{"msg": "x"}]})), "")


class TtsRefusalMappingTests(unittest.TestCase):
    def assertCode(self, resp: FakeResp, code: str):
        err, _ = tts(resp)
        self.assertIsNotNone(err, "a refused call must raise")
        self.assertEqual(err.code, code, err.message)
        return err

    def test_a_wrong_key_is_auth(self):
        err = self.assertCode(FakeResp(401, detail("invalid_api_key")), E_AUTH)
        self.assertTrue(err.not_accepted)

    def test_an_empty_balance_on_401_is_quota_not_auth(self):
        # Same status as a wrong key; the opposite fix.
        err = self.assertCode(FakeResp(401, detail("quota_exceeded", legacy=True)), E_QUOTA)
        self.assertTrue(err.not_accepted)
        self.assertCode(FakeResp(402, detail("insufficient_credits")), E_QUOTA)

    def test_429_is_quota_or_slow_down_by_its_code(self):
        self.assertCode(FakeResp(429, detail("quota_exceeded")), E_QUOTA)
        # "exceeded your" is a quota word to the generic reader; ElevenLabs' code says it is concurrency.
        self.assertCode(FakeResp(429, detail("concurrent_limit_exceeded",
                                             message="You have exceeded your concurrent requests limit")),
                        E_RATE_LIMITED)
        self.assertCode(FakeResp(429, detail("system_busy")), E_RATE_LIMITED)

    def test_400_and_422_are_the_request(self):
        self.assertCode(FakeResp(400, detail("text_too_long")), E_BAD_REQUEST)
        self.assertCode(FakeResp(422, {"detail": [{"loc": ["body", "text"], "msg": "field required", "type": "missing"}]}),
                        E_BAD_REQUEST)

    def test_an_outage_stays_retryable(self):
        err = self.assertCode(FakeResp(503, detail("service_unavailable")), E_UNAVAILABLE)
        self.assertTrue(err.retryable)

    def test_the_key_never_reaches_the_message(self):
        err, _ = tts(FakeResp(401, {"detail": {"code": "invalid_api_key", "message": f"bad key {KEY}"}}))
        self.assertNotIn(KEY, err.message)


class UnknownVoiceTests(unittest.TestCase):
    def test_voice_not_found_names_the_voice_and_asks_for_another(self):
        err, _ = tts(FakeResp(404, detail("voice_not_found")))
        self.assertEqual(err.code, E_BAD_REQUEST)
        self.assertIn(VOICE, err.message)
        self.assertIn("pick another voice", err.message)
        # A 404 is a refusal outright: the call was not taken, nothing was billed.
        self.assertTrue(err.not_accepted)

    def test_legacy_and_codeless_404s_are_the_voice_too(self):
        for body in (detail("voice_not_found", legacy=True), ""):
            err, _ = tts(FakeResp(404, body))
            self.assertEqual(err.code, E_BAD_REQUEST)
            self.assertIn("pick another voice", err.message)

    def test_an_invalid_or_forbidden_voice_is_refused_the_same_way(self):
        for status, code in ((400, "invalid_voice_id"), (403, "voice_access_denied")):
            err, _ = tts(FakeResp(status, detail(code)))
            self.assertEqual(err.code, E_BAD_REQUEST)
            self.assertIn(VOICE, err.message)
            # Only a 404 is trusted as "not billed"; a 400 / 403 keeps the base rule.
            self.assertFalse(err.not_accepted)

    def test_no_fallback_voice_is_ever_asked_for(self):
        # Even with a "default" voice configured for the pipeline, the Studio's adapter asks for the one voice
        # the person picked, once, and stops.
        session = FakeSession([("POST", "/v1/text-to-speech/", FakeResp(404, detail("voice_not_found")))])
        env = dict(ENV, ELEVENLABS_VOICE_ID=OTHER_VOICE, ELEVENLABS_SECONDARY_VOICE_ID=OTHER_VOICE)
        a = build_adapter("audio.elevenlabs_tts", env=env, session=session)
        with self.assertRaises(AdapterError):
            a.submit(CapabilityRequest("tts", "Salom", voice_id=VOICE), "eleven_v3")
        self.assertEqual(len(session.calls), 1)
        self.assertTrue(session.calls[0][1].endswith(f"/v1/text-to-speech/{VOICE}"))
        self.assertNotIn(OTHER_VOICE, session.calls[0][1])

    def test_a_picked_voice_that_exists_is_the_one_spoken(self):
        session = FakeSession([("POST", f"/v1/text-to-speech/{VOICE}", FakeResp(200, content=b"ID3audio"))])
        a = build_adapter("audio.elevenlabs_tts", env=ENV, session=session)
        task = a.submit(CapabilityRequest("tts", "Salom", voice_id=VOICE), "eleven_v3")
        self.assertEqual(task.outputs[0].data, b"ID3audio")
        self.assertEqual(session.calls[0][2]["json"]["model_id"], "eleven_v3")


if __name__ == "__main__":
    unittest.main()
