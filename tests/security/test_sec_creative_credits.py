"""Creative jobs and credits (0036), end to end in a real database: the hold
is the quote, a capture never exceeds it, every other ending releases it,
two concurrent creates cannot overspend, a replayed idempotency key returns
the same job, and a crashed job resumes by polling its stored provider task.

Runs in its own scratch database (it commits, and it needs a model registry
with sellable models): the fake registry below stands in for 0035 when that
migration is not applied. When it is (the lab applies every migration), the
same models go into the REAL table through the real path: sync_model_registry
for the file's facts, record_model_probe for the proof, then availability.
"""
import json
import os
import threading
import time
import uuid

import psycopg
import pytest

import sec_db

DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"


ORG_A = "aaaaaaaa-0000-0000-0000-00000000000a"
ORG_B = "bbbbbbbb-0000-0000-0000-00000000000b"
UA = str(uuid.UUID(int=0xA1))
UB = str(uuid.UUID(int=0xB1))
UADMIN = str(uuid.UUID(int=0xAD))

FAKE_REGISTRY = """
create table public.model_registry (
  id text primary key, provider text not null, capabilities text[] not null,
  availability text not null default 'hidden', verified_at timestamptz,
  credit_unit text, entitlement text default 'any');
alter table public.model_registry enable row level security;
"""
PRICES = """
insert into public.credit_prices (unit, credits_per_unit, margin) values
 ('model_img_x', 4, 0.5), ('model_vid_y_second', 2, 1), ('job_minimum', 5, 0);
"""
# (id, capability, availability, verified, credit_unit, entitlement)
MODELS = [
    ("img-x", "t2i", "beta", True, "model_img_x", "any"),
    ("vid-y", "t2v", "ga", True, "model_vid_y_second", "any"),
    ("img-hidden", "t2i", "hidden", True, "model_img_x", "any"),
    ("img-unverified", "t2i", "beta", False, "model_img_x", "any"),
    ("img-unpriced", "t2i", "beta", True, "model_nope", "any"),
    ("img-paid", "t2i", "beta", True, "model_img_x", "paid"),
]
REGISTRY = PRICES + """
insert into public.model_registry (id, provider, capabilities, availability, verified_at, credit_unit, entitlement) values
 ('img-x','acme','{t2i}','beta',now(),'model_img_x','any'),
 ('vid-y','acme','{t2v}','ga',now(),'model_vid_y_second','any'),
 ('img-hidden','acme','{t2i}','hidden',now(),'model_img_x','any'),
 ('img-unverified','acme','{t2i}','beta',null,'model_img_x','any'),
 ('img-unpriced','acme','{t2i}','beta',now(),'model_nope','any'),
 ('img-paid','acme','{t2i}','beta',now(),'model_img_x','paid');
"""


def install_real_registry(d):
    """The same six models in the real 0035 table, every one through the path
    production uses, so no CHECK or trigger of 0035 is bypassed, except for
    'img-unverified' (see below)."""
    adapter = lambda cap: "image.acme" if cap == "t2i" else "video.acme"
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": adapter(cap),
             "capabilities": [cap], "credit_unit": unit, "entitlement": ent,
             "spec": {"vendor_model": "acme-" + m, "output": "image" if cap == "t2i" else "video"}}
            for m, cap, _av, _v, unit, ent in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, cap, av, verified, _unit, _ent in MODELS:
        if verified:
            d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
                 [m, adapter(cap), "acme-" + m, cap])
            if av != "hidden":
                d.su("update public.model_registry set availability=%s where id=%s", [av, m])
    # 0035 makes "beta/ga without verified_at" unrepresentable (CHECK). 0036
    # still refuses such a row itself (defense in depth) and that refusal is an
    # assertion of this file, so the state is forced once: the CHECK is
    # dropped, the row set, and the CHECK re-added NOT VALID (still enforced
    # for every later write; only this one row is outside it). Scratch database.
    d.su("alter table public.model_registry drop constraint model_registry_verified_before_sale")
    d.su("update public.model_registry set availability='beta' where id='img-unverified'")
    d.su("alter table public.model_registry add constraint model_registry_verified_before_sale "
         "check (availability not in ('beta','ga') or verified_at is not null) not valid")
    d.su(PRICES)
    # Fail loudly if the real table does not hold the states the tests name.
    got = {r[0]: (r[1], r[2]) for r in d.su("select id, availability, verified_at is not null from public.model_registry")}
    want = {m: (av, v) for m, _c, av, v, _u, _e in MODELS}
    assert got == want, got


