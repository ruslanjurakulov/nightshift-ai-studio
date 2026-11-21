"""The Film Studio segment worker (modules/film_orchestrator.py) against a fake 0171 and fake adapters.

What would break, and which test says so:

* a take kind the worker cannot make (key frame, clip, extend, narration), or a clip handed in without its last frame;
* a second model tried when the take's model fails (CLAUDE.md #4: no fallback model, ever), or a retry loop of the worker's own on top of
  0171's one attempt-2 take;
* a provider error stored under a word the live view does not know (FILM_ERROR_CODES), or the wrong one (an unknown voice read as a
  bad request; a moderation refusal read as a provider error, which loses what 0171 records about vendor billing);
* a worker that dies mid-take and a later worker that pays again (submits instead of polling the stored task id), or resubmits a
  call whose answer it cannot know;
* a take begun after the deadline, or after the organization's switch went off;
* the assembly begun without a usable clip, or never handed to the assembly session; settle called twice, or not at all;
* the narration's provenance drifting from the assembly's contract (segments on the film's clock, loudness null when unmeasured);
* a secret reaching a log line or a stored error.
"""

from __future__ import annotations

import copy
import logging
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest import mock

from modules import creative_worker as cw
from modules import film_orchestrator as fo

ORG = "0a000000-0000-4000-8000-00000000000a"
FILM = "0f000000-0000-4000-8000-00000000000f"
SEG = "5e000000-0000-4000-8000-000000000005"
SA = "51000000-0000-4000-8000-000000000001"
SB = "52000000-0000-4000-8000-000000000002"
SECRET = "sk-live-THIS-IS-A-SECRET-0123456789"


def tid() -> str:
    return str(uuid.uuid4())


