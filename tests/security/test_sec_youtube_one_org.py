"""Migration 0141: one YouTube channel (its `UC...` id) is connected to at most ONE organization at a time.

"Connected" (0141's header): a channel holds YouTube id Y through an ACTIVE Vault connection (channel_token_refs with a secret and no
revoked_at) or a CONFIRMED row (channels.credential_ref.verified_at set for that youtube_channel_id). Every write that makes a channel of
organization O hold Y is refused when a channel of another organization holds Y: SQLSTATE 23P01, message 'youtube_channel_in_use: ...',
hint 'youtube_channel_in_use', and nothing that names the holder.

What would break without these (each attacked in a real database):

  * a second organization's admin connects a YouTube channel another organization holds (the incident), through the customer function,
    the operator's function, the credential stamp, create_channel, a direct table write by the service key or the SQL editor, or by
    moving a channel row between organizations (0018 lets an admin of both do that with a plain UPDATE);
  * a reconnect / token refresh inside the same organization, or a second channel of the same organization on the same YouTube channel,
    is refused;
  * a disconnect does not free the id;
  * two concurrent connects from two organizations both win (the check reads before the other commits);
  * the refusal says who holds the id;
  * the file applies over live duplicates and silently keeps both, or its rollback leaves anything behind.

Rows made in the shared lab database are made inside rolled-back transactions, except in the race test, which needs two committed
connections and removes its rows in `finally`. The file-level tests (duplicates, drift guard, rollback) run on a scratch database.
"""

from __future__ import annotations

import json
import threading
import time
import uuid

import psycopg
import pytest

import sec_db
from sec_db import SERVICE, as_superuser, user
from sec_scenario import DEFAULT_ORG

MIGRATION = sec_db.MIGRATIONS / "0141_youtube_channel_one_org.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0141_youtube_channel_one_org.sql"
CHECK_SQL = sec_db.REPO / "docs" / "sql" / "check_0141_youtube_channel_duplicates.sql"

STORE = "select public.store_channel_token(%s, %s, %s::jsonb)"
OPERATOR_STORE = "select public.store_operator_channel_token(%s, %s, %s::jsonb)"
REVOKE = "select public.revoke_channel_token(%s)"
TOKEN = "1//0gREFRESHtoken" + "a" * 24
SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]
IN_USE = "youtube_channel_in_use"


def meta(yt, title="Some channel"):
    return json.dumps({"youtube_channel_id": yt, "youtube_channel_title": title, "scopes": SCOPES})


def body_of(path):
    """A file without its own begin / commit, to run inside a test's transaction."""
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def _become(conn, who):
    conn.execute("reset role")
    conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims() if who else {})])
    if who is not None:
        conn.execute(f"set local role {who.role}")


def _call(conn, who, q, params=None):
    """Run q as `who` (None: the database owner, i.e. the SQL editor) in a savepoint of the current transaction.
    Returns ('ok', first value) or (sqlstate, message, hint, detail)."""
    try:
        with conn.transaction():
            _become(conn, who)
            cur = conn.execute(q, params)
            v = cur.fetchone()[0] if cur.description else None
            _become(conn, None)
            return "ok", v
    except psycopg.Error as e:
        d = e.diag
        return e.sqlstate, d.message_primary, d.message_hint, d.message_detail


def _channel(conn, cid, org, **cred):
    """A paused channel row as the pipeline writes one (the owner: the guard lets it through)."""
    conn.execute("insert into public.channels (channel_id, name, niche, status, org_id, credential_ref) "
                 "values (%s, %s, 'tech', 'PAUSED', %s, %s::jsonb)", [cid, f"Name of {cid}", org, json.dumps(cred)])


def _holders(conn, yt):
    """Ground truth: (channel, org, via) for every holder of yt, the 0141 definition."""
    return sorted(conn.execute(
        "select c.channel_id, c.org_id::text, 'confirmed' from public.channels c "
        " where coalesce(c.credential_ref ->> 'verified_at', '') <> '' and btrim(c.credential_ref ->> 'youtube_channel_id') = %s "
        "union all "
        "select r.channel_id, c.org_id::text, 'vault_token' from public.channel_token_refs r join public.channels c using (channel_id) "
        " where r.vault_secret_id is not null and r.revoked_at is null and btrim(r.youtube_channel_id) = %s", [yt, yt]).fetchall())


