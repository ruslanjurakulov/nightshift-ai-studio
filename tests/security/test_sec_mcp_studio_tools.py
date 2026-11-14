"""The MCP Studio tools' database half (0162), attacked in a real database.

list_models and get_generation call api_creative_models and api_creative_job_files with the anon key and the API key's hash, the
way PostgREST does; quote_generation and create_generation call 0062's api_creative_quote and api_creative_create, which
tests/security/test_sec_api_creative.py attacks (ceiling, idempotency, organizations, scopes, the key's monthly credits). These prove:

* the model list is only what this organization's create would accept: the API's sellable set (never a web-only model), a `paid`
  model only after a purchase, never a plan-feature model; an unknown capability is 400; no price is listed;
* a key needs creative:quote to list and creative:read to read files; a revoked, malformed or unknown key, and a hash that is no
  key (an access token's place), is refused before anything is read; the request is counted and logged as creative.models;
* a generation's files are answered only for a job THIS key started, in its organization: another key of the same organization,
  another organization's key, and a made-up id all read 404; a deleted asset, another organization's asset and one not stored on the
  server's volume are never listed even when the job names them;
* nothing is held, charged or written by either call, and only the anon role may call them.

Runs in its own scratch database (it commits).
"""

import hashlib
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG_A = "aaaaaaaa-0000-0000-0000-0000000001c6"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000001c6"
UA = str(uuid.UUID(int=0xA1C6))
UB = str(uuid.UUID(int=0xB1C6))

H = lambda name: hashlib.sha256(f"mcp-studio-{name}".encode()).hexdigest()

ALL_CREATIVE = ["creative:quote", "creative:create", "creative:read"]
KEYS = {
    "a_full": (ORG_A, UA, ALL_CREATIVE),
    "a_full2": (ORG_A, UA, ALL_CREATIVE),
    "a_quote": (ORG_A, UA, ["creative:quote"]),
    "a_read": (ORG_A, UA, ["creative:read"]),
    "a_legacy": (ORG_A, UA, None),
    "a_revoked": (ORG_A, UA, ALL_CREATIVE),
    "b_full": (ORG_B, UB, ALL_CREATIVE),
}

# (id, capabilities, extra spec, entitlement)
MODELS = [
    ("img-api", ["t2i"], {}, "any"),
    ("img-edit", ["t2i", "edit"], {}, "any"),
    ("img-webonly", ["t2i"], {"api_exposure": "web_only"}, "any"),
    ("img-paid", ["t2i"], {}, "paid"),
    ("img-pro", ["t2i"], {}, "pro_models"),
]
PROMPT = {"prompt": "a lighthouse at dawn"}


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


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_mcp_studio_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@c6.io'),(%s,'b@c6.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-a-c6'),(%s,'B','org-b-c6')", [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@c6.io','owner'),(%s,%s,'b@c6.io','owner')",
         [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values "
         "(%s, now(), %s, 'v1'), (%s, now(), %s, 'v1')", [ORG_A, UA, ORG_B, UB])
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 0, 100000), (%s, 0, 100000)",
         [ORG_A, ORG_B])
    rows = [{"id": m, "display_name": m.upper(), "provider": "acme", "adapter": "image.acme", "capabilities": caps,
             "credit_unit": f"model_{m.replace('-', '_')}_image", "entitlement": ent,
             "spec": {"vendor_model": "acme-" + m, "output": "image", **extra}}
            for m, caps, extra, ent in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, _x, _e in MODELS:
        d.su("select public.record_model_probe(%s, 'image.acme', %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 4, 0.5) on conflict (unit) do nothing",
             [f"model_{m.replace('-', '_')}_image"])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit")
    d.key_id = {}
    for k, (org, uid, scopes) in KEYS.items():
        d.key_id[k] = d.su(
            "insert into public.api_keys (org_id, name, key_hash, created_by, scopes, revoked_at) "
            "values (%s, %s, %s, %s, %s, case when %s then now() end) returning id::text",
            [org, k, H(k), uid, scopes, k == "a_revoked"])[0][0]
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def models(db, key, cap=None, raw_hash=None):
    return db.act("anon", None, "select public.api_creative_models(%s,%s,null)", [raw_hash or H(key), cap])[0][0]


def files(db, key, job_id, raw_hash=None):
    return db.act("anon", None, "select public.api_creative_job_files(%s,%s,null)", [raw_hash or H(key), job_id])[0][0]


def create(db, key, idem):
    return db.act("anon", None, "select public.api_creative_create(%s,'t2i','img-api',%s::jsonb,'exact',100,%s,%s,null)",
                  [H(key), json.dumps(PROMPT), idem, hashlib.sha256(idem.encode()).hexdigest()])[0][0]


def code(res):
    return res["error"]["code"] if res.get("ok") is False else None


def ids(res):
    return [m["id"] for m in res["data"]["models"]]


def footprint(db, org):
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [org])[0][0],
            db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org])[0],
            db.su("select count(*) from public.credit_transactions where org_id=%s", [org])[0][0])


