"""Voice change and dubbing from a library recording (0050), attacked in a real
database.

voice_change / dub name their input by a media asset id, like 0046's picture
tools. The database alone decides whether that id may be used — an audio or
video file of the SAME organization, live, of a type the provider takes, of a
measured length within the limits — and it alone decides the quantity: the
recording's seconds from the asset row. Bob (org B) tries to use Alice's
recording every way the API lets him; the answer must be exactly the answer
for an id that does not exist, and nothing may be held. A length typed by a
client is refused, never priced.

Runs in its own scratch database (it commits), like the 0046 lab.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000c5"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000c5"
UA = str(uuid.UUID(int=0xC5A))
UB = str(uuid.UUID(int=0xC5B))
VOICE = "AbCdEfGhIjKlMnOpQrSt"

# (id, capability, extra spec, credit unit, credits per unit)
MODELS = [
    ("vox", "voice_change", {}, "model_vox_second", 0.5),
    ("dubber", "dub", {"languages": ["uz", "ru", "en"]}, "model_dubber_second", 2),
    ("dub-ru", "dub", {"languages": ["ru"]}, "model_dub_ru_second", 2),
]
PRICES = ", ".join(f"('{u}', {c}, 0)" for _m, _c, _s, u, c in MODELS) + ", ('job_minimum', 1, 0)"


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_voice_tools_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a5@x.io'),(%s,'b5@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A5','org-a5'),(%s,'B5','org-b5')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a5@x.io','viewer'),(%s,%s,'b5@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "audio.acme", "capabilities": [cap],
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "audio", **extra}}
            for m, cap, extra, unit, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    d.rows = rows
    for m, cap, _x, _u, _c in MODELS:
        d.su("select public.record_model_probe(%s, 'audio.acme', %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, "acme-" + m, cap])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.assets = {
        "a_mp3": rec(d, ORG_A, "audio", "audio/mpeg", 61.2),
        "a_mp4": rec(d, ORG_A, "video", "video/mp4", 12),
        "a_aac": rec(d, ORG_A, "audio", "audio/aac", 10),
        "a_long": rec(d, ORG_A, "audio", "audio/wav", 300.5),
        "a_hour": rec(d, ORG_A, "video", "video/mp4", 1800.2),
        "a_nolen": rec(d, ORG_A, "audio", "audio/mpeg", None),
        "a_png": rec(d, ORG_A, "image", "image/png", None),
        "a_deleted": rec(d, ORG_A, "audio", "audio/mpeg", 5),
        "b_mp3": rec(d, ORG_B, "audio", "audio/mpeg", 20),
    }
    d.act("authenticated", UA, "select public.soft_delete_asset(%s)", [d.assets["a_deleted"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def rec(d, org, kind, mime, seconds, provenance=None):
    aid = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, %s, %s, 1000, %s, 'generated', p_duration_s => %s::numeric, "
          "p_provenance => %s::jsonb)",
          [aid, org, kind, mime, uuid.uuid4().hex * 2, seconds, json.dumps(provenance or {"job_id": "seed"})])
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


def vc(src):
    return {"source_asset_id": src, "voice_id": VOICE}


def dub(src, lang="uz"):
    return {"source_asset_id": src, "target_language": lang}


# ── the price is the recording's length, from the database ──────────────────

def test_quantity_is_the_recordings_measured_seconds_rounded_up(db):
    q = quote(db, UA, ORG_A, "voice_change", "vox", vc(db.assets["a_mp3"]))
    # 61.2 s -> 62 s x 0.5 credits.
    assert (q["quantity"], q["unit"], q["credits"]) == (62, "model_vox_second", 31)
    q = quote(db, UA, ORG_A, "dub", "dubber", dub(db.assets["a_mp4"], "ru"))
    assert (q["quantity"], q["credits"]) == (12, 24)


def test_created_job_keeps_the_databases_quantity_and_holds_exactly_the_quote(db):
    drain(db)
    j = create(db, UA, ORG_A, "dub", "dubber", dub(db.assets["a_mp3"]))["job"]
    row = db.su("select quantity::float, quoted_credits::float, credit_unit from public.creative_jobs where id=%s",
                [j["id"]])[0]
    assert row == (62.0, 124.0, "model_dubber_second")
    assert db.su("select amount::float from public.credit_reservations where job_id=%s",
                 ["cj:" + j["id"]]) == [(124.0,)]
    drain(db)


@pytest.mark.parametrize("cap,model,extra", [
    ("voice_change", "vox", {"duration_s": 1}),
    ("dub", "dubber", {"duration_s": 1}),
])
def test_a_length_sent_by_the_client_is_refused_not_priced(db, cap, model, extra):
    base = vc(db.assets["a_mp3"]) if cap == "voice_change" else dub(db.assets["a_mp3"])
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, model, {**base, **extra}))
    assert (st, word) == ("NS400", "invalid_params") and "duration_s does not apply" in detail


def test_the_confirmed_price_is_still_the_ceiling(db):
    st, word, _ = err(lambda: create(db, UA, ORG_A, "voice_change", "vox", vc(db.assets["a_mp3"]), maxc=30))
    assert (st, word) == ("NS409", "price_changed")


# ── the recording must be the organization's own ────────────────────────────

@pytest.mark.parametrize("call", ["quote", "create"])
@pytest.mark.parametrize("cap,model,params", [("voice_change", "vox", vc), ("dub", "dubber", dub)])
def test_another_orgs_recording_reads_like_one_that_does_not_exist(db, call, cap, model, params):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    st, word, detail = err(lambda: fn(db, UB, ORG_B, cap, model, params(db.assets["a_mp3"])))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, cap, model, params(str(uuid.uuid4()))))
    assert (st, word) == ("NS400", "source_unavailable"), (st, word)
    assert (st, word, detail) == (st2, word2, detail2)
    assert db.assets["a_mp3"] not in detail
    assert footprint(db, ORG_B) == before


def test_alice_cannot_use_bobs_recording_and_a_stranger_cannot_spend_in_her_org(db):
    drain(db)
    before = footprint(db, ORG_A)
    for cap, model, params in [("voice_change", "vox", vc), ("dub", "dubber", dub)]:
        st, word, _ = err(lambda: create(db, UA, ORG_A, cap, model, params(db.assets["b_mp3"])))
        assert (st, word) == ("NS400", "source_unavailable"), cap
    assert footprint(db, ORG_A) == before
    st, _, _ = err(lambda: create(db, UB, ORG_A, "dub", "dubber", dub(db.assets["a_mp3"])))
    assert st == "42501"


@pytest.mark.parametrize("cap,model,key,why", [
    ("voice_change", "vox", "a_deleted", "no audio or video file"),
    ("voice_change", "vox", "a_png", "must be an audio or video file"),
    ("voice_change", "vox", "a_aac", "cannot be used here"),
    ("voice_change", "vox", "a_long", "up to 5 minutes"),
    ("voice_change", "vox", "a_nolen", "not known"),
    ("dub", "dubber", "a_hour", "up to 30 minutes"),
    ("dub", "dubber", "a_png", "must be an audio or video file"),
    ("dub", "dubber", "a_nolen", "not known"),
])
def test_unusable_recordings_are_refused_before_any_hold(db, cap, model, key, why):
    drain(db)
    before = footprint(db, ORG_A)
    params = vc(db.assets[key]) if cap == "voice_change" else dub(db.assets[key])
    st, word, detail = err(lambda: create(db, UA, ORG_A, cap, model, params))
    assert (st, word) == ("NS400", "source_unavailable") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


def test_a_dub_takes_aac_where_the_voice_changer_does_not(db):
    assert quote(db, UA, ORG_A, "dub", "dubber", dub(db.assets["a_aac"]))["quantity"] == 10


# ── params ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cap,model,params,why", [
    ("voice_change", "vox", {"source_asset_id": "SRC"}, "voice_id"),
    ("voice_change", "vox", {"source_asset_id": "SRC", "voice_id": "16516516145"}, "voice_id"),
    ("voice_change", "vox", {"source_asset_id": "SRC", "voice_id": "../../../../etc/pass"}, "voice_id"),
    ("voice_change", "vox", {"voice_id": VOICE}, "source_asset_id"),
    ("voice_change", "vox", {"source_asset_id": "https://evil.example/a.mp3", "voice_id": VOICE}, "source_asset_id"),
    ("voice_change", "vox", {"source_asset_id": "SRC", "voice_id": VOICE, "prompt": "x"}, "does not apply"),
    ("voice_change", "vox", {"source_asset_id": "SRC", "voice_id": VOICE, "target_language": "uz"}, "does not apply"),
    ("voice_change", "vox", {"source_asset_id": "SRC", "voice_id": VOICE, "seed": 1}, "does not apply"),
    ("dub", "dubber", {"source_asset_id": "SRC"}, "target_language"),
    ("dub", "dubber", {"source_asset_id": "SRC", "target_language": "de"}, "target_language"),
    ("dub", "dubber", {"source_asset_id": "SRC", "target_language": "UZ"}, "target_language"),
    ("dub", "dubber", {"source_asset_id": "SRC", "target_language": "uz", "voice_id": VOICE}, "does not apply"),
    ("dub", "dubber", {"source_asset_id": "SRC", "target_language": "uz", "aspect_ratio": "16:9"}, "does not apply"),
    ("dub", "dubber", {"source_asset_id": "SRC", "target_language": "uz", "style_kit_id": str(uuid.uuid4())},
     "does not apply"),
    ("dub", "dub-ru", {"source_asset_id": "SRC", "target_language": "uz"}, "does not dub into uz"),
    ("tts", "vox", {"prompt": "x", "target_language": "uz"}, "does not apply"),
    ("t2i", "vox", {"prompt": "x", "source_asset_id": "SRC"}, "does not apply"),
])
def test_param_refusals(db, cap, model, params, why):
    src = db.assets["a_mp3"]
    params = {k: (src if v == "SRC" else v) for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, model, params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)


def test_a_picture_tool_still_refuses_a_recording(db):
    # 0046's rule is unchanged: edit wants an image, never audio.
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "edit", "vox", {"prompt": "x",
                                                                          "source_asset_id": db.assets["a_mp3"]}))
    assert (st, word) == ("NS400", "source_unavailable") and "must be an image" in detail


def test_a_new_language_needs_a_new_probe(db):
    rows = [dict(r, spec={**r["spec"], "languages": ["ru", "en"]}) if r["id"] == "dub-ru" else r for r in db.rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    assert db.su("select availability from public.model_registry where id='dubber'") == [("beta",)]
    assert db.su("select availability, verified_at is null from public.model_registry where id='dub-ru'") == \
        [("hidden", True)]


def test_sellable_models_shows_the_languages(db):
    rows = db.act("authenticated", UA, "select id, spec from public.sellable_models('dub', 'web')")
    by = {r[0]: r[1] for r in rows}
    assert by["dubber"]["languages"] == ["uz", "ru", "en"]
    assert "vendor_model" not in by["dubber"]


# ── the worker's side ────────────────────────────────────────────────────────

def test_worker_reads_the_recording_of_its_own_running_job_only(db):
    drain(db)
    j = create(db, UA, ORG_A, "voice_change", "vox", vc(db.assets["a_mp4"]))["job"]
    assert svc(db, "select id::text from public.claim_creative_job('w1')")[0][0] == j["id"]
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is True and out["asset_id"] == db.assets["a_mp4"]
    assert (out["kind"], out["mime"], float(out["duration_s"])) == ("video", "video/mp4", 12.0)
    assert svc(db, "select public.creative_job_source(%s, 'w2')", [j["id"]])[0][0]["ok"] is False
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_a_recording_deleted_after_create_fails_and_releases_in_full(db):
    drain(db)
    src = rec(db, ORG_A, "audio", "audio/flac", 30)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "dub", "dubber", dub(src, "en"))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    db.act("authenticated", UA, "select public.soft_delete_asset(%s)", [src])
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is False and "no audio or video file" in out["problem"]
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'source_unavailable',%s)",
               [j["id"], out["problem"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]
    assert db.su("select status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == [("released",)]


def test_a_provider_failure_after_submit_releases_the_hold(db):
    drain(db)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "dub", "dubber", dub(db.assets["a_mp4"]))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','proj/lang')", [j["id"]])
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'bad_request','dub failed')",
               [j["id"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]


@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA), ("authenticated", UB)])
@pytest.mark.parametrize("query", [
    "select public.creative_source_seconds(%(org)s, jsonb_build_object('source_asset_id', %(asset)s::text))",
    "select public.creative_source_problem(%(org)s, 'dub', jsonb_build_object('source_asset_id', %(asset)s::text))",
    "select public.creative_job_source(%(job)s, 'w1')",
    "select public.creative_price(%(org)s, 'dub', 'dubber', jsonb_build_object('source_asset_id', %(asset)s::text,"
    " 'target_language', 'uz'))",
])
def test_no_browser_reaches_the_internal_or_worker_side(db, role, uid, query):
    job = db.su("select id::text from public.creative_jobs where org_id=%s limit 1", [ORG_A])[0][0]
    with pytest.raises(psycopg.Error) as e:
        db.act(role, uid, query, {"job": job, "asset": db.assets["a_mp3"], "org": ORG_A})
    assert e.value.sqlstate == "42501"
