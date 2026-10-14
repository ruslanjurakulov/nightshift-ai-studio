"""The video ops (migration 0100): change a library video by a prompt, reframe
it to another shape, take its background out — the provider adapter, the
registry, the adapter seam, the worker and the migration, all through fake
sessions, so nothing here touches a network or spends anything.

The adapter is the repository's own GENERIC async dialect, UNVERIFIED against
any vendor. What must hold:

* nothing is called until the operator has set a key, an https host and both
  paths; a registry entry that still carries the placeholder vendor model is
  refused; either way the job fails before any call, so nothing is charged;
* the request is ``{model, operation, video, [prompt], [aspect_ratio]}`` with the
  library file inline (never a URL of ours), the key in a header only, and the
  result downloaded WITHOUT the key;
* a task id is validated before it goes into a URL, a result that is not https is
  refused, and a failed task fails the job so the database releases the hold;
* the registry entries that ship are not sellable by themselves: a terms gate, no
  price, web only, one op each, a placeholder model;
* 0100 is built on 0099's bodies: every string literal of every function it
  replaces is kept, and the closed lists agree in SQL, Python and TypeScript.
"""

from __future__ import annotations

import base64
import json
import re
import tempfile
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import media_library as ml
from modules import model_registry as reg
from modules import video_providers as vp
from modules.capabilities import build_adapter
from modules.capabilities import video_ops
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_POLICY,
    EXPAND_ASPECTS,
    FAILED,
    PENDING,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    ProviderTask,
)
from tests.test_capabilities import FakeResp, FakeSession
from tests.test_creative_media_inputs import FakeStore, SourceQueue, put_asset
from tests.test_creative_worker import JOB, ORG, FakeCredits, job

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
SQL_PATH = MIGRATIONS / "0100_video_ai_ops.sql"
KEY = "key_TOPSECRET-videoops-0123456789abcdef"
HOST = "https://ops.example.test"
ENV = {"VIDEO_OPS_API_KEY": KEY, "VIDEO_OPS_BASE_URL": HOST, "VIDEO_OPS_SUBMIT_PATH": "/v1/video/ops",
       "VIDEO_OPS_QUERY_PATH": "/v1/tasks/{id}"}
SRC = "ab0c1d1e-0000-4000-8000-000000000100"
TASK = "1f2e3d4c-5b6a-4789-8abc-def012345678"
OUT = "https://cdn.example.test/out.mp4?sig=x"
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 1024
MODELS = {"video_edit": "generic-video-edit", "video_reframe": "generic-video-reframe",
          "video_remove_bg": "generic-video-remove-bg"}
REAL = "acme-video-1"


class Recording(FakeSession):
    pass


def adapter(routes=(), env=ENV, downloads=None):
    return build_adapter("video.generic_ops", env=env, session=Recording(routes, downloads))


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def video(self, name="source.mp4", data=MP4) -> str:
        p = self.root / name
        p.write_bytes(data)
        return str(p)

    def req(self, cap, **kw):
        kw.setdefault("input_media", (self.video(),))
        return CapabilityRequest(capability=cap, **kw)


def entry(cap, vendor_model=REAL):
    e = reg.get(MODELS[cap])
    if vendor_model == e.vendor_model:
        return e
    raw = dict(e.raw, vendor_model=vendor_model)
    return reg._entry(raw)


SUBMIT = [("POST", "/v1/video/ops", FakeResp(200, {"id": TASK}))]


# ── the generic dialect ──────────────────────────────────────────────────────

class Dialect(unittest.TestCase):
    def test_the_words_and_keys_are_the_ones_the_pipelines_generic_client_speaks(self):
        cfg = vp.VideoProviderConfig(name="x", api_key="k", base_url="https://x", model="m", submit_path="/s", query_path="/q")
        self.assertEqual(video_ops.TASK_ID_KEYS, tuple(cfg.task_id_keys))
        self.assertEqual(video_ops.STATUS_KEYS, tuple(cfg.status_keys))
        self.assertEqual(video_ops.URL_KEYS, tuple(cfg.url_keys))
        self.assertEqual(video_ops.SUCCESS_WORDS, frozenset(vp._SUCCESS))
        self.assertEqual(video_ops.FAILURE_WORDS, frozenset(vp._FAILURE))
        self.assertEqual(video_ops.WRAPPERS, ("data", "result", "job", "resp", "response"))
        # …and flattening behaves the same way.
        for payload in ({"data": {"id": "a"}}, {"result": {"task_id": "b"}, "x": 1}, {"id": "c"}, [], None):
            self.assertEqual(video_ops.unwrap(payload), vp._unwrap(payload))


