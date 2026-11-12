"""Named attacks and the arithmetic of the operator's Customers page (migration 0138).

operator_customer_totals(), operator_customer_daily() and operator_customer_accounts() are SECURITY DEFINER: they read every
workspace's credit ledger and every person's email address, which no customer may read. So the whole defence is that they
refuse everyone but a platform owner/admin before they read anything (or even look at the arguments), and that anon and the
service role cannot execute them at all.

The second half pins what the operator reads, against a world built here: "credits spent" is what captures took (less a
capture that was refunded), never a hold, never a released hold and never an open one; a payment in another currency is
counted apart, never added as dollars; a retried webhook is one payment; the operator's own workspace is in none of it.
Totals are checked as the difference this world makes, so the rest of the lab's scenario cannot move them.

Every world is built inside one transaction that is rolled back, so nothing is left for another test to trip over.
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path

import pytest

from sec_db import ANON, REPO, SERVICE, acting, as_superuser
from sec_scenario import DEFAULT_ORG

D = Decimal
TOTALS = "select * from public.operator_customer_totals()"
DAILY = "select * from public.operator_customer_daily(%s)"
ACCOUNTS = "select * from public.operator_customer_accounts(%s, %s, %s, %s)"
TOTAL_COLUMNS = [
    "users_total", "users_new_7d", "users_new_30d", "workspaces_total", "workspaces_new_7d", "workspaces_new_30d",
    "active_7d", "active_30d", "credits_spent_total", "credits_spent_30d", "credits_purchased_total",
    "credits_granted_total", "paid_usd_total", "payments_other_currency", "balance_total", "reserved_total",
]
ACCOUNT_COLUMNS = [
    "org_id", "name", "owner_email", "created_at", "last_sign_in_at", "last_activity_at", "credits_spent_30d",
    "credits_spent", "balance", "reserved", "credits_purchased", "credits_granted", "paid_usd", "payments_other_currency",
    "plan_id", "plan_name", "jobs_total", "jobs_failed", "total_count",
]
MIGRATION = REPO / "supabase" / "migrations" / "0138_operator_customers.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0138_operator_customers.sql"
SIGS = (
    "public.operator_customer_totals()",
    "public.operator_customer_daily(integer)",
    "public.operator_customer_accounts(text, text, integer, integer)",
)


# ── building a world ────────────────────────────────────────────────────────

def _workspace(su, key: str, *, sign_in: bool = True):
    """A person and their workspace, written the way GoTrue and create_organization leave them (no welcome credits: the
    workspace has no created_by, so 0027's trigger grants nothing and every credit below is this test's)."""
    uid = str(uuid.uuid4())
    su.rows("insert into auth.users (id, email, email_confirmed_at, last_sign_in_at) "
            "values (%s, %s, now(), case when %s then now() - interval '1 hour' end) returning 1",
            [uid, f"{key}-opslab@example.test", sign_in])
    org = str(su.value("insert into public.organizations (name, slug) values (%s, %s) returning id",
                       [f"Opslab {key.upper()} Studio", f"opslab-{key}-{uid[:8]}"]))
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
            [org, uid, f"{key}-opslab@example.test"])
    return org, uid


def _capture(su, org, job, hold, charge):
    su.value("select public.reserve_credits(%s, %s, %s)", [org, job, hold])
    if charge is None:
        su.value("select public.release_credits(%s)", [job])
    else:
        su.value("select public.capture_credits(%s, %s)", [job, charge])


def _refund_capture(su, org, n, ref):
    """A failed paid download given back (0030's download_refund_locked: balance up, a positive 'refund' row)."""
    su.value("select public.credit_account_lock(%s)", [org])
    su.rows("update public.credit_accounts set balance = balance + %s, updated_at = now() where org_id = %s returning 1", [n, org])
    su.value("select public.credit_log(%s, 'refund', %s, %s, null, 'lab: download failed')", [org, n, ref])


def _old_capture(su, org, n, days_ago):
    """A capture from before the 30-day window. The ledger is append-only and stamped now(), so the row is written with the
    lot trigger off (it would otherwise spend from a lot the old run never took); only the ledger row matters here."""
    su.conn.execute("set local session_replication_role = replica")
    su.rows("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, job_id, created_at) "
            "values (%s, 'capture', %s, 0, 0, %s, now() - make_interval(days => %s)) returning 1",
            [org, -n, f"lab-old-{org[:8]}", days_ago])
    su.conn.execute("set local session_replication_role = origin")


def _payment(su, org, txn, minor, currency="USD", status="processed", event=None):
    su.rows("insert into public.payment_events (provider, event_id, event_type, status, org_id, transaction_id, credits, "
            "currency, amount_minor) values ('paddle', %s, 'transaction.completed', %s, %s, %s, 500, %s, %s) returning 1",
            [event or f"evt-{txn}", status, org, txn, currency, minor])


def _job(su, org, status):
    su.rows("insert into public.creative_jobs (org_id, capability, requested_model, params, status, quoted_credits, finished_at) "
            "values (%s, 't2i', 'm-lab', '{}', %s, 0, case when %s in ('completed', 'failed', 'expired') then now() end) "
            "returning 1", [org, status, status])


@contextmanager
def world(conn):
    """Two new workspaces and one person with none.

    C1: granted 100, bought 500 (paid $12.00, its webhook delivered twice); a run held 30 and captured 20 (10 released), a run
        held 15 and failed (all released), a paid download of 5 refunded. Spent 20 - 5 = 15. Balance 100 + 500 - 20 + 5 = 585.
        Four generations, two of them failed or expired. No subscription: the default plan.
    C2: granted 50 and captured 10, a capture of 7 forty days ago, an open hold of 5. Spent 17, 10 in 30 days. Balance 40,
        reserved 5. Paid 9.00 EUR once (counted apart, never as dollars). On Pro.
    The operator's own workspace is granted 1000 and captures 3: none of it may show.
    """
    with as_superuser(conn, commit=False) as su:
        c1, _ = _workspace(su, "c1")
        c2, _ = _workspace(su, "c2", sign_in=False)
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, 'noworkspace-opslab@example.test', now()) "
                "returning 1", [str(uuid.uuid4())])

        su.value("select public.grant_credits(%s, 100, 'lab grant')", [c1])
        su.value("select public.add_purchased_credits(%s, 500, 'txn-opslab-1', 'lab pack')", [c1])
        _payment(su, c1, "txn-opslab-1", 1200)
        _payment(su, c1, "txn-opslab-1", 1200, status="duplicate", event="evt-txn-opslab-1-retry")
        _capture(su, c1, "lab-c1-run", 30, 20)
        _capture(su, c1, "lab-c1-failed", 15, None)
        _refund_capture(su, c1, 5, "download:opslab")
        for status in ("completed", "completed", "failed", "expired"):
            _job(su, c1, status)

        su.value("select public.grant_credits(%s, 50, 'lab grant')", [c2])
        _capture(su, c2, "lab-c2-run", 10, 10)
        su.value("select public.reserve_credits(%s, 'lab-c2-open', 5)", [c2])
        _old_capture(su, c2, 7, 40)
        _payment(su, c2, "txn-opslab-eur", 900, currency="EUR")
        su.rows("insert into public.subscriptions (org_id, provider_subscription_id, plan_id, status) "
                "values (%s, 'sub_opslabc2aaaaaaaa', 'pro', 'active') returning 1", [c2])

        su.value("select public.grant_credits(%s, 1000, 'lab grant to the operator')", [DEFAULT_ORG])
        su.rows("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, job_id) "
                "select %s, 'capture', -3, balance, reserved, 'lab-internal' from public.credit_accounts where org_id = %s "
                "returning 1", [DEFAULT_ORG, DEFAULT_ORG])
        yield su, c1, c2


