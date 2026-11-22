"""Kling lip-sync (modules/capabilities/lipsync.py) and its registry entry ``kling-lipsync``.

Every vendor call goes to a fake session: nothing here touches a network, a key or a vendor balance. What would break without it:

* the two documented request bodies (identify-face with ``video_url``; advanced-lip-sync with ``session_id`` and one
  ``face_choose`` item carrying OUR ``sound_file``), with nothing a person did not choose (no TTS ``audio_id``, no watermark);
* a file outside Kling's limits reaching the billed face check, or a request sent without the worker's measurements;
* a face picked silently: zero or two faces, or a named face that is not there, must stop before the lip-sync call;
* an unknown status, a success without a URL, or a result on a foreign host read as anything but a failure;
* Kling's 1303 (concurrency) read as anything but rate_limited, and a lost create answer read as a refusal (it may bill);
* the face-check session lost on a crash (it is in the task id, with the face that was moved);
* the entry leaking into the database: it is registry-only, never synced, never probed, terms-gated, web_only, unconfirmed.
"""

import json
import tempfile
import unittest

import requests

from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter
from modules.capabilities.base import (
    FAILED,
    LIPSYNC,
    PENDING,
    PROMPT_OPTIONAL,
    REGISTRY_ONLY_CAPABILITIES,
    SUCCEEDED,
    VIDEO_INPUT,
    AdapterError,
    CapabilityRequest,
    MediaFacts,
    Output,
    PollResult,
    ProviderTask,
)
from modules.capabilities import lipsync as lip
from modules.capabilities.lipsync import KlingLipsyncAdapter
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from tests.test_character_swap_adapters import Resp, Session

KEY = "kling-console-key-0123456789abcdef"
ENV = {"KLING_API_KEY": KEY}
VIDEO = "https://studio.example.com/api/media/file/11111111-1111-1111-1111-111111111111/original?t=video%2Fmp4&exp=1&sig=a"
SPEECH = "https://studio.example.com/api/media/file/44444444-4444-4444-4444-444444444444/original?t=audio%2Fmpeg&exp=1&sig=c"
CLIP = MediaFacts("mp4", 40_000_000, 8.0, 1920, 1080)
LINE = MediaFacts("mp3", 200_000, 6.5)
BASE = "https://api-singapore.klingai.com"
IDENTIFY, LIPSYNC_URL = "/v1/videos/identify-face", "/v1/videos/advanced-lip-sync"
ONE_FACE = {"code": 0, "data": {"session_id": "sess-1", "face_data": [{"face_id": "0", "start_time": 0, "end_time": 8000}]}}
TWO_FACES = {"code": 0, "data": {"session_id": "sess-1", "face_data": [{"face_id": "0", "start_time": 0, "end_time": 8000},
                                                                     {"face_id": "1", "start_time": 1000, "end_time": 7000}]}}
NO_FACES = {"code": 0, "data": {"session_id": "sess-1", "face_data": []}}
CREATED = {"code": 0, "data": {"task_id": "T-77", "task_status": "submitted"}}
MODEL = "advanced-lip-sync"
TASK = ProviderTask("video.kling_lipsync", MODEL, "sess-1/0/T-77")


def req(**kw):
    base = dict(capability=LIPSYNC, input_media=(VIDEO,), input_audio=SPEECH, input_media_facts=CLIP, input_audio_facts=LINE)
    base.update(kw)
    return CapabilityRequest(**base)


def adapter(routes=(), env=ENV, downloads=None):
    s = Session(routes, downloads)
    return build_adapter("video.kling_lipsync", env=env, session=s), s


def happy(identify=ONE_FACE, create=CREATED):
    return [("POST", IDENTIFY, Resp(200, identify)), ("POST", LIPSYNC_URL, Resp(200, create))]


def posted(session, frag):
    return [c for c in session.calls if c[0] == "POST" and frag in c[1]]


def polled(body):
    a, _ = adapter([("GET", f"{LIPSYNC_URL}/T-77", Resp(200, {"code": 0, "data": body}))])
    return a


