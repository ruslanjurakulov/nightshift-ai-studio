"""The Studio for a connected assistant (0191), attacked in a real database.

The MCP tools quote_creative / create_creative / get_creative_job / list_creative_models / list_media call 0191's five doors with the
anon key and the access token's hash, the way PostgREST does. These prove:

* every model is off for assistants unless its registry spec says JSON true (a string "true" is off), independently of api_exposure
  (a web-only model can be on for assistants and still never reach an API key, and an API-sold model is not thereby an assistant's);
  a model that needs a rights acknowledgement is refused with its own word before anything is priced;
* the quote is creative_price's, kept for ONE connection: another connection of the same workspace, another workspace's connection
  and an API key all read it as unknown; an expired quote, a used quote and a moved price are refused and nothing is held;
* create takes nothing but the quote and the key, so the job runs exactly the quoted capability, model and params, and the hold
  equals the quote; there is no create without a quote; one key creates once; the connection's monthly limit counts generations
  alongside videos and refuses past it; another workspace's media file is refused at the quote;
* every create writes the api_requests row and the creative.generate audit row the API path writes; only anon may call the doors and
  no API role reads the records; the rate buckets refuse a loop; the migration replays, and its rollback refuses while a connection
  holds the permission, then restores 0093's bodies.

Runs in its own scratch database (it commits).
"""

import hashlib
import json
import os
import time
import uuid

import psycopg
import pytest

import sec_db

MIGRATION = sec_db.MIGRATIONS / "0191_mcp_oauth_creative.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0191_mcp_oauth_creative.sql"
ORG_A = "aaaaaaaa-0000-0000-0000-000000000176"
ORG_B = "bbbbbbbb-0000-0000-0000-000000000176"
UA = str(uuid.UUID(int=0xA175))
UB = str(uuid.UUID(int=0xB175))
# A workspace with only 5 credits: a 6-credit generation does not fit.
ORG_C = "cccccccc-0000-0000-0000-000000000176"
UC = str(uuid.UUID(int=0xC175))
RESOURCE = "https://nightshift-ai.studio/api/mcp"
ALL = ["videos:read", "videos:create", "videos:publish", "studio:create"]
PROMPT = {"prompt": "a lighthouse at dawn"}

# (id, capabilities, extra spec)
MODELS = [
    # On for assistants and never for API keys: the vendor's web + connector permission (0188's web_mcp) and the switch.
    ("img-on", ["t2i", "edit"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True}),
    # The switch on a model whose vendor said web only: the 'mcp' surface refuses it (Lens on 0191).
    ("img-webonly", ["t2i"], {"api_exposure": "web_only", "mcp_oauth_exposure": True}),
    ("img-off", ["t2i"], {}),
    ("img-api", ["t2i"], {"api_exposure": "any"}),
    ("img-string", ["t2i"], {"mcp_oauth_exposure": "true"}),
    ("img-ack", ["t2i", "edit"], {"mcp_oauth_exposure": True, "requires_acknowledgement": ["likeness_photo"]}),
    ("img-later", ["t2i"], {"mcp_oauth_exposure": True}),
]
API_KEY_HASH = hashlib.sha256(b"mcp-oauth-creative-api-key").hexdigest()


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
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


def setup(d: Db) -> None:
    d.su("insert into auth.users (id, email) values (%s,'a@c175.io'),(%s,'b@c175.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-a-c175'),(%s,'B','org-b-c175')", [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@c175.io','owner'),(%s,%s,'b@c175.io','owner')",
         [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])
    d.su("insert into auth.users (id, email) values (%s,'c@c175.io')", [UC])
    d.su("insert into public.organizations (id, name, slug) values (%s,'C','org-c-c175')", [ORG_C])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'c@c175.io','owner')", [ORG_C, UC])
    d.su("select public.grant_credits(%s, 5, 'test')", [ORG_C])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    rows = [{"id": m, "display_name": m.upper(), "provider": "acme", "adapter": "image.acme", "capabilities": caps,
             "credit_unit": f"model_{m.replace('-', '_')}_image", "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "image", **extra}}
            for m, caps, extra in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, _x in MODELS:
        for cap in caps:
            d.su("select public.record_model_probe(%s, 'image.acme', %s, %s, true, null, null, 10, 100, 'security-lab')",
                 [m, "acme-" + m, cap])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 4, 0.5) on conflict (unit) do nothing",
             [f"model_{m.replace('-', '_')}_image"])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit")
    # An API key of org A, to prove the doors are a connection's only.
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1')", [ORG_A, UA])
    d.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s,'k',%s,%s,%s)",
         [ORG_A, API_KEY_HASH, UA, ["creative:quote", "creative:create", "creative:read"]])


