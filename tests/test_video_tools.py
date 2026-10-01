"""The video tools (migration 0052): a video upscale of a library video, and an
image-to-video clip that ends on a chosen picture — the provider adapters, the
registry, the adapter seam, the worker and the probe, all through fake
sessions, so nothing here touches a network or spends anything.

What must hold: each vendor gets exactly its documented request (Runway's
ephemeral upload + /v1/video_upscale with a target resolution; Veo's
lastFrame, Kling's image_tail, Luma's end_frame, Seedance's first/last-frame
roles) built from files the worker copied by id — never a URL from the params;
our key never reaches the upload's storage host; a source whose frame rate is
above (or cannot be read against) what the per-second price assumes is
refused before anything is uploaded; an end frame is sent or the job fails —
a model that would drop it never gets the job; every failure fails the job
(so the database releases the hold) with a typed code and no secret in the
text; and the usage reported is the quantity the DATABASE priced."""

from __future__ import annotations

import base64
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import media_library as ml
from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_QUOTA,
    PENDING,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    ProviderTask,
)
from tests.test_capabilities import FakeResp
from tests.test_creative_media_inputs import FakeStore, SourceQueue, put_asset
from tests.test_creative_worker import JOB, ORG, FakeCredits, job
from tests.test_voice_tools import RecordingSession

KEY = "key_TOPSECRET-runway-0123456789abcdef"
GKEY = "AIzaTOPSECRETgoogle0123456789abcdefgh"
ENV = {"RUNWAYML_API_SECRET": KEY, "GEMINI_API_KEY": GKEY, "LUMA_AGENTS_API_KEY": KEY,
       "SEEDANCE_API_KEY": KEY, "KLING_API_KEY": KEY, "MINIMAX_API_KEY": KEY, "WAN_API_KEY": KEY}
SRC = "ab0c1d1e-0000-4000-8000-0000000052a5"
END = "cd0c1d1e-0000-4000-8000-0000000052e7"
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 1024
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
UPLOAD = "https://runway-uploads.s3.amazonaws.com/"
TICKET = {"uploadUrl": UPLOAD, "fields": {"key": "ephemeral/abc/source.mp4", "policy": "eyJ...", "x-amz-signature": "f00"},
          "runwayUri": "runway://ephemeral/abc"}
TASK = "1f2e3d4c-5b6a-4789-8abc-def012345678"
OUT = "https://dnznrvs05pmza.cloudfront.net/out.mp4?_jwt=x"


def adapter(key, routes=(), downloads=None, env=ENV, fps=30.0):
    a = build_adapter(key, env=env, session=RecordingSession(routes, downloads))
    if hasattr(a, "fps_of"):
        a.fps_of = lambda _path: fps
    return a


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name="source.mp4", data=MP4) -> str:
        p = self.root / name
        p.write_bytes(data)
        return str(p)


def upscale_routes():
    return [("POST", "/v1/uploads", FakeResp(200, TICKET)),
            ("POST", UPLOAD, FakeResp(204)),
            ("POST", "/v1/video_upscale", FakeResp(200, {"id": TASK, "estimatedCost": {"credits": 210}}))]


# ── the Runway video upscaler ────────────────────────────────────────────────

