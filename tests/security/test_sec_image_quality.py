"""Image quality tiers (0060), attacked in a real database.

A picture model that bills by quality is quoted, held and charged at the price
of the TIER the person confirmed. The browser may name the tier; the database
alone decides whether this model sells it, what it costs, and what an absent
tier means (medium — the tier the worker sends). What must hold:

* the tier's own credit_prices row prices it (model_<id>_image_<tier>); a tier
  without a row is 'unpriced' — never another tier's rate, never 0;
* a tier the model does not list, an unknown word, a non-string and a tier on
  a capability that has none are refused before any hold;
* the hold is the quote of that tier, and the confirmed price is the ceiling;
* sellable_models lists a quality-priced model only while a tier has a price,
  and carries the tiers it sells;
* 0060 is built on 0052 / 0055: video_upscale's per-target price and the
  describe rules still answer exactly as before;
* the starting price rows come from an existing flat price only, and never
  overwrite one.

Runs in its own scratch database (it commits), like the 0046 / 0055 labs.
"""
import json
import os
import re
import uuid
from pathlib import Path

import psycopg
import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc
from test_sec_describe_image import pic

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000e0"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000e0"
UA = str(uuid.UUID(int=0xE0A))   # owner of A
UB = str(uuid.UUID(int=0xE0B))   # owner of B

MIGRATION = Path(sec_db.MIGRATIONS) / "0060_image_quality.sql"
TIERS = ["low", "medium", "high"]

#: (id, capabilities, credit unit, qualities or None, tier prices (credits per image) or None)
PRICES = {"low": 1, "medium": 4, "high": 16}


def _spec(qualities):
    spec = {"vendor_model": "acme-img", "output": "image", "pricing": {"unit": "image"}}
    if qualities:
        spec["qualities"] = qualities
        spec["pricing"]["variants"] = {"by": "quality", "prices": {q: None for q in qualities}}
    return spec


MODELS = [
    # id, qualities
    ("qimg", TIERS),
    ("qimg-part", TIERS),    # only high has a price
    ("qimg-none", TIERS),    # no tier has a price
    ("flat-img", None),      # a model without tiers
]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_quality_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a8@x.io'),(%s,'b8@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A8','org-a8'),(%s,'B8','org-b8')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a8@x.io','owner'),"
         "(%s,%s,'b8@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i", "edit"],
             "credit_unit": f"model_{m.replace('-', '_')}_image", "entitlement": "any", "spec": _spec(q)}
            for m, q in MODELS]
    # 0052's and 0055's tools, to prove 0060 did not take them away.
    rows += [
        {"id": "vup", "display_name": "vup", "provider": "acme", "adapter": "video.acme_up",
         "capabilities": ["video_upscale"], "credit_unit": "model_vup_second", "entitlement": "any",
         "spec": {"vendor_model": "acme-vup", "output": "video", "upscale_targets": ["2k", "4k"],
                  "pricing": {"unit": "second", "variants": {"by": "upscale_target", "prices": {"2k": 0.1, "4k": 0.2}}},
                  "limits": {"max_source_seconds": 30}}},
        {"id": "seer", "display_name": "seer", "provider": "acme", "adapter": "image.acme_describe",
         "capabilities": ["describe"], "credit_unit": "model_seer_request", "entitlement": None,
         "spec": {"vendor_model": "acme-seer", "output": "text"}},
    ]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for r in rows:
        cap = r["capabilities"][0]
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [r["id"], r["adapter"], r["spec"]["vendor_model"], cap])
        d.su("update public.model_registry set availability='beta' where id=%s", [r["id"]])
    # Flat prices (what the platform admin set on the Credits page) and tier rows.
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0)"
         " on conflict (unit) do update set credits_per_unit = 1, margin = 0")
    flat = [("model_qimg_image", 16), ("model_qimg_part_image", 16), ("model_qimg_none_image", 16),
            ("model_flat_img_image", 3), ("model_vup_second", 1), ("model_seer_request", 2)]
    for unit, c in flat:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, c])
    for tier, c in PRICES.items():
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0)",
             [f"model_qimg_image_{tier}", c])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_qimg_part_image_high', 16, 0)")
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values "
         "('model_vup_second_2k', 1, 0), ('model_vup_second_4k', 3, 0)")
    d.assets = {"a_png": pic(d, ORG_A, "image", "image/png"),
                "b_png": pic(d, ORG_B, "image", "image/png"),
                "a_mp4": pic(d, ORG_A, "video", "video/mp4", width=640, height=360)}
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def quote(db, uid, org, cap, model, params):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,%s,%s,%s::jsonb)",
                  [org, cap, model, json.dumps(params)])[0][0]


