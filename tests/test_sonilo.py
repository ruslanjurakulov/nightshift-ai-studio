"""Sonilo (Sonilo's own API): the music adapter, its two registry entries, and the rule that none of it can be reached.

The adapter talks to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py): no network, no key, no spend.

What would break without these tests:

* a registry entry with a capability the database does not know reaching ``sync_model_registry``: the check constraint would
  fail the sync of EVERY model, not just this one;
* a paid probe of such an entry: its result could not be recorded, so the money would be spent for nothing;
* a priced setting (the duration, the number of variants) left to the vendor's default, or a track shorter than Sonilo's
  10-second billing floor sold at seconds x rate;
* the key following a redirect, or going to a link the vendor put in a JSON body;
* a local file that is not a video being uploaded to a vendor (which trains on uploads and cannot delete them) because its
  name ends in .mp4, or a link from a job row being handed to the vendor to fetch;
* a submit whose answer was lost being treated as "nothing was bought";
* a result that is not an MP3 being stored as a track;
* a model whose terms (a compete clause, training on customers' videos) nobody has settled becoming sellable.
"""

from __future__ import annotations

import copy
import gzip
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter, sonilo
from modules.capabilities.base import (
    CAPABILITIES,
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    FILE_INPUT,
    MUSIC,
    OUTPUT_OF,
    PENDING,
    PROMPT_OPTIONAL,
    REGISTRY_ONLY_CAPABILITIES,
    SUCCEEDED,
    VIDEO_INPUT,
    VIDEO_MUSIC,
    AdapterError,
    CapabilityRequest,
    Output,
    PollResult,
    ProviderTask,
)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED, _looks_like
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate, closed_port_url
from tests.test_creative_worker import JOB, ORG

ROOT = Path(__file__).resolve().parent.parent
KEY = "sk_sonilo-test-NOT-A-REAL-KEY-0123456789abcdef"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x0a" + b"\x00" * 10 + b"\xff\xfb\x90\x64" + b"\x00" * 2048
MP3_BARE = b"\xff\xfb\x90\x64" + b"\x00" * 2048                       # no tag: straight into an MPEG audio frame
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 2048
IDS = ("sonilo-music", "sonilo-video-music")
VENDOR = {"sonilo-music": "text-to-music", "sonilo-video-music": "video-to-music"}
CAP = {"sonilo-music": MUSIC, "sonilo-video-music": VIDEO_MUSIC}
T2M, V2M, TASKS = "/v1/text-to-music", "/v1/video-to-music", "/v1/tasks/"
TID = "9f5f2f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b"
ACCEPTED = {"task_id": TID, "status": "processing"}


def tearDownModule():
    cleanup_certificate()


def req(**kw) -> CapabilityRequest:
    base = dict(capability=MUSIC, prompt="a calm piano melody", duration_s=30)
    return CapabilityRequest(**{**base, **kw})


def form(r) -> dict:
    """The fields of a multipart/form-data request the fake vendor saw: name -> (filename, content type, bytes)."""
    m = re.search(r"boundary=([^;]+)", r.headers.get("content-type", ""))
    assert m, r.headers.get("content-type")
    out = {}
    for part in r.body.split(b"--" + m.group(1).encode())[1:-1]:
        head, _, body = part.partition(b"\r\n\r\n")
        text = head.decode("latin-1")
        name = re.search(r'name="([^"]*)"', text).group(1)
        filename = re.search(r'filename="([^"]*)"', text)
        ctype = re.search(r"(?i)content-type:\s*([^\r\n]+)", text)
        assert name not in out, name
        out[name] = (filename.group(1) if filename else None, ctype.group(1) if ctype else None, body[:-2])
    return out


def track(url) -> PollResult:
    return PollResult(SUCCEEDED, [Output("audio/mpeg", url=url)])


