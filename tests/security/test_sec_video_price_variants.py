"""Video price variants (0070), attacked in a real database.

A video is quoted, held and charged at the price of the RESOLUTION and
SOUNDTRACK it is made with. The browser may name them; the database alone
decides whether this model sells them, what each costs, and what an absent
setting means (the model's pinned resolution, silent — what the worker sends).
What must hold:

* each variant's own credit_prices row prices it (model_<id>_second_<variant>)
  and the quote names it; a variant without a row is 'unpriced' — never the
  base row's rate, never another variant's, never 0;
* a resolution the model does not list, a non-boolean audio, audio on a model
  that does not price it, and audio on another capability are refused before
  any hold, and a refusal leaves no trace;
* a model that pins no resolution (Veo, Wan 3.0) is still sold by its base row;
* sellable_models carries the pinned resolution and lists a model priced by
  variants only while one of its variants has a price;
* 0070 is built on 0052 / 0055 / 0060: the per-target upscale price, the
  quality tier and the describe rules still answer exactly as before;
* the hold is the quote of that variant and the confirmed price is the ceiling,
  and the job carries the resolution and soundtrack it was priced at (the worker
  sends exactly them and has no default of its own), 0060's stored tier kept;
* the starting rows never overwrite a price the owner set.

Runs in its own scratch database (it commits), like the 0060 lab.
"""
import json
import os
import re
import uuid
from pathlib import Path

import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc
from test_sec_describe_image import pic

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000f0"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000f0"
UA = str(uuid.UUID(int=0xF0A))
UB = str(uuid.UUID(int=0xF0B))

MIGRATION = Path(sec_db.MIGRATIONS) / "0070_video_price_variants.sql"
SECONDS = 5


def _spec(by, prices, resolutions, default=None, audio=False):
    spec = {"vendor_model": "acme-vid", "output": "video", "resolutions": resolutions, "audio_out": audio,
            "pricing": {"unit": "second"}}
    if default:
        spec["default_resolution"] = default
    if by:
        spec["pricing"]["variants"] = {"by": by, "prices": prices}
    return spec


