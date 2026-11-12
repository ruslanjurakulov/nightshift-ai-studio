"""Migration 0143: a model whose registry entry carries blocked_countries cannot be put on sale.

The country check runs in the Next.js routes only, and a signed-in user can call create_creative_job, start_workflow_run and
advance_workflow_run straight through PostgREST (docs/GEO_BLOCK.md "What it cannot do"). So a model with a country list must never be
beta or ga until the database refuses by country itself. These tests prove that no caller can get there:

  * the platform admin (0035's column grant on availability) and the service role are refused beta and ga, with the model verified,
    priced and without a terms_gate, so 0143's CHECK is the only thing that stops them;
  * a sync that gives a model already on sale a country list is refused whole, and changes nothing;
  * hidden, disabled, an empty list and JSON null are allowed (the operator preview of 0139 is hidden);
  * the file: its pre-check names a model already on sale, a replay changes nothing, the rollback takes the CHECK out and 0143 applies
    again.

Everything runs inside transactions that are rolled back. Nothing calls a provider.
"""

from __future__ import annotations

import json

from psycopg import sql

import sec_db
from sec_db import SERVICE, Actor, as_superuser
from sec_scenario import MODEL_GATED, MODEL_HIDDEN, MODEL_SOLD, _model_row

MIGRATION = sec_db.MIGRATIONS / "0143_country_block_before_sale.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0143_country_block_before_sale.sql"
CHECK = "model_registry_countries_before_sale"
COUNTRIES = ["IR", "KP"]


def body(path) -> str:
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def become(s, who: Actor | None) -> None:
    """Switch the caller inside the open transaction: None is the database owner."""
    s.conn.execute("reset role")
    if who is None:
        s.conn.execute("select set_config('request.jwt.claims', '', true)")
        return
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))


def sync(s, sold_spec=None, hidden_spec=None) -> object:
    rows = [_model_row(MODEL_SOLD, **(sold_spec or {})), _model_row(MODEL_HIDDEN, **(hidden_spec or {})),
            _model_row(MODEL_GATED, terms_gate="written_consent_required")]
    become(s, SERVICE)
    return s.run("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])


def state(s, mid):
    become(s, None)
    return s.value("select jsonb_build_object('availability', availability, 'countries', spec -> 'blocked_countries', "
                   "'verified', verified_at is not null) from public.model_registry where id = %s", [mid])


def off_sale_with_countries(s, countries=COUNTRIES):
    """MODEL_SOLD as the worst case: verified by a real probe, priced, no terms_gate; taken off sale, then given a country list."""
    become(s, None)
    s.rows("update public.model_registry set availability = 'hidden' where id = %s returning 1", [MODEL_SOLD])
    out = sync(s, sold_spec={"blocked_countries": countries})
    assert out.ok, out
    got = state(s, MODEL_SOLD)
    assert got == {"availability": "hidden", "countries": countries, "verified": True}, got


def test_the_check_is_there(conn, sc):
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from pg_constraint where conrelid = 'public.model_registry'::regclass "
                       "and conname = %s and convalidated", [CHECK]) == 1


def test_nobody_can_put_a_model_with_a_country_list_on_sale(conn, sc):
    with as_superuser(conn, commit=False) as s:
        off_sale_with_countries(s)
        for who in (sc.operator, SERVICE, None):
            for level in ("beta", "ga"):
                become(s, who)
                out = s.run("update public.model_registry set availability = %s where id = %s", [level, MODEL_SOLD])
                assert not out.ok and out.sqlstate == "23514" and CHECK in out.error, (who, level, out)
        assert state(s, MODEL_SOLD)["availability"] == "hidden"
        become(s, sc.bob.actor)
        assert s.rows("select id from public.sellable_models()") == []


def test_without_the_list_the_same_model_goes_back_on_sale(conn, sc):
    # The control: what stops the admin above is the country list, and nothing else.
    with as_superuser(conn, commit=False) as s:
        off_sale_with_countries(s)
        assert sync(s).ok
        become(s, sc.operator)
        out = s.run("update public.model_registry set availability = 'ga' where id = %s", [MODEL_SOLD])
        assert out.ok and out.rowcount == 1, out


def test_a_sync_that_gives_a_model_on_sale_a_country_list_is_refused_whole(conn, sc):
    with as_superuser(conn, commit=False) as s:
        before = {m: state(s, m) for m in (MODEL_SOLD, MODEL_HIDDEN)}
        assert before[MODEL_SOLD]["availability"] == "beta"
        out = sync(s, sold_spec={"blocked_countries": COUNTRIES}, hidden_spec={"note": "changed in the same sync"})
        assert not out.ok and out.sqlstate == "23514" and CHECK in out.error, out
        assert {m: state(s, m) for m in (MODEL_SOLD, MODEL_HIDDEN)} == before
        become(s, None)
        assert s.value("select spec ->> 'note' from public.model_registry where id = %s", [MODEL_HIDDEN]) is None


def test_hidden_disabled_an_empty_list_and_null_are_allowed(conn, sc):
    with as_superuser(conn, commit=False) as s:
        off_sale_with_countries(s)
        become(s, sc.operator)
        out = s.run("update public.model_registry set availability = 'disabled' where id = %s", [MODEL_SOLD])
        assert out.ok and out.rowcount == 1, out
        out = s.run("update public.model_registry set availability = 'hidden' where id = %s", [MODEL_SOLD])
        assert out.ok and out.rowcount == 1, out
        for empty in ([], None):
            assert sync(s, sold_spec={"blocked_countries": empty}).ok
            become(s, sc.operator)
            out = s.run("update public.model_registry set availability = 'beta' where id = %s", [MODEL_SOLD])
            assert out.ok and out.rowcount == 1, (empty, out)
            out = s.run("update public.model_registry set availability = 'hidden' where id = %s", [MODEL_SOLD])
            assert out.ok, out


def test_the_file_names_a_model_already_on_sale_and_refuses(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute(body(ROLLBACK))
        assert sync(s, sold_spec={"blocked_countries": COUNTRIES}).ok      # no CHECK: the sync goes through
        become(s, None)
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "0143" in out.error and f"{MODEL_SOLD} (beta)" in out.error, out
        assert s.value("select count(*) from pg_constraint where conname = %s", [CHECK]) == 0


def test_a_replay_changes_nothing(conn, sc):
    with as_superuser(conn, commit=False) as s:
        q = ("select conname, pg_get_constraintdef(oid) from pg_constraint "
             "where conrelid = 'public.model_registry'::regclass order by conname")
        before = s.rows(q)
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert s.rows(q) == before


def test_the_rollback_takes_the_check_out_and_0143_applies_again(conn, sc):
    with as_superuser(conn, commit=False) as s:
        q = "select count(*) from pg_constraint where conrelid = 'public.model_registry'::regclass and conname = %s"
        s.conn.execute(body(ROLLBACK))
        assert s.value(q, [CHECK]) == 0
        s.conn.execute(body(ROLLBACK))                                     # running it twice is harmless
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert s.value(q, [CHECK]) == 1
        off_sale_with_countries(s)
        become(s, sc.operator)
        out = s.run("update public.model_registry set availability = 'ga' where id = %s", [MODEL_SOLD])
        assert not out.ok and out.sqlstate == "23514", out
