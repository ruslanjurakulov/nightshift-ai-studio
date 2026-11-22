"""Film Studio P3 (migration 0198), attacked in a real database: the switch per organization, the take's creative job, and the
worker's paths through 0171's state machine.

What would break without each guard (each test names the guard it pins):

  * the switch: an organization nobody switched on can neither start a film nor have a segment claimed, even with the platform's
    switch on; the quote says so before Start; only a platform owner/admin (owner_guard) or the SQL editor flips it, and every change
    writes a security_events row;
  * the lease: two workers claiming at once never get the same segment;
  * the money: a segment settled twice captures once (one capture in the ledger, never above the hold); a segment nobody claims, and
    one past its deadline and grace, is settled by the sweep and its hold released or captured while it is still open;
  * the take's job: written only by film_take_job, for the worker holding the lease, payer 'film', quoted 0, no hold, already the
    worker's ('running'), so the creative queue never hands it to the credit-paid worker; one job a take, ever; the starter as
    requested_by; inputs decided by the database from the takes this segment completed, never by the caller;
  * the migration: a replay changes nothing, the drift guard refuses a body that is not its own, and the rollback puts the earlier
    bodies back, after which 0198 applies again.

Runs in its own scratch database (it commits), on the registry and models of test_sec_films_money.py.
"""

from __future__ import annotations

import json
import os
import threading
import uuid

import psycopg
import pytest

import sec_db
from test_sec_films_money import ASSEMBLY_RATE, JOB_MINIMUM, MODELS, SETTINGS, Db

MIGRATION = sec_db.MIGRATIONS / "0198_film_studio_org_switch.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0198_film_studio_org_switch.sql"


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_film_worker_{uuid.uuid4().hex[:8]}"
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
def no_live_segment(db):
    """The claim takes the oldest claimable segment across organizations: every live one is cancelled through the service's own cancel
    first, so a test only ever claims its own."""
    for (sid,) in db.su("select id from public.film_segments where status in ('queued', 'running', 'draining')"):
        db.svc("select public.film_cancel_segment(%s, 'cancelled')", [sid])
    yield


@pytest.fixture
def a(db):
    return db.new_org()  # switched on (Db.new_org does it through the SQL editor path when 0198 is applied)


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0]


def org_switch(db, org, on):
    return db.su("select public.set_org_film_studio_enabled(%s, %s)", [org, on])[0][0]


def take_job(db, take, worker="w-1"):
    return db.svc("select public.film_take_job(%s, %s)", [take, worker])


def job(db, job_id):
    return db.su("select payer, film_take_id, credit_ref, quoted_credits, status, worker_id, requested_by, capability, params "
                 "from public.creative_jobs where id = %s", [job_id])[0]


# ── the switch per organization ─────────────────────────────────────────────

def test_an_organization_that_is_off_cannot_start_even_with_the_platform_switch_on(db):
    o = db.new_org()
    org_switch(db, o.org, False)
    fid = db.film(o)
    q = db.quote(o.editor, fid)
    assert q["film_studio_enabled"] is False and {"reason": "film_studio_disabled"} in q["blocked_by"] and q["startable"] is False
    assert err(lambda: db.start(o.admin, fid, q["quote_id"])) == ("NS409", "film_studio_disabled")
    assert db.holds(o.org) == [] and db.film_row(fid)[0] == "draft" and db.rate_used(o.admin, "start") == 0
    org_switch(db, o.org, True)
    assert db.start(o.admin, fid, db.quote(o.editor, fid)["quote_id"])["ok"] is True


def test_a_new_organization_is_off_by_default(db):
    o = db.new_org()
    db.su("delete from public.org_film_settings where org_id = %s", [o.org])  # as an organization with no row at all
    assert db.su("select public.film_studio_on_for(%s)", [o.org])[0][0] is False
    assert db.su("select column_default from information_schema.columns where table_name = 'org_film_settings' "
                 "and column_name = 'film_studio_enabled'")[0][0] == "false"


