"""Grok Imagine (xAI, first party): the adapters, the registry entries, and the
rule that none of it is for sale.

The adapters talk to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py):
no network, no key, no spend. The download rules are pinned in
tests/test_safe_fetch.py; here the point is that these adapters USE them.

What would break without these tests:

* a priced setting (resolution, duration, image quality) defaulted instead of
  refused: xAI bills the tier it picks for ``auto`` and the size it picks for
  an omitted resolution;
* a moderation refusal reported as "nothing was bought" when xAI charges it;
* a submit whose answer was lost being treated as "nothing was bought";
* a model whose terms nobody has read becoming sellable.
"""

from __future__ import annotations

import base64
import io
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    I2V,
    PENDING,
    SUCCEEDED,
    T2I,
    T2V,
    AdapterError,
    CapabilityRequest,
    ProviderTask,
)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from modules.capabilities.xai import CHARGED, GrokImageAdapter, GrokVideoAdapter
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url
from tests.test_creative_worker import JOB, ORG

ROOT = Path(__file__).resolve().parent.parent
KEY = "xai-test-NOT-A-REAL-KEY-0123456789abcdef"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
V15, LITE, IMG = "grok-imagine-video-1.5", "grok-imagine-video-1.5-lite", "grok-imagine-image-2.0"
GEN = "/v1/videos/generations"
VIDEOS = "/v1/videos/"
IMAGES = "/v1/images/generations"
VIDEO_IDS = (V15, LITE)


def tearDownModule():
    cleanup_certificate()


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="grok_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        # The base URL carries the API's /v1 prefix, as the real default does.
        self.env = {"XAI_API_KEY": KEY, "XAI_BASE_URL": self.vendor.base_url + "/v1"}

    def video(self, env=None) -> GrokVideoAdapter:
        a = build_adapter("video.xai", env=env or self.env, session=self.vendor.session())
        a.result_hosts = ("localhost",)
        a.result_ports = (None, 443, self.vendor.port)
        return a

    def image(self, env=None) -> GrokImageAdapter:
        return build_adapter("image.xai", env=env or self.env, session=self.vendor.session())

    def frame(self, name="first.png") -> str:
        p = self.tmp / name
        p.write_bytes(png())
        return str(p)


def t2v(**kw) -> CapabilityRequest:
    base = dict(capability=T2V, prompt="a boat at dawn", resolution="480p", duration_s=5)
    return CapabilityRequest(**{**base, **kw})


def t2i(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2I, prompt="a red apple on a white table", quality="low"), **kw})