def _call(conn, who, query, params=None):
    with acting(conn, who) as s:
        return s.run(query, params)


def _totals(conn, who):
    out = _call(conn, who, TOTALS)
    assert out.ok and len(out.rows) == 1, out
    return dict(zip(TOTAL_COLUMNS, out.rows[0]))


def _accounts(conn, who, search=None, sort="spent_total", limit=50, offset=0):
    out = _call(conn, who, ACCOUNTS, [search, sort, limit, offset])
    assert out.ok, out
    return [dict(zip(ACCOUNT_COLUMNS, r)) for r in out.rows]


def _today(conn, who):
    out = _call(conn, who, DAILY, [30])
    assert out.ok and len(out.rows) == 30, out
    return dict(zip(["day", "signups", "credits_spent", "active_accounts"], out.rows[-1]))


# ── attacks: who may call them ──────────────────────────────────────────────

CALLS = [(TOTALS, None), (DAILY, [30]), (ACCOUNTS, [None, "spent_total", 50, 0])]


@pytest.mark.parametrize("call", CALLS, ids=["totals", "daily", "accounts"])
@pytest.mark.parametrize("who", ["alice", "bob", "stranger", "dana", "invitee"])
def test_customers_are_refused_inside_the_function(conn, sc, who, call):
    # dana is a member of the operator's own workspace: the closest a customer-shaped account gets without being on the roster.
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "stranger": sc.stranger, "dana": sc.dana, "invitee": sc.invitee}[who]
    out = _call(conn, actor, *call)
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("call", CALLS, ids=["totals", "daily", "accounts"])
def test_anon_and_the_service_role_cannot_execute_them(conn, sc, call):
    for who in (ANON, SERVICE):
        out = _call(conn, who, *call)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_a_customer_is_refused_before_the_arguments_are_looked_at(conn, sc):
    # A bad argument answering 22023 to a customer would be an oracle on the function's shape.
    for query, params in ((DAILY, [0]), (ACCOUNTS, [None, "no-such-sort", 0, -1]), (ACCOUNTS, ["x" * 500, None, 50, 0])):
        out = _call(conn, sc.alice.actor, query, params)
        assert not out.ok and out.sqlstate == "42501", out


