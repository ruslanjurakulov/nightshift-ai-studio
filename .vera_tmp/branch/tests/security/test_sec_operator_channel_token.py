"""Migration 0115: the operator's own channels (Chronos, `default`) keep a Vault connection, written only by a platform
owner/admin, readable only by the service role.

What would break without these (each attacked in a real database):

  * a customer organization's admin (or a viewer / editor of the operator's organization, or someone who is only an
    organization member and not on the platform roster) writes a token onto an operator channel, or learns it exists;
  * the platform admin is turned away from his own channel, or writes a token for a CUSTOMER's channel with this function;
  * the customer function starts accepting the operator's organization, or a customer reaches an operator token by naming
    its channel (a customer's credential_ref.ref never selects a Vault row);
  * a browser or anon reads the stored token back, or the Vault row;
  * an unpinned or mismatched YouTube channel is stored, scopes outside the connect flow's are stored;
  * the rollback leaves the function behind or the migration does not re-apply.
"""

from __future__ import annotations

import json
import re

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user
from sec_scenario import DEFAULT_ORG

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0115_operator_channel_token.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0115_operator_channel_token.sql"

STORE = "select public.store_operator_channel_token(%s, %s, %s::jsonb)"
CUSTOMER_STORE = "select public.store_channel_token(%s, %s, %s::jsonb)"
TOKEN = "1//0gOPERATORrefreshTOKEN" + "a" * 20
META = json.dumps({"youtube_channel_id": "UCchronos", "youtube_channel_title": "Chronos", "scopes": [
    "https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    "oauth_client_id": "cc.apps.googleusercontent.com"})


def platform_user(su, role, name):
    """A real account on the platform roster (app_members) with `role`."""
    who = user(name, f"{name}@op.test")
    su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
    su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, %s) returning 1", [who.uid, who.email, role])
    return who


def org_only_member(su, role, name):
    """A member of the operator's organization through org_members only: NOT on the platform roster."""
    who = user(name, f"{name}@op.test")
    su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
            [DEFAULT_ORG, who.uid, who.email, role])
    return who


def stored_ref(conn, channel):
    with as_superuser(conn, commit=False) as su:
        return su.rows("select vault_secret_id is not null, youtube_channel_id, revoked_at is null, oauth_client_id "
                       "from public.channel_token_refs where channel_id = %s", [channel])


def test_the_platform_owner_connects_the_default_channel_and_only_the_service_role_reads_it_back(conn, sc):
    with acting(conn, sc.operator, commit=True) as s:
        out = s.run(STORE, ["default", TOKEN, META])
        assert out.ok, out
        assert out.rows[0][0]["connected"] is True and out.rows[0][0]["reconnected"] is False
        status = s.rows("select connected, youtube_channel_id from public.channel_token_status('default')")
        assert status == [(True, "UCchronos")]
        # Reconnect replaces the secret in place.
        again = s.run(STORE, ["default", TOKEN[:-1] + "b", META])
        assert again.ok and again.rows[0][0]["reconnected"] is True
    try:
        for who in (sc.operator, sc.alice.actor, sc.bob.actor, ANON):
            with acting(conn, who) as s:
                assert not s.run("select * from public.read_channel_token('default')").ok, who.name
                assert not s.run("select decrypted_secret from vault.decrypted_secrets").ok, who.name
                assert not s.run("select * from public.channel_token_refs").ok, who.name
        with acting(conn, SERVICE) as s:
            rows = s.rows("select refresh_token, youtube_channel_id, oauth_client_id from public.read_channel_token('default')")
            assert rows == [(TOKEN[:-1] + "b", "UCchronos", "cc.apps.googleusercontent.com")]
    finally:
        with as_superuser(conn) as su:
            su.rows("delete from vault.secrets returning 1")
            su.rows("delete from public.channel_token_refs returning 1")


def test_nobody_but_a_platform_owner_or_admin_may_connect_an_operator_channel(conn, sc):
    with as_superuser(conn, commit=False) as su:
        admin = platform_user(su, "admin", "op-admin")
        editor = platform_user(su, "editor", "op-editor")
        viewer = platform_user(su, "viewer", "op-viewer")
        org_admin = org_only_member(su, "admin", "op-orgadmin")      # an admin of the operator's org, not on the roster
        refused = {"editor": editor, "viewer": viewer, "org_only_admin": org_admin, "dana": sc.dana,
                   "customer_admin": sc.alice.actor, "other_customer": sc.bob.actor, "stranger": sc.stranger}
        # The roster rows above live in this rolled-back world; act inside it.
        for name, who in refused.items():
            su.conn.execute("reset role")
            su.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            su.conn.execute("set local role authenticated")
            out = su.run(STORE, ["default", TOKEN, META])
            assert not out.ok and out.sqlstate == "42501", (name, out)
            assert su.run(STORE, ["ruslanjurakulov", TOKEN, META]).sqlstate == "42501", name
        su.conn.execute("reset role")
        su.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(admin.claims())])
        su.conn.execute("set local role authenticated")
        assert su.run(STORE, ["default", TOKEN, META]).ok, "a platform admin is turned away from the operator's channel"
        su.conn.execute("reset role")
        assert su.value("select count(*) from public.channel_token_refs where channel_id = 'default'") == 1


