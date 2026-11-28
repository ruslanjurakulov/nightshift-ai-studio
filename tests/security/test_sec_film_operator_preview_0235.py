"""Migration 0235 (Film Studio lets the platform operator use an operator-preview model in the operator's own organization), attacked
in a real database.

0139 lets the operator use a hidden model marked `"operator_preview": true` in the Studio: creative_operator_preview(org, availability,
spec) holds only for a hidden row marked with the JSON true, a caller whose own JWT is a platform owner/admin, and the credits-exempt
organization. Its member check is vacuous for a platform admin (0043's accessible_org_ids makes every platform owner/admin a member of
every organization), so the audience is every platform owner/admin in the exempt organization, the same as start_film's exempt branch
(Breach 0235-I1, informational). Film Studio's own model check (0166's film_check_model, 0171's film_model_problem) asked
sellable_models with no organization, so it refused every hidden model for everyone. 0235 gives that check the film's organization.
What would break without each guard (each test names it):

  * the operator: a film narrated by a preview voice is saved, quoted (the narration line says preview), started (no hold: the exempt
    organization), claimed and taken (film_take_job makes the take's creative job on the preview model, the service role asking);
    and resumed (film_resume_precheck through quote_film_resume);
  * everyone else is answered exactly as before, model_not_available: a customer's editor and admin (save, quote, start), a platform
    admin acting in a customer's organization (save, quote, start), a member of the exempt organization who is not a platform admin
    (save, quote, resume), and the service role or a caller with no JWT asking the check itself;
  * the operator too, for a preview that is disabled, not marked (or marked with a string), never probed, past its shutdown date,
    switched off by the owner, or listed for another capability; a Seedance model is refused first, marked or not;
  * the migration: the two overloads are internal (no API role, the service role included, may call them); the three-argument check is
    unchanged; a replay changes nothing; the drift guard refuses a body that is not its predecessor's or its own; the rollback refuses
    the same, puts every body back byte for byte, drops the overloads (the operator is refused again), and 0235 applies again.

Runs in the money lab's own scratch database (test_sec_films_money's fixtures, imported as they are), with the operator's organization
(the credits-exempt default organization) and the preview rows added here by the database owner.
"""

from __future__ import annotations

import json
import uuid

import psycopg
import pytest

import sec_db
from test_sec_films_money import SCENES, SETTINGS, Db, Org, a, b, db, err, no_live_segment, one_hour, refused  # noqa: F401

MIGRATION = sec_db.MIGRATION_0235
ROLLBACK = sec_db.ROLLBACK_0235
EXEMPT = "00000000-0000-0000-0000-000000000001"
PREVIEW = "tts-preview"
PREVIEW_VOICE = {"source": "creative_tts", "model": PREVIEW, "voice_id": "voice_lab_1"}
#: Each a hidden TTS row the operator must still be refused: (id, what is wrong with it).
NOT_RUNNABLE = [("tts-pv-disabled", "disabled"), ("tts-pv-unmarked", "not marked"), ("tts-pv-string", "marked with a string"),
                ("tts-pv-unprobed", "never probed"), ("tts-pv-past", "past its shutdown date"), ("tts-pv-off", "switched off"),
                ("tts-pv-sfx", "listed for another capability")]
SEEDANCE = "seedance-pv"
SIGS = {"check4": "public.film_check_model(text, text[], text, uuid)", "problem4": "public.film_model_problem(text, text[], text, uuid)",
        "check3": "public.film_check_model(text, text[], text)", "problem3": "public.film_model_problem(text, text[], text)"}
REPLACED = ("public.film_price(public.films)", "public.film_precheck(public.films)", "public.film_resume_precheck(public.films, uuid)",
            "public.film_apply_settings(public.films, jsonb, text[])", "public.film_save_scenes(public.films, jsonb)")


