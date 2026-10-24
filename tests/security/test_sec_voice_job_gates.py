"""Migration 0121 (Custom Voice): the queue gates G2 and G3, and the oracle on channel_voice_config_problem.

G2   a clone job that a worker parked and whose profile the owner then deleted must not stay queued for ever and block
     purge_voice_records (and with it the deletion of the account and of the organization).
G3   voice_requeue_overdue() puts failed purge / deletion jobs back, bounded and never where the work must not run;
     voice_overdue_report() says what is late, in counts and ages only.
ORACLE  a signed-in user who is not a member of the channel's organization, or who asks about a voice they cannot see, gets the
     answer an id that is no voice gets; the service role, the Actions pre-flight and the channels guard still get the truth.

Everything runs on the shared scenario (conftest ``conn`` / ``sc``) through the building blocks of test_sec_voice_profiles.py, inside
transactions that are rolled back. Nothing calls a provider: the worker is played by the test with the service role.
"""

from __future__ import annotations

import json
import re
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, as_superuser, user
from test_sec_voice_profiles import (  # noqa: F401  (world is a fixture: importing it makes it available here)
    GOOD, SHA, attach, become, blocked, cfg, claim, finish, make_approved, make_testing, request, requested, set_cfg, upload, vid, world)

KEYS = ("elevenlabs_voice_id", "elevenlabs_secondary_voice_id")


def purge(s, pid):
    become(s, SERVICE)
    return s.value("select public.purge_voice_records(%s)", [pid])


def done(s, job, worker="w1", ok=True, error=None):
    become(s, SERVICE)
    return s.value("select public.finish_voice_task(%s, %s, %s, %s)", [job["job_id"], worker, ok, error])


def jobs(s, pid, kind=None):
    become(s, None)
    q = "select kind, status, attempts, error_code from public.voice_clone_jobs where profile_id = %s"
    args = [pid]
    if kind:
        q += " and kind = %s"
        args.append(kind)
    return [tuple(r) for r in s.rows(q + " order by created_at, kind", args)]


def drain(s, worker="drain"):
    """Play the worker to the end of the queue: every job it hands out is answered ok. Returns the kinds, in order."""
    out = []
    for _ in range(20):
        job = claim(s, worker)
        if not job:
            break
        out.append(job["kind"])
        become(s, SERVICE)
        if job["kind"] == "clone":
            s.value("select public.finish_voice_clone(%s, %s, 'failed', null, null, null, 'worker_error')", [job["job_id"], worker])
        else:
            assert done(s, job, worker) == {"ok": True}
    return out


# ═══ G2: a clone job of a profile that is no longer pending ══════════════════════════════════════════════════════════════════

def parked_then_deleted(s, who, **kw):
    """The sequence the gate is about: the worker claims the clone and parks it (no answer), the owner deletes the voice, the lease
    runs out. Returns (profile id, the clone job as the worker saw it)."""
    r = requested(s, who, **kw)
    pid = r["profile_id"]
    assert upload(s, who, pid).ok
    job = claim(s, "w1")
    assert job and job["kind"] == "clone" and job["profile_id"] == pid and job["attempts"] == 1
    become(s, who)
    assert s.value("select public.delete_voice(%s)", [pid])["ok"]
    become(s, None)
    s.conn.execute("update public.voice_clone_jobs set heartbeat_at = now() - interval '1 hour' where id = %s", [job["job_id"]])
    return pid, job


def test_a_clone_parked_and_then_deleted_is_ended_and_the_purge_goes_through(conn, sc, world):
    s = world.su
    pid, job = parked_then_deleted(s, world.ed)
    nxt = claim(s, "w2")
    assert nxt and nxt["kind"] == "purge_sample" and nxt["profile_id"] == pid and nxt["status"] == "deleted"
    assert jobs(s, pid, "clone") == [("clone", "expired", 1, "profile_not_pending")], "ended once: it was claimed, so it says expired"
    assert done(s, nxt, "w2") == {"ok": True}
    assert claim(s, "w2") is None
    assert purge(s, pid) == {"ok": True}, "nothing is left to block it"
    become(s, None)
    assert s.value("select count(*) from public.voice_profiles where id = %s", [pid]) == 0


def test_without_the_gate_the_same_sequence_blocks_the_purge_for_ever(conn, sc, world):
    """The control: 0117's claim_voice_job leaves the clone job queued, so purge_voice_records answers job_outstanding. Proves the test
    above is not vacuous and says what 0121 fixed."""
    s = world.su
    become(s, None)
    sec_db.take_off_0121(s)
    pid, job = parked_then_deleted(s, world.ed)
    nxt = claim(s, "w2")
    assert nxt["kind"] == "purge_sample"
    assert done(s, nxt, "w2") == {"ok": True}
    assert claim(s, "w2") is None
    assert jobs(s, pid, "clone") == [("clone", "queued", 1, None)]
    assert purge(s, pid) == {"ok": False, "error": "job_outstanding"}
    for _ in range(3):
        assert claim(s, "w3") is None
    assert purge(s, pid) == {"ok": False, "error": "job_outstanding"}, "and it stays so"


def test_a_queued_clone_of_a_deleted_profile_that_was_never_claimed_is_cancelled(conn, sc, world):
    """A row that is stranded already (the state a live database may hold today): queued, never claimed, the profile deleted."""
    s = world.su
    r = requested(s, world.ed)
    pid = r["profile_id"]
    become(s, world.ed)
    s.value("select public.delete_voice(%s)", [pid])
    become(s, None)
    s.conn.execute("update public.voice_clone_jobs set status = 'cancelled' where profile_id = %s and kind = 'clone'", [pid])
    s.conn.execute("insert into public.voice_clone_jobs (profile_id, user_id, kind, phrase) values (%s, %s, 'clone', 'apple river candle')",
                   [pid, world.ed.uid])
    assert drain(s) == ["purge_sample"], "the purge delete_voice queued"
    rows = jobs(s, pid, "clone")
    assert rows[-1] == ("clone", "cancelled", 0, "profile_not_pending"), rows
    assert purge(s, pid) == {"ok": True}


