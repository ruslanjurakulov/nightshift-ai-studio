"""Migration 0217: a channel id may not be a page of the site's own (/privacy, /pricing, /ru, /uz ...).

The app has refused these words for a long time (isValidChannelId, RESERVED_ROOT_SEGMENTS), but the database held only
the shape, so the create_channel RPC called directly, the service role or the SQL editor could still make a channel
called "privacy" or "ru", whose every screen is shadowed by the page of the same name. The attacker here is the owner of
an ordinary customer organization calling create_channel the way the wizard does, and every writer the function does
not see: the service role and the database owner writing the table directly.

Held beside it (the controls that keep the refusals from being vacuous): an id that merely starts with a reserved word
is created, an ordinary edit of a channel by a signed-in member still passes the new CHECK (it runs its function as the
writer), and the live list is the app's list.

Everything runs on the shared, rolled-back scenario (conftest ``conn`` / ``sc``).
"""

from __future__ import annotations

import re
from typing import Optional

import psycopg

import sec_db
from sec_db import SERVICE, acting, as_superuser

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0217_reserved_channel_ids.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0217_reserved_channel_ids.sql"
PUBLIC_PATHS = sec_db.REPO / "command-center" / "lib" / "public-paths.ts"
CREATE = "select public.create_channel(%s, %s, %s, 'travel', '{}'::jsonb, '{}'::jsonb, null, false)"
SIG = "public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)"
CONSTRAINT = "channels_channel_id_not_reserved"


def refusal(s, query, params) -> tuple[Optional[str], str, Optional[str]]:
    """(sqlstate, message, hint) of a refused statement, in its own savepoint; (None, '', None) when it went through."""
    try:
        with s.conn.transaction():
            s.conn.execute(query, params)
    except psycopg.Error as e:
        return e.sqlstate, (e.diag.message_primary or ""), e.diag.message_hint
    return None, "", None


def exists(s, channel) -> bool:
    s.conn.execute("reset role")
    return bool(s.value("select count(*) from public.channels where channel_id = %s", [channel]))


def app_list() -> set[str]:
    """RESERVED_ROOT_SEGMENTS as the Command Center states it (comments dropped)."""
    text = PUBLIC_PATHS.read_text(encoding="utf-8")
    block = re.search(r"export const RESERVED_ROOT_SEGMENTS = \[(.*?)\] as const;", text, re.S).group(1)
    block = "\n".join(line.split("//", 1)[0] for line in block.splitlines())
    return set(re.findall(r'"([^"]*)"', block))


# ── create_channel: refused by name, before anything is written ─────────────