class Case(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="sonilo_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def env(self):
        return {"SONILO_API_KEY": KEY, "SONILO_BASE_URL": self.vendor.base_url}

    def adapter(self, *, hosts=("localhost",), env=None) -> sonilo.SoniloMusicAdapter:
        a = build_adapter("audio.sonilo", env=env if env is not None else self.env(), session=self.vendor.session())
        if hosts is not None:
            a.result_hosts = hosts
            a.result_ports = (None, 443, self.vendor.port)
        return a

    def video(self, name="clip.mp4", body=MP4) -> str:
        p = self.tmp / name
        p.write_bytes(body)
        return str(p)

    def vreq(self, ref=None, **kw) -> CapabilityRequest:
        return CapabilityRequest(**{**dict(capability=VIDEO_MUSIC, input_media=(ref or self.video(),)), **kw})


# ══ the capabilities and the registry ════════════════════════════════════════════════

def _db_capabilities(name: str):
    """The closed capability list of the NEWEST migration that defines constraint ``name`` (0100 today)."""
    newest = None
    for path in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
        text = path.read_text()
        m = re.search(rf"add constraint {name}\s+check \((.*?)\);", text, re.S)
        if m:
            newest = m.group(1)
    assert newest, name
    return set(re.findall(r"'([a-z0-9_]+)'", newest))


class CapabilityTests(unittest.TestCase):
    def test_music_is_two_audio_capabilities_and_the_video_one_starts_from_a_video_file(self):
        self.assertEqual((MUSIC, VIDEO_MUSIC), ("music", "video_music"))
        self.assertEqual((OUTPUT_OF[MUSIC], OUTPUT_OF[VIDEO_MUSIC]), ("audio", "audio"))
        self.assertIn(VIDEO_MUSIC, VIDEO_INPUT)
        self.assertIn(VIDEO_MUSIC, FILE_INPUT)
        self.assertIn(VIDEO_MUSIC, PROMPT_OPTIONAL)       # scored to the picture: words only steer it
        self.assertNotIn(MUSIC, FILE_INPUT)
        self.assertNotIn(MUSIC, PROMPT_OPTIONAL)          # text-to-music is asked by its words

    def test_the_registry_only_set_is_exactly_what_the_database_does_not_list(self):
        # The migration that teaches the database a capability must also take it out of REGISTRY_ONLY_CAPABILITIES, and
        # nothing may be called registry-only that the database already knows.
        for constraint in ("model_registry_capabilities_check", "model_probe_runs_capability_check"):
            self.assertEqual(set(CAPABILITIES) - REGISTRY_ONLY_CAPABILITIES, _db_capabilities(constraint), constraint)
        # video_character_swap (0137) is sold through its own tables, never as a creative job: registry-only for good.
        # dialogue (S6_GAPS G5) waits for its migration: tests/test_elevenlabs_dialogue.py holds it.
        self.assertEqual(REGISTRY_ONLY_CAPABILITIES, {"music", "video_music", "video_character_swap", "dialogue"})

    def test_no_migration_here_adds_them(self):
        for path in (ROOT / "supabase" / "migrations").glob("*.sql"):
            self.assertNotIn("video_music", path.read_text(), path.name)

    def test_the_customer_ui_does_not_know_them(self):
        for rel in ("command-center/lib/models-discovery.ts", "command-center/lib/creative/registry.ts"):
            text = (ROOT / rel).read_text()
            block = text[text.index("CAPABILITIES = ["):]
            block = block[:block.index("] as const")]
            self.assertNotIn("music", block, rel)


class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()
        self.doc = json.loads(reg.REGISTRY_PATH.read_text())

    def mutated(self, mid, change):
        doc = copy.deepcopy(self.doc)
        change(next(m for m in doc["models"] if m["id"] == mid))
        return reg.validate(doc)

    def test_each_entry_is_on_sonilos_adapter_with_the_endpoint_the_docs_name(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual((e.adapter, e.provider, e.vendor_model, e.capabilities, e.output, e.is_async),
                             ("audio.sonilo", "sonilo", VENDOR[mid], (CAP[mid],), "audio", True), mid)
        self.assertEqual({m for m in self.r if self.r[m].provider == "sonilo"}, set(IDS))

    def test_only_the_two_wired_endpoints_are_reachable(self):
        self.assertEqual(sonilo.SoniloMusicAdapter.SPECS, {"text-to-music": MUSIC, "video-to-music": VIDEO_MUSIC})
        for vendor in ("video-to-video-music", "text-to-sfx", "video-to-sfx", "video-to-sound", "audio-ducking", "dubbing",
                       "video-analysis", "account/keys/self", "tasks", "../tasks", "suno-v5", "pika/sonilo"):
            with self.assertRaises(AdapterError, msg=vendor) as cm:
                build_adapter("audio.sonilo", env={"SONILO_API_KEY": KEY}).submit(req(), vendor)
            self.assertIn("not a Sonilo endpoint", cm.exception.message)
            self.assertTrue(cm.exception.not_accepted)

    def test_they_are_registry_only_so_the_database_never_sees_them(self):
        rows = reg.sync_rows(list(self.r.values()))
        known = _db_capabilities("model_registry_capabilities_check")
        self.assertFalse({row["id"] for row in rows} & set(IDS))
        for row in rows:      # one row outside the constraint would fail the sync of every model
            self.assertLessEqual(set(row["capabilities"]), known, row["id"])
        # The two Character Studio entries (0137) are registry-only too: tests/test_character_swap_adapters.py holds them.
        swap = {"kling-4.0-omni-edit", "seedance-2.5-edit"}
        # So are the two Text to Dialogue entries (tests/test_elevenlabs_dialogue.py).
        talk = {"elevenlabs-dialogue-v3", "elevenlabs-dialogue-v4"}
        self.assertEqual(len(rows), len(self.r) - 2 - len(swap) - len(talk))
        self.assertEqual({e.id for e in self.r.values() if e.registry_only}, set(IDS) | swap | talk)

    def test_the_gate_is_terms_review_and_nothing_can_be_sold(self):
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual((e.terms_gate, e.api_exposure, e.raw["attribution"]), ("terms_review_required", "web_only", None), mid)
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("NOT read", notes, mid)
            self.assertIn("Gate stays open", notes, mid)
            self.assertIn("Uzbekistan", notes, mid)
            self.assertIn("REGISTRY-ONLY", e.raw["api_documented"]["note"], mid)
        self.assertFalse({e.id for e in self.r.values() if not e.terms_gate} & set(IDS))

    def test_a_registry_only_entry_must_be_dark_by_its_own_fields(self):
        for change in (lambda m: m.update(terms_gate=None), lambda m: m.update(api_exposure="any"),
                       lambda m: m["pricing"].update(confirmed=True)):
            errors = self.mutated("sonilo-music", change)
            self.assertTrue(any("a registry-only entry stays dark" in e for e in errors), errors)

    def test_a_registry_only_capability_is_never_listed_beside_one_the_database_knows(self):
        errors = self.mutated("sonilo-music", lambda m: m["capabilities"].append("sfx"))
        self.assertTrue(any("never listed beside one it knows" in e for e in errors), errors)

    def test_a_music_for_video_model_needs_the_longest_source_it_takes(self):
        errors = self.mutated("sonilo-video-music", lambda m: m["limits"].pop("max_source_seconds"))
        self.assertTrue(any("video_music needs limits.max_source_seconds" in e for e in errors), errors)
        self.assertEqual(self.r["sonilo-video-music"].max_source_seconds, 360)

    def test_the_clauses_are_recorded_verbatim_with_their_dates(self):
        for mid in IDS:
            notes = " ".join(self.r[mid].raw["terms_notes"])
            for quote in (
                "Audio generated through the Sonilo API can be used commercially — in your own product and by your end users",
                "scoring their edits in a video-editing app",
                "the Terms govern if anything here differs",
                "You may not use the Service or Outputs to build, train, benchmark, or offer a product or service that competes with Sonilo.",
                "Assign, sublicense, resell, or otherwise transfer rights in the Software except as expressly authorized by Sonilo",
                "Any use of the Service not expressly allowed by these Terms requires our prior written consent",
                "by default to all users, and there is no separate opt-out",
                "a separate plan, product setting, or written agreement",
                "irrevocable, non-exclusive, worldwide, perpetual, royalty-free",
                "Output may not be unique, and other users may receive similar or identical results",
                "A Content ID claim is still possible. Sonilo says it does not register generated tracks with Content ID",
                "For API output, retain its generation record",
                "at least 13 years old",
                "October 2, 2026", "October 10, 2026", "2026-10-01",
            ):
                self.assertIn(quote, notes, (mid, quote))
            self.assertIn("our reading, not Sonilo's", notes, mid)
            self.assertIn("RETENTION", notes, mid)
        self.assertIn("must be told and must agree", " ".join(self.r["sonilo-video-music"].raw["terms_notes"]))

    def test_no_migration_or_price_file_prices_them(self):
        units = [self.r[mid].credit_unit for mid in IDS]
        self.assertEqual(units, ["model_sonilo_music_second", "model_sonilo_video_music_second"])
        hits = []
        for folder in ("supabase/migrations", "docs/sql", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".ts", ".json", ".yml", ".txt"):
                    text = path.read_text(errors="ignore")
                    hits += [f"{path.relative_to(ROOT)}: {u}" for u in units if re.search(rf"\b{u}\b", text)]
        self.assertEqual(hits, [], "a credit_prices row would make a gated model priced")

    def test_every_price_is_a_dated_unconfirmed_estimate_with_a_source(self):
        want = {"sonilo-music": 0.00225, "sonilo-video-music": 0.009}
        for mid in IDS:
            p = self.r[mid].raw["pricing"]
            self.assertEqual((p["unit"], p["provider_usd_per_unit"], p["confirmed"], p["as_of"], p["source_url"]),
                             ("second", want[mid], False, "2026-11-10", "https://platform.sonilo.com/pricing"), mid)
            self.assertIn("ESTIMATE", p["note"], mid)
            self.assertIn("10-second billing floor", p["note"], mid)
            self.assertNotIn("variants", p, mid)

    def test_a_failed_task_is_never_stated_to_be_free(self):
        for mid in IDS:
            for note in [self.r[mid].raw["pricing"]["note"], *self.r[mid].raw["terms_notes"]]:
                low = note.lower()
                for bad in ("failed tasks are free", "failures are free", "is not billed", "are not billed"):
                    self.assertNotIn(bad, low, (mid, note))
                if "refunded" in low:           # the vendor's example may be quoted, but only AS an unverified example
                    self.assertIn("unverified", low, (mid, note))
            self.assertIn("is not stated", self.r[mid].raw["pricing"]["note"], mid)
        self.assertIn("unverified", sonilo.SPEND_UNKNOWN)
        self.assertTrue(sonilo.SPEND_UNKNOWN.startswith("SPEND UNKNOWN"))

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        a = sonilo.SoniloMusicAdapter
        m, v = self.r["sonilo-music"], self.r["sonilo-video-music"]
        self.assertEqual(m.durations_s, (10, 15, 20, 30, 45, 60, 90, 120))
        self.assertTrue(all(a.MIN_SECONDS <= d <= a.MAX_SECONDS for d in m.durations_s))
        self.assertEqual((a.MIN_SECONDS, a.MAX_SECONDS), (10, 360))      # Sonilo takes 5; it bills 10 at least
        self.assertEqual((v.durations_s, v.max_source_seconds), ((), 360))
        for e in (m, v):
            self.assertEqual((e.resolutions, e.aspect_ratios, e.image_refs_max, e.audio_out, e.max_prompt_chars,
                              e.max_concurrent_per_org), ((), (), 0, False, 2000, 1), e.id)

    def test_probes_are_servable_and_cheap(self):
        p = self.r["sonilo-music"].probe_request()
        self.assertEqual((p.capability, p.duration_s, bool(p.prompt), p.input_media), (MUSIC, 10, True, ()))
        p = self.r["sonilo-video-music"].probe_request(generated_video="probe_video.mp4")
        self.assertEqual((p.capability, p.duration_s, p.prompt, p.input_media), (VIDEO_MUSIC, None, "", ("probe_video.mp4",)))
        for mid in IDS:
            e = self.r[mid]
            self.assertEqual(ADAPTERS[e.adapter](env={}).problems(e.probe_request(generated_video="probe_video.mp4"), e), [], mid)

    def test_the_notes_say_what_is_sent_and_that_no_model_field_exists(self):
        for mid in IDS:
            note = self.r[mid].raw["api_documented"]["note"]
            for word in ("mode=async", "output_format=mp3", "variants_num=1", "No model field exists"):
                self.assertIn(word, note, (mid, word))


# ══ text-to-music: submit ═══════════════════════════════════════════════════════════════

class SubmitTests(Case):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", T2M, Resp(202, ACCEPTED))
        self.vendor.on("POST", V2M, Resp(202, ACCEPTED))

    def test_a_track_is_asked_for_as_an_async_mp3_of_one_variant_with_the_duration_given(self):
        task = self.adapter().submit(req(duration_s=45), "text-to-music")
        self.assertEqual((task.adapter, task.vendor_model, task.task_id), ("audio.sonilo", "text-to-music", TID))
        (r,) = self.vendor.requests
        self.assertEqual((r.method, r.path), ("POST", T2M))
        self.assertTrue(r.headers["content-type"].startswith("multipart/form-data"), r.headers["content-type"])
        self.assertEqual(r.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(r.headers["accept-encoding"], "identity")
        self.assertEqual({k: v[2].decode() for k, v in form(r).items()},
                         {"mode": "async", "output_format": "mp3", "variants_num": "1", "prompt": "a calm piano melody",
                          "duration": "45"})
        self.assertTrue(all(v[0] is None for v in form(r).values()))       # text fields only: nothing is uploaded

    def test_nothing_unpriced_or_unverified_is_ever_sent(self):
        self.adapter().submit(req(), "text-to-music")
        self.adapter().submit(self.vreq(prompt="warm strings"), "video-to-music")
        for r in self.vendor.requests:
            for name in ("video_url", "segments", "stems", "ducking", "preserve_speech", "prompt_influence"):
                self.assertNotIn(name, form(r), name)
            self.assertNotIn(KEY.encode(), r.body)
            self.assertNotIn(KEY, r.path)

    def test_the_duration_is_required_and_never_defaulted(self):
        # Left out, Sonilo infers a length from the prompt (90 s when it cannot): a price nobody quoted.
        for bad in (None, 0, 5, 9, 361, 3600, -30, True, "30", 10.5):
            with self.assertRaises(AdapterError, msg=repr(bad)) as cm:
                self.adapter().submit(req(duration_s=bad), "text-to-music")
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, repr(bad))
            self.assertTrue(cm.exception.not_accepted, repr(bad))
            self.assertIn("never defaulted", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_shortest_and_the_longest_track_are_the_billing_floor_and_the_vendors_cap(self):
        for d in (10, 360):
            self.vendor.requests.clear()
            self.adapter().submit(req(duration_s=d), "text-to-music")
            self.assertEqual(form(self.vendor.requests[0])["duration"][2], str(d).encode())

    def test_what_does_not_apply_to_a_track_from_words_is_refused_before_any_call(self):
        cases = {"prompt is empty": dict(prompt="   "), "no negative prompt": dict(negative_prompt="no drums"),
                 "a picture does not apply": dict(input_images=("x.png",)),
                 "a video does not apply": dict(input_media=(self.video(),))}
        for want, kw in cases.items():
            with self.assertRaises(AdapterError, msg=want) as cm:
                self.adapter().submit(req(**kw), "text-to-music")
            self.assertIn(want, cm.exception.message)
            self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_an_endpoint_is_never_used_for_the_other_capability(self):
        for request, vendor in ((req(), "video-to-music"), (self.vreq(), "text-to-music")):
            with self.assertRaises(AdapterError) as cm:
                self.adapter().submit(request, vendor)
            self.assertIn("does not do", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_no_key_is_a_refusal_before_any_call(self):
        with self.assertRaises(AdapterError) as cm:
            self.adapter(env={"SONILO_BASE_URL": self.vendor.base_url}).submit(req(), "text-to-music")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])

    def test_the_registry_entries_refuse_what_the_adapter_would_refuse(self):
        a, r = self.adapter(), reg.load()
        self.assertEqual(a.problems(req(duration_s=30), r["sonilo-music"]), [])
        self.assertTrue(a.problems(req(duration_s=5), r["sonilo-music"]))
        self.assertTrue(a.problems(req(duration_s=200), r["sonilo-music"]))       # Sonilo would; the registry does not offer it
        self.assertTrue(a.problems(req(prompt=""), r["sonilo-music"]))
        self.assertTrue(a.problems(req(prompt="x" * 2001), r["sonilo-music"]))
        self.assertTrue(a.problems(req(audio=True), r["sonilo-music"]))
        self.assertTrue(a.problems(req(capability=VIDEO_MUSIC), r["sonilo-music"]))
        self.assertEqual(a.problems(self.vreq(), r["sonilo-video-music"]), [])
        self.assertTrue(a.problems(self.vreq(duration_s=30), r["sonilo-video-music"]))
        self.assertTrue(a.problems(CapabilityRequest(VIDEO_MUSIC), r["sonilo-video-music"]))
        # what only the adapter knows (the registry entry has no field for it) is said before a job is started too
        self.assertIn("Sonilo takes no negative prompt", a.problems(req(negative_prompt="no drums"), r["sonilo-music"]))
        self.assertTrue(any("not a link" in p for p in a.problems(self.vreq("https://example.com/v.mp4"), r["sonilo-video-music"])))

    def test_an_override_of_the_api_host_that_is_not_https_is_ignored(self):
        a = build_adapter("audio.sonilo", env={"SONILO_API_KEY": KEY, "SONILO_BASE_URL": "http://localhost:1"})
        self.assertEqual(a.base_url, "https://api.sonilo.com")


# ══ video-to-music: the upload ═════════════════════════════════════════════════════════════

class VideoTests(Case):
    def setUp(self):
        super().setUp()
        self.vendor.on("POST", V2M, Resp(202, ACCEPTED))

    def refused(self, request, want=None):
        self.vendor.requests.clear()
        with self.assertRaises(AdapterError, msg=want) as cm:
            self.adapter().submit(request, "video-to-music")
        self.assertEqual(cm.exception.code, E_BAD_REQUEST, want)
        self.assertTrue(cm.exception.not_accepted, want)
        self.assertEqual(self.vendor.requests, [], want)
        if want:
            self.assertIn(want, cm.exception.message)

    def test_the_video_goes_up_as_a_file_under_a_fixed_name_never_the_uploaders(self):
        task = self.adapter().submit(self.vreq(self.video("my private holiday 2026.mp4")), "video-to-music")
        self.assertEqual(task.task_id, TID)
        (r,) = self.vendor.requests
        f = form(r)
        self.assertEqual(f["video"], ("source.mp4", "video/mp4", MP4))
        self.assertEqual({k: v[2].decode() for k, v in f.items() if k != "video"},
                         {"mode": "async", "output_format": "mp3", "variants_num": "1"})
        self.assertNotIn(b"holiday", r.body)
        self.assertEqual(r.headers["authorization"], f"Bearer {KEY}")

    def test_words_are_optional_and_sent_only_when_given(self):
        self.adapter().submit(self.vreq(prompt="  warm strings "), "video-to-music")
        self.assertEqual(form(self.vendor.requests[0])["prompt"][2], b"warm strings")

    def test_a_link_is_never_handed_to_the_vendor_to_fetch(self):
        for link in ("https://example.com/v.mp4", "http://169.254.169.254/latest/meta-data/x.mp4", "file:///etc/passwd.mp4",
                     "s3://bucket/v.mp4"):
            self.refused(self.vreq(link), "must be a local file, not a link")

    def test_a_duration_does_not_apply_the_music_is_as_long_as_the_video(self):
        self.refused(self.vreq(duration_s=30), "a duration does not apply")

    def test_exactly_one_video(self):
        self.refused(CapabilityRequest(VIDEO_MUSIC), "exactly one video")
        self.refused(CapabilityRequest(VIDEO_MUSIC, input_media=(self.video("a.mp4"), self.video("b.mp4"))), "exactly one video")
        self.refused(self.vreq(input_images=("x.png",)), "a picture does not apply")

    def test_a_file_that_only_wears_a_video_suffix_is_refused_and_nothing_is_sent(self):
        bodies = {"text": b"DB_PASSWORD=hunter2\n" * 20, "html": b"<html><body>login</body></html>" * 4,
                  "zip": b"PK\x03\x04" + b"\x00" * 64, "png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 64,
                  "mp3": MP3, "short": b"\x00\x00\x00\x18ftyp", "empty": b"",
                  "ftyp too late": b"\x00" * 5 + b"ftypmp42" + b"\x00" * 64}
        for kind, body in bodies.items():
            self.refused(self.vreq(self.video(f"{kind}.mp4", body)), "not an MP4 video")

    def test_an_audio_only_mp4_is_not_a_video(self):
        for brand in (b"M4A ", b"M4B "):
            self.refused(self.vreq(self.video("song.mp4", b"\x00\x00\x00\x18ftyp" + brand + b"\x00" * 64)), "audio-only MP4")

    def test_a_suffix_that_is_not_mp4_is_refused_before_the_file_is_opened(self):
        for name in ("notes.txt", "key.pem", "a.mov", "a.webm", "a.mkv", "a", ".env", "a.mp4.exe", "a.m4a"):
            with mock.patch("os.open", side_effect=AssertionError("opened")):
                self.refused(self.vreq(self.video(name)), "MP4 video only")

    def test_a_file_the_size_cap_forbids_is_refused_before_it_is_read(self):
        big = self.tmp / "big.mp4"
        with open(big, "wb") as fh:
            fh.write(MP4)
            fh.truncate(sonilo.SoniloMusicAdapter.MAX_VIDEO_BYTES + 1)            # sparse: no disk is used
        with mock.patch("os.fdopen", side_effect=AssertionError("read")):
            self.refused(self.vreq(str(big)), "over 300 MB")

    def test_a_file_that_grows_after_the_size_check_is_still_stopped_at_the_cap(self):
        a = self.adapter()
        a.MAX_VIDEO_BYTES = 64
        real = os.fstat

        class Small:
            def __init__(self, info):
                self.st_mode, self.st_size = info.st_mode, 10
        asked, real_fdopen = [], os.fdopen

        class Counting:
            def __init__(self, fh):
                self.fh = fh

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.fh.close()

            def read(self, n=-1):
                asked.append(n)
                return self.fh.read(n)
        with mock.patch("os.fstat", side_effect=lambda fd: Small(real(fd))), \
                mock.patch("os.fdopen", side_effect=lambda fd, mode: Counting(real_fdopen(fd, mode))):
            with self.assertRaises(AdapterError) as cm:
                a.submit(self.vreq(), "video-to-music")
        self.assertIn("the video is over", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])
        self.assertEqual(asked, [65])                       # never more than one byte past the cap is held in memory

    def test_what_is_not_a_regular_file_is_refused(self):
        folder = self.tmp / "dir.mp4"
        folder.mkdir()
        self.refused(self.vreq(str(folder)))
        self.refused(self.vreq(str(self.tmp / "missing.mp4")), "could not be read")
        fifo = self.tmp / "pipe.mp4"
        os.mkfifo(fifo)
        self.refused(self.vreq(str(fifo)), "not a regular file")                 # and the open did not block

    def test_the_adapter_sends_no_delete_at_all(self):
        # The API's ONLY delete revokes the calling key; nothing uploaded can be removed, and nothing here pretends to.
        self.vendor.on("GET", TASKS, [Resp(200, {"task_id": TID, "status": "processing"}),
                                      Resp(200, {"task_id": TID, "status": "failed", "error": {"code": "upstream_error"}})])
        a = self.adapter()
        task = a.submit(self.vreq(), "video-to-music")
        a.poll(task)
        a.poll(task)
        self.assertEqual({r.method for r in self.vendor.requests}, {"POST", "GET"})
        source = (ROOT / "modules" / "capabilities" / "sonilo.py").read_text()
        self.assertNotIn('"DELETE"', source)
        self.assertNotIn("keys/self\"", source)

    def test_the_bridge_hands_the_video_over_as_a_file_and_never_as_a_picture(self):
        entry = reg.get("sonilo-video-music")
        ra = ca.RegistryAdapter(entry, self.adapter(), sync_store={})
        request = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="video_music", model=entry.id, params={},
                                       input_files=(Path(self.video()),), quantity=42.0)
        self.assertEqual(ra.submit(request), TID)
        self.assertEqual(form(self.vendor.requests[0])["video"][2], MP4)
        usage = ra.usage(request, 1)
        self.assertEqual((usage.unit, usage.quantity, usage.provider), ("second", 42.0, "sonilo"))   # the video's seconds, as priced


