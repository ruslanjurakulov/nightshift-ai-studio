"""The owner's Nightshift AI conversation history (migration 0209).

The history holds the owner's questions and the AI's answers in plain text (answers can contain business figures and customer
names), so the store is closed: only security-definer functions that check owner_analytics_is_owner() (42501) and then 0107's
second factor (NS401) reach it, and every function checks the session belongs to the caller. History is written only by
owner_ai_turn_save, once per answered 0203 turn, question and answer together. What would break: a customer, an admin who is not
the owner, the service key or anon reading the owner's words or writing into them; a password-only owner session reading them when
the MFA gate is on; one owner reading or writing into another's conversation; text stored without a paid, answered turn, or the
same turn stored twice (storage no longer bounded by 0203's cap); a question stored without its answer; a "deleted" conversation
whose words are still in the database; a title that reads backwards in the list. Every world is rolled back.
"""

from __future__ import annotations

import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user

NIL = "00000000-0000-0000-0000-000000000000"
MODEL = "anthropic-claude-sonnet-5-5"
SAVE = "select public.owner_ai_turn_save(%s, %s, %s, %s, now(), %s)"

# Every function with harmless arguments: the gate must refuse before the arguments are even looked at.
CALLS = [
    ("select public.owner_ai_turn_save(1, %s, 'q', 'a', null, null)", [NIL]),
    ("select * from public.owner_ai_session_list(30, null, null)", []),
    ("select * from public.owner_ai_session_messages(%s)", [NIL]),
    ("select public.owner_ai_session_rename(%s, 'x')", [NIL]),
    ("select public.owner_ai_session_delete(%s)", [NIL]),
]


def _seeded_session(su, sc) -> str:
    return str(su.value("select id from public.owner_ai_sessions where user_id = %s and title = 'Seeded owner chat'",
                        [sc.operator.uid]))


def _turn(su, who, outcome: str = "answered") -> int:
    """A 0203 turn as the route leaves it after the vendor call (answered) or before/after a failure."""
    return su.value("insert into public.owner_ai_turns (user_id, model, outcome, chars_in, finished_at) "
                    "values (%s, %s, %s, 5, case when %s = 'reserved' then null else now() end) returning id",
                    [who.uid, MODEL, outcome, outcome])


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
                s.run("truncate public.owner_ai_messages"),
                s.run("select nextval('public.owner_ai_messages_id_seq')"),
            ]
        for out in outs:
            assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_the_free_writers_of_the_earlier_draft_do_not_exist(conn, sc):
    with as_superuser(conn, commit=False) as su:
        left = su.rows("select s from unnest(array['public.owner_ai_message_append(uuid,text,text,timestamptz,text)', "
                       "'public.owner_ai_session_create(text)', 'public.owner_ai_session_list(integer,timestamptz)']) s "
                       "where to_regprocedure(s) is not null")
    assert left == [], left


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


def test_the_owner_saves_turns_lists_and_reads_back_in_order(conn, sc):
    with as_superuser(conn, commit=False) as su:
        t1, t2 = _turn(su, sc.operator), _turn(su, sc.operator)
        with acting(conn, sc.operator) as s:
            sid = s.value(SAVE, [t1, None, "  Revenue\n\tthis week  ", "About the same as last week.", MODEL])
            again = s.value(SAVE, [t2, sid, "And signups?", "Twelve.", MODEL])
            listed = s.rows("select id, title from public.owner_ai_session_list(30, null, null)")
            msgs = s.rows("select role, text, as_of is null, model from public.owner_ai_session_messages(%s)", [sid])
    assert again == sid
    # Newest activity first: the session just written to is above the seeded one; the title is the question, whitespace folded.
    assert listed[0] == (sid, "Revenue this week"), listed
    assert msgs == [("owner", "  Revenue\n\tthis week  ", True, None), ("ai", "About the same as last week.", False, MODEL),
                    ("owner", "And signups?", True, None), ("ai", "Twelve.", False, MODEL)], msgs


@pytest.mark.parametrize("case", ["reserved", "failed", "missing", "another_owners"])
def test_a_save_without_an_answered_turn_of_the_caller_is_refused_and_writes_nothing(conn, sc, case):
    with as_superuser(conn, commit=False) as su:
        if case == "missing":
            tid = 2_000_000_000
        elif case == "another_owners":
            tid = _turn(su, _second_owner(su))
        else:
            tid = _turn(su, sc.operator, case)
        before = su.value("select count(*) from public.owner_ai_messages")
        sessions = su.value("select count(*) from public.owner_ai_sessions")
        # commit=True keeps the caller's writes for the superuser's count below; the outer world still rolls back.
        with acting(conn, sc.operator, commit=True) as s:
            out = s.run(SAVE, [tid, None, "free text", "free answer", MODEL])
        conn.execute("reset role")
        after = su.value("select count(*) from public.owner_ai_messages")
        sessions_after = su.value("select count(*) from public.owner_ai_sessions")
    assert not out.ok and out.sqlstate == "P0002" and out.error == "turn_not_answered", out
    assert (after, sessions_after) == (before, sessions), (before, after, sessions, sessions_after)