# ── configuration: nothing is called until the operator has set it all ───────

class Configuration(Tmp):
    def test_each_missing_setting_stops_the_job_before_any_call(self):
        for name in ENV:
            env = {k: v for k, v in ENV.items() if k != name}
            a = adapter(SUBMIT, env=env)
            self.assertFalse(a.configured(), name)
            with self.assertRaises(AdapterError) as cm:
                a.submit(self.req("video_remove_bg"), REAL)
            self.assertEqual(cm.exception.code, E_NOT_CONFIGURED, name)
            self.assertTrue(cm.exception.not_accepted, name)       # proof nothing was bought
            self.assertEqual(a.session.calls, [], name)
            self.assertIn(name if name != "VIDEO_OPS_API_KEY" else "VIDEO_OPS_API_KEY", str(cm.exception))
            self.assertNotIn(KEY, str(cm.exception))

    def test_a_host_that_is_not_https_or_a_path_that_is_not_a_path_counts_as_unset(self):
        for name, bad in (("VIDEO_OPS_BASE_URL", "http://ops.example.test"), ("VIDEO_OPS_SUBMIT_PATH", "https://evil.example/x"),
                          ("VIDEO_OPS_SUBMIT_PATH", "v1/video/ops"), ("VIDEO_OPS_QUERY_PATH", "/v1/tasks/"),
                          ("VIDEO_OPS_QUERY_PATH", "/v1/tasks/{id}?x=1")):
            a = adapter(SUBMIT, env={**ENV, name: bad})
            self.assertFalse(a.configured(), (name, bad))

    def test_the_placeholder_vendor_model_is_never_sent(self):
        a = adapter(SUBMIT)
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req("video_remove_bg"), video_ops.PLACEHOLDER_MODEL)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertEqual(a.session.calls, [])
        for cap in MODELS:
            problems = adapter().problems(self.req(cap, **self.good(cap)), entry(cap, video_ops.PLACEHOLDER_MODEL))
            self.assertTrue(any("placeholder vendor model" in p for p in problems), cap)
            self.assertEqual(adapter().problems(self.req(cap, **self.good(cap)), entry(cap)), [], cap)

    @staticmethod
    def good(cap):
        return {"video_edit": dict(prompt="make it night"), "video_reframe": dict(aspect_ratio="9:16"),
                "video_remove_bg": {}}[cap]


# ── the adapter ──────────────────────────────────────────────────────────────

