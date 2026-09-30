"""The creative worker (migration 0036, modules/creative_worker.py): what it
does with one claimed job, against an in-memory queue and fake adapters.

The rules pinned here are the ones that cost money when broken: the provider
is called at most once per job (the task id is stored before polling, and a
resumed job polls it), EXACT mode never tries another model, a job is run only
while its credit hold is open (when enforced), and nothing is charged for a
job that produced no file."""

from __future__ import annotations

import io
import os
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import yaml

from modules import creative_worker as cw
from modules import credits as credit_rules

ORG = "11111111-2222-3333-4444-555555555555"
JOB = "0f0e0d0c-0b0a-4000-8000-000000000001"


def job(**over):
    j = {"id": JOB, "org_id": ORG, "capability": "t2i", "mode": "exact", "payer": "credits",
         "requested_model": "img-x", "routed_model": "img-x", "params": {"prompt": "a cat"},
         "status": "running", "provider_task_id": None, "credit_ref": f"cj:{JOB}",
         "quoted_credits": 6}
    j.update(over)
    return j


class FakeQueue:
    """The 0036 worker functions, in memory, with the same refusals."""

    def __init__(self, j=None, *, down_at=None):
        self.job = dict(j) if j else None
        self.calls = []
        self.finished = None
        self.costs = []
        self.down_at = down_at
        self.heartbeat_answer = True

    def _maybe_down(self, what):
        if self.down_at == what:
            raise cw.CreativeUnavailable(f"{what}: HTTP 503")

    def claim(self, worker_id, stale_minutes=10):
        self.calls.append(("claim",))
        j, self.job = self.job, None
        if j:
            self.current = j
        return j

    def heartbeat(self, job_id, worker_id):
        self.calls.append(("heartbeat",))
        return self.heartbeat_answer

    def advance(self, job_id, worker_id, step, task_id=None, route=None):
        self._maybe_down(step)
        self.calls.append(("advance", step, task_id))
        j = self.current
        if step == "submitting":
            if j.get("submit_started_at") or j.get("provider_task_id"):
                return False
            j["submit_started_at"] = "now"
        elif step == "submitted":
            j["provider_task_id"] = task_id
        return True

    def finish(self, job_id, worker_id, ok, *, charge=None, result=None, error_code=None, error=None):
        self._maybe_down("finish")
        self.calls.append(("finish", ok, error_code))
        self.finished = {"ok": ok, "charge": charge, "result": result, "error_code": error_code,
                         "error": error}
        return {"status": "completed" if ok else "failed"}

    def record_cost(self, job_id, usage):
        self.costs.append(usage)


class FakeAdapter:
    def __init__(self, polls=None, submit_error=None, task_id="task-1", usage=None):
        self.polls = list(polls or ["ok"])
        self.submit_error = submit_error
        self.task_id = task_id
        self.usage = usage
        self.log = []

    def submit(self, request):
        self.log.append(("submit", request.model))
        if self.submit_error:
            raise self.submit_error
        return self.task_id

    def poll(self, task_id, request, out_dir):
        self.log.append(("poll", task_id))
        step = self.polls.pop(0) if self.polls else "ok"
        if isinstance(step, Exception):
            raise step
        if step == "pending":
            return cw.ProviderPoll(cw.PENDING)
        if step == "failed":
            return cw.ProviderPoll(cw.FAILED, error_code="content_policy", error="refused by the provider")
        if step == "empty":
            return cw.ProviderPoll(cw.SUCCEEDED, files=[])
        out_dir.mkdir(parents=True, exist_ok=True)
        f = out_dir / "output_0.png"
        f.write_bytes(b"\x89PNG fake image")
        return cw.ProviderPoll(cw.SUCCEEDED, files=[f], usage=self.usage)