class FakeDb:
    """0171's state machine as far as the worker can see it: the lease, the takes, the one retry, the 0.9 rule, the assembly, the
    settle. Every call is recorded."""

    def __init__(self, *, shots_b=1, deadline="2999-01-01T00:00:00Z", narration=True):
        self.calls = []
        self.on = True
        self.lost = False
        self.seg = {"id": SEG, "org_id": ORG, "film_id": FILM, "status": "running", "deadline_at": deadline,
                    "assembly": {"status": "planned"}}
        self.scenes_ = [
            {"id": SA, "position": 0, "first_frame": "keyframe", "last_frame": "none", "shot_count": 1, "planned_seconds": 10,
             "narration": "It begins."},
            {"id": SB, "position": 1, "first_frame": "previous", "last_frame": "none", "shot_count": shots_b, "planned_seconds": 8,
             "narration": "It ends."},
        ]
        self.takes_ = [self._take("keyframe", SA, 0, "img-key", {"aspect_ratio": "16:9"}),
                       self._take("clip", SA, 1, "vid-clip", {"duration_s": 10}, duration=10),
                       self._take("clip", SB, 1, "vid-clip", {"duration_s": 10}, duration=10)]
        for i in range(2, shots_b + 1):
            self.takes_.append(self._take("extend", SB, i, "vid-clip", {"duration_s": 10}, duration=10))
        if narration:
            self.takes_.append(self._take("narration", None, 0, "tts-a", {"voice_id": "voice_lab_1"}))
        self.jobs = {}
        self.assets = {}
        self.settles = []
        self.failed = []

    @staticmethod
    def _take(kind, scene, shot, model, params, duration=None):
        return {"id": tid(), "kind": kind, "scene_id": scene, "shot_index": shot, "attempt": 1, "status": "planned", "model": model,
                "params": params, "quantity": 1, "duration_s": duration, "job": None}

    def _t(self, take):
        return next(t for t in self.takes_ if t["id"] == take)

    def _lease(self, worker):
        if self.lost or self.seg.get("worker") != worker:
            raise fo.FilmRefused("lease_lost")

    # 0171 / 0198
    def claim(self, worker, stale):
        self.calls.append(("claim", worker))
        self.seg["worker"] = worker
        self.lost = False
        return copy.deepcopy(self.seg)

    def heartbeat(self, segment, worker):
        self.calls.append(("heartbeat",))
        return not self.lost and self.seg.get("worker") == worker

    def studio_on_for(self, org):
        return self.on

    def begin_take(self, take, worker):
        self._lease(worker)
        t = self._t(take)
        self.calls.append(("begin", t["kind"], t["scene_id"], t["attempt"]))
        if t["status"] == "running":
            return {"began": True}
        if self.seg["status"] != "running":
            raise fo.FilmRefused("not_running")
        t["status"] = "running"
        return {"began": True}

    def take_job(self, take, worker):
        self._lease(worker)
        t = self._t(take)
        cap = {"keyframe": "t2i", "clip": "i2v", "extend": "i2v", "narration": "tts"}[t["kind"]]
        if t["job"]:
            j = self.jobs[t["job"]]
            return {"ok": True, "replayed": True, "job_id": j["id"], "job_status": j["status"], "capability": cap,
                    "params": j["params"], "provider_task_id": j["task"], "submit_started": j["submitting"], "job_worker": j["worker"],
                    "inputs": j["inputs"], "narration": j["narration"]}
        params = dict(t["params"])
        inputs = []
        if cap == "i2v":
            params["source_asset_id"] = "src"
            inputs = [{"role": "first", "asset_id": "src", "mime": "image/png", "variants": []}]
        if cap in ("t2i", "i2v"):
            params["prompt"] = "a lighthouse"
        narration = None
        if cap == "tts":
            narration = [{"scene_id": s["id"], "position": s["position"], "planned_seconds": s["planned_seconds"],
                          "narration": s["narration"]} for s in self.scenes_]
        j = {"id": tid(), "status": "running", "task": None, "submitting": False, "worker": worker, "params": params,
             "inputs": inputs, "narration": narration, "steps": [], "assets": [], "finished": None}
        self.jobs[j["id"]] = j
        t["job"] = j["id"]
        return {"ok": True, "replayed": False, "job_id": j["id"], "job_status": "running", "capability": cap, "params": params,
                "provider_task_id": None, "submit_started": False, "job_worker": worker, "inputs": inputs, "narration": narration}

    def _fail_locked(self, t, failure, code, error):
        self.failed.append((t["kind"], failure, code, error))
        if t["attempt"] == 1 and self.seg["status"] == "running":
            t["status"] = "superseded"
            nt = dict(t, id=tid(), attempt=2, status="planned", job=None)
            self.takes_.append(nt)
            return {"status": "superseded", "retry_take_id": nt["id"]}
        t["status"] = "failed"
        return {"status": "failed"}

    def take_succeeded(self, take, worker, seconds, result, last_frame, task):
        self._lease(worker)
        t = self._t(take)
        self.calls.append(("succeeded", t["kind"], result, last_frame, task))
        if t["kind"] in ("clip", "extend"):
            secs = self.assets[result].get("duration_s")
            if secs is None or secs < 0.9 * t["duration_s"]:
                return {**self._fail_locked(t, "provider_error", "output_too_short", "short"), "accepted": False}
        t["status"] = "completed"
        t["result"], t["last_frame"] = result, last_frame
        return {"status": "completed", "accepted": True}

    def take_failed(self, take, worker, failure, code, error=None, units_done=None):
        self._lease(worker)
        t = self._t(take)
        self.calls.append(("failed", t["kind"], failure, code))
        return self._fail_locked(t, failure, code, error)

    def begin_assembly(self, segment, worker):
        self._lease(worker)
        self.calls.append(("begin_assembly",))
        if any(t["status"] not in ("completed", "superseded") for t in self.takes_):
            raise fo.FilmRefused("not_complete")
        self.seg["assembly"]["status"] = "running"
        return copy.deepcopy(self.seg)

    def record_assembly(self, segment, worker, ok, result):
        self._lease(worker)
        self.calls.append(("record_assembly", ok, result))
        self.seg["assembly"]["status"] = "completed" if ok else "failed"
        return copy.deepcopy(self.seg)

    def settle(self, segment, worker, reason):
        self.calls.append(("settle", reason))
        self.settles.append(reason)
        self.seg["status"] = "settled"
        return {"status": "settled", "settled": True}

    def expire(self):
        return 0

    def takes(self, segment):
        return [{k: v for k, v in t.items() if k not in ("job",)} for t in self.takes_]

    def scenes(self, film):
        return copy.deepcopy(self.scenes_)

    # the take's creative job
    def heartbeat_job(self, job, worker):
        return True

    def advance_job(self, job, worker, step, task=None, route=None):
        j = self.jobs[job]
        j["steps"].append(step)
        if step == "submitting":
            j["submitting"] = True
        if step == "submitted":
            j["task"] = task
        return True

    def attach_job_assets(self, job, worker, assets):
        self.jobs[job]["assets"] = list(assets)
        return True

    def finish_job(self, job, worker, ok, *, result=None, error_code=None, error=None):
        self.jobs[job]["finished"] = (ok, error_code, error)
        self.jobs[job]["status"] = "completed" if ok else "failed"

    def record_cost(self, job, usage):
        pass

    def count(self, name):
        return sum(1 for c in self.calls if c[0] == name)


