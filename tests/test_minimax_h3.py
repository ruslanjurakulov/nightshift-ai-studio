"""MiniMax H3 (the maker's own API, video generation V2): the adapter, the registry
entries, and the rule that none of it is for sale.

The adapter talks to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py):
no network, no key, no spend. The download rules are pinned in
tests/test_safe_fetch.py; here the point is that this adapter USES them.

What would break without these tests:

* a priced setting (resolution, duration) defaulted instead of refused: the price
  is per second of output and differs by resolution;
* a submit whose answer was lost being treated as "nothing was bought";
* the old Hailuo adapter (``/v1``, a flat prompt) being used for H3, which it cannot serve;
* a clip fetched from a host that is not MiniMax's, or a failed download reported
  as "nothing happened" when MiniMax had finished and billed;
* a message that tells a person a failed task was not billed (MiniMax does not say so);
* a model whose terms nobody has decided becoming sellable.
"""

from __future__ import annotations

import copy
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter
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
    T2V,
    AdapterError,
    CapabilityRequest,
    Output,
    PollResult,
    ProviderTask,
)
from modules.capabilities.minimax import BILLING_UNKNOWN, RESULT_HOSTS, MiniMaxH3Adapter
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url
from tests.test_creative_worker import JOB, ORG

ROOT = Path(__file__).resolve().parent.parent
KEY = "mm-test-NOT-A-REAL-KEY-0123456789abcdef"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
H3, HS, LITE, MAX = "minimax-h3", "minimax-h3-highspeed", "minimax-h3-lite", "minimax-h3-max"
NEW_IDS = (H3, HS, LITE, MAX)
PROBE_IDS = (*NEW_IDS, "minimax-hailuo-2.3")        # the Hailuo entry shares the Terms and the gate
CREATE = "/v2/video_generation"
QUERY = "/v2/query/video_generation/"


def tearDownModule():
    cleanup_certificate()


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def oai_error(kind: str, message: str) -> dict:
    return {"type": "error", "error": {"type": kind, "message": message, "http_code": "400"}, "request_id": "r1"}


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="mm_h3_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.env = {"MINIMAX_API_KEY": KEY, "MINIMAX_BASE_URL": self.vendor.base_url}

    def adapter(self, env=None, vendor=None) -> MiniMaxH3Adapter:
        v = vendor or self.vendor
        a = build_adapter("video.minimax_h3", env=env or self.env, session=v.session())
        a.result_hosts = ("localhost",)
        a.result_ports = (None, 443, v.port)
        return a

    def frame(self, name="first.png") -> str:
        p = self.tmp / name
        p.write_bytes(png())
        return str(p)


def t2v(**kw) -> CapabilityRequest:
    base = dict(capability=T2V, prompt="a boat at dawn", aspect_ratio="16:9", resolution="768p", duration_s=5)
    return CapabilityRequest(**{**base, **kw})


def i2v(first, **kw) -> CapabilityRequest:
    base = dict(capability=I2V, prompt="slow push in", resolution="768p", duration_s=5, input_images=(first,))
    return CapabilityRequest(**{**base, **kw})