class Bodies(unittest.TestCase):
    def test_the_face_check_then_one_face_with_our_own_speech(self):
        a, s = adapter(happy())
        task = a.submit(req(), MODEL, external_id="0b8f2c51-6f7c-4f1e-9a43-111111111111")
        self.assertEqual(task.task_id, "sess-1/0/T-77", "the billed session and the face survive a crash")
        self.assertEqual([c[1] for c in s.calls], [BASE + IDENTIFY, BASE + LIPSYNC_URL])
        first, second = s.calls[0][2], s.calls[1][2]
        self.assertEqual(first["json"], {"video_url": VIDEO})
        for kw in (first, second):
            self.assertEqual(kw["headers"]["Authorization"], f"Bearer {KEY}")
            self.assertEqual(kw["allow_redirects"], False, "the key never follows a 3xx")
        self.assertEqual(second["json"], {
            "session_id": "sess-1",
            "face_choose": [{"face_id": "0", "sound_file": SPEECH, "sound_start_time": 0, "sound_end_time": 6500,
                             "sound_insert_time": 0}],
            "external_task_id": "0b8f2c51-6f7c-4f1e-9a43-111111111111"})
        self.assertNotIn("audio_id", json.dumps(second["json"]), "Kling's own TTS (zh/en only) is never the voice")

    def test_a_chosen_window_and_a_named_face_are_sent_as_given(self):
        a, s = adapter(happy(identify=TWO_FACES))
        task = a.submit(req(face_id="1", sound_window_ms=(500, 4500, 1500)), MODEL)
        self.assertEqual(task.task_id, "sess-1/1/T-77")
        item = posted(s, LIPSYNC_URL)[0][2]["json"]["face_choose"]
        self.assertEqual(item, [{"face_id": "1", "sound_file": SPEECH, "sound_start_time": 500, "sound_end_time": 4500,
                                 "sound_insert_time": 1500}])
        self.assertEqual(set(posted(s, LIPSYNC_URL)[0][2]["json"]), {"session_id", "face_choose"}, "no external id unless given")

    def test_no_watermark_field_and_no_label_replacement(self):
        from tests.test_vendor_watermarks import provenance_offences, watermark_fields
        a, s = adapter(happy())
        a.submit(req(), MODEL)
        for _, _, kw in s.calls:
            self.assertEqual(list(watermark_fields(kw["json"])), [])
            self.assertEqual(list(provenance_offences(kw["json"])), [])


