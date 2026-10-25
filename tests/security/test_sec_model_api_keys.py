"""Migration 0123 (the owner's vendor API keys, kept in Supabase Vault).

The attackers are everyone a browser can be who is NOT the platform owner: an administrator of the platform (a roster row of role `admin`), a
member of an organization, the viewer of the operator's organization, a signed-in stranger, the anon key and the service key. The owner is
the one caller that must work, and what the owner gets back must never contain the key or the Vault id.

Everything runs on the shared scenario (conftest ``conn`` / ``sc``) inside transactions that are rolled back. No vendor is called: this file
only tests the database half; the vendor check is the Command Center route's (command-center/tests/model-keys-*.test.ts).
"""

from __future__ import annotations

import json
import re
import uuid

import psycopg
import psycopg.sql
import pytest

import sec_db
from contextlib import contextmanager

from sec_db import ANON, SERVICE, acting, user

MIGRATION = sec_db.MIGRATIONS / "0123_model_api_keys.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0123_model_api_keys.sql"

KEY = "sk-attack-AbCdEf0123456789-wxyz"      # 31 printable characters; the last four are "wxyz"
KEY2 = "sk-second-ZyXwVu9876543210-abcd"
PROVIDERS = ["alibaba", "assemblyai", "bfl", "bytedance", "elevenlabs", "google", "ideogram", "kling", "luma", "minimax", "openai",
             "runway", "xai"]


def store(s, provider="openai", key=KEY, status="verified"):
    return s.value("select public.owner_model_key_store(%s, %s, %s)", [provider, key, status])


@contextmanager
def as_superuser(conn, commit=False):
    """The database owner for a look at the ground truth, also from INSIDE a caller's transaction (the lab rolls it back at the end): the
    role and the claims the caller had are put back when the block ends, so the caller can go on."""
    role = conn.execute("select current_user").fetchone()[0]
    claims = conn.execute("select coalesce(current_setting('request.jwt.claims', true), '')").fetchone()[0]
    with sec_db.as_superuser(conn, commit=commit) as s:
        conn.execute("reset role")
        yield s
    conn.execute("select set_config('request.jwt.claims', %s, true)", [claims])
    if role != "postgres":
        conn.execute(psycopg.sql.SQL("set local role {}").format(psycopg.sql.Identifier(role)))


def vault_rows(su, like="nightshift_model_key:%"):
    """The Vault secrets of this feature, without the one the scenario seeded (xai)."""
    return su.rows("select id, name, secret from vault.secrets where name like %s and name not like 'nightshift_model_key:xai:%%' order by name", [like])


def n(su, table):
    """Rows of a feature table, without the one the scenario seeded (xai)."""
    return su.value(f"select count(*) from public.{table} where provider <> 'xai'")


@pytest.fixture()
def admin_actor(conn):
    """A platform administrator who is not the owner: a roster row of role admin, bound to a signed-up account."""
    who = user("platform-admin", f"padmin-{uuid.uuid4().hex[:6]}@lab.test")
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning id", [who.uid, who.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [who.uid, who.email])
        yield su, who


# ── the owner ──────────────────────────────────────────────────────────────────

def test_the_owner_stores_a_key_and_it_lands_in_vault_not_in_a_table(conn, sc):
    with acting(conn, sc.operator) as s:
        out = store(s)
        assert out == {"ok": True, "provider": "openai", "status": "verified", "replaced": False}
        assert KEY not in json.dumps(out)
        listed = s.value("select public.owner_model_key_status()")
        assert listed["ok"] is True
        assert [(k["provider"], k["status"], k["last4"]) for k in listed["keys"]] == [("openai", "verified", "wxyz"), ("xai", "verified", "seed")]
        assert KEY not in json.dumps(listed)
        with as_superuser(conn, commit=False) as su:
            # the status table has the last four characters and nothing more of the key
            assert su.rows("select provider, status, last4 from public.model_api_key_status where provider <> 'xai'") == [("openai", "verified", "wxyz")]
            for table in ("model_api_key_status", "model_api_key_refs"):
                dump = json.dumps(su.rows(f"select to_jsonb(t) from public.{table} t"), default=str)
                assert KEY not in dump and "sk-attack" not in dump, table
            rows = vault_rows(su)
            assert len(rows) == 1 and rows[0][2] == KEY
            # the Vault id is in refs and in no answer the owner got
            sid = str(rows[0][0])
            assert su.value("select vault_secret_id::text from public.model_api_key_refs where provider = 'openai'") == sid
            assert sid not in json.dumps(listed)


