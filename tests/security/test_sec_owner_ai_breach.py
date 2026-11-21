"""Breach round on 0203 (the owner's Nightshift AI meter): attacks that go past the author's own lab tests.

What would break: two owner tabs (or a retry loop) racing for the last turn and both getting a vendor call past the cap; a finish
call freeing a slot so the cap never bites; a second platform owner finishing, or rewriting, the first one's turn; a value that
slips a vendor's free text into the log. Every committed row is deleted in `finally`, so the shared lab stays clean.
"""

from __future__ import annotations

import json
import threading
import time

import psycopg
from psycopg import sql

import sec_db
from sec_db import acting, as_superuser, user

RESERVE = "select public.owner_ai_reserve_turn(40, 'anthropic-claude-sonnet-5-5')"


def _owner_conn(conn, who):
    """A second PostgREST-like connection to the same lab database, acting as `who` in one open transaction."""
    # conn.info.dsn hides the password (CI's lab has one): build it from the lab's admin DSN, as the other race tests do.
    c = psycopg.connect(psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname))
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    c.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    c.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return c


def _seed(conn, uid, n):
    with as_superuser(conn, commit=True) as su:
        su.rows("insert into public.owner_ai_turns (user_id, chars_in, created_at) "
                "select %s, 1, now() - interval '1 hour' from generate_series(1, %s) returning 1", [uid, n])


def _wipe(conn):
    # Only this file's rows (the last day's): the scenario's seed row, two days old, stays for the isolation suite.
    with as_superuser(conn, commit=True) as su:
        su.run("delete from public.owner_ai_turns where created_at > now() - interval '1 day'")


def test_two_racing_requests_cannot_both_take_the_last_turn(conn, sc):
    a = b = None
    out_b: dict = {}
    try:
        # Inside the try: a failed connect must still wipe the seeded rows, or the next test starts at the cap.
        _seed(conn, sc.operator.uid, 199)
        a = _owner_conn(conn, sc.operator)
        b = _owner_conn(conn, sc.operator)
        first = a.execute(RESERVE).fetchone()[0]  # holds the advisory lock, its insert not yet committed

        def second():
            try:
                out_b["id"] = b.execute(RESERVE).fetchone()[0]
                b.commit()
            except psycopg.Error as e:
                out_b["err"] = (e.sqlstate, str(e).splitlines()[0])
                b.rollback()

        t = threading.Thread(target=second)
        t.start()
        time.sleep(0.5)
        assert t.is_alive(), "the second reserve did not wait for the first one's lock"
        a.commit()
        t.join(10)
        assert first is not None
        assert out_b.get("err", (None,))[0] == "NS429", out_b
    finally:
        for c in (a, b):
            if c is not None:
                c.close()
        _wipe(conn)


def test_finishing_a_turn_does_not_free_a_slot(conn, sc):
    try:
        _seed(conn, sc.operator.uid, 199)
        with acting(conn, sc.operator, commit=True) as s:
            tid = s.value(RESERVE)
            s.run("select public.owner_ai_finish_turn(%s, false, 'vendor_error', null, null)", [tid])
        with acting(conn, sc.operator) as s:
            out = s.run(RESERVE)
        assert not out.ok and out.sqlstate == "NS429", out
    finally:
        _wipe(conn)


def test_a_second_owner_cannot_finish_or_rewrite_the_first_owners_turn(conn, sc):
    other = user("owner-2", "owner-2@nightshift.test")
    try:
        with as_superuser(conn, commit=True) as su:
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [other.uid, other.email])
            su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner') returning 1", [other.uid, other.email])
        with acting(conn, sc.operator, commit=True) as s:
            tid = s.value(RESERVE)
        with acting(conn, other, commit=True) as s:
            s.run("select public.owner_ai_finish_turn(%s, true, null, 999999, 999999)", [tid])
        with as_superuser(conn, commit=False) as su:
            row = su.rows("select outcome, tokens_in, user_id::text from public.owner_ai_turns where id = %s", [tid])
        assert row == [("reserved", None, sc.operator.uid)], row
    finally:
        _wipe(conn)
        with as_superuser(conn, commit=True) as su:
            su.run("delete from public.app_members where user_id = %s", [other.uid])
            su.run("delete from auth.users where id = %s", [other.uid])


def test_hostile_values_are_refused_or_neutralised(conn, sc):
    try:
        with acting(conn, sc.operator) as s:
            assert s.run("select public.owner_ai_reserve_turn(-5, 'm')").sqlstate == "22023"
            assert s.run("select public.owner_ai_reserve_turn(2147483647, 'm')").sqlstate == "22023"
            assert not s.run("select public.owner_ai_reserve_turn(2147483648, 'm')").ok
            assert s.run("select public.owner_ai_reserve_turn(5, null)").sqlstate == "22023"
            assert s.run("select public.owner_ai_reserve_turn(5, E'm\\nx')").sqlstate == "22023"
            tid = s.value(RESERVE)
            # A vendor's message, a negative count and an over-long code never land in the log.
            assert s.run("select public.owner_ai_finish_turn(%s, false, 'invalid api key sk-xxx', null, null)", [tid]).sqlstate == "22023"
            assert s.run("select public.owner_ai_finish_turn(%s, false, %s, null, null)", [tid, "a" * 41]).sqlstate == "22023"
            assert s.run("select public.owner_ai_finish_turn(%s, true, null, -1, -1)", [tid]).ok
            row = s.run("select 1 from public.owner_ai_turns")
            assert not row.ok and row.sqlstate == "42501", row
    finally:
        _wipe(conn)
