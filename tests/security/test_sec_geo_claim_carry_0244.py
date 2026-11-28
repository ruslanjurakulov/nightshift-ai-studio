"""Migration 0244, attacked in a real database: a film take and a workflow step carry the country their start verified.

Before 0244 the country gate (0208, 0230) read only the visitor's own signed claim, so a Film Studio take (written by the worker) and a
workflow step made at a later advance (the worker's poll, another member's page) were refused country_unverified on every Google
model, after the start had held the money. 0244 reads the claim at the start, refuses there by name, records the country for that one
segment or run, and lets the gate accept it for that segment's takes and that run's steps only, until the start's own deadline.

What would break, and which test says so:
  a Google take or step started with a UZ claim is refused                      test_a_film_started_in_uz_*, test_a_workflow_started_in_uz_*
  a start with no claim, an RU claim, a forged or expired one holds money       test_*_start_with_no_claim_*, *_ru_*, *_forged_*
  the resume asks nothing                                                       test_a_resume_*
  the recorded country outlives the segment's or the run's deadline             test_the_carried_country_dies_with_*
  it serves another segment, film or run, or a direct create                    test_the_carried_country_is_never_*
  a client (or a definer) writes the record                                     test_nobody_writes_the_record
  the API and MCP doors gained the carried country                              test_the_api_and_mcp_doors_*
  0244 lands on a body nobody read, its rollback drifts, or it is not harmless  test_drift_guard_*, test_rollback_*

Its own scratch database (it commits), on test_sec_films_money's models plus two Google rows carrying the shipped Google lists.
"""

from __future__ import annotations

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
from test_sec_films_money import ASSEMBLY_RATE, JOB_MINIMUM, MODELS, SCENES, SETTINGS, Db, Org

KEY = "lab-only-geo-claim-key-0244-not-a-secret-xxxxxxxx"  # a lab-only key, never a real one
REGISTRY = json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]
ANY_GOOGLE = next(m for m in REGISTRY if m.get("provider") == "google" and m.get("available_countries"))
LISTS = {"blocked_countries": ANY_GOOGLE["blocked_countries"], "available_countries": ANY_GOOGLE["available_countries"]}
G_KEY = "google-lab-key"
G_CLIP = "google-lab-clip"
GOOGLE_MODELS = [
    (G_KEY, "google", "image.acme", ["t2i", "edit"], "model_google_lab_key_image", 3,
     {"aspect_ratios": ["16:9", "9:16", "1:1"], "inputs": {"image_refs_max": 4}, **LISTS}),
    (G_CLIP, "google", "video.acme", ["t2v", "i2v"], "model_google_lab_clip_second", 2,
     {"durations_s": [5, 10], "end_frame": True, **LISTS}),
]
G_SETTINGS = {**SETTINGS, "keyframe_model": G_KEY, "clip_model": G_CLIP}
MIGRATION = sec_db.MIGRATION_0244
ROLLBACK = sec_db.ROLLBACK_0244
FOLD = "md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g'))"
#: The live folded md5s read on 2026-11-28 05:24Z, and the file each came from (the trace 0244's header states).
LIVE = {
    "public.start_film(uuid, text, text)": ("37d467f86ed6350598144c4252568e1f", "0215_film_archive_resume.sql"),
    "public.start_film_resume(uuid, text, text)": ("9f1444b6d34991c9964a0200986a43bb", "0215_film_archive_resume.sql"),
    "public.film_take_job(uuid, text)": ("8a28484a7992a4aa2195d78878f3b399", "0198_film_studio_org_switch.sql"),
    "public.film_fail_locked(uuid, text, text, text, numeric)": ("0676b7e0f3e3549348044a8915a246cc", "0198_film_studio_org_switch.sql"),
    "public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)": ("04d4ac338fbce93ceec279aac3fce89d",
                                                                         "0226_org_spender_everywhere.sql"),
    "public.workflow_advance_locked(uuid, boolean)": ("37fda6dc6caf182483f10314d166579c", "0231_cancel_audit.sql"),
    "public.creative_jobs_geo_gate()": ("6d28388da6b6b927b0da500524fe0325", "0230_geo_gate_allow_list.sql"),
    "public.geo_claim_country()": ("add85b6752c03be6882a59a0ff8017ba", "0208_geo_gate_and_image_size_price.sql"),
}


def sign(country, uid, exp=None, key=KEY):
    body = f"v1.{country}.{uid}.{int(exp if exp is not None else time.time() + 120)}"
    return body + "." + hmac.new(key.encode(), body.encode(), hashlib.sha256).hexdigest()


