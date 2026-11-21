"""Gemini 3.8 Flash TTS (Gemini API): narration and two-voice dialogue in Uzbek, Russian and English, dark until probed.

No network, no key: a fake ``requests`` session answers each call, so every answer (audio, 401, 429, 5xx, a block)
travels through the real ``HttpAdapter._call`` error path, the layer production uses, not a stub above it.

What would break without these tests:

* a language nobody verified (or none at all) read by the voice anyway, or "fixed" with another voice or model;
* a third speaker silently read in one of the two voices, or a dialogue line names nobody speaks;
* a rejected key, a rate limit and a Google outage given the same remedy, or a decision made retryable;
* the key leaking into an exception or a log line;
* raw 24 kHz PCM stored as if it were a WAV, or stored at a guessed sample rate (the voice would sound wrong, nothing would fail);
* text longer than the bound sent and paid for before the refusal;
* the entries becoming sellable, reachable from the API, or usable by an account that said it is under 18.
"""

from __future__ import annotations

import base64
import json
import logging
import struct
import unittest
from pathlib import Path

from modules import model_registry as reg
from modules import tts_languages
from modules.capabilities import ADAPTERS
from modules.capabilities.audio import ElevenLabsTTSAdapter
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    TTS,
    AdapterError,
    CapabilityRequest,
)
from modules.capabilities.gemini_tts import MAX_TEXT_CHARS, GeminiTTSAdapter, pcm_to_wav

ROOT = Path(__file__).resolve().parent.parent
KEY = "AIzaSyTEST-not-a-real-key-0123456789abcd"
MODEL = "gemini-3.8-flash-tts"
IDS = ("gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts")
UZ_LINE = ("Salom, mening ismim Dilnoza. Bugun 21-noyabr, soat to'qqizda yangi film boshlanadi. "
           "Bilasizmi, bu kunni uch yil kutdim!")
PCM = struct.pack("<8h", 0, 1000, -1000, 2000, -2000, 3000, -3000, 0)


class FakeResp:
    def __init__(self, status=200, body=None, text=None):
        self.status_code = status
        self._body = body
        self.text = text if text is not None else json.dumps(body if body is not None else {})
        self.headers = {}

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