def test_a_stranded_clone_of_a_rejected_profile_with_a_claimed_attempt_asks_for_a_sweep_even_when_the_sample_is_purged(conn, sc, world):
    """A claimed attempt may have created a voice whose answer was lost; the purge job is also the provider sweep for a profile with no
    recorded voice, so it is queued although the sample is already gone."""
    s = world.su
    r = requested(s, world.ed)
    pid = r["profile_id"]
    become(s, None)
    s.conn.execute("update public.voice_profiles set status = 'rejected', reject_reason = 'worker_lost', sample_state = 'purged' where id = %s", [pid])
    s.conn.execute("update public.voice_clone_jobs set status = 'queued', attempts = 2 where profile_id = %s and kind = 'clone'", [pid])
    job = claim(s, "w1")
    assert job and job["kind"] == "purge_sample" and job["profile_id"] == pid and job["status"] == "rejected" and job["provider_voice_id"] is None
    assert jobs(s, pid, "clone") == [("clone", "expired", 2, "profile_not_pending")]
    assert done(s, job, "w1") == {"ok": True}
    become(s, None)
    assert s.value("select sample_state from public.voice_profiles where id = %s", [pid]) == "purged"


def test_a_stored_sample_of_a_stranded_profile_is_marked_for_purging_with_its_job(conn, sc, world):
    """sample_state follows the queue: when the gate queues the purge, the sample reads purge_pending (the report and
    purge_voice_records read that state), not the 'stored' it was left in."""
    s = world.su
    r = requested(s, world.ed)
    pid = r["profile_id"]
    become(s, None)
    s.conn.execute("update public.voice_profiles set status = 'rejected', reject_reason = 'worker_error', sample_state = 'stored' where id = %s", [pid])
    s.conn.execute("update public.voice_clone_jobs set status = 'queued', attempts = 1 where profile_id = %s and kind = 'clone'", [pid])
    job = claim(s, "w1")
    assert job and job["kind"] == "purge_sample" and job["profile_id"] == pid
    become(s, None)
    assert s.value("select sample_state from public.voice_profiles where id = %s", [pid]) == "purge_pending"


def test_a_never_claimed_clone_of_a_profile_whose_sample_is_already_purged_queues_nothing(conn, sc, world):
    s = world.su
    r = requested(s, world.ed)
    pid = r["profile_id"]
    become(s, None)
    s.conn.execute("update public.voice_profiles set status = 'rejected', reject_reason = 'sample_timeout' where id = %s", [pid])
    s.conn.execute("update public.voice_clone_jobs set status = 'queued' where profile_id = %s and kind = 'clone'", [pid])
    assert claim(s, "w1") is None
    assert jobs(s, pid) == [("clone", "cancelled", 0, "profile_not_pending")], "no sample, no attempt: nothing to clean"


def test_a_recorded_provider_voice_gets_its_deletion_queued(conn, sc, world):
    s = world.su
    r = requested(s, world.ed)
    pid = r["profile_id"]
    become(s, None)
    voice = vid()
    s.conn.execute("update public.voice_profiles set status = 'deleted', deleted_at = now(), provider = 'elevenlabs', provider_voice_id = %s, "
                   "sample_state = 'purged' where id = %s", [voice, pid])
    s.conn.execute("update public.voice_clone_jobs set status = 'queued' where profile_id = %s and kind = 'clone'", [pid])
    job = claim(s, "w1")
    assert job and job["kind"] == "delete_provider" and job["provider_voice_id"] == voice
    assert jobs(s, pid) == [("clone", "cancelled", 0, "profile_not_pending"), ("delete_provider", "running", 1, None)]
    assert done(s, job, "w1") == {"ok": True}
    assert purge(s, pid) == {"ok": True}


def test_the_gate_is_idempotent_and_queues_each_cleanup_once(conn, sc, world):
    s = world.su
    pid, job = parked_then_deleted(s, world.ed)
    first = claim(s, "w2")
    assert first["kind"] == "purge_sample"
    for _ in range(3):
        assert claim(s, "w3") is None, "the one purge job is running; nothing else is handed out"
    become(s, None)
    assert s.value("select count(*) from public.voice_clone_jobs where profile_id = %s and kind = 'purge_sample'", [pid]) == 1
    assert s.value("select count(*) from public.voice_clone_jobs where profile_id = %s and kind = 'delete_provider'", [pid]) == 0
    assert jobs(s, pid, "clone") == [("clone", "expired", 1, "profile_not_pending")]


def test_a_running_clone_whose_lease_has_not_run_out_is_left_to_its_worker(conn, sc, world):
    """The owner deleted the voice while a worker is cloning it: finish_voice_clone answers that job (and queues the provider deletion),
    so the gate must not end it under the worker's feet."""
    s = world.su
    r = requested(s, world.ed)
    pid = r["profile_id"]
    assert upload(s, world.ed, pid).ok
    job = claim(s, "w1")
    become(s, world.ed)
    s.value("select public.delete_voice(%s)", [pid])
    nxt = claim(s, "w2")
    assert nxt["kind"] == "purge_sample"
    assert done(s, nxt, "w2") == {"ok": True}
    assert claim(s, "w2") is None
    assert jobs(s, pid, "clone") == [("clone", "running", 1, None)]
    voice = vid()
    res = finish(s, job, voice=voice, worker="w1")
    assert res["ok"] and res["status"] == "deleted"
    kinds = drain(s)
    assert "delete_provider" in kinds
    assert purge(s, pid) == {"ok": True}


def test_a_clone_that_is_still_pending_is_handed_out_as_before(conn, sc, world):
    s = world.su
    r = requested(s, world.ed)
    pid = r["profile_id"]
    assert upload(s, world.ed, pid).ok
    job = claim(s, "w1")
    assert job["kind"] == "clone" and job["profile_id"] == pid and job["status"] == "pending_verification"
    assert jobs(s, pid, "clone") == [("clone", "running", 1, None)]
    # and another pending clone with no sample yet stays queued, untouched
    r2 = requested(s, world.vo)
    assert claim(s, "w2") is None
    assert jobs(s, r2["profile_id"], "clone") == [("clone", "queued", 0, None)]