class RunwayUpscale(Tmp):
    ENTRY = "runway-video-upscale"

    def req(self, target="4k", media=None):
        return CapabilityRequest("video_upscale", input_media=(media or self.file(),), upscale_target=target)

    def test_the_file_is_uploaded_ephemerally_then_the_documented_task_is_started(self):
        a = adapter("video.runway_upscale", upscale_routes())
        task = a.submit(self.req(), "magnific_video_upscaler_creative")
        (m1, u1, k1), (m2, u2, k2), (m3, u3, k3) = a.session.calls
        self.assertEqual((m1, u1), ("POST", "https://api.dev.runwayml.com/v1/uploads"))
        self.assertEqual(k1["json"], {"filename": "source.mp4", "type": "ephemeral"})
        self.assertEqual(k1["headers"]["Authorization"], f"Bearer {KEY}")
        self.assertEqual(k1["headers"]["X-Runway-Version"], "2024-11-06")
        # The presigned upload: the ticket's fields and the file, and NO key.
        self.assertEqual((m2, u2), ("POST", UPLOAD))
        self.assertEqual(k2["data"], TICKET["fields"])
        self.assertEqual(k2["files"]["file"], ("source.mp4", MP4, "video/mp4"))
        self.assertNotIn("headers", k2)
        self.assertFalse(k2["allow_redirects"])
        self.assertNotIn(KEY, json.dumps({k: str(v) for k, v in k2.items()}))
        # The task names the upload, never a URL of ours; no fpsBoost (it changes the bill).
        self.assertEqual((m3, u3), ("POST", "https://api.dev.runwayml.com/v1/video_upscale"))
        self.assertEqual(k3["json"], {"model": "magnific_video_upscaler_creative",
                                      "videoUri": "runway://ephemeral/abc", "resolution": "4k"})
        self.assertEqual(task.task_id, TASK)

    def test_it_is_polled_like_every_runway_task_and_the_clip_is_fetched(self):
        task = ProviderTask("video.runway_upscale", "magnific_video_upscaler_creative", TASK)
        a = adapter("video.runway_upscale", [("GET", f"/v1/tasks/{TASK}", FakeResp(200, {"status": "RUNNING"}))])
        self.assertEqual(a.poll(task).state, PENDING)
        a = adapter("video.runway_upscale",
                    [("GET", f"/v1/tasks/{TASK}", FakeResp(200, {"status": "SUCCEEDED", "output": [OUT]}))],
                    downloads={OUT: FakeResp(200, content=MP4)})
        result = a.poll(task)
        self.assertEqual(result.state, SUCCEEDED)
        (path,) = a.fetch(result, self.root / "out")
        self.assertEqual((path.name, path.read_bytes()), ("output_0.mp4", MP4))

    def test_a_frame_rate_above_the_priced_one_or_unreadable_is_refused_before_any_call(self):
        for fps in (120.0, 61.0, None):
            a = adapter("video.runway_upscale", upscale_routes(), fps=fps)
            with self.assertRaises(AdapterError) as cm:
                a.submit(self.req(), "magnific_video_upscaler_creative")
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, fps)
            self.assertEqual(a.session.calls, [], fps)
        a = adapter("video.runway_upscale", upscale_routes(), fps=59.94)
        a.submit(self.req(), "magnific_video_upscaler_creative")
        self.assertEqual(len(a.session.calls), 3)

    def test_requests_the_vendor_does_not_take_are_refused_before_any_call(self):
        entry = reg.get(self.ENTRY)
        a = adapter("video.runway_upscale")
        self.assertEqual(a.problems(self.req("720p"), entry), [])
        bad = [self.req("8k"), self.req(None), CapabilityRequest("video_upscale", upscale_target="4k"),
               self.req(media=self.file("source.avi")),
               CapabilityRequest("video_upscale", input_media=(self.file(),), upscale_target="4k",
                                 input_images=(self.file("a.png", PNG),)),
               CapabilityRequest("video_upscale", input_media=(self.file(),), upscale_target="4k", scale=2),
               CapabilityRequest("video_upscale", input_media=(self.file(),), upscale_target="4k",
                                 end_image=self.file("e.png", PNG))]
        for r in bad:
            self.assertTrue(a.problems(r, entry), r)
        for r in (self.req("8k"), self.req(media=self.file("source.avi"))):
            with self.assertRaises(AdapterError) as cm:
                a.submit(r, "magnific_video_upscaler_creative")
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(a.session.calls, [])

    def test_a_file_outside_the_upload_limits_is_refused_before_any_call(self):
        for size in (100, 200 * 1024 * 1024 + 1):
            a = adapter("video.runway_upscale", upscale_routes())
            path = self.file()
            with mock.patch("pathlib.Path.stat", return_value=mock.Mock(st_size=size)):
                with self.assertRaises(AdapterError) as cm:
                    a.submit(self.req(media=path), "magnific_video_upscaler_creative")
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, size)
            self.assertEqual(a.session.calls, [], size)

    def test_a_ticket_that_is_not_usable_fails_before_the_file_leaves(self):
        for ticket in ({**TICKET, "uploadUrl": "http://insecure.example/"}, {**TICKET, "runwayUri": "https://x/y"},
                       {**TICKET, "fields": ["a"]}, {**TICKET, "fields": {"a": 1}}, {}):
            a = adapter("video.runway_upscale", [("POST", "/v1/uploads", FakeResp(200, ticket))])
            with self.assertRaises(AdapterError) as cm:
                a.submit(self.req(), "magnific_video_upscaler_creative")
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, ticket)
            self.assertEqual(len(a.session.calls), 1, ticket)

    def test_a_failed_upload_starts_no_task(self):
        a = adapter("video.runway_upscale", [("POST", "/v1/uploads", FakeResp(200, TICKET)),
                                             ("POST", UPLOAD, FakeResp(403, "<Error>AccessDenied</Error>"))])
        with self.assertRaises(AdapterError):
            a.submit(self.req(), "magnific_video_upscaler_creative")
        self.assertFalse([c for c in a.session.calls if "video_upscale" in c[1]])

    def test_a_vendor_error_is_typed_and_never_carries_the_key(self):
        a = adapter("video.runway_upscale", [
            ("POST", "/v1/uploads", FakeResp(200, TICKET)), ("POST", UPLOAD, FakeResp(204)),
            ("POST", "/v1/video_upscale", FakeResp(402, {"error": f"not enough credits for {KEY}"}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), "magnific_video_upscaler_creative")
        self.assertEqual(cm.exception.code, E_QUOTA)
        self.assertNotIn(KEY, str(cm.exception))
        self.assertNotIn(KEY[:12], cm.exception.message)

    def test_without_a_key_nothing_is_called(self):
        a = adapter("video.runway_upscale", env={})
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), "magnific_video_upscaler_creative")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertEqual(a.session.calls, [])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg + ffprobe")
    def test_the_frame_rate_is_read_from_the_file_itself(self):
        from modules.capabilities.video import video_fps
        from tools.probe_models import probe_video

        clip = probe_video(self.root / "clip.mp4")
        self.assertAlmostEqual(video_fps(str(clip)), 24.0)
        self.assertIsNone(video_fps(self.file("x.mp4", b"not a video at all")))


