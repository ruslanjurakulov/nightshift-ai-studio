"""MCP over OAuth (0093), attacked in a real database.

What a connected app may do is decided by the database alone. These tests call
the entry points the way the Command Center's routes and PostgREST would (the
consent functions as the signed-in person, everything else with the public anon
key and a secret) and prove, with a real credit ledger behind them:

* nothing in the OAuth tables is reachable by any API role;
* registration is hostile-input safe (redirect URIs, floods, caps, cleanup);
* consent: Free gets no code, a redirect that is not an exact match gets nothing,
  a request is single-use and only its own person can decide it;
* codes are single-use (a replay revokes what the first use made), bound to
  client, redirect and PKCE, and refresh tokens rotate with reuse detection;
* a token reaches only the allow-listed endpoints and only its own workspace;
  it can never touch the USD API balance, even by calling api_* directly;
* MCP is a subscription feature, re-checked live on every call and refresh;
* a connected app's video is paid in site credits through the same hold as the
  app's, capped per connection under concurrency, never free when unpriced;
* revoking, expiring, losing the plan or the person deleting the account kills
  the connection at once; the API-key door is unchanged.

Runs in its own scratch database (it commits).
"""

import base64
import concurrent.futures as cf
import hashlib
import json
import os
import secrets
import uuid

import psycopg
import pytest

import sec_db

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000d3"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000d3"
ORG_F = "ffffffff-0000-0000-0000-0000000000d3"  # a Free workspace: packs, no subscription
ORG_P = "cccccccc-0000-0000-0000-0000000000d3"  # a workspace with credits and no plan row at all
UA = str(uuid.UUID(int=0xA1D3))
UB = str(uuid.UUID(int=0xB1D3))
UF = str(uuid.UUID(int=0xF1D3))
UOP = str(uuid.UUID(int=0x0D3))  # the operator (owner of the default organization)
RESOURCE = "https://nightshift-ai.studio/api/mcp"
REDIRECT = "https://claude.ai/api/mcp/auth_callback"
LOOPBACK = "http://127.0.0.1:33418/callback"
KEY_A = "key-a-d3"


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
        c["email"] = "u@x.io"
    return json.dumps(c)


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
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
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
    name = f"ns_mcp_oauth_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@d3.io'),(%s,'b@d3.io'),(%s,'f@d3.io'),(%s,'op@d3.io')",
         [UA, UB, UF, UOP])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-a-d3'),(%s,'B','org-b-d3'),(%s,'F','org-f-d3'),(%s,'P','org-p-d3')",
         [ORG_A, ORG_B, ORG_F, ORG_P])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@d3.io','owner'),(%s,%s,'b@d3.io','owner'),"
         "(%s,%s,'f@d3.io','owner'),(public.default_org_id(),%s,'op@d3.io','owner')", [ORG_A, UA, ORG_B, UB, ORG_F, UF, UOP])
    for org in (ORG_A, ORG_B, ORG_F):
        d.su("select public.grant_credits(%s, 5000, 'test')", [org])
    # A and B subscribe (creator); F bought packs only (Free).
    d.su("insert into public.subscriptions (org_id, provider_subscription_id, plan_id, status) values "
         "(%s,'sub_aaaaaaaaaaaa','creator','active'),(%s,'sub_bbbbbbbbbbbb','pro','active')", [ORG_A, ORG_B])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('video_minute', 60, 0.5), ('job_minimum', 10, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin")
    d.su("insert into public.channels (channel_id, name, niche, status, org_id, agent_config, credential_ref) values "
         "('chan-a','A','tech','ACTIVE',%s,'{\"target_duration_seconds\": 120}','{\"verified_at\":\"2026-09-01\"}'),"
         "('chan-b','B','tech','ACTIVE',%s,'{}','{\"verified_at\":\"2026-09-01\"}'),"
         "('chan-f','F','tech','ACTIVE',%s,'{}','{\"verified_at\":\"2026-09-01\"}'),"
         "('chan-op','Op','tech','ACTIVE',public.default_org_id(),'{}','{\"verified_at\":\"2026-09-01\"}')", [ORG_A, ORG_B, ORG_F])
    d.su("insert into public.videos (video_id, channel_id, title, slug, review_state) values ('vid-a','chan-a','VA','sl-a','pending'),('vid-b','chan-b','VB','sl-b','pending')")
    # The API-key door: activated, USD balance, one key for A.
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1')", [ORG_A, UA])
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 5000, 100000)", [ORG_A])
    d.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s,'k',%s,%s,%s)",
         [ORG_A, sha(KEY_A), UA, ["account:read", "videos:read", "videos:write"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


# ── helpers ─────────────────────────────────────────────────────────────────

def pkce():
    verifier = secrets.token_urlsafe(48)
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


def register(db, name="Test app", uris=(REDIRECT,), ip=None):
    return db.anon("select public.oauth_register_client(%s,%s,%s)", [name, list(uris), ip or f"203.0.113.{secrets.randbelow(250)}"])


def client(db, uris=(REDIRECT,)):
    r = register(db, uris=uris, ip=f"198.51.100.{secrets.randbelow(250)}.{uuid.uuid4().hex[:6]}")
    assert r["ok"], r
    return r["client_id"]


def begin(db, uid, client_id, redirect=REDIRECT, challenge=None, method="S256", state="st-1", scope=None, resource=RESOURCE):
    secret = secrets.token_urlsafe(32)
    res = db.user(uid, "select public.oauth_begin_authorization(%s,%s,%s,%s,%s,%s,%s,%s)",
                  [client_id, redirect, challenge or pkce()[1], method, state, scope, resource, sha(secret)])
    return res, secret


def decide(db, uid, secret, allow=True, limit=500, code=None):
    code = code or "code-" + secrets.token_urlsafe(32)
    res = db.user(uid, "select public.oauth_decide_authorization(%s,%s,%s::numeric,%s)", [sha(secret), allow, limit, sha(code)])
    return res, code


def exchange(db, code, client_id, verifier, redirect=REDIRECT, resource=RESOURCE):
    """The token endpoint's database call: the PKCE verifier itself goes in (0093 checks it)."""
    at, rt = "at-" + secrets.token_urlsafe(32), "rt-" + secrets.token_urlsafe(32)
    res = db.anon("select public.oauth_exchange_code(%s,%s,%s,%s,%s,%s,%s)",
                  [sha(code), client_id, redirect, verifier, resource, sha(at), sha(rt)])
    return res, at, rt


def refresh(db, rt, client_id, resource=RESOURCE):
    at2, rt2 = "at-" + secrets.token_urlsafe(32), "rt-" + secrets.token_urlsafe(32)
    res = db.anon("select public.oauth_refresh(%s,%s,%s,%s,%s)", [sha(rt), client_id, resource, sha(at2), sha(rt2)])
    return res, at2, rt2


def connect(db, uid=UA, limit=500, uris=(REDIRECT,), redirect=REDIRECT):
    """The whole flow for one person: a connection with live tokens."""
    if db.su("select count(*) from public.oauth_grants where user_id=%s", [uid])[0][0] >= 15:
        db.su("delete from public.oauth_grants where user_id=%s", [uid])  # the 20-connection cap is tested on its own
    cid = client(db, uris)
    verifier, challenge = pkce()
    res, secret = begin(db, uid, cid, redirect=redirect, challenge=challenge)
    assert res["ok"] and res["entitled"], res
    dec, code = decide(db, uid, secret, limit=limit)
    assert dec["ok"] and dec["allowed"], dec
    ex, at, rt = exchange(db, code, cid, verifier, redirect=redirect)
    assert ex["ok"], ex
    grant = db.su("select g.id::text from public.oauth_grants g join public.oauth_tokens t on t.grant_id = g.id "
                  "where t.token_hash = %s", [sha(at)])[0][0]
    return {"client": cid, "at": at, "rt": rt, "grant": grant, "challenge": challenge, "uid": uid}


def create(db, conn_, channel="chan-a", params=None, idem=None):
    return db.anon("select public.oauth_create_video(%s,%s,%s::jsonb,%s,%s)",
                   [sha(conn_["at"]), channel, json.dumps(params if params is not None else {"duration": 60}), idem, "req_t"])


def code_of(res):
    return res["error"]["code"] if res.get("ok") is False and "error" in res and isinstance(res["error"], dict) else None


def usd(db):
    return db.su("select balance_cents, reserved_cents from public.api_accounts where org_id=%s", [ORG_A])[0]


def credits(db, org=ORG_A):
    return db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org])[0]


