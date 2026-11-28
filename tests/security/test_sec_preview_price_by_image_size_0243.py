"""An operator preview of a picture model priced by size is quoted at exactly that size's vendor cost (migration 0243).

0139 let the platform operator try a hidden model in the operator's own credits-exempt organization, quoted at the vendor's cost when
no credit price exists; 0149 and 0153 taught that fallback the quoted resolution's and tier's figures. A model priced by picture size
(spec.pricing.variants.by = image_size, which 0208 sells only at a named size) still had no figure the fallback could read, so every
preview quote of it was refused `unpriced` (0238's measurement). 0243 reads the named size's own figure. These tests run the real
quote and the real create on a real Postgres and pin what must hold:

* every size with a figure quotes exactly that figure (x 100 credits, no margin, rounded UP), the quote names the size, the job carries
  it and its quoted credits; a fractional figure is never rounded down;
* a listed size without a usable figure of its own is refused `unpriced`, by name, at the quote AND at the create (no job, no hold):
  never another size's figure, never the largest size's, never provider_usd_per_unit;
* no size named, or a size the model does not list (even one the price table has), is refused `invalid_params` (0208, unchanged);
* everyone 0139's rule refuses still gets no preview price; a model on sale is never quoted at vendor cost; a credit_prices row for
  the size still wins;
* with 0243 rolled back, only the by-size preview answers change (every other model, flat, by tier or on sale, is answered the same);
* the shipped Google rows, marked operator_preview, quote each listed size at the registry's own figure (read from the file here);
* the file: its guard refuses a hand-edited body and 0224's (0228 not applied) by name, a replay changes nothing, the rollback puts
  0228's body back byte for byte and is harmless twice.

Every figure here is a lab figure, not a vendor's. Every row is made inside a rolled-back transaction; the file-level test runs on a
scratch database.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest

import sec_db
from sec_scenario import DEFAULT_ORG, MODEL_SOLD
from test_sec_api_creative import Db
from test_sec_operator_preview import _become, _minimum, _operator_joins

SIZED = "lab-image-sized"
SIZES = ("1K", "2K", "4K")
#: Lab figures: 1K and 2K priced, 4K (the largest) deliberately without a figure, and a flat figure next to the variants, so that a
#: fall back to another size, to the largest, or to provider_usd_per_unit would each show as a different number.
FIGURES = {"1K": 0.37, "2K": 0.81}
FLAT = 0.55
SIZE_PRICING = {"unit": "image", "provider_usd_per_unit": FLAT, "variants": {"by": "image_size", "prices": dict(FIGURES)}}


def _unit(mid):
    return f"model_{mid.replace('-', '_').replace('.', '_')}_image"


def _make(conn, mid=SIZED, *, availability="hidden", pricing=SIZE_PRICING, sizes=SIZES, entitlement="models_image:premium", **extra):
    """A picture model the way the registry ships the cleared Google rows: hidden, unpriced, priced by image_size, and (for these
    tests) marked operator_preview. No country list, so a create here does not need the web server's signed country."""
    spec = {"vendor_model": f"{mid}-vendor", "output": "image", "operator_preview": True, "terms_gate": None,
            "image_sizes": list(sizes), "aspect_ratios": ["1:1"], "pricing": pricing, **extra}
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, %s, 'lab', 'image.gemini', array['t2i', 'edit'], %s::jsonb, %s, %s)",
                 [mid, mid, json.dumps(spec), _unit(mid), entitlement])
    conn.execute("select public.record_model_probe(%s, 'image.gemini', %s, 't2i', true, null, null, 900, 1234, 'security-lab')",
                 [mid, spec["vendor_model"]])
    if availability != "hidden":
        conn.execute("update public.model_registry set availability = %s where id = %s", [availability, mid])


def _params(size=None, **extra):
    p = {"prompt": "a lighthouse at dawn", **extra}
    if size is not None:
        p["image_size"] = size
    return p


