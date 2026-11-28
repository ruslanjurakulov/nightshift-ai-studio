"""Breach on migration 0250 (sellable_models knows `music`), in a throwaway lab database.

0250 makes a lit music model visible to everything that asks sellable_models for 'music': the router (route_model 0196), the
worker's failover (reroute_creative_job 0208) and the API's exact and routed doors (api_creative_model_ok 0188, creative_route_quote
0196). Before it those callers saw 22023, which every one of them turned into a refusal. These tests try to make that new reach
sell, route or fail over to a music model that must not be sold, leak what sellable_models must not show, cross capabilities in a
failover, wake the two registry-only capabilities, and break the md5 guard, the rollback or 0192's function settings.

What would break, and which test says so:
  a failover lands on a music model that is hidden, unpriced, switched off, shut down, entitled,
  adult-only (no attestation) or country-listed (the worker has no visitor's country)     test_failover_never_lands_on_an_unsellable_music_model
  the router picks a music model in one of those states                                    test_the_router_never_picks_an_unsellable_music_model
  the schema lets a music model on sale unverified, terms-gated or unpriced                test_the_registry_refuses_a_music_model_on_sale_unverified_or_gated
  a member's quote reaches a minor, or a country-listed music model runs from a blocked
  or unknown country                                                                       test_a_minor_and_a_blocked_country_are_refused_music
  sellable_models leaks a hidden row or a private spec field, or anon can call it          test_sellable_models_leaks_nothing_about_music
  a failover moves a music job to a picture model, or a picture job to a music model       test_failover_never_crosses_capabilities
  a member writes the platform's failover list                                             test_a_member_cannot_write_the_failover_list
  video_music or video_character_swap reach any door                                       test_registry_only_capabilities_reach_no_door
  0250 changes 0192's settings (definer, search_path, volatility, ACL, owner, defaults)    test_0250_keeps_0192s_function_settings_exactly
  a re-apply of 0250 or its rollback keeps an ALTERed security setting                     test_reapply_and_rollback_restore_definer_and_search_path
  a body whose `--` comments differ passes the guard (expected: comments are not code)    test_the_guard_ignores_comments_only
  THE API SELLS MUSIC when a music row is not marked web_only (FAILING: a hole)            test_the_api_never_sells_music_whatever_api_exposure_says
  THE API ROUTER PICKS MUSIC the same way (FAILING: a hole)                                test_the_api_router_never_picks_music

Everything is lab-only: synthetic users and models, a lab-only geo key, no provider call.
"""
import hashlib
import hmac
import json
import os
import re
import time
import uuid

import psycopg
import pytest

import sec_db

ORG = "aaaaaaaa-0000-0000-0000-0000000b0250"
U_A = str(uuid.UUID(int=0xB250A))     # owner of ORG, no adult attestation
U_OWN = str(uuid.UUID(int=0xB250F))   # the platform owner
U_MINOR = str(uuid.UUID(int=0xB250C))  # a member who said they are under 18
KEY = "lab-only-geo-claim-key-b0250-not-a-secret-xxxxxxxx"
API_KEY_HASH = hashlib.sha256(b"breach-0250-lab-key").hexdigest()
SONG = {"prompt": "a calm solo piano piece"}
PIC = {"prompt": "a lighthouse at dusk"}
SM = "public.sellable_models(text, text)"
A, B, API_SONG, IMG = "lab-b-song-a", "lab-b-song-b", "lab-b-song-api", "lab-b-img"
#: What 0192's sellable_models publishes of spec (its jsonb_build_object keys). Anything else is private.
PUBLIC_SPEC = {"output", "inputs", "aspect_ratios", "aspect_ratios_by_capability", "image_sizes", "resolutions", "durations_s",
               "audio_out", "upscale_factors", "languages", "upscale_targets", "end_frame", "async", "unit", "qualities",
               "relight_looks", "default_resolution", "price_variants_by", "attribution", "api_exposure", "requires_adult",
               "limits", "quality_tier", "speed_tier"}
