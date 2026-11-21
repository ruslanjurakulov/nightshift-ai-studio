"""Migration 0096: a unique @username per person (visible handle; sign-in stays by e-mail).

A handle is a label, not a credential, so the attacks here are on its
integrity and on what asking about it gives away. What would break without
each:

* two people holding one name (case games, or two requests landing together);
* a name that reads as the platform (admin, support, "a.d.m.i.n", anything
  nightshift...) being claimed, by the RPC or by a write that skipped it;
* a format the page cannot render, or one the table would store in mixed case;
* the one-change-per-30-days rule being beaten by changing again, by a second
  tab, or by re-running the first set;
* a person reading, or anyone writing, the table directly;
* the signed-out check being callable as a way to learn more than a boolean,
  or without any ceiling;
* the signed-in functions being reachable with the anon key;
* an error message (SQL text) standing in for a business refusal.

Isolation of the table (customer / stranger / anon, row by row) is covered by
test_sec_isolation.py through sec_expectations.TABLES; the function grants and
the pinned search_path by test_sec_catalog.py.
"""

from __future__ import annotations

import json
import threading
import uuid
from contextlib import contextmanager

import psycopg
import pytest

import sec_db
from sec_db import ANON, acting, as_superuser, user

SC = None


@pytest.fixture(autouse=True)
def _scenario(sc):
    global SC
    SC = sc


# ── helpers ─────────────────────────────────────────────────────────────────

def as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    return s


def as_user(s, actor):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)
    return s


def call(s, actor, query, params=None):
    as_user(s, actor)
    out = s.run(query, params)
    as_owner(s)
    return out


def ok(out):
    assert out.ok, out
    return out.rows[0][0] if out.rows else None


def new_user(s, tag="h"):
    who = user(tag, f"{tag}-{uuid.uuid4().hex[:8]}@lab.test")
    as_owner(s)
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
    return who


def uniq(prefix="ana"):
    return f"{prefix}.{uuid.uuid4().hex[:10]}"


def set_handle(s, who, handle):
    return ok(call(s, who, "select public.set_handle(%s)", [handle]))


def available(s, who, handle):
    return ok(call(s, who, "select public.handle_available(%s)", [handle]))


@contextmanager
def world(conn):
    with as_superuser(conn, commit=False) as s:
        yield s


# ── the rules ───────────────────────────────────────────────────────────────

GOOD = ["abc", "ana.k", "ana_k", "a1b2c3", "_ab", "ab_", "123", "a" * 30, "x.y.z", "ana__k"]
BAD_FORMAT = [
    "", "ab", "a" * 31, ".ab", "ab.", "a..b", "___", "_._", "a b", "a-b", "a@b", "@ana", "ана", "ana!", "a\nb", "ana.k ",
    "a" * 29 + ".",
]
RESERVED = [
    "admin", "Administrator", "ROOT", "support", "help", "billing", "api", "mcp", "nightshift", "security", "system",
    "staff", "moderator", "null", "undefined", "login", "signup",
    "nightshift_team", "nightshift.support", "nightshifts", "NightShift99",
    "a.d.m.i.n", "su_pport", "bil.ling",
]


@pytest.mark.parametrize("handle", GOOD)
def test_a_good_handle_is_stored_lowercase_and_then_unavailable(conn, handle):
    # The transaction is rolled back, so the fixed shapes below never collide
    # with a name an earlier test committed.
    with world(conn) as s:
        who = new_user(s)
        assert available(s, who, handle.upper()) is True
        assert set_handle(s, who, handle.upper()) == {"code": "ok", "handle": handle.lower()}
        as_owner(s)
        assert s.value("select handle from public.user_handles where user_id = %s", [who.uid]) == handle.lower()
        assert available(s, SC.bob.actor, handle) is False
        assert available(s, SC.bob.actor, handle.upper()) is False
        assert ok(call(s, ANON, "select public.handle_available_public(%s)", [handle])) is False


@pytest.mark.parametrize("handle", BAD_FORMAT)
def test_a_malformed_handle_is_invalid_and_never_available(conn, handle):
    with world(conn) as s:
        who = new_user(s)
        assert available(s, who, handle) is False
        assert ok(call(s, ANON, "select public.handle_available_public(%s)", [handle])) is False
        assert set_handle(s, who, handle) == {"code": "invalid"}
        as_owner(s)
        assert s.value("select count(*) from public.user_handles where user_id = %s", [who.uid]) == 0


def test_null_is_not_a_handle(conn):
    with world(conn) as s:
        who = new_user(s)
        assert available(s, who, None) is False
        assert set_handle(s, who, None) == {"code": "invalid"}