R3 = ["480p", "720p", "1080p"]
MODELS = {
    "vseed": _spec("resolution_audio", {"720p_silent": None, "720p_audio": None, "1080p_audio": None, "1080p_silent": None},
                   R3, "720p", True),
    "vwan": _spec("resolution", {"720p": None, "1080p": None}, ["720p", "1080p"], "720p"),
    "vkling": _spec("audio", {"silent": None, "audio": None}, [], None, True),
    "vveo": _spec("resolution", {"720p": None, "1080p": None, "2160p": None}, ["720p", "1080p", "2160p"]),   # pins none
    "vflat": _spec(None, None, ["720p"]),
    "vpart": _spec("audio", {"silent": None, "audio": None}, [], None, True),    # only silent has a price
    "vnone": _spec("audio", {"silent": None, "audio": None}, [], None, True),    # no variant has a price
}
#: variant row -> credits per second (margin 0, so the quote is seconds x this)
ROWS = {
    "model_vseed_second_720p_silent": 1, "model_vseed_second_720p_audio": 2, "model_vseed_second_1080p_audio": 4,
    "model_vwan_second_720p": 3, "model_vwan_second_1080p": 5,
    "model_vkling_second_silent": 2, "model_vkling_second_audio": 3,
    "model_vpart_second_silent": 2,
}
BASE = {"vseed": 9, "vwan": 9, "vkling": 9, "vveo": 7, "vflat": 6, "vpart": 9, "vnone": 9}


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_vidvar_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a9@x.io'),(%s,'b9@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A9','org-a9'),(%s,'B9','org-b9')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a9@x.io','owner'),"
         "(%s,%s,'b9@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "video.acme", "capabilities": ["t2v", "i2v"],
             "credit_unit": f"model_{m}_second", "entitlement": "any", "spec": spec} for m, spec in MODELS.items()]
    # 0052's, 0055's and 0060's tools, to prove 0070 did not take them away.
    rows += [
        {"id": "vup", "display_name": "vup", "provider": "acme", "adapter": "video.acme_up",
         "capabilities": ["video_upscale"], "credit_unit": "model_vup_second", "entitlement": "any",
         "spec": {"vendor_model": "acme-vup", "output": "video", "upscale_targets": ["2k", "4k"],
                  "pricing": {"unit": "second", "variants": {"by": "upscale_target", "prices": {"2k": 0.1, "4k": 0.2}}},
                  "limits": {"max_source_seconds": 30}}},
        {"id": "seer", "display_name": "seer", "provider": "acme", "adapter": "image.acme_describe",
         "capabilities": ["describe"], "credit_unit": "model_seer_request", "entitlement": None,
         "spec": {"vendor_model": "acme-seer", "output": "text"}},
        {"id": "qimg", "display_name": "qimg", "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i"],
         "credit_unit": "model_qimg_image", "entitlement": "any",
         "spec": {"vendor_model": "acme-img", "output": "image", "qualities": ["low", "medium", "high"],
                  "pricing": {"unit": "image", "variants": {"by": "quality", "prices": {"low": None, "medium": None, "high": None}}}}},
    ]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for r in rows:
        cap = r["capabilities"][0]
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [r["id"], r["adapter"], r["spec"]["vendor_model"], cap])
        d.su("update public.model_registry set availability='beta' where id=%s", [r["id"]])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0)"
         " on conflict (unit) do update set credits_per_unit = 1, margin = 0")
    flat = [(f"model_{m}_second", c) for m, c in BASE.items()] + [
        ("model_vup_second", 1), ("model_seer_request", 2), ("model_qimg_image", 16)]
    for unit, c in flat:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, c])
    for unit, c in ROWS.items():
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0)", [unit, c])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values "
         "('model_vup_second_2k', 1, 0), ('model_vup_second_4k', 3, 0), ('model_qimg_image_medium', 4, 0)")
    d.assets = {"a_png": pic(d, ORG_A, "image", "image/png"),
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


def t2v(**extra):
    return {"prompt": "a paper boat", "duration_s": SECONDS, **extra}


# ── the price is the variant's own ───────────────────────────────────────────

@pytest.mark.parametrize("params,unit,res,audio", [
    (t2v(), "model_vseed_second_720p_silent", "720p", False),                       # the pinned defaults
    (t2v(audio=False), "model_vseed_second_720p_silent", "720p", False),
    (t2v(audio=True), "model_vseed_second_720p_audio", "720p", True),
    (t2v(resolution="720p", audio=True), "model_vseed_second_720p_audio", "720p", True),
    (t2v(resolution="1080p", audio=True), "model_vseed_second_1080p_audio", "1080p", True),
])
def test_resolution_and_audio_price_by_their_own_row_and_the_quote_names_them(db, params, unit, res, audio):
    q = quote(db, UA, ORG_A, "t2v", "vseed", params)
    assert (q["unit"], q["credits"], q["resolution"], q["audio"]) == (unit, ROWS[unit] * SECONDS, res, audio)


def test_i2v_is_priced_by_variant_too(db):
    q = quote(db, UA, ORG_A, "i2v", "vseed", {"source_asset_id": db.assets["a_png"], "duration_s": SECONDS,
                                              "resolution": "1080p", "audio": True})
    assert (q["unit"], q["credits"]) == ("model_vseed_second_1080p_audio", 4 * SECONDS)


def test_a_resolution_only_model_is_priced_by_resolution_and_names_no_audio(db):
    for res, unit in (("720p", "model_vwan_second_720p"), ("1080p", "model_vwan_second_1080p")):
        q = quote(db, UA, ORG_A, "t2v", "vwan", t2v(resolution=res))
        assert (q["unit"], q["credits"], q["resolution"]) == (unit, ROWS[unit] * SECONDS, res) and "audio" not in q
    assert quote(db, UA, ORG_A, "t2v", "vwan", t2v())["unit"] == "model_vwan_second_720p"


def test_an_audio_only_model_is_priced_by_audio_and_names_no_resolution(db):
    for params, unit in ((t2v(), "model_vkling_second_silent"), (t2v(audio=True), "model_vkling_second_audio")):
        q = quote(db, UA, ORG_A, "t2v", "vkling", params)
        assert (q["unit"], q["credits"]) == (unit, ROWS[unit] * SECONDS) and "resolution" not in q


def test_a_variant_without_a_row_is_unpriced_never_the_base_rate_never_zero(db):
    drain(db)
    before = footprint(db, ORG_A)
    # vseed: 480p (any sound) and 1080p silent have no row, although the base row (9) exists.
    for params in (t2v(resolution="480p"), t2v(resolution="480p", audio=True), t2v(resolution="1080p")):
        st, word, _ = err(lambda p=params: quote(db, UA, ORG_A, "t2v", "vseed", p))
        assert (st, word) == ("NS400", "unpriced"), params
        st, word, _ = err(lambda p=params: create(db, UA, ORG_A, "t2v", "vseed", p))
        assert (st, word) == ("NS400", "unpriced"), params
    # vpart: only silent is priced.
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "t2v", "vpart", t2v(audio=True)))
    assert (st, word) == ("NS400", "unpriced")
    assert quote(db, UA, ORG_A, "t2v", "vpart", t2v())["credits"] == 2 * SECONDS
    assert footprint(db, ORG_A) == before