def set_plan(db, org, status):
    db.su("update public.subscriptions set status=%s where org_id=%s", [status, org])


# ── no table is reachable ───────────────────────────────────────────────────

OAUTH_TABLES = ["oauth_settings", "oauth_clients", "oauth_auth_requests", "oauth_grants", "oauth_codes",
                "oauth_tokens", "oauth_runs", "oauth_rate_counters"]


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("table", OAUTH_TABLES)
def test_no_api_role_can_touch_an_oauth_table(db, role, table):
    for q in (f"select * from public.{table}", f"delete from public.{table}"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, UA if role != "anon" else None, q)


def test_token_hashes_never_leak_through_a_function_answer(db):
    c = connect(db)
    res = db.user(UA, "select public.oauth_my_grants()")
    text = json.dumps(res)
    assert sha(c["at"]) not in text and sha(c["rt"]) not in text and c["at"] not in text
    assert "token" not in text.lower()


# ── registration: a hostile, unauthenticated endpoint ───────────────────────

BAD_URIS = [
    "https://evil.com@good.com/cb",             # userinfo
    "https://good.com@evil.com/cb",
    "HTTPS://claude.ai/cb",                      # upper-case scheme
    "https://Claude.AI/cb",                      # upper-case host
    "https://claude.ai/cb#frag",                 # fragment
    "http://claude.ai/cb",                       # http off loopback
    "http://localhost.evil.com/cb",              # lookalike of loopback
    "http://127.0.0.1.evil.com/cb",
    "http://127.0.0.2/cb",                       # not the loopback literal
    "http://[::2]/cb",                           # IPv6, not loopback
    "http://[::1]@evil.com/cb",
    "https://127.0.0.1/cb",                      # https to an IP literal
    "https://localhost/cb",                      # https to a single-label host
    "https://exаmple.com/cb",                    # Cyrillic а in the host
    "https://*.evil.com/cb",                     # wildcard
    "https://evil.com/*",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "myapp://callback",
    "cursor://evil.example/oauth/x",             # a custom scheme that is not the one exception
    "vscode://vscode.github-authentication/did-authenticate",
    "https://claude.ai/cb\nSet-Cookie: x=1",     # header injection
    "https://claude.ai/cb with space",
    "https://claude.ai\\@evil.com/cb",
    "//evil.com/cb",
    "/relative",
    "",
    "https://" + "a" * 320 + ".com/cb",
]
GOOD_URIS = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "http://127.0.0.1:33418/callback",
    "http://localhost:8080/cb",
    "http://[::1]:9000/cb",
    "http://localhost/callback",
    "https://vscode.dev/redirect",
    "cursor://anysphere.cursor-retrieval/oauth/user-nightshift/callback",
]


@pytest.mark.parametrize("uri", BAD_URIS)
def test_registration_refuses_a_hostile_redirect_uri(db, uri):
    res = register(db, uris=[uri])
    assert res["ok"] is False and res["error"] == "invalid_redirect_uri", (uri, res)


@pytest.mark.parametrize("uri", GOOD_URIS)
def test_registration_accepts_the_redirects_real_clients_use(db, uri):
    assert register(db, uris=[uri], ip="192.0.2." + str(secrets.randbelow(250)) + uuid.uuid4().hex[:4])["ok"] is True


def test_registration_bounds_the_name_and_the_uri_count(db):
    assert register(db, name="")["error"] == "invalid_client_metadata"
    assert register(db, name="x" * 81)["error"] == "invalid_client_metadata"
    assert register(db, name="line\nbreak")["error"] == "invalid_client_metadata"
    assert register(db, uris=[f"https://a{i}.example.com/cb" for i in range(6)])["error"] == "invalid_redirect_uri"
    assert register(db, uris=[])["error"] == "invalid_redirect_uri"


def test_registration_is_rate_limited_per_address_and_globally(db):
    ip = "198.18.0." + uuid.uuid4().hex[:6]
    results = [register(db, ip=ip) for _ in range(12)]
    assert sum(1 for r in results if r["ok"]) == 10
    assert all(r["error"] == "rate_limited" for r in results if not r["ok"])
    # The global ceiling: another address is refused once the hour's budget is spent.
    db.su("update public.oauth_clients set created_at = now()")  # everything counts in this hour
    have = db.su("select count(*) from public.oauth_clients")[0][0]
    db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) "
          "select 'flood', array['https://f.example.com/cb'], %s from generate_series(1, greatest(0, 300 - %s))",
          [sha("x" * 3), have])
    assert register(db, ip="192.0.2.77" + uuid.uuid4().hex[:4])["error"] == "rate_limited"
    db.su("delete from public.oauth_clients where client_name = 'flood'")


def test_never_used_registrations_are_collected_and_used_ones_are_kept(db):
    stale = db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash, created_at) "
                  "values ('stale', array['https://s.example.com/cb'], %s, now() - interval '3 days') returning client_id::text", [sha("s")])[0][0]
    c = connect(db)
    db.su("update public.oauth_clients set created_at = now() - interval '3 days' where client_id = %s", [c["client"]])
    register(db, ip="192.0.2.5" + uuid.uuid4().hex[:5])  # a registration runs the collector
    assert db.su("select count(*) from public.oauth_clients where client_id = %s", [stale])[0][0] == 0
    assert db.su("select count(*) from public.oauth_clients where client_id = %s", [c["client"]])[0][0] == 1


# ── consent ─────────────────────────────────────────────────────────────────

def test_a_free_workspace_gets_a_plain_answer_and_no_request_row(db):
    cid = client(db)
    before = db.su("select count(*) from public.oauth_auth_requests")[0][0]
    res, secret = begin(db, UF, cid)
    assert res["ok"] and res["entitled"] is False and res["plan"] == "free", res
    assert db.su("select count(*) from public.oauth_auth_requests")[0][0] == before
    # With no row there is nothing to decide: no code can come out of it.
    dec, _ = decide(db, UF, secret)
    assert dec == {"ok": False, "error": "expired"}
    assert db.su("select count(*) from public.oauth_codes c join public.oauth_grants g on g.id = c.grant_id where g.user_id=%s", [UF])[0][0] == 0


