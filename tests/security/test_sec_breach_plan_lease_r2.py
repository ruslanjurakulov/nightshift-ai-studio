"""Breach round 2 on the S1 plan step: migration 0211's lease (ai_chat_plan_begin / _end / _state) attacked as a signed-up member,
a colleague, another tenant and anon, in the lab database only.

What this file pins (each held on 4256eef8 unless it says otherwise):

* two begins of one conversation racing on two connections: exactly one is granted, also on a conversation that never had a lease
  (the first INSERT is not a gap: the conversation's row lock serialises it);
* ai_chat_plan_state says nothing about a conversation that is not the caller's: another person's real conversation and an id that
  never existed read identically, for a colleague, another tenant and a former member who wrote it;
* a temp table named like the lease table, sessions or calls does not change what the functions read (search_path public, pg_temp
  and every table schema-qualified), and an API role cannot create in `public` to shadow anything;
* no API role grants itself the lease table, turns its RLS off or adds a policy;
* the takeover's sweep finishes only the author's own stale pending calls of THIS conversation: not Bob's, not the author's other
  conversation's, not a colleague's call in the same workspace;
* the attempt counter at its ceiling fails closed (an error, the lease unchanged): it never wraps to a number whose request ids
  were already spent, nor to one an old plan still holds;
* the database fact BR-S1-08 rests on: after an expired lease is taken over, the old plan can no longer END its lease, but nothing
  stops it from writing the conversation's BRIEF (ai_chat_save_brief knows no lease). The hole itself is in the route and stays
  failing in command-center/tests/security-brain-plan-breach-r2.test.ts.
"""

from __future__ import annotations

import threading
import uuid

import psycopg

import sec_db
from sec_db import ANON, acting, as_superuser, user

BEGIN = "select public.ai_chat_plan_begin(%s, %s, %s)"
END = "select public.ai_chat_plan_end(%s, %s, %s, %s)"
STATE = "select public.ai_chat_plan_state(%s)"
SAVE_BRIEF = "select public.ai_chat_save_brief(%s, %s::jsonb, %s)"


def _dsn(conn) -> str:
    # With the password: conn.info.dsn hides it, and a thread connecting with it fails.
    return psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)


def _member(su, org: str, role: str):
    who = user(f"r2-{role}", f"r2-{role}-{uuid.uuid4().hex[:6]}@lease-r2.lab")
    su.rows("insert into auth.users (id, email) values (%s, %s) returning 1", [who.uid, who.email])
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
            [org, who.uid, who.email, role])
    return who


def _session(su, t, author_uid: str | None = None) -> str:
    return str(su.value("insert into public.ai_chat_sessions (org_id, channel_id, created_by, model, step) "
                        "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'proposing') returning id",
                        [t.org, t.channel, author_uid or t.actor.uid]))


