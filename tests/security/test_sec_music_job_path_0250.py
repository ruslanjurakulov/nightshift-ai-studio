"""Migration 0250, in a real database: sellable_models knows `music`, so a music model the owner opened is listed, quoted, held, claimed
and failed over like any other, and nothing else changes.

Before 0250, sellable_models (0192's body) raised 22023 "unknown capability music". route_model catches that as "no candidates", so a
routed music quote answered no_model_available with a model on sale; reroute_creative_job (the worker's failover, 0208) does not catch
it, so a routed music job's failover raised in the worker. The exact path never asks sellable_models and was already sold.

The lab plays the owner, a member, the worker and every API role on lab-only music models: `lab-lyria` has Lyria 3.5's shape (Google,
both country lists from the registry file, a terms gate the owner clears, per-request pricing, web_only), so 0230's gate and 0238's
CHECK apply to it; `lab-song-a` and `lab-song-b` are plain per-request models (no country list) for the router and the failover. The
real google-lyria-3.5 entry is untouched: its entitlement and its adults-only mark are other files' gates (0156, 0192), left out here.

What would break, and which test says so:
  0250 is not the live body                                                  test_the_live_body_is_0250s
  music raises, or lists something, while nothing is on sale                 test_music_is_known_and_empty_while_nothing_is_sellable
  a lit music model is not listed, or reaches the API / MCP (web_only)       test_a_lit_music_model_is_listed_on_the_web_only
  a music quote, hold or worker claim fails                                  test_a_music_job_is_quoted_held_and_claimed
  a routed music quote finds no model, a failover raises                     test_a_routed_music_job_is_routed_and_failed_over
  without 0250 the failover raises 22023 (the red half of the proof)         test_without_0250_the_failover_raises_and_the_route_finds_nothing
  the API answers music as an unknown capability                             test_the_api_answers_music_as_not_sold_there
  video_music or video_character_swap become known anywhere                  test_video_music_and_character_swap_stay_unknown
  the rollback does not restore 0192's body byte for byte, or a drift passes  test_rollback_and_replay, test_the_guards_refuse_a_drifted_body
  the lab chain leaves 0250 on under a replay of 0192                         test_the_lab_chain_takes_0250_off_with_0192
  a backslash in the files (the live apply path rewrites them)               test_the_files_carry_no_backslash

Runs in its own scratch database (it commits). Nothing calls a provider.
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

ORG = "aaaaaaaa-0000-0000-0000-000000000250"
U_A = str(uuid.UUID(int=0x250A))
U_OWN = str(uuid.UUID(int=0x250F))
#: A lab-only key (never a real one).
KEY = "lab-only-geo-claim-key-0250-not-a-secret-xxxxxxxx"
SONG = {"prompt": "a calm solo piano piece"}
SM = "public.sellable_models(text, text)"
OK = "public.api_creative_model_ok(text, text)"
GATE = "terms_review_required"

REGISTRY = {m["id"]: m for m in json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
LYRIA_FILE = REGISTRY["google-lyria-3.5"]
LYRIA, SONG_A, SONG_B = "lab-lyria", "lab-song-a", "lab-song-b"
#: id -> (provider, credits per request, extra spec)
MODELS = {
    LYRIA: ("google", 8, {"blocked_countries": LYRIA_FILE["blocked_countries"],
                          "available_countries": LYRIA_FILE["available_countries"], "terms_gate": GATE}),
    SONG_A: ("acme", 3, {}),
    # The same price as lab-song-a: a failover never moves a job to a model dearer than its hold (BR-L-020).
    SONG_B: ("acme", 3, {}),
}
UNKNOWN = ("video_music", "video_character_swap")


def unit_of(mid):
    return "model_" + mid.replace("-", "_") + "_request"


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


def as_role(c, role, uid=None, headers=None):
    """Inside the caller's open transaction: become `role` (PostgREST's claims) for the rest of it."""
    c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
    if headers is not None:
        c.execute("select set_config('request.headers', %s, true)", [json.dumps(headers)])
    c.execute(f"set local role {role}")


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
                as_role(c, role, uid, headers)
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
    name = f"ns_music250_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io'), (%s,'own@x.io')", [U_A, U_OWN])
    d.su("insert into public.organizations (id, name, slug) values (%s,'M','org-music-0250')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner')", [ORG, U_A])
    d.su("insert into public.app_members (user_id, email, role) values (%s,'own@x.io','owner')", [U_OWN])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    d.su("select vault.create_secret(%s, 'nightshift_geo_claim_key', 'lab')", [KEY])
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": "audio.lab", "capabilities": ["music"],
             "credit_unit": unit_of(m), "entitlement": "any",
             "spec": {"vendor_model": "lab-" + m, "output": "audio", "durations_s": [], "api_exposure": "web_only",
                      "limits": {"max_prompt_chars": 2000, "max_concurrent_per_org": 5},
                      "pricing": {"unit": "request", "provider_usd_per_unit": 0.08, "confirmed": False}, **extra}}
            for m, (prov, _, extra) in MODELS.items()]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    # The owner clears the reviewed gate (0227), as the profile's checkbox does; a probe passes; the model goes on sale; a price.
    d.act("authenticated", U_OWN, "select public.owner_accept_model_terms(%s, %s, %s)", [LYRIA, GATE, LYRIA])
    for m in MODELS:
        d.su("select public.record_model_probe(%s, 'audio.lab', %s, 'music', true, null, null, 10, 100, 'security-lab')", [m, "lab-" + m])
    d.su("update public.model_registry set availability = 'ga' where id = %s", [LYRIA])   # 0238: both lists, so it may
    d.su("update public.model_registry set availability = 'beta' where id in (%s, %s)", [SONG_A, SONG_B])
    prices = ", ".join(f"('{unit_of(m)}', {r}, 0)" for m, (_, r, _) in MODELS.items())
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {prices}, ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def raised(fn):
    """The SQLSTATE and the first line of the error, with creative_refuse's DETAIL (the sentence)."""
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, f"{str(e.value).splitlines()[0]} {e.value.diag.message_detail or ''}"