class RefusedBeforeAnyCall(unittest.TestCase):
    def assert_refused(self, r, model=MODEL):
        a, s = adapter()
        with self.assertRaises(AdapterError) as cm:
            a.submit(r, model)
        self.assertEqual(cm.exception.code, "bad_request", r)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(s.calls, [], "nothing reached the billed face check")
        return cm.exception.message

    def test_a_video_outside_klings_limits(self):
        for facts in (MediaFacts("webm", 1_000_000, 8.0, 1280, 720), MediaFacts("mp4", 100_000_001, 8.0, 1280, 720),
                      MediaFacts("mp4", 1_000_000, 1.9, 1280, 720), MediaFacts("mp4", 1_000_000, 60.5, 1280, 720),
                      MediaFacts("mp4", 1_000_000, 8.0, 854, 480), MediaFacts("mp4", 1_000_000, 8.0, 3840, 2160),
                      MediaFacts("mp4", 1_000_000, 8.0, 2560, 1080), MediaFacts("mp4", 1_000_000, 8.0, None, None),
                      MediaFacts("mov", 0, 8.0, 1280, 720)):
            self.assert_refused(req(input_media_facts=facts))
        for ok in (MediaFacts("mov", 100_000_000, 2.0, 720, 1280), MediaFacts("mp4", 1, 60.0, 1920, 1080)):
            self.assertEqual(lip.media_problems(ok, LINE), [], ok)

    def test_speech_outside_klings_limits(self):
        for facts in (MediaFacts("ogg", 100_000, 6.0), MediaFacts("mp3", 5_000_001, 6.0), MediaFacts("wav", 100_000, 1.5),
                      MediaFacts("m4a", 100_000, 61.0)):
            self.assert_refused(req(input_audio_facts=facts))
        for fmt in ("mp3", "wav", "m4a", "aac"):
            self.assertEqual(lip.media_problems(CLIP, MediaFacts(fmt, 5_000_000, 2.0)), [], fmt)

    def test_nothing_unmeasured_is_sent_on_trust(self):
        self.assertIn("not measured", self.assert_refused(req(input_media_facts=None)))
        self.assertIn("not measured", self.assert_refused(req(input_audio_facts=None)))

    def test_inputs_that_are_not_signed_links_or_not_a_lipsync(self):
        for r in (req(input_media=("/tmp/clip.mp4",)), req(input_media=()), req(input_media=(VIDEO, VIDEO)),
                  req(input_audio=None), req(input_audio="/tmp/line.mp3"), req(prompt="make him talk"),
                  req(resolution="1080p"), req(duration_s=5), req(aspect_ratio="16:9"), req(audio=True),
                  req(input_images=("https://x.example/p.png",)), req(face_id="../x")):
            self.assert_refused(r)
        self.assert_refused(req(), model="kling-v3")

    def test_a_window_kling_would_refuse(self):
        for w in ((0, 1999, 0), (-1, 4000, 0), (0, 4000, -5), (0, 7000, 0), (0, 4000, 8000), (0, 4000), (0.5, 4000, 0), "0,4000,0"):
            self.assert_refused(req(sound_window_ms=w))

    def test_the_legacy_access_secret_pair_is_not_configured(self):
        for env in ({"KLING_API_KEY": "AK123:SK456"}, {"KLING_ACCESS_KEY": "AK", "KLING_SECRET_KEY": "SK"}, {}):
            a, s = adapter(env=env)
            with self.assertRaises(AdapterError) as cm:
                a.submit(req(), MODEL)
            self.assertEqual(cm.exception.code, "not_configured")
            self.assertTrue(cm.exception.not_accepted)
            self.assertNotIn("SK456", cm.exception.message)
            self.assertEqual(s.calls, [])


class OneFaceNeverAGuess(unittest.TestCase):
    def assert_stops_after_the_face_check(self, identify, reason, **kw):
        a, s = adapter(happy(identify=identify))
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(**kw), MODEL)
        self.assertEqual(cm.exception.code, "bad_request")
        self.assertTrue(cm.exception.message.startswith(reason + ":"), cm.exception.message)
        self.assertFalse(cm.exception.not_accepted, "the face check was billed")
        self.assertIn("sess-1", cm.exception.message, "the operator can find the billed session")
        self.assertEqual(posted(s, LIPSYNC_URL), [], "no lip-sync call")
        self.assertEqual(len(posted(s, IDENTIFY)), 1)
        return cm.exception.message

    def test_zero_faces(self):
        self.assert_stops_after_the_face_check(NO_FACES, lip.NO_FACE)

    def test_two_faces_without_a_choice(self):
        msg = self.assert_stops_after_the_face_check(TWO_FACES, lip.SEVERAL_FACES)
        self.assertIn("name the face", msg)

    def test_a_named_face_that_is_not_there(self):
        self.assert_stops_after_the_face_check(ONE_FACE, lip.FACE_NOT_FOUND, face_id="3")

    def test_speech_placed_where_the_face_is_not(self):
        late = {"code": 0, "data": {"session_id": "sess-1", "face_data": [{"face_id": "0", "start_time": 6000, "end_time": 8000}]}}
        self.assert_stops_after_the_face_check(late, lip.FACE_OVERLAP, sound_window_ms=(0, 4000, 0))

    def test_the_reasons_are_a_closed_list(self):
        self.assertEqual(lip.REASONS, ("no_face", "several_faces", "face_not_found", "face_overlap"))

    def test_a_face_without_an_interval_or_with_an_odd_id_is_not_moved(self):
        for face in ({"face_id": "0"}, {"face_id": "0/../x", "start_time": 0, "end_time": 8000}):
            a, s = adapter(happy(identify={"code": 0, "data": {"session_id": "sess-1", "face_data": [face]}}))
            with self.assertRaises(AdapterError) as cm:
                a.submit(req(), MODEL)
            self.assertEqual(cm.exception.code, "bad_response")
            self.assertEqual(posted(s, LIPSYNC_URL), [])