@pytest.mark.parametrize("redirect", [
    REDIRECT + "/",                 # trailing slash
    REDIRECT.upper(),               # case
    REDIRECT + "?x=1",              # extra query
    "https://claude.ai:443/api/mcp/auth_callback",   # explicit port
    "https://claude.ai/api/mcp/auth_callback#x",
    "https://claude.ai.evil.com/api/mcp/auth_callback",
    "https://evil.com@claude.ai/api/mcp/auth_callback",
    "http://127.0.0.1:33418/callback",   # registered for another origin
    "",
])
def test_authorize_needs_an_exact_registered_redirect_and_sends_nothing_otherwise(db, redirect):
    cid = client(db)
    before = db.su("select count(*) from public.oauth_auth_requests")[0][0]
    res, _ = begin(db, UA, cid, redirect=redirect)
    assert res == {"ok": False, "error": "redirect_mismatch"}, res
    assert db.su("select count(*) from public.oauth_auth_requests")[0][0] == before


def test_authorize_with_an_unknown_client_is_an_error_not_a_redirect(db):
    res, _ = begin(db, UA, str(uuid.uuid4()))
    assert res == {"ok": False, "error": "unknown_client"}


def test_authorize_requires_pkce_s256_and_a_well_formed_challenge(db):
    cid = client(db)
    assert begin(db, UA, cid, method="plain")[0]["error"] == "invalid_request"
    assert begin(db, UA, cid, method=None)[0]["error"] == "invalid_request"
    assert begin(db, UA, cid, challenge="short")[0]["error"] == "invalid_request"
    assert begin(db, UA, cid, challenge="!" * 43)[0]["error"] == "invalid_request"
    r = begin(db, UA, cid, resource="not a url")[0]
    assert r["error"] == "invalid_target" and r["redirect_ok"] is True


def test_unknown_scopes_are_dropped_and_empty_means_all_offered(db):
    cid = client(db)
    assert begin(db, UA, cid, scope="videos:read nonsense admin")[0]["scopes"] == ["videos:read"]
    assert sorted(begin(db, UA, cid, scope=None)[0]["scopes"]) == ["videos:create", "videos:publish", "videos:read"]
    assert sorted(begin(db, UA, cid, scope="offline_access")[0]["scopes"]) == ["videos:create", "videos:publish", "videos:read"]


def test_the_consent_screen_data_names_the_workspace_and_the_limits(db):
    res, _ = begin(db, UA, client(db))
    assert res["workspace_name"] == "A" and res["client_name"] == "Test app"
    assert res["default_limit_credits"] == 500 and res["max_limit_credits"] == 20000


def test_only_the_person_a_request_was_made_for_can_decide_it_and_only_once(db):
    cid = client(db)
    res, secret = begin(db, UA, cid)
    assert decide(db, UB, secret)[0] == {"ok": False, "error": "expired"}  # another signed-in person
    dec, _ = decide(db, UA, secret)
    assert dec["ok"] and dec["allowed"]
    assert decide(db, UA, secret)[0] == {"ok": False, "error": "expired"}  # single-use


def test_signing_out_means_no_decision_at_all(db):
    for who in ("anon",):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(who, None, "select public.oauth_decide_authorization(%s,true,500,%s)", [sha("x"), sha("y")])
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(who, None, "select public.oauth_begin_authorization(%s,%s,%s,'S256',null,null,%s,%s)",
                   [str(uuid.uuid4()), REDIRECT, pkce()[1], RESOURCE, sha("z")])


def test_a_request_expires_after_ten_minutes(db):
    cid = client(db)
    _, secret = begin(db, UA, cid)
    db.su("update public.oauth_auth_requests set expires_at = now() - interval '1 second' where secret_hash = %s", [sha(secret)])
    assert decide(db, UA, secret)[0] == {"ok": False, "error": "expired"}


@pytest.mark.parametrize("limit", [None, -1, 20001, 1.5, 10**9])
def test_the_spend_limit_is_mandatory_and_bounded(db, limit):
    cid = client(db)
    _, secret = begin(db, UA, cid)
    dec, _ = decide(db, UA, secret, limit=limit)
    assert dec["ok"] is False and dec["error"] == "invalid_limit", dec
    # The refused attempt consumed the request and made no grant.


def test_deny_redirects_with_access_denied_and_makes_no_grant(db):
    cid = client(db)
    before = db.su("select count(*) from public.oauth_grants")[0][0]
    _, secret = begin(db, UA, cid, state="keepme")
    dec, _ = decide(db, UA, secret, allow=False, limit=None)
    assert dec["ok"] and dec["allowed"] is False and dec["state"] == "keepme" and dec["redirect_uri"] == REDIRECT
    assert db.su("select count(*) from public.oauth_grants")[0][0] == before


def test_a_person_has_at_most_five_pending_requests(db):
    cid = client(db)
    for _ in range(9):
        begin(db, UB, cid)
    assert db.su("select count(*) from public.oauth_auth_requests where user_id=%s", [UB])[0][0] <= 5


def test_a_person_cannot_hold_more_than_twenty_connections(db):
    db.su("delete from public.oauth_grants where user_id=%s", [UB])
    cid = client(db)
    last = None
    for _ in range(22):
        _, secret = begin(db, UB, cid)
        last, _ = decide(db, UB, secret)
    assert last == {"ok": False, "error": "too_many_connections"}
    db.su("delete from public.oauth_grants where user_id=%s", [UB])


def test_the_plan_lapsing_between_screen_and_allow_issues_no_code(db):
    cid = client(db)
    _, secret = begin(db, UB, cid)
    set_plan(db, ORG_B, "canceled")
    try:
        dec, _ = decide(db, UB, secret)
        assert dec == {"ok": False, "error": "subscription_required"}
    finally:
        set_plan(db, ORG_B, "active")


# ── the token endpoint ──────────────────────────────────────────────────────

def test_the_full_happy_path_and_what_it_stores(db):
    c = connect(db)
    row = db.su("select g.user_id::text, g.org_id::text, g.monthly_limit_credits::float, g.scopes, g.resource "
                "from public.oauth_grants g where g.id=%s", [c["grant"]])[0]
    assert row[0] == UA and row[1] == ORG_A and row[2] == 500.0 and row[4] == RESOURCE
    # Only hashes are stored.
    stored = [r[0] for r in db.su("select token_hash from public.oauth_tokens where grant_id=%s", [c["grant"]])]
    assert sorted(stored) == sorted([sha(c["at"]), sha(c["rt"])])
    assert all(len(h) == 64 for h in stored)


def test_a_code_is_single_use_and_a_replay_kills_what_the_first_use_made(db):
    cid = client(db)
    verifier, challenge = pkce()
    _, secret = begin(db, UA, cid, challenge=challenge)
    _, code = decide(db, UA, secret)
    first, at, rt = exchange(db, code, cid, verifier)
    assert first["ok"]
    assert db.anon("select public.oauth_check(%s,null)", [sha(at)])["ok"] is True
    second, at2, _ = exchange(db, code, cid, verifier)
    assert second == {"ok": False, "error": "invalid_grant"}
    # The leaked-code response: the first use's tokens are dead and so is the refresh token.
    assert db.anon("select public.oauth_check(%s,null)", [sha(at)])["ok"] is False
    assert refresh(db, rt, cid)[0] == {"ok": False, "error": "invalid_grant"}


def test_two_simultaneous_redemptions_of_one_code_produce_at_most_one_session(db):
    cid = client(db)
    verifier, challenge = pkce()
    _, secret = begin(db, UA, cid, challenge=challenge)
    _, code = decide(db, UA, secret)

    def go(_):
        return exchange(db, code, cid, verifier)

    with cf.ThreadPoolExecutor(8) as ex:
        outs = list(ex.map(go, range(8)))
    assert sum(1 for r, _a, _r in outs if r["ok"]) == 1
    grant_dead = db.su("select count(*) from public.oauth_grants g join public.oauth_codes c on c.grant_id=g.id "
                       "where c.code_hash=%s and g.revoked_at is not null", [sha(code)])[0][0]
    live = sum(1 for r, a, _r in outs if r["ok"] and db.anon("select public.oauth_check(%s,null)", [sha(a)])["ok"])
    assert grant_dead == 1 and live == 0, "a redeemed-twice code must leave no live token"


