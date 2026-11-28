"""Migration 0239 (a film's key frame is quoted the way its take and the worker make it), in a real database.

Breach's file (test_sec_breach_0235_refs_take.py) asks only that nothing is held and then refused. This one pins the answers 0239 gives
and the ones it must not take away, each test named for what would break:

  * B1: an edit-only key-frame model is refused at save (the film's and a scene's), and at the quote for a film saved before 0239,
    model_not_available with the remedy; a t2i model is still saved and priced;
  * B2/B3: the style path counts what the worker sends: a style kit or @character with no description that the model cannot see is
    refused style_needs_description, naming it; one with a description, or one that still gets a slot beside the film's references, is
    priced; film references that fill every slot leave an undescribed kit refused;
  * B4: a reference character with a deleted picture is refused reference_missing, naming the remedy;
  * B6: more than 16 references are refused refs_not_supported even on a model that states 30;
  * the file: its bodies are internal; a replay changes nothing; the drift guard and the rollback refuse a hand-changed body; the
    rollback puts 0235's bodies back byte for byte and 0239 applies again; the lab chain takes 0239 off before 0235, 0218 and 0215
    and puts it back after them.

Runs in the money lab's own scratch database (test_sec_films_money's fixtures, imported as they are).
"""

from __future__ import annotations

import uuid

import psycopg
import pytest

import sec_db
from test_sec_breach_0235_refs_take import characters, keyframes, models, style_kit  # noqa: F401
from test_sec_films_money import SCENES, SETTINGS, Db, a, db, no_live_segment  # noqa: F401

MIGRATION = sec_db.MIGRATION_0239
ROLLBACK = sec_db.ROLLBACK_0239
REPLACED = ("public.film_price(public.films)", "public.film_apply_settings(public.films, jsonb, text[])",
            "public.film_save_scenes(public.films, jsonb)")
AFTER = {"public.film_price(public.films)": sec_db.FILM_PRICE_0239,
         "public.film_apply_settings(public.films, jsonb, text[])": sec_db.FILM_APPLY_SETTINGS_0239,
         "public.film_save_scenes(public.films, jsonb)": sec_db.FILM_SAVE_SCENES_0239}
REMEDY_T2I = "a key frame is made from words; choose a key-frame model that makes a picture from words"
REMEDY_STYLE = "add a description to the style kit or character, or choose a key-frame model that takes reference pictures"


def refusal(q, reason):
    return [r for r in q["refusals"] if r["reason"] == reason]


