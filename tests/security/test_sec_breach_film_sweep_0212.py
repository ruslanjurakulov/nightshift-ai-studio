"""Breach on migration 0212 (film_sweep, film_sweep_status, film_sweep_runs), tools/film_sweep.py, FilmRest.sweep and film_sweep.yml.

Attacked from the lab only (a scratch Postgres with the migrations applied, the PostgREST stand-in, fake keys), as the anon key, a signed-in
member of another organization, a platform admin, a JWT whose claims say service_role while the role is authenticated, and the service
role itself (many runners at once, racing the worker's claim, take and settle calls). Each test names the defence it pins; a test that
fails names a hole that is still open (it stays failing until the product code closes it, never skipped):

  reach      no browser role, forged claim or platform admin calls either function or touches the record; the status names no org,
             film or segment;
  races      any number of sweeps from every runner, racing film_claim_segment, film_take_succeeded and film_settle_segment, capture a
             hold once and never above its amount, and never settle a live segment early;
  injection  p_runner is one of three words: oversized, SQL-ish, control characters and null are refused and record nothing;
  silence    a sweep that "completes" while every pass skips a segment past its deadline and grace must not make "overdue" read
             false (OPEN: see test_overdue_is_not_false_while_every_sweep_skips_a_segment_past_its_grace); a cancelled statement
             surfaces as an error, never as a recorded success;
  workflow   film_sweep.yml has no trigger a pull request can reach, interpolates nothing into a shell, and the CLI logs neither the
             key nor the URL on any failure path.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from decimal import Decimal

import psycopg
import pytest

import sec_db
from test_sec_film_e2e_lab import KEY, URL, FakePostgrest
from test_sec_films_money import a, db, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are

from modules import film_orchestrator as fo
from tools import film_sweep as fs

RUNNERS = ("worker", "actions", "pg_cron")
WORKFLOW = sec_db.REPO / ".github" / "workflows" / "film_sweep.yml"
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


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
    db.su("delete from public.film_sweep_runs")
    yield


def past_grace(db, o):
    """A started film whose worker made the key frame and was lost; its segment past the deadline plus the 2-hour grace."""
    fid = db.film(o)
    seg = db.quoted_start(o, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.make(o, kf, "keyframe")
    db.su("update public.film_segments set deadline_at = now() - interval '2 hours 1 minute' where id = %s", [seg["id"]])
    return fid, seg


def past_grace_with_a_take_in_flight(db, o):
    """As past_grace, with a clip begun before the deadline passed: the worker is waiting on its provider when the grace runs out."""
    fid = db.film(o)
    seg = db.quoted_start(o, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.make(o, kf, "keyframe")
    clip = next(t[0] for t in db.takes(seg["id"]) if t[1] != "keyframe" and t[4] == "planned")
    db.begin(clip)
    db.su("update public.film_segments set deadline_at = now() - interval '2 hours 1 minute' where id = %s", [seg["id"]])
    return fid, seg, clip


def hold_of(db, o, ref):
    return [h for h in db.holds(o.org) if h[0] == ref]


def money_invariants(db, o, seg_id, before_balance):
    """A settled segment: its hold captured once, never above the hold, the account moved by exactly what was captured."""
    st, captured, _reason, ref = db.segment(seg_id)[:4]
    hs = hold_of(db, o, ref)
    assert len(hs) == 1, hs
    _job, amount, hstatus, hcaptured = hs[0]
    assert hstatus in ("captured", "released"), hs
    assert Decimal(hcaptured or 0) <= Decimal(amount), hs
    assert Decimal(hcaptured or 0) == Decimal(captured or 0), (hs, captured)
    caps = db.su("select amount from public.credit_transactions where org_id = %s and kind = 'capture' and job_id = %s", [o.org, ref])
    assert len(caps) <= 1, caps
    assert db.account(o.org)[0] == before_balance - Decimal(captured or 0)
    return st, captured


def race(*fns):
    outs, errs, barrier = [None] * len(fns), [None] * len(fns), threading.Barrier(len(fns))

    def run(i, f):
        barrier.wait()
        try:
            outs[i] = f()
        except Exception as e:  # noqa: BLE001 — a refused call is one legitimate outcome of a race
            errs[i] = e

    ts = [threading.Thread(target=run, args=(i, f)) for i, f in enumerate(fns)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return outs, errs


# ── reach ───────────────────────────────────────────────────────────────────

def test_a_jwt_claiming_service_role_on_the_authenticated_role_reaches_nothing(db, a):
    """PostgREST picks the role from the JWT; the database decides by the role it runs as. Claims alone are not the service role."""
    forged = json.dumps({"role": "service_role", "sub": a.owner})
    for q in ("select public.film_sweep('actions')", "select public.film_sweep_status()", "select * from public.film_sweep_runs"):
        with psycopg.connect(db.dsn, autocommit=False) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [forged])
            c.execute("set local role authenticated")
            with pytest.raises(psycopg.Error) as e:
                c.execute(q)
            assert e.value.sqlstate == "42501", q
            c.rollback()
    assert runs(db) == {}


def test_a_platform_admin_and_another_orgs_owner_reach_nothing(db, a):
    b = db.new_org()
    admin = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, %s)", [admin, f"platform-{admin[:8]}@breach.lab"])
    db.su("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner')", [admin, f"platform-{admin[:8]}@breach.lab"])
    for who in (admin, b.owner):
        for q in ("select public.film_sweep('worker')", "select public.film_sweep_status()",
                  "select count(*) from public.film_sweep_runs",
                  "insert into public.film_sweep_runs (runner, last_at, last_settled) values ('pg_cron', now(), 0)"):
            assert err(lambda: db.act("authenticated", who, q)) == "42501", (who, q)
    assert runs(db) == {}


def test_no_api_role_can_replace_or_drop_the_sweep_or_its_record(db):
    for role in ("anon", "authenticated", "service_role"):
        for q in ("create or replace function public.film_sweep(p_runner text) returns jsonb language sql as $$ select '{}'::jsonb $$",
                  "drop function public.film_sweep_status()", "alter table public.film_sweep_runs disable row level security",
                  "drop table public.film_sweep_runs"):
            assert err(lambda: db.act(role, None, q)) in ("42501", "42P13"), (role, q)


def test_the_status_names_no_organization_film_or_segment(db, a):
    b = db.new_org()
    db.quoted_start(a, db.film(a))
    db.quoted_start(b, db.film(b))
    sweep(db, "actions")
    st = status(db)
    text = json.dumps(st, default=str)
    assert not UUID_RE.search(text), text
    assert set(st) == {"runners", "last_at", "open_segments", "stuck_segments", "oldest_stuck_minutes", "overdue_after_minutes",
                       "overdue", "at"}
    assert st["open_segments"] >= 2  # a count across orgs, service role only, nothing that says whose


# ── injection ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", ["actions'; delete from public.film_segments; --", "x" * 1_000_000, "actions\n", "actions\t",
                                 " actions", "ACTIONS", "worker,actions", "pg_cron_", None, "", "  "])
def test_a_hostile_runner_is_refused_and_records_nothing(db, bad):
    code = err(lambda: sweep(db, bad))
    assert code == "22023", (repr(bad)[:40], code)
    assert runs(db) == {}


def test_sweeping_never_settles_a_live_segment_early(db, a):
    """A running segment inside its deadline, a take in flight, its heartbeat fresh: no number of sweeps, from any runner, moves it."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf)
    before = (db.segment(seg["id"]), db.holds(a.org), db.account(a.org))
    for _ in range(3):
        for r in RUNNERS:
            out = sweep(db, r)
            assert out["ok"] is True and out["settled"] == 0, out
    assert (db.segment(seg["id"]), db.holds(a.org), db.account(a.org)) == before
    assert db.takes(seg["id"])[0][4] == "running"