def _race(conn, who, session: str, n: int = 6) -> list:
    dsn = _dsn(conn)
    results: list = []
    gate = threading.Barrier(n)

    def one(i: int):
        with psycopg.connect(dsn, autocommit=False) as c:
            gate.wait()
            with acting(c, who, commit=True) as s:
                results.append(s.run(BEGIN, [session, 41, i % 3]))

    threads = [threading.Thread(target=one, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_two_begins_racing_on_two_connections_grant_one_lease(conn, sc):
    # A conversation with a finished lease (the seed's) and one that never had one: the first INSERT ... ON CONFLICT must not let
    # two plans in through the gap before the row exists.
    with as_superuser(conn, commit=True) as su:
        fresh = _session(su, sc.alice)
        seeded = sc.alice.ai_chat_session
        su.rows("update public.ai_chat_plan_leases set state = 'done' where session_id = %s returning 1", [seeded])
    try:
        for session in (fresh, seeded):
            results = _race(conn, sc.alice.actor, session)
            granted = [r for r in results if r.ok]
            assert len(granted) == 1, (session, results)
            assert all(r.error == "plan_running" for r in results if not r.ok), results
            with as_superuser(conn, commit=False) as su:
                assert su.value("select state from public.ai_chat_plan_leases where session_id = %s", [session]) == "running"
    finally:
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from public.ai_chat_sessions where id = %s returning 1", [fresh])
            su.rows("update public.ai_chat_plan_leases set state = 'done', expires_at = now(), finished_at = now() "
                    "where session_id = %s returning 1", [seeded])


def test_plan_state_reads_the_same_for_someone_elses_conversation_and_one_that_never_existed(conn, sc):
    with as_superuser(conn, commit=False) as su:
        colleague = _member(su, sc.alice.org, "editor")
        former = _member(su, sc.alice.org, "editor")
        # A conversation the former member wrote, with a running lease, and then they left the workspace.
        theirs = _session(su, sc.alice, former.uid)
        su.rows("insert into public.ai_chat_plan_leases (session_id, created_by, proposal_id, scenario_index, attempt, state, expires_at) "
                "values (%s, %s, 1, 0, 3, 'running', now() + interval '5 minutes') returning 1", [theirs, former.uid])
        su.rows("delete from public.org_members where org_id = %s and user_id = %s returning 1", [sc.alice.org, former.uid])
        nowhere = str(uuid.uuid4())
        for who, target in ((colleague, sc.alice.ai_chat_session), (sc.bob.actor, sc.alice.ai_chat_session), (former, theirs)):
            with acting(conn, who) as s:
                real = s.run(STATE, [target])
                ghost = s.run(STATE, [nowhere])
                for fn in (BEGIN, END):
                    args = [target, 41, 0] if fn == BEGIN else [target, 3, "done", None]
                    g_args = [nowhere, 41, 0] if fn == BEGIN else [nowhere, 3, "done", None]
                    a, b = s.run(fn, args), s.run(fn, g_args)
                    assert (a.ok, a.sqlstate, a.error) == (b.ok, b.sqlstate, b.error) == (False, b.sqlstate, "session_not_found"), (who.name, fn, a, b)
            assert (real.ok, real.sqlstate, real.error) == (ghost.ok, ghost.sqlstate, ghost.error), (who.name, real, ghost)
            assert not real.ok and real.error == "session_not_found", (who.name, real)
        with acting(conn, ANON) as s:
            out = s.run(STATE, [sc.alice.ai_chat_session])
            assert not out.ok and out.sqlstate == "42501", out
        # The former member's lease is untouched by all of it.
        assert su.value("select attempt from public.ai_chat_plan_leases where session_id = %s", [theirs]) == 3


def test_a_temp_table_named_like_the_lease_does_not_change_what_the_functions_read(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.ai_chat_plan_leases set state = 'done' where session_id = %s returning 1", [sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor) as s:
            # pg_temp is on the functions' search_path (last). A member may create temp tables; shadows of every table they read:
            for t in ("ai_chat_plan_leases", "ai_chat_sessions", "ai_chat_calls", "ai_chat_settings"):
                assert s.run(f"create temp table {t} (session_id uuid, state text, attempt int, expires_at timestamptz, "
                             "created_by uuid, id uuid, org_id uuid, per_user_daily int, step text)").ok
            s.rows("insert into pg_temp.ai_chat_plan_leases values (%s, 'running', 99, now() + interval '1 hour', %s) returning 1",
                   [sc.alice.ai_chat_session, sc.alice.actor.uid])
            s.rows("insert into pg_temp.ai_chat_settings (per_user_daily) values (100000) returning 1")
            got = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])
            assert got["attempt"] != 100 and got["user_left"] < 100000, got
            state = s.value(STATE, [sc.alice.ai_chat_session])
            assert state["attempt"] == got["attempt"] and state["state"] == "running", state
            # Nor can a member put a function or a table into public to be found first.
            for q in ("create function public.now() returns timestamptz language sql as $$ select 'epoch'::timestamptz $$",
                      "create table public.ai_chat_plan_leases_x (a int)",
                      "create function public.is_org_member(uuid, text) returns boolean language sql as $$ select true $$"):
                out = s.run(q)
                assert not out.ok and out.sqlstate in ("42501", "42723"), (q, out)


def test_no_api_role_grants_itself_the_lease_table_or_turns_its_rls_off(conn, sc):
    with as_superuser(conn, commit=False):
        for who in (sc.alice.actor, ANON, sec_db.SERVICE):
            with acting(conn, who) as s:
                for q in ("grant select, insert, update, delete on public.ai_chat_plan_leases to authenticated",
                          f"grant select on public.ai_chat_plan_leases to {who.role}",
                          "alter table public.ai_chat_plan_leases disable row level security",
                          "create policy mine on public.ai_chat_plan_leases for all to authenticated using (true) with check (true)",
                          "alter policy ai_chat_plan_leases_author_read on public.ai_chat_plan_leases using (true)",
                          "grant execute on function public.ai_chat_plan_session(uuid) to authenticated",
                          "alter function public.ai_chat_plan_begin(uuid, bigint, integer) security invoker",
                          "alter function public.ai_chat_plan_begin(uuid, bigint, integer) set search_path = pg_temp, public"):
                    out = s.run(q)
                    assert not out.ok and out.sqlstate == "42501", (who.name, q, out)
                out = s.run("select public.ai_chat_plan_session(%s)", [sc.alice.ai_chat_session])
                assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_the_takeover_sweep_finishes_only_the_authors_stale_calls_of_this_conversation(conn, sc):
    with as_superuser(conn, commit=False) as su:
        colleague = _member(su, sc.alice.org, "editor")
        other_of_alice = _session(su, sc.alice)
        colleagues = _session(su, sc.alice, colleague.uid)
        su.rows("update public.ai_chat_plan_leases set state = 'running', started_at = now() - interval '10 minutes', "
                "expires_at = now() - interval '4 minutes' where session_id = %s returning 1", [sc.alice.ai_chat_session])

        def pending(org, uid, session):
            return su.value("insert into public.ai_chat_calls (org_id, user_id, session_id, model, outcome, created_at) "
                            "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'pending', now() - interval '8 minutes') returning id",
                            [org, uid, session])

        mine = pending(sc.alice.org, sc.alice.actor.uid, sc.alice.ai_chat_session)
        untouched = [
            pending(sc.alice.org, sc.alice.actor.uid, other_of_alice),       # her other conversation
            pending(sc.alice.org, colleague.uid, colleagues),               # a colleague's, same workspace
            pending(sc.bob.org, sc.bob.actor.uid, sc.bob.ai_chat_session),  # another tenant's
            pending(sc.alice.org, sc.alice.actor.uid, None),                # hers, in no conversation
        ]
        with acting(conn, sc.alice.actor) as s:
            assert s.run(BEGIN, [sc.alice.ai_chat_session, 41, 0]).ok
            conn.execute("reset role")
            assert su.value("select outcome from public.ai_chat_calls where id = %s", [mine]) == "vendor_error"
            for c in untouched:
                assert su.value("select outcome from public.ai_chat_calls where id = %s", [c]) == "pending", c


def test_the_attempt_counter_at_its_ceiling_fails_closed(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.ai_chat_plan_leases set attempt = 2147483647, state = 'failed', reason = 'vendor_error' "
                "where session_id = %s returning 1", [sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor) as s:
            out = s.run(BEGIN, [sc.alice.ai_chat_session, 41, 0])
            # Never a wrap to 1 (whose request ids were spent) or a negative number: an error, nothing granted.
            assert not out.ok, out
            state = s.value(STATE, [sc.alice.ai_chat_session])
            assert state["attempt"] == 2147483647 and state["state"] == "failed", state
        # The route's own guard: an attempt that is not a positive integer is never handed out.
        assert su.value("select count(*) from public.ai_chat_plan_leases where attempt < 1") == 0


def test_fact_br_s1_08_a_taken_over_plan_cannot_end_its_lease_but_still_writes_the_brief(conn, sc):
    """The database half of BR-S1-08. A plan whose lease ran out and was taken over (a paused or overloaded server, the route's
    DB calls after the plan are not time-bounded and a self-hosted server ignores maxDuration) is refused plan_not_current at its
    END, so 0211 knows it is stale. ai_chat_save_brief does not ask, so its late BRIEF replaces the new plan's. A route fix must
    check the lease itself before it writes (or 0199's save must take the attempt); this pins what the database gives today."""
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.ai_chat_plan_leases set state = 'done' where session_id = %s returning 1", [sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor, commit=True) as s:
            old = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])["attempt"]
        conn.execute("reset role")
        su.rows("update public.ai_chat_plan_leases set started_at = now() - interval '6 minutes', expires_at = now() - interval '1 second' "
                "where session_id = %s returning 1", [sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor, commit=True) as s:
            new = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])["attempt"]
            assert new == old + 1
            assert s.run(SAVE_BRIEF, [sc.alice.ai_chat_session, '{"v": 1, "by": "new", "price": {"state": "priced"}}', "ready"]).ok
            # The old plan, late: its end is refused...
            out = s.run(END, [sc.alice.ai_chat_session, old, "done", None])
            assert not out.ok and out.error == "plan_not_current", out
            # ...and its BRIEF still lands over the new one's.
            assert s.run(SAVE_BRIEF, [sc.alice.ai_chat_session, '{"v": 1, "by": "old", "price": {"state": "unpriced"}}', "ready"]).ok
        conn.execute("reset role")
        assert su.value("select brief ->> 'by' from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session]) == "old"
