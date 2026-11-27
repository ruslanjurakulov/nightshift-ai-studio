"""A creative job whose model went off sale while it was queued, run by the REAL worker code against the REAL 0036/0124/0125/0139 SQL.

The worker (modules/creative_worker.py, "Still on sale") asks sellable_models again right before the paid call. What would break
without each guard, against a real database and a real hold:

  * a model retired (availability 'disabled') or hidden after the job was queued: 0036's claim hands the job out (it never looks at
    the model) and 0124's advance 'submitting' only asks the owner's switch, so without the look the vendor is called. With it: no
    submit, submit_started_at stays empty, the job is failed 'model_not_available' through finish_creative_job(ok=false), and the
    hold is RELEASED (never captured): the balance is untouched and nothing stays reserved. No money code of the worker's own;
  * the look's answer out of reach: nothing is sent, nothing is recorded, and the stale sweep hands the job back UNSENT (re-queued,
    not 'submit_interrupted'), so the next claim asks again;
  * a model still on sale runs exactly as before (one submit, the hold captured at the price);
  * the operator's preview (0139) in the exempt organization still runs: sellable_models never lists it, and the worker reads the
    model's row as the service role (0035's select grant) with 0139's rule;
  * the worker's copy of 0125's model_past_shutdown (used for that one row) answers as the SQL does on one corpus.

The worker talks to the database through a few lines of PostgREST (an rpc is a named-argument call as service_role; a GET of
model_registry is a select as service_role), so CreativeRest, CreditsRest and the worker run unchanged. Runs in its own scratch
database, on test_sec_creative_credits.py's registry and organizations.
"""

from __future__ import annotations

import json as jsonlib
import tempfile
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg import sql
from psycopg.types.json import Jsonb

import sec_db  # noqa: F401 — the lab's own module, imported for its side effects on sys.path like every lab file
from modules import creative_worker as cw
from modules import credits as credit_rules
from test_sec_creative_credits import DEFAULT_ORG, ORG_A, UA, UADMIN, acct, create, db, drain, install_real_registry  # noqa: F401

WORKER = "recheck-w1"


