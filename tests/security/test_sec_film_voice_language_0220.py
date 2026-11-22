"""Migration 0220: a film whose voice model does not speak the film's language is refused at the quote and at the start, before
anything is counted, priced or held (0214's voice_language_problem, wired into 0171's film_price and film_precheck).

What would break without each guard (each test names the one it pins):

  * the quote: an Uzbek film on a voice model whose registry list has no Uzbek is quoted with a total and a quote_id, so its
    credits can be held and the narration take fails after the clips were paid for (rule 6). It must read priced:false,
    voice_language_unsupported, total null, the remedy in the detail;
  * unknown is never "speaks" (rule 5): a voice model nobody listed languages for is refused voice_language_unknown, never priced;
  * the order: a hidden voice model is answered model_not_available, never with a language reason that describes its row;
  * nothing else moves: a supported pair is priced exactly as without 0220 (the same lines, total and quote_id);
  * the start: a film whose voice stopped listing its language after a valid quote is refused with its own word before the rate
    step, so nothing is counted, held or created;
  * the migration: a replay changes nothing, the drift guard refuses a foreign body (of either helper, or of 0214's), and the
    rollback puts 0171's bodies back, after which 0220 applies again.

Runs in its own scratch database (it commits), on the registry and models of test_sec_films_money.py, plus two ElevenLabs rows
seeded with the display names and spec.languages of schemas/model_registry.json, as 0214's tests seed them.
"""

from __future__ import annotations

import json
import os
import uuid
from decimal import Decimal

import psycopg
import pytest

import sec_db
from test_sec_films_money import ASSEMBLY_RATE, JOB_MINIMUM, MODELS, SETTINGS, TOTAL, VOICE, Db, claims

MIGRATION = sec_db.MIGRATIONS / "0220_film_voice_language.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0220_film_voice_language.sql"
ROLLBACK_0214 = sec_db.REPO / "docs" / "sql" / "rollback_0214_voice_language_check.sql"
MIGRATION_0214 = sec_db.MIGRATIONS / "0214_voice_language_check.sql"

REGISTRY = {m["id"]: m for m in json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
_COLUMNS = ("id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement")
# The two ElevenLabs rows, as a sync stores them (spec.languages and display_name from the registry file), minus the terms gate the
# lab cannot accept (model_registry_terms_before_sale): the language list is what is under test, not the vendor's plan.
ELEVEN = ("elevenlabs-multilingual-v2", "elevenlabs-v3")
# Lab voice models, each owned by one test (the database is shared by the module): (id, spec.languages or None for no list).
LAB_TTS = [("tts-nolist", None), ("tts-flip", ["en", "ru", "uz"]), ("tts-gone", ["en", "ru"])]
TTS_RATE = Decimal("0.01")


def _eleven_row(mid):
    m = REGISTRY[mid]
    spec = {k: v for k, v in m.items() if k not in _COLUMNS and k not in ("terms_gate", "terms_notes")}
    return {"id": m["id"], "display_name": m["display_name"], "provider": m["provider"], "adapter": m["adapter"],
            "capabilities": list(m["capabilities"]), "credit_unit": m["credit_unit"], "entitlement": "any", "spec": spec}


def _lab_tts_row(mid, languages):
    spec = {"vendor_model": "acme-" + mid, "output": "audio"}
    if languages is not None:
        spec["languages"] = languages
    return {"id": mid, "display_name": mid, "provider": "acme", "adapter": "audio.acme", "capabilities": ["tts"],
            "credit_unit": f"model_{mid.replace('-', '_')}_character", "entitlement": "any", "spec": spec}


def _sell(d, mid, adapter, vendor_model, cap):
    d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')", [mid, adapter, vendor_model, cap])
    d.su("update public.model_registry set availability = 'beta' where id = %s", [mid])


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_film_voice_lang_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], **spec}}
            for m, prov, a, caps, unit, _rate, spec in MODELS]
    rows += [_eleven_row(mid) for mid in ELEVEN] + [_lab_tts_row(mid, langs) for mid, langs in LAB_TTS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, _prov, a, caps, unit, rate, _spec in MODELS:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, rate])
        _sell(d, m, a, "acme-" + m, caps[-1])
    for r in rows[len(MODELS):]:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [r["credit_unit"], TTS_RATE])
        _sell(d, r["id"], r["adapter"], r["spec"]["vendor_model"], "tts")
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0), "
         "('job_minimum', %s, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit",
         [ASSEMBLY_RATE, JOB_MINIMUM])
    sellable = {r[0] for r in d.su("select id from public.sellable_models('tts', 'web')")}
    assert sellable >= {"tts-a", *ELEVEN, *(m for m, _ in LAB_TTS)}, sellable
    assert d.su("select public.set_film_studio_enabled(true)")[0][0]["ok"] is True
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(autouse=True)
def no_live_segment(db):
    for (sid,) in db.su("select id from public.film_segments where status in ('queued', 'running', 'draining')"):
        db.svc("select public.film_cancel_segment(%s, 'cancelled')", [sid])
    yield


