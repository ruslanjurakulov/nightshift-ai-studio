"""Breach on 0187: the Film Studio's other ways of handing a person's picture to a model that requires a rights acknowledgement.

Tried against film_acknowledgement_missing and HELD on 0187; pinned so a rewrite of it (or of film_price's line plan) cannot quietly
drop one:

  * a scene's OWN clip model (film_scenes.clip_model) overriding a film-level model that requires nothing;
  * a key frame model that requires an acknowledgement, fed a film reference CHARACTER (no @name anywhere) or the film's style kit;
  * the last frame of a multi-shot scene, which film_price hands to the LAST extend shot, not to the first clip shot.

Each must refuse the start with acknowledgement_required before anything is held. Runs in its own scratch database (it commits),
on test_sec_films_money's lab helpers.
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

import sec_db
from test_sec_films_money import ASSEMBLY_RATE, JOB_MINIMUM, SETTINGS, Db
from test_sec_films_money import MODELS as FILM_MODELS

MODELS = FILM_MODELS + [
    ("vid-clip-ack", "acme", "video.acme", ["t2v", "i2v"], "model_vid_clip_ack_second", 2, {"durations_s": [5, 10], "end_frame": True}),
    ("img-key-ack", "acme", "image.acme", ["t2i"], "model_img_key_ack_image", 3,
     # 0235 (refs path): it takes references on the path a key frame is made on (t2i), or the quote refuses them first.
     {"aspect_ratios": ["16:9", "9:16", "1:1"], "inputs": {"image_refs_max": 6, "ref_capabilities": ["t2i"]}}),
]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_0187_film_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], **spec}}
            for m, prov, a, caps, unit, _rate, spec in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, _prov, a, caps, unit, rate, _spec in MODELS:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, rate])
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
    d.su("update public.model_registry set requires_acknowledgement = array['likeness_photo'] "
         "where id in ('vid-clip-ack', 'img-key-ack')")
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0), "
         "('job_minimum', %s, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit",
         [ASSEMBLY_RATE, JOB_MINIMUM])
    assert d.su("select public.set_film_studio_enabled(true)")[0][0]["ok"] is True
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def start_refused(db, o, fid, subject):
    q = db.quote(o.editor, fid)
    assert q.get("quote_id"), q
    out = db.start(o.admin, fid, q["quote_id"])
    if out.get("ok") is True:
        db.cancel(out["id"])
    assert out.get("ok") is False and out.get("reason") == "acknowledgement_required", out
    assert out.get("detail", "").endswith(f"subject={subject}"), out
    assert not db.holds(o.org)
    assert db.su("select count(*) from public.film_takes where film_id = %s", [fid])[0][0] == 0


def test_a_scenes_own_clip_model_is_asked_not_the_films(db):
    o = db.new_org(credits=500)
    scenes = [{"title": "Open", "narration": "It begins.", "planned_seconds": 10, "clip_model": "vid-clip-ack",
               "first_frame": "asset", "first_frame_asset_id": o.image}]
    fid = db.film(o, settings=dict(SETTINGS, clip_model="vid-clip"), scenes=scenes)
    start_refused(db, o, fid, o.image)


def test_a_key_frame_model_is_asked_about_a_reference_character_nobody_mentions(db):
    o = db.new_org(credits=500)
    cid = db.one("authenticated", o.editor,
                 "select public.save_character(%s, null, 'warden', 'character', 'the warden', %s::uuid[])", [o.org, [o.image]])
    fid = db.film(o, settings=dict(SETTINGS, keyframe_model="img-key-ack"),
                  scenes=[{"title": "Open", "narration": "It begins.", "visual_prompt": "a lighthouse at dusk",
                           "planned_seconds": 10}])
    db.save(o.editor, fid, db.version(fid), {"refs": [{"kind": "character", "character_id": str(cid)}]})
    start_refused(db, o, fid, o.image)


def test_a_key_frame_model_is_asked_about_the_films_style_kit(db):
    o = db.new_org(credits=500)
    pics = [o.image] + [db.asset(o.org) for _ in range(2)]
    kit = db.one("authenticated", o.editor, "select public.save_style_kit(%s, null, 'film look', 'a face', %s::uuid[])",
                 [o.org, pics])
    fid = db.film(o, settings=dict(SETTINGS, keyframe_model="img-key-ack", style_kit_id=str(kit)),
                  scenes=[{"title": "Open", "narration": "It begins.", "visual_prompt": "a lighthouse at dusk",
                           "planned_seconds": 10}])
    start_refused(db, o, fid, o.image)


def test_the_last_frame_of_a_multi_shot_scene_is_asked_about_for_its_extend_shot(db):
    o = db.new_org(credits=500)
    end = db.asset(o.org)
    scenes = [{"title": "Open", "narration": "It begins.", "visual_prompt": "a lighthouse at dusk", "planned_seconds": 20,
               "shot_count": 2, "last_frame": "asset", "last_frame_asset_id": end}]
    fid = db.film(o, settings=dict(SETTINGS, clip_model="vid-clip-ack"), scenes=scenes)
    start_refused(db, o, fid, end)
