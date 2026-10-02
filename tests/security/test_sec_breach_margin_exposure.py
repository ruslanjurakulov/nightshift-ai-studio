"""BR-G-001: the platform's per-unit margin (markup) was handed to every
signed-in customer. Fixed by migration 0084.

``credit_prices.margin`` is the platform's markup multiplier:
``credits = quantity * credits_per_unit * (1 + margin)`` (table comment,
migration 0020). Migration 0037 states the rule plainly — "This is the
platform's own margin, never shown to an organization's members" — and
``tests/security/test_sec_model_registry.py`` blocks ``model_registry.spec``
from customers because it "carries provider USD costs and internal notes:
platform-only economics". Before 0084 three paths reached ``margin``:

  1. ``select margin from public.credit_prices`` — the SELECT grant and RLS
     policy (0020) let any ``auth.uid() is not null`` caller read every row
     and every column, so a member read the markup of every unit, including
     the internal ``usd`` unit (the master markup over provider USD cost,
     which a customer cannot derive from their own charges), the base rates
     and the notes (provider list prices).

  2. ``public.sellable_models()`` (latest body migration 0072) returned
     ``cp.margin`` as a column to the ``authenticated`` role.

  3. every creative quote: ``creative_price()`` (latest body 0072) built a
     jsonb with a ``margin`` key and the base ``credits_per_unit``, and
     ``quote_creative_job()`` (and through it the public API's quote) handed it
     to the member as is — free to call for any model.

0084: the table is read by a platform owner/admin only (RLS by person — a
column grant cannot tell the operator from a member, both are
``authenticated``); members read the rates AS CHARGED through
``credit_rates()``; sellable_models() and creative_price() (so every quote)
name the charged rate and never the margin. These tests assert the secure behaviour; the mutation
proofs at the end put each pre-0084 body back (inside a rolled-back
transaction, from the migration files themselves) and show the same reads
leak again, so the tests cannot pass vacuously. A positive control confirms
the operator still reads (and edits) margin and that a member still reads the
price they pay.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal

from sec_db import ANON, MIGRATIONS, acting, as_superuser
from sec_scenario import MODEL_SOLD

PROBE_UNIT = "br_g_001_probe_usd"
PROBE_MARGIN = "2.5000"  # 3.5x over the provider's USD cost
MODEL_UNIT = f"model_{MODEL_SOLD.replace('-', '_')}_image"
MODEL_MARGIN = Decimal("0.75")
MODEL_BASE = Decimal("4")  # sec_scenario seeds the sold model's unit at 4
CHARGED = MODEL_BASE * (1 + MODEL_MARGIN)  # 7: what a member pays per image
PARAMS = json.dumps({"prompt": "a cat"})


def _seed_margins(conn):
    """A known markup on an internal unit and on the one sold model's unit."""
    with as_superuser(conn, commit=True) as s:
        s.rows(
            "insert into public.credit_prices (unit, credits_per_unit, margin, note) "
            "values (%s, 100, %s, 'NOTECANARY provider list $1') "
            "on conflict (unit) do update set margin = excluded.margin, note = excluded.note returning 1",
            [PROBE_UNIT, PROBE_MARGIN])
        s.rows("update public.credit_prices set margin = %s where unit = %s returning 1", [MODEL_MARGIN, MODEL_UNIT])


def _clear_margins(conn):
    with as_superuser(conn, commit=True) as s:
        s.run("delete from public.credit_prices where unit = %s", [PROBE_UNIT])
        s.run("update public.credit_prices set margin = 0 where unit = %s", [MODEL_UNIT])


def _member_quote(conn, sc):
    """Bob's quote of the sold model. The lab seeds it behind a plan
    entitlement (models_image:basic), which every quote refuses; for this
    read it is opened to anyone, in the caller's transaction only."""
    with as_superuser(conn, commit=True) as s:
        s.rows("update public.model_registry set entitlement = 'any' where id = %s returning 1", [MODEL_SOLD])
    with acting(conn, sc.bob.actor) as s:
        return s.run("select public.quote_creative_job(%s, 't2i', %s, %s::jsonb)", [sc.bob.org, MODEL_SOLD, PARAMS])


