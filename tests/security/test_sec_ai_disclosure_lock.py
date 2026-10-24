"""Migration 0114: ``agent_config.ai_disclosure = never`` and ``ai_disclosure_voice = own_clone`` lower what is declared to
YouTube, Instagram and TikTok, so only a PLATFORM administrator (is_platform_admin: the site owner and helpers) may SET
them. Every customer is the admin of their own organization, so an organization admin is refused too.

The attacker is an editor, an administrator and the owner of an ordinary customer organization (alice's), writing the
row the way the Command Center does (PostgREST: UPDATE on channels, and the create_channel RPC). The behaviour that
must NOT change is checked beside it: unrelated edits of a channel that already has a lowering value, values that
raise the label, the service role, and the platform administrator.

Everything runs on the shared, rolled-back scenario (conftest ``conn`` / ``sc``).
"""

from __future__ import annotations

import json
import re
import sys
import uuid

import psycopg
import pytest
from psycopg import sql

import sec_db
from sec_db import SERVICE, acting, as_superuser, user

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))
from modules import ai_disclosure as reader  # noqa: E402  (the Python reader the lock must agree with)

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0114_ai_disclosure_admin_lock.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0114_ai_disclosure_admin_lock.sql"
MODE = "ai_disclosure"
VOICE = "ai_disclosure_voice"
MERGE = "update public.channels set agent_config = agent_config || %s::jsonb where channel_id = %s"
CREATE = "select public.create_channel(%s, %s, %s, 'travel', %s::jsonb, '{}'::jsonb, null, false)"


