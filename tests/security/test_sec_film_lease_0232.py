"""Migration 0232: one storyboard plan per film, and its turns reserved when it begins (ai_chat_film_plan_begin; ai_chat_quota,
ai_chat_reserve_turn and ai_chat_plan_end replaced; ai_chat_used and ai_chat_trial_left stay 0199's: "used" means charged).

Breach on #953 (tests/security/test_sec_brain_film_breach.py, command-center/tests/security-brain-film-breach.test.ts) found that
nothing in the database ties a plan to a FILM (BR-FILM-01/02: 0211's lease is per conversation) and that the up-front cap check
reserves nothing (BR-FILM-03: two plans at the cap both start, the second stops halfway). These pin what closes both:

* two films of one workspace at the cap: exactly one plan starts; the other is told `chat_reserved` (with when) if it would fit
  once the first plan's hold ends, `plan_over_cap` with the real `left` if not;
* a plan's reserved turns block ordinary chat turns past the cap, a plan cannot begin over turns chat already took, and the plan's
  own turns are counted once (out of the reservation), never on top;
* a plan whose server died gives its unused turns back when its lease expires, the turns it took stay taken, and the next begin's
  sweep records it and closes its pending calls as failures;
* the chat's draft and the film editor's button on one film: one plan wins, the other is told `plan_running`, one reservation;
* a viewer, another tenant and a seatless platform admin begin nothing and reserve nothing; a member removed or demoted mid-plan
  holds nothing;
* a reservation is never more than the film's own worst case, nor for a film no plan could write into;
* a hold is reported as reserved (with when it ends), never as used, and a turn that only finds the rest held is told chat_reserved;
* 0232 refuses a database whose bodies are 0211's (0226 not on), replays onto itself, and its rollback puts the earlier bodies back.
"""

from __future__ import annotations

import difflib
import json
import re
import uuid

import psycopg
import pytest
from psycopg import sql

import sec_db
import sec_film_lease_0232 as lease
import test_sec_series_tables as st
from sec_db import as_superuser, user
from sec_films_0166 import FILM

MIGRATION = sec_db.MIGRATION_0232
ROLLBACK = sec_db.ROLLBACK_0232

PLAN_BEGIN = "select public.ai_chat_plan_begin(%s, 0, 0)"
FILM_BEGIN = "select public.ai_chat_film_plan_begin(%s, %s, %s)"
PLAN_END = "select public.ai_chat_plan_end(%s, %s, %s, %s)"
TURN = "select public.ai_chat_reserve_turn(%s, %s, %s, %s)"


# ── one rolled-back transaction, acting as each caller in turn ──────────────────

def become(s, who):
    s.conn.execute("reset role")
    if who is None:
        s.conn.execute("select set_config('request.jwt.claims', '', true)")
        return s
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def as_(s, who, q, p=None):
    become(s, who)
    out = s.run(q, p)
    become(s, None)
    return out


def refusal(s, who, q, p):
    """(message, detail) of a refused call, or None when it was not refused. The detail carries plan_over_cap's real numbers."""
    become(s, who)
    try:
        with s.conn.transaction():
            s.conn.execute(q, p)
        return None
    except psycopg.Error as e:
        return (e.diag.message_primary, e.diag.message_detail)
    finally:
        become(s, None)


@pytest.fixture()
def w(conn, sc):
    """Alice's workspace, with the person's and the platform's limits out of the way (the workspace's cap is the question), an
    editor colleague, a viewer, and a second film of hers."""
    with as_superuser(conn, commit=False) as su:
        x = type("W", (), {})()
        x.su, x.sc, x.org, x.alice = su, sc, sc.alice.org, sc.alice.actor
        su.rows("update public.ai_chat_settings set per_user_daily = 100000, global_daily = 1000000, "
                "sessions_per_user_daily = 10000 where id returning 1")
        room(su, x.org, 1000)
        x.colleague = member(su, x.org, "editor")
        x.viewer = member(su, x.org, "viewer")
        # Two empty drafts of hers (the seeded FILM["a"] has scenes: no plan may write into it, film_not_plannable).
        x.film_a = film(su, x.alice, x.org, 180)
        x.film_b = film(su, x.alice, x.org, 60)
        yield x


def member(su, org, role):
    who = user(f"lease-{role}", f"lease-{role}-{uuid.uuid4().hex[:6]}@lease0232.lab")
    su.rows("insert into auth.users (id, email) values (%s, %s) returning 1", [who.uid, who.email])
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
            [org, who.uid, who.email, role])
    return who


def staff(su):
    """A platform admin on the roster with no seat anywhere: an admin of every workspace by 0043, a spender of none (0226)."""
    who = user("lease-staff", f"lease-staff-{uuid.uuid4().hex[:6]}@nightshift.test")
    su.rows("insert into auth.users (id, email) values (%s, %s) returning 1", [who.uid, who.email])
    su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [who.uid, who.email])
    return who


def used(su, org) -> int:
    """The workspace's CHARGED turns (0199's ai_chat_used, unchanged by 0232): never what plans only hold."""
    become(su, None)
    return su.value("select public.ai_chat_used(%s)", [org])


def reserved(su, org) -> int:
    become(su, None)
    return su.value("select public.ai_chat_reserved(%s)", [org])