def test_the_same_turn_cannot_be_saved_twice(conn, sc):
    with as_superuser(conn, commit=False) as su:
        tid = _turn(su, sc.operator)
        with acting(conn, sc.operator, commit=True) as s:
            sid = s.value(SAVE, [tid, None, "q", "a", MODEL])
            twice = s.run(SAVE, [tid, sid, "q again", "a again", MODEL])
            elsewhere = s.run(SAVE, [tid, None, "q again", "a again", MODEL])
        conn.execute("reset role")
        rows = su.value("select count(*) from public.owner_ai_messages where turn_id = %s", [tid])
        sessions = su.value("select count(*) from public.owner_ai_sessions where user_id = %s", [sc.operator.uid])
    for out in (twice, elsewhere):
        assert not out.ok and out.sqlstate == "23505" and out.error == "turn_already_saved", out
    assert rows == 2, rows
    # The refused second save did not leave an empty new session behind (one transaction).
    assert sessions == 2, sessions


def test_a_foreign_session_id_starts_a_new_session_and_never_writes_into_the_other_owners(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        stamp = su.value("select updated_at from public.owner_ai_sessions where id = %s", [sid])
        other = _second_owner(su)
        tid = _turn(su, other)
        with acting(conn, other, commit=True) as s:
            mine = s.value(SAVE, [tid, sid, "injected question", "injected answer", MODEL])
            listed = s.rows("select id from public.owner_ai_session_list(100, null, null)")
        conn.execute("reset role")
        truth = su.rows("select title, updated_at = %s, (select count(*) from public.owner_ai_messages m where m.session_id = s.id) "
                        "from public.owner_ai_sessions s where s.id = %s", [stamp, sid])
        owner_of_new = su.value("select user_id from public.owner_ai_sessions where id = %s", [mine])
    assert str(mine) != sid
    assert str(owner_of_new) == str(other.uid)
    assert [str(r[0]) for r in listed] == [str(mine)], listed
    assert truth == [("Seeded owner chat", True, 2)], truth


def test_one_owner_cannot_read_rename_or_delete_anothers_session(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        other = _second_owner(su)
        with acting(conn, other, commit=True) as s:
            listed = s.rows("select id from public.owner_ai_session_list(100, null, null)")
            read = s.run("select * from public.owner_ai_session_messages(%s)", [sid])
            ren = s.run("select public.owner_ai_session_rename(%s, 'pwned')", [sid])
            dele = s.run("select public.owner_ai_session_delete(%s)", [sid])
        conn.execute("reset role")
        truth = su.rows("select title, (select count(*) from public.owner_ai_messages m where m.session_id = s.id) "
                        "from public.owner_ai_sessions s where s.id = %s", [sid])
    assert sid not in {str(r[0]) for r in listed}, listed
    for out in (read, ren, dele):
        # The same answer as an id that does not exist: an id is not an oracle.
        assert not out.ok and out.sqlstate == "P0002", out
    assert truth == [("Seeded owner chat", 2)], truth


def test_delete_removes_the_session_and_its_messages_from_the_database(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        tid = _turn(su, sc.operator)
        with acting(conn, sc.operator, commit=True) as s:
            gone = s.run("select public.owner_ai_session_delete(%s)", [sid])
            again = s.run("select public.owner_ai_session_delete(%s)", [sid])
            listed = s.rows("select id from public.owner_ai_session_list(100, null, null)")
            read = s.run("select * from public.owner_ai_session_messages(%s)", [sid])
            ren = s.run("select public.owner_ai_session_rename(%s, 'back')", [sid])
            # A tab still holding the deleted chat keeps its paid turn: it lands in a new conversation, not the deleted one.
            fresh = s.value(SAVE, [tid, sid, "after delete", "kept", MODEL])
        conn.execute("reset role")
        counts = su.rows("select (select count(*) from public.owner_ai_sessions where id = %s), "
                         "(select count(*) from public.owner_ai_messages where session_id = %s)", [sid, sid])
    assert gone.ok, gone
    assert counts == [(0, 0)], counts
    assert str(fresh) != sid
    assert sid not in {str(r[0]) for r in listed}, listed
    for out in (again, read, ren):
        assert not out.ok and out.sqlstate == "P0002", out


def test_an_emoji_at_the_title_cut_does_not_fail_and_counts_as_one_character(conn, sc):
    with as_superuser(conn, commit=False) as su:
        t1, t2 = _turn(su, sc.operator), _turn(su, sc.operator)
        q = "a" * 59 + "😀" + "b" * 20
        with acting(conn, sc.operator) as s:
            sid = s.value(SAVE, [t1, None, q, "ok", MODEL])
            # 2000 emoji are 2000 characters to Postgres (4000 UTF-16 units to the browser): within the cap.
            wide = s.run(SAVE, [t2, None, "😀" * 2000, "😀" * 12000, MODEL])
            title = s.value("select title from public.owner_ai_session_list(100, null, null) where id = %s", [sid])
    assert title == "a" * 59 + "😀", title
    assert wide.ok, wide


def test_control_and_bidi_characters_never_reach_a_title(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        tid = _turn(su, sc.operator)
        with acting(conn, sc.operator) as s:
            new = s.value(SAVE, [tid, None, "Revenue \u202eevil\u2066 x\u0007y", "ok", MODEL])
            title = s.value("select title from public.owner_ai_session_list(100, null, null) where id = %s", [new])
            outs = [s.run("select public.owner_ai_session_rename(%s, %s)", [sid, t])
                    for t in ("evil\u202e", "a\u2067b", "bell\u0007", "tab\there")]
        conn.execute("reset role")
        direct = su.run("insert into public.owner_ai_sessions (user_id, title) values (%s, %s)", [sc.operator.uid, "x\u202ey"])
    assert title == "Revenue evil x y", title
    for out in outs:
        assert not out.ok and out.sqlstate == "22023", out
    # The table refuses it too, so a later function cannot forget the check.
    assert not direct.ok and direct.sqlstate == "23514", direct


def test_text_time_and_model_limits_are_enforced(conn, sc):
    with as_superuser(conn, commit=False) as su:
        sid = _seeded_session(su, sc)
        turns = [_turn(su, sc.operator) for _ in range(9)]
        with acting(conn, sc.operator) as s:
            def save(i, q="q", a="a", as_of="now()", model=MODEL):
                return s.run(f"select public.owner_ai_turn_save(%s, null, %s, %s, {as_of}, %s)", [turns[i], q, a, model])
            q_ok = save(0, q="q" * 2000)
            a_ok = save(1, a="a" * 12000)
            no_as_of = save(2, as_of="null")
            q_long = save(3, q="q" * 2001)
            a_long = save(4, a="a" * 12001)
            empty = save(5, a="")
            other_model = save(6, model="openai-gpt-5")
            stale = save(7, as_of="now() - interval '2 days'")
            future = save(8, as_of="now() + interval '2 days'")
            title_long = s.run("select public.owner_ai_session_rename(%s, %s)", [sid, "t" * 61])
            title_blank = s.run("select public.owner_ai_session_rename(%s, '   ')", [sid])
        conn.execute("reset role")
        # A question carrying an as-of time or a model would be a claim nobody made: the table refuses it.
        owner_model = su.run("insert into public.owner_ai_messages (session_id, turn_id, role, text, model) "
                             "values (%s, -1, 'owner', 'q', %s)", [sid, MODEL])
        owner_as_of = su.run("insert into public.owner_ai_messages (session_id, turn_id, role, text, as_of) "
                             "values (%s, -2, 'owner', 'q', now())", [sid])
    assert q_ok.ok and a_ok.ok and no_as_of.ok, (q_ok, a_ok, no_as_of)
    for out in (q_long, a_long, empty, other_model, stale, future, title_long, title_blank):
        assert not out.ok and out.sqlstate == "22023", out
    for out in (owner_model, owner_as_of):
        assert not out.ok and out.sqlstate == "23514", out


def test_list_pages_newest_first_without_skipping_ties_and_rename_does_not_reorder(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("delete from public.owner_ai_sessions where user_id = %s returning 1", [sc.operator.uid])
        # Three chats saved in the same microsecond, between an older and a newer one.
        su.rows("insert into public.owner_ai_sessions (user_id, title, updated_at) values "
                "(%s, 'old', now() - interval '2 days'), (%s, 'tie1', now() - interval '1 day'), (%s, 'tie2', now() - interval '1 day'), "
                "(%s, 'tie3', now() - interval '1 day'), (%s, 'new', now() - interval '1 hour') returning 1", [sc.operator.uid] * 5)
        with acting(conn, sc.operator) as s:
            seen, cursor = [], (None, None)
            for _ in range(5):
                page = s.rows("select id, title, updated_at from public.owner_ai_session_list(2, %s, %s)", list(cursor))
                if not page:
                    break
                seen += [r[1] for r in page]
                cursor = (page[-1][2], page[-1][0])
            old = s.value("select id from public.owner_ai_session_list(100, null, null) where title = 'old'")
            s.run("select public.owner_ai_session_rename(%s, 'renamed old')", [old])
            after = s.rows("select title from public.owner_ai_session_list(100, null, null)")
    assert seen[0] == "new" and seen[-1] == "old", seen
    assert sorted(seen) == sorted(["new", "tie1", "tie2", "tie3", "old"]), seen
    assert [r[0] for r in after][-1] == "renamed old", after
