"""0089: public_video_rates() hands anyone — signed in or not — the two credit
rates a price page names (credits per finished minute, and the smallest hold),
AS CHARGED, and nothing else from the operator's price list.

The risk it must not reopen is BR-G-001 (0084): the platform's margin reached
members three ways, one of them the base rate next to the charged one (the
margin by division). So these prove, against a real Postgres: anon reads the
minute and the floor as charged; no other unit (an internal ``usd``-like unit
with a markup) comes back; the result has no base-rate, margin or note
column; and the call is a SECURITY DEFINER read past credit_prices' operator
RLS, so a signed-out page reads it with the anon key. A mutation proof puts a
body that returns every unit back (in a rolled-back transaction) and shows
the probe unit would leak, so the unit filter cannot pass vacuously.
"""

from __future__ import annotations

from decimal import Decimal

from sec_db import ANON, acting, as_superuser

PROBE_UNIT = "zz_0089_probe_usd"
MINUTE_BASE = Decimal("40")
MINUTE_MARGIN = Decimal("0.5")  # charged: 60 credits a minute
FLOOR = Decimal("30")


def _seed(conn):
    with as_superuser(conn, commit=True) as s:
        for unit, rate, margin in [("video_minute", MINUTE_BASE, MINUTE_MARGIN), ("job_minimum", FLOOR, Decimal("2")),
                                   (PROBE_UNIT, Decimal("100"), Decimal("2.5"))]:
            s.rows(
                "insert into public.credit_prices (unit, credits_per_unit, margin, note) values (%s, %s, %s, 'NOTECANARY') "
                "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin, "
                "note = excluded.note returning 1",
                [unit, rate, margin])


def _snapshot(conn):
    with as_superuser(conn, commit=False) as s:
        return s.rows("select unit, credits_per_unit, margin, note from public.credit_prices "
                      "where unit in ('video_minute', 'job_minimum')")


def _restore(conn, rows):
    with as_superuser(conn, commit=True) as s:
        s.run("delete from public.credit_prices where unit in ('video_minute', 'job_minimum', %s)", [PROBE_UNIT])
        for unit, rate, margin, note in rows:
            s.rows("insert into public.credit_prices (unit, credits_per_unit, margin, note) values (%s, %s, %s, %s) "
                   "returning 1", [unit, rate, margin, note])


def test_anon_reads_the_minute_and_the_floor_as_charged_and_nothing_else(conn, sc):
    before = _snapshot(conn)
    _seed(conn)
    try:
        for who in (ANON, sc.bob.actor):
            with acting(conn, who) as s:
                out = s.run("select unit, credits_per_unit from public.public_video_rates()")
            assert out.ok, (who, out)
            rates = dict(out.rows)
            assert set(rates) == {"video_minute", "job_minimum"}, (
                f"public_video_rates returned units beyond the two a price page names: {sorted(rates)}")
            assert rates["video_minute"] == MINUTE_BASE * (1 + MINUTE_MARGIN), rates  # as charged
            assert rates["job_minimum"] == FLOOR, rates  # a flat floor: its margin is ignored (0020)
        with acting(conn, ANON) as s:
            raw = s.run("select margin from public.credit_prices")
        assert (not raw.ok) or raw.rows == [], f"anon read the price list's margins directly: {raw}"
    finally:
        _restore(conn, before)


def test_the_result_has_no_base_rate_margin_or_note_column(conn, sc):
    with as_superuser(conn, commit=False) as s:
        result = s.value("select pg_get_function_result('public.public_video_rates()'::regprocedure)")
        definer = s.value("select prosecdef from pg_proc where oid = 'public.public_video_rates()'::regprocedure")
    assert result == "TABLE(unit text, credits_per_unit numeric)", result
    assert definer is True


def test_mutation_proof_without_the_unit_filter_the_probe_unit_leaks(conn, sc):
    """Put back a body that returns every unit, inside a rolled-back
    transaction: anon then reads the internal probe unit's charged rate. The
    filter in 0089 is what keeps the first test from passing vacuously."""
    before = _snapshot(conn)
    _seed(conn)
    try:
        with as_superuser(conn, commit=False) as s:
            s.run("""
                create or replace function public.public_video_rates()
                  returns table (unit text, credits_per_unit numeric)
                  language sql stable security definer set search_path = public, pg_temp as $$
                  select cp.unit, cp.credits_per_unit * (1 + cp.margin) from public.credit_prices cp order by cp.unit
                $$""")
            s.run("set local role anon")
            leaked = s.rows("select unit from public.public_video_rates()")
        assert (PROBE_UNIT,) in leaked, leaked
    finally:
        _restore(conn, before)


def test_the_file_replays_twice_and_keeps_its_grants(conn, sc):
    """Additive and idempotent: applying 0089 again (twice, after every later
    migration) leaves the same function and the same grants — the order a
    hand-applied migration actually meets."""
    from sec_db import MIGRATIONS
    sql = (MIGRATIONS / "0089_public_video_rates.sql").read_text()
    with as_superuser(conn, commit=False) as s:
        for _ in range(2):
            out = s.run(sql)
            assert out.ok, out
        result = s.value("select pg_get_function_result('public.public_video_rates()'::regprocedure)")
        anon = s.value("select has_function_privilege('anon', 'public.public_video_rates()', 'EXECUTE')")
        service = s.value("select has_function_privilege('service_role', 'public.public_video_rates()', 'EXECUTE')")
    assert result == "TABLE(unit text, credits_per_unit numeric)", result
    assert anon is True and service is False, (anon, service)