def test_create_channel_refuses_a_reserved_id_with_a_named_remedy(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        for word in ("ru", "uz", "en", "privacy", "agent-builder"):
            state, message, hint = refusal(s, CREATE, [word, sc.alice.org, "Mine"])
            assert state == "22023", (word, state, message)
            assert message.startswith(f'reserved_channel_id: "{word}" is the address of a page of the site'), message
            assert hint == "reserved_channel_id", hint
        for word in ("ru", "privacy"):
            assert not exists(s, word)


def test_an_upper_case_reserved_id_is_refused_too(conn, sc):
    # The shape check (0086) answers first, with its own 22023; the CHECK below is what holds a direct write.
    with acting(conn, sc.alice.actor) as s:
        state, message, _ = refusal(s, CREATE, ["RU", sc.alice.org, "Mine"])
        assert state == "22023", (state, message)
        assert not exists(s, "RU")


def test_the_trusted_server_caller_is_refused_as_well(conn, sc):
    # credits_trusted_caller() passes the service role past the membership check; the reserved word is not a permission.
    with acting(conn, SERVICE) as s:
        state, _message, hint = refusal(s, CREATE, ["ru", sc.alice.org, "Mine"])
        assert (state, hint) == ("22023", "reserved_channel_id")
        assert not exists(s, "ru")


def test_an_id_that_only_contains_a_reserved_word_is_still_created(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        for ok in ("russia", "ru-history", "privacy-tips"):
            out = s.run(CREATE, [ok, sc.alice.org, "Mine"])
            assert out.ok, (ok, out)
        assert exists(s, "ru-history")


# ── the CHECK: every writer create_channel does not see ─────────────────────

def test_a_direct_insert_of_a_reserved_id_violates_the_check(conn, sc):
    insert = "insert into public.channels (channel_id, name, niche, status, org_id) values (%s, 'x', 'n', 'PAUSED', %s)"
    with as_superuser(conn, commit=False) as su:
        for word in ("ru", "RU", "Privacy", "uz", "trust"):
            state, message, _ = refusal(su, insert, [word, sc.alice.org])
            assert state == "23514" and CONSTRAINT in message, (word, state, message)
    with acting(conn, SERVICE) as s:          # the pipeline's own upsert path (modules/supabase_sync.py)
        state, message, _ = refusal(s, insert, ["en", sc.alice.org])
        assert state == "23514" and CONSTRAINT in message, (state, message)


def test_renaming_a_channel_to_a_reserved_id_violates_the_check(conn, sc):
    with as_superuser(conn, commit=False) as su:
        for word in ("ru", "Ru", "pricing"):
            state, message, _ = refusal(su, "update public.channels set channel_id = %s where channel_id = %s",
                                        [word, sc.alice.channel])
            assert state == "23514" and CONSTRAINT in message, (word, state, message)
        assert su.value("select count(*) from public.channels where channel_id = %s", [sc.alice.channel]) == 1


def test_a_signed_in_member_can_still_edit_their_channel(conn, sc):
    # The CHECK runs is_reserved_channel_id as the writer: without the grant to authenticated every edit of a channel
    # through PostgREST would fail with "permission denied for function".
    with acting(conn, sc.alice.actor) as s:
        out = s.run("update public.channels set name = 'Renamed 0217' where channel_id = %s", [sc.alice.channel])
        assert out.ok and out.rowcount == 1, out


def test_the_constraint_is_validated_and_the_grants_are_what_the_file_says(conn):
    with as_superuser(conn, commit=False) as su:
        assert su.value("select convalidated from pg_constraint where conrelid = 'public.channels'::regclass "
                        "and conname = %s", [CONSTRAINT]) is True
        priv = [su.value("select has_function_privilege(%s, 'public.is_reserved_channel_id(text)', 'EXECUTE')", [r])
                for r in ("anon", "authenticated", "service_role")]
        assert priv == [False, True, True]
        assert su.value("select provolatile from pg_proc where oid = 'public.is_reserved_channel_id(text)'::regprocedure") == "i"
        assert su.value("select prosecdef from pg_proc where oid = %s::regprocedure", [SIG]) is True


def live_list(su) -> set[str]:
    """The words of the function as the database holds it: the array literal of its live definition."""
    src = su.value("select prosrc from pg_proc where oid = 'public.is_reserved_channel_id(text)'::regprocedure")
    array = re.search(r"= any \(array\[(.*?)\]::text\[\]\)", src, re.S)
    assert array, src
    return set(re.findall(r"'([^']*)'", array.group(1)))


def test_the_live_list_is_the_apps_list(conn):
    words = app_list()
    assert {"privacy", "en", "ru", "uz"} <= words
    with as_superuser(conn, commit=False) as su:
        live = live_list(su)
        assert sorted(live - words) == [], "the database reserves words the app does not"
        assert sorted(words - live) == [], "the app reserves words the database does not"
        for w in sorted(words):
            assert su.value("select public.is_reserved_channel_id(%s)", [w]) is True, w
            assert su.value("select public.is_reserved_channel_id(%s)", [w.upper()]) is True, w
        for w in ("default", "chan-a", "russia", "", None):
            assert su.value("select public.is_reserved_channel_id(%s)", [w]) is False, w


# ── the file: names what blocks it, replays, rolls back ─────────────────────

def _snapshot(su):
    return (su.value("select pg_get_functiondef(%s::regprocedure)", [SIG]),
            su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [SIG]),
            su.value("select pg_get_constraintdef(oid) || ' ' || convalidated::text from pg_constraint "
                     "where conrelid = 'public.channels'::regclass and conname = %s", [CONSTRAINT]),
            su.value("select proacl::text from pg_proc where oid = to_regprocedure('public.is_reserved_channel_id(text)')"))


def test_an_existing_reserved_row_is_named_and_the_constraint_left_out_until_it_is_renamed(conn, sc):
    notices: list[str] = []

    def keep(diag):
        notices.append(f"{diag.severity_nonlocalized}: {diag.message_primary}")

    with as_superuser(conn, commit=False) as su:
        su.conn.execute(f"alter table public.channels drop constraint {CONSTRAINT}")
        su.conn.execute("insert into public.channels (channel_id, name, niche, status, org_id) "
                        "values ('docs', 'x', 'n', 'PAUSED', %s)", [sc.alice.org])
        conn.add_notice_handler(keep)
        try:
            su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        finally:
            conn.remove_notice_handler(keep)
        warned = [n for n in notices if n.startswith("WARNING: 0217 did NOT add the constraint")]
        assert len(warned) == 1 and f"docs (organization {sc.alice.org})" in warned[0] and "run 0217 again" in warned[0], notices
        assert su.value("select count(*) from pg_constraint where conname = %s", [CONSTRAINT]) == 0
        # The row keeps working: the bot's sync can still write it (a NOT VALID constraint would have refused this).
        assert su.run("update public.channels set name = 'still syncing' where channel_id = 'docs'").ok
        # create_channel was still replaced, so no NEW reserved id gets in meanwhile.
        assert "reserved_channel_id" in su.value("select pg_get_functiondef(%s::regprocedure)", [SIG])
        su.conn.execute("delete from public.channels where channel_id = 'docs'")
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert su.value("select convalidated from pg_constraint where conname = %s", [CONSTRAINT]) is True


def test_the_migration_replays_and_the_rollback_takes_it_out_and_replays(conn):
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    m0114 = (sec_db.REPO / "supabase" / "migrations" / "0114_ai_disclosure_admin_lock.sql").read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        applied = _snapshot(su)
        assert "NOT" in applied[2] and "is_reserved_channel_id(channel_id)" in applied[2] and applied[2].endswith(" true"), applied
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))           # a replay changes nothing
        assert _snapshot(su) == applied
        su.conn.execute(body)
        after = _snapshot(su)
        assert after[2] is None and after[3] is None
        assert "reserved_channel_id" not in after[0] and "channel_label_lowering" in after[0]
        assert after[1] == applied[1]                                      # the same grants as before
        # 0114's body exactly: replaying 0114's own create_channel gives the same definition.
        cc = re.search(r"create or replace function public\.create_channel\(.*?\n\$\$;\n", m0114, re.S).group(0)
        su.conn.execute(cc)
        assert _snapshot(su)[0] == after[0]
        su.conn.execute(body)                                              # the rollback replays
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _snapshot(su) == applied
    with as_superuser(conn, commit=False) as su:                       # nothing of the above survived the transaction
        assert _snapshot(su) == applied
