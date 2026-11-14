"""The failed-job cap (0175), attacked in a real database.

A creative job that fails or is refused releases its whole hold, so the customer pays nothing for it, while a vendor may have
billed us for the call (a picture generated and then refused as unsafe, a task that failed late). 0175: an organization with 5
counted failures in the last 24 hours starts no new creative job; create_creative_job and start_workflow_run refuse NS429
failed_job_limit before anything is held, naming when the window frees.

What would break, and which test says so:
  * the 5th failure does not stop the next job, or the refusal holds something     test_four_failures_start_a_job_and_five_refuse_it
  * the time named is not when the count drops below the limit                     test_retry_at_is_when_the_count_drops_below_the_limit
  * our outage, quota, lost worker or switched-off model is held against a customer test_failures_that_are_not_the_customers_do_not_count
  * one of the customer's own codes is not counted                                  test_each_counted_code_counts
  * yesterday's failures still count                                                test_failures_older_than_24_hours_do_not_count
  * another organization's failures count against mine                              test_another_orgs_failures_do_not_count
  * the operator's own organization is capped                                       test_the_operators_organization_is_not_capped
  * a replay of a job made before the limit is refused (or a new key passes)        test_a_replay_is_answered_and_a_new_key_is_refused
  * the public API answers anything but 429 failed_job_limit with the remedy        test_the_api_path_refuses_with_the_remedy_and_holds_nothing
  * a workflow starts at the limit, or a waiting step reads "your runs are busy"    test_workflow_*
  * concurrent creates pass the cap by more than the jobs already in flight         test_a_race_*

Runs in the scratch database of test_sec_workflows.py (its db fixture, module scoped: this module gets its own copy), with a new
organization per test so that no test's failures count in another's.
"""

import hashlib
import json
import re
import threading
import uuid
from datetime import timedelta

import psycopg
import pytest

from test_sec_workflows import (  # noqa: F401  (db: this module's own scratch database)
    UADMIN,
    VALUES,
    db,
    flow,
    start_ok,
)

DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"
DETAIL_RE = re.compile(r"^failed=(\d+) limit=5 retry_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$")

COUNTED = ["policy", "bad_request", "invalid_params", "source_unavailable", "source_too_large", "provider_error"]
NOT_COUNTED = ["unavailable", "unreachable", "network", "rate_limited", "quota", "provider_quota", "auth", "not_configured",
               "not_found", "bad_response", "vendor_tool_unsupported", "adapter_missing", "worker_error", "worker_lost",
               "submit_interrupted", "provider_timeout", "output_lost", "result_not_stored", "credits_unavailable",
               "hold_below_quote", "model_temporarily_off", "no_region_applied", "region_quote_mismatch", "drained"]


@pytest.fixture(scope="module", autouse=True)
def _many_runs_at_once(db):
    # The free plan runs one generation at a time; the race below starts several. This is this module's own database.
    db.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def press(db, o, who=None, idem=None):
    """A Studio press: one picture, 4 credits held."""
    return db.one("authenticated", who or o.owner,
                  "select public.create_creative_job(%s, 't2i', 'img-a', %s::jsonb, 'exact', %s, 4)",
                  [o.org, json.dumps({"prompt": "a lighthouse"}), idem or f"cap-{uuid.uuid4()}"])


def fail(db, o, n=1, code="policy", who=None):
    """n jobs started the way the Studio starts them and ended the way the worker ends a refused one."""
    for _ in range(n):
        db.worker(press(db, o, who)["job"]["id"], ok=False, code=code)


def fail_queued(db, jobs, code):
    """End every one of `jobs` (all queued) the way the worker ends a refused job, each with `code`."""
    w = "cap-worker"
    left = set(jobs)
    while left:
        got = db.act("service_role", None, "select id::text, org_id::text, credit_ref from public.claim_creative_job(%s)", [w])
        assert got, f"not in the queue: {left}"
        jid, org, ref = got[0]
        if ref:
            db.act("service_role", None, "select public.start_credit_reservation(%s, %s)", [ref, org])
        db.act("service_role", None, "select public.advance_creative_job(%s, %s, 'submitting')", [jid, w])
        db.act("service_role", None, "select public.finish_creative_job(%s, %s, false, null, null, %s, 'refused')",
               [jid, w, code if jid in left else "drained"])
        left.discard(jid)


