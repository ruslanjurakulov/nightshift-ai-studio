"""The owner's facts for Nightshift Brain (migration 0197) reach the platform owner and no one else.

An owner-data leak is CRITICAL: the facts name workspaces and plans, and say what the platform's queues, tokens and bot are
doing. A customer, a workspace admin, a platform admin who is not the owner, anon and the service key are all refused before
anything is read; a password-only owner is refused while 0107's second-factor gate is on.
"""

from __future__ import annotations

import json
import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user

CALLS = ["select public.owner_brain_people()", "select public.owner_brain_health()"]
IDS = ["people", "health"]
SECRETS = ("vault_secret_id", "access_token", "refresh_token", "@example.test", "password")


@pytest.mark.parametrize("q", CALLS, ids=IDS)
@pytest.mark.parametrize("who", ["alice", "bob", "dana", "admin"])
def test_no_one_but_the_owner_gets_the_owner_facts(conn, sc, who, q):
    # A platform admin who is not the owner is refused too: the facts are the owner's, not the staff's.
    with as_superuser(conn, commit=False) as su:
        admin = user("ob-admin", "ob-admin@example.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [admin.uid, admin.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [admin.uid, admin.email])
        actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "dana": sc.dana, "admin": admin}[who]
        with acting(conn, actor) as s:
            out = s.run(q)
    assert not out.ok and out.sqlstate == "42501", (who, out)


@pytest.mark.parametrize("q", CALLS, ids=IDS)
def test_anon_and_the_service_key_cannot_call_them(conn, sc, q):
    for who in (ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run(q)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


@pytest.mark.parametrize("q", CALLS, ids=IDS)
def test_the_owner_gets_json_with_its_time_and_no_secret(conn, sc, q):
    with acting(conn, sc.operator) as s:
        out = s.run(q)
    assert out.ok, out
    doc = out.rows[0][0]
    assert isinstance(doc, dict) and doc.get("as_of"), doc
    text = json.dumps(doc, default=str)
    for word in SECRETS:
        assert word not in text, (word, text[:400])


def test_people_leave_out_the_operators_own_workspace(conn, sc):
    with acting(conn, sc.operator) as s:
        out = s.run("select public.owner_brain_people()")
    assert out.ok, out
    assert out.rows[0][0]["internal_excluded"] is True


def test_a_trial_is_not_paying_and_a_typed_address_never_reaches_the_owners_ai(conn, sc):
    """A workspace name is customer-typed text: an address in it is masked before the owner's AI sees it, and a trial is
    counted apart from paying workspaces."""
    with as_superuser(conn, commit=False) as su:
        plan = su.value("select id from public.plans order by id limit 1")
        with acting(conn, sc.operator) as s:
            before = s.run("select public.owner_brain_people()").rows[0][0]
        su.rows("update public.organizations set name = 'Shop of leak.me@example.test' where id = %s returning 1", [sc.alice.org])
        su.rows("insert into public.subscriptions (org_id, provider_subscription_id, plan_id, status, last_event_at) "
                "values (%s, 'sub_labtrial0001', %s, 'trialing', now()) returning 1", [sc.alice.org, plan])
        with acting(conn, sc.operator) as s:
            out = s.run("select public.owner_brain_people()")
    assert out.ok, out
    doc = out.rows[0][0]
    assert "leak.me@example.test" not in json.dumps(doc), doc
    assert doc["trialing_by_plan"].get(plan, 0) == before["trialing_by_plan"].get(plan, 0) + 1, doc
    assert doc["paying_by_plan"] == before["paying_by_plan"], doc
    names = [r["workspace"] for r in doc["recent_plan_changes"]]
    assert "Shop of [address]" in names and doc["untrusted_fields"], doc


def test_health_says_ci_is_not_in_the_database(conn, sc):
    with acting(conn, sc.operator) as s:
        out = s.run("select public.owner_brain_health()")
    assert out.ok, out
    assert out.rows[0][0]["ci_deploy"]["state"] == "not_in_database"


def test_with_the_mfa_gate_on_a_password_only_owner_reads_nothing(conn, sc):
    """Unlike the hub's reads, these facts are what the owner's AI hands a model: a stolen password must not read them."""
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.owner_security_settings set admin_aal2_required = true returning 1")
        su.rows("insert into auth.mfa_factors (id, user_id, status) values (%s, %s, 'verified') returning 1", [str(uuid.uuid4()), sc.operator.uid])
        outs = []
        for q in CALLS:
            with acting(conn, sc.operator) as s:
                outs.append(s.run(q))
    for out in outs:
        assert not out.ok and out.sqlstate == "NS401", out
