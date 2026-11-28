"""Breach's attacks on Nightshift AI's database half (migration 0199, working-tree shape after the Brain rewrite), PR #843.

A test that FAILS here is a confirmed hole and stays failing until 0199 (or a follow-up migration) closes it. A passing test pins an
attack that was tried and held, so a later change that reopens it says so by name.

The lab's tenants are on the free plan, which has no Brain: every attack that needs a turn first grants a cap to the plans inside a
rolled-back superuser transaction (_caps), as test_sec_ai_chat.py does.
"""

from __future__ import annotations

import json
import threading
import uuid

import psycopg

from test_sec_series_tables import _dsn
from sec_db import ANON, SERVICE, acting, as_superuser

START = "select public.ai_chat_start(%s, %s)"
RESERVE = "select public.ai_chat_reserve_turn(%s, %s)"
FINISH = "select public.ai_chat_finish_turn(%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s::jsonb, %s::jsonb)"


def _caps(su, n: int) -> None:
    """Every plan gets the Brain with `n` turns a day (rolled back with the caller's transaction unless it commits)."""
    su.rows("insert into public.ai_chat_plan_caps (plan_id, per_day) select id, %s from public.plans "
            "on conflict (plan_id) do update set per_day = excluded.per_day returning 1", [n])


def _settings(su, **kv) -> None:
    for k, v in kv.items():
        su.rows(f"update public.ai_chat_settings set {k} = %s where id returning 1", [v])


def _user_used(su, uid: str) -> int:
    return su.value("select count(*) from public.ai_chat_calls where user_id = %s and created_at > now() - interval '24 hours'", [uid])


def _sybil_orgs(s, n: int) -> list[tuple[str, str]]:
    """What any signed-up account may do: create a workspace (0018, up to ten) and a draft channel in it (create_channel)."""
    out = []
    for i in range(n):
        org = s.value("select public.create_organization(%s)", [f"Sybil {i} {uuid.uuid4().hex[:6]}"])
        ch = f"sybil-{uuid.uuid4().hex[:10]}"
        made = s.run("select public.create_channel(%s, %s, %s)", [ch, org, f"Sybil {i}"])
        assert made.ok, made
        out.append((str(org), ch))
    return out


# ── 1. Cap bypass / platform spend ─────────────────────────────────────────────────────────────────────────────────────────────


def test_one_account_with_many_workspaces_is_held_to_the_per_user_cap(conn, sc):
    """Was finding 1 (one account, three self-made workspaces, three caps). Each workspace still brings its own plan cap; the
    per-user cap (ai_chat_settings.per_user_daily) must bound the account across all of them."""
    with as_superuser(conn, commit=False) as su:
        _caps(su, 5)
        _settings(su, per_user_daily=_user_used(su, sc.stranger.uid) + 2)
        granted = 0
        with acting(conn, sc.stranger) as s:
            for org, ch in _sybil_orgs(s, 3):
                sid = s.value(START, [org, ch])
                for _ in range(3):
                    out = s.run(RESERVE, [sid, "plan a video"])
                    if out.ok:
                        granted += 1
                    else:
                        assert out.error == "chat_daily_cap", out
        assert granted == 2, f"one account reserved {granted} vendor turns with per_user_daily = 2"