# ── the three paths, closed ─────────────────────────────────────────────────

def test_a_member_cannot_read_the_platform_markup_in_credit_prices(conn, sc):
    _seed_margins(conn)
    try:
        with acting(conn, sc.bob.actor) as s:
            out = s.run("select unit, credits_per_unit, margin from public.credit_prices")
        assert out.ok, out
        margins = {r[0]: r[2] for r in out.rows}
        # The internal 'usd'-like unit is the clearest leak: its markup is not
        # derivable from any charge a customer can observe.
        assert PROBE_UNIT not in margins or margins[PROBE_UNIT] is None, (
            f"member read the platform markup of {PROBE_UNIT!r}: {margins.get(PROBE_UNIT)!r} "
            "(margin must never be shown to an organization's members, migration 0037)")
        # Not one row: the base rate next to the charged one would give the
        # margin by division, and the notes carry provider list prices.
        assert out.rows == [], f"member read raw price rows: {out.rows[:3]}"
        with acting(conn, sc.stranger) as s:
            stranger = s.run("select unit, margin, note from public.credit_prices")
        assert stranger.ok and stranger.rows == [], stranger
        with acting(conn, ANON) as s:
            anon = s.run("select margin from public.credit_prices")
        assert (not anon.ok) or anon.rows == [], anon
    finally:
        _clear_margins(conn)


def test_sellable_models_does_not_hand_customers_the_per_model_margin(conn, sc):
    _seed_margins(conn)
    try:
        with acting(conn, sc.bob.actor) as s:
            out = s.run(
                "select id, credits_per_unit, margin from public.sellable_models(null, 'web')")
        assert out.ok, out
        leaked = {r[0]: r[2] for r in out.rows if r[2] is not None and r[2] != 0}
        assert not leaked, (
            f"sellable_models() returned the markup of {sorted(leaked)} to a customer "
            f"({leaked}); the catalog must carry the price, never the margin")
        rates = {r[0]: r[1] for r in out.rows}
        # The one number it carries is the rate as charged, never the base one.
        assert rates.get(MODEL_SOLD) == CHARGED, rates
    finally:
        _clear_margins(conn)


def test_a_quote_names_the_rate_as_charged_and_never_the_margin(conn, sc):
    _seed_margins(conn)
    try:
        with conn.transaction(force_rollback=True):
            out = _member_quote(conn, sc)
        assert out.ok, out
        q = out.rows[0][0]
        assert "margin" not in q, f"the quote handed a member the margin: {q}"
        assert Decimal(str(q["credits_per_unit"])) == CHARGED, q
        # What is held is creative_price's own number, unchanged by 0084.
        assert Decimal(str(q["credits"])) >= CHARGED and q["quantity"] == 1, q
    finally:
        _clear_margins(conn)


def test_credit_rates_gives_members_the_charged_rate_and_nothing_else(conn, sc):
    _seed_margins(conn)
    try:
        with acting(conn, sc.bob.actor) as s:
            cols = s.run("select * from public.credit_rates() limit 0")
            out = s.run("select unit, credits_per_unit from public.credit_rates()")
        assert cols.ok, cols
        assert out.ok, out
        rates = dict(out.rows)
        assert rates[PROBE_UNIT] == Decimal("350"), rates  # 100 x 3.5
        assert rates[MODEL_UNIT] == CHARGED, rates
        with as_superuser(conn, commit=False) as su:
            floor = su.rows("select credits_per_unit, margin from public.credit_prices where unit = 'job_minimum'")
        if floor:
            # A flat floor: its margin is ignored when charging (0020), so it is its own rate.
            assert rates["job_minimum"] == floor[0][0], (rates.get("job_minimum"), floor)
        with acting(conn, ANON) as s:
            anon = s.run("select * from public.credit_rates()")
        assert not anon.ok and anon.sqlstate == "42501", anon
    finally:
        _clear_margins(conn)


