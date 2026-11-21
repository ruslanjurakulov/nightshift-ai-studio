"""Breach on PR #853 (migration 0198): the take's creative job, the lease, the switches, and the creative credit worker.

Attacked as the service role a worker holds (two workers, one with a lease that went stale), as the creative credit worker that claims
credit-paid jobs, as a signed-in member and the anon key, and as a platform admin. Each test names the pin it holds; a test that fails
names a hole that is still open (it stays failing until the product code closes it, never skipped):

  1. film_take_job never takes or spends a credit hold, for any kind of take, and the job it writes cannot be charged afterwards.
  2. Only the lease holder writes or takes over a take's job; an expired lease another worker reclaimed is refused everywhere.
  3. A re-claim, or workers racing, never make two jobs for one take (and a failed take leaves no live job next to its retry).
  4. A stale lease's job cannot be advanced, completed or captured, and moves no money.
  5. A payer 'film' job is never handed to (or ended by) the creative credit worker, and that worker never charges it.
  6. anon / authenticated reach none of the worker's calls; the org switch is flipped only by a platform owner/admin or the SQL
     editor, and every flip writes security_events.
  7. With the platform switch off, quote_film, start_film and film_claim_segment refuse.

Its own scratch database (it commits), on the registry and models of test_sec_films_money.py, like test_sec_film_worker.py.
"""

from __future__ import annotations

import json
import os
import threading
import uuid

import psycopg
import pytest

import sec_db
from test_sec_films_money import ASSEMBLY_RATE, JOB_MINIMUM, MODELS, Db


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_film_breach_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], **spec}}
            for m, prov, a, caps, unit, _rate, spec in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, _prov, a, caps, unit, rate, _spec in MODELS:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, rate])
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0), "
         "('job_minimum', %s, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit",
         [ASSEMBLY_RATE, JOB_MINIMUM])
    assert d.su("select public.set_film_studio_enabled(true)")[0][0]["ok"] is True
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(autouse=True)
def only_this_tests_segment(db):
    """The claim hands out the oldest claimable segment of any organization. Every live one is cancelled through the service's own
    cancel; one left draining (a take still running) is given a heartbeat far ahead, so a later test never claims it."""
    db.su("select public.set_film_studio_enabled(true)")
    for (sid,) in db.su("select id from public.film_segments where status in ('queued', 'running', 'draining')"):
        db.svc("select public.film_cancel_segment(%s, 'cancelled')", [sid])
    db.su("update public.film_segments set heartbeat_at = now() + interval '1 day' where status in ('running', 'draining')")
    yield


@pytest.fixture
def a(db):
    return db.new_org()


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0]


def take_job(db, take, worker="w-1"):
    return db.svc("select public.film_take_job(%s, %s)", [take, worker])


def advance(db, job, worker, step, task=None):
    return db.svc("select public.advance_creative_job(%s, %s, %s, %s)", [job, worker, step, task])


def finish(db, job, worker, ok=True, charge=None):
    return db.svc("select public.finish_creative_job(%s, %s, %s, %s::numeric, '{}'::jsonb, null, null)", [job, worker, ok, charge])


def job_row(db, job):
    return db.su("select status, worker_id, payer, credit_ref, quoted_credits, charged_credits from public.creative_jobs where id = %s",
                 [job])[0]


def money(db, org):
    """Everything that is money for the organization: the account, every hold, every ledger line."""
    return (db.account(org), db.holds(org),
            db.su("select kind, amount, coalesce(job_id, '') from public.credit_transactions where org_id = %s order by id", [org]))


def started(db, o):
    fid = db.film(o)
    seg = db.quoted_start(o, fid)
    return fid, seg


def stale(db, seg):
    db.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s", [seg])


def take_of(db, seg, kind, attempt=1):
    return db.su("select t.id from public.film_takes t left join public.film_scenes s on s.id = t.scene_id "
                 "where t.segment_id = %s and t.kind = %s and t.attempt = %s order by s.position nulls last, t.shot_index limit 1",
                 [seg, kind, attempt])[0][0]


# ── 1. no hold, no spend ────────────────────────────────────────────────────

