"""Named attacks on Nightshift AI's database half (migration 0197).

What would break, and which test says so:
* the daily cap is the only brake on the platform's LLM spend: it must hold for a workspace (and only that workspace), refuse
  without writing, and hold under two calls racing for the last turn;
* a conversation is its author's alone: nobody else reserves a turn on it, finishes its call, or reads it;
* a session is only ever opened in a workspace the person belongs to, for one of that workspace's own channels;
* the metering and the owner's knobs are the owner's: closed tables, owner-only functions;
* the person's half and the assistant's half cannot be written except through the functions.
"""

from __future__ import annotations

import threading

import psycopg
import pytest

from sec_db import ANON, SERVICE, acting, as_superuser

START = "select public.ai_chat_start(%s, %s, 'anthropic-claude-sonnet-5-5')"
RESERVE = "select public.ai_chat_reserve_turn(%s, %s)"


def _limit(su, n: int) -> None:
    su.rows("update public.ai_chat_limits set per_org_daily = %s where id returning 1", [n])


def test_the_cap_refuses_the_turn_after_the_limit_and_writes_nothing(conn, sc):
    with as_superuser(conn, commit=False) as su:
        used = su.value("select public.ai_chat_used(%s)", [sc.alice.org])
        _limit(su, used + 1)
        with acting(conn, sc.alice.actor) as s:
            assert s.run(RESERVE, [sc.alice.ai_chat_session, "one more"]).ok
            before = su.value("select count(*) from public.ai_chat_messages")
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "and another"])
            assert not out.ok and out.sqlstate == "NS429" and out.error == "chat_daily_cap", out
            assert su.value("select count(*) from public.ai_chat_messages") == before
        # Bob's workspace has its own count: Alice's cap is not his.
        with acting(conn, sc.bob.actor) as s:
            assert s.run(RESERVE, [sc.bob.ai_chat_session, "mine"]).ok


@pytest.fixture
def _racing_dsn(conn):
    return conn.info.dsn


def test_the_last_turn_is_taken_once_under_a_race(conn, sc, _racing_dsn):
    with as_superuser(conn, commit=True) as su:
        used = su.value("select public.ai_chat_used(%s)", [sc.bob.org])
        _limit(su, used + 1)
    results: list = []

    def one():
        with psycopg.connect(_racing_dsn, autocommit=False) as c:
            with acting(c, sc.bob.actor, commit=True) as s:
                results.append(s.run(RESERVE, [sc.bob.ai_chat_session, "race"]))

    try:
        threads = [threading.Thread(target=one) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sum(r.ok for r in results) == 1, results
        assert all(r.error == "chat_daily_cap" for r in results if not r.ok), results
    finally:
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from public.ai_chat_messages where content = 'race' returning 1")
            su.rows("delete from public.ai_chat_calls where org_id = %s and created_at > now() - interval '1 minute' returning 1", [sc.bob.org])
            _limit(su, 40)


def test_nobody_else_reserves_finishes_or_reads_a_conversation(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(RESERVE, [sc.alice.ai_chat_session, "hijack"])
        assert not out.ok and out.error == "session_not_found", out
        assert s.rows("select id from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session]) == []
        assert s.rows("select id from public.ai_chat_messages where session_id = %s", [sc.alice.ai_chat_session]) == []
    with as_superuser(conn, commit=False) as su:
        call = su.value("select id from public.ai_chat_calls where session_id = %s order by created_at desc limit 1", [sc.alice.ai_chat_session])
        with acting(conn, sc.bob.actor) as s:
            out = s.run("select public.ai_chat_finish_turn(%s, 'ok', 1, 1, 'fake', null, null, null)", [call])
            assert not out.ok and out.error == "call_not_found", out
        with acting(conn, sc.operator) as s:
            # Not even the operator reads a person's conversation.
            assert s.rows("select id from public.ai_chat_messages where session_id = %s", [sc.alice.ai_chat_session]) == []


def test_a_call_is_finished_once(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        call = s.value(RESERVE, [sc.alice.ai_chat_session, "finish me"])["call_id"]
        assert s.run("select public.ai_chat_finish_turn(%s, 'ok', 5, 6, 'answer', null, '{\"style\":\"noir\"}', 'asking')", [call]).ok
        again = s.run("select public.ai_chat_finish_turn(%s, 'ok', 5, 6, 'answer twice', null, null, null)", [call])
        assert not again.ok and again.error == "call_not_found", again
        assert s.value("select count(*) from public.ai_chat_messages where session_id = %s and content = 'answer twice'",
                       [sc.alice.ai_chat_session]) == 0


def test_a_session_opens_only_in_ones_own_workspace_for_its_own_channel(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.run(START, [sc.bob.org, sc.bob.channel])
        assert not out.ok and out.error == "forbidden", out
        out = s.run(START, [sc.alice.org, sc.bob.channel])
        assert not out.ok and out.error == "channel_not_found", out
    with acting(conn, sc.stranger) as s:
        assert not s.run(START, [sc.alice.org, sc.alice.channel]).ok
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select public.ai_chat_quota(%s)", [sc.bob.org])
        assert not out.ok and out.error == "forbidden", out


def test_a_message_too_long_is_refused_before_it_counts(conn, sc):
    with as_superuser(conn, commit=False) as su:
        before = su.value("select public.ai_chat_used(%s)", [sc.alice.org])
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "x" * 5000])
            assert not out.ok and out.error == "message_too_long", out
        assert su.value("select public.ai_chat_used(%s)", [sc.alice.org]) == before


@pytest.mark.parametrize("q", [
    "insert into public.ai_chat_messages (session_id, created_by, role, content) values (%(s)s, %(u)s, 'assistant', 'forged')",
    "update public.ai_chat_sessions set step = 'proposing' where id = %(s)s",
    "select * from public.ai_chat_calls",
    "select * from public.ai_chat_limits",
    "update public.ai_chat_limits set per_org_daily = 10000",
])
def test_the_tables_are_written_only_through_the_functions(conn, sc, q):
    with acting(conn, sc.alice.actor) as s:
        out = s.run(q, {"s": sc.alice.ai_chat_session, "u": sc.alice.actor.uid})
    assert not out.ok and out.sqlstate == "42501", out


def test_the_knobs_and_the_metering_are_the_owners(conn, sc):
    for call in ("select public.ai_chat_set_limits(10000, 4000)", "select * from public.ai_chat_usage('2026-01-01', '2026-12-31')"):
        with acting(conn, sc.alice.actor) as s:
            out = s.run(call)
        assert not out.ok and out.sqlstate == "42501", out
        for who in (ANON, SERVICE):
            with acting(conn, who) as s:
                assert not s.run(call).ok
    with acting(conn, sc.operator) as s:
        rows = s.rows("select * from public.ai_chat_usage(current_date - 1, current_date + 1)")
        assert rows and all(len(r) == 7 for r in rows)
        # No text column in the owner's reading: only counts and tokens.
        assert s.value("select public.ai_chat_set_limits(40, 2000) ->> 'per_org_daily'") == "40"