def save_refused(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.diag.message_primary, e.value.diag.message_detail or ""


# ── B1 ──────────────────────────────────────────────────────────────────────

def test_an_edit_only_model_is_refused_as_the_films_key_frame_model_at_save_with_the_remedy(db, models, a):
    word, detail = save_refused(lambda: db.film(a, settings={**SETTINGS, "keyframe_model": "img-editonly"}))
    assert word == "model_not_available" and detail.startswith("keyframe_model: img-editonly ") and REMEDY_T2I in detail


def test_an_edit_only_model_is_refused_as_a_scenes_key_frame_model_at_save_with_the_remedy(db, models, a):
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gemk"})
    word, detail = save_refused(lambda: db.save(a.editor, fid, db.version(fid),
                                                {"scenes": [{**SCENES[0], "keyframe_model": "img-editonly"}, SCENES[1]]}))
    assert word == "model_not_available" and detail.startswith("scene 1 keyframe_model: img-editonly ") and REMEDY_T2I in detail


def test_a_film_saved_with_an_edit_only_key_frame_model_before_0239_is_refused_at_the_quote(db, models, a):
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gemk"})
    db.su("update public.films set keyframe_model = 'img-editonly' where id = %s", [fid])
    q = db.quote(a.editor, fid)
    kf = keyframes(q)[0]
    assert q["quote_id"] is None and kf["reason"] == "model_not_available" and REMEDY_T2I in kf["detail"], kf


def test_a_model_that_makes_a_picture_from_words_is_still_saved_and_priced(db, models, a):
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gemk"})
    q = db.quote(a.editor, fid)
    assert q["priced"] is True, q["refusals"]
    assert keyframes(q)[0]["capability"] == "t2i"


# ── B2 / B3 ─────────────────────────────────────────────────────────────────

def test_an_undescribed_style_kit_on_a_model_that_takes_no_t2i_reference_is_refused_by_name(db, models, a):
    kit, _ = style_kit(db, a, 3, description="")
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gptk", "style_kit_id": kit})
    q = db.quote(a.editor, fid)
    kf = keyframes(q)[0]
    assert q["quote_id"] is None and kf["reason"] == "style_needs_description", kf
    assert "the style kit has no description" in kf["detail"] and REMEDY_STYLE in kf["detail"]


def test_an_undescribed_mentioned_character_is_refused_by_name_and_a_described_one_is_priced(db, models, a):
    characters(db, a, "deckhand", 2, description="")
    characters(db, a, "captain", 2, description="grey beard, blue coat")
    scenes = [{**SCENES[0], "visual_prompt": "@Captain and @deckhand at the rail"}, SCENES[1]]
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gptk"}, scenes=scenes)
    kf = keyframes(db.quote(a.editor, fid))[0]
    assert kf["reason"] == "style_needs_description" and "@deckhand has no description" in kf["detail"], kf
    assert "@captain" not in kf["detail"]
    db.save(a.editor, fid, db.version(fid), {"scenes": [{**SCENES[0], "visual_prompt": "@captain at the rail"}, SCENES[1]]})
    assert db.quote(a.editor, fid)["priced"] is True


def test_a_described_style_kit_is_priced_on_a_model_that_takes_no_t2i_reference(db, models, a):
    kit, _ = style_kit(db, a, 3, description="cold blue dusk")
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gptk", "style_kit_id": kit})
    q = db.quote(a.editor, fid)
    assert q["priced"] is True, q["refusals"]


def test_a_film_reference_and_an_undescribed_kit_on_a_small_model_is_priced_when_a_slot_is_left(db, models, a):
    kit, _ = style_kit(db, a, 3, description="")
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-lite", "style_kit_id": kit})
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "style", "asset_id": a.image}]})
    assert db.quote(a.editor, fid)["priced"] is True


def test_film_references_that_fill_every_slot_leave_an_undescribed_kit_refused(db, models, a):
    kit, _ = style_kit(db, a, 3, description="")
    cid, _ = characters(db, a, "pilot", 3)
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-lite", "style_kit_id": kit})
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "character", "character_id": cid}]})
    kf = keyframes(db.quote(a.editor, fid))[0]
    assert kf["reason"] == "style_needs_description" and "the style kit" in kf["detail"], kf


# ── B4 / B6 ─────────────────────────────────────────────────────────────────

def test_a_reference_character_with_a_deleted_picture_is_refused_with_the_remedy(db, models, a):
    cid, assets = characters(db, a, "keeper", 2)
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gemk"})
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "character", "character_id": cid}]})
    assert db.quote(a.editor, fid)["priced"] is True
    assert db.one("authenticated", a.editor, "select public.soft_delete_asset(%s::uuid)", [assets[0]]) is True
    q = db.quote(a.editor, fid)
    (r,) = [x for x in refusal(q, "reference_missing") if "reference character" in x["detail"]]
    assert q["quote_id"] is None and "remove it from the character" in r["detail"]


def test_more_than_sixteen_references_are_refused_even_on_a_model_that_states_thirty(db, models, a):
    refs = [{"kind": "character", "character_id": characters(db, a, f"hand_{i}", 6)[0]} for i in range(3)]
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-wide"})
    db.save(a.editor, fid, db.version(fid), {"refs": refs[:2]})
    assert db.quote(a.editor, fid)["priced"] is True  # 12
    db.save(a.editor, fid, db.version(fid), {"refs": refs})
    kf = keyframes(db.quote(a.editor, fid))[0]
    assert kf["reason"] == "refs_not_supported" and "at most 16 reference pictures and this scene has 18" in kf["detail"], kf


# ── the file ────────────────────────────────────────────────────────────────

def _md5s(c):
    return {sig: c.execute("select (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc "
                           "where oid = to_regprocedure(%s))", [sig]).fetchone()[0] for sig in REPLACED}