# ── the registry: dark, gated, unpriced ────────────────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_the_four_models_are_registered_on_the_v2_adapter_not_the_hailuo_one(self):
        for mid in NEW_IDS:
            self.assertEqual(self.r[mid].adapter, "video.minimax_h3", mid)
            self.assertEqual(self.r[mid].provider, "minimax", mid)
        self.assertEqual(self.r["minimax-hailuo-2.3"].adapter, "video.minimax")
        self.assertEqual({mid: self.r[mid].vendor_model for mid in NEW_IDS},
                         {H3: "MiniMax-H3", HS: "MiniMax-H3-Highspeed", LITE: "MiniMax-H3-Lite", MAX: "MiniMax-H3-Max"})

    def test_the_old_adapter_cannot_serve_them(self):
        # video.minimax would send /v1 and a flat prompt: the registry must refuse the pairing.
        d = json.loads(reg.REGISTRY_PATH.read_text())
        m = copy.deepcopy(next(x for x in d["models"] if x["id"] == H3))
        m["adapter"] = "video.minimax"
        errs = reg.validate({**d, "models": [m]})
        self.assertTrue(errs, "the Hailuo adapter was accepted for an H3 model")

    def test_none_of_them_can_be_sold_until_a_person_has_decided_the_resale_question(self):
        for mid in (*NEW_IDS, "minimax-hailuo-2.3"):
            e = self.r[mid]
            self.assertEqual(e.terms_gate, "terms_review_required", mid)
            self.assertEqual(e.api_exposure, "web_only", mid)
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("2026-03-30", notes, mid)                    # the Terms version that was read
            self.assertIn("7(c)", notes, mid)
            self.assertIn("outside of any integrated applications", notes, mid)
            self.assertIn("NOT read", notes, mid)                      # says what was not read
            self.assertIn("guardian", notes, mid)
            self.assertNotIn("could not be read", notes, mid)          # the stale claim is gone

    def test_the_terms_gate_reaches_the_database_row(self):
        # sellable_models() (migration 0035) refuses any row whose spec.terms_gate is non-empty.
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in (*NEW_IDS, "minimax-hailuo-2.3"):
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "terms_review_required", mid)

    def test_h3_max_says_it_is_a_fal_post_train_and_that_it_is_the_owners_call(self):
        notes = " ".join(self.r[MAX].raw["terms_notes"])
        self.assertIn("post-trained by fal.ai", notes)
        self.assertIn("owner's decision", notes)
        for mid in (H3, HS, LITE):
            self.assertNotIn("fal.ai", " ".join(self.r[mid].raw["terms_notes"]), mid)

    def test_no_migration_or_price_file_prices_them(self):
        units = []
        for mid in NEW_IDS:
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, e.raw["pricing"]["unit"], k)
                      for k in (e.raw["pricing"].get("variants") or {}).get("prices", {})]
        self.assertTrue(all(u.startswith("model_minimax_h3_") for u in units), units)
        hits = []
        for folder in ("supabase/migrations", "docs", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".md", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row (or any other mention) would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_with_a_source(self):
        want = {H3: {"768p": 0.08, "2k": 0.13}, HS: {"768p": 0.06}, LITE: {"480p": 0.025, "768p": 0.04},
                MAX: {"480p": 0.05, "768p": 0.08}}
        for mid in NEW_IDS:
            p = self.r[mid].raw["pricing"]
            self.assertFalse(p["confirmed"], mid)
            self.assertEqual(p["source_url"], "https://platform.minimax.io/docs/pricing/overview", mid)
            self.assertEqual(p["as_of"], "2026-10-25", mid)
            self.assertIn("ESTIMATE", p["note"], mid)
            self.assertEqual(p["variants"]["by"], "resolution", mid)
            self.assertEqual(p["variants"]["prices"], want[mid], mid)
            self.assertEqual(p["provider_usd_per_unit"], p["variants"]["prices"][self.r[mid].default_resolution], mid)
            # the page does not say a failed task is free, so neither may the registry
            self.assertNotRegex(p["note"].lower(), r"(not billed|free of charge|no charge)", mid)
            self.assertIn("not stated", p["note"], mid)

    def test_the_2k_tier_is_labelled_2k_not_a_pixel_size_minimax_never_gave(self):
        self.assertEqual(self.r[H3].resolutions, ("768p", "2k"))
        for mid in (HS, LITE, MAX):
            self.assertNotIn("2k", self.r[mid].resolutions, mid)      # only H3 offers 2K
        for mid in NEW_IDS:
            self.assertNotIn("1440p", self.r[mid].resolutions, mid)

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        for mid in NEW_IDS:
            e = self.r[mid]
            spec = MiniMaxH3Adapter.SPECS[e.vendor_model]
            self.assertEqual(sorted(e.resolutions), sorted(spec["resolutions"]), mid)
            self.assertEqual(sorted(e.durations_s), sorted(spec["durations"]), mid)
            self.assertTrue(set(e.aspect_ratios) <= set(MiniMaxH3Adapter.RATIOS), mid)
            self.assertEqual(e.default_resolution, "768p", mid)       # the vendor's own default for all four
            self.assertEqual(e.max_prompt_chars, 7000, mid)
            self.assertTrue(e.end_frame and e.audio_out and e.is_async, mid)

    def test_pinned_resolution_is_a_listed_priced_one(self):
        for mid in NEW_IDS:
            e = self.r[mid]
            self.assertIn(e.default_resolution, e.raw["pricing"]["variants"]["prices"], mid)
            self.assertEqual(e.variants_by, "resolution", mid)

    def test_probes_are_servable_cheap_and_prove_the_end_frame_that_is_sold(self):
        for mid in NEW_IDS:
            req = self.r[mid].probe_request(generated_image="/p/first.png", generated_end_image="/p/end.png")
            self.assertEqual((req.capability, req.end_image), (I2V, "/p/end.png"), mid)
            self.assertIsNone(req.aspect_ratio, mid)                  # i2v keeps the picture's shape
            self.assertLessEqual(req.duration_s, 5, mid)
        self.assertEqual(self.r[LITE].probe_request(generated_image="x").resolution, "480p")   # the cheapest tier

    def test_the_stale_hailuo_note_is_replaced_by_one_that_cites_the_terms_that_were_read(self):
        notes = " ".join(self.r["minimax-hailuo-2.3"].raw["terms_notes"])
        self.assertIn("effective 2026-03-30", notes)
        self.assertIn("an earlier note here called them unreadable", notes)

    def test_the_schema_takes_2k_and_4k_and_still_refuses_look_alikes(self):
        schema = reg.load_schema()
        res = schema["$defs"]["resolution"]
        for ok in ("480p", "768p", "1080p", "2k", "4k"):
            self.assertEqual(reg.schema_errors(ok, res, schema), [], ok)
        for bad in ("2K", "4K", "3k", "8k", "k2", "2 k", "2kk", "1440", "p", "", "20k", "02k"):
            self.assertTrue(reg.schema_errors(bad, res, schema), repr(bad))


# ── what is sent ───────────────────────────────────────────────────────────────

class SubmitTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", CREATE, Resp(200, {"task_id": "424010985738629"}))

    def sent(self):
        (req,) = self.vendor.seen("POST", CREATE)
        return req

    def test_text_to_video_sends_every_priced_setting_explicitly_on_the_v2_path(self):
        task = self.adapter().submit(t2v(), "MiniMax-H3")
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("video.minimax_h3", "MiniMax-H3", "424010985738629"))
        req = self.sent()
        self.assertEqual(req.path, CREATE)
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.json(), {"model": "MiniMax-H3", "resolution": "768P", "duration": 5, "ratio": "16:9",
                                      "content": [{"type": "text", "text": "a boat at dawn"}]})

    def test_the_2k_label_goes_out_as_2K_and_each_model_gets_its_own_vendor_name(self):
        self.adapter().submit(t2v(resolution="2k"), "MiniMax-H3")
        self.assertEqual(self.sent().json()["resolution"], "2K")
        for model, res in (("MiniMax-H3-Highspeed", "768p"), ("MiniMax-H3-Lite", "480p"), ("MiniMax-H3-Max", "480p")):
            self.vendor.requests.clear()
            self.adapter().submit(t2v(resolution=res, duration_s=6), model)
            body = self.sent().json()
            self.assertEqual((body["model"], body["resolution"]), (model, res.upper()))

    def test_text_to_video_without_a_ratio_gets_a_concrete_one_because_adaptive_is_refused_by_the_vendor(self):
        self.adapter().submit(t2v(aspect_ratio=None), "MiniMax-H3")
        self.assertEqual(self.sent().json()["ratio"], "16:9")

    def test_picture_to_video_sends_the_first_frame_and_no_ratio(self):
        self.adapter().submit(i2v(self.frame()), "MiniMax-H3")
        body = self.sent().json()
        self.assertNotIn("ratio", body)                                   # the picture's own shape ("adaptive")
        self.assertEqual([c["type"] for c in body["content"]], ["text", "image_url"])
        pic = body["content"][1]
        self.assertEqual(pic["role"], "first_frame")
        self.assertTrue(pic["image_url"]["url"].startswith("data:image/png;base64,"))
        self.vendor.requests.clear()
        self.adapter().submit(i2v("https://example.invalid/still.png"), "MiniMax-H3")
        self.assertEqual(self.sent().json()["content"][1],
                         {"type": "image_url", "role": "first_frame", "image_url": {"url": "https://example.invalid/still.png"}})

    def test_the_last_frame_rides_with_its_own_role(self):
        self.adapter().submit(i2v(self.frame("a.png"), end_image=self.frame("b.png")), "MiniMax-H3-Lite")
        content = self.sent().json()["content"]
        self.assertEqual([c.get("role") for c in content], [None, "first_frame", "last_frame"])

    def test_a_ratio_for_picture_to_video_is_refused_not_ignored(self):
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(i2v(self.frame(), aspect_ratio="9:16"), "MiniMax-H3")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertTrue(cm.exception.not_accepted)
        self.assertIn("own shape", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_a_setting_the_price_depends_on_is_refused_before_any_call_never_defaulted(self):
        cases = (
            ("MiniMax-H3", t2v(resolution=None), "resolution"),               # the vendor's default is not a quote
            ("MiniMax-H3", t2v(resolution="1080p"), "resolution"),
            ("MiniMax-H3", t2v(resolution="2K"), "resolution"),               # the registry label is 2k
            ("MiniMax-H3", t2v(resolution="1440p"), "resolution"),
            ("MiniMax-H3-Highspeed", t2v(resolution="2k"), "resolution"),     # 2K is H3 only
            ("MiniMax-H3-Lite", t2v(resolution="2k"), "resolution"),
            ("MiniMax-H3-Max", t2v(resolution="2k"), "resolution"),
            ("MiniMax-H3-Highspeed", t2v(resolution="480p"), "resolution"),
            ("MiniMax-H3", t2v(duration_s=None), "duration"),
            ("MiniMax-H3", t2v(duration_s=3), "duration"),
            ("MiniMax-H3", t2v(duration_s=16), "duration"),
            ("MiniMax-H3", t2v(duration_s=True), "duration"),
            ("MiniMax-H3-Max", t2v(duration_s=4), "duration"),                # Max starts at 5 s
            ("MiniMax-H3", t2v(aspect_ratio="7:3"), "aspect ratio"),
            ("MiniMax-H3", t2v(aspect_ratio="adaptive"), "aspect ratio"),
            ("MiniMax-Hailuo-2.3", t2v(), "not a MiniMax H3 model"),          # the old family is the old adapter's
            ("MiniMax-H3-Regeneration", t2v(), "not a MiniMax H3 model"),
            ("", t2v(), "not a MiniMax H3 model"),
            ("MiniMax-H3", t2v(prompt="  "), "needs words"),
            ("MiniMax-H3", t2v(prompt="x" * 7001), "longer than 7000"),
            ("MiniMax-H3", t2v(input_images=("a.png",)), "does not apply to text-to-video"),
            ("MiniMax-H3", t2v(end_image="a.png"), "does not apply to text-to-video"),
            ("MiniMax-H3", CapabilityRequest(I2V, "x", resolution="768p", duration_s=5), "exactly one first-frame"),
            ("MiniMax-H3", CapabilityRequest(I2V, "", resolution="768p", duration_s=5,
                                             input_images=("https://example.invalid/a.png",)), "needs words"),
            ("MiniMax-H3", CapabilityRequest(I2V, "x", resolution="768p", duration_s=5,
                                             input_images=("https://example.invalid/a.png", "https://example.invalid/b.png")),
             "exactly one first-frame"),
        )
        for model, req, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.adapter().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message, (model, req))
        self.assertEqual(self.vendor.requests, [])

    def test_a_prompt_at_exactly_the_limit_is_sent(self):
        self.adapter().submit(t2v(prompt="x" * 7000), "MiniMax-H3")
        self.assertEqual(len(self.sent().json()["content"][0]["text"]), 7000)

    def test_max_takes_five_seconds_and_the_others_four(self):
        self.adapter().submit(t2v(duration_s=5, resolution="480p"), "MiniMax-H3-Max")
        self.adapter().submit(t2v(duration_s=4, resolution="480p"), "MiniMax-H3-Lite")
        self.adapter().submit(t2v(duration_s=15), "MiniMax-H3")
        self.assertEqual([r.json()["duration"] for r in self.vendor.seen("POST", CREATE)], [5, 4, 15])

    def test_a_picture_that_cannot_be_sent_is_a_refusal_not_a_crash(self):
        big = self.tmp / "big.png"
        big.write_bytes(b"\x89PNG" + b"\0" * (MiniMaxH3Adapter.MAX_IMAGE_BYTES + 1))
        gif = self.tmp / "x.gif"
        gif.write_bytes(b"GIF89a")
        for pic, fragment in ((str(self.tmp / "missing.png"), "could not be read"), (str(big), "over 20 MB"),
                              (str(gif), "JPG, PNG or WEBP"), ("http://example.invalid/a.png", "https link")):
            with self.assertRaises(AdapterError, msg=pic) as cm:
                self.adapter().submit(i2v(pic), "MiniMax-H3")
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, pic)
            self.assertTrue(cm.exception.not_accepted, pic)
            self.assertIn(fragment, cm.exception.message, pic)
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(i2v(self.frame(), end_image=str(self.tmp / "gone.png")), "MiniMax-H3")
        self.assertIn("last-frame", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_a_soundtrack_flag_is_refused_because_h3_has_none_to_set(self):
        entry = reg.get(H3)
        for audio in (True, False):
            self.assertTrue(any("audio flag" in p for p in self.adapter().problems(t2v(audio=audio), entry)), audio)
        self.assertEqual(self.adapter().problems(t2v(), entry), [])

    def test_the_registry_entry_refuses_what_the_adapter_would_refuse(self):
        entry = reg.get(MAX)
        a = self.adapter()
        self.assertEqual(a.problems(entry.probe_request(generated_image="https://p/x.png",
                                                        generated_end_image="https://p/y.png"), entry), [])
        self.assertTrue(a.problems(t2v(resolution=None), entry))
        self.assertTrue(a.problems(t2v(duration_s=None), entry))
        self.assertTrue(a.problems(t2v(duration_s=4, resolution="480p"), entry))
        self.assertTrue(any("own shape" in p for p in a.problems(i2v("https://p/x.png", aspect_ratio="16:9"), entry)))
        self.assertTrue(any("needs words" in p for p in a.problems(
            CapabilityRequest(I2V, "", resolution="768p", duration_s=5, input_images=("https://p/x.png",)), entry)))

    def test_no_key_is_a_refusal_before_any_call(self):
        a = build_adapter("video.minimax_h3", env={"MINIMAX_BASE_URL": self.vendor.base_url}, session=self.vendor.session())
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), "MiniMax-H3")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_the_limits_and_the_default_endpoint_are_the_documented_ones(self):
        self.assertEqual(MiniMaxH3Adapter.MAX_IMAGE_BYTES, 20 * 1024 * 1024)          # MiniMax takes 30 MB; sent inline, 64 MB body
        self.assertEqual(MiniMaxH3Adapter.MAX_PROMPT_UNITS, 7000)
        a = build_adapter("video.minimax_h3", env={"MINIMAX_API_KEY": KEY})
        self.assertEqual(a.base_url, "https://api.minimax.io")
        self.assertEqual(build_adapter("video.minimax_h3", env={"MINIMAX_API_KEY": KEY,
                                                                "MINIMAX_BASE_URL": "http://evil.example"}).base_url,
                         "https://api.minimax.io")                                    # the key never goes out in clear text

    def test_a_picture_just_over_the_inline_limit_is_refused_and_one_at_the_limit_is_not(self):
        import os

        at = self.tmp / "at.png"
        at.write_bytes(b"\x89PNG")
        os.truncate(at, 20 * 1024 * 1024)
        over = self.tmp / "over.png"
        over.write_bytes(b"\x89PNG")
        os.truncate(over, 20 * 1024 * 1024 + 1)
        self.assertEqual(self.adapter()._picture_problem(str(at), "x"), None)
        self.assertIn("over 20 MB", self.adapter()._picture_problem(str(over), "x"))

    def test_the_hailuo_adapter_is_untouched(self):
        self.assertEqual(ADAPTERS["video.minimax"].default_base_url, "https://api.minimax.io")
        self.assertEqual(ADAPTERS["video.minimax_h3"].key_env, ADAPTERS["video.minimax"].key_env)