class FakeMedia:
    def __init__(self, db: FakeDb, *, video_seconds=10.0, loudness=(-18.0, -2.0)):
        self.db = db
        self.video_seconds = video_seconds
        self.loud = loudness
        self.stored = {}

    def copy_input(self, item, dest, name):
        dest.mkdir(parents=True, exist_ok=True)
        p = dest / f"{name}.png"
        p.write_bytes(b"png")
        return p

    def store_file(self, path, *, asset_id, org_id, provenance, expect_kind, parent_asset_id=None):
        dur = self.video_seconds if expect_kind == "video" else (4.0 if expect_kind == "audio" else None)
        row = {"id": asset_id, "kind": expect_kind, "duration_s": dur, "provenance": dict(provenance), "parent": parent_asset_id}
        self.stored[asset_id] = row
        self.db.assets[asset_id] = row
        return row

    def last_frame(self, video, out):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"png")
        return out

    def duration(self, path):
        return 2.0

    def narration_mix(self, clips, out):
        self.mixed = list(clips)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"m4a")
        return out

    def loudness(self, path):
        return self.loud


class Err(Exception):
    def __init__(self, code, message="refused", http_status=None):
        super().__init__(message)
        self.code, self.message, self.http_status = code, message, http_status


class FakeAdapter:
    """One model's adapter. ``fail``: a list of errors (or None for success) consumed one submit at a time."""

    def __init__(self, model, fail=None, vendor_code=""):
        self.model = model
        self.fail = list(fail or [])
        self.submits = 0
        self.polls = 0
        self.adapter = type("Inner", (), {"last_vendor_code": vendor_code})()

    def submit(self, request):
        self.submits += 1
        if self.fail:
            e = self.fail.pop(0)
            if e is not None:
                raise e
        return f"task-{self.model}-{self.submits}"

    def poll(self, task_id, request, out_dir):
        self.polls += 1
        out_dir.mkdir(parents=True, exist_ok=True)
        f = out_dir / "output_0.bin"
        f.write_bytes(b"data")
        return cw.ProviderPoll(cw.SUCCEEDED, files=[f])


class Harness:
    def __init__(self, db=None, adapters=None, assemble=None, media=None, **kw):
        self.db = db or FakeDb()
        self.adapters = adapters or {m: FakeAdapter(m) for m in ("img-key", "vid-clip", "tts-a")}
        self.resolved = []
        self.tmp = tempfile.TemporaryDirectory()
        self.assembled = []

        def default_assemble(seg, **k):
            self.assembled.append((seg["id"], k["worker_id"]))
            self.db.record_assembly(seg["id"], k["worker_id"], True, "asm-asset")
            return fo.AssemblyOutcome(True, "asm-asset")

        def resolve(model):
            self.resolved.append(model)
            return self.adapters.get(model)

        self.media = media or FakeMedia(self.db)
        self.orch = fo.FilmOrchestrator(self.db, resolve, worker_id=kw.pop("worker_id", "w-1"), media=self.media,
                                        out_dir=Path(self.tmp.name), assemble=assemble or default_assemble,
                                        heartbeat_seconds=0, poll_seconds=0, sleep=lambda s: None, **kw)

    def run(self):
        return self.orch.run_once()


