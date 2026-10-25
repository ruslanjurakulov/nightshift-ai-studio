"""Gemini Omni Flash 1.1 and Nano Banana 2.1 (Google, Interactions API): the adapters, the registry
entries, and the rule that none of it is for sale.

The adapters talk to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py): no network, no key,
no spend, no call to Google. The download rules themselves are pinned in tests/test_safe_fetch.py; here
the point is that these adapters USE them, and that the one thing they add (the key in a header, to the
API's own host only) is exactly that narrow.

What would break without these tests:

* a setting the price depends on (Omni's resolution, Nano Banana's size and thinking level) defaulted
  instead of refused or pinned: Google bills what it picks;
* a duration "accepted" for a model that has no duration setting, and so billed for a length nobody asked for;
* a refusal or a failure reported as "nothing was bought" when no Google page says so;
* a submit whose answer was lost being treated as "nothing was bought";
* a clip fetched from a host nobody vetted, or the key sent to one;
* a model whose terms nobody has read (18+, consumer use, sublicensing) becoming sellable or reaching the API.
"""

from __future__ import annotations

import base64
import io
import re
import shutil
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
    EDIT,
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
from modules.capabilities.google_interactions import (
    BILLING_UNKNOWN,
    RESULT_HOSTS,
    GeminiNanoBananaAdapter,
    GeminiOmniAdapter,
)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from modules.capabilities.xai import GrokVideoAdapter
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url

ROOT = Path(__file__).resolve().parent.parent
KEY = "AIzaSy-test-NOT-A-REAL-KEY-0123456789abcdef"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
OMNI, NB = "gemini-omni-1.1-flash", "gemini-nano-banana-2.1"
POST = "/v1beta/interactions"
GET = "/v1beta/interactions/"
TID = "v1_abc123DEF-456"


def tearDownModule():
    cleanup_certificate()


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def interaction(status="completed", *, content=None, **extra) -> dict:
    steps = [{"type": "user_input", "content": [{"type": "text", "text": "..."}]},
             {"type": "thought", "content": [{"text": "...", "type": "thought"}]}]
    if content is not None:
        steps.append({"type": "model_output", "content": content})
    return {"steps": steps, "id": TID, "status": status, "model": OMNI, "object": "interaction", **extra}


def video_done(**kw) -> dict:
    return interaction(content=[{"type": "video", "mime_type": "video/mp4", "data": b64(MP4)}], **kw)


def image_done(data=None, text=None) -> dict:
    content = [{"type": "image", "mime_type": "image/png", "data": b64(data if data is not None else png())}]
    if text:
        content.append({"type": "text", "text": text})
    return interaction(content=content)


def google_error(status: int, name: str, message: str) -> Resp:
    return Resp(status, {"error": {"code": status, "message": message, "status": name}})


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="gint_test_"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        # The base URL carries the API's /v1beta prefix, as the real default does.
        self.env = {"GEMINI_API_KEY": KEY, "GEMINI_BASE_URL": self.vendor.base_url + "/v1beta"}

    def _adapter(self, key, env=None):
        a = build_adapter(key, env=env or self.env, session=self.vendor.session())
        a.result_hosts = ("localhost", "127.0.0.1")
        a.result_ports = (None, 443, self.vendor.port)
        return a

    def omni(self, env=None) -> GeminiOmniAdapter:
        return self._adapter("video.gemini_omni", env)

    def banana(self, env=None) -> GeminiNanoBananaAdapter:
        return self._adapter("image.gemini_interactions", env)

    def frame(self, name="first.png", data=None) -> str:
        p = self.tmp / name
        p.write_bytes(data if data is not None else png())
        return str(p)

    def sent(self, method="POST", prefix=POST):
        (req,) = self.vendor.seen(method, prefix)
        return req


def t2v(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2V, prompt="a boat at dawn", resolution="720p"), **kw})


def t2i(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2I, prompt="a red apple on a white table", image_size="1K"), **kw})