def asset(db, org, *, deleted=False, storage="local"):
    aid = str(uuid.uuid4())
    db.act("service_role", None,
           "select public.register_asset(%s, %s, 'image', 'image/png', 1000, %s, 'generated', p_width => 64, p_height => 64, "
           "p_provenance => '{\"job_id\": \"seed\"}'::jsonb)", [aid, org, uuid.uuid4().hex * 2])
    if deleted:
        db.su("update public.media_assets set deleted_at = now() where id = %s", [aid])
    if storage != "local":
        db.su("update public.media_assets set storage = %s where id = %s", [storage, aid])
    return aid


# ── the model list ─────────────────────────────────────────────────────────

def test_lists_only_what_this_organizations_create_would_accept(db):
    res = models(db, "a_quote")
    assert res["ok"] and res["status"] == 200, res
    # web_only is never sold through the API; `paid` needs a purchase; a plan feature is refused at create, so neither is listed.
    assert ids(res) == ["img-api", "img-edit"], res
    row = res["data"]["models"][0]
    assert set(row) == {"id", "name", "capabilities", "availability", "spec"}, row
    assert "api_exposure" not in row["spec"] and "vendor_model" not in row["spec"], row
    text = json.dumps(res)
    for priced in ("credits_per_unit", "margin", "credit_unit", "price"):
        assert priced not in text, priced


def test_a_paid_model_is_listed_once_the_organization_bought_credits_and_create_agrees(db):
    assert "img-paid" not in ids(models(db, "b_full"))
    refused = db.act("anon", None, "select public.api_creative_quote(%s,'t2i','img-paid',%s::jsonb,null)", [H("b_full"), json.dumps(PROMPT)])[0][0]
    assert code(refused) == "entitlement_required", refused
    # A ledger row of kind 'purchase' is what creative_price reads (0156); the amount is not what is tested. The ledger is
    # append-only, so organization B keeps it for the rest of this module (no later test lists B's models).
    db.su("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, note) "
          "select %s, 'purchase', 0, balance, reserved, 'lab purchase' from public.credit_accounts where org_id = %s", [ORG_B, ORG_B])
    assert ids(models(db, "b_full")) == ["img-api", "img-edit", "img-paid"]
    quoted = db.act("anon", None, "select public.api_creative_quote(%s,'t2i','img-paid',%s::jsonb,null)", [H("b_full"), json.dumps(PROMPT)])[0][0]
    assert quoted["ok"], quoted
    # Organization A bought nothing: its list is unchanged.
    assert "img-paid" not in ids(models(db, "a_full"))


def test_a_credits_exempt_organization_sees_a_paid_model_without_a_purchase_but_never_a_plan_feature(db):
    # The operator's own organization (0018 default_org_id) is credits-exempt: creative_price sells it a `paid` model (0156).
    exempt = db.su("select public.default_org_id()::text")[0][0]
    assert db.su("select public.credits_exempt(%s)", [exempt])[0][0]
    db.su("insert into public.organizations (id, name, slug) values (%s, 'Default', 'default-c6') on conflict (id) do nothing", [exempt])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@c6.io','owner') on conflict do nothing", [exempt, UA])
    db.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1') "
          "on conflict (org_id) do update set activated_at = now()", [exempt, UA])
    db.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s, 'exempt', %s, %s, %s)",
          [exempt, H("exempt"), UA, ALL_CREATIVE])
    assert db.su("select count(*) from public.credit_transactions where org_id=%s and kind='purchase'", [exempt])[0][0] == 0
    listed = ids(models(db, "exempt"))
    assert "img-paid" in listed and "img-pro" not in listed and "img-webonly" not in listed, listed
    quoted = db.act("anon", None, "select public.api_creative_quote(%s,'t2i','img-paid',%s::jsonb,null)", [H("exempt"), json.dumps(PROMPT)])[0][0]
    assert quoted["ok"], quoted


def test_a_capability_narrows_the_list_and_an_unknown_one_is_400(db):
    assert ids(models(db, "a_full", "edit")) == ["img-edit"]
    assert models(db, "a_full", "EDIT ")["data"]["capability"] == "edit"
    res = models(db, "a_full", "teleport")
    assert res["status"] == 400 and code(res) == "invalid_params", res
    # Captions are a web tool: nothing is ever listed for them through the API.
    assert ids(models(db, "a_full", "captions")) == []


@pytest.mark.parametrize("key", ["a_read", "a_legacy"])
def test_listing_needs_the_quote_scope(db, key):
    res = models(db, key)
    assert res["status"] == 403 and code(res) == "insufficient_scope" and res["error"]["required_scope"] == "creative:quote", res