REGISTRY = {m["id"]: m for m in json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
LYRIA_FILE = REGISTRY["google-lyria-3.5"]


def unit_of(mid, kind="request"):
    return "model_" + mid.replace("-", "_").replace(".", "_") + "_" + kind


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
    return json.dumps(c)


def sign(country, uid=U_A):
    body = f"v1.{country}.{uid}.{int(time.time() + 120)}"
    return body + "." + hmac.new(KEY.encode(), body.encode(), hashlib.sha256).hexdigest()


def strip_tx(path):
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def become(c, role, uid=None, headers=None):
    c.execute("reset role")
    c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
    c.execute("select set_config('request.headers', %s, true)", [json.dumps(headers or {})])
    c.execute(f"set local role {role}")


def raised(c, q, p=None):
    c.execute("savepoint b")
    try:
        c.execute(q, p)
    except psycopg.Error as e:
        c.execute("rollback to savepoint b")
        return e.sqlstate, f"{str(e).splitlines()[0]} {e.diag.message_detail or ''}"
    c.execute("release savepoint b")
    return None, None


def music_spec(extra=None, exposure="web_only"):
    s = {"vendor_model": "vend-secret-id", "output": "audio", "durations_s": [], "terms_notes": "private terms note",
         "limits": {"max_prompt_chars": 2000, "max_concurrent_per_org": 5},
         "pricing": {"unit": "request", "provider_usd_per_unit": 0.08, "confirmed": False}}
    if exposure is not None:
        s["api_exposure"] = exposure
    s.update(extra or {})
    return s


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None, headers=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            become(c, role, uid, headers)
            cur = c.execute(q, p)
            rows = cur.fetchall() if cur.description else None
            c.commit()
            return rows


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach250_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@b.io'), (%s,'own@b.io'), (%s,'kid@b.io')", [U_A, U_OWN, U_MINOR])
    d.su("insert into public.organizations (id, name, slug) values (%s,'B','org-breach-0250')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@b.io','owner'), (%s,%s,'kid@b.io','admin')",
         [ORG, U_A, ORG, U_MINOR])
    d.su("insert into public.app_members (user_id, email, role) values (%s,'own@b.io','owner')", [U_OWN])
    d.su("insert into public.adult_attestations (user_id, adult, terms_version, method) values (%s, false, 'v1', 'welcome')", [U_MINOR])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    d.su("select vault.create_secret(%s, 'nightshift_geo_claim_key', 'lab')", [KEY])
    # The API: activated, tier 4, one full creative key.
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1')", [ORG, U_A])
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 0, 100000)", [ORG])
    d.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s, 'k', %s, %s, %s)",
         [ORG, API_KEY_HASH, U_A, ["creative:quote", "creative:create", "creative:read"]])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "audio.lab", "capabilities": ["music"],
             "credit_unit": unit_of(m), "entitlement": "any", "spec": music_spec(exposure=exp)}
            for m, exp in ((A, "web_only"), (B, "web_only"), (API_SONG, "any"))]
    rows.append({"id": IMG, "display_name": IMG, "provider": "acme", "adapter": "image.lab", "capabilities": ["t2i"],
                 "credit_unit": unit_of(IMG, "image"), "entitlement": "any",
                 "spec": {"vendor_model": "lab-" + IMG, "output": "image", "api_exposure": "web_only"}})
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m in (A, B, API_SONG):
        d.su("select public.record_model_probe(%s, 'audio.lab', 'vend-secret-id', 'music', true, null, null, 10, 100, 'security-lab')", [m])
    d.su("select public.record_model_probe(%s, 'image.lab', %s, 't2i', true, null, null, 10, 100, 'security-lab')", [IMG, "lab-" + IMG])
    d.su("update public.model_registry set availability = 'beta' where id in (%s, %s, %s)", [A, B, IMG])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 3, 0), (%s, 3, 0), (%s, 2, 0), (%s, 3, 0), "
         "('job_minimum', 1, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin",
         [unit_of(A), unit_of(B), unit_of(API_SONG), unit_of(IMG, "image")])
    # One routed music job on A (B is its failover) and one routed picture job, both claimed by the lab worker.
    d.music_job = routed(d, "music", SONG, "b250-music", "b250-w1")
    d.pic_job = routed(d, "t2i", PIC, "b250-pic", "b250-w2")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def routed(d, cap, params, idem, worker):
    route = d.act("authenticated", U_A, "select public.quote_creative_route(%s, %s, 'cheap', %s::jsonb)", [ORG, cap, json.dumps(params)])[0][0]
    job = d.act("authenticated", U_A, "select public.create_creative_job(%s::uuid, %s, %s, %s::jsonb, 'cheap', %s, %s::numeric)",
                [ORG, cap, route["model"], json.dumps(params), idem, route["credits"]])[0][0]["job"]
    got = d.act("service_role", None, "select id::text, routed_model from public.claim_creative_job(%s)", [worker])
    assert got and got[0][0] == job["id"], got
    return {"id": job["id"], "worker": worker, "model": got[0][1]}