class FakeSession:
    """Records every request; answers with the queued responses in order."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kw):
        self.calls.append({"method": method, "url": url, **kw})
        return self.responses.pop(0)


def audio_answer(data: bytes = PCM, mime: str = "audio/L16;codec=pcm;rate=24000", finish: str = "STOP") -> FakeResp:
    """The recorded shape of a generateContent audio answer (inlineData, base64)."""
    return FakeResp(200, {"candidates": [{"content": {"role": "model", "parts": [
        {"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode("ascii")}}]},
        "finishReason": finish}], "usageMetadata": {"promptTokenCount": 30}})


def google_error(status: int, name: str, message: str) -> FakeResp:
    return FakeResp(status, {"error": {"code": status, "status": name, "message": message}})


def adapter(*responses):
    session = FakeSession(*responses)
    return GeminiTTSAdapter(env={"GEMINI_API_KEY": KEY}, session=session), session


def narration(**kw) -> CapabilityRequest:
    base = dict(capability=TTS, prompt=UZ_LINE, voice_id="Kore", text_language="uz")
    base.update(kw)
    return CapabilityRequest(**base)


DIALOGUE = "Dilnoza: Salom, Aziz! Film boshlandimi?\nAziz: Ha, hozirgina boshlandi."


def dialogue(**kw) -> CapabilityRequest:
    base = dict(capability=TTS, prompt=DIALOGUE, speakers=(("Dilnoza", "Kore"), ("Aziz", "Puck")), text_language="uz")
    base.update(kw)
    return CapabilityRequest(**base)


class Narration(unittest.TestCase):
    def test_uzbek_russian_and_english_are_each_synthesised(self):
        for lang, text in (("uz", UZ_LINE), ("Russian", "Привет, меня зовут Дильноза."), ("en-US", "Hello, I am Dilnoza.")):
            a, s = adapter(audio_answer())
            task = a.submit(narration(prompt=text, text_language=lang), MODEL)
            self.assertEqual(task.outputs[0].mime, "audio/wav", lang)
            self.assertEqual(len(s.calls), 1, lang)

    def test_the_request_is_the_generate_content_audio_shape_with_the_key_in_a_header_only(self):
        a, s = adapter(audio_answer())
        a.submit(narration(style="Calm and warm, a little slow"), MODEL)
        call = s.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent")
        self.assertEqual(call["headers"]["x-goog-api-key"], KEY)
        self.assertNotIn(KEY, call["url"])
        self.assertFalse(call.get("params"))
        self.assertIs(call["allow_redirects"], False, "the key header must never follow a redirect")
        body = call["json"]
        self.assertEqual(body["generationConfig"]["responseModalities"], ["AUDIO"])
        self.assertEqual(body["generationConfig"]["speechConfig"],
                         {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}})
        # The direction travels with the words, ahead of them; the words themselves are untouched.
        self.assertEqual(body["contents"][0]["parts"][0]["text"], f"Calm and warm, a little slow: {UZ_LINE}")

    def test_raw_pcm_becomes_a_wav_at_the_rate_the_answer_states(self):
        a, _ = adapter(audio_answer(mime="audio/L16;codec=pcm;rate=24000"))
        wav = a.submit(narration(), MODEL).outputs[0].data
        self.assertEqual(wav[:4], b"RIFF")
        self.assertEqual(wav[8:12], b"WAVE")
        channels, rate, _, _, bits = struct.unpack("<HIIHH", wav[22:36])
        self.assertEqual((channels, rate, bits), (1, 24000, 16))
        self.assertEqual(wav[44:], PCM, "the samples are stored as they came, not re-encoded")
        self.assertEqual(wav, pcm_to_wav(PCM, 24000))

    def test_a_wav_answer_is_kept_as_is(self):
        wav = pcm_to_wav(PCM, 24000)
        a, _ = adapter(audio_answer(data=wav, mime="audio/wav"))
        self.assertEqual(a.submit(narration(), MODEL).outputs[0].data, wav)

    def test_pcm_without_a_stated_rate_is_not_delivered_at_a_guessed_one(self):
        a, _ = adapter(audio_answer(mime="audio/L16;codec=pcm"))
        with self.assertRaises(AdapterError) as cm:
            a.submit(narration(), MODEL)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertIn("sample rate", cm.exception.message)

    def test_a_cut_off_answer_is_not_delivered(self):
        a, _ = adapter(audio_answer(finish="MAX_TOKENS"))
        with self.assertRaises(AdapterError) as cm:
            a.submit(narration(), MODEL)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)


class Language(unittest.TestCase):
    def test_a_language_nobody_verified_is_refused_with_its_reason_and_no_call(self):
        for lang in ("Arabic", "kk", "Turkish"):
            a, s = adapter()
            with self.assertRaises(AdapterError) as cm:
                a.submit(narration(text_language=lang), MODEL)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, lang)
            self.assertTrue(cm.exception.not_accepted, lang)
            self.assertIn("not verified for language", cm.exception.message, lang)
            self.assertIn("No other voice or model is substituted", cm.exception.message, lang)
            self.assertEqual(s.calls, [], lang)

    def test_no_language_at_all_is_refused_not_guessed(self):
        a, s = adapter()
        with self.assertRaises(AdapterError) as cm:
            a.submit(narration(text_language=None), MODEL)
        self.assertIn("content language is required", cm.exception.message)
        self.assertEqual(s.calls, [])

    def test_the_language_table_says_gemini_speaks_uzbek_and_cites_googles_page(self):
        for model in IDS:
            for code in ("uz", "ru", "en"):
                self.assertIs(tts_languages.speaks(model, code), True, (model, code))
            self.assertEqual(tts_languages.MODEL_SOURCES[model][0], "https://aistudio.google.com/docs/speech-generation")
            self.assertEqual(tts_languages.VENDOR_LANGUAGE_NAMES[model]["uz"], "Northern Uzbek")
        self.assertIsNone(tts_languages.refusal(MODEL, "Uzbek"))


class Dialogue(unittest.TestCase):
    def test_two_speakers_are_sent_as_two_named_prebuilt_voices(self):
        a, s = adapter(audio_answer())
        a.submit(dialogue(), MODEL)
        body = s.calls[0]["json"]
        self.assertEqual(body["generationConfig"]["speechConfig"], {"multiSpeakerVoiceConfig": {"speakerVoiceConfigs": [
            {"speaker": "Dilnoza", "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}},
            {"speaker": "Aziz", "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Puck"}}}]}})
        self.assertEqual(body["contents"][0]["parts"][0]["text"], DIALOGUE)

    def test_a_third_speaker_is_refused_before_any_call(self):
        a, s = adapter()
        three = (("Dilnoza", "Kore"), ("Aziz", "Puck"), ("Bobur", "Charon"))
        with self.assertRaises(AdapterError) as cm:
            a.submit(dialogue(speakers=three, prompt=DIALOGUE + "\nBobur: Men ham keldim."), MODEL)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertIn("at most 2 speakers", cm.exception.message)
        self.assertEqual(s.calls, [])

    def test_a_voice_not_on_the_prebuilt_list_is_refused(self):
        for speakers in ((("Dilnoza", "Kore"), ("Aziz", "pNInz6obpgDQGcFmaJgB")), (("Dilnoza", "kore"), ("Aziz", "Puck"))):
            a, s = adapter()
            with self.assertRaises(AdapterError) as cm:
                a.submit(dialogue(speakers=speakers), MODEL)
            self.assertIn("prebuilt voices", cm.exception.message)
            self.assertEqual(s.calls, [])
        a, s = adapter()
        with self.assertRaises(AdapterError):
            a.submit(narration(voice_id=None), MODEL)
        self.assertEqual(s.calls, [], "no voice is ever picked for the caller")

    def test_a_line_for_someone_who_is_not_a_speaker_is_refused(self):
        a, s = adapter()
        with self.assertRaises(AdapterError) as cm:
            a.submit(dialogue(prompt=DIALOGUE + "\nBobur: Men ham keldim."), MODEL)
        self.assertIn("'Bobur'", cm.exception.message)
        self.assertEqual(s.calls, [])

    def test_another_adapter_refuses_a_dialogue_or_a_style_instead_of_dropping_it(self):
        entry = reg.load()["elevenlabs-v3"]
        el = ElevenLabsTTSAdapter(env={})
        both = CapabilityRequest(capability=TTS, prompt="Dilnoza: Salom\nAziz: Salom", voice_id="A" * 20,
                                 speakers=(("Dilnoza", "Kore"), ("Aziz", "Puck")), style="warm")
        problems = el.problems(both, entry)
        self.assertTrue(any("dialogue" in p for p in problems), problems)
        self.assertTrue(any("delivery style" in p for p in problems), problems)


class Errors(unittest.TestCase):
    def _fail(self, resp) -> AdapterError:
        a, s = adapter(resp)
        with self.assertRaises(AdapterError) as cm:
            a.submit(narration(), MODEL)
        self.assertEqual(len(s.calls), 1, "a refusal is never retried inside the adapter")
        return cm.exception

    def test_401_403_and_googles_400_bad_key_are_auth_and_final(self):
        for resp in (google_error(401, "UNAUTHENTICATED", "Request had invalid authentication credentials."),
                     google_error(403, "PERMISSION_DENIED", "Method doesn't allow unregistered callers."),
                     google_error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.")):
            e = self._fail(resp)
            self.assertEqual(e.code, E_AUTH, e.message)
            self.assertFalse(e.retryable)

    def test_429_rate_limit_is_transient_even_though_google_says_quota(self):
        e = self._fail(google_error(429, "RESOURCE_EXHAUSTED",
                                    "You exceeded your current quota for requests per minute. Please retry in 20s."))
        self.assertEqual(e.code, E_RATE_LIMITED)
        self.assertTrue(e.retryable)
        self.assertTrue(e.not_accepted)

    def test_429_naming_billing_is_the_accounts_quota_not_a_slow_down(self):
        e = self._fail(google_error(429, "RESOURCE_EXHAUSTED",
                                    "You exceeded your current quota, please check your plan and billing details."))
        self.assertEqual(e.code, E_QUOTA)
        self.assertFalse(e.retryable)

    def test_5xx_is_unavailable_and_may_have_been_taken(self):
        for status in (500, 503):
            e = self._fail(google_error(status, "UNAVAILABLE", "The model is overloaded."))
            self.assertEqual(e.code, E_UNAVAILABLE)
            self.assertTrue(e.retryable)
            self.assertFalse(e.not_accepted, "a 5xx does not prove nothing was billed")

    def test_blocked_text_is_policy_and_says_billing_is_unknown(self):
        e = self._fail(FakeResp(200, {"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}}))
        self.assertEqual(e.code, E_POLICY)
        self.assertIn("BILLING UNKNOWN", e.message)
        e = self._fail(FakeResp(200, {"candidates": [{"finishReason": "SAFETY", "content": {"parts": []}}]}))
        self.assertEqual(e.code, E_POLICY)

    def test_the_four_remedies_are_distinct(self):
        codes = {self._fail(google_error(401, "UNAUTHENTICATED", "bad")).code,
                 self._fail(google_error(429, "RESOURCE_EXHAUSTED", "Too many requests per minute, quota")).code,
                 self._fail(google_error(503, "UNAVAILABLE", "overloaded")).code,
                 self._fail(FakeResp(200, {"promptFeedback": {"blockReason": "SAFETY"}})).code}
        self.assertEqual(codes, {E_AUTH, E_RATE_LIMITED, E_UNAVAILABLE, E_POLICY})


class TheKeyNeverLeaks(unittest.TestCase):
    def test_an_echoed_key_is_scrubbed_from_the_exception_and_the_log(self):
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger("probe").debug("start")
            a, _ = adapter(google_error(400, "INVALID_ARGUMENT", f"API key not valid: {KEY} (header x-goog-api-key={KEY})"))
            with self.assertRaises(AdapterError) as cm:
                a.submit(narration(), MODEL)
            logging.getLogger("probe").error("tts failed: %s", cm.exception)
        e = cm.exception
        for text in (str(e), e.message, repr(e.args), "\n".join(logs.output)):
            self.assertNotIn(KEY, text)
            self.assertNotIn(KEY[8:20], text)
        self.assertEqual(e.code, E_AUTH)

    def test_a_network_failure_names_only_its_class(self):
        import requests

        class Boom(FakeSession):
            def request(self, method, url, **kw):
                raise requests.exceptions.ReadTimeout(f"timed out; headers={kw.get('headers')}")

        a = GeminiTTSAdapter(env={"GEMINI_API_KEY": KEY}, session=Boom())
        with self.assertRaises(AdapterError) as cm:
            a.submit(narration(), MODEL)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        self.assertNotIn(KEY, str(cm.exception))


class LengthIsCheckedFirst(unittest.TestCase):
    def test_text_over_the_bound_is_refused_before_the_call(self):
        a, s = adapter()
        with self.assertRaises(AdapterError) as cm:
            a.submit(narration(prompt="a" * (MAX_TEXT_CHARS + 1)), MODEL)
        self.assertIn(f"at most {MAX_TEXT_CHARS}", cm.exception.message)
        self.assertEqual(s.calls, [])

    def test_the_style_counts_toward_the_bound(self):
        a, s = adapter()
        with self.assertRaises(AdapterError):
            a.submit(narration(prompt="a" * (MAX_TEXT_CHARS - 5), style="Slow and very calm"), MODEL)
        self.assertEqual(s.calls, [])

    def test_the_registry_bound_matches_the_adapter(self):
        for mid in IDS:
            self.assertEqual(reg.load()[mid].max_prompt_chars, MAX_TEXT_CHARS)


class TheEntriesStayDark(unittest.TestCase):
    def test_both_entries_exist_on_this_adapter_and_are_gated_web_only_unpriced(self):
        entries = reg.load()
        self.assertIs(ADAPTERS["audio.gemini_tts"], GeminiTTSAdapter)
        for mid in IDS:
            e = entries[mid]
            self.assertEqual(e.adapter, "audio.gemini_tts")
            self.assertTrue((e.terms_gate or "").strip(), f"{mid} must carry a terms_gate until probed and cleared")
            self.assertEqual(e.api_exposure, "web_only")
            self.assertFalse(e.raw["pricing"]["confirmed"])
            self.assertIsNone(e.raw["pricing"]["provider_usd_per_unit"])
            self.assertNotIn("mcp_oauth_exposure", e.raw)
            self.assertTrue(any("PROBE REQUIRED" in n for n in e.raw["terms_notes"]), mid)

    def test_the_registry_probe_is_servable_by_the_adapter(self):
        """The registry's own check builds the probe request; it must name a Gemini voice and a language."""
        e = reg.load()[MODEL]
        req = e.probe_request(voice_id="A" * 20)
        self.assertEqual((req.voice_id, req.text_language), ("Kore", "uz"))
        self.assertEqual(GeminiTTSAdapter(env={}).problems(req, e), [])


