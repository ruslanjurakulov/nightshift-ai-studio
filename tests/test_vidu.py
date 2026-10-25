"""Vidu Q3 (Pro, Turbo, Pro Fast) and Q4 preview (Shengshu's own API): the adapter, the registry entries, and the
rule that none of it is for sale.

The adapter talks to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py): no network, no key, no spend.
The download rules themselves are pinned in tests/test_safe_fetch.py; here the point is that this adapter USES them,
and that where the real result host is not known the download fails closed.

What would break without these tests:

* a priced setting (resolution, duration) defaulted instead of refused: Vidu bills credits per second by model and
  resolution, and its own defaults (5 s, 720p) are not what a person was quoted;
* image-to-video leaving ``is_rec`` to the vendor: on Q4 preview the default is true, the system writes (and bills) a
  prompt and ignores the one the person typed;
* the key following a redirect, or going to a link the vendor put in a JSON body (a result link, a task id that
  steers the poll path);
* a result link on a host nobody has allowed being downloaded (it is valid for 24 h: it must be stored at once, and
  it must be stored only from a host a person has checked);
* a submit whose answer was lost being treated as "nothing was bought";
* a model whose terms nobody has settled becoming sellable.
"""

from __future__ import annotations

import io
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import build_adapter, vidu
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
    ProviderTask,
)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url
from tests.test_creative_worker import JOB, ORG

ROOT = Path(__file__).resolve().parent.parent
KEY = "vidu-test-NOT-A-REAL-KEY-0123456789abcdef"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
IDS = ("vidu-q3-pro", "vidu-q3-turbo", "vidu-q3-pro-fast", "vidu-q4-preview")
VENDOR = {"vidu-q3-pro": "viduq3-pro", "vidu-q3-turbo": "viduq3-turbo", "vidu-q3-pro-fast": "viduq3-pro-fast",
          "vidu-q4-preview": "viduq4-preview"}
T2V_PATH, I2V_PATH, END_PATH = "/ent/v2/text2video", "/ent/v2/img2video", "/ent/v2/start-end2video"
#: credits per second on the pricing page (read 2026-10-25) -> dollars at the estimate's $0.005 per credit.
CREDITS = {
    "vidu-q3-pro": {"540p": 9, "720p": 20, "1080p": 24},
    "vidu-q3-turbo": {"540p": 7, "720p": 12, "1080p": 13},
    "vidu-q3-pro-fast": {"720p": 12, "1080p": 15},
    "vidu-q4-preview": {"540p": 9, "720p": 19, "1080p": 24, "2k": 38, "4k": 78},
}


def tearDownModule():
    cleanup_certificate()


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def req(**kw) -> CapabilityRequest:
    base = dict(capability=T2V, prompt="a boat at dawn", resolution="720p", duration_s=5)
    return CapabilityRequest(**{**base, **kw})