def test_anon_and_the_service_key_cannot_call_it(conn, sc):
    for who in (ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run(STORE, ["default", TOKEN, META])
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
    assert stored_ref(conn, "default") == []


def test_an_operator_function_does_not_write_a_customers_channel_and_the_customer_function_still_refuses_the_operator(conn, sc):
    # The platform owner is an admin of every organization (0018), but this function is the operator's alone.
    with acting(conn, sc.operator) as s:
        out = s.run(STORE, [sc.alice.channel, TOKEN, META])
        assert not out.ok and out.sqlstate == "42501", out
    # The customer function is unchanged: it refuses the operator's organization (even for the platform owner), and a
    # customer admin cannot name the operator's channel.
    with acting(conn, sc.operator) as s:
        out = s.run(CUSTOMER_STORE, ["default", TOKEN, META])
        assert not out.ok and out.sqlstate == "22023" and "keep their token" in out.error, out
    with acting(conn, sc.alice.actor) as s:
        out = s.run(CUSTOMER_STORE, ["default", TOKEN, META])
        assert not out.ok and out.sqlstate == "42501", out
    assert stored_ref(conn, "default") == [] and stored_ref(conn, sc.alice.channel) == []


def test_a_customer_credential_ref_cannot_select_the_operators_vault_row(conn, sc):
    """The runner reads by the channel's OWN id. A customer row whose credential_ref.ref names `default` changes nothing in
    the database either: its token (if any) is its own row, and `default` stays the operator's."""
    with acting(conn, sc.operator, commit=True) as s:
        assert s.run(STORE, ["default", TOKEN, META]).ok
    try:
        with as_superuser(conn) as su:
            su.rows("update public.channels set credential_ref = credential_ref || '{\"ref\": \"default\"}'::jsonb "
                    "where channel_id = %s returning 1", [sc.alice.channel])
        with acting(conn, SERVICE) as s:
            assert s.rows("select count(*) from public.read_channel_token(%s)", [sc.alice.channel]) == [(0,)]
            assert s.rows("select count(*) from public.read_channel_token('default')") == [(1,)]
    finally:
        with as_superuser(conn) as su:
            su.rows("update public.channels set credential_ref = credential_ref - 'ref' where channel_id = %s returning 1",
                    [sc.alice.channel])
            su.rows("delete from vault.secrets returning 1")
            su.rows("delete from public.channel_token_refs returning 1")


def test_it_validates_the_token_the_scopes_and_the_pinned_youtube_channel(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.channels set credential_ref = '{\"youtube_channel_id\": \"UCpinned\"}'::jsonb "
                "where channel_id = 'default' returning 1")
        su.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.operator.claims())])
        su.conn.execute("set local role authenticated")
        wrong = su.run(STORE, ["default", TOKEN, META])
        assert not wrong.ok and wrong.sqlstate == "22023" and "wrong_youtube_channel" in wrong.error, wrong
        pinned = json.dumps({"youtube_channel_id": "UCpinned", "scopes": []})
        for bad in ("short", "has space in it 123456", "x" * 3000, None):
            assert su.run(STORE, ["default", bad, pinned]).sqlstate == "22023", bad
        assert su.run(STORE, ["default", TOKEN, json.dumps({"youtube_channel_id": "UCpinned", "scopes": ["https://www.googleapis.com/auth/drive"]})]).sqlstate == "22023"
        assert su.run(STORE, ["default", TOKEN, json.dumps({"youtube_channel_id": "UCpinned", "evil": 1})]).sqlstate == "22023"
        assert su.run(STORE, ["default", TOKEN, json.dumps({"scopes": []})]).sqlstate == "22023"
        assert su.run(STORE, ["default", TOKEN, pinned]).ok
        su.conn.execute("reset role")
        assert su.value("select count(*) from public.channel_token_refs where channel_id = 'default'") == 1


def test_an_unknown_channel_reads_like_a_refused_one(conn, sc):
    with acting(conn, sc.operator) as s:
        a = s.run(STORE, ["no-such-channel", TOKEN, META])
        b = s.run(STORE, [sc.alice.channel, TOKEN, META])
    assert (a.sqlstate, a.error) == (b.sqlstate, b.error) == ("42501", "only the platform owner or an admin may connect an operator channel")


def test_the_migration_is_pinned_and_the_rollback_round_trips(conn, sc):
    text = MIGRATION.read_text(encoding="utf-8")
    assert "language plpgsql volatile security definer set search_path = ''" in text
    assert "public.is_platform_admin()" in text and "public.default_org_id()" in text
    # Customer function untouched by this file.
    assert "create or replace function public.store_channel_token" not in text
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    with as_superuser(conn, commit=False) as su:
        sig = "public.store_operator_channel_token(text,text,jsonb)"
        before = (su.value("select pg_get_functiondef(%s::regprocedure)", [sig]), su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sig]))
        customer = su.value("select pg_get_functiondef('public.store_channel_token(text,text,jsonb)'::regprocedure)")
        su.conn.execute(body)
        assert su.value("select to_regprocedure(%s)", [sig]) is None
        assert su.value("select pg_get_functiondef('public.store_channel_token(text,text,jsonb)'::regprocedure)") == customer
        su.conn.execute(body)                      # replays
        su.conn.execute(text)                      # and the migration re-applies to the same shape
        assert (su.value("select pg_get_functiondef(%s::regprocedure)", [sig]), su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sig])) == before
        su.conn.execute(text)                      # idempotent