def test_the_per_user_cap_holds_when_two_workspaces_race_for_the_last_turn(conn, sc):
    """Alice, an editor of her own workspace and (for this test) of Bob's, races one turn in each: the two take DIFFERENT
    workspace locks, so only the per-user lock stands between her and one turn over her own cap."""
    dsn = _dsn(conn)  # with the password (conn.info.dsn hides it: every thread failed to connect in CI)
    with as_superuser(conn, commit=True) as su:
        had_caps = su.rows("select plan_id, per_day from public.ai_chat_plan_caps")
        had_user = su.value("select per_user_daily from public.ai_chat_settings where id")
        _caps(su, 50)
        _settings(su, per_user_daily=_user_used(su, sc.alice.actor.uid) + 1)
        su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'editor') returning 1",
                [sc.bob.org, sc.alice.actor.uid, sc.alice.actor.email])
    second = None
    try:
        with acting(conn, sc.alice.actor, commit=True) as s:
            second = str(s.value(START, [sc.bob.org, None]))
        results: list = []

        def one(sid: str) -> None:
            with psycopg.connect(dsn, autocommit=False) as c:
                with acting(c, sc.alice.actor, commit=True) as s:
                    results.append(s.run(RESERVE, [sid, "race-across"]))

        threads = [threading.Thread(target=one, args=(sid,)) for sid in (sc.alice.ai_chat_session, second) * 2]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sum(r.ok for r in results) == 1, results
        assert all(r.error == "chat_daily_cap" for r in results if not r.ok), results
    finally:
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from public.ai_chat_messages where content = 'race-across' returning 1")
            su.rows("delete from public.ai_chat_calls where user_id = %s and created_at > now() - interval '5 minutes' returning 1",
                    [sc.alice.actor.uid])
            if second:
                su.rows("delete from public.ai_chat_sessions where id = %s returning 1", [second])
            su.rows("delete from public.org_members where org_id = %s and user_id = %s returning 1", [sc.bob.org, sc.alice.actor.uid])
            su.rows("delete from public.ai_chat_plan_caps returning 1")
            for plan, n in had_caps:
                su.rows("insert into public.ai_chat_plan_caps (plan_id, per_day) values (%s, %s) returning 1", [plan, n])
            _settings(su, per_user_daily=had_user)


def test_the_platform_wide_cap_refuses_every_workspace_once_reached(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        _settings(su, global_daily=su.value("select count(*) from public.ai_chat_calls where created_at > now() - interval '24 hours'") + 1)
        with acting(conn, sc.alice.actor, commit=True) as s:  # kept until the outer rollback, so Bob's turn sees it
            assert s.run(RESERVE, [sc.alice.ai_chat_session, "the last one"]).ok
        su.run("reset role")
        with acting(conn, sc.bob.actor) as s:
            out = s.run(RESERVE, [sc.bob.ai_chat_session, "too late"])
            assert not out.ok and out.sqlstate == "NS503" and out.error == "chat_unavailable", out


def test_new_conversations_a_day_are_capped_per_person(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        n = su.value("select count(*) from public.ai_chat_sessions where created_by = %s and created_at > now() - interval '24 hours'",
                     [sc.alice.actor.uid])
        _settings(su, sessions_per_user_daily=n + 1)
        with acting(conn, sc.alice.actor) as s:
            assert s.run(START, [sc.alice.org, sc.alice.channel]).ok
            out = s.run(START, [sc.alice.org, None])
            assert not out.ok and out.error == "chat_daily_cap", out


def test_a_free_workspace_gets_no_turn_even_on_an_old_session(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("delete from public.ai_chat_plan_caps where plan_id = public.org_plan_internal(%s) returning 1", [sc.alice.org])
        su.rows("update public.ai_chat_settings set trial_messages = 0 where id returning 1")  # its lifetime trial spent
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "free turn?"])
            assert not out.ok and out.sqlstate == "NS402", out


def test_a_viewer_and_a_demoted_editor_spend_no_turns(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        org = su.value("select public.default_org_id()")
        ch = su.value("select channel_id from public.channels where org_id = %s limit 1", [org])
        with acting(conn, sc.dana) as s:  # a viewer of the operator's (credits-exempt) workspace
            out = s.run(START, [org, ch])
            assert not out.ok and out.error == "forbidden", out
        su.run("reset role")
        su.rows("update public.org_members set role = 'viewer' where org_id = %s and user_id = %s returning 1",
                [sc.alice.org, sc.alice.actor.uid])
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "still an editor?"])
            assert not out.ok and out.error == "session_not_found", out


