"""Breach: a film sends an uploaded photo to a model that requires a rights acknowledgement, and nobody acknowledged it (0174 x 0171).

0174's header leaves "the Film Studio's job path (0171, an open pull request)" to a follow-up, but 0171 is on main: quote_film and
start_film price, hold and plan a clip take whose first frame is a library file the person uploaded (film_scenes.first_frame_asset_id),
for a clip model that requires likeness_photo, without asking rights_acknowledgement_missing. P3's worker then writes the take's
creative job directly (payer 'film', never through create_creative_job), so no later step asks either.

The test describes the safe outcome (the start refused with acknowledgement_required before anything is held), so it FAILS while the
hole is open. Runs in its own scratch database (it commits), on test_sec_films_money's own lab helpers.
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

import sec_db
from test_sec_films_money import ASSEMBLY_RATE, JOB_MINIMUM, SETTINGS, Db
from test_sec_films_money import MODELS as FILM_MODELS

# The films lab's models, plus a clip model that requires likeness_photo (as 0174 seeds on Runway's two models).
MODELS = FILM_MODELS + [("vid-clip-ack", "acme", "video.acme", ["t2v", "i2v"], "model_vid_clip_ack_second", 2,
                         {"durations_s": [5, 10], "end_frame": True})]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_film_ack_{uuid.uuid4().hex[:8]}"
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
    d.su("update public.model_registry set requires_acknowledgement = array['likeness_photo'] where id = 'vid-clip-ack'")
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0), "
         "('job_minimum', %s, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit",
         [ASSEMBLY_RATE, JOB_MINIMUM])
    assert d.su("select public.set_film_studio_enabled(true)")[0][0]["ok"] is True
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def test_a_film_never_starts_a_clip_of_an_unacknowledged_upload_on_a_model_that_requires_an_acknowledgement(db):
    o = db.new_org(credits=500)
    photo = o.image                                   # a library picture of the organization: the person's own upload
    assert "likeness_photo" in db.su("select public.rights_acknowledgement_required('vid-clip-ack')")[0][0]
    settings = dict(SETTINGS, clip_model="vid-clip-ack")
    scenes = [{"title": "Open", "narration": "It begins.", "planned_seconds": 10,
               "first_frame": "asset", "first_frame_asset_id": photo}]
    fid = db.film(o, settings=settings, scenes=scenes)
    q = db.quote(o.editor, fid)
    out = db.start(o.admin, fid, q.get("quote_id")) if q.get("quote_id") else {"ok": False, "reason": "unpriced", "quote": q}
    held = db.holds(o.org)
    # The clip take of the scene whose first frame is the upload (the worker reads the frame from the scene, or the take).
    planned = db.su("select count(*) from public.film_takes t join public.film_scenes s on s.id = t.scene_id "
                    "where t.film_id = %s and t.model = 'vid-clip-ack' and t.kind = 'clip' "
                    "and coalesce(t.first_frame_asset_id, s.first_frame_asset_id) = %s", [fid, photo])[0][0]
    takes = db.su("select kind, model, status, first_frame_asset_id::text from public.film_takes where film_id = %s", [fid])
    if out.get("ok") is True:
        db.cancel(out["id"])
    assert db.su("select count(*) from public.rights_acknowledgements where subject_asset_id = %s", [photo])[0][0] == 0
    # Safe: refused for the acknowledgement, nothing held, no take planned. Today: started, the total held, the clip planned.
    assert out.get("ok") is False and out.get("reason") == "acknowledgement_required", (out.get("ok"), held, planned, takes)
    assert planned == 0 and not held, (planned, held)


def test_a_film_asks_about_the_characters_its_visual_prompt_mentions(db):
    # 0179 (Lens on #S5): the key frame's and the clip's params carry the scene's visual prompt, and the worker reads @names from it.
    o = db.new_org(credits=500)
    db.one("authenticated", o.editor, "select public.save_character(%s, null, 'keeper', 'character', 'the keeper', %s::uuid[])",
           [o.org, [o.image]])
    settings = dict(SETTINGS, clip_model="vid-clip-ack")
    scenes = [{"title": "Open", "narration": "It begins.", "visual_prompt": "@keeper at the lighthouse door", "planned_seconds": 10}]
    fid = db.film(o, settings=settings, scenes=scenes)
    q = db.quote(o.editor, fid)
    assert q.get("quote_id"), q
    out = db.start(o.admin, fid, q["quote_id"])
    if out.get("ok") is True:
        db.cancel(out["id"])
    assert out.get("ok") is False and out.get("reason") == "acknowledgement_required", out
    assert out.get("detail", "").endswith(f"subject={o.image}"), out
    assert not db.holds(o.org)