# ── the registry: dark, gated, unpriced ────────────────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_the_three_models_are_registered_on_their_own_adapters(self):
        for mid in VIDEO_IDS:
            self.assertEqual(self.r[mid].adapter, "video.xai", mid)
            self.assertEqual(self.r[mid].provider, "xai", mid)
        self.assertEqual(self.r[IMG].adapter, "image.xai")

    def test_none_of_them_can_be_sold_until_a_person_has_read_the_xai_terms(self):
        for mid in (*VIDEO_IDS, IMG):
            e = self.r[mid]
            self.assertEqual(e.terms_gate, "terms_review_required", mid)
            self.assertEqual(e.api_exposure, "web_only", mid)
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("NOT read", notes, mid)                    # says what was not read
            self.assertIn("403", notes, mid)                         # and why
            self.assertIn("Gate stays open", notes, mid)

    def test_the_terms_gate_reaches_the_database_row(self):
        # sellable_models() (migration 0035) refuses any row whose spec.terms_gate is non-empty.
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in (*VIDEO_IDS, IMG):
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "terms_review_required", mid)

    def test_no_migration_or_price_file_prices_them(self):
        units = []
        for mid in (*VIDEO_IDS, IMG):
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, e.raw["pricing"]["unit"], k)
                      for k in (e.raw["pricing"].get("variants") or {}).get("prices", {})]
        self.assertTrue(all(u.startswith("model_grok_imagine_") for u in units), units)
        hits = []
        for folder in ("supabase/migrations", "docs", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".md", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row (or any other mention) would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_with_a_source(self):
        for mid in (*VIDEO_IDS, IMG):
            p = self.r[mid].raw["pricing"]
            self.assertFalse(p["confirmed"], mid)
            self.assertTrue(p["source_url"].startswith("https://docs.x.ai/"), mid)
            self.assertEqual(p["as_of"], "2026-10-24", mid)
            self.assertIn("ESTIMATE", p["note"], mid)

    def test_only_the_price_the_docs_state_is_filled_in(self):
        v = self.r[V15].raw["pricing"]["variants"]["prices"]
        self.assertEqual(v, {"480p": 0.08, "720p": None, "1080p": None})       # null = no price read, so not sold
        self.assertEqual(self.r[LITE].raw["pricing"]["variants"]["prices"]["480p"], 0.02)
        self.assertEqual(self.r[IMG].raw["pricing"]["variants"]["prices"], {"low": 0.04, "medium": None})

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        for mid in VIDEO_IDS:
            e = self.r[mid]
            spec = GrokVideoAdapter.SPECS[e.vendor_model]
            self.assertEqual(sorted(e.resolutions), sorted(spec["resolutions"]), mid)
            self.assertTrue(set(e.durations_s) <= set(spec["durations"]), mid)
            self.assertTrue(set(e.aspect_ratios) <= set(GrokVideoAdapter.RATIOS), mid)
        e = self.r[IMG]
        spec = GrokImageAdapter.SPECS[e.vendor_model]
        self.assertEqual(list(spec["sizes"]), list(e.image_sizes))
        self.assertEqual(sorted(spec["qualities"]), sorted(e.qualities))

    def test_video_entries_pin_the_vendors_default_resolution_so_the_database_prices_by_it(self):
        for mid in VIDEO_IDS:
            self.assertEqual(self.r[mid].default_resolution, "480p", mid)
            self.assertEqual(self.r[mid].variants_by, "resolution", mid)

    def test_probes_are_servable_and_cheap(self):
        for mid in VIDEO_IDS:
            req = self.r[mid].probe_request(generated_image="https://probe.invalid/x.png")
            self.assertEqual((req.capability, req.resolution, req.duration_s), (I2V, "480p", 2), mid)
            self.assertIsNone(req.aspect_ratio)                       # i2v keeps the picture's shape
        req = self.r[IMG].probe_request()
        self.assertEqual((req.quality, req.image_size), ("low", "1K"))


# ── video: what is sent ──────────────────────────────────────────────────────────

class GrokVideoSubmitTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", GEN, Resp(200, {"request_id": "d97415a1-5796-b7ec-379f-4e6819e08fdf"}))

    def sent(self):
        (req,) = self.vendor.seen("POST", GEN)
        return req

    def test_text_to_video_sends_every_priced_setting_explicitly(self):
        task = self.video().submit(t2v(end_user="a" * 32), V15)
        self.assertEqual((task.adapter, task.vendor_model, task.task_id),
                         ("video.xai", V15, "d97415a1-5796-b7ec-379f-4e6819e08fdf"))
        req = self.sent()
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.json(), {"model": V15, "duration": 5, "resolution": "480p", "prompt": "a boat at dawn",
                                      "aspect_ratio": "16:9", "user": "a" * 32})

    def test_an_end_user_id_that_is_not_a_plain_token_is_not_sent(self):
        for bad in ("x" * 65, "has space", "a@b.com", "../x", ""):
            self.vendor.requests.clear()
            self.video().submit(t2v(end_user=bad), V15)
            self.assertNotIn("user", self.sent().json(), repr(bad))
        self.vendor.requests.clear()
        self.vendor.on("POST", IMAGES, Resp(200, {"data": [{"b64_json": b64(png())}]}))
        self.image().submit(t2i(end_user="a@b.com"), IMG)
        self.assertNotIn("user", self.vendor.seen("POST", IMAGES)[0].json())

    def test_the_sound_flag_is_sent_only_when_the_job_names_it(self):
        for audio in (None, True, False):
            self.vendor.requests.clear()
            self.video().submit(t2v(audio=audio), LITE)
            body = self.sent().json()
            self.assertEqual("generate_audio" in body, audio is not None)
            if audio is not None:
                self.assertIs(body["generate_audio"], audio)

    def test_picture_to_video_sends_the_picture_and_no_ratio(self):
        self.video().submit(CapabilityRequest(I2V, "", resolution="720p", duration_s=2, input_images=(self.frame(),)), V15)
        body = self.sent().json()
        self.assertNotIn("aspect_ratio", body)
        self.assertNotIn("prompt", body)                                  # optional for i2v
        self.assertTrue(body["image"]["url"].startswith("data:image/png;base64,"))
        self.vendor.requests.clear()
        self.video().submit(CapabilityRequest(I2V, "x", resolution="480p", duration_s=2,
                                              input_images=("https://example.invalid/still.png",)), V15)
        self.assertEqual(self.sent().json()["image"], {"url": "https://example.invalid/still.png"})

    def test_a_ratio_for_picture_to_video_is_refused_not_ignored(self):
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(CapabilityRequest(I2V, "x", aspect_ratio="9:16", resolution="480p", duration_s=2,
                                                  input_images=(self.frame(),)), V15)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_a_setting_the_price_depends_on_is_refused_before_any_call_never_defaulted(self):
        cases = (
            (V15, t2v(resolution=None), "resolution"),              # the vendor's own default is 480p
            (V15, t2v(resolution="4k"), "resolution"),
            (V15, t2v(duration_s=None), "duration"),                # the vendor's own default is 8 s
            (V15, t2v(duration_s=0), "duration"),
            (V15, t2v(duration_s=16), "duration"),
            (V15, t2v(aspect_ratio="7:3"), "aspect ratio"),
            ("grok-imagine-video", t2v(), "not a Grok Imagine video model"),   # classic: not offered here
            ("grok-imagine-video-2", t2v(), "not a Grok Imagine video model"),
            ("", t2v(), "not a Grok Imagine video model"),
            (V15, CapabilityRequest(I2V, "x", resolution="480p", duration_s=2), "first-frame picture"),
            (V15, t2v(input_images=("a.png",)), "does not apply to text-to-video"),
        )
        for model, req, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.video().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_an_unreadable_picture_is_a_refusal_not_a_crash(self):
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(CapabilityRequest(I2V, "x", resolution="480p", duration_s=2,
                                                  input_images=(str(self.tmp / "missing.png"),)), V15)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entry_refuses_what_the_adapter_would_refuse(self):
        entry = reg.get(V15)
        a = self.video()
        self.assertEqual(a.problems(entry.probe_request(generated_image="https://p/x.png"), entry), [])
        self.assertTrue(a.problems(t2v(resolution=None), entry))
        self.assertTrue(a.problems(t2v(duration_s=None), entry))
        self.assertTrue(any("own shape" in p for p in a.problems(
            CapabilityRequest(I2V, "x", aspect_ratio="16:9", resolution="480p", duration_s=2,
                              input_images=("https://p/x.png",)), entry)))

    def test_no_key_is_a_refusal_before_any_call(self):
        a = build_adapter("video.xai", env={"XAI_BASE_URL": self.vendor.base_url + "/v1"}, session=self.vendor.session())
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), V15)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])


