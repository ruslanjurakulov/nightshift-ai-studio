"""Recraft V4.1 and V4.1 Flash (the maker's own API): the adapter, the registry
entries, and the rule that none of it is for sale.

The adapter talks to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py):
no network, no key, no spend.

What would break without these tests:

* a priced setting (the 2K "pro" variant, the vector variant) slipping in: the entry
  is priced for the raster 1K model only;
* a result LINK being fetched: the docs name no host for it, so nothing may be
  downloaded; the picture is requested inline and a link answer is "unusable, may be billed";
* a submit whose answer was lost being treated as "nothing was bought";
* a cached or shared output being served in place of a new call (Developer Terms 3.7);
* a plain-text error body ("request unauthorized") crashing the error path;
* a model whose terms nobody has decided becoming sellable.
"""

from __future__ import annotations

import base64
import io
import re
import tempfile
import unittest
from pathlib import Path

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
    SUCCEEDED,
    T2I,
    AdapterError,
    CapabilityRequest,
)
from modules.capabilities.recraft import RecraftImageAdapter
from modules.capabilities.safe_fetch import UNCONFIRMED
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url

ROOT = Path(__file__).resolve().parent.parent
KEY = "rc-test-NOT-A-REAL-TOKEN-0123456789abcdef"
V41, FLASH = "recraft-v4.1", "recraft-v4.1-flash"
IDS = (V41, FLASH)
GEN = "/v1/images/generations"


def tearDownModule():
    cleanup_certificate()


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def answer(data: bytes = None, credits: int = 35) -> dict:
    return {"created": 1759140000, "credits": credits,
            "data": [{"image_id": "0e6a1b8c-5b1f-4a8e-9f3a-2c7d4e8b9a10", "b64_json": b64(data if data is not None else png())}]}


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="recraft_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        # The base URL carries the API's /v1 prefix, as the real default does.
        self.env = {"RECRAFT_API_TOKEN": KEY, "RECRAFT_BASE_URL": self.vendor.base_url + "/v1"}

    def adapter(self, env=None, vendor=None) -> RecraftImageAdapter:
        v = vendor or self.vendor
        return build_adapter("image.recraft", env=env or self.env, session=v.session())


def t2i(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2I, prompt="a red apple on a white table", aspect_ratio="1:1",
                                       image_size="1K"), **kw})