# ── end frames ───────────────────────────────────────────────────────────────

class EndFrames(Tmp):
    def i2v(self, end=True, **kw):
        return CapabilityRequest("i2v", "slow push in", input_images=(self.file("source.png", PNG),),
                                 end_image=self.file("end.jpg", JPG) if end else None, **kw)

    def test_veo_sends_the_last_frame_beside_the_first(self):
        a = adapter("video.veo", [("POST", ":predictLongRunning",
                                   FakeResp(200, {"name": "models/veo-3.1-generate-preview/operations/op1"}))])
        a.submit(self.i2v(duration_s=8), "veo-3.1-generate-preview")
        inst = a.session.calls[0][2]["json"]["instances"][0]
        self.assertEqual(inst["image"]["mimeType"], "image/png")
        self.assertEqual(inst["lastFrame"]["mimeType"], "image/jpeg")
        self.assertTrue(inst["lastFrame"]["bytesBase64Encoded"])
        a = adapter("video.veo", [("POST", ":predictLongRunning",
                                   FakeResp(200, {"name": "models/veo-3.1-generate-preview/operations/op1"}))])
        a.submit(self.i2v(end=False), "veo-3.1-generate-preview")
        self.assertNotIn("lastFrame", a.session.calls[0][2]["json"]["instances"][0])

    def test_kling_sends_image_tail_as_raw_base64(self):
        a = adapter("video.kling", [("POST", "/v1/videos/image2video",
                                     FakeResp(200, {"code": 0, "data": {"task_id": "t1"}}))])
        a.submit(self.i2v(duration_s=5), "kling-v3")
        body = a.session.calls[0][2]["json"]
        self.assertTrue(body["image_tail"])
        self.assertFalse(body["image_tail"].startswith("data:"))

    def test_luma_sends_end_frame_and_refuses_a_framed_ten_second_clip(self):
        entry = reg.get("luma-ray-3.2")
        a = adapter("video.luma", [("POST", "/generations", FakeResp(200, {"id": "g1"}))])
        self.assertEqual(a.problems(self.i2v(duration_s=5, aspect_ratio="16:9"), entry), [])
        a.submit(self.i2v(duration_s=5), "ray-3.2")
        video = a.session.calls[0][2]["json"]["video"]
        self.assertEqual((video["start_frame"]["media_type"], video["end_frame"]["media_type"]),
                         ("image/png", "image/jpeg"))
        # Luma rejects start/end frames with 10 s: refused here, before the call.
        self.assertTrue(a.problems(self.i2v(duration_s=10), entry))
        self.assertTrue(a.problems(self.i2v(end=False, duration_s=10), entry))

    def test_seedance_marks_both_roles_only_when_there_are_two_pictures(self):
        a = adapter("video.seedance", [("POST", "/contents/generations/tasks", FakeResp(200, {"id": "cgt-1"}))])
        a.submit(self.i2v(duration_s=5), "seedance-1-5-pro-251215")
        content = a.session.calls[0][2]["json"]["content"]
        self.assertEqual([c.get("role") for c in content], [None, "first_frame", "last_frame"])
        a = adapter("video.seedance", [("POST", "/contents/generations/tasks", FakeResp(200, {"id": "cgt-1"}))])
        a.submit(self.i2v(end=False, duration_s=5), "seedance-1-5-pro-251215")
        self.assertEqual([c.get("role") for c in a.session.calls[0][2]["json"]["content"]], [None, None])

    def test_adapters_that_would_drop_it_refuse_an_end_frame(self):
        for key, model in (("video.runway", "runway-gen4.5"), ("video.minimax", "minimax-hailuo-2.3"),
                           ("video.wan", "wan-2.7")):
            entry = reg.get(model)
            self.assertTrue(any("chosen frame" in p for p in adapter(key).problems(self.i2v(duration_s=5), entry)),
                            key)

    def test_only_models_documented_for_it_take_an_end_frame(self):
        takes = {m.id for m in reg.models("i2v") if m.end_frame}
        self.assertEqual(takes, {"veo-3.1", "veo-3.1-fast", "veo-3.1-lite", "kling-v3", "luma-ray-3.2",
                                 "seedance-1.0-pro", "seedance-1.5-pro"})
        # Kling 2.6 takes one only in 1080p silent (pro) mode, which is never sent.
        entry = reg.get("kling-v2.6")
        self.assertTrue(adapter("video.kling").problems(self.i2v(duration_s=5), entry))
        self.assertEqual(adapter("video.kling").problems(self.i2v(duration_s=5), reg.get("kling-v3")), [])