def connection(d: Db, uid, org, scopes=ALL, limit=500):
    """A live access token of a connected app, the way 0093's exchange leaves it: (token hash, grant id)."""
    cid = d.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) values "
               "('lab', array['https://claude.ai/api/mcp/auth_callback'], %s) returning client_id::text",
               [hashlib.sha256(uuid.uuid4().bytes).hexdigest()])[0][0]
    grant = d.su("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits, activated_at) "
                 "values (%s,%s,%s,%s,%s,%s,now()) returning id::text", [uid, org, cid, scopes, RESOURCE, limit])[0][0]
    h = hashlib.sha256(("at-" + uuid.uuid4().hex).encode()).hexdigest()
    d.su("insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values (%s,%s,'access',now() + interval '1 hour')",
         [h, grant])
    assert d.su("select public.oauth_token_state(%s) is not null", [h])[0][0]
    return h, grant


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_mcp_oacr_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    setup(d)
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def quote(db, tok, model="img-on", cap="t2i", params=PROMPT):
    return db.act("anon", None, "select public.oauth_creative_quote(%s,%s,%s,%s::jsonb,null)", [tok, cap, model, json.dumps(params)])[0][0]


def create(db, tok, quote_id, idem):
    return db.act("anon", None, "select public.oauth_creative_create(%s,%s,%s,null)", [tok, quote_id, idem])[0][0]


def get(db, tok, job):
    return db.act("anon", None, "select public.oauth_creative_get(%s,%s,null)", [tok, job])[0][0]


def models(db, tok, cap=None):
    return db.act("anon", None, "select public.oauth_creative_models(%s,%s,null)", [tok, cap])[0][0]


def code(res):
    return res["error"]["code"] if res.get("ok") is False else None


def credits(db, org):
    return tuple(float(x) for x in db.su("select balance, reserved from public.credit_accounts where org_id=%s", [org])[0])


def asset(db, org):
    aid = str(uuid.uuid4())
    db.act("service_role", None,
           "select public.register_asset(%s, %s, 'image', 'image/png', 1000, %s, 'generated', p_width => 64, p_height => 64, "
           "p_provenance => '{\"job_id\": \"seed\"}'::jsonb)",
           [aid, org, uuid.uuid4().hex * 2])
    return aid


# ── every model is off unless its own spec says JSON true ──────────────────

def test_the_list_is_only_the_models_switched_on_for_assistants(db):
    tok, _g = connection(db, UA, ORG_A)
    res = models(db, tok)
    assert res["ok"], res
    listed = {m["id"]: m for m in res["data"]["models"]}
    # img-off has no switch, img-api is API-sold (that is not an assistant's permission), img-string says "true" as a string,
    # img-ack needs a rights acknowledgement: none is listed.
    assert sorted(listed) == ["img-later", "img-on"], res
    assert listed["img-on"]["capabilities"] == ["edit", "t2i"]
    assert "credits" not in json.dumps(listed) and "credits_per_unit" not in json.dumps(listed)
    # And the API key's list is untouched by the assistant's switch: the web-only model never reaches a key.
    key = db.act("anon", None, "select public.api_creative_models(%s,null,null)", [API_KEY_HASH])[0][0]
    assert "img-on" not in [m["id"] for m in key["data"]["models"]] and "img-api" in [m["id"] for m in key["data"]["models"]], key


