"""Migration 0147 attacked in a real database: connecting an AI app on every plan, limited by credits; one rate unit per tool
call; the API key's spend-limit refusals name their remedy.

What would break, and the test that says so:

* a Free (or pack-only, or lapsed) workspace still refused at one of the doors 0093 gated (consent, decision, code, refresh,
  every call), or a connection 0093 paused staying paused after 0147;
* a Free workspace spending credits it does not have: the refusal is `insufficient_credits` before anything is held, and the
  same connection works on its next call once credits come from a pack or a plan (welcome credits count too);
* the videos-at-once limit, the per-connection monthly limit and revocation no longer applying to a Free connection;
* the rate credit as a free pass: a forged request id gains at most the one call its counted check paid for, a refused check
  leaves nothing, calls racing for one credit get exactly one free, a credit dies after a minute, and a batch of N tool calls
  costs N units, so 120 a minute is 120 tool calls, and the call a check admitted is never refused for the check's own unit;
* the rollback not putting 0093 / 0042 back, or 0147 not applying again after it; the drift guard not refusing a stranger body.

Runs in its own scratch database (it commits).
"""

from __future__ import annotations

import base64
import concurrent.futures as cf
import hashlib
import json
import os
import re
import secrets
import threading
import uuid

import psycopg
import pytest

import sec_db

MIGRATION = sec_db.MIGRATIONS / "0147_mcp_free_tier.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0147_mcp_free_tier.sql"
# Later migrations that replace a function of 0147, with their undo, newest first: api_create_video (0192, the adult gate,
# tests/security/test_sec_adult_attestation.py), the 0191 connector's own (tests/security/test_sec_mcp_oauth_creative.py), oauth_gc
# (0161, tests/security/test_sec_mcp_chatgpt_client.py) and api_request_download (0170, tests/security/test_sec_api_download.py).
# 0198 (Film Studio's switch per organization) sits on 0192's quote_film and start_film: off before 0192, on after it.
# 0219 (the operator route for connected assistants) sits on 0192's and 0191's Studio doors, and both refuse it: off first.
# 0218 (creative_price on 0208's body) comes off before 0208 and goes back after it.
# 0215 (archive and resume) sits on 0198's start_film and film_claim_segment: off before 0198.
# 0226 (only a member spends) sits on 0147's oauth_ctx and 0192's bodies and calls 0215's is_org_spender: off first of all.
# 0231 (cancel audit) asks for 0226: off before it.
LATER = [(sec_db.MIGRATION_0232, sec_db.ROLLBACK_0232),  # 0232 sits on 0226's chat bodies, which 0226's rollback refuses
         (sec_db.MIGRATION_0231, sec_db.ROLLBACK_0231),
         (sec_db.MIGRATION_0226, sec_db.ROLLBACK_0226),
         (sec_db.MIGRATION_0228, sec_db.ROLLBACK_0228),  # 0228 sits on 0218's creative_params_problem and 0224's creative_price
         (sec_db.MIGRATION_0224, sec_db.ROLLBACK_0224),  # 0224 sits on 0218's creative_price, which 0218's rollback keeps the line of
         (sec_db.MIGRATION_0219, sec_db.ROLLBACK_0219),
         (sec_db.MIGRATION_0218, sec_db.ROLLBACK_0218),
         (sec_db.MIGRATION_0215, sec_db.ROLLBACK_0215),
         (sec_db.MIGRATION_0208, sec_db.ROLLBACK_0208),  # 0208 sits on 0196's reroute_creative_job, which 0196's rollback refuses
         (sec_db.MIGRATION_0198, sec_db.ROLLBACK_0198),
         (sec_db.MIGRATION_0196, sec_db.ROLLBACK_0196),  # 0196 sits on 0192's api_create_video
         (sec_db.MIGRATION_0192, sec_db.ROLLBACK_0192),
         (sec_db.MIGRATIONS / "0191_mcp_oauth_creative.sql", sec_db.REPO / "docs" / "sql" / "rollback_0191_mcp_oauth_creative.sql"),
         (sec_db.MIGRATIONS / "0161_mcp_chatgpt_client.sql", sec_db.REPO / "docs" / "sql" / "rollback_0161_mcp_chatgpt_client.sql"),
         (sec_db.MIGRATIONS / "0170_api_download_audit.sql", sec_db.REPO / "docs" / "sql" / "rollback_0170_api_download_audit.sql")]