class GeoDb(Db):
    """test_sec_films_money's Db, with the request's headers (the claim our web server would send) for the next call."""

    headers = None

    def act(self, role, user, q, p=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)",
                          [json.dumps({"role": role, **({"sub": user} if user else {})})])
                if self.headers is not None:
                    c.execute("select set_config('request.headers', %s, true)", [json.dumps(self.headers)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit()
                return rows
            except psycopg.Error:
                c.rollback()
                raise

    def claimed(self, country, uid, **kw):
        """The headers for one call, as the web server signs them (None: no claim at all)."""
        self.headers = None if country is None else {"x-nightshift-geo": sign(country, uid, **kw)}
        return self


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_geo244_{uuid.uuid4().hex[:8]}"
    d = GeoDb(sec_db.build(admin, name))
    every = MODELS + GOOGLE_MODELS
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], **spec}}
            for m, prov, a, caps, unit, _rate, spec in every]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, _prov, a, caps, unit, rate, _spec in every:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, rate])
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0), "
         "('job_minimum', %s, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit",
         [ASSEMBLY_RATE, JOB_MINIMUM])
    assert d.su("select public.set_film_studio_enabled(true)")[0][0]["ok"] is True
    d.su("select vault.create_secret(%s, 'nightshift_geo_claim_key', 'lab')", [KEY])
    # One organization here holds a film segment and a run's step at once; the plan's parallel-run limit (0034) is not what this file
    # tests, and would refuse the second hold before the gate is reached.
    d.su("alter table public.credit_reservations disable trigger credit_reservations_concurrency")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(autouse=True)
def fresh(db):
    """No claim unless a test signs one; every live segment cancelled (the claim takes the oldest across organizations)."""
    db.headers = None
    for (sid,) in db.su("select id from public.film_segments where status in ('queued', 'running', 'draining')"):
        db.svc("select public.film_cancel_segment(%s, 'cancelled')", [sid])
    yield
    db.headers = None


def org(db, credits=1000):
    """A fresh organization whose people answered "18 or older" (a Google model asks it of a film and a run, 0192 / 0196)."""
    o = db.new_org(credits=credits)
    for uid in (o.owner, o.admin, o.editor, o.viewer):
        db.su("insert into public.adult_attestations (user_id, adult, terms_version, method) "
              "values (%s, true, '2026-11-20', 'email_signup') on conflict (user_id) do nothing", [uid])
    return o


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0]


def footprint(db, o):
    return (db.holds(o.org), db.account(o.org),
            db.su("select count(*) from public.film_segments where org_id = %s", [o.org])[0][0],
            db.su("select count(*) from public.workflow_runs where org_id = %s", [o.org])[0][0],
            records(db))


def records(db):
    """How many starts recorded a country (0 where 0244 is not applied, so a pin fails on what it pins, not on a missing table)."""
    if not db.su("select to_regclass('public.creative_geo_carry') is not null")[0][0]:
        return 0
    return db.su("select count(*) from public.creative_geo_carry")[0][0]


def start(db, o, fid, country, **kw):
    q = db.quote(o.editor, fid)
    assert q["quote_id"], q
    db.claimed(country, o.admin, **kw)
    try:
        return db.start(o.admin, fid, q["quote_id"])
    finally:
        db.headers = None


def keyframe_take(db, seg):
    return next(str(t[0]) for t in db.takes(seg) if t[1] == "keyframe")


def take_job(db, take, worker="w-1"):
    return db.svc("select public.film_take_job(%s, %s)", [take, worker])


def carried(db, seg=None, run=None):
    if not db.su("select to_regclass('public.creative_geo_carry') is not null")[0][0]:
        return []
    return db.su("select country, recorded_by::text from public.creative_geo_carry where film_segment_id is not distinct from %s "
                 "and workflow_run_id is not distinct from %s", [seg, run])


def test_the_lab_chain_takes_0244_off_and_puts_it_back(db):
    """First in the file: rollback_0215, which take_off_0215 reaches, refuses while a resume segment of a later test is open."""
    for off, back in ((sec_db.take_off_0226, sec_db.put_back_0226), (sec_db.take_off_0215, sec_db.put_back_0215),
                      (sec_db.take_off_0208, sec_db.put_back_0208)):
        with psycopg.connect(db.dsn, autocommit=False) as c:
            assert sec_db.has_0244(c)
            # rollback_0238 (take_off_0208 reaches it) refuses while a country-listed model is on sale: off sale in this transaction.
            c.execute("update public.model_registry set availability = 'hidden' where id = any (%s)", [[G_KEY, G_CLIP]])
            off(c)
            assert not sec_db.has_0244(c), off.__name__
            back(c)
            assert all(sec_db._cut_md5(c, s) == now_ for s, _w, now_ in sec_db.BODIES_0244), back.__name__
            c.rollback()


# ── films ───────────────────────────────────────────────────────────────────

