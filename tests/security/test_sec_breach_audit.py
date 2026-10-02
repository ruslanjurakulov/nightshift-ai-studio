"""Breach wave 7, lane G: the audit trail (app_audit_log) as evidence.

``app_audit_log_insert`` lets any member who can read a channel add a row to its
stream, on the one condition that ``actor_user_id`` is their own id. The Audit
page prints ``actor_email`` and ``action``, and both are free text the member
chooses. A viewer, the lowest role, can therefore write "owner@... did
publish.approve" into the evidence an owner reads after an incident.

Held (a passing test): a row cannot name another person's USER ID, cannot go
into another organization's channel, and the log cannot be edited or deleted.

Open (xfail strict): BR-G-008, the e-mail (and so the person the page names) is
whatever the caller types.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import pytest

from sec_db import acting, as_superuser, user

INSERT = ("insert into public.app_audit_log (actor_user_id, actor_email, action, target, channel_id) "
          "values (%s, %s, %s, 'x', %s) returning id")


@contextmanager
def a_viewer_of_org_a(conn, sc):
    who = user("w7-audit-viewer", "w7-audit-viewer@a.test")
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                [who.uid, who.email])
        su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
                [sc.alice.org, who.uid, who.email])
        yield su, who


def test_a_member_cannot_write_a_row_in_someone_elses_name_or_another_organizations_stream(conn, sc):
    with a_viewer_of_org_a(conn, sc) as (_su, who):
        with acting(conn, who) as s:
            as_owner = s.run(INSERT, [sc.alice.actor.uid, who.email, "member.remove", sc.alice.channel])
            elsewhere = s.run(INSERT, [who.uid, who.email, "member.remove", sc.bob.channel])
            platform = s.run(INSERT, [who.uid, who.email, "secrets.update", None])
    assert not as_owner.ok and as_owner.sqlstate == "42501", as_owner
    assert not elsewhere.ok and elsewhere.sqlstate == "42501", elsewhere
    assert not platform.ok and platform.sqlstate == "42501", platform


def test_the_log_is_append_only_for_members(conn, sc):
    with a_viewer_of_org_a(conn, sc) as (_su, who):
        with acting(conn, who) as s:
            row = s.run(INSERT, [who.uid, who.email, "note", sc.alice.channel])
            assert row.ok, row
            upd = s.run("update public.app_audit_log set action = 'x' where actor_user_id = %s", [who.uid])
            dele = s.run("delete from public.app_audit_log where actor_user_id = %s", [who.uid])
    assert upd.ok and upd.rowcount == 0, upd
    assert dele.ok and dele.rowcount == 0, dele


@pytest.mark.xfail(strict=True, reason="BR-G-008 open: actor_email of an audit row is whatever the member types")
def test_BR_G_008_an_audit_row_names_only_the_person_who_wrote_it(conn, sc):
    owner_email = sc.alice.actor.email
    with a_viewer_of_org_a(conn, sc) as (_su, who):
        with acting(conn, who) as s:
            out = s.run(INSERT, [who.uid, owner_email, "publish.approve", sc.alice.channel])
            if out.ok:
                s.conn.execute("reset role")
                shown = s.value("select actor_email from public.app_audit_log where id = %s", [out.rows[0][0]])
                assert shown != owner_email, f"the Audit page would show {shown!r} as the actor of publish.approve"