# ══ a submit whose answer is lost ═════════════════════════════════════════════════════════

class LostAnswerTests(Case):
    def assertUnconfirmed(self, cm, code):
        self.assertEqual(cm.exception.code, code)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)

    def submit(self, resp, *, timeout=None, video=False):
        self.vendor._routes.clear()
        self.vendor.requests.clear()
        self.vendor.on("POST", V2M if video else T2M, resp)
        a = self.adapter()
        if timeout:
            a.timeout = a.upload_timeout = timeout
        return a.submit(self.vreq() if video else req(), "video-to-music" if video else "text-to-music")

    def test_a_dropped_connection_a_timeout_and_a_5xx_may_have_billed(self):
        for video in (False, True):
            for resp in (Resp(drop=True), Resp(502, {"code": "upstream_error", "message": "Upstream processing error. Please retry."}),
                         Resp(503, raw=b"<html>unavailable</html>"), Resp(202, ACCEPTED, hang_s=1.5)):
                with self.assertRaises(AdapterError) as cm:
                    self.submit(resp, timeout=0.4, video=video)
                self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_5xx_stays_unconfirmed_whatever_word_the_body_carries(self):
        # a gateway can answer 5xx in front of a Sonilo that already took the task: the status decides, not a vendor word
        for status in (500, 502, 503, 504):
            for code in ("rate_limit_exceeded", "insufficient_balance", "trial_exhausted", "auth_invalid", "not_found",
                         "unprocessable_entity"):
                with self.assertRaises(AdapterError, msg=(status, code)) as cm:
                    self.submit(Resp(status, {"code": code, "message": "x"}))
                self.assertUnconfirmed(cm, E_UNAVAILABLE)

    def test_a_2xx_without_a_usable_task_id_may_have_billed(self):
        for body in ({}, {"task_id": ""}, {"task_id": None}, {"task_id": 5}, {"task_id": "../x"}, {"task_id": "a/b"},
                     {"task_id": "a.b"}, {"task_id": "a:b"}, {"task_id": "a?b=c"}, {"task_id": "a b"}, {"task_id": "x" * 101},
                     {"task_id": ["a"]}, {"status": "processing"}, {"id": TID}, [], None, "ok"):
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.submit(Resp(202, body))
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_2xx_that_is_not_json_may_have_billed(self):
        # the second is what the vendor's DEFAULT mode answers: a stream of audio, generated and billed, that we asked not to get
        stream = b'{"type": "title", "title": "x"}\n{"type": "audio_chunk", "data": "AAAA"}\n{"type": "complete"}\n'
        for raw in (b"<html>ok</html>", stream, b""):
            with self.assertRaises(AdapterError, msg=raw[:20]) as cm:
                self.submit(Resp(200, raw=raw))
            self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_compressed_answer_was_not_asked_for_and_is_not_used(self):
        plain = json.dumps(ACCEPTED).encode()
        for coding in ("gzip", "deflate", "br", "zstd", "x-unknown"):
            with self.assertRaises(AdapterError, msg=coding) as cm:
                self.submit(Resp(202, raw=gzip.compress(plain) if coding == "gzip" else plain, headers={"Content-Encoding": coding}))
            # A real gzip body is decoded by the HTTP library and then refused here; a body that only claims a coding the
            # library knows fails inside the library. Either way it is a lost answer, never a task id.
            self.assertIn(cm.exception.code, (E_BAD_RESPONSE, E_UNAVAILABLE), coding)
            self.assertFalse(cm.exception.not_accepted, coding)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)
            if coding in ("gzip", "x-unknown"):
                self.assertUnconfirmed(cm, E_BAD_RESPONSE)
                self.assertIn("Content-Encoding", cm.exception.message)
        for header in ({"Content-Encoding": "identity"}, {}):
            self.assertEqual(self.submit(Resp(202, ACCEPTED, headers=header)).task_id, TID)

    def test_an_answer_too_large_to_be_a_task_is_not_parsed(self):
        with self.assertRaises(AdapterError) as cm:
            self.submit(Resp(202, {"task_id": TID, "pad": "x" * (sonilo.MAX_API_BYTES + 1)}))
        self.assertUnconfirmed(cm, E_BAD_RESPONSE)

    def test_a_refusal_the_status_proves_is_typed_and_is_proof(self):
        cases = ((401, "auth_invalid", E_AUTH, True), (401, None, E_AUTH, True), (403, "forbidden", E_AUTH, True),
                 (402, "insufficient_balance", E_QUOTA, True), (402, "trial_exhausted", E_QUOTA, True),
                 (402, "payment_required", E_QUOTA, True), (404, "not_found", E_NOT_FOUND, True),
                 (429, "rate_limit_exceeded", E_RATE_LIMITED, True),
                 (400, None, E_BAD_REQUEST, False), (413, None, E_BAD_REQUEST, False),
                 (422, "unprocessable_entity", E_BAD_REQUEST, False))
        for status, code, want, proof in cases:
            body = {"code": code, "message": f"m {KEY}"} if code else {"message": f"nope {KEY}"}
            with self.assertRaises(AdapterError, msg=(status, code)) as cm:
                self.submit(Resp(status, body))
            self.assertEqual((cm.exception.code, cm.exception.not_accepted, cm.exception.http_status), (want, proof, status),
                             (status, code))
            self.assertNotIn(UNCONFIRMED, cm.exception.message)
            self.assertNotIn(KEY, cm.exception.message)
            self.assertNotIn(KEY[:20], cm.exception.message)

    def test_both_429_messages_are_a_slow_down_not_an_empty_balance(self):
        for message in ("Rate limit exceeded: your account allows 60 requests per minute. Please retry after 1 minute.",
                        "Too many concurrent generations: 5 of 5 in progress. Please wait for one to finish before starting another."):
            with self.assertRaises(AdapterError) as cm:
                self.submit(Resp(429, {"code": "rate_limit_exceeded", "message": message}))
            self.assertEqual(cm.exception.code, E_RATE_LIMITED)

    def test_the_vendors_code_decides_not_a_word_in_its_sentence(self):
        # Sonilo's pages: "treat the code field as authoritative, not the message text". A slow-down that mentions a credit
        # limit is still a slow-down (retry later), and an unreadable file described as "prohibited" is still a bad request.
        for status, code, message, want in ((429, "rate_limit_exceeded", "Too many requests for your credit limit and balance", E_RATE_LIMITED),
                                            (422, "unprocessable_entity", "This container is prohibited by policy", E_BAD_REQUEST),
                                            (403, "forbidden", "Your billing plan does not include this endpoint", E_AUTH)):
            with self.assertRaises(AdapterError, msg=code) as cm:
                self.submit(Resp(status, {"code": code, "message": message}))
            self.assertEqual(cm.exception.code, want, code)

    def test_a_connection_that_never_opened_proves_nothing_was_bought(self):
        a = self.adapter(env={"SONILO_API_KEY": KEY, "SONILO_BASE_URL": closed_port_url()})
        with self.assertRaises(AdapterError) as cm:
            a.submit(req(), "text-to-music")
        self.assertTrue(cm.exception.not_accepted)
        self.assertNotIn(UNCONFIRMED, cm.exception.message)

    def test_a_second_call_is_never_made_after_a_lost_answer(self):
        for resp in (Resp(drop=True), Resp(502, {"code": "upstream_error", "message": "Please retry."}),
                     Resp(429, {"code": "rate_limit_exceeded", "message": "x"}, headers={"Retry-After": "1"})):
            with self.assertRaises(AdapterError):
                self.submit(resp)
            self.assertEqual(len(self.vendor.requests), 1)

    def test_the_creative_bridge_keeps_the_difference(self):
        entry = reg.get("sonilo-music")

        def bridged(env, **params):
            ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=self.vendor.session()), sync_store={})
            return ra.submit(cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="music", model=entry.id,
                                                  params=dict(prompt="a calm piano", **params), input_files=()))
        with self.assertRaises(ca.CreativeAdapterError) as cm:           # the job carries no duration: nothing was quoted
            bridged(self.env())
        self.assertIn("never defaulted", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])
        self.vendor.on("POST", T2M, [Resp(drop=True), Resp(402, {"code": "insufficient_balance", "message": "x"}),
                                     Resp(202, ACCEPTED)])
        with self.assertRaises(AdapterError) as lost:
            bridged(self.env(), duration_s=30)
        self.assertFalse(lost.exception.not_accepted)
        with self.assertRaises(AdapterError) as refused:
            bridged(self.env(), duration_s=30)
        self.assertTrue(refused.exception.not_accepted)
        self.assertEqual(bridged(self.env(), duration_s=30), TID)


