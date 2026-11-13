"""Migration 0158: a channel's concept-thumbnail settings (agent_config.thumbnail_mode and thumbnail_concept) are an
administrator's of the channel's organization. ``thumbnail_mode = "concept"`` makes every run of the channel pay for a
planner call and one generated image per A/B arm on the worker's provider keys, and thumbnail_concept picks the model and
whether invented faces or baked words may appear (modules/thumbnail_concept.py).

The attacker is a viewer or editor of alice's organization writing the row the way the Command Center does (PostgREST:
UPDATE on channels, the create_channel RPC, patch_channel_agent_config). The behaviour that must NOT change sits beside
it: an administrator and the owner may, the service role (the pipeline) may, an editor's unrelated edit and a whole-blob
write that carries the stored values back unchanged still pass.

Everything runs on the shared, rolled-back scenario (conftest ``conn`` / ``sc``), except the replay/rollback test, which
builds its own database.
"""

from __future__ import annotations

import json
import re
import uuid

import psycopg
import pytest
from psycopg import sql

import sec_db
from sec_db import SERVICE, acting, as_superuser, user

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0158_thumbnail_concept_admin_lock.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0158_thumbnail_concept_admin_lock.sql"
MERGE = "update public.channels set agent_config = coalesce(agent_config, '{}'::jsonb) || %s::jsonb where channel_id = %s"
CREATE = "select public.create_channel(%s, %s, %s, 'travel', %s::jsonb, '{}'::jsonb, null, false)"
ON = {"thumbnail_mode": "concept", "thumbnail_concept": {"image_provider": "flux", "allow_faces": True}}


