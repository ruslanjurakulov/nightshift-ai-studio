"""Migration 0161 attacked in a real database: the collector keeps a ChatGPT client after its connection ended.

What would break, and the test that says so:

* ChatGPT's reconnect after a Disconnect or the 90-day cap being refused as an unknown app because the collector deleted
  the one client ChatGPT registered and reuses (OpenAI: "Keep the registered OAuth client ... valid while the MCP server
  connection is in use"): a ChatGPT client whose connection ended a day ago is still there, and the SAME client id signs in
  again, through the consent screen, to a working connection;
* the kept client being a way back in: its old tokens stay dead, and signing in again needs the person's Allow;
* the exception growing past ChatGPT: a Claude client, a registration with one non-ChatGPT URI, and a ChatGPT client nobody
  approved still go a day later, exactly as under 0147;
* the exception pinning rows (the loop 0147 closed): approve-redeem-revoke 50 times keeps at most 3 clients a person, the
  3 newest; after 30 days nothing is kept at all;
* the helper or the collector callable by an API role; the replay, the rollback (0147's body back, verbatim) and the drift
  guard not doing what the file says.

Runs in its own scratch database (it commits).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import uuid

import psycopg
import pytest

import sec_db

MIGRATION = sec_db.MIGRATIONS / "0161_mcp_chatgpt_client.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0161_mcp_chatgpt_client.sql"
RESOURCE = "https://nightshift-ai.studio/api/mcp"
CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect"
CHATGPT_ID = "https://chatgpt.com/connector/oauth/AbC_12-x"
CLAUDE = "https://claude.ai/api/mcp/auth_callback"
GC_0147 = "b5d0423a7df82812106021e05488d9ad"


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                claims = {"role": role}
                if uid:
                    claims.update(sub=uid, email=f"{uid[-6:]}@x.io")
                c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit()
                return rows
            except psycopg.Error:
                c.rollback()
                raise

    def anon(self, q, p=None):
        return self.act("anon", None, q, p)[0][0]

    def user(self, uid, q, p=None):
        return self.act("authenticated", uid, q, p)[0][0]

    def apply(self, path):
        """One file as one transaction; a rollback's own begin/commit lines are dropped."""
        text = "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
        with psycopg.connect(self.dsn, autocommit=True) as c:
            with c.transaction():
                c.execute(text)


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_mcp_chatgpt_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


# ── helpers ─────────────────────────────────────────────────────────────────

