"""Breach on 0206 (publish_request_refusal reads videos.gate_verdict): the attacks that would make a video with no, or a
forged, gate verdict pass "Publish to platforms".

What would break without these:

  * a browser (owner, admin, editor, viewer, another org, anon) writes videos.gate_verdict, or inserts a video row carrying
    one, and the refusal then reads its own forged verdict as the gate's;
  * a browser forges a publish.blocked / publish.allowed system event for a video (the old 0029 check still reads them);
  * a verdict whose "allowed" is truthy but not JSON true (1, "true", [true], {"v": true}) or whose shape is not an object
    reads as a pass;
  * a browser or anon calls the function directly, or it loses security definer / its empty search_path.
"""

from __future__ import annotations

import json

import pytest

from sec_db import ANON, SERVICE, as_superuser
from test_sec_approve_video import VID, acting, member
from test_sec_publish_refusal_gate import ALLOWED, REFUSAL, _video

FORGED = json.dumps(ALLOWED)


def _verdict(su):
    return su.value("select gate_verdict::text from public.videos where video_id = %s", [VID])


@pytest.mark.parametrize("role", ["owner", "admin", "editor", "viewer"])
def test_no_member_of_the_workspace_can_write_a_gate_verdict_onto_the_video(conn, sc, role):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        _video(su, bob.channel, None)
        who = bob.actor if role == "owner" else member(su, bob.org, role)
        with acting(conn, who) as s:
            upd = s.run("update public.videos set gate_verdict = %s::jsonb where video_id = %s returning 1", [FORGED, VID])
            ins = s.run("insert into public.videos (video_id, channel_id, published_at, publish_state, review_state, gate_verdict) "
                        "values ('Zz3dEf6hIjK', %s, now(), 'uploaded', 'approved', %s::jsonb) returning 1", [bob.channel, FORGED])
            ups = s.run("insert into public.videos (video_id, channel_id, gate_verdict) values (%s, %s, %s::jsonb) "
                        "on conflict (video_id) do update set gate_verdict = excluded.gate_verdict returning 1",
                        [VID, bob.channel, FORGED])
        assert not (upd.ok and upd.rowcount), upd
        assert not ins.ok, ins
        assert not ups.ok, ups
        assert _verdict(su) is None
        with acting(conn, SERVICE) as s:
            assert s.value(REFUSAL, [VID]) == "gate_unknown"


def test_another_organization_and_anon_cannot_write_it_either(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _video(su, sc.bob.channel, None)
        for who in (sc.alice.actor, ANON):
            with acting(conn, who) as s:
                out = s.run("update public.videos set gate_verdict = %s::jsonb where video_id = %s returning 1", [FORGED, VID])
            assert not (out.ok and out.rowcount), (who.name, out)
        assert _verdict(su) is None


def test_a_browser_cannot_forge_a_gate_event_for_a_video(conn, sc):
    """The 0029 event check still runs first: a forged publish.blocked would let anyone refuse another tenant's cross-post."""
    with as_superuser(conn, commit=False) as su:
        _video(su, sc.bob.channel, ALLOWED)
        for who in (sc.alice.actor, sc.bob.actor, ANON):
            with acting(conn, who) as s:
                out = s.run("insert into public.system_events (event_key, event, ts, channel_id, video_id) "
                            "values ('forged-' || md5(random()::text), 'publish.blocked', '2999-01-01T00:00:00Z', %s, %s) "
                            "returning 1", [sc.bob.channel, VID])
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        with acting(conn, SERVICE) as s:
            assert s.value(REFUSAL, [VID]) is None


@pytest.mark.parametrize("verdict", [
    {"allowed": 1, "blocks": []},
    {"allowed": "true", "blocks": []},
    {"allowed": [True], "blocks": []},
    {"allowed": {"v": True}, "blocks": []},
    {"allowed": None, "blocks": []},
    {"Allowed": True, "blocks": []},
    {"gate": {"allowed": True}},
])
def test_anything_but_allowed_exactly_json_true_is_unknown_never_a_pass(conn, sc, verdict):
    with as_superuser(conn, commit=False) as su:
        _video(su, sc.bob.channel, verdict)
        with acting(conn, SERVICE) as s:
            assert s.value(REFUSAL, [VID]) == "gate_unknown", verdict


@pytest.mark.parametrize("shape", [[ALLOWED], "allowed", True])
def test_a_verdict_that_is_not_an_object_cannot_be_stored(conn, sc, shape):
    """0112's check constraint: an array, string or boolean verdict never reaches the refusal's '->' reads."""
    with as_superuser(conn, commit=False) as su:
        _video(su, sc.bob.channel, None)
        out = su.run("update public.videos set gate_verdict = %s::jsonb where video_id = %s", [json.dumps(shape), VID])
        assert not out.ok and out.sqlstate == "23514", out


@pytest.mark.parametrize("verdict", [
    {"allowed": False},
    {"allowed": False, "blocks": "rights"},
    {"allowed": True, "blocks": [None]},
    {"allowed": True, "blocks": [[]]},
    {"allowed": True, "blocks": ["x"] * 50000},
])
def test_a_false_or_any_block_refuses_blocked(conn, sc, verdict):
    with as_superuser(conn, commit=False) as su:
        _video(su, sc.bob.channel, verdict)
        with acting(conn, SERVICE) as s:
            assert s.value(REFUSAL, [VID]) == "gate_blocked", verdict


def test_only_the_service_role_may_call_it_and_it_keeps_its_definer_settings(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _video(su, sc.bob.channel, ALLOWED)
        for who in (ANON, sc.bob.actor, sc.alice.actor):
            with acting(conn, who) as s:
                out = s.run(REFUSAL, [VID])
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        row = su.rows("select prosecdef, proconfig, provolatile from pg_proc "
                      "where oid = 'public.publish_request_refusal(text)'::regprocedure")[0]
        assert row == (True, ['search_path=""'], "s"), row