# ── races ───────────────────────────────────────────────────────────────────

def test_eight_sweeps_from_every_runner_at_once_settle_each_segment_once_and_never_above_its_hold(db, a):
    b = db.new_org()
    _fa, sa = past_grace(db, a)
    _fb, sb = past_grace(db, b)
    ba, bb = db.account(a.org)[0], db.account(b.org)[0]
    outs, errs = race(*[(lambda r=RUNNERS[i % 3]: sweep(db, r)) for i in range(8)])
    assert errs == [None] * 8, errs
    assert all(o["ok"] is True for o in outs) and sum(o["settled"] for o in outs) == 2, outs
    for o, s, bal in ((a, sa, ba), (b, sb, bb)):
        st, captured = money_invariants(db, o, s["id"], bal)
        assert st == "settled" and captured == Decimal(3)
    assert set(runs(db)) == set(RUNNERS)


def test_a_sweep_racing_the_workers_take_succeeded_captures_once_and_within_the_hold(db):
    for _ in range(4):
        a = db.new_org()  # one film's hold each round: a fresh account, so a round never runs short of credits  # a few rounds: either side may win; the money must agree either way
        _fid, seg, clip = past_grace_with_a_take_in_flight(db, a)
        out_asset = db.output(a.org, clip)
        bal = db.account(a.org)[0]
        _outs, _errs = race(lambda: sweep(db, "pg_cron"), lambda: db.succeed(clip, 10, out_asset))
        if db.segment(seg["id"])[0] != "settled":
            sweep(db, "actions")  # the take won and the segment drained: the next sweep settles it
        st, captured = money_invariants(db, a, seg["id"], bal)
        assert st == "settled"
        take = next(t for t in db.takes(seg["id"]) if t[0] == clip)
        charged = Decimal(take[6] or 0)
        assert captured == Decimal(3) + charged, (captured, take)  # the key frame plus the clip only if it was really counted
        late = db.su("select count(*) from public.credit_transactions where org_id = %s and kind = 'capture' "
                     "and job_id = %s", [a.org, db.segment(seg["id"])[3]])[0][0]
        assert late == 1


