"""The video ops (0100) — video_edit, video_reframe, video_remove_bg — attacked
in a real database.

Each starts from one video of the organization's media library and answers one
video. The database alone decides whether the video may be used (the SAME
organization's, live, a container the provider takes, of a measured length,
at most 25 MB), what the settings may be (a prompt for an edit; a closed list
of shapes for a reframe; nothing else), and what it costs: the video's own
measured seconds at the model's price per second, against the model's stated
longest input. Bob (org B) tries to use Alice's video every way the API lets
him; the answer must be exactly the answer for an id that does not exist, and
nothing may be held. A length typed by a client is refused, never priced; a
model with no price row, no proof or no stated longest input is never sold.

Runs in its own scratch database (it commits), like the 0052 lab.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc
from test_sec_video_tools import create, drain, media, quote

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000e1"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000e1"
UA = str(uuid.UUID(int=0xE1A))
UB = str(uuid.UUID(int=0xE1B))

SHAPES = ["16:9", "9:16"]
# (id, capabilities, extra spec, credit unit)
MODELS = [
    ("vops", ["video_edit", "video_reframe", "video_remove_bg"],
     {"aspect_ratios": SHAPES, "aspect_ratios_by_capability": {"video_reframe": SHAPES},
      "limits": {"max_source_seconds": 30}}, "model_vops_second"),
    ("vops-unpriced", ["video_edit", "video_reframe", "video_remove_bg"],
     {"aspect_ratios": SHAPES, "aspect_ratios_by_capability": {"video_reframe": SHAPES},
      "limits": {"max_source_seconds": 30}}, "model_vops_unpriced_second"),
    ("vops-nolimit", ["video_edit", "video_reframe", "video_remove_bg"],
     {"aspect_ratios": SHAPES, "aspect_ratios_by_capability": {"video_reframe": SHAPES}},
     "model_vops_nolimit_second"),
    ("vops-nolists", ["video_reframe"], {"limits": {"max_source_seconds": 30}}, "model_vops_nolists_second"),
    ("vops-hidden", ["video_edit"], {"limits": {"max_source_seconds": 30}}, "model_vops_hidden_second"),
]
PRICES = [("model_vops_second", 0.5), ("model_vops_nolimit_second", 0.5), ("model_vops_nolists_second", 0.5),
          ("model_vops_hidden_second", 0.5), ("job_minimum", 1)]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_video_ops_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a1e@x.io'),(%s,'b1e@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A1E','org-a1e'),(%s,'B1E','org-b1e')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a1e@x.io','viewer'),(%s,%s,'b1e@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "video.acme_ops", "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "video", **extra}}
            for m, caps, extra, unit in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    d.rows = rows
    for m, caps, _x, _u in MODELS:
        if m == "vops-hidden":
            continue  # never probed, never listed: the owner has not said yes
        d.su("select public.record_model_probe(%s, 'video.acme_ops', %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, "acme-" + m, caps[0]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values "
         + ", ".join(f"('{u}', {c}, 0)" for u, c in PRICES)
         + " on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.assets = {
        "a_mp4": media(d, ORG_A, "video", "video/mp4", 12.2),
        "a_mov": media(d, ORG_A, "video", "video/quicktime", 30),
        "a_long": media(d, ORG_A, "video", "video/mp4", 30.4),
        "a_nolen": media(d, ORG_A, "video", "video/mp4", None),
        "a_avi": media(d, ORG_A, "video", "video/x-msvideo", 5),
        "a_big": media(d, ORG_A, "video", "video/mp4", 10, size=26 * 1024 * 1024),
        "a_edge": media(d, ORG_A, "video", "video/mp4", 10, size=25 * 1024 * 1024),
        "a_mp3": media(d, ORG_A, "audio", "audio/mpeg", 10),
        "a_png": media(d, ORG_A, "image", "image/png", None),
        "a_deleted": media(d, ORG_A, "video", "video/mp4", 5),
        "b_mp4": media(d, ORG_B, "video", "video/mp4", 8),
    }
    d.act("authenticated", UA, "select public.soft_delete_asset(%s)", [d.assets["a_deleted"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def edit(src, words="make it night", **more):
    return {"source_asset_id": src, "prompt": words, **more}


def reframe(src, shape="9:16", **more):
    return {"source_asset_id": src, "aspect_ratio": shape, **more}


def cutout(src, **more):
    return {"source_asset_id": src, **more}


CALLS = {"video_edit": edit, "video_reframe": reframe, "video_remove_bg": cutout}


# ── the price: the video's measured seconds at the model's rate ──────────────

@pytest.mark.parametrize("cap", sorted(CALLS))
def test_quantity_is_the_videos_measured_seconds_never_the_clients(db, cap):
    q = quote(db, UA, ORG_A, cap, "vops", CALLS[cap](db.assets["a_mp4"]))
    # 12.2 s -> 13 s x 0.5 credits.
    assert (q["quantity"], q["unit"], q["credits"], q["capability"]) == (13, "model_vops_second", 6.5, cap)
    assert "margin" not in q
    q = quote(db, UA, ORG_A, cap, "vops", CALLS[cap](db.assets["a_mov"]))
    assert (q["quantity"], q["credits"]) == (30, 15)


@pytest.mark.parametrize("cap", sorted(CALLS))
@pytest.mark.parametrize("extra", [{"duration_s": 1}, {"duration_s": 30}])
def test_a_length_sent_by_the_client_is_refused_not_priced(db, cap, extra):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, "vops", {**CALLS[cap](db.assets["a_mp4"]), **extra}))
    assert (st, word) == ("NS400", "invalid_params") and "duration_s does not apply" in detail


def test_created_job_keeps_the_databases_quantity_and_holds_exactly_the_quote(db):
    drain(db)
    j = create(db, UA, ORG_A, "video_edit", "vops", edit(db.assets["a_mp4"]))["job"]
    row = db.su("select quantity::float, quoted_credits::float, credit_unit from public.creative_jobs where id=%s",
                [j["id"]])[0]
    assert row == (13.0, 6.5, "model_vops_second")
    assert db.su("select amount::float from public.credit_reservations where job_id=%s",
                 ["cj:" + j["id"]]) == [(6.5,)]
    drain(db)


def test_the_confirmed_price_is_still_the_ceiling(db):
    st, word, _ = err(lambda: create(db, UA, ORG_A, "video_remove_bg", "vops", cutout(db.assets["a_mp4"]), maxc=6))
    assert (st, word) == ("NS409", "price_changed")


@pytest.mark.parametrize("cap", sorted(CALLS))
def test_a_model_without_a_price_row_is_unpriced_never_free(db, cap):
    drain(db)
    before = footprint(db, ORG_A)
    for fn in (quote, create):
        st, word, _ = err(lambda: fn(db, UA, ORG_A, cap, "vops-unpriced", CALLS[cap](db.assets["a_mp4"])))
        assert (st, word) == ("NS400", "unpriced"), cap
    assert footprint(db, ORG_A) == before


def test_a_model_that_was_never_probed_is_not_sold_at_any_price(db):
    drain(db)
    before = footprint(db, ORG_A)
    for fn in (quote, create):
        st, word, _ = err(lambda: fn(db, UA, ORG_A, "video_edit", "vops-hidden", edit(db.assets["a_mp4"])))
        assert (st, word) == ("NS400", "model_not_sellable")
    assert footprint(db, ORG_A) == before


def test_a_model_is_only_sold_the_ops_it_lists(db):
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "video_edit", "vops-nolists", edit(db.assets["a_mp4"])))
    assert (st, word) == ("NS400", "model_not_sellable")
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "video_upscale", "vops",
                                    {"source_asset_id": db.assets["a_mp4"], "target_resolution": "4k"}))
    assert (st, word) == ("NS400", "model_not_sellable")


def test_nothing_is_sold_until_a_model_lists_the_ops_and_has_a_price(db):
    db.su("update public.model_registry set availability='hidden' where id in ('vops', 'vops-nolimit', 'vops-nolists')")
    try:
        for cap in CALLS:
            assert db.act("authenticated", UA, "select id from public.sellable_models(%s, 'web')", [cap]) == []
    finally:
        db.su("update public.model_registry set availability='beta' where id in ('vops', 'vops-nolimit', 'vops-nolists')")


# ── the model's longest input ────────────────────────────────────────────────

@pytest.mark.parametrize("cap", sorted(CALLS))
def test_longer_than_the_model_takes_is_refused_before_any_hold(db, cap):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, cap, "vops", CALLS[cap](db.assets["a_long"])))
    assert (st, word) == ("NS400", "source_unavailable") and "up to 30 seconds" in detail
    assert footprint(db, ORG_A) == before


@pytest.mark.parametrize("cap", sorted(CALLS))
def test_a_model_that_states_no_longest_input_is_not_sold_a_length(db, cap):
    st, word, _ = err(lambda: quote(db, UA, ORG_A, cap, "vops-nolimit", CALLS[cap](db.assets["a_mp4"])))
    assert (st, word) == ("NS400", "model_not_sellable")


# ── the shape of a reframe ───────────────────────────────────────────────────

@pytest.mark.parametrize("shape", ["16:9", "9:16"])
def test_a_reframe_to_a_shape_the_model_lists_is_priced(db, shape):
    assert quote(db, UA, ORG_A, "video_reframe", "vops", reframe(db.assets["a_mp4"], shape))["credits"] == 6.5


@pytest.mark.parametrize("shape", ["1:1", "4:3", "3:4"])
def test_a_shape_of_the_closed_list_the_model_was_not_proven_for_is_refused(db, shape):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "video_reframe", "vops", reframe(db.assets["a_mp4"], shape)))
    assert (st, word) == ("NS400", "invalid_params") and f"does not reframe a video to {shape}" in detail


def test_a_model_without_a_list_is_not_sold_any_shape(db):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "video_reframe", "vops-nolists", reframe(db.assets["a_mp4"])))
    assert (st, word) == ("NS400", "invalid_params") and "does not reframe a video to 9:16" in detail


def test_changing_the_shapes_needs_a_new_probe(db):
    rows = [dict(r, spec={**r["spec"], "aspect_ratios": SHAPES + ["1:1"],
                          "aspect_ratios_by_capability": {"video_reframe": SHAPES + ["1:1"]}})
            if r["id"] == "vops-nolimit" else r for r in db.rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    assert db.su("select availability, verified_at is null from public.model_registry where id='vops-nolimit'") == \
        [("hidden", True)]
    # A model whose lists did not change keeps its proof.
    assert db.su("select availability from public.model_registry where id='vops'") == [("beta",)]


@pytest.mark.parametrize("cap,model,params,why", [
    ("video_edit", "vops", {"source_asset_id": "SRC"}, "prompt is required"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": " "}, "prompt is required"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": 4}, "prompt is required"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "a" * 501}, "longer than 500"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "one\ntwo"}, "plain text"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "one\u2028two"}, "plain text"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "one\u2029two"}, "plain text"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "x", "aspect_ratio": "16:9"}, "aspect_ratio does not apply"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "x", "negative_prompt": "y"}, "does not apply"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "x", "resolution": "1080p"}, "does not apply"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "x", "seed": 1}, "does not apply"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "x", "look": "warm"}, "look does not apply"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "x", "target_resolution": "4k"}, "does not apply"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "x", "style_kit_id": str(uuid.uuid4())}, "does not apply"),
    ("video_edit", "vops", {"source_asset_id": "SRC", "prompt": "x", "audio": True}, "does not apply"),
    ("video_edit", "vops", {"prompt": "x"}, "source_asset_id"),
    ("video_edit", "vops", {"source_asset_id": "https://evil.example/a.mp4", "prompt": "x"}, "source_asset_id"),
    ("video_edit", "vops", {"source_asset_id": "PNG_NOT_A_UUID", "prompt": "x"}, "source_asset_id"),
    ("video_reframe", "vops", {"source_asset_id": "SRC"}, "aspect_ratio must be one of"),
    ("video_reframe", "vops", {"source_asset_id": "SRC", "aspect_ratio": "21:9"}, "aspect_ratio must be one of"),
    ("video_reframe", "vops", {"source_asset_id": "SRC", "aspect_ratio": None}, "aspect_ratio must look like"),
    ("video_reframe", "vops", {"source_asset_id": "SRC", "aspect_ratio": "9:16", "prompt": "x"}, "prompt does not apply"),
    ("video_reframe", "vops", {"source_asset_id": "SRC", "aspect_ratio": "9:16", "negative_prompt": "x"}, "does not apply"),
    ("video_reframe", "vops", {"source_asset_id": "SRC", "aspect_ratio": "9:16", "resolution": "720p"}, "does not apply"),
    ("video_reframe", "vops", {"source_asset_id": "SRC", "aspect_ratio": "9:16", "seed": 2}, "does not apply"),
    ("video_remove_bg", "vops", {"source_asset_id": "SRC", "prompt": "x"}, "prompt does not apply"),
    ("video_remove_bg", "vops", {"source_asset_id": "SRC", "aspect_ratio": "9:16"}, "aspect_ratio does not apply"),
    ("video_remove_bg", "vops", {"source_asset_id": "SRC", "factor": 2}, "does not apply"),
    ("video_remove_bg", "vops", {}, "source_asset_id"),
    ("t2v", "vops", {"prompt": "x", "duration_s": 5, "source_asset_id": "SRC"}, "does not apply"),
    ("upscale", "vops", {"source_asset_id": "SRC", "factor": 2, "prompt": "x", "look": "warm"}, "look does not apply"),
])
def test_param_refusals(db, cap, model, params, why):
    params = {k: db.assets["a_mp4"] if v == "SRC" else v for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, model, params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)


def test_the_longest_prompt_is_accepted_and_hostile_text_is_data(db):
    src = db.assets["a_mp4"]
    assert quote(db, UA, ORG_A, "video_edit", "vops", edit(src, "a" * 500))["credits"] == 6.5
    weird = "make it \"night\"'; drop table public.creative_jobs; -- <script>"
    assert quote(db, UA, ORG_A, "video_edit", "vops", edit(src, weird))["credits"] == 6.5
    assert db.su("select to_regclass('public.creative_jobs') is not null") == [(True,)]


# ── the video must be the organization's own ─────────────────────────────────

@pytest.mark.parametrize("cap", sorted(CALLS))
@pytest.mark.parametrize("call", ["quote", "create"])
def test_another_orgs_video_reads_like_one_that_does_not_exist(db, cap, call):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    st, word, detail = err(lambda: fn(db, UB, ORG_B, cap, "vops", CALLS[cap](db.assets["a_mp4"])))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, cap, "vops", CALLS[cap](str(uuid.uuid4()))))
    assert (st, word) == ("NS400", "source_unavailable"), (st, word)
    assert (st, word, detail) == (st2, word2, detail2)
    assert db.assets["a_mp4"] not in detail
    assert footprint(db, ORG_B) == before


@pytest.mark.parametrize("cap", sorted(CALLS))
def test_alice_cannot_use_bobs_video_and_a_stranger_cannot_spend_in_her_org(db, cap):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: create(db, UA, ORG_A, cap, "vops", CALLS[cap](db.assets["b_mp4"])))
    assert (st, word) == ("NS400", "source_unavailable")
    assert footprint(db, ORG_A) == before
    st, _, _ = err(lambda: create(db, UB, ORG_A, cap, "vops", CALLS[cap](db.assets["a_mp4"])))
    assert st == "42501"


@pytest.mark.parametrize("key,why", [
    ("a_deleted", "no video in this organization"),
    ("a_mp3", "must be a video"),
    ("a_png", "must be a video"),
    ("a_avi", "MP4, MOV, WebM or MKV"),
    ("a_nolen", "not known"),
    ("a_big", "larger than 25 MB"),
])
@pytest.mark.parametrize("cap", sorted(CALLS))
def test_unusable_videos_are_refused_before_any_hold(db, cap, key, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, cap, "vops", CALLS[cap](db.assets[key])))
    assert (st, word) == ("NS400", "source_unavailable") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


@pytest.mark.parametrize("cap", sorted(CALLS))
def test_a_video_of_exactly_25_mb_is_fine(db, cap):
    assert quote(db, UA, ORG_A, cap, "vops", CALLS[cap](db.assets["a_edge"]))["quantity"] == 10


# ── what applying the migration left alone ───────────────────────────────────

def test_the_earlier_tools_are_checked_exactly_as_before(db):
    ok = "00000000-0000-4000-8000-000000000000"
    for cap, params in (("captions", {"source_asset_id": ok, "language": "uz"}),
                        ("video_upscale", {"source_asset_id": ok, "target_resolution": "4k"}),
                        ("expand", {"source_asset_id": ok, "aspect_ratio": "16:9"}),
                        ("relight", {"source_asset_id": ok, "look": "warm"}),
                        ("erase", {"source_asset_id": ok, "prompt": "the car"}),
                        ("upscale", {"source_asset_id": ok, "factor": 2}),
                        ("dub", {"source_asset_id": ok, "target_language": "ru"})):
        assert db.su("select public.creative_params_problem(%s, %s::jsonb) is null", [cap, json.dumps(params)]) == [(True,)], cap
    assert db.su("select public.creative_quantity('erase', '{}'::jsonb), public.creative_quantity('upscale', '{\"factor\":4}'::jsonb)") == [(1, 4)]
    # A video upscale still says "upscaled" and is still limited to 200 MB (a 26 MB video is fine for it).
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "video_upscale", "vops",
                                         {"source_asset_id": db.assets["a_avi"], "target_resolution": "4k"}))
    assert (st, word) == ("NS400", "source_unavailable") and "cannot be upscaled" in detail
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "video_upscale", "vops",
                                    {"source_asset_id": db.assets["a_big"], "target_resolution": "4k"}))
    assert (st, word) == ("NS400", "model_not_sellable")


def test_sellable_models_lists_the_shapes_and_never_the_margin(db):
    rows = db.act("authenticated", UA, "select id, spec, margin, credits_per_unit::float "
                                       "from public.sellable_models('video_reframe', 'web')")
    by = {r[0]: r for r in rows}
    assert set(by) == {"vops", "vops-nolists"}   # the unpriced one is not listed; "vops-nolimit" lost its proof above
    assert by["vops"][1]["aspect_ratios_by_capability"] == {"video_reframe": SHAPES}
    assert by["vops"][1]["limits"]["max_source_seconds"] == 30
    assert by["vops"][2] is None and by["vops"][3] == 0.5
    assert "vendor_model" not in by["vops"][1] and "pricing" not in by["vops"][1]


def test_an_unknown_capability_is_still_refused_by_sellable_models(db):
    with pytest.raises(psycopg.Error) as e:
        db.act("authenticated", UA, "select * from public.sellable_models('video_inpaint', 'web')")
    assert e.value.sqlstate == "22023"


def test_the_registry_accepts_the_new_capabilities_and_no_others(db):
    db.su("update public.model_registry set capabilities = array['video_edit','video_reframe','video_remove_bg','video_upscale'] where id='vops-hidden'")
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.model_registry set capabilities = array['video_edit','video_inpaint'] where id='vops-hidden'")
    assert e.value.sqlstate == "23514"
    db.su("update public.model_registry set capabilities = array['video_edit'] where id='vops-hidden'")
    with pytest.raises(psycopg.Error) as e:
        db.su("select public.record_model_probe('vops', 'video.acme_ops', 'acme-vops', 'video_inpaint', true, null, null, 10, 1, 'x')")
    assert e.value.sqlstate in ("23514", "22023")


# ── the worker's side ────────────────────────────────────────────────────────

@pytest.mark.parametrize("cap", sorted(CALLS))
def test_worker_reads_the_video_of_its_own_running_job_only(db, cap):
    drain(db)
    j = create(db, UA, ORG_A, cap, "vops", CALLS[cap](db.assets["a_mov"]))["job"]
    assert svc(db, "select id::text from public.claim_creative_job('w1')")[0][0] == j["id"]
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is True and out["asset_id"] == db.assets["a_mov"]
    assert (out["kind"], out["mime"], float(out["duration_s"])) == ("video", "video/quicktime", 30.0)
    assert svc(db, "select public.creative_job_source(%s, 'w2')", [j["id"]])[0][0]["ok"] is False
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_a_video_deleted_after_create_fails_and_releases_in_full(db):
    drain(db)
    vid = media(db, ORG_A, "video", "video/mp4", 5)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "video_remove_bg", "vops", cutout(vid))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    db.act("authenticated", UA, "select public.soft_delete_asset(%s)", [vid])
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is False and "no video in this organization" in out["problem"]
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'source_unavailable',%s)",
               [j["id"], out["problem"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]
    assert db.su("select status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == [("released",)]


@pytest.mark.parametrize("cap", sorted(CALLS))
def test_a_provider_failure_after_submit_releases_the_hold(db, cap):
    drain(db)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, cap, "vops", CALLS[cap](db.assets["a_mp4"]))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','0f0e0d0c-0000-4000-8000-000000000001')", [j["id"]])
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'bad_request','failed')", [j["id"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]


# ── nobody reaches the internals through the API ─────────────────────────────

@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA), ("authenticated", UB)])
@pytest.mark.parametrize("query", [
    "select public.creative_params_problem('video_edit', jsonb_build_object('source_asset_id', %(asset)s::text, 'prompt', 'x'))",
    "select public.creative_source_problem(%(org)s, 'video_reframe', jsonb_build_object('source_asset_id', %(asset)s::text))",
    "select public.creative_capability_supported('video_edit')",
    "select public.creative_job_source(%(job)s, 'w1')",
    "select public.creative_price(%(org)s, 'video_remove_bg', 'vops', jsonb_build_object('source_asset_id', %(asset)s::text))",
])
def test_no_browser_reaches_the_internal_or_worker_side(db, role, uid, query):
    job = db.su("select id::text from public.creative_jobs where org_id=%s limit 1", [ORG_A])[0][0]
    with pytest.raises(psycopg.Error) as e:
        db.act(role, uid, query, {"job": job, "asset": db.assets["a_mp4"], "org": ORG_A})
    assert e.value.sqlstate == "42501"


def test_anon_cannot_quote_or_list(db):
    with pytest.raises(psycopg.Error) as e:
        db.act("anon", None, "select public.quote_creative_job(%s,'video_remove_bg','vops',%s::jsonb)",
               [ORG_A, json.dumps(cutout(db.assets["a_mp4"]))])
    assert e.value.sqlstate == "42501"
    with pytest.raises(psycopg.Error) as e:
        db.act("anon", None, "select * from public.sellable_models('video_edit', 'web')")
    assert e.value.sqlstate == "42501"