def become(s, who):
    """Continue the same transaction as another API caller."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def stored(s, channel):
    s.conn.execute("reset role")
    return s.value("select agent_config from public.channels where channel_id = %s", [channel]) or {}


@pytest.fixture()
def world(conn, sc):
    """A rolled-back transaction in which alice's organization has a viewer, editor and admin member, and the
    platform has a helper (app_members role admin) besides the owner (sc.operator)."""
    with as_superuser(conn, commit=False) as su:
        members = {}
        for role in ("viewer", "editor", "admin"):
            who = user(f"ai-{role}", f"ai-{role}@a.test")
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                    [who.uid, who.email])
            su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [sc.alice.org, who.uid, who.email, role])
            members[role] = who
        helper = user("ai-helper", "ai-helper@nightshift.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                [helper.uid, helper.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1",
                [helper.uid, helper.email])
        members["helper"] = helper
        members["owner"] = sc.alice.actor
        members["platform_owner"] = sc.operator
        yield su, members


def refused_by_the_lock(out):
    return (not out.ok and out.sqlstate == "42501" and "ai_disclosure_lock" in (out.error or ""))


# ── the lock ─────────────────────────────────────────────────────────────────

LOWERING = [(MODE, "never"), (VOICE, "own_clone")]
SPELLINGS = ["never", "Never", "NEVER", " never", "never ", "\tnever\n", "\u00a0never", "never\u3000", "\u2003NeVeR\u2009",
             "\u0085never", "never\u001f"]
VOICE_SPELLINGS = ["own_clone", "Own_Clone", "OWN_CLONE", " own_clone", "own_clone\n", "\u00a0own_clone\u00a0"]


@pytest.mark.parametrize("who", ["editor", "admin", "owner"])
@pytest.mark.parametrize("key,value", LOWERING)
def test_an_organization_member_cannot_set_either_value_even_the_organizations_owner(conn, sc, world, who, key, value):
    _su, m = world
    with acting(conn, m[who]) as s:
        out = s.run(MERGE, [json.dumps({key: value}), sc.alice.channel])
        assert refused_by_the_lock(out), out
        assert key not in stored(s, sc.alice.channel), "the refused write left the value behind"


@pytest.mark.parametrize("value", SPELLINGS)
def test_every_spelling_the_reader_reads_as_never_is_refused(conn, sc, world, value):
    assert reader.normalize_mode(value) == "never", "the corpus must be spellings the reader reads as never"
    _su, m = world
    with acting(conn, m["admin"]) as s:
        out = s.run(MERGE, [json.dumps({MODE: value}), sc.alice.channel])
        assert refused_by_the_lock(out), (value, out)


@pytest.mark.parametrize("value", VOICE_SPELLINGS)
def test_every_spelling_the_reader_reads_as_own_clone_is_refused(conn, sc, world, value):
    assert reader.normalize_voice(value) == "own_clone"
    _su, m = world
    with acting(conn, m["admin"]) as s:
        out = s.run(MERGE, [json.dumps({VOICE: value}), sc.alice.channel])
        assert refused_by_the_lock(out), (value, out)


def test_the_lock_is_not_dodged_by_replacing_the_blob_or_nesting_the_write(conn, sc, world):
    _su, m = world
    with acting(conn, m["admin"]) as s:
        for attack in (
            "update public.channels set agent_config = '{\"ai_disclosure\": \"never\"}'::jsonb where channel_id = %s",
            "update public.channels set agent_config = jsonb_set(coalesce(agent_config, '{}'::jsonb), '{ai_disclosure}', '\"never\"') where channel_id = %s",
            "update public.channels set agent_config = jsonb_set(coalesce(agent_config, '{}'::jsonb), '{ai_disclosure_voice}', '\" Own_Clone\"') where channel_id = %s",
            "update public.channels set agent_config = coalesce(agent_config, '{}'::jsonb) || '{\"ai_disclosure\": \"never\", \"ai_disclosure_voice\": \"always\"}' where channel_id = %s",
        ):
            out = s.run(attack, [sc.alice.channel])
            assert refused_by_the_lock(out), (attack, out)
        assert MODE not in stored(s, sc.alice.channel) and VOICE not in stored(s, sc.alice.channel)


def test_the_refusal_names_the_hint_the_command_center_maps(conn, sc, world):
    _su, m = world
    with acting(conn, m["admin"]) as s:
        try:
            s.conn.execute(MERGE, [json.dumps({MODE: "never"}), sc.alice.channel])
        except Exception as e:  # psycopg.errors.InsufficientPrivilege
            assert e.diag.sqlstate == "42501" and e.diag.message_hint == "ai_disclosure_lock", e
            assert e.diag.message_primary.startswith("ai_disclosure_lock:")
        else:
            raise AssertionError("the write was not refused")


def test_create_channel_refuses_the_values_to_everyone_but_a_platform_administrator(conn, sc, world):
    _su, m = world
    for key, value in LOWERING:
        for who in ("editor", "admin", "owner"):
            with acting(conn, m[who]) as s:
                out = s.run(CREATE, [f"ai-c-{who}", sc.alice.org, "x", json.dumps({key: value})])
                assert refused_by_the_lock(out), (who, key, out)
                assert s.value("select count(*) from public.channels where channel_id = %s", [f"ai-c-{who}"]) == 0
        with acting(conn, m["admin"]) as s:   # a spelling variant through the function
            out = s.run(CREATE, ["ai-c-variant", sc.alice.org, "x", json.dumps({key: f" {value.upper()} "})])
            assert refused_by_the_lock(out), out
    with acting(conn, m["helper"]) as s:
        for i, (key, value) in enumerate(LOWERING):
            out = s.run(CREATE, [f"ai-c-helper-{i}", sc.alice.org, "x", json.dumps({key: value})])
            assert out.ok, out
            assert stored(s, f"ai-c-helper-{i}")[key] == value
    with acting(conn, SERVICE) as s:
        out = s.run(CREATE, ["ai-c-service", sc.alice.org, "x", json.dumps({MODE: "never", VOICE: "own_clone"})])
        assert out.ok, out


def test_create_channel_still_accepts_values_that_do_not_lower_the_label(conn, sc, world):
    _su, m = world
    with acting(conn, m["admin"]) as s:
        out = s.run(CREATE, ["ai-c-ok", sc.alice.org, "x",
                             json.dumps({MODE: "always", VOICE: "real_person", "language": "English"})])
        assert out.ok, out
        out = s.run(CREATE, ["ai-c-ok2", sc.alice.org, "x", json.dumps({MODE: "auto", VOICE: "generic"})])
        assert out.ok, out


def test_a_channel_cannot_be_inserted_straight_into_the_table_either(conn, sc, world):
    # INSERT is revoked from the browser roles (0086); the lock is the second wall behind it.
    _su, m = world
    with acting(conn, m["admin"]) as s:
        out = s.run("insert into public.channels (channel_id, name, niche, org_id, agent_config) "
                    "values ('ai-ins', 'x', 'n', %s, '{\"ai_disclosure\": \"never\"}'::jsonb)", [sc.alice.org])
        assert not out.ok and out.sqlstate == "42501", out


# ── who may ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["helper", "platform_owner"])
def test_a_platform_administrator_sets_all_three_values_of_each_key(conn, sc, world, who):
    _su, m = world
    with acting(conn, m[who]) as s:
        for key, values in ((MODE, ("auto", "always", "never")), (VOICE, ("generic", "own_clone", "real_person"))):
            for value in values:
                out = s.run(MERGE, [json.dumps({key: value}), sc.alice.channel])
                assert out.ok and out.rowcount == 1, (key, value, out)
                assert stored(s, sc.alice.channel)[key] == value
                become(s, m[who])


def test_the_service_role_writes_the_values_as_the_pipeline_does(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run(MERGE, [json.dumps({MODE: "never", VOICE: "own_clone"}), sc.alice.channel])
        assert out.ok and out.rowcount == 1, out
        assert stored(s, sc.alice.channel)[MODE] == "never"


# ── what must keep working ───────────────────────────────────────────────────

def test_an_unrelated_edit_of_a_channel_that_already_has_the_values_still_succeeds(conn, sc, world):
    _su, m = world
    with acting(conn, SERVICE) as s:   # the platform set them earlier
        assert s.run(MERGE, [json.dumps({MODE: " Never", VOICE: "own_clone"}), sc.alice.channel]).ok
        become(s, m["editor"])
        # the Voice / Cast / Schedule editors write the whole blob back with one key changed
        whole = stored(s, sc.alice.channel) | {"language": "Russian", "tts_provider": "edge"}
        become(s, m["editor"])
        out = s.run("update public.channels set agent_config = %s::jsonb where channel_id = %s",
                    [json.dumps(whole), sc.alice.channel])
        assert out.ok and out.rowcount == 1, out
        assert stored(s, sc.alice.channel)[MODE] == " Never"
        become(s, m["admin"])
        assert s.run(MERGE, [json.dumps({"storyboard_review": True}), sc.alice.channel]).ok
        assert s.run("update public.channels set name = 'Renamed' where channel_id = %s", [sc.alice.channel]).ok


def test_an_editor_may_raise_the_label_and_then_cannot_lower_it_again(conn, sc, world):
    _su, m = world
    with acting(conn, SERVICE) as s:
        assert s.run(MERGE, [json.dumps({MODE: "never", VOICE: "own_clone"}), sc.alice.channel]).ok
        become(s, m["editor"])
        assert s.run(MERGE, [json.dumps({MODE: "always", VOICE: "real_person"}), sc.alice.channel]).ok
        assert stored(s, sc.alice.channel)[MODE] == "always"
        become(s, m["editor"])
        assert refused_by_the_lock(s.run(MERGE, [json.dumps({MODE: "never"}), sc.alice.channel]))
        assert refused_by_the_lock(s.run(MERGE, [json.dumps({VOICE: "own_clone"}), sc.alice.channel]))
        # removing the key is "auto" / "generic": raising or neutral, so it passes
        assert s.run("update public.channels set agent_config = agent_config - 'ai_disclosure' where channel_id = %s",
                     [sc.alice.channel]).ok


def test_values_that_do_not_lower_the_label_are_open_to_an_editor(conn, sc, world):
    _su, m = world
    with acting(conn, m["editor"]) as s:
        for cfg in ({MODE: "auto"}, {MODE: "always"}, {VOICE: "generic"}, {VOICE: "real_person"},
                    {MODE: "nevermind", VOICE: "own clone"}, {MODE: 5}, {VOICE: None}, {MODE: ["never"]}):
            out = s.run(MERGE, [json.dumps(cfg), sc.alice.channel])
            assert out.ok and out.rowcount == 1, (cfg, out)
            become(s, m["editor"])


def test_a_viewer_and_a_stranger_still_write_nothing(conn, sc, world):
    _su, m = world
    with acting(conn, m["viewer"]) as s:
        out = s.run(MERGE, [json.dumps({MODE: "always"}), sc.alice.channel])
        assert out.ok and out.rowcount == 0, out
        become(s, sc.bob.actor)
        out = s.run(MERGE, [json.dumps({MODE: "always"}), sc.alice.channel])
        assert out.ok and out.rowcount == 0, out


# ── the lock reads a value the way the Python reader does ────────────────────

def _sql_lowering(s, values):
    """{value: (mode_lowering, voice_lowering)} as the database reads each string."""
    rows = s.rows("select v, 'ai_disclosure' = any (public.channel_label_lowering(jsonb_build_object('ai_disclosure', v))), "
                  "'ai_disclosure_voice' = any (public.channel_label_lowering(jsonb_build_object('ai_disclosure_voice', v))) "
                  "from jsonb_array_elements(%s::jsonb) as t(v)", [json.dumps(values)])
    return {json.loads(v) if not isinstance(v, str) else v: (a, b) for v, a, b in rows}


def test_the_database_and_the_reader_agree_on_every_padding_character(conn):
    """Every Unicode code point as a prefix and as a suffix of the two words: the database says 'lowering' exactly
    where Python's strip().lower() reads never / own_clone."""
    with as_superuser(conn, commit=False) as s:
        sql_hits = {
            (r[0], r[1]) for r in s.rows(
                "select g, side from generate_series(1, 1114111) g "
                "cross join (values ('pre'), ('post')) sides(side) "
                "where not (g between 55296 and 57343) and "
                "  public.ai_disclosure_norm(to_jsonb(case side when 'pre' then chr(g) || 'never' else 'never' || chr(g) end)) = 'never'")}
    py_hits = set()
    for g in range(1, 0x110000):
        if 0xD800 <= g <= 0xDFFF:
            continue
        c = chr(g)
        if reader.normalize_mode(c + "never") == "never":
            py_hits.add((g, "pre"))
        if reader.normalize_mode("never" + c) == "never":
            py_hits.add((g, "post"))
    assert sql_hits == py_hits, (sorted(sql_hits - py_hits)[:10], sorted(py_hits - sql_hits)[:10])


