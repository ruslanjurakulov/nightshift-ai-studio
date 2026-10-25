"""Alibaba Model Studio (HappyHorse 1.1, Qwen-Image 2.1, Z-Image Turbo) and the gate on Wan:
the adapters, the registry entries, and the rule that none of it is for sale.

The adapters talk to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py): no network, no key,
no spend. The download rules are pinned in tests/test_safe_fetch.py; here the point is that these
adapters USE them, and that Alibaba's shared storage domain is narrowed to its result buckets.

What would break without these tests:

* Wan 2.7 / 3.0 sold with no gate although the Product Terms bar resale of Model Studio models;
* a priced setting (resolution, duration, Z-Image prompt rewriting) left to the vendor, which bills
  the dearest resolution (1080P) or doubles the price for an omitted field;
* the vendor's HappyHorse watermark silently on (or silently off with nobody having decided);
* a result link on somebody else's Alibaba Cloud bucket being downloaded;
* a submit whose answer was lost being treated as "nothing was bought";
* a model whose resale Alibaba has not allowed becoming sellable.
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
from modules.capabilities import alibaba, build_adapter
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
    EDIT,
    FAILED,
    I2V,
    PENDING,
    SUCCEEDED,
    T2I,
    T2V,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED, SafeResultMixin
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url
from tests.test_creative_worker import JOB, ORG

ROOT = Path(__file__).resolve().parent.parent
KEY = "sk-test-NOT-A-REAL-KEY-0123456789abcdef"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
HH = "happyhorse-1.1"
HH_T2V, HH_I2V = "happyhorse-1.1-t2v", "happyhorse-1.1-i2v"
QWEN_PRO, QWEN_TURBO, ZIMG = "qwen-image-2.1-pro", "qwen-image-2.1-turbo", "z-image-turbo"
NEW_IDS = (HH, QWEN_PRO, QWEN_TURBO, ZIMG)
WAN_IDS = ("wan-2.7", "wan-3.0")
SUBMIT = "/api/v1/services/aigc/video-generation/video-synthesis"
TASKS = "/api/v1/tasks/"
GEN = "/api/v1/services/aigc/multimodal-generation/generation"
BUCKET = "https://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com/out"


def tearDownModule():
    cleanup_certificate()


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def done_video(url: str) -> dict:
    return {"request_id": "r", "output": {"task_id": "t", "task_status": "SUCCEEDED", "video_url": url}}


def image_answer(url: str) -> dict:
    return {"output": {"choices": [{"finish_reason": "stop", "message": {"role": "assistant",
                                                                          "content": [{"image": url}]}}]},
            "usage": {"image_count": 1}, "request_id": "r"}


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="alibaba_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.env = {"WAN_API_KEY": KEY, "WAN_BASE_URL": self.vendor.base_url}

    def widen(self):
        """Tests alone let a result come from the loopback server; production keeps Alibaba's buckets."""
        p = mock.patch.object(alibaba, "RESULT_HOST_RE", re.compile(r"localhost"))
        p.start()
        self.addCleanup(p.stop)

    def adapter(self, key, env=None, *, widen=True) -> HttpAdapter:
        a = build_adapter(key, env=env or self.env, session=self.vendor.session())
        if widen:
            self.widen()
            a.result_hosts = ("localhost",)
            a.result_ports = (None, 443, self.vendor.port)
        return a

    def video(self, env=None, *, widen=True):
        return self.adapter("video.happyhorse", env, widen=widen)

    def image(self, env=None, *, widen=True):
        return self.adapter("image.dashscope", env, widen=widen)

    def frame(self, name="first.png") -> str:
        p = self.tmp / name
        p.write_bytes(png())
        return str(p)


def t2v(**kw) -> CapabilityRequest:
    base = dict(capability=T2V, prompt="a boat at dawn", resolution="480p", duration_s=3)
    return CapabilityRequest(**{**base, **kw})


def t2i(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2I, prompt="a red apple on a white table"), **kw})


# ── Wan: the gate that was missing ────────────────────────────────────────────────

class WanGateTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_wan_is_gated_on_the_resale_clause_it_was_missing(self):
        for mid in WAN_IDS:
            e = self.r[mid]
            self.assertEqual(e.terms_gate, "written_consent_required", mid)
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("§4.48.1(d)(v)", notes, mid)
            self.assertIn("expressly authorised", notes, mid)
            self.assertIn("2026-09-23", notes, mid)
            self.assertIn("NOT read", notes, mid)                 # says what was not read
            self.assertIn("Gate stays open", notes, mid)

    def test_the_wan_gate_reaches_the_database_row_where_sellable_models_refuses_it(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in WAN_IDS:
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "written_consent_required", mid)

    def test_wan_3_0_records_what_the_docs_say_but_still_only_sells_what_the_adapter_sends(self):
        e = self.r["wan-3.0"]
        self.assertEqual(e.capabilities, ("t2v",))                 # i2v / reference are NOT wired: note only
        self.assertEqual(e.vendor_model, "wan3.0-video")
        note = e.raw["api_documented"]["note"]
        for word in ("wan3.0-video-prime", "first/last-frame", "2-30 s", "Neither is wired"):
            self.assertIn(word, note)
        price = e.raw["pricing"]
        self.assertEqual(price["variants"]["prices"], {"720p": 0.1, "1080p": 0.2})     # values unchanged
        self.assertFalse(price["confirmed"])
        self.assertIn("Limited-time 30% off", price["note"])      # and the doubt about it is written down
        self.assertIn("wan3.0-video-prime", price["note"])

    def test_gated_wan_is_left_out_of_probe_all_and_probed_when_named(self):
        from tools import probe_models

        entries = list(self.r.values())
        chosen = {e.id for e in probe_models.select(entries, [], None, True)}
        for mid in (*WAN_IDS, *NEW_IDS):
            self.assertNotIn(mid, chosen, mid)
            self.assertIn(mid, {e.id for e in probe_models.select(entries, [mid], None, True)})
            self.assertIn(mid, {e.id for e in probe_models.gated_left_out(entries, [], None, True)})


