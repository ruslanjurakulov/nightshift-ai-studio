"""Named attacks and the arithmetic of the operator's margin report (0063).

operator_margin_report() is SECURITY DEFINER: it reads every organization's
credit lots, payments and provider costs, which no customer may read. So the
whole defence is that it refuses everyone but a platform owner/admin before it
reads anything, that anon and the service role cannot execute it at all, and
that it never hands a customer the operator's margin through some other door.

The second half pins what the operator reads — the report is a money number,
and the ways it could be quietly wrong are the ones tested: an unpriced cost
turning into $0, a failed job counted as revenue, free credits counted as
sales, a credit valued at a price nobody paid.

Every world is built inside one transaction that is rolled back, so nothing
here is left for another test to trip over.
"""

from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scenario import DEFAULT_ORG

DAY = "2026-05-10"
REPORT = "select * from public.operator_margin_report(%s::date, %s::date)"
COLUMNS = [
    "day", "model", "capability", "jobs_completed", "jobs_released", "jobs_internal",
    "credits_sold", "credits_released", "credits_paid", "credits_free", "credits_unvalued",
    "revenue_usd", "provider_usd", "provider_usd_released", "jobs_uncosted",
    "jobs_released_uncosted", "margin_usd", "margin_pct", "flags",
]
D = Decimal


# ── building a world ────────────────────────────────────────────────────────

def _svc(conn, query, params=None):
    """A service-key call inside the rolled-back world. SET LOCAL ROLE outlives
    a released savepoint, so the role is put back explicitly."""
    with acting(conn, SERVICE, commit=True) as s:
        out = s.value(query, params)
    conn.execute("reset role")
    return out


def _job(su, org, model, status="completed", *, charged=0, quoted=None, ref=None, payer="credits",
         submit=True, day=DAY):
    return su.value(
        "insert into public.creative_jobs (org_id, capability, requested_model, routed_model, params, status, "
        "quoted_credits, charged_credits, credit_ref, payer, submit_started_at, finished_at) "
        "values (%s, 't2i', %s, %s, '{}', %s, %s, %s, %s, %s, "
        "case when %s then %s::timestamptz end, %s::timestamptz) returning id",
        [org, model, model, status, charged if quoted is None else quoted, charged, ref, payer,
         submit, f"{day} 11:00+00", f"{day} 12:00+00"])


def _cost(su, job, org, usd):
    su.rows("insert into public.creative_job_costs (job_id, org_id, provider, unit, quantity, usd_estimate, price_source) "
            "values (%s, %s, 'acme', 'image', 1, %s, %s) returning 1",
            [job, org, usd, "lab price" if usd is not None else None])


def _lot(su, org, source, amount, ext=None):
    return su.value("insert into public.credit_lots (org_id, source, amount, remaining, external_id) "
                    "values (%s, %s, %s, 0, %s) returning id", [org, source, amount, ext])


def _spend(su, org, lot, ref, n):
    su.rows("insert into public.credit_lot_moves (org_id, lot_id, job_id, kind, remaining_delta, held_delta) "
            "values (%s, %s, %s, 'spend', %s, 0) returning 1", [org, lot, ref, -n])


def _paid(su, org, txn, credits, minor, currency="USD"):
    su.rows("insert into public.payment_events (provider, event_id, event_type, status, org_id, transaction_id, "
            "credits, currency, amount_minor) values ('paddle', %s, 'transaction.completed', 'processed', %s, %s, %s, %s, %s) "
            "returning 1", [f"evt-{txn}", org, txn, credits, currency, minor])


def _sold(su, org, model, n, lot, **kw):
    """A completed job that charged n credits, all spent from `lot`."""
    ref = f"cj:lab-{model}"
    job = _job(su, org, model, "completed", charged=n, ref=ref, **kw)
    if lot is not None:
        _spend(su, org, lot, ref, n)
    return job