def claims(role, uid=None, email=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
    if email:
        c["email"] = email
    return json.dumps(c)


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def conn(self):
        return psycopg.connect(self.dsn, autocommit=False)

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid=None, q="", p=None, conn=None, commit=True):
        own = conn is None
        c = conn or self.conn()
        try:
            c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
            c.execute(f"set local role {role}")
            cur = c.execute(q, p)
            rows = cur.fetchall() if cur.description else None
            if own:
                if commit:
                    c.commit()
                else:
                    c.rollback()
            return rows
        except psycopg.Error:
            if own:
                c.rollback()
            raise
        finally:
            if own:
                c.close()


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_creative_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io'),(%s,'b@x.io'),(%s,'admin@x.io')", [UA, UB, UADMIN])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-a'),(%s,'B','org-b')", [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','viewer'),(%s,%s,'b@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("insert into public.app_members (user_id, email, role) values (%s,'admin@x.io','admin')", [UADMIN])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])
    d.registry_applied = d.su("select to_regclass('public.model_registry') is not null")[0][0]
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0]


def create(db, uid, org, cap="t2i", model="img-x", params=None, key=None, maxc=None, conn=None):
    params = params or {"prompt": "a cat"}
    r = db.act("authenticated", uid, "select public.create_creative_job(%s,%s,%s,%s::jsonb,'exact',%s,%s)",
               [org, cap, model, json.dumps(params), key, maxc], conn=conn)
    return r[0][0]


def acct(db, org):
    return db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org])[0]


def test_registry_missing_refuses(db):
    if db.registry_applied:
        pytest.skip("0035 is applied: the registry exists")
    st, msg = err(lambda: create(db, UA, ORG_A))
    assert st == "NS400" and "registry_missing" in msg
    st, msg = err(lambda: db.act("authenticated", UA, "select public.quote_creative_job(%s,'t2i','img-x','{\"prompt\":\"x\"}')", [ORG_A]))
    assert "registry_missing" in msg


def test_install_registry(db):
    if db.registry_applied:
        install_real_registry(db)
    else:
        db.su(FAKE_REGISTRY)
        db.su(REGISTRY)


