"""Breach wave 7, lane G: what a LOW-ROLE member of an organization can rewrite on
their channel row, and what the worker later believes about it.

The attacker is an editor (or any member who can write ``channels``) of an
ordinary customer organization. ``channels`` is the one table a browser writes
straight through PostgREST: the Channels page, the Approvals page and the
channel wizard all call ``supabase.from("channels").update/insert``. The row is
also what the render worker reads as the channel's configuration
(``modules/channels.py`` ``_load_from_supabase``), so a column the member can
write is a column the worker obeys.

Held (a passing test): a viewer writes nothing; an editor's ordinary edits work.

Open (xfail strict, flip when fixed):

* BR-G-002  ``credential_ref`` is written by the member and decides WHICH secret
  the worker uses to publish: ``tools/list_channels.py`` turns ``credential_ref.ref``
  into ``token_secret = CHRONOS_YT_TOKEN_<REF>`` and ``tools/queue_worker.py``
  falls back to that environment variable when the channel has no Vault token.
  The worker-side half is pinned in ``tests/test_breach_wave7_worker.py``. Here:
  the database lets the member name any reference, forge the "verified against
  YouTube" stamp (``credential_ref.verified_at``), and learn which channel ids
  already exist (a duplicate key on insert).
* BR-G-003  the controls that stand between a render and the audience
  (``agent_config.publish_gate``, ``require_two_person_publish``, ``auto_publish``,
  ``storyboard_review``) can be switched off by the member who is meant to be
  held by them. Each is its own parametrized case so the owner can decide, key
  by key, which role may change it and drop the others from the xfail.

Everything runs on the shared, rolled-back scenario (conftest ``conn`` / ``sc``).
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import pytest

from psycopg import sql

from sec_db import acting, as_superuser, user


@contextmanager
def org_members(conn, org, roles=("viewer", "editor", "admin")):
    """A rolled-back world in which org ``org`` also has one member per role."""
    members = {}
    with as_superuser(conn, commit=False) as su:
        for role in roles:
            who = user(f"w7-{role}", f"w7-{role}@a.test")
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                    [who.uid, who.email])
            su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [org, who.uid, who.email, role])
            members[role] = who
        yield su, members


def become(s, who):
    """Continue the same transaction as another API caller (acting() rolls
    everything back when it ends, so a read of the outcome must happen inside)."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def stored(s, channel, column):
    """The row as the database owner sees it, in the transaction the attack ran in."""
    s.conn.execute("reset role")
    return s.value(f"select {column} from public.channels where channel_id = %s", [channel])



# ── held ────────────────────────────────────────────────────────────────────

def test_a_viewer_changes_nothing_on_a_channel_and_creates_none(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["viewer"]) as s:
            out = s.run("update public.channels set name = 'pwned', auto_publish = true where channel_id = %s",
                        [sc.alice.channel])
            assert out.ok and out.rowcount == 0, out
            out = s.run("insert into public.channels (channel_id, name, niche, status, org_id) "
                        "values ('w7-viewer-chan', 'x', 'n', 'PAUSED', %s)", [sc.alice.org])
            assert not out.ok and out.sqlstate == "42501", out
            assert stored(s, sc.alice.channel, "name") != "pwned"


def test_an_editor_can_still_edit_the_ordinary_fields_of_their_channel(conn, sc):
    # The control that keeps the attacks below from being vacuous.
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            out = s.run("update public.channels set name = 'Renamed', niche = 'travel' where channel_id = %s",
                        [sc.alice.channel])
            assert out.ok and out.rowcount == 1, out
            assert stored(s, sc.alice.channel, "name") == "Renamed"


