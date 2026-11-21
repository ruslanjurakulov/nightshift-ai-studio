"""The audit row of a switch between the accounts kept in one browser (migration 0203, audit_account_switch), in a real
database.

Found in review before release (Lens H1, Breach M1): the switch route inserted `account.switch` into app_audit_log
directly, and the database refused every such row (an action outside audit_action_allowed(), and channel_id null for a
non-admin), while the route reported nothing. 0203 adds the action and one SECURITY DEFINER function that writes the row.

What would break without these: an anonymous caller writing switch rows; a person writing a row that says ANOTHER person
switched in (the `to` must always be the caller); p_from being used for anything but the record; the row not being
written at all.
"""

from __future__ import annotations

from sec_db import ANON, MIGRATIONS, acting, as_superuser

MIGRATION = MIGRATIONS / "0203_account_switch_audit.sql"


def _rows(conn, uid):
    # `set local role` from acting() lasts to the end of the outer transaction: read the ground truth as the owner.
    conn.execute("reset role")
    with as_superuser(conn, commit=False) as s:
        return s.rows(
            "select action, target, actor_user_id::text, detail, channel_id from public.app_audit_log "
            "where action = 'account.switch' and actor_user_id = %s order by at",
            [uid],
        )


def test_the_migration_is_in_the_build():
    assert MIGRATION.exists()


# The outer transaction is rolled back; the inner one commits into it, so the row can be read back as the owner.


def test_a_signed_in_person_records_their_own_arrival_with_the_account_they_left(conn, sc):
    a, b = sc.alice.actor, sc.bob.actor
    with conn.transaction(force_rollback=True):
        with acting(conn, b, commit=True) as s:
            out = s.run("select public.audit_account_switch(%s::uuid)", [a.uid])
            assert out.ok, out
        rows = _rows(conn, b.uid)
        assert len(rows) == 1
        action, target, actor, detail, channel = rows[0]
        assert (action, target, actor, channel) == ("account.switch", b.uid, b.uid, None)
        # Ids only, the arrival always the caller.
        assert detail == {"from": a.uid, "to": b.uid}


def test_anon_is_refused(conn):
    with acting(conn, ANON) as s:
        out = s.run("select public.audit_account_switch(null)")
        assert not out.ok and out.sqlstate == "42501", out


def test_nobody_can_write_a_row_about_another_persons_arrival(conn, sc):
    """The only argument is where the caller came FROM: whatever is passed, the row's `to` and actor are the caller."""
    a, b = sc.alice.actor, sc.bob.actor
    with conn.transaction(force_rollback=True):
        with acting(conn, a, commit=True) as s:
            assert s.run("select public.audit_account_switch(%s::uuid)", [b.uid]).ok
        assert _rows(conn, b.uid) == []
        rows = _rows(conn, a.uid)
        assert len(rows) == 1 and rows[0][3] == {"from": b.uid, "to": a.uid}


def test_p_from_is_only_recorded_and_a_switch_to_oneself_is_refused(conn, sc):
    a = sc.alice.actor
    with acting(conn, a) as s:
        same = s.run("select public.audit_account_switch(%s::uuid)", [a.uid])
        assert not same.ok and same.sqlstate == "22023", same
        # An id that names no one is recorded as given and grants nothing: the function reads nothing about it.
        ghost = s.run("select public.audit_account_switch('00000000-0000-4000-8000-000000000000'::uuid)")
        assert ghost.ok, ghost
        assert s.value("select count(*) from public.app_audit_log where actor_user_id <> auth.uid() and action = 'account.switch'") == 0


def test_the_row_is_still_refused_written_directly(conn, sc):
    """The function is the one way: a direct insert of the action stays under 0033's policy (no channel, not an admin)."""
    a = sc.alice.actor
    with acting(conn, a) as s:
        out = s.run(
            "insert into public.app_audit_log (actor_user_id, action, detail, channel_id) values (auth.uid(), 'account.switch', '{}', null)"
        )
        assert not out.ok, out


def test_execute_is_authenticated_only(conn):
    with as_superuser(conn, commit=False) as s:
        assert s.value("select has_function_privilege('anon', 'public.audit_account_switch(uuid)', 'execute')") is False
        assert s.value("select has_function_privilege('authenticated', 'public.audit_account_switch(uuid)', 'execute')") is True
        assert s.value("select public.audit_action_allowed('account.switch')") is True
        assert s.value("select public.audit_action_allowed('video.made_for_kids')") is True