def listed(c, cap, surface):
    return sorted(r[0] for r in c.execute("select id from public.sellable_models(%s, %s)", [cap, surface]).fetchall())


_n = [0]


def drain(db, worker):
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id = %s and status = 'running'", [worker]):
        db.act("service_role", None, "select public.finish_creative_job(%s, %s, false, null, null, 'test_drain', 'drained')",
               [jid, worker])


def routed_job(db, worker):
    """A cheap-mode music job, routed and claimed by `worker` (running, no vendor task yet)."""
    _n[0] += 1
    route = db.act("authenticated", U_A, "select public.quote_creative_route(%s, 'music', 'cheap', %s::jsonb)",
                   [ORG, json.dumps(SONG)])[0][0]
    assert route["model"] == SONG_A, route
    job = db.act("authenticated", U_A, "select public.create_creative_job(%s::uuid, 'music', %s, %s::jsonb, 'cheap', %s, %s::numeric)",
                 [ORG, route["model"], json.dumps(SONG), f"m250-r{_n[0]}", route["credits"]])[0][0]["job"]
    got = db.act("service_role", None, "select id::text from public.claim_creative_job(%s)", [worker])
    assert got and got[0][0] == job["id"], got
    return job["id"]


def test_the_live_body_is_0250s(db):
    with psycopg.connect(db.dsn) as c:
        assert sec_db.cut_md5(c, SM) == sec_db.SELLABLE_MODELS_0250
        assert sec_db.has_0250(c)


