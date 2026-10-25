"""The region editor's run step in the creative worker (migration 0126, modules/creative_worker.py + modules/region_edit.py).

The model here is a LOOPBACK fake that returns garbage (noise, the wrong shape, not a picture, a vendor refusal) and the tests still require:

* the pixel lock: every pixel outside the regions of the stored result is the original's, and a region whose edit would break the lock counts
  as FAILED (so it is not charged) while the others stand;
* per-region status with a closed code and no vendor text: applied | failed | refused; a refused or failed region is reported, never hidden;
* the model asked for, or nothing (rule 4): exact mode only, a model the database still sells for editing, one call per region on that one
  adapter, no retry and no other model; off unless NIGHTSHIFT_REGION_EDITOR is on in the worker;
* the order that cannot pay twice: nothing is spent before ``submitting``, the synthetic task id comes after the last call, a resumed job is
  failed (``output_lost``) instead of polled;
* the result is one new library picture, ``source='generated'``, ``parent_asset_id`` = the source, AI provenance written by the worker;
  a result that cannot be stored fails the job (nothing is charged for it).
No network, no key and no credit is touched.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import media_library as ml
from modules import model_registry as reg
from modules import region_edit as re_
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_POLICY,
    E_UNAVAILABLE,
    SUCCEEDED,
    AdapterError,
    Output,
    PollResult,
    ProviderTask,
)
from tests.test_creative_media_inputs import FakeStore, SourceQueue, put_asset
from tests.test_creative_worker import FakeCredits, JOB, ORG, job

SRC = "ab0c1d1e-0000-4000-8000-00000000a5e7"
W, H = 320, 240
GEMINI = "gemini-3.1-flash-image"       # an edit model without quality tiers
OPENAI = "openai-gpt-image-2"           # an edit model that bills by tier


def picture(size=(W, H), seed=1, mode="RGB") -> Image.Image:
    rng = np.random.default_rng(seed)
    chans = 4 if mode == "RGBA" else 3
    return Image.fromarray(rng.integers(0, 256, size=(size[1], size[0], chans), dtype=np.uint8), mode)


def png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def region(i, x, y, w=60, h=50, prompt=None, name=None):
    return {"id": f"r{i}", "name": name or f"Region {i}", "prompt": prompt or f"change part {i}", "rect": {"x": x, "y": y, "w": w, "h": h}}


REGIONS = [region(1, 10, 10), region(2, 120, 20), region(3, 220, 150)]


def region_job(regions=None, **over):
    params = {"source_asset_id": SRC, "regions": regions if regions is not None else REGIONS}
    params.update(over.pop("params", {}))
    base = dict(capability="edit", requested_model=GEMINI, routed_model=GEMINI, params=params, quoted_credits=9, quantity=len(params["regions"]))
    base.update(over)
    return job(**base)


class Loopback:
    """A capability-layer edit adapter whose model returns whatever ``behave(n, request)`` says: bytes, or it raises."""

    key = "image.loopback"
    capabilities = ("t2i", "edit")
    reference_capabilities = ("edit",)

    def __init__(self, behave=None):
        self.behave = behave or self.noise
        self.requests = []
        self.vendor_models = []
        self.problem_list = []
        self.crop_sizes = []

    @staticmethod
    def noise(n, request):
        w, h = Image.open(request.input_images[0]).size
        return png(picture((w, h), seed=100 + n))

    def problems(self, request, entry):
        return list(self.problem_list)

    def submit(self, request, vendor_model):
        n = len(self.requests)
        self.requests.append(request)
        self.crop_sizes.append(Image.open(request.input_images[0]).size)
        self.vendor_models.append(vendor_model)
        out = self.behave(n, request)
        return ProviderTask(self.key, vendor_model, None, outputs=[Output(mime="image/png", data=out)])

    def poll(self, task):
        return PollResult(SUCCEEDED, list(task.outputs))

    def fetch(self, result, out_dir, stem="output"):
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        files = []
        for i, o in enumerate(result.outputs):
            f = out_dir / f"{stem}_{i}.png"
            f.write_bytes(o.data)
            files.append(f)
        return files


class RegionQueue(SourceQueue):
    """SourceQueue plus 0126's sellable_models, and a record of what the database was told."""

    def __init__(self, j, source, sold=(GEMINI, OPENAI), attach=True):
        super().__init__(j, source=source, attach=attach)
        self.sold = None if sold is None else list(sold)
        self.sold_asked = []

    def sellable_models(self, capability):
        self.sold_asked.append(capability)
        return None if self.sold is None else list(self.sold)

    def advance(self, job_id, worker_id, step, task_id=None, route=None):
        ok = super().advance(job_id, worker_id, step, task_id, route)
        if step == "processing" and ok:
            self.current["status"] = "processing"
        return ok


