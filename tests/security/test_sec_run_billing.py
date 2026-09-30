"""Migration 0041: a customer's queued run is paid for, and for the length it runs.

What would break without these (each fails on a database without 0041):

* C2 — a customer organization's render job with no credit hold is queued
  (and the worker, with NIGHTSHIFT_CREDITS_ENFORCE off, runs it for free);
* C1 — the hold prices one length and the job runs another: no length on the
  job (the worker then read the channel's target at run time, after the
  customer raised it), a job asking for more than its hold covers, or a
  target raised between the hold and the insert;
* (a) a browser attaches an API balance hold (api_hold_ref) to its own row;
* (b) a browser names a hold that is not an open, unused queue hold of the
  channel's own organization — another tenant's, a released, started,
  expired or Actions ("gh-") hold — so one hold pays twice or not at all;
* two runs racing one balance both get held and queued.

The operator's own (credits-exempt) organization and the public API's
create-video path keep working, and are checked as controls.
"""

from __future__ import annotations

import json
import threading
import uuid
from contextlib import contextmanager

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user

PRICES = {"video_minute": 12, "job_minimum": 5}  # 5 minutes = 60 credits


@contextmanager
def world(conn, sc, *, target=None, prices=True, channel=None, status=None, grant=None):
    """A rolled-back world: the price list, and the channel's target length
    (None = unset). Everything inside — holds, jobs — disappears with it."""
    channel = channel or sc.bob.channel
    with as_superuser(conn, commit=False) as s:
        if prices:
            for unit, rate in PRICES.items():
                s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
                       "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 "
                       "returning 1", [unit, rate])
        cfg = {} if target is None else {"target_duration_seconds": target}
        s.rows("update public.channels set agent_config = (agent_config - 'target_duration_seconds') || %s::jsonb "
               "where channel_id = %s returning 1", [json.dumps(cfg), channel])
        if status:
            s.rows("update public.channels set status = %s, credential_ref = coalesce(credential_ref, '{}'::jsonb) "
                   "|| '{\"verified_at\": \"2026-09-01T00:00:00Z\"}' where channel_id = %s returning 1",
                   [status, channel])
        if grant:
            s.value("select public.grant_credits(%s, %s, 'test')", [sc.bob.org, grant])
        yield s


def free_a_slot(s, ref) -> None:
    """Release one of the scenario's seeded holds, so the org has a parallel
    run slot free (0034: Alice's Creator plan allows 2 open holds, and the
    scenario already holds both). Rolled back with the world."""
    s.value("select public.release_credits(%s)", [ref])


def hold(s, org, amount=60, prefix="rj-") -> str:
    """A credit hold, reserved as the SQL editor (a trusted caller)."""
    ref = f"{prefix}{uuid.uuid4()}"
    s.value("select public.reserve_credits(%s, %s, %s)", [org, ref, amount])
    return ref


def queue(s, channel, params=None, **cols):
    """A render job as "Run now" in queue mode inserts it (0032's shape)."""
    row = {"channel_id": channel, "kind": "daily", "params": json.dumps(params or {}), **cols}
    names = ", ".join(row)
    marks = ", ".join(["%s"] * len(row))
    return s.run(f"insert into public.render_jobs ({names}) values ({marks}) returning params", list(row.values()))


def duration_of(out):
    assert out.ok, out
    return out.rows[0][0].get("duration")


# ── C2: someone pays, whatever the env flag says ────────────────────────────

def test_customer_run_without_a_credit_hold_is_refused(conn, sc):
    with world(conn, sc, target=300):
        with acting(conn, sc.bob.actor) as s:
            browser = queue(s, sc.bob.channel, {"duration": 300})
        with acting(conn, SERVICE) as s:
            service = queue(s, sc.bob.channel, {"duration": 300})
    assert not browser.ok and browser.sqlstate == "42501", browser
    # The database is the guarantee, not the route: the service key is refused too.
    assert not service.ok and service.sqlstate == "42501", service


