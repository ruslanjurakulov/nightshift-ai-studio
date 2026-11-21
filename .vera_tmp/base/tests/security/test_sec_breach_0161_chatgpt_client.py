"""Breach on migration 0161 (the collector keeps a ChatGPT-only client 30 days after its last connection ended, 3 a person).

An attacker with a normal free account, an anonymous registrant and a holder of revoked tokens, each against the real
functions in a scratch database built from the migrations. What would break, and the test that says so:

* the 30-day exception reached by a registration that only LOOKS like ChatGPT's (case, a trailing slash, a query, a port,
  a subdomain, punycode, a dot segment, an id one character too long, a full-width letter, or one real ChatGPT callback next
  to a stranger's): every one that registration accepts is still taken a day after its connection ended, and every one it
  refuses never exists;
* a kept client being a way back in: the old code, the old refresh token and the old access token stay dead, replaying them
  after the person reconnected does not end the NEW connection, nobody but the person can finish their consent, and a
  stranger who signs in on the same kept client is bound to the stranger's own workspace, never to the person's;
* the cap of 3 a person failing across workspaces (the ranking is by person, not by workspace) or under collectors running
  at the same moment;
* a retained connection becoming visible or editable: it is not listed, its limit cannot be changed, and nobody else can
  revoke or touch it.

Runs in its own scratch database (it commits).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import uuid

import psycopg
import pytest

import sec_db

RESOURCE = "https://nightshift-ai.studio/api/mcp"
CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect"
CHATGPT_ID = "https://chatgpt.com/connector/oauth/AbC_12-x"
MIGRATION = sec_db.MIGRATIONS / "0161_mcp_chatgpt_client.sql"


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


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    if not MIGRATION.exists():
        pytest.skip("0161 is not on this branch")
    name = f"ns_breach_0161_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


# ── helpers (the same real path the app takes) ──────────────────────────────

def signup(db) -> str:
    uid = str(uuid.uuid4())
    db.su("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [uid, f"b-{uid[:8]}@example.test"])
    db.user(uid, "select public.create_organization(%s)", [f"B {uid[:8]}"])
    return uid


def org_of(db, uid) -> str:
    return db.su("select public.oauth_workspace(%s)::text", [uid])[0][0]


def pkce():
    verifier = secrets.token_urlsafe(48)
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


def try_register(db, uris, name="ChatGPT"):
    return db.anon("select public.oauth_register_client(%s, %s, %s)", [name, list(uris), f"198.51.100.{uuid.uuid4().hex[:10]}"])


def register(db, uris, name="ChatGPT") -> str:
    r = try_register(db, uris, name)
    assert r["ok"], r
    return r["client_id"]


def begin(db, uid, cid, redirect):
    verifier, challenge = pkce()
    secret = secrets.token_urlsafe(32)
    begun = db.user(uid, "select public.oauth_begin_authorization(%s,%s,%s,'S256','st',null,%s,%s)",
                    [cid, redirect, challenge, RESOURCE, sha(secret)])
    assert begun["ok"], begun
    return verifier, secret


def sign_in(db, uid, cid, redirect):
    verifier, secret = begin(db, uid, cid, redirect)
    code = "code-" + secrets.token_urlsafe(32)
    dec = db.user(uid, "select public.oauth_decide_authorization(%s, true, 500::numeric, %s)", [sha(secret), sha(code)])
    assert dec["ok"] and dec["allowed"], dec
    at, rt = "at-" + secrets.token_urlsafe(32), "rt-" + secrets.token_urlsafe(32)
    ex = db.anon("select public.oauth_exchange_code(%s,%s,%s,%s,%s,%s,%s)", [sha(code), cid, redirect, verifier, RESOURCE, sha(at), sha(rt)])
    assert ex["ok"], ex
    grant = db.su("select grant_id::text from public.oauth_tokens where token_hash = %s", [sha(at)])[0][0]
    return {"at": at, "rt": rt, "code": code, "verifier": verifier, "client": cid, "grant": grant, "uid": uid, "redirect": redirect}


def end(db, c):
    assert db.user(c["uid"], "select public.oauth_revoke_grant(%s)", [c["grant"]]) is True


def age(db, hours, conns):
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


def calls(db, at) -> bool:
    return db.anon("select public.oauth_check(%s, null)", [sha(at)])["ok"] is True


def refresh(db, c, rt):
    nat, nrt = "at-" + secrets.token_urlsafe(32), "rt-" + secrets.token_urlsafe(32)
    r = db.anon("select public.oauth_refresh(%s,%s,%s,%s,%s)", [sha(rt), c["client"], RESOURCE, sha(nat), sha(nrt)])
    return r, nat, nrt


# ── 1. Lookalike callbacks: registration takes them, the collector does not keep them ──

ACCEPTED_LOOKALIKES = [
    [CHATGPT + "/"],
    [CHATGPT + "?x=1"],
    [CHATGPT + "?"],
    ["https://chatgpt.com:443/connector_platform_oauth_redirect"],
    ["https://www.chatgpt.com/connector_platform_oauth_redirect"],
    ["https://xn--chatgpt-7ya.com/connector_platform_oauth_redirect"],
    ["https://chatgpt.com.evil.example/connector_platform_oauth_redirect"],
    ["https://chatgpt.com/connector/oauth/../../evil"],
    ["https://chatgpt.com/connector/oauth/%2e%2e"],
    ["https://chatgpt.com/connector/oauth/abc/"],
    ["https://chatgpt.com/connector/oauth/abc?x"],
    ["https://chatgpt.com/connector/oauth/" + "a" * 65],
    ["https://chatgpt.com/connector/oauth/Ａ"],  # a full-width A
    ["https://chatgpt.com/connector/oauthX/a"],
    ["https://chatgpt.com/connector_platform_oauth_redirect​"],  # a zero-width space after the path
    [CHATGPT, "https://evil.example/cb"],
    [CHATGPT_ID, "https://chatgpt.com/connector/oauth/a/b"],
    [CHATGPT, "https://claude.ai/api/mcp/auth_callback"],
]

REFUSED_LOOKALIKES = [
    ["https://ChatGPT.com/connector_platform_oauth_redirect"],
    ["http://chatgpt.com/connector_platform_oauth_redirect"],
    [CHATGPT + "#f"],
    ["https://u@chatgpt.com/connector_platform_oauth_redirect"],
    ["https://chatgpt.com@evil.example/connector_platform_oauth_redirect"],
    ["https://chatgpt.com./connector_platform_oauth_redirect"],
    ["https://chatgpt.com/connector/oauth/abc\n"],
    ["https://chatgpt​.com/connector_platform_oauth_redirect"],
]


@pytest.mark.parametrize("uris", ACCEPTED_LOOKALIKES, ids=lambda u: repr(u)[:70])
def test_a_registration_that_only_looks_like_chatgpt_still_goes_a_day_after_its_connection_ended(db, uris):
    uid = signup(db)
    c = sign_in(db, uid, register(db, uris), uris[0])
    end(db, c)
    age(db, 25, [c])
    gc(db)
    assert not present(db, c["client"]), f"{uris} got ChatGPT's 30-day retention"


@pytest.mark.parametrize("uris", REFUSED_LOOKALIKES, ids=lambda u: repr(u)[:70])
def test_a_lookalike_registration_cannot_reach_chatgpts_class_at_all(db, uris):
    r = try_register(db, uris)
    assert r["ok"] is False and r["error"] == "invalid_redirect_uri", r
    assert db.su("select public.oauth_chatgpt_callbacks_only(%s)", [uris])[0][0] is False


def test_no_code_point_outside_ascii_matches_the_callback_id(db):
    # A collation or case-folding surprise (Kelvin sign, long s, dotless i, full-width letters) would widen the class.
    n = db.su("select count(*) from generate_series(128, 70000) i where i not between 55296 and 57343 "
              "and public.oauth_chatgpt_callbacks_only(array['https://chatgpt.com/connector/oauth/' || chr(i)])")[0][0]
    assert n == 0


# ── 2. A kept client is not a way back in ───────────────────────────────────

def test_a_kept_clients_old_code_refresh_and_access_token_stay_dead_and_replaying_them_spares_the_new_connection(db):
    alice = signup(db)
    old = sign_in(db, alice, register(db, [CHATGPT]), CHATGPT)
    # One rotation, so there is a spent refresh token to replay as well as the live one.
    r, _, live_rt = refresh(db, old, old["rt"])
    assert r["ok"], r
    end(db, old)
    age(db, 25, [old])
    gc(db)
    assert present(db, old["client"])

    new = sign_in(db, alice, old["client"], CHATGPT)
    assert new["grant"] != old["grant"] and calls(db, new["at"])

    # The old access token, the old live refresh token, the spent one, and the old code all fail.
    assert not calls(db, old["at"])
    for rt in (live_rt, old["rt"]):
        r, nat, _ = refresh(db, old, rt)
        assert r == {"ok": False, "error": "invalid_grant"}, r
        assert not calls(db, nat)
    nat, nrt = "at-" + secrets.token_urlsafe(32), "rt-" + secrets.token_urlsafe(32)
    ex = db.anon("select public.oauth_exchange_code(%s,%s,%s,%s,%s,%s,%s)",
                 [sha(old["code"]), old["client"], CHATGPT, old["verifier"], RESOURCE, sha(nat), sha(nrt)])
    assert ex["ok"] is False
    assert not calls(db, nat)

    # Reuse detection fired on the OLD connection only: the person's new connection still works and still refreshes.
    assert calls(db, new["at"])
    r, nat, _ = refresh(db, new, new["rt"])
    assert r["ok"], r
    assert calls(db, nat)


def test_nobody_but_the_person_can_finish_their_consent_on_a_kept_client(db):
    alice, mallory = signup(db), signup(db)
    old = sign_in(db, alice, register(db, [CHATGPT]), CHATGPT)
    end(db, old)
    age(db, 25, [old])
    gc(db)
    _, secret = begin(db, alice, old["client"], CHATGPT)
    code = "code-" + secrets.token_urlsafe(32)
    stolen = db.user(mallory, "select public.oauth_decide_authorization(%s, true, 500::numeric, %s)", [sha(secret), sha(code)])
    assert stolen == {"ok": False, "error": "expired"}, stolen
    assert db.su("select count(*) from public.oauth_codes where code_hash = %s", [sha(code)])[0][0] == 0
    # Without an Allow nothing is issued: a refusal on a kept client makes no connection.
    denied = db.user(alice, "select public.oauth_decide_authorization(%s, false, 500::numeric, %s)", [sha(secret), sha(code)])
    assert denied["ok"] and denied["allowed"] is False
    assert db.su("select count(*) from public.oauth_grants where client_id = %s and revoked_at is null", [old["client"]])[0][0] == 0


def test_a_stranger_signing_in_on_someone_elses_kept_client_is_bound_to_their_own_workspace(db):
    alice, mallory = signup(db), signup(db)
    old = sign_in(db, alice, register(db, [CHATGPT]), CHATGPT)
    end(db, old)
    age(db, 25, [old])
    gc(db)
    theirs = sign_in(db, mallory, old["client"], CHATGPT)
    row = db.su("select user_id::text, org_id::text from public.oauth_grants where id = %s", [theirs["grant"]])[0]
    assert row == (mallory, org_of(db, mallory))
    assert org_of(db, alice) != org_of(db, mallory)
    # Alice's ended connection is not revived by it, and Mallory cannot touch it.
    assert not calls(db, old["at"])
    assert db.user(mallory, "select public.oauth_revoke_grant(%s)", [old["grant"]]) is False
    assert db.user(mallory, "select public.oauth_set_grant_limit(%s, 0)", [old["grant"]]) is False
    assert db.su("select revoked_reason from public.oauth_grants where id = %s", [old["grant"]])[0][0] == "user"


def test_a_retained_connection_is_not_listed_and_cannot_be_edited_by_its_own_person(db):
    alice = signup(db)
    old = sign_in(db, alice, register(db, [CHATGPT]), CHATGPT)
    end(db, old)
    age(db, 25, [old])
    gc(db)
    assert present(db, old["client"])
    listed = db.user(alice, "select public.oauth_my_grants()")
    assert all(g["id"] != old["grant"] for g in listed), listed
    assert db.user(alice, "select public.oauth_set_grant_limit(%s, 20000)", [old["grant"]]) is False
    for role in ("anon", "authenticated"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, alice if role == "authenticated" else None, "select client_id from public.oauth_clients limit 1")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, alice if role == "authenticated" else None, "select id from public.oauth_grants limit 1")


# ── 3. The cap of 3: by person, across workspaces, and under concurrent collectors ──

def test_the_cap_of_three_is_per_person_not_per_workspace(db):
    # Grants are ranked by person. A person owning a second workspace (or moved between workspaces) gets no extra three.
    uid = signup(db)
    org2 = str(uuid.uuid4())
    db.su("insert into public.organizations (id, name, slug) values (%s, 'Second', %s)", [org2, f"second-{org2[:8]}"])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'b@x.io', 'owner')", [org2, uid])
    conns = []
    for i in range(6):
        c = sign_in(db, uid, register(db, [CHATGPT]), CHATGPT)
        if i % 2:
            db.su("update public.oauth_grants set org_id = %s where id = %s", [org2, c["grant"]])
        end(db, c)
        age(db, 30 + i, [c])
        conns.append(c)
    gc(db)
    assert [present(db, c["client"]) for c in conns] == [True, True, True, False, False, False]


def test_concurrent_collectors_still_keep_exactly_the_newest_three(db):
    uid = signup(db)
    conns = []
    for i in range(8):
        c = sign_in(db, uid, register(db, [CHATGPT_ID if i % 2 else CHATGPT]), CHATGPT_ID if i % 2 else CHATGPT)
        end(db, c)
        age(db, 30 + i, [c])
        conns.append(c)
    errors = []
    start = threading.Barrier(6)

    def run():
        try:
            with psycopg.connect(db.dsn, autocommit=True) as c:
                start.wait()
                c.execute("select public.oauth_gc()")
        except Exception as e:  # noqa: BLE001 - every collector must finish; the test reports what did not
            errors.append(repr(e))

    threads = [threading.Thread(target=run) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert errors == []
    assert [present(db, c["client"]) for c in conns] == [True] * 3 + [False] * 5


def test_a_reconnect_racing_the_collector_never_loses_the_client_it_is_signing_in_on(db):
    # The person is on the consent screen for their 4th-newest ChatGPT client (out of the kept three) while a collector runs.
    uid = signup(db)
    conns = []
    for i in range(4):
        c = sign_in(db, uid, register(db, [CHATGPT]), CHATGPT)
        end(db, c)
        age(db, 30 + i, [c])
        conns.append(c)
    verifier, secret = begin(db, uid, conns[3]["client"], CHATGPT)
    gc(db)
    assert present(db, conns[3]["client"]), "a pending consent keeps its client (0147), kept or not"
    code = "code-" + secrets.token_urlsafe(32)
    dec = db.user(uid, "select public.oauth_decide_authorization(%s, true, 500::numeric, %s)", [sha(secret), sha(code)])
    assert dec["ok"] and dec["allowed"], dec
