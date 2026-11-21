"""The owner's Nightshift AI conversation history (migration 0209).

The history holds the owner's questions and the AI's answers in plain text, so the store is closed: only security-definer
functions that check owner_analytics_is_owner() (42501) and then 0107's second factor (NS401) reach it, and every function checks
the session belongs to the caller. What would break: a customer, an admin who is not the owner, the service key or anon reading
the owner's words or writing into them; a password-only owner session reading them when the MFA gate is on; one owner reading or
appending to another's conversation; a text over its cap stored; a deleted conversation still listed or readable. Every world is
rolled back.
"""

from __future__ import annotations

import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user

NIL = "00000000-0000-0000-0000-000000000000"
MODEL = "anthropic-claude-sonnet-5-5"

# Every function with harmless arguments: the gate must refuse before the arguments are even looked at.
CALLS = [
    ("select public.owner_ai_session_create('x')", []),
    ("select * from public.owner_ai_session_list(30, null)", []),
    ("select * from public.owner_ai_session_messages(%s)", [NIL]),
    ("select public.owner_ai_message_append(%s, 'owner', 'q', null, null)", [NIL]),
    ("select public.owner_ai_session_rename(%s, 'x')", [NIL]),
    ("select public.owner_ai_session_delete(%s)", [NIL]),
]


def _seeded_session(su, sc) -> str:
    return str(su.value("select id from public.owner_ai_sessions where user_id = %s and title = 'Seeded owner chat'",
                        [sc.operator.uid]))


def _second_owner(su):
    """Another platform owner, created in the rolled-back world: the only kind of other person who passes the owner gate."""
    other = user("oa-owner2", "oa-owner2@example.test")
    su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [other.uid, other.email])
    su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner') returning 1", [other.uid, other.email])
    return other


@pytest.mark.parametrize("who", ["alice", "bob", "dana", "admin"])
def test_no_one_but_the_owner_reaches_any_history_function(conn, sc, who):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        admin = user("oh-admin", "oh-admin@example.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [admin.uid, admin.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [admin.uid, admin.email])
        actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "dana": sc.dana, "admin": admin}[who]
        with acting(conn, actor) as s:
            outs = [s.run(q, [sid] if p else p) for q, p in CALLS]
    for (q, _), out in zip(CALLS, outs):
        assert not out.ok and out.sqlstate == "42501", (who, q, out)


def test_anon_and_the_service_key_cannot_call_any_history_function(conn, sc):
    for who in (ANON, SERVICE):
        with acting(conn, who) as s:
            outs = [s.run(q, p) for q, p in CALLS]
        for (q, _), out in zip(CALLS, outs):
            assert not out.ok and out.sqlstate == "42501", (who.name, q, out)


