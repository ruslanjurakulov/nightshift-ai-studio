"""Breach on 0236 (the film clip-sound gate): the paths 0236's own tests do not walk.

0236 claims that while film_studio_settings.clip_sound_kept is off, no film whose clips carry the priced sound option
(clip_params.audio = true) is quoted, held, started or resumed, and that no API role reads or turns the switch. Its own file pins the
quote, start_film with a quote taken while on, the table grants, replay and rollback. What would break without each test here:

  * the gate compares clip_params -> 'audio' with the JSON true only, while film_price hands the raw value on to creative_price,
    which reads it with ->> and ::boolean ("true", "yes", "on", 1 all mean sound there). So the gate holds only while every writer
    of film_scenes.clip_params stores a JSON boolean: a writer that stores "true" would be sold sound past the gate;
  * the resume path (quote_film_resume, start_film_resume) re-prices through film_resume_price -> film_price, but only the lines
    still to make keep their refusals: a resume quote taken while on must not start once off, and a carried take must not make
    the gate refuse a resume that sells no sound;
  * a SECURITY DEFINER function executable by an API role that reads film_studio_settings would hand the switch to a browser
    or the worker's key (the table grants alone do not stop that), and one that writes it would let a non-owner turn it on.

Runs in its own scratch database (it commits), on the money lab of test_sec_films_money plus 0236's sound-priced clip model.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from test_sec_film_clip_sound_0236 import SOUND_SETTINGS, clip_lines, db, kept, switch_off  # noqa: F401 — 0236's own lab
from test_sec_films_money import SCENES, err, no_live_segment, refused  # noqa: F401


@pytest.fixture
def a(db):
    return db.new_org(credits=500)


def film_with(db, o, clip_params_by_position):
    scenes = [dict(s) for s in SCENES]
    for pos, cp in clip_params_by_position.items():
        scenes[pos]["clip_params"] = cp
    return db.film(o, settings=SOUND_SETTINGS, scenes=scenes)


# ── 1. Where the flag lives: only a JSON boolean ever reaches film_scenes.clip_params ─────────────────────────────────────────────

@pytest.mark.parametrize("cp", [
    {"audio": "true"}, {"audio": "yes"}, {"audio": "on"}, {"audio": 1}, {"audio": "1"}, {"audio": "t"}, {"audio": None},
    {"audio": [True]}, {"audio": {"on": True}},
    {"Audio": True}, {"AUDIO": True}, {"audio ": True}, {"generate_audio": True}, {"sound": "on"},
])
def test_a_sound_flag_that_is_not_the_json_true_never_reaches_a_scene(db, a, cp):
    """creative_price reads params ->> 'audio' as ::boolean: any of these, stored, would be priced (and made) with sound while
    0236's `= 'true'::jsonb` lets it past. film_save_scenes must refuse every one of them at the save."""
    code, word, _detail = err(lambda: film_with(db, a, {0: cp}))
    assert (code, word) == ("NS400", "invalid_params"), cp


def test_no_scene_in_the_lab_holds_an_audio_value_other_than_a_json_boolean(db):
    """The invariant the gate leans on, checked on every row any test (or a later writer) left behind."""
    assert db.su("select count(*) from public.film_scenes where clip_params ? 'audio' "
                 "and jsonb_typeof(clip_params -> 'audio') <> 'boolean'")[0][0] == 0


def test_a_duplicate_json_key_resolves_to_the_last_value_and_the_gate_reads_that_one(db, a):
    """'{"audio": false, "audio": true}' is true in jsonb (last key wins): the gate and creative_price read the same value."""
    fid = db.film(a, settings=SOUND_SETTINGS)
    sid = db.su("select id from public.film_scenes where film_id = %s and position = 0", [fid])[0][0]
    raw = '{"scenes": [{"id": "%s", "clip_params": {"audio": false, "audio": true}}]}' % sid
    db.one("authenticated", a.editor, "select public.save_film(%s::uuid, %s::integer, %s::jsonb)", [fid, db.version(fid), raw])
    assert db.su("select clip_params -> 'audio' from public.film_scenes where id = %s", [sid])[0][0] is True
    q = db.quote(a.editor, fid)
    assert {ln["reason"] for ln in clip_lines(q)} == {"clip_sound_not_kept"} and q["quote_id"] is None