class LostAnswerTests(VendorCase):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
        self.assertNotIn(KEY, cm.exception.message)

    def test_a_connection_dropped_after_the_request_arrived_may_have_billed(self):
        self.vendor.on("POST", CREATE, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2v(), "MiniMax-H3")
        self.assertUnconfirmed(cm, E_UNAVAILABLE)
        self.assertEqual(len(self.vendor.seen("POST", CREATE)), 1)

    def test_a_read_timeout_may_have_billed(self):
        self.vendor.on("POST", CREATE, Resp(200, {"task_id": "late"}, hang_s=1.5))
        a = self.adapter()
        a.timeout = 0.4
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), "MiniMax-H3")
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_5xx_may_have_billed_even_with_a_polite_error_body(self):
        for status in (500, 502, 503, 529):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", CREATE, Resp(status, oai_error("server_error", "internal error (1000)")))
            a = self.adapter({"MINIMAX_API_KEY": KEY, "MINIMAX_BASE_URL": vendor.base_url}, vendor)
            with self.assertRaises(AdapterError, msg=status) as cm:
                a.submit(t2v(), "MiniMax-H3")
            self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_task_id_may_have_billed(self):
        for body in ({}, {"task_id": ""}, {"task_id": 7}, {"task_id": None}, {"task_id": "../../v1/files"},
                     {"task_id": "x" * 300}, {"task": {"id": "1"}}, oai_error("server_error", "x"), [], None):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", CREATE, Resp(200, body))
            a = self.adapter({"MINIMAX_API_KEY": KEY, "MINIMAX_BASE_URL": vendor.base_url}, vendor)
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                a.submit(t2v(), "MiniMax-H3")
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_2xx_that_is_not_json_may_have_billed(self):
        self.vendor.on("POST", CREATE, Resp(200, raw=b"<html>gateway</html>"))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2v(), "MiniMax-H3")
        self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.adapter({"MINIMAX_API_KEY": KEY, "MINIMAX_BASE_URL": closed_port_url()})
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2v(), "MiniMax-H3")
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_outright_refusals_are_proof_and_name_the_right_remedy(self):
        cases = ((401, oai_error("authorized_error", "login fail: Please carry the API secret key (1004)"), E_AUTH),
                 (402, oai_error("insufficient_balance_error", "insufficient balance (1008)"), E_QUOTA),
                 (429, oai_error("rate_limit_error", "rate limit, please retry later (1002)"), E_RATE_LIMITED),
                 (404, {"error": "no such route"}, E_NOT_FOUND))
        for status, body, want in cases:
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", CREATE, Resp(status, body))
            a = self.adapter({"MINIMAX_API_KEY": KEY, "MINIMAX_BASE_URL": vendor.base_url}, vendor)
            with self.assertRaises(AdapterError, msg=status) as cm:
                a.submit(t2v(), "MiniMax-H3")
            self.assertEqual(cm.exception.code, want, status)
            self.assertTrue(cm.exception.not_accepted, status)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, status)

    def test_the_vendors_own_4xx_about_the_request_is_typed_and_not_dressed_as_a_lost_answer(self):
        cases = ((400, oai_error("bad_request_error", "invalid params, content must include a non-empty text item (2013)"),
                  E_BAD_REQUEST),
                 (422, oai_error("unprocessable_entity_error", "video description contains sensitive content (1026)"),
                  E_POLICY))
        for status, body, want in cases:
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", CREATE, Resp(status, body))
            a = self.adapter({"MINIMAX_API_KEY": KEY, "MINIMAX_BASE_URL": vendor.base_url}, vendor)
            with self.assertRaises(AdapterError, msg=status) as cm:
                a.submit(t2v(), "MiniMax-H3")
            self.assertEqual(cm.exception.code, want, status)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, status)

    def test_a_key_the_vendor_echoes_in_an_error_is_scrubbed(self):
        self.vendor.on("POST", CREATE, Resp(401, oai_error("authorized_error", f"bad key {KEY}")))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2v(), "MiniMax-H3")
        self.assertNotIn(KEY, cm.exception.message)

    def test_the_vendors_own_codes_beat_a_misleading_status(self):
        # a 403 whose body is a balance error is a quota problem, not a rejected key
        self.vendor.on("POST", CREATE, Resp(403, oai_error("insufficient_balance_error", "insufficient balance (1008)")))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2v(), "MiniMax-H3")
        self.assertEqual(cm.exception.code, E_QUOTA)
        a = self.adapter()
        for message, want in (("login fail (1004)", E_AUTH), ("rate limit (1002)", E_RATE_LIMITED),
                              ("insufficient balance (1008)", E_QUOTA), ("sensitive (1026)", E_POLICY),
                              ("invalid params (2013)", E_BAD_REQUEST), ("internal error (1000)", E_UNAVAILABLE),
                              ("brand new (9999)", None), ("no code at all", None)):
            body = json.dumps({"type": "error", "error": {"message": message}})
            self.assertEqual(a.vendor_error_code(400, body), want, message)
        self.assertIsNone(a.vendor_error_code(400, "not json"))
        # the error type alone is enough, with no number in the message (and it wins over a number that disagrees)
        for kind, want in (("authorized_error", E_AUTH), ("insufficient_balance_error", E_QUOTA),
                           ("rate_limit_error", E_RATE_LIMITED), ("bad_request_error", E_BAD_REQUEST),
                           ("unprocessable_entity_error", E_POLICY), ("overloaded_error", E_UNAVAILABLE),
                           ("server_error", E_UNAVAILABLE)):
            self.assertEqual(a.vendor_error_code(400, json.dumps({"error": {"type": kind, "message": "words only"}})), want, kind)
        self.assertEqual(a.vendor_error_code(400, json.dumps({"error": {"type": "authorized_error", "message": "x (1008)"}})), E_AUTH)
        self.assertIsNone(a.vendor_error_code(400, json.dumps({"error": {"type": "brand_new_error", "message": "x"}})))


