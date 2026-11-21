"""Seedance 2.5 / 2.5 Flash through Runway's API (video.runway_seedance): gated, built post-event.

What would break without these tests:

* a job without a stated soundtrack reaching Runway with no ``audio`` field, so Runway's default (on) is made and billed
  for nobody's choice (CLAUDE.md #4);
* ``duration: auto`` being sent, which Runway bills at the longest length up front, or a length outside 4-30 s or a
  length nobody chose (the price is per second);
* keyframes and reference pictures sent together (Runway: they "cannot be mixed") or a picture on text-to-video read as
  a frame; a reference recording or clip reaching Runway as anything but an ephemeral ``runway://`` upload;
* a ratio Runway does not list, or a resolution the model does not make, reaching a paid call;
* a spoken Uzbek or Russian line going out without the language marked (Runway's Seedance prompt guide);
* another maker's model on a Runway adapter going on sale with nobody having decided it (the terms gate).

No network, no key, no database: every call goes to a fake session.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import E_BAD_REQUEST, AdapterError, CapabilityRequest
from tests.test_capabilities import ENV, FakeResp
from tests.test_voice_tools import RecordingSession

PRO, FLASH = "seedance2_5", "seedance2_5_flash"
ENTRIES = ("runway-seedance-2.5", "runway-seedance-2.5-flash")
GATE = "written_ok_required: Runway written confirmation naming Seedance + owner exception to own-models-only rule"
TASK = "1f2e3d4c-5b6a-4789-8abc-def012345678"
UPLOAD = "https://runway-uploads.s3.amazonaws.com/"
TICKET = {"uploadUrl": UPLOAD, "fields": {"key": "ephemeral/abc/ref", "policy": "p"}, "runwayUri": "runway://ephemeral/abc"}
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 1024
MP3 = b"ID3" + b"\x00" * 1024


def routes(path="/v1/text_to_video", uploads=False):
    out = [("POST", path, FakeResp(200, {"id": TASK}))]
    if uploads:
        out = [("POST", "/v1/uploads", FakeResp(200, TICKET)), ("POST", UPLOAD, FakeResp(204))] + out
    return out


def make(route_list=(), seconds=10.0):
    a = build_adapter("video.runway_seedance", env=ENV, session=RecordingSession(route_list))
    a.seconds_of = lambda _path: seconds
    return a


def t2v(**kw) -> CapabilityRequest:
    base = dict(aspect_ratio="9:16", resolution="720p", duration_s=5)
    base.update(kw)
    return CapabilityRequest("t2v", "a lighthouse at dusk", **base)


def i2v(**kw) -> CapabilityRequest:
    base = dict(aspect_ratio="9:16", resolution="720p", duration_s=5, input_images=("https://img.test/first.png",))
    base.update(kw)
    return CapabilityRequest("i2v", "slow push in", **base)


def sent(a, path):
    """The JSON body of the one task-creating call (uploads are not it)."""
    bodies = [kw["json"] for m, url, kw in a.session.calls if m == "POST" and url.endswith(path)]
    assert len(bodies) == 1, a.session.calls
    return bodies[0]


class RequestBodies(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name, data):
        p = self.root / name
        p.write_bytes(data)
        return str(p)

    def test_text_to_video_sends_the_documented_fields_and_audio_off_when_nobody_asked(self):
        a = make(routes())
        task = a.submit(t2v(), PRO)
        self.assertEqual(task.task_id, TASK)
        self.assertEqual(sent(a, "/v1/text_to_video"),
                         {"model": PRO, "promptText": "a lighthouse at dusk", "ratio": "720:1280", "duration": 5,
                          "audio": False})

    def test_audio_is_sent_as_asked_true_and_false(self):
        for asked in (True, False):
            with self.subTest(audio=asked):
                a = make(routes())
                a.submit(t2v(audio=asked), PRO)
                self.assertIs(sent(a, "/v1/text_to_video")["audio"], asked)

    def test_each_resolution_picks_its_own_9_16_ratio(self):
        for res, ratio in (("480p", "480:854"), ("720p", "720:1280"), ("1080p", "1080:1920"), ("4k", "2160:3840")):
            with self.subTest(res=res):
                a = make(routes())
                a.submit(t2v(resolution=res), PRO)
                self.assertEqual(sent(a, "/v1/text_to_video")["ratio"], ratio)

    def test_thirty_seconds_is_sent_as_thirty(self):
        a = make(routes())
        a.submit(t2v(duration_s=30), PRO)
        self.assertEqual(sent(a, "/v1/text_to_video")["duration"], 30)

    def test_image_to_video_sends_first_and_last_keyframes_with_positions(self):
        a = make(routes("/v1/image_to_video"))
        a.submit(i2v(end_image="https://img.test/last.png"), PRO)
        body = sent(a, "/v1/image_to_video")
        self.assertEqual(body["promptImage"], [{"uri": "https://img.test/first.png", "position": "first"},
                                               {"uri": "https://img.test/last.png", "position": "last"}])
        self.assertIs(body["audio"], False)

    def test_image_to_video_references_go_in_promptimage_without_a_position(self):
        a = make(routes("/v1/image_to_video"))
        a.submit(i2v(input_images=(), reference_images=("https://img.test/a.png", "https://img.test/b.png")), PRO)
        self.assertEqual(sent(a, "/v1/image_to_video")["promptImage"],
                         [{"uri": "https://img.test/a.png"}, {"uri": "https://img.test/b.png"}])

    def test_text_to_video_references_audio_and_clips_go_up_as_runway_uploads(self):
        clip, voice = self.file("move.mp4", MP4), self.file("line.mp3", MP3)
        a = make(routes(uploads=True))
        a.submit(t2v(reference_images=("https://img.test/a.png",), reference_videos=(clip,), reference_audio=(voice,)),
                 PRO)
        body = sent(a, "/v1/text_to_video")
        self.assertEqual(body["references"], [{"uri": "https://img.test/a.png"}])
        self.assertEqual(body["referenceVideos"], [{"uri": "runway://ephemeral/abc"}])
        self.assertEqual(body["referenceAudio"], [{"uri": "runway://ephemeral/abc"}])
        storage = [kw for m, url, kw in a.session.calls if url == UPLOAD]
        self.assertEqual([kw["files"]["file"][2] for kw in storage], ["video/mp4", "audio/mpeg"])
        # The presigned upload is the credential: our key never reaches the storage host.
        self.assertTrue(all("headers" not in kw or not kw["headers"] for kw in storage))

    def test_an_uzbek_line_is_marked_and_english_is_not(self):
        a = make(routes())
        a.submit(t2v(dialogue_language="uz"), PRO)
        self.assertEqual(sent(a, "/v1/text_to_video")["promptText"],
                         "a lighthouse at dusk\nThe dialogue is spoken in Uzbek.")
        a = make(routes())
        a.submit(t2v(dialogue_language="en"), PRO)
        self.assertEqual(sent(a, "/v1/text_to_video")["promptText"], "a lighthouse at dusk")

    def test_a_prompt_that_already_names_the_language_is_not_marked_twice(self):
        a = make(routes())
        a.submit(CapabilityRequest("t2v", 'She says in Russian: "Привет"', aspect_ratio="9:16", resolution="720p",
                                   duration_s=5, dialogue_language="ru"), PRO)
        self.assertEqual(sent(a, "/v1/text_to_video")["promptText"], 'She says in Russian: "Привет"')


class Refusals(unittest.TestCase):
    """Every refusal happens before any call: nothing is uploaded, nothing is sent, nothing is billed."""

    def refused(self, request, model=PRO, seconds=10.0):
        a = make(routes(uploads=True), seconds=seconds)
        with self.assertRaises(AdapterError) as cm:
            a.submit(request, model)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(a.session.calls, [])
        return str(cm.exception)

    def test_auto_duration_is_refused_because_it_holds_the_maximum(self):
        self.assertIn("holds the longest length up front", self.refused(t2v(duration_s="auto")))

    def test_lengths_outside_4_to_30_or_unstated_are_refused(self):
        for d in (3, 31, None, 5.5, True):
            with self.subTest(d=d):
                self.refused(t2v(duration_s=d))

    def test_keyframes_and_references_together_are_refused(self):
        self.assertIn("cannot be mixed", self.refused(i2v(reference_images=("https://img.test/r.png",))))
        self.refused(i2v(input_images=(), end_image="https://img.test/last.png",
                         reference_images=("https://img.test/r.png",)))

    def test_a_ratio_runway_does_not_list_or_none_is_refused(self):
        for ratio in ("16:9", "1:1", None):
            with self.subTest(ratio=ratio):
                self.refused(t2v(aspect_ratio=ratio))

    def test_flash_stops_at_720p_and_a_resolution_is_never_defaulted(self):
        self.refused(t2v(resolution="1080p"), FLASH)
        self.refused(t2v(resolution=None))

    def test_a_picture_on_text_to_video_is_never_read_as_a_frame(self):
        self.refused(t2v(input_images=("https://img.test/a.png",)))

    def test_reference_sound_and_clips_are_refused_on_image_to_video(self):
        self.refused(i2v(reference_audio=("line.mp3",)))

    def test_reference_audio_of_thirty_seconds_or_unreadable_length_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            voice = Path(d) / "line.mp3"
            voice.write_bytes(MP3)
            self.assertIn("shorter than 30", self.refused(t2v(reference_audio=(str(voice),)), seconds=30.0))
            self.assertIn("could not be read", self.refused(t2v(reference_audio=(str(voice),)), seconds=None))

    def test_too_many_references_and_unknown_types_are_refused(self):
        self.refused(t2v(reference_images=tuple(f"https://img.test/{i}.png" for i in range(31))))
        self.refused(t2v(reference_audio=("line.ogg",)))
        self.refused(t2v(reference_videos=("move.gif",)))

    def test_a_language_this_route_cannot_mark_is_refused(self):
        self.refused(t2v(dialogue_language="kk"))

    def test_an_unknown_vendor_model_is_refused(self):
        self.refused(t2v(), "gen4.5")


class OtherAdaptersNeverDropTheNewInputs(unittest.TestCase):
    def test_gen45_refuses_references_and_a_dialogue_language_rather_than_dropping_them(self):
        r = reg.load()
        a = build_adapter("video.runway", env=ENV, session=RecordingSession())
        e = r["runway-gen4.5"]
        base = dict(aspect_ratio="16:9", duration_s=5, input_images=("https://img.test/p.png",))
        for extra in ({"reference_images": ("https://img.test/r.png",)}, {"reference_audio": ("a.mp3",)},
                      {"reference_videos": ("v.mp4",)}, {"dialogue_language": "uz"}):
            with self.subTest(extra=extra):
                self.assertTrue(a.problems(CapabilityRequest("i2v", "x", **base, **extra), e))


class Registry(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_both_entries_are_gated_web_only_unpriced_and_attributed(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid, vendor in zip(ENTRIES, (PRO, FLASH)):
            with self.subTest(mid=mid):
                e = self.r[mid]
                self.assertEqual((e.adapter, e.vendor_model, e.provider), ("video.runway_seedance", vendor, "runway"))
                self.assertEqual(e.terms_gate, GATE)
                self.assertEqual(rows[mid]["spec"]["terms_gate"], GATE)   # what keeps it off sale in SQL (0035)
                self.assertEqual(e.api_exposure, "web_only")
                self.assertFalse(e.raw["pricing"]["confirmed"])
                self.assertIsNone(e.raw["pricing"]["provider_usd_per_unit"])
                self.assertTrue(all(v is None for v in e.raw["pricing"]["variants"]["prices"].values()))
                self.assertNotIn("operator_preview", e.raw)
                self.assertEqual(e.raw["attribution"], {"text": "Powered by Runway", "url": "https://runway.com"})

    def test_the_gate_value_is_one_the_schema_and_the_module_agree_on(self):
        schema = json.loads(reg.SCHEMA_PATH.read_text())
        enum = schema["$defs"]["model"]["properties"]["terms_gate"]["enum"]
        self.assertEqual([g for g in enum if g], list(reg.TERMS_GATES))
        self.assertEqual(reg.RUNWAY_THIRD_PARTY_GATE, GATE)

    def test_offered_lengths_and_resolutions_are_inside_what_the_adapter_sends(self):
        from modules.capabilities.video import RunwaySeedanceAdapter as A
        for mid in ENTRIES:
            e = self.r[mid]
            spec = A.SPECS[e.vendor_model]
            self.assertTrue(set(e.durations_s) <= set(spec["durations"]), mid)
            self.assertEqual(set(e.resolutions), set(spec["resolutions"]), mid)
            self.assertEqual(set(e.aspect_ratios), set(A.RATIOS), mid)

    def test_a_clip_from_reference_pictures_alone_passes_the_registry(self):
        # Without it the registry demands a first frame, and i2v references could never reach the adapter.
        e = self.r["runway-seedance-2.5"]
        req = i2v(input_images=(), reference_images=("https://img.test/a.png",))
        self.assertEqual(make().problems(req, e), [])
        self.assertIn("i2v needs an input image", reg.ModelEntry.problems(e, i2v(input_images=())))

    def test_probes_pass_the_registry_and_the_adapter_and_are_not_run_by_all(self):
        from tools import probe_models
        a = make()
        for mid in ENTRIES:
            e = self.r[mid]
            self.assertEqual(a.problems(e.probe_request(), e), [], mid)
        # --all (the workflow's empty "model" input) never makes a paid call to a gated model.
        chosen = probe_models.select(self.r.values(), [], None, True)
        self.assertFalse({e.id for e in chosen} & set(ENTRIES))
        self.assertEqual(a.session.calls, [])


if __name__ == "__main__":
    unittest.main()