@pytest.fixture
def a(db):
    return db.new_org()


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def film_in(db, o, language, model):
    return db.film(o, settings={**SETTINGS, "language": language, "voice": {**VOICE, "model": model}})


def narration(q):
    return next(ln for ln in q["lines"] if ln["line"] == "narration")


def forged_quote(db, fid):
    """A quote_id of the right shape and version that quote_film never stored: start_film's precheck runs before it looks."""
    return f"fq-{db.version(fid)}-{'0' * 32}"


def nothing_happened(db, o, fid):
    assert db.holds(o.org) == []
    assert db.rate_used(o.admin, "start") == 0
    assert db.film_row(fid)[0] == "draft"
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0


# ── the quote ───────────────────────────────────────────────────────────────

def test_an_uzbek_film_on_a_voice_without_uzbek_is_not_priced_and_names_the_remedy(db, a):
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    q = db.quote(a.editor, fid)
    ln = narration(q)
    assert ln["priced"] is False and ln["reason"] == "voice_language_unsupported" and ln["credits"] is None
    assert ln["detail"] == "ElevenLabs Multilingual v2 does not speak Uzbek; choose Eleven v3, a voice model that lists Uzbek"
    assert q["priced"] is False and q["total"] is None and q["quote_id"] is None and q["startable"] is False
    assert {"line": "narration", "reason": "voice_language_unsupported"}.items() <= next(
        r for r in q["refusals"] if r["line"] == "narration").items()
    # Every other line is still priced, so the person sees what the rest would cost and what to change.
    assert all(ln["priced"] for ln in q["lines"] if ln["line"] != "narration")
    assert db.su("select count(*) from public.film_quotes where film_id = %s", [fid])[0][0] == 0


def test_the_same_voice_in_a_language_it_lists_is_priced(db, a):
    fid = film_in(db, a, "ru", "elevenlabs-multilingual-v2")
    q = db.quote(a.editor, fid)
    assert narration(q)["priced"] is True and q["priced"] is True and q["total"] == float(TOTAL)


def test_the_remedy_for_russian_names_the_language_not_a_model(db, a):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("update public.model_registry set spec = jsonb_set(spec, '{languages}', '[\"en\"]') where id = 'tts-flip'")
        c.execute("select public.record_model_probe('tts-flip', 'audio.acme', 'acme-tts-flip', 'tts', true, null, null, 10, 100, 'security-lab')")
        c.execute("update public.model_registry set availability = 'beta' where id = 'tts-flip'")
        detail = c.execute("select public.voice_language_problem('tts-flip', 'ru') ->> 'detail'").fetchone()[0]
        c.rollback()
    assert detail == "tts-flip does not speak Russian; choose a voice model that lists Russian"


def test_a_voice_model_with_no_language_list_is_unknown_never_priced(db, a):
    fid = film_in(db, a, "en", "tts-nolist")
    q = db.quote(a.editor, fid)
    ln = narration(q)
    assert ln["priced"] is False and ln["reason"] == "voice_language_unknown" and ln["credits"] is None
    assert "does not list the languages it speaks" in ln["detail"] and "choose a voice model that lists it" in ln["detail"]
    assert q["total"] is None and q["quote_id"] is None
    st, word, detail = err(lambda: db.start(a.admin, fid, forged_quote(db, fid)))
    assert (st, word) == ("NS400", "voice_language_unknown") and detail == ln["detail"]
    nothing_happened(db, a, fid)


