"""Migration 0228, in a real database: the database knows `music`, and a model priced per request (Google Lyria 3.5, "per song") is
quoted for one request with no duration. Nothing goes on sale: 0228 seeds no price.

The lab plays the owner, a member and every API role on synthetic models (the real google-lyria-3.5 entry stays registry-only in the
code until 0228 is confirmed live, so the sync never writes it).

What would break, and which test says so:
  a per-request music model is asked a duration it has no field for, or billed by the second   test_a_per_request_music_model_*
  a per-second music model is quoted with no duration, or by the wrong quantity                test_a_per_second_music_model_*
  a per-request model with no price is sold, or quoted at 0                                    test_an_unpriced_per_request_model_is_refused
  any other capability loses its duration rule                                                 test_every_other_timed_capability_still_needs_a_duration
  a registry row or a probe result cannot name music                                           test_the_registry_and_the_probe_log_take_music
  a member calls the pricing functions directly                                                test_no_api_role_can_call_the_pricing_functions
  0228 lands on a body it was not written on (0218's alone, without 0224)                      test_the_guard_refuses_a_creative_price_without_0224
  the rollback or a replay changes what it should not                                         test_rollback_and_replay
  the rollback drops a value rows still use, or deletes them                                   test_rollback_refuses_while_a_row_names_music
  a backslash in the file (the live apply path rewrites them)                                  test_the_files_carry_no_backslash

Runs in its own scratch database (it commits).
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG = "aaaaaaaa-0000-0000-0000-000000000228"
U_A = str(uuid.UUID(int=0x228A))
SONG = {"prompt": "a calm solo piano piece"}
CP = "public.creative_price(uuid,text,text,jsonb)"
PP = "public.creative_params_problem(text,jsonb)"

#: id -> (registry pricing unit, credit unit, durations_s, credits per unit or None = unpriced)
MODELS = {
    "song-req": ("request", "model_song_req_request", [], 8),
    "song-req-free": ("request", "model_song_req_free_request", [], None),
    "song-sec": ("second", "model_song_sec_second", [10, 30], 0.5),
}


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


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_music_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io')", [U_A])
    d.su("insert into public.organizations (id, name, slug) values (%s,'M','org-music-0228')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner')", [ORG, U_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "audio.acme", "capabilities": ["music"], "credit_unit": cu,
             "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "audio", "durations_s": ds,
                      "limits": {"max_prompt_chars": 2000, "max_concurrent_per_org": 1},
                      "pricing": {"unit": unit, "provider_usd_per_unit": 0.08, "confirmed": False}}}
            for m, (unit, cu, ds, _) in MODELS.items()]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m in MODELS:
        d.su("select public.record_model_probe(%s, 'audio.acme', %s, 'music', true, null, null, 10, 100, 'security-lab')", [m, "acme-" + m])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    prices = [f"('{cu}', {r}, 0)" for (_, cu, _, r) in MODELS.values() if r is not None]
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {', '.join(prices)}, ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(scope="module")
def bare():
    """The full chain and no row naming music: what the rollback needs (probe results are append-only, so a database that has
    recorded a music probe can never drop the value again; test_rollback_refuses_while_a_row_names_music shows that refusal)."""
    admin = sec_db.admin_dsn()
    if not admin:
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_music_bare_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def quote(db, model, params, cap="music"):
    return db.act("authenticated", U_A, "select public.quote_creative_job(%s,%s,%s,%s::jsonb)",
                  [ORG, cap, model, json.dumps(params)])[0][0]


def refused(fn):
    """The refusal's word and its detail (creative_refuse puts the sentence in DETAIL)."""
    with pytest.raises(psycopg.Error) as e:
        fn()
    return f"{str(e.value).splitlines()[0]} {e.value.diag.message_detail or ''}"


def md5(conn, sig):
    return conn.execute(f"select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = '{sig}'::regprocedure"
                        ).fetchone()[0]


