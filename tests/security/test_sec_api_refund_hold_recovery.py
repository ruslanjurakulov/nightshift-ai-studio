"""Migration 0168: a refund of an API top-up that meets a hold takes those cents back when the hold is released (BR-0031-01).

The Breach test (test_sec_breach_api_refund_hold.py) is the attack itself: everything held by API runs, a full refund, the runs fail.
These are the variants the root-cause search turned up, each asserting the safe outcome:

  * a PARTIAL hold: the refund takes what is available now and the rest when the hold is released; the 24-hour expiry is a release;
  * a hold CAPTURED after the refund: real spending, nothing collected, the shortfall stands;
  * TWO refunds of one top-up; two refunds of two top-ups that met ONE hold, with a top-up made afterwards (Lens on 0167: a release
    pays at most what it gave back, so the later top-up stays whole);
  * a hold placed AFTER the refund, on cents topped up later, which is never touched;
  * the other holder of API cents, a paid DOWNLOAD (api_request_download), released when it fails;
  * held cents cannot be consumed while held, and a ledger row that is no real release of its hold collects nothing;
  * REPLAY: the same refund id twice, a job failed twice, an expiry after the release, the migration applied again;
  * WHO: a collection made inside the customer's own API call (the lazy expiry) is the platform's row, never the customer's;
  * CONCURRENCY with api_create_video's hold on real, committing connections, in both orders.

Every in-transaction test checks the account against the ledger and the open holds (sec_api_refund_lab.balanced).
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
from sec_db import ANON, SERVICE, as_superuser

from sec_api_refund_lab import (account, as_owner, balanced, call, customer, end_job, hold_status, ok, refund, run, topup)

MIGRATION = sec_db.MIGRATIONS / "0168_api_refund_hold_recovery.sql"


def _recovery(s, rid):
    rows = s.rows("select owed, collected, holds from public.api_refund_recoveries where refund_id = %s", [rid])
    return tuple(rows[0]) if rows else None


def _collections(s, org):
    """The rows the collector wrote: refunds with no refund id of their own, naming the hold they came from."""
    return s.rows("select amount_cents, hold_ref, source_external_id, requested_cents, created_by, note from public.api_ledger "
                  "where org_id = %s and kind = 'refund' and external_id is null order by id", [org])


def _expire_unstarted(s, org, ref):
    """24 hours later the hold has never started: the platform's expiry (api_expire_holds_locked, under the account lock) releases it."""
    s.rows("update public.api_holds set created_at = now() - interval '24 hours 1 minute' where ref = %s returning 1", [ref])
    s.rows("select public.api_account_lock(%s) is not null", [org])
    s.rows("select public.api_expire_holds_locked(%s)", [org])
    assert hold_status(s, ref) == "released"


# ── a partial hold; the expiry ──────────────────────────────────────────────

