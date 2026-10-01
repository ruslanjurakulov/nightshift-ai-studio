"""Generations from a library picture (migration 0046): edit, i2v, upscale,
remove_bg — the worker's side, the adapter seam, the Ideogram upscale call,
and outputs stored as library assets.

What must hold: the source is the one the DATABASE hands this worker for the
job it holds (never a path or URL from the params), it is copied by id from
the media volume, any problem fails the job before the paid call (so the hold
is released), a capability no wired vendor supports fails as
``capability_not_supported`` (never a fake result), and outputs land in the
job's organization's library with provenance."""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import media_library as ml
from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import CapabilityRequest, AdapterError
from tests.test_creative_worker import FakeAdapter, FakeCredits, FakeQueue, ORG, JOB, job

SRC = "ab0c1d1e-0000-4000-8000-00000000a5e7"
OTHER = "cd0c1d1e-0000-4000-8000-00000000b0b0"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class SourceQueue(FakeQueue):
    """FakeQueue plus 0046's worker functions."""

    def __init__(self, j, source=None, attach=True):
        super().__init__(j)
        self.source = source
        self.attach_answer = attach
        self.attached = None

    def job_source(self, job_id, worker_id):
        self.calls.append(("job_source", job_id, worker_id))
        return self.source

    def attach_assets(self, job_id, worker_id, ids):
        self.calls.append(("attach", list(ids)))
        self.attached = list(ids)
        return self.attach_answer


class RecordingAdapter(FakeAdapter):
    def submit(self, request):
        self.request = request
        return super().submit(request)


class FakeStore:
    def __init__(self, fail=False):
        self.rows = []
        self.fail = fail

    def register(self, **kw):
        if self.fail:
            raise RuntimeError("register_asset: HTTP 503")
        self.rows.append(kw)
        return {"id": kw["asset_id"], "storage_key": ml.storage_key(kw["asset_id"]), "reused": False}


def put_asset(media_root: Path, aid: str, data: bytes = PNG, variant: str = "original") -> Path:
    f = ml.asset_file(media_root, aid, variant)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(data)
    return f


def ok_source(aid=SRC, mime="image/png", variants=("thumb",)):
    return {"ok": True, "asset_id": aid, "storage_key": ml.storage_key(aid), "mime": mime,
            "variants": list(variants)}


def edit_job(**over):
    return job(capability="edit", params={"prompt": "make it night", "source_asset_id": SRC}, **over)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.out = root / "jobs"
        self.media = root / "media"
        self.media.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def worker(self, queue, adapter, **kw):
        kw.setdefault("media_root", self.media)
        return cw.CreativeWorker(queue, lambda m: adapter, worker_id="w1", out_dir=self.out,
                                 credits=FakeCredits(), enforce=True, sleep=lambda s: None,
                                 heartbeat_seconds=0, **kw)


