"""Migration 0154: the Credits page's Dodo purchase history (public.dodo_purchase_history), attacked in a real database.

What would break without these:
  * anon, the service key, a stranger, or a plain member of the organization reading payment_events through the new door
    (0021 closes it to every API role; only an owner or admin may see their own organization's purchases);
  * one organization's payments, amounts or refunds showing on another's page, or the invoice route's ownership check saying
    yes for a payment of another organization;
  * a payment that was rejected, ignored or is still failing (paid, never credited) listed as bought;
  * a payment delivered twice listed twice, or a refund counted twice;
  * a typed amount's signed item, a pack's, or a plan period's label lost or invented;
  * a malformed payment id reaching the query;
  * the file not replaying, the rollback leaving the function behind, or either one overwriting a body it did not write.
"""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

from sec_db import ANON, REPO, SERVICE, Session, as_superuser, user

MIGRATION = REPO / "supabase" / "migrations" / "0154_dodo_purchase_history.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0154_dodo_purchase_history.sql"
SIG = "public.dodo_purchase_history(uuid, text)"
CALL = ("select payment_id, item, credits::text, amount_minor, currency, paid_at is not null, refunded_minor, refund_unsized, chargeback "
        "from public.dodo_purchase_history(%s, %s)")


@contextmanager
def scratch(conn):
    """One transaction that is always rolled back: the superuser sets the world up, then callers ask inside it."""
    with conn.transaction(force_rollback=True):
        conn.execute("select set_config('request.jwt.claims', '', true)")
        yield conn


def as_who(conn, who, query, params):
    conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    try:
        return Session(conn).run(query, params)
    finally:
        conn.execute("reset role")
        conn.execute("select set_config('request.jwt.claims', '', true)")


def ask(conn, who, org, payment=None):
    return as_who(conn, who, CALL, [org, payment])


def event(conn, event_id, event_type, status, org, txn, credits=None, amount=None, currency="USD", at="2026-11-13T10:00:00Z"):
    conn.execute(
        "select public.record_payment_event('dodo', %s, %s, %s::timestamptz, %s, 'lab', %s, %s, null, %s, %s, %s)",
        [event_id, event_type, at, status, org, txn, credits, currency, amount])


def spend_nonce(conn, who, org, item, consumer):
    """A nonce issued the way the checkout route does (the owner's own session), spent by the webhook (service role)."""
    out = as_who(conn, who, "select public.dodo_issue_checkout_nonce(%s, %s)", [org, item])
    assert out.ok, out
    nonce = out.rows[0][0]
    spent = as_who(conn, SERVICE, "select public.dodo_consume_checkout_nonce(%s, %s, %s, %s, %s, null)", [nonce, org, who.uid, item, consumer])
    assert spent.ok and spent.rows[0][0] == "ok", spent


def ok(out):
    assert out.ok, out
    return out.rows


def seed_alice(conn, sc):
    """Alice's organization: a typed amount ($25, partly refunded), a Starter pack delivered twice, a plan period, a rejected
    payment and a still-failing one. Bob's organization: one pack."""
    a, b = sc.alice, sc.bob
    spend_nonce(conn, a.actor, a.org, "pack:amount_2500", "pay_LabAmount0001")
    event(conn, "msg_a1", "payment.succeeded", "processed", a.org, "pay_LabAmount0001", 2500, 2700, at="2026-11-13T10:00:00Z")
    event(conn, "msg_a1r", "refund.succeeded", "processed", a.org, "pay_LabAmount0001", 1000, 1080)
    event(conn, "msg_a1r2", "refund.succeeded", "duplicate", a.org, "pay_LabAmount0001", None, 1080)  # the same refund again
    spend_nonce(conn, a.actor, a.org, "pack:starter", "pay_LabStarter001")
    event(conn, "msg_a2", "payment.succeeded", "processed", a.org, "pay_LabStarter001", 1000, 1080, at="2026-11-12T10:00:00Z")
    event(conn, "msg_a2b", "payment.succeeded", "duplicate", a.org, "pay_LabStarter001", 1000, 1080, at="2026-11-12T10:00:00Z")
    # A plan period: no nonce of its own, a 'subscription' ledger row under the payment id.
    conn.execute("select public.upsert_subscription_for('dodo', %s, 'sub_LabHistory00001', null, 'pro', 'pdt_LabProPlan0001', 'active', "
                 "now() - interval '1 day', now() + interval '29 days', false, null, now())", [a.org])
    conn.execute("select public.grant_subscription_credits_for('dodo', %s, 'sub_LabHistory00001', 'pro', now() - interval '1 day', "
                 "now() + interval '29 days', 'pay_LabPlan000001', 'n', null, 'pdt_LabProPlan0001', 1)", [a.org])
    event(conn, "msg_a3", "payment.succeeded", "processed", a.org, "pay_LabPlan000001", 6000, 5292, at="2026-11-11T10:00:00Z")
    # Paid but never credited: a person's case, never "bought".
    event(conn, "msg_a4", "payment.succeeded", "rejected", a.org, "pay_LabRejected01", None, 999)
    event(conn, "msg_a5", "payment.succeeded", "failed", a.org, "pay_LabFailing001", None, 1080)
    # Bob's.
    event(conn, "msg_b1", "payment.succeeded", "processed", b.org, "pay_LabBobPack001", 1000, 1080)