# ── the registry: dark, gated, unpriced, web only ──────────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_both_models_are_registered_on_their_own_adapters(self):
        self.assertEqual((self.r[OMNI].adapter, self.r[OMNI].provider, self.r[OMNI].vendor_model),
                         ("video.gemini_omni", "google", OMNI))
        self.assertEqual((self.r[NB].adapter, self.r[NB].provider, self.r[NB].vendor_model),
                         ("image.gemini_interactions", "google", NB))
        self.assertIn("video.gemini_omni", ADAPTERS)
        self.assertIn("image.gemini_interactions", ADAPTERS)

    def test_neither_can_be_sold_or_reach_the_api_until_the_owners_lawyer_has_read_googles_terms(self):
        for mid in (OMNI, NB):
            e = self.r[mid]
            self.assertEqual(e.terms_gate, "terms_review_required", mid)
            self.assertEqual(e.api_exposure, "web_only", mid)
            notes = " ".join(e.raw["terms_notes"])
            for needle in ("18+", "likely to be accessed by people under 18", "not for consumer use", "§4(a)",
                           "sublicensing an API", "lawyer", "Gate stays open"):
                self.assertIn(needle, notes, f"{mid}: {needle}")

    def test_the_gate_and_the_web_only_flag_reach_the_database_row(self):
        # sellable_models() (migration 0035) refuses any row whose spec.terms_gate is non-empty, and hides
        # api_exposure web_only models from the API and MCP surfaces.
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in (OMNI, NB):
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "terms_review_required", mid)
            self.assertEqual(rows[mid]["spec"]["api_exposure"], "web_only", mid)

    def test_no_migration_or_price_file_prices_them(self):
        units = []
        for mid in (OMNI, NB):
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, e.raw["pricing"]["unit"], k)
                      for k in (e.raw["pricing"].get("variants") or {}).get("prices", {})]
        self.assertTrue(all(re.match(r"model_gemini_(omni_1_1_flash|nano_banana_2_1)_", u) for u in units), units)
        hits = []
        for folder in ("supabase/migrations", "docs", "deploy", "command-center/lib"):
            base = ROOT / folder
            if not base.exists():
                continue
            for path in base.rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".md", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row (or any other mention) would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_with_a_source(self):
        for mid in (OMNI, NB):
            p = self.r[mid].raw["pricing"]
            self.assertFalse(p["confirmed"], mid)
            self.assertEqual(p["source_url"], "https://ai.google.dev/gemini-api/docs/pricing", mid)
            self.assertEqual(p["as_of"], "2026-10-25", mid)
            self.assertIn("ESTIMATE", p["note"], mid)

    def test_only_the_prices_google_states_are_filled_in(self):
        v = self.r[OMNI].raw["pricing"]["variants"]["prices"]
        self.assertEqual(v, {"360p": None, "720p": 0.1014, "1080p": None, "4k": None})   # null = no price read
        self.assertEqual(self.r[NB].raw["pricing"]["variants"]["prices"], {"1K": 0.0336, "2K": 0.0504, "4K": 0.113})
        self.assertIn("thinking", self.r[NB].raw["pricing"]["note"])                    # what the figure leaves out
        self.assertIn("Excludes input tokens", self.r[OMNI].raw["pricing"]["note"])

    def test_omni_has_no_duration_setting_so_the_registry_offers_none(self):
        # An empty list means "the model takes no such setting": a job that names one is refused (entry.problems).
        self.assertEqual(self.r[OMNI].durations_s, ())
        self.assertTrue(self.r[OMNI].problems(t2v(duration_s=5)))
        self.assertEqual(self.r[OMNI].problems(t2v()), [])
        self.assertIn("steered in the prompt", self.r[OMNI].raw["api_documented"]["note"])

    def test_what_the_registry_offers_is_what_the_adapters_will_send(self):
        e = self.r[OMNI]
        spec = GeminiOmniAdapter.SPECS[e.vendor_model]
        self.assertEqual(sorted(e.resolutions), sorted(spec["resolutions"]))
        self.assertEqual(sorted(e.aspect_ratios), sorted(spec["ratios"]))
        e = self.r[NB]
        spec = GeminiNanoBananaAdapter.SPECS[e.vendor_model]
        self.assertEqual(sorted(e.image_sizes), sorted(spec["sizes"]))
        self.assertEqual(sorted(e.aspect_ratios), sorted(spec["ratios"]))
        self.assertEqual(e.image_refs_max, spec["refs"])
        self.assertEqual(e.image_refs_max, 14)

    def test_omni_pins_googles_default_resolution_so_the_database_prices_by_it(self):
        self.assertEqual(self.r[OMNI].default_resolution, "720p")
        self.assertEqual(self.r[OMNI].variants_by, "resolution")

    def test_probes_are_servable_and_the_cheapest_there_is(self):
        req = self.r[OMNI].probe_request()
        self.assertEqual((req.capability, req.resolution, req.duration_s), (T2V, "360p", None))
        req = self.r[NB].probe_request()
        self.assertEqual((req.capability, req.image_size, req.aspect_ratio), (T2I, "1K", "1:1"))

    def test_both_read_the_one_google_key_and_host_the_other_google_adapters_already_use(self):
        for cls in (GeminiOmniAdapter, GeminiNanoBananaAdapter):
            self.assertEqual(tuple(cls.key_env), ("GEMINI_API_KEY",), cls.key)
            self.assertEqual(cls.base_url_env, "GEMINI_BASE_URL", cls.key)
        self.assertEqual(ADAPTERS["image.gemini"].base_url_env, "GEMINI_BASE_URL")
        self.assertEqual(ADAPTERS["image.gemini"].default_base_url, GeminiNanoBananaAdapter.default_base_url)
        # ...and that key is already mapped everywhere a worker or the probe gets its secrets.
        for rel in (".github/workflows/probe_models.yml", ".github/workflows/deploy_web.yml", "deploy/.env.worker.example"):
            self.assertIn("GEMINI_API_KEY", (ROOT / rel).read_text(), rel)

    def test_the_result_host_is_googles_own_file_host_and_nothing_wider(self):
        self.assertEqual(RESULT_HOSTS, ("generativelanguage.googleapis.com",))
        self.assertEqual(GeminiOmniAdapter.result_hosts, RESULT_HOSTS)
        self.assertEqual(GeminiNanoBananaAdapter.result_hosts, RESULT_HOSTS)