def test_the_bodies_are_0239s_internal_and_carry_their_marks(db):
    # 0241 sits on this file's film_price and film_save_scenes (its own lab is test_sec_film_dialogue_0241.py): off for the look.
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0241(c)
        assert _md5s(c) == AFTER
        for sig in REPLACED:
            for role in ("anon", "authenticated", "service_role"):
                assert c.execute("select has_function_privilege(%s, %s, 'execute')", [role, sig]).fetchone()[0] is False, (role, sig)
            assert "-- 0239" in c.execute("select prosrc from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0], sig
        # 0239 replaces neither start_film nor film_take_job (a later file does): 0198's / 0215's bodies stay.
        assert "0239" not in c.execute("select prosrc from pg_proc where oid = 'public.film_take_job(uuid, text)'::regprocedure").fetchone()[0]
        c.rollback()
    for path in (MIGRATION, ROLLBACK):
        assert "\\" not in path.read_text(encoding="utf-8"), path.name


@pytest.fixture
def scratch():
    admin = sec_db.admin_dsn()
    name = f"ns_m0239_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.build(admin, name)
    # 0241 sits on this file's film_price and film_save_scenes (its own lab is test_sec_film_dialogue_0241.py): off, so 0239 is the top.
    with psycopg.connect(dsn, autocommit=True) as c:
        sec_db.take_off_0241(c)
    try:
        yield dsn
    finally:
        sec_db.drop_database(admin, name)


def test_a_replay_changes_nothing_and_a_hand_changed_body_is_refused_by_the_file_and_its_rollback(scratch):
    with psycopg.connect(scratch, autocommit=True) as c:
        assert _md5s(c) == AFTER
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _md5s(c) == AFTER
        body = c.execute("select pg_get_functiondef('public.film_save_scenes(public.films, jsonb)'::regprocedure)").fetchone()[0]
        c.execute(body.replace("  return jsonb_array_length(p_scenes);\nend", "  return jsonb_array_length(p_scenes); -- by hand\nend", 1))
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "0239 found a public.film_save_scenes(public.films, jsonb)" in str(e.value)
        with pytest.raises(psycopg.Error) as e:
            c.execute(ROLLBACK.read_text(encoding="utf-8"))
        assert "rollback 0239: public.film_save_scenes(public.films, jsonb)" in str(e.value)


def test_the_rollback_puts_0235s_bodies_back_is_idempotent_and_0239_applies_again(scratch):
    with psycopg.connect(scratch, autocommit=True) as c:
        c.execute(ROLLBACK.read_text(encoding="utf-8"))
        back = _md5s(c)
        assert back == sec_db._BEFORE_0239
        c.execute(ROLLBACK.read_text(encoding="utf-8"))
        assert _md5s(c) == back
        assert sec_db.has_0235(c) and not sec_db.has_0239(c)
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _md5s(c) == AFTER


def test_the_lab_chain_takes_0239_off_before_0235_0218_and_0215_and_puts_it_back(scratch):
    with psycopg.connect(scratch, autocommit=True) as c:
        for off, on, gone in ((sec_db.take_off_0235, sec_db.put_back_0235, sec_db.has_0235),
                              (sec_db.take_off_0218, sec_db.put_back_0218, sec_db.has_0218),
                              (sec_db.take_off_0215, sec_db.put_back_0215, sec_db.has_0215)):
            assert sec_db.has_0239(c)
            off(c)
            assert not sec_db.has_0239(c) and not gone(c), off.__name__
            on(c)
            # The put-back chain ends on 0241 (on 0239's bodies): it comes back too, and off again here so 0239 is the top.
            assert sec_db.has_0241(c), on.__name__
            sec_db.take_off_0241(c)
            assert gone(c) and sec_db.has_0239(c) and _md5s(c) == AFTER, on.__name__
        # The text form the money lab runs (rollback_0218_if_on starts with 0235's, which starts with 0239's).
        c.execute(sec_db.rollback_0235_if_on())
        assert not sec_db.has_0239(c) and not sec_db.has_0235(c)
        sec_db.put_back_0235(c)
        assert sec_db.has_0239(c)
