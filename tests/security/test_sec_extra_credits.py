"""Migration 0094: the extra-credits switch (Usage page) on the money path.

The switch decides which credit lots a NEW hold may draw on. ON (the default,
and what every workspace had before) is today's behaviour to the cent; OFF
leaves one-time pack lots untouched and refuses a run the rest cannot pay,
before anything is held. This file attacks and pins:

* ON is identical to before the migration: a differential run of one scripted
  sequence against a database built WITHOUT 0094 and the lab (with it), same
  lot-by-lot result and same refusal text, plus explicit draw-order pins;
* OFF: packs are never touched, welcome/grant/adjustment credits still pay,
  the refusal is NS402 with the figures, and nothing is held, charged or
  logged; exact boundary; an empty balance reads as an ordinary shortfall;
* concurrency: 10 simultaneous reservations (OFF: exactly the affordable ones
  succeed and no pack is touched; ON: all succeed, plan first), and the switch
  flipped while reservations are running (no deadlock, lots stay in step);
* a flip waits for a reservation in flight and the next reservation sees it;
  a hold already placed is settled and released against its own lots after the
  flip (a running job is never killed);
* only the person who runs the workspace flips it: another tenant, a stranger,
  the platform operator, an invitation that is not bound, anon, and the
  service key are all refused, and nothing changes; no API role writes the
  column directly;
* usage_summary is the caller's own workspace and nothing else;
* the operator's own (exempt) workspace is unchanged by either position;
* the replay of 0094 (twice) changes nothing;
* the MCP OAuth path: its definer function reserves through reserve_credits
  and turns NS402 into its 402, inside a sub-block that rolls the hold back;
  composed here (the same block shape) and, when 0093 is present, run for real.

Every test uses a workspace of its own (fresh lots, so the numbers are exact);
the lab's tenants are only the victims or the bystanders.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user
from sec_scenario import DEFAULT_ORG

PLAN = "usagelab"
PLAN_MONTHLY = 1000


# ── the world ───────────────────────────────────────────────────────────────

@pytest.fixture(scope="module", autouse=True)
def lab_plan(conn):
    """A plan of its own (hidden from the price list) that allows many parallel
    runs, so the concurrency tests are limited by credits, not by the plan."""
    with as_superuser(conn) as s:
        s.rows("insert into public.plans (id, name, monthly_credits, sort_order, is_public) "
               "values (%s, 'Usage lab', %s, 99, false) on conflict (id) do update set monthly_credits = excluded.monthly_credits returning 1",
               [PLAN, PLAN_MONTHLY])
        s.rows("insert into public.plan_entitlements (plan_id, key, value) values (%s, 'concurrency', '60') "
               "on conflict (plan_id, key) do update set value = excluded.value returning 1", [PLAN])
        s.rows("insert into public.plan_entitlements (plan_id, key, value) values (%s, 'queue_priority', '1') "
               "on conflict (plan_id, key) do update set value = excluded.value returning 1", [PLAN])


class Ws:
    """One fresh workspace: its person, its id, and lots seeded the way
    production creates them (the webhook's functions, as the trusted caller)."""

    def __init__(self, conn, *, plan=0, packs=(), grants=(), adjustments=(), subscribed=True):
        self.conn = conn
        self.org = str(uuid.uuid4())
        self.person = user("owner", f"ws-{uuid.uuid4().hex[:10]}@lab.test")
        self.dsn = psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)
        with as_superuser(conn) as s:
            s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                   [self.person.uid, self.person.email])
            s.rows("insert into public.organizations (id, name, slug) values (%s, 'Lab', %s) returning 1",
                   [self.org, f"lab-{self.org[:8]}"])
            s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
                   [self.org, self.person.uid, self.person.email])
            if plan and subscribed:
                tag = uuid.uuid4().hex[:20]
                s.value("select public.upsert_subscription(%s, %s, %s, %s, null, 'active', now() - interval '10 days', "
                        "now() + interval '20 days', false, null, now())",
                        [self.org, f"sub_{tag}", f"ctm_{tag}", PLAN])
                s.value("select public.grant_subscription_credits(%s, %s, %s, now() - interval '10 days', "
                        "now() + interval '20 days', %s, null, null, null, %s::numeric)",
                        [self.org, f"sub_{tag}", PLAN, f"txn_{tag}", repr(plan / PLAN_MONTHLY)])
            for days, amount in packs:
                ext = f"pack-{uuid.uuid4().hex}"
                s.value("select public.add_purchased_credits(%s, %s::numeric, %s, 'lab pack')", [self.org, amount, ext])
                s.rows("update public.credit_lots set expires_at = now() + make_interval(days => %s) "
                       "where external_id = %s returning 1", [days, ext])
            for amount in grants:
                s.value("select public.grant_credits(%s, %s::numeric, 'lab grant')", [self.org, amount])

    # the ground truth, read as the database owner
    def lots(self):
        with as_superuser(self.conn, commit=False) as s:
            rows = s.rows("select source, remaining::float, held::float from public.credit_lots "
                          "where org_id = %s order by id", [self.org])
        return [tuple(r) for r in rows]

    def acct(self):
        with as_superuser(self.conn, commit=False) as s:
            r = s.rows("select balance::float, reserved::float, use_extra_credits from public.credit_accounts "
                       "where org_id = %s", [self.org])
        return tuple(r[0]) if r else None

    def count(self, table):
        with as_superuser(self.conn, commit=False) as s:
            return s.value(f"select count(*) from public.{table} where org_id = %s", [self.org])

    def switch(self, on, who=None):
        return switch_raw(self.dsn, who or self.person, self.org, on)

    def reserve(self, amount, ref=None):
        return reserve_raw(self.dsn, self.person, self.org, ref or f"rj-{uuid.uuid4().hex}", amount)

    def summary(self, who=None):
        with acting(self.conn, who or self.person) as s:
            return s.value("select public.usage_summary(%s)", [self.org])

    def settle(self, ref, actual):
        with acting(self.conn, SERVICE, commit=True) as s:
            return s.value("select public.capture_credits(%s, %s::numeric)", [ref, actual])

    def release(self, ref):
        with acting(self.conn, SERVICE, commit=True) as s:
            return s.value("select public.release_credits(%s)", [ref])