class GrokVideoLostAnswerTests(VendorCase):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
        self.assertNotIn(KEY, cm.exception.message)

    def test_a_connection_dropped_after_the_request_arrived_may_have_billed(self):
        self.vendor.on("POST", GEN, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(t2v(), V15)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)
        self.assertEqual(len(self.vendor.seen("POST", GEN)), 1)

    def test_a_read_timeout_may_have_billed(self):
        self.vendor.on("POST", GEN, Resp(200, {"request_id": "late"}, hang_s=1.5))
        a = self.video()
        a.timeout = 0.4
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), V15)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_5xx_may_have_billed(self):
        self.vendor.on("POST", GEN, Resp(503, {"error": "overloaded"}))
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(t2v(), V15)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_request_id_may_have_billed(self):
        for body in ({}, {"request_id": ""}, {"request_id": 7}, {"request_id": "../../v1/files"}, {"request_id": "x" * 300}, [], None):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", GEN, Resp(200, body))
            a = build_adapter("video.xai", env={"XAI_API_KEY": KEY, "XAI_BASE_URL": vendor.base_url + "/v1"},
                              session=vendor.session())
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                a.submit(t2v(), V15)
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_synchronous_moderation_refusal_may_still_be_charged_and_says_so(self):
        for path, make in ((GEN, lambda: self.video().submit(t2v(), V15)), (IMAGES, lambda: self.image().submit(t2i(), IMG))):
            vendor_body = {"code": "Client specified an invalid argument", "error": "Generated content violates our usage guidelines (safety, moderation)"}
            self.vendor._routes.clear()
            self.vendor.on("POST", path, Resp(400, vendor_body))
            with self.assertRaises(AdapterError, msg=path) as cm:
                make()
            self.assertEqual(cm.exception.code, E_POLICY, path)
            self.assertTrue(cm.exception.message.startswith(CHARGED), cm.exception.message)
            self.assertFalse(cm.exception.not_accepted)             # not proof that nothing was taken
            self.assertEqual(cm.exception.message.count(CHARGED), 1)
        # an ordinary 400 about the request is not dressed up as a charged refusal
        self.vendor._routes.clear()
        self.vendor.on("POST", GEN, Resp(400, {"error": "duration must be between 1 and 15"}))
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(t2v(), V15)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertNotIn("CHARGE", cm.exception.message)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.video({"XAI_API_KEY": KEY, "XAI_BASE_URL": closed_port_url() + "/v1"})
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), V15)
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_outright_refusals_are_proof_and_say_the_right_remedy(self):
        cases = ((401, {"error": "Incorrect API key provided"}, E_AUTH),
                 (402, {"error": "no credits"}, E_QUOTA),
                 (429, {"error": "Too many requests, slow down"}, E_RATE_LIMITED),
                 (404, {"error": "The model does not exist"}, E_NOT_FOUND))
        for status, body, want in cases:
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", GEN, Resp(status, body))
            a = build_adapter("video.xai", env={"XAI_API_KEY": KEY, "XAI_BASE_URL": vendor.base_url + "/v1"},
                              session=vendor.session())
            with self.assertRaises(AdapterError, msg=status) as cm:
                a.submit(t2v(), V15)
            self.assertEqual(cm.exception.code, want, status)
            self.assertTrue(cm.exception.not_accepted, status)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, status)

    def test_the_creative_bridge_keeps_the_difference(self):
        entry = reg.get(V15)

        def bridged(env):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=self.vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2v", model=entry.id,
                                                  params=dict(prompt="a boat", duration_s=5, resolution="480p"),
                                                  input_files=()))
        with self.assertRaises(ca.CreativeAdapterError) as cm:           # the job carries no resolution: not quoted
            ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=self.env, session=self.vendor.session()),
                               sync_store={}).submit(cw.GenerationRequest(
                job_id=JOB, org_id=ORG, capability="t2v", model=entry.id, params=dict(prompt="a boat", duration_s=5),
                input_files=()))
        self.assertIn("no resolution", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])
        self.vendor.on("POST", GEN, Resp(drop=True))
        with self.assertRaises(AdapterError) as lost:
            bridged(self.env)
        self.assertFalse(lost.exception.not_accepted)            # the worker must not move this job to another model
        refused = FakeVendor()
        self.addCleanup(refused.close)
        refused.on("POST", GEN, Resp(401, {"error": "bad key"}))
        with self.assertRaises(AdapterError) as no:
            bridged({"XAI_API_KEY": KEY, "XAI_BASE_URL": refused.base_url + "/v1"})
        self.assertTrue(no.exception.not_accepted)