def test_music_is_known_and_empty_while_nothing_is_sellable(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("update public.model_registry set availability = 'hidden' where 'music' = any (capabilities)")
        for role, uid in (("authenticated", U_A), ("service_role", None)):
            c.execute("savepoint s")
            as_role(c, role, uid)
            for surface in ("web", "api", "mcp"):
                assert listed(c, "music", surface) == [], (role, surface)
            c.execute("rollback to savepoint s")
        c.rollback()


def test_a_lit_music_model_is_listed_on_the_web_only(db):
    for role, uid in (("authenticated", U_A), ("service_role", None)):
        with psycopg.connect(db.dsn, autocommit=False) as c:
            as_role(c, role, uid)
            assert listed(c, "music", "web") == sorted(MODELS), role
            assert set(MODELS) <= set(listed(c, None, "web")), role
            # web_only, as Lyria's entry: never the developer API, never a connected assistant.
            assert listed(c, "music", "api") == [] and listed(c, "music", "mcp") == [], role
            c.rollback()


def test_a_music_job_is_quoted_held_and_claimed(db):
    q = db.act("authenticated", U_A, "select public.quote_creative_job(%s, 'music', %s, %s::jsonb)", [ORG, LYRIA, json.dumps(SONG)])[0][0]
    assert (float(q["credits"]), float(q["quantity"]), q["unit"]) == (8.0, 1.0, unit_of(LYRIA)), q
    before = db.su("select balance::float, reserved::float from public.credit_accounts where org_id = %s", [ORG])[0]
    # 0230 / 0238: a country-listed model runs only on a signed claim from its vendor's allow-list.
    assert "UZ" in LYRIA_FILE["available_countries"]
    st, msg = raised(lambda: db.act("authenticated", U_A,
                                    "select public.create_creative_job(%s, 'music', %s, %s::jsonb, 'exact', 'm250-nogeo', 8)",
                                    [ORG, LYRIA, json.dumps(SONG)]))
    assert st == "NS400" and "country_unverified" in msg, (st, msg)
    out = db.act("authenticated", U_A, "select public.create_creative_job(%s, 'music', %s, %s::jsonb, 'exact', 'm250-exact', 8)",
                 [ORG, LYRIA, json.dumps(SONG)], headers={"x-nightshift-geo": sign("UZ")})[0][0]
    jid = out["job"]["id"]
    held = db.su("select r.amount::float, r.status from public.credit_reservations r "
                 "join public.creative_jobs j on j.credit_ref = r.job_id where j.id = %s", [jid])
    assert held == [(8.0, "open")], held
    after = db.su("select balance::float, reserved::float from public.credit_accounts where org_id = %s", [ORG])[0]
    assert after == (before[0], before[1] + 8.0), (before, after)
    got = db.act("service_role", None, "select id::text, capability, routed_model, status from public.claim_creative_job('m250-w1')")
    assert got == [(jid, "music", LYRIA, "running")], got
    drain(db, "m250-w1")
    assert db.su("select r.status from public.credit_reservations r join public.creative_jobs j on j.credit_ref = r.job_id "
                 "where j.id = %s", [jid]) == [("released",)]


def test_a_routed_music_job_is_routed_and_failed_over(db):
    jid = routed_job(db, "m250-w2")
    try:
        moved = db.act("service_role", None, "select public.reroute_creative_job(%s, 'm250-w2', 'unreachable')", [jid])[0][0]
        # The next candidate; lab-lyria (dearer than the hold, and refused a job with no visitor's country) is never reached.
        assert moved and moved["model"] == SONG_B and float(moved["credits"]) == 3.0, moved
        assert db.su("select routed_model, fallback_from from public.creative_jobs where id = %s", [jid]) == [(SONG_B, SONG_A)]
    finally:
        drain(db, "m250-w2")


def test_without_0250_the_failover_raises_and_the_route_finds_nothing(db):
    """Red then green: 0192's body (the rollback) brings back the finding; 0250 again takes it away."""
    jid = routed_job(db, "m250-w3")
    try:
        with psycopg.connect(db.dsn, autocommit=False) as c:
            sec_db.rollback_0250_on_sale(c)                              # the rollback refuses while music is on sale
            assert sec_db.cut_md5(c, SM) == sec_db.SELLABLE_MODELS_0192
            c.execute("savepoint s")
            as_role(c, "service_role")
            st, msg = raised(lambda: c.execute("select public.reroute_creative_job(%s, 'm250-w3', 'unreachable')", [jid]))
            assert (st, msg.split(" ")[:3]) == ("22023", ["unknown", "capability", "music"]), (st, msg)
            c.execute("rollback to savepoint s")
            as_role(c, "authenticated", U_A)
            st, msg = raised(lambda: c.execute("select public.quote_creative_route(%s, 'music', 'cheap', %s::jsonb)",
                                               [ORG, json.dumps(SONG)]))
            assert st == "NS400" and "no_model_available" in msg, (st, msg)
            c.execute("rollback to savepoint s")
            c.rollback()
        # Green: the same job, on 0250's body, fails over.
        moved = db.act("service_role", None, "select public.reroute_creative_job(%s, 'm250-w3', 'unreachable')", [jid])[0][0]
        assert moved and moved["model"] == SONG_B, moved
    finally:
        drain(db, "m250-w3")


def test_the_api_answers_music_as_not_sold_there(db):
    assert db.su("select public.api_creative_model_ok('music', %s)", [LYRIA]) == [(False,)]
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.rollback_0250_on_sale(c)
        st, msg = raised(lambda: c.execute("select public.api_creative_model_ok('music', %s)", [LYRIA]))
        assert st == "22023" and "unknown capability music" in msg, (st, msg)
        c.rollback()


def test_video_music_and_character_swap_stay_unknown(db):
    for cap in UNKNOWN:
        for role, uid in (("authenticated", U_A), ("service_role", None)):
            for surface in ("web", "api", "mcp"):
                with psycopg.connect(db.dsn, autocommit=False) as c:
                    as_role(c, role, uid)
                    st, msg = raised(lambda: listed(c, cap, surface))
                    assert st == "22023" and f"unknown capability {cap}" in msg, (cap, role, surface, msg)
        assert db.su("select public.creative_capability_supported(%s)", [cap]) == [(False,)], cap
        st, msg = raised(lambda: db.act("authenticated", U_A, "select public.quote_creative_job(%s, %s, %s, %s::jsonb)",
                                        [ORG, cap, SONG_A, json.dumps(SONG)]))
        assert st == "NS400" and "capability_not_supported" in msg, (cap, msg)
        st, msg = raised(lambda: db.su("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, "
                                       "credit_unit) values ('lab-unknown', 'x', 'acme', 'audio.lab', array['music', %s], '{}', "
                                       "'model_lab_unknown')", [cap]))
        assert st == "23514" and "model_registry_capabilities_check" in msg, (cap, msg)
        st, msg = raised(lambda: db.su("select public.record_model_probe(%s, 'audio.lab', 'lab-lab-song-a', %s, true, null, null, 10, "
                                       "100, 'security-lab')", [SONG_A, cap]))
        assert st == "23514" and "model_probe_runs_capability_check" in msg, (cap, msg)


def _body_0192():
    """sellable_models' body as 0192's file writes it (the text between `as $$` and `$$;` of its section 7)."""
    text = (sec_db.MIGRATIONS / "0192_adult_attestation.sql").read_text(encoding="utf-8")
    m = re.search(r"create or replace function public\.sellable_models\(.*?as \$\$(.*?)\$\$;", text, re.S)
    return m.group(1)


def _body_0188_ok():
    """api_creative_model_ok's body as 0188's file writes it."""
    text = (sec_db.MIGRATIONS / "0188_recraft_web_mcp.sql").read_text(encoding="utf-8")
    return re.search(r"create or replace function public\.api_creative_model_ok\(.*?as \$\$(.*?)\$\$;", text, re.S).group(1)


def prosrc(c, sig=SM):
    return c.execute("select prosrc from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0]


def test_rollback_and_replay(db):
    mig = sec_db.MIGRATION_0250.read_text(encoding="utf-8")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        live, live_ok = prosrc(c), prosrc(c, OK)
        c.execute(mig)                                                   # a replay changes nothing
        assert (prosrc(c), prosrc(c, OK)) == (live, live_ok)
        c.execute("update public.model_registry set availability = 'hidden' where 'music' = any (capabilities)")
        c.execute(strip_tx(sec_db.ROLLBACK_0250))
        assert prosrc(c) == _body_0192()                                 # 0192's body, byte for byte
        assert prosrc(c, OK) == _body_0188_ok()                          # and 0188's api_creative_model_ok
        assert sec_db.cut_md5(c, SM) == sec_db.SELLABLE_MODELS_0192
        c.execute(strip_tx(sec_db.ROLLBACK_0250))                        # twice: harmless
        assert prosrc(c) == _body_0192()
        for role, want in (("anon", False), ("authenticated", True), ("service_role", True)):
            assert c.execute("select has_function_privilege(%s, %s, 'EXECUTE')", [role, SM]).fetchone()[0] is want, role
        c.execute(mig)
        assert (prosrc(c), prosrc(c, OK)) == (live, live_ok)
        c.rollback()


def test_the_rollback_refuses_while_a_music_model_is_on_sale(db):
    """Without 0250 a music model on sale is a dead end again (routed quotes find nothing, the failover raises 22023): the rollback
    names the models and changes nothing until they are off sale."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        live = prosrc(c)
        st, msg = raised(lambda: c.execute(strip_tx(sec_db.ROLLBACK_0250)))
        assert "rollback 0250: these music models are on sale" in msg, msg
        for m, level in ((LYRIA, "ga"), (SONG_A, "beta"), (SONG_B, "beta")):
            assert f"{m} ({level})" in msg, msg
        c.rollback()
    with psycopg.connect(db.dsn) as c:
        assert prosrc(c) == live and sec_db.has_0250(c)


def test_the_rollback_names_routed_music_jobs_still_in_flight(db):
    """The emergency order is: hide music, then revert (no force switch). A routed music job already running would hit the 22023 in
    its failover after the revert, so the rollback names it in a NOTICE instead of letting it fail unannounced."""
    jid = routed_job(db, "m250-w5")
    try:
        with psycopg.connect(db.dsn, autocommit=False) as c:
            notices = []
            c.add_notice_handler(lambda d: notices.append(d.message_primary or ""))
            sec_db.rollback_0250_on_sale(c)
            text = " ".join(notices)
            assert "routed music jobs still in flight" in text and jid in text, notices
            c.rollback()
    finally:
        drain(db, "m250-w5")


def test_the_guards_refuse_a_drifted_body(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        live = prosrc(c)
        drifted = live.replace("'music') then", "'music', 'video_music') then", 1)
        assert drifted != live
        c.execute("create or replace function public.sellable_models(p_capability text default null, p_surface text default 'web') "
                  "returns table (id text, display_name text, provider text, capabilities text[], availability text, "
                  "verified_at timestamptz, credit_unit text, entitlement text, credits_per_unit numeric, margin numeric, spec jsonb) "
                  "language plpgsql stable security definer set search_path = public, pg_temp as $body$" + drifted + "$body$")
        c.execute("savepoint s")
        st, msg = raised(lambda: c.execute(sec_db.MIGRATION_0250.read_text(encoding="utf-8")))
        assert "0250 found a sellable_models() that is neither 0192's body nor 0250's" in msg, msg
        c.execute("rollback to savepoint s")
        st, msg = raised(lambda: c.execute(strip_tx(sec_db.ROLLBACK_0250)))
        assert "rollback 0250: sellable_models() is neither 0250's body nor 0192's" in msg, msg
        c.execute("rollback to savepoint s")
        assert prosrc(c) == drifted                                      # nothing of either refused file was written
        c.rollback()


@pytest.fixture(scope="module")
def bare():
    """The full chain and no row naming music: the lab chain goes through 0228's rollback, which refuses while a row names music
    (probe results are append-only, so the main database here can never drop the value again)."""
    admin = sec_db.admin_dsn()
    if not admin:
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_music250_bare_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def test_the_lab_chain_takes_0250_off_with_0192(bare):
    for name in ("ON_0139", "ON_0125", "ON_0124"):
        seq = list(getattr(sec_db, name))
        assert seq.index("0192_adult_attestation.sql") < seq.index(sec_db.MIGRATION_0250.name), name
        assert seq[-1] == "0238_country_list_sale_needs_allow_list.sql", name
    with psycopg.connect(bare.dsn, autocommit=False) as c:
        sec_db.take_off_0192(c)                                          # 0250 first, then 0192's rollback
        assert not sec_db.has_0250(c) and not sec_db.has_0192(c)
        sec_db.put_back_0192(c)                                          # 0192, the files on it, then 0250 again
        assert sec_db.has_0192(c) and sec_db.has_0250(c)
        c.rollback()


def test_the_files_carry_no_backslash():
    for f in (sec_db.MIGRATION_0250, sec_db.ROLLBACK_0250):
        assert chr(92) not in f.read_text(encoding="utf-8"), f.name