def test_a_take_that_succeeds_after_the_sweep_settled_moves_no_money(db, a):
    _fid, seg, clip = past_grace_with_a_take_in_flight(db, a)
    out_asset = db.output(a.org, clip)
    assert sweep(db, "actions")["settled"] == 1
    after = (db.segment(seg["id"]), db.holds(a.org), db.account(a.org),
             db.su("select count(*) from public.credit_transactions where org_id = %s", [a.org])[0][0])
    try:
        late = db.succeed(clip, 10, out_asset)
        assert not (isinstance(late, dict) and late.get("ok") is True and late.get("charged")), late
    except psycopg.Error:
        pass  # refused: the take was lost with its segment
    assert (db.segment(seg["id"]), db.holds(a.org), db.account(a.org),
            db.su("select count(*) from public.credit_transactions where org_id = %s", [a.org])[0][0]) == after


def test_a_sweep_racing_the_workers_settle_captures_once(db):
    for _ in range(4):
        a = db.new_org()  # one film's hold each round: a fresh account, so a round never runs short of credits
        _fid, seg = past_grace(db, a)
        bal = db.account(a.org)[0]
        race(lambda: sweep(db, "worker"), lambda: db.settle(seg["id"], "failed"), lambda: sweep(db, "actions"))
        st, captured = money_invariants(db, a, seg["id"], bal)
        assert st == "settled" and captured == Decimal(3)


def test_a_sweep_racing_a_claim_of_an_unclaimed_segment_never_hands_out_a_settled_one(db):
    for _ in range(4):
        a = db.new_org()  # one film's hold each round: a fresh account, so a round never runs short of credits
        fid = db.film(a)
        seg = db.quoted_start(a, fid)
        db.su("update public.film_segments set created_at = now() - interval '3 hours 1 minute' where id = %s", [seg["id"]])
        bal = db.account(a.org)[0]
        outs, errs = race(lambda: sweep(db, "pg_cron"), lambda: db.claim("w-race"))
        claimed = outs[1]
        st = db.segment(seg["id"])[0]
        if isinstance(claimed, dict) and claimed.get("id") == seg["id"]:
            assert st in ("running", "draining"), (claimed, st)  # handed out: the sweep must not have settled it under the worker
            db.cancel(seg["id"])
            sweep(db, "actions")
        else:
            assert st in ("settled", "released"), st
        money_invariants(db, a, seg["id"], bal)


# ── silence ─────────────────────────────────────────────────────────────────

def test_overdue_is_not_false_while_every_sweep_skips_a_segment_past_its_grace(db, a):
    """OPEN (medium). film_sweep counts a pass as completed whenever film_expire_segments returns, and 0171 returns normally after
    skipping every segment it could not settle (each in its own subtransaction, a film.segment_skipped event, a WARNING). So a
    segment that fails to settle on every pass, past its deadline and grace with its customer's credits held, leaves
    film_sweep_status() at {"ok": true, settled: 0, overdue: false} forever: G2's measurement reads "met" while nothing settles.
    The status should say so (e.g. count open segments past their settle point and treat one older than the overdue line as
    overdue), not just "a call returned"."""
    _fid, seg = past_grace(db, a)
    db.su("update public.film_segments set deadline_at = now() - interval '5 hours' where id = %s", [seg["id"]])
    db.su("create or replace function public.breach_block_settle() returns trigger language plpgsql as $f$ "
          "begin if old.id = '" + str(seg["id"]) + "'::uuid and new.status is distinct from old.status then "
          "raise exception 'a persistent settle defect' using errcode = 'P0001'; end if; return new; end $f$")
    db.su("create trigger breach_block_settle before update on public.film_segments for each row "
          "execute function public.breach_block_settle()")
    try:
        for r in RUNNERS:
            out = sweep(db, r)
            assert out["ok"] is True and out["settled"] == 0, out  # every runner "completed"
        assert db.segment(seg["id"])[0] in ("running", "draining")
        assert [h[2] for h in hold_of(db, a, db.segment(seg["id"])[3])] == ["open"]
        st = status(db)
        assert st["overdue"] is not False, (
            "film_sweep_status says not overdue while a segment 3 hours past its grace is skipped by every sweep", st)
    finally:
        db.su("drop trigger if exists breach_block_settle on public.film_segments")
        db.su("drop function if exists public.breach_block_settle()")


