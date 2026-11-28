"""tools/export_showcase.py: what may become a public model sample, and what the workflow hands to the job that can push.

Every refusal here is a way a sample could have lied on the public site: a customer's work shown as ours, a failed job, a
stock photograph (or anyone's upload) animated and called our model's, a file that is not the one the job stored, the same
job twice, a cost of "0" that was never measured. Runs under both ``python -m pytest`` and ``python -m unittest``.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

import yaml

from tools import export_showcase as x

OP = x.OPERATOR_ORG
CUSTOMER = "11111111-2222-4333-8444-555555555555"
JOB = "0b0b0b0b-1111-4222-8333-444455556666"
OUT = "0c0c0c0c-1111-4222-8333-444455556666"
SRC = "0d0d0d0d-1111-4222-8333-444455556666"
PARENT_JOB = "0e0e0e0e-1111-4222-8333-444455556666"
BYTES = b"\x00\x00\x00\x18ftypmp42 a real clip"
SHA = hashlib.sha256(BYTES).hexdigest()
ART = {hashlib.sha256(b"site art").hexdigest(): "step-1.webp"}
STOCK = {hashlib.sha256(b"pexels photo").hexdigest(): "coast.webp"}
REGISTRY = x.load_registry()


def job(**over):
    j = {
        "id": JOB, "org_id": OP, "kind": "generate", "capability": "i2v", "status": "completed",
        "requested_model": "runway-gen4.5", "routed_model": None,
        "params": {"prompt": "the lanterns drift up", "source_asset_id": SRC},
        "result": {"storage": "library"}, "result_asset_ids": [OUT], "created_at": "2026-11-12T09:30:00+00:00",
    }
    j.update(over)
    return j


def asset(aid, **over):
    a = {
        "id": aid, "org_id": OP, "kind": "video", "mime": "video/mp4", "sha256": SHA, "source": "generated",
        "provenance": {"job_id": JOB}, "width": 1280, "height": 720, "duration_s": 5, "bytes": len(BYTES),
        "deleted_at": None, "purged_at": None,
    }
    a.update(over)
    return a


class FakeRest:
    def __init__(self, jobs=(), assets=(), costs=None):
        self.jobs = {j["id"]: j for j in jobs}
        self.assets = {a["id"]: a for a in assets}
        self.cost_rows = costs if costs is not None else [
            {"provider": "runway", "vendor_model": "gen4.5", "unit": "credits", "quantity": 60, "usd_estimate": 0.6, "price_source": "runway list price 2026-11"},
        ]
        self.session = None

    def job(self, job_id):
        return self.jobs.get(job_id)

    def asset(self, asset_id):
        return self.assets.get(asset_id)

    def costs(self, job_id):
        return self.cost_rows


def art_upload():
    return asset(SRC, kind="image", mime="image/webp", source="upload", sha256=next(iter(ART)), provenance={})


def world(**over):
    """The happy case: an operator i2v job animating the site's own AI art."""
    return FakeRest(jobs=[job(**over)], assets=[asset(OUT), art_upload()])


def plan(rest, existing=(), today=date(2026, 11, 13)):
    return x.plan_export(rest, JOB, registry=REGISTRY, art=ART, stock=STOCK, existing=list(existing), today=today)


class JobIdTest(unittest.TestCase):
    def test_only_a_uuid_is_a_job_id(self):
        for bad in ("", "  ", "abc", JOB + "0", JOB[:-1], f"{JOB}; drop table x", "../" + JOB, None, 42):
            with self.subTest(bad=bad), self.assertRaises(x.Refusal) as cm:
                x.parse_job_id(bad)
            self.assertEqual(cm.exception.code, "bad_job_id")

    def test_case_and_surrounding_space_do_not_matter(self):
        self.assertEqual(x.parse_job_id(f"  {JOB.upper()}\n"), JOB)


