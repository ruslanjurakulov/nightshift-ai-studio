"""A quote refuses a clip length the model does not list (migration 0159).

Read from the code on 2026-11-13: creative_params_problem only checks that duration_s is a whole number from 1 to 60, and creative_price
never read the model's spec.durations_s, so a clip of a length the model does not make (Veo 3.1 makes 4, 6 or 8 seconds; the Studio
offered 5 and 10 to every model) was quoted, held and queued, and only the worker refused it ("duration 5s is not offered by veo-3.1").
These tests run the real quote, the real router and the real create on a real Postgres and pin what must hold:

* a length the spec lists is quoted (priced by those seconds); one it does not is refused `invalid_params`, naming the model, the
  length and the capability (the check reads no capability: i2v, sfx and music meet the same lines; test_sec_video_price_variants
  quotes i2v at a listed length);
* an empty list and a spec with no list at all refuse every length;
* the operator's preview is held to the same list;
* Auto (quote_creative_route) picks a model that makes the length, and answers no_model_available when none does;
* create_creative_job refuses the same request: no job row, no hold (customer and operator alike);
* with 0159 rolled back the same create is accepted (the failure this file pins), and every other answer is 0156's.

Every row is made inside a rolled-back transaction. The file-level test (order, drift guard, rollback) runs on a scratch database.
"""

from __future__ import annotations

import json
import uuid

import pytest

import sec_db
from sec_scenario import DEFAULT_ORG
from test_sec_api_creative import Db
from test_sec_operator_preview import _become, _call

EVEN = "lab-even-clip"        # 4, 6, 8 seconds (Veo's list)
ROUND = "lab-round-clip"      # 5, 10 seconds
SILENT = "lab-lengthless"     # an empty list
UNSTATED = "lab-unstated-clip"  # no list at all


def _unit(mid):
    return f"model_{mid.replace('-', '_')}_second"


def _make(conn, mid, *, availability="beta", capabilities=("t2v",), **spec_extra):
    """A clip model on sale the ordinary way (verified, beta, a credit price per second, no plan entitlement)."""
    spec = {"vendor_model": f"{mid}-vendor", "output": "video", "terms_gate": None, "aspect_ratios": ["16:9", "9:16"],
            "pricing": {"unit": "second", "provider_usd_per_unit": 0.05}, **spec_extra}
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, %s, 'lab', 'video.lab', %s, %s::jsonb, %s, null)",
                 [mid, mid, list(capabilities), json.dumps(spec), _unit(mid)])
    conn.execute("select public.record_model_probe(%s, 'video.lab', %s, %s, true, null, null, 900, 1234, 'security-lab')",
                 [mid, spec["vendor_model"], capabilities[0]])
    conn.execute("update public.model_registry set availability = %s where id = %s", [availability, mid])
    conn.execute("insert into public.credit_prices (unit, credits_per_unit) values (%s, 1) on conflict (unit) do nothing", [_unit(mid)])


def _all(conn):
    _make(conn, EVEN, durations_s=[4, 6, 8])
    _make(conn, ROUND, durations_s=[5, 10])
    _make(conn, SILENT, durations_s=[])
    _make(conn, UNSTATED)


def _params(**extra):
    return {"prompt": "a lighthouse at dawn", **extra}


def _quote(conn, who, org, mid, params, cap="t2v"):
    return _call(conn, who, "select public.quote_creative_job(%s, %s, %s, %s::jsonb)", [org, cap, mid, json.dumps(params)])


def _route(conn, who, org, params, cap="t2v"):
    return _call(conn, who, "select public.quote_creative_route(%s, %s, 'auto', %s::jsonb)", [org, cap, json.dumps(params)])


def _create(conn, who, org, mid, params, maxc=1000):
    return _call(conn, who, "select public.create_creative_job(%s, 't2v', %s, %s::jsonb, 'exact', null, %s::numeric)",
                 [org, mid, json.dumps(params), maxc])


def _detail(conn, who, q, params):
    """Run q as ``who`` in a savepoint; the refusal's code and its detail (creative_refuse puts the words in DETAIL), or None."""
    try:
        with conn.transaction():
            _become(conn, who)
            conn.execute(q, params)
            _become(conn, None)
            return None
    except Exception as e:                                      # noqa: BLE001 - the SQLSTATE and text are the assertion
        return getattr(e, "sqlstate", None), str(e).strip().splitlines()[0], getattr(e.diag, "message_detail", None)


def _refused_for_length(conn, who, org, mid, seconds, *, create=False, cap="t2v", params=None):
    p = json.dumps(params if params is not None else _params(duration_s=seconds))
    if create:
        got = _detail(conn, who, "select public.create_creative_job(%s, 't2v', %s, %s::jsonb, 'exact', null, 1000::numeric)",
                      [org, mid, p])
    else:
        got = _detail(conn, who, "select public.quote_creative_job(%s, %s, %s, %s::jsonb)", [org, cap, mid, p])
    return got == ("NS400", "invalid_params", f"{mid} does not offer a {seconds}-second clip for {cap}")


