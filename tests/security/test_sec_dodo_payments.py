"""Migration 0143 (Dodo Payments next to Paddle) on a real PostgreSQL.

What would break, and what each test proves:
  * a customer or anon calling the provider-aware twins to mint plan credits (refused, 42501);
  * the Dodo money path not going through the SAME ledger functions as Paddle's (a Dodo pack, plan period, replay and
    refund here use add_purchased_credits, grant_subscription_credits_for and refund_purchased_credits, and the ledger
    agrees with the lots after each);
  * Paddle behaving differently once 0143 is applied: one Paddle scenario is run on a scratch database with 0143, then
    again after 0143's own rollback (0034's bodies), and every answer, error code, ledger row and lot must be equal;
  * a Paddle row admitting a shape 0034 refused, or a provider nobody configured;
  * a Paddle call reaching a Dodo subscription (or the reverse) because they share an id string;
  * the drift guard, the rollback's refusals, and rollback-then-reapply.
"""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager

import pytest

sec_db = pytest.importorskip("sec_db")  # the lab's own harness (tests/security/conftest.py)

from sec_db import ANON, SERVICE, acting, as_superuser  # noqa: E402

REPO = sec_db.REPO
MIGRATION = REPO / "supabase" / "migrations" / "0143_dodo_payments.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0143_dodo_payments.sql"

UPSERT_FOR = "public.upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)"
GRANT_FOR = "public.grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)"


def new_org(conn) -> str:
    org = str(uuid.uuid4())
    with as_superuser(conn) as s:
        s.value("insert into public.organizations (id, name, slug) values (%s, %s, %s) returning id",
                [org, "Dodo lab", "dodo-" + org[:12]])
    return org


def svc(conn, query, params=None):
    with acting(conn, SERVICE, commit=True) as s:
        out = s.run(query, params)
    return out


def jval(out):
    assert out.ok, out
    v = out.rows[0][0]
    return v if isinstance(v, dict) else json.loads(v)


def ledger(conn, org):
    with as_superuser(conn, commit=False) as s:
        return s.rows("select kind, amount::text, external_id from public.credit_transactions where org_id = %s order by id", [org])


def lots(conn, org):
    with as_superuser(conn, commit=False) as s:
        return s.rows("select source, amount::text, remaining::text, held::text, plan_id from public.credit_lots where org_id = %s order by id", [org])


def consistent(conn, org) -> bool:
    with as_superuser(conn, commit=False) as s:
        return s.value(
            "select a.balance = coalesce(sum(l.remaining), 0) and a.reserved = coalesce(sum(l.held), 0) "
            "from public.credit_accounts a left join public.credit_lots l on l.org_id = a.org_id "
            "where a.org_id = %s group by a.balance, a.reserved", [org])


# ── who may call ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("query", [
    "select public.grant_subscription_credits_for('dodo', %(org)s, 'sub_EvilDodo0001', 'studio', now(), now() + interval '30 days', 'pay_EvilPay0001')",
    "select public.upsert_subscription_for('dodo', %(org)s, 'sub_EvilDodo0001', null, 'studio', null, 'active', now(), now() + interval '30 days', false, null, now())",
    "select public.grant_subscription_credits_for('paddle', %(org)s, 'sub_01evil00000000000000000000', 'studio', now(), now() + interval '30 days', 'txn_01evil00000000000000000000')",
])
def test_customer_and_anon_cannot_call_the_twins(conn, sc, query):
    for who in (sc.bob.actor, ANON):
        with acting(conn, who) as s:
            out = s.run(query, {"org": sc.bob.org})
        assert not out.ok and out.sqlstate == "42501", (who, out)