class Case(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="vidu_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def frame(self, name="first.png") -> str:
        p = self.tmp / name
        p.write_bytes(png())
        return str(p)

    def adapter(self, *, hosts=("localhost",), env=None) -> vidu.ViduVideoAdapter:
        env = env if env is not None else {"VIDU_API_KEY": KEY, "VIDU_BASE_URL": self.vendor.base_url}
        a = build_adapter("video.vidu", env=env, session=self.vendor.session())
        if hosts is not None:
            a.result_hosts = hosts
            a.result_ports = (None, 443, self.vendor.port)
        return a


# ══ the registry ═════════════════════════════════════════════════════════════════

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_each_entry_is_on_vidus_adapter_with_the_vendor_model_the_docs_name(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual((e.adapter, e.provider, e.vendor_model), ("video.vidu", "vidu", VENDOR[mid]), mid)

    def test_the_gate_is_terms_review_and_nothing_can_be_sold(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual((e.terms_gate, e.api_exposure), ("terms_review_required", "web_only"), mid)
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "terms_review_required", mid)   # sellable_models() refuses it
            notes = " ".join(e.raw["terms_notes"])
            self.assertRegex(notes, r"NOT read", mid)                       # says what was not read
            self.assertIn("Gate stays open", notes, mid)
            self.assertIn("Uzbekistan", notes, mid)

    def test_the_clauses_the_gate_rests_on_are_quoted_with_their_clause_number(self):
        for mid in IDS:
            notes = " ".join(self.r[mid].raw["terms_notes"])
            self.assertIn("clause 4 'Content Generated by End Users'", notes, mid)
            self.assertIn("You may not sell the Vidu-related technology directly or indirectly without obtaining the "
                          "necessary approval from regulatory authorities and the prior consent of us.", notes, mid)
            self.assertIn("WRITTEN confirmation", notes, mid)
            self.assertIn("must not remove, falsify, cover the sign that can distinguish those output generated by "
                          "using deep synthesis technology", notes, mid)
            self.assertIn("effective 2025-01-23", notes, mid)
            self.assertIn("5 concurrent tasks per organisation", notes, mid)
            self.assertIn("valid 24 h", notes, mid)

    def test_no_migration_or_price_file_prices_them(self):
        units = []
        for mid in IDS:
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, "second", k) for k in e.raw["pricing"]["variants"]["prices"]]
        self.assertEqual(len(units), 4 + 3 + 3 + 2 + 5)
        hits = []
        for folder in ("supabase/migrations", "docs/sql", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_with_a_source(self):
        for mid in IDS:
            p = self.r[mid].raw["pricing"]
            self.assertFalse(p["confirmed"], mid)
            self.assertEqual(p["as_of"], "2026-10-25", mid)
            self.assertIn("ESTIMATE", p["note"], mid)
            self.assertEqual(p["source_url"], "https://platform.vidu.com/docs/overview/pricing", mid)
            self.assertIn("USD per credit is on no page read", p["note"], mid)   # the exchange assumption is admitted

    def test_the_prices_are_the_pages_credits_per_second_at_the_stated_rate(self):
        for mid, credits in CREDITS.items():
            got = self.r[mid].raw["pricing"]["variants"]
            self.assertEqual(got["by"], "resolution", mid)
            self.assertEqual(got["prices"], {k: round(v * 0.005, 4) for k, v in credits.items()}, mid)
            self.assertEqual(self.r[mid].raw["pricing"]["provider_usd_per_unit"], got["prices"]["720p"], mid)
            self.assertEqual(sorted(self.r[mid].resolutions), sorted(credits), mid)

    def test_a_failed_task_is_never_stated_to_be_free(self):
        for mid in IDS:
            for note in [self.r[mid].raw["pricing"]["note"], *self.r[mid].raw["terms_notes"]]:
                for bad in ("failed tasks use no credits", "failed generations are not billed", "failures are free"):
                    if bad in note.lower():       # a vendor's claim may be quoted, but only AS a claim
                        self.assertTrue("claim" in note.lower() and "unverified" in note.lower(), (mid, note))
            self.assertIn("claims", self.r[mid].raw["pricing"]["note"])

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        for mid in IDS:
            e = self.r[mid]
            spec = vidu.ViduVideoAdapter.SPECS[e.vendor_model]
            self.assertEqual(sorted(e.resolutions), sorted(spec["resolutions"]), mid)
            self.assertEqual(list(e.durations_s), list(spec["durations"]), mid)
            self.assertEqual(sorted(e.aspect_ratios), sorted(spec["ratios"]), mid)
            self.assertEqual((e.default_resolution, e.variants_by), ("720p", "resolution"), mid)
            self.assertEqual(e.end_frame, "end" in spec["modes"], mid)
            self.assertEqual(T2V in e.capabilities, "t2v" in spec["modes"], mid)
            self.assertEqual(I2V in e.capabilities, "i2v" in spec["modes"], mid)
        self.assertEqual(self.r["vidu-q3-pro-fast"].resolutions, ("720p", "1080p"))      # no 540p tier is priced
        self.assertEqual(self.r["vidu-q4-preview"].durations_s, tuple(range(3, 17)))     # Q4 starts at 3 s

    def test_pro_fast_and_q4_offer_no_end_frame_because_their_prices_are_not_listed_for_it(self):
        self.assertFalse(self.r["vidu-q3-pro-fast"].end_frame)
        self.assertFalse(self.r["vidu-q4-preview"].end_frame)
        self.assertTrue(self.r["vidu-q3-pro"].end_frame)
        self.assertTrue(self.r["vidu-q3-turbo"].end_frame)

    def test_probes_are_servable_and_cheap(self):
        want = {"vidu-q3-pro": ("540p", 2, True), "vidu-q3-turbo": ("540p", 2, True),
                "vidu-q3-pro-fast": ("720p", 2, False), "vidu-q4-preview": ("540p", 3, False)}
        for mid, (res, dur, end) in want.items():
            probe = self.r[mid].probe_request(generated_image="https://probe.invalid/x.png",
                                              generated_end_image="https://probe.invalid/end.png")
            self.assertEqual((probe.capability, probe.resolution, probe.duration_s, bool(probe.end_image)),
                             (I2V, res, dur, end), mid)

    def test_the_result_host_note_says_it_is_unknown_and_fails_closed(self):
        for mid in IDS:
            self.assertIn("result host UNKNOWN", self.r[mid].raw["api_documented"]["note"], mid)
            self.assertIn("fail closed", self.r[mid].raw["api_documented"]["note"], mid)
        self.assertEqual(vidu.RESULT_HOSTS, ())


# ══ submit ════════════════════════════════════════════════════════════════════════════

class SubmitTests(Case):
    def setUp(self):
        super().setUp()
        for path in (T2V_PATH, I2V_PATH, END_PATH):
            self.vendor.on("POST", path, Resp(200, {"task_id": "t1000", "state": "created", "credits": 4}))

    def sent(self, path=T2V_PATH):
        (r,) = self.vendor.seen("POST", path)
        return r

    def test_text_to_video_sends_every_priced_setting_explicitly_and_the_token_scheme(self):
        task = self.adapter().submit(req(), "viduq3-pro")
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("video.vidu", "viduq3-pro", "t1000"))
        r = self.sent()
        self.assertEqual(r.headers["authorization"], f"Token {KEY}")           # not Bearer
        self.assertEqual(r.json(), {"model": "viduq3-pro", "duration": 5, "resolution": "720p",
                                    "prompt": "a boat at dawn", "aspect_ratio": "16:9"})
        self.assertIs(type(r.json()["duration"]), int)

    def test_a_named_aspect_ratio_is_sent_and_nothing_unpriced_or_unverified_is_ever_sent(self):
        self.adapter().submit(req(aspect_ratio="9:16", duration_s=16, resolution="1080p"), "viduq3-turbo")
        body = self.sent().json()
        self.assertEqual((body["aspect_ratio"], body["duration"], body["resolution"]), ("9:16", 16, "1080p"))
        for field in ("off_peak", "seed", "payload", "callback_url", "audio", "watermark", "meta_data", "voice_id", "bgm",
                      "movement_amplitude", "is_rec"):
            self.assertNotIn(field, body, field)

    def test_the_sound_flag_is_sent_only_when_the_job_names_it(self):
        for audio in (None, True, False):
            self.vendor.requests.clear()
            self.adapter().submit(req(audio=audio), "viduq3-turbo")
            body = self.sent().json()
            self.assertEqual("audio" in body, audio is not None)
            if audio is not None:
                self.assertIs(body["audio"], audio)

    def test_image_to_video_always_turns_the_recommended_prompt_off_and_sends_the_picture_inline(self):
        a = self.adapter()
        for model in ("viduq3-pro", "viduq3-turbo", "viduq3-pro-fast", "viduq4-preview"):
            self.vendor.requests.clear()
            res = "540p" if model != "viduq3-pro-fast" else "720p"
            task = a.submit(CapabilityRequest(I2V, "slow push in", resolution=res, duration_s=5,
                                              input_images=(self.frame(),)), model)
            self.assertEqual(task.task_id, "t1000")
            body = self.sent(I2V_PATH).json()
            self.assertIs(body["is_rec"], False, model)                  # Q4's default is true: it would write and bill a prompt
            self.assertEqual(body["prompt"], "slow push in")
            self.assertEqual(len(body["images"]), 1)
            self.assertTrue(body["images"][0].startswith("data:image/png;base64,"))
            self.assertNotIn("aspect_ratio", body)
            self.assertEqual((body["model"], body["resolution"], body["duration"]), (model, res, 5))

    def test_image_to_video_without_words_sends_no_prompt_field(self):
        self.adapter().submit(CapabilityRequest(I2V, "", resolution="720p", duration_s=5, input_images=(self.frame(),)),
                              "viduq3-pro")
        body = self.sent(I2V_PATH).json()
        self.assertNotIn("prompt", body)
        self.assertIs(body["is_rec"], False)

    def test_a_link_goes_as_a_link(self):
        self.adapter().submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5,
                                                input_images=("https://example.invalid/a.png",)), "viduq3-pro")
        self.assertEqual(self.sent(I2V_PATH).json()["images"], ["https://example.invalid/a.png"])

    def test_start_and_end_frame_go_to_their_own_endpoint_in_order(self):
        self.adapter().submit(CapabilityRequest(I2V, "morph", resolution="1080p", duration_s=8, end_image=self.frame("end.png"),
                                                input_images=(self.frame(),)), "viduq3-turbo")
        body = self.sent(END_PATH).json()
        self.assertEqual(self.vendor.seen("POST", I2V_PATH), [])
        self.assertEqual(len(body["images"]), 2)
        self.assertTrue(all(i.startswith("data:image/png;base64,") for i in body["images"]))
        self.assertNotIn("is_rec", body)                                # the start-end page has no such field
        self.assertEqual((body["model"], body["resolution"], body["duration"]), ("viduq3-turbo", "1080p", 8))

    def test_q4_preview_wire_resolution_is_spelled_the_way_vidu_spells_it(self):
        for res, wire in (("540p", "540p"), ("1080p", "1080p"), ("2k", "2K"), ("4k", "4K")):
            self.vendor.requests.clear()
            self.adapter().submit(CapabilityRequest(I2V, "x", resolution=res, duration_s=3, input_images=(self.frame(),)),
                                  "viduq4-preview")
            self.assertEqual(self.sent(I2V_PATH).json()["resolution"], wire, res)

    def test_a_setting_the_price_depends_on_is_refused_before_any_call_never_defaulted(self):
        pic = self.frame()
        gif = self.tmp / "a.gif"
        gif.write_bytes(b"GIF89a")
        i2v = lambda **kw: CapabilityRequest(I2V, **{**dict(prompt="x", resolution="720p", duration_s=5, input_images=(pic,)), **kw})  # noqa: E731
        cases = (
            ("viduq3-pro", req(resolution=None), "resolution"),
            ("viduq3-pro", req(resolution="480p"), "resolution"),
            ("viduq3-pro", req(resolution="2k"), "resolution"),                   # 2K / 4K are Q4 preview's
            ("viduq3-pro-fast", i2v(resolution="540p"), "resolution"),            # no 540p tier is priced for Pro Fast
            ("viduq4-preview", i2v(resolution="480p"), "resolution"),
            ("viduq3-pro", req(duration_s=None), "duration"),
            ("viduq3-pro", req(duration_s=0), "duration"),
            ("viduq3-pro", req(duration_s=17), "duration"),
            ("viduq4-preview", i2v(duration_s=2), "duration"),                    # Q4 starts at 3 s
            ("viduq3-pro", req(negative_prompt="blur"), "negative prompt"),
            ("viduq3-pro", req(prompt=" "), "prompt is empty"),
            ("viduq3-pro", req(aspect_ratio="21:9"), "aspect ratio"),
            ("viduq3-pro", req(input_images=(pic,)), "does not apply to text-to-video"),
            ("viduq3-pro", i2v(input_images=()), "first-frame picture"),
            ("viduq3-pro", i2v(input_images=(pic, pic)), "one first-frame picture"),
            ("viduq3-pro", i2v(aspect_ratio="16:9"), "keeps their shape"),
            ("viduq3-pro-fast", req(), "no text-to-video"),                       # Pro Fast is image-to-video only here
            ("viduq4-preview", req(), "no text-to-video"),
            ("viduq3-pro-fast", i2v(end_image=pic), "no a start and end frame"),   # its start-end price is not listed
            ("viduq4-preview", i2v(end_image=pic), "no a start and end frame"),
            ("viduq3-pro", i2v(input_images=(str(gif),)), "JPEG, PNG or WEBP"),
            ("viduq3", req(), "not a Vidu model"),                                 # reference-to-video is not wired
            ("viduq3-mix", req(), "not a Vidu model"),
            ("viduq2", req(), "not a Vidu model"),
            ("viduq3-pro-hdr", req(), "not a Vidu model"),
            ("", req(), "not a Vidu model"),
        )
        for model, request, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, request)) as cm:
                self.adapter().submit(request, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, request))
            self.assertTrue(cm.exception.not_accepted, (model, request))
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_whole_duration_range_is_accepted_where_the_docs_allow_it(self):
        for model, lo in (("viduq3-pro", 1), ("viduq3-turbo", 1)):
            for d in (lo, 16):
                self.vendor.requests.clear()
                self.adapter().submit(req(duration_s=d), model)
                self.assertEqual(self.sent().json()["duration"], d)

    def test_the_registry_entries_refuse_what_the_adapter_would_refuse(self):
        a = self.adapter()
        for mid in IDS:
            entry = reg.get(mid)
            probe = entry.probe_request(generated_image="https://probe.invalid/x.png",
                                        generated_end_image="https://probe.invalid/end.png")
            self.assertEqual(a.problems(probe, entry), [], mid)
        entry = reg.get("vidu-q3-pro-fast")
        self.assertTrue(a.problems(req(), entry))                                     # no t2v
        self.assertTrue(a.problems(req(resolution=None), reg.get("vidu-q3-pro")))
        self.assertTrue(a.problems(req(duration_s=None), reg.get("vidu-q3-pro")))
        self.assertTrue(a.problems(req(prompt="x" * 2001), reg.get("vidu-q3-pro")))   # the registry's own cap

    def test_no_key_is_a_refusal_before_any_call(self):
        a = self.adapter(env={"VIDU_BASE_URL": self.vendor.base_url})
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "viduq3-pro")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_the_task_id_may_come_as_a_plain_integer_but_never_as_anything_that_could_steer_a_path(self):
        self.vendor._routes.clear()
        self.vendor.on("POST", T2V_PATH, Resp(200, {"task_id": 831457260038590464, "state": "created"}))
        self.assertEqual(self.adapter().submit(req(), "viduq3-pro").task_id, "831457260038590464")


