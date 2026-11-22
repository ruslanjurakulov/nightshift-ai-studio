"""0214: voice_language_problem answers whether a film's voice model speaks the film's language, from the registry's own list.

What would break: an Uzbek film read by Multilingual v2 is priced and held (the refusal must say 'voice_language_unsupported'); an
Uzbek film on Eleven v4 is refused (it must answer NULL); a model with no list, no row or a film with no language reads as
"speaks" (rule 5: it must say 'voice_language_unknown'); an API role calls it directly. The four ElevenLabs TTS rows are seeded
from schemas/model_registry.json exactly as a sync stores them, inside a rolled-back transaction.
"""

from __future__ import annotations

import json

import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user

# Read directly, not through modules.model_registry (its adapters need `requests`, which the lab does not install).
REGISTRY = {m["id"]: m for m in json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
_COLUMNS = ("id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement")
TTS = sorted(mid for mid, m in REGISTRY.items() if "tts" in m["capabilities"])


def _sync_row(mid):
    m = REGISTRY[mid]
    return {"id": m["id"], "display_name": m["display_name"], "provider": m["provider"], "adapter": m["adapter"],
            "capabilities": list(m["capabilities"]), "credit_unit": m["credit_unit"], "entitlement": m["entitlement"],
            "spec": {k: v for k, v in m.items() if k not in _COLUMNS}}


@pytest.fixture
def seeded(conn):
    with conn.transaction(force_rollback=True):
        conn.execute("select public.sync_model_registry(%s::jsonb)", [json.dumps([_sync_row(mid) for mid in TTS])])
        yield conn


def _ask(conn, model, language):
    with as_superuser(conn, commit=False) as s:
        return s.value("select public.voice_language_problem(%s, %s)", [model, language])


def test_the_registry_seeds_four_voice_models(seeded):
    assert {"elevenlabs-v4", "elevenlabs-v3", "elevenlabs-multilingual-v2", "elevenlabs-flash-v2.5"} <= set(TTS)


@pytest.mark.parametrize("model", ["elevenlabs-multilingual-v2", "elevenlabs-flash-v2.5"])
def test_an_uzbek_film_on_a_model_that_does_not_speak_uzbek_is_refused(seeded, model):
    q = _ask(seeded, model, "uz")
    assert q["priced"] is False and q["reason"] == "voice_language_unsupported"
    assert REGISTRY[model]["display_name"] in q["detail"] and "Uzbek" in q["detail"]


@pytest.mark.parametrize("model", ["elevenlabs-v4", "elevenlabs-v3"])
def test_an_uzbek_film_on_v4_or_v3_has_no_problem(seeded, model):
    assert _ask(seeded, model, "uz") is None
    assert _ask(seeded, model, " UZ ") is None


@pytest.mark.parametrize("model", ["elevenlabs-v4", "elevenlabs-multilingual-v2"])
def test_russian_and_english_pass_on_every_listed_model(seeded, model):
    assert _ask(seeded, model, "ru") is None
    assert _ask(seeded, model, "en") is None


def test_an_unknown_model_is_unknown_never_speaks(seeded):
    q = _ask(seeded, "no-such-voice-model", "uz")
    assert q["priced"] is False and q["reason"] == "voice_language_unknown"
    assert _ask(seeded, None, "uz")["reason"] == "voice_language_unknown"


@pytest.mark.parametrize("language", [None, "", "   "])
def test_a_film_with_no_language_is_unknown(seeded, language):
    assert _ask(seeded, "elevenlabs-v4", language)["reason"] == "voice_language_unknown"


@pytest.mark.parametrize("languages", [None, [], "uz"])
def test_a_model_whose_list_is_missing_empty_or_not_a_list_is_unknown(seeded, languages):
    with as_superuser(seeded, commit=False) as s:
        if languages is None:
            s.rows("update public.model_registry set spec = spec - 'languages' where id = 'elevenlabs-v4' returning 1")
        else:
            s.rows("update public.model_registry set spec = jsonb_set(spec, '{languages}', %s::jsonb) "
                   "where id = 'elevenlabs-v4' returning 1", [json.dumps(languages)])
        q = s.value("select public.voice_language_problem('elevenlabs-v4', 'uz')")
    assert q["reason"] == "voice_language_unknown"


def test_neither_api_role_may_call_it_and_the_service_role_may(seeded):
    for who in (ANON, user("lab-voice-lang", "voice-lang@lab.invalid")):
        with acting(seeded, who) as s:
            out = s.run("select public.voice_language_problem('elevenlabs-v4', 'uz')")
        assert not out.ok and out.sqlstate == "42501", who
    with acting(seeded, SERVICE) as s:
        assert s.value("select public.voice_language_problem('elevenlabs-multilingual-v2', 'uz') ->> 'reason'") \
            == "voice_language_unsupported"


def test_the_rollback_removes_it_and_the_file_applies_again(conn):
    rollback = (sec_db.REPO / "docs" / "sql" / "rollback_0214_voice_language_check.sql").read_text(encoding="utf-8")
    migration = (sec_db.MIGRATIONS / "0214_voice_language_check.sql").read_text(encoding="utf-8")
    with conn.transaction(force_rollback=True):
        conn.execute(rollback)
        assert conn.execute("select to_regprocedure('public.voice_language_problem(text,text)')").fetchone()[0] is None
        conn.execute(migration)
        conn.execute(migration)  # a replay changes nothing
        assert conn.execute("select to_regprocedure('public.voice_language_problem(text,text)')").fetchone()[0] is not None


def test_the_rollback_refuses_while_a_function_still_calls_it(conn):
    rollback = (sec_db.REPO / "docs" / "sql" / "rollback_0214_voice_language_check.sql").read_text(encoding="utf-8")
    with conn.transaction(force_rollback=True):
        conn.execute("create function public.lab_calls_voice_language() returns jsonb language sql as "
                     "$$ select public.voice_language_problem('elevenlabs-v4', 'uz') $$")
        with pytest.raises(Exception, match="still calls voice_language_problem"):
            with conn.transaction():
                conn.execute(rollback)
