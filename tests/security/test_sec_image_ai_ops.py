"""The picture ops (0099) — expand, relight, erase — attacked in a real database.

Each starts from one picture of the organization's media library and answers
one picture. The database alone decides whether the picture may be used (the
SAME organization's, live, a type the provider takes, at most 15 MB), what the
settings may be (closed lists, exactly one of a look or a prompt for a relight)
and what it costs (one picture at the model's credit price, from the registry
and credit_prices). Bob (org B) tries to use Alice's picture every way the API
lets him; the answer must be exactly the answer for an id that does not exist,
and nothing may be held. A model with no price row, or one that is not proven,
is never sold at 0.

Runs in its own scratch database (it commits), like the 0046 / 0052 labs.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc
from test_sec_video_tools import create, drain, media, quote

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000d9"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000d9"
UA = str(uuid.UUID(int=0xD9A))
UB = str(uuid.UUID(int=0xD9B))

SHAPES = ["16:9", "1:1", "9:16"]
LOOKS = ["soft", "warm", "golden_hour"]
# (id, capabilities, extra spec, credit unit)
MODELS = [
    ("ops", ["expand", "relight", "erase"],
     {"aspect_ratios": SHAPES, "aspect_ratios_by_capability": {"expand": SHAPES}, "relight_looks": LOOKS},
     "model_ops_image"),
    ("ops-unpriced", ["expand", "relight", "erase"],
     {"aspect_ratios": SHAPES, "aspect_ratios_by_capability": {"expand": SHAPES}, "relight_looks": LOOKS},
     "model_ops_unpriced_image"),
    ("ops-hidden", ["erase"], {}, "model_ops_hidden_image"),
    ("ops-nolists", ["expand", "relight"], {}, "model_ops_nolists_image"),
]
PRICES = [("model_ops_image", 3), ("model_ops_hidden_image", 3), ("model_ops_nolists_image", 3), ("job_minimum", 1)]
LIVE = ("ops", "ops-unpriced", "ops-nolists")


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_image_ops_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a9@x.io'),(%s,'b9@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A9','org-a9'),(%s,'B9','org-b9')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a9@x.io','viewer'),(%s,%s,'b9@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "image.acme_ops", "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "image", **extra}}
            for m, caps, extra, unit in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    d.rows = rows
    for m, caps, _x, _u in MODELS:
        if m == "ops-hidden":
            continue  # never probed, never listed: the owner has not said yes
        d.su("select public.record_model_probe(%s, 'image.acme_ops', %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values "
         + ", ".join(f"('{u}', {c}, 0)" for u, c in PRICES)
         + " on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.assets = {
        "a_png": media(d, ORG_A, "image", "image/png", None),
        "a_jpg": media(d, ORG_A, "image", "image/jpeg", None),
        "a_gif": media(d, ORG_A, "image", "image/gif", None),
        "a_big": media(d, ORG_A, "image", "image/png", None, size=16 * 1024 * 1024),
        "a_edge": media(d, ORG_A, "image", "image/png", None, size=15 * 1024 * 1024),
        "a_video": media(d, ORG_A, "video", "video/mp4", 5),
        "a_deleted": media(d, ORG_A, "image", "image/png", None),
        "b_png": media(d, ORG_B, "image", "image/png", None),
    }
    d.act("authenticated", UA, "select public.soft_delete_asset(%s)", [d.assets["a_deleted"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def grow(src, shape="16:9", **more):
    return {"source_asset_id": src, "aspect_ratio": shape, **more}


def light(src, **more):
    return {"source_asset_id": src, **({"look": "warm"} if "prompt" not in more else {}), **more}


def erase(src, thing="the red car", **more):
    return {"source_asset_id": src, "prompt": thing, **more}


# ── the price: one picture at the model's credit price, from the database ────

@pytest.mark.parametrize("cap,params", [
    ("expand", lambda a: grow(a["a_png"])),
    ("relight", lambda a: light(a["a_png"])),
    ("relight", lambda a: light(a["a_png"], prompt="late afternoon sun from the left")),
    ("erase", lambda a: erase(a["a_png"])),
])
def test_each_op_is_one_picture_at_the_models_rate(db, cap, params):
    q = quote(db, UA, ORG_A, cap, "ops", params(db.assets))
    assert (q["quantity"], q["unit"], q["credits"], q["capability"]) == (1, "model_ops_image", 3, cap)
    assert "margin" not in q


def test_a_created_job_holds_exactly_the_quote_and_keeps_the_databases_numbers(db):
    drain(db)
    j = create(db, UA, ORG_A, "erase", "ops", erase(db.assets["a_png"]))["job"]
    row = db.su("select quantity::float, quoted_credits::float, credit_unit from public.creative_jobs where id=%s",
                [j["id"]])[0]
    assert row == (1.0, 3.0, "model_ops_image")
    assert db.su("select amount::float from public.credit_reservations where job_id=%s",
                 ["cj:" + j["id"]]) == [(3.0,)]
    drain(db)


def test_the_confirmed_price_is_still_the_ceiling(db):
    st, word, _ = err(lambda: create(db, UA, ORG_A, "expand", "ops", grow(db.assets["a_png"]), maxc=2))
    assert (st, word) == ("NS409", "price_changed")


def test_a_model_without_a_price_row_is_unpriced_never_free(db):
    drain(db)
    before = footprint(db, ORG_A)
    for cap, params in (("expand", grow(db.assets["a_png"])), ("relight", light(db.assets["a_png"])),
                        ("erase", erase(db.assets["a_png"]))):
        st, word, _ = err(lambda: quote(db, UA, ORG_A, cap, "ops-unpriced", params))
        assert (st, word) == ("NS400", "unpriced"), cap
        st, word, _ = err(lambda: create(db, UA, ORG_A, cap, "ops-unpriced", params))
        assert (st, word) == ("NS400", "unpriced"), cap
    assert footprint(db, ORG_A) == before


def test_a_model_that_was_never_probed_is_not_sold_at_any_price(db):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "erase", "ops-hidden", erase(db.assets["a_png"])))
    assert (st, word) == ("NS400", "model_not_sellable")
    st, word, _ = err(lambda: create(db, UA, ORG_A, "erase", "ops-hidden", erase(db.assets["a_png"])))
    assert (st, word) == ("NS400", "model_not_sellable")
    assert footprint(db, ORG_A) == before


def test_a_model_is_only_sold_the_ops_it_lists(db):
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "erase", "ops-nolists", erase(db.assets["a_png"])))
    assert (st, word) == ("NS400", "model_not_sellable")
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "relight", "ops-hidden", light(db.assets["a_png"])))
    assert (st, word) == ("NS400", "model_not_sellable")


def test_nothing_is_sold_until_a_model_lists_the_ops_and_has_a_price(db):
    # "ops" and "ops-nolists" are the only priced, proven models: with both hidden
    # again, sellable_models lists nothing for the new capabilities (the unpriced
    # and the never-probed ones were never listed).
    db.su("update public.model_registry set availability='hidden' where id in ('ops', 'ops-nolists')")
    try:
        for cap in ("expand", "relight", "erase"):
            assert db.act("authenticated", UA, "select id from public.sellable_models(%s, 'web')", [cap]) == []
    finally:
        db.su("update public.model_registry set availability='beta' where id in ('ops', 'ops-nolists')")


# ── the closed lists ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("shape", ["16:9", "9:16", "1:1", "4:3", "3:4"])
def test_expand_accepts_each_shape_of_the_list_the_model_has(db, shape):
    if shape in SHAPES:
        assert quote(db, UA, ORG_A, "expand", "ops", grow(db.assets["a_png"], shape))["credits"] == 3
    else:
        # A shape on the closed list that this model was not proven for.
        st, word, detail = err(lambda: quote(db, UA, ORG_A, "expand", "ops", grow(db.assets["a_png"], shape)))
        assert (st, word) == ("NS400", "invalid_params") and f"does not extend a picture to {shape}" in detail


def test_a_model_without_lists_is_not_sold_a_shape_or_a_light(db):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "expand", "ops-nolists", grow(db.assets["a_png"])))
    assert (st, word) == ("NS400", "invalid_params") and "does not extend a picture to 16:9" in detail
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "relight", "ops-nolists", light(db.assets["a_png"])))
    assert (st, word) == ("NS400", "invalid_params") and "does not offer the warm light" in detail
    # A free prompt needs no list.
    assert quote(db, UA, ORG_A, "relight", "ops-nolists", light(db.assets["a_png"], prompt="candle light"))["credits"] == 3


def test_a_light_the_model_does_not_list_is_refused(db):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "relight", "ops", {"source_asset_id": db.assets["a_png"],
                                                                            "look": "studio"}))
    assert (st, word) == ("NS400", "invalid_params") and "does not offer the studio light" in detail


@pytest.mark.parametrize("cap,model,params,why", [
    # expand
    ("expand", "ops", {"source_asset_id": "SRC"}, "aspect_ratio must be one of"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "21:9"}, "aspect_ratio must be one of"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:10"}, "aspect_ratio must be one of"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": 1}, "aspect_ratio must look like 16:9"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": None}, "aspect_ratio must look like 16:9"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9; drop table"}, "aspect_ratio must look like"),
    ("expand", "ops", {"aspect_ratio": "16:9"}, "source_asset_id"),
    ("expand", "ops", {"source_asset_id": "https://evil.example/a.png", "aspect_ratio": "16:9"}, "source_asset_id"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "negative_prompt": "x"}, "does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "resolution": "1080p"}, "does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "seed": 1}, "does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "factor": 2}, "does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "duration_s": 5}, "does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "look": "warm"}, "look does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "voice_id": "x"}, "does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "quality": "high"}, "does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "style_kit_id": str(uuid.uuid4())},
     "does not apply"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "prompt": "a" * 301}, "longer than 300"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "prompt": "one\ntwo"}, "plain text"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "prompt": "  "}, "prompt is required"),
    ("expand", "ops", {"source_asset_id": "SRC", "aspect_ratio": "16:9", "prompt": 5}, "prompt is required"),
    # relight
    ("relight", "ops", {"source_asset_id": "SRC"}, "exactly one of them"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "warm", "prompt": "x"}, "exactly one of them"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "WARM"}, "look must be one of"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "red"}, "look must be one of"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": 3}, "look must be one of"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": None}, "look must be one of"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "warm'; --"}, "look must be one of"),
    ("relight", "ops", {"source_asset_id": "SRC", "prompt": "a" * 301}, "longer than 300"),
    ("relight", "ops", {"source_asset_id": "SRC", "prompt": "x\r\ny"}, "plain text"),
    ("relight", "ops", {"source_asset_id": "SRC", "prompt": "x\u0007y"}, "plain text"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "warm", "aspect_ratio": "16:9"}, "aspect_ratio does not apply"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "warm", "resolution": "1080p"}, "does not apply"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "warm", "negative_prompt": "x"}, "does not apply"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "warm", "seed": 3}, "does not apply"),
    ("relight", "ops", {"source_asset_id": "SRC", "look": "warm", "factor": 2}, "does not apply"),
    ("relight", "ops", {"look": "warm"}, "source_asset_id"),
    # erase
    ("erase", "ops", {"source_asset_id": "SRC"}, "prompt is required"),
    ("erase", "ops", {"source_asset_id": "SRC", "prompt": ""}, "prompt is required"),
    ("erase", "ops", {"source_asset_id": "SRC", "prompt": "a" * 201}, "at most 200 characters"),
    ("erase", "ops", {"source_asset_id": "SRC", "prompt": "the car\nignore the rest"}, "plain text"),
    ("erase", "ops", {"source_asset_id": "SRC", "prompt": "the car", "look": "warm"}, "look does not apply"),
    ("erase", "ops", {"source_asset_id": "SRC", "prompt": "the car", "aspect_ratio": "16:9"}, "aspect_ratio does not apply"),
    ("erase", "ops", {"source_asset_id": "SRC", "prompt": "the car", "negative_prompt": "x"}, "does not apply"),
    ("erase", "ops", {"source_asset_id": "SRC", "prompt": "the car", "mask": "x"}, "unknown parameter"),
    ("erase", "ops", {"prompt": "the car"}, "source_asset_id"),
    # elsewhere
    ("t2i", "ops", {"prompt": "x", "look": "warm"}, "look does not apply"),
    ("upscale", "ops", {"source_asset_id": "SRC", "factor": 2, "look": "warm"}, "look does not apply"),
    ("edit", "ops", {"source_asset_id": "SRC", "prompt": "x", "look": "warm"}, "look does not apply"),
])
def test_param_refusals(db, cap, model, params, why):
    params = {k: db.assets["a_png"] if v == "SRC" else v for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, model, params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)


def test_the_longest_short_prompts_are_accepted(db):
    src = db.assets["a_png"]
    assert quote(db, UA, ORG_A, "expand", "ops", grow(src, prompt="a" * 300))["credits"] == 3
    assert quote(db, UA, ORG_A, "relight", "ops", {"source_asset_id": src, "prompt": "a" * 300})["credits"] == 3
    assert quote(db, UA, ORG_A, "erase", "ops", erase(src, "a" * 200))["credits"] == 3


def test_a_prompt_with_quotes_and_markup_is_data_not_sql(db):
    src = db.assets["a_png"]
    weird = "the \"red\" car'; drop table public.creative_jobs; -- <script>"
    assert quote(db, UA, ORG_A, "erase", "ops", erase(src, weird))["credits"] == 3
    assert db.su("select to_regclass('public.creative_jobs') is not null") == [(True,)]


# ── the picture must be the organization's own ───────────────────────────────

CALLS = {
    "expand": lambda src: grow(src),
    "relight": lambda src: light(src),
    "erase": lambda src: erase(src),
}


@pytest.mark.parametrize("cap", sorted(CALLS))
@pytest.mark.parametrize("call", ["quote", "create"])
def test_another_orgs_picture_reads_like_one_that_does_not_exist(db, cap, call):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    st, word, detail = err(lambda: fn(db, UB, ORG_B, cap, "ops", CALLS[cap](db.assets["a_png"])))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, cap, "ops", CALLS[cap](str(uuid.uuid4()))))
    assert (st, word) == ("NS400", "source_unavailable"), (st, word)
    assert (st, word, detail) == (st2, word2, detail2)
    assert db.assets["a_png"] not in detail
    assert footprint(db, ORG_B) == before


@pytest.mark.parametrize("cap", sorted(CALLS))
def test_alice_cannot_use_bobs_picture_and_a_stranger_cannot_spend_in_her_org(db, cap):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: create(db, UA, ORG_A, cap, "ops", CALLS[cap](db.assets["b_png"])))
    assert (st, word) == ("NS400", "source_unavailable")
    assert footprint(db, ORG_A) == before
    st, _, _ = err(lambda: create(db, UB, ORG_A, cap, "ops", CALLS[cap](db.assets["a_png"])))
    assert st == "42501"


@pytest.mark.parametrize("key,why", [
    ("a_deleted", "no image in this organization"),
    ("a_video", "must be an image"),
    ("a_gif", "GIF"),
    ("a_big", "larger than 15 MB"),
])
@pytest.mark.parametrize("cap", sorted(CALLS))
def test_unusable_pictures_are_refused_before_any_hold(db, cap, key, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, cap, "ops", CALLS[cap](db.assets[key])))
    assert (st, word) == ("NS400", "source_unavailable") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


@pytest.mark.parametrize("cap", sorted(CALLS))
def test_a_picture_of_exactly_15_mb_is_fine(db, cap):
    assert quote(db, UA, ORG_A, cap, "ops", CALLS[cap](db.assets["a_edge"]))["credits"] == 3


# ── what applying the migration left alone ───────────────────────────────────

def test_the_earlier_tools_are_quoted_exactly_as_before(db):
    # An upscale on a model priced per picture, a description and a captions
    # quote still go through the same functions; only the closed lists grew.
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "upscale", "ops",
                                    {"source_asset_id": db.assets["a_png"], "factor": 2}))
    assert (st, word) == ("NS400", "model_not_sellable")
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "t2i", "ops", {"prompt": "x", "aspect_ratio": "21:9"}))
    assert (st, word) == ("NS400", "model_not_sellable")
    assert db.su("select public.creative_params_problem('captions', "
                 "'{\"source_asset_id\":\"00000000-0000-4000-8000-000000000000\",\"language\":\"uz\"}'::jsonb) is null")\
        == [(True,)]
    assert db.su("select public.creative_params_problem('video_upscale', "
                 "'{\"source_asset_id\":\"00000000-0000-4000-8000-000000000000\",\"target_resolution\":\"4k\"}'::jsonb) is null")\
        == [(True,)]
    assert db.su("select public.creative_quantity('upscale', '{\"factor\":4}'::jsonb), "
                 "public.creative_quantity('edit', '{}'::jsonb), public.creative_quantity('remove_bg', '{}'::jsonb)") \
        == [(4, 1, 1)]


def test_sellable_models_lists_the_lights_and_never_the_margin(db):
    rows = db.act("authenticated", UA, "select id, capabilities, spec, margin, credits_per_unit::float "
                                       "from public.sellable_models('relight', 'web')")
    by = {r[0]: r for r in rows}
    assert set(by) == {"ops", "ops-nolists"}   # the unpriced one is not listed
    assert by["ops"][2]["relight_looks"] == LOOKS
    assert by["ops"][2]["aspect_ratios_by_capability"] == {"expand": SHAPES}
    assert "relight_looks" not in by["ops-nolists"][2]
    assert by["ops"][3] is None and by["ops"][4] == 3.0
    assert "vendor_model" not in by["ops"][2] and "pricing" not in by["ops"][2]


def test_an_unknown_capability_is_still_refused_by_sellable_models(db):
    with pytest.raises(psycopg.Error) as e:
        db.act("authenticated", UA, "select * from public.sellable_models('inpaint', 'web')")
    assert e.value.sqlstate == "22023"


def test_the_registry_accepts_the_new_capabilities_and_no_others(db):
    db.su("update public.model_registry set capabilities = array['expand','relight','erase','upscale'] where id='ops-hidden'")
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.model_registry set capabilities = array['expand','inpaint'] where id='ops-hidden'")
    assert e.value.sqlstate == "23514"
    db.su("update public.model_registry set capabilities = array['erase'] where id='ops-hidden'")


def test_a_probe_of_the_new_capabilities_can_be_recorded_and_others_cannot(db):
    pid = db.su("select public.record_model_probe('ops', 'image.acme_ops', 'acme-ops', 'expand', false, "
                "'bad_response', 'x', 10, null, 'security-lab')")[0][0]
    assert pid
    with pytest.raises(psycopg.Error) as e:
        db.su("select public.record_model_probe('ops', 'image.acme_ops', 'acme-ops', 'inpaint', true, null, null, 10, 1, 'x')")
    assert e.value.sqlstate in ("23514", "22023")


def test_changing_the_lights_or_the_shapes_needs_a_new_probe(db):
    rows = [dict(r, spec={**r["spec"], "relight_looks": LOOKS + ["cool"]}) if r["id"] == "ops-nolists" else r
            for r in db.rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    assert db.su("select availability, verified_at is null from public.model_registry where id='ops-nolists'") == \
        [("hidden", True)]
    # …and so does a new shape; a model whose lists did not change keeps its proof.
    assert db.su("select availability from public.model_registry where id='ops'") == [("beta",)]
    rows = [dict(r, spec={**r["spec"], "aspect_ratios": SHAPES + ["4:3"],
                          "aspect_ratios_by_capability": {"expand": SHAPES + ["4:3"]}}) if r["id"] == "ops" else r
            for r in rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    assert db.su("select availability, verified_at is null from public.model_registry where id='ops'") == \
        [("hidden", True)]
    # Prove it again, as the owner would, and the sale resumes at the same price.
    pid = db.su("select public.record_model_probe('ops', 'image.acme_ops', 'acme-ops', 'erase', true, "
                "null, null, 10, 100, 'security-lab')")[0][0]
    assert pid
    db.su("update public.model_registry set availability='beta' where id='ops'")
    assert quote(db, UA, ORG_A, "expand", "ops", grow(db.assets["a_png"], "4:3"))["credits"] == 3


# ── the worker's side ────────────────────────────────────────────────────────

@pytest.mark.parametrize("cap", sorted(CALLS))
def test_worker_reads_the_picture_of_its_own_running_job_only(db, cap):
    drain(db)
    j = create(db, UA, ORG_A, cap, "ops", CALLS[cap](db.assets["a_jpg"]))["job"]
    assert svc(db, "select id::text from public.claim_creative_job('w1')")[0][0] == j["id"]
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is True and out["asset_id"] == db.assets["a_jpg"] and out["kind"] == "image"
    assert svc(db, "select public.creative_job_source(%s, 'w2')", [j["id"]])[0][0]["ok"] is False
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_a_picture_deleted_after_create_fails_and_releases_in_full(db):
    drain(db)
    pic = media(db, ORG_A, "image", "image/webp", None)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "erase", "ops", erase(pic))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    db.act("authenticated", UA, "select public.soft_delete_asset(%s)", [pic])
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is False and "no image in this organization" in out["problem"]
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'source_unavailable',%s)",
               [j["id"], out["problem"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]
    assert db.su("select status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == [("released",)]


@pytest.mark.parametrize("cap", sorted(CALLS))
def test_a_provider_failure_after_submit_releases_the_hold(db, cap):
    drain(db)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, cap, "ops", CALLS[cap](db.assets["a_png"]))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','sync:00000000000000000000000000000001')", [j["id"]])
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'bad_request','failed')", [j["id"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]


# ── nobody reaches the internals through the API ─────────────────────────────

@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA), ("authenticated", UB)])
@pytest.mark.parametrize("query", [
    "select public.creative_params_problem('erase', jsonb_build_object('source_asset_id', %(asset)s::text, 'prompt', 'x'))",
    "select public.creative_source_problem(%(org)s, 'expand', jsonb_build_object('source_asset_id', %(asset)s::text))",
    "select public.creative_quantity('erase', '{}'::jsonb)",
    "select public.creative_capability_supported('erase')",
    "select public.creative_job_source(%(job)s, 'w1')",
    "select public.creative_price(%(org)s, 'erase', 'ops', jsonb_build_object('source_asset_id', %(asset)s::text, 'prompt', 'x'))",
])
def test_no_browser_reaches_the_internal_or_worker_side(db, role, uid, query):
    job = db.su("select id::text from public.creative_jobs where org_id=%s limit 1", [ORG_A])[0][0]
    with pytest.raises(psycopg.Error) as e:
        db.act(role, uid, query, {"job": job, "asset": db.assets["a_png"], "org": ORG_A})
    assert e.value.sqlstate == "42501"


def test_anon_cannot_quote_or_list(db):
    with pytest.raises(psycopg.Error) as e:
        db.act("anon", None, "select public.quote_creative_job(%s,'erase','ops',%s::jsonb)",
               [ORG_A, json.dumps(erase(db.assets["a_png"]))])
    assert e.value.sqlstate == "42501"
    with pytest.raises(psycopg.Error) as e:
        db.act("anon", None, "select * from public.sellable_models('erase', 'web')")
    assert e.value.sqlstate == "42501"