# ── the registry: dark, gated, unpriced ────────────────────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_the_models_are_registered_on_their_own_adapters(self):
        self.assertEqual(self.r[HH].adapter, "video.happyhorse")
        for mid in (QWEN_PRO, QWEN_TURBO, ZIMG):
            self.assertEqual(self.r[mid].adapter, "image.dashscope", mid)
        for mid in NEW_IDS:
            self.assertEqual(self.r[mid].provider, "alibaba", mid)

    def test_none_of_them_can_be_sold_until_alibaba_has_authorised_resale_in_writing(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in NEW_IDS:
            e = self.r[mid]
            self.assertEqual(e.terms_gate, "written_consent_required", mid)
            self.assertEqual(e.api_exposure, "web_only", mid)
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "written_consent_required", mid)
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("§4.48.1(d)(v)", notes, mid)
            self.assertIn("our reading, not Alibaba's", notes, mid)      # an interpretation is labelled as one
            self.assertIn("NOT read", notes, mid)
            self.assertIn("Gate stays open", notes, mid)
            self.assertIn("Uzbekistan", notes, mid)

    def test_no_migration_or_price_file_prices_them(self):
        units = []
        for mid in NEW_IDS:
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, e.raw["pricing"]["unit"], k)
                      for k in (e.raw["pricing"].get("variants") or {}).get("prices", {})]
        self.assertEqual(len(units), 1 + 3 + 3)
        hits = []
        for folder in ("supabase/migrations", "docs/sql", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_with_a_source(self):
        for mid in NEW_IDS:
            p = self.r[mid].raw["pricing"]
            self.assertFalse(p["confirmed"], mid)
            self.assertEqual(p["source_url"], "https://www.alibabacloud.com/help/en/model-studio/model-pricing", mid)
            self.assertEqual(p["as_of"], "2026-10-25", mid)
            self.assertIn("ESTIMATE", p["note"], mid)
            # a vendor's "failed requests are not billed" is quoted as a claim, never stated as a fact
            self.assertIn("vendor claim", p["note"], mid)

    def test_the_prices_are_the_pages_singapore_list(self):
        v = self.r[HH].raw["pricing"]["variants"]
        self.assertEqual(v["by"], "resolution")
        self.assertEqual(v["prices"], {"480p": 0.07, "720p": 0.14, "1080p": 0.18})
        self.assertEqual(self.r[QWEN_PRO].raw["pricing"]["provider_usd_per_unit"], 0.04)
        self.assertEqual(self.r[QWEN_TURBO].raw["pricing"]["provider_usd_per_unit"], 0.016)
        self.assertEqual(self.r[ZIMG].raw["pricing"]["provider_usd_per_unit"], 0.015)   # prompt rewriting OFF
        self.assertIn("$0.03", self.r[ZIMG].raw["pricing"]["note"])                      # and the dearer ON price is told

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        e = self.r[HH]
        self.assertEqual(sorted(e.resolutions), ["1080p", "480p", "720p"])
        self.assertEqual(list(e.durations_s), list(range(3, 16)))
        self.assertTrue(set(e.aspect_ratios) <= set(alibaba.HappyHorseVideoAdapter.RATIOS))
        self.assertEqual(e.vendor_model, HH_T2V)
        self.assertEqual(e.vendor_model_for("i2v"), HH_I2V)
        self.assertEqual(set(alibaba.HappyHorseVideoAdapter.SPECS), {HH_T2V, HH_I2V})
        spec = alibaba.DashScopeImageAdapter.SPECS
        for mid in (QWEN_PRO, QWEN_TURBO, ZIMG):
            m = self.r[mid]
            self.assertIn(m.vendor_model, spec, mid)
            self.assertEqual(sorted(m.aspect_ratios), sorted(spec[m.vendor_model]["sizes"]), mid)
            self.assertEqual(m.image_refs_max, spec[m.vendor_model]["max_refs"], mid)

    def test_the_video_entry_pins_the_cheaper_resolution_so_the_database_prices_by_it(self):
        self.assertEqual(self.r[HH].default_resolution, "720p")      # the vendor's own default is 1080P
        self.assertEqual(self.r[HH].variants_by, "resolution")

    def test_the_prompt_cap_is_the_smaller_of_the_vendors_two_limits(self):
        # 5,000 non-Chinese or 2,500 Chinese characters, and the vendor TRUNCATES the excess silently.
        self.assertEqual(self.r[HH].max_prompt_chars, 2500)
        self.assertEqual(self.r[ZIMG].max_prompt_chars, 800)

    def test_probes_are_servable_and_cheap(self):
        req = self.r[HH].probe_request()
        self.assertEqual((req.capability, req.resolution, req.duration_s), (T2V, "480p", 3))   # 3 s x $0.07 = $0.21
        for mid in (QWEN_PRO, QWEN_TURBO, ZIMG):
            self.assertEqual(self.r[mid].probe_request().capability, T2I)

    def test_quality_and_speed_tiers_follow_the_research_and_are_judgement(self):
        self.assertEqual((self.r[HH].raw["quality_tier"], self.r[HH].raw["speed_tier"]), (5, 3))
        self.assertEqual(self.r[QWEN_PRO].raw["quality_tier"], 4)


# ── video: what is sent ─────────────────────────────────────────────────────────────

class HappyHorseSubmitTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", SUBMIT, Resp(200, {"output": {"task_status": "PENDING", "task_id": "0385dc79-5ff8"},
                                                    "request_id": "r"}))

    def sent(self):
        (req,) = self.vendor.seen("POST", SUBMIT)
        return req

    def test_text_to_video_sends_every_priced_setting_and_the_watermark_choice_explicitly(self):
        task = self.video().submit(t2v(), HH_T2V)
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("video.happyhorse", HH_T2V, "0385dc79-5ff8"))
        req = self.sent()
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.headers["x-dashscope-async"], "enable")        # without it the API refuses
        self.assertEqual(req.json(), {"model": HH_T2V, "input": {"prompt": "a boat at dawn"},
                                      "parameters": {"resolution": "480P", "duration": 3, "watermark": False,
                                                     "ratio": "16:9"}})

    def test_the_watermark_is_always_sent_and_off_until_the_owner_decides_otherwise(self):
        # Alibaba's default is ON ("HappyHorse" lower right). OFF is an owner decision not yet taken
        # (Product Terms 4.48.1(h)(ii) labelling duty): this pins that it is explicit either way.
        self.assertIs(alibaba.HappyHorseVideoAdapter.WATERMARK, False)
        for req in (t2v(), CapabilityRequest(I2V, "x", resolution="480p", duration_s=3, input_images=(self.frame(),))):
            self.vendor.requests.clear()
            self.video().submit(req, HH_T2V if req.capability == T2V else HH_I2V)
            self.assertIs(self.sent().json()["parameters"]["watermark"], False)
        self.vendor.requests.clear()
        with mock.patch.object(alibaba.HappyHorseVideoAdapter, "WATERMARK", True):
            self.video().submit(t2v(), HH_T2V)
        self.assertIs(self.sent().json()["parameters"]["watermark"], True)     # the one-line switch works

    def test_resolution_and_duration_are_sent_in_the_vendors_case_and_as_asked(self):
        for res, dur in (("480p", 3), ("720p", 7), ("1080p", 15)):
            self.vendor.requests.clear()
            self.video().submit(t2v(resolution=res, duration_s=dur, aspect_ratio="9:16"), HH_T2V)
            p = self.sent().json()["parameters"]
            self.assertEqual((p["resolution"], p["duration"], p["ratio"]), (res.upper(), dur, "9:16"))

    def test_picture_to_video_sends_the_picture_inline_or_as_a_link_and_no_ratio(self):
        self.video().submit(CapabilityRequest(I2V, "", resolution="720p", duration_s=5, input_images=(self.frame(),)),
                            HH_I2V)
        body = self.sent().json()
        self.assertEqual(body["model"], HH_I2V)
        self.assertNotIn("prompt", body["input"])                                 # optional for i2v
        (media,) = body["input"]["media"]
        self.assertEqual(media["type"], "first_frame")
        self.assertTrue(media["url"].startswith("data:image/png;base64,"))
        self.assertNotIn("ratio", body["parameters"])
        self.vendor.requests.clear()
        self.video().submit(CapabilityRequest(I2V, "go", resolution="480p", duration_s=3,
                                              input_images=("https://example.invalid/still.png",)), HH_I2V)
        self.assertEqual(self.sent().json()["input"], {"prompt": "go", "media": [{"type": "first_frame",
                                                                                  "url": "https://example.invalid/still.png"}]})

    def test_a_setting_the_price_depends_on_is_refused_before_any_call_never_defaulted(self):
        gif = self.tmp / "a.gif"
        gif.write_bytes(b"GIF89a")
        cases = (
            (HH_T2V, t2v(resolution=None), "resolution"),              # the vendor's own default is 1080P
            (HH_T2V, t2v(resolution="2160p"), "resolution"),
            (HH_T2V, t2v(duration_s=None), "duration"),                # the vendor's own default is 5 s
            (HH_T2V, t2v(duration_s=2), "duration"),
            (HH_T2V, t2v(duration_s=16), "duration"),
            (HH_T2V, t2v(aspect_ratio="7:3"), "aspect ratio"),
            (HH_T2V, t2v(prompt=" "), "prompt is empty"),
            (HH_T2V, t2v(negative_prompt="blur"), "negative prompt"),
            (HH_T2V, t2v(input_images=("a.png",)), "does not apply to text-to-video"),
            (HH_T2V, CapabilityRequest(I2V, "x", resolution="480p", duration_s=3, input_images=("https://x/a.png",)), "is the t2v model"),
            (HH_I2V, t2v(), "is the i2v model"),
            ("happyhorse-1.0-t2v", t2v(), "not a HappyHorse 1.1 model"),    # 1.0 is a different price table
            ("happyhorse-1.1-r2v", t2v(), "not a HappyHorse 1.1 model"),    # its page was not read
            ("", t2v(), "not a HappyHorse 1.1 model"),
            (HH_I2V, CapabilityRequest(I2V, "x", resolution="480p", duration_s=3), "first-frame picture"),
            (HH_I2V, CapabilityRequest(I2V, "x", aspect_ratio="16:9", resolution="480p", duration_s=3,
                                       input_images=("https://x/a.png",)), "own shape"),
        )
        for model, req, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.video().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message)
        for bad_pic, fragment in ((str(gif), "JPEG, PNG or WEBP"), (str(self.tmp / "missing.png"), "could not be read")):
            with self.assertRaises(AdapterError) as cm:
                self.video().submit(CapabilityRequest(I2V, "x", resolution="480p", duration_s=3,
                                                      input_images=(bad_pic,)), HH_I2V)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
            self.assertTrue(cm.exception.not_accepted)
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_a_picture_over_the_size_the_docs_allow_is_refused_before_any_call(self):
        with mock.patch.object(alibaba.HappyHorseVideoAdapter, "MAX_IMAGE_BYTES", 4):
            with self.assertRaises(AdapterError) as cm:
                self.video().submit(CapabilityRequest(I2V, "x", resolution="480p", duration_s=3,
                                                      input_images=(self.frame(),)), HH_I2V)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entry_refuses_what_the_adapter_would_refuse(self):
        entry = reg.get(HH)
        a = self.video()
        self.assertEqual(a.problems(entry.probe_request(), entry), [])
        self.assertTrue(a.problems(t2v(resolution=None), entry))
        self.assertTrue(a.problems(t2v(duration_s=None), entry))
        self.assertTrue(any("own shape" in p for p in a.problems(
            CapabilityRequest(I2V, "x", aspect_ratio="16:9", resolution="480p", duration_s=3,
                              input_images=("https://p/x.png",)), entry)))
        # the audio is part of the model: there is no switch, so none may be asked for
        self.assertTrue(any("audio flag" in p for p in a.problems(t2v(audio=False), entry)))

    def test_no_key_is_a_refusal_before_any_call(self):
        a = build_adapter("video.happyhorse", env={"WAN_BASE_URL": self.vendor.base_url}, session=self.vendor.session())
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), HH_T2V)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_the_workspace_host_is_used_like_wan_and_an_http_override_is_ignored(self):
        a = build_adapter("video.happyhorse", env={"WAN_API_KEY": KEY, "WAN_WORKSPACE_ID": "ws-1"})
        self.assertEqual(a.base_url, "https://ws-1.ap-southeast-1.maas.aliyuncs.com")
        a = build_adapter("video.happyhorse", env={"WAN_API_KEY": KEY, "WAN_WORKSPACE_ID": "evil.example/x"})
        self.assertEqual(a.base_url, "https://dashscope-intl.aliyuncs.com")
        a = build_adapter("video.happyhorse", env={"WAN_API_KEY": KEY, "WAN_BASE_URL": "http://plain.example"})
        self.assertEqual(a.base_url, "https://dashscope-intl.aliyuncs.com")     # a key is never sent in clear text