def test_a_cancelled_sweep_raises_and_is_never_recorded_as_done(db):
    """'when others' does not catch query_canceled: a statement_timeout surfaces to the caller (PostgREST 5xx, pg_cron failed) and
    leaves no completed run behind."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("create or replace function public.film_expire_segments() returns integer language plpgsql security definer "
                  "set search_path = public, pg_temp as $$ begin perform pg_sleep(2); return 0; end $$")
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role"})])
        c.execute("set local role service_role")
        c.execute("set local statement_timeout = '200ms'")
        with pytest.raises(psycopg.Error) as e:
            c.execute("select public.film_sweep('actions')")
        assert e.value.sqlstate == "57014"
        c.rollback()
    assert runs(db) == {}


def test_only_failed_sweeps_past_the_overdue_line_read_overdue_even_with_a_fresh_error(db, a):
    db.quoted_start(a, db.film(a))
    sweep(db, "actions")
    line = status(db)["overdue_after_minutes"]  # 0212's one overdue line (30), read from the answer, never a second copy
    db.su("update public.film_sweep_runs set last_at = now() - make_interval(mins => %s + 5), "
          "last_error = '55P03', last_error_at = now()", [line])
    st = status(db)
    assert st["overdue"] is True and st["runners"]["actions"]["last_error"] == "55P03"


# ── the CLI and the workflow ────────────────────────────────────────────────

SECRET_URL = "https://breach-lab-project.supabase.invalid"
SECRET_KEY = "breach-lab-fake-service-key-0123456789"


class Raising:
    def post(self, url, **kw):
        import requests  # noqa: PLC0415
        raise requests.ConnectionError(f"HTTPSConnectionPool(host='{url}', key='{kw.get('headers', {}).get('apikey')}')")


class Answer:
    def __init__(self, code, body):
        self.code, self.body = code, body

    def post(self, url, **kw):
        class R:
            status_code = self.code

            def json(_s):  # noqa: N805
                return self.body
        return R()


@pytest.mark.parametrize("session,code", [
    (Raising(), 1),
    (Answer(200, {"ok": False, "runner": "actions", "error": "55P03"}), 1),
    (Answer(200, {"ok": False, "error": SECRET_KEY}), 1),
    (Answer(200, None), 1),
    (Answer(404, {"message": "not found"}), 1),
    (Answer(400, {"message": "unknown_runner", "details": f"{SECRET_URL} {SECRET_KEY}"}), 1),
    (Answer(401, {"message": f"Invalid API key {SECRET_KEY}"}), 1),
    (Answer(500, {"message": SECRET_URL}), 1),
])
def test_the_cli_fails_red_and_never_logs_the_key_or_the_url(session, code, caplog):
    env = {"SUPABASE_URL": SECRET_URL, "SUPABASE_SERVICE_KEY": SECRET_KEY}
    with caplog.at_level(logging.DEBUG):
        assert fs.main(env, make_db=lambda u, k: fo.FilmRest(u, k, session=session)) == code
    assert SECRET_KEY not in caplog.text and "breach-lab-project" not in caplog.text, caplog.text


def test_the_cli_against_the_lab_sweeps_as_actions_only(db, a):
    pg = FakePostgrest(db.dsn)
    assert fs.main({"SUPABASE_URL": URL, "SUPABASE_SERVICE_KEY": KEY}, make_db=lambda u, k: fo.FilmRest(u, k, session=pg)) == 0
    assert set(runs(db)) == {"actions"} and [c[1] for c in pg.calls] == ["film_sweep"]


def test_the_workflow_has_no_pull_request_trigger_and_no_shell_interpolation():
    """Read as text (the lab installs no YAML parser): the triggers, the token's permissions, and every line that runs a shell."""
    text = WORKFLOW.read_text(encoding="utf-8")
    code = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    top = [ln for ln in code if not ln.startswith(" ")]
    i = top.index("on:")
    on_block = code[code.index("on:") + 1:code.index(top[i + 1])]
    triggers = {ln.strip().rstrip(":").split(":")[0] for ln in on_block if re.match(r"^  [a-z_]+:", ln)}
    assert triggers == {"schedule", "workflow_dispatch"}, triggers
    assert not re.search(r"pull_request|workflow_run|issue_comment|repository_dispatch|inputs:", text)
    assert re.search(r"^permissions:\n  contents: read\n", text, re.M)
    assert "persist-credentials: false" in text
    for ln in code:
        if "${{" in ln:
            assert re.fullmatch(r"\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}", ln), ln  # only a secret into a step's env
        if re.match(r"\s+(- )?run:", ln):
            assert "${{" not in ln, ln
        if re.match(r"\s+(- )?uses:", ln):
            assert re.search(r"@[0-9a-f]{40}\b", ln), ln  # pinned by sha