class AMinorCannotUseThem(unittest.TestCase):
    """0192 records each account's 18+ answer; 0196 refuses a requires_adult model with adult_only_service for a
    "minor" answer. That refusal reads ``public.model_requires_adult(spec)``, i.e. spec.requires_adult synced from the
    file, and the Studio locks the model from the same flag (studio.ts adultOnly -> age.ts adultLock)."""

    def test_both_rows_are_marked_and_the_mark_reaches_the_spec_the_database_reads(self):
        entries = reg.load()
        rows = {r["id"]: r for r in reg.sync_rows(list(entries.values()))}
        for mid in IDS:
            self.assertIs(entries[mid].raw.get("requires_adult"), True, mid)
            self.assertIs(rows[mid]["spec"]["requires_adult"], True, mid)

    def test_the_database_gate_refuses_a_minor_by_that_flag(self):
        sql = (ROOT / "supabase/migrations/0192_adult_attestation.sql").read_text(encoding="utf-8")
        self.assertIn("return (p_spec -> 'requires_adult')::boolean;", sql)
        runs = (ROOT / "supabase/migrations/0196_adult_attestation_google_runs.sql").read_text(encoding="utf-8")
        self.assertIn("adult_only_service", runs)

    def test_the_studio_locks_the_model_for_a_minor(self):
        studio = (ROOT / "command-center/lib/creative/studio.ts").read_text(encoding="utf-8")
        self.assertIn("...(spec.requires_adult === true ? { adultOnly: true } : {}),", studio)
        age = (ROOT / "command-center/lib/age.ts").read_text(encoding="utf-8")
        self.assertIn('return model.adultOnly && (state === "none" || state === "minor") ? "adult_only" : null;', age)


