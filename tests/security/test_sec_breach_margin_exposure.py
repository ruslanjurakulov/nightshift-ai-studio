"""BR-G-001: the platform's per-unit margin (markup) is handed to every
signed-in customer.

``credit_prices.margin`` is the platform's markup multiplier:
``credits = quantity * credits_per_unit * (1 + margin)`` (table comment,
migration 0020). Migration 0037 states the rule plainly — "This is the
platform's own margin, never shown to an organization's members" — and
``tests/security/test_sec_model_registry.py`` blocks ``model_registry.spec``
from customers because it "carries provider USD costs and internal notes:
platform-only economics". Yet two paths still reach ``margin``:

  1. ``select margin from public.credit_prices`` — the SELECT grant and RLS
     policy (0020) let any ``auth.uid() is not null`` caller read every row
     and every column, so a member reads the markup of every unit, including
     the internal ``usd`` unit (the master markup over provider USD cost,
     which a customer cannot derive from their own charges) and the download
     minutes.

  2. ``public.sellable_models()`` (latest body migration 0072) returns
     ``cp.margin`` as a column to the ``authenticated`` role, so a member
     reads each sold model's markup directly.

The write side of ``credit_prices`` was carefully column-restricted
(``grant insert/update (credits_per_unit, margin, note)``), but the read side
was granted table-wide, and the catalog function surfaces the same column.

These tests assert the SECURE behaviour (a member sees no margin) and are
``xfail(strict=True)`` while the hole is open: when the leak is closed they
xpass and strict turns that into a failure, so the pin cannot rot. A positive
control confirms the operator still reads margin and that the public price
(``credits_per_unit``) stays readable — only the markup must be hidden.
"""

from __future__ import annotations

import uuid

import pytest

from sec_db import acting, as_superuser
from sec_scenario import MODEL_SOLD

PROBE_UNIT = "br_g_001_probe_usd"
PROBE_MARGIN = "2.5000"  # 3.5x over the provider's USD cost
MODEL_UNIT = f"model_{MODEL_SOLD.replace('-', '_')}_image"


def _seed_margins(conn):
    """A known markup on an internal unit and on the one sold model's unit."""
    with as_superuser(conn, commit=True) as s:
        s.rows(
            "insert into public.credit_prices (unit, credits_per_unit, margin) "
            "values (%s, 100, %s) on conflict (unit) do update set margin = excluded.margin returning 1",
            [PROBE_UNIT, PROBE_MARGIN])
        s.rows("update public.credit_prices set margin = 0.75 where unit = %s returning 1", [MODEL_UNIT])


def _clear_margins(conn):
    with as_superuser(conn, commit=True) as s:
        s.run("delete from public.credit_prices where unit = %s", [PROBE_UNIT])
        s.run("update public.credit_prices set margin = 0 where unit = %s", [MODEL_UNIT])


@pytest.mark.xfail(strict=True, reason="BR-G-001 open")
def test_a_member_cannot_read_the_platform_markup_in_credit_prices(conn, sc):
    _seed_margins(conn)
    try:
        with acting(conn, sc.bob.actor) as s:
            out = s.run("select unit, credits_per_unit, margin from public.credit_prices")
        assert out.ok, out
        margins = {r[0]: r[2] for r in out.rows}
        # The member may legitimately see the public price (credits_per_unit),
        # but never the markup. The internal 'usd' unit is the clearest leak:
        # its markup is not derivable from any charge a customer can observe.
        assert PROBE_UNIT not in margins or margins[PROBE_UNIT] is None, (
            f"member read the platform markup of {PROBE_UNIT!r}: {margins.get(PROBE_UNIT)!r} "
            "(margin must never be shown to an organization's members, migration 0037)")
    finally:
        _clear_margins(conn)


@pytest.mark.xfail(strict=True, reason="BR-G-001 open")
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
    finally:
        _clear_margins(conn)


def test_control_operator_reads_margin_and_members_still_read_the_public_price(conn, sc):
    """Positive control: the leak is specific to the margin column for
    customers. The operator must still read margin, and a member must still
    read credits_per_unit (the price they pay) — the fix narrows the read, it
    does not remove the price list."""
    _seed_margins(conn)
    try:
        with acting(conn, sc.operator) as s:
            op = s.run("select margin from public.credit_prices where unit = %s", [PROBE_UNIT])
        assert op.ok and op.rows and str(op.rows[0][0]) == PROBE_MARGIN, op
        with acting(conn, sc.bob.actor) as s:
            price = s.run(
                "select credits_per_unit from public.credit_prices where unit = %s", [MODEL_UNIT])
        assert price.ok and price.rows and price.rows[0][0] is not None, price
    finally:
        _clear_margins(conn)
