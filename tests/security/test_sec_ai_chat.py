"""Named attacks on Nightshift AI's database half (migration 0198).

What would break, and which test says so:
* the plan is the gate: a workspace on a plan without the Brain (free) has a lifetime trial of a few messages, taken once even when
  two tabs race for the last one, and after it cannot start a session or take a turn — never "free unlimited";
* a workspace the owner pilots has Business's cap whatever its plan, and only while it is listed;
* the plan's daily cap is the only brake on the platform's LLM spend: it holds for one workspace (and only that one), refuses
  without writing, and holds when calls race for the last turn;
* a conversation is its author's alone: nobody else reserves a turn on it, finishes its call, records its handoff or reads it —
  not even the operator;
* a handoff records only a film or a channel of the session's own workspace, and closes the conversation;
* the model, the caps and the metering are the owner's: closed tables, owner-only functions.
"""

from __future__ import annotations

import threading

import psycopg
import pytest

from test_sec_series_tables import _dsn
from sec_db import ANON, SERVICE, acting, as_superuser

RESERVE = "select public.ai_chat_reserve_turn(%s, %s)"


def _cap(su, plan: str, n: int | None) -> None:
    if n is None:
        su.rows("delete from public.ai_chat_plan_caps where plan_id = %s returning 1", [plan])
    else:
        su.rows("insert into public.ai_chat_plan_caps (plan_id, per_day) values (%s, %s) "
                "on conflict (plan_id) do update set per_day = excluded.per_day returning 1", [plan, n])


def _plan(su, org: str) -> str:
    return su.value("select public.org_plan_internal(%s)", [org])


def _trial(su, n: int) -> None:
    su.rows("update public.ai_chat_settings set trial_messages = %s where id returning 1", [n])


def _free(su, org: str, on: bool = True) -> None:
    """The workspace on Free (its subscription lapsed), or back on its paid plan."""
    su.rows("update public.subscriptions set status = %s where org_id = %s returning 1", ["canceled" if on else "active", org])
    assert (_plan(su, org) == "free") == on


def test_a_plan_without_the_brain_cannot_start_or_take_a_turn_once_its_trial_is_spent(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), None)
        _trial(su, 0)
        with acting(conn, sc.alice.actor) as s:
            out = s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, sc.alice.channel])
            assert not out.ok and out.sqlstate == "NS402" and out.error == "chat_plan_required", out
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "hello"])
            assert not out.ok and out.error == "chat_plan_required", out
            q = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])
            assert q["limit"] is None and q["trial_left"] == 0, q  # no Brain on this plan: "upgrade", never a 0 read as "used up"


def test_the_trial_is_a_lifetime_count_not_a_daily_one(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _free(su, sc.alice.org)
        _trial(su, 3)
        # The seed's one turn counts; an old turn counts as much as today's (it is the workspace's whole life).
        su.rows("update public.ai_chat_calls set created_at = now() - interval '400 days' where org_id = %s returning 1", [sc.alice.org])
        with acting(conn, sc.alice.actor) as s:
            assert s.value("select public.ai_chat_quota(%s)", [sc.alice.org])["trial_left"] == 2
            assert s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, sc.alice.channel]).ok
            out = s.value(RESERVE, [sc.alice.ai_chat_session, "one"])
            assert out["limit"] is None and out["trial_left"] == 1, out
            assert s.run(RESERVE, [sc.alice.ai_chat_session, "two"]).ok
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "three"])
            assert not out.ok and out.sqlstate == "NS402" and out.error == "chat_plan_required", out
            # Deleting nothing helps: the trial is counted from the metering, which no member can touch.
            assert not s.run("delete from public.ai_chat_calls where org_id = %s", [sc.alice.org]).ok or \
                s.value("select public.ai_chat_quota(%s)", [sc.alice.org])["trial_left"] == 0
            out = s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, sc.alice.channel])
            assert not out.ok and out.error == "chat_plan_required", out
        # A paid plan's daily cap replaces the trial; the trial is not added on top of it.
        _free(su, sc.alice.org, False)
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            q = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])
            assert q["limit"] == 1000 and q["trial_left"] is None, q


