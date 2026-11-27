"""ElevenLabs Text to Dialogue with timestamps (docs/studio/S6_GAPS.md G5 and §4): fakes only, no network, no key.

What must hold: the vendor gets exactly the documented body; a scene the vendor would cut short (over 2,000 characters), one
with more than 10 voices, an empty line, a typed voice or a language the model does not speak is refused before any call;
every line comes back with its own times, and an answer that cannot be mapped line for line, or whose audio is not clean
base64, fails closed instead of being guessed at; vendor errors mean what they mean for the TTS adapter; and the capability
stays registry-only (no row synced, nothing probed) until a migration teaches the database about it.
"""

from __future__ import annotations

import base64
import json
import unittest

from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    DIALOGUE,
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_QUOTA,
    E_RATE_LIMITED,
    REGISTRY_ONLY_CAPABILITIES,
    AdapterError,
    CapabilityRequest,
)
from modules.capabilities.dialogue import DIALOGUE_MAX_CHARS, decode_audio, line_times
from tests.test_capabilities import FakeResp, FakeSession

KEY = "xi-TOPSECRET-dialogue-key-0123456789"
ENV = {"ELEVENLABS_API_KEY": KEY}
AZIZA = "AzizaVoice0123456789"
BOBUR = "BoburVoice0123456789"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64
LINES = (("c1", AZIZA, "Salom, Bobur."), ("c2", BOBUR, "Salom, Aziza. Qalaysan?"), ("c1", AZIZA, "Yaxshi."))
PATH = "/v1/text-to-dialogue/with-timestamps"


def segments(*times, voices=(AZIZA, BOBUR, AZIZA)):
    return [{"voice_id": v, "start_time_seconds": s, "end_time_seconds": e, "character_start_index": 0,
             "character_end_index": 1, "dialogue_input_index": i}
            for i, (v, (s, e)) in enumerate(zip(voices, times))]


_DEFAULT = object()


def answer(segs=_DEFAULT, audio=_DEFAULT):
    return {"audio_base64": base64.b64encode(MP3).decode() if audio is _DEFAULT else audio,
            "voice_segments": segments((0.4, 1.6), (1.8, 3.25), (3.5, 4.0)) if segs is _DEFAULT else segs,
            "alignment": {"characters": [], "character_start_times_seconds": [], "character_end_times_seconds": []}}


def request(lines=LINES, language="uz", **kw):
    return CapabilityRequest(DIALOGUE, dialogue_lines=lines, text_language=language, **kw)


class Rig(unittest.TestCase):
    def setUp(self):
        self.entries = reg.load()
        self.v3 = self.entries["elevenlabs-dialogue-v3"]

    def adapter(self, resp=None):
        self.session = FakeSession([("POST", PATH, resp if resp is not None else FakeResp(200, answer()))])
        return build_adapter("audio.elevenlabs_dialogue", env=ENV, session=self.session)

    def refused(self, req, model="eleven_v3"):
        a = self.adapter()
        with self.assertRaises(AdapterError) as cm:
            a.submit(req, model)
        self.assertEqual(self.session.calls, [], "a refusal must come before any call")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        # problems() says the same before the worker would hold anything.
        self.assertTrue(a.problems(req, self.v3) or model != "eleven_v3")
        return cm.exception.message


class TheBodyIsTheDocumentedOne(Rig):
    def test_inputs_model_and_language_code(self):
        task = self.adapter().submit(request(), "eleven_v3")
        (method, url, kw), = self.session.calls
        self.assertEqual((method, url), ("POST", "https://api.elevenlabs.io" + PATH))
        self.assertEqual(kw["json"], {"inputs": [{"text": "Salom, Bobur.", "voice_id": AZIZA},
                                                 {"text": "Salom, Aziza. Qalaysan?", "voice_id": BOBUR},
                                                 {"text": "Yaxshi.", "voice_id": AZIZA}],
                                      "model_id": "eleven_v3", "language_code": "uz"})
        self.assertEqual(kw["params"], {"output_format": "mp3_44100_128"})
        self.assertEqual(kw["headers"]["xi-api-key"], KEY)
        self.assertIs(kw["allow_redirects"], False)
        self.assertEqual(task.adapter, "audio.elevenlabs_dialogue")

    def test_v4_takes_the_code_too_and_no_language_sends_none(self):
        self.adapter().submit(request(language="Russian"), "eleven_v4")
        self.assertEqual(self.session.calls[0][2]["json"]["language_code"], "ru")
        self.adapter().submit(request(language=None), "eleven_v3")
        self.assertNotIn("language_code", self.session.calls[0][2]["json"])


