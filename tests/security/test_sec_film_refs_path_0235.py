"""0235's refs path, in a real database: a film whose key frame has reference pictures is refused at the quote, before anything is
held, when the key-frame model's adapter does not send references on t2i (the path film_take_job makes every key frame on).

The live bug (S1): the OpenAI image adapter takes references on EDIT only (modules/capabilities/image.py reference_capabilities), and
creative_adapters refuses references on t2i as bad_request at submit. film_price asked only inputs.image_refs_max, so a film with one
reference on a GPT Image key-frame model was priced, held at Start, and refused at its first take. What would break without each guard
(each test names it):

  * a GPT-Image-like model (references on edit only) with a reference: priced and held -> refused refs_not_supported with the remedy,
    no quote id, and a start on any quote id holds nothing and makes no segment;
  * the same film without a reference is priced as before (the check asks only when there is one);
  * a Gemini-like model (references on t2i and edit; S10 is enabling gemini-3-pro-image and nano-banana-2.1) with a reference is priced;
  * a model whose spec does not state ref_capabilities at all (a registry not yet synced) is refused: unknown is not "supported";
  * a quote taken while the model said t2i, then a sync that says edit only: start_film's own re-pricing refuses, nothing is held;
  * the count check (inputs.image_refs_max) still answers first.

Runs in the money lab's own scratch database (test_sec_films_money's fixtures, imported as they are).
"""

from __future__ import annotations

import json

import pytest

from test_sec_films_money import SETTINGS, Db, a, db, err, no_live_segment, one_hour, refused  # noqa: F401

#: (id, ref_capabilities or None for "not stated", image_refs_max). Each priced on sale, t2i and edit, like the money lab's img-key.
KEYFRAME_MODELS = [("img-gptlike", ["edit"], 16), ("img-geminilike", ["t2i", "edit"], 14), ("img-unstated", None, 4),
                   ("img-flip", ["t2i", "edit"], 4)]
REMEDY = "remove the reference pictures or choose a key-frame model that takes them"


def _inputs(refs, n):
    return {"image_refs_max": n, **({} if refs is None else {"ref_capabilities": refs})}


@pytest.fixture(scope="module")
def models(db):
    """The key-frame models, added by the database owner beside the money lab's synced rows (a sync would disable those)."""
    for mid, refs, n in KEYFRAME_MODELS:
        spec = {"vendor_model": "acme-" + mid, "output": "image", "aspect_ratios": ["16:9", "9:16", "1:1"], "inputs": _inputs(refs, n)}
        unit = f"model_{mid.replace('-', '_')}_image"
        db.su("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
              "values (%s, %s, 'acme', 'image.acme', array['t2i', 'edit'], %s::jsonb, %s, 'any')", [mid, mid, json.dumps(spec), unit])
        db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 3, 0) "
              "on conflict (unit) do update set credits_per_unit = 3, margin = 0", [unit])
        db.su("select public.record_model_probe(%s, 'image.acme', %s, 'edit', true, null, null, 10, 100, 'security-lab')",
              [mid, "acme-" + mid])
        db.su("update public.model_registry set availability = 'beta' where id = %s", [mid])
    on_sale = {r[0] for r in db.su("select id from public.sellable_models('t2i', 'web')")}
    assert on_sale >= {m[0] for m in KEYFRAME_MODELS}, on_sale
    return {m[0] for m in KEYFRAME_MODELS}


def film_with(db, o, model, refs=True):
    fid = db.film(o, settings={**SETTINGS, "keyframe_model": model})
    if refs:
        db.save(o.editor, fid, db.version(fid), {"refs": [{"kind": "style", "asset_id": o.image}]})
    return fid


def keyframes(q):
    return [ln for ln in q["lines"] if ln["line"] == "keyframe"]


def test_a_gpt_image_like_key_frame_with_a_reference_is_refused_at_the_quote_and_nothing_is_held(db, models, a, one_hour):
    fid = film_with(db, a, "img-gptlike")
    q = db.quote(a.editor, fid)
    assert q["priced"] is False and q["total"] is None and q["quote_id"] is None
    kf = keyframes(q)
    assert kf and all(ln["priced"] is False and ln["reason"] == "refs_not_supported" for ln in kf), kf
    assert all(REMEDY in ln["detail"] and "img-gptlike" in ln["detail"] for ln in kf), kf
    before = db.account(a.org)
    out = db.start(a.admin, fid, f"fq-{db.version(fid)}-{'0' * 32}")
    assert out.get("ok") is False, out
    assert db.holds(a.org) == [] and db.account(a.org) == before
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0


def test_the_same_film_without_a_reference_is_priced(db, models, a):
    q = db.quote(a.editor, film_with(db, a, "img-gptlike", refs=False))
    assert q["priced"] is True and q["quote_id"], q["refusals"]
    assert all(ln["priced"] is True for ln in keyframes(q))


def test_a_gemini_like_model_that_takes_references_from_words_is_priced_with_one(db, models, a):
    q = db.quote(a.editor, film_with(db, a, "img-geminilike"))
    assert q["priced"] is True and q["quote_id"], q["refusals"]
    assert all(ln["priced"] is True and ln["capability"] == "t2i" for ln in keyframes(q))


def test_a_model_that_does_not_state_its_reference_capabilities_is_refused_with_a_reference(db, models, a):
    q = db.quote(a.editor, film_with(db, a, "img-unstated"))
    assert {ln["reason"] for ln in keyframes(q)} == {"refs_not_supported"} and q["quote_id"] is None
    # without a reference the missing field asks nothing
    assert db.quote(a.editor, film_with(db, a, "img-unstated", refs=False))["priced"] is True


def test_a_quote_taken_before_the_registry_said_edit_only_is_refused_at_start_and_nothing_is_held(db, models, a, one_hour):
    fid = film_with(db, a, "img-flip")
    q = db.quote(a.editor, fid)
    assert q["priced"] is True and q["quote_id"]
    try:
        db.su("update public.model_registry set spec = jsonb_set(spec, '{inputs,ref_capabilities}', '[\"edit\"]') where id = 'img-flip'")
        before = db.account(a.org)
        out = db.start(a.admin, fid, q["quote_id"])
        assert out.get("ok") is False, out
        assert db.holds(a.org) == [] and db.account(a.org) == before
        assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0
    finally:
        db.su("update public.model_registry set spec = jsonb_set(spec, '{inputs,ref_capabilities}', '[\"t2i\", \"edit\"]') "
              "where id = 'img-flip'")


def test_the_count_check_still_answers_first(db, models, a):
    """img-norefs (the money lab's) takes no reference at all: the refusal is still the count's, naming how many it takes."""
    fid = film_with(db, a, "img-norefs")
    kf = keyframes(db.quote(a.editor, fid))
    assert kf and all(ln["reason"] == "refs_not_supported" and "takes 0 reference pictures" in ln["detail"] for ln in kf), kf