class LostAnswerTests(Case):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)

    def test_a_dropped_connection_a_timeout_and_a_5xx_may_have_billed(self):
        for resp in (Resp(drop=True), Resp(503, {"code": 503, "reason": "SystemThrottling", "message": "x"}),
                     Resp(502, raw=b"<html>bad gateway</html>"), Resp(200, {"task_id": "late"}, hang_s=1.5)):
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, resp)
            a = self.adapter()
            a.timeout = 0.4
            with self.assertRaises(AdapterError) as cm:
                a.submit(req(), "viduq3-pro")
            self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_id_may_have_billed(self):
        for body in ({}, {"task_id": ""}, {"task_id": None}, {"task_id": True}, {"task_id": -4}, {"task_id": "../x"},
                     {"task_id": "a/b"}, {"task_id": "a.b"}, {"task_id": "a:b"}, {"task_id": "x" * 300}, {"task_id": ["a"]},
                     [], None):
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, Resp(200, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.adapter().submit(req(), "viduq3-pro")
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_2xx_with_a_body_that_is_not_json_may_have_billed(self):
        self.vendor.on("POST", T2V_PATH, Resp(200, raw=b"<html>ok</html>"))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(req(), "viduq3-pro")
        self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_the_vendors_error_names_beat_the_http_status_and_proven_refusals_are_proof(self):
        cases = ((401, "Unauthorized", E_AUTH, True), (403, "Forbidden", E_AUTH, True),
                 (402, "CreditInsufficient", E_QUOTA, True), (429, "TooManyRequests", E_RATE_LIMITED, True),
                 (404, "NotFound", E_NOT_FOUND, True), (400, "TaskPromptPolicyViolation", E_POLICY, False),
                 (400, "AuditSubmitIllegal", E_POLICY, False), (400, "FieldInvalid", E_BAD_REQUEST, False),
                 (400, "ImageFormatInvalid", E_BAD_REQUEST, False), (400, "PageSizeOutOfRange", E_BAD_REQUEST, False),
                 (400, "QuotaExceeded", E_RATE_LIMITED, False))
        for status, reason, want, proof in cases:
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, Resp(status, {"code": status, "reason": reason, "message": f"m {KEY}",
                                                           "metadata": {"trace_id": "abc"}}))
            with self.assertRaises(AdapterError, msg=reason) as cm:
                self.adapter().submit(req(), "viduq3-pro")
            self.assertEqual(cm.exception.code, want, reason)
            self.assertEqual(cm.exception.not_accepted, proof, reason)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, reason)
            self.assertNotIn(KEY, cm.exception.message, reason)

    def test_a_200_that_carries_the_error_shape_and_no_task_is_the_vendors_refusal_not_a_lost_answer(self):
        # the cancel page shows exactly this: HTTP 200 with {"code": 400, "reason": ..., "message": ...}
        self.vendor.on("POST", T2V_PATH, Resp(200, {"code": 400, "reason": "FieldInvalid", "message": f"bad {KEY}"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(req(), "viduq3-pro")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)
        self.assertNotIn(KEY, cm.exception.message)

    def test_a_200_error_shape_that_reads_as_an_outage_does_not_prove_nothing_was_started(self):
        for reason in ("InternalServiceFailure", "ModelUnavailable", "OperationInProcess", "BrandNewReason"):
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, Resp(200, {"code": 500, "reason": reason, "message": "x"}))
            with self.assertRaises(AdapterError, msg=reason) as cm:
                self.adapter().submit(req(), "viduq3-pro")
            self.assertUnconfirmed(cm, E_UNAVAILABLE)
        # while polling, the same shape is an ordinary typed error (nothing is being started)
        self.vendor._routes.clear()
        self.vendor.on("GET", "/ent/v2/tasks/t1000/creations", Resp(200, {"code": 500, "reason": "InternalServiceFailure"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().poll(ProviderTask("video.vidu", "viduq3-pro", "t1000"))
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.adapter(env={"VIDU_API_KEY": KEY, "VIDU_BASE_URL": closed_port_url()})
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "viduq3-pro")
        self.assertTrue(cm.exception.not_accepted)

    def test_a_second_call_is_never_made_after_a_lost_answer(self):
        self.vendor.on("POST", T2V_PATH, Resp(drop=True))
        with self.assertRaises(AdapterError):
            self.adapter().submit(req(), "viduq3-pro")
        self.assertEqual(len(self.vendor.seen("POST", T2V_PATH)), 1)          # no retry: the first one may have billed

    def test_the_creative_bridge_keeps_the_difference(self):
        entry = reg.get("vidu-q3-turbo")

        def bridged(env, **params):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=self.vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2v", model=entry.id,
                                                  params=dict(prompt="a boat", duration_s=5, **params), input_files=()))
        with self.assertRaises(ca.CreativeAdapterError) as cm:           # the job carries no resolution: not quoted
            bridged({"VIDU_API_KEY": KEY, "VIDU_BASE_URL": self.vendor.base_url})
        self.assertIn("no resolution", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])
        self.vendor.on("POST", T2V_PATH, Resp(drop=True))
        with self.assertRaises(AdapterError) as lost:
            bridged({"VIDU_API_KEY": KEY, "VIDU_BASE_URL": self.vendor.base_url}, resolution="720p")
        self.assertFalse(lost.exception.not_accepted)