def test_a_live_voice_and_its_kept_sample_are_never_touched(conn, sc, world):
    """The gate looks at deleted and rejected profiles only. An approved voice whose sample the owner keeps has no live clone job; even
    if one were left behind it would not be turned into a purge of the kept sample."""
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a, keep=True)
    become(s, None)
    s.conn.execute("insert into public.voice_clone_jobs (profile_id, user_id, kind, phrase) values (%s, %s, 'clone', 'apple river candle')",
                   [pid, world.vo.uid])
    before = s.rows("select status, sample_state, provider_voice_id from public.voice_profiles where id = %s", [pid])
    assert claim(s, "w1") is None
    become(s, None)
    assert s.rows("select status, sample_state, provider_voice_id from public.voice_profiles where id = %s", [pid]) == before
    assert jobs(s, pid, "clone")[-1] == ("clone", "queued", 0, None), "left as it was"
    assert s.value("select count(*) from public.voice_clone_jobs where profile_id = %s and kind in ('purge_sample', 'delete_provider')", [pid]) == 0


def test_account_and_organization_deletion_go_through_once_the_voices_are_purged(conn, sc, world):
    s = world.su
    become(s, None)
    org = s.value("insert into public.organizations (name, slug) values ('Gate org', %s) returning id", ["gate-" + uuid.uuid4().hex[:8]])
    who = user("gate-user", f"gate-{uuid.uuid4().hex[:6]}@a.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'editor') returning 1", [org, who.uid, who.email])
    pid, job = parked_then_deleted(s, who, org=str(org))
    become(s, None)
    out = s.run("delete from auth.users where id = %s", [who.uid])
    assert not out.ok and out.sqlstate == "23503", "the account cannot go while its voice record is there"
    out = s.run("delete from public.organizations where id = %s", [org])
    assert not out.ok and out.sqlstate == "23503", "nor can the organization"
    assert drain(s) == ["purge_sample"]
    assert purge(s, pid) == {"ok": True}
    become(s, None)
    assert s.run("delete from auth.users where id = %s", [who.uid]).ok, "the account goes"
    assert s.run("delete from public.organizations where id = %s", [org]).ok, "and so does the organization"


def test_a_delete_voice_for_an_approved_voice_still_purges_through_the_normal_path(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, world.vo)
    assert s.value("select public.delete_voice(%s)", [pid])["ok"]
    kinds = sorted(drain(s))
    assert kinds == ["delete_provider", "purge_sample"]
    assert purge(s, pid) == {"ok": True}


# ═══ G3: voice_requeue_overdue ══════════════════════════════════════════════════════════════════════════════════════════════

def deleted_profile(s, who, *, voice=None, sample="purge_pending"):
    """A deleted profile as a worker leaves it: its jobs are NOT created; the test adds the ones it needs."""
    r = requested(s, who)
    pid = r["profile_id"]
    become(s, None)
    s.conn.execute("update public.voice_clone_jobs set status = 'cancelled', finished_at = now() where profile_id = %s", [pid])
    if voice:
        s.conn.execute("update public.voice_profiles set status = 'deleted', deleted_at = now(), provider = 'elevenlabs', provider_voice_id = %s, "
                       "sample_state = %s where id = %s", [voice, sample, pid])
    else:
        s.conn.execute("update public.voice_profiles set status = 'deleted', deleted_at = now(), sample_state = %s where id = %s", [sample, pid])
    return pid


def fresh_user(s, org):
    """A new editor of the organization: the requests per person per day (5) and the live voices (3) are per user."""
    become(s, None)
    who = user("gate-" + uuid.uuid4().hex[:6], f"gate-{uuid.uuid4().hex[:8]}@a.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'editor') returning 1", [org, who.uid, who.email])
    return who


def add_job(s, pid, uid, kind, status="failed", age="4 hours", attempts=3, error="provider_error"):
    become(s, None)
    return s.value(
        "insert into public.voice_clone_jobs (profile_id, user_id, kind, status, attempts, error_code, created_at, started_at, finished_at) "
        "values (%s, %s, %s, %s, %s, %s, now() - %s::interval - interval '1 hour', now() - %s::interval - interval '1 hour', "
        "case when %s in ('failed', 'succeeded') then now() - %s::interval end) returning id",
        [pid, uid, kind, status, attempts, error if status == "failed" else None, age, age, status, age])


def requeue(s, older="3 hours"):
    become(s, SERVICE)
    return s.run("select public.voice_requeue_overdue(%s::interval)", [older])


def job_row(s, jid):
    become(s, None)
    return tuple(s.rows("select status, attempts, worker_id, finished_at is null, kind from public.voice_clone_jobs where id = %s", [jid])[0])


def test_a_failed_purge_is_put_back_with_its_attempts_reset(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed)
    jid = add_job(s, pid, world.ed.uid, "purge_sample")
    out = requeue(s)
    assert out.ok and out.rows[0][0] == {"requeued": 1, "purge_sample": 1, "delete_provider": 0}, out
    assert job_row(s, jid) == ("queued", 0, None, True, "purge_sample")
    job = claim(s, "w1")
    assert job["job_id"] == str(jid) and job["attempts"] == 1
    assert done(s, job, "w1") == {"ok": True}
    assert purge(s, pid) == {"ok": True}


def test_a_failed_provider_deletion_of_a_deleted_voice_is_put_back(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed, voice=vid(), sample="purged")
    jid = add_job(s, pid, world.ed.uid, "delete_provider")
    out = requeue(s)
    assert out.rows[0][0] == {"requeued": 1, "purge_sample": 0, "delete_provider": 1}
    assert job_row(s, jid)[0] == "queued"


def test_a_job_that_failed_too_recently_is_left_and_the_age_is_the_callers(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed)
    jid = add_job(s, pid, world.ed.uid, "purge_sample", age="2 hours")
    assert requeue(s, "3 hours").rows[0][0]["requeued"] == 0
    assert job_row(s, jid)[0] == "failed"
    assert requeue(s, "1 hour").rows[0][0]["requeued"] == 1
    assert job_row(s, jid)[0] == "queued"


@pytest.mark.parametrize("age", [None, "0 seconds", "59 minutes", "31 days", "-3 hours"])
def test_the_age_must_be_between_one_hour_and_thirty_days(conn, sc, world, age):
    s = world.su
    become(s, SERVICE)
    out = s.run("select public.voice_requeue_overdue(%s::interval)", [age])
    assert not out.ok and out.sqlstate == "22023", (age, out)