# ── the registry ─────────────────────────────────────────────────────────────

class Registry(unittest.TestCase):
    def doc(self):
        return json.loads(reg.REGISTRY_PATH.read_text())

    def entry(self, mid):
        return next(m for m in self.doc()["models"] if m["id"] == mid)

    def test_the_upscaler_validates_and_is_never_available_from_the_file(self):
        m = reg.get("runway-video-upscale")
        self.assertEqual((m.capabilities, m.adapter, m.vendor_model, m.provider),
                         (("video_upscale",), "video.runway_upscale", "magnific_video_upscaler_creative", "runway"))
        self.assertEqual((m.upscale_targets, m.max_source_seconds, m.output), (("720p", "1k", "2k", "4k"), 30, "video"))
        self.assertEqual(m.raw["pricing"]["unit"], "second")
        self.assertFalse(m.raw["pricing"]["confirmed"])
        self.assertEqual(m.raw["pricing"]["variants"]["by"], "upscale_target")
        self.assertNotIn("availability", m.raw)
        self.assertEqual(m.raw["attribution"]["text"], "Powered by Runway")

    def test_targets_go_with_video_upscale_and_only_with_it(self):
        doc = self.doc()
        up = self.entry("runway-video-upscale")
        broken = {k: v for k, v in up.items() if k != "upscale_targets"}
        self.assertTrue(any("upscale_targets" in e for e in reg.validate({**doc, "models": [broken]})))
        veo = self.entry("veo-3.1")
        self.assertTrue(any("upscale_targets" in e for e in reg.validate({**doc, "models": [dict(veo, upscale_targets=["4k"])]})))
        nolimit = dict(up, limits={"max_prompt_chars": 1000, "max_concurrent_per_org": 1})
        self.assertTrue(any("max_source_seconds" in e for e in reg.validate({**doc, "models": [nolimit]})))
        stray = dict(up, pricing={**up["pricing"], "variants": {"by": "upscale_target", "prices": {"8k": 1}}})
        self.assertTrue(reg.validate({**doc, "models": [stray]}))

    def test_an_end_frame_is_claimed_only_where_the_adapter_sends_it(self):
        doc = self.doc()
        runway = self.entry("runway-gen4.5")
        errs = reg.validate({**doc, "models": [dict(runway, end_frame=True)]})
        self.assertTrue(any("does not send an end frame" in e for e in errs), errs)
        t2i = self.entry("flux-2-pro")
        self.assertTrue(reg.validate({**doc, "models": [dict(t2i, end_frame=True)]}))
        probe_without = dict(self.entry("kling-v2.6"))
        probe_without["probe"] = {**probe_without["probe"], "capability": "i2v", "input_image": "generated",
                                  "end_frame": "generated"}
        self.assertTrue(any("probed with one" in e for e in reg.validate({**doc, "models": [probe_without]})))

    def test_what_is_sold_is_what_the_probe_proves(self):
        for m in reg.models("i2v"):
            if m.end_frame:
                r = m.probe_request(generated_image="/p/first.png", generated_end_image="/p/end.png")
                self.assertEqual((r.capability, r.end_image), ("i2v", "/p/end.png"), m.id)
        r = reg.get("runway-video-upscale").probe_request(generated_video="/p/v.mp4")
        self.assertEqual((r.capability, r.input_media, r.upscale_target, r.prompt), ("video_upscale", ("/p/v.mp4",), "720p", ""))