def reserve_raw(dsn, who, org, ref, amount, *, hold_open=None):
    """reserve_credits as `who` on a connection of its own. Returns
    (ok, sqlstate, detail, message). `hold_open` (an Event pair) keeps the
    transaction open after the call, to test the lock."""
    with psycopg.connect(dsn, autocommit=False) as c:
        try:
            c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            c.execute("select set_config('request.jwt.claim.role', 'authenticated', true)")
            c.execute("set local role authenticated")
            c.execute("select public.reserve_credits(%s, %s, %s::numeric)", [org, ref, amount])
            if hold_open:
                started, go = hold_open
                started.set()
                go.wait(30)
            c.commit()
            return (True, None, None, None)
        except psycopg.Error as e:
            c.rollback()
            return (False, e.sqlstate, e.diag.message_detail, e.diag.message_primary)


class Flip:
    def __init__(self, ok, sqlstate=None, value=None):
        self.ok, self.sqlstate, self.value = ok, sqlstate, value

    def __repr__(self):
        return f"<flip ok={self.ok} {self.sqlstate} {self.value}>"


def switch_raw(dsn, who, org, on, *, role="authenticated"):
    """set_use_extra_credits as `who`, on a connection of its own (so it can wait
    on a lock while the test thread does something else)."""
    with psycopg.connect(dsn, autocommit=False) as c:
        try:
            c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            c.execute("select set_config('request.jwt.claim.role', %s, true)", [role])
            c.execute(f"set local role {role}")
            value = c.execute("select public.set_use_extra_credits(%s, %s)", [org, on]).fetchone()[0]
            c.commit()
            return Flip(True, None, value)
        except psycopg.Error as e:
            c.rollback()
            return Flip(False, e.sqlstate)


def figures(detail):
    """'available=50.00 needed=51.00 extra_off=1 extra=400.00' -> {'available': 50.0, ...}"""
    return {k: float(v) for k, v in (kv.split("=") for kv in (detail or "").split())}


def held_by_source(ws, ref):
    with as_superuser(ws.conn, commit=False) as s:
        return {r[0]: r[1] for r in s.rows(
            "select l.source, sum(h.amount)::float from public.credit_hold_lots h join public.credit_lots l on l.id = h.lot_id "
            "where h.job_id = %s group by l.source", [ref])}


def in_step(ws):
    """The lot invariant the database checks at commit, asserted again here."""
    with as_superuser(ws.conn, commit=False) as s:
        r = s.rows("select a.balance = coalesce(sum(l.remaining), 0), a.reserved = coalesce(sum(l.held), 0) "
                   "from public.credit_accounts a left join public.credit_lots l on l.org_id = a.org_id "
                   "where a.org_id = %s group by a.balance, a.reserved", [ws.org])
    return tuple(r[0]) == (True, True)


# ── ON is today's behaviour ─────────────────────────────────────────────────

SCRIPT = [
    ("reserve", "rj-a", 450), ("reserve", "rj-b", 150), ("capture", "rj-a", 400), ("reserve", "rj-c", 150),
    ("release", "rj-b", None), ("reserve", "rj-d", 900), ("reserve", "rj-e", 5000), ("expire_pack", None, None),
    ("reserve", "rj-f", 100), ("capture", "rj-c", 150), ("capture", "rj-f", 90),
]