# ══ poll ══════════════════════════════════════════════════════════════════════════════

class PollTests(Case):
    def status(self, body, tid="t1000", code=200, *, hosts=("localhost",)):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", f"/ent/v2/tasks/{tid}/creations", Resp(code, body))
        return self.adapter(hosts=hosts).poll(ProviderTask("video.vidu", "viduq3-pro", tid))

    def test_every_in_flight_state_is_pending_and_the_key_goes_only_to_the_api(self):
        for st in ("created", "queueing", "processing", "something_new"):
            self.assertEqual(self.status({"id": "t1000", "state": st}).state, PENDING, st)
        (r,) = self.vendor.seen("GET", "/ent/v2/tasks/t1000/creations")
        self.assertEqual(r.headers["authorization"], f"Token {KEY}")
        self.assertEqual(self.vendor.seen("POST", ""), [])                # polling never submits

    def test_success_hands_back_the_clip_link_not_the_cover_nor_the_marked_copy(self):
        base = self.vendor.base_url
        res = self.status({"state": "success", "creations": [
            {"id": "c1", "url": f"{base}/clip.mp4", "cover_url": f"{base}/cover.jpg", "watermarked_url": f"{base}/marked.mp4"}]})
        self.assertEqual((res.state, res.outputs[0].mime, res.outputs[0].url), (SUCCEEDED, "video/mp4", f"{base}/clip.mp4"))

    def test_the_watermarked_copy_is_one_constant_away(self):
        base = self.vendor.base_url
        self.vendor._routes.clear()
        self.vendor.on("GET", "/ent/v2/tasks/t1000/creations", Resp(200, {"state": "success", "creations": [
            {"url": f"{base}/clip.mp4", "watermarked_url": f"{base}/marked.mp4"}]}))
        with mock.patch.object(vidu.ViduVideoAdapter, "STORE_WATERMARKED", True):
            res = self.adapter().poll(ProviderTask("video.vidu", "viduq3-pro", "t1000"))
        self.assertEqual(res.outputs[0].url, f"{base}/marked.mp4")
        self.assertFalse(vidu.ViduVideoAdapter.STORE_WATERMARKED)         # shipped: the unmarked file

    def test_a_failed_task_carries_the_vendors_error_code_and_the_right_remedy(self):
        cases = (("TaskPromptPolicyViolation", E_POLICY), ("CreationPolicyViolation", E_POLICY), ("AuditFailed", E_POLICY),
                 ("CreditInsufficient", E_QUOTA), ("ImageDownloadFailure", E_BAD_REQUEST), ("FieldInvalid", E_BAD_REQUEST),
                 ("SystemThrottling", E_RATE_LIMITED), ("InternalServiceFailure", E_UNAVAILABLE), ("ModelUnavailable", E_UNAVAILABLE),
                 ("UserCancelled", E_UNAVAILABLE), ("Unknown", E_UNAVAILABLE), ("BrandNewCode", E_UNAVAILABLE), ("", E_UNAVAILABLE))
        for err, want in cases:
            res = self.status({"state": "failed", "err_code": err})
            self.assertEqual((res.state, res.error.code), (FAILED, want), err)
            self.assertTrue(res.error.message.endswith(vidu.SPEND_UNKNOWN), res.error.message)
            self.assertIn("usage page", res.error.message)
            self.assertIn("vendor claim", res.error.message)              # the vendor's statement is quoted AS one

    def test_a_key_the_vendor_echoes_in_a_failure_is_scrubbed(self):
        res = self.status({"state": "failed", "err_code": f"oops {KEY}"})
        self.assertNotIn(KEY, res.error.message)

    def test_success_without_a_link_may_have_billed_and_says_so(self):
        for creations in ([], [{}], [{"url": ""}], [{"url": 5}], [{"cover_url": "https://x/c.jpg"}], None, "x"):
            with self.assertRaises(AdapterError, msg=repr(creations)) as cm:
                self.status({"state": "success", "creations": creations})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))

    def test_with_no_known_result_host_every_link_is_refused_and_names_the_host_it_saw(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"state": "success", "creations": [{"url": "https://cdn.vidu.example/a/b.mp4?sig=1"}]}, hosts=None)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)
        self.assertIn("'cdn.vidu.example'", cm.exception.message)
        self.assertNotIn("sig=1", cm.exception.message)                  # the signed query is not echoed

    def test_a_link_that_is_not_plain_https_on_an_allowed_host_is_refused(self):
        ok = self.status({"state": "success", "creations": [{"url": "https://clips.vidu.example/v.mp4?X=1"}]},
                         hosts=("vidu.example",))
        self.assertEqual(ok.state, SUCCEEDED)
        for url in ("http://clips.vidu.example/v.mp4", "https://evilvidu.example/v.mp4",
                    "https://vidu.example.attacker.example/v.mp4", "https://attacker.example/vidu.example/v.mp4",
                    "https://clips.vidu.example:8443/v.mp4", "https://127.0.0.1\\@clips.vidu.example/v.mp4",
                    "https://user:pw@clips.vidu.example/v.mp4", "//clips.vidu.example/v.mp4", ""):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status({"state": "success", "creations": [{"url": url}]}, hosts=("vidu.example",))
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)

    def test_a_task_id_that_could_steer_the_request_is_refused(self):
        for tid in ("../../ent/v2/credits", "a/b", "a?b", "a#b", "..", ".", "a.b", "a:b", "", " ", "x" * 300, "a\\b", "a%2fb",
                    "a b", "t1000\n"):
            with self.assertRaises(AdapterError, msg=repr(tid)) as cm:
                self.adapter().poll(ProviderTask("video.vidu", "viduq3-pro", tid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_is_typed(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"code": 404, "reason": "TaskNotFound", "message": "gone"}, code=404)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        with self.assertRaises(AdapterError) as cm:
            self.status({"code": 500, "reason": "InternalServiceFailure"}, code=500)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        with self.assertRaises(AdapterError) as cm:
            self.status({"code": 200, "reason": "TaskNotFound", "message": "no such task"})   # the error shape under a 200
        self.assertEqual(cm.exception.code, E_NOT_FOUND)


# ══ the key never leaves the API host ═════════════════════════════════════════════════

class RedirectAndDownloadTests(Case):
    def setUp(self):
        super().setUp()
        self.attacker = FakeVendor()
        self.addCleanup(self.attacker.close)
        self.attacker.on("GET", "/", Resp(200, {"state": "success", "creations": [{"url": "https://x/o.mp4"}]}))
        self.attacker.on("POST", "/", Resp(200, {"task_id": "stolen"}))

    def test_the_adapter_says_it_follows_no_redirect(self):
        self.assertIs(vidu.ViduVideoAdapter.follow_redirects, False)

    def test_the_submit_call_does_not_follow_a_redirect(self):
        self.vendor.on("POST", T2V_PATH, Resp(307, headers={"Location": f"{self.attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(req(), "viduq3-pro")
        self.assertIn("307", cm.exception.message)
        self.assertEqual(self.attacker.requests, [])
        self.assertEqual(len(self.vendor.seen("POST", T2V_PATH)), 1)

    def test_the_poll_call_does_not_follow_a_redirect(self):
        self.vendor.on("GET", "/ent/v2/tasks/t1000/creations", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().poll(ProviderTask("video.vidu", "viduq3-pro", "t1000"))
        self.assertIn("302", cm.exception.message)
        self.assertEqual(self.attacker.requests, [])

    def test_control_the_same_redirect_WOULD_reach_the_other_host_if_it_were_followed(self):
        # Proves the two tests above can fail: with redirects on, requests goes to the other host.
        self.vendor.on("GET", "/ent/v2/tasks/t1000/creations", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        a = self.adapter()
        a.follow_redirects = True
        try:
            a.poll(ProviderTask("video.vidu", "viduq3-pro", "t1000"))
        except AdapterError:
            pass                                                       # the other host's answer is no clip: not the point
        self.assertEqual([r.path for r in self.attacker.requests], ["/steal"])

    def test_the_download_sends_no_key_and_follows_no_redirect(self):
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4))
        a = self.adapter()
        res = PollResultFor(self.vendor.base_url + "/clip.mp4")
        (path,) = a.fetch(res, self.tmp, "clip")
        self.assertEqual(path.read_bytes(), MP4)
        (r,) = self.vendor.seen("GET", "/clip.mp4")
        self.assertNotIn("authorization", r.headers)
        self.assertNotIn(KEY, str(r.headers))
        self.vendor.on("GET", "/moved.mp4", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError) as cm:
            a.fetch(PollResultFor(self.vendor.base_url + "/moved.mp4"), self.tmp, "moved")
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)
        self.assertEqual(self.attacker.requests, [])

    def test_an_expired_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/gone.mp4", Resp(403, {"error": "expired"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().fetch(PollResultFor(self.vendor.base_url + "/gone.mp4"), self.tmp, "gone")
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))

    def test_a_file_that_is_not_a_video_is_not_stored(self):
        self.vendor.on("GET", "/page.mp4", Resp(200, raw=b"<html>login</html>" * 50))
        with self.assertRaises(AdapterError):
            self.adapter().fetch(PollResultFor(self.vendor.base_url + "/page.mp4"), self.tmp, "page")
        self.assertEqual(list(self.tmp.glob("page*")), [])


def PollResultFor(url):
    from modules.capabilities.base import Output, PollResult

    return PollResult(SUCCEEDED, [Output("video/mp4", url=url)])


# ══ end to end through the probe ═══════════════════════════════════════════════════════

class EndToEndTests(Case):
    def run_probe(self, polls, *, entry_id="vidu-q3-turbo", path=END_PATH, timeout_s=600):
        from tools.probe_models import run_probe

        self.vendor.on("POST", path, Resp(200, {"task_id": "job-9", "state": "created"}))
        self.vendor.on("GET", "/ent/v2/tasks/job-9/creations", polls)
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4))
        clock = {"t": 0.0}
        with mock.patch.object(vidu.ViduVideoAdapter, "result_hosts", ("localhost",)), \
                mock.patch.object(vidu.ViduVideoAdapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(entry_id), env={"VIDU_API_KEY": KEY, "VIDU_BASE_URL": self.vendor.base_url},
                             voice_id=None, workdir=self.tmp, timeout_s=timeout_s, poll_every_s=5,
                             session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def test_the_probe_runs_the_whole_chain_and_stores_a_real_clip(self):
        done = Resp(200, {"state": "success", "creations": [{"url": f"{self.vendor.base_url}/clip.mp4"}]})
        res = self.run_probe([Resp(200, {"state": "queueing"}), Resp(200, {"state": "processing"}), done])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(MP4))
        body = self.vendor.seen("POST", END_PATH)[0].json()
        self.assertEqual((body["model"], body["duration"], body["resolution"]), ("viduq3-turbo", 2, "540p"))
        self.assertEqual(len(body["images"]), 2)                         # the probe proves the start-end path it sells
        self.assertEqual(len(self.vendor.seen("POST", END_PATH)), 1)

    def test_the_q4_probe_goes_through_image_to_video_with_the_recommended_prompt_off(self):
        done = Resp(200, {"state": "success", "creations": [{"url": f"{self.vendor.base_url}/clip.mp4"}]})
        res = self.run_probe([done], entry_id="vidu-q4-preview", path=I2V_PATH)
        self.assertTrue(res.ok, res.message)
        body = self.vendor.seen("POST", I2V_PATH)[0].json()
        self.assertEqual((body["model"], body["duration"], body["resolution"], body["is_rec"]), ("viduq4-preview", 3, "540p", False))

    def test_a_job_that_never_finishes_ends_as_a_timeout_that_names_the_task(self):
        res = self.run_probe([Resp(200, {"state": "processing"})], timeout_s=30)
        self.assertEqual((res.ok, res.code, res.task_id), (False, "timeout", "job-9"))

    def test_an_expired_clip_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/expired.mp4", Resp(403, {"error": "expired"}))
        res = self.run_probe([Resp(200, {"state": "success", "creations": [{"url": f"{self.vendor.base_url}/expired.mp4"}]})])
        self.assertEqual((res.ok, res.code), (False, E_NOT_FOUND))
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)

    def test_the_probe_as_shipped_fails_closed_and_says_where_the_money_went(self):
        from tools.probe_models import run_probe

        self.vendor.on("POST", END_PATH, Resp(200, {"task_id": "job-9"}))
        self.vendor.on("GET", "/ent/v2/tasks/job-9/creations",
                       Resp(200, {"state": "success", "creations": [{"url": f"{self.vendor.base_url}/clip.mp4"}]}))
        clock = {"t": 0.0}
        res = run_probe(reg.get("vidu-q3-turbo"), env={"VIDU_API_KEY": KEY, "VIDU_BASE_URL": self.vendor.base_url},
                        voice_id=None, workdir=self.tmp, timeout_s=600, poll_every_s=5, session=self.vendor.session(),
                        sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])
        self.assertFalse(res.ok)
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)
        self.assertIn("'localhost'", res.message)                        # the host a person would read off and pin


