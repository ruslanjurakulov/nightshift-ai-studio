"""FLUX 3 Image and FLUX 3 Image Klein (Black Forest Labs' own API): the adapter, the
registry entries, the two small changes to shared code they need, and the rule that
none of it is for sale.

The adapter talks to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py):
no network, no key, no spend.

What would break without these tests:

* a FLUX.2 field (``width``, ``height``, ``seed``) sent to FLUX 3, which answers 422 to
  unknown fields; or the priced ``resolution`` defaulted instead of refused;
* ``grounding`` (web search with the customer's prompt) left on by the vendor's default;
* a task BFL failed (HTTP 503 with a normal JSON body) read as an outage and retried, or
  a real outage read as a finished task;
* the key sent to the signed download link, a redirect followed, or a result fetched from a
  host that is not BFL's;
* a picture stored under the wrong type, or a non-picture stored at all;
* a submit whose answer was lost being treated as "nothing was bought";
* a message that tells a person a moderated or failed task was not billed (BFL does not say so);
* a model whose terms nobody has decided becoming sellable.
"""

from __future__ import annotations

import io
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
    PENDING,
    SUCCEEDED,
    T2I,
    AdapterError,
    CapabilityRequest,
    Output,
    PollResult,
    ProviderTask,
)
from modules.capabilities.bfl import BILLING_UNKNOWN, Flux3ImageAdapter
from modules.capabilities.safe_fetch import ANY_IMAGE, AFTER_COMPLETION, UNCONFIRMED, SafeResultMixin
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url

ROOT = Path(__file__).resolve().parent.parent
KEY = "bfl-test-NOT-A-REAL-KEY-0123456789abcdef"
F3, KLEIN = "flux-3-image", "flux-3-image-klein"
IDS = (F3, KLEIN)
PROBE_IDS = (*IDS, "recraft-v4.1", "recraft-v4.1-flash")


def tearDownModule():
    cleanup_certificate()


def picture(kind: str = "PNG") -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, kind)
    return buf.getvalue()


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="flux3_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.env = {"BFL_API_KEY": KEY, "BFL_BASE_URL": self.vendor.base_url + "/v1"}

    def adapter(self, env=None, vendor=None) -> Flux3ImageAdapter:
        v = vendor or self.vendor
        a = build_adapter("image.bfl3", env=env or self.env, session=v.session())
        a.polling_domain = "localhost"
        a.polling_ports = (None, 443, v.port)
        a.result_hosts = ("localhost",)
        a.result_ports = (None, 443, v.port)
        return a

    def poll_url(self, name="abc"):
        return f"{self.vendor.base_url}/v1/get_result/{name}"

    def ready(self, name="o.png"):
        return {"id": "t1", "status": "Ready",
                "result": {"sample": f"{self.vendor.base_url}/{name}", "prompt": "expanded", "duration": 3.2}}


def t2i(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2I, prompt="a red apple on a white table", aspect_ratio="1:1",
                                       image_size="1K"), **kw})