class RefusalsTest(unittest.TestCase):
    def refused(self, rest, code, existing=()):
        with self.assertRaises(x.Refusal) as cm:
            plan(rest, existing)
        self.assertEqual(cm.exception.code, code)

    def test_the_happy_case_names_the_model_its_attribution_and_the_art_it_started_from(self):
        p = plan(world())
        self.assertEqual(p["modelId"], "runway-gen4.5")
        self.assertEqual(p["modelName"], REGISTRY["runway-gen4.5"]["display_name"])
        self.assertEqual(p["attribution"], {"text": "Powered by Runway", "url": "https://runway.com"})
        self.assertEqual(p["input"], {"kind": "site_art", "file": "step-1.webp", "sha256": next(iter(ART))})
        self.assertEqual(p["prompt"], "the lanterns drift up")
        self.assertEqual(p["createdAt"], "2026-11-12T09:30:00Z")
        # Runway's models are operator previews: the card will say "coming" and the link will not name the model.
        self.assertIs(p["operatorPreview"], True)
        self.assertIsNone(p["shutdownOn"])

    def test_a_customers_job_is_never_ours_to_show(self):
        self.refused(world(org_id=CUSTOMER), "not_operator_org")

    def test_only_a_completed_job(self):
        for status in ("failed", "running", "queued", "cancelled", "expired", "provider_pending"):
            with self.subTest(status=status):
                self.refused(world(status=status), "not_succeeded")

    def test_a_missing_job(self):
        self.refused(FakeRest(), "job_not_found")

    def test_a_model_past_its_announced_shutdown_is_refused_from_that_day(self):
        # openai-gpt-image-2: shutdown.on 2027-02-10 in the registry, no terms gate.
        self.assertEqual(REGISTRY["openai-gpt-image-2"]["shutdown"]["on"], "2027-02-10")
        before = plan(world(requested_model="openai-gpt-image-2"), today=date(2027, 2, 9))
        self.assertIs(before["operatorPreview"], False)
        # Recorded, so the site's card stops naming the model from that day (lib/site/showcase.ts modelLeftOut).
        self.assertEqual(before["shutdownOn"], "2027-02-10")
        with self.assertRaises(x.Refusal) as cm:
            plan(world(requested_model="openai-gpt-image-2"), today=date(2027, 2, 10))
        self.assertEqual(cm.exception.code, "model_shut_down")

    def test_a_model_whose_vendor_terms_are_not_cleared_is_refused(self):
        for model in ("kling-v3", "seedance-2.0", "elevenlabs-v3"):
            with self.subTest(model=model):
                self.assertTrue(REGISTRY[model].get("terms_gate"))
                self.refused(world(requested_model=model), "model_terms_not_cleared")

    def test_a_prompt_the_site_would_drop_is_refused_not_cut(self):
        # 2001 lanterns: 2001 characters to the database, 4002 to the page's parser (UTF-16), which would drop the entry unseen.
        self.refused(world(params={"prompt": chr(0x1F3EE) * 2001, "source_asset_id": SRC}), "entry_invalid")
        self.assertEqual(len(plan(world(params={"prompt": "a" * 4000, "source_asset_id": SRC}))["prompt"]), 4000)

    def test_a_model_the_registry_does_not_list(self):
        self.refused(world(requested_model="made-up-model"), "unknown_model")

    def test_the_routed_model_is_the_one_named_when_the_job_ran_on_auto(self):
        self.assertEqual(plan(world(requested_model="auto", routed_model="runway-gen4-turbo"))["modelId"], "runway-gen4-turbo")

    def test_a_style_kit_whose_references_cannot_be_vouched_for(self):
        self.refused(world(params={"prompt": "x", "source_asset_id": SRC, "style_kit_id": PARENT_JOB}), "style_kit_used")

    def test_an_output_that_never_reached_the_library(self):
        self.refused(world(result_asset_ids=[]), "output_not_in_library")

    def test_an_output_another_job_made(self):
        rest = FakeRest(jobs=[job()], assets=[asset(OUT, provenance={"job_id": PARENT_JOB}), art_upload()])
        self.refused(rest, "output_mismatch")

    def test_a_deleted_output(self):
        rest = FakeRest(jobs=[job()], assets=[asset(OUT, deleted_at="2026-11-12T10:00:00Z"), art_upload()])
        self.refused(rest, "output_deleted")

    def test_a_stock_photograph_animated_is_refused(self):
        stock = asset(SRC, kind="image", mime="image/jpeg", source="upload", sha256=next(iter(STOCK)), provenance={})
        self.refused(FakeRest(jobs=[job()], assets=[asset(OUT), stock]), "input_is_stock")

    def test_any_other_upload_is_refused(self):
        upload = asset(SRC, kind="image", mime="image/jpeg", source="upload", sha256="f" * 64, provenance={})
        self.refused(FakeRest(jobs=[job()], assets=[asset(OUT), upload]), "input_is_upload")

    def test_a_pipeline_frame_or_a_render_is_not_ours_either(self):
        for source in ("pipeline", "render"):
            with self.subTest(source=source):
                other = asset(SRC, kind="image", mime="image/jpeg", source=source, sha256="e" * 64, provenance={})
                self.refused(FakeRest(jobs=[job()], assets=[asset(OUT), other]), "input_not_ours")

    def test_a_customers_picture_as_the_input(self):
        theirs = asset(SRC, org_id=CUSTOMER, kind="image", mime="image/png", provenance={"job_id": PARENT_JOB})
        self.refused(FakeRest(jobs=[job()], assets=[asset(OUT), theirs]), "input_not_operator")

    def test_an_input_made_by_another_operator_job_is_followed_back_to_its_own_first_picture(self):
        made = asset(SRC, kind="image", mime="image/png", provenance={"job_id": PARENT_JOB})
        parent_ok = job(id=PARENT_JOB, capability="t2i", params={"prompt": "a lantern"}, result_asset_ids=[SRC])
        p = plan(FakeRest(jobs=[job(), parent_ok], assets=[asset(OUT), made]))
        self.assertEqual(p["input"], {"kind": "operator_job", "jobId": PARENT_JOB, "assetId": SRC})
        # ...and an edit of a stock photograph two steps back is still a stock photograph.
        stock_id = "0f0f0f0f-1111-4222-8333-444455556666"
        parent_edit = job(id=PARENT_JOB, capability="edit", params={"prompt": "warmer", "source_asset_id": stock_id}, result_asset_ids=[SRC])
        stock = asset(stock_id, kind="image", mime="image/jpeg", source="upload", sha256=next(iter(STOCK)), provenance={})
        self.refused(FakeRest(jobs=[job(), parent_edit], assets=[asset(OUT), made, stock]), "input_is_stock")

    def test_an_end_frame_is_checked_like_the_input(self):
        end_id = "0a0a0a0a-1111-4222-8333-444455556666"
        upload = asset(end_id, kind="image", mime="image/jpeg", source="upload", sha256="d" * 64, provenance={})
        rest = FakeRest(jobs=[job(params={"prompt": "x", "source_asset_id": SRC, "end_asset_id": end_id})], assets=[asset(OUT), art_upload(), upload])
        self.refused(rest, "input_is_upload")

    def test_the_same_job_twice_is_a_no_op_not_a_duplicate(self):
        with self.assertRaises(x.AlreadyThere):
            plan(world(), existing=[{"jobId": JOB}])

    def test_a_clip_too_long_for_a_landing_page(self):
        rest = FakeRest(jobs=[job()], assets=[asset(OUT, duration_s=120), art_upload()])
        self.refused(rest, "clip_too_long")


class TextTest(unittest.TestCase):
    def test_invisible_characters_never_reach_the_entry(self):
        z = lambda *cps: "".join(chr(c) for c in cps)  # noqa: E731 — built from code points so the source shows what they are
        hidden = "lan" + z(0x200B) + "terns" + z(0xFEFF) + " " + z(0x2063) + "rise" + z(0xE0041, 0xE0042, 0x202E, 0x200E)
        self.assertEqual(x.clean_text(hidden, 100), "lanterns rise")
        # The same set as the site's (lib/creative/improve.ts): soft hyphen, Arabic letter mark, Mongolian vowel separator,
        # supplementary variation selectors, and runs of variation selectors.
        more = "te" + z(0xAD) + "a" + z(0x61C) + z(0x180E) + " po" + z(0xE0100) + "t" + z(0xFE00, 0xFE01, 0xFE0F)
        self.assertEqual(x.clean_text(more, 100), "tea pot")
        # One variation selector after a symbol is how an emoji is written, and it stays.
        heart = "love " + z(0x2764, 0xFE0F)
        self.assertEqual(x.clean_text(heart, 100), heart)

    def test_every_invisible_character_is_stripped_and_visible_format_marks_stay(self):
        # BR-1: tag characters past U+E007F spell hidden text the old list let through.
        hidden = "".join(chr(0xE0000 + ord(c)) for c in "ignore")  # U+E0069 ... as tags
        self.assertEqual(x.clean_text("a boat" + chr(0xE0080) + chr(0xE0FFF) + hidden, 100), "a boat")
        z = lambda *cps: "".join(chr(c) for c in cps)  # noqa: E731
        # Fillers, other Cf characters (U+2061-2064, U+FFF9 interlinear annotations, U+1D173 musical format), DEL, C1.
        fillers = z(0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180B, 0x180F, 0x3164, 0xFFA0, 0xFFF0, 0xFFF8, 0xFFF9, 0x1D173, 0x7F, 0x85)
        self.assertEqual(x.clean_text("sea" + fillers + "side", 100), "seaside")
        # Tab and line break are text, not controls.
        self.assertEqual(x.clean_text("a\tb\nc", 100), "a\tb\nc")
        # The prepended concatenation marks draw something: removing them would change what the text shows.
        for cp in (0x0600, 0x0605, 0x06DD, 0x070F, 0x0890, 0x0891, 0x08E2, 0x110BD, 0x110CD):
            with self.subTest(cp=hex(cp)):
                self.assertEqual(x.clean_text("x" + chr(cp) + "1", 100), "x" + chr(cp) + "1")

    def test_the_cut_counts_as_the_page_does_and_never_halves_a_character(self):
        lantern = chr(0x1F3EE)
        self.assertEqual(x.utf16_len(lantern), 2)
        self.assertEqual(x.clean_text(lantern * 5, 5), lantern * 2)