class TakeKinds(unittest.TestCase):
    def test_every_take_kind_is_made_and_the_assembly_then_the_settle_follow(self):
        h = Harness(FakeDb(shots_b=2))
        out = h.run()
        self.assertEqual(out.result, "settled")
        self.assertEqual({t["kind"]: t["status"] for t in h.db.takes_}, {"keyframe": "completed", "clip": "completed",
                                                                         "extend": "completed", "narration": "completed"})
        self.assertEqual(h.assembled, [(SEG, "w-1")])
        self.assertEqual(h.db.settles, ["completed"])

    def test_takes_run_key_frames_first_then_shots_in_scene_order_then_the_narration(self):
        h = Harness(FakeDb(shots_b=2))
        h.run()
        begun = [(c[1], c[2]) for c in h.db.calls if c[0] == "begin"]
        self.assertEqual(begun, [("keyframe", SA), ("clip", SA), ("clip", SB), ("extend", SB), ("narration", None)])

    def test_every_clip_is_handed_in_with_its_extracted_last_frame_registered_through_the_job(self):
        h = Harness()
        h.run()
        for c in (c for c in h.db.calls if c[0] == "succeeded" and c[1] in ("clip", "extend")):
            _, _, result, last, task = c
            self.assertIsNotNone(last)
            self.assertEqual(h.media.stored[last]["provenance"]["role"], "last_frame")
            self.assertEqual(h.media.stored[last]["parent"], result)
            self.assertTrue(task.startswith("task-vid-clip"))
        for j in h.db.jobs.values():
            for a in j["assets"]:
                self.assertEqual(h.media.stored[a]["provenance"]["job_id"], j["id"])
                self.assertIn("film_take_id", h.media.stored[a]["provenance"])

    def test_the_narration_provenance_is_the_assembly_contract(self):
        h = Harness(media=None)
        h.media.loud = (None, None)  # not measured: null, never a default
        h.run()
        narr = next(t for t in h.db.takes_ if t["kind"] == "narration")
        row = h.media.stored[narr["result"]]
        p = row["provenance"]
        self.assertEqual(set(p), {"job_id", "film_take_id", "segments", "loudness_lufs", "true_peak_db"})
        self.assertEqual(p["film_take_id"], narr["id"])
        self.assertIsNone(p["loudness_lufs"])
        self.assertIsNone(p["true_peak_db"])
        # On the film's clock: scene A starts at 0, scene B at 10 s; each one's words NARRATION_LEAD_S into it.
        self.assertEqual(p["segments"], [{"scene_id": SA, "start_s": 0.25, "end_s": 2.25},
                                         {"scene_id": SB, "start_s": 10.25, "end_s": 12.25}])
        self.assertEqual(fo.NARRATION_LEAD_S, 0.25)

    def test_measured_loudness_is_carried_as_measured(self):
        h = Harness()
        h.run()
        narr = next(t for t in h.db.takes_ if t["kind"] == "narration")
        p = h.media.stored[narr["result"]]["provenance"]
        self.assertEqual((p["loudness_lufs"], p["true_peak_db"]), (-18.0, -2.0))

    def test_a_narration_that_does_not_fit_its_scene_fails_whole_and_names_the_fix(self):
        h = Harness()
        h.media.duration = lambda path: 9.9  # 0.25 + 9.9 + 0.25 > the 8 s scene B
        h.run()
        fails = [f for f in h.db.failed if f[0] == "narration"]
        self.assertEqual(fails[0][2], "bad_request")
        self.assertIn("shorten its narration", fails[0][3])