ORG_PAID = "aaaaaaaa-0000-0000-0000-000000000147"
U_PAID = str(uuid.UUID(int=0xA147))
RESOURCE = "https://nightshift-ai.studio/api/mcp"
REDIRECT = "https://claude.ai/api/mcp/auth_callback"
KEY = "key-0147-paid"


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def rid() -> str:
    """A request id of the route's shape (lib/api/http.ts newRequestId)."""
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    return "req_" + "".join(secrets.choice(alphabet) for _ in range(24))


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
    name = f"ns_mcp_free_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    # This lab replays and rolls back 0147, whose drift guard refuses a body it was not written on; so a later migration that
    # replaces one of 0147's functions is undone first (with its own rollback) and attacked in its own lab.
    for later, undo in LATER:
        if later.exists():
            d.apply(undo)
    d.su("insert into auth.users (id, email, email_confirmed_at) values (%s, 'paid@0147.io', now())", [U_PAID])
    d.su("insert into public.organizations (id, name, slug) values (%s, 'Paid', 'org-paid-0147')", [ORG_PAID])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'paid@0147.io', 'owner')", [ORG_PAID, U_PAID])
    d.su("select public.grant_credits(%s, 5000, 'test')", [ORG_PAID])
    d.su("insert into public.subscriptions (org_id, provider_subscription_id, plan_id, status) values (%s, 'sub_paid0147aaaa', 'creator', 'active')",
         [ORG_PAID])
    # 60 credits a minute + 50% margin, 10 minimum: 30 s = 45 credits, 60 s = 90, 120 s = 180.
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('video_minute', 60, 0.5), ('job_minimum', 10, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin")
    d.su("insert into public.channels (channel_id, name, niche, status, org_id, agent_config, credential_ref) values "
         "('chan-paid-0147', 'P', 'tech', 'ACTIVE', %s, '{}', '{\"verified_at\":\"2026-09-01\"}')", [ORG_PAID])
    # The API-key door of the paid workspace: activated, a USD balance, one key with a small limit of its own.
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1')", [ORG_PAID, U_PAID])
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 50000, 100000)", [ORG_PAID])
    d.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes, monthly_limit_cents) values (%s, 'k', %s, %s, %s, 100)",
         [ORG_PAID, sha(KEY), U_PAID, ["account:read", "videos:read", "videos:write"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


# ── helpers ─────────────────────────────────────────────────────────────────

def signup(db) -> tuple[str, str, str]:
    """A person who signs up and makes their workspace the way the app does: Free, no subscription, 100 welcome credits (0027)."""
    uid = str(uuid.uuid4())
    db.su("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [uid, f"free-{uid[:8]}@example.test"])
    org = db.user(uid, "select public.create_organization(%s)", [f"Free {uid[:8]}"])
    channel = f"chan-{uid[:8]}"
    db.su("insert into public.channels (channel_id, name, niche, status, org_id, agent_config, credential_ref) values "
          "(%s, 'F', 'tech', 'ACTIVE', %s, '{}', '{\"verified_at\":\"2026-09-01\"}')", [channel, org])
    return uid, str(org), channel


def pkce():
    verifier = secrets.token_urlsafe(48)
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


def client(db) -> str:
    r = db.anon("select public.oauth_register_client(%s, %s, %s)", ["Test app", [REDIRECT], f"198.51.100.{uuid.uuid4().hex[:10]}"])
    assert r["ok"], r
    return r["client_id"]


def begin(db, uid, cid, challenge):
    secret = secrets.token_urlsafe(32)
    res = db.user(uid, "select public.oauth_begin_authorization(%s,%s,%s,'S256','st',null,%s,%s)",
                  [cid, REDIRECT, challenge, RESOURCE, sha(secret)])
    return res, secret


def connect(db, uid, limit=20000):
    cid = client(db)
    verifier, challenge = pkce()
    res, secret = begin(db, uid, cid, challenge)
    assert res["ok"] and res["entitled"] is True and "scopes" in res, res
    code = "code-" + secrets.token_urlsafe(32)
    dec = db.user(uid, "select public.oauth_decide_authorization(%s, true, %s::numeric, %s)", [sha(secret), limit, sha(code)])
    assert dec["ok"] and dec["allowed"], dec
    at, rt = "at-" + secrets.token_urlsafe(32), "rt-" + secrets.token_urlsafe(32)
    ex = db.anon("select public.oauth_exchange_code(%s,%s,%s,%s,%s,%s,%s)", [sha(code), cid, REDIRECT, verifier, RESOURCE, sha(at), sha(rt)])
    assert ex["ok"], ex
    grant = db.su("select grant_id::text from public.oauth_tokens where token_hash = %s", [sha(at)])[0][0]
    return {"at": at, "rt": rt, "client": cid, "grant": grant, "uid": uid}


def check(db, c, request_id):
    return db.anon("select public.oauth_check(%s, %s)", [sha(c["at"]), request_id])


def list_channels(db, c, request_id):
    return db.anon("select public.api_list_channels(%s, %s)", [sha(c["at"]), request_id])


def create(db, c, channel, seconds, idem=None, request_id=None):
    return db.anon("select public.oauth_create_video(%s, %s, %s::jsonb, %s, %s)",
                   [sha(c["at"]), channel, json.dumps({"duration": seconds}), idem, request_id or rid()])


def units(db, grant) -> int:
    """Every rate unit this connection has taken (the counter rows of every minute still kept)."""
    return db.su("select coalesce(sum(count), 0)::int from public.oauth_rate_counters where grant_id = %s", [grant])[0][0]


def credits_left(db, grant) -> int:
    return db.su("select count(*)::int from public.oauth_check_credits where grant_id = %s", [grant])[0][0]


def err(res):
    return res["error"]["code"] if res.get("ok") is False else None


# ── the contract: closed table, internal helpers, the catalog says "every plan" ─────────────────────────────

@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
def test_no_api_role_can_touch_the_credit_table_or_call_its_helpers(db, role):
    uid = U_PAID if role != "anon" else None
    for q in ("select * from public.oauth_check_credits", "delete from public.oauth_check_credits",
              "insert into public.oauth_check_credits (grant_id, request_id) values (gen_random_uuid(), 'req_AAAAAAAAAAAAAAAAAAAAAAAA')",
              "select public.oauth_check_credit_put(gen_random_uuid(), 'req_AAAAAAAAAAAAAAAAAAAAAAAA')",
              "select public.oauth_check_credit_take(gen_random_uuid(), 'req_AAAAAAAAAAAAAAAAAAAAAAAA')"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, uid, q)


def test_the_mcp_entitlement_is_checked_nowhere_and_true_for_every_plan(db):
    assert db.su("select status, default_value::text from public.entitlement_keys where key = 'mcp'")[0] == ("planned", "true")
    assert {p: v for p, v in db.su("select plan_id, value::text from public.plan_entitlements where key = 'mcp'")} == \
        {"free": "true", "creator": "true", "pro": "true", "studio": "true"}
    # Nothing in the database reads it any more: no function body names the key.
    assert db.su("select array_agg(p.proname order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace "
                 "and p.prosrc ~ $$has_entitlement(_internal)?\\([^)]*'mcp'$$")[0][0] is None


# ── every plan may connect ──────────────────────────────────────────────────

def test_a_free_workspace_approves_on_the_consent_screen_and_its_app_works(db):
    uid, org, channel = signup(db)
    assert db.su("select public.org_plan_internal(%s)", [org])[0][0] == "free"
    before = db.su("select count(*) from public.oauth_auth_requests where user_id = %s", [uid])[0][0]
    c = connect(db, uid)  # begin (a request row, the consent data), decide (a grant and a code), exchange (tokens)
    assert db.su("select count(*) from public.oauth_auth_requests where user_id = %s", [uid])[0][0] == before  # single use
    chk = check(db, c, rid())
    assert chk["ok"] is True and chk["data"]["entitled"] is True and chk["data"]["resource"] == RESOURCE
    r = list_channels(db, c, rid())
    assert r["ok"] is True and [x["id"] for x in r["data"]["channels"]] == [channel]
    assert [g["status"] for g in db.user(uid, "select public.oauth_my_grants()")] == ["active"]
    # The refresh token works on Free too (0093 refused it with subscription_required).
    at2, rt2 = "at-" + secrets.token_urlsafe(32), "rt-" + secrets.token_urlsafe(32)
    ref = db.anon("select public.oauth_refresh(%s,%s,%s,%s,%s)", [sha(c["rt"]), c["client"], RESOURCE, sha(at2), sha(rt2)])
    assert ref["ok"] is True, ref


def test_a_lapsed_subscription_no_longer_pauses_the_connection(db):
    c = connect(db, U_PAID)
    db.su("update public.subscriptions set status = 'canceled' where org_id = %s", [ORG_PAID])
    try:
        assert db.su("select public.org_plan_internal(%s)", [ORG_PAID])[0][0] == "free"
        for q in ("select public.api_list_channels(%s, null)", "select public.oauth_get_balance(%s, null)"):
            assert db.anon(q, [sha(c["at"])])["ok"] is True, q
        assert [g["status"] for g in db.user(U_PAID, "select public.oauth_my_grants()") if g["id"] == c["grant"]] == ["active"]
    finally:
        db.su("update public.subscriptions set status = 'active' where org_id = %s", [ORG_PAID])


def test_free_spends_its_welcome_credits_and_is_refused_before_anything_is_held_when_short(db):
    uid, org, channel = signup(db)
    bal = db.su("select balance::float, reserved::float from public.credit_accounts where org_id = %s", [org])[0]
    assert bal == (100.0, 0.0), "the 100 welcome credits of 0027 / 0042"
    c = connect(db, uid)
    short = create(db, c, channel, 120, idem="too-big")  # 180 credits against 100
    assert short["status"] == 402 and err(short) == "insufficient_credits", short
    assert short["error"]["available_credits"] == 100 and short["error"]["price_credits"] == 180
    assert db.su("select count(*) from public.credit_reservations where org_id = %s", [org])[0][0] == 0
    assert db.su("select count(*) from public.render_jobs where channel_id = %s", [channel])[0][0] == 0
    ok = create(db, c, channel, 30, idem="fits")  # 45 credits: the welcome credits pay
    assert ok["ok"] is True and ok["data"]["price_credits"] == 45, ok


def test_a_pack_makes_the_same_connection_work_on_its_next_call(db):
    uid, org, channel = signup(db)
    c = connect(db, uid)
    assert err(create(db, c, channel, 120, idem="v1")) == "insufficient_credits"
    db.su("select public.add_purchased_credits(%s, 1000, %s, 'pack')", [org, "txn_pack_" + uuid.uuid4().hex[:12]])
    r = create(db, c, channel, 120, idem="v1")  # same token, same key, no reconnect
    assert r["ok"] is True and r["data"]["price_credits"] == 180, r


def test_a_plan_makes_the_same_connection_work_on_its_next_call(db):
    uid, org, channel = signup(db)
    c = connect(db, uid)
    assert err(create(db, c, channel, 120, idem="v1")) == "insufficient_credits"
    sub, period = "sub_" + uuid.uuid4().hex[:20], "timestamptz '2026-01-01T00:00:00Z', timestamptz '2099-01-01T00:00:00Z'"
    db.su("select public.upsert_subscription(%s, %s, %s, 'creator', null, 'active', " + period + ", false, null, now())",
          [org, sub, "ctm_" + uuid.uuid4().hex[:20]])
    db.su("select public.grant_subscription_credits(%s, %s, 'creator', " + period + ", %s, 'plan')", [org, sub, "txn_" + uuid.uuid4().hex[:20]])
    r = create(db, c, channel, 120, idem="v1")
    assert r["ok"] is True, r


def test_free_keeps_its_videos_at_once_limit_its_connection_limit_and_revocation(db):
    uid, org, channel = signup(db)
    db.su("select public.grant_credits(%s, 5000, 'top')", [org])
    c = connect(db, uid, limit=100)
    assert create(db, c, channel, 30, idem="one")["ok"] is True                   # 45 of the connection's 100
    busy = create(db, c, channel, 30, idem="two")
    assert busy["status"] == 429 and err(busy) == "run_limit_reached", busy        # Free runs one at a time
    ref = db.su("select job_id from public.credit_reservations where org_id = %s and status = 'open'", [org])[0][0]
    db.su("select public.capture_credits(%s, 45, false)", [ref])  # the video finished: charged, the slot is free again
    capped = create(db, c, channel, 60, idem="three")                               # 45 + 90 > 100
    assert capped["status"] == 402 and err(capped) == "connection_limit_reached", capped
    assert db.user(uid, "select public.oauth_revoke_grant(%s)", [c["grant"]]) is True
    gone = list_channels(db, c, rid())
    assert gone["status"] == 401 and err(gone) == "invalid_api_key"
    assert check(db, c, rid())["status"] == 401


def test_a_free_connection_reaches_no_usd_endpoint(db):
    uid, _org, _channel = signup(db)
    c = connect(db, uid)
    for q in ("select public.api_balance(%s, null)", "select public.api_auth(%s, null)",
              "select public.api_create_video(%s, 'chan-paid-0147', '{}'::jsonb, null, null, null)"):
        r = db.anon(q, [sha(c["at"])])
        assert r["status"] == 403 and err(r) == "not_available_for_connected_apps", (q, r)


# ── one rate unit per tool call ─────────────────────────────────────────────

def test_a_check_and_one_tool_call_cost_one_unit(db):
    c = connect(db, U_PAID)
    before = units(db, c["grant"])
    req = rid()
    assert check(db, c, req)["ok"] is True
    assert credits_left(db, c["grant"]) == 1
    assert list_channels(db, c, req)["ok"] is True
    assert units(db, c["grant"]) == before + 1
    assert credits_left(db, c["grant"]) == 0


def test_a_check_and_two_tool_calls_cost_two_units_the_second_call_is_counted(db):
    c = connect(db, U_PAID)
    before = units(db, c["grant"])
    req = rid()
    check(db, c, req)
    list_channels(db, c, req)
    list_channels(db, c, req)  # the same request id again: the credit is spent, this one takes a unit
    assert units(db, c["grant"]) == before + 2


def test_a_tool_call_with_no_check_behind_it_is_counted(db):
    c = connect(db, U_PAID)
    before = units(db, c["grant"])
    for req in (rid(), rid(), None, "not-a-request-id"):
        list_channels(db, c, req)
    assert units(db, c["grant"]) == before + 4


def test_a_forged_or_reused_request_id_gains_at_most_one_free_call(db):
    c = connect(db, U_PAID)
    before = units(db, c["grant"])
    forged = rid()
    for _ in range(3):  # the same id checked three times: one credit (on conflict do nothing), three counted checks
        check(db, c, forged)
    assert credits_left(db, c["grant"]) == 1
    for _ in range(5):
        list_channels(db, c, forged)
    # 3 checks + 5 calls = 8 database calls; one of them free.
    assert units(db, c["grant"]) == before + 7


def test_a_refused_check_leaves_no_credit(db):
    c = connect(db, U_PAID)
    # An unknown token, a malformed id and a check over the limit: nothing to take afterwards.
    assert db.anon("select public.oauth_check(%s, %s)", [sha("nobody"), rid()])["status"] == 401
    for bad in ("req_short", "REQ_AAAAAAAAAAAAAAAAAAAAAAAA", "req_AAAAAAAAAAAAAAAAAAAAAAA!", "req_" + "A" * 25, None):
        assert check(db, c, bad)["ok"] is True
    assert credits_left(db, c["grant"]) == 0
    db.su("insert into public.oauth_rate_counters (grant_id, minute, count) values (%s, date_trunc('minute', now()), 500) "
          "on conflict (grant_id, minute) do update set count = 500", [c["grant"]])
    req = rid()
    limited = check(db, c, req)
    assert limited["status"] == 429 and err(limited) == "rate_limit_exceeded"
    assert credits_left(db, c["grant"]) == 0
    assert list_channels(db, c, req)["status"] == 429


def test_calls_racing_for_one_credit_get_exactly_one_free(db):
    c = connect(db, U_PAID)
    req = rid()
    check(db, c, req)
    before = units(db, c["grant"])
    n = 8
    # Hold the credit's row so every racer is queued on it, then let them all go at once.
    holder = psycopg.connect(db.dsn, autocommit=False)
    holder.execute("select 1 from public.oauth_check_credits where grant_id = %s and request_id = %s for update", [c["grant"], req])
    started = threading.Barrier(n + 1)

    def racer():
        started.wait()
        return list_channels(db, c, req)

    with cf.ThreadPoolExecutor(n) as pool:
        futures = [pool.submit(racer) for _ in range(n)]
        started.wait()
        holder.commit()
        holder.close()
        answers = [f.result(timeout=60) for f in futures]
    assert all(a["ok"] is True for a in answers), answers
    assert units(db, c["grant"]) == before + n - 1
    assert credits_left(db, c["grant"]) == 0


def test_a_credit_older_than_a_minute_is_not_taken_and_old_credits_are_pruned(db):
    c = connect(db, U_PAID)
    old = rid()
    db.su("insert into public.oauth_check_credits (grant_id, request_id, created_at) values (%s, %s, now() - interval '61 seconds')",
          [c["grant"], old])
    stale = rid()
    db.su("insert into public.oauth_check_credits (grant_id, request_id, created_at) values (%s, %s, now() - interval '3 minutes')",
          [c["grant"], stale])
    before = units(db, c["grant"])
    list_channels(db, c, old)
    assert units(db, c["grant"]) == before + 1
    check(db, c, rid())  # the next put prunes this grant's credits older than two minutes
    left = {r[0] for r in db.su("select request_id from public.oauth_check_credits where grant_id = %s", [c["grant"]])}
    assert stale not in left and old in left and len(left) == 2


def test_a_credit_is_one_connections_and_dies_with_it(db):
    a = connect(db, U_PAID)
    b = connect(db, U_PAID)
    req = rid()
    check(db, a, req)
    before = units(db, b["grant"])
    list_channels(db, b, req)  # another connection's credit is not this one's
    assert units(db, b["grant"]) == before + 1 and credits_left(db, a["grant"]) == 1
    db.su("delete from public.oauth_grants where id = %s", [a["grant"]])
    assert credits_left(db, a["grant"]) == 0


def test_120_a_minute_is_120_tool_calls_and_the_admitted_call_is_never_refused_for_the_checks_unit(db):
    rpm = db.su("select (public.oauth_limits() ->> 'rpm')::int")[0][0]
    for _attempt in range(3):  # a run that straddles a minute boundary is repeated, not judged
        c = connect(db, U_PAID)
        minute = db.su("select date_trunc('minute', now())")[0][0]
        db.su("insert into public.oauth_rate_counters (grant_id, minute, count) values (%s, %s, %s)", [c["grant"], minute, rpm - 3])
        answers = []
        for _ in range(4):
            req = rid()
            chk = check(db, c, req)
            if not chk["ok"]:
                answers.append(("check", chk["status"]))
                continue
            call = list_channels(db, c, req)
            answers.append(("call", 200 if call["ok"] else call["status"]))
        if db.su("select date_trunc('minute', now())")[0][0] == minute:
            break
    else:
        pytest.skip("three runs straddled a minute boundary")
    # The checks take units rpm-2, rpm-1 and rpm and are let through; their calls read those counts and are not refused
    # (the test stays `>`). The fourth check is unit rpm+1 and is refused. Under 0093 each call took a unit of its own: the first
    # pair took rpm-2 and rpm-1, the second check took rpm, and the second call (rpm+1) was already refused.
    assert answers == [("call", 200), ("call", 200), ("call", 200), ("check", 429)], answers


def test_a_batch_of_tool_calls_under_one_check_costs_one_unit_each(db):
    c = connect(db, U_PAID)
    before = units(db, c["grant"])
    req = rid()
    check(db, c, req)
    list_channels(db, c, req)
    db.anon("select public.oauth_get_balance(%s, %s)", [sha(c["at"]), req])
    db.anon("select public.api_list_videos(%s, null, 10, 0, %s)", [sha(c["at"]), req])
    assert units(db, c["grant"]) == before + 3  # one check + three tool calls: three units, the API-key door's count


# ── registrations: an AI vendor's shared server registers for every person ─────────────────────────────────────

CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback"
CHATGPT_CB = "https://chatgpt.com/connector_platform_oauth_redirect"
GROK_CB = "https://grok.com/connectors-oauth-exchange-code/"
GEMINI_CB = "https://oauth-redirect.googleusercontent.com/r/my-gemini-project"
ORDINARY = "https://app.example.com/cb"


def register(db, uris, ip):
    return db.anon("select public.oauth_register_client(%s, %s, %s)", ["Test app", list(uris), ip])


def limits(db):
    return db.su("select public.oauth_limits()")[0][0]


def test_a_vendor_callback_registers_at_least_200_an_hour_from_one_address_and_stops_at_its_own_limit(db):
    ip = "160.79.104." + uuid.uuid4().hex[:6]  # Anthropic's published range: one server for every person
    answers = [register(db, (CLAUDE_CB,), ip) for _ in range(200)]
    assert all(a["ok"] for a in answers), [a for a in answers if not a["ok"]][:2]
    ip_hash = db.su("select ip_hash from public.oauth_clients where client_id = %s", [answers[0]["client_id"]])[0][0]
    per_ip = limits(db)["register_vendor_per_ip_hour"]
    db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) select 'vendor-fill', array[%s], %s "
          "from generate_series(1, %s)", [CHATGPT_CB, ip_hash, per_ip - 200])
    try:
        refused = register(db, (CLAUDE_CB,), ip)
        assert refused["ok"] is False and refused["error"] == "rate_limited", refused
        # The same address keeps the ordinary class's own 10: one class cannot spend the other's budget.
        assert register(db, (ORDINARY,), ip)["ok"] is True
    finally:
        db.su("delete from public.oauth_clients where ip_hash = %s", [ip_hash])


@pytest.mark.parametrize("callback", [CLAUDE_CB, CHATGPT_CB, "https://chatgpt.com/connector/oauth/g-AbC123", GROK_CB, GEMINI_CB,
                                      "https://oauth-redirect.googleusercontent.com/a/my-gemini-project"])
def test_each_vendor_callback_passes_the_11th_registration_from_one_address(db, callback):
    ip = "198.51.100." + uuid.uuid4().hex[:6]
    answers = [register(db, (callback,), ip) for _ in range(15)]
    try:
        assert all(a["ok"] for a in answers), [a for a in answers if not a["ok"]][:2]
    finally:
        db.su("delete from public.oauth_clients where client_id = any(%s::uuid[])", [[a["client_id"] for a in answers if a.get("ok")]])


def test_an_arbitrary_redirect_from_one_address_is_still_limited_to_10_an_hour(db):
    ip = "198.18.47." + uuid.uuid4().hex[:6]
    for uris in ((ORDINARY,), (CLAUDE_CB, ORDINARY)):  # one non-vendor URI makes the whole registration ordinary
        answers = [register(db, uris, ip + str(len(uris))) for _ in range(12)]
        assert [a["ok"] for a in answers] == [True] * 10 + [False] * 2, uris
        assert {a["error"] for a in answers if not a["ok"]} == {"rate_limited"}


def test_the_class_is_what_the_stored_uris_say(db):
    for uris, vendor in (((CLAUDE_CB,), True), ((CHATGPT_CB,), True), (("https://chatgpt.com/connector/oauth/AbC_12-x",), True),
                         ((CLAUDE_CB, CHATGPT_CB), True), ((CLAUDE_CB, ORDINARY), False), ((CLAUDE_CB + "/x",), False),
                         (("https://chatgpt.com/connector/oauth/a/b",), False), (("https://claude.ai.evil.example/api/mcp/auth_callback",), False),
                         (("http://127.0.0.1:33418/callback",), False),
                         ((GROK_CB,), True), ((GROK_CB.rstrip("/"),), False), (("https://grok.com.evil.example/connectors-oauth-exchange-code/",), False),
                         ((GEMINI_CB,), True), (("https://oauth-redirect.googleusercontent.com/a/abc.Def_9~x",), True),
                         (("https://oauth-redirect.googleusercontent.com/r/a/b",), False),
                         (("https://oauth-redirect.googleusercontent.com/r/..",), False),
                         (("https://oauth-redirect.googleusercontent.com/x/project",), False),
                         (("https://oauth-redirect-sandbox.googleusercontent.com/r/my-gemini-project",), False),
                         (("https://oauth-redirect.googleusercontent.com.evil.example/r/p",), False),
                         ((CLAUDE_CB, CHATGPT_CB, GROK_CB, GEMINI_CB), True), ((GEMINI_CB, ORDINARY), False)):
        r = register(db, uris, "203.0.113." + uuid.uuid4().hex[:8])
        assert r["ok"] is True, (uris, r)
        assert db.su("select vendor from public.oauth_clients where client_id = %s", [r["client_id"]])[0][0] is vendor, uris
    # A row written any other way is classed the same (the column is generated, nobody can set it).
    with pytest.raises(psycopg.Error):
        db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash, vendor) values ('x', array[%s], %s, true)",
              [ORDINARY, sha("x")])