class ProviderError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class FakeCredits:
    def __init__(self, amount=6.0, down=False):
        self.amount = amount
        self.down = down
        self.calls = []

    def start(self, ref, org):
        if self.down:
            raise credit_rules.CreditsUnavailable("start_credit_reservation: HTTP 503")
        self.calls.append(("start", ref, org))
        return self.amount


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.resolved = []

    def tearDown(self):
        self.tmp.cleanup()

    def worker(self, queue, adapter, *, credits=None, enforce=True, **kw):
        def resolve(model):
            self.resolved.append(model)
            return adapter

        kw.setdefault("heartbeat_seconds", 0)
        return cw.CreativeWorker(queue, resolve, worker_id="w1", out_dir=self.out,
                                 credits=credits if credits is not None else FakeCredits(),
                                 enforce=enforce, sleep=lambda s: None, **kw)


class HappyPath(Base):
    def test_the_task_id_is_stored_before_the_first_poll_and_the_job_is_settled(self):
        q = FakeQueue(job())
        usage = cw.ProviderUsage(provider="acme", vendor_model="img-x-1", unit="image", quantity=1)
        a = FakeAdapter(polls=["pending", "ok"], usage=usage)
        self.assertTrue(self.worker(q, a).run_once())
        steps = [c for c in q.calls if c[0] in ("advance", "finish")]
        self.assertEqual(steps, [("advance", "submitting", None), ("advance", "submitted", "task-1"),
                                 ("advance", "processing", None), ("finish", True, None)])
        self.assertEqual(a.log, [("submit", "img-x"), ("poll", "task-1"), ("poll", "task-1")])
        # Charge left to the database: the quote, which is the hold.
        self.assertIsNone(q.finished["charge"])
        files = q.finished["result"]["files"]
        self.assertEqual([f["name"] for f in files], ["output_0.png"])
        self.assertEqual(files[0]["mime"], "image/png")
        self.assertEqual(len(files[0]["sha256"]), 64)
        self.assertNotIn(str(self.out), repr(q.finished["result"]))  # no absolute paths
        self.assertTrue((self.out / JOB / "output_0.png").is_file())
        self.assertEqual(q.costs, [usage])

    def test_empty_queue_does_nothing(self):
        self.assertFalse(self.worker(FakeQueue(None), FakeAdapter()).run_once())


class NeverPayTwice(Base):
    def test_a_resumed_job_polls_its_stored_task_and_never_submits(self):
        q = FakeQueue(job(status="provider_pending", provider_task_id="task-77", attempts=2))
        a = FakeAdapter()
        self.worker(q, a).run_once()
        self.assertEqual(a.log, [("poll", "task-77")])
        self.assertFalse(any(c[1] in ("submitting", "submitted") for c in q.calls if c[0] == "advance"))
        self.assertTrue(q.finished["ok"])

    def test_no_submit_when_the_database_refuses_the_submitting_step(self):
        q = FakeQueue(job(submit_started_at="earlier"))
        a = FakeAdapter()
        self.assertTrue(self.worker(q, a).run_once())
        self.assertEqual(a.log, [])
        self.assertIsNone(q.finished)  # left for the stale sweep, which fails and releases it

    def test_a_task_id_that_cannot_be_stored_is_never_polled_or_resubmitted(self):
        q = FakeQueue(job(), down_at="submitted")
        a = FakeAdapter()
        self.worker(q, a).run_once()
        self.assertEqual(a.log, [("submit", "img-x")])
        self.assertIsNone(q.finished)

    def test_shutdown_while_waiting_hands_the_job_back_with_its_task(self):
        q = FakeQueue(job())
        a = FakeAdapter(polls=["pending"] * 5)
        stop = threading.Event()
        w = self.worker(q, a, stop=stop)
        w.sleep = lambda s: stop.set()
        w.run_once()
        self.assertIn(("advance", "requeue", None), q.calls)
        self.assertEqual([x for x in a.log if x[0] == "submit"], [("submit", "img-x")])
        self.assertIsNone(q.finished)

    def test_a_database_outage_at_finish_leaves_the_job_resumable(self):
        q = FakeQueue(job(), down_at="finish")
        self.assertEqual(self.worker(q, FakeAdapter()).process(q.claim("w1")), "left")