# ── the registry: dark, gated, unpriced ────────────────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_the_two_models_are_registered_on_the_flux3_adapter_and_flux2_is_untouched(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual((e.adapter, e.provider, e.vendor_model, e.capabilities), ("image.bfl3", "bfl", mid, ("t2i",)), mid)
            self.assertTrue(e.is_async, mid)
        for mid in ("flux-2-pro", "flux-2-max", "flux-2-flex"):
            self.assertEqual((self.r[mid].adapter, self.r[mid].terms_gate), ("image.bfl", None), mid)

    def test_none_of_them_can_be_sold_until_a_person_has_decided_the_training_licence_question(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual(e.terms_gate, "terms_review_required", mid)
            self.assertEqual(e.api_exposure, "web_only", mid)
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("2026-08-04", notes, mid)                      # the Terms version that was read
            self.assertIn("End Users of a Developer Application", notes, mid)
            self.assertIn("hosted endpoint for third parties is barred", notes, mid)
            self.assertIn("to train and improve", notes, mid)            # 2(b): why the gate is not open
            self.assertIn("under 18", notes, mid)
            self.assertIn("NOT read", notes, mid)

    def test_the_terms_gate_reaches_the_database_row(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in IDS:
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "terms_review_required", mid)

    def test_no_migration_or_price_file_prices_them(self):
        units = []
        for mid in IDS:
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, e.raw["pricing"]["unit"], k) for k in e.raw["pricing"]["variants"]["prices"]]
        self.assertTrue(all(u.startswith("model_flux_3_image") for u in units), units)
        hits = []
        for folder in ("supabase/migrations", "docs", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".md", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row (or any other mention) would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_from_the_vendors_price_list(self):
        want = {F3: {"1K": 0.048, "2K": 0.10}, KLEIN: {"1K": 0.009, "2K": 0.014}}
        for mid in IDS:
            p = self.r[mid].raw["pricing"]
            self.assertFalse(p["confirmed"], mid)
            self.assertEqual(p["variants"], {"by": "image_size", "prices": want[mid]}, mid)
            self.assertEqual(p["provider_usd_per_unit"], want[mid]["1K"], mid)
            self.assertEqual(p["source_url"], "https://bfl.ai/pricing", mid)
            self.assertEqual(p["as_of"], "2026-10-25", mid)
            self.assertIn("ESTIMATE", p["note"], mid)
            self.assertIn("4k", p["note"], mid)                              # says what is NOT offered and why
            self.assertNotRegex(p["note"].lower(), r"(not billed|free of charge|no charge)", mid)

    def test_only_the_two_sizes_that_can_be_named_and_are_sane_are_offered(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual(e.image_sizes, ("1K", "2K"), mid)               # 768sq / 1.5k have no name; 4k is $0.607
            self.assertEqual(sorted(e.aspect_ratios), sorted(Flux3ImageAdapter.RATIOS), mid)
            self.assertEqual(e.image_refs_max, 0, mid)

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual(list(e.image_sizes), list(Flux3ImageAdapter.SPECS[e.vendor_model]["sizes"]), mid)

    def test_probes_are_servable_and_cheap(self):
        for mid in IDS:
            req = self.r[mid].probe_request()
            self.assertEqual((req.capability, req.image_size, req.aspect_ratio), (T2I, "1K", "1:1"), mid)
            self.assertEqual(Flux3ImageAdapter(env={}).problems(req, self.r[mid]), [], mid)

    def test_the_tiers_are_marked_as_judgement(self):
        self.assertEqual((self.r[F3].quality_tier, self.r[F3].speed_tier, self.r[F3].entitlement), (5, 3, "models_image:premium"))
        self.assertEqual((self.r[KLEIN].quality_tier, self.r[KLEIN].speed_tier, self.r[KLEIN].entitlement), (3, 5, "models_image:basic"))
        for mid in IDS:
            self.assertIn("judgement", self.r[mid].raw["api_documented"]["note"], mid)


# ── what is sent ───────────────────────────────────────────────────────────────

class SubmitTests(VendorCase):
    def setUp(self):
        super().setUp()
        for model in IDS:
            self.vendor.on("POST", f"/v1/{model}", Resp(200, {"id": "t1", "polling_url": self.poll_url(), "cost": 4.8,
                                                              "input_mp": 0, "output_mp": 1.05}))

    def sent(self, model=F3):
        (req,) = self.vendor.seen("POST", f"/v1/{model}")
        return req

    def test_flux_3_image_sends_the_priced_tier_the_ratio_and_switches_grounding_off(self):
        task = self.adapter().submit(t2i(aspect_ratio="16:9", image_size="2K", end_user="a" * 32), F3)
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("image.bfl3", F3, self.poll_url()))
        req = self.sent()
        self.assertEqual(req.path, "/v1/flux-3-image")
        self.assertEqual(req.headers["x-key"], KEY)
        self.assertNotIn("authorization", req.headers)
        self.assertEqual(req.json(), {"prompt": "a red apple on a white table", "resolution": "2k", "aspect_ratio": "16:9",
                                      "grounding": False, "user": "a" * 32})

    def test_klein_has_its_own_path_and_no_grounding_field_because_unknown_fields_are_a_422(self):
        self.adapter().submit(t2i(), KLEIN)
        req = self.sent(KLEIN)
        self.assertEqual(req.path, "/v1/flux-3-image-klein")
        self.assertEqual(req.json(), {"prompt": "a red apple on a white table", "resolution": "1k", "aspect_ratio": "1:1"})

    def test_no_flux2_field_is_ever_sent(self):
        for model in IDS:
            self.vendor.requests.clear()
            self.adapter().submit(t2i(), model)
            body = self.sent(model).json()
            self.assertFalse({"width", "height", "seed", "input_image", "images", "safety_tolerance", "output_format", "steps"} & set(body), body)

    def test_no_ratio_asks_for_the_vendors_auto_and_a_bad_end_user_id_is_not_sent(self):
        self.adapter().submit(t2i(aspect_ratio=None), F3)
        self.assertEqual(self.sent().json()["aspect_ratio"], "auto")
        for bad in ("x" * 65, "has space", "a@b.com", "../x", ""):
            self.vendor.requests.clear()
            self.adapter().submit(t2i(end_user=bad), F3)
            self.assertNotIn("user", self.sent().json(), repr(bad))

    def test_a_priced_setting_that_is_not_offered_is_refused_before_any_call_never_defaulted(self):
        cases = (
            (t2i(image_size=None), F3, "image size (none)"),                 # the vendor's own default is 1k
            (t2i(image_size="512"), F3, "image size 512"),
            (t2i(image_size="4K"), F3, "image size 4K"),                     # $0.607: not offered
            (t2i(image_size="1.5k"), F3, "image size 1.5k"),
            (t2i(image_size="1k"), F3, "image size 1k"),                     # the registry label is 1K
            (t2i(image_size="2K"), "flux-2-pro", "not a FLUX 3 image model"),
            (t2i(), "flux-3-image-max", "not a FLUX 3 image model"),
            (t2i(), "flux-3-video", "not a FLUX 3 image model"),
            (t2i(), "", "not a FLUX 3 image model"),
            (t2i(aspect_ratio="19.5:9"), F3, "aspect ratio"),
            (t2i(aspect_ratio="auto"), F3, "aspect ratio"),
            (t2i(prompt=""), F3, "prompt is empty"),
            (t2i(prompt="x" * 4001), KLEIN, "longer than 4000"),
            (CapabilityRequest("edit", "x", image_size="1K", input_images=("a.png",)), F3, "text-to-image only"),
            (t2i(input_images=("a.png",)), F3, "text-to-image only"),
        )
        for req, model, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.adapter().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message, (model, req))
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entry_refuses_what_the_adapter_would_refuse(self):
        entry = reg.get(F3)
        a = self.adapter()
        self.assertEqual(a.problems(entry.probe_request(), entry), [])
        self.assertTrue(a.problems(t2i(image_size=None), entry))
        self.assertTrue(a.problems(t2i(image_size="4K"), entry))
        self.assertTrue(a.problems(CapabilityRequest("edit", "x", image_size="1K", input_images=("a.png",)), entry))

    def test_editing_is_not_wired_even_without_a_picture(self):
        self.assertEqual(Flux3ImageAdapter.capabilities, (T2I,))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(CapabilityRequest("edit", "x", image_size="1K"), F3)
        self.assertTrue(cm.exception.not_accepted)
        self.assertIn("text-to-image only", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_no_key_is_a_refusal_before_any_call(self):
        a = build_adapter("image.bfl3", env={"BFL_BASE_URL": self.vendor.base_url + "/v1"}, session=self.vendor.session())
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2i(), F3)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_the_flux2_adapter_and_the_shared_key_are_untouched(self):
        self.assertEqual(ADAPTERS["image.bfl"].key_env, ADAPTERS["image.bfl3"].key_env)
        self.assertEqual(ADAPTERS["image.bfl3"].default_base_url, "https://api.bfl.ai/v1")
        self.assertEqual(ADAPTERS["image.bfl3"].polling_domain, "bfl.ai")
        self.assertEqual(ADAPTERS["image.bfl3"].result_hosts, ("bfl.ai",))
        self.assertEqual(ADAPTERS["image.bfl3"].result_ports, (None, 443))