class Adapter(Tmp):
    def test_the_edit_sends_the_prompt_and_the_video_inline_with_the_key_in_a_header(self):
        a = adapter(SUBMIT)
        task = a.submit(self.req("video_edit", prompt="  make it\nnight  "), REAL)
        (method, url, kw), = a.session.calls
        self.assertEqual((method, url), ("POST", f"{HOST}/v1/video/ops"))
        self.assertEqual(kw["headers"]["Authorization"], f"Bearer {KEY}")
        self.assertNotIn(KEY, url)
        body = kw["json"]
        self.assertEqual(sorted(body), ["model", "operation", "prompt", "video"])
        self.assertEqual((body["model"], body["operation"], body["prompt"]), (REAL, "edit", "make it night"))
        self.assertTrue(body["video"].startswith("data:video/mp4;base64,"))
        self.assertEqual(base64.b64decode(body["video"].split(",", 1)[1]), MP4)
        self.assertNotIn(KEY, json.dumps(body))
        self.assertEqual((task.task_id, task.adapter, task.vendor_model), (TASK, "video.generic_ops", REAL))

    def test_the_reframe_sends_the_shape_and_no_words_and_the_removal_neither(self):
        a = adapter(SUBMIT)
        a.submit(self.req("video_reframe", aspect_ratio="9:16"), REAL)
        body = a.session.calls[0][2]["json"]
        self.assertEqual(sorted(body), ["aspect_ratio", "model", "operation", "video"])
        self.assertEqual((body["operation"], body["aspect_ratio"]), ("reframe", "9:16"))
        a = adapter(SUBMIT)
        a.submit(self.req("video_remove_bg"), REAL)
        body = a.session.calls[0][2]["json"]
        self.assertEqual(sorted(body), ["model", "operation", "video"])
        self.assertEqual(body["operation"], "remove_background")

    def test_the_container_decides_the_declared_type(self):
        for suffix, mime in ((".mov", "video/quicktime"), (".webm", "video/webm"), (".mkv", "video/x-matroska")):
            a = adapter(SUBMIT)
            a.submit(self.req("video_remove_bg", input_media=(self.video(f"s{suffix}"),)), REAL)
            self.assertTrue(a.session.calls[0][2]["json"]["video"].startswith(f"data:{mime};base64,"))

    def test_the_task_id_is_found_wrapped_or_not_and_must_have_a_safe_shape(self):
        for payload in ({"id": TASK}, {"data": {"task_id": TASK}}, {"result": {"taskId": TASK}}):
            a = adapter([("POST", "/v1/video/ops", FakeResp(200, payload))])
            self.assertEqual(a.submit(self.req("video_remove_bg"), REAL).task_id, TASK)
        for payload in ({}, {"id": ""}, {"status": "ok"}):
            a = adapter([("POST", "/v1/video/ops", FakeResp(200, payload))])
            with self.assertRaises(AdapterError) as cm:
                a.submit(self.req("video_remove_bg"), REAL)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        a = adapter([("POST", "/v1/video/ops", FakeResp(200, {"id": "../../etc/passwd"}))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req("video_remove_bg"), REAL)
        self.assertEqual(cm.exception.code, E_NOT_FOUND)

    def test_a_vendor_error_never_carries_the_key(self):
        a = adapter([("POST", "/v1/video/ops", FakeResp(401, f"bad key {KEY}"))])
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req("video_remove_bg"), REAL)
        self.assertNotIn(KEY, str(cm.exception))
        self.assertTrue(cm.exception.not_accepted)

    def test_poll_reads_the_generic_status_words(self):
        task = ProviderTask("video.generic_ops", REAL, TASK)
        url = f"/v1/tasks/{TASK}"
        for body in ({"status": "running"}, {"state": "queued"}, {"data": {"status": "processing"}}, {}):
            self.assertEqual(adapter([("GET", url, FakeResp(200, body))]).poll(task).state, PENDING, body)
        for body in ({"status": "succeeded", "url": OUT}, {"state": "Done", "result": {"video_url": OUT}}, {"output_url": OUT}):
            r = adapter([("GET", url, FakeResp(200, body))]).poll(task)
            self.assertEqual((r.state, r.outputs[0].url), (SUCCEEDED, OUT), body)
        r = adapter([("GET", url, FakeResp(200, {"status": "failed", "error": "decode error"}))]).poll(task)
        self.assertEqual(r.state, FAILED)
        r = adapter([("GET", url, FakeResp(200, {"status": "rejected", "message": "blocked by safety policy"}))]).poll(task)
        self.assertEqual((r.state, r.error.code), (FAILED, E_POLICY))

    def test_a_result_without_a_url_or_off_https_is_refused_not_trusted(self):
        task = ProviderTask("video.generic_ops", REAL, TASK)
        for body in ({"status": "succeeded"}, {"status": "done", "url": "http://cdn.example.test/x.mp4"},
                     {"url": "file:///etc/passwd"}):
            with self.assertRaises(AdapterError) as cm:
                adapter([("GET", f"/v1/tasks/{TASK}", FakeResp(200, body))]).poll(task)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE, body)

    def test_a_task_id_from_a_job_row_cannot_steer_the_request(self):
        a = adapter([("GET", "/v1/tasks/", FakeResp(200, {"status": "running"}))])
        for bad in ("../admin", "a b", "x?y=1", "", None):
            with self.assertRaises(AdapterError) as cm:
                a.poll(ProviderTask("video.generic_ops", REAL, bad))
            self.assertEqual(cm.exception.code, E_NOT_FOUND, bad)
        self.assertEqual(a.session.calls, [])

    def test_the_result_is_downloaded_without_the_key(self):
        a = adapter([("GET", f"/v1/tasks/{TASK}", FakeResp(200, {"status": "done", "url": OUT}))],
                    downloads={OUT: FakeResp(200, content=MP4)})
        result = a.poll(ProviderTask("video.generic_ops", REAL, TASK))
        (path,) = a.fetch(result, self.root / "out")
        self.assertEqual((path.name, path.read_bytes()), ("output_0.mp4", MP4))
        download = [c for c in a.session.calls if c[0] == "DOWNLOAD"][0]
        self.assertNotIn(KEY, json.dumps({k: str(v) for k, v in download[2].items()}))
        self.assertFalse((download[2].get("headers") or {}))

    def test_problems_before_the_paid_call(self):
        cases = [
            ("video_edit", dict(), "words for what to change"),
            ("video_edit", dict(prompt="x" * 501), "at most 500"),
            ("video_edit", dict(prompt="x", aspect_ratio="1:1"), "keeps the video's own shape"),
            ("video_reframe", dict(), "needs one of the shapes"),
            ("video_reframe", dict(aspect_ratio="21:9"), "needs one of the shapes"),
            ("video_reframe", dict(aspect_ratio="1:1", prompt="x"), "takes no words"),
            ("video_remove_bg", dict(prompt="x"), "takes no words"),
            ("video_remove_bg", dict(aspect_ratio="1:1"), "keeps the video's own shape"),
            ("video_remove_bg", dict(duration_s=5), "takes no length"),
            ("video_remove_bg", dict(resolution="1080p"), "takes no length"),
            ("video_remove_bg", dict(upscale_target="4k"), "takes no length"),
        ]
        for cap, kw, why in cases:
            problems = adapter().problems(self.req(cap, **kw), entry(cap))
            self.assertTrue(any(why in p for p in problems), (cap, kw, problems))

    def test_a_url_a_picture_a_second_video_or_a_wrong_type_or_size_are_refused(self):
        e, a = entry("video_remove_bg"), adapter()
        cases = [
            (CapabilityRequest("video_remove_bg", input_media=("https://evil.example/a.mp4",)), "not an https URL"),
            (CapabilityRequest("video_remove_bg", input_media=(self.video(), self.video("b.mp4"))), "exactly one video"),
            (CapabilityRequest("video_remove_bg", input_media=(self.video("x.avi"),)), "MP4, MOV, WebM or MKV"),
            (CapabilityRequest("video_remove_bg", input_media=(self.video(),), input_images=(self.video("p.png"),)), "not a picture"),
        ]
        for req, why in cases:
            self.assertTrue(any(why in p for p in a.problems(req, e)), why)
        big = self.root / "big.mp4"
        with open(big, "wb") as fh:
            fh.truncate(a.MAX_BYTES + 1)
        self.assertTrue(any("at most 25 MB" in p for p in a.problems(CapabilityRequest("video_remove_bg", input_media=(str(big),)), e)))

    def test_submit_rechecks_what_it_needs_even_if_the_caller_did_not(self):
        for cap, kw in (("video_edit", {}), ("video_reframe", dict(aspect_ratio="21:9"))):
            a = adapter(SUBMIT)
            with self.assertRaises(AdapterError) as cm:
                a.submit(self.req(cap, **kw), REAL)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, cap)
            self.assertEqual(a.session.calls, [], cap)
        a = adapter(SUBMIT)
        with self.assertRaises(AdapterError):
            a.submit(CapabilityRequest("video_remove_bg", input_media=("https://evil.example/a.mp4",)), REAL)
        self.assertEqual(a.session.calls, [])