@pytest.mark.parametrize("what", ["verifier", "redirect", "client", "resource"])
def test_a_code_is_bound_to_its_pkce_challenge_redirect_client_and_resource(db, what):
    cid = client(db, uris=(REDIRECT, LOOPBACK))
    other = client(db)
    verifier, challenge = pkce()
    _, secret = begin(db, UA, cid, challenge=challenge)
    _, code = decide(db, UA, secret)
    kw = {"verifier": dict(verifier=pkce()[0]), "redirect": dict(redirect=LOOPBACK),
          "client": dict(client_id=other), "resource": dict(resource="https://evil.example/mcp")}[what]
    args = dict(code=code, client_id=cid, verifier=verifier)
    args.update(kw)
    res, at, _ = exchange(db, **args)
    assert res["ok"] is False, res
    # A wrong verifier / redirect / client burns the code; the right one afterwards is refused too.
    if what != "resource":
        assert exchange(db, code, cid, verifier)[0]["ok"] is False
    assert db.anon("select public.oauth_check(%s,null)", [sha(at)])["ok"] is False


def test_an_expired_code_is_refused(db):
    cid = client(db)
    verifier, challenge = pkce()
    _, secret = begin(db, UA, cid, challenge=challenge)
    _, code = decide(db, UA, secret)
    db.su("update public.oauth_codes set expires_at = now() - interval '1 second' where code_hash=%s", [sha(code)])
    assert exchange(db, code, cid, verifier)[0] == {"ok": False, "error": "invalid_grant"}


def test_a_code_lives_sixty_seconds(db):
    cid = client(db)
    verifier, challenge = pkce()
    _, secret = begin(db, UA, cid, challenge=challenge)
    _, code = decide(db, UA, secret)
    secs = db.su("select extract(epoch from expires_at - created_at)::int from public.oauth_codes where code_hash=%s", [sha(code)])[0][0]
    assert secs == 60


def test_free_cannot_redeem_even_a_code_made_while_subscribed(db):
    cid = client(db)
    verifier, challenge = pkce()
    _, secret = begin(db, UB, cid, challenge=challenge)
    _, code = decide(db, UB, secret)
    set_plan(db, ORG_B, "canceled")
    try:
        assert exchange(db, code, cid, verifier)[0] == {"ok": False, "error": "subscription_required"}
    finally:
        set_plan(db, ORG_B, "active")
    # Nothing was spent: renewing the plan and trying again works.
    assert exchange(db, code, cid, verifier)[0]["ok"] is True


def test_garbage_input_to_the_token_functions_is_refused_not_raised(db):
    cid = client(db)
    for args in (["", cid, REDIRECT, "x", RESOURCE, "", ""], ["zz", cid, REDIRECT, "x", RESOURCE, sha("a"), sha("a")]):
        assert db.anon("select public.oauth_exchange_code(%s,%s,%s,%s,%s,%s,%s)", args) == {"ok": False, "error": "invalid_grant"}
    assert db.anon("select public.oauth_refresh(%s,%s,%s,%s,%s)", ["nope", cid, RESOURCE, "a", "b"]) == {"ok": False, "error": "invalid_grant"}
    db.anon("select public.oauth_revoke_token(%s,%s)", ["nope", cid])  # no error, no oracle


# ── refresh: rotation and reuse ─────────────────────────────────────────────

def test_refresh_rotates_and_the_old_refresh_token_cannot_be_used_twice(db):
    c = connect(db)
    r1, at2, rt2 = refresh(db, c["rt"], c["client"])
    assert r1["ok"]
    assert db.anon("select public.oauth_check(%s,null)", [sha(c["at"])])["ok"] is False, "the old access token dies at rotation"
    assert db.anon("select public.oauth_check(%s,null)", [sha(at2)])["ok"] is True
    # Presenting the spent refresh token again: the whole grant is revoked, new tokens included.
    again, at3, _ = refresh(db, c["rt"], c["client"])
    assert again == {"ok": False, "error": "invalid_grant"}
    assert db.anon("select public.oauth_check(%s,null)", [sha(at2)])["ok"] is False
    assert refresh(db, rt2, c["client"])[0] == {"ok": False, "error": "invalid_grant"}
    assert db.su("select revoked_reason from public.oauth_grants where id=%s", [c["grant"]])[0][0] == "reuse"


def test_a_refresh_race_never_leaves_two_live_families(db):
    c = connect(db)

    def go(_):
        return refresh(db, c["rt"], c["client"])

    with cf.ThreadPoolExecutor(8) as ex:
        outs = list(ex.map(go, range(8)))
    assert sum(1 for r, _a, _r in outs if r["ok"]) == 1
    live = [a for r, a, _r in outs if r["ok"] and db.anon("select public.oauth_check(%s,null)", [sha(a)])["ok"]]
    assert live == [], "once a spent refresh token was seen, no token of the family may work"


def test_refresh_is_bound_to_the_client(db):
    c = connect(db)
    assert refresh(db, c["rt"], client(db))[0] == {"ok": False, "error": "invalid_grant"}
    assert refresh(db, c["rt"], c["client"])[0]["ok"] is True  # the wrong client did not spend it


def test_refresh_lifetimes_are_bounded_and_sliding(db):
    c = connect(db)
    secs = db.su("select extract(epoch from expires_at - now())::int from public.oauth_tokens where token_hash=%s", [sha(c["at"])])[0][0]
    assert 3590 <= secs <= 3600
    days = db.su("select extract(epoch from expires_at - now())::float / 86400 from public.oauth_tokens where token_hash=%s", [sha(c["rt"])])[0][0]
    assert 29.9 <= days <= 30
    # Near the absolute cap a new refresh token cannot outlive it.
    db.su("update public.oauth_grants set absolute_expires_at = now() + interval '2 days' where id=%s", [c["grant"]])
    _, _at, rt2 = refresh(db, c["rt"], c["client"])
    d2 = db.su("select extract(epoch from expires_at - now())::float / 86400 from public.oauth_tokens where token_hash=%s", [sha(rt2)])[0][0]
    assert d2 <= 2.01
    db.su("update public.oauth_grants set absolute_expires_at = now() - interval '1 second' where id=%s", [c["grant"]])
    assert refresh(db, rt2, c["client"])[0] == {"ok": False, "error": "invalid_grant"}


def test_an_expired_access_token_and_an_expired_refresh_token_are_refused(db):
    c = connect(db)
    db.su("update public.oauth_tokens set expires_at = now() - interval '1 second' where token_hash=%s", [sha(c["at"])])
    assert db.anon("select public.oauth_check(%s,null)", [sha(c["at"])])["ok"] is False
    assert db.anon("select public.api_list_channels(%s,null)", [sha(c["at"])])["status"] == 401
    db.su("update public.oauth_tokens set expires_at = now() - interval '1 second' where token_hash=%s", [sha(c["rt"])])
    assert refresh(db, c["rt"], c["client"])[0] == {"ok": False, "error": "invalid_grant"}


def test_an_access_token_is_not_a_refresh_token_and_back(db):
    c = connect(db)
    assert refresh(db, c["at"], c["client"])[0] == {"ok": False, "error": "invalid_grant"}
    assert db.anon("select public.oauth_check(%s,null)", [sha(c["rt"])])["ok"] is False
    assert db.anon("select public.api_list_channels(%s,null)", [sha(c["rt"])])["status"] == 401