class LostAnswerTests(VendorCase):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
        self.assertNotIn(KEY, cm.exception.message)

    def test_a_connection_dropped_after_the_request_arrived_may_have_billed(self):
        self.vendor.on("POST", "/v1/flux-3-image", Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), F3)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)
        self.assertEqual(len(self.vendor.seen("POST", "/v1/flux-3-image")), 1)

    def test_a_read_timeout_may_have_billed(self):
        self.vendor.on("POST", "/v1/flux-3-image", Resp(200, {"polling_url": self.poll_url()}, hang_s=1.5))
        a = self.adapter()
        a.timeout = 0.4
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2i(), F3)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_5xx_may_have_billed(self):
        self.vendor.on("POST", "/v1/flux-3-image", Resp(503, {"detail": "overloaded"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), F3)
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_polling_url_may_have_billed_and_the_key_never_follows_a_foreign_one(self):
        for body in ({}, {"id": "x"}, {"polling_url": ""}, {"polling_url": 7}, {"polling_url": "https://attacker.example/poll"},
                     {"polling_url": "http://localhost/poll"}, {"polling_url": "https://localhost.evil.io/poll"},
                     {"polling_url": "https://evil.io/localhost"}, [], None):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", "/v1/flux-3-image", Resp(200, body))
            a = self.adapter({"BFL_API_KEY": KEY, "BFL_BASE_URL": vendor.base_url + "/v1"}, vendor)
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                a.submit(t2i(), F3)
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.adapter({"BFL_API_KEY": KEY, "BFL_BASE_URL": closed_port_url() + "/v1"})
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2i(), F3)
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_outright_refusals_are_proof_and_name_the_right_remedy(self):
        cases = ((401, {"detail": "Not authenticated"}, E_AUTH), (402, {"detail": "Insufficient credits"}, E_QUOTA),
                 (429, {"detail": "Too many requests"}, E_RATE_LIMITED), (404, {"detail": "Not Found"}, E_NOT_FOUND))
        for status, body, want in cases:
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", "/v1/flux-3-image", Resp(status, body))
            a = self.adapter({"BFL_API_KEY": KEY, "BFL_BASE_URL": vendor.base_url + "/v1"}, vendor)
            with self.assertRaises(AdapterError, msg=status) as cm:
                a.submit(t2i(), F3)
            self.assertEqual(cm.exception.code, want, status)
            self.assertTrue(cm.exception.not_accepted, status)

    def test_the_vendors_422_about_the_request_is_a_bad_request_not_a_lost_answer(self):
        self.vendor.on("POST", "/v1/flux-3-image", Resp(422, {"detail": [{"loc": ["body", "width"], "msg": "Extra inputs are not permitted"}]}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), F3)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)