@pytest.mark.parametrize("handle", RESERVED)
def test_reserved_words_are_refused_like_a_taken_name(conn, handle):
    with world(conn) as s:
        who = new_user(s)
        assert available(s, who, handle) is False
        assert ok(call(s, ANON, "select public.handle_available_public(%s)", [handle])) is False
        # the same word a taken name gets: a caller cannot tell reserved from held
        assert set_handle(s, who, handle) == {"code": "taken"}
        as_owner(s)
        assert s.value("select count(*) from public.user_handles where user_id = %s", [who.uid]) == 0


def test_the_table_refuses_a_bad_handle_even_when_the_rpc_is_skipped(conn):
    with world(conn) as s:
        who = new_user(s)
        as_owner(s)
        for bad in ("Ana.Mixed", "ab", "admin", "a..b", "nightshift1", "x" * 31):
            out = s.run("insert into public.user_handles (user_id, handle) values (%s, %s)", [who.uid, bad])
            assert not out.ok and out.sqlstate == "23514", (bad, out)


def test_the_pure_helpers_are_not_callable_through_the_api(conn):
    with world(conn) as s:
        who = new_user(s)
        for fn in ("handle_format_ok", "handle_reserved", "handle_valid"):
            for actor in (ANON, who):
                out = call(s, actor, f"select public.{fn}('abc')")
                assert not out.ok and out.sqlstate == "42501", (fn, actor.name, out)


# ── uniqueness ──────────────────────────────────────────────────────────────

def test_one_name_one_person_whatever_the_case(conn):
    with world(conn) as s:
        a, b = new_user(s, "first"), new_user(s, "second")
        name = uniq("Case")
        assert set_handle(s, a, name)["code"] == "ok"
        assert available(s, b, name) is False
        assert available(s, b, name.upper()) is False
        for variant in (name, name.upper(), name.title()):
            assert set_handle(s, b, variant) == {"code": "taken"}, variant
        as_owner(s)
        assert s.value("select count(*) from public.user_handles where lower(handle) = %s", [name.lower()]) == 1
        # and the index itself, below the function
        out = s.run("insert into public.user_handles (user_id, handle) values (%s, %s)", [b.uid, name.lower()])
        assert not out.ok and out.sqlstate == "23505", out


def test_a_replaced_handle_is_free_again(conn):
    with world(conn) as s:
        a, b = new_user(s, "mover"), new_user(s, "taker")
        old, new = uniq("old"), uniq("new")
        assert set_handle(s, a, old)["code"] == "ok"
        assert set_handle(s, a, new)["code"] == "ok"  # the first change is allowed at once
        assert available(s, b, old) is True
        assert set_handle(s, b, old)["code"] == "ok"


def test_two_people_racing_for_one_name_get_one_ok_and_one_taken(conn):
    name = uniq("race")
    people = []
    for _ in range(2):
        with as_superuser(conn) as s:
            people.append(new_user(s, "racer"))

    def go(c, barrier, i):
        barrier.wait()
        with acting(c, people[i], commit=True) as s:
            return s.value("select public.set_handle(%s)", [name])["code"]

    results = _race(conn, 2, go)
    assert sorted(results) == ["ok", "taken"], results
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.user_handles where handle = %s", [name]) == 1


def test_one_person_in_two_tabs_cannot_beat_the_cooldown_or_leave_two_rows(conn):
    with as_superuser(conn) as s:
        who = new_user(s, "tabs")
    names = [uniq("tab"), uniq("tab"), uniq("tab")]

    def go(c, barrier, i):
        barrier.wait()
        with acting(c, who, commit=True) as s:
            return s.value("select public.set_handle(%s)", [names[i]])["code"]

    results = _race(conn, 3, go)
    # the first set is free and the first change is free: two succeed at most, the third is held back
    assert sorted(results) in (["cooldown", "ok", "ok"], ["cooldown", "cooldown", "ok"]), results
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.user_handles where user_id = %s", [who.uid]) == 1


def _dsn(conn) -> str:
    return psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)


def _race(conn, n, body):
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


# ── one change per 30 days (the first set is free) ──────────────────────────