# ── the registry entries ─────────────────────────────────────────────────────

class Registry(unittest.TestCase):
    def test_each_op_is_its_own_entry_so_it_is_proven_and_priced_on_its_own(self):
        for cap, mid in MODELS.items():
            e = reg.get(mid)
            self.assertEqual((e.capabilities, e.adapter, e.output), ((cap,), "video.generic_ops", "video"))
            self.assertEqual(e.credit_unit, f"model_{mid.replace('-', '_')}_second")
        self.assertEqual(len({reg.get(m).credit_unit for m in MODELS.values()}), 3)

    def test_nothing_that_ships_can_be_sold_without_the_owner(self):
        for mid in MODELS.values():
            e = reg.get(mid)
            self.assertEqual(e.terms_gate, "terms_review_required", mid)    # beta/ga is refused while it is set
            self.assertEqual(e.api_exposure, "web_only", mid)
            self.assertEqual(e.vendor_model, video_ops.PLACEHOLDER_MODEL, mid)
            p = e.raw["pricing"]
            self.assertEqual((p["provider_usd_per_unit"], p["source_url"], p["as_of"], p["confirmed"]), (None, None, None, False), mid)
            self.assertNotIn("variants", p)
            self.assertIn("UNVERIFIED", e.raw["api_documented"]["note"])
            self.assertIn("UNVERIFIED", " ".join(e.raw["terms_notes"]))
            self.assertEqual(e.raw["api_documented"]["source"], "third_party")
            self.assertTrue(e.max_source_seconds)

    def test_a_reframe_model_lists_its_shapes(self):
        self.assertEqual(reg.get(MODELS["video_reframe"]).aspect_ratios_by_capability["video_reframe"], EXPAND_ASPECTS)

    def test_the_probe_asks_what_it_proves(self):
        r = reg.get(MODELS["video_edit"]).probe_request(generated_video="/p/v.mp4")
        self.assertEqual((r.capability, r.input_media, bool(r.prompt)), ("video_edit", ("/p/v.mp4",), True))
        r = reg.get(MODELS["video_reframe"]).probe_request(generated_video="/p/v.mp4")
        self.assertEqual((r.aspect_ratio, r.prompt), ("1:1", ""))
        r = reg.get(MODELS["video_remove_bg"]).probe_request(generated_video="/p/v.mp4")
        self.assertEqual((r.prompt, r.aspect_ratio), ("", None))

    def doc(self):
        return json.loads((REPO / "schemas" / "model_registry.json").read_text())

    def test_the_file_as_shipped_is_valid(self):
        self.assertEqual(reg.validate(self.doc()), [])

    def test_the_rules_a_video_op_entry_must_keep(self):
        def broken(mid, change):
            d = self.doc()
            for m in d["models"]:
                if m["id"] == mid:
                    change(m)
            return reg.validate(d)
        self.assertTrue(any("max_source_seconds" in e for e in broken(MODELS["video_edit"], lambda m: m["limits"].pop("max_source_seconds"))))
        self.assertTrue(any("video_reframe is required" in e for e in broken(MODELS["video_reframe"], lambda m: m.pop("aspect_ratios_by_capability"))))
        self.assertTrue(any("web_only" in e for e in broken(MODELS["video_edit"], lambda m: m.update(api_exposure="any"))))
        self.assertTrue(broken(MODELS["video_edit"], lambda m: m.update(capabilities=["video_edit", "edit"])))
        self.assertTrue(broken(MODELS["video_edit"], lambda m: m.update(output="image")))

    def test_the_sync_rows_carry_the_shapes_and_never_the_availability(self):
        rows = {r["id"]: r for r in reg.sync_rows(list(reg.registry().values()))}
        self.assertEqual(rows[MODELS["video_reframe"]]["spec"]["aspect_ratios_by_capability"]["video_reframe"], list(EXPAND_ASPECTS))
        self.assertEqual(rows[MODELS["video_edit"]]["spec"]["limits"]["max_source_seconds"], 30)
        for r in rows.values():
            self.assertNotIn("availability", r)