# ── polling and the result ────────────────────────────────────────────────────────

class PollTests(VendorCase):
    def status(self, body, *, code=200, url=None, raw=None):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", "/v1/get_result/abc", Resp(code, body, raw=raw) if raw is None else Resp(code, raw=raw))
        return self.adapter().poll(ProviderTask("image.bfl3", F3, url or self.poll_url()))

    def test_pending_reasoning_and_generating_are_pending_and_the_key_goes_only_to_the_polling_link(self):
        for st in ("Pending", "Reasoning", "Generating"):
            self.assertEqual(self.status({"status": st}).state, PENDING, st)
        (req,) = self.vendor.seen("GET", "/v1/get_result/")
        self.assertEqual(req.headers["x-key"], KEY)
        self.assertEqual(self.vendor.seen("POST", ""), [])                # polling never submits

    def test_ready_hands_back_a_picture_of_unnamed_type_for_the_bytes_to_decide(self):
        res = self.status(self.ready())
        self.assertEqual(res.state, SUCCEEDED)
        self.assertEqual((res.outputs[0].mime, res.outputs[0].url), (ANY_IMAGE, f"{self.vendor.base_url}/o.png"))

    def test_a_failed_task_that_comes_back_as_503_with_a_json_body_is_read_not_retried(self):
        res = self.status({"id": "t1", "status": "Error", "details": "boom"}, code=503)
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))
        self.assertIn("(Error)", res.error.message)
        self.assertTrue(res.error.message.endswith(BILLING_UNKNOWN))
        res = self.status({"id": "t1", "status": "Content Moderated"}, code=503)
        self.assertEqual((res.state, res.error.code), (FAILED, E_POLICY))

    def test_a_real_outage_is_unavailable_so_the_caller_polls_again(self):
        for code, kw in ((503, dict(raw=b"<html>Service Unavailable</html>")), (503, dict(body={"detail": "busy"})),
                         (503, dict(body={"status": "Reticulating"})), (502, dict(body={"status": "Error"})),
                         (503, dict(body={"status": "Ready", "result": {"sample": "https://localhost/o.png"}})),
                         (503, dict(body={"status": "Pending"})),
                         (500, dict(body={"detail": "x"}))):
            body = kw.get("body")
            with self.assertRaises(AdapterError, msg=(code, kw)) as cm:
                self.status(body, code=code, raw=kw.get("raw"))
            self.assertEqual(cm.exception.code, E_UNAVAILABLE, (code, kw))
            self.assertFalse(cm.exception.not_accepted)

    def test_moderation_is_policy_and_never_says_the_task_was_free(self):
        res = self.status({"status": "Request Moderated"})
        self.assertEqual((res.state, res.error.code), (FAILED, E_POLICY))
        self.assertIn("before generating", res.error.message)
        res2 = self.status({"status": "Content Moderated"})
        self.assertEqual((res2.state, res2.error.code), (FAILED, E_POLICY))
        self.assertIn("generated the image and then withheld", res2.error.message)
        for r in (res, res2, self.status({"status": "Task not found"}), self.status({"status": "Error"})):
            self.assertTrue(r.error.message.endswith(BILLING_UNKNOWN), r.error.message)
            self.assertNotRegex(r.error.message.lower(), r"is not billed|free of charge|no charge|was not charged")

    def test_task_not_found_is_not_found(self):
        res = self.status({"status": "Task not found"})
        self.assertEqual((res.state, res.error.code), (FAILED, E_NOT_FOUND))
        res = self.status({"status": "Task not found"}, code=404)           # BFL's errors page: 200 or 404
        self.assertEqual((res.state, res.error.code), (FAILED, E_NOT_FOUND))

    def test_task_not_found_is_a_verdict_only_with_http_200_or_404_never_with_a_503_or_anything_else(self):
        # A gateway can answer 503 with any body; "the task does not exist" must not end a task that is still running.
        with self.assertRaises(AdapterError) as cm:
            self.status({"status": "Task not found"}, code=503)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)                   # poll again
        for code in (202, 206):
            with self.assertRaises(AdapterError, msg=code) as cm:
                self.status({"status": "Task not found"}, code=code)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, code)
        with self.assertRaises(AdapterError) as cm:
            self.status({"status": "Task not found"}, code=500)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        # the other failure statuses keep their documented 503 mapping
        for st, want in (("Error", E_UNAVAILABLE), ("Request Moderated", E_POLICY), ("Content Moderated", E_POLICY)):
            res = self.status({"status": st}, code=503)
            self.assertEqual((res.state, res.error.code), (FAILED, want), st)

    def test_a_404_that_is_not_the_vendors_task_not_found_is_a_plain_not_found_error(self):
        for body, raw in ((None, b"404 page not found"), ({"detail": "Not Found"}, None), ({"status": "Ready"}, None),
                          ({"status": "Pending"}, None)):
            with self.assertRaises(AdapterError, msg=repr((body, raw))) as cm:
                self.status(body, code=404, raw=raw)
            self.assertEqual(cm.exception.code, E_NOT_FOUND)

    def test_a_status_we_do_not_know_or_a_body_that_is_not_a_task_is_an_error_not_an_endless_wait(self):
        for body in ({"status": "Reticulating"}, {"status": None}, {}, [], "x"):
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.status(body)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, repr(body))

    def test_ready_without_a_link_or_with_a_foreign_one_says_the_spend_may_have_happened(self):
        for result in (None, {}, {"sample": ""}, {"sample": 7}):
            with self.assertRaises(AdapterError, msg=repr(result)) as cm:
                self.status({"status": "Ready", "result": result})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)
        for url in ("https://attacker.example/o.png", "http://localhost/o.png", "https://localhost.evil.io/o.png",
                    "https://evillocalhost/o.png", "https://user:pw@localhost/o.png", "https://localhost:8443/o.png",
                    "https://localhost\\@evil.example/o.png"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status({"status": "Ready", "result": {"sample": url}})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)

    def test_the_real_allow_list_takes_the_regional_delivery_hosts_and_nothing_else(self):
        a = build_adapter("image.bfl3", env=self.env, session=self.vendor.session())
        for url in ("https://delivery-eu1.bfl.ai/results/x/sample.png", "https://delivery.us1.bfl.ai/r/x.jpeg?s=1"):
            res = a.checked_outputs(PollResult(SUCCEEDED, [Output(ANY_IMAGE, url=url)]))
            self.assertEqual(res.state, SUCCEEDED, url)
        for url in ("https://bfl.ai.evil.io/x.png", "https://evilbfl.ai/x.png", "https://delivery.bfl.ml/x.png",
                    "http://delivery.eu1.bfl.ai/x.png", "https://cdn.sanity.io/x.png"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                a.checked_outputs(PollResult(SUCCEEDED, [Output(ANY_IMAGE, url=url)]))
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)

    def test_a_task_id_that_is_not_a_polling_link_on_the_vendors_domain_never_gets_the_key(self):
        for tid in ("https://attacker.example/poll", "http://localhost/poll", "abc", "", "../../v1/x",
                    "https://localhost.evil.io/poll", "https://evil.io/localhost"):
            with self.assertRaises(AdapterError, msg=repr(tid)) as cm:
                self.adapter().poll(ProviderTask("image.bfl3", F3, tid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])
        real = build_adapter("image.bfl3", env=self.env, session=self.vendor.session())
        with self.assertRaises(AdapterError):
            real.poll(ProviderTask("image.bfl3", F3, self.poll_url()))     # localhost is not bfl.ai by default
        self.assertEqual(self.vendor.requests, [])

    def test_a_key_the_vendor_echoes_in_an_error_is_scrubbed(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"detail": f"bad key {KEY}"}, code=401)
        self.assertEqual(cm.exception.code, E_AUTH)
        self.assertNotIn(KEY, cm.exception.message)


