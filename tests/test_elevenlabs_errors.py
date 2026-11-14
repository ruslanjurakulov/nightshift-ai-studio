"""ElevenLabs' refusal is read by its code, and the remedy matches that code.

The status alone misleads: a 401 used to carry both ``invalid_api_key`` and
``quota_exceeded``, and the old copy told a person with a wrong key that they
might be out of characters. ``detail.code`` is the field ElevenLabs documents
(https://elevenlabs.io/docs/eleven-api/resources/errors, read 2026-11-14);
``detail.status`` is the legacy one, still read when the code is absent.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules import audio_mixer
from modules.audio_mixer import VoiceUnavailable, _tts_refusal, elevenlabs_error, verify_voice

VOICE = "pNInz6obpgDQGcFmaJgB"


def body(code=None, status=None, message="m"):
    detail = {"message": message}
    if code:
        detail["code"] = code
    if status:
        detail["status"] = status
    return {"detail": detail}


class EachCodeHasItsRemedy(unittest.TestCase):
    def test_401_says_key_wrong_or_missing_and_nothing_spent(self):
        for code in ("invalid_api_key", "missing_api_key"):
            msg = _tts_refusal(VOICE, 401, body(code))
            self.assertIn(code, msg)
            self.assertIn("wrong or missing", msg)
            self.assertIn("nothing was spent", msg)
            self.assertNotIn("characters", msg)

    def test_402_says_out_of_credit_top_up_and_no_other_voice(self):
        msg = _tts_refusal(VOICE, 402, body("insufficient_credits"))
        self.assertIn("out of credit", msg)
        self.assertIn("top up", msg)
        self.assertIn("No other voice is used", msg)

    def test_403_says_the_plan_cannot_use_this_voice_or_feature(self):
        for code in ("subscription_required", "feature_not_available", "voice_access_denied"):
            msg = _tts_refusal(VOICE, 403, body(code))
            self.assertIn(code, msg)
            self.assertIn("plan cannot use this voice or feature", msg)

    def test_404_says_pick_a_voice_from_the_account_list(self):
        msg = _tts_refusal(VOICE, 404, body("voice_not_found"))
        self.assertIn("Pick a voice from the account's list", msg)

    def test_429_says_busy_will_retry(self):
        for code in ("rate_limit_exceeded", "concurrent_limit_exceeded", "system_busy"):
            msg = _tts_refusal(VOICE, 429, body(code))
            self.assertIn("busy", msg)
            self.assertIn("retry", msg)

    def test_legacy_status_is_read_when_code_is_absent(self):
        self.assertEqual(elevenlabs_error(body(status="quota_exceeded")), ("quota_exceeded", "m"))
        msg = _tts_refusal(VOICE, 401, body(status="quota_exceeded"))
        self.assertIn("quota_exceeded", msg)
        self.assertIn("out of credit", msg)

    def test_code_wins_over_legacy_status(self):
        self.assertEqual(elevenlabs_error(body(code="invalid_api_key", status="quota_exceeded"))[0], "invalid_api_key")

    def test_no_code_at_all_falls_back_to_the_status_family(self):
        self.assertIn("wrong or missing", _tts_refusal(VOICE, 401, {}))
        self.assertIn("out of credit", _tts_refusal(VOICE, 402, None))
        self.assertIn("fix the cause", _tts_refusal(VOICE, 500, {}))

    def test_a_code_that_is_not_a_plain_word_is_not_quoted(self):
        """The body is the vendor's; only a plain code reaches a log line or an event."""
        self.assertEqual(elevenlabs_error(body(code="x\n<script>"))[0], "")


class TheVoiceCheckReadsTheCode(unittest.TestCase):
    def channel(self):
        ctx = MagicMock()
        ctx.agent.tts_provider = "elevenlabs"
        ctx.agent.language = "English"
        ctx.agent.elevenlabs_voice_id = VOICE
        ctx.agent.elevenlabs_secondary_voice_id = "narrator"
        return ctx

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_a_401_at_preflight_does_not_mention_characters(self, get):
        get.return_value = MagicMock(status_code=401, json=lambda: body("invalid_api_key"))
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(self.channel())
        self.assertIn("nothing was spent", str(caught.exception))
        self.assertNotIn("characters", str(caught.exception))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_a_403_at_preflight_names_the_plan(self, get):
        get.return_value = MagicMock(status_code=403, json=lambda: body("voice_access_denied"))
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(self.channel())
        self.assertIn("voice_access_denied", str(caught.exception))

    @patch("modules.audio_mixer._verify_characters_left")
    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_a_busy_preflight_is_not_fatal(self, get, _chars):
        """The check synthesizes nothing; the narration stage asks again and retries."""
        get.return_value = MagicMock(status_code=429, json=lambda: body("system_busy"))
        verify_voice(self.channel())


class BusyIsRetriedThenNamed(unittest.TestCase):
    def mixer(self):
        m = audio_mixer.AudioMixer.__new__(audio_mixer.AudioMixer)
        m.channel = None
        m.elevenlabs_model = "eleven_multilingual_v2"
        return m

    def run_with(self, outcomes):
        class ApiError(Exception):
            def __init__(self, status, code):
                self.status_code, self.body = status, body(code)

        calls = []

        def convert(**kw):
            calls.append(kw)
            nxt = outcomes.pop(0)
            if nxt is None:
                return iter([b"mp3"])
            raise ApiError(*nxt)

        client = MagicMock()
        client.text_to_speech.convert.side_effect = convert
        sdk = MagicMock()
        sdk.ElevenLabs.return_value = client
        with tempfile.TemporaryDirectory() as d, patch.dict(sys.modules, {"elevenlabs": sdk}), \
                patch.object(audio_mixer.time, "sleep") as sleep:
            out = Path(d) / "seg.mp3"
            try:
                self.mixer()._tts_elevenlabs("hello", VOICE, out)
                return calls, sleep, out.read_bytes(), None
            except VoiceUnavailable as e:
                return calls, sleep, None, e

    def test_a_busy_answer_is_asked_again_in_the_same_voice(self):
        calls, sleep, data, err = self.run_with([(429, "system_busy"), None])
        self.assertIsNone(err)
        self.assertEqual(data, b"mp3")
        self.assertEqual([c["voice_id"] for c in calls], [VOICE, VOICE])
        self.assertEqual(sleep.call_count, 1)

    def test_still_busy_after_every_try_stops_and_says_so(self):
        busy = (429, "concurrent_limit_exceeded")
        calls, _, _, err = self.run_with([busy, busy, busy])
        self.assertIsNotNone(err)
        self.assertEqual(len(calls), len(audio_mixer.BUSY_WAITS) + 1)
        self.assertIn("still busy", str(err))
        self.assertIn("no other voice is substituted", str(err))

    def test_a_credit_refusal_is_not_retried(self):
        calls, sleep, _, err = self.run_with([(402, "insufficient_credits")])
        self.assertIn("out of credit", str(err))
        self.assertEqual(len(calls), 1)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