class RefusedBeforeAnyCall(Rig):
    def test_more_than_2000_characters(self):
        long = (("c1", AZIZA, "a" * 1000), ("c2", BOBUR, "b" * 1001))
        self.assertIn(f"at most {DIALOGUE_MAX_CHARS} characters", self.refused(request(long)))

    def test_exactly_2000_characters_is_sent(self):
        edge = (("c1", AZIZA, "a" * 1000), ("c2", BOBUR, "b" * 1000))
        self.adapter(FakeResp(200, answer(segs=segments((0, 1), (1, 2), voices=(AZIZA, BOBUR))))).submit(
            request(edge), "eleven_v3")
        self.assertEqual(len(self.session.calls), 1)

    def test_more_than_ten_voices(self):
        many = tuple((f"c{i}", f"Voice{i:02d}abcdefghijklm"[:20].ljust(20, "x"), "Salom.") for i in range(11))
        self.assertEqual(len({v for _c, v, _t in many}), 11)
        self.assertIn("at most 10 voices", self.refused(request(many)))

    def test_ten_voices_reused_across_many_lines_is_fine(self):
        ten = tuple((f"c{i % 10}", f"V{i % 10:02d}".ljust(20, "x"), "Ha.") for i in range(14))
        self.assertFalse(any("voices" in p for p in self.adapter().problems(request(ten), self.v3)))

    def test_a_language_the_model_does_not_speak(self):
        """eleven_v3 speaks Uzbek; multilingual_v2 does not, and the dialogue endpoint never runs it anyway."""
        msg = self.refused(request(), model="eleven_multilingual_v2")
        self.assertIn("does not speak Uzbek", msg)
        self.assertIn("Text to Dialogue takes", msg)

    def test_a_language_the_entry_does_not_list(self):
        self.assertIn("elevenlabs-dialogue-v3 does not speak fr",
                      self.adapter().problems(request(language="fr"), self.v3))

    def test_an_empty_line(self):
        self.assertIn("line 2 is empty", self.refused(request((("c1", AZIZA, "Salom."), ("c2", BOBUR, "   ")))))

    def test_a_typed_voice(self):
        self.assertIn("line 1: a voice_id from the account's voice list",
                      self.refused(request((("c1", "12345", "Salom."),))))

    def test_no_lines(self):
        self.assertIn("dialogue needs its lines", self.refused(request(())))

    def test_one_voice_for_the_whole_request(self):
        self.assertIn("a single voice does not apply", self.refused(request(voice_id=AZIZA)))

    def test_no_key_is_refused_without_a_call(self):
        session = FakeSession([])
        with self.assertRaises(AdapterError) as cm:
            build_adapter("audio.elevenlabs_dialogue", env={}, session=session).submit(request(), "eleven_v3")
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(session.calls, [])