def test_quote_is_the_hold(db):
    q = db.act("authenticated", UA, "select public.quote_creative_job(%s,'t2i','img-x','{\"prompt\":\"x\"}')", [ORG_A])[0][0]
    assert q["credits"] == 6 and q["exempt"] is False and q["available"] == 100
    before = acct(db, ORG_A)
    out = create(db, UA, ORG_A)
    j = out["job"]
    assert j["quoted_credits"] == 6 and j["status"] == "queued"
    res = db.su("select amount::float, status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]])
    assert res == [(6.0, "open")]
    assert acct(db, ORG_A) == (before[0], before[1] + 6)
    # a viewer-role member created it: no customer roles
    assert db.su("select requested_by::text from public.creative_jobs where id=%s", [j["id"]])[0][0] == UA


def test_min_floor_and_video_quantity(db):
    q = db.act("authenticated", UA, "select public.quote_creative_job(%s,'t2v','vid-y','{\"prompt\":\"x\",\"duration_s\":1}')", [ORG_A])[0][0]
    assert q["credits"] == 5  # 1s * 2 * 2 = 4 < job_minimum 5
    q = db.act("authenticated", UA, "select public.quote_creative_job(%s,'t2v','vid-y','{\"prompt\":\"x\",\"duration_s\":8}')", [ORG_A])[0][0]
    assert q["credits"] == 32 and q["quantity"] == 8


def test_refusals(db):
    for model, code in [("img-hidden", "model_not_sellable"), ("img-unverified", "model_not_sellable"),
                        ("img-unpriced", "unpriced"), ("nope", "model_not_sellable"), ("vid-y", "model_not_sellable"),
                        ("img-paid", "entitlement_required")]:
        st, msg = err(lambda: create(db, UA, ORG_A, model=model))
        assert st == "NS400" and code in msg, (model, msg)
    st, msg = err(lambda: create(db, UA, ORG_A, params={"prompt": "x", "size": 3}))
    assert "invalid_params" in msg
    st, msg = err(lambda: create(db, UA, ORG_A, params={"prompt": "x", "seed": "abc"}))
    assert "invalid_params" in msg
    st, msg = err(lambda: create(db, UA, ORG_A, cap="t2v", model="vid-y", params={"prompt": "x", "duration_s": 61}))
    assert "invalid_params" in msg
    # 0046 made i2v (and edit, upscale, remove_bg) real; a capability nobody
    # built is still refused outright.
    st, msg = err(lambda: create(db, UA, ORG_A, cap="v2v"))
    assert "capability_not_supported" in msg
    # 0075: a routed mode runs only the model and price its quote showed: a
    # press without the confirmed price is refused before anything is held.
    st, msg = err(lambda: db.act("authenticated", UA, "select public.create_creative_job(%s,'t2i','img-x','{\"prompt\":\"x\"}','auto')", [ORG_A]))
    assert st == "NS400" and "invalid_params" in msg
    st, msg = err(lambda: create(db, UA, ORG_A, maxc=5))
    assert st == "NS409" and "price_changed" in msg


def test_idempotent_replay(db):
    drain(db)  # 0034: a Free org holds one open run at a time
    a = create(db, UA, ORG_A, key="k-1")
    b = create(db, UA, ORG_A, key="k-1")
    assert a["job"]["id"] == b["job"]["id"] and b["replay"] is True
    assert db.su("select count(*) from public.credit_reservations where job_id=%s", ["cj:" + a["job"]["id"]])[0][0] == 1
    st, msg = err(lambda: create(db, UA, ORG_A, key="k-1", params={"prompt": "different"}))
    assert st == "NS409" and "idempotency_conflict" in msg
    # the same key in another org is another job
    c = create(db, UB, ORG_B, key="k-1")
    assert c["job"]["id"] != a["job"]["id"]


def test_concurrent_creates_cannot_overspend(db):
    org = str(uuid.uuid4())
    db.su("insert into public.organizations (id,name,slug) values (%s,'C',%s)", [org, "org-" + org[:8]])
    db.su("insert into public.org_members (org_id,user_id,email,role) values (%s,%s,'a@x.io','viewer')", [org, UA])
    db.su("select public.grant_credits(%s, 10, 't')", [org])
    c1 = db.conn()
    out1 = create(db, UA, org, conn=c1)  # holds the account lock, uncommitted
    result = {}

    def second():
        c2 = db.conn()
        try:
            result["ok"] = create(db, UA, org, conn=c2); c2.commit()
        except psycopg.Error as e:
            result["err"] = e.sqlstate; c2.rollback()
        finally:
            c2.close()

    t = threading.Thread(target=second); t.start()
    time.sleep(0.5)
    assert t.is_alive(), "second create must wait on the account lock"
    c1.commit(); c1.close()
    t.join(5)
    assert result.get("err") == "NS402", result
    assert acct(db, org) == (10.0, 6.0)


def test_cross_org_and_anon(db):
    drain(db)  # 0034: a Free org holds one open run at a time
    j = create(db, UA, ORG_A)["job"]
    assert db.act("authenticated", UB, "select id from public.creative_jobs where id=%s", [j["id"]]) == []
    assert db.act("authenticated", UB, "select id from public.creative_job_events where job_id=%s", [j["id"]]) == []
    st, _ = err(lambda: db.act("authenticated", UB, "select public.cancel_creative_job(%s)", [j["id"]]))
    assert st == "P0002"
    st, _ = err(lambda: create(db, UB, ORG_A))
    assert st == "42501"
    st, _ = err(lambda: db.act("authenticated", UB, "select public.quote_creative_job(%s,'t2i','img-x','{\"prompt\":\"x\"}')", [ORG_A]))
    assert st == "42501"
    for q in ["select * from public.creative_jobs", "select * from public.creative_job_events",
              "select * from public.creative_job_costs", "select * from public.creative_economics"]:
        st, _ = err(lambda: db.act("anon", None, q)); assert st == "42501", q
    st, _ = err(lambda: db.act("anon", None, "select public.create_creative_job(%s,'t2i','img-x','{}')", [ORG_A]))
    assert st == "42501"
    # browsers never write rows directly or call the worker's functions
    for q in ["update public.creative_jobs set status='completed'", "delete from public.creative_jobs",
              "insert into public.creative_jobs (org_id,capability,requested_model) values ('%s','t2i','img-x')" % ORG_A,
              "select public.claim_creative_job('w')",
              "select public.finish_creative_job('%s','w',true)" % j["id"],
              "select public.creative_platform_reserve('%s','cj:x',1)" % ORG_A,
              "select public.creative_platform_release('cj:x')",
              "select public.expire_creative_jobs()"]:
        st, _ = err(lambda: db.act("authenticated", UA, q)); assert st == "42501", q
    for q in ["update public.creative_jobs set status='completed'", "select public.creative_platform_release('cj:x')"]:
        st, _ = err(lambda: db.act("service_role", None, q)); assert st == "42501", q


def svc(db, q, p=None, conn=None):
    return db.act("service_role", None, q, p, conn=conn)


def drain(db):
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc(db, "select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


def test_worker_success_captures_at_most_the_hold(db):
    drain(db)
    j = create(db, UA, ORG_A)["job"]
    rows = svc(db, "select id::text, status, credit_ref, org_id::text from public.claim_creative_job('w1')")
    assert rows[0][0] == j["id"] and rows[0][1] == "running"
    assert svc(db, "select public.start_credit_reservation(%s,%s)", [rows[0][2], ORG_A])[0][0] == 6
    assert svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])[0][0] is True
    assert svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])[0][0] is False
    assert svc(db, "select public.advance_creative_job(%s,'w2','submitted','t-1')", [j["id"]])[0][0] is False
    assert svc(db, "select public.advance_creative_job(%s,'w1','submitted','t-1')", [j["id"]])[0][0] is True
    st, _ = err(lambda: svc(db, "select public.finish_creative_job(%s,'w1',true,7)", [j["id"]]))
    assert st == "22023"
    before = acct(db, ORG_A)
    out = svc(db, "select public.finish_creative_job(%s,'w1',true,4,'{\"files\":[]}')", [j["id"]])[0][0]
    assert out["status"] == "completed" and out["charged_credits"] == 4
    after = acct(db, ORG_A)
    assert after == (before[0] - 4, before[1] - 6)
    again = svc(db, "select public.finish_creative_job(%s,'w1',false)", [j["id"]])[0][0]
    assert again["status"] == "completed"
    assert acct(db, ORG_A) == after