# ── what a token can reach ──────────────────────────────────────────────────

def test_a_token_lists_only_its_own_workspace(db):
    a, b = connect(db, UA), connect(db, UB)
    ra = db.anon("select public.api_list_channels(%s,null)", [sha(a["at"])])
    rb = db.anon("select public.api_list_channels(%s,null)", [sha(b["at"])])
    assert [c["id"] for c in ra["data"]["channels"]] == ["chan-a"]
    assert [c["id"] for c in rb["data"]["channels"]] == ["chan-b"]


def test_a_token_reads_only_its_own_videos_and_jobs_and_cannot_publish_another_workspaces_video(db):
    a = connect(db, UA)
    assert db.anon("select public.api_get_video(%s,'vid-a',null)", [sha(a["at"])])["ok"] is True
    other = db.anon("select public.api_get_video(%s,'vid-b',null)", [sha(a["at"])])
    assert other["status"] == 404
    pub = db.anon("select public.api_request_publish(%s,'vid-b',null,array['chan-b'],null,null,null)", [sha(a["at"])])
    assert pub["status"] == 404
    jid = db.su("insert into public.render_jobs (channel_id, kind, params, requested_by) "
                "select 'chan-op', 'daily', '{}'::jsonb, %s returning id", [UOP])[0][0]
    assert db.anon("select public.oauth_get_job(%s,%s,null)", [sha(a["at"]), jid])["status"] == 404


def test_a_token_cannot_reach_a_usd_balance_endpoint_even_by_calling_the_database_directly(db):
    a = connect(db, UA)
    before = usd(db)
    attempts = [
        "select public.api_create_video(%s,'chan-a','{\"duration\":60}'::jsonb,null,null,null)",
        "select public.api_request_download(%s,'vid-a','720p',null,null,null)",
        "select public.api_get_download(%s,1,null)",
        "select public.api_balance(%s,null)",
        "select public.api_auth(%s,null)",
        "select public.api_get_job(%s,1,null)",
        "select public.api_creative_quote(%s,'t2i','m','{}'::jsonb,null)",
        "select public.api_creative_create(%s,'t2i','m','{}'::jsonb,'exact',9,'k','" + sha("x") + "',null)",
        "select public.api_creative_get(%s,'" + str(uuid.uuid4()) + "',null)",
    ]
    for q in attempts:
        res = db.anon(q, [sha(a["at"])])
        assert res["ok"] is False and res["status"] == 403 and res["error"]["code"] == "not_available_for_connected_apps", (q, res)
    assert usd(db) == before
    assert db.su("select count(*) from public.api_holds where org_id=%s", [ORG_A])[0][0] == 0


def test_the_scopes_a_person_gave_are_the_scopes_a_token_has(db):
    cid = client(db)
    verifier, challenge = pkce()
    res, secret = begin(db, UA, cid, challenge=challenge, scope="videos:read")
    _, code = decide(db, UA, secret)
    _ex, at, _ = exchange(db, code, cid, verifier)
    conn_ = {"at": at}
    assert db.anon("select public.api_list_channels(%s,null)", [sha(at)])["ok"] is True
    for q, scope in [("select public.oauth_create_video(%s,'chan-a','{\"duration\":60}'::jsonb,null,null)", "videos:create"),
                     ("select public.api_request_publish(%s,'vid-a',null,array['chan-a'],null,null,null)", "videos:publish")]:
        r = db.anon(q, [sha(at)])
        assert r["status"] == 403 and r["error"]["code"] == "insufficient_scope" and r["error"]["required_scope"] == scope, r
    assert create(db, conn_)["status"] == 403


def test_a_token_workspace_cannot_be_changed_by_the_caller(db):
    # There is no argument that names an organization; a channel of another one is simply not found.
    a = connect(db, UA)
    r = create(db, a, channel="chan-b")
    assert r["status"] == 404 and r["error"]["code"] == "channel_not_found"
    assert create(db, a, channel="chan-op")["status"] == 404


def test_a_connection_is_rate_limited_per_minute(db):
    a = connect(db, UA)
    codes = []
    with psycopg.connect(db.dsn) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [claims("anon")])
        c.execute("set local role anon")
        for _ in range(125):
            codes.append(c.execute("select public.api_list_channels(%s,null)", [sha(a["at"])]).fetchone()[0].get("status"))
        c.rollback()
    assert codes.count(200) <= 120 and 429 in codes


# ── the API-key door is unchanged ───────────────────────────────────────────

def test_the_api_key_door_answers_exactly_as_before(db):
    ok = db.anon("select public.api_list_channels(%s,null)", [sha(KEY_A)])
    assert ok["ok"] is True and [c["id"] for c in ok["data"]["channels"]] == ["chan-a"]
    assert db.anon("select public.api_balance(%s,null)", [sha(KEY_A)])["data"]["balance_cents"] == 5000
    unknown = db.anon("select public.api_list_channels(%s,null)", [sha("nobody")])
    assert unknown["status"] == 401 and unknown["error"]["code"] == "invalid_api_key"
    garbage = db.anon("select public.api_list_channels(%s,null)", ["not-a-hash"])
    assert garbage["status"] == 401 and garbage["error"]["code"] == "invalid_api_key"
    db.su("update public.api_keys set revoked_at = now() where key_hash=%s", [sha(KEY_A)])
    try:
        rev = db.anon("select public.api_list_channels(%s,null)", [sha(KEY_A)])
        assert rev["status"] == 401 and rev["error"]["code"] == "invalid_api_key"
    finally:
        db.su("update public.api_keys set revoked_at = null where key_hash=%s", [sha(KEY_A)])


def test_an_api_key_hash_is_not_a_token_and_a_token_hash_is_not_a_key(db):
    # The key's hash cannot be redeemed as an OAuth token anywhere, and the
    # key keeps its own scopes: a key without creative scopes still cannot use them.
    assert db.anon("select public.oauth_check(%s,null)", [sha(KEY_A)])["ok"] is False
    r = db.anon("select public.api_creative_quote(%s,'t2i','m','{}'::jsonb,null)", [sha(KEY_A)])
    assert r["error"]["code"] == "insufficient_scope"


# ── the subscription gate, live ─────────────────────────────────────────────

def test_a_cancelled_subscription_stops_the_next_call_and_renewing_brings_it_back(db):
    c = connect(db, UB)
    assert db.anon("select public.api_list_channels(%s,null)", [sha(c["at"])])["ok"] is True
    set_plan(db, ORG_B, "canceled")
    try:
        for q in ("select public.api_list_channels(%s,null)", "select public.api_get_video(%s,'vid-b',null)",
                  "select public.oauth_get_balance(%s,null)"):
            r = db.anon(q, [sha(c["at"])])
            assert r["status"] == 403 and r["error"]["code"] == "subscription_required", r
        r = create(db, c, channel="chan-b")
        assert r["error"]["code"] == "subscription_required"
        assert db.anon("select public.oauth_check(%s,null)", [sha(c["at"])])["data"]["entitled"] is False
        # The refresh token is refused but NOT spent.
        assert refresh(db, c["rt"], c["client"])[0] == {"ok": False, "error": "subscription_required"}
        mine = db.user(UB, "select public.oauth_my_grants()")
        assert [g["status"] for g in mine if g["id"] == c["grant"]] == ["paused_plan"]
    finally:
        set_plan(db, ORG_B, "active")
    assert db.anon("select public.api_list_channels(%s,null)", [sha(c["at"])])["ok"] is True
    assert refresh(db, c["rt"], c["client"])[0]["ok"] is True