# ══ pictures ═════════════════════════════════════════════════════════════════════════

class LocalPictureTests(Case):
    """A path comes from a job. Only a real picture may be read from it and sent to a vendor."""

    def setUp(self):
        super().setUp()
        for path in (I2V_PATH, END_PATH):
            self.vendor.on("POST", path, Resp(200, {"task_id": "t1"}))

    def secret_file(self, name="notes.png", body=b"DB_PASSWORD=hunter2\n" * 20) -> str:
        p = self.tmp / name
        p.write_bytes(body)
        return str(p)

    def submitters(self):
        a = self.adapter()
        yield ("first frame", lambda ref: a.submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5,
                                                                      input_images=(ref,)), "viduq3-pro"))
        yield ("end frame", lambda ref: a.submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5, end_image=ref,
                                                                    input_images=(self.frame("ok.png"),)), "viduq3-pro"))

    def test_a_file_that_only_wears_a_picture_suffix_is_refused_and_nothing_is_sent(self):
        bodies = {"text": b"DB_PASSWORD=hunter2\n" * 20, "html": b"<html><body>login</body></html>",
                  "zip": b"PK\x03\x04" + b"\x00" * 64, "gif": b"GIF89a" + b"\x00" * 64,
                  "svg": b"<svg xmlns='http://www.w3.org/2000/svg'/>", "empty": b""}
        for who, submit in self.submitters():
            for kind, body in bodies.items():
                with self.assertRaises(AdapterError, msg=(who, kind)) as cm:
                    submit(self.secret_file(f"{kind}.png", body))
                self.assertEqual(cm.exception.code, E_BAD_REQUEST, (who, kind))
                self.assertTrue(cm.exception.not_accepted, (who, kind))
                self.assertIn("not a PNG, JPEG or WEBP picture", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_a_suffix_that_is_not_a_picture_is_refused_before_the_file_is_opened(self):
        for who, submit in self.submitters():
            for name in ("notes.txt", "key.pem", "a.gif", "a.svg", "a", ".env", "a.png.exe"):
                with self.assertRaises(AdapterError, msg=(who, name)) as cm:
                    submit(self.secret_file(name))
                self.assertIn("JPEG, PNG or WEBP", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_picture_is_labelled_with_the_type_its_bytes_say(self):
        from PIL import Image

        jpeg = io.BytesIO()
        Image.new("RGB", (8, 8), (10, 20, 30)).save(jpeg, "JPEG")
        self.adapter().submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5,
                                                input_images=(self.secret_file("liar.png", jpeg.getvalue()),)), "viduq3-pro")
        self.assertTrue(self.vendor.seen("POST", I2V_PATH)[0].json()["images"][0].startswith("data:image/jpeg;base64,"))

    def test_an_oversized_or_missing_picture_is_refused_before_the_call(self):
        big = self.tmp / "big.png"
        with open(big, "wb") as fh:
            fh.write(png())
            fh.truncate(vidu.ViduVideoAdapter.MAX_IMAGE_BYTES + 1)
        for ref in (str(big), str(self.tmp / "gone.png")):
            with self.assertRaises(AdapterError) as cm:
                self.adapter().submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5, input_images=(ref,)), "viduq3-pro")
            self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])
        self.assertLess(2 * vidu.ViduVideoAdapter.MAX_IMAGE_BYTES * 4 // 3, 20 * 1024 * 1024)   # two frames stay under a 20 MB body
        self.assertLess(vidu.ViduVideoAdapter.MAX_IMAGE_BYTES, 10 * 1000 * 1000)                  # the decoded picture stays under 10 MB

    def test_the_bad_end_frame_is_found_before_the_first_picture_is_sent_anywhere(self):
        with self.assertRaises(AdapterError):
            self.adapter().submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5, end_image=self.secret_file("e.png"),
                                                    input_images=(self.frame(),)), "viduq3-pro")
        self.assertEqual(self.vendor.requests, [])