def test_the_operators_own_org_still_runs_unpaid_and_unfrozen(conn, sc):
    with world(conn, sc, target=600, channel="default"):
        with acting(conn, sc.operator) as s:
            out = queue(s, "default")
    assert out.ok, f"control: the operator cannot queue their own channel: {out!r}"
    # Exempt runs keep following the channel's own target, as before 0041.
    assert duration_of(out) is None


def test_a_paid_customer_run_is_queued(conn, sc):
    with world(conn, sc, target=300) as su:
        ref = hold(su, sc.bob.org)
        with acting(conn, sc.bob.actor) as s:
            out = queue(s, sc.bob.channel, {"duration": 300}, credit_ref=ref)
    assert out.ok, f"control: Bob cannot queue a paid run: {out!r}"


# ── (a) only the API's own functions attach an API hold ─────────────────────

def test_browser_cannot_attach_an_api_hold(conn, sc):
    with world(conn, sc, target=300) as su:
        api_ref = su.value("select ref from public.api_holds where org_id = %s and status = 'open' limit 1", [sc.bob.org])
        assert api_ref, "the scenario seeded no open API hold for org B"
        with acting(conn, sc.bob.actor) as s:
            out = queue(s, sc.bob.channel, {"duration": 300}, api_hold_ref=api_ref)
    assert not out.ok and out.sqlstate == "42501", out


# ── (b) the credit hold is an open, unused queue hold of this org ───────────

def _prepare(su, sc, case):
    bob, alice = sc.bob.org, sc.alice.org
    if case == "another org's open hold":
        free_a_slot(su, "job-a")
        return hold(su, alice)
    if case == "a released hold":
        ref = hold(su, bob)
        su.value("select public.release_credits(%s)", [ref])
        return ref
    if case == "a started hold (paying for a running job)":
        ref = hold(su, bob)
        su.value("select public.start_credit_reservation(%s, %s)", [ref, bob])
        return ref
    if case == "an expired hold":
        ref = hold(su, bob)
        su.rows("update public.credit_reservations set created_at = now() - interval '4 hours' "
                "where job_id = %s returning 1", [ref])
        return ref
    if case == "the Actions dispatch's own hold":
        return hold(su, bob, prefix="gh-")
    if case == "a hold that does not exist":
        return f"rj-{uuid.uuid4()}"
    if case == "a hold already paying for a queued job":
        return "rj-seed-b"
    raise AssertionError(case)


@pytest.mark.parametrize("case", [
    "another org's open hold",
    "a released hold",
    "a started hold (paying for a running job)",
    "an expired hold",
    "the Actions dispatch's own hold",
    "a hold that does not exist",
    "a hold already paying for a queued job",
])
def test_browser_cannot_pay_with_a_hold_that_is_not_its_own_open_queue_hold(conn, sc, case):
    with world(conn, sc, target=300) as su:
        ref = _prepare(su, sc, case)
        with acting(conn, sc.bob.actor) as s:
            out = queue(s, sc.bob.channel, {"duration": 300}, credit_ref=ref)
    assert not out.ok, f"{case}: {out!r}"


# ── C1: the length the hold priced is the length that runs ──────────────────

def test_the_channels_target_is_frozen_into_the_job_at_insert(conn, sc):
    with world(conn, sc, target=300) as su:
        ref = hold(su, sc.bob.org, 60)
        with acting(conn, sc.bob.actor) as s:
            out = queue(s, sc.bob.channel, credit_ref=ref)
            # Raising the target afterwards changes nothing the job runs.
            s.rows("update public.channels set agent_config = agent_config || '{\"target_duration_seconds\": 3600}' "
                   "where channel_id = %s returning 1", [sc.bob.channel])
            s.conn.execute("reset role")
            stored = s.value("select params from public.render_jobs where credit_ref = %s", [ref])
    assert duration_of(out) == 300
    assert stored == {"duration": 300}


