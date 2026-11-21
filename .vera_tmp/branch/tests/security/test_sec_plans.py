"""Attacks on plans, subscriptions and credit lots (migration 0034).

What a malicious customer would try: mint subscription credits, give their
organization a better plan, raise their plan's allowance, stretch a lot's
expiry, or read another organization's billing. Bob (org B, on Pro) attacks;
Alice (org A, on Creator) is the victim where there is one.
"""

from __future__ import annotations

import pytest

sec_db = pytest.importorskip("sec_db")  # the lab's own harness (tests/security/conftest.py)

from sec_db import ANON, acting, as_superuser  # noqa: E402


def truth(conn, query, params=None):
    with as_superuser(conn, commit=False) as s:
        return s.value(query, params)


def refused(out) -> bool:
    return (not out.ok) or out.rowcount == 0


# ── minting ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("query", [
    "select public.grant_subscription_credits(%(org)s, 'sub_01evil00000000000000000000', 'studio', now(), "
    "now() + interval '30 days', 'txn_01evil00000000000000000000')",
    "select public.upsert_subscription(%(org)s, 'sub_01evil00000000000000000000', null, 'studio', null, 'active', "
    "now(), now() + interval '30 days', false, null, now())",
    "select public.expire_credit_lots(%(org)s)",
    "select public.credit_lots_add_locked(%(org)s, 'grant', 100000, null, null, null, 'free')",
    "select public.credit_expire_lots_locked(%(org)s)",
    "select public.org_entitlements_internal(%(victim)s)",
])
def test_customer_cannot_call_the_subscription_or_lot_functions(conn, sc, query):
    before = truth(conn, "select balance from public.credit_accounts where org_id = %s", [sc.bob.org])
    with acting(conn, sc.bob.actor) as s:
        out = s.run(query, {"org": sc.bob.org, "victim": sc.alice.org})
    assert not out.ok and out.sqlstate == "42501", out
    assert truth(conn, "select balance from public.credit_accounts where org_id = %s", [sc.bob.org]) == before


def test_customer_cannot_change_their_own_plan(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        attempts = [
            s.run("update public.subscriptions set plan_id = 'studio' where org_id = %s", [sc.bob.org]),
            s.run("update public.subscriptions set status = 'active', current_period_end = now() + interval '10 years' "
                  "where org_id = %s", [sc.bob.org]),
            s.run("insert into public.subscriptions (org_id, provider_subscription_id, plan_id, status) "
                  "values (%s, 'sub_01evil00000000000000000001', 'studio', 'active')", [sc.bob.org]),
            s.run("delete from public.subscriptions where org_id = %s", [sc.bob.org]),
        ]
    for out in attempts:
        assert refused(out), out
    assert truth(conn, "select public.org_plan_internal(%s)", [sc.bob.org]) == "pro"


def test_customer_cannot_raise_their_plans_allowance_or_limits(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        attempts = [
            s.run("update public.plans set monthly_credits = 1000000 where id = 'pro'"),
            s.run("update public.plans set is_default = false where is_default"),
            s.run("insert into public.plans (id, name, monthly_credits) values ('evil', 'Evil', 1000000)"),
            s.run("update public.plan_entitlements set value = '1000' where plan_id = 'pro' and key = 'concurrency'"),
            s.run("insert into public.plan_entitlements (plan_id, key, value) values ('free', 'mcp', 'true')"),
            s.run("delete from public.plan_entitlements where plan_id = 'free'"),
            s.run("update public.entitlement_keys set default_value = '1000' where key = 'concurrency'"),
            s.run("update public.credit_lot_policies set valid_months = null where source = 'pack'"),
        ]
    for out in attempts:
        assert refused(out), out
    assert truth(conn, "select monthly_credits from public.plans where id = 'pro'") == 6000
    assert truth(conn, "select public.entitlement_int_internal(%s, 'concurrency')", [sc.bob.org]) == 4


def test_customer_cannot_write_a_credit_lot(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        attempts = [
            s.run("update public.credit_lots set remaining = remaining + 1000, amount = amount + 1000 where org_id = %s",
                  [sc.bob.org]),
            s.run("update public.credit_lots set expires_at = null where org_id = %s", [sc.bob.org]),
            s.run("insert into public.credit_lots (org_id, source, amount, remaining) values (%s, 'grant', 1000, 1000)",
                  [sc.bob.org]),
            s.run("delete from public.credit_hold_lots"),
            s.run("insert into public.credit_lot_moves (org_id, lot_id, kind, remaining_delta, held_delta) "
                  "select org_id, id, 'grant', 1000, 0 from public.credit_lots where org_id = %s limit 1", [sc.bob.org]),
        ]
    for out in attempts:
        assert refused(out), out


def test_even_the_service_key_cannot_write_lots_directly(conn, sc):
    from sec_db import SERVICE
    with acting(conn, SERVICE) as s:
        out = s.run("update public.credit_lots set remaining = remaining + 1 where org_id = %s", [sc.bob.org])
    assert not out.ok and out.sqlstate == "42501", out


# ── reading someone else's billing ──────────────────────────────────────────

@pytest.mark.parametrize("query,expect", [
    ("select public.billing_summary(%s)", None),
    ("select public.org_entitlements(%s)", None),
    ("select public.org_plan(%s)", None),
    ("select public.org_run_slots(%s)", None),
    ("select public.entitlement_int(%s, 'concurrency')", None),
    ("select public.has_entitlement(%s, 'api_access')", False),
    ("select public.model_tier_allowed(%s, 'video', 'basic')", False),
])
def test_customer_learns_nothing_about_another_orgs_plan(conn, sc, query, expect):
    with acting(conn, sc.bob.actor) as s:
        theirs = s.run(query, [sc.alice.org])
        mine = s.run(query, [sc.bob.org])
    assert theirs.ok and theirs.rows[0][0] == expect, theirs
    assert mine.ok and mine.rows[0][0] not in (None, False), mine  # the positive control


def test_stranger_and_anon_learn_nothing(conn, sc):
    with acting(conn, sc.stranger) as s:
        out = s.run("select public.billing_summary(%s)", [sc.alice.org])
    assert out.ok and out.rows[0][0] is None, out
    with acting(conn, ANON) as s:
        out = s.run("select public.billing_summary(%s)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501", out
