"""Creative generations through the public API (0062), attacked in a real database.

What a key can do is decided by the database alone. These tests call the three
anon entry points (api_creative_quote / _create / _get) the way PostgREST would
and prove, with a real credit ledger behind them:

* a key does only what its scopes say — a key made before 0062 cannot spend
  credits, a creative-only key cannot touch videos, an unknown endpoint is
  closed — and a refused call holds nothing and creates nothing;
* nothing crosses an organization: another organization's picture reads like
  one that does not exist, another organization's job and another KEY's job
  read as 404, and no request names an organization at all;
* money behaves exactly like the Studio's: the hold is the quote, the worker's
  capture and release leave the same ledger rows, a price above max_credits
  is refused, a retry never pays twice, two keys never share an
  Idempotency-Key, and a key's own monthly credit ceiling holds;
* the API is stricter than the web where it must be: a model whose vendor
  forbids third-party API use is refused;
* a key's request limit can lower the tier's, never raise it;
* a failure inside the database is a structured 500 that says nothing of the
  database and leaves no job and no hold.

Runs in its own scratch database (it commits): a real 0035 registry with
models installed through sync_model_registry and a real probe, as production does.
"""

import hashlib
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000c2"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000c2"
ORG_C = "cccccccc-0000-0000-0000-0000000000c2"  # usage tier 0 (10 requests a minute)
UA = str(uuid.UUID(int=0xA2C2))      # owner of A, the creator of A's keys
UA_VIEWER = str(uuid.UUID(int=0xA3C2))  # a plain member of A
UB = str(uuid.UUID(int=0xB2C2))      # owner of B
USTRANGER = str(uuid.UUID(int=0xC2C2))

H = lambda name: hashlib.sha256(f"api-creative-{name}".encode()).hexdigest()

# name -> (org, creator, scopes, rpm_limit, creative_monthly_credits)
ALL_CREATIVE = ["creative:quote", "creative:create", "creative:read"]
KEYS = {
    "a_full": (ORG_A, UA, ALL_CREATIVE, None, None),
    "a_full2": (ORG_A, UA, ALL_CREATIVE, None, None),        # a second key of the same organization
    "a_quote": (ORG_A, UA, ["creative:quote"], None, None),
    "a_read": (ORG_A, UA, ["creative:read"], None, None),
    "a_legacy": (ORG_A, UA, None, None, None),               # made before 0062: scopes null
    "a_limited": (ORG_A, UA, ALL_CREATIVE, None, 10),        # may start 10 credits a month
    "a_slow": (ORG_A, UA, ALL_CREATIVE, 2, None),            # 2 requests a minute
    "a_account": (ORG_A, UA, ["account:read"], None, None),
    "a_revoked": (ORG_A, UA, ALL_CREATIVE, None, None),
    "a_stale": (ORG_A, UA_VIEWER, ALL_CREATIVE, None, None), # its creator is only a member
    "b_full": (ORG_B, UB, ALL_CREATIVE, None, None),
}

# (id, capabilities, adapter, extra spec, credit unit, credits per unit)
MODELS = [
    ("img-api", ["t2i"], "image.acme", {}, "model_img_api_image", 4),
    ("img-webonly", ["t2i"], "image.acme", {"api_exposure": "web_only"}, "model_img_webonly_image", 4),
    ("img-edit", ["t2i", "edit"], "image.acme", {}, "model_img_edit_image", 4),
]
PRICES = ", ".join(f"('{u}', {c}, 0.5)" for _m, _c, _a, _s, u, c in MODELS) + ", ('job_minimum', 1, 0)"
PROMPT = {"prompt": "a lighthouse at dawn"}
PRICE = 6  # 4 credits x (1 + 0.5)


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

    def act(self, role, uid, q, p=None, *, commit=True):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit() if commit else c.rollback()
                return rows
            except psycopg.Error:
                c.rollback()
                raise

    def many(self, role, calls):
        """Several calls in ONE transaction (so now(), and with it the minute
        a request is counted in, cannot change between them); rolled back."""
        out = []
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role)])
                c.execute(f"set local role {role}")
                for q, p in calls:
                    out.append(c.execute(q, p).fetchone()[0])
            finally:
                c.rollback()
        return out


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_api_creative_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@c2.io'),(%s,'av@c2.io'),(%s,'b@c2.io'),(%s,'s@c2.io')",
         [UA, UA_VIEWER, UB, USTRANGER])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-a-c2'),(%s,'B','org-b-c2')", [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a@c2.io','owner'),(%s,%s,'av@c2.io','viewer'),(%s,%s,'b@c2.io','owner')",
         [ORG_A, UA, ORG_A, UA_VIEWER, ORG_B, UB])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])
    # The free plan runs one generation at a time; these tests start several.
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    d.su("insert into public.organizations (id, name, slug) values (%s,'C','org-c-c2')", [ORG_C])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@c2.io','owner')", [ORG_C, UA])
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values "
         "(%s, now(), %s, 'v1'), (%s, now(), %s, 'v1'), (%s, now(), %s, 'v1')", [ORG_A, UA, ORG_B, UB, ORG_C, UA])
    # Tier 4 (300 requests a minute) for A and B, so a test that makes many
    # calls is not stopped by the request limit it is not about; C stays at tier 0.
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 0, 100000), (%s, 0, 100000)",
         [ORG_A, ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": a, "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "image", **extra}}
            for m, caps, a, extra, unit, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, a, _x, _u, _c in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin")
    d.key_id = {}
    for k, (org, uid, scopes, rpm, cap) in KEYS.items():
        d.key_id[k] = d.su(
            "insert into public.api_keys (org_id, name, key_hash, created_by, scopes, rpm_limit, creative_monthly_credits, revoked_at) "
            "values (%s, %s, %s, %s, %s, %s, %s, case when %s then now() end) returning id::text",
            [org, k, H(k), uid, scopes, rpm, cap, k == "a_revoked"])[0][0]
    # An organization A picture, for the cross-organization attacks.
    d.asset_a = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, 'image', 'image/png', 1000, %s, 'generated', p_width => 64, p_height => 64, "
          "p_provenance => '{\"job_id\": \"seed\"}'::jsonb)", [d.asset_a, ORG_A, uuid.uuid4().hex * 2])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