# ── Omni: what is sent ────────────────────────────────────────────────────────────────

class OmniSubmitTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", POST, Resp(200, interaction("in_progress")))

    def test_text_to_video_is_asynchronous_with_the_key_in_google_header_and_every_priced_setting_explicit(self):
        task = self.omni().submit(t2v(aspect_ratio="9:16", end_user="a" * 32), OMNI)
        self.assertEqual((task.adapter, task.vendor_model, task.task_id, task.outputs), ("video.gemini_omni", OMNI, TID, []))
        req = self.sent()
        self.assertEqual(req.headers["x-goog-api-key"], KEY)
        self.assertNotIn("authorization", req.headers)
        self.assertNotIn(KEY, req.path)                                  # never in the query string
        self.assertEqual(req.json(), {"model": OMNI, "input": "a boat at dawn",
                                      "response_format": {"type": "video", "resolution": "720p", "aspect_ratio": "9:16"},
                                      "background": True, "store": True})
        self.assertNotIn("user", req.json())                              # Google documents no end-user field here

    def test_the_ratio_is_left_out_when_the_job_names_none_never_made_up(self):
        self.omni().submit(t2v(), OMNI)
        self.assertNotIn("aspect_ratio", self.sent().json()["response_format"])

    def test_picture_to_video_sends_the_picture_then_the_words(self):
        self.omni().submit(CapabilityRequest(I2V, "slow push in", resolution="1080p", input_images=(self.frame(),)), OMNI)
        body = self.sent().json()
        self.assertEqual(body["input"][0]["type"], "image")
        self.assertEqual(body["input"][0]["mime_type"], "image/png")
        self.assertEqual(base64.b64decode(body["input"][0]["data"]), png())
        self.assertEqual(body["input"][1], {"type": "text", "text": "slow push in"})
        self.assertEqual(body["response_format"], {"type": "video", "resolution": "1080p"})
        self.vendor.requests.clear()
        self.omni().submit(CapabilityRequest(I2V, "", resolution="720p", input_images=(self.frame(),)), OMNI)
        self.assertEqual([p["type"] for p in self.sent().json()["input"]], ["image"])        # words are optional

    def test_a_setting_nobody_can_honour_or_price_is_refused_before_any_call_never_defaulted_or_ignored(self):
        cases = (
            (t2v(resolution=None), "resolution"),                      # Google's default is 720p: never left to it
            (t2v(resolution="2160p"), "resolution"),
            (t2v(duration_s=5), "no duration setting"),                # Omni has none: refused, not ignored
            (t2v(audio=False), "always on"),                           # there is no flag to send
            (t2v(audio=True), "always on"),
            (t2v(negative_prompt="no cars"), "negative"),
            (t2v(aspect_ratio="1:1"), "aspect ratio"),
            (t2v(prompt=" "), "prompt is empty"),
            (t2v(input_images=("x.png",)), "does not apply to text-to-video"),
            (CapabilityRequest(I2V, "x", resolution="720p"), "exactly one"),
            (CapabilityRequest(I2V, "x", resolution="720p", input_images=("https://example.invalid/a.png",)), "not an https URL"),
            (CapabilityRequest(I2V, "x", resolution="720p", input_images=("a.gif",)), "PNG, JPEG or WebP"),
        )
        for req, needle in cases:
            with self.subTest(needle=needle, req=req):
                with self.assertRaises(AdapterError) as cm:
                    self.omni().submit(req, OMNI)
                self.assertEqual(cm.exception.code, E_BAD_REQUEST)
                self.assertTrue(cm.exception.not_accepted)
                self.assertIn(needle, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_a_model_the_adapter_does_not_know_is_refused_for_example_the_shut_down_preview(self):
        with self.assertRaises(AdapterError) as cm:
            self.omni().submit(t2v(), "gemini-omni-flash-preview")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entry_and_the_adapter_agree_on_what_a_request_may_be(self):
        a = self.omni()
        entry = reg.get(OMNI)
        self.assertEqual(a.problems(t2v(), entry), [])
        self.assertTrue(a.problems(t2v(duration_s=4), entry))
        self.assertTrue(a.problems(t2v(resolution=None), entry))
        self.assertTrue(a.problems(CapabilityRequest(T2I, "x"), entry))

    def test_no_key_means_no_call(self):
        with self.assertRaises(AdapterError) as cm:
            self.omni({**self.env, "GEMINI_API_KEY": ""}).submit(t2v(), OMNI)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_an_answer_that_is_already_completed_still_yields_the_id_and_the_first_poll_reads_the_clip(self):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("POST", POST, Resp(200, video_done()))
        self.vendor.on("GET", GET, Resp(200, video_done()))
        a = self.omni()
        task = a.submit(t2v(), OMNI)
        self.assertEqual((task.task_id, task.outputs), (TID, []))        # nothing held in memory by the task
        res = a.poll(task)
        self.assertEqual([(o.mime, o.data) for o in res.outputs], [("video/mp4", MP4)])


class OmniLostAnswerTests(VendorCase):
    """A submit whose answer never came may still have started a billable clip."""

    def assertUnconfirmed(self, ctx):
        e = ctx.exception
        self.assertTrue(e.message.startswith(UNCONFIRMED), e.message)
        self.assertFalse(e.not_accepted)

    def test_a_dropped_connection_is_unconfirmed_spend_not_a_refusal(self):
        self.vendor.on("POST", POST, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.omni().submit(t2v(), OMNI)
        self.assertUnconfirmed(cm)

    def test_a_5xx_is_unconfirmed_spend_a_gateway_may_front_an_accepted_job(self):
        self.vendor.on("POST", POST, google_error(503, "UNAVAILABLE", "The model is overloaded."))
        with self.assertRaises(AdapterError) as cm:
            self.omni().submit(t2v(), OMNI)
        self.assertUnconfirmed(cm)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_id_is_unconfirmed_spend(self):
        for body in ({"status": "in_progress"}, {"id": "bad id/../x", "status": "in_progress"}, {"id": 7}, ["x"]):
            with self.subTest(body=body):
                self.vendor._routes.clear()
                self.vendor.on("POST", POST, Resp(200, body))
                with self.assertRaises(AdapterError) as cm:
                    self.omni().submit(t2v(), OMNI)
                self.assertUnconfirmed(cm)
                self.assertEqual(cm.exception.code, E_BAD_RESPONSE)

    def test_a_2xx_that_is_not_json_is_unconfirmed_spend(self):
        self.vendor.on("POST", POST, Resp(200, raw=b"<html>gateway</html>"))
        with self.assertRaises(AdapterError) as cm:
            self.omni().submit(t2v(), OMNI)
        self.assertUnconfirmed(cm)

    def test_a_connection_that_never_opened_is_a_proven_refusal(self):
        env = {**self.env, "GEMINI_BASE_URL": closed_port_url() + "/v1beta"}
        with self.assertRaises(AdapterError) as cm:
            self.omni(env).submit(t2v(), OMNI)
        self.assertTrue(cm.exception.not_accepted)
        self.assertFalse(cm.exception.message.startswith(UNCONFIRMED))


class GoogleErrorVocabularyTests(VendorCase):
    """Google's own ``error.status`` picks the remedy where the HTTP status is ambiguous (CLAUDE.md #6)."""

    def code_for(self, resp: Resp, adapter="omni") -> AdapterError:
        self.vendor._routes.clear()
        self.vendor.on("POST", POST, resp)
        with self.assertRaises(AdapterError) as cm:
            if adapter == "omni":
                self.omni().submit(t2v(), OMNI)
            else:
                self.banana().submit(t2i(), NB)
        return cm.exception

    def test_each_status_maps_to_the_remedy_an_operator_needs(self):
        cases = (
            (google_error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key."), E_AUTH),
            (google_error(400, "INVALID_ARGUMENT", "Request contains an invalid argument."), E_BAD_REQUEST),
            (google_error(401, "UNAUTHENTICATED", "Request had invalid authentication credentials."), E_AUTH),
            (google_error(403, "PERMISSION_DENIED", "The caller does not have permission"), E_AUTH),
            (google_error(403, "PERMISSION_DENIED", "Billing is not enabled for this project"), E_QUOTA),
            (google_error(400, "FAILED_PRECONDITION", "This model is only available on the paid tier; enable billing"), E_QUOTA),
            (google_error(400, "FAILED_PRECONDITION", "User location is not supported for the API use."), E_AUTH),
            (google_error(429, "RESOURCE_EXHAUSTED", "Too many requests, slow down."), E_RATE_LIMITED),
            (google_error(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, check your plan and billing"), E_QUOTA),
            (google_error(404, "NOT_FOUND", "models/gemini-omni-1.1-flash is not found"), E_NOT_FOUND),
        )
        for resp, want in cases:
            with self.subTest(status=resp.status, want=want):
                e = self.code_for(resp)
                self.assertEqual(e.code, want, e.message)
                # 401/402/403/404/429 PROVE the call was refused; a 400 is Google's own answer about the request,
                # passed through (never rewritten into "unconfirmed", never claimed to be "not billed").
                self.assertEqual(e.not_accepted, resp.status in (401, 402, 403, 404, 429), (resp.status, e.message))
                self.assertFalse(e.message.startswith(UNCONFIRMED), e.message)

    def test_a_content_refusal_is_policy_and_never_claims_it_was_not_billed(self):
        for adapter in ("omni", "banana"):
            e = self.code_for(google_error(400, "INVALID_ARGUMENT", "The prompt was blocked: PROHIBITED_CONTENT"), adapter)
            self.assertEqual(e.code, E_POLICY)
            self.assertTrue(e.message.startswith(BILLING_UNKNOWN), e.message)
            self.assertRegex(BILLING_UNKNOWN, r"do not say whether")

    def test_no_message_this_module_builds_claims_nothing_was_charged(self):
        low = BILLING_UNKNOWN.lower()
        for phrase in ("not billed", "no charge", "free of charge", "at no cost", "nothing was bought", "will not be charged"):
            self.assertNotIn(phrase, low)

    def test_the_key_never_reaches_an_error_message_even_when_google_echoes_it(self):
        self.vendor.on("POST", POST, Resp(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT",
                                                          "message": f"bad key {KEY} in x-goog-api-key: {KEY}"}}))
        with self.assertRaises(AdapterError) as cm:
            self.omni().submit(t2v(), OMNI)
        self.assertNotIn(KEY, cm.exception.message)
        self.assertNotIn(KEY[:12], cm.exception.message)


# ── Omni: polling and fetching ────────────────────────────────────────────────────────

class OmniPollTests(VendorCase):
    def task(self) -> ProviderTask:
        return ProviderTask("video.gemini_omni", OMNI, TID)

    def poll(self, body, status=200):
        self.vendor._routes.clear()
        self.vendor.on("GET", GET, Resp(status, body))
        return self.omni().poll(self.task())

    def test_a_running_interaction_is_pending_and_the_poll_never_submits_again(self):
        for status in ("in_progress", "queued", "running"):
            self.assertEqual(self.poll(interaction(status)).state, PENDING, status)
        self.assertEqual(self.vendor.seen("POST", POST), [])
        req = self.vendor.seen("GET", GET)[-1]
        self.assertEqual(req.path, GET + TID)
        self.assertEqual(req.headers["x-goog-api-key"], KEY)

    def test_a_completed_interaction_yields_the_inline_clip_and_fetch_stores_it_atomically(self):
        res = self.poll(video_done())
        self.assertEqual(res.state, SUCCEEDED)
        (path,) = self.omni().fetch(res, self.tmp / "out")
        self.assertEqual(path.read_bytes(), MP4)
        self.assertEqual(path.suffix, ".mp4")
        self.assertEqual([p.name for p in (self.tmp / "out").iterdir()], [path.name])      # no .part left behind

    def test_the_text_and_thought_steps_are_not_a_clip(self):
        body = interaction(content=[{"type": "text", "text": "Here is your video"}])
        with self.assertRaises(AdapterError) as cm:
            self.poll(body)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)

    def test_every_failure_after_google_finished_carries_the_spend_note(self):
        bad = (
            interaction(content=[{"type": "video", "mime_type": "video/mp4"}]),                        # neither data nor uri
            interaction(content=[{"type": "video", "mime_type": "video/webm", "data": b64(MP4)}]),     # not mp4
            interaction(content=[{"type": "video", "mime_type": "video/mp4", "data": "!!!notbase64"}]),
            interaction(content=[{"type": "video", "mime_type": "video/mp4",
                                  "uri": "https://evil.example/v1beta/files/x:download?alt=media"}]),  # a host nobody vetted
        )
        for body in bad:
            with self.subTest(body=str(body)[:80]):
                with self.assertRaises(AdapterError) as cm:
                    self.poll(body)
                self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)

    def test_bytes_that_are_not_an_mp4_are_not_stored(self):
        res = self.poll(interaction(content=[{"type": "video", "mime_type": "video/mp4", "data": b64(b"<html>not a clip</html>")}]))
        with self.assertRaises(AdapterError) as cm:
            self.omni().fetch(res, self.tmp / "out")
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))
        self.assertEqual(list((self.tmp / "out").glob("*")), [])

    def test_failed_and_cancelled_interactions_are_failures_with_the_billing_unknown_note(self):
        for status in ("failed", "cancelled"):
            res = self.poll(interaction(status, error={"message": "internal error while rendering"}))
            self.assertEqual(res.state, FAILED, status)
            self.assertTrue(res.error.message.startswith(BILLING_UNKNOWN), res.error.message)
            self.assertEqual(res.error.code, E_UNAVAILABLE)

    def test_a_failure_that_names_safety_is_policy(self):
        res = self.poll(interaction("failed", error={"message": "The video was blocked by safety filters"}))
        self.assertEqual((res.state, res.error.code), (FAILED, E_POLICY))
        self.assertTrue(res.error.message.startswith(BILLING_UNKNOWN))

    def test_a_pause_for_client_input_is_a_failure_that_says_nothing_was_cancelled(self):
        res = self.poll(interaction("requires_action"))
        self.assertEqual(res.state, FAILED)
        self.assertIn("not cancelled", res.error.message)
        self.assertTrue(res.error.message.startswith(BILLING_UNKNOWN))

    def test_an_unknown_status_is_a_bad_response_never_quietly_pending_forever(self):
        with self.assertRaises(AdapterError) as cm:
            self.poll(interaction("teleporting"))
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        with self.assertRaises(AdapterError) as cm:
            self.poll(["not", "an", "object"])
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)

    def test_a_task_id_that_could_steer_the_request_is_refused_before_any_call(self):
        for bad in ("../../admin", "v1/x", "a b", "", None, "x" * 201, "id?alt=media"):
            with self.subTest(bad=bad):
                with self.assertRaises(AdapterError) as cm:
                    self.omni().poll(ProviderTask("video.gemini_omni", OMNI, bad))
                self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_keeps_its_remedy(self):
        self.vendor.on("GET", GET, google_error(404, "NOT_FOUND", "interaction not found"))
        with self.assertRaises(AdapterError) as cm:
            self.omni().poll(self.task())
        self.assertEqual(cm.exception.code, E_NOT_FOUND)