# ── who may call it ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("who", [ANON, SERVICE], ids=["anon", "service_role"])
def test_anon_and_the_service_key_cannot_call_it(conn, sc, who):
    with scratch(conn):
        out = ask(conn, who, sc.alice.org)
    assert not out.ok and out.sqlstate == "42501", out


def test_a_stranger_and_a_plain_member_read_nothing(conn, sc):
    erin = user("erin", "erin@a.test")
    with scratch(conn):
        seed_alice(conn, sc)
        conn.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [erin.uid, erin.email])
        conn.execute("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'editor')", [sc.alice.org, erin.uid, erin.email])
        for who in (sc.bob.actor, erin):
            for payment in (None, "pay_LabAmount0001"):
                out = ask(conn, who, sc.alice.org, payment)
                assert not out.ok and out.sqlstate == "42501", (who.name, payment, out)
        # A null organization is not "every organization".
        out = ask(conn, sc.alice.actor, None)
        assert not out.ok and out.sqlstate == "42501", out


def test_it_is_a_stable_security_definer_with_a_fixed_search_path_and_signed_in_execute_only(conn):
    with as_superuser(conn, commit=False) as s:
        row = s.rows(
            "select p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('authenticated', p.oid, 'EXECUTE'), "
            "has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('service_role', p.oid, 'EXECUTE') "
            "from pg_proc p where p.oid = %s::regprocedure", [SIG])[0]
    assert (row[0], row[1], row[3], row[4], row[5]) == (True, "s", True, False, False), row
    assert "search_path=public, pg_temp" in row[2], row


# ── what the owner is shown ─────────────────────────────────────────────────

def test_the_owner_sees_their_credited_payments_once_each_newest_first_and_nothing_else(conn, sc):
    with scratch(conn):
        seed_alice(conn, sc)
        rows = ok(ask(conn, sc.alice.actor, sc.alice.org))
    assert rows == [
        # payment, item, credits, charged, currency, dated, refunded, refund unsized, chargeback
        ("pay_LabAmount0001", "pack:amount_2500", "2500.00", 2700, "USD", True, 1080, False, False),
        ("pay_LabStarter001", "pack:starter", "1000.00", 1080, "USD", True, 0, False, False),
        ("pay_LabPlan000001", "plan", "6000.00", 5292, "USD", True, 0, False, False),
    ]


def test_one_payment_by_id_answers_only_for_its_own_organization(conn, sc):
    with scratch(conn):
        seed_alice(conn, sc)
        own = ok(ask(conn, sc.alice.actor, sc.alice.org, "pay_LabStarter001"))
        bobs = ok(ask(conn, sc.alice.actor, sc.alice.org, "pay_LabBobPack001"))
        rejected = ok(ask(conn, sc.alice.actor, sc.alice.org, "pay_LabRejected01"))
        bob_own = ok(ask(conn, sc.bob.actor, sc.bob.org, "pay_LabBobPack001"))
    assert [r[0] for r in own] == ["pay_LabStarter001"]
    assert bobs == [] and rejected == []
    # Bob's pack spent no nonce here: its item is unknown, and is said as unknown (null), never guessed.
    assert bob_own == [("pay_LabBobPack001", None, "1000.00", 1080, "USD", True, 0, False, False)]