def test_the_twins_are_service_role_only_security_definer_with_a_fixed_search_path(conn):
    with as_superuser(conn, commit=False) as s:
        for sig in (UPSERT_FOR, GRANT_FOR):
            row = s.rows(
                "select has_function_privilege('service_role', %s, 'EXECUTE'), has_function_privilege('authenticated', %s, 'EXECUTE'), "
                "has_function_privilege('anon', %s, 'EXECUTE'), p.prosecdef, p.proconfig from pg_proc p where p.oid = %s::regprocedure",
                [sig, sig, sig, sig])[0]
            assert row[:4] == (True, False, False, True), (sig, row)
            assert "search_path=public, pg_temp" in row[4], (sig, row)


# ── the Dodo money path through the shared ledger functions ─────────────────

def test_a_dodo_pack_is_credited_once_and_refunded_through_the_shared_functions(conn):
    org = new_org(conn)
    first = jval(svc(conn, "select public.add_purchased_credits(%s, 1000, 'pay_DodoPack0001', 'Dodo pay_DodoPack0001: 1x starter')", [org]))
    again = jval(svc(conn, "select public.add_purchased_credits(%s, 1000, 'pay_DodoPack0001', 'replay')", [org]))
    assert first["duplicate"] is False and again["duplicate"] is True
    r = jval(svc(conn, "select public.refund_purchased_credits('pay_DodoPack0001', 'dodo_refund:ref_0001', 250, 'Dodo dodo_refund:ref_0001', 'refund')"))
    d = jval(svc(conn, "select public.refund_purchased_credits('pay_DodoPack0001', 'dodo_dispute:dis_0001', null, 'Dodo dodo_dispute:dis_0001', 'chargeback')"))
    assert (r["taken"], d["taken"]) == (250, 750)
    # A third reversal of the same payment finds nothing left to take: the running total is capped at the purchase.
    x = jval(svc(conn, "select public.refund_purchased_credits('pay_DodoPack0001', 'dodo_refund:ref_0002', null, 'n', 'refund')"))
    assert x["requested"] == 0
    assert [k for k, _a, _e in ledger(conn, org)][-4:] == ["purchase", "refund", "refund", "refund"]
    assert consistent(conn, org)


def test_a_dodo_plan_period_is_granted_once_per_payment_and_per_period(conn):
    org = new_org(conn)
    # One fixed period, as Dodo's service_periods give it: every call below names the same period end.
    period = "timestamptz '2026-11-12T10:00:00Z', timestamptz '2099-12-12T10:00:00Z'"
    up = jval(svc(conn, "select public.upsert_subscription_for('dodo', %s, 'sub_Iuaq622bbmmfOGrVTqdXv', 'cus_TV52uJWWXt2yIoBBxpjaa', 'pro', "
                        "'pdt_ProPlan00000000001', 'active', " + period + ", false, null, now())", [org]))
    assert up["stale"] is False and up["plan"] == "pro"
    grant = ("select public.grant_subscription_credits_for('dodo', %s, 'sub_Iuaq622bbmmfOGrVTqdXv', 'pro', " + period +
             ", %s, 'Dodo payment: pro plan (new)', null, 'pdt_ProPlan00000000001', 1)")
    g = jval(svc(conn, grant, [org, "pay_DodoPlan0001"]))
    replay = jval(svc(conn, grant, [org, "pay_DodoPlan0001"]))
    # Another payment for the SAME period (a second charge Dodo reports for it) adds nothing: the lot is at its allowance.
    second = jval(svc(conn, grant, [org, "pay_DodoPlan0002"]))
    assert (g["granted"], replay["duplicate"], second["granted"]) == (6000, True, 0)
    with as_superuser(conn, commit=False) as s:
        row = s.rows("select provider, provider_customer_id, price_id, status from public.subscriptions where org_id = %s", [org])
    assert row == [("dodo", "cus_TV52uJWWXt2yIoBBxpjaa", "pdt_ProPlan00000000001", "active")]
    assert [x[0] for x in lots(conn, org)].count("subscription") == 1
    ref = jval(svc(conn, "select public.refund_purchased_credits('pay_DodoPlan0001', 'dodo_refund:ref_plan', null, 'n', 'refund')"))
    assert ref["taken"] == 6000
    assert consistent(conn, org)