def test_the_hourly_ceilings_still_hold_and_are_per_class(db):
    lim = limits(db)
    db.su("update public.oauth_clients set created_at = now() - interval '2 hours' where created_at > now() - interval '1 hour'")
    try:
        db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) select 'vendor-flood', array[%s], md5(g::text) || md5(g::text) "
              "from generate_series(1, %s) g", [CLAUDE_CB, lim["register_vendor_global_hour"]])
        refused = register(db, (CLAUDE_CB,), "160.79.105." + uuid.uuid4().hex[:6])
        assert refused["ok"] is False and refused["error"] == "rate_limited", refused
        assert register(db, (ORDINARY,), "203.0.113." + uuid.uuid4().hex[:8])["ok"] is True  # the ordinary budget is untouched
        db.su("delete from public.oauth_clients where client_name = 'vendor-flood'")
        db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) select 'plain-flood', array[%s], md5(g::text) || md5(g::text) "
              "from generate_series(1, %s) g", [ORDINARY, lim["register_global_hour"]])
        assert register(db, (ORDINARY,), "203.0.113." + uuid.uuid4().hex[:8])["error"] == "rate_limited"
        assert register(db, (CLAUDE_CB,), "160.79.106." + uuid.uuid4().hex[:6])["ok"] is True
    finally:
        db.su("delete from public.oauth_clients where client_name in ('vendor-flood', 'plain-flood')")