def run_script(dsn, tag):
    """One scripted life of a workspace, as the browser and the worker live it.
    Returns what could differ between the old and the new code: the lots after
    every step, and every refusal's text. Works on a database with or without 0094."""
    org = str(uuid.UUID(int=0x94000000 + int(tag)))
    owner = user("o", f"script{tag}@lab.test", str(uuid.UUID(int=0x95000000 + int(tag))))
    out = []
    with psycopg.connect(dsn, autocommit=True) as su:
        su.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [owner.uid, owner.email])
        su.execute("insert into public.organizations (id, name, slug) values (%s, 'Script', %s)", [org, f"script-{tag}"])
        su.execute("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner')",
                   [org, owner.uid, owner.email])
        su.execute("insert into public.plans (id, name, monthly_credits, sort_order, is_public) values (%s, 'Usage lab', %s, 99, false) "
                   "on conflict (id) do nothing", [PLAN, PLAN_MONTHLY])
        su.execute("insert into public.plan_entitlements (plan_id, key, value) values (%s, 'concurrency', '60') on conflict do nothing", [PLAN])
        su.execute("select public.upsert_subscription(%s, 'sub_scriptaaaaaaaaaa" + tag + "', 'ctm_scriptaaaaaaaaaa" + tag + "', %s, null, 'active', "
                   "now() - interval '5 days', now() + interval '25 days', false, null, now())", [org, PLAN])
        su.execute("select public.grant_subscription_credits(%s, 'sub_scriptaaaaaaaaaa" + tag + "', %s, now() - interval '5 days', "
                   "now() + interval '25 days', 'txn_scriptaaaaaaaaaa" + tag + "', null, null, null, 0.3)", [org, PLAN])
        for i, (days, amount) in enumerate(((10, 200), (20, 200))):
            su.execute("select public.add_purchased_credits(%s, %s::numeric, %s, 'p')", [org, amount, f"script-pack-{tag}-{i}"])
            su.execute("update public.credit_lots set expires_at = now() + make_interval(days => %s) where external_id = %s",
                       [days, f"script-pack-{tag}-{i}"])
        su.execute("select public.grant_credits(%s, 100, 'g')", [org])

        def snap():
            rows = su.execute("select source, remaining::float, held::float from public.credit_lots where org_id = %s order by id",
                              [org]).fetchall()
            acc = su.execute("select balance::float, reserved::float from public.credit_accounts where org_id = %s", [org]).fetchone()
            return [list(r) for r in rows], list(acc)

        for step, ref, amount in SCRIPT:
            if step == "reserve":
                ok, state, detail, msg = reserve_raw(dsn, owner, org, f"{ref}-{tag}", amount)
                out.append((step, ref, ok, state, detail if not ok and state == "NS402" else None, msg if not ok else None))
            elif step == "capture":
                su.execute("select public.capture_credits(%s, %s::numeric)", [f"{ref}-{tag}", amount])
                out.append((step, ref))
            elif step == "release":
                su.execute("select public.release_credits(%s)", [f"{ref}-{tag}"])
                out.append((step, ref))
            elif step == "expire_pack":
                su.execute("update public.credit_lots set expires_at = now() - interval '1 minute' "
                           "where org_id = %s and source = 'pack' and expires_at < now() + interval '15 days'", [org])
                out.append((step,))
            out.append(snap())
    return out


@pytest.fixture(scope="module")
def baseline_dsn(conn):
    """A database built from every migration EXCEPT 0094 and later: what the
    code did before this change."""
    admin = sec_db.admin_dsn()
    name = f"ns_usage_base_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(dsn, [f for f in sec_db.build_sequence()
                                 if not (re.match(r"^\d{4}_", f.name) and int(f.name[:4]) >= 94)])
        yield dsn
    finally:
        sec_db.drop_database(admin, name)


def test_with_the_switch_on_every_step_matches_the_code_before_0094(conn, baseline_dsn):
    here = psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)
    old, new = run_script(baseline_dsn, "1"), run_script(here, "1")
    assert len(old) == len(new)
    for step, (a, b) in enumerate(zip(old, new)):
        assert a == b, f"step {step}: before {a!r}, after {b!r}"
    # The script really did exercise packs, expiry and a refusal.
    assert any(isinstance(x, tuple) and x[0] == "reserve" and x[2] is False for x in new)
    assert any(isinstance(x, tuple) and x[0] == "expire_pack" for x in new)


def test_on_draws_plan_then_soonest_pack_then_the_rest_in_the_documented_order(conn):
    ws = Ws(conn, plan=300, packs=[(10, 200), (20, 200)], grants=[100])
    assert ws.lots() == [("subscription", 300, 0), ("pack", 200, 0), ("pack", 200, 0), ("grant", 100, 0)]
    assert ws.reserve(450, "rj-order-1")[0]
    assert ws.lots() == [("subscription", 300, 300), ("pack", 200, 150), ("pack", 200, 0), ("grant", 100, 0)]
    assert ws.reserve(150, "rj-order-2")[0]
    assert ws.lots() == [("subscription", 300, 300), ("pack", 200, 200), ("pack", 200, 100), ("grant", 100, 0)]
    assert ws.reserve(150, "rj-order-3")[0]
    assert ws.lots() == [("subscription", 300, 300), ("pack", 200, 200), ("pack", 200, 200), ("grant", 100, 50)]
    assert in_step(ws)
    refused = ws.reserve(51, "rj-order-4")
    assert refused[:2] == (False, "NS402") and "extra_off" not in refused[2], refused
    assert figures(refused[2]) == {"available": 50, "needed": 51}


def test_the_default_is_on_for_every_workspace(conn, sc):
    ws = Ws(conn, plan=100)
    assert ws.summary()["extra_enabled"] is True
    with as_superuser(conn, commit=False) as s:
        assert s.value("select bool_and(use_extra_credits) from public.credit_accounts") in (True, False)
        assert s.value("select count(*) from public.credit_accounts where org_id = %s and not use_extra_credits",
                       [sc.alice.org]) == 0
        # A column added to a table that already has rows: every row is ON.
        assert s.value("select column_default from information_schema.columns where table_schema = 'public' "
                       "and table_name = 'credit_accounts' and column_name = 'use_extra_credits'") == "true"


# ── OFF ─────────────────────────────────────────────────────────────────────

