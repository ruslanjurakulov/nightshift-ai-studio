"""Migration 0167: a refund that meets a hold takes those credits back when the hold is released (Breach BR-0034-01).

The Breach test (test_sec_breach_refund_hold.py) is the attack itself: everything held, a full refund, the hold expires. These are
the variants Patch's root-cause search turned up, each asserting the safe outcome:

  * a PARTIAL hold: the refund takes what is available now and the rest when the hold is released;
  * a hold CAPTURED after the refund: real spending, nothing collected, the shortfall stands and the ledger says so; the unused part
    of a capture is a release, and is collected;
  * TWO refunds of one purchase against one hold, and a hold placed AFTER a refund (on credits bought later), which is never touched;
  * REPLAY: the same refund id twice, a release twice, an expiry twice, the migration applied again — nothing is collected twice;
  * CONCURRENCY with reserve_credits on real, committing connections, in both orders.

Every in-transaction test ends with `set constraints all immediate`, which runs 0034's deferred lots-vs-balance check there and then.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from decimal import Decimal

import psycopg
import pytest

import sec_db
from sec_db import SERVICE, as_superuser, user

MIGRATION = sec_db.MIGRATIONS / "0167_refund_hold_recovery.sql"
BAL = "select balance, reserved from public.credit_accounts where org_id = %s"


def _as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")


def _call(s, actor, query, params=None):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)
    out = s.run(query, params)
    _as_owner(s)
    return out


def _ok(out):
    assert out.ok, out
    return out.rows[0][0] if out.rows else None


def _buyer(s, pack=1000):
    """A confirmed person, their new workspace (100 welcome credits) and one bought pack. Returns (person, org, purchase id)."""
    buyer = user("buyer", f"buyer-{uuid.uuid4().hex[:8]}@lab.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at, created_at) values (%s, %s, now(), now()) returning 1",
           [buyer.uid, buyer.email])
    org = str(_ok(_call(s, buyer, "select public.create_organization(%s)", [f"WS {uuid.uuid4().hex[:6]}"])))
    ext = f"pay_lab{uuid.uuid4().hex[:16]}"
    _ok(_call(s, SERVICE, "select public.add_purchased_credits(%s, %s, %s, 'lab purchase')", [org, pack, ext]))
    return buyer, org, ext


def _hold(s, buyer, org, amount):
    job = f"rj-hold-{uuid.uuid4().hex[:8]}"
    _ok(_call(s, buyer, "select public.reserve_credits(%s, %s, %s)", [org, job, amount]))
    return job


def _refund(s, ext, amount=None, rid=None):
    rid = rid or f"rf_{uuid.uuid4().hex[:12]}"
    out = _ok(_call(s, SERVICE, "select public.refund_purchased_credits(%s, %s, %s, 'lab', 'refund')", [ext, rid, amount]))
    return rid, out


def _expire(s, org, job):
    s.rows("update public.credit_reservations set created_at = now() - interval '3 hours 1 minute' where job_id = %s returning 1", [job])
    _ok(_call(s, SERVICE, "select public.expire_credit_reservations(%s)", [org]))
    assert s.value("select status from public.credit_reservations where job_id = %s", [job]) == "released"


def _balanced(s, org):
    """0034's invariant, now (not at a commit these rolled-back tests never reach), plus a balance that is never negative."""
    s.rows("set constraints all immediate")
    s.rows("set constraints all deferred")  # checked now; later statements in this transaction defer again, as in production
    bal, res = s.rows(BAL, [org])[0]
    lots = s.rows("select coalesce(sum(remaining), 0), coalesce(sum(held), 0) from public.credit_lots where org_id = %s and remaining > 0",
                  [org])[0]
    assert (bal, res) == tuple(lots), f"account {bal}/{res} vs lots {lots}"
    assert bal >= 0 and 0 <= res <= bal
    return bal


def _recovery(s, rid):
    rows = s.rows("select owed, collected, holds from public.credit_refund_recoveries where refund_id = %s", [rid])
    return rows[0] if rows else None


# ── a partial hold ──────────────────────────────────────────────────────────