def test_a_model_that_pins_no_resolution_is_still_sold_by_its_base_row(db):
    for params in (t2v(), t2v(resolution="1080p"), t2v(resolution="2160p")):
        q = quote(db, UA, ORG_A, "t2v", "vveo", params)
        assert (q["unit"], q["credits"]) == ("model_vveo_second", BASE["vveo"] * SECONDS), params
        assert "resolution" not in q and "audio" not in q


def test_a_model_without_variants_keeps_its_flat_price(db):
    q = quote(db, UA, ORG_A, "t2v", "vflat", t2v())
    assert (q["unit"], q["credits"]) == ("model_vflat_second", BASE["vflat"] * SECONDS) and "audio" not in q


# ── what is refused ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("model,params,why", [
    ("vseed", t2v(resolution="1440p"), "does not offer"),                 # not listed by the model
    ("vwan", t2v(resolution="480p"), "does not offer"),
    ("vwan", t2v(resolution="2160p"), "does not offer"),
    ("vkling", t2v(resolution="720p"), "does not offer"),              # lists none
    ("vflat", t2v(resolution="1080p"), "does not offer"),
    ("vseed", t2v(audio="yes"), "audio must be true or false"),
    ("vseed", t2v(audio=1), "audio must be true or false"),
    ("vseed", t2v(audio=None), "audio must be true or false"),
    ("vseed", t2v(audio=["true"]), "audio must be true or false"),
    ("vwan", t2v(audio=True), "does not offer a choice of sound"),     # makes no sound
    ("vwan", t2v(audio=False), "does not offer a choice of sound"),    # nothing for the worker to send
    ("vflat", t2v(audio=True), "does not offer a choice of sound"),
    ("vveo", t2v(audio=True), "does not offer a choice of sound"),     # priced by resolution only
])
def test_a_setting_the_model_does_not_sell_is_refused_before_any_hold(db, model, params, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "t2v", model, params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "t2v", model, params))
    assert (st, word) == ("NS400", "invalid_params")
    assert footprint(db, ORG_A) == before