def signup(db) -> str:
    """A person with a Free workspace of their own, as the app makes it (0147: every plan may connect)."""
    uid = str(uuid.uuid4())
    db.su("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [uid, f"p-{uid[:8]}@example.test"])
    db.user(uid, "select public.create_organization(%s)", [f"W {uid[:8]}"])
    return uid


def pkce():
    verifier = secrets.token_urlsafe(48)
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


def register(db, uris, name="ChatGPT") -> str:
    r = db.anon("select public.oauth_register_client(%s, %s, %s)", [name, list(uris), f"203.0.113.{uuid.uuid4().hex[:10]}"])
    assert r["ok"], r
    return r["client_id"]


def sign_in(db, uid, cid, redirect):
    """The whole sign-in on an existing client: consent screen, Allow, code exchange. Returns the connection."""
    verifier, challenge = pkce()
    secret = secrets.token_urlsafe(32)
    begun = db.user(uid, "select public.oauth_begin_authorization(%s,%s,%s,'S256','st',null,%s,%s)",
                    [cid, redirect, challenge, RESOURCE, sha(secret)])
    assert begun["ok"], begun
    code = "code-" + secrets.token_urlsafe(32)
    dec = db.user(uid, "select public.oauth_decide_authorization(%s, true, 500::numeric, %s)", [sha(secret), sha(code)])
    assert dec["ok"] and dec["allowed"], dec
    at, rt = "at-" + secrets.token_urlsafe(32), "rt-" + secrets.token_urlsafe(32)
    ex = db.anon("select public.oauth_exchange_code(%s,%s,%s,%s,%s,%s,%s)", [sha(code), cid, redirect, verifier, RESOURCE, sha(at), sha(rt)])
    assert ex["ok"], ex
    grant = db.su("select grant_id::text from public.oauth_tokens where token_hash = %s", [sha(at)])[0][0]
    return {"at": at, "rt": rt, "client": cid, "grant": grant, "uid": uid}


def connect(db, uid, uris=(CHATGPT,)):
    cid = register(db, uris)
    return sign_in(db, uid, cid, uris[0])


def end(db, c):
    """The person presses Disconnect in Developers -> Connected apps."""
    assert db.user(c["uid"], "select public.oauth_revoke_grant(%s)", [c["grant"]]) is True


def age(db, hours, conns):
    """Move a connection and its client back in time, as if `hours` had passed since they were made."""
    grants = [c["grant"] for c in conns]
    clients = [c["client"] for c in conns]
    db.su("update public.oauth_grants set created_at = created_at - make_interval(hours => %s), "
          "activated_at = activated_at - make_interval(hours => %s), revoked_at = revoked_at - make_interval(hours => %s), "
          "absolute_expires_at = absolute_expires_at - make_interval(hours => %s) where id = any(%s::uuid[])",
          [hours, hours, hours, hours, grants])
    db.su("update public.oauth_clients set created_at = created_at - make_interval(hours => %s), "
          "last_authorized_at = last_authorized_at - make_interval(hours => %s) where client_id = any(%s::uuid[])",
          [hours, hours, clients])


def gc(db):
    db.su("select public.oauth_gc()")


def present(db, cid) -> bool:
    return db.su("select count(*) from public.oauth_clients where client_id = %s", [cid])[0][0] == 1


def calls(db, c) -> bool:
    return db.anon("select public.oauth_check(%s, null)", [sha(c["at"])])["ok"] is True


# ── the contract ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
def test_no_api_role_can_call_the_helper_or_the_collector(db, role):
    for fn in ("public.oauth_chatgpt_callbacks_only(text[])", "public.oauth_gc()"):
        assert db.su("select has_function_privilege(%s, %s, 'EXECUTE')", [role, fn])[0][0] is False, (role, fn)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.act(role, None, "select public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com/connector_platform_oauth_redirect'])")


@pytest.mark.parametrize("uris,want", [
    ([CHATGPT], True),
    ([CHATGPT, CHATGPT_ID], True),
    ([CLAUDE], False),
    ([CHATGPT, CLAUDE], False),
    ([CHATGPT + "/"], False),
    (["https://chatgpt.com.evil.example/connector_platform_oauth_redirect"], False),
    (["https://chatgpt.com/connector/oauth/a/b"], False),
    (["https://evil.example/cb"], False),
])
def test_only_chatgpts_own_callbacks_are_chatgpts(db, uris, want):
    assert db.su("select public.oauth_chatgpt_callbacks_only(%s)", [uris])[0][0] is want


# ── the fix ─────────────────────────────────────────────────────────────────

def test_chatgpt_signs_in_again_with_the_same_client_a_day_after_a_disconnect(db):
    uid = signup(db)
    first = connect(db, uid)
    end(db, first)
    age(db, 25, [first])
    gc(db)  # under 0147 this deleted the client: ChatGPT's next sign-in with it was "an unknown app"
    assert present(db, first["client"])
    assert not calls(db, first), "the disconnected connection's token stays dead"
    again = sign_in(db, uid, first["client"], CHATGPT)  # the consent screen and the person's Allow, as always
    assert again["client"] == first["client"] and again["grant"] != first["grant"]
    assert calls(db, again)


def test_chatgpt_signs_in_again_after_the_90_day_cap(db):
    uid = signup(db)
    c = connect(db, uid)
    # The connection reached its absolute expiry two days ago without being revoked.
    age(db, 24 * 92, [c])
    db.su("update public.oauth_grants set absolute_expires_at = now() - interval '2 days' where id = %s", [c["grant"]])
    gc(db)
    assert present(db, c["client"])
    assert sign_in(db, uid, c["client"], CHATGPT)["client"] == c["client"]


def test_a_kept_chatgpt_client_goes_30_days_after_its_connection_ended(db):
    uid = signup(db)
    c = connect(db, uid)
    end(db, c)
    age(db, 24 * 29, [c])
    gc(db)
    assert present(db, c["client"])
    age(db, 24 * 2, [c])  # 31 days: 0093 takes the ended grant, then the client that has none left
    gc(db)
    assert not present(db, c["client"])
    assert db.su("select count(*) from public.oauth_grants where id = %s", [c["grant"]])[0][0] == 0


def test_a_chatgpt_client_with_a_live_connection_is_untouched(db):
    uid = signup(db)
    live = connect(db, uid)
    age(db, 24 * 40, [live])
    db.su("update public.oauth_grants set absolute_expires_at = now() + interval '50 days' where id = %s", [live["grant"]])
    gc(db)
    assert present(db, live["client"]) and calls(db, live)


# ── the exception stays ChatGPT's, and small ───────────────────────────────

@pytest.mark.parametrize("uris", [(CLAUDE,), (CHATGPT, CLAUDE), ("https://app.example.com/cb",)])
def test_any_other_client_still_goes_a_day_after_its_connection_ended(db, uris):
    uid = signup(db)
    c = connect(db, uid, uris)
    end(db, c)
    age(db, 25, [c])
    gc(db)
    assert not present(db, c["client"])


def test_a_chatgpt_client_nobody_approved_still_goes_after_a_day(db):
    cid = register(db, [CHATGPT])
    db.su("update public.oauth_clients set created_at = now() - interval '25 hours' where client_id = %s", [cid])
    gc(db)
    assert not present(db, cid)


def test_a_person_keeps_at_most_three_ended_chatgpt_clients_the_newest(db):
    uid = signup(db)
    conns = []
    for hours_ago in (30, 40, 50, 60, 70):
        c = connect(db, uid)
        end(db, c)
        age(db, hours_ago, [c])
        conns.append(c)
    gc(db)
    kept = [present(db, c["client"]) for c in conns]
    assert kept == [True, True, True, False, False], kept


def test_approve_redeem_revoke_in_a_loop_pins_three_clients_not_fifty(db):
    # 0147's loop, with ChatGPT's callback: one free account, the daily cap of approvals, each one revoked at once.
    uid = signup(db)
    conns = []
    for i in range(50):
        c = connect(db, uid, (CHATGPT_ID if i % 2 else CHATGPT,))
        end(db, c)
        conns.append(c)
    age(db, 25, conns)
    for _ in range(3):  # each collection takes at most 200 clients; three runs settle this account's 50
        gc(db)
    left = db.su("select count(*) from public.oauth_clients where client_id = any(%s::uuid[])", [[c["client"] for c in conns]])[0][0]
    assert left == 3, left


def test_one_shared_client_is_kept_while_any_person_ranks_it(db):
    # A workspace plugin in ChatGPT: one client id, several people. The client stays while it is one of anyone's newest three.
    alice, bob = signup(db), signup(db)
    shared = connect(db, alice)
    second = sign_in(db, bob, shared["client"], CHATGPT)
    end(db, shared)
    end(db, second)
    age(db, 25, [shared, second])
    # Alice then used three other ChatGPT plugins, which pushes the shared one out of HER newest three; Bob still ranks it.
    for _ in range(3):
        c = connect(db, alice)
        end(db, c)
        age(db, 25, [c])
        db.su("update public.oauth_grants set revoked_at = now() - interval '2 hours' where id = %s", [c["grant"]])
    gc(db)
    assert present(db, shared["client"])


# ── replay, rollback, drift guard ───────────────────────────────────────────

def body_md5(db) -> str:
    return db.su("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = 'public.oauth_gc()'::regprocedure")[0][0]


def test_replaying_0161_changes_nothing(db):
    before = body_md5(db)
    db.apply(MIGRATION)
    db.apply(MIGRATION)
    assert body_md5(db) == before != GC_0147


def test_the_rollback_puts_0147s_collector_back_and_0161_applies_again(db):
    uid = signup(db)
    c = connect(db, uid)
    end(db, c)
    age(db, 25, [c])
    db.apply(ROLLBACK)
    try:
        assert body_md5(db) == GC_0147
        assert db.su("select to_regprocedure('public.oauth_chatgpt_callbacks_only(text[])') is null")[0][0] is True
        gc(db)
        assert not present(db, c["client"]), "0147's collector takes the ChatGPT client a day after it ended"
    finally:
        db.apply(MIGRATION)
    assert body_md5(db) != GC_0147


def test_the_rollback_and_the_drift_guard_refuse_a_stranger_body(db):
    real = db.su("select pg_get_functiondef('public.oauth_gc()'::regprocedure)")[0][0]
    db.su("create or replace function public.oauth_gc() returns void language plpgsql volatile security definer "
          "set search_path = public, pg_temp as $$ begin null; end $$")
    try:
        with pytest.raises(psycopg.Error, match="is not 0161's body"):
            db.apply(ROLLBACK)
        with pytest.raises(psycopg.Error, match="neither 0147's nor 0161's"):
            db.apply(MIGRATION)
    finally:
        db.su(real)
        db.su("revoke all on function public.oauth_gc() from public, anon, authenticated, service_role")
    db.apply(MIGRATION)
