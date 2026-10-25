"""Krea 3, LTX-2.5 / 2.3 and Luma Uni-1 / Uni-1 Max (the makers' own APIs): the adapters, the registry
entries, and the rule that none of it is for sale.

The adapters talk to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py): no network, no key, no
spend. The download rules are pinned in tests/test_safe_fetch.py; here the point is that these adapters USE
them, and that where the real result host is not known the download fails closed.

What would break without these tests:

* a priced setting (resolution / output size, duration, thinking mode) defaulted instead of refused: Krea
  prices 2K at double 1K and its dearer thinking modes apart, LTX bills by the second at a per-resolution
  rate, and automatic duration holds credits for the longest clip;
* an option the docs describe but nobody verified (Krea's bounding boxes) being sent;
* a result link on a host nobody has allowed being downloaded;
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
from modules.capabilities import build_adapter, krea, ltx, luma, pictures
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
    ProviderTask,
)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url
from tests.test_creative_worker import JOB, ORG

ROOT = Path(__file__).resolve().parent.parent
KEY = "test-NOT-A-REAL-KEY-0123456789abcdef"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
KREA_IDS = ("krea-3", "krea-3-regional")
LTX_IDS = ("ltx-2.5-pro", "ltx-2.5-fast", "ltx-2.3-pro", "ltx-2.3-fast")
LTX_VENDOR = {"ltx-2.5-pro": "ltx-2-5-pro", "ltx-2.5-fast": "ltx-2-5-fast", "ltx-2.3-pro": "ltx-2-3-pro",
              "ltx-2.3-fast": "ltx-2-3-fast"}
LUMA_IDS = ("luma-uni-1", "luma-uni-1-max")
NEW_IDS = (*KREA_IDS, *LTX_IDS, *LUMA_IDS)
KREA_PATH, JOBS = "/generate/image/krea/krea-3", "/jobs/"
T2V_PATH, I2V_PATH = "/v2/text-to-video", "/v2/image-to-video"
LUMA_PATH = "/generations"


def tearDownModule():
    cleanup_certificate()


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="kll_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def frame(self, name="first.png") -> str:
        p = self.tmp / name
        p.write_bytes(png())
        return str(p)

    def build(self, key, env_name, base_env, hosts, *, env=None) -> HttpAdapter:
        env = env if env is not None else {env_name: KEY, base_env: self.vendor.base_url}
        a = build_adapter(key, env=env, session=self.vendor.session())
        if hosts is not None:
            a.result_hosts = hosts
            a.result_ports = (None, 443, self.vendor.port)
        return a


# ══ the registry ═════════════════════════════════════════════════════════════════

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_each_entry_is_on_its_makers_adapter(self):
        for mid in KREA_IDS:
            self.assertEqual((self.r[mid].adapter, self.r[mid].provider), ("image.krea", "krea"), mid)
        for mid in LTX_IDS:
            self.assertEqual((self.r[mid].adapter, self.r[mid].provider), ("video.ltx", "lightricks"), mid)
        for mid in LUMA_IDS:
            self.assertEqual((self.r[mid].adapter, self.r[mid].provider), ("image.luma", "luma"), mid)

    def test_the_gates_are_the_ones_the_research_names_and_none_can_be_sold(self):
        want = {**{m: "terms_review_required" for m in (*KREA_IDS, *LTX_IDS)},
                **{m: "written_consent_required" for m in LUMA_IDS}}
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid, gate in want.items():
            e = self.r[mid]
            self.assertEqual(e.terms_gate, gate, mid)
            self.assertEqual(e.api_exposure, "web_only", mid)
            self.assertEqual(rows[mid]["spec"]["terms_gate"], gate, mid)       # sellable_models() refuses it
            notes = " ".join(e.raw["terms_notes"])
            self.assertRegex(notes, r"NOT (read|found)", mid)                  # says what was not read
            self.assertIn("Gate stays open", notes, mid)
            self.assertIn("Uzbekistan", notes, mid)

    def test_the_clauses_the_gates_rest_on_are_quoted(self):
        notes = lambda mid: " ".join(self.r[mid].raw["terms_notes"])           # noqa: E731
        self.assertIn("non-sublicensable", notes("krea-3"))
        self.assertIn("Nothing grants a right to resell", notes("krea-3"))
        self.assertIn("May 20, 2024", notes("krea-3"))                         # a possibly stale copy is said to be one
        for mid in LTX_IDS:
            self.assertIn("2.2(d)", notes(mid))
            self.assertIn("service bureau, resale or similar models", notes(mid))
            self.assertIn("2.1(b)", notes(mid))
        for mid in LUMA_IDS:
            self.assertIn("3.4(b)", notes(mid))
            self.assertIn("API Terms of Use", notes(mid))
            self.assertIn("NOT re-read", notes(mid))                           # the carried-over quote is flagged as carried

    def test_no_migration_or_price_file_prices_them(self):
        units = []
        for mid in NEW_IDS:
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, e.raw["pricing"]["unit"], k)
                      for k in (e.raw["pricing"].get("variants") or {}).get("prices", {})]
        self.assertEqual(len(units), 2 * 2 + 4 * 5 + 2)
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
            self.assertEqual(p["as_of"], "2026-10-25", mid)
            self.assertIn("ESTIMATE", p["note"], mid)
            self.assertTrue(p["source_url"].startswith("https://"), mid)

    def test_the_ltx_result_host_note_says_to_pin_the_bucket_after_the_first_probe(self):
        for mid in LTX_IDS:
            self.assertIn("pin the bucket after the first probe", self.r[mid].raw["api_documented"]["note"], mid)
        self.assertIn("pin the bucket", (ROOT / "docs" / "research" / "krea-ltx-luma-first-party.md").read_text())
        self.assertIn("PIN THE BUCKET", (ROOT / "modules" / "capabilities" / "ltx.py").read_text())

    def test_a_failed_job_is_never_stated_to_be_free(self):
        for mid in NEW_IDS:
            for note in [self.r[mid].raw["pricing"]["note"], *self.r[mid].raw["terms_notes"]]:
                for bad in ("failed generations are not billed", "failed jobs are not billed", "failures are free",
                            "not charged for failed"):
                    if bad in note.lower():       # a vendor's claim may be quoted, but only AS a claim
                        self.assertTrue("claim" in note.lower() and "unverified" in note.lower(), (mid, note))
        for mid in KREA_IDS:
            self.assertIn("vendor claim", self.r[mid].raw["pricing"]["note"])

    def test_the_prices_are_the_pages_list(self):
        r = self.r
        self.assertEqual(r["krea-3"].raw["pricing"]["variants"], {"by": "image_size", "prices": {"1K": 0.03}})
        self.assertIn("2K is $0.06", r["krea-3"].raw["pricing"]["note"])        # the dearer size is told, and not offered
        self.assertEqual(r["krea-3"].image_sizes, ("1K",))
        self.assertEqual(r["luma-uni-1"].raw["pricing"]["provider_usd_per_unit"], 0.0404)
        self.assertEqual(r["luma-uni-1-max"].raw["pricing"]["provider_usd_per_unit"], 0.1)
        want = {"ltx-2.5-pro": (0.12, 0.17, 0.25, 0.39), "ltx-2.5-fast": (0.09, 0.13, 0.19, 0.30),
                "ltx-2.3-pro": (0.04, 0.08, 0.16, 0.32), "ltx-2.3-fast": (0.03, 0.06, 0.12, 0.24)}
        for mid, prices in want.items():
            got = r[mid].raw["pricing"]["variants"]
            self.assertEqual((got["by"], tuple(got["prices"].values()), tuple(got["prices"])),
                             ("resolution", prices, ("720p", "1080p", "1440p", "4k")), mid)

    def test_what_the_registry_offers_is_what_the_adapters_will_send(self):
        for mid in LTX_IDS:
            e = self.r[mid]
            spec = ltx.LtxVideoAdapter.SPECS[e.vendor_model]
            self.assertEqual(e.vendor_model, LTX_VENDOR[mid])
            self.assertEqual(sorted(e.resolutions), sorted(spec["sizes"]), mid)
            self.assertEqual(sorted(e.aspect_ratios), sorted(spec["sizes"]["720p"]), mid)
            self.assertEqual(list(e.durations_s), sorted({d for ds in spec["durations"].values() for d in ds}), mid)
            self.assertEqual((e.default_resolution, e.variants_by), ("720p", "resolution"), mid)
        for mid in KREA_IDS:
            e = self.r[mid]
            self.assertIn(e.vendor_model, krea.KreaImageAdapter.SPECS)
            self.assertEqual(sorted(e.aspect_ratios), sorted(krea.KreaImageAdapter.ASPECTS))
            self.assertTrue(set(e.image_sizes) <= set(krea.KreaImageAdapter.SIZES))     # 2K is supported, not offered
            self.assertEqual(e.image_sizes, (krea.KreaImageAdapter.BASE_SIZE,))
            self.assertEqual(e.image_refs_max, krea.KreaImageAdapter.MAX_REFS)
        for mid in LUMA_IDS:
            e = self.r[mid]
            self.assertIn(e.vendor_model, luma.LumaImageAdapter.MODELS)
            self.assertEqual(sorted(e.aspect_ratios), sorted(luma.LumaImageAdapter.ASPECTS))

    def test_probes_are_servable_and_cheap(self):
        req = self.r["krea-3"].probe_request()
        self.assertEqual((req.capability, req.image_size), (T2I, "1K"))               # $0.03
        req = self.r["krea-3-regional"].probe_request(generated_image="https://probe.invalid/x.png")
        self.assertEqual((req.capability, req.image_size), (EDIT, "1K"))
        for mid in LTX_IDS:
            req = self.r[mid].probe_request()
            self.assertEqual((req.capability, req.resolution, req.duration_s), (T2V, "720p", 6), mid)
        for mid in LUMA_IDS:
            self.assertEqual(self.r[mid].probe_request().capability, T2I)

    def test_regional_edit_is_its_own_entry_so_the_global_edit_never_sends_it(self):
        self.assertEqual(self.r["krea-3"].capabilities, ("t2i", "edit"))
        self.assertEqual(self.r["krea-3-regional"].capabilities, ("edit",))
        self.assertEqual(self.r["krea-3-regional"].vendor_model, "krea-3:regional")
        self.assertIn("UNVERIFIED", self.r["krea-3"].raw["api_documented"]["note"])
        self.assertIn("UNVERIFIED", self.r["krea-3-regional"].raw["api_documented"]["note"])

    def test_the_edit_price_note_admits_the_reference_surcharge_is_not_in_the_figures(self):
        note = self.r["krea-3"].raw["pricing"]["note"]
        self.assertIn("+$0.02", note)
        self.assertIn("+$0.07", note)
        self.assertIn("NOT in this figure", note)


# ══ Krea ══════════════════════════════════════════════════════════════════════════

def k_req(**kw) -> CapabilityRequest:
    base = dict(capability=T2I, prompt="a red apple on a white table", image_size="1K")
    return CapabilityRequest(**{**base, **kw})


class KreaCase(VendorCase):
    def adapter(self, **kw) -> krea.KreaImageAdapter:
        return self.build("image.krea", "KREA_API_KEY", "KREA_BASE_URL", kw.pop("hosts", ("localhost",)), **kw)

    def sent(self):
        (req,) = self.vendor.seen("POST", KREA_PATH)
        return req


class KreaSubmitTests(KreaCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", KREA_PATH, Resp(200, {"job_id": "550e8400-e29b-41d4-a716-446655440000"}))

    def test_text_to_image_sends_every_priced_setting_explicitly(self):
        task = self.adapter().submit(k_req(aspect_ratio="16:9", image_size="2K"), "krea-3")
        self.assertEqual((task.adapter, task.vendor_model, task.task_id),
                         ("image.krea", "krea-3", "550e8400-e29b-41d4-a716-446655440000"))
        req = self.sent()
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.json(), {"prompt": "a red apple on a white table", "thinking_mode": "fast",
                                      "resolution": "2K", "aspect_ratio": "16:9"})

    def test_the_size_is_always_explicit_and_one_k_unless_the_job_names_one(self):
        # Krea omitted = 1K; the job bridge passes no image size and the quote prices the base unit (1K).
        self.adapter().submit(k_req(image_size=None), "krea-3")
        self.assertEqual(self.sent().json()["resolution"], "1K")

    def test_the_dearer_thinking_modes_and_every_unverified_field_are_never_sent(self):
        self.adapter().submit(k_req(), "krea-3")
        body = self.sent().json()
        self.assertEqual(body["thinking_mode"], "fast")                      # high +$0.02, ultra +$0.20
        for field in ("regions", "regional_edit", "width", "height", "loras", "style_urls", "priority", "seed",
                      "image_urls", "negative_prompt"):
            self.assertNotIn(field, body, field)

    def test_a_negative_prompt_is_sent_when_asked_and_capped(self):
        self.adapter().submit(k_req(negative_prompt="blur"), "krea-3")
        self.assertEqual(self.sent().json()["negative_prompt"], "blur")
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(k_req(negative_prompt="x" * 1025), "krea-3")
        self.assertIn("1024", cm.exception.message)

    def test_edit_sends_one_picture_and_regional_edit_only_for_the_regional_entry(self):
        a = self.adapter()
        a.submit(CapabilityRequest(EDIT, "make the mug red", image_size="1K", input_images=(self.frame(),)), "krea-3")
        body = self.sent().json()
        self.assertTrue(body["image_urls"][0].startswith("data:image/png;base64,"))
        self.assertNotIn("regional_edit", body)                              # a global edit re-renders the whole picture
        self.vendor.requests.clear()
        a.submit(CapabilityRequest(EDIT, "make the mug red", image_size="2K",
                                   input_images=("https://example.invalid/mug.png",)), "krea-3:regional")
        body = self.sent().json()
        self.assertEqual(body["image_urls"], ["https://example.invalid/mug.png"])
        self.assertIs(body["regional_edit"], True)
        self.assertEqual(body["resolution"], "2K")

    def test_a_setting_the_price_depends_on_is_refused_before_any_call_never_defaulted(self):
        pic = self.frame()
        cases = (
            (k_req(image_size="4K"), "krea-3", "image size"),
            (k_req(image_size="512"), "krea-3", "image size"),
            (k_req(aspect_ratio="5:2"), "krea-3", "aspect ratio"),
            (k_req(quality="high"), "krea-3", "quality"),
            (k_req(prompt=" "), "krea-3", "prompt is empty"),
            (k_req(input_images=(pic,)), "krea-3", "does not apply to text-to-image"),
            (k_req(), "krea-3:regional", "edits a picture"),
            (CapabilityRequest(EDIT, "x", image_size="1K"), "krea-3", "needs a picture"),
            (CapabilityRequest(EDIT, "x", image_size="1K", input_images=(pic, pic)), "krea-3", "takes one picture"),
            (k_req(), "krea-3-ultra", "not a Krea 3 model"),
            (k_req(), "krea-2-medium", "not a Krea 3 model"),
            (k_req(), "", "not a Krea 3 model"),
        )
        for req, model, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.adapter().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_an_unreadable_or_oversized_picture_is_a_refusal_not_a_crash(self):
        for ref in (str(self.tmp / "missing.png"),):
            with self.assertRaises(AdapterError) as cm:
                self.adapter().submit(CapabilityRequest(EDIT, "x", image_size="1K", input_images=(ref,)), "krea-3")
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        with mock.patch.object(krea, "MAX_INLINE_IMAGE_BYTES", 4):
            with self.assertRaises(AdapterError) as cm:
                self.adapter().submit(CapabilityRequest(EDIT, "x", image_size="1K", input_images=(self.frame(),)),
                                      "krea-3")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entries_refuse_what_the_adapter_would_refuse(self):
        a = self.adapter()
        for mid in KREA_IDS:
            entry = reg.get(mid)
            req = entry.probe_request(generated_image="https://probe.invalid/x.png")
            self.assertEqual(a.problems(req, entry), [], mid)
        entry = reg.get("krea-3")
        self.assertTrue(a.problems(k_req(image_size="2K"), entry))       # supported by the adapter, not offered by the entry
        self.assertTrue(a.problems(k_req(aspect_ratio="5:2"), entry))

    def test_no_key_is_a_refusal_before_any_call(self):
        a = self.adapter(env={"KREA_BASE_URL": self.vendor.base_url})
        with self.assertRaises(AdapterError) as cm:
            a.submit(k_req(), "krea-3")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])


class KreaLostAnswerTests(KreaCase):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
        self.assertNotIn(KEY, cm.exception.message)

    def test_a_dropped_connection_a_timeout_and_a_5xx_may_have_billed(self):
        for resp in (Resp(drop=True), Resp(503, {"error": "overloaded"}), Resp(200, {"job_id": "late"}, hang_s=1.5)):
            self.vendor._routes.clear()
            self.vendor.on("POST", KREA_PATH, resp)
            a = self.adapter()
            a.timeout = 0.4
            with self.assertRaises(AdapterError) as cm:
                a.submit(k_req(), "krea-3")
            self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_job_id_may_have_billed(self):
        for body in ({}, {"job_id": ""}, {"job_id": 7}, {"job_id": "../../jobs"}, {"job_id": ".."}, {"job_id": "a.b"},
                      {"job_id": "x" * 300}, [], None):
            self.vendor._routes.clear()
            self.vendor.on("POST", KREA_PATH, Resp(200, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.adapter().submit(k_req(), "krea-3")
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.adapter(env={"KREA_API_KEY": KEY, "KREA_BASE_URL": closed_port_url()})
        with self.assertRaises(AdapterError) as cm:
            a.submit(k_req(), "krea-3")
        self.assertTrue(cm.exception.not_accepted)

    def test_outright_refusals_are_proof_and_an_empty_api_balance_is_quota_not_auth(self):
        cases = ((401, {"error": "Unauthorized"}, E_AUTH),
                 (402, {"message": "Your API balance is separate from your workspace compute balance."}, E_QUOTA),
                 (404, {"error": "Not found"}, E_NOT_FOUND),
                 (429, {"error": "Too many requests, slow down"}, E_RATE_LIMITED))
        for status, body, want in cases:
            self.vendor._routes.clear()
            self.vendor.on("POST", KREA_PATH, Resp(status, body))
            with self.assertRaises(AdapterError, msg=status) as cm:
                self.adapter().submit(k_req(), "krea-3")
            self.assertEqual(cm.exception.code, want, status)
            self.assertTrue(cm.exception.not_accepted, status)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, status)

    def test_a_validation_error_is_the_callers_to_fix_and_a_key_the_vendor_echoes_is_scrubbed(self):
        self.vendor.on("POST", KREA_PATH, Resp(422, {"error": "Validation failed", "details": [{"field": f"x {KEY}"}]}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(k_req(), "krea-3")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertNotIn(KEY, cm.exception.message)

    def test_the_creative_bridge_keeps_the_difference(self):
        entry = reg.get("krea-3")

        def bridged(env, **params):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=self.vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2i", model=entry.id,
                                                  params=dict(prompt="an apple", **params), input_files=()))
        self.vendor.on("POST", KREA_PATH, Resp(drop=True))
        with self.assertRaises(AdapterError) as lost:
            bridged({"KREA_API_KEY": KEY, "KREA_BASE_URL": self.vendor.base_url}, image_size="1K")
        self.assertFalse(lost.exception.not_accepted)            # the worker must not move this job to another model
        refused = FakeVendor()
        self.addCleanup(refused.close)
        refused.on("POST", KREA_PATH, Resp(401, {"error": "bad key"}))
        with self.assertRaises(AdapterError) as no:
            bridged({"KREA_API_KEY": KEY, "KREA_BASE_URL": refused.base_url}, image_size="1K")
        self.assertTrue(no.exception.not_accepted)


class KreaPollTests(KreaCase):
    def status(self, body, jid="job-1", code=200, *, hosts=("localhost",)):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", JOBS + jid, Resp(code, body))
        return self.adapter(hosts=hosts).poll(ProviderTask("image.krea", "krea-3", jid))

    def test_every_in_flight_state_is_pending_and_the_key_goes_only_to_the_api(self):
        for st in ("scheduled", "processing", "queued", "backlogged", "sampling", "intermediate-complete", "brand_new"):
            self.assertEqual(self.status({"job_id": "job-1", "status": st}).state, PENDING, st)
        (req,) = self.vendor.seen("GET", JOBS)
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(self.vendor.seen("POST", ""), [])               # polling never submits

    def test_an_intermediate_result_is_not_a_finished_one(self):
        res = self.status({"status": "intermediate-complete", "result": {"urls": [f"{self.vendor.base_url}/x.png"]}})
        self.assertEqual(res.state, PENDING)

    def test_completed_hands_back_the_picture_link_typed_by_its_extension(self):
        for name, mime in (("a.png", "image/png"), ("a.jpg", "image/jpeg"), ("a.webp", "image/webp"), ("a", "image/png")):
            res = self.status({"status": "completed", "result": {"urls": [f"{self.vendor.base_url}/{name}"]}})
            self.assertEqual((res.state, res.outputs[0].mime), (SUCCEEDED, mime), name)

    def test_failed_and_cancelled_carry_the_vendors_words_and_a_block_is_a_policy_failure(self):
        res = self.status({"status": "failed", "result": {"error": "Content blocked by NSFW moderation"}})
        self.assertEqual((res.state, res.error.code), (FAILED, E_POLICY))
        res = self.status({"status": "failed", "result": {"error": {"message": "generation service error"}}})
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))
        self.assertIn("generation service error", res.error.message)
        res = self.status({"status": "failed"})
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))
        res = self.status({"status": "cancelled"})
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))
        self.assertIn("cancelled", res.error.message)

    def test_a_key_the_vendor_echoes_in_a_failure_is_scrubbed(self):
        res = self.status({"status": "failed", "result": {"error": f"token {KEY} rejected"}})
        self.assertNotIn(KEY, res.error.message)

    def test_every_failed_or_cancelled_job_says_the_spend_is_unknown_and_never_that_it_was_free(self):
        for body in ({"status": "failed", "result": {"error": "x"}}, {"status": "failed"}, {"status": "cancelled"},
                     {"status": "failed", "result": {"error": "blocked by moderation"}}):
            res = self.status(body)
            self.assertEqual(res.state, FAILED)
            self.assertTrue(res.error.message.endswith(krea.SPEND_UNKNOWN), res.error.message)
            self.assertIn("usage page", res.error.message)
            self.assertIn("vendor claim, unverified", res.error.message)   # Krea's "not billed" is quoted as a claim

    def test_completed_without_a_link_may_have_billed_and_says_so(self):
        for result in ({}, {"urls": []}, {"urls": [""]}, {"urls": [5]}, None):
            with self.assertRaises(AdapterError, msg=repr(result)) as cm:
                self.status({"status": "completed", "result": result})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)

    def test_a_link_off_kreas_own_hosts_is_refused_and_names_the_host_it_saw(self):
        for url in ("https://attacker.example/krea.ai/a.png", "http://gen.krea.ai/a.png", "https://evilkrea.ai/a.png",
                    "https://krea.ai.evil.io/a.png", "https://u:p@gen.krea.ai/a.png", "https://gen.krea.ai:8443/a.png"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status({"status": "completed", "result": {"urls": [url]}}, hosts=None)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)
        res = self.status({"status": "completed", "result": {"urls": ["https://gen.krea.ai/images/a.png"]}}, hosts=None)
        self.assertEqual(res.state, SUCCEEDED)
        with self.assertRaises(AdapterError) as cm:
            self.status({"status": "completed", "result": {"urls": ["https://cdn.somewhere-else.example/a.png"]}}, hosts=None)
        self.assertIn("'cdn.somewhere-else.example'", cm.exception.message)

    def test_a_job_id_that_could_steer_the_request_is_refused(self):
        for jid in ("../../assets", "a/b", "a?b=c", "", "x" * 300, "..", ".", "a..b", "a.b", "a:b", "%2e%2e"):
            with self.assertRaises(AdapterError, msg=repr(jid)) as cm:
                self.adapter().poll(ProviderTask("image.krea", "krea-3", jid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_is_typed(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"error": "not found"}, code=404)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        with self.assertRaises(AdapterError) as cm:
            self.status({"error": "bad gateway"}, code=502)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)             # the job is still Krea's: poll again


class KreaEndToEndTests(KreaCase):
    def run_probe(self, polls, *, entry_id="krea-3", timeout_s=600):
        from tools.probe_models import run_probe

        self.vendor.on("POST", KREA_PATH, Resp(200, {"job_id": "job-9"}))
        self.vendor.on("GET", JOBS + "job-9", polls)
        self.vendor.on("GET", "/result.png", Resp(200, raw=png()))
        clock = {"t": 0.0}
        with mock.patch.object(krea.KreaImageAdapter, "result_hosts", ("localhost",)), \
                mock.patch.object(krea.KreaImageAdapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(entry_id), env={"KREA_API_KEY": KEY, "KREA_BASE_URL": self.vendor.base_url},
                             voice_id=None, workdir=self.tmp, timeout_s=timeout_s, poll_every_s=2,
                             session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def test_the_probe_runs_the_whole_chain_and_stores_a_real_picture(self):
        done = Resp(200, {"status": "completed", "result": {"urls": [f"{self.vendor.base_url}/result.png"]}})
        res = self.run_probe([Resp(200, {"status": "queued"}), Resp(200, {"status": "processing"}), done])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(png()))
        self.assertEqual(len(self.vendor.seen("POST", KREA_PATH)), 1)       # polling never re-submitted
        body = self.sent_body()
        self.assertEqual((body["resolution"], body["thinking_mode"], body["aspect_ratio"]), ("1K", "fast", "1:1"))

    def sent_body(self):
        return self.vendor.seen("POST", KREA_PATH)[0].json()

    def test_the_regional_entry_probe_sends_regional_edit(self):
        done = Resp(200, {"status": "completed", "result": {"urls": [f"{self.vendor.base_url}/result.png"]}})
        res = self.run_probe([done], entry_id="krea-3-regional")
        self.assertTrue(res.ok, res.message)
        body = self.sent_body()
        self.assertIs(body["regional_edit"], True)
        self.assertTrue(body["image_urls"][0].startswith("data:image/png;base64,"))

    def test_a_job_that_never_finishes_ends_as_a_timeout_that_names_the_job(self):
        res = self.run_probe([Resp(200, {"status": "processing"})], timeout_s=30)
        self.assertEqual((res.ok, res.code, res.task_id), (False, "timeout", "job-9"))   # it may still bill

    def test_an_expired_picture_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/gone.png", Resp(403, {"error": "expired"}))
        res = self.run_probe([Resp(200, {"status": "completed", "result": {"urls": [f"{self.vendor.base_url}/gone.png"]}})])
        self.assertEqual((res.ok, res.code), (False, E_NOT_FOUND))
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)


# ══ LTX ═══════════════════════════════════════════════════════════════════════════

def l_req(**kw) -> CapabilityRequest:
    base = dict(capability=T2V, prompt="a boat at dawn", resolution="720p", duration_s=6)
    return CapabilityRequest(**{**base, **kw})


class LtxCase(VendorCase):
    def adapter(self, **kw) -> ltx.LtxVideoAdapter:
        return self.build("video.ltx", "LTX_API_KEY", "LTX_BASE_URL", kw.pop("hosts", ("localhost",)), **kw)


class LtxSubmitTests(LtxCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", T2V_PATH, Resp(202, {"id": "a1b2c3d4-e5f6", "created_at": "2026-10-25T10:00:00Z"}))
        self.vendor.on("POST", I2V_PATH, Resp(202, {"id": "i1j2k3", "created_at": "2026-10-25T10:00:00Z"}))

    def sent(self, path=T2V_PATH):
        (req,) = self.vendor.seen("POST", path)
        return req

    def test_text_to_video_sends_every_priced_setting_explicitly(self):
        task = self.adapter().submit(l_req(), "ltx-2-5-pro")
        self.assertEqual((task.adapter, task.vendor_model, task.task_id),
                         ("video.ltx", "ltx-2-5-pro", "text-to-video:a1b2c3d4-e5f6"))   # the endpoint rides in the id
        req = self.sent()
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.json(), {"prompt": "a boat at dawn", "model": "ltx-2-5-pro", "duration": 6,
                                      "resolution": "1280x720", "fps": 24})

    def test_the_resolution_is_sent_as_the_width_by_height_the_docs_list_for_the_shape(self):
        cases = (("ltx-2-5-pro", "1080p", "9:16", "1080x1920"), ("ltx-2-5-pro", "1440p", "1:1", "1440x1440"),
                 ("ltx-2-5-fast", "4k", "3:2", "3240x2160"), ("ltx-2-5-fast", "720p", "2:3", "720x1080"),
                 ("ltx-2-3-pro", "4k", "16:9", "3840x2160"), ("ltx-2-3-fast", "1440p", "9:16", "1440x2560"))
        for model, res, shape, want in cases:
            self.vendor.requests.clear()
            self.adapter().submit(l_req(resolution=res, aspect_ratio=shape, duration_s=6), model)
            self.assertEqual(self.sent().json()["resolution"], want, (model, res, shape))

    def test_duration_null_automatic_duration_is_never_sent(self):
        self.adapter().submit(l_req(duration_s=10), "ltx-2-5-pro")
        self.assertIs(type(self.sent().json()["duration"]), int)
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(l_req(duration_s=None), "ltx-2-5-pro")      # the vendor would hold credits for 20 s
        self.assertIn("never defaulted or left to the model to choose", cm.exception.message)

    def test_the_sound_flag_is_sent_only_when_the_job_names_it(self):
        for audio in (None, True, False):
            self.vendor.requests.clear()
            self.adapter().submit(l_req(audio=audio), "ltx-2-3-fast")
            body = self.sent().json()
            self.assertEqual("generate_audio" in body, audio is not None)
            if audio is not None:
                self.assertIs(body["generate_audio"], audio)

    def test_picture_to_video_goes_to_its_own_endpoint_with_the_picture_inline_or_as_a_link(self):
        a = self.adapter()
        task = a.submit(CapabilityRequest(I2V, "slow push in", resolution="720p", duration_s=6,
                                          input_images=(self.frame(),)), "ltx-2-3-pro")
        self.assertEqual(task.task_id, "image-to-video:i1j2k3")
        body = self.sent(I2V_PATH).json()
        self.assertTrue(body["image_uri"].startswith("data:image/png;base64,"))
        self.assertEqual((body["model"], body["resolution"], body["fps"]), ("ltx-2-3-pro", "1280x720", 24))
        self.assertNotIn("last_frame_uri", body)
        self.vendor.requests.clear()
        a.submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=6, input_images=("https://example.invalid/a.png",)),
                 "ltx-2-3-pro")
        self.assertEqual(self.sent(I2V_PATH).json()["image_uri"], "https://example.invalid/a.png")

    def test_a_setting_the_price_depends_on_is_refused_before_any_call_never_defaulted(self):
        pic = self.frame()
        gif = self.tmp / "a.gif"
        gif.write_bytes(b"GIF89a")
        cases = (
            ("ltx-2-5-pro", l_req(resolution=None), "resolution"),
            ("ltx-2-5-pro", l_req(resolution="480p"), "resolution"),
            ("ltx-2-5-pro", l_req(duration_s=None), "duration"),
            ("ltx-2-5-pro", l_req(duration_s=5), "duration"),                    # not in the table
            ("ltx-2-5-pro", l_req(duration_s=12), "duration"),                   # Pro stops at 10 s
            ("ltx-2-5-fast", l_req(resolution="1440p", duration_s=12), "duration"),   # Fast: 12-20 s only up to 1080p
            ("ltx-2-5-fast", l_req(resolution="4k", duration_s=20), "duration"),
            ("ltx-2-5-fast", l_req(duration_s=22), "duration"),
            ("ltx-2-3-pro", l_req(aspect_ratio="1:1"), "aspect ratio"),          # 2.3 is 16:9 and 9:16 only
            ("ltx-2-5-pro", l_req(aspect_ratio="21:9"), "aspect ratio"),
            ("ltx-2-5-pro", l_req(negative_prompt="blur"), "negative prompt"),
            ("ltx-2-5-pro", l_req(prompt=" "), "prompt is empty"),
            ("ltx-2-5-pro", l_req(input_images=(pic,)), "does not apply to text-to-video"),
            ("ltx-2-5-pro", CapabilityRequest(I2V, "x", resolution="720p", duration_s=6), "first-frame picture"),
            ("ltx-2-5-pro", CapabilityRequest(I2V, "x", resolution="720p", duration_s=6, input_images=(str(gif),)),
             "JPEG, PNG or WEBP"),
            ("ltx-2-1", l_req(), "not an LTX model"),
            ("ltx-2-5-pro-hdr", l_req(), "not an LTX model"),
            ("", l_req(), "not an LTX model"),
        )
        for model, req, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.adapter().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_long_clips_fast_offers_are_accepted_where_the_docs_allow_them(self):
        for res in ("720p", "1080p"):
            self.vendor.requests.clear()
            self.adapter().submit(l_req(resolution=res, duration_s=20), "ltx-2-5-fast")
            self.assertEqual(self.sent().json()["duration"], 20)

    def test_the_registry_entries_refuse_what_the_adapter_would_refuse(self):
        a = self.adapter()
        for mid in LTX_IDS:
            entry = reg.get(mid)
            self.assertEqual(a.problems(entry.probe_request(), entry), [], mid)
        entry = reg.get("ltx-2.5-fast")
        self.assertTrue(a.problems(l_req(resolution="4k", duration_s=12), entry))
        self.assertTrue(a.problems(l_req(duration_s=None), entry))

    def test_no_key_is_a_refusal_before_any_call(self):
        a = self.adapter(env={"LTX_BASE_URL": self.vendor.base_url})
        with self.assertRaises(AdapterError) as cm:
            a.submit(l_req(), "ltx-2-5-pro")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertEqual(self.vendor.requests, [])

    def test_either_name_of_the_key_works(self):
        for name in ("LTX_API_KEY", "LTXV_API_KEY"):
            self.assertTrue(build_adapter("video.ltx", env={name: KEY}).configured(), name)


class LtxLostAnswerTests(LtxCase):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)

    def test_a_dropped_connection_a_timeout_and_a_5xx_may_have_billed(self):
        for resp in (Resp(drop=True), Resp(503, {"type": "error", "error": {"type": "service_unavailable_error", "message": "x"}}),
                     Resp(202, {"id": "late"}, hang_s=1.5)):
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, resp)
            a = self.adapter()
            a.timeout = 0.4
            with self.assertRaises(AdapterError) as cm:
                a.submit(l_req(), "ltx-2-5-pro")
            self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_id_may_have_billed(self):
        for body in ({}, {"id": ""}, {"id": 7}, {"id": "../x"}, {"id": "a:b"}, {"id": "x" * 300}, [], None):
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, Resp(202, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.adapter().submit(l_req(), "ltx-2-5-pro")
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_the_vendors_error_types_beat_the_http_status_and_proven_refusals_are_proof(self):
        cases = ((401, "authentication_error", E_AUTH, True), (402, "insufficient_funds_error", E_QUOTA, True),
                 (403, "permission_error", E_AUTH, True), (429, "rate_limit_error", E_RATE_LIMITED, True),
                 (429, "concurrency_limit_error", E_RATE_LIMITED, True), (404, "not_found_error", E_NOT_FOUND, True),
                 (422, "content_filtered_error", E_POLICY, False), (400, "invalid_request_error", E_BAD_REQUEST, False),
                 (413, "request_too_large_error", E_BAD_REQUEST, False))
        for status, etype, want, proof in cases:
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, Resp(status, {"type": "error", "error": {"type": etype, "message": f"m {KEY}"}}))
            with self.assertRaises(AdapterError, msg=etype) as cm:
                self.adapter().submit(l_req(), "ltx-2-5-pro")
            self.assertEqual(cm.exception.code, want, etype)
            self.assertEqual(cm.exception.not_accepted, proof, etype)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, etype)
            self.assertNotIn(KEY, cm.exception.message, etype)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.adapter(env={"LTX_API_KEY": KEY, "LTX_BASE_URL": closed_port_url()})
        with self.assertRaises(AdapterError) as cm:
            a.submit(l_req(), "ltx-2-5-pro")
        self.assertTrue(cm.exception.not_accepted)

    def test_the_creative_bridge_keeps_the_difference(self):
        entry = reg.get("ltx-2.3-fast")

        def bridged(env, **params):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=self.vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2v", model=entry.id,
                                                  params=dict(prompt="a boat", duration_s=6, **params), input_files=()))
        with self.assertRaises(ca.CreativeAdapterError) as cm:           # the job carries no resolution: not quoted
            bridged({"LTX_API_KEY": KEY, "LTX_BASE_URL": self.vendor.base_url})
        self.assertIn("no resolution", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])
        self.vendor.on("POST", T2V_PATH, Resp(drop=True))
        with self.assertRaises(AdapterError) as lost:
            bridged({"LTX_API_KEY": KEY, "LTX_BASE_URL": self.vendor.base_url}, resolution="720p")
        self.assertFalse(lost.exception.not_accepted)


class LtxPollTests(LtxCase):
    def status(self, body, tid="text-to-video:job-1", code=200, *, hosts=("localhost",)):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        endpoint, _, jid = tid.partition(":")
        self.vendor.on("GET", f"/v2/{endpoint}/{jid}", Resp(code, body))
        return self.adapter(hosts=hosts).poll(ProviderTask("video.ltx", "ltx-2-5-pro", tid))

    def test_pending_and_processing_are_pending_and_the_endpoint_comes_from_the_task_id(self):
        for st in ("pending", "processing", "something_new"):
            self.assertEqual(self.status({"id": "job-1", "status": st}).state, PENDING, st)
        self.assertEqual(self.status({"status": "pending"}, "image-to-video:job-2").state, PENDING)
        (req,) = self.vendor.seen("GET", "/v2/image-to-video/job-2")
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(self.vendor.seen("POST", ""), [])               # polling never submits

    def test_completed_hands_back_the_clip_link(self):
        res = self.status({"status": "completed", "result": {"video_url": f"{self.vendor.base_url}/clip.mp4"}})
        self.assertEqual((res.state, res.outputs[0].mime), (SUCCEEDED, "video/mp4"))

    def test_a_failed_job_carries_the_vendors_error_type_and_the_right_remedy(self):
        cases = (("content_filtered_error", E_POLICY), ("insufficient_funds_error", E_QUOTA), ("api_error", E_UNAVAILABLE),
                 ("invalid_request_error", E_BAD_REQUEST), ("overloaded_error", E_UNAVAILABLE), ("brand_new_type", E_UNAVAILABLE))
        for etype, want in cases:
            res = self.status({"status": "failed", "error": {"type": etype, "message": f"it broke {KEY}"}})
            self.assertEqual((res.state, res.error.code), (FAILED, want), etype)
            self.assertNotIn(KEY, res.error.message)
            self.assertTrue(res.error.message.endswith(ltx.SPEND_UNKNOWN), res.error.message)
            self.assertIn("usage page", res.error.message)
        res = self.status({"status": "failed"})
        self.assertEqual(res.error.code, E_UNAVAILABLE)
        self.assertTrue(res.error.message.endswith(ltx.SPEND_UNKNOWN))     # the docs are silent on a failed job's cost

    def test_completed_without_a_link_may_have_billed_and_says_so(self):
        for result in ({}, {"video_url": ""}, {"video_url": 5}, None):
            with self.assertRaises(AdapterError, msg=repr(result)) as cm:
                self.status({"status": "completed", "result": result})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))

    def test_only_the_one_documented_host_is_allowed_and_any_other_names_itself(self):
        ok = self.status({"status": "completed", "result": {"video_url": "https://storage.googleapis.com/bkt/v.mp4?X=1"}},
                         hosts=None)
        self.assertEqual(ok.state, SUCCEEDED)
        for url in ("http://storage.googleapis.com/b/v.mp4", "https://evilstorage.googleapis.com.io/v.mp4",
                    "https://storage.googleapis.com.attacker.example/v.mp4", "https://attacker.example/storage.googleapis.com/v.mp4",
                    "https://cdn.ltx.io/v.mp4", "https://storage.googleapis.com:8443/b/v.mp4"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status({"status": "completed", "result": {"video_url": url}}, hosts=None)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)
        with self.assertRaises(AdapterError) as cm:
            self.status({"status": "completed", "result": {"video_url": "https://cdn.ltx.io/v.mp4"}}, hosts=None)
        self.assertIn("'cdn.ltx.io'", cm.exception.message)

    def test_a_task_id_that_could_steer_the_request_is_refused(self):
        for tid in ("../../v2/x", "text-to-video", "text-to-video:", "retake:abc", "text-to-video:a/b", "text-to-video:a?b",
                    ":abc", "", "text-to-video:" + "x" * 300, "image-to-video:../x", "text-to-video:..", "text-to-video:.",
                    "text-to-video:a.b", "image-to-video:a:b"):
            with self.assertRaises(AdapterError, msg=repr(tid)) as cm:
                self.adapter().poll(ProviderTask("video.ltx", "ltx-2-5-pro", tid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_is_typed(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"type": "error", "error": {"type": "not_found_error", "message": "expired"}}, code=404)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        with self.assertRaises(AdapterError) as cm:
            self.status({"type": "error", "error": {"type": "api_error", "message": "x"}}, code=500)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)


class LtxEndToEndTests(LtxCase):
    def run_probe(self, polls, *, entry_id="ltx-2.3-fast", timeout_s=600):
        from tools.probe_models import run_probe

        self.vendor.on("POST", T2V_PATH, Resp(202, {"id": "job-9"}))
        self.vendor.on("GET", "/v2/text-to-video/job-9", polls)
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4))
        clock = {"t": 0.0}
        with mock.patch.object(ltx.LtxVideoAdapter, "result_hosts", ("localhost",)), \
                mock.patch.object(ltx.LtxVideoAdapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(entry_id), env={"LTX_API_KEY": KEY, "LTX_BASE_URL": self.vendor.base_url},
                             voice_id=None, workdir=self.tmp, timeout_s=timeout_s, poll_every_s=5,
                             session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def test_the_probe_runs_the_whole_chain_and_stores_a_real_clip(self):
        done = Resp(200, {"status": "completed", "result": {"video_url": f"{self.vendor.base_url}/clip.mp4"}})
        res = self.run_probe([Resp(200, {"status": "pending"}), Resp(200, {"status": "processing"}), done])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(MP4))
        body = self.vendor.seen("POST", T2V_PATH)[0].json()
        self.assertEqual((body["model"], body["duration"], body["resolution"], body["fps"]), ("ltx-2-3-fast", 6, "1280x720", 24))
        self.assertEqual(len(self.vendor.seen("POST", T2V_PATH)), 1)

    def test_a_job_that_never_finishes_ends_as_a_timeout_that_names_the_job(self):
        res = self.run_probe([Resp(200, {"status": "processing"})], timeout_s=30)
        self.assertEqual((res.ok, res.code, res.task_id), (False, "timeout", "text-to-video:job-9"))

    def test_an_expired_clip_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/expired.mp4", Resp(403, {"error": "expired"}))
        res = self.run_probe([Resp(200, {"status": "completed", "result": {"video_url": f"{self.vendor.base_url}/expired.mp4"}})])
        self.assertEqual((res.ok, res.code), (False, E_NOT_FOUND))
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)


# ══ Luma ══════════════════════════════════════════════════════════════════════════

def u_req(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2I, prompt="a red apple on a white table"), **kw})


class LumaCase(VendorCase):
    def adapter(self, **kw) -> luma.LumaImageAdapter:
        return self.build("image.luma", "LUMA_AGENTS_API_KEY", "LUMA_AGENTS_BASE_URL", kw.pop("hosts", ("localhost",)), **kw)


class LumaTests(LumaCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", LUMA_PATH, Resp(201, {"id": "d290f1ee-6c54", "type": "image", "state": "queued",
                                                      "model": "uni-1", "output": [], "failure_code": None}))

    def sent(self):
        (req,) = self.vendor.seen("POST", LUMA_PATH)
        return req

    def test_text_to_image_sends_the_model_the_type_and_a_png_request(self):
        task = self.adapter().submit(u_req(aspect_ratio="16:9"), "uni-1-max")
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("image.luma", "uni-1-max", "d290f1ee-6c54"))
        req = self.sent()
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.json(), {"model": "uni-1-max", "type": "image", "prompt": "a red apple on a white table",
                                      "output_format": "png", "aspect_ratio": "16:9"})

    def test_no_ratio_leaves_the_models_own_choice_and_nothing_priced_is_added(self):
        self.adapter().submit(u_req(), "uni-1")
        body = self.sent().json()
        self.assertNotIn("aspect_ratio", body)
        for field in ("style", "web_search", "image_ref", "source", "video"):
            self.assertNotIn(field, body, field)

    def test_a_setting_that_does_not_apply_is_refused_before_any_call(self):
        cases = ((u_req(aspect_ratio="4:3"), "uni-1", "aspect ratio"), (u_req(aspect_ratio="21:9"), "uni-1", "aspect ratio"),
                 (u_req(image_size="1K"), "uni-1", "every output is 2K"), (u_req(quality="high"), "uni-1", "quality"),
                 (u_req(negative_prompt="x"), "uni-1", "negative prompt"), (u_req(prompt=" "), "uni-1", "prompt is empty"),
                 (u_req(prompt="x" * 6001), "uni-1", "6000"),
                 (u_req(input_images=(self.frame(),)), "uni-1", "text-to-image only"),
                 (CapabilityRequest(EDIT, "x", input_images=(self.frame(),)), "uni-1", "text-to-image only"),
                 (u_req(), "ray-3.2", "not a Luma image model"), (u_req(), "photon-1", "not a Luma image model"),
                 (u_req(), "", "not a Luma image model"))
        for req, model, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.adapter().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entries_refuse_what_the_adapter_would_refuse(self):
        a = self.adapter()
        for mid in LUMA_IDS:
            entry = reg.get(mid)
            self.assertEqual(a.problems(entry.probe_request(), entry), [], mid)
            self.assertTrue(a.problems(u_req(image_size="1K"), entry), mid)

    def test_no_key_is_a_refusal_before_any_call(self):
        a = self.adapter(env={"LUMA_AGENTS_BASE_URL": self.vendor.base_url})
        with self.assertRaises(AdapterError) as cm:
            a.submit(u_req(), "uni-1")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertEqual(self.vendor.requests, [])

    def test_lost_answers_may_have_billed_and_refusals_did_not(self):
        for resp in (Resp(drop=True), Resp(502, {"detail": "upstream"}), Resp(201, {})):
            self.vendor._routes.clear()
            self.vendor.on("POST", LUMA_PATH, resp)
            with self.assertRaises(AdapterError) as cm:
                self.adapter().submit(u_req(), "uni-1")
            self.assertFalse(cm.exception.not_accepted)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
        for body in ({"id": 7}, {"id": "../x"}, {"id": "x" * 100}, [], None):
            self.vendor._routes.clear()
            self.vendor.on("POST", LUMA_PATH, Resp(201, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.adapter().submit(u_req(), "uni-1")
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))
        for status, body, want in ((401, {"detail": "bad key"}, E_AUTH), (402, {"detail": "Insufficient balance"}, E_QUOTA),
                                   (429, {"detail": "slow down"}, E_RATE_LIMITED), (404, {"detail": "no"}, E_NOT_FOUND)):
            self.vendor._routes.clear()
            self.vendor.on("POST", LUMA_PATH, Resp(status, body))
            with self.assertRaises(AdapterError, msg=status) as cm:
                self.adapter().submit(u_req(), "uni-1")
            self.assertEqual(cm.exception.code, want, status)
            self.assertTrue(cm.exception.not_accepted, status)
        self.vendor._routes.clear()
        self.vendor.on("POST", LUMA_PATH, Resp(422, {"detail": "aspect_ratio='1:1' is not allowed when style='manga'"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(u_req(), "uni-1")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)

    def poll(self, body, gid="gen-1", code=200, *, hosts=("localhost",)):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", f"{LUMA_PATH}/{gid}", Resp(code, body))
        return self.adapter(hosts=hosts).poll(ProviderTask("image.luma", "uni-1", gid))

    def test_queued_and_processing_are_pending(self):
        for st in ("queued", "processing", "new_state"):
            self.assertEqual(self.poll({"state": st}).state, PENDING, st)

    def test_completed_hands_back_the_picture_link(self):
        res = self.poll({"state": "completed", "output": [{"type": "image", "url": f"{self.vendor.base_url}/o.png"}]})
        self.assertEqual((res.state, res.outputs[0].mime), (SUCCEEDED, "image/png"))

    def test_failure_codes_map_to_the_right_remedy(self):
        cases = (("content_moderated", E_POLICY), ("budget_exhausted", E_QUOTA), ("rate_limited", E_RATE_LIMITED),
                 ("invalid_request", E_BAD_REQUEST), ("image_too_large", E_BAD_REQUEST), ("generation_failed", E_UNAVAILABLE),
                 ("output_not_found", E_UNAVAILABLE), ("brand_new_code", E_UNAVAILABLE))
        for code, want in cases:
            res = self.poll({"state": "failed", "failure_code": code, "failure_reason": f"why {KEY}"})
            self.assertEqual((res.state, res.error.code), (FAILED, want), code)
            self.assertNotIn(KEY, res.error.message)
            self.assertTrue(res.error.message.endswith(luma.SPEND_UNKNOWN), res.error.message)
            self.assertIn("usage page", res.error.message)
            self.assertIn("unverified", res.error.message)                 # Luma's refund list is quoted as its statement, never as fact
            self.assertNotIn("were refunded", res.error.message.lower())

    def test_completed_without_a_link_may_have_billed_and_says_so(self):
        for out in ([], [{}], [{"url": ""}], None, "x"):
            with self.assertRaises(AdapterError, msg=repr(out)) as cm:
                self.poll({"state": "completed", "output": out})
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))

    def test_with_no_known_result_host_every_link_is_refused_and_names_the_host_it_saw(self):
        # The docs show a placeholder host only. Until a person has read the real one off a probe, nothing downloads.
        self.assertEqual(luma.RESULT_HOSTS, ())
        for url in ("https://storage.example.com/generations/x/output.png?X-Amz-Expires=3600",
                    "https://lumalabs.ai/x.png", "http://storage.cdn-luma.com/x.png"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.poll({"state": "completed", "output": [{"url": url}]}, hosts=None)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)
            self.assertIn("it was not downloaded", cm.exception.message)
        with self.assertRaises(AdapterError) as cm:
            self.poll({"state": "completed", "output": [{"url": "https://storage.example.com/x.png"}]}, hosts=None)
        self.assertIn("'storage.example.com'", cm.exception.message)

    def test_a_generation_id_that_could_steer_the_request_is_refused(self):
        for gid in ("../../v1/files", "a/b", "a?b=c", "", "x" * 100, "..", ".", "a.b", "a:b"):
            with self.assertRaises(AdapterError, msg=repr(gid)) as cm:
                self.adapter().poll(ProviderTask("image.luma", "uni-1", gid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_the_probe_runs_the_whole_chain_once_a_host_is_allowed(self):
        from tools.probe_models import run_probe

        self.vendor.on("GET", f"{LUMA_PATH}/d290f1ee-6c54", [
            Resp(200, {"state": "processing"}),
            Resp(200, {"state": "completed", "output": [{"type": "image", "url": f"{self.vendor.base_url}/o.png"}]})])
        self.vendor.on("GET", "/o.png", Resp(200, raw=png()))
        clock = {"t": 0.0}
        with mock.patch.object(luma.LumaImageAdapter, "result_hosts", ("localhost",)), \
                mock.patch.object(luma.LumaImageAdapter, "result_ports", (None, 443, self.vendor.port)):
            res = run_probe(reg.get("luma-uni-1"), env={"LUMA_AGENTS_API_KEY": KEY, "LUMA_AGENTS_BASE_URL": self.vendor.base_url},
                            voice_id=None, workdir=self.tmp, session=self.vendor.session(), poll_every_s=2,
                            sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(len(self.vendor.seen("POST", LUMA_PATH)), 1)

    def test_the_probe_as_shipped_fails_closed_and_says_where_the_money_went(self):
        from tools.probe_models import run_probe

        self.vendor.on("GET", f"{LUMA_PATH}/d290f1ee-6c54",
                       Resp(200, {"state": "completed", "output": [{"url": f"{self.vendor.base_url}/o.png"}]}))
        res = run_probe(reg.get("luma-uni-1"), env={"LUMA_AGENTS_API_KEY": KEY, "LUMA_AGENTS_BASE_URL": self.vendor.base_url},
                        voice_id=None, workdir=self.tmp, session=self.vendor.session(), sleep=lambda s: None)
        self.assertEqual((res.ok, res.code), (False, E_BAD_RESPONSE))
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)


# ══ local pictures ════════════════════════════════════════════════════════════════

class LocalPictureTests(VendorCase):
    """A path comes from a job. Only a real picture may be read from it and sent to a vendor."""

    def secret_file(self, name="notes.png", body=b"DB_PASSWORD=hunter2\n" * 20) -> str:
        p = self.tmp / name
        p.write_bytes(body)
        return str(p)

    def submitters(self):
        k = KreaCase()
        k.vendor = self.vendor
        l = LtxCase()
        l.vendor = self.vendor
        self.vendor.on("POST", KREA_PATH, Resp(200, {"job_id": "j1"}))
        self.vendor.on("POST", I2V_PATH, Resp(202, {"id": "i1"}))
        yield ("krea", lambda ref: k.adapter().submit(CapabilityRequest(EDIT, "x", image_size="1K", input_images=(ref,)), "krea-3"))
        yield ("krea-regional", lambda ref: k.adapter().submit(
            CapabilityRequest(EDIT, "x", image_size="1K", input_images=(ref,)), "krea-3:regional"))
        yield ("ltx", lambda ref: l.adapter().submit(
            CapabilityRequest(I2V, "go", resolution="720p", duration_s=6, input_images=(ref,)), "ltx-2-5-pro"))

    def test_a_file_that_only_wears_a_picture_suffix_is_refused_and_nothing_is_sent(self):
        bodies = {"text": b"DB_PASSWORD=hunter2\n" * 20, "html": b"<html><body>login</body></html>", "zip": b"PK\x03\x04" + b"\x00" * 64,
                  "gif": b"GIF89a" + b"\x00" * 64, "svg": b"<svg xmlns='http://www.w3.org/2000/svg'/>", "empty": b""}
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

    def test_a_real_picture_is_labelled_with_the_type_its_bytes_say_not_its_suffix(self):
        from PIL import Image

        jpeg = io.BytesIO()
        Image.new("RGB", (8, 8), (10, 20, 30)).save(jpeg, "JPEG")
        webp = io.BytesIO()
        Image.new("RGB", (8, 8), (10, 20, 30)).save(webp, "WEBP")
        for body, mime in ((png(), "image/png"), (jpeg.getvalue(), "image/jpeg"), (webp.getvalue(), "image/webp")):
            uri = pictures.inline_picture(self.secret_file("liar.png", body), max_bytes=1 << 20, who="x")   # a .png suffix on every one
            self.assertTrue(uri.startswith(f"data:{mime};base64,"), (mime, uri[:30]))

    def test_the_end_to_end_body_carries_the_labelled_picture(self):
        for who, submit in self.submitters():
            self.vendor.requests.clear()
            submit(self.frame(f"{who}.png"))
            (req,) = self.vendor.requests
            blob = req.body.decode()
            self.assertIn("data:image/png;base64,", blob, who)

    def test_a_missing_or_oversized_picture_and_a_link_behave_as_before(self):
        with self.assertRaises(AdapterError) as cm:
            pictures.inline_picture(str(self.tmp / "gone.png"), max_bytes=1 << 20, who="x")
        self.assertIn("could not be read", cm.exception.message)
        with self.assertRaises(AdapterError) as cm:
            pictures.inline_picture(self.frame(), max_bytes=4, who="x")
        self.assertIn("over", cm.exception.message)
        self.assertEqual(pictures.inline_picture("https://example.invalid/a.png", max_bytes=1, who="x"),
                         "https://example.invalid/a.png")
        with self.assertRaises(AdapterError):
            pictures.inline_picture("http://example.invalid/a.png", max_bytes=1 << 20, who="x")    # not https: treated as a path


# ══ wiring ════════════════════════════════════════════════════════════════════════

class WiringTests(unittest.TestCase):
    def test_result_hosts_are_what_the_docs_show_and_only_tests_widen_the_port(self):
        self.assertEqual(krea.KreaImageAdapter.result_hosts, ("krea.ai",))
        self.assertEqual(ltx.LtxVideoAdapter.result_hosts, ("storage.googleapis.com",))
        self.assertEqual(luma.LumaImageAdapter.result_hosts, ())
        for cls in (krea.KreaImageAdapter, ltx.LtxVideoAdapter, luma.LumaImageAdapter):
            self.assertEqual(cls.result_ports, (None, 443))

    def test_the_new_keys_are_ones_the_worker_the_probe_workflow_and_the_doctor_can_be_given(self):
        example = (ROOT / "deploy" / ".env.worker.example").read_text()
        deploy = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text()
        probe = (ROOT / ".github" / "workflows" / "probe_models.yml").read_text()
        doctor = (ROOT / "tools" / "doctor.py").read_text()
        for name in ("KREA_API_KEY", "LTX_API_KEY"):
            self.assertRegex(example, rf"(?m)^{name}=$")                    # empty in the example, never a value
            self.assertIn(f"WORKERENV_{name}: ${{{{ secrets.{name} }}}}", deploy)
            self.assertIn(f"{name}: ${{{{ secrets.{name} }}}}", probe)
            self.assertIn(f'"{name}"', doctor)
        # Luma's key was wired for Ray and serves Uni-1 unchanged.
        self.assertEqual(luma.LumaImageAdapter.key_env, ("LUMA_AGENTS_API_KEY",))
        self.assertRegex(example, r"(?m)^LUMA_AGENTS_API_KEY=$")
        self.assertEqual(krea.KreaImageAdapter.key_env, ("KREA_API_KEY",))
        self.assertEqual(ltx.LtxVideoAdapter.key_env, ("LTX_API_KEY", "LTXV_API_KEY"))

    def test_all_probe_skips_every_new_gated_entry_and_a_named_one_comes_back(self):
        from tools import probe_models

        entries = list(reg.registry().values())
        chosen = {e.id for e in probe_models.select(entries, [], None, True)}
        self.assertFalse(chosen & set(NEW_IDS), chosen & set(NEW_IDS))
        for mid in NEW_IDS:
            self.assertIn(mid, {e.id for e in probe_models.select(entries, [mid], None, True)})
            self.assertIn(mid, {e.id for e in probe_models.gated_left_out(entries, [], None, True)})
        for cap in ("t2v", "i2v", "t2i", "edit"):
            self.assertFalse({e.id for e in probe_models.select(entries, [], cap, True)} & set(NEW_IDS), cap)


if __name__ == "__main__":
    unittest.main()
