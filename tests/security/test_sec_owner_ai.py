"""The owner's Nightshift AI turn log and cap (migration 0202).

Every owner AI turn is vendor spend, so it is reserved in the database before the model is called. What would break: a customer or
an admin who is not the owner reserving turns (spend on the owner's model, and a way to probe the owner's console); the cap not
holding, so a loop is an open tap; a turn finished twice or by someone else, so the log lies; the log readable directly; the
question text stored. Every world is rolled back.
"""

from __future__ import annotations

import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user

RESERVE = "select public.owner_ai_reserve_turn(40, 'anthropic-claude-sonnet-5-5')"
FINISH = "select public.owner_ai_finish_turn(%s, true, null, 10, 20)"


@pytest.mark.parametrize("who", ["alice", "bob", "dana", "admin"])
def test_no_one_but_the_owner_reserves_a_turn(conn, sc, who):
    with as_superuser(conn, commit=False) as su:
        admin = user("oa-admin", "oa-admin@example.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [admin.uid, admin.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [admin.uid, admin.email])
        actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "dana": sc.dana, "admin": admin}[who]
        with acting(conn, actor) as s:
            out = s.run(RESERVE)
            fin = s.run(FINISH, [1])
    assert not out.ok and out.sqlstate == "42501", (who, out)
    assert not fin.ok and fin.sqlstate == "42501", (who, fin)


def test_anon_and_the_service_key_cannot_call_them(conn, sc):
    for who in (ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run(RESERVE)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_the_log_is_closed_to_every_api_role(conn, sc):
    for who in (sc.operator, sc.alice.actor, SERVICE, ANON):
        with acting(conn, who) as s:
            sel = s.run("select * from public.owner_ai_turns")
            ins = s.run("insert into public.owner_ai_turns (user_id, chars_in) values (%s, 1)", [sc.operator.uid])
        for out in (sel, ins):
            assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_the_owner_reserves_and_finishes_once_and_no_text_is_stored(conn, sc):
    # The owner's block is committed inside the superuser's rolled-back world, so the row can be read and still leaves nothing.
    with as_superuser(conn, commit=False) as su:
        with acting(conn, sc.operator, commit=True) as s:
            tid = s.value(RESERVE)
            s.run(FINISH, [tid])
            # A second finish is a no-op: the record is not rewritten.
            s.run("select public.owner_ai_finish_turn(%s, false, 'vendor_error', 1, 1)", [tid])
        # The committed block's `set local role` outlives it inside the outer transaction: back to the database owner to read.
        conn.execute("reset role")
        row = su.rows("select outcome, error, tokens_in, tokens_out, chars_in, model from public.owner_ai_turns where id = %s", [tid])
        cols = {r[0] for r in su.rows("select column_name from information_schema.columns where table_name = 'owner_ai_turns'")}
    assert row == [("answered", None, 10, 20, 40, "anthropic-claude-sonnet-5-5")]
    assert not ({"question", "answer", "text", "prompt", "facts"} & cols), cols


def test_bad_input_is_refused_before_anything_is_written(conn, sc):
    with acting(conn, sc.operator) as s:
        assert s.run("select public.owner_ai_reserve_turn(0, 'm')").sqlstate == "22023"
        assert s.run("select public.owner_ai_reserve_turn(2001, 'm')").sqlstate == "22023"
        assert s.run("select public.owner_ai_reserve_turn(5, 'Bad Model!')").sqlstate == "22023"
        assert s.run("select public.owner_ai_finish_turn(1, false, 'Free text from a vendor', null, null)").sqlstate == "22023"


def test_the_daily_cap_holds(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into public.owner_ai_turns (user_id, chars_in, created_at) "
                "select %s, 1, now() - interval '1 hour' from generate_series(1, 200) returning 1", [sc.operator.uid])
        with acting(conn, sc.operator) as s:
            out = s.run(RESERVE)
    assert not out.ok and out.sqlstate == "NS429" and out.error == "owner_ai_daily_cap", out


def test_turns_older_than_a_day_do_not_count(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into public.owner_ai_turns (user_id, chars_in, created_at) "
                "select %s, 1, now() - interval '25 hours' from generate_series(1, 200) returning 1", [sc.operator.uid])
        with acting(conn, sc.operator) as s:
            out = s.run(RESERVE)
    assert out.ok, out


def test_with_the_mfa_gate_on_a_password_only_owner_reserves_nothing(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.owner_security_settings set admin_aal2_required = true returning 1")
        su.rows("insert into auth.mfa_factors (id, user_id, status) values (%s, %s, 'verified') returning 1", [str(uuid.uuid4()), sc.operator.uid])
        with acting(conn, sc.operator) as s:
            out = s.run(RESERVE)
    assert not out.ok and out.sqlstate == "NS401", out