def test_1_a_take_job_of_every_kind_takes_no_hold_and_moves_no_credit(db, a):
    fid, seg = started(db, a)
    db.claim()
    before = money(db, a.org)
    assert len(before[1]) == 1 and before[1][0][2] == "open"  # the segment's own hold, from start_film
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf)
    out = take_job(db, kf)
    assert out["ok"] is True
    db.make(a, kf, "keyframe")  # already running: begin answers as it is; the result is stored
    clip = take_of(db, seg["id"], "clip")
    db.begin(clip)
    clip_job = take_job(db, clip)
    narr = take_of(db, seg["id"], "narration")
    db.begin(narr)
    narr_job = take_job(db, narr)
    assert clip_job["ok"] is True and narr_job["ok"] is True, (clip_job, narr_job)
    for j in (out["job_id"], clip_job["job_id"], narr_job["job_id"]):
        status, worker, payer, ref, quoted, charged = job_row(db, j)
        assert (status, worker, payer, ref, float(quoted)) == ("running", "w-1", "film", None, 0.0)
    # Not one line in the ledger, not one cent reserved, no second hold: the segment's hold is the only money a film has.
    assert money(db, a.org) == before


def test_1_a_film_job_cannot_be_charged_when_its_worker_finishes_it(db, a):
    fid, seg = started(db, a)
    db.claim()
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf)
    j = take_job(db, kf)["job_id"]
    before = money(db, a.org)
    assert advance(db, j, "w-1", "submitting") is True
    assert advance(db, j, "w-1", "submitted", "lab-task-1") is True
    # A worker that names a charge is refused: the job's hold is 0, and nothing above it is ever captured.
    assert err(lambda: finish(db, j, "w-1", True, 5))[0] == "22023"
    done = finish(db, j, "w-1", True)
    assert done["status"] == "completed"
    assert float(job_row(db, j)[5]) == 0.0
    assert money(db, a.org) == before


# ── 2. the lease holder, and nobody else ────────────────────────────────────

def test_2_a_take_job_is_refused_to_any_worker_id_but_the_lease_holders(db, a):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    for impostor in ("w-2", "W-1", "w-1x", "", None, "w-1" + " " * 200 + "tail"):
        assert err(lambda: take_job(db, kf, impostor)) == ("NS409", "lease_lost"), impostor
    assert db.su("select count(*) from public.creative_jobs where film_take_id = %s", [kf])[0][0] == 0
    # The same worker id with the padding the database trims is the same worker (btrim, as every lease call reads it).
    assert take_job(db, kf, "  w-1  ")["ok"] is True


def test_2_an_expired_lease_that_another_worker_reclaimed_is_refused_everywhere(db, a):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    clip = take_of(db, seg["id"], "clip")
    db.begin(kf, "w-1")
    stale(db, seg["id"])
    assert db.claim("w-2")["id"] == seg["id"]
    before = money(db, a.org)
    assert err(lambda: take_job(db, kf, "w-1")) == ("NS409", "lease_lost")
    assert err(lambda: db.begin(clip, "w-1")) == ("NS409", "lease_lost")
    assert err(lambda: db.succeed(kf, None, db.output(a.org, kf, "image", "image/png"), "w-1")) == ("NS409", "lease_lost")
    assert err(lambda: db.settle(seg["id"], "takes_failed", "w-1")) == ("NS409", "lease_lost")
    assert db.svc("select public.film_heartbeat_segment(%s, 'w-1')", [seg["id"]]) is False
    assert db.su("select count(*) from public.creative_jobs where film_take_id = %s", [kf])[0][0] == 0
    assert money(db, a.org) == before
    assert take_job(db, kf, "w-2")["job_worker"] == "w-2"


def test_2_an_expired_lease_nobody_reclaimed_is_still_its_holders(db, a):
    """Recorded as the design, not a hole: 0171's lease has no clock of its own. A heartbeat older than the stale interval makes the
    segment claimable; until another worker claims it, the holder is still the only one who may act, and the claim (which locks the
    same rows) can never interleave with it."""
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    stale(db, seg["id"])
    assert take_job(db, kf, "w-1")["ok"] is True
    assert err(lambda: take_job(db, kf, "w-2")) == ("NS409", "lease_lost")


