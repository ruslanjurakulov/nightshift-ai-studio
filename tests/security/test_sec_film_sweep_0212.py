"""Migration 0212 (the recorded film sweep, switch-on gate G2) attacked in a real database.

What would break without each guard (each test names the guard it pins):

  * the doors: anon or a signed-in member calling film_sweep (a browser that settles films) or film_sweep_status, or reading or
    writing film_sweep_runs (a forged "it ran"); the service role writes the record only through film_sweep;
  * the record: a sweep that is not recorded under its own runner, or a failed sweep recorded as done, or recorded with a message
    body instead of its SQLSTATE;
  * the measurement: "overdue" read as fine when nothing ever swept (it is null: unknown), or false while a segment is open and no
    runner swept for more than the overdue line (30 minutes, returned as overdue_after_minutes), or false while a segment past its
    settle point outlives the line (stuck_segments, oldest_stuck_minutes: counts, never ids);
  * the money: film_sweep is film_expire_segments, recorded: a segment past its deadline and grace settles while its hold is open,
    once, even with two sweeps at the same moment;
  * the callers: FilmRest.sweep, tools/film_sweep.py and the worker's sweep_once reach the REAL signature through the PostgREST
    stand-in of test_sec_film_e2e_lab.py (a body key the function does not have is a 404 there, never dropped);
  * the migration: the pg_cron job is created once (unscheduled first) where pg_cron exists, calls film_sweep('pg_cron') and FAILS on
    ok:false (pg_cron would otherwise mark a failed sweep succeeded); a schedule that did not land fails the file; a
    film_sweep_runs of another shape is refused; a rollback whose unschedule fails changes nothing; a replay
    changes nothing and keeps the record; the drift guard and the rollback refuse a body that is not 0212's; the rollback takes
    everything of 0212 out and leaves 0171's sweep, after which 0212 applies again.

Runs in its own scratch database (it commits), on the registry and models of test_sec_films_money.py.
"""

from __future__ import annotations

import json
import logging
import threading
from decimal import Decimal

import psycopg
import pytest

import sec_db
from test_sec_film_e2e_lab import KEY, URL, FakePostgrest
from test_sec_films_money import a, db, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are

from modules import film_orchestrator as fo
from tools import film_sweep as fs
from tools import film_worker as fw

MIGRATION = sec_db.MIGRATIONS / "0212_film_sweep.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0212_film_sweep.sql"
JOB = "nightshift-film-sweep"
RUNNERS = ("worker", "actions", "pg_cron")

# A stand-in for the pg_cron API, inside one rolled-back transaction (as test_sec_video_safety.py does for 0111).
CRON_STUB = """
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $f$
declare id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into id;
  return id;
end $f$;
create function cron.unschedule(job_name text) returns boolean language plpgsql as $f$
begin
  delete from cron.job where jobname = job_name;
  if not found then raise exception 'could not find valid entry for job ''%''', job_name; end if;
  return true;
end $f$;
"""


def body(path):
    """A file without its own begin/commit, for the caller's transaction."""
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate


def sweep(db, runner="actions"):
    return db.svc("select public.film_sweep(%s)", [runner])


def status(db):
    return db.svc("select public.film_sweep_status()")


def runs(db):
    return {r[0]: r[1:] for r in db.su("select runner, last_at, last_settled, last_error, last_error_at from public.film_sweep_runs")}


@pytest.fixture(autouse=True)
def no_runs(db):
    """Each test starts with no sweep ever recorded (the superuser's door; no API role can do this)."""
    db.su("delete from public.film_sweep_runs")
    yield


