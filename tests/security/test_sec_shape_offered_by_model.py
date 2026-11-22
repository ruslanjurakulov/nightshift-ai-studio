"""A quote refuses a shape the model does not list (migration 0155).

Seen live on 2026-11-13: ideogram-4 and ideogram-4.5 t2i with {"aspect_ratio": "16:9"} were quoted and created, and the worker then
failed both jobs ("aspect ratio 16:9 is not offered for t2i by ideogram-4"): the database only checked that a shape looked like 16:9,
and the first place that read the model's own list was the worker, after the job row and its hold. These tests run the real quote and
the real create on a real Postgres and pin what must hold:

* a shape the spec lists is quoted; one it does not is refused `invalid_params`, naming the model, the shape and the capability;
* an empty list (a model that makes its own shape) refuses every shape, and a spec with no list at all refuses too;
* aspect_ratios_by_capability narrows the list for its capability, and an empty narrowing reads as none (the worker's rule);
* no shape named is unchanged;
* create_creative_job refuses the same request: no job row, no hold, nothing for the worker to pick up (customer and operator alike);
* with 0155 rolled back the same create is accepted (the failure this file pins), and every answer without a bad shape is 0153's.

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

SHAPED = "lab-shaped-image"
SHAPELESS = "lab-shapeless-image"
UNSTATED = "lab-unstated-image"
NARROWED = "lab-narrowed-image"


def _unit(mid):
    return f"model_{mid.replace('-', '_')}_image"


def _make(conn, mid, *, availability="beta", capabilities=("t2i",), **spec_extra):
    """A model on sale the ordinary way (verified, beta, a credit price, no plan entitlement). ``spec_extra`` carries its shapes."""
    spec = {"vendor_model": f"{mid}-vendor", "output": "image", "terms_gate": None,
            "pricing": {"unit": "image", "provider_usd_per_unit": 0.03}, **spec_extra}
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, %s, 'lab', 'image.ideogram_v4', %s, %s::jsonb, %s, null)",
                 [mid, mid, list(capabilities), json.dumps(spec), _unit(mid)])
    conn.execute("select public.record_model_probe(%s, 'image.ideogram_v4', %s, %s, true, null, null, 900, 1234, 'security-lab')",
                 [mid, spec["vendor_model"], capabilities[0]])
    conn.execute("update public.model_registry set availability = %s where id = %s", [availability, mid])
    conn.execute("insert into public.credit_prices (unit, credits_per_unit) values (%s, 4) on conflict (unit) do nothing", [_unit(mid)])


def _all(conn):
    _make(conn, SHAPED, aspect_ratios=["16:9", "9:16", "1:1"])
    _make(conn, SHAPELESS, aspect_ratios=[])
    _make(conn, UNSTATED)
    _make(conn, NARROWED, capabilities=("t2i", "edit"), aspect_ratios=["16:9", "9:16", "1:1"],
          aspect_ratios_by_capability={"edit": ["1:1"]})


def _params(**extra):
    return {"prompt": "a lighthouse at dawn", **extra}


def _quote(conn, who, org, mid, params, cap="t2i"):
    return _call(conn, who, "select public.quote_creative_job(%s, %s, %s, %s::jsonb)", [org, cap, mid, json.dumps(params)])


def _create(conn, who, org, mid, params, maxc=1000):
    return _call(conn, who, "select public.create_creative_job(%s, 't2i', %s, %s::jsonb, 'exact', null, %s::numeric)",
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


def _refused_for_shape(conn, who, org, mid, shape, *, create=False, cap="t2i"):
    p = json.dumps(_params(aspect_ratio=shape))
    if create:
        got = _detail(conn, who, "select public.create_creative_job(%s, 't2i', %s, %s::jsonb, 'exact', null, 1000::numeric)",
                      [org, mid, p])
    else:
        got = _detail(conn, who, "select public.quote_creative_job(%s, %s, %s, %s::jsonb)", [org, cap, mid, p])
    return got == ("NS400", "invalid_params", f"{mid} does not offer the {shape} shape for {cap}")


def _customer(conn, sc):
    # A paying tenant: the scenario seeds Alice's organization with credits (sec_scenario), enough for a 4-credit image.
    return sc.alice.actor, sc.alice.org


# ── the quote ──────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_listed_shape_is_quoted_and_an_unlisted_one_is_refused_naming_it(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        for shape in ("16:9", "9:16", "1:1"):
            state, q = _quote(conn, who, org, SHAPED, _params(aspect_ratio=shape))
            assert state == "ok" and float(q["credits"]) > 0, (shape, q)
        for shape in ("4:3", "21:9", "2:1"):
            assert _refused_for_shape(conn, who, org, SHAPED, shape), shape
        # no shape named: no check, exactly as before
        assert _quote(conn, who, org, SHAPED, _params())[0] == "ok"


def test_an_empty_list_or_no_list_at_all_refuses_every_shape_and_quotes_none(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        for mid in (SHAPELESS, UNSTATED):
            for shape in ("16:9", "1:1"):
                assert _refused_for_shape(conn, who, org, mid, shape), (mid, shape)
            assert _quote(conn, who, org, mid, _params())[0] == "ok", mid


def test_a_capability_narrowing_wins_for_its_capability_only(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        # t2i has no narrowing (edit's 1:1 narrows edit only): the model's whole list
        assert _quote(conn, who, org, NARROWED, _params(aspect_ratio="16:9"))[0] == "ok"
        # an empty narrowing reads as none, as the worker's `by_cap.get(cap) or aspect_ratios` does
        conn.execute("update public.model_registry set spec = jsonb_set(spec, '{aspect_ratios_by_capability}', %s::jsonb) where id = %s",
                     [json.dumps({"t2i": []}), NARROWED])
        assert _quote(conn, who, org, NARROWED, _params(aspect_ratio="9:16"))[0] == "ok"
        conn.execute("update public.model_registry set spec = jsonb_set(spec, '{aspect_ratios_by_capability}', %s::jsonb) where id = %s",
                     [json.dumps({"t2i": ["1:1"]}), NARROWED])
        assert _refused_for_shape(conn, who, org, NARROWED, "16:9")
        assert _quote(conn, who, org, NARROWED, _params(aspect_ratio="1:1"))[0] == "ok"


def test_the_operator_preview_is_held_to_the_same_list(conn, sc):
    # The live failure was an operator preview (ideogram-4 / 4.5 in the operator's own organization): the rule is the same there.
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, SHAPED, availability="hidden", aspect_ratios=["16:9"], operator_preview=True)
        conn.execute("delete from public.credit_prices where unit = %s", [_unit(SHAPED)])
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, SHAPED, _params(aspect_ratio="16:9"))
        assert state == "ok" and q.get("preview") is True, q
        assert _refused_for_shape(conn, sc.operator, DEFAULT_ORG, SHAPED, "9:16")


# ── the create: a refused shape never becomes a job ───────────────────────────────────────────────────────────────

def _counts(conn):
    return conn.execute("select (select count(*) from public.creative_jobs), (select count(*) from public.credit_transactions)").fetchone()


def test_a_refused_shape_never_becomes_a_job_or_a_hold_for_a_customer_or_the_operator(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        before = _counts(conn)
        for actor, o in ((who, org), (sc.operator, DEFAULT_ORG)):
            for mid, shape in ((SHAPED, "4:3"), (SHAPELESS, "16:9"), (UNSTATED, "16:9")):
                assert _refused_for_shape(conn, actor, o, mid, shape, create=True), (actor.name, mid, shape)
        # nothing was queued for the worker and nothing was held
        assert _counts(conn) == before
        # the positive control, in the exempt organization (the scenario's tenants are at their parallel-run limit)
        state, out = _create(conn, sc.operator, DEFAULT_ORG, SHAPED, _params(aspect_ratio="16:9"))
        assert state == "ok", out
        row = conn.execute("select params ->> 'aspect_ratio', status from public.creative_jobs where id = %s", [out["job"]["id"]]).fetchone()
        assert row[0] == "16:9", row


def test_without_0155_the_same_job_is_queued_and_every_other_answer_is_0153s(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _all(conn)
        who, org = _customer(conn, sc)
        others = [(who, org, mid, p, cap)
                  for mid in (SHAPED, SHAPELESS, UNSTATED, NARROWED, "no-such-model")
                  for p, cap in ((_params(), "t2i"), (_params(aspect_ratio="16:9"), "t2i"), (_params(aspect_ratio="bad"), "t2i"),
                                 (_params(quality="high"), "t2i"))
                  if not (p.get("aspect_ratio") == "16:9" and mid in (SHAPELESS, UNSTATED))]
        bad = [(who, org, SHAPELESS, _params(aspect_ratio="16:9"), "t2i"), (who, org, SHAPED, _params(aspect_ratio="4:3"), "t2i")]
        with_0155 = [_quote(conn, *c) for c in others + bad]
        _become(conn, None)
        conn.execute(sec_db.rollback_0159_body())  # 0159 sits on 0156's creative_price: off first
        conn.execute(sec_db.rollback_0156_body())  # 0156 sits on 0155's creative_price: off first
        conn.execute(sec_db.rollback_0155_body())
        assert sec_db.has_0153(conn)
        without = [_quote(conn, *c) for c in others + bad]
        n = len(others)
        assert with_0155[:n] == without[:n], "every answer without an unlisted shape, refusals included, is 0153's"
        assert any(s == "ok" for s, _ in with_0155[:n]), "the positive control"
        assert all(s == "NS400" for s, _ in with_0155[n:]), with_0155[n:]
        # the failure 0155 fixes: under 0153 the shape the model cannot make is quoted and queued, and only the worker refuses it
        assert all(s == "ok" for s, _ in without[n:]), without[n:]
        state, out = _create(conn, sc.operator, DEFAULT_ORG, SHAPELESS, _params(aspect_ratio="16:9"))
        assert state == "ok", out


# ── the file itself: order, drift guard, rollback ──────────────────────────────────────────────────────────────────

SIG = "public.creative_price(uuid,text,text,jsonb)"


def _md5(d):
    return d.su(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{SIG}'::regprocedure")[0][0]


def test_the_file_needs_0153_its_guard_refuses_a_hand_edit_and_its_rollback_restores_0153_byte_for_byte(lab):
    admin = sec_db.admin_dsn()
    name = f"ns_shape_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        # everything up to 0149, without 0153 (and so without this file)
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0149])
        d = Db(base)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0149
        m0155 = sec_db.MIGRATION_0155.read_text(encoding="utf-8")
        with pytest.raises(Exception) as cm:
            d.su(m0155)
        assert "0155 found a creative_price() that is neither 0153's body nor 0155's" in str(cm.value)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0149, "nothing left behind"
        d.su(sec_db.MIGRATION_0153.read_text(encoding="utf-8"))
        d.su(m0155)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0155
        d.su(m0155)                                                        # the replay
        assert _md5(d) == sec_db.CREATIVE_PRICE_0155
        # 0153's replay and rollback refuse 0155's body: the chain is taken off from the top
        with pytest.raises(Exception) as cm:
            d.su(sec_db.MIGRATION_0153.read_text(encoding="utf-8"))
        assert "0153 found a creative_price() that is neither 0149's body nor 0153's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su(sec_db.ROLLBACK_0153.read_text(encoding="utf-8"))
        assert "rollback 0153 found a creative_price() that is neither 0153's body nor 0149's" in str(cm.value)
        d.su(sec_db.ROLLBACK_0155.read_text(encoding="utf-8"))
        assert _md5(d) == sec_db.CREATIVE_PRICE_0153, "byte for byte"
        d.su(m0155)
        assert _md5(d) == sec_db.CREATIVE_PRICE_0155
        assert d.su("select has_function_privilege('authenticated', %s, 'EXECUTE') or has_function_privilege('service_role', %s, 'EXECUTE') "
                    "or has_function_privilege('anon', %s, 'EXECUTE')", [SIG, SIG, SIG]) == [(False,)]
        body = d.su(f"select pg_get_functiondef('{SIG}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(m0155)
        assert "0155 found a creative_price() that is neither 0153's body nor 0155's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su(sec_db.ROLLBACK_0155.read_text(encoding="utf-8"))
        assert "rollback 0155 found a creative_price() that is neither 0155's body nor 0153's" in str(cm.value)
    finally:
        sec_db.drop_database(admin, name)
