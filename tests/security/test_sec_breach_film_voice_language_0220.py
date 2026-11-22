"""Breach: attacks on 0220 (a film's voice model must speak the film's language at the quote and the start).

Each test names the attack and pins the defence that held (a hole stays a FAILING test until fixed). Run in the module's own scratch
database, on test_sec_film_voice_language_0220.py's registry (its fixtures are imported, so this module builds its own copy).

Attacks:
  * bypass the language check and still start: edit the language or the voice between quote and start (a direct write, a stale
    save_film), odd casing or whitespace in the language, a channel voice on a narrated film, a voice with no model, a model id in
    another casing, a quote stored before 0220 was applied;
  * make a refusal be charged: the registry flips between the quote and the start, and between start_film's precheck and its re-price
    (a lab-only pause inside the start's own transaction), and the order of the precheck against the rate step;
  * leak: another organization's film, a non-admin, a hidden model, the refusal's detail;
  * reach: every API role against voice_language_problem, film_price and film_precheck, and no overload or PUBLIC grant;
  * replay and race: two starts of one film, a start held open while the registry flips, a replay after the flip.
"""

from __future__ import annotations

import json
import re
import threading
import time

import psycopg
import pytest

import sec_db
from test_sec_films_money import SETTINGS, VOICE, claims
from test_sec_film_voice_language_0220 import (  # noqa: F401  (db, a and no_live_segment are fixtures used by name)
    _sell, a, db, err, film_in, forged_quote, narration, no_live_segment, nothing_happened)

UZ_FIX = "tts-flip does not speak Uzbek; choose Eleven v3, a voice model that lists Uzbek"


def _flip(c, languages):
    """A registry sync that changes tts-flip's languages, then the owner's probe and re-sale, in the caller's transaction."""
    c.execute("update public.model_registry set spec = jsonb_set(spec, '{languages}', %s::jsonb) where id = 'tts-flip'",
              [json.dumps(languages)])
    c.execute("select public.record_model_probe('tts-flip', 'audio.acme', 'acme-tts-flip', 'tts', true, null, null, 10, 100, "
              "'security-lab')")
    c.execute("update public.model_registry set availability = 'beta' where id = 'tts-flip'")


@pytest.fixture
def flip_restored(db):
    yield
    with psycopg.connect(db.dsn, autocommit=False) as c:
        _flip(c, ["en", "ru", "uz"])
        c.commit()


def _as(c, who):
    c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", who)])
    c.execute("set local role authenticated")


def _segments(db, fid):
    return db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0]


# ── bypass: change the language or the voice between quote and start ──────

@pytest.mark.parametrize("role, stmt", [
    ("authenticated", "update public.films set language = 'uz' where id = %s"),
    ("authenticated", "update public.films set voice = jsonb_set(voice, '{model}', '\"elevenlabs-multilingual-v2\"') where id = %s"),
    ("service_role", "update public.films set language = 'uz' where id = %s"),
    ("anon", "update public.films set language = 'uz' where id = %s"),
])
def test_no_api_role_rewrites_a_quoted_films_language_or_voice_directly(db, a, role, stmt):
    fid = film_in(db, a, "en", "elevenlabs-multilingual-v2")
    with pytest.raises(psycopg.Error) as e:
        db.act(role, a.admin if role == "authenticated" else None, stmt, [fid])
    assert e.value.sqlstate == "42501", (role, e.value.sqlstate)
    assert db.su("select language, voice ->> 'model' from public.films where id = %s", [fid])[0] == ("en", "elevenlabs-multilingual-v2")


def test_a_save_with_the_quotes_stale_version_cannot_switch_the_language(db, a):
    fid = film_in(db, a, "en", "elevenlabs-multilingual-v2")
    v = db.version(fid)
    q = db.quote(a.editor, fid)
    assert q["priced"] is True
    db.save(a.editor, fid, v, {"title": "bumped"})  # someone else's edit: the quote's version is now stale
    st, word, _ = err(lambda: db.save(a.editor, fid, v, {"language": "uz"}))
    assert (st, word) == ("NS409", "film_changed")
    assert db.su("select language from public.films where id = %s", [fid])[0][0] == "en"