def test_a_partial_hold_is_taken_back_when_it_is_released(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 400)                       # 1100 owned, 400 held, 700 available
        rid, out = _refund(s, ext)
        assert (out["taken"], out["shortfall"], out["on_hold"]) == (700, 300, 300), out
        assert s.value("select note from public.credit_refunds where refund_id = %s", [rid]).endswith(
            "700.00 taken back, 300.00 on hold (taken back if the hold is released, not if it is spent), 0.00 already spent and NOT recovered · lab")
        assert _recovery(s, rid) == (300, 0, [job])

        _expire(s, org, job)
        assert _balanced(s, org) == 100, "the refunded pack's credits must all be gone; the welcome 100 stays"
        assert _recovery(s, rid)[1] == 300
        note, amount = s.rows("select note, amount from public.credit_transactions where org_id = %s and kind = 'refund' "
                              "order by id desc limit 1", [org])[0]
        assert amount == -300 and rid in note and job in note, note


def test_lazy_expiry_by_the_next_reserve_collects_inside_the_browsers_own_call(conn):
    """Lazy expiry by the next reserve_credits is a release too; it collects inside the browser's own call."""
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, out = _refund(s, ext, 600)
        assert (out["taken"], out["on_hold"]) == (0, 600)
        s.rows("update public.credit_reservations set created_at = now() - interval '3 hours 1 minute' where job_id = %s returning 1", [job])
        _ok(_call(s, buyer, "select public.reserve_credits(%s, %s, 100)", [org, f"rj-next-{uuid.uuid4().hex[:8]}"]))
        assert s.value("select status from public.credit_reservations where job_id = %s", [job]) == "released"
        assert _recovery(s, rid)[1] == 600
        assert _balanced(s, org) == 500                       # 1100 - 600 refunded; 100 of it now on the new hold


# ── captured after the refund: real spending ────────────────────────────────

