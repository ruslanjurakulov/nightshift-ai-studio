"""A workspace has one person (migration 0091), and the roster is the operator's.

History: 0043 made an invite an offer (a confirmed address, an explicit accept) after
two holes (audit P1, C6: a JWT `email` claim is no proof of an address, and a pending
invite already was membership). 0091 (owner decision: no team, no roles, no invites on
the customer side) removes the offer itself:

* invite_org_member, accept_org_invite, decline_org_invite and my_invites are closed
  to every API role, owner included;
* org_members cannot be written from a browser: no insert, no role change, no delete;
* a signed-in caller can never add a second person to a workspace, even through a
  definer function that a later migration grants by mistake (BEFORE INSERT trigger);
* the migration deletes every pending invitation and leaves existing bound members as
  they are, and is safe to run twice.

The platform roster (app_members) is the operator and keeps its bind-on-sign-in for a
confirmed address; its tests stay below.
"""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from pathlib import Path

from sec_db import Actor, Session, as_superuser


@contextmanager
def scratch(conn):
    """One rolled-back transaction in which the test can create accounts and
    invites as the owner, then act as anyone (`become`)."""
    with as_superuser(conn, commit=False) as s:
        def become(who: Actor | None):
            conn.execute("reset role")
            if who is None:
                conn.execute("select set_config('request.jwt.claims', '', true)")
                return
            conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            conn.execute(f"set local role {who.role}")
        yield s, become


def _account(s: Session, email: str, *, confirmed: bool, jwt_email: str | None = None) -> Actor:
    uid = str(uuid.uuid4())
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, %s) returning 1",
           [uid, email, "now()" if confirmed else None])
    return Actor(email.split("@")[0], "authenticated", uid, jwt_email or email)


def _invite(s: Session, org: str, email: str, role: str = "admin") -> str:
    return str(s.value("insert into public.org_members (org_id, email, role) values (%s, %s, %s) returning id",
                       [org, email, role]))



LEGACY = "ivan@a.test"
M91 = (Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "0091_simple_accounts.sql").read_text(encoding="utf-8")
CLOSED = (
    "select public.invite_org_member(%s, 'new@a.test', 'viewer')",
    "select public.accept_org_invite(%s)",
    "select public.decline_org_invite(%s)",
    "select * from public.my_invites()",
)


def _call(s, q, org, inv):
    return s.run(q, [org] if "invite_org_member" in q else [inv] if "%s" in q else None)


def test_nobody_can_invite_accept_decline_or_list_an_invitation(conn, sc):
    # Not the owner of the workspace, not a stranger, not the addressee, not the operator.
    with scratch(conn) as (s, become):
        inv = s.value("select id from public.org_members where org_id = %s and email = %s", [sc.alice.org, LEGACY])
        for who in (sc.alice.actor, sc.bob.actor, sc.invitee, sc.stranger, sc.operator):
            become(who)
            for q in CLOSED:
                out = _call(s, q, sc.alice.org, inv)
                assert not out.ok and out.sqlstate == "42501", (who.name, q, out)
        become(sc.alice.actor)
        assert s.run("select public.bind_org_memberships()").ok  # kept for older dashboards: binds nothing
        become(None)
        assert s.value("select user_id from public.org_members where id = %s", [inv]) is None


def test_the_four_functions_are_executable_by_no_api_role(conn, sc):
    with scratch(conn) as (s, become):
        for sig in ("invite_org_member(uuid,text,text)", "accept_org_invite(uuid)", "decline_org_invite(uuid)", "my_invites()"):
            for role in ("anon", "authenticated"):
                assert s.value("select has_function_privilege(%s, %s, 'execute')", [role, f"public.{sig}"]) is False, (sig, role)


def test_a_member_row_cannot_be_added_changed_or_removed_from_a_browser(conn, sc):
    with scratch(conn) as (s, become):
        owner_row = s.value("select id from public.org_members where org_id = %s and user_id = %s", [sc.alice.org, sc.alice.actor.uid])
        members_before = s.value("select count(*) from public.org_members where org_id = %s", [sc.alice.org])
        for who in (sc.alice.actor, sc.bob.actor, sc.operator):
            become(who)
            ins = s.run("insert into public.org_members (org_id, email, role) values (%s, 'x@a.test', 'viewer')", [sc.alice.org])
            assert not ins.ok and ins.sqlstate == "42501", (who.name, ins)
            ins2 = s.run("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'y@a.test', 'owner')",
                         [sc.alice.org, sc.stranger.uid])
            assert not ins2.ok and ins2.sqlstate == "42501", (who.name, ins2)
            upd = s.run("update public.org_members set role = 'viewer' where id = %s", [owner_row])
            assert not upd.ok and upd.sqlstate == "42501", (who.name, upd)
            dele = s.run("delete from public.org_members where id = %s", [owner_row])
            assert not dele.ok and dele.sqlstate == "42501", (who.name, dele)
        become(None)
        assert s.value("select role from public.org_members where id = %s", [owner_row]) == "owner"
        assert s.value("select count(*) from public.org_members where org_id = %s", [sc.alice.org]) == members_before
        for priv in ("INSERT", "UPDATE", "DELETE"):
            for role in ("anon", "authenticated"):
                assert s.value("select has_table_privilege(%s, 'public.org_members', %s)", [role, priv]) is False, (role, priv)
        assert s.value("select count(*) from pg_policies where schemaname = 'public' and tablename = 'org_members' "
                       "and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')") == 0