def create(db, uid, org, cap, model, params, maxc=1000):
    return db.act("authenticated", uid,
                  "select public.create_creative_job(%s,%s,%s,%s::jsonb,'exact',null,%s::numeric)",
                  [org, cap, model, json.dumps(params), maxc])[0][0]


def drain(db):
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc(db, "select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


def t2i(**extra):
    return {"prompt": "a red apple", **extra}


# ── the price is the tier's own ──────────────────────────────────────────────

@pytest.mark.parametrize("tier", TIERS)
def test_each_tier_is_priced_by_its_own_credit_row_and_the_quote_names_it(db, tier):
    q = quote(db, UA, ORG_A, "t2i", "qimg", t2i(quality=tier))
    assert (q["unit"], q["credits"], q["quality"]) == (f"model_qimg_image_{tier}", PRICES[tier], tier)


def test_no_tier_named_is_medium_the_tier_the_worker_sends(db):
    q = quote(db, UA, ORG_A, "t2i", "qimg", t2i())
    assert (q["unit"], q["credits"], q["quality"]) == ("model_qimg_image_medium", PRICES["medium"], "medium")


def test_edit_is_priced_by_tier_too(db):
    q = quote(db, UA, ORG_A, "edit", "qimg", {"prompt": "x", "source_asset_id": db.assets["a_png"], "quality": "low"})
    assert (q["unit"], q["credits"]) == ("model_qimg_image_low", PRICES["low"])


def test_a_model_without_tiers_keeps_its_flat_price_and_names_no_quality(db):
    q = quote(db, UA, ORG_A, "t2i", "flat-img", t2i())
    assert (q["unit"], q["credits"]) == ("model_flat_img_image", 3) and "quality" not in q


def test_a_tier_without_a_price_row_is_unpriced_never_another_tiers_rate_and_never_zero(db):
    drain(db)
    before = footprint(db, ORG_A)
    # qimg-part has only 'high' priced: the default (medium) and low are unpriced.
    for params in (t2i(), t2i(quality="medium"), t2i(quality="low")):
        st, word, _ = err(lambda p=params: quote(db, UA, ORG_A, "t2i", "qimg-part", p))
        assert (st, word) == ("NS400", "unpriced"), params
        st, word, _ = err(lambda p=params: create(db, UA, ORG_A, "t2i", "qimg-part", p))
        assert (st, word) == ("NS400", "unpriced"), params
    assert quote(db, UA, ORG_A, "t2i", "qimg-part", t2i(quality="high"))["credits"] == 16
    assert footprint(db, ORG_A) == before


# ── what is refused ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("params,why", [
    ({"prompt": "x", "quality": "ultra"}, "quality must be one of"),
    ({"prompt": "x", "quality": "HIGH"}, "quality must be one of"),
    ({"prompt": "x", "quality": ""}, "quality must be one of"),
    ({"prompt": "x", "quality": 2}, "quality must be one of"),
    ({"prompt": "x", "quality": None}, "quality must be one of"),
    ({"prompt": "x", "quality": ["low"]}, "quality must be one of"),
    ({"prompt": "x", "quality": "low' or '1'='1"}, "quality must be one of"),
])
def test_an_unknown_tier_is_refused_before_any_hold(db, params, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "t2i", "qimg", params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "t2i", "qimg", params))
    assert (st, word) == ("NS400", "invalid_params")
    assert footprint(db, ORG_A) == before


@pytest.mark.parametrize("cap,params", [
    ("t2v", {"prompt": "x", "duration_s": 5, "quality": "low"}),
    ("tts", {"prompt": "x", "quality": "low"}),
    ("upscale", {"source_asset_id": "SRC", "factor": 2, "quality": "low"}),
    ("remove_bg", {"source_asset_id": "SRC", "quality": "low"}),
    ("describe", {"source_asset_id": "SRC", "quality": "low"}),
    ("video_upscale", {"source_asset_id": "VID", "target_resolution": "4k", "quality": "low"}),
])
def test_a_quality_on_a_capability_without_tiers_is_refused(db, cap, params):
    params = {k: ({"SRC": db.assets["a_png"], "VID": db.assets["a_mp4"]}.get(v, v) if isinstance(v, str) else v)
              for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, "qimg", params))
    assert (st, word) == ("NS400", "invalid_params") and "quality does not apply" in detail, (st, word, detail)