def test_a_removed_member_reserves_nothing_on_an_old_session(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        su.rows("delete from public.org_members where org_id = %s and user_id = %s returning 1", [sc.alice.org, sc.alice.actor.uid])
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "still here?"])
            assert not out.ok and out.error == "session_not_found", out
            assert s.rows("select id from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session]) == []
            assert not s.run("select public.ai_chat_quota(%s)", [sc.alice.org]).ok


def test_anon_service_and_a_pending_invitee_cannot_start_or_reserve(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        for who in (ANON, SERVICE):
            with acting(conn, who) as s:
                assert not s.run(START, [sc.alice.org, sc.alice.channel]).ok
                assert not s.run(RESERVE, [sc.alice.ai_chat_session, "x"]).ok
        with acting(conn, sc.invitee) as s:
            out = s.run(START, [sc.alice.org, sc.alice.channel])
            assert not out.ok and out.error == "forbidden", out


def test_null_blank_and_oversized_text_never_count(conn, sc):
    """Was finding 4 (tabs and newlines took a turn): now trimmed like spaces."""
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        before = su.value("select public.ai_chat_used(%s)", [sc.alice.org])
        with acting(conn, sc.alice.actor) as s:
            for t in (None, "    ", " \n\t\r\n ", "\f\x0b", "y" * 2001, "z" * 1_000_000):
                out = s.run(RESERVE, [sc.alice.ai_chat_session, t])
                assert not out.ok and out.error in ("invalid_params", "message_too_long"), (repr(t[:8] if t else t), out)
            assert not s.run(RESERVE, [None, "x"]).ok
            assert not s.run(RESERVE, [str(uuid.uuid4()), "x"]).ok
        su.run("reset role")
        assert su.value("select public.ai_chat_used(%s)", [sc.alice.org]) == before


def test_a_second_session_shares_the_workspace_cap(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, su.value("select public.ai_chat_used(%s)", [sc.alice.org]) + 1)
        with acting(conn, sc.alice.actor) as s:
            other = s.value(START, [sc.alice.org, None])
            assert s.run(RESERVE, [other, "first"]).ok
            out = s.run(RESERVE, [sc.alice.ai_chat_session, "second"])
            assert not out.ok and out.error == "chat_daily_cap", out


# ── 2. Cross-person / forged metering ───────────────────────────────────────────────────────────────────────────────────────────


def test_finish_turn_cannot_write_into_someone_elses_conversation(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        with acting(conn, sc.bob.actor) as s:
            call = s.value(RESERVE, [sc.bob.ai_chat_session, "mine"])["call_id"]
            aim = json.dumps({"session_id": sc.alice.ai_chat_session})
            assert s.run(FINISH, [call, "ok", 1, 1, "forged", aim, "{}", "proposing", aim, None]).ok
        su.run("reset role")
        assert su.value("select count(*) from public.ai_chat_messages where session_id = %s and content = 'forged'",
                        [sc.alice.ai_chat_session]) == 0
        assert su.value("select brief from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session]) == {}


def test_brief_and_handoff_cannot_reach_another_persons_session_or_workspace(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        with acting(conn, sc.bob.actor) as s:
            out = s.run("select public.ai_chat_save_brief(%s, '{\"x\":1}'::jsonb, 'ready')", [sc.alice.ai_chat_session])
            assert not out.ok and out.error == "session_not_found", out
            out = s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)",
                        [sc.alice.ai_chat_session, json.dumps({"kind": "run", "channel_id": sc.alice.channel})])
            assert not out.ok and out.error == "session_not_found", out
            # His own session, Alice's channel or a made-up film: refused.
            for h in ({"kind": "run", "channel_id": sc.alice.channel}, {"kind": "film", "film_id": str(uuid.uuid4())}, {"kind": "publish"}):
                out = s.run("select public.ai_chat_record_handoff(%s, %s::jsonb)", [sc.bob.ai_chat_session, json.dumps(h)])
                assert not out.ok and out.error == "invalid_params", (h, out)
            out = s.run("select public.ai_chat_save_brief(%s, '{}'::jsonb, 'created')", [sc.bob.ai_chat_session])
            assert not out.ok and out.error == "invalid_params", out


def test_a_null_or_unknown_outcome_is_refused(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        with acting(conn, sc.alice.actor) as s:
            call = s.value(RESERVE, [sc.alice.ai_chat_session, "null outcome"])["call_id"]
            for o in (None, "pending", "OK"):
                out = s.run(FINISH, [call, o, 1, 1, "x", None, None, None, None, None])
                assert not out.ok and out.error == "invalid_params", (o, out)


def test_a_token_count_the_vendor_did_not_report_is_stored_as_unknown_not_zero(conn, sc):
    """Was finding 3 (GREATEST turned NULL into 0)."""
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        with acting(conn, sc.alice.actor, commit=True) as s:
            call = s.value(RESERVE, [sc.alice.ai_chat_session, "timeout"])["call_id"]
            assert s.run(FINISH, [call, "vendor_error", None, None, None, None, None, None, None, None]).ok
        su.run("reset role")
        assert su.rows("select tokens_in, tokens_out from public.ai_chat_calls where id = %s", [call])[0] == (None, None)


def test_a_person_finishing_their_own_call_is_held_to_the_per_turn_token_bound(conn, sc):
    """Was finding 2. RESIDUAL, accepted and documented: the author's JWT can still finish a call it reserved straight through
    PostgREST (no vendor call) as 'ok' with tokens of its choosing. What is pinned here is the bound: never above 1,000,000 in /
    100,000 out per turn and never negative, so one forged turn cannot dwarf the owner's real usage."""
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        with acting(conn, sc.alice.actor, commit=True) as s:
            big = s.value(RESERVE, [sc.alice.ai_chat_session, "fake big"])["call_id"]
            assert s.run(FINISH, [big, "ok", 2_147_483_647, 2_147_483_647, "x", None, None, None, None, None]).ok
            neg = s.value(RESERVE, [sc.alice.ai_chat_session, "fake negative"])["call_id"]
            assert s.run(FINISH, [neg, "ok", -5, -7, "x", None, None, None, None, None]).ok
        su.run("reset role")
        assert su.rows("select tokens_in, tokens_out from public.ai_chat_calls where id = %s", [big])[0] == (1_000_000, 100_000)
        assert su.rows("select tokens_in, tokens_out from public.ai_chat_calls where id = %s", [neg])[0] == (0, 0)


def test_forged_brief_card_and_payload_are_size_bounded(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _caps(su, 100)
        with acting(conn, sc.alice.actor) as s:
            call = s.value(RESERVE, [sc.alice.ai_chat_session, "bloat"])["call_id"]
            huge = json.dumps({"x": "a" * 300_000})
            assert not s.run(FINISH, [call, "ok", 1, 1, "x", huge, None, None, None, None]).ok
            assert not s.run(FINISH, [call, "ok", 1, 1, "x", None, None, None, huge, None]).ok
            assert not s.run(FINISH, [call, "ok", 1, 1, "x", None, None, None, None, json.dumps({"x": "a" * 9000})]).ok
            assert not s.run("select public.ai_chat_save_brief(%s, %s::jsonb, 'ready')", [sc.alice.ai_chat_session, huge]).ok


# ── 4. Leakage ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_quota_names_no_other_workspace_and_no_cost(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        q = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])
        # 0232 adds what this workspace's own running storyboard plans hold, and until when: still nothing of another workspace's.
        assert set(q) <= {"used", "limit", "trial_left", "max_input_chars", "model_ref", "reserved", "reserved_until"}, q
        assert not s.run("select public.ai_chat_quota(%s)", [sc.bob.org]).ok
        assert not s.run("select public.ai_chat_used(%s)", [sc.bob.org]).ok
        assert not s.run("select public.ai_chat_cap(%s)", [sc.bob.org]).ok
        assert not s.run("select public.ai_chat_owner_settings()").ok
        assert not s.run("select public.ai_chat_set_limits(4000, 100000, 1000000, 10000)").ok
        assert not s.run("select public.ai_chat_set_plan_cap('free', 10000)").ok
    with acting(conn, sc.stranger) as s:
        assert not s.run("select public.ai_chat_quota(%s)", [sc.alice.org]).ok
