"""Breach wave 7, lane G: the audit trail (app_audit_log) as evidence (BR-G-008,
fixed by migration 0087).

``app_audit_log_insert`` lets any member who can read a channel add a row to its
stream, on the one condition that ``actor_user_id`` is their own id. The Audit
page prints ``actor_email`` and ``action``, and both were free text the member
chose: a viewer, the lowest role, could write "owner@... did publish.approve"
into the evidence an owner reads after an incident.

Held (a passing test): a row cannot name another person's USER ID, cannot go
into another organization's channel, and the log cannot be edited or deleted.

Fixed (0087): a trigger sets ``actor_email`` from the caller's confirmed
account and ``at`` from the clock, refuses an action the application does not
write (``audit_action_allowed``), and bounds ``target`` and ``detail``.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

from sec_db import ANON, SERVICE, acting, as_superuser, user

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
            as_owner = s.run(INSERT, [sc.alice.actor.uid, who.email, "workflow.run", sc.alice.channel])
            elsewhere = s.run(INSERT, [who.uid, who.email, "workflow.run", sc.bob.channel])
            platform = s.run(INSERT, [who.uid, who.email, "secret.write", None])
    assert not as_owner.ok and as_owner.sqlstate == "42501", as_owner
    assert not elsewhere.ok and elsewhere.sqlstate == "42501", elsewhere
    assert not platform.ok and platform.sqlstate == "42501", platform


def test_the_log_is_append_only_for_members(conn, sc):
    with a_viewer_of_org_a(conn, sc) as (_su, who):
        with acting(conn, who) as s:
            row = s.run(INSERT, [who.uid, who.email, "workflow.run", sc.alice.channel])
            assert row.ok, row
            upd = s.run("update public.app_audit_log set action = 'x' where actor_user_id = %s", [who.uid])
            dele = s.run("delete from public.app_audit_log where actor_user_id = %s", [who.uid])
    assert upd.ok and upd.rowcount == 0, upd
    assert dele.ok and dele.rowcount == 0, dele


def test_BR_G_008_an_audit_row_names_only_the_person_who_wrote_it(conn, sc):
    owner_email = sc.alice.actor.email
    with a_viewer_of_org_a(conn, sc) as (_su, who):
        with acting(conn, who) as s:
            out = s.run(INSERT, [who.uid, owner_email, "workflow.run", sc.alice.channel])
            assert out.ok, out
            s.conn.execute("reset role")
            shown = s.value("select actor_email from public.app_audit_log where id = %s", [out.rows[0][0]])
    assert shown == who.email, f"the Audit page would show {shown!r} as the actor of workflow.run"


def test_BR_G_008_an_unconfirmed_account_has_no_address_to_show(conn, sc):
    who = user("w7-unconfirmed", "w7-unconfirmed@a.test")
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, null) returning 1", [who.uid, who.email])
        su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
                [sc.alice.org, who.uid, who.email])
        with acting(conn, who) as s:
            out = s.run(INSERT, [who.uid, "owner@x.test", "workflow.run", sc.alice.channel])
            assert out.ok, out
            s.conn.execute("reset role")
            assert s.value("select actor_email from public.app_audit_log where id = %s", [out.rows[0][0]]) is None


def test_BR_G_008_the_time_of_a_row_is_the_databases(conn, sc):
    with a_viewer_of_org_a(conn, sc) as (_su, who):
        with acting(conn, who) as s:
            out = s.run("insert into public.app_audit_log (actor_user_id, at, action, channel_id) "
                        "values (%s, '1999-01-01', 'workflow.run', %s) returning id", [who.uid, sc.alice.channel])
            assert out.ok, out
            s.conn.execute("reset role")
            assert s.value("select at > now() - interval '1 minute' from public.app_audit_log where id = %s",
                           [out.rows[0][0]]) is True


def test_BR_G_008_only_actions_the_application_writes_are_accepted(conn, sc):
    with a_viewer_of_org_a(conn, sc) as (_su, who):
        with acting(conn, who) as s:
            for action in ("publish.approve", "owner.removed", "", "workflow.run ", "WORKFLOW.RUN", "social.facebook.connect",
                           "learning.delete", "x" * 500):
                out = s.run(INSERT, [who.uid, who.email, action, sc.alice.channel])
                assert not out.ok and out.sqlstate == "22023", (action, out)
            for action in ("workflow.run", "social.tiktok.connect_failed", "learning.approve", "secret.write",
                           "storyboard.approve"):
                out = s.run(INSERT, [who.uid, who.email, action, sc.alice.channel])
                assert out.ok, (action, out)


def test_BR_G_008_target_and_detail_are_bounded(conn, sc):
    with a_viewer_of_org_a(conn, sc) as (_su, who):
        with acting(conn, who) as s:
            long_target = s.run("insert into public.app_audit_log (actor_user_id, action, target, channel_id) "
                                "values (%s, 'workflow.run', %s, %s)", [who.uid, "t" * 201, sc.alice.channel])
            big = s.run("insert into public.app_audit_log (actor_user_id, action, detail, channel_id) "
                        "values (%s, 'workflow.run', %s::jsonb, %s)", [who.uid, json.dumps({"k": "v" * 5000}), sc.alice.channel])
            not_object = s.run("insert into public.app_audit_log (actor_user_id, action, detail, channel_id) "
                               "values (%s, 'workflow.run', '[1]'::jsonb, %s)", [who.uid, sc.alice.channel])
            fine = s.run("insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id) "
                         "values (%s, 'workflow.run', %s, %s::jsonb, %s)",
                         [who.uid, "t" * 200, json.dumps({"names": ["a", "b"]}), sc.alice.channel])
    for out in (long_target, big, not_object):
        assert not out.ok and out.sqlstate == "22023", out
    assert fine.ok, fine


def test_the_functions_that_audit_their_own_work_still_write_and_name_the_caller(conn, sc):
    """create_api_key (0042) writes 'api_key.create' itself; the trigger holds
    that row to the same rules and the caller's confirmed address is on it."""
    with acting(conn, sc.alice.actor) as s:
        made = s.run("select public.create_api_key(%s, 'w7-key', 1000)", [sc.alice.org])
        assert made.ok, made
        s.conn.execute("reset role")
        rows = s.rows("select actor_email, action from public.app_audit_log where action = 'api_key.create' "
                      "and actor_user_id = %s", [sc.alice.actor.uid])
    assert rows and all(tuple(r) == (sc.alice.actor.email, "api_key.create") for r in rows), rows


