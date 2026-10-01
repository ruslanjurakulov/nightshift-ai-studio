"""Voice change and dubbing (migration 0050): the provider adapters, the
adapter seam, the worker and the probe — all driven through fake sessions,
so nothing here touches a network or spends anything.

What must hold: the vendor gets exactly the documented request (path,
multipart fields, the account voice, the target language) built from the
recording the worker copied by id — never a picture, never a URL from the
params; a dub is polled until its target is ``completed`` and its signed
audio URL is fetched without our key; every failure fails the job (so the
database releases the hold) with a typed code and no secret in the text;
and the usage reported is the quantity the DATABASE priced, not a client's."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import media_library as ml
from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.audio import MEDIA_MAX_BYTES
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_QUOTA,
    FAILED,
    PENDING,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    ProviderTask,
)
from tests.test_capabilities import FakeResp, FakeSession
from tests.test_creative_media_inputs import FakeStore, SourceQueue, put_asset
from tests.test_creative_worker import JOB, ORG, FakeCredits, job

KEY = "xi-TOPSECRET-voice-key-0123456789"
ENV = {"ELEVENLABS_API_KEY": KEY}
VOICE = "AbCdEfGhIjKlMnOpQrSt"
SRC = "ab0c1d1e-0000-4000-8000-0000000050a5"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 64
FLAC = b"fLaC\x00\x00\x00\x22" + b"\x00" * 64
SIGNED = "https://storage.example.net/dubs/out.flac?sig=abc"


class RecordingSession(FakeSession):
    """FakeSession that reads the multipart file while it is still open (the
    adapter closes it when the call returns, as requests would have sent it)."""

    def request(self, method, url, **kw):
        if kw.get("files"):
            kw = dict(kw, files={k: (v[0], v[1].read(), v[2]) for k, v in kw["files"].items()})
        return super().request(method, url, **kw)


def adapter(key, routes=(), downloads=None, env=ENV):
    return build_adapter(key, env=env, session=RecordingSession(routes, downloads))


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def recording(self, name="source.mp4", data=MP4) -> str:
        p = self.root / name
        p.write_bytes(data)
        return str(p)


# ── the voice changer ────────────────────────────────────────────────────────

class VoiceChanger(Tmp):
    ENTRY = "elevenlabs-voice-changer"

    def test_the_documented_request_is_sent_and_the_audio_comes_back(self):
        a = adapter("audio.elevenlabs_sts", [("POST", "speech-to-speech", FakeResp(200, content=b"ID3voice"))])
        req = CapabilityRequest("voice_change", voice_id=VOICE, input_media=(self.recording(),))
        task = a.submit(req, "eleven_multilingual_sts_v2")
        method, url, kw = a.session.calls[0]
        self.assertEqual((method, url), ("POST", f"https://api.elevenlabs.io/v1/speech-to-speech/{VOICE}"))
        self.assertEqual(kw["params"], {"output_format": "mp3_44100_128"})
        self.assertEqual(kw["data"], {"model_id": "eleven_multilingual_sts_v2"})
        name, body, mime = kw["files"]["audio"]
        # The worker's copy name and the type the database recorded — never the uploader's name.
        self.assertEqual((name, body, mime), ("source.mp4", MP4, "video/mp4"))
        self.assertIsNone(kw["json"])
        self.assertEqual(kw["headers"]["xi-api-key"], KEY)
        self.assertIsNone(task.task_id)
        self.assertEqual((task.outputs[0].mime, task.outputs[0].data), ("audio/mpeg", b"ID3voice"))

    def test_no_voice_or_a_typed_number_is_refused_before_any_call(self):
        for voice in (None, "16516516145", "../../v1/voices/xyz"):
            a = adapter("audio.elevenlabs_sts")
            with self.assertRaises(AdapterError) as cm:
                a.submit(CapabilityRequest("voice_change", voice_id=voice, input_media=(self.recording(),)), "m")
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
            self.assertEqual(a.session.calls, [], voice)

    def test_a_type_the_voice_changer_does_not_document_is_refused_before_any_call(self):
        a = adapter("audio.elevenlabs_sts")
        req = CapabilityRequest("voice_change", voice_id=VOICE, input_media=(self.recording("source.aac", b"x" * 9),))
        with self.assertRaises(AdapterError) as cm:
            a.submit(req, "m")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(a.session.calls, [])

    def test_pictures_or_words_never_ride_along(self):
        entry = reg.get(self.ENTRY)
        a = adapter("audio.elevenlabs_sts")
        rec = (self.recording(),)
        self.assertEqual(a.problems(CapabilityRequest("voice_change", voice_id=VOICE, input_media=rec), entry), [])
        for bad in (CapabilityRequest("voice_change", voice_id=VOICE, input_media=rec, input_images=("x.png",)),
                    CapabilityRequest("voice_change", "say this", voice_id=VOICE, input_media=rec),
                    CapabilityRequest("voice_change", voice_id=VOICE),
                    CapabilityRequest("voice_change", voice_id=VOICE, input_media=rec * 2)):
            self.assertTrue(a.problems(bad, entry), bad)

    def test_an_oversized_recording_is_refused_before_any_call(self):
        a = adapter("audio.elevenlabs_sts")
        path = self.recording()
        with mock.patch("pathlib.Path.stat", return_value=mock.Mock(st_size=MEDIA_MAX_BYTES + 1)):
            with self.assertRaises(AdapterError) as cm:
                a.submit(CapabilityRequest("voice_change", voice_id=VOICE, input_media=(path,)), "m")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(a.session.calls, [])

    def test_a_vendor_error_is_typed_and_never_carries_the_key(self):
        body = json.dumps({"detail": {"status": "quota_exceeded", "message": f"credits exceeded for {KEY}"}})
        a = adapter("audio.elevenlabs_sts", [("POST", "speech-to-speech", FakeResp(401, body))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("voice_change", voice_id=VOICE, input_media=(self.recording(),)), "m")
        self.assertNotIn(KEY, cm.exception.message)
        self.assertNotIn(KEY[:12], str(cm.exception))

    def test_without_a_key_nothing_is_called(self):
        a = adapter("audio.elevenlabs_sts", env={})
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("voice_change", voice_id=VOICE, input_media=(self.recording(),)), "m")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertEqual(a.session.calls, [])


# ── dubbing ──────────────────────────────────────────────────────────────────

CREATED = {"project_id": "proj_123", "status": "queued", "revision": 0, "created_at": "t", "updated_at": "t",
           "language_ids": ["lang_456"]}


def target(status, **extra):
    return {"language_id": "lang_456", "project_id": "proj_123", "target_language": "uz", "status": status,
            "revision": 1, "created_at": "t", "updated_at": "t", **extra}


class Dubbing(Tmp):
    def test_the_project_is_created_with_its_one_language_target(self):
        a = adapter("audio.elevenlabs_dub", [("POST", "/v1/dubbing/project", FakeResp(201, CREATED))])
        rec = self.recording("source.mp3", MP3)
        task = a.submit(CapabilityRequest("dub", input_media=(rec,), target_language="uz"), "dubbing_v2")
        method, url, kw = a.session.calls[0]
        self.assertEqual((method, url), ("POST", "https://api.elevenlabs.io/v1/dubbing/project"))
        self.assertEqual(kw["data"], {"model_id": "dubbing_v2", "target_language": "uz"})
        self.assertEqual(kw["files"]["file"], ("source.mp3", MP3, "audio/mpeg"))
        # Not the legacy /v1/dubbing endpoint, no source_url, no watermark flag.
        self.assertNotIn("source_url", kw["data"])
        self.assertEqual(task.task_id, "proj_123/lang_456")
        self.assertEqual(len(a.session.calls), 1)

    def test_a_language_the_model_does_not_list_is_refused_before_any_call(self):
        entry = reg.get("elevenlabs-dubbing-v2")
        a = adapter("audio.elevenlabs_dub")
        rec = (self.recording(),)
        self.assertEqual(a.problems(CapabilityRequest("dub", input_media=rec, target_language="uz"), entry), [])
        for lang in ("de", None, "UZ"):
            self.assertTrue(a.problems(CapabilityRequest("dub", input_media=rec, target_language=lang), entry), lang)
        with self.assertRaises(AdapterError):
            a.submit(CapabilityRequest("dub", input_media=rec, target_language=None), "dubbing_v2")
        self.assertEqual(a.session.calls, [])

    def test_a_project_that_does_not_name_its_target_fails_now(self):
        for answer in ({**CREATED, "language_ids": []}, {**CREATED, "language_ids": ["../x"]},
                       {**CREATED, "project_id": "a/b"}):
            a = adapter("audio.elevenlabs_dub", [("POST", "/v1/dubbing/project", FakeResp(201, answer))])
            with self.assertRaises(AdapterError) as cm:
                a.submit(CapabilityRequest("dub", input_media=(self.recording(),), target_language="ru"), "dubbing_v2")
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, answer)

    def test_polling_reads_the_target_until_it_is_completed(self):
        url = "/v1/dubbing/project/proj_123/language/lang_456"
        task = ProviderTask("audio.elevenlabs_dub", "dubbing_v2", "proj_123/lang_456")
        for status in ("queued", "processing"):
            a = adapter("audio.elevenlabs_dub", [("GET", url, FakeResp(200, target(status)))])
            self.assertEqual(a.poll(task).state, PENDING)
            self.assertEqual(a.session.calls[0][1], "https://api.elevenlabs.io" + url)
        a = adapter("audio.elevenlabs_dub", [("GET", url, FakeResp(200, target("completed", outputs={
            "lossless_audio": SIGNED})))], downloads={SIGNED: FakeResp(200, content=FLAC)})
        result = a.poll(task)
        self.assertEqual(result.state, SUCCEEDED)
        self.assertEqual((result.outputs[0].mime, result.outputs[0].url), ("audio/flac", SIGNED))
        (path,) = a.fetch(result, self.root / "out")
        self.assertEqual((path.name, path.read_bytes()), ("output_0.flac", FLAC))
        download = [c for c in a.session.calls if c[0] == "DOWNLOAD"][0]
        # The signed URL is fetched as it is: our key never goes to a storage host.
        self.assertFalse(download[2].get("headers"))

    def test_a_failed_or_odd_target_is_a_typed_failure(self):
        url = "/v1/dubbing/project/proj_123/language/lang_456"
        task = ProviderTask("audio.elevenlabs_dub", "dubbing_v2", "proj_123/lang_456")
        cases = [
            (target("failed", error={"message_type": "error", "error": "no speech could be transcribed"}), E_BAD_REQUEST),
            (target("completed", outputs=None), E_BAD_RESPONSE),
            (target("completed", outputs={"lossless_audio": "http://insecure.example/x.flac"}), E_BAD_RESPONSE),
            (target("stale", outputs={"lossless_audio": SIGNED}), E_BAD_RESPONSE),
        ]
        for body, code in cases:
            a = adapter("audio.elevenlabs_dub", [("GET", url, FakeResp(200, body))])
            r = a.poll(task)
            self.assertEqual((r.state, r.error.code), (FAILED, code), body)
        a = adapter("audio.elevenlabs_dub", [("GET", url, FakeResp(200, target("exploded")))])
        with self.assertRaises(AdapterError):
            a.poll(task)

    def test_a_task_id_that_is_not_ours_is_never_put_into_a_url(self):
        a = adapter("audio.elevenlabs_dub")
        for bad in ("proj_123", "../../v1/user/lang", "p/l/x", ""):
            with self.assertRaises(AdapterError):
                a.poll(ProviderTask("audio.elevenlabs_dub", "dubbing_v2", bad))
        self.assertEqual(a.session.calls, [])

    def test_an_empty_balance_is_quota_not_a_retry(self):
        a = adapter("audio.elevenlabs_dub", [("POST", "/v1/dubbing/project",
                                              FakeResp(402, {"detail": "insufficient credits"}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("dub", input_media=(self.recording(),), target_language="en"), "dubbing_v2")
        self.assertEqual(cm.exception.code, E_QUOTA)
        self.assertFalse(cm.exception.retryable)


# ── the registry ─────────────────────────────────────────────────────────────

class Registry(unittest.TestCase):
    def test_the_voice_models_validate_and_are_never_available_from_the_file(self):
        models = {m.id: m for m in reg.models()}
        vc = models["elevenlabs-voice-changer"]
        self.assertEqual((vc.capabilities, vc.adapter, vc.vendor_model),
                         (("voice_change",), "audio.elevenlabs_sts", "eleven_multilingual_sts_v2"))
        for mid, vendor in (("elevenlabs-dubbing-v2", "dubbing_v2"), ("elevenlabs-dubbing-v1", "dubbing_v1")):
            m = models[mid]
            self.assertEqual((m.capabilities, m.vendor_model, m.languages), (("dub",), vendor, ("uz", "ru", "en")))
            self.assertTrue(m.is_async)
        for m in (vc, models["elevenlabs-dubbing-v2"]):
            self.assertEqual(m.raw["pricing"]["unit"], "second")
            self.assertFalse(m.raw["pricing"]["confirmed"])
            self.assertNotIn("availability", m.raw)
            self.assertNotIn("verified_at", m.raw)
            self.assertTrue(m.terms_gate)  # kept unsellable in SQL until the owner clears the vendor terms

    def test_languages_go_with_dub_and_only_with_it(self):
        doc = json.loads(reg.REGISTRY_PATH.read_text())
        dub = next(m for m in doc["models"] if m["id"] == "elevenlabs-dubbing-v2")
        broken = dict(dub, languages=[])
        broken.pop("languages")
        self.assertTrue(any("languages" in e for e in reg.validate({**doc, "models": [broken]})))
        vc = next(m for m in doc["models"] if m["id"] == "elevenlabs-voice-changer")
        self.assertTrue(any("languages" in e for e in reg.validate({**doc, "models": [dict(vc, languages=["uz"])]})))

    def test_a_voice_tool_probe_starts_from_speech(self):
        dub = reg.get("elevenlabs-dubbing-v2").probe_request(voice_id=VOICE, generated_speech="/tmp/s.mp3")
        self.assertEqual((dub.prompt, dub.input_media, dub.target_language, dub.voice_id), ("", ("/tmp/s.mp3",), "ru", None))
        vc = reg.get("elevenlabs-voice-changer").probe_request(voice_id=VOICE, generated_speech="/tmp/s.mp3")
        self.assertEqual((vc.voice_id, vc.input_media), (VOICE, ("/tmp/s.mp3",)))


# ── the adapter seam and the worker ──────────────────────────────────────────

def voice_job(cap="voice_change", **over):
    params = {"source_asset_id": SRC, "voice_id": VOICE} if cap == "voice_change" else \
        {"source_asset_id": SRC, "target_language": "uz"}
    model = "elevenlabs-voice-changer" if cap == "voice_change" else "elevenlabs-dubbing-v2"
    return job(capability=cap, requested_model=model, routed_model=model, params=params, quantity="62.0000",
               **over)


def ok_source(mime="audio/mpeg", kind="audio"):
    return {"ok": True, "asset_id": SRC, "storage_key": ml.storage_key(SRC), "mime": mime, "kind": kind,
            "variants": [], "duration_s": 61.2}


class Seam(Tmp):
    def test_a_recording_goes_to_the_adapter_as_media_never_as_a_picture(self):
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="dub", model="m",
                                   params={"source_asset_id": SRC, "target_language": "ru"},
                                   input_files=(Path("/w/source.mp4"),))
        cr = ca.capability_request(req)
        self.assertEqual((cr.input_media, cr.input_images, cr.target_language), (("/w/source.mp4",), (), "ru"))
        pic = ca.capability_request(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="edit", model="m",
                                                         params={"prompt": "x"}, input_files=(Path("/w/s.png"),)))
        self.assertEqual((pic.input_media, pic.input_images), ((), ("/w/s.png",)))

    def test_usage_is_the_quantity_the_database_priced(self):
        ra = ca.RegistryAdapter(reg.get("elevenlabs-dubbing-v2"), adapter("audio.elevenlabs_dub"), sync_store={})
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="dub", model="elevenlabs-dubbing-v2",
                                   params={"source_asset_id": SRC, "target_language": "ru", "duration_s": 1},
                                   quantity=62.0)
        u = ra.usage(req, 1)
        self.assertEqual((u.unit, u.quantity, u.vendor_model), ("second", 62.0, "dubbing_v2"))


class Worker(Tmp):
    def setUp(self):
        super().setUp()
        self.media = self.root / "media"
        self.media.mkdir()
        self.out = self.root / "jobs"

    def run_job(self, j, source, routes, downloads=None, store=None):
        put_asset(self.media, SRC, MP4 if source.get("kind") == "video" else MP3)
        q = SourceQueue(j, source=source)
        entry = reg.get(j["requested_model"])
        session = RecordingSession(routes, downloads)
        ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=ENV, session=session), sync_store={})
        library = cw.Library(store=store, media_root=self.media) if store is not None else None
        w = cw.CreativeWorker(q, lambda m: ra if m == entry.id else None, worker_id="w1", out_dir=self.out,
                              credits=FakeCredits(), enforce=True, sleep=lambda s: None, heartbeat_seconds=0,
                              media_root=self.media, library=library)
        w.run_once()
        return q, session

    def test_a_voice_change_runs_end_to_end_into_the_library(self):
        store = FakeStore()
        q, session = self.run_job(voice_job(), ok_source(), [("POST", "speech-to-speech", FakeResp(200, content=MP3))],
                                  store=store)
        self.assertTrue(q.finished["ok"], q.finished)
        name, body, mime = session.calls[0][2]["files"]["audio"]
        self.assertEqual((name, body, mime), ("source.mp3", MP3, "audio/mpeg"))
        (row,) = store.rows
        self.assertEqual((row["org"], row["kind"], row["source"]), (ORG, "audio", "generated"))
        self.assertEqual(row["provenance"]["source_asset_id"], SRC)
        self.assertIsNone(row["parent_asset_id"])  # a new audio asset, not a version of the video
        self.assertEqual(q.costs[0].quantity, 62.0)

    def test_a_dub_is_submitted_once_polled_and_stored(self):
        url = "/v1/dubbing/project/proj_123/language/lang_456"
        routes = [("POST", "/v1/dubbing/project", FakeResp(201, CREATED))]
        polls = iter([target("processing"), target("completed", outputs={"lossless_audio": SIGNED})])

        class Polls(RecordingSession):
            def request(self, method, u, **kw):
                if method == "GET" and url in u:
                    self.calls.append((method, u, kw))
                    return FakeResp(200, next(polls))
                return super().request(method, u, **kw)

        put_asset(self.media, SRC, MP4)
        q = SourceQueue(voice_job("dub"), source=ok_source("video/mp4", "video"))
        entry = reg.get("elevenlabs-dubbing-v2")
        session = Polls(routes, {SIGNED: FakeResp(200, content=FLAC)})
        ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=ENV, session=session), sync_store={})
        store = FakeStore()
        cw.CreativeWorker(q, lambda m: ra, worker_id="w1", out_dir=self.out, credits=FakeCredits(), enforce=True,
                          sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media,
                          library=cw.Library(store=store, media_root=self.media)).run_once()
        self.assertTrue(q.finished["ok"], q.finished)
        submits = [c for c in session.calls if c[0] == "POST"]
        self.assertEqual(len(submits), 1)
        self.assertIn(("advance", "submitted", "proj_123/lang_456"), q.calls)
        self.assertEqual(store.rows[0]["mime"], "audio/flac")

    def test_a_vendor_failure_fails_the_job_so_the_hold_is_released(self):
        q, _ = self.run_job(voice_job(), ok_source(),
                            [("POST", "speech-to-speech", FakeResp(422, {"detail": "audio could not be decoded"}))])
        self.assertFalse(q.finished["ok"])
        self.assertEqual(q.finished["error_code"], "bad_request")
        self.assertEqual(q.calls[-1][0:2], ("finish", False))

    def test_a_failed_dub_fails_the_job_with_its_reason(self):
        url = "/v1/dubbing/project/proj_123/language/lang_456"
        q, _ = self.run_job(voice_job("dub"), ok_source(), [
            ("POST", "/v1/dubbing/project", FakeResp(201, CREATED)),
            ("GET", url, FakeResp(200, target("failed", error={"message_type": "error",
                                                                "error": "no speech could be transcribed"})))])
        self.assertFalse(q.finished["ok"])
        self.assertEqual(q.finished["error_code"], "bad_request")
        self.assertIn("no speech", q.finished["error"])

    def test_the_databases_refusal_stops_the_job_before_any_paid_call(self):
        q, session = self.run_job(voice_job(), {"ok": False, "problem": "a voice change takes recordings of up to "
                                                                       "5 minutes; trim this one first"}, [])
        self.assertEqual(session.calls, [])
        self.assertEqual(q.finished["error_code"], "source_unavailable")
        self.assertNotIn(("advance", "submitting", None), q.calls)

    def test_a_picture_named_as_a_voice_source_is_never_copied(self):
        q, session = self.run_job(voice_job(), ok_source("image/png", "image") | {"kind": "audio"}, [])
        self.assertEqual(session.calls, [])
        self.assertEqual(q.finished["error_code"], "source_unavailable")

    def test_a_picture_tool_never_receives_a_recording(self):
        put_asset(self.media, SRC, MP3)
        with self.assertRaises(ml.SourceUnavailable):
            ml.copy_source(self.media, SRC, "audio/mpeg", [], self.root / "x")
        path = ml.copy_source(self.media, SRC, "audio/mpeg", [], self.root / "y", media=True)
        self.assertEqual((path.name, path.read_bytes()), ("source.mp3", MP3))
        with self.assertRaises(ml.SourceUnavailable):
            ml.copy_source(self.media, SRC, "image/png", [], self.root / "z", media=True)


# ── the probe ────────────────────────────────────────────────────────────────

class Probe(Tmp):
    def test_a_voice_tool_probe_speaks_its_words_first_then_calls_the_tool(self):
        from tools import probe_models

        session = RecordingSession([
            ("POST", "/v1/text-to-speech/", FakeResp(200, content=MP3)),
            ("POST", "/v1/speech-to-speech/", FakeResp(200, content=MP3)),
        ])
        res = probe_models.run_probe(reg.get("elevenlabs-voice-changer"), env=ENV, voice_id=VOICE,
                                     workdir=self.root, session=session)
        self.assertTrue(res.ok, res.message)
        tts, sts = session.calls
        self.assertIn("eleven_flash_v2_5", json.dumps(tts[2]["json"]))
        self.assertEqual(sts[2]["files"]["audio"][1], MP3)

    def test_a_voice_tool_probe_without_a_voice_is_skipped_not_spent(self):
        from tools import probe_models

        session = RecordingSession([])
        res = probe_models.run_probe(reg.get("elevenlabs-dubbing-v2"), env=ENV, voice_id=None, workdir=self.root,
                                     session=session)
        self.assertEqual(res.code, E_NOT_CONFIGURED)
        self.assertEqual(session.calls, [])


if __name__ == "__main__":
    unittest.main()