def test_a_film_started_in_uz_makes_its_google_takes(db):
    o = org(db)
    fid = db.film(o, settings=G_SETTINGS)
    seg = start(db, o, fid, "UZ")
    assert seg["ok"] is True, seg
    assert db.claim()["id"] == seg["id"]
    tid = keyframe_take(db, seg["id"])
    db.begin(tid)
    out = take_job(db, tid)  # the worker: no visitor, no claim. Before 0244: NS400 country_unverified.
    assert out["ok"] is True and out["job_id"], out
    assert carried(db, seg=seg["id"]) == [("UZ", o.admin)]
    assert db.su("select payer, film_take_id::text, requested_model from public.creative_jobs where id = %s",
                 [out["job_id"]])[0] == ("film", tid, G_KEY)
    assert db.su("select current_setting('nightshift.geo_carry_take', true)")[0][0] in (None, "")


@pytest.mark.parametrize("country, word", [(None, "country_unverified"), ("RU", "country_blocked"), ("BY", "country_blocked"),
                                           ("EU", "country_unverified")])
def test_a_film_start_with_no_claim_or_a_ru_claim_is_refused_by_name_before_any_hold(db, country, word):
    o = org(db)
    fid = db.film(o, settings=G_SETTINGS)
    before = footprint(db, o)
    out = start(db, o, fid, country)
    assert out["ok"] is False and out["reason"] == word and out["code"] == "NS400", out
    assert G_KEY in out["detail"] and "nothing was held" in out["detail"]
    assert footprint(db, o) == before and db.film_row(fid)[0] == "draft"


def test_a_forged_or_expired_or_borrowed_claim_at_the_start_is_refused(db):
    o = org(db)
    fid = db.film(o, settings=G_SETTINGS)
    before = footprint(db, o)
    for kw in ({"key": "another-key-that-is-long-enough-to-sign-xxxxxxxx"}, {"exp": time.time() - 5},
               {"exp": time.time() + 3600}):
        assert start(db, o, fid, "UZ", **kw)["reason"] == "country_unverified", kw
    # A claim signed for another person (the editor) does not vouch for the admin who starts.
    q = db.quote(o.editor, fid)
    db.claimed("UZ", o.editor)
    assert db.start(o.admin, fid, q["quote_id"])["reason"] == "country_unverified"
    db.headers = None
    assert footprint(db, o) == before


def test_a_film_with_no_country_listed_model_needs_no_claim(db):
    o = org(db)
    fid = db.film(o)  # test_sec_films_money's acme models: no list
    seg = start(db, o, fid, None)
    assert seg["ok"] is True and carried(db, seg=seg["id"]) == []


def test_a_resume_asks_and_records_the_same_way(db):
    o = org(db)
    fid = db.film(o, settings=G_SETTINGS)
    seg = start(db, o, fid, "UZ")
    assert db.claim()["id"] == seg["id"]
    # Scene 2's clip fails for good, everything else is made: the film pauses.
    scene_pos = {str(r[0]): r[1] for r in db.su("select id, position from public.film_scenes where film_id = %s", [fid])}
    for t in db.takes(seg["id"]):
        tid, kind, scene = str(t[0]), t[1], t[2]
        if kind == "clip" and scene_pos[str(scene)] == max(scene_pos.values()):
            db.begin(tid)
            retry = db.fail(tid, "provider_error")["retry_take_id"]
            db.begin(retry)
            db.fail(retry, "provider_error")
        else:
            db.make(o, tid, kind)
    db.settle(seg["id"], "takes_failed")
    assert db.film_row(fid)[0] == "paused"

    def resume(country):
        q = db.one("authenticated", o.admin, "select public.quote_film_resume(%s::uuid, %s::integer)", [fid, db.version(fid)])
        assert q["quote_id"], q
        db.claimed(country, o.admin)
        try:
            return db.one("authenticated", o.admin, "select public.start_film_resume(%s::uuid, %s, %s)", [fid, q["quote_id"], db.key()])
        finally:
            db.headers = None

    before = footprint(db, o)
    for country, word in ((None, "country_unverified"), ("RU", "country_blocked")):
        out = resume(country)
        assert out["ok"] is False and out["reason"] == word and G_CLIP in out["detail"], out
        assert footprint(db, o) == before
    out = resume("UZ")
    assert out["ok"] is True, out
    assert carried(db, seg=out["id"]) == [("UZ", o.admin)]
    assert carried(db, seg=seg["id"]) == [("UZ", o.admin)]  # the first segment's row is its own, untouched
    assert db.claim()["id"] == out["id"]
    # The lab's make() records no last frame; the real worker does, and the next scene's clip starts from it.
    db.su("update public.film_takes set result_last_frame_asset_id = %s where segment_id = %s and kind = 'clip' "
          "and status = 'completed'", [db.asset(o.org), out["id"]])
    clip = next(str(t[0]) for t in db.takes(out["id"]) if t[1] == "clip" and t[4] == "planned")
    db.begin(clip)
    job = take_job(db, clip)
    assert job["ok"] is True and job["job_id"], job


