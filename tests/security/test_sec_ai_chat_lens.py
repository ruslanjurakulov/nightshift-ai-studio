"""Lens's behaviour-gap round on Nightshift AI (0199): what each fix pins.

* B1: the chat's short-film draft is the real create_film_draft with the chat's own arguments (source kind 'script'): it was
  'storyboard', which the function refuses, so every short Choose failed;
* a turn that never reached the vendor (not_sent), a vendor's safety refusal and the plan's own refusal are not charged to the
  person's plan cap or trial (the per-person and platform caps still count refusals, against abuse);
* a network retry of the same press (the same request id) is a duplicate: nothing is written twice;
* a message of invisible characters or no-break spaces is empty;
* a member never reads the owner's model id (it names the vendor): not from ai_chat_quota, not from their own session row.
"""

from __future__ import annotations

import json

import pytest

from sec_db import acting, as_superuser
from test_sec_ai_chat import RESERVE, _cap, _plan
from test_sec_films_core import a, db  # noqa: F401  (the films lab's own database and workspace fixtures)

RESERVE_ID = "select public.ai_chat_reserve_turn(%s, %s, false, %s)"
FINISH = "select public.ai_chat_finish_turn(%s, %s, null, null, null, null, null, null, null, null)"


def test_b1_the_chats_short_draft_is_accepted_by_the_real_create_film_draft(db, a):  # noqa: F811
    # Exactly what app/api/brain/turn/route.ts sends: source kind 'script', filmFromBrief's settings and scenes.
    settings = {"title": "Night owls", "language": "en", "aspect": "9:16", "target_seconds": 60}
    out = db.create(a.editor, a.org, settings=settings, kind="script", text="Two owls guard a lighthouse.\nA storm comes.")
    film = out["film"]
    scenes = [{"title": "Dusk", "narration": "", "visual_prompt": "Two owls on a lighthouse rail at dusk", "planned_seconds": 30},
              {"title": "Storm", "narration": "", "visual_prompt": "The storm hits; the owls hold on", "planned_seconds": 30}]
    saved = db.save(a.editor, film["id"], film["version"], {"scenes": scenes})
    assert saved["film"]["version"] == film["version"] + 1, saved
    # The value it used to send is refused by name: what the route must never send again.
    with pytest.raises(Exception) as e:
        db.create(a.editor, a.org, settings=settings, kind="storyboard", text="x")
    assert "invalid_params" in str(e.value)


def test_not_sent_and_refused_turns_are_not_charged_to_the_plan(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            before = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])["used"]
            for outcome in ("not_sent", "vendor_refused", "refused", "not_configured"):
                call = s.value(RESERVE, [sc.alice.ai_chat_session, f"try {outcome}"])["call_id"]
                assert s.run(FINISH, [call, outcome]).ok
            assert s.value("select public.ai_chat_quota(%s)", [sc.alice.org])["used"] == before
            call = s.value(RESERVE, [sc.alice.ai_chat_session, "a real turn"])["call_id"]
            assert s.run(FINISH, [call, "vendor_error"]).ok
            assert s.value("select public.ai_chat_quota(%s)", [sc.alice.org])["used"] == before + 1


def test_not_sent_carries_no_tokens_and_is_only_for_a_fresh_call(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            call = s.value(RESERVE, [sc.alice.ai_chat_session, "tokens?"])["call_id"]
            out = s.run("select public.ai_chat_finish_turn(%s, 'not_sent', 10, 5, null, null, null, null, null, null)", [call])
            assert not out.ok and out.error == "invalid_params", out
        old = su.value("insert into public.ai_chat_calls (org_id, user_id, session_id, model, created_at) values (%s, %s, %s, 'm', "
                       "now() - interval '10 minutes') returning id", [sc.alice.org, sc.alice.actor.uid, sc.alice.ai_chat_session])
        with acting(conn, sc.alice.actor) as s:
            out = s.run(FINISH, [old, "not_sent"])
            assert not out.ok and out.error == "invalid_params", out


def test_the_same_press_twice_is_a_duplicate_and_writes_nothing(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            assert s.run(RESERVE_ID, [sc.alice.ai_chat_session, "once only", "press-abcdef12"]).ok
            msgs = s.value("select count(*) from public.ai_chat_messages where session_id = %s", [sc.alice.ai_chat_session])
            out = s.run(RESERVE_ID, [sc.alice.ai_chat_session, "once only", "press-abcdef12"])
            assert not out.ok and out.sqlstate == "NS409" and out.error == "duplicate_request", out
            assert s.value("select count(*) from public.ai_chat_messages where session_id = %s", [sc.alice.ai_chat_session]) == msgs
            out = s.run(RESERVE_ID, [sc.alice.ai_chat_session, "bad id", "x;drop"])
            assert not out.ok and out.error == "invalid_params", out


@pytest.mark.parametrize("text", ["​​​", "  ", "﻿ ⁠", "　 "])
def test_a_message_of_invisible_or_no_break_spaces_is_empty(conn, sc, text):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, text])
            assert not out.ok and out.error == "invalid_params", out


def test_a_member_never_reads_the_owners_model_id(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        q = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])
        assert "model" not in q and len(q["model_ref"]) == 32, q
        assert "sonnet" not in json.dumps(q) and "anthropic" not in json.dumps(q)
        out = s.run("select model from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session])
        assert not out.ok and out.sqlstate == "42501", out
        # The rest of their own session stays readable.
        assert s.rows("select id, step from public.ai_chat_sessions where id = %s", [sc.alice.ai_chat_session])
