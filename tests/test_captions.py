"""Auto-captions (migration 0059): a library recording -> a word-timed caption
track, stored as data and never as a library asset.

Everything is driven through fake sessions and a fake queue: no network, no
key, no paid call. What must hold:

* the provider gets exactly the documented request — the recording from the
  file the worker copied BY ID as multipart, word timestamps asked for, no
  speaker labels, the key in a header only — and never a URL;
* whatever was said, what is stored is words and times only: control and bidi
  characters are gone, times run forward inside the recording, audio-event
  tags are not words, and more than 20 000 words is refused rather than cut;
* the result is a caption track (``store_caption_track``) whose id is all the
  job row keeps — never a library asset;
* every failure — no speech, a provider outage, a refused file, a track that
  cannot be stored — fails the job, so the database releases the hold;
  nothing empty is ever charged;
* 0059 is built on 0055 / 0052: every string literal of every function it
  replaces is kept.
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from modules import captions as cap
from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_QUOTA,
    OUTPUT_OF,
    AdapterError,
    CapabilityRequest,
)
from tests.test_capabilities import FakeResp, FakeSession
from tests.test_creative_media_inputs import FakeStore, SourceQueue, put_asset
from tests.test_creative_worker import FakeCredits, job

KEY = "xi-TOPSECRET-scribe-key-0123456789"
ENV = {"ELEVENLABS_API_KEY": KEY}
MODEL = "elevenlabs-scribe-v2"
SRC = "ab0c1d1e-0000-4000-8000-0000000059a5"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64
MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"


def heard(*words, language="uzb", extra=()):
    """A speech-to-text answer: (text, start, end) words, with the vendor's own spacing entries."""
    entries = []
    for text, s, e in words:
        entries.append({"text": text, "start": s, "end": e, "type": "word", "logprob": -0.1})
        entries.append({"text": " ", "start": e, "end": e, "type": "spacing"})
    entries.extend(extra)
    return {"language_code": language, "language_probability": 0.98, "text": "x", "words": entries}


HELLO = heard(("Salom", 0.1, 0.5), ("dunyo", 0.6, 1.1))


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


def adapter(routes=(), env=ENV):
    return build_adapter("audio.elevenlabs_scribe", env=env, session=FakeSession(routes))


# ── the cleaned words ────────────────────────────────────────────────────────