class HappyHorseLostAnswerTests(VendorCase):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
        self.assertNotIn(KEY, cm.exception.message)

    def test_a_connection_dropped_after_the_request_arrived_may_have_billed(self):
        self.vendor.on("POST", SUBMIT, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(t2v(), HH_T2V)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)
        self.assertEqual(len(self.vendor.seen("POST", SUBMIT)), 1)

    def test_a_read_timeout_may_have_billed(self):
        self.vendor.on("POST", SUBMIT, Resp(200, {"output": {"task_id": "late"}}, hang_s=1.5))
        a = self.video()
        a.timeout = 0.4
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), HH_T2V)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_5xx_may_have_billed(self):
        self.vendor.on("POST", SUBMIT, Resp(503, {"code": "ServiceUnavailable", "message": "busy"}))
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(t2v(), HH_T2V)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_task_id_may_have_billed(self):
        for body in ({}, {"output": {}}, {"output": {"task_id": ""}}, {"output": {"task_id": 7}},
                     {"output": {"task_id": "../../v1/files"}}, {"output": {"task_id": "x" * 300}}, [], None):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", SUBMIT, Resp(200, body))
            a = build_adapter("video.happyhorse", env={"WAN_API_KEY": KEY, "WAN_BASE_URL": vendor.base_url},
                              session=vendor.session())
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                a.submit(t2v(), HH_T2V)
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.video({"WAN_API_KEY": KEY, "WAN_BASE_URL": closed_port_url()})
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), HH_T2V)
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_outright_refusals_are_proof_and_say_the_right_remedy(self):
        cases = ((401, {"code": "InvalidApiKey", "message": "Invalid API-key provided."}, E_AUTH),
                 (402, {"code": "Whatever", "message": "no credits"}, E_QUOTA),
                 (429, {"code": "Throttling.RateQuota", "message": "slow down"}, E_RATE_LIMITED),
                 (404, {"code": "ModelNotFound", "message": "no such model"}, E_NOT_FOUND))
        for status, body, want in cases:
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", SUBMIT, Resp(status, body))
            a = build_adapter("video.happyhorse", env={"WAN_API_KEY": KEY, "WAN_BASE_URL": vendor.base_url},
                              session=vendor.session())
            with self.assertRaises(AdapterError, msg=status) as cm:
                a.submit(t2v(), HH_T2V)
            self.assertEqual(cm.exception.code, want, status)
            self.assertTrue(cm.exception.not_accepted, status)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, status)

    def test_the_vendors_own_codes_beat_the_http_status(self):
        # An overdue bill and a rejected key are both a 4xx; they need opposite remedies (CLAUDE.md #6).
        cases = (("Arrearage", 400, E_QUOTA), ("DataInspectionFailed", 400, E_POLICY),
                 ("IPInfringementSuspect", 400, E_POLICY), ("InvalidParameter", 400, E_BAD_REQUEST),
                 ("Throttling.User", 400, E_RATE_LIMITED))
        for code, status, want in cases:
            self.vendor._routes.clear()
            self.vendor.on("POST", SUBMIT, Resp(status, {"code": code, "message": "x"}))
            with self.assertRaises(AdapterError, msg=code) as cm:
                self.video().submit(t2v(), HH_T2V)
            self.assertEqual(cm.exception.code, want, code)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, code)

    def test_a_key_the_vendor_echoes_is_scrubbed(self):
        self.vendor.on("POST", SUBMIT, Resp(401, {"code": "InvalidApiKey", "message": f"bad {KEY}"}))
        with self.assertRaises(AdapterError) as cm:
            self.video().submit(t2v(), HH_T2V)
        self.assertNotIn(KEY, cm.exception.message)

    def test_the_creative_bridge_keeps_the_difference(self):
        entry = reg.get(HH)

        def bridged(env, **params):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=self.vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2v", model=entry.id,
                                                  params=dict(prompt="a boat", duration_s=3, **params), input_files=()))
        with self.assertRaises(ca.CreativeAdapterError) as cm:           # the job carries no resolution: not quoted
            bridged(self.env)
        self.assertIn("no resolution", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])
        self.vendor.on("POST", SUBMIT, Resp(drop=True))
        with self.assertRaises(AdapterError) as lost:
            bridged(self.env, resolution="480p")
        self.assertFalse(lost.exception.not_accepted)            # the worker must not move this job to another model
        refused = FakeVendor()
        self.addCleanup(refused.close)
        refused.on("POST", SUBMIT, Resp(401, {"code": "InvalidApiKey", "message": "bad key"}))
        with self.assertRaises(AdapterError) as no:
            bridged({"WAN_API_KEY": KEY, "WAN_BASE_URL": refused.base_url}, resolution="480p")
        self.assertTrue(no.exception.not_accepted)


