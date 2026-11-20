"""Named attacks and the arithmetic of the owner analytics hub (migration 0182).

The hub's functions are SECURITY DEFINER: they read every workspace's payments and every person's milestones. The whole defence
is that each refuses everyone but the platform OWNER — not an admin, not a member of the operator's workspace, not a customer —
before it reads anything or looks at its arguments, and that anon and the service role cannot execute them at all.

The second half pins what the owner reads, against a world built here: a sale delivered twice is one sale; a plan's first period
is "initial" and its second "renewal"; a pack is named from the checkout it spent; an API top-up is told from a pack; a refund
without an amount is unknown, never zero; a dispute is not a refund; the operator's own workspace is flagged internal; provider
fees are null because nothing stores them. An export is recorded in the caller's own name, and the log table is closed.

Every world is built inside one transaction that is rolled back.
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user
from sec_scenario import DEFAULT_ORG

FROM = datetime(2026, 1, 1, tzinfo=timezone.utc)
TO = datetime(2027, 1, 1, tzinfo=timezone.utc)

MONEY = "select * from public.owner_analytics_money(%s, %s)"
PEOPLE = "select * from public.owner_analytics_people()"
ACTIVITY = "select * from public.owner_analytics_activity(%s, %s)"
JOBS = "select * from public.owner_analytics_jobs(%s, %s)"
RECORD = "select public.owner_analytics_record_export(%s, %s, %s, %s, %s)"
LOG = "select * from public.owner_analytics_export_log(%s)"
IS_OWNER = "select public.owner_analytics_is_owner()"
MONEY_COLUMNS = [
    "event", "at", "provider", "payment_ref", "org_ref", "kind", "item", "charge", "currency", "amount_minor", "fee_minor",
    "period_start", "period_end", "subscription_ref", "internal",
]
PEOPLE_COLUMNS = [
    "user_ref", "signed_up_at", "confirmed", "last_sign_in_at", "locale", "acquisition", "internal", "first_project_at",
    "first_generation_at", "first_export_at", "first_payment_at", "first_plan",
]
CALLS = [
    (MONEY, [FROM, TO]),
    (PEOPLE, None),
    (ACTIVITY, [FROM, FROM + timedelta(days=30)]),
    (JOBS, [FROM, TO]),
    (RECORD, ["revenue", "csv", FROM, TO, False]),
    (LOG, [10]),
]
CALLS += [
    ("select public.owner_analytics_set_internal(%s, true, 'x')", [DEFAULT_ORG]),
    ("select * from public.owner_analytics_internal_list()", None),
]
CALL_IDS = ["money", "people", "activity", "jobs", "record", "log", "set_internal", "internal_list"]


def _ts(month: int, day: int = 10) -> datetime:
    return datetime(2026, month, day, 12, tzinfo=timezone.utc)


def _workspace(su, key: str):
    uid = str(uuid.uuid4())
    su.rows("insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, created_at) "
            "values (%s, %s, now(), now() - interval '1 hour', %s) returning 1", [uid, f"{key}-oalab@example.test", _ts(9, 1)])
    org = str(su.value("insert into public.organizations (name, slug) values (%s, %s) returning id",
                       [f"OA {key}", f"oalab-{key}-{uid[:8]}"]))
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
            [org, uid, f"{key}-oalab@example.test"])
    return org, uid


def _event(su, provider, event_type, txn, org, minor, *, at, status="processed", event=None, currency="USD", adjustment=None):
    su.rows("insert into public.payment_events (provider, event_id, event_type, occurred_at, status, org_id, transaction_id, "
            "adjustment_id, credits, currency, amount_minor) values (%s, %s, %s, %s, %s, %s, %s, %s, 100, %s, %s) returning 1",
            [provider, event or f"evt-{event_type}-{txn}-{status}", event_type, at, status, org, txn, adjustment, currency, minor])


@contextmanager
def world(conn):
    """C1 bought a pack (its webhook delivered twice, then part-refunded with an amount, then refunded once more without one),
    and holds a plan billed for October (initial) and November (renewal). C2 topped up its API balance through Paddle and lost a
    dispute on a payment nothing else describes. The operator's own workspace bought something too. An admin who is not the owner
    exists, to be refused."""
    with as_superuser(conn, commit=False) as su:
        c1, u1 = _workspace(su, "c1")
        c2, u2 = _workspace(su, "c2")
        admin = user("oa-admin", "oa-admin@example.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [admin.uid, admin.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [admin.uid, admin.email])

        # C1's pack, through the checkout nonce it spent.
        su.rows("insert into public.dodo_checkout_nonces (nonce, org_id, user_id, item, expires_at, consumed_at, consumed_by) "
                "values (%s, %s, %s, 'pack:starter', now() + interval '1 day', now(), 'pay_oalabpack1') returning 1",
                [uuid.uuid4().hex, c1, u1])
        _event(su, "dodo", "payment.succeeded", "pay_oalabpack1", c1, 1500, at=_ts(10, 2))
        _event(su, "dodo", "payment.succeeded", "pay_oalabpack1", c1, 1500, at=_ts(10, 2), status="duplicate", event="evt-retry")
        _event(su, "dodo", "refund.succeeded", "pay_oalabpack1", c1, 500, at=_ts(10, 5), event="evt-refund-1")
        _event(su, "dodo", "refund.succeeded", "pay_oalabpack1", c1, None, at=_ts(10, 6), event="evt-refund-2")

        # C1's plan: two billed periods of one subscription.
        sub = su.value("insert into public.subscriptions (org_id, provider, provider_subscription_id, plan_id, status) "
                       "values (%s, 'dodo', 'sub_oalab1', 'pro', 'active') returning id", [c1])
        su.conn.execute("set local session_replication_role = replica")
        for txn, start in (("pay_oalabplan1", _ts(10, 1)), ("pay_oalabplan2", _ts(11, 1))):
            su.rows("insert into public.credit_lots (org_id, source, amount, remaining, external_id, subscription_id, plan_id, "
                    "period_start, period_end) values (%s, 'subscription', 10, 10, %s, %s, 'pro', %s, %s) returning 1",
                    [c1, txn, sub, start, start + timedelta(days=30)])
        su.rows("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, external_id, note) "
                "values (%s, 'subscription', 10, 10, 0, 'pay_oalabplan1', 'Dodo pay_oalabplan1: pro plan (new)') returning 1", [c1])
        su.rows("insert into public.api_ledger (org_id, kind, amount_cents, balance_after, reserved_after, external_id) "
                "values (%s, 'topup', 2000, 2000, 0, 'txn_oalabapi') returning 1", [c2])
        su.conn.execute("set local session_replication_role = origin")
        _event(su, "dodo", "payment.succeeded", "pay_oalabplan1", c1, 2900, at=_ts(10, 1))
        _event(su, "dodo", "payment.succeeded", "pay_oalabplan2", c1, 2900, at=_ts(11, 1))

        # C2: an API top-up through Paddle, and a sale nothing else describes, then lost in a dispute (no amount reported).
        _event(su, "paddle", "transaction.completed", "txn_oalabapi", c2, 2000, at=_ts(10, 3))
        _event(su, "dodo", "payment.succeeded", "pay_oalabmystery", c2, 990, at=_ts(10, 4), currency="EUR")
        _event(su, "dodo", "dispute.lost", "pay_oalabmystery", c2, None, at=_ts(10, 20))

        # The operator's own workspace.
        _event(su, "dodo", "payment.succeeded", "pay_oalabinternal", DEFAULT_ORG, 100, at=_ts(10, 7))

        # Activity and jobs for C1's person: one completed generation that took 90 s, one failed.
        su.rows("insert into public.creative_jobs (org_id, capability, requested_model, params, status, quoted_credits, "
                "charged_credits, requested_by, created_at, finished_at) values "
                "(%s, 't2i', 'm-oalab', '{}', 'completed', 4, 4, %s, %s, %s), "
                "(%s, 't2i', 'm-oalab', '{}', 'failed', 4, null, %s, %s, %s) returning 1",
                [c1, u1, _ts(10, 8), _ts(10, 8) + timedelta(seconds=90), c1, u1, _ts(10, 9), _ts(10, 9) + timedelta(seconds=5)])
        yield {"c1": c1, "c2": c2, "u1": u1, "u2": u2, "admin": admin}


def _call(conn, who, query, params=None):
    with acting(conn, who) as s:
        return s.run(query, params)


# ── attacks: who may call them ──────────────────────────────────────────────

@pytest.mark.parametrize("call", CALLS, ids=CALL_IDS)
@pytest.mark.parametrize("who", ["alice", "bob", "stranger", "dana", "invitee", "admin"])
def test_everyone_but_the_owner_is_refused_inside_the_function(conn, sc, who, call):
    # A platform ADMIN is refused too: revenue and the people behind it are the owner's to show (0182 header).
    with world(conn) as w:
        actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "stranger": sc.stranger, "dana": sc.dana,
                 "invitee": sc.invitee, "admin": w["admin"]}[who]
        out = _call(conn, actor, *call)
        owner = _call(conn, actor, IS_OWNER)
    assert not out.ok and out.sqlstate == "42501", out
    assert owner.ok and owner.rows == [(False,)], owner


@pytest.mark.parametrize("call", CALLS + [(IS_OWNER, None)], ids=CALL_IDS + ["is_owner"])
def test_anon_and_the_service_role_cannot_execute_them(conn, sc, call):
    for who in (ANON, SERVICE):
        out = _call(conn, who, *call)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_nobody_calls_the_internal_sales_reader_directly(conn, sc):
    for who in (sc.operator, sc.alice.actor, ANON, SERVICE):
        for fn in ("owner_analytics_sales_all", "owner_analytics_internal_org_ids"):
            out = _call(conn, who, f"select * from public.{fn}()")
            assert not out.ok and out.sqlstate == "42501", (who.name, fn, out)


def test_a_customer_is_refused_before_the_arguments_are_looked_at(conn, sc):
    # A bad window answering 22023 to a customer would be an oracle on the function's shape.
    for query, params in ((MONEY, [TO, FROM]), (ACTIVITY, [FROM, TO + timedelta(days=900)]), (RECORD, ["BAD!", "exe", FROM, TO, None])):
        out = _call(conn, sc.alice.actor, query, params)
        assert not out.ok and out.sqlstate == "42501", out


def test_the_export_log_is_closed_and_records_the_callers_own_name(conn, sc):
    with world(conn):
        for who in (sc.alice.actor, sc.operator, SERVICE):
            with acting(conn, who) as s:
                ins = s.run("insert into public.owner_analytics_exports (actor_user_id, what, format, period_from, period_to, "
                            "present_mode) values (%s, 'x', 'csv', now() - interval '1 day', now(), false)", [sc.operator.uid])
                sel = s.run("select * from public.owner_analytics_exports")
            assert not ins.ok and ins.sqlstate == "42501", (who.name, ins)
            assert not sel.ok and sel.sqlstate == "42501", (who.name, sel)
        with acting(conn, sc.operator) as s:
            rec = s.run(RECORD, ["revenue.sales", "xlsx", FROM, TO, True])
            bad = s.run(RECORD, ["../etc", "exe", FROM, TO, True])
            log = s.run(LOG, [5])
        assert rec.ok, rec
        assert not bad.ok and bad.sqlstate == "22023", bad
        assert log.ok and log.rows[0][1:4] == (uuid.UUID(sc.operator.uid), "revenue.sales", "xlsx") and log.rows[0][6] is True


def test_the_functions_are_definers_with_a_fixed_search_path(conn, sc):
    with as_superuser(conn, commit=False) as su:
        rows = su.rows("select p.proname, p.prosecdef, p.proconfig from pg_proc p "
                       "where p.pronamespace = 'public'::regnamespace and p.proname like 'owner\\_analytics\\_%%'")
    names = {r[0] for r in rows}
    # Later owner analytics migrations (0183, 0184) add functions under the same prefix: 0182's own set must all exist, and
    # every function under the prefix, whichever migration made it, is held to the same rule below.
    assert names >= {"owner_analytics_is_owner", "owner_analytics_sales_all", "owner_analytics_internal_org_ids",
                     "owner_analytics_set_internal", "owner_analytics_internal_list", "owner_analytics_money", "owner_analytics_people",
                     "owner_analytics_activity", "owner_analytics_jobs", "owner_analytics_record_export",
                     "owner_analytics_export_log"}, names
    for name, definer, config in rows:
        assert "search_path=public, pg_temp" in (config or []), name
        assert definer == (name not in ("owner_analytics_sales_all", "owner_analytics_internal_org_ids")), name


# ── what the owner reads ────────────────────────────────────────────────────

def _money(conn, sc):
    out = _call(conn, sc.operator, MONEY, [FROM, TO])
    assert out.ok, out
    return [dict(zip(MONEY_COLUMNS, r)) for r in out.rows if (r[3] or "").startswith(("pay_oalab", "txn_oalab"))]


def test_the_owner_reads_each_sale_once_and_classified(conn, sc):
    with world(conn) as w:
        rows = _money(conn, sc)
    sales = {r["payment_ref"]: r for r in rows if r["event"] == "sale"}
    assert set(sales) == {"pay_oalabpack1", "pay_oalabplan1", "pay_oalabplan2", "txn_oalabapi", "pay_oalabmystery",
                          "pay_oalabinternal"}
    pack, p1, p2, api = sales["pay_oalabpack1"], sales["pay_oalabplan1"], sales["pay_oalabplan2"], sales["txn_oalabapi"]
    assert (pack["kind"], pack["item"], pack["charge"], pack["amount_minor"]) == ("pack", "starter", None, 1500)
    # The first period says "(new)" in its webhook note; the second has no note, and its earlier billed period proves a renewal.
    assert (p1["kind"], p1["item"], p1["charge"]) == ("plan", "pro", "initial")
    assert (p2["kind"], p2["item"], p2["charge"]) == ("plan", "pro", "renewal")
    assert p1["subscription_ref"] == p2["subscription_ref"] and p1["period_end"] > p1["period_start"]
    assert (api["kind"], api["provider"]) == ("api_topup", "paddle")
    assert (sales["pay_oalabmystery"]["kind"], sales["pay_oalabmystery"]["currency"]) == ("unknown", "EUR")
    assert sales["pay_oalabinternal"]["internal"] is True and pack["internal"] is False
    # Nothing stores a provider fee: it is unknown on every row, never 0.
    assert all(r["fee_minor"] is None for r in rows)
    assert str(pack["org_ref"]) == w["c1"]


def test_a_refund_without_an_amount_stays_unknown_and_a_dispute_is_not_a_refund(conn, sc):
    with world(conn):
        rows = _money(conn, sc)
    backs = sorted((r for r in rows if r["event"] != "sale"), key=lambda r: r["at"])
    assert [(r["event"], r["payment_ref"], r["amount_minor"]) for r in backs] == [
        ("refund", "pay_oalabpack1", 500),
        ("refund", "pay_oalabpack1", None),
        ("dispute", "pay_oalabmystery", None),
    ]
    assert backs[0]["kind"] == "pack" and backs[0]["item"] == "starter"


def test_the_window_is_half_open(conn, sc):
    with world(conn):
        out = _call(conn, sc.operator, MONEY, [_ts(11, 1), _ts(12, 1)])
        edge = _call(conn, sc.operator, MONEY, [_ts(10, 1) - timedelta(days=1), _ts(11, 1)])
    assert out.ok and edge.ok
    assert "pay_oalabplan2" in {r[3] for r in out.rows}
    assert "pay_oalabplan2" not in {r[3] for r in edge.rows}


def test_the_owner_reads_the_funnel_without_an_address(conn, sc):
    with world(conn) as w:
        out = _call(conn, sc.operator, PEOPLE)
    assert out.ok, out
    people = {str(r[0]): dict(zip(PEOPLE_COLUMNS, r)) for r in out.rows}
    p1, p2 = people[w["u1"]], people[w["u2"]]
    assert p1["first_generation_at"] == _ts(10, 8)
    assert p1["first_payment_at"] == _ts(10, 1) and p1["first_plan"] == "pro"
    assert p2["first_payment_at"] == _ts(10, 3) and p2["first_plan"] is None and p2["first_generation_at"] is None
    assert p1["acquisition"] is None and p1["internal"] is False and p1["confirmed"] is True
    assert people[sc.operator.uid]["internal"] is True
    assert not any("@" in str(v) for row in out.rows for v in row)


def test_activity_counts_a_person_once_a_day_and_leaves_the_roster_out(conn, sc):
    with world(conn) as w:
        out = _call(conn, sc.operator, ACTIVITY, [_ts(10, 1), _ts(10, 20)])
        wide = _call(conn, sc.operator, ACTIVITY, [FROM, FROM + timedelta(days=401)])
    assert out.ok, out
    mine = [r for r in out.rows if str(r[1]) == w["u1"]]
    assert sorted(str(r[0]) for r in mine) == ["2026-10-08", "2026-10-09"]
    assert all(r[2] is False for r in mine)
    assert all(r[2] is True for r in out.rows if str(r[1]) == sc.operator.uid)
    assert not wide.ok and wide.sqlstate == "22023", wide


def test_jobs_are_counted_with_the_time_they_took(conn, sc):
    with world(conn):
        out = _call(conn, sc.operator, JOBS, [_ts(10, 1), _ts(10, 20)])
    assert out.ok, out
    rows = {r[4]: r for r in out.rows if r[3] == "m-oalab"}
    done, failed = rows["completed"], rows["failed"]
    assert (done[7], done[8], done[9], float(done[10]), done[11]) == (1, 4, 1, 90.0, 1)
    # The failed job was never charged: 0 credits, and 0 jobs carrying a charge — not a free job.
    assert (failed[7], failed[8], failed[9]) == (1, 0, 0)


# ── internal / test workspaces ──────────────────────────────────────────────

def test_a_flagged_demo_workspace_is_internal_everywhere_and_unflagging_restores_it(conn, sc):
    with world(conn) as w:
        with acting(conn, sc.operator) as s:
            assert s.run("select public.owner_analytics_set_internal(%s, true, '  ')", [w["c1"]]).sqlstate == "22023"
            assert s.run("select public.owner_analytics_set_internal(%s, true, 'x')", [str(uuid.uuid4())]).sqlstate == "22023"
            assert s.run("select public.owner_analytics_set_internal(%s, true, 'Investor demo')", [w["c1"]]).ok
            sales = s.rows(MONEY, [FROM, TO])
            people = s.rows(PEOPLE)
            jobs = s.rows(JOBS, [FROM, TO])
            listed = s.rows("select org_id, source, reason from public.owner_analytics_internal_list()")
            assert s.run("select public.owner_analytics_set_internal(%s, false)", [w["c1"]]).ok
            after = s.rows(MONEY, [FROM, TO])
    c1 = [r for r in sales if str(r[4]) == w["c1"]]
    assert c1 and all(r[14] is True for r in c1)
    assert next(r for r in people if str(r[0]) == w["u1"])[6] is True
    assert all(r[6] is True for r in jobs if r[3] == "m-oalab")
    assert (uuid.UUID(w["c1"]), "flag", "Investor demo") in listed
    assert all(r[14] is False for r in after if str(r[4]) == w["c1"])


def test_a_workspace_owned_by_a_roster_account_is_internal_without_a_flag(conn, sc):
    with world(conn) as w:
        with as_superuser(conn, commit=False) as su:
            su.rows("insert into public.app_members (user_id, email, role) values (%s, 'c2-oalab@example.test', 'admin') returning 1",
                    [w["u2"]])
            with acting(conn, sc.operator) as s:
                sales = s.rows(MONEY, [FROM, TO])
    assert all(r[14] is True for r in sales if str(r[4]) == w["c2"])


def test_an_owner_grant_is_never_revenue(conn, sc):
    with world(conn) as w:
        with as_superuser(conn, commit=False) as su:
            su.value("select public.grant_credits(%s, 3000, 'lab: investor demo grant')", [w["c2"]])
            with acting(conn, sc.operator) as s:
                rows = s.rows(MONEY, [FROM, TO])
    assert sorted(r[3] for r in rows if str(r[4]) == w["c2"]) == ["pay_oalabmystery", "pay_oalabmystery", "txn_oalabapi"]


def test_a_plan_period_with_no_evidence_is_not_assumed_initial(conn, sc):
    with world(conn) as w:
        with as_superuser(conn, commit=False) as su:
            sub = su.value("insert into public.subscriptions (org_id, provider, provider_subscription_id, plan_id, status) "
                           "values (%s, 'dodo', 'sub_oalab2', 'pro', 'active') returning id", [w["c2"]])
            su.conn.execute("set local session_replication_role = replica")
            su.rows("insert into public.credit_lots (org_id, source, amount, remaining, external_id, subscription_id, plan_id, "
                    "period_start, period_end) values (%s, 'subscription', 10, 10, 'pay_oalabnonote', %s, 'pro', %s, %s) returning 1",
                    [w["c2"], sub, _ts(10, 1), _ts(10, 31)])
            su.conn.execute("set local session_replication_role = origin")
            _event(su, "dodo", "payment.succeeded", "pay_oalabnonote", w["c2"], 2900, at=_ts(10, 1))
            rows = _money(conn, sc)
    row = next(r for r in rows if r["payment_ref"] == "pay_oalabnonote")
    assert (row["kind"], row["charge"]) == ("plan", None)


def test_money_that_arrived_but_was_not_credited_is_its_own_event(conn, sc):
    with world(conn) as w:
        with as_superuser(conn, commit=False) as su:
            _event(su, "dodo", "payment.succeeded", "pay_oalabrejected", w["c2"], 4900, at=_ts(10, 11), status="rejected")
            # Rejected once, credited on a later delivery: a sale, not uncredited.
            _event(su, "dodo", "payment.succeeded", "pay_oalabpack1", w["c1"], 1500, at=_ts(10, 2), status="rejected", event="evt-rej")
            rows = _money(conn, sc)
    unc = [(r["event"], r["payment_ref"], r["amount_minor"]) for r in rows if r["event"] == "uncredited"]
    assert unc == [("uncredited", "pay_oalabrejected", 4900)]