@pytest.mark.parametrize("model", ["img-off", "img-api", "img-string", "no-such-model"])
def test_a_model_off_for_assistants_is_refused_before_any_price(db, model):
    tok, grant = connection(db, UA, ORG_A)
    res = quote(db, tok, model)
    assert res["status"] == 422 and code(res) == "model_not_offered", res
    assert db.su("select count(*) from public.oauth_creative_quotes where grant_id=%s", [grant])[0][0] == 0


def test_a_model_needing_an_acknowledgement_is_refused_with_its_own_word(db):
    tok, grant = connection(db, UA, ORG_A)
    res = quote(db, tok, "img-ack")
    assert res["status"] == 428 and code(res) == "acknowledgement_required", res
    assert db.su("select count(*) from public.oauth_creative_quotes where grant_id=%s", [grant])[0][0] == 0


# ── quote, then create: the hold is the quote ──────────────────────────────

def test_quote_then_create_holds_exactly_the_quote_and_writes_the_api_paths_rows(db):
    tok, grant = connection(db, UA, ORG_A)
    before = credits(db, ORG_A)
    q = quote(db, tok)
    assert q["ok"] and q["status"] == 201, q
    qd = q["data"]
    assert qd["credits"] == 6 and qd["model"] == "img-on" and qd["params"] == PROMPT, qd
    # The quote holds nothing.
    assert credits(db, ORG_A) == before
    res = create(db, tok, qd["quote_id"], "first-" + uuid.uuid4().hex)
    assert res["ok"] and res["status"] == 201, res
    job = res["data"]["id"]
    row = db.su("select capability, requested_model, params, quoted_credits, credit_ref, requested_by::text from public.creative_jobs where id=%s", [job])[0]
    assert row[0] == "t2i" and row[1] == "img-on" and row[2]["prompt"] == PROMPT["prompt"] and float(row[3]) == 6 and row[5] == UA, row
    hold = db.su("select amount, status from public.credit_reservations where job_id=%s", [row[4]])[0]
    assert float(hold[0]) == qd["credits"] and hold[1] == "open", hold
    assert credits(db, ORG_A) == (before[0], before[1] + 6)
    link = db.su("select grant_id::text, quote_id::text, quoted_credits from public.oauth_creative_jobs where job_id=%s", [job])[0]
    assert link[0] == grant and link[1] == qd["quote_id"] and float(link[2]) == 6
    assert float(db.su("select public.oauth_grant_month_credits(%s)", [grant])[0][0]) == 6
    audit = db.su("select action, detail ->> 'via', detail ->> 'grant_id', actor_user_id::text from public.app_audit_log where target=%s", [job])
    assert audit == [("creative.generate", "mcp_oauth", grant, UA)], audit
    logged = db.su("select endpoint, status from public.api_requests where org_id=%s and endpoint like 'oauth.creative.%%' order by created_at", [ORG_A])
    assert ("oauth.creative.quote", 201) in logged and ("oauth.creative.create", 201) in logged, logged


def test_another_workspaces_file_is_refused_at_the_quote(db):
    tok, grant = connection(db, UA, ORG_A)
    theirs = asset(db, ORG_B)
    res = quote(db, tok, "img-on", "edit", {"prompt": "make it night", "source_asset_id": theirs})
    assert res["status"] == 422 and code(res) == "source_unavailable", res
    assert db.su("select count(*) from public.oauth_creative_quotes where grant_id=%s", [grant])[0][0] == 0
    # The workspace's own file is fine, and list_media names only its own files.
    mine = asset(db, ORG_A)
    assert quote(db, tok, "img-on", "edit", {"prompt": "make it night", "source_asset_id": mine})["ok"]
    media = db.act("anon", None, "select public.oauth_media_list(%s,'image',100,null)", [tok])[0][0]
    ids = [m["asset_id"] for m in media["data"]["media"]]
    assert mine in ids and theirs not in ids, media