def test_the_last_trial_message_is_taken_once_under_a_race(conn, sc):
    dsn = _dsn(conn)  # with the password (conn.info.dsn hides it: every thread failed to connect in CI)
    with as_superuser(conn, commit=True) as su:
        kept = [str(r[0]) for r in su.rows("select id from public.ai_chat_calls where org_id = %s", [sc.bob.org])]
        plan = _plan(su, sc.bob.org)
        had = su.value("select per_day from public.ai_chat_plan_caps where plan_id = %s", [plan])
        had_trial = su.value("select trial_messages from public.ai_chat_settings where id")
        _free(su, sc.bob.org)
        _trial(su, su.value("select count(*) from public.ai_chat_calls where org_id = %s", [sc.bob.org]) + 1)
    results: list = []

    def one():
        with psycopg.connect(dsn, autocommit=False) as c:
            with acting(c, sc.bob.actor, commit=True) as s:
                results.append(s.run(RESERVE, [sc.bob.ai_chat_session, "trial race"]))

    try:
        threads = [threading.Thread(target=one) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sum(r.ok for r in results) == 1, results
        assert all(r.error == "chat_plan_required" for r in results if not r.ok), results
    finally:
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from public.ai_chat_messages where content = 'trial race' returning 1")
            # Only the race's own calls: the seed's row is another test's fixture.
            su.rows("delete from public.ai_chat_calls where org_id = %s and not (id = any(%s::uuid[])) returning 1",
                    [sc.bob.org, kept])
            _free(su, sc.bob.org, False)
            _trial(su, had_trial)


def test_a_piloted_workspace_has_businesss_cap_whatever_its_plan_and_only_while_listed(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), None)
        _trial(su, 0)
        business = su.value("select per_day from public.ai_chat_plan_caps where plan_id = 'studio'")
        assert business == 300
        with acting(conn, sc.operator) as s:
            # The owner's function lists it (the acting block is rolled back, so the row is then placed as the seed would).
            assert s.value("select public.ai_chat_set_pilot(%s, true)", [sc.alice.org]) == {"pilot": True}
            assert str(sc.alice.org) in [str(o) for o in s.value("select public.ai_chat_owner_settings()")["pilots"]]
        su.rows("insert into public.ai_chat_pilot_orgs (org_id) values (%s) returning 1", [sc.alice.org])
        with acting(conn, sc.alice.actor) as s:
            assert s.value("select public.ai_chat_quota(%s)", [sc.alice.org])["limit"] == business
            assert s.run(RESERVE, [sc.alice.ai_chat_session, "pilot"]).ok
            # A member cannot list their own workspace.
            out = s.run("select public.ai_chat_set_pilot(%s, true)", [sc.alice.org])
            assert not out.ok and out.sqlstate == "42501", out
        bobs = su.value("select per_day from public.ai_chat_plan_caps where plan_id = %s", [_plan(su, sc.bob.org)])
        with acting(conn, sc.bob.actor) as s:
            # Another workspace is not piloted by Alice's listing: Bob keeps his own plan's cap.
            assert s.value("select public.ai_chat_quota(%s)", [sc.bob.org])["limit"] == bobs != business
        su.rows("delete from public.ai_chat_pilot_orgs where org_id = %s returning 1", [sc.alice.org])
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "after"])
            assert not out.ok and out.error == "chat_plan_required", out


def test_the_plans_cap_refuses_the_turn_after_the_limit_and_writes_nothing(conn, sc):
    with as_superuser(conn, commit=False) as su:
        used = su.value("select public.ai_chat_used(%s)", [sc.alice.org])
        _cap(su, _plan(su, sc.alice.org), used + 1)
        with acting(conn, sc.alice.actor) as s:
            assert s.run(RESERVE, [sc.alice.ai_chat_session, "one more"]).ok
            before = su.value("select count(*) from public.ai_chat_messages")
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "and another"])
            assert not out.ok and out.sqlstate == "NS429" and out.error == "chat_daily_cap", out
            assert su.value("select count(*) from public.ai_chat_messages") == before
        # Bob's workspace has its own count: Alice's turns are not his.
        _cap(su, _plan(su, sc.bob.org), su.value("select public.ai_chat_used(%s)", [sc.bob.org]) + 1)
        with acting(conn, sc.bob.actor) as s:
            assert s.run(RESERVE, [sc.bob.ai_chat_session, "mine"]).ok