# ══ poll ══════════════════════════════════════════════════════════════════════════════════

class PollTests(Case):
    def status(self, body, tid=TID, code=200, *, hosts=("localhost",), adapter=None, headers=None):
        self.vendor.requests.clear()
        self.vendor._routes.clear()
        self.vendor.on("GET", f"{TASKS}{tid}", Resp(code, body, headers=headers))
        return (adapter or self.adapter(hosts=hosts)).poll(ProviderTask("audio.sonilo", "text-to-music", tid))

    def link(self, name="track.mp3"):
        return f"{self.vendor.base_url}/{name}"

    def done(self, **kw):
        return {"task_id": TID, "type": "text_to_music", "status": "succeeded", "duration_seconds": 30.0,
                "audio": [{"url": self.link(), "content_type": "audio/mpeg", "file_size": 1200000, "stream_index": 0}], **kw}

    def test_processing_is_pending_and_the_key_goes_only_to_the_api(self):
        self.assertEqual(self.status({"task_id": TID, "status": "processing"}).state, PENDING)
        (r,) = self.vendor.requests
        self.assertEqual((r.method, r.path), ("GET", f"{TASKS}{TID}"))
        self.assertEqual(r.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(r.headers["accept-encoding"], "identity")

    def test_succeeded_hands_back_one_mp3_link(self):
        for word in ("succeeded", "SUCCEEDED", "completed"):       # the OpenAPI text names "completed" beside it
            res = self.status(self.done(status=word))
            self.assertEqual(res.state, SUCCEEDED, word)
            self.assertEqual([(o.mime, o.url, o.data) for o in res.outputs], [("audio/mpeg", self.link(), None)])

    def test_one_track_is_stored_when_several_parallel_streams_come_back(self):
        streams = [{"url": self.link("b.mp3"), "stream_index": 1}, {"url": self.link("a.mp3"), "stream_index": 0},
                   {"url": self.link("c.mp3"), "stream_index": 2}]
        res = self.status(self.done(audio=streams))
        self.assertEqual([o.url for o in res.outputs], [self.link("a.mp3")])
        # no stream says it is the first: the first usable entry, and never a boolean read as index 0
        res = self.status(self.done(audio=[{"url": self.link("x.mp3"), "stream_index": 3}, {"url": self.link("y.mp3"), "stream_index": False}]))
        self.assertEqual([o.url for o in res.outputs], [self.link("x.mp3")])
        res = self.status(self.done(audio={"url": self.link("solo.mp3")}))            # the single-object shape
        self.assertEqual([o.url for o in res.outputs], [self.link("solo.mp3")])

    def test_succeeded_without_a_link_may_have_billed_and_says_so(self):
        for audio in (None, [], [{}], [{"url": ""}], [{"url": None}], [{"url": 5}], "x", [None, "y"]):
            with self.assertRaises(AdapterError, msg=repr(audio)) as cm:
                self.status(self.done(audio=audio))
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)

    def test_with_no_host_pinned_every_link_is_refused_and_names_itself(self):
        self.assertEqual(sonilo.RESULT_HOSTS, ())
        for url, host in (("https://cdn.sonilo.com/a.mp3", "cdn.sonilo.com"), ("https://storage.googleapis.com/sonilo/a.mp3",
                          "storage.googleapis.com"), ("https://api.sonilo.com/v1/files/a.mp3", "api.sonilo.com"),
                          (self.link(), "localhost")):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status(self.done(audio=[{"url": url, "stream_index": 0}]), hosts=None)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)
            self.assertIn(repr(host), cm.exception.message)                 # the host a person will check and pin
        self.assertEqual(len(self.vendor.requests), 1)                       # the poll; no link was ever requested

    def test_a_link_that_is_not_a_plain_https_address_on_a_pinned_host_is_refused(self):
        port = self.vendor.port
        for url in (f"http://localhost:{port}/a.mp3", f"https://user:pw@localhost:{port}/a.mp3",
                    f"https://localhost.evil.example:{port}/a.mp3", f"https://evil.example\\@localhost:{port}/a.mp3",
                    f"https://localhost:{port + 1}/a.mp3", "file:///etc/passwd", "//localhost/a.mp3", f"https://127.0.0.1:{port}/a.mp3"):
            with self.assertRaises(AdapterError, msg=url) as cm:
                self.status(self.done(audio=[{"url": url, "stream_index": 0}]))
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), url)

    def test_a_file_the_task_itself_reports_as_too_large_is_not_downloaded(self):
        a = self.adapter()
        with self.assertRaises(AdapterError) as cm:
            self.status(self.done(audio=[{"url": self.link(), "stream_index": 0, "file_size": a.max_result_bytes + 1}]), adapter=a)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))
        self.assertIn("not downloaded", cm.exception.message)
        self.assertEqual(self.status(self.done(audio=[{"url": self.link(), "file_size": a.max_result_bytes}]), adapter=a).state, SUCCEEDED)
        self.assertEqual(a.max_result_bytes, 64 * 1024 * 1024)

    def test_a_failed_task_carries_the_vendors_code_the_right_remedy_and_the_spend_note(self):
        cases = (("upstream_error", E_UNAVAILABLE), ("insufficient_balance", E_QUOTA), ("trial_exhausted", E_QUOTA),
                 ("payment_required", E_QUOTA), ("rate_limit_exceeded", E_RATE_LIMITED), ("unprocessable_entity", E_BAD_REQUEST),
                 ("brand_new_code", E_UNAVAILABLE), ("", E_UNAVAILABLE))
        for code, want in cases:
            res = self.status({"task_id": TID, "status": "failed", "error": {"code": code, "message": f"went wrong {KEY}"}})
            self.assertEqual((res.state, res.error.code), (FAILED, want), code)
            self.assertIn(sonilo.SPEND_UNKNOWN, res.error.message)
            self.assertNotIn(KEY, res.error.message)
            self.assertNotIn("refunded (its statement", res.error.message)
        for body in ({"status": "failed"}, {"status": "failed", "error": "x"}, {"status": "failed", "error": None}):
            res = self.status(body)
            self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))
            self.assertIn(sonilo.SPEND_UNKNOWN, res.error.message)

    def test_refunded_is_quoted_as_sonilos_statement_only_when_the_task_says_it(self):
        said = "Sonilo's task record says refunded (its statement, unverified)"
        res = self.status({"status": "failed", "error": {"code": "upstream_error", "message": "x"}, "refunded": True})
        self.assertIn(said, res.error.message)
        self.assertIn(sonilo.SPEND_UNKNOWN, res.error.message)             # and it is still not called free
        for value in (False, None, "true", 1, "yes"):
            res = self.status({"status": "failed", "error": {"code": "upstream_error", "message": "x"}, "refunded": value})
            self.assertNotIn(said, res.error.message, repr(value))

    def test_a_cancelled_task_is_a_failure_with_the_spend_note(self):
        for word in ("canceled", "cancelled", "Canceled"):
            res = self.status({"task_id": TID, "status": word})
            self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE), word)
            self.assertIn("cancelled at Sonilo", res.error.message)
            self.assertIn(sonilo.SPEND_UNKNOWN, res.error.message)

    def test_any_status_the_pages_do_not_list_is_a_failure_not_a_task_still_running(self):
        a = self.adapter()
        for body in ({"status": "queued"}, {"status": "pending"}, {"status": "expired"}, {"status": "deleted"}, {"status": ""},
                     {"status": None}, {"status": 5}, {"status": ["processing"]}, {"status": True}, {}, [],
                     {"state": "processing"}, {"status": f"weird {KEY}"}):
            with self.assertLogs("modules.capabilities.sonilo", "WARNING") as logs:      # said once per poll, and never with a secret
                res = self.status(body, adapter=a)
            self.assertNotIn(KEY, " ".join(logs.output))
            self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE), repr(body))
            self.assertIn("does not know", res.error.message)
            self.assertIn(sonilo.SPEND_UNKNOWN, res.error.message)
            self.assertNotIn(KEY, res.error.message)
        self.assertEqual(sum(a.unknown_statuses.values()), 13)
        self.assertEqual(a.unknown_statuses["queued"], 1)
        self.assertGreaterEqual(a.unknown_statuses["(none)"], 4)
        self.assertGreaterEqual(a.unknown_statuses["(not text)"], 3)
        self.assertFalse(any(KEY in word for word in a.unknown_statuses))

    def test_a_task_id_that_could_steer_the_request_is_refused(self):
        for tid in ("", "../account/keys/self", "a/b", "a.b", "..", "a?x=1", "a#b", "a b", "a%2Fb", "x" * 101, "a:b", "a\nb",
                    "https://evil.example/x"):
            self.vendor.requests.clear()
            with self.assertRaises(AdapterError, msg=repr(tid)) as cm:
                self.adapter().poll(ProviderTask("audio.sonilo", "text-to-music", tid))
            self.assertEqual(cm.exception.code, E_NOT_FOUND)
            self.assertEqual(self.vendor.requests, [], repr(tid))
        with self.assertRaises(AdapterError):
            self.adapter().poll(ProviderTask("audio.sonilo", "text-to-music", None))

    def test_no_key_is_a_refusal_before_any_poll(self):
        self.vendor.on("GET", TASKS, Resp(200, {"status": "processing"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter(env={"SONILO_BASE_URL": self.vendor.base_url}).poll(ProviderTask("audio.sonilo", "text-to-music", TID))
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertEqual(self.vendor.requests, [])

    def test_an_http_error_while_polling_is_typed(self):
        for code, want in ((401, E_AUTH), (403, E_AUTH), (404, E_NOT_FOUND), (429, E_RATE_LIMITED), (500, E_UNAVAILABLE),
                           (502, E_UNAVAILABLE)):
            with self.assertRaises(AdapterError, msg=code) as cm:
                self.status({"code": "x", "message": f"nope {KEY}"}, code=code)
            self.assertEqual((cm.exception.code, cm.exception.http_status), (want, code))
            self.assertNotIn(KEY, cm.exception.message)

    def test_a_compressed_or_oversized_or_unreadable_poll_answer_is_not_used(self):
        self.vendor._routes.clear()
        self.vendor.on("GET", f"{TASKS}{TID}", Resp(200, raw=gzip.compress(json.dumps(self.done()).encode()),
                                                    headers={"Content-Encoding": "gzip"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().poll(ProviderTask("audio.sonilo", "text-to-music", TID))
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertIn("Content-Encoding", cm.exception.message)
        with self.assertRaises(AdapterError) as cm:
            self.status(self.done(pad="x" * (sonilo.MAX_API_BYTES + 1)))
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.vendor._routes.clear()
        self.vendor.on("GET", f"{TASKS}{TID}", Resp(200, raw=b"<html>sign in</html>"))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().poll(ProviderTask("audio.sonilo", "text-to-music", TID))
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)

    def test_the_length_sonilo_reports_is_kept_and_printed_by_the_probe(self):
        a = self.adapter()
        task = ProviderTask("audio.sonilo", "text-to-music", TID)
        self.assertEqual(a.probe_note(task), "Sonilo reported no duration")
        self.status(self.done(duration_seconds=10.0, audio=[{"url": self.link("a.mp3")}, {"url": self.link("b.mp3")}]), adapter=a)
        note = a.probe_note(task)
        self.assertIn("duration_seconds 10.0 and 2 audio stream(s)", note)
        self.assertIn("10 s at least", note)
        self.status(self.done(duration_seconds=True), adapter=a)                       # a boolean is not a length
        self.assertIn("duration_seconds (none)", a.probe_note(task))
        for i in range(sonilo._KEEP + 5):
            a._remember(f"t{i}", (1.0, 1))
        self.assertEqual(len(a.reported), sonilo._KEEP)


# ══ redirects, the attacker's host, and the download ════════════════════════════════════════

class RedirectAndDownloadTests(Case):
    def setUp(self):
        super().setUp()
        self.attacker = FakeVendor()
        self.addCleanup(self.attacker.close)
        self.attacker.on("GET", "/", Resp(200, raw=MP3))
        self.attacker.on("POST", "/", Resp(202, {"task_id": "stolen", "status": "processing"}))

    def test_the_adapter_says_it_follows_no_redirect(self):
        self.assertIs(sonilo.SoniloMusicAdapter.follow_redirects, False)

    def test_the_submit_call_does_not_follow_a_redirect(self):
        for path, request, vendor in ((T2M, req(), "text-to-music"), (V2M, self.vreq(), "video-to-music")):
            self.vendor.on("POST", path, Resp(307, headers={"Location": f"{self.attacker.base_url}/steal"}))
            with self.assertRaises(AdapterError) as cm:
                self.adapter().submit(request, vendor)
            self.assertIn("307", cm.exception.message)
        self.assertEqual(self.attacker.requests, [])

    def test_the_poll_call_does_not_follow_a_redirect(self):
        self.vendor.on("GET", f"{TASKS}{TID}", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().poll(ProviderTask("audio.sonilo", "text-to-music", TID))
        self.assertIn("302", cm.exception.message)
        self.assertEqual(self.attacker.requests, [])

    def test_control_the_same_redirect_WOULD_reach_the_other_host_if_it_were_followed(self):
        self.vendor.on("GET", f"{TASKS}{TID}", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        a = self.adapter()
        a.follow_redirects = True
        try:
            a.poll(ProviderTask("audio.sonilo", "text-to-music", TID))
        except AdapterError:
            pass                                                       # the other host's answer is no task: not the point
        self.assertEqual([r.path for r in self.attacker.requests], ["/steal"])

    def test_a_result_link_on_another_host_gets_no_request_at_all(self):
        # the attacker listens on localhost too: with localhost pinned, only the PORT tells the two apart
        stolen = f"{self.attacker.base_url}/track.mp3"
        self.vendor.on("GET", f"{TASKS}{TID}", Resp(200, {"status": "succeeded", "audio": [{"url": stolen, "stream_index": 0}]}))
        for hosts in (None, ("localhost",)):
            a = self.adapter(hosts=hosts)
            with self.assertRaises(AdapterError) as cm:
                a.poll(ProviderTask("audio.sonilo", "text-to-music", TID))
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))
            with self.assertRaises(AdapterError):
                a.fetch(track(stolen), self.tmp, "stolen")
        self.assertEqual(self.attacker.requests, [])
        self.assertEqual(list(self.tmp.glob("stolen*")), [])

    def test_the_download_sends_no_key_and_follows_no_redirect(self):
        self.vendor.on("GET", "/track.mp3", Resp(200, raw=MP3))
        a = self.adapter()
        (path,) = a.fetch(track(self.vendor.base_url + "/track.mp3"), self.tmp, "track")
        self.assertEqual((path.name, path.read_bytes()), ("track_0.mp3", MP3))
        (r,) = self.vendor.seen("GET", "/track.mp3")
        self.assertNotIn("authorization", r.headers)
        self.assertNotIn(KEY, str(r.headers))
        self.vendor.on("GET", "/moved.mp3", Resp(302, headers={"Location": f"{self.attacker.base_url}/steal"}))
        with self.assertRaises(AdapterError) as cm:
            a.fetch(track(self.vendor.base_url + "/moved.mp3"), self.tmp, "moved")
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)
        self.assertEqual(self.attacker.requests, [])
        self.assertEqual(list(self.tmp.glob("moved*")), [])

    def test_a_result_route_that_wants_the_key_fails_closed_with_the_spend_note(self):
        # The pages do not say whether a result link needs the key. It is never sent; a 401 / 403 is an expired-or-gone link.
        for status in (401, 403, 404, 410):
            self.vendor._routes.clear()
            self.vendor.requests.clear()
            self.vendor.on("GET", "/gone.mp3", Resp(status, {"message": "Invalid API key"}))
            with self.assertRaises(AdapterError) as cm:
                self.adapter().fetch(track(self.vendor.base_url + "/gone.mp3"), self.tmp, "gone")
            self.assertEqual(cm.exception.code, E_NOT_FOUND, status)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION))
            self.assertNotIn("authorization", self.vendor.requests[0].headers)

    def test_only_an_mp3_is_stored_as_a_track(self):
        self.vendor.on("GET", "/bare.mp3", Resp(200, raw=MP3_BARE))
        (path,) = self.adapter().fetch(track(self.vendor.base_url + "/bare.mp3"), self.tmp, "bare")
        self.assertEqual(path.read_bytes(), MP3_BARE)
        strangers = {"html": b"<html>login</html>" * 50, "mp4": MP4, "jpeg": b"\xff\xd8\xff\xe0" + b"\x00" * 512,
                     "aac": b"\xff\xf1\x50\x80" + b"\x00" * 512, "wav": b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 512,
                     "json": json.dumps({"code": "not_found"}).encode() * 20, "zeros": b"\x00" * 512}
        for kind, body in strangers.items():
            self.vendor.on("GET", f"/{kind}.mp3", Resp(200, raw=body))
            with self.assertRaises(AdapterError, msg=kind) as cm:
                self.adapter().fetch(track(f"{self.vendor.base_url}/{kind}.mp3"), self.tmp, kind)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), kind)
            self.assertIn("not a audio/mpeg file", cm.exception.message)
            self.assertEqual(list(self.tmp.glob(f"{kind}*")), [], kind)

    def test_a_track_over_the_cap_is_not_stored_whether_or_not_its_size_is_announced(self):
        a = self.adapter()
        a.max_result_bytes = 4096
        self.vendor.on("GET", "/announced.mp3", Resp(200, raw=MP3 + b"\x00" * 8192))
        self.vendor.on("GET", "/streamed.mp3", Resp(200, chunks=[MP3, b"\x00" * 4096, b"\x00" * 4096]))
        self.vendor.on("GET", "/cut.mp3", Resp(200, raw=MP3, declared_length=len(MP3) + 500))
        self.vendor.on("GET", "/empty.mp3", Resp(200, raw=b""))
        for name in ("announced", "streamed", "cut", "empty"):
            with self.assertRaises(AdapterError, msg=name) as cm:
                a.fetch(track(f"{self.vendor.base_url}/{name}.mp3"), self.tmp, name)
            self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), name)
            self.assertEqual(list(self.tmp.glob(f"{name}*")), [], name)