def test_the_carried_country_dies_with_the_segments_deadline(db):
    o = org(db)
    fid = db.film(o, settings=G_SETTINGS)
    seg = start(db, o, fid, "UZ")
    assert db.claim()["id"] == seg["id"]
    tid = keyframe_take(db, seg["id"])
    db.begin(tid)
    db.su("update public.film_segments set deadline_at = now() - interval '1 minute' where id = %s", [seg["id"]])
    assert err(lambda: take_job(db, tid)) == ("NS400", "country_unverified")
    assert db.su("select creative_job_id from public.film_takes where id = %s", [tid])[0][0] is None


def test_the_carried_country_is_never_another_segments_or_a_direct_creates(db):
    o = org(db)
    fa = db.film(o, settings=G_SETTINGS)
    sa = start(db, o, fa, "UZ")
    assert sa["ok"] is True
    db.svc("select public.film_cancel_segment(%s, 'cancelled')", [sa["id"]])  # one film of an organization runs at a time
    # Film B started in UZ too, then its record is gone: film A's record (same organization, same person) does not serve it.
    fb = db.film(o, settings=G_SETTINGS)
    sb = start(db, o, fb, "UZ")
    assert sb["ok"] is True, sb
    db.su("alter table public.creative_geo_carry disable trigger creative_geo_carry_frozen")
    db.su("delete from public.creative_geo_carry where film_segment_id = %s", [sb["id"]])
    db.su("alter table public.creative_geo_carry enable trigger creative_geo_carry_frozen")
    assert db.claim()["id"] == sb["id"]
    tb = keyframe_take(db, sb["id"])
    db.begin(tb)
    assert err(lambda: take_job(db, tb)) == ("NS400", "country_unverified")
    # A member's own create, with the take named in the setting film_take_job uses, carries nothing: it is not that take's row.
    for setup in ("", f"select set_config('nightshift.geo_carry_take', '{tb}', true);"):
        with psycopg.connect(db.dsn, autocommit=False) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "authenticated", "sub": o.admin})])
            if setup:
                c.execute(setup)
            c.execute("set local role authenticated")
            with pytest.raises(psycopg.Error) as e:
                c.execute("select public.create_creative_job(%s, 't2i', %s, %s::jsonb, 'exact', %s, 1000)",
                          [o.org, G_KEY, json.dumps({"prompt": "a lighthouse"}), f"geo244-{uuid.uuid4().hex[:12]}"])
            assert e.value.sqlstate == "NS400" and "country_unverified" in str(e.value)
            c.rollback()


def test_the_carry_rule_itself_for_a_synthetic_row(db):
    """creative_geo_carried, asked as the gate asks it: the marker alone, the row alone, or the row after its deadline carry nothing."""
    o = org(db)
    fid = db.film(o, settings=G_SETTINGS)
    seg = start(db, o, fid, "UZ")
    assert db.claim()["id"] == seg["id"]
    tid = keyframe_take(db, seg["id"])
    db.begin(tid)
    row = ("select public.creative_geo_carried(row(gen_random_uuid(), %s, 'generate', 't2i', 'exact', %s, null, null, null, null, "
           "'{}'::jsonb, 'running', null, null, 1, 1, 'w', now(), now(), null, now(), 'film', null, null, null, 0, null, null, null, null, "
           "'{}'::uuid[], null, null, null, %s, now(), now(), null, null, %s)::public.creative_jobs)")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        assert c.execute(row, [o.org, G_KEY, o.admin, tid]).fetchone()[0] is None           # no marker
        c.execute("select set_config('nightshift.geo_carry_take', %s, true)", [tid])
        assert c.execute(row, [o.org, G_KEY, o.admin, tid]).fetchone()[0] == "UZ"           # film_take_job's own insert
        assert c.execute(row, [o.org, "img-key", o.admin, tid]).fetchone()[0] is None       # another model
        assert c.execute(row, [str(uuid.uuid4()), G_KEY, o.admin, tid]).fetchone()[0] is None  # another organization
        c.execute("update public.film_segments set deadline_at = now() - interval '1 second' where id = %s", [seg["id"]])
        assert c.execute(row, [o.org, G_KEY, o.admin, tid]).fetchone()[0] is None           # past the deadline
        c.rollback()


EXEMPT = "00000000-0000-0000-0000-000000000001"  # the credits-exempt default organization, the operator's own
G_PREVIEW = "google-pv-key"