# ── helpers ─────────────────────────────────────────────────────────────────

def fp(name):
    return hashlib.sha256(name.encode()).hexdigest()


def quote(db, key, cap="t2i", model="img-api", params=PROMPT):
    return db.act("anon", None, "select public.api_creative_quote(%s,%s,%s,%s::jsonb,null)",
                  [H(key), cap, model, json.dumps(params)])[0][0]


def create(db, key, cap="t2i", model="img-api", params=PROMPT, maxc=100, idem="k-1", fprint=None, mode="exact"):
    return db.act("anon", None, "select public.api_creative_create(%s,%s,%s,%s::jsonb,%s,%s,%s,%s,null)",
                  [H(key), cap, model, json.dumps(params), mode, maxc, idem, fprint or fp(f"{cap}{model}{json.dumps(params)}{mode}")])[0][0]


def get(db, key, job_id):
    return db.act("anon", None, "select public.api_creative_get(%s,%s,null)", [H(key), job_id])[0][0]


def code(res):
    return res["error"]["code"] if res.get("ok") is False else None


def uniq():
    return "idem-" + uuid.uuid4().hex


def footprint(db, org):
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [org])[0][0],
            db.su("select count(*) from public.api_creative_jobs where org_id=%s", [org])[0][0],
            db.su("select count(*), coalesce(sum(amount),0)::float from public.credit_reservations "
                  "where org_id=%s and job_id like 'cj:%%'", [org])[0],
            db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org])[0])


def svc(db, q, p=None):
    return db.act("service_role", None, q, p)