class LostAnswersAndVendorCodes(unittest.TestCase):
    def test_a_lost_face_check_answer_is_unconfirmed_spend(self):
        for resp in (requests.exceptions.ReadTimeout("x"), Resp(502, "bad gateway"), Resp(200, {"code": 0, "data": {}})):
            a, s = adapter([("POST", IDENTIFY, resp)])
            with self.assertRaises(AdapterError) as cm:
                a.submit(req(), MODEL)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
            self.assertFalse(cm.exception.not_accepted)
            self.assertEqual(posted(s, LIPSYNC_URL), [])

    def test_a_lost_create_answer_is_unconfirmed_spend_not_a_refusal(self):
        for resp in (requests.exceptions.ReadTimeout("x"), Resp(500, "oops"), Resp(200, {"code": 0, "data": {}}),
                     Resp(200, {"code": 0, "data": {"task_id": "T 1/../x"}})):
            a, _ = adapter([("POST", IDENTIFY, Resp(200, ONE_FACE)), ("POST", LIPSYNC_URL, resp)])
            with self.assertRaises(AdapterError) as cm:
                a.submit(req(), MODEL)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
            self.assertFalse(cm.exception.not_accepted)

    def test_1303_concurrency_is_rate_limited(self):
        for routes in ([("POST", IDENTIFY, Resp(429, {"code": 1303, "message": "parallel task over resource pack limit"}))],
                       [("POST", IDENTIFY, Resp(200, ONE_FACE)), ("POST", LIPSYNC_URL, Resp(200, {"code": 1303, "message": "busy"}))]):
            a, _ = adapter(routes)
            with self.assertRaises(AdapterError) as cm:
                a.submit(req(), MODEL)
            self.assertEqual(cm.exception.code, "rate_limited")
            self.assertTrue(cm.exception.retryable)

    def test_an_empty_package_is_quota_and_the_key_never_appears(self):
        a, _ = adapter([("POST", IDENTIFY, Resp(402, {"code": 1102, "message": f"package used up for {KEY}"}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), MODEL)
        self.assertEqual(cm.exception.code, "quota")
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(KEY, cm.exception.message)


class Poll(unittest.TestCase):
    def test_running_states_are_pending(self):
        for status in ("submitted", "processing"):
            self.assertEqual(polled({"task_id": "T-77", "task_status": status}).poll(TASK).state, PENDING)

    def test_success_is_fetched_only_from_klings_hosts(self):
        a, s = adapter([("GET", f"{LIPSYNC_URL}/T-77", Resp(200, {"code": 0, "data": {
            "task_id": "T-77", "task_status": "succeed",
            "task_result": {"videos": [{"id": "v1", "url": "https://v15-kling.klingai.com/lip.mp4", "duration": "8.0"}]}}}))])
        out = a.poll(TASK)
        self.assertEqual(out.state, SUCCEEDED)
        self.assertEqual(out.outputs[0].url, "https://v15-kling.klingai.com/lip.mp4")
        self.assertEqual(s.calls[0][1], f"{BASE}{LIPSYNC_URL}/T-77", "only the task part of the id goes into the URL")

    def test_a_foreign_host_fails_closed_after_completion(self):
        a = polled({"task_id": "T-77", "task_status": "succeed", "task_result": {"videos": [{"url": "https://evil.example/lip.mp4"}]}})
        with self.assertRaises(AdapterError) as cm:
            a.poll(TASK)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))

    def test_success_without_a_url_fails_closed(self):
        for result in ({}, {"videos": []}, {"videos": [{"url": ""}]}):
            a = polled({"task_id": "T-77", "task_status": "succeed", "task_result": result})
            with self.assertRaises(AdapterError) as cm:
                a.poll(TASK)
            self.assertEqual(cm.exception.code, "bad_response")
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))

    def test_an_unknown_status_is_not_still_running(self):
        for status in ("succeeded", "done", "", None):
            with self.assertRaises(AdapterError) as cm:
                polled({"task_id": "T-77", "task_status": status}).poll(TASK)
            self.assertEqual(cm.exception.code, "bad_response", status)

    def test_failed_carries_klings_reason(self):
        out = polled({"task_id": "T-77", "task_status": "failed", "task_status_msg": "face lost in frame"}).poll(TASK)
        self.assertEqual(out.state, FAILED)
        self.assertIn("face lost", out.error.message)

    def test_another_tasks_answer_is_not_ours(self):
        with self.assertRaises(AdapterError):
            polled({"task_id": "OTHER", "task_status": "succeed"}).poll(TASK)

    def test_a_task_id_from_a_row_cannot_steer_the_request(self):
        for tid in ("T-77", "sess-1/T-77", "../../v1/account/x/y", "s/0/T 1", "s/0/T?x=1", "s//T", "", None):
            a, s = adapter()
            with self.assertRaises(AdapterError):
                a.poll(ProviderTask("video.kling_lipsync", MODEL, tid))
            self.assertEqual(s.calls, [], tid)
        self.assertEqual(KlingLipsyncAdapter.parse_task_id("sess-1/0/T-77"), ("sess-1", "0", "T-77"))

    def test_the_download_follows_no_redirect_sends_no_key_and_is_capped(self):
        url = "https://v15-kling.klingai.com/lip.mp4"
        a, s = adapter(downloads={url: Resp(302, headers={"Location": "https://evil.example/"})})
        with self.assertRaises(AdapterError):
            a.fetch(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]), tempfile.mkdtemp())
        self.assertNotIn("headers", s.calls[0][2])
        a, _ = adapter(downloads={url: Resp(200, headers={"Content-Length": str(300 * 1024 * 1024)}, content=b"x")})
        with self.assertRaises(AdapterError) as cm:
            a.fetch(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]), tempfile.mkdtemp())
        self.assertIn("byte limit", cm.exception.message)