def test_a_job_longer_than_its_hold_is_refused(conn, sc):
    with world(conn, sc, target=300) as su:
        ref = hold(su, sc.bob.org, 60)  # 5 minutes at 12 credits/minute
        with acting(conn, sc.bob.actor) as s:
            out = queue(s, sc.bob.channel, {"duration": 3600}, credit_ref=ref)
    assert not out.ok and out.sqlstate == "22023", out


def test_a_target_raised_between_hold_and_queue_is_refused(conn, sc):
    with world(conn, sc, target=300) as su:
        ref = hold(su, sc.bob.org, 60)  # priced at the 300 s target
        su.rows("update public.channels set agent_config = agent_config || '{\"target_duration_seconds\": 3600}' "
                "where channel_id = %s returning 1", [sc.bob.channel])
        with acting(conn, sc.bob.actor) as s:
            out = queue(s, sc.bob.channel, credit_ref=ref)
    assert not out.ok and out.sqlstate == "22023", out


@pytest.mark.parametrize("target,frozen", [(7200, 3600), (10, 30), (299.6, 300)])
def test_the_frozen_length_is_capped_to_what_a_run_may_be(conn, sc, target, frozen):
    with world(conn, sc, target=target, grant=1000) as su:
        ref = hold(su, sc.bob.org, 720)  # covers the 3600 s maximum
        with acting(conn, sc.bob.actor) as s:
            out = queue(s, sc.bob.channel, credit_ref=ref)
    assert duration_of(out) == frozen


def test_a_paid_run_with_no_length_at_all_is_refused(conn, sc):
    with world(conn, sc, target=None) as su:
        ref = hold(su, sc.bob.org, 60)
        with acting(conn, sc.bob.actor) as s:
            out = queue(s, sc.bob.channel, credit_ref=ref)
    assert not out.ok and out.sqlstate == "22023", out


def test_a_queued_jobs_terms_cannot_be_changed_afterwards(conn, sc):
    with acting(conn, SERVICE) as s:
        for patch in ({"params": json.dumps({"duration": 3600})}, {"credit_ref": None}, {"channel_id": sc.alice.channel}):
            col, val = next(iter(patch.items()))
            out = s.run(f"update public.render_jobs set {col} = %s where id = %s", [val, sc.bob.render_job])
            assert not out.ok and out.sqlstate == "42501", (col, out)
        # The worker's own writes still go through.
        ok = s.run("update public.render_jobs set heartbeat_at = now() where id = %s", [sc.bob.render_job])
    assert ok.ok and ok.rowcount == 1, ok


def test_an_outsider_learns_nothing_about_a_tenants_holds(conn, sc):
    # The payment checks run before RLS; a caller who may not run the channel
    # gets the policy's refusal whatever the hold is.
    with world(conn, sc, target=300) as su:
        free_a_slot(su, "job-a")
        good = hold(su, sc.alice.org)
        with acting(conn, sc.bob.actor) as s:
            outs = [queue(s, sc.alice.channel, {"duration": 300}, credit_ref=r)
                    for r in (good, "rj-seed-a", f"rj-{uuid.uuid4()}")]
            outs.append(queue(s, "no-such-channel", {"duration": 300}, credit_ref=good))
    assert {(o.ok, o.sqlstate) for o in outs} == {(False, "42501")}, outs
    assert len({o.error for o in outs}) == 1, outs


# ── the public API still creates paid jobs, with the length frozen ──────────

def test_api_create_video_still_works_and_freezes_the_length(conn, sc):
    with world(conn, sc, target=300, status="ACTIVE"):
        with acting(conn, ANON) as s:
            res = s.value("select public.api_create_video(%s, %s, '{}'::jsonb, null, null, null)",
                          [sc.bob.api_key_hash, sc.bob.channel])
            assert res["ok"] is True and res["status"] == 201, res
            s.conn.execute("reset role")
            params, api_ref = s.rows("select params, api_hold_ref from public.render_jobs where id = %s",
                                     [res["data"]["job_id"]])[0]
    assert api_ref and params == {"duration": 300}