def test_a_model_that_lists_no_tiers_refuses_one_instead_of_ignoring_it(db):
    drain(db)
    before = footprint(db, ORG_A)
    for tier in TIERS:
        st, word, detail = err(lambda t=tier: quote(db, UA, ORG_A, "t2i", "flat-img", t2i(quality=t)))
        assert (st, word) == ("NS400", "invalid_params") and "does not offer the" in detail
        st, word, _ = err(lambda t=tier: create(db, UA, ORG_A, "t2i", "flat-img", t2i(quality=t)))
        assert (st, word) == ("NS400", "invalid_params")
    assert footprint(db, ORG_A) == before


def test_a_tier_the_model_does_not_list_is_refused_even_when_a_price_row_exists(db):
    # A stray credit_prices row must not sell a tier the model never listed.
    db.su("update public.model_registry set spec = jsonb_set(spec, '{qualities}', '[\"medium\",\"high\"]') "
          "where id = 'qimg-none'")
    db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_qimg_none_image_low', 1, 0)"
          " on conflict (unit) do nothing")
    try:
        st, word, detail = err(lambda: quote(db, UA, ORG_A, "t2i", "qimg-none", t2i(quality="low")))
        assert (st, word) == ("NS400", "invalid_params") and "does not offer" in detail
    finally:
        db.su("update public.model_registry set spec = jsonb_set(spec, '{qualities}', '[\"low\",\"medium\",\"high\"]') "
              "where id = 'qimg-none'")
        db.su("delete from public.credit_prices where unit = 'model_qimg_none_image_low'")


# ── money: the hold is the tier's quote ──────────────────────────────────────

def test_the_hold_is_the_tiers_price_and_the_confirmed_price_is_the_ceiling(db):
    drain(db)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "t2i", "qimg", t2i(quality="high"), maxc=PRICES["medium"]))
    assert (st, word) == ("NS409", "price_changed")
    j = create(db, UA, ORG_A, "t2i", "qimg", t2i(quality="low"), maxc=PRICES["low"])["job"]
    assert float(j["quoted_credits"]) == PRICES["low"] and j["params"]["quality"] == "low"
    assert db.su("select amount::float from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == \
        [(float(PRICES["low"]),)]
    drain(db)


def test_a_job_that_names_no_tier_is_held_at_medium_and_stores_no_tier_it_was_not_given(db):
    drain(db)
    j = create(db, UA, ORG_A, "t2i", "qimg", t2i(), maxc=PRICES["medium"])["job"]
    assert float(j["quoted_credits"]) == PRICES["medium"] and "quality" not in j["params"]
    drain(db)


def test_a_failure_releases_the_tiers_hold_in_full(db):
    drain(db)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "t2i", "qimg", t2i(quality="high"))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'policy','refused')", [j["id"]])[0][0]
    assert done["status"] == "failed" and float(done["charged_credits"]) == 0
    assert footprint(db, ORG_A)[2] == before[2]


def test_the_earlier_source_checks_still_apply_to_a_tiered_edit(db):
    drain(db)
    before = footprint(db, ORG_B)
    params = {"prompt": "x", "source_asset_id": db.assets["a_png"], "quality": "low"}
    st, word, _ = err(lambda: create(db, UB, ORG_B, "edit", "qimg", params))   # another organization's picture
    assert (st, word) == ("NS400", "source_unavailable")
    assert footprint(db, ORG_B) == before


def test_a_member_of_another_org_cannot_quote_or_create_here(db):
    st, _, _ = err(lambda: quote(db, UB, ORG_A, "t2i", "qimg", t2i(quality="low")))
    assert st == "42501"
    st, _, _ = err(lambda: db.act("anon", None, "select public.quote_creative_job(%s,'t2i','qimg',%s::jsonb)",
                                  [ORG_A, json.dumps(t2i(quality="low"))]))
    assert st == "42501"


