"""Breach: the MCP Studio tools' database half (0162) and the 0062 doors they call, attacked as a key holder, a connected app and
an anonymous caller holding only the public anon key.

tests/security/test_sec_mcp_studio_tools.py is the PR's own proof. This file is the red team's: every attack below was tried in the
lab, and each test pins what the database must answer. A test that fails here is a hole that is still open.

* a connected app's real access token (0093) reaches neither 0162 function, whatever its permissions;
* a key whose creator lost the admin role, and an organization whose API was switched off, read nothing;
* a generation started in the web Studio, a video job's id, and every other key's generation read 404 for every key;
* only models create would sell are listed: never preview/hidden (a terms gate cannot be on sale: 0035's CHECK), switched-off, past-shutdown, unpriced, web-only, a
  plan feature, a `paid:<x>` entitlement, or a model of another capability; an injected capability is a 400 and writes nothing;
* a generation that FAILED and released its hold lists no files: a file link is the thing that was paid for (finding BR-0162-1);
* idempotency: a concurrent double create with one key pays once; a replay with other params is refused; a huge max_credits is
  never what is charged; the key's monthly ceiling holds under a race of two different creates.

Runs in its own scratch database (it commits).
"""

import hashlib
import json
import os
import threading
import uuid

import psycopg
import pytest

import sec_db

ORG_A = "aaaaaaaa-0000-0000-0000-0000000b0162"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000b0162"
ORG_C = "cccccccc-0000-0000-0000-0000000b0162"  # its key's creator is demoted to editor
ORG_D = "dddddddd-0000-0000-0000-0000000b0162"  # its API is not activated
UA = str(uuid.UUID(int=0xBA0162))
UB = str(uuid.UUID(int=0xBB0162))
UC = str(uuid.UUID(int=0xBC0162))
UD = str(uuid.UUID(int=0xBD0162))

H = lambda name: hashlib.sha256(f"breach-0162-{name}".encode()).hexdigest()

ALL = ["creative:quote", "creative:create", "creative:read"]
KEYS = {
    "a_full": (ORG_A, UA, ALL),
    "a_full2": (ORG_A, UA, ALL),
    "a_limited": (ORG_A, UA, ALL),  # creative_monthly_credits set below
    "a_create_only": (ORG_A, UA, ["creative:create"]),
    "b_full": (ORG_B, UB, ALL),
    "c_full": (ORG_C, UC, ALL),
    "d_full": (ORG_D, UD, ALL),
}

PROMPT = {"prompt": "a lighthouse at dawn"}

