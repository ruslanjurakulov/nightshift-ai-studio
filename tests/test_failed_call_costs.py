"""Every vendor call gets exactly one cost row (0037), whatever the take's or job's outcome.

What would break, and which test says so:

* a take submitted to the vendor that then failed, timed out, answered without a file, or ran out of poll retries writes no row, so
  the spend watcher reads its spend as unknown and the known sum runs short of what the platform absorbs (0171 charges such takes 0);
* such a row reads as measured (it must say ``failed_call`` and carry no USD);
* a success writes two rows (the poll's and a failure path's), or a resumed job writes a second row for a call already recorded;
* a retry is not counted as the second call it is;
* a narration that fails on its second scene loses the first scene's row, or the failed scene's;
* a recording that raises changes the take's outcome, or logs a secret, a URL or a prompt.
"""

from __future__ import annotations

import itertools
import logging
import types
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import film_orchestrator as fo
from tests import test_creative_worker as tcw
from tests import test_film_orchestrator as tfo

FAILED_CALL = cw.FAILED_CALL_PRICE_SOURCE
URL = "https://vendor.example/v1/tasks?key=abc"


def _qty(unit, request, n_files):
    p = request.params or {}
    return {"second": p.get("duration_s"), "character": len(str(p.get("prompt") or "")), "image": n_files}.get(unit)


class FilmAdapter(tfo.FakeAdapter):
    """A film model with the registry adapter's ``usage(request, n_files)`` and a scripted poll: each step is "ok", "failed",
    "empty", "pending", or an exception to raise. Past the script every poll succeeds."""

    UNITS = {"img-key": "image", "vid-clip": "second", "tts-a": "character"}

    def __init__(self, model, steps=None, **kw):
        super().__init__(model, **kw)
        self.steps = list(steps or [])

    def usage(self, request, n_files):
        unit = self.UNITS[self.model]
        q = _qty(unit, request, n_files)
        return cw.ProviderUsage(provider="acme", vendor_model=self.model, unit=unit, quantity=float(q) if q is not None else None,
                                route="exact")

    def poll(self, task_id, request, out_dir):
        self.polls += 1
        step = self.steps.pop(0) if self.steps else "ok"
        if isinstance(step, BaseException):
            raise step
        if callable(step):
            return step()
        if step == "pending":
            return cw.ProviderPoll(cw.PENDING)
        if step == "failed":
            return cw.ProviderPoll(cw.FAILED, error_code="provider_error", error="the vendor failed it")
        if step == "empty":
            return cw.ProviderPoll(cw.SUCCEEDED, files=[], usage=self.usage(request, 0))
        out_dir.mkdir(parents=True, exist_ok=True)
        f = out_dir / "output_0.bin"
        f.write_bytes(b"data")
        return cw.ProviderPoll(cw.SUCCEEDED, files=[f], usage=self.usage(request, 1))


class CostDb(tfo.FakeDb):
    def __init__(self, *a, raise_on_cost=None, **kw):
        super().__init__(*a, **kw)
        self.costs = []
        self.raise_on_cost = raise_on_cost

    def record_cost(self, job, usage):
        if self.raise_on_cost is not None:
            raise self.raise_on_cost
        self.costs.append((job, usage))

    def rows(self, kind, attempt=None):
        """Cost rows of the takes of one kind (and attempt), in the order written."""
        jobs = {t["job"] for t in self.takes_ if t["kind"] == kind and (attempt is None or t["attempt"] == attempt) and t["job"]}
        return [u for j, u in self.costs if j in jobs]

    def take(self, kind, scene=None, attempt=1):
        return next(t for t in self.takes_ if t["kind"] == kind and t["attempt"] == attempt
                    and (scene is None or t["scene_id"] == scene))


def film(db=None, **steps):
    db = db or CostDb()
    adapters = {m: FilmAdapter(m, steps.get(m.replace("-", "_"))) for m in ("img-key", "vid-clip", "tts-a")}
    return tfo.Harness(db, adapters), db, adapters