class CostTest(unittest.TestCase):
    def test_unknown_is_null_never_zero(self):
        self.assertEqual(x.summarize_costs([])["usdEstimate"], None)
        self.assertEqual(x.summarize_costs([])["rows"], 0)
        unpriced = [{"provider": "runway", "vendor_model": None, "unit": "credits", "quantity": 60, "usd_estimate": None, "price_source": None}]
        c = x.summarize_costs(unpriced)
        self.assertIsNone(c["usdEstimate"])
        self.assertIsNone(c["priceSource"])
        # The vendor's own figure survives even when the dollar figure is unknown.
        self.assertEqual(c["vendor"], [{"provider": "runway", "vendorModel": None, "unit": "credits", "quantity": 60.0}])

    def test_one_unpriced_row_makes_the_whole_unknown(self):
        rows = [
            {"provider": "runway", "usd_estimate": 0.5, "price_source": "list"},
            {"provider": "runway", "usd_estimate": None, "price_source": None},
        ]
        self.assertIsNone(x.summarize_costs(rows)["usdEstimate"])

    def test_a_figure_without_its_source_is_not_trusted(self):
        self.assertIsNone(x.summarize_costs([{"provider": "runway", "usd_estimate": 0.5, "price_source": None}])["usdEstimate"])

    def test_priced_rows_are_summed_with_their_sources(self):
        rows = [{"provider": "runway", "usd_estimate": "0.25", "price_source": "b"}, {"provider": "runway", "usd_estimate": 0.5, "price_source": "a"}]
        c = x.summarize_costs(rows)
        self.assertEqual(c["usdEstimate"], 0.75)
        self.assertEqual(c["priceSource"], "a; b")


class SignedLinkTest(unittest.TestCase):
    def test_the_signature_is_the_servers_byte_for_byte(self):
        # Computed with Node's crypto exactly as command-center/lib/server/media.ts signMedia does.
        self.assertEqual(x.sign_media("s" * 40, JOB, "original", "video/mp4", 1800000000), "Q133SHLT39vyLeeeR7gfPklgbFCx78gaXtR68rJ7BJs")

    def test_the_origin_must_be_an_https_origin(self):
        self.assertEqual(x.site_origin("https://new.nightshift-ai.studio/"), "https://new.nightshift-ai.studio")
        for bad in ("http://example.com", "https://example.com/path", "example.com", "", "https://user@example.com"):
            with self.subTest(bad=bad), self.assertRaises(x.Refusal):
                x.site_origin(bad)


class FakeResponse:
    def __init__(self, status, body=b""):
        self.status_code = status
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_content(self, n):
        yield self.body


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.urls = []

    def get(self, url, **kw):
        self.urls.append(url)
        self.assertion = kw
        return self.response


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_the_file_must_be_the_one_the_library_stored(self):
        s = FakeSession(FakeResponse(200, b"something else"))
        with self.assertRaises(x.Refusal) as cm:
            x.download(s, "https://site.test", "k" * 40, OUT, "video/mp4", SHA, self.tmp / "f", now=1000)
        self.assertEqual(cm.exception.code, "hash_mismatch")

    def test_a_good_download_uses_a_short_link_and_no_redirect(self):
        s = FakeSession(FakeResponse(200, BYTES))
        self.assertEqual(x.download(s, "https://site.test", "k" * 40, OUT, "video/mp4", SHA, self.tmp / "f", now=1000), len(BYTES))
        self.assertIn(f"/api/media/file/{OUT}/original?", s.urls[0])
        self.assertIn("exp=1300", s.urls[0])
        self.assertIs(s.assertion["allow_redirects"], False)

    def test_an_error_never_carries_the_signed_link(self):
        s = FakeSession(FakeResponse(403))
        with self.assertRaises(x.Refusal) as cm:
            x.download(s, "https://site.test", "k" * 40, OUT, "video/mp4", SHA, self.tmp / "f", now=1000)
        self.assertEqual(cm.exception.code, "download_failed")
        self.assertNotIn("sig=", str(cm.exception))
        self.assertNotIn("k" * 10, str(cm.exception))

    def test_a_connection_error_never_carries_the_signed_link(self):
        import requests

        class Broken:
            def get(self, url, **kw):
                raise requests.ConnectionError(f"HTTPSConnectionPool: Max retries exceeded with url: {url}")

        with self.assertRaises(x.Refusal) as cm:
            x.download(Broken(), "https://site.test", "k" * 40, OUT, "video/mp4", SHA, self.tmp / "f", now=1000)
        self.assertEqual(cm.exception.code, "download_failed")
        self.assertIn("ConnectionError", str(cm.exception))
        self.assertNotIn("sig=", str(cm.exception))
        self.assertNotIn("/api/media/file", str(cm.exception))
        # `from None`: the traceback does not chain the original (whose text holds the link) either.
        self.assertIsNone(cm.exception.__cause__)
        self.assertTrue(cm.exception.__suppress_context__)

    def test_main_prints_only_the_type_of_an_unexpected_error(self):
        import requests

        signed = f"https://site.test/api/media/file/{OUT}/original?t=video%2Fmp4&exp=1&sig=SIGNATURE"

        def boom(*a, **kw):
            raise requests.ConnectionError(signed)

        env = {"SUPABASE_URL": "https://db.test", "SUPABASE_SERVICE_KEY": "service-key-value", "MEDIA_URL_SECRET": "m" * 40, "SITE_ORIGIN": "https://site.test"}
        out, err = io.StringIO(), io.StringIO()
        saved = {k: x.os.environ.get(k) for k in env}
        orig_export = x.export
        x.export = boom
        x.os.environ.update(env)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = x.main(["--job-id", JOB, "--outcome", str(self.tmp / "outcome")])
        finally:
            x.export = orig_export
            for k, v in saved.items():
                if v is None:
                    x.os.environ.pop(k, None)
                else:
                    x.os.environ[k] = v
        self.assertEqual(code, 1)
        printed = out.getvalue() + err.getvalue()
        self.assertIn("ConnectionError", printed)
        for leak in ("SIGNATURE", "sig=", "/api/media/file", "service-key-value"):
            self.assertNotIn(leak, printed)
        self.assertEqual((self.tmp / "outcome").read_text(encoding="utf-8").strip(), "failed")

    def test_a_missing_or_short_key_stops_before_any_request(self):
        s = FakeSession(FakeResponse(200, BYTES))
        with self.assertRaises(x.Refusal) as cm:
            x.download(s, "https://site.test", "short", OUT, "video/mp4", SHA, self.tmp / "f")
        self.assertEqual(cm.exception.code, "media_secret_missing")
        self.assertEqual(s.urls, [])


