"""The language speech is transcribed in is locked, never guessed (owner decision, 21 Nov 2026).

The owner spoke Uzbek with a slight accent and the speech recogniser decided it was another language. Whisper and the
caption vendors guess the language only when none is given, so every recogniser here is given the language of the
run (the channel's, or this run's --language), the film or the job, and work with no language stops by name
(CLAUDE.md rules 4 and 6). The interface language is never a source: an Uzbek user may make English content.

What would break:
* the pipeline's Whisper call goes out with no ``language`` (Whisper auto-detects again);
* a channel language Whisper does not know is found at Stage 5, after the script and voice were paid for;
* a missing language reads as ``None`` somewhere and is passed through as "detect it";
* the registry's captions probe (a paid call) is sent for the vendor to detect.
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from modules import captions as cap
from modules import model_registry as reg

#: Whisper's own table is code -> lower-case English name (whisper.tokenizer.LANGUAGES).
TABLE = {"en": "english", "ru": "russian", "uz": "uzbek", "tr": "turkish"}


def fake_tokenizer():
    return {"whisper.tokenizer": types.SimpleNamespace(LANGUAGES=TABLE)}


class WhisperLanguage(unittest.TestCase):
    def test_a_channel_language_by_name_or_code_becomes_whispers_code(self):
        for given, code in (("Uzbek", "uz"), ("uzbek", "uz"), (" Uzbek ", "uz"), ("uz", "uz"), ("Russian", "ru"),
                            ("English", "en"), ("EN", "en")):
            self.assertEqual(cap.whisper_language(given, known=TABLE), code, given)

    def test_no_language_is_refused_never_none_which_whisper_reads_as_detect(self):
        for missing in (None, "", "   ", 3):
            with self.assertRaises(cap.CaptionLanguageMissing) as cm:
                cap.whisper_language(missing, known=TABLE)
            self.assertEqual(cm.exception.code, "captions_language_missing")
            self.assertIn("set the channel's language", cm.exception.message)

    def test_a_language_whisper_does_not_know_is_refused_by_name(self):
        with self.assertRaises(cap.CaptionLanguageMissing) as cm:
            cap.whisper_language("Klingon", known=TABLE)
        self.assertIn("'Klingon'", cm.exception.message)

    @unittest.skipUnless(__import__("importlib.util").util.find_spec("whisper"), "openai-whisper is not installed")
    def test_whispers_real_table_knows_the_three_languages_we_sell(self):
        self.assertEqual([cap.whisper_language(n) for n in ("Uzbek", "Russian", "English")], ["uz", "ru", "en"])


class SubtitleGeneratorPassesTheLanguage(unittest.TestCase):
    """The pipeline's Stage 5 (modules/subtitle_generator.py) with Whisper's model replaced."""

    def setUp(self):
        try:
            from modules import subtitle_generator as sg  # noqa: PLC0415 — imports whisper (torch)
        except ImportError as e:  # pragma: no cover — the CI image has it
            self.skipTest(f"whisper is not installed ({e.name})")
        self.sg = sg
        self.calls = []
        calls = self.calls

        class Model:
            def transcribe(self, path, **kw):
                calls.append(kw)
                return {"segments": [{"words": [{"word": " Salom", "start": 0.1, "end": 0.4}]}]}
        gen = sg.SubtitleGenerator.__new__(sg.SubtitleGenerator)
        gen._model = Model()
        self.gen = gen

    def test_the_channels_language_reaches_whisper(self):
        with mock.patch.dict(sys.modules, fake_tokenizer()):
            words = self.gen.transcribe(Path("narration.mp3"), "Uzbek")
        self.assertEqual(self.calls[0]["language"], "uz")
        self.assertEqual(words, [{"word": "Salom", "start": 0.1, "end": 0.4}])

    def test_no_language_never_reaches_whisper(self):
        with mock.patch.dict(sys.modules, fake_tokenizer()):
            for missing in (None, ""):
                with self.assertRaises(cap.CaptionLanguageMissing):
                    self.gen.transcribe(Path("narration.mp3"), missing)
        self.assertEqual(self.calls, [])


class ProviderSeam(unittest.TestCase):
    def test_the_speech_to_text_provider_hands_the_language_to_the_engine(self):
        from modules.providers import WhisperSpeechToTextProvider  # noqa: PLC0415
        seen = []

        class Engine:
            def transcribe(self, audio_path, language):
                seen.append((audio_path, language))
                return []
        WhisperSpeechToTextProvider(Engine()).transcribe("/tmp/n.mp3", "uz")
        self.assertEqual(seen, [(Path("/tmp/n.mp3"), "uz")])


class MainPreflight(unittest.TestCase):
    def setUp(self):
        import main  # noqa: PLC0415 — heavy, as in tests/test_disk_preflight.py
        self.main = main

    def ctx(self, language):
        return types.SimpleNamespace(agent=types.SimpleNamespace(language=language))

    def test_the_runs_script_language_is_what_whisper_will_hear(self):
        with mock.patch.dict(sys.modules, fake_tokenizer()), mock.patch.object(self.main.events, "emit") as emit:
            self.assertEqual(self.main._preflight_caption_language(self.ctx("Uzbek"), "chan"), "uz")
        emit.assert_not_called()

    def test_a_language_whisper_cannot_hear_stops_the_run_before_it_spends_and_says_why(self):
        with mock.patch.dict(sys.modules, fake_tokenizer()), mock.patch.object(self.main.events, "emit") as emit:
            with self.assertRaises(cap.CaptionLanguageMissing):
                self.main._preflight_caption_language(self.ctx("Klingon"), "chan")
        meta = emit.call_args.kwargs["metadata"]
        self.assertEqual((meta["stage"], meta["reason"]), ("preflight", "captions_language_missing"))
        self.assertEqual(emit.call_args.kwargs["agent"], "subtitle_generator")

    def test_the_preflight_runs_before_the_first_paid_stage_and_stage_5_uses_its_answer(self):
        # Source order is the contract here: a run() that reached Stage 5 without it would have paid for the script.
        src = Path(self.main.__file__).read_text(encoding="utf-8")
        pre = src.index("caption_language = _preflight_caption_language(ctx, channel_id)")
        self.assertLess(pre, src.index("# ── Stage 0c: Can the configured b-roll model be called at all?"))
        self.assertIn("sub_gen.transcribe(audio_path, caption_language)", src)
        self.assertNotIn("sub_gen.transcribe(audio_path)\n", src)


class ProbeNamesItsLanguage(unittest.TestCase):
    def test_every_captions_probe_names_the_language_of_its_own_speech(self):
        entries = [e for e in reg.registry().values() if "captions" in e.capabilities]
        self.assertGreaterEqual(len(entries), 2)
        for e in entries:
            req = e.probe_request(generated_speech="/tmp/probe.mp3")
            self.assertEqual(req.spoken_language, "en", e.id)
            self.assertIn("en", e.languages, e.id)


if __name__ == "__main__":
    unittest.main()