# ── polling and the result ────────────────────────────────────────────────────────

class PollTests(VendorCase):
    def task(self, body, tid="424010985738629", code=200):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", QUERY + tid, Resp(code, body))
        return self.adapter().poll(ProviderTask("video.minimax_h3", "MiniMax-H3", tid))

    def test_queued_and_running_are_pending_and_polling_sends_the_key_only_to_the_api(self):
        for status in ("queued", "running", "RUNNING"):
            self.assertEqual(self.task({"task": {"id": "1", "status": status}}).state, PENDING, status)
        (req,) = self.vendor.seen("GET", QUERY)
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(self.vendor.seen("POST", ""), [])                 # polling never submits

    def test_succeeded_hands_back_the_clip_link(self):
        res = self.task({"task": {"id": "1", "status": "succeeded", "content": {"url": f"{self.vendor.base_url}/o.mp4"},
                                  "resolution": "2K", "duration": 5, "usage": {"output_seconds": 5}}})
        self.assertEqual(res.state, SUCCEEDED)
        self.assertEqual((res.outputs[0].mime, res.outputs[0].url), ("video/mp4", f"{self.vendor.base_url}/o.mp4"))

    def test_succeeded_without_a_link_or_with_a_foreign_one_is_an_error_that_says_the_spend_may_have_happened(self):
        for task in ({"status": "succeeded"}, {"status": "succeeded", "content": {}},
                     {"status": "succeeded", "content": {"url": ""}}, {"status": "succeeded", "content": {"url": 7}}):
            with self.assertRaises(AdapterError, msg=task) as cm:
                self.task({"task": task})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)
        for url in ("https://attacker.example/o.mp4", "http://video-product.cdn.minimax.io/o.mp4",
                    "https://minimax.io.evil.io/o.mp4", "https://evilminimax.io/o.mp4", "https://hailuoai.com.evil.io/o.mp4",
                    "https://user:pw@cdn.hailuoai.com/o.mp4", "https://cdn.hailuoai.com:8443/o.mp4",
                    "https://cdn.hailuoai.com\\@evil.example/o.mp4", "ftp://cdn.hailuoai.com/o.mp4"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.task({"task": {"status": "succeeded", "content": {"url": url}}})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)    # MiniMax said done: it may be billed

    def test_the_hosts_the_docs_examples_show_are_the_ones_allowed_and_only_vendor_domains(self):
        self.assertEqual(RESULT_HOSTS, ("minimax.io", "hailuoai.com"))
        self.assertEqual(MiniMaxH3Adapter.result_hosts, RESULT_HOSTS)
        self.assertEqual(MiniMaxH3Adapter.result_ports, (None, 443))
        a = build_adapter("video.minimax_h3", env=self.env, session=self.vendor.session())
        for url in ("https://video-product.cdn.minimax.io/inference_output/rollout/2026-07-27/x/output.mp4",
                    "https://cdn.hailuoai.com/prod/hailuo_demo/x.mp4"):
            res = a.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]))
            self.assertEqual(res.state, SUCCEEDED, url)

    def test_failed_carries_the_vendors_code_the_right_remedy_and_never_claims_it_was_free(self):
        cases = (("1026", "video description contains sensitive content", E_POLICY),
                 ("1002", "rate limit", E_RATE_LIMITED),
                 ("1004", "login fail", E_AUTH),
                 ("1008", "insufficient balance", E_QUOTA),
                 ("2013", "invalid params", E_BAD_REQUEST),
                 ("1000", "internal error", E_UNAVAILABLE),
                 ("9999", "something blocked by safety policy", E_POLICY),      # an unknown code, a policy word
                 ("9999", "gpu on fire", E_UNAVAILABLE),
                 (None, "oops", E_UNAVAILABLE))
        for code, message, want in cases:
            err = {"message": message}
            if code is not None:
                err["code"] = code
            res = self.task({"task": {"status": "failed", "error": err}})
            self.assertEqual((res.state, res.error.code), (FAILED, want), (code, message))
            self.assertTrue(res.error.message.endswith(BILLING_UNKNOWN), res.error.message)
            self.assertNotRegex(res.error.message.lower(), r"not (be )?billed(?! is)|free of charge|no charge")
        self.assertEqual(self.task({"task": {"status": "failed"}}).error.code, E_UNAVAILABLE)

    def test_cancelled_is_a_failure_with_the_billing_caveat(self):
        res = self.task({"task": {"status": "cancelled"}})
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))
        self.assertIn("cancelled", res.error.message)
        self.assertIn(BILLING_UNKNOWN, res.error.message)

    def test_a_status_we_do_not_know_or_a_missing_task_is_an_error_not_an_endless_wait(self):
        for body in ({"task": {"status": "reticulating"}}, {"task": {}}, {"task": {"status": None}}, {"task": "x"},
                     {}, [], None):
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.task(body)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, repr(body))

    def test_a_key_the_vendor_echoes_in_a_failure_is_scrubbed(self):
        res = self.task({"task": {"status": "failed", "error": {"code": "1000", "message": f"token {KEY} rejected"}}})
        self.assertNotIn(KEY, res.error.message)

    def test_a_task_id_that_could_steer_the_request_is_refused(self):
        for tid in ("../../v1/files", "a/b", "a?b=c", "", "x" * 300, "a b"):
            with self.assertRaises(AdapterError, msg=repr(tid)) as cm:
                self.adapter().poll(ProviderTask("video.minimax_h3", "MiniMax-H3", tid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_is_typed_and_the_job_stays_pollable(self):
        with self.assertRaises(AdapterError) as cm:
            self.task(oai_error("server_error", "internal error (1000)"), code=500)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)               # the task is still MiniMax's: poll again
        with self.assertRaises(AdapterError) as cm:
            self.task(oai_error("authorized_error", "login fail (1004)"), code=401)
        self.assertEqual(cm.exception.code, E_AUTH)
        with self.assertRaises(AdapterError) as cm:
            self.task(oai_error("rate_limit_error", "rate limit (1002)"), code=429)
        self.assertEqual(cm.exception.code, E_RATE_LIMITED)

    def test_a_task_outside_the_seven_day_window_is_not_found_and_does_not_claim_it_was_free(self):
        with self.assertRaises(AdapterError) as cm:
            self.task(oai_error("bad_request_error", "invalid task_id (2013)"), code=400)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertIn("7 days", cm.exception.message)
        self.assertIn("billed", cm.exception.message)
        # the same words on a server error are not a missing task: the job stays pollable
        with self.assertRaises(AdapterError) as cm:
            self.task(oai_error("server_error", "could not load task_id from the store (1000)"), code=500)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        # any other 400 stays a bad request
        with self.assertRaises(AdapterError) as cm:
            self.task(oai_error("bad_request_error", "invalid params (2013)"), code=400)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)