class OmniResultDownloadTests(VendorCase):
    """A ``uri`` result: Google's own file host only, the key in a header to that host only, no redirect."""

    def uri_task(self, host="localhost"):
        return interaction(content=[{"type": "video", "mime_type": "video/mp4",
                                     "uri": f"https://{host}:{self.vendor.port}/v1beta/files/f1:download?alt=media"}])

    def poll(self, body):
        self.vendor._routes.clear()
        self.vendor.on("GET", GET, Resp(200, body))
        return self.omni().poll(ProviderTask("video.gemini_omni", OMNI, TID))

    def test_the_key_goes_in_a_header_to_the_api_host_itself_and_the_clip_is_stored(self):
        res = self.poll(self.uri_task("localhost"))
        self.vendor.on("GET", "/v1beta/files/", Resp(200, raw=MP4, headers={"Content-Type": "video/mp4"}))
        (path,) = self.omni().fetch(res, self.tmp / "out")
        self.assertEqual(path.read_bytes(), MP4)
        (req,) = self.vendor.seen("GET", "/v1beta/files/")
        self.assertEqual(req.headers.get("x-goog-api-key"), KEY)
        self.assertNotIn(KEY, req.path)

    def test_a_vetted_host_that_is_not_the_api_host_gets_no_key(self):
        # base URL is localhost; 127.0.0.1 passes the allow-list in this test but is not the API host.
        res = self.poll(self.uri_task("127.0.0.1"))
        self.vendor.on("GET", "/v1beta/files/", Resp(200, raw=MP4))
        self.omni().fetch(res, self.tmp / "out")
        (req,) = self.vendor.seen("GET", "/v1beta/files/")
        self.assertNotIn("x-goog-api-key", req.headers)
        self.assertNotIn("authorization", req.headers)

    def test_a_redirect_is_never_followed_and_so_the_key_never_follows_it(self):
        res = self.poll(self.uri_task())
        self.vendor.on("GET", "/v1beta/files/", Resp(302, headers={"Location": "https://127.0.0.1:1/steal"}))
        with self.assertRaises(AdapterError) as cm:
            self.omni().fetch(res, self.tmp / "out")
        self.assertIn("redirect", cm.exception.message)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))
        self.assertEqual(len(self.vendor.seen("GET", "/v1beta/files/")), 1)

    def test_an_expired_link_is_not_found_and_never_auth(self):
        res = self.poll(self.uri_task())
        self.vendor.on("GET", "/v1beta/files/", Resp(403, {"error": "expired"}))
        with self.assertRaises(AdapterError) as cm:
            self.omni().fetch(res, self.tmp / "out")
        self.assertEqual(cm.exception.code, E_NOT_FOUND)

    def test_a_stream_cut_short_leaves_no_file(self):
        res = self.poll(self.uri_task())
        self.vendor.on("GET", "/v1beta/files/", Resp(200, raw=MP4[:100], declared_length=len(MP4)))
        with self.assertRaises(AdapterError):
            self.omni().fetch(res, self.tmp / "out")
        self.assertEqual([p for p in (self.tmp / "out").glob("*")], [])

    def test_the_real_default_allow_list_refuses_a_look_alike_host_before_any_request(self):
        a = build_adapter("video.gemini_omni", env=self.env, session=self.vendor.session())     # default result_hosts
        self.vendor._routes.clear()
        self.vendor.on("GET", GET, Resp(200, interaction(content=[{"type": "video", "mime_type": "video/mp4",
                       "uri": "https://generativelanguage.googleapis.com.evil.example/v1beta/files/x:download?alt=media"}])))
        with self.assertRaises(AdapterError) as cm:
            a.poll(ProviderTask("video.gemini_omni", OMNI, TID))
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))
        self.assertEqual(len(self.vendor.requests), 1)                  # only the status poll, never the link

    def test_the_download_header_hook_is_closed_by_default_for_every_other_adapter(self):
        self.assertIsNone(GrokVideoAdapter(env={}).download_headers("https://vidgen.x.ai/a.mp4"))
        a = build_adapter("video.gemini_omni", env={"GEMINI_API_KEY": KEY})
        self.assertEqual(a.download_headers("https://generativelanguage.googleapis.com/v1beta/files/f:download?alt=media"),
                         {"x-goog-api-key": KEY})
        for url in ("https://storage.googleapis.com/x", "http://generativelanguage.googleapis.com/x",
                    "https://generativelanguage.googleapis.com.evil.example/x", "not a url"):
            self.assertIsNone(a.download_headers(url), url)