def drain(db):
    """Fail every queued job so a test starts from an empty queue (releases its hold)."""
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc(db, "select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


def ledger(db, ref):
    return db.su("select kind, amount::float from public.credit_transactions where job_id=%s order by id", [ref])


def run_job(db, job_id, ok, charge=None):
    """The worker's side, step by step, for one specific job."""
    drain_other = svc(db, "select id::text, credit_ref, org_id::text from public.claim_creative_job('w-api')")
    assert drain_other and drain_other[0][0] == job_id, drain_other
    _id, ref, org = drain_other[0]
    if ref:
        svc(db, "select public.start_credit_reservation(%s,%s)", [ref, org])
    svc(db, "select public.advance_creative_job(%s,'w-api','submitting')", [job_id])
    svc(db, "select public.advance_creative_job(%s,'w-api','submitted',%s)", [job_id, "task-" + job_id[:8]])
    if ok:
        return svc(db, "select public.finish_creative_job(%s,'w-api',true,%s,'{\"files\":[]}')", [job_id, charge])[0][0]
    return svc(db, "select public.finish_creative_job(%s,'w-api',false,null,null,'content_policy','refused')", [job_id])[0][0]


# ── unknown, revoked and stale keys ─────────────────────────────────────────

def test_an_unknown_key_is_refused_before_anything_else(db):
    before = (footprint(db, ORG_A), footprint(db, ORG_B))
    nobody = hashlib.sha256(b"nobody").hexdigest()
    for q, p in [("select public.api_creative_quote(%s,'t2i','img-api','{}'::jsonb,null)", [nobody]),
                 ("select public.api_creative_create(%s,'t2i','img-api','{}'::jsonb,'exact',9,'k','" + fp("x") + "',null)", [nobody]),
                 ("select public.api_creative_get(%s,%s,null)", [nobody, str(uuid.uuid4())])]:
        res = db.act("anon", None, q, p)[0][0]
        assert res["status"] == 401 and code(res) == "invalid_api_key", res
    assert (footprint(db, ORG_A), footprint(db, ORG_B)) == before


def test_a_revoked_key_creates_nothing(db):
    before = footprint(db, ORG_A)
    res = create(db, "a_revoked", idem=uniq())
    assert res["status"] == 401 and code(res) == "invalid_api_key", res
    assert footprint(db, ORG_A) == before


def test_a_key_whose_creator_is_no_longer_an_admin_creates_nothing(db):
    before = footprint(db, ORG_A)
    res = create(db, "a_stale", idem=uniq())
    assert res["status"] == 403 and code(res) == "key_owner_not_admin", res
    assert footprint(db, ORG_A) == before


# ── scopes ──────────────────────────────────────────────────────────────────

def test_a_key_without_creative_scopes_cannot_quote_create_or_read(db):
    drain(db)
    before = footprint(db, ORG_A)
    mine = create(db, "a_full", idem=uniq())["data"]["id"]
    after_create = footprint(db, ORG_A)
    for key in ("a_legacy", "a_account"):
        for res in (quote(db, key), create(db, key, idem=uniq()), get(db, key, mine)):
            assert res["status"] == 403 and code(res) == "insufficient_scope", (key, res)
    assert footprint(db, ORG_A) == after_create, "a refused call held credits or made a job"
    assert after_create[0] == before[0] + 1
    drain(db)


@pytest.mark.parametrize("key,allowed", [
    ("a_quote", {"quote"}),
    ("a_read", {"get"}),
    ("a_full", {"quote", "create", "get"}),
])
def test_each_creative_scope_opens_exactly_its_own_endpoint(db, key, allowed):
    drain(db)
    mine = create(db, "a_full", idem=uniq())["data"]["id"]
    before = footprint(db, ORG_A)
    calls = {"quote": lambda: quote(db, key), "create": lambda: create(db, key, idem=uniq()), "get": lambda: get(db, key, mine)}
    for name, call in calls.items():
        res = call()
        if name in allowed:
            assert res.get("ok") is True or code(res) == "job_not_found", (key, name, res)
        else:
            assert res["status"] == 403 and code(res) == "insufficient_scope", (key, name, res)
            assert res["error"]["required_scope"] == {"quote": "creative:quote", "create": "creative:create", "get": "creative:read"}[name]
    after = footprint(db, ORG_A)
    # Only a key allowed to create may have moved credits.
    assert (after[0] - before[0]) == (1 if "create" in allowed else 0)
    drain(db)


def test_creative_only_keys_cannot_use_the_video_endpoints(db):
    for name, q, p in [
        ("balance", "select public.api_balance(%s,null)", [H("a_full")]),
        ("channels", "select public.api_list_channels(%s,null)", [H("a_full")]),
        ("videos", "select public.api_list_videos(%s,null,20,0,null)", [H("a_full")]),
        ("create video", "select public.api_create_video(%s,'chan',%s::jsonb,null,null,null)", [H("a_full"), "{}"]),
        ("job", "select public.api_get_job(%s,1,null)", [H("a_full")]),
    ]:
        res = db.act("anon", None, q, p)[0][0]
        assert res["status"] == 403 and code(res) == "insufficient_scope", (name, res)


def test_a_key_made_before_0062_keeps_the_endpoints_it_had(db):
    for q in ("select public.api_balance(%s,null)", "select public.api_list_channels(%s,null)",
              "select public.api_list_videos(%s,null,20,0,null)"):
        res = db.act("anon", None, q, [H("a_legacy")])[0][0]
        assert res["status"] == 200, (q, res)
    me = db.act("anon", None, "select public.api_auth(%s,null)", [H("a_legacy")])[0][0]
    assert me["data"]["key"]["scopes"] == ["account:read", "videos:read", "videos:write"], me


def test_me_is_open_to_every_valid_key_and_reports_its_scopes(db):
    for key, scopes in (("a_quote", ["creative:quote"]), ("a_account", ["account:read"])):
        me = db.act("anon", None, "select public.api_auth(%s,null)", [H(key)])[0][0]
        assert me["status"] == 200 and me["data"]["key"]["scopes"] == scopes, me


def test_an_endpoint_without_a_scope_is_closed_and_me_is_open(db):
    assert db.su("select public.api_endpoint_scope('me')")[0][0] is None
    assert db.su("select public.api_endpoint_scope('not.a.real.endpoint')")[0][0] == "none"
    assert db.su("select public.api_endpoint_scope(null)")[0][0] == "none"
    # every entry point the API has is mapped (no new endpoint ships open by accident)
    for ep in ("balance", "channels.list", "accounts.list", "videos.list", "videos.get", "jobs.get", "downloads.get",
               "videos.create", "videos.publish", "downloads.create", "creative.quote", "creative.create", "creative.get"):
        assert db.su("select public.api_endpoint_scope(%s)", [ep])[0][0] != "none", ep


def test_scopes_and_limits_cannot_be_written_out_of_range(db):
    for scopes, rpm, cap in ((["admin:all"], None, None), ([], None, None), ([None], None, None),
                             (["creative:read"], 0, None), (["creative:read"], 301, None), (["creative:read"], None, -1)):
        with pytest.raises(psycopg.errors.CheckViolation):
            db.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes, rpm_limit, creative_monthly_credits) "
                  "values (%s,'bad',%s,%s,%s,%s,%s)", [ORG_A, hashlib.sha256(uuid.uuid4().bytes).hexdigest(), UA, scopes, rpm, cap])


