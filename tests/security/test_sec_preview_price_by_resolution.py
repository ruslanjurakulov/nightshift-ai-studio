"""An operator preview of a model priced by resolution is quoted at that resolution's vendor cost (migration 0149).

0139 let the platform operator try a hidden model in the operator's own credits-exempt organization, quoted at the vendor's cost when
no credit price exists, but only for a model with ONE flat figure: every MiniMax H3 entry is priced by resolution, so every preview
quote of it was refused `unpriced`. 0149 takes the figure of the resolution the quote is for. These tests run the real quote and the
real create on a real Postgres and pin what must hold:

* 480p and 768p of an H3 Lite-shaped model quote their own two vendor costs, and the quote names the resolution;
* no resolution named = the model's pinned default_resolution, and the job carries it (what the worker sends);
* a request that NAMES 768p or 2k reaches its own figure. Until 0156 creative_params_problem (0126's) accepted only 480p 540p 720p
  1080p 1440p 2160p and refused both before any model was read; this was pinned here as a strict xfail, and 0156 closed it
  (tests/security/test_sec_named_resolution_params.py has the rest);
* a resolution the model does not list is refused `invalid_params`, and a listed one without its own figure `unpriced`: never mapped
  to another resolution's figure, never to provider_usd_per_unit;
* everyone 0139's rule refuses (a member who is not a platform admin, the operator in a customer's organization, a customer, a model
  that is not hidden or not marked) still gets no preview price at all;
* a model on sale is never quoted at vendor cost, and a credit_prices row for the variant still wins;
* any other variants.by (audio, resolution_audio, resolution with no pinned default) stays unpriced;
* with 0149 rolled back, only the by-resolution preview answers change.

Every row is made inside a rolled-back transaction. The file-level test (order, drift guard, rollback) runs on a scratch database.
"""

from __future__ import annotations

import json
import uuid

import pytest

import sec_db
from sec_scenario import DEFAULT_ORG, MODEL_SOLD
from test_sec_api_creative import Db
from test_sec_operator_preview import _become, _call, _minimum, _operator_joins

LITE = "lab-h3-lite"
SECONDS = 4
LITE_PRICING = {"unit": "second", "provider_usd_per_unit": 0.04,
                "variants": {"by": "resolution", "prices": {"480p": 0.025, "768p": 0.04}}}


def _unit(mid):
    return f"model_{mid.replace('-', '_')}_second"


def _make(conn, mid=LITE, *, availability="hidden", pricing=LITE_PRICING, resolutions=("480p", "768p"), default="768p",
          entitlement="models_video:basic", **extra):
    """A video model the way the registry file ships MiniMax H3 Lite: hidden, terms gate cleared, unpriced, marked operator_preview,
    priced by resolution with 768p pinned. Anything can be overridden."""
    spec = {"vendor_model": f"{mid}-vendor", "output": "video", "operator_preview": True, "terms_gate": None,
            "resolutions": list(resolutions), "durations_s": [SECONDS], "audio_out": True, "end_frame": True,
            "pricing": pricing, **extra}
    if default is not None:
        spec["default_resolution"] = default
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, %s, 'lab', 'video.lab', array['t2v'], %s::jsonb, %s, %s)",
                 [mid, mid, json.dumps(spec), _unit(mid), entitlement])
    conn.execute("select public.record_model_probe(%s, 'video.lab', %s, 't2v', true, null, null, 900, 1234, 'security-lab')",
                 [mid, spec["vendor_model"]])
    if availability != "hidden":
        conn.execute("update public.model_registry set availability = %s where id = %s", [availability, mid])


def _params(**extra):
    return {"prompt": "a lighthouse at dawn", "duration_s": SECONDS, **extra}


def _quote(conn, who, org, mid, params):
    return _call(conn, who, "select public.quote_creative_job(%s, 't2v', %s, %s::jsonb)", [org, mid, json.dumps(params)])


def _create(conn, who, org, mid, params, maxc=1000):
    return _call(conn, who, "select public.create_creative_job(%s, 't2v', %s, %s::jsonb, 'exact', null, %s::numeric)",
                 [org, mid, json.dumps(params), maxc])


def _ok(conn, sc, mid, params):
    state, q = _quote(conn, sc.operator, DEFAULT_ORG, mid, params)
    assert state == "ok", (params, q)
    return q


# ── the preview rate is the chosen resolution's ────────────────────────────────────────────────────────────────────