def test_the_history_tables_are_closed_to_every_api_role(conn, sc):
    for who in (sc.operator, sc.alice.actor, SERVICE, ANON):
        with acting(conn, who) as s:
            outs = [
                s.run("select * from public.owner_ai_sessions"),
                s.run("select * from public.owner_ai_messages"),
                s.run("insert into public.owner_ai_sessions (user_id, title) values (%s, 't')", [sc.operator.uid]),
                s.run("update public.owner_ai_messages set text = 'x'"),
                s.run("delete from public.owner_ai_messages"),
            ]
        for out in outs:
            assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_with_the_mfa_gate_on_a_password_only_owner_gets_nothing(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        su.rows("update public.owner_security_settings set admin_aal2_required = true returning 1")
        su.rows("insert into auth.mfa_factors (id, user_id, status) values (%s, %s, 'verified') returning 1",
                [str(uuid.uuid4()), sc.operator.uid])
        with acting(conn, sc.operator) as s:
            outs = [s.run(q, [sid] if p else p) for q, p in CALLS]
    for (q, _), out in zip(CALLS, outs):
        assert not out.ok and out.sqlstate == "NS401", (q, out)


def test_the_owner_creates_appends_lists_and_reads_back_in_order(conn, sc):
    with as_superuser(conn, commit=False):
        with acting(conn, sc.operator) as s:
            sid = s.value("select public.owner_ai_session_create('  Revenue this week  ')")
            s.value("select public.owner_ai_message_append(%s, 'owner', 'What was revenue?', null, null)", [sid])
            s.value("select public.owner_ai_message_append(%s, 'ai', 'About the same as last week.', now(), %s)", [sid, MODEL])
            listed = s.rows("select id, title from public.owner_ai_session_list(30, null)")
            msgs = s.rows("select role, text, model from public.owner_ai_session_messages(%s)", [sid])
    # Newest activity first: the session just written to is above the seeded one.
    assert listed[0] == (sid, "Revenue this week"), listed
    assert msgs == [("owner", "What was revenue?", None), ("ai", "About the same as last week.", MODEL)], msgs


def test_one_owner_cannot_read_append_rename_or_delete_anothers_session(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        other = _second_owner(su)
        with acting(conn, other) as s:
            listed = s.rows("select id from public.owner_ai_session_list(100, null)")
            read = s.run("select * from public.owner_ai_session_messages(%s)", [sid])
            app = s.run("select public.owner_ai_message_append(%s, 'owner', 'injected', null, null)", [sid])
            ren = s.run("select public.owner_ai_session_rename(%s, 'pwned')", [sid])
            dele = s.run("select public.owner_ai_session_delete(%s)", [sid])
        conn.execute("reset role")
        truth = su.rows("select title, deleted_at is null, (select count(*) from public.owner_ai_messages m where m.session_id = s.id) "
                        "from public.owner_ai_sessions s where s.id = %s", [sid])
    assert sid not in {str(r[0]) for r in listed}, listed
    for out in (read, app, ren, dele):
        # The same answer as an id that does not exist: an id is not an oracle.
        assert not out.ok and out.sqlstate == "P0002", out
    assert truth == [("Seeded owner chat", True, 2)], truth


def test_text_length_limits_are_enforced(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        with acting(conn, sc.operator) as s:
            app = "select public.owner_ai_message_append(%s, %s, %s, null, null)"
            q_ok = s.run(app, [sid, "owner", "q" * 2000])
            q_long = s.run(app, [sid, "owner", "q" * 2001])
            a_ok = s.run(app, [sid, "ai", "a" * 12000])
            a_long = s.run(app, [sid, "ai", "a" * 12001])
            empty = s.run(app, [sid, "ai", ""])
            role = s.run(app, [sid, "system", "x"])
            model = s.run("select public.owner_ai_message_append(%s, 'ai', 'x', null, 'Bad Model!')", [sid])
            title_long = s.run("select public.owner_ai_session_create(%s)", ["t" * 61])
            title_blank = s.run("select public.owner_ai_session_create('   ')")
            rename_long = s.run("select public.owner_ai_session_rename(%s, %s)", [sid, "t" * 61])
    assert q_ok.ok and a_ok.ok, (q_ok, a_ok)
    for out in (q_long, a_long, empty, role, model, title_long, title_blank, rename_long):
        assert not out.ok and out.sqlstate == "22023", out


def test_a_deleted_session_is_not_listed_read_or_appended_to(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        with acting(conn, sc.operator) as s:
            s.run("select public.owner_ai_session_delete(%s)", [sid])
            again = s.run("select public.owner_ai_session_delete(%s)", [sid])
            listed = s.rows("select id from public.owner_ai_session_list(100, null)")
            read = s.run("select * from public.owner_ai_session_messages(%s)", [sid])
            app = s.run("select public.owner_ai_message_append(%s, 'owner', 'after delete', null, null)", [sid])
            ren = s.run("select public.owner_ai_session_rename(%s, 'back')", [sid])
    assert again.ok, again
    assert sid not in {str(r[0]) for r in listed}, listed
    for out in (read, app, ren):
        assert not out.ok and out.sqlstate == "P0002", out


def test_list_pages_newest_first_and_rename_does_not_reorder(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("delete from public.owner_ai_sessions where user_id = %s returning 1", [sc.operator.uid])
        su.rows("insert into public.owner_ai_sessions (user_id, title, updated_at) values "
                "(%s, 'old', now() - interval '2 days'), (%s, 'mid', now() - interval '1 day'), (%s, 'new', now() - interval '1 hour') "
                "returning 1", [sc.operator.uid] * 3)
        with acting(conn, sc.operator) as s:
            first = s.rows("select title, updated_at from public.owner_ai_session_list(2, null)")
            rest = s.rows("select title from public.owner_ai_session_list(2, %s)", [first[-1][1]])
            old = s.value("select id from public.owner_ai_session_list(100, null) where title = 'old'")
            s.run("select public.owner_ai_session_rename(%s, 'renamed old')", [old])
            after = s.rows("select title from public.owner_ai_session_list(100, null)")
    assert [r[0] for r in first] == ["new", "mid"], first
    assert rest == [("old",)], rest
    assert [r[0] for r in after] == ["new", "mid", "renamed old"], after