# ── concurrency: two runs racing one balance cannot overspend ───────────────

def _dsn(conn) -> str:
    return psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)


@pytest.fixture(scope="module")
def carol(conn):
    """A third tenant with only her welcome credits (100) and one channel, on
    0034's Creator plan: two parallel runs, so the race below is decided by
    the balance, not by the run limit."""
    who = user("carol", "carol@c.test")
    with as_superuser(conn) as s:
        s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
               [who.uid, who.email])
    with acting(conn, who, commit=True) as s:
        org = str(s.value("select public.create_organization('Carol Films')"))
    channel = f"chan-c{uuid.uuid4().hex[:6]}"
    with acting(conn, SERVICE, commit=True) as s:
        s.rows("insert into public.channels (channel_id, name, niche, status, org_id, agent_config) "
               "values (%s, 'Channel C', 'tech', 'PAUSED', %s, '{\"target_duration_seconds\": 300}') returning 1",
               [channel, org])
    with acting(conn, SERVICE, commit=True) as s:
        s.value("select public.upsert_subscription(%s, 'sub_01seclab0000000000000000cc', "
                "'ctm_01seclab0000000000000000cc', 'creator', null, 'active', now() - interval '1 day', "
                "now() + interval '29 days', false, null, now())", [org])
    with as_superuser(conn, commit=False) as s:
        assert s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org]) == 100
        assert s.value("select public.entitlement_int_internal(%s, 'concurrency')", [org]) == 2
    return who, org, channel


def _race(conn, n, body):
    """Run body(session, i) for i in range(n), each in its own connection and
    transaction as Carol, released together by a barrier."""
    barrier = threading.Barrier(n)
    results = [None] * n

    def worker(i):
        with psycopg.connect(_dsn(conn), autocommit=True) as c:
            try:
                results[i] = body(c, barrier, i)
            except Exception as e:  # noqa: BLE001 — a refusal is a result here
                results[i] = e

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    return results


def test_two_runs_racing_one_balance_cannot_overspend(conn, carol):
    who, org, channel = carol
    with as_superuser(conn) as s:  # start from no open hold, whatever ran before
        s.rows("select public.release_credits(job_id) from public.credit_reservations "
               "where org_id = %s and status = 'open'", [org])
        jobs_before = s.value("select count(*) from public.render_jobs where channel_id = %s", [channel])

    def run_now(c, barrier, i):
        # "Run now" twice at once: each takes a 60-credit hold and queues its
        # job. 100 credits cover one; the account lock makes the other wait
        # and then find the balance spoken for.
        barrier.wait()
        with acting(c, who, commit=True) as s:
            ref = f"rj-{uuid.uuid4()}"
            r = s.run("select public.reserve_credits(%s, %s, 60), pg_sleep(0.3)", [org, ref])
            if not r.ok:
                return r
            return queue(s, channel, {"duration": 300}, credit_ref=ref)

    outs = _race(conn, 2, run_now)
    assert sorted(o.ok for o in outs) == [False, True], outs
    assert [o.sqlstate for o in outs if not o.ok] == ["NS402"], outs
    with as_superuser(conn, commit=False) as s:
        balance, reserved = s.rows("select balance, reserved from public.credit_accounts where org_id = %s", [org])[0]
        jobs = s.value("select count(*) from public.render_jobs where channel_id = %s", [channel])
        holds = s.value("select count(*) from public.credit_reservations where org_id = %s and status = 'open'", [org])
    assert (balance, reserved, jobs - jobs_before, holds) == (100, 60, 1, 1)


