"""Breach's attacks on migration 0230 (the country gate reads Google's allow-list), in a scratch database of its own.

Each test names the attack. A test that FAILS here is a hole that is still open (it is never skipped):

  a Google row with available_countries and no (or an empty) blocked_countries is not gated     test_breach_allow_list_alone_*
    at all, and 0142's CHECK lets it go on sale
  a body whose comment swallowed the HMAC check folds to 0208's md5, so 0230's end state        test_breach_md5_fold_*
    accepts a geo_claim_country() that trusts any unsigned claim

The rest pin attacks that were tried and refused (claim casing / white space, odd list shapes, the UPDATE path, the API roles'
reach into model_registry and creative_jobs), so a later change that opens one of them is caught.

Helpers (signing, Db, create / refused) are the 0230 contract file's own, so both files attack the same database shape.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db
import test_sec_geo_allowlist_0230 as base

ORG, U_A = base.ORG, base.U_A
ANY = base.ANY_GOOGLE
AVAIL = ANY["available_countries"]
BLOCK = ANY["blocked_countries"]

#: provider spelled with a capital would skip `prov = 'google'`; 0035's model_registry_provider_check (^[a-z0-9-]{2,32}$) refuses it.
CASED_STALE = "breach-google-cased-stale"
#: a Google row synced with its allow-list (the control for the UPDATE-path tests).
CASED_SYNCED = "breach-google-synced"
#: an allow-list and no deny-list (the registry validator refuses this shape; the database does not).
AVAIL_ONLY = "breach-google-avail-only"
#: an allow-list and an empty deny-list.
AVAIL_EMPTY_BLOCK = "breach-google-avail-empty-block"
#: an allow-list that is an object whose keys are countries: `?` on an object reads keys, so it must be refused by shape.
OBJ = "breach-google-obj"
#: an allow-list with non-strings in it: `?` matches only string elements.
MIXED = "breach-google-mixed"
#: an allow-list written as JSON null.
JNULL = "breach-google-jnull"
#: an allow-list with lower case / padded codes (a mis-written sync): fails closed for a legitimate visitor.
LOWER = "breach-google-lower"

MODELS = [
    (CASED_SYNCED, "google", {"blocked_countries": BLOCK, "available_countries": AVAIL}),
    (AVAIL_ONLY, "google", {"available_countries": AVAIL}),
    (AVAIL_EMPTY_BLOCK, "google", {"blocked_countries": [], "available_countries": AVAIL}),
    (OBJ, "google", {"blocked_countries": BLOCK, "available_countries": {c: True for c in AVAIL + ["EU", "QQ"]}}),
    (MIXED, "google", {"blocked_countries": BLOCK, "available_countries": [1, None, {"UZ": 1}, ["UZ"], "US"]}),
    (JNULL, "acme", {"blocked_countries": ["RU"], "available_countries": None}),
    (LOWER, "google", {"blocked_countries": BLOCK, "available_countries": ["uz", " US", "XK "]}),
]

#: the contract file's rows (the shipped Google ids, its deny-list model) plus these.
ALL = base.MODELS + MODELS


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_geo230b_{uuid.uuid4().hex[:8]}"
    d = base.Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io')", [U_A])
    d.su("insert into public.organizations (id, name, slug) values (%s,'G','org-geo-0230')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner')", [ORG, U_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    # Kept for AVAIL_ONLY / AVAIL_EMPTY_BLOCK (they must go on sale WITH it); dropped below only for the rows that carry a deny-list.
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": base.unit_of(m), "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "image", **spec}}
            for m, prov, spec in ALL]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    prices = []
    for m, _p, _s in ALL:
        d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'security-lab')", [m, "acme-" + m])
        prices.append(f"('{base.unit_of(m)}', 2, 0)")
    # 0142's CHECK is live here: these two go on sale through it (that is part of the finding).
    for m in (AVAIL_ONLY, AVAIL_EMPTY_BLOCK):
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su("alter table public.model_registry drop constraint if exists model_registry_countries_before_sale")
    for m, _p, _s in ALL:
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {', '.join(prices)}, ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.su("select vault.create_secret(%s, 'nightshift_geo_claim_key', 'lab')", [base.KEY])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def _create_with_header(db, model, header_value):
    base._n[0] += 1
    headers = {"x-nightshift-geo": header_value}
    out = db.act("authenticated", U_A, "select public.create_creative_job(%s,'t2i',%s,%s::jsonb,'exact',%s,1000)",
                 [ORG, model, json.dumps(base.T2I), f"geo230b-{base._n[0]}"], headers=headers)[0][0]
    base.drain(db)
    return out


# ───────────────────────────── open holes (these FAIL until fixed) ─────────────────────────────

def test_provider_casing_or_padding_cannot_reach_the_registry(db):
    # 0230 reads `prov = 'google'` exactly. A row spelled 'Google' / ' google' with only the complement would fall back to 0208's
    # reading (EU a job); 0035's CHECK on provider refuses such a row before the gate ever sees it.
    for prov in ("Google", " google", "google ", "GOOGLE"):
        row = {"id": CASED_STALE, "display_name": "x", "provider": prov, "adapter": "image.acme", "capabilities": ["t2i"],
               "credit_unit": base.unit_of(CASED_STALE), "entitlement": "any", "spec": {"blocked_countries": BLOCK}}
        with psycopg.connect(db.dsn, autocommit=False) as c:
            with pytest.raises(psycopg.errors.CheckViolation):
                c.execute("select public.sync_model_registry(%s::jsonb)", [json.dumps([row])])
            c.rollback()


def test_breach_allow_list_alone_is_not_gated_at_all(db):
    # 0230's header: "an allow-list model is a row whose spec carries available_countries". The trigger still returns at 0208's
    # `if lst is null ... return new` before it reads al, so a row with only available_countries is asked nothing: EU, QQ and even
    # no claim at all (a member straight through PostgREST) are jobs. 0142's CHECK reads blocked_countries only, so this row went
    # on sale (beta) in the fixture with the CHECK in place.
    assert db.su("select availability from public.model_registry where id=%s", [AVAIL_ONLY])[0][0] == "beta"
    for code in ("EU", "QQ", "RU"):
        assert base.refused(db, AVAIL_ONLY, code)[1] in ("country_unverified", "country_blocked"), code
    assert base.refused(db, AVAIL_ONLY, None) == ("NS400", "country_unverified")


def test_breach_allow_list_alone_with_empty_deny_list_is_not_gated_at_all(db):
    assert db.su("select availability from public.model_registry where id=%s", [AVAIL_EMPTY_BLOCK])[0][0] == "beta"
    for code in ("EU", "RU"):
        assert base.refused(db, AVAIL_EMPTY_BLOCK, code)[1] in ("country_unverified", "country_blocked"), code
    assert base.refused(db, AVAIL_EMPTY_BLOCK, None) == ("NS400", "country_unverified")


def _fold(s):
    import re
    return re.sub(r"\s+", " ", s)


def test_breach_md5_fold_lets_a_comment_swallow_the_hmac_check(db):
    # The drift guards (0208's, 0218's and 0230's end state) hash prosrc with every white-space run folded to one space. A newline
    # that ends a `--` comment is white space, so replacing it with a space turns the next lines into comment text without changing
    # the folded md5. Planted: geo_claim_country() with the Vault read, the key check and the HMAC comparison inside the comment
    # above them. 0230 should refuse to finish on it ("is not 0208's body"); it applies, and an unsigned claim is then trusted.
    with psycopg.connect(db.dsn, autocommit=False) as c:
        src = c.execute("select prosrc from pg_proc where oid = 'public.geo_claim_country()'::regprocedure").fetchone()[0]
        start = src.index("  -- The key lives in Vault")
        end = src.index("  return parts[2];")
        planted = src[:start] + " ".join(src[start:end].split()) + "\n" + src[end:]
        assert _fold(planted) == _fold(src) and planted != src
        c.execute("create or replace function public.geo_claim_country() returns text language plpgsql stable security definer "
                  "set search_path = extensions, public, pg_temp as $body$" + planted + "$body$")
        c.execute(base._rollback())
        refused_apply = False
        try:
            c.execute(base._migration())
        except psycopg.Error as e:
            refused_apply = "geo_claim_country" in str(e)
        if refused_apply:
            c.rollback()
            return
        # 0230 applied over it. Show what that means: a claim with a made-up signature is trusted.
        uid = U_A
        exp = int(c.execute("select extract(epoch from now())").fetchone()[0]) + 60
        forged = f"v1.US.{uid}.{exp}." + "0" * 64
        c.execute("select set_config('request.jwt.claims', %s, true)", [base.claims("authenticated", uid)])
        c.execute("select set_config('request.headers', %s, true)", [json.dumps({"x-nightshift-geo": forged})])
        got = c.execute("select public.geo_claim_country()").fetchone()[0]
        c.rollback()
    pytest.fail(f"0230 applied over a geo_claim_country() whose HMAC check is commented out (forged claim read as {got!r})")


# ───────────────────────────── tried and refused (regression pins) ─────────────────────────────

def test_claim_country_case_and_white_space_variants_are_no_claim(db):
    gid = next(iter(base.GOOGLE))
    for code in ("uz", "Uz", "uZ"):
        assert base.refused(db, gid, code) == ("NS400", "country_unverified"), code
    for raw in (base.sign("UZ").replace("v1.UZ.", "v1. UZ."), " " + base.sign("UZ"), base.sign("UZ") + " ",
                base.sign("UZ") + "\n"):
        got = base.err(lambda: _create_with_header(db, gid, raw))
        assert got == ("NS400", "country_unverified"), repr(raw)


def test_claim_header_of_another_json_type_is_no_claim(db):
    gid = next(iter(base.GOOGLE))
    good = base.sign("UZ")
    for value in ([good], {"v": good}, 1, True, None):
        got = base.err(lambda: _create_with_header(db, gid, value))
        assert got == ("NS400", "country_unverified"), value


def test_google_row_with_allow_list_is_gated(db):
    assert base.refused(db, CASED_SYNCED, "EU") == ("NS400", "country_unverified")
    assert base.refused(db, CASED_SYNCED, "RU") == ("NS400", "country_blocked")
    assert base.create(db, CASED_SYNCED, "UZ")["job"]["id"]


def test_allow_list_as_object_is_refused_by_shape(db):
    # `?` on an object answers for its keys; a list written as {"UZ": true, "EU": true} must not read EU as listed.
    for code in ("EU", "QQ", "UZ"):
        assert base.refused(db, OBJ, code) == ("NS400", "country_unverified"), code


def test_allow_list_with_non_strings_matches_only_string_elements(db):
    assert base.create(db, MIXED, "US")["job"]["id"]
    for code in ("UZ", "EU"):
        assert base.refused(db, MIXED, code) == ("NS400", "country_unverified"), code


def test_allow_list_json_null_fails_closed_even_off_google(db):
    for code in ("UZ", "EU"):
        assert base.refused(db, JNULL, code) == ("NS400", "country_unverified"), code
    assert base.refused(db, JNULL, "RU") == ("NS400", "country_blocked")


def test_allow_list_with_lower_case_codes_fails_closed(db):
    # A mis-written sync denies a legitimate visitor rather than reading "uz" as UZ: the safe direction (and the apply NOTICE
    # does not catch it, since the list IS an array). Pinned so a future "normalise in SQL" change is a deliberate one.
    for code in ("UZ", "US", "XK"):
        assert base.refused(db, LOWER, code) == ("NS400", "country_unverified"), code


def test_client_roles_cannot_change_a_models_spec_or_provider(db):
    gid = next(iter(base.GOOGLE))
    for role, uid in (("authenticated", U_A), ("anon", None)):
        for q in ("update public.model_registry set spec = spec - 'available_countries' where id = %s",
                  "update public.model_registry set provider = 'acme' where id = %s"):
            with pytest.raises(psycopg.Error) as e:
                db.act(role, uid, q, [gid])
            assert e.value.sqlstate == "42501", (role, q)
        with pytest.raises(psycopg.Error):
            db.act(role, uid, "select public.sync_model_registry('[]'::jsonb)")
    assert "available_countries" in db.su("select spec from public.model_registry where id=%s", [gid])[0][0]


def test_client_roles_cannot_update_a_job_onto_a_google_model(db):
    jid = base.create(db, CASED_SYNCED, "UZ")["job"]["id"]
    gid = next(iter(base.GOOGLE))
    for col in ("routed_model", "requested_model"):
        with pytest.raises(psycopg.Error) as e:
            db.act("authenticated", U_A, f"update public.creative_jobs set {col} = %s where id = %s", [gid, jid],
                   headers={"x-nightshift-geo": base.sign("EU")})
        assert e.value.sqlstate == "42501", col


def test_update_of_routed_model_with_a_claim_still_reads_the_allow_list(db):
    # Even a caller WITH a (signed) claim that moves a job's routed_model onto a Google model is asked the allow-list question:
    # the gate fires on UPDATE OF routed_model and reads the same body as on insert.
    jid = base.create(db, CASED_SYNCED, "UZ")["job"]["id"]
    gid = next(iter(base.GOOGLE))
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [base.claims("authenticated", U_A)])
        c.execute("select set_config('request.headers', %s, true)", [json.dumps({"x-nightshift-geo": base.sign("EU")})])
        with pytest.raises(psycopg.Error) as e:
            c.execute("update public.creative_jobs set routed_model = %s where id = %s", [gid, jid])
        assert e.value.sqlstate == "NS400" and "country_unverified" in str(e.value)
        c.rollback()
