"""The video tools (0052), attacked in a real database: an upscale of a library
video, and an image-to-video that ends on a chosen picture.

Both name their inputs by media asset id. The database alone decides whether
an id may be used — a VIDEO of the SAME organization, live, of a type the
provider takes, of a measured length within the model's limit; an end frame
that is a usable picture of the SAME organization — and it alone decides the
quantity of an upscale: the video's seconds from the asset row. Bob (org B)
tries to use Alice's video and Alice's picture every way the API lets him;
the answer must be exactly the answer for an id that does not exist, and
nothing may be held. A length typed by a client is refused, never priced.

Runs in its own scratch database (it commits), like the 0046 / 0050 labs.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000c7"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000c7"
UA = str(uuid.UUID(int=0xC7A))
UB = str(uuid.UUID(int=0xC7B))

TARGETS = {"by": "upscale_target", "prices": {"720p": 0.42, "4k": 0.72}}
# (id, capabilities, adapter, extra spec, credit unit)
MODELS = [
    ("vup", ["video_upscale"], "video.acme_up",
     {"upscale_targets": ["720p", "4k"], "limits": {"max_source_seconds": 30}, "pricing": {"variants": TARGETS}},
     "model_vup_second"),
    ("vup-flat", ["video_upscale"], "video.acme_up",
     {"upscale_targets": ["2k"], "limits": {"max_source_seconds": 30}}, "model_vup_flat_second"),
    ("vup-nolimit", ["video_upscale"], "video.acme_up", {"upscale_targets": ["2k"]}, "model_vup_nolimit_second"),
    ("i2v-end", ["t2v", "i2v"], "video.acme", {"end_frame": True}, "model_i2v_end_second"),
    ("i2v-plain", ["t2v", "i2v"], "video.acme", {}, "model_i2v_plain_second"),
]
# Per-target rows for "vup" (and a base row so it is listed); 1k is listed by
# no model, 2k is "vup-flat"'s single price.
PRICES = [("model_vup_second", 1), ("model_vup_second_720p", 0.5), ("model_vup_second_4k", 2),
          ("model_vup_flat_second", 1), ("model_vup_nolimit_second", 1),
          ("model_i2v_end_second", 2), ("model_i2v_plain_second", 2), ("job_minimum", 1)]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_video_tools_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a7@x.io'),(%s,'b7@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A7','org-a7'),(%s,'B7','org-b7')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a7@x.io','viewer'),(%s,%s,'b7@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": a, "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "video", **extra}}
            for m, caps, a, extra, unit in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    d.rows = rows
    for m, caps, a, _x, _u in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
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
        "a_huge": media(d, ORG_A, "video", "video/mp4", 10, size=210 * 1024 * 1024),
        "a_mp3": media(d, ORG_A, "audio", "audio/mpeg", 10),
        "a_png": media(d, ORG_A, "image", "image/png", None),
        "a_end": media(d, ORG_A, "image", "image/jpeg", None),
        "a_gif": media(d, ORG_A, "image", "image/gif", None),
        "a_vdeleted": media(d, ORG_A, "video", "video/mp4", 5),
        "a_pdeleted": media(d, ORG_A, "image", "image/png", None),
        "b_mp4": media(d, ORG_B, "video", "video/mp4", 8),
        "b_png": media(d, ORG_B, "image", "image/png", None),
    }
    for k in ("a_vdeleted", "a_pdeleted"):
        d.act("authenticated", UA, "select public.soft_delete_asset(%s)", [d.assets[k]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def media(d, org, kind, mime, seconds, size=1000):
    aid = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, %s, %s, %s, %s, 'generated', p_width => 640, p_height => 360, "
          "p_duration_s => %s::numeric, p_provenance => %s::jsonb)",
          [aid, org, kind, mime, size, uuid.uuid4().hex * 2, seconds, json.dumps({"job_id": "seed"})])
    return aid


def quote(db, uid, org, cap, model, params):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,%s,%s,%s::jsonb)",
                  [org, cap, model, json.dumps(params)])[0][0]


def create(db, uid, org, cap, model, params, maxc=10000):
    return db.act("authenticated", uid, "select public.create_creative_job(%s,%s,%s,%s::jsonb,'exact',null,%s)",
                  [org, cap, model, json.dumps(params), maxc])[0][0]


def drain(db):
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc(db, "select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


def up(src, target="720p"):
    return {"source_asset_id": src, "target_resolution": target}


def framed(src, end, seconds=5):
    return {"source_asset_id": src, "end_asset_id": end, "duration_s": seconds}


# ── the upscale's price is the video's length, from the database ────────────

def test_quantity_is_the_videos_measured_seconds_priced_per_target(db):
    q = quote(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_mp4"]))
    # 12.2 s -> 13 s x 0.5 credits (the 720p row), never the base row.
    assert (q["quantity"], q["unit"], q["credits"]) == (13, "model_vup_second_720p", 6.5)
    q = quote(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_mp4"], "4k"))
    assert (q["quantity"], q["unit"], q["credits"]) == (13, "model_vup_second_4k", 26)
    # A model priced without variants uses its one row.
    q = quote(db, UA, ORG_A, "video_upscale", "vup-flat", up(db.assets["a_mov"], "2k"))
    assert (q["quantity"], q["unit"], q["credits"]) == (30, "model_vup_flat_second", 30)


def test_created_job_keeps_the_databases_quantity_and_holds_exactly_the_quote(db):
    drain(db)
    j = create(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_mp4"], "4k"))["job"]
    row = db.su("select quantity::float, quoted_credits::float, credit_unit from public.creative_jobs where id=%s",
                [j["id"]])[0]
    assert row == (13.0, 26.0, "model_vup_second_4k")
    assert db.su("select amount::float from public.credit_reservations where job_id=%s",
                 ["cj:" + j["id"]]) == [(26.0,)]
    drain(db)


@pytest.mark.parametrize("extra", [{"duration_s": 1}, {"duration_s": 30}])
def test_a_length_sent_by_the_client_is_refused_not_priced(db, extra):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "video_upscale", "vup", {**up(db.assets["a_mp4"]), **extra}))
    assert (st, word) == ("NS400", "invalid_params") and "duration_s does not apply" in detail


def test_a_target_without_its_own_price_is_unpriced_not_sold_at_another(db):
    # "vup" lists 720p and 4k; a 4k-only price row must never price 2k.
    rows = [dict(r, spec={**r["spec"], "upscale_targets": ["720p", "4k", "1k"]}) if r["id"] == "vup" else r
            for r in db.rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    db.rows = rows
    # Listing a new target is a new claim: the model is hidden until probed again.
    assert db.su("select availability, verified_at is null from public.model_registry where id='vup'") == \
        [("hidden", True)]
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_mp4"], "1k")))
    assert (st, word) == ("NS400", "model_not_sellable")
    pid = db.su("select public.record_model_probe('vup', 'video.acme_up', 'acme-vup', 'video_upscale', true, "
                "null, null, 10, 100, 'security-lab')")[0][0]
    assert pid
    db.su("update public.model_registry set availability='beta' where id='vup'")
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_mp4"], "1k")))
    assert (st, word) == ("NS400", "unpriced")
    assert quote(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_mp4"], "4k"))["credits"] == 26


def test_the_confirmed_price_is_still_the_ceiling(db):
    st, word, _ = err(lambda: create(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_mp4"], "4k"), maxc=25))
    assert (st, word) == ("NS409", "price_changed")


def test_longer_than_the_model_takes_is_refused_before_any_hold(db):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_long"])))
    assert (st, word) == ("NS400", "source_unavailable") and "up to 30 seconds" in detail
    # Exactly the limit is fine.
    assert quote(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["a_mov"]))["quantity"] == 30
    # A model that states no longest input is not sold a length it may refuse.
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "video_upscale", "vup-nolimit", up(db.assets["a_mp4"], "2k")))
    assert (st, word) == ("NS400", "model_not_sellable")
    assert footprint(db, ORG_A) == before


# ── the video must be the organization's own ─────────────────────────────────

@pytest.mark.parametrize("call", ["quote", "create"])
def test_another_orgs_video_reads_like_one_that_does_not_exist(db, call):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    st, word, detail = err(lambda: fn(db, UB, ORG_B, "video_upscale", "vup", up(db.assets["a_mp4"])))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, "video_upscale", "vup", up(str(uuid.uuid4()))))
    assert (st, word) == ("NS400", "source_unavailable"), (st, word)
    assert (st, word, detail) == (st2, word2, detail2)
    assert db.assets["a_mp4"] not in detail
    assert footprint(db, ORG_B) == before


def test_alice_cannot_upscale_bobs_video_and_a_stranger_cannot_spend_in_her_org(db):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "video_upscale", "vup", up(db.assets["b_mp4"])))
    assert (st, word) == ("NS400", "source_unavailable")
    assert footprint(db, ORG_A) == before
    st, _, _ = err(lambda: create(db, UB, ORG_A, "video_upscale", "vup", up(db.assets["a_mp4"])))
    assert st == "42501"


@pytest.mark.parametrize("key,why", [
    ("a_vdeleted", "no video in this organization"),
    ("a_mp3", "must be a video"),
    ("a_png", "must be a video"),
    ("a_avi", "MP4, MOV, WebM or MKV"),
    ("a_nolen", "not known"),
    ("a_huge", "larger than 200 MB"),
])
def test_unusable_videos_are_refused_before_any_hold(db, key, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, "video_upscale", "vup", up(db.assets[key])))
    assert (st, word) == ("NS400", "source_unavailable") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


# ── the end frame must be the organization's own picture ─────────────────────

def test_an_end_frame_adds_nothing_to_the_price(db):
    plain = quote(db, UA, ORG_A, "i2v", "i2v-end", {"source_asset_id": db.assets["a_png"], "duration_s": 5})
    q = quote(db, UA, ORG_A, "i2v", "i2v-end", framed(db.assets["a_png"], db.assets["a_end"]))
    assert (q["quantity"], q["credits"]) == (plain["quantity"], plain["credits"]) == (5, 10)


@pytest.mark.parametrize("call", ["quote", "create"])
def test_another_orgs_end_frame_reads_like_one_that_does_not_exist(db, call):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    st, word, detail = err(lambda: fn(db, UB, ORG_B, "i2v", "i2v-end", framed(db.assets["b_png"], db.assets["a_end"])))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, "i2v", "i2v-end",
                                         framed(db.assets["b_png"], str(uuid.uuid4()))))
    assert (st, word) == ("NS400", "source_unavailable"), (st, word)
    assert (st, word, detail) == (st2, word2, detail2)
    assert "end_asset_id names no image" in detail and db.assets["a_end"] not in detail
    assert footprint(db, ORG_B) == before


@pytest.mark.parametrize("key,why", [
    ("a_pdeleted", "end_asset_id names no image"),
    ("a_mp4", "end frame must be an image"),
    ("a_gif", "GIF"),
])
def test_unusable_end_frames_are_refused_before_any_hold(db, key, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, "i2v", "i2v-end", framed(db.assets["a_png"], db.assets[key])))
    assert (st, word) == ("NS400", "source_unavailable") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


def test_a_model_that_would_drop_the_end_frame_is_not_sold_one(db):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "i2v", "i2v-plain", framed(db.assets["a_png"], db.assets["a_end"])))
    assert (st, word) == ("NS400", "invalid_params") and "cannot end a clip" in detail


# ── params ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cap,model,params,why", [
    ("video_upscale", "vup", {"source_asset_id": "SRC"}, "target_resolution"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "8k"}, "target_resolution"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "4K"}, "target_resolution"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": 4}, "target_resolution"),
    ("video_upscale", "vup", {"target_resolution": "4k"}, "source_asset_id"),
    ("video_upscale", "vup", {"source_asset_id": "https://evil.example/a.mp4", "target_resolution": "4k"},
     "source_asset_id"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "4k", "prompt": "x"}, "does not apply"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "4k", "factor": 4}, "does not apply"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "4k", "resolution": "2160p"},
     "does not apply"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "4k", "aspect_ratio": "16:9"},
     "does not apply"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "4k", "seed": 1}, "does not apply"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "4k",
                              "style_kit_id": str(uuid.uuid4())}, "does not apply"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "4k", "end_asset_id": "END"},
     "does not apply"),
    ("video_upscale", "vup", {"source_asset_id": "SRC", "target_resolution": "2k"}, "does not upscale a video to 2k"),
    ("upscale", "vup", {"source_asset_id": "SRC", "factor": 2, "target_resolution": "4k"}, "does not apply"),
    ("i2v", "i2v-end", {"source_asset_id": "PNG", "duration_s": 5, "end_asset_id": None}, "end_asset_id"),
    ("i2v", "i2v-end", {"source_asset_id": "PNG", "duration_s": 5, "end_asset_id": "../../etc"}, "end_asset_id"),
    ("t2v", "i2v-end", {"prompt": "x", "duration_s": 5, "end_asset_id": "END"}, "does not apply"),
    ("edit", "i2v-end", {"prompt": "x", "source_asset_id": "PNG", "end_asset_id": "END"}, "does not apply"),
])
def test_param_refusals(db, cap, model, params, why):
    sub = {"SRC": db.assets["a_mp4"], "PNG": db.assets["a_png"], "END": db.assets["a_end"]}
    params = {k: sub.get(v, v) if isinstance(v, str) else v for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, model, params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)


def test_the_picture_and_voice_tools_still_refuse_a_video_where_they_did(db):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "i2v", "i2v-end",
                                         {"source_asset_id": db.assets["a_mp4"], "duration_s": 5}))
    assert (st, word) == ("NS400", "source_unavailable") and "must be an image" in detail


def test_an_end_frame_claim_needs_a_new_probe(db):
    rows = [dict(r, spec={**r["spec"], "end_frame": True}) if r["id"] == "i2v-plain" else r for r in db.rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    assert db.su("select availability, verified_at is null from public.model_registry where id='i2v-plain'") == \
        [("hidden", True)]
    assert db.su("select availability from public.model_registry where id='i2v-end'") == [("beta",)]


def test_sellable_models_shows_targets_and_the_end_frame(db):
    rows = db.act("authenticated", UA, "select id, spec from public.sellable_models(null, 'web')")
    by = {r[0]: r[1] for r in rows}
    assert by["vup-flat"]["upscale_targets"] == ["2k"]
    assert by["vup-flat"]["limits"]["max_source_seconds"] == 30
    assert by["i2v-end"]["end_frame"] is True
    assert "vendor_model" not in by["i2v-end"] and "pricing" not in by["vup-flat"]


# ── the worker's side ────────────────────────────────────────────────────────

def test_worker_reads_the_video_of_its_own_running_job_only(db):
    drain(db)
    j = create(db, UA, ORG_A, "video_upscale", "vup-flat", up(db.assets["a_mov"], "2k"))["job"]
    assert svc(db, "select id::text from public.claim_creative_job('w1')")[0][0] == j["id"]
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is True and out["asset_id"] == db.assets["a_mov"]
    assert (out["kind"], out["mime"], float(out["duration_s"])) == ("video", "video/quicktime", 30.0)
    assert "end_frame" not in out
    assert svc(db, "select public.creative_job_source(%s, 'w2')", [j["id"]])[0][0]["ok"] is False
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_worker_reads_the_end_frame_with_the_first(db):
    drain(db)
    j = create(db, UA, ORG_A, "i2v", "i2v-end", framed(db.assets["a_png"], db.assets["a_end"]))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is True and out["asset_id"] == db.assets["a_png"]
    assert out["end_frame"] == {"asset_id": db.assets["a_end"], "mime": "image/jpeg", "kind": "image",
                                "variants": []}
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_an_end_frame_deleted_after_create_fails_and_releases_in_full(db):
    drain(db)
    end = media(db, ORG_A, "image", "image/webp", None)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "i2v", "i2v-end", framed(db.assets["a_png"], end))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    db.act("authenticated", UA, "select public.soft_delete_asset(%s)", [end])
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is False and "end_asset_id names no image" in out["problem"]
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'source_unavailable',%s)",
               [j["id"], out["problem"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]
    assert db.su("select status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == [("released",)]


def test_a_provider_failure_after_submit_releases_the_hold(db):
    drain(db)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "video_upscale", "vup-flat", up(db.assets["a_mp4"], "2k"))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','0f0e0d0c-0000-4000-8000-000000000001')",
        [j["id"]])
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'bad_request','upscale failed')",
               [j["id"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]


@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA), ("authenticated", UB)])
@pytest.mark.parametrize("query", [
    "select public.creative_picture_problem(%(org)s, %(asset)s::uuid, 'end_asset_id')",
    "select public.creative_source_problem(%(org)s, 'video_upscale', jsonb_build_object('source_asset_id', %(asset)s::text))",
    "select public.creative_source_seconds(%(org)s, jsonb_build_object('source_asset_id', %(asset)s::text))",
    "select public.creative_job_source(%(job)s, 'w1')",
    "select public.creative_price(%(org)s, 'video_upscale', 'vup', jsonb_build_object('source_asset_id', %(asset)s::text,"
    " 'target_resolution', '720p'))",
])
def test_no_browser_reaches_the_internal_or_worker_side(db, role, uid, query):
    job = db.su("select id::text from public.creative_jobs where org_id=%s limit 1", [ORG_A])[0][0]
    with pytest.raises(psycopg.Error) as e:
        db.act(role, uid, query, {"job": job, "asset": db.assets["a_mp4"], "org": ORG_A})
    assert e.value.sqlstate == "42501"