class SourceResolution(Base):
    def test_the_source_is_copied_by_id_with_its_type_and_handed_to_the_adapter(self):
        put_asset(self.media, SRC)
        q = SourceQueue(edit_job(), source=ok_source())
        a = RecordingAdapter()
        self.worker(q, a).run_once()
        self.assertTrue(q.finished["ok"], q.finished)
        (path,) = a.request.input_files
        self.assertEqual(path.name, "source.png")  # the adapters read the type from the suffix
        self.assertEqual(path.parent, self.out / JOB / "input")  # a copy in the job's folder
        self.assertEqual(path.read_bytes(), PNG)
        # Asked of the database for THIS job and THIS worker, before any paid call.
        order = [c[0] if c[0] != "advance" else c[1] for c in q.calls if c[0] in ("job_source", "advance")]
        self.assertEqual(order[:2], ["job_source", "submitting"])
        self.assertIn(("job_source", JOB, "w1"), q.calls)

    def assert_refused_before_submit(self, q, a, why=None):
        self.worker(q, a).run_once()
        self.assertEqual(q.finished["ok"], False)
        self.assertEqual(q.finished["error_code"], "source_unavailable")
        self.assertNotIn(("advance", "submitting", None), q.calls)  # nothing paid, the hold is released
        self.assertEqual(a.log, [])
        self.assertNotIn(str(self.media), q.finished["error"])  # no path in the stored error
        if why:
            self.assertIn(why, q.finished["error"])

    def test_the_databases_refusal_fails_the_job_before_the_paid_call(self):
        q = SourceQueue(edit_job(), source={"ok": False, "problem": "source_asset_id names no image in this organization's library"})
        self.assert_refused_before_submit(q, RecordingAdapter(), "no image")

    def test_an_answer_for_another_asset_is_not_trusted(self):
        put_asset(self.media, OTHER)
        q = SourceQueue(edit_job(), source=ok_source(OTHER))
        self.assert_refused_before_submit(q, RecordingAdapter())

    def test_no_media_volume_means_no_source(self):
        q = SourceQueue(edit_job(), source=ok_source())
        a = RecordingAdapter()
        w = self.worker(q, a, media_root=None)
        w.run_once()
        self.assertEqual(q.finished["error_code"], "source_unavailable")
        self.assertEqual(a.log, [])

    def test_a_missing_file_or_a_symlink_is_refused(self):
        q = SourceQueue(edit_job(), source=ok_source())
        self.assert_refused_before_submit(q, RecordingAdapter(), "not on this worker")
        # A symlinked asset directory pointing elsewhere (another org's folder).
        put_asset(self.media, OTHER)
        d = ml.asset_dir(self.media, SRC)
        d.parent.mkdir(parents=True, exist_ok=True)
        d.symlink_to(ml.asset_dir(self.media, OTHER))
        q = SourceQueue(edit_job(), source=ok_source())
        self.assert_refused_before_submit(q, RecordingAdapter(), "not a plain file")

    def test_a_heic_photo_is_read_from_its_jpeg_display_copy(self):
        put_asset(self.media, SRC, b"\xff\xd8\xff jpeg", variant="display")
        q = SourceQueue(edit_job(), source=ok_source(mime="image/heic", variants=("thumb", "display")))
        a = RecordingAdapter()
        self.worker(q, a).run_once()
        self.assertEqual(a.request.input_files[0].name, "source.jpg")

    def test_a_resumed_job_polls_without_reading_the_source_again(self):
        q = SourceQueue(edit_job(provider_task_id="task-9", status="provider_pending"), source=None)
        a = RecordingAdapter()
        self.worker(q, a).run_once()
        self.assertTrue(q.finished["ok"])
        self.assertNotIn("job_source", [c[0] for c in q.calls])
        self.assertEqual(a.log, [("poll", "task-9")])

    def test_text_only_jobs_never_ask_for_a_source(self):
        q = SourceQueue(job(), source=None)
        self.worker(q, RecordingAdapter()).run_once()
        self.assertTrue(q.finished["ok"])
        self.assertNotIn("job_source", [c[0] for c in q.calls])


class OutputsIntoTheLibrary(Base):
    def test_outputs_become_assets_of_the_jobs_org_and_are_attached(self):
        put_asset(self.media, SRC)
        store = FakeStore()
        q = SourceQueue(edit_job(), source=ok_source())
        lib = cw.Library(store, self.media, None)
        a = RecordingAdapter()
        a.poll = lambda task_id, request, out_dir: self._png(out_dir)
        self.worker(q, a, library=lib).run_once()
        self.assertTrue(q.finished["ok"])
        (row,) = store.rows
        self.assertEqual(row["org"], ORG)
        self.assertEqual(row["source"], "generated")
        self.assertEqual(row["kind"], "image")
        self.assertEqual(row["mime"], "image/png")
        self.assertEqual(row["parent_asset_id"], SRC)  # an edit is a new version of its source
        self.assertEqual(row["provenance"]["job_id"], JOB)
        self.assertEqual(row["provenance"]["source_asset_id"], SRC)
        aid = row["asset_id"]
        self.assertEqual(aid, str(uuid.uuid5(cw.ASSET_NS, f"{JOB}:0")))  # a retry reuses the row
        self.assertTrue(ml.asset_file(self.media, aid, "original").is_file())
        self.assertEqual(q.attached, [aid])
        self.assertEqual(q.finished["result"]["storage"], "library")
        self.assertEqual(q.finished["result"]["asset_ids"], [aid])
        self.assertFalse((self.out / JOB).exists())  # scratch removed once in the library

    def _png(self, out_dir):
        out_dir.mkdir(parents=True, exist_ok=True)
        f = out_dir / "output_0.png"
        f.write_bytes(PNG)
        return cw.ProviderPoll(cw.SUCCEEDED, files=[f])

    def test_a_library_failure_never_loses_the_paid_result(self):
        put_asset(self.media, SRC)
        q = SourceQueue(edit_job(), source=ok_source())
        a = RecordingAdapter()
        a.poll = lambda task_id, request, out_dir: self._png(out_dir)
        self.worker(q, a, library=cw.Library(FakeStore(fail=True), self.media, None)).run_once()
        self.assertTrue(q.finished["ok"])
        self.assertEqual(q.finished["result"]["storage"], "worker")
        self.assertTrue((self.out / JOB / "output_0.png").is_file())

    def test_a_video_from_an_image_model_is_refused_by_the_library(self):
        f = Path(self.tmp.name) / "x.png"
        f.write_bytes(PNG)
        with self.assertRaises(ml.IngestReject):
            ml.store_generated(f, asset_id=str(uuid.uuid4()), org_id=ORG, store=FakeStore(),
                               media_root=self.media, tools=None, provenance={}, expect_kind="video")