class FilmSuccess(unittest.TestCase):
    def test_a_film_that_succeeds_writes_one_measured_row_per_call_and_never_two(self):
        h, db, _ = film()
        self.assertEqual(h.run().result, "settled")
        # One key frame, two clips, two narration scenes: five calls, five rows, none of them an estimate.
        self.assertEqual(len(db.costs), 5)
        self.assertTrue(all(u.price_source is None for _, u in db.costs))
        self.assertEqual(len(db.rows("keyframe")), 1)
        self.assertEqual([u.quantity for u in db.rows("narration")], [len("It begins."), len("It ends.")])
        per_job = {}
        for j, _ in db.costs:
            per_job[j] = per_job.get(j, 0) + 1
        self.assertEqual(sorted(per_job.values()), [1, 1, 1, 2])

    def test_a_storage_failure_after_a_delivered_answer_keeps_the_one_measured_row(self):
        h, db, _ = film()
        real = h.media.store_file
        calls = itertools.count()

        def fail_first(*a, **kw):
            if next(calls) == 0:
                raise OSError("disk full")
            return real(*a, **kw)

        h.media.store_file = fail_first
        h.run()
        self.assertEqual(db.failed[0][:3], ("keyframe", "provider_error", "no_output"))
        rows = db.rows("keyframe", attempt=1)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].price_source)  # the vendor delivered: its own usage, not an estimate
        self.assertEqual(rows[0].quantity, 1.0)


class FilmFailureExits(unittest.TestCase):
    def assert_one_failed_call(self, rows, quantity):
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0].price_source, FAILED_CALL)
        self.assertIsNone(rows[0].usd)
        self.assertEqual(rows[0].quantity, quantity)

    def test_a_take_the_vendor_failed_writes_one_failed_call_row_and_its_retry_a_second_row(self):
        h, db, _ = film(img_key=["failed"])
        h.run()
        self.assertEqual(db.take("keyframe")["status"], "superseded")
        # A picture that never came: 0 pictures, as the adapter's usage says for no file.
        self.assert_one_failed_call(db.rows("keyframe", attempt=1), 0.0)
        retry = db.rows("keyframe", attempt=2)
        self.assertEqual(len(retry), 1)
        self.assertIsNone(retry[0].price_source)
        self.assertEqual(len(db.rows("keyframe")), 2)  # a retry is a second call: a second row

    def test_a_success_without_a_file_writes_one_failed_call_row(self):
        h, db, _ = film(img_key=["empty"])
        h.run()
        self.assertEqual(db.failed[0][2], "no_output")
        self.assert_one_failed_call(db.rows("keyframe", attempt=1), 0.0)

    def test_a_timeout_writes_one_failed_call_row_for_the_requested_seconds(self):
        db = CostDb()
        adapters = {m: FilmAdapter(m) for m in ("img-key", "tts-a")}
        adapters["vid-clip"] = FilmAdapter("vid-clip", ["pending"] * 5)
        clock = itertools.count(0, 100)
        h = tfo.Harness(db, adapters, clock=lambda: float(next(clock)), max_poll_seconds=250)
        h.run()
        self.assertEqual(db.failed[0][:3], ("clip", "provider_error", "timeout"))
        self.assert_one_failed_call(db.rows("clip", attempt=1)[:1], 10.0)
        clip_a1 = db.take("clip", tfo.SA)
        self.assertEqual(len([u for j, u in db.costs if j == clip_a1["job"]]), 1)

    def test_poll_errors_past_the_limit_write_one_failed_call_row(self):
        h, db, adapters = film(vid_clip=[tfo.Err("unavailable")] * fo.MAX_POLL_ERRORS)
        h.run()
        self.assertEqual(adapters["vid-clip"].polls, fo.MAX_POLL_ERRORS + 2)  # the ten errors, then each clip's one good poll
        clip_a1 = db.take("clip", tfo.SA)
        rows = [u for j, u in db.costs if j == clip_a1["job"]]
        self.assert_one_failed_call(rows, 10.0)

    def test_a_poll_error_that_is_not_retried_writes_one_failed_call_row(self):
        h, db, _ = film(img_key=[tfo.Err("auth")])
        h.run()
        self.assertEqual(db.failed[0][2], "auth")
        self.assert_one_failed_call(db.rows("keyframe", attempt=1), 0.0)

    def test_a_task_id_that_could_not_be_stored_writes_one_failed_call_row(self):
        h, db, _ = film()
        real = db.advance_job
        db.advance_job = lambda job, w, step, task=None, route=None: False if step == "submitted" else real(job, w, step, task, route)
        out = h.run()
        self.assertEqual(out.result, "left")
        # Nobody will poll it again (submit_started with no task id fails as worker_lost): its row is written now.
        self.assert_one_failed_call(db.rows("keyframe"), 0.0)

    def test_a_lease_lost_mid_poll_leaves_the_row_to_the_claim_that_polls_the_task_next(self):
        db = CostDb()
        clip = FilmAdapter("vid-clip")
        adapters = {"img-key": FilmAdapter("img-key"), "tts-a": FilmAdapter("tts-a"), "vid-clip": clip}
        first = tfo.Harness(db, adapters)

        def lose():
            db.lost = True
            first.orch._lease.lost.set()
            return cw.ProviderPoll(cw.PENDING)

        clip.steps = [lose]
        self.assertEqual(first.run().result, "left")
        clip_a = db.take("clip", tfo.SA)
        self.assertEqual([u for j, u in db.costs if j == clip_a["job"]], [])
        self.assertEqual(tfo.Harness(db, adapters, worker_id="w-2").run().result, "settled")
        rows = [u for j, u in db.costs if j == clip_a["job"]]
        self.assertEqual(len(rows), 1)  # one call, one row, written by the claim that saw its outcome
        self.assertIsNone(rows[0].price_source)

    def test_a_resumed_job_that_was_already_storing_writes_no_second_row(self):
        db = CostDb()
        h = tfo.Harness(db, {m: FilmAdapter(m) for m in ("img-key", "vid-clip", "tts-a")})
        kf = db.takes_[0]
        kf["status"] = "running"
        db.seg["worker"] = "w-0"
        job = db.take_job(kf["id"], "w-0")
        db.jobs[job["job_id"]].update(submitting=True, task="task-img-key-9", status="processing")
        h.run()
        self.assertEqual(kf["status"], "completed")
        self.assertEqual([u for j, u in db.costs if j == job["job_id"]], [])

    def test_a_resumed_poll_that_fails_writes_the_calls_one_failed_call_row(self):
        db = CostDb()
        h = tfo.Harness(db, {"img-key": FilmAdapter("img-key", ["failed"]), "vid-clip": FilmAdapter("vid-clip"),
                             "tts-a": FilmAdapter("tts-a")})
        kf = db.takes_[0]
        kf["status"] = "running"
        db.seg["worker"] = "w-0"
        job = db.take_job(kf["id"], "w-0")
        db.jobs[job["job_id"]].update(submitting=True, task="task-img-key-9", status="provider_pending")
        h.run()
        rows = [u for j, u in db.costs if j == job["job_id"]]
        self.assert_one_failed_call(rows, 0.0)