def test_an_operator_preview_google_take_carries_the_starters_claim(db):
    """0235 lets the platform operator use a hidden operator-preview model in the operator's own organization, Film Studio included.
    Such a Google row keeps its country lists, so its take meets the same gate: started with a UZ claim, the take carries it; with
    none, the start is refused by name, nothing held."""
    if not db.su("select to_regprocedure('public.film_check_model(text, text[], text, uuid)') is not null")[0][0]:
        pytest.skip("0235 (Film Studio's operator preview) is not in this chain")
    if not db.su("select count(*) from public.model_registry where id = %s", [G_PREVIEW])[0][0]:
        spec = {"vendor_model": "acme-" + G_PREVIEW, "output": "image", "operator_preview": True, "terms_gate": "plan_required:scale",
                "pricing": {"unit": "image", "provider_usd_per_unit": 0.04}, "aspect_ratios": ["16:9", "9:16", "1:1"],
                "inputs": {"image_refs_max": 4}, **LISTS}
        db.su("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
              "values (%s, %s, 'google', 'image.acme', array['t2i', 'edit'], %s::jsonb, %s, 'any')",
              [G_PREVIEW, G_PREVIEW, json.dumps(spec), "model_google_pv_key_image"])
        db.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'security-lab')",
              [G_PREVIEW, "acme-" + G_PREVIEW])
        operator = str(uuid.uuid4())
        db.su("insert into auth.users (id, email) values (%s, 'operator@carry.lab')", [operator])
        db.su("insert into public.app_members (user_id, email, role) values (%s, 'operator@carry.lab', 'owner') "
              "on conflict do nothing", [operator])
        db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'operator@carry.lab', 'owner')",
              [EXEMPT, operator])
        db.su("insert into public.adult_attestations (user_id, adult, terms_version, method) "
              "values (%s, true, '2026-11-20', 'email_signup') on conflict (user_id) do nothing", [operator])
        db.film_org_on(EXEMPT)
    operator = db.su("select user_id::text from public.app_members where email = 'operator@carry.lab'")[0][0]
    assert G_PREVIEW not in {r[0] for r in db.su("select id from public.sellable_models(null, 'web')")}, "on sale: proves nothing"
    o = Org(EXEMPT, operator, operator, operator, operator)
    o.image = db.asset(EXEMPT)
    fid = db.film(o, settings={**SETTINGS, "keyframe_model": G_PREVIEW})
    before = footprint(db, o)
    out = start(db, o, fid, None)
    assert out["ok"] is False and out["reason"] == "country_unverified" and G_PREVIEW in out["detail"], out
    assert footprint(db, o) == before
    seg = start(db, o, fid, "UZ")
    assert seg["ok"] is True, seg
    assert db.claim()["id"] == seg["id"]
    tid = keyframe_take(db, seg["id"])
    db.begin(tid)
    job = take_job(db, tid)
    assert job["ok"] is True and job["job_id"], job
    assert db.su("select requested_model from public.creative_jobs where id = %s", [job["job_id"]])[0][0] == G_PREVIEW
    assert carried(db, seg=seg["id"]) == [("UZ", operator)]


# ── workflows ───────────────────────────────────────────────────────────────

WF_STEPS = [{"capability": "t2i", "model": G_KEY, "params": {"prompt": {"$input": "idea"}}},
            {"capability": "t2i", "model": G_KEY, "params": {"prompt": {"$input": "idea"}}}]
WF_INPUTS = [{"name": "idea", "kind": "text"}]


def workflow(db, o):
    wf = db.one("authenticated", o.editor, "select public.save_workflow(%s::uuid, null::uuid, 'Geo', %s::jsonb, %s::jsonb)",
                [o.org, json.dumps(WF_INPUTS), json.dumps(WF_STEPS)])
    q = db.one("authenticated", o.editor, "select public.quote_workflow(%s, %s::jsonb)", [wf["id"], json.dumps({"idea": "a lighthouse"})])
    return wf, q["total"]


def run_start(db, o, country, wf=None, total=None):
    if wf is None:
        wf, total = workflow(db, o)
    run = str(uuid.uuid4())
    db.claimed(country, o.editor)
    try:
        return run, db.one("authenticated", o.editor,
                           "select public.start_workflow_run(%s::uuid, %s::uuid, %s::integer, %s::jsonb, %s::numeric)",
                           [run, wf["id"], wf["version"], json.dumps({"idea": "a lighthouse"}), total])
    finally:
        db.headers = None


