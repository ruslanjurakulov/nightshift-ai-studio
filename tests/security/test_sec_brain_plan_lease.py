"""Migration 0211: one storyboard plan at a time per Nightshift AI conversation (ai_chat_plan_begin / _end / _state).

Breach BR-S1-02 (tests/security/test_sec_brain_plan_breach.py) found that nothing in the database ties one plan to one
conversation: a second tab began a second plan and took every turn again. These pin the lease that closes it, failing before 0211
(the functions do not exist) and passing after:

* a second begin while a plan runs is refused (`plan_running`, with when the running one ends);
* nobody but the author begins, ends or reads a plan: not a colleague, not a viewer, not another tenant (`session_not_found`);
* only the running attempt ends the lease, by its number (`plan_not_current` for any other);
* a failed plan is granted again at once, as attempt + 1; so is a running one whose time ran out;
* no API role writes (or reads) the lease table directly;
* taking over an expired plan finishes its stale `pending` calls as `vendor_error` with unknown tokens, and leaves a live call be.
"""

from __future__ import annotations

import uuid

from sec_db import ANON, SERVICE, acting, as_superuser, user

BEGIN = "select public.ai_chat_plan_begin(%s, %s, %s)"
END = "select public.ai_chat_plan_end(%s, %s, %s, %s)"
STATE = "select public.ai_chat_plan_state(%s)"


def _member(su, org: str, role: str):
    who = user(f"lease-{role}", f"lease-{role}-{uuid.uuid4().hex[:6]}@lease.lab")
    su.rows("insert into auth.users (id, email) values (%s, %s) returning 1", [who.uid, who.email])
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
            [org, who.uid, who.email, role])
    return who


def test_a_second_plan_of_one_conversation_is_refused_while_the_first_runs(conn, sc):
    with as_superuser(conn, commit=False):
        with acting(conn, sc.alice.actor) as s:
            first = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])
            assert first["attempt"] == 1 and first["expires_at"] and isinstance(first["user_left"], int), first
            # The same outline from a second tab, and another outline of the same proposal: both refused, with the first's end.
            for index in (0, 1):
                out = s.run(BEGIN, [sc.alice.ai_chat_session, 41, index])
                assert not out.ok and out.error == "plan_running", out
            assert s.value(STATE, [sc.alice.ai_chat_session])["state"] == "running"


def test_nobody_but_the_author_begins_ends_or_reads_a_plan(conn, sc):
    with as_superuser(conn, commit=False) as su:
        colleague = _member(su, sc.alice.org, "editor")
        viewer = _member(su, sc.alice.org, "viewer")
        # Kept for the attacks that follow; the outer superuser transaction still rolls it all back.
        with acting(conn, sc.alice.actor, commit=True) as s:
            attempt = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])["attempt"]
        conn.execute("reset role")
        for who in (colleague, viewer, sc.bob.actor):
            with acting(conn, who) as s:
                for q, args in ((BEGIN, [sc.alice.ai_chat_session, 41, 1]), (END, [sc.alice.ai_chat_session, attempt, "done", None]),
                                (STATE, [sc.alice.ai_chat_session])):
                    out = s.run(q, args)
                    assert not out.ok and out.error == "session_not_found", (who.name, q, out)
        # Alice's plan is untouched by all of it.
        with acting(conn, sc.alice.actor) as s:
            state = s.value(STATE, [sc.alice.ai_chat_session])
            assert state["state"] == "running" and state["attempt"] == attempt, state


def test_only_the_running_attempt_ends_the_lease(conn, sc):
    with as_superuser(conn, commit=False):
        with acting(conn, sc.alice.actor) as s:
            attempt = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])["attempt"]
            for wrong in (attempt - 1, attempt + 1, None):
                out = s.run(END, [sc.alice.ai_chat_session, wrong, "done", None])
                assert not out.ok and out.error == "plan_not_current", (wrong, out)
            out = s.run(END, [sc.alice.ai_chat_session, attempt, "running", None])
            assert not out.ok and out.error == "invalid_params", out
            out = s.run(END, [sc.alice.ai_chat_session, attempt, "failed", "Not A Code"])
            assert not out.ok and out.error == "invalid_params", out
            assert s.run(END, [sc.alice.ai_chat_session, attempt, "done", None]).ok
            # Ended once: a second end of the same attempt is not the running one any more.
            out = s.run(END, [sc.alice.ai_chat_session, attempt, "failed", "late"])
            assert not out.ok and out.error == "plan_not_current", out
            assert s.value(STATE, [sc.alice.ai_chat_session])["state"] == "done"


