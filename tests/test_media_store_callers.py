"""What each caller of MediaStore does when register_asset fails, driven through the REAL MediaStore._rpc.

The failure is injected at the HTTP session (a fake ``post``), never above MediaStore: a stub that raises from store_file
stays green while production regresses, which is how PR #869 first broke Sentinel R1 unnoticed.

What would break:
* film assembly: a lost answer (ReadTimeout) or a 503 after register_asset wrote the master is recorded as the film's
  failure, instead of nothing recorded and the next claim reusing the registered master (Sentinel R1);
* editor export / character swap: an outage while registering a finished render or a PAID vendor result records a
  terminal store_failed, and the paid output is lost instead of being retried on the next claim;
* brand scan: a refused key or call (401, 422) waits for the stale sweep with its reason lost, instead of failing now
  with the remedy named;
* the reverse: a refusal (401/422) made to look transient and left running forever (CLAUDE.md rule 6).
"""

from __future__ import annotations

import json as jsonlib
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import requests

from modules import brand_scan as bs
from modules import character_swap as cs
from modules import editor_export
from modules import film_assembly as fa
from modules import media_library as ml
from modules import model_registry as reg
from tests import test_brand_scan_worker as tbs
from tests import test_character_swap_worker as tcs
from tests import test_film_assembly as tfa
from tests.test_editor_export_paid_1080p import own
from tests.test_editor_hires_export import Base as ExportBase, FakeStore as ExportStore, doc

URL = "https://projectref123.supabase.co"
KEY = "service-key-placeholder"
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
#: Taken before any test patches it: the real function, so register_asset goes through MediaStore._rpc.
REAL_STORE_GENERATED = ml.store_generated

LOST = "lost"  # the write happened, then the answer was lost (requests' ReadTimeout)


class _Resp:
    def __init__(self, status, text):
        self.status_code, self.text = status, text

    def json(self):
        return jsonlib.loads(self.text)


class Wire:
    """PostgREST as MediaStore._rpc sees it, for register_asset only. ``answer`` is LOST, an exception, or a status.
    ``wrote`` runs first when the database is meant to have committed the row (the answer is lost on the way back)."""

    def __init__(self, answer, wrote=None):
        self.answer, self.wrote, self.sent = answer, wrote, []

    def post(self, url, json=None, headers=None, timeout=None):  # noqa: A002 — requests' own keyword
        name = url.rsplit("/", 1)[-1]
        self.sent.append(name)
        assert name == "register_asset", name
        if self.wrote:
            self.wrote(json)
        a = self.answer
        if a == LOST:
            raise requests.exceptions.ReadTimeout(f"read timed out {url}")
        if isinstance(a, BaseException):
            raise a
        body = {"id": json["p_asset_id"]} if a < 300 else {"code": "PGRST301", "message": "refused"}
        return _Resp(a, jsonlib.dumps(body))


def media(answer, wrote=None) -> ml.MediaStore:
    return ml.MediaStore(URL, KEY, session=Wire(answer, wrote))


# ── film assembly (Sentinel R1) ──────────────────────────────────────────────

class FilmAssemblyThroughTheRealStore(tfa.Base):
    def assemble(self, db, store_media):
        return fa.assemble_segment(db.seg, worker_id="w-1", store=db, media=store_media, media_root=self.root,
                                   tools=ml.Tools(ffprobe="ffprobe", ffmpeg="ffmpeg"), deps=self.fake_deps(db))

    def test_a_lost_or_5xx_register_answer_records_nothing_and_the_next_claim_reuses_the_master(self):
        for answer in (LOST, 503, 502, 429):
            f = self.film()
            db = f.db()
            committed = tfa.FakeMedia(db)

            def wrote(payload, committed=committed):
                committed.register(**{k[2:]: v for k, v in payload.items()})  # the row is in the database

            with self.assertRaises(fa.DbUnavailable, msg=answer):
                self.assemble(db, media(answer, wrote))
            self.assertEqual(db.records(), [], f"{answer}: a transient outage was recorded as the film's failure")
            self.assertEqual(db.seg["assembly"]["status"], "running", answer)
            again = self.assemble(db, tfa.FakeMedia(db))
            self.assertTrue(again.ok and not again.rendered, (answer, again))
            self.assertEqual(len(db.records()), 1, answer)

    def test_a_refused_register_is_recorded_as_a_failure_not_left_running(self):
        for status in (401, 422):
            f = self.film()
            db = f.db()
            with self.assertRaises(ml.MediaStoreRefused, msg=status):
                self.assemble(db, media(status))
            self.assertEqual(db.records(), [("record", False, None)], status)
            self.assertEqual(db.seg["assembly"]["status"], "failed", status)


# ── editor export ────────────────────────────────────────────────────────────