@contextmanager
def world(conn, sc):
    """The scenario of the arithmetic tests, rolled back at the end. Prices:
    the USD pack (1000 credits for 12.00) is 0.012 a credit."""
    a = sc.alice.org
    with as_superuser(conn, commit=False) as su:
        pack = _lot(su, a, "pack", 1000, "txn-lab-1")
        _paid(su, a, "txn-lab-1", 1000, 1200)
        grant = _lot(su, a, "grant", 100)
        adjust = _lot(su, a, "adjustment", 100)
        eur = _lot(su, a, "pack", 1000, "txn-lab-eur")
        _paid(su, a, "txn-lab-eur", 1000, 1100, "EUR")
        refunded = _lot(su, a, "pack", 1000, "txn-lab-ref")
        _paid(su, a, "txn-lab-ref", 1000, 1200)
        su.rows("insert into public.credit_refunds (refund_id, purchase_external_id, org_id, requested, taken, shortfall) "
                "values ('rf-lab', 'txn-lab-ref', %s, 100, 100, 0) returning 1", [a])
        short = _lot(su, a, "pack", 1000, "txn-lab-short")  # the payment covered fewer credits than the lot holds
        _paid(su, a, "txn-lab-short", 500, 600)

        # m-paid: one sale, one failed job that still cost provider money.
        j = _sold(su, a, "m-paid", 10, pack)
        _cost(su, j, a, D("0.04"))
        failed = _job(su, a, "m-paid", "failed", quoted=6, ref="cj:lab-m-paid-failed")
        _cost(su, failed, a, D("0.02"))

        j = _sold(su, a, "m-unpriced", 5, pack)
        _cost(su, j, a, None)
        _sold(su, a, "m-nocost", 4, pack)                       # reached the provider, nothing recorded
        _sold(su, a, "m-nosubmit", 4, pack, submit=False)       # never began a billable call
        j = _sold(su, a, "m-free", 3, grant)
        _cost(su, j, a, D("0.01"))
        _cost(su, _sold(su, a, "m-adjust", 2, adjust), a, D("0.01"))
        _cost(su, _sold(su, a, "m-eur", 2, eur), a, D("0.01"))
        _cost(su, _sold(su, a, "m-refunded", 2, refunded), a, D("0.01"))
        _cost(su, _sold(su, a, "m-short", 2, short), a, D("0.01"))
        _cost(su, _sold(su, a, "m-untraced", 7, None), a, D("0.01"))
        _cost(su, _job(su, a, "m-api", "completed", payer="api_balance"), a, D("0.01"))
        _cost(su, _job(su, DEFAULT_ORG, "m-internal", "completed"), DEFAULT_ORG, D("0.50"))
        _job(su, a, "m-running", "running")
        _cost(su, _sold(su, a, "m-next-day", 1, pack, day="2026-05-11"), a, D("0.01"))
        yield su


def report(conn, who, frm=DAY, to=DAY):
    with acting(conn, who) as s:
        out = s.run(REPORT, [frm, to])
    return out


def by_model(conn, sc):
    out = report(conn, sc.operator)
    assert out.ok, out
    return {r[1]: dict(zip(COLUMNS, r)) for r in out.rows}


# ── attacks: who may call it ────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["alice", "bob", "stranger", "dana", "invitee"])
def test_customers_are_refused_inside_the_function(conn, sc, who):
    # dana is a member of the operator's own organization, the closest a
    # customer-shaped account gets to the operator without being on the roster.
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "stranger": sc.stranger,
             "dana": sc.dana, "invitee": sc.invitee}[who]
    with world(conn, sc):
        out = report(conn, actor)
    assert not out.ok and out.sqlstate == "42501", out


def test_a_customer_is_refused_with_no_arguments_too(conn, sc):
    with world(conn, sc):
        with acting(conn, sc.alice.actor) as s:
            out = s.run("select * from public.operator_margin_report()")
    assert not out.ok and out.sqlstate == "42501", out


def test_anon_cannot_execute_it(conn, sc):
    out = report(conn, ANON)
    assert not out.ok and out.sqlstate == "42501", out


def test_the_service_role_cannot_execute_it(conn, sc):
    # The Command Center never holds the service key; nothing else needs it.
    out = report(conn, SERVICE)
    assert not out.ok and out.sqlstate == "42501", out


def test_a_customer_learns_nothing_from_a_refusal(conn, sc):
    with world(conn, sc):
        out = report(conn, sc.bob.actor)
    assert not out.ok
    text = (out.error or "").lower()
    for leak in ("m-paid", "txn-lab", "0.04", sc.alice.org, "margin"):
        assert leak not in text, out