def test_a_quote_is_not_usable_by_another_connection_or_an_api_key(db):
    tok, _g = connection(db, UA, ORG_A)
    q = quote(db, tok)["data"]["quote_id"]
    same_ws, _ = connection(db, UA, ORG_A)
    other_ws, _ = connection(db, UB, ORG_B)
    before_a, before_b = credits(db, ORG_A), credits(db, ORG_B)
    for other in (same_ws, other_ws):
        res = create(db, other, q, "steal-" + uuid.uuid4().hex)
        assert res["status"] == 404 and code(res) == "quote_not_found", res
    res = create(db, API_KEY_HASH, q, "key-" + uuid.uuid4().hex)
    assert res["status"] == 401, res
    assert credits(db, ORG_A) == before_a and credits(db, ORG_B) == before_b
    assert db.su("select job_id from public.oauth_creative_quotes where id=%s", [q])[0][0] is None


def test_no_create_without_a_quote(db):
    tok, grant = connection(db, UA, ORG_A)
    before = credits(db, ORG_A)
    assert code(create(db, tok, str(uuid.uuid4()), "noq-1")) == "quote_not_found"
    assert code(create(db, tok, None, "noq-2")) == "quote_required"
    assert credits(db, ORG_A) == before
    assert db.su("select count(*) from public.oauth_creative_jobs where grant_id=%s", [grant])[0][0] == 0


def test_an_expired_quote_holds_nothing(db):
    tok, _g = connection(db, UA, ORG_A)
    q = quote(db, tok)["data"]["quote_id"]
    db.su("update public.oauth_creative_quotes set created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' where id=%s", [q])
    before = credits(db, ORG_A)
    res = create(db, tok, q, "late-" + uuid.uuid4().hex)
    assert res["status"] == 409 and code(res) == "quote_expired", res
    assert credits(db, ORG_A) == before


def test_a_moved_price_is_refused_as_price_changed_and_holds_nothing(db):
    tok, _g = connection(db, UA, ORG_A)
    q = quote(db, tok, "img-later")["data"]
    before = credits(db, ORG_A)
    db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_img_later_image'")
    try:
        res = create(db, tok, q["quote_id"], "moved-" + uuid.uuid4().hex)
        assert res["status"] == 409 and code(res) == "price_changed", res
        assert res["error"]["quoted_credits"] == 6 and res["error"]["price_credits"] == 3, res
        assert credits(db, ORG_A) == before
    finally:
        db.su("update public.credit_prices set credits_per_unit = 4 where unit = 'model_img_later_image'")


def test_a_model_switched_off_after_the_quote_is_refused_at_create(db):
    tok, _g = connection(db, UA, ORG_A)
    q = quote(db, tok, "img-later")["data"]["quote_id"]
    db.su("update public.model_registry set spec = spec - 'mcp_oauth_exposure' where id = 'img-later'")
    try:
        before = credits(db, ORG_A)
        res = create(db, tok, q, "off-" + uuid.uuid4().hex)
        assert res["status"] == 422 and code(res) == "model_not_offered", res
        assert credits(db, ORG_A) == before
    finally:
        db.su("update public.model_registry set spec = spec || '{\"mcp_oauth_exposure\": true}'::jsonb where id = 'img-later'")


def test_one_key_creates_once_and_one_quote_pays_once(db):
    tok, grant = connection(db, UA, ORG_A)
    q1 = quote(db, tok)["data"]["quote_id"]
    a = create(db, tok, q1, "idem-1")
    b = create(db, tok, q1, "idem-1")
    assert a["ok"] and b["ok"] and a["data"]["id"] == b["data"]["id"] and b["data"]["replayed"] is True, (a, b)
    assert b["status"] == 200
    used = create(db, tok, q1, "idem-2")
    assert used["status"] == 409 and code(used) == "quote_used" and used["error"]["job_id"] == a["data"]["id"], used
    q2 = quote(db, tok)["data"]["quote_id"]
    reused = create(db, tok, q2, "idem-1")
    assert reused["status"] == 422 and code(reused) == "idempotency_key_reused", reused
    assert db.su("select count(*) from public.oauth_creative_jobs where grant_id=%s", [grant])[0][0] == 1