class EveryLineGetsItsOwnTimes(Rig):
    def test_the_provenance_is_the_section_4_record(self):
        out, = self.adapter().submit(request(), "eleven_v3").outputs
        self.assertEqual((out.mime, out.data), ("audio/mpeg", MP3))
        self.assertEqual(out.provenance, {
            "kind": "dialogue",
            "lines": [{"character_id": "c1", "voice_id": AZIZA, "start_s": 0.4, "end_s": 1.6},
                      {"character_id": "c2", "voice_id": BOBUR, "start_s": 1.8, "end_s": 3.25},
                      {"character_id": "c1", "voice_id": AZIZA, "start_s": 3.5, "end_s": 4.0}],
            "model": "eleven_v3", "language": "uz", "loudness_lufs": None, "true_peak_db": None})
        # 0038 caps a provenance at 16 KB: no character alignment rides along.
        self.assertNotIn("alignment", json.dumps(out.provenance))

    def test_an_interruption_may_overlap_the_line_before(self):
        times = line_times(LINES, segments((0.0, 2.0), (1.5, 3.0), (3.0, 3.5)))
        self.assertEqual([(t["start_s"], t["end_s"]) for t in times], [(0.0, 2.0), (1.5, 3.0), (3.0, 3.5)])

    def test_a_line_split_into_segments_is_one_line_spanning_them(self):
        # The vendor: dialogue_input_index is the line "this segment is a part of". A pause inside a line is two segments.
        segs = segments((0, 1), (1, 2), (2, 2.5), (2.7, 3), voices=(AZIZA, BOBUR, AZIZA, AZIZA))
        segs[3]["dialogue_input_index"] = 2
        times = line_times(LINES, segs)
        self.assertEqual([(t["character_id"], t["start_s"], t["end_s"]) for t in times],
                         [("c1", 0.0, 1.0), ("c2", 1.0, 2.0), ("c1", 2.0, 3.0)])

    def assert_fails_closed(self, segs, words):
        with self.assertRaises(AdapterError) as cm:
            line_times(LINES, segs)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertIn(words, cm.exception.message)
        # And through the adapter: the vendor billed audio we cannot attribute, so it is a failure, not a guess.
        with self.assertRaises(AdapterError) as cm:
            self.adapter(FakeResp(200, answer(segs=segs))).submit(request(), "eleven_v3")
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertFalse(cm.exception.not_accepted)

    def test_a_segment_without_its_line_index_is_never_paired_by_position(self):
        segs = segments((0, 1), (1, 2), (2, 3))
        for s in segs:
            del s["dialogue_input_index"]
        self.assert_fails_closed(segs, "voice segment 1 does not name one of the 3 lines")

    def test_a_line_with_no_segment(self):
        self.assert_fails_closed(segments((0, 1), (1, 2)), "no voice segment for line(s) [3]")

    def test_an_index_beyond_the_lines(self):
        segs = segments((0, 1), (1, 2), (2, 3))
        segs[2]["dialogue_input_index"] = 3
        self.assert_fails_closed(segs, "voice segment 3 does not name one of the 3 lines")

    def test_a_segment_in_another_voice(self):
        self.assert_fails_closed(segments((0, 1), (1, 2), (2, 3), voices=(AZIZA, AZIZA, AZIZA)), "not in line 2's voice")

    def test_a_segment_that_names_another_line(self):
        segs = segments((0, 1), (1, 2), (2, 3))
        segs[2]["dialogue_input_index"] = 0
        # Segment 3 is Aziza's, claimed for line 1 (also Aziza's): line 3 is then never spoken.
        self.assert_fails_closed(segs, "no voice segment for line(s) [3]")

    def test_out_of_speaking_order(self):
        self.assert_fails_closed(segments((2, 3), (0, 1), (3, 4)), "starts before the line before it")

    def test_times_that_are_not_times(self):
        for bad in ((None, 1), (-0.1, 1), (2, 1), (True, 1), (float("nan"), 1), ("0.4", 1)):
            with self.subTest(bad=bad):
                self.assert_fails_closed(segments(bad, (2, 3), (3, 4)), "voice segment 1 has no usable times")

    def test_no_segments_at_all(self):
        self.assert_fails_closed(None, "no voice segments")


class EveryLimitIsCheckedBeforeTheCall(Rig):
    def test_more_lines_than_a_provenance_can_hold(self):
        from modules.capabilities.dialogue import DIALOGUE_MAX_LINES, line_problems
        many = tuple(("c1", AZIZA, "Ha.") for _ in range(DIALOGUE_MAX_LINES + 1))
        req = request(lines=many)
        self.assertTrue(any("at most" in p and "lines" in p for p in line_problems(req, "eleven_v3")))

    def test_the_worst_case_provenance_fits_0038s_16_kb(self):
        from modules.capabilities.dialogue import DIALOGUE_MAX_LINES
        line = {"character_id": "x" * 64, "voice_id": AZIZA, "start_s": 1234.567, "end_s": 1234.567}
        record = {"kind": "dialogue", "lines": [line] * DIALOGUE_MAX_LINES, "model": "eleven_v3", "language": "uz",
                  "loudness_lufs": None, "true_peak_db": None,
                  # The worker adds these (S2); leave room for them.
                  "film_take_id": "0" * 36, "scene_id": "0" * 36}
        self.assertLess(len(json.dumps(record).encode()), 16384)


class TheAudioIsDecodedStrictly(Rig):
    def test_clean_base64_is_the_file(self):
        self.assertEqual(decode_audio(base64.b64encode(MP3).decode()), MP3)

    def test_bad_base64_fails_closed(self):
        for bad in ("not base64!!", "QUJD$", "QUJ", "", None, 42):
            with self.subTest(bad=bad):
                with self.assertRaises(AdapterError) as cm:
                    self.adapter(FakeResp(200, answer(audio=bad))).submit(request(), "eleven_v3")
                self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
                # Decoded after the vendor answered 200: the audio may have been billed.
                self.assertFalse(cm.exception.not_accepted)

    def test_audio_that_is_not_mp3_fails_closed(self):
        for bad in (b"{\"error\": 1}", b"<html>", b"RIFF....WAVE"):
            with self.subTest(bad=bad):
                with self.assertRaises(AdapterError) as cm:
                    decode_audio(base64.b64encode(bad).decode())
                self.assertIn("not an MP3", cm.exception.message)
        self.assertEqual(decode_audio(base64.b64encode(b"\xff\xfb\x90\x00").decode()), b"\xff\xfb\x90\x00")

    def test_an_answer_that_is_not_json(self):
        with self.assertRaises(AdapterError) as cm:
            self.adapter(FakeResp(200, "<html>")).submit(request(), "eleven_v3")
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)