def _call(conn, who, q, params):
    """Run q as `who` in a savepoint; returns ('ok', value) or (sqlstate, code, detail): the detail is what names the refusal."""
    try:
        with conn.transaction():
            _become(conn, who)
            v = conn.execute(q, params).fetchone()[0]
            _become(conn, None)
            return "ok", v
    except Exception as e:                                      # noqa: BLE001 - the SQLSTATE and text are the assertion
        diag = getattr(e, "diag", None)
        return getattr(e, "sqlstate", None), str(e).strip().splitlines()[0], (diag.message_detail if diag else None)


def _quote(conn, who, org, mid, params):
    return _call(conn, who, "select public.quote_creative_job(%s, 't2i', %s, %s::jsonb)", [org, mid, json.dumps(params)])


def _create(conn, who, org, mid, params, maxc=1000):
    return _call(conn, who, "select public.create_creative_job(%s, 't2i', %s, %s::jsonb, 'exact', null, %s::numeric)",
                 [org, mid, json.dumps(params), maxc])


def _ok(conn, sc, mid, params):
    got = _quote(conn, sc.operator, DEFAULT_ORG, mid, params)
    assert got[0] == "ok", (params, got)
    return got[1]


def _jobs(conn, mid):
    return conn.execute("select count(*) from public.creative_jobs where routed_model = %s or requested_model = %s", [mid, mid]).fetchone()[0]


def _round_up(conn, x):
    return float(conn.execute("select public.credits_round_up(%s::numeric)", [x]).fetchone()[0])


# ── the preview rate is the requested size's, exactly ──────────────────────────────────────────────────────────────