def test_bad_keys_are_refused_before_anything_is_read(db):
    assert models(db, "a_revoked")["status"] == 401
    assert models(db, None, raw_hash="not-a-key")["status"] == 401
    # A well-formed hash that is no key is an access token's place (0093): it is refused, never listed.
    stray = models(db, None, raw_hash=hashlib.sha256(b"no such key").hexdigest())
    assert stray["ok"] is False and stray["status"] in (401, 403), stray


def test_the_list_is_counted_and_logged_as_creative_models_and_writes_nothing(db):
    before = footprint(db, ORG_A)
    logged = lambda: db.su("select count(*) from public.api_requests where key_id=%s and endpoint='creative.models'", [db.key_id["a_quote"]])[0][0]
    n = logged()
    models(db, "a_quote")
    assert logged() == n + 1
    assert footprint(db, ORG_A) == before


# ── a generation's files ───────────────────────────────────────────────────

def test_files_of_a_job_this_key_started_only_its_own_live_local_assets(db):
    res = create(db, "a_full", "files-" + uuid.uuid4().hex)
    assert res["ok"], res
    job = res["data"]["id"]
    mine = asset(db, ORG_A)
    gone = asset(db, ORG_A, deleted=True)
    remote = asset(db, ORG_A, storage="supabase")
    theirs = asset(db, ORG_B)
    # Even if a job row named them, only the organization's own, undeleted, local assets are answered.
    db.su("update public.creative_jobs set result_asset_ids = %s::uuid[] where id = %s", [[mine, gone, remote, theirs], job])
    # Not yet completed (so not charged): no file at all (Breach BR-0162-1; tests/security/test_sec_breach_mcp_studio_0162.py
    # walks the worker's real path to a failed job).
    assert files(db, "a_full", job)["data"]["files"] == []
    db.su("update public.creative_jobs set status = 'completed', finished_at = now() where id = %s", [job])
    out = files(db, "a_full", job)
    assert out["ok"] and out["data"]["id"] == job, out
    assert [f["asset_id"] for f in out["data"]["files"]] == [mine], out
    f = out["data"]["files"][0]
    assert f["kind"] == "image" and f["mime"] == "image/png" and f["variants"] == [] and f["width"] == 64, f
    # The rest of the answer is api_creative_get's.
    got = db.act("anon", None, "select public.api_creative_get(%s,%s,null)", [H("a_full"), job])[0][0]
    assert {k: v for k, v in out["data"].items() if k != "files"} == got["data"]


def test_files_answer_404_to_another_key_another_organization_and_a_made_up_id(db):
    res = create(db, "a_full", "files404-" + uuid.uuid4().hex)
    job = res["data"]["id"]
    for key in ("a_full2", "b_full"):
        out = files(db, key, job)
        assert out["status"] == 404 and code(out) == "job_not_found", (key, out)
    assert files(db, "a_full", str(uuid.uuid4()))["status"] == 404


def test_files_need_the_read_scope_and_a_live_key(db):
    res = create(db, "a_full", "filesscope-" + uuid.uuid4().hex)
    job = res["data"]["id"]
    out = files(db, "a_quote", job)
    assert out["status"] == 403 and out["error"]["required_scope"] == "creative:read", out
    assert files(db, "a_revoked", job)["status"] == 401


# ── who may call ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("role", ["authenticated", "service_role"])
def test_only_the_anon_role_may_call_them(db, role):
    for q, p in (("select public.api_creative_models(%s,null,null)", [H("a_full")]),
                 ("select public.api_creative_job_files(%s,%s,null)", [H("a_full"), str(uuid.uuid4())])):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.act(role, UA if role == "authenticated" else None, q, p)


def test_the_rollback_takes_both_out_and_a_replay_puts_them_back(db):
    rollback = (sec_db.REPO / "docs" / "sql" / "rollback_0162_api_creative_models.sql").read_text(encoding="utf-8")
    migration = next(sec_db.MIGRATIONS.glob("0162_*.sql")).read_text(encoding="utf-8")
    # 0171 replaces api_creative_models on 0162's body, and 0162's replay refuses any other: 0171 comes off first and goes back last.
    db.su(sec_db.rollback_0171_body())
    try:
        db.su(rollback)
        assert db.su("select to_regprocedure('public.api_creative_models(text, text, text)') is null")[0][0]
        assert db.su("select to_regprocedure('public.api_creative_job_files(text, uuid, text)') is null")[0][0]
    finally:
        db.su(migration)
    db.su(migration)  # a replay of the same body is accepted
    db.su(sec_db.MIGRATION_0171.read_text(encoding="utf-8"))
    assert models(db, "a_full")["ok"]
