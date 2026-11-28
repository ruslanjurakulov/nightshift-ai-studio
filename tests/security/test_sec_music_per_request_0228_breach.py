"""Breach on migration 0228 (music per request): a member, a stranger and every API role against the new per-request quantity and the
duration-free music rule, on synthetic models in a scratch database (no real vendor, no real key).

0228's own contract tests are in test_sec_music_per_request_0228.py; this file is the attack. It holds what the lab could not break
(the registry spec is not a member's to write, params cannot name a unit, a per-second music model refuses a missing duration on
every door, a dark model stays dark, the grants and the other capabilities' quotes are 0224's) and it keeps, as FAILING tests, what
it could:

  BR-0228-01  the per-request override is not scoped to music, and it runs before the longest-input checks: a video op the
              registry prices per request is quoted (and so held and queued) for a source longer than the vendor takes
              (test_a_per_request_video_op_still_refuses_a_source_longer_than_the_model_takes)
  BR-0228-02  the same override quotes a region edit on a per-request edit model as ONE request: the worker makes one vendor
              call per region, and finish_creative_job then fails the job region_quote_mismatch and charges nothing
              (test_a_per_request_region_edit_is_quoted_for_every_region)

Both are latent: no model on sale today is priced per request on those capabilities (schemas/model_registry.json: only three
describe models and google-lyria-3.5). One registry entry would open them, and 0228's header says no quote can change.

Runs in its own scratch databases (they commit).
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG = "aaaaaaaa-0000-0000-0000-00000000b228"
ORG_B = "bbbbbbbb-0000-0000-0000-00000000b228"
U_A = str(uuid.UUID(int=0xB228A))   # an editor (a normal member) of ORG
U_B = str(uuid.UUID(int=0xB228B))   # owner of ORG_B only
VID_LONG = "cccccccc-0000-0000-0000-00000000b228"   # 600 s video of ORG
VID_SHORT = "cccccccc-0000-0000-0000-00000000b229"  # 8 s video of ORG
IMG = "cccccccc-0000-0000-0000-00000000b230"        # a picture of ORG
SONG = {"prompt": "a calm solo piano piece"}
CP = "public.creative_price(uuid,text,text,jsonb)"
PP = "public.creative_params_problem(text,jsonb)"


def _row(mid, caps, unit, extra=None, cu=None):
    spec = {"vendor_model": "acme-" + mid, "output": "audio" if "music" in caps else "image",
            "limits": {"max_prompt_chars": 2000, "max_concurrent_per_org": 1},
            "pricing": {"unit": unit, "provider_usd_per_unit": 0.08, "confirmed": False}}
    spec.update(extra or {})
    return {"id": mid, "display_name": mid, "provider": "acme", "adapter": "audio.acme", "capabilities": caps,
            "credit_unit": cu or f"model_{mid.replace('-', '_')}_{unit}", "entitlement": "any", "spec": spec}


#: id -> (row, on sale?, credits per unit or None)
MUSIC = {
    "bsong-req": (_row("bsong-req", ["music"], "request", {"durations_s": []}), True, 8),
    "bsong-sec": (_row("bsong-sec", ["music"], "second", {"durations_s": [10, 30]}), True, 0.5),
    "bsong-dark": (_row("bsong-dark", ["music"], "request", {"durations_s": []}), False, 8),
    "bsong-preview": (_row("bsong-preview", ["music"], "request", {"durations_s": [], "operator_preview": True}), False, None),
    "bsong-past": (_row("bsong-past", ["music"], "request", {"durations_s": [], "shutdown": {"on": "2026-01-01"}}), True, 8),
}
VIDEO_OPS = {
    "bvup-req": (_row("bvup-req", ["video_upscale"], "request",
                      {"upscale_targets": ["720p"], "limits": {"max_source_seconds": 10, "max_prompt_chars": 0}}), True, 50),
    "bvup-sec": (_row("bvup-sec", ["video_upscale"], "second",
                      {"upscale_targets": ["720p"], "limits": {"max_source_seconds": 10, "max_prompt_chars": 0}}), True, 2),
    "bvedit-req": (_row("bvedit-req", ["video_edit"], "request",
                        {"limits": {"max_source_seconds": 10, "max_prompt_chars": 500}}), True, 50),
    "bedit-req": (_row("bedit-req", ["edit"], "request", {"aspect_ratios": []}), True, 4),
}
#: The other capabilities, priced the ways the registry prices them today (never per request except describe).
OTHERS = {
    "bt2i": (_row("bt2i", ["t2i"], "image", {"aspect_ratios": ["1:1"]}), True, 3),
    "bt2v": (_row("bt2v", ["t2v"], "second", {"durations_s": [5, 10], "aspect_ratios": ["16:9"]}), True, 7),
    "bi2v": (_row("bi2v", ["i2v"], "second", {"durations_s": [5]}), True, 9),
    "bsfx": (_row("bsfx", ["sfx"], "second", {"durations_s": [5, 10]}), True, 1),
    "btts": (_row("btts", ["tts"], "character"), True, 0.01),
    "bdescribe": (_row("bdescribe", ["describe"], "request"), True, 2),
    "bupscale": (_row("bupscale", ["upscale"], "image", {"upscale_factors": [2, 4]}), True, 5),
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


def _seed(d, models):
    d.su("insert into auth.users (id, email) values (%s,'a@b228.io'), (%s,'b@b228.io') on conflict do nothing", [U_A, U_B])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-b228-a'), (%s,'B','org-b228-b') on conflict do nothing",
         [ORG, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@b228.io','editor'), "
         "(%s,%s,'b@b228.io','owner') on conflict do nothing", [ORG, U_A, ORG_B, U_B])
    d.su("select public.grant_credits(%s, 5000, 'lab')", [ORG])
    d.su("select public.grant_credits(%s, 5000, 'lab')", [ORG_B])
    d.su("insert into public.media_assets (id, org_id, kind, mime, bytes, sha256, source, duration_s) values "
         "(%s,%s,'video','video/mp4',1000000,repeat('a',64),'upload',600), "
         "(%s,%s,'video','video/mp4',1000000,repeat('b',64),'upload',8) on conflict do nothing", [VID_LONG, ORG, VID_SHORT, ORG])
    d.su("insert into public.media_assets (id, org_id, kind, mime, bytes, sha256, source, width, height) values "
         "(%s,%s,'image','image/png',1000,repeat('c',64),'upload',1024,1024) on conflict do nothing", [IMG, ORG])
    rows = [r for (r, _, _) in models.values()]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for mid, (r, on_sale, _) in models.items():
        d.su("select public.record_model_probe(%s, 'audio.acme', %s, %s, true, null, null, 10, 100, 'security-lab')",
             [mid, "acme-" + mid, r["capabilities"][0]])
        if on_sale:
            d.su("update public.model_registry set availability='beta' where id=%s", [mid])
    prices = [f"('{r['credit_unit']}', {p}, 0)" for (r, _, p) in models.values() if p is not None]
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {', '.join(prices)}, ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin")


def _db(prefix, models):
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"{prefix}_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    _seed(d, models)
    return admin, name, d


@pytest.fixture(scope="module")
def db():
    admin, name, d = _db("ns_b228", {**MUSIC, **VIDEO_OPS, **OTHERS})
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(scope="module")
def plain():
    """No row names music, so 0228's rollback can run inside a transaction: the same quotes on 0224's bodies and on 0228's."""
    admin, name, d = _db("ns_b228_plain", {**VIDEO_OPS, **OTHERS})
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def quote(db, model, params, cap="music", uid=U_A, org=ORG):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,%s,%s,%s::jsonb)",
                  [org, cap, model, json.dumps(params)])[0][0]