# ── video: polling and the result ───────────────────────────────────────────────────

class HappyHorsePollTests(VendorCase):
    def status(self, body, tid="t-1", code=200, *, widen=True):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", TASKS + tid, Resp(code, body))
        return self.video(widen=widen).poll(ProviderTask("video.happyhorse", HH_T2V, tid))

    def test_pending_and_running_are_pending_and_polling_sends_the_key_only_to_the_api(self):
        for st in ("PENDING", "RUNNING", "SOMETHING_NEW"):
            self.assertEqual(self.status({"output": {"task_status": st}}).state, PENDING, st)
        (req,) = self.vendor.seen("GET", TASKS)
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(self.vendor.seen("POST", ""), [])               # polling never submits

    def test_succeeded_hands_back_the_clip_link(self):
        res = self.status(done_video(f"{self.vendor.base_url}/clip.mp4"))
        self.assertEqual(res.state, SUCCEEDED)
        self.assertEqual(res.outputs[0].mime, "video/mp4")

    def test_failed_and_cancelled_carry_the_vendors_code_and_the_right_remedy(self):
        cases = (("InvalidParameter", "The parameter is invalid.", E_BAD_REQUEST),
                 ("DataInspectionFailed", "inappropriate content", E_POLICY),
                 ("IPInfringementSuspect", "IP", E_POLICY),
                 ("Arrearage", "overdue", E_QUOTA),
                 ("Throttling.RateQuota", "slow", E_RATE_LIMITED),
                 ("brand_new_code", "?", E_UNAVAILABLE))
        for code, message, want in cases:
            res = self.status({"output": {"task_status": "FAILED", "code": code, "message": message}})
            self.assertEqual((res.state, res.error.code), (FAILED, want), (code, message))
        self.assertEqual(self.status({"output": {"task_status": "FAILED"}}).error.code, E_UNAVAILABLE)
        res = self.status({"output": {"task_status": "CANCELED"}})
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))

    def test_a_task_the_vendor_no_longer_knows_says_to_check_the_usage_page_not_that_it_was_free(self):
        res = self.status({"output": {"task_id": "t-1", "task_status": "UNKNOWN"}})
        self.assertEqual((res.state, res.error.code), (FAILED, E_NOT_FOUND))
        self.assertIn("usage page", res.error.message)
        self.assertNotIn("not billed", res.error.message)
        self.assertNotIn("free", res.error.message.lower())

    def test_a_key_the_vendor_echoes_in_a_failure_is_scrubbed(self):
        res = self.status({"output": {"task_status": "FAILED", "code": "X", "message": f"token {KEY} rejected"}})
        self.assertNotIn(KEY, res.error.message)

    def test_succeeded_without_a_link_may_have_billed_and_says_so(self):
        for out in ({"task_status": "SUCCEEDED"}, {"task_status": "SUCCEEDED", "video_url": ""},
                    {"task_status": "SUCCEEDED", "video_url": 5}):
            with self.assertRaises(AdapterError) as cm:
                self.status({"output": out})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)

    def test_a_link_off_alibabas_result_buckets_is_refused_and_says_the_spend_may_have_happened(self):
        # Alibaba's storage domain is shared by every customer's bucket: the domain alone is not enough.
        for url in ("https://attacker.example/dashscope-result.oss-cn-beijing.aliyuncs.com/c.mp4",
                    "http://dashscope-result.oss-cn-beijing.aliyuncs.com/c.mp4",              # not https
                    "https://some-customer-bucket.oss-cn-beijing.aliyuncs.com/c.mp4",          # another tenant
                    "https://dashscope-result.oss-cn-beijing.aliyuncs.com.evil.io/c.mp4",      # a look-alike
                    "https://evildashscope-result.oss-cn-beijing.aliyuncs.com/c.mp4",
                    "https://dashscope-result.oss-cn-beijing.aliyuncs.com:8443/c.mp4",         # another port
                    "https://dashscope.aliyuncs.com/c.mp4",                                    # the API host, not a bucket
                    "https://u:p@dashscope-result.oss-cn-beijing.aliyuncs.com/c.mp4"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status(done_video(url), widen=False)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)
            self.assertNotIn(KEY, cm.exception.message)

    def test_fetch_itself_refuses_a_link_that_was_never_vetted(self):
        # The download is the last gate: a result handed to fetch() directly is vetted again, whatever poll did.
        a = self.video(widen=False)
        for url in ("https://some-customer-bucket.oss-cn-beijing.aliyuncs.com/x.mp4", "https://attacker.example/x.mp4"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                a.fetch(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]), self.tmp)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)
            self.assertIn("it was not downloaded", cm.exception.message, url)
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_the_result_buckets_the_docs_show_are_accepted_and_an_unseen_host_names_itself(self):
        # Beijing / Shanghai / Shenzhen / Hangzhou examples from the pages read; the Singapore one is a guess
        # that matches the same shape and is exactly what the first real probe confirms.
        for url in ("https://dashscope-result.oss-cn-beijing.aliyuncs.com/a.mp4?Expires=1",
                    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.mp4",
                    "https://dashscope-result-sh.oss-accelerate.aliyuncs.com/a.mp4",
                    "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/a.mp4",
                    BUCKET + ".mp4"):
            res = self.status(done_video(url), widen=False)
            self.assertEqual(res.state, SUCCEEDED, url)
        with self.assertRaises(AdapterError) as cm:
            self.status(done_video("https://results.example.aliyuncs.com/a.mp4"), widen=False)
        self.assertIn("'results.example.aliyuncs.com'", cm.exception.message)       # the probe tells a person what to allow
        self.assertIn("RESULT_HOST_RE", cm.exception.message)

    def test_a_body_that_is_an_error_not_a_status_is_typed_not_pending_forever(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"code": "InvalidApiKey", "message": "Invalid API-key provided.", "request_id": "r"})
        self.assertEqual(cm.exception.code, E_AUTH)

    def test_a_task_id_that_could_steer_the_request_is_refused(self):
        for tid in ("../../v1/files", "a/b", "a?b=c", "", "x" * 300):
            with self.assertRaises(AdapterError, msg=repr(tid)) as cm:
                self.video().poll(ProviderTask("video.happyhorse", HH_T2V, tid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_is_typed(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"code": "InvalidApiKey", "message": "x"}, code=401)
        self.assertEqual(cm.exception.code, E_AUTH)
        with self.assertRaises(AdapterError) as cm:
            self.status({"code": "ServiceUnavailable"}, code=502)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)             # the task is still Alibaba's: poll again