def test_even_a_definer_path_cannot_add_a_second_person(conn, sc):
    # What a later migration's careless grant would look like: code running as the
    # database owner on behalf of a signed-in caller (claims set, role not authenticated).
    with scratch(conn) as (s, become):
        become(sc.alice.actor)
        s.conn.execute("reset role")
        out = s.run("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'z@a.test', 'editor')",
                    [sc.alice.org, sc.stranger.uid])
        assert not out.ok and out.sqlstate == "42501" and "one person" in (out.error or ""), out
        # The control: a new workspace gets its first (owner) row through the one door that exists...
        become(sc.alice.actor)
        org = s.value("select public.create_organization('Second Studio')")
        assert s.value("select count(*) from public.org_members where org_id = %s", [org]) == 1
        assert s.value("select role from public.org_members where org_id = %s", [org]) == "owner"
        s.conn.execute("reset role")
        again = s.run("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'q@a.test', 'viewer')", [org, sc.stranger.uid])
        assert not again.ok and again.sqlstate == "42501", again
        # ...and the SQL editor (no auth.uid()) can still repair.
        become(None)
        assert s.run("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'r@a.test', 'viewer')",
                     [org, sc.stranger.uid]).ok


def test_the_migration_deletes_pending_invites_keeps_members_and_replays(conn, sc):
    with scratch(conn) as (s, become):
        # Another legacy invite, to an owner role, in the operator's organization; plus Ivan bound as an
        # extra viewer of org B (an existing extra member the migration must not touch).
        s.rows("insert into public.org_members (org_id, email, role) values (%s, 'late@b.test', 'owner') returning 1", [sc.bob.org])
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'dana2@b.test', 'viewer') returning 1",
               [sc.bob.org, sc.dana.uid])
        before = s.rows("select org_id, user_id, role from public.org_members where user_id is not null order by 1, 2")
        assert s.value("select count(*) from public.org_members where user_id is null") >= 2
        for _ in range(2):  # replay-twice
            conn.execute(M91)
            assert s.value("select count(*) from public.org_members where user_id is null") == 0
            assert s.rows("select org_id, user_id, role from public.org_members where user_id is not null order by 1, 2") == before
        # Nobody lost access and nobody gained any: the extra viewer still reads, as a viewer only.
        become(sc.dana)
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.bob.org]) is True
        assert s.value("select public.is_org_member(%s, 'editor')", [sc.bob.org]) is False
        become(sc.bob.actor)
        assert s.value("select public.org_role(%s)", [sc.bob.org]) == "owner"
        # The addressee of a deleted invitation has nothing to accept or claim.
        become(sc.invitee)
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False


def test_an_unconfirmed_address_does_not_claim_the_platform_roster(conn, sc):
    with scratch(conn) as (s, become):
        s.rows("insert into public.app_members (email, role) values ('opsadmin@nightshift.test', 'admin') returning 1")
        mallory = _account(s, "opsadmin@nightshift.test", confirmed=False)
        become(mallory)
        assert s.value("select public.platform_role()") is None
        assert s.value("select public.bind_current_member()") is None
        assert s.value("select public.is_platform_admin()") is False
        become(None)
        assert s.value("select user_id from public.app_members where email = 'opsadmin@nightshift.test'") is None


def test_the_platform_roster_still_binds_a_confirmed_invitee(conn, sc):
    with scratch(conn) as (s, become):
        s.rows("insert into public.app_members (email, role) values ('Ops@Nightshift.test', 'admin') returning 1")
        ops = _account(s, "ops@nightshift.test", confirmed=True)
        become(ops)
        assert s.value("select public.bind_current_member()") == "admin"
        assert s.value("select public.is_platform_admin()") is True


def test_existing_bound_memberships_keep_working(conn, sc):
    # The change must not lock out anyone already in: the owners of A and B,
    # the operator, and the default org's bound member.
    with scratch(conn) as (s, become):
        for who, org in ((sc.alice.actor, sc.alice.org), (sc.bob.actor, sc.bob.org),
                         (sc.dana, "00000000-0000-0000-0000-000000000001")):
            become(who)
            assert s.value("select public.is_org_member(%s, 'viewer')", [org]) is True, who.name
        become(sc.operator)
        assert s.value("select public.is_platform_admin()") is True
        assert s.value("select public.is_org_member(%s, 'admin')", [sc.bob.org]) is True