def ok_source(aid=SRC, kind="image"):
    return {"ok": True, "asset_id": aid, "storage_key": ml.storage_key(aid), "mime": "image/png", "kind": kind,
            "variants": [], "width": W, "height": H}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.out, self.media = root / "jobs", root / "media"
        self.media.mkdir()
        self.original = picture()
        put_asset(self.media, SRC, png(self.original))
        self.store = FakeStore()
        self.resolved = []

    def tearDown(self):
        self.tmp.cleanup()

    def run_job(self, j=None, *, behave=None, sold=(GEMINI, OPENAI), model=GEMINI, region_editor=True, source=None, attach=True,
                library=True, adapter=None, **kw):
        loop = adapter or Loopback(behave)
        entry = reg.get(model)
        ra = ca.RegistryAdapter(entry, loop)

        def resolve(m):
            self.resolved.append(m)
            return ra

        q = RegionQueue(j if j is not None else region_job(requested_model=model, routed_model=model),
                        source if source is not None else ok_source(), sold=sold, attach=attach)
        lib = cw.Library(self.store, self.media, None) if library else None
        w = cw.CreativeWorker(q, resolve, worker_id="w1", out_dir=self.out, credits=FakeCredits(9.0), enforce=True,
                              sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media, library=lib,
                              region_editor=region_editor, **kw)
        self.assertTrue(w.run_once())
        self.q, self.loop = q, loop
        return q, loop

    def steps(self, q):
        return [c[1] if c[0] == "advance" else c[0] for c in q.calls if c[0] in ("advance", "finish")]

    def report(self, q):
        return [(r["id"], r["status"], r.get("code")) for r in q.finished["result"]["regions"]]

    def stored_result(self):
        row = self.store.rows[0]
        data = ml.asset_file(self.media, row["asset_id"], "original").read_bytes()
        return np.array(Image.open(io.BytesIO(data)).convert("RGBA")), row


def outside(shape, regions):
    return re_.outside_mask(shape, [re_.check_region({**r["rect"], "name": r["name"], "prompt": r["prompt"]}, (W, H)) for r in regions],
                            re_.DEFAULT_FEATHER)