@pytest.mark.parametrize("cap,params", [
    ("t2i", {"prompt": "x", "audio": True}),
    ("tts", {"prompt": "x", "audio": True}),
    ("upscale", {"source_asset_id": "SRC", "factor": 2, "audio": True}),
    ("describe", {"source_asset_id": "SRC", "audio": False}),
    ("video_upscale", {"source_asset_id": "VID", "target_resolution": "4k", "audio": True}),
])
def test_audio_on_a_capability_without_a_soundtrack_choice_is_refused(db, cap, params):
    params = {k: ({"SRC": db.assets["a_png"], "VID": db.assets["a_mp4"]}.get(v, v) if isinstance(v, str) else v)
              for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, "vseed", params))
    assert (st, word) == ("NS400", "invalid_params") and "audio does not apply" in detail, (st, word, detail)


def test_a_stray_price_row_does_not_sell_a_resolution_the_model_never_listed(db):
    db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_vwan_second_1440p', 1, 0)"
          " on conflict (unit) do nothing")
    try:
        st, word, detail = err(lambda: quote(db, UA, ORG_A, "t2v", "vwan", t2v(resolution="1440p")))
        assert (st, word) == ("NS400", "invalid_params") and "does not offer" in detail
    finally:
        db.su("delete from public.credit_prices where unit = 'model_vwan_second_1440p'")


def test_a_zero_price_row_is_a_price_of_zero_only_if_the_owner_set_it_and_is_not_listed_for_sale(db):
    # A variant at 0 credits must never make a model "sellable" by itself.
    db.su("update public.credit_prices set credits_per_unit = 0 where unit = 'model_vpart_second_silent'")
    try:
        ids = {r[0] for r in db.act("authenticated", UA, "select id from public.sellable_models('t2v')")}
        assert "vpart" not in ids
    finally:
        db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vpart_second_silent'")


# ── money: the hold is the variant's quote ───────────────────────────────────