def test_480p_and_768p_of_h3_lite_quote_their_own_two_vendor_costs(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        low = _ok(conn, sc, LITE, _params(resolution="480p"))
        high = _ok(conn, sc, LITE, _params())              # 768p, the pinned default (a NAMED 768p: below)
        # 0.025 and 0.04 USD a second x 100 credits per USD, no margin; 4 seconds, rounded up, floored at job_minimum like every quote.
        assert (float(low["credits_per_unit"]), low["unit"], low["resolution"]) == (2.5, _unit(LITE) + "_480p", "480p"), low
        assert (float(high["credits_per_unit"]), high["unit"], high["resolution"]) == (4.0, _unit(LITE) + "_768p", "768p"), high
        assert float(low["credits"]) == max(10.0, _minimum(conn)) and float(high["credits"]) == max(16.0, _minimum(conn))
        assert low["preview"] is True and high["preview"] is True and low["exempt"] is True
        # never provider_usd_per_unit for 480p (that is 768p's figure)
        assert float(low["credits_per_unit"]) != 4.0
        # the quote wrote no price: nothing is on sale because the operator looked
        assert conn.execute("select count(*) from public.credit_prices where unit like %s",
                            [_unit(LITE).replace("_", "\\_") + "%"]).fetchone()[0] == 0


# Was a strict xfail (0126's closed list refused both names before the model was read); 0156 accepts a model's own names.
@pytest.mark.parametrize("res,cost", [("768p", 8.0), ("2k", 13.0)])
def test_a_named_768p_or_2k_reaches_its_own_figure(conn, sc, res, cost):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, "lab-h3", resolutions=("768p", "2k"),
              pricing={"unit": "second", "provider_usd_per_unit": 0.08,
                       "variants": {"by": "resolution", "prices": {"768p": 0.08, "2k": 0.13}}})
        q = _ok(conn, sc, "lab-h3", _params(resolution=res))
        assert (float(q["credits_per_unit"]), q["resolution"]) == (cost, res), q


def test_h3_without_a_named_resolution_is_its_768p_figure_never_2ks(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, "lab-h3", resolutions=("768p", "2k"),
              pricing={"unit": "second", "provider_usd_per_unit": 0.08,
                       "variants": {"by": "resolution", "prices": {"768p": 0.08, "2k": 0.13}}})
        q = _ok(conn, sc, "lab-h3", _params())
        assert (float(q["credits_per_unit"]), q["resolution"]) == (8.0, "768p"), q


def test_no_resolution_named_is_the_pinned_default_and_the_job_carries_it(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        q = _ok(conn, sc, LITE, _params())
        assert (float(q["credits_per_unit"]), q["resolution"], q["unit"]) == (4.0, "768p", _unit(LITE) + "_768p"), q
        before = conn.execute("select count(*) from public.credit_transactions").fetchone()[0]
        state, out = _create(conn, sc.operator, DEFAULT_ORG, LITE, _params())
        assert state == "ok", out
        row = conn.execute("select params ->> 'resolution', quoted_credits, credit_ref from public.creative_jobs where id = %s",
                           [out["job"]["id"]]).fetchone()
        # what was priced is what the worker sends; the exempt organization holds nothing
        assert row[0] == "768p" and float(row[1]) == float(q["credits"]) and row[2] is None, row
        assert conn.execute("select count(*) from public.credit_transactions").fetchone()[0] == before


@pytest.mark.parametrize("res", ["1080p", "720p", "2k", "768P", ""])
def test_a_resolution_the_model_does_not_list_is_refused_not_mapped(conn, sc, res):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        got = _quote(conn, sc.operator, DEFAULT_ORG, LITE, _params(resolution=res))
        assert got[0] == "NS400" and got[1] == "invalid_params", (res, got)


@pytest.mark.parametrize("figure", [None, "0.04", 0, -1, 1000, [0.04], {"usd": 0.04}])
def test_a_listed_resolution_without_a_usable_figure_of_its_own_is_unpriced(conn, sc, figure):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, resolutions=("480p", "768p", "1080p"),
              pricing={"unit": "second", "provider_usd_per_unit": 0.04,
                       "variants": {"by": "resolution", "prices": {"480p": 0.025, "768p": 0.04, "1080p": figure}}})
        got = _quote(conn, sc.operator, DEFAULT_ORG, LITE, _params(resolution="1080p"))
        assert got[:2] == ("NS400", "unpriced"), (figure, got)
        # the others are still quoted at their own figure
        assert float(_ok(conn, sc, LITE, _params(resolution="480p"))["credits_per_unit"]) == 2.5