def fake_derive(src, kind, mime, out):
    out.mkdir(parents=True, exist_ok=True)
    for name in x.VIDEO_FILES if kind == "video" else x.IMAGE_FILES:
        head = {".webp": b"RIFF\x00\x00\x00\x00WEBPVP8 ", ".mp4": b"\x00\x00\x00\x18ftypisom", ".webm": b"\x1a\x45\xdf\xa3\x00"}[Path(name).suffix]
        (out / name).write_bytes(head + b"data")
    return (1280, 720, False)


def fake_derive_with_sound(src, kind, mime, out):
    w, h, _ = fake_derive(src, kind, mime, out)
    return (w, h, kind == "video")


class ExportTest(unittest.TestCase):
    """The whole run against a scratch copy of the data file and the module."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.data = self.tmp / "showcase.json"
        self.data.write_text('{\n  "entries": []\n}\n', encoding="utf-8")
        self.module = self.tmp / "showcase-assets.ts"
        self.module.write_text(x.render_assets_module([]), encoding="utf-8")
        self.out = self.tmp / "showcase"
        self.fetched = []

    def fetch(self, asset_id, mime, sha, dest):
        self.fetched.append(asset_id)
        dest.write_bytes(BYTES)
        return len(BYTES)

    def run_export(self, rest, derive=fake_derive, **kw):
        # The real art hashes are used by export(); stand the fake art in for them.
        orig = x.file_hashes
        x.file_hashes = lambda dirs: ART if dirs == [x.ART_DIR] else STOCK
        try:
            return x.export(JOB, rest=rest, fetch=self.fetch, derive=derive, data_file=self.data, assets_module=self.module,
                            out_root=self.out, now=datetime(2026, 11, 13, tzinfo=timezone.utc), **kw)
        finally:
            x.file_hashes = orig

    def test_one_export_writes_the_entry_the_files_and_the_module(self):
        entry = self.run_export(world(), slot_raw="show.studio", caption_raw="first" + chr(0x202E) + " sample")
        data = json.loads(self.data.read_text(encoding="utf-8"))
        self.assertEqual([e["jobId"] for e in data["entries"]], [JOB])
        self.assertEqual(entry["slot"], "show.studio")
        self.assertEqual(entry["caption"], "first sample")
        self.assertEqual(entry["cost"]["usdEstimate"], 0.6)
        self.assertEqual(sorted(p.name for p in (self.out / JOB).iterdir()), sorted(x.VIDEO_FILES))
        module = self.module.read_text(encoding="utf-8")
        self.assertEqual(module, x.render_assets_module(data["entries"]))
        self.assertIn(f'import s0Mp4 from "@/components/site/showcase/{JOB}/clip.mp4";', module)

    def test_the_entry_records_no_sound_and_no_card_line_by_default(self):
        entry = self.run_export(world())
        self.assertIs(entry["audio"], False)
        self.assertIsNone(entry["cardLine"])
        self.assertNotIn("audio", self.module.read_text(encoding="utf-8"))

    def test_the_entry_and_the_module_carry_the_sound_the_derivatives_found(self):
        line = {"en": "Lanterns rise", "ru": "Фонари", "uz": "Chiroqlar"}
        entry = self.run_export(world(), derive=fake_derive_with_sound, card_line_raw=line)
        self.assertIs(entry["audio"], True)
        data = json.loads(self.data.read_text(encoding="utf-8"))
        self.assertIs(data["entries"][0]["audio"], True)
        self.assertEqual(data["entries"][0]["cardLine"], line)
        self.assertIn("audio: true", self.module.read_text(encoding="utf-8"))
        self.assertIn("Sound: yes", x.summary_markdown(entry))
        self.assertIn('Card line: en: `` "Lanterns rise" ``'.replace("``", "`"), x.summary_markdown(entry))

    def test_a_prompt_with_hidden_tag_bytes_is_exported_as_its_visible_words(self):
        # BR-1: "a boat" followed by text spelled in tag characters past U+E007F (invisible on the page, read by a model).
        hidden = "".join(chr(0xE0080 + i) for i in range(16))
        entry = self.run_export(world(params={"prompt": "a boat" + hidden, "source_asset_id": SRC}))
        self.assertEqual(entry["prompt"], "a boat")
        self.assertEqual(json.loads(self.data.read_text(encoding="utf-8"))["entries"][0]["prompt"], "a boat")

    def test_a_bad_card_line_is_refused_before_anything_is_fetched(self):
        with self.assertRaises(x.Refusal) as cm:
            self.run_export(world(), card_line_raw={"en": "only english"})
        self.assertEqual(cm.exception.code, "card_line_incomplete")
        self.assertEqual(self.fetched, [])

    def test_the_same_job_again_changes_nothing(self):
        self.run_export(world())
        before = (self.data.read_text(encoding="utf-8"), self.module.read_text(encoding="utf-8"))
        with self.assertRaises(x.AlreadyThere):
            self.run_export(world())
        self.assertEqual((self.data.read_text(encoding="utf-8"), self.module.read_text(encoding="utf-8")), before)
        self.assertEqual(self.fetched, [OUT])

    def test_a_refusal_downloads_nothing_and_writes_nothing(self):
        with self.assertRaises(x.Refusal):
            self.run_export(world(org_id=CUSTOMER))
        self.assertEqual(self.fetched, [])
        self.assertEqual(json.loads(self.data.read_text(encoding="utf-8")), {"entries": []})
        self.assertFalse(self.out.exists())

    def test_the_library_files_id_finds_the_job_that_made_it(self):
        rest = world()
        self.assertEqual(x.resolve_job_id(rest, OUT), JOB)
        self.assertEqual(x.resolve_job_id(rest, JOB), JOB)
        done = self.run_export_id(OUT, rest)
        self.assertEqual(done["jobId"], JOB)
        self.assertEqual(done["assetId"], OUT)
        # Asked again by either id, it is the same sample: nothing happens.
        for again in (OUT, JOB):
            with self.subTest(again=again), self.assertRaises(x.AlreadyThere):
                self.run_export_id(again, world())

    def test_a_file_that_is_a_customers_or_not_a_generation_resolves_to_nothing(self):
        theirs = FakeRest(assets=[asset(OUT, org_id=CUSTOMER)])
        with self.assertRaises(x.Refusal) as cm:
            x.resolve_job_id(theirs, OUT)
        self.assertEqual(cm.exception.code, "not_operator_org")
        upload = FakeRest(assets=[asset(OUT, source="upload", provenance={})])
        with self.assertRaises(x.Refusal) as cm:
            x.resolve_job_id(upload, OUT)
        self.assertEqual(cm.exception.code, "not_a_generation")
        with self.assertRaises(x.Refusal) as cm:
            x.resolve_job_id(FakeRest(), OUT)
        self.assertEqual(cm.exception.code, "job_not_found")

    def run_export_id(self, some_id, rest):
        orig = x.file_hashes
        x.file_hashes = lambda dirs: ART if dirs == [x.ART_DIR] else STOCK
        try:
            return x.export(some_id, rest=rest, fetch=self.fetch, derive=fake_derive, data_file=self.data, assets_module=self.module,
                            out_root=self.out, now=datetime(2026, 11, 13, tzinfo=timezone.utc))
        finally:
            x.file_hashes = orig

    def test_an_unknown_slot_is_refused_before_anything(self):
        with self.assertRaises(x.Refusal) as cm:
            self.run_export(world(), slot_raw="not.a.slot")
        self.assertEqual(cm.exception.code, "bad_slot")
        self.assertEqual(self.fetched, [])


class VerifyExportTest(unittest.TestCase):
    """The publish job holds the write token: it commits only what this check lets through."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        cc = self.root / "command-center"
        entry = {"jobId": JOB, "kind": "video"}
        (cc / "lib/site").mkdir(parents=True)
        (cc / "lib/site/showcase.json").write_text(json.dumps({"entries": [entry]}), encoding="utf-8")
        (cc / "components/site").mkdir(parents=True)
        (cc / "components/site/showcase-assets.ts").write_text(x.render_assets_module([entry]), encoding="utf-8")
        fake_derive(None, "video", "video/mp4", cc / "components/site/showcase" / JOB)
        (self.root / "summary.md").write_text("- Job: x\n", encoding="utf-8")

    def refused(self, code):
        with self.assertRaises(x.Refusal) as cm:
            x.verify_export(self.root, JOB)
        self.assertEqual(cm.exception.code, code)

    def test_a_clean_export_passes(self):
        self.assertEqual(x.verify_export(self.root, JOB), "video")

    def test_any_other_file_is_refused(self):
        for rel in (".github/workflows/evil.yml", "command-center/app/page.tsx", f"command-center/components/site/showcase/{JOB}/extra.mp4"):
            with self.subTest(rel=rel):
                p = self.root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("x", encoding="utf-8")
                self.refused("export_unexpected_files")
                p.unlink()

    def test_a_symbolic_link_is_refused(self):
        (self.root / "command-center/components/site/showcase" / JOB / "clip.mp4").unlink()
        (self.root / "command-center/components/site/showcase" / JOB / "clip.mp4").symlink_to("/etc/passwd")
        self.refused("export_has_link")

    def test_a_module_that_is_not_the_generated_one_is_refused(self):
        p = self.root / "command-center/components/site/showcase-assets.ts"
        p.write_text(p.read_text(encoding="utf-8") + 'import "@/lib/server/secrets";\n', encoding="utf-8")
        self.refused("export_module_mismatch")

    def test_a_file_that_is_not_its_type_is_refused(self):
        (self.root / "command-center/components/site/showcase" / JOB / "poster.webp").write_bytes(b"<html>")
        self.refused("export_bad_file")

    def test_a_job_listed_twice_is_refused(self):
        entry = {"jobId": JOB, "kind": "video"}
        (self.root / "command-center/lib/site/showcase.json").write_text(json.dumps({"entries": [entry, entry]}), encoding="utf-8")
        self.refused("export_bad_entry")