#: Each way a music model is not for sale, as superuser SQL on `{m}`. Applied inside a transaction that is rolled back.
UNSELLABLE = {
    "hidden": "update public.model_registry set availability = 'hidden' where id = '{m}'",
    "disabled": "update public.model_registry set availability = 'disabled' where id = '{m}'",
    "unpriced": "delete from public.credit_prices where unit = (select credit_unit from public.model_registry where id = '{m}')",
    "price_zero": "update public.credit_prices set credits_per_unit = 0 where unit = (select credit_unit from public.model_registry where id = '{m}')",
    "switched_off": "update public.model_availability_settings set enforced = true; "
                    "insert into public.model_availability (scope, target, enabled, reason) values ('model', '{m}', false, 'other') on conflict do nothing",
    "provider_off": "update public.model_availability_settings set enforced = true; "
                    "insert into public.model_availability (scope, target, enabled, reason) values ('provider', 'acme', false, 'other') on conflict do nothing",
    "shut_down": "update public.model_registry set spec = spec || '{{\"shutdown\": {{\"on\": \"2020-01-01\"}}}}' where id = '{m}'",
    "bad_shutdown": "update public.model_registry set spec = spec || '{{\"shutdown\": \"soon\"}}' where id = '{m}'",
    "entitled": "update public.model_registry set entitlement = 'models_audio:premium' where id = '{m}'",
    "paid_no_purchase": "update public.model_registry set entitlement = 'paid' where id = '{m}'",
    "adult_only": "update public.model_registry set spec = spec || '{{\"requires_adult\": true}}' where id = '{m}'",
    "adult_odd": "update public.model_registry set spec = spec || '{{\"requires_adult\": \"yes\"}}' where id = '{m}'",
    "country_listed": "update public.model_registry set provider = 'google', spec = spec || jsonb_build_object("
                      "'blocked_countries', %(blocked)s::jsonb, 'available_countries', %(avail)s::jsonb) where id = '{m}'",
    "allow_list_only": "update public.model_registry set spec = spec || '{{\"available_countries\": [\"UZ\"]}}' where id = '{m}'",
}
LISTS = {"blocked": json.dumps(LYRIA_FILE["blocked_countries"]), "avail": json.dumps(LYRIA_FILE["available_countries"])}


def apply_state(c, state, m):
    c.execute("reset role")
    sql = UNSELLABLE[state].format(m=m)
    for stmt in [s for s in sql.split("; ") if s.strip()]:
        c.execute(stmt, LISTS if "%(" in stmt else None)


@pytest.mark.parametrize("state", sorted(UNSELLABLE))
def test_failover_never_lands_on_an_unsellable_music_model(db, state):
    j = db.music_job
    assert j["model"] == A
    with psycopg.connect(db.dsn, autocommit=False) as c:
        apply_state(c, state, B)
        become(c, "service_role")
        moved = c.execute("select public.reroute_creative_job(%s, %s, 'unreachable')", [j["id"], j["worker"]]).fetchone()[0]
        assert moved is None, (state, moved)
        c.execute("reset role")
        assert c.execute("select routed_model from public.creative_jobs where id = %s", [j["id"]]).fetchone()[0] == A, state
        c.rollback()
    # Control: with B sellable the same failover moves (so the null above is the state, not a broken job).
    with psycopg.connect(db.dsn, autocommit=False) as c:
        become(c, "service_role")
        moved = c.execute("select public.reroute_creative_job(%s, %s, 'unreachable')", [j["id"], j["worker"]]).fetchone()[0]
        assert moved and moved["model"] == B, moved
        c.rollback()