def test_failure_cancel_expire_release(db):
    drain(db)
    j = create(db, UA, ORG_A)["job"]
    before = acct(db, ORG_A)
    svc(db, "select public.claim_creative_job('w1')")
    out = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'content_policy','refused')", [j["id"]])[0][0]
    assert out["status"] == "failed" and out["error_code"] == "content_policy"
    assert acct(db, ORG_A) == (before[0], before[1] - 6)
    # cancel
    j = create(db, UA, ORG_A)["job"]
    b = acct(db, ORG_A)
    out = db.act("authenticated", UA, "select public.cancel_creative_job(%s)", [j["id"]])[0][0]
    assert out["job"]["status"] == "cancelled"
    assert acct(db, ORG_A) == (b[0], b[1] - 6)
    assert db.su("select status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]])[0][0] == "released"
    # cannot cancel once the provider has it
    j = create(db, UA, ORG_A)["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    st, msg = err(lambda: db.act("authenticated", UA, "select public.cancel_creative_job(%s)", [j["id"]]))
    assert st == "NS409" and "not_cancellable" in msg
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','t-9')", [j["id"]])
    svc(db, "select public.finish_creative_job(%s,'w1',false)", [j["id"]])
    # expire
    j = create(db, UA, ORG_A)["job"]
    b = acct(db, ORG_A)
    db.su("update public.creative_jobs set expires_at = now() - interval '1 minute' where id=%s", [j["id"]])
    assert svc(db, "select public.expire_creative_jobs()")[0][0] == 1
    assert db.su("select status, error_code from public.creative_jobs where id=%s", [j["id"]])[0] == ("expired", "not_picked_up")
    assert acct(db, ORG_A) == (b[0], b[1] - 6)


def test_crash_resume_polls_stored_task(db):
    drain(db)
    j = create(db, UA, ORG_A)["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','task-77')", [j["id"]])
    db.su("update public.creative_jobs set heartbeat_at = now() - interval '1 hour' where id=%s", [j["id"]])
    rows = svc(db, "select id::text, status, provider_task_id, attempts from public.claim_creative_job('w2')")
    assert rows == [(j["id"], "provider_pending", "task-77", 2)]
    assert svc(db, "select public.advance_creative_job(%s,'w2','submitting')", [j["id"]])[0][0] is False
    assert svc(db, "select public.advance_creative_job(%s,'w2','processing')", [j["id"]])[0][0] is True
    out = svc(db, "select public.finish_creative_job(%s,'w2',true)", [j["id"]])[0][0]
    assert out["status"] == "completed" and out["charged_credits"] == 6


def test_submit_interrupted_is_failed_and_released(db):
    drain(db)
    j = create(db, UA, ORG_A)["job"]
    b = acct(db, ORG_A)
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    db.su("update public.creative_jobs set heartbeat_at = now() - interval '1 hour' where id=%s", [j["id"]])
    svc(db, "select public.claim_creative_job('w2')")
    assert db.su("select status, error_code from public.creative_jobs where id=%s", [j["id"]])[0] == ("failed", "submit_interrupted")
    assert acct(db, ORG_A) == (b[0], b[1] - 6)


def test_exempt_org_holds_nothing(db):
    db.su("insert into public.org_members (org_id,user_id,email,role) values (%s,%s,'a@x.io','viewer') on conflict do nothing", [DEFAULT_ORG, UA])
    st, _ = err(lambda: create(db, UA, DEFAULT_ORG))
    assert st == "42501"  # a plain member of the operator's org cannot spend the platform's money
    out = create(db, UADMIN, DEFAULT_ORG)["job"]
    assert db.su("select credit_ref from public.creative_jobs where id=%s", [out["id"]])[0][0] is None
    assert db.su("select count(*) from public.credit_reservations where job_id=%s", ["cj:" + out["id"]])[0][0] == 0


def test_events_append_only_and_costs_admin_only(db):
    st, _ = err(lambda: db.su("update public.creative_job_events set event='x'"))
    assert st == "42501"
    jid = db.su("select id::text from public.creative_jobs where org_id=%s and status='completed' limit 1", [ORG_A])[0][0]
    svc(db, "select public.record_creative_job_cost(%s,'acme','acme','img-x-v1','image',1,null,null)", [jid])
    assert db.act("authenticated", UA, "select * from public.creative_job_costs") == []
    assert db.act("authenticated", UA, "select * from public.creative_economics") == []
    rows = db.act("authenticated", UADMIN, "select model, jobs_completed, provider_usd, unpriced_cost_rows from public.creative_economics")
    assert rows and all(r[2] is None for r in rows if r[3] > 0)
    st, _ = err(lambda: db.act("authenticated", UA, "select public.record_creative_job_cost(%s,'acme')", [jid]))
    assert st == "42501"


# ── the two helpers that call 0020 as the platform ──────────────────────────
# creative_platform_reserve / creative_platform_release clear the caller's JWT
# claims for one call to reserve_credits / release_credits. Three things must
# hold: the claims come back even when that call raises, no API role can call
# them, and a member of another org cannot steer them at a victim's hold.

HELPERS = ("creative_platform_reserve(uuid,text,numeric)", "creative_platform_release(text)")
BOB = json.dumps({"role": "authenticated", "sub": UB, "email": "b@x.io"})


def _restored_after(db, call_sql, setup_sql=""):
    """Run `call_sql` as the (superuser) definer with Bob's claims set, catch
    whatever it raises in a plpgsql exception block, and report the claims and
    the trusted-caller answer afterwards. Rolled back."""
    with db.conn() as c:
        try:
            if setup_sql:
                c.execute(setup_sql)
            c.execute("select set_config('request.jwt.claims', %s, true)", [BOB])
            c.execute(f"""
                do $$
                begin
                  begin
                    {call_sql};
                  exception when others then
                    perform set_config('creative.test.raised', sqlstate, true);
                  end;
                end $$""")
            row = c.execute("select current_setting('request.jwt.claims', true), public.credits_trusted_caller(), "
                            "current_setting('creative.test.raised', true)").fetchone()
        finally:
            c.rollback()
    return row


def test_claims_come_back_when_reserve_raises(db):
    # 99,999,999 credits: reserve_credits refuses with insufficient credits.
    claims_after, trusted, raised = _restored_after(
        db, f"perform public.creative_platform_reserve('{ORG_A}'::uuid, 'cj:adv-raise', 99999999)")
    assert raised == "NS402"
    assert json.loads(claims_after) == json.loads(BOB)
    assert trusted is False


def test_claims_come_back_when_release_raises(db):
    ref = "cj:adv-release"
    setup = f"""
        select public.grant_credits('{ORG_A}'::uuid, 1, 'adv');
        select set_config('request.jwt.claims', '', true);
        select public.reserve_credits('{ORG_A}'::uuid, '{ref}', 5);
        create function pg_temp.boom() returns trigger language plpgsql as
          $f$ begin raise exception 'release sabotaged' using errcode = 'XX001'; end $f$;
        create trigger adv_boom before update on public.credit_reservations
          for each row execute function pg_temp.boom();
    """
    claims_after, trusted, raised = _restored_after(db, f"perform public.creative_platform_release('{ref}')", setup)
    assert raised == "XX001"
    assert json.loads(claims_after) == json.loads(BOB)
    assert trusted is False


def test_claims_come_back_after_a_successful_call(db):
    with db.conn() as c:
        try:
            c.execute("select set_config('request.jwt.claims', %s, true)", [BOB])
            c.execute("select public.creative_platform_reserve(%s, 'cj:adv-ok', 6)", [ORG_A])
            after = c.execute("select current_setting('request.jwt.claims', true), public.credits_trusted_caller()").fetchone()
            c.execute("select public.creative_platform_release('cj:adv-ok')")
            after2 = c.execute("select current_setting('request.jwt.claims', true), public.credits_trusted_caller()").fetchone()
        finally:
            c.rollback()
    assert (json.loads(after[0]), after[1]) == (json.loads(BOB), False)
    assert (json.loads(after2[0]), after2[1]) == (json.loads(BOB), False)


@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA), ("authenticated", UB),
                                      ("service_role", None)])