class EndToEndTests(VendorCase):
    """submit -> poll (queued, running, succeeded) -> fetch through the probe runner."""

    def run_probe(self, polls, *, entry_id=LITE, timeout_s=600):
        from tools.probe_models import run_probe

        self.vendor.on("POST", CREATE, Resp(200, {"task_id": "424010985738629"}))
        self.vendor.on("GET", QUERY + "424010985738629", polls)
        self.vendor.on("GET", "/o.mp4", Resp(200, raw=MP4))
        clock = {"t": 0.0}
        with mock.patch.object(MiniMaxH3Adapter, "result_hosts", ("localhost",)), \
                mock.patch.object(MiniMaxH3Adapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(entry_id), env=self.env, voice_id=None, workdir=self.tmp, timeout_s=timeout_s,
                             poll_every_s=5, session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def done(self, name="o.mp4"):
        return Resp(200, {"task": {"id": "1", "status": "succeeded", "content": {"url": f"{self.vendor.base_url}/{name}"}}})

    def test_the_probe_runs_the_whole_chain_and_stores_a_real_clip(self):
        res = self.run_probe([Resp(200, {"task": {"status": "queued"}}), Resp(200, {"task": {"status": "running"}}), self.done()])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(MP4))
        (req,) = self.vendor.seen("POST", CREATE)
        body = req.json()
        self.assertEqual((body["model"], body["resolution"], body["duration"]), ("MiniMax-H3-Lite", "480P", 4))
        self.assertEqual([c.get("role") for c in body["content"]], [None, "first_frame", "last_frame"])
        self.assertTrue(all(c["image_url"]["url"].startswith("data:image/png;base64,") for c in body["content"][1:]))
        self.assertEqual(len(self.vendor.seen("POST", CREATE)), 1)         # polling never re-submitted
        self.assertEqual(list(self.tmp.glob("*.part")), [])

    def test_a_job_that_never_finishes_ends_as_a_timeout_that_names_the_task(self):
        res = self.run_probe([Resp(200, {"task": {"status": "running"}})], timeout_s=30)
        self.assertFalse(res.ok)
        self.assertEqual((res.code, res.task_id), ("timeout", "424010985738629"))   # it may still bill: the id is kept
        self.assertEqual(len(self.vendor.seen("POST", CREATE)), 1)

    def test_an_expired_clip_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/expired.mp4", Resp(403, {"error": "signature expired"}))
        res = self.run_probe([self.done("expired.mp4")])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_NOT_FOUND)
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)

    def test_a_truncated_or_wrong_file_leaves_no_clip_behind(self):
        self.vendor.on("GET", "/html.mp4", Resp(200, raw=b"<html>not a video</html>"))
        res = self.run_probe([self.done("html.mp4")])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_BAD_RESPONSE)
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)
        self.assertEqual(list(self.tmp.glob("*.mp4")), [])

    def test_a_failed_task_is_a_failed_probe_with_the_vendors_reason(self):
        res = self.run_probe([Resp(200, {"task": {"status": "failed", "error": {"code": "1026", "message": "sensitive"}}})])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_POLICY)

    def test_the_creative_bridge_keeps_the_difference_between_a_lost_answer_and_a_refusal(self):
        entry = reg.get(H3)

        def bridged(env, vendor):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2v", model=entry.id,
                                                  params=dict(prompt="a boat", duration_s=5, resolution="768p",
                                                              aspect_ratio="16:9"),
                                                  input_files=()))
        with self.assertRaises(ca.CreativeAdapterError) as cm:           # the job carries no resolution: not quoted
            ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=self.env, session=self.vendor.session()),
                               sync_store={}).submit(cw.GenerationRequest(
                job_id=JOB, org_id=ORG, capability="t2v", model=entry.id, params=dict(prompt="a boat", duration_s=5),
                input_files=()))
        self.assertIn("no resolution", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])
        self.vendor.on("POST", CREATE, Resp(drop=True))
        with self.assertRaises(AdapterError) as lost:
            bridged(self.env, self.vendor)
        self.assertFalse(lost.exception.not_accepted)            # the worker must not move this job to another model
        refused = FakeVendor()
        self.addCleanup(refused.close)
        refused.on("POST", CREATE, Resp(401, oai_error("authorized_error", "login fail (1004)")))
        with self.assertRaises(AdapterError) as no:
            bridged({"MINIMAX_API_KEY": KEY, "MINIMAX_BASE_URL": refused.base_url}, refused)
        self.assertTrue(no.exception.not_accepted)