def test_each_size_with_a_figure_quotes_exactly_that_figure_and_names_the_size(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        got = {s: _ok(conn, sc, SIZED, _params(s)) for s in FIGURES}
        for s, q in got.items():
            want = round(FIGURES[s] * 100, 6)
            assert (float(q["credits_per_unit"]), q["unit"], q["image_size"]) == (want, f"{_unit(SIZED)}_{s.lower()}", s), q
            assert float(q["credits"]) == max(want, _minimum(conn)), q
            assert q["preview"] is True and q["exempt"] is True, q
            # never the flat figure that sits next to the variants
            assert float(q["credits_per_unit"]) != FLAT * 100
        assert len({float(q["credits_per_unit"]) for q in got.values()}) == 2, "two sizes, two figures"
        # the quote wrote no price: nothing is on sale because the operator looked
        assert conn.execute("select count(*) from public.credit_prices where unit like %s",
                            [_unit(SIZED).replace("_", "\\_") + "%"]).fetchone()[0] == 0


def test_the_job_carries_the_size_and_the_quoted_credits_and_holds_nothing(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        before = conn.execute("select count(*) from public.credit_transactions").fetchone()[0]
        for s in FIGURES:
            q = _ok(conn, sc, SIZED, _params(s))
            got = _create(conn, sc.operator, DEFAULT_ORG, SIZED, _params(s))
            assert got[0] == "ok", got
            row = conn.execute("select params ->> 'image_size', quoted_credits, credit_ref from public.creative_jobs where id = %s",
                               [got[1]["job"]["id"]]).fetchone()
            # what was priced is what the worker sends; the exempt organization holds nothing
            assert row[0] == s and float(row[1]) == float(q["credits"]) and row[2] is None, row
            assert float(row[1]) >= FIGURES[s] * 100, "never below the size's own figure"
        assert conn.execute("select count(*) from public.credit_transactions").fetchone()[0] == before


def test_a_fractional_figure_is_rounded_up_never_down(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        conn.execute("delete from public.credit_prices where unit = 'job_minimum'")   # so the floor cannot hide the rounding
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": FLAT,
                             "variants": {"by": "image_size", "prices": {"1K": 0.012341, "2K": 0.81}}})
        q = _ok(conn, sc, SIZED, _params("1K"))
        assert float(q["credits"]) == _round_up(conn, 1.2341) and float(q["credits"]) >= 1.2341, q


def test_a_credit_price_for_the_size_still_wins_and_another_sizes_row_never_leaks(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 9, 0.5)", [_unit(SIZED) + "_2k"])
        q = _ok(conn, sc, SIZED, _params("2K"))
        assert float(q["credits_per_unit"]) == 13.5 and q["preview"] is True and q["image_size"] == "2K", q
        # 1K has no row of its own: its own vendor figure, never the 2K row's rate
        assert float(_ok(conn, sc, SIZED, _params("1K"))["credits_per_unit"]) == FIGURES["1K"] * 100
        # 4K has neither: unpriced, never the 2K row and never 2K's figure
        assert _quote(conn, sc.operator, DEFAULT_ORG, SIZED, _params("4K"))[:2] == ("NS400", "unpriced")


# ── a size without its own figure is unpriced, by name, and never another size's ──────────────────────────────────

def test_the_largest_size_without_a_figure_is_unpriced_and_no_job_is_made(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        got = _quote(conn, sc.operator, DEFAULT_ORG, SIZED, _params("4K"))
        assert got[:2] == ("NS400", "unpriced"), got
        assert SIZED in (got[2] or ""), "the refusal names the model"
        before = conn.execute("select count(*) from public.credit_transactions").fetchone()[0]
        got = _create(conn, sc.operator, DEFAULT_ORG, SIZED, _params("4K"))
        assert got[:2] == ("NS400", "unpriced"), got
        assert _jobs(conn, SIZED) == 0
        assert conn.execute("select count(*) from public.credit_transactions").fetchone()[0] == before
        # and with an enormous confirmation too: no figure means no price, whatever the caller is willing to pay
        assert _create(conn, sc.operator, DEFAULT_ORG, SIZED, _params("4K"), maxc=10 ** 9)[:2] == ("NS400", "unpriced")


@pytest.mark.parametrize("figure", [None, "0.37", 0, -1, 1000, [0.37], {"usd": 0.37}, True])
def test_a_listed_size_without_a_usable_figure_of_its_own_is_unpriced(conn, sc, figure):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": FLAT,
                             "variants": {"by": "image_size", "prices": {"1K": figure, "2K": 0.81, "4K": 0.99}}})
        got = _quote(conn, sc.operator, DEFAULT_ORG, SIZED, _params("1K"))
        assert got[:2] == ("NS400", "unpriced"), (figure, got)
        # the others are still quoted at their own figure
        assert float(_ok(conn, sc, SIZED, _params("2K"))["credits_per_unit"]) == 81.0
        assert float(_ok(conn, sc, SIZED, _params("4K"))["credits_per_unit"]) == 99.0


def test_a_size_key_written_another_way_is_not_the_sizes_figure(conn, sc):
    # The key must be the size exactly as image_sizes lists it: "1k" or " 1K" in the table is not 1K's figure.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": FLAT,
                             "variants": {"by": "image_size", "prices": {"1k": 0.37, " 1K": 0.37, "2K": 0.81}}})
        assert _quote(conn, sc.operator, DEFAULT_ORG, SIZED, _params("1K"))[:2] == ("NS400", "unpriced")


@pytest.mark.parametrize("prices", [[0.37, 0.81], "0.37", 0.37, None])
def test_a_price_table_that_is_not_an_object_is_unpriced(conn, sc, prices):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": FLAT, "variants": {"by": "image_size", "prices": prices}})
        for s in SIZES:
            assert _quote(conn, sc.operator, DEFAULT_ORG, SIZED, _params(s))[:2] == ("NS400", "unpriced"), (prices, s)


# ── the size must be named and offered (0208, unchanged) ───────────────────────────────────────────────────────────