class NoFallback(unittest.TestCase):
    def test_a_failed_take_gets_0171s_one_retry_and_nothing_more(self):
        h = Harness(adapters={"img-key": FakeAdapter("img-key"), "tts-a": FakeAdapter("tts-a"),
                              "vid-clip": FakeAdapter("vid-clip", fail=[Err("unavailable")])})
        h.run()
        clips_a = [t for t in h.db.takes_ if t["kind"] == "clip" and t["scene_id"] == SA]
        self.assertEqual([(t["attempt"], t["status"]) for t in clips_a], [(1, "superseded"), (2, "completed")])
        self.assertEqual(h.db.settles, ["completed"])

    def test_the_takes_model_is_the_only_model_ever_asked_and_a_failure_twice_settles_without_assembly(self):
        bad = FakeAdapter("vid-clip", fail=[Err("quota")] * 10)
        h = Harness(adapters={"img-key": FakeAdapter("img-key"), "tts-a": FakeAdapter("tts-a"), "vid-clip": bad,
                              "vid-cheap": FakeAdapter("vid-cheap")})
        h.run()
        self.assertEqual(set(h.resolved), {"img-key", "vid-clip", "tts-a"})
        self.assertEqual(h.adapters["vid-cheap"].submits, 0)
        # Scene A's clip: attempt 1 and 0171's attempt 2, nothing more; scene B's clip never begins (its first frame is missing).
        self.assertEqual(bad.submits, 2)
        self.assertNotIn(("begin", "clip", SB, 1), h.db.calls)
        self.assertEqual(h.db.count("begin_assembly"), 0)
        self.assertEqual(h.db.settles, ["takes_failed"])

    def test_a_too_short_clip_is_0171s_rejection_and_its_job_says_too_short(self):
        h = Harness()
        h.media.video_seconds = 5.0
        h.run()
        jobs = [j for j in h.db.jobs.values() if j["finished"] and j["finished"][1] == "too_short"]
        self.assertTrue(jobs)
        self.assertEqual(h.db.settles, ["takes_failed"])


class ErrorClasses(unittest.TestCase):
    def test_the_codes_map_onto_the_closed_list(self):
        cases = {("auth", None): "auth", ("not_configured", None): "auth", ("adapter_missing", None): "auth",
                 ("quota", None): "quota", ("plan_required", None): "plan_required", ("rate_limited", None): "rate_limited",
                 ("bad_request", "i2v"): "bad_request", ("policy", None): "moderated", ("provider_timeout", None): "timeout",
                 ("bad_response", None): "no_output", ("unavailable", None): "provider_error", ("weird_new_code", None): "provider_error",
                 (None, None): "provider_error"}
        for (code, cap), want in cases.items():
            self.assertEqual(fo.film_error_code(code, capability=cap), want, code)

    def test_an_unknown_voice_is_voice_not_found(self):
        self.assertEqual(fo.film_error_code("bad_request", vendor_code="voice_not_found", capability="tts"), "voice_not_found")
        self.assertEqual(fo.film_error_code("bad_request", http_status=404, capability="tts"), "voice_not_found")
        self.assertEqual(fo.film_error_code("bad_request", vendor_code="voice_not_found", capability="i2v"), "bad_request")

    def test_a_moderation_refusal_is_failed_as_moderated(self):
        h = Harness(adapters={"img-key": FakeAdapter("img-key", fail=[Err("policy"), Err("policy")]), "tts-a": FakeAdapter("tts-a"),
                              "vid-clip": FakeAdapter("vid-clip")})
        h.run()
        self.assertEqual([(f[1], f[2]) for f in h.db.failed if f[0] == "keyframe"], [("moderated", "moderated")] * 2)

    def test_plan_required_and_a_missing_voice_end_the_narration_with_their_own_words(self):
        for err, vendor, want in ((Err("plan_required"), "", "plan_required"), (Err("bad_request"), "voice_not_found", "voice_not_found")):
            tts = FakeAdapter("tts-a", fail=[err, err], vendor_code=vendor)
            h = Harness(adapters={"img-key": FakeAdapter("img-key"), "vid-clip": FakeAdapter("vid-clip"), "tts-a": tts})
            h.run()
            self.assertEqual({f[2] for f in h.db.failed if f[0] == "narration"}, {want})

    def test_every_code_the_worker_can_emit_is_in_the_closed_list(self):
        src = Path(fo.__file__).read_text(encoding="utf-8")
        import re
        emitted = set(re.findall(r'_TakeFailed\("([a-z_]+)"', src)) | set(fo._CODE_MAP.values()) | {"provider_error", "film_studio_off"}
        self.assertTrue(emitted <= fo.FILM_ERROR_CODES, emitted - fo.FILM_ERROR_CODES)
        self.assertEqual(fo.FILM_ERROR_CODES, {"auth", "quota", "plan_required", "rate_limited", "bad_request", "voice_not_found",
                                               "moderated", "provider_error", "timeout", "too_short", "no_output", "worker_lost",
                                               "film_studio_off"})
        # And at run time: every code handed to film_take_failed in every scenario above is one of them.
        for fail in (Err("auth"), Err("strange"), Err("policy"), Err("provider_timeout")):
            h = Harness(adapters={"img-key": FakeAdapter("img-key", fail=[fail, fail]), "tts-a": FakeAdapter("tts-a"),
                                  "vid-clip": FakeAdapter("vid-clip")})
            h.run()
            for c in (c for c in h.db.calls if c[0] == "failed"):
                self.assertIn(c[3], fo.FILM_ERROR_CODES)


