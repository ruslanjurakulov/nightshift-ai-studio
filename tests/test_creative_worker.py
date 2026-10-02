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

    def reroute(self, job_id, worker_id, code):
        """0075's reroute_creative_job: the next model from `self.reroutes`,
        with the database's refusals (exact, a stored task, not submitting)."""
        self.calls.append(("reroute", code))
        j = self.current
        if j.get("mode") == "exact" or j.get("provider_task_id") or not getattr(self, "reroutes", None):
            return None
        nxt = self.reroutes.pop(0)
        j["submit_started_at"] = None
        j["fallback_from"], j["routed_model"] = j.get("routed_model"), nxt["model"]
        return nxt


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

    def test_an_unknown_mode_is_refused_before_any_call(self):
        q = FakeQueue(job(mode="turbo"))
        a = FakeAdapter()
        self.worker(q, a).run_once()
        self.assertEqual(q.finished["error_code"], "mode_not_supported")
        self.assertEqual(a.log, [])

    def test_a_routed_job_without_its_routed_model_is_not_run(self):
        q = FakeQueue(job(mode="auto", routed_model=None))
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


# ── routed modes (migration 0075) ───────────────────────────────────────────

class Down(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code
        self.message = f"{code} at the vendor"


class PerModel:
    """One fake adapter per model: `fail` maps a model to the submit error it raises."""

    def __init__(self, fail=None, missing=()):
        self.fail = dict(fail or {})
        self.missing = set(missing)
        self.log = []

    def resolve(self, model):
        if model in self.missing:
            return None
        outer = self

        class A(FakeAdapter):
            def submit(self, request):
                outer.log.append(("submit", request.model, dict(request.params)))
                if model in outer.fail:
                    raise Down(outer.fail[model])
                return f"task-{model}"

            def poll(self, task_id, request, out_dir):
                outer.log.append(("poll", task_id))
                return FakeAdapter().poll(task_id, request, out_dir)

        return A()


def routed(**over):
    return job(**{"mode": "quality", "requested_model": "img-a", "routed_model": "img-a", **over})


class RoutedModes(Base):
    def go(self, q, models):
        w = cw.CreativeWorker(q, models.resolve, worker_id="w1", out_dir=self.out, credits=FakeCredits(),
                              enforce=True, sleep=lambda s: None, heartbeat_seconds=0)
        w.run_once()
        return w

    def test_a_routed_job_runs_its_routed_model(self):
        q = FakeQueue(routed(requested_model="img-a", routed_model="img-a"))
        m = PerModel()
        self.go(q, m)
        self.assertEqual([x[:2] for x in m.log if x[0] == "submit"], [("submit", "img-a")])
        self.assertTrue(q.finished["ok"])
        self.assertIsNone(q.finished["charge"])     # the database charges the routed model's price

    def test_a_refused_submit_moves_to_the_databases_next_model_with_its_priced_params(self):
        q = FakeQueue(routed())
        q.reroutes = [{"model": "img-b", "credits": 9, "params": {"prompt": "a cat", "quality": "medium"}}]
        m = PerModel(fail={"img-a": "unavailable"})
        self.go(q, m)
        submits = [x for x in m.log if x[0] == "submit"]
        self.assertEqual([x[1] for x in submits], ["img-a", "img-b"])
        self.assertEqual(submits[1][2], {"prompt": "a cat", "quality": "medium"})
        self.assertIn(("reroute", "unavailable"), q.calls)
        # Two 'submitting' steps (the database cleared the first), one new task, polled.
        steps = [c for c in q.calls if c[0] == "advance"]
        self.assertEqual(steps[:3], [("advance", "submitting", None), ("advance", "submitting", None),
                                     ("advance", "submitted", "task-img-b")])
        self.assertTrue(q.finished["ok"])

    def test_no_adapter_on_this_worker_is_a_failover_too(self):
        q = FakeQueue(routed())
        q.reroutes = [{"model": "img-b", "credits": 9, "params": {"prompt": "a cat"}}]
        m = PerModel(missing={"img-a"})
        self.go(q, m)
        self.assertEqual([x[1] for x in m.log if x[0] == "submit"], ["img-b"])
        self.assertEqual(q.calls.count(("reroute", "adapter_missing")), 1)
        self.assertTrue(q.finished["ok"])

    def test_exact_never_asks_for_another_model(self):
        q = FakeQueue(job(requested_model="img-a", routed_model="img-a"))
        q.reroutes = [{"model": "img-b", "credits": 6, "params": {"prompt": "a cat"}}]
        m = PerModel(fail={"img-a": "unavailable"})
        self.go(q, m)
        self.assertEqual([x[1] for x in m.log if x[0] == "submit"], ["img-a"])
        self.assertFalse(any(c[0] == "reroute" for c in q.calls))
        self.assertEqual(q.finished["error_code"], "unavailable")

    def test_a_refusal_of_the_request_itself_is_never_shopped_to_another_model(self):
        for code in ("policy", "bad_request", "bad_response"):
            with self.subTest(code=code):
                q = FakeQueue(routed())
                q.reroutes = [{"model": "img-b", "credits": 9, "params": {"prompt": "a cat"}}]
                m = PerModel(fail={"img-a": code})
                self.go(q, m)
                self.assertEqual([x[1] for x in m.log if x[0] == "submit"], ["img-a"])
                self.assertFalse(any(c[0] == "reroute" for c in q.calls))
                self.assertEqual(q.finished["error_code"], code)

    def test_no_compatible_model_fails_the_job_with_the_original_code(self):
        q = FakeQueue(routed())
        q.reroutes = []
        m = PerModel(fail={"img-a": "quota"})
        self.go(q, m)
        self.assertEqual(q.finished["error_code"], "quota")
        self.assertFalse(q.finished["ok"])

    def test_at_most_two_failovers(self):
        q = FakeQueue(routed())
        q.reroutes = [{"model": f"img-{c}", "credits": 9, "params": {"prompt": "a cat"}} for c in "bcd"]
        m = PerModel(fail={f"img-{c}": "unavailable" for c in "abcd"})
        self.go(q, m)
        self.assertEqual([x[1] for x in m.log if x[0] == "submit"], ["img-a", "img-b", "img-c"])
        self.assertEqual(q.finished["error_code"], "unavailable")

    def test_an_answer_without_the_priced_params_sends_nothing(self):
        q = FakeQueue(routed())
        q.reroutes = [{"model": "img-b", "credits": 9}]
        m = PerModel(fail={"img-a": "unavailable"})
        self.go(q, m)
        self.assertEqual([x[1] for x in m.log if x[0] == "submit"], ["img-a"])
        self.assertEqual(q.finished["error_code"], "unavailable")

    def test_a_resumed_routed_job_polls_its_routed_models_task_and_never_moves(self):
        q = FakeQueue(routed(routed_model="img-b", fallback_from="img-a", status="provider_pending",
                             provider_task_id="task-img-b"))
        q.reroutes = [{"model": "img-c", "credits": 9, "params": {"prompt": "a cat"}}]
        m = PerModel()
        self.go(q, m)
        self.assertEqual(m.log[0], ("poll", "task-img-b"))
        self.assertFalse(any(x[0] == "submit" for x in m.log))
        self.assertFalse(any(c[0] == "reroute" for c in q.calls))

    def test_the_failover_list_matches_the_database(self):
        sql = (Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "0075_model_router.sql").read_text()
        listed = sql.split("if code not in (", 1)[1].split(")", 1)[0]
        self.assertEqual({c.strip(" '\n") for c in listed.replace("\n", " ").split(",")}, set(cw.FAILOVER_CODES))


if __name__ == "__main__":
    unittest.main()
