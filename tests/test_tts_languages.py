"""An Uzbek channel is never read by a model that does not speak Uzbek.

The default narration model, eleven_multilingual_v2, does not list Uzbek on
ElevenLabs' own model page (read 2026-11-14). Nothing would fail: the run would
finish and upload Uzbek text read badly, and with auto publish on the audience
would hear it first. These tests pin that the run stops instead, before it
spends anything, names the fix, and that no other model is picked for it.
"""

import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules import tts_languages as tl
from modules.audio_mixer import VoiceUnavailable, verify_voice

ROOT = Path(__file__).resolve().parent.parent
NOT_UZBEK = ("eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5")


def channel(language, provider="elevenlabs"):
    ctx = MagicMock()
    ctx.agent.tts_provider = provider
    ctx.agent.language = language
    ctx.agent.elevenlabs_voice_id = "pNInz6obpgDQGcFmaJgB"
    ctx.agent.elevenlabs_secondary_voice_id = "narrator"
    ctx.agent.target_duration_seconds = 60
    return ctx


class TheTableIsOneTable(unittest.TestCase):
    def test_the_command_center_copy_equals_the_python_table(self):
        """The picker and the run must disagree on nothing: a model the picker offers for Uzbek
        and the run refuses would make a person wait for a refusal."""
        ts = (ROOT / "command-center/lib/ttsLanguages.ts").read_text(encoding="utf-8")
        block = re.search(r"TTS_MODEL_LANGUAGES[^=]*=\s*\{(.*?)\n\};", ts, re.S)
        self.assertIsNotNone(block, "TTS_MODEL_LANGUAGES not found in ttsLanguages.ts")
        parsed = {m: tuple(re.findall(r'"([a-z]{2})"', langs))
                  for m, langs in re.findall(r"^\s*([a-z0-9_]+):\s*\[([^\]]*)\]", block.group(1), re.M)}
        self.assertEqual(parsed, tl.MODEL_LANGUAGES)
        self.assertIn('"uz", "ru", "en"', ts)
        self.assertIn(tl.SOURCE_URL, ts)
        self.assertIn(tl.SOURCE_READ_ON, ts)

    def test_only_the_three_verified_languages_appear(self):
        for model, langs in tl.MODEL_LANGUAGES.items():
            self.assertTrue(set(langs) <= set(tl.VERIFIED_LANGUAGES), model)

    def test_the_docs_lists_are_the_ones_written_down(self):
        for model in ("eleven_v4", "eleven_v4_turbo", "eleven_v3", "eleven_v3_conversational", "eleven_ttv_v3"):
            self.assertTrue(tl.speaks(model, "uz"), model)
        for model in (*NOT_UZBEK, "eleven_multilingual_sts_v2", "eleven_multilingual_ttv_v2"):
            self.assertIs(tl.speaks(model, "uz"), False, model)
            self.assertTrue(tl.speaks(model, "Russian"), model)

    def test_an_unverified_language_or_model_is_unknown_not_no(self):
        """Arabic was never checked against the page; guessing 'no' would stop a channel on a hunch."""
        self.assertIsNone(tl.speaks("eleven_multilingual_v2", "Arabic"))
        self.assertIsNone(tl.speaks("some_future_model", "uz"))
        self.assertIsNone(tl.refusal("eleven_multilingual_v2", "Arabic"))
        self.assertIsNone(tl.refusal("eleven_multilingual_v2", None))

    def test_every_way_a_person_writes_uzbek_is_uzbek(self):
        for value in ("Uzbek", "uzbek", "uz", "UZ", "uz-Latn", "uzb", "Oʻzbek", "O'zbek", "Uzbek (Latin script)"):
            self.assertEqual(tl.language_code(value), "uz", value)