class Mp3SniffTests(unittest.TestCase):
    def test_what_an_mp3_starts_with(self):
        for head in (b"ID3\x04\x00\x00\x00\x00\x00\x0a", b"\xff\xfb\x90\x64", b"\xff\xf3\x90\x64", b"\xff\xf2\x90\x64",
                     b"\xff\xfa\x90\x64", b"\xff\xe3\x18\xc4"):
            self.assertTrue(_looks_like("audio/mpeg", head), head)

    def test_what_is_not_one(self):
        for head in (b"", b"\xff", b"\xff\xd8\xff\xe0", b"\xff\xf1\x50\x80", b"\xff\xf9\x50\x80", b"\x00\x00\x00\x18ftypM4A ",
                     b"RIFF\x00\x00\x00\x00WAVE", b"fLaC", b"OggS", b"<html>", b"{\"code\"", b"id3\x04", b"\xfe\xfb\x90\x64",
                     b"\xff\x02\x00\x00", b"\xff\x1e\x00\x00", b"\xff\xc2\x00\x00"):     # an FF byte without the frame sync
            self.assertFalse(_looks_like("audio/mpeg", head), head)


# ══ end to end through the probe ════════════════════════════════════════════════════════════

class EndToEndTests(Case):
    def run_probe(self, polls, *, entry_id="sonilo-music", hosts=("localhost",), timeout_s=600):
        from tools.probe_models import run_probe

        self.vendor.on("POST", T2M, Resp(202, ACCEPTED))
        self.vendor.on("POST", V2M, Resp(202, ACCEPTED))
        self.vendor.on("GET", f"{TASKS}{TID}", polls)
        self.vendor.on("GET", "/track.mp3", Resp(200, raw=MP3))
        clock = {"t": 0.0}
        with mock.patch.object(sonilo.SoniloMusicAdapter, "result_hosts", hosts), \
                mock.patch.object(sonilo.SoniloMusicAdapter, "result_ports", (None, 443, self.vendor.port)):
            return run_probe(reg.get(entry_id), env=self.env(), voice_id=None, workdir=self.tmp, timeout_s=timeout_s,
                             poll_every_s=5, session=self.vendor.session(),
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), clock=lambda: clock["t"])

    def done(self, url=None):
        return Resp(200, {"task_id": TID, "status": "succeeded", "duration_seconds": 10.0,
                          "audio": [{"url": url or f"{self.vendor.base_url}/track.mp3", "content_type": "audio/mpeg",
                                     "file_size": len(MP3), "stream_index": 0}]})

    def test_the_music_probe_runs_the_whole_chain_and_stores_a_real_track(self):
        res = self.run_probe([Resp(200, {"task_id": TID, "status": "processing"}), self.done()])
        self.assertTrue(res.ok, res.message)
        self.assertEqual((res.output_bytes, res.task_id), (len(MP3), TID))
        self.assertIn("duration_seconds 10.0", res.note)
        self.assertEqual(form(self.vendor.seen("POST", T2M)[0])["duration"][2], b"10")       # the billing floor, the cheapest call
        self.assertEqual(len(self.vendor.seen("POST", T2M)), 1)
        self.assertEqual((self.tmp / "sonilo-music_0.mp3").read_bytes(), MP3)

    def test_the_video_probe_uploads_the_drawn_test_pattern(self):
        res = self.run_probe([self.done()], entry_id="sonilo-video-music")
        self.assertTrue(res.ok, res.message)
        (r,) = self.vendor.seen("POST", V2M)
        name, ctype, body = form(r)["video"]
        self.assertEqual((name, ctype, body[4:8]), ("source.mp4", "video/mp4", b"ftyp"))
        self.assertNotIn("prompt", form(r))
        self.assertNotIn("duration", form(r))

    def test_as_shipped_the_first_probe_fails_closed_and_names_the_host_to_pin(self):
        res = self.run_probe([self.done()], hosts=())
        self.assertEqual((res.ok, res.code, res.task_id), (False, E_BAD_RESPONSE, TID))
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)
        self.assertIn("'localhost'", res.message)
        self.assertEqual(self.vendor.seen("GET", "/track.mp3"), [])
        self.assertEqual(list(self.tmp.glob("*.mp3")), [])

    def test_a_task_that_never_finishes_ends_as_a_timeout_that_names_the_task(self):
        res = self.run_probe([Resp(200, {"task_id": TID, "status": "processing"})], timeout_s=30)
        self.assertEqual((res.ok, res.code, res.task_id), (False, "timeout", TID))

    def test_an_expired_link_is_not_an_auth_error_and_says_the_spend_may_have_happened(self):
        self.vendor.on("GET", "/expired.mp3", Resp(403, {"error": "expired"}))
        res = self.run_probe([self.done(f"{self.vendor.base_url}/expired.mp3")])
        self.assertEqual((res.ok, res.code), (False, E_NOT_FOUND))
        self.assertTrue(res.message.startswith(AFTER_COMPLETION), res.message)