def test_the_row_caps_are_per_class_and_the_ceiling_times_a_day_stays_under_the_vendor_cap(db):
    lim = limits(db)
    assert lim["register_vendor_global_hour"] * 24 < lim["max_vendor_clients"]
    assert (lim["register_per_ip_hour"], lim["register_global_hour"], lim["max_clients"]) == (10, 300, 20000)  # 0093's, unchanged
    have = db.su("select count(*) from public.oauth_clients where vendor")[0][0]
    db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash, created_at) select 'vendor-cap', array[%s], "
          "md5(g::text) || md5(g::text), now() - interval '2 hours' from generate_series(1, %s) g", [CLAUDE_CB, lim["max_vendor_clients"] - have])
    try:
        closed = register(db, (CLAUDE_CB,), "160.79.107." + uuid.uuid4().hex[:6])
        assert closed["ok"] is False and closed["error"] == "rate_limited" and "closed" in closed["description"], closed
        assert register(db, (ORDINARY,), "203.0.113." + uuid.uuid4().hex[:8])["ok"] is True
    finally:
        db.su("delete from public.oauth_clients where client_name = 'vendor-cap'")


# ── rows stay bounded now that Free can approve (review of #713) ─────────────────────────────────────────────

def approve(db, uid, cid=None):
    """Begin and Allow on the consent screen, without redeeming the code: what one decision answers."""
    cid = cid or client(db)
    _, challenge = pkce()
    _, secret = begin(db, uid, cid, challenge)
    return db.user(uid, "select public.oauth_decide_authorization(%s, true, 500::numeric, %s)", [sha(secret), sha("code-" + secrets.token_urlsafe(16))])