class CleanWords(unittest.TestCase):
    def test_words_keep_their_text_and_times_to_the_millisecond(self):
        out = cap.clean_words([{"text": "Salom", "start": 0.1004, "end": 0.5}, {"t": "dunyo", "s": 0.6, "e": 1.1}])
        self.assertEqual(out, [{"t": "Salom", "s": 0.1, "e": 0.5}, {"t": "dunyo", "s": 0.6, "e": 1.1}])

    def test_the_pipelines_own_whisper_words_are_accepted_as_they_are(self):
        out = cap.words_from_whisper([{"word": " Hello", "start": 0.0, "end": 0.4}, {"word": "world", "start": 0.4, "end": 0.9}])
        self.assertEqual([w["t"] for w in out], ["Hello", "world"])

    def test_control_zero_width_and_bidi_characters_are_removed(self):
        out = cap.clean_words([{"t": "ca‮t​\x00", "s": 0, "e": 1}])
        self.assertEqual(out[0]["t"], "cat")

    def test_a_word_is_cut_to_80_characters_and_an_empty_one_is_dropped(self):
        out = cap.clean_words([{"t": "x" * 200, "s": 0, "e": 1}, {"t": " ​ ", "s": 1, "e": 2}])
        self.assertEqual(len(out), 1)
        self.assertEqual(len(out[0]["t"]), 80)

    def test_times_run_forward_and_a_word_is_never_zero_length(self):
        out = cap.clean_words([{"t": "a", "s": 0.0, "e": 1.0}, {"t": "b", "s": 0.5, "e": 0.5}, {"t": "c", "s": 2.0, "e": 1.0}])
        for prev, nxt in zip(out, out[1:]):
            self.assertGreaterEqual(nxt["s"], prev["e"])
        for w in out:
            self.assertGreater(w["e"], w["s"])

    def test_a_word_without_a_usable_time_is_skipped_not_guessed(self):
        out = cap.clean_words([{"t": "ok", "s": 0, "e": 1}, {"t": "nan", "s": float("nan"), "e": 2},
                               {"t": "neg", "s": -1, "e": 2}, {"t": "none", "s": None, "e": 3}, {"t": "bool", "s": True, "e": 3},
                               {"t": "str", "s": "x", "e": 3}])
        self.assertEqual([w["t"] for w in out], ["ok"])

    def test_times_are_kept_inside_the_recording(self):
        out = cap.clean_words([{"t": "in", "s": 1, "e": 2}, {"t": "late", "s": 9, "e": 10}], duration_s=3)
        self.assertEqual([w["t"] for w in out], ["in"])
        out = cap.clean_words([{"t": "tail", "s": 2.5, "e": 9}], duration_s=3)
        self.assertLessEqual(out[0]["e"], 4.0)

    def test_nothing_usable_is_no_speech_never_an_empty_track(self):
        for empty in ([], [{"t": "", "s": 0, "e": 1}], [{"t": "x", "s": None, "e": 1}], ["x", 3, None]):
            with self.assertRaises(cap.NoSpeech):
                cap.clean_words(empty)

    def test_more_than_the_limit_is_refused_not_cut(self):
        many = [{"t": "w", "s": i, "e": i + 0.5} for i in range(cap.MAX_WORDS + 1)]
        with self.assertRaises(cap.CaptionsError) as cm:
            cap.clean_words(many)
        self.assertEqual(cm.exception.code, "too_many_words")

    def test_the_vendor_answer_keeps_only_words_and_a_base_language(self):
        lang, words = cap.words_from_vendor(heard(("Salom", 0, 1), extra=[{"text": "(laughter)", "start": 1, "end": 2,
                                                                          "type": "audio_event"}]))
        self.assertEqual((lang, [w["text"] for w in words]), ("uz", ["Salom"]))
        for body in ({"transcripts": []}, {"words": "x"}, [], None):
            with self.assertRaises(cap.CaptionsError):
                cap.words_from_vendor(body)

    def test_language_tags_are_reduced_to_the_stored_form(self):
        self.assertEqual([cap.base_language(c) for c in ("uz", "UZB", "ru-RU", "eng", "xx", "toolong", None, 3)],
                         ["uz", "uz", "ru", "en", "xx", None, None, None])


# ── the adapter ──────────────────────────────────────────────────────────────