def test_first_set_free_then_one_change_then_thirty_days(conn):
    with world(conn) as s:
        who = new_user(s, "slow")
        a, b, c = uniq("one"), uniq("two"), uniq("three")
        assert set_handle(s, who, a) == {"code": "ok", "handle": a}
        as_owner(s)
        row = s.rows("select changed_at = created_at from public.user_handles where user_id = %s", [who.uid])
        assert row == [(True,)], "the first set must not start the cooldown"
        assert set_handle(s, who, a.upper()) == {"code": "same", "handle": a}  # not a change
        assert set_handle(s, who, b) == {"code": "ok", "handle": b}  # the first change
        res = set_handle(s, who, c)
        assert res["code"] == "cooldown" and "next_change_at" in res, res
        as_owner(s)
        want = s.value("select to_jsonb(changed_at + interval '30 days') #>> '{}' from public.user_handles where user_id = %s", [who.uid])
        assert res["next_change_at"] == want, (res, want)
        # 29 days later: still held back; 31 days: allowed again
        s.rows("update public.user_handles set created_at = now() - interval '60 days', changed_at = now() - interval '29 days' where user_id = %s returning 1", [who.uid])
        assert set_handle(s, who, c)["code"] == "cooldown"
        as_owner(s)
        s.rows("update public.user_handles set created_at = now() - interval '60 days', changed_at = now() - interval '31 days' where user_id = %s returning 1", [who.uid])
        assert set_handle(s, who, c) == {"code": "ok", "handle": c}
        res = set_handle(s, who, uniq("four"))
        assert res["code"] == "cooldown", "a change starts the clock again"


def test_a_refused_change_does_not_cost_the_person_their_handle(conn):
    with world(conn) as s:
        who = new_user(s, "keeper")
        a = uniq("keep")
        assert set_handle(s, who, a)["code"] == "ok"
        assert set_handle(s, who, "admin") == {"code": "taken"}
        assert set_handle(s, who, "a..b") == {"code": "invalid"}
        assert set_handle(s, who, "alice.lab") == {"code": "taken"}
        as_owner(s)
        assert s.value("select handle from public.user_handles where user_id = %s", [who.uid]) == a
        assert s.value("select changed_at = created_at from public.user_handles where user_id = %s", [who.uid]) is True


# ── who may do what ─────────────────────────────────────────────────────────

def test_anon_cannot_set_or_ask_as_a_person(conn):
    with world(conn) as s:
        for q in ("select public.set_handle('anon.try')", "select public.handle_available('anon.try')"):
            out = call(s, ANON, q)
            assert not out.ok and out.sqlstate == "42501", (q, out)
        as_owner(s)
        assert s.value("select count(*) from public.user_handles where handle = 'anon.try'") == 0


def test_a_person_reads_only_their_own_row_and_writes_none(conn, sc):
    with world(conn) as s:
        who = new_user(s, "reader")
        mine = uniq("mine")
        assert set_handle(s, who, mine)["code"] == "ok"
        seen = ok(call(s, who, "select coalesce(jsonb_agg(handle order by handle), '[]'::jsonb) from public.user_handles"))
        assert seen == [mine], seen
        # Alice reads hers only: the seeded one, never the new person's
        seen = ok(call(s, sc.alice.actor, "select coalesce(jsonb_agg(handle), '[]'::jsonb) from public.user_handles"))
        assert seen == ["alice.lab"], seen
        # nobody else, and no anon
        assert ok(call(s, sc.stranger, "select count(*) from public.user_handles")) == 0
        out = call(s, ANON, "select * from public.user_handles")
        assert not out.ok and out.sqlstate == "42501", out
        for q, params in (
            ("insert into public.user_handles (user_id, handle) values (%s, 'sneaky.row')", [who.uid]),
            ("update public.user_handles set handle = 'stolen.row'", []),
            ("update public.user_handles set changed_at = '2001-01-01', created_at = '2001-01-01'", []),
            ("delete from public.user_handles", []),
        ):
            out = call(s, who, q, params)
            assert not out.ok and out.sqlstate == "42501", (q, out)
        as_owner(s)
        assert s.value("select handle from public.user_handles where user_id = %s", [who.uid]) == mine


def test_a_handle_cannot_be_set_for_somebody_else(conn):
    # set_handle takes no user id: it always acts for the caller's own token.
    with world(conn) as s:
        a, b = new_user(s, "actor"), new_user(s, "other")
        name = uniq("mine")
        assert set_handle(s, a, name)["code"] == "ok"
        as_owner(s)
        assert s.value("select count(*) from public.user_handles where user_id = %s", [b.uid]) == 0
        args = s.rows("select pg_get_function_identity_arguments('public.set_handle(text)'::regprocedure)")
        assert args == [("p_handle text",)]


def test_deleting_the_account_deletes_the_handle_and_frees_the_name(conn):
    with world(conn) as s:
        a = new_user(s, "leaver")
        name = uniq("gone")
        assert set_handle(s, a, name)["code"] == "ok"
        as_owner(s)
        s.rows("delete from auth.users where id = %s returning 1", [a.uid])
        assert s.value("select count(*) from public.user_handles where handle = %s", [name]) == 0
        assert available(s, SC.bob.actor, name) is True