class ExactModeNeverFailsOver(Base):
    def test_a_provider_refusal_fails_the_job_without_trying_another_model(self):
        q = FakeQueue(job())
        a = FakeAdapter(submit_error=ProviderError("quota", "the provider balance is empty"))
        self.worker(q, a).run_once()
        self.assertEqual(self.resolved, ["img-x"])
        self.assertEqual(a.log, [("submit", "img-x")])
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "quota"))

    def test_no_adapter_for_the_model_fails_it_rather_than_substituting(self):
        q = FakeQueue(job())
        w = cw.CreativeWorker(q, lambda m: self.resolved.append(m), worker_id="w1",
                              out_dir=self.out, credits=FakeCredits(), enforce=True,
                              heartbeat_seconds=0)
        w.run_once()
        self.assertEqual(self.resolved, ["img-x"])
        self.assertEqual(q.finished["error_code"], "adapter_missing")

    def test_router_modes_are_refused_by_the_worker_too(self):
        q = FakeQueue(job(mode="auto"))
        a = FakeAdapter()
        self.worker(q, a).run_once()
        self.assertEqual(q.finished["error_code"], "mode_not_supported")
        self.assertEqual(a.log, [])

    def test_a_provider_failure_is_reported_with_its_code(self):
        q = FakeQueue(job())
        self.worker(q, FakeAdapter(polls=["failed"])).run_once()
        self.assertEqual(q.finished["error_code"], "content_policy")


class Polling(Base):
    def test_transient_poll_errors_are_retried_on_the_same_task(self):
        q = FakeQueue(job())
        a = FakeAdapter(polls=[ProviderError("network", "reset"), ProviderError("rate_limited", "429"), "ok"])
        self.worker(q, a).run_once()
        self.assertTrue(q.finished["ok"])
        self.assertEqual([x for x in a.log if x[0] == "submit"], [("submit", "img-x")])

    def test_a_permanent_poll_error_fails_the_job(self):
        q = FakeQueue(job())
        self.worker(q, FakeAdapter(polls=[ProviderError("auth", "key rejected")])).run_once()
        self.assertEqual(q.finished["error_code"], "auth")

    def test_a_provider_that_never_finishes_times_out_and_is_released(self):
        q = FakeQueue(job())
        ticks = iter(range(0, 10_000, 100))
        w = self.worker(q, FakeAdapter(polls=["pending"] * 100), max_poll_seconds=250,
                        clock=lambda: next(ticks))
        w.run_once()
        self.assertEqual(q.finished["error_code"], "provider_timeout")

    def test_success_without_a_file_is_not_charged(self):
        q = FakeQueue(job())
        self.worker(q, FakeAdapter(polls=["empty"])).run_once()
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "bad_response"))

    def test_a_job_taken_away_stops_being_polled(self):
        q = FakeQueue(job())
        q.heartbeat_answer = False
        a = FakeAdapter(polls=["pending"] * 1000)
        w = self.worker(q, a, heartbeat_seconds=0.01)
        w.sleep = lambda s: threading.Event().wait(0.02)
        self.assertEqual(w.process(q.claim("w1")), "left")
        self.assertIsNone(q.finished)


