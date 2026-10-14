"""Auto-captions through an ASYNCHRONOUS speech-to-text vendor (migration 0072).

The second transcription shape behind the same registry routing: upload the
recording, create a transcript, poll it. Everything is driven through fake
sessions: no network, no key, no paid call. What must hold:

* the documented requests are sent in order — raw upload, then the transcript
  with the vendor model and EITHER the named language OR detection, the key in
  a header only;
* the answer (milliseconds) becomes exactly the words-in-seconds JSON the
  synchronous adapter hands back, so the worker stores it the same way;
* pending is pending, a spoken-word-free recording is an EMPTY answer (the
  worker fails it as no_speech and the hold is released), a vendor failure is
  typed, and no message carries the key;
* the registry entry cannot sell by itself: a terms gate, no price, languages
  limited to the ones it was documented for, and a web-only tool.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    FAILED,
    PENDING,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    ProviderTask,
)
from tests.test_capabilities import FakeResp, FakeSession
from tests.test_captions import CaptionQueue, captions_job, recording_source
from tests.test_creative_media_inputs import put_asset
from tests.test_creative_worker import FakeCredits

KEY = "aai-TOPSECRET-transcribe-key-0123456789"
ENV = {"ASSEMBLYAI_API_KEY": KEY}
MODEL = "assemblyai-universal-2"
SRC = "ab0c1d1e-0000-4000-8000-0000000059a5"
TID = "5551c9a0-1111-4222-8333-444455556666"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64
UPLOAD = "https://cdn.example.test/upload/abc"


class Sequenced(FakeSession):
    """Like FakeSession, but a route may hold a list of answers served in turn."""

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        for m, frag, resp in self.routes:
            if m == method and frag in url:
                if isinstance(resp, list):
                    return resp.pop(0) if len(resp) > 1 else resp[0]
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError(f"unexpected {method} {url}")


def done(*words, language="ru"):
    return {"id": TID, "status": "completed", "language_code": language,
            "words": [{"text": t, "start": s, "end": e, "confidence": 0.9} for t, s, e in words]}


HELLO = done(("Privet", 100, 500), ("mir", 600, 1100))
UP_OK = ("POST", "/v2/upload", FakeResp(200, {"upload_url": UPLOAD}))
CREATE_OK = ("POST", "/v2/transcript", FakeResp(200, {"id": TID, "status": "queued"}))


def adapter(routes=(), env=ENV):
    return build_adapter("audio.async_transcribe", env=env, session=Sequenced(routes))


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def recording(self, name="source.mp3", data=MP3) -> str:
        p = self.root / name
        p.write_bytes(data)
        return str(p)


class Submit(Tmp):
    def test_the_recording_is_uploaded_raw_then_a_transcript_is_created_with_the_named_language(self):
        a = adapter([UP_OK, CREATE_OK])
        task = a.submit(CapabilityRequest("captions", input_media=(self.recording(),), spoken_language="ru"), "universal-2")
        (m1, u1, k1), (m2, u2, k2) = a.session.calls
        self.assertEqual((m1, u1), ("POST", "https://api.assemblyai.com/v2/upload"))
        self.assertEqual(k1["headers"]["authorization"], KEY)
        self.assertEqual(k1["headers"]["Content-Type"], "application/octet-stream")
        self.assertEqual((m2, u2), ("POST", "https://api.assemblyai.com/v2/transcript"))
        self.assertEqual(k2["json"], {"audio_url": UPLOAD, "speech_models": ["universal-2"], "speaker_labels": False,
                                      "language_code": "ru"})
        self.assertNotIn(KEY, u1 + u2)
        self.assertEqual(task.task_id, TID)
        self.assertFalse(task.outputs)

    def test_no_language_asked_means_the_vendor_detects_it(self):
        a = adapter([UP_OK, CREATE_OK])
        a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "universal-2")
        body = a.session.calls[1][2]["json"]
        self.assertTrue(body["language_detection"])
        self.assertNotIn("language_code", body)

    def test_an_upload_without_an_address_or_a_transcript_without_an_id_is_a_bad_response(self):
        for routes in ([("POST", "/v2/upload", FakeResp(200, {"upload_url": "http://insecure.example/x"}))],
                       [UP_OK, ("POST", "/v2/transcript", FakeResp(200, {"status": "queued"}))],
                       [UP_OK, ("POST", "/v2/transcript", FakeResp(200, {"id": "../etc"}))]):
            with self.assertRaises(AdapterError) as cm:
                adapter(routes).submit(CapabilityRequest("captions", input_media=(self.recording(),)), "universal-2")
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)

    def test_a_refused_key_is_typed_and_the_message_never_carries_it(self):
        a = adapter([("POST", "/v2/upload", FakeResp(401, json.dumps({"error": f"invalid {KEY}"})))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "universal-2")
        self.assertEqual(cm.exception.code, E_AUTH)
        self.assertNotIn(KEY, cm.exception.message)
        self.assertTrue(cm.exception.not_accepted)

    def test_what_is_refused_before_any_call(self):
        entry = reg.get(MODEL)
        a = adapter()
        rec = (self.recording(),)
        self.assertEqual(a.problems(CapabilityRequest("captions", input_media=rec), entry), [])
        for bad in (CapabilityRequest("captions"),
                    CapabilityRequest("captions", input_media=rec * 2),
                    CapabilityRequest("captions", input_media=rec, spoken_language="uz"),
                    CapabilityRequest("captions", input_media=rec, voice_id="A" * 20),
                    CapabilityRequest("captions", input_media=(self.recording("a.exe", b"MZ"),))):
            self.assertTrue(a.problems(bad, entry), bad)
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("captions"), "universal-2")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(a.session.calls, [])

    def test_no_key_on_the_worker_is_not_configured_before_any_call(self):
        a = adapter(env={})
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "universal-2")
        self.assertEqual(cm.exception.code, "not_configured")
        self.assertEqual(a.session.calls, [])

    def test_the_base_url_override_must_be_https(self):
        a = build_adapter("audio.async_transcribe", env={**ENV, "ASSEMBLYAI_BASE_URL": "http://plain.example"},
                          session=FakeSession())
        self.assertEqual(a.base_url, "https://api.assemblyai.com")
        b = build_adapter("audio.async_transcribe", env={**ENV, "ASSEMBLYAI_BASE_URL": "https://eu.example/"},
                          session=FakeSession())
        self.assertEqual(b.base_url, "https://eu.example")


class Poll(unittest.TestCase):
    def task(self, tid=TID):
        return ProviderTask("audio.async_transcribe", "universal-2", tid)

    def test_queued_and_processing_are_pending(self):
        for st in ("queued", "processing"):
            a = adapter([("GET", f"/v2/transcript/{TID}", FakeResp(200, {"id": TID, "status": st}))])
            self.assertEqual(a.poll(self.task()).state, PENDING)

    def test_milliseconds_become_seconds_and_the_language_a_base_tag(self):
        a = adapter([("GET", f"/v2/transcript/{TID}", FakeResp(200, HELLO))])
        r = a.poll(self.task())
        self.assertEqual(r.state, SUCCEEDED)
        self.assertEqual(r.outputs[0].mime, "application/json")
        body = json.loads(r.outputs[0].data)
        self.assertEqual(body["language"], "ru")
        self.assertEqual(body["words"], [{"t": "Privet", "s": 0.1, "e": 0.5}, {"t": "mir", "s": 0.6, "e": 1.1}])

    def test_a_recording_without_speech_is_an_empty_answer_for_the_worker_to_refuse(self):
        for body in ({"id": TID, "status": "completed", "words": None, "language_code": "en"},
                     {"id": TID, "status": "completed", "words": [], "language_code": "en"},
                     {"id": TID, "status": "error", "error": "language_detection cannot be performed on files "
                                                             "with no spoken audio"}):
            a = adapter([("GET", f"/v2/transcript/{TID}", FakeResp(200, body))])
            r = a.poll(self.task())
            self.assertEqual(r.state, SUCCEEDED)
            self.assertEqual(json.loads(r.outputs[0].data)["words"], [])

    def test_a_failed_transcript_is_typed_by_what_the_vendor_said(self):
        a = adapter([("GET", f"/v2/transcript/{TID}", FakeResp(200, {"id": TID, "status": "error",
                                                                      "error": "Unsupported file format"}))])
        r = a.poll(self.task())
        self.assertEqual((r.state, r.error.code), (FAILED, E_BAD_REQUEST))
        a = adapter([("GET", f"/v2/transcript/{TID}", FakeResp(200, {"id": TID, "status": "error",
                                                                      "error": f"Internal error {KEY}"}))])
        r = a.poll(self.task())
        self.assertEqual((r.state, r.error.code), (FAILED, "unavailable"))
        self.assertNotIn(KEY, r.error.message)

    def test_an_unknown_status_or_a_shape_we_do_not_understand_is_refused(self):
        for body in ({"status": "weird"}, ["x"], {"status": "completed", "words": "x"}):
            a = adapter([("GET", f"/v2/transcript/{TID}", FakeResp(200, body))])
            try:
                r = a.poll(self.task())
            except AdapterError as e:
                self.assertEqual(e.code, E_BAD_RESPONSE)
            else:
                self.assertEqual((r.state, r.error.code), (FAILED, E_BAD_RESPONSE))

    def test_a_task_id_that_is_not_ours_makes_no_call(self):
        a = adapter()
        with self.assertRaises(AdapterError):
            a.poll(self.task("../../v2/upload"))
        self.assertEqual(a.session.calls, [])


class Worker(Tmp):
    def setUp(self):
        super().setUp()
        self.out = self.root / "jobs"
        self.media = self.root / "media"
        self.media.mkdir()
        put_asset(self.media, SRC, MP3)

    def run_job(self, status_answers, language="ru"):
        session = Sequenced([UP_OK, CREATE_OK, ("GET", f"/v2/transcript/{TID}", [FakeResp(200, a) for a in status_answers])])
        entry = reg.get(MODEL)
        ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=ENV, session=session), sync_store={})
        j = captions_job()
        j["requested_model"] = j["routed_model"] = MODEL
        j["params"] = {"source_asset_id": SRC, "language": language}
        q = CaptionQueue(j, recording_source())
        w = cw.CreativeWorker(q, lambda m: ra if m == MODEL else None, worker_id="w1", out_dir=self.out,
                              credits=FakeCredits(amount=3), enforce=True, media_root=self.media,
                              sleep=lambda s: None, heartbeat_seconds=0)
        return w.process(q.claim("w1")), q, session

    def test_pending_then_done_becomes_a_track_and_the_task_id_is_kept_in_between(self):
        out, q, session = self.run_job([{"id": TID, "status": "queued"}, {"id": TID, "status": "processing"}, HELLO])
        self.assertEqual(out, "completed:captions")
        self.assertEqual(q.stored["language"], "ru")
        self.assertEqual(q.stored["words"], [{"t": "Privet", "s": 0.1, "e": 0.5}, {"t": "mir", "s": 0.6, "e": 1.1}])
        self.assertEqual([c[0] for c in session.calls], ["POST", "POST", "GET", "GET", "GET"])
        self.assertTrue(q.finished["ok"])

    def test_a_silent_recording_fails_the_job_so_nothing_is_charged(self):
        out, q, _ = self.run_job([{"id": TID, "status": "error", "error": "no spoken audio"}])
        self.assertEqual(out, "failed:no_speech")
        self.assertEqual(q.finished["error_code"], "no_speech")
        self.assertIsNone(q.stored)

    def test_a_vendor_failure_fails_the_job_with_its_typed_code(self):
        out, q, _ = self.run_job([{"id": TID, "status": "error", "error": "Unsupported file format"}])
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "bad_request"))
        self.assertIsNone(q.stored)


class Registry(unittest.TestCase):
    def test_the_entry_cannot_sell_by_itself(self):
        e = reg.get(MODEL)
        self.assertEqual(e.capabilities, ("captions",))
        self.assertEqual(e.terms_gate, "terms_review_required")
        self.assertIsNone(e.raw["pricing"]["provider_usd_per_unit"])
        self.assertFalse(e.raw["pricing"]["confirmed"])
        self.assertEqual(e.api_exposure, "web_only")
        self.assertTrue(e.is_async)

    def test_only_documented_good_languages_are_offered_and_uzbek_is_not(self):
        self.assertEqual(tuple(reg.get(MODEL).languages), ("ru", "en"))

    def test_it_has_a_probe_made_from_speech_and_a_30_minute_ceiling(self):
        e = reg.get(MODEL)
        self.assertEqual(e.raw["probe"]["input_audio"], "speech")
        self.assertEqual(e.max_source_seconds, 1800)