def test_a_cancellation_at_period_end_keeps_the_plan_live_until_dodo_ends_it(conn):
    org = new_org(conn)
    sub = "sub_CancelAtEnd000001"
    args = "'pro', 'pdt_ProPlan00000000001', %s, now() - interval '1 day', now() + interval '29 days', %s, null, %s"
    svc(conn, f"select public.upsert_subscription_for('dodo', %s, %s, null, {args})", [org, sub, "active", False, "2026-11-12T10:00:00Z"])
    svc(conn, f"select public.upsert_subscription_for('dodo', %s, %s, null, {args})", [org, sub, "active", True, "2026-11-12T11:00:00Z"])
    with as_superuser(conn, commit=False) as s:
        assert s.value("select public.org_plan_internal(%s)", [org]) == "pro"
    svc(conn, f"select public.upsert_subscription_for('dodo', %s, %s, null, {args})", [org, sub, "canceled", False, "2026-12-12T10:00:00Z"])
    with as_superuser(conn, commit=False) as s:
        assert s.value("select public.org_plan_internal(%s)", [org]) == "free"


def test_payment_events_take_dodo_and_nothing_else(conn):
    ok = svc(conn, "select public.record_payment_event('dodo', 'msg_lab0001', 'payment.succeeded', now(), 'processed', 'x', null, "
                   "'pay_DodoPack0001', null, 1000, 'USD', 1080)")
    assert ok.ok, ok
    bad = svc(conn, "select public.record_payment_event('stripe', 'msg_lab0002', 'payment.succeeded', now(), 'processed', 'x')")
    assert not bad.ok and bad.sqlstate == "23514", bad


@pytest.mark.parametrize("provider,sub,customer,price", [
    ("paddle", "sub_MixedCaseNotPaddle", None, None),          # a Dodo-shaped id on a Paddle row
    ("paddle", "sub_01aaaaaaaaaaaaaaaaaaaaaaaa", "cus_TV52uJWWXt2y", None),
    ("paddle", "sub_01aaaaaaaaaaaaaaaaaaaaaaab", None, "pdt_0NVbdIG3JNg9Yc8ey5JHW"),
    ("dodo", "sub_Iuaq622bbmmfOGrVTqdXX", "ctm_01aaaaaaaaaaaaaaaaaaaaaaaa", None),  # a Paddle customer on a Dodo row
    ("dodo", "sub_Iuaq622bbmmfOGrVTqdXY", None, "pri_01aaaaaaaaaaaaaaaaaaaaaaaa"),
    ("dodo", "sub_x", None, None),                                # too short
    ("stripe", "sub_01aaaaaaaaaaaaaaaaaaaaaaac", None, None),
])
def test_the_checks_refuse_a_shape_that_belongs_to_another_provider(conn, provider, sub, customer, price):
    org = new_org(conn)
    with as_superuser(conn, commit=False) as s:
        out = s.run("insert into public.subscriptions (org_id, provider, provider_subscription_id, provider_customer_id, plan_id, price_id, status) "
                    "values (%s, %s, %s, %s, 'pro', %s, 'active')", [org, provider, sub, customer, price])
    assert not out.ok and out.sqlstate == "23514", out


def test_an_unknown_provider_is_refused_by_the_twins(conn):
    org = new_org(conn)
    out = svc(conn, "select public.upsert_subscription_for('stripe', %s, 'sub_01aaaaaaaaaaaaaaaaaaaaaaad', null, 'pro', null, 'active', "
                    "now(), now() + interval '30 days', false, null, now())", [org])
    assert not out.ok and out.sqlstate == "22023", out
    out = svc(conn, "select public.grant_subscription_credits_for(null, %s, 'sub_01aaaaaaaaaaaaaaaaaaaaaaad', 'pro', now(), "
                    "now() + interval '30 days', 'txn_01aaaaaaaaaaaaaaaaaaaaaaad')", [org])
    assert not out.ok and out.sqlstate == "22023", out


