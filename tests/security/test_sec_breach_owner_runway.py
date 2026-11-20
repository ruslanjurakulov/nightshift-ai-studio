"""Breach: attacks on the provider runway (0183's owner_analytics_model_activity) that were tried and held.

The runway reads every workspace's creative jobs, so its one SQL function must answer the platform owner only — not a
platform admin on app_members, not a tenant admin, not anon, not the service role, not a token that carries the owner's
e-mail under another sub — and must refuse every window it cannot bound (NULL, infinite, reversed, over 200 days) before it
scans anything. What it returns is counts per model: no org, no user, no job id. Kept so a later change cannot quietly
reopen any of these. Every world is rolled back.
"""

from __future__ import annotations

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user

Q = "select * from public.owner_analytics_model_activity(%s::timestamptz, %s::timestamptz)"
WEEK = "select * from public.owner_analytics_model_activity(now() - interval '7 days', now() + interval '1 minute')"


def test_a_platform_admin_who_is_not_the_owner_is_refused(conn, sc):
    # is_platform_admin() is true for this account (it reads provider_topups and provider_balances under RLS, as the Billing
    # page does), but the runway's per-model job counts are the owner's alone.
    admin = user("rw-admin", "rw-admin@example.test")
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [admin.uid, admin.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [admin.uid, admin.email])
        with acting(conn, admin) as s:
            assert s.value("select public.is_platform_admin()") is True
            out = s.run(WEEK)
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("who", ["impostor", "nosub", "anon", "service"])
def test_forged_and_keyless_callers_are_refused(conn, sc, who):
    actor = {
        # The owner's address in the token, under a fresh sub with no confirmed auth.users row.
        "impostor": user("rw-impostor", sc.operator.email),
        # role = authenticated (EXECUTE is granted) but no sub: no auth.uid().
        "nosub": type(ANON)("rw-nosub", "authenticated"),
        "anon": ANON,
        "service": SERVICE,
    }[who]
    with acting(conn, actor) as s:
        out = s.run(WEEK)
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("window", [
    (None, "2026-01-01"), ("2026-01-01", None), ("2026-01-02", "2026-01-01"), ("2026-01-01", "2026-01-01"),
    ("infinity", "infinity"), ("-infinity", "infinity"), ("2026-01-01", "infinity"), ("-infinity", "2026-01-01"),
    ("2026-01-01", "2026-07-21"),
])
def test_the_owner_cannot_ask_for_an_unbounded_window(conn, sc, window):
    # An infinite bound fails in the subtraction itself (22008 on PG16, before the function's own 22023): refused either way,
    # and before the scan.
    with acting(conn, sc.operator) as s:
        out = s.run(Q, list(window))
    assert not out.ok and out.sqlstate in ("22023", "22008"), out


def test_exactly_200_days_is_accepted(conn, sc):
    with acting(conn, sc.operator) as s:
        out = s.run(Q, ["2026-01-01", "2026-07-20"])
    assert out.ok, out


def test_the_owner_gets_counts_per_model_and_nothing_that_names_a_customer(conn, sc):
    with as_superuser(conn, commit=False) as su:
        for org in (sc.alice.org, sc.bob.org):
            su.rows("insert into public.creative_jobs (org_id, capability, requested_model, params, status, quoted_credits) "
                    "values (%s, 't2i', 'm-rwlab', '{\"prompt\": \"secret plan\"}', 'completed', 1) returning 1", [org])
        with acting(conn, sc.operator) as s:
            out = s.run(WEEK)
            cols = s.rows("select p.name from pg_proc f, unnest(f.proargnames, f.proargmodes) as p(name, mode) "
                          "where f.oid = 'public.owner_analytics_model_activity(timestamptz, timestamptz)'::regprocedure "
                          "and p.mode = 't'")
    assert out.ok, out
    names = [c[0] for c in cols]
    assert names == ["model", "unit", "jobs", "completed", "failed", "quota_failed", "units", "units_counted",
                     "first_at", "last_at", "last_status", "last_error_code"], names
    row = [r for r in out.rows if r[0] == "m-rwlab"]
    assert len(row) == 1 and row[0][2] == 2, out.rows
    flat = repr(out.rows)
    for leak in (sc.alice.org, sc.bob.org, sc.alice.actor.uid, "secret plan"):
        assert str(leak) not in flat, leak