def test_a_resolution_missing_from_the_price_table_is_unpriced_not_the_base_figure(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, resolutions=("480p", "768p", "1080p"))         # 1080p listed, no price for it at all
        got = _quote(conn, sc.operator, DEFAULT_ORG, LITE, _params(resolution="1080p"))
        assert got[:2] == ("NS400", "unpriced"), got


def test_a_price_table_that_is_not_an_object_is_unpriced(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "second", "provider_usd_per_unit": 0.04, "variants": {"by": "resolution", "prices": [0.025, 0.04]}})
        assert _quote(conn, sc.operator, DEFAULT_ORG, LITE, _params())[:2] == ("NS400", "unpriced")


# ── nobody else gets a preview price ──────────────────────────────────────────────────────────────────────────────

def test_everyone_the_preview_rule_refuses_is_still_refused(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        _operator_joins(conn, sc, sc.alice.org)
        for who, org in ((sc.dana, DEFAULT_ORG),                       # a member of the exempt organization, not a platform admin
                         (sc.operator, sc.alice.org),                  # the operator acting in a customer's organization
                         (sc.alice.actor, sc.alice.org),               # a customer
                         (sc.bob.actor, sc.bob.org)):
            for res in ("480p", None):
                params = _params() if res is None else _params(resolution=res)
                got = _quote(conn, who, org, LITE, params)
                assert got[:2] == ("NS400", "model_not_sellable"), (who.name, org, res, got)


@pytest.mark.parametrize("variant", [
    {"availability": "disabled"},          # the owner's off
    {"operator_preview": "true"},          # not the JSON value true
    {"operator_preview": False},
])
def test_a_model_that_is_not_a_hidden_marked_preview_gets_no_preview_price(conn, sc, variant):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, **variant)
        got = _quote(conn, sc.operator, DEFAULT_ORG, LITE, _params(resolution="480p"))
        assert got[:2] == ("NS400", "model_not_sellable"), (variant, got)


def test_a_model_on_sale_is_never_quoted_at_vendor_cost(conn, sc):
    # beta, no credit price: the operator's own organization is answered like everyone, unpriced. The vendor figure is for a preview only.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, availability="beta", entitlement=None)
        for who, org in ((sc.operator, DEFAULT_ORG), (sc.alice.actor, sc.alice.org)):
            got = _quote(conn, who, org, LITE, _params(resolution="480p"))
            assert got[:2] == ("NS400", "unpriced"), (who.name, got)


def test_a_credit_price_for_the_variant_still_wins(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 7, 0.5)", [_unit(LITE) + "_480p"])
        q = _ok(conn, sc, LITE, _params(resolution="480p"))
        assert float(q["credits_per_unit"]) == 10.5 and q["preview"] is True, q
        # 768p has no row of its own: its vendor figure, never the 480p row's rate
        assert float(_ok(conn, sc, LITE, _params())["credits_per_unit"]) == 4.0


@pytest.mark.parametrize("pricing,default", [
    ({"unit": "second", "provider_usd_per_unit": 0.04, "variants": {"by": "audio", "prices": {"silent": 0.04, "audio": 0.05}}}, None),
    ({"unit": "second", "provider_usd_per_unit": 0.04,
      "variants": {"by": "resolution_audio", "prices": {"480p_silent": 0.025, "768p_silent": 0.04, "480p_audio": 0.03,
                                                         "768p_audio": 0.05}}}, "768p"),
    # priced by resolution but no resolution pinned (the way 0070 sells Veo by its base row): no variant, so no figure to take
    ({"unit": "second", "provider_usd_per_unit": 0.04, "variants": {"by": "resolution", "prices": {"480p": 0.025, "768p": 0.04}}}, None),
    ({"unit": "second", "provider_usd_per_unit": 0.04, "variants": {"by": "quality", "prices": {"480p": 0.025}}}, None),
])
def test_any_other_kind_of_variant_stays_unpriced(conn, sc, pricing, default):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing=pricing, default=default)
        for params in (_params(), _params(resolution="480p")):
            got = _quote(conn, sc.operator, DEFAULT_ORG, LITE, params)
            assert got[:2] == ("NS400", "unpriced"), (pricing["variants"]["by"], params, got)