def test_the_connections_monthly_limit_counts_generations_and_refuses_past_it(db):
    tok, grant = connection(db, UA, ORG_A, limit=10)
    first = create(db, tok, quote(db, tok)["data"]["quote_id"], "lim-1")
    assert first["ok"], first
    before = credits(db, ORG_A)
    second = create(db, tok, quote(db, tok)["data"]["quote_id"], "lim-2")
    assert second["status"] == 402 and code(second) == "connection_limit_reached", second
    assert second["error"]["limit_credits"] == 10 and second["error"]["spent_credits"] == 6 and second["error"]["price_credits"] == 6
    assert credits(db, ORG_A) == before
    # A read-only connection (limit 0) generates nothing.
    ro, _ = connection(db, UA, ORG_A, limit=0)
    assert code(create(db, ro, quote(db, ro)["data"]["quote_id"], "ro-1")) == "connection_limit_reached"


def test_not_enough_credits_is_refused_and_holds_nothing(db):
    tok, _g = connection(db, UC, ORG_C, limit=20000)
    before = credits(db, ORG_C)
    res = create(db, tok, quote(db, tok)["data"]["quote_id"], "poor-1")
    assert res["status"] == 402 and code(res) == "insufficient_credits" and res["error"]["price_credits"] == 6, res
    assert credits(db, ORG_C) == before


def test_the_job_runs_the_quoted_params_and_nothing_sent_later(db):
    # create_creative has no params argument at all: a crafted call with one does not exist as a function.
    tok, _g = connection(db, UA, ORG_A)
    q = quote(db, tok, params={"prompt": "the quoted words"})["data"]["quote_id"]
    with pytest.raises(psycopg.errors.UndefinedFunction):
        db.act("anon", None, "select public.oauth_creative_create(%s,%s,%s,%s::jsonb,null)", [tok, q, "crafted", json.dumps({"prompt": "other"})])
    # No API role can rewrite the stored quote either.
    for role in ("anon", "authenticated"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, UA, "update public.oauth_creative_quotes set params = '{\"prompt\":\"other\"}'::jsonb where id = %s", [q])
    res = create(db, tok, q, "quoted-" + uuid.uuid4().hex)
    assert db.su("select params ->> 'prompt' from public.creative_jobs where id=%s", [res["data"]["id"]])[0][0] == "the quoted words"


def test_a_generation_is_read_by_the_connection_that_started_it_with_files_only_once_completed(db):
    tok, _g = connection(db, UA, ORG_A)
    job = create(db, tok, quote(db, tok)["data"]["quote_id"], "read-" + uuid.uuid4().hex)["data"]["id"]
    mine = asset(db, ORG_A)
    db.su("update public.creative_jobs set result_asset_ids = %s::uuid[] where id = %s", [[mine], job])
    assert get(db, tok, job)["data"]["files"] == []
    db.su("update public.creative_jobs set status = 'completed', finished_at = now() where id = %s", [job])
    assert [f["asset_id"] for f in get(db, tok, job)["data"]["files"]] == [mine]
    other, _ = connection(db, UA, ORG_A)
    assert code(get(db, other, job)) == "job_not_found"
    assert get(db, API_KEY_HASH, job)["status"] == 401


# ── who may call ───────────────────────────────────────────────────────────

def test_a_connection_without_studio_create_reaches_no_door(db):
    tok, _g = connection(db, UA, ORG_A, scopes=["videos:read", "videos:create", "videos:publish"])
    for res in (models(db, tok), quote(db, tok), create(db, tok, str(uuid.uuid4()), "x"), get(db, tok, str(uuid.uuid4())),
                db.act("anon", None, "select public.oauth_media_list(%s,null,null,null)", [tok])[0][0]):
        assert res["status"] == 403 and code(res) == "insufficient_scope" and res["error"]["required_scope"] == "studio:create", res