# ── organizations ───────────────────────────────────────────────────────────

def test_no_entry_point_takes_an_organization(db):
    for fn in ("api_creative_quote", "api_creative_create", "api_creative_get"):
        args = db.su("select pg_get_function_arguments(p.oid) from pg_proc p where p.proname=%s", [fn])[0][0]
        assert "org" not in args.lower(), (fn, args)


def test_another_orgs_picture_reads_like_one_that_does_not_exist(db):
    drain(db)
    before = footprint(db, ORG_B)
    params = {"prompt": "x", "source_asset_id": db.asset_a}
    ghost = {"prompt": "x", "source_asset_id": str(uuid.uuid4())}
    for call in (lambda p: quote(db, "b_full", "edit", "img-edit", p),
                 lambda p: create(db, "b_full", "edit", "img-edit", p, idem=uniq())):
        theirs, ghosts = call(params), call(ghost)
        assert theirs["status"] == 422 and code(theirs) == "source_unavailable", theirs
        strip = lambda e: {k: v for k, v in e.items() if k != "request_id"}
        assert strip(theirs["error"]) == strip(ghosts["error"]), (theirs, ghosts)
        assert db.asset_a not in json.dumps(theirs)
    assert footprint(db, ORG_B) == before


def test_the_owner_org_can_use_its_own_picture(db):
    drain(db)
    res = create(db, "a_full", "edit", "img-edit", {"prompt": "x", "source_asset_id": db.asset_a}, idem=uniq())
    assert res["status"] == 201, res
    drain(db)


def test_another_orgs_key_reads_a_job_as_missing(db):
    drain(db)
    job = create(db, "a_full", idem=uniq())["data"]["id"]
    mine = get(db, "a_full", job)
    other_org = get(db, "b_full", job)
    ghost = get(db, "b_full", str(uuid.uuid4()))
    assert mine["status"] == 200 and mine["data"]["id"] == job
    assert other_org["status"] == 404 and code(other_org) == "job_not_found"
    assert other_org["error"] == ghost["error"], "another organization's id answers differently from a missing one"
    drain(db)


def test_another_key_of_the_same_org_reads_a_job_as_missing(db):
    drain(db)
    job = create(db, "a_full", idem=uniq())["data"]["id"]
    res = get(db, "a_full2", job)
    assert res["status"] == 404 and code(res) == "job_not_found", res
    drain(db)


def test_a_job_started_in_the_studio_is_not_visible_to_a_key(db):
    drain(db)
    studio = db.act("authenticated", UA, "select public.create_creative_job(%s,'t2i','img-api',%s::jsonb,'exact',null,100)",
                    [ORG_A, json.dumps(PROMPT)])[0][0]["job"]["id"]
    res = get(db, "a_full", studio)
    assert res["status"] == 404 and code(res) == "job_not_found", res
    drain(db)


def test_a_job_row_is_never_linked_to_a_key_of_another_org(db):
    # Defence in depth: even a link row that pointed a foreign key at a job
    # would not make the job readable (the organization is checked as well).
    drain(db)
    job = create(db, "a_full", idem=uniq())["data"]["id"]
    db.su("insert into public.api_creative_jobs (job_id, key_id, org_id) values (%s,%s,%s) on conflict (job_id) do update set key_id = excluded.key_id",
          [job, db.key_id["b_full"], ORG_B])
    try:
        assert code(get(db, "b_full", job)) == "job_not_found"
    finally:
        db.su("update public.api_creative_jobs set key_id=%s, org_id=%s where job_id=%s", [db.key_id["a_full"], ORG_A, job])
    drain(db)


# ── what the status shows ───────────────────────────────────────────────────

def test_the_status_shows_the_job_and_nothing_internal(db):
    drain(db)
    job = create(db, "a_full", idem=uniq())["data"]
    assert set(job) == {"id", "capability", "model", "status", "quoted_credits", "charged_credits", "error_code", "error",
                        "result", "result_asset_ids", "created_at", "updated_at", "finished_at", "expires_at"}, set(job)
    assert job["status"] == "queued" and job["quoted_credits"] == PRICE and job["charged_credits"] is None
    drain(db)


# ── the money ───────────────────────────────────────────────────────────────

def test_a_quote_is_the_price_and_holds_nothing(db):
    before = footprint(db, ORG_A)
    res = quote(db, "a_quote")
    assert res["status"] == 200 and res["data"]["quote"]["credits"] == PRICE, res
    assert "available" not in res["data"]["quote"], "a quote must not read the organization's balance"
    assert footprint(db, ORG_A) == before


def test_the_hold_is_the_quote_and_the_job_is_the_uis_job(db):
    drain(db)
    before = footprint(db, ORG_A)
    res = create(db, "a_full", idem=uniq())
    assert res["status"] == 201, res
    job = res["data"]
    after = footprint(db, ORG_A)
    assert after[0] == before[0] + 1 and after[1] == before[1] + 1
    assert after[2] == (before[2][0] + 1, before[2][1] + PRICE)
    assert after[3] == (before[3][0], before[3][1] + PRICE)
    row = db.su("select payer, credit_ref, quoted_credits::float, requested_by::text, status from public.creative_jobs where id=%s", [job["id"]])[0]
    assert row == ("credits", f"cj:{job['id']}", PRICE, UA, "queued"), row
    drain(db)