class Credits(Base):
    def test_enforced_a_hold_that_is_not_open_refuses_before_any_provider_call(self):
        q = FakeQueue(job())
        a = FakeAdapter()
        self.worker(q, a, credits=FakeCredits(amount=None)).run_once()
        self.assertEqual(q.finished["error_code"], "hold_not_open")
        self.assertEqual(a.log, [])

    def test_enforced_a_hold_below_the_quote_is_refused(self):
        q = FakeQueue(job())
        self.worker(q, FakeAdapter(), credits=FakeCredits(amount=2.0)).run_once()
        self.assertEqual(q.finished["error_code"], "hold_below_quote")

    def test_enforced_no_hold_and_credits_down_are_refusals(self):
        q = FakeQueue(job(credit_ref=None))
        self.worker(q, FakeAdapter()).run_once()
        self.assertEqual(q.finished["error_code"], "no_credit_hold")
        q = FakeQueue(job())
        self.worker(q, FakeAdapter(), credits=FakeCredits(down=True)).run_once()
        self.assertEqual(q.finished["error_code"], "credits_unavailable")

    def test_not_enforced_the_job_runs_without_an_open_hold(self):
        q = FakeQueue(job())
        self.worker(q, FakeAdapter(), credits=FakeCredits(amount=None), enforce=False).run_once()
        self.assertTrue(q.finished["ok"])

    def test_the_exempt_organization_needs_no_hold(self):
        fc = FakeCredits(amount=None)
        q = FakeQueue(job(org_id=credit_rules.DEFAULT_ORG_ID, credit_ref=None))
        self.worker(q, FakeAdapter(), credits=fc).run_once()
        self.assertTrue(q.finished["ok"])
        self.assertEqual(fc.calls, [])

    def test_the_hold_is_started_with_the_jobs_own_reference(self):
        fc = FakeCredits()
        q = FakeQueue(job())
        self.worker(q, FakeAdapter(), credits=fc).run_once()
        self.assertEqual(fc.calls, [("start", f"cj:{JOB}", ORG)])

    def test_api_balance_jobs_are_not_run_by_this_worker(self):
        q = FakeQueue(job(payer="api_balance"))
        self.worker(q, FakeAdapter()).run_once()
        self.assertEqual(q.finished["error_code"], "payer_not_supported")


class Secrets(Base):
    def test_a_key_echoed_by_the_provider_never_reaches_the_job_row(self):
        from tools.creative_worker import make_scrubber

        secret = "prov-key-0123456789abcdef"
        scrub = make_scrubber({"ACME_API_KEY": secret})
        q = FakeQueue(job())
        a = FakeAdapter(submit_error=ProviderError("auth", f"invalid key {secret}"))
        self.worker(q, a, scrub=scrub).run_once()
        self.assertEqual(q.finished["error_code"], "auth")
        self.assertNotIn(secret, q.finished["error"])
        self.assertNotIn(secret[:8], q.finished["error"])


class Cli(unittest.TestCase):
    def test_without_adapters_it_claims_nothing(self):
        from tools import creative_worker as tool

        env = {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "service-key-value-xyz"}
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(cw.CreativeRest, "claim", side_effect=AssertionError("claimed")):
            os.environ.pop(cw.ADAPTERS_ENV, None)
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertEqual(tool.main(["--once"]), 1)
        self.assertNotIn("service-key-value-xyz", buf.getvalue())

    def test_the_resolver_spec_is_module_colon_function(self):
        self.assertIs(cw.load_resolver("os.path:basename"), os.path.basename)
        for bad in ("", "os.path", ":basename", "os.path:"):
            with self.assertRaises(ValueError):
                cw.load_resolver(bad)


class Compose(unittest.TestCase):
    """deploy/docker-compose.yml: the service the owner starts by hand."""

    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parent.parent
        cls.services = yaml.safe_load((root / "deploy" / "docker-compose.yml").read_text())["services"]

    def test_creative_worker_is_behind_the_worker_profile(self):
        svc = self.services["creative-worker"]
        self.assertEqual(svc["profiles"], ["worker"])
        self.assertEqual(svc["command"], ["python", "tools/creative_worker.py"])
        self.assertEqual(svc["image"], self.services["worker"]["image"])
        self.assertEqual(svc["env_file"], self.services["worker"]["env_file"])

    def test_it_publishes_no_port_and_runs_unprivileged(self):
        svc = self.services["creative-worker"]
        self.assertNotIn("ports", svc)
        self.assertEqual(svc["cap_drop"], ["ALL"])
        self.assertIn("no-new-privileges:true", svc["security_opt"])
        self.assertEqual(svc["restart"], "unless-stopped")


if __name__ == "__main__":
    unittest.main()