# ── Nano Banana 2.1 ────────────────────────────────────────────────────────────────────

class BananaSubmitTests(VendorCase):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", POST, Resp(200, image_done()))

    def test_text_to_image_is_synchronous_unstored_and_sends_every_priced_setting_explicitly(self):
        task = self.banana().submit(t2i(image_size="2K", aspect_ratio="16:9", end_user="a" * 32), NB)
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("image.gemini_interactions", NB, None))
        self.assertEqual([(o.mime, o.data) for o in task.outputs], [("image/png", png())])
        req = self.sent()
        self.assertEqual(req.headers["x-goog-api-key"], KEY)
        self.assertEqual(req.json(), {
            "model": NB,
            "input": [{"type": "text", "text": "a red apple on a white table"}],
            "response_format": {"type": "image", "image_size": "2K", "aspect_ratio": "16:9"},
            "generation_config": {"thinking_level": "medium"},        # thinking tokens are billed: never Google's default
            "background": False, "store": False})
        self.assertNotIn("user", req.json())

    def test_the_ratio_is_left_out_when_none_is_named(self):
        self.banana().submit(t2i(), NB)
        self.assertNotIn("aspect_ratio", self.sent().json()["response_format"])

    def test_an_edit_sends_the_words_then_up_to_fourteen_pictures(self):
        refs = tuple(self.frame(f"r{i}.png") for i in range(14))
        self.banana().submit(CapabilityRequest(EDIT, "put them all on a boat", image_size="1K", input_images=refs), NB)
        parts = self.sent().json()["input"]
        self.assertEqual(parts[0], {"type": "text", "text": "put them all on a boat"})
        self.assertEqual([p["type"] for p in parts[1:]], ["image"] * 14)
        self.assertEqual({p["mime_type"] for p in parts[1:]}, {"image/png"})

    def test_a_setting_the_price_depends_on_is_refused_before_any_call(self):
        refs = tuple(self.frame(f"r{i}.png") for i in range(15))
        cases = (
            (t2i(image_size=None), "image size"),                       # Google's default is 1K: never left to it
            (t2i(image_size="512"), "image size"),                      # 3.1 Flash Image's size, not this model's
            (t2i(aspect_ratio="7:5"), "aspect ratio"),
            (t2i(negative_prompt="no worms"), "negative"),
            (t2i(prompt=" "), "prompt is empty"),
            (CapabilityRequest(EDIT, "x", image_size="1K"), "at least one picture"),
            (CapabilityRequest(EDIT, "x", image_size="1K", input_images=refs), "at most 14"),
            (CapabilityRequest(EDIT, "x", image_size="1K", input_images=("https://example.invalid/a.png",)), "not https URLs"),
            (CapabilityRequest(EDIT, "x", image_size="1K", input_images=("a.gif",)), "PNG, JPEG or WebP"),
        )
        for req, needle in cases:
            with self.subTest(needle=needle):
                with self.assertRaises(AdapterError) as cm:
                    self.banana().submit(req, NB)
                self.assertEqual(cm.exception.code, E_BAD_REQUEST)
                self.assertTrue(cm.exception.not_accepted)
                self.assertIn(needle, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_pictures_beyond_the_inline_bound_are_refused(self):
        big = self.frame("big.png", b"\x89PNG" + b"\x00" * (15 * 1024 * 1024))
        with self.assertRaises(AdapterError) as cm:
            self.banana().submit(CapabilityRequest(EDIT, "x", image_size="1K", input_images=(big,)), NB)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.vendor.requests, [])

    def test_fourteen_is_what_the_registry_offers_and_fifteen_is_refused_there_too(self):
        entry = reg.get(NB)
        ok = CapabilityRequest(EDIT, "x", image_size="1K", input_images=tuple(f"r{i}.png" for i in range(14)))
        self.assertEqual(entry.problems(ok), [])
        over = CapabilityRequest(EDIT, "x", image_size="1K", input_images=tuple(f"r{i}.png" for i in range(15)))
        self.assertTrue(entry.problems(over))

    def test_an_unknown_model_is_refused(self):
        with self.assertRaises(AdapterError) as cm:
            self.banana().submit(t2i(), "gemini-3.1-flash-image")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.vendor.requests, [])

    def test_the_image_is_stored_under_the_type_it_is_not_the_type_the_json_claimed(self):
        res = self.banana().submit(t2i(), NB)
        res.outputs[0].mime = "image/png"
        (path,) = self.banana().fetch(type("R", (), {"outputs": res.outputs})(), self.tmp / "out")
        self.assertEqual(path.suffix, ".png")
        self.assertEqual(path.read_bytes(), png())