def test_the_age_has_a_default_of_three_hours(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed)
    old = add_job(s, pid, world.ed.uid, "purge_sample", age="4 hours")
    pid2 = deleted_profile(s, world.vo)
    new = add_job(s, pid2, world.vo.uid, "purge_sample", age="2 hours")
    become(s, SERVICE)
    assert s.value("select public.voice_requeue_overdue()")["requeued"] == 1
    assert job_row(s, old)[0] == "queued" and job_row(s, new)[0] == "failed"


def test_a_clone_job_is_never_put_back(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed)
    become(s, None)
    s.conn.execute("update public.voice_profiles set sample_state = 'purge_pending' where id = %s", [pid])
    clone = add_job(s, pid, world.ed.uid, "clone", error="worker_lost")
    # a pending profile's failed clone, too
    r = requested(s, world.vo)
    become(s, None)
    s.conn.execute("update public.voice_clone_jobs set status = 'failed', finished_at = now() - interval '9 hours', error_code = 'worker_lost' "
                   "where profile_id = %s", [r["profile_id"]])
    assert requeue(s).rows[0][0]["requeued"] == 0
    assert job_row(s, clone)[0] == "failed"
    assert jobs(s, r["profile_id"], "clone") == [("clone", "failed", 0, "worker_lost")]


def test_work_is_not_resurrected_for_a_profile_where_it_must_not_run(conn, sc, world):
    s = world.su
    cases = {}
    # the live voices first (their own jobs are drained, so the synthetic ones below are the only ones in the queue)
    live, voice = make_approved(s, world.alice, world.org_a)
    drain(s)
    kept, _ = make_approved(s, world.vo, world.org_a, keep=True)
    drain(s)
    # 1. a purge whose sample is already purged
    p = deleted_profile(s, world.ed, sample="purged")
    cases["purged_sample"] = add_job(s, p, world.ed.uid, "purge_sample")
    # 2. a purge for a profile still waiting for its verification
    r = requested(s, fresh_user(s, world.org_a))
    become(s, None)
    s.conn.execute("update public.voice_clone_jobs set status = 'cancelled', finished_at = now() where profile_id = %s", [r["profile_id"]])
    s.conn.execute("update public.voice_profiles set sample_state = 'purge_pending' where id = %s", [r["profile_id"]])
    cases["pending_profile"] = add_job(s, r["profile_id"], s.value("select user_id from public.voice_profiles where id = %s", [r["profile_id"]]), "purge_sample")
    # 3. a provider deletion for an approved (live) voice: it must never be deleted by a re-queue
    cases["live_voice"] = add_job(s, live, world.alice.uid, "delete_provider")
    # 4. a provider deletion for a deleted profile that has no recorded voice
    p4 = deleted_profile(s, world.ed)
    cases["no_voice_id"] = add_job(s, p4, world.ed.uid, "delete_provider")
    # 5. a provider deletion whose twin already succeeded
    p5 = deleted_profile(s, world.ed, voice=vid(), sample="purged")
    cases["already_gone"] = add_job(s, p5, world.ed.uid, "delete_provider")
    add_job(s, p5, world.ed.uid, "delete_provider", status="succeeded", age="1 hour", attempts=1)
    # 6. a purge for a live voice whose sample the owner keeps (sample_state stays 'stored': nobody asked to delete it)
    cases["kept_sample"] = add_job(s, kept, world.vo.uid, "purge_sample")
    out = requeue(s)
    assert out.ok and out.rows[0][0] == {"requeued": 0, "purge_sample": 0, "delete_provider": 0}, out
    for name, jid in cases.items():
        assert job_row(s, jid)[0] == "failed", name
    become(s, None)
    assert s.value("select sample_state from public.voice_profiles where id = %s", [kept]) == "stored"


def test_a_kept_sample_the_owner_asked_to_delete_is_put_back(conn, sc, world):
    s = world.su
    pid, _ = make_approved(s, world.vo, world.org_a, keep=True)
    become(s, world.vo)
    assert s.value("select public.delete_voice_sample(%s)", [pid])["ok"]
    become(s, None)
    s.conn.execute("update public.voice_clone_jobs set status = 'failed', attempts = 3, error_code = 'storage_http', finished_at = now() - interval '5 hours' "
                   "where profile_id = %s and kind = 'purge_sample'", [pid])
    assert requeue(s).rows[0][0]["purge_sample"] == 1


def test_one_job_per_profile_and_kind_and_never_beside_a_live_one(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed)
    old = add_job(s, pid, world.ed.uid, "purge_sample", age="9 hours")
    new = add_job(s, pid, world.ed.uid, "purge_sample", age="5 hours")
    out = requeue(s)
    assert out.ok and out.rows[0][0]["requeued"] == 1, out
    assert job_row(s, new)[0] == "queued" and job_row(s, old)[0] == "failed", "the newest failure is the one put back"
    # with a live job of the same kind, the call neither fails nor adds a second
    pid2 = deleted_profile(s, world.vo)
    add_job(s, pid2, world.vo.uid, "purge_sample", status="queued", age="1 hour", attempts=0)
    failed = add_job(s, pid2, world.vo.uid, "purge_sample", age="6 hours")
    out = requeue(s)
    assert out.ok and out.rows[0][0]["requeued"] == 0, out
    assert job_row(s, failed)[0] == "failed"


def test_at_most_twenty_per_call_oldest_first(conn, sc, world):
    s = world.su
    ids = []
    for n in range(25):
        who = fresh_user(s, world.org_a)
        pid = deleted_profile(s, who)
        ids.append(add_job(s, pid, who.uid, "purge_sample", age=f"{4 + n} hours"))
    out = requeue(s)
    assert out.ok and out.rows[0][0] == {"requeued": 20, "purge_sample": 20, "delete_provider": 0}
    states = {jid: job_row(s, jid)[0] for jid in ids}
    assert [j for j in ids if states[j] == "failed"] == ids[:5], "the five youngest failures wait"
    out = requeue(s)
    assert out.rows[0][0]["requeued"] == 5
    assert requeue(s).rows[0][0]["requeued"] == 0


