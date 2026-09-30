"""Creative generations (0036) and their provider costs (0037), attacked.

The table-by-table tests already prove that creative_jobs and
creative_job_events are org-scoped and creative_job_costs is the operator's.
These prove the functions: the paths that hold and release credits, where
the check lives in plpgsql. Bob (org B) attacks Alice (org A)."""

from __future__ import annotations

import json

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scenario import DEFAULT_ORG

PARAMS = json.dumps({"prompt": "a cat"})


def ground(conn, q, p=None):
    with as_superuser(conn, commit=False) as s:
        return s.rows(q, p)


def holds(conn, org):
    return ground(conn, "select count(*), coalesce(sum(amount), 0) from public.credit_reservations "
                        "where org_id = %s and job_id like 'cj:%%'", [org])[0]


def jobs_of(conn, org):
    return ground(conn, "select count(*) from public.creative_jobs where org_id = %s", [org])[0][0]


def test_customer_cannot_quote_or_create_in_another_org(conn, sc):
    before = (holds(conn, sc.alice.org), jobs_of(conn, sc.alice.org))
    with acting(conn, sc.bob.actor) as s:
        q = s.run("select public.quote_creative_job(%s, 't2i', 'img-x', %s::jsonb)", [sc.alice.org, PARAMS])
        c = s.run("select public.create_creative_job(%s, 't2i', 'img-x', %s::jsonb, 'exact', null, 1000)",
                  [sc.alice.org, PARAMS])
    assert not q.ok and q.sqlstate == "42501", q
    assert not c.ok and c.sqlstate == "42501", c
    assert (holds(conn, sc.alice.org), jobs_of(conn, sc.alice.org)) == before


def test_stranger_and_anon_cannot_create(conn, sc):
    with acting(conn, sc.stranger) as s:
        out = s.run("select public.create_creative_job(%s, 't2i', 'img-x', %s::jsonb)", [sc.alice.org, PARAMS])
    assert not out.ok and out.sqlstate == "42501", out
    with acting(conn, ANON) as s:
        for q in ("select public.create_creative_job(%s, 't2i', 'img-x', '{}'::jsonb)",
                  "select public.quote_creative_job(%s, 't2i', 'img-x', '{}'::jsonb)"):
            out = s.run(q, [sc.alice.org])
            assert not out.ok and out.sqlstate == "42501", (q, out)
        out = s.run("select public.cancel_creative_job(%s)", [sc.alice.creative_job])
        assert not out.ok and out.sqlstate == "42501", out


def test_a_plain_member_of_the_operators_org_cannot_spend_the_platforms_money(conn, sc):
    # Every account that existed before 0018 is a member of the exempt org.
    with acting(conn, sc.dana) as s:
        out = s.run("select public.create_creative_job(%s, 't2i', 'img-x', %s::jsonb)", [DEFAULT_ORG, PARAMS])
    assert not out.ok and out.sqlstate == "42501", out


def test_customer_cannot_cancel_another_orgs_job(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select public.cancel_creative_job(%s)", [sc.alice.creative_job])
    # Another org's id reads as missing, so ids confirm nothing.
    assert not out.ok and out.sqlstate == "P0002", out
    assert ground(conn, "select status from public.creative_jobs where id = %s", [sc.alice.creative_job]) == [("completed",)]


def test_an_unsellable_model_holds_nothing(conn, sc):
    # Without the registry (0035) the answer is registry_missing, with it
    # model_not_sellable — never "allowed", and never a hold.
    before = (holds(conn, sc.alice.org), jobs_of(conn, sc.alice.org))
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select public.create_creative_job(%s, 't2i', 'nightshift-no-such-model', %s::jsonb, 'exact', null, 1000)",
                    [sc.alice.org, PARAMS])
    assert not out.ok and out.sqlstate == "NS400", out
    assert out.error.split(":")[-1].strip() in ("registry_missing", "model_not_sellable"), out
    assert (holds(conn, sc.alice.org), jobs_of(conn, sc.alice.org)) == before


@pytest.mark.parametrize("query", [
    "select public.claim_creative_job('evil')",
    "select public.heartbeat_creative_job(%(job)s, 'evil')",
    "select public.advance_creative_job(%(job)s, 'evil', 'submitting')",
    "select public.finish_creative_job(%(job)s, 'evil', true, 0)",
    "select public.expire_creative_jobs()",
    "select public.record_creative_job_cost(%(job)s, 'acme')",
    "select public.creative_platform_reserve(%(org)s, 'cj:evil', 1)",
    "select public.creative_platform_release('job-a')",
    "select public.creative_end_locked(%(job)s, 'cancelled', 'x', 'x')",
    "select public.creative_price(%(org)s, 't2i', 'img-x', '{}'::jsonb)",
])
def test_customer_cannot_call_the_workers_or_the_platforms_functions(conn, sc, query):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(query, {"job": sc.alice.creative_job, "org": sc.alice.org})
    assert not out.ok and out.sqlstate == "42501", out


def test_nobody_writes_job_rows_directly(conn, sc):
    for who in (sc.alice.actor, SERVICE):
        with acting(conn, who) as s:
            for q in ("update public.creative_jobs set status = 'completed', charged_credits = 0 where id = %s",
                      "delete from public.creative_jobs where id = %s",
                      "update public.creative_job_events set event = 'x' where job_id = %s"):
                out = s.run(q, [sc.alice.creative_job])
                assert (not out.ok) or out.rowcount == 0, (who.name, q, out)


def test_provider_costs_are_the_operators_only(conn, sc):
    for who in (sc.alice.actor, sc.bob.actor, sc.stranger, sc.dana):
        with acting(conn, who) as s:
            costs = s.run("select * from public.creative_job_costs")
            econ = s.run("select * from public.creative_economics")
        assert costs.ok and costs.rows == [], (who.name, costs)
        assert econ.ok and econ.rows == [], (who.name, econ)
    with acting(conn, ANON) as s:
        for q in ("select * from public.creative_job_costs", "select * from public.creative_economics"):
            out = s.run(q)
            assert (not out.ok) or out.rows == [], (q, out)
    with acting(conn, sc.operator) as s:
        costs = s.run("select org_id::text from public.creative_job_costs")
        econ = s.run("select model, jobs_completed, provider_usd, unpriced_cost_rows from public.creative_economics")
    assert {r[0] for r in costs.rows} >= {sc.alice.org, sc.bob.org}, costs
    # Unpriced provider cost is never shown as a dollar figure.
    assert econ.ok and econ.rows and all(r[2] is None for r in econ.rows if r[3] > 0), econ