def test_the_last_turn_is_taken_once_under_a_race(conn, sc):
    dsn = _dsn(conn)  # with the password (conn.info.dsn hides it: every thread failed to connect in CI)
    with as_superuser(conn, commit=True) as su:
        kept = [str(r[0]) for r in su.rows("select id from public.ai_chat_calls where org_id = %s", [sc.bob.org])]
        plan = _plan(su, sc.bob.org)
        had = su.value("select per_day from public.ai_chat_plan_caps where plan_id = %s", [plan])
        _cap(su, plan, su.value("select public.ai_chat_used(%s)", [sc.bob.org]) + 1)
    results: list = []

    def one():
        with psycopg.connect(dsn, autocommit=False) as c:
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
            # Only the race's own calls: the seed's row is another test's fixture.
            su.rows("delete from public.ai_chat_calls where org_id = %s and not (id = any(%s::uuid[])) returning 1",
                    [sc.bob.org, kept])
            _cap(su, plan, had)


def test_nobody_else_reserves_finishes_records_or_reads_a_conversation(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            call = s.value(RESERVE, [sc.alice.ai_chat_session, "mine"])["call_id"]
        with acting(conn, sc.bob.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "hijack"])
            assert not out.ok and out.error == "session_not_found", out
            out = s.run("select public.ai_chat_finish_turn(%s, 'ok', 1, 1, 'fake', null, null, null, '{}'::jsonb, null)", [call])
            assert not out.ok and out.error == "call_not_found", out
            out = s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)",
                        [sc.alice.ai_chat_session, '{"kind":"run","channel_id":"%s"}' % sc.alice.channel])
            assert not out.ok and out.error == "session_not_found", out
            assert s.rows("select id from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session]) == []
            assert s.rows("select id from public.ai_chat_messages where session_id = %s", [sc.alice.ai_chat_session]) == []
        with acting(conn, sc.operator) as s:
            # Not even the operator reads a person's conversation.
            assert s.rows("select id from public.ai_chat_messages where session_id = %s", [sc.alice.ai_chat_session]) == []


def test_a_call_is_finished_once_and_its_brief_is_stored(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            call = s.value(RESERVE, [sc.alice.ai_chat_session, "finish me"])["call_id"]
            assert s.run("select public.ai_chat_finish_turn(%s, 'ok', 5, 6, 'answer', null, '{}'::jsonb, 'asking', "
                         "'{\"version\":1,\"kind\":\"short\"}'::jsonb, '{\"slot\":\"style\"}'::jsonb)", [call]).ok
            again = s.run("select public.ai_chat_finish_turn(%s, 'ok', 5, 6, 'twice', null, null, null, null, null)", [call])
            assert not again.ok and again.error == "call_not_found", again
            brief, card = s.rows("select brief, card from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session])[0]
            assert brief == {"version": 1, "kind": "short"} and card == {"slot": "style"}


def test_a_handoff_names_only_the_workspaces_own_and_closes_the_conversation(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            out = s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)",
                        [sc.alice.ai_chat_session, '{"kind":"run","channel_id":"%s"}' % sc.bob.channel])
            assert not out.ok and out.error == "invalid_params", out
            out = s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)",
                        [sc.alice.ai_chat_session, '{"kind":"film","film_id":"00000000-0000-0000-0000-000000000000"}'])
            assert not out.ok and out.error == "invalid_params", out
            out = s.run("select public.ai_chat_record_handoff(%s, '{\"kind\":\"publish\"}'::jsonb)", [sc.alice.ai_chat_session])
            assert not out.ok and out.error == "invalid_params", out
            assert s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)",
                         [sc.alice.ai_chat_session, '{"kind":"run","channel_id":"%s","dispatched_at":"2026-11-21T00:00:00Z"}'
                          % sc.alice.channel]).ok
            assert s.value("select step from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session]) == "created"
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "more?"])
            assert not out.ok and out.error == "session_closed", out