def test_a_second_store_replaces_the_secret_in_place_and_says_so(conn, sc):
    with acting(conn, sc.operator) as s:
        store(s)
        out = store(s, key=KEY2, status="format_only")
        assert out == {"ok": True, "provider": "openai", "status": "format_only", "replaced": True}
        with as_superuser(conn, commit=False) as su:
            rows = vault_rows(su)
            assert len(rows) == 1 and rows[0][2] == KEY2        # one secret, new value
            assert su.rows("select status, last4 from public.model_api_key_status where provider <> 'xai'") == [("format_only", "abcd")]
            assert n(su, "model_api_key_refs") == 1


def test_every_provider_of_the_closed_set_is_accepted_and_nothing_else(conn, sc):
    with acting(conn, sc.operator) as s:
        s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.operator.claims())])
        for p in PROVIDERS[:10]:
            assert store(s, provider=p)["ok"] is True, p
    with as_superuser(conn, commit=False) as su:
        assert [p for p in PROVIDERS if su.value("select public.model_key_provider_ok(%s)", [p])] == PROVIDERS
        for bad in ("OpenAI", "openai ", "", "unassigned-video-vendor", "default", "x" * 200, "open-ai", "veo", "gemini", "fal"):
            assert su.value("select public.model_key_provider_ok(%s)", [bad]) is False, bad
        assert su.value("select public.model_key_provider_ok(null)") is False


@pytest.mark.parametrize("bad", ["", "short-key-1234", " " + KEY, KEY + " ", KEY + "\n", "sk with space 0123456789", "sk-$(touch x)-0123456789",
                                 "sk-`id`-0123456789abcd", 'sk-"quote"-0123456789ab', "sk-'quote'-0123456789ab", "sk-back\\slash-0123456789",
                                 "sk-" + "a" * 600, "sk-ééé-0123456789abcdef", "sk-\x01ctl-0123456789abcd", None])
def test_a_value_that_is_not_one_printable_token_is_refused_with_a_document_that_does_not_echo_it(conn, sc, bad):
    with acting(conn, sc.operator) as s:
        out = store(s, key=bad)
        assert out["ok"] is False and out["error"] == "bad_key"
        assert (bad or "x") not in json.dumps(out) or bad in ("", None)
        with as_superuser(conn, commit=False) as su:
            assert vault_rows(su) == [] and n(su, "model_api_key_status") == 0


def test_an_unknown_vendor_or_status_is_refused_and_stores_nothing(conn, sc):
    with acting(conn, sc.operator) as s:
        assert store(s, provider="notavendor")["error"] == "unknown_provider"
        assert store(s, provider=None)["error"] == "unknown_provider"
        assert store(s, status="trusted")["error"] == "bad_status"
        assert store(s, status=None)["error"] == "bad_status"
        with as_superuser(conn, commit=False) as su:
            assert vault_rows(su) == [] and n(su, "model_api_key_refs") == 0


def test_a_refusal_is_a_returned_document_not_a_raised_error(conn, sc):
    # A raised error writes the statement and its parameters to the Postgres log; an expected refusal must not.
    with acting(conn, sc.operator) as s:
        out = s.run("select public.owner_model_key_store('openai', 'x', 'verified')")
        assert out.ok and out.rows[0][0]["error"] == "bad_key"


def test_a_reference_whose_secret_was_deleted_by_hand_does_not_block_a_store_or_a_remove(conn, sc):
    with acting(conn, sc.operator) as s:
        store(s)
        with as_superuser(conn, commit=True) as su:       # a savepoint inside the caller's rolled-back transaction
            su.rows("delete from vault.secrets where name like 'nightshift_model_key:%' returning 1")
        out = store(s, key=KEY2)
        assert out["ok"] is True and out["replaced"] is False
        with as_superuser(conn, commit=False) as su:
            assert [r[2] for r in vault_rows(su)] == [KEY2]
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from vault.secrets where name like 'nightshift_model_key:%' returning 1")
        assert s.value("select public.owner_model_key_remove('openai')")["removed"] is True
        with as_superuser(conn, commit=False) as su:
            assert n(su, "model_api_key_refs") == 0


def test_remove_destroys_the_secret_and_both_rows_and_is_idempotent(conn, sc):
    with acting(conn, sc.operator) as s:
        store(s)
        sid = None
        with as_superuser(conn, commit=False) as su:
            sid = vault_rows(su)[0][0]
        assert s.value("select public.owner_model_key_remove('openai')") == {"ok": True, "provider": "openai", "removed": True}
        assert s.value("select public.owner_model_key_remove('openai')") == {"ok": True, "provider": "openai", "removed": False}
        assert s.value("select public.owner_model_key_remove('notavendor')")["error"] == "unknown_provider"
        with as_superuser(conn, commit=False) as su:
            assert su.rows("select 1 from vault.secrets where id = %s", [sid]) == []                 # deleted, not merely overwritten
            assert n(su, "model_api_key_refs") == 0
            assert n(su, "model_api_key_status") == 0
        assert [k["provider"] for k in s.value("select public.owner_model_key_status()")["keys"]] == ["xai"]