def test_a_language_edit_after_the_quote_makes_the_quote_unstartable_before_anything_is_counted(db, a):
    fid = film_in(db, a, "en", "elevenlabs-multilingual-v2")
    q = db.quote(a.editor, fid)
    assert q["priced"] is True
    db.save(a.editor, fid, db.version(fid), {"language": "uz"})
    st, word, _ = err(lambda: db.start(a.admin, fid, q["quote_id"]))
    assert (st, word) == ("NS409", "film_changed")
    nothing_happened(db, a, fid)
    # And a quote_id forged to the new version is answered with the language, still before the count.
    st, word, detail = err(lambda: db.start(a.admin, fid, forged_quote(db, fid)))
    assert (st, word) == ("NS400", "voice_language_unsupported") and "Uzbek" in detail
    nothing_happened(db, a, fid)


def test_a_save_cannot_land_while_a_start_of_the_same_film_is_in_flight(db, a):
    """start_film holds the film row (NO KEY UPDATE) to its commit; a save waits on it and then reads a film that is no longer
    editable, so a language change can never slip between the start's check and its hold."""
    fid = film_in(db, a, "en", "elevenlabs-multilingual-v2")
    q = db.quote(a.editor, fid)
    with psycopg.connect(db.dsn, autocommit=False) as starter, psycopg.connect(db.dsn, autocommit=False) as saver:
        _as(starter, a.admin)
        out = starter.execute("select public.start_film(%s::uuid, %s, %s)", [fid, q["quote_id"], db.key()]).fetchone()[0]
        assert out["ok"] is True, out
        _as(saver, a.editor)
        saver.execute("set local lock_timeout = '300ms'")
        with pytest.raises(psycopg.errors.LockNotAvailable):
            saver.execute("select public.save_film(%s::uuid, %s::integer, %s::jsonb)", [fid, db.version(fid), '{"language": "uz"}'])
        saver.rollback()
        starter.commit()
    st, word, _ = err(lambda: db.save(a.editor, fid, db.version(fid), {"language": "uz"}))
    assert (st, word) == ("NS409", "film_not_editable")
    assert db.su("select language from public.films where id = %s", [fid])[0][0] == "en"


# ── bypass: odd language values ──────────────────────────────────────────────

ODD_LANGUAGES = ["UZ", "Uz", " uz", "uz ", "uz-Latn", "uz_UZ", "uz​", "​uz", "", None, 7, ["uz"]]


@pytest.mark.parametrize("language", ODD_LANGUAGES, ids=repr)
def test_an_odd_language_is_refused_by_save_film_never_stored(db, a, language):
    fid = film_in(db, a, "en", "elevenlabs-multilingual-v2")
    st, word, _ = err(lambda: db.save(a.editor, fid, db.version(fid), {"language": language}))
    assert (st, word) == ("NS400", "invalid_params")
    assert db.su("select language from public.films where id = %s", [fid])[0][0] == "en"


@pytest.mark.parametrize("language", ODD_LANGUAGES, ids=repr)
def test_an_odd_language_is_refused_by_create_film_draft(db, a, language):
    st, word, _ = err(lambda: db.film(a, settings={**SETTINGS, "language": language,
                                                   "voice": {**VOICE, "model": "elevenlabs-multilingual-v2"}}))
    assert (st, word) == ("NS400", "invalid_params")


@pytest.mark.parametrize("language", ["UZ", " uz", "uz-Latn", "uz​", ""], ids=repr)
def test_even_the_table_refuses_an_odd_language(db, a, language):
    fid = film_in(db, a, "en", "elevenlabs-multilingual-v2")
    with pytest.raises(psycopg.errors.CheckViolation):
        db.su("update public.films set language = %s where id = %s", [language, fid])


# ── bypass: a voice that is not creative_tts, a voice with no model, a model in another casing ──────

