"""Breach: attacks on migration 0184 (owner costs and balances) and its two routes.

Two kinds of test live here. The ones that PASS are attacks that were tried and held (kept so a later change cannot quietly
reopen them). The ones that FAIL are holes that are still open; they stay failing, never skipped, until the fix lands.

The open holes all come from one fact: before 0184 the only writer of public.provider_balances was the balance worker with
the provider's own API (source = 'api'). 0184 adds a second writer, owner_analytics_balance_enter(), and stores its rows in
the same table. The owner hub reads `source` and badges a typed figure, but the operator bot's dead-man switch
(modules/operator_bot/sources.py balances(), reliability.provider_alerts) and the Billing page (lib/billing.ts latestBalance)
read the newest row whatever its source. So a typed figure silences the alerts that exist to catch a dead balance worker or
an empty provider account, and an unthrottled stream of typed rows pushes the real readings out of the bot's 100-row window.
Every world is rolled back.
"""

from __future__ import annotations

import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from sec_db import ANON, SERVICE, acting, user

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

WRITES = [
    "select public.owner_analytics_balance_enter('lab-vendor', 'credits', 5, 'credits')",
    "select public.owner_analytics_cost_add('2026-10-01', 'tools', 10, 'x')",
    "select public.owner_analytics_cost_delete(1)",
]
READS = [
    "select * from public.owner_analytics_provider_spend('2026-01-01', '2026-12-01')",
    "select * from public.owner_analytics_balances()",
    "select * from public.owner_analytics_costs('2026-01-01', '2026-12-01')",
]


# ── what held ──────────────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("q", READS + WRITES)
def test_a_forged_email_claim_of_the_owner_does_not_make_an_owner(conn, sc, q):
    # A fresh account whose token carries the owner's e-mail (but its own sub, and no confirmed address in auth.users):
    # platform_role() keys on auth.uid() and the CONFIRMED address only, so the claim buys nothing.
    impostor = user("oc-impostor", sc.operator.email)
    with acting(conn, impostor) as s:
        out = s.run(q)
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("q", READS + WRITES)
def test_service_role_claims_on_the_authenticated_role_are_still_not_the_owner(conn, sc, q):
    # role = authenticated (so EXECUTE is granted) but claims shaped like a service caller with no sub: no auth.uid().
    forged = type(ANON)("forged", "authenticated")
    with acting(conn, forged) as s:
        out = s.run(q)
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("remaining", ["'NaN'", "'Infinity'", "'-Infinity'", "-1", "1e12 + 1", "null"])
def test_the_owner_cannot_store_a_balance_that_is_not_a_finite_amount(conn, sc, remaining):
    # NaN in Postgres compares GREATER than every number (and equal to itself), so `> 1e12` is what refuses it here.
    with acting(conn, sc.operator) as s:
        out = s.run(f"select public.owner_analytics_balance_enter('lab-vendor', 'credits', {remaining}::double precision, 'credits')")
    assert not out.ok and out.sqlstate == "22023", out


@pytest.mark.parametrize("provider", ["=cmd|' /C calc'!A0", "ElevenLabs", "eleven labs", "../etc", "-x", "a" * 41, ""])
def test_a_provider_name_outside_the_slug_grammar_is_refused(conn, sc, provider):
    with acting(conn, sc.operator) as s:
        out = s.run("select public.owner_analytics_balance_enter(%s, 'credits', 1, 'credits')", [provider])
    assert not out.ok and out.sqlstate == "22023", out


def test_a_typed_balance_is_always_stored_as_manual_with_no_total_and_the_time_of_entry(conn, sc):
    # There is no parameter for source, total or the time: a typed row cannot be made to look like the provider's own. And it is
    # stored apart from provider_balances, which the operator bot and the Billing page read as the providers' own word.
    with acting(conn, sc.operator) as s:
        before = s.rows("select 1 from public.owner_analytics_balances() where provider = 'lab-vendor' and source = 'api'")
        bid = s.value("select public.owner_analytics_balance_enter('lab-vendor', 'credits', 7, 'credits')")
        got = s.rows("select source, total from public.owner_analytics_balances() where provider = 'lab-vendor' and remaining = 7")
        conn.execute("reset role")
        typed = s.rows("select entered_at > now() - interval '1 minute' from public.owner_manual_balances where id = %s", [bid])
        leaked = s.rows("select count(*) from public.provider_balances where provider = 'lab-vendor' and remaining = 7")
    assert before == [], before
    assert got == [("manual", None)], got
    assert typed == [(True,)], typed
    assert leaked == [(0,)], leaked