class ProbeVideoTests(unittest.TestCase):
    """The probe's drawn video is made with the ffmpeg the rest of the code renders with. A PATH lookup alone skipped every
    probe that starts from a video on the CI runner and the worker image, which carry the pinned imageio-ffmpeg binary only."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sonilo_probe_video_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def test_the_pinned_binary_draws_it_with_nothing_on_path(self):
        from modules import render_backend
        from tools.probe_models import probe_video

        exe = render_backend.resolve_ffmpeg()
        if os.sep not in exe:
            self.skipTest("imageio-ffmpeg is not installed here")
        with mock.patch.dict(os.environ, {"PATH": str(self.tmp)}):
            clip = probe_video(self.tmp / "probe.mp4")
        self.assertEqual(clip.read_bytes()[4:8], b"ftyp")

    def test_the_resolvers_answer_is_what_runs(self):
        from tools import probe_models

        fake = self.tmp / "ffmpeg-pinned"
        fake.write_text("#!/bin/sh\n")
        fake.chmod(0o755)
        ran = []

        def runner(cmd, **kw):
            ran.append(cmd[0])
            Path(cmd[-1]).write_bytes(MP4)
        with mock.patch("modules.render_backend.resolve_ffmpeg", return_value=str(fake)), \
                mock.patch("shutil.which", side_effect=AssertionError("PATH must not decide")):
            probe_models.probe_video(self.tmp / "v.mp4", runner=runner)
        self.assertEqual(ran, [str(fake)])

    def test_no_ffmpeg_at_all_is_our_setup_never_the_vendors_answer(self):
        from tools import probe_models

        for answer in (str(self.tmp / "missing-ffmpeg"), "ffmpeg"):
            with mock.patch("modules.render_backend.resolve_ffmpeg", return_value=answer), \
                    mock.patch.dict(os.environ, {"PATH": str(self.tmp)}):
                with self.assertRaises(AdapterError, msg=answer) as cm:
                    probe_models.probe_video(self.tmp / "v.mp4", runner=lambda *a, **k: self.fail("ran"))
            self.assertEqual(cm.exception.code, E_NOT_CONFIGURED, answer)
            self.assertIn("a probe that starts from a video needs ffmpeg", cm.exception.message)
            self.assertNotIn("upscale", cm.exception.message)


# ══ wiring ═════════════════════════════════════════════════════════════════════════════════

class WiringTests(unittest.TestCase):
    def test_the_adapter_is_wired_the_way_a_header_key_adapter_must_be(self):
        a = sonilo.SoniloMusicAdapter
        self.assertEqual((a.key, a.key_env, a.base_url_env, a.default_base_url),
                         ("audio.sonilo", ("SONILO_API_KEY",), "SONILO_BASE_URL", "https://api.sonilo.com"))
        self.assertEqual((a.result_hosts, a.result_ports), ((), (None, 443)))      # no host is known: none is allowed
        self.assertIs(a.follow_redirects, False)
        self.assertEqual(a.capabilities, (MUSIC, VIDEO_MUSIC))
        self.assertEqual(a(env={"SONILO_API_KEY": KEY}).auth_headers(), {"Authorization": f"Bearer {KEY}"})
        self.assertEqual((a.audio_capabilities, a.resolution_capabilities, a.reference_capabilities), ((), (), ()))
        self.assertEqual(a.MAX_VIDEO_BYTES, 300 * 1024 * 1024)
        self.assertEqual((sonilo.OUTPUT_FORMAT, sonilo.RESULT_MIME), ("mp3", "audio/mpeg"))

    def test_the_new_key_is_one_the_worker_the_probe_workflow_and_the_doctor_can_be_given(self):
        example = (ROOT / "deploy" / ".env.worker.example").read_text()
        deploy = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text()
        probe = (ROOT / ".github" / "workflows" / "probe_models.yml").read_text()
        doctor = (ROOT / "tools" / "doctor.py").read_text()
        name = "SONILO_API_KEY"
        self.assertRegex(example, rf"(?m)^{name}=$")                       # empty in the example, never a value
        self.assertIn(f"WORKERENV_{name}: ${{{{ secrets.{name} }}}}", deploy)
        self.assertIn(f"{name}: ${{{{ secrets.{name} }}}}", probe)
        self.assertIn(f'"{name}"', doctor)
        self.assertIn(f'("{name}", "sonilo")', doctor)

    def test_the_key_page_checks_the_key_with_the_free_account_read_and_nothing_that_generates(self):
        text = (ROOT / "command-center" / "lib" / "model-keys.ts").read_text()
        i = text.index('id: "sonilo"')
        card = text[i:text.index("\n  },\n", i)]
        self.assertIn('envSets: [["SONILO_API_KEY"]]', card)
        self.assertIn('origin: "https://api.sonilo.com"', card)
        self.assertIn('path: "/v1/account/services"', card)
        self.assertIn("rejectStatuses: [401]", card)                # a 403 is a valid key without endpoint access
        self.assertIn('name: "available_services"', card)
        self.assertNotIn("music\"", card.split("strategy")[1])      # never a generation path

    def test_no_probe_is_ever_run_on_them_named_or_not(self):
        from tools import probe_models

        entries = list(reg.registry().values())
        self.assertFalse({e.id for e in probe_models.select(entries, [], None, True)} & set(IDS))
        for mid in IDS:
            self.assertNotIn(mid, {e.id for e in probe_models.select(entries, [mid], None, True)})
            self.assertEqual(probe_models.select(entries, [mid], None, False), [])
            self.assertIn(mid, {e.id for e in probe_models.gated_left_out(entries, [], None, True)})      # --all says "gated"
            self.assertEqual([e.id for e in probe_models.registry_only_left_out(entries, [mid], None)], [mid])
        self.assertEqual(probe_models.registry_only_left_out(entries, [], None), [])
        self.assertEqual(probe_models.registry_only_left_out(entries, list(IDS), "sfx"), [])
        for cap in ("music", "video_music", "sfx", "tts"):
            self.assertFalse({e.id for e in probe_models.select(entries, list(IDS), cap, True)} & set(IDS), cap)

    def test_a_named_probe_spends_nothing_records_nothing_and_says_why(self):
        from tools import probe_models

        for argv, want in ((["--model", "sonilo-music"], "SKIP sonilo-music: registry-only"),
                           (["--model", "sonilo-video-music", "--brief"], "skipped sonilo-video-music"),
                           (["--all", "--brief"], "gated sonilo-music")):
            out, db = io.StringIO(), mock.Mock()
            db.record.return_value, db.sync.return_value = 1, 0
            called = []

            def fake_probe(entry, **kw):
                called.append(entry.id)
                return probe_models.ProbeResult(entry.id, True, latency_ms=1, output_bytes=1)
            env = {name: "k" * 24 for cls in ADAPTERS.values() for name in cls.key_env}
            with mock.patch.object(probe_models, "run_probe", side_effect=fake_probe), \
                    mock.patch("requests.Session.request", side_effect=AssertionError("network")):
                probe_models.main(argv, env=env, db=db, stream=out)
            self.assertIn(want, out.getvalue(), argv)
            self.assertFalse(set(called) & set(IDS), argv)
            self.assertFalse([c for c in db.record.call_args_list if c.kwargs.get("model") in IDS], argv)

    def test_a_sync_sends_no_row_for_them(self):
        from tools import probe_models

        db, out = mock.Mock(), io.StringIO()
        db.sync.return_value = 80
        probe_models.main(["--sync"], env={}, db=db, stream=out)
        (rows,), _ = db.sync.call_args
        self.assertFalse({row["id"] for row in rows} & set(IDS))
        self.assertFalse([row["id"] for row in rows if set(row["capabilities"]) & REGISTRY_ONLY_CAPABILITIES])

    def test_the_worker_gets_no_adapter_for_them(self):
        # No job can name one through the database; a row that names one all the same is not served.
        for mid in IDS:
            self.assertIsNone(ca.resolve(mid, env={"SONILO_API_KEY": KEY}), mid)
        self.assertIsNotNone(ca.resolve("pika-2.5", env={}))                 # control: a gated entry the database knows
        self.assertIsNone(ca.resolve("no-such-model", env={}))

    def test_none_of_them_is_sellable(self):
        sellable = {e.id for e in reg.registry().values() if not e.terms_gate}
        self.assertFalse(sellable & set(IDS))


if __name__ == "__main__":
    unittest.main()