class FilmNarration(unittest.TestCase):
    def test_a_narration_that_fails_on_its_second_scene_writes_one_row_per_scene_called(self):
        h, db, adapters = film(tts_a=["ok", "failed"])
        h.run()
        rows = db.rows("narration", attempt=1)
        self.assertEqual([(u.price_source, u.quantity) for u in rows],
                         [(None, float(len("It begins."))), (FAILED_CALL, float(len("It ends.")))])

    def test_a_narration_whose_scene_does_not_fit_keeps_both_measured_rows(self):
        h, db, _ = film()
        h.media.duration = lambda path: 9.0  # fits scene A's 10 s, not scene B's 8 s: fails after both scenes were voiced
        h.run()
        rows = db.rows("narration", attempt=1)
        self.assertEqual([u.price_source for u in rows], [None, None])

    def test_a_lease_lost_during_a_scene_writes_that_scenes_row_because_nobody_polls_it_again(self):
        db = CostDb()
        tts = FilmAdapter("tts-a")
        adapters = {"img-key": FilmAdapter("img-key"), "vid-clip": FilmAdapter("vid-clip"), "tts-a": tts}
        h = tfo.Harness(db, adapters)

        def lose():
            db.lost = True
            h.orch._lease.lost.set()
            return cw.ProviderPoll(cw.PENDING)

        tts.steps = ["ok", lose]
        self.assertEqual(h.run().result, "left")
        self.assertEqual([u.price_source for u in db.rows("narration")], [None, FAILED_CALL])


