"""The narrator is checked before the run spends anything — and never substituted.

A channel set to ElevenLabs was set that way for the voice. With auto publish
on, nobody hears the result before the audience does, so narrating in a
different voice would put a video on YouTube that does not sound like the
channel. These tests pin the refusal to do that, and pin that the check is
cheap and early.
"""

import unittest
from unittest.mock import MagicMock, patch

from modules.audio_mixer import VoiceUnavailable, verify_voice


def channel(provider, voice_id="pNInz6obpgDQGcFmaJgB", secondary="narrator"):
    ctx = MagicMock()
    ctx.agent.tts_provider = provider
    ctx.agent.elevenlabs_voice_id = voice_id
    ctx.agent.elevenlabs_secondary_voice_id = secondary
    return ctx


class EdgeNeedsNothing(unittest.TestCase):
    @patch("modules.audio_mixer.requests.get")
    def test_an_edge_channel_is_not_checked_at_all(self, get):
        verify_voice(channel("edge"))
        get.assert_not_called()


class ElevenLabsMustBeUsable(unittest.TestCase):
    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "")
    @patch("modules.audio_mixer.requests.get")
    def test_a_missing_key_stops_the_run_before_any_request(self, get):
        """Run #20's failure: the secret was empty and nothing noticed until the
        audio stage, four Gemini calls later."""
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel("elevenlabs"))
        self.assertIn("ELEVENLABS_API_KEY", str(caught.exception))
        get.assert_not_called()

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_a_missing_voice_id_stops_the_run(self, get):
        with self.assertRaises(VoiceUnavailable):
            verify_voice(channel("elevenlabs", voice_id=""))
        get.assert_not_called()

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_an_unknown_voice_id_says_so(self, get):
        """'16516516145' is what a person types when guessing at an id."""
        get.return_value = MagicMock(status_code=404, json=lambda: {})
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel("elevenlabs", voice_id="16516516145"))
        self.assertIn("16516516145", str(caught.exception))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_it_quotes_elevenlabs_own_reason_for_a_401(self, get):
        """invalid_api_key and quota_exceeded share a status and need opposite fixes."""
        get.return_value = MagicMock(
            status_code=401,
            json=lambda: {"detail": {"status": "quota_exceeded"}},
        )
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel("elevenlabs"))
        self.assertIn("quota_exceeded", str(caught.exception))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_a_working_voice_passes_quietly(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: {"voice_id": "x"})
        verify_voice(channel("elevenlabs"))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get", side_effect=OSError("network down"))
    def test_an_outage_does_not_stop_the_run(self, _):
        """The real call happens a few stages later. A blip must not be the
        thing that kills a run before it starts."""
        verify_voice(channel("elevenlabs"))


class TheSecondVoiceIsChosenNotTyped(unittest.TestCase):
    """Runs #147 and #159 died at the audio stage, after the script was paid
    for, on a voice id typed into audio_mixer.py: a library voice the account's
    free plan may not use through the API (HTTP 402, paid_plan_required)."""

    @patch("modules.audio_mixer.ELEVENLABS_SECONDARY_VOICE_ID", "")
    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_no_second_voice_stops_the_run_before_any_request(self, get):
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel("elevenlabs", secondary=""))
        self.assertIn("Quote voice", str(caught.exception))
        get.assert_not_called()

    @patch("modules.audio_mixer.ELEVENLABS_SECONDARY_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")
    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_the_deployment_default_counts_as_a_choice(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: {})
        verify_voice(channel("elevenlabs", secondary=""))
        urls = [c.args[0] for c in get.call_args_list]
        self.assertTrue(any(u.endswith("/voices/EXAVITQu4vr4xnSDxMaL") for u in urls))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_a_chosen_second_voice_is_verified_too(self, get):
        get.side_effect = [MagicMock(status_code=200, json=lambda: {}),
                           MagicMock(status_code=404, json=lambda: {})]
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel("elevenlabs", secondary="21m00Tcm4TlvDq8ikWAM"))
        self.assertIn("21m00Tcm4TlvDq8ikWAM", str(caught.exception))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_narrator_is_an_explicit_choice_and_costs_no_extra_request(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: {})
        verify_voice(channel("elevenlabs", secondary="narrator"))
        self.assertEqual(get.call_count, 1)

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_a_typed_non_id_is_refused_before_it_reaches_a_url(self, get):
        with self.assertRaises(VoiceUnavailable):
            verify_voice(channel("elevenlabs", secondary="../user/subscription"))
        get.assert_not_called()

    def test_the_old_typed_voice_id_is_gone(self):
        from pathlib import Path
        src = (Path(__file__).resolve().parent.parent / "modules" / "audio_mixer.py").read_text()
        self.assertNotIn("D38z5RcWu1voky8WS1ja", src)


class SegmentVoices(unittest.TestCase):
    def _mixer(self, secondary):
        from modules.audio_mixer import AudioMixer
        m = AudioMixer.__new__(AudioMixer)
        m.tts_provider = "elevenlabs"
        m.main_elevenlabs_voice = "pNInz6obpgDQGcFmaJgB"
        m.secondary_elevenlabs_voice = secondary
        return m

    def test_secondary_lines_use_the_chosen_voice(self):
        self.assertEqual(self._mixer("21m00Tcm4TlvDq8ikWAM")._elevenlabs_voice_for("secondary"),
                         "21m00Tcm4TlvDq8ikWAM")

    def test_narrator_choice_reads_them_in_the_main_voice(self):
        self.assertEqual(self._mixer("narrator")._elevenlabs_voice_for("secondary"),
                         "pNInz6obpgDQGcFmaJgB")

    def test_unset_raises_instead_of_picking_one(self):
        with self.assertRaises(VoiceUnavailable):
            self._mixer("")._elevenlabs_voice_for("secondary")

    def test_a_402_says_what_the_plan_allows(self):
        from modules.audio_mixer import _tts_refusal
        body = {"detail": {"type": "payment_required", "code": "paid_plan_required",
                           "message": "Free users cannot use library voices via the API."}}
        msg = _tts_refusal("21m00Tcm4TlvDq8ikWAM", 402, body)
        self.assertIn("paid_plan_required", msg)
        self.assertIn("voice list", msg)

    def test_a_tts_refusal_becomes_voice_unavailable(self):
        import tempfile
        from pathlib import Path
        from modules import audio_mixer

        class ApiError(Exception):
            status_code = 402
            body = {"detail": {"code": "paid_plan_required", "message": "no"}}

        import sys
        client = MagicMock()
        client.text_to_speech.convert.side_effect = ApiError()
        sdk = MagicMock()                     # the elevenlabs package, not installed in CI
        sdk.ElevenLabs.return_value = client
        m = self._mixer("narrator")
        m.elevenlabs_model = "eleven_multilingual_v2"
        with tempfile.TemporaryDirectory() as d, \
                patch.dict(sys.modules, {"elevenlabs": sdk}), \
                patch.object(audio_mixer, "ELEVENLABS_API_KEY", "secret-key-value"):
            out = Path(d) / "seg.mp3"
            with self.assertRaises(VoiceUnavailable) as caught:
                m._tts_elevenlabs("hello", "pNInz6obpgDQGcFmaJgB", out)
            self.assertFalse(out.exists())
        self.assertNotIn("secret-key-value", str(caught.exception))


class NoSubstitution(unittest.TestCase):
    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "")
    def test_it_raises_rather_than_returning_a_different_provider(self):
        """There is no return value that could be read as 'use edge instead'."""
        with self.assertRaises(VoiceUnavailable):
            verify_voice(channel("elevenlabs"))


if __name__ == "__main__":
    unittest.main()
