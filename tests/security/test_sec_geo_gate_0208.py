"""Migration 0208, attacked in a real database: the country gate on creative_jobs, and the price by picture size.

A member holds the anon key and their session, so they can call create_creative_job straight through PostgREST and skip every web
route that checks the country (docs/GEO_BLOCK.md). 0208 makes the database refuse a job on a model with a country list unless the
request carries a country our web server signed (x-nightshift-geo: an HMAC with a key in Vault). These tests play that member.

What would break, and which test says so:
  a member with no claim starts a job on a gated model (the direct RPC)               test_no_claim_is_refused_before_anything_is_held
  RU or BY gets a Google model; UZ is refused one                                      test_every_google_model_*
  a member forges, alters, borrows or replays a claim                                  test_a_forged_*, test_a_claim_*
  the gate reaches a model without a list                                              test_a_model_without_a_list_needs_no_claim
  the worker's failover moves a job onto a gated model                                  test_moving_a_job_onto_a_gated_model_is_refused
  no key in Vault reads as "allowed"                                                    test_no_key_in_vault_vouches_for_nothing
  an API role can ask the gate's functions (an oracle)                                  test_no_api_role_can_call_the_gate
  a picture model priced by size is sold at one rate, at a size it does not list,
    with no size, or a size reaches a model not priced by size                         test_size_*
  the rollback leaves the gate or the new bodies behind, or a replay changes anything  test_rollback_and_replay

0142's CHECK keeps a model with a country list off sale, so this scratch database drops it once (the day a gated model opens is the
day this gate matters; it is a throwaway database and nothing here is applied anywhere else). The Google ids and their lists are read
from schemas/model_registry.json, so the lab checks the lists that ship. Runs in its own scratch database (it commits).
"""
import hashlib
import hmac
import json
import os
import time
import uuid

import psycopg
import pytest

import sec_db

ORG = "aaaaaaaa-0000-0000-0000-000000000208"
U_A = str(uuid.UUID(int=0x208A))
U_B = str(uuid.UUID(int=0x208B))
#: A lab-only key (never a real one): the same value the web would hold in NIGHTSHIFT_GEO_CLAIM_KEY.
KEY = "lab-only-geo-claim-key-0208-not-a-secret-xxxxxxxx"
T2I = {"prompt": "a lighthouse at dusk"}

REGISTRY = json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]
GOOGLE = {m["id"]: m["blocked_countries"] for m in REGISTRY if m.get("provider") == "google"}


def unit_of(mid):
    return "model_" + "".join(c if c.isalnum() else "_" for c in mid.lower()) + "_image"


# (id, extra spec, credit rows {unit: credits})
MODELS = [
    ("img-plain", {}, {unit_of("img-plain"): 3}),
    ("img-sized", {"image_sizes": ["1K", "2K", "4K"],
                   "pricing": {"unit": "image", "variants": {"by": "image_size", "prices": {"1K": 0.04, "2K": 0.08, "4K": 0.12}}}},
     # The base row lists the model (sellable_models); the sizes price it. 4K has no row: unpriced, never the base rate.
     {unit_of("img-sized"): 1, unit_of("img-sized") + "_1k": 5, unit_of("img-sized") + "_2k": 8}),
] + [(gid, {"blocked_countries": lst}, {unit_of(gid): 2}) for gid, lst in GOOGLE.items()]


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
    return json.dumps(c)


def sign(country, uid, exp=None, key=KEY):
    body = f"v1.{country}.{uid}.{int(exp if exp is not None else time.time() + 120)}"
    return body + "." + hmac.new(key.encode(), body.encode(), hashlib.sha256).hexdigest()


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None, headers=None, pre=(), keep=True):
        """One request: `pre` runs as the owner first (rolled back with it when keep is False), then the call in `role`'s session."""
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                for stmt in pre:
                    c.execute(stmt)
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
                if headers is not None:
                    c.execute("select set_config('request.headers', %s, true)", [headers if isinstance(headers, str) else json.dumps(headers)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit() if keep else c.rollback()
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
    name = f"ns_geo_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io'),(%s,'b@x.io')", [U_A, U_B])
    d.su("insert into public.organizations (id, name, slug) values (%s,'G','org-geo-0208')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner'),(%s,%s,'b@x.io','editor')",
         [ORG, U_A, ORG, U_B])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    # The day a gated model opens (see the module's docstring): 0142's CHECK is dropped in this throwaway database only.
    d.su("alter table public.model_registry drop constraint if exists model_registry_countries_before_sale")
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": unit_of(m), "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": "image", **extra}}
            for m, extra, _p in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    prices = []
    for m, _x, units in MODELS:
        d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'security-lab')", [m, "acme-" + m])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
        prices += [f"('{u}', {c}, 0)" for u, c in units.items()]
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {', '.join(prices)}, ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.su("select vault.create_secret(%s, 'nightshift_geo_claim_key', 'lab')", [KEY])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0]