class Adapter(Tmp):
    def test_the_documented_request_is_sent_with_the_recording_as_multipart(self):
        a = adapter([("POST", "/v1/speech-to-text", FakeResp(200, HELLO))])
        task = a.submit(CapabilityRequest("captions", input_media=(self.recording(),), spoken_language="uz"), "scribe_v2")
        method, url, kw = a.session.calls[0]
        self.assertEqual((method, url), ("POST", "https://api.elevenlabs.io/v1/speech-to-text"))
        self.assertEqual(kw["headers"]["xi-api-key"], KEY)
        self.assertNotIn(KEY, url)
        self.assertEqual(kw["files"]["file"][0], "source.mp3")
        self.assertEqual(kw["files"]["file"][2], "audio/mpeg")
        self.assertEqual(kw["data"], {"model_id": "scribe_v2", "timestamps_granularity": "word", "diarize": "false",
                                      "tag_audio_events": "false", "language_code": "uz"})
        self.assertIsNone(task.task_id)
        out = task.outputs[0]
        self.assertEqual(out.mime, "application/json")
        body = json.loads(out.data)
        self.assertEqual(body["language"], "uz")
        self.assertEqual(body["words"], [{"t": "Salom", "s": 0.1, "e": 0.5}, {"t": "dunyo", "s": 0.6, "e": 1.1}])

    def test_no_language_asked_means_the_vendor_detects_and_that_is_what_is_stored(self):
        a = adapter([("POST", "/v1/speech-to-text", FakeResp(200, heard(("Privet", 0, 1), language="rus")))])
        task = a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "scribe_v2")
        self.assertNotIn("language_code", a.session.calls[0][2]["data"])
        self.assertEqual(json.loads(task.outputs[0].data)["language"], "ru")

    def test_audio_events_and_spacing_never_become_words(self):
        body = heard(("Hi", 0, 1), extra=[{"text": "(music)", "start": 1, "end": 3, "type": "audio_event"}])
        a = adapter([("POST", "/v1/speech-to-text", FakeResp(200, body))])
        task = a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "scribe_v2")
        self.assertEqual([w["t"] for w in json.loads(task.outputs[0].data)["words"]], ["Hi"])

    def test_a_recording_without_speech_is_an_empty_answer_for_the_worker_to_refuse(self):
        a = adapter([("POST", "/v1/speech-to-text", FakeResp(200, {"language_code": "eng", "text": "", "words": []}))])
        task = a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "scribe_v2")
        self.assertEqual(json.loads(task.outputs[0].data)["words"], [])

    def test_an_answer_with_channels_instead_of_words_is_refused_not_half_read(self):
        a = adapter([("POST", "/v1/speech-to-text", FakeResp(200, {"transcripts": [{"words": []}]}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "scribe_v2")
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)

    def test_a_vendor_error_is_typed_and_never_carries_the_key(self):
        a = adapter([("POST", "/v1/speech-to-text", FakeResp(402, json.dumps({"detail": f"quota exceeded {KEY}"})))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "scribe_v2")
        self.assertEqual(cm.exception.code, E_QUOTA)
        self.assertNotIn(KEY, cm.exception.message)

    def test_what_captions_refuse_before_any_call(self):
        entry = reg.get(MODEL)
        a = adapter()
        rec = (self.recording(),)
        self.assertEqual(a.problems(CapabilityRequest("captions", input_media=rec), entry), [])
        self.assertEqual(a.problems(CapabilityRequest("captions", input_media=rec, spoken_language="ru"), entry), [])
        for bad in (CapabilityRequest("captions"),
                    CapabilityRequest("captions", input_media=rec * 2),
                    CapabilityRequest("captions", input_media=rec, spoken_language="de"),
                    CapabilityRequest("captions", "say this", input_media=rec),
                    CapabilityRequest("captions", input_media=rec, voice_id="A" * 20),
                    CapabilityRequest("captions", input_media=(self.recording("a.exe", b"MZ"),)),
                    CapabilityRequest("captions", input_images=rec)):
            self.assertTrue(a.problems(bad, entry), bad)
        # A spoken language belongs to captions only.
        self.assertTrue(entry.problems(CapabilityRequest("t2i", "x", spoken_language="en")))

    def test_a_refused_request_makes_no_call(self):
        a = adapter()
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("captions"), "scribe_v2")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(a.session.calls, [])

    def test_no_key_on_the_worker_is_not_configured_before_any_call(self):
        a = adapter(env={})
        with self.assertRaises(AdapterError) as cm:
            a.submit(CapabilityRequest("captions", input_media=(self.recording(),)), "scribe_v2")
        self.assertEqual(cm.exception.code, "not_configured")
        self.assertEqual(a.session.calls, [])


# ── the registry ─────────────────────────────────────────────────────────────

class Registry(unittest.TestCase):
    def test_the_model_is_the_speech_to_text_model_and_outputs_text(self):
        e = reg.get(MODEL)
        self.assertEqual((e.adapter, e.capabilities, e.output), ("audio.elevenlabs_scribe", ("captions",), "text"))
        self.assertEqual(OUTPUT_OF["captions"], "text")
        self.assertEqual(e.languages, ("uz", "ru", "en"))
        # No customer price and no invented provider price: unknown is never 0.
        self.assertEqual(e.credit_unit, "model_elevenlabs_scribe_v2_second")
        self.assertIsNone(e.raw["pricing"]["provider_usd_per_unit"])
        self.assertEqual(e.raw["pricing"]["unit"], "second")

    def test_it_is_probed_from_speech_and_nothing_else(self):
        req = reg.get(MODEL).probe_request(voice_id="A" * 20, generated_speech="/tmp/probe_speech.mp3")
        self.assertEqual((req.capability, req.prompt, req.input_media, req.voice_id),
                         ("captions", "", ("/tmp/probe_speech.mp3",), None))

    def test_a_captions_model_must_list_its_languages(self):
        doc = json.loads((Path(reg.REGISTRY_PATH)).read_text())
        for m in doc["models"]:
            if m["id"] == MODEL:
                del m["languages"]
        self.assertTrue(any("languages is required" in p for p in reg.validate(doc)))

    def test_the_adapter_the_registry_names_exists(self):
        self.assertIn("audio.elevenlabs_scribe", __import__("modules.capabilities", fromlist=["ADAPTERS"]).ADAPTERS)


# ── the worker ───────────────────────────────────────────────────────────────

def captions_job(**over):
    return job(capability="captions", requested_model=MODEL, routed_model=MODEL,
               params={"source_asset_id": SRC, "language": "uz"}, quoted_credits=3, quantity=95, **over)


class CaptionQueue(SourceQueue):
    """SourceQueue plus 0059's store function."""

    def __init__(self, j, source=None, track="11111111-2222-4333-8444-555555555555"):
        super().__init__(j, source)
        self.track_answer = track
        self.stored = None

    def store_caption_track(self, job_id, worker_id, language, duration_s, words):
        self.calls.append(("store_caption_track", language))
        self.stored = {"job": job_id, "worker": worker_id, "language": language, "duration_s": duration_s,
                       "words": list(words)}
        return self.track_answer


def recording_source(aid=SRC, mime="audio/mpeg", duration=95.0):
    return {"ok": True, "asset_id": aid, "storage_key": "k", "mime": mime, "kind": "audio", "variants": [],
            "duration_s": duration}


class Worker(Tmp):
    def setUp(self):
        super().setUp()
        self.out = self.root / "jobs"
        self.media = self.root / "media"
        self.media.mkdir()
        put_asset(self.media, SRC, MP3)
        self.store = FakeStore()

    def run_job(self, body, *, source=None, status=200, track="11111111-2222-4333-8444-555555555555"):
        session = FakeSession([("POST", "/v1/speech-to-text", FakeResp(status, body))])
        entry = reg.get(MODEL)
        ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=ENV, session=session), sync_store={})
        q = CaptionQueue(captions_job(), source or recording_source(), track=track)
        w = cw.CreativeWorker(q, lambda m: ra if m == MODEL else None, worker_id="w1", out_dir=self.out,
                              credits=FakeCredits(amount=3), enforce=True, media_root=self.media,
                              library=cw.Library(store=self.store, media_root=self.media),
                              sleep=lambda s: None, heartbeat_seconds=0)
        return w.process(q.claim("w1")), q, session

    def test_the_words_become_a_track_and_the_job_keeps_only_its_id(self):
        out, q, session = self.run_job(HELLO)
        self.assertEqual(out, "completed:captions")
        self.assertTrue(q.finished["ok"])
        r = q.finished["result"]
        self.assertEqual(r, {"track_id": "11111111-2222-4333-8444-555555555555", "language": "uz", "words": 2,
                             "duration_s": 95.0, "storage": "table"})
        self.assertEqual(q.stored["words"], [{"t": "Salom", "s": 0.1, "e": 0.5}, {"t": "dunyo", "s": 0.6, "e": 1.1}])
        self.assertEqual((q.stored["job"], q.stored["worker"], q.stored["language"]), (q.current["id"], "w1", "uz"))
        # Data, never a library asset.
        self.assertNotIn("asset_ids", r)
        self.assertNotIn("files", r)
        self.assertEqual(self.store.rows, [])
        self.assertIsNone(q.attached)
        # The track is stored BEFORE the job is settled: a settled job always has its track.
        names = [c[0] for c in q.calls]
        self.assertLess(names.index("store_caption_track"), names.index("finish"))
        # The scratch folder (the copied recording, the provider's JSON) is gone.
        self.assertFalse((self.out / q.current["id"]).exists())
        # The recording sent is the library copy, named by id, as the language asked for.
        data = session.calls[0][2]["data"]
        self.assertEqual(data["language_code"], "uz")
        self.assertEqual(session.calls[0][2]["files"]["file"][0], "source.mp3")
        self.assertTrue(Path(session.calls[0][2]["files"]["file"][1].name).parts[-3:-1] == (q.current["id"], "input"))
        # Priced by the recording's seconds, as the database measured them.
        self.assertEqual((q.costs[0].unit, q.costs[0].quantity), ("second", 95.0))

    def test_a_recording_with_no_speech_fails_the_job_so_nothing_is_charged(self):
        out, q, _ = self.run_job({"language_code": "eng", "text": "", "words": []})
        self.assertEqual(out, "failed:no_speech")
        self.assertFalse(q.finished["ok"])
        self.assertEqual(q.finished["error_code"], "no_speech")
        self.assertIsNone(q.stored)

    def test_the_detected_language_is_stored_when_none_was_asked_for(self):
        session = FakeSession([("POST", "/v1/speech-to-text", FakeResp(200, heard(("Privet", 0, 1), language="rus")))])
        entry = reg.get(MODEL)
        ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=ENV, session=session), sync_store={})
        q = CaptionQueue(job(capability="captions", requested_model=MODEL, routed_model=MODEL,
                             params={"source_asset_id": SRC}, quoted_credits=3, quantity=95), recording_source())
        w = cw.CreativeWorker(q, lambda m: ra, worker_id="w1", out_dir=self.out, credits=FakeCredits(amount=3),
                              enforce=True, media_root=self.media, sleep=lambda s: None, heartbeat_seconds=0)
        self.assertEqual(w.process(q.claim("w1")), "completed:captions")
        self.assertEqual(q.stored["language"], "ru")
        self.assertNotIn("language_code", session.calls[0][2]["data"])

    def test_a_provider_outage_or_refusal_fails_the_job_with_a_typed_code(self):
        out, q, _ = self.run_job({"detail": "overloaded"}, status=503)
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "unavailable"))
        out, q, _ = self.run_job({"detail": "invalid api key"}, status=401)
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "auth"))
        self.assertIsNone(q.stored)

    def test_a_recording_the_database_refuses_is_never_sent(self):
        out, q, session = self.run_job(HELLO, source={"ok": False, "problem": "source_asset_id names no audio or video "
                                                                           "file in this organization's library"})
        self.assertEqual(out, "failed:source_unavailable")
        self.assertEqual(session.calls, [])
        self.assertNotIn(("advance", "submitting", None), q.calls)

    def test_a_track_that_cannot_be_stored_fails_the_job_instead_of_completing_it(self):
        out, q, _ = self.run_job(HELLO, track=None)
        self.assertEqual(out, "failed:bad_response")
        self.assertFalse(q.finished["ok"])

    def test_the_stored_words_are_cleaned_again_even_if_an_adapter_did_not(self):
        q = CaptionQueue(captions_job(), recording_source(duration=3))

        class Raw:
            def submit(self, request):
                return "sync:raw"

            def poll(self, task_id, request, out_dir):
                out_dir.mkdir(parents=True, exist_ok=True)
                f = out_dir / "output_0.json"
                f.write_text(json.dumps({"language": "uz", "words": [
                    {"t": "sa‮lom\x00", "s": 0.5, "e": 1.0}, {"t": "late", "s": 40, "e": 41},
                    {"t": "back", "s": 0.2, "e": 0.3}]}))
                return cw.ProviderPoll(cw.SUCCEEDED, files=[f])

        w = cw.CreativeWorker(q, lambda m: Raw(), worker_id="w1", out_dir=self.out, credits=FakeCredits(amount=3),
                              enforce=True, media_root=self.media, sleep=lambda s: None, heartbeat_seconds=0)
        self.assertEqual(w.process(q.claim("w1")), "completed:captions")
        words = q.stored["words"]
        self.assertEqual([w["t"] for w in words], ["back", "salom"])
        self.assertTrue(all(b["s"] >= a["e"] for a, b in zip(words, words[1:])))

    def test_garbage_from_an_adapter_is_a_bad_response_not_a_result(self):
        for text in ("not json", json.dumps([1, 2]), json.dumps({"words": "x"})):
            q = CaptionQueue(captions_job(), recording_source())

            class Raw:
                def submit(self, request):
                    return "sync:raw"

                def poll(self, task_id, request, out_dir, _t=text):
                    out_dir.mkdir(parents=True, exist_ok=True)
                    f = out_dir / "output_0.json"
                    f.write_text(_t)
                    return cw.ProviderPoll(cw.SUCCEEDED, files=[f])

            w = cw.CreativeWorker(q, lambda m: Raw(), worker_id="w1", out_dir=self.out, credits=FakeCredits(amount=3),
                                  enforce=True, media_root=self.media, sleep=lambda s: None, heartbeat_seconds=0)
            self.assertEqual(w.process(q.claim("w1")), "failed:bad_response", text)
            self.assertFalse(q.finished["ok"])

    def test_the_capability_is_a_recording_tool_with_text_output(self):
        self.assertIn("captions", cw.SOURCE_CAPABILITIES)
        self.assertIn("captions", cw.MEDIA_SOURCE_CAPABILITIES)
        self.assertNotIn("captions", cw.VIDEO_SOURCE_CAPABILITIES)
        self.assertEqual(cw.OUTPUT_KIND["captions"], "text")
        self.assertNotIn("captions", cw.VERSION_CAPABILITIES)


