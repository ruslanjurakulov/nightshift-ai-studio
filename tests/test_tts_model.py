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


class RunRequestTests(unittest.TestCase):
    def test_tts_model_is_validated_and_reaches_the_env(self):
        _, env, params = run_request.plan_run("news", "daily", {"tts_model": "eleven_flash_v2_5"}, {})
        self.assertEqual(params["tts_model"], "eleven_flash_v2_5")
        self.assertEqual(env["ELEVENLABS_MODEL_ID"], "eleven_flash_v2_5")
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.validate("news", "daily", {"tts_model": "eleven_v9"})
        _, env, _ = run_request.plan_run("news", "daily", {}, {"ELEVENLABS_MODEL_ID": "eleven_v3"})
        self.assertEqual(env["ELEVENLABS_MODEL_ID"], "eleven_v3")

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