class HappyHorseEndToEndTests(VendorCase):
    """submit -> poll (pending, then succeeded) -> fetch through the probe runner."""

    def run_probe(self, polls, *, timeout_s=600):
        from tools.probe_models import run_probe

        self.widen()
        self.vendor.on("POST", SUBMIT, Resp(200, {"output": {"task_status": "PENDING", "task_id": "req-9"}}))
        self.vendor.on("GET", TASKS + "req-9", polls)
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4))
        clock = {"t": 0.0}
        with mock.patch.object(alibaba.HappyHorseVideoAdapter, "result_hosts", ("localhost",)), \
                mock.patch.object(alibaba.HappyHorseVideoAdapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(HH), env=self.env, voice_id=None, workdir=self.tmp, timeout_s=timeout_s,
                             poll_every_s=15, session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def test_the_probe_runs_the_whole_chain_and_stores_a_real_clip(self):
        done = Resp(200, done_video(f"{self.vendor.base_url}/clip.mp4"))
        res = self.run_probe([Resp(200, {"output": {"task_status": "PENDING"}}),
                              Resp(200, {"output": {"task_status": "RUNNING"}}), done])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(MP4))
        body = self.vendor.seen("POST", SUBMIT)[0].json()
        self.assertEqual(body["model"], HH_T2V)
        self.assertEqual(body["parameters"], {"resolution": "480P", "duration": 3, "watermark": False, "ratio": "16:9"})
        self.assertEqual(len(self.vendor.seen("POST", SUBMIT)), 1)          # polling never re-submitted

    def test_a_job_that_never_finishes_ends_as_a_timeout_that_names_the_task(self):
        res = self.run_probe([Resp(200, {"output": {"task_status": "RUNNING"}})], timeout_s=30)
        self.assertFalse(res.ok)
        self.assertEqual((res.code, res.task_id), ("timeout", "req-9"))     # it may still bill: the id is kept
        self.assertEqual(len(self.vendor.seen("POST", SUBMIT)), 1)

    def test_an_expired_clip_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/expired.mp4", Resp(403, {"error": "signature expired"}))
        res = self.run_probe([Resp(200, done_video(f"{self.vendor.base_url}/expired.mp4"))])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_NOT_FOUND)
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)

    def test_an_html_page_instead_of_a_clip_is_refused_not_stored(self):
        self.vendor.on("GET", "/page.mp4", Resp(200, raw=b"<html>login</html>" + b" " * 64))
        res = self.run_probe([Resp(200, done_video(f"{self.vendor.base_url}/page.mp4"))])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_BAD_RESPONSE)
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)
        self.assertEqual([p.name for p in self.tmp.glob("*.mp4*")], [])


