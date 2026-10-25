"""Pika 2.5 and Pikaframes (Pika's own models on the Pika API): the adapter, the registry entries, and the rule that none
of it is for sale.

The adapter talks to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py): no network, no key, no spend.

What would break without these tests:

* a priced setting (resolution, duration) defaulted instead of refused: Pika bills per second by resolution and its own
  resolution default is 1080p, the dearest tier;
* a model of the ~168 Pika RESELLS (Seedance, Kling, Veo, ...) becoming reachable through this adapter: the owner's rule is the
  maker's own API, never an aggregator;
* the key following a redirect, or going to a link the vendor put in a JSON body (a result link, an upload answer, a job id that
  steers the poll path);
* a local file that is not a picture being uploaded to a vendor because its name ends in .png;
* a submit whose answer was lost being treated as "nothing was bought";
* a model whose terms (attribution, training on content, resale) nobody has settled becoming sellable.
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
from modules.capabilities import build_adapter, pika, pictures
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
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url
from tests.test_creative_worker import JOB, ORG

ROOT = Path(__file__).resolve().parent.parent
KEY = "pika-test-NOT-A-REAL-KEY-0123456789abcdef"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
IDS = ("pika-2.5", "pika-pikaframes")
VENDOR = {"pika-2.5": "pika-2.5", "pika-pikaframes": "pikaframes"}
T2V_PATH, I2V_PATH, FRAMES_PATH = ("/v1/media/pika/pika-2.5/text-to-video", "/v1/media/pika/pika-2.5/image-to-video",
                                   "/v1/media/pika/pikaframes/image-to-video")
UPLOAD_PATH, JOBS = "/v1/media/uploads", "/v1/media/jobs/"
HOSTED = "https://cdn.pika.art/v2/files/agent/abc/frame_000.png"


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
        self.tmp = Path(tempfile.mkdtemp(prefix="pika_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def frame(self, name="first.png") -> str:
        p = self.tmp / name
        p.write_bytes(png())
        return str(p)

    def adapter(self, *, hosts=("localhost",), env=None) -> pika.PikaVideoAdapter:
        env = env if env is not None else {"PIKA_API_KEY": KEY, "PIKA_BASE_URL": self.vendor.base_url}
        a = build_adapter("video.pika", env=env, session=self.vendor.session())
        if hosts is not None:
            a.result_hosts = hosts
            a.result_ports = (None, 443, self.vendor.port)
        return a


# ══ the registry ═════════════════════════════════════════════════════════════════

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_each_entry_is_on_pikas_adapter_with_the_vendor_model_the_docs_name(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual((e.adapter, e.provider, e.vendor_model), ("video.pika", "pika", VENDOR[mid]), mid)

    def test_only_pikas_own_models_are_here_and_nothing_a_reseller_catalogue_lists(self):
        self.assertEqual(sorted(pika.PikaVideoAdapter.SPECS), ["pika-2.5", "pikaframes"])
        self.assertEqual({m for m in self.r if self.r[m].provider == "pika"}, set(IDS))
        for vendor in ("bytedance/seedance-2.5", "kling/kling-3.0", "google/veo-3.1", "alibaba/wan3.0-video",
                       "alibaba/happyhorse-1.0", "minimax/h3", "seedance-2.5", "veo-3.1"):
            with self.assertRaises(AdapterError, msg=vendor) as cm:
                build_adapter("video.pika", env={"PIKA_API_KEY": KEY}).submit(req(), vendor)
            self.assertIn("not a Pika model", cm.exception.message)
        self.assertEqual(self.r["pika-2.5"].raw["pricing"]["unit"], "second")

    def test_the_gate_is_terms_review_and_nothing_can_be_sold(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual((e.terms_gate, e.api_exposure), ("terms_review_required", "web_only"), mid)
            self.assertEqual(rows[mid]["spec"]["terms_gate"], "terms_review_required", mid)   # sellable_models() refuses it
            notes = " ".join(e.raw["terms_notes"])
            self.assertRegex(notes, r"NOT read", mid)
            self.assertIn("Gate stays open", notes, mid)
            self.assertIn("Uzbekistan", notes, mid)

    def test_the_attribution_duty_is_recorded_as_a_clause_and_as_the_registry_attribution(self):
        for mid in IDS:
            e = self.r[mid]
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("section 7", notes, mid)
            self.assertIn("you must display appropriate attribution in a manner reasonably visible to end users", notes, mid)
            self.assertIn("unless your Plan expressly permits white-labeling", notes, mid)
            self.assertEqual(e.raw["attribution"], {"text": "Powered by Pika", "url": "https://pika.art"}, mid)

    def test_the_training_clause_is_recorded_verbatim(self):
        for mid in IDS:
            notes = " ".join(self.r[mid].raw["terms_notes"])
            self.assertIn("anonymized or aggregated Content, including Inputs, Outputs", notes, mid)
            self.assertIn("to train, improve, and develop its machine learning models", notes, mid)
            self.assertIn("perpetual", notes, mid)

    def test_the_resale_and_end_user_clauses_are_quoted_with_their_section(self):
        for mid in IDS:
            notes = " ".join(self.r[mid].raw["terms_notes"])
            self.assertIn("section 4", notes, mid)
            self.assertIn("you do not expose Pika's APIs directly to third parties", notes, mid)
            self.assertIn("Section 5 'Prohibited Uses'", notes, mid)
            self.assertIn("sell, resell, sublicense, or provide access to any part of the Service, its content, or API access "
                          "to any third party, except as expressly permitted under your Plan", notes, mid)
            self.assertIn("at least 18 years old", notes, mid)
            self.assertIn("08/04/2026", notes, mid)

    def test_no_migration_or_price_file_prices_them(self):
        units = []
        for mid in IDS:
            e = self.r[mid]
            units.append(e.credit_unit)
            units += [reg.credit_unit_for(mid, "second", k) for k in e.raw["pricing"]["variants"]["prices"]]
        self.assertEqual(len(units), 3 + 3)
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
            self.assertTrue(p["source_url"].startswith("https://api.dev.pika.art/catalog/apis/pika/"), mid)

    def test_the_prices_are_the_catalogues(self):
        self.assertEqual(self.r["pika-2.5"].raw["pricing"]["variants"], {"by": "resolution", "prices": {"720p": 0.04, "1080p": 0.09}})
        self.assertEqual(self.r["pika-pikaframes"].raw["pricing"]["variants"],
                         {"by": "resolution", "prices": {"720p": 0.04, "1080p": 0.06}})
        for mid in IDS:
            self.assertEqual(self.r[mid].raw["pricing"]["provider_usd_per_unit"], 0.04, mid)
            self.assertEqual((self.r[mid].default_resolution, self.r[mid].variants_by), ("720p", "resolution"), mid)

    def test_a_failed_job_is_never_stated_to_be_free(self):
        for mid in IDS:
            for note in [self.r[mid].raw["pricing"]["note"], *self.r[mid].raw["terms_notes"]]:
                for bad in ("only successful generations are charged", "failed jobs are free", "failures are free"):
                    if bad in note.lower():       # a vendor's claim may be quoted, but only AS a claim
                        self.assertTrue("claim" in note.lower() and "unverified" in note.lower(), (mid, note))
            self.assertIn("claim", self.r[mid].raw["pricing"]["note"])

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        a = pika.PikaVideoAdapter
        e = self.r["pika-2.5"]
        self.assertEqual((e.resolutions, e.durations_s, e.aspect_ratios, e.audio_out, e.end_frame),
                         (("720p", "1080p"), (5,), (), False, False))
        self.assertEqual(sorted(a.SPECS["pika-2.5"]["resolutions"]), sorted(e.resolutions))
        self.assertEqual(e.capabilities, ("t2v", "i2v"))
        f = self.r["pika-pikaframes"]
        self.assertEqual((f.capabilities, f.resolutions, f.durations_s, f.end_frame), (("i2v",), ("720p", "1080p"), (1, 2, 3, 4, 5), True))
        self.assertEqual(list(f.durations_s), list(a.SPECS["pikaframes"]["durations"]["end"]))

    def test_probes_are_servable_and_cheap(self):
        p = self.r["pika-2.5"].probe_request(generated_image="https://probe.invalid/x.png")
        self.assertEqual((p.capability, p.resolution, p.duration_s, bool(p.end_image)), (I2V, "720p", 5, False))
        p = self.r["pika-pikaframes"].probe_request(generated_image="https://probe.invalid/x.png",
                                                    generated_end_image="https://probe.invalid/end.png")
        self.assertEqual((p.capability, p.resolution, p.duration_s, bool(p.end_image)), (I2V, "720p", 1, True))

    def test_the_notes_say_what_is_not_wired_and_why(self):
        for mid in IDS:
            note = self.r[mid].raw["api_documented"]["note"]
            self.assertIn("Pikaffects", note, mid)
            self.assertIn("not wired", note, mid)


# ══ submit ════════════════════════════════════════════════════════════════════════════

class SubmitTests(Case):
    def setUp(self):
        super().setUp()
        for path in (T2V_PATH, I2V_PATH, FRAMES_PATH):
            self.vendor.on("POST", path, Resp(200, {"id": "media_8f3a2c91-5b7d", "status": "queued"}))
        self.vendor.on("POST", UPLOAD_PATH, Resp(200, {"url": HOSTED}))

    def sent(self, path=T2V_PATH):
        (r,) = self.vendor.seen("POST", path)
        return r

    def test_text_to_video_sends_every_priced_setting_explicitly_and_the_header_key(self):
        task = self.adapter().submit(req(), "pika-2.5")
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("video.pika", "pika-2.5", "media_8f3a2c91-5b7d"))
        r = self.sent()
        self.assertEqual(r.headers["x-api-key"], KEY)
        self.assertNotIn("authorization", r.headers)
        self.assertEqual(r.json(), {"resolution": "720p", "duration_s": 5, "prompt": "a boat at dawn"})
        self.assertIs(type(r.json()["duration_s"]), int)

    def test_a_negative_prompt_is_sent_when_asked(self):
        self.adapter().submit(req(negative_prompt=" blur "), "pika-2.5")
        self.assertEqual(self.sent().json()["negative_prompt"], "blur")

    def test_nothing_unpriced_or_unverified_is_ever_sent(self):
        self.adapter().submit(req(resolution="1080p"), "pika-2.5")
        body = self.sent().json()
        self.assertEqual(body["resolution"], "1080p")
        for field in ("seed", "webhook_url", "loop", "aspect_ratio", "audio", "generate_audio", "model"):
            self.assertNotIn(field, body, field)
        self.assertNotIn("idempotency-key", self.sent().headers)

    def test_image_to_video_uploads_the_picture_first_and_sends_its_hosted_link(self):
        task = self.adapter().submit(CapabilityRequest(I2V, "slow push in", resolution="1080p", duration_s=5,
                                                       input_images=(self.frame(),)), "pika-2.5")
        self.assertEqual(task.task_id, "media_8f3a2c91-5b7d")
        up = self.sent(UPLOAD_PATH)
        self.assertEqual(up.headers["content-type"], "image/png")
        self.assertEqual(up.headers["x-api-key"], KEY)
        self.assertEqual(up.body, png())                                  # the raw bytes, nothing wrapped
        body = self.sent(I2V_PATH).json()
        self.assertEqual(body, {"resolution": "1080p", "duration_s": 5, "prompt": "slow push in", "image": HOSTED})
        order = [r.path for r in self.vendor.requests]
        self.assertEqual(order, [UPLOAD_PATH, I2V_PATH])                  # upload strictly before the paid call

    def test_an_https_link_goes_as_a_link_without_an_upload(self):
        self.adapter().submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5,
                                                input_images=("https://example.invalid/a.png",)), "pika-2.5")
        self.assertEqual(self.sent(I2V_PATH).json()["image"], "https://example.invalid/a.png")
        self.assertEqual(self.vendor.seen("POST", UPLOAD_PATH), [])

    def test_pikaframes_keeps_the_keyframes_in_order(self):
        from PIL import Image

        first, last = self.tmp / "a.png", self.tmp / "b.png"
        for path, colour in ((first, (200, 30, 30)), (last, (30, 30, 200))):
            Image.new("RGB", (8, 8), colour).save(path, "PNG")
        a_bytes = first.read_bytes()
        self.vendor._routes[:] = [r for r in self.vendor._routes if r[1] != UPLOAD_PATH]
        self.vendor.on("POST", UPLOAD_PATH, lambda r: Resp(200, {"url": "https://cdn.pika.art/v2/" + ("first" if r.body == a_bytes else "last") + ".png"}))
        self.adapter().submit(CapabilityRequest(I2V, "x", resolution="720p", duration_s=2, end_image=str(last),
                                                input_images=(str(first),)), "pikaframes")
        self.assertEqual(self.sent(FRAMES_PATH).json()["images"],
                         ["https://cdn.pika.art/v2/first.png", "https://cdn.pika.art/v2/last.png"])

    def test_pikaframes_sends_both_keyframes_in_order_and_the_duration_as_the_transition(self):
        task = self.adapter().submit(CapabilityRequest(I2V, "morph", resolution="1080p", duration_s=4, end_image=self.frame("end.png"),
                                                       input_images=(self.frame(),)), "pikaframes")
        self.assertEqual(task.vendor_model, "pikaframes")
        body = self.sent(FRAMES_PATH).json()
        self.assertEqual(body, {"resolution": "1080p", "prompt": "morph", "images": [HOSTED, HOSTED], "transition_duration_s": 4})
        self.assertEqual(len(self.vendor.seen("POST", UPLOAD_PATH)), 2)
        self.assertNotIn("duration_s", body)
        self.assertNotIn("loop", body)

    def test_a_setting_the_price_depends_on_is_refused_before_any_call_never_defaulted(self):
        pic = self.frame()
        gif = self.tmp / "a.gif"
        gif.write_bytes(b"GIF89a")
        i2v = lambda **kw: CapabilityRequest(I2V, **{**dict(prompt="x", resolution="720p", duration_s=5, input_images=(pic,)), **kw})  # noqa: E731
        frames = lambda **kw: i2v(**{**dict(end_image=pic, duration_s=3), **kw})  # noqa: E731
        cases = (
            ("pika-2.5", req(resolution=None), "resolution"),
            ("pika-2.5", req(resolution="480p"), "resolution"),
            ("pika-2.5", req(resolution="4k"), "resolution"),
            ("pika-2.5", req(duration_s=None), "duration"),
            ("pika-2.5", req(duration_s=4), "duration"),
            ("pika-2.5", req(duration_s=10), "duration"),                       # image-to-video takes 10 s but it is not offered
            ("pika-2.5", i2v(duration_s=10), "duration"),
            ("pika-2.5", req(aspect_ratio="16:9"), "no aspect ratio"),
            ("pika-2.5", req(prompt=" "), "prompt is empty"),
            ("pika-2.5", req(input_images=(pic,)), "does not apply to text-to-video"),
            ("pika-2.5", i2v(input_images=()), "first-frame picture"),
            ("pika-2.5", i2v(input_images=(pic, pic)), "one first-frame picture"),
            ("pika-2.5", i2v(end_image=pic), "belongs to Pikaframes"),
            ("pika-2.5", i2v(input_images=(str(gif),)), "JPEG, PNG or WEBP"),
            ("pikaframes", i2v(), "first and a last picture"),                 # no last frame
            ("pikaframes", req(), "first and a last picture"),                 # no text-to-video
            ("pikaframes", frames(duration_s=6), "duration"),                  # one transition: 1-5 s offered
            ("pikaframes", frames(duration_s=0), "duration"),
            ("pikaframes", frames(duration_s=None), "duration"),
            ("pikaframes", frames(resolution=None), "resolution"),
            ("pikaframes", frames(resolution="480p"), "resolution"),
            ("pikaframes", frames(aspect_ratio="1:1"), "no aspect ratio"),
            ("pikaffects", req(), "not a Pika model"),                          # not wired
            ("pikaswaps", req(), "not a Pika model"),
            ("pikadditions", req(), "not a Pika model"),
            ("pika-2.0", req(), "not a Pika model"),
            ("", req(), "not a Pika model"),
        )
        for model, request, fragment in cases:
            with self.assertRaises(AdapterError, msg=(model, request)) as cm:
                self.adapter().submit(request, model)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, (model, request))
            self.assertTrue(cm.exception.not_accepted, (model, request))
            self.assertIn(fragment, cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_no_sound_flag_exists(self):
        entry = reg.get("pika-2.5")
        self.assertTrue(self.adapter().problems(req(audio=True), entry))
        self.assertTrue(self.adapter().problems(req(audio=False), entry))      # the adapter sends no audio flag at all

    def test_the_registry_entries_refuse_what_the_adapter_would_refuse(self):
        a = self.adapter()
        for mid in IDS:
            entry = reg.get(mid)
            probe = entry.probe_request(generated_image="https://probe.invalid/x.png",
                                        generated_end_image="https://probe.invalid/end.png")
            self.assertEqual(a.problems(probe, entry), [], mid)
        self.assertTrue(a.problems(req(resolution=None), reg.get("pika-2.5")))
        self.assertTrue(a.problems(req(duration_s=None), reg.get("pika-2.5")))
        self.assertTrue(a.problems(req(), reg.get("pika-pikaframes")))
        self.assertTrue(a.problems(req(prompt="x" * 2001), reg.get("pika-2.5")))

    def test_no_key_is_a_refusal_before_any_call(self):
        a = self.adapter(env={"PIKA_BASE_URL": self.vendor.base_url})
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "pika-2.5")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])


class UploadTests(Case):
    """The upload is the first call of a picture job; it is not billable, and its answer is checked before it is passed on."""

    def setUp(self):
        super().setUp()
        self.vendor.on("POST", I2V_PATH, Resp(200, {"id": "media_1", "status": "queued"}))

    def go(self):
        return self.adapter().submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5,
                                                       input_images=(self.frame(),)), "pika-2.5")

    def test_a_hosted_link_off_pikas_hosts_is_refused_and_no_job_is_started(self):
        for url in ("https://attacker.example/a.png", "http://cdn.pika.art/a.png", "https://cdn.pika.art.attacker.example/a.png",
                    "https://attacker.example/cdn.pika.art/a.png", "https://cdn.pika.art:8443/a.png", "javascript:alert(1)", "",
                    None, 5, "https://127.0.0.1\\@cdn.pika.art/a.png"):
            self.vendor._routes[:] = [r for r in self.vendor._routes if r[1] != UPLOAD_PATH]
            self.vendor.requests.clear()
            self.vendor.on("POST", UPLOAD_PATH, Resp(200, {"url": url}))
            a = self.adapter(hosts=None)
            with self.assertRaises(AdapterError, msg=repr(url)) as cm:
                a.submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5, input_images=(self.frame(),)), "pika-2.5")
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, repr(url))
            self.assertTrue(cm.exception.not_accepted, repr(url))
            self.assertEqual(self.vendor.seen("POST", I2V_PATH), [], repr(url))

    def test_an_upload_that_fails_is_a_refusal_whatever_the_status_because_nothing_billable_was_sent(self):
        for resp in (Resp(500, {"message": "x"}), Resp(503, {"message": "x"}), Resp(drop=True), Resp(200, raw=b"<html>ok</html>"),
                     Resp(413, {"message": "too big"}), Resp(415, {"message": "type"}), Resp(401, {"message": "Invalid API key"})):
            self.vendor._routes[:] = [r for r in self.vendor._routes if r[1] != UPLOAD_PATH]
            self.vendor.requests.clear()
            self.vendor.on("POST", UPLOAD_PATH, resp)
            with self.assertRaises(AdapterError) as cm:
                self.go()
            self.assertTrue(cm.exception.not_accepted)
            self.assertNotIn(UNCONFIRMED, cm.exception.message)
            self.assertIn("no generation was started", cm.exception.message)
            self.assertEqual(self.vendor.seen("POST", I2V_PATH), [])

    def test_the_upload_sends_the_key_only_to_the_api_and_follows_no_redirect(self):
        attacker = FakeVendor()
        self.addCleanup(attacker.close)
        attacker.on("POST", "/", Resp(200, {"url": HOSTED}))
        self.vendor.on("POST", UPLOAD_PATH, Resp(307, headers={"Location": f"{attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError):
            self.go()
        self.assertEqual(attacker.requests, [])

    def test_a_file_the_size_cap_forbids_is_refused_before_it_is_read(self):
        big = self.tmp / "big.png"
        with open(big, "wb") as fh:
            fh.write(png())
            fh.truncate(pika.PikaVideoAdapter.MAX_IMAGE_BYTES + 1)
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5, input_images=(str(big),)), "pika-2.5")
        self.assertIn("over 20 MB", cm.exception.message)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])


class LostAnswerTests(Case):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)

    def test_a_dropped_connection_a_timeout_and_a_5xx_may_have_billed(self):
        for resp in (Resp(drop=True), Resp(503, {"id": "media_1", "status": "failed", "error": {"code": "provider_unavailable", "message": "x"}}),
                     Resp(502, raw=b"<html>bad gateway</html>"), Resp(200, {"id": "late"}, hang_s=1.5)):
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, resp)
            a = self.adapter()
            a.timeout = 0.4
            with self.assertRaises(AdapterError) as cm:
                a.submit(req(), "pika-2.5")
            self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_5xx_stays_unconfirmed_whatever_word_the_body_carries(self):
        # a gateway can answer 5xx in front of a Pika that already took the job: the status decides, not a vendor word
        for status in (500, 502, 503, 504):
            for code in ("rate_limited", "insufficient_balance", "content_moderation", "invalid_input", "cycle_limit_exceeded"):
                self.vendor._routes.clear()
                self.vendor.on("POST", T2V_PATH, Resp(status, {"id": "media_1", "status": "failed", "error": {"code": code, "message": "x"}}))
                with self.assertRaises(AdapterError, msg=(status, code)) as cm:
                    self.adapter().submit(req(), "pika-2.5")
                self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_id_may_have_billed(self):
        for body in ({}, {"id": ""}, {"id": None}, {"id": 5}, {"id": "../x"}, {"id": "a/b"}, {"id": "a.b"}, {"id": "a:b"},
                     {"id": "x" * 300}, {"status": "queued"}, [], None):
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, Resp(200, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.adapter().submit(req(), "pika-2.5")
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_2xx_that_is_not_json_may_have_billed(self):
        self.vendor.on("POST", T2V_PATH, Resp(200, raw=b"<html>ok</html>"))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(req(), "pika-2.5")
        self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_the_failed_job_envelope_names_the_refusal_and_proven_ones_are_proof(self):
        cases = ((403, "insufficient_balance", E_QUOTA, True), (403, "cycle_limit_exceeded", E_QUOTA, True),
                 (429, "rate_limited", E_RATE_LIMITED, True), (401, None, E_AUTH, True), (404, None, E_NOT_FOUND, True),
                 (422, None, E_BAD_REQUEST, False), (400, "content_moderation", E_POLICY, False),
                 (400, "invalid_input", E_BAD_REQUEST, False))
        for status, code, want, proof in cases:
            self.vendor._routes.clear()
            body = ({"id": "media_1", "status": "failed", "error": {"code": code, "message": f"m {KEY}"}} if code
                    else {"message": f"nope {KEY}"})
            self.vendor.on("POST", T2V_PATH, Resp(status, body))
            with self.assertRaises(AdapterError, msg=(status, code)) as cm:
                self.adapter().submit(req(), "pika-2.5")
            self.assertEqual(cm.exception.code, want, (status, code))
            self.assertEqual(cm.exception.not_accepted, proof, (status, code))
            self.assertNotIn(UNCONFIRMED, cm.exception.message)
            self.assertNotIn(KEY, cm.exception.message)

    def test_a_2xx_failed_job_envelope_is_the_vendors_refusal_not_a_lost_answer(self):
        for code, want in (("invalid_input", E_BAD_REQUEST), ("insufficient_balance", E_QUOTA), ("rate_limited", E_RATE_LIMITED),
                           ("content_moderation", E_POLICY), ("provider_error", E_UNAVAILABLE), ("internal", E_UNAVAILABLE),
                           ("brand_new", E_UNAVAILABLE)):
            self.vendor._routes.clear()
            self.vendor.on("POST", T2V_PATH, Resp(200, {"id": "media_1", "status": "failed", "error": {"code": code, "message": f"x {KEY}"}}))
            with self.assertRaises(AdapterError, msg=code) as cm:
                self.adapter().submit(req(), "pika-2.5")
            self.assertEqual(cm.exception.code, want, code)
            self.assertNotIn(KEY, cm.exception.message)
            if want == E_UNAVAILABLE:           # an outage-shaped refusal does not prove nothing was started
                self.assertUnconfirmed(cm, E_UNAVAILABLE)
            else:
                self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.adapter(env={"PIKA_API_KEY": KEY, "PIKA_BASE_URL": closed_port_url()})
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "pika-2.5")
        self.assertTrue(cm.exception.not_accepted)

    def test_a_second_call_is_never_made_after_a_lost_answer(self):
        self.vendor.on("POST", T2V_PATH, Resp(drop=True))
        with self.assertRaises(AdapterError):
            self.adapter().submit(req(), "pika-2.5")
        self.assertEqual(len(self.vendor.seen("POST", T2V_PATH)), 1)

    def test_the_creative_bridge_keeps_the_difference(self):
        entry = reg.get("pika-2.5")

        def bridged(env, **params):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=self.vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2v", model=entry.id,
                                                  params=dict(prompt="a boat", duration_s=5, **params), input_files=()))
        with self.assertRaises(ca.CreativeAdapterError) as cm:           # the job carries no resolution: not quoted
            bridged({"PIKA_API_KEY": KEY, "PIKA_BASE_URL": self.vendor.base_url})
        self.assertIn("no resolution", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])
        self.vendor.on("POST", T2V_PATH, Resp(drop=True))
        with self.assertRaises(AdapterError) as lost:
            bridged({"PIKA_API_KEY": KEY, "PIKA_BASE_URL": self.vendor.base_url}, resolution="720p")
        self.assertFalse(lost.exception.not_accepted)


# ══ poll ══════════════════════════════════════════════════════════════════════════════

class PollTests(Case):
    def status(self, body, jid="media_1", code=200, *, hosts=("localhost",)):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", f"{JOBS}{jid}", Resp(code, body))
        return self.adapter(hosts=hosts).poll(ProviderTask("video.pika", "pika-2.5", jid))

    def test_queued_and_running_are_pending_and_the_key_goes_only_to_the_api(self):
        for st in ("queued", "running", "something_new"):
            self.assertEqual(self.status({"id": "media_1", "status": st}).state, PENDING, st)
        (r,) = self.vendor.seen("GET", f"{JOBS}media_1")
        self.assertEqual(r.headers["x-api-key"], KEY)
        self.assertEqual(self.vendor.seen("POST", ""), [])                # polling never submits

    def test_completed_hands_back_the_clip_link(self):
        base = self.vendor.base_url
        res = self.status({"id": "media_1", "status": "completed", "billing": {"state": "settled", "charge_micro_usd": 200000},
                           "output": {"media_type": "video", "video": {"url": f"{base}/v1/files/video_1.mp4", "content_type": "video/mp4"}}})
        self.assertEqual((res.state, res.outputs[0].mime, res.outputs[0].url), (SUCCEEDED, "video/mp4", f"{base}/v1/files/video_1.mp4"))

    def test_a_failed_job_carries_the_vendors_error_code_and_the_right_remedy(self):
        cases = (("content_moderation", E_POLICY), ("invalid_input", E_BAD_REQUEST), ("rate_limited", E_RATE_LIMITED),
                 ("insufficient_balance", E_QUOTA), ("cycle_limit_exceeded", E_QUOTA), ("membership_required", E_QUOTA),
                 ("provider_error", E_UNAVAILABLE), ("provider_timeout", E_UNAVAILABLE), ("provider_unavailable", E_UNAVAILABLE),
                 ("timed_out", E_UNAVAILABLE), ("internal", E_UNAVAILABLE), ("admission_suspended", E_UNAVAILABLE),
                 ("brand_new_code", E_UNAVAILABLE))
        for code, want in cases:
            res = self.status({"id": "media_1", "status": "failed", "error": {"code": code, "message": f"it broke {KEY}"}})
            self.assertEqual((res.state, res.error.code), (FAILED, want), code)
            self.assertNotIn(KEY, res.error.message)
            self.assertTrue(res.error.message.endswith(pika.SPEND_UNKNOWN), res.error.message)
            self.assertIn("usage page", res.error.message)
            self.assertIn("vendor claim", res.error.message)
        res = self.status({"id": "media_1", "status": "failed"})
        self.assertEqual(res.error.code, E_UNAVAILABLE)
        self.assertTrue(res.error.message.endswith(pika.SPEND_UNKNOWN))

    def test_a_failed_jobs_billing_is_quoted_as_pikas_statement_only_when_settled(self):
        res = self.status({"status": "failed", "error": {"code": "provider_error", "message": "x"},
                           "billing": {"state": "settled", "charge_micro_usd": 0}})
        self.assertIn("billing settled at 0 micro-USD (its statement, unverified)", res.error.message)
        for billing in ({"state": "pending"}, {"state": "unavailable"}, None, {"state": "settled", "charge_micro_usd": "0"},
                        {"state": "settled", "charge_micro_usd": True}, {"state": "pending", "charge_micro_usd": 5},
                        {"state": "unavailable", "charge_micro_usd": 0}, {"charge_micro_usd": 0}):
            res = self.status({"status": "failed", "error": {"code": "provider_error", "message": "x"}, "billing": billing})
            self.assertNotIn("micro-USD", res.error.message, billing)
            self.assertNotIn("not charged", res.error.message.lower())

    def test_completed_without_a_link_may_have_billed_and_says_so(self):
        for output in (None, {}, {"video": {}}, {"video": {"url": ""}}, {"video": {"url": 5}}, {"image": {"url": "https://x/a.png"}}, "x"):
            with self.assertRaises(AdapterError, msg=repr(output)) as cm:
                self.status({"status": "completed", "output": output})
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))

    def test_only_pikas_two_hosts_are_allowed_and_any_other_names_itself(self):
        for url in ("https://api.dev.pika.art/v1/files/video_1.mp4", "https://cdn.pika.art/v2/media/m/output.mp4?X=1"):
            ok = self.status({"status": "completed", "output": {"video": {"url": url}}}, hosts=None)
            self.assertEqual(ok.state, SUCCEEDED, url)
        for url in ("http://api.dev.pika.art/v1/files/v.mp4", "https://pika.art/v.mp4", "https://dev.pika.art/v.mp4",
                    "https://evil.cdn.pika.art.attacker.example/v.mp4", "https://attacker.example/cdn.pika.art/v.mp4",
                    "https://cdn.pika.art:8443/v.mp4", "https://127.0.0.1\\@cdn.pika.art/v.mp4", "https://user:pw@cdn.pika.art/v.mp4",
                    "https://storage.googleapis.com/b/v.mp4"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status({"status": "completed", "output": {"video": {"url": url}}}, hosts=None)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, url)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)
        with self.assertRaises(AdapterError) as cm:
            self.status({"status": "completed", "output": {"video": {"url": "https://files.example.net/v.mp4"}}}, hosts=None)
        self.assertIn("'files.example.net'", cm.exception.message)

    def test_a_job_id_that_could_steer_the_request_is_refused(self):
        for jid in ("../../billing/balance", "a/b", "a?b", "a#b", "..", ".", "a.b", "a:b", "", " ", "x" * 300, "a\\b", "a%2fb", "a b",
                    "media_1\n"):
            with self.assertRaises(AdapterError, msg=repr(jid)) as cm:
                self.adapter().poll(ProviderTask("video.pika", "pika-2.5", jid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_is_typed(self):
        with self.assertRaises(AdapterError) as cm:
            self.status({"message": "media job not found"}, code=404)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        with self.assertRaises(AdapterError) as cm:
            self.status({"message": "Invalid API key"}, code=401)
        self.assertEqual(cm.exception.code, E_AUTH)
        with self.assertRaises(AdapterError) as cm:
            self.status({"message": "dependency down"}, code=503)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)


# ══ the key never leaves the API host ═════════════════════════════════════════════════

def clip_result(url):
    return PollResult(SUCCEEDED, [Output("video/mp4", url=url)])


class RedirectAndDownloadTests(Case):
    def setUp(self):
        super().setUp()
        self.attacker = FakeVendor()
        self.addCleanup(self.attacker.close)
        self.attacker.on("GET", "/", Resp(200, {"status": "completed"}))
        self.attacker.on("POST", "/", Resp(200, {"id": "stolen"}))

    def test_the_adapter_says_it_follows_no_redirect(self):
        self.assertIs(pika.PikaVideoAdapter.follow_redirects, False)

    def test_the_submit_call_does_not_follow_a_redirect(self):
        self.vendor.on("POST", T2V_PATH, Resp(307, headers={"Location": f"{self.attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(req(), "pika-2.5")
        self.assertIn("307", cm.exception.message)
        self.assertEqual(self.attacker.requests, [])

    def test_the_poll_call_does_not_follow_a_redirect(self):
        self.vendor.on("GET", f"{JOBS}media_1", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().poll(ProviderTask("video.pika", "pika-2.5", "media_1"))
        self.assertIn("302", cm.exception.message)
        self.assertEqual(self.attacker.requests, [])

    def test_control_the_same_redirect_WOULD_reach_the_other_host_if_it_were_followed(self):
        self.vendor.on("GET", f"{JOBS}media_1", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        a = self.adapter()
        a.follow_redirects = True
        try:
            a.poll(ProviderTask("video.pika", "pika-2.5", "media_1"))
        except AdapterError:
            pass                                                       # the other host's answer is no clip: not the point
        self.assertEqual([r.path for r in self.attacker.requests], ["/steal"])

    def test_the_download_sends_no_key_and_follows_no_redirect(self):
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4))
        a = self.adapter()
        (path,) = a.fetch(clip_result(self.vendor.base_url + "/clip.mp4"), self.tmp, "clip")
        self.assertEqual(path.read_bytes(), MP4)
        (r,) = self.vendor.seen("GET", "/clip.mp4")
        self.assertNotIn("x-api-key", r.headers)
        self.assertNotIn("authorization", r.headers)
        self.assertNotIn(KEY, str(r.headers))
        self.vendor.on("GET", "/moved.mp4", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError) as cm:
            a.fetch(clip_result(self.vendor.base_url + "/moved.mp4"), self.tmp, "moved")
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)
        self.assertEqual(self.attacker.requests, [])

    def test_a_files_route_that_needs_the_key_fails_closed_with_the_spend_note(self):
        # The pages do not say whether /v1/files needs the key. It is never sent; a 401 / 403 is an expired-or-gone link.
        self.vendor.on("GET", "/v1/files/video_1.mp4", Resp(401, {"message": "Invalid API key"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().fetch(clip_result(self.vendor.base_url + "/v1/files/video_1.mp4"), self.tmp, "x")
        self.assertEqual(cm.exception.code, E_NOT_FOUND)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))
        (r,) = self.vendor.seen("GET", "/v1/files/video_1.mp4")
        self.assertNotIn("x-api-key", r.headers)

    def test_a_file_that_is_not_a_video_is_not_stored(self):
        self.vendor.on("GET", "/page.mp4", Resp(200, raw=b"<html>login</html>" * 50))
        with self.assertRaises(AdapterError):
            self.adapter().fetch(clip_result(self.vendor.base_url + "/page.mp4"), self.tmp, "page")
        self.assertEqual(list(self.tmp.glob("page*")), [])


# ══ end to end through the probe ═══════════════════════════════════════════════════════

class EndToEndTests(Case):
    def run_probe(self, polls, *, entry_id="pika-pikaframes", path=FRAMES_PATH, timeout_s=600):
        from tools.probe_models import run_probe

        self.vendor.on("POST", UPLOAD_PATH, Resp(200, {"url": HOSTED}))
        self.vendor.on("POST", path, Resp(200, {"id": "media_9", "status": "queued"}))
        self.vendor.on("GET", f"{JOBS}media_9", polls)
        self.vendor.on("GET", "/clip.mp4", Resp(200, raw=MP4))
        clock = {"t": 0.0}
        with mock.patch.object(pika.PikaVideoAdapter, "result_hosts", ("localhost",)), \
                mock.patch.object(pika.PikaVideoAdapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(entry_id), env={"PIKA_API_KEY": KEY, "PIKA_BASE_URL": self.vendor.base_url},
                             voice_id=None, workdir=self.tmp, timeout_s=timeout_s, poll_every_s=5,
                             session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def done(self, url=None):
        return Resp(200, {"id": "media_9", "status": "completed",
                          "output": {"media_type": "video", "video": {"url": url or f"{self.vendor.base_url}/clip.mp4"}}})

    def test_the_pikaframes_probe_runs_the_whole_chain_and_stores_a_real_clip(self):
        res = self.run_probe([Resp(200, {"id": "media_9", "status": "queued"}), Resp(200, {"id": "media_9", "status": "running"}),
                              self.done()])
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.output_bytes, len(MP4))
        body = self.vendor.seen("POST", FRAMES_PATH)[0].json()
        self.assertEqual((body["resolution"], body["transition_duration_s"], len(body["images"])), ("720p", 1, 2))
        self.assertEqual(len(self.vendor.seen("POST", UPLOAD_PATH)), 2)      # both keyframes went up
        self.assertEqual(len(self.vendor.seen("POST", FRAMES_PATH)), 1)

    def test_the_pika_2_5_probe_goes_through_image_to_video_with_an_uploaded_picture(self):
        res = self.run_probe([self.done()], entry_id="pika-2.5", path=I2V_PATH)
        self.assertTrue(res.ok, res.message)
        body = self.vendor.seen("POST", I2V_PATH)[0].json()
        self.assertEqual((body["resolution"], body["duration_s"], body["image"]), ("720p", 5, HOSTED))

    def test_a_job_that_never_finishes_ends_as_a_timeout_that_names_the_job(self):
        res = self.run_probe([Resp(200, {"id": "media_9", "status": "running"})], timeout_s=30)
        self.assertEqual((res.ok, res.code, res.task_id), (False, "timeout", "media_9"))

    def test_an_expired_clip_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/expired.mp4", Resp(403, {"error": "expired"}))
        res = self.run_probe([self.done(f"{self.vendor.base_url}/expired.mp4")])
        self.assertEqual((res.ok, res.code), (False, E_NOT_FOUND))
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)


# ══ pictures ═════════════════════════════════════════════════════════════════════════

class LocalPictureTests(Case):
    """A path comes from a job. Only a real picture may be read from it and uploaded to a vendor."""

    def setUp(self):
        super().setUp()
        self.vendor.on("POST", UPLOAD_PATH, Resp(200, {"url": HOSTED}))
        for path in (I2V_PATH, FRAMES_PATH):
            self.vendor.on("POST", path, Resp(200, {"id": "media_1", "status": "queued"}))

    def secret_file(self, name="notes.png", body=b"DB_PASSWORD=hunter2\n" * 20) -> str:
        p = self.tmp / name
        p.write_bytes(body)
        return str(p)

    def submitters(self):
        a = self.adapter()
        yield ("first frame", lambda ref: a.submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5,
                                                                      input_images=(ref,)), "pika-2.5"))
        yield ("last frame", lambda ref: a.submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=3, end_image=ref,
                                                                     input_images=(self.frame("ok.png"),)), "pikaframes"))

    def test_a_file_that_only_wears_a_picture_suffix_is_refused_and_nothing_is_uploaded(self):
        bodies = {"text": b"DB_PASSWORD=hunter2\n" * 20, "html": b"<html><body>login</body></html>",
                  "zip": b"PK\x03\x04" + b"\x00" * 64, "gif": b"GIF89a" + b"\x00" * 64,
                  "svg": b"<svg xmlns='http://www.w3.org/2000/svg'/>", "empty": b""}
        for who, submit in self.submitters():
            for kind, body in bodies.items():
                self.vendor.requests.clear()
                with self.assertRaises(AdapterError, msg=(who, kind)) as cm:
                    submit(self.secret_file(f"{kind}.png", body))
                self.assertEqual(cm.exception.code, E_BAD_REQUEST, (who, kind))
                self.assertTrue(cm.exception.not_accepted, (who, kind))
                self.assertIn("not a PNG, JPEG or WEBP picture", cm.exception.message)
                self.assertEqual(self.vendor.seen("POST", "/v1/media/pika"), [], (who, kind))
                for up in self.vendor.seen("POST", UPLOAD_PATH):          # only the harmless first frame may have gone up
                    self.assertEqual(up.body, png(), (who, kind))
        self.vendor.requests.clear()
        with self.assertRaises(AdapterError):
            list(self.submitters())[0][1](self.secret_file("secret.png"))
        self.assertEqual(self.vendor.requests, [])

    def test_a_suffix_that_is_not_a_picture_is_refused_before_the_file_is_opened(self):
        for who, submit in self.submitters():
            for name in ("notes.txt", "key.pem", "a.gif", "a.svg", "a", ".env", "a.png.exe"):
                with self.assertRaises(AdapterError, msg=(who, name)) as cm:
                    submit(self.secret_file(name))
                self.assertIn("JPEG, PNG or WEBP", cm.exception.message)

    def test_the_upload_is_labelled_with_the_type_its_bytes_say_not_its_suffix(self):
        from PIL import Image

        jpeg, webp = io.BytesIO(), io.BytesIO()
        Image.new("RGB", (8, 8), (10, 20, 30)).save(jpeg, "JPEG")
        Image.new("RGB", (8, 8), (10, 20, 30)).save(webp, "WEBP")
        for body, mime in ((png(), "image/png"), (jpeg.getvalue(), "image/jpeg"), (webp.getvalue(), "image/webp")):
            self.vendor.requests.clear()
            self.adapter().submit(CapabilityRequest(I2V, "go", resolution="720p", duration_s=5,
                                                    input_images=(self.secret_file("liar.png", body),)), "pika-2.5")
            (up,) = self.vendor.seen("POST", UPLOAD_PATH)
            self.assertEqual((up.headers["content-type"], up.body), (mime, body))

    def test_read_picture_matches_inline_picture_on_every_refusal(self):
        for ref in (str(self.tmp / "gone.png"), self.secret_file("t.png"), self.secret_file("t.txt")):
            with self.assertRaises(AdapterError) as a:
                pictures.read_picture(ref, max_bytes=1 << 20, who="x")
            with self.assertRaises(AdapterError) as b:
                pictures.inline_picture(ref, max_bytes=1 << 20, who="x")
            self.assertEqual((a.exception.code, a.exception.message), (b.exception.code, b.exception.message))
            self.assertTrue(a.exception.not_accepted)


# ══ wiring ═════════════════════════════════════════════════════════════════════════════

class WiringTests(unittest.TestCase):
    def test_the_adapter_is_wired_the_way_a_header_key_adapter_must_be(self):
        a = pika.PikaVideoAdapter
        self.assertEqual((a.key, a.key_env, a.base_url_env, a.default_base_url),
                         ("video.pika", ("PIKA_API_KEY",), "PIKA_BASE_URL", "https://api.dev.pika.art"))
        self.assertEqual(a.result_hosts, ("api.dev.pika.art", "cdn.pika.art"))
        self.assertEqual(a.result_ports, (None, 443))
        self.assertIs(a.follow_redirects, False)
        self.assertEqual(a.end_frame_capabilities, (I2V,))
        self.assertEqual(a.audio_capabilities, ())
        self.assertEqual(set(a.resolution_capabilities), {T2V, I2V})

    def test_the_new_key_is_one_the_worker_the_probe_workflow_and_the_doctor_can_be_given(self):
        example = (ROOT / "deploy" / ".env.worker.example").read_text()
        deploy = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text()
        probe = (ROOT / ".github" / "workflows" / "probe_models.yml").read_text()
        doctor = (ROOT / "tools" / "doctor.py").read_text()
        name = "PIKA_API_KEY"
        self.assertRegex(example, rf"(?m)^{name}=$")                       # empty in the example, never a value
        self.assertIn(f"WORKERENV_{name}: ${{{{ secrets.{name} }}}}", deploy)
        self.assertIn(f"{name}: ${{{{ secrets.{name} }}}}", probe)
        self.assertIn(f'"{name}"', doctor)
        self.assertIn(f'("{name}", "pika")', doctor)

    def test_the_key_page_checks_the_key_with_the_one_free_read_pika_documents(self):
        text = (ROOT / "command-center" / "lib" / "model-keys.ts").read_text()
        i = text.index('id: "pika"')
        card = text[i:text.index("\n  },\n", i)]
        self.assertIn('envSets: [["PIKA_API_KEY"]]', card)
        self.assertIn('origin: "https://api.dev.pika.art"', card)
        self.assertIn('path: "/billing/balance"', card)
        self.assertIn('auth: { header: "X-API-Key", scheme: "raw" }', card)
        self.assertIn('name: "balance_micro_usd"', card)

    def test_all_probe_skips_every_pika_entry_and_a_named_one_comes_back(self):
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
        sellable = {e.id for e in reg.registry().values() if not e.terms_gate}
        self.assertFalse(sellable & set(IDS))


if __name__ == "__main__":
    unittest.main()