def test_the_same_id_string_under_two_providers_is_two_subscriptions(conn):
    paddle_org, dodo_org = new_org(conn), new_org(conn)
    sub = "sub_01shared0000000000000000"  # a valid shape for both
    svc(conn, "select public.upsert_subscription(%s, %s, null, 'creator', null, 'active', now(), now() + interval '30 days', false, null, now())",
        [paddle_org, sub])
    out = svc(conn, "select public.upsert_subscription_for('dodo', %s, %s, null, 'pro', null, 'active', now(), now() + interval '30 days', false, null, now())",
              [dodo_org, sub])
    assert out.ok, out  # not "already recorded for another organization"
    # And the Paddle name never moves the Dodo row: it finds only its own.
    svc(conn, "select public.upsert_subscription(%s, %s, null, null, null, 'canceled', null, null, false, now(), now() + interval '1 second')",
        [paddle_org, sub])
    with as_superuser(conn, commit=False) as s:
        assert s.rows("select provider, org_id::text, status from public.subscriptions where provider_subscription_id = %s order by provider", [sub]) == [
            ("dodo", dodo_org, "active"), ("paddle", paddle_org, "canceled")]


# ── Paddle, with and without 0143: the same answers ─────────────────────────

@contextmanager
def scratch_db():
    import psycopg
    dsn = sec_db.admin_dsn()
    name = f"ns_dodo_scratch_{uuid.uuid4().hex[:8]}"
    db_dsn = sec_db.build(dsn, name)
    c = psycopg.connect(db_dsn, autocommit=True)
    try:
        yield c
    finally:
        c.close()
        sec_db.drop_database(dsn, name)


def apply(c, path):
    """One file as one transaction; the rollback's own begin/commit lines are dropped (sec_db.take_off_* does the same)."""
    text = "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    with c.transaction():
        c.execute(text)


def paddle_scenario(c) -> list:
    """Every Paddle call the webhook makes, with its ids replaced by their position so two runs can be compared."""
    org = new_org(c)
    other = new_org(c)
    sub = "sub_" + uuid.uuid4().hex[:26]
    txn = ["txn_" + uuid.uuid4().hex[:26] for _ in range(3)]
    period = "timestamptz '2026-01-01T00:00:00Z', timestamptz '2099-01-01T00:00:00Z'"
    steps = [
        ("select public.upsert_subscription(%s, %s, %s, 'creator', null, 'active', " + period + ", false, null, timestamptz '2026-06-01')",
         [org, sub, "ctm_" + uuid.uuid4().hex[:26]]),
        ("select public.grant_subscription_credits(%s, %s, 'creator', " + period + ", %s, 'note')", [org, sub, txn[0]]),
        ("select public.grant_subscription_credits(%s, %s, 'creator', " + period + ", %s, 'replay')", [org, sub, txn[0]]),
        ("select public.grant_subscription_credits(%s, %s, 'creator', " + period + ", %s, 'half', null, null, 0.5)", [org, sub, txn[1]]),
        ("select public.upsert_subscription(%s, %s, null, null, null, 'canceled', null, null, false, now(), timestamptz '2026-01-01')", [org, sub]),
        ("select public.upsert_subscription(%s, %s, null, null, null, 'active', null, null, true, null, timestamptz '2026-07-01')", [org, sub]),
        ("select public.upsert_subscription(%s, %s, null, 'pro', null, 'active', null, null, false, null, timestamptz '2026-08-01')", [other, sub]),
        ("select public.upsert_subscription(%s, %s, null, null, null, 'active', null, null, false, null, now())", [org, "sub_" + uuid.uuid4().hex[:26]]),
        ("select public.grant_subscription_credits(%s, %s, 'nope', " + period + ", %s)", [org, sub, txn[2]]),
        ("select public.grant_subscription_credits(%s, %s, 'creator', now() - interval '2 days', now() - interval '1 day', %s)", [org, sub, txn[2]]),
        ("select public.refund_purchased_credits(%s, %s, null, 'n', 'refund')", [txn[0], "adj_" + uuid.uuid4().hex[:26]]),
    ]
    out = []
    for q, p in steps:
        r = svc(c, q, p)
        if r.ok:
            v = r.rows[0][0]
            v = v if isinstance(v, dict) else json.loads(v)
            out.append(("ok", {k: v[k] for k in sorted(v) if k not in ("id", "transaction_id", "lot_id", "refund_id")}))
        else:
            out.append(("error", r.sqlstate))
    with as_superuser(c, commit=False) as s:
        out.append(("subscription", s.rows("select provider, plan_id, status, cancel_at_period_end, current_period_end::text from public.subscriptions where org_id = %s", [org])))
    out.append(("ledger", [(k, a) for k, a, _e in ledger(c, org)]))
    out.append(("lots", lots(c, org)))
    out.append(("consistent", consistent(c, org)))
    return out