def test_credit_rates_has_no_margin_or_note_column(conn, sc):
    with as_superuser(conn, commit=False) as su:
        result = su.value("select pg_get_function_result('public.credit_rates()'::regprocedure)")
    assert result == "TABLE(unit text, credits_per_unit numeric, updated_at timestamp with time zone)", result


# ── positive control ────────────────────────────────────────────────────────

def test_control_operator_reads_margin_and_members_still_read_the_public_price(conn, sc):
    """The fix is specific to the margin for customers. The operator must still
    read (and edit) margin in the table, and a member must still read the price
    they pay — through credit_rates(), with the margin folded in: the fix
    narrows the read, it does not remove the price list."""
    _seed_margins(conn)
    try:
        with acting(conn, sc.operator) as s:
            op = s.run("select margin from public.credit_prices where unit = %s", [PROBE_UNIT])
        assert op.ok and op.rows and str(op.rows[0][0]) == PROBE_MARGIN, op
        # The editor's write path (PostgREST upsert = insert .. on conflict do update).
        with acting(conn, sc.operator) as s:
            edit = s.run(
                "insert into public.credit_prices (unit, credits_per_unit, margin, note) values (%s, 100, 1.25, 'x') "
                "on conflict (unit) do update set margin = excluded.margin returning margin", [PROBE_UNIT])
        assert edit.ok and edit.rows == [(Decimal("1.2500"),)], edit
        with acting(conn, sc.bob.actor) as s:
            price = s.run("select credits_per_unit from public.credit_rates() where unit = %s", [MODEL_UNIT])
        assert price.ok and price.rows and price.rows[0][0] == CHARGED, price
    finally:
        _clear_margins(conn)


# ── mutation proofs: the pre-0084 bodies leak again ─────────────────────────

def _function_sql(migration: str, name: str) -> str:
    text = (MIGRATIONS / migration).read_text()
    m = re.search(r"create or replace function public\." + name + r"\(.*?\n\$\$;", text, re.S)
    assert m, (migration, name)
    return m.group(0)


def test_mutation_the_0020_policy_hands_the_margin_back(conn, sc):
    _seed_margins(conn)
    try:
        with conn.transaction(force_rollback=True):
            with as_superuser(conn, commit=True) as su:
                assert su.run("drop policy credit_prices_select on public.credit_prices").ok
                assert su.run("create policy credit_prices_select on public.credit_prices for select to authenticated "
                       "using ((select auth.uid()) is not null)").ok
            with acting(conn, sc.bob.actor) as s:
                out = s.run("select unit, margin from public.credit_prices where unit = %s", [PROBE_UNIT])
            assert out.ok and out.rows == [(PROBE_UNIT, Decimal(PROBE_MARGIN))], out
    finally:
        _clear_margins(conn)


def test_mutation_0072s_catalog_hands_the_margin_back(conn, sc):
    _seed_margins(conn)
    try:
        with conn.transaction(force_rollback=True):
            with as_superuser(conn, commit=True) as su:
                assert su.run(_function_sql("0072_captions.sql", "sellable_models")).ok
            with acting(conn, sc.bob.actor) as s:
                out = s.run("select id, credits_per_unit, margin from public.sellable_models(null, 'web')")
            assert out.ok, out
            assert {r[0]: (r[1], r[2]) for r in out.rows}.get(MODEL_SOLD) == (MODEL_BASE, MODEL_MARGIN), out
    finally:
        _clear_margins(conn)


def test_mutation_0072s_price_hands_the_margin_back_in_the_quote(conn, sc):
    _seed_margins(conn)
    try:
        with conn.transaction(force_rollback=True):
            with as_superuser(conn, commit=True) as su:
                assert su.run(_function_sql("0072_captions.sql", "creative_price")).ok
            out = _member_quote(conn, sc)
            assert out.ok, out
            q = out.rows[0][0]
            assert Decimal(str(q["margin"])) == MODEL_MARGIN and Decimal(str(q["credits_per_unit"])) == MODEL_BASE, q
    finally:
        _clear_margins(conn)