# ── what asking gives away ──────────────────────────────────────────────────

def test_availability_is_a_bare_boolean_for_the_signed_in_and_the_signed_out(conn):
    with world(conn) as s:
        as_owner(s)
        for fn in ("handle_available(text)", "handle_available_public(text)"):
            assert s.rows("select prorettype::regtype::text from pg_proc where oid = %s::regprocedure", [f"public.{fn}"]) == [("boolean",)]
        taken, free = "alice.lab", uniq("free")
        for asker in (SC.bob.actor, ANON):
            fn = "handle_available" if asker is not ANON else "handle_available_public"
            out = call(s, asker, f"select public.{fn}(%s)", [taken])
            assert out.ok and out.rows == [(False,)], out
            out = call(s, asker, f"select public.{fn}(%s)", [free])
            assert out.ok and out.rows == [(True,)], out
            assert out.rowcount == 1 and len(out.rows[0]) == 1
        # "taken" and "reserved" and "malformed" are the same answer: false
        for same in ("alice.lab", "admin", "no", "ALICE.LAB"):
            assert ok(call(s, ANON, "select public.handle_available_public(%s)", [same])) is False


def test_the_signed_in_check_is_rate_limited_per_person_and_says_null_not_false(conn):
    with world(conn) as s:
        who = new_user(s, "asker")
        answers = [available(s, who, uniq("probe")) for _ in range(62)]
        assert answers[:60] == [True] * 60, answers[:60]
        assert answers[60:] == [None, None], "past the ceiling the answer is 'not now', never 'taken'"
        # another person is not slowed by it
        assert available(s, new_user(s, "calm"), uniq("probe")) is True


def test_the_signed_out_check_has_a_platform_wide_ceiling(conn):
    with world(conn) as s:
        as_owner(s)
        nil = "00000000-0000-0000-0000-000000000000"
        s.rows("delete from public.web_rate_counters where user_id = %s returning 1", [nil])
        s.rows("insert into public.web_rate_counters (user_id, bucket, window_start, count) "
               "values (%s, 'handle.anon@60', to_timestamp(floor(extract(epoch from now()) / 60) * 60), 299) returning 1", [nil])
        first = ok(call(s, ANON, "select public.handle_available_public(%s)", [uniq("edge")]))
        second = ok(call(s, ANON, "select public.handle_available_public(%s)", [uniq("edge")]))
        third = ok(call(s, ANON, "select public.handle_available_public(%s)", [uniq("edge")]))
        assert (first, second, third) == (True, None, None), (first, second, third)
        # a malformed or reserved handle is answered without spending the counter or touching the table
        before = s.value("select sum(count) from public.web_rate_counters where user_id = %s", [nil])
        assert ok(call(s, ANON, "select public.handle_available_public('admin')")) is False
        assert s.value("select sum(count) from public.web_rate_counters where user_id = %s", [nil]) == before


def test_set_handle_is_rate_limited_and_answers_with_a_code(conn):
    with world(conn) as s:
        who = new_user(s, "hammer")
        codes = [set_handle(s, who, "a..b")["code"] for _ in range(10)]
        assert codes == ["invalid"] * 10
        assert set_handle(s, who, uniq("late")) == {"code": "rate_limited"}


def test_no_business_refusal_is_a_raw_sql_error(conn):
    with world(conn) as s:
        who = new_user(s, "calm")
        for h in ("admin", "a..b", "alice.lab", "", None):
            out = call(s, who, "select public.set_handle(%s)", [h])
            assert out.ok, (h, out)
            assert set(out.rows[0][0]) <= {"code", "handle", "next_change_at"}


# ── replay ──────────────────────────────────────────────────────────────────

def test_applying_the_migration_twice_keeps_every_handle(conn):
    with as_superuser(conn) as s:
        who = new_user(s, "replay")
    name = uniq("replay")
    with acting(conn, who, commit=True) as s:
        assert s.value("select public.set_handle(%s)", [name])["code"] == "ok"
    for _ in range(2):
        sec_db.apply_files(_dsn(conn), [sec_db.MIGRATIONS / "0096_user_handles.sql"])
    with as_superuser(conn, commit=False) as s:
        assert s.value("select handle from public.user_handles where user_id = %s", [who.uid]) == name
        assert s.value("select count(*) from public.user_handles where handle = 'alice.lab'") == 1
    with acting(conn, ANON) as s:
        out = s.run("select * from public.user_handles")
        assert not out.ok and out.sqlstate == "42501"