def test_a_session_opens_only_in_ones_own_workspace_for_its_own_channel(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            out = s.run("select public.ai_chat_start(%s, %s)", [sc.bob.org, sc.bob.channel])
            assert not out.ok and out.error == "forbidden", out
            out = s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, sc.bob.channel])
            assert not out.ok and out.error == "channel_not_found", out
            assert s.run("select public.ai_chat_start(%s, null)", [sc.alice.org]).ok  # a short film needs no channel
            out = s.run("select public.ai_chat_quota(%s)", [sc.bob.org])
            assert not out.ok and out.error == "forbidden", out
        with acting(conn, sc.stranger) as s:
            assert not s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, sc.alice.channel]).ok


def test_a_message_too_long_is_refused_before_it_counts(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        before = su.value("select public.ai_chat_used(%s)", [sc.alice.org])
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "x" * 5000])
            assert not out.ok and out.error == "message_too_long", out
        assert su.value("select public.ai_chat_used(%s)", [sc.alice.org]) == before


@pytest.mark.parametrize("q", [
    "insert into public.ai_chat_messages (session_id, created_by, role, content) values (%(s)s, %(u)s, 'assistant', 'forged')",
    "update public.ai_chat_sessions set step = 'proposing' where id = %(s)s",
    "update public.ai_chat_sessions set handoff = '{}'::jsonb where id = %(s)s",
    "select * from public.ai_chat_calls",
    "select * from public.ai_chat_settings",
    "select * from public.ai_chat_plan_caps",
    "update public.ai_chat_plan_caps set per_day = 10000",
])
def test_the_tables_are_written_only_through_the_functions(conn, sc, q):
    with acting(conn, sc.alice.actor) as s:
        out = s.run(q, {"s": sc.alice.ai_chat_session, "u": sc.alice.actor.uid})
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("call", [
    "select public.ai_chat_set_model('anthropic-claude-sonnet-5-5')",
    "select public.ai_chat_set_plan_cap('free', 10000)",
    "select public.ai_chat_set_limits(4000, null, null, null)",
    "select public.ai_chat_set_pilot('00000000-0000-0000-0000-000000000001', true)",
    "select public.ai_chat_owner_settings()",
    "select * from public.ai_chat_usage('2026-01-01', '2026-12-31')",
])
def test_the_model_caps_and_metering_are_the_owners(conn, sc, call):
    with acting(conn, sc.alice.actor) as s:
        out = s.run(call)
    assert not out.ok and out.sqlstate == "42501", out
    for who in (ANON, SERVICE):
        with acting(conn, who) as s:
            assert not s.run(call).ok


def test_the_owner_sets_a_known_text_model_and_reads_no_text(conn, sc):
    with as_superuser(conn, commit=False) as su:
        with acting(conn, sc.operator) as s:
            out = s.run("select public.ai_chat_set_model('not-a-model')")
            assert not out.ok and out.error == "invalid_params", out
            settings = s.value("select public.ai_chat_owner_settings()")
            assert settings["model"] == "anthropic-claude-sonnet-5-5" and settings["caps"].get("free") is None, settings
            rows = s.rows("select * from public.ai_chat_usage(current_date - 1, current_date + 1)")
            assert all(len(r) == 7 for r in rows)


def test_a_retry_takes_a_turn_but_stores_the_message_once(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            s.value(RESERVE, [sc.alice.ai_chat_session, "once"])
            before = s.value("select count(*) from public.ai_chat_messages where session_id = %s", [sc.alice.ai_chat_session])
            used = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])["used"]
            assert s.run("select public.ai_chat_reserve_turn(%s, '', true)", [sc.alice.ai_chat_session]).ok
            assert s.value("select count(*) from public.ai_chat_messages where session_id = %s", [sc.alice.ai_chat_session]) == before
            assert s.value("select public.ai_chat_quota(%s)", [sc.alice.org])["used"] == used + 1
        # Once the last message is answered there is nothing to retry.
        su.rows("insert into public.ai_chat_messages (session_id, created_by, role, content) values (%s, %s, 'assistant', 'answered') returning 1",
                [sc.alice.ai_chat_session, sc.alice.actor.uid])
        with acting(conn, sc.alice.actor) as s:
            out = s.run("select public.ai_chat_reserve_turn(%s, '', true)", [sc.alice.ai_chat_session])
            assert not out.ok and out.error == "nothing_to_retry", out