class BananaAnswerTests(VendorCase):
    def answer(self, body, status=200):
        self.vendor._routes.clear()
        self.vendor.on("POST", POST, Resp(status, body))
        return self.banana().submit(t2i(), NB)

    def test_an_answer_with_text_and_no_image_says_what_the_model_said_and_that_spend_is_unconfirmed(self):
        with self.assertRaises(AdapterError) as cm:
            self.answer(interaction(content=[{"type": "text", "text": "I can't create that picture."}]))
        e = cm.exception
        self.assertEqual(e.code, E_BAD_RESPONSE)
        self.assertTrue(e.message.startswith(UNCONFIRMED), e.message)
        self.assertIn("I can't create that picture", e.message)

    def test_an_answer_that_is_not_finished_is_unconfirmed_spend_not_a_refusal(self):
        with self.assertRaises(AdapterError) as cm:
            self.answer(interaction("in_progress"))
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))
        self.assertFalse(cm.exception.not_accepted)

    def test_bytes_that_are_not_a_picture_are_unconfirmed_spend(self):
        for data in (b"", b"<html>nope</html>"):
            with self.subTest(data=data[:8]):
                with self.assertRaises(AdapterError) as cm:
                    self.answer(image_done(data=data) if data else interaction(content=[{"type": "image", "data": ""}]))
                self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))

    def test_a_failed_interaction_is_raised_with_the_billing_unknown_note(self):
        with self.assertRaises(AdapterError) as cm:
            self.answer(interaction("failed", error={"message": "internal error"}))
        self.assertTrue(cm.exception.message.startswith(BILLING_UNKNOWN), cm.exception.message)

    def test_a_lost_answer_is_unconfirmed_spend(self):
        self.vendor.on("POST", POST, Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.banana().submit(t2i(), NB)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))
        self.assertFalse(cm.exception.not_accepted)

    def test_the_picture_is_stored_under_the_type_its_bytes_say(self):
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (8, 8)).save(buf, "JPEG")
        body = interaction(content=[{"type": "image", "mime_type": "image/png", "data": b64(buf.getvalue())}])
        task = self.answer(body)
        self.assertEqual(task.outputs[0].mime, "image/jpeg")                # the bytes are a JPEG, whatever the JSON said

    def test_there_is_nothing_to_poll_for_a_synchronous_image(self):
        task = self.answer(image_done())
        res = self.banana().poll(task)
        self.assertEqual(res.state, SUCCEEDED)


# ── probes: dark means never reached by --all ──────────────────────────────────────────

class ProbeTests(unittest.TestCase):
    def test_all_leaves_both_out_and_a_named_one_comes_back(self):
        from tools import probe_models

        entries = list(reg.registry().values())
        chosen = {e.id for e in probe_models.select(entries, [], None, True)}
        self.assertFalse(chosen & {OMNI, NB})
        for mid in (OMNI, NB):
            self.assertIn(mid, {e.id for e in probe_models.select(entries, [mid], None, True)})
        for cap in ("t2v", "i2v", "t2i", "edit"):
            self.assertFalse({e.id for e in probe_models.select(entries, [], cap, True)} & {OMNI, NB}, cap)


if __name__ == "__main__":
    unittest.main()