def footprint(db, org):
    """Everything a job start could leave behind: job rows, open holds, the account, the ledger."""
    return (db.su("select count(*) from public.creative_jobs where org_id = %s", [org])[0][0],
            db.holds(org),
            db.acct(org),
            db.su("select count(*) from public.credit_transactions where org_id = %s", [org])[0][0])


def refused(fn):
    st, word, detail = err(fn)
    assert (st, word) == ("NS429", "failed_job_limit"), (st, word, detail)
    m = DETAIL_RE.match(detail)
    assert m, detail
    return int(m.group(1)), m.group(2)


def counted_finish_times(db, org):
    return [r[0] for r in db.su(
        "select finished_at from public.creative_jobs where org_id = %s and status = 'failed' "
        "and error_code = any (public.creative_failed_job_codes()) and finished_at > now() - interval '24 hours' "
        "order by finished_at, id", [org])]


def utc(ts):
    return (ts + timedelta(hours=24)).astimezone().astimezone(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ") if False else \
        (ts + timedelta(hours=24)).astimezone(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── the gate ────────────────────────────────────────────────────────────────

def test_four_failures_start_a_job_and_five_refuse_it(db):
    o = db.new_org()
    fail(db, o, 4)
    job = press(db, o)["job"]
    assert job["status"] == "queued", "4 counted failures still start a job"
    db.worker(job["id"], ok=False, code="policy")
    before = footprint(db, o.org)
    n, _ = refused(lambda: press(db, o))
    assert n == 5
    assert footprint(db, o.org) == before, "the refusal holds nothing and writes no job"
    # Another member of the same organization is refused too: the count is the organization's.
    n, _ = refused(lambda: press(db, o, who=o.editor))
    assert n == 5


def test_retry_at_is_when_the_count_drops_below_the_limit(db):
    o = db.new_org()
    fail(db, o, 4)
    # Two jobs accepted at 4 failures (both in flight), both refused later: 6 counted.
    a, b = press(db, o)["job"]["id"], press(db, o)["job"]["id"]
    db.worker(a, ok=False, code="policy")
    db.worker(b, ok=False, code="bad_request")
    times = counted_finish_times(db, o.org)
    assert len(times) == 6
    n, retry_at = refused(lambda: press(db, o))
    assert n == 6
    # The count drops to 4 when the 2nd oldest leaves the window: with 6 counted, the (6 - 5 + 1)-th oldest.
    assert retry_at == utc(times[1]), (retry_at, times)
    # With exactly 5, it is the oldest.
    db.su("update public.creative_jobs set finished_at = now() - interval '25 hours' where id = (select id from public.creative_jobs "
          "where org_id = %s and status = 'failed' order by finished_at, id limit 1)", [o.org])
    times = counted_finish_times(db, o.org)
    n, retry_at = refused(lambda: press(db, o))
    assert (n, retry_at) == (5, utc(times[0]))


def test_failures_that_are_not_the_customers_do_not_count(db):
    o = db.new_org()
    for code in NOT_COUNTED:
        fail(db, o, 1, code=code)
    # Cancelled and expired jobs are not failures at all.
    j = press(db, o)["job"]["id"]
    db.one("authenticated", o.owner, "select public.cancel_creative_job(%s)", [j])
    fail(db, o, 4, code="policy")
    assert press(db, o)["job"]["status"] == "queued", f"{len(NOT_COUNTED)} excluded failures + 4 counted still start a job"


@pytest.mark.parametrize("code", COUNTED)
def test_each_counted_code_counts(db, code):
    o = db.new_org()
    fail(db, o, 4, code="policy")
    fail(db, o, 1, code=code)
    assert refused(lambda: press(db, o))[0] == 5


def test_the_list_in_the_database_is_the_one_this_file_names(db):
    assert db.su("select public.creative_failed_job_codes()")[0][0] == COUNTED


def test_failures_older_than_24_hours_do_not_count(db):
    o = db.new_org()
    fail(db, o, 5)
    refused(lambda: press(db, o))
    db.su("update public.creative_jobs set finished_at = finished_at - interval '24 hours' - interval '1 second' "
          "where id = (select id from public.creative_jobs where org_id = %s and status = 'failed' order by finished_at limit 1)",
          [o.org])
    assert press(db, o)["job"]["status"] == "queued"


def test_another_orgs_failures_do_not_count(db):
    a, b = db.new_org(), db.new_org()
    fail(db, b, 5)
    refused(lambda: press(db, b))
    assert press(db, a)["job"]["status"] == "queued", "B's failures are not A's"
    # And a member of A cannot be refused on B's behalf, nor learn B's count: B's org is not A's to create in.
    st, _w, _d = err(lambda: db.one("authenticated", a.owner,
                                    "select public.create_creative_job(%s, 't2i', 'img-a', '{\"prompt\":\"x\"}'::jsonb, 'exact', null, 4)",
                                    [b.org]))
    assert st == "42501"


def test_the_gate_is_not_callable_by_any_api_role(db):
    o = db.new_org()
    for role, user in (("anon", None), ("authenticated", o.owner), ("service_role", None)):
        st, _w, _d = err(lambda: db.act(role, user, "select public.creative_failed_job_gate(%s)", [o.org]))
        assert st == "42501", (role, st)


def test_the_operators_organization_is_not_capped(db):
    db.su("insert into public.app_members (user_id, email, role) values (%s, 'admin@x.io', 'owner') on conflict do nothing", [UADMIN])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'admin@x.io', 'owner') "
          "on conflict do nothing", [DEFAULT_ORG, UADMIN])
    assert db.su("select public.credits_exempt(%s)", [DEFAULT_ORG])[0][0] is True

    class Op:
        org, owner = DEFAULT_ORG, UADMIN

    fail(db, Op, 6)
    assert press(db, Op)["job"]["status"] == "queued", "the platform pays the operator's generations: no cap there"
    db.worker(press(db, Op)["job"]["id"], ok=False)  # leave nothing queued for the next test's worker