@pytest.mark.parametrize("helper", HELPERS)
def test_no_api_role_can_call_the_helpers(db, role, uid, helper):
    assert db.su("select has_function_privilege(%s, %s, 'execute')", [role, "public." + helper])[0][0] is False
    call = ("select public.creative_platform_reserve(%s, 'cj:adv-direct', 6)" if helper.startswith("creative_platform_reserve")
            else "select public.creative_platform_release('cj:adv-direct')")
    params = [ORG_A] if "%s" in call else None
    st, _ = err(lambda: db.act(role, uid, call, params))
    assert st == "42501"


def test_a_member_of_org_b_cannot_reach_org_as_hold(db):
    drain(db)  # 0034: a Free org holds one open run at a time
    victim = create(db, UA, ORG_A)["job"]
    ref = "cj:" + victim["id"]
    before = acct(db, ORG_A)
    hold = db.su("select org_id::text, amount::float, status from public.credit_reservations where job_id = %s", [ref])
    # Through the member calls: refused, and nothing of A's moves.
    st, _ = err(lambda: create(db, UB, ORG_A))
    assert st == "42501"
    st, _ = err(lambda: db.act("authenticated", UB, "select public.cancel_creative_job(%s)", [victim["id"]]))
    assert st == "P0002"
    # Through 0020 directly, with A's own hold reference: refused.
    st, _ = err(lambda: db.act("authenticated", UB, "select public.release_credits(%s)", [ref]))
    assert st == "42501"
    st, _ = err(lambda: db.act("authenticated", UB, "select public.reserve_credits(%s, %s, 6)", [ORG_A, ref]))
    assert st == "42501"
    # Bob may reserve in his own org — but never under A's job reference.
    st, _ = err(lambda: db.act("authenticated", UB, "select public.reserve_credits(%s, %s, 6)", [ORG_B, ref]))
    assert st == "23505"
    assert acct(db, ORG_A) == before
    assert db.su("select org_id::text, amount::float, status from public.credit_reservations where job_id = %s", [ref]) == hold
    assert db.su("select status from public.creative_jobs where id = %s", [victim["id"]])[0][0] == "queued"


def test_the_plans_parallel_limit_applies_to_creative_holds(db):
    # 0034: on the Free plan an organization has one open hold at a time. A
    # second generation is refused whole — no hold, no job row.
    drain(db)
    first = create(db, UA, ORG_A)["job"]
    jobs_before = db.su("select count(*) from public.creative_jobs where org_id = %s", [ORG_A])[0][0]
    bal = acct(db, ORG_A)
    st, msg = err(lambda: create(db, UA, ORG_A, key="limit-2"))
    assert st == "NS429", msg
    assert db.su("select count(*) from public.creative_jobs where org_id = %s", [ORG_A])[0][0] == jobs_before
    assert acct(db, ORG_A) == bal
    db.act("authenticated", UA, "select public.cancel_creative_job(%s)", [first["id"]])
    assert create(db, UA, ORG_A, key="limit-2")["job"]["status"] == "queued"
    drain(db)
