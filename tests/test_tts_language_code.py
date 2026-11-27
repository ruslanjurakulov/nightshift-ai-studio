"""The narration request tells a v3/v4 model which language it reads (docs/studio/S6_GAPS.md G4).

Without ``language_code`` Eleven v3/v4 guess the language from the text, and Uzbek written in Latin letters can come out
with another language's numbers and stress: nothing fails, the film just sounds wrong (rule 4). Multilingual v2 refuses the
field by name in the API reference, so it must never get it. A fake HTTP layer records the body; nothing reaches a network.
"""

from __future__ import annotations

import json
import unittest

from modules import tts_languages as tl
from modules.capabilities import build_adapter
from modules.capabilities.base import CapabilityRequest
from tests.test_capabilities import FakeResp, FakeSession

ENV = {"ELEVENLABS_API_KEY": "xi-test-key-not-real-000"}
VOICE = "AbCdEfGhIjKlMnOpQrSt"
MP3 = b"ID3\x04\x00" + b"\x00" * 32


def sent_body(vendor_model, language):
    session = FakeSession([("POST", "/v1/text-to-speech/", FakeResp(200, content=MP3))])
    adapter = build_adapter("audio.elevenlabs_tts", env=ENV, session=session)
    adapter.submit(CapabilityRequest("tts", "Salom, dunyo", voice_id=VOICE, text_language=language), vendor_model)
    (method, url, kw), = session.calls
    return kw["json"]


class TheBodyNamesTheLanguage(unittest.TestCase):
    def test_v3_and_v4_get_the_two_letter_code(self):
        for model in ("eleven_v3", "eleven_v4"):
            for language, code in (("uz", "uz"), ("Uzbek", "uz"), ("Oʻzbek", "uz"), ("ru", "ru"), ("English", "en")):
                body = sent_body(model, language)
                self.assertEqual(body, {"text": "Salom, dunyo", "model_id": model, "language_code": code}, (model, language))

    def test_multilingual_v2_never_gets_the_field(self):
        """The API reference: language_code 'is not supported for multilingual_v2 models'."""
        for language in ("ru", "en", "Russian"):
            body = sent_body("eleven_multilingual_v2", language)
            self.assertEqual(body, {"text": "Salom, dunyo", "model_id": "eleven_multilingual_v2"})

    def test_flash_is_not_sent_a_field_its_docs_do_not_promise(self):
        self.assertNotIn("language_code", sent_body("eleven_flash_v2_5", "ru"))

    def test_no_language_named_sends_none(self):
        self.assertEqual(sent_body("eleven_v3", None), {"text": "Salom, dunyo", "model_id": "eleven_v3"})

    def test_an_unverified_language_is_not_enforced(self):
        """Arabic was never checked against the model page: forcing it would be a claim nobody verified."""
        self.assertNotIn("language_code", sent_body("eleven_v3", "ar"))


class TheListLivesBesideTheLanguageTable(unittest.TestCase):
    def test_every_model_that_takes_the_code_is_a_model_the_table_knows(self):
        self.assertLessEqual(set(tl.LANGUAGE_CODE_MODELS), set(tl.MODEL_LANGUAGES))

    def test_multilingual_v2_flash_and_deprecated_models_are_out(self):
        for model in ("eleven_multilingual_v2", "eleven_multilingual_sts_v2", "eleven_multilingual_ttv_v2",
                      "eleven_flash_v2_5", *tl.DEPRECATED_MODELS):
            self.assertNotIn(model, tl.LANGUAGE_CODE_MODELS, model)
            self.assertIsNone(tl.vendor_language_code(model, "uz"), model)

    def test_the_code_is_iso_639_1(self):
        self.assertEqual(tl.vendor_language_code("eleven_v4", "uz_UZ"), "uz")
        self.assertEqual(tl.vendor_language_code("eleven_v4", "uzb"), "uz")
        self.assertEqual(json.dumps(tl.vendor_language_code("eleven_v3", "Русский")), '"ru"')


if __name__ == "__main__":
    unittest.main()