@pytest.mark.parametrize("voice", [
    {"source": "channel", "model": "elevenlabs-multilingual-v2"},
    {"source": "channel", "voice_id": "voice_lab_1"},
    {"source": "Creative_TTS", "model": "elevenlabs-multilingual-v2", "voice_id": "voice_lab_1"},
    {"source": "creative_tts ", "model": "elevenlabs-multilingual-v2", "voice_id": "voice_lab_1"},
    {"model": "elevenlabs-multilingual-v2", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": None, "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": "", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": "ElevenLabs-V3", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": "ELEVENLABS-MULTILINGUAL-V2", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": " elevenlabs-v3", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": "elevenlabs-v3​", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": "img-key", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": "elevenlabs-multilingual-v2", "voice_id": "voice_lab_1", "language": "ru"},
], ids=lambda v: json.dumps(v))
def test_a_voice_that_could_dodge_the_check_is_refused_by_save_film(db, a, voice):
    fid = film_in(db, a, "uz", "elevenlabs-v3")
    st, word, _ = err(lambda: db.save(a.editor, fid, db.version(fid), {"voice": voice}))
    assert st == "NS400" and word in ("invalid_params", "model_not_available"), (st, word)


def test_a_channel_voice_on_a_narrated_film_is_never_priced_held_or_started(db, a):
    """The channel voice is exempt from the language question only because it is never priced: the film cannot start at all."""
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    # save_film takes a channel voice only on a film with a channel; the row is what such a save stores, planted directly.
    db.su("update public.films set voice = '{\"source\": \"channel\"}'::jsonb, version = version + 1 where id = %s", [fid])
    q = db.quote(a.editor, fid)
    assert narration(q)["reason"] == "channel_voice_not_priced" and q["quote_id"] is None
    out = db.start(a.admin, fid, forged_quote(db, fid))
    assert out["ok"] is False and out["reason"] == "price_changed"
    assert db.holds(a.org) == [] and _segments(db, fid) == 0


@pytest.mark.parametrize("voice", [
    {"source": "creative_tts", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": None, "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": "", "voice_id": "voice_lab_1"},
    {"source": "creative_tts", "model": "ELEVENLABS-MULTILINGUAL-V2", "voice_id": "voice_lab_1"},
    {"source": "elsewhere", "model": "elevenlabs-multilingual-v2", "voice_id": "voice_lab_1"},
    {"model": "elevenlabs-multilingual-v2", "voice_id": "voice_lab_1"},
], ids=lambda v: json.dumps(v))
def test_a_voice_planted_behind_the_api_still_prices_nothing_and_holds_nothing(db, a, voice):
    """Defence in depth: a row no API can write (a pre-0166 import, a hand edit), whose voice film_precheck's language hunk skips
    (no model, or a source that is not creative_tts), is still refused by film_price's narration line, so nothing is held."""
    fid = film_in(db, a, "uz", "elevenlabs-v3")
    db.su("update public.films set voice = %s::jsonb, version = version + 1 where id = %s", [json.dumps(voice), fid])
    q = db.quote(a.editor, fid)
    ln = narration(q)
    assert ln["priced"] is False and q["quote_id"] is None and q["total"] is None, ln
    out = None
    try:
        out = db.start(a.admin, fid, forged_quote(db, fid))
    except psycopg.Error as e:
        assert e.sqlstate == "NS400"
    if out is not None:
        assert out["ok"] is False
    assert db.holds(a.org) == [] and _segments(db, fid) == 0 and db.film_row(fid)[0] == "draft"


def test_a_quote_stored_before_0220_does_not_start_an_unsupported_film_after_it(db, a):
    """The upgrade window: a quote_film answered on 0171's film_price (unsupported pair priced, quote row stored), then 0220 applied
    before the person pressed Start. The start must refuse with the language, before the count."""
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0220(c)
        _as(c, a.editor)
        q = c.execute("select public.quote_film(%s::uuid, %s::integer)", [fid, db.version(fid)]).fetchone()[0]
        assert q["priced"] is True and q["quote_id"]
        c.execute("reset role")
        c.execute(sec_db.MIGRATIONS.joinpath("0220_film_voice_language.sql").read_text(encoding="utf-8"))
        assert sec_db.has_0220(c)
        c.commit()
    assert db.su("select count(*) from public.film_quotes where film_id = %s", [fid])[0][0] == 1
    st, word, detail = err(lambda: db.start(a.admin, fid, q["quote_id"]))
    assert (st, word) == ("NS400", "voice_language_unsupported") and "Uzbek" in detail
    nothing_happened(db, a, fid)


# ── make a refusal be charged ───────────────────────────────────────────────

def test_the_language_refusal_comes_before_the_rate_step_even_when_the_hour_is_spent(db, a):
    """film_precheck runs before film_take_rate: a person out of starts reads the language remedy, never 'rate_limited', and the
    refusal adds nothing to the counter."""
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    limit = db.su("select (public.film_money_limits() ->> 'starts_per_hour')::integer")[0][0]
    db.spend_rate(a.admin, "start", limit)
    st, word, _ = err(lambda: db.start(a.admin, fid, forged_quote(db, fid)))
    assert (st, word) == ("NS400", "voice_language_unsupported")
    assert db.rate_used(a.admin, "start") == limit
    assert db.holds(a.org) == [] and _segments(db, fid) == 0


def test_repeated_language_refusals_never_use_up_the_hours_starts(db, a):
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    limit = db.su("select (public.film_money_limits() ->> 'starts_per_hour')::integer")[0][0]
    for _ in range(limit + 2):
        st, word, _d = err(lambda: db.start(a.admin, fid, forged_quote(db, fid)))
        assert word == "voice_language_unsupported"
    nothing_happened(db, a, fid)


def test_a_flip_between_the_precheck_and_the_reprice_is_counted_but_never_held(db, a, flip_restored):
    """The one window the precheck cannot close: the registry changes after start_film's precheck read it and before its re-price.
    The documented outcome (start_film: "Counted: from here every refusal is returned, so the counter commits with it"): the start is
    counted once and answered ok:false with the language word, and nothing is held, created or started. A lab-only trigger pauses the
    start inside its own transaction right at the rate step, while a second session syncs the registry."""
    fid = film_in(db, a, "uz", "tts-flip")
    q = db.quote(a.editor, fid)
    assert q["priced"] is True
    db.su("create or replace function public.lab_pause_start() returns trigger language plpgsql as $$ begin "
          "if current_setting('lab.pause_start', true) = 'on' and new.bucket like 'db.film.start@%' then perform pg_sleep(1.5); end if; "
          "return new; end $$")
    db.su("create trigger lab_pause_start after insert or update on public.web_rate_counters "
          "for each row execute function public.lab_pause_start()")
    result = {}

    def start():
        with psycopg.connect(db.dsn, autocommit=False) as c:
            c.execute("select set_config('lab.pause_start', 'on', true)")
            _as(c, a.admin)
            result["out"] = c.execute("select public.start_film(%s::uuid, %s, %s)", [fid, q["quote_id"], db.key()]).fetchone()[0]
            c.commit()

    try:
        t = threading.Thread(target=start)
        t.start()
        time.sleep(0.5)
        with psycopg.connect(db.dsn, autocommit=False) as c:
            _flip(c, ["en", "ru"])
            c.commit()
        t.join(10)
        assert not t.is_alive()
    finally:
        db.su("drop trigger if exists lab_pause_start on public.web_rate_counters")
        db.su("drop function if exists public.lab_pause_start()")
    out = result["out"]
    assert out["ok"] is False and out["reason"] == "voice_language_unsupported" and out["detail"] == UZ_FIX, out
    assert db.rate_used(a.admin, "start") == 1
    assert db.holds(a.org) == [] and _segments(db, fid) == 0 and db.film_row(fid)[0] == "draft"
    assert "started" not in db.events(fid)


# ── leaks ───────────────────────────────────────────────────────────────────

def test_another_organization_reads_not_found_never_the_language_refusal(db, a):
    b = db.new_org()
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    for who in (b.owner, b.admin, b.editor, b.viewer):
        st, word, detail = err(lambda: db.start(who, fid, forged_quote(db, fid)))
        assert (st, word, detail) == ("P0002", "not_found", ""), who
        st, word, detail = err(lambda: db.quote(who, fid))
        assert (st, word, detail) == ("P0002", "not_found", ""), who
    assert db.rate_used(b.admin, "start") == 0
    nothing_happened(db, a, fid)


def test_a_member_who_may_not_start_is_forbidden_before_the_language_is_asked(db, a):
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    for who in (a.editor, a.viewer):
        st, word, detail = err(lambda: db.start(who, fid, forged_quote(db, fid)))
        assert (st, word) == ("42501", "forbidden") and "Uzbek" not in detail and "speak" not in detail, who
    st, word, _ = err(lambda: db.quote(a.viewer, fid))
    assert (st, word) == ("42501", "forbidden")
    nothing_happened(db, a, fid)


def test_the_refusal_detail_names_only_the_public_display_name_and_the_language(db, a):
    """The detail is the model's display_name (what sellable_models already shows) and the language; never its id when they differ,
    its spec, its adapter, its vendor model or its price."""
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    q = db.quote(a.editor, fid)
    ln = narration(q)
    row = db.su("select display_name, adapter, spec ->> 'vendor_model', credit_unit from public.model_registry "
                "where id = 'elevenlabs-multilingual-v2'")[0]
    assert ln["detail"].startswith(row[0] + " does not speak Uzbek")
    for secret in row[1:]:
        if secret:
            assert secret not in json.dumps(ln), secret
    assert set(ln) <= {"line", "scene_id", "position", "shot_index", "model", "capability", "quantity", "priced", "reason",
                       "detail", "credits"}, set(ln)
    st, word, detail = err(lambda: db.start(a.admin, fid, forged_quote(db, fid)))
    assert detail == ln["detail"]


# ── reach ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("call", [
    "select public.voice_language_problem('elevenlabs-v3', 'uz')",
    "select public.voice_language_problem(null, null)",
    "select public.film_price(f) from public.films f where f.id = %s",
    "select public.film_precheck(f) from public.films f where f.id = %s",
])
def test_no_api_role_calls_the_language_or_price_helpers_directly(db, a, role, call):
    fid = film_in(db, a, "uz", "elevenlabs-v3")
    with pytest.raises(psycopg.Error) as e:
        db.act(role, a.admin if role == "authenticated" else None, call, [fid] if "%s" in call else None)
    assert e.value.sqlstate == "42501", (role, call, e.value.sqlstate, str(e.value))


