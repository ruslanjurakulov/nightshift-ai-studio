"""Style kits and @characters in generations (0048), attacked in a real database.

A generation may name a style kit (params.style_kit_id) and its prompt may
mention characters by @name. The database alone decides whether the kit may
be used — it must be the SAME organization's — and the worker's read
(creative_job_style) only ever returns the job's own organization's kit,
characters and reference images. Bob (org B) tries to use Alice's (org A)
kit every way the API lets him; the answer must be exactly the answer for an
id that does not exist, and nothing may be held.

Runs in its own scratch database (it commits), like the 0046 lab.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000a8"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000b8"
UA = str(uuid.UUID(int=0xA8))
UB = str(uuid.UUID(int=0xB8))

# (id, capabilities, adapter, extra spec, credit unit, credits per unit)
MODELS = [
    ("img-style", ["t2i", "edit"], "image.acme", {}, "model_img_style_image", 4),
    ("vid-style", ["t2v", "i2v"], "video.acme", {}, "model_vid_style_second", 2),
    ("voice", ["tts"], "audio.acme", {}, "model_voice_character", 0.01),
    ("img-up", ["upscale"], "image.acme", {"upscale_factors": [2]}, "model_img_up_image", 3),
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


def asset(d, org, kind="image", mime="image/png", variants=None):
    aid = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, %s, %s, 1000, %s, 'generated', p_width => 64, p_height => 64, "
          "p_provenance => '{\"job_id\": \"seed\"}'::jsonb)",
          [aid, org, kind, mime, uuid.uuid4().hex * 2])
    if variants is not None:
        d.su("update public.media_assets set variants = %s::text[] where id = %s", [variants, aid])
    return aid


def save_kit(d, uid, org, name, desc, assets):
    return str(d.act("authenticated", uid, "select public.save_style_kit(%s, null, %s, %s, %s::uuid[])",
                     [org, name, desc, assets])[0][0])


def save_char(d, uid, org, name, desc, assets):
    return str(d.act("authenticated", uid,
                     "select public.save_character(%s, null, %s, 'character', %s, %s::uuid[])",
                     [org, name, desc, assets])[0][0])


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_style_inputs_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a8@x.io'),(%s,'b8@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A8','org-a8'),(%s,'B8','org-b8')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a8@x.io','editor'),(%s,%s,'b8@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": a, "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m,
                      "output": "video" if a.startswith("video") else "audio" if a.startswith("audio") else "image",
                      **extra}}
            for m, caps, a, extra, unit, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, a, _x, _u, _c in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")

    a_imgs = [asset(d, ORG_A) for _ in range(4)]
    a_heic_raw = asset(d, ORG_A, mime="image/heic", variants=["thumb"])
    b_imgs = [asset(d, ORG_B) for _ in range(3)]
    d.a_imgs, d.b_imgs, d.a_heic_raw = a_imgs, b_imgs, a_heic_raw
    d.src = asset(d, ORG_A)
    d.kit_a = save_kit(d, UA, ORG_A, "Warm film", "warm film grain, soft daylight", a_imgs[:3] + [a_heic_raw])
    d.kit_b = save_kit(d, UB, ORG_B, "Bob's look", "neon noir", b_imgs)
    d.hero_a = save_char(d, UA, ORG_A, "hero", "red scarf, round glasses", [a_imgs[3]])
    d.mira_a = save_char(d, UA, ORG_A, "mira", "silver hair", [a_imgs[0], a_imgs[1]])
    # Bob has a character with the SAME @name: Alice's prompt must never reach it.
    d.hero_b = save_char(d, UB, ORG_B, "hero", "bob's hero", [b_imgs[0]])
    d.villain_b = save_char(d, UB, ORG_B, "villain", "bob's villain", [b_imgs[1]])
    # A reference deleted from the library after the kit was saved.
    d.act("authenticated", UA, "select public.soft_delete_asset(%s)", [a_imgs[2]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


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


def claimed(db, uid, org, cap, model, params, worker="w1"):
    drain(db)
    j = create(db, uid, org, cap, model, params)["job"]
    rows = svc(db, "select id::text from public.claim_creative_job(%s)", [worker])
    assert rows[0][0] == j["id"]
    return j


def style_of(db, job, worker="w1"):
    return svc(db, "select public.creative_job_style(%s, %s)", [job, worker])[0][0]


# ── the kit must be the organization's own ──────────────────────────────────

def test_own_kit_quotes_and_creates_at_the_same_price(db):
    drain(db)
    plain = quote(db, UA, ORG_A, "t2i", "img-style", {"prompt": "a lighthouse"})
    styled = quote(db, UA, ORG_A, "t2i", "img-style", {"prompt": "a lighthouse", "style_kit_id": db.kit_a})
    # A style adds no credits.
    assert (styled["credits"], styled["quantity"], styled["unit"]) == (plain["credits"], plain["quantity"], plain["unit"])
    for cap, model, params in [
        ("t2i", "img-style", {"prompt": "x"}),
        ("edit", "img-style", {"prompt": "x", "source_asset_id": db.src}),
        ("t2v", "vid-style", {"prompt": "x", "duration_s": 4}),
        ("i2v", "vid-style", {"source_asset_id": db.src, "duration_s": 4}),
    ]:
        j = create(db, UA, ORG_A, cap, model, {**params, "style_kit_id": db.kit_a})["job"]
        assert j["status"] == "queued" and j["params"]["style_kit_id"] == db.kit_a, cap
        drain(db)


@pytest.mark.parametrize("call", ["quote", "create"])
def test_another_orgs_kit_reads_like_one_that_does_not_exist(db, call):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    # Bob, in his own organization, names Alice's kit.
    st, word, detail = err(lambda: fn(db, UB, ORG_B, "t2i", "img-style", {"prompt": "x", "style_kit_id": db.kit_a}))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, "t2i", "img-style",
                                         {"prompt": "x", "style_kit_id": str(uuid.uuid4())}))
    assert (st, word) == ("NS400", "style_unavailable"), (st, word)
    # Exactly the same answer as for a made-up id: nothing is confirmed.
    assert (st, word, detail) == (st2, word2, detail2)
    assert db.kit_a not in detail
    assert footprint(db, ORG_B) == before


def test_alice_cannot_use_bobs_kit_on_any_capability(db):
    drain(db)
    before = footprint(db, ORG_A)
    for cap, model, params in [
        ("t2i", "img-style", {"prompt": "x"}),
        ("edit", "img-style", {"prompt": "x", "source_asset_id": db.src}),
        ("t2v", "vid-style", {"prompt": "x", "duration_s": 4}),
        ("i2v", "vid-style", {"source_asset_id": db.src, "duration_s": 4}),
    ]:
        p = {**params, "style_kit_id": db.kit_b}
        st, word, _ = err(lambda: create(db, UA, ORG_A, cap, model, p))
        assert (st, word) == ("NS400", "style_unavailable"), (cap, st, word)
    assert footprint(db, ORG_A) == before


def test_a_member_of_org_b_cannot_spend_in_org_a_with_org_as_kit(db):
    st, _, _ = err(lambda: create(db, UB, ORG_A, "t2i", "img-style", {"prompt": "x", "style_kit_id": db.kit_a}))
    assert st == "42501"


@pytest.mark.parametrize("cap,model,params,why", [
    ("tts", "voice", {"prompt": "hello", "style_kit_id": "KIT"}, "does not apply"),
    ("upscale", "img-up", {"source_asset_id": "SRC", "factor": 2, "style_kit_id": "KIT"}, "does not apply"),
    ("t2i", "img-style", {"prompt": "x", "style_kit_id": None}, "style_kit_id"),
    ("t2i", "img-style", {"prompt": "x", "style_kit_id": 7}, "style_kit_id"),
    ("t2i", "img-style", {"prompt": "x", "style_kit_id": "../kits/1"}, "style_kit_id"),
    ("t2i", "img-style", {"prompt": "x", "style_kit_ids": ["KIT"]}, "unknown parameter"),
])
def test_param_refusals(db, cap, model, params, why):
    subst = {"KIT": db.kit_a, "SRC": db.src}
    params = {k: (subst.get(v, v) if isinstance(v, str) else v) for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, cap, model, params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)


# ── the worker's read ───────────────────────────────────────────────────────

def test_worker_reads_the_kit_and_mentioned_characters_of_its_own_job_only(db):
    prompt = "@Hero meets @mira at dawn; mail me at me@villain.io, @villain and @nobody watch, @hero again"
    j = claimed(db, UA, ORG_A, "t2i", "img-style", {"prompt": prompt, "style_kit_id": db.kit_a})
    out = style_of(db, j["id"])
    assert out["ok"] is True and out["org_id"] == ORG_A
    kit = out["kit"]
    assert kit["id"] == db.kit_a and kit["org_id"] == ORG_A and kit["description"] == "warm film grain, soft daylight"
    # In order; the deleted reference and the HEIC photo without a JPEG copy are not handed out.
    assert [r["asset_id"] for r in kit["references"]] == db.a_imgs[:2]
    assert all(r["org_id"] == ORG_A for r in kit["references"])
    # Alice's characters by first mention; Bob's @hero and @villain never; @nobody is not anyone's.
    chars = out["characters"]
    assert [(c["id"], c["name"]) for c in chars] == [(db.hero_a, "hero"), (db.mira_a, "mira")]
    assert all(c["org_id"] == ORG_A for c in chars)
    assert [r["asset_id"] for r in chars[0]["references"]] == [db.a_imgs[3]]
    flat = json.dumps(out)
    for foreign in [db.kit_b, db.hero_b, db.villain_b, *db.b_imgs]:
        assert foreign not in flat
    # Another worker, or after the paid call started: nothing.
    assert style_of(db, j["id"], "w2")["ok"] is False
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    assert style_of(db, j["id"])["ok"] is False
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_bobs_prompt_gets_bobs_characters_not_alices(db):
    j = claimed(db, UB, ORG_B, "t2v", "vid-style", {"prompt": "@hero and @mira", "duration_s": 4})
    out = style_of(db, j["id"])
    assert out["ok"] is True and out["kit"] is None
    assert [c["id"] for c in out["characters"]] == [db.hero_b]
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_a_foreign_kit_written_into_a_job_row_is_still_refused_to_the_worker(db):
    # Defence in depth: even a row that bypassed create (here, written by the
    # database owner) cannot make the worker read another org's kit.
    j = claimed(db, UA, ORG_A, "t2i", "img-style", {"prompt": "x", "style_kit_id": db.kit_a})
    db.su("update public.creative_jobs set params = jsonb_set(params, '{style_kit_id}', to_jsonb(%s::text)) "
          "where id = %s", [db.kit_b, j["id"]])
    out = style_of(db, j["id"])
    assert out == {"ok": False, "problem": "style_kit_id names no style kit in this organization"}
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_a_kit_deleted_after_create_fails_and_releases_in_full(db):
    drain(db)
    kit = save_kit(db, UA, ORG_A, "Short-lived", "", db.a_imgs[:2] + [db.a_imgs[3]])
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "t2i", "img-style", {"prompt": "x", "style_kit_id": kit})["job"]
    svc(db, "select public.claim_creative_job('w1')")
    db.act("authenticated", UA, "delete from public.style_kits where id = %s", [kit])
    out = style_of(db, j["id"])
    assert out["ok"] is False and "no style kit" in out["problem"]
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'style_unavailable',%s)",
               [j["id"], out["problem"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]  # balance and reserved exactly as before
    assert db.su("select status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == [("released",)]


def test_capabilities_without_a_look_get_no_characters(db):
    j = claimed(db, UA, ORG_A, "tts", "voice", {"prompt": "hello @hero"})
    out = style_of(db, j["id"])
    assert out == {"ok": True, "org_id": ORG_A, "kit": None, "characters": []}
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA), ("authenticated", UB)])
@pytest.mark.parametrize("query", [
    "select public.creative_job_style(%(job)s, 'w1')",
    "select public.creative_style_problem(%(org)s, 't2i', jsonb_build_object('style_kit_id', %(kit)s::text))",
])
def test_no_browser_reaches_the_worker_side(db, role, uid, query):
    job = db.su("select id::text from public.creative_jobs where org_id=%s limit 1", [ORG_A])[0][0]
    st, _, _ = err(lambda: db.act(role, uid, query, {"job": job, "kit": db.kit_a, "org": ORG_A}))
    assert st == "42501"