@pytest.mark.parametrize("amount", ["'NaN'::numeric", "'Infinity'::numeric", "-0.01", "1e10", "null"])
def test_a_cost_amount_that_is_not_a_bounded_number_is_refused(conn, sc, amount):
    with acting(conn, sc.operator) as s:
        out = s.run(f"select public.owner_analytics_cost_add('2026-10-01', 'tools', {amount})")
    assert not out.ok and out.sqlstate == "22023", out


def test_a_cost_for_next_month_and_a_note_over_300_characters_are_refused(conn, sc):
    with acting(conn, sc.operator) as s:
        nxt = s.run("select public.owner_analytics_cost_add((date_trunc('month', now() at time zone 'Asia/Tashkent') "
                    "+ interval '1 month')::date, 'tools', 1)")
        inf = s.run("select public.owner_analytics_cost_add('infinity', 'tools', 1)")
        note = s.run("select public.owner_analytics_cost_add('2026-10-01', 'tools', 1, %s)", ["x" * 301])
    for out in (nxt, inf, note):
        assert not out.ok and out.sqlstate == "22023", out


def test_the_write_guard_is_not_callable_even_by_the_owner(conn, sc):
    for who in (sc.operator, sc.alice.actor, ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run("select public.owner_costs_write_guard()")
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_no_api_role_can_write_provider_balances_directly(conn, sc):
    # The 'api' badge is only trustworthy while the balance worker (service key) is its only direct writer.
    for who in (sc.operator, sc.alice.actor, ANON):
        with acting(conn, who) as s:
            out = s.run("insert into public.provider_balances (provider, metric, remaining, unit, source) "
                        "values ('elevenlabs', 'characters', 1e9, 'characters', 'api')")
        assert not out.ok, (who.name, out)


# ── the operator bot, fed from the lab the way it reads production ─────────────────────────────────────────────────────


class _LabSync:
    """A SupabaseSync stand-in that answers the bot's PostgREST read from the lab, as the service key would."""

    enabled = True

    def __init__(self, session):
        self.s = session

    def select_strict(self, table, params=None):
        assert table == "provider_balances", table
        p = dict(params or {})
        cols = [c.strip() for c in p["select"].split(",")]
        col, _, way = p["order"].partition(".")
        q = (f"select {', '.join(cols)} from public.provider_balances order by {col} {'desc' if way == 'desc' else 'asc'} "
             f"limit {int(p['limit'])}")
        return [dict(zip(cols, [v.isoformat() if isinstance(v, datetime) else v for v in r])) for r in self.s.rows(q)]


def _bot_alerts(session, now):
    from modules.operator_bot import reliability
    from modules.operator_bot.config import OperatorConfig
    from modules.operator_bot.sources import OperatorSources

    ops = OperatorSources(_LabSync(session), lambda *a, **k: (None, None), OperatorConfig(), now=lambda: now)
    return {a.key for a in reliability.provider_alerts(ops, now, 1000.0, "en", reliability.Verdicts())}


@contextmanager
def _owner_and_service(conn, sc):
    """One rolled-back transaction in which the test can be the owner (writes) and then the service key (the bot's read)."""
    from psycopg import sql
    import json

    with conn.transaction(force_rollback=True):
        def be(who):
            conn.execute("reset role")
            conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))

        from sec_db import Session

        yield be, Session(conn)
        conn.execute("reset role")


def test_a_typed_balance_must_not_silence_the_stale_balance_alert(conn, sc):
    """FAILS today. The balance worker last reached the provider 40 hours ago (a rejected key, a dead schedule): the bot
    must say "stale". The owner then types a figure for the same provider. The bot reads the newest row whatever its
    source, sees a reading from a minute ago, and the dead-man alert for that provider goes quiet."""
    now = datetime.now(timezone.utc)
    with _owner_and_service(conn, sc) as (be, s):
        be(SERVICE)
        s.rows("insert into public.provider_balances (provider, metric, remaining, unit, source, checked_at) "
               "values ('lab-real', 'credits', 50, 'credits', 'api', %s) returning 1", [now - timedelta(hours=40)])
        before = _bot_alerts(s, now)
        be(sc.operator)
        s.value("select public.owner_analytics_balance_enter('lab-real', 'credits', 50, 'credits')")
        be(SERVICE)
        after = _bot_alerts(s, now)
    stale = {k for k in before if k.startswith("provider:stale:lab-real:")}
    assert stale, f"precondition: the stale API reading raises the alert ({before})"
    assert stale <= after, f"a typed balance silenced the stale-balance alert: before={before} after={after}"