class TheAdapterSeam(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.img = self.dir / "source.png"
        self.img.write_bytes(PNG)

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, cap, params, files=()):
        return cw.GenerationRequest(job_id=JOB, org_id=ORG, capability=cap, model="m", params=params,
                                    input_files=tuple(files))

    def test_params_map_to_a_capability_request(self):
        r = ca.capability_request(self.request("upscale", {"source_asset_id": SRC, "factor": 2, "prompt": "crisp"},
                                               [self.img]))
        self.assertEqual((r.capability, r.scale, r.prompt, r.input_images), ("upscale", 2, "crisp", (str(self.img),)))
        self.assertNotIn(ORG, r.end_user)  # opaque, stable
        self.assertEqual(ca.capability_request(self.request("i2v", {"duration_s": 5})).duration_s, 5)

    def test_a_capability_the_adapter_cannot_serve_is_refused_before_any_call(self):
        entry = reg.get("ideogram-upscale")
        calls = []

        class Session:
            def request(self, *a, **k):
                calls.append(a)
                raise AssertionError("no call may be made")

        adapter = build_adapter(entry.adapter, env={"IDEOGRAM_API_KEY": "k" * 20}, session=Session())
        ra = ca.RegistryAdapter(entry, adapter, sync_store={})
        with self.assertRaises(ca.CreativeAdapterError) as cm:
            ra.submit(self.request("remove_bg", {"source_asset_id": SRC}, [self.img]))
        self.assertEqual(cm.exception.code, "capability_not_supported")
        self.assertEqual(calls, [])

    def test_no_registry_model_claims_background_removal(self):
        # No wired vendor documents it, so nothing can be sold for it.
        self.assertEqual(reg.models("remove_bg"), [])

    def test_a_4x_upscale_is_refused_before_the_call_on_a_2x_model(self):
        entry = reg.get("ideogram-upscale")
        adapter = build_adapter(entry.adapter, env={"IDEOGRAM_API_KEY": "k" * 20})
        ra = ca.RegistryAdapter(entry, adapter, sync_store={})
        with self.assertRaises(ca.CreativeAdapterError) as cm:
            ra.submit(self.request("upscale", {"source_asset_id": SRC, "factor": 4}, [self.img]))
        self.assertEqual(cm.exception.code, "bad_request")

    def test_a_synchronous_vendor_is_written_out_by_the_first_poll(self):
        entry = reg.get("ideogram-upscale")
        sess = FakeSession([
            ("POST", "/upscale", 200, {"data": [{"url": "https://ideogram.ai/api/images/x.png", "is_image_safe": True}]}),
            ("GET", "ideogram.ai/api/images/x.png", 200, PNG),
        ])
        adapter = build_adapter(entry.adapter, env={"IDEOGRAM_API_KEY": "k" * 20}, session=sess)
        held = {}
        ra = ca.RegistryAdapter(entry, adapter, sync_store=held)
        req = self.request("upscale", {"source_asset_id": SRC, "factor": 2}, [self.img])
        task = ra.submit(req)
        self.assertTrue(task.startswith(ca.SYNC_PREFIX))
        post = sess.sent[0]
        self.assertEqual(post["url"], "https://api.ideogram.ai/upscale")
        self.assertEqual(post["headers"]["Api-Key"], "k" * 20)
        self.assertEqual(json.loads(post["files"]["image_request"][1]), {})
        self.assertEqual(post["files"]["image_file"][1], PNG)
        self.assertEqual(post["files"]["image_file"][2], "image/png")
        res = ra.poll(task, req, self.dir / "out")
        self.assertEqual(res.state, cw.SUCCEEDED)
        self.assertEqual(res.files[0].read_bytes(), PNG)
        self.assertEqual(held, {})
        self.assertEqual((res.usage.provider, res.usage.unit, res.usage.quantity), ("ideogram", "image", 1.0))
        # A restarted worker has lost a synchronous result: failed, never "succeeded".
        lost = ra.poll(ca.SYNC_PREFIX + "gone", req, self.dir / "out2")
        self.assertEqual((lost.state, lost.error_code), (cw.FAILED, "output_lost"))

    def test_the_vendor_refusing_a_key_is_a_typed_error(self):
        entry = reg.get("ideogram-upscale")
        sess = FakeSession([("POST", "/upscale", 401, {"error": "bad key"})])
        ra = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env={"IDEOGRAM_API_KEY": "k" * 20},
                                                     session=sess), sync_store={})
        with self.assertRaises(AdapterError) as cm:
            ra.submit(self.request("upscale", {"source_asset_id": SRC, "factor": 2}, [self.img]))
        self.assertEqual(cm.exception.code, "auth")
        self.assertEqual(cw.error_code_of(cm.exception), "auth")

    def test_resolve_is_exact(self):
        self.assertIsNone(ca.resolve("no-such-model"))
        ra = ca.resolve("veo-3.1", env={})
        self.assertEqual(ra.entry.id, "veo-3.1")
        self.assertEqual(ra.adapter.key, "video.veo")


