"""Google Lyria 3.5 (music, Interactions API): the adapter, the registry entry, and the rules that keep it dark.

docs/research/lyria-3-5.md is the contract. The adapter talks to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py): no
network, no key, no spend, no call to Google.

What would break without these tests:

* a song decoded from a base64 string that is not base64 (or one so large it is allocated before anything checks it), or "succeeded"
  with no audio at all;
* Google's block for an artist's voice or a real song's lyrics reaching the person as a generic failure, or retried, instead of
  ``policy`` with what to change (rule 4: the block is the answer, never another model);
* a song sung in Russian or Uzbek (or any language) that no real call has proven, or a duration / negative prompt "accepted" for a
  model that has no such field and then dropped while the person pays;
* the Api-Revision header, ``store: false`` or the key header falling out of the request, or the key reaching an error message;
* the SynthID watermark not recorded on the library row;
* the model reaching the public API, MCP, a price, a probe of everything, or the sync, before the owner signs the legal text.
"""

from __future__ import annotations

import base64
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_POLICY,
    MUSIC,
    REGISTRY_ONLY_CAPABILITIES,
    AdapterError,
    CapabilityRequest,
)
from modules.capabilities.google_interactions import (
    BILLING_UNKNOWN,
    LYRIA_API_REVISION,
    LYRIA_INSTRUMENTAL,
    LYRIA_POLICY_REMEDY,
    GoogleLyriaAdapter,
)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate

ROOT = Path(__file__).resolve().parent.parent
KEY = "AIzaSy-test-NOT-A-REAL-KEY-0123456789abcdef"
LYRIA, VENDOR = "google-lyria-3.5", "lyria-3.5"
POST = "/v1beta/interactions"
#: An ID3 tag then an MPEG frame header: what safe_fetch and the adapter both read as MP3.
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 4096


def tearDownModule():
    cleanup_certificate()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def song(data=None, *, mime="audio/mpeg", text="[Instrumental]", status="completed", **extra) -> dict:
    content = [{"type": "text", "text": text}] if text else []
    if data is not False:
        block = {"type": "audio", "data": data if isinstance(data, str) else b64(MP3)}
        if mime:
            block["mime_type"] = mime
        content.append(block)
    return {"id": "v1_lyria-1", "status": status, "model": VENDOR, "object": "interaction",
            "steps": [{"type": "user_input", "content": [{"type": "text", "text": "..."}]},
                      {"type": "model_output", "content": content}], **extra}


def music(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=MUSIC, prompt="a calm solo piano piece"), **kw})


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.env = {"GEMINI_API_KEY": KEY, "GEMINI_BASE_URL": self.vendor.base_url + "/v1beta"}

    def answer(self, resp: Resp) -> None:
        """The one answer the next call gets: a subtest must never be served the route an earlier subtest left behind."""
        self.vendor.close()
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.env = {**self.env, "GEMINI_BASE_URL": self.vendor.base_url + "/v1beta"}
        self.vendor.on("POST", POST, resp)

    def lyria(self) -> GoogleLyriaAdapter:
        return build_adapter("audio.google_lyria", env=self.env, session=self.vendor.session())

    def sent(self):
        (req,) = self.vendor.seen("POST", POST)
        return req