def test_the_paddle_path_answers_the_same_with_and_without_0143():
    if not sec_db.admin_dsn():
        pytest.skip("no lab database")
    with scratch_db() as c:
        with_0143 = paddle_scenario(c)
        apply(c, ROLLBACK)  # 0034's bodies and checks, byte for byte
        with as_superuser(c, commit=False) as s:
            assert s.value("select to_regprocedure(%s) is null", [GRANT_FOR])
        without = paddle_scenario(c)
        apply(c, MIGRATION)
        again = paddle_scenario(c)
    assert with_0143 == without == again
    # The scenario is not vacuous: it grants, replays, scales, refuses and refunds.
    kinds = [x[0] for x in with_0143[:11]]
    assert kinds.count("error") == 3 and with_0143[1][1]["granted"] == 2000 and with_0143[2][1]["duplicate"] is True


def test_drift_guard_rollback_refusals_and_reapply():
    if not sec_db.admin_dsn():
        pytest.skip("no lab database")
    with scratch_db() as c:
        # A replay of 0143 on itself is fine.
        apply(c, MIGRATION)
        # A Dodo row makes the rollback refuse, changing nothing.
        org = new_org(c)
        svc(c, "select public.upsert_subscription_for('dodo', %s, 'sub_RollbackGuard0001', null, 'pro', null, 'active', now(), now() + interval '30 days', false, null, now())", [org])
        import psycopg
        with pytest.raises(psycopg.Error, match="Dodo rows exist"):
            apply(c, ROLLBACK)
        with as_superuser(c, commit=False) as s:
            assert s.value("select to_regprocedure(%s) is not null", [GRANT_FOR])
        with as_superuser(c) as s:
            s.value("delete from public.subscriptions where provider = 'dodo' returning 1")
        apply(c, ROLLBACK)
        # A live body that is neither 0034's nor 0143's: 0143 refuses to replace it.
        with c.transaction():
            c.execute("create or replace function public.grant_subscription_credits(p_org uuid, p_subscription_id text, p_plan text, "
                      "p_period_start timestamptz, p_period_end timestamptz, p_external_id text, p_note text default null, "
                      "p_customer_id text default null, p_price_id text default null, p_paid_share numeric default 1) returns jsonb "
                      "language plpgsql volatile security definer set search_path = public, pg_temp as $$ begin return '{}'::jsonb; end $$")
        with pytest.raises(psycopg.Error, match="neither 0034''?s nor 0143''?s|neither 0034's nor 0143's"):
            apply(c, MIGRATION)
        with as_superuser(c, commit=False) as s:
            assert s.value("select to_regprocedure(%s) is null", [GRANT_FOR])  # nothing half-applied