def finish_job(db, job):
    w = "wf-geo"
    while True:
        got = db.act("service_role", None, "select id::text, org_id::text, credit_ref from public.claim_creative_job(%s)", [w])
        assert got, "the job is not in the queue"
        jid, org_, ref = got[0]
        if jid == job:
            break
        db.act("service_role", None, "select public.finish_creative_job(%s, %s, false, null, null, 'drained', 'drained')", [jid, w])
    if ref:
        db.act("service_role", None, "select public.start_credit_reservation(%s, %s)", [ref, org_])
    sv = lambda q, p: db.act("service_role", None, q, p)  # noqa: E731
    sv("select public.advance_creative_job(%s, %s, 'submitting')", [job, w])
    sv("select public.advance_creative_job(%s, %s, 'submitted', %s)", [job, w, f"task-{job}"])
    sv("select public.advance_creative_job(%s, %s, 'processing')", [job, w])
    sv("select public.attach_creative_job_assets(%s, %s, %s::uuid[])", [job, w, [db.asset(org_, provenance={"job_id": job})]])
    return sv("select public.finish_creative_job(%s::uuid, %s, true, null::numeric, '{}'::jsonb)", [job, w])[0][0]


def steps(db, run):
    return db.su("select step_index, status, job_id::text, error_code from public.workflow_run_steps where run_id = %s "
                 "order by step_index", [run])


def test_a_workflow_started_in_uz_makes_its_later_google_step_at_an_advance_with_no_claim(db):
    o = org(db)
    run, out = run_start(db, o, "UZ")
    s0 = steps(db, run)[0]
    assert s0[1] == "running", steps(db, run)
    finish_job(db, s0[2])
    # The advance comes from no visitor's claim (a poll, or the viewer's page carrying it on as the editor). Before 0244 step 2
    # failed country_unverified and the run with it.
    db.one("authenticated", o.editor, "select public.advance_workflow_run(%s)", [run])
    s1 = steps(db, run)[1]
    assert s1[1] == "running" and s1[2], steps(db, run)
    assert db.su("select idempotency_key from public.creative_jobs where id = %s", [s1[2]])[0][0] == f"wf:{run}:1"
    assert carried(db, run=run) == [("UZ", o.editor)]


@pytest.mark.parametrize("country, word", [(None, "country_unverified"), ("RU", "country_blocked")])
def test_a_workflow_start_with_no_claim_or_a_ru_claim_is_refused_by_name_before_any_hold(db, country, word):
    o = org(db)
    wf, total = workflow(db, o)
    before = footprint(db, o)
    sqlstate, msg = err(lambda: run_start(db, o, country, wf, total))
    assert (sqlstate, msg) == ("NS400", word)
    assert footprint(db, o) == before


def test_a_forged_or_expired_claim_at_a_workflow_start_is_refused(db):
    o = org(db)
    wf, total = workflow(db, o)
    for kw in ({"key": "another-key-that-is-long-enough-to-sign-xxxxxxxx"}, {"exp": time.time() - 5}):
        run = str(uuid.uuid4())
        db.claimed("UZ", o.editor, **kw)
        try:
            assert err(lambda: db.one("authenticated", o.editor,
                                      "select public.start_workflow_run(%s::uuid, %s::uuid, %s::integer, %s::jsonb, %s::numeric)",
                                      [run, wf["id"], wf["version"], json.dumps({"idea": "x"}), total])) == \
                ("NS400", "country_unverified"), kw
        finally:
            db.headers = None


def test_the_carried_country_dies_with_the_runs_day_and_never_serves_another_run(db):
    o = org(db)
    run, _out = run_start(db, o, "UZ")
    run_b, _ = run_start(db, o, "UZ")
    key_ = f"wf:{run}:1"
    row = ("select public.creative_geo_carried(row(gen_random_uuid(), %s, 'generate', 't2i', 'exact', %s, %s, null, null, null, "
           "'{}'::jsonb, 'queued', null, null, 0, 3, null, null, null, null, now(), 'credits', null, null, null, 0, null, null, null, "
           "null, '{}'::uuid[], null, %s, null, %s, now(), now(), null, null, null)::public.creative_jobs)")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        assert c.execute(row, [o.org, G_KEY, G_KEY, key_, o.editor]).fetchone()[0] is None    # no step key named
        c.execute("select set_config('nightshift.workflow_step_key', %s, true)", [key_])
        assert c.execute(row, [o.org, G_KEY, G_KEY, key_, o.editor]).fetchone()[0] == "UZ"    # that step's own create
        assert c.execute(row, [o.org, G_KEY, G_KEY, key_, o.owner]).fetchone()[0] is None     # not made as the starter
        assert c.execute(row, [o.org, G_KEY, G_KEY, f"wf:{run_b}:1", o.editor]).fetchone()[0] is None  # another run's key
        c.execute("update public.workflow_runs set created_at = now() - interval '24 hours 1 second' where id = %s", [run])
        assert c.execute(row, [o.org, G_KEY, G_KEY, key_, o.editor]).fetchone()[0] is None    # past the run's day
        c.rollback()


# ── who writes the record, and the doors that have no claim ─────────────────