def test_a_refusal_names_nothing(conn, sc):
    with world(conn) as (_su, c1, _c2):
        out = _call(conn, sc.bob.actor, ACCOUNTS, ["opslab", "spent_total", 50, 0])
    assert not out.ok
    text = (out.error or "").lower()
    for leak in ("opslab", "example.test", c1, "admin", "operator", "owner", "credit"):
        assert leak not in text, out


def test_a_customer_cannot_borrow_the_rights_through_a_view_or_wrapper(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        view = s.run("create view public.leak as select * from public.operator_customer_accounts()")
        func = s.run("create function public.leak() returns setof record language sql as "
                     "'select * from public.operator_customer_accounts()'")
    assert not view.ok and view.sqlstate == "42501", view
    assert not func.ok and func.sqlstate == "42501", func


def test_the_email_addresses_stay_closed_to_customers(conn, sc):
    # The page is the only door to other people's addresses; around it, a customer reads none.
    with world(conn):
        with acting(conn, sc.alice.actor) as s:
            users = s.run("select email from auth.users")
            members = s.run("select email from public.org_members where email like '%%opslab%%'")
            ledger = s.run("select count(*) from public.credit_transactions where job_id like 'lab-c%%'")
    assert not users.ok and users.sqlstate == "42501", users
    assert members.ok and members.rows == [], members
    assert ledger.ok and ledger.rows == [(0,)], ledger


def test_the_functions_are_read_only_definers_with_a_fixed_search_path(conn, sc):
    with as_superuser(conn, commit=False) as su:
        for sig in SIGS:
            row = su.rows("select p.prosecdef, p.provolatile, p.proconfig from pg_proc p where p.oid = to_regprocedure(%s)", [sig])
            assert row, sig
            definer, volatility, config = row[0]
            assert definer and volatility == "s", sig
            assert "search_path=public, pg_temp" in (config or []), sig


# ── what the operator reads ─────────────────────────────────────────────────

def test_the_operator_reads_each_workspace_exactly(conn, sc):
    with world(conn) as (_su, c1, c2):
        rows = {r["org_id"].__str__(): r for r in _accounts(conn, sc.operator, search="opslab")}
    assert set(rows) == {c1, c2}
    a, b = rows[c1], rows[c2]

    assert a["owner_email"] == "c1-opslab@example.test" and a["name"] == "Opslab C1 Studio"
    assert a["last_sign_in_at"] is not None and b["last_sign_in_at"] is None
    # Captured 20, of which a hold of 30 kept 10 back; a failed run's hold of 15 all released; a refunded download of 5.
    assert (a["credits_spent"], a["credits_spent_30d"]) == (D("15"), D("15"))
    assert (a["balance"], a["reserved"]) == (D("585"), D("0"))
    assert (a["credits_purchased"], a["credits_granted"]) == (D("500"), D("100"))
    # One payment, though its webhook arrived twice.
    assert (a["paid_usd"], a["payments_other_currency"]) == (D("12"), 0)
    assert (a["plan_id"], a["plan_name"]) == ("free", "Free")
    assert (a["jobs_total"], a["jobs_failed"]) == (4, 2)
    assert a["last_activity_at"] is not None

    # The open hold of 5 is reserved, never spent; the capture of 40 days ago is spent, not in 30 days.
    assert (b["credits_spent"], b["credits_spent_30d"]) == (D("17"), D("10"))
    assert (b["balance"], b["reserved"]) == (D("40"), D("5"))
    assert (b["credits_purchased"], b["credits_granted"]) == (D("0"), D("50"))
    # 9.00 EUR is counted apart, never read as dollars.
    assert (b["paid_usd"], b["payments_other_currency"]) == (D("0"), 1)
    assert (b["plan_id"], b["plan_name"]) == ("pro", "Pro")
    assert (b["jobs_total"], b["jobs_failed"]) == (0, 0)
    assert all(r["total_count"] == 2 for r in rows.values())


def test_the_totals_move_by_exactly_what_the_world_adds(conn, sc):
    before = _totals(conn, sc.operator)
    with world(conn):
        after = _totals(conn, sc.operator)
    delta = {k: after[k] - before[k] for k in TOTAL_COLUMNS}
    assert delta == {
        "users_total": 3, "users_new_7d": 3, "users_new_30d": 3,
        "workspaces_total": 2, "workspaces_new_7d": 2, "workspaces_new_30d": 2,
        "active_7d": 2, "active_30d": 2,
        # 15 + 17; in 30 days 15 + 10. The operator's own capture of 3 and grant of 1000 are in nothing.
        "credits_spent_total": D("32"), "credits_spent_30d": D("25"),
        "credits_purchased_total": D("500"), "credits_granted_total": D("150"),
        "paid_usd_total": D("12"), "payments_other_currency": 1,
        "balance_total": D("625"), "reserved_total": D("5"),
    }, delta


def test_the_day_by_day_counts_today_and_leaves_the_old_capture_out(conn, sc):
    before = _today(conn, sc.operator)
    with world(conn):
        after = _today(conn, sc.operator)
        out = _call(conn, sc.operator, DAILY, [90])
    assert after["day"] == before["day"]
    assert after["signups"] - before["signups"] == 2
    assert after["credits_spent"] - before["credits_spent"] == D("25")
    assert after["active_accounts"] - before["active_accounts"] == 2
    # 90 days reach back past the 40-day-old capture: it is on its own day, and every day is there, a quiet one as 0.
    assert out.ok and len(out.rows) == 90, out
    days = [r[0] for r in out.rows]
    assert days == sorted(days) and len(set(days)) == 90
    assert sum(r[2] for r in out.rows) >= D("32")


def test_search_is_plain_text_and_case_blind(conn, sc):
    with world(conn) as (_su, c1, c2):
        by_email = _accounts(conn, sc.operator, search="C1-OPSLAB@")
        by_name = _accounts(conn, sc.operator, search="opslab c2 studio")
        by_id = _accounts(conn, sc.operator, search=c2)
        wildcard = _accounts(conn, sc.operator, search="%")
        underscore = _accounts(conn, sc.operator, search="opslab_c")
        everyone = _accounts(conn, sc.operator, search="   ")
    assert [str(r["org_id"]) for r in by_email] == [c1]
    assert [str(r["org_id"]) for r in by_name] == [c2]
    assert [str(r["org_id"]) for r in by_id] == [c2]
    # % and _ are characters, not patterns: no workspace name or address holds them.
    assert wildcard == [] and underscore == []
    # A blank search is no search; the operator's own workspace is never a row.
    ids = {str(r["org_id"]) for r in everyone}
    assert {c1, c2, sc.alice.org, sc.bob.org} <= ids and DEFAULT_ORG not in ids


def test_sorting_and_paging_happen_in_the_database(conn, sc):
    with world(conn) as (_su, c1, c2):
        total = [str(r["org_id"]) for r in _accounts(conn, sc.operator, search="opslab", sort="spent_total")]
        recent = [str(r["org_id"]) for r in _accounts(conn, sc.operator, search="opslab", sort="spent_30d")]
        balance = [str(r["org_id"]) for r in _accounts(conn, sc.operator, search="opslab", sort="balance")]
        paid = [str(r["org_id"]) for r in _accounts(conn, sc.operator, search="opslab", sort="paid")]
        second = _accounts(conn, sc.operator, search="opslab", sort="spent_total", limit=1, offset=1)
        past_the_end = _accounts(conn, sc.operator, search="opslab", limit=50, offset=2)
        default_sort = [str(r["org_id"]) for r in _accounts(conn, sc.operator, search="opslab", sort=None)]
    assert total == [c2, c1]            # 17 > 15
    assert recent == [c1, c2]           # 15 > 10
    assert balance == [c1, c2]          # 585 > 40
    assert paid == [c1, c2]             # 12 > 0
    assert default_sort == total
    assert len(second) == 1 and str(second[0]["org_id"]) == c1 and second[0]["total_count"] == 2
    assert past_the_end == []


@pytest.mark.parametrize("query,params", [
    (DAILY, [0]), (DAILY, [91]), (DAILY, [None]),
    (ACCOUNTS, [None, "email", 50, 0]),
    (ACCOUNTS, [None, "spent_total", 0, 0]),
    (ACCOUNTS, [None, "spent_total", 101, 0]),
    (ACCOUNTS, [None, "spent_total", 50, -1]),
    (ACCOUNTS, [None, "spent_total", None, 0]),
    (ACCOUNTS, ["x" * 201, "spent_total", 50, 0]),
], ids=["days-0", "days-91", "days-null", "sort", "limit-0", "limit-101", "offset-neg", "limit-null", "search-long"])
def test_the_operator_gets_a_clear_refusal_for_a_bad_argument(conn, sc, query, params):
    out = _call(conn, sc.operator, query, params)
    assert not out.ok and out.sqlstate == "22023", out


def test_nothing_is_written(conn, sc):
    # The page is read-only: a call leaves every money table as it was.
    tables = ("credit_transactions", "credit_accounts", "credit_reservations", "payment_events", "creative_jobs", "subscriptions")
    count = " union all ".join(f"select '{t}', count(*) from public.{t}" for t in tables)
    with world(conn) as (su, _c1, _c2):
        before = su.rows(count)
        _totals(conn, sc.operator)
        _today(conn, sc.operator)
        _accounts(conn, sc.operator)
        after = su.rows(count)
    assert before == after


# ── the file ────────────────────────────────────────────────────────────────

def test_the_migration_replays_and_the_rollback_takes_it_out(conn, sc):
    def body(path: Path) -> str:
        return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))

    with as_superuser(conn, commit=False) as su:
        su.conn.execute(body(MIGRATION))  # a replay: its own bodies pass the drift guard
        su.conn.execute(body(ROLLBACK))
        for sig in SIGS:
            assert su.value("select to_regprocedure(%s)", [sig]) is None, sig
        su.conn.execute(body(MIGRATION))  # and it applies again on the rolled-back database
        for sig in SIGS:
            assert su.value("select to_regprocedure(%s)", [sig]) is not None, sig


def test_the_migration_and_the_rollback_refuse_a_body_they_did_not_write(conn, sc):
    import psycopg

    drift = ("create or replace function public.operator_customer_totals() returns table (users_total bigint) "
             "language sql stable security definer set search_path = public, pg_temp as $$ select 1::bigint $$")
    for path in (MIGRATION, ROLLBACK):
        with as_superuser(conn, commit=False) as su:
            su.conn.execute("drop function public.operator_customer_totals()")
            su.conn.execute(drift)
            text = "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
            with pytest.raises(psycopg.errors.RaiseException, match="operator_customer_totals"):
                with su.conn.transaction():
                    su.conn.execute(text)