class EditorExportThroughTheRealStore(ExportBase):
    def export(self, answer):
        store = ExportStore()
        lib = media(answer)

        def store_file(path, **kw):
            # The real store_generated over the real MediaStore; no ffprobe here (the sniffed type is enough).
            return REAL_STORE_GENERATED(path, **{**kw, "store": lib, "tools": None})

        def render(d, res, out, **kw):
            Path(out).write_bytes(MP4)
            return out

        def run():
            # The layout check refuses a non-POSIX path (timeline._local_path), so on a Windows box every export would end
            # invalid_timeline before the store is reached. The layout is not what is tested here; the store path is.
            with mock.patch.object(editor_export.timeline_render, "to_render_spec", return_value=None):
                return editor_export.run_export(
                    own(doc(4.0)), store=store, media_root=self.root, worker_id="w1",
                    tools=ml.Tools("ffprobe", "ffmpeg"), render=render, store_file=store_file,
                    has_audio=lambda p, m: True, heartbeat_s=0.01)
        return run, store

    def test_an_outage_while_storing_the_render_leaves_the_export_for_a_reclaim(self):
        for answer in (LOST, requests.exceptions.ConnectionError("reset"), 503, 429):
            run, store = self.export(answer)
            with self.assertRaises(ml.MediaStoreUnavailable, msg=answer):
                run()
            self.assertEqual(store.finished, [], f"{answer}: an outage was recorded as a terminal store_failed")

    def test_a_refusal_while_storing_fails_the_export_now(self):
        for status in (401, 422):
            run, store = self.export(status)
            self.assertEqual(run(), "failed", status)
            self.assertEqual(store.finished, [(None, "store_failed")], status)

    def test_a_working_store_still_finishes_the_export(self):
        run, store = self.export(200)
        self.assertEqual(run(), "done")
        self.assertEqual(len(store.finished), 1)
        self.assertIsNone(store.finished[0][1])


# ── character swap (a paid vendor result) ────────────────────────────────────

class CharacterSwapThroughTheRealStore(tcs.Patched):
    def swap(self, answer):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        st = tcs.Store(tcs.claimed())
        adapter = tcs.Adapter(polls=[tcs.done()])
        w = cs.CharacterSwapWorker(st, worker_id="w-1", library=cs.Library(store=media(answer), media_root=tmp, tools=tcs.Tools()),
                                   scratch=tmp / "s", origin=tcs.ORIGIN, secret=tcs.SECRET, registry=reg.registry(),
                                   build_adapter=lambda key: adapter, sleep=lambda s: None)
        # Undo Patched's fake store_generated: the real one, over the real MediaStore (no ffprobe here).
        with mock.patch("modules.media_library.store_generated",
                        lambda path, **kw: REAL_STORE_GENERATED(path, **{**kw, "tools": None})):
            self.assertTrue(w.run_once())
        return [c[0] if c[0] != "fail" else c for c in st.calls]

    def test_an_outage_while_storing_the_paid_result_leaves_the_job_for_the_next_claim(self):
        for answer in (LOST, requests.exceptions.ConnectionError("reset"), 503, 429):
            calls = self.swap(answer)
            self.assertIn("record_task", calls, answer)  # the next claim resumes this task, it never pays for a second
            self.assertNotIn(("fail", "store_failed"), calls, f"{answer}: a paid result was lost as store_failed")
            self.assertNotIn("finish", calls, answer)

    def test_a_refusal_while_storing_fails_the_job_now(self):
        for status in (401, 422):
            self.assertEqual(self.swap(status)[-1], ("fail", "store_failed"), status)

    def test_a_working_store_still_finishes_the_job(self):
        self.assertEqual(self.swap(200)[-1], "finish")


# ── brand scan ───────────────────────────────────────────────────────────────

class BrandScanThroughTheRealStore(unittest.TestCase):
    def setUp(self):
        self.media_root = Path(tempfile.mkdtemp(prefix="brand_scan_media_"))
        self.addCleanup(shutil.rmtree, self.media_root, True)

    def scan(self, answer):
        store = tbs.FakeStore(scans=[tbs.job()])
        site = tbs.Worker.site(None)
        w = bs.BrandScanWorker(store, worker_id="w1", verifier=tbs.FakeVerifier(), open_site=lambda url: site,
                               library=bs.Library(media(answer), self.media_root), palette=lambda b: ["#112233"],
                               scratch=self.media_root)
        return w.process_scan(tbs.job()), store

    def test_a_refused_register_fails_the_scan_now_and_names_the_remedy(self):
        for status, code in ((401, "invalid_service_key"), (422, "http_error")):
            with self.assertLogs("modules.brand_scan", "ERROR") as logs:
                out, store = self.scan(status)
            self.assertEqual(out, "failed:worker_error", status)
            self.assertEqual(store.calls[-1], ("fail_scan", tbs.SCAN_ID, "worker_error"), status)
            said = "\n".join(logs.output)
            self.assertIn(code, said)
            self.assertIn(ml._STORE_REMEDIES[code], said)
            self.assertNotIn(KEY, said)
            self.assertNotIn("projectref123", said)

    def test_an_outage_while_storing_leaves_the_scan_for_the_stale_sweep(self):
        for answer in (LOST, 503, 429):
            out, store = self.scan(answer)
            self.assertEqual(out, "left", answer)
            self.assertEqual(store.calls, [], answer)


if __name__ == "__main__":
    unittest.main()