def _customer(conn, sc):
    return sc.alice.actor, sc.alice.org


# ── the quote ──────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_listed_length_is_quoted_by_its_seconds_and_an_unlisted_one_is_refused_naming_it(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        for s in (4, 6, 8):
            state, q = _quote(conn, who, org, EVEN, _params(duration_s=s))
            assert state == "ok" and float(q["quantity"]) == s, (s, q)
        for s in (5, 10, 1, 60):
            assert _refused_for_length(conn, who, org, EVEN, s), s
        # the other model's list is its own
        assert _quote(conn, who, org, ROUND, _params(duration_s=5))[0] == "ok"
        assert _refused_for_length(conn, who, org, ROUND, 6)


def test_an_empty_list_or_no_list_at_all_refuses_every_length(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        for mid in (SILENT, UNSTATED):
            for s in (4, 5, 10):
                assert _refused_for_length(conn, who, org, mid, s), (mid, s)


def test_the_operator_preview_is_held_to_the_same_list(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, EVEN, availability="hidden", durations_s=[4, 6, 8], operator_preview=True)
        conn.execute("delete from public.credit_prices where unit = %s", [_unit(EVEN)])
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, EVEN, _params(duration_s=6))
        assert state == "ok" and q.get("preview") is True, q
        assert _refused_for_length(conn, sc.operator, DEFAULT_ORG, EVEN, 5)


# ── Auto ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_auto_picks_a_model_that_makes_the_length_and_none_when_no_model_does(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        state, q = _route(conn, who, org, _params(duration_s=5))
        assert state == "ok" and q["routed_model"] == ROUND, q
        state, q = _route(conn, who, org, _params(duration_s=6))
        assert state == "ok" and q["routed_model"] == EVEN, q
        state, q = _route(conn, who, org, _params(duration_s=7))
        assert state == "NS400" and "no_model_available" in q, (state, q)


# ── the create: a refused length never becomes a job ─────────────────────────────────────────────────────────────

def _counts(conn):
    return conn.execute("select (select count(*) from public.creative_jobs), (select count(*) from public.credit_transactions)").fetchone()