def test_store_and_remove_each_leave_one_audit_row_without_the_key_or_its_last_four(conn, sc):
    with acting(conn, sc.operator) as s:
        store(s)
        store(s, key=KEY2)
        s.value("select public.owner_model_key_remove('openai')")
        with as_superuser(conn, commit=False) as su:
            rows = su.rows("select action, target, detail, actor_user_id::text from public.app_audit_log "
                           "where action = 'secret.write' and target = 'openai' order by id")
            assert sorted(r[2]["op"] for r in rows) == ["remove", "replace", "store"]
            assert all(r[2]["store"] == "vault" and r[3] == sc.operator.uid for r in rows)
            blob = json.dumps(rows, default=str) + json.dumps(su.rows("select to_jsonb(e) from public.security_events e where target = 'openai'"), default=str)
            for fragment in (KEY, KEY2, "wxyz", "abcd", "sk-attack", "sk-second"):
                assert fragment not in blob, fragment


def test_the_owner_is_rate_limited_per_person(conn, sc):
    with acting(conn, sc.operator) as s:
        seen = [s.value("select public.owner_model_key_remove('openai')") for _ in range(25)]
        assert any(isinstance(o, dict) and o.get("error") == "rate_limited" for o in seen)
        assert seen[0]["ok"] is True


# ── everyone else ─────────────────────────────────────────────────────────────────

CALLS = {
    "store": "select public.owner_model_key_store('openai', %s, 'verified')",
    "remove": "select public.owner_model_key_remove('openai')",
    "status": "select public.owner_model_key_status()",
}


def _args(name):
    return [KEY] if name == "store" else []


@pytest.mark.parametrize("name", sorted(CALLS))
def test_a_platform_administrator_who_is_not_the_owner_is_refused_with_a_document_and_nothing_is_stored(conn, sc, admin_actor, name):
    su, who = admin_actor
    with acting(conn, who) as s:
        out = s.run(CALLS[name], _args(name))
        assert out.ok, out
        assert out.rows[0][0]["ok"] is False and out.rows[0][0]["error"] == "owner_required"
        assert KEY not in json.dumps(out.rows[0][0])
        with as_superuser(conn, commit=False) as su2:
            assert vault_rows(su2) == [] and n(su2, "model_api_key_status") == 0


@pytest.mark.parametrize("name", sorted(CALLS))
def test_nobody_else_can_call_any_of_the_three(conn, sc, name):
    people = {"alice (owner of her organization)": sc.alice.actor, "bob": sc.bob.actor, "stranger": sc.stranger,
              "dana (viewer of the operator's organization)": sc.dana, "invitee": sc.invitee, "anon": ANON, "service key": SERVICE}
    for label, who in people.items():
        with acting(conn, who) as s:
            out = s.run(CALLS[name], _args(name))
            assert not out.ok and out.sqlstate == "42501", (label, out)
            with as_superuser(conn, commit=False) as su:
                assert vault_rows(su) == [], label


def test_the_internal_helpers_are_executable_by_no_api_role(conn, sc):
    for who in (sc.operator, sc.alice.actor, ANON, SERVICE):
        with acting(conn, who) as s:
            for q in ("select public.model_key_owner_gate('model_key')", "select public.model_key_provider_ok('openai')"):
                out = s.run(q)
                assert not out.ok and out.sqlstate == "42501", (who.name, q, out)


def test_the_status_table_is_readable_by_the_owner_only_and_writable_by_nobody(conn, sc, admin_actor):
    su, adm = admin_actor
    with acting(conn, sc.operator) as s:
        store(s)
    # RLS rows were rolled back with the transaction above; seed one as the database owner for the readers.
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into public.model_api_key_status (provider, status, last4, checked_by) values ('openai', 'verified', 'wxyz', %s) returning 1",
                [sc.operator.uid])
        su.rows("insert into public.model_api_key_refs (provider, vault_secret_id) values ('openai', gen_random_uuid()) returning 1")
        su.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.operator.claims())])
        su.conn.execute("set local role authenticated")
        assert su.rows("select provider, last4 from public.model_api_key_status where provider = 'openai'") == [("openai", "wxyz")]       # the owner reads
        for stmt in ("insert into public.model_api_key_status (provider, status, last4, checked_by) values ('google', 'verified', 'abcd', gen_random_uuid())",
                     "update public.model_api_key_status set last4 = 'zzzz'", "delete from public.model_api_key_status"):
            out = su.run(stmt)
            assert not out.ok and out.sqlstate == "42501", stmt                                                   # nobody writes it
        for q in ("select * from public.model_api_key_refs", "insert into public.model_api_key_refs (provider, vault_secret_id) values ('google', gen_random_uuid())",
                  "delete from public.model_api_key_refs"):
            out = su.run(q)
            assert not out.ok and out.sqlstate == "42501", q                                                      # not even the owner
        su.conn.execute("reset role")
        for label, who in (("administrator", adm), ("alice", sc.alice.actor), ("dana", sc.dana), ("stranger", sc.stranger)):
            su.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            su.conn.execute("set local role authenticated")
            assert su.rows("select * from public.model_api_key_status") == [], label                               # RLS: no row for them
            su.conn.execute("reset role")
        su.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(ANON.claims())])
        su.conn.execute("set local role anon")
        out = su.run("select * from public.model_api_key_status")
        assert not out.ok and out.sqlstate == "42501"
        su.conn.execute("reset role")
        su.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(SERVICE.claims())])
        su.conn.execute("set local role service_role")
        for q in ("select * from public.model_api_key_refs", "select * from public.model_api_key_status"):
            out = su.run(q)
            assert not out.ok and out.sqlstate == "42501", q
        su.conn.execute("reset role")