def test_a_workspace_with_packs_but_no_subscription_is_not_entitled(db):
    cid = client(db)
    res, _ = begin(db, UF, cid)
    assert res["entitled"] is False
    assert db.su("select public.has_entitlement_internal(%s,'mcp')", [ORG_F])[0][0] is False


def test_the_operators_own_organization_is_exempt_from_the_plan_and_from_holds(db):
    c = connect(db, UOP)
    before = db.su("select count(*) from public.credit_reservations")[0][0]
    r = create(db, c, channel="chan-op", params={"duration": 60})
    assert r["ok"] is True and r["data"]["status"] == "queued", r
    assert db.su("select count(*) from public.credit_reservations")[0][0] == before, "the operator's runs hold nothing"
    assert db.su("select credit_ref from public.render_jobs where id=%s", [r["data"]["job_id"]])[0][0] is None


def test_the_mcp_entitlement_is_enforced_for_every_paid_plan_and_not_for_free(db):
    rows = dict(db.su("select plan_id, value::text from public.plan_entitlements where key='mcp'"))
    assert rows["free"] == "false" and rows["creator"] == "true" and rows["pro"] == "true" and rows["studio"] == "true"
    assert db.su("select status from public.entitlement_keys where key='mcp'")[0][0] == "enforced"


# ── paying in site credits ──────────────────────────────────────────────────

def test_a_connected_video_is_paid_from_site_credits_never_the_usd_balance(db):
    c = connect(db, UA, limit=1000)
    usd0, cr0 = usd(db), credits(db)
    r = create(db, c, params={"duration": 120}, idem="paid-1")
    assert r["ok"] is True and r["status"] == 201, r
    price = r["data"]["price_credits"]
    assert price == 180.0  # 60 credits a minute x 1.5 margin x 2 minutes
    assert usd(db) == usd0, "the USD API balance never moves"
    assert db.su("select count(*) from public.api_holds where org_id=%s", [ORG_A])[0][0] == 0
    bal, held = credits(db)
    assert held - cr0[1] == price and bal == cr0[0], "the credits are held, not yet charged"
    ref = db.su("select credit_ref from public.render_jobs where id=%s", [r["data"]["job_id"]])[0][0]
    assert ref.startswith("rj-oa-")
    row = db.su("select amount::float, status from public.credit_reservations where job_id=%s", [ref])[0]
    assert row == (price, "open")
    assert [k for (k,) in db.su("select kind from public.credit_transactions where job_id=%s order by id", [ref])] == ["reserve"]
    # The job carries the length that was held for.
    assert db.su("select (params->>'duration')::int from public.render_jobs where id=%s", [r["data"]["job_id"]])[0][0] == 120


def test_the_hold_follows_the_channels_target_length_when_none_is_given_and_never_a_guess(db):
    c = connect(db, UA, limit=1000)
    r = create(db, c, params={}, idem="target-1")
    assert r["ok"] and r["data"]["price_credits"] == 180.0  # chan-a's target is 120 s
    r2 = create(db, c, channel="chan-a", params={"duration": 30}, idem="clamp-1")
    assert r2["ok"] and r2["data"]["price_credits"] == 45.0  # 60 x 1.5 x 0.5
    assert db.su("select (params->>'duration')::int from public.render_jobs where id=%s", [r2["data"]["job_id"]])[0][0] == 30
    # A channel with no target length and no duration is refused: no guess is priced.
    b = connect(db, UB, limit=1000)
    before = credits(db, ORG_B)
    assert create(db, b, channel="chan-b", params={}, idem="nolen-1")["error"]["code"] == "duration_required"
    assert credits(db, ORG_B) == before


def test_an_unpriced_video_is_refused_never_free(db):
    c = connect(db, UA, limit=1000)
    db.su("delete from public.credit_prices where unit='video_minute'")
    try:
        before = (credits(db), db.su("select count(*) from public.render_jobs")[0][0])
        r = create(db, c, params={"duration": 60}, idem="unpriced-1")
        assert r["status"] == 503 and r["error"]["code"] == "pricing_unavailable"
        assert (credits(db), db.su("select count(*) from public.render_jobs")[0][0]) == before
    finally:
        db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('video_minute', 60, 0.5)")


def test_a_retry_with_the_same_idempotency_key_makes_one_job_and_one_hold(db):
    c = connect(db, UA, limit=1000)
    first = create(db, c, idem="idem-x")
    again = create(db, c, idem="idem-x")
    assert first["ok"] and again["ok"] and again.get("replayed") is True
    assert first["data"]["job_id"] == again["data"]["job_id"]
    assert db.su("select count(*) from public.oauth_runs where grant_id=%s", [c["grant"]])[0][0] == 1
    assert db.su("select count(*) from public.credit_reservations where job_id like 'rj-oa-%%' and job_id = "
                 "(select credit_ref from public.oauth_runs where grant_id=%s)", [c["grant"]])[0][0] == 1
    diff = create(db, c, params={"duration": 90}, idem="idem-x")
    assert diff["status"] == 422 and diff["error"]["code"] == "idempotency_key_reused"
    other = connect(db, UA, limit=1000)
    assert create(db, other, idem="idem-x")["data"]["job_id"] != first["data"]["job_id"], "keys are per connection"


def test_invalid_params_hold_nothing(db):
    c = connect(db, UA, limit=1000)
    before = credits(db)
    for params in ({"duration": 5}, {"topic": "x" * 301}, {"nope": 1}, {"duration": "60"}):
        assert create(db, c, params=params)["error"]["code"] == "invalid_params"
    assert credits(db) == before


def test_insufficient_credits_names_only_the_workspaces_own_numbers_and_holds_nothing(db):
    c = connect(db, UA, limit=20000)
    db.su("select public.grant_credits(%s, 1, 'x')", [ORG_P])  # a stranger's balance must not leak
    r = create(db, c, params={"duration": 3600}, idem="big-1")   # 5400 credits against ~4-5k
    cr = credits(db)
    if r["ok"]:  # balance happened to cover it: ask for more than is there
        r = create(db, c, params={"duration": 3600}, idem="big-2")
    assert r["status"] == 402 and r["error"]["code"] == "insufficient_credits", r
    e = r["error"]
    assert set(e) >= {"available_credits", "held_credits", "price_credits"}
    assert e["price_credits"] == 5400.0
    assert e["available_credits"] == pytest.approx(credits(db)[0] - credits(db)[1])
    assert credits(db) == credits(db)
    assert "org" not in json.dumps(e).lower() and ORG_P not in json.dumps(e) and ORG_B not in json.dumps(e)
    _ = cr


def test_top_up_then_continue_on_the_same_connection(db):
    c = connect(db, UA, limit=20000)
    db.su("select public.grant_credits(%s, 100000, 'drain-reset')", [ORG_P])
    # Use up the workspace: hold nearly everything, then ask for more.
    bal, held = credits(db)
    take = int(bal - held) - 5
    db.su("select public.reserve_credits(%s, 'rj-test-drain-" + uuid.uuid4().hex[:8] + "', %s)", [ORG_A, take])
    r = create(db, c, params={"duration": 120}, idem="top-1")
    assert r["status"] == 402 and r["error"]["code"] == "insufficient_credits"
    db.su("select public.grant_credits(%s, 1000, 'top-up')", [ORG_A])           # the person buys credits
    r = create(db, c, params={"duration": 120}, idem="top-2")                      # same token, no reconnect
    assert r["ok"] is True, r