# ── video: polling and the result ────────────────────────────────────────────────

class GrokVideoPollTests(VendorCase):
    def status(self, body, rid="req-1", code=200):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", VIDEOS + rid, Resp(code, body))
        return self.video().poll(ProviderTask("video.xai", V15, rid))

    def test_pending_is_pending_and_polling_sends_the_key_only_to_the_api(self):
        self.assertEqual(self.status({"status": "pending", "progress": 40}).state, PENDING)
        (req,) = self.vendor.seen("GET", VIDEOS)
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(self.vendor.seen("POST", ""), [])               # polling never submits

    def test_done_hands_back_the_clip_link(self):
        res = self.status({"status": "done", "video": {"url": f"{self.vendor.base_url}/clip.mp4", "duration": 5,
                                                         "respect_moderation": True}, "model": V15})
        self.assertEqual(res.state, SUCCEEDED)
        self.assertEqual(res.outputs[0].mime, "video/mp4")

    def test_a_filtered_video_is_a_policy_failure_that_says_it_was_still_charged(self):
        res = self.status({"status": "done", "video": {"url": "", "duration": 5, "respect_moderation": False}})
        self.assertEqual((res.state, res.error.code), (FAILED, E_POLICY))
        self.assertTrue(res.error.message.startswith(CHARGED), res.error.message)
        self.assertFalse(res.error.not_accepted)

    def test_every_policy_path_carries_the_may_still_be_charged_warning(self):
        # 1. a failed job whose invalid_argument is a moderation block
        res = self.status({"status": "failed", "error": {"code": "invalid_argument", "message": "content blocked by moderation"}})
        self.assertEqual(res.error.code, E_POLICY)
        self.assertTrue(res.error.message.startswith(CHARGED), res.error.message)
        # 2. an invalid_argument that is NOT a policy block is an ordinary bad request, with no such warning
        res = self.status({"status": "failed", "error": {"code": "invalid_argument", "message": "Prompt cannot be empty."}})
        self.assertEqual(res.error.code, E_BAD_REQUEST)
        self.assertNotIn("CHARGE", res.error.message)

    def test_done_without_a_link_or_with_a_foreign_one_is_an_error(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"status": "done", "video": {"respect_moderation": True}})
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        for url in ("https://attacker.example/clip.mp4", "http://vidgen.x.ai/clip.mp4", "https://x.ai.evil.io/c.mp4",
                    "https://evilx.ai/c.mp4"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status({"status": "done", "video": {"url": url, "respect_moderation": True}})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)    # xAI said done: it may be billed

    def test_failed_carries_the_vendors_code_and_the_right_remedy(self):
        cases = (("invalid_argument", "Prompt cannot be empty.", E_BAD_REQUEST),
                 ("invalid_argument", "content blocked by moderation", E_POLICY),
                 ("failed_precondition", "resolution not available", E_BAD_REQUEST),
                 ("permission_denied", "team lacks access", E_AUTH),
                 ("service_unavailable", "overloaded", E_UNAVAILABLE),
                 ("internal_error", "oops", E_UNAVAILABLE),
                 ("brand_new_code", "?", E_UNAVAILABLE))
        for code, message, want in cases:
            res = self.status({"status": "failed", "error": {"code": code, "message": message}})
            self.assertEqual((res.state, res.error.code), (FAILED, want), (code, message))
        self.assertEqual(self.status({"status": "failed"}).error.code, E_UNAVAILABLE)

    def test_expired_is_a_failure_a_status_we_do_not_know_is_pending(self):
        res = self.status({"status": "expired"})
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))
        self.assertEqual(self.status({"status": "reticulating"}).state, PENDING)

    def test_a_key_the_vendor_echoes_in_a_failure_is_scrubbed(self):
        res = self.status({"status": "failed", "error": {"code": "internal_error", "message": f"token {KEY} rejected"}})
        self.assertNotIn(KEY, res.error.message)

    def test_a_request_id_that_could_steer_the_request_is_refused(self):
        for rid in ("../../v1/files", "a/b", "a?b=c", "", "x" * 300):
            with self.assertRaises(AdapterError, msg=repr(rid)) as cm:
                self.video().poll(ProviderTask("video.xai", V15, rid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_is_typed(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"error": "not found"}, code=404)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        with self.assertRaises(AdapterError) as cm:
            self.status({"error": "bad gateway"}, code=502)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)             # the job is still xAI's: poll again


