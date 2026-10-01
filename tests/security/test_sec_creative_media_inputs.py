"""Generations from a library image (0046), attacked in a real database.

edit / i2v / upscale / remove_bg name their input by a media asset id. The
database alone decides whether that id may be used: it must be an image of
the SAME organization, live, of a type a provider takes. Bob (org B) tries to
use Alice's (org A) picture every way the API lets him; the answer must be
exactly the answer for an id that does not exist, and nothing may be held.

Runs in its own scratch database (it commits): a real 0035 registry with one
model per new capability, installed through sync_model_registry and a real
probe row, as production does.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000a6"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000b6"
UA = str(uuid.UUID(int=0xA6))
UB = str(uuid.UUID(int=0xB6))

# (id, capabilities, adapter, extra spec, credit unit, credits per unit)
MODELS = [
    ("img-edit", ["t2i", "edit"], "image.acme", {}, "model_img_edit_image", 4),
    ("vid-i2v", ["t2v", "i2v"], "video.acme", {}, "model_vid_i2v_second", 2),
    ("img-up", ["upscale"], "image.acme", {"upscale_factors": [2]}, "model_img_up_image", 3),
    ("img-up4", ["upscale"], "image.acme", {"upscale_factors": [2, 4]}, "model_img_up4_image", 3),
    ("img-bg", ["remove_bg"], "image.acme", {}, "model_img_bg_image", 1),
]
PRICES = ", ".join(f"('{u}', {c}, 0)" for _m, _c, _a, _s, u, c in MODELS) + ", ('job_minimum', 1, 0)"


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
    return json.dumps(c)


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit()
                return rows
            except psycopg.Error:
                c.rollback()
                raise


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_media_inputs_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a6@x.io'),(%s,'b6@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A6','org-a6'),(%s,'B6','org-b6')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a6@x.io','viewer'),(%s,%s,'b6@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": a, "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "video" if a.startswith("video") else "image",
                      **extra}}
            for m, caps, a, extra, unit, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    d.rows = rows
    for m, caps, a, _x, _u, _c in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.assets = {
        "a_png": asset(d, ORG_A, "image", "image/png"),
        "a_video": asset(d, ORG_A, "video", "video/mp4"),
        "a_gif": asset(d, ORG_A, "image", "image/gif"),
        "a_heic_raw": asset(d, ORG_A, "image", "image/heic"),
        "a_deleted": asset(d, ORG_A, "image", "image/jpeg"),
        "b_png": asset(d, ORG_B, "image", "image/png"),
    }
    d.act("authenticated", UA, "select public.soft_delete_asset(%s)", [d.assets["a_deleted"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def asset(d, org, kind, mime, provenance=None):
    aid = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, %s, %s, 1000, %s, 'generated', p_width => 64, p_height => 64, "
          "p_provenance => %s::jsonb)",
          [aid, org, kind, mime, uuid.uuid4().hex * 2, json.dumps(provenance or {"job_id": "seed"})])
    return aid


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def quote(db, uid, org, cap, model, params):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,%s,%s,%s::jsonb)",
                  [org, cap, model, json.dumps(params)])[0][0]


def create(db, uid, org, cap, model, params, maxc=1000):
    return db.act("authenticated", uid, "select public.create_creative_job(%s,%s,%s,%s::jsonb,'exact',null,%s)",
                  [org, cap, model, json.dumps(params), maxc])[0][0]


def footprint(db, org):
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [org])[0][0],
            db.su("select count(*), coalesce(sum(amount),0)::float from public.credit_reservations "
                  "where org_id=%s and job_id like 'cj:%%'", [org])[0],
            db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org])[0])


def svc(db, q, p=None):
    return db.act("service_role", None, q, p)


def drain(db):
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc(db, "select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


# ── the source must be the organization's own ───────────────────────────────

EDIT = ("edit", "img-edit")


def test_own_image_quotes_and_creates(db):
    drain(db)
    params = {"prompt": "make the sky purple", "source_asset_id": db.assets["a_png"]}
    q = quote(db, UA, ORG_A, *EDIT, params)
    assert q["credits"] == 4 and q["quantity"] == 1
    j = create(db, UA, ORG_A, *EDIT, params)["job"]
    assert j["status"] == "queued" and j["params"]["source_asset_id"] == db.assets["a_png"]
    drain(db)


@pytest.mark.parametrize("call", ["quote", "create"])
def test_another_orgs_image_reads_like_one_that_does_not_exist(db, call):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    # Bob, in his own organization, names Alice's picture.
    st, word, detail = err(lambda: fn(db, UB, ORG_B, *EDIT, {"prompt": "x", "source_asset_id": db.assets["a_png"]}))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, *EDIT, {"prompt": "x", "source_asset_id": str(uuid.uuid4())}))
    assert (st, word) == ("NS400", "source_unavailable"), (st, word)
    # Exactly the same answer as for a random id: nothing is confirmed.
    assert (st, word, detail) == (st2, word2, detail2)
    assert db.assets["a_png"] not in detail
    assert footprint(db, ORG_B) == before


def test_alice_cannot_use_bobs_image_either(db):
    drain(db)
    before = footprint(db, ORG_A)
    for cap, model, params in [
        ("edit", "img-edit", {"prompt": "x"}),
        ("i2v", "vid-i2v", {"duration_s": 4}),
        ("upscale", "img-up", {"factor": 2}),
        ("remove_bg", "img-bg", {}),
    ]:
        p = {**params, "source_asset_id": db.assets["b_png"]}
        st, word, _ = err(lambda: create(db, UA, ORG_A, cap, model, p))
        assert (st, word) == ("NS400", "source_unavailable"), (cap, st, word)
    assert footprint(db, ORG_A) == before


def test_a_member_of_org_b_cannot_spend_in_org_a_with_org_as_image(db):
    st, _, _ = err(lambda: create(db, UB, ORG_A, *EDIT, {"prompt": "x", "source_asset_id": db.assets["a_png"]}))
    assert st == "42501"


@pytest.mark.parametrize("key,why", [
    ("a_deleted", "no image in this organization"),
    ("a_video", "must be an image"),
    ("a_gif", "GIF"),
    ("a_heic_raw", "no shareable copy"),
])
def test_unusable_sources_are_refused_before_any_hold(db, key, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, *EDIT, {"prompt": "x", "source_asset_id": db.assets[key]}))
    assert (st, word) == ("NS400", "source_unavailable") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


# ── params and price ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("cap,model,params,why", [
    ("edit", "img-edit", {"prompt": "x"}, "source_asset_id"),
    ("edit", "img-edit", {"source_asset_id": "A"}, "prompt is required"),
    ("t2i", "img-edit", {"prompt": "x", "source_asset_id": "SRC"}, "does not apply"),
    ("edit", "img-edit", {"prompt": "x", "source_asset_id": "../../etc/passwd"}, "source_asset_id"),
    ("i2v", "vid-i2v", {"source_asset_id": "SRC"}, "duration_s"),
    ("upscale", "img-up", {"source_asset_id": "SRC"}, "factor"),
    ("upscale", "img-up", {"source_asset_id": "SRC", "factor": 3}, "factor"),
    ("upscale", "img-up", {"source_asset_id": "SRC", "factor": "4"}, "factor"),
    ("upscale", "img-up", {"source_asset_id": "SRC", "factor": 2, "aspect_ratio": "16:9"}, "does not apply"),
    ("upscale", "img-up", {"source_asset_id": "SRC", "factor": 4}, "does not offer a 4x"),
    ("remove_bg", "img-bg", {"source_asset_id": "SRC", "prompt": "x"}, "does not apply"),
    ("remove_bg", "img-bg", {"source_asset_id": "SRC", "factor": 2}, "does not apply"),
    ("edit", "img-edit", {"prompt": "x", "source_asset_id": "SRC", "url": "https://evil"}, "unknown parameter"),
])
def test_param_refusals(db, cap, model, params, why):
    src = db.assets["a_png"]
    params = {k: (src if v == "SRC" else v) for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, model, params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)


def test_quantities_are_computed_in_the_database(db):
    src = db.assets["a_png"]
    assert quote(db, UA, ORG_A, "i2v", "vid-i2v", {"source_asset_id": src, "duration_s": 8})["credits"] == 16
    q2 = quote(db, UA, ORG_A, "upscale", "img-up4", {"source_asset_id": src, "factor": 2})
    q4 = quote(db, UA, ORG_A, "upscale", "img-up4", {"source_asset_id": src, "factor": 4})
    assert (q2["quantity"], q2["credits"]) == (1, 3) and (q4["quantity"], q4["credits"]) == (4, 12)
    assert quote(db, UA, ORG_A, "remove_bg", "img-bg", {"source_asset_id": src})["credits"] == 1
    # The confirmed price is still the ceiling.
    st, word, _ = err(lambda: create(db, UA, ORG_A, "upscale", "img-up4", {"source_asset_id": src, "factor": 4}, maxc=3))
    assert (st, word) == ("NS409", "price_changed")


def test_a_new_upscale_factor_needs_a_new_probe(db):
    # The whole file is synced (a model missing from it is disabled); only
    # img-up's factors change.
    rows = [dict(r, spec={**r["spec"], "upscale_factors": [2, 4]}) if r["id"] == "img-up" else r for r in db.rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    assert db.su("select availability from public.model_registry where id='img-edit'") == [("beta",)]
    assert db.su("select availability, verified_at is null from public.model_registry where id='img-up'") == [("hidden", True)]


# ── the worker's side ────────────────────────────────────────────────────────

def test_worker_reads_the_source_of_its_own_running_job_only(db):
    drain(db)
    j = create(db, UA, ORG_A, *EDIT, {"prompt": "x", "source_asset_id": db.assets["a_png"]})["job"]
    rows = svc(db, "select id::text from public.claim_creative_job('w1')")
    assert rows[0][0] == j["id"]
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is True and out["asset_id"] == db.assets["a_png"] and out["mime"] == "image/png"
    assert out["storage_key"] == db.assets["a_png"][:2] + "/" + db.assets["a_png"]
    assert svc(db, "select public.creative_job_source(%s, 'w2')", [j["id"]])[0][0]["ok"] is False
    # Once the paid call has started the source is not handed out again.
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','t-1')", [j["id"]])
    assert svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]["ok"] is False
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_a_source_deleted_after_create_fails_and_releases_in_full(db):
    drain(db)
    src = asset(db, ORG_A, "image", "image/webp")
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "remove_bg", "img-bg", {"source_asset_id": src})["job"]
    svc(db, "select public.claim_creative_job('w1')")
    db.act("authenticated", UA, "select public.soft_delete_asset(%s)", [src])
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is False and "no image" in out["problem"]
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'source_unavailable',%s)",
               [j["id"], out["problem"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    after = footprint(db, ORG_A)
    assert after[2] == before[2]  # balance and reserved exactly as before
    assert db.su("select status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == [("released",)]


def test_attach_takes_only_this_jobs_outputs(db):
    drain(db)
    j = create(db, UA, ORG_A, *EDIT, {"prompt": "x", "source_asset_id": db.assets["a_png"]})["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','t-2')", [j["id"]])
    mine = asset(db, ORG_A, "image", "image/png", {"job_id": j["id"]})
    other_job = asset(db, ORG_A, "image", "image/png", {"job_id": str(uuid.uuid4())})
    bobs = asset(db, ORG_B, "image", "image/png", {"job_id": j["id"]})
    # Not before processing.
    assert svc(db, "select public.attach_creative_job_assets(%s,'w1',%s::uuid[])", [j["id"], [mine]])[0][0] is False
    svc(db, "select public.advance_creative_job(%s,'w1','processing')", [j["id"]])
    assert svc(db, "select public.attach_creative_job_assets(%s,'w2',%s::uuid[])", [j["id"], [mine]])[0][0] is False
    for bad in ([bobs], [mine, bobs], [other_job], [db.assets["a_png"]]):
        st, _, _ = err(lambda: svc(db, "select public.attach_creative_job_assets(%s,'w1',%s::uuid[])", [j["id"], bad]))
        assert st == "42501", bad
    assert svc(db, "select public.attach_creative_job_assets(%s,'w1',%s::uuid[])", [j["id"], [mine]])[0][0] is True
    done = svc(db, "select public.finish_creative_job(%s,'w1',true)", [j["id"]])[0][0]
    assert done["status"] == "completed" and done["result_asset_ids"] == [mine] and done["charged_credits"] == 4
    # Bob cannot see the job, its outputs or Alice's source.
    assert db.act("authenticated", UB, "select id from public.creative_jobs where id=%s", [j["id"]]) == []
    assert db.act("authenticated", UB, "select id from public.media_assets where id = any(%s::uuid[])",
                  [[mine, db.assets["a_png"]]]) == []


@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA), ("authenticated", UB)])
@pytest.mark.parametrize("query", [
    "select public.creative_job_source(%(job)s, 'w1')",
    "select public.attach_creative_job_assets(%(job)s, 'w1', array[%(asset)s]::uuid[])",
    "select public.creative_source_problem(%(org)s, 'edit', jsonb_build_object('source_asset_id', %(asset)s::text))",
])
def test_no_browser_reaches_the_worker_side(db, role, uid, query):
    job = db.su("select id::text from public.creative_jobs where org_id=%s limit 1", [ORG_A])[0][0]
    st, _, _ = err(lambda: db.act(role, uid, query, {"job": job, "asset": db.assets["a_png"], "org": ORG_A}))
    assert st == "42501"
