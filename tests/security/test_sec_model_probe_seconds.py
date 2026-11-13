"""Migration 0151: the Studio's progress seed (public.model_probe_seconds), attacked in a real database.

What would break without these:
  * anon or the service key reading the platform's probe evidence through the new door (0035 closes model_probe_runs to both);
  * a customer learning that a hidden or terms-gated model exists, or how it did in a probe, by naming it;
  * anything beyond the five columns leaking: the probe's error text, output bytes, who probed, the vendor model, spec;
  * a failed probe, or a probe of a vendor model the registry no longer calls, read as the model's speed;
  * an older success outranking a newer one, or a failure after the success going unsaid;
  * the probe's clip length borrowed from a probe block of another capability, or from a string;
  * an unbounded or malformed list reaching the query (51 ids, a null, a filter-looking id, a 2-D array);
  * the file not replaying, the rollback leaving the function behind, or either one overwriting a body it did not write.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

from sec_db import ANON, REPO, SERVICE, Session, as_superuser
from sec_scenario import MODEL_GATED, MODEL_HIDDEN, MODEL_SOLD

CALL = "select model_id, capability, probe_seconds, clip_seconds, probed_at is not null, failed_after from public.model_probe_seconds(%s::text[])"
MIGRATION = REPO / "supabase" / "migrations" / "0151_model_probe_seconds.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0151_model_probe_seconds.sql"
SIG = "public.model_probe_seconds(text[])"
ALL = [MODEL_SOLD, MODEL_HIDDEN, MODEL_GATED]


@contextmanager
def scratch(conn):
    """One transaction that is always rolled back: the superuser sets the world up, then callers ask inside it."""
    with conn.transaction(force_rollback=True):
        conn.execute("select set_config('request.jwt.claims', '', true)")
        yield conn


def ask(conn, who, models):
    conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    try:
        return Session(conn).run(CALL, [models])
    finally:
        conn.execute("reset role")
        conn.execute("select set_config('request.jwt.claims', '', true)")


def probe(conn, model, *, ok=True, latency=900, at="now()", capability="t2i", vendor="lab-model-1"):
    conn.execute(
        "insert into public.model_probe_runs (model_id, adapter, vendor_model, capability, ok, error_code, error, latency_ms, "
        f"output_bytes, probed_by, created_at) values (%s, 'image.openai', %s, %s, %s, %s, %s, %s, 1, 'security-lab', {at})",
        [model, vendor, capability, ok, None if ok else "timeout", None if ok else "LAB-PROBE-ERROR-TEXT", latency])


def set_probe_block(conn, model, block):
    conn.execute("update public.model_registry set spec = jsonb_set(spec, '{probe}', %s::jsonb) where id = %s", [json.dumps(block), model])


def ok(out):
    assert out.ok, out
    return out.rows


# ── who may call it ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("who", [ANON, SERVICE], ids=["anon", "service_role"])
def test_anon_and_the_service_key_cannot_execute_it(conn, sc, who):
    with scratch(conn):
        out = ask(conn, who, [MODEL_SOLD])
    assert not out.ok and out.sqlstate == "42501", out


def test_a_customer_sees_the_model_on_sale_and_nothing_of_a_hidden_or_gated_one(conn, sc):
    with scratch(conn):
        for who in (sc.bob.actor, sc.alice.actor, sc.stranger):
            rows = ok(ask(conn, who, ALL))
            # The scenario's probe: 900 ms, t2i, no probe block (an image has no clip length), no failure since.
            assert rows == [(MODEL_SOLD, "t2i", Decimal("0.900"), None, True, False)], (who.name, rows)


def test_the_platform_admin_also_sees_a_hidden_model_with_a_successful_probe(conn, sc):
    with scratch(conn):
        rows = sorted(ok(ask(conn, sc.operator, ALL)))
    # The gated model has a successful probe and is hidden; the hidden one only failed, so it has no seed for anyone.
    assert [r[0] for r in rows] == sorted([MODEL_SOLD, MODEL_GATED]), rows


def test_only_the_five_columns_come_back_never_the_error_text_or_the_vendor_model(conn, sc):
    with scratch(conn):
        probe(conn, MODEL_SOLD, ok=False, at="now() + interval '1 minute'")
        conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        conn.execute("set local role authenticated")
        try:
            cur = conn.execute("select * from public.model_probe_seconds(array[%s])", [MODEL_SOLD])
            names = [d.name for d in cur.description]
            text = json.dumps(cur.fetchall(), default=str)
        finally:
            conn.execute("reset role")
    assert names == ["model_id", "capability", "probe_seconds", "clip_seconds", "probed_at", "failed_after"]
    for secret in ("LAB-PROBE-ERROR-TEXT", "timeout", "lab-model-1", "image.openai", "security-lab", "provider_usd"):
        assert secret not in text, secret


# ── which probe ─────────────────────────────────────────────────────────────

def test_the_newest_success_wins_and_a_failure_after_it_is_said(conn, sc):
    with scratch(conn):
        probe(conn, MODEL_SOLD, latency=70976, at="now() + interval '1 minute'")
        assert ok(ask(conn, sc.bob.actor, [MODEL_SOLD])) == [(MODEL_SOLD, "t2i", Decimal("70.976"), None, True, False)]
        probe(conn, MODEL_SOLD, ok=False, latency=600000, at="now() + interval '2 minutes'")
        # The failure's 600 s is never the answer; the success stays, flagged.
        assert ok(ask(conn, sc.bob.actor, [MODEL_SOLD])) == [(MODEL_SOLD, "t2i", Decimal("70.976"), None, True, True)]
        # A failure of ANOTHER capability says nothing about this one.
        probe(conn, MODEL_GATED, ok=False, capability="edit", at="now() + interval '3 minutes'")
        assert ok(ask(conn, sc.operator, [MODEL_GATED]))[0][5] is False


def test_a_probe_of_another_vendor_model_is_not_this_models_speed(conn, sc):
    with scratch(conn):
        probe(conn, MODEL_SOLD, latency=5000, vendor="lab-model-OLD", at="now() + interval '1 minute'")
        assert ok(ask(conn, sc.bob.actor, [MODEL_SOLD]))[0][2] == Decimal("0.900")


def test_a_failed_only_model_has_no_seed_even_for_the_admin(conn, sc):
    with scratch(conn):
        assert ok(ask(conn, sc.operator, [MODEL_HIDDEN])) == []


# ── the clip length ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("block, want", [
    ({"capability": "t2i", "duration_s": 5}, Decimal(5)),
    ({"capability": "t2i", "duration_s": 2.5}, Decimal("2.5")),
    ({"capability": "i2v", "duration_s": 5}, None),   # the probe block is for another capability than the probe row
    ({"capability": "t2i", "duration_s": "5"}, None),  # a string is not a length
    ({"capability": "t2i", "duration_s": 0}, None),
    ({"capability": "t2i", "duration_s": -4}, None),
    ({"capability": "t2i", "duration_s": 7200}, None),
    ({"capability": "t2i"}, None),
])
def test_the_clip_length_comes_only_from_a_matching_probe_block(conn, sc, block, want):
    with scratch(conn):
        set_probe_block(conn, MODEL_SOLD, block)
        rows = ok(ask(conn, sc.bob.actor, [MODEL_SOLD]))
    assert rows[0][3] == want, (block, rows)


# ── the input ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("models", [
    [f"m{i:02d}-x" for i in range(51)],
    [MODEL_SOLD, None],
    ["Lab-Sold-1"],
    ["a"],
    ['lab-sold-1"),or(x'],
    ["x" * 41],
], ids=["51 ids", "a null", "upper case", "too short", "filter-looking", "too long"])
def test_a_long_or_malformed_list_is_refused_whole(conn, sc, models):
    with scratch(conn):
        out = ask(conn, sc.bob.actor, models)
    assert not out.ok and out.sqlstate == "22023", out


def test_a_two_dimensional_array_is_refused(conn, sc):
    with scratch(conn):
        conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        conn.execute("set local role authenticated")
        try:
            out = Session(conn).run("select * from public.model_probe_seconds(array[array['lab-sold-1'], array['lab-gated-1']])")
        finally:
            conn.execute("reset role")
    assert not out.ok and out.sqlstate == "22023", out


def test_fifty_ids_an_empty_list_and_null_are_answered(conn, sc):
    with scratch(conn):
        fifty = [MODEL_SOLD] + [f"m{i:02d}-x" for i in range(49)]
        assert [r[0] for r in ok(ask(conn, sc.bob.actor, fifty))] == [MODEL_SOLD]
        assert ok(ask(conn, sc.bob.actor, [])) == []
        assert ok(ask(conn, sc.bob.actor, None)) == []


# ── the function itself ─────────────────────────────────────────────────────

def test_it_is_a_stable_definer_with_a_fixed_search_path_that_writes_nothing(conn, sc):
    with as_superuser(conn, commit=False) as su:
        row = su.rows("select prosecdef, provolatile, proconfig from pg_proc where oid = to_regprocedure(%s)", [SIG])[0]
        before = su.value("select count(*) from public.model_probe_runs")
    assert row[0] is True and row[1] == "s" and "search_path=public, pg_temp" in row[2]
    with scratch(conn):
        ok(ask(conn, sc.operator, ALL))
    with as_superuser(conn, commit=False) as su:
        assert su.value("select count(*) from public.model_probe_runs") == before


# ── the file ────────────────────────────────────────────────────────────────

def _text(path: Path) -> str:
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_the_migration_replays_and_the_rollback_takes_it_out(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(_text(MIGRATION))  # a replay: its own body passes the drift guard
        su.conn.execute(_text(ROLLBACK))
        assert su.value("select to_regprocedure(%s)", [SIG]) is None
        su.conn.execute(_text(MIGRATION))  # and it applies again on the rolled-back database
        assert su.value("select to_regprocedure(%s)", [SIG]) is not None
        assert su.value("select has_function_privilege('authenticated', %s, 'EXECUTE')", [SIG]) is True
        assert su.value("select has_function_privilege('anon', %s, 'EXECUTE')", [SIG]) is False


def test_the_migration_and_the_rollback_refuse_a_body_they_did_not_write(conn, sc):
    drift = ("create or replace function public.model_probe_seconds(p_models text[]) returns table (model_id text, capability text, "
             "probe_seconds numeric, clip_seconds numeric, probed_at timestamptz, failed_after boolean) "
             "language sql stable security definer set search_path = public, pg_temp as $$ select null::text, null::text, 1::numeric, "
             "null::numeric, now(), false $$")
    for path in (MIGRATION, ROLLBACK):
        with as_superuser(conn, commit=False) as su:
            su.conn.execute("drop function public.model_probe_seconds(text[])")
            su.conn.execute(drift)
            with pytest.raises(psycopg.errors.RaiseException, match="model_probe_seconds"):
                with su.conn.transaction():
                    su.conn.execute(_text(path))
