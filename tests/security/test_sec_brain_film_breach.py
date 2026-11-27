"""Breach on the film editor's "Write the storyboard with AI" (POST /api/brain/film, command-center/lib/server/brain/film-plan.ts),
its database half. The route-level holes stay failing in command-center/tests/security-brain-film-breach.test.ts; these pin the
database facts they rest on and the walls the route relies on.

* BR-FILM-01/02 (HOLE, xfail strict): nothing in the database ties a plan to a FILM. The route finds "the project's conversation"
  through a BRIEF marker (brief->film_plan->>film_id) that the author writes freely with ai_chat_save_brief, and 0211's lease is per
  conversation. Two conversations marked with the same film (one person's two first presses racing, or two editors) both get a
  running lease at once, so two plans of one project both take every turn and only one save_film can win.
* The walls that held (pinned, passing): another tenant reads and writes nothing of the film or the marked conversation; a viewer
  cannot start a conversation or save; save_film at the version read first refuses an edit made meanwhile and an archived film;
  ai_chat_start refuses another workspace's channel.
"""

from __future__ import annotations

import json
import uuid

import pytest

from sec_db import acting, as_superuser, user
from sec_films_0166 import FILM

BEGIN = "select public.ai_chat_plan_begin(%s, 0, 0)"
SAVE_BRIEF = "select public.ai_chat_save_brief(%s, %s::jsonb, 'ready')"


def _cap(su, org: str, n: int) -> None:
    plan = su.value("select public.org_plan_internal(%s)", [org])
    su.rows("insert into public.ai_chat_plan_caps (plan_id, per_day) values (%s, %s) "
            "on conflict (plan_id) do update set per_day = excluded.per_day returning 1", [plan, n])


def _member(su, org: str, role: str):
    who = user(f"film-{role}", f"film-{role}-{uuid.uuid4().hex[:6]}@film.lab")
    su.rows("insert into auth.users (id, email) values (%s, %s) returning 1", [who.uid, who.email])
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
            [org, who.uid, who.email, role])
    return who


def _back(conn) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('request.jwt.claims', '', true)")


def _marked_conversation(conn, who, org: str, film: str) -> str:
    """What openFilmConversation does on a first press: ai_chat_start, then the marker through ai_chat_save_brief."""
    with acting(conn, who, commit=True) as s:
        sid = str(s.value("select public.ai_chat_start(%s, %s)", [org, None]))
        s.value(SAVE_BRIEF, [sid, json.dumps({"version": 1, "session_id": sid, "status": "drafting", "film_plan": {"film_id": film}})])
    _back(conn)
    return sid


@pytest.mark.xfail(strict=True, reason="BR-FILM-01: one person's two marked conversations of one film both hold a plan lease")
def test_one_person_cannot_run_two_plans_of_one_film_at_once(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, sc.alice.org, 1000)
        # Two first presses that raced (tests BR-FILM-01 in the vitest file): each made and marked its own conversation.
        a = _marked_conversation(conn, sc.alice.actor, sc.alice.org, FILM["a"])
        b = _marked_conversation(conn, sc.alice.actor, sc.alice.org, FILM["a"])
        with acting(conn, sc.alice.actor, commit=True) as s:
            first = s.run(BEGIN, [a])
            second = s.run(BEGIN, [b])
        _back(conn)
        assert first.ok, first
        # The safe answer: the film is being planned already. Today the second is granted too.
        assert not second.ok and second.error == "plan_running", second


@pytest.mark.xfail(strict=True, reason="BR-FILM-02: two editors' conversations of one film both hold a plan lease")
def test_two_editors_cannot_run_two_plans_of_one_film_at_once(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, sc.alice.org, 1000)
        colleague = _member(su, sc.alice.org, "editor")
        a = _marked_conversation(conn, sc.alice.actor, sc.alice.org, FILM["a"])
        b = _marked_conversation(conn, colleague, sc.alice.org, FILM["a"])
        with acting(conn, sc.alice.actor, commit=True) as s:
            first = s.run(BEGIN, [a])
        _back(conn)
        with acting(conn, colleague, commit=True) as s:
            second = s.run(BEGIN, [b])
        _back(conn)
        assert first.ok, first
        assert not second.ok and second.error == "plan_running", second