class _Resp:
    def __init__(self, status: int, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class PostgrestShim:
    """Just enough of PostgREST for the worker: POST /rest/v1/rpc/<fn> with a JSON body is ``public.<fn>(name => value, ...)`` as
    service_role; GET /rest/v1/model_registry?id=eq.X&select=a,b is that select as service_role. ``fail`` names an rpc that answers
    HTTP 503, as a database out of reach would."""

    def __init__(self, d):
        self.d = d
        self.fail = set()
        self.rpcs = []

    def post(self, url, json=None, timeout=None, headers=None):
        name = url.rsplit("/rpc/", 1)[1]
        self.rpcs.append(name)
        if name in self.fail:
            return _Resp(503, {"message": "unavailable"})
        body = json or {}
        retset = self.d.su("select bool_or(p.proretset) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = %s",
                           [name])[0][0]
        args = sql.SQL(", ").join(sql.SQL("{} => %s").format(sql.Identifier(k)) for k in body)
        fn = sql.SQL("public.{}({})").format(sql.Identifier(name), args)
        q = (sql.SQL("select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from {} x").format(fn) if retset
             else sql.SQL("select to_jsonb({})").format(fn))
        values = [Jsonb(v) if isinstance(v, (dict, list)) else v for v in body.values()]
        try:
            rows = self.d.act("service_role", None, q.as_string(), values)
        except psycopg.Error as e:
            return _Resp(400, {"message": str(e).splitlines()[0]})
        return _Resp(200, rows[0][0] if rows else None)

    def get(self, url, params=None, timeout=None, headers=None):
        table = url.rsplit("/rest/v1/", 1)[1]
        assert table == "model_registry", table
        cols = [c for c in params["select"].split(",")]
        mid = params["id"].removeprefix("eq.")
        q = sql.SQL("select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select {} from public.model_registry where id = %s) r").format(
            sql.SQL(", ").join(sql.Identifier(c) for c in cols))
        try:
            rows = self.d.act("service_role", None, q.as_string(), [mid])
        except psycopg.Error as e:
            return _Resp(403, {"message": str(e).splitlines()[0]})
        return _Resp(200, rows[0][0])


class VendorMustNotBeCalled:
    def __init__(self):
        self.submits = []

    def submit(self, request):
        self.submits.append(request.model)
        return f"task-{request.model}"

    def poll(self, task_id, request, out_dir):
        out_dir.mkdir(parents=True, exist_ok=True)
        f = out_dir / "output_0.png"
        f.write_bytes(b"\x89PNG lab")
        return cw.ProviderPoll(cw.SUCCEEDED, files=[f])


def run_worker(d, shim=None):
    shim = shim or PostgrestShim(d)
    vendor = VendorMustNotBeCalled()
    with tempfile.TemporaryDirectory() as tmp:
        w = cw.CreativeWorker(cw.CreativeRest("https://lab.invalid", "lab", session=shim), lambda m: vendor, worker_id=WORKER,
                              out_dir=Path(tmp), credits=credit_rules.CreditsRest("https://lab.invalid", "lab", session=shim),
                              enforce=True, heartbeat_seconds=0, sleep=lambda s: None)
        job = w.queue.claim(WORKER, 10)
        outcome = w.process(job) if job else None
    return outcome, vendor, shim


def job_row(d, jid):
    return d.su("select status, error_code, submit_started_at is not null, provider_task_id, charged_credits::float "
                "from public.creative_jobs where id = %s", [jid])[0]


def hold(d, jid):
    return d.su("select status from public.credit_reservations where job_id = %s", ["cj:" + jid])[0][0]


@pytest.fixture(scope="module", autouse=True)
def registry(db):  # noqa: F811 — the money lab's fixture, by design
    if not db.registry_applied:
        pytest.skip("0035 is not applied: sellable_models needs the real registry")
    install_real_registry(db)
    yield


@pytest.fixture(autouse=True)
def on_sale_again(db):  # noqa: F811
    drain(db)
    db.su("update public.model_registry set availability = 'beta' where id = 'img-x'")
    yield
    db.su("update public.model_registry set availability = 'beta' where id = 'img-x'")


@pytest.mark.parametrize("off", ["disabled", "hidden"])
def test_a_model_taken_off_sale_after_the_queue_is_not_sent_and_its_hold_is_released_not_captured(db, off):  # noqa: F811
    before = acct(db, ORG_A)
    j = create(db, UA, ORG_A)["job"]
    assert hold(db, j["id"]) == "open" and acct(db, ORG_A) == (before[0], before[1] + 6)
    # The retirement lands while the job waits in the queue (a migration or a registry sync, as the owner's SQL editor would).
    db.su("update public.model_registry set availability = %s where id = 'img-x'", [off])

    outcome, vendor, shim = run_worker(db)

    assert outcome == "failed:model_not_available"
    assert vendor.submits == [], "the vendor was called for a model that is no longer on sale"
    status, code, submit_started, task, charged = job_row(db, j["id"])
    assert (status, code, submit_started, task) == ("failed", "model_not_available", False, None)
    assert not charged
    assert hold(db, j["id"]) == "released"
    assert acct(db, ORG_A) == before, "the hold was not given back in full"
    ledger = db.su("select kind from public.credit_transactions where job_id = %s order by id", ["cj:" + j["id"]])
    assert [k for (k,) in ledger] == ["reserve", "release"], ledger
    # One settle, through the ordinary failure path: finish_creative_job, never advance 'submitting'.
    assert shim.rpcs.count("finish_creative_job") == 1 and "advance_creative_job" not in shim.rpcs


def test_an_unreachable_answer_sends_nothing_and_the_sweep_hands_the_job_back_unsent(db):  # noqa: F811
    before = acct(db, ORG_A)
    j = create(db, UA, ORG_A)["job"]
    shim = PostgrestShim(db)
    shim.fail.add("sellable_models")

    outcome, vendor, _ = run_worker(db, shim)

    assert outcome == "left" and vendor.submits == []
    status, code, submit_started, task, _c = job_row(db, j["id"])
    assert (status, code, submit_started, task) == ("running", None, False, None)
    assert hold(db, j["id"]) == "open"
    # The stale sweep: a job never sent is re-queued (and claimed again), never failed as submit_interrupted.
    db.su("update public.creative_jobs set heartbeat_at = now() - interval '1 hour' where id = %s", [j["id"]])
    rows = db.act("service_role", None, "select id::text, status, attempts from public.claim_creative_job('recheck-w2')")
    assert rows == [(j["id"], "running", 2)]
    db.act("service_role", None, "select public.finish_creative_job(%s,'recheck-w2',false,null,null,'test_drain','drained')", [j["id"]])
    assert acct(db, ORG_A) == before


def test_a_model_still_on_sale_is_sent_once_and_its_hold_captured_as_before(db):  # noqa: F811
    before = acct(db, ORG_A)
    j = create(db, UA, ORG_A)["job"]

    outcome, vendor, _ = run_worker(db)

    assert vendor.submits == ["img-x"]
    status, code, submit_started, task, charged = job_row(db, j["id"])
    assert (status, submit_started, task) == ("completed", True, "task-img-x"), (outcome, code)
    assert charged == 6 and hold(db, j["id"]) == "captured"
    assert acct(db, ORG_A) == (before[0] - 6, before[1])


def test_the_operators_preview_in_the_exempt_organization_still_runs(db):  # noqa: F811
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'admin@x.io', 'owner') "
          "on conflict do nothing", [DEFAULT_ORG, UADMIN])
    # 'img-hidden' is hidden and probed; marking it operator_preview is a spec change 0035's guard does not reset.
    db.su("update public.model_registry set spec = spec || '{\"operator_preview\": true}'::jsonb where id = 'img-hidden'")
    try:
        j = create(db, UADMIN, DEFAULT_ORG, model="img-hidden")["job"]
        outcome, vendor, shim = run_worker(db)
        assert vendor.submits == ["img-hidden"], outcome
        assert job_row(db, j["id"])[0] == "completed"
        assert "sellable_models" in shim.rpcs
        # Retired since: the same preview is refused, through the same release path (the exempt organization holds nothing).
        j = create(db, UADMIN, DEFAULT_ORG, model="img-hidden")["job"]
        db.su("update public.model_registry set availability = 'disabled' where id = 'img-hidden'")
        outcome, vendor, _ = run_worker(db)
        assert vendor.submits == [] and outcome == "failed:model_not_available"
        assert job_row(db, j["id"])[:2] == ("failed", "model_not_available")
    finally:
        db.su("update public.model_registry set availability = 'hidden', spec = spec - 'operator_preview' where id = 'img-hidden'")


