"""0236 (Breach BR-SG-01, S1): a scene that asks for its clip's own sound is refused by name while the cut does not keep it.

What would break without each guard: a person charged the with-sound price for a clip whose sound the film then drops (rules 4 and 5);
the refusal living only in a panel, so a direct call to quote_film or start_film still sells it; a quote taken while the switch was on
started after it was turned off; the browser (anon or a member's session) or the worker's service key turning the switch itself; a
replay resetting the switch, the drift guard accepting a body that is not 0218's or its own, or the rollback leaving 0236's body or
column behind.

Runs in its own scratch database (it commits), with test_sec_films_money's registry plus one clip model priced by its sound.
"""

from __future__ import annotations

import json
import os
import uuid
from decimal import Decimal

import psycopg
import pytest

import sec_db
from test_sec_films_money import ASSEMBLY_RATE, JOB_MINIMUM, MODELS, SETTINGS, Db, refused

MIGRATION = sec_db.MIGRATIONS / "0236_film_clip_sound_gate.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0236_film_clip_sound_gate.sql"

#: A clip model priced by its sound (0070's variants, as kling-v3): 2 credits a second silent, 3 with sound.
SOUND_MODEL = ("vid-sound", "acme", "video.acme", ["t2v", "i2v"], "model_vid_sound_second",
               {"durations_s": [5, 10], "audio_out": True,
                "pricing": {"unit": "second", "variants": {"by": "audio", "prices": {"silent": None, "audio": None}}}})
SOUND_SETTINGS = {**SETTINGS, "clip_model": "vid-sound"}


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_clip_sound_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    models = [*[(m, p, a, c, u, s) for m, p, a, c, u, _r, s in MODELS], SOUND_MODEL]
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], **spec}}
            for m, prov, a, caps, unit, spec in models]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    prices = {unit: rate for _m, _p, _a, _c, unit, rate, _s in MODELS}
    # The base unit too, as 0070's lab does: sellable_models asks for the model's own row; the quote reads the variant's.
    prices.update({"model_vid_sound_second": 9, "model_vid_sound_second_silent": 2, "model_vid_sound_second_audio": 3,
                   "film_assembly_minute": ASSEMBLY_RATE, "job_minimum": JOB_MINIMUM})
    for unit, rate in prices.items():
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, rate])
    for m, _prov, a, caps, _unit, _spec in models:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
    assert d.su("select public.set_film_studio_enabled(true)")[0][0]["ok"] is True
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture
def a(db):
    return db.new_org(credits=500)


def kept(db, on: bool):
    """The owner's step, as the header says it: from the SQL editor, after the worker that keeps clip sound is deployed."""
    db.su("update public.film_studio_settings set clip_sound_kept = %s, updated_at = now() where id", [on])


@pytest.fixture(autouse=True)
def switch_off(db):
    kept(db, False)
    yield
    kept(db, False)


def sound_film(db, o, audio=True):
    fid = db.film(o, settings=SOUND_SETTINGS)
    db.su("update public.film_scenes set clip_params = %s::jsonb where film_id = %s and position = 0",
          [json.dumps({} if audio is None else {"audio": audio}), fid])
    return fid


def clip_lines(q, position=0):
    return [ln for ln in q["lines"] if ln["line"] in ("clip", "extend") and ln["position"] == position]


def test_the_switch_is_off_after_a_fresh_build(db):
    assert db.su("select clip_sound_kept from public.film_studio_settings where id")[0][0] is False


def test_a_scene_asking_for_clip_sound_is_refused_by_name_while_the_cut_drops_it(db, a):
    q = db.quote(a.editor, sound_film(db, a))
    lines = clip_lines(q)
    assert lines and {(ln["priced"], ln["reason"]) for ln in lines} == {(False, "clip_sound_not_kept")}, lines
    assert all("clip sound is not yet kept in the final film" in ln["detail"] for ln in lines)
    assert "clip_sound_not_kept" in {r["reason"] for r in q["refusals"]}
    assert q["total"] is None and q["quote_id"] is None
    # The other scene (no clip sound asked) is priced as before.
    assert all(ln["priced"] for ln in clip_lines(q, 1))