def test_a_typed_balance_must_not_clear_a_zero_balance_the_provider_reported(conn, sc):
    """FAILS today. The provider's own API said 0 left an hour ago; the owner types 500. The bot's "provider at zero"
    alert disappears, and the Billing page's latestBalance() shows 500 as kind 'reported' (lib/billing.ts), i.e. as
    the provider's own reading (CLAUDE.md #5: a typed figure presented as a measurement)."""
    now = datetime.now(timezone.utc)
    with _owner_and_service(conn, sc) as (be, s):
        be(SERVICE)
        s.rows("insert into public.provider_balances (provider, metric, remaining, unit, source, checked_at) "
               "values ('lab-real', 'credits', 0, 'credits', 'api', %s) returning 1", [now - timedelta(hours=1)])
        before = _bot_alerts(s, now)
        be(sc.operator)
        s.value("select public.owner_analytics_balance_enter('lab-real', 'credits', 500, 'credits')")
        be(SERVICE)
        after = _bot_alerts(s, now)
    zero = {k for k in before if k.startswith("provider:zero:lab-real:")}
    assert zero, f"precondition: an API zero raises the alert ({before})"
    assert zero <= after, f"a typed balance cleared the provider-at-zero alert: before={before} after={after}"


def test_a_flood_of_typed_balances_must_not_blind_the_bot_to_real_readings(conn, sc):
    """FAILS today. owner_analytics_balance_enter has no rate limit (0107's owner_guard has one; this does not use it)
    and every call appends a row with checked_at = now(). 100 typed rows for any made-up provider fill the bot's
    `limit=100` window (sources.balances), the real API readings fall out of it, and balances() drops the Section's
    row-cap marker, so the dead-man switch reports neither the zero balance nor that it could not see."""
    now = datetime.now(timezone.utc)
    with _owner_and_service(conn, sc) as (be, s):
        be(SERVICE)
        s.rows("insert into public.provider_balances (provider, metric, remaining, unit, source, checked_at) "
               "values ('lab-real', 'credits', 0, 'credits', 'api', %s) returning 1", [now - timedelta(hours=1)])
        before = _bot_alerts(s, now)
        be(sc.operator)
        refused = 0
        for i in range(120):
            out = s.run("select public.owner_analytics_balance_enter(%s, 'credits', 1, 'credits')", [f"lab-flood-{i % 3}"])
            refused += 0 if out.ok else 1
        be(SERVICE)
        after = _bot_alerts(s, now)
    zero = {k for k in before if k.startswith("provider:zero:lab-real:")}
    assert zero, f"precondition: an API zero raises the alert ({before})"
    assert refused > 0 or zero <= after, (
        f"120 unthrottled typed balances pushed the real zero reading out of the bot's view: before={before} after={after}")


# ── validation gaps in the cost entries ────────────────────────────────────────────────────────────────────────────────


def test_a_cost_entry_for_the_month_minus_infinity_is_refused(conn, sc):
    """FAILS today. '-infinity'::date passes every check in owner_analytics_cost_add (date_trunc('month', -infinity) is
    -infinity, and -infinity is not after today) and the table's CHECK, so a cost with no month is stored and read
    back by owner_analytics_costs for any range that starts at -infinity. Only a direct RPC call reaches it: the route's
    MONTH regex refuses it."""
    with acting(conn, sc.operator) as s:
        out = s.run("select public.owner_analytics_cost_add('-infinity', 'tools', 1)")
    assert not out.ok and out.sqlstate == "22023", out


def test_an_amount_that_rounds_up_to_the_ceiling_is_a_validation_error_not_a_storage_failure(conn, sc):
    """FAILS today. 9999999999.995 passes `p_amount < 1e10`, rounds to 10000000000.00, and the table's CHECK raises
    23514; the route maps that to 503 "not_saved" (a transient failure, retry) instead of 400 (fix the input):
    CLAUDE.md #6."""
    with acting(conn, sc.operator) as s:
        out = s.run("select public.owner_analytics_cost_add('2026-10-01', 'tools', 9999999999.995)")
    assert not out.ok and out.sqlstate == "22023", out