class RepositoryStateTest(unittest.TestCase):
    def test_the_committed_module_is_the_one_the_data_file_generates(self):
        data = x.load_data()
        self.assertEqual(x.ASSETS_MODULE.read_text(encoding="utf-8"), x.render_assets_module(data["entries"]))

    def test_the_operator_org_is_the_one_the_rest_of_the_code_uses(self):
        from modules import credits

        self.assertEqual(x.OPERATOR_ORG, credits.DEFAULT_ORG_ID)

    def test_the_slots_are_read_from_the_site(self):
        names = x.slot_names()
        self.assertIn("hero", names)
        self.assertIn("show.studio", names)
        self.assertIn("mcp.hero", names)

    def test_the_data_file_is_not_hidden_by_the_blanket_json_ignore(self):
        out = subprocess.run(["git", "check-ignore", "-q", str(x.DATA_FILE)], cwd=x.ROOT)
        self.assertEqual(out.returncode, 1, "command-center/lib/site/showcase.json must be committed (.gitignore re-includes it)")


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.text = (x.ROOT / ".github/workflows/showcase_asset.yml").read_text(encoding="utf-8")
        self.doc = yaml.safe_load(self.text)

    def test_inputs_reach_scripts_only_through_env(self):
        for job_id, job in self.doc["jobs"].items():
            for step in job["steps"]:
                with self.subTest(job=job_id, step=step.get("name")):
                    self.assertNotIn("${{", step.get("run", ""))

    def test_the_job_with_the_keys_cannot_write_and_the_job_that_writes_has_no_key(self):
        export, publish = self.doc["jobs"]["export"], self.doc["jobs"]["publish"]
        self.assertEqual(export["permissions"], {"contents": "read"})
        self.assertIn("secrets.SUPABASE_SERVICE_KEY", yaml.safe_dump(export))
        self.assertNotIn("secrets.", yaml.safe_dump(publish))
        self.assertEqual(publish["permissions"]["contents"], "write")

    def test_only_an_open_pull_request_is_a_no_op(self):
        run = "\n".join(s.get("run", "") for s in self.doc["jobs"]["publish"]["steps"])
        self.assertIn('gh pr list --repo "$GITHUB_REPOSITORY" --head "$branch" --state open --json number -q length', run)
        # The open PR is the only no-op; a branch left without one stops the run (it is never reused or its PR reopened).
        self.assertEqual(run.count("exit 0"), 1)
        self.assertLess(run.index("exit 0"), run.index("branches/${branch}"))
        branch_check = run[run.index("branches/${branch}"):]
        self.assertIn("::error::branch ${branch} exists without an open pull request", branch_check)
        self.assertLess(branch_check.index("exit 1"), branch_check.index("push origin"))
        self.assertLess(branch_check.index("exit 1"), branch_check.index("gh pr create"))

    def test_a_run_off_main_fails_red_instead_of_skipping_green(self):
        export = self.doc["jobs"]["export"]
        self.assertNotIn("if", export)
        first = export["steps"][0]
        self.assertEqual(first["if"], "github.ref != 'refs/heads/main'")
        self.assertIn("::error::", first["run"])
        self.assertIn("exit 1", first["run"])

    def test_publish_commits_on_the_commit_the_export_read_not_on_main_as_it_is_now(self):
        # A showcase PR merged between the two jobs would otherwise be reverted by this run's whole-file data file and module.
        checkout = next(s for s in self.doc["jobs"]["publish"]["steps"] if str(s.get("uses", "")).startswith("actions/checkout@"))
        self.assertEqual(checkout["with"]["ref"], "${{ github.sha }}")
        export_checkout = next(s for s in self.doc["jobs"]["export"]["steps"] if str(s.get("uses", "")).startswith("actions/checkout@"))
        self.assertNotIn("ref", export_checkout.get("with") or {})

    def test_installs_are_pinned_and_values_cannot_become_options(self):
        export = self.doc["jobs"]["export"]
        runs = "\n".join(s.get("run", "") for s in export["steps"])
        self.assertIn("pip install -c constraints.txt", runs)
        for flag in ('--job-id="$JOB_ID"', '--slot="$SLOT"', '--caption="$CAPTION"', '--card-line-en="$CARD_LINE_EN"',
                     '--card-line-ru="$CARD_LINE_RU"', '--card-line-uz="$CARD_LINE_UZ"'):
            self.assertIn(flag, runs)

    def test_it_never_pushes_to_main_and_opens_a_draft(self):
        run = "\n".join(s.get("run", "") for s in self.doc["jobs"]["publish"]["steps"])
        self.assertIn("gh pr create --draft --base main", run)
        self.assertIn('HEAD:refs/heads/${branch}', run)
        self.assertNotIn("refs/heads/main", run)
        self.assertIn('branch="showcase/${JOB_ID}"', run)
        self.assertIn("--verify-export", run)