class Crash(unittest.TestCase):
    def test_a_worker_that_dies_after_the_submit_is_resumed_by_polling_never_by_paying_again(self):
        db = FakeDb()
        clip = FakeAdapter("vid-clip")
        adapters = {"img-key": FakeAdapter("img-key"), "tts-a": FakeAdapter("tts-a"), "vid-clip": clip}
        first = Harness(db, adapters)
        real_poll = clip.poll

        def die(task_id, request, out_dir):
            db.lost = True  # the lease lapses while this worker is gone
            first.orch._lease.lost.set()
            return cw.ProviderPoll(cw.PENDING)

        clip.poll = die
        out = first.run()
        self.assertEqual(out.result, "left")
        self.assertEqual(db.settles, [])  # a lost lease settles nothing
        clip.poll = real_poll
        second = Harness(db, adapters, worker_id="w-2")
        # The next claim's worker owns the job now (0171 hands it the lease; the job row keeps the task id).
        for j in db.jobs.values():
            j["worker"] = "w-2"
        out = second.run()
        self.assertEqual(out.result, "settled")
        self.assertEqual(clip.submits, 2)  # scene A's clip once, scene B's clip once: never a second submit for A
        self.assertEqual(db.settles, ["completed"])

    def test_a_worker_that_died_during_the_paid_call_is_never_resubmitted(self):
        db = FakeDb()
        h = Harness(db)
        kf = db.takes_[0]
        kf["status"] = "running"
        db.seg["worker"] = "w-1"
        job = db.take_job(kf["id"], "w-1")
        db.jobs[job["job_id"]]["submitting"] = True  # 'submitting' recorded, no task id: the vendor may have it
        h.run()
        self.assertEqual(h.adapters["img-key"].submits, 1)  # only 0171's attempt 2, never the lost one again
        self.assertIn(("keyframe", "provider_error", "worker_lost", mock.ANY), [(f[0], f[1], f[2], mock.ANY) for f in db.failed])

    def test_a_synchronous_answer_lost_with_the_worker_is_no_output(self):
        db = FakeDb()
        h = Harness(db)
        kf = db.takes_[0]
        kf["status"] = "running"
        db.seg["worker"] = "w-1"
        job = db.take_job(kf["id"], "w-1")
        db.jobs[job["job_id"]].update(submitting=True, task="sync:abc")
        h.run()
        self.assertEqual(db.failed[0][2], "no_output")


class Stops(unittest.TestCase):
    def test_past_the_deadline_no_take_begins_and_the_segment_settles(self):
        h = Harness(FakeDb(deadline="2000-01-01T00:00:00Z"))
        h.run()
        self.assertEqual(h.db.count("begin"), 0)
        self.assertEqual(h.db.settles, ["deadline"])

    def test_the_organizations_switch_going_off_stops_new_takes_and_settles(self):
        h = Harness()
        orig = h.db.begin_take

        def begin(take, worker):
            out = orig(take, worker)
            h.db.on = False  # switched off while the first take runs
            return out

        h.db.begin_take = begin
        h.run()
        self.assertEqual(h.db.count("begin"), 1)
        self.assertEqual(h.db.settles, ["film_studio_off"])

    def test_a_hold_0171_lost_ends_the_drive_without_a_settle_of_ours(self):
        h = Harness()
        h.db.begin_take = lambda take, worker: {"began": False, "reason": "hold_lost"}
        out = h.run()
        self.assertEqual((out.result, out.reason), ("settled_by_db", "hold_lost"))
        self.assertEqual(h.db.settles, [])