def become(s, who):
    """Continue the same (rolled-back) transaction as another API caller: each ``acting`` block rolls back on exit,
    so a write an administrator made must be attacked inside the same block."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def stored(s, channel):
    s.conn.execute("reset role")
    return s.value("select agent_config from public.channels where channel_id = %s", [channel]) or {}


def refused_by_the_lock(out):
    return not out.ok and out.sqlstate == "42501" and "thumbnail_concept_lock" in (out.error or "")


@pytest.fixture()
def world(conn, sc):
    with as_superuser(conn, commit=False) as su:
        members = {}
        for role in ("viewer", "editor", "admin"):
            who = user(f"tc-{role}", f"tc-{role}@a.test")
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                    [who.uid, who.email])
            su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [sc.alice.org, who.uid, who.email, role])
            members[role] = who
        members["owner"] = sc.alice.actor
        yield su, members


# ── the lock ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("key,value", [("thumbnail_mode", "concept"), ("thumbnail_mode", "frame"),
                                       ("thumbnail_concept", {"image_provider": "flux"}),
                                       ("thumbnail_concept", {"allow_baked_text": True}),
                                       ("thumbnail_concept", {})])
def test_an_editor_cannot_set_either_key(conn, sc, world, key, value):
    _su, m = world
    with acting(conn, m["editor"]) as s:
        out = s.run(MERGE, [json.dumps({key: value}), sc.alice.channel])
        assert refused_by_the_lock(out), out
        assert key not in stored(s, sc.alice.channel), "the refused write left the value behind"


def test_an_editor_cannot_change_or_remove_what_an_administrator_set(conn, sc, world):
    _su, m = world
    with acting(conn, m["admin"]) as s:
        assert s.run(MERGE, [json.dumps(ON), sc.alice.channel]).ok
        assert stored(s, sc.alice.channel)["thumbnail_mode"] == "concept"
        become(s, m["editor"])
        for attack in (
            ("update public.channels set agent_config = agent_config - 'thumbnail_mode' where channel_id = %s", [sc.alice.channel]),
            ("update public.channels set agent_config = agent_config - 'thumbnail_concept' where channel_id = %s", [sc.alice.channel]),
            ("update public.channels set agent_config = jsonb_set(agent_config, '{thumbnail_concept,allow_baked_text}', 'true') "
             "where channel_id = %s", [sc.alice.channel]),
            ("update public.channels set agent_config = '{\"language\": \"English\"}'::jsonb where channel_id = %s", [sc.alice.channel]),
            (MERGE, [json.dumps({"thumbnail_mode": "frame"}), sc.alice.channel]),
        ):
            out = s.run(*attack)
            assert refused_by_the_lock(out), (attack[0], out)
            become(s, m["editor"])
        assert stored(s, sc.alice.channel)["thumbnail_concept"] == ON["thumbnail_concept"]


def test_a_viewer_changes_nothing_at_all(conn, sc, world):
    _su, m = world
    with acting(conn, m["viewer"]) as s:
        out = s.run(MERGE, [json.dumps(ON), sc.alice.channel])
        assert (not out.ok) or out.rowcount == 0, out
        assert "thumbnail_mode" not in stored(s, sc.alice.channel)


def test_the_refusal_names_the_hint(conn, sc, world):
    _su, m = world
    with acting(conn, m["editor"]) as s:
        try:
            s.conn.execute(MERGE, [json.dumps({"thumbnail_mode": "concept"}), sc.alice.channel])
        except psycopg.Error as e:
            assert e.diag.sqlstate == "42501" and e.diag.message_hint == "thumbnail_concept_lock", e
            assert e.diag.message_primary.startswith("thumbnail_concept_lock:")
        else:
            raise AssertionError("the write was not refused")


def test_the_atomic_patch_function_cannot_write_either_key(conn, sc, world):
    _su, m = world
    with acting(conn, m["admin"]) as s:
        out = s.run("select public.patch_channel_agent_config(%s, %s::jsonb)",
                    [sc.alice.channel, json.dumps({"thumbnail_mode": "concept"})])
        assert not out.ok and out.sqlstate == "22023", out


def test_create_channel_needs_an_administrator_for_either_key(conn, sc, world):
    _su, m = world
    for i, key in enumerate(("thumbnail_mode", "thumbnail_concept")):
        with acting(conn, m["editor"]) as s:
            out = s.run(CREATE, [f"tc-c-ed-{i}", sc.alice.org, "x", json.dumps({key: ON[key]})])
            assert not out.ok and out.sqlstate == "42501", out
            assert s.value("select count(*) from public.channels where channel_id = %s", [f"tc-c-ed-{i}"]) == 0
    with acting(conn, m["editor"]) as s:      # an editor still creates a channel that does not name them
        out = s.run(CREATE, ["tc-c-plain", sc.alice.org, "x", json.dumps({"language": "English"})])
        assert out.ok, out
    with acting(conn, m["admin"]) as s:
        out = s.run(CREATE, ["tc-c-admin", sc.alice.org, "x", json.dumps(ON)])
        assert out.ok, out
        assert stored(s, "tc-c-admin")["thumbnail_mode"] == "concept"


# ── who may, and what must keep working ──────────────────────────────────────

@pytest.mark.parametrize("who", ["admin", "owner"])
def test_an_administrator_sets_changes_and_removes_both_keys(conn, sc, world, who):
    _su, m = world
    with acting(conn, m[who]) as s:
        out = s.run(MERGE, [json.dumps(ON), sc.alice.channel])
        assert out.ok and out.rowcount == 1, out
        assert stored(s, sc.alice.channel)["thumbnail_mode"] == "concept"
        become(s, m[who])
        out = s.run(MERGE, [json.dumps({"thumbnail_concept": {"image_provider": "fal"}}), sc.alice.channel])
        assert out.ok and out.rowcount == 1, out
        become(s, m[who])
        out = s.run("update public.channels set agent_config = agent_config - 'thumbnail_mode' - 'thumbnail_concept' "
                    "where channel_id = %s", [sc.alice.channel])
        assert out.ok and out.rowcount == 1, out
        assert "thumbnail_mode" not in stored(s, sc.alice.channel)


def test_an_editors_unrelated_edit_and_an_unchanged_blob_still_pass(conn, sc, world):
    _su, m = world
    with acting(conn, m["admin"]) as s:
        assert s.run(MERGE, [json.dumps(ON), sc.alice.channel]).ok
        become(s, m["editor"])
        out = s.run(MERGE, [json.dumps({"language": "Uzbek"}), sc.alice.channel])
        assert out.ok and out.rowcount == 1, out
        blob = stored(s, sc.alice.channel)
        assert blob["thumbnail_mode"] == "concept"
        become(s, m["editor"])   # the Voice / Cast editors write back the whole blob they loaded
        out = s.run("update public.channels set agent_config = %s::jsonb where channel_id = %s",
                    [json.dumps({**blob, "system_prompt": "x"}), sc.alice.channel])
        assert out.ok and out.rowcount == 1, out
        assert stored(s, sc.alice.channel)["thumbnail_concept"] == ON["thumbnail_concept"]


def test_the_service_role_writes_them_as_the_pipeline_does(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run(MERGE, [json.dumps(ON), sc.alice.channel])
        assert out.ok and out.rowcount == 1, out


def test_the_trigger_runs_as_the_caller_and_nobody_may_call_it(conn):
    with as_superuser(conn, commit=False) as su:
        sig = "public.channels_thumbnail_concept_guard()"
        assert su.value("select prosecdef from pg_proc where oid = %s::regprocedure", [sig]) is False
        for role in ("anon", "authenticated", "service_role"):
            assert su.value("select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [role, sig]) is False
        assert su.value("select count(*) from pg_trigger where tgrelid = 'public.channels'::regclass "
                        "and tgname = 'channels_thumbnail_concept_guard' and not tgisinternal") == 1
        assert su.value("select count(*) from pg_trigger where tgrelid = 'public.channels'::regclass "
                        "and tgname = 'channels_config_guard' and not tgisinternal") == 1
        assert sorted(su.value("select public.channel_admin_controls()")) == [
            "auto_publish", "publish_gate", "require_two_person_publish", "storyboard_review",
            "thumbnail_concept", "thumbnail_mode"]


# ── replay and rollback ──────────────────────────────────────────────────────

def test_the_migration_replays_and_the_rollback_takes_it_out(conn, sc):
    admin = sec_db.admin_dsn()
    name = f"ns_tc_lock_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.create_database(admin, name)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    trig = ("select count(*) from pg_trigger where tgrelid = 'public.channels'::regclass "
            "and tgname = 'channels_thumbnail_concept_guard' and not tgisinternal")
    controls = "select array(select k from unnest(public.channel_admin_controls()) k order by k)"
    try:
        sec_db.apply_files(dsn, sec_db.build_sequence())
        with psycopg.connect(dsn, autocommit=True) as c, as_superuser(c, commit=False) as su:
            applied = (su.value(trig), su.value(controls))
            assert applied[0] == 1 and "thumbnail_mode" in applied[1]
            su.conn.execute(MIGRATION.read_text(encoding="utf-8"))           # a replay changes nothing
            assert (su.value(trig), su.value(controls)) == applied
            su.conn.execute(body)
            assert su.value(trig) == 0
            assert su.value(controls) == ["auto_publish", "publish_gate", "require_two_person_publish", "storyboard_review"]
            assert su.value("select to_regprocedure('public.channels_thumbnail_concept_guard()')") is None
            su.conn.execute(body)                                            # the rollback replays
            su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
            assert (su.value(trig), su.value(controls)) == applied
            # A list someone changed by hand is not overwritten.
            su.conn.execute("create or replace function public.channel_admin_controls() returns text[] "
                            "language sql immutable set search_path = public, pg_temp as $$ "
                            "select array['publish_gate']::text[] $$")
            with pytest.raises(psycopg.Error, match="neither 0086"):
                su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
    finally:
        sec_db.drop_database(admin, name)