class TheOwnerProbe(unittest.TestCase):
    def _run(self, argv, make):
        import contextlib
        import io
        from unittest import mock

        from tools import probe_gemini_tts as probe

        buf = io.StringIO()
        with mock.patch.object(probe, "GeminiTTSAdapter", make), contextlib.redirect_stdout(buf):
            code = probe.main(argv)
        return code, buf.getvalue()

    def test_without_a_key_it_fails_with_the_remedy_and_calls_nothing(self):
        session = FakeSession()
        code, out = self._run(["--voice", "Kore"], lambda env: GeminiTTSAdapter(env={}, session=session))
        self.assertEqual(code, 1)
        self.assertTrue(out.startswith("FAILED not_configured"), out)
        self.assertIn("GEMINI_API_KEY", out)
        self.assertEqual(session.calls, [])

    def test_it_sends_the_uzbek_line_and_writes_a_wav_printing_only_the_path(self):
        import tempfile

        session = FakeSession(audio_answer())
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "probe.wav"
            code, out = self._run(["--voice", "Kore", "--out", str(path)],
                                  lambda env: GeminiTTSAdapter(env={"GEMINI_API_KEY": KEY}, session=session))
            self.assertEqual(code, 0)
            self.assertEqual(path.read_bytes()[:4], b"RIFF")
        self.assertEqual(out.strip(), f"OK {path.resolve()}")
        self.assertNotIn(KEY, out)
        self.assertEqual(session.calls[0]["json"]["contents"][0]["parts"][0]["text"], UZ_LINE)


if __name__ == "__main__":
    unittest.main()