class TheRun(Base):
    def test_every_region_applied_with_a_model_that_returns_garbage_and_the_pixel_lock_holds(self):
        q, loop = self.run_job()
        self.assertTrue(q.finished["ok"], q.finished)
        self.assertEqual(self.report(q), [("r1", "applied", None), ("r2", "applied", None), ("r3", "applied", None)])
        self.assertEqual(len(loop.requests), 3, "one call per region")
        self.assertEqual(set(loop.vendor_models), {reg.get(GEMINI).vendor_model_for("edit")}, "one model for every region")
        after, row = self.stored_result()
        before = np.array(self.original.convert("RGBA"))
        keep = outside(before.shape[:2], REGIONS)
        self.assertTrue(np.array_equal(before[keep], after[keep]), "a pixel outside the regions changed")
        self.assertTrue(np.array_equal(before[..., 3], after[..., 3]))
        self.assertFalse(np.array_equal(before, after), "the lock is not vacuous: the regions did change")
        self.assertEqual(self.steps(q), ["submitting", "submitted", "processing", "finish"])

    def test_the_synthetic_task_id_comes_after_the_last_call_and_the_charge_is_left_to_the_database(self):
        seen = []

        def behave(n, request):
            seen.append(("call", n))
            return Loopback.noise(n, request)

        q, loop = self.run_job(behave=behave)
        self.assertIn(("advance", "submitting", None), q.calls)
        self.assertEqual(len(seen), 3)
        order = [c for c in q.calls if c[0] == "advance"]
        self.assertEqual(order[0][1], "submitting")
        self.assertEqual(order[1][:3], ("advance", "submitted", f"region:{JOB}"))
        self.assertIsNone(q.finished["charge"], "the database counts the applied regions; the worker names no price")
        self.assertEqual(q.finished["result"]["feather"], re_.DEFAULT_FEATHER)

    def test_the_result_is_one_generated_version_of_the_source_with_ai_provenance_written_by_the_worker(self):
        q, _ = self.run_job()
        self.assertEqual(len(self.store.rows), 1)
        row = self.store.rows[0]
        self.assertEqual((row["source"], row["kind"], row["mime"], row["org"], row["parent_asset_id"]), ("generated", "image", "image/png", ORG, SRC))
        prov = row["provenance"]
        self.assertTrue(prov["ai_generated"])
        self.assertEqual((prov["job_id"], prov["model"], prov["capability"], prov["source_asset_id"]), (JOB, GEMINI, "edit", SRC))
        self.assertEqual(prov["provider"], reg.get(GEMINI).provider)
        self.assertEqual(prov["region_edit"]["pixel_lock"], "outside_mask_identical")
        self.assertEqual(len(prov["region_edit"]["regions"]), 3)
        self.assertNotIn("change part", json.dumps(prov), "the person's words are not kept in the provenance")
        self.assertEqual(q.attached, [row["asset_id"]])
        self.assertEqual(q.finished["result"]["asset_ids"], [row["asset_id"]])
        self.assertEqual(row["asset_id"], str(uuid.uuid5(cw.ASSET_NS, f"{JOB}:0")), "a retried store reuses the same row")

    def test_a_region_the_vendor_refuses_is_refused_and_reported_and_the_others_apply(self):
        def behave(n, request):
            if n == 1:
                raise AdapterError(E_POLICY, "blocked: your key sk-live-SECRET said no")
            return Loopback.noise(n, request)

        q, loop = self.run_job(behave=behave)
        self.assertEqual(self.report(q), [("r1", "applied", None), ("r2", "refused", "policy"), ("r3", "applied", None)])
        self.assertEqual(len(loop.requests), 3, "the refused region is not retried and no other model is asked")
        after, _ = self.stored_result()
        before = np.array(self.original.convert("RGBA"))
        self.assertTrue(np.array_equal(before[20:70, 120:180], after[20:70, 120:180]), "the refused region is untouched")
        self.assertNotIn("sk-live", json.dumps(q.finished))
        self.assertNotIn("blocked", json.dumps(q.finished))

    def test_a_region_that_fails_in_transit_is_failed_not_refused(self):
        def behave(n, request):
            if n == 0:
                raise AdapterError(E_UNAVAILABLE, "502 from the vendor")
            return Loopback.noise(n, request)

        q, _ = self.run_job(behave=behave)
        self.assertEqual(self.report(q)[0], ("r1", "failed", "unavailable"))
        self.assertEqual(self.report(q)[1:], [("r2", "applied", None), ("r3", "applied", None)])

    def test_garbage_answers_fail_their_region_with_a_closed_code(self):
        answers = {0: b"this is not a picture", 1: png(picture((400, 40))), 2: b""}
        q, _ = self.run_job(behave=lambda n, request: answers[n])
        self.assertEqual(self.report(q), [("r1", "failed", "bad_response"), ("r2", "failed", "bad_response"), ("r3", "failed", "bad_response")])
        self.assertEqual(self.store.rows, [], "nothing to store when nothing applied")
        self.assertNotIn("attach", [c[0] for c in q.calls])

    def test_when_no_region_applies_the_database_is_told_and_nothing_is_stored(self):
        q, _ = self.run_job(behave=lambda n, request: (_ for _ in ()).throw(AdapterError(E_BAD_REQUEST, "no")))
        self.assertTrue(q.finished["ok"], "the report is the finish; the database ends the job failed and releases the hold")
        self.assertTrue(all(s == "refused" for _i, s, _c in self.report(q)))
        self.assertEqual(self.steps(q), ["submitting", "submitted", "finish"])
        self.assertEqual(self.store.rows, [])
        self.assertNotIn("asset_ids", q.finished["result"])

    def test_a_region_outside_the_picture_is_refused_without_a_call_and_the_rest_run(self):
        regions = [region(1, 10, 10), region(2, 300, 200, w=60, h=50), region(3, 220, 150), region(4, 5, 5, w=8, h=60)]
        q, loop = self.run_job(region_job(regions))
        self.assertEqual(self.report(q), [("r1", "applied", None), ("r2", "refused", "region_out_of_bounds"),
                                          ("r3", "applied", None), ("r4", "refused", "region_too_small")])
        self.assertEqual(len(loop.requests), 2, "no model was asked about a region that was refused")

    def test_a_reason_outside_the_closed_list_is_reported_as_a_provider_error_not_as_it_came(self):
        def behave(n, request):
            if n == 0:
                raise re_.RegionEditError("mask_invalid", "the brush mask said: sk-leak")
            return Loopback.noise(n, request)

        q, _ = self.run_job(behave=behave)
        self.assertEqual(self.report(q)[0], ("r1", "failed", "provider_error"))
        self.assertNotIn("mask_invalid", json.dumps(q.finished))
        self.assertNotIn("sk-leak", json.dumps(q.finished))

    def test_a_region_that_touches_the_picture_edge_is_valid_and_applied(self):
        regions = [region(1, W - 60, H - 50, 60, 50), region(2, 0, 0, 60, 50)]
        q, loop = self.run_job(region_job(regions))
        self.assertEqual([s for _i, s, _c in self.report(q)], ["applied", "applied"])
        after, _ = self.stored_result()
        before = np.array(self.original.convert("RGBA"))
        self.assertTrue(np.array_equal(before[outside(before.shape[:2], regions)], after[outside(before.shape[:2], regions)]))

    def test_the_report_names_every_region_in_order_with_the_jobs_own_ids(self):
        regions = [region(7, 10, 10), region(3, 120, 20), region(5, 220, 150)]
        regions[0]["id"], regions[1]["id"], regions[2]["id"] = "z-last", "a_first", "m.id".replace(".", "-")
        q, _ = self.run_job(region_job(regions))
        self.assertEqual([r["id"] for r in q.finished["result"]["regions"]], ["z-last", "a_first", "m-id"])

    def test_one_call_per_region_and_the_crop_not_the_whole_picture_goes_to_the_model(self):
        q, loop = self.run_job()
        for r, (w, h) in zip(loop.requests, loop.crop_sizes):
            self.assertLess(w * h, W * H, "the model sees a crop, never the whole picture")
            self.assertTrue(r.prompt.startswith("Change this picture as described"))
            self.assertEqual(len(r.input_images), 1)

    def test_the_feather_is_the_jobs_and_the_default_is_the_modules(self):
        q, _ = self.run_job(region_job(params={"region_feather": 7}))
        self.assertEqual(q.finished["result"]["feather"], 7)

    def test_the_provider_cost_is_recorded_once_with_the_number_of_calls(self):
        q, _ = self.run_job()
        self.assertEqual(len(q.costs), 1)
        self.assertEqual((q.costs[0].provider, q.costs[0].quantity, q.costs[0].route), (reg.get(GEMINI).provider, 3.0, "exact"))