def test_a_replay_is_answered_and_a_new_key_is_refused(db):
    o = db.new_org()
    fail(db, o, 4)
    key = f"cap-replay-{uuid.uuid4()}"
    first = press(db, o, idem=key)["job"]
    db.worker(first["id"], ok=False)
    again = press(db, o, idem=key)
    assert again["replay"] is True and again["job"]["id"] == first["id"], "a job already made is answered, never refused"
    refused(lambda: press(db, o))


# ── the public API (and the MCP server, which answers through it) ──────────

def H(name):
    return hashlib.sha256(f"failed-job-cap-{name}".encode()).hexdigest()


def api_org(db):
    o = db.new_org()
    db.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1')",
          [o.org, o.owner])
    db.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 0, 100000)", [o.org])
    db.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s, 'cap', %s, %s, %s)",
          [o.org, H(o.org), o.owner, ["creative:quote", "creative:create", "creative:read"]])
    return o


def api_create(db, o, idem):
    params = {"prompt": "a lighthouse"}
    return db.one("anon", None, "select public.api_creative_create(%s, 't2i', 'img-a', %s::jsonb, 'exact', 4, %s, %s, null)",
                  [H(o.org), json.dumps(params), idem, hashlib.sha256(idem.encode()).hexdigest()])


def test_the_api_path_refuses_with_the_remedy_and_holds_nothing(db):
    o = api_org(db)
    for i in range(5):
        out = api_create(db, o, f"api-{i}")
        assert out.get("ok") is not False, out
        db.worker(out["data"]["id"], ok=False, code="policy")
    before = footprint(db, o.org)
    out = api_create(db, o, "api-6")
    assert out["ok"] is False and out["status"] == 429, out
    e = out["error"]
    assert e["code"] == "failed_job_limit"
    assert e["failed_jobs"] == 5 and e["limit"] == 5 and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", e["retry_at"]), e
    assert "Nothing was held or charged" in e["message"] and "change the prompt" in e["message"]
    assert e["retry_at"][11:16] + " UTC" in e["message"], "the sentence names the time the window frees"
    assert footprint(db, o.org) == before
    # A replay of a key used before the limit is still answered (the job exists), not refused.
    assert api_create(db, o, "api-0").get("ok") is not False