def test_capture_and_release_leave_the_same_ledger_as_the_studio(db):
    drain(db)
    # one job through the API, one through the Studio, both succeed with the same charge
    api_ok = create(db, "a_full", idem=uniq())["data"]["id"]
    ui_ok = db.act("authenticated", UA, "select public.create_creative_job(%s,'t2i','img-api',%s::jsonb,'exact',null,100)",
                   [ORG_A, json.dumps(PROMPT)])[0][0]["job"]["id"]
    for jid in (api_ok, ui_ok):
        done = run_job(db, jid, True, 4)
        assert done["status"] == "completed" and done["charged_credits"] == 4
    kinds = lambda ref: [k for k, _a in ledger(db, ref)]
    # reserve the quote, capture what the worker charged, release the rest of the hold
    assert kinds(f"cj:{api_ok}") == kinds(f"cj:{ui_ok}") == ["reserve", "capture", "release"]
    assert [a for _k, a in ledger(db, f"cj:{api_ok}")] == [a for _k, a in ledger(db, f"cj:{ui_ok}")]
    # the status a key reads is the settled one
    seen = get(db, "a_full", api_ok)["data"]
    assert seen["status"] == "completed" and seen["charged_credits"] == 4 and seen["quoted_credits"] == PRICE

    # and a failure releases, identically
    api_bad = create(db, "a_full", idem=uniq())["data"]["id"]
    ui_bad = db.act("authenticated", UA, "select public.create_creative_job(%s,'t2i','img-api',%s::jsonb,'exact',null,100)",
                    [ORG_A, json.dumps(PROMPT)])[0][0]["job"]["id"]
    before = footprint(db, ORG_A)[3]
    for jid in (api_bad, ui_bad):
        assert run_job(db, jid, False)["status"] == "failed"
    kinds2 = lambda ref: [k for k, _a in ledger(db, ref)]
    assert kinds2(f"cj:{api_bad}") == kinds2(f"cj:{ui_bad}") == ["reserve", "release"]
    assert footprint(db, ORG_A)[3] == (before[0], before[1] - 2 * PRICE), "a failed generation kept its hold"
    seen = get(db, "a_full", api_bad)["data"]
    assert seen["status"] == "failed" and seen["charged_credits"] == 0 and seen["error_code"] == "content_policy"


def test_a_price_above_max_credits_is_refused_and_not_charged(db):
    drain(db)
    before = footprint(db, ORG_A)
    res = create(db, "a_full", maxc=PRICE - 1, idem=uniq())
    assert res["status"] == 409 and code(res) == "price_changed", res
    assert footprint(db, ORG_A) == before
    ok = create(db, "a_full", maxc=PRICE, idem=uniq())
    assert ok["status"] == 201, ok
    drain(db)


def test_max_credits_and_an_idempotency_key_are_required(db):
    before = footprint(db, ORG_A)
    for kwargs, want in (({"maxc": None, "idem": uniq()}, "max_credits_required"),
                         ({"maxc": -1, "idem": uniq()}, "max_credits_required"),
                         ({"maxc": 100, "idem": None}, "idempotency_key_required")):
        res = create(db, "a_full", **kwargs)
        assert res["status"] == 400 and code(res) == want, (kwargs, res)
    assert footprint(db, ORG_A) == before
    bad = create(db, "a_full", idem="not valid!")
    assert code(bad) == "invalid_idempotency_key", bad
    assert footprint(db, ORG_A) == before


def test_not_enough_credits_holds_nothing(db):
    drain(db)
    # ORG_B has 100 credits: priced above that, the generation is refused whole.
    db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_img_api_image', 500, 0) "
          "on conflict (unit) do update set credits_per_unit = 500, margin = 0")
    try:
        before = footprint(db, ORG_B)
        res = create(db, "b_full", maxc=1000, idem=uniq())
        assert res["status"] == 402 and code(res) == "insufficient_credits", res
        assert res["error"]["needed_credits"] == 500 and res["error"]["available_credits"] == 100
        assert footprint(db, ORG_B) == before
    finally:
        db.su("update public.credit_prices set credits_per_unit = 4, margin = 0.5 where unit = 'model_img_api_image'")


def test_the_plans_parallel_run_limit_applies_to_the_api_too(db):
    drain(db)
    db.su("update public.plan_entitlements set value = '1' where key = 'concurrency'")
    try:
        first = create(db, "a_full", idem=uniq())
        assert first["status"] == 201, first
        before = footprint(db, ORG_A)
        res = create(db, "a_full", idem=uniq())
        assert res["status"] == 429 and code(res) == "run_limit_reached", res
        assert res["error"]["limit"] == 1 and res["error"]["active"] == 1 and res["error"]["retry_after"] == 60
        assert footprint(db, ORG_A) == before
    finally:
        db.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
        drain(db)