def test_off_leaves_packs_untouched_and_the_plan_then_welcome_credits_pay(conn):
    ws = Ws(conn, plan=300, packs=[(10, 200), (20, 200)], grants=[100])
    assert ws.switch(False).ok
    assert ws.reserve(350, "rj-off-1")[0]
    assert ws.lots() == [("subscription", 300, 300), ("pack", 200, 0), ("pack", 200, 0), ("grant", 100, 50)]
    assert held_by_source(ws, "rj-off-1") == {"subscription": 300.0, "grant": 50.0}
    assert in_step(ws)


def test_off_refuses_before_anything_is_held_when_the_plan_side_is_not_enough(conn):
    ws = Ws(conn, plan=300, packs=[(10, 200), (20, 200)], grants=[100])
    assert ws.switch(False).ok
    assert ws.reserve(350, "rj-off-a")[0]
    snapshot = (ws.lots(), ws.acct(), ws.count("credit_reservations"), ws.count("credit_transactions"))
    ok, state, detail, msg = ws.reserve(51, "rj-off-b")
    assert (ok, state, msg) == (False, "NS402", "insufficient credits")
    # The figures a person needs: what the plan side can pay, what this needs, what waits in packs.
    assert figures(detail) == {"available": 50, "needed": 51, "extra_off": 1, "extra": 400}, detail
    assert (ws.lots(), ws.acct(), ws.count("credit_reservations"), ws.count("credit_transactions")) == snapshot
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.credit_reservations where job_id = 'rj-off-b'") == 0


def test_off_exact_boundary_succeeds_and_one_cent_more_is_refused(conn):
    ws = Ws(conn, plan=300, packs=[(10, 500)])
    assert ws.switch(False).ok
    assert ws.reserve(300.01, "rj-edge-1")[:2] == (False, "NS402")
    assert ws.reserve(300, "rj-edge-2")[0]
    assert ws.lots() == [("subscription", 300, 300), ("pack", 500, 0)]


def test_off_with_no_credits_at_all_is_the_ordinary_shortfall_not_an_extra_credits_message(conn):
    ws = Ws(conn, plan=0, packs=[], grants=[])
    assert ws.switch(False).ok
    ok, state, detail, _ = ws.reserve(60)
    assert (ok, state) == (False, "NS402") and figures(detail) == {"available": 0, "needed": 60}, detail


def test_off_when_even_the_packs_cannot_pay_it_says_so_plainly(conn):
    ws = Ws(conn, plan=100, packs=[(10, 100)])
    assert ws.switch(False).ok
    ok, state, detail, _ = ws.reserve(500)
    assert (ok, state) == (False, "NS402") and figures(detail) == {"available": 200, "needed": 500}, detail


def test_turning_it_back_on_makes_the_packs_spendable_again(conn):
    ws = Ws(conn, plan=100, packs=[(10, 300)])
    assert ws.switch(False).ok
    assert ws.reserve(200, "rj-back-1")[:2] == (False, "NS402")
    assert ws.switch(True).ok
    assert ws.reserve(200, "rj-back-2")[0]
    assert ws.lots() == [("subscription", 100, 100), ("pack", 300, 100)]


def test_off_adjustment_lots_still_pay_and_a_refund_goes_back_to_where_it_came_from(conn):
    ws = Ws(conn, plan=100, packs=[(10, 300)])
    with as_superuser(conn) as s:  # an operator correction: an adjustment lot (never expires)
        s.value("select public.grant_credits(%s, 50, 'lab correction')", [ws.org])
    assert ws.switch(False).ok
    assert ws.reserve(150, "rj-adj-1")[0]
    ws.settle("rj-adj-1", 150)
    assert ws.lots() == [("subscription", 0, 0), ("pack", 300, 0), ("grant", 0, 0)]


def test_a_hold_placed_while_on_is_settled_and_released_after_the_flip(conn):
    ws = Ws(conn, plan=100, packs=[(10, 300)])
    assert ws.reserve(250, "rj-run-1")[0]            # draws the plan lot and 150 of the pack
    assert held_by_source(ws, "rj-run-1") == {"subscription": 100.0, "pack": 150.0}
    assert ws.switch(False).ok
    # A running job is never killed: the capture settles against the lots the hold was
    # placed on (soonest expiry first, as before), whatever the switch says now.
    assert ws.settle("rj-run-1", 180) == 180
    assert ws.lots() == [("subscription", 70, 0), ("pack", 150, 0)]
    assert in_step(ws)
    assert ws.reserve(80, "rj-run-2")[:2] == (False, "NS402")       # a NEW run is refused: 70 plan credits left
    assert ws.switch(True).ok
    assert ws.reserve(100, "rj-run-3")[0]                           # plan 70 + 30 from the pack
    assert held_by_source(ws, "rj-run-3") == {"subscription": 70.0, "pack": 30.0}
    assert ws.switch(False).ok
    assert ws.release("rj-run-3") == 100                            # released after the flip, back to both lots
    assert ws.lots() == [("subscription", 70, 0), ("pack", 150, 0)]
    assert in_step(ws)


# ── concurrency and the lock ────────────────────────────────────────────────

def stampede(ws, n, amount, flipper=None):
    start = threading.Barrier(n + (1 if flipper else 0))

    def one(i):
        start.wait(30)
        return ws.reserve(amount, f"rj-st-{uuid.uuid4().hex[:12]}")

    with ThreadPoolExecutor(n + (1 if flipper else 0)) as pool:
        futures = [pool.submit(one, i) for i in range(n)]
        if flipper:
            futures.append(pool.submit(lambda: (start.wait(30), flipper())[1]))
        return [f.result(60) for f in futures]