def test_2_switched_off_the_lease_holder_makes_no_new_take_job(db, a):
    """HOLE (low, defence in depth). 0198 enforces "off" at the start and at the claim only. A worker that already holds a lease keeps
    making new takes' jobs (and so new paid provider calls, captured from the customer's hold at the settle) after the platform or the
    organization was switched off: film_begin_take and film_take_job never ask film_studio_on_for. The only "off = stop" before a take
    is the Python worker's own question (modules/film_orchestrator.py); the database, which every other rule here relies on, does not
    say it."""
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    try:
        db.su("select public.set_org_film_studio_enabled(%s, false)", [a.org])
        assert db.su("select public.film_studio_on_for(%s)", [a.org])[0][0] is False
        refused = None
        try:
            out = take_job(db, kf, "w-1")
        except psycopg.Error as e:
            refused, out = e.sqlstate, None
        made = db.su("select count(*) from public.creative_jobs where film_take_id = %s", [kf])[0][0]
        assert made == 0 and (refused is not None or (out or {}).get("ok") is False), \
            f"an organization switched off still had a take's job written for it: {out}"
    finally:
        db.su("select public.set_org_film_studio_enabled(%s, true)", [a.org])


# ── 3. one job a take ───────────────────────────────────────────────────────

def test_3_the_same_take_asked_for_by_many_threads_at_once_has_one_job(db, a):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    got, gate, lock = [], threading.Barrier(6), threading.Lock()

    def go():
        gate.wait()
        try:
            out = take_job(db, kf, "w-1")
            r = (out["job_id"], out["replayed"])
        except psycopg.Error as e:
            r = ("error", e.sqlstate)
        with lock:
            got.append(r)

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ids = {g[0] for g in got}
    assert len(ids) == 1 and "error" not in ids, got
    assert sorted(g[1] for g in got) == [False] + [True] * 5, got
    assert db.su("select count(*) from public.creative_jobs where film_take_id = %s", [kf])[0][0] == 1