class Assembly(unittest.TestCase):
    def test_an_assembly_that_succeeds_settles_completed_once(self):
        h = Harness()
        h.run()
        self.assertEqual(h.db.count("settle"), 1)
        self.assertEqual(h.db.settles, ["completed"])
        self.assertEqual([c for c in h.db.calls if c[0] == "record_assembly"], [("record_assembly", True, "asm-asset")])

    def test_an_assembly_that_fails_settles_with_its_reason(self):
        def bad(seg, **k):
            h.db.record_assembly(seg["id"], k["worker_id"], False, None)
            return fo.AssemblyOutcome(False, None, "render_failed", "the render ran out of time")

        h = Harness(assemble=bad)
        h.run()
        self.assertEqual(h.db.settles, ["render_failed"])

    def test_without_the_assembly_module_the_failure_is_recorded_then_settled(self):
        h = Harness()
        h.orch._assemble = None
        missing = ModuleNotFoundError("No module named 'modules.film_assembly'", name="modules.film_assembly")
        with mock.patch.object(fo.importlib, "import_module", side_effect=missing):
            h.run()
        self.assertEqual([c for c in h.db.calls if c[0] == "record_assembly"], [("record_assembly", False, None)])
        self.assertEqual(h.db.settles, ["assembly_unavailable"])
        self.assertLess(h.db.calls.index(("record_assembly", False, None)), h.db.calls.index(("settle", "assembly_unavailable")))

    def test_a_reclaim_during_the_assembly_runs_the_assembly_again(self):
        h = Harness()
        for t in h.db.takes_:
            t["status"] = "completed"
        h.db.seg["assembly"]["status"] = "running"
        h.run()
        self.assertEqual(h.db.count("begin"), 0)
        self.assertEqual(h.assembled, [(SEG, "w-1")])
        self.assertEqual(h.db.settles, ["completed"])

    def test_no_usable_clip_means_no_assembly(self):
        bad = FakeAdapter("vid-clip", fail=[Err("provider_error")] * 10)
        h = Harness(adapters={"img-key": FakeAdapter("img-key"), "tts-a": FakeAdapter("tts-a"), "vid-clip": bad})
        h.run()
        self.assertEqual(h.db.count("begin_assembly"), 0)
        self.assertEqual(h.assembled, [])
        self.assertEqual(h.db.count("settle"), 1)

    def test_the_lease_beats_through_the_assembly(self):
        h = Harness()
        h.orch.heartbeat_seconds = 0.01
        beats = []

        def slow(seg, **k):
            n = h.db.count("heartbeat")
            threading.Event().wait(0.2)
            beats.append(h.db.count("heartbeat") - n)
            h.db.record_assembly(seg["id"], k["worker_id"], True, "asm")
            return fo.AssemblyOutcome(True, "asm")

        h.orch._assemble = slow
        h.run()
        self.assertGreater(beats[0], 0)


class Secrets(unittest.TestCase):
    def test_a_secret_in_a_provider_message_reaches_no_log_and_no_stored_error(self):
        err = Err("unavailable", f"upstream said Authorization: Bearer {SECRET}")
        h = Harness(adapters={"img-key": FakeAdapter("img-key", fail=[err, err]), "tts-a": FakeAdapter("tts-a"),
                              "vid-clip": FakeAdapter("vid-clip")},
                    scrub=lambda s: s.replace(SECRET, "[redacted]"))
        with self.assertLogs("film_worker", level=logging.DEBUG) as logs:
            logging.getLogger("film_worker").info("start")
            h.run()
        self.assertNotIn(SECRET, "\n".join(logs.output))
        for f in h.db.failed:
            self.assertNotIn(SECRET, f[3] or "")
        for j in h.db.jobs.values():
            if j["finished"]:
                self.assertNotIn(SECRET, str(j["finished"]))


class Ebur128(unittest.TestCase):
    def test_the_summary_is_read_and_a_missing_one_is_unknown(self):
        tail = ("[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -17.3 LUFS\n    Threshold: -27.6 LUFS\n\n"
                "  Loudness range:\n    LRA:         3.1 LU\n\n  True peak:\n    Peak:       -1.8 dBFS\n")
        self.assertEqual(fo.parse_ebur128(tail), (-17.3, -1.8))
        self.assertEqual(fo.parse_ebur128("no summary here"), (None, None))


if __name__ == "__main__":
    unittest.main()