# ── pictures ──────────────────────────────────────────────────────────────────────

class DashScopeImageTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", GEN, Resp(200, image_answer(f"{self.vendor.base_url}/img.png")))
        self.vendor.on("GET", "/img.png", Resp(200, raw=png()))

    def sent(self):
        (req,) = self.vendor.seen("POST", GEN)
        return req

    def test_qwen_text_to_image_sends_one_image_without_a_watermark_and_the_size_only_when_asked(self):
        a = self.image()
        task = a.submit(t2i(), QWEN_PRO)
        self.assertIsNone(task.task_id)                                 # synchronous: finished inside submit
        req = self.sent()
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertNotIn("x-dashscope-async", req.headers)               # the picture API is synchronous
        self.assertEqual(req.json(), {"model": QWEN_PRO,
                                      "input": {"messages": [{"role": "user",
                                                              "content": [{"text": "a red apple on a white table"}]}]},
                                      "parameters": {"n": 1, "watermark": False}})
        self.vendor.requests.clear()
        a.submit(t2i(aspect_ratio="16:9"), QWEN_TURBO)
        self.assertEqual(self.sent().json()["parameters"], {"n": 1, "watermark": False, "size": "2688*1536"})
        (path,) = a.fetch(a.poll(task), self.tmp, stem="img")
        self.assertEqual(path.suffix, ".png")
        self.assertEqual(path.read_bytes(), png())

    def test_z_image_always_sends_prompt_rewriting_off_because_on_doubles_the_price(self):
        self.image().submit(t2i(), ZIMG)
        self.assertEqual(self.sent().json()["parameters"], {"prompt_extend": False})
        self.vendor.requests.clear()
        self.image().submit(t2i(aspect_ratio="9:16"), ZIMG)
        self.assertEqual(self.sent().json()["parameters"], {"prompt_extend": False, "size": "720*1280"})

    def test_qwen_edit_sends_the_pictures_before_the_words_inline_or_as_links(self):
        a = self.image()
        a.submit(CapabilityRequest(EDIT, "make it red", input_images=(self.frame(), "https://example.invalid/b.png")), QWEN_PRO)
        content = self.sent().json()["input"]["messages"][0]["content"]
        self.assertTrue(content[0]["image"].startswith("data:image/png;base64,"))
        self.assertEqual(content[1], {"image": "https://example.invalid/b.png"})
        self.assertEqual(content[2], {"text": "make it red"})

    def test_a_setting_that_does_not_apply_is_refused_before_any_call(self):
        pic = self.frame()
        cases = ((t2i(aspect_ratio="19.5:9"), QWEN_PRO, "aspect ratio"),
                 (t2i(aspect_ratio="2:3"), QWEN_PRO, "aspect ratio"),      # a Z-Image shape, not in the Qwen table
                 (t2i(image_size="2K"), QWEN_PRO, "image size"),
                 (t2i(quality="high"), QWEN_PRO, "quality"),
                 (t2i(negative_prompt="blur"), QWEN_PRO, "negative prompt"),   # only the 3.0 series takes one
                 (t2i(prompt=" "), QWEN_PRO, "prompt is empty"),
                 (t2i(input_images=(pic,)), QWEN_PRO, "does not apply to text-to-image"),
                 (CapabilityRequest(EDIT, "x"), QWEN_PRO, "needs a picture"),
                 (CapabilityRequest(EDIT, "x", input_images=(pic,) * 11), QWEN_PRO, "at most 10"),
                 (CapabilityRequest(EDIT, "x", input_images=(pic,)), ZIMG, "text-to-image only"),
                 (t2i(), "qwen-image-3.0-pro", "not a Qwen-Image / Z-Image model"),     # priced by size: not offered here
                 (t2i(), "qwen-image-2.0-pro", "not a Qwen-Image / Z-Image model"),
                 (t2i(), "", "not a Qwen-Image / Z-Image model"))
        for req, model, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.image().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entry_refuses_the_same(self):
        for mid in (QWEN_PRO, ZIMG):
            entry = reg.get(mid)
            a = self.image()
            self.assertEqual(a.problems(entry.probe_request(), entry), [], mid)
            self.assertTrue(a.problems(t2i(image_size="2K"), entry), mid)
            self.assertTrue(a.problems(t2i(quality="low"), entry), mid)

    def test_an_answer_that_is_not_a_picture_may_have_billed(self):
        for body in ({"output": {"choices": []}}, {"output": {"choices": [{"message": {"content": [{"text": "hi"}]}}]}},
                     {"output": {"choices": [{"message": {"content": [{"image": ""}]}}]}}, {"output": {}}, [], {"usage": {}}):
            self.vendor._routes.clear()
            self.vendor.on("POST", GEN, Resp(200, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.image().submit(t2i(), QWEN_PRO)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertFalse(cm.exception.not_accepted)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))

    def test_an_error_body_on_a_2xx_is_typed_not_an_empty_picture(self):
        self.vendor._routes.clear()
        self.vendor.on("POST", GEN, Resp(200, {"code": "DataInspectionFailed", "message": "bad content", "request_id": "r"}))
        with self.assertRaises(AdapterError) as cm:
            self.image().submit(t2i(), QWEN_PRO)
        self.assertEqual(cm.exception.code, E_POLICY)

    def test_a_lost_answer_may_have_billed_and_a_refusal_did_not(self):
        self.vendor._routes.clear()
        self.vendor.on("POST", GEN, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.image().submit(t2i(), ZIMG)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))
        self.vendor._routes.clear()
        self.vendor.on("POST", GEN, Resp(401, {"code": "InvalidApiKey", "message": "bad key"}))
        with self.assertRaises(AdapterError) as cm:
            self.image().submit(t2i(), ZIMG)
        self.assertEqual(cm.exception.code, E_AUTH)
        self.assertTrue(cm.exception.not_accepted)

    def test_a_picture_link_off_alibabas_result_buckets_is_refused_with_the_spend_note(self):
        for url in ("https://attacker.example/x.png", "https://some-customer-bucket.oss-cn-beijing.aliyuncs.com/x.png",
                    "http://dashscope-result.oss-cn-beijing.aliyuncs.com/x.png"):
            self.vendor._routes.clear()
            self.vendor.on("POST", GEN, Resp(200, image_answer(url)))
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.image(widen=False).submit(t2i(), QWEN_PRO)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)   # the picture exists and may be billed

    def test_an_expired_picture_link_is_not_an_auth_error(self):
        self.vendor.on("GET", "/gone.png", Resp(403, {"error": "expired"}))
        a = self.image()
        self.vendor._routes.clear()
        self.vendor.on("POST", GEN, Resp(200, image_answer(f"{self.vendor.base_url}/gone.png")))
        self.vendor.on("GET", "/gone.png", Resp(403, {"error": "expired"}))
        task = a.submit(t2i(), QWEN_PRO)
        with self.assertRaises(AdapterError) as cm:
            a.fetch(a.poll(task), self.tmp)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))

    def test_the_probe_stores_a_real_image_for_each_model(self):
        from tools.probe_models import run_probe

        for mid in (QWEN_PRO, QWEN_TURBO, ZIMG):
            self.vendor.requests.clear()
            self.widen()
            with mock.patch.object(alibaba.DashScopeImageAdapter, "result_hosts", ("localhost",)), \
                    mock.patch.object(alibaba.DashScopeImageAdapter, "result_ports", (None, 443, self.vendor.port)):
                res = run_probe(reg.get(mid), env=self.env, voice_id=None, workdir=self.tmp,
                                session=self.vendor.session(), sleep=lambda s: None)
            self.assertTrue(res.ok, (mid, res.message))
            self.assertEqual(self.sent().json()["model"], mid)