def room(su, org, n: int) -> int:
    """The workspace's plan given a daily cap of what is used now plus n. Returns the cap."""
    become(su, None)
    cap = used(su, org) + n
    plan = su.value("select public.org_plan_internal(%s)", [org])
    su.rows("insert into public.ai_chat_plan_caps (plan_id, per_day) values (%s, %s) "
            "on conflict (plan_id) do update set per_day = excluded.per_day returning 1", [plan, cap])
    return cap


def film(su, who, org, seconds=60):
    out = as_(su, who, "select public.create_film_draft(%s, null, 'topic', 'A film to plan', %s::jsonb, %s)",
              [org, json.dumps({"title": "To plan", "language": "en", "target_seconds": seconds}), f"lease0232-{uuid.uuid4().hex[:8]}"])
    assert out.ok, out
    return out.rows[0][0]["film"]["id"]


def conversation(su, who, org) -> str:
    out = as_(su, who, "select public.ai_chat_start(%s, null)", [org])
    assert out.ok, out
    return str(out.rows[0][0])


def plan(su, who, sid, film_id, at_most):
    """What both routes do before a plan's first turn: 0211's lease, then the film's. Returns (attempt, film begin's outcome)."""
    began = as_(su, who, PLAN_BEGIN, [sid])
    assert began.ok, began
    return began.rows[0][0]["attempt"], as_(su, who, FILM_BEGIN, [sid, film_id, at_most])


def turn(su, who, sid, text="go", retry=False):
    return as_(su, who, TURN, [sid, "" if retry else text, retry, None])


def first_expiry(su, film_id) -> str:
    become(su, None)
    return su.value("""select to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from public.ai_chat_film_plan_leases """
                    "where film_id = %s", [film_id])


def free_with_trial(su, org, left: int) -> None:
    """The workspace on Free (its subscription lapsed) with `left` trial messages still to take in its whole life."""
    import test_sec_ai_chat as chat

    chat._free(su, org)
    calls = su.value("select count(*)::integer from public.ai_chat_calls where org_id = %s", [org])
    chat._trial(su, calls + left)


def lease_row(su, film_id):
    become(su, None)
    rows = su.rows("select session_id::text, reserved, taken, released, state, reason from public.ai_chat_film_plan_leases "
                   "where film_id = %s", [film_id])
    return rows[0] if rows else None


# ── two projects at the cap ──────────────────────────────────────────────────────

def test_two_films_at_the_cap_exactly_one_plan_starts_and_the_other_is_told_what_is_left(w):
    s = w.su
    a, b = conversation(s, w.alice, w.org), conversation(s, w.alice, w.org)
    room(s, w.org, 7)  # one plan of 5 fits, two do not
    _, first = plan(s, w.alice, a, w.film_a, 5)
    assert first.ok, first
    assert first.rows[0][0]["reserved"] == 5 and first.rows[0][0]["left"] == 2 and first.rows[0][0]["scope"] == "workspace", first
    before = (used(s, w.org), reserved(s, w.org))
    _, second = plan(s, w.alice, b, w.film_b, 5)
    # Two left now, and it would fit once the first plan's hold ends: a wait of minutes, said with when (Lens on 0232, rule 6).
    assert not second.ok and second.error == "chat_reserved" and second.sqlstate == "NS429", second
    assert refusal(s, w.alice, FILM_BEGIN, [b, w.film_b, 5]) == (
        "chat_reserved", f"used={before[0]} reserved=5 limit={before[0] + 7} until={first_expiry(s, w.film_a)} scope=workspace")
    # Refused before anything was written: no lease on the second film, nothing more reserved.
    assert lease_row(s, w.film_b) is None
    assert (used(s, w.org), reserved(s, w.org)) == before


