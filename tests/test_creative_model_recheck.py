"""A model taken off sale between queue and submit is never sent (modules/creative_worker.py, "Still on sale"; film takes too).

What would break, and which test says so:

* a creative job or a film take queued while its model was on sale, then submitted to the vendor after a retirement, a hide, a lost
  price or a shutdown date took the model off sale (the vendor bills a call the platform no longer sells);
* the refusal read as a reason to try another model (rule 4), or as a submit the vendor may have taken (a failover, a stuck job);
* the refusal failing the job in a way that captures money: it must go through finish(ok=false), once, which 0036 settles as a release;
* an unreadable or unreachable answer read as "available" (rule 5): nothing is sent, and the job is left for the next claim;
* a job that already has a task id at the vendor abandoned because its model went off sale (it is polled, never re-asked);
* the operator's preview (0139: a hidden model marked operator_preview, only in the exempt organization) refused by the new look,
  or any other organization allowed through it.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from modules import creative_worker as cw
from modules import credits as credit_rules
from tests.test_creative_worker import Base, FakeAdapter, FakeQueue, PerModel, job, routed
from tests.test_film_orchestrator import FakeDb, FakeAdapter as FilmAdapter, Harness

EXEMPT = credit_rules.DEFAULT_ORG_ID


def steps(q):
    return [c[1] for c in q.calls if c[0] == "advance"]


def finishes(q):
    return [c for c in q.calls if c[0] == "finish"]


class CreativeJobStillOnSale(Base):
    def test_a_model_taken_off_sale_after_the_queue_is_never_submitted_and_the_job_fails_once_with_its_code(self):
        q = FakeQueue(job())
        q.off_sale.add("img-x")
        a = FakeAdapter()
        self.worker(q, a).run_once()
        self.assertEqual(a.log, [], "the vendor was called for a model no longer on sale")
        self.assertNotIn("submitting", steps(q), "submit_started_at was set for a job that is never sent")
        self.assertEqual(finishes(q), [("finish", False, "model_not_available")])
        self.assertIsNone(q.finished["charge"])  # the database releases the hold; the worker never names a charge
        self.assertIn("nothing was submitted", q.finished["error"])

    def test_a_model_still_on_sale_is_submitted_as_before_and_asked_right_before_submitting(self):
        q = FakeQueue(job())
        a = FakeAdapter()
        self.worker(q, a).run_once()
        self.assertEqual([x for x in a.log if x[0] == "submit"], [("submit", "img-x")])
        self.assertTrue(q.finished["ok"])
        names = [c[0] if c[0] != "advance" else c[1] for c in q.calls]
        self.assertLess(names.index("on_sale"), names.index("submitting"))
        self.assertIn(("on_sale", "t2i"), q.calls)

    def test_an_unreachable_answer_sends_nothing_and_leaves_the_job_for_the_next_claim(self):
        q = FakeQueue(job(), down_at="on_sale")
        a = FakeAdapter()
        w = self.worker(q, a)
        self.assertEqual(w.process(q.claim("w1")), "left")
        self.assertEqual(a.log, [])
        self.assertEqual(finishes(q), [], "a job whose model could not be checked was failed instead of left")
        self.assertNotIn("submitting", steps(q), "left with submit_started_at set, the sweep would fail it as submit_interrupted")

    def test_an_unreadable_answer_is_unknown_never_available(self):
        q = FakeQueue(job(), down_at="on_sale_unreadable")
        a = FakeAdapter()
        self.assertEqual(self.worker(q, a).process(q.claim("w1")), "left")
        self.assertEqual(a.log, [])
        self.assertEqual(finishes(q), [])

    def test_the_owners_switch_keeps_0124s_own_word(self):
        q = FakeQueue(job())
        q.switched_off.add("img-x")
        a = FakeAdapter()
        self.worker(q, a).run_once()
        self.assertEqual(a.log, [])
        self.assertEqual(finishes(q), [("finish", False, "model_temporarily_off")])

    def test_a_routed_job_off_sale_is_never_moved_to_another_model(self):
        q = FakeQueue(routed())
        q.reroutes = [{"model": "img-b", "credits": 9, "params": {"prompt": "a cat"}}]
        q.off_sale.add("img-a")
        m = PerModel()
        cw.CreativeWorker(q, m.resolve, worker_id="w1", out_dir=self.out, credits=None, enforce=False,
                          sleep=lambda s: None, heartbeat_seconds=0).run_once()
        self.assertEqual([x for x in m.log if x[0] == "submit"], [])
        self.assertFalse(any(c[0] == "reroute" for c in q.calls), "the refusal was offered to the router as a failover")
        self.assertEqual(finishes(q), [("finish", False, "model_not_available")])

    def test_a_job_already_at_the_vendor_is_polled_not_re_asked_or_abandoned(self):
        q = FakeQueue(job(provider_task_id="task-9", status="provider_pending"))
        q.off_sale.add("img-x")
        a = FakeAdapter()
        self.worker(q, a).run_once()
        self.assertEqual(a.log, [("poll", "task-9")])
        self.assertFalse(any(c[0] == "on_sale" for c in q.calls))
        self.assertTrue(q.finished["ok"])


PREVIEW = {"id": "img-x", "availability": "hidden", "verified_at": "2026-11-01T00:00:00Z", "capabilities": ["t2i"],
           "spec": {"operator_preview": True}}


class OperatorPreview(Base):
    def run_job(self, org, row):
        q = FakeQueue(job(org_id=org, credit_ref=None, quoted_credits=0))
        q.off_sale.add("img-x")  # sellable_models never lists a preview
        if row is not None:
            q.registry["img-x"] = row
        a = FakeAdapter()
        self.worker(q, a).run_once()
        return q, a

    def test_the_operators_preview_in_the_exempt_organization_is_still_sent(self):
        q, a = self.run_job(EXEMPT, PREVIEW)
        self.assertEqual([x for x in a.log if x[0] == "submit"], [("submit", "img-x")])
        self.assertTrue(q.finished["ok"])

    def test_a_preview_row_opens_nothing_for_any_other_organization(self):
        q, a = self.run_job("22222222-3333-4444-5555-666666666666", PREVIEW)
        self.assertEqual(a.log, [])
        self.assertFalse(any(c[0] == "registry_row" for c in q.calls))
        self.assertEqual(finishes(q), [("finish", False, "model_not_available")])

    def test_a_preview_disabled_unmarked_unprobed_or_past_its_date_is_not_sent(self):
        for name, row in [
            ("disabled", {**PREVIEW, "availability": "disabled"}),
            ("not marked", {**PREVIEW, "spec": {}}),
            ("marked with a string", {**PREVIEW, "spec": {"operator_preview": "true"}}),
            ("not probed", {**PREVIEW, "verified_at": None}),
            ("another capability", {**PREVIEW, "capabilities": ["t2v"]}),
            ("past its date", {**PREVIEW, "spec": {"operator_preview": True, "shutdown": {"on": "2000-01-01"}}}),
            ("no row", None),
        ]:
            with self.subTest(name):
                q, a = self.run_job(EXEMPT, row)
                self.assertEqual(a.log, [])
                self.assertEqual(finishes(q), [("finish", False, "model_not_available")])


class PastShutdown(unittest.TestCase):
    """0125's model_past_shutdown, mirrored for the one row the worker reads itself; the lab compares both on this corpus."""

    def test_the_date_and_the_fail_closed_cases(self):
        today = date(2026, 11, 22)
        for spec, want in [(None, False), ({}, False), ({"shutdown": {"on": "2026-11-23"}}, False),
                           ({"shutdown": {"on": "2026-11-22"}}, True), ({"shutdown": {"on": "2000-01-01"}}, True),
                           ({"shutdown": {"on": "not a date"}}, True), ({"shutdown": {"on": "2026-13-45"}}, True),
                           ({"shutdown": "2999-12-31"}, True), ({"shutdown": {"on": 20991231}}, True), ({"shutdown": None}, True)]:
            with self.subTest(spec=spec):
                self.assertIs(cw.past_shutdown(spec, today), want)