def test_a_hidden_voice_model_still_reads_model_not_available_never_a_language_word(db, a):
    fid = film_in(db, a, "uz", "tts-gone")  # tts-gone lists no Uzbek either: the role must still be answered first
    db.su("update public.model_registry set availability = 'hidden' where id = 'tts-gone'")
    try:
        q = db.quote(a.editor, fid)
        ln = narration(q)
        assert ln["priced"] is False and ln["reason"] == "model_not_available"
        assert "Uzbek" not in ln["detail"] and "speak" not in ln["detail"] and "languages" not in ln["detail"]
        st, word, detail = err(lambda: db.start(a.admin, fid, forged_quote(db, fid)))
        assert (st, word) == ("NS400", "model_not_available") and "Uzbek" not in detail
        nothing_happened(db, a, fid)
    finally:
        _sell(db, "tts-gone", "audio.acme", "acme-tts-gone", "tts")


def _quote_without_0220(db, who, fid):
    """quote_film as `who`, with 0220 taken off inside one rolled-back transaction: what the quote read before this file."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0220(c)
        assert not sec_db.has_0220(c)
        c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", who)])
        c.execute("set local role authenticated")
        q = c.execute("select public.quote_film(%s::uuid, %s::integer)", [fid, db.version(fid)]).fetchone()[0]
        c.rollback()
    return q


@pytest.mark.parametrize("language, model", [("en", "tts-a"), ("uz", "tts-a"), ("uz", "elevenlabs-v3")])
def test_a_supported_pair_is_priced_exactly_as_without_0220(db, a, language, model):
    fid = film_in(db, a, language, model)
    before = _quote_without_0220(db, a.editor, fid)
    q = db.quote(a.editor, fid)
    assert q["priced"] is True and q["total"] == float(TOTAL)
    assert (q["total"], q["quote_id"], q["lines"]) == (before["total"], before["quote_id"], before["lines"])
    assert db.start(a.admin, fid, q["quote_id"])["ok"] is True


def test_the_unsupported_quote_was_priced_before_0220(db, a):
    """The evidence for this file: without it, the Uzbek film on Multilingual v2 had a total and a quote_id."""
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    before = _quote_without_0220(db, a.editor, fid)
    assert before["priced"] is True and before["quote_id"] is not None


# ── the start ───────────────────────────────────────────────────────────────

def test_a_start_whose_voice_stopped_speaking_the_language_since_its_quote_is_refused_before_anything_is_counted(db, a):
    fid = film_in(db, a, "uz", "tts-flip")
    q = db.quote(a.editor, fid)
    assert q["priced"] is True and q["blocked_by"] == []
    # The registry's list changes (a sync), the guard un-verifies the model, and the owner probes it and puts it on sale again.
    db.su("update public.model_registry set spec = jsonb_set(spec, '{languages}', '[\"en\", \"ru\"]') where id = 'tts-flip'")
    assert db.su("select availability from public.model_registry where id = 'tts-flip'")[0][0] == "hidden"
    _sell(db, "tts-flip", "audio.acme", "acme-tts-flip", "tts")
    try:
        before = db.account(a.org)
        st, word, detail = err(lambda: db.start(a.admin, fid, q["quote_id"]))
        assert (st, word) == ("NS400", "voice_language_unsupported")
        assert detail == "tts-flip does not speak Uzbek; choose Eleven v3, a voice model that lists Uzbek"
        nothing_happened(db, a, fid)
        assert db.account(a.org) == before
        assert "started" not in db.events(fid)
        # And the quote says the same now, so the person reads the remedy before pressing Start again.
        assert narration(db.quote(a.editor, fid))["reason"] == "voice_language_unsupported"
    finally:
        db.su("update public.model_registry set spec = jsonb_set(spec, '{languages}', '[\"en\", \"ru\", \"uz\"]') where id = 'tts-flip'")
        _sell(db, "tts-flip", "audio.acme", "acme-tts-flip", "tts")


def test_a_channel_voice_or_a_silent_film_is_not_asked_about_language(db, a):
    """The check is the narration line's: a film with no narration has no voice to ask about, whatever its voice says."""
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    db.save(a.editor, fid, db.version(fid), {"scenes": [{"title": "Open", "narration": "", "visual_prompt": "a lighthouse at dusk",
                                                          "planned_seconds": 10}]})
    q = db.quote(a.editor, fid)
    assert q["priced"] is True and not [ln for ln in q["lines"] if ln["line"] == "narration"]
    assert db.start(a.admin, fid, q["quote_id"])["ok"] is True


# ── the migration ───────────────────────────────────────────────────────────