ENTRY = reg.registry()["kling-lipsync"]


class RegistryEntry(unittest.TestCase):
    def test_the_capability_is_registry_only_and_takes_a_video_and_no_words(self):
        self.assertIn(LIPSYNC, REGISTRY_ONLY_CAPABILITIES)
        self.assertIn(LIPSYNC, VIDEO_INPUT)
        self.assertIn(LIPSYNC, PROMPT_OPTIONAL)

    def test_dark_by_every_field(self):
        e = ENTRY
        self.assertTrue(e.registry_only)
        self.assertEqual((e.capabilities, e.adapter, e.provider), ((LIPSYNC,), "video.kling_lipsync", "kling"))
        self.assertEqual((e.api_exposure, e.terms_gate), ("web_only", "terms_review_required"))
        kling_gates = {x.terms_gate for x in reg.registry().values() if x.provider == "kling"}
        self.assertEqual(kling_gates, {"terms_review_required"}, "the same terms review as the other Kling entries")
        self.assertFalse(e.raw["pricing"]["confirmed"])
        self.assertNotIn("credit", json.dumps(e.raw["pricing"]), "a vendor price, never a credit price")

    def test_never_synced_and_never_probed(self):
        from tools import probe_models
        entries = list(reg.registry().values())
        self.assertNotIn("kling-lipsync", {row["id"] for row in reg.sync_rows(entries)})
        self.assertEqual([x.id for x in probe_models.registry_only_left_out(entries, ["kling-lipsync"], None)], ["kling-lipsync"])

    def test_the_researched_price_limits_auth_and_sources(self):
        raw = ENTRY.raw
        self.assertEqual(raw["pricing"]["provider_usd_per_unit"], 0.014)
        self.assertEqual((raw["pricing"]["unit"], raw["pricing"]["source_url"], raw["pricing"]["as_of"]),
                         ("second", "https://kling.ai/document-api/pricing/base/video.md", "2026-11-22"))
        for quote in ("0.5 Units ($0.07) /5s", "$0.007", "/call"):
            self.assertIn(quote, raw["pricing"]["note"])
        doc = raw["api_documented"]
        self.assertEqual(doc["url"], "https://kling.ai/document-api/api/video/lip-sync.md")
        self.assertIn("https://kling.ai/document-api/api/video/lip-sync/face-detection.md", doc["evidence"])
        self.assertIn("API key (Bearer)", doc["evidence"])
        self.assertNotIn("JWT or API key", json.dumps(raw), "G8: Kling's auth is the API key, the JWT is legacy")
        notes = " ".join(raw["terms_notes"])
        self.assertIn("3.3", notes)
        self.assertIn("8.2.3", notes)
        self.assertIn("Gate stays open", notes)
        self.assertEqual(ENTRY.max_source_seconds, 60)

    def test_the_entry_and_the_adapter_state_the_same_limits(self):
        L = ENTRY.raw["lipsync"]
        self.assertEqual(tuple(L["video_formats"]), lip.VIDEO_FORMATS)
        self.assertEqual(tuple(L["audio_formats"]), lip.AUDIO_FORMATS)
        self.assertEqual((L["video_max_bytes"], L["audio_max_bytes"]), (lip.VIDEO_MAX_BYTES, lip.AUDIO_MAX_BYTES))
        self.assertEqual((tuple(L["video_seconds"]), tuple(L["audio_seconds"])), (lip.VIDEO_SECONDS, lip.AUDIO_SECONDS))
        self.assertEqual(tuple(L["video_short_sides_px"]), lip.VIDEO_SHORT_SIDES_PX)
        self.assertEqual((L["video_min_side_px"], L["video_max_side_px"]), (lip.VIDEO_MIN_SIDE_PX, lip.VIDEO_MAX_SIDE_PX))
        self.assertEqual((L["faces_per_task"], L["min_overlap_ms"], L["speech_source"]), (1, lip.MIN_OVERLAP_MS, "our_file"))

    def test_the_validator_holds_the_lipsync_rules(self):
        doc = json.loads(reg.REGISTRY_PATH.read_text(encoding="utf-8"))
        self.assertEqual(reg.validate(doc), [], "the shipped file is valid")

        def mutated(change):
            bad = json.loads(json.dumps(doc))
            change(next(m for m in bad["models"] if m["id"] == "kling-lipsync"))
            return reg.validate(bad)

        self.assertTrue(any("lipsync is required with lipsync" in e for e in mutated(lambda m: m.pop("lipsync"))))
        self.assertTrue(any("within limits.max_source_seconds" in e
                            for e in mutated(lambda m: m["limits"].update(max_source_seconds=30))))
        for change in (lambda m: m.update(terms_gate=None), lambda m: m.update(api_exposure="any"),
                       lambda m: m["pricing"].update(confirmed=True)):
            self.assertTrue(any("a registry-only entry stays dark" in e for e in mutated(change)))
        errors = mutated(lambda m: m["lipsync"].update(faces_per_task=2))
        self.assertTrue(errors, "one face per task is the vendor's rule")
        bad = json.loads(json.dumps(doc))
        next(m for m in bad["models"] if m["id"] == "kling-v2.6")["lipsync"] = json.loads(json.dumps(ENTRY.raw["lipsync"]))
        self.assertTrue(any("lipsync is required with lipsync and only with it" in e for e in reg.validate(bad)))

    def test_the_entry_refuses_a_speech_file_on_any_other_tool(self):
        t2v = reg.registry()["kling-v2.6"]
        r = CapabilityRequest("t2v", "a boat", input_audio=SPEECH)
        self.assertTrue(any("does not apply" in p for p in t2v.problems(r)))
        self.assertTrue(any("needs the speech" in p for p in ENTRY.problems(req(input_audio=None))))
        self.assertEqual(ENTRY.problems(req()), [])

    def test_registered_and_serving_only_lipsync(self):
        self.assertIs(ADAPTERS["video.kling_lipsync"], KlingLipsyncAdapter)
        self.assertEqual(KlingLipsyncAdapter.capabilities, (LIPSYNC,))


if __name__ == "__main__":
    unittest.main()