def test_a_handoff_reads_the_runs_hold_and_the_films_scene_map_from_the_database(conn, sc):
    """The canvas (S6b) gets the run's credit_ref and the film's {brief scene id: film_scenes.id}: both read from the workspace's
    own job and film, never taken from what the browser sent."""
    with as_superuser(conn, commit=False) as su:
        held = su.value("select credit_ref from public.render_jobs where id = %s", [sc.alice.render_job])
        with acting(conn, sc.alice.actor) as s:
            assert s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)", [sc.alice.ai_chat_session,
                         '{"kind":"run","channel_id":"%s","job_id":"%s","credit_ref":"forged"}' % (sc.alice.channel, sc.alice.render_job)]).ok
            h = s.value("select handoff from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session])
        assert h["credit_ref"] == held and held, h
        # Bob's job named on Alice's channel gives no hold.
        su.rows("update public.ai_chat_sessions set step = 'ready', handoff = null where id = %s returning 1", [sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor) as s:
            assert s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)", [sc.alice.ai_chat_session,
                         '{"kind":"run","channel_id":"%s","job_id":"%s"}' % (sc.alice.channel, sc.bob.render_job)]).ok
            h = s.value("select handoff from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session])
        assert "credit_ref" not in h, h

        fid = su.value("insert into public.films (org_id, title, source_kind, language, target_seconds, idempotency_key, request_hash) "
                       "values (%s, 'x', 'topic', 'en', 120, 'brain-map-01', %s) returning id", [sc.alice.org, "0" * 32])
        ids = [su.value("insert into public.film_scenes (film_id, org_id, position, planned_seconds) values (%s, %s, %s, 10) returning id",
                        [fid, sc.alice.org, pos]) for pos in (2, 1)]
        su.rows("update public.ai_chat_sessions set step = 'ready', handoff = null, "
                "brief = '{\"scenes\":[{\"id\":\"s1\"},{\"id\":\"s2\"}]}'::jsonb where id = %s returning 1", [sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor) as s:
            assert s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)", [sc.alice.ai_chat_session,
                         '{"kind":"film","film_id":"%s","scene_map":{"s1":"forged"}}' % fid]).ok
            h = s.value("select handoff from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session])
        # By position, not by insert order: the brief's first scene is the film's position 1.
        assert h["scene_map"] == {"s1": str(ids[1]), "s2": str(ids[0])}, h


def test_the_creator_plan_is_plus_and_gets_plus_cap(conn, sc):
    """plan_id 'creator' is the product's "Plus" (0034's plans; the Command Center names it Plus): 30 turns a day as seeded,
    read from ai_chat_plan_caps, not a number in code."""
    with as_superuser(conn, commit=False) as su:
        assert _plan(su, sc.alice.org) == "creator"  # an active subscription, as the owner's test customer has
        assert su.value("select per_day from public.ai_chat_plan_caps where plan_id = 'creator'") == 30
        with acting(conn, sc.alice.actor) as s:
            q = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])
            assert q["limit"] == 30 and q["trial_left"] is None, q
        assert su.value("select public.ai_chat_cap(%s)", [sc.alice.org]) == 30


def test_a_paid_plan_without_a_cap_row_is_refused_never_free_and_never_unlimited(conn, sc):
    """A plan nobody priced the Brain for (a new plan id with no ai_chat_plan_caps row) is "not on this plan": no Free trial
    handed to it, no unlimited, a named refusal."""
    with as_superuser(conn, commit=False) as su:
        _cap(su, "creator", None)
        _trial(su, 3)
        with acting(conn, sc.alice.actor) as s:
            q = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])
            assert q["limit"] is None and q["trial_left"] == 0, q
            out = s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, sc.alice.channel])
            assert not out.ok and out.sqlstate == "NS402" and out.error == "chat_plan_required", out
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "free turn?"])
            assert not out.ok and out.sqlstate == "NS402" and out.error == "chat_plan_required", out
        # A subscription to a plan id the plans table does not know cannot exist (0034's foreign key): there is no unknown plan
        # to misread.
        out = su.run("update public.subscriptions set plan_id = 'lab_unknown' where org_id = %s", [sc.alice.org])
        assert not out.ok and out.sqlstate == "23503", out