def test_no_overload_or_public_grant_reaches_the_helpers(db):
    rows = db.su("select p.oid::regprocedure::text, coalesce(p.proacl::text, '<default>') from pg_proc p "
                 "join pg_namespace n on n.oid = p.pronamespace "
                 "where n.nspname not in ('pg_catalog', 'information_schema') "
                 "and p.proname in ('voice_language_problem', 'film_price', 'film_precheck')")
    sigs = {r[0] for r in rows}
    assert sigs == {"voice_language_problem(text,text)", "film_price(films)", "film_precheck(films)"}, sigs
    for sig, acl in rows:
        # A NULL acl is the default, which grants EXECUTE to PUBLIC; '=X/' is an explicit PUBLIC grant.
        assert acl != "<default>" and not re.search(r"(^|[{,])=X", acl), (sig, acl)
        for role in ("anon", "authenticated", "service_role"):
            assert not db.su("select has_function_privilege(%s, %s, 'execute')", [role, "public." + sig])[0][0], (role, sig)


# ── replay and races ─────────────────────────────────────────────────────────

def test_a_replay_of_a_start_that_won_before_the_flip_holds_nothing_more(db, a, flip_restored):
    fid = film_in(db, a, "uz", "tts-flip")
    q = db.quote(a.editor, fid)
    key = db.key()
    first = db.start(a.admin, fid, q["quote_id"], key)
    assert first["ok"] is True
    with psycopg.connect(db.dsn, autocommit=False) as c:
        _flip(c, ["en", "ru"])
        c.commit()
    again = db.start(a.admin, fid, q["quote_id"], key)
    assert again["ok"] is True and again["replayed"] is True and again["id"] == first["id"]
    assert len(db.holds(a.org)) == 1 and _segments(db, fid) == 1
    assert db.rate_used(a.admin, "start") == 1
    # A fresh key on the started film: not startable, before the precheck and the count.
    st, word, _ = err(lambda: db.start(a.admin, fid, q["quote_id"]))
    assert (st, word) == ("NS409", "film_not_startable")
    assert len(db.holds(a.org)) == 1 and db.rate_used(a.admin, "start") == 1