def test_3_a_reclaim_racing_the_old_worker_never_makes_two_jobs_or_two_owners(db, a):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    stale(db, seg["id"])
    out, gate, lock = {}, threading.Barrier(3), threading.Lock()

    def old():
        gate.wait()
        try:
            r = take_job(db, kf, "w-1")["job_id"]
        except psycopg.Error as e:
            r = e.sqlstate
        with lock:
            out["w-1"] = r

    def new_claim():
        gate.wait()
        r = db.claim("w-2")
        with lock:
            out["claim"] = r and r["id"]

    def new_job():
        gate.wait()
        try:
            r = take_job(db, kf, "w-2")["job_id"]
        except psycopg.Error as e:
            r = e.sqlstate
        with lock:
            out["w-2"] = r

    threads = [threading.Thread(target=f) for f in (old, new_claim, new_job)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    jobs = db.su("select id, worker_id, status from public.creative_jobs where film_take_id = %s", [kf])
    assert len(jobs) <= 1, jobs
    holder = db.su("select worker_id from public.film_segments where id = %s", [seg["id"]])[0][0]
    # Whatever the order: the lease holder can take the job over now, and then it is the only one who owns it.
    final = take_job(db, kf, holder)
    assert final["job_worker"] == holder
    assert db.su("select count(*) from public.creative_jobs where film_take_id = %s and status in "
                 "('queued', 'running', 'provider_pending', 'processing', 'rendering')", [kf])[0][0] == 1, (out, jobs)


def test_3_every_lease_of_a_segment_shares_the_take_s_one_job(db, a):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    first = take_job(db, kf, "w-1")["job_id"]
    for w in ("w-2", "w-3"):
        stale(db, seg["id"])
        assert db.claim(w)["id"] == seg["id"]
        again = take_job(db, kf, w)
        assert again["job_id"] == first and again["job_worker"] == w and again["replayed"] is True
    assert db.su("select count(*) from public.creative_jobs where film_take_id = %s", [kf])[0][0] == 1


def test_3_a_take_that_failed_leaves_no_live_job_next_to_its_retry(db, a):
    """HOLE (medium). film_take_failed fails the take and plans attempt 2, but never ends the take's creative job: that is left to the
    worker's separate finish_creative_job, whose failure modules/film_orchestrator.py only logs. The attempt-2 take then gets a job of
    its own, and the shot has two live provider jobs, the first one still the old worker's to submit (advance 'submitting' is
    accepted) while nothing can ever pay for it. The database must end a take's job when it ends the take."""
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    first = take_job(db, kf, "w-1")["job_id"]
    out = db.fail(kf, "provider_error", "w-1", "provider_error")
    retry = out.get("retry_take_id")
    assert retry, out
    db.begin(retry, "w-1")
    second = take_job(db, retry, "w-1")["job_id"]
    live = db.su("select id from public.creative_jobs where film_take_id in (%s, %s) and status in "
                 "('queued', 'running', 'provider_pending', 'processing', 'rendering')", [kf, retry])
    assert [str(r[0]) for r in live] == [second], f"the failed take's job {first} is still live beside the retry's {second}"


# ── 4. a stale lease's job ──────────────────────────────────────────────────

def test_4_a_stale_lease_moves_no_money_whatever_it_calls(db, a):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    j = take_job(db, kf, "w-1")["job_id"]
    stale(db, seg["id"])
    assert db.claim("w-2")["id"] == seg["id"]
    before = money(db, a.org)
    captured = db.segment(seg["id"])[1]
    res = db.output(a.org, kf, "image", "image/png")
    assert err(lambda: db.succeed(kf, None, res, "w-1")) == ("NS409", "lease_lost")
    assert err(lambda: db.fail(kf, "provider_error", "w-1")) == ("NS409", "lease_lost")
    assert err(lambda: db.settle(seg["id"], "completed", "w-1")) == ("NS409", "lease_lost")
    for step, task in (("submitting", None), ("submitted", "lab-old-1")):
        advance(db, j, "w-1", step, task)  # whatever 0036 answers, the money below must not move
    try:
        finish(db, j, "w-1", True)
    except psycopg.Error:
        pass
    assert money(db, a.org) == before and db.segment(seg["id"])[1] == captured
    assert db.su("select status, coalesce(charged_credits, 0) from public.film_takes where id = %s", [kf])[0] == ("running", 0)


def test_4_after_another_worker_claims_the_segment_the_old_worker_cannot_drive_the_take_s_job(db, a):
    """HOLE (medium). The takeover is lazy: film_claim_segment hands w-2 the lease but leaves the take's live job w-1's until w-2
    reaches that take and calls film_take_job. In that window 0036's calls (which check only the job's worker id) still obey the
    worker that LOST the lease: it may mark the job 'submitting' and make the paid provider call nobody will be charged for, store a
    task id, or finish the job as completed. w-2 then finds a job that was submitted (or ended) under it and fails the take as
    worker_lost: a provider call the platform paid, a take the customer must wait a retry for. The lease that changed hands must take
    the segment's live jobs with it (or 0036's calls must ask the segment's lease for a payer 'film' job)."""
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    j = take_job(db, kf, "w-1")["job_id"]
    stale(db, seg["id"])
    db.su("update public.creative_jobs set heartbeat_at = now() where id = %s", [j])  # the old worker's job beat is still fresh
    assert db.claim("w-2")["id"] == seg["id"]
    obeyed = []
    if db.svc("select public.heartbeat_creative_job(%s, 'w-1')", [j]):
        obeyed.append("heartbeat")
    if advance(db, j, "w-1", "submitting"):
        obeyed.append("submitting")
    if advance(db, j, "w-1", "submitted", "lab-old-1"):
        obeyed.append("submitted")
    try:
        if finish(db, j, "w-1", True)["status"] == "completed":
            obeyed.append("completed")
    except psycopg.Error:
        pass
    assert obeyed == [], f"a worker that lost the lease still drove the take's job: {obeyed} ({job_row(db, j)})"


def test_4_a_take_the_sweep_ended_leaves_no_job_its_lost_worker_can_still_complete(db, a):
    """HOLE (medium, same root as the failed take). film_expire_segments (0171, unchanged) ends a lost worker's running take as
    worker_lost_not_charged and releases the hold, but the take's creative job stays 'running', w-1's. That worker, if it is only slow
    and not dead, may still submit it to the provider and complete it after the film's money was already settled."""
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    j = take_job(db, kf, "w-1")["job_id"]
    db.su("update public.film_segments set deadline_at = now() - interval '2 hours 1 minute' where id = %s", [seg["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.segment(seg["id"])[0] == "released"
    before = money(db, a.org)
    status = job_row(db, j)[0]
    went = advance(db, j, "w-1", "submitting")
    assert money(db, a.org) == before  # whatever happens to the job, the settled film's money does not move
    assert status not in ("queued", "running", "provider_pending", "processing") and went is False, \
        f"the job of a take the sweep ended is still {status} and its lost worker could submit it ({job_row(db, j)})"


# ── 5. invisible to the creative credit worker ──────────────────────────────

def test_5_a_film_job_handed_back_to_the_queue_is_never_claimed_by_the_credit_worker(db, a):
    """HOLE (medium). claim_creative_job (0036) picks the oldest 'queued' job of ANY payer. A film job becomes 'queued' through 0036's
    own advance 'requeue' (a worker's shutdown hand-back; film_take_job even has a branch for it), and the credit worker then claims
    it, runs it under its own worker id and submits it to the provider: a second paid call for one take that the customer is charged
    once for, and a job the film worker loses (film_take_job then hands it back, mid-flight). Nothing in the queue says payer 'film'
    is not the credit worker's."""
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    j = take_job(db, kf, "w-1")["job_id"]
    assert advance(db, j, "w-1", "requeue") is True
    handed = db.svc("select coalesce(jsonb_agg(jsonb_build_object('id', id, 'payer', payer)), '[]'::jsonb) "
                    "from public.claim_creative_job('creative-1')")
    assert [h for h in handed if h["payer"] == "film"] == [], f"the credit worker was handed a film job: {handed}"


def test_5_even_handed_a_film_job_the_credit_worker_charges_nothing(db, a):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    j = take_job(db, kf, "w-1")["job_id"]
    before = money(db, a.org)
    # However the job reaches it (see the test above), the credit worker's own path to money is finish_creative_job.
    db.su("update public.creative_jobs set worker_id = 'creative-1' where id = %s", [j])
    assert advance(db, j, "creative-1", "submitting") is True
    assert advance(db, j, "creative-1", "submitted", "lab-cw-1") is True
    assert err(lambda: finish(db, j, "creative-1", True, 3))[0] == "22023"
    assert finish(db, j, "creative-1", True)["status"] == "completed"
    assert float(job_row(db, j)[5]) == 0.0
    assert money(db, a.org) == before
    assert db.su("select status, coalesce(charged_credits, 0) from public.film_takes where id = %s", [kf])[0] == ("running", 0)


def test_5_a_fresh_film_job_is_never_claimed_and_the_queue_s_sweep_moves_no_money(db, a):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    j = take_job(db, kf, "w-1")["job_id"]
    assert db.svc("select count(*) from public.claim_creative_job('creative-1')") == 0
    assert job_row(db, j)[:2] == ("running", "w-1")
    before = money(db, a.org)
    db.su("update public.creative_jobs set heartbeat_at = now() - interval '11 minutes' where id = %s", [j])
    handed = db.svc("select coalesce(jsonb_agg(id), '[]'::jsonb) from public.claim_creative_job('creative-1')")
    assert str(j) not in [str(x) for x in handed]
    assert money(db, a.org) == before


def test_5_the_credit_worker_s_sweep_never_ends_a_film_job_whose_segment_lease_is_alive(db, a):
    """HOLE (low). The same claim_creative_job sweeps every stale running job, payer 'film' included: a film job whose own heartbeat
    lapsed (the film worker beats it beside the segment and swallows a failed beat) is ended 'failed worker_lost' by the CREDIT worker
    while the segment's lease is fresh and its worker is mid-poll on a paid provider task. The film worker's next step is then refused
    (job_lost) after the provider was already paid. A payer 'film' job's liveness is its segment's lease, not 0036's job heartbeat."""
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    j = take_job(db, kf, "w-1")["job_id"]
    assert advance(db, j, "w-1", "submitting") is True
    assert advance(db, j, "w-1", "submitted", "lab-task-9") is True
    assert db.svc("select public.film_heartbeat_segment(%s, 'w-1')", [seg["id"]]) is True
    db.su("update public.creative_jobs set heartbeat_at = now() - interval '11 minutes' where id = %s", [j])
    db.svc("select count(*) from public.claim_creative_job('creative-1')")
    assert job_row(db, j)[:2] == ("provider_pending", "w-1"), f"the credit worker's sweep ended a live film job: {job_row(db, j)}"


# ── 6. who calls what ───────────────────────────────────────────────────────

@pytest.mark.parametrize("call", [
    "select public.film_studio_on_for(%s::uuid)",
    "select public.film_take_job(%s::uuid, 'w-1')",
    "select public.film_take_inputs(t) from public.film_takes t where t.id = %s::uuid",
])
@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_6_no_browser_role_reaches_the_workers_calls(db, a, role, call):
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    arg = a.org if "on_for" in call else kf
    for user in ((None,) if role == "anon" else (a.owner, a.admin)):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, user, call, [arg])
        assert e.value.sqlstate == "42501", str(e.value)
    assert db.su("select count(*) from public.creative_jobs where film_take_id = %s", [kf])[0][0] == 0


def test_6_forged_claims_do_not_make_a_member_a_worker_or_an_owner(db, a):
    """An authenticated session whose claims SAY service_role, or carry no claims at all (the SQL editor's shape), is still the
    authenticated role: refused by the grant, and by owner_guard."""
    fid, seg = started(db, a)
    db.claim("w-1")
    kf = take_of(db, seg["id"], "keyframe")
    db.begin(kf, "w-1")
    for claims in (json.dumps({"role": "service_role", "sub": a.owner}), json.dumps({"role": "service_role"}), ""):
        with psycopg.connect(db.dsn, autocommit=False) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [claims])
            c.execute("set local role authenticated")
            with pytest.raises(psycopg.Error) as e:
                c.execute("select public.film_take_job(%s::uuid, 'w-1')", [kf])
            assert e.value.sqlstate == "42501"
            c.rollback()
        with psycopg.connect(db.dsn, autocommit=False) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [claims])
            c.execute("set local role authenticated")
            with pytest.raises(psycopg.Error) as e:
                c.execute("select public.set_org_film_studio_enabled(%s::uuid, false)", [a.org])
            assert e.value.sqlstate == "42501" and "only a platform owner or admin" in str(e.value), str(e.value)
            c.rollback()
    assert db.su("select public.film_studio_on_for(%s)", [a.org])[0][0] is True


def test_6_a_platform_admin_flips_another_org_s_switch_and_every_flip_is_audited(db, a):
    b = db.new_org()
    admin = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, %s)", [admin, f"platform-{admin[:8]}@breach.lab"])
    db.su("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin')", [admin, f"platform-{admin[:8]}@breach.lab"])
    n0 = db.su("select count(*) from public.security_events where kind = 'film_studio.org_enabled' and target = %s", [b.org])[0][0]
    # a's owner and admin are not platform admins: they cannot touch b, nor a.
    for who in (a.owner, a.admin, b.owner):
        for org in (a.org, b.org):
            assert err(lambda: db.one("authenticated", who, "select public.set_org_film_studio_enabled(%s::uuid, false)", [org]))[0] \
                == "42501"
    out = db.one("authenticated", admin, "select public.set_org_film_studio_enabled(%s::uuid, false)", [b.org])
    assert out == {"ok": True, "org_id": b.org, "enabled": False, "changed": True}, out
    assert db.su("select public.film_studio_on_for(%s)", [b.org])[0][0] is False
    assert db.su("select public.film_studio_on_for(%s)", [a.org])[0][0] is True
    ev = db.su("select detail ->> 'from', detail ->> 'to', detail ->> 'via' from public.security_events "
               "where kind = 'film_studio.org_enabled' and target = %s order by id", [b.org])
    assert len(ev) == n0 + 1 and ev[-1][:3] == ("true", "false", "admin"), ev
    assert db.su("select updated_by from public.org_film_settings where org_id = %s", [b.org])[0][0] == uuid.UUID(admin)
    db.one("authenticated", admin, "select public.set_org_film_studio_enabled(%s::uuid, true)", [b.org])
    assert db.su("select count(*) from public.security_events where kind = 'film_studio.org_enabled' and target = %s",
                 [b.org])[0][0] == n0 + 2


# ── 7. the platform switch off ──────────────────────────────────────────────

def test_7_with_the_platform_switch_off_quote_start_and_claim_refuse_even_for_an_org_switched_on(db, a):
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    fid2, seg = started(db, a)  # queued before the switch goes off
    before = money(db, a.org)
    starts = db.rate_used(a.admin, "start")
    try:
        db.su("select public.set_film_studio_enabled(false)")
        assert db.su("select public.film_studio_on_for(%s)", [a.org])[0][0] is False
        q = db.quote(a.editor, fid)
        assert q["film_studio_enabled"] is False and {"reason": "film_studio_disabled"} in q["blocked_by"]
        assert q["startable"] is False
        assert err(lambda: db.start(a.admin, fid, qid)) == ("NS409", "film_studio_disabled")
        assert db.claim("w-1") is None
        assert db.segment(seg["id"])[0] == "queued"
        assert money(db, a.org) == before and db.rate_used(a.admin, "start") == starts
        assert db.film_row(fid)[0] == "draft"
    finally:
        db.su("select public.set_film_studio_enabled(true)")
    assert db.claim("w-1")["id"] == seg["id"]