def test_a_retry_with_the_same_key_pays_once(db):
    drain(db)
    before = footprint(db, ORG_A)
    idem = uniq()
    first = create(db, "a_full", idem=idem)
    again = create(db, "a_full", idem=idem)
    # The stored answer is replayed as it was (201), marked as a replay.
    assert first["status"] == 201 and again["status"] == 201 and again["replayed"] is True, (first, again)
    assert again["data"]["id"] == first["data"]["id"]
    after = footprint(db, ORG_A)
    assert (after[0], after[1], after[2][0]) == (before[0] + 1, before[1] + 1, before[2][0] + 1)
    assert after[2][1] == before[2][1] + PRICE
    drain(db)


def test_the_same_idempotency_key_with_another_request_is_refused(db):
    drain(db)
    idem = uniq()
    assert create(db, "a_full", idem=idem)["status"] == 201
    before = footprint(db, ORG_A)
    res = create(db, "a_full", params={"prompt": "something else"}, idem=idem)
    assert res["status"] == 422 and code(res) == "idempotency_key_reused", res
    assert footprint(db, ORG_A) == before
    drain(db)


def test_two_keys_of_one_org_never_share_an_idempotency_key(db):
    drain(db)
    idem = uniq()
    one = create(db, "a_full", idem=idem)
    two = create(db, "a_full2", idem=idem)
    assert one["status"] == 201 and two["status"] == 201, (one, two)
    assert one["data"]["id"] != two["data"]["id"], "a second key replayed the first key's generation"
    assert get(db, "a_full", two["data"]["id"])["status"] == 404
    assert get(db, "a_full2", one["data"]["id"])["status"] == 404
    drain(db)


def test_a_keys_monthly_credit_ceiling_holds(db):
    drain(db)
    ids = []
    res = create(db, "a_limited", idem=uniq())
    assert res["status"] == 201, res            # 6 of 10 credits
    ids.append(res["data"]["id"])
    before = footprint(db, ORG_A)
    refused = create(db, "a_limited", idem=uniq())
    assert refused["status"] == 402 and code(refused) == "key_credit_limit_reached", refused
    assert refused["error"]["limit_credits"] == 10 and refused["error"]["month_credits"] == PRICE
    assert footprint(db, ORG_A) == before
    # a failed job gives its share back
    run_job(db, ids[0], False)
    again = create(db, "a_limited", idem=uniq())
    assert again["status"] == 201, again
    drain(db)


def test_a_replay_is_not_counted_against_the_ceiling_again(db):
    drain(db)
    idem = uniq()
    first = create(db, "a_limited", idem=idem)
    assert first["status"] == 201, first
    # the stored response is replayed, and the ceiling (6 of 10 used) does not refuse it
    again = create(db, "a_limited", idem=idem)
    assert again["replayed"] is True and again["data"]["id"] == first["data"]["id"], again
    # Once the API's 24-hour replay record is gone, the job's own idempotency key still answers (200, the same job).
    db.su("delete from public.api_idempotency where key_id=%s and idem_key=%s", [db.key_id["a_limited"], idem])
    late = create(db, "a_limited", idem=idem)
    assert late["status"] == 200 and late["data"]["id"] == first["data"]["id"], late
    drain(db)


def test_only_exact_mode_and_known_params_are_accepted(db):
    before = footprint(db, ORG_A)
    res = create(db, "a_full", mode="auto", idem=uniq())
    assert res["status"] == 422 and code(res) == "mode_not_supported", res
    res = create(db, "a_full", params={"prompt": "x", "org_id": ORG_B}, idem=uniq())
    assert res["status"] == 400 and code(res) == "invalid_params", res
    assert footprint(db, ORG_A) == before


def test_a_model_the_vendor_keeps_off_the_api_is_refused_on_the_api_only(db):
    drain(db)
    before = footprint(db, ORG_A)
    for res in (quote(db, "a_full", model="img-webonly"), create(db, "a_full", model="img-webonly", idem=uniq())):
        assert res["status"] == 422 and code(res) == "model_not_sellable", res
    assert footprint(db, ORG_A) == before
    # The Studio offers it (web surface): the gate is the API's own.
    web = db.act("authenticated", UA, "select public.create_creative_job(%s,'t2i','img-webonly',%s::jsonb,'exact',null,100)",
                 [ORG_A, json.dumps(PROMPT)])[0][0]
    assert web["job"]["status"] == "queued"
    drain(db)
    # and an unknown model is the same answer, never a different one that confirms a name
    unknown = quote(db, "a_full", model="no-such-model")
    assert unknown["status"] == 422 and code(unknown) == "model_not_sellable"


# ── request limits ──────────────────────────────────────────────────────────

def test_a_keys_request_limit_lowers_the_tier_limit(db):
    calls = [("select public.api_auth(%s,null)", [H("a_slow")])] * 3
    res = db.many("anon", calls)
    assert [r["status"] for r in res] == [200, 200, 429], res
    assert res[2]["error"]["code"] == "rate_limit_exceeded" and res[0]["rate"]["limit"] == 2