def test_two_concurrent_starts_of_one_film_make_one_hold(db, a):
    fid = film_in(db, a, "uz", "elevenlabs-v3")
    q = db.quote(a.editor, fid)
    outs, errs = [], []
    barrier = threading.Barrier(2)

    def start():
        barrier.wait()
        try:
            outs.append(db.start(a.admin, fid, q["quote_id"]))
        except psycopg.Error as e:
            errs.append((e.sqlstate, str(e).splitlines()[0]))

    ts = [threading.Thread(target=start) for _ in range(2)]
    [t.start() for t in ts]
    [t.join(20) for t in ts]
    assert [o["ok"] for o in outs] == [True] and errs == [("NS409", "film_not_startable")], (outs, errs)
    assert len(db.holds(a.org)) == 1 and _segments(db, fid) == 1


def test_a_start_held_open_across_a_flip_wins_and_the_next_start_reads_the_flip(db, a, flip_restored):
    """Two films of one organization, one voice. Start 1 runs and is held open (its read of the registry is the one before the flip);
    the registry flips and commits; start 2 waits on the organization's start lock, then reads the flipped registry and is refused
    before it is counted. Each winner gets exactly what the registry said when it read it: no hold for the loser."""
    f1 = film_in(db, a, "uz", "tts-flip")
    f2 = film_in(db, a, "uz", "tts-flip")
    q1, q2 = db.quote(a.editor, f1), db.quote(a.editor, f2)
    assert q1["priced"] and q2["priced"]
    result = {}

    def second():
        try:
            result["out"] = db.start(a.admin, f2, q2["quote_id"])
        except psycopg.Error as e:
            result["err"] = (e.sqlstate, str(e).splitlines()[0], e.diag.message_detail or "")

    with psycopg.connect(db.dsn, autocommit=False) as c1:
        _as(c1, a.admin)
        out1 = c1.execute("select public.start_film(%s::uuid, %s, %s)", [f1, q1["quote_id"], db.key()]).fetchone()[0]
        assert out1["ok"] is True
        with psycopg.connect(db.dsn, autocommit=False) as c:
            _flip(c, ["en", "ru"])
            c.commit()
        t = threading.Thread(target=second)
        t.start()
        time.sleep(0.5)
        assert t.is_alive()  # waiting on pg_advisory_xact_lock('film_start:' || org)
        c1.commit()
    t.join(10)
    assert result.get("err") == ("NS400", "voice_language_unsupported", UZ_FIX), result
    assert db.rate_used(a.admin, "start") == 1
    assert len(db.holds(a.org)) == 1 and _segments(db, f1) == 1 and _segments(db, f2) == 0
    assert db.film_row(f2)[0] == "draft"


def test_when_the_flip_commits_first_the_start_is_refused_with_nothing_counted(db, a, flip_restored):
    fid = film_in(db, a, "uz", "tts-flip")
    q = db.quote(a.editor, fid)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        _flip(c, ["en", "ru"])
        c.commit()
    st, word, detail = err(lambda: db.start(a.admin, fid, q["quote_id"]))
    assert (st, word, detail) == ("NS400", "voice_language_unsupported", UZ_FIX)
    nothing_happened(db, a, fid)