# ── 2. The resume path ────────────────────────────────────────────────────────────────────────────────────────────────────────

def positions(db, fid):
    return {str(r[0]): r[1] for r in db.su("select id, position from public.film_scenes where film_id = %s", [fid])}


def paused_with_failed(db, o, failed_position, sound_position):
    """Started while the switch is on, scene `failed_position`'s clip failed twice, everything else made, settled takes_failed."""
    kept(db, True)
    fid = film_with(db, o, {sound_position: {"audio": True}})
    seg = db.quoted_start(o, fid)
    assert db.claim("w-cs")["id"] == seg["id"]
    pos = positions(db, fid)
    for t in db.takes(seg["id"]):
        tid, kind, scene = str(t[0]), t[1], t[2]
        if kind == "clip" and pos[str(scene)] == failed_position:
            db.begin(tid, "w-cs")
            retry = db.fail(tid, "provider_error", "w-cs")["retry_take_id"]
            db.begin(retry, "w-cs")
            db.fail(retry, "provider_error", "w-cs")
        else:
            db.make(o, tid, kind, "w-cs")
    assert db.settle(seg["id"], "takes_failed", "w-cs")["settled"] is True
    assert db.film_row(fid) == ("paused", "takes_failed")
    return fid, seg


def rquote(db, who, fid):
    return db.one("authenticated", who, "select public.quote_film_resume(%s::uuid, %s::integer)", [fid, db.version(fid)])


def resume(db, who, fid, quote_id):
    return db.one("authenticated", who, "select public.start_film_resume(%s::uuid, %s, %s)", [fid, quote_id, db.key()])


def test_a_resume_that_would_remake_a_sound_clip_is_refused_once_off_even_with_a_quote_taken_while_on(db, a):
    fid, _seg = paused_with_failed(db, a, failed_position=1, sound_position=1)
    on_quote = rquote(db, a.admin, fid)
    assert on_quote["priced"] is True and on_quote["quote_id"], on_quote["refusals"]
    held_before = db.holds(a.org)
    kept(db, False)
    q = rquote(db, a.admin, fid)
    assert q["priced"] is False and q["quote_id"] is None
    assert "clip_sound_not_kept" in {r["reason"] for r in q["refusals"]}
    assert refused(resume(db, a.admin, fid, on_quote["quote_id"])) == ("clip_sound_not_kept", "NS400")
    assert db.holds(a.org) == held_before
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1


def test_a_carried_sound_take_sells_nothing_and_does_not_block_the_resume_of_a_silent_scene(db, a):
    """The other way round: the gate must not refuse wrongly. Scene 1's sound clip was made (and paid) while on; only silent
    scene 2 is left. Once off, the resume carries the made take at 0 and prices only silent work."""
    fid, _seg = paused_with_failed(db, a, failed_position=1, sound_position=0)
    kept(db, False)
    q = rquote(db, a.admin, fid)
    assert q["priced"] is True, q["refusals"]
    assert all(ln["params"].get("audio") is not True for ln in q["lines"] if ln["line"] in ("clip", "extend"))
    assert any(c["position"] == 0 and Decimal(str(c["credits"])) == 0 for c in q["carried"] if c["line"] == "clip")
    out = resume(db, a.admin, fid, q["quote_id"])
    assert out.get("ok") is True, out
    made_with_sound = db.su("select count(*) from public.film_takes where segment_id = %s and status = 'planned' "
                            "and params -> 'audio' = 'true'::jsonb", [out["id"]])[0][0]
    assert made_with_sound == 0


# ── 3. The switch through a function ──────────────────────────────────────────────────────────────────────────────────────────

API_ROLES = ("anon", "authenticated", "service_role")


