"""Breach on 0249 (ai_chat_save_sheets and the keep-sheets trigger): the attacks tried, each pinned as the behaviour that must hold.

BR-SW-01 .. BR-SW-NN. A test here that fails is an open hole (never skipped).
"""

from __future__ import annotations

import json
import threading
import time
import uuid

import psycopg
import pytest
from psycopg import sql

import sec_db
import test_sec_series_tables as st
from sec_db import as_superuser
from sec_films_0166 import FILM
from test_sec_sheets_writer_0249 import (BASE_BRIEF, BRIEF, SAVE, Committed, _as_alice, _waiting, as_, become, j, refused, sheet,
                                         stored, view, w)  # noqa: F401 - w is the fixture

GUC = "nightshift.ai_chat_sheets"


# ── 1. setting the flag without the writer ─────────────────────────────────────

def test_br_sw_01_no_api_callable_function_can_set_an_arbitrary_setting(conn):
    """PostgREST runs no SQL of a caller's, so the only way to set the flag through the API is a function in an exposed schema that
    calls set_config with a name or value the caller controls. None may exist; only ai_chat_save_sheets may name the flag."""
    rows = conn.execute(
        "select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prosrc from pg_proc p "
        "join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') "
        "and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))"
    ).fetchall()
    dynamic, flag = [], []
    for nsp, name, args, src in rows:
        src = src or ""
        if name == "set_config":
            dynamic.append(f"{nsp}.{name}({args}) wrapper")
        low = src.lower()
        i = low.find("set_config(")
        while i >= 0:
            arg = low[i + len("set_config("):].lstrip()
            if not arg.startswith("'"):
                dynamic.append(f"{nsp}.{name}({args}): {src[i:i + 60]!r}")
            i = low.find("set_config(", i + 1)
        if GUC in src and name != "ai_chat_save_sheets":
            flag.append(f"{nsp}.{name}({args})")
        # dynamic SQL built from a parameter could run set_config too
    assert not dynamic, dynamic
    assert not flag, flag


def test_br_sw_02_postgrest_request_settings_never_equal_the_flag(w):
    """The request.* settings PostgREST writes (headers, cookies, claims) are other names: a header called nightshift.ai_chat_sheets
    lands inside request.headers, never as the flag, so a whole-BRIEF write with forged sheets is still overruled."""
    s = w.su
    become(s, w.alice)
    s.conn.execute("select set_config('request.headers', %s, true)", [json.dumps({GUC: str(w.sid), "prefer": f"{GUC}={w.sid}"})])
    forged = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
    out = s.run(BRIEF, [w.sid, json.dumps({**BASE_BRIEF, "ref_sheets": forged})])
    become(s, None)
    assert out.ok, out
    assert stored(s, w.sid)["ref_sheets"] == w.sheets


# ── 6. the flag left set after an exception ────────────────────────────────────

def test_br_sw_03_a_caught_failure_inside_the_writer_leaves_no_flag_for_the_next_statement(w):
    """Force the writer's own UPDATE to fail after it set the flag (a later BEFORE trigger raising), catch it in a savepoint as a
    caller could, then write a whole BRIEF in the same transaction: the flag must be gone, the forged sheets overruled."""
    s = w.su
    become(s, None)
    s.conn.execute("create function pg_temp.br_boom() returns trigger language plpgsql as $$ begin "
                   "if current_setting('nightshift.ai_chat_sheets', true) <> '' then raise exception 'boom'; end if; return new; end $$")
    s.conn.execute("create trigger zz_br_boom before update of brief on public.ai_chat_sessions for each row "
                   "execute function pg_temp.br_boom()")
    become(s, w.alice)
    s.conn.execute("savepoint br")
    with pytest.raises(psycopg.Error):
        s.conn.execute(SAVE, [w.sid, j([sheet("c9")]), j([]), None])
    s.conn.execute("rollback to savepoint br")
    assert (s.conn.execute("select coalesce(current_setting(%s, true), '')", [GUC]).fetchone()[0]) == ""
    forged = [sheet("evil")]
    s.conn.execute(BRIEF, [w.sid, json.dumps({**BASE_BRIEF, "ref_sheets": forged})])
    become(s, None)
    s.conn.execute("drop trigger zz_br_boom on public.ai_chat_sessions")
    assert stored(s, w.sid)["ref_sheets"] == w.sheets


