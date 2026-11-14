"""Migration 0172: an owner's reversal of a grant that meets a hold takes those credits back when the hold is released (BR-0107-01).

The Breach test (test_sec_breach_owner_reverse_hold.py) is the finding itself: a run holds most of a grant, the owner reverses it, the
hold is released. These are the variants, each asserting the safe outcome:

  * a PARTIAL hold: the reversal takes what is free now and the rest when the hold is released, from the grant's own lot;
  * TWO holds on the grant's lot: each release pays only what it gave back to that lot, and a purchase made afterwards stays whole;
  * a hold CAPTURED after the reversal: real spending, nothing collected, the shortfall stands;
  * a hold placed AFTER the reversal is never touched;
  * REPLAY: the reversal twice, a release twice, an expiry after the release, the migration applied again: collected once;
  * WHO: a release inside the workspace's own reserve_credits (the lazy expiry) collects, written as the platform's row;
  * ONE RELEASE, TWO COLLECTORS: a refund (0167) and a reversal met the same hold; together they take at most what it gave back;
  * CONCURRENCY with reserve_credits on real, committing connections, in both orders.

Every in-transaction test checks the account against its lots (0034's deferred check, run there and then).
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid

import psycopg
import pytest

import sec_db
from sec_db import SERVICE, as_superuser, user

MIGRATION = sec_db.MIGRATIONS / "0172_grant_reversal_hold_recovery.sql"
REASON = "granted to the wrong workspace by mistake"


def _as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")


def _call(s, actor, query, params=None, aal=False):
    claims = actor.claims()
    if aal:
        claims["aal"] = "aal1"
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)
    out = s.run(query, params)
    _as_owner(s)
    return out


def _ok(out):
    assert out.ok, out
    return out.rows[0][0] if out.rows else None


def _workspace(s):
    """A confirmed person and their new workspace (100 welcome credits, a lot older than any grant made here)."""
    member = user("member", f"member-{uuid.uuid4().hex[:8]}@lab.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at, created_at) values (%s, %s, now(), now()) returning 1",
           [member.uid, member.email])
    org = str(_ok(_call(s, member, "select public.create_organization(%s)", [f"WS {uuid.uuid4().hex[:6]}"])))
    return member, org


def _grant(s, sc, org, credits=100):
    g = _ok(_call(s, sc.operator, "select public.owner_grant_credits(%s, %s, %s, %s)",
                  [org, credits, REASON, f"key-0172-{uuid.uuid4().hex[:10]}"], aal=True))
    assert g["ok"] is True, g
    return g["transaction_id"]


def _reverse(s, sc, grant_txn):
    return _ok(_call(s, sc.operator, "select public.owner_reverse_grant(%s, %s)", [grant_txn, REASON], aal=True))


def _many_parallel_runs(s):
    """For this transaction every plan may hold ten runs at once (0034's limit is one on Free): the tests about two holds need two."""
    _as_owner(s)
    s.conn.execute("update public.entitlement_keys set default_value = '10' where key = 'concurrency'")
    s.conn.execute("update public.plan_entitlements set value = '10' where key = 'concurrency'")


def _hold(s, member, org, amount):
    job = f"rj-0172-{uuid.uuid4().hex[:8]}"
    _ok(_call(s, member, "select public.reserve_credits(%s, %s, %s)", [org, job, amount]))
    return job


def _buy(s, org, credits):
    ext = f"pay_lab{uuid.uuid4().hex[:16]}"
    _ok(_call(s, SERVICE, "select public.add_purchased_credits(%s, %s, %s, 'lab purchase')", [org, credits, ext]))
    return ext


def _release(s, job):
    return _ok(_call(s, SERVICE, "select public.release_credits(%s)", [job]))


def _recovery(s, grant_txn):
    rows = s.rows("select owed, collected, lapsed, holds from public.credit_grant_reversal_recoveries where grant_txn_id = %s",
                  [grant_txn])
    return tuple(rows[0]) if rows else None


def _lot(s, grant_txn):
    return s.value("select id from public.credit_lots where created_txn = %s", [grant_txn])


def _collections(s, org):
    """The rows the collector wrote: 'adjust' rows with no external id of their own, naming the grant and the hold."""
    return s.rows("select id, amount, created_by, note from public.credit_transactions "
                  "where org_id = %s and kind = 'adjust' and external_id is null and note like 'owner reversal of grant #%%' order by id",
                  [org])


def _spent_from(s, txn):
    """The lots a ledger row spent, and how much from each."""
    return s.rows("select lot_id, -remaining_delta from public.credit_lot_moves where txn_id = %s and kind = 'spend' order by lot_id", [txn])


def _balanced(s, org):
    s.rows("set constraints all immediate")
    s.rows("set constraints all deferred")
    bal, res = s.rows("select balance, reserved from public.credit_accounts where org_id = %s", [org])[0]
    lots = s.rows("select coalesce(sum(remaining), 0), coalesce(sum(held), 0) from public.credit_lots where org_id = %s and remaining > 0",
                  [org])[0]
    assert (bal, res) == tuple(lots), f"account {bal}/{res} vs lots {lots}"
    assert bal >= 0 and 0 <= res <= bal
    return bal


# ── a partial hold ──────────────────────────────────────────────────────────

def test_a_partial_hold_is_taken_back_from_the_grants_own_lot_when_it_is_released(conn, sc):
    with as_superuser(conn, commit=False) as s:
        member, org = _workspace(s)
        g = _grant(s, sc, org)
        lot = _lot(s, g)
        job = _hold(s, member, org, 170)                     # the welcome 100, then 70 of the grant's lot
        out = _reverse(s, sc, g)
        assert (out["reversed"], out["shortfall"], out["on_hold"]) == (30, 70, 70), out
        assert _recovery(s, g) == (70, 0, 0, [job])
        # 0107's "lot attribution" limit is gone: the reversal itself spends the grant's lot.
        assert _spent_from(s, out["transaction_id"]) == [(lot, 30)]
        audit = s.value("select detail from public.app_audit_log where action = 'credits.reverse' order by id desc limit 1")
        assert (audit["reversed"], audit["shortfall"], audit["on_hold"]) == (30, 70, 70), audit

        assert _release(s, job) == 170
        assert _balanced(s, org) == 100, "every credit of the reversed grant must be gone; the welcome 100 stays"
        assert _recovery(s, g)[1:3] == (70, 0)
        [(txn, amount, by, note)] = _collections(s, org)
        assert amount == -70 and by is None, (amount, by)
        assert f"#{g}" in note and job in note, note
        assert _spent_from(s, txn) == [(lot, 70)], "the collection spends the grant's own lot"


def test_a_lot_that_expired_on_the_hold_counts_as_lapsed_with_no_ledger_row(conn, sc):
    """Grants do not expire today, but the policy is a row: credits of the grant's lot that ran out while held are gone already."""
    with as_superuser(conn, commit=False) as s:
        member, org = _workspace(s)
        g = _grant(s, sc, org)
        job = _hold(s, member, org, 170)
        _reverse(s, sc, g)
        s.rows("update public.credit_lots set expires_at = now() - interval '1 minute' where created_txn = %s returning 1", [g])
        _release(s, job)
        assert _recovery(s, g)[1:3] == (0, 70)
        assert _collections(s, org) == []
        assert _balanced(s, org) == 100


# ── two holds, and a purchase made afterwards ──────────────────────────────

def test_two_holds_each_pay_only_what_they_gave_back_and_a_later_purchase_stays_whole(conn, sc):
    with as_superuser(conn, commit=False) as s:
        _many_parallel_runs(s)
        member, org = _workspace(s)
        g = _grant(s, sc, org)
        a = _hold(s, member, org, 130)                       # welcome 100 + 30 of the grant
        b = _hold(s, member, org, 50)                        # 50 of the grant; 20 free
        out = _reverse(s, sc, g)
        assert (out["reversed"], out["shortfall"], out["on_hold"]) == (20, 80, 80), out
        assert _recovery(s, g) == (80, 0, 0, [a, b])

        _buy(s, org, 500)                                    # bought after the reversal: never the reversal's to take
        _release(s, a)
        assert _recovery(s, g)[1] == 30, "hold A gave 30 back to the grant's lot, and that is all it pays"
        assert _balanced(s, org) == 100 + 500 + 50          # B still holds 50 of the grant
        _release(s, b)
        assert _recovery(s, g)[1] == 80
        assert _balanced(s, org) == 600
        assert [r[1] for r in _collections(s, org)] == [-30, -50]


# ── captured: real spending ─────────────────────────────────────────────────

def test_a_hold_captured_after_the_reversal_is_spending_and_the_shortfall_stands(conn, sc):
    with as_superuser(conn, commit=False) as s:
        member, org = _workspace(s)
        g = _grant(s, sc, org)
        job = _hold(s, member, org, 170)
        _reverse(s, sc, g)
        assert _ok(_call(s, SERVICE, "select public.capture_credits(%s, 170)", [job])) == 170
        assert _recovery(s, g)[1:3] == (0, 0)
        assert _collections(s, org) == []
        assert _balanced(s, org) == 0
        again = _reverse(s, sc, g)
        assert again["duplicate"] is True and again["shortfall"] == 70 and again["on_hold"] == 70, again


# ── a hold placed after the reversal ───────────────────────────────────────

def test_a_hold_placed_after_the_reversal_is_never_collected(conn, sc):
    with as_superuser(conn, commit=False) as s:
        _many_parallel_runs(s)
        member, org = _workspace(s)
        g = _grant(s, sc, org)
        first = _hold(s, member, org, 170)
        _reverse(s, sc, g)
        _buy(s, org, 500)
        later = _hold(s, member, org, 200)
        _release(s, later)
        assert _recovery(s, g)[1] == 0 and _collections(s, org) == [], "a hold the reversal never met pays nothing"
        _release(s, first)
        assert _recovery(s, g)[1] == 70
        assert _balanced(s, org) == 600


# ── replay ──────────────────────────────────────────────────────────────────

def test_replays_of_the_reversal_the_release_the_expiry_and_the_migration_collect_once(conn, sc):
    with as_superuser(conn, commit=False) as s:
        member, org = _workspace(s)
        g = _grant(s, sc, org)
        job = _hold(s, member, org, 170)
        out = _reverse(s, sc, g)
        dup = _reverse(s, sc, g)
        assert dup["duplicate"] is True and dup["on_hold"] == out["on_hold"] == 70 and dup["shortfall"] == 70, dup
        assert s.value("select count(*) from public.credit_grant_reversal_recoveries where grant_txn_id = %s", [g]) == 1

        s.conn.execute(MIGRATION.read_text(encoding="utf-8").replace("set local lock_timeout = '5s';", ""))
        assert _recovery(s, g) == (70, 0, 0, [job])

        assert _release(s, job) == 170
        assert _release(s, job) == 0
        _ok(_call(s, SERVICE, "select public.expire_credit_reservations(%s)", [org]))
        after = _reverse(s, sc, g)
        assert after["duplicate"] is True
        assert _recovery(s, g)[1] == 70 and len(_collections(s, org)) == 1
        assert _balanced(s, org) == 100


def test_the_recovery_record_is_written_by_the_functions_only(conn, sc):
    with as_superuser(conn, commit=False) as s:
        member, org = _workspace(s)
        g = _grant(s, sc, org)
        job = _hold(s, member, org, 170)
        _reverse(s, sc, g)
        for q in ("update public.credit_grant_reversal_recoveries set owed = 1 where grant_txn_id = %s",
                  "update public.credit_grant_reversal_recoveries set holds = '{x}' where grant_txn_id = %s",
                  "update public.credit_grant_reversal_recoveries set lot_id = lot_id + 1 where grant_txn_id = %s",
                  "delete from public.credit_grant_reversal_recoveries where grant_txn_id = %s"):
            out = s.run(q, [g])
            assert not out.ok and out.sqlstate == "42501", (q, out)
        _release(s, job)
        out = s.run("update public.credit_grant_reversal_recoveries set collected = 0 where grant_txn_id = %s", [g])
        assert not out.ok and out.sqlstate == "42501", "collected never goes back down"
        assert not s.run("truncate public.credit_grant_reversal_recoveries").ok
        for actor in (SERVICE, member, sc.operator):
            out = _call(s, actor, "insert into public.credit_grant_reversal_recoveries (grant_txn_id, reversal_txn_id, lot_id, org_id, holds, owed) "
                                  "values (%s, %s, %s, %s, '{x}', 1)", [g, g, _lot(s, g), org])
            assert not out.ok and out.sqlstate == "42501", (actor.name, out)
        assert not _call(s, member, "select * from public.credit_grant_reversal_recoveries").ok
        assert _call(s, SERVICE, "select count(*) from public.credit_grant_reversal_recoveries where grant_txn_id = %s", [g]).ok


# ── who: a release inside the workspace's own call ─────────────────────────

def test_a_collection_made_inside_the_members_own_reserve_is_the_platforms_row(conn, sc):
    """Lazy expiry by the next reserve_credits is a release that runs as the member; the collection is still not theirs."""
    with as_superuser(conn, commit=False) as s:
        member, org = _workspace(s)
        g = _grant(s, sc, org)
        job = _hold(s, member, org, 170)
        _reverse(s, sc, g)
        _buy(s, org, 500)
        s.rows("update public.credit_reservations set created_at = now() - interval '3 hours 1 minute' where job_id = %s returning 1", [job])
        _hold(s, member, org, 100)
        assert s.value("select status from public.credit_reservations where job_id = %s", [job]) == "released"
        assert _recovery(s, g)[1] == 70
        [(_txn, amount, by, _note)] = _collections(s, org)
        assert (amount, by) == (-70, None), "the collection is the platform's act, never stamped with the member's id"
        assert _balanced(s, org) == 600


# ── one release, two collectors ─────────────────────────────────────────────

def test_a_refund_and_a_reversal_that_met_one_hold_together_take_no_more_than_it_gave_back(conn, sc):
    """0167's collector fires first and spends the lots the release gave back in spend order, the grant's lot included; this one then
    takes only what is left of the grant's lot in that release. Nothing is collected twice. The cost, pinned here so that a change to
    0167's lot order changes this test on purpose: the reversal's 50 went to the refund, which then needed 50 less from its own pack."""
    with as_superuser(conn, commit=False) as s:
        _many_parallel_runs(s)
        member, org = _workspace(s)
        ext = _buy(s, org, 1000)                             # a pack, which holds take before any lot that never expires
        g = _grant(s, sc, org)
        lot = _lot(s, g)
        k = _hold(s, member, org, 1000)                      # the pack
        j = _hold(s, member, org, 150)                       # welcome 100 + 50 of the grant; 50 free, all of it the grant's
        out = _reverse(s, sc, g)
        assert (out["reversed"], out["on_hold"], _recovery(s, g)[3]) == (50, 50, [j]), out
        rid = f"rf_{uuid.uuid4().hex[:12]}"
        ref = _ok(_call(s, SERVICE, "select public.refund_purchased_credits(%s, %s, null, 'lab', 'refund')", [ext, rid]))
        assert (ref["taken"], ref["on_hold"]) == (0, 1000), ref
        _buy(s, org, 500)                                    # after both: never theirs
        refund_collected = "select collected from public.credit_refund_recoveries where refund_id = %s"

        before = _balanced(s, org)
        _release(s, j)                                       # gives back 150: welcome 100 + grant 50
        assert before - _balanced(s, org) == 150, "one release of 150 pays 150 in all, never more"
        assert (s.value(refund_collected, [rid]), _recovery(s, g)[1]) == (150, 0)
        assert s.value("select coalesce(sum(-remaining_delta), 0) from public.credit_lot_moves where lot_id = %s and kind = 'spend'",
                       [lot]) == 100, "the grant's lot paid exactly what it had: 50 to the reversal itself, 50 to the refund"
        _release(s, k)
        assert s.value(refund_collected, [rid]) == 1000
        assert _balanced(s, org) == 650, "the later pack (500) is whole; the reversal's 50 stayed with the workspace via the refund's order"


def test_credits_that_came_into_the_grants_lot_from_elsewhere_do_not_let_one_release_pay_twice(conn, sc):
    """The grant's lot can hold free credits that no release gave back (a failed download's charge restored to the lot it was spent
    from, credit_lots_restore_locked). When 0167's collector has already taken this release's share of the lot, those credits are not
    the release's to pay a second time: the reversal subtracts what was spent from the lot since the release row."""
    with as_superuser(conn, commit=False) as s:
        _many_parallel_runs(s)
        member, org = _workspace(s)
        ext = _buy(s, org, 1000)
        g = _grant(s, sc, org)
        lot = _lot(s, g)
        _hold(s, member, org, 1000)                          # the pack
        j = _hold(s, member, org, 150)                       # welcome 100 + 50 of the grant
        assert _reverse(s, sc, g)["on_hold"] == 50
        _ok(_call(s, SERVICE, "select public.refund_purchased_credits(%s, %s, null, 'lab', 'refund')", [ext, f"rf_{uuid.uuid4().hex[:12]}"]))
        # 40 credits come back into the grant's lot from outside any release (as a restore would), kept consistent with the account.
        s.rows("update public.credit_lots set remaining = remaining + 40 where id = %s returning 1", [lot])
        s.rows("update public.credit_accounts set balance = balance + 40 where org_id = %s returning 1", [org])
        before = _balanced(s, org)
        _release(s, j)
        assert before - _balanced(s, org) == 150, "one release of 150 pays 150 in all: the restored 40 are not a second share"
        assert _recovery(s, g)[1] == 0


# ── the migration's shape ───────────────────────────────────────────────────

def test_the_collector_fires_after_the_lots_and_after_the_refund_collector():
    assert "credit_transactions_apply_lots" < "credit_transactions_recover_refunds" < "credit_transactions_recover_reversals"
    assert "create trigger credit_transactions_recover_reversals after insert on public.credit_transactions" in \
        MIGRATION.read_text(encoding="utf-8")


def test_a_release_that_meets_no_recovery_reads_nothing_but_the_open_index(conn):
    body = MIGRATION.read_text(encoding="utf-8").split("create or replace function public.credit_grant_reversal_recover()", 1)[1]
    first = body.split("return null;", 1)[0]
    assert "credit_lot_moves" not in first and "credit_grant_reversal_recoveries r" in first
    with as_superuser(conn, commit=False) as s:
        assert s.value("select indexdef from pg_indexes where indexname = 'credit_grant_reversal_recoveries_open_idx'").endswith(
            "WHERE ((collected + lapsed) < owed)")


# ── concurrency with reserve_credits (real commits, their own database) ─────

@pytest.fixture(scope="module")
def committing():
    dsn = sec_db.admin_dsn()
    if not dsn:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_reversehold_{uuid.uuid4().hex[:8]}"
    db_dsn = sec_db.build(dsn, name)
    try:
        yield db_dsn
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(dsn, name)


def _operator(c):
    """A platform owner of this scratch database (the lab's scenario is not seeded here)."""
    op = user("operator", f"op-{uuid.uuid4().hex[:8]}@lab.test")
    with as_superuser(c, commit=True) as s:
        s.rows("insert into auth.users (id, email, email_confirmed_at, created_at) values (%s, %s, now(), now()) returning 1",
               [op.uid, op.email])
        s.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner') returning 1", [op.uid, op.email])
    return op


class _Ops:
    def __init__(self, operator):
        self.operator = operator


def _begin(c, actor, aal=False):
    claims = actor.claims()
    if aal:
        claims["aal"] = "aal1"
    c.execute("begin")
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
    c.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    c.execute("set local role " + actor.role)


def _seed(db_dsn):
    with psycopg.connect(db_dsn, autocommit=True) as c:
        ops = _Ops(_operator(c))
        with as_superuser(c, commit=True) as s:
            member, org = _workspace(s)
            g = _grant(s, ops, org)
            avail = s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org])
    return ops, member, org, g, avail