class SharedHelpersTests(unittest.TestCase):
    """The two additions to safe_fetch.py, pinned here so the other adapters cannot be changed by them."""

    def test_the_default_result_check_is_still_the_domain_allow_list(self):
        class Plain(SafeResultMixin, HttpAdapter):
            key, key_env, result_hosts = "video.plain", ("P_KEY",), ("example.test",)

        a = Plain(env={"P_KEY": KEY})
        self.assertEqual(a.checked_url("https://x.example.test/a.mp4"), "https://x.example.test/a.mp4")
        for url in ("https://example.test.evil.io/a.mp4", "http://x.example.test/a", "https://evil.io/example.test"):
            with self.assertRaises(AdapterError, msg=url):
                a.checked_url(url)

    def test_submit_json_passes_a_header_and_still_marks_a_lost_answer(self):
        class Plain(SafeResultMixin, HttpAdapter):
            key, key_env = "video.plain", ("P_KEY",)

        a = Plain(env={"P_KEY": KEY})
        seen = {}

        def post(url, body, *, what, **kw):
            seen.update(kw)
            raise AdapterError(E_UNAVAILABLE, "x")
        a.post = post
        with self.assertRaises(AdapterError) as cm:
            a.submit_json("https://x.test/", {}, headers={"X-DashScope-Async": "enable"})
        self.assertEqual(seen, {"headers": {"X-DashScope-Async": "enable"}})
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))