# ── the registry: dark, gated, unpriced ────────────────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_the_two_models_are_registered_on_the_recraft_adapter(self):
        self.assertEqual({mid: (self.r[mid].adapter, self.r[mid].provider, self.r[mid].vendor_model) for mid in IDS},
                         {V41: ("image.recraft", "recraft", "recraftv4_1"),
                          FLASH: ("image.recraft", "recraft", "recraftv4_1_flash")})
        for mid in IDS:
            self.assertEqual(self.r[mid].capabilities, ("t2i",), mid)       # raster text-to-image only
            self.assertFalse(self.r[mid].is_async, mid)

    def test_none_of_them_can_be_sold_until_a_person_has_decided_the_terms_questions(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual(e.terms_gate, "terms_review_required", mid)
            self.assertEqual(e.api_exposure, "web_only", mid)
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("2026-10-20", notes, mid)                       # the Terms version that was read
            self.assertIn("3.7 No Substitution", notes, mid)
            self.assertIn("in place of a new API call", notes, mid)
            self.assertIn("fresh call", notes, mid)
            self.assertIn("3.2(x)", notes, mid)                           # why the gate is not open
            self.assertIn("may not be used to train", notes, mid)
            self.assertIn("NOT verified", notes, mid)

    def test_the_terms_gate_reaches_the_database_row(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in IDS:
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "terms_review_required", mid)

    def test_no_migration_or_price_file_prices_them(self):
        units = [self.r[mid].credit_unit for mid in IDS]
        self.assertEqual(units, ["model_recraft_v4_1_image", "model_recraft_v4_1_flash_image"])
        hits = []
        for folder in ("supabase/migrations", "docs", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".md", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row (or any other mention) would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_with_a_source(self):
        want = {V41: 0.035, FLASH: 0.007}
        for mid in IDS:
            p = self.r[mid].raw["pricing"]
            self.assertFalse(p["confirmed"], mid)
            self.assertEqual(p["provider_usd_per_unit"], want[mid], mid)
            self.assertEqual(p["source_url"], "https://www.recraft.ai/docs/api-reference/pricing", mid)
            self.assertEqual(p["as_of"], "2026-10-25", mid)
            self.assertIn("ESTIMATE", p["note"], mid)
            self.assertEqual(p["unit"], "image", mid)
            # the page does not say a failed request is free, so neither may the registry
            self.assertIn("not stated", p["note"], mid)
            self.assertNotRegex(p["note"].lower(), r"(not billed|free of charge|no charge)", mid)

    def test_only_the_raster_1k_model_is_offered_so_the_price_is_the_one_that_is_sent(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual(e.image_sizes, ("1K",), mid)                 # the Pro 2K variants are priced apart
            self.assertNotIn("vector", e.vendor_model, mid)
            self.assertNotIn("pro", e.vendor_model, mid)
            self.assertEqual(e.max_prompt_chars, 10000, mid)
            self.assertIsNone(e.default_resolution, mid)

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        for mid in IDS:
            e = self.r[mid]
            spec = RecraftImageAdapter.SPECS[e.vendor_model]
            self.assertEqual(list(e.image_sizes), list(spec["sizes"]), mid)
            self.assertEqual(sorted(e.aspect_ratios), sorted(RecraftImageAdapter.RATIOS), mid)

    def test_probes_are_servable_and_cheap(self):
        for mid in IDS:
            req = self.r[mid].probe_request()
            self.assertEqual((req.capability, req.image_size, req.aspect_ratio), (T2I, "1K", "1:1"), mid)
            self.assertEqual(RecraftImageAdapter(env={}).problems(req, self.r[mid]), [], mid)

    def test_the_tiers_follow_the_research_recommendation(self):
        self.assertEqual((self.r[V41].quality_tier, self.r[V41].speed_tier, self.r[V41].entitlement), (4, 4, "models_image:basic"))
        self.assertEqual((self.r[FLASH].quality_tier, self.r[FLASH].speed_tier, self.r[FLASH].entitlement), (3, 5, "models_image:basic"))


# ── what is sent ───────────────────────────────────────────────────────────────

class SubmitTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", GEN, Resp(200, answer()))

    def sent(self):
        (req,) = self.vendor.seen("POST", GEN)
        return req

    def test_the_picture_is_requested_inline_as_png_one_at_a_time_and_comes_back_stored(self):
        a = self.adapter()
        task = a.submit(t2i(aspect_ratio="16:9"), "recraftv4_1")
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("image.recraft", "recraftv4_1", None))
        req = self.sent()
        self.assertEqual(req.path, GEN)
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.json(), {"model": "recraftv4_1", "prompt": "a red apple on a white table", "n": 1,
                                      "response_format": "b64_json", "image_format": "png", "size": "16:9"})
        (path,) = a.fetch(a.poll(task), self.tmp, stem="img")
        self.assertEqual((path.suffix, path.read_bytes()), (".png", png()))
        self.assertEqual(list(self.tmp.glob("*.part")), [])
        # only the generation endpoint was ever called: no link was fetched
        self.assertEqual([r.path for r in self.vendor.requests], [GEN])

    def test_no_aspect_ratio_leaves_the_vendors_own_choice_and_the_flash_model_is_sent_by_name(self):
        self.adapter().submit(t2i(aspect_ratio=None, image_size=None), "recraftv4_1_flash")
        body = self.sent().json()
        self.assertNotIn("size", body)
        self.assertEqual(body["model"], "recraftv4_1_flash")

    def test_every_call_is_a_fresh_generation_never_a_replay_of_an_earlier_output(self):
        # Developer Terms 3.7: no service that hands out earlier outputs in place of a new API call.
        a = self.adapter()
        for _ in range(3):
            a.submit(t2i(), "recraftv4_1")
        self.assertEqual(len(self.vendor.seen("POST", GEN)), 3)

    def test_what_is_not_priced_here_is_refused_before_any_call_never_defaulted(self):
        cases = (
            (t2i(), "recraftv4_1_vector", "not a Recraft model"),             # SVG: $0.08, not offered
            (t2i(), "recraftv4_1_pro", "not a Recraft model"),                # 2K: $0.21, not offered
            (t2i(), "recraftv4_1_utility", "not a Recraft model"),
            (t2i(), "recraftv4_styles", "not a Recraft model"),
            (t2i(), "recraftv4", "not a Recraft model"),
            (t2i(), "recraftv3", "not a Recraft model"),
            (t2i(), "", "not a Recraft model"),
            (t2i(image_size="2K"), "recraftv4_1", "image size 2K"),
            (t2i(image_size="4K"), "recraftv4_1_flash", "image size 4K"),
            (t2i(aspect_ratio="14:10"), "recraftv4_1", "aspect ratio"),       # a row of the size table left out on purpose
            (t2i(aspect_ratio="1024x1024"), "recraftv4_1", "aspect ratio"),
            (t2i(aspect_ratio="19.5:9"), "recraftv4_1", "aspect ratio"),
            (t2i(prompt="   "), "recraftv4_1", "prompt is empty"),
            (t2i(prompt="x" * 10001), "recraftv4_1", "longer than 10000"),
            (CapabilityRequest("edit", "x", input_images=("a.png",)), "recraftv4_1", "text-to-image only"),
            (CapabilityRequest("edit", "x"), "recraftv4_1", "text-to-image only"),
            (t2i(input_images=("a.png",)), "recraftv4_1", "text-to-image only"),
        )
        for req, model, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, req)) as cm:
                self.adapter().submit(req, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, req))
            self.assertTrue(cm.exception.not_accepted, (model, req))
            self.assertIn(fragment, cm.exception.message, (model, req))
        self.assertEqual(self.vendor.requests, [])

    def test_a_prompt_at_exactly_the_limit_is_sent_and_every_listed_ratio_is(self):
        self.adapter().submit(t2i(prompt="x" * 10000), "recraftv4_1")
        self.assertEqual(len(self.sent().json()["prompt"]), 10000)
        for ratio in RecraftImageAdapter.RATIOS:
            self.vendor.requests.clear()
            self.adapter().submit(t2i(aspect_ratio=ratio), "recraftv4_1")
            self.assertEqual(self.sent().json()["size"], ratio)

    def test_the_registry_entry_refuses_what_the_adapter_would_refuse(self):
        entry = reg.get(V41)
        a = self.adapter()
        self.assertEqual(a.problems(entry.probe_request(), entry), [])
        self.assertTrue(a.problems(t2i(image_size="2K"), entry))
        self.assertTrue(a.problems(t2i(prompt=""), entry))
        self.assertTrue(a.problems(CapabilityRequest("edit", "x", input_images=("a.png",)), entry))

    def test_no_token_is_a_refusal_before_any_call(self):
        a = build_adapter("image.recraft", env={"RECRAFT_BASE_URL": self.vendor.base_url + "/v1"}, session=self.vendor.session())
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2i(), "recraftv4_1")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertIn("RECRAFT_API_TOKEN", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_a_base_url_override_that_is_not_https_is_ignored(self):
        a = build_adapter("image.recraft", env={"RECRAFT_API_TOKEN": KEY, "RECRAFT_BASE_URL": "http://evil.example/v1"})
        self.assertEqual(a.base_url, "https://external.api.recraft.ai/v1")


class ResultTests(VendorCase):
    def test_an_answer_that_is_not_an_inline_picture_may_have_billed_and_is_never_fetched(self):
        link = {"created": 1, "credits": 35, "data": [{"image_id": "x", "url": f"{self.vendor.base_url}/img.png"}]}
        self.vendor.on("GET", "/img.png", Resp(200, raw=png()))
        for body in ({"data": []}, {"data": [{}]}, {"data": [{"b64_json": ""}]}, {"data": [{"b64_json": 5}]},
                     {"data": [{"b64_json": b64(b"<html>no</html>")}]}, {"data": [{"b64_json": "!!not base64!!"}]},
                     link, [], {}, "text"):
            self.vendor._routes = [r for r in self.vendor._routes if r[0] != "POST"]
            self.vendor.on("POST", GEN, Resp(200, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.adapter().submit(t2i(), "recraftv4_1")
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, repr(body))
            self.assertFalse(cm.exception.not_accepted)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), repr(body))
        self.assertEqual(self.vendor.seen("GET", ""), [])            # the link was never requested

    def test_a_2xx_that_is_not_json_may_have_billed(self):
        self.vendor.on("POST", GEN, Resp(200, raw=b"<html>gateway</html>"))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), "recraftv4_1")
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))

    def test_the_stored_file_takes_the_type_its_bytes_are_not_the_one_the_json_claims(self):
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (8, 8)).save(buf, "WEBP")
        self.vendor.on("POST", GEN, Resp(200, answer(buf.getvalue())))
        a = self.adapter()
        (path,) = a.fetch(a.poll(a.submit(t2i(), "recraftv4_1")), self.tmp, stem="img")
        self.assertEqual(path.suffix, ".webp")

    def test_a_result_host_list_is_empty_because_nothing_is_ever_downloaded(self):
        self.assertEqual(RecraftImageAdapter.result_hosts, ())