def test_two_jobs_racing_for_one_hold_queue_once(conn, carol):
    who, org, channel = carol
    with as_superuser(conn) as s:
        s.rows("select public.release_credits(job_id) from public.credit_reservations "
               "where org_id = %s and status = 'open'", [org])
        ref = hold(s, org, 60)

    def queue_it(c, barrier, i):
        barrier.wait()
        with acting(c, who, commit=True) as s:
            return queue(s, channel, {"duration": 300}, credit_ref=ref)

    outs = _race(conn, 2, queue_it)
    assert sorted(o.ok for o in outs) == [False, True], outs
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.render_jobs where credit_ref = %s", [ref]) == 1


# ── with 0034's parallel-run limit: neither rule hides the other ────────────

def _superuser_again(s) -> None:
    """After a nested `acting(..., commit=True)` block the role and claims it
    set stay for the rest of the outer transaction; drop them."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")


def test_a_plan_with_n_slots_holds_n_runs_and_refuses_the_next(conn, carol):
    who, org, channel = carol
    with as_superuser(conn, commit=False) as su:
        su.rows("select public.release_credits(job_id) from public.credit_reservations "
                "where org_id = %s and status = 'open'", [org])
        su.value("select public.grant_credits(%s, 1000, 'test')", [org])
        slots = su.value("select public.entitlement_int_internal(%s, 'concurrency')", [org])
        with acting(conn, who, commit=True) as s:
            queued = []
            for _ in range(slots):
                ref = s.value("select public.reserve_credits(%s, 'rj-' || gen_random_uuid()::text, 60) ->> 'job_id'", [org])
                queued.append(queue(s, channel, {"duration": 300}, credit_ref=ref))
            one_more = s.run("select public.reserve_credits(%s, 'rj-' || gen_random_uuid()::text, 60)", [org])
            # 0034 counts holds, 0041 checks jobs: a job with no hold while the
            # slots are full is still refused by the payment guard, for that reason.
            no_hold = queue(s, channel, {"duration": 300})
            unknown_hold = queue(s, channel, {"duration": 300}, credit_ref=f"rj-{uuid.uuid4()}")
        _superuser_again(su)
        open_holds = su.value("select count(*) from public.credit_reservations where org_id = %s and status = 'open'", [org])
    assert slots == 2 and all(q.ok for q in queued), queued
    assert not one_more.ok and one_more.sqlstate == "NS429", one_more
    assert "parallel run limit" in one_more.error
    assert not no_hold.ok and no_hold.sqlstate == "42501" and "credit hold" in no_hold.error, no_hold
    assert not unknown_hold.ok and unknown_hold.sqlstate == "42501" and "not an open, unused hold" in unknown_hold.error
    assert open_holds == slots


def test_a_freed_slot_takes_a_hold_again_and_the_length_check_still_applies(conn, carol, sc):
    who, org, channel = carol
    with world(conn, sc, target=300, channel=channel) as su:
        su.rows("select public.release_credits(job_id) from public.credit_reservations "
                "where org_id = %s and status = 'open'", [org])
        su.value("select public.grant_credits(%s, 1000, 'test')", [org])  # the balance is not what refuses
        refs = [hold(su, org, 30), hold(su, org, 30)]
        with acting(conn, who) as s:
            full = s.run("select public.reserve_credits(%s, 'rj-' || gen_random_uuid()::text, 60)", [org])
        su.value("select public.release_credits(%s)", [refs[0]])
        with acting(conn, who) as s:
            ref = s.value("select public.reserve_credits(%s, 'rj-' || gen_random_uuid()::text, 60) ->> 'job_id'", [org])
            too_long = queue(s, channel, {"duration": 3600}, credit_ref=ref)
            fits = queue(s, channel, {"duration": 300}, credit_ref=ref)
    assert not full.ok and full.sqlstate == "NS429", full
    # The slot is back, so what refuses the long run is 0041's length check.
    assert not too_long.ok and too_long.sqlstate == "22023", too_long
    assert fits.ok, fits
