"""Named attacks and the arithmetic of the owner analytics hub's costs (migration 0183).

The functions read every provider's cost and every balance, and write the owner's own cost entries and manual balances. So:
everyone but the platform owner is refused (an admin too) before anything is read; anon and the service role cannot execute
them; with 0107's second-factor gate on, a password-only owner session cannot write; the cost table is closed. The arithmetic:
an unpriced cost row is counted, never added as 0; the operator's internal workspaces and the pipeline are flagged internal; a
balance the owner typed in is returned as 'manual'. Every world is rolled back.
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user
from sec_scenario import DEFAULT_ORG

FROM = datetime(2026, 1, 1, tzinfo=timezone.utc)
TO = datetime(2027, 1, 1, tzinfo=timezone.utc)
SPEND = "select * from public.owner_analytics_provider_spend(%s, %s)"
CALLS = [
    (SPEND, [FROM, TO]),
    ("select * from public.owner_analytics_balances()", None),
    ("select public.owner_analytics_balance_enter('lab-vendor', 'credits', 5, 'credits')", None),
    ("select public.owner_analytics_cost_add('2026-10-01', 'tools', 10, 'x')", None),
    ("select public.owner_analytics_cost_delete(1)", None),
    ("select * from public.owner_analytics_costs('2026-01-01', '2026-12-01')", None),
    ("select * from public.owner_analytics_model_activity(now() - interval '7 days', now())", None),
]
IDS = ["spend", "balances", "balance_enter", "cost_add", "cost_delete", "costs", "model_activity"]


@contextmanager
def world(conn, sc):
    with as_superuser(conn, commit=False) as su:
        admin = user("oc-admin", "oc-admin@example.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [admin.uid, admin.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [admin.uid, admin.email])
        jobs = []
        for org in (sc.alice.org, sc.alice.org, DEFAULT_ORG):
            jobs.append(su.value("insert into public.creative_jobs (org_id, capability, requested_model, params, status, quoted_credits) "
                                 "values (%s, 't2i', 'm-oclab', '{}', 'completed', 1) returning id", [org]))
        su.rows("insert into public.creative_job_costs (job_id, org_id, provider, vendor_model, unit, quantity, usd_estimate, price_source, recorded_at) values "
                "(%s, %s, 'oclab', 'oclab-model', 'image', 1, 0.5, 'lab', '2026-10-02T10:00:00Z'), "
                "(%s, %s, 'oclab', 'oclab-model', 'image', 1, null, null, '2026-10-02T11:00:00Z'), "
                "(%s, %s, 'oclab', 'oclab-model', 'image', 1, 0.25, 'lab', '2026-10-02T12:00:00Z') returning 1",
                [jobs[0], sc.alice.org, jobs[1], sc.alice.org, jobs[2], DEFAULT_ORG])
        su.rows("insert into public.video_costs (unit, quantity, stage, estimated_usd, recorded_at) values "
                "('oclab_tokens', 10, 'script', 0.1, '2026-10-03T00:00:00Z'), ('oclab_tokens', 1, 'script', null, 'not a date') returning 1")
        yield {"admin": admin}


def _call(conn, who, q, p=None):
    with acting(conn, who) as s:
        return s.run(q, p)


@pytest.mark.parametrize("call", CALLS, ids=IDS)
@pytest.mark.parametrize("who", ["alice", "bob", "dana", "admin"])
def test_everyone_but_the_owner_is_refused(conn, sc, who, call):
    with world(conn, sc) as w:
        actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "dana": sc.dana, "admin": w["admin"]}[who]
        out = _call(conn, actor, *call)
    assert not out.ok and out.sqlstate == "42501" and out.error == "not available", out


@pytest.mark.parametrize("call", CALLS, ids=IDS)
def test_anon_and_the_service_role_cannot_execute_them(conn, sc, call):
    for who in (ANON, SERVICE):
        out = _call(conn, who, *call)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_the_cost_table_and_the_helper_are_closed(conn, sc):
    for who in (sc.operator, sc.alice.actor, SERVICE):
        with acting(conn, who) as s:
            sel = s.run("select * from public.owner_cost_entries")
            ins = s.run("insert into public.owner_cost_entries (month, category, amount_usd, entered_by) "
                        "values ('2026-10-01', 'tools', 1, %s)", [sc.operator.uid])
            helper = s.run("select public.owner_costs_write_guard()")
        for out in (sel, ins, helper):
            assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_an_unpriced_cost_is_counted_never_added_as_zero(conn, sc):
    with world(conn, sc):
        out = _call(conn, sc.operator, SPEND, [FROM, TO])
    assert out.ok, out
    rows = [r for r in out.rows if r[1] == "creative" and r[2] == "oclab"]
    customer = next(r for r in rows if r[4] is False)
    internal = next(r for r in rows if r[4] is True)
    assert (customer[5], customer[6], customer[7]) == (2, Decimal("0.500000"), 1)
    assert (internal[5], internal[6], internal[7]) == (1, Decimal("0.250000"), 0)
    pipe = [r for r in out.rows if r[1] == "pipeline" and r[3] == "oclab_tokens"]
    # The provider is named from the unit as 0106 names it; the pipeline is internal; the row whose date cannot be read is
    # returned undated (day null), counted, never dropped.
    assert sorted((str(r[0]), r[2], r[4], r[5], float(r[6]), r[7]) for r in pipe) == [
        ("2026-10-03", "oclab", True, 1, 0.1, 0),
        ("None", "oclab", True, 1, 0.0, 1),
    ]


def test_the_owner_enters_costs_and_balances_and_nothing_else_changes(conn, sc):
    with world(conn, sc):
        with acting(conn, sc.operator) as s:
            assert s.run("select public.owner_analytics_cost_add('2026-10-15', 'tools', 10)").sqlstate == "22023"
            assert s.run("select public.owner_analytics_cost_add('2026-10-01', 'yachts', 10)").sqlstate == "22023"
            assert s.run("select public.owner_analytics_cost_add('2026-10-01', 'tools', -1)").sqlstate == "22023"
            assert s.run("select public.owner_analytics_cost_add('2099-01-01', 'tools', 1)").sqlstate == "22023"
            cid = s.value("select public.owner_analytics_cost_add('2026-10-01', 'tools', 12.345, ' editor seats ')")
            costs = s.rows("select month::text, category, amount_usd, note, entered_by from public.owner_analytics_costs('2026-10-01', '2026-10-01')")
            assert s.run("select public.owner_analytics_balance_enter('Bad Name', 'credits', 1, 'credits')").sqlstate == "22023"
            assert s.run("select public.owner_analytics_balance_enter('lab-vendor', 'credits', 'NaN', 'credits')").sqlstate == "22023"
            assert s.value("select public.owner_analytics_balance_enter('lab-vendor', 'credits', 42, 'credits')") is not None
            bal = s.rows("select provider, remaining, source from public.owner_analytics_balances() where provider = 'lab-vendor'")
            assert s.value("select public.owner_analytics_cost_delete(%s)", [cid]) is True
            assert s.value("select public.owner_analytics_cost_delete(%s)", [cid]) is False
    assert ("2026-10-01", "tools", Decimal("12.35"), "editor seats", uuid.UUID(sc.operator.uid)) in costs
    assert bal == [("lab-vendor", 42.0, "manual")]


def test_with_the_mfa_gate_on_a_password_only_owner_cannot_write(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.owner_security_settings set admin_aal2_required = true returning 1")
        su.rows("insert into auth.mfa_factors (id, user_id, status) values (%s, %s, 'verified') returning 1", [str(uuid.uuid4()), sc.operator.uid])
        with acting(conn, sc.operator) as s:
            add = s.run("select public.owner_analytics_cost_add('2026-10-01', 'tools', 1)")
            bal = s.run("select public.owner_analytics_balance_enter('lab-vendor', 'credits', 1, 'credits')")
            read = s.run("select count(*) from public.owner_analytics_costs('2026-01-01', '2026-12-01')")
    assert not add.ok and add.sqlstate == "NS401", add
    assert not bal.ok and bal.sqlstate == "NS401", bal
    assert read.ok, read


def test_model_activity_counts_every_workspace_and_says_how_the_newest_job_ended(conn, sc):
    """The provider runway's job counts: every workspace's jobs spend the provider's balance, the operator's own included,
    and a model whose newest job was refused with error_code 'quota' must say so (the runway reads it as EMPTY)."""
    q = "select * from public.owner_analytics_model_activity(now() - interval '1 day', now() + interval '1 minute')"
    with world(conn, sc):
        with as_superuser(conn, commit=False) as su:
            su.rows("insert into public.creative_jobs (org_id, capability, requested_model, params, status, quoted_credits, error_code, "
                    "created_at) values (%s, 't2i', 'm-oclab', '{}', 'failed', 1, 'quota', now() + interval '1 second') returning 1",
                    [sc.alice.org])
            out = _call(conn, sc.operator, q)
    assert out.ok, out
    row = [r for r in out.rows if r[0] == "m-oclab"]
    assert len(row) == 1, out.rows
    model, unit, jobs, completed, failed, quota, units, counted, first_at, last_at, last_status, last_error, ok_at, quota_at = row[0]
    assert (jobs, completed, failed, quota) == (4, 3, 1, 1), row
    assert (last_status, last_error) == ("failed", "quota"), row
    assert quota_at is not None and ok_at is not None and quota_at >= ok_at, row


def test_a_quota_refusal_hidden_by_routing_still_reaches_the_model_that_refused(conn, sc):
    """A routed job whose first model refused for want of balance runs on the next one (0088): the job row names the second
    model as completed, and only the platform-only route row says the first refused with 'quota'. The runway must see it."""
    q = "select * from public.owner_analytics_model_activity(now() - interval '1 day', now() + interval '1 minute')"
    with world(conn, sc):
        with as_superuser(conn, commit=False) as su:
            job = su.value("insert into public.creative_jobs (org_id, capability, requested_model, routed_model, params, status, "
                           "quoted_credits, created_at) values (%s, 't2i', 'm-oclab', 'm-oclab-b', '{}', 'completed', 1, "
                           "now() + interval '2 seconds') returning id", [sc.alice.org])
            su.rows("insert into public.creative_job_routes (job_id, candidates, tried, reasons) values "
                    "(%s, '[]', '[\"m-oclab-a\", \"m-oclab-b\"]', '[\"quota\"]') on conflict (job_id) do update "
                    "set tried = excluded.tried, reasons = excluded.reasons returning 1", [job])
            out = _call(conn, sc.operator, q)
    assert out.ok, out
    by = {r[0]: r for r in out.rows}
    assert "m-oclab-a" in by and by["m-oclab-a"][13] is not None, out.rows  # last_quota_at for the model that refused
    assert by["m-oclab-b"][12] is not None and by["m-oclab-b"][13] is None, out.rows  # the model that ran completed


def test_model_activity_refuses_an_unbounded_window(conn, sc):
    out = _call(conn, sc.operator, "select * from public.owner_analytics_model_activity(now() - interval '201 days', now())")
    assert not out.ok and out.sqlstate == "22023", out
