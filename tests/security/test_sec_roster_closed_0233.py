"""Migration 0233: nobody adds a person to the platform roster, changes a role on it or removes a person from it from a browser
(BR-L-213).

The owner's decision: the site has the operator and users, each user owns their own workspace, nobody is added to anybody's.
0091 closed the workspace side (test_sec_invites.py). The Command Center's Team page was the last screen that wrote the operator's
roster; it is gone, and before 0233 the database still let a signed-in platform owner or admin do everything it did:

* call owner_add_member / owner_set_member_role / owner_remove_member (0107, granted to authenticated);
* insert, update or delete app_members rows directly through REST (0007's policies, Supabase's default privileges), which also
  skipped 0107's last-owner, self-change and owner-only checks;
* on an empty roster, let the first default-org member insert themselves as owner (0018's bootstrap policy).

What would break without these tests: a later file that re-grants any of it (re-applying 0007, 0018 or 0107 does), and nobody
notices that a browser can mint an admin of the platform again. What must keep working is pinned too: the operator still reads
the roster and is still the platform owner, a row the operator adds in the SQL editor still binds on sign-in, the service role
(the workers) keeps its privileges, and a customer is still the owner of their own workspace.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import pytest

from sec_db import ANON, MIGRATION_0233, SERVICE, Actor, as_superuser, has_0233, put_back_0233, take_off_0233

ROSTER_CALLS = (
    "select public.owner_add_member('evil-0233@x.test', 'admin')",
    "select public.owner_set_member_role(gen_random_uuid(), 'owner')",
    "select public.owner_remove_member(gen_random_uuid())",
)
DIRECT = (
    "insert into public.app_members (email, role) values ('direct-0233@x.test', 'admin')",
    "update public.app_members set role = 'viewer'",
    "delete from public.app_members",
)


@contextmanager
def scratch(conn):
    """One rolled-back transaction in which the test can seed as the owner, then act as anyone (`become`)."""
    with as_superuser(conn, commit=False) as s:
        def become(who: Actor | None):
            conn.execute("reset role")
            if who is None:
                conn.execute("select set_config('request.jwt.claims', '', true)")
                return
            conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            conn.execute(f"set local role {who.role}")
        yield s, become


def _admin(s, sc):
    """Dana (a member of the operator's organization) made a platform admin the only way left: the SQL editor."""
    s.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [sc.dana.uid, sc.dana.email])


def test_the_lab_has_0233_on():
    # The other tests mean nothing on a database where the file did not apply.
    assert MIGRATION_0233.exists()


def test_no_api_role_may_execute_a_roster_function(conn, sc):
    with scratch(conn) as (s, become):
        assert has_0233(s.conn)
        for role in ("anon", "authenticated", "service_role"):
            for sig in ("public.owner_add_member(text,text,text)", "public.owner_set_member_role(uuid,text,text)",
                        "public.owner_remove_member(uuid,text)"):
                assert s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [role, sig]) is False, (role, sig)


@pytest.mark.parametrize("call", ROSTER_CALLS)
def test_the_platform_owner_and_an_admin_are_refused_by_every_roster_function(conn, sc, call):
    with scratch(conn) as (s, become):
        _admin(s, sc)
        before = s.value("select count(*) from public.app_members")
        trail = s.value("select count(*) from public.security_events")
        for who in (sc.operator, sc.dana, sc.bob.actor, sc.stranger, ANON):
            become(who)
            out = s.run(call)
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        become(None)
        assert s.value("select count(*) from public.app_members") == before
        assert s.value("select count(*) from public.security_events") == trail


@pytest.mark.parametrize("stmt", DIRECT)
def test_nobody_writes_the_roster_directly_from_a_browser(conn, sc, stmt):
    with scratch(conn) as (s, become):
        _admin(s, sc)
        rows = s.value("select count(*) from public.app_members")
        roles = s.rows("select id, role from public.app_members order by id")
        for who in (sc.operator, sc.dana, sc.bob.actor, sc.stranger, ANON):
            become(who)
            out = s.run(stmt)
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        become(None)
        assert s.value("select count(*) from public.app_members") == rows
        assert s.rows("select id, role from public.app_members order by id") == roles