class ProbeSkipsGatedTests(unittest.TestCase):
    """``--all`` (and the probe workflow with an empty model input) never makes a paid call to
    these models; naming one still probes it, and only it."""

    ENV = {name: "k" * 24 for cls in ADAPTERS.values() for name in cls.key_env}

    def run_main(self, argv):
        from tools import probe_models

        out, called = io.StringIO(), []
        db = mock.Mock()
        db.record.return_value = 1
        db.sync.return_value = 0

        def fake_probe(entry, **kw):
            called.append(entry.id)
            return probe_models.ProbeResult(entry.id, True, latency_ms=1, output_bytes=1)

        with mock.patch.object(probe_models, "run_probe", side_effect=fake_probe), \
                mock.patch("requests.Session.request", side_effect=AssertionError("network")):
            code = probe_models.main(argv, env=self.ENV, db=db, stream=out)
        return code, called, out.getvalue()

    def test_all_skips_every_one_of_them_and_says_so(self):
        from tools import probe_models

        entries = list(reg.registry().values())
        chosen = {e.id for e in probe_models.select(entries, [], None, True)}
        self.assertFalse(chosen & set(PROBE_IDS), chosen & set(PROBE_IDS))
        for cap in ("t2v", "i2v", "t2i"):
            self.assertFalse({e.id for e in probe_models.select(entries, [], cap, True)} & set(PROBE_IDS), cap)
        code, called, text = self.run_main(["--all", "--brief"])
        self.assertEqual(code, 0)
        self.assertTrue(called)
        self.assertFalse(set(called) & set(PROBE_IDS), set(called) & set(PROBE_IDS))
        for mid in PROBE_IDS:
            self.assertIn(f"gated {mid}", text)                    # said in the log, nothing else about it
            self.assertNotIn(f"ok {mid}", text)

    def test_naming_one_probes_it_and_only_it(self):
        for mid in PROBE_IDS:
            _, called, _ = self.run_main(["--model", mid])
            self.assertEqual(called, [mid], mid)


class WiringTests(unittest.TestCase):
    def test_the_key_is_one_the_worker_can_already_be_given(self):
        text = (ROOT / "deploy" / ".env.worker.example").read_text()
        self.assertRegex(text, r"(?m)^MINIMAX_API_KEY=$")                # empty in the example, never a value
        self.assertIn("WORKERENV_MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}",
                      (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text())
        self.assertIn("MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}",
                      (ROOT / ".github" / "workflows" / "probe_models.yml").read_text())
        self.assertIn('"MINIMAX_API_KEY"', (ROOT / "tools" / "doctor.py").read_text())

    def test_results_come_only_from_minimax_hosts_and_only_tests_widen_the_port(self):
        self.assertEqual(MiniMaxH3Adapter.result_ports, (None, 443))


if __name__ == "__main__":
    unittest.main()
