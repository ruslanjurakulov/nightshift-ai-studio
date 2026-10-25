"""A model past its vendor's announced shutdown date is not sold (migration 0125).

Google's deprecations page lists the Veo 3.1 previews with a shutdown date and
calls it the earliest possible one. Nothing in the database knew a model had a
date, so a model stayed on sale (and quotable by name) after its vendor had
scheduled it off. These tests run the two real functions on a real Postgres:
the list (sellable_models) and the quote (creative_price), at the boundary day
and with a `shutdown` nobody can read, which must read as past, never as safe.

Every row is made inside one rolled-back transaction, so no later test sees it.
"""

from __future__ import annotations

import json

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scenario import _model_row


def _spec_shutdown(on):
    return {"on": on, "source_url": "https://ai.google.dev/gemini-api/docs/deprecations", "as_of": "2026-10-25"}


def _unit(mid):
    return f"model_{mid.replace('-', '_')}_image"


def _make_models(conn, cases):
    """Insert verified, priced, on-sale models (the way sec_scenario makes lab-sold-1), one per case."""
    for mid, shutdown in cases.items():
        row = _model_row(mid, **({} if shutdown is None else {"shutdown": shutdown}))
        row["entitlement"] = None
        conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, "
                     "credit_unit, entitlement) values (%s, %s, 'lab', 'image.openai', array['t2i'], %s::jsonb, %s, null)",
                     [mid, mid, json.dumps(row["spec"]), _unit(mid)])
        conn.execute("select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', true, null, null, 900, 1234, 'security-lab')", [mid])
        conn.execute("update public.model_registry set availability = 'beta' where id = %s", [mid])
        conn.execute("insert into public.credit_prices (unit, credits_per_unit) values (%s, 4)", [_unit(mid)])


def _cases(conn):
    today = conn.execute("select (now() at time zone 'utc')::date").fetchone()[0]
    day = lambda n: (today.fromordinal(today.toordinal() + n)).isoformat()
    return {
        "lab-sd-past": _spec_shutdown(day(-3)),
        "lab-sd-today": _spec_shutdown(day(0)),
        "lab-sd-tomorrow": _spec_shutdown(day(1)),
        "lab-sd-none": None,
        "lab-sd-baddate": _spec_shutdown("2026-13-45"),
        "lab-sd-word": _spec_shutdown("today"),
        "lab-sd-string": "2999-12-31",
        "lab-sd-no-on": {"source_url": "https://ai.google.dev/gemini-api/docs/deprecations", "as_of": "2026-10-25"},
    }


ON_SALE = {"lab-sd-tomorrow", "lab-sd-none"}


def test_sellable_models_drops_a_model_on_and_after_its_shutdown_day_and_keeps_the_rest(conn, sc):
    with conn.transaction(force_rollback=True):
        conn.execute("select set_config('request.jwt.claims', '', true)")
        cases = _cases(conn)
        _make_models(conn, cases)
        conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.alice.actor.claims())])
        conn.execute("set local role authenticated")
        ids = {r[0] for r in conn.execute("select id from public.sellable_models(null, 'web')").fetchall()
               if r[0].startswith("lab-sd-")}
        # A date nobody can read (a bad day, a word, a bare string, an object with no `on`) is past, never safe.
        assert ids == ON_SALE, ids


def test_a_model_named_directly_is_refused_the_same_day(conn, sc):
    with conn.transaction(force_rollback=True):
        conn.execute("select set_config('request.jwt.claims', '', true)")
        cases = _cases(conn)
        _make_models(conn, cases)
        for mid in cases:
            try:
                with conn.transaction():
                    quote = conn.execute("select public.creative_price(%s, 't2i', %s, %s::jsonb)",
                                         [sc.alice.org, mid, json.dumps({"prompt": "x"})]).fetchone()[0]
                offered = True
            except Exception as e:                      # noqa: BLE001 - the SQLSTATE and text are the assertion
                offered = False
                assert getattr(e, "sqlstate", None) == "NS400" and "model_not_sellable" in str(e), (mid, e)
            assert offered == (mid in ON_SALE), (mid, offered)
            if offered:
                assert quote["model"] == mid and quote["credits"] > 0, quote