def test_the_requeue_writes_nothing_but_the_queue_rows(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed)
    add_job(s, pid, world.ed.uid, "purge_sample")
    become(s, None)
    snap = lambda: (s.rows("select * from public.voice_profiles order by id"), s.rows("select count(*) from public.voice_consents"),  # noqa: E731
                    s.rows("select count(*) from public.voice_deletion_records"), s.rows("select count(*) from public.app_audit_log"))
    before = snap()
    assert requeue(s).rows[0][0]["requeued"] == 1
    become(s, None)
    assert snap() == before


# ═══ G3: voice_overdue_report ═══════════════════════════════════════════════════════════════════════════════════════════════

LINES = ("failed_purge_sample", "failed_delete_provider", "late_queued", "stranded_clone", "purge_without_job", "provider_without_job")


def report(s):
    become(s, SERVICE)
    return s.value("select public.voice_overdue_report()")


def test_the_report_has_closed_fields_and_nothing_but_numbers(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed, voice=vid())
    add_job(s, pid, world.ed.uid, "purge_sample")
    add_job(s, pid, world.ed.uid, "delete_provider")
    r = report(s)
    assert set(r) == {*LINES, "total"}
    for line in LINES:
        assert set(r[line]) == {"count", "oldest_seconds"}, line
        assert isinstance(r[line]["count"], int) and (r[line]["oldest_seconds"] is None or isinstance(r[line]["oldest_seconds"], int))
    assert isinstance(r["total"], int)
    text = json.dumps(r)
    assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", text), "no id of anything"
    assert world.ed.uid not in text and world.ed.email not in text and "@" not in text


def test_the_report_counts_what_is_late_and_nothing_else(conn, sc, world):
    s = world.su
    become(s, None)
    # everything the lab has so far is clean (the seeded voice of the scenario is approved)
    base = report(s)
    assert all(base[line]["count"] == 0 and base[line]["oldest_seconds"] is None for line in LINES), base
    assert base["total"] == 0
    pid = deleted_profile(s, world.ed, voice=vid())
    add_job(s, pid, world.ed.uid, "purge_sample", age="5 hours")
    add_job(s, pid, world.ed.uid, "delete_provider", age="6 hours")
    r = report(s)
    assert r["failed_purge_sample"]["count"] == 1 and 5 * 3600 <= r["failed_purge_sample"]["oldest_seconds"] < 5 * 3600 + 600
    assert r["failed_delete_provider"]["count"] == 1 and 6 * 3600 <= r["failed_delete_provider"]["oldest_seconds"] < 6 * 3600 + 600
    # a profile with a purge waiting and no job at all, and a deleted voice with no deletion job
    pid2 = deleted_profile(s, world.vo, voice=vid())
    r = report(s)
    assert r["purge_without_job"]["count"] == 1 and r["provider_without_job"]["count"] == 1, "a profile with a failed job is in the failed line only"
    assert r["purge_without_job"]["oldest_seconds"] is not None
    # a purge queued for four hours is late; one queued a minute ago is not
    add_job(s, pid2, world.vo.uid, "purge_sample", status="queued", age="4 hours", attempts=0)
    r = report(s)
    assert r["late_queued"]["count"] == 1 and r["purge_without_job"]["count"] == 0
    r2 = deleted_profile(s, world.alice)
    add_job(s, r2, world.alice.uid, "purge_sample", status="queued", age="0 seconds", attempts=0)
    assert report(s)["late_queued"]["count"] == 1
    # a stranded clone
    pid3 = deleted_profile(s, world.ed)
    become(s, None)
    s.conn.execute("insert into public.voice_clone_jobs (profile_id, user_id, kind, phrase) values (%s, %s, 'clone', 'apple river candle')", [pid3, world.ed.uid])
    assert report(s)["stranded_clone"]["count"] == 1
    assert claim(s, "w1") is not None and report(s)["stranded_clone"]["count"] == 0, "claim_voice_job ends it"
    r = report(s)
    assert r["total"] == sum(r[line]["count"] for line in LINES)


def test_a_failed_purge_whose_sample_is_already_gone_is_not_reported(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed, sample="purged")
    add_job(s, pid, world.ed.uid, "purge_sample")
    r = report(s)
    assert r["failed_purge_sample"] == {"count": 0, "oldest_seconds": None}, "the sample is purged: nothing is outstanding"


def test_a_clone_a_worker_is_still_running_for_a_deleted_profile_is_not_stranded(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed)
    add_job(s, pid, world.ed.uid, "clone", status="running", age="0 seconds", attempts=1)
    assert report(s)["stranded_clone"] == {"count": 0, "oldest_seconds": None}, "its worker will answer it"


def test_a_succeeded_deletion_and_a_purged_sample_are_not_reported(conn, sc, world):
    s = world.su
    pid = deleted_profile(s, world.ed, voice=vid(), sample="purged")
    add_job(s, pid, world.ed.uid, "delete_provider", status="succeeded", age="9 hours", attempts=1)
    r = report(s)
    assert r["provider_without_job"]["count"] == 0 and r["purge_without_job"]["count"] == 0 and r["failed_delete_provider"]["count"] == 0


# ═══ who may call what ══════════════════════════════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("sql_", ["select public.voice_requeue_overdue('3 hours'::interval)", "select public.voice_requeue_overdue()",
                                  "select public.voice_overdue_report()",
                                  "select public.channel_voice_config_problem_core('c', null, '{}'::jsonb, '{}'::jsonb)"])
@pytest.mark.parametrize("who_name", ["anon", "alice", "bob", "operator", "helper"])
def test_only_the_service_role_calls_the_sweep_functions_and_nobody_the_core(conn, sc, world, sql_, who_name):
    s = world.su
    who = {"anon": ANON, "alice": world.alice, "bob": world.bob, "operator": world.operator, "helper": world.helper}[who_name]
    become(s, who)
    out = s.run(sql_)
    assert not out.ok and out.sqlstate == "42501", (who_name, sql_, out)


def test_the_service_role_cannot_call_the_core_either(conn, sc, world):
    s = world.su
    become(s, SERVICE)
    out = s.run("select public.channel_voice_config_problem_core('c', null, '{}'::jsonb, '{}'::jsonb)")
    assert not out.ok and out.sqlstate == "42501", out


