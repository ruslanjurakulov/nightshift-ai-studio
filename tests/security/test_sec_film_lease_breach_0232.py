"""Breach on migration 0232 (per-film storyboard plan lease, turns reserved at begin).

BR-LEASE-01/02/03 were holes, fixed in 0232's own fix round (Sentinel's list): they pass now and must stay passing. The PROBE tests pin attacks that were tried and held, so a later
change that reopens them fails here too.

Everything runs in one rolled-back transaction of the security lab (sec_db), acting as each caller by role and request.jwt.claims.
"""

from __future__ import annotations

import pytest

import sec_db
from test_sec_film_lease_0232 import (  # noqa: F401  (w is a fixture)
    FILM_BEGIN, PLAN_BEGIN, PLAN_END, as_, become, conversation, film, lease_row, plan, refusal, reserved, room, turn, used, w,
)


def calls_by(su, uid) -> int:
    become(su, None)
    return su.value("select count(*)::integer from public.ai_chat_calls where user_id = %s", [uid])


def attempt_of(su, sid) -> int:
    become(su, None)
    return su.value("select attempt from public.ai_chat_plan_leases where session_id = %s", [sid])


# ── holes ─────────────────────────────────────────────────────────────────────

def test_BR_LEASE_01_an_archived_film_takes_a_lease_and_reserves_the_workspaces_turns(w):
    """No storyboard can be written into an archived film (save_film refuses it, both routes refuse it before any turn), yet
    ai_chat_film_plan_begin reserves turns for it: the predicate "a film this plan could write" is only in the app, so a direct RPC
    holds the workspace's turns for a film nothing will ever plan."""
    s = w.su
    a = conversation(s, w.alice, w.org)
    room(s, w.org, 5)
    out = as_(s, w.alice, "select public.archive_film(%s)", [w.film_b])
    assert out.ok, out
    _, begun = plan(s, w.alice, a, w.film_b, 5)
    assert not begun.ok, ("an archived film was leased and its turns reserved", begun, reserved(s, w.org))


def test_BR_LEASE_02_a_member_removed_from_the_workspace_keeps_its_turns_reserved_and_cannot_give_them_back(w):
    """The colleague is removed (or demoted to viewer) while their plan holds the workspace's whole remaining cap. Their reservation
    keeps counting as used for the rest of its 320 s, the workspace's remaining editors are refused chat_daily_cap, and nobody can
    release it: plan_end refuses the removed person (session_not_found), and no admin path ends another's lease."""
    s = w.su
    planner = conversation(s, w.colleague, w.org)
    chatter = conversation(s, w.alice, w.org)
    room(s, w.org, 6)
    attempt, begun = plan(s, w.colleague, planner, w.film_b, 6)
    assert begun.ok, begun
    become(s, None)
    s.rows("delete from public.org_members where org_id = %s and user_id = %s returning 1", [w.org, w.colleague.uid])
    # The removed person can no longer end it.
    end = as_(s, w.colleague, PLAN_END, [planner, attempt, "failed", "unavailable"])
    assert not end.ok, end
    # The owner's chat in her own workspace is blocked by a non-member's reservation.
    out = turn(s, w.alice, chatter, "hello")
    assert out.ok, ("a removed member's live reservation still blocks the workspace", out, reserved(s, w.org))


def test_BR_LEASE_03_a_reservation_is_never_more_than_the_films_own_worst_case(w):
    """p_at_most was the caller's number (1..500), not the plan's: a direct RPC asked the whole day's cap for a 60 s film, and every
    colleague was refused chat_daily_cap for as long as the begin-end loop ran, without one turn spent. Fixed: the database bounds it
    by the film (ai_chat_film_plan_max_turns(target_seconds), 7 for 60 s) and refuses a bigger number; it never cuts it down."""
    s = w.su
    hog = conversation(s, w.colleague, w.org)
    chatter = conversation(s, w.alice, w.org)
    room(s, w.org, 30)  # a creator plan's whole day
    _, begun = plan(s, w.colleague, hog, w.film_b, 30)
    # Named (round 3): the film's own bound, said with its number, never a generic invalid_params 400.
    assert not begun.ok and (begun.sqlstate, begun.error) == ("NS409", "plan_too_long"), begun
    assert reserved(s, w.org) == 0
    out = as_(s, w.colleague, FILM_BEGIN, [hog, w.film_b, 7])
    assert out.ok and out.rows[0][0]["reserved"] == 7, out
    assert turn(s, w.alice, chatter, "hello").ok