def test_a_customer_cannot_borrow_the_functions_rights_through_a_view_or_wrapper(conn, sc):
    # Defining objects needs CREATE on a schema; the API roles have none.
    with acting(conn, sc.alice.actor) as s:
        view = s.run("create view public.leak as select * from public.operator_margin_report()")
        func = s.run("create function public.leak() returns setof record language sql as "
                     "'select * from public.operator_margin_report()'")
    assert not view.ok and view.sqlstate == "42501", view
    assert not func.ok and func.sqlstate == "42501", func


def test_the_underlying_money_tables_stay_closed_to_customers(conn, sc):
    # The report is the only door, and it is locked: reading around it fails too.
    for who in (sc.alice.actor, sc.bob.actor, sc.dana):
        with acting(conn, who) as s:
            costs = s.rows("select count(*) from public.creative_job_costs")
            events = s.run("select count(*) from public.payment_events")
        assert costs == [(0,)], who
        assert (not events.ok) or events.rows == [(0,)], who


def test_the_operator_may_call_it(conn, sc):
    with world(conn, sc):
        out = report(conn, sc.operator)
    assert out.ok, out


def test_the_function_is_security_definer_with_a_pinned_search_path_and_a_closed_acl(conn):
    with as_superuser(conn, commit=False) as s:
        row = s.rows(
            "select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute'), "
            "has_function_privilege('service_role', p.oid, 'execute'), "
            "has_function_privilege('authenticated', p.oid, 'execute'), "
            "exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) "
            "from pg_proc p where p.oid = 'public.operator_margin_report(date,date)'::regprocedure")[0]
    secdef, config, anon, service, authed, public_grant = row
    assert secdef is True
    assert any(c.startswith("search_path=public") for c in config), config
    assert (anon, service, authed, public_grant) == (False, False, True, False)


def test_bad_ranges_are_refused_before_anything_is_read(conn, sc):
    for frm, to in (("2026-05-10", "2026-05-09"), ("2024-01-01", "2026-05-10")):
        out = report(conn, sc.operator, frm, to)
        assert not out.ok and out.sqlstate == "22023", (frm, to, out)


# ── what the operator reads ─────────────────────────────────────────────────

def test_the_columns_name_no_organization_job_or_person(conn, sc):
    with world(conn, sc):
        with acting(conn, sc.operator) as s:
            cur = s.conn.execute(REPORT, [DAY, DAY])
            names = [c.name for c in cur.description]
    assert names == COLUMNS


def test_a_paid_sale_is_valued_at_what_the_pack_was_bought_for(conn, sc):
    with world(conn, sc):
        r = by_model(conn, sc)["m-paid"]
    # 10 credits at 12.00 / 1000 = 0.12, against a priced 0.04 of provider cost.
    assert (r["credits_sold"], r["credits_paid"], r["credits_free"], r["credits_unvalued"]) == (10, 10, 0, 0)
    assert r["revenue_usd"] == D("0.12")
    assert r["provider_usd"] == D("0.04")
    assert r["margin_usd"] == D("0.08") and r["margin_pct"] == D("66.67")
    assert r["jobs_completed"] == 1


def test_a_failed_job_adds_no_revenue_and_is_flagged_with_its_cost(conn, sc):
    with world(conn, sc):
        r = by_model(conn, sc)["m-paid"]
    assert r["jobs_released"] == 1 and r["credits_released"] == 6
    assert r["provider_usd_released"] == D("0.02")
    assert "released_jobs" in r["flags"]
    # ...and the sale's own margin is untouched by it.
    assert r["revenue_usd"] == D("0.12") and r["provider_usd"] == D("0.04")


def test_an_unpriced_cost_is_unknown_never_zero(conn, sc):
    with world(conn, sc):
        r = by_model(conn, sc)["m-unpriced"]
    assert r["provider_usd"] is None and r["margin_usd"] is None and r["margin_pct"] is None
    assert r["revenue_usd"] == D("0.06")  # the revenue itself is known
    assert r["jobs_uncosted"] == 1 and "unpriced_cost" in r["flags"]


def test_a_job_that_reached_the_provider_with_no_cost_row_is_unknown_not_free(conn, sc):
    with world(conn, sc):
        r = by_model(conn, sc)["m-nocost"]
    assert r["provider_usd"] is None and r["margin_pct"] is None
    assert r["jobs_uncosted"] == 1 and "unpriced_cost" in r["flags"]


def test_a_job_that_never_began_a_billable_call_costs_a_known_zero(conn, sc):
    with world(conn, sc):
        r = by_model(conn, sc)["m-nosubmit"]
    assert r["provider_usd"] == 0 and r["jobs_uncosted"] == 0
    assert r["revenue_usd"] == D("0.048") and r["margin_pct"] == D("100.00")