def test_no_size_named_is_refused_never_given_a_default_size(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        got = _quote(conn, sc.operator, DEFAULT_ORG, SIZED, _params())
        assert got[:2] == ("NS400", "invalid_params") and "name image_size" in (got[2] or ""), got


@pytest.mark.parametrize("size", ["512", "8K", "1k", "", "2K "])
def test_a_size_the_model_does_not_list_is_refused_even_with_a_figure(conn, sc, size):
    # 512 has a figure in the table, but the model does not list it: the size list decides, not the price table.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, pricing={"unit": "image", "provider_usd_per_unit": FLAT,
                             "variants": {"by": "image_size", "prices": {**FIGURES, "512": 0.05}}})
        got = _quote(conn, sc.operator, DEFAULT_ORG, SIZED, _params(size))
        assert got[:2] == ("NS400", "invalid_params"), (size, got)


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
            for s in SIZES:
                got = _quote(conn, who, org, SIZED, _params(s))
                assert got[:2] == ("NS400", "model_not_sellable"), (who.name, org, s, got)
                got = _create(conn, who, org, SIZED, _params(s))
                assert got[:2] in (("NS400", "model_not_sellable"), ("42501", "forbidden")), (who.name, org, s, got)
        assert _jobs(conn, SIZED) == 0


@pytest.mark.parametrize("variant", [{"availability": "disabled"}, {"operator_preview": "true"}, {"operator_preview": False}])
def test_a_model_that_is_not_a_hidden_marked_preview_gets_no_preview_price(conn, sc, variant):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, **variant)
        got = _quote(conn, sc.operator, DEFAULT_ORG, SIZED, _params("1K"))
        assert got[:2] == ("NS400", "model_not_sellable"), (variant, got)


def test_a_model_on_sale_is_never_quoted_at_vendor_cost(conn, sc):
    # beta, no credit price: the operator's own organization is answered like everyone, unpriced. The figure is for a preview only.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, availability="beta", entitlement=None)
        for who, org in ((sc.operator, DEFAULT_ORG), (sc.alice.actor, sc.alice.org)):
            for s in FIGURES:
                got = _quote(conn, who, org, SIZED, _params(s))
                assert got[:2] == ("NS400", "unpriced"), (who.name, s, got)


# ── only the by-size preview changes ──────────────────────────────────────────────────────────────────────────────

def test_with_0243_rolled_back_only_the_by_size_preview_changes(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn)
        _make(conn, "lab-flat-image", pricing={"unit": "image", "provider_usd_per_unit": 0.03}, sizes=())
        _make(conn, "lab-tier-image", pricing={"unit": "image", "provider_usd_per_unit": 0.03,
                                               "variants": {"by": "quality", "prices": {"low": 0.02, "medium": 0.07}}},
              sizes=(), qualities=["low", "medium"])
        _operator_joins(conn, sc, sc.alice.org)
        others = [(who, org, mid, params)
                  for who, org in ((sc.alice.actor, sc.alice.org), (sc.operator, sc.alice.org), (sc.dana, DEFAULT_ORG),
                                   (sc.operator, DEFAULT_ORG))
                  for mid, params in ((SIZED, _params()), (SIZED, _params("512")), (SIZED, _params("4K")),
                                      ("lab-flat-image", _params()), ("lab-flat-image", _params("1K")),
                                      ("lab-tier-image", _params(quality="low")), ("lab-tier-image", _params()),
                                      (MODEL_SOLD, _params()), ("no-such-model", _params("1K")))]
        others += [(who, org, SIZED, _params(s))
                   for who, org in ((sc.alice.actor, sc.alice.org), (sc.operator, sc.alice.org), (sc.dana, DEFAULT_ORG))
                   for s in FIGURES]
        ours = [(sc.operator, DEFAULT_ORG, SIZED, _params(s)) for s in FIGURES]
        with_0243 = [_quote(conn, *c) for c in others + ours]
        _become(conn, None)
        assert sec_db.has_0243(conn)
        sec_db.take_off_0243(conn)
        assert sec_db.has_0228(conn)
        without = [_quote(conn, *c) for c in others + ours]
        n = len(others)
        assert with_0243[:n] == without[:n], "every other answer, refusals included, is 0228's"
        assert sum(s == "ok" for s, *_ in with_0243[:n]) >= 3, "the positive controls: flat, by tier and on sale are quoted"
        assert all(s == "ok" for s, *_ in with_0243[n:]), with_0243[n:]
        assert all(v[:2] == ("NS400", "unpriced") for v in without[n:]), without[n:]