# (id, capabilities, extra spec, entitlement, availability, priced)
MODELS = [
    ("bimg-ok", ["t2i"], {}, "any", "beta", True),
    ("bimg-hidden", ["t2i"], {"operator_preview": True}, "any", "hidden", True),
    ("bimg-disabled", ["t2i"], {}, "any", "disabled", True),
    ("bimg-off", ["t2i"], {}, "any", "beta", True),  # switched off below
    ("bimg-sunset", ["t2i"], {"shutdown": {"on": "2000-01-01"}}, "any", "beta", True),
    ("bimg-unpriced", ["t2i"], {}, "any", "beta", False),
    ("bimg-webonly", ["t2i"], {"api_exposure": "web_only"}, "any", "beta", True),
    ("bimg-plan", ["t2i"], {}, "pro_models", "beta", True),
    ("bimg-paidx", ["t2i"], {}, "paid:studio", "beta", True),
    ("bimg-tts", ["tts"], {}, "any", "beta", True),
]


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

    def anon(self, q, p=None):
        return self.act("anon", None, q, p)[0][0]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_0162_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@b0162.io'),(%s,'b@b0162.io'),(%s,'c@b0162.io'),(%s,'d@b0162.io')",
         [UA, UB, UC, UD])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-a-b0162'),(%s,'B','org-b-b0162'),"
         "(%s,'C','org-c-b0162'),(%s,'D','org-d-b0162')", [ORG_A, ORG_B, ORG_C, ORG_D])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@b0162.io','owner'),"
         "(%s,%s,'b@b0162.io','owner'),(%s,%s,'c@b0162.io','owner'),(%s,%s,'d@b0162.io','owner')",
         [ORG_A, UA, ORG_B, UB, ORG_C, UC, ORG_D, UD])
    for org in (ORG_A, ORG_B, ORG_C, ORG_D):
        d.su("select public.grant_credits(%s, 100, 'test')", [org])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values "
         "(%s, now(), %s, 'v1'), (%s, now(), %s, 'v1'), (%s, now(), %s, 'v1')", [ORG_A, UA, ORG_B, UB, ORG_C, UC])
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s,0,100000),(%s,0,100000),"
         "(%s,0,100000),(%s,0,100000)", [ORG_A, ORG_B, ORG_C, ORG_D])
    rows = [{"id": m, "display_name": m.upper(), "provider": "acme", "adapter": "audio.acme" if caps == ["tts"] else "image.acme",
             "capabilities": caps, "credit_unit": f"model_{m.replace('-', '_')}_unit", "entitlement": ent,
             "spec": {"vendor_model": "acme-" + m, "output": "audio" if caps == ["tts"] else "image", **extra}}
            for m, caps, extra, ent, _a, _p in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, _x, _e, avail, priced in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, "audio.acme" if caps == ["tts"] else "image.acme", "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability=%s where id=%s", [avail, m])
        if priced:
            d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 4, 0.5) on conflict (unit) do nothing",
                 [f"model_{m.replace('-', '_')}_unit"])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit")
    # The owner's switch (0124), in force, with one model off.
    d.su("insert into public.model_availability_settings (id, enforced) values (true, true) "
         "on conflict (id) do update set enforced = true")
    d.su("insert into public.model_availability (scope, target, enabled, reason) values ('model', 'bimg-off', false, 'vendor_outage')")
    d.key_id = {}
    for k, (org, uid, scopes) in KEYS.items():
        d.key_id[k] = d.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s,%s,%s,%s,%s) "
                           "returning id::text", [org, k, H(k), uid, scopes])[0][0]
    # A key's own monthly ceiling: room for exactly one 6-credit generation.
    d.su("update public.api_keys set creative_monthly_credits = 10 where id = %s", [d.key_id["a_limited"]])
    # C's key creator is no longer an admin of C (editor).
    d.su("update public.org_members set role = 'editor' where org_id = %s and user_id = %s", [ORG_C, UC])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def models(db, key=None, cap=None, raw_hash=None):
    return db.anon("select public.api_creative_models(%s,%s,null)", [raw_hash or H(key), cap])


def files(db, key, job_id, raw_hash=None):
    return db.anon("select public.api_creative_job_files(%s,%s,null)", [raw_hash or H(key), job_id])


def create(db, key, idem, params=None, max_credits=100, model="bimg-ok", fingerprint=None):
    p = params if params is not None else PROMPT
    fp = fingerprint or hashlib.sha256(json.dumps([model, p, max_credits], sort_keys=True).encode()).hexdigest()
    return db.anon("select public.api_creative_create(%s,'t2i',%s,%s::jsonb,'exact',%s,%s,%s,null)",
                   [H(key), model, json.dumps(p), max_credits, idem, fp])


def code(res):
    return res["error"]["code"] if res.get("ok") is False else None


def ids(res):
    return [m["id"] for m in res["data"]["models"]]


def credits(db, org):
    return tuple(float(x) for x in db.su("select balance, reserved from public.credit_accounts where org_id=%s", [org])[0])


def oauth_token(db, uid, org):
    """A live access token of a connected app with every permission a grant can carry, the way 0093's exchange leaves it."""
    cid = db.su("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) values "
                "('breach', array['https://claude.ai/api/mcp/auth_callback'], %s) returning client_id::text",
                [hashlib.sha256(uuid.uuid4().bytes).hexdigest()])[0][0]
    grant = db.su("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits, activated_at) "
                  "values (%s,%s,%s,array['videos:read','videos:create','videos:publish'],'https://nightshift-ai.studio/api/mcp',500,now()) "
                  "returning id::text", [uid, org, cid])[0][0]
    at = "at-" + uuid.uuid4().hex
    h = hashlib.sha256(at.encode()).hexdigest()
    db.su("insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values (%s,%s,'access',now() + interval '1 hour')",
          [h, grant])
    assert db.su("select public.oauth_token_state(%s) is not null", [h])[0][0], "the lab token must be live"
    return h


# ── who may call ───────────────────────────────────────────────────────────