def test_no_function_an_api_role_may_call_names_clip_sound_kept_or_reads_the_whole_switch_row(db):
    """Grants on the table stop a direct read; a SECURITY DEFINER function does not ask them. Every function an API role can execute
    whose body touches film_studio_settings is listed, and none of them names clip_sound_kept or reads the row whole."""
    rows = db.su(
        "select p.oid::regprocedure::text, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
        "where n.nspname = 'public' and p.prosrc ~* 'film_studio_settings' "
        "and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') "
        "     or has_function_privilege('service_role', p.oid, 'execute'))")
    for sig, src in rows:
        assert "clip_sound_kept" not in src, sig
        assert not any(pat in src.replace(" ", "") for pat in ("select*frompublic.film_studio_settings",
                                                                "to_jsonb(s)", "row_to_json")), sig
    # Only film_price names the column, and no API role executes it.
    named = {r[0] for r in db.su("select p.oid::regprocedure::text from pg_proc p where p.prosrc ~ 'clip_sound_kept'")}
    assert named == {"film_price(films)"}, named


def test_the_platform_switch_function_never_writes_clip_sound_kept(db):
    """set_film_studio_enabled (0171: a platform owner or admin through owner_guard) updates the same row. It must leave the clip
    sound switch where the SQL editor put it, both ways."""
    for want in (False, True):
        kept(db, want)
        for flip in (False, True):
            assert db.su("select public.set_film_studio_enabled(%s)", [flip])[0][0]["ok"] is True
            assert db.su("select clip_sound_kept from public.film_studio_settings where id")[0][0] is want
    kept(db, False)


@pytest.mark.parametrize("role", API_ROLES)
def test_no_api_role_writes_the_switch_row_by_insert_upsert_or_delete(db, a, role):
    """0236's own test tries select and update; an upsert or a delete-then-insert is the other way to a row with the column on."""
    for q in ("insert into public.film_studio_settings (id, clip_sound_kept) values (true, true) "
              "on conflict (id) do update set clip_sound_kept = true",
              "delete from public.film_studio_settings"):
        code, _w, _d = err(lambda: db.act(role, a.owner if role == "authenticated" else None, q))
        assert code == "42501", (role, q)
    assert db.su("select clip_sound_kept from public.film_studio_settings where id")[0][0] is False


@pytest.mark.parametrize("role", ["service_role", "anon"])
def test_the_worker_key_or_a_forged_claim_quotes_starts_or_resumes_nothing(db, a, role):
    """A forged request.jwt.claims naming the org's admin under a non-member role still cannot reach the sale."""
    fid = film_with(db, a, {0: {"audio": True}})
    for q, p in (("select public.quote_film(%s::uuid, 1)", [fid]),
                 ("select public.start_film(%s::uuid, 'fq-1-' || md5('x'), 'forged-key-0001')", [fid]),
                 ("select public.quote_film_resume(%s::uuid, 1)", [fid]),
                 ("select public.start_film_resume(%s::uuid, 'fq-1-' || md5('x'), 'forged-key-0002')", [fid])):
        code, _w, _d = err(lambda: db.act(role, a.admin, q, p))
        assert code == "42501", (role, q)
    assert db.holds(a.org) == []


def test_a_take_job_carries_only_the_takes_frozen_params_never_the_scenes_current_sound(db, a):
    """film_take_job builds the vendor request from film_takes.params (frozen at start), so a scene turned to sound after a silent
    start is not sent audio:true. The scene can only be edited while the film is editable, which a started film is not."""
    fid = film_with(db, a, {0: {"audio": False}})
    seg = db.quoted_start(a, fid)
    sid = db.su("select id from public.film_scenes where film_id = %s and position = 0", [fid])[0][0]
    code, word, _d = err(lambda: db.save(a.editor, fid, db.version(fid),
                                         {"scenes": [{"id": str(sid), "clip_params": {"audio": True}}]}))
    assert code.startswith("NS4"), (code, word)
    assert db.su("select count(*) from public.film_takes where segment_id = %s and params -> 'audio' = 'true'::jsonb",
                 [seg["id"]])[0][0] == 0
    assert json.loads(json.dumps(db.su("select clip_params from public.film_scenes where id = %s", [sid])[0][0])) == {"audio": False}