def test_a_silent_or_unset_scene_is_priced_as_before_while_off(db, a):
    for audio in (False, None):
        q = db.quote(a.editor, sound_film(db, a, audio=audio))
        assert q["priced"] is True, (audio, q["refusals"])
        assert all(ln["params"].get("audio") is not True for ln in clip_lines(q))


def test_with_the_switch_on_the_sound_is_priced_at_its_own_variant(db, a):
    kept(db, True)
    q = db.quote(a.editor, sound_film(db, a))
    assert q["priced"] is True, q["refusals"]
    lines = clip_lines(q)
    assert all(ln["params"]["audio"] is True for ln in lines)
    assert {Decimal(str(ln["credits"])) for ln in lines} == {Decimal(3) * Decimal(str(lines[0]["duration_s"]))}


def test_a_quote_taken_while_on_is_refused_at_start_once_off_and_nothing_is_held(db, a):
    kept(db, True)
    fid = sound_film(db, a)
    qid = db.quote(a.editor, fid)["quote_id"]
    assert qid
    kept(db, False)
    assert refused(db.start(a.admin, fid, qid)) == ("clip_sound_not_kept", "NS400")
    assert db.holds(a.org) == []
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
def test_no_api_role_reads_or_turns_the_switch(db, a, role):
    for q in ("select clip_sound_kept from public.film_studio_settings",
              "update public.film_studio_settings set clip_sound_kept = true where id"):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, a.owner if role == "authenticated" else None, q)
        assert e.value.sqlstate == "42501", (role, q)
    assert db.su("select clip_sound_kept from public.film_studio_settings where id")[0][0] is False


def test_film_price_stays_internal(db):
    for role in ("anon", "authenticated", "service_role"):
        assert db.su("select has_function_privilege(%s, 'public.film_price(public.films)', 'EXECUTE')", [role])[0][0] is False


def _md5(db):
    return db.su("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc "
                 "where oid = 'public.film_price(public.films)'::regprocedure")[0][0]


def test_a_replay_changes_nothing_and_keeps_the_switch(db):
    kept(db, True)
    db.su(MIGRATION.read_text(encoding="utf-8"))
    assert _md5(db) == sec_db.FILM_PRICE_0236
    assert db.su("select clip_sound_kept from public.film_studio_settings where id")[0][0] is True


def test_the_drift_guard_refuses_a_body_that_is_neither_0218s_nor_its_own(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("comment on function public.film_price(public.films) is 'drift'")  # a comment is not the body: still accepted
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        src = c.execute("select prosrc from pg_proc where oid = 'public.film_price(public.films)'::regprocedure").fetchone()[0]
        c.execute("select set_config('lab.src', %s, true)", [src.replace("'clip_sound_not_kept'", "'something_else'")])
        c.execute("do $d$ begin execute 'create or replace function public.film_price(p_film public.films) returns jsonb "
                  "language plpgsql stable security definer set search_path = public, pg_temp as ' "
                  "|| quote_literal(current_setting('lab.src')); end $d$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "neither 0218" in str(e.value)
        c.rollback()
    assert _md5(db) == sec_db.FILM_PRICE_0236


def test_the_rollback_puts_0218_back_and_drops_the_column_and_0236_applies_again(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0236(c)
        assert c.execute("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc "
                         "where oid = 'public.film_price(public.films)'::regprocedure").fetchone()[0] == sec_db.FILM_PRICE_0218
        assert c.execute("select count(*) from information_schema.columns where table_schema = 'public' "
                         "and table_name = 'film_studio_settings' and column_name = 'clip_sound_kept'").fetchone()[0] == 0
        sec_db.put_back_0236(c)
        assert sec_db.has_0236(c)
        assert c.execute("select clip_sound_kept from public.film_studio_settings where id").fetchone()[0] is False
        c.rollback()


def test_the_file_holds_no_backslash_and_marks_its_hunk(db):
    for path in (MIGRATION, ROLLBACK):
        assert "\\" not in path.read_text(encoding="utf-8"), path.name
    body = MIGRATION.read_text(encoding="utf-8")
    assert body.count("  -- 0236\n") == 5      # the hunk's five lines, each marked