BODIES = """
select jsonb_build_object(
  'price', (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = 'public.film_price(public.films)'::regprocedure),
  'pre', (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = 'public.film_precheck(public.films)'::regprocedure),
  'vlp', (select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc
           where oid = 'public.voice_language_problem(text, text)'::regprocedure),
  'acl', (select jsonb_agg(coalesce(proacl::text, '') order by proname) from pg_proc
           where oid in ('public.film_price(public.films)'::regprocedure, 'public.film_precheck(public.films)'::regprocedure)),
  'quotes', (select count(*) from public.film_quotes),
  'segments', (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from public.film_segments s))
"""


def test_reapplying_the_migration_changes_nothing(db, a):
    fid = film_in(db, a, "en", "tts-a")
    db.quoted_start(a, fid)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        before = c.execute(BODIES).fetchone()[0]
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute(BODIES).fetchone()[0] == before
        c.rollback()


@pytest.mark.parametrize("sig, body", [
    ("film_price", "create or replace function public.film_price(p_film public.films) returns jsonb language sql stable "
                   "security definer set search_path = public, pg_temp as $$ select '{\"priced\": true}'::jsonb $$"),
    ("film_precheck", "create or replace function public.film_precheck(p_film public.films) returns jsonb language sql stable "
                      "security definer set search_path = public, pg_temp as $$ select null::jsonb $$"),
])
def test_the_drift_guard_refuses_a_body_that_is_neither_0171s_nor_its_own(db, sig, body):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(body)
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert f"{sig}(films) with a body that is neither 0171's nor 0220's" in str(e.value) \
            or f"{sig}(public.films) with a body that is neither 0171's nor 0220's" in str(e.value)
        c.rollback()


def test_it_refuses_without_0214_or_with_a_helper_that_is_not_0214s(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0220(c)
        c.execute(ROLLBACK_0214.read_text(encoding="utf-8"))
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "apply 0214_voice_language_check.sql first" in str(e.value)
        c.rollback()
        c.execute("create or replace function public.voice_language_problem(p_model text, p_language text) returns jsonb "
                  "language sql stable security definer set search_path = public, pg_temp as $$ select null::jsonb $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "voice_language_problem(text, text) with a body that is not 0214's" in str(e.value)
        c.rollback()


def test_rollback_0214_refuses_while_0220_is_on(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        with pytest.raises(psycopg.Error) as e:
            c.execute(ROLLBACK_0214.read_text(encoding="utf-8"))
        assert "still calls voice_language_problem" in str(e.value)
        c.rollback()


def test_the_rollback_puts_0171s_bodies_back_and_0220_applies_again(db, a):
    fid = film_in(db, a, "uz", "elevenlabs-multilingual-v2")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(ROLLBACK.read_text(encoding="utf-8").replace("begin;", "").replace("commit;", ""))
        got = c.execute(BODIES).fetchone()[0]
        assert (got["price"], got["pre"]) == ("5de6c9bb2a74079e2078cad2d91b3c34", "ff4fa7e8a6386420f32ab6a3a85a778c")
        assert not sec_db.has_0220(c)
        # Nothing calls 0214's helper any more, so its own rollback may run now.
        c.execute("savepoint s")
        c.execute(ROLLBACK_0214.read_text(encoding="utf-8"))
        c.execute("rollback to savepoint s")
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert sec_db.has_0220(c)
        c.commit()
    assert narration(db.quote(a.editor, fid))["reason"] == "voice_language_unsupported"


def test_the_rollback_refuses_a_body_that_is_not_0220s(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0220(c)  # 0171's bodies are live: the rollback must not "restore" over them
        with pytest.raises(psycopg.Error) as e:
            c.execute(ROLLBACK.read_text(encoding="utf-8").replace("begin;", "").replace("commit;", ""))
        assert "is missing or is not 0220's body" in str(e.value)
        c.rollback()


def test_no_api_role_may_call_either_helper(db, a):
    fid = film_in(db, a, "uz", "tts-a")
    for role, who in (("anon", None), ("authenticated", a.admin), ("service_role", None)):
        for fn in ("film_price", "film_precheck"):
            with pytest.raises(psycopg.Error) as e:
                db.act(role, who, f"select public.{fn}(f) from public.films f where f.id = %s", [fid])
            assert e.value.sqlstate == "42501", (role, fn)