class EndToEndTests(VendorCase):
    """submit -> poll (Pending, Generating, Ready) -> fetch through the probe runner."""

    def run_probe(self, polls, entry_id=KLEIN):
        from tools.probe_models import run_probe

        self.vendor.on("POST", f"/v1/{entry_id}", Resp(200, {"id": "t1", "polling_url": self.poll_url(), "cost": 0.9}))
        self.vendor.on("GET", "/v1/get_result/abc", polls)
        clock = {"t": 0.0}
        with mock.patch.object(Flux3ImageAdapter, "polling_domain", "localhost"), \
                mock.patch.object(Flux3ImageAdapter, "polling_ports", (None, 443, self.vendor.port)), \
                mock.patch.object(Flux3ImageAdapter, "result_hosts", ("localhost",)), \
                mock.patch.object(Flux3ImageAdapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(entry_id), env=self.env, voice_id=None, workdir=self.tmp, timeout_s=600,
                             poll_every_s=5, session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def test_the_probe_runs_the_whole_chain_and_stores_a_picture_under_the_type_it_is(self):
        self.vendor.on("GET", "/o.png", Resp(200, raw=picture("PNG")))
        res = self.run_probe([Resp(200, {"status": "Pending"}), Resp(200, {"status": "Generating"}), Resp(200, self.ready())])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(picture("PNG")))
        self.assertEqual(len(self.vendor.seen("POST", "/v1/flux-3-image-klein")), 1)    # polling never re-submitted
        self.assertEqual([p.suffix for p in self.tmp.glob("flux-3-image-klein_*")], [".png"])
        # the signed link is fetched without our key
        (dl,) = self.vendor.seen("GET", "/o.png")
        self.assertNotIn("x-key", dl.headers)
        self.assertNotIn("authorization", dl.headers)

    def test_a_jpeg_link_is_stored_as_jpg_and_a_webp_as_webp(self):
        for kind, name, suffix in (("JPEG", "j.jpg", ".jpg"), ("WEBP", "w.webp", ".webp")):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            tmp = Path(tempfile.mkdtemp(prefix="flux3_ext_"))
            self.addCleanup(lambda t=tmp: __import__("shutil").rmtree(t, ignore_errors=True))
            a = self.adapter({"BFL_API_KEY": KEY, "BFL_BASE_URL": vendor.base_url + "/v1"}, vendor)
            vendor.on("GET", "/" + name, Resp(200, raw=picture(kind)))
            res = PollResult(SUCCEEDED, [Output(ANY_IMAGE, url=f"{vendor.base_url}/{name}")])
            (path,) = a.fetch(res, tmp, stem="img")
            self.assertEqual((path.suffix, path.read_bytes()), (suffix, picture(kind)))

    def test_a_link_that_serves_something_else_leaves_nothing_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/o.png", Resp(200, raw=b"<html>not a picture</html>"))
        res = self.run_probe([Resp(200, self.ready())])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_BAD_RESPONSE)
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)
        self.assertEqual(list(self.tmp.glob("flux-3-image-klein*")), [])

    def test_an_expired_link_is_not_an_auth_error_and_a_redirect_is_never_followed(self):
        self.vendor.on("GET", "/o.png", Resp(403, {"error": "signature expired"}))
        res = self.run_probe([Resp(200, self.ready())])
        self.assertEqual(res.code, E_NOT_FOUND)
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)
        vendor2 = FakeVendor()
        self.addCleanup(vendor2.close)
        vendor2.on("GET", "/o.png", Resp(302, headers={"Location": "https://attacker.example/x.png"}))
        a = self.adapter({"BFL_API_KEY": KEY, "BFL_BASE_URL": vendor2.base_url + "/v1"}, vendor2)
        with self.assertRaises(AdapterError) as cm:
            a.fetch(PollResult(SUCCEEDED, [Output(ANY_IMAGE, url=f"{vendor2.base_url}/o.png")]), self.tmp, stem="r")
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertEqual(len(vendor2.requests), 1)

    def test_a_moderated_probe_is_a_failed_probe_with_a_policy_code(self):
        res = self.run_probe([Resp(200, {"status": "Request Moderated"})])
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_POLICY)