# ── the adapter seam and the worker ──────────────────────────────────────────

def up_job(**over):
    return job(capability="video_upscale", requested_model="runway-video-upscale", routed_model="runway-video-upscale",
               params={"source_asset_id": SRC, "target_resolution": "2k"}, quantity="13.0000", **over)


def framed_job(model="veo-3.1", **over):
    return job(capability="i2v", requested_model=model, routed_model=model,
               params={"source_asset_id": SRC, "end_asset_id": END, "duration_s": 8}, quantity="8", **over)


def video_source(mime="video/mp4", kind="video"):
    return {"ok": True, "asset_id": SRC, "storage_key": ml.storage_key(SRC), "mime": mime, "kind": kind,
            "variants": ["thumb"], "duration_s": 12.2}


def picture_source(end=True):
    s = {"ok": True, "asset_id": SRC, "storage_key": ml.storage_key(SRC), "mime": "image/png", "kind": "image",
         "variants": ["thumb"]}
    if end:
        s["end_frame"] = {"asset_id": END, "mime": "image/jpeg", "kind": "image", "variants": []}
    return s


class Seam(Tmp):
    def test_a_video_goes_to_the_adapter_as_media_with_its_target(self):
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="video_upscale", model="m",
                                   params={"source_asset_id": SRC, "target_resolution": "4k"},
                                   input_files=(Path("/w/source.mp4"),))
        cr = ca.capability_request(req)
        self.assertEqual((cr.input_media, cr.input_images, cr.upscale_target, cr.scale),
                         (("/w/source.mp4",), (), "4k", None))

    def test_an_end_frame_goes_as_end_image_never_as_a_reference(self):
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="i2v", model="m",
                                   params={"source_asset_id": SRC, "end_asset_id": END, "duration_s": 5},
                                   input_files=(Path("/w/source.png"),), end_file=Path("/w/end.jpg"))
        cr = ca.capability_request(req)
        self.assertEqual((cr.input_images, cr.end_image), (("/w/source.png",), "/w/end.jpg"))

    def test_a_job_with_an_end_frame_never_reaches_a_model_that_would_drop_it(self):
        params = {"source_asset_id": SRC, "end_asset_id": END, "duration_s": 5}
        for model, end_file in (("runway-gen4.5", Path(self.file("end.jpg", JPG))), ("veo-3.1", None)):
            entry = reg.get(model)
            ra = ca.RegistryAdapter(entry, adapter(entry.adapter), sync_store={})
            req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="i2v", model=model, params=params,
                                       input_files=(Path(self.file("source.png", PNG)),), end_file=end_file)
            with self.assertRaises(ca.CreativeAdapterError) as cm:
                ra.submit(req)
            self.assertEqual(cm.exception.code, "bad_request", model)
            self.assertEqual(ra.adapter.session.calls, [], model)

    def test_usage_is_the_quantity_the_database_priced(self):
        ra = ca.RegistryAdapter(reg.get("runway-video-upscale"), adapter("video.runway_upscale"), sync_store={})
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="video_upscale", model="runway-video-upscale",
                                   params={"source_asset_id": SRC, "target_resolution": "2k", "duration_s": 1},
                                   quantity=13.0)
        u = ra.usage(req, 1)
        self.assertEqual((u.provider, u.unit, u.quantity, u.vendor_model),
                         ("runway", "second", 13.0, "magnific_video_upscaler_creative"))