_n = [0]


def drain(db):
    """Finish every queued job (a failure, refunded) so the plan's one parallel run is free for the next create."""
    def svc(q, p=None):
        return db.act("service_role", None, q, p)
    while svc("select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain' and status='running'"):
        svc("select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


def create(db, model, headers=None, uid=U_A, params=T2I, **kw):
    _n[0] += 1
    out = db.act("authenticated", uid, "select public.create_creative_job(%s,'t2i',%s,%s::jsonb,'exact',%s,1000)",
                 [ORG, model, json.dumps(params), f"geo-{_n[0]}"], headers=headers, **kw)[0][0]
    drain(db)
    return out


def quote(db, model, params, uid=U_A):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,'t2i',%s,%s::jsonb)", [ORG, model, json.dumps(params)])[0][0]


def geo(country, uid=U_A, **kw):
    return {"x-nightshift-geo": sign(country, uid, **kw)}


def footprint(db):
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [ORG])[0][0],
            db.su("select count(*), coalesce(sum(amount),0)::float from public.credit_reservations where org_id=%s", [ORG])[0],
            db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [ORG])[0])


GID = "gemini-3.1-flash-image"


def test_the_shipped_lists_block_russia_and_belarus_and_not_uzbekistan():
    assert len(GOOGLE) == 12
    for gid, lst in GOOGLE.items():
        assert "RU" in lst and "BY" in lst and "UZ" not in lst, gid


def test_no_claim_is_refused_before_anything_is_held(db):
    before = footprint(db)
    for headers in (None, {}, {"x-nightshift-client-ip": "84.54.64.1"}):
        assert err(lambda: create(db, GID, headers)) == ("NS400", "country_unverified")
    assert footprint(db) == before


def test_every_google_model_refuses_russia_and_belarus_and_lets_uzbekistan_through(db):
    for gid in GOOGLE:
        for country in ("RU", "BY"):
            before = footprint(db)
            assert err(lambda: create(db, gid, geo(country))) == ("NS400", "country_blocked"), (gid, country)
            assert footprint(db) == before
        job = create(db, gid, geo("UZ"))
        assert job["job"]["routed_model"] == gid or job["job"].get("requested_model") == gid, job


def test_a_forged_claim_is_refused(db):
    now = int(time.time())
    good = sign("UZ", U_A)
    body, mac = good.rsplit(".", 1)
    forged = [
        sign("UZ", U_A, key="a-member-guessed-key-0000000000000000000"),          # signed with another key
        body.replace(".UZ.", ".US.") + "." + mac,                                   # the country changed after signing
        body + "." + "0" * 64,                                                      # no signature
        good.upper(),                                                               # another shape
        good + ".x",
        "v1.UZ." + U_A,
        "",
    ]
    for value in forged:
        assert err(lambda: create(db, GID, {"x-nightshift-geo": value})) == ("NS400", "country_unverified"), value
    # A header that is not JSON at all reads as no claim.
    assert err(lambda: create(db, GID, "not json")) == ("NS400", "country_unverified")
    # A Russian member cannot turn a refusal into "unverified -> allowed" by sending a broken claim: both are refusals.
    assert err(lambda: create(db, GID, {"x-nightshift-geo": sign("RU", U_A)})) == ("NS400", "country_blocked")
    assert now  # the clock was read once; the claims above are all fresh


def test_a_claim_made_for_someone_else_or_out_of_date_is_refused(db):
    now = int(time.time())
    for headers in (geo("UZ", uid=U_B),                       # another member's claim, replayed by A
                    geo("UZ", exp=now - 1),                   # expired
                    geo("UZ", exp=now + 3600)):               # too far ahead: our server signs 120 seconds ahead
        assert err(lambda: create(db, GID, headers)) == ("NS400", "country_unverified"), headers
    # The same claim in its own person's session passes.
    assert create(db, GID, geo("UZ", uid=U_B), uid=U_B)["job"]["id"]