def test_a_connected_apps_live_token_reaches_neither_function(db):
    tok = oauth_token(db, UA, ORG_A)
    job = create(db, "a_full", "oauth-" + uuid.uuid4().hex)["data"]["id"]
    for res in (models(db, raw_hash=tok), files(db, None, job, raw_hash=tok)):
        assert res["ok"] is False and res["status"] == 403 and code(res) == "not_available_for_connected_apps", res
        assert "data" not in res, res


def test_a_key_whose_creator_is_no_longer_admin_reads_nothing(db):
    job = db.su("select id::text from public.creative_jobs where org_id = %s limit 1", [ORG_A])
    for res in (models(db, "c_full"), files(db, "c_full", job[0][0] if job else str(uuid.uuid4()))):
        assert res["status"] == 403 and code(res) == "key_owner_not_admin", res


def test_an_organization_without_the_api_activated_reads_nothing(db):
    for res in (models(db, "d_full"), files(db, "d_full", str(uuid.uuid4()))):
        assert res["status"] == 403 and code(res) == "api_not_activated", res


@pytest.mark.parametrize("raw", [None, "", "X" * 64, H("a_full").upper(), H("a_full") + "\n", " " + H("a_full"),
                                 "' or 1=1 --", H("a_full")[:63]])
def test_a_mangled_key_hash_is_401_before_anything_is_read(db, raw):
    before = db.su("select count(*) from public.api_requests")[0][0]
    for q, p in (("select public.api_creative_models(%s,null,null)", [raw]),
                 ("select public.api_creative_job_files(%s,%s,null)", [raw, str(uuid.uuid4())])):
        res = db.anon(q, p)
        assert res["status"] == 401 and code(res) == "invalid_api_key", (raw, res)
    assert db.su("select count(*) from public.api_requests")[0][0] == before


def test_a_create_only_key_can_neither_list_nor_read_files(db):
    job = create(db, "a_create_only", "co-" + uuid.uuid4().hex)
    assert job["ok"], job
    assert models(db, "a_create_only")["error"]["required_scope"] == "creative:quote"
    assert files(db, "a_create_only", job["data"]["id"])["error"]["required_scope"] == "creative:read"


# ── whose generation ───────────────────────────────────────────────────────

def test_a_web_studio_generation_is_404_to_every_key_of_its_organization(db):
    out = db.act("authenticated", UA, "select public.create_creative_job(%s,'t2i','bimg-ok',%s::jsonb,'exact',%s,%s)",
                 [ORG_A, json.dumps(PROMPT), "web-" + uuid.uuid4().hex, 100])[0][0]
    job = out["job"]["id"]
    for k in ("a_full", "a_full2", "a_limited", "b_full"):
        res = files(db, k, job)
        assert res["status"] == 404 and code(res) == "job_not_found", (k, res)


def test_another_keys_generation_is_404_even_inside_one_organization(db):
    job = create(db, "a_full", "own-" + uuid.uuid4().hex)["data"]["id"]
    for k in ("a_full2", "a_limited", "b_full"):
        assert files(db, k, job)["status"] == 404, k
    # And the same 404 as an id that never existed: nothing confirms the job is there.
    assert {k: v for k, v in files(db, "a_full2", job).items() if k != "rate"} == \
           {k: v for k, v in files(db, "a_full2", str(uuid.uuid4())).items() if k != "rate"}