def test_ten_simultaneous_reservations_with_the_switch_off_pay_only_from_plan_credits(conn):
    ws = Ws(conn, plan=500, packs=[(10, 1000)])
    assert ws.switch(False).ok
    results = stampede(ws, 10, 100)
    ok = [r for r in results if r[0]]
    refused = [r for r in results if not r[0]]
    assert len(ok) == 5 and len(refused) == 5, results
    assert {(r[1], r[3]) for r in refused} == {("NS402", "insufficient credits")}
    assert all("extra_off=1" in r[2] for r in refused)
    assert ws.lots() == [("subscription", 500, 500), ("pack", 1000, 0)]
    assert ws.acct() == (1500, 500, False) and in_step(ws)


def test_ten_simultaneous_reservations_with_the_switch_on_all_succeed_plan_first(conn):
    ws = Ws(conn, plan=500, packs=[(10, 1000)])
    results = stampede(ws, 10, 100)
    assert all(r[0] for r in results), results
    assert ws.lots() == [("subscription", 500, 500), ("pack", 1000, 500)]
    assert in_step(ws)


def test_the_switch_flipped_while_ten_reservations_run_never_deadlocks_or_breaks_the_lots(conn):
    ws = Ws(conn, plan=500, packs=[(10, 1000)])

    def flip_a_lot():
        outcomes = []
        for i in range(12):
            outcomes.append(ws.switch(i % 2 == 1).ok)
        outcomes.append(ws.switch(False).ok)
        return outcomes

    results = stampede(ws, 10, 100, flipper=flip_a_lot)
    reserves = results[:10]
    assert all(r[0] or r[1] == "NS402" for r in reserves), reserves        # nothing but a clean refusal
    assert all(results[10]), results[10]                                    # every flip landed
    assert in_step(ws)
    # Every hold that exists is fully booked on lots, and none exceeds what was asked.
    with as_superuser(conn, commit=False) as s:
        bad = s.rows("select r.job_id from public.credit_reservations r "
                     "left join public.credit_hold_lots h on h.job_id = r.job_id where r.org_id = %s and r.status = 'open' "
                     "group by r.job_id, r.amount having coalesce(sum(h.amount), 0) <> r.amount", [ws.org])
    assert bad == []
    assert ws.acct()[2] is False


def _blocked(conn, pred):
    deadline = time.time() + 5
    while time.time() < deadline:
        with as_superuser(conn, commit=False) as s:
            if s.value("select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' "
                       "and query ilike %s", [pred]):
                return True
        time.sleep(0.05)
    return False


def test_a_flip_waits_for_a_reservation_in_flight_which_keeps_the_lots_it_drew(conn):
    ws = Ws(conn, plan=100, packs=[(10, 300)])
    started, go = threading.Event(), threading.Event()
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(reserve_raw, ws.dsn, ws.person, ws.org, "rj-wait-1", 250, hold_open=(started, go))
        assert started.wait(10)
        flip = pool.submit(ws.switch, False)
        assert _blocked(conn, "%set_use_extra_credits%"), "the flip did not wait for the reservation in flight"
        assert not flip.done()
        go.set()
        assert first.result(30)[0] and flip.result(30).ok
    assert held_by_source(ws, "rj-wait-1") == {"subscription": 100.0, "pack": 150.0}   # it saw ON
    assert ws.acct()[2] is False and in_step(ws)


def test_a_reservation_waits_for_a_flip_in_flight_and_then_sees_it(conn):
    ws = Ws(conn, plan=100, packs=[(10, 300)])
    with psycopg.connect(ws.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(ws.person.claims())])
        c.execute("select set_config('request.jwt.claim.role', 'authenticated', true)")
        c.execute("set local role authenticated")
        c.execute("select public.set_use_extra_credits(%s, false)", [ws.org])       # not committed yet
        with ThreadPoolExecutor(1) as pool:
            second = pool.submit(ws.reserve, 250, "rj-wait-2")
            assert _blocked(conn, "%reserve_credits%"), "the reservation did not wait for the flip in flight"
            assert not second.done()
            c.commit()
            result = second.result(30)
    assert result[:2] == (False, "NS402") and "extra_off=1" in result[2], result
    assert ws.lots() == [("subscription", 100, 0), ("pack", 300, 0)]


# ── who may flip it ─────────────────────────────────────────────────────────

def test_another_tenant_a_stranger_and_the_operator_cannot_flip_my_workspace(conn, sc):
    ws = Ws(conn, plan=100, packs=[(10, 100)])
    for who in (sc.bob.actor, sc.alice.actor, sc.stranger, sc.operator, sc.dana):
        out = ws.switch(False, who)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
    assert ws.acct() is None or ws.acct()[2] is True
    assert ws.summary()["extra_enabled"] is True


