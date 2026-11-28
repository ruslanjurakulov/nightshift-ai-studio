"""Migration 0240: a vendor call that delivered nothing is never counted as units used in owner_provider_spend (0106).

What would break:

* a failed_call row (PR #964: a creative or film call that failed, timed out or answered without a file; its quantity is what was
  ASKED) summed into ``units`` as though it were used, or read as priced, or making the day's usd a number;
* a day of failed calls only reading 0 units instead of unknown;
* 0240 applied over a body that is neither 0106's nor its own, or its rollback not putting 0106's back;
* the function losing its security definer, search_path or grants on the way.

Every world is built inside one transaction that is rolled back.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import psycopg
import pytest

from sec_db import REPO, acting, as_superuser

D = Decimal
SPEND = "select * from public.owner_provider_spend(%s)"
COLUMNS = ["day", "provider", "usd", "usd_priced", "unpriced_rows", "units", "unit", "runs"]
MIGRATION = REPO / "supabase" / "migrations" / "0240_provider_spend_failed_calls.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0240_provider_spend_failed_calls.sql"
BODY_0106 = "dc5aaeb7ce9899dee21104238a0fada5"
BODY_0240 = "893a14eadc947b7065556c2d67b07530"
FOLDED = ("select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), "
          "'[[:space:]]+', ' ', 'g')) from pg_proc p where p.oid = 'public.owner_provider_spend(integer)'::regprocedure")


def _day(ago=0):
    return (datetime.now(timezone.utc) - timedelta(days=ago)).strftime("%Y-%m-%d")


def _job(su, org):
    return su.value(
        "insert into public.creative_jobs (org_id, capability, requested_model, routed_model, params, status, "
        "quoted_credits, charged_credits, payer, submit_started_at, finished_at) "
        "values (%s, 'i2v', 'm', 'm', '{}', 'failed', 1, 0, 'credits', now(), now()) returning id", [org])


def _cc(su, job, org, provider, *, unit="second", qty=None, usd=None, source=None):
    su.rows("insert into public.creative_job_costs (job_id, org_id, provider, unit, quantity, usd_estimate, price_source, recorded_at) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s::timestamptz) returning 1",
            [job, org, provider, unit, qty, usd, source, f"{_day()} 09:00:00+00"])


def mine(conn, who, prefix):
    with acting(conn, who) as s:
        out = s.run(SPEND, [30])
    assert out.ok, out
    return {(r[0], r[1]): dict(zip(COLUMNS, r)) for r in out.rows if r[1] and r[1].startswith(prefix)}


def _sql(path):
    # The rollback is written for an owner's one transaction; inside the lab's own transaction its begin/commit are left out.
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_the_live_body_is_0240s(conn):
    with as_superuser(conn, commit=False) as su:
        assert su.value(FOLDED) == BODY_0240


def test_the_files_hold_no_backslash_and_no_double_dash_inside_a_literal():
    for path in (MIGRATION, ROLLBACK):
        text = path.read_text(encoding="utf-8")
        assert "\\" not in text, path
        for line in text.splitlines():
            code = line.split("--", 1)[0] if not line.lstrip().startswith("--") else ""
            assert "'--" not in code and "--'" not in code, line


def test_a_failed_call_adds_no_units_and_keeps_the_day_unknown(conn, sc):
    with as_superuser(conn, commit=False) as su:
        j = _job(su, sc.alice.org)
        _cc(su, j, sc.alice.org, "lab-fc1", qty=10, usd=D("0.50"), source="lab price")      # delivered and priced
        _cc(su, _job(su, sc.alice.org), sc.alice.org, "lab-fc1", qty=10, source="failed_call")  # asked 10 s, delivered nothing
        r = mine(conn, sc.operator, "lab-fc")[(_day(), "lab-fc1")]
    assert (r["units"], r["unit"]) == (D("10"), "second")   # not 20: the failed call's seconds were asked, not used
    assert r["usd"] is None and r["usd_priced"] == D("0.50") and r["unpriced_rows"] == 1
    assert r["runs"] == 2


def test_a_day_of_failed_calls_only_has_unknown_units_not_zero(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cc(su, _job(su, sc.alice.org), sc.alice.org, "lab-fc2", qty=8, source="failed_call")
        _cc(su, _job(su, sc.bob.org), sc.bob.org, "lab-fc2", unit="second", qty=None, source="failed_call")
        r = mine(conn, sc.operator, "lab-fc")[(_day(), "lab-fc2")]
    assert r["units"] is None and r["unit"] == "second"
    assert r["usd"] is None and r["usd_priced"] is None and r["unpriced_rows"] == 2


def test_an_unpriced_row_that_is_not_a_failed_call_still_needs_its_quantity(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cc(su, _job(su, sc.alice.org), sc.alice.org, "lab-fc3", qty=None)
        _cc(su, _job(su, sc.alice.org), sc.alice.org, "lab-fc3", qty=5, source="failed_call")
        r = mine(conn, sc.operator, "lab-fc")[(_day(), "lab-fc3")]
    assert r["units"] is None   # a delivered row with no quantity leaves the units unknown, as in 0106


def test_the_security_is_0106s(conn):
    with as_superuser(conn, commit=False) as s:
        row = s.rows(
            "select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute'), "
            "has_function_privilege('service_role', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute') "
            "from pg_proc p where p.oid = 'public.owner_provider_spend(integer)'::regprocedure")[0]
    secdef, config, anon, service, authed = row
    assert secdef is True and any(c.startswith("search_path=public") for c in config), config
    assert (anon, service, authed) == (False, False, True)


def test_a_customer_is_still_refused_inside_the_function(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.run(SPEND, [30])
    assert not out.ok and out.sqlstate == "42501", out


def test_the_rollback_puts_0106s_body_back_and_0240_applies_again(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(_sql(ROLLBACK))
        assert su.value(FOLDED) == BODY_0106
        _cc(su, _job(su, sc.alice.org), sc.alice.org, "lab-fc4", qty=10, usd=D("0.50"), source="lab price")
        _cc(su, _job(su, sc.alice.org), sc.alice.org, "lab-fc4", qty=10, source="failed_call")
        before = mine(conn, sc.operator, "lab-fc4")[(_day(), "lab-fc4")]["units"]
        assert before == D("20")   # the finding, back under 0106: the asked seconds counted as used
        su.conn.execute(_sql(MIGRATION))
        assert su.value(FOLDED) == BODY_0240
        assert mine(conn, sc.operator, "lab-fc4")[(_day(), "lab-fc4")]["units"] == D("10")


def test_0240_refuses_a_body_it_does_not_know(conn):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute("create or replace function public.owner_provider_spend(p_days integer default 30) "
                        "returns table (day text, provider text, usd numeric, usd_priced numeric, unpriced_rows bigint, "
                        "units numeric, unit text, runs bigint) language sql security definer set search_path = public, pg_temp "
                        "as 'select null::text, null::text, null::numeric, null::numeric, null::bigint, null::numeric, null::text, null::bigint'")
        with pytest.raises(psycopg.errors.RaiseException, match="neither 0106"):
            su.conn.execute(_sql(MIGRATION))