class GrokVideoEndToEndTests(VendorCase):
    """submit -> poll (pending, then done) -> fetch through the probe runner."""

    def run_probe(self, polls, *, entry_id=LITE, timeout_s=600):
        from tools.probe_models import run_probe

        self.vendor.on("POST", GEN, Resp(200, {"request_id": "req-9"}))
        self.vendor.on("GET", VIDEOS + "req-9", polls)
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4))
        clock = {"t": 0.0}
        with mock.patch.object(GrokVideoAdapter, "result_hosts", ("localhost",)), \
                mock.patch.object(GrokVideoAdapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(entry_id), env=self.env, voice_id=None, workdir=self.tmp, timeout_s=timeout_s,
                             poll_every_s=5, session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def test_the_probe_runs_the_whole_chain_and_stores_a_real_clip(self):
        done = Resp(200, {"status": "done", "video": {"url": f"{self.vendor.base_url}/clip.mp4", "respect_moderation": True}})
        res = self.run_probe([Resp(200, {"status": "pending"}), Resp(200, {"status": "pending"}), done])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(MP4))
        body = self.vendor.seen("POST", GEN)[0].json()
        self.assertEqual((body["model"], body["resolution"], body["duration"]), (LITE, "480p", 2))
        self.assertTrue(body["image"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(len(self.vendor.seen("POST", GEN)), 1)         # polling never re-submitted

    def test_a_job_that_never_finishes_ends_as_a_timeout_that_names_the_request(self):
        res = self.run_probe([Resp(200, {"status": "pending"})], timeout_s=30)
        self.assertFalse(res.ok)
        self.assertEqual((res.code, res.task_id), ("timeout", "req-9"))  # it may still bill: the id is kept
        self.assertEqual(len(self.vendor.seen("POST", GEN)), 1)

    def test_an_expired_clip_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        gone = Resp(200, {"status": "done", "video": {"url": f"{self.vendor.base_url}/expired.mp4", "respect_moderation": True}})
        self.vendor.on("GET", "/expired.mp4", Resp(403, {"error": "signature expired"}))
        res = self.run_probe([gone])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_NOT_FOUND)
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)

    def test_a_link_xai_cannot_serve_is_a_failed_probe_not_a_hang(self):
        gone = Resp(200, {"status": "done", "video": {"url": f"{self.vendor.base_url}/missing.mp4", "respect_moderation": True}})
        res = self.run_probe([gone])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_NOT_FOUND)


