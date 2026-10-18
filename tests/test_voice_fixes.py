"""D4 (voice) and D11: a run that expects ElevenLabs does not fall back to the
free voice, a short account is found before anything is paid, and the TTS cache
never holds half a segment. No network, no SDK."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules import audio_mixer
from modules.audio_mixer import AudioMixer, VoiceUnavailable, verify_voice

RUN_VOICE = "21m00Tcm4TlvDq8ikWAM"


def channel(provider, target=300):
    ctx = MagicMock()
    ctx.agent.tts_provider = provider
    ctx.agent.elevenlabs_voice_id = "pNInz6obpgDQGcFmaJgB"
    ctx.agent.elevenlabs_secondary_voice_id = "narrator"
    ctx.agent.target_duration_seconds = target
    return ctx


class ExpectedElevenLabsMissingKey(unittest.TestCase):
    """config.TTS_PROVIDER is 'edge' when the key never reached the worker. That
    must not become the robot voice when the deployment or the run expects
    ElevenLabs."""

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "")
    @patch("modules.audio_mixer.TTS_PROVIDER_EXPLICIT", False)
    @patch("modules.audio_mixer.EXPECT_TTS_PROVIDER", "elevenlabs")
    def test_a_deployment_that_expects_elevenlabs_stops_at_the_start(self):
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel("edge"))
        self.assertIn("ELEVENLABS_API_KEY", str(caught.exception))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "")
    @patch("modules.audio_mixer.TTS_PROVIDER_EXPLICIT", False)
    @patch("modules.audio_mixer.EXPECT_TTS_PROVIDER", "")
    @patch("modules.audio_mixer.ELEVENLABS_RUN_VOICE_ID", RUN_VOICE)
    def test_a_run_with_its_own_elevenlabs_voice_expects_elevenlabs(self):
        with self.assertRaises(VoiceUnavailable):
            verify_voice(channel("edge"))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "")
    @patch("modules.audio_mixer.TTS_PROVIDER_EXPLICIT", True)
    @patch("modules.audio_mixer.EXPECT_TTS_PROVIDER", "elevenlabs")
    def test_an_explicit_tts_provider_is_respected(self):
        verify_voice(channel("edge"))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "")
    @patch("modules.audio_mixer.TTS_PROVIDER_EXPLICIT", False)
    @patch("modules.audio_mixer.EXPECT_TTS_PROVIDER", "")
    @patch("modules.audio_mixer.ELEVENLABS_RUN_VOICE_ID", "")
    def test_nothing_expected_stays_edge(self):
        verify_voice(channel("edge"))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.TTS_PROVIDER_EXPLICIT", False)
    @patch("modules.audio_mixer.EXPECT_TTS_PROVIDER", "elevenlabs")
    @patch("modules.audio_mixer.requests.get")
    def test_with_the_key_present_an_edge_channel_is_left_alone(self, get):
        verify_voice(channel("edge"))
        get.assert_not_called()


def _get(voices=200, subscription=None, sub_status=200):
    def fake(url, **kw):
        if url.endswith("/user/subscription"):
            if isinstance(subscription, Exception):
                raise subscription
            return MagicMock(status_code=sub_status, json=lambda: subscription)
        return MagicMock(status_code=voices, json=lambda: {})
    return fake


@patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
class CharactersLeft(unittest.TestCase):
    def test_a_short_account_stops_the_run_before_it_spends(self):
        sub = {"character_count": 99_000, "character_limit": 100_000}   # 1000 left, ~4500 needed
        with patch("modules.audio_mixer.requests.get", side_effect=_get(subscription=sub)):
            with self.assertRaises(VoiceUnavailable) as caught:
                verify_voice(channel("elevenlabs", target=300))
        msg = str(caught.exception)
        self.assertIn("1000 characters left", msg)
        self.assertIn("4500", msg)
        self.assertNotIn("k-", msg)

    def test_enough_characters_passes(self):
        sub = {"character_count": 1_000, "character_limit": 100_000}
        with patch("modules.audio_mixer.requests.get", side_effect=_get(subscription=sub)):
            verify_voice(channel("elevenlabs", target=300))

    def test_the_need_follows_the_run_length(self):
        sub = {"character_count": 94_000, "character_limit": 100_000}   # 6000 left
        with patch("modules.audio_mixer.requests.get", side_effect=_get(subscription=sub)):
            verify_voice(channel("elevenlabs", target=300))             # needs 4500
            with self.assertRaises(VoiceUnavailable):
                verify_voice(channel("elevenlabs", target=600))         # needs 9000

    def test_usage_based_billing_past_the_limit_is_not_short(self):
        sub = {"character_count": 100_000, "character_limit": 100_000,
               "allowed_to_extend_character_limit": True}
        with patch("modules.audio_mixer.requests.get", side_effect=_get(subscription=sub)):
            verify_voice(channel("elevenlabs"))

    def test_an_unreadable_subscription_is_not_fatal(self):
        for sub, status in (({}, 200), (None, 200), ({"character_limit": 1}, 200), ({}, 500),
                            (OSError("down"), 200)):
            with self.subTest(sub=sub, status=status):
                with patch("modules.audio_mixer.requests.get",
                           side_effect=_get(subscription=sub, sub_status=status)):
                    verify_voice(channel("elevenlabs"))

    def test_a_missing_voice_is_still_reported_first(self):
        with patch("modules.audio_mixer.requests.get", side_effect=_get(voices=404)):
            with self.assertRaises(VoiceUnavailable) as caught:
                verify_voice(channel("elevenlabs"))
        self.assertIn("no voice", str(caught.exception))


def _mixer(work_dir):
    m = AudioMixer.__new__(AudioMixer)
    m.tts_provider = "elevenlabs"
    m.main_elevenlabs_voice = "pNInz6obpgDQGcFmaJgB"
    m.secondary_elevenlabs_voice = "narrator"
    m.main_edge_voice = "en-US-AriaNeural"
    m.elevenlabs_model = "eleven_multilingual_v2"
    m.work_dir = Path(work_dir)
    m.characters_synthesized = 0
    return m


def _sdk(convert):
    client = MagicMock()
    client.text_to_speech.convert.side_effect = convert
    sdk = MagicMock()
    sdk.ElevenLabs.return_value = client
    return patch.dict(sys.modules, {"elevenlabs": sdk})


class TtsCacheIsAtomic(unittest.TestCase):
    def test_the_segment_is_written_beside_the_cache_name_and_moved_when_complete(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "seg.mp3"
            part = Path(d) / "seg.mp3.part"
            seen = {}

            def convert(**kw):
                yield b"abc"
                seen["out_exists"] = out.exists()      # mid-write: not yet under the cache name
                seen["part_exists"] = part.exists()
                yield b"def"

            with _sdk(convert), patch.object(audio_mixer, "ELEVENLABS_API_KEY", "k"):
                _mixer(d)._tts_elevenlabs("hello", "pNInz6obpgDQGcFmaJgB", out)
            self.assertEqual((seen["out_exists"], seen["part_exists"]), (False, True))
            self.assertEqual(out.read_bytes(), b"abcdef")
            self.assertFalse(part.exists())

    def test_a_stream_that_dies_mid_write_leaves_no_cache_file(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "seg.mp3"

            def convert(**kw):
                yield b"abc"
                raise ConnectionError("stream cut")

            with _sdk(convert), patch.object(audio_mixer, "ELEVENLABS_API_KEY", "k"):
                with self.assertRaises(ConnectionError):
                    _mixer(d)._tts_elevenlabs("hello", "pNInz6obpgDQGcFmaJgB", out)
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_a_killed_write_is_never_reused_as_the_segment(self):
        # A SIGKILL leaves only the .part; the final name stays absent, so the resume re-renders.
        with tempfile.TemporaryDirectory() as d:
            m = _mixer(d)
            rendered = []

            def fake_tts(self, text, voice, out):
                rendered.append(out)
                Path(out).write_bytes(b"whole")

            with patch.object(AudioMixer, "_tts_elevenlabs", fake_tts):
                seg = Path(m._render_segment("hello world", "main"))
                seg.unlink()
                Path(str(seg) + ".part").write_bytes(b"cut")        # what a kill leaves behind
                again = Path(m._render_segment("hello world", "main"))
            self.assertEqual(again.read_bytes(), b"whole")
            self.assertEqual(len(rendered), 2)                      # re-synthesized, not reused

    def test_an_empty_cache_file_is_deleted_and_rendered_again(self):
        with tempfile.TemporaryDirectory() as d:
            m = _mixer(d)
            rendered = []

            def fake_tts(self, text, voice, out):
                rendered.append(out)
                Path(out).write_bytes(b"whole")

            with patch.object(AudioMixer, "_tts_elevenlabs", fake_tts):
                seg = Path(m._render_segment("hello", "main"))
                seg.write_bytes(b"")                                # a truncated write from an older build
                again = Path(m._render_segment("hello", "main"))
            self.assertEqual(again.read_bytes(), b"whole")
            self.assertEqual(len(rendered), 2)

    def test_a_complete_cache_file_is_reused(self):
        with tempfile.TemporaryDirectory() as d:
            m = _mixer(d)
            rendered = []

            def fake_tts(self, text, voice, out):
                rendered.append(out)
                Path(out).write_bytes(b"whole")

            with patch.object(AudioMixer, "_tts_elevenlabs", fake_tts):
                m._render_segment("hello", "main")
                m._render_segment("hello", "main")
            self.assertEqual(len(rendered), 1)


if __name__ == "__main__":
    unittest.main()