def test_the_service_role_still_has_no_privilege_on_a_voice_table(conn, sc, world):
    s = world.su
    become(s, SERVICE)
    for t in ("voice_clone_jobs", "voice_profiles"):
        out = s.run(f"select count(*) from public.{t}")
        assert not out.ok and out.sqlstate == "42501", (t, out)


def test_request_voice_clone_is_still_granted_to_nobody(conn, sc, world):
    s = world.su
    become(s, None)
    sig = "public.request_voice_clone(text,jsonb,text,boolean,text,uuid)"
    for role in ("anon", "authenticated", "service_role", "public"):
        assert s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [role, sig]) is False, role


def test_every_new_definer_pins_its_search_path(conn, sc, world):
    s = world.su
    become(s, None)
    for fn in ("voice_requeue_overdue", "voice_overdue_report", "channel_voice_config_problem", "channel_voice_config_problem_core", "claim_voice_job"):
        row = s.rows("select p.prosecdef, p.proconfig::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = %s", [fn])
        assert row and all(r[0] and "search_path=public, pg_temp" in r[1] for r in row), (fn, row)


# ═══ ORACLE: channel_voice_config_problem ═══════════════════════════════════════════════════════════════════════════════════

def ask(s, who, channel, voice, *, org="own", key="elevenlabs_voice_id", old=None):
    """The Run-now route's call: the function as the signed-in user (or the service key, or the database owner for who None)."""
    become(s, who)
    out = s.run("select public.channel_voice_config_problem(%s, %s, %s::jsonb, %s::jsonb)",
                [channel, None if org == "own" else org, json.dumps(old or {}), json.dumps({key: voice})])
    return out


def answer(out):
    assert out.ok, out
    return out.rows[0][0]


@pytest.fixture()
def nobody_world(world):
    """A signed-in user who is a member of no organization at all."""
    world.nobody = user("oracle-nobody", "oracle-nobody@x.test")
    return world


@pytest.fixture()
def orc(conn, sc, nobody_world):
    s = nobody_world.su
    pid, voice = make_approved(s, nobody_world.vo, nobody_world.org_a)
    assert attach(s, nobody_world.vo, pid, nobody_world.chan_a).rows[0][0]["ok"]
    become(s, None)
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
           [nobody_world.nobody.uid, nobody_world.nobody.email])
    o = type("Oracle", (), {})()
    o.s, o.pid, o.voice, o.w = s, pid, voice, nobody_world
    return o


def test_the_service_role_and_the_database_owner_get_the_truth(conn, sc, orc):
    s, w = orc.s, orc.w
    for who in (SERVICE, None):
        assert answer(ask(s, who, w.chan_a, orc.voice)) is None, "attached to this channel as narrator: fine"
        assert answer(ask(s, who, w.chan_a2, orc.voice)) == "elevenlabs_voice_id", "a clone that is not attached here"
        assert answer(ask(s, who, w.chan_a, orc.voice, key="elevenlabs_secondary_voice_id")) == "elevenlabs_secondary_voice_id"
        assert answer(ask(s, who, w.chan_b, orc.voice)) == "elevenlabs_voice_id", "another organization's channel"
        assert answer(ask(s, who, w.chan_a, vid())) is None, "an id that is no voice"
        assert answer(ask(s, who, "no-such-channel", orc.voice)) == "elevenlabs_voice_id"


def test_a_member_of_the_organization_gets_the_truth_about_its_voices(conn, sc, orc):
    """The Run-now route: the signed-in member of the channel's organization, for a voice requested in that organization."""
    s, w = orc.s, orc.w
    for who in (w.ed, w.vo, w.alice, w.viewer):
        assert answer(ask(s, who, w.chan_a, orc.voice)) is None, who.name
        assert answer(ask(s, who, w.chan_a2, orc.voice)) == "elevenlabs_voice_id", who.name
        assert answer(ask(s, who, w.chan_a, orc.voice, key="elevenlabs_secondary_voice_id")) == "elevenlabs_secondary_voice_id", who.name


def test_a_member_is_refused_a_voice_that_was_deleted_or_whose_owner_left(conn, sc, orc):
    s, w = orc.s, orc.w
    become(s, w.vo)
    s.value("select public.delete_voice(%s)", [orc.pid])
    assert answer(ask(s, w.ed, w.chan_a, orc.voice)) == "elevenlabs_voice_id"


def test_a_stranger_gets_the_answer_an_id_that_is_no_voice_gets(conn, sc, orc):
    """The oracle: nobody outside the channel's organization, and nobody asking about a voice they cannot see, learns that an id is a clone."""
    s, w = orc.s, orc.w
    strangers = [w.bob, w.nobody, w.stranger, w.operator, w.helper]
    not_a_voice = vid()
    for who in strangers:
        for channel in (w.chan_a, w.chan_a2, w.chan_b, "no-such-channel"):
            for org in ("own", w.org_a, w.org_b, str(uuid.uuid4())):
                got = answer(ask(s, who, channel, orc.voice, org=org))
                control = answer(ask(s, who, channel, not_a_voice, org=org))
                assert got is None and control is None, (who.name, channel, org, got, control)
                for key in KEYS:
                    assert answer(ask(s, who, channel, orc.voice, org=org, key=key)) is None, (who.name, channel, org, key)


def test_a_member_of_another_organization_asking_on_their_own_channel_learns_nothing(conn, sc, orc):
    """bob administers organization B and its channel: a member of the channel's organization, but the voice was requested in A and is not
    his. This is the case the membership test alone would leave open (anyone can have a workspace and a channel of their own)."""
    s, w = orc.s, orc.w
    assert answer(ask(s, w.bob, w.chan_b, orc.voice)) is None
    assert answer(ask(s, w.bob, w.chan_b, orc.voice, org=w.org_a)) is None, "and the organization he names is not believed"
    assert answer(ask(s, w.bob, w.chan_a, orc.voice, org=w.org_b)) is None