# ── the shipped Google rows ───────────────────────────────────────────────────────────────────────────────────────

def test_the_shipped_google_rows_quote_each_listed_size_at_the_registrys_own_figure(conn, sc):
    # The figure is read from the registry file here, never written in a test: the repo states none of its own.
    from modules import model_registry as reg

    rows = {r["id"]: r for r in reg.sync_rows(list(reg.load().values()))}
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        for mid in ("gemini-3-pro-image", "gemini-nano-banana-2.1"):
            r = rows[mid]
            assert r["spec"]["operator_preview"] is True and r["spec"]["terms_gate"] is None, mid
            conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, "
                         "entitlement) values (%s, %s, %s, %s, %s, %s::jsonb, %s, %s) on conflict (id) do update set spec = excluded.spec",
                         [r["id"], r["display_name"], r["provider"], r["adapter"], r["capabilities"], json.dumps(r["spec"]),
                          r["credit_unit"], r["entitlement"]])
            conn.execute("select public.record_model_probe(%s, %s, %s, 't2i', true, null, null, 900, 1234, 'security-lab')",
                         [mid, r["adapter"], r["spec"]["vendor_model"]])
            prices = r["spec"]["pricing"]["variants"]["prices"]
            for s in r["spec"]["image_sizes"]:
                q = _ok(conn, sc, mid, _params(s, aspect_ratio="1:1"))
                want = round(prices[s] * 100, 6)
                assert (round(float(q["credits_per_unit"]), 6), q["image_size"], q["preview"]) == (want, s, True), (mid, s, q)
                assert float(q["credits"]) >= want, (mid, s, q)
            # a size Google sells but the row does not list stays refused, never priced
            assert _quote(conn, sc.operator, DEFAULT_ORG, mid, _params("512", aspect_ratio="1:1"))[:2] == ("NS400", "invalid_params")
            # a customer still cannot see it at all
            assert _quote(conn, sc.alice.actor, sc.alice.org, mid, _params("1K", aspect_ratio="1:1"))[0] != "ok"


# ── the file itself: order, drift guard, rollback ──────────────────────────────────────────────────────────────────

SIG = "public.creative_price(uuid,text,text,jsonb)"


def _md5(d):
    return d.su(f"select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = '{SIG}'::regprocedure")[0][0]


def test_the_lab_takes_0243_off_with_the_chain_and_puts_it_back_last(conn, sc):
    session = SimpleNamespace(conn=conn)
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        assert sec_db.has_0243(conn) and sec_db.has_0218(conn) and sec_db.has_0208(conn) and sec_db.has_0159(conn)
        sec_db.take_off_0218(conn)                                      # 0243, 0228, 0224, then 0218 come off
        assert not sec_db.has_0243(conn) and _md5_conn(conn) == sec_db.CREATIVE_PRICE_0208
        sec_db.put_back_0218(conn)
        assert _md5_conn(conn) == sec_db.CREATIVE_PRICE_0243
        sec_db.take_off_0139(session)                                   # the whole preview chain
        assert _md5_conn(conn) == "e0c4a7806642086398558cf322c95a0d", "0125's body"
        sec_db.put_back_0139(session)
        assert _md5_conn(conn) == sec_db.CREATIVE_PRICE_0243
    for name in ("ON_0156", "ON_0139", "ON_0125", "ON_0124"):
        seq = list(getattr(sec_db, name))
        assert seq[-1] == sec_db.MIGRATION_0243.name, name
        assert seq.index("0228_music_per_request_price.sql") < seq.index(sec_db.MIGRATION_0243.name), name


def _md5_conn(conn):
    return conn.execute("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc "
                        "where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure").fetchone()[0]