def test_a_refused_length_never_becomes_a_job_or_a_hold_for_a_customer_or_the_operator(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        before = _counts(conn)
        for actor, o in ((who, org), (sc.operator, DEFAULT_ORG)):
            for mid, s in ((EVEN, 5), (ROUND, 6), (SILENT, 5), (UNSTATED, 5)):
                assert _refused_for_length(conn, actor, o, mid, s, create=True), (actor.name, mid, s)
        assert _counts(conn) == before, "nothing was queued for the worker and nothing was held"
        # the positive control, in the exempt organization (the scenario's tenants are at their parallel-run limit)
        state, out = _create(conn, sc.operator, DEFAULT_ORG, EVEN, _params(duration_s=6))
        assert state == "ok", out
        row = conn.execute("select (params ->> 'duration_s')::int from public.creative_jobs where id = %s", [out["job"]["id"]]).fetchone()
        assert row[0] == 6, row


def test_without_0159_the_same_job_is_queued_and_every_other_answer_is_0156s(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        others = [(who, org, mid, p, cap)
                  for mid in (EVEN, ROUND, SILENT, UNSTATED, "no-such-model", "lab-sold-1")
                  for p, cap in ((_params(duration_s=6), "t2v"), (_params(duration_s=5), "t2v"), (_params(), "t2v"),
                                 (_params(duration_s=0), "t2v"), (_params(duration_s=61), "t2v"), (_params(duration_s="5"), "t2v"),
                                 (_params(duration_s=6, aspect_ratio="4:3"), "t2v"), (_params(), "t2i"),
                                 (_params(duration_s=5), "t2i"))
                  # the requests 0159 refuses (a well-formed length the model does not list) are the `bad` list below
                  if not (cap == "t2v" and isinstance(p.get("duration_s"), int) and 1 <= p["duration_s"] <= 60
                          and mid in (EVEN, ROUND, SILENT, UNSTATED)
                          and p["duration_s"] not in {EVEN: (4, 6, 8), ROUND: (5, 10)}.get(mid, ()))]
        bad = [(who, org, EVEN, _params(duration_s=5), "t2v"), (who, org, SILENT, _params(duration_s=5), "t2v"),
               (who, org, UNSTATED, _params(duration_s=6), "t2v")]
        with_0159 = [_quote(conn, *c) for c in others + bad]
        _become(conn, None)
        conn.execute(sec_db.rollback_0176_body())  # 0176 sits on 0159's creative_price: off first
        conn.execute(sec_db.rollback_0159_body())
        assert sec_db.has_0156(conn)
        without = [_quote(conn, *c) for c in others + bad]
        n = len(others)
        assert with_0159[:n] == without[:n], "every answer without an unlisted length, refusals included, is 0156's"
        assert any(s == "ok" for s, _ in with_0159[:n]), "the positive control"
        assert all(s == "NS400" for s, _ in with_0159[n:]), with_0159[n:]
        # the failure 0159 fixes: under 0156 the length the model cannot make is quoted and queued, and only the worker refuses it
        assert all(s == "ok" for s, _ in without[n:]), without[n:]
        state, out = _create(conn, sc.operator, DEFAULT_ORG, EVEN, _params(duration_s=5))
        assert state == "ok", out
        # (0159 comes back with the rolled-back transaction: re-applying it here would be refused, rightly, while UNSTATED is on sale
        # with no list; test_the_file_refuses_to_apply_while_an_offered_clip_model_states_no_lengths pins that.)


# ── the file itself: order, drift guard, rollback ──────────────────────────────────────────────────────────────────

SIG = "public.creative_price(uuid,text,text,jsonb)"


def _md5(d):
    return d.su(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{SIG}'::regprocedure")[0][0]


def test_the_file_needs_0156_its_guard_refuses_a_hand_edit_and_its_rollback_restores_0156_byte_for_byte(lab):
    admin = sec_db.admin_dsn()
    name = f"ns_length_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        # everything up to 0155, without 0156 (and so without this file)
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0155])
        d = Db(base)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0155
        m0159 = sec_db.MIGRATION_0159.read_text(encoding="utf-8")
        with pytest.raises(Exception) as cm:
            d.su(m0159)
        assert "0159 found a creative_price() that is neither 0156's body nor 0159's" in str(cm.value)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0155, "nothing left behind"
        d.su(sec_db.MIGRATION_0156.read_text(encoding="utf-8"))
        d.su(m0159)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0159
        d.su(m0159)                                                        # the replay
        assert _md5(d) == sec_db.CREATIVE_PRICE_0159
        # 0156's replay and rollback refuse 0159's body: the chain is taken off from the top
        with pytest.raises(Exception) as cm:
            d.su(sec_db.MIGRATION_0156.read_text(encoding="utf-8"))
        assert "0156 found a creative_price() that is neither 0155's body nor 0156's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su(sec_db.ROLLBACK_0156.read_text(encoding="utf-8"))
        assert "rollback 0156 found a creative_price() that is neither 0156's body nor 0155's" in str(cm.value)
        d.su(sec_db.ROLLBACK_0159.read_text(encoding="utf-8"))
        assert _md5(d) == sec_db.CREATIVE_PRICE_0156, "byte for byte"
        d.su(m0159)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0159
        assert d.su("select has_function_privilege('authenticated', %s, 'EXECUTE') or has_function_privilege('service_role', %s, 'EXECUTE') "
                    "or has_function_privilege('anon', %s, 'EXECUTE')", [SIG, SIG, SIG]) == [(False,)]
        body = d.su(f"select pg_get_functiondef('{SIG}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(m0159)
        assert "0159 found a creative_price() that is neither 0156's body nor 0159's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su(sec_db.ROLLBACK_0159.read_text(encoding="utf-8"))
        assert "rollback 0159 found a creative_price() that is neither 0159's body nor 0156's" in str(cm.value)
    finally:
        sec_db.drop_database(admin, name)


def test_the_file_refuses_to_apply_while_an_offered_clip_model_states_no_lengths(lab):
    # A spec synced before durations_s was copied would be refused every length the moment 0159 applies: the file names the model and
    # the fix (a sync) instead of quietly taking a model off sale.
    admin = sec_db.admin_dsn()
    name = f"ns_length_stale_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0156])
        d = Db(base)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0156
        spec = {"vendor_model": "stale-v", "output": "video", "terms_gate": None, "pricing": {"unit": "second", "provider_usd_per_unit": 0.05}}
        d.su("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit) "
             "values ('lab-stale-clip', 'stale', 'lab', 'video.lab', array['t2v'], %s::jsonb, 'model_lab_stale_clip_second')", [json.dumps(spec)])
        d.su("select public.record_model_probe('lab-stale-clip', 'video.lab', 'stale-v', 't2v', true, null, null, 900, 1234, 'security-lab')")
        d.su("update public.model_registry set availability = 'beta' where id = 'lab-stale-clip'")
        m0159 = sec_db.MIGRATION_0159.read_text(encoding="utf-8")
        with pytest.raises(Exception) as cm:
            d.su(m0159)
        assert "lab-stale-clip" in str(cm.value) and "--sync first" in str(cm.value)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0156, "nothing applied"
        # once the spec states its list (what a sync copies), the file applies
        d.su("update public.model_registry set spec = spec || '{\"durations_s\": [5, 10]}'::jsonb where id = 'lab-stale-clip'")
        d.su(m0159)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0159
    finally:
        sec_db.drop_database(admin, name)