def test_anon_writes_nothing_and_the_service_role_writes_any_row(conn, sc):
    with acting(conn, ANON) as s:
        out = s.run(INSERT, [sc.alice.actor.uid, "x@y.test", "workflow.run", sc.alice.channel])
        assert not out.ok and out.sqlstate == "42501", out
    with acting(conn, SERVICE) as s:
        out = s.run("insert into public.app_audit_log (actor_user_id, actor_email, action, channel_id) "
                    "values (%s, 'bot@nightshift.test', 'worker.sweep', %s) returning id", [None, sc.alice.channel])
        assert out.ok, out


# ── the value-built actions ──────────────────────────────────────────────────
# (The scan that every logAudit action in the Command Center is in the list is a
# unit test: tests/test_audit_actions.py.)

def test_the_value_built_actions_match_the_two_patterns(conn):
    with as_superuser(conn, commit=False) as su:
        def ok(a):
            return su.value("select public.audit_action_allowed(%s)", [a])

        for platform in ("instagram", "tiktok"):
            for verb in ("connect", "connect_failed", "disconnect"):
                assert ok(f"social.{platform}.{verb}"), (platform, verb)
        assert ok("learning.approve") and ok("learning.reject")
        assert not ok("learning.other") and not ok("social.youtube.connect") and not ok(None)