def test_a_failed_generation_whose_hold_was_released_lists_no_files(db):
    """BR-0162-1. The worker attaches a job's outputs (attach_creative_job_assets, status 'processing') BEFORE it settles the job;
    a finish that then fails (a later step raises, the worker dies and the stale sweep ends it, a region edit that applied
    nothing) releases the whole hold and charges 0, and result_asset_ids keeps the attached outputs. api_creative_job_files does not
    look at the status, so get_generation hands the key signed links to the original file of a generation that was refunded.
    Before 0162 the API answered only asset ids, which a key cannot download; the file link is new with this PR."""
    res = create(db, "a_full", "refund-" + uuid.uuid4().hex)
    assert res["ok"], res
    job = res["data"]["id"]
    worker = "breach-worker"
    db.su("update public.creative_jobs set expires_at = now() + interval '1 hour' where id = %s", [job])
    # Claim exactly this job: park every other queued job of the lab out of the claim's reach for the moment.
    parked = [r[0] for r in db.su("update public.creative_jobs set status = 'cancelled' where status = 'queued' and id <> %s "
                                  "returning id::text", [job])]
    try:
        claimed = db.act("service_role", None, "select * from public.claim_creative_job(%s, '10 minutes'::interval)", [worker])
        assert claimed, "the worker must claim the job"
    finally:
        if parked:
            db.su("update public.creative_jobs set status = 'queued' where id = any(%s::uuid[])", [parked])
    for step, task in (("submitting", None), ("submitted", "task-1")):
        assert db.act("service_role", None, "select public.advance_creative_job(%s,%s,%s,%s,null)", [job, worker, step, task])[0][0], step
    assert db.act("service_role", None, "select public.advance_creative_job(%s,%s,'processing',null,null)", [job, worker])[0][0]
    aid = str(uuid.uuid4())
    db.act("service_role", None,
           "select public.register_asset(%s, %s, 'image', 'image/png', 1000, %s, 'generated', p_width => 64, p_height => 64, "
           "p_provenance => %s::jsonb)", [aid, ORG_A, uuid.uuid4().hex * 2, json.dumps({"job_id": job})])
    assert db.act("service_role", None, "select public.attach_creative_job_assets(%s,%s,%s::uuid[])", [job, worker, [aid]])[0][0]
    db.act("service_role", None, "select public.finish_creative_job(%s,%s,false,null,null,'provider_error','lab failure')", [job, worker])
    st = db.su("select status, charged_credits::float from public.creative_jobs where id = %s", [job])[0]
    assert st == ("failed", 0.0), st
    out = files(db, "a_full", job)
    assert out["ok"], out
    assert out["data"]["status"] == "failed"
    assert out["data"]["files"] == [], (
        "a failed, refunded generation is handed its output files: get_generation would sign a link to them", out["data"]["files"])


# ── what is listed ─────────────────────────────────────────────────────────

def test_only_models_create_would_sell_are_listed(db):
    listed = ids(models(db, "a_full"))
    assert listed == ["bimg-ok", "bimg-tts"], listed
    # Each listed model, for each capability it is listed with, is one a quote accepts: nothing is shown that is not.
    for m in models(db, "a_full")["data"]["models"]:
        for cap in m["capabilities"]:
            q = db.anon("select public.api_creative_quote(%s,%s,%s,%s::jsonb,null)",
                        [H("a_full"), cap, m["id"], json.dumps(PROMPT if cap == "t2i" else {"text": "hello there"})])
            assert q["ok"] or code(q) == "invalid_params", (m["id"], cap, q)
    # And every unlisted one is refused by quote (the list never hides what create would sell either).
    for mid in ("bimg-hidden", "bimg-disabled", "bimg-off", "bimg-sunset", "bimg-unpriced", "bimg-webonly",
                "bimg-plan", "bimg-paidx"):
        q = db.anon("select public.api_creative_quote(%s,'t2i',%s,%s::jsonb,null)", [H("a_full"), mid, json.dumps(PROMPT)])
        assert q["ok"] is False, (mid, q)


def test_a_paid_colon_entitlement_is_never_listed_even_after_a_purchase(db):
    db.su("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, note) "
          "select %s, 'purchase', 0, balance, reserved, 'lab purchase' from public.credit_accounts where org_id = %s", [ORG_B, ORG_B])
    assert "bimg-paidx" not in ids(models(db, "b_full"))
    assert "bimg-plan" not in ids(models(db, "b_full"))


def test_a_capability_narrows_to_its_own_models(db):
    assert ids(models(db, "a_full", "tts")) == ["bimg-tts"]
    assert ids(models(db, "a_full", "t2i")) == ["bimg-ok"]


@pytest.mark.parametrize("cap", ["t2i' or '1'='1", "t2i;select pg_sleep(5)", "t2i,tts", "%", "t2ı", "x" * 100000,
                                 "music", "TTS ", "../t2i"])
def test_an_injected_capability_is_400_or_its_own_list_and_writes_nothing(db, cap):
    before = credits(db, ORG_A), db.su("select count(*) from public.creative_jobs")[0][0]
    res = models(db, "a_full", cap)
    if cap.strip(" ").lower() == "tts":
        assert ids(res) == ["bimg-tts"], res
    else:
        assert res["status"] == 400 and code(res) == "invalid_params", (cap[:40], res)
        # The refusal never echoes the caller's string back (it would be reflected into an assistant's context).
        assert cap[:20] not in json.dumps(res["error"]), res
    assert (credits(db, ORG_A), db.su("select count(*) from public.creative_jobs")[0][0]) == before