def test_a_flat_figure_preview_is_quoted_as_under_0139(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, "lab-flat-video", pricing={"unit": "second", "provider_usd_per_unit": 0.05}, resolutions=(), default=None)
        q = _ok(conn, sc, "lab-flat-video", _params())
        assert float(q["credits_per_unit"]) == 5.0 and "resolution" not in q and q["preview"] is True, q


def test_with_0149_rolled_back_only_the_by_resolution_preview_changes(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        _make(conn, "lab-flat-video", pricing={"unit": "second", "provider_usd_per_unit": 0.05}, resolutions=(), default=None)
        _operator_joins(conn, sc, sc.alice.org)
        others = [(who, org, mid, params)
                  for who, org in ((sc.alice.actor, sc.alice.org), (sc.operator, sc.alice.org), (sc.dana, DEFAULT_ORG),
                                   (sc.operator, DEFAULT_ORG))
                  for mid, params in ((LITE, _params(resolution="1080p")), ("lab-flat-video", _params()), (MODEL_SOLD, _params()),
                                      ("no-such-model", _params()))]
        others += [(who, org, LITE, _params(resolution="480p"))
                   for who, org in ((sc.alice.actor, sc.alice.org), (sc.operator, sc.alice.org), (sc.dana, DEFAULT_ORG))]
        ours = [(sc.operator, DEFAULT_ORG, LITE, p) for p in (_params(), _params(resolution="480p"))]
        with_0149 = [_quote(conn, *c) for c in others + ours]
        _become(conn, None)
        # 0153 sits on 0149's creative_price, and 0149's rollback refuses any other body: it comes off first (0155, on 0153's, before it).
        conn.execute(sec_db.rollback_0156_body())  # 0156 sits on 0155's creative_price: off first
        conn.execute(sec_db.rollback_0155_body())
        conn.execute(sec_db.rollback_0153_body())
        conn.execute(sec_db.rollback_0149_body())
        without = [_quote(conn, *c) for c in others + ours]
        n = len(others)
        assert with_0149[:n] == without[:n], "every other answer, refusals included, is 0139's"
        assert all(s == "ok" for s, _ in with_0149[n:]), with_0149[n:]
        assert all(v[:2] == ("NS400", "unpriced") for v in without[n:]), without[n:]


# ── the file itself: order, drift guard, rollback ──────────────────────────────────────────────────────────────────

SIG = "public.creative_price(uuid,text,text,jsonb)"
MD5_0125 = "e0c4a7806642086398558cf322c95a0d"
MD5_0139 = "ae28b700503542701ee0ac63a67df36e"


def _md5(d):
    return d.su(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{SIG}'::regprocedure")[0][0]


def test_the_file_needs_0139_its_guard_refuses_a_hand_edit_and_its_rollback_restores_0139_byte_for_byte(lab):
    admin = sec_db.admin_dsn()
    name = f"ns_preview_res_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0125])
        d = Db(base)
        assert _md5(d) == MD5_0125
        m0149 = sec_db.MIGRATION_0149.read_text(encoding="utf-8")
        with pytest.raises(Exception) as cm:
            d.su(m0149)
        assert "0149 needs 0139_operator_preview.sql" in str(cm.value)
        assert _md5(d) == MD5_0125, "nothing left behind"
        d.su(sec_db.MIGRATION_0139.read_text(encoding="utf-8"))
        d.su(m0149)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0149
        d.su(m0149)                                                        # the replay
        assert _md5(d) == sec_db.CREATIVE_PRICE_0149
        # 0139's replay and rollback refuse 0149's body: the chain is taken off from the top
        with pytest.raises(Exception) as cm:
            d.su(sec_db.MIGRATION_0139.read_text(encoding="utf-8"))
        assert "0139 found a creative_price() that is neither 0125's body nor 0139's" in str(cm.value)
        d.su(sec_db.ROLLBACK_0149.read_text(encoding="utf-8"))
        assert _md5(d) == MD5_0139, "byte for byte"
        d.su(sec_db.ROLLBACK_0139.read_text(encoding="utf-8"))
        assert _md5(d) == MD5_0125
        d.su(sec_db.MIGRATION_0139.read_text(encoding="utf-8"))
        d.su(m0149)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0149
        body = d.su(f"select pg_get_functiondef('{SIG}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(m0149)
        assert "0149 found a creative_price() that is neither 0139's body nor 0149's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su(sec_db.ROLLBACK_0149.read_text(encoding="utf-8"))
        assert "rollback 0149 found a creative_price() that is neither 0149's body nor 0139's" in str(cm.value)
    finally:
        sec_db.drop_database(admin, name)