# ── the two small changes to shared code ───────────────────────────────────────────

class SharedChangesTests(VendorCase):
    def test_a_status_listed_as_ok_comes_back_to_the_caller_and_any_other_still_raises(self):
        self.vendor.on("GET", "/v1/a", Resp(503, {"status": "Error"}))
        a = self.adapter()
        with self.assertRaises(AdapterError) as cm:
            a.get(f"{self.vendor.base_url}/v1/a")                       # the default is unchanged: a 503 raises
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        resp = a.get(f"{self.vendor.base_url}/v1/a", raw=True, ok_statuses=(503,))
        self.assertEqual((resp.status_code, resp.json()), (503, {"status": "Error"}))
        self.vendor.on("GET", "/v1/b", Resp(500, {"status": "Error"}))
        with self.assertRaises(AdapterError):
            a.get(f"{self.vendor.base_url}/v1/b", raw=True, ok_statuses=(503,))      # only the listed status

    def test_any_image_accepts_exactly_the_three_picture_types(self):
        from modules.capabilities.safe_fetch import _looks_like

        for kind in ("PNG", "JPEG", "WEBP"):
            self.assertTrue(_looks_like(ANY_IMAGE, picture(kind)[:16]), kind)
        for head in (b"", b"<html>not a pic", b"GIF89a" + b"0" * 10, b"\x00\x00\x00\x18ftypmp42" + b"0" * 4, b"RIFF....WAVE" + b"0" * 4):
            self.assertFalse(_looks_like(ANY_IMAGE, head), head)
        self.assertFalse(_looks_like("image/png", picture("JPEG")[:16]))     # the specific types are as strict as before

    def test_an_inline_picture_of_unnamed_type_is_stored_under_its_real_extension(self):
        a = self.adapter()
        (path,) = a.fetch(PollResult(SUCCEEDED, [Output(ANY_IMAGE, data=picture("JPEG"))]), self.tmp, stem="inline")
        self.assertEqual((path.suffix, path.read_bytes()), (".jpg", picture("JPEG")))
        with self.assertRaises(AdapterError) as cm:
            a.fetch(PollResult(SUCCEEDED, [Output(ANY_IMAGE, data=b"<html>x</html>")]), self.tmp, stem="bad")
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))
        self.assertEqual(list(self.tmp.glob("bad*")), [])

    def test_settling_a_file_that_is_not_a_picture_removes_it(self):
        bogus = self.tmp / "x.bin"
        bogus.write_bytes(b"<html>nope</html>")
        with self.assertRaises(AdapterError):
            SafeResultMixin._settle_image(bogus)
        self.assertFalse(bogus.exists())

    def test_the_mixin_still_serves_every_other_adapter_unchanged(self):
        self.assertTrue(issubclass(Flux3ImageAdapter, SafeResultMixin))
        self.assertEqual(ADAPTERS["video.xai"].result_hosts, ("x.ai",))




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
        self.assertRegex(text, r"(?m)^BFL_API_KEY=$")                    # empty in the example, never a value
        self.assertIn("WORKERENV_BFL_API_KEY: ${{ secrets.BFL_API_KEY }}",
                      (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text())
        self.assertIn("BFL_API_KEY: ${{ secrets.BFL_API_KEY }}",
                      (ROOT / ".github" / "workflows" / "probe_models.yml").read_text())
        self.assertIn('"BFL_API_KEY"', (ROOT / "tools" / "doctor.py").read_text())


if __name__ == "__main__":
    unittest.main()