def test_the_same_plan_asking_again_reserves_nothing_twice(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    room(s, w.org, 7)
    _, first = plan(s, w.alice, a, w.film_a, 5)
    assert first.ok, first
    again = as_(s, w.alice, FILM_BEGIN, [a, w.film_a, 5])
    assert again.ok and again.rows[0][0]["reserved"] == 5, again
    assert reserved(s, w.org) == 5


# ── chat turns and a plan at the cap ──────────────────────────────────────────────

def test_a_plans_reservation_blocks_other_chat_turns_past_the_cap_and_its_own_turns_count_once(w):
    s = w.su
    planner, chatter = conversation(s, w.alice, w.org), conversation(s, w.colleague, w.org)
    cap = room(s, w.org, 5)
    attempt, begun = plan(s, w.alice, planner, w.film_a, 5)
    assert begun.ok, begun
    # Held, not used: the charged count does not move at begin.
    assert used(s, w.org) == cap - 5 and reserved(s, w.org) == 5
    # Another conversation's turn finds the rest held: chat_reserved with the real numbers and when the hold ends, not the daily cap.
    out = turn(s, w.colleague, chatter, "hello")
    assert not out.ok and out.error == "chat_reserved" and out.sqlstate == "NS429", out
    until = first_expiry(s, w.film_a)
    assert refusal(s, w.colleague, TURN, [chatter, "hello", False, None]) == (
        "chat_reserved", f"used={cap - 5} reserved=5 limit={cap} until={until} scope=workspace")
    # The plan's own turn is one of the five: it passes, counted once (one fewer held, one more charged).
    mine = turn(s, w.alice, planner, "plan it")
    assert mine.ok and mine.rows[0][0]["used"] == cap - 4 and mine.rows[0][0]["reserved"] == 4, mine
    assert used(s, w.org) == cap - 4 and reserved(s, w.org) == 4
    # The plan ends after one turn: the four it did not take come back at once, and the colleague's turn goes through.
    assert as_(s, w.alice, PLAN_END, [planner, attempt, "done", None]).ok
    row = lease_row(s, w.film_a)
    assert row[1:5] == (5, 1, 4, "done"), row
    assert reserved(s, w.org) == 0 and used(s, w.org) == cap - 4
    assert turn(s, w.colleague, chatter, "hello").ok


def test_a_plan_cannot_begin_over_turns_chat_already_took(w):
    s = w.su
    planner, chatter = conversation(s, w.alice, w.org), conversation(s, w.colleague, w.org)
    room(s, w.org, 3)
    assert turn(s, w.colleague, chatter, "hello").ok
    _, begun = plan(s, w.alice, planner, w.film_a, 3)
    assert not begun.ok and begun.error == "plan_over_cap", begun
    assert refusal(s, w.alice, FILM_BEGIN, [planner, w.film_a, 3]) == ("plan_over_cap", "left=2 needed=3 scope=workspace")
    # Nothing written, nothing reserved.
    assert lease_row(s, w.film_a) is None and reserved(s, w.org) == 0


def test_the_persons_own_limit_is_reserved_too(w):
    s = w.su
    a, b = conversation(s, w.alice, w.org), conversation(s, w.alice, w.org)
    mine = s.value("select count(*)::integer from public.ai_chat_calls where user_id = %s and created_at > now() - interval '24 hours'",
                   [w.alice.uid])
    s.rows("update public.ai_chat_settings set per_user_daily = %s where id returning 1", [mine + 6])
    _, first = plan(s, w.alice, a, w.film_a, 4)
    assert first.ok and first.rows[0][0]["scope"] == "person" and first.rows[0][0]["left"] == 2, first
    # A second plan of hers finds the four held: two left of her own six, whatever the workspace's cap says. Four fits once the
    # first hold ends (a wait: chat_reserved, scope person); seven does not even then (plan_over_cap, scope person).
    assert as_(s, w.alice, PLAN_BEGIN, [b]).ok
    message, detail = refusal(s, w.alice, FILM_BEGIN, [b, w.film_b, 4])
    assert message == "chat_reserved" and detail == f"used={mine} reserved=4 limit={mine + 6} until={first_expiry(s, w.film_a)} scope=person", detail
    assert refusal(s, w.alice, FILM_BEGIN, [b, w.film_b, 7]) == ("plan_over_cap", "left=2 needed=7 scope=person")
    assert lease_row(s, w.film_b) is None


def test_a_persons_chat_turn_that_finds_their_own_limit_held_is_told_chat_reserved_never_the_daily_cap(w):
    """Lens M1 on 0232: the person's limit, held only by their own storyboard being written, is a wait of minutes. Charged at the
    limit stays chat_daily_cap ("your own daily limit"); held is chat_reserved, scope person, with when."""
    s = w.su
    planner, chat = conversation(s, w.alice, w.org), conversation(s, w.alice, w.org)
    mine = s.value("select count(*)::integer from public.ai_chat_calls where user_id = %s and created_at > now() - interval '24 hours'",
                   [w.alice.uid])
    s.rows("update public.ai_chat_settings set per_user_daily = %s where id returning 1", [mine + 4])
    assert plan(s, w.alice, planner, w.film_a, 4)[1].ok
    out = turn(s, w.alice, chat, "hello")
    assert not out.ok and (out.sqlstate, out.error) == ("NS429", "chat_reserved"), out
    assert refusal(s, w.alice, TURN, [chat, "hello", False, None]) == (
        "chat_reserved", f"used={mine} reserved=4 limit={mine + 4} until={first_expiry(s, w.film_a)} scope=person")
    # The plan's own turn is one of the four: it passes.
    assert turn(s, w.alice, planner, "go").ok
    # Charged at the limit is the daily cap, as before 0232.
    s.rows("update public.ai_chat_settings set per_user_daily = %s where id returning 1", [mine + 1])
    out = turn(s, w.alice, chat, "hello")
    assert not out.ok and out.error == "chat_daily_cap", out


def test_film_plan_begin_says_chat_reserved_when_it_would_fit_once_holds_end_and_plan_over_cap_when_not(w):
    """Lens M2 on 0232: cap = used + 12, another plan holds 10, so 2 are left now and 12 once that plan ends. Needing 9 is a wait
    (chat_reserved, with when); needing 13 is over the cap even then (plan_over_cap, with the 2 left now)."""
    s = w.su
    other, mine = conversation(s, w.colleague, w.org), conversation(s, w.alice, w.org)
    cap = room(s, w.org, 12)
    f = film(s, w.alice, w.org, 180)
    assert plan(s, w.colleague, other, w.film_a, 10)[1].ok
    assert as_(s, w.alice, PLAN_BEGIN, [mine]).ok
    assert refusal(s, w.alice, FILM_BEGIN, [mine, f, 9]) == (
        "chat_reserved", f"used={cap - 12} reserved=10 limit={cap} until={first_expiry(s, w.film_a)} scope=workspace")
    assert refusal(s, w.alice, FILM_BEGIN, [mine, f, 13]) == ("plan_over_cap", "left=2 needed=13 scope=workspace")
    assert lease_row(s, f) is None and reserved(s, w.org) == 10


def test_a_plan_past_its_reservation_is_counted_on_top_and_nothing_goes_below_zero(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    cap = room(s, w.org, 3)
    _, begun = plan(s, w.alice, a, w.film_a, 1)
    assert begun.ok, begun
    assert turn(s, w.alice, a, "first").ok          # the one reserved
    assert turn(s, w.alice, a, retry=True).ok       # one more, on top
    assert reserved(s, w.org) == 0 and lease_row(s, w.film_a)[2] == 2
    assert used(s, w.org) == cap - 1
    assert turn(s, w.alice, a, retry=True).ok
    out = turn(s, w.alice, a, retry=True)
    assert not out.ok and out.error == "chat_daily_cap", out


def test_a_forgiven_plan_turn_gives_its_turn_back_and_is_never_counted_twice(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    cap = room(s, w.org, 4)
    _, begun = plan(s, w.alice, a, w.film_a, 4)
    assert begun.ok, begun
    call = turn(s, w.alice, a, "first").rows[0][0]["call_id"]
    assert used(s, w.org) == cap - 3 and reserved(s, w.org) == 3
    # The vendor refused it: the plan's cap forgives it (0199), so the charged count drops by one; it is out of the reservation
    # either way (Sentinel F: it goes back to the workspace's pool, not to the plan; noted in the 0232 header).
    assert as_(s, w.alice, "select public.ai_chat_finish_turn(%s, 'vendor_refused', null, null, null, null, null, null, null, null)",
               [call]).ok
    assert used(s, w.org) == cap - 4 and reserved(s, w.org) == 3


# ── a crash mid-plan ───────────────────────────────────────────────────────────

def test_a_crashed_plan_gives_its_unused_turns_back_at_expiry_and_the_ones_it_took_stay_taken(w):
    s = w.su
    a, b = conversation(s, w.alice, w.org), conversation(s, w.alice, w.org)
    base = used(s, w.org)
    room(s, w.org, 20)
    _, begun = plan(s, w.alice, a, w.film_a, 6)
    assert begun.ok, begun
    # Two of six turns taken, then the server dies: no finish, no end.
    calls = [turn(s, w.alice, a, "first").rows[0][0]["call_id"], turn(s, w.alice, a, retry=True).rows[0][0]["call_id"]]
    assert used(s, w.org) == base + 2 and reserved(s, w.org) == 4
    # Its 320 s run out (the clock, moved for the lease and its calls: now() is the transaction's in this lab).
    s.rows("update public.ai_chat_film_plan_leases set started_at = now() - interval '400 seconds', "
           "expires_at = now() - interval '80 seconds' where film_id = %s returning 1", [w.film_a])
    s.rows("update public.ai_chat_plan_leases set started_at = now() - interval '400 seconds', "
           "expires_at = now() - interval '80 seconds' where session_id = %s returning 1", [a])
    s.rows("update public.ai_chat_calls set created_at = now() - interval '200 seconds' where id = any(%s::uuid[]) returning 1", [calls])
    # The four it never took are back the moment it expired, with nothing run; the two it took stay counted (pending is charged).
    assert reserved(s, w.org) == 0 and used(s, w.org) == base + 2
    # The next plan in the workspace runs the sweep: the dead lease is recorded and its pending calls are failures, still counted.
    _, next_ = plan(s, w.alice, b, w.film_b, 3)
    assert next_.ok, next_
    row = lease_row(s, w.film_a)
    assert row[1:6] == (6, 2, 4, "failed", "expired"), row
    outcomes = s.rows("select outcome, tokens_in, tokens_out from public.ai_chat_calls where id = any(%s::uuid[])", [calls])
    assert outcomes == [("vendor_error", None, None)] * 2, outcomes
    assert used(s, w.org) == base + 2 and reserved(s, w.org) == 3


def test_an_expired_plan_of_a_film_is_taken_over_by_the_next_press_on_it(w):
    s = w.su
    a, b = conversation(s, w.alice, w.org), conversation(s, w.colleague, w.org)
    _, first = plan(s, w.alice, a, w.film_a, 5)
    assert first.ok, first
    s.rows("update public.ai_chat_film_plan_leases set expires_at = now() - interval '1 second' where film_id = %s returning 1", [w.film_a])
    _, second = plan(s, w.colleague, b, w.film_a, 5)
    assert second.ok, second
    assert lease_row(s, w.film_a)[0] == b and reserved(s, w.org) == 5


# ── the chat's draft and the film editor's button on one film ────────────────────

def test_the_chats_choose_and_the_film_route_on_one_draft_one_wins_the_other_is_told_plan_running(w):
    s = w.su
    film_route = conversation(s, w.alice, w.org)   # the film editor's marked conversation
    chat = conversation(s, w.alice, w.org)         # the chat that drafted the film
    _, first = plan(s, w.alice, film_route, w.film_a, 7)
    assert first.ok, first
    _, second = plan(s, w.alice, chat, w.film_a, 5)
    assert not second.ok and second.error == "plan_running" and second.sqlstate == "NS409", second
    message, detail = refusal(s, w.alice, FILM_BEGIN, [chat, w.film_a, 5])
    assert message == "plan_running" and detail == first.rows[0][0]["expires_at"], detail
    # One plan's turns reserved, never two.
    assert reserved(s, w.org) == 7 and lease_row(s, w.film_a)[0] == film_route
    # And the other way round once the first is done.
    attempt = s.value("select attempt from public.ai_chat_plan_leases where session_id = %s", [film_route])
    assert as_(s, w.alice, PLAN_END, [film_route, attempt, "done", None]).ok
    assert as_(s, w.alice, FILM_BEGIN, [chat, w.film_a, 5]).ok


def test_one_conversation_plans_one_film_at_a_time(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    _, first = plan(s, w.alice, a, w.film_a, 3)
    assert first.ok, first
    out = as_(s, w.alice, FILM_BEGIN, [a, w.film_b, 3])
    assert not out.ok and out.error == "plan_running", out


def test_a_film_lease_rides_on_a_running_conversation_lease(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    out = as_(s, w.alice, FILM_BEGIN, [a, w.film_a, 3])
    assert not out.ok and out.error == "plan_not_current", out
    attempt, begun = plan(s, w.alice, a, w.film_a, 3)
    assert begun.ok
    assert as_(s, w.alice, PLAN_END, [a, attempt, "failed", "vendor_error"]).ok
    out = as_(s, w.alice, FILM_BEGIN, [a, w.film_a, 3])
    assert not out.ok and out.error == "plan_not_current", out
    assert lease_row(s, w.film_a)[4:6] == ("failed", "vendor_error")


# ── "used" means charged; a hold is reported as held ─────────────────────────────

def test_a_running_plans_reservation_is_reported_as_reserved_never_as_used(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    room(s, w.org, 10)
    before = as_(s, w.alice, "select public.ai_chat_quota(%s)", [w.org]).rows[0][0]
    assert before["reserved"] == 0 and before["reserved_until"] is None, before
    _, begun = plan(s, w.alice, a, w.film_a, 5)
    assert begun.ok, begun
    q = as_(s, w.alice, "select public.ai_chat_quota(%s)", [w.org]).rows[0][0]
    assert q["used"] == before["used"] and q["reserved"] == 5 and q["reserved_until"] == first_expiry(s, w.film_a), q
    # A viewer reads the same numbers (ai_chat_quota is a member's read).
    v = as_(s, w.viewer, "select public.ai_chat_quota(%s)", [w.org]).rows[0][0]
    assert (v["used"], v["reserved"]) == (q["used"], 5)


def test_a_free_workspace_whose_trial_is_only_held_can_start_and_is_told_chat_reserved(w):
    s = w.su
    planner = conversation(s, w.alice, w.org)
    free_with_trial(s, w.org, 3)
    _, begun = plan(s, w.alice, planner, w.film_b, 3)
    assert begun.ok and begun.rows[0][0]["scope"] == "trial" and begun.rows[0][0]["left"] == 0, begun
    # The trial is only held: starting a conversation is not refused as "Nightshift AI is on the paid plans" (chat_plan_required).
    out = as_(s, w.colleague, "select public.ai_chat_start(%s, null)", [w.org])
    assert out.ok, out
    other = str(out.rows[0][0])
    out = turn(s, w.colleague, other, "hello")
    assert not out.ok and out.error == "chat_reserved", out
    message, detail = refusal(s, w.colleague, TURN, [other, "hello", False, None])
    assert message == "chat_reserved" and detail.startswith("used=") and " reserved=3 limit= until=" in detail, detail
    # The plan's own turns are its own.
    assert turn(s, w.alice, planner, "go").ok


def test_film_plan_begin_on_a_free_workspace_with_no_trial_left_says_chat_plan_required(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    free_with_trial(s, w.org, 0)
    _, begun = plan(s, w.alice, a, w.film_b, 3)
    assert not begun.ok and (begun.sqlstate, begun.error) == ("NS402", "chat_plan_required"), begun


def test_film_plan_begin_at_the_cap_says_chat_daily_cap_with_used_and_limit(w):
    s = w.su
    a, chatter = conversation(s, w.alice, w.org), conversation(s, w.colleague, w.org)
    # One charged turn, then a cap of exactly what is charged (a cap of 0 would be "no Nightshift AI on this plan" instead).
    room(s, w.org, 1)
    assert turn(s, w.colleague, chatter, "hello").ok
    cap = room(s, w.org, 0)
    assert as_(s, w.alice, PLAN_BEGIN, [a]).ok
    assert refusal(s, w.alice, FILM_BEGIN, [a, w.film_b, 3]) == ("chat_daily_cap", f"used={cap} limit={cap}")


def test_film_plan_begin_with_everything_left_held_says_chat_reserved(w):
    s = w.su
    a, b = conversation(s, w.alice, w.org), conversation(s, w.colleague, w.org)
    cap = room(s, w.org, 5)
    assert plan(s, w.alice, a, w.film_a, 5)[1].ok
    assert as_(s, w.colleague, PLAN_BEGIN, [b]).ok
    assert refusal(s, w.colleague, FILM_BEGIN, [b, w.film_b, 3]) == (
        "chat_reserved", f"used={cap - 5} reserved=5 limit={cap} until={first_expiry(s, w.film_a)} scope=workspace")


# ── what a reservation may be ─────────────────────────────────────────────────

@pytest.mark.parametrize("seconds,pinned", [(60, 7), (61, 7), (90, 9), (180, 15), (600, 15), (1200, 15)])
def test_film_plan_begin_accepts_exactly_the_bound_for_each_length(w, seconds, pinned):
    s = w.su
    assert s.value("select public.ai_chat_film_plan_max_turns(%s)", [seconds]) == pinned
    f = film(s, w.alice, w.org, seconds)
    a = conversation(s, w.alice, w.org)
    assert as_(s, w.alice, PLAN_BEGIN, [a]).ok
    assert refusal(s, w.alice, FILM_BEGIN, [a, f, pinned + 1]) == ("plan_too_long", f"at most {pinned} turns for this film")
    assert lease_row(s, f) is None
    out = as_(s, w.alice, FILM_BEGIN, [a, f, pinned])
    assert out.ok and out.rows[0][0]["reserved"] == pinned, out


def test_a_film_with_a_scene_takes_no_lease(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    version = s.value("select version from public.films where id = %s", [w.film_b])
    assert as_(s, w.alice, "select public.save_film(%s, %s, %s::jsonb)",
               [w.film_b, version, json.dumps({"scenes": [{"title": "Mine", "planned_seconds": 10}]})]).ok
    _, begun = plan(s, w.alice, a, w.film_b, 3)
    assert not begun.ok and (begun.sqlstate, begun.error) == ("NS409", "film_not_plannable"), begun
    # The seeded project with scenes too.
    out = as_(s, w.alice, FILM_BEGIN, [a, FILM["a"], 3])
    assert not out.ok and out.error == "film_not_plannable", out
    assert lease_row(s, w.film_b) is None and reserved(s, w.org) == 0


def test_a_member_demoted_to_viewer_mid_plan_holds_nothing(w):
    s = w.su
    planner, chatter = conversation(s, w.colleague, w.org), conversation(s, w.alice, w.org)
    room(s, w.org, 6)
    _, begun = plan(s, w.colleague, planner, w.film_b, 6)
    assert begun.ok, begun
    assert not turn(s, w.alice, chatter, "hello").ok
    s.rows("update public.org_members set role = 'viewer' where org_id = %s and user_id = %s returning 1", [w.org, w.colleague.uid])
    assert reserved(s, w.org) == 0
    assert turn(s, w.alice, chatter, "hello").ok


# ── who may begin ─────────────────────────────────────────────────────────────

def test_a_viewer_another_tenant_and_a_seatless_platform_admin_begin_nothing_and_reserve_nothing(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    admin = staff(s)
    theirs = str(s.value("insert into public.ai_chat_sessions (org_id, created_by, model) "
                         "values (%s, %s, (select model from public.ai_chat_settings where id)) returning id", [w.org, admin.uid]))
    viewers = str(s.value("insert into public.ai_chat_sessions (org_id, created_by, model) "
                          "values (%s, %s, (select model from public.ai_chat_settings where id)) returning id", [w.org, w.viewer.uid]))
    bobs = w.sc.bob.ai_chat_session
    before = (reserved(s, w.org), s.value("select count(*) from public.ai_chat_film_plan_leases"))
    for who, sid, film_id, want in (
        (w.viewer, viewers, w.film_a, ("NS404", "session_not_found")),   # a viewer's conversation is not an editor's
        (w.viewer, a, w.film_a, ("NS404", "session_not_found")),         # nor is a colleague's
        (w.sc.bob.actor, a, w.film_a, ("NS404", "session_not_found")),   # another tenant, Alice's conversation
        (w.sc.bob.actor, bobs, w.film_a, ("NS404", "film_not_found")),   # another tenant, their own conversation, Alice's film
        (w.alice, a, FILM["b"], ("NS404", "film_not_found")),            # Alice's conversation, Bob's film
        (admin, theirs, w.film_a, ("NS400", "not_a_member")),            # a platform admin with no seat (0226)
    ):
        out = as_(s, who, FILM_BEGIN, [sid, film_id, 3])
        assert not out.ok and (out.sqlstate, out.error) == want, (who.name, out)
    assert (reserved(s, w.org), s.value("select count(*) from public.ai_chat_film_plan_leases")) == before


def test_no_api_role_reaches_the_film_lease_table_or_the_helpers(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    assert plan(s, w.alice, a, w.film_a, 3)[1].ok
    for who in (w.alice, w.sc.bob.actor, sec_db.ANON, sec_db.SERVICE):
        for q, p in (("select * from public.ai_chat_film_plan_leases", []),
                     ("update public.ai_chat_film_plan_leases set taken = 0", []),
                     ("delete from public.ai_chat_film_plan_leases", []),
                     ("select public.ai_chat_reserved(%s)", [w.org]),
                     ("select public.ai_chat_reserved_by(%s)", [w.alice.uid]),
                     ("select public.ai_chat_reserved_until(%s)", [w.org]),
                     ("select public.ai_chat_film_plan_max_turns(60)", []),
                     ("select public.ai_chat_used(%s)", [w.org])):
            out = as_(s, who, q, p)
            assert not out.ok and out.sqlstate == "42501", (who.name, q, out)
    for who in (sec_db.ANON, sec_db.SERVICE):
        out = as_(s, who, FILM_BEGIN, [a, w.film_a, 3])
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_bad_parameters_are_refused(w):
    s = w.su
    a = conversation(s, w.alice, w.org)
    as_(s, w.alice, PLAN_BEGIN, [a])
    for at_most in (0, -1, None):
        out = as_(s, w.alice, FILM_BEGIN, [a, w.film_a, at_most])
        assert not out.ok and out.error == "invalid_params", (at_most, out)
    # Over the film's own bound (15 for 180 s) is named, with the number: plan_too_long, never a generic 400.
    for at_most in (16, 501):
        out = as_(s, w.alice, FILM_BEGIN, [a, w.film_a, at_most])
        assert not out.ok and (out.sqlstate, out.error) == ("NS409", "plan_too_long"), (at_most, out)


# ── the file ──────────────────────────────────────────────────────────────────

def md5_of(c, sig):
    return c.execute("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)",
                     [sig]).fetchone()[0]


def test_the_lab_holds_0232s_bodies_and_the_ones_it_relies_on(conn):
    for sig, _was, now_ in lease.GUARD:
        assert md5_of(conn, sig) == now_, sig


def test_0232_refuses_a_database_with_0211s_bodies_and_says_apply_0226_first(conn):
    """A database where 0226 is not on: the plan step's bodies are 0211's and the turn's is 0199's."""
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        sec_db.take_off_0226(c)  # takes 0232 off first, then 0226
        assert not sec_db.has_0232(c) and not sec_db.has_0226(c)
        assert md5_of(c, "public.ai_chat_plan_begin(uuid, bigint, integer)").startswith("bcb630a5")
        assert md5_of(c, "public.ai_chat_plan_session(uuid)").startswith("872b3f92")
        assert md5_of(c, "public.ai_chat_plan_end(uuid, integer, text, text)").startswith("5b94856b")
        assert md5_of(c, "public.ai_chat_plan_state(uuid)").startswith("c2aede96")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "apply 0226 first" in str(e.value), str(e.value)
        c.rollback()


def test_0232_refuses_a_body_it_was_not_written_on(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute("create or replace function public.ai_chat_plan_state(p_session uuid) returns jsonb language plpgsql stable "
                  "security definer set search_path = public, pg_temp as $$ begin return null; end $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        msg = str(e.value)
        assert "0232 found public.ai_chat_plan_state(uuid) with an unknown body" in msg and "changed by hand?" in msg, msg
        assert "apply 0226 first" not in msg, msg
        c.rollback()


SNAPSHOT = """
select md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(array_to_string(p.proacl, ','), ''), ',' order by p.oid))
  from pg_proc p where p.pronamespace = 'public'::regnamespace
"""


def test_a_replay_changes_nothing(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        before = c.execute(SNAPSHOT).fetchone()[0]
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute(SNAPSHOT).fetchone()[0] == before
        c.rollback()


def test_the_rollback_puts_the_earlier_bodies_back_then_0232_applies_again(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        grants = {sig: c.execute("select proacl::text from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0]
                  for sig, *_ in lease.GUARD}
        sec_db.take_off_0232(c)
        for sig, was, _now in lease.GUARD:
            assert md5_of(c, sig) == was, sig
            assert c.execute("select proacl::text from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0] == grants[sig], sig
        assert c.execute("select to_regprocedure('public.ai_chat_film_plan_begin(uuid, uuid, integer)') is null").fetchone()[0]
        assert c.execute("select to_regclass('public.ai_chat_film_plan_leases') is null").fetchone()[0]
        sec_db.put_back_0232(c)
        for sig, _was, now_ in lease.GUARD:
            assert md5_of(c, sig) == now_, sig
            assert c.execute("select proacl::text from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0] == grants[sig], sig
        c.rollback()


def test_the_rollback_refuses_a_body_that_is_not_0232s(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute("create or replace function public.ai_chat_quota(p_org uuid) returns jsonb language sql stable "
                  "security definer set search_path = public, pg_temp as $$ select '{}'::jsonb $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute("\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;")))
        assert "rollback 0232: public.ai_chat_quota(uuid) is not 0232's body" in str(e.value), str(e.value)
        c.rollback()


def test_each_replaced_body_is_the_earlier_one_with_only_marked_0232_lines_added_and_the_table_has_its_shape(conn):
    """ai_chat_reserve_turn and ai_chat_plan_end (0226's) and ai_chat_quota (0199's): the earlier source, line for line, plus inserted
    lines, every inserted run of them opening with a 0232 comment. Nothing earlier is changed or dropped. And the table's columns and
    indexes are the ones the file declares (the full ones on the two cascading keys included)."""
    cols = conn.execute("select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) "
                        "from information_schema.columns where table_schema = 'public' and table_name = 'ai_chat_film_plan_leases'").fetchone()[0]
    assert cols == ("film_id:uuid:NO,org_id:uuid:NO,session_id:uuid:NO,created_by:uuid:NO,attempt:integer:NO,reserved:integer:NO,"
                    "taken:integer:NO,released:integer:YES,state:text:NO,reason:text:YES,started_at:timestamp with time zone:NO,"
                    "expires_at:timestamp with time zone:NO,finished_at:timestamp with time zone:YES"), cols
    idx = dict(conn.execute("select indexname, indexdef from pg_indexes where schemaname = 'public' "
                            "and tablename = 'ai_chat_film_plan_leases'").fetchall())
    assert idx["ai_chat_film_plan_leases_session"].endswith("USING btree (session_id)"), idx
    assert idx["ai_chat_film_plan_leases_org"].endswith("USING btree (org_id)"), idx
    assert "UNIQUE" in idx["ai_chat_film_plan_leases_one_per_session"] and "WHERE (state = 'running'::text)" in idx[
        "ai_chat_film_plan_leases_one_per_session"], idx
    assert conn.execute("select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_chat_film_plan_leases_reserved_check'"
                        ).fetchone()[0] == "CHECK (((reserved >= 1) AND (reserved <= 15)))"
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        sigs = tuple(lease.REPLACED)
        src = lambda sig: c.execute("select prosrc from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0]  # noqa: E731
        now_ = {sig: src(sig) for sig in sigs}
        sec_db.take_off_0232(c)
        was = {sig: src(sig) for sig in sigs}
        c.rollback()
    for sig in sigs:
        a, b = was[sig].splitlines(), now_[sig].splitlines()
        ops = difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes()
        assert all(op in ("equal", "insert") for op, *_ in ops), (sig, [o for o in ops if o[0] not in ("equal", "insert")])
        runs = [(j1, j2) for op, _i1, _i2, j1, j2 in ops if op == "insert"]
        assert runs and all(run_is_marked(b, j1, j2) for j1, j2 in runs), (sig, [b[j1:j2] for j1, j2 in runs])


def run_is_marked(b, j1, j2) -> bool:
    """An inserted run b[j1:j2] opens with a 0232 comment, or its unmarked first lines are a pure alignment shift: difflib matched
    an earlier line (a repeated `end if;`) to the same line at the END of the hunk, so the run starts k lines early. That is so
    exactly when its k unmarked first lines equal the k lines right after it: moved k lines on, the same run opens with the marked
    comment and the text is the same. Anything else, an unmarked line put in ahead of the marked comment included, fails."""
    run = b[j1:j2]
    k = next((i for i, ln in enumerate(run) if ln.strip().startswith("-- 0232")), None)
    if k is None:
        return False
    return k == 0 or run[:k] == b[j2:j2 + k]


def test_the_diff_check_refuses_an_unmarked_line_put_in_before_a_marked_comment():
    """The check's own pins: a pure shift passes; an unmarked line inserted ahead of the comment, or a run with no comment, fails."""
    # Earlier: perform, end if, b. Now: perform, end if, -- 0232, y, end if, b; difflib puts the earlier `end if` last.
    shifted = ["a", "  perform x();", "  end if;", "  -- 0232: x", "  y;", "  end if;", "b"]
    assert run_is_marked(shifted, 2, 5)
    sneaked = ["a", "  perform x();", "  perform evil();", "  -- 0232: x", "  y;", "  end if;", "b"]
    assert not run_is_marked(sneaked, 2, 5)       # an unmarked statement ahead of the marked comment
    assert not run_is_marked(["a", "  y;", "b"], 1, 2)


@pytest.mark.parametrize("name,loud", [("0199_studio_ai_chat.sql", False), ("0211_ai_chat_plan_leases.sql", False),
                                       ("0226_org_spender_everywhere.sql", True)])
def test_the_replay_note_says_what_rerunning_an_earlier_file_does(conn, name, loud):
    """The file's REPLAY note, measured: 0199 and 0211 apply silently and put an older body back; 0226 refuses 0232's bodies."""
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        before = {sig: md5_of(c, sig) for sig in lease.REPLACED}
        if loud:
            with pytest.raises(psycopg.Error) as e:
                c.execute((sec_db.MIGRATIONS / name).read_text(encoding="utf-8"))
            # 0226's guard walks its bodies in order and stops at the first it does not know: 0232's chat body, or, where 0231
            # (cancel audit) is on as well, 0231's create_creative_job, which comes first. Either way it refuses loudly.
            assert re.search(r"0226 found public[.](ai_chat_reserve_turn|create_creative_job|cancel_workflow_run)", str(e.value)), \
                str(e.value)
        else:
            c.execute((sec_db.MIGRATIONS / name).read_text(encoding="utf-8"))
            assert {sig: md5_of(c, sig) for sig in lease.REPLACED} != before
        c.rollback()
    note = MIGRATION.read_text(encoding="utf-8").split("-- REPLAY.", 1)[1].split("-- REQUIRES", 1)[0]
    assert name[:4] in note


def test_neither_the_file_nor_its_rollback_holds_a_backslash():
    for path in (MIGRATION, ROLLBACK):
        assert "\\" not in path.read_text(encoding="utf-8"), path.name


def test_the_files_fold_reads_every_body_as_the_shorthand_does(conn):
    for sig, *_ in lease.GUARD:
        a = conn.execute("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')), md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) "
                         "from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()
        assert a[0] == a[1], sig