def test_an_api_key_and_a_malformed_hash_reach_no_door(db):
    for h in (API_KEY_HASH, "not-a-hash"):
        assert models(db, h)["status"] == 401
        assert quote(db, h)["status"] == 401


@pytest.mark.parametrize("role", ["authenticated", "service_role"])
def test_only_anon_may_call_the_doors_and_nobody_reads_the_records(db, role):
    tok, _g = connection(db, UA, ORG_A)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.act(role, UA, "select public.oauth_creative_quote(%s,'t2i','img-on','{}'::jsonb,null)", [tok])
    for t in ("oauth_creative_quotes", "oauth_creative_jobs", "oauth_creative_rate_counters"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, UA, f"select count(*) from public.{t}")


def test_the_quote_bucket_refuses_a_loop(db):
    tok, _g = connection(db, UA, ORG_A)
    # The bucket is a calendar minute (date_trunc('minute', now())): 31 quotes that straddle a minute boundary are two buckets and
    # the 31st is allowed (CI failed exactly so). Start with at least 15 seconds of the database's own minute left.
    left = float(db.su("select 60 - extract(second from clock_timestamp())")[0][0])
    if left < 15:
        time.sleep(left + 0.5)
    answers = [quote(db, tok)["status"] for _ in range(31)]
    assert answers[:30] == [201] * 30 and answers[30] == 429, answers


# ── replay and rollback ────────────────────────────────────────────────────

def test_replay_then_rollback_refuses_while_a_connection_holds_the_permission_then_restores_0093():
    admin = sec_db.admin_dsn()
    if not admin:
        pytest.skip("no lab database")
    name = f"ns_mcp_oacr_rb_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    try:
        sec_db.apply_files(d.dsn, [MIGRATION])  # a replay changes nothing
        setup(d)
        tok, grant = connection(d, UA, ORG_A)
        job = create(d, tok, quote(d, tok)["data"]["quote_id"], "rb-1")["data"]["id"]
        with pytest.raises(sec_db.ApplyError, match="hold the studio:create permission"):
            sec_db.apply_files(d.dsn, [ROLLBACK])
        assert d.su("select to_regprocedure('public.oauth_creative_create(text, uuid, text, text)') is not null")[0][0]
        d.su("delete from public.oauth_grants where 'studio:create' = any (scopes)")
        sec_db.apply_files(d.dsn, [ROLLBACK])
        assert d.su("select to_regprocedure('public.oauth_creative_create(text, uuid, text, text)') is null")[0][0]
        assert d.su("select 'studio:create' = any (public.oauth_scopes_supported())")[0][0] is False
        assert d.su("select to_regclass('public.oauth_creative_jobs') is not null")[0][0]
        with pytest.raises(psycopg.errors.CheckViolation):
            d.su("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits) "
                 "select %s, %s, client_id, array['studio:create'], %s, 1 from public.oauth_clients limit 1", [UA, ORG_A, RESOURCE])
        # And 0191 goes on again after its own rollback.
        sec_db.apply_files(d.dsn, [MIGRATION])
        assert d.su("select public.oauth_endpoint_scope('oauth.creative.create')")[0][0] == "studio:create"
        assert job
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def test_a_vendors_web_only_model_is_never_offered_to_an_assistant_whatever_the_switch_says(db):
    tok, _g = connection(db, UA, ORG_A)
    res = quote(db, tok, "img-webonly")
    assert res["ok"] is False and res["status"] == 422 and res["error"]["code"] == "model_not_offered", res


def test_the_media_list_names_no_file(db):
    # Breach on 0191: a member's file name reached the admin's assistant verbatim (an instruction channel).
    tok, _g = connection(db, UA, ORG_A)
    out = db.act("anon", None, "select public.oauth_media_list(%s, null, 50, null)", [tok])[0][0]
    assert out["ok"] is True, out
    assert all("name" not in m for m in out["data"]["media"]), out["data"]["media"][:3]