def refused(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return f"{str(e.value).splitlines()[0]} {e.value.diag.message_detail or ''}"


# ── 1. quantity 1 through a role, a registry row or params ───────────────────


def test_a_member_cannot_write_the_registry_spec_or_the_unit(db):
    for sql in ("update public.model_registry set spec = jsonb_set(spec, '{pricing,unit}', '\"request\"') where id = 'bsong-sec'",
                "update public.model_registry set credit_unit = 'model_bsong_req_request' where id = 'bsong-sec'",
                "insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                "values ('x','x','acme','audio.acme','{music}','{\"pricing\":{\"unit\":\"request\"}}','model_bsong_req_request','any')"):
        try:
            db.act("authenticated", U_A, sql)
        except psycopg.Error:
            pass  # refused outright, or (credit_unit, a column admins may write) filtered to no row by RLS: either way
    # No row changed, whatever PostgREST answered.
    assert db.su("select spec #>> '{pricing,unit}', credit_unit from public.model_registry where id = 'bsong-sec'")[0] == \
        ("second", "model_bsong_sec_second")


def test_a_member_cannot_reach_the_sync_or_the_probe_recorder(db):
    row = json.dumps([MUSIC["bsong-sec"][0] | {"spec": {**MUSIC["bsong-sec"][0]["spec"], "pricing": {"unit": "request"}}}])
    for role, uid in (("authenticated", U_A), ("anon", None)):
        with pytest.raises(psycopg.Error):
            db.act(role, uid, "select public.sync_model_registry(%s::jsonb)", [row])


def test_params_cannot_name_a_unit_or_a_quantity(db):
    for extra in ({"pricing": {"unit": "request"}}, {"unit": "request"}, {"quantity": 1}, {"credit_unit": "model_bsong_req_request"}):
        msg = refused(lambda: quote(db, "bsong-sec", {**SONG, "duration_s": 30, **extra}))
        assert msg.startswith("invalid_params") and "unknown parameter" in msg, extra


def test_a_per_second_t2v_is_still_quoted_by_its_seconds(db):
    q = quote(db, "bt2v", {"prompt": "a boat", "duration_s": 10}, cap="t2v")
    assert (float(q["quantity"]), float(q["credits"])) == (10.0, 70.0)


# ── 2. no duration on a per-second music model, on every door ───────────────


def test_a_per_second_music_model_refuses_no_duration_on_create(db):
    msg = refused(lambda: db.act("authenticated", U_A,
                                 "select public.create_creative_job(%s,'music','bsong-sec',%s::jsonb,'exact',%s,null)",
                                 [ORG, json.dumps(SONG), "k-" + uuid.uuid4().hex]))
    assert "sold by the second" in msg
    assert db.su("select count(*) from public.creative_jobs where coalesce(routed_model, requested_model) = 'bsong-sec'")[0][0] == 0


def test_a_routed_music_quote_never_lands_on_the_per_second_model_without_a_duration(db):
    # route_model tries every candidate; the per-second one refuses, so a route either names the per-request model or nothing.
    try:
        out = db.su("select public.route_model('music', %s::jsonb, 'cheap', %s, 'web')", [json.dumps(SONG), ORG])[0][0]
    except psycopg.Error as e:
        assert "bsong-sec" not in str(e)
        return
    assert (out or {}).get("model") != "bsong-sec"


def test_null_fractional_string_and_long_durations_are_refused_for_music_on_any_model(db):
    for model in ("bsong-req", "bsong-sec"):
        for d in (None, 1.5, "30", 61, 0, -1, True):
            assert "duration_s must be a whole number" in refused(lambda: quote(db, model, {**SONG, "duration_s": d})), (model, d)


# ── 3. a dark or registry-only model through the new paths ──────────────────


def test_dark_previewed_and_shut_down_music_models_are_not_sold(db):
    for model in ("bsong-dark", "bsong-preview", "bsong-past", "google-lyria-3.5", "sonilo-music"):
        msg = refused(lambda: quote(db, model, SONG))
        assert msg.startswith("model_not_sellable"), (model, msg)
        assert db.su("select count(*) from public.creative_jobs where coalesce(routed_model, requested_model) = %s", [model])[0][0] == 0


def test_a_terms_gated_music_model_cannot_be_put_on_sale(db):
    with pytest.raises(psycopg.Error):
        db.su("update public.model_registry set spec = spec || '{\"terms_gate\": \"terms_review_required\"}' where id = 'bsong-req'")
    assert quote(db, "bsong-req", SONG)["quantity"] == 1


def test_a_stranger_cannot_quote_or_create_in_another_org(db):
    for fn in (lambda: quote(db, "bsong-req", SONG, uid=U_B, org=ORG),
               lambda: db.act("authenticated", U_B, "select public.create_creative_job(%s,'music','bsong-req',%s::jsonb,'exact',%s,null)",
                              [ORG, json.dumps(SONG), "k-" + uuid.uuid4().hex])):
        assert "forbidden" in refused(fn)
    assert refused(lambda: db.act("anon", None, "select public.quote_creative_job(%s,'music','bsong-req',%s::jsonb)",
                                  [ORG, json.dumps(SONG)]))


# ── 6. the other capabilities ───────────────────────────────────────────────

MATRIX = [
    ("t2i", "bt2i", {"prompt": "a cat"}),
    ("t2v", "bt2v", {"prompt": "a boat", "duration_s": 10}),
    ("t2v", "bt2v", {"prompt": "a boat"}),
    ("i2v", "bi2v", {"source_asset_id": IMG, "duration_s": 5}),
    ("sfx", "bsfx", {"prompt": "rain", "duration_s": 5}),
    ("sfx", "bsfx", {"prompt": "rain"}),
    ("tts", "btts", {"prompt": "hello there, this is forty characters ok"}),
    ("describe", "bdescribe", {"source_asset_id": IMG}),
    ("upscale", "bupscale", {"source_asset_id": IMG, "factor": 4}),
    ("video_upscale", "bvup-sec", {"source_asset_id": VID_SHORT, "target_resolution": "720p"}),
    ("video_upscale", "bvup-sec", {"source_asset_id": VID_LONG, "target_resolution": "720p"}),
]


def _quote_or_refusal(c, cap, model, params):
    c.execute("savepoint q")
    try:
        out = c.execute("select public.creative_price(%s,%s,%s,%s::jsonb)", [ORG, cap, model, json.dumps(params)]).fetchone()[0]
        c.execute("release savepoint q")
        return ("quote", out)
    except psycopg.Error as e:
        c.execute("rollback to savepoint q")
        return ("refused", e.diag.sqlstate, e.diag.message_primary, e.diag.message_detail)


def _attrs(c):
    return c.execute("select p.oid::regprocedure::text, p.proowner, p.prosecdef, p.provolatile, p.proconfig, p.proacl::text "
                     "from pg_proc p where p.oid in (%s::regprocedure, %s::regprocedure) order by 1", [CP, PP]).fetchall()


def test_every_other_capability_quotes_and_refuses_exactly_as_on_0224(plain):
    with psycopg.connect(plain.dsn, autocommit=False) as c:
        on_0228 = [_quote_or_refusal(c, *m) for m in MATRIX]
        attrs_0228 = _attrs(c)
        c.execute(sec_db.rollback_0228_body())
        assert c.execute(f"select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = '{CP}'::regprocedure"
                         ).fetchone()[0] == sec_db.CREATIVE_PRICE_0224
        on_0224 = [_quote_or_refusal(c, *m) for m in MATRIX]
        attrs_0224 = _attrs(c)
        c.rollback()
    assert any(r[0] == "quote" for r in on_0228)
    for m, a, b in zip(MATRIX, on_0224, on_0228):
        assert a == b, m
    # Owner, security definer, volatility, search_path and the ACL are 0224's, byte for byte.
    assert attrs_0224 == attrs_0228


# ── 7. who can call the replaced functions ──────────────────────────────────


def test_no_api_role_and_no_public_grant_reaches_the_replaced_functions(db):
    for sig in (CP, PP):
        acl = db.su(f"select coalesce(proacl::text, '') from pg_proc where oid = '{sig}'::regprocedure")[0][0]
        assert acl == "{postgres=X/postgres}", (sig, acl)   # the owner only: no PUBLIC (an empty grantee), no API role
        for role in ("anon", "authenticated", "service_role"):
            with pytest.raises(psycopg.Error):
                db.act(role, U_A if role == "authenticated" else None,
                       f"select {'public.creative_price(%s,%s,%s,%s::jsonb)' if sig == CP else 'public.creative_params_problem(%s,%s::jsonb)'}",
                       [ORG, "music", "bsong-req", json.dumps(SONG)] if sig == CP else ["music", json.dumps(SONG)])


# ── 4. the md5 guard ────────────────────────────────────────────────────────


def test_0228_refuses_a_tampered_body_and_writes_nothing(db):
    mig = sec_db.MIGRATION_0228.read_text(encoding="utf-8")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        src = c.execute(f"select pg_get_functiondef('{CP}'::regprocedure)").fetchone()[0]
        # A tamper that would sell every quote for one unit, on 0228's own body: the replay must not accept it as its own.
        # (The line as 0228 writes it since BR-0228-01/02 scoped it to music; a replace that finds nothing would test nothing.)
        line = "if cap = 'music' and m_spec -> 'pricing' ->> 'unit' = 'request' then"
        assert line in src
        c.execute(src.replace(line, "if true then", 1))
        c.execute("savepoint s")
        with pytest.raises(psycopg.Error) as e:
            c.execute(mig)
        assert "neither 0218's with 0224's line nor 0228's" in str(e.value)
        c.execute("rollback to savepoint s")
        c.rollback()
    with psycopg.connect(db.dsn) as c:
        assert c.execute(f"select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = '{CP}'::regprocedure"
                         ).fetchone()[0] == sec_db.CREATIVE_PRICE_0228


def test_the_rollbacks_beneath_refuse_to_strip_0228(db):
    # 0224's rollback over 0228 would put back a creative_price without music's rule while 0218's params still let music through.
    with psycopg.connect(db.dsn, autocommit=False) as c:
        with pytest.raises(psycopg.Error) as e:
            c.execute(sec_db.rollback_0224_body())
        # After the #945 merge, sec_db's rollback_0224_body() runs 0228's rollback first, which refuses here while music rows exist;
        # 0224's own rollback refuses 0228's body by itself. Either way 0228 is not stripped.
        assert "a later file sits on 0224" in str(e.value) or "names music; take it out first" in str(e.value)
        c.rollback()


# ── the holes ───────────────────────────────────────────────────────────────


def test_a_per_request_video_op_still_refuses_a_source_longer_than_the_model_takes(db):
    """BR-0228-01. 0224 refused a 600 s video for a model whose limits.max_source_seconds is 10, before any hold (the vendor refuses it
    after the hold otherwise). 0228 sets qty := 1 for any per-request model BEFORE `if qty > longest`, so the check reads 1 > 10 and
    the over-long video is quoted, held and queued. Per-second twin for contrast: still refused."""
    assert "upscales videos of up to 10 seconds" in refused(
        lambda: quote(db, "bvup-sec", {"source_asset_id": VID_LONG, "target_resolution": "720p"}, cap="video_upscale"))
    for cap, model, params in (("video_upscale", "bvup-req", {"source_asset_id": VID_LONG, "target_resolution": "720p"}),
                               ("video_edit", "bvedit-req", {"source_asset_id": VID_LONG, "prompt": "make it night"})):
        msg = refused(lambda: quote(db, model, params, cap=cap))
        assert msg.startswith("source_unavailable") and "up to 10 seconds" in msg, (model, msg)


def test_a_per_request_region_edit_is_quoted_for_every_region(db):
    """BR-0228-02. A region edit is one model call per region (0126): creative_quantity = n, and finish_creative_job fails the job
    region_quote_mismatch, charging nothing, when the held quantity is not n. 0228 forces qty := 1 for a per-request edit model, so
    a 3-region edit is quoted for 1 request: the vendor is called three times and the organization is charged nothing."""
    regions = [{"id": f"r{i}", "name": f"region {i}", "rect": {"x": 0, "y": 0, "w": 64, "h": 64}, "prompt": "make it blue"}
               for i in range(3)]
    try:
        q = quote(db, "bedit-req", {"source_asset_id": IMG, "regions": regions}, cap="edit")
    except psycopg.Error:
        return  # refusing a per-request region edit outright is also a fix
    assert float(q["quantity"]) == 3.0, q