# ── image ─────────────────────────────────────────────────────────────────────────

class GrokImageTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", IMAGES, Resp(200, {"data": [{"b64_json": b64(png()), "mime_type": "image/png"}],
                                                    "usage": {"cost_in_usd_ticks": 400000000}}))

    def sent(self):
        (req,) = self.vendor.seen("POST", IMAGES)
        return req

    def test_the_tier_and_size_are_always_sent_and_the_image_comes_back_inline(self):
        a = self.image()
        task = a.submit(t2i(aspect_ratio="16:9", image_size="1K", end_user="b" * 32), IMG)
        self.assertIsNone(task.task_id)                                  # synchronous: finished inside submit
        req = self.sent()
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.json(), {"model": IMG, "prompt": "a red apple on a white table", "n": 1, "quality": "low",
                                      "resolution": "1k", "response_format": "b64_json", "aspect_ratio": "16:9",
                                      "user": "b" * 32})
        (path,) = a.fetch(a.poll(task), self.tmp, stem="img")
        self.assertEqual(path.suffix, ".png")
        self.assertEqual(path.read_bytes(), png())

    def test_no_aspect_ratio_leaves_the_vendors_auto_and_medium_is_passed_as_chosen(self):
        self.image().submit(t2i(quality="medium"), IMG)
        body = self.sent().json()
        self.assertNotIn("aspect_ratio", body)
        self.assertEqual(body["quality"], "medium")

    def test_a_tier_or_size_that_is_not_offered_is_refused_before_any_call_never_defaulted(self):
        cases = ((t2i(quality=None), IMG, "quality"),                   # 'auto' bills whatever tier xAI picks
                 (t2i(quality="auto"), IMG, "quality auto"),
                 (t2i(quality="high"), IMG, "quality high"),
                 (t2i(image_size="2K"), IMG, "image size 2K"),          # priced apart, not offered
                 (t2i(aspect_ratio="19.5:9"), IMG, "aspect ratio"),
                 (t2i(), "grok-imagine-image", "not a Grok Imagine image model"),
                 (t2i(), "grok-imagine-image-quality", "not a Grok Imagine image model"),
                 (t2i(), "", "not a Grok Imagine image model"),
                 (CapabilityRequest("edit", "x", quality="low", input_images=("a.png",)), IMG, "text-to-image only"))
        for req, model, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.image().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
            self.assertTrue(cm.exception.not_accepted)
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entry_refuses_the_same(self):
        entry = reg.get(IMG)
        a = self.image()
        self.assertEqual(a.problems(entry.probe_request(), entry), [])
        self.assertTrue(a.problems(t2i(quality=None), entry))
        self.assertTrue(a.problems(t2i(image_size="2K"), entry))

    def test_an_answer_that_is_not_a_picture_may_have_billed(self):
        for body in ({"data": []}, {"data": [{}]}, {"data": [{"b64_json": ""}]}, {"data": [{"b64_json": b64(b"<html>no</html>")}]},
                     {"data": [{"url": "https://x.ai/i.png"}]}, [], {}):
            self.vendor._routes.clear()
            self.vendor.on("POST", IMAGES, Resp(200, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.image().submit(t2i(), IMG)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertFalse(cm.exception.not_accepted)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))

    def test_a_lost_answer_may_have_billed_and_a_refusal_did_not(self):
        self.vendor._routes.clear()
        self.vendor.on("POST", IMAGES, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.image().submit(t2i(), IMG)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))
        self.vendor._routes.clear()
        self.vendor.on("POST", IMAGES, Resp(401, {"error": "bad key"}))
        with self.assertRaises(AdapterError) as cm:
            self.image().submit(t2i(), IMG)
        self.assertEqual(cm.exception.code, E_AUTH)
        self.assertTrue(cm.exception.not_accepted)

    def test_the_probe_stores_a_real_image(self):
        from tools.probe_models import run_probe

        res = run_probe(reg.get(IMG), env=self.env, voice_id=None, workdir=self.tmp, session=self.vendor.session(),
                        sleep=lambda s: None)
        self.assertTrue(res.ok, res.message)
        body = self.sent().json()
        self.assertEqual((body["quality"], body["resolution"], body["aspect_ratio"]), ("low", "1k", "1:1"))


class WiringTests(unittest.TestCase):
    def test_results_come_only_from_xai_hosts_and_only_tests_widen_the_port(self):
        self.assertEqual(GrokVideoAdapter.result_hosts, ("x.ai",))
        self.assertEqual(GrokVideoAdapter.result_ports, (None, 443))

    def test_the_key_is_one_the_worker_can_be_given(self):
        text = (ROOT / "deploy" / ".env.worker.example").read_text()
        self.assertRegex(text, r"(?m)^XAI_API_KEY=$")                    # empty in the example, never a value
        self.assertIn("WORKERENV_XAI_API_KEY: ${{ secrets.XAI_API_KEY }}",
                      (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text())
        self.assertIn("XAI_API_KEY: ${{ secrets.XAI_API_KEY }}",
                      (ROOT / ".github" / "workflows" / "probe_models.yml").read_text())


if __name__ == "__main__":
    unittest.main()