# ── the adapter seam and the worker ──────────────────────────────────────────

def op_job(cap, params, **over):
    m = MODELS[cap]
    return job(capability=cap, requested_model=m, routed_model=m, params={"source_asset_id": SRC, **params}, quantity="13", **over)


def video_source(mime="video/mp4", kind="video"):
    return {"ok": True, "asset_id": SRC, "storage_key": ml.storage_key(SRC), "mime": mime, "kind": kind,
            "variants": ["thumb"], "duration_s": 12.2}


class Seam(Tmp):
    def test_the_video_goes_to_the_adapter_as_media_with_its_shape_and_words(self):
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="video_reframe", model="m",
                                   params={"source_asset_id": SRC, "aspect_ratio": "9:16"},
                                   input_files=(Path("/w/source.mp4"),))
        cr = ca.capability_request(req)
        self.assertEqual((cr.input_media, cr.input_images, cr.aspect_ratio, cr.prompt, cr.duration_s),
                         (("/w/source.mp4",), (), "9:16", "", None))
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="video_edit", model="m",
                                   params={"source_asset_id": SRC, "prompt": "make it night"},
                                   input_files=(Path("/w/source.mp4"),))
        self.assertEqual(ca.capability_request(req).prompt, "make it night")

    def test_a_model_is_never_asked_for_an_op_it_does_not_list(self):
        e = reg.get(MODELS["video_edit"])
        ra = ca.RegistryAdapter(e, build_adapter(e.adapter, env=ENV, session=Recording()), sync_store={})
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="video_reframe", model=e.id,
                                   params={"source_asset_id": SRC, "aspect_ratio": "9:16"}, input_files=(Path(self.video()),))
        with self.assertRaises(ca.CreativeAdapterError) as cm:
            ra.submit(req)
        self.assertEqual(cm.exception.code, "capability_not_supported")
        self.assertEqual(ra.adapter.session.calls, [])

    def test_a_shape_the_model_was_not_proven_for_never_reaches_the_vendor(self):
        e = entry("video_reframe")
        raw = dict(e.raw, aspect_ratios_by_capability={"video_reframe": ["16:9"]})
        e = reg._entry(raw)
        ra = ca.RegistryAdapter(e, build_adapter(e.adapter, env=ENV, session=Recording()), sync_store={})
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="video_reframe", model=e.id,
                                   params={"source_asset_id": SRC, "aspect_ratio": "9:16"}, input_files=(Path(self.video()),))
        with self.assertRaises(ca.CreativeAdapterError) as cm:
            ra.submit(req)
        self.assertEqual(cm.exception.code, "bad_request")
        self.assertEqual(ra.adapter.session.calls, [])

    def test_usage_is_the_quantity_the_database_priced(self):
        e = reg.get(MODELS["video_edit"])
        ra = ca.RegistryAdapter(e, build_adapter(e.adapter, env=ENV, session=Recording()), sync_store={})
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="video_edit", model=e.id,
                                   params={"source_asset_id": SRC, "prompt": "x", "duration_s": 1}, quantity=13.0)
        u = ra.usage(req, 1)
        self.assertEqual((u.provider, u.unit, u.quantity), ("operator", "second", 13.0))

    def video(self):
        p = self.root / "source.mp4"
        p.write_bytes(MP4)
        return str(p)