def _refused(got, sc):
    """The stable refusal, and nothing in it that names the holder."""
    assert got[0] == "23P01", got
    state, message, hint, detail = got
    assert message.startswith("youtube_channel_in_use:") and hint == IN_USE and detail is None, got
    text = " ".join(str(x) for x in got)
    for secret in (sc.alice.org, sc.bob.org, DEFAULT_ORG, sc.alice.channel, sc.bob.channel, "chan-", sc.alice.actor.email,
                   sc.bob.actor.email, "Name of", "Channel A", "Channel B"):
        assert secret not in text, (secret, got)


# ── the rule ────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_lab_starts_with_each_tenant_holding_its_own_youtube_channel(conn, sc):
    with as_superuser(conn, commit=False):
        assert _holders(conn, "UCyta") == [(sc.alice.channel, sc.alice.org, "confirmed"), (sc.alice.channel, sc.alice.org, "vault_token")]
        assert _holders(conn, "UCytb") == [(sc.bob.channel, sc.bob.org, "confirmed"), (sc.bob.channel, sc.bob.org, "vault_token")]


def test_a_reconnect_in_the_same_organization_and_a_second_channel_of_it_keep_working(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _channel(conn, "chan-a2", sc.alice.org)
        got = _call(conn, sc.alice.actor, STORE, [sc.alice.channel, TOKEN, meta("UCyta")])
        assert got[0] == "ok" and got[1]["reconnected"] is True, got
        got = _call(conn, sc.alice.actor, STORE, [sc.alice.channel, TOKEN[:-1] + "b", meta(" UCyta ")])   # Google's id, trimmed
        assert got[0] == "ok", got
        # the same organization may connect a second Nightshift channel to the same YouTube channel
        got = _call(conn, sc.alice.actor, STORE, ["chan-a2", TOKEN, meta("UCyta")])
        assert got[0] == "ok" and got[1]["reconnected"] is False, got
        assert {h[1] for h in _holders(conn, "UCyta")} == {sc.alice.org}
        # and a fresh YouTube channel nobody holds connects as before
        _channel(conn, "chan-b2", sc.bob.org)
        assert _call(conn, sc.bob.actor, STORE, ["chan-b2", TOKEN, meta("UCbrandnew")])[0] == "ok"


def test_a_second_organization_is_refused_with_the_stable_code_and_learns_nothing_about_the_holder(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        # Bob adds a channel to his organization and signs in with the Google account of Alice's YouTube channel.
        _channel(conn, "chan-bx", sc.bob.org)
        secrets = conn.execute("select count(*) from vault.secrets").fetchone()[0]
        got = _call(conn, sc.bob.actor, STORE, ["chan-bx", TOKEN, meta("UCyta")])
        _refused(got, sc)
        # nothing was stored: no connection row, no confirmation, and the new Vault secret rolled back with the refusal
        assert conn.execute("select count(*) from public.channel_token_refs where channel_id = 'chan-bx'").fetchone()[0] == 0
        assert conn.execute("select credential_ref from public.channels where channel_id = 'chan-bx'").fetchone()[0] == {}
        assert conn.execute("select count(*) from vault.secrets").fetchone()[0] == secrets
        # the answer is the same whoever holds it: org A's channel, or the operator's confirmed channel
        conn.execute("update public.channels set credential_ref = credential_ref || %s::jsonb where channel_id = 'default'",
                     [json.dumps({"youtube_channel_id": "UCoperator", "verified_at": "2026-01-01T00:00:00.000Z"})])
        other = _call(conn, sc.bob.actor, STORE, ["chan-bx", TOKEN, meta("UCoperator")])
        _refused(other, sc)
        assert other == got, (other, got)
        # and through the pick flow's new channel (created unconfirmed, then connected)
        _channel(conn, "chan-b2", sc.bob.org, provider="youtube", ref="chan-b2", youtube_channel_id="UCyta")
        _refused(_call(conn, sc.bob.actor, STORE, ["chan-b2", TOKEN, meta("UCyta")]), sc)
        assert {h[1] for h in _holders(conn, "UCyta")} == {sc.alice.org}


def test_the_operators_own_connect_stamp_and_create_are_held_to_it_too(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        # store_operator_channel_token (0115): the platform owner connects the default channel to a customer's YouTube channel
        _refused(_call(conn, sc.operator, OPERATOR_STORE, ["default", TOKEN, meta("UCyta")]), sc)
        # set_channel_credential with the stamp (0086): the operator's wizard confirms a channel against it
        _refused(_call(conn, sc.operator, "select public.set_channel_credential('default', %s::jsonb, true)",
                       [json.dumps({"youtube_channel_id": "UCyta"})]), sc)
        # create_channel with the stamp (0114; the operator's Add channel screen): 23P01, never 'that channel id is not available'
        got = _call(conn, sc.operator, "select public.create_channel('op-new', %s, 'New', '', '{}'::jsonb, '{}'::jsonb, %s::jsonb, true)",
                    [DEFAULT_ORG, json.dumps({"youtube_channel_id": "UCyta"})])
        _refused(got, sc)
        assert conn.execute("select count(*) from public.channels where channel_id = 'op-new'").fetchone()[0] == 0
        # the same three with a YouTube channel nobody holds still work
        assert _call(conn, sc.operator, "select public.set_channel_credential('default', %s::jsonb, true)",
                     [json.dumps({"youtube_channel_id": "UCopfree"})])[0] == "ok"
        assert _call(conn, sc.operator, "select public.create_channel('op-new', %s, 'New', '', '{}'::jsonb, '{}'::jsonb, %s::jsonb, true)",
                     [DEFAULT_ORG, json.dumps({"youtube_channel_id": "UCopfree2"})])[0] == "ok"
        assert _call(conn, sc.operator, OPERATOR_STORE, ["default", TOKEN, meta("UCopfree")])[0] == "ok"
        # an UNconfirmed credential naming a held id is not a connection, so writing it is not refused (an editor's typo holds nothing)
        assert _call(conn, sc.bob.actor, "select public.set_channel_credential(%s, %s::jsonb, false)",
                     [sc.bob.channel, json.dumps({"youtube_channel_id": "UCyta"})])[0] == "ok"
        assert {h[1] for h in _holders(conn, "UCyta")} == {sc.alice.org}


def test_a_disconnect_frees_the_id_for_another_organization_and_the_first_cannot_take_it_back(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        assert _call(conn, sc.alice.actor, REVOKE, [sc.alice.channel]) == ("ok", True)
        assert _holders(conn, "UCyta") == [], "a revoked connection (and the confirmation it gave) holds nothing"
        # the YouTube id stays pinned on alice's row (without verified_at): that pin is not a connection
        assert conn.execute("select credential_ref ->> 'youtube_channel_id', coalesce(credential_ref ->> 'verified_at', '') "
                            "from public.channels where channel_id = %s", [sc.alice.channel]).fetchone() == ("UCyta", "")
        _channel(conn, "chan-bx", sc.bob.org)
        got = _call(conn, sc.bob.actor, STORE, ["chan-bx", TOKEN, meta("UCyta")])
        assert got[0] == "ok", got
        # now org B holds it, and org A's reconnect is the one refused
        _refused(_call(conn, sc.alice.actor, STORE, [sc.alice.channel, TOKEN, meta("UCyta")]), sc)
        assert {h[1] for h in _holders(conn, "UCyta")} == {sc.bob.org}


def test_direct_table_writes_are_held_to_it_on_every_role(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        # A browser cannot write a connection or a confirmation at all (0022: no table privilege; 0086: no column privilege).
        assert _call(conn, sc.bob.actor, "update public.channels set credential_ref = %s::jsonb where channel_id = %s",
                     [json.dumps({"youtube_channel_id": "UCyta", "verified_at": "x"}), sc.bob.channel])[0] == "42501"
        assert _call(conn, sc.bob.actor, "insert into public.channel_token_refs (channel_id, vault_secret_id, youtube_channel_id) "
                     "values (%s, gen_random_uuid(), 'UCyta')", [sc.bob.channel])[0] == "42501"
        # The service key (it holds the table privilege on channels) and the SQL editor (no privilege applies) are refused by the rule.
        _refused(_call(conn, SERVICE, "update public.channels set credential_ref = %s::jsonb where channel_id = %s",
                       [json.dumps({"youtube_channel_id": "UCyta", "verified_at": "2026-01-01T00:00:00.000Z"}), sc.bob.channel]), sc)
        _refused(_call(conn, None, "update public.channel_token_refs set youtube_channel_id = 'UCyta' where channel_id = %s",
                       [sc.bob.channel]), sc)
        _refused(_call(conn, None, "insert into public.channels (channel_id, name, niche, status, org_id, credential_ref) "
                       "values ('chan-b9', 'x', 't', 'PAUSED', %s, %s::jsonb)",
                       [sc.bob.org, json.dumps({"youtube_channel_id": "UCyta", "verified_at": "2026-01-01T00:00:00.000Z"})]), sc)
        # un-revoking an old connection row by hand is a new claim too
        _channel(conn, "chan-b3", sc.bob.org)
        conn.execute("insert into public.channel_token_refs (channel_id, vault_secret_id, youtube_channel_id, revoked_at) "
                     "values ('chan-b3', null, 'UCyta', now())")
        _refused(_call(conn, None, "update public.channel_token_refs set vault_secret_id = gen_random_uuid(), revoked_at = null "
                       "where channel_id = 'chan-b3'"), sc)
        assert {h[1] for h in _holders(conn, "UCyta")} == {sc.alice.org}


def test_moving_a_channel_between_organizations_cannot_split_one_youtube_channel_across_two(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        # Alice administers org B too (the shape of the incident: one person, two workspaces). 0018 lets her move a channel.
        conn.execute("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin')",
                     [sc.bob.org, sc.alice.actor.uid, sc.alice.actor.email])
        _channel(conn, "chan-a2", sc.alice.org)
        assert _call(conn, sc.alice.actor, STORE, ["chan-a2", TOKEN, meta("UCyta")])[0] == "ok"
        move = "update public.channels set org_id = %s where channel_id = %s returning org_id"
        # chan-a still holds UCyta in org A: moving chan-a2 (Vault-connected and confirmed) to B would make two organizations
        _refused(_call(conn, sc.alice.actor, move, [sc.bob.org, "chan-a2"]), sc)
        # the same for a row that holds it only by its Vault connection (its confirmation removed by the owner)
        conn.execute("update public.channels set credential_ref = credential_ref - 'verified_at' where channel_id = 'chan-a2'")
        _refused(_call(conn, sc.alice.actor, move, [sc.bob.org, "chan-a2"]), sc)
        # once chan-a is disconnected, chan-a2 is org A's only holder and may move: the id goes with the row
        assert _call(conn, sc.alice.actor, REVOKE, [sc.alice.channel]) == ("ok", True)
        got = _call(conn, sc.alice.actor, move, [sc.bob.org, "chan-a2"])
        assert got[0] == "ok", got
        assert {h[1] for h in _holders(conn, "UCyta")} == {sc.bob.org}
        # and a move of a channel that holds nothing is not checked at all
        _channel(conn, "chan-a3", sc.alice.org)
        assert _call(conn, sc.alice.actor, move, [sc.bob.org, "chan-a3"])[0] == "ok"


def test_repeatable_read_cannot_write_a_claim_against_a_stale_snapshot(conn, sc):
    with conn.transaction(force_rollback=True):
        conn.execute("set transaction isolation level repeatable read")
        _become(conn, None)
        _channel(conn, "chan-bx", sc.bob.org)
        got = _call(conn, sc.bob.actor, STORE, ["chan-bx", TOKEN, meta("UCrr-free")])
        assert got[0] == "0A000" and got[2] == "youtube_channel_isolation", got
        # a write that claims nothing (a disconnect) is not checked, so it is not refused
        assert _call(conn, sc.bob.actor, REVOKE, [sc.bob.channel]) == ("ok", True)


# ── the race: two sessions, both begin, both try, one commits first ─────────────────────────────────────────────────

def _waiting_on_advisory(dsn):
    with psycopg.connect(dsn, autocommit=True) as c:
        return c.execute("select count(*) from pg_locks where locktype = 'advisory' and not granted").fetchone()[0]


def _race(conn, sc, yt, isolation):
    dsn = conn.info.dsn
    with as_superuser(conn) as s:
        s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values "
               "('chan-race-a', 'Race A', 't', 'PAUSED', %s), ('chan-race-b', 'Race B', 't', 'PAUSED', %s) returning 1",
               [sc.alice.org, sc.bob.org])
    first = second = None
    result = {}
    try:
        # Explicit BEGIN / COMMIT on autocommit connections: exactly the two transactions the test describes.
        first, second = psycopg.connect(dsn, autocommit=True), psycopg.connect(dsn, autocommit=True)
        for c, who in ((first, sc.alice.actor), (second, sc.bob.actor)):
            c.execute(f"begin isolation level {isolation}")
            c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            c.execute("set local role authenticated")
            c.execute("select count(*) from public.channels")       # both have begun, and both hold a snapshot
        first.execute(STORE, ["chan-race-a", TOKEN, meta(yt)])

        def go():
            try:
                second.execute(STORE, ["chan-race-b", TOKEN, meta(yt)])
                second.execute("commit")
                result["second"] = "ok"
            except psycopg.Error as e:
                result["second"] = (e.sqlstate, e.diag.message_primary, e.diag.message_hint)
                second.execute("rollback")

        t = threading.Thread(target=go)
        t.start()
        deadline = time.time() + 10
        while time.time() < deadline and _waiting_on_advisory(dsn) == 0 and t.is_alive():
            time.sleep(0.05)
        blocked = t.is_alive()
        first.execute("commit")
        t.join(30)
        assert not t.is_alive()
        with as_superuser(conn, commit=False) as s:
            holders = _holders(conn, yt)
        return blocked, result["second"], holders
    finally:
        for c in (first, second):
            if c is not None:
                c.close()
        with as_superuser(conn) as s:
            s.run("delete from vault.secrets where id in (select vault_secret_id from public.channel_token_refs "
                  "where channel_id in ('chan-race-a', 'chan-race-b'))")
            s.run("delete from public.channel_token_refs where channel_id in ('chan-race-a', 'chan-race-b')")
            s.run("delete from public.channels where channel_id in ('chan-race-a', 'chan-race-b')")


def test_two_concurrent_connects_from_two_organizations_end_with_exactly_one_winner(conn, sc):
    blocked, second, holders = _race(conn, sc, "UCrace1", "read committed")
    assert blocked, "the second connect must wait for the first at the YouTube id's lock"
    assert second[0] == "23P01" and second[2] == IN_USE and second[1].startswith("youtube_channel_in_use:"), second
    assert sc.alice.org not in second[1]
    assert {(h[0], h[1]) for h in holders} == {("chan-race-a", sc.alice.org)}, holders


def test_the_race_under_serializable_also_ends_with_one_winner(conn, sc):
    blocked, second, holders = _race(conn, sc, "UCrace2", "serializable")
    assert blocked
    # The second transaction's snapshot predates the first commit, so it cannot see it; SSI aborts it instead (40001), or the check does.
    assert second != "ok" and second[0] in ("40001", "23P01"), second
    assert {(h[0], h[1]) for h in holders} == {("chan-race-a", sc.alice.org)}, holders


# ── the file: duplicates, drift guard, rollback ────────────────────────────────────────────────────────────────────

def _catalogue(c):
    """Every public function body, grant, definer flag and search_path, and every trigger on the two tables."""
    procs = c.execute("select p.oid::regprocedure::text, md5(p.prosrc), coalesce(p.proacl::text, ''), p.prosecdef, "
                      "coalesce(p.proconfig::text, '') from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1").fetchall()
    trigs = c.execute("select tgrelid::regclass::text, tgname, pg_get_triggerdef(oid), tgenabled from pg_trigger "
                      "where tgrelid in ('public.channels'::regclass, 'public.channel_token_refs'::regclass) and not tgisinternal "
                      "order by 1, 2").fetchall()
    return procs, trigs


@pytest.fixture(scope="module")
def scratch():
    """A database with every file but 0141, two organizations, and ONE YouTube id connected in both (the live shape 0141 refuses)."""
    admin = sec_db.admin_dsn()
    if not admin:
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_ytuniq_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(dsn, [f for f in sec_db.build_sequence() if f.name != MIGRATION.name])
        with psycopg.connect(dsn, autocommit=True) as c:
            orgs = [str(c.execute("insert into public.organizations (name, slug) values (%s, %s) returning id", [n, n]).fetchone()[0])
                    for n in ("main-org", "test-org")]
            for cid, org in (("main-ch", orgs[0]), ("test-ch", orgs[1]), ("other-ch", orgs[1])):
                c.execute("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 't', 'PAUSED', %s)",
                          [cid, cid, org])
            for cid, yt in (("main-ch", "UCdup"), ("test-ch", "UCdup"), ("other-ch", "UCsolo")):
                c.execute("insert into public.channel_token_refs (channel_id, vault_secret_id, youtube_channel_id, connected_at) "
                          "values (%s, vault.create_secret(%s), %s, now())", [cid, f"tok-{cid}", yt])
        yield dsn, orgs
    finally:
        sec_db.drop_database(admin, name)


def test_the_file_refuses_live_duplicates_with_counts_only_and_applies_once_they_are_resolved(scratch):
    dsn, orgs = scratch
    with psycopg.connect(dsn, autocommit=True) as c:
        # the owner's read-only listing names each holder of the shared id (and nothing else)
        rows = c.execute(CHECK_SQL.read_text(encoding="utf-8")).fetchall()
        assert {(r[0], str(r[1]), r[3], r[4]) for r in rows} == {
            ("UCdup", orgs[0], "main-ch", "vault_token"), ("UCdup", orgs[0], "main-ch", "confirmed"),
            ("UCdup", orgs[1], "test-ch", "vault_token"), ("UCdup", orgs[1], "test-ch", "confirmed")}, rows
        assert {r[2] for r in rows} == {"main-org", "test-org"}
        before = _catalogue(c)
        with pytest.raises(psycopg.Error) as cm:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        msg = cm.value.diag.message_primary
        assert msg.startswith("0141 found 1 YouTube channel id(s) connected in more than one organization (2 channel rows)"), msg
        for leak in ("UCdup", "main-ch", "test-ch", orgs[0], orgs[1]):
            assert leak not in str(cm.value), leak
        assert _catalogue(c) == before, "a refused file leaves nothing behind"
        # the owner decides: the test organization's connection goes
        assert c.execute("select public.revoke_channel_token('test-ch')").fetchone()[0] is True
        assert c.execute(CHECK_SQL.read_text(encoding="utf-8")).fetchall() == []
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute("select to_regprocedure('public.youtube_channel_one_org_check(text, uuid, text[])') is not null").fetchone()[0]
        # replay: nothing changes
        after = _catalogue(c)
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _catalogue(c) == after


def test_the_drift_guard_refuses_a_reviewed_write_path_edited_by_hand(scratch):
    dsn, _ = scratch
    with psycopg.connect(dsn, autocommit=True) as c:
        for sig in ("public.store_channel_token(text, text, jsonb)", "public.channel_stamp_from_connection()",
                    "public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)"):
            with c.transaction(force_rollback=True):
                body = c.execute("select pg_get_functiondef(%s::regprocedure)", [sig]).fetchone()[0]
                c.execute(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
                with pytest.raises(psycopg.Error) as cm:
                    with c.transaction():
                        c.execute(MIGRATION.read_text(encoding="utf-8"))
                assert f"0141 found a {sig} that is not the reviewed body" in str(cm.value), str(cm.value)
        # and one of its own functions edited by hand
        with c.transaction(force_rollback=True):
            c.execute(body_of(ROLLBACK))
            c.execute("create function public.youtube_channel_one_org_check(p_youtube_id text, p_org uuid, p_channels text[]) "
                      "returns void language sql as $$ select $$")
            with pytest.raises(psycopg.Error) as cm:
                with c.transaction():
                    c.execute(MIGRATION.read_text(encoding="utf-8"))
            assert "0141 found a public.youtube_channel_one_org_check(text, uuid, text[]) that is not the reviewed body" in str(cm.value)


def test_the_rollback_restores_the_catalogue_and_the_old_behaviour_and_the_file_applies_again(scratch):
    dsn, orgs = scratch
    with psycopg.connect(dsn, autocommit=True) as c:
        with c.transaction(force_rollback=True):
            c.execute(body_of(ROLLBACK))
            pre = _catalogue(c)
        # The catalogue without 0141, compared on a fresh build of every other file (bodies, grants, definer, search_path, triggers).
        admin = sec_db.admin_dsn()
        name = f"ns_ytuniq_pre_{uuid.uuid4().hex[:8]}"
        fresh = sec_db.create_database(admin, name)
        try:
            sec_db.apply_files(fresh, [f for f in sec_db.build_sequence() if f.name != MIGRATION.name])
            with psycopg.connect(fresh, autocommit=True) as f:
                assert _catalogue(f) == pre, "the rollback leaves exactly the catalogue 0141 found"
        finally:
            sec_db.drop_database(admin, name)
        # The rollback file as the owner runs it (its own transaction), the old behaviour, then the refusal to re-apply over it.
        c.execute(ROLLBACK.read_text(encoding="utf-8"))
        assert c.execute("select to_regprocedure('public.youtube_channel_one_org_check(text, uuid, text[])') is null").fetchone()[0]
        c.execute("insert into public.channel_token_refs (channel_id, vault_secret_id, youtube_channel_id, connected_at) "
                  "values ('test-ch', vault.create_secret('again'), 'UCdup', now()) on conflict (channel_id) do update set "
                  "vault_secret_id = excluded.vault_secret_id, revoked_at = null, youtube_channel_id = excluded.youtube_channel_id")
        assert len({r[1] for r in c.execute(CHECK_SQL.read_text(encoding="utf-8")).fetchall()}) == 2, "pre-0141: two organizations"
        with pytest.raises(psycopg.Error):
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute("select public.revoke_channel_token('test-ch')")
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        # and the rollback refuses a body of its own edited by hand
        with c.transaction(force_rollback=True):
            body = c.execute("select pg_get_functiondef('public.channels_youtube_one_org()'::regprocedure)").fetchone()[0]
            c.execute(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
            with pytest.raises(psycopg.Error) as cm:
                with c.transaction():
                    c.execute(body_of(ROLLBACK))
            assert "rollback 0141 found a public.channels_youtube_one_org() that is not 0141's body" in str(cm.value)


def test_in_the_lab_the_rollback_brings_back_the_old_behaviour_and_the_pre_check_then_refuses_to_reapply(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        conn.execute(body_of(ROLLBACK))
        _channel(conn, "chan-bx", sc.bob.org)
        got = _call(conn, sc.bob.actor, STORE, ["chan-bx", TOKEN, meta("UCyta")])
        assert got[0] == "ok", "without 0141 a second organization connects it, as before"
        assert {h[1] for h in _holders(conn, "UCyta")} == {sc.alice.org, sc.bob.org}
        with pytest.raises(psycopg.Error) as cm:
            with conn.transaction():
                conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "0141 found 1 YouTube channel id(s) connected in more than one organization (2 channel rows)" in str(cm.value)


def test_the_end_state_grants_and_triggers(conn):
    with as_superuser(conn, commit=False) as s:
        for sig, definer in (("public.youtube_channel_one_org_check(text, uuid, text[])", False),
                             ("public.channel_token_refs_one_org()", True), ("public.channels_youtube_one_org()", True)):
            for role in ("anon", "authenticated", "service_role"):
                assert s.value("select has_function_privilege(%s, %s, 'execute')", [role, sig]) is False, (role, sig)
            assert s.value("select prosecdef from pg_proc where oid = %s::regprocedure", [sig]) is definer, sig
            assert s.value("select proconfig from pg_proc where oid = %s::regprocedure", [sig]) == ["search_path=public, pg_temp"]
        trig = dict(s.rows("select tgname, pg_get_triggerdef(oid) from pg_trigger where tgname in "
                           "('channel_token_refs_one_org', 'channels_youtube_one_org')"))
        assert trig == {
            "channel_token_refs_one_org": "CREATE TRIGGER channel_token_refs_one_org BEFORE INSERT OR UPDATE ON public.channel_token_refs "
                                          "FOR EACH ROW EXECUTE FUNCTION channel_token_refs_one_org()",
            "channels_youtube_one_org": "CREATE TRIGGER channels_youtube_one_org BEFORE INSERT OR UPDATE OF credential_ref, org_id ON "
                                        "public.channels FOR EACH ROW EXECUTE FUNCTION channels_youtube_one_org()"}