def test_br_sw_04_the_flag_set_for_my_own_row_does_not_open_another_row(w):
    """The flag names one row: even if Alice could set it (direct SQL, not the API), it opens only her own conversation, which
    ai_chat_save_brief already limits to her. Bob's conversation keeps its sheets."""
    s = w.su
    put = [sheet("bobs")]
    become(s, None)
    s.conn.execute(f"select set_config('{GUC}', %s, true)", [str(w.bob_sid)])
    s.conn.execute("update public.ai_chat_sessions set step = 'ready', brief = brief || %s::jsonb where id = %s",
                   [json.dumps({"ref_sheets": put}), w.bob_sid])
    s.conn.execute(f"select set_config('{GUC}', %s, true)", [str(w.sid)])
    # Alice with the flag naming her own row tries Bob's conversation: save_brief refuses (not the author).
    assert refused(s, w.alice, BRIEF, [w.bob_sid, json.dumps({**BASE_BRIEF, "ref_sheets": []})]) == "session_not_found"
    s.conn.execute(f"select set_config('{GUC}', '', true)")
    assert stored(s, w.bob_sid)["ref_sheets"] == put


# ── 2. another person's / another org's ────────────────────────────────────────

def test_br_sw_05_bob_cannot_link_alices_conversation_or_link_his_own_to_alices_film(w):
    link = {"film_id": FILM["a"], "scenes": [{"brief": "s1", "film": w.scenes[0]}]}
    assert refused(w.su, w.bob, SAVE, [w.sid, None, None, j(link)]) == "session_not_found"
    w.su.rows("update public.ai_chat_sessions set step = 'ready' where id = %s returning 1", [w.bob_sid])
    assert refused(w.su, w.bob, SAVE, [w.bob_sid, None, None, j(link)]) == "invalid_film_link"
    upper = {"film_id": FILM["a"].upper(), "scenes": [{"brief": "s1", "film": w.scenes[0].upper()}]}
    assert refused(w.su, w.bob, SAVE, [w.bob_sid, None, None, j(upper)]) == "invalid_film_link"
    assert "film_link" not in stored(w.su, w.bob_sid)


# ── 5. lock order ──────────────────────────────────────────────────────────────

def test_br_sw_06_the_writer_takes_no_lock_but_the_conversation_row(conn, sc):
    """A deadlock with 0232 needs the writer to hold the row and wait on something else (the workspace's advisory lock, a lease, a
    call). With its transaction left open, it holds no advisory lock and writes no table but ai_chat_sessions."""
    race = Committed(conn, sc, [sheet()])
    try:
        with psycopg.connect(st._dsn(conn), autocommit=False) as a:
            _as_alice(a, race.alice)
            a.execute(SAVE, [race.sid, j([sheet("c2")]), j([]), None]).fetchall()
            pid = a.info.backend_pid
            with as_superuser(conn, commit=False) as su:
                adv = su.value("select count(*) from pg_locks where pid = %s and locktype = 'advisory'", [pid])
                rel = {r[0] for r in su.rows("select c.relname from pg_locks l join pg_class c on c.oid = l.relation "
                                             "where l.pid = %s and l.mode in ('RowShareLock', 'RowExclusiveLock')", [pid])}
            a.rollback()
        assert adv == 0
        assert all(r.startswith("ai_chat_sessions") for r in rel), rel
    finally:
        race.purge()


# ── 7. a step change racing the write ──────────────────────────────────────────

