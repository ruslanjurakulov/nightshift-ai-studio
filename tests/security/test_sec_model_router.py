"""Model Router v1 (0075), attacked in a real database.

auto / cheap / fast / quality let the database pick the model of a creative
job. What must hold, with a real registry, price list and credit ledger:

* the pick is deterministic, explainable (a reason code) and made only among
  models that are available, verified, priced for these exact settings and
  allowed by the organization's plan; an unpriced, unverified or plan-gated
  model is never picked, however cheap or good it would be;
* the price comes BEFORE the spend: the quote names the model and its price,
  a routed create needs both back, a different pick since the quote is
  refused ('route_changed') and a higher price too ('price_changed'), and a
  refusal leaves no job and no hold;
* exact is never replaced: no failover, no reroute, whatever fails;
* a failover goes only to a compatible model, of the same tier for quality,
  never above the hold, never after a provider task exists, at most twice;
  otherwise the job fails and the hold comes back in full; a routed job is
  charged the price of the model that made it, never more than the hold;
* nothing crosses an organization: another organization's quote, create,
  routing and job read as forbidden / missing; nobody writes the route;
* the API routes among the models the API sells, through api_creative_*;
* two concurrent creates never hold more than the organization has, and one
  idempotency key is one job.

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
from test_sec_api_creative import Db

ORG_A = "aaaaaaaa-0000-0000-0000-000000000075"
ORG_B = "bbbbbbbb-0000-0000-0000-000000000075"
ORG_C = "cccccccc-0000-0000-0000-000000000075"   # a small balance, for the concurrency attack
UA = str(uuid.UUID(int=0x75A))
UB = str(uuid.UUID(int=0x75B))
UC = str(uuid.UUID(int=0x75C))
KEY_A = hashlib.sha256(b"router-key-a").hexdigest()

PROMPT = {"prompt": "a lighthouse at dawn"}

# id -> (quality_tier, speed_tier, credits per image or None = no price row, extra spec, entitlement, verified)
MODELS = {
    "img-cheap": (3, 5, 2, {}, "any", True),
    "img-mid": (4, 3, 5, {}, "any", True),
    "img-best": (5, 2, 9, {}, "any", True),
    "img-best-b": (5, 1, 9, {}, "any", True),
    "img-webonly": (4, 4, 3, {"api_exposure": "web_only"}, "any", True),
    # Would win every mode, and must never be picked:
    "img-unpriced": (5, 5, None, {}, "any", True),                     # no price row at all
    "img-var": (5, 5, 1, {"qualities": ["medium", "high"],             # medium (the default) has no row
                          "pricing": {"unit": "image", "variants": {"by": "quality",
                                                                   "prices": {"medium": None, "high": None}}}},
                "any", True),
    "img-plan": (5, 5, 1, {}, "models_image:ultra", True),            # a plan entitlement nothing grants yet
    "img-paid": (5, 5, 1, {}, "paid", True),                          # after a credit purchase only
    "img-unverified": (5, 5, 1, {}, "any", False),                    # never probed (so hidden)
}
NEVER = {"img-unpriced", "img-var", "img-plan", "img-paid", "img-unverified"}


def unit(m):
    return f"model_{m.replace('-', '_')}_image"


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_router_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@r.io'),(%s,'b@r.io'),(%s,'c@r.io')", [UA, UB, UC])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-a-r'),(%s,'B','org-b-r'),"
         "(%s,'C','org-c-r')", [ORG_A, ORG_B, ORG_C])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@r.io','owner'),"
         "(%s,%s,'b@r.io','owner'),(%s,%s,'c@r.io','owner')", [ORG_A, UA, ORG_B, UB, ORG_C, UC])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    # B bought credits once: the 'paid' entitlement opens for B only.
    d.su("select public.add_purchased_credits(%s, 1000, 'router-lab-purchase', 'test')", [ORG_B])
    d.su("select public.grant_credits(%s, 10, 'test')", [ORG_C])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    rows = [{"id": m, "display_name": m.upper(), "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": unit(m), "entitlement": ent,
             "spec": {"vendor_model": "acme-" + m, "output": "image", "quality_tier": q, "speed_tier": s, **extra}}
            for m, (q, s, _c, extra, ent, _v) in MODELS.items()]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, (_q, _s, c, _x, _e, verified) in MODELS.items():
        if verified:
            d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'lab')",
                 [m, "acme-" + m])
            # The registry refuses beta for a model no probe proved (0035): it stays hidden.
            d.su("update public.model_registry set availability='beta' where id=%s", [m])
        if c is not None:
            d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
                 "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0",
                 [unit(m), c])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_img_var_image_high', 7, 0)")
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = 1, margin = 0")
    # The API, for org A.
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1')",
         [ORG_A, UA])
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 0, 100000)", [ORG_A])
    d.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s, 'k', %s, %s, %s)",
         [ORG_A, KEY_A, UA, ["creative:quote", "creative:create", "creative:read"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


# ── helpers ─────────────────────────────────────────────────────────────────

def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def rquote(db, uid, org, mode, params=PROMPT, cap="t2i"):
    return db.act("authenticated", uid, "select public.quote_creative_route(%s,%s,%s,%s::jsonb)",
                  [org, cap, mode, json.dumps(params)])[0][0]


def create(db, uid, org, mode, model, maxc, idem=None, params=PROMPT, cap="t2i"):
    return db.act("authenticated", uid,
                  "select public.create_creative_job(%s,%s,%s,%s::jsonb,%s,%s,%s::numeric)",
                  [org, cap, model, json.dumps(params), mode, idem, maxc])[0][0]


def route(db, org, mode, surface="web", params=PROMPT):
    return db.su("select public.route_model('t2i', %s::jsonb, %s, %s, %s)",
                 [json.dumps(params), mode, org, surface])[0][0]


def svc(db, q, p=None):
    return db.act("service_role", None, q, p)


def footprint(db, org):
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [org])[0][0],
            db.su("select count(*), coalesce(sum(amount),0)::float from public.credit_reservations "
                  "where org_id=%s and status='open'", [org])[0],
            db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org])[0])


def drain(db):
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc(db, "select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


def claim(db, job_id, worker="w-r"):
    got = svc(db, f"select id::text, credit_ref, org_id::text from public.claim_creative_job('{worker}')")
    assert got and got[0][0] == job_id, got
    return got[0]


def job(db, job_id):
    cols = ("mode", "requested_model", "routed_model", "quoted_credits", "routed_credits", "fallback_from",
            "fallback_reason", "status", "charged_credits", "routing", "params", "credit_ref")
    row = db.su(f"select {', '.join(cols)} from public.creative_jobs where id=%s", [job_id])[0]
    return dict(zip(cols, row))


def set_price(db, m, c):
    db.su("update public.credit_prices set credits_per_unit=%s where unit=%s", [c, unit(m)])


# ── the pick ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("mode,model,reason,credits", [
    ("cheap", "img-cheap", "cheapest", 2),
    ("fast", "img-cheap", "fastest", 2),
    ("quality", "img-best", "best_quality", 9),       # img-best-b is as good and as dear, but slower
    ("auto", "img-webonly", "best_value", 3),          # the cheapest of tier 4 and above
])
def test_each_mode_picks_one_model_the_same_way_every_time_and_says_why(db, mode, model, reason, credits):
    answers = [rquote(db, UA, ORG_A, mode) for _ in range(3)]
    assert all(a == answers[0] for a in answers)
    q = answers[0]
    assert (q["routed_model"], q["model"], q["route_reason"], q["credits"], q["mode"]) == (model, model, reason, credits, mode)
    # The quote of the pick is creative_price's own answer for that model, named.
    assert q["unit"] == unit(model) and q["display_name"] == model.upper() and q["available"] == 1000


def test_unpriced_unverified_and_plan_gated_models_are_never_candidates(db):
    for mode in ("auto", "cheap", "fast", "quality"):
        r = route(db, ORG_A, mode)
        names = {c["model"] for c in r["candidates"]}
        assert r["model"] not in NEVER and not (names & NEVER), (mode, r)
        assert r["considered"] == 5


def test_the_plan_decides_what_is_a_candidate(db):
    # B made a purchase: the 'paid' model is B's to use, and now the cheapest of all.
    assert rquote(db, UB, ORG_B, "cheap")["routed_model"] == "img-paid"
    assert rquote(db, UA, ORG_A, "cheap")["routed_model"] == "img-cheap"
    # A model that becomes paid-only leaves A's list at once.
    db.su("update public.model_registry set entitlement='paid' where id='img-cheap'")
    try:
        assert rquote(db, UA, ORG_A, "cheap")["routed_model"] == "img-webonly"
    finally:
        db.su("update public.model_registry set entitlement='any' where id='img-cheap'")


def test_settings_only_some_models_offer_narrow_the_pick_never_ignored(db):
    # Only img-var sells 'high' (its high row is priced): the only option.
    q = rquote(db, UA, ORG_A, "cheap", {**PROMPT, "quality": "high"})
    assert (q["routed_model"], q["route_reason"], q["credits"], q["quality"]) == ("img-var", "only_option", 7, "high")
    st, word, _ = err(lambda: rquote(db, UA, ORG_A, "cheap", {**PROMPT, "quality": "low"}))
    assert (st, word) == ("NS400", "no_model_available")


def test_what_no_model_can_fix_is_refused_as_itself(db):
    st, word, _ = err(lambda: rquote(db, UA, ORG_A, "auto", {"prompt": ""}))
    assert (st, word) == ("NS400", "invalid_params")
    st, word, _ = err(lambda: rquote(db, UA, ORG_A, "exact"))
    assert (st, word) == ("NS400", "invalid_params")
    st, word, _ = err(lambda: rquote(db, UA, ORG_A, "auto", {**PROMPT, "duration_s": 5}, cap="music"))
    assert (st, word) == ("NS400", "no_model_available")


# ── price before spend ──────────────────────────────────────────────────────

def test_the_confirmed_quote_is_the_hold_and_the_job_says_how_it_was_picked(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "auto")
    before = footprint(db, ORG_A)
    out = create(db, UA, ORG_A, "auto", q["routed_model"], q["credits"], idem="r-hold-1")
    j = job(db, out["job"]["id"])
    assert (j["mode"], j["requested_model"], j["routed_model"]) == ("auto", "img-webonly", "img-webonly")
    assert (float(j["quoted_credits"]), float(j["routed_credits"])) == (3, 3)
    assert j["routing"]["reason"] == "best_value" and j["routing"]["tried"] == ["img-webonly"]
    assert out["job"]["route_reason"] == "best_value" and float(out["job"]["routed_credits"]) == 3
    assert footprint(db, ORG_A)[1] == (before[1][0] + 1, before[1][1] + 3)
    drain(db)


def test_a_routed_create_needs_the_quoted_model_and_price_and_a_refusal_leaves_nothing(db):
    drain(db)
    before = footprint(db, ORG_A)
    for model, maxc in ((None, 3), ("img-webonly", None), ("", 3)):
        st, word, _ = err(lambda m=model, c=maxc: create(db, UA, ORG_A, "auto", m, c))
        assert (st, word) == ("NS400", "invalid_params"), (model, maxc)
    # A model the router would not pick is not run in its place: refused.
    st, word, _ = err(lambda: create(db, UA, ORG_A, "auto", "img-best", 9))
    assert (st, word) == ("NS409", "route_changed")
    st, word, _ = err(lambda: create(db, UA, ORG_A, "turbo", "img-best", 9))
    assert (st, word) == ("NS400", "invalid_params")
    assert footprint(db, ORG_A) == before


def test_a_price_that_rose_or_a_pick_that_changed_after_the_quote_is_refused_never_run(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "cheap")
    assert (q["routed_model"], q["credits"]) == ("img-cheap", 2)
    before = footprint(db, ORG_A)
    try:
        set_price(db, "img-cheap", 2.5)          # still the cheapest, but dearer than confirmed
        st, word, detail = err(lambda: create(db, UA, ORG_A, "cheap", "img-cheap", q["credits"]))
        assert (st, word) == ("NS409", "price_changed") and "confirmed=2" in detail
        set_price(db, "img-cheap", 4)            # img-webonly (3) is now the cheapest
        st, word, _ = err(lambda: create(db, UA, ORG_A, "cheap", "img-cheap", q["credits"]))
        assert (st, word) == ("NS409", "route_changed")
        db.su("update public.model_registry set availability='hidden' where id='img-cheap'")
        st, word, _ = err(lambda: create(db, UA, ORG_A, "cheap", "img-cheap", 100))
        assert (st, word) == ("NS409", "route_changed")
    finally:
        set_price(db, "img-cheap", 2)
        db.su("update public.model_registry set availability='beta' where id='img-cheap'")
    assert footprint(db, ORG_A) == before


def test_a_price_that_fell_holds_the_confirmed_price_and_charges_the_lower_one(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "cheap")
    try:
        set_price(db, "img-cheap", 1.5)
        out = create(db, UA, ORG_A, "cheap", "img-cheap", q["credits"], idem="r-fell-1")
    finally:
        set_price(db, "img-cheap", 2)
    jid = out["job"]["id"]
    j = job(db, jid)
    assert (float(j["quoted_credits"]), float(j["routed_credits"])) == (2, 1.5)
    bal = footprint(db, ORG_A)[2][0]
    _id, ref, org = claim(db, jid)
    svc(db, "select public.start_credit_reservation(%s,%s)", [ref, org])
    svc(db, "select public.advance_creative_job(%s,'w-r','submitting')", [jid])
    svc(db, "select public.advance_creative_job(%s,'w-r','submitted','task-1')", [jid])
    # The worker names no charge (or a larger one): the job pays the model's price.
    done = svc(db, "select public.finish_creative_job(%s,'w-r',true,5,'{}'::jsonb)", [jid])[0][0]
    assert float(done["charged_credits"]) == 1.5
    assert footprint(db, ORG_A)[2][0] == pytest.approx(bal - 1.5)
    assert db.su("select status, amount::float, captured::float from public.credit_reservations where job_id=%s",
                 [ref]) == [("captured", 2.0, 1.5)]


def test_a_replay_of_the_same_press_is_the_same_job_and_one_hold(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "quality")
    first = create(db, UA, ORG_A, "quality", q["routed_model"], q["credits"], idem="r-replay-1")
    before = footprint(db, ORG_A)
    again = create(db, UA, ORG_A, "quality", q["routed_model"], q["credits"], idem="r-replay-1")
    assert again["replay"] is True and again["job"]["id"] == first["job"]["id"]
    assert footprint(db, ORG_A) == before
    st, word, _ = err(lambda: create(db, UA, ORG_A, "cheap", "img-cheap", 2, idem="r-replay-1"))
    assert (st, word) == ("NS409", "idempotency_conflict")
    drain(db)


# ── exact is never replaced ─────────────────────────────────────────────────

def test_exact_is_never_routed_or_rerouted_whatever_fails(db):
    drain(db)
    out = create(db, UA, ORG_A, "exact", "img-best", 9, idem="r-exact-1")
    jid = out["job"]["id"]
    j = job(db, jid)
    assert (j["routed_model"], j["routing"], j["routed_credits"]) == ("img-best", None, None)
    claim(db, jid)
    svc(db, "select public.advance_creative_job(%s,'w-r','submitting')", [jid])
    for code in ("unavailable", "adapter_missing", "quota", "rate_limited"):
        assert svc(db, "select public.reroute_creative_job(%s,'w-r',%s)", [jid, code])[0][0] is None
    assert job(db, jid)["routed_model"] == "img-best" and job(db, jid)["fallback_from"] is None
    svc(db, "select public.finish_creative_job(%s,'w-r',false,null,null,'unavailable','down')", [jid])
    assert job(db, jid)["status"] == "failed"
    # An exact model that is unavailable is refused at create, never routed.
    db.su("update public.model_registry set availability='hidden' where id='img-best'")
    try:
        st, word, _ = err(lambda: create(db, UA, ORG_A, "exact", "img-best", 9))
        assert (st, word) == ("NS400", "model_not_sellable")
    finally:
        db.su("update public.model_registry set availability='beta' where id='img-best'")
    # Nobody can give an exact job a route either: the CHECK refuses it.
    with pytest.raises(psycopg.errors.CheckViolation):
        db.su("update public.creative_jobs set routing='{}'::jsonb where id=%s", [jid])


# ── failover ────────────────────────────────────────────────────────────────

def test_quality_fails_over_once_to_the_same_tier_within_the_hold_then_stops(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "quality")
    jid = create(db, UA, ORG_A, "quality", q["routed_model"], q["credits"], idem="r-fo-1")["job"]["id"]
    _id, ref, org = claim(db, jid)
    svc(db, "select public.start_credit_reservation(%s,%s)", [ref, org])
    # Not the worker holding the job, a code that is the request's own fault, a browser: nothing.
    assert svc(db, "select public.reroute_creative_job(%s,'someone-else','unavailable')", [jid])[0][0] is None
    for code in ("policy", "bad_request", "provider_timeout", "content_policy"):
        assert svc(db, "select public.reroute_creative_job(%s,'w-r',%s)", [jid, code])[0][0] is None
    st, _w, _d = err(lambda: db.act("authenticated", UA, "select public.reroute_creative_job(%s,'w-r','unavailable')", [jid]))
    assert st == "42501"
    svc(db, "select public.advance_creative_job(%s,'w-r','submitting')", [jid])
    moved = svc(db, "select public.reroute_creative_job(%s,'w-r','unavailable')", [jid])[0][0]
    assert moved == {"model": "img-best-b", "credits": 9}
    j = job(db, jid)
    assert (j["routed_model"], j["fallback_from"], j["fallback_reason"], j["requested_model"]) == \
        ("img-best-b", "img-best", "unavailable", "img-best")
    assert j["routing"]["tried"] == ["img-best", "img-best-b"]
    # The next submit is a new one: 'submitting' is allowed again, no task id carried.
    assert svc(db, "select public.advance_creative_job(%s,'w-r','submitting')", [jid])[0][0] is True
    # No third model of tier 5 within the hold: no failover, the job fails, the hold comes back in full.
    assert svc(db, "select public.reroute_creative_job(%s,'w-r','unavailable')", [jid])[0][0] is None
    svc(db, "select public.finish_creative_job(%s,'w-r',false,null,null,'unavailable','down')", [jid])
    assert db.su("select status from public.credit_reservations where job_id=%s", [ref])[0][0] == "released"


def test_no_failover_above_the_hold_or_to_a_lower_tier_or_after_a_task_exists(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "quality")
    jid = create(db, UA, ORG_A, "quality", q["routed_model"], q["credits"], idem="r-fo-2")["job"]["id"]
    claim(db, jid)
    svc(db, "select public.advance_creative_job(%s,'w-r','submitting')", [jid])
    try:
        set_price(db, "img-best-b", 9.5)        # the only same-tier model now costs more than the hold
        assert svc(db, "select public.reroute_creative_job(%s,'w-r','unavailable')", [jid])[0][0] is None
    finally:
        set_price(db, "img-best-b", 9)
    # Once the provider has a task, the job is that task's: never moved.
    svc(db, "select public.advance_creative_job(%s,'w-r','submitted','task-x')", [jid])
    assert svc(db, "select public.reroute_creative_job(%s,'w-r','unavailable')", [jid])[0][0] is None
    svc(db, "select public.finish_creative_job(%s,'w-r',false,null,null,'unavailable','down')", [jid])
    # auto (img-webonly, tier 4, 3 credits): every other candidate is dearer or of a lower tier.
    drain(db)
    a = rquote(db, UA, ORG_A, "auto")
    jid = create(db, UA, ORG_A, "auto", a["routed_model"], a["credits"], idem="r-fo-3")["job"]["id"]
    claim(db, jid)
    assert svc(db, "select public.reroute_creative_job(%s,'w-r','adapter_missing')", [jid])[0][0] is None
    svc(db, "select public.finish_creative_job(%s,'w-r',false,null,null,'adapter_missing','x')", [jid])


def test_a_failover_never_carries_a_model_the_job_could_not_be_priced_for(db):
    # cheap with a generous confirmed price (an API caller may confirm more):
    # the next candidates by price are tried in order, each priced for the job.
    drain(db)
    jid = create(db, UA, ORG_A, "cheap", "img-cheap", 5, idem="r-fo-4")["job"]["id"]
    assert float(job(db, jid)["quoted_credits"]) == 5 and float(job(db, jid)["routed_credits"]) == 2
    claim(db, jid)
    db.su("update public.model_registry set availability='hidden' where id='img-webonly'")
    try:
        moved = svc(db, "select public.reroute_creative_job(%s,'w-r','quota')", [jid])[0][0]
    finally:
        db.su("update public.model_registry set availability='beta' where id='img-webonly'")
    assert moved == {"model": "img-mid", "credits": 5}         # img-webonly is no longer sellable: skipped
    j = job(db, jid)
    assert float(j["routed_credits"]) == 5 and float(j["quoted_credits"]) == 5
    # A second failover is allowed, a third model is not.
    assert svc(db, "select public.reroute_creative_job(%s,'w-r','quota')", [jid])[0][0] == {"model": "img-webonly", "credits": 3}
    assert svc(db, "select public.reroute_creative_job(%s,'w-r','quota')", [jid])[0][0] is None
    svc(db, "select public.finish_creative_job(%s,'w-r',false,null,null,'quota','x')", [jid])


# ── nothing crosses an organization ─────────────────────────────────────────

def test_another_organization_cannot_quote_create_or_read_a_route(db):
    drain(db)
    st, _w, _d = err(lambda: rquote(db, UB, ORG_A, "auto"))
    assert st == "42501"
    before = footprint(db, ORG_A)
    st, _w, _d = err(lambda: create(db, UB, ORG_A, "auto", "img-webonly", 3))
    assert st == "42501"
    assert footprint(db, ORG_A) == before
    jid = create(db, UA, ORG_A, "auto", "img-webonly", 3, idem="r-x-1")["job"]["id"]
    assert db.act("authenticated", UB, "select routing, routed_model from public.creative_jobs where id=%s", [jid]) == []
    assert db.act("authenticated", UA, "select routing ->> 'reason' from public.creative_jobs where id=%s",
                  [jid]) == [("best_value",)]
    drain(db)


@pytest.mark.parametrize("role,uid", [("authenticated", UA), ("anon", None), ("service_role", None)])
def test_nobody_writes_the_route_or_calls_the_router_directly(db, role, uid):
    jid = db.su("select id::text from public.creative_jobs where org_id=%s limit 1", [ORG_A])[0][0]
    for q in ("update public.creative_jobs set routed_model='img-best', routed_credits=0 where id=%s",
              "update public.creative_jobs set routing='{\"tried\":[]}'::jsonb where id=%s"):
        st, _w, _d = err(lambda q=q: db.act(role, uid, q, [jid]))
        assert st == "42501"
    for q, p in (("select public.route_model('t2i','{\"prompt\":\"x\"}'::jsonb,'auto',%s,'web')", [ORG_A]),
                 ("select public.creative_route_quote(%s,'t2i','auto','{\"prompt\":\"x\"}'::jsonb,'web')", [ORG_A])):
        st, _w, _d = err(lambda q=q, p=p: db.act(role, uid, q, p))
        assert st == "42501"


# ── concurrency ─────────────────────────────────────────────────────────────

def test_two_concurrent_routed_creates_never_hold_more_than_the_organization_has(db):
    # C has 10 credits; each press confirms the quality pick at 9.
    q = rquote(db, UC, ORG_C, "quality")
    assert q["credits"] == 9
    results, barrier = [], threading.Barrier(2)

    def press(i):
        barrier.wait()
        try:
            results.append(("ok", create(db, UC, ORG_C, "quality", q["routed_model"], 9, idem=f"r-cc-{i}")))
        except psycopg.Error as e:
            results.append(("err", e.sqlstate))

    threads = [threading.Thread(target=press, args=(i,)) for i in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(r[0] for r in results) == ["err", "ok"], results
    assert [r[1] for r in results if r[0] == "err"] == ["NS402"]
    _jobs, (holds, held), (bal, reserved) = footprint(db, ORG_C)
    assert (holds, held, reserved) == (1, 9.0, 9.0) and bal == 10


def test_the_same_press_twice_at_once_is_one_job(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "fast")
    results, barrier = [], threading.Barrier(2)

    def press():
        barrier.wait()
        results.append(create(db, UA, ORG_A, "fast", q["routed_model"], q["credits"], idem="r-cc-same"))

    threads = [threading.Thread(target=press) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len({r["job"]["id"] for r in results}) == 1 and sorted(r["replay"] for r in results) == [False, True]
    drain(db)


# ── the API: the same rules, its own model list ─────────────────────────────

def api_quote(db, mode, params=PROMPT):
    return db.act("anon", None, "select public.api_creative_quote(%s,'t2i',null,%s::jsonb,%s,null)",
                  [KEY_A, json.dumps(params), mode])[0][0]


def api_create(db, mode, model, maxc, idem):
    return db.act("anon", None, "select public.api_creative_create(%s,'t2i',%s,%s::jsonb,%s,%s,%s,%s,null)",
                  [KEY_A, model, json.dumps(PROMPT), mode, maxc, idem, hashlib.sha256(idem.encode()).hexdigest()])[0][0]


def test_the_api_routes_among_the_models_it_sells_and_names_no_provider(db):
    drain(db)
    q = api_quote(db, "auto")
    assert q["ok"] is True, q
    quote = q["data"]["quote"]
    # img-webonly is the web's pick; the API never sells it.
    assert (quote["routed_model"], quote["route_reason"], quote["credits"]) == ("img-mid", "best_value", 5)
    assert not ({"display_name", "available", "provider", "candidates"} & set(quote))
    made = api_create(db, "auto", "img-mid", 5, "api-r-1")
    assert made["ok"] is True and made["data"]["routed_model"] == "img-mid" and made["data"]["mode"] == "auto", made
    assert made["data"]["route_reason"] == "best_value" and "routing" not in made["data"]
    # The web's pick through the API: refused before anything is held.
    before = footprint(db, ORG_A)
    res = api_create(db, "auto", "img-webonly", 3, "api-r-2")
    assert res["ok"] is False and res["error"]["code"] == "model_not_sellable", res
    res = api_create(db, "cheap", "img-mid", 5, "api-r-3")      # cheap picks img-cheap: the pick changed
    assert res["ok"] is False and res["error"]["code"] == "route_changed", res
    assert footprint(db, ORG_A) == before
    # The exact quote is 0062's, untouched.
    ex = db.act("anon", None, "select public.api_creative_quote(%s,'t2i','img-best',%s::jsonb,'exact',null)",
                [KEY_A, json.dumps(PROMPT)])[0][0]
    assert ex["ok"] is True and ex["data"]["quote"]["model"] == "img-best" and "routed_model" not in ex["data"]["quote"]
    drain(db)


def test_a_bad_key_routes_nothing(db):
    res = db.act("anon", None, "select public.api_creative_quote(%s,'t2i',null,%s::jsonb,'auto',null)",
                 ["0" * 64, json.dumps(PROMPT)])[0][0]
    assert res["ok"] is False and res["status"] in (401, 403), res