class WiringTests(unittest.TestCase):
    def test_results_come_only_from_alibabas_storage_domain_and_only_tests_widen_the_port(self):
        for cls in (alibaba.HappyHorseVideoAdapter, alibaba.DashScopeImageAdapter):
            self.assertEqual(cls.result_hosts, ("aliyuncs.com",))
            self.assertEqual(cls.result_ports, (None, 443))
        self.assertTrue(alibaba.RESULT_HOST_RE.fullmatch("dashscope-result.oss-cn-beijing.aliyuncs.com"))
        self.assertFalse(alibaba.RESULT_HOST_RE.fullmatch("oss-cn-beijing.aliyuncs.com"))

    def test_the_keys_are_the_ones_wan_already_has_on_the_worker_and_in_the_probe_workflow(self):
        # One Model Studio key serves every model in a region: nothing new to wire, and nothing to forget.
        self.assertEqual(alibaba.HappyHorseVideoAdapter.key_env, ("WAN_API_KEY", "DASHSCOPE_API_KEY"))
        self.assertEqual(alibaba.DashScopeImageAdapter.key_env, ("WAN_API_KEY", "DASHSCOPE_API_KEY"))
        text = (ROOT / "deploy" / ".env.worker.example").read_text()
        self.assertRegex(text, r"(?m)^WAN_API_KEY=$")                    # empty in the example, never a value
        self.assertRegex(text, r"(?m)^WAN_WORKSPACE_ID=$")
        self.assertIn("WORKERENV_WAN_API_KEY: ${{ secrets.WAN_API_KEY }}",
                      (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text())
        probe = (ROOT / ".github" / "workflows" / "probe_models.yml").read_text()
        self.assertIn("WAN_API_KEY: ${{ secrets.WAN_API_KEY }}", probe)
        self.assertIn("WAN_WORKSPACE_ID: ${{ vars.WAN_WORKSPACE_ID }}", probe)


if __name__ == "__main__":
    unittest.main()