class VendorErrorsMeanWhatTheyMeanForTTS(Rig):
    def error(self, status, code):
        body = {"detail": {"code": code, "message": f"{code} {KEY}"}}
        with self.assertRaises(AdapterError) as cm:
            self.adapter(FakeResp(status, body)).submit(request(), "eleven_v3")
        self.assertNotIn(KEY, cm.exception.message)
        # The TTS adapter, given the same answer, must say the same.
        tts = build_adapter("audio.elevenlabs_tts", env=ENV,
                            session=FakeSession([("POST", "/v1/text-to-speech/", FakeResp(status, body))]))
        with self.assertRaises(AdapterError) as same:
            tts.submit(CapabilityRequest("tts", "Salom", voice_id=AZIZA), "eleven_v3")
        self.assertEqual(cm.exception.code, same.exception.code)
        self.assertEqual(cm.exception.not_accepted, same.exception.not_accepted)
        return cm.exception

    def test_401_bad_key(self):
        self.assertEqual(self.error(401, "invalid_api_key").code, E_AUTH)

    def test_401_quota_exceeded_is_an_empty_account_not_a_bad_key(self):
        self.assertEqual(self.error(401, "quota_exceeded").code, E_QUOTA)

    def test_402_out_of_credit(self):
        self.assertEqual(self.error(402, "insufficient_credits").code, E_QUOTA)

    def test_429_busy(self):
        for code in ("rate_limit_exceeded", "concurrent_limit_exceeded", "system_busy"):
            self.assertEqual(self.error(429, code).code, E_RATE_LIMITED, code)

    def test_an_unknown_voice_says_which_list_to_check_and_tries_no_other(self):
        with self.assertRaises(AdapterError) as cm:
            self.adapter(FakeResp(404, {"detail": {"code": "voice_not_found"}})).submit(request(), "eleven_v3")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertIn("account's voice list", cm.exception.message)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(len(self.session.calls), 1)


class RegistryOnly(Rig):
    def test_dialogue_is_registry_only(self):
        self.assertIn(DIALOGUE, REGISTRY_ONLY_CAPABILITIES)
        for mid in ("elevenlabs-dialogue-v3", "elevenlabs-dialogue-v4"):
            e = self.entries[mid]
            self.assertTrue(e.registry_only, mid)
            self.assertEqual((e.terms_gate, e.api_exposure), ("plan_required:scale", "web_only"), mid)
            self.assertFalse(e.raw["pricing"]["confirmed"], mid)
            # No price at all: the vendor lists none for dialogue, and a guess is not a price (rule 5).
            self.assertIsNone(e.raw["pricing"]["provider_usd_per_unit"], mid)
            self.assertEqual(e.languages, ("uz", "ru", "en"), mid)

    def test_not_synced(self):
        ids = {r["id"] for r in reg.sync_rows(list(self.entries.values()))}
        self.assertFalse(ids & {"elevenlabs-dialogue-v3", "elevenlabs-dialogue-v4"})
        self.assertFalse(any(DIALOGUE in r["capabilities"] for r in reg.sync_rows(list(self.entries.values()))))

    def test_not_probed_even_by_name(self):
        from tools import probe_models
        ids = ["elevenlabs-dialogue-v3", "elevenlabs-dialogue-v4"]
        self.assertEqual(probe_models.select(self.entries.values(), ids, None, False), [])
        self.assertEqual(probe_models.select(self.entries.values(), [], DIALOGUE, True), [])
        self.assertEqual({e.id for e in probe_models.registry_only_left_out(self.entries.values(), ids, None)}, set(ids))

    def test_no_migration_teaches_the_database_dialogue_yet(self):
        for path in (reg.Path(reg.__file__).resolve().parent.parent / "supabase" / "migrations").glob("*.sql"):
            self.assertNotIn("'dialogue'", path.read_text(), path.name)

    def test_the_probe_request_is_one_line_in_the_probe_voice(self):
        req = self.v3.probe_request(voice_id=AZIZA)
        self.assertEqual((req.prompt, req.voice_id), ("", None))
        self.assertEqual(tuple(req.dialogue_lines), (("probe", AZIZA, "Hello from Nightshift."),))

    def test_lines_never_ride_on_another_capability(self):
        tts = self.entries["elevenlabs-v3"]
        req = CapabilityRequest("tts", "Salom", voice_id=AZIZA, dialogue_lines=LINES)
        self.assertIn("dialogue lines do not apply to tts", tts.problems(req))


if __name__ == "__main__":
    unittest.main()