def test_the_live_bodies_are_0228s(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        # 0243 sits on 0228's creative_price (two hunks in the preview rate): the chain ends there, and under it is 0228's body.
        assert (md5(c, PP), md5(c, CP)) == (sec_db.CREATIVE_PARAMS_PROBLEM_0228, sec_db.CREATIVE_PRICE_0243)
        sec_db.take_off_0243(c)
        assert (md5(c, PP), md5(c, CP)) == (sec_db.CREATIVE_PARAMS_PROBLEM_0228, sec_db.CREATIVE_PRICE_0228)
        c.rollback()


def test_a_per_request_music_model_is_quoted_for_one_request_with_no_duration(db):
    q = quote(db, "song-req", SONG)
    assert (float(q["quantity"]), float(q["credits"]), q["unit"]) == (1.0, 8.0, "model_song_req_request")


def test_a_per_request_music_model_refuses_a_duration_it_has_no_field_for(db):
    msg = refused(lambda: quote(db, "song-req", {**SONG, "duration_s": 30}))
    assert "does not offer a 30-second clip" in msg


def test_a_per_second_music_model_still_needs_its_duration_and_says_so(db):
    msg = refused(lambda: quote(db, "song-sec", SONG))
    assert "duration_s" in msg and "sold by the second" in msg


def test_a_per_second_music_model_is_quoted_by_its_seconds(db):
    q = quote(db, "song-sec", {**SONG, "duration_s": 10})
    assert (float(q["quantity"]), float(q["credits"])) == (10.0, 5.0)


def test_a_bad_duration_is_still_refused_for_music(db):
    assert "duration_s must be a whole number" in refused(lambda: quote(db, "song-sec", {**SONG, "duration_s": 0}))
    assert "duration_s must be a whole number" in refused(lambda: quote(db, "song-sec", {**SONG, "duration_s": "10"}))


def test_an_unpriced_per_request_model_is_refused(db):
    msg = refused(lambda: quote(db, "song-req-free", SONG))
    assert msg.startswith("unpriced") and "no credit price yet" in msg


def test_every_other_timed_capability_still_needs_a_duration(db):
    with psycopg.connect(db.dsn) as c:
        for cap in ("t2v", "sfx", "i2v"):
            assert "duration_s must be a whole number" in c.execute(
                "select public.creative_params_problem(%s, %s::jsonb)", [cap, json.dumps({"prompt": "x"})]).fetchone()[0], cap
        assert c.execute("select public.creative_params_problem('music', %s::jsonb)", [json.dumps(SONG)]).fetchone()[0] is None


def test_the_registry_and_the_probe_log_take_music(db):
    assert db.su("select count(*) from public.model_registry where 'music' = any (capabilities)")[0][0] == len(MODELS)
    assert db.su("select count(*) from public.model_probe_runs where capability = 'music'")[0][0] >= len(MODELS)
    # Only the one value was added: a capability nobody knows is still refused.
    with pytest.raises(psycopg.Error):
        db.su("insert into public.model_probe_runs (model_id, adapter, vendor_model, capability, ok, run_by) "
              "values ('song-req', 'audio.acme', 'acme-song-req', 'video_music', true, 'lab')")


def test_no_api_role_can_call_the_pricing_functions(db):
    for role in ("anon", "authenticated", "service_role"):
        for sig in (CP, PP):
            assert db.su(f"select has_function_privilege('{role}', '{sig}', 'EXECUTE')")[0][0] is False, (role, sig)


def test_the_guard_refuses_a_creative_price_without_0224(bare):
    mig = sec_db.MIGRATION_0228.read_text(encoding="utf-8")
    with psycopg.connect(bare.dsn, autocommit=False) as c:
        sec_db.take_off_0228(c)
        sec_db.take_off_0224(c)
        assert md5(c, CP) == sec_db.CREATIVE_PRICE_0218
        with pytest.raises(psycopg.Error) as e:
            c.execute(mig)
        assert "0224" in str(e.value) and "apply them first" in str(e.value)
        c.rollback()


def test_rollback_refuses_while_a_row_names_music(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0243(c)                                          # 0243 sits on 0228's creative_price: off first
        c.execute(sec_db.MIGRATION_0228.read_text(encoding="utf-8"))  # a replay changes nothing
        assert (md5(c, PP), md5(c, CP)) == (sec_db.CREATIVE_PARAMS_PROBLEM_0228, sec_db.CREATIVE_PRICE_0228)
        with pytest.raises(psycopg.Error) as e:                          # nothing is deleted on the owner's behalf
            c.execute(sec_db.rollback_0228_body())
        assert "names music" in str(e.value)
        c.rollback()
    assert float(quote(db, "song-req", SONG)["credits"]) == 8.0


def test_rollback_and_replay(bare):
    mig = sec_db.MIGRATION_0228.read_text(encoding="utf-8")
    check = ("select position('''music''' in pg_get_constraintdef((select oid from pg_constraint "
             "where conname = 'model_registry_capabilities_check')))")
    with psycopg.connect(bare.dsn, autocommit=False) as c:
        sec_db.take_off_0243(c)                                          # 0243 sits on 0228's creative_price: off first
        c.execute(mig)                                                   # a replay changes nothing
        assert (md5(c, PP), md5(c, CP)) == (sec_db.CREATIVE_PARAMS_PROBLEM_0228, sec_db.CREATIVE_PRICE_0228)
        c.execute(sec_db.rollback_0228_body())
        assert (md5(c, PP), md5(c, CP)) == (sec_db.CREATIVE_PARAMS_PROBLEM_0218, sec_db.CREATIVE_PRICE_0224)
        assert c.execute(check).fetchone()[0] == 0
        c.execute(sec_db.rollback_0228_body())                           # twice: harmless
        assert (md5(c, PP), md5(c, CP)) == (sec_db.CREATIVE_PARAMS_PROBLEM_0218, sec_db.CREATIVE_PRICE_0224)
        sec_db.put_back_0228(c)                                          # 0228, and 0243 on it again
        assert (md5(c, PP), md5(c, CP)) == (sec_db.CREATIVE_PARAMS_PROBLEM_0228, sec_db.CREATIVE_PRICE_0243)
        assert c.execute(check).fetchone()[0] > 0
        sec_db.take_off_0218(c)                                          # the chain: 0243, 0228, 0224, then 0218 come off
        assert md5(c, CP) == sec_db.CREATIVE_PRICE_0208
        sec_db.put_back_0218(c)                                          # and back on, 0228 then 0243 last
        assert md5(c, CP) == sec_db.CREATIVE_PRICE_0243
        c.rollback()


def test_the_lab_lists_put_0228_back_after_0224():
    for name in ("ON_0156", "ON_0139", "ON_0125", "ON_0124"):
        seq = list(getattr(sec_db, name))
        assert "0228_music_per_request_price.sql" in seq, name
        assert seq.index("0224_dated_credit_price.sql") < seq.index("0228_music_per_request_price.sql"), name


def test_the_files_carry_no_backslash():
    for f in (sec_db.MIGRATION_0228, sec_db.ROLLBACK_0228):
        assert chr(92) not in f.read_text(encoding="utf-8"), f.name