def test_anon_and_the_service_key_cannot_flip_it_either(conn):
    ws = Ws(conn, plan=100)
    for who in (ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run("select public.set_use_extra_credits(%s, false)", [ws.org])
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
    assert ws.summary()["extra_enabled"] is True


def test_an_invitation_that_is_not_bound_to_an_account_cannot_flip_it(conn):
    ws = Ws(conn, plan=100)
    guest = user("guest", f"guest-{uuid.uuid4().hex[:8]}@lab.test")
    with as_superuser(conn) as s:
        s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [guest.uid, guest.email])
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, null, %s, 'admin') returning 1",
               [ws.org, guest.email])
    out = ws.switch(False, guest)
    assert not out.ok and out.sqlstate == "42501", out


def test_the_flip_needs_a_real_answer_and_a_workspace(conn):
    ws = Ws(conn, plan=100)
    with acting(conn, ws.person) as s:
        assert s.run("select public.set_use_extra_credits(%s, null)", [ws.org]).sqlstate == "22023"
        assert s.run("select public.set_use_extra_credits(null, true)").sqlstate == "42501"
        assert s.run("select public.set_use_extra_credits(%s, true)", [str(uuid.uuid4())]).sqlstate == "42501"


def test_the_flip_is_idempotent_and_reports_whether_it_changed_anything(conn):
    ws = Ws(conn, plan=100)
    with acting(conn, ws.person, commit=True) as s:
        assert s.value("select public.set_use_extra_credits(%s, true)", [ws.org]) == {"use_extra_credits": True, "changed": False}
        assert s.value("select public.set_use_extra_credits(%s, false)", [ws.org]) == {"use_extra_credits": False, "changed": True}
        assert s.value("select public.set_use_extra_credits(%s, false)", [ws.org]) == {"use_extra_credits": False, "changed": False}


def test_a_workspace_with_no_account_row_yet_can_still_set_it(conn):
    ws = Ws(conn)  # no credits at all: no credit_accounts row
    assert ws.acct() is None
    assert ws.switch(False).ok
    assert ws.acct() == (0, 0, False)