class Rule4TheModelAskedForOrNothing(Base):
    def failed_before_any_spend(self, q, loop, code):
        self.assertFalse(q.finished["ok"], q.finished)
        self.assertEqual(q.finished["error_code"], code)
        self.assertEqual(loop.requests, [], "nothing was asked of a model")
        self.assertNotIn("submitting", self.steps(q), "nothing is marked as sent")
        self.assertEqual(self.store.rows, [])

    def test_it_is_off_unless_the_switch_is_on_in_the_worker(self):
        q, loop = self.run_job(region_editor=False)
        self.failed_before_any_spend(q, loop, "region_editor_off")
        self.assertEqual(self.resolved, [], "not even an adapter was looked up")

    def test_the_switch_words(self):
        for on in ("on", "ON", " 1 ", "true", "Yes"):
            self.assertTrue(cw.region_editor_enabled({cw.REGION_FLAG: on}), on)
        for off in ("", "off", "0", "no", "false", "enabled", "2"):
            self.assertFalse(cw.region_editor_enabled({cw.REGION_FLAG: off}), off)
        self.assertFalse(cw.region_editor_enabled({}))

    def test_a_model_the_database_does_not_sell_for_editing_stops_the_job_and_no_other_is_tried(self):
        q, loop = self.run_job(sold=(OPENAI,))        # the job's gemini is not on sale
        self.failed_before_any_spend(q, loop, "model_not_available")
        self.assertEqual(self.resolved, [GEMINI], "only the model the person picked was ever looked up")
        self.assertEqual(q.sold_asked, ["edit"])

    def test_an_unreadable_sellable_list_is_not_every_model(self):
        q, loop = self.run_job(sold=None)
        self.failed_before_any_spend(q, loop, "model_not_available")

    def test_a_model_that_cannot_edit_or_is_gated_stops_the_job(self):
        q, loop = self.run_job(region_job(requested_model="flux-2-pro"), model="flux-2-pro", sold=("flux-2-pro",))
        self.failed_before_any_spend(q, loop, "model_cannot_edit")

    def test_routed_modes_are_refused_because_a_failover_would_be_another_model(self):
        q, loop = self.run_job(region_job(mode="cheap"))
        self.failed_before_any_spend(q, loop, "mode_not_supported")
        self.assertEqual(self.resolved, [])

    def test_there_is_no_reroute_even_when_every_region_fails(self):
        class NoReroute(RegionQueue):
            def reroute(self, *a, **k):
                raise AssertionError("a region edit must never ask for another model")

        entry = reg.get(GEMINI)
        loop = Loopback(lambda n, r: (_ for _ in ()).throw(AdapterError("rate_limited", "slow down", not_accepted=True)))
        q = NoReroute(region_job(), ok_source(), sold=(GEMINI,))
        w = cw.CreativeWorker(q, lambda m: ca.RegistryAdapter(entry, loop), worker_id="w1", out_dir=self.out, credits=FakeCredits(9.0),
                              enforce=True, sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media,
                              library=cw.Library(self.store, self.media, None), region_editor=True)
        w.run_once()
        self.assertEqual(len(loop.requests), 3)
        self.assertEqual([s for _i, s, _c in self.report(q)], ["failed"] * 3)

    def test_no_adapter_for_the_model_stops_the_job(self):
        q = RegionQueue(region_job(), ok_source())
        w = cw.CreativeWorker(q, lambda m: None, worker_id="w1", out_dir=self.out, credits=FakeCredits(9.0), enforce=True,
                              sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media,
                              library=cw.Library(self.store, self.media, None), region_editor=True)
        w.run_once()
        self.assertEqual(q.finished["error_code"], "adapter_missing")
        self.assertNotIn("submitting", self.steps(q))

    def test_a_worker_without_a_library_does_not_start(self):
        q, loop = self.run_job(library=False)
        self.failed_before_any_spend(q, loop, "library_unavailable")

    def test_a_tiered_model_is_sent_exactly_the_tier_the_job_was_priced_at_or_nothing(self):
        q, loop = self.run_job(region_job(requested_model=OPENAI, routed_model=OPENAI), model=OPENAI)
        self.failed_before_any_spend(q, loop, "bad_request")
        self.setUp()
        q, loop = self.run_job(region_job(requested_model=OPENAI, routed_model=OPENAI, params={"quality": "high"}), model=OPENAI)
        self.assertTrue(q.finished["ok"])
        self.assertEqual({r.quality for r in loop.requests}, {"high"})
        self.setUp()
        q, loop = self.run_job(region_job(requested_model=OPENAI, routed_model=OPENAI, params={"quality": "ultra"}), model=OPENAI)
        self.failed_before_any_spend(q, loop, "bad_request")

    def test_a_request_the_adapter_refuses_is_a_refused_region_and_costs_nothing_at_the_vendor(self):
        loop = Loopback()
        loop.problem_list = ["prompt is longer than this model takes"]
        q, _ = self.run_job(adapter=loop)
        self.assertEqual([c for _i, _s, c in self.report(q)], ["bad_request"] * 3)
        self.assertEqual(loop.requests, [], "problems() refuses before submit: the vendor was not called")