# ── 0059 is built on 0055 / 0052 ─────────────────────────────────────────────

def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(sql):
    # Comments carry apostrophes ("the source's shape"): strip them, then read
    # the SQL string literals ('' is an escaped quote inside one).
    code = re.sub(r"--[^\n]*", "", sql)
    return set(re.findall(r"'(?:[^']|'')*'", code))


class BuiltOnTheLatestBodies(unittest.TestCase):
    """``create or replace`` keeps the LAST definition: a 0059 written on older
    bodies would silently remove describe, the voice tools, the video upscale
    or another change's lines. Every function it replaces must keep every
    literal of the latest body before it: the highest-numbered OTHER migration
    that defines it (0060's, once that change is in the tree; until then
    0055's / 0052's, with 0060's own lines pinned by name below)."""

    REPLACED = ("sellable_models", "creative_capability_supported", "creative_params_problem",
                "creative_source_problem", "creative_price")

    def latest_other(self, name):
        found = None
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name.startswith("0059"):
                continue
            b = bodies(path.read_text())
            if name in b:
                found = (path.name, b[name])
        if found is None:
            raise AssertionError(name)
        return found

    def test_every_function_0059_replaces_keeps_every_literal_of_the_latest_other_body(self):
        new = bodies((MIGRATIONS / "0059_captions.sql").read_text())
        self.assertEqual(set(self.REPLACED), {n for n in new if n not in ("store_caption_track", "delete_caption_track")})
        for name in self.REPLACED:
            src, old = self.latest_other(name)
            for lit in literals(old):
                self.assertIn(lit, new[name], f"{name} lost {lit} from {src}")

    def test_the_picture_quality_lines_of_0060_are_kept(self):
        # 0060 (image quality) replaces these three; 0059 is built on its bodies.
        new = bodies((MIGRATIONS / "0059_captions.sql").read_text())
        self.assertIn("'quality must be one of low, medium, high'", new["creative_params_problem"])
        self.assertIn("'language', 'quality') then", new["creative_params_problem"])
        self.assertIn("%s does not offer the %s quality", new["creative_price"])
        self.assertIn("'quality'", new["creative_price"])
        self.assertIn("'quality_tier', m.spec -> 'quality_tier'", new["sellable_models"])
        self.assertIn("is distinct from 'quality'", new["sellable_models"])

    def test_a_later_migration_that_replaces_these_functions_must_know_captions(self):
        # Numbered after 0059 = applied after it: its bodies win, and a body
        # without the captions lines would take the capability away again.
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if int(path.name[:4]) <= 59:
                continue
            for name, body in bodies(path.read_text()).items():
                if name in ("sellable_models", "creative_capability_supported", "creative_params_problem",
                            "creative_source_problem", "creative_price"):
                    self.assertIn("'captions'", body, f"{path.name} replaces {name} without the captions lines")

    def test_nothing_between_0055_and_0059_replaces_them(self):
        for path in sorted(MIGRATIONS.glob("*.sql")):
            number = int(path.name[:4])
            if number <= 55 or number >= 59:
                continue
            hit = [n for n in bodies(path.read_text()) if n in self.REPLACED]
            self.assertEqual(hit, [], f"{path.name} replaces {hit}: rebuild 0059 on it")

    def test_captions_are_added_to_every_list_that_names_the_recording_tools(self):
        new = bodies((MIGRATIONS / "0059_captions.sql").read_text())
        for name in ("creative_capability_supported", "sellable_models"):
            self.assertIn("'describe', 'captions'", new[name], name)
        self.assertIn("'voice_change', 'dub', 'captions'", new["creative_params_problem"])
        self.assertIn("'voice_change', 'dub', 'captions'", new["creative_source_problem"])
        self.assertIn("if cap in ('voice_change', 'dub', 'video_upscale', 'captions') then", new["creative_price"])

    def test_the_price_is_the_recordings_seconds_from_the_database_never_the_params(self):
        price = bodies((MIGRATIONS / "0059_captions.sql").read_text())["creative_price"]
        self.assertRegex(price, r"if cap in \('voice_change', 'dub', 'video_upscale', 'captions'\) then\s+[\s\S]*?qty := public\.creative_source_seconds\(p_org, p_params\)")
        self.assertIn("%s does not transcribe %s", price)

    def test_the_capability_check_and_the_track_table_are_in_the_migration(self):
        text = (MIGRATIONS / "0059_captions.sql").read_text()
        for needle in ("between 1 and 13", "creative_jobs_captions_check", "cardinality(result_asset_ids) = 0",
                       "create table if not exists public.caption_tracks", "alter table public.caption_tracks enable row level security",
                       "set search_path = public, pg_temp", "to service_role;", "-- Verify"):
            self.assertIn(needle, text)
        # Nobody writes the table directly, and anon reads nothing.
        self.assertIn("grant select on public.caption_tracks to authenticated, service_role;", text)
        self.assertNotRegex(text, r"grant (insert|update|delete)[^;]*caption_tracks")

    def test_every_security_definer_function_pins_its_search_path(self):
        new = bodies((MIGRATIONS / "0059_captions.sql").read_text())
        for name, body in new.items():
            if "security definer" in body:
                self.assertIn("set search_path = public, pg_temp", body, name)


if __name__ == "__main__":
    unittest.main()