def test_the_film_marker_is_the_authors_own_and_names_any_film(conn, sc):
    """The marker is not a database fact about the film: the author writes any film id into it, another tenant's included. Harmless
    today only because the route ALSO pins org_id = the film's own workspace and created_by = the caller (film-plan.ts
    findFilmConversation); this pins that the database does not, so neither filter can be dropped."""
    with as_superuser(conn, commit=False) as su:
        _cap(su, sc.alice.org, 1000)
        sid = _marked_conversation(conn, sc.alice.actor, sc.alice.org, FILM["b"])
        assert su.value("select brief->'film_plan'->>'film_id' from public.ai_chat_sessions where id = %s", [sid]) == FILM["b"]
        # Bob, whose film it is, never sees Alice's conversation through the marker lookup (0199 RLS: the author only).
        with acting(conn, sc.bob.actor) as s:
            assert s.rows("select id from public.ai_chat_sessions where brief->'film_plan'->>'film_id' = %s", [FILM["b"]]) == []
            out = s.run(BEGIN, [sid])
            assert not out.ok and out.error == "session_not_found", out


def test_another_tenant_reads_and_writes_nothing_of_the_film(conn, sc):
    with as_superuser(conn, commit=False):
        with acting(conn, sc.bob.actor) as s:
            out = s.run("select public.film_json(%s)", [FILM["a"]])
            assert not out.ok and out.sqlstate == "P0002", out
            out = s.run("select public.save_film(%s, 1, %s::jsonb)", [FILM["a"], json.dumps({"scenes": []})])
            assert not out.ok and out.sqlstate == "P0002", out
            # A conversation of Alice's workspace on Bob's account, for the plan to live in: refused.
            out = s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, None])
            assert not out.ok and "forbidden" in (out.error or ""), out


def test_a_viewer_cannot_start_the_plans_conversation_or_save_its_storyboard(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, sc.alice.org, 1000)
        viewer = _member(su, sc.alice.org, "viewer")
        version = su.value("select version from public.films where id = %s", [FILM["a"]])
        with acting(conn, viewer) as s:
            out = s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, None])
            assert not out.ok and "forbidden" in (out.error or ""), out
            out = s.run("select public.save_film(%s, %s, %s::jsonb)", [FILM["a"], version, json.dumps({"title": "Hijack"})])
            assert not out.ok and out.sqlstate == "42501", out


def test_save_at_the_version_read_first_loses_to_an_edit_and_never_writes_an_archived_film(conn, sc):
    with as_superuser(conn, commit=False) as su:
        read = su.value("select version from public.films where id = %s", [FILM["a"]])
        with acting(conn, sc.alice.actor, commit=True) as s:
            # A person's edit lands between the plan's read and its save.
            s.value("select public.save_film(%s, %s, %s::jsonb)", [FILM["a"], read, json.dumps({"title": "Edited meanwhile"})])
            out = s.run("select public.save_film(%s, %s, %s::jsonb)",
                        [FILM["a"], read, json.dumps({"scenes": [{"title": "Planned", "planned_seconds": 10}]})])
            assert not out.ok and "film_changed" in (out.error or ""), out
            now = s.value("select public.archive_film(%s)", [FILM["a"]])["film"]["version"]
            out = s.run("select public.save_film(%s, %s, %s::jsonb)",
                        [FILM["a"], now, json.dumps({"scenes": [{"title": "Planned", "planned_seconds": 10}]})])
            assert not out.ok and "film_not_editable" in (out.error or ""), out
        _back(conn)


def test_the_plans_conversation_cannot_be_opened_on_another_workspaces_channel(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, sc.alice.org, 1000)
        with acting(conn, sc.alice.actor) as s:
            out = s.run("select public.ai_chat_start(%s, %s)", [sc.alice.org, sc.bob.channel])
            assert not out.ok and "channel_not_found" in (out.error or ""), out