class TheOrderThatCannotPayTwice(Base):
    def test_a_resumed_region_job_is_failed_not_polled_and_not_submitted(self):
        q, loop = self.run_job(region_job(provider_task_id=f"region:{JOB}", status="provider_pending"))
        self.assertEqual(q.finished["error_code"], "output_lost")
        self.assertEqual(loop.requests, [])
        self.assertEqual(self.steps(q), ["finish"])

    def test_a_job_that_is_no_longer_ours_before_the_first_call_is_left_alone(self):
        class Gone(RegionQueue):
            def advance(self, job_id, worker_id, step, task_id=None, route=None):
                self.calls.append(("advance", step, task_id))
                return False

        entry = reg.get(GEMINI)
        loop = Loopback()
        q = Gone(region_job(), ok_source(), sold=(GEMINI,))
        w = cw.CreativeWorker(q, lambda m: ca.RegistryAdapter(entry, loop), worker_id="w1", out_dir=self.out, credits=FakeCredits(9.0),
                              enforce=True, sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media,
                              library=cw.Library(self.store, self.media, None), region_editor=True)
        w.run_once()
        self.assertEqual(loop.requests, [])
        self.assertIsNone(q.finished)

    def test_a_job_lost_between_regions_stops_spending_and_is_left_for_the_sweep(self):
        holder = {}

        def behave(n, request):
            if n == 0:
                holder["beat"].lost.set()
            return Loopback.noise(n, request)

        real = cw._Heartbeat.__init__

        def spy(self_, *a, **k):
            real(self_, *a, **k)
            holder["beat"] = self_

        with mock.patch.object(cw._Heartbeat, "__init__", spy):
            q, loop = self.run_job(behave=behave)
        self.assertEqual(len(loop.requests), 1, "the second region is not paid for once the job is lost")
        self.assertIsNone(q.finished)
        self.assertNotIn("submitted", self.steps(q))

    def test_a_result_that_cannot_be_stored_fails_the_job_with_nothing_charged(self):
        self.store.fail = True
        q, _ = self.run_job()
        self.assertFalse(q.finished["ok"])
        self.assertEqual(q.finished["error_code"], "result_not_stored")
        self.assertNotIn("regions", q.finished["result"] or {})

    def test_a_result_the_database_will_not_attach_fails_the_job_too(self):
        q, _ = self.run_job(attach=False)
        self.assertFalse(q.finished["ok"])
        self.assertEqual(q.finished["error_code"], "result_not_stored")

    def test_a_database_that_is_out_of_reach_leaves_the_job_for_the_stale_sweep(self):
        class Down(RegionQueue):
            def sellable_models(self, capability):
                raise cw.CreativeUnavailable("sellable_models: HTTP 503")

        entry = reg.get(GEMINI)
        loop = Loopback()
        q = Down(region_job(), ok_source())
        w = cw.CreativeWorker(q, lambda m: ca.RegistryAdapter(entry, loop), worker_id="w1", out_dir=self.out, credits=FakeCredits(9.0),
                              enforce=True, sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media,
                              library=cw.Library(self.store, self.media, None), region_editor=True)
        w.run_once()
        self.assertEqual(loop.requests, [])
        self.assertIsNone(q.finished)


