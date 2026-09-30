"""Creative jobs and credits (0036), end to end in a real database: the hold
is the quote, a capture never exceeds it, every other ending releases it,
two concurrent creates cannot overspend, a replayed idempotency key returns
the same job, and a crashed job resumes by polling its stored provider task.

Runs in its own scratch database (it commits, and it needs a model registry
with sellable models): the fake registry below stands in for 0035 when that
migration is not applied; when it is, the same rows go into the real table.
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
REGISTRY = """
insert into public.model_registry (id, provider, capabilities, availability, verified_at, credit_unit, entitlement) values
 ('img-x','acme','{t2i}','beta',now(),'model_img_x','any'),
 ('vid-y','acme','{t2v}','ga',now(),'model_vid_y_second','any'),
 ('img-hidden','acme','{t2i}','hidden',now(),'model_img_x','any'),
 ('img-unverified','acme','{t2i}','beta',null,'model_img_x','any'),
 ('img-unpriced','acme','{t2i}','beta',now(),'model_nope','any'),
 ('img-paid','acme','{t2i}','beta',now(),'model_img_x','paid');
insert into public.credit_prices (unit, credits_per_unit, margin) values
 ('model_img_x', 4, 0.5), ('model_vid_y_second', 2, 1), ('job_minimum', 5, 0);
"""


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
    if not db.registry_applied:
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
    st, msg = err(lambda: create(db, UA, ORG_A, cap="i2v"))
    assert "capability_not_supported" in msg
    st, msg = err(lambda: db.act("authenticated", UA, "select public.create_creative_job(%s,'t2i','img-x','{\"prompt\":\"x\"}','auto')", [ORG_A]))
    assert "mode_not_supported" in msg
    st, msg = err(lambda: create(db, UA, ORG_A, maxc=5))
    assert st == "NS409" and "price_changed" in msg


def test_idempotent_replay(db):
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