# ── the registry: dark, gated, unpriced, web only ──────────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()
        self.e = self.r[LYRIA]

    def test_lyria_is_one_more_provider_of_the_existing_music_capability(self):
        self.assertEqual((self.e.adapter, self.e.provider, self.e.vendor_model, self.e.capabilities),
                         ("audio.google_lyria", "google", VENDOR, (MUSIC,)))
        self.assertIs(ADAPTERS["audio.google_lyria"], GoogleLyriaAdapter)
        self.assertEqual(GoogleLyriaAdapter.capabilities, (MUSIC,))

    def test_it_is_web_only_and_on_no_api_or_mcp_list(self):
        # Google APIs Terms 4(a): never a bare prompt-to-song service or a public API. web_only keeps it off the API (0035's
        # sellable_models for an API key) and the absent mcp_oauth_exposure keeps it off the MCP connector (0191).
        self.assertEqual(self.e.api_exposure, "web_only")
        self.assertNotIn("mcp_oauth_exposure", self.e.raw)
        self.assertEqual(self.e.terms_gate, "terms_review_required")

    def test_it_is_registry_only_so_nothing_can_sync_probe_price_or_run_it(self):
        # The database does not know `music` yet (base.REGISTRY_ONLY_CAPABILITIES): no row, so no quote, hold or job.
        self.assertIn(MUSIC, REGISTRY_ONLY_CAPABILITIES)
        self.assertTrue(self.e.registry_only)
        self.assertNotIn(LYRIA, [row["id"] for row in reg.sync_rows(list(self.r.values()))])
        self.assertIsNone(ca.resolve(LYRIA, env={"GEMINI_API_KEY": KEY}))

    def test_the_end_user_conditions_ride_the_entry_the_existing_gates_read(self):
        # 0192/0196 read requires_adult; 0208's trigger and lib/geo/blocked.ts read blocked_countries. Russia is not one of Google's
        # available regions; Uzbekistan is.
        self.assertIs(self.e.raw["requires_adult"], True)
        blocked = self.e.raw["blocked_countries"]
        self.assertIn("RU", blocked)
        self.assertNotIn("UZ", blocked)
        self.assertEqual(blocked, self.r["gemini-nano-banana-2.1"].raw["blocked_countries"])
        geo = (ROOT / "command-center" / "lib" / "geo" / "blocked.ts").read_text()
        google_models = geo[geo.index("export const GOOGLE_MODELS"):]
        self.assertIn(f'"{LYRIA}"', google_models[:google_models.index("];")])

    def test_the_price_is_unconfirmed_and_no_credit_price_row_exists_so_a_quote_is_refused(self):
        p = self.e.raw["pricing"]
        self.assertEqual((p["unit"], p["confirmed"]), ("request", False))
        self.assertEqual(self.e.credit_unit, "model_google_lyria_3_5_request")
        hits = []
        for folder in ("supabase/migrations", "docs/sql", "deploy", "command-center/lib", "command-center/app"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".ts", ".tsx", ".json", ".yml", ".txt"):
                    if re.search(rf"\b{self.e.credit_unit}\b", path.read_text(errors="ignore")):
                        hits.append(str(path.relative_to(ROOT)))
        self.assertEqual(hits, [], "a credit_prices row would make Lyria priced before the probe and the owner's sign-off")

    def test_no_duration_is_offered_because_lyria_has_no_duration_field(self):
        # 0036 sells music by duration_s and creative_price refuses a length the entry does not list: an empty list can never be
        # quoted by the second, which is right for a model billed per song.
        self.assertEqual(self.e.durations_s, ())
        self.assertEqual(self.e.problems(music(duration_s=30)), ["duration 30s is not offered by google-lyria-3.5"])

    def test_the_probe_is_an_instrumental_piece_the_adapter_accepts(self):
        req = self.e.probe_request()
        self.assertEqual(GoogleLyriaAdapter(env={}).problems(req, self.e), [])

    def test_no_probe_picks_it_even_by_name_while_the_database_cannot_record_it(self):
        from tools import probe_models  # noqa: PLC0415

        for ids, everything in (([], True), ([LYRIA], False)):
            self.assertNotIn(LYRIA, [e.id for e in probe_models.select(list(self.r.values()), ids, None, everything)])


# ── the request ───────────────────────────────────────────────────────────────────