def test_the_database_and_the_reader_agree_on_a_corpus_of_values(conn):
    corpus = ["never", "Never", "NEVER", " never ", "never\n", "always", "auto", "", " ", "nevermind", "ne ver", "n-ever",
              "own_clone", "Own_Clone", " OWN_CLONE", "own-clone", "own clone", "generic", "real_person", "REAL_PERSON",
              "neverr", "\u212aever", "ne\u200bver", "\ufeffnever", "\u180enever", "never\u2060"]
    with as_superuser(conn, commit=False) as s:
        got = _sql_lowering(s, corpus)
    for value in corpus:
        assert got[value] == (reader.normalize_mode(value) == "never", reader.normalize_voice(value) == "own_clone"), value


# ── replay and rollback ──────────────────────────────────────────────────────

def test_the_migration_replays_and_the_rollback_puts_0086s_two_functions_back(conn, sc):
    """The rollback file restores channels_config_guard and create_channel byte for byte (and their grants), drops the two
    helpers, and the migration applies again on top; a replay of the migration changes nothing."""
    admin = sec_db.admin_dsn()
    base = f"ns_ai_lock_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    sigs = ("public.channels_config_guard()", "public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)")
    try:
        # 0117 replaces channels_config_guard() on 0114's body and needs 0114, and 0119 replaces it again on 0117's, so both are left
        # out of both databases here: tests/security/test_sec_voice_profiles.py and test_sec_channel_settings.py prove their own
        # rollbacks and replays.
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(("0114_", "0117_", "0119_", "0121_"))])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = {s: (b.execute("select pg_get_functiondef(%s::regprocedure)", [s]).fetchone()[0],
                        b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [s]).fetchone()[0])
                    for s in sigs}
            fns = [r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace order by 1")]
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    full = f"ns_ai_lock_full_{uuid.uuid4().hex[:8]}"
    full_dsn = sec_db.create_database(admin, full)
    try:
        sec_db.apply_files(full_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(("0117_", "0119_", "0121_"))])
        with psycopg.connect(full_dsn, autocommit=True) as fconn:
            _replay_and_rollback(fconn, sigs, want, fns, body)
    finally:
        sec_db.drop_database(admin, full)