def test_an_empty_roster_cannot_be_claimed_from_a_page_any_more(conn, sc):
    # 0018's bootstrap policy let a default-org member insert themselves as owner while the table was empty. The operator is one.
    with scratch(conn) as (s, become):
        s.rows("delete from public.app_members returning 1")
        become(sc.operator)
        out = s.run("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner')", [sc.operator.uid, sc.operator.email])
        assert not out.ok and out.sqlstate == "42501", out
        become(None)
        assert s.value("select count(*) from public.app_members") == 0


def test_what_the_operator_and_the_workers_still_have(conn, sc):
    with scratch(conn) as (s, become):
        become(sc.operator)
        assert s.value("select public.platform_role()") == "owner"
        assert s.value("select public.is_platform_admin()") is True
        assert s.value("select count(*) from public.app_members") >= 1  # the roster still reads (Approvals, platform_role)
        # a customer is still the owner of their own workspace, and of nothing else
        become(sc.bob.actor)
        assert s.value("select public.org_role(%s)", [sc.bob.org]) == "owner"
        assert s.value("select public.is_org_member(%s, 'editor')", [sc.bob.org]) is True
        assert s.value("select public.is_platform_admin()") is False
        # the service role (workers, the SQL path) keeps its privileges on the table
        become(SERVICE)
        assert s.run("insert into public.app_members (email, role) values ('svc-0233@x.test', 'viewer')").ok
        assert s.run("delete from public.app_members where email = 'svc-0233@x.test'").ok


def test_a_row_the_operator_adds_in_the_sql_editor_still_binds_on_sign_in(conn, sc):
    with scratch(conn) as (s, become):
        s.rows("insert into public.app_members (email, role) values (%s, 'admin') returning 1", [sc.stranger.email])
        become(sc.stranger)
        assert s.value("select public.bind_current_member()") == "admin"
        assert s.value("select public.is_platform_admin()") is True


def test_the_file_replays_and_its_rollback_reopens_exactly_what_it_closed(conn, sc):
    with scratch(conn) as (s, become):
        s.conn.execute(MIGRATION_0233.read_text(encoding="utf-8"))  # a second apply is a no-op
        assert has_0233(s.conn)
        take_off_0233(s.conn)
        assert not has_0233(s.conn)
        assert s.value("select has_function_privilege('anon', 'public.owner_add_member(text,text,text)', 'EXECUTE')") is False
        assert s.value("select has_function_privilege('service_role', 'public.owner_add_member(text,text,text)', 'EXECUTE')") is False
        assert s.value("select has_table_privilege('authenticated', 'public.app_members', 'INSERT')") is True
        # reopened, the finding is back: the operator mints an admin from a browser session
        become(sc.operator)
        assert s.value("select public.owner_add_member('back-0233@x.test', 'admin')")["ok"] is True
        become(None)
        s.rows("delete from public.app_members where email = 'back-0233@x.test' returning 1")
        put_back_0233(s.conn)
        assert has_0233(s.conn)
        become(sc.operator)
        assert s.run(ROSTER_CALLS[0]).sqlstate == "42501"


def test_the_file_refuses_when_the_workspace_side_was_reopened(conn, sc):
    # A re-applied 0018 re-grants org_members writes; 0233 says to apply 0091 again rather than pass over it.
    with scratch(conn) as (s, become):
        s.conn.execute("grant insert on public.org_members to authenticated")
        out = s.run(MIGRATION_0233.read_text(encoding="utf-8"))
        assert not out.ok and "apply 0091 again" in (out.error or ""), out


def test_the_file_has_no_backslash_and_drops_nothing():
    text = MIGRATION_0233.read_text(encoding="utf-8")
    assert "\\" not in text
    code = "\n".join(ln.split("--", 1)[0] for ln in text.splitlines()).lower()
    for word in ("drop ", "create or replace", "alter table", "alter function", "grant "):
        assert word not in code, word