def test_the_file_needs_0228_its_guard_refuses_a_hand_edit_and_its_rollback_restores_0228_byte_for_byte(lab):
    admin = sec_db.admin_dsn()
    name = f"ns_preview_size_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    mig = sec_db.MIGRATION_0243.read_text(encoding="utf-8")
    rb = sec_db.ROLLBACK_0243.read_text(encoding="utf-8")
    try:
        # everything, without 0228 (and so without this file): creative_price is 0224's
        sec_db.apply_files(base, [f for f in sec_db.build_sequence()
                                  if f.name not in ("0228_music_per_request_price.sql", sec_db.MIGRATION_0243.name)])
        d = Db(base)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0224
        with pytest.raises(Exception) as cm:
            d.su(mig)
        assert "0243 found a creative_price() that is neither 0228's body nor 0243's" in str(cm.value)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0224, "nothing left behind"
        d.su(sec_db.MIGRATION_0228.read_text(encoding="utf-8"))
        assert _md5(d) == sec_db.CREATIVE_PRICE_0228
        d.su(mig)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0243
        d.su(mig)                                                        # the replay
        assert _md5(d) == sec_db.CREATIVE_PRICE_0243
        assert d.su("select has_function_privilege('authenticated', %s, 'EXECUTE') or has_function_privilege('service_role', %s, 'EXECUTE')"
                    " or has_function_privilege('anon', %s, 'EXECUTE')", [SIG, SIG, SIG]) == [(False,)]
        # 0228's replay refuses 0243's body: the chain is taken off from the top
        with pytest.raises(Exception) as cm:
            d.su(sec_db.MIGRATION_0228.read_text(encoding="utf-8"))
        assert "0228 found a creative_price() that is neither" in str(cm.value)
        d.su(rb)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0228, "byte for byte"
        d.su(rb)                                                         # twice: harmless
        assert _md5(d) == sec_db.CREATIVE_PRICE_0228
        d.su(mig)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0243
        # A hand edit (a drifted live body): the file refuses it by name and leaves it; the rollback leaves it too and changes nothing.
        body = d.su(f"select pg_get_functiondef('{SIG}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        drifted = _md5(d)
        assert drifted not in (sec_db.CREATIVE_PRICE_0228, sec_db.CREATIVE_PRICE_0243)
        with pytest.raises(Exception) as cm:
            d.su(mig)
        assert "0243 found a creative_price() that is neither 0228's body nor 0243's" in str(cm.value)
        assert _md5(d) == drifted
        d.su(rb)
        assert _md5(d) == drifted, "the rollback puts a body back only from 0243's own"
    finally:
        sec_db.drop_database(admin, name)


def test_a_creative_price_handed_to_another_owner_is_refused_by_the_file_and_its_rollback(lab):
    # Breach 0243 F2: create or replace keeps the owner and the md5 reads only the source, so a security definer whose owner was
    # changed by hand passed the guard, the end state and the rollback. Both end states now name the owner.
    admin = sec_db.admin_dsn()
    name = f"ns_preview_owner_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    mig = sec_db.MIGRATION_0243.read_text(encoding="utf-8")
    rb = sec_db.ROLLBACK_0243.read_text(encoding="utf-8")
    try:
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name != sec_db.MIGRATION_0243.name])
        d = Db(base)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0228
        d.su("do $$ begin if not exists (select 1 from pg_roles where rolname = 'ns_owner_drift') then "
             "create role ns_owner_drift nologin; end if; end $$")
        d.su(f"alter function {SIG} owner to ns_owner_drift")
        with pytest.raises(Exception) as cm:
            d.su(mig)
        assert "0243 end state: creative_price is not owned by postgres" in str(cm.value)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0228, "the refused apply leaves nothing behind"
        d.su(f"alter function {SIG} owner to postgres")
        d.su(mig)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0243
        d.su(f"alter function {SIG} owner to ns_owner_drift")
        with pytest.raises(Exception) as cm:
            d.su(rb)
        assert "rollback 0243 end state: creative_price is not owned by postgres" in str(cm.value)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0243, "the refused rollback leaves nothing behind"
    finally:
        sec_db.drop_database(admin, name)