class RegistryRules(unittest.TestCase):
    def test_upscale_needs_factors_and_a_source(self):
        e = reg.get("ideogram-upscale")
        self.assertEqual(e.upscale_factors, (2,))
        self.assertEqual(e.problems(CapabilityRequest("upscale", "", scale=2)), ["upscale needs an input image"])
        self.assertEqual(e.problems(CapabilityRequest("upscale", "", scale=2, input_images=("a.png",))), [])
        self.assertTrue(e.problems(CapabilityRequest("upscale", "", scale=4, input_images=("a.png",))))

    def test_upscale_without_factors_is_refused(self):
        doc = json.loads(reg.REGISTRY_PATH.read_text())
        m = next(x for x in doc["models"] if x["id"] == "ideogram-upscale")
        del m["upscale_factors"]
        self.assertTrue(any("upscale_factors" in e for e in reg.validate(doc)))

    def test_i2v_prompt_is_optional(self):
        e = reg.get("veo-3.1")
        probs = e.problems(CapabilityRequest("i2v", "", duration_s=e.durations_s[0], input_images=("a.png",)))
        self.assertNotIn("prompt is empty", probs)


class Compose(unittest.TestCase):
    def test_the_creative_worker_shares_the_media_volume_as_its_owner(self):
        import yaml

        svcs = yaml.safe_load((Path(__file__).resolve().parent.parent / "deploy" / "docker-compose.yml").read_text())["services"]
        cwk, media = svcs["creative-worker"], svcs["media-worker"]
        self.assertEqual(cwk["user"], media["user"])  # uid 1000 owns the media volume
        self.assertIn("media:/app/media", cwk["volumes"])
        self.assertEqual(cwk["environment"]["NIGHTSHIFT_MEDIA_DIR"], "/app/media")
        self.assertTrue(cwk["environment"]["NIGHTSHIFT_CREATIVE_DIR"].startswith("/app/media/."))
        # Running the container is the opt-in; once it runs it claims jobs.
        self.assertEqual(cwk["environment"][cw.ADAPTERS_ENV], "modules.creative_adapters:resolve")
        self.assertNotIn("media_staging:/app/media-staging", cwk["volumes"])


class FakeResp:
    def __init__(self, status, body):
        self.status_code = status
        self.content = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.text = self.content.decode("latin-1")
        self.headers = {}

    def json(self):
        return json.loads(self.content)

    def iter_content(self, chunk_size=1):
        yield self.content

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeSession:
    def __init__(self, script):
        self.script = list(script)
        self.sent = []

    def _answer(self, method, url, **kw):
        self.sent.append({"method": method, "url": url, **kw})
        for i, (m, frag, status, body) in enumerate(self.script):
            if m == method and frag in url:
                self.script.pop(i)
                return FakeResp(status, body)
        raise AssertionError(f"unexpected {method} {url}")

    def request(self, method, url, **kw):
        return self._answer(method, url, **kw)

    def get(self, url, **kw):
        return self._answer("GET", url, **kw)


if __name__ == "__main__":
    unittest.main()