def test_the_api_answer_without_a_detail_names_no_number(db):
    out = db.su("select public.api_creative_refusal('NS429', 'failed_job_limit', 'garbled')")[0][0]
    e = out["error"]
    assert out["status"] == 429 and e["code"] == "failed_job_limit"
    # An unknown count is never shown as a number (CLAUDE.md rule 5): no "<n> generations", no limit, no time.
    assert not re.search(r"\b\d+ generations|limit is|UTC", e["message"]), e["message"]
    assert "failed_jobs" not in e and "retry_at" not in e
    # The plan's run limit keeps its own answer.
    run = db.su("select public.api_creative_refusal('NS429', 'run limit', 'active=1 limit=1')")[0][0]
    assert run["error"]["code"] == "run_limit_reached"


# ── workflows ───────────────────────────────────────────────────────────────

def test_workflow_start_is_refused_at_the_limit_before_anything_is_held(db):
    o = db.new_org()
    wf = flow(db, o)
    fail(db, o, 5, who=o.editor)
    before = footprint(db, o.org)
    n, _ = refused(lambda: db.start(o.editor, str(uuid.uuid4()), wf["id"], wf["version"], VALUES, 15.9))
    assert n == 5
    assert footprint(db, o.org) == before
    assert db.su("select count(*) from public.workflow_runs where workflow_id = %s", [wf["id"]])[0][0] == 0


def test_workflow_replay_of_a_run_started_before_the_limit_is_answered(db):
    o = db.new_org()
    wf, run, _ = start_ok(db, o)
    fail(db, o, 5, who=o.editor)
    out = db.start(o.editor, run, wf["id"], wf["version"], VALUES, 15.9)
    assert out["replay"] is True


def test_workflow_step_waits_under_its_own_word_and_starts_when_the_window_frees(db):
    o = db.new_org()
    fail(db, o, 4, who=o.editor)
    wf, run, _ = start_ok(db, o)  # at 4 the run starts, and its first step's job with it
    db.worker(db.steps(run)[0][2], charge=4)  # step 1 succeeds
    fail(db, o, 1, who=o.editor)  # the 5th counted failure lands before step 2 is due
    out = db.advance(o.editor, run)
    assert out["run"]["status"] == "running", out["run"]
    step2 = db.steps(run)[1]
    assert step2[1] == "pending" and step2[2] is None, step2
    assert step2[5] == "failed_job_limit", "the step waits as the cap, never as 'your plan's runs are busy' (rule 5)"
    assert db.holds(o.org)[0] == 0, "a waiting step holds nothing"
    db.su("update public.creative_jobs set finished_at = finished_at - interval '25 hours' where org_id = %s and status = 'failed'",
          [o.org])
    db.advance(o.editor, run)
    assert db.steps(run)[1][1] == "running"


# ── the race ────────────────────────────────────────────────────────────────

def race(calls):
    barrier = threading.Barrier(len(calls))
    results, errors = [], []

    def go(fn):
        barrier.wait()
        try:
            results.append(fn())
        except psycopg.Error as e:
            errors.append(e)

    ts = [threading.Thread(target=go, args=(fn,)) for fn in calls]
    [t.start() for t in ts]
    [t.join(timeout=60) for t in ts]
    return results, errors


def test_a_race_at_the_limit_starts_nothing(db):
    o = db.new_org()
    fail(db, o, 5)
    before = footprint(db, o.org)
    results, errors = race([lambda: press(db, o) for _ in range(8)])
    assert results == [] and len(errors) == 8
    assert {(e.sqlstate, str(e).splitlines()[0]) for e in errors} == {("NS429", "failed_job_limit")}
    assert footprint(db, o.org) == before


def test_a_race_below_the_limit_overshoots_by_at_most_the_jobs_in_flight(db):
    """THE BOUND (header of 0175): creates queue on the account lock and each counts the failures committed before it; a job in
    flight is not a failure yet. With 4 counted failures, N concurrent presses all start, and if all N then fail the window holds
    4 + N; the next press is refused. N is the jobs accepted and unfinished, which the plan's parallel-run limit bounds for jobs
    that hold credits."""
    o = db.new_org()
    fail(db, o, 4)
    n = 6
    results, errors = race([lambda: press(db, o) for _ in range(n)])
    assert errors == [] and len(results) == n
    fail_queued(db, {r["job"]["id"] for r in results}, code="policy")
    assert len(counted_finish_times(db, o.org)) == 4 + n
    assert refused(lambda: press(db, o))[0] == 4 + n