def test_an_editor_cannot_move_a_channel_into_another_organization_or_write_there(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            out = s.run("update public.channels set org_id = %s where channel_id = %s", [sc.bob.org, sc.alice.channel])
            assert not out.ok and out.sqlstate == "42501", out
            out = s.run("update public.channels set name = 'x' where channel_id = %s", [sc.bob.channel])
            assert out.ok and out.rowcount == 0, out
            out = s.run("insert into public.channels (channel_id, name, niche, status, org_id) "
                        "values ('w7-into-b', 'x', 'n', 'PAUSED', %s)", [sc.bob.org])
            assert not out.ok and out.sqlstate == "42501", out


# ── BR-G-002: the member names the secret the worker publishes with ──────────

OPERATORS_REF = "extinct-world"   # an operator channel's secret reference (CHRONOS_YT_TOKEN_EXTINCT_WORLD)


@pytest.mark.xfail(strict=True, reason="BR-G-002 open: credential_ref is member-writable and names the worker's token secret")
def test_BR_G_002_an_editor_cannot_aim_their_channel_at_another_credential(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            s.run("update public.channels set credential_ref = coalesce(credential_ref, '{}'::jsonb) || %s::jsonb "
                  "where channel_id = %s", [json.dumps({"ref": OPERATORS_REF}), sc.alice.channel])
            after = stored(s, sc.alice.channel, "credential_ref")
            assert (after or {}).get("ref") != OPERATORS_REF, \
                f"the member re-pointed the channel at {OPERATORS_REF!r}: {after}"


@pytest.mark.xfail(strict=True, reason="BR-G-002 open: a member can write the 'verified against YouTube' stamp the scheduler and Run now trust")
def test_BR_G_002_an_editor_cannot_make_up_a_channels_verification(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            out = s.run(
                "insert into public.channels (channel_id, name, niche, status, org_id, credential_ref) "
                "values ('w7-forged', 'x', 'n', 'ACTIVE', %s, %s::jsonb)",
                [sc.alice.org, json.dumps({"provider": "youtube", "ref": OPERATORS_REF, "verified_at": "2026-01-01T00:00:00Z",
                                           "youtube_channel_id": "UCforgedforgedforgedforg"})])
        assert not out.ok, ("the database accepted an ACTIVE channel whose proof of verification the member typed "
                            f"themselves: {out!r}")


def test_a_taken_channel_id_is_told_apart_from_a_free_one_BR_G_002_aggravation(conn, sc):
    """Not a hole by itself (a primary key must refuse a duplicate) but what makes
    BR-G-002 practical: an editor of any organization learns, by the error alone,
    which channel ids exist in OTHER organizations (the operator's included), so
    the operator's credential references can be guessed. Pinned as today's
    behaviour so a change to it (a namespaced id, a uniform error) is noticed."""
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            taken = s.run("insert into public.channels (channel_id, name, niche, status, org_id) "
                          "values (%s, 'x', 'n', 'PAUSED', %s)", [sc.bob.channel, sc.alice.org])
            free = s.run("insert into public.channels (channel_id, name, niche, status, org_id) "
                         "values ('w7-free-id', 'x', 'n', 'PAUSED', %s)", [sc.alice.org])
    assert (taken.ok, taken.sqlstate) == (False, "23505")
    assert free.ok


# ── BR-G-003: the controls that hold a render are switchable by the member they hold ──

#: name -> (the owner turns it ON, the editor turns it OFF, the agent_config key)
CONTROLS = {
    "publish_gate": ({"publish_gate": {"originality": True, "fact_check": True}},
                     {"publish_gate": {"originality": False, "fact_check": False}}, "publish_gate"),
    "two_person": ({"require_two_person_publish": True}, {"require_two_person_publish": False},
                   "require_two_person_publish"),
    "storyboard_review": ({"storyboard_review": True}, {"storyboard_review": False}, "storyboard_review"),
}

MERGE = ("update public.channels set agent_config = coalesce(agent_config, '{}'::jsonb) || %s::jsonb "
         "where channel_id = %s")


@pytest.mark.parametrize("name", list(CONTROLS))
@pytest.mark.xfail(strict=True, reason="BR-G-003 open: any editor rewrites the publish gate / approval settings of the channel")
def test_BR_G_003_an_editor_cannot_switch_off_the_gate_or_the_second_person(conn, sc, name):
    on, off, key = CONTROLS[name]
    with org_members(conn, sc.alice.org) as (_su, m):
        # The organization's owner turned the control on (as the Approvals / Channels pages do).
        with acting(conn, sc.alice.actor) as s:
            out = s.run(MERGE, [json.dumps(on), sc.alice.channel])
            assert out.ok and out.rowcount == 1, out
            before = (stored(s, sc.alice.channel, "agent_config") or {}).get(key)
            assert before not in (None, False), "the owner's setting did not take; the test would be vacuous"
            # Then an editor, in the same transaction.
            become(s, m["editor"])
            s.run(MERGE, [json.dumps(off), sc.alice.channel])
            after = (stored(s, sc.alice.channel, "agent_config") or {}).get(key)
            assert after == before, f"an editor changed {key}: {before!r} -> {after!r}"


@pytest.mark.xfail(strict=True, reason="BR-G-003 open: any editor flips auto_publish")
def test_BR_G_003_an_editor_cannot_turn_auto_publish_on(conn, sc):
    with org_members(conn, sc.alice.org) as (_su, m):
        with acting(conn, m["editor"]) as s:
            assert stored(s, sc.alice.channel, "auto_publish") is False
            become(s, m["editor"])
            s.run("update public.channels set auto_publish = true where channel_id = %s", [sc.alice.channel])
            assert stored(s, sc.alice.channel, "auto_publish") is False