def test_a_key_limit_cannot_raise_the_tier_limit(db):
    # Organization C is on tier 0: 10 requests a minute. A key asking for 300 gets 10.
    assert db.su("select rpm from public.api_tier_limits(public.api_tier_for(0, false))")[0][0] == 10
    db.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes, rpm_limit) values (%s,'fast',%s,%s,%s,300)",
          [ORG_C, H("c_fast"), UA, ALL_CREATIVE])
    res = db.many("anon", [("select public.api_auth(%s,null)", [H("c_fast")])] * 11)
    assert [r["status"] for r in res] == [200] * 10 + [429], [r["status"] for r in res]
    assert res[0]["rate"]["limit"] == 10, res[0]["rate"]


def test_a_refused_scope_still_counts_as_a_request(db):
    logged = lambda: db.su("select count(*) from public.api_requests where key_id=%s and endpoint='creative.quote' and status=403",
                           [db.key_id["a_legacy"]])[0][0]
    before = logged()
    res = quote(db, "a_legacy")
    assert code(res) == "insufficient_scope" and res["rate"]["limit"] == 300
    assert logged() == before + 1, "a refused call must still be logged"


# ── failure inside the database ─────────────────────────────────────────────

def test_a_failure_inside_create_is_a_structured_500_with_no_job_and_no_hold(db):
    drain(db)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        try:
            c.execute("""
                create or replace function public.api_audit(p_ctx jsonb, p_action text, p_target text, p_channel text, p_detail jsonb)
                  returns void language plpgsql security definer set search_path = public, pg_temp as $$
                begin raise exception 'injected fault: secret detail'; end $$""")
            jobs = c.execute("select count(*) from public.creative_jobs where org_id=%s", [ORG_A]).fetchone()[0]
            held = c.execute("select count(*) from public.credit_reservations where org_id=%s and job_id like 'cj:%%'", [ORG_A]).fetchone()[0]
            c.execute("select set_config('request.jwt.claims', %s, true)", [claims("anon")])
            c.execute("set local role anon")
            res = c.execute("select public.api_creative_create(%s,'t2i','img-api',%s::jsonb,'exact',100,'k-fault',%s,null)",
                            [H("a_full"), json.dumps(PROMPT), fp("fault")]).fetchone()[0]
            c.execute("reset role")
            jobs2 = c.execute("select count(*) from public.creative_jobs where org_id=%s", [ORG_A]).fetchone()[0]
            held2 = c.execute("select count(*) from public.credit_reservations where org_id=%s and job_id like 'cj:%%'", [ORG_A]).fetchone()[0]
            links = c.execute("select count(*) from public.api_creative_jobs where org_id=%s", [ORG_A]).fetchone()[0]
            idem = c.execute("select count(*) from public.api_idempotency where idem_key='k-fault'").fetchone()[0]
        finally:
            c.rollback()
    assert res["ok"] is False and res["status"] == 500 and code(res) == "internal_error", res
    assert "injected" not in json.dumps(res) and "secret" not in json.dumps(res)
    assert (jobs2, held2) == (jobs, held), "a failed create left a job or a hold behind"
    assert idem == 0, "the idempotency key stayed claimed by a request that failed"


def test_a_database_refusal_never_leaks_its_text(db):
    for state, msg, detail in (("XX000", "relation api_secret does not exist", "password=hunter2"),
                               ("42P01", "boom", None), ("23505", "duplicate key value", "Key (x)=(y)")):
        res = db.su("select public.api_creative_refusal(%s,%s,%s)", [state, msg, detail])[0][0]
        assert res["status"] == 500 and "hunter2" not in json.dumps(res) and "relation" not in json.dumps(res), res


# ── the Developer console's calls ───────────────────────────────────────────

def test_only_an_org_admin_can_mint_or_change_a_scoped_key(db):
    scopes = ["creative:read"]
    for uid, role in ((UA_VIEWER, "authenticated"), (UB, "authenticated"), (USTRANGER, "authenticated")):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, uid, "select public.create_scoped_api_key(%s,'x',null,%s,null,null)", [ORG_A, scopes])
        assert e.value.sqlstate == "42501", (uid, e.value)
        with pytest.raises(psycopg.Error) as e:
            db.act(role, uid, "select public.set_api_key_access(%s,%s,null,null)", [db.key_id["a_full"], scopes])
        assert e.value.sqlstate == "42501", (uid, e.value)
    with pytest.raises(psycopg.Error) as e:
        db.act("anon", None, "select public.create_scoped_api_key(%s,'x',null,%s,null,null)", [ORG_A, scopes])
    assert e.value.sqlstate == "42501"
    # the key is untouched
    assert db.su("select scopes from public.api_keys where id=%s", [db.key_id["a_full"]])[0][0] == ALL_CREATIVE


