"""Seedance 2.0 / 2.5 and Seedream (BytePlus ModelArk): the adapters, the registry
entries, and the rule that none of it is for sale.

The adapters talk to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py):
no network, no key, no spend. The download rules themselves are pinned in
tests/test_safe_fetch.py; here the point is that these adapters USE them.

What would break without these tests:

* a priced setting (resolution, duration, size) defaulted instead of refused;
* a Seedance 2.5 picture-to-video that names an aspect ratio the vendor then
  rejects asynchronously, after the job was accepted;
* a submit whose answer was lost being treated as "nothing was bought";
* a model that BytePlus has not authorised us to resell becoming sellable.
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
from modules.capabilities.image import SeedreamAdapter
from modules.capabilities.modelark import map_code
from modules.capabilities.safe_fetch import UNCONFIRMED
from modules.capabilities.video import SeedanceV2Adapter
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url
from tests.test_creative_worker import JOB, ORG

ROOT = Path(__file__).resolve().parent.parent
KEY = "ark-test-NOT-A-REAL-KEY-0123456789abcdef"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
V20, V25 = "dreamina-seedance-2-0-260128", "dreamina-seedance-2-5-260628"
TASKS = "/api/v3/contents/generations/tasks"
IMAGES = "/api/v3/images/generations"
VIDEO_IDS = ("seedance-2.0", "seedance-2.5")
IMAGE_IDS = ("seedream-5.0-pro", "seedream-5.0-flash", "seedream-4.5")


def tearDownModule():
    cleanup_certificate()


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def jpeg() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (30, 30, 200)).save(buf, "JPEG")
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class VendorCase(unittest.TestCase):
    """One loopback vendor per test; ``env`` points the adapter at it."""

    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="seedance_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.env = {"SEEDANCE_API_KEY": KEY, "SEEDANCE_BASE_URL": self.vendor.base_url,
                    "SEEDREAM_BASE_URL": self.vendor.base_url}

    def video(self, **env) -> SeedanceV2Adapter:
        a = build_adapter("video.seedance2", env={**self.env, **env}, session=self.vendor.session())
        a.result_hosts = ("localhost",)
        a.result_ports = (None, 443, self.vendor.port)
        return a

    def image(self, **env) -> SeedreamAdapter:
        return build_adapter("image.seedream", env={**self.env, **env}, session=self.vendor.session())

    def frame(self, name="first.png") -> str:
        p = self.tmp / name
        p.write_bytes(png())
        return str(p)


def t2v(**kw) -> CapabilityRequest:
    base = dict(capability=T2V, prompt="a boat at dawn", resolution="720p", duration_s=5)
    return CapabilityRequest(**{**base, **kw})


# ── the registry: dark, gated, unpriced ────────────────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_all_five_models_are_registered_on_their_own_adapters(self):
        for mid in VIDEO_IDS:
            self.assertEqual(self.r[mid].adapter, "video.seedance2", mid)
        for mid in IMAGE_IDS:
            self.assertEqual(self.r[mid].adapter, "image.seedream", mid)

    def test_none_of_them_can_be_sold_until_bytedance_agrees_in_writing(self):
        for mid in (*VIDEO_IDS, *IMAGE_IDS):
            e = self.r[mid]
            self.assertEqual(e.terms_gate, "written_consent_required", mid)
            self.assertEqual(e.api_exposure, "web_only", mid)       # not on the public API either
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("6.2(1)", notes, mid)                      # Customer Agreement: no reseller / MaaS without consent
            self.assertIn("NOT seen", notes, mid)                    # says what was not read
            self.assertIn("Gate stays open", notes, mid)

    def test_video_notes_quote_the_platform_customer_clause(self):
        for mid in VIDEO_IDS:
            notes = " ".join(self.r[mid].raw["terms_notes"])
            self.assertIn("4.2.3", notes, mid)
            self.assertIn("AI content creation tools", notes, mid)

    def test_the_terms_gate_reaches_the_database_row(self):
        # sellable_models() (migration 0035) refuses any row whose spec.terms_gate is non-empty.
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in (*VIDEO_IDS, *IMAGE_IDS):
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "written_consent_required", mid)

    def test_no_migration_or_price_file_prices_them(self):
        # "Sellable" needs a positive credit_prices row. None may exist for these units.
        units = []
        for mid in (*VIDEO_IDS, *IMAGE_IDS):
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, e.raw["pricing"]["unit"], k)
                      for k in (e.raw["pricing"].get("variants") or {}).get("prices", {})]
        self.assertTrue(all(u.startswith(("model_seedance_2_", "model_seedream_")) for u in units), units)
        hits = []
        for folder in ("supabase/migrations", "docs", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".md", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row (or any other mention) would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_with_a_source(self):
        for mid in (*VIDEO_IDS, *IMAGE_IDS):
            p = self.r[mid].raw["pricing"]
            self.assertFalse(p["confirmed"], mid)
            self.assertTrue(p["source_url"].startswith("https://docs.byteplus.com/"), mid)
            self.assertEqual(p["as_of"], "2026-10-24", mid)
            self.assertIn("ESTIMATE", p["note"], mid)

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        for mid, vendor in zip(VIDEO_IDS, (V20, V25)):
            e = self.r[mid]
            spec = SeedanceV2Adapter.SPECS[e.vendor_model]
            self.assertEqual(e.vendor_model, vendor)
            self.assertEqual(sorted(e.resolutions), sorted(spec["resolutions"]), mid)
            self.assertTrue(set(e.durations_s) <= set(spec["durations"]), mid)
            self.assertEqual(sorted(e.raw["pricing"]["variants"]["prices"]), sorted(e.resolutions), mid)
            self.assertIn(e.default_resolution, e.resolutions)
        for mid in IMAGE_IDS:
            e = self.r[mid]
            sizes = SeedreamAdapter.SIZES[e.vendor_model]
            self.assertEqual(list(sizes), list(e.image_sizes), mid)
            self.assertEqual(sorted(sizes[e.image_sizes[0]]), sorted(e.aspect_ratios), mid)

    def test_seedream_offers_only_the_size_whose_price_the_docs_state(self):
        # 5.0 pro costs double above 2.61 M pixels: 1K and 1.5K are the same price, 2K is not offered.
        self.assertEqual(self.r["seedream-5.0-pro"].image_sizes, ("1K",))
        self.assertEqual(self.r["seedream-4.5"].image_sizes, ("2K",))
        for sizes in SeedreamAdapter.SIZES.values():
            for table in sizes.values():
                for wh in table.values():
                    w, h = map(int, wh.split("x"))
                    self.assertGreaterEqual(w * h, 921_600)           # 5.0's explicit-size floor

    def test_seedance_2_0_does_not_offer_4k(self):
        self.assertNotIn("4k", self.r["seedance-2.0"].resolutions)

    def test_probe_requests_are_servable_and_cheap(self):
        for mid in VIDEO_IDS:
            req = self.r[mid].probe_request(generated_image="https://probe.invalid/x.png",
                                            generated_end_image="https://probe.invalid/e.png")
            self.assertEqual((req.resolution, req.duration_s), ("480p", 4), mid)   # the cheapest the model takes
            self.assertEqual(req.capability, I2V)
        self.assertIsNone(self.r["seedance-2.5"].probe_request(generated_image="https://p/x.png",
                                                              generated_end_image="https://p/e.png").aspect_ratio)


# ── Seedance 2.x: what is sent ───────────────────────────────────────────────

class SeedanceSubmitTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", TASKS, Resp(200, {"id": "cgt-20261024-abc"}))

    def sent(self):
        (req,) = self.vendor.seen("POST", TASKS)
        return req

    def test_text_to_video_sends_every_priced_setting_explicitly(self):
        task = self.video().submit(t2v(end_user="a" * 32), V20)
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("video.seedance2", V20, "cgt-20261024-abc"))
        req = self.sent()
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        body = req.json()
        self.assertEqual(body, {"model": V20, "content": [{"type": "text", "text": "a boat at dawn"}],
                                "resolution": "720p", "ratio": "16:9", "duration": 5,
                                "execution_expires_after": 3600, "safety_identifier": "a" * 32})
        self.assertNotIn("watermark", body)                       # the vendor's own default
        self.assertNotEqual(body["duration"], -1)                 # "the model picks" would be a price we cannot quote

    def test_the_sound_flag_is_sent_only_when_the_job_names_it(self):
        for audio, expect in ((None, False), (True, True), (False, True)):
            self.vendor.requests.clear()
            self.video().submit(t2v(audio=audio), V25)
            body = self.sent().json()
            self.assertEqual("generate_audio" in body, expect)
            if audio is not None:
                self.assertIs(body["generate_audio"], audio)

    def test_a_task_that_is_still_queued_is_ended_by_the_vendor_within_the_hour(self):
        self.video().submit(t2v(), V20)
        self.assertEqual(self.sent().json()["execution_expires_after"], 3600)   # the API's minimum; the default is 48 h

    def test_an_end_user_id_that_is_not_the_vendors_shape_is_not_sent(self):
        self.video().submit(t2v(end_user="x" * 65), V20)
        self.assertNotIn("safety_identifier", self.sent().json())

    def test_2_0_picture_to_video_follows_the_picture_unless_a_ratio_is_named(self):
        first, last = self.frame("a.png"), self.frame("b.png")
        self.video().submit(CapabilityRequest(I2V, "slow push in", resolution="480p", duration_s=4,
                                              input_images=(first,), end_image=last), V20)
        body = self.sent().json()
        self.assertEqual(body["ratio"], "adaptive")
        self.assertEqual([c["type"] for c in body["content"]], ["text", "image_url", "image_url"])
        self.assertEqual([c.get("role") for c in body["content"][1:]], ["first_frame", "last_frame"])
        self.assertTrue(body["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.vendor.requests.clear()
        self.video().submit(CapabilityRequest(I2V, "x", aspect_ratio="9:16", resolution="480p", duration_s=4,
                                              input_images=(first,)), V20)
        self.assertEqual(self.sent().json()["ratio"], "9:16")

    def test_2_5_picture_to_video_is_always_adaptive_and_a_ratio_is_refused_not_ignored(self):
        first = self.frame()
        self.video().submit(CapabilityRequest(I2V, "", resolution="480p", duration_s=4, input_images=(first,)), V25)
        body = self.sent().json()
        self.assertEqual(body["ratio"], "adaptive")
        self.assertEqual([c["type"] for c in body["content"]], ["image_url"])        # no empty text item
        self.assertEqual(body["content"][0]["role"], "first_frame")                 # 2.5 reads the task type from it
        self.vendor.requests.clear()
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(CapabilityRequest(I2V, "x", aspect_ratio="16:9", resolution="480p", duration_s=4,
                                                  input_images=(first,)), V25)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_2_5_text_to_video_may_still_name_a_ratio(self):
        self.video().submit(t2v(aspect_ratio="9:16", duration_s=30), V25)
        self.assertEqual(self.sent().json()["ratio"], "9:16")
        self.assertEqual(self.sent().json()["duration"], 30)

    def test_a_setting_the_price_depends_on_is_refused_before_any_call_never_defaulted(self):
        cases = (
            (V20, t2v(resolution=None), "resolution"),
            (V20, t2v(resolution="4k"), "resolution"),                  # exists at the vendor, not offered here
            (V20, t2v(resolution="2160p"), "resolution"),
            (V20, t2v(duration_s=None), "duration"),
            (V20, t2v(duration_s=3), "duration"),                       # below the 2.0 minimum of 4 s
            (V20, t2v(duration_s=16), "duration"),                      # above 2.0's 15 s
            (V25, t2v(duration_s=31), "duration"),
            (V25, t2v(duration_s=-1), "duration"),                      # "the model decides the length"
            ("dreamina-seedance-2-0-fast-260128", t2v(), "not a Seedance 2.x model"),
            ("seedance-1-5-pro-251215", t2v(), "not a Seedance 2.x model"),
            ("", t2v(), "not a Seedance 2.x model"),
            (V20, CapabilityRequest(I2V, "x", resolution="480p", duration_s=4), "first-frame picture"),
            (V20, t2v(input_images=("a.png",)), "does not apply to text-to-video"),
            (V20, t2v(aspect_ratio="5:4"), "aspect ratio 5:4"),
            (V20, t2v(aspect_ratio="adaptive"), "aspect ratio adaptive"),   # sent by the adapter itself, never by a job
        )
        for model, req, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.video().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))     # nothing left this process
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_nothing_to_generate_from_is_refused(self):
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(t2v(prompt="   "), V20)
        self.assertIn("nothing to generate", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_an_unreadable_picture_is_a_refusal_not_a_crash(self):
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(CapabilityRequest(I2V, "x", resolution="480p", duration_s=4,
                                                  input_images=(str(self.tmp / "missing.png"),)), V20)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.vendor.requests, [])

    def test_a_picture_over_20_mb_is_refused_before_it_is_encoded_into_the_request(self):
        big = self.tmp / "big.png"
        with open(big, "wb") as fh:
            fh.truncate(21 * 1024 * 1024)                    # sparse: no disk is spent
        req = CapabilityRequest(I2V, "x", resolution="480p", duration_s=4, input_images=(str(big),))
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(req, V20)
        self.assertIn("20 MB", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entry_refuses_what_the_adapter_would_refuse(self):
        entry = reg.get("seedance-2.5")
        a = self.video()
        self.assertEqual(a.problems(entry.probe_request(generated_image="https://p/x.png",
                                                       generated_end_image="https://p/e.png"), entry), [])
        bad = CapabilityRequest(I2V, "x", aspect_ratio="16:9", resolution="480p", duration_s=4,
                                input_images=("https://p/x.png",))
        self.assertTrue(any("first frame" in p for p in a.problems(bad, entry)))
        self.assertTrue(a.problems(t2v(resolution=None), entry))
        self.assertTrue(a.problems(t2v(duration_s=None), entry))

    def test_no_key_is_a_refusal_before_any_call(self):
        a = build_adapter("video.seedance2", env={"SEEDANCE_BASE_URL": self.vendor.base_url}, session=self.vendor.session())
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), V20)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_the_same_modelark_key_works_under_either_name(self):
        a = build_adapter("video.seedance2", env={"ARK_API_KEY": KEY, "SEEDANCE_BASE_URL": self.vendor.base_url},
                          session=self.vendor.session())
        a.submit(t2v(), V20)
        self.assertEqual(self.sent().headers["authorization"], f"Bearer {KEY}")


# ── Seedance 2.x: the lost answer ────────────────────────────────────────────

class SeedanceLostAnswerTests(VendorCase):
    def submit(self, **kw):
        return self.video(**kw).submit(t2v(), V20)

    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
        self.assertNotIn(KEY, cm.exception.message)

    def test_a_connection_dropped_after_the_request_arrived_may_have_billed(self):
        self.vendor.on("POST", TASKS, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.submit()
        self.assertUnconfirmed(cm, E_UNAVAILABLE)
        self.assertEqual(len(self.vendor.seen("POST", TASKS)), 1)         # it did arrive, and is not sent again

    def test_a_read_timeout_may_have_billed(self):
        self.vendor.on("POST", TASKS, Resp(200, {"id": "late"}, hang_s=1.5))
        a = self.video()
        a.timeout = 0.4
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), V20)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_5xx_may_have_billed(self):
        self.vendor.on("POST", TASKS, Resp(502, {"error": {"code": "InternalServiceError", "message": "bad gateway"}}))
        with self.assertRaises(AdapterError) as cm:
            self.submit()
        self.assertUnconfirmed(cm, E_UNAVAILABLE)
        self.assertTrue(cm.exception.retryable)

    def test_a_2xx_without_a_usable_task_id_may_have_billed(self):
        for body in ({}, {"id": ""}, {"id": 12}, {"id": "../etc/passwd"}, {"id": "x" * 300}, ["id"], None):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", TASKS, Resp(200, body))
            a = build_adapter("video.seedance2", env={"SEEDANCE_API_KEY": KEY, "SEEDANCE_BASE_URL": vendor.base_url},
                              session=vendor.session())
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                a.submit(t2v(), V20)
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_2xx_that_is_not_json_may_have_billed(self):
        self.vendor.on("POST", TASKS, Resp(200, raw=b"<html>gateway</html>"))
        with self.assertRaises(AdapterError) as cm:
            self.submit()
        self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        with self.assertRaises(AdapterError) as cm:
            self.submit(SEEDANCE_BASE_URL=closed_port_url())
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_the_creative_bridge_keeps_the_difference(self):
        entry = reg.get("seedance-2.0")
        job = dict(prompt="a boat", duration_s=5, resolution="720p")

        def bridged(env):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=self.vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2v", model=entry.id,
                                                  params=job, input_files=()))
        self.vendor.on("POST", TASKS, Resp(drop=True))
        with self.assertRaises(AdapterError) as lost:
            bridged(self.env)
        self.assertFalse(lost.exception.not_accepted)             # the worker must not move this job to another model
        refused = FakeVendor()
        self.addCleanup(refused.close)
        refused.on("POST", TASKS, Resp(401, {"error": {"code": "AuthenticationError", "message": "bad key"}}))
        with self.assertRaises(AdapterError) as no:
            bridged({"SEEDANCE_API_KEY": KEY, "SEEDANCE_BASE_URL": refused.base_url})
        self.assertTrue(no.exception.not_accepted)
        self.assertEqual(no.exception.code, E_AUTH)


class ModelArkErrorTests(VendorCase):
    def test_same_http_status_opposite_remedies(self):
        cases = (
            (401, "AuthenticationError", E_AUTH, True),
            (403, "AccessDenied", E_AUTH, True),
            (403, "AccountOverdueError", E_QUOTA, True),                 # top up, do not replace the key
            (403, "OperationDenied.ServiceOverdue", E_QUOTA, True),
            (404, "ModelNotOpen", E_NOT_FOUND, True),                    # activate the model in the console
            (404, "InvalidEndpointOrModel.NotFound", E_NOT_FOUND, True),
            (429, "RateLimitExceeded.EndpointRPMExceeded", E_RATE_LIMITED, True),
            (429, "ModelAccountRpmRateLimitExceeded", E_RATE_LIMITED, True),
            (429, "ServerOverloaded", E_RATE_LIMITED, True),
            (429, "QuotaExceeded", E_QUOTA, True),
            (400, "InputImageSensitiveContentDetected.PrivacyInformation", E_POLICY, False),   # a real face
            (400, "InputTextSensitiveContentDetected", E_POLICY, False),
            (400, "InvalidParameter.TaskTypeConstraint", E_BAD_REQUEST, False),
        )
        for status, code, want, not_accepted in cases:
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", TASKS, Resp(status, {"error": {"code": code, "message": f"{code} happened"}}))
            a = build_adapter("video.seedance2", env={"SEEDANCE_API_KEY": KEY, "SEEDANCE_BASE_URL": vendor.base_url},
                              session=vendor.session())
            with self.assertRaises(AdapterError, msg=code) as cm:
                a.submit(t2v(), V20)
            self.assertEqual(cm.exception.code, want, code)
            self.assertEqual(cm.exception.not_accepted, not_accepted, code)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, code)

    def test_unknown_codes_fall_back_to_the_status_never_to_success(self):
        self.assertIsNone(map_code("SomethingNew"))
        self.assertIsNone(map_code(None))
        self.assertIsNone(map_code(""))
        self.vendor.on("POST", TASKS, Resp(400, {"error": {"code": "SomethingNew", "message": "?"}}))
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(t2v(), V20)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)


# ── Seedance 2.x: polling and the result ───────────────────────────────────────

class SeedancePollTests(VendorCase):
    def task(self, tid="cgt-1"):
        return ProviderTask("video.seedance2", V20, tid)

    def status(self, body, tid="cgt-1", code=200):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", f"{TASKS}/{tid}", Resp(code, body))
        return self.video().poll(self.task(tid))

    def test_queued_and_running_are_pending(self):
        for st in ("queued", "running"):
            self.assertEqual(self.status({"id": "cgt-1", "status": st}).state, PENDING, st)
        (req,) = self.vendor.seen("GET", TASKS)
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")

    def test_succeeded_hands_back_the_clip_link(self):
        res = self.status({"status": "succeeded", "content": {"video_url": f"{self.vendor.base_url}/clip.mp4"}})
        self.assertEqual(res.state, SUCCEEDED)
        self.assertEqual(res.outputs[0].mime, "video/mp4")

    def test_a_succeeded_task_without_a_link_or_with_a_foreign_one_is_an_error(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"status": "succeeded", "content": {}})
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        for url in ("https://attacker.example/clip.mp4", "http://localhost/clip.mp4", "https://volces.com.evil.io/c.mp4"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status({"status": "succeeded", "content": {"video_url": url}})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)

    def test_failed_expired_and_cancelled_are_failures_with_the_vendors_reason(self):
        res = self.status({"status": "failed", "error": {"code": "OutputVideoSensitiveContentDetected", "message": "blocked"}})
        self.assertEqual((res.state, res.error.code), (FAILED, E_POLICY))
        res = self.status({"status": "failed", "error": {"code": "InternalServiceError", "message": "oops"}})
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))
        for st in ("expired", "cancelled"):
            res = self.status({"status": st})
            self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE), st)

    def test_a_status_we_do_not_know_is_pending_not_success(self):
        self.assertEqual(self.status({"status": "reticulating"}).state, PENDING)

    def test_a_task_id_that_could_steer_the_request_is_refused(self):
        for tid in ("../../v1/files", "a/b", "a?b=c", "", "x" * 300):
            with self.assertRaises(AdapterError, msg=repr(tid)) as cm:
                self.video().poll(self.task(tid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_polling_never_submits(self):
        self.status({"status": "running"})
        self.assertEqual(self.vendor.seen("POST", ""), [])


class SeedanceEndToEndTests(VendorCase):
    """submit -> poll (pending, then done) -> fetch through the probe runner."""

    def run_probe(self, polls, *, timeout_s=600):
        from tools.probe_models import run_probe

        self.vendor.on("POST", TASKS, Resp(200, {"id": "cgt-9"}))
        self.vendor.on("GET", f"{TASKS}/cgt-9", polls)
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4))
        clock = {"t": 0.0}
        entry = reg.get("seedance-2.0")
        with mock.patch.object(SeedanceV2Adapter, "result_hosts", ("localhost",)), \
                mock.patch.object(SeedanceV2Adapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(entry, env=self.env, voice_id=None, workdir=self.tmp, timeout_s=timeout_s,
                             poll_every_s=10, session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def test_the_probe_runs_the_whole_chain_and_stores_a_real_clip(self):
        done = Resp(200, {"status": "succeeded", "content": {"video_url": f"{self.vendor.base_url}/clip.mp4"}})
        res = self.run_probe([Resp(200, {"status": "queued"}), Resp(200, {"status": "running"}), done])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(MP4))
        body = self.vendor.seen("POST", TASKS)[0].json()
        self.assertEqual((body["resolution"], body["duration"], body["ratio"]), ("480p", 4, "16:9"))
        self.assertEqual([c.get("role") for c in body["content"] if c["type"] == "image_url"], ["first_frame", "last_frame"])
        self.assertEqual(len(self.vendor.seen("POST", TASKS)), 1)         # polling never re-submitted

    def test_a_task_that_never_finishes_ends_as_a_timeout_that_names_the_task(self):
        res = self.run_probe([Resp(200, {"status": "running"})], timeout_s=60)
        self.assertFalse(res.ok)
        self.assertEqual((res.code, res.task_id), ("timeout", "cgt-9"))   # the vendor task may still bill: the id is kept
        self.assertEqual(len(self.vendor.seen("POST", TASKS)), 1)

    def test_a_clip_link_the_vendor_cannot_serve_is_a_failed_probe_not_a_hang(self):
        gone = Resp(200, {"status": "succeeded", "content": {"video_url": f"{self.vendor.base_url}/missing.mp4"}})
        res = self.run_probe([gone])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_NOT_FOUND)


# ── Seedream ───────────────────────────────────────────────────────────────────

def pro(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2I, prompt="a red apple on a white table"), **kw})


PRO, FLASH, V45 = "dola-seedream-5-0-pro-260628", "dola-seedream-5-0-flash-260915", "seedream-4-5-251128"


class SeedreamTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", IMAGES, Resp(200, {"created": 1, "model": PRO, "data": [{"b64_json": b64(png()), "size": "1024x1024"}],
                                                    "usage": {"generated_images": 1}}))

    def sent(self):
        (req,) = self.vendor.seen("POST", IMAGES)
        return req

    def test_the_size_is_the_explicit_pixel_size_of_the_chosen_shape(self):
        for ratio, wh in (("1:1", "1024x1024"), ("16:9", "1424x800"), ("9:16", "800x1424"), ("21:9", "1568x672")):
            self.vendor.requests.clear()
            self.image().submit(pro(aspect_ratio=ratio, image_size="1K"), PRO)
            body = self.sent().json()
            self.assertEqual(body["size"], wh, ratio)
            self.assertEqual(body["response_format"], "b64_json")        # no 24-hour link to lose
            self.assertEqual(body["model"], PRO)
            self.assertNotIn("watermark", body)
        self.assertEqual(self.sent().headers["authorization"], f"Bearer {KEY}")

    def test_defaults_are_the_one_size_that_is_offered(self):
        self.image().submit(pro(), PRO)
        self.assertEqual(self.sent().json()["size"], "1024x1024")
        self.vendor.requests.clear()
        self.image().submit(pro(aspect_ratio="16:9"), V45)
        self.assertEqual(self.sent().json()["size"], "2848x1600")          # 4.5's own 2K table
        self.vendor.requests.clear()
        self.image().submit(pro(), FLASH)
        self.assertEqual(self.sent().json()["size"], "1024x1024")

    def test_the_image_is_stored_under_the_type_it_is(self):
        for payload, suffix in ((png(), ".png"), (jpeg(), ".jpg")):
            self.vendor._routes.clear()
            self.vendor.on("POST", IMAGES, Resp(200, {"data": [{"b64_json": b64(payload), "output_format": "png"}]}))
            a = self.image()
            task = a.submit(pro(), PRO)
            self.assertIsNone(task.task_id)                                # synchronous: finished inside submit
            (path,) = a.fetch(a.poll(task), self.tmp, stem=f"img{suffix[1:]}")
            self.assertEqual(path.suffix, suffix)
            self.assertEqual(path.read_bytes(), payload)

    def test_a_price_tier_or_shape_that_is_not_offered_is_refused_before_any_call(self):
        cases = ((pro(image_size="2K"), PRO, "image size 2K"),              # 5.0 pro costs double above 1.5K
                 (pro(image_size="4K"), V45, "image size 4K"),
                 (pro(image_size="1K"), V45, "image size 1K"),
                 (pro(aspect_ratio="5:2"), PRO, "aspect ratio 5:2"),
                 (pro(), "seedream-3-0-t2i-250415", "not a Seedream model"),
                 (pro(), "", "not a Seedream model"),
                 (CapabilityRequest("edit", "x", input_images=("a.png",)), PRO, "text-to-image only"),
                 (pro(prompt="   "), PRO, "prompt is empty"))
        for req, model, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.image().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
            self.assertTrue(cm.exception.not_accepted)
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entry_refuses_the_same(self):
        entry = reg.get("seedream-5.0-pro")
        a = self.image()
        self.assertEqual(a.problems(entry.probe_request(), entry), [])
        self.assertTrue(a.problems(pro(image_size="2K"), entry))
        self.assertTrue(a.problems(pro(quality="high"), entry))            # no tiers on this model

    def test_an_answer_that_is_not_a_picture_may_have_billed(self):
        for body in ({"data": []}, {"data": [{}]}, {"data": [{"b64_json": ""}]}, {"data": [{"b64_json": b64(b"<html>no</html>")}]},
                     {"data": [{"b64_json": "!!!not base64!!!"}]}, [], {}):
            self.vendor._routes.clear()
            self.vendor.on("POST", IMAGES, Resp(200, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.image().submit(pro(), PRO)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertFalse(cm.exception.not_accepted)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))

    def test_a_lost_answer_may_have_billed_and_a_refusal_did_not(self):
        self.vendor._routes.clear()
        self.vendor.on("POST", IMAGES, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.image().submit(pro(), PRO)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))
        self.vendor._routes.clear()
        self.vendor.on("POST", IMAGES, Resp(401, {"error": {"code": "AuthenticationError", "message": "bad key"}}))
        with self.assertRaises(AdapterError) as cm:
            self.image().submit(pro(), PRO)
        self.assertEqual(cm.exception.code, E_AUTH)
        self.assertTrue(cm.exception.not_accepted)

    def test_a_moderation_refusal_is_a_policy_error_in_either_place_the_vendor_puts_it(self):
        for body in ({"error": {"code": "OutputImageSensitiveContentDetected", "message": "blocked"}},
                     {"data": [{"error": {"code": "OutputImageSensitiveContentDetected", "message": "blocked"}}]}):
            self.vendor._routes.clear()
            self.vendor.on("POST", IMAGES, Resp(200, body))
            with self.assertRaises(AdapterError) as cm:
                self.image().submit(pro(), PRO)
            self.assertEqual(cm.exception.code, E_POLICY)

    def test_http_errors_use_the_modelark_vocabulary(self):
        for status, code, want in ((403, "AccountOverdueError", E_QUOTA), (429, "ModelAccountIpmRateLimitExceeded", E_RATE_LIMITED),
                                   (400, "InputTextSensitiveContentDetected", E_POLICY)):
            self.vendor._routes.clear()
            self.vendor.on("POST", IMAGES, Resp(status, {"error": {"code": code, "message": "x"}}))
            with self.assertRaises(AdapterError, msg=code) as cm:
                self.image().submit(pro(), PRO)
            self.assertEqual(cm.exception.code, want, code)

    def test_no_key_is_a_refusal_before_any_call(self):
        a = build_adapter("image.seedream", env={"SEEDREAM_BASE_URL": self.vendor.base_url}, session=self.vendor.session())
        with self.assertRaises(AdapterError) as cm:
            a.submit(pro(), PRO)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertEqual(self.vendor.requests, [])


class WiringTests(unittest.TestCase):
    def test_the_modelark_result_hosts_are_what_the_adapter_downloads_from(self):
        self.assertEqual(SeedanceV2Adapter.result_hosts, ("volces.com", "bytepluses.com"))
        self.assertEqual(SeedanceV2Adapter.result_ports, (None, 443))     # only tests widen it, on an instance
        self.assertLessEqual(SeedanceV2Adapter.max_result_bytes, 1 << 30)

    def test_a_seedance_1_x_adapter_is_untouched(self):
        from modules.capabilities.video import SeedanceAdapter

        self.assertNotIn("fetch", vars(SeedanceAdapter))
        self.assertEqual(SeedanceAdapter.key, "video.seedance")


if __name__ == "__main__":
    unittest.main()