class RequestTests(VendorCase):
    def test_the_call_is_the_documented_one_synchronous_and_not_stored(self):
        self.vendor.on("POST", POST, Resp(200, song()))
        task = self.lyria().submit(music(), VENDOR)
        req = self.sent()
        self.assertEqual(req.path, POST)                                   # never a key in the query string
        self.assertEqual(req.headers.get("api-revision"), LYRIA_API_REVISION)   # the fake vendor lower-cases header names
        self.assertEqual(req.headers.get("x-goog-api-key"), KEY)
        self.assertNotIn("authorization", req.headers)
        body = req.json()
        self.assertEqual(set(body), {"model", "input", "response_format", "background", "store"})
        self.assertEqual(body["model"], VENDOR)
        self.assertEqual(body["response_format"], {"type": "audio"})
        self.assertIs(body["store"], False)
        self.assertIs(body["background"], False)
        self.assertEqual(task.task_id, None)
        self.assertEqual(len(task.outputs), 1)

    def test_with_no_proven_language_every_song_is_asked_for_without_vocals(self):
        self.vendor.on("POST", POST, Resp(200, song()))
        self.lyria().submit(music(prompt="  a calm solo piano piece  "), VENDOR)
        self.assertEqual(self.sent().json()["input"], f"a calm solo piano piece\n\n{LYRIA_INSTRUMENTAL}")


class RefusedBeforeTheCallTests(VendorCase):
    def assertRefused(self, request, needle):
        with self.assertRaises(AdapterError) as cm:
            self.lyria().submit(request, VENDOR)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertTrue(cm.exception.not_accepted)
        self.assertIn(needle, cm.exception.message)
        self.assertEqual(self.vendor.seen("POST", POST), [], "nothing may reach Google")

    def test_vocals_in_a_language_no_call_has_proven_are_refused(self):
        for lang in ("ru", "uz", "en", "Russian"):
            with self.subTest(lang=lang):
                self.assertRefused(music(text_language=lang), f"not offered for vocals in {lang}")

    def test_a_prompt_with_lyric_sections_is_refused_while_only_instrumental_is_offered(self):
        self.assertRefused(music(prompt="[Verse]\nla la la\n[Chorus]\noh"), "lyric sections")

    def test_settings_lyria_has_no_field_for_are_refused_not_dropped(self):
        self.assertRefused(music(duration_s=30), "no duration setting")
        self.assertRefused(music(negative_prompt="drums"), "no negative prompt")
        self.assertRefused(music(aspect_ratio="16:9"), "an aspect ratio does not apply")
        self.assertRefused(music(input_images=("/tmp/x.png",)), "asked by words only")

    def test_an_empty_prompt_and_an_unknown_vendor_model_are_refused(self):
        self.assertRefused(music(prompt="  "), "prompt is empty")
        with self.assertRaises(AdapterError):
            self.lyria().submit(music(), "lyria-3-pro-preview")

    def test_no_key_means_no_call(self):
        with self.assertRaises(AdapterError) as cm:
            build_adapter("audio.google_lyria", env={}, session=self.vendor.session()).submit(music(), VENDOR)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.seen("POST", POST), [])

    def test_the_registry_check_says_the_same_before_a_job_is_queued(self):
        e = reg.load()[LYRIA]
        self.assertTrue(any("vocals in ru" in p for p in self.lyria().problems(music(text_language="ru"), e)))
        self.assertEqual(self.lyria().problems(music(), e), [])


# ── the answer ────────────────────────────────────────────────────────────────────