def test_nobody_writes_the_record(db):
    o = org(db)
    fid = db.film(o, settings=G_SETTINGS)
    seg = start(db, o, fid, "UZ")
    assert seg["ok"] is True, seg
    for role, user in (("anon", None), ("authenticated", o.admin), ("service_role", None)):
        for q in ("select country from public.creative_geo_carry",
                  "update public.creative_geo_carry set country = 'RU'",
                  "delete from public.creative_geo_carry",
                  f"insert into public.creative_geo_carry (film_segment_id, country, recorded_by) values ('{seg['id']}', 'UZ', "
                  f"'{o.admin}')"):
            assert err(lambda: db.act(role, user, q))[0] == "42501", (role, q)
        for fn in ("public.creative_geo_refusal('x', 'UZ')", "public.creative_geo_carried(null::public.creative_jobs)"):
            assert err(lambda: db.act(role, user, f"select {fn}"))[0] == "42501", (role, fn)
    # Not extended or refreshed, even by the table's owner (a definer function).
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.creative_geo_carry set recorded_at = now() where film_segment_id = %s", [seg["id"]])
    assert e.value.sqlstate == "42501"
    assert carried(db, seg=seg["id"]) == [("UZ", o.admin)]


def test_the_api_and_mcp_doors_have_no_claim_and_carry_nothing(db):
    """The API and MCP reach creative_jobs through create_creative_job as the key's or connection's person (api_act_as), with no
    claim and with neither carry setting. A member whose film and run carry UZ is still refused there, and 0244 changes neither door."""
    o = org(db)
    fid = db.film(o, settings=G_SETTINGS)
    assert start(db, o, fid, "UZ")["ok"] is True
    run_start(db, o, "UZ")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role"})])
        c.execute("select public.api_act_as(%s)", [o.admin])
        with pytest.raises(psycopg.Error) as e:
            c.execute("select public.create_creative_job(%s, 't2i', %s, %s::jsonb, 'exact', %s, 1000)",
                      [o.org, G_KEY, json.dumps({"prompt": "a lighthouse"}), f"api-{uuid.uuid4().hex[:12]}"])
        assert e.value.sqlstate == "NS400" and "country_unverified" in str(e.value)
        c.rollback()
    sigs = [r[0] for r in db.su("select p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace "
                                "and p.proname in ('api_creative_create', 'oauth_creative_create', 'create_creative_job')")]
    assert sigs
    for sig in sigs:
        src = db.su("select prosrc from pg_proc where oid = %s::regprocedure", [sig])[0][0]
        assert "geo_carry_take" not in src and "creative_geo_carry" not in src, sig
    with psycopg.connect(db.dsn, autocommit=False) as c:
        before = {s: c.execute(f"select {FOLD} from pg_proc where oid = %s::regprocedure", [s]).fetchone()[0] for s in sigs}
        c.execute(sec_db.rollback_0244_body())
        assert {s: c.execute(f"select {FOLD} from pg_proc where oid = %s::regprocedure", [s]).fetchone()[0] for s in sigs} == before
        c.rollback()


# ── the migration ───────────────────────────────────────────────────────────

def _fold(c, sig):
    return c.execute(f"select {FOLD} from pg_proc where oid = %s::regprocedure", [sig]).fetchone()[0]