@pytest.mark.parametrize("bad", ["pdt_0NVbdIG3JNg9Yc8ey5JHW", "pay_", "pay_%", "pay_a' or '1'='1", "pay_" + "a" * 65, ""])
def test_a_malformed_payment_id_is_refused_before_anything_is_read(conn, sc, bad):
    with scratch(conn):
        out = ask(conn, sc.alice.actor, sc.alice.org, bad)
    assert not out.ok and out.sqlstate == "22023", out


def test_a_refund_without_an_amount_or_in_another_currency_is_unsized_and_a_lost_dispute_is_a_chargeback(conn, sc):
    org = sc.alice.org
    with scratch(conn):
        event(conn, "msg_c1", "payment.succeeded", "processed", org, "pay_LabUnsized001", 1000, 1080)
        event(conn, "msg_c1r", "refund.succeeded", "processed", org, "pay_LabUnsized001", 500, None, currency=None)
        event(conn, "msg_c2", "payment.succeeded", "processed", org, "pay_LabEuro000001", 1000, 1080)
        event(conn, "msg_c2r", "refund.succeeded", "processed", org, "pay_LabEuro000001", 500, 500, currency="EUR")
        event(conn, "msg_c3", "payment.succeeded", "processed", org, "pay_LabDispute001", 1000, 1080)
        event(conn, "msg_c3d", "dispute.lost", "processed", org, "pay_LabDispute001", 1000, 1080)
        # A refund that changed nothing (rejected: could not be sized) is not a refund on the page.
        event(conn, "msg_c4", "payment.succeeded", "processed", org, "pay_LabNoRefund01", 1000, 1080)
        event(conn, "msg_c4r", "refund.succeeded", "rejected", org, "pay_LabNoRefund01", None, 1080)
        rows = {r[0]: r[6:] for r in ok(ask(conn, sc.alice.actor, org))}
    assert rows["pay_LabUnsized001"] == (0, True, False)
    assert rows["pay_LabEuro000001"] == (0, True, False)
    assert rows["pay_LabDispute001"] == (0, False, True)
    assert rows["pay_LabNoRefund01"] == (0, False, False)


def test_a_platform_admin_reads_any_organization_as_its_admin(conn, sc):
    # 0018: a platform owner/admin holds that role in every organization (the same bar the nonce issuer uses). Pinned so a change
    # of that rule is a decision, not a surprise on the Credits page.
    with scratch(conn):
        seed_alice(conn, sc)
        rows = ok(ask(conn, sc.operator, sc.alice.org))
    assert len(rows) == 3


# ── replay, rollback, drift ─────────────────────────────────────────────────

def _text(path: Path) -> str:
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_the_migration_replays_and_the_rollback_takes_it_out(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(_text(MIGRATION))  # a replay: its own body passes the drift guard
        su.conn.execute(_text(ROLLBACK))
        assert su.value("select to_regprocedure(%s)", [SIG]) is None
        su.conn.execute(_text(MIGRATION))  # and it applies again on the rolled-back database
        assert su.value("select to_regprocedure(%s)", [SIG]) is not None
        assert su.value("select has_function_privilege('authenticated', %s, 'EXECUTE')", [SIG]) is True
        assert su.value("select has_function_privilege('anon', %s, 'EXECUTE')", [SIG]) is False


def test_the_migration_and_the_rollback_refuse_a_body_they_did_not_write(conn, sc):
    drift = ("create or replace function public.dodo_purchase_history(p_org uuid, p_payment text default null) returns table ("
             "payment_id text, item text, credits numeric, amount_minor bigint, currency text, paid_at timestamptz, refunded_minor bigint, "
             "refund_unsized boolean, chargeback boolean) language sql stable security definer set search_path = public, pg_temp as $$ "
             "select transaction_id, null::text, credits, amount_minor, currency, received_at, 0::bigint, false, false from public.payment_events $$")
    for path in (MIGRATION, ROLLBACK):
        with as_superuser(conn, commit=False) as su:
            su.conn.execute(f"drop function {SIG}")
            su.conn.execute(drift)
            with pytest.raises(psycopg.errors.RaiseException, match="dodo_purchase_history"):
                with su.conn.transaction():
                    su.conn.execute(_text(path))


def test_the_migration_refuses_to_apply_without_0146(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute("alter table public.dodo_checkout_nonces rename to dodo_checkout_nonces_lab_" + uuid.uuid4().hex[:6])
        with pytest.raises(psycopg.errors.RaiseException, match="0154 needs 0146"):
            with su.conn.transaction():
                su.conn.execute(_text(MIGRATION))