def test_the_workers_shutdown_rule_is_0125s(db):  # noqa: F811
    today = datetime.now(timezone.utc).date()
    corpus = [None, {}, {"shutdown": {"on": "2999-12-31"}}, {"shutdown": {"on": today.isoformat()}},
              {"shutdown": {"on": date.fromordinal(today.toordinal() + 1).isoformat()}}, {"shutdown": {"on": "2000-01-01"}},
              {"shutdown": {"on": "not a date"}}, {"shutdown": {"on": "2026-13-45"}}, {"shutdown": {"on": "2026-02-30"}},
              {"shutdown": "2999-12-31"}, {"shutdown": {"on": 20991231}}, {"shutdown": None}, {"shutdown": {}}]
    for spec in corpus:
        want = db.su("select public.model_past_shutdown(%s::jsonb)", [None if spec is None else jsonlib.dumps(spec)])[0][0]
        assert cw.past_shutdown(spec, today) is want, spec


def test_the_reads_the_worker_relies_on_are_the_service_roles_and_nobody_elses(db):  # noqa: F811
    """No grant was added: the look uses what 0035/0124 already give the service role, and a browser still cannot read the registry
    row the preview rule reads, or call the switch with a trusted answer."""
    for fn, ok in [("public.sellable_models(text,text)", True), ("public.model_is_available(text)", True)]:
        assert db.su("select has_function_privilege('service_role', %s, 'execute')", [fn])[0][0] is ok
        assert db.su("select has_function_privilege('anon', %s, 'execute')", [fn])[0][0] is False
    assert db.su("select has_table_privilege('service_role', 'public.model_registry', 'select')")[0][0] is True
    assert db.su("select has_table_privilege('anon', 'public.model_registry', 'select')")[0][0] is False
    assert uuid.UUID(ORG_A)  # the scenario's organization is a real id, as the worker's job rows carry