def age(db, hours, grants=(), clients=()):
    """Move rows back in time, as if `hours` had passed since they were made."""
    db.su("update public.oauth_grants set created_at = created_at - make_interval(hours => %s), "
          "activated_at = activated_at - make_interval(hours => %s), revoked_at = revoked_at - make_interval(hours => %s) "
          "where id = any(%s::uuid[])", [hours, hours, hours, list(grants)])
    db.su("update public.oauth_clients set created_at = created_at - make_interval(hours => %s), "
          "last_authorized_at = last_authorized_at - make_interval(hours => %s) where client_id = any(%s::uuid[])",
          [hours, hours, list(clients)])


def test_connect_and_revoke_in_a_loop_stops_at_the_daily_cap_and_the_rows_go_a_day_later(db):
    # The reviewer's loop: register (a vendor callback), Allow, redeem the code, revoke. Under 0093 every cycle kept its
    # registration alive 30 days (the collector never took a client with a grant), and the live cap (20) never bit.
    uid, org, _ = signup(db)
    cap = limits(db)["max_new_grants_per_user_day"]
    assert cap == 50
    cycles = []
    for _ in range(cap):
        c = connect(db, uid)
        assert db.user(uid, "select public.oauth_revoke_grant(%s)", [c["grant"]]) is True
        cycles.append(c)
    assert db.su("select bool_and(vendor) from public.oauth_clients where client_id = any(%s::uuid[])", [[c["client"] for c in cycles]])[0][0]
    refused = approve(db, uid)
    assert refused == {"ok": False, "error": "too_many_connections_today"}, refused
    assert db.su("select count(*) from public.oauth_grants where user_id = %s", [uid])[0][0] == cap  # the refusal made nothing

    # A client with a live grant, and one whose grant ended only an hour ago, must survive the collection below.
    db.su("delete from public.oauth_grants where user_id = %s and id <> all(%s::uuid[])", [uid, [c["grant"] for c in cycles[:48]]])
    live = connect(db, uid)
    recent = connect(db, uid)
    db.user(uid, "select public.oauth_revoke_grant(%s)", [recent["grant"]])
    ended = cycles[:48]
    age(db, 25, grants=[c["grant"] for c in ended] + [live["grant"], recent["grant"]],
        clients=[c["client"] for c in ended] + [live["client"], recent["client"]])
    db.su("update public.oauth_grants set revoked_at = now() - interval '1 hour' where id = %s", [recent["grant"]])
    db.su("select public.oauth_gc()")
    left = {r[0] for r in db.su("select client_id::text from public.oauth_clients where client_id = any(%s::uuid[])",
                                 [[c["client"] for c in ended] + [live["client"], recent["client"]]])}
    assert left == {live["client"], recent["client"]}, len(left)
    assert db.su("select count(*) from public.oauth_grants where id = any(%s::uuid[])", [[c["grant"] for c in ended]])[0][0] == 0
    assert list_channels(db, live, rid())["ok"] is True  # the live connection is untouched
    # A day on, the person may connect again: the cap is a rolling day, not a ban.
    assert approve(db, uid)["ok"] is True