# ── credits ────────────────────────────────────────────────────────────────

def test_a_huge_max_credits_is_never_what_is_charged(db):
    before = credits(db, ORG_A)
    res = create(db, "a_full", "huge-" + uuid.uuid4().hex, max_credits=10**15)
    assert res["ok"], res
    held = res["data"]["quoted_credits"]
    assert float(held) == 6.0, res
    after = credits(db, ORG_A)
    assert after[1] - before[1] == pytest.approx(6.0), (before, after)


def test_a_negative_max_credits_is_refused_and_holds_nothing(db):
    before = credits(db, ORG_A)
    res = create(db, "a_full", "neg-" + uuid.uuid4().hex, max_credits=-1)
    assert res["status"] == 400 and code(res) == "max_credits_required", res
    assert credits(db, ORG_A) == before


def test_a_replay_with_other_params_and_the_same_fingerprint_never_makes_a_second_job(db):
    """The fingerprint is the Command Center's, but PostgREST takes it from anyone with the anon key: a caller may send the first
    request's fingerprint with other params. The answer must be the first job, never a new one and never a second hold."""
    idem = "fp-" + uuid.uuid4().hex
    first = create(db, "a_full", idem, fingerprint="f" * 64)
    assert first["ok"], first
    before = credits(db, ORG_A), db.su("select count(*) from public.creative_jobs where org_id=%s", [ORG_A])[0][0]
    again = create(db, "a_full", idem, params={"prompt": "something else entirely"}, max_credits=1000, fingerprint="f" * 64)
    assert again.get("data", {}).get("id") in (None, first["data"]["id"]), again
    assert (credits(db, ORG_A), db.su("select count(*) from public.creative_jobs where org_id=%s", [ORG_A])[0][0]) == before


def test_a_replay_with_other_params_is_refused(db):
    idem = "rp-" + uuid.uuid4().hex
    assert create(db, "a_full", idem)["ok"]
    res = create(db, "a_full", idem, params={"prompt": "another picture"})
    assert res["status"] == 422 and code(res) == "idempotency_key_reused", res


def _race(db, calls):
    barrier = threading.Barrier(len(calls))
    out = [None] * len(calls)

    def run(i, fn):
        barrier.wait()
        out[i] = fn()

    ts = [threading.Thread(target=run, args=(i, fn)) for i, fn in enumerate(calls)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(30)
    return out


def test_two_concurrent_creates_with_one_idempotency_key_hold_once(db):
    idem = "race-" + uuid.uuid4().hex
    before = credits(db, ORG_A)
    jobs_before = db.su("select count(*) from public.creative_jobs where org_id=%s", [ORG_A])[0][0]
    out = _race(db, [lambda: create(db, "a_full", idem)] * 4)
    oks = [r for r in out if r and r.get("ok")]
    assert oks, out
    assert len({r["data"]["id"] for r in oks}) == 1, out
    assert db.su("select count(*) from public.creative_jobs where org_id=%s", [ORG_A])[0][0] == jobs_before + 1
    assert credits(db, ORG_A)[1] - before[1] == pytest.approx(6.0)


def test_the_keys_monthly_ceiling_holds_under_a_race_of_different_creates(db):
    kid = db.key_id["a_limited"]
    out = _race(db, [lambda i=i: create(db, "a_limited", f"cap-{i}-" + uuid.uuid4().hex) for i in range(4)])
    made = [r for r in out if r and r.get("ok")]
    assert len(made) == 1, out
    assert all(code(r) == "key_credit_limit_reached" for r in out if r not in made), out
    assert db.su("select count(*) from public.api_creative_jobs where key_id=%s", [kid])[0][0] == 1


# ── side effects ───────────────────────────────────────────────────────────

def test_a_refused_files_call_logs_under_the_callers_key_not_the_owners(db):
    job = create(db, "a_full", "log-" + uuid.uuid4().hex)["data"]["id"]
    owner_before = db.su("select count(*) from public.api_requests where key_id=%s", [db.key_id["a_full"]])[0][0]
    files(db, "b_full", job)
    assert db.su("select count(*) from public.api_requests where key_id=%s", [db.key_id["a_full"]])[0][0] == owner_before
    row = db.su("select org_id::text, endpoint, status from public.api_requests where key_id=%s order by created_at desc limit 1",
                [db.key_id["b_full"]])[0]
    assert row == (ORG_B, "creative.get", 404), row