class LostAnswerTests(VendorCase):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
        self.assertNotIn(KEY, cm.exception.message)

    def test_a_connection_dropped_after_the_request_arrived_may_have_billed(self):
        self.vendor.on("POST", GEN, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), "recraftv4_1")
        self.assertUnconfirmed(cm, E_UNAVAILABLE)
        self.assertEqual(len(self.vendor.seen("POST", GEN)), 1)

    def test_a_read_timeout_may_have_billed(self):
        self.vendor.on("POST", GEN, Resp(200, answer(), hang_s=1.5))
        a = self.adapter()
        a.timeout = 0.4
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2i(), "recraftv4_1")
        self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_5xx_may_have_billed_whatever_its_body_looks_like(self):
        for status, raw in ((500, b"internal error"), (502, b"<html>bad gateway</html>"), (503, b'{"error":"busy"}')):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", GEN, Resp(status, raw=raw))
            a = self.adapter({"RECRAFT_API_TOKEN": KEY, "RECRAFT_BASE_URL": vendor.base_url + "/v1"}, vendor)
            with self.assertRaises(AdapterError, msg=status) as cm:
                a.submit(t2i(), "recraftv4_1")
            self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.adapter({"RECRAFT_API_TOKEN": KEY, "RECRAFT_BASE_URL": closed_port_url() + "/v1"})
        with self.assertRaises(AdapterError) as cm:
            a.submit(t2i(), "recraftv4_1")
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_outright_refusals_are_proof_whether_the_body_is_plain_text_or_json(self):
        cases = ((401, b"request unauthorized", E_AUTH),                       # documented: text/plain
                 (404, b"404 page not found", E_NOT_FOUND),                     # documented: text/plain
                 (402, b'{"error": "insufficient API units balance"}', E_QUOTA),
                 (429, b"Too many requests, slow down", E_RATE_LIMITED))
        for status, raw, want in cases:
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", GEN, Resp(status, raw=raw))
            a = self.adapter({"RECRAFT_API_TOKEN": KEY, "RECRAFT_BASE_URL": vendor.base_url + "/v1"}, vendor)
            with self.assertRaises(AdapterError, msg=status) as cm:
                a.submit(t2i(), "recraftv4_1")
            self.assertEqual(cm.exception.code, want, status)
            self.assertTrue(cm.exception.not_accepted, status)
            self.assertNotIn(UNCONFIRMED, cm.exception.message, status)

    def test_the_vendors_own_4xx_about_the_request_is_typed_and_not_a_lost_answer(self):
        for status, raw, want in ((400, b"size must be one of the supported sizes", E_BAD_REQUEST),
                                  (400, b'{"message": "prompt blocked by the content safety policy"}', E_POLICY)):
            vendor = FakeVendor()
            self.addCleanup(vendor.close)
            vendor.on("POST", GEN, Resp(status, raw=raw))
            a = self.adapter({"RECRAFT_API_TOKEN": KEY, "RECRAFT_BASE_URL": vendor.base_url + "/v1"}, vendor)
            with self.assertRaises(AdapterError) as cm:
                a.submit(t2i(), "recraftv4_1")
            self.assertEqual(cm.exception.code, want)
            self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_a_token_the_vendor_echoes_in_an_error_is_scrubbed(self):
        self.vendor.on("POST", GEN, Resp(401, raw=f"unauthorized: {KEY}".encode()))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), "recraftv4_1")
        self.assertNotIn(KEY, cm.exception.message)