def test_a_consent_in_progress_survives_the_collection_and_the_client_goes_once_it_expires(db):
    # Delta review of #713: one person connected and revoked a day ago; another opens the consent screen on the SAME client (a
    # vendor that reuses one client id, as ChatGPT does). A collection triggered by anyone's registration must not delete
    # the client (that cascades to the open request and turns their Allow into `expired`).
    first, _, _ = signup(db)
    second, _, _ = signup(db)

    def ended_a_day_ago():
        c = connect(db, first)
        db.user(first, "select public.oauth_revoke_grant(%s)", [c["grant"]])
        age(db, 25, grants=[c["grant"]], clients=[c["client"]])
        return c["client"]

    def present(cid):
        return db.su("select count(*) from public.oauth_clients where client_id = %s", [cid])[0][0] == 1

    kept = ended_a_day_ago()
    _, challenge = pkce()
    _, secret = begin(db, second, kept, challenge)
    client(db)  # someone else's registration runs the collector
    db.su("select public.oauth_gc()")
    assert present(kept)
    dec = db.user(second, "select public.oauth_decide_authorization(%s, true, 500::numeric, %s)", [sha(secret), sha("code-" + secrets.token_urlsafe(16))])
    assert dec["ok"] is True and dec["allowed"] is True, dec

    gone = ended_a_day_ago()
    _, challenge = pkce()
    begin(db, second, gone, challenge)
    db.su("select public.oauth_gc()")
    assert present(gone)  # still on the consent screen
    db.su("update public.oauth_auth_requests set expires_at = now() - interval '1 second' where client_id = %s", [gone])
    db.su("select public.oauth_gc()")
    assert not present(gone)  # the request expired: nothing keeps the client any more