def test_a_hold_captured_after_the_refund_is_spending_and_the_shortfall_stands(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, out = _refund(s, ext)
        assert (out["taken"], out["shortfall"], out["on_hold"]) == (0, 1000, 1000)
        assert _ok(_call(s, SERVICE, "select public.start_credit_reservation(%s, %s)", [job, org])) == 1100
        assert _ok(_call(s, SERVICE, "select public.capture_credits(%s, 1100)", [job])) == 1100
        assert _balanced(s, org) == 0
        assert _recovery(s, rid)[1] == 0, "a capture is not a release: nothing to collect"
        assert s.rows("select taken, shortfall from public.credit_refunds where refund_id = %s", [rid])[0] == (0, 1000)
        assert s.value("select count(*) from public.credit_transactions where org_id = %s and kind = 'refund' and amount < 0", [org]) == 0


def test_the_unused_part_of_a_capture_is_released_and_collected(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, _ = _refund(s, ext)
        _ok(_call(s, SERVICE, "select public.start_credit_reservation(%s, %s)", [job, org]))
        assert _ok(_call(s, SERVICE, "select public.capture_credits(%s, 600)", [job])) == 600
        assert _recovery(s, rid)[1] == 500, "600 spent, 500 released: the refund takes the 500"
        assert _balanced(s, org) == 0


# ── two refunds; a hold placed after a refund ───────────────────────────────

def test_two_refunds_of_one_purchase_each_collect_their_own_part_once(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid1, out1 = _refund(s, ext, 400)
        rid2, out2 = _refund(s, ext)                          # the rest: 600
        assert (out1["on_hold"], out2["requested"], out2["on_hold"]) == (400, 600, 600)
        _expire(s, org, job)
        assert (_recovery(s, rid1)[1], _recovery(s, rid2)[1]) == (400, 600)
        assert _balanced(s, org) == 100
        # A third refund of the same purchase asks for nothing: the two add up to the purchase.
        _rid3, out3 = _refund(s, ext)
        assert (out3["requested"], out3["on_hold"]) == (0, 0)
        assert _balanced(s, org) == 100


def test_a_hold_placed_after_the_refund_on_credits_bought_later_is_never_collected(conn):
    """0021's reason for not carrying a debt: a refund must not eat the next purchase."""
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job1 = _hold(s, buyer, org, 1100)
        rid, _ = _refund(s, ext)
        _ok(_call(s, SERVICE, "select public.start_credit_reservation(%s, %s)", [job1, org]))
        _ok(_call(s, SERVICE, "select public.capture_credits(%s, 1100)", [job1]))   # spent: 1000 stays owed, uncollectable
        assert _balanced(s, org) == 0
        _ok(_call(s, SERVICE, "select public.add_purchased_credits(%s, 500, %s, 'second pack')", [org, f"pay_lab{uuid.uuid4().hex[:16]}"]))
        job2 = _hold(s, buyer, org, 500)
        _expire(s, org, job2)
        assert _balanced(s, org) == 500, "the later pack's credits came back whole"
        assert _recovery(s, rid)[1] == 0


# ── lots that expire on the hold (Lens on #766) ─────────────────────────────

def _expire_lot_of(s, org, where, params):
    s.rows(f"update public.credit_lots set expires_at = now() - interval '1 second' where org_id = %s and {where} returning 1",
           [org, *params])


def _lapsed(s, rid):
    return s.value("select lapsed from public.credit_refund_recoveries where refund_id = %s", [rid])


def test_a_refunded_lot_that_expired_on_the_hold_is_not_paid_again_from_a_later_purchase(conn):
    """Lens's repro: the refunded pack's lot runs out while held, a second pack is bought, the hold expires. The expired credits are
    gone, which is what the refund wanted; the later pack must come through whole. Before the fix: balance 100 instead of 1100."""
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, out = _refund(s, ext)
        assert (out["taken"], out["on_hold"]) == (0, 1000)
        _expire_lot_of(s, org, "external_id = %s", [ext])
        _ok(_call(s, SERVICE, "select public.add_purchased_credits(%s, 1000, %s, 'later pack')", [org, f"pay_lab{uuid.uuid4().hex[:16]}"]))
        _expire(s, org, job)
        assert _balanced(s, org) == 1100, "the welcome 100 and the later pack stay: nothing is collected"
        assert (_recovery(s, rid)[1], _lapsed(s, rid)) == (0, 1000), "the expired refunded credits are counted, not collected twice"
        assert s.value("select count(*) from public.credit_transactions where org_id = %s and kind = 'refund' and amount < 0", [org]) == 0


def test_another_lot_that_expired_on_the_hold_leaves_the_refunded_credits_to_collect_and_spares_the_later_purchase(conn):
    """The mirror case: the WELCOME lot runs out on the hold, the refunded pack does not. The refund takes the pack's 1000 that came
    back; the later pack is untouched."""
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, _ = _refund(s, ext)
        _expire_lot_of(s, org, "external_id is distinct from %s", [ext])
        _ok(_call(s, SERVICE, "select public.add_purchased_credits(%s, 1000, %s, 'later pack')", [org, f"pay_lab{uuid.uuid4().hex[:16]}"]))
        _expire(s, org, job)
        assert _balanced(s, org) == 1000, "welcome expired, refunded pack taken back, later pack whole"
        assert (_recovery(s, rid)[1], _lapsed(s, rid)) == (1000, 0)


def test_a_subscription_payment_refunded_over_a_hold_is_collected_from_its_own_lot(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, _pack = _buyer(s, pack=1)
        sub, txn = f"sub_{uuid.uuid4().hex[:26]}", f"txn_{uuid.uuid4().hex[:26]}"
        _ok(_call(s, SERVICE, "select public.upsert_subscription(%s, %s, %s, 'creator', null, 'active', now() - interval '1 day', "
                              "now() + interval '29 days', false, null, now())", [org, sub, f"ctm_{uuid.uuid4().hex[:26]}"]))
        granted = _ok(_call(s, SERVICE, "select public.grant_subscription_credits(%s, %s, 'creator', now() - interval '1 day', "
                                        "now() + interval '29 days', %s)", [org, sub, txn]))["granted"]
        granted = Decimal(str(granted))
        assert granted > 0
        before = s.rows(BAL, [org])[0][0] - granted
        job = _hold(s, buyer, org, s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org]))
        rid, out = _refund(s, txn)
        assert (Decimal(str(out["taken"])), Decimal(str(out["on_hold"]))) == (0, granted), out
        _expire(s, org, job)
        assert _balanced(s, org) == before, "the plan period's credits are taken back; welcome and the small pack stay"
        assert _recovery(s, rid)[1] == granted
        spent_from = s.rows("select l.source from public.credit_lot_moves m join public.credit_lots l on l.id = m.lot_id "
                            "join public.credit_transactions t on t.id = m.txn_id "
                            "where t.org_id = %s and t.kind = 'refund' and m.kind = 'spend'", [org])
        assert {r[0] for r in spent_from} == {"subscription"}, spent_from


def test_a_started_hold_that_never_settles_is_collected_when_it_expires(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, _ = _refund(s, ext)
        _ok(_call(s, SERVICE, "select public.start_credit_reservation(%s, %s)", [job, org]))
        s.rows("update public.credit_reservations set started_at = now() - interval '24 hours 1 minute' where job_id = %s returning 1", [job])
        _ok(_call(s, SERVICE, "select public.expire_credit_reservations(%s)", [org]))
        assert s.value("select status from public.credit_reservations where job_id = %s", [job]) == "released"
        assert _recovery(s, rid)[1] == 1000
        assert _balanced(s, org) == 100


def test_a_storyboard_undo_is_a_release_and_collects(conn):
    """0057's storyboard_dispatch_failed: the approver undoes an Actions dispatch the route saw fail, in their own session."""
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        ch = f"chan-rh-{uuid.uuid4().hex[:8]}"
        s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, 'Refund lab', 'tech', 'PAUSED', %s) "
               "returning 1", [ch, org])
        scenes = [{"n": i + 1, "name": f"Scene {i + 1}", "type": "story", "narration": f"Line {i + 1}.", "visual": "harbour",
                   "duration_s": 100} for i in range(3)]
        script = {"topic": "t", "title": "T", "sections": [{"name": f"s{i}", "narration": f"Line {i}."} for i in range(3)]}
        sb = str(s.value("insert into public.storyboards (channel_id, slug, topic, title, scenes, script, duration_s) "
                         "values (%s, 'plan-rh', 'A topic', 'A title', %s::jsonb, %s::jsonb, 300) returning id",
                         [ch, json.dumps(scenes), json.dumps(script)]))
        approved = _ok(_call(s, buyer, "select public.approve_storyboard(%s, 1100, 'actions')", [sb]))
        job = approved["credit_ref"]
        rid, out = _refund(s, ext)
        assert out["on_hold"] == 1000 and _recovery(s, rid)[2] == [job]
        undo = _ok(_call(s, buyer, "select public.storyboard_dispatch_failed(%s)", [sb]))
        assert undo["released"] == 1100
        assert _recovery(s, rid)[1] == 1000
        assert _balanced(s, org) == 100


def test_a_collection_made_inside_the_buyers_own_call_is_not_signed_with_their_name(conn):
    """The lazy release in reserve_credits runs in the buyer's session; the collection is the platform's act (created_by null)."""
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, _ = _refund(s, ext)
        s.rows("update public.credit_reservations set created_at = now() - interval '3 hours 1 minute' where job_id = %s returning 1", [job])
        _ok(_call(s, buyer, "select public.reserve_credits(%s, %s, 100)", [org, f"rj-next-{uuid.uuid4().hex[:8]}"]))
        rows = s.rows("select created_by, balance_after, reserved_after, amount from public.credit_transactions "
                      "where org_id = %s and kind = 'refund' and note like %s", [org, f"%{rid}%"])
        assert len(rows) == 1 and rows[0][0] is None, rows
        assert rows[0][3] == -1000
        release_by = s.value("select created_by::text from public.credit_transactions where org_id = %s and kind = 'release' and job_id = %s",
                             [org, job])
        assert release_by == buyer.uid, "control: the release itself is the buyer's call"
        assert _balanced(s, org) == 100


def test_the_open_recoveries_query_leaves_out_one_whose_holds_were_all_captured(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    query = text.split("-- Refunds whose held part is still open", 1)[1].split("order by r.created_at;", 1)[0]
    query = "\n".join(ln.split("--", 1)[1] for ln in query.splitlines()[2:]).strip()
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, _ = _refund(s, ext)
        open_q = f"select count(*) from ({query}) q where q.refund_id = %s"
        assert s.value(open_q, [rid]) == 1
        _ok(_call(s, SERVICE, "select public.start_credit_reservation(%s, %s)", [job, org]))
        _ok(_call(s, SERVICE, "select public.capture_credits(%s, 1100)", [job]))
        assert s.value(open_q, [rid]) == 0, "captured: spent, not open"


def test_the_collection_spends_the_lot_the_release_gave_back_not_a_later_purchase(conn):
    """Lens round 2 on #766: the refunded pack A is spent for real, 100 welcome credits are held, A is refunded (on hold 100), a pack B
    is bought, the hold expires. The 100 that come back are W's, and W pays: B stays whole. (Before: the lot trigger preferred A, which
    was empty, and then took B in spend order.)"""
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        s.rows("update public.credit_lots set expires_at = null where org_id = %s and external_id is distinct from %s returning 1", [org, ext])
        s.rows("update public.credit_lots set expires_at = now() + interval '1 day' where org_id = %s and external_id = %s returning 1",
               [org, ext])
        spend = _hold(s, buyer, org, 1000)                    # A expires first, so the hold (and the capture) sits on A
        _ok(_call(s, SERVICE, "select public.start_credit_reservation(%s, %s)", [spend, org]))
        _ok(_call(s, SERVICE, "select public.capture_credits(%s, 1000)", [spend]))
        w = s.value("select id from public.credit_lots where org_id = %s and remaining > 0", [org])
        job = _hold(s, buyer, org, 100)                       # on W, the only lot left
        rid, out = _refund(s, ext)
        assert (out["taken"], out["on_hold"]) == (0, 100), out
        ext_b = f"pay_lab{uuid.uuid4().hex[:16]}"
        _ok(_call(s, SERVICE, "select public.add_purchased_credits(%s, 1000, %s, 'later pack')", [org, ext_b]))
        s.rows("update public.credit_lots set expires_at = now() + interval '2 days' where org_id = %s and external_id = %s returning 1",
               [org, ext_b])                                 # B would come first in spend order
        # 0165's setting for 'adjust' rows, left naming B, must not steer a 'refund' row (each setting is read in its own branch only).
        s.rows("select set_config('nightshift.adjust_lot_first', %s, true)", [ext_b])
        _expire(s, org, job)
        assert _recovery(s, rid)[1] == 100
        assert s.value("select current_setting('nightshift.refund_lot', true)") == "", "the collector resets its own setting"
        assert s.value("select current_setting('nightshift.adjust_lot_first', true)") == ext_b, "and never touches 0165's"
        s.rows("select set_config('nightshift.adjust_lot_first', '', true)")
        assert s.value("select remaining from public.credit_lots where id = %s", [w]) == 0, "W, the lot the release returned, pays"
        assert s.value("select remaining from public.credit_lots where org_id = %s and external_id = %s", [org, ext_b]) == 1000
        assert _balanced(s, org) == 1000


def _plan(s, query):
    s.rows("set local enable_seqscan = off")  # any index that can serve the predicate is then chosen; a missing one shows as Seq Scan
    plan = "\n".join(r[0] for r in s.rows("explain " + query))
    s.rows("set local enable_seqscan = on")
    return plan


def test_the_collectors_queries_never_scan_the_whole_moves_table(conn):
    """Lens round 2 on #766: credit_lot_moves has no txn_id index; at 200k moves a release cost 21.9 ms instead of 0.04 ms. Each
    query of the collector, as written in the migration, is planned here with the hold's job and the release row filled in."""
    body = MIGRATION.read_text(encoding="utf-8").split("create or replace function public.credit_refund_recover()", 1)[1]
    body = body.split("$$", 2)[1]
    live_q = body.split("select coalesce(sum(-m.held_delta), 0) into live_", 1)[1].split(";", 1)[0]
    lots_q = body.split("for lot in", 1)[1].split("\n    loop", 1)[0]
    first = body.split("if not exists (", 1)[1].split(") then", 1)[0]
    fill = {"new.job_id": "'rj-plan-x'", "new.id": "1", "new.org_id": "'00000000-0000-4000-8000-000000000000'::uuid",
            "rec.purchase_external_id": "'pay_x'"}

    def filled(q):
        for k, v in fill.items():
            q = q.replace(k, v)
        return q

    with as_superuser(conn, commit=False) as s:
        for name, q in (("live", "select coalesce(sum(-m.held_delta), 0) " + live_q), ("lots", lots_q)):
            plan = _plan(s, filled(q))
            assert "Seq Scan on credit_lot_moves" not in plan, (name, plan)
            assert "credit_lot_moves_job_idx" in plan, (name, plan)
        # The control: without the job filter the job index is out of reach, and the moves are read from every live lot of every
        # organization (no txn_id index), so the filter is what makes the plan above possible.
        unfiltered = _plan(s, filled("select coalesce(sum(-m.held_delta), 0) " + live_q.replace("m.job_id = new.job_id and ", "")))
        assert "credit_lot_moves_job_idx" not in unfiltered, unfiltered
        plan = _plan(s, filled(first))
        assert "credit_refund_recoveries_open_idx" in plan and "Seq Scan on credit_refund_recoveries" not in plan, plan


def test_a_release_that_meets_no_recovery_does_not_read_the_moves_table(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, _ext = _buyer(s)
        job = _hold(s, buyer, org, 500)
        q = ("select coalesce(seq_scan, 0) + coalesce(idx_scan, 0) from pg_stat_xact_user_tables "
             "where relid = 'public.credit_lot_moves'::regclass")
        before = s.value(q)
        _ok(_call(s, SERVICE, "select public.release_credits(%s)", [job]))
        assert s.value(q) == before, "the collector returned before reading credit_lot_moves"
        assert _balanced(s, org) == 1100


# ── replay ──────────────────────────────────────────────────────────────────

def test_replays_of_the_refund_the_release_the_expiry_and_the_migration_collect_once(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, out = _refund(s, ext)
        _again, dup = _refund(s, ext, rid=rid)
        assert dup["duplicate"] is True and dup["on_hold"] == out["on_hold"] == 1000
        assert s.value("select count(*) from public.credit_refund_recoveries where refund_id = %s", [rid]) == 1

        # The migration again, with a recovery row open: it finds its own bodies and changes nothing.
        text = MIGRATION.read_text(encoding="utf-8")
        s.conn.execute(text.replace("set local lock_timeout = '5s';", ""))
        assert _recovery(s, rid) == (1000, 0, [job])

        assert _ok(_call(s, SERVICE, "select public.release_credits(%s)", [job])) == 1100
        assert _ok(_call(s, SERVICE, "select public.release_credits(%s)", [job])) == 0
        _ok(_call(s, SERVICE, "select public.expire_credit_reservations(%s)", [org]))
        assert _recovery(s, rid)[1] == 1000
        assert s.value("select count(*) from public.credit_transactions where org_id = %s and kind = 'refund' and note like %s",
                       [org, f"%{rid}%"]) == 1
        assert _balanced(s, org) == 100


def test_the_recovery_record_is_written_by_the_functions_only(conn):
    with as_superuser(conn, commit=False) as s:
        buyer, org, ext = _buyer(s)
        job = _hold(s, buyer, org, 1100)
        rid, _ = _refund(s, ext)
        for q in ("update public.credit_refund_recoveries set owed = 1 where refund_id = %s",
                  "update public.credit_refund_recoveries set holds = '{x}' where refund_id = %s",
                  "delete from public.credit_refund_recoveries where refund_id = %s"):
            out = s.run(q, [rid])
            assert (not out.ok and out.sqlstate == "42501") or (out.ok and out.rowcount == 0), (q, out)
        _expire(s, org, job)
        out = s.run("update public.credit_refund_recoveries set collected = 0 where refund_id = %s", [rid])
        assert not out.ok and out.sqlstate == "42501", "collected never goes back down"
        assert not s.run("truncate public.credit_refund_recoveries").ok
        for actor in (SERVICE, buyer):
            out = _call(s, actor, "insert into public.credit_refund_recoveries (refund_id, purchase_external_id, org_id, holds, owed) "
                                  "values (%s, %s, %s, '{x}', 1)", [rid + "x", ext, org])
            assert not out.ok and out.sqlstate == "42501", (actor.name, out)
        assert not _call(s, buyer, "select * from public.credit_refund_recoveries").ok


def test_the_collector_fires_after_the_lots_are_released():
    """Triggers on one event fire in name order: the collection must spend lots the release has already given back."""
    assert "credit_transactions_apply_lots" < "credit_transactions_recover_refunds"
    assert "create trigger credit_transactions_recover_refunds after insert on public.credit_transactions" in \
        MIGRATION.read_text(encoding="utf-8")


# ── concurrency with reserve_credits (real commits, their own database) ─────

@pytest.fixture(scope="module")
def committing():
    dsn = sec_db.admin_dsn()
    if not dsn:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_refundhold_{uuid.uuid4().hex[:8]}"
    db_dsn = sec_db.build(dsn, name)
    try:
        yield db_dsn
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(dsn, name)


def _begin(c, actor):
    c.execute("begin")
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    c.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    c.execute("set local role " + actor.role)


def _seed(db_dsn):
    with psycopg.connect(db_dsn, autocommit=True) as c:
        with as_superuser(c, commit=True) as s:
            buyer, org, ext = _buyer(s)
            avail = s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org])
    return buyer, org, ext, avail


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


def test_a_refund_waiting_behind_a_hold_being_placed_records_that_hold(committing):
    """The race the attack needs: the browser's reserve and the webhook's refund at the same instant. The refund waits on the
    account lock, then sees the committed hold and records it; the hold's expiry then collects."""
    buyer, org, ext, avail = _seed(committing)
    job = f"rj-race-{uuid.uuid4().hex[:8]}"
    rid = f"rf_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(committing, autocommit=True) as a, psycopg.connect(committing, autocommit=True) as b, \
            psycopg.connect(committing, autocommit=True) as admin:
        _begin(a, buyer)
        a.execute("select public.reserve_credits(%s, %s, %s)", [org, job, avail])
        _begin(b, SERVICE)
        t, box = _in_thread(lambda: b.execute("select public.refund_purchased_credits(%s, %s, null, 'lab', 'refund')",
                                              [ext, rid]).fetchone()[0])
        assert _waiting(admin, b.info.backend_pid), "the refund must queue behind the hold's account lock"
        a.execute("commit")
        t.join(20)
        b.execute("commit")
        assert "ok" in box, box
        assert (box["ok"]["taken"], box["ok"]["on_hold"]) == (0, 1000), box
        with as_superuser(admin, commit=True) as s:
            assert _recovery(s, rid) == (1000, 0, [job])
            _expire(s, org, job)
            assert _balanced(s, org) == 100


def test_a_hold_waiting_behind_a_refund_sees_what_the_refund_took(committing):
    """The other order: the refund holds the lock, the browser's reserve of what it saw as available waits, then is refused NS402
    (the credits are gone), and nothing is owed because the refund took everything."""
    buyer, org, ext, avail = _seed(committing)
    rid = f"rf_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(committing, autocommit=True) as a, psycopg.connect(committing, autocommit=True) as b, \
            psycopg.connect(committing, autocommit=True) as admin:
        _begin(b, SERVICE)
        out = b.execute("select public.refund_purchased_credits(%s, %s, null, 'lab', 'refund')", [ext, rid]).fetchone()[0]
        assert (out["taken"], out["on_hold"]) == (1000, 0)
        _begin(a, buyer)
        t, box = _in_thread(lambda: a.execute("select public.reserve_credits(%s, %s, %s)",
                                              [org, f"rj-race-{uuid.uuid4().hex[:8]}", avail]).fetchone()[0])
        assert _waiting(admin, a.info.backend_pid), "the hold must queue behind the refund's account lock"
        b.execute("commit")
        t.join(20)
        a.execute("rollback")
        assert box.get("err", (None,))[0] == "NS402", box
        with as_superuser(admin, commit=True) as s:
            assert _recovery(s, rid) is None
            assert _balanced(s, org) == 100