class DecodeTests(VendorCase):
    def output(self, answer):
        self.answer(Resp(200, answer))
        return self.lyria().submit(music(), VENDOR).outputs

    def failure(self, answer) -> AdapterError:
        self.answer(Resp(200, answer))
        with self.assertRaises(AdapterError) as cm:
            self.lyria().submit(music(), VENDOR)
        self.assertFalse(cm.exception.not_accepted, "the call went through: it may have been billed")
        return cm.exception

    def test_the_song_is_the_decoded_mp3(self):
        (out,) = self.output(song())
        self.assertEqual((out.mime, out.data), ("audio/mpeg", MP3))

    def test_a_block_without_a_media_type_and_the_top_level_output_audio_are_read(self):
        (out,) = self.output(song(mime=None))
        self.assertEqual(out.data, MP3)
        top = song(data=False)
        top["output_audio"] = {"type": "audio", "data": b64(MP3), "mime_type": "audio/mp3"}
        (out,) = self.output(top)
        self.assertEqual(out.data, MP3)

    def test_the_last_audio_block_is_the_song(self):
        answer = song()
        other = MP3[:-1] + b"\x01"
        answer["steps"][-1]["content"].append({"type": "audio", "mime_type": "audio/mpeg", "data": b64(other)})
        (out,) = self.output(answer)
        self.assertEqual(out.data, other)

    def test_bad_base64_fails_closed(self):
        for bad in ("not base64!!", b64(MP3)[:-1], "SUQz\nBAAA", b64(MP3).replace("A", "-", 1), "SUQz BAAA"):
            with self.subTest(bad=bad[:12]):
                e = self.failure(song(data=bad))
                self.assertEqual(e.code, E_BAD_RESPONSE)
                self.assertTrue(e.message.startswith(AFTER_COMPLETION), e.message)
                self.assertIn("base64", e.message)

    def test_missing_empty_or_wrong_audio_fails_closed(self):
        cases = {
            "no audio": (song(data=False), "completed without audio"),
            "empty": (song(data=""), "completed without audio"),
            "wav": (song(mime="audio/wav"), "MP3 was asked for"),
            "not mp3": (song(data=b64(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)), "not an MP3"),
        }
        for name, (answer, needle) in cases.items():
            with self.subTest(name):
                e = self.failure(answer)
                self.assertEqual(e.code, E_BAD_RESPONSE)
                self.assertIn(needle, e.message)

    def test_an_answer_over_the_cap_is_refused_before_it_is_decoded(self):
        a = self.lyria()
        a.max_inline_bytes = 1024
        self.vendor.on("POST", POST, Resp(200, song(data=b64(MP3 + b"\x00" * 4096))))
        with mock.patch("modules.capabilities.google_interactions.base64.b64decode") as decode:
            with self.assertRaises(AdapterError) as cm:
                a.submit(music(), VENDOR)
        decode.assert_not_called()
        self.assertIn("byte limit", cm.exception.message)

    def test_an_unfinished_or_unreadable_answer_is_unconfirmed_spend(self):
        e = self.failure(song(data=False, text=None, status="in_progress"))
        self.assertTrue(e.message.startswith(UNCONFIRMED), e.message)
        e = self.failure({"steps": "nonsense", "status": "completed"})
        self.assertEqual(e.code, E_BAD_RESPONSE)