class FilmTakeStillOnSale(unittest.TestCase):
    def test_a_clip_model_taken_off_sale_is_never_submitted_and_both_tries_fail_as_bad_request_uncharged(self):
        db = FakeDb()
        db.off_sale.add("vid-clip")
        h = Harness(db)
        h.run()
        clip = h.adapters["vid-clip"]
        self.assertEqual(clip.submits, 0, "a take was sent for a model no longer on sale")
        self.assertLessEqual(set(h.resolved), {"img-key", "vid-clip", "tts-a"}, "a model no take names was asked")
        fails = [f for f in db.failed if f[0] == "clip"]
        self.assertTrue(fails)
        self.assertTrue(all(f[2] == "bad_request" and f[1] == "provider_error" for f in fails), fails)
        self.assertTrue(all("no longer on sale" in f[3] for f in fails))
        # Every clip job ended through finish(ok=false), and none of them recorded a submit.
        clip_jobs = [j for j in db.jobs.values() if j["params"].get("duration_s")]
        self.assertTrue(clip_jobs)
        for j in clip_jobs:
            self.assertEqual(j["finished"][:2], (False, "bad_request"))
            self.assertNotIn("submitting", j["steps"])
        self.assertEqual(db.settles, ["takes_failed"])

    def test_a_narration_voice_model_taken_off_sale_is_not_voiced(self):
        db = FakeDb()
        db.off_sale.add("tts-a")
        h = Harness(db)
        h.run()
        self.assertEqual(h.adapters["tts-a"].submits, 0)
        self.assertTrue([f for f in db.failed if f[0] == "narration" and f[2] == "bad_request"])

    def test_takes_whose_models_are_on_sale_run_as_before(self):
        db = FakeDb()
        h = Harness(db)
        h.run()
        self.assertEqual(db.failed, [])
        self.assertEqual(db.settles, ["completed"])
        self.assertEqual({c[1] for c in db.calls if c[0] == "on_sale"}, {"t2i", "i2v", "tts"})

    def test_an_unreachable_answer_sends_nothing_records_no_failure_and_leaves_the_segment(self):
        db = FakeDb()
        db.sale_down = True
        h = Harness(db)
        out = h.run()
        self.assertEqual((out.result, out.reason), ("left", "db_unavailable"))
        self.assertEqual(sum(a.submits for a in h.adapters.values()), 0)
        self.assertEqual(db.failed, [])
        self.assertEqual(db.settles, [])
        for j in db.jobs.values():
            self.assertNotIn("submitting", j["steps"])


if __name__ == "__main__":
    unittest.main()
