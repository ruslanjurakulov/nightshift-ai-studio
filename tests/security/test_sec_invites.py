"""Invites (migration 0043): a confirmed address, and an explicit yes.

Each test here failed against 0001–0033 (audit P1, C6):

* P1 — an invite was claimed by the JWT's `email` claim, which an account
  whose address is NOT confirmed carries too. Signing up as the invited
  address was enough to join the org at the invited role, and for the
  platform roster, to become platform admin.
* C6 — a pending invite already was membership (accessible_org_ids matched
  it by email), and bind_org_memberships(), called on every dashboard page
  load, bound it without asking the invitee.
"""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager

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


def test_an_unconfirmed_address_does_not_claim_an_invite(conn, sc):
    with scratch(conn) as (s, become):
        inv = _invite(s, sc.alice.org, "newhire@a.test", "owner")
        mallory = _account(s, "newhire@a.test", confirmed=False)
        become(mallory)
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False
        assert s.rows("select id from public.my_invites()") == []
        s.value("select public.bind_org_memberships()")
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False
        out = s.run("select public.accept_org_invite(%s)", [inv])
        assert not out.ok and out.sqlstate == "42501", out
        become(None)
        assert s.value("select user_id from public.org_members where id = %s", [inv]) is None


def test_a_jwt_email_claim_is_not_proof_of_the_address(conn, sc):
    # Confirmed account, but for a different address than the claim says.
    with scratch(conn) as (s, become):
        inv = _invite(s, sc.alice.org, "cfo@a.test")
        eve = _account(s, "eve@evil.test", confirmed=True, jwt_email="cfo@a.test")
        become(eve)
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False
        assert s.rows("select id from public.my_invites()") == []
        assert not s.run("select public.accept_org_invite(%s)", [inv]).ok


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


def test_a_pending_invite_is_not_membership_until_accepted(conn, sc):
    ivan = sc.invitee  # confirmed, invited to org A as viewer by Alice
    with scratch(conn) as (s, become):
        become(ivan)
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False
        assert s.rows("select channel_id from public.channels where org_id = %s", [sc.alice.org]) == []
        s.value("select public.bind_org_memberships()")  # what every page load used to do
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False
        invites = s.rows("select id, org_id, org_name from public.my_invites()")
        assert [(str(r[1]), r[2]) for r in invites] == [(sc.alice.org, "Alice Studio")]
        assert str(s.value("select public.accept_org_invite(%s)", [invites[0][0]])) == sc.alice.org
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is True
        assert s.value("select public.is_org_member(%s, 'editor')", [sc.alice.org]) is False
        assert s.rows("select id from public.my_invites()") == []


def test_declining_removes_the_offer(conn, sc):
    ivan = sc.invitee
    with scratch(conn) as (s, become):
        become(ivan)
        inv = s.value("select id from public.my_invites()")
        assert s.value("select public.decline_org_invite(%s)", [inv]) is True
        assert s.rows("select id from public.my_invites()") == []
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False
        become(None)
        assert s.value("select count(*) from public.org_members where id = %s", [inv]) == 0


def test_nobody_answers_someone_elses_invite(conn, sc):
    with scratch(conn) as (s, become):
        inv = s.value("select id from public.org_members where email = %s", [sc.invitee.email])
        for who in (sc.bob.actor, sc.stranger, sc.alice.actor):
            become(who)
            assert not s.run("select public.accept_org_invite(%s)", [inv]).ok, who.name
            assert not s.run("select public.decline_org_invite(%s)", [inv]).ok, who.name
        become(None)
        assert s.value("select user_id from public.org_members where id = %s", [inv]) is None


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