class Worker(Tmp):
    def setUp(self):
        super().setUp()
        self.media = self.root / "media"
        self.media.mkdir()
        self.out = self.root / "jobs"

    def run_job(self, j, source, routes, downloads=None, store=None, fps=30.0):
        q = SourceQueue(j, source=source)
        entry = reg.get(j["requested_model"])
        session = RecordingSession(routes, downloads)
        built = build_adapter(entry.adapter, env=ENV, session=session)
        if hasattr(built, "fps_of"):
            built.fps_of = lambda _p: fps
        ra = ca.RegistryAdapter(entry, built, sync_store={})
        library = cw.Library(store=store, media_root=self.media) if store is not None else None
        w = cw.CreativeWorker(q, lambda m: ra if m == entry.id else None, worker_id="w1", out_dir=self.out,
                              credits=FakeCredits(), enforce=True, sleep=lambda s: None, heartbeat_seconds=0,
                              media_root=self.media, library=library)
        w.run_once()
        return q, session

    def test_an_upscale_runs_end_to_end_into_the_library_as_a_new_version(self):
        put_asset(self.media, SRC, MP4)
        store = FakeStore()
        routes = upscale_routes() + [("GET", f"/v1/tasks/{TASK}", FakeResp(200, {"status": "SUCCEEDED",
                                                                                 "output": [OUT]}))]
        q, session = self.run_job(up_job(), video_source(), routes, downloads={OUT: FakeResp(200, content=MP4)},
                                  store=store)
        self.assertTrue(q.finished["ok"], q.finished)
        upload = [c for c in session.calls if c[1] == UPLOAD][0]
        self.assertEqual(upload[2]["files"]["file"], ("source.mp4", MP4, "video/mp4"))
        start = [c for c in session.calls if c[1].endswith("/v1/video_upscale")][0]
        self.assertEqual(start[2]["json"]["resolution"], "2k")
        self.assertIn(("advance", "submitted", TASK), q.calls)
        (row,) = store.rows
        self.assertEqual((row["org"], row["kind"], row["parent_asset_id"]), (ORG, "video", SRC))
        self.assertEqual(row["provenance"]["source_asset_id"], SRC)
        self.assertEqual(q.costs[0].quantity, 13.0)

    def test_audio_named_as_the_video_is_refused_before_any_call(self):
        put_asset(self.media, SRC, b"ID3\x04" + b"\x00" * 64)
        for source in (video_source("audio/mpeg", "audio"), video_source("video/mp4", "audio"),
                       video_source("audio/mpeg", "video")):
            q, session = self.run_job(up_job(), source, upscale_routes())
            self.assertEqual(session.calls, [], source)
            self.assertEqual(q.finished["error_code"], "source_unavailable", source)
            self.assertNotIn(("advance", "submitting", None), q.calls)

    def test_a_refused_frame_rate_fails_the_job_so_the_hold_is_released(self):
        put_asset(self.media, SRC, MP4)
        q, session = self.run_job(up_job(), video_source(), upscale_routes(), fps=120.0)
        self.assertEqual(session.calls, [])
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "bad_request"))
        self.assertIn("frames a second", q.finished["error"])

    def test_a_vendor_failure_fails_the_job_so_the_hold_is_released(self):
        put_asset(self.media, SRC, MP4)
        routes = upscale_routes() + [("GET", f"/v1/tasks/{TASK}", FakeResp(200, {
            "status": "FAILED", "failureCode": "INPUT_PREPROCESSING.INVALID", "failure": "could not decode"}))]
        q, _ = self.run_job(up_job(), video_source(), routes)
        self.assertFalse(q.finished["ok"])
        self.assertEqual(q.calls[-1][0:2], ("finish", False))

    def test_the_end_frame_is_copied_by_id_and_sent(self):
        put_asset(self.media, SRC, PNG)
        put_asset(self.media, END, JPG)
        store = FakeStore()
        routes = [("POST", ":predictLongRunning", FakeResp(200, {"name": "models/veo-3.1-generate-preview/operations/o"})),
                  ("GET", "/operations/o", FakeResp(200, {"done": True, "response": {"generateVideoResponse": {
                      "generatedSamples": [{"video": {"encodedVideo": base64.b64encode(MP4).decode()}}]}}}))]
        q, session = self.run_job(framed_job(), picture_source(), routes, store=store)
        self.assertTrue(q.finished["ok"], q.finished)
        inst = session.calls[0][2]["json"]["instances"][0]
        self.assertEqual(inst["lastFrame"], {"bytesBase64Encoded": base64.b64encode(JPG).decode(),
                                             "mimeType": "image/jpeg"})
        self.assertEqual(store.rows[0]["provenance"]["end_asset_id"], END)

    def test_an_answer_without_the_end_frame_fails_before_any_call(self):
        # A database without 0052 (or an answer that names another picture):
        # the clip is never made without the ending that was paid for.
        put_asset(self.media, SRC, PNG)
        put_asset(self.media, END, JPG)
        other = dict(picture_source(), end_frame={"asset_id": SRC, "mime": "image/png", "variants": []})
        for source in (picture_source(end=False), other):
            q, session = self.run_job(framed_job(), source, [])
            self.assertEqual(session.calls, [])
            self.assertEqual(q.finished["error_code"], "source_unavailable")