def test_the_hold_is_the_variants_price_and_the_confirmed_price_is_the_ceiling(db):
    drain(db)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "t2v", "vseed", t2v(resolution="1080p", audio=True),
                                     maxc=ROWS["model_vseed_second_720p_audio"] * SECONDS))
    assert (st, word) == ("NS409", "price_changed")
    j = create(db, UA, ORG_A, "t2v", "vseed", t2v(audio=True), maxc=2 * SECONDS)["job"]
    assert float(j["quoted_credits"]) == 2 * SECONDS and j["params"]["audio"] is True
    assert db.su("select amount::float from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == \
        [(float(2 * SECONDS),)]
    drain(db)


def unit_of(db, job):
    return db.su("select credit_unit from public.creative_jobs where id=%s", [job["id"]])[0][0]


@pytest.mark.parametrize("model,params,stored,unit,per_s", [
    # The worker sends exactly params.resolution / params.audio and has no default of its own:
    # the database writes down what it priced.
    ("vseed", {}, {"resolution": "720p", "audio": False}, "model_vseed_second_720p_silent", 1),
    ("vseed", {"audio": True}, {"resolution": "720p", "audio": True}, "model_vseed_second_720p_audio", 2),
    ("vseed", {"resolution": "1080p", "audio": True}, {"resolution": "1080p", "audio": True},
     "model_vseed_second_1080p_audio", 4),
    ("vwan", {}, {"resolution": "720p"}, "model_vwan_second_720p", 3),
    ("vwan", {"resolution": "1080p"}, {"resolution": "1080p"}, "model_vwan_second_1080p", 5),
    ("vkling", {}, {"audio": False}, "model_vkling_second_silent", 2),
    ("vkling", {"audio": True}, {"audio": True}, "model_vkling_second_audio", 3),
])
def test_the_job_carries_the_resolution_and_sound_it_was_priced_at(db, model, params, stored, unit, per_s):
    drain(db)
    j = create(db, UA, ORG_A, "t2v", model, t2v(**params), maxc=per_s * SECONDS)["job"]
    assert float(j["quoted_credits"]) == per_s * SECONDS and unit_of(db, j) == unit
    # the stored params are what the caller sent plus exactly the priced settings, nothing else changed
    assert j["params"] == {**t2v(**params), **stored}
    drain(db)


@pytest.mark.parametrize("model", ["vveo", "vflat"])
def test_a_model_priced_by_no_setting_stores_none(db, model):
    drain(db)
    j = create(db, UA, ORG_A, "t2v", model, t2v())["job"]
    assert "resolution" not in j["params"] and "audio" not in j["params"]
    assert unit_of(db, j) == f"model_{model}_second"
    drain(db)


def test_i2v_carries_its_priced_settings_too(db):
    drain(db)
    params = {"source_asset_id": db.assets["a_png"], "duration_s": SECONDS}
    j = create(db, UA, ORG_A, "i2v", "vseed", params)["job"]
    assert j["params"] == {**params, "resolution": "720p", "audio": False}
    drain(db)


def test_a_replayed_key_is_still_a_replay_and_a_changed_setting_under_one_key_is_a_conflict(db):
    drain(db)
    key = "studio:" + uuid.uuid4().hex

    def go(params):
        return db.act("authenticated", UA,
                      "select public.create_creative_job(%s,'t2v','vseed',%s::jsonb,'exact',%s::text,1000)",
                      [ORG_A, json.dumps(params), key])[0][0]
    first = go(t2v())                                # nothing named: priced and stored as 720p silent
    again = go(t2v())                                # same request, same key
    assert again["replay"] is True and again["job"]["id"] == first["job"]["id"]
    st, word, _ = err(lambda: go(t2v(audio=True)))
    assert (st, word) == ("NS409", "idempotency_conflict")
    assert db.su("select count(*) from public.credit_reservations where job_id=%s", ["cj:" + first["job"]["id"]]) == [(1,)]
    drain(db)


def test_the_quality_tier_is_still_stored_by_the_replaced_create(db):
    drain(db)
    j = create(db, UA, ORG_A, "t2i", "qimg", {"prompt": "x"})["job"]
    assert j["params"]["quality"] == "medium" and unit_of(db, j) == "model_qimg_image_medium"
    drain(db)


def test_a_failure_releases_the_variants_hold_in_full(db):
    drain(db)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "t2v", "vseed", t2v(resolution="1080p", audio=True))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'policy','refused')", [j["id"]])[0][0]
    assert done["status"] == "failed" and float(done["charged_credits"]) == 0
    assert footprint(db, ORG_A)[2] == before[2]


def test_a_member_of_another_org_cannot_quote_or_create_here(db):
    st, _, _ = err(lambda: quote(db, UB, ORG_A, "t2v", "vseed", t2v(audio=True)))
    assert st == "42501"
    st, _, _ = err(lambda: db.act("anon", None, "select public.quote_creative_job(%s,'t2v','vseed',%s::jsonb)",
                                  [ORG_A, json.dumps(t2v())]))
    assert st == "42501"


# ── the model list ───────────────────────────────────────────────────────────

def _sellable(db, cap="t2v"):
    return {r[0]: r[1] for r in db.act("authenticated", UA, "select id, spec from public.sellable_models(%s)", [cap])}


def test_the_list_carries_the_pinned_resolution_and_hides_a_model_with_no_priced_variant(db):
    got = _sellable(db)
    assert got["vseed"]["default_resolution"] == "720p" and got["vseed"]["price_variants_by"] == "resolution_audio"
    assert got["vseed"]["resolutions"] == R3 and got["vseed"]["audio_out"] is True
    assert "vpart" in got                 # one variant (silent) is priced
    assert "vnone" not in got             # a base price alone does not sell a model priced by variants
    assert "default_resolution" not in got["vflat"] and "price_variants_by" not in got["vflat"]
    assert "vveo" in got                  # no pinned resolution: sold by its base row as before
    assert "vwan" in got and "vkling" in got