ROUTER_REFUSES = {"hidden", "disabled", "unpriced", "price_zero", "switched_off", "provider_off", "shut_down", "bad_shutdown",
                  "entitled", "paid_no_purchase", "adult_only", "adult_odd"}


@pytest.mark.parametrize("state", sorted(ROUTER_REFUSES))
def test_the_router_never_picks_an_unsellable_music_model(db, state):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        apply_state(c, state, A)
        apply_state(c, state, B)
        c.execute("update public.model_registry set availability = 'hidden' where id = %s", [API_SONG])
        for surface in ("web", "api", "mcp"):
            if surface == "web":
                become(c, "authenticated", U_A)
                st, msg = raised(c, "select public.quote_creative_route(%s, 'music', 'cheap', %s::jsonb)", [ORG, json.dumps(SONG)])
            else:
                # creative_route_quote is the API's and MCP's internal door (no grant): called as its definer would, for U_A.
                become(c, "authenticated", U_A)
                c.execute("reset role")
                st, msg = raised(c, "select public.creative_route_quote(%s, 'music', 'cheap', %s::jsonb, %s)", [ORG, json.dumps(SONG), surface])
            become(c, "authenticated", U_A)
            assert st == "NS400" and ("no_model_available" in msg or "adult_attestation_required" in msg), (state, surface, st, msg)
            st, msg = raised(c, "select public.create_creative_job(%s, 'music', %s, %s::jsonb, 'cheap', %s, 3)",
                             [ORG, A, json.dumps(SONG), f"b250-{state}-{surface}"])
            assert st == "NS400", (state, surface, st, msg)
        c.rollback()


