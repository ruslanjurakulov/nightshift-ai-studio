"""0193: public_models_on_sale() hands anyone — signed in or not — the display names and capability codes of the models the Studio
sells today, and nothing else.

What it must not reopen: sellable_models() is closed to anon since 0035 because it returns the charged rate and the public half
of spec, and 0084 (BR-G-001) is why a rate next to anything else is a margin leak. So these prove, against a real Postgres: anon
reads the list; the answer has exactly three columns; its names are exactly sellable_models(null, 'web')'s, so the two cannot drift
(a model the owner switches off disappears from both); a model 0192 marks as for adults only carries that mark here too, so the
landing never lists one without its 18+ label; and sellable_models itself still refuses anon.
"""

from __future__ import annotations

from sec_db import ANON, acting, as_superuser


def _sellable_names(conn) -> list:
    with as_superuser(conn, commit=False) as s:
        return sorted({r[0] for r in s.rows("select display_name from public.sellable_models(null, 'web')")})


def test_anon_reads_names_and_capabilities_only(conn):
    with acting(conn, ANON) as s:
        cur = s.conn.execute("select * from public.public_models_on_sale()")
        cols = [d.name for d in cur.description]
        rows = cur.fetchall()
    assert cols == ["display_name", "capabilities", "adult_only"]
    assert sorted(r[0] for r in rows) == _sellable_names(conn)
    for _name, caps, adult in rows:
        assert caps and all(isinstance(c, str) for c in caps)
        assert adult in (True, False)


def test_the_list_follows_sellable_models_when_a_model_is_switched_off(conn):
    names = _sellable_names(conn)
    assert names, "the lab sells no model after 0173: this test would pass vacuously"
    with conn.transaction(force_rollback=True):
        # The model behind the first name loses its price, which sellable_models treats as "not on sale" (never free).
        cur = conn.execute(
            "update public.credit_prices set credits_per_unit = 0 where unit in "
            "(select credit_unit from public.model_registry where display_name = %s)", [names[0]])
        assert cur.rowcount >= 1
        with acting(conn, ANON) as s:
            now = {r[0] for r in s.rows("select display_name from public.public_models_on_sale()")}
        assert names[0] not in now
        # (only that one: another model could share its credit unit, so the rest is not asserted)


def test_an_adults_only_model_is_listed_with_its_mark(conn):
    """0192: a model whose vendor terms are 18+ stays on sale (never hidden) and must be said to be for adults only."""
    names = _sellable_names(conn)
    assert names, "the lab sells no model after 0173: this test would pass vacuously"

    def marks() -> dict:
        with acting(conn, ANON) as s:
            return {r[0]: r[1] for r in s.rows("select display_name, adult_only from public.public_models_on_sale()")}

    assert marks().get(names[0]) is False, "a model without 0192's mark must not read as adults-only"
    with conn.transaction(force_rollback=True):
        cur = conn.execute(
            "update public.model_registry set spec = jsonb_set(coalesce(spec, '{}'::jsonb), '{requires_adult}', 'true'::jsonb) "
            "where display_name = %s", [names[0]])
        assert cur.rowcount >= 1
        assert marks().get(names[0]) is True, "an adults-only model must stay listed, marked"


def test_sellable_models_itself_stays_closed_to_anon(conn):
    with acting(conn, ANON) as s:
        out = s.run("select * from public.sellable_models(null, 'web')")
    assert not out.ok and out.sqlstate == "42501"


def test_no_price_or_vendor_detail_in_the_answer(conn):
    with acting(conn, ANON) as s:
        text = s.value("select coalesce(json_agg(m)::text, '') from public.public_models_on_sale() m")
    for leak in ("credits_per_unit", "margin", "provider", "credit_unit", "spec", "vendor", "usd"):
        assert leak not in (text or "")