def test_the_public_spec_never_carries_provider_costs(db):
    spec = _sellable(db)["vseed"]
    assert "pricing" not in spec and "probe" not in spec and "vendor_model" not in spec


def test_the_list_is_closed_to_anon(db):
    st, _, _ = err(lambda: db.act("anon", None, "select * from public.sellable_models('t2v')"))
    assert st == "42501"


# ── built on 0052 / 0055 / 0060 ──────────────────────────────────────────────

def test_video_upscale_is_still_priced_per_target(db):
    q = quote(db, UA, ORG_A, "video_upscale", "vup", {"source_asset_id": db.assets["a_mp4"], "target_resolution": "4k"})
    assert q["unit"] == "model_vup_second_4k" and "audio" not in q and "resolution" not in q


def test_describe_still_quotes_one_request(db):
    q = quote(db, UA, ORG_A, "describe", "seer", {"source_asset_id": db.assets["a_png"], "language": "uz"})
    assert (q["quantity"], q["unit"]) == (1, "model_seer_request")


def test_the_quality_tier_is_still_priced(db):
    q = quote(db, UA, ORG_A, "t2i", "qimg", {"prompt": "x", "quality": "medium"})
    assert (q["unit"], q["quality"]) == ("model_qimg_image_medium", "medium") and "audio" not in q
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "t2i", "qimg", {"prompt": "x", "quality": "ultra"}))
    assert (st, word) == ("NS400", "invalid_params")


def test_the_replaced_functions_stay_closed_to_the_api(db):
    for fn in ("creative_price(uuid,text,text,jsonb)", "creative_params_problem(text,jsonb)"):
        for role in ("anon", "authenticated"):
            assert db.su("select has_function_privilege(%s, %s, 'EXECUTE')", [role, f"public.{fn}"]) == [(False,)]


# ── the starting prices ──────────────────────────────────────────────────────

SEEDED = {
    "model_seedance_1_5_pro_second_720p_silent": 2.6, "model_seedance_1_5_pro_second_720p_audio": 5.2,
    "model_seedance_1_5_pro_second_1080p_audio": 11.6, "model_wan_2_7_second_720p": 10,
    "model_wan_2_7_second_1080p": 15, "model_kling_v3_second_silent": 8.4, "model_kling_v3_second_audio": 12.6,
}


def _seed_statement():
    sql = MIGRATION.read_text()
    m = re.search(r"insert into public\.credit_prices.*?on conflict \(unit\) do nothing;", sql, re.S)
    assert m, "the migration's starting-price insert is missing"
    return m.group(0)


def test_the_starting_rows_are_the_documented_prices_with_margin_1_5_and_never_overwrite(db):
    units = list(SEEDED)
    q = "select unit, credits_per_unit::float, margin::float from public.credit_prices where unit = any(%s)"
    db.su("delete from public.credit_prices where unit = any(%s)", [units])
    db.su(_seed_statement())
    got = {u: (c, m) for u, c, m in db.su(q, [units])}
    assert got == {u: (c, 1.5) for u, c in SEEDED.items()}
    # Not read from the vendor, so not seeded: unpriced.
    assert db.su("select count(*) from public.credit_prices where unit in "
                 "('model_seedance_1_5_pro_second_480p_silent', 'model_seedance_1_5_pro_second_480p_audio',"
                 " 'model_seedance_1_5_pro_second_1080p_silent')") == [(0,)]
    # The owner changes one; a re-run leaves it alone.
    db.su("update public.credit_prices set credits_per_unit = 7 where unit = 'model_wan_2_7_second_720p'")
    db.su(_seed_statement())
    assert db.su("select credits_per_unit::float from public.credit_prices where unit = 'model_wan_2_7_second_720p'") == [(7.0,)]
    db.su("delete from public.credit_prices where unit = any(%s)", [units])


# ── what is sent changed: the proof is re-opened (model_registry_guard) ──────

