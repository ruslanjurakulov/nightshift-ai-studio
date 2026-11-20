"""Breach: the rights acknowledgement (0174) is asked of the model a job is CREATED for, not of the model it RUNS or the files it SENDS.

create_creative_job refuses a job of a model that requires an acknowledgement unless this person acknowledged each of the job's
input files (params.source_asset_id, params.end_asset_id). Two ways past it, both with nothing but a signed-up account:

  * failover: an auto-mode job is created for a model that requires nothing; when the vendor is unreachable (or rate-limited, or
    out of quota) the worker's reroute_creative_job moves the job, with the same params and the same source photo, to the next
    candidate, which may be a model that requires likeness_photo. reroute_creative_job never asks for the acknowledgement, so the
    photo is sent to that vendor without anyone having confirmed the consent of the person in it;
  * references: a style kit (params.style_kit_id) or an @character in the prompt hands its reference pictures to the provider
    (modules/creative_style.py, for an adapter that takes references). Those pictures are inputs too, and the gate never reads them.

Each test describes the safe outcome, so each FAILS while the hole is open. Runs in its own scratch database (it commits).
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG = "aaaaaaaa-0000-0000-0000-0000000b1ea0"
UA = str(uuid.UUID(int=0xB1EA1))     # Alice, owner of ORG; she never acknowledges anything here
V1 = "likeness_photo.v1"

# (id, capabilities, spec, requires_acknowledgement column, credit unit, credits per unit)
MODELS = [
    # The model the person picked in auto mode: requires nothing, ranked first (faster).
    ("vid-first", ["i2v"], {"speed_tier": 5}, None, "model_vid_first_second", 2),
    # The failover candidate: same price and tier, requires a likeness acknowledgement.
    ("vid-needs-ack", ["i2v"], {"speed_tier": 0}, ["likeness_photo"], "model_vid_needs_ack_second", 2),
    # A picture model that takes reference pictures and requires a likeness acknowledgement.
    ("img-refs-ack", ["t2i"], {"inputs": {"image_refs_max": 4}}, ["likeness_photo"], "model_img_refs_ack_image", 1),
    # A picture model that requires nothing: a workflow's first step (0187's workflow test).
    ("img-plain", ["t2i"], {}, None, "model_img_plain_image", 1),
]
PRICES = ", ".join(f"('{u}', {c}, 0)" for _m, _c, _s, _col, u, c in MODELS) + ", ('job_minimum', 1, 0)"


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


def asset(d, org, kind="image", mime="image/png"):
    aid = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, %s, %s, 1000, %s, 'generated', p_width => 64, p_height => 64, "
          "p_provenance => '{\"job_id\": \"seed\"}'::jsonb)",
          [aid, org, kind, mime, uuid.uuid4().hex * 2])
    return aid


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_ack_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s, 'alice@breach.lab')", [UA])
    d.su("insert into public.organizations (id, name, slug) values (%s, 'Breach', 'org-breach-ack')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'alice@breach.lab', 'owner')", [ORG, UA])
    d.su("select public.grant_credits(%s, 500, 'test')", [ORG])

    def kind(m):
        return "image" if m.startswith("img-") else "video"

    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": f"{kind(m)}.acme", "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": kind(m), "durations_s": [4, 5], **extra}}
            for m, caps, extra, _col, unit, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, _x, col, _u, _c in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, f"{kind(m)}.acme", "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
        if col:
            d.su("update public.model_registry set requires_acknowledgement=%s where id=%s", [col, m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def create(db, params, model, cap="i2v", mode="exact", maxc=1000):
    return db.act("authenticated", UA, "select public.create_creative_job(%s::uuid,%s,%s,%s::jsonb,%s,null,%s::numeric)",
                  [ORG, cap, model, json.dumps(params), mode, maxc])[0][0]


def acknowledged(db, subject):
    return db.su("select count(*) from public.rights_acknowledgements where subject_asset_id = %s", [subject])[0][0] > 0


def test_the_gate_holds_for_the_model_picked_directly(db):
    # The control: picked by name, the acknowledging model refuses Alice's unacknowledged photo.
    photo = asset(db, ORG)
    with pytest.raises(psycopg.Error) as e:
        create(db, {"duration_s": 4, "source_asset_id": photo}, "vid-needs-ack")
    assert (e.value.sqlstate, str(e.value).splitlines()[0]) == ("NS400", "acknowledgement_required")


def test_a_failover_never_moves_an_unacknowledged_photo_to_a_model_that_requires_an_acknowledgement(db):
    photo = asset(db, ORG)
    params = {"duration_s": 4, "source_asset_id": photo}
    # What the Studio's auto quote shows (route_model is internal; read here as the database owner).
    route = db.su("select public.route_model('i2v', %s::jsonb, 'auto', %s, 'web')", [json.dumps(params), ORG])[0][0]
    assert route["model"] == "vid-first", route
    assert "vid-needs-ack" in [c["model"] for c in route["candidates"]], route
    job = create(db, params, "vid-first", mode="auto", maxc=route["credits"])["job"]
    # The worker claims it, and the vendor is unreachable: a code that proves no vendor task exists, so failover is allowed.
    claimed = db.act("service_role", None, "select id::text from public.claim_creative_job('breach-w')")
    assert claimed and claimed[0][0] == job["id"], claimed
    moved = db.act("service_role", None, "select public.reroute_creative_job(%s, 'breach-w', 'unreachable')", [job["id"]])[0][0]
    routed = db.su("select routed_model, params ->> 'source_asset_id' from public.creative_jobs where id = %s", [job["id"]])[0]
    db.act("service_role", None, "select public.finish_creative_job(%s,'breach-w',false,null,null,'test_drain','drained')", [job["id"]])
    assert not acknowledged(db, photo)
    # Safe: no candidate that requires an acknowledgement Alice never gave. Today: the job now runs vid-needs-ack with her photo.
    assert moved is None or moved.get("model") != "vid-needs-ack", (moved, routed)
    assert routed[0] != "vid-needs-ack", routed


def test_style_kit_reference_pictures_are_inputs_the_gate_asks_about(db):
    photos = [asset(db, ORG) for _ in range(3)]   # a kit takes 3 to 12 pictures (0047)
    photo = photos[0]
    kit = db.act("authenticated", UA, "select public.save_style_kit(%s, null, 'faces', 'a real person', %s::uuid[])",
                 [ORG, photos])[0][0]
    kit_id = str(kit)   # save_style_kit answers the kit's id
    try:
        out = create(db, {"prompt": "a portrait", "style_kit_id": kit_id}, "img-refs-ack", cap="t2i")
    except psycopg.Error as e:
        # Safe: refused, and refused for the acknowledgement (not some unrelated parameter problem).
        assert (e.sqlstate, str(e).splitlines()[0]) == ("NS400", "acknowledgement_required"), e
        return
    db.act("service_role", None, "select public.claim_creative_job('breach-w')")
    db.act("service_role", None, "select public.finish_creative_job(%s,'breach-w',false,null,null,'test_drain','drained')",
           [out["job"]["id"]])
    assert not acknowledged(db, photo)
    pytest.fail(f"a job of a model that requires likeness_photo was created with an unacknowledged reference picture: {out['job']['id']}")


def test_an_at_character_in_the_prompt_is_an_input_the_gate_asks_about(db):
    # No parameter names the file at all: the prompt's @mention makes the worker send the character's pictures (0048).
    photo = asset(db, ORG)
    db.act("authenticated", UA, "select public.save_character(%s, null, 'neighbour', 'character', 'the man next door', %s::uuid[])",
           [ORG, [photo]])
    try:
        out = create(db, {"prompt": "@neighbour waving at the camera"}, "img-refs-ack", cap="t2i")
    except psycopg.Error as e:
        assert (e.sqlstate, str(e).splitlines()[0]) == ("NS400", "acknowledgement_required"), e
        return
    db.act("service_role", None, "select public.claim_creative_job('breach-w')")
    db.act("service_role", None, "select public.finish_creative_job(%s,'breach-w',false,null,null,'test_drain','drained')",
           [out["job"]["id"]])
    assert not acknowledged(db, photo)
    pytest.fail(f"a job of a model that requires likeness_photo was created with an unacknowledged @character picture: {out['job']['id']}")


# ── 0187's follow-ups (Lens): a workflow step and the worker's own read ─────

def ack(db, subject):
    db.act("authenticated", UA, "select public.acknowledge_rights('likeness_photo', %s, %s, 'en')", [V1, subject])


def test_a_workflow_step_that_sends_character_pictures_is_refused_at_the_quote(db):
    photo = asset(db, ORG)
    db.act("authenticated", UA, "select public.save_character(%s, null, 'lodger', 'character', 'the lodger', %s::uuid[])",
           [ORG, [photo]])
    steps = [{"capability": "t2i", "model": "img-plain", "params": {"prompt": "a hallway"}},
             {"capability": "t2i", "model": "img-refs-ack", "params": {"prompt": "@lodger in the hallway"}}]
    wf = db.act("authenticated", UA, "select public.save_workflow(%s::uuid, null, %s, '[]'::jsonb, %s::jsonb)",
                [ORG, f"wf-lodger-{uuid.uuid4().hex[:6]}", json.dumps(steps)])[0][0]
    q = db.act("authenticated", UA, "select public.quote_workflow(%s, '{}'::jsonb)", [wf["id"]])[0][0]
    # Safe: refused before any hold, not at step 2's own job after step 1 was paid for.
    assert q["priced"] is False and q["steps"][1]["reason"] == "acknowledgement_required", q


def test_a_character_picture_added_after_the_job_was_created_is_never_handed_out(db):
    first = asset(db, ORG)
    ack(db, first)
    db.act("authenticated", UA, "select public.save_character(%s, null, 'tenant', 'character', 'the tenant', %s::uuid[])",
           [ORG, [first]])
    out = create(db, {"prompt": "@tenant at the window"}, "img-refs-ack", cap="t2i")
    job = out["job"]["id"]
    later = asset(db, ORG)   # nobody acknowledged this one
    cid = db.su("select id from public.characters where org_id = %s and name = 'tenant'", [ORG])[0][0]
    db.act("authenticated", UA, "select public.save_character(%s, %s, 'tenant', 'character', 'the tenant', %s::uuid[])",
           [ORG, str(cid), [first, later]])
    claimed = db.act("service_role", None, "select id::text from public.claim_creative_job('breach-w')")
    assert claimed and claimed[0][0] == job, claimed
    style = db.act("service_role", None, "select public.creative_job_style(%s, 'breach-w')", [job])[0][0]
    db.act("service_role", None, "select public.finish_creative_job(%s,'breach-w',false,null,null,'test_drain','drained')", [job])
    assert style["ok"] is False, style