def _replay_and_rollback(conn, sigs, want, fns, body):
    with as_superuser(conn, commit=False) as su:
        def snapshot():
            return {s: (su.value("select pg_get_functiondef(%s::regprocedure)", [s]),
                        su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [s])) for s in sigs}
        applied = snapshot()
        trig = "select oid, tgtype, tgenabled, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.channels'::regclass and tgname = 'channels_config_guard'"
        trigger_before = su.rows(trig)
        assert len(trigger_before) == 1
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))          # a replay
        assert snapshot() == applied
        # the trigger is the same object (same oid): 0114 neither dropped nor re-created it
        assert su.rows(trig) == trigger_before
        assert "BEFORE INSERT OR UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION channels_config_guard()" in trigger_before[0][3]
        su.conn.execute(body)
        assert snapshot() == want
        assert su.rows(trig) == trigger_before                           # nor does the rollback touch it
        assert [r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace order by 1")] == fns
        su.conn.execute(body)                                           # the rollback replays
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert snapshot() == applied


def test_the_grants_are_what_the_file_says(conn):
    with as_superuser(conn, commit=False) as su:
        def priv(sig):
            return [su.value("select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [r, sig])
                    for r in ("anon", "authenticated", "service_role")]
        assert priv("public.ai_disclosure_norm(jsonb)") == [False, True, True]
        assert priv("public.channel_label_lowering(jsonb)") == [False, True, True]
        assert priv("public.channels_config_guard()") == [False, False, False]
        assert priv("public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)") == [False, True, True]
        # still a trigger on channels, and still a security INVOKER function (the caller is what it tells apart)
        assert su.value("select prosecdef from pg_proc where oid = 'public.channels_config_guard()'::regprocedure") is False
        assert su.value("select count(*) from pg_trigger where tgrelid = 'public.channels'::regclass and tgname = 'channels_config_guard'") == 1