# ── probes that held ─────────────────────────────────────────────────────────

def test_PROBE_a_lease_that_expired_before_the_sweep_neither_takes_a_turn_nor_counts(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    cap = room(s, w.org, 4)
    _, begun = plan(s, w.alice, a, w.film_a, 4)
    assert begun.ok
    s.rows("update public.ai_chat_film_plan_leases set expires_at = now() - interval '1 second' where film_id = %s returning 1",
           [w.film_a])
    assert reserved(s, w.org) == 0
    for _ in range(4):
        assert turn(s, w.alice, a, "x").ok
    out = turn(s, w.alice, a, "x")
    assert not out.ok and out.error == "chat_daily_cap", out
    assert lease_row(s, w.film_a)[2] == 0  # nothing taken out of a dead lease
    assert used(s, w.org) == cap


def test_PROBE_beginning_again_with_a_bigger_number_reserves_nothing_more(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    room(s, w.org, 10)
    _, begun = plan(s, w.alice, a, w.film_a, 2)
    assert begun.ok
    again = as_(s, w.alice, FILM_BEGIN, [a, w.film_a, 500])
    assert again.ok and again.rows[0][0]["reserved"] == 2
    assert reserved(s, w.org) == 2


def test_PROBE_a_new_attempt_supersedes_the_old_lease_and_the_cap_still_holds(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    room(s, w.org, 5)
    attempt, begun = plan(s, w.alice, a, w.film_a, 5)
    assert begun.ok
    # Kill the 0211 lease only (the film lease shares its expiry in reality; here the film lease is left "running" on purpose).
    s.rows("update public.ai_chat_plan_leases set expires_at = now() - interval '1 second' where session_id = %s returning 1", [a])
    _, second = plan(s, w.alice, a, w.film_b, 5)
    assert second.ok, second
    assert lease_row(s, w.film_a)[4:6] == ("failed", "superseded")
    assert reserved(s, w.org) == 5


def test_PROBE_a_colleague_cannot_take_or_end_anothers_film_lease(w):
    s = w.su
    mine = conversation(s, w.alice, w.org)
    attempt, begun = plan(s, w.alice, mine, w.film_a, 3)
    assert begun.ok
    for q, p in ((FILM_BEGIN, [mine, w.film_a, 3]), (PLAN_END, [mine, attempt, "done", None]),
                 ("select public.ai_chat_reserve_turn(%s, 'x', false, null)", [mine])):
        out = as_(s, w.colleague, q, p)
        assert not out.ok and out.error == "session_not_found", (q, out)
    assert lease_row(s, w.film_a)[4] == "running" and reserved(s, w.org) == 3


def test_PROBE_another_tenant_cannot_lease_or_read_counts_of_this_workspace(w):
    s = w.su
    bob = w.sc.bob
    sid = bob.ai_chat_session
    assert as_(s, bob.actor, PLAN_BEGIN, [sid]).ok
    out = as_(s, bob.actor, FILM_BEGIN, [sid, w.film_a, 1])
    assert not out.ok and out.error == "film_not_found", out
    for q, p in (("select public.ai_chat_quota(%s)", [w.org]),):
        out = as_(s, bob.actor, q, p)
        assert not out.ok, out
    for who in (sec_db.ANON,):
        out = as_(s, who, "select public.ai_chat_film_plan_begin(%s, %s, 1)", [sid, w.film_a])
        assert not out.ok and out.sqlstate == "42501", out


def test_PROBE_forged_claims_without_the_authenticated_role_begin_nothing(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    assert as_(s, w.alice, PLAN_BEGIN, [a]).ok
    become(s, sec_db.ANON)
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", ['{"sub": "%s", "role": "authenticated"}' % w.alice.uid])
    out = s.run(FILM_BEGIN, [a, w.film_a, 1])
    become(s, None)
    assert not out.ok and out.sqlstate == "42501", out