def past_deadline(db, o):
    """A started film whose worker made the key frame and was lost, its segment past the deadline plus the 2-hour grace."""
    fid = db.film(o)
    seg = db.quoted_start(o, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.make(o, kf, "keyframe")
    db.su("update public.film_segments set deadline_at = now() - interval '2 hours 1 minute' where id = %s", [seg["id"]])
    return fid, seg


# ── the doors ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_no_browser_role_sweeps_reads_the_status_or_touches_the_record(db, a, role):
    user = a.owner if role == "authenticated" else None
    for q in ("select public.film_sweep('actions')", "select public.film_sweep('worker')", "select public.film_sweep_status()",
              "select * from public.film_sweep_runs",
              "insert into public.film_sweep_runs (runner, last_at, last_settled) values ('actions', now(), 0)",
              "update public.film_sweep_runs set last_at = now()", "delete from public.film_sweep_runs"):
        assert err(lambda: db.act(role, user, q)) == "42501", (role, q)
    assert runs(db) == {}


def test_the_service_role_sweeps_and_reads_but_writes_the_record_only_through_film_sweep(db):
    out = sweep(db, "actions")
    assert out["ok"] is True and out["runner"] == "actions" and out["settled"] == 0 and out["at"]
    assert [r[0] for r in db.act("service_role", None, "select runner from public.film_sweep_runs")] == ["actions"]
    for q in ("insert into public.film_sweep_runs (runner, last_at, last_settled) values ('worker', now(), 0)",
              "update public.film_sweep_runs set last_at = now() + interval '1 day'", "delete from public.film_sweep_runs",
              "truncate public.film_sweep_runs"):
        assert err(lambda: db.act("service_role", None, q)) == "42501", q
    assert status(db)["runners"]["actions"] is not None


def test_an_unknown_runner_is_refused_and_records_nothing(db):
    for bad in ("", "browser", "Actions", None, "pg-cron"):
        assert err(lambda: sweep(db, bad)) == "22023", bad
    assert runs(db) == {}
    assert sweep(db, " actions ")["runner"] == "actions"  # trimmed, the way every text argument here is


# ── the record ──────────────────────────────────────────────────────────────

def test_each_runner_records_its_own_row_and_the_others_stay_unknown(db):
    sweep(db, "worker")
    st = status(db)
    assert st["runners"]["worker"]["last_at"] is not None and st["runners"]["worker"]["last_settled"] == 0
    assert st["runners"]["actions"] is None and st["runners"]["pg_cron"] is None  # never ran: null, never a zero or a date
    first = runs(db)["worker"][0]
    sweep(db, "worker")
    sweep(db, "pg_cron")
    r = runs(db)
    assert set(r) == {"worker", "pg_cron"} and r["worker"][0] > first  # one row per runner, moved forward
    assert status(db)["last_at"] is not None


def test_a_sweep_that_fails_is_recorded_by_its_sqlstate_only_and_answers_ok_false(db):
    sweep(db, "actions")
    done_at = runs(db)["actions"][0]
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("create or replace function public.film_expire_segments() returns integer language plpgsql security definer "
                  "set search_path = public, pg_temp as $$ begin raise exception 'segment of org acme-secret-detail' "
                  "using errcode = '55P03'; end $$")
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role"})])
        c.execute("set local role service_role")
        out = c.execute("select public.film_sweep('actions')").fetchone()[0]
        assert out["ok"] is False and out["error"] == "55P03" and "settled" not in out
        row = c.execute("select last_at, last_settled, last_error, last_error_at from public.film_sweep_runs "
                        "where runner = 'actions'").fetchone()
        assert row[0] == done_at and row[1] == 0  # the last completed sweep is still the last completed sweep
        assert row[2] == "55P03" and row[3] is not None
        assert "acme" not in json.dumps(out, default=str) and "acme" not in str(row)
        c.rollback()


# ── the measurement ─────────────────────────────────────────────────────────

def test_never_swept_is_unknown_not_fine_even_with_a_segment_open(db, a):
    st = status(db)
    assert st["overdue"] is None and st["last_at"] is None and st["runners"] == {r: None for r in RUNNERS}
    db.quoted_start(a, db.film(a))
    st = status(db)
    assert st["open_segments"] >= 1 and st["overdue"] is None


def test_overdue_when_a_segment_is_open_and_no_runner_swept_within_the_line(db, a):
    db.quoted_start(a, db.film(a))  # queued: open, and nobody claims it in this test
    sweep(db, "actions")
    sweep(db, "worker")
    st = status(db)
    assert st["overdue"] is False and st["overdue_after_minutes"] == 30
    db.su("update public.film_sweep_runs set last_at = now() - interval '31 minutes'")
    st = status(db)
    assert st["overdue"] is True and st["open_segments"] >= 1
    db.su("update public.film_sweep_runs set last_at = now() - interval '29 minutes' where runner = 'worker'")
    assert status(db)["overdue"] is False  # any one runner within the line is enough
    db.su("update public.film_sweep_runs set last_at = now() - interval '31 minutes'")
    sweep(db, "pg_cron")
    assert status(db)["overdue"] is False


def test_a_runner_that_only_ever_failed_is_overdue_while_a_segment_is_open(db, a):
    db.quoted_start(a, db.film(a))
    db.su("insert into public.film_sweep_runs (runner, last_error, last_error_at) values ('actions', '55P03', now())")
    st = status(db)
    assert st["last_at"] is None and st["overdue"] is True and st["runners"]["actions"]["last_error"] == "55P03"


def test_not_overdue_when_nothing_is_open(db):
    sweep(db, "actions")
    db.su("update public.film_sweep_runs set last_at = now() - interval '3 hours'")
    st = status(db)
    assert st["overdue"] is (st["open_segments"] > 0)


def test_stuck_counts_a_segment_past_each_settle_point_and_names_none(db, a):
    """0171's three settle points, from its own constants: queued past unclaimed_hours, past deadline + grace, a hold gone."""
    sweep(db, "actions")
    base = status(db)
    assert base["stuck_segments"] == 0 and base["oldest_stuck_minutes"] is None
    b, c = db.new_org(), db.new_org()  # one running film per organization (0171's limit)
    q = db.quoted_start(a, db.film(a))
    d = db.quoted_start(b, db.film(b))
    h = db.quoted_start(c, db.film(c))
    db.su("update public.film_segments set created_at = now() - interval '3 hours 10 minutes' where id = %s", [q["id"]])
    db.su("update public.film_segments set deadline_at = now() - interval '2 hours 5 minutes' where id = %s", [d["id"]])
    db.su("update public.credit_reservations set status = 'released', settled_at = now() - interval '40 minutes' "
          "where job_id = (select credit_ref from public.film_segments where id = %s)", [h["id"]])
    st = status(db)
    assert st["stuck_segments"] == 3 and 39 <= st["oldest_stuck_minutes"] <= 41, st
    assert st["overdue"] is True  # 40 minutes past a settle point is longer than the line, whatever last_at says
    text = json.dumps(st, default=str)
    assert not any(str(x["id"]) in text for x in (q, d, h)) and not any(o.org in text for o in (a, b, c))  # counts, never ids
    db.su("update public.credit_reservations set settled_at = now() - interval '5 minutes' "
          "where job_id = (select credit_ref from public.film_segments where id = %s)", [h["id"]])
    st = status(db)
    assert st["stuck_segments"] == 3 and st["oldest_stuck_minutes"] <= 10 and st["overdue"] is False  # stuck, not yet overdue
    # The hold back as it was, so the next test's cleanup cancels through 0171's own path.
    db.su("update public.credit_reservations set status = 'open', settled_at = null "
          "where job_id = (select credit_ref from public.film_segments where id = %s)", [h["id"]])


def test_a_segment_stuck_past_the_line_is_overdue_even_when_no_sweep_was_ever_recorded(db, a):
    s = db.quoted_start(a, db.film(a))
    assert status(db)["overdue"] is None  # open, nothing stuck, nothing recorded: unknown
    db.su("update public.film_segments set created_at = now() - interval '4 hours' where id = %s", [s["id"]])
    st = status(db)
    assert st["overdue"] is True and st["stuck_segments"] == 1 and st["oldest_stuck_minutes"] >= 59


# ── the money ───────────────────────────────────────────────────────────────

def test_a_segment_past_its_deadline_and_grace_is_settled_by_film_sweep_while_its_hold_is_open(db, a):
    fid, seg = past_deadline(db, a)
    before = db.account(a.org)[0]
    assert [h[2] for h in db.holds(a.org)] == ["open"]
    out = sweep(db, "pg_cron")
    assert out["ok"] is True and out["settled"] >= 1
    st, captured, reason, ref = db.segment(seg["id"])[:4]
    assert (st, captured, reason) == ("settled", Decimal(3), "deadline")  # the key frame it made, nothing else
    assert [h[2:] for h in db.holds(a.org) if h[0] == ref] == [("captured", Decimal(3))]
    assert db.account(a.org)[0] == before - 3
    assert db.film_row(fid) == ("paused", "deadline")
    assert runs(db)["pg_cron"][1] == out["settled"]
    assert sweep(db, "pg_cron")["settled"] == 0  # settled once


def test_two_sweeps_at_the_same_moment_settle_a_segment_once(db, a):
    _fid, seg = past_deadline(db, a)
    outs, barrier = [], threading.Barrier(2)

    def one(runner):
        barrier.wait()
        outs.append(sweep(db, runner))

    ts = [threading.Thread(target=one, args=(r,)) for r in ("worker", "actions")]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert all(o["ok"] is True for o in outs) and sum(o["settled"] for o in outs) == 1, outs
    assert len(db.ledger(a.org, "capture")) == 1
    assert db.segment(seg["id"])[0] == "settled" and set(runs(db)) == {"worker", "actions"}


# ── the callers, through the PostgREST stand-in ─────────────────────────────

def test_filmrest_the_cli_and_the_worker_reach_the_real_signature(db, a, monkeypatch, caplog):
    pg = FakePostgrest(db.dsn)
    rest = fo.FilmRest(URL, KEY, session=pg)
    _fid, seg = past_deadline(db, a)
    assert rest.sweep("worker") == 1
    assert db.segment(seg["id"])[0] == "settled"
    with caplog.at_level(logging.INFO):
        assert fs.main({"SUPABASE_URL": URL, "SUPABASE_SERVICE_KEY": KEY}, make_db=lambda u, k: rest) == 0
        fw._SWEEP_UNRECORDED.clear()
        fw.sweep_once(rest)
    assert not fw._SWEEP_UNRECORDED.is_set()  # 0212 is here: no unrecorded sweep
    assert set(runs(db)) == {"worker", "actions"}
    assert pg.unknown == [] and {c[1] for c in pg.calls} == {"film_sweep"}
    assert all(c[2] == ("p_runner",) for c in pg.calls)
    with pytest.raises(fo.FilmRefused) as e:  # 22023 through PostgREST is a 400 with its machine word
        rest.sweep("browser")
    assert e.value.word == "unknown_runner"
    assert KEY not in caplog.text


# ── the migration ───────────────────────────────────────────────────────────

SNAPSHOT = """
select jsonb_build_object(
  'functions', (select jsonb_agg(p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(array_to_string(p.proacl, ','), '')
                                 order by p.oid::regprocedure::text)
                  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'film\\_sweep%%'),
  'grants', (select jsonb_agg(grantee || ' ' || privilege_type order by grantee, privilege_type)
               from information_schema.role_table_grants where table_schema = 'public' and table_name = 'film_sweep_runs'),
  'constraints', (select jsonb_agg(conname || ' ' || pg_get_constraintdef(oid) order by conname) from pg_constraint
                   where conrelid = 'public.film_sweep_runs'::regclass),
  'rls', (select relrowsecurity from pg_class where oid = 'public.film_sweep_runs'::regclass),
  'expire', (select md5(prosrc) from pg_proc where oid = 'public.film_expire_segments()'::regprocedure),
  'rows', (select jsonb_agg(to_jsonb(f) order by runner) from public.film_sweep_runs f))
"""


def test_a_replay_changes_nothing_and_keeps_the_record(db):
    sweep(db, "actions")
    sweep(db, "worker")
    before = db.su(SNAPSHOT)[0][0]
    assert len(before["rows"]) == 2
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.commit()
    assert db.su(SNAPSHOT)[0][0] == before


def test_without_pg_cron_it_applies_and_says_so(db):
    assert db.su("select to_regclass('cron.job') is null")[0][0] is True
    notices = []
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.add_notice_handler(lambda d: notices.append(d.message_primary))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.rollback()
    assert any("0212: pg_cron is not enabled" in n and "film_sweep.yml" in n for n in notices), notices


def test_with_pg_cron_one_job_every_five_minutes_runs_film_sweep_as_pg_cron_and_the_rollback_removes_it(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(CRON_STUB)
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))  # unscheduled first: still one job
        jobs = c.execute("select jobname, schedule, command from cron.job").fetchall()
        assert jobs == [(JOB, "*/5 * * * *", "select case when (r ->> 'ok')::boolean then 1 else ('film_sweep failed with SQLSTATE ' || coalesce(r ->> 'error', 'none'))::integer end from (select public.film_sweep('pg_cron') as r) s")]
        assert c.execute(jobs[0][2]).fetchone()[0] == 1  # what pg_cron runs, as the database owner
        assert c.execute("select runner from public.film_sweep_runs").fetchall() == [("pg_cron",)]
        # A sweep that fails: the command raises, so pg_cron marks the run failed, with the SQLSTATE in its message.
        c.execute("savepoint before_fail")
        c.execute("create or replace function public.film_expire_segments() returns integer language plpgsql security definer "
                  "set search_path = public, pg_temp as $$ begin raise exception 'x' using errcode = '55P03'; end $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(jobs[0][2])
        assert "film_sweep failed with SQLSTATE 55P03" in str(e.value)
        c.execute("rollback to savepoint before_fail")
        c.execute(body(ROLLBACK))
        assert c.execute("select count(*) from cron.job").fetchone()[0] == 0
        c.rollback()


def test_with_pg_cron_a_schedule_that_did_not_land_fails_the_file(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(CRON_STUB)
        c.execute("create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint "
                  "language sql as $f$ select 0::bigint $f$")  # answers, schedules nothing
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "pg_cron is installed but the job nightshift-film-sweep" in str(e.value)
        c.rollback()


def test_a_rollback_whose_unschedule_fails_changes_nothing(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(CRON_STUB)
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute("create or replace function cron.unschedule(job_name text) returns boolean language plpgsql as $f$ "
                  "begin raise exception 'cron is unhappy'; end $f$")
        c.execute("savepoint before_rollback")
        with pytest.raises(psycopg.Error) as e:
            c.execute(body(ROLLBACK))
        assert "cron is unhappy" in str(e.value)
        c.execute("rollback to savepoint before_rollback")
        assert c.execute("select to_regprocedure('public.film_sweep(text)') is not null and "
                         "(select count(*) from cron.job where jobname = %s) = 1", [JOB]).fetchone()[0] is True
        c.rollback()


@pytest.mark.parametrize("change", [
    "alter table public.film_sweep_runs add column note text",
    "alter table public.film_sweep_runs alter column last_settled type bigint",
    "alter table public.film_sweep_runs drop constraint film_sweep_runs_last_error_check",
    "alter table public.film_sweep_runs drop constraint film_sweep_runs_runner_check",
])
def test_a_film_sweep_runs_of_another_shape_is_refused(db, change):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(change)
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "film_sweep_runs that is not this file's" in str(e.value)
        c.rollback()


def test_the_drift_guard_and_the_rollback_refuse_a_body_that_is_not_0212s(db):
    other = ("create or replace function public.film_sweep(p_runner text) returns jsonb language sql security definer "
             "set search_path = public, pg_temp as $$ select '{\"ok\": true}'::jsonb $$")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(other)
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "film_sweep(text) with a body that is not this file's" in str(e.value)
        c.rollback()
        c.execute(other)
        with pytest.raises(psycopg.Error) as e:
            c.execute(body(ROLLBACK))
        assert "is not 0212's body" in str(e.value)
        c.rollback()


def test_the_rollback_takes_0212_out_leaves_0171s_sweep_and_0212_applies_again(db):
    sweep(db, "actions")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(body(ROLLBACK))
        gone = c.execute("select to_regprocedure('public.film_sweep(text)'), to_regprocedure('public.film_sweep_status()'), "
                         "to_regclass('public.film_sweep_runs')").fetchone()
        assert gone == (None, None, None)
        assert c.execute("select to_regprocedure('public.film_expire_segments()') is not null").fetchone()[0] is True
        assert isinstance(c.execute("select public.film_expire_segments()").fetchone()[0], int)  # the worker's pre-0212 path
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute("select has_function_privilege('service_role', 'public.film_sweep(text)', 'execute') "
                         "and not has_function_privilege('anon', 'public.film_sweep(text)', 'execute')").fetchone()[0] is True
        assert c.execute("select public.film_sweep_status() -> 'overdue'").fetchone()[0] is None  # the record starts over: unknown
        c.rollback()
    assert set(runs(db)) == {"actions"}


def test_the_lab_takes_0212_off_before_0171_and_puts_it_back(db):
    """sec_db.take_off_0171 (through take_off_0187) must take 0212 off first: 0171's rollback refuses while a later function reads
    film_segments, and 0166's while any film_ function is left."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0212(c)
        assert sec_db.has_0212(c) is False
        sec_db.put_back_0212(c)
        assert sec_db.has_0212(c) is True
        c.rollback()