# ── the probe ────────────────────────────────────────────────────────────────

class Probe(Tmp):
    def test_an_upscale_probe_draws_its_own_video_and_skips_without_ffmpeg(self):
        from tools import probe_models

        session = RecordingSession([])
        with mock.patch.object(probe_models.shutil, "which", return_value=None):
            res = probe_models.run_probe(reg.get("runway-video-upscale"), env=ENV, voice_id=None, workdir=self.root,
                                         session=session)
        self.assertEqual(res.code, E_NOT_CONFIGURED)
        self.assertEqual(session.calls, [])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg + ffprobe")
    def test_an_upscale_probe_uploads_the_drawn_pattern(self):
        from tools import probe_models

        routes = upscale_routes() + [("GET", f"/v1/tasks/{TASK}", FakeResp(200, {"status": "SUCCEEDED",
                                                                                 "output": [OUT]}))]
        session = RecordingSession(routes, {OUT: FakeResp(200, content=MP4)})
        res = probe_models.run_probe(reg.get("runway-video-upscale"), env=ENV, voice_id=None, workdir=self.root,
                                     session=session)
        self.assertTrue(res.ok, res.message)
        start = [c for c in session.calls if c[1].endswith("/v1/video_upscale")][0]
        self.assertEqual(start[2]["json"]["resolution"], "720p")

    def test_an_end_frame_probe_ends_on_a_second_drawn_picture(self):
        from tools import probe_models

        routes = [("POST", ":predictLongRunning", FakeResp(200, {"name": "models/veo-3.1-lite-generate-preview/operations/o"})),
                  ("GET", "/operations/o", FakeResp(200, {"done": True, "response": {"generateVideoResponse": {
                      "generatedSamples": [{"video": {"encodedVideo": base64.b64encode(MP4).decode()}}]}}}))]
        session = RecordingSession(routes)
        entry = reg.get("veo-3.1-lite")
        res = probe_models.run_probe(entry, env=ENV, voice_id=None, workdir=self.root, session=session)
        self.assertTrue(res.ok, res.message)
        inst = session.calls[0][2]["json"]["instances"][0]
        self.assertNotEqual(inst["image"]["bytesBase64Encoded"], inst["lastFrame"]["bytesBase64Encoded"])


if __name__ == "__main__":
    unittest.main()