class Worker(Tmp):
    def setUp(self):
        super().setUp()
        self.media = self.root / "media"
        self.media.mkdir()
        self.out = self.root / "jobs"

    def run_job(self, j, source, routes, downloads=None, store=None, vendor=REAL):
        q = SourceQueue(j, source=source)
        e = reg._entry(dict(reg.get(j["requested_model"]).raw, vendor_model=vendor))
        session = Recording(routes, downloads)
        ra = ca.RegistryAdapter(e, build_adapter(e.adapter, env=ENV, session=session), sync_store={})
        library = cw.Library(store=store, media_root=self.media) if store is not None else None
        w = cw.CreativeWorker(q, lambda m: ra if m == e.id else None, worker_id="w1", out_dir=self.out,
                              credits=FakeCredits(), enforce=True, sleep=lambda s: None, heartbeat_seconds=0,
                              media_root=self.media, library=library)
        w.run_once()
        return q, session

    def routes(self, status=None):
        return SUBMIT + [("GET", f"/v1/tasks/{TASK}", FakeResp(200, status or {"status": "done", "url": OUT}))]

    def test_each_op_runs_end_to_end_into_the_library_as_a_new_version(self):
        for cap, params in (("video_edit", {"prompt": "make it night"}), ("video_reframe", {"aspect_ratio": "9:16"}),
                            ("video_remove_bg", {})):
            put_asset(self.media, SRC, MP4)
            store = FakeStore()
            q, session = self.run_job(op_job(cap, params), video_source(), self.routes(),
                                      downloads={OUT: FakeResp(200, content=MP4)}, store=store)
            self.assertTrue(q.finished["ok"], (cap, q.finished))
            self.assertIn(("advance", "submitted", TASK), q.calls)
            (row,) = store.rows
            self.assertEqual((row["org"], row["kind"], row["parent_asset_id"]), (ORG, "video", SRC), cap)
            self.assertEqual(row["provenance"]["source_asset_id"], SRC, cap)
            self.assertEqual(q.costs[0].quantity, 13.0, cap)
            sent = session.calls[0][2]["json"]
            self.assertEqual(base64.b64decode(sent["video"].split(",", 1)[1]), MP4, cap)

    def test_a_deployment_without_a_provider_fails_the_job_before_any_call_and_releases_the_hold(self):
        put_asset(self.media, SRC, MP4)
        q = SourceQueue(op_job("video_remove_bg", {}), source=video_source())
        e = reg._entry(dict(reg.get(MODELS["video_remove_bg"]).raw, vendor_model=REAL))
        session = Recording(SUBMIT)
        ra = ca.RegistryAdapter(e, build_adapter(e.adapter, env={}, session=session), sync_store={})
        w = cw.CreativeWorker(q, lambda m: ra, worker_id="w1", out_dir=self.out, credits=FakeCredits(), enforce=True,
                              sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media)
        w.run_once()
        self.assertEqual(session.calls, [])
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "not_configured"))

    def test_the_placeholder_model_fails_the_job_before_any_call(self):
        put_asset(self.media, SRC, MP4)
        q, session = self.run_job(op_job("video_remove_bg", {}), video_source(), SUBMIT, vendor=video_ops.PLACEHOLDER_MODEL)
        self.assertEqual(session.calls, [])
        self.assertFalse(q.finished["ok"])

    def test_a_source_that_is_not_a_video_is_refused_before_any_call(self):
        put_asset(self.media, SRC, b"ID3\x04" + b"\x00" * 64)
        for source in (video_source("audio/mpeg", "audio"), video_source("video/mp4", "audio"), video_source("audio/mpeg", "video")):
            q, session = self.run_job(op_job("video_edit", {"prompt": "x"}), source, self.routes())
            self.assertEqual(session.calls, [], source)
            self.assertEqual(q.finished["error_code"], "source_unavailable", source)

    def test_a_vendor_failure_or_a_wrong_result_fails_the_job_so_the_hold_is_released(self):
        put_asset(self.media, SRC, MP4)
        q, _ = self.run_job(op_job("video_edit", {"prompt": "x"}), video_source(),
                            self.routes({"status": "failed", "error": "could not decode"}))
        self.assertFalse(q.finished["ok"])
        q, _ = self.run_job(op_job("video_edit", {"prompt": "x"}), video_source(),
                            self.routes({"status": "done", "url": "http://cdn.example.test/x.mp4"}))
        self.assertFalse(q.finished["ok"])