class TheRunStopsBeforeItSpends(unittest.TestCase):
    @patch("modules.audio_mixer.ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_uzbek_on_the_default_model_stops_with_the_fix_and_no_request(self, get):
        with self.assertRaises(VoiceUnavailable) as caught:
            verify_voice(channel("Uzbek"))
        self.assertIn(tl.UZBEK_REMEDY, str(caught.exception))
        get.assert_not_called()

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "")
    @patch("modules.audio_mixer.requests.get")
    def test_the_language_refusal_comes_before_the_missing_key_one(self, get):
        """A new key would not make Multilingual v2 speak Uzbek, so that is not the first fix to name."""
        with patch("modules.audio_mixer.ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"):
            with self.assertRaises(VoiceUnavailable) as caught:
                verify_voice(channel("uz"))
        self.assertIn("does not speak Uzbek", str(caught.exception))

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_flash_and_turbo_stop_too(self, get):
        for model in ("eleven_flash_v2_5", "eleven_turbo_v2_5"):
            with self.subTest(model=model), patch("modules.audio_mixer.ELEVENLABS_MODEL_ID", model):
                with self.assertRaises(VoiceUnavailable) as caught:
                    verify_voice(channel("Uzbek"))
                self.assertIn("Eleven v4 or v3", str(caught.exception))
        get.assert_not_called()

    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_v3_and_v4_pass_the_language_check(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: {})
        for model in ("eleven_v3", "eleven_v4"):
            with self.subTest(model=model), patch("modules.audio_mixer.ELEVENLABS_MODEL_ID", model):
                verify_voice(channel("Uzbek"))

    @patch("modules.audio_mixer.ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
    @patch("modules.audio_mixer.ELEVENLABS_API_KEY", "k")
    @patch("modules.audio_mixer.requests.get")
    def test_russian_and_english_channels_are_untouched(self, get):
        get.return_value = MagicMock(status_code=200, json=lambda: {})
        for language in ("Russian", "English", "Arabic"):
            verify_voice(channel(language))

    @patch("modules.audio_mixer.ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
    @patch("modules.audio_mixer.requests.get")
    def test_an_edge_channel_is_not_judged_by_an_elevenlabs_table(self, get):
        verify_voice(channel("Uzbek", provider="edge"))
        get.assert_not_called()

    def test_scene_repair_and_other_entry_points_refuse_at_synthesis_too(self):
        """A mixer built without verify_voice (scene repair) must not read Uzbek on v2 either."""
        from modules import audio_mixer
        with tempfile.TemporaryDirectory() as d, patch.object(audio_mixer, "OUTPUT_DIR", Path(d)):
            m = audio_mixer.AudioMixer("t", channel=channel("Uzbek"))
        m.elevenlabs_model = "eleven_multilingual_v2"
        sdk = MagicMock()
        with patch.dict(sys.modules, {"elevenlabs": sdk}), tempfile.TemporaryDirectory() as d:
            with self.assertRaises(VoiceUnavailable):
                m._tts_elevenlabs("Salom", "pNInz6obpgDQGcFmaJgB", Path(d) / "seg.mp3")
        sdk.ElevenLabs.assert_not_called()


class TheCreativeVoiceToolRefusesToo(unittest.TestCase):
    def setUp(self):
        from modules import model_registry as reg
        from modules.capabilities import build_adapter
        self.entries = reg.load()
        self.adapter = build_adapter("audio.elevenlabs_tts", env={"ELEVENLABS_API_KEY": "k"})

    def request(self, language):
        from modules.capabilities.base import CapabilityRequest
        return CapabilityRequest("tts", "Salom", voice_id="pNInz6obpgDQGcFmaJgB", text_language=language)

    def test_uzbek_text_on_multilingual_v2_is_refused_before_any_hold(self):
        problems = self.adapter.problems(self.request("uz"), self.entries["elevenlabs-multilingual-v2"])
        self.assertTrue(any("does not speak Uzbek" in p for p in problems), problems)

    def test_uzbek_text_on_v3_is_not_refused_for_its_language(self):
        problems = self.adapter.problems(self.request("uz"), self.entries["elevenlabs-v3"])
        self.assertFalse(any("Uzbek" in p for p in problems), problems)

    def test_text_with_no_language_named_is_not_judged(self):
        problems = self.adapter.problems(self.request(None), self.entries["elevenlabs-multilingual-v2"])
        self.assertFalse(any("Uzbek" in p for p in problems), problems)

    def test_submit_refuses_without_calling_the_vendor(self):
        from modules.capabilities.base import AdapterError
        with patch.object(type(self.adapter), "_audio") as audio:
            with self.assertRaises(AdapterError):
                self.adapter.submit(self.request("Uzbek"), "eleven_flash_v2_5")
        audio.assert_not_called()

    def test_the_job_language_reaches_the_request(self):
        from modules.creative_adapters import capability_request
        job = MagicMock(capability="tts", prompt=None, params={"prompt": "Salom", "voice_id": "x", "language": "uz"},
                        input_files=(), reference_files=(), end_file=None, org_id="o")
        self.assertEqual(capability_request(job).text_language, "uz")


if __name__ == "__main__":
    unittest.main()