def test_the_registry_refuses_a_music_model_on_sale_unverified_or_gated(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        for q, con in (("update public.model_registry set spec = spec || '{\"terms_gate\": \"terms_review_required\"}' where id = %s",
                        "model_registry_terms_before_sale"),
                       ("update public.model_registry set verified_at = null, verified_probe_id = null where id = %s",
                        "model_registry_verified"),
                       ("update public.model_registry set credit_unit = null where id = %s", "model_registry_unit_before_sale"),
                       ("update public.model_registry set spec = spec || '{\"blocked_countries\": [\"RU\"]}' where id = %s",
                        "model_registry_countries_before_sale")):
            st, msg = raised(c, q, [A])
            assert st == "23514" and con in msg, (q, st, msg)
        # The guard: changing what is called (vendor model) takes it off sale, it never stays on sale on the old probe.
        c.execute("update public.model_registry set spec = spec || '{\"vendor_model\": \"other\"}' where id = %s", [A])
        assert c.execute("select availability, verified_at from public.model_registry where id = %s", [A]).fetchone() == ("hidden", None)
        become(c, "authenticated", U_A)
        assert A not in [r[0] for r in c.execute("select id from public.sellable_models('music', 'web')")]
        c.rollback()


def test_a_minor_and_a_blocked_country_are_refused_music(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        become(c, "authenticated", U_MINOR)
        st, msg = raised(c, "select public.quote_creative_route(%s, 'music', 'cheap', %s::jsonb)", [ORG, json.dumps(SONG)])
        assert st == "NS400" and "adult_only_service" in msg, (st, msg)
        st, msg = raised(c, "select public.create_creative_job(%s, 'music', %s, %s::jsonb, 'exact', 'b250-kid', 3)", [ORG, A, json.dumps(SONG)])
        assert st == "NS400" and "adult_only_service" in msg, (st, msg)
        # The only music model is country-listed (Lyria's lists): the router may pick it, but no job runs without a trusted claim
        # from its allow-list.
        apply_state(c, "country_listed", A)
        c.execute("update public.model_registry set availability = 'hidden' where id in (%s, %s)", [B, API_SONG])
        blocked = LYRIA_FILE["blocked_countries"][0]
        for headers, word in (({}, "country_unverified"), ({"x-nightshift-geo": sign(blocked)}, "country_blocked"),
                              ({"x-nightshift-geo": sign("ZZ")}, "country_unverified"),
                              ({"x-nightshift-geo": sign("UZ", uid=U_MINOR)}, "country_unverified")):
            become(c, "authenticated", U_A, headers)
            route = c.execute("select public.quote_creative_route(%s, 'music', 'cheap', %s::jsonb)", [ORG, json.dumps(SONG)]).fetchone()[0]
            assert route["model"] == A, route
            st, msg = raised(c, "select public.create_creative_job(%s, 'music', %s, %s::jsonb, 'cheap', %s, %s::numeric)",
                             [ORG, A, json.dumps(SONG), "b250-geo-" + word + str(len(headers)), route["credits"]])
            assert st == "NS400" and word in msg, (headers.keys(), st, msg)
        c.rollback()


def test_sellable_models_leaks_nothing_about_music(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("update public.model_registry set availability = 'hidden' where id = %s", [B])
        c.execute("update public.model_registry set spec = spec || '{\"secret_note\": \"x\", \"probe\": {\"k\": 1}}' where id = %s", [A])
        c.execute("update public.credit_prices set margin = 0.5 where unit = %s", [unit_of(A)])
        for role, uid in (("authenticated", U_A), ("service_role", None)):
            for surface in ("web", "api", "mcp"):
                become(c, role, uid)
                rows = c.execute("select id, margin, spec, credits_per_unit from public.sellable_models('music', %s)", [surface]).fetchall()
                ids = [r[0] for r in rows]
                assert B not in ids, (role, surface)                         # hidden
                assert (A in ids) == (surface == "web"), (role, surface, ids)  # web_only
                for mid, margin, spec, cpu in rows:
                    assert margin is None, mid
                    assert set(spec) <= PUBLIC_SPEC, (mid, set(spec) - PUBLIC_SPEC)
                    assert "vend-secret-id" not in json.dumps(spec) and "private terms" not in json.dumps(spec), mid
                    if mid == A:
                        assert float(cpu) == 4.5, cpu                         # the rate as charged, never the margin itself
        become(c, "anon")
        st, _ = raised(c, "select * from public.sellable_models('music', 'web')")
        assert st == "42501", st
        names = [r[0] for r in c.execute("select display_name from public.public_models_on_sale()")]
        assert A in names and B not in names, names
        c.rollback()


def test_failover_never_crosses_capabilities(db):
    mj, pj = db.music_job, db.pic_job
    with psycopg.connect(db.dsn, autocommit=False) as c:
        # Plant the other capability's model as the only next candidate (the platform's own table, as if a bug wrote it).
        c.execute("update public.creative_job_routes set candidates = jsonb_build_array(jsonb_build_object('model', %s::text, 'credits', 3), "
                  "jsonb_build_object('model', %s::text, 'credits', 1, 'quality_tier', 0)) where job_id = %s", [A, IMG, mj["id"]])
        c.execute("update public.creative_job_routes set candidates = jsonb_build_array(jsonb_build_object('model', %s::text, 'credits', 3), "
                  "jsonb_build_object('model', %s::text, 'credits', 1, 'quality_tier', 0), jsonb_build_object('model', %s::text, 'credits', 1)) "
                  "where job_id = %s", [IMG, A, API_SONG, pj["id"]])
        become(c, "service_role")
        assert c.execute("select public.reroute_creative_job(%s, %s, 'unreachable')", [mj["id"], mj["worker"]]).fetchone()[0] is None
        assert c.execute("select public.reroute_creative_job(%s, %s, 'unreachable')", [pj["id"], pj["worker"]]).fetchone()[0] is None
        c.rollback()
    # And the router's own list for a music job names music models only.
    cands = db.su("select candidates from public.creative_job_routes where job_id = %s", [mj["id"]])[0][0]
    assert {x["model"] for x in cands} <= {A, B}, cands


def test_a_member_cannot_write_the_failover_list(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        for role, uid in (("authenticated", U_A), ("anon", None), ("service_role", None)):
            become(c, role, uid)
            st, _ = raised(c, "update public.creative_job_routes set candidates = '[]'::jsonb where job_id = %s", [db.music_job["id"]])
            assert st == "42501", (role, st)
            st, _ = raised(c, "update public.creative_jobs set routed_model = %s where id = %s", [IMG, db.music_job["id"]])
            assert st == "42501", (role, st)
        c.rollback()


@pytest.mark.parametrize("cap", ["video_music", "video_character_swap", "VIDEO_MUSIC", " video_music ", "Music", "music;"])
def test_registry_only_capabilities_reach_no_door(db, cap):
    norm = cap.strip().lower()
    with psycopg.connect(db.dsn, autocommit=False) as c:
        for surface in ("web", "api", "mcp"):
            become(c, "authenticated", U_A)
            st, msg = raised(c, "select * from public.sellable_models(%s, %s)", [cap, surface])
            assert st == "22023", (cap, surface, st, msg)
        if norm == "music":
            c.rollback()
            return                                                        # the routers normalise case; sellable_models does not
        become(c, "authenticated", U_A)
        for q, p in (("select public.quote_creative_route(%s, %s, 'cheap', %s::jsonb)", [ORG, cap, json.dumps(SONG)]),
                     ("select public.quote_creative_job(%s, %s, %s, %s::jsonb)", [ORG, cap, A, json.dumps(SONG)]),
                     ("select public.create_creative_job(%s, %s, %s, %s::jsonb, 'exact', 'b250-u', 9)", [ORG, cap, A, json.dumps(SONG)]),
                     ("select public.create_creative_job(%s, %s, %s, %s::jsonb, 'cheap', 'b250-u2', 9)", [ORG, cap, A, json.dumps(SONG)])):
            st, msg = raised(c, q, p)
            assert st == "NS400" and ("capability_not_supported" in msg or "invalid_params" in msg), (cap, q, st, msg)
        become(c, "anon")
        out = c.execute("select public.api_creative_quote(%s, %s, %s, %s::jsonb, null)", [API_KEY_HASH, cap, API_SONG, json.dumps(SONG)]).fetchone()[0]
        assert not out.get("ok", False) and "data" not in out, (cap, out)
        c.execute("reset role")
        st, msg = raised(c, "update public.model_registry set capabilities = array['music', %s] where id = %s", [norm, A])
        assert st == "23514", (cap, st, msg)
        c.rollback()


def _settings(c):
    return c.execute("select prosecdef, proconfig, provolatile, proacl::text, proowner, pg_get_function_arguments(oid), "
                     "pg_get_function_result(oid), prolang, proparallel, proleakproof, procost, prorows "
                     "from pg_proc where oid = %s::regprocedure", [SM]).fetchone()


def test_0250_keeps_0192s_function_settings_exactly(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        live = _settings(c)
        assert live[0] is True and live[1] == ["search_path=public, pg_temp"] and live[2] == "s", live
        assert live[3] == "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", live[3]
        sec_db.rollback_0250_on_sale(c)                                 # 0192's body and settings, as the rollback writes them
        assert sec_db.cut_md5(c, SM) == sec_db.SELLABLE_MODELS_0192
        assert _settings(c) == live
        c.rollback()


def test_reapply_and_rollback_restore_definer_and_search_path(db):
    mig = sec_db.MIGRATION_0250.read_text(encoding="utf-8")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        want = _settings(c)
        for path in (mig, None):
            # Same prosrc, so the md5 guard passes; the settings drifted by ALTER.
            c.execute("alter function public.sellable_models(text, text) security invoker")
            c.execute("alter function public.sellable_models(text, text) set search_path = pg_temp, public")
            c.execute("grant execute on function public.sellable_models(text, text) to anon")
            if path is None:
                sec_db.rollback_0250_on_sale(c)                         # the rollback refuses while music is on sale
            else:
                c.execute(path)
            assert _settings(c) == want, (path or "rollback")[:40]
        c.rollback()


def test_the_guard_ignores_comments_only(db):
    """The fingerprint cuts `--` comments and folds white space, by design. This pins that a CODE change still fails, and that the
    cut cannot be abused: the 0250 body holds no `--` inside a string literal, so no code hides behind a cut."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        src = c.execute("select prosrc from pg_proc where oid = %s::regprocedure", [SM]).fetchone()[0]
        # A small lexer (plpgsql: '...' literals with '' escapes, -- line comments, no dollar quotes inside this body).
        i, lits = 0, []
        while i < len(src):
            if src.startswith("--", i):
                i = src.find(chr(10), i) if src.find(chr(10), i) >= 0 else len(src)
            elif src[i] == "'":
                j = i + 1
                while j < len(src) and not (src[j] == "'" and not src.startswith("''", j)):
                    j += 2 if src.startswith("''", j) else 1
                lits.append(src[i:j + 1])
                i = j + 1
            else:
                i += 1
        assert lits and "'music'" in lits
        assert not [x for x in lits if "--" in x or chr(36) in x], lits
        c.rollback()


def test_the_api_never_sells_music_whatever_api_exposure_says(db):
    """FAILING ON PURPOSE (a hole). API_CREATIVE_CAPABILITIES (command-center/lib/api/operations.ts) says music is 'never on the API',
    and 0250's header files api_creative_models' exclusion under 'must stay so'. But quoteCreative / createCreative do not check that
    list, and api_creative_quote / _create ask only api_creative_model_ok -> sellable_models(cap, 'api'), whose surface rule reads
    the row's api_exposure with a default of 'any'. Before 0250 the 22023 kept every music row off the API; after it, a music row
    that is not marked web_only (absent counts as 'any'; nothing in modules/model_registry.py requires web_only for music) is quoted,
    held and queued for an API key. The fix belongs in the database (music refused on the 'api' surface, as captions are), not in
    each row's data."""
    seen = []
    with psycopg.connect(db.dsn, autocommit=False) as c:
        for exp in ("any", None):
            if exp is None:
                c.execute("update public.model_registry set spec = spec - 'api_exposure' where id = %s", [API_SONG])
            c.execute("update public.model_registry set availability = 'beta' where id = %s", [API_SONG])
            become(c, "authenticated", U_A)
            if API_SONG in [r[0] for r in c.execute("select id from public.sellable_models('music', 'api')")]:
                seen.append((exp, "sellable_models('music', 'api') lists it"))
            become(c, "anon")
            q = c.execute("select public.api_creative_quote(%s, 'music', %s, %s::jsonb, null)",
                          [API_KEY_HASH, API_SONG, json.dumps(SONG)]).fetchone()[0]
            if q.get("ok"):
                seen.append((exp, "api_creative_quote", q["data"]))
            job = c.execute("select public.api_creative_create(%s, 'music', %s, %s::jsonb, 'exact', 2, %s, %s, null)",
                            [API_KEY_HASH, API_SONG, json.dumps(SONG), f"b250-api-{exp}", "f" * 64]).fetchone()[0]
            if job.get("ok"):
                c.execute("reset role")
                held = c.execute("select status, capability, routed_model, credit_ref is not null from public.creative_jobs "
                                 "where id = %s", [job["data"]["id"]]).fetchone()
                seen.append((exp, "api_creative_create", job["data"]["id"], held))
            c.execute("reset role")
        c.rollback()
    assert seen == [], seen


def test_the_api_router_never_picks_music(db):
    """FAILING ON PURPOSE (the same hole through the routed door: api_creative_quote(..., p_mode) -> creative_route_quote(..., 'api')
    -> route_model -> sellable_models('music', 'api'))."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("update public.model_registry set availability = 'beta' where id = %s", [API_SONG])
        become(c, "anon")
        q = c.execute("select public.api_creative_quote(%s, 'music', null, %s::jsonb, 'cheap', null)",
                      [API_KEY_HASH, json.dumps(SONG)]).fetchone()[0]
        assert "data" not in q, ("the API router picked a music model", q)
        c.rollback()


def test_before_0250_the_api_refused_music(db):
    """The red half of the API finding: on 0192's body (the rollback) the same key, model and row are refused, so 0250 opened it."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.rollback_0250_on_sale(c)                                 # the rollback refuses while music is on sale
        c.execute("update public.model_registry set availability = 'beta' where id = %s", [API_SONG])
        become(c, "anon")
        q = c.execute("select public.api_creative_quote(%s, 'music', %s, %s::jsonb, null)", [API_KEY_HASH, API_SONG, json.dumps(SONG)]).fetchone()[0]
        assert not q.get("ok"), q
        r = c.execute("select public.api_creative_quote(%s, 'music', null, %s::jsonb, 'cheap', null)", [API_KEY_HASH, json.dumps(SONG)]).fetchone()[0]
        assert not r.get("ok"), r
        c.rollback()