def test_a_segment_of_an_organization_switched_off_is_never_claimed_and_the_sweep_releases_it(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    org_switch(db, a.org, False)
    assert db.claim() is None
    assert db.segment(seg["id"])[0] == "queued" and db.holds(a.org)[0][2] == "open"
    # Nobody claimed it within 3 hours: the sweep (unchanged 0171) settles it and the hold goes back.
    db.su("update public.film_segments set created_at = now() - interval '4 hours' where id = %s", [seg["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.segment(seg["id"])[:3] == ("released", 0, "worker_unavailable") and db.account(a.org)[1] == 0
    org_switch(db, a.org, True)


def test_the_platform_switch_off_stops_the_claim_too(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    try:
        db.su("select public.set_film_studio_enabled(false)")
        assert db.claim() is None and db.segment(seg["id"])[0] == "queued"
    finally:
        db.su("select public.set_film_studio_enabled(true)")
    assert db.claim()["id"] == seg["id"]


def test_the_setter_refuses_everyone_but_a_platform_owner_and_writes_security_events(db, a):
    before = db.su("select count(*) from public.security_events where kind = 'film_studio.org_enabled'")[0][0]
    for who in (a.owner, a.admin, a.editor):
        assert err(lambda: db.one("authenticated", who, "select public.set_org_film_studio_enabled(%s::uuid, false)", [a.org])) == \
            ("42501", "only a platform owner or admin may do this")
    for role in ("anon", "service_role"):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, None, "select public.set_org_film_studio_enabled(%s::uuid, false)", [a.org])
        assert e.value.sqlstate == "42501" and "permission denied" in str(e.value)
    assert db.su("select public.film_studio_on_for(%s)", [a.org])[0][0] is True
    assert db.su("select count(*) from public.security_events where kind = 'film_studio.org_enabled'")[0][0] == before
    assert org_switch(db, a.org, False) == {"ok": True, "org_id": a.org, "enabled": False, "changed": True}
    assert org_switch(db, a.org, False)["changed"] is False  # no change, no event
    org_switch(db, a.org, True)
    ev = db.su("select target, detail ->> 'from', detail ->> 'to', detail ->> 'via' from public.security_events "
               "where kind = 'film_studio.org_enabled' order by id")
    assert ev[-2:] == [(a.org, "true", "false", "sql_editor"), (a.org, "false", "true", "sql_editor")], ev
    assert err(lambda: org_switch(db, str(uuid.uuid4()), True))[0] == "P0002"


def test_film_studio_on_for_is_the_shape_its_callers_use(db):
    """The assembly session calls it through PostgREST with the service key: frozen name, (p_org uuid) -> boolean, STABLE."""
    row = db.su("select pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.provolatile from pg_proc p "
                "where p.oid = 'public.film_studio_on_for(uuid)'::regprocedure")[0]
    assert row == ("p_org uuid", "boolean", "s")
    grants = db.su("select has_function_privilege(r, 'public.film_studio_on_for(uuid)', 'execute') from unnest(array['service_role', "
                   "'authenticated', 'anon']) r")
    assert [g[0] for g in grants] == [True, False, False]


def test_a_member_reads_the_switch_but_nobody_writes_the_row_directly(db, a):
    assert db.one("authenticated", a.viewer, "select film_studio_enabled from public.org_film_settings where org_id = %s", [a.org]) is True
    for role, user in (("authenticated", a.owner), ("service_role", None)):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, user, "update public.org_film_settings set film_studio_enabled = true where org_id = %s", [a.org])
        assert e.value.sqlstate == "42501"


# ── the shortest film ───────────────────────────────────────────────────────

def test_a_fifteen_second_film_of_two_scenes_is_quoted_and_started(db, a):
    """0198: a 15-30 s advert is a film (target 10-1200 s). It is priced like any film, never refused on its length."""
    fid = db.film(a, settings={**SETTINGS, "target_seconds": 15},
                  scenes=[{"title": "Hook", "narration": "Look.", "visual_prompt": "a red shoe in rain", "planned_seconds": 8},
                          {"title": "Brand", "narration": "Now.", "planned_seconds": 7, "first_frame": "previous"}])
    q = db.quote(a.admin, fid)
    assert q["priced"] is True and q["refusals"] == [] and q["startable"] is True, (q["blocked_by"], q["refusals"])
    assert q["planned_seconds"] == 15 and q["assembly_minutes"] == 1
    assert db.start(a.admin, fid, q["quote_id"])["ok"] is True


def test_below_ten_seconds_is_refused_by_the_save_and_by_the_table(db, a):
    assert err(lambda: db.film(a, settings={**SETTINGS, "target_seconds": 9}))[1] == "invalid_params"
    fid = db.film(a)
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.films set target_seconds = 9 where id = %s", [fid])
    assert e.value.sqlstate == "23514" and "films_format_check" in str(e.value)
    assert db.su("select public.film_limits() ->> 'target_seconds_min'")[0][0] == "10"


# ── the lease and the money ─────────────────────────────────────────────────

def test_two_concurrent_claims_never_get_the_same_segment(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    got, gate, lock = [], threading.Barrier(4), threading.Lock()

    def go(w):
        gate.wait()
        out = db.claim(w)
        with lock:
            got.append(out["id"] if out else None)

    threads = [threading.Thread(target=go, args=(f"w-{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(got, key=str) == sorted([seg["id"], None, None, None], key=str), got
    assert db.segment(seg["id"])[5] == 1  # one lease taken, not four


def test_a_segment_settled_twice_captures_once(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.make(a, kf, "keyframe")
    first = db.settle(seg["id"], "takes_failed")
    again = db.settle(seg["id"], "takes_failed")
    assert first["settled"] is True and again["status"] == first["status"] == "settled"
    assert len(db.ledger(a.org, "capture")) == 1
    assert [h[2] for h in db.holds(a.org)] == ["captured"] and db.holds(a.org)[0][3] == 3
    assert db.film_row(fid) == ("paused", "takes_failed")


def test_a_lost_worker_past_the_deadline_and_grace_is_settled_by_the_sweep_with_its_hold_open(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf)  # the worker died here: the take is running, nobody beats
    db.su("update public.film_segments set deadline_at = now() - interval '2 hours 1 minute' where id = %s", [seg["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.segment(seg["id"])[:3] == ("released", 0, "deadline") and db.account(a.org)[1] == 0
    assert db.su("select charge_basis from public.film_takes where id = %s", [kf])[0][0] == "worker_lost_not_charged"


# ── the take's creative job ─────────────────────────────────────────────────

def test_the_take_job_is_the_workers_paid_by_the_film_and_holds_nothing(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf)
    out = take_job(db, kf)
    assert out["ok"] is True and out["replayed"] is False and out["capability"] == "t2i"
    payer, take_id, ref, quoted, status, worker, by, cap, params = job(db, out["job_id"])
    assert (payer, take_id, ref, float(quoted), status, worker, cap) == ("film", kf, None, 0.0, "running", "w-1", "t2i")
    assert by == db.su("select created_by from public.film_segments where id = %s", [seg["id"]])[0][0] == uuid.UUID(a.admin)
    assert params["prompt"] == "a lighthouse at dusk"
    # One job a take, ever: the same call answers the same job.
    again = take_job(db, kf)
    assert again["replayed"] is True and again["job_id"] == out["job_id"]
    assert db.su("select count(*) from public.creative_jobs where film_take_id = %s", [kf])[0][0] == 1
    assert db.su("select creative_job_id from public.film_takes where id = %s", [kf])[0][0] == uuid.UUID(out["job_id"])
    # The creative queue never hands it to the credit-paid worker while it is fresh.
    assert db.svc("select count(*) from public.claim_creative_job('creative-1')") == 0
    assert db.su("select status, worker_id from public.creative_jobs where id = %s", [out["job_id"]])[0] == ("running", "w-1")


def test_only_the_lease_holder_gets_a_take_job_and_never_for_a_take_that_has_not_begun(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf, clip = db.takes(seg["id"])[0][0], db.takes(seg["id"])[1][0]
    assert err(lambda: take_job(db, kf)) == ("NS409", "take_not_running")
    db.begin(kf)
    assert err(lambda: take_job(db, kf, "w-other")) == ("NS409", "lease_lost")
    for role, user in (("authenticated", a.owner), ("anon", None)):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, user, "select public.film_take_job(%s::uuid, 'w-1')", [kf])
        assert e.value.sqlstate == "42501"
    assert db.su("select count(*) from public.creative_jobs where film_take_id in (%s, %s)", [kf, clip])[0][0] == 0


def test_a_clip_starts_from_the_key_frame_its_segment_made_and_records_it(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    takes = db.takes(seg["id"])
    kf, clip, clip2 = takes[0][0], takes[1][0], takes[2][0]
    db.begin(clip)
    missing = take_job(db, clip)
    assert missing["ok"] is False and missing["reason"] == "input_missing"  # the key frame is not made yet
    db.svc("select public.film_take_failed(%s, 'w-1', 'provider_error', 'bad_request', 'input missing')", [clip])
    db.make(a, kf, "keyframe")
    result = db.su("select result_asset_id from public.film_takes where id = %s", [kf])[0][0]
    retry = db.su("select id from public.film_takes where segment_id = %s and kind = 'clip' and attempt = 2", [seg["id"]])[0][0]
    db.begin(retry)
    out = take_job(db, retry)
    assert out["ok"] is True and out["capability"] == "i2v" and out["params"]["source_asset_id"] == str(result)
    assert "end_frame" not in out["params"] and out["inputs"][0]["role"] == "first"
    assert db.su("select first_frame_asset_id from public.film_takes where id = %s", [retry])[0][0] == result
    # The second scene continues from the first scene's last frame: nothing until that shot made one.
    db.begin(clip2)
    assert take_job(db, clip2)["reason"] == "input_missing"


def test_a_worker_that_takes_over_the_lease_takes_over_the_live_job(db, a):
    """0036's calls check the job's worker id: without this, a worker that resumed a dead one's take could neither store nor
    finish it, and the take would end as worker_lost after three leases."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim("w-1")
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf, "w-1")
    first = take_job(db, kf, "w-1")
    assert db.svc("select public.advance_creative_job(%s, 'w-1', 'submitting')", [first["job_id"]]) is True
    assert db.svc("select public.advance_creative_job(%s, 'w-1', 'submitted', 'lab-task-7')", [first["job_id"]]) is True
    db.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s", [seg["id"]])
    assert db.claim("w-2")["id"] == seg["id"]
    again = take_job(db, kf, "w-2")
    assert (again["replayed"], again["job_id"], again["job_worker"], again["provider_task_id"]) == (True, first["job_id"], "w-2",
                                                                                                    "lab-task-7")
    assert db.svc("select public.advance_creative_job(%s, 'w-2', 'processing')", [first["job_id"]]) is True
    assert db.svc("select public.advance_creative_job(%s, 'w-1', 'requeue')", [first["job_id"]]) is False  # the old worker is out


def test_a_take_job_never_follows_an_input_the_caller_names(db, a):
    """film_take_job takes no asset id at all: the database decides the inputs from the storyboard and the completed takes."""
    args = db.su("select pg_get_function_arguments('public.film_take_job(uuid, text)'::regprocedure)")[0][0]
    assert args == "p_take uuid, p_worker text"


# ── the migration ───────────────────────────────────────────────────────────

def test_a_replay_changes_nothing_and_the_guard_refuses_a_body_that_is_not_its_own(db):
    bodies = ("select md5(string_agg(md5(prosrc), '' order by oid)) from pg_proc "
              "where proname in ('start_film', 'quote_film', 'film_claim_segment', 'film_take_job', 'film_studio_on_for')")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        # 0215 replaces 0198's start_film and film_claim_segment (0198's guard refuses its bodies): compared on 0198 alone, inside
        # one transaction.
        sec_db.take_off_0215(c)
        before = c.execute(bodies).fetchone()
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute(bodies).fetchone() == before
        c.rollback()
    assert db.su("select public.film_studio_on()")[0][0] is True  # the lab turned it on; a replay never writes the switch
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0215(c)
        c.execute("create or replace function public.film_studio_on_for(p_org uuid) returns boolean "
                  "language sql stable security definer set search_path = public, pg_temp as $$ select true $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "film_studio_on_for(uuid) with a body that is not this file's" in str(e.value)
        c.rollback()


def test_the_rollback_puts_the_earlier_bodies_back_and_0198_applies_again(db, a):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        short = c.execute("select count(*) from public.films where target_seconds < 60").fetchone()[0]
        if short:
            # 0166's check would refuse them: the rollback says so and changes nothing.
            with pytest.raises(psycopg.Error) as e:
                sec_db.take_off_0198(c)
            assert "target less than 60 s" in str(e.value)
            c.rollback()
            c.execute("update public.films set target_seconds = 60 where target_seconds < 60")
        sec_db.take_off_0198(c)
        assert c.execute("select to_regprocedure('public.film_take_job(uuid, text)')").fetchone()[0] is None
        assert c.execute("select public.film_limits() ->> 'target_seconds_min'").fetchone()[0] == "60"
        assert c.execute("select count(*) from information_schema.columns where table_name = 'org_film_settings' "
                         "and column_name = 'film_studio_enabled'").fetchone()[0] == 1  # the record is kept
        assert "film_studio_on()" in c.execute("select prosrc from pg_proc where oid = 'public.start_film(uuid,text,text)'::regprocedure").fetchone()[0]
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute("select public.film_studio_on_for(%s)", [a.org]).fetchone()[0] is True
        c.rollback()


# ── Sentinel's pins on #853 (the credit queue, the lease's jobs, ending a take, "off", cancel, notify, the voice) ──

LIVE_JOB = ("queued", "running", "provider_pending", "processing", "rendering")


def submitted_job(db, a, worker="w-1", task="lab-task-7"):
    """A started film whose key frame's job is at the vendor (a task id stored) under ``worker``'s lease."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim(worker)
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf, worker)
    j = take_job(db, kf, worker)["job_id"]
    assert db.svc("select public.advance_creative_job(%s, %s, 'submitting')", [j, worker]) is True
    assert db.svc("select public.advance_creative_job(%s, %s, 'submitted', %s)", [j, worker, task]) is True
    return fid, seg, kf, j


def live(db, take):
    return db.su("select count(*) from public.creative_jobs where film_take_id = %s and status = any(%s)", [take, list(LIVE_JOB)])[0][0]


def test_a_a_deploy_never_lets_the_credit_queue_end_a_paid_film_task(db, a):
    """Lens's reaper probe, pinned. The film worker stops (a deploy): the segment's lease and the job's heartbeat lapse together.
    The credit worker's routine claim runs first; it must leave the film job alone, so the film's next claim polls the SAME task id
    and no attempt 2 (a second paid vendor call) is ever planned."""
    _fid, seg, kf, j = submitted_job(db, a)
    db.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s", [seg["id"]])
    db.su("update public.creative_jobs set heartbeat_at = now() - interval '11 minutes' where id = %s", [j])
    db.svc("select count(*) from public.claim_creative_job('creative-1')")
    assert db.su("select status, worker_id, provider_task_id from public.creative_jobs where id = %s", [j])[0] == \
        ("provider_pending", "w-1", "lab-task-7")
    assert db.claim("w-2")["id"] == seg["id"]
    again = take_job(db, kf, "w-2")
    assert (again["job_status"], again["job_worker"], again["provider_task_id"]) == ("provider_pending", "w-2", "lab-task-7")
    assert db.su("select count(*) from public.film_takes where segment_id = %s and attempt = 2", [seg["id"]])[0][0] == 0
    assert db.su("select count(*) from public.notifications where ref = %s", [str(j)])[0][0] == 0


def test_a_a_job_requeued_and_taken_back_is_never_swept_by_the_credit_queue(db, a):
    """A requeue resets 0036's attempts to 0; the takeback does not restore them. The credit sweep must not touch the job at all."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim("w-1")
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf, "w-1")
    j = take_job(db, kf, "w-1")["job_id"]
    assert db.svc("select public.advance_creative_job(%s, 'w-1', 'requeue')", [j]) is True
    assert take_job(db, kf, "w-1")["job_status"] == "running"
    db.su("update public.creative_jobs set heartbeat_at = now() - interval '11 minutes' where id = %s", [j])
    db.svc("select count(*) from public.claim_creative_job('creative-1')")
    assert db.su("select status, worker_id from public.creative_jobs where id = %s", [j])[0] == ("running", "w-1")


def test_b_after_the_reclaim_the_old_worker_cannot_attach_files_to_the_job(db, a):
    _fid, seg, kf, j = submitted_job(db, a)
    assert db.svc("select public.advance_creative_job(%s, 'w-1', 'processing')", [j]) is True
    res = db.asset(a.org, "image", "image/png", provenance={"job_id": str(j), "film_take_id": str(kf)})
    db.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s", [seg["id"]])
    assert db.claim("w-2")["id"] == seg["id"]
    assert db.su("select worker_id from public.creative_jobs where id = %s", [j])[0][0] == "w-2"  # moved at the claim
    assert db.svc("select public.attach_creative_job_assets(%s, 'w-1', array[%s::uuid])", [j, res]) is False
    assert db.svc("select public.attach_creative_job_assets(%s, 'w-2', array[%s::uuid])", [j, res]) is True


def test_c_a_clip_rejected_as_too_short_ends_its_job(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    takes = db.takes(seg["id"])
    kf, clip = takes[0][0], takes[1][0]
    db.make(a, kf, "keyframe")
    db.begin(clip)
    j = take_job(db, clip)["job_id"]
    short = db.asset(a.org, "video", "video/mp4", duration=2, provenance={"job_id": str(j), "film_take_id": str(clip)})
    out = db.succeed(clip, 2, short)
    assert out["accepted"] is False and out.get("retry_take_id")
    assert db.su("select status, error_code from public.creative_jobs where id = %s", [j])[0] == ("failed", "output_too_short")
    assert db.su("select count(*) from public.notifications where ref = %s", [str(j)])[0][0] == 0


def test_c_a_settled_segment_leaves_no_live_take_job(db, a):
    """A completed take whose job was never finished (the worker's finish call lost) is ended by the settle."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf)
    j = take_job(db, kf)["job_id"]
    db.succeed(kf, None, db.output(a.org, kf, "image", "image/png"))
    assert live(db, kf) == 1
    assert db.settle(seg["id"], "takes_failed")["settled"] is True
    assert live(db, kf) == 0
    assert db.su("select error_code from public.creative_jobs where id = %s", [j])[0][0] == "segment_settled"


def test_c_and_l2_a_failed_and_retried_take_ends_its_job_and_notifies_nobody(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf)
    j = take_job(db, kf)["job_id"]
    out = db.fail(kf, "provider_error", code="provider_error")
    assert out.get("retry_take_id")
    assert db.su("select status from public.creative_jobs where id = %s", [j])[0][0] == "failed"
    assert db.svc("select public.advance_creative_job(%s, 'w-1', 'submitting')", [j]) is False
    assert db.su("select count(*) from public.notifications where ref = %s", [str(j)])[0][0] == 0


def test_d_l9_switched_off_a_task_at_the_vendor_is_still_polled_and_nothing_new_begins(db, a):
    _fid, seg, kf, j = submitted_job(db, a)
    clip = db.takes(seg["id"])[1][0]
    try:
        db.su("select public.set_org_film_studio_enabled(%s, false)", [a.org])
        db.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s", [seg["id"]])
        assert db.claim("w-2")["id"] == seg["id"]  # a running segment is re-claimed, off or not
        again = take_job(db, kf, "w-2")
        assert (again["ok"], again["provider_task_id"], again["job_worker"]) == (True, "lab-task-7", "w-2")
        assert err(lambda: db.begin(clip, "w-2")) == ("NS409", "film_studio_disabled")
        assert db.su("select status from public.film_takes where id = %s", [clip])[0][0] == "planned"
    finally:
        db.su("select public.set_org_film_studio_enabled(%s, true)", [a.org])


def test_d_a_queued_segment_of_an_org_switched_off_is_still_not_claimed(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    try:
        db.su("select public.set_org_film_studio_enabled(%s, false)", [a.org])
        assert db.claim() is None and db.segment(seg["id"])[0] == "queued"
    finally:
        db.su("select public.set_org_film_studio_enabled(%s, true)", [a.org])


@pytest.mark.parametrize("who", ["viewer", "editor", "admin", "owner"])
def test_n1_a_member_cannot_cancel_a_film_take_job(db, a, who):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf)
    j = take_job(db, kf)["job_id"]
    user = getattr(a, who)
    assert err(lambda: db.one("authenticated", user, "select public.cancel_creative_job(%s::uuid)", [j])) == ("P0002", "not_found")
    assert db.su("select status, worker_id from public.creative_jobs where id = %s", [j])[0] == ("running", "w-1")
    assert db.svc("select public.advance_creative_job(%s, 'w-1', 'submitting')", [j]) is True


def test_l6_a_narration_in_a_voice_still_testing_is_refused_and_writes_no_job(db, a):
    voice = "VoiceLabTesting00001"
    db.su("insert into public.user_voice_refs (user_id) values (%s) on conflict (user_id) do nothing", [a.admin])
    ref = db.su("select owner_ref from public.user_voice_refs where user_id = %s", [a.admin])[0][0]
    db.su("insert into public.voice_profiles (user_id, org_id, owner_ref, name, status, provider, provider_voice_id) "
          "values (%s, %s, %s, 'Lab voice', 'testing', 'elevenlabs', %s)", [a.admin, a.org, ref, voice])
    from test_sec_films_money import SETTINGS
    fid = db.film(a, settings={**SETTINGS, "voice": {"source": "creative_tts", "model": "tts-a", "voice_id": voice}})
    seg = db.quoted_start(a, fid)
    db.claim()
    narr = [t[0] for t in db.takes(seg["id"]) if t[1] == "narration"][0]
    db.begin(narr)
    out = take_job(db, narr)
    assert (out["ok"], out["reason"]) == (False, "voice_not_found")
    assert db.su("select count(*) from public.creative_jobs where film_take_id = %s", [narr])[0][0] == 0
