"""Breach on the Studio live view's two read-only routes (branch claude/canvas-film-live):

  * GET /api/films/[id]/live   film_json (0166) + film_segments (0171) + film_takes (0166/0171), with the person's own session;
  * GET /api/agent/runs/[id]   render_jobs by id (0019) + the job channel's system_events in [started_at, finished_at + 2 min] (0033).

Each test runs the routes' EXACT PostgREST selects as the SQL PostgREST would issue, as the role and claims PostgREST would set, so
what the database refuses here is what the route is refused. The route code adds no authorization of its own beyond the session, so
these RLS policies and column grants ARE the boundary.
"""

from __future__ import annotations

import json

import psycopg
import pytest

from sec_db import ANON, acting, as_superuser  # noqa: E402
from test_sec_films_money import a, b, db, no_live_segment  # noqa: E402,F401  (fixtures)

# The routes' column lists, verbatim.
SEG_COLS = ("id,status,assembly_status,assembly_asset_id,confirmed_credits,captured_credits,assembly_confirmed_credits,"
            "assembly_charged_credits,created_at")
TAKE_COLS = "id,error_code,confirmed_credits,charged_credits"
JOB_COLS = "id,kind,status,attempts,channel_id,created_at,started_at,heartbeat_at,finished_at,error"

OPERATOR_TEXT = "LAB-OPERATOR-ONLY: ElevenLabs quota_exceeded on key slot 2; remedy: top up vendor"


def act(db, user, q, p=None, role="authenticated"):
    return db.act(role, user, q, p)


# ── the film route ─────────────────────────────────────────────────────────