def test_free_credits_are_reported_as_free_not_as_revenue_or_unknown(conn, sc):
    with world(conn, sc):
        r = by_model(conn, sc)["m-free"]
    assert (r["credits_sold"], r["credits_free"], r["credits_paid"], r["credits_unvalued"]) == (3, 3, 0, 0)
    assert r["revenue_usd"] == 0 and r["margin_usd"] == D("-0.01")
    assert r["margin_pct"] is None  # a percentage of nothing
    assert "free_credits" in r["flags"]


@pytest.mark.parametrize("model", ["m-adjust", "m-eur", "m-refunded", "m-short", "m-untraced"])
def test_credits_that_cannot_be_valued_make_revenue_unknown(conn, sc, model):
    # adjustment lot (may or may not have been bought) · a EUR payment (no
    # exchange rate is invented) · a refunded purchase · a lot that no longer
    # matches its one payment · a charge with no lot on record (before 0034).
    with world(conn, sc):
        r = by_model(conn, sc)[model]
    assert r["revenue_usd"] is None and r["margin_usd"] is None and r["margin_pct"] is None
    assert r["credits_unvalued"] == r["credits_sold"] > 0
    assert "unvalued_credits" in r["flags"]


def test_an_api_balance_job_has_no_credit_revenue_and_says_so(conn, sc):
    with world(conn, sc):
        r = by_model(conn, sc)["m-api"]
    assert r["revenue_usd"] is None and r["credits_sold"] == 0
    assert "api_balance_jobs" in r["flags"]


def test_the_operators_own_jobs_are_counted_but_leave_revenue_and_cost_alone(conn, sc):
    with world(conn, sc):
        r = by_model(conn, sc)["m-internal"]
    assert r["jobs_internal"] == 1 and r["jobs_completed"] == 0
    assert r["provider_usd"] == 0 and r["revenue_usd"] == 0 and "internal_jobs" in r["flags"]


def test_jobs_still_running_and_other_days_are_not_in_the_row(conn, sc):
    with world(conn, sc):
        models = by_model(conn, sc)
        wider = report(conn, sc.operator, "2026-05-10", "2026-05-11")
    assert "m-running" not in models and "m-next-day" not in models
    assert any(r[1] == "m-next-day" for r in wider.rows)


def test_rows_come_newest_day_first(conn, sc):
    with world(conn, sc):
        out = report(conn, sc.operator, "2026-05-10", "2026-05-11")
    days = [r[0] for r in out.rows]
    assert days == sorted(days, reverse=True)


def test_a_real_purchase_and_capture_is_valued_through_the_real_functions(conn, sc):
    # The same arithmetic, but the lot, the payment and the spend are written by
    # the platform's own functions, so the test fails if they ever stop leaving
    # what the report reads (lot external_id = the Paddle transaction id, and a
    # 'spend' lot move keyed by the hold's reference).
    org = None
    with as_superuser(conn, commit=False) as su:
        with acting(conn, sc.stranger, commit=True) as s:
            org = str(s.value("select public.create_organization('Margin Lab')"))
        conn.execute("reset role")
        _svc(conn, "select public.add_purchased_credits(%s, 1000, 'txn-lab-real', 'lab')", [org])
        _svc(conn, "select public.record_payment_event('paddle', 'evt-lab-real', 'transaction.completed', now(), "
                   "'processed', null, %s, 'txn-lab-real', null, 1000, 'USD', 1200)", [org])
        job = _job(su, org, "m-real", "completed", charged=10, quoted=10, ref="cj:lab-real")
        _svc(conn, "select public.reserve_credits(%s, 'cj:lab-real', 10)", [org])
        _svc(conn, "select public.capture_credits('cj:lab-real', 10, false)")
        _svc(conn, "select public.record_creative_job_cost(%s, 'acme', null, 'v1', 'image', 1, 0.04, 'lab price')", [job])
        r = by_model(conn, sc)["m-real"]
    assert (r["credits_sold"], r["credits_paid"], r["credits_free"], r["credits_unvalued"]) == (10, 10, 0, 0)
    assert r["revenue_usd"] == D("0.12") and r["provider_usd"] == D("0.04") and r["margin_pct"] == D("66.67")