def test_br_sw_07_a_step_change_committed_while_the_writer_waits_is_read_after_the_wait(conn, sc):
    """Alice's whole-BRIEF write moving the plan back to 'proposing' holds the row; the sheets write waits on it, then must read
    the NEW step (FOR UPDATE re-reads the row) and refuse plan_not_ready, not write against the step it would have seen before."""
    race = Committed(conn, sc, [sheet()])
    try:
        errors = []
        started = threading.Event()
        pid = []
        with psycopg.connect(st._dsn(conn), autocommit=False) as a:
            _as_alice(a, race.alice)
            a.execute("select public.ai_chat_save_brief(%s, %s::jsonb, 'proposing')", [race.sid, json.dumps(BASE_BRIEF)])

            def second():
                try:
                    with psycopg.connect(st._dsn(conn), autocommit=False) as b:
                        pid.append(b.info.backend_pid)
                        _as_alice(b, race.alice)
                        started.set()
                        b.execute(SAVE, [race.sid, j([sheet("late")]), j([]), None]).fetchall()
                        b.commit()
                except Exception as e:  # noqa: BLE001
                    errors.append(e)
                    started.set()

            t = threading.Thread(target=second)
            t.start()
            started.wait(10)
            deadline = time.time() + 10
            while time.time() < deadline and not (pid and _waiting(conn, pid[0])):
                time.sleep(0.05)
            assert pid and _waiting(conn, pid[0])
            a.commit()
            t.join(30)
        assert errors and "plan_not_ready" in str(errors[0]), errors
        assert [x["character_id"] for x in race.brief()["ref_sheets"]] == ["c1"]
    finally:
        race.purge()


# ── 4. the caps: the kept sheets against 0199's 262144 ──────────────────────────

def _full_sheets():
    # 40 sheets x 3 views x 1450-character prompts: about 191 KB, under the writer's 196608 and accepted by it.
    return [sheet(f"c{i}", views=[view(v, prompt="p" * 1450) for v in ("front", "side", "back")]) for i in range(40)]


def test_br_sw_08_a_turn_that_fits_0199s_cap_is_not_broken_by_the_sheets_the_trigger_puts_back(w):
    """BR-SW-08 (closed by 0249's fix round: ai_chat_sessions_brief_0249 counts the sheets apart, so the turn is measured alone
    against 0199's 262144; the trigger names a BRIEF too large on its own brief_too_large). Before: the writer lets the sheets take up to 196608 bytes and checks the whole BRIEF only on its own writes. The
    trigger then adds those stored sheets to EVERY other BRIEF writer's BRIEF after that writer's own checks, so a turn whose BRIEF
    is only ~75 KB now exceeds the table's CHECK (octet_length(brief) <= 262144): ai_chat_save_brief and ai_chat_finish_turn fail
    with a raw 23514, and finish_turn's whole transaction rolls back, so the turn's call (the vendor already paid) stays 'pending'
    and its answer is lost. The route cannot leave the sheets out to make room: the trigger forces them in. Every later turn of the
    conversation fails the same way. Rule 6: refuse by name with the remedy, and never leave a paid call pending."""
    out = as_(w.su, w.alice, SAVE, [w.sid, j(_full_sheets()), j([]), None])
    assert out.ok, out
    turn = {**BASE_BRIEF, "notes": "n" * 75000}
    out = as_(w.su, w.alice, BRIEF, [w.sid, json.dumps(turn)])
    assert out.ok or "brief_too_large" in (out.error or ""), f"save_brief: {out.sqlstate} {out.error}"
    call = w.su.value("insert into public.ai_chat_calls (org_id, user_id, session_id, model, outcome) "
                      "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'pending') returning id", [w.org, w.alice.uid, w.sid])
    out = as_(w.su, w.alice, "select public.ai_chat_finish_turn(%s, 'ok', 1, 1, 'hi', null, null, 'ready', %s::jsonb, null)",
              [call, json.dumps(turn)])
    become(w.su, None)
    outcome = w.su.value("select outcome from public.ai_chat_calls where id = %s", [call])
    assert out.ok or outcome != "pending", f"finish_turn: {out.sqlstate} {out.error}; call left {outcome}"