def test_the_helper_is_internal_only(conn, sc):
    for who in (sc.alice.actor, ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run("select public.model_past_shutdown('{}'::jsonb)")
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
    with as_superuser(conn, commit=False) as s:
        assert s.value("select public.model_past_shutdown(null)") is False
        assert s.value("select public.model_past_shutdown('{\"shutdown\": null}'::jsonb)") is True


# ── the file itself: order, drift guard, rollback ──────────────────────────────────────

import uuid

import sec_db
from test_sec_api_creative import Db

MIGRATION = sec_db.MIGRATION_0125
ROLLBACK = sec_db.ROLLBACK_0125
M0124 = MIGRATION.with_name("0124_model_switch.sql")
FUNCS = {"sellable_models": "public.sellable_models(text,text)",
         "creative_price": "public.creative_price(uuid,text,text,jsonb)"}


def _md5(d, fn):
    return d.su(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{FUNCS[fn]}'::regprocedure")[0][0]


def _scratch(files):
    admin = sec_db.admin_dsn()
    name = f"ns_shutdown_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    sec_db.apply_files(base, files)
    return admin, name, Db(base)


def test_it_refuses_to_apply_before_0124_and_leaves_nothing_behind():
    admin, name, d = _scratch([f for f in sec_db.build_sequence() if f.name not in (M0124.name, MIGRATION.name)])
    try:
        with pytest.raises(Exception) as cm:
            d.su(MIGRATION.read_text(encoding="utf-8"))
        assert "0125 needs 0124_model_switch.sql" in str(cm.value)
        assert d.su("select to_regprocedure('public.model_past_shutdown(jsonb)') is null")[0][0] is True
    finally:
        sec_db.drop_database(admin, name)


def test_the_drift_guard_refuses_a_body_edited_by_hand_and_a_replay_changes_nothing():
    admin, name, d = _scratch(sec_db.build_sequence())
    try:
        before = {f: _md5(d, f) for f in FUNCS}
        d.su(MIGRATION.read_text(encoding="utf-8"))                       # the replay
        assert {f: _md5(d, f) for f in FUNCS} == before
        fn, sig = "sellable_models", FUNCS["sellable_models"]
        body = d.su(f"select pg_get_functiondef('{sig}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(MIGRATION.read_text(encoding="utf-8"))
        assert f"0125 found a {fn}() that is neither 0124's body nor 0125's" in str(cm.value), str(cm.value)
    finally:
        sec_db.drop_database(admin, name)


def test_the_rollback_puts_0124s_two_bodies_back_byte_for_byte_and_the_file_applies_again():
    admin, name, d = _scratch([f for f in sec_db.build_sequence() if f.name != MIGRATION.name])
    try:
        pre = {f: _md5(d, f) for f in FUNCS}
        d.su(MIGRATION.read_text(encoding="utf-8"))
        assert {f: _md5(d, f) for f in FUNCS} != pre
        d.su(ROLLBACK.read_text(encoding="utf-8"))
        assert {f: _md5(d, f) for f in FUNCS} == pre, "byte for byte"
        assert d.su("select to_regprocedure('public.model_past_shutdown(jsonb)') is null")[0][0] is True
        d.su(MIGRATION.read_text(encoding="utf-8"))                       # and again on the rolled-back database
        assert {f: _md5(d, f) for f in FUNCS} != pre
        # the rollback refuses a body that is neither 0125's nor 0124's
        body = d.su(f"select pg_get_functiondef('{FUNCS['creative_price']}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(ROLLBACK.read_text(encoding="utf-8"))
        assert "rollback 0125 found a creative_price() that is neither 0125's body nor 0124's" in str(cm.value)
    finally:
        sec_db.drop_database(admin, name)


@pytest.mark.parametrize("zone", ["UTC", "Etc/GMT+12", "Pacific/Kiritimati"])
def test_the_shutdown_day_is_the_utc_day_whatever_the_sessions_time_zone(conn, zone):
    """Etc/GMT+12 is UTC-12 (its date can be the UTC date minus one) and Pacific/Kiritimati is UTC+14 (plus one): with current_date the
    boundary day moved with the session; the guard reads the UTC date."""
    with as_superuser(conn, commit=False) as s:
        s.conn.execute("select set_config('TimeZone', %s, true)", [zone])
        utc_today = s.value("select (now() at time zone 'utc')::date")
        for delta, past in ((-1, True), (0, True), (1, False), (2, False)):
            on = s.value("select (%s::date + %s)::text", [utc_today, delta])
            got = s.value("select public.model_past_shutdown(jsonb_build_object('shutdown', jsonb_build_object('on', %s::text)))", [on])
            assert got is past, (zone, delta, on, got)