def test_a_partial_hold_is_taken_back_when_its_run_fails(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        job, ref, price = run(s, c, 1000)                     # 5000 paid, 2000 held, 3000 available
        assert price == 2000
        rid, out = refund(s, ext)
        assert (out["taken_cents"], out["shortfall_cents"], out["on_hold_cents"]) == (3000, 2000, 2000), out
        assert s.value("select note from public.api_ledger where external_id = %s", [rid]).endswith(
            "3000 taken back, 2000 on hold (taken back if the hold is released, not if it is spent), 0 already spent and NOT recovered · lab")
        assert _recovery(s, rid) == (2000, 0, [ref])

        end_job(s, job, "failed")
        assert hold_status(s, ref) == "released"
        assert balanced(s, c.org) == 0, "every cent of the refunded top-up must be gone"
        assert _recovery(s, rid)[1] == 2000
        [(amount, hold, source, requested, by, note)] = _collections(s, c.org)
        assert (amount, hold, source, requested, by) == (-2000, ref, ext, None, None)
        assert rid in note and ref in note and note.startswith("refund of top-up "), note
        assert s.value("select paid_total_cents from public.api_accounts where org_id = %s", [c.org]) == 0, \
            "the collection is not a second refund: paid_total moved once, by the refund"


def test_the_24_hour_expiry_of_an_unstarted_hold_collects(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        _job, ref, _ = run(s, c, 2500)
        rid, out = refund(s, ext, 3000, reason="chargeback")
        assert (out["taken_cents"], out["on_hold_cents"]) == (0, 3000)
        _expire_unstarted(s, c.org, ref)
        assert _recovery(s, rid)[1] == 3000
        assert balanced(s, c.org) == 2000                     # 5000 - 3000 charged back
        assert _collections(s, c.org)[0][5].startswith("chargeback of top-up ")


# ── captured after the refund: real spending ────────────────────────────────

def test_a_hold_captured_after_the_refund_is_spending_and_the_shortfall_stands(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        job, ref, _ = run(s, c, 2500)
        rid, out = refund(s, ext)
        assert (out["taken_cents"], out["shortfall_cents"], out["on_hold_cents"]) == (0, 5000, 5000)
        end_job(s, job, "succeeded")
        assert hold_status(s, ref) == "captured"
        assert balanced(s, c.org) == 0
        assert _recovery(s, rid)[1] == 0, "a capture is not a release: nothing to collect"
        assert _collections(s, c.org) == []
        assert s.value("select amount_cents from public.api_ledger where org_id = %s and kind = 'usage'", [c.org]) == -5000


# ── two refunds; a later top-up; a hold placed after a refund ───────────────

def test_two_refunds_of_one_topup_each_collect_their_own_part_once(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        job, _ref, _ = run(s, c, 2500)
        rid1, out1 = refund(s, ext, 2000)
        rid2, out2 = refund(s, ext)                           # the rest: 3000
        assert (out1["on_hold_cents"], out2["requested_cents"], out2["on_hold_cents"]) == (2000, 3000, 3000)
        end_job(s, job, "failed")
        assert (_recovery(s, rid1)[1], _recovery(s, rid2)[1]) == (2000, 3000)
        assert balanced(s, c.org) == 0
        # A third refund of the same top-up asks for nothing: the collections are not refunds of their own.
        rid3, out3 = refund(s, ext)
        assert (out3["requested_cents"], out3["on_hold_cents"]) == (0, 0) and _recovery(s, rid3) is None
        assert balanced(s, c.org) == 0


def test_two_refunds_that_met_one_hold_share_what_it_gave_back_and_a_later_topup_stays_whole(conn):
    """Lens on 0167: a collection must not eat funds added after the refund. Two top-ups of 3000 are refunded while one 3000 hold is
    open (3000 was already spent): each refund records 3000 on hold, 6000 in all, more than the hold. A 4000 top-up comes after. The
    release gives back 3000 and pays exactly that: the first refund in full, the second nothing, and the 4000 stays."""
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext1, ext2 = topup(s, c, 3000), topup(s, c, 3000)
        spent, _r, _ = run(s, c, 1500)
        end_job(s, spent, "succeeded")                        # 3000 really spent
        job, ref, _ = run(s, c, 1500)                         # 3000 held, 0 available
        rid1, out1 = refund(s, ext1)
        rid2, out2 = refund(s, ext2)
        assert (out1["on_hold_cents"], out2["on_hold_cents"]) == (3000, 3000)
        later = topup(s, c, 4000)
        assert account(s, c.org) == (7000, 3000)
        end_job(s, job, "failed")
        assert (_recovery(s, rid1)[1], _recovery(s, rid2)[1]) == (3000, 0)
        assert balanced(s, c.org) == 4000, "the top-up made after the refunds must come through whole"
        assert [r[2] for r in _collections(s, c.org)] == [ext1]
        assert later not in [r[2] for r in _collections(s, c.org)]


def test_one_refund_over_two_holds_takes_from_each_release_only_what_that_release_gave_back(conn):
    """One refund meets two holds (2000 and 3000), and a top-up of 4000 follows. The 2000 hold is released: the refund may take that
    2000 and not a cent more, though 5000 is owed and 9000 sits on the balance. The 3000 hold is then captured (spent): the shortfall
    of 3000 stands, and the later top-up is whole."""
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        job1, ref1, _ = run(s, c, 1000)
        job2, ref2, _ = run(s, c, 1500)
        rid, out = refund(s, ext)
        assert (out["taken_cents"], out["on_hold_cents"]) == (0, 5000)
        assert _recovery(s, rid) == (5000, 0, [ref1, ref2])
        topup(s, c, 4000)
        end_job(s, job1, "failed")
        assert _recovery(s, rid)[1] == 2000, "a 2000 release pays 2000"
        assert account(s, c.org) == (7000, 3000)
        end_job(s, job2, "succeeded")
        assert _recovery(s, rid)[1] == 2000
        assert balanced(s, c.org) == 4000, "the top-up made after the refund must come through whole"


def test_a_hold_placed_after_the_refund_on_a_later_topup_is_never_collected(conn):
    """0021's reason for not carrying a debt: a refund must not eat the next top-up. Only the hold that was open at the refund pays."""
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        job1, ref1, _ = run(s, c, 1000)                       # 2000 held before the refund
        rid, out = refund(s, ext)
        assert (out["taken_cents"], out["on_hold_cents"]) == (3000, 2000)
        topup(s, c, 3000)
        job2, ref2, price2 = run(s, c, 1500)                  # 3000 held after the refund
        assert price2 == 3000
        assert _recovery(s, rid)[2] == [ref1]
        end_job(s, job2, "failed")
        assert _recovery(s, rid)[1] == 0, "the later hold is not one the refund met"
        assert balanced(s, c.org) == 5000
        end_job(s, job1, "failed")
        assert _recovery(s, rid)[1] == 2000
        assert balanced(s, c.org) == 3000, "the later top-up came back whole"
        assert [r[1] for r in _collections(s, c.org)] == [ref1]


def test_a_hold_captured_after_the_refund_then_a_later_hold_released_collects_nothing(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        job1, _ref1, _ = run(s, c, 2500)
        rid, _ = refund(s, ext)
        end_job(s, job1, "succeeded")                         # spent: 5000 stays owed, uncollectable
        topup(s, c, 3000)
        job2, _ref2, _ = run(s, c, 1500)
        end_job(s, job2, "failed")
        assert _recovery(s, rid)[1] == 0
        assert balanced(s, c.org) == 3000


# ── the other holder of API cents: a paid download ──────────────────────────

def _download_hold(s, c, price):
    """A paid download's hold, placed by api_request_download's own statements (0147: the request row, the hold bound to it, the
    reservation, the 'hold' ledger row). Not through the function itself: on main it answers internal_error before it commits a
    hold, because its audit action 'video.download' is not on the audit allow-list (0087 lists 'video.download_request'). That
    fails closed and is reported separately; the release path tested here (api_settle_download) is the one a download hold takes."""
    rid = s.value("insert into public.download_requests (org_id, channel_id, video_id, quality, status, charged, paid_until, minutes, "
                  "requested_by) values (%s, %s, %s, '1080p', 'queued', 0, now() + interval '7 days', 10, %s) returning id",
                  [c.org, c.channel, c.video, c.actor.uid])
    ref = f"ah-{uuid.uuid4()}"
    key = s.value("select id from public.api_keys where key_hash = %s", [c.key_hash])
    s.rows("select public.api_account_lock(%s) is not null", [c.org])
    s.rows("insert into public.api_holds (ref, org_id, key_id, download_request_id, amount_cents) values (%s, %s, %s, %s, %s) returning 1",
           [ref, c.org, key, rid, price])
    s.rows("update public.api_accounts set reserved_cents = reserved_cents + %s, updated_at = now() where org_id = %s returning 1",
           [price, c.org])
    s.rows("select public.api_log(%s, 'hold', %s, %s, %s, null, null, null, 'download 1080p of the lab video')", [c.org, price, ref, key])
    return rid, ref


def test_a_download_hold_open_at_the_refund_is_collected_when_the_download_fails(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        price = s.value("select ceil(public.download_credits_price(600, '1080p') * p.cents)::bigint from public.api_prices p "
                        "where p.unit = 'download_cents_per_credit'")
        assert 0 < price < 5000
        request, ref = _download_hold(s, c, price)
        rid, out = refund(s, ext)
        assert (out["taken_cents"], out["on_hold_cents"]) == (5000 - price, price)
        s.rows("update public.download_requests set status = 'failed' where id = %s returning 1", [request])
        assert hold_status(s, ref) == "released"
        assert _recovery(s, rid)[1] == price
        assert balanced(s, c.org) == 0


# ── held cents are never consumed; only a real release pays ─────────────────

def test_held_cents_cannot_be_taken_while_held_so_a_release_gives_back_its_whole_amount(conn):
    """API cents have no lots and never expire. What could make a release give back less than its amount is something taking held
    cents meanwhile: an adjustment and a second refund both stop at what is available."""
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext1, ext2 = topup(s, c, 3000), topup(s, c, 2000)
        job, ref, _ = run(s, c, 2500)                         # all 5000 held
        out = s.run("select public.api_adjust_balance(%s, -1, 'take one cent of what is held')", [c.org])
        assert not out.ok and out.sqlstate == "22023", out
        _rid2, out2 = refund(s, ext2)
        assert (out2["taken_cents"], out2["on_hold_cents"]) == (0, 2000)
        assert account(s, c.org) == (5000, 5000)
        rid1, out1 = refund(s, ext1)
        assert out1["on_hold_cents"] == 3000
        end_job(s, job, "failed")
        assert balanced(s, c.org) == 0
        assert sum(-r[0] for r in _collections(s, c.org)) == 5000


def test_a_ledger_release_row_that_is_no_real_release_of_its_hold_collects_nothing(conn):
    """Only the 0031 functions write api_ledger. If anything ever wrote a 'release' row for a hold that is still open (or for another
    amount), the collector must not treat it as cents given back."""
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        _job, ref, _ = run(s, c, 2500)
        rid, _ = refund(s, ext)
        topup(s, c, 4000)
        s.rows("insert into public.api_ledger (org_id, kind, amount_cents, balance_after, reserved_after, hold_ref, note) "
               "values (%s, 'release', 5000, 9000, 5000, %s, 'not a real release') returning 1", [c.org, ref])
        assert hold_status(s, ref) == "open"
        assert _recovery(s, rid)[1] == 0
        assert account(s, c.org) == (9000, 5000)


# ── replay ──────────────────────────────────────────────────────────────────

def test_replays_of_the_refund_the_release_the_expiry_and_the_migration_collect_once(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        job, ref, _ = run(s, c, 2500)
        rid, out = refund(s, ext)
        _again, dup = refund(s, ext, rid=rid)
        assert dup["duplicate"] is True and dup["on_hold_cents"] == out["on_hold_cents"] == 5000
        assert s.value("select count(*) from public.api_refund_recoveries where refund_id = %s", [rid]) == 1

        # The migration again, with a recovery row open: it finds its own bodies and changes nothing.
        s.conn.execute(MIGRATION.read_text(encoding="utf-8").replace("set local lock_timeout = '5s';", ""))
        assert _recovery(s, rid) == (5000, 0, [ref])

        end_job(s, job, "failed")
        end_job(s, job, "failed")                             # the same status again: 0031's trigger does nothing
        assert s.value("select public.api_settle_locked(%s, false, 'again')", [ref]) == 0
        s.rows("select public.api_account_lock(%s) is not null", [c.org])
        s.rows("select public.api_expire_holds_locked(%s)", [c.org])
        assert _recovery(s, rid)[1] == 5000
        assert len(_collections(s, c.org)) == 1
        assert balanced(s, c.org) == 0
        _again, dup2 = refund(s, ext, rid=rid)
        assert dup2["duplicate"] is True and dup2["on_hold_cents"] == 5000


# ── the record, and who wrote the collection ────────────────────────────────

def test_the_recovery_record_is_written_by_the_functions_only(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext = topup(s, c, 5000)
        job, _ref, _ = run(s, c, 2500)
        rid, _ = refund(s, ext)
        for q in ("update public.api_refund_recoveries set owed = 1 where refund_id = %s",
                  "update public.api_refund_recoveries set holds = '{x}' where refund_id = %s",
                  "update public.api_refund_recoveries set org_id = gen_random_uuid() where refund_id = %s",
                  "delete from public.api_refund_recoveries where refund_id = %s"):
            out = s.run(q, [rid])
            assert not out.ok and out.sqlstate == "42501", (q, out)
        end_job(s, job, "failed")
        out = s.run("update public.api_refund_recoveries set collected = 0 where refund_id = %s", [rid])
        assert not out.ok and out.sqlstate == "42501", "collected never goes back down"
        assert not s.run("truncate public.api_refund_recoveries").ok
        ledger_id = s.value("select refund_ledger_id from public.api_refund_recoveries where refund_id = %s", [rid])
        for actor in (SERVICE, c.actor, ANON):
            out = call(s, actor, "insert into public.api_refund_recoveries (refund_id, refund_ledger_id, topup_external_id, org_id, "
                                 "reason, holds, owed) values (%s, %s, %s, %s, 'refund', '{x}', 1)", [rid + "x", ledger_id, ext, c.org])
            assert not out.ok and out.sqlstate == "42501", (actor.name, out)
        assert not call(s, c.actor, "select * from public.api_refund_recoveries").ok
        assert not call(s, ANON, "select * from public.api_refund_recoveries").ok
        assert call(s, SERVICE, "select count(*) from public.api_refund_recoveries where refund_id = %s", [rid]).rows == [(1,)]


def test_a_collection_made_inside_the_customers_own_api_call_is_the_platforms_row_not_the_customers(conn):
    """The lazy expiry at the top of api_create_video runs after api_act_as made auth.uid() the key's creator, so the release row it
    writes carries the customer (0031, unchanged). The collection it pays is the refund's, the platform's: created_by stays NULL."""
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        ext1 = topup(s, c, 5000)
        topup(s, c, 5000)                                     # keeps the tier, so the next run reaches the lazy expiry
        _job1, ref1, _ = run(s, c, 2500)
        _job2, _ref2, _ = run(s, c, 2500)
        rid, out = refund(s, ext1)
        assert (out["taken_cents"], out["on_hold_cents"]) == (0, 5000)
        s.rows("update public.api_holds set created_at = now() - interval '24 hours 1 minute' where ref = %s returning 1", [ref1])

        body = ok(call(s, ANON, "select public.api_create_video(%s, %s, '{\"duration\": 30}'::jsonb, null, null, null)",
                       [c.key_hash, c.channel]))
        assert body["status"] == 402 and body["error"]["code"] == "insufficient_balance", body
        assert hold_status(s, ref1) == "released"
        released_by = s.value("select created_by from public.api_ledger where hold_ref = %s and kind = 'release'", [ref1])
        assert str(released_by) == c.actor.uid, "precondition: the release ran as the customer"
        [(amount, hold, _src, _req, by, note)] = _collections(s, c.org)
        assert (amount, hold, by) == (-5000, ref1, None), "the collection must not read as the customer's own act"
        assert rid in note
        assert _recovery(s, rid)[1] == 5000
        assert balanced(s, c.org) == 5000

        # Nor can the customer write such a row, or call the collector or the refund, themselves.
        for q, p in (("insert into public.api_ledger (org_id, kind, amount_cents, balance_after, reserved_after) "
                      "values (%s, 'refund', -1, 0, 0)", [c.org]),
                     ("select public.api_refund_topup(%s, 'adj_self', null, 'x', 'refund')", [ext1]),
                     ("select public.api_refund_recover()", None)):
            out = call(s, c.actor, q, p)
            assert not out.ok and out.sqlstate == "42501", (q, out)


# ── concurrency with api_create_video (real commits, their own database) ────

@pytest.fixture(scope="module")
def committing():
    dsn = sec_db.admin_dsn()
    if not dsn:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_apirefund_{uuid.uuid4().hex[:8]}"
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
            cust = customer(s)
            ext = topup(s, cust, 5000)
    return cust, ext


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

    def go():
        try:
            box["ok"] = fn()
        except psycopg.Error as e:
            box["err"] = (e.sqlstate, str(e).splitlines()[0])
    t = threading.Thread(target=go)
    t.start()
    return t, box


CREATE = "select public.api_create_video(%s, %s, '{\"duration\": 2500}'::jsonb, null, null, null)"
REFUND = "select public.api_refund_topup(%s, %s, null, 'lab', 'refund')"


def test_a_refund_waiting_behind_an_api_hold_being_placed_records_that_hold(committing):
    """The race the attack needs: the customer's API run and the webhook's refund at the same instant. The refund waits on the
    account lock, then sees the committed hold and records it; the run's failure then collects."""
    cust, ext = _seed(committing)
    rid = f"adj_race{uuid.uuid4().hex[:12]}"
    with psycopg.connect(committing, autocommit=True) as a, psycopg.connect(committing, autocommit=True) as b, \
            psycopg.connect(committing, autocommit=True) as admin:
        _begin(a, ANON)
        made = a.execute(CREATE, [cust.key_hash, cust.channel]).fetchone()[0]
        assert made["status"] == 201, made
        _begin(b, SERVICE)
        t, box = _in_thread(lambda: b.execute(REFUND, [ext, rid]).fetchone()[0])
        assert _waiting(admin, b.info.backend_pid), "the refund must queue behind the hold's account lock"
        a.execute("commit")
        t.join(20)
        b.execute("commit")
        assert "ok" in box, box
        assert (box["ok"]["taken_cents"], box["ok"]["on_hold_cents"]) == (0, 5000), box
        with as_superuser(admin, commit=True) as s:
            ref = s.value("select api_hold_ref from public.render_jobs where id = %s", [made["data"]["job_id"]])
            assert _recovery(s, rid) == (5000, 0, [ref])
            end_job(s, made["data"]["job_id"], "failed")
            assert _recovery(s, rid)[1] == 5000
            assert balanced(s, cust.org) == 0


def test_an_api_hold_waiting_behind_a_refund_sees_what_the_refund_took(committing):
    """The other order: the refund holds the lock, the customer's run of what it saw as available waits, then is refused
    insufficient_balance (the cents are gone), and nothing is owed because the refund took everything."""
    cust, ext = _seed(committing)
    rid = f"adj_race{uuid.uuid4().hex[:12]}"
    with psycopg.connect(committing, autocommit=True) as a, psycopg.connect(committing, autocommit=True) as b, \
            psycopg.connect(committing, autocommit=True) as admin:
        _begin(b, SERVICE)
        out = b.execute(REFUND, [ext, rid]).fetchone()[0]
        assert (out["taken_cents"], out["on_hold_cents"]) == (5000, 0)
        _begin(a, ANON)
        t, box = _in_thread(lambda: a.execute(CREATE, [cust.key_hash, cust.channel]).fetchone()[0])
        assert _waiting(admin, a.info.backend_pid), "the hold must queue behind the refund's account lock"
        b.execute("commit")
        t.join(20)
        a.execute("commit")
        assert "ok" in box, box
        assert box["ok"]["status"] == 402 and box["ok"]["error"]["code"] == "insufficient_balance", box
        with as_superuser(admin, commit=True) as s:
            assert _recovery(s, rid) is None
            assert s.value("select count(*) from public.api_holds where org_id = %s", [cust.org]) == 0
            assert balanced(s, cust.org) == 0