# ── 0100 is built on 0099's bodies ───────────────────────────────────────────

def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(sql):
    code = re.sub(r"--[^\n]*", "", sql)
    return set(re.findall(r"'(?:[^']|'')*'", code))


NEW = bodies(SQL_PATH.read_text())
CODE = "\n".join(line.split("--", 1)[0] for line in SQL_PATH.read_text().splitlines())
REPLACED = ("sellable_models", "creative_capability_supported", "creative_params_problem", "creative_source_problem",
            "creative_price", "model_registry_guard")


def latest_other(name):
    found = None
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if int(path.name[:4]) >= 100:
            continue
        b = bodies(path.read_text())
        if name in b:
            found = (path.name, b[name])
    assert found, name
    return found


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_it_replaces_exactly_these_functions_and_they_are_0099s(self):
        self.assertEqual(set(NEW), set(REPLACED))
        for name in REPLACED:
            self.assertEqual(latest_other(name)[0], "0099_image_ai_ops.sql", name)

    def test_every_function_keeps_every_literal_of_the_latest_other_body(self):
        for name in REPLACED:
            src, old = latest_other(name)
            for lit in literals(old):
                self.assertIn(lit, NEW[name], f"{name} lost {lit} from {src}")

    def test_the_video_ops_are_in_every_list_that_names_the_tools(self):
        for name in ("creative_capability_supported", "sellable_models"):
            self.assertIn("'video_edit', 'video_reframe', 'video_remove_bg'", NEW[name], name)
        self.assertIn("'expand', 'relight', 'erase',\n                                       'video_edit', 'video_reframe', 'video_remove_bg');",
                      NEW["creative_params_problem"])

    def test_the_price_is_the_videos_seconds_from_the_database_never_the_params(self):
        price = NEW["creative_price"]
        self.assertRegex(price, r"if cap in \('voice_change', 'dub', 'video_upscale', 'captions', 'video_edit', 'video_reframe', 'video_remove_bg'\) then\s+[\s\S]*?qty := public\.creative_source_seconds\(p_org, p_params\)")
        self.assertNotRegex(price, r"p_params\s*->>?\s*'duration_s'")
        # A model that states no longest input is not sold a length; a longer video is refused before any hold.
        self.assertIn("%s does not state the longest video it takes", price)
        self.assertIn("this model takes videos of up to %s seconds; trim this one first", price)
        self.assertIn("has no credit price yet", price)
        self.assertIn("%s does not reframe a video to %s", price)

    def test_the_params_rules(self):
        p = NEW["creative_params_problem"]
        for needle in ("aspect_ratio must be one of 16:9, 9:16, 1:1, 4:3, 3:4 for video_reframe",
                       "prompt must be plain text on one line for video_edit",
                       "prompt is longer than 500 characters for video_edit",
                       "reshaped or grown or reframed or voiced or told",
                       "or told or unworded) and p_params ? 'prompt'"):
            self.assertIn(needle, p)

    def test_the_source_check_is_the_videos_with_a_25_mb_limit(self):
        s = NEW["creative_source_problem"]
        self.assertIn("a.bytes > 26214400", s)
        self.assertIn("this video is larger than 25 MB; use a smaller copy", s)
        # …and the video upscale keeps its own words and its 200 MB.
        self.assertIn("this video type cannot be upscaled; use MP4, MOV, WebM or MKV", s)
        self.assertIn("a.bytes > 209715200", s)

    def test_the_margin_stays_private_and_the_earlier_lines_stay(self):
        self.assertNotIn("cp.margin,", NEW["sellable_models"])
        self.assertNotIn("'margin'", NEW["creative_price"])
        self.assertIn("'expand', 'relight', 'erase',", NEW["creative_capability_supported"])
        self.assertIn("%s does not extend a picture to %s", NEW["creative_price"])
        self.assertIn("%s does not transcribe %s", NEW["creative_price"])
        self.assertIn("if p_capability = 'captions' and p_surface <> 'web' then\n    return;", NEW["sellable_models"])

    def test_the_guard_reopens_the_proof_when_the_reframe_shapes_change(self):
        g = NEW["model_registry_guard"]
        self.assertIn("new.spec -> 'aspect_ratios_by_capability' -> 'video_reframe' is distinct from old.spec -> 'aspect_ratios_by_capability' -> 'video_reframe'", g)
        self.assertIn("new.spec -> 'relight_looks' is distinct from old.spec -> 'relight_looks'", g)
        self.assertNotIn("new.spec -> 'aspect_ratios_by_capability' is distinct", g)

    def test_the_closed_shape_list_is_the_same_everywhere(self):
        p = NEW["creative_params_problem"]
        lists = re.findall(r"not in \(('16:9'[^)]*)\)", p)
        self.assertEqual(len(lists), 2)
        for l in lists:
            self.assertEqual(tuple(re.findall(r"'([0-9:]+)'", l)), EXPAND_ASPECTS)
        ops = (REPO / "command-center" / "lib" / "creative" / "operations.ts").read_text()
        ts = re.search(r"EXPAND_ASPECTS = \[([^\]]*)\]", ops).group(1)
        self.assertEqual(tuple(re.findall(r'"([0-9:]+)"', ts)), EXPAND_ASPECTS)
        self.assertIn("MAX_VIDEO_EDIT_WORDS = 500", ops)

    def test_the_registry_checks_accept_the_new_capabilities_and_no_more_than_19(self):
        for needle in ("between 1 and 19", "'video_edit','video_reframe','video_remove_bg']::text[]",
                       "'video_edit', 'video_reframe', 'video_remove_bg'));"):
            self.assertIn(needle, CODE)

    def test_it_refuses_to_apply_without_0099(self):
        text = SQL_PATH.read_text()
        self.assertEqual(text.count("0100 needs 0099_image_ai_ops.sql: apply it first"), 2)
        self.assertLess(text.index("0100 needs 0099_image_ai_ops.sql"), text.index("create or replace function"))

    def test_a_later_migration_that_replaces_these_functions_must_know_the_video_ops(self):
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if int(path.name[:4]) <= 100:
                continue
            for name, body in bodies(path.read_text()).items():
                if name in ("sellable_models", "creative_capability_supported", "creative_params_problem",
                            "creative_source_problem", "creative_price"):
                    self.assertIn("'video_edit'", body, f"{path.name} replaces {name} without the video-op lines")

    def test_additive_and_scoped(self):
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate"):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")
        self.assertIn("-- Verify", SQL_PATH.read_text())
        for name, body in NEW.items():
            if "security definer" in body:
                self.assertIn("set search_path = public, pg_temp", body, name)

    def test_grants_are_revoke_then_grant_and_no_api_role_reaches_the_internals(self):
        for sig in ("public.creative_capability_supported(text)", "public.creative_params_problem(text, jsonb)",
                    "public.creative_source_problem(uuid, text, jsonb)", "public.creative_price(uuid, text, text, jsonb)"):
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", CODE)
            self.assertNotIn(f"grant execute on function {sig}", CODE)
        self.assertIn("revoke all on function public.sellable_models(text, text) from public, anon;\n"
                      "grant execute on function public.sellable_models(text, text) to authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.model_registry_guard() from public, anon, authenticated;", CODE)

    def test_the_verify_query_covers_the_new_rules_and_that_nothing_is_sold(self):
        text = SQL_PATH.read_text()
        verify = text[text.index("-- Verify"):]
        for needle in ("creative_capability_supported('video_edit')", "video_params_checked", "earlier_tools_kept",
                       "nothing_sold_yet", "functions_scoped"):
            self.assertIn(needle, verify)


if __name__ == "__main__":
    unittest.main()
