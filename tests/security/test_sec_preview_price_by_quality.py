"""An operator preview of a model priced by quality is quoted at that tier's vendor cost (migration 0153).

0139 let the platform operator try a hidden model in the operator's own credits-exempt organization, quoted at the vendor's cost when
no credit price exists, from one flat figure; 0149 added the quoted resolution's figure. An image model priced by quality tier (the
OpenAI GPT Image entries) still had no figure a preview could read, so every preview quote of it was refused `unpriced`. 0153 takes the
figure of the tier the quote is for. These tests run the real quote and the real create on a real Postgres and pin what must hold:

* low, medium and high quote their own three vendor costs, and the quote names the tier;
* no tier named = medium (the tier every quote settles on), and the job carries it (what the worker sends);
* a tier the model does not offer is refused `invalid_params`, and no tier on a model that does not offer medium too: never mapped;
* a listed tier without a usable figure of its own is refused `unpriced`: never another tier's figure, never provider_usd_per_unit;
* everyone 0139's rule refuses (a member who is not a platform admin, the operator in a customer's organization, a customer, a model
  that is not hidden or not marked) still gets no preview price at all;
* a model on sale is never quoted at vendor cost, and a credit_prices row for the tier still wins;
* with 0153 rolled back, only the by-quality preview answers change.

Every row is made inside a rolled-back transaction. The file-level test (order, drift guard, rollback) runs on a scratch database.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest

import sec_db
from sec_scenario import DEFAULT_ORG, MODEL_SOLD
from test_sec_api_creative import Db
from test_sec_operator_preview import _become, _call, _minimum, _operator_joins

FLARE = "lab-image-flare"
TIERS = ("low", "medium", "high")
#: Lab figures, not a vendor's: three different numbers so a tier read as another tier shows.
FIGURES = {"low": 0.02, "medium": 0.07, "high": 0.19}
#: A flat figure next to the variants, so a fall back to provider_usd_per_unit would show as 5 credits.
QUALITY_PRICING = {"unit": "image", "provider_usd_per_unit": 0.05, "variants": {"by": "quality", "prices": dict(FIGURES)}}


def _unit(mid):
    return f"model_{mid.replace('-', '_')}_image"


def _make(conn, mid=FLARE, *, availability="hidden", pricing=QUALITY_PRICING, qualities=TIERS,
          entitlement="models_image:premium", **extra):
    """An image model the way the registry file ships GPT Image 2.5 Flare: hidden, unpriced, priced by quality, low/medium/high, and
    (for these tests) marked operator_preview with a figure per tier. Anything can be overridden."""
    spec = {"vendor_model": f"{mid}-vendor", "output": "image", "operator_preview": True, "terms_gate": None,
            "qualities": list(qualities), "pricing": pricing, **extra}
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, %s, 'lab', 'image.openai', array['t2i'], %s::jsonb, %s, %s)",
                 [mid, mid, json.dumps(spec), _unit(mid), entitlement])
    conn.execute("select public.record_model_probe(%s, 'image.openai', %s, 't2i', true, null, null, 900, 1234, 'security-lab')",
                 [mid, spec["vendor_model"]])
    if availability != "hidden":
        conn.execute("update public.model_registry set availability = %s where id = %s", [availability, mid])


def _params(**extra):
    return {"prompt": "a lighthouse at dawn", **extra}


def _quote(conn, who, org, mid, params):
    return _call(conn, who, "select public.quote_creative_job(%s, 't2i', %s, %s::jsonb)", [org, mid, json.dumps(params)])


def _create(conn, who, org, mid, params, maxc=1000):
    return _call(conn, who, "select public.create_creative_job(%s, 't2i', %s, %s::jsonb, 'exact', null, %s::numeric)",
                 [org, mid, json.dumps(params), maxc])


def _ok(conn, sc, mid, params):
    state, q = _quote(conn, sc.operator, DEFAULT_ORG, mid, params)
    assert state == "ok", (params, q)
    return q


# ── the preview rate is the chosen tier's ──────────────────────────────────────────────────────────────────────────

def test_low_medium_and_high_quote_their_own_three_vendor_costs(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        got = {t: _ok(conn, sc, FLARE, _params(quality=t)) for t in TIERS}
        for t, q in got.items():
            # the tier's USD figure x 100 credits per USD, no margin; one image, rounded up, floored at job_minimum like every quote
            want = round(FIGURES[t] * 100, 6)
            assert (float(q["credits_per_unit"]), q["unit"], q["quality"]) == (want, _unit(FLARE) + "_" + t, t), q
            assert float(q["credits"]) == max(want, _minimum(conn)), q
            assert q["preview"] is True and q["exempt"] is True, q
            # never the flat provider_usd_per_unit (5 credits) that sits next to the variants
            assert float(q["credits_per_unit"]) != 5.0
        assert len({float(q["credits_per_unit"]) for q in got.values()}) == 3, "three tiers, three figures"
        # the quote wrote no price: nothing is on sale because the operator looked
        assert conn.execute("select count(*) from public.credit_prices where unit like %s",
                            [_unit(FLARE).replace("_", "\\_") + "%"]).fetchone()[0] == 0


def test_no_tier_named_is_medium_and_the_job_carries_it_and_holds_nothing(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        q = _ok(conn, sc, FLARE, _params())
        assert (float(q["credits_per_unit"]), q["quality"], q["unit"]) == (7.0, "medium", _unit(FLARE) + "_medium"), q
        before = conn.execute("select count(*) from public.credit_transactions").fetchone()[0]
        state, out = _create(conn, sc.operator, DEFAULT_ORG, FLARE, _params())
        assert state == "ok", out
        row = conn.execute("select params ->> 'quality', quoted_credits, credit_ref from public.creative_jobs where id = %s",
                           [out["job"]["id"]]).fetchone()
        # what was priced is what the worker sends; the exempt organization holds nothing
        assert row[0] == "medium" and float(row[1]) == float(q["credits"]) and row[2] is None, row
        assert conn.execute("select count(*) from public.credit_transactions").fetchone()[0] == before


def test_a_named_tier_is_the_tier_the_job_carries(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        q = _ok(conn, sc, FLARE, _params(quality="high"))
        state, out = _create(conn, sc.operator, DEFAULT_ORG, FLARE, _params(quality="high"))
        assert state == "ok", out
        row = conn.execute("select params ->> 'quality', quoted_credits from public.creative_jobs where id = %s",
                           [out["job"]["id"]]).fetchone()
        assert row[0] == "high" and float(row[1]) == float(q["credits"]) == max(19.0, _minimum(conn)), row


@pytest.mark.parametrize("tier", ["ultra", "auto", "Medium", "", "xhigh"])
def test_a_tier_the_model_does_not_offer_is_refused_not_mapped(conn, sc, tier):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        got = _quote(conn, sc.operator, DEFAULT_ORG, FLARE, _params(quality=tier))
        assert got[0] == "NS400" and got[1] == "invalid_params", (tier, got)


def test_a_listed_tier_the_model_does_not_offer_is_refused_even_with_a_figure(conn, sc):
    # high has a figure in the table, but the model offers only low and medium: the tier list decides, not the price table
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, qualities=("low", "medium"))
        got = _quote(conn, sc.operator, DEFAULT_ORG, FLARE, _params(quality="high"))
        assert got[:2] == ("NS400", "invalid_params"), got


def test_no_tier_on_a_model_that_does_not_offer_medium_is_refused_never_given_another_tier(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, qualities=("low", "high"))
        got = _quote(conn, sc.operator, DEFAULT_ORG, FLARE, _params())
        assert got[:2] == ("NS400", "invalid_params"), got
        # a named tier it offers is still quoted at its own figure
        assert float(_ok(conn, sc, FLARE, _params(quality="low"))["credits_per_unit"]) == 2.0


@pytest.mark.parametrize("figure", [None, "0.07", 0, -1, 1000, [0.07], {"usd": 0.07}, True])
def test_a_listed_tier_without_a_usable_figure_of_its_own_is_unpriced(conn, sc, figure):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": 0.05,
                             "variants": {"by": "quality", "prices": {"low": 0.02, "medium": figure, "high": 0.19}}})
        for params in (_params(quality="medium"), _params()):
            got = _quote(conn, sc.operator, DEFAULT_ORG, FLARE, params)
            assert got[:2] == ("NS400", "unpriced"), (figure, params, got)
        # the others are still quoted at their own figure
        assert float(_ok(conn, sc, FLARE, _params(quality="low"))["credits_per_unit"]) == 2.0


def test_a_tier_missing_from_the_price_table_is_unpriced_not_the_flat_figure(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": 0.05, "variants": {"by": "quality", "prices": {"low": 0.02}}})
        for params in (_params(quality="high"), _params()):
            assert _quote(conn, sc.operator, DEFAULT_ORG, FLARE, params)[:2] == ("NS400", "unpriced"), params


@pytest.mark.parametrize("prices", [[0.02, 0.07, 0.19], "0.07", 0.07, None])
def test_a_price_table_that_is_not_an_object_is_unpriced(conn, sc, prices):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": 0.05, "variants": {"by": "quality", "prices": prices}})
        assert _quote(conn, sc.operator, DEFAULT_ORG, FLARE, _params())[:2] == ("NS400", "unpriced"), prices


def test_the_unknown_figures_of_the_shipped_registry_entries_stay_unpriced(conn, sc):
    # The GPT Image 2.5 entries ship {"low": null, "medium": null, "high": null}: marking one would be a dead end, never a guess.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": None,
                             "variants": {"by": "quality", "prices": {t: None for t in TIERS}}})
        for params in (_params(), *(_params(quality=t) for t in TIERS)):
            assert _quote(conn, sc.operator, DEFAULT_ORG, FLARE, params)[:2] == ("NS400", "unpriced"), params


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
            for tier in ("high", None):
                params = _params() if tier is None else _params(quality=tier)
                got = _quote(conn, who, org, FLARE, params)
                assert got[:2] == ("NS400", "model_not_sellable"), (who.name, org, tier, got)
                # a create is refused too (a member who may not create at all is refused before the model is read)
                got = _create(conn, who, org, FLARE, params)
                assert got[:2] in (("NS400", "model_not_sellable"), ("42501", "forbidden")), (who.name, org, tier, got)


@pytest.mark.parametrize("variant", [
    {"availability": "disabled"},          # the owner's off
    {"operator_preview": "true"},          # not the JSON value true
    {"operator_preview": False},
])
def test_a_model_that_is_not_a_hidden_marked_preview_gets_no_preview_price(conn, sc, variant):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, **variant)
        got = _quote(conn, sc.operator, DEFAULT_ORG, FLARE, _params(quality="low"))
        assert got[:2] == ("NS400", "model_not_sellable"), (variant, got)


def test_a_model_on_sale_is_never_quoted_at_vendor_cost(conn, sc):
    # beta, no credit price: the operator's own organization is answered like everyone, unpriced. The vendor figure is for a preview only.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, availability="beta", entitlement=None)
        for who, org in ((sc.operator, DEFAULT_ORG), (sc.alice.actor, sc.alice.org)):
            for params in (_params(quality="low"), _params()):
                got = _quote(conn, who, org, FLARE, params)
                assert got[:2] == ("NS400", "unpriced"), (who.name, params, got)


def test_a_credit_price_for_the_tier_still_wins(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 9, 0.5)", [_unit(FLARE) + "_high"])
        q = _ok(conn, sc, FLARE, _params(quality="high"))
        assert float(q["credits_per_unit"]) == 13.5 and q["preview"] is True and q["quality"] == "high", q
        # medium has no row of its own: its vendor figure, never the high row's rate
        assert float(_ok(conn, sc, FLARE, _params())["credits_per_unit"]) == 7.0


def test_a_quality_table_on_a_video_model_is_still_unpriced(conn, sc):
    # The tier is settled for t2i and edit only (0060): a video entry that says "by quality" gets no tier, so no figure.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        mid = "lab-video-by-quality"
        spec = {"vendor_model": "v", "output": "video", "operator_preview": True, "terms_gate": None, "durations_s": [4],
                "pricing": {"unit": "second", "provider_usd_per_unit": 0.05, "variants": {"by": "quality", "prices": {"medium": 0.05}}}}
        conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                     "values (%s, %s, 'lab', 'video.lab', array['t2v'], %s::jsonb, %s, null)",
                     [mid, mid, json.dumps(spec), f"model_{mid.replace('-', '_')}_second"])
        conn.execute("select public.record_model_probe(%s, 'video.lab', 'v', 't2v', true, null, null, 900, 1234, 'security-lab')", [mid])
        got = _call(conn, sc.operator, "select public.quote_creative_job(%s, 't2v', %s, %s::jsonb)",
                    [DEFAULT_ORG, mid, json.dumps({"prompt": "a lighthouse at dawn", "duration_s": 4})])
        assert got[:2] == ("NS400", "unpriced"), got


def test_with_0153_rolled_back_only_the_by_quality_preview_changes(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        _make(conn, "lab-flat-image", pricing={"unit": "image", "provider_usd_per_unit": 0.03}, qualities=())
        _operator_joins(conn, sc, sc.alice.org)
        others = [(who, org, mid, params)
                  for who, org in ((sc.alice.actor, sc.alice.org), (sc.operator, sc.alice.org), (sc.dana, DEFAULT_ORG),
                                   (sc.operator, DEFAULT_ORG))
                  for mid, params in ((FLARE, _params(quality="ultra")), ("lab-flat-image", _params()), (MODEL_SOLD, _params()),
                                      ("no-such-model", _params()))]
        others += [(who, org, FLARE, _params(quality="low"))
                   for who, org in ((sc.alice.actor, sc.alice.org), (sc.operator, sc.alice.org), (sc.dana, DEFAULT_ORG))]
        ours = [(sc.operator, DEFAULT_ORG, FLARE, p) for p in (_params(), *(_params(quality=t) for t in TIERS))]
        # This measures 0153's own body: 0155 (which sits on it) comes off first.
        _become(conn, None)
        conn.execute(sec_db.rollback_0159_body())  # 0159 sits on 0156's creative_price: off first
        conn.execute(sec_db.rollback_0156_body())  # 0156 sits on 0155's creative_price: off first
        conn.execute(sec_db.rollback_0155_body())
        with_0153 = [_quote(conn, *c) for c in others + ours]
        _become(conn, None)
        conn.execute(sec_db.rollback_0153_body())
        without = [_quote(conn, *c) for c in others + ours]
        n = len(others)
        assert with_0153[:n] == without[:n], "every other answer, refusals included, is 0149's"
        assert any(s == "ok" for s, _ in with_0153[:n]), "the positive control: a flat-figure preview and a model on sale are quoted"
        assert all(s == "ok" for s, _ in with_0153[n:]), with_0153[n:]
        assert all(v[:2] == ("NS400", "unpriced") for v in without[n:]), without[n:]


def test_the_lab_takes_the_whole_chain_off_and_puts_it_back_from_0153s_body(conn, sc):
    # take_off_0139 used to look for 0149's hash only: on a database with 0153 it skipped 0149 and 0139's rollback refused the body.
    session = SimpleNamespace(conn=conn)
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        # The lab's database ends at 0155, which sits on 0153's body: start from 0153's own.
        sec_db.take_off_0155(session)
        assert sec_db.has_0153(conn) and not sec_db.has_0149(conn)
        sec_db.take_off_0139(session)
        assert _md5_conn(conn) == "e0c4a7806642086398558cf322c95a0d", "0125's body"
        sec_db.put_back_0139(session)
        # put_back_0153 puts 0155 (and 0156 on it, 0159 on that, 0208 on that and 0218 on that) back with it: the whole chain, as the
        # lab was built
        assert _md5_conn(conn) == sec_db.CREATIVE_PRICE_0218


def _md5_conn(conn):
    return conn.execute("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc "
                        "where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure").fetchone()[0]


# ── the file itself: order, drift guard, rollback ──────────────────────────────────────────────────────────────────

SIG = "public.creative_price(uuid,text,text,jsonb)"
MD5_0139 = "ae28b700503542701ee0ac63a67df36e"


def _md5(d):
    return d.su(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{SIG}'::regprocedure")[0][0]


def test_the_file_needs_0149_its_guard_refuses_a_hand_edit_and_its_rollback_restores_0149_byte_for_byte(lab):
    admin = sec_db.admin_dsn()
    name = f"ns_preview_q_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        # everything up to 0139, without 0149 (and so without this file)
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0139])
        d = Db(base)
        assert _md5(d) == MD5_0139
        m0153 = sec_db.MIGRATION_0153.read_text(encoding="utf-8")
        with pytest.raises(Exception) as cm:
            d.su(m0153)
        assert "0153 found a creative_price() that is neither 0149's body nor 0153's" in str(cm.value)
        assert _md5(d) == MD5_0139, "nothing left behind"
        d.su(sec_db.MIGRATION_0149.read_text(encoding="utf-8"))
        assert _md5(d) == sec_db.CREATIVE_PRICE_0149
        d.su(m0153)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0153
        d.su(m0153)                                                        # the replay
        assert _md5(d) == sec_db.CREATIVE_PRICE_0153
        # 0149's replay and rollback refuse 0153's body: the chain is taken off from the top
        with pytest.raises(Exception) as cm:
            d.su(sec_db.MIGRATION_0149.read_text(encoding="utf-8"))
        assert "0149 found a creative_price() that is neither 0139's body nor 0149's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su(sec_db.ROLLBACK_0149.read_text(encoding="utf-8"))
        assert "rollback 0149 found a creative_price() that is neither 0149's body nor 0139's" in str(cm.value)
        d.su(sec_db.ROLLBACK_0153.read_text(encoding="utf-8"))
        assert _md5(d) == sec_db.CREATIVE_PRICE_0149, "byte for byte"
        d.su(sec_db.ROLLBACK_0149.read_text(encoding="utf-8"))
        assert _md5(d) == MD5_0139
        d.su(sec_db.MIGRATION_0149.read_text(encoding="utf-8"))
        d.su(m0153)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0153
        assert d.su("select has_function_privilege('authenticated', %s, 'EXECUTE') or has_function_privilege('service_role', %s, 'EXECUTE')",
                    [SIG, SIG]) == [(False,)]
        body = d.su(f"select pg_get_functiondef('{SIG}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(m0153)
        assert "0153 found a creative_price() that is neither 0149's body nor 0153's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su(sec_db.ROLLBACK_0153.read_text(encoding="utf-8"))
        assert "rollback 0153 found a creative_price() that is neither 0153's body nor 0149's" in str(cm.value)
    finally:
        sec_db.drop_database(admin, name)