def test_the_owner_of_a_voice_who_is_a_member_of_the_channels_organization_gets_the_truth(conn, sc, orc):
    """The voice was requested in A; its owner is also a member of B. On B's channel the owner may know their own voice is not attached."""
    s, w = orc.s, orc.w
    become(s, None)
    s.conn.execute("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer')", [w.org_b, w.vo.uid, w.vo.email])
    assert answer(ask(s, w.vo, w.chan_b, orc.voice)) == "elevenlabs_voice_id"
    assert answer(ask(s, w.ed, w.chan_b, orc.voice)) is None, "a colleague of the owner in A, who is not in B, is a stranger to B"


def test_a_teammate_of_another_user_in_the_same_organization_sees_the_organizations_voice(conn, sc, orc):
    s, w = orc.s, orc.w
    # ed did not request it, is a member of the organization it was requested in: allowed to know
    assert answer(ask(s, w.ed, w.chan_a2, orc.voice)) == "elevenlabs_voice_id"


def test_anon_cannot_call_it_at_all(conn, sc, orc):
    s, w = orc.s, orc.w
    out = ask(s, ANON, w.chan_a, orc.voice)
    assert not out.ok and out.sqlstate == "42501"


def test_a_value_that_is_not_a_string_is_refused_for_everybody_and_says_nothing_about_voices(conn, sc, orc):
    s, w = orc.s, orc.w
    for who in (SERVICE, None, w.ed, w.bob, w.nobody):
        for value in (12345678901234567890, ["x"], {"a": 1}, True):
            assert answer(ask(s, who, w.chan_a, value)) == "elevenlabs_voice_id", (getattr(who, "name", who), value)


def test_the_answer_for_a_member_is_still_exact_in_every_state_of_the_voice(conn, sc, orc):
    s, w = orc.s, orc.w
    # detached by the owner: refused
    become(s, w.vo)
    s.value("select public.detach_voice_from_channel(%s, %s)", [orc.pid, w.chan_a])
    assert answer(ask(s, w.ed, w.chan_a, orc.voice)) == "elevenlabs_voice_id"
    # attached again: fine
    assert attach(s, w.vo, orc.pid, w.chan_a).rows[0][0]["ok"]
    assert answer(ask(s, w.ed, w.chan_a, orc.voice)) is None
    # the owner is demoted: refused
    become(s, None)
    s.conn.execute("update public.org_members set role = 'viewer' where org_id = %s and user_id = %s", [w.org_a, w.vo.uid])
    assert answer(ask(s, w.ed, w.chan_a, orc.voice)) == "elevenlabs_voice_id"


def test_the_channels_guard_is_not_masked(conn, sc, orc):
    """The guard asks from inside its trigger and must keep refusing a custom voice that is not attached, whoever writes. Masking it
    would let anyone with a channel store another person's voice id in it."""
    s, w = orc.s, orc.w
    assert blocked(set_cfg(s, w.bob, w.chan_b, {"elevenlabs_voice_id": orc.voice}), "elevenlabs_voice_id")
    assert blocked(set_cfg(s, w.bob, w.chan_b, {"elevenlabs_secondary_voice_id": orc.voice}), "elevenlabs_secondary_voice_id")
    assert blocked(set_cfg(s, w.ed, w.chan_a2, {"elevenlabs_voice_id": orc.voice}), "elevenlabs_voice_id")
    assert blocked(set_cfg(s, SERVICE, w.chan_b, {"elevenlabs_voice_id": orc.voice}), "elevenlabs_voice_id")
    assert set_cfg(s, w.bob, w.chan_b, {"elevenlabs_voice_id": vid()}).ok, "an id that is no voice is allowed exactly as before"
    # create_channel (a definer that inserts the row, so the guard asks about a channel that does not exist yet)
    become(s, w.bob)
    out = s.run("select public.create_channel(%s, %s, 'Oracle test', 'tech', %s::jsonb)",
                ["oracle-test-" + uuid.uuid4().hex[:6], w.org_b, json.dumps({"elevenlabs_voice_id": orc.voice})])
    assert blocked(out, "elevenlabs_voice_id"), out


def test_the_guards_other_entry_points_still_refuse(conn, sc, orc):
    """Entry points 1 and 2 never asked this function; they are listed so a change here is seen to leave them alone."""
    from test_sec_voice_profiles import run_job, tts_job

    s, w = orc.s, orc.w
    assert blocked(tts_job(s, w.bob, w.org_b, orc.voice, status="queued"))
    assert blocked(run_job(s, w.chan_b, {"voice_id": orc.voice}, by=w.bob))
    assert run_job(s, w.chan_a, {}, by=w.ed).ok


def test_the_pre_flight_style_call_with_the_service_key_is_unchanged_for_every_slot(conn, sc, orc):
    """modules/voice_gate.py asks about the narrator and the secondary voice in one call, with the service key."""
    s, w = orc.s, orc.w
    become(s, SERVICE)
    out = s.run("select public.channel_voice_config_problem(%s, %s, '{}'::jsonb, %s::jsonb)",
                [w.chan_a, w.org_a, json.dumps({"elevenlabs_voice_id": orc.voice, "elevenlabs_secondary_voice_id": orc.voice})])
    assert answer(out) == "elevenlabs_secondary_voice_id", "attached as narrator only: the quote voice is refused"
    out = s.run("select public.channel_voice_config_problem(%s, %s, '{}'::jsonb, %s::jsonb)",
                [w.chan_a, w.org_a, json.dumps({"elevenlabs_voice_id": orc.voice, "elevenlabs_secondary_voice_id": vid()})])
    assert answer(out) is None


def test_the_wrapper_does_the_same_lookups_whatever_it_answers(conn, sc, orc):
    """No timing difference is claimed that cannot be shown, but the work is the same: the masked and the unmasked answer both read
    the profile and the membership. Pinned from the catalog, not the clock: the body asks before it decides."""
    s = orc.s
    become(s, None)
    body = s.value("select prosrc from pg_proc where oid = 'public.channel_voice_config_problem(text, uuid, jsonb, jsonb)'::regprocedure")
    assert body.index("select * into pr") < body.index("if k is not null and is_one and not visible")
    assert body.index("voice_caller_member") < body.index("if k is not null and is_one and not visible")


# ═══ the file itself: replay, drift guard, rollback ═════════════════════════════════════════════════════════════════════════