def test_a_workspace_is_capped_across_its_admins(db):
    uid, org, _ = signup(db)
    cap = limits(db)["max_new_grants_per_org_day"]
    assert cap == 200
    cid = client(db)
    others = [str(uuid.uuid4()) for _ in range(5)]
    for o in others:  # 5 admins x 40 = the workspace's 200, each under the per-person 50
        db.su("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [o, f"adm-{o[:8]}@example.test"])
        db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin')", [org, o, f"adm-{o[:8]}@example.test"])
        db.su("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits, activated_at, revoked_at) "
              "select %s, %s, %s, array['videos:read'], %s, 0, now(), now() from generate_series(1, 40)", [o, org, cid, RESOURCE])
    assert approve(db, uid) == {"ok": False, "error": "too_many_connections_today"}
    other_uid, _, _ = signup(db)
    assert approve(db, other_uid)["ok"] is True  # another workspace is not affected
    db.su("delete from public.oauth_grants where org_id = %s", [org])


def test_two_approvals_racing_at_the_cap_let_exactly_one_through(db):
    uid, org, _ = signup(db)
    cid = client(db)
    db.su("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits, activated_at, revoked_at) "
          "select %s, %s, %s, array['videos:read'], %s, 0, now(), now() from generate_series(1, %s)",
          [uid, org, cid, RESOURCE, limits(db)["max_new_grants_per_user_day"] - 1])
    secrets_ = []
    for _ in range(2):
        _, challenge = pkce()
        _, secret = begin(db, uid, client(db), challenge)
        secrets_.append(secret)
    barrier = threading.Barrier(2)

    def go(secret):
        barrier.wait()
        return db.user(uid, "select public.oauth_decide_authorization(%s, true, 500::numeric, %s)", [sha(secret), sha("code-" + secrets.token_urlsafe(16))])

    with cf.ThreadPoolExecutor(2) as ex:
        answers = list(ex.map(go, secrets_))
    assert sorted(a.get("error", "ok") for a in answers) == ["ok", "too_many_connections_today"], answers


# ── the API key's spend limits name the remedy; everything else is 0042's ─────────────────────────────────────

def test_the_key_limit_refusal_names_where_it_is_raised(db):
    r = db.anon("select public.api_create_video(%s, 'chan-paid-0147', %s::jsonb, null, null, 'req_t')", [sha(KEY), json.dumps({"duration": 120})])
    assert r["status"] == 402 and err(r) == "key_limit_reached", r
    assert "Developers → API keys → Set limit on this key" in r["error"]["message"]
    assert r["error"]["limit_cents"] == 100 and r["error"]["price_cents"] == 240


def test_the_monthly_limit_refusal_names_where_it_is_raised(db):
    db.su("update public.api_keys set monthly_limit_cents = null where key_hash = %s", [sha(KEY)])
    db.su("update public.api_settings set monthly_limit_cents = 100 where org_id = %s", [ORG_PAID])
    try:
        r = db.anon("select public.api_create_video(%s, 'chan-paid-0147', %s::jsonb, null, null, 'req_t')", [sha(KEY), json.dumps({"duration": 120})])
        assert r["status"] == 402 and err(r) == "monthly_limit_reached", r
        msg = r["error"]["message"]
        assert msg.startswith("This video would take the organization past its monthly API spend limit. ")
        assert "Developers → Usage and billing → Monthly spend limit" in msg and "usage tier's cap" in msg
        assert set(r["error"]) >= {"limit_cents", "month_spend_cents", "price_cents"}
    finally:
        db.su("update public.api_settings set monthly_limit_cents = null where org_id = %s", [ORG_PAID])
        db.su("update public.api_keys set monthly_limit_cents = 100 where key_hash = %s", [sha(KEY)])


# ── replay, rollback, re-apply, drift guard ─────────────────────────────────

def test_replaying_0147_changes_nothing(db):
    c = connect(db, U_PAID)
    req = rid()
    check(db, c, req)
    db.apply(MIGRATION)
    db.apply(MIGRATION)
    assert credits_left(db, c["grant"]) == 1  # a replay keeps the table and its rows
    before = units(db, c["grant"])
    assert list_channels(db, c, req)["ok"] is True
    assert units(db, c["grant"]) == before


def test_the_rollback_puts_0093_back_and_0147_brings_the_free_connection_back_without_reconnecting(db):
    uid, org, channel = signup(db)
    c = connect(db, uid)
    paid = connect(db, U_PAID)
    db.apply(ROLLBACK)
    try:
        assert db.su("select to_regclass('public.oauth_check_credits') is null")[0][0] is True
        assert db.su("select status from public.entitlement_keys where key = 'mcp'")[0][0] == "enforced"
        paused = list_channels(db, c, rid())
        assert paused["status"] == 403 and err(paused) == "subscription_required", paused
        assert [g["status"] for g in db.user(uid, "select public.oauth_my_grants()")] == ["paused_plan"]
        res, _ = begin(db, uid, client(db), pkce()[1])
        assert res["ok"] and res["entitled"] is False
        # 0093's count is back: a check and a tool call are two units again.
        before = units(db, paid["grant"])
        req = rid()
        check(db, paid, req)
        list_channels(db, paid, req)
        assert units(db, paid["grant"]) == before + 2
        # 0042's sentence is back.
        r = db.anon("select public.api_create_video(%s, 'chan-paid-0147', %s::jsonb, null, null, 'req_t')", [sha(KEY), json.dumps({"duration": 120})])
        assert r["error"]["message"] == "This video would take this key past its own monthly spend limit."
    finally:
        db.apply(MIGRATION)
    assert list_channels(db, c, rid())["ok"] is True  # the same token, no reconnect
    assert [g["status"] for g in db.user(uid, "select public.oauth_my_grants()")] == ["active"]


def test_the_rollback_puts_back_each_plans_own_mcp_value_not_a_guess(db):
    # Before 0147 an admin had set a paid plan false; 0147 made it true; the rollback must make it false again.
    db.apply(ROLLBACK)
    try:
        db.su("update public.plan_entitlements set value = 'false'::jsonb where key = 'mcp' and plan_id = 'pro'")
        db.apply(MIGRATION)
        assert db.su("select value from public.plan_entitlements where key = 'mcp' and plan_id = 'pro'")[0][0] is True
        assert db.su("select value from public.oauth_mcp_entitlement_before_0147 where plan_id = 'pro'")[0][0] is False
        db.apply(MIGRATION)  # a replay keeps the first record
        assert db.su("select value from public.oauth_mcp_entitlement_before_0147 where plan_id = 'pro'")[0][0] is False
        db.apply(ROLLBACK)
        vals = dict(db.su("select plan_id, value from public.plan_entitlements where key = 'mcp'"))
        assert vals["pro"] is False and vals["free"] is False and vals["creator"] is True, vals
        assert db.su("select to_regclass('public.oauth_mcp_entitlement_before_0147') is null")[0][0] is True
        db.su("update public.plan_entitlements set value = 'true'::jsonb where key = 'mcp' and plan_id = 'pro'")
    finally:
        db.apply(MIGRATION)
    assert db.su("select bool_and(value = 'true'::jsonb) from public.plan_entitlements where key = 'mcp'")[0][0] is True


def test_the_rollback_refuses_a_body_that_is_not_0147s(db):
    real = db.su("select pg_get_functiondef('public.oauth_check_credit_take(uuid,text)'::regprocedure)")[0][0]
    db.su("create or replace function public.oauth_check_credit_take(p_grant uuid, p_request_id text) returns boolean "
          "language plpgsql volatile security definer set search_path = public, pg_temp as $$ begin return false; end $$")
    try:
        with pytest.raises(psycopg.Error, match="is not 0147's body"):
            db.apply(ROLLBACK)
        assert db.su("select to_regclass('public.oauth_check_credits') is not null")[0][0] is True
    finally:
        db.su(real)
        db.su("revoke all on function public.oauth_check_credit_take(uuid, text) from public, anon, authenticated, service_role")


def test_the_drift_guard_refuses_a_body_it_was_not_written_on(db):
    real = db.su("select pg_get_functiondef('public.oauth_my_grants()'::regprocedure)")[0][0]
    db.su("create or replace function public.oauth_my_grants() returns jsonb language plpgsql stable security definer "
          "set search_path = public, pg_temp as $$ begin return '[]'::jsonb; end $$")
    try:
        with pytest.raises(psycopg.Error, match="neither the one it was written on nor 0147"):
            db.apply(MIGRATION)
    finally:
        db.su(real)
    db.apply(MIGRATION)


def test_the_files_name_their_numbers(db):
    text = MIGRATION.read_text(encoding="utf-8")
    assert re.search(r"live is at 0146", text) and "0148 is reserved" in text