def test_the_live_bodies_are_the_files_the_header_names(db):
    """Each live body (2026-11-28) is what the chain without 0244 ends on, and the file named produced it."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(sec_db.rollback_0244_body())
        for sig, (h, src) in LIVE.items():
            assert _fold(c, sig) == h, sig
            name = sig.split("(")[0]
            assert f"create or replace function {name}(" in (sec_db.MIGRATIONS / src).read_text(encoding="utf-8"), (sig, src)
            later = [p.name for p in sec_db.migration_files() if p.name > src and p.name != MIGRATION.name
                     and f"create or replace function {name}(" in p.read_text(encoding="utf-8")]
            assert later == [], (sig, later)
        c.rollback()


@pytest.mark.parametrize("sig", [s for s, _was, _now in sec_db.BODIES_0244])
def test_drift_guard_refuses_a_body_nobody_read(db, sig):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        src = c.execute("select prosrc from pg_proc where oid = %s::regprocedure", [sig]).fetchone()[0]
        planted = src.replace("begin", "begin\n  perform 1;", 1)
        defn = c.execute("select pg_get_functiondef(%s::regprocedure)", [sig]).fetchone()[0]
        body_at = defn.index(src)
        c.execute(defn[:body_at] + planted + defn[body_at + len(src):])
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert f"0244 found {sig} with a body that is neither" in str(e.value), str(e.value)
        c.rollback()


def test_drift_guard_refuses_a_claim_reader_that_is_not_0208s(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("create or replace function public.geo_claim_country() returns text language sql stable security definer "
                  "set search_path = extensions, public, pg_temp as $$ select 'UZ'::text $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "0244 found a geo_claim_country() that is not 0208's body" in str(e.value)
        c.rollback()


def _bodies_of(path, names):
    text = path.read_text(encoding="utf-8")
    out = {}
    for n in names:
        i = text.index(f"create or replace function public.{n}(")
        j = text.index("\n$$;\n", i)
        out[n] = text[text.index("$$", i) + 2:j + 1]
    return out


NAMES = ("start_film", "start_film_resume", "film_take_job", "start_workflow_run", "creative_jobs_geo_gate")
SOURCES = {"start_film": "0215_film_archive_resume.sql", "start_film_resume": "0215_film_archive_resume.sql",
           "film_take_job": "0198_film_studio_org_switch.sql", "start_workflow_run": "0226_org_spender_everywhere.sql",
           "creative_jobs_geo_gate": "0230_geo_gate_allow_list.sql"}


def test_rollback_restores_each_body_byte_for_byte_is_harmless_twice_and_0244_applies_again(db):
    want = {n: _bodies_of(sec_db.MIGRATIONS / SOURCES[n], [n])[n] for n in NAMES}
    assert _bodies_of(ROLLBACK, NAMES) == want  # the rollback's text is the earlier files', verbatim
    acl = "select proacl::text from pg_proc where oid = %s::regprocedure"
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sigs = {s.split("(")[0].split(".")[1]: s for s, _w, _n in sec_db.BODIES_0244}
        after = {n: (_fold(c, sigs[n]), c.execute(acl, [sigs[n]]).fetchone()[0]) for n in NAMES}
        c.execute(MIGRATION.read_text(encoding="utf-8"))  # a replay changes nothing
        assert {n: (_fold(c, sigs[n]), c.execute(acl, [sigs[n]]).fetchone()[0]) for n in NAMES} == after
        c.execute(sec_db.rollback_0244_body())
        for n in NAMES:
            assert c.execute("select prosrc from pg_proc where oid = %s::regprocedure", [sigs[n]]).fetchone()[0] == want[n], n
        live = {n: c.execute(acl, [sigs[n]]).fetchone()[0] for n in NAMES}
        assert c.execute("select to_regclass('public.creative_geo_carry'), to_regprocedure('public.creative_geo_refusal(text, text)')"
                         ).fetchone() == (None, None)
        c.execute(sec_db.rollback_0244_body())  # twice: harmless
        assert {n: c.execute("select prosrc from pg_proc where oid = %s::regprocedure", [sigs[n]]).fetchone()[0] for n in NAMES} == want
        assert {n: c.execute(acl, [sigs[n]]).fetchone()[0] for n in NAMES} == live == {n: after[n][1] for n in NAMES}
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert {n: (_fold(c, sigs[n]), c.execute(acl, [sigs[n]]).fetchone()[0]) for n in NAMES} == after
        c.rollback()


def test_rollback_refuses_a_body_that_is_neither(db):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("create or replace function public.creative_jobs_geo_gate() returns trigger language plpgsql security definer "
                  "set search_path = public, pg_temp as $$ begin return new; end $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(sec_db.rollback_0244_body())
        assert "rollback 0244: public.creative_jobs_geo_gate() is neither 0244's body nor 0230's" in str(e.value), str(e.value)
        c.rollback()


def test_the_end_state_holds_definer_owner_search_path_and_grants(db):
    rows = db.su("select p.oid::regprocedure::text, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), "
                 "has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'), "
                 "has_function_privilege('service_role', p.oid, 'execute') from pg_proc p "
                 "where p.oid in (select to_regprocedure(x) from unnest(%s::text[]) x)",
                 [[s for s, _w, _n in sec_db.BODIES_0244] + ["public.creative_geo_refusal(text, text)",
                                                             "public.creative_geo_carried(public.creative_jobs)",
                                                             "public.creative_geo_carry_frozen()"]])
    got = {r[0]: r[1:] for r in rows}
    assert len(got) == 8
    pinned = (True, ["search_path=public, pg_temp"], "postgres")
    want = {"start_film(uuid,text,text)": (False, True, False), "start_film_resume(uuid,text,text)": (False, True, False),
            "start_workflow_run(uuid,uuid,integer,jsonb,numeric)": (False, True, False),
            "film_take_job(uuid,text)": (False, False, True)}
    for sig, row in got.items():
        assert row[:3] == pinned, sig
        assert row[3:] == want.get(sig, (False, False, False)), sig
    assert db.su("select relrowsecurity from pg_class where oid = 'public.creative_geo_carry'::regclass")[0][0] is True


def test_neither_the_file_nor_its_rollback_holds_a_backslash():
    for path in (MIGRATION, ROLLBACK):
        assert chr(92) not in path.read_text(encoding="utf-8"), path
    assert re.search(r"(?m)^begin;$", ROLLBACK.read_text(encoding="utf-8"))