def test_a_failed_plan_is_granted_again_at_once_as_the_next_attempt(conn, sc):
    with as_superuser(conn, commit=False):
        with acting(conn, sc.alice.actor) as s:
            one = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])["attempt"]
            assert s.run(END, [sc.alice.ai_chat_session, one, "failed", "vendor_error"]).ok
            state = s.value(STATE, [sc.alice.ai_chat_session])
            assert state["state"] == "failed" and state["reason"] == "vendor_error", state
            two = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])["attempt"]
            assert two == one + 1
            # The older attempt can no longer end the new one.
            out = s.run(END, [sc.alice.ai_chat_session, one, "done", None])
            assert not out.ok and out.error == "plan_not_current", out


def test_a_plan_whose_time_ran_out_is_granted_again(conn, sc):
    with as_superuser(conn, commit=False) as su:
        with acting(conn, sc.alice.actor, commit=True) as s:
            one = s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])["attempt"]
        conn.execute("reset role")
        su.rows("update public.ai_chat_plan_leases set expires_at = now() - interval '1 second' where session_id = %s returning 1",
                [sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor) as s:
            state = s.value(STATE, [sc.alice.ai_chat_session])
            # Nothing will finish it now: it reads as failed, expired, never as still running.
            assert state["state"] == "failed" and state["reason"] == "expired", state
            assert s.value(BEGIN, [sc.alice.ai_chat_session, 41, 1])["attempt"] == one + 1


def test_no_api_role_reaches_the_lease_table_directly(conn, sc):
    with as_superuser(conn, commit=False):
        with acting(conn, sc.alice.actor) as s:
            s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])
        for who in (sc.alice.actor, sc.bob.actor, ANON, SERVICE):
            with acting(conn, who) as s:
                for q, args in (
                    ("select * from public.ai_chat_plan_leases", []),
                    ("insert into public.ai_chat_plan_leases (session_id, created_by, proposal_id, scenario_index, attempt, state, "
                     "expires_at) values (%s, %s, 1, 0, 9, 'done', now()) returning 1", [sc.alice.ai_chat_session, who.uid or sc.alice.actor.uid]),
                    ("update public.ai_chat_plan_leases set state = 'done' returning 1", []),
                    ("delete from public.ai_chat_plan_leases returning 1", []),
                ):
                    out = s.run(q, args)
                    assert not out.ok and out.sqlstate == "42501", (who.name, q, out)


def test_taking_over_an_expired_plan_finishes_its_stale_pending_calls_only(conn, sc):
    with as_superuser(conn, commit=False) as su:
        with acting(conn, sc.alice.actor, commit=True) as s:
            s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])
        conn.execute("reset role")
        su.rows("update public.ai_chat_plan_leases set started_at = now() - interval '10 minutes', "
                "expires_at = now() - interval '4 minutes' where session_id = %s returning 1", [sc.alice.ai_chat_session])
        # A call the dead plan left pending, and a live turn of the same person in the same conversation made just now.
        stale = su.value("insert into public.ai_chat_calls (org_id, user_id, session_id, model, outcome, tokens_in, created_at) "
                         "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'pending', null, now() - interval '8 minutes') returning id",
                         [sc.alice.org, sc.alice.actor.uid, sc.alice.ai_chat_session])
        live = su.value("insert into public.ai_chat_calls (org_id, user_id, session_id, model, outcome, created_at) "
                        "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'pending', now()) returning id",
                        [sc.alice.org, sc.alice.actor.uid, sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor, commit=True) as s:
            assert s.value(BEGIN, [sc.alice.ai_chat_session, 41, 0])["attempt"] == 2
        conn.execute("reset role")
        row = su.rows("select outcome, tokens_in, tokens_out, finished_at is not null from public.ai_chat_calls where id = %s", [stale])[0]
        assert row == ("vendor_error", None, None, True), row
        assert su.value("select outcome from public.ai_chat_calls where id = %s", [live]) == "pending"