@pytest.mark.parametrize("scopes,rpm,credits", [
    ([], None, None), (None, None, None), (["root"], None, None), (["creative:read", None], None, None),
    (["creative:read"], 0, None), (["creative:read"], 301, None), (["creative:read"], None, -1),
])
def test_a_scoped_key_needs_valid_scopes_and_limits(db, scopes, rpm, credits):
    before = db.su("select count(*) from public.api_keys where org_id=%s", [ORG_A])[0][0]
    with pytest.raises(psycopg.Error) as e:
        db.act("authenticated", UA, "select public.create_scoped_api_key(%s,'x',null,%s,%s,%s)", [ORG_A, scopes, rpm, credits])
    assert e.value.sqlstate in ("22023", "22004"), e.value
    assert db.su("select count(*) from public.api_keys where org_id=%s", [ORG_A])[0][0] == before, "an invalid request still minted a key"


def test_a_minted_scoped_key_carries_exactly_what_was_chosen(db):
    made = db.act("authenticated", UA, "select public.create_scoped_api_key(%s,'scoped',null,%s,5,12.5)",
                  [ORG_A, ["creative:read", "creative:quote", "creative:read"]])[0][0]
    key = made["key"]
    row = db.su("select scopes, rpm_limit, creative_monthly_credits::float from public.api_keys where id=%s", [made["id"]])[0]
    try:
        assert row == (["creative:quote", "creative:read"], 5, 12.5), row
        me = db.act("anon", None, "select public.api_auth(%s,null)", [hashlib.sha256(key.encode()).hexdigest()])[0][0]
        assert me["data"]["key"]["scopes"] == ["creative:quote", "creative:read"]
        assert me["data"]["limits"]["requests_per_minute"] == 5
        # it cannot create
        res = db.act("anon", None, "select public.api_creative_create(%s,'t2i','img-api','{}'::jsonb,'exact',9,'k',%s,null)",
                     [hashlib.sha256(key.encode()).hexdigest(), fp("x")])[0][0]
        assert code(res) == "insufficient_scope"
        audit = db.su("select detail::text from public.app_audit_log where action='api_key.access' and target=%s", [made["id"]])
        assert audit and key[len("nsk_live_"):] not in audit[0][0], "the key reached the audit log"
    finally:
        db.su("delete from public.api_keys where id=%s", [made["id"]])


def test_an_admin_can_narrow_a_key_and_it_applies_on_the_next_request(db):
    k = db.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s,'edit-me',%s,%s,%s) returning id::text",
              [ORG_A, H("a_edit"), UA, ALL_CREATIVE])[0][0]
    try:
        assert quote(db, "a_edit")["status"] == 200
        assert db.act("authenticated", UA, "select public.set_api_key_access(%s,%s,null,null)", [k, ["creative:read"]])[0][0] is True
        res = quote(db, "a_edit")
        assert res["status"] == 403 and code(res) == "insufficient_scope", res
        db.su("update public.api_keys set revoked_at = now() where id=%s", [k])
        with pytest.raises(psycopg.Error) as e:
            db.act("authenticated", UA, "select public.set_api_key_access(%s,%s,null,null)", [k, ALL_CREATIVE])
        assert e.value.sqlstate == "22023", "a revoked key was given scopes back"
    finally:
        db.su("delete from public.api_keys where id=%s", [k])


# ── tables and function grants ──────────────────────────────────────────────

def test_the_link_table_is_read_only_and_admin_only(db):
    for role, uid in (("anon", None), ("authenticated", UA_VIEWER), ("authenticated", USTRANGER), ("authenticated", UB)):
        try:
            rows = db.act(role, uid, "select job_id from public.api_creative_jobs where org_id=%s", [ORG_A])
        except psycopg.Error:
            rows = []
        assert not rows, (role, uid, rows)
    for who in (("authenticated", UA), ("service_role", None)):
        for q in ("insert into public.api_creative_jobs (job_id, key_id, org_id) select id, %s, org_id from public.creative_jobs limit 1",
                  "update public.api_creative_jobs set key_id = %s", "delete from public.api_creative_jobs where key_id = %s"):
            with pytest.raises(psycopg.Error):
                db.act(*who, q, [db.key_id["a_full"]])
    # an admin of the organization reads its own
    assert db.act("authenticated", UA, "select count(*) from public.api_creative_jobs where org_id=%s", [ORG_A])[0][0] >= 0


@pytest.mark.parametrize("fn,args", [
    ("api_creative_month_credits", "%s::uuid"),
    ("api_creative_model_ok", "'t2i','img-api'"),
    ("api_creative_refusal", "'42501','x',null"),
    ("api_endpoint_scope", "'me'"),
    ("api_legacy_scopes", ""),
    ("api_scopes_valid", "array['creative:read']"),
])
def test_the_helpers_are_not_callable_from_the_api(db, fn, args):
    for role, uid in (("anon", None), ("authenticated", UA), ("service_role", None)):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, uid, f"select public.{fn}({args})", [db.key_id["a_full"]] if "%s" in args else None)
        assert e.value.sqlstate == "42501", (fn, role, e.value)


def test_the_console_calls_are_not_for_anon(db):
    with pytest.raises(psycopg.Error) as e:
        db.act("anon", None, "select public.set_api_key_access(%s,%s,null,null)", [db.key_id["a_full"], ["creative:read"]])
    assert e.value.sqlstate == "42501"
