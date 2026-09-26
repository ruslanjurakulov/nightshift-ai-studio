"""The ElevenLabs model choice: config fallback, the per-run param, and the
mixer actually sending (and caching by) the chosen model."""

import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import config
from modules import run_request


class ConfigTests(unittest.TestCase):
    def reload_with(self, value):
        with mock.patch.dict(os.environ, {"ELEVENLABS_MODEL_ID": value}):
            return importlib.reload(config).ELEVENLABS_MODEL_ID

    def tearDown(self):
        importlib.reload(config)

    def test_default_known_and_unknown(self):
        self.assertEqual(self.reload_with(""), "eleven_multilingual_v2")
        self.assertEqual(self.reload_with("eleven_v3"), "eleven_v3")
        # A typo must not fail a paid run.
        self.assertEqual(self.reload_with("eleven_v9"), "eleven_multilingual_v2")


class VoiceConfigTests(unittest.TestCase):
    def tearDown(self):
        importlib.reload(config)

    def test_run_voice_must_look_like_an_id_and_empty_default_is_unset(self):
        env = {"ELEVENLABS_RUN_VOICE_ID": "nPczCjzI2devNBz1zQrb", "ELEVENLABS_VOICE_ID": ""}
        with mock.patch.dict(os.environ, env):
            c = importlib.reload(config)
            self.assertEqual(c.ELEVENLABS_RUN_VOICE_ID, "nPczCjzI2devNBz1zQrb")
            self.assertEqual(c.ELEVENLABS_VOICE_ID, "pNInz6obpgDQGcFmaJgB")
        with mock.patch.dict(os.environ, {"ELEVENLABS_RUN_VOICE_ID": "../etc/passwd"}):
            self.assertEqual(importlib.reload(config).ELEVENLABS_RUN_VOICE_ID, "")

    def test_the_run_voice_beats_the_channel_voice(self):
        from modules import audio_mixer
        agent = mock.Mock(elevenlabs_voice_id="channelvoice00000000")
        with mock.patch.object(audio_mixer, "ELEVENLABS_RUN_VOICE_ID", ""):
            self.assertEqual(audio_mixer.narrator_voice(agent), "channelvoice00000000")
        with mock.patch.object(audio_mixer, "ELEVENLABS_RUN_VOICE_ID", "nPczCjzI2devNBz1zQrb"):
            self.assertEqual(audio_mixer.narrator_voice(agent), "nPczCjzI2devNBz1zQrb")
            self.assertEqual(audio_mixer.narrator_voice(None), "nPczCjzI2devNBz1zQrb")


class RunRequestTests(unittest.TestCase):
    def test_tts_model_is_validated_and_reaches_the_env(self):
        _, env, params = run_request.plan_run("news", "daily", {"tts_model": "eleven_flash_v2_5"}, {})
        self.assertEqual(params["tts_model"], "eleven_flash_v2_5")
        self.assertEqual(env["ELEVENLABS_MODEL_ID"], "eleven_flash_v2_5")
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.validate("news", "daily", {"tts_model": "eleven_v9"})
        _, env, _ = run_request.plan_run("news", "daily", {}, {"ELEVENLABS_MODEL_ID": "eleven_v3"})
        self.assertEqual(env["ELEVENLABS_MODEL_ID"], "eleven_v3")

    def test_voice_id_is_validated_and_reaches_the_env(self):
        _, env, params = run_request.plan_run("news", "daily", {"voice_id": "nPczCjzI2devNBz1zQrb"}, {})
        self.assertEqual(env["ELEVENLABS_RUN_VOICE_ID"], "nPczCjzI2devNBz1zQrb")
        for bad in ("short", "x" * 21, "has space 0123456789", 42):
            with self.subTest(bad=bad), self.assertRaises(run_request.InvalidRunRequest):
                run_request.validate("news", "daily", {"voice_id": bad})

    def test_lists_agree(self):
        self.assertEqual(run_request.TTS_MODELS, config.ELEVENLABS_MODELS)


class MixerTests(unittest.TestCase):
    def mixer(self, model):
        from modules import audio_mixer
        tmp = Path(tempfile.mkdtemp())
        with mock.patch.object(audio_mixer, "OUTPUT_DIR", tmp):
            m = audio_mixer.AudioMixer("t")
        m.tts_provider = "elevenlabs"
        m.elevenlabs_model = model
        return m

    def test_sends_the_model_and_keys_the_cache_by_it(self):
        sent = []

        def fake_tts(self, text, voice_id, out):
            sent.append(self.elevenlabs_model)
            Path(out).write_bytes(b"mp3")

        from modules import audio_mixer
        with mock.patch.object(audio_mixer.AudioMixer, "_tts_elevenlabs", fake_tts):
            a = self.mixer("eleven_multilingual_v2")
            b = self.mixer("eleven_v3")
            b.work_dir = a.work_dir  # same cache directory
            pa = a._render_segment("Hello there.", "main")
            pb = b._render_segment("Hello there.", "main")
        self.assertNotEqual(pa, pb)
        self.assertEqual(sent, ["eleven_multilingual_v2", "eleven_v3"])


if __name__ == "__main__":
    unittest.main()