MIG = sec_db.MIGRATION_0121
SIGS = ("public.claim_voice_job(text)", "public.channel_voice_config_problem(text,uuid,jsonb,jsonb)",
        "public.channel_voice_config_problem_core(text,uuid,jsonb,jsonb)", "public.voice_requeue_overdue(interval)",
        "public.voice_overdue_report()")


def snapshot(su):
    return {sig: (su.value("select pg_get_functiondef(%s::regprocedure)", [sig]), su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sig]))
            for sig in SIGS}


def test_applying_it_again_changes_nothing_and_keeps_every_row(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, None)
    before = snapshot(s)
    counts = [s.value(f"select count(*) from public.{t}") for t in ("voice_profiles", "voice_clone_jobs", "voice_consents", "voice_channel_attachments")]
    s.conn.execute(MIG.read_text(encoding="utf-8"))
    s.conn.execute(MIG.read_text(encoding="utf-8"))
    assert snapshot(s) == before
    assert counts == [s.value(f"select count(*) from public.{t}") for t in ("voice_profiles", "voice_clone_jobs", "voice_consents", "voice_channel_attachments")]


def _swap(s, sig_def, body):
    s.conn.execute(sig_def + " as $f$" + body + "$f$")


def test_the_migration_refuses_a_live_body_it_has_not_seen_and_accepts_a_reformatted_one(conn, sc, world):
    s = world.su
    become(s, None)
    text = MIG.read_text(encoding="utf-8")
    claim_def = "create or replace function public.claim_voice_job(p_worker text) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp"
    ccp_def = ("create or replace function public.channel_voice_config_problem(p_channel text, p_org uuid, p_old jsonb, p_new jsonb) returns text "
               "language plpgsql stable security definer set search_path = public, pg_temp")
    claim_src = s.value("select prosrc from pg_proc where oid = 'public.claim_voice_job(text)'::regprocedure")
    ccp_src = s.value("select prosrc from pg_proc where oid = 'public.channel_voice_config_problem(text,uuid,jsonb,jsonb)'::regprocedure")
    # white space only: accepted
    _swap(s, claim_def, claim_src.replace("\n", "\r\n\n").replace("  ", "\t"))
    _swap(s, ccp_def, ccp_src.replace("\n", "\r\n"))
    assert s.run(text).ok
    # a foreign claim body: refused, nothing replaced
    _swap(s, claim_def, claim_src.replace("interval '30 minutes'", "interval '31 minutes'", 1))
    out = s.run(text)
    assert not out.ok and out.sqlstate == "P0001" and "claim_voice_job" in out.error and "neither" in out.error, out
    _swap(s, claim_def, claim_src)
    # a foreign wrapper / 0117 body: refused
    _swap(s, ccp_def, ccp_src.replace("return k;", "return null;", 1))
    out = s.run(text)
    assert not out.ok and "channel_voice_config_problem" in out.error and "neither" in out.error, out
    _swap(s, ccp_def, ccp_src)
    # one of the new names already holding another body: refused
    s.conn.execute("create or replace function public.voice_overdue_report() returns jsonb language sql as $f$ select '{}'::jsonb $f$")
    out = s.run(text)
    assert not out.ok and "voice_overdue_report" in out.error, out
    s.conn.execute("drop function public.voice_requeue_overdue(interval)")
    s.conn.execute("create function public.voice_requeue_overdue(p_older_than interval) returns jsonb language sql as $f$ select '{}'::jsonb $f$")
    s.conn.execute("drop function public.voice_overdue_report()")
    out = s.run(text)
    assert not out.ok and "voice_requeue_overdue" in out.error, out
    s.conn.execute("drop function public.voice_requeue_overdue(interval)")
    assert s.run(text).ok


def test_the_hashes_in_the_file_match_what_the_database_computes(conn, sc, world):
    s = world.su
    become(s, None)
    head = MIG.read_text(encoding="utf-8").split("1. ORACLE", 1)[0]
    hashes = set(re.findall(r"'([0-9a-f]{32})'", head))
    live = {s.value("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = %s::regprocedure", [sig]) for sig in SIGS}
    assert live <= hashes and len(live) == 5, "five functions, five distinct bodies: the core is 0117's body, so it is the hash of 0117's"
    assert len(hashes) == 6, "0117's claim_voice_job and channel_voice_config_problem, and 0121's claim_voice_job, wrapper, requeue and report"


def test_the_rollback_puts_0117s_two_functions_back_byte_for_byte_and_0121_applies_again(conn, sc):
    admin = sec_db.admin_dsn()
    base = f"ns_voice_gates_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    claim_sig, ccp_sig = SIGS[0], SIGS[1]
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith("0121_")])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = {sg: (b.execute("select pg_get_functiondef(%s::regprocedure)", [sg]).fetchone()[0],
                         b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [sg]).fetchone()[0])
                    for sg in (claim_sig, ccp_sig)}
            fns = {r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
    finally:
        sec_db.drop_database(admin, base)
    rollback = sec_db.ROLLBACK_0121.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    with as_superuser(conn, commit=False) as su:
        applied = snapshot(su)
        su.conn.execute(body)
        for sg, (definition, acl) in want.items():
            assert su.value("select pg_get_functiondef(%s::regprocedure)", [sg]) == definition, sg
            assert su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sg]) == acl, sg
        now = {r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
        assert now == fns, sorted(now ^ fns)
        su.conn.execute(body)                         # the rollback replays
        su.conn.execute(MIG.read_text(encoding="utf-8"))
        assert snapshot(su) == applied


def test_the_rollback_refuses_a_body_it_has_not_seen(conn, sc, world):
    s = world.su
    become(s, None)
    rollback = sec_db.ROLLBACK_0121.read_text(encoding="utf-8")
    claim_src = s.value("select prosrc from pg_proc where oid = 'public.claim_voice_job(text)'::regprocedure")
    s.conn.execute("create or replace function public.claim_voice_job(p_worker text) returns jsonb language plpgsql volatile security definer "
                   "set search_path = public, pg_temp as $f$" + claim_src.replace("interval '30 minutes'", "interval '45 minutes'", 1) + "$f$")
    out = s.run("\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;")))
    assert not out.ok and "neither" in out.error, out