def _row(db, mid, *, caps=("tts",), adapter="audio.acme", availability="hidden", probed=True, **spec):
    base = {"vendor_model": "acme-" + mid, "output": "audio", "operator_preview": True, "terms_gate": "plan_required:scale",
            "pricing": {"unit": "character", "provider_usd_per_unit": 0.0001}, "languages": ["uz", "ru", "en"]}
    base.update(spec)
    base = {k: v for k, v in base.items() if v is not _DROP}
    db.su("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
          "values (%s, %s, 'acme', %s, %s, %s::jsonb, %s, 'models_audio:premium')",
          [mid, mid, adapter, list(caps), json.dumps(base), f"model_{mid.replace('-', '_')}_character"])
    if probed:
        db.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
              [mid, adapter, "acme-" + mid, caps[-1]])
    if availability != "hidden":
        db.su("update public.model_registry set availability = %s where id = %s", [availability, mid])


_DROP = object()


class People:
    def __init__(self, operator, dana, staff, org):
        self.operator, self.dana, self.staff = operator, dana, staff
        # The operator's organization, as the money lab's helpers read one: the operator quotes and starts there.
        self.org = org


def _user(db, email, uid=None):
    uid = uid or str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, %s)", [uid, email])
    return uid


@pytest.fixture(scope="module")
def pv(db):
    """The operator's organization and the preview rows, written by the database owner once for this module."""
    _row(db, PREVIEW)
    _row(db, "tts-pv-disabled", availability="disabled")
    _row(db, "tts-pv-unmarked", operator_preview=_DROP)
    _row(db, "tts-pv-string", operator_preview="true")
    _row(db, "tts-pv-unprobed", probed=False)
    _row(db, "tts-pv-past", shutdown={"on": "2000-01-01", "source_url": "https://example.com/deprecations", "as_of": "2026-11-12"})
    _row(db, "tts-pv-off")
    _row(db, "tts-pv-sfx", caps=("sfx",))
    _row(db, SEEDANCE, caps=("i2v",), adapter="video.seedance", output="video")
    # The owner's switch, put in force for one model only (every other row stays available).
    db.su("update public.model_availability_settings set enforced = true")
    operator = _user(db, "operator@preview.lab")
    dana = _user(db, "dana@preview.lab")
    staff = _user(db, "staff@preview.lab")
    db.su("insert into public.model_availability (scope, target, enabled, reason, note, changed_by) "
          "values ('model', 'tts-pv-off', false, 'other', 'lab', %s)", [operator])
    # The roster is claimed (the production state): the operator owns the platform, staff is a platform admin; Dana is an admin of the
    # operator's organization and nothing on the platform.
    db.su("insert into public.app_members (user_id, email, role) values (%s, 'operator@preview.lab', 'owner'), "
          "(%s, 'staff@preview.lab', 'admin')", [operator, staff])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'operator@preview.lab', 'owner'), "
          "(%s, %s, 'dana@preview.lab', 'admin')", [EXEMPT, operator, EXEMPT, dana])
    db.film_org_on(EXEMPT)
    org = Org(EXEMPT, operator, operator, operator, dana)
    org.image = db.asset(EXEMPT)
    sellable = {r[0] for r in db.su("select id from public.sellable_models(null, 'web')")}
    assert not sellable & {PREVIEW, SEEDANCE, *(m for m, _ in NOT_RUNNABLE)}, "a preview row is on sale: the lab proves nothing"
    assert db.su("select public.credits_exempt(%s), not public.credits_exempt(%s)", [EXEMPT, str(uuid.uuid4())])[0] == (True, True)
    return People(operator, dana, staff, org)


def staff_in(db, pv, o):
    """The platform admin is also an owner of a customer's organization: the case the rule must still refuse."""
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'staff@preview.lab', 'owner') "
          "on conflict do nothing", [o.org, pv.staff])


def preview_settings(voice=None):
    return {**SETTINGS, "voice": voice or PREVIEW_VOICE}


def draft(db, who, org, settings):
    return db.one("authenticated", who, "select public.create_film_draft(%s::uuid, null, 'topic', %s, %s::jsonb, %s)",
                  [org, "A lighthouse keeper's last night", json.dumps(settings), db.key()])