class FilmReportingOnly(unittest.TestCase):
    def test_a_recording_that_raises_changes_no_outcome_and_logs_only_its_type(self):
        for steps in ({}, {"img_key": ["failed"]}):
            with self.subTest(steps=steps):
                plain, plain_db, _ = film(**steps)
                plain_out = plain.run()
                boom = RuntimeError(f"POST {URL} Authorization: Bearer {tfo.SECRET}")
                h, db, _ = film(CostDb(raise_on_cost=boom), **steps)
                with self.assertLogs("film_orchestrator", level="DEBUG") as logs, \
                        self.assertLogs("creative_worker", level="WARNING") as cw_logs:
                    logging.getLogger("film_orchestrator").debug("start")
                    out = h.run()
                self.assertEqual((out.result, out.reason), (plain_out.result, plain_out.reason))
                self.assertEqual([(t["kind"], t["attempt"], t["status"]) for t in db.takes_],
                                 [(t["kind"], t["attempt"], t["status"]) for t in plain_db.takes_])
                text = "\n".join(logs.output + cw_logs.output)
                self.assertIn("provider cost not recorded (RuntimeError)", text)
                for leak in (tfo.SECRET, URL, "a lighthouse", "It begins."):
                    self.assertNotIn(leak, text)

    def test_a_usage_that_cannot_be_computed_writes_nothing_and_changes_nothing(self):
        h, db, adapters = film(img_key=["failed"])

        def broken(request, n):
            raise ValueError(tfo.SECRET)

        adapters["img-key"].usage = broken
        with self.assertLogs("creative_worker", level="WARNING") as logs:
            out = h.run()
        self.assertEqual(out.result, "settled")
        self.assertEqual(db.rows("keyframe", attempt=1), [])
        self.assertNotIn(tfo.SECRET, "\n".join(logs.output))


# ── the registry adapter's own usage, for a call that delivered nothing ─────

class RegistryUsage(unittest.TestCase):
    def adapter(self, unit):
        entry = types.SimpleNamespace(raw={"pricing": {"unit": unit}}, provider="acme", vendor_model_for=lambda cap: "vm-1")
        return ca.RegistryAdapter(entry, adapter=object(), sync_store={})

    def test_a_failed_call_is_priced_at_what_was_asked_with_no_usd(self):
        for unit, cap, params, qty in (("second", "i2v", {"duration_s": 8, "prompt": "x"}, 8.0),
                                       ("image", "t2i", {"prompt": "x"}, 0.0),
                                       ("character", "tts", {"prompt": "hello"}, 5.0)):
            with self.subTest(unit=unit):
                req = cw.GenerationRequest(job_id="j", org_id="o", capability=cap, model="m", params=params)
                u = cw.failed_call_usage(self.adapter(unit), req)
                self.assertEqual((u.unit, u.quantity, u.usd, u.price_source), (unit, qty, None, FAILED_CALL))

    def test_an_adapter_without_usage_falls_back_to_what_the_vendor_reported_else_nothing(self):
        req = cw.GenerationRequest(job_id="j", org_id="o", capability="t2i", model="m", params={})
        reported = cw.ProviderUsage(provider="acme", unit="image", quantity=0.0, usd=0.04, price_source="env")
        u = cw.failed_call_usage(object(), req, reported)
        self.assertEqual((u.provider, u.usd, u.price_source), ("acme", None, FAILED_CALL))
        self.assertIsNone(cw.failed_call_usage(object(), req))


# ── the creative (non-film) worker: the same gap, the same rule ─────────────

class CreativeAdapterWithUsage(tcw.FakeAdapter):
    """The creative fake, with ``usage(request, n_files)`` as the registry adapter has it."""

    def __init__(self, polls=None, **kw):
        super().__init__(polls=polls, **kw)
        del self.usage  # the method below, not the fake's reported-usage attribute

    def usage(self, request, n_files):
        return cw.ProviderUsage(provider="acme", vendor_model="img-x-1", unit="image", quantity=float(n_files), route="exact")

    def poll(self, task_id, request, out_dir):
        self.log.append(("poll", task_id))
        step = self.polls.pop(0) if self.polls else "ok"
        if isinstance(step, BaseException):
            raise step
        if step == "pending":
            return cw.ProviderPoll(cw.PENDING)
        if step == "failed":
            return cw.ProviderPoll(cw.FAILED, error_code="content_policy", error=f"refused {tfo.SECRET}")
        if step == "empty":
            return cw.ProviderPoll(cw.SUCCEEDED, files=[])
        out_dir.mkdir(parents=True, exist_ok=True)
        f = Path(out_dir) / "output_0.png"
        f.write_bytes(b"\x89PNG fake image")
        return cw.ProviderPoll(cw.SUCCEEDED, files=[f], usage=self.usage(request, 1))


class RaisingQueue(tcw.FakeQueue):
    def __init__(self, *a, boom=None, **kw):
        super().__init__(*a, **kw)
        self.boom = boom

    def record_cost(self, job_id, usage):
        if self.boom is not None:
            raise self.boom
        super().record_cost(job_id, usage)