class TheSource(Base):
    def test_a_source_the_database_refuses_stops_the_job_before_any_spend(self):
        q, loop = self.run_job(source={"ok": False, "problem": "source_asset_id names no image in this organization's library"})
        self.assertEqual(q.finished["error_code"], "source_unavailable")
        self.assertEqual(loop.requests, [])
        self.assertNotIn("submitting", self.steps(q))

    def test_a_source_that_is_not_a_picture_stops_the_job(self):
        q, loop = self.run_job(source=ok_source(kind="video"))
        self.assertEqual(q.finished["error_code"], "source_unavailable")
        self.assertEqual(loop.requests, [])

    def test_an_unreadable_source_file_stops_the_job_before_submitting(self):
        put_asset(self.media, SRC, b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        q, loop = self.run_job()
        self.assertEqual(q.finished["error_code"], "source_unavailable")
        self.assertEqual(loop.requests, [])
        self.assertNotIn("submitting", self.steps(q))
        self.assertNotIn(str(self.media), q.finished["error"])


class ThePixelLockIsVerifiedAfterTheComposite(Base):
    """A region whose edit would break the lock counts as FAILED (not charged) and the others stand."""

    def breaking(self, which):
        real = re_.composite_regions

        def bad(original, edits, feather):
            out = real(original, edits, feather)
            if any(r.name in which for r, _e, _b in edits):
                out[0, 0, 0] ^= 0x55          # a pixel outside every region
                out[0, 0, 3] ^= 0x01          # and the alpha
            return out

        return mock.patch.object(re_, "composite_regions", bad)

    def test_the_region_that_broke_the_lock_is_failed_and_the_others_are_kept(self):
        with self.breaking({"Region 2"}):
            q, _ = self.run_job()
        self.assertEqual(self.report(q), [("r1", "applied", None), ("r2", "failed", "pixel_lock_failed"), ("r3", "applied", None)])
        after, _ = self.stored_result()
        before = np.array(self.original.convert("RGBA"))
        self.assertTrue(np.array_equal(before[20:70, 120:180], after[20:70, 120:180]), "the failed region is untouched in the result")
        self.assertTrue(np.array_equal(before[0, 0], after[0, 0]), "the lock holds on the stored picture")
        self.assertFalse(np.array_equal(before[10:60, 10:70], after[10:60, 10:70]), "an applied region did change")

    def test_when_every_region_breaks_it_nothing_is_stored_and_all_are_failed(self):
        with self.breaking({"Region 1", "Region 2", "Region 3"}):
            q, _ = self.run_job()
        self.assertEqual([(s, c) for _i, s, c in self.report(q)], [("failed", "pixel_lock_failed")] * 3)
        self.assertEqual(self.store.rows, [])

    def test_a_combination_that_breaks_the_lock_only_together_fails_them_all(self):
        real = re_.composite_regions

        def bad(original, edits, feather):
            out = real(original, edits, feather)
            if len(edits) > 1:
                out[1, 1, 1] ^= 0x33
            return out

        with mock.patch.object(re_, "composite_regions", bad):
            q, _ = self.run_job()
        self.assertEqual([s for _i, s, _c in self.report(q)], ["failed"] * 3)
        self.assertEqual(self.store.rows, [])


class TheClosedWords(unittest.TestCase):
    def test_an_unknown_code_is_a_provider_error_never_a_sentence(self):
        for c in (None, "", "blocked by safety: sk-123", 7, "Policy", "x" * 80):
            self.assertEqual(cw.region_report_code(c), "provider_error", c)
        for c in cw.REGION_CODES:
            self.assertEqual(cw.region_report_code(c), c)

    def test_every_adapter_error_code_maps_to_a_word_the_database_accepts(self):
        from modules.capabilities.base import ERROR_CODES
        for code in ERROR_CODES:
            self.assertIn(cw.region_report_code(code), cw.REGION_CODES)

    def test_every_code_the_module_raises_for_a_region_is_in_the_list(self):
        for code in ("region_invalid", "region_too_small", "region_out_of_bounds", "crop_unavailable", "pixel_lock_failed", "bad_response"):
            self.assertIn(code, cw.REGION_CODES)
        self.assertTrue(cw.REGION_REFUSED_CODES <= set(cw.REGION_CODES))

    def test_the_wire_region_is_the_flat_mapping_the_module_reads(self):
        self.assertEqual(cw._wire_region(region(1, 3, 4, 20, 30)), {"x": 3, "y": 4, "w": 20, "h": 30, "name": "Region 1", "prompt": "change part 1"})
        self.assertEqual(cw._wire_region("x"), {})
        self.assertEqual(cw._wire_region({"rect": 5}), {})

    def test_only_an_edit_with_regions_is_a_region_job(self):
        self.assertTrue(cw.is_region_job({"capability": "edit", "params": {"regions": []}}))
        self.assertFalse(cw.is_region_job({"capability": "edit", "params": {"prompt": "x"}}))
        self.assertFalse(cw.is_region_job({"capability": "t2i", "params": {"regions": [1]}}))
        self.assertFalse(cw.is_region_job({"capability": "edit", "params": None}))


class RunJobRegions(unittest.TestCase):
    """modules/region_edit.run_job_regions on its own."""

    def wire(self, *rows):
        return [{"x": x, "y": y, "w": w, "h": h, "name": f"R{i}", "prompt": p} for i, (x, y, w, h, p) in enumerate(rows, start=1)]

    def test_each_region_is_judged_on_its_own_and_nothing_is_clamped(self):
        fake = Loopback()
        calls = []

        def edit(c):
            calls.append(c.index)
            return png(picture(c.size, seed=c.index))

        res = re_.run_job_regions(png(picture()), self.wire((10, 10, 60, 50, "a"), (310, 10, 60, 50, "b"), (10, 100, 8, 8, "c"), (100, 100, 40, 40, "d")), edit)
        self.assertEqual([(o.status, o.code) for o in res.outcomes], [("applied", None), ("refused", "region_out_of_bounds"),
                                                                       ("refused", "region_too_small"), ("applied", None)])
        self.assertEqual(calls, [0, 3])
        self.assertIsNotNone(res.png)

    def test_nothing_runnable_is_an_answer_not_an_exception(self):
        res = re_.run_job_regions(png(picture()), self.wire((400, 10, 60, 50, "a")), lambda c: b"")
        self.assertIsNone(res.png)
        self.assertEqual(res.outcomes[0].status, "refused")

    def test_a_non_object_region_is_refused(self):
        res = re_.run_job_regions(png(picture()), ["x", {}], lambda c: b"")
        self.assertEqual([(o.status, o.code) for o in res.outcomes], [("refused", "region_invalid"), ("refused", "region_invalid")])

    def test_the_feather_is_checked_first(self):
        with self.assertRaises(re_.RegionEditError) as cm:
            re_.run_job_regions(png(picture()), self.wire((10, 10, 60, 50, "a")), lambda c: b"", feather=99)
        self.assertEqual(cm.exception.code, "feather_invalid")

    def test_the_legacy_entry_still_refuses_when_no_region_has_words(self):
        with self.assertRaises(re_.RegionEditError) as cm:
            re_.run_region_edit(png(picture()), [re_.Region("r", "", 10, 10, 60, 50)], lambda c: b"")
        self.assertEqual(cm.exception.code, "no_prompt")


if __name__ == "__main__":
    unittest.main()