def operator_film(db, pv, voice=None):
    f = draft(db, pv.operator, EXEMPT, preview_settings(voice))
    fid = f["film"]["id"]
    db.save(pv.operator, fid, 1, {"scenes": SCENES})
    return fid


def with_voice(db, fid, model):
    """The film row given a voice model behind the code's back (the database owner): what a film saved while a model was on sale, or
    before a registry change, holds. The quote and the start must refuse it on their own."""
    db.su("update public.films set voice = jsonb_set(voice, '{model}', to_jsonb(%s::text)) where id = %s", [model, fid])


def narration(q):
    return next(ln for ln in q["lines"] if ln["line"] == "narration")


def fake_quote_id(db, fid):
    return f"fq-{db.version(fid)}-{'0' * 32}"


def refused_word(fn):
    code, word, detail = err(fn)
    return code, word, detail


def as_jwt(db, who, q, p=None):
    """Run q as the database owner with `who`'s JWT claims set (None: no JWT), to ask the internal check itself."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)",
                  [json.dumps({"role": "authenticated", "sub": who} if who else {})])
        v = c.execute(q, p).fetchone()[0]
        c.rollback()
        return v


def problem(db, who, model, org, caps=("tts",)):
    return as_jwt(db, who, "select public.film_model_problem(%s, %s, 'voice.model', %s::uuid)", [model, list(caps), org])


# ── the operator ──────────────────────────────────────────────────────────────

def test_the_operator_saves_quotes_and_starts_a_film_narrated_by_a_preview_voice_with_no_hold(db, pv, one_hour):
    fid = operator_film(db, pv)
    q = db.quote(pv.operator, fid)
    assert q["priced"] is True and q["quote_id"], q["refusals"]
    n = narration(q)
    assert n["priced"] is True and n["model"] == PREVIEW and n.get("preview") is True, n
    # The vendor's cost (0.0001 USD a character = 0.01 credits), never a price on sale: no credit_prices row was written.
    assert float(n["credits_per_unit"]) == 0.01, n
    assert db.su("select count(*) from public.credit_prices where unit = 'model_tts_preview_character'")[0][0] == 0
    out = db.start(pv.operator, fid, q["quote_id"])
    assert out.get("ok") is True, out
    seg = db.su("select credit_ref, status from public.film_segments where id = %s", [out["id"]])[0]
    assert seg == (None, "queued"), seg
    assert db.holds(EXEMPT) == []
    kinds = {t[1] for t in db.takes(out["id"])}
    assert "narration" in kinds


def test_at_take_time_the_service_role_makes_the_narrations_job_on_the_preview_model(db, pv, one_hour):
    """No database function at take or claim time asks whether a model is on sale (0198's film_take_job and film_begin_take): the
    worker's own recheck does, with previews for the exempt organization only (tests/test_creative_model_recheck.py). So the operator's
    preview take gets its creative job, made by the service role with no JWT, on exactly the model that was priced."""
    fid = operator_film(db, pv)
    seg = db.quoted_start(pv.org, fid)["id"]
    assert db.claim()["id"] == seg
    take = next(t for t in db.takes(seg) if t[1] == "narration")
    assert db.begin(take[0])["began"] is True
    out = db.svc("select public.film_take_job(%s, 'w-1')", [take[0]])
    assert out["ok"] is True and out["capability"] == "tts", out
    job = db.su("select requested_model, payer, org_id::text from public.creative_jobs where id = %s", [out["job_id"]])[0]
    assert job == (PREVIEW, "film", EXEMPT), job
    # Nothing is sent in the lab: the take fails (its one retry is planned, not in flight) and the segment is cancelled, so the next
    # test's film is not held back by the one-film-at-a-time limit.
    db.fail(take[0], "provider_error")
    db.cancel(seg)


def paused_on_narration(db, o, fid):
    """Started, claimed, the narration failed twice, everything else made, settled takes_failed: paused, the narration still to make."""
    seg = db.quoted_start(o, fid)["id"]
    assert db.claim()["id"] == seg
    for t in db.takes(seg):
        tid, kind = str(t[0]), t[1]
        if kind == "narration":
            db.begin(tid)
            retry = db.fail(tid, "provider_error")["retry_take_id"]
            db.begin(retry)
            db.fail(retry, "provider_error")
        else:
            db.make(o, tid, kind)
    db.settle(seg, "takes_failed")
    assert db.film_row(fid) == ("paused", "takes_failed")
    return seg


def test_a_paused_operator_film_is_resumed_with_its_preview_narration(db, pv, one_hour):
    fid = operator_film(db, pv)
    paused_on_narration(db, pv.org, fid)
    rq = db.one("authenticated", pv.operator, "select public.quote_film_resume(%s::uuid, %s::integer)", [fid, db.version(fid)])
    assert rq["priced"] is True and rq["quote_id"], rq
    n = narration(rq)
    assert n["model"] == PREVIEW and n["priced"] is True and n.get("preview") is True, n
    # Dana administers the operator's organization but is no platform admin: a resume there is the platform's to start (0215).
    code, word, _ = refused_word(lambda: db.one("authenticated", pv.dana, "select public.quote_film_resume(%s::uuid, %s::integer)",
                                                [fid, db.version(fid)]))
    assert (code, word) == ("42501", "forbidden")
    out = db.one("authenticated", pv.operator, "select public.start_film_resume(%s::uuid, %s, %s)", [fid, rq["quote_id"], db.key()])
    assert out.get("ok") is True, out


# ── everyone else, as before ──────────────────────────────────────────────────

def test_a_customers_editor_cannot_save_a_preview_voice(db, pv, a):
    code, word, detail = refused_word(lambda: draft(db, a.editor, a.org, preview_settings()))
    assert (code, word) == ("NS400", "model_not_available") and PREVIEW in detail


def test_a_customers_quote_and_start_still_refuse_the_preview_voice_as_model_not_available(db, pv, a, one_hour):
    fid = db.film(a)
    with_voice(db, fid, PREVIEW)
    q = db.quote(a.editor, fid)
    assert q["priced"] is False and q["quote_id"] is None
    n = narration(q)
    assert n["priced"] is False and n["reason"] == "model_not_available", n
    code, word, _ = refused_word(lambda: db.start(a.admin, fid, fake_quote_id(db, fid)))
    assert (code, word) == ("NS400", "model_not_available")
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0


def test_a_customers_paused_film_whose_narration_is_a_preview_is_not_resumed(db, pv, a, one_hour):
    """The resume quote prices the voice through film_price, and the resume start asks film_resume_precheck (each remaining take's
    own model): a preview there, written behind the code's back, is refused by name in both."""
    fid = db.film(a)
    seg = paused_on_narration(db, a, fid)
    with_voice(db, fid, PREVIEW)
    db.su("update public.film_takes set model = %s where segment_id = %s and kind = 'narration'", [PREVIEW, seg])
    rq = db.one("authenticated", a.admin, "select public.quote_film_resume(%s::uuid, %s::integer)", [fid, db.version(fid)])
    assert rq["priced"] is False and rq["quote_id"] is None, rq
    n = narration(rq)
    assert n["priced"] is False and n["reason"] == "model_not_available", n
    # The resume start asks film_resume_precheck before it counts or prices anything, and raises its word.
    code, word, detail = refused_word(lambda: db.one("authenticated", a.admin, "select public.start_film_resume(%s::uuid, %s, %s)",
                                                     [fid, fake_quote_id(db, fid), db.key()]))
    assert (code, word) == ("NS400", "model_not_available") and PREVIEW in detail, (code, word, detail)


def test_a_platform_admin_acting_in_a_customers_organization_is_refused_too(db, pv, b, one_hour):
    staff_in(db, pv, b)
    code, word, _ = refused_word(lambda: draft(db, pv.staff, b.org, preview_settings()))
    assert (code, word) == ("NS400", "model_not_available")
    fid = db.film(b)
    with_voice(db, fid, PREVIEW)
    n = narration(db.quote(pv.staff, fid))
    assert n["priced"] is False and n["reason"] == "model_not_available", n
    code, word, _ = refused_word(lambda: db.start(pv.staff, fid, fake_quote_id(db, fid)))
    assert (code, word) == ("NS400", "model_not_available")


def test_a_member_of_the_exempt_organization_who_is_not_a_platform_admin_is_refused(db, pv, one_hour):
    code, word, _ = refused_word(lambda: draft(db, pv.dana, EXEMPT, preview_settings()))
    assert (code, word) == ("NS400", "model_not_available")
    fid = operator_film(db, pv)
    n = narration(db.quote(pv.dana, fid))
    assert n["priced"] is False and n["reason"] == "model_not_available", n


def test_the_check_itself_passes_only_the_operators_own_jwt_in_the_exempt_organization(db, pv, a):
    assert problem(db, pv.operator, PREVIEW, EXEMPT) is None
    for who, org in ((None, EXEMPT), (pv.dana, EXEMPT), (pv.operator, a.org), (a.owner, a.org), (pv.operator, None)):
        got = problem(db, who, PREVIEW, org)
        assert got is not None and got["reason"] == "model_not_available", (who, org, got)
    # The three-argument check (0166) never passes a preview, whoever asks.
    got = as_jwt(db, pv.operator, "select public.film_model_problem(%s, array['tts'], 'voice.model')", [PREVIEW])
    assert got["reason"] == "model_not_available", got


@pytest.mark.parametrize("model,why", NOT_RUNNABLE)
def test_the_operator_is_refused_a_preview_that_is_not_runnable(db, pv, model, why):
    assert problem(db, pv.operator, model, EXEMPT)["reason"] == "model_not_available", why
    code, word, _ = refused_word(lambda: draft(db, pv.operator, EXEMPT, preview_settings({**PREVIEW_VOICE, "model": model})))
    assert (code, word) == ("NS400", "model_not_available"), why


def test_the_operators_quote_and_start_refuse_a_preview_that_stopped_being_runnable(db, pv, one_hour):
    fid = operator_film(db, pv)
    with_voice(db, fid, "tts-pv-off")
    assert narration(db.quote(pv.operator, fid))["reason"] == "model_not_available"
    code, word, _ = refused_word(lambda: db.start(pv.operator, fid, fake_quote_id(db, fid)))
    assert (code, word) == ("NS400", "model_not_available")


def test_seedance_is_refused_first_even_marked_as_a_preview_for_the_operator(db, pv):
    got = problem(db, pv.operator, SEEDANCE, EXEMPT, caps=("i2v",))
    assert got["reason"] == "model_not_offered", got
    code, word, _ = refused_word(lambda: draft(db, pv.operator, EXEMPT, {**SETTINGS, "voice": PREVIEW_VOICE, "clip_model": SEEDANCE}))
    assert (code, word) == ("NS400", "model_not_offered")


# ── the migration ─────────────────────────────────────────────────────────────

def md5(db, sig):
    return db.su("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)", [sig])[0][0]


def test_the_two_overloads_are_internal_and_the_three_argument_check_is_unchanged(db):
    for sig in (SIGS["check4"], SIGS["problem4"]):
        for role in ("anon", "authenticated", "service_role"):
            assert db.su("select has_function_privilege(%s, %s, 'execute')", [role, sig])[0][0] is False, (role, sig)
        assert db.su("select prosecdef and proconfig @> array['search_path=public, pg_temp'] from pg_proc "
                     "where oid = to_regprocedure(%s)", [sig])[0][0] is True
    assert md5(db, SIGS["check3"]) == "864da632969ae05f964eee1b568a671f"
    assert md5(db, SIGS["problem3"]) == "d828ee349aa5da3aa05ea9db4d8f1b94"
    assert md5(db, SIGS["check4"]) == sec_db.FILM_CHECK_MODEL_0235
    assert md5(db, SIGS["problem4"]) == sec_db.FILM_MODEL_PROBLEM_0235
    assert md5(db, "public.film_price(public.films)") == sec_db.FILM_PRICE_0235
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.svc(f"select public.film_model_problem('{PREVIEW}', array['tts'], 'voice.model', '{EXEMPT}'::uuid)")


def test_the_file_has_no_backslash_and_every_replaced_caller_names_the_film_organization(db):
    for path in (MIGRATION, ROLLBACK):
        assert "\\" not in path.read_text(encoding="utf-8"), path.name
    for sig in REPLACED:
        body = db.su("select prosrc from pg_proc where oid = to_regprocedure(%s)", [sig])[0][0]
        assert "-- 0235" in body, sig
        assert "org_id)" in body, sig


@pytest.fixture
def scratch():
    """A database of its own for the file-level tests, built from every migration (0235 included)."""
    admin = sec_db.admin_dsn()
    name = f"ns_m0235_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.build(admin, name)
    try:
        yield dsn
    finally:
        sec_db.drop_database(admin, name)


def _md5s(c):
    return {sig: c.execute("select (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc "
                           "where oid = to_regprocedure(%s))", [sig]).fetchone()[0] for sig in (*REPLACED, SIGS["check4"], SIGS["problem4"])}


def test_a_replay_changes_nothing_and_the_drift_guard_refuses_a_hand_changed_body(scratch):
    with psycopg.connect(scratch, autocommit=True) as c:
        before = _md5s(c)
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _md5s(c) == before
        body = c.execute("select pg_get_functiondef('public.film_precheck(public.films)'::regprocedure)").fetchone()[0]
        c.execute(body.replace("return null;\nend", "return null; -- changed by hand\nend", 1))
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "0235 found a public.film_precheck(public.films)" in str(e.value)
        with pytest.raises(psycopg.Error) as e:
            c.execute(sec_db.ROLLBACK_0235.read_text(encoding="utf-8"))
        assert "rollback 0235: public.film_precheck(public.films)" in str(e.value)


def test_the_rollback_puts_every_body_back_drops_the_overloads_and_0235_applies_again(scratch):
    with psycopg.connect(scratch, autocommit=True) as c:
        after = _md5s(c)
        c.execute(ROLLBACK.read_text(encoding="utf-8"))
        back = _md5s(c)
        assert back == {**sec_db._BEFORE_0235, SIGS["check4"]: None, SIGS["problem4"]: None}
        # Idempotent: a second run finds the earlier bodies and changes nothing.
        c.execute(ROLLBACK.read_text(encoding="utf-8"))
        assert _md5s(c) == back
        # 0218's, 0171's and 0215's own guards accept what came back (their replays would refuse anything else).
        assert sec_db.has_0218(c) and sec_db.has_0215(c) and not sec_db.has_0235(c)
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _md5s(c) == after


def test_the_lab_chain_takes_0235_off_before_0218_and_0215_and_puts_it_back(scratch):
    with psycopg.connect(scratch, autocommit=True) as c:
        assert sec_db.has_0235(c)
        sec_db.take_off_0218(c)
        assert not sec_db.has_0235(c) and not sec_db.has_0218(c)
        sec_db.put_back_0218(c)
        assert sec_db.has_0218(c) and sec_db.has_0235(c)
        sec_db.take_off_0215(c)
        assert not sec_db.has_0235(c) and not sec_db.has_0215(c)
        sec_db.put_back_0215(c)
        assert sec_db.has_0215(c) and sec_db.has_0235(c)
        # The rollbacks 0235 sits on run with it taken off (0171's through take_off_0171, as the money lab does).
        sec_db.take_off_0171(c)
        assert not sec_db.has_0235(c) and not sec_db.has_0171(c)
        sec_db.put_back_0171(c)
        assert sec_db.has_0171(c)
