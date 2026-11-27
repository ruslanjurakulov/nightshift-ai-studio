"""BR-S6-04, attacked in a real database: an allow-list vendor's models gated by a deny-list (0208), and 0230's fix.

Google's terms are an allow-list ("You may only access the Services ... within an available region", 0208's header). The registry
writes that list as its complement, blocked_countries = every ISO 3166-1 code Google does not list, and 0208's trigger refuses only a
code ON that complement (`lst ? c`). So a claim code that is on neither list (EU and AP are DB-IP placeholders; QQ is no country at
all) was let through: the gate read "not known to be blocked" as "allowed". The web side reads such a code as unknown (PR #951);
this is the database half, in defence in depth: a code our own web server signed, but that is not on Google's list, is unknown.

What would break, and which test says so:
  a code on neither list (EU, AP, QQ, ZZ) starts a job on a Google model            test_br_s6_04_a_code_on_neither_list_is_refused
  a country Google lists (UZ, and XK, which has no ISO code) is refused one         test_a_country_on_googles_list_is_still_served
  RU or BY is refused with another word than country_blocked                        test_a_country_off_googles_list_is_still_blocked
  a non-Google model with a deny-list changes behaviour                             test_a_deny_list_model_is_unchanged
  a Google row synced before 0230 (no allow-list yet) falls back to the deny-list    test_a_google_row_without_its_allow_list_is_refused
  an allow-list of another shape reads as "allowed"                                 test_an_allow_list_of_another_shape_fails_closed
  0230 lands on a gate body nobody read, or its rollback / replay drifts            test_drift_guard_*, test_rollback_and_replay
  a comment that swallowed the code under it reads as 0208's body (BR-S6-05)         test_drift_guard_refuses_a_gate_whose_*

0142's CHECK keeps a model with a country list off sale, so this scratch database drops it once (as test_sec_geo_gate_0208.py does).
The Google ids and both lists are read from schemas/model_registry.json, so the lab checks the lists that ship. Its own scratch
database (it commits).
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

ORG = "aaaaaaaa-0000-0000-0000-000000000230"
U_A = str(uuid.UUID(int=0x230A))
#: A lab-only key (never a real one).
KEY = "lab-only-geo-claim-key-0230-not-a-secret-xxxxxxxx"
T2I = {"prompt": "a lighthouse at dusk"}

REGISTRY = json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]
GOOGLE = {m["id"]: m for m in REGISTRY if m.get("provider") == "google"}
#: md5 (white space folded) of 0208's creative_jobs_geo_gate, the body 0230 replaces.
GATE_0208 = "71468a6f60d2659cd44199a3c834dc69"
GATE_SIG = "public.creative_jobs_geo_gate()"
FOLD = "md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g'))"
#: A non-Google model with a vendor deny-list (the shape of grounded-image-1.0): a code on no list is not refused for it.
DENY = "img-deny-list"
#: A Google row as a registry synced from a ref without 0230 holds it: blocked_countries, no available_countries.
STALE = "google-stale-sync"
#: A Google row whose allow-list is not an array.
BENT = "google-bent-list"
#: Codes that pass 0208's claim shape ([A-Z]{2}) and are on neither of Google's lists.
NEITHER = ("EU", "AP", "QQ", "ZZ")


def unit_of(mid):
    return "model_" + "".join(c if c.isalnum() else "_" for c in mid.lower()) + "_image"


def _google_spec(m):
    spec = {"blocked_countries": m["blocked_countries"]}
    if "available_countries" in m:
        spec["available_countries"] = m["available_countries"]
    return spec


ANY_GOOGLE = next(iter(GOOGLE.values()))
# (id, provider, spec)
MODELS = [(gid, "google", _google_spec(m)) for gid, m in GOOGLE.items()] + [
    (DENY, "acme", {"blocked_countries": ["RU", "BY"]}),
    (STALE, "google", {"blocked_countries": ANY_GOOGLE["blocked_countries"]}),
    (BENT, "google", {"blocked_countries": ANY_GOOGLE["blocked_countries"], "available_countries": "UZ"}),
]


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
    return json.dumps(c)


def sign(country, uid=U_A, exp=None, key=KEY):
    body = f"v1.{country}.{uid}.{int(exp if exp is not None else time.time() + 120)}"
    return body + "." + hmac.new(key.encode(), body.encode(), hashlib.sha256).hexdigest()


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None, headers=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
                if headers is not None:
                    c.execute("select set_config('request.headers', %s, true)", [json.dumps(headers)])
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
    name = f"ns_geo230_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io')", [U_A])
    d.su("insert into public.organizations (id, name, slug) values (%s,'G','org-geo-0230')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner')", [ORG, U_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    d.su("alter table public.model_registry drop constraint if exists model_registry_countries_before_sale")
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": unit_of(m), "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": "image", **spec}}
            for m, prov, spec in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    prices = []
    for m, _p, _s in MODELS:
        d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'security-lab')", [m, "acme-" + m])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
        prices.append(f"('{unit_of(m)}', 2, 0)")
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


def create(db, model, country):
    _n[0] += 1
    headers = None if country is None else {"x-nightshift-geo": sign(country)}
    out = db.act("authenticated", U_A, "select public.create_creative_job(%s,'t2i',%s,%s::jsonb,'exact',%s,1000)",
                 [ORG, model, json.dumps(T2I), f"geo230-{_n[0]}"], headers=headers)[0][0]
    drain(db)
    return out


def footprint(db):
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [ORG])[0][0],
            db.su("select count(*), coalesce(sum(amount),0)::float from public.credit_reservations where org_id=%s", [ORG])[0],
            db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [ORG])[0])


def refused(db, model, country):
    before = footprint(db)
    got = err(lambda: create(db, model, country))
    assert footprint(db) == before, (model, country)   # nothing held, nothing written
    return got


def test_the_shipped_lists_name_these_codes_on_neither_side():
    for gid, m in GOOGLE.items():
        for code in NEITHER:
            assert code not in m["blocked_countries"], (gid, code)
            assert code not in m.get("available_countries", []), (gid, code)


def test_br_s6_04_a_code_on_neither_list_is_refused(db):
    # Before 0230 every one of these was a job: 0208 asked only "is it on blocked_countries?".
    for gid in GOOGLE:
        for code in NEITHER:
            assert refused(db, gid, code) == ("NS400", "country_unverified"), (gid, code)


def test_a_country_on_googles_list_is_still_served(db):
    for gid in GOOGLE:
        for code in ("UZ", "XK", "US"):
            job = create(db, gid, code)
            assert job["job"]["id"], (gid, code)


def test_a_country_off_googles_list_is_still_blocked(db):
    for gid in GOOGLE:
        for code in ("RU", "BY", "CN"):
            assert refused(db, gid, code) == ("NS400", "country_blocked"), (gid, code)
        assert refused(db, gid, None) == ("NS400", "country_unverified"), gid


def test_a_deny_list_model_is_unchanged(db):
    # 0208's rule for a vendor that names where it may NOT be used: a code off its list passes, a listed one is blocked, no claim is
    # unverified. BR-S6-03 is about allow-list vendors only.
    for code in ("EU", "QQ", "UZ"):
        assert create(db, DENY, code)["job"]["id"], code
    assert refused(db, DENY, "RU") == ("NS400", "country_blocked")
    assert refused(db, DENY, None) == ("NS400", "country_unverified")


def test_a_google_row_without_its_allow_list_is_refused(db):
    # A registry synced from a ref without 0230 holds only the complement. Reading it as before would let EU through again; reading
    # it as refused is honest (every Google model is off sale until then; the apply notice names the sync).
    for code in ("UZ", "EU"):
        assert refused(db, STALE, code) == ("NS400", "country_unverified"), code
    assert refused(db, STALE, "RU") == ("NS400", "country_blocked")


def test_an_allow_list_of_another_shape_fails_closed(db):
    for code in ("UZ", "EU"):
        assert refused(db, BENT, code) == ("NS400", "country_unverified"), code


def test_the_worker_still_cannot_move_a_job_onto_a_google_model(db):
    jid = create(db, DENY, "UZ")["job"]["id"]
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.creative_jobs set routed_model = %s where id = %s", [next(iter(GOOGLE)), jid])
    assert e.value.sqlstate == "NS400" and "country_unverified" in str(e.value)


def test_the_gate_is_still_definer_pinned_and_closed_to_every_api_role(db):
    prosecdef, cfg = db.su("select prosecdef, proconfig from pg_proc where oid = %s::regprocedure", [GATE_SIG])[0]
    assert prosecdef is True and cfg == ["search_path=public, pg_temp"]
    for role in ("anon", "authenticated", "service_role"):
        assert db.su("select has_function_privilege(%s, %s, 'EXECUTE')", [role, GATE_SIG])[0][0] is False, role
    assert db.su("select count(*) from pg_trigger where tgrelid = 'public.creative_jobs'::regclass "
                 "and tgname = 'creative_jobs_geo_gate' and tgenabled = 'O'")[0][0] == 1


def _migration():
    return (sec_db.MIGRATIONS / "0230_geo_gate_allow_list.sql").read_text(encoding="utf-8")


def _rollback():
    text = (sec_db.REPO / "docs" / "sql" / "rollback_0230_geo_gate_allow_list.sql").read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def _gate_md5(c):
    return c.execute(f"select {FOLD} from pg_proc where oid = %s::regprocedure", [GATE_SIG]).fetchone()[0]


def test_drift_guard_refuses_a_gate_body_nobody_read(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(_rollback())
        c.execute("create or replace function public.creative_jobs_geo_gate() returns trigger language plpgsql security definer "
                  "set search_path = public, pg_temp as $$ begin return new; end $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(_migration())
        assert "0230 found a creative_jobs_geo_gate()" in str(e.value)
        c.rollback()


def test_drift_guard_refuses_a_gate_whose_comment_swallowed_a_refusal(db):
    # BR-S6-05: 0208's body with the claim refusal folded onto the comment line above it hashes to 0208's folded md5, and has no
    # claim check. 0230's fingerprint cuts comments before folding, so it is "a body nobody read".
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(_rollback())
        src = c.execute("select prosrc from pg_proc where oid = %s::regprocedure", [GATE_SIG]).fetchone()[0]
        start = src.index("  -- A model with a country list")
        end = src.index("  -- A list of any other shape")
        planted = src[:start] + " ".join(src[start:end].split()) + "\n" + src[end:]
        c.execute("create or replace function public.creative_jobs_geo_gate() returns trigger language plpgsql security definer "
                  "set search_path = public, pg_temp as $body$" + planted + "$body$")
        assert _gate_md5(c) == GATE_0208                        # the fold alone cannot tell
        with pytest.raises(psycopg.Error) as e:
            c.execute(_migration())
        assert "0230 found a creative_jobs_geo_gate()" in str(e.value)
        c.rollback()


def test_drift_guard_refuses_without_0208(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("drop trigger creative_jobs_geo_gate on public.creative_jobs")
        c.execute("drop function public.creative_jobs_geo_gate()")
        with pytest.raises(psycopg.Error) as e:
            c.execute(_migration())
        assert "0230 needs 0208" in str(e.value)
        c.rollback()


def test_rollback_and_replay(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        after = _gate_md5(c)
        assert after != GATE_0208
        c.execute(_migration())                                 # a replay changes nothing
        assert _gate_md5(c) == after
        c.execute(_rollback())
        assert _gate_md5(c) == GATE_0208                        # 0208's body, byte for byte (folded)
        c.execute(_rollback())                                  # twice: harmless
        assert _gate_md5(c) == GATE_0208
        c.execute(_migration())
        assert _gate_md5(c) == after
        c.rollback()


def test_after_the_rollback_the_finding_is_back(db):
    # The rollback is a real undo: with 0208's body back, EU is a job again (which is why 0230 exists).
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(_rollback())
        c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", U_A)])
        c.execute("select set_config('request.headers', %s, true)", [json.dumps({"x-nightshift-geo": sign("EU")})])
        c.execute("set local role authenticated")
        out = c.execute("select public.create_creative_job(%s,'t2i',%s,%s::jsonb,'exact','geo230-rb',1000)",
                        [ORG, next(iter(GOOGLE)), json.dumps(T2I)]).fetchone()[0]
        assert out["job"]["id"]
        c.rollback()