# ── the model list ───────────────────────────────────────────────────────────

def _sellable(db, cap="t2i"):
    return {r[0]: r[1] for r in db.act("authenticated", UA, "select id, spec from public.sellable_models(%s)", [cap])}


def test_a_quality_model_lists_the_tiers_it_sells_and_only_while_a_tier_has_a_price(db):
    got = _sellable(db)
    assert got["qimg"]["qualities"] == TIERS
    assert "qimg-part" in got            # one tier (high) is priced
    assert "qimg-none" not in got        # a flat price alone does not sell a tiered model
    assert "qualities" not in got["flat-img"]


def test_the_public_spec_never_carries_provider_costs(db):
    spec = _sellable(db)["qimg"]
    assert "pricing" not in spec and "probe" not in spec and "vendor_model" not in spec


def test_the_list_is_closed_to_anon(db):
    st, _, _ = err(lambda: db.act("anon", None, "select * from public.sellable_models('t2i')"))
    assert st == "42501"


# ── built on 0052 / 0055 ─────────────────────────────────────────────────────

def test_video_upscale_is_still_priced_per_target(db):
    q = quote(db, UA, ORG_A, "video_upscale", "vup", {"source_asset_id": db.assets["a_mp4"], "target_resolution": "4k"})
    assert q["unit"] == "model_vup_second_4k" and "quality" not in q


def test_describe_still_quotes_one_request(db):
    q = quote(db, UA, ORG_A, "describe", "seer", {"source_asset_id": db.assets["a_png"], "language": "uz"})
    assert (q["quantity"], q["unit"]) == (1, "model_seer_request")


def test_the_replaced_functions_stay_closed_to_the_api(db):
    for fn in ("creative_price(uuid,text,text,jsonb)", "creative_params_problem(text,jsonb)"):
        for role in ("anon", "authenticated"):
            assert db.su("select has_function_privilege(%s, %s, 'EXECUTE')", [role, f"public.{fn}"]) == [(False,)]


# ── the starting prices ──────────────────────────────────────────────────────

def _seed_statement():
    sql = MIGRATION.read_text()
    m = re.search(r"insert into public\.credit_prices.*?on conflict \(unit\) do nothing;", sql, re.S)
    assert m, "the migration's starting-price insert is missing"
    return m.group(0)


OPENAI_UNIT = "model_openai_gpt_image_2_image"


def test_starting_prices_come_from_an_existing_flat_price_only_and_never_overwrite(db):
    tiers = [f"{OPENAI_UNIT}_{t}" for t in TIERS]
    count = "select count(*) from public.credit_prices where unit = any(%s)"
    # No flat price: the models stay unpriced (the lab's fresh database has none).
    assert db.su(count, [tiers]) == [(0,)]
    db.su(_seed_statement())
    assert db.su(count, [tiers]) == [(0,)]
    # A flat price exists: the three rows follow it, with its margin.
    db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 20, 0.5)", [OPENAI_UNIT])
    try:
        db.su(_seed_statement())
        got = dict(db.su("select unit, credits_per_unit::float from public.credit_prices where unit = any(%s)", [tiers]))
        assert got == {tiers[0]: 1.4, tiers[1]: 5.0, tiers[2]: 20.0}
        assert {m for (m,) in db.su("select margin::float from public.credit_prices where unit = any(%s)", [tiers])} == {0.5}
        # The owner changes one; a re-run leaves it alone (on conflict do nothing).
        db.su("update public.credit_prices set credits_per_unit = 7 where unit = %s", [tiers[1]])
        db.su(_seed_statement())
        assert db.su("select credits_per_unit::float from public.credit_prices where unit = %s", [tiers[1]]) == [(7.0,)]
    finally:
        db.su("delete from public.credit_prices where unit = any(%s)", [tiers + [OPENAI_UNIT]])


def test_a_zero_flat_price_seeds_nothing_zero_is_not_a_price_to_derive_from(db):
    db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 0, 0)", [OPENAI_UNIT])
    try:
        db.su(_seed_statement())
        assert db.su("select count(*) from public.credit_prices where unit like %s", [OPENAI_UNIT + "\\_%"]) == [(0,)]
    finally:
        db.su("delete from public.credit_prices where unit = %s", [OPENAI_UNIT])