@pytest.mark.parametrize("statement", [
    "update public.credit_accounts set use_extra_credits = false where org_id = %(org)s",
    "update public.credit_accounts set use_extra_credits = true",
    "insert into public.credit_accounts (org_id, use_extra_credits) values (%(org)s, false)",
    "delete from public.credit_accounts where org_id = %(org)s",
])
def test_no_api_role_writes_the_column_directly(conn, statement):
    ws = Ws(conn, plan=100)
    for who in (ws.person, ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run(statement, {"org": ws.org})
        assert (not out.ok) or out.rowcount == 0, (who.name, out)
    assert ws.summary()["extra_enabled"] is True


def test_the_internal_helper_is_not_callable_by_any_api_role(conn):
    ws = Ws(conn, plan=100)
    for who in (ws.person, ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run("select public.credit_spendable_internal(%s)", [ws.org])
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


# ── what the Usage page reads ───────────────────────────────────────────────

SUMMARY_KEYS = {"exempt", "extra_enabled", "plan", "subscription", "plan_credits", "last_plan_period_end",
                "extra_credits", "bonus_credits", "spendable_now", "run_slots", "entitlements"}


def test_usage_summary_reports_the_plan_period_extra_and_bonus_credits(conn):
    ws = Ws(conn, plan=400, packs=[(10, 200), (20, 300)], grants=[100])
    assert ws.reserve(150, "rj-sum-1")[0] and ws.settle("rj-sum-1", 100) == 100
    assert ws.reserve(60, "rj-sum-2")[0]
    s = ws.summary()
    assert set(s) == SUMMARY_KEYS
    pc = s["plan_credits"]
    assert (pc["granted"], pc["spent"], pc["held"], pc["left"]) == (400, 100, 60, 240)
    assert pc["period_end"] and pc["period_start"]
    assert s["extra_credits"]["available"] == 500 and s["extra_credits"]["soonest_expiry"]
    assert s["bonus_credits"]["available"] == 100 and s["bonus_credits"]["soonest_expiry"] is None
    assert s["spendable_now"] == 840 and s["extra_enabled"] is True
    assert s["plan"]["id"] == PLAN and s["subscription"]["status"] == "active"
    assert s["run_slots"]["limit"] == 60 and s["run_slots"]["active"] == 1
    assert s["entitlements"]["concurrency"] == 60 and "models_image" not in s["entitlements"]  # enforced keys only
    assert ws.switch(False).ok
    off = ws.summary()
    assert off["extra_enabled"] is False and off["spendable_now"] == 340 and off["extra_credits"]["available"] == 500


def test_usage_summary_never_counts_an_expired_period_as_spent(conn):
    ws = Ws(conn, plan=400)
    assert ws.reserve(100, "rj-exp-1")[0] and ws.settle("rj-exp-1", 100) == 100
    with as_superuser(conn) as s:
        s.rows("update public.credit_lots set expires_at = now() - interval '1 hour', period_end = now() - interval '1 hour', "
               "period_start = now() - interval '31 days' where org_id = %s and source = 'subscription' returning 1",
               [ws.org])
    s = ws.summary()
    assert s["plan_credits"] is None and s["last_plan_period_end"] is not None
    assert s["spendable_now"] == 0


def test_usage_summary_is_the_callers_own_workspace_and_nothing_else(conn, sc):
    ws = Ws(conn, plan=100, packs=[(10, 100)])
    assert ws.summary() is not None
    for who in (sc.bob.actor, sc.stranger, sc.dana):
        with acting(conn, who) as s:
            assert s.value("select public.usage_summary(%s)", [ws.org]) is None, who.name
    with acting(conn, ANON) as s:
        assert s.run("select public.usage_summary(%s)", [ws.org]).sqlstate == "42501"
    # My own call names my own workspace and carries no id, margin, cost, note or other tenant.
    text = json.dumps(ws.summary())
    for needle in (sc.alice.org, sc.bob.org, "margin", "cost", "note", "external", "provider", "ctm_", "sub_"):
        assert needle not in text, needle


def test_usage_summary_for_a_free_workspace_is_honest(conn):
    ws = Ws(conn, plan=0, grants=[100])
    s = ws.summary()
    assert s["plan_credits"] is None and s["subscription"] is None and s["last_plan_period_end"] is None
    assert s["plan"]["is_default"] is True and s["bonus_credits"]["available"] == 100
    assert s["spendable_now"] == 100


# ── the operator's own workspace ────────────────────────────────────────────

def test_the_operators_exempt_workspace_is_untouched_by_either_position(conn, sc):
    for position in (False, True):
        with acting(conn, sc.operator, commit=True) as s:
            assert s.run("select public.set_use_extra_credits(%s, %s)", [DEFAULT_ORG, position]).ok
        with acting(conn, SERVICE, commit=True) as s:
            out = s.value("select public.reserve_credits(%s, %s, 500)", [DEFAULT_ORG, f"rj-op-{uuid.uuid4().hex}"])
        assert out["exempt"] is True and out["reserved"] == 0
    with acting(conn, sc.operator, commit=True) as s:
        s.run("select public.set_use_extra_credits(%s, true)", [DEFAULT_ORG])


# ── replay ──────────────────────────────────────────────────────────────────

def test_replaying_0094_twice_changes_nothing(conn):
    ws = Ws(conn, plan=100, packs=[(10, 300)])
    assert ws.switch(False).ok
    before = (ws.lots(), ws.acct(), ws.summary())
    sql = (sec_db.MIGRATIONS / "0094_extra_credits_toggle.sql").read_text(encoding="utf-8")
    sec_db.apply_files(ws.dsn, [sec_db.MIGRATIONS / "0094_extra_credits_toggle.sql"])
    sec_db.apply_files(ws.dsn, [sec_db.MIGRATIONS / "0094_extra_credits_toggle.sql"])
    assert (ws.lots(), ws.acct(), ws.summary()) == before and ws.acct()[2] is False   # an OFF stays OFF
    assert ws.reserve(150, "rj-replay-1")[:2] == (False, "NS402")
    with as_superuser(conn, commit=False) as s:
        acl = s.rows(
            "select p.proname, has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'), "
            "has_function_privilege('service_role', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace "
            "and p.proname in ('set_use_extra_credits', 'usage_summary', 'credit_spendable_internal', 'reserve_credits', 'credit_lots_hold_locked') "
            "order by 1")
    assert [tuple(r) for r in acl] == [
        ("credit_lots_hold_locked", False, False, False),
        ("credit_spendable_internal", False, False, False),
        ("reserve_credits", False, True, True),
        ("set_use_extra_credits", False, True, False),
        ("usage_summary", False, True, True),
    ]
    assert "extra_off=1" in sql


# ── MCP over OAuth (0093, PR #386) ──────────────────────────────────────────

OAUTH_SHAPE = """
create or replace function pg_temp.oauth_like(p_org uuid, p_price numeric) returns jsonb
  language plpgsql volatile as $$
declare
  acc public.credit_accounts;
  v_hold jsonb;
begin
  -- 0093's oauth_create_video, reduced to its credit step: lock the account, then
  -- reserve inside a sub-block that turns NS402 into a 402 and keeps nothing.
  acc := public.credit_account_lock(p_org);
  begin
    v_hold := public.reserve_credits(p_org, 'rj-oa-' || replace(gen_random_uuid()::text, '-', ''), p_price);
  exception
    when sqlstate 'NS402' then
      select * into acc from public.credit_accounts where org_id = p_org;
      return jsonb_build_object('status', 402, 'code', 'insufficient_credits',
                                'available_credits', greatest(acc.balance - acc.reserved, 0));
  end;
  return jsonb_build_object('status', 201);
end $$;
"""


def test_the_oauth_credit_step_composes_with_the_switch_and_holds_nothing_when_refused(conn):
    ws = Ws(conn, plan=100, packs=[(10, 400)])
    assert ws.switch(False).ok
    with as_superuser(conn) as s:      # the trusted caller, as the connected app's route is
        s.conn.execute(OAUTH_SHAPE)
        refused = s.value("select pg_temp.oauth_like(%s, 150)", [ws.org])
        assert refused["status"] == 402 and refused["code"] == "insufficient_credits"
        ok = s.value("select pg_temp.oauth_like(%s, 100)", [ws.org])
        assert ok["status"] == 201
    # Nothing from the refused call stays; the accepted one took plan credits only.
    assert ws.lots() == [("subscription", 100, 100), ("pack", 400, 0)]
    assert ws.count("credit_reservations") == 1 and in_step(ws)
    # With extra credits ON the same call passes and draws the pack, as before the switch.
    assert ws.switch(True).ok
    with as_superuser(conn) as s:
        s.conn.execute(OAUTH_SHAPE)
        assert s.value("select pg_temp.oauth_like(%s, 150)", [ws.org])["status"] == 201
    assert ws.lots() == [("subscription", 100, 100), ("pack", 400, 150)]


def test_oauth_refusal_numbers_are_available_through_the_internal_helper(conn):
    """0093 reports available_credits as balance - held, which counts packs even
    when they cannot be spent. credit_spendable_internal is the figure a refusal
    should quote (a definer function may call it); pinned so that stays true."""
    ws = Ws(conn, plan=100, packs=[(10, 400)])
    assert ws.switch(False).ok
    with as_superuser(conn, commit=False) as s:
        assert s.value("select public.credit_spendable_internal(%s)", [ws.org]) == 100
        assert s.value("select balance - reserved from public.credit_accounts where org_id = %s", [ws.org]) == 500


@pytest.fixture(scope="module")
def oauth_db():
    """A scratch database of its own with a connected app's grant and token, built
    only when 0093 (MCP OAuth) is in this tree: the price rows and a plan with the
    mcp feature that the real call needs are not for the shared lab."""
    if not (sec_db.MIGRATIONS / "0093_mcp_oauth.sql").exists():
        pytest.skip("0093 (MCP OAuth) is not in this tree; the composition tests above cover its credit step")
    admin = sec_db.admin_dsn()
    name = f"ns_usage_oauth_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.build(admin, name)
    try:
        yield dsn
    finally:
        sec_db.drop_database(admin, name)


def test_the_real_connected_app_video_call_obeys_the_switch(oauth_db):
    import hashlib

    org, uid, token = str(uuid.uuid4()), str(uuid.uuid4()), "oauth-usage-token-" + uuid.uuid4().hex
    tok_hash = hashlib.sha256(token.encode()).hexdigest()
    with psycopg.connect(oauth_db, autocommit=True) as su:
        su.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, 'oa@lab.test', now())", [uid])
        su.execute("insert into public.organizations (id, name, slug) values (%s, 'OA', 'oa-usage')", [org])
        su.execute("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'oa@lab.test', 'owner')", [org, uid])
        su.execute("select public.upsert_subscription(%s, 'sub_oausageaaaaaaaaaa', 'ctm_oausageaaaaaaaaaa', 'pro', null, 'active', "
                   "now() - interval '5 days', now() + interval '25 days', false, null, now())", [org])
        su.execute("select public.grant_subscription_credits(%s, 'sub_oausageaaaaaaaaaa', 'pro', now() - interval '5 days', "
                   "now() + interval '25 days', 'txn_oausageaaaaaaaaaa', null, null, null, 0.01::numeric)", [org])   # 60 plan credits
        su.execute("select public.add_purchased_credits(%s, 500, 'oa-usage-pack', 'p')", [org])
        su.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values ('video_minute', 60, 0), ('job_minimum', 10, 0) "
                   "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin")
        su.execute("insert into public.channels (channel_id, name, niche, status, org_id, agent_config, credential_ref) values "
                   "('chan-oa-usage', 'OA', 'tech', 'ACTIVE', %s, '{}', '{\"verified_at\": \"2026-09-01\"}')", [org])
        client = su.execute("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) values "
                            "('Usage lab app', array['https://claude.ai/api/mcp/auth_callback'], %s) returning client_id",
                            [hashlib.sha256(b"ip").hexdigest()]).fetchone()[0]
        grant = su.execute("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits, activated_at) "
                           "values (%s, %s, %s, array['videos:read', 'videos:create'], 'https://nightshift-ai.studio/api/mcp', 20000, now()) returning id",
                           [uid, org, client]).fetchone()[0]
        su.execute("insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values (%s, %s, 'access', now() + interval '1 hour')",
                   [tok_hash, grant])
        su.execute("update public.credit_accounts set use_extra_credits = false where org_id = %s", [org])

    def create(idem):
        with psycopg.connect(oauth_db, autocommit=False) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "anon"})])
            c.execute("set local role anon")
            out = c.execute("select public.oauth_create_video(%s, 'chan-oa-usage', %s::jsonb, %s)",
                            [tok_hash, json.dumps({"duration": 60}), idem]).fetchone()[0]
            c.commit()
            return out

    def state():
        with psycopg.connect(oauth_db, autocommit=True) as su:
            return (su.execute("select source, remaining::float, held::float from public.credit_lots where org_id = %s order by id", [org]).fetchall(),
                    su.execute("select count(*) from public.credit_reservations where org_id = %s", [org]).fetchone()[0])

    # Extra credits OFF: 60 plan credits cannot pay a 60-credit video once... first one fits exactly.
    first = create("oa-1")
    assert first["status"] == 201, first
    assert state() == ([("subscription", 60.0, 60.0), ("pack", 500.0, 0.0)], 1)
    second = create("oa-2")                      # plan credits are all on hold; 500 sit in a pack
    assert second["status"] == 402 and second["error"]["code"] == "insufficient_credits", second
    assert state() == ([("subscription", 60.0, 60.0), ("pack", 500.0, 0.0)], 1)       # nothing held, nothing charged
    # Extra credits ON: the same call takes the pack, exactly as before the switch existed.
    with psycopg.connect(oauth_db, autocommit=True) as su:
        su.execute("update public.credit_accounts set use_extra_credits = true where org_id = %s", [org])
    third = create("oa-3")
    assert third["status"] == 201, third
    assert state() == ([("subscription", 60.0, 60.0), ("pack", 500.0, 60.0)], 2)