@pytest.fixture
def started(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    # A take with a provider task id and a free-text error, as the worker writes it.
    db.claim()
    takes = db.takes(seg["id"])
    db.make(a, takes[0][0], takes[0][1])  # succeeded with provider task "lab-task-1"
    db.begin(takes[1][0])
    db.fail(takes[1][0], "provider_error", code="vendor_refused")
    return fid, seg["id"]


def test_a_viewer_of_another_org_reads_no_segment_and_no_take_of_a_film(db, a, b, started):
    fid, _ = started
    seg = act(db, b.viewer, f"select {SEG_COLS} from public.film_segments where film_id = %s", [fid])
    tk = act(db, b.viewer, f"select {TAKE_COLS} from public.film_takes where film_id = %s", [fid])
    assert seg == [] and tk == []
    with pytest.raises(psycopg.Error) as e:
        act(db, b.viewer, "select public.film_json(%s::uuid)", [fid])
    assert e.value.sqlstate == "P0002"


def test_the_owning_viewer_reads_every_column_the_live_route_selects(db, a, started):
    """Not a hole: if any column here were ungranted the route would silently answer segments/takes null."""
    fid, _ = started
    assert len(act(db, a.viewer, f"select {SEG_COLS} from public.film_segments where film_id = %s", [fid])) == 1
    assert len(act(db, a.viewer, f"select {TAKE_COLS} from public.film_takes where film_id = %s", [fid])) >= 1


@pytest.mark.parametrize("col", ["provider_task_id"])
def test_a_member_cannot_select_the_takes_provider_task_id(db, a, started, col):
    with pytest.raises(psycopg.Error) as e:
        act(db, a.viewer, f"select {col} from public.film_takes")
    assert e.value.sqlstate == "42501"


@pytest.mark.parametrize("col", ["worker_id", "request_hash"])
def test_a_member_cannot_select_the_segments_worker_columns(db, a, started, col):
    exists = db.su("select 1 from information_schema.columns where table_schema='public' and table_name='film_segments' "
                   "and column_name=%s", [col])
    if not exists:
        pytest.skip(f"film_segments has no {col}")
    with pytest.raises(psycopg.Error) as e:
        act(db, a.viewer, f"select {col} from public.film_segments")
    assert e.value.sqlstate == "42501"


def test_film_json_carries_no_provider_task_id_or_worker_id(db, a, started):
    fid, sid = started
    assert db.su("select count(*) from public.film_takes where segment_id = %s and provider_task_id = 'lab-task-1'", [sid])[0][0] == 1
    raw = json.dumps(act(db, a.viewer, "select public.film_json(%s::uuid)", [fid])[0][0])
    assert "provider_task_id" not in raw and "worker_id" not in raw and "lab-task" not in raw


@pytest.mark.parametrize("role", ["anon", "service_role"])
def test_no_anon_or_service_read_of_the_film_tables(db, a, started, role):
    fid, _ = started
    for q in (f"select {SEG_COLS} from public.film_segments", "select id from public.film_takes",
              f"select public.film_json('{fid}'::uuid)"):
        if role == "service_role" and not q.startswith("select public."):
            continue  # the trusted backend reads whole rows on purpose (0166/0171)
        with pytest.raises(psycopg.Error) as e:
            act(db, None, q, role=role)
        assert e.value.sqlstate == "42501", q


# ── the run route ──────────────────────────────────────────────────────────

@pytest.fixture
def run_window(conn, sc):
    """Each tenant's seeded job, run and finished in one window, with channel events inside it carrying operator text."""
    with as_superuser(conn) as s:
        for t in sc.tenants():
            s.rows("update public.render_jobs set status='failed', attempts=1, started_at='2026-10-01T10:00:00Z', "
                   "heartbeat_at='2026-10-01T10:05:00Z', finished_at='2026-10-01T10:10:00Z', error=%s where id=%s",
                   [OPERATOR_TEXT, t.render_job])
            s.rows("insert into public.system_events (event_key, event, ts, channel_id, status, agent, metadata) "
                   "values (%s, 'render_done', '2026-10-01T10:11:00Z', %s, 'ok', 'renderer', %s::jsonb) "
                   "on conflict do nothing",
                   [f"ev-live-{t.key}", t.channel, json.dumps({"privacy": "private", "log_tail": OPERATOR_TEXT})])
    yield


def events_q(cols):
    return (f"select {cols} from public.system_events where channel_id = %s and ts >= %s and ts <= %s "
            "order by ts asc limit 300")


def test_another_orgs_run_reads_like_a_missing_one(conn, sc, run_window):
    for me, other in ((sc.alice, sc.bob), (sc.bob, sc.alice)):
        with acting(conn, me.actor) as s:
            assert s.rows(f"select {JOB_COLS} from public.render_jobs where id = %s", [other.render_job]) == []
            assert s.rows(events_q("ts,event,status,agent,metadata->>'privacy' as privacy"),
                          [other.channel, "2026-10-01T10:00:00Z", "2026-10-01T10:12:00Z"]) == []
    with acting(conn, sc.stranger) as s:
        assert s.rows("select id from public.render_jobs") == []
        assert s.rows("select ts from public.system_events where channel_id is not null") == []


def test_anon_reads_no_job_and_no_event(conn, sc, run_window):
    with acting(conn, ANON) as s:
        assert not s.run("select id from public.render_jobs").ok
        out = s.run("select ts from public.system_events where channel_id in ('chan-a','chan-b')")
        assert (not out.ok) or out.rows == []


def test_KNOWN_the_privacy_only_select_is_not_a_boundary_members_read_job_error_and_all_event_metadata(conn, sc, run_window):
    """Not new with this route (0017/0019/0033 grant whole-table select): a viewer of the job's organization reads
    render_jobs.error and every key of system_events.metadata with the anon key directly. The route's "the operator text and
    log tail stay the operator's" is therefore a presentation choice, not access control. Pinned as current behaviour."""
    me = sc.alice
    with acting(conn, me.actor) as s:
        err = s.value("select error from public.render_jobs where id = %s", [me.render_job])
        md = s.value("select metadata from public.system_events where event_key = %s", [f"ev-live-{me.key}"])
    assert err == OPERATOR_TEXT
    assert md.get("log_tail") == OPERATOR_TEXT


def test_the_window_select_reads_only_the_jobs_own_channel(conn, sc, run_window):
    me = sc.alice
    with acting(conn, me.actor) as s:
        rows = s.rows(events_q("ts,event,status,agent,metadata->>'privacy' as privacy,channel_id"),
                      [me.channel, "2026-10-01T10:00:00Z", "2026-10-01T10:12:00Z"])
    assert rows and {r[-1] for r in rows} == {me.channel}