class CreativeWorkerCosts(tcw.Base):
    def run_job(self, polls, q=None, **kw):
        q = q or tcw.FakeQueue(tcw.job())
        a = CreativeAdapterWithUsage(polls=polls)
        self.worker(q, a, **kw).run_once()
        return q, a

    def assert_one_failed_call(self, q):
        self.assertEqual(len(q.costs), 1, q.costs)
        self.assertEqual((q.costs[0].price_source, q.costs[0].usd, q.costs[0].quantity), (FAILED_CALL, None, 0.0))

    def test_success_writes_one_measured_row(self):
        q, _ = self.run_job(["pending", "ok"])
        self.assertTrue(q.finished["ok"])
        self.assertEqual(len(q.costs), 1)
        self.assertIsNone(q.costs[0].price_source)
        self.assertEqual(q.costs[0].quantity, 1.0)

    def test_a_failed_task_writes_one_failed_call_row(self):
        q, _ = self.run_job(["failed"])
        self.assertEqual(q.finished["error_code"], "content_policy")
        self.assert_one_failed_call(q)

    def test_a_success_without_a_file_writes_one_failed_call_row(self):
        q, _ = self.run_job(["empty"])
        self.assertEqual(q.finished["error_code"], "bad_response")
        self.assert_one_failed_call(q)

    def test_a_timeout_writes_one_failed_call_row(self):
        clock = itertools.count(0, 100)
        q, _ = self.run_job(["pending"] * 5, clock=lambda: float(next(clock)), max_poll_seconds=250)
        self.assertEqual(q.finished["error_code"], "provider_timeout")
        self.assert_one_failed_call(q)

    def test_poll_errors_past_the_limit_write_one_failed_call_row(self):
        q, _ = self.run_job([tcw.ProviderError("unavailable", "down")] * cw.MAX_POLL_ERRORS)
        self.assertEqual(q.finished["error_code"], "unavailable")
        self.assert_one_failed_call(q)

    def test_a_task_id_that_could_not_be_stored_writes_one_failed_call_row(self):
        q = tcw.FakeQueue(tcw.job())
        real = q.advance
        q.advance = lambda job_id, w, step, task_id=None, route=None: (
            False if step == "submitted" else real(job_id, w, step, task_id, route))
        self.run_job(["ok"], q=q)
        self.assert_one_failed_call(q)

    def test_the_database_out_of_reach_while_settling_leaves_the_row_to_the_next_claim(self):
        # The job is left with its task id stored; the stale sweep re-queues it and the claim that polls it writes the row.
        q, _ = self.run_job(["ok"], q=tcw.FakeQueue(tcw.job(), down_at="finish"))
        self.assertIsNone(q.finished)
        self.assertEqual(q.costs, [])

    def test_a_resumed_job_whose_task_then_fails_writes_the_calls_one_row(self):
        # The worker that submitted it left the task stored without a row; the claim that sees the outcome writes it.
        q, a = self.run_job(["failed"], q=tcw.FakeQueue(tcw.job(status="provider_pending", provider_task_id="task-77")))
        self.assertNotIn(("submit", "img-x"), a.log)
        self.assert_one_failed_call(q)

    def test_a_storing_failure_after_a_delivered_file_writes_the_vendors_usage_once(self):
        q = tcw.FakeQueue(tcw.job())
        real = q.finish

        def boom(*a, **kw):
            if a[2] is True:
                raise ValueError("bad")
            return real(*a, **kw)

        q.finish = boom
        self.run_job(["ok"], q=q)
        self.assertEqual(q.finished["error_code"], "worker_error")
        self.assertEqual(len(q.costs), 1)
        self.assertIsNone(q.costs[0].price_source)

    def test_a_recording_that_raises_changes_no_outcome_and_logs_only_its_type(self):
        for polls, ok in ((["ok"], True), (["failed"], False)):
            with self.subTest(polls=polls):
                q = RaisingQueue(tcw.job(), boom=RuntimeError(f"{URL} {tfo.SECRET}"))
                with self.assertLogs("creative_worker", level="WARNING") as logs:
                    self.run_job(polls, q=q)
                self.assertEqual(q.finished["ok"], ok)
                text = "\n".join(logs.output)
                self.assertIn("provider cost not recorded (RuntimeError)", text)
                for leak in (tfo.SECRET, URL, "a cat"):
                    self.assertNotIn(leak, text)


if __name__ == "__main__":
    unittest.main()