class EndToEndTests(VendorCase):
    def test_the_probe_stores_a_real_image_for_both_models(self):
        from tools.probe_models import run_probe

        self.vendor.on("POST", GEN, Resp(200, answer()))
        for mid in IDS:
            self.vendor.requests.clear()
            res = run_probe(reg.get(mid), env=self.env, voice_id=None, workdir=self.tmp, session=self.vendor.session(),
                            sleep=lambda s: None)
            self.assertTrue(res.ok, res.message)
            body = self.vendor.seen("POST", GEN)[0].json()
            self.assertEqual((body["model"], body["size"], body["response_format"]), (reg.get(mid).vendor_model, "1:1", "b64_json"))
            self.assertEqual(len(self.vendor.requests), 1)             # one call, no download

    def test_a_poll_after_a_synchronous_submit_hands_back_the_stored_bytes_and_a_second_poll_does_too(self):
        self.vendor.on("POST", GEN, Resp(200, answer()))
        a = self.adapter()
        task = a.submit(t2i(), "recraftv4_1")
        self.assertEqual(a.poll(task).state, SUCCEEDED)
        self.assertEqual(a.poll(task).state, SUCCEEDED)
        self.assertEqual(len(self.vendor.seen("POST", GEN)), 1)        # polling never submits again


class WiringTests(unittest.TestCase):
    def test_the_token_is_one_the_worker_can_be_given(self):
        text = (ROOT / "deploy" / ".env.worker.example").read_text()
        self.assertRegex(text, r"(?m)^RECRAFT_API_TOKEN=$")             # empty in the example, never a value
        self.assertIn("WORKERENV_RECRAFT_API_TOKEN: ${{ secrets.RECRAFT_API_TOKEN }}",
                      (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text())
        self.assertIn("RECRAFT_API_TOKEN: ${{ secrets.RECRAFT_API_TOKEN }}",
                      (ROOT / ".github" / "workflows" / "probe_models.yml").read_text())
        doctor = (ROOT / "tools" / "doctor.py").read_text()
        self.assertEqual(doctor.count('"RECRAFT_API_TOKEN"'), 2)        # the shape check and the unverified-providers list

    def test_the_adapter_reads_the_token_from_the_documented_name(self):
        self.assertEqual(ADAPTERS["image.recraft"].key_env, ("RECRAFT_API_TOKEN",))


if __name__ == "__main__":
    unittest.main()