def test_the_tables_refuse_a_row_the_functions_would_never_write_even_to_the_database_owner(conn, sc):
    with as_superuser(conn, commit=False) as su:
        for q, params in (
            ("insert into public.model_api_key_status (provider, status, last4, checked_by) values ('google', 'trusted', 'abcd', %s)", [sc.operator.uid]),
            ("insert into public.model_api_key_status (provider, status, last4, checked_by) values ('google', 'verified', 'ab', %s)", [sc.operator.uid]),
            ("insert into public.model_api_key_status (provider, status, last4, checked_by) values ('google', 'verified', 'ab d', %s)", [sc.operator.uid]),
            ("insert into public.model_api_key_status (provider, status, last4, checked_by) values ('nonesuch', 'verified', 'abcd', %s)", [sc.operator.uid]),
            ("insert into public.model_api_key_refs (provider, vault_secret_id) values ('nonesuch', gen_random_uuid())", []),
        ):
            out = su.run(q, params)
            assert not out.ok and out.sqlstate == "23514", (q, out)


# ── the file ─────────────────────────────────────────────────────────────────────

def test_the_migration_replaces_no_existing_function_grants_nothing_to_anon_or_service_and_pins_search_path():
    text = MIGRATION.read_text(encoding="utf-8")
    code = "\n".join(ln for ln in text.splitlines() if not ln.lstrip().startswith("--"))
    assert "audit_action_allowed(p_action" not in code and not re.search(r"create or replace function public\.audit_action_allowed", code)
    created = re.findall(r"create or replace function public\.(\w+)", code)
    assert sorted(created) == ["model_key_owner_gate", "model_key_provider_ok", "owner_model_key_remove", "owner_model_key_status", "owner_model_key_store"]
    for g in re.findall(r"(?is)\bgrant\b[^;]*;", code):
        assert " to authenticated" in g and "anon" not in g and "service_role" not in g, g
    for name in created:
        head = code[code.index(f"function public.{name}"):][:700]
        assert "set search_path" in head, name
    assert "set local lock_timeout" in code
    assert not re.search(r"(?m)^\s*(begin|commit);", code), "the file is one transaction applied by the runner, as the other migrations"


def test_the_rollback_returns_the_schema_to_what_it_was_without_0123_and_0123_applies_again(conn, sc):
    admin = sec_db.admin_dsn()
    base = f"ns_model_keys_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    q_fns = "select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace"
    q_tabs = "select c.relname from pg_class c where relnamespace = 'public'::regnamespace and relkind in ('r','p','v')"
    q_pols = "select policyname from pg_policies where schemaname = 'public'"
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith("0123_")])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = {k: {r[0] for r in b.execute(q).fetchall()} for k, q in (("f", q_fns), ("t", q_tabs), ("p", q_pols))}
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))

    def snap(su):
        return {k: {r[0] for r in su.rows(q)} for k, q in (("f", q_fns), ("t", q_tabs), ("p", q_pols))}

    with as_superuser(conn, commit=False) as su:
        applied = snap(su)
        sid = su.value("select vault.create_secret(%s, 'nightshift_model_key:openai:rollback-test', 'x')", [KEY])
        su.rows("insert into public.model_api_key_refs (provider, vault_secret_id) values ('openai', %s) returning 1", [sid])
        su.conn.execute(body)
        assert snap(su) == want
        assert su.rows("select 1 from vault.secrets where secret = %s", [KEY]) == [], "the rollback destroys the stored keys"
        su.conn.execute(body)                                  # replays
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert snap(su) == applied
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))  # and so does the migration
        assert snap(su) == applied