class SafetyBlockTests(VendorCase):
    def assertBlocked(self, e: AdapterError):
        self.assertEqual(e.code, E_POLICY)
        self.assertFalse(e.retryable)
        self.assertTrue(e.message.startswith(BILLING_UNKNOWN), e.message)
        self.assertIn(LYRIA_POLICY_REMEDY, e.message)
        self.assertIn("remove any artist's name or voice and any real song's lyrics", e.message)

    def blocked(self, resp: Resp) -> AdapterError:
        self.answer(resp)
        with self.assertRaises(AdapterError) as cm:
            self.lyria().submit(music(), VENDOR)
        return cm.exception

    def test_an_http_refusal_for_an_artist_voice_or_copyrighted_lyrics_is_policy_with_the_remedy(self):
        for msg in ("The prompt was blocked by safety filters.", "Request for a specific artist voice is not allowed.",
                    "Generation of copyrighted lyrics is not allowed."):
            with self.subTest(msg=msg):
                self.assertBlocked(self.blocked(Resp(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": msg}})))

    def test_a_failed_interaction_or_a_finished_one_without_audio_that_says_so_is_policy(self):
        self.assertBlocked(self.blocked(Resp(200, {"id": "x", "status": "failed",
                                                   "error": {"message": "Blocked: recitation of copyrighted lyrics"}})))
        self.assertBlocked(self.blocked(Resp(200, song(data=False, text="This request was blocked by our safety filters."))))

    def test_a_400_that_is_not_about_content_stays_a_bad_request(self):
        e = self.blocked(Resp(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "Unknown field: foo"}}))
        self.assertEqual(e.code, E_BAD_REQUEST)

    def test_no_key_reaches_an_error_message(self):
        e = self.blocked(Resp(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT",
                                              "message": f"blocked by safety filters for key {KEY}"}}))
        self.assertNotIn(KEY, e.message)
        self.assertNotIn(KEY[:12], e.message)
        e = self.blocked(Resp(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": f"API key not valid: {KEY}"}}))
        self.assertNotIn(KEY, e.message)


# ── provenance: SynthID on every library row ──────────────────────────────────────

class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lyria_test_"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.entry = reg.load()[LYRIA]

    def test_the_adapter_says_every_file_carries_synthid_and_names_the_model(self):
        said = GoogleLyriaAdapter(env={}).output_provenance(music(), VENDOR)
        self.assertEqual(said, {"synthid": True, "vendor_model": VENDOR, "vocals_requested": False})

    def test_the_bridge_hands_it_to_the_worker_with_the_stored_song(self):
        adapter = GoogleLyriaAdapter(env={"GEMINI_API_KEY": KEY})
        store = {}
        ra = ca.RegistryAdapter(self.entry, adapter, sync_store=store)
        from modules.capabilities.base import Output  # noqa: PLC0415

        store[ca.SYNC_PREFIX + "k"] = [Output("audio/mpeg", data=MP3)]
        request = cw.GenerationRequest(job_id="j1", org_id="o1", capability=MUSIC, model=LYRIA,
                                       params={"prompt": "a calm solo piano piece"})
        result = ra.poll(ca.SYNC_PREFIX + "k", request, self.tmp)
        self.assertEqual(result.state, cw.SUCCEEDED)
        self.assertEqual(result.provenance["synthid"], True)
        self.assertEqual(result.provenance["vendor_model"], VENDOR)

    def test_the_worker_records_it_and_its_own_keys_always_win(self):
        worker = cw.CreativeWorker.__new__(cw.CreativeWorker)
        worker.library = cw.Library(store=object(), media_root=self.tmp)
        worker.queue = mock.Mock(attach_assets=mock.Mock(return_value=True))
        worker.worker_id = "w"
        f = self.tmp / "output_0.mp3"
        f.write_bytes(MP3)
        request = cw.GenerationRequest(job_id="j1", org_id="o1", capability=MUSIC, model=LYRIA, params={})
        with mock.patch.object(cw.ml, "store_generated") as store:
            worker._to_library(request, [f], None, {"synthid": True, "vendor_model": VENDOR, "job_id": "forged", "model": "x"})
        prov = store.call_args.kwargs["provenance"]
        self.assertEqual((prov["synthid"], prov["vendor_model"]), (True, VENDOR))
        self.assertEqual((prov["job_id"], prov["model"], prov["rights"]), ("j1", LYRIA, "generated_for_org"))

    def test_a_music_job_names_its_sung_language_to_the_adapter(self):
        request = cw.GenerationRequest(job_id="j", org_id="o", capability=MUSIC, model=LYRIA,
                                       params={"prompt": "p", "language": "ru"})
        self.assertEqual(ca.capability_request(request).text_language, "ru")


class DocsTests(unittest.TestCase):
    def test_the_research_note_and_the_adapter_agree_on_the_contract(self):
        doc = GoogleLyriaAdapter.__doc__ or ""
        for needle in ("Api-Revision: 2026-05-20", "store: false", "SynthID", "web_only", "vocal_languages"):
            self.assertIn(needle, doc)
        self.assertEqual(GoogleLyriaAdapter.SPECS[VENDOR]["vocal_languages"], ())


if __name__ == "__main__":
    unittest.main()