# ══ wiring ═════════════════════════════════════════════════════════════════════════════

class WiringTests(unittest.TestCase):
    def test_the_adapter_is_wired_the_way_a_header_key_adapter_must_be(self):
        a = vidu.ViduVideoAdapter
        self.assertEqual((a.key, a.key_env, a.base_url_env, a.default_base_url),
                         ("video.vidu", ("VIDU_API_KEY",), "VIDU_BASE_URL", "https://api.vidu.com"))
        self.assertEqual(a.result_ports, (None, 443))
        self.assertIs(a.follow_redirects, False)
        self.assertEqual(a.end_frame_capabilities, (I2V,))
        self.assertEqual(set(a.resolution_capabilities), {T2V, I2V})

    def test_the_new_key_is_one_the_worker_the_probe_workflow_and_the_doctor_can_be_given(self):
        example = (ROOT / "deploy" / ".env.worker.example").read_text()
        deploy = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text()
        probe = (ROOT / ".github" / "workflows" / "probe_models.yml").read_text()
        doctor = (ROOT / "tools" / "doctor.py").read_text()
        name = "VIDU_API_KEY"
        self.assertRegex(example, rf"(?m)^{name}=$")                       # empty in the example, never a value
        self.assertIn(f"WORKERENV_{name}: ${{{{ secrets.{name} }}}}", deploy)
        self.assertIn(f"{name}: ${{{{ secrets.{name} }}}}", probe)
        self.assertIn(f'"{name}"', doctor)
        self.assertIn(f'("{name}", "vidu")', doctor)

    def test_the_key_page_lists_vidu_with_no_check_that_sends_the_key(self):
        text = (ROOT / "command-center" / "lib" / "model-keys.ts").read_text()
        i = text.index('id: "vidu"')
        card = text[i:text.index("\n  },\n", i)]
        self.assertIn('envSets: [["VIDU_API_KEY"]]', card)
        self.assertIn('kind: "format_only"', card)
        self.assertIn("keyUrl: null", card)

    def test_all_probe_skips_every_vidu_entry_and_a_named_one_comes_back(self):
        from tools import probe_models

        entries = list(reg.registry().values())
        chosen = {e.id for e in probe_models.select(entries, [], None, True)}
        self.assertFalse(chosen & set(IDS), chosen & set(IDS))
        for mid in IDS:
            self.assertIn(mid, {e.id for e in probe_models.select(entries, [mid], None, True)})
            self.assertIn(mid, {e.id for e in probe_models.gated_left_out(entries, [], None, True)})
        for cap in ("t2v", "i2v"):
            self.assertFalse({e.id for e in probe_models.select(entries, [], cap, True)} & set(IDS), cap)

    def test_none_of_them_is_sellable(self):
        from modules import model_registry

        sellable = {e.id for e in model_registry.registry().values() if not e.terms_gate}
        self.assertFalse(sellable & set(IDS))


if __name__ == "__main__":
    unittest.main()