class SoundTest(unittest.TestCase):
    """Owner decision 2026-11-22: a clip with sound keeps it in the full copies; the site learns it from the entry, never guesses."""

    class Done:
        def __init__(self, code, out):
            self.returncode, self.stdout = code, out

    def probe(self, code, out):
        return x.has_audio("ffprobe", Path("clip"), "video/mp4", run=lambda *a, **kw: self.Done(code, out))

    def test_an_audio_stream_is_read_from_the_file(self):
        self.assertTrue(self.probe(0, b"audio\n"))
        self.assertTrue(self.probe(0, b"audio\naudio\n"))
        self.assertFalse(self.probe(0, b""))

    def test_a_probe_that_cannot_say_is_a_refusal_not_a_silent_copy(self):
        with self.assertRaises(x.Refusal) as cm:
            self.probe(1, b"")
        self.assertEqual(cm.exception.code, "audio_unknown")

        def missing(*a, **kw):
            raise FileNotFoundError("ffprobe")

        with self.assertRaises(x.Refusal) as cm:
            x.has_audio("ffprobe", Path("clip"), "video/mp4", run=missing)
        self.assertEqual(cm.exception.code, "audio_unknown")

    def test_the_audio_probe_is_forced_to_the_files_type_and_reads_no_other_protocol(self):
        cmd = x.audio_probe_command("ffprobe", Path("clip"), "video/webm")
        self.assertEqual(cmd[cmd.index("-f") + 1], "matroska")
        self.assertEqual(cmd[cmd.index("-protocol_whitelist") + 1], "file")
        self.assertEqual(cmd[cmd.index("-select_streams") + 1], "a")

    @staticmethod
    def by_output(cmds):
        return {Path(c[-1]).name: c for c in cmds}

    def test_with_sound_the_full_copies_carry_aac_and_opus_and_the_small_ones_stay_silent(self):
        cmds = self.by_output(x.video_commands("ffmpeg", Path("src"), "video/mp4", Path("out"), audio=True))
        mp4, webm = cmds["clip.mp4"], cmds["clip.webm"]
        self.assertNotIn("-an", mp4)
        self.assertNotIn("-an", webm)
        self.assertEqual(mp4[mp4.index("-c:a") + 1], "aac")
        self.assertEqual(mp4[mp4.index("-b:a") + 1], "128k")
        self.assertEqual(webm[webm.index("-c:a") + 1], "libopus")
        self.assertEqual(webm[webm.index("-b:a") + 1], "96k")
        for c in (mp4, webm):
            self.assertEqual(c[c.index("-ac") + 1], "2")
            self.assertEqual(c[c.index("-ar") + 1], "48000")
            # Exactly one audio stream and the video: a second track a source carries is never shipped.
            self.assertIn("0:a:0", c)
            self.assertIn("0:v:0", c)
        for name in ("clip-sm.mp4", "clip-sm.webm"):
            self.assertIn("-an", cmds[name])
            self.assertNotIn("-c:a", cmds[name])
        self.assertNotIn("-c:a", cmds["frame0.png"])

    def test_without_sound_every_copy_is_silent(self):
        # The default is silent: a caller that never probed cannot ship a track it did not check for.
        for cmds in (x.video_commands("ffmpeg", Path("src"), "video/mp4", Path("out")),
                     x.video_commands("ffmpeg", Path("src"), "video/mp4", Path("out"), audio=False)):
            for name, c in self.by_output(cmds).items():
                if name.endswith((".mp4", ".webm")):
                    self.assertIn("-an", c, name)
                    self.assertNotIn("-c:a", c, name)

    def test_derivatives_ask_the_probe_and_pass_its_answer_on(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        ran = []
        orig = x.write_posters
        x.write_posters = lambda still, out: (1280, 720)
        try:
            got = x.make_derivatives(tmp / "src", "video", "video/mp4", tmp / "out", run=ran.append, measure=lambda *a: 5.0, sound=lambda *a: True)
        finally:
            x.write_posters = orig
        self.assertEqual(got, (1280, 720, True))
        mp4 = next(c for c in ran if c[-1].endswith("/clip.mp4"))
        self.assertIn("aac", mp4)

    def test_a_picture_has_no_sound_and_is_never_probed(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)

        def never(*a):
            raise AssertionError("a picture was probed for sound")

        orig = x.write_posters
        x.write_posters = lambda still, out: (1280, 720)
        try:
            self.assertEqual(x.make_derivatives(tmp / "src", "image", "image/png", tmp / "out", sound=never), (1280, 720, False))
        finally:
            x.write_posters = orig

    def sound_run(self, peak, samples, code=0):
        """ffprobe says there is a stream; ffmpeg's astats reports `peak` and `samples` (or nothing, with code != 0)."""
        def run(cmd, **kw):
            if Path(cmd[0]).name == "ffprobe":
                return self.Done(0, b"audio\n")
            text = "" if code else f"[Parsed_astats_1] Overall\n[Parsed_astats_1] Peak level dB: {peak}\n[Parsed_astats_1] Number of samples: {samples}\n"
            d = self.Done(code, b"")
            d.stderr = text.encode()
            return d
        return run

    def test_only_a_track_that_is_heard_and_covers_the_picture_is_sound(self):
        hear = lambda peak, samples: x.audio_is_sound("ffmpeg", "ffprobe", Path("c"), "video/mp4", 2.0, run=self.sound_run(peak, samples))  # noqa: E731
        self.assertTrue(hear("-12.5", 96000))
        # Digital silence, and a generator's near-silent padding.
        self.assertFalse(hear("-inf", 96000))
        self.assertFalse(hear("-75.0", 96000))
        # A blip: 1024 samples at 48 kHz on a 2 s picture; and just under 80% of it.
        self.assertFalse(hear("-18.0", 1024))
        self.assertFalse(hear("-18.0", int(0.79 * 2 * 48000)))
        self.assertTrue(hear("-18.0", int(0.8 * 2 * 48000)))

    def test_a_sound_measurement_that_cannot_be_read_refuses(self):
        with self.assertRaises(x.Refusal) as cm:
            x.audio_is_sound("ffmpeg", "ffprobe", Path("c"), "video/mp4", 2.0, run=self.sound_run("-1", 1, code=1))
        self.assertEqual(cm.exception.code, "audio_unknown")

    def test_the_sound_measure_reads_only_the_file_through_its_forced_demuxer(self):
        cmd = x.sound_measure_command("ffmpeg", Path("/w/src"), "video/webm")
        self.assertEqual(cmd[cmd.index("-f") + 1], "matroska")
        self.assertEqual(cmd[cmd.index("-protocol_whitelist") + 1], "file")
        self.assertLess(cmd.index("-t"), cmd.index("-i"))

    def test_the_kept_track_is_cut_at_the_pictures_length(self):
        cmds = self.by_output(x.video_commands("ffmpeg", Path("src"), "video/mp4", Path("out"), audio=True, seconds=2.0))
        for name in ("clip.mp4", "clip.webm"):
            c = cmds[name]
            self.assertIn("-shortest", c)
            # The second -t (after -i) is the output's own cut.
            after = c[c.index("-i"):]
            self.assertEqual(after[after.index("-t") + 1], "2.000")

    def test_the_length_is_the_video_streams_and_a_webm_tag_reads(self):
        cmd = x.probe_command("ffprobe", Path("c"), "video/webm")
        self.assertEqual(cmd[cmd.index("-select_streams") + 1], "v:0")
        self.assertEqual(x._parse_seconds("N/A,00:00:02.500000000\n"), 2.5)
        self.assertEqual(x._parse_seconds("5.041667\n"), 5.041667)
        self.assertNotEqual(x._parse_seconds("N/A\n"), x._parse_seconds("N/A\n"))

    def test_the_module_marks_only_a_clip_with_sound_and_an_old_entry_generates_what_it_did(self):
        silent = {"jobId": JOB, "kind": "video"}
        old = x.render_assets_module([silent])
        self.assertNotIn("audio", old)
        self.assertEqual(x.render_assets_module([dict(silent, audio=False)]), old)
        loud = x.render_assets_module([dict(silent, audio=True)])
        self.assertIn("smWebm: s0SmWebm, audio: true }", loud)


class ClientSliceTest(unittest.TestCase):
    """SHOWCASE_CARDS, the slice of the data file client code reads. The full manifest is server-only: it names the vendor, the
    vendor's model and the cost, which the public site never shows (command-center/tests/showcase-cards.test.ts holds the slice
    equal to what the site's own parser makes of the data file)."""

    def entry(self, **kw):
        base = {"jobId": JOB, "modelId": "runway-gen4.5", "modelName": "Runway Gen-4.5", "provider": "runway", "capability": "i2v",
                "kind": "video", "width": 1280, "height": 720, "slot": None, "createdAt": "2026-11-13T10:00:00Z", "sha256": "a" * 64,
                "operatorPreview": True, "input": {"kind": "operator_job", "jobId": PARENT_JOB, "assetId": PARENT_JOB},
                "cost": {"vendor": [{"provider": "runway", "vendorModel": "gen4.5"}]}, "attribution": {"text": "Powered by Runway", "url": "https://runwayml.com"}}
        base.update(kw)
        return base

    def test_a_card_holds_only_what_client_code_reads(self):
        (card,) = x.showcase_cards([self.entry()])
        self.assertEqual(card, {"jobId": JOB, "modelId": "runway-gen4.5", "capability": "i2v", "kind": "video", "width": 1280, "height": 720,
                                "slot": None, "input": {"kind": "operator_job", "jobId": PARENT_JOB}})
        module = x.render_assets_module([self.entry()])
        for private in ("provider", "vendorModel", "modelName", "operatorPreview", "sha256", "Runway", "runwayml", "attribution", "assetId"):
            # After the export, not the first mention: the header's comment and import name SHOWCASE_CARDS / ShowcaseCard too, and
            # splitting there would scan the files map and header instead of the cards.
            self.assertNotIn(private, module.split("export const SHOWCASE_CARDS")[1], private)

    def test_a_trailing_newline_never_passes_an_id_check(self):
        # `$` matches before a final newline; written into TypeScript, "id\n" would break the string literal.
        self.assertEqual(x.showcase_cards([self.entry(jobId=JOB + "\n")]), [])
        self.assertEqual(x.showcase_cards([self.entry(modelId="runway-gen4.5\n")]), [])
        self.assertEqual(x.showcase_cards([self.entry(slot="hero\n")]), [])
        self.assertEqual(x.showcase_cards([self.entry(capability="i2v\n")]), [])

    def test_the_site_art_input_keeps_its_kind_and_not_its_file_or_hash(self):
        (card,) = x.showcase_cards([self.entry(input={"kind": "site_art", "file": "a.webp", "sha256": "b" * 64})])
        self.assertEqual(card["input"], {"kind": "site_art"})

    def test_newest_first_each_job_once_and_a_malformed_entry_is_not_a_card(self):
        older = self.entry(jobId=PARENT_JOB, createdAt="2026-11-12T10:00:00Z", kind="image", capability="t2i", input={"kind": "none"})
        bad = self.entry(jobId="11111111-2222-4333-8444-555555555555", modelId="Not An Id")
        cards = x.showcase_cards([older, self.entry(), self.entry(width=1), bad])
        self.assertEqual([c["jobId"] for c in cards], [JOB, PARENT_JOB])
        self.assertEqual(cards[0]["width"], 1280)

    def test_the_committed_slice_has_every_entry_of_the_data_file(self):
        data = x.load_data()
        self.assertEqual(len(x.showcase_cards(data["entries"])), len({e["jobId"] for e in data["entries"]}))


class CardLineTest(unittest.TestCase):
    def test_none_given_is_null(self):
        self.assertIsNone(x.parse_card_line({}))
        self.assertIsNone(x.parse_card_line({"en": " ", "ru": "", "uz": chr(0x200B)}))

    def test_all_three_are_kept_cleaned(self):
        got = x.parse_card_line({"en": " Lanterns" + chr(0x202E) + " rise ", "ru": "Фонари", "uz": "Chiroqlar"})
        self.assertEqual(got, {"en": "Lanterns rise", "ru": "Фонари", "uz": "Chiroqlar"})

    def test_one_or_two_languages_only_is_refused(self):
        for given in ({"en": "a"}, {"en": "a", "ru": "b"}, {"ru": "b", "uz": "c"}):
            with self.subTest(given=given), self.assertRaises(x.Refusal) as cm:
                x.parse_card_line(given)
            self.assertEqual(cm.exception.code, "card_line_incomplete")

    def test_invisible_characters_are_stripped_from_the_card_line_too(self):
        got = x.parse_card_line({"en": "boat" + chr(0xE0080) + chr(0x2064), "ru": "лодка" + chr(0x3164), "uz": "qayiq" + chr(0x034F)})
        self.assertEqual(got, {"en": "boat", "ru": "лодка", "uz": "qayiq"})
        # A line that was only invisible characters is no line.
        self.assertIsNone(x.parse_card_line({"en": chr(0xE0080), "ru": chr(0x3164), "uz": chr(0xFFA0)}))

    def test_a_line_break_or_a_tab_is_refused(self):
        for bad in ("one\ntwo", "one\rtwo", "one\ttwo"):
            with self.subTest(bad=bad), self.assertRaises(x.Refusal) as cm:
                x.parse_card_line({"en": "a", "ru": bad, "uz": "c"})
            self.assertEqual(cm.exception.code, "card_line_invalid")

    def test_the_summary_shows_a_card_line_as_code_so_it_pings_nobody(self):
        card = x.parse_card_line({"en": "thanks @octocat", "ru": "a ``b`` c", "uz": "d"})
        self.assertEqual(x._code('"thanks @octocat"'), '` "thanks @octocat" `')
        # A value with backticks cannot close its own span.
        self.assertEqual(x._code('"a ``b`` c"'), '``` "a ``b`` c" ```')
        self.assertIsNotNone(card)

    def test_a_line_over_the_limit_is_refused_never_cut(self):
        self.assertEqual(x.parse_card_line({"en": "a" * 140, "ru": "b", "uz": "c"})["en"], "a" * 140)
        lantern = chr(0x1F3EE)  # two UTF-16 units, as the page counts it
        for long in ("a" * 141, lantern * 71):
            with self.subTest(n=len(long)), self.assertRaises(x.Refusal) as cm:
                x.parse_card_line({"en": "a", "ru": long, "uz": "c"})
            self.assertEqual(cm.exception.code, "card_line_too_long")


class ClipLengthTest(unittest.TestCase):
    """The length is measured on the downloaded file; the row's duration_s may be null, and -t is only a backstop."""

    class Done:
        def __init__(self, code, out):
            self.returncode, self.stdout = code, out

    def measure(self, code, out):
        return x.clip_seconds("ffprobe", Path("clip"), "video/mp4", run=lambda *a, **kw: self.Done(code, out))

    def test_a_clip_within_the_limit_passes(self):
        self.assertEqual(self.measure(0, b"5.041667\n"), 5.041667)

    def test_a_clip_over_the_limit_is_refused_even_when_the_row_said_nothing(self):
        with self.assertRaises(x.Refusal) as cm:
            self.measure(0, b"31.5\n")
        self.assertEqual(cm.exception.code, "clip_too_long")

    def test_a_length_that_cannot_be_read_is_refused_not_trimmed(self):
        for code, out in ((0, b"N/A\n"), (0, b""), (1, b"5.0\n"), (0, b"nan\n"), (0, b"0\n"), (0, b"inf\n")):
            with self.subTest(out=out, code=code), self.assertRaises(x.Refusal) as cm:
                self.measure(code, out)
            self.assertEqual(cm.exception.code, "clip_length_unknown")

    def test_a_missing_ffprobe_is_a_refusal(self):
        def missing(*a, **kw):
            raise FileNotFoundError("ffprobe")

        with self.assertRaises(x.Refusal) as cm:
            x.clip_seconds("ffprobe", Path("clip"), "video/mp4", run=missing)
        self.assertEqual(cm.exception.code, "clip_length_unknown")

    def test_derivatives_measure_first_and_write_nothing_when_refused(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        ran = []

        def too_long(*a):
            raise x.Refusal("clip_too_long", "x")

        with self.assertRaises(x.Refusal):
            x.make_derivatives(tmp / "src", "video", "video/mp4", tmp / "out", run=ran.append, measure=too_long)
        self.assertEqual(ran, [])
        self.assertFalse((tmp / "out").exists())

    def test_the_probe_is_forced_to_the_files_type_and_reads_no_other_protocol(self):
        cmd = x.probe_command("ffprobe", Path("clip"), "video/mp4")
        self.assertEqual(cmd[cmd.index("-f") + 1], "mov")
        self.assertEqual(cmd[cmd.index("-protocol_whitelist") + 1], "file")


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed here")
class DerivativesTest(unittest.TestCase):
    def test_a_real_clip_becomes_the_four_renditions_and_two_posters(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        src = tmp / "src.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24:duration=1",
                        "-pix_fmt", "yuv420p", str(src)], check=True)
        self.assertAlmostEqual(x.clip_seconds("ffprobe", src, "video/mp4"), 1.0, places=1)
        size = x.make_derivatives(src, "video", "video/mp4", tmp / "out")
        # No rendition runs past a sample's length, whatever the file says about itself.
        for cmd in x.video_commands("ffmpeg", src, "video/mp4", tmp / "out"):
            self.assertLess(cmd.index("-t"), cmd.index("-i"))
            self.assertEqual(cmd[cmd.index("-t") + 1], "30")
        self.assertEqual(size, (1280, 720, False))
        self.assertEqual(sorted(p.name for p in (tmp / "out").iterdir()), sorted(x.VIDEO_FILES))

    def test_a_clip_with_sound_keeps_it_in_the_full_copies_only(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        src = tmp / "src.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24:duration=1",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-pix_fmt", "yuv420p", str(src)], check=True)
        self.assertTrue(x.has_audio("ffprobe", src, "video/mp4"))
        self.assertEqual(x.make_derivatives(src, "video", "video/mp4", tmp / "out"), (1280, 720, True))

        def codecs(name):
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0",
                                  str(tmp / "out" / name)], stdout=subprocess.PIPE, check=True).stdout.decode()
            return sorted(line.strip() for line in out.splitlines() if line.strip())

        self.assertIn("aac,audio", codecs("clip.mp4"))
        self.assertIn("opus,audio", codecs("clip.webm"))
        for name in ("clip-sm.mp4", "clip-sm.webm"):
            self.assertFalse([c for c in codecs(name) if c.endswith(",audio")], name)


if __name__ == "__main__":
    unittest.main()