def _verified(db, mid, spec):
    row = {"id": mid, "display_name": mid, "provider": "acme", "adapter": "video.acme", "capabilities": ["t2v"],
           "credit_unit": f"model_{mid}_second", "entitlement": "any", "spec": spec}
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps([row])])
    db.su("select public.record_model_probe(%s, 'video.acme', %s, 't2v', true, null, null, 10, 100, 'security-lab')",
          [mid, spec["vendor_model"]])
    db.su("update public.model_registry set availability='beta' where id=%s", [mid])
    assert db.su("select verified_probe_id is not null from public.model_registry where id=%s", [mid])[0][0]


def _state(db, mid):
    return db.su("select verified_at is not null, verified_probe_id is not null, availability "
                 "from public.model_registry where id=%s", [mid])[0]


@pytest.mark.parametrize("name,change", [
    ("res", "set spec = jsonb_set(spec, '{default_resolution}', '\"1080p\"')"),
    ("res_dropped", "set spec = spec - 'default_resolution'"),
    ("by", "set spec = jsonb_set(spec, '{pricing,variants,by}', '\"resolution_audio\"')"),
    ("by_dropped", "set spec = spec #- '{pricing,variants}'"),
    ("tiers", "set spec = jsonb_set(spec, '{qualities}', '[\"low\",\"high\"]')"),
    ("tiers_added", "set spec = spec || '{\"qualities\":[\"low\"]}'::jsonb"),
])
def test_a_change_of_what_is_sent_reopens_the_proof(db, name, change):
    mid = "g" + name.replace("_", "")
    spec = _spec("resolution", {"720p": 0.1, "1080p": 0.2}, ["720p", "1080p"], "720p")
    spec["qualities"] = ["low", "medium"]
    _verified(db, mid, spec)
    assert _state(db, mid)[:2] == (True, True)
    db.su(f"update public.model_registry {change} where id=%s", [mid])
    assert _state(db, mid) == (False, False, "hidden"), name


@pytest.mark.parametrize("change", [
    "set spec = jsonb_set(spec, '{pricing,variants,prices,720p}', '0.5')",       # a price is not a call
    "set display_name = 'renamed'",
    "set spec = jsonb_set(spec, '{pricing,note}', '\"read again\"')",
])
def test_a_change_that_does_not_alter_the_call_keeps_the_proof(db, change):
    mid = f"k{abs(hash(change)) % 10**8}"
    _verified(db, mid, _spec("resolution", {"720p": 0.1, "1080p": 0.2}, ["720p", "1080p"], "720p"))
    db.su(f"update public.model_registry {change} where id=%s", [mid])
    assert _state(db, mid) == (True, True, "beta")


@pytest.mark.parametrize("name,change", [
    ("endframe", "set spec = jsonb_set(spec, '{end_frame}', 'true')"),
    ("factors", "set spec = jsonb_set(spec, '{upscale_factors}', '[2,4]')"),
    ("vendor", "set spec = jsonb_set(spec, '{vendor_model}', '\"acme-vid-2\"')"),
    ("languages", "set spec = jsonb_set(spec, '{languages}', '[\"en\"]')"),
    ("targets", "set spec = jsonb_set(spec, '{upscale_targets}', '[\"4k\"]')"),
])
def test_the_guard_keeps_every_earlier_trigger(db, name, change):
    mid = f"e{name}"
    spec = _spec(None, None, ["720p"]) | {"end_frame": False, "upscale_factors": [2], "languages": ["ru"],
                                           "upscale_targets": ["2k"]}
    _verified(db, mid, spec)
    db.su(f"update public.model_registry {change} where id=%s", [mid])
    assert _state(db, mid) == (False, False, "hidden"), name


def test_the_guard_is_closed_to_the_api(db):
    assert db.su("select not has_function_privilege('authenticated','public.model_registry_guard()','EXECUTE')"
                 " and not has_function_privilege('anon','public.model_registry_guard()','EXECUTE')")[0][0]