def _waiting(admin, pid, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        row = admin.execute("select wait_event_type from pg_stat_activity where pid = %s", [pid]).fetchone()
        if row and row[0] == "Lock":
            return True
        time.sleep(0.05)
    return False


def _in_thread(fn):
    box = {}

    def run():
        try:
            box["ok"] = fn()
        except psycopg.Error as e:
            box["err"] = (e.sqlstate, str(e).splitlines()[0])
    t = threading.Thread(target=run)
    t.start()
    return t, box


def test_a_reversal_waiting_behind_a_hold_being_placed_records_that_hold(committing):
    ops, member, org, g, avail = _seed(committing)
    job = f"rj-race-{uuid.uuid4().hex[:8]}"
    with psycopg.connect(committing, autocommit=True) as a, psycopg.connect(committing, autocommit=True) as b, \
            psycopg.connect(committing, autocommit=True) as admin:
        _begin(a, member)
        a.execute("select public.reserve_credits(%s, %s, %s)", [org, job, avail - 30])
        _begin(b, ops.operator, aal=True)
        t, box = _in_thread(lambda: b.execute("select public.owner_reverse_grant(%s, %s)", [g, REASON]).fetchone()[0])
        assert _waiting(admin, b.info.backend_pid), "the reversal must queue behind the hold's account lock"
        a.execute("commit")
        t.join(20)
        b.execute("commit")
        assert "ok" in box, box
        assert (box["ok"]["reversed"], box["ok"]["on_hold"]) == (30, 70), box
        with as_superuser(admin, commit=True) as s:
            assert _recovery(s, g) == (70, 0, 0, [job])
            _release(s, job)
            assert _recovery(s, g)[1] == 70
            assert _balanced(s, org) == 100


def test_a_hold_waiting_behind_a_reversal_sees_what_the_reversal_took(committing):
    ops, member, org, g, avail = _seed(committing)
    with psycopg.connect(committing, autocommit=True) as a, psycopg.connect(committing, autocommit=True) as b, \
            psycopg.connect(committing, autocommit=True) as admin:
        _begin(b, ops.operator, aal=True)
        out = b.execute("select public.owner_reverse_grant(%s, %s)", [g, REASON]).fetchone()[0]
        assert (out["reversed"], out["on_hold"]) == (100, 0), out
        _begin(a, member)
        t, box = _in_thread(lambda: a.execute("select public.reserve_credits(%s, %s, %s)",
                                              [org, f"rj-race-{uuid.uuid4().hex[:8]}", avail]).fetchone()[0])
        assert _waiting(admin, a.info.backend_pid), "the hold must queue behind the reversal's account lock"
        b.execute("commit")
        t.join(20)
        a.execute("rollback")
        assert box.get("err", (None,))[0] == "NS402", box
        with as_superuser(admin, commit=True) as s:
            assert _recovery(s, g) is None
            assert _balanced(s, org) == 100