def test_a_model_without_a_list_needs_no_claim(db):
    assert create(db, "img-plain")["job"]["id"]
    assert create(db, "img-plain", {"x-nightshift-geo": "garbage"})["job"]["id"]


def test_moving_a_job_onto_a_gated_model_is_refused(db):
    jid = create(db, "img-plain")["job"]["id"]
    # The worker's failover (reroute_creative_job) writes routed_model with no visitor behind it: a gated model is refused.
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.creative_jobs set routed_model = %s where id = %s", [GID, jid])
    assert e.value.sqlstate == "NS400" and "country_unverified" in str(e.value)
    # Any other change to the row is not asked.
    db.su("update public.creative_jobs set updated_at = now() where id = %s", [jid])


def test_no_key_in_vault_vouches_for_nothing(db):
    for pre in (["delete from vault.secrets where name = 'nightshift_geo_claim_key'"],
                ["update vault.secrets set secret = 'short' where name = 'nightshift_geo_claim_key'"]):
        assert err(lambda: create(db, GID, geo("UZ"), pre=pre, keep=False)) == ("NS400", "country_unverified")
    assert create(db, GID, geo("UZ"))["job"]["id"]   # the key is back (both were rolled back)


def test_no_api_role_can_call_the_gate(db):
    for role in ("anon", "authenticated", "service_role"):
        for sig in ("public.geo_claim_country()", "public.creative_jobs_geo_gate()"):
            assert db.su("select has_function_privilege(%s, %s, 'EXECUTE')", [role, sig])[0][0] is False, (role, sig)
        assert err(lambda: db.act(role, U_A, "select public.geo_claim_country()", headers=geo("UZ")))[0] == "42501"


# ── B: the price by picture size ─────────────────────────────────────────────────────────────────────────────────────────────────

def test_size_each_size_is_priced_by_its_own_row(db):
    q1 = quote(db, "img-sized", {**T2I, "image_size": "1K"})
    q2 = quote(db, "img-sized", {**T2I, "image_size": "2K"})
    assert (q1["unit"], q1["credits"], q1["image_size"]) == (unit_of("img-sized") + "_1k", 5, "1K")
    assert (q2["unit"], q2["credits"], q2["image_size"]) == (unit_of("img-sized") + "_2k", 8, "2K")


def test_size_a_listed_size_without_a_row_is_unpriced_never_another_rate(db):
    assert err(lambda: quote(db, "img-sized", {**T2I, "image_size": "4K"})) == ("NS400", "unpriced")


def test_size_none_named_or_one_not_listed_or_not_sold_by_size_is_refused(db):
    for model, params in (("img-sized", T2I),                                  # no size: never the base row
                          ("img-sized", {**T2I, "image_size": "512"}),         # a size the model does not list
                          ("img-sized", {**T2I, "image_size": "8K"}),          # not a size at all (creative_params_problem)
                          ("img-plain", {**T2I, "image_size": "1K"})):         # a model whose price does not follow the size
        assert err(lambda: quote(db, model, params)) == ("NS400", "invalid_params"), (model, params)


def test_size_a_job_carries_the_size_it_was_priced_at(db):
    out = create(db, "img-sized", params={**T2I, "image_size": "2K"})
    row = db.su("select params ->> 'image_size', credit_unit, quoted_credits::float from public.creative_jobs where id = %s",
                [out["job"]["id"]])[0]
    assert row == ("2K", unit_of("img-sized") + "_2k", 8.0)


def test_rollback_and_replay(db):
    mig = sec_db.MIGRATION_0208.read_text(encoding="utf-8")
    q = ("select (select count(*) from pg_trigger where tgrelid = 'public.creative_jobs'::regclass and tgname = 'creative_jobs_geo_gate'), "
         "md5(regexp_replace((select prosrc from pg_proc where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure), '\\s+', ' ', 'g'))")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        assert c.execute(q).fetchone() == (1, sec_db.CREATIVE_PRICE_0208)
        c.execute(mig)                                                   # a replay changes nothing
        assert c.execute(q).fetchone() == (1, sec_db.CREATIVE_PRICE_0208)
        c.execute(sec_db.rollback_0208_body())
        assert c.execute(q).fetchone() == (0, sec_db.CREATIVE_PRICE_0159)
        assert c.execute("select to_regprocedure('public.geo_claim_country()') is null").fetchone()[0]
        c.execute(sec_db.rollback_0208_body())                           # twice: harmless
        c.execute(mig)
        assert c.execute(q).fetchone() == (1, sec_db.CREATIVE_PRICE_0208)
        c.rollback()