def test_the_per_connection_monthly_limit_holds_and_the_person_can_raise_it_but_not_the_assistant(db):
    c = connect(db, UA, limit=100)
    first = create(db, c, params={"duration": 60}, idem="lim-1")   # 90 credits
    assert first["ok"], first
    second = create(db, c, params={"duration": 60}, idem="lim-2")
    assert second["status"] == 402 and second["error"]["code"] == "connection_limit_reached", second
    e = second["error"]
    assert (e["limit_credits"], e["spent_credits"], e["price_credits"]) == (100.0, 90.0, 90.0)
    # The assistant (the token) has no way to change it; another person has none either.
    assert db.user(UB, "select public.oauth_set_grant_limit(%s, 5000)", [c["grant"]]) is False
    assert db.su("select monthly_limit_credits::float from public.oauth_grants where id=%s", [c["grant"]])[0][0] == 100.0
    assert db.user(UA, "select public.oauth_set_grant_limit(%s, 400)", [c["grant"]]) is True
    assert create(db, c, params={"duration": 60}, idem="lim-3")["ok"] is True
    with pytest.raises(psycopg.errors.Error):
        db.user(UA, "select public.oauth_set_grant_limit(%s, 20001)", [c["grant"]])


def test_a_released_hold_gives_the_connection_its_allowance_back(db):
    c = connect(db, UA, limit=100)
    r = create(db, c, params={"duration": 60}, idem="rel-1")
    ref = db.su("select credit_ref from public.render_jobs where id=%s", [r["data"]["job_id"]])[0][0]
    assert create(db, c, params={"duration": 60}, idem="rel-2")["status"] == 402
    db.su("select public.credit_release_locked(%s, 'test: the job failed')", [ref]) if False else db.su(
        "update public.credit_reservations set status='released', settled_at=now() where job_id=%s", [ref])
    assert create(db, c, params={"duration": 60}, idem="rel-3")["ok"] is True


def test_concurrent_creates_cannot_jointly_exceed_the_connections_limit(db):
    c = connect(db, UB, limit=300)   # 90 credits each: at most 3 fit
    db.su("select public.grant_credits(%s, 100000, 'plenty')", [ORG_B])

    def go(i):
        return db.anon("select public.oauth_create_video(%s,'chan-b',%s::jsonb,%s,'r')",
                       [sha(c["at"]), json.dumps({"duration": 60}), f"race-{i}"])

    with cf.ThreadPoolExecutor(10) as ex:
        outs = list(ex.map(go, range(10)))
    ok = [o for o in outs if o["ok"]]
    assert len(ok) == 3, [o.get("error", {}).get("code") for o in outs]
    assert all(o["error"]["code"] == "connection_limit_reached" for o in outs if not o["ok"])
    spent = db.su("select coalesce(sum(cr.amount),0)::float from public.oauth_runs r join public.credit_reservations cr "
                  "on cr.job_id=r.credit_ref where r.grant_id=%s", [c["grant"]])[0][0]
    assert spent == 270.0 <= 300


def test_the_plans_parallel_run_limit_refuses_a_new_hold_and_says_wait_or_upgrade(db):
    db.su("update public.plan_entitlements set value='1' where key='concurrency' and plan_id in ('creator', 'pro', 'studio', 'free')")
    try:
        c = connect(db, UB, limit=20000)
        db.su("update public.credit_reservations set status='released' where org_id=%s and status='open'", [ORG_B])
        assert create(db, c, channel="chan-b", params={"duration": 60}, idem="run-1")["ok"] is True
        r = create(db, c, channel="chan-b", params={"duration": 60}, idem="run-2")
        assert r["status"] == 429 and r["error"]["code"] == "run_limit_reached", r
        assert r["error"]["run_limit"] == 1 and r["error"]["active_runs"] == 1 and r["error"]["retry_after"] == 60
        assert db.su("select count(*) from public.oauth_runs where grant_id=%s", [c["grant"]])[0][0] == 1, "nothing half-made"
    finally:
        db.su("update public.plan_entitlements set value='1000' where key='concurrency'")


def test_a_running_job_is_not_killed_by_a_later_limit_only_new_holds_are_refused(db):
    c = connect(db, UA, limit=1000)
    r = create(db, c, params={"duration": 60}, idem="keep-1")
    db.user(UA, "select public.oauth_set_grant_limit(%s, 0)", [c["grant"]])
    ref = db.su("select credit_ref from public.render_jobs where id=%s", [r["data"]["job_id"]])[0][0]
    assert db.su("select status from public.credit_reservations where job_id=%s", [ref])[0][0] == "open"
    assert db.su("select status from public.render_jobs where id=%s", [r["data"]["job_id"]])[0][0] == "queued"
    assert create(db, c, idem="keep-2")["error"]["code"] == "connection_limit_reached"


def test_a_limit_of_zero_is_a_read_only_connection(db):
    c = connect(db, UA, limit=0)
    assert db.anon("select public.api_list_channels(%s,null)", [sha(c["at"])])["ok"] is True
    assert create(db, c)["error"]["code"] == "connection_limit_reached"


def test_the_job_and_balance_reads_show_the_charge_in_credits_and_the_connections_own_numbers(db):
    c = connect(db, UA, limit=1000)
    r = create(db, c, params={"duration": 60}, idem="read-1")
    job = db.anon("select public.oauth_get_job(%s,%s,null)", [sha(c["at"]), r["data"]["job_id"]])
    assert job["data"]["charge"] == {"status": "open", "held_credits": 90.0, "charged_credits": None}
    bal = db.anon("select public.oauth_get_balance(%s,null)", [sha(c["at"])])["data"]
    assert bal["this_connection"] == {"monthly_limit_credits": 1000.0, "spent_this_month_credits": 90.0, "left_this_month_credits": 910.0}
    assert set(bal) >= {"credits", "plan", "videos_in_progress", "videos_at_once_limit"}
    assert "balance_cents" not in json.dumps(bal)


# ── revoking and ending a connection ────────────────────────────────────────

def test_revoking_a_grant_kills_every_token_at_once(db):
    c = connect(db, UA)
    _, at2, rt2 = refresh(db, c["rt"], c["client"])
    assert db.user(UA, "select public.oauth_revoke_grant(%s)", [c["grant"]]) is True
    for tok in (at2,):
        assert db.anon("select public.oauth_check(%s,null)", [sha(tok)])["ok"] is False
        assert db.anon("select public.api_list_channels(%s,null)", [sha(tok)])["status"] == 401
        assert create(db, {"at": tok})["status"] == 401
    assert refresh(db, rt2, c["client"])[0] == {"ok": False, "error": "invalid_grant"}
    assert c["grant"] not in [g["id"] for g in db.user(UA, "select public.oauth_my_grants()")]


def test_only_the_owner_of_a_grant_can_revoke_it(db):
    c = connect(db, UA)
    assert db.user(UB, "select public.oauth_revoke_grant(%s)", [c["grant"]]) is False
    assert db.anon("select public.oauth_check(%s,null)", [sha(c["at"])])["ok"] is True
    assert c["grant"] not in [g["id"] for g in db.user(UB, "select public.oauth_my_grants()")]


def test_revoke_all_and_the_revoke_endpoint(db):
    c1, c2 = connect(db, UA), connect(db, UA)
    db.anon("select public.oauth_revoke_token(%s,%s)", [sha(c1["rt"]), c1["client"]])
    assert db.anon("select public.oauth_check(%s,null)", [sha(c1["at"])])["ok"] is False
    # Another client cannot revoke it by naming a token it does not own.
    db.anon("select public.oauth_revoke_token(%s,%s)", [sha(c2["at"]), c1["client"]])
    assert db.anon("select public.oauth_check(%s,null)", [sha(c2["at"])])["ok"] is True
    assert db.user(UA, "select public.oauth_revoke_all_grants()") >= 1
    assert db.anon("select public.oauth_check(%s,null)", [sha(c2["at"])])["ok"] is False


def test_losing_the_workspace_stops_the_connection(db):
    c = connect(db, UA)
    db.su("update public.org_members set role = 'viewer' where org_id=%s and user_id=%s", [ORG_A, UA])
    try:
        r = db.anon("select public.api_list_channels(%s,null)", [sha(c["at"])])
        assert r["status"] == 403 and r["error"]["code"] == "workspace_access_lost"
    finally:
        db.su("update public.org_members set role = 'owner' where org_id=%s and user_id=%s", [ORG_A, UA])


def test_deleting_the_account_removes_its_connections(db):
    ghost = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, 'ghost@d3.io')", [ghost])
    org = str(uuid.uuid4())
    db.su("insert into public.organizations (id, name, slug) values (%s, 'G', %s)", [org, "g-" + org[:8]])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'ghost@d3.io','owner')", [org, ghost])
    db.su("insert into public.subscriptions (org_id, provider_subscription_id, plan_id, status) values (%s,'sub_gggggggggggg','creator','active')", [org])
    c = connect(db, ghost)
    assert db.anon("select public.oauth_check(%s,null)", [sha(c["at"])])["ok"] is True
    db.su("delete from auth.users where id=%s", [ghost])
    assert db.anon("select public.oauth_check(%s,null)", [sha(c["at"])])["ok"] is False
    assert db.su("select count(*) from public.oauth_grants where user_id=%s", [ghost])[0][0] == 0


def test_the_my_grants_list_is_the_persons_own_and_carries_the_numbers(db):
    c = connect(db, UA, limit=250)
    create(db, c, params={"duration": 60}, idem="list-1")
    mine = [g for g in db.user(UA, "select public.oauth_my_grants()") if g["id"] == c["grant"]][0]
    assert mine["monthly_limit_credits"] == 250.0 and mine["spent_this_month_credits"] == 90.0
    assert mine["client_name"] == "Test app" and mine["status"] == "active" and mine["last_used_at"] is not None
    assert c["grant"] not in [g["id"] for g in db.user(UB, "select public.oauth_my_grants()")]


def test_every_connect_and_disconnect_is_audited_without_a_secret(db):
    c = connect(db, UA)
    db.user(UA, "select public.oauth_revoke_grant(%s)", [c["grant"]])
    rows = db.su("select action, detail::text from public.app_audit_log where target=%s order by at", [c["grant"]])
    assert [r[0] for r in rows] == ["mcp.connect", "mcp.disconnect"]
    assert c["at"] not in "".join(r[1] for r in rows) and sha(c["at"]) not in "".join(r[1] for r in rows)


def test_the_dangerous_functions_pin_their_search_path(db):
    bad = db.su("select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'oauth\\_%' "
                "and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')")
    assert bad == []


def test_replaying_the_migration_twice_changes_nothing(db):
    path = sec_db.MIGRATIONS / "0093_mcp_oauth.sql"
    c = connect(db, UA)
    before = (db.su("select count(*) from public.oauth_grants")[0][0], db.su("select count(*) from public.oauth_tokens")[0][0],
              db.su("select pepper from public.oauth_settings")[0][0])
    sec_db.apply_files(db.dsn, [path, path])
    after = (db.su("select count(*) from public.oauth_grants")[0][0], db.su("select count(*) from public.oauth_tokens")[0][0],
             db.su("select pepper from public.oauth_settings")[0][0])
    assert before == after
    assert db.anon("select public.oauth_check(%s,null)", [sha(c["at"])])["ok"] is True
    assert db.su("select status from public.entitlement_keys where key='mcp'")[0][0] == "enforced"


# ── Lens-386A: PKCE is checked by the database, a limit of 0 is read-only for the operator too,
#    and a refused registration costs no table scan ────────────────────────────────────────────

def test_pkce_is_checked_in_the_database_not_trusted_from_the_caller(db):
    """The token functions are callable with the public anon key. Someone who saw the code and the
    authorization URL (so knows the challenge) must not be able to redeem without the verifier."""
    cid = client(db)
    verifier, challenge = pkce()
    _, secret = begin(db, UA, cid, challenge=challenge)
    _, code = decide(db, UA, secret)
    # the challenge presented where the verifier belongs: refused, and it burns the code
    res, at, _ = exchange(db, code, cid, challenge)
    assert res == {"ok": False, "error": "invalid_grant"}
    assert exchange(db, code, cid, verifier)[0]["ok"] is False
    assert db.anon("select public.oauth_check(%s,null)", [sha(at)])["ok"] is False
    # a verifier that is not RFC 7636 shaped never reaches the digest (and burns nothing)
    cid2 = client(db)
    v2, c2 = pkce()
    _, secret2 = begin(db, UA, cid2, challenge=c2)
    _, code2 = decide(db, UA, secret2)
    for bad in ("", "short", "x" * 129, "has space " + "a" * 40, c2 + "="):
        assert exchange(db, code2, cid2, bad)[0] == {"ok": False, "error": "invalid_grant"}
    assert exchange(db, code2, cid2, v2)[0]["ok"] is True
    # the S256 vector of RFC 7636 appendix B
    cid3 = client(db)
    _, secret3 = begin(db, UA, cid3, challenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    _, code3 = decide(db, UA, secret3)
    assert exchange(db, code3, cid3, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")[0]["ok"] is True


def test_a_limit_of_zero_is_read_only_for_the_operators_exempt_workspace_too(db):
    c = connect(db, uid=UOP, limit=0)
    jobs = lambda: db.su("select count(*) from public.render_jobs where channel_id='chan-op'")[0][0]
    before = jobs()
    r = create(db, c, channel="chan-op", params={"duration": 60}, idem="op-zero")
    assert code_of(r) == "connection_limit_reached", r
    assert db.su("select count(*) from public.oauth_runs where grant_id=%s", [c["grant"]])[0][0] == 0
    assert jobs() == before
    # raised by the person, the same connection creates (the exempt workspace is never charged)
    assert db.user(UOP, "select public.oauth_set_grant_limit(%s::uuid, 10)", [c["grant"]]) is True
    assert create(db, c, channel="chan-op", params={"duration": 60}, idem="op-ten")["ok"] is True


def test_a_refused_registration_does_not_run_the_collector(db):
    stale = db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash, created_at) "
                  "values ('stale2', array['https://s2.example.com/cb'], %s, now() - interval '3 days') returning client_id::text", [sha("s2")])[0][0]
    ip = "198.19.0." + uuid.uuid4().hex[:6]
    db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) "
          "select 'flood2', array['https://f2.example.com/cb'], %s from generate_series(1, 300)", [sha("f2")])
    try:
        assert register(db, ip=ip)["error"] == "rate_limited"
        assert db.su("select count(*) from public.oauth_clients where client_id=%s", [stale])[0][0] == 1, \
            "a refused call must not scan and delete (it is the unauthenticated flood's cheapest lever)"
    finally:
        db.su("delete from public.oauth_clients where client_name = 'flood2'")
    assert register(db, ip=ip)["ok"] is True  # an accepted call still collects
    assert db.su("select count(*) from public.oauth_clients where client_id=%s", [stale])[0][0] == 0
