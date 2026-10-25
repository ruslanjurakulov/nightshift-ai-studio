"""The region editor's run step (0126), attacked in a real database.

A region edit is an ordinary `edit` creative job whose params carry 1 to 5 regions. The browser may ask for one; the DATABASE alone decides
whether the shape is allowed, what it costs, and what is charged. What must hold:

* the shape is closed: 1 to 5 regions, each {id, name, rect, prompt}; every other key, every other capability and every other parameter
  next to the regions is refused, and a request WITHOUT the two new keys is judged and priced exactly as before 0126 (compared against the
  pre-0126 bodies on a corpus);
* the price is the ordinary quote of n units, the hold equals it, and a refused request holds and charges nothing;
* settlement is per region: applied regions are charged their share of the hold, rounded up to the cent and never above the hold; a failed
  or refused region is not charged; none applied ends the job failed with the whole hold released; the rest is released exactly once;
* the worker's report is closed too (one outcome per region, in order, with a code from a closed list), a charge the worker names cannot
  differ from the regions', and nothing is charged for a result that was never stored;
* finishing twice, expiring or cancelling afterwards, and a retried call move no credit a second time;
* no API role can call the new functions or the settlement; the generic rules for every other job are untouched.

Runs in its own scratch database (it commits), like the 0046 / 0060 labs.
"""
import json
import os
import re
import uuid
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000f5"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000f5"
UA = str(uuid.UUID(int=0xF5A))   # owner of A
UB = str(uuid.UUID(int=0xF5B))   # owner of B

MIGRATION = Path(sec_db.MIGRATIONS) / "0126_region_edit_run.sql"
ROLLBACK = Path(sec_db.REPO) / "docs" / "sql" / "rollback_0126_region_edit_run.sql"
M0100 = Path(sec_db.MIGRATIONS) / "0100_video_ai_ops.sql"
M0099 = Path(sec_db.MIGRATIONS) / "0099_image_ai_ops.sql"

#: model id -> credits per unit. rimg: 2 credits a region with a 50 % margin (3.00); rcents: a rate whose n-region price is not a whole share.
MODELS = {"rimg": ("model_rimg_image", 2, "0.5"), "rcents": ("model_rcents_image", "0.0333", "0"), "rtier": ("model_rtier_image", 8, "0")}
SRC = "00000000-0000-4000-8000-000000000000"
CODES = ["not_configured", "auth", "quota", "rate_limited", "bad_request", "policy", "not_found", "unavailable",
         "bad_response", "provider_error", "region_invalid", "region_too_small", "region_out_of_bounds",
         "crop_unavailable", "pixel_lock_failed"]


def region(i=1, **kw):
    r = {"id": f"r{i}", "name": f"Region {i}", "prompt": f"make part {i} brighter", "rect": {"x": 10 * i, "y": 10 * i, "w": 40, "h": 30}}
    r.update(kw)
    return r


def params(n=1, **kw):
    p = {"source_asset_id": kw.pop("source", SRC), "regions": [region(i + 1) for i in range(n)]}
    p.update(kw)
    return p


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_region_run_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.name, d.admin = name, admin
    d.su("insert into auth.users (id, email) values (%s,'a5@x.io'),(%s,'b5@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A5','org-a5'),(%s,'B5','org-b5')", [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a5@x.io','owner'),(%s,%s,'b5@x.io','owner')",
         [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 10000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 10000, 'test')", [ORG_B])
    rows = []
    for m, (unit, _c, _m) in MODELS.items():
        spec = {"vendor_model": "acme-" + m, "output": "image"}
        if m == "rtier":
            spec["qualities"] = ["low", "high"]
            spec["pricing"] = {"unit": "image", "variants": {"by": "quality", "prices": {"low": None, "high": None}}}
        rows.append({"id": m, "display_name": m, "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i", "edit"],
                     "credit_unit": unit, "entitlement": "any", "spec": spec})
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for r in rows:
        d.su("select public.record_model_probe(%s, %s, %s, 'edit', true, null, null, 10, 100, 'security-lab')",
             [r["id"], r["adapter"], r["spec"]["vendor_model"]])
        d.su("update public.model_registry set availability='beta' where id=%s", [r["id"]])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 0.01, 0) "
         "on conflict (unit) do update set credits_per_unit = 0.01, margin = 0")
    for m, (unit, c, mg) in MODELS.items():
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, %s) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin", [unit, c, mg])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_rtier_image_low', 1, 0), ('model_rtier_image_high', 5, 0)")
    d.src = reg_asset(d, ORG_A, "image", "image/png")
    d.src_b = reg_asset(d, ORG_B, "image", "image/png")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def reg_asset(d, org, kind, mime, *, job=None, parent=None):
    aid = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, %s, %s, 1000, %s, 'generated', p_width => 640, p_height => 480, "
          "p_provenance => %s::jsonb, p_parent_asset_id => %s)",
          [aid, org, kind, mime, uuid.uuid4().hex * 2, json.dumps({"job_id": job or "seed"}), parent])
    return aid


def problem(db, cap, p):
    return db.su("select public.creative_params_problem(%s, %s::jsonb)", [cap, json.dumps(p)])[0][0]


def quote(db, uid, org, model, p, cap="edit"):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,%s,%s,%s::jsonb)", [org, cap, model, json.dumps(p)])[0][0]


def create(db, uid, org, model, p, maxc=1000, key=None, cap="edit"):
    return db.act("authenticated", uid,
                  "select public.create_creative_job(%s,%s,%s,%s::jsonb,'exact',%s::text,%s::numeric)",
                  [org, cap, model, json.dumps(p), key, maxc])[0][0]


def drain(db):
    """End every job that still holds credits (queued, or parked by an earlier test) so the plan's one parallel run is free."""
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for jid, worker in db.su("select id::text, worker_id from public.creative_jobs "
                             "where worker_id is not null and status in ('running','provider_pending','processing')"):
        svc(db, "select public.finish_creative_job(%s,%s,false,null,null,'test_drain','drained')", [jid, worker])


def account(db, org):
    b, r = db.su("select balance, reserved from public.credit_accounts where org_id=%s", [org])[0]
    return Decimal(b), Decimal(r)


def ledger(db, ref):
    return db.su("select kind, amount from public.credit_transactions where job_id=%s order by id", [ref])


def outcomes(job_params, statuses, codes=None):
    """The worker's report for the params' regions: statuses is a list of applied / failed / refused."""
    out = []
    for r, st in zip(job_params["regions"], statuses):
        o = {"id": r["id"], "status": st}
        if st != "applied":
            o["code"] = (codes or {}).get(r["id"], "provider_error")
        out.append(o)
    return {"regions": out}


def run_to_processing(db, p, *, model="rimg", org=ORG_A, uid=UA, worker="w-region", stored=True):
    """Create the job, claim it as the worker, walk it to `processing` as the worker does, and store (and attach) the one result."""
    drain(db)
    j = create(db, uid, org, model, p)["job"]
    claimed = svc(db, "select id from public.claim_creative_job(%s)", [worker])
    assert claimed and str(claimed[0][0]) == j["id"], claimed
    assert svc(db, "select public.advance_creative_job(%s,%s,'submitting')", [j["id"], worker])[0][0]
    assert svc(db, "select public.advance_creative_job(%s,%s,'submitted',%s)", [j["id"], worker, f"region:{j['id']}"])[0][0]
    assert svc(db, "select public.advance_creative_job(%s,%s,'processing')", [j["id"], worker])[0][0]
    asset = None
    if stored:
        asset = reg_asset(db, org, "image", "image/png", job=j["id"], parent=p["source_asset_id"])
        assert svc(db, "select public.attach_creative_job_assets(%s,%s,%s::uuid[])", [j["id"], worker, [asset]])[0][0]
    return j, worker, asset


def finish(db, j, worker, result, charge=None):
    return svc(db, "select public.finish_creative_job(%s,%s,true,%s::numeric,%s::jsonb)",
               [j["id"], worker, charge, json.dumps(result)])[0][0]


def P(db, n=1, **kw):
    return params(n, source=db.src, **kw)


# ── the shape is closed ──────────────────────────────────────────────────────

def test_a_well_formed_region_edit_is_accepted_for_one_to_five_regions(db):
    for n in range(1, 6):
        assert problem(db, "edit", P(db, n)) is None, n
    assert problem(db, "edit", P(db, 2, region_feather=2)) is None
    assert problem(db, "edit", P(db, 2, region_feather=8)) is None
    assert problem(db, "edit", P(db, 1, quality="high")) is None


def test_more_than_five_regions_and_none_are_refused(db):
    assert "1 to 5" in problem(db, "edit", params(6, source=db.src))
    assert "1 to 5" in problem(db, "edit", {"source_asset_id": db.src, "regions": []})
    for bad in (None, "x", 3, {"a": 1}, True):
        assert "1 to 5" in problem(db, "edit", {"source_asset_id": db.src, "regions": bad}), bad


@pytest.mark.parametrize("cap", ["t2i", "t2v", "i2v", "tts", "sfx", "music", "upscale", "remove_bg", "voice_change", "dub", "video_upscale",
                                 "describe", "captions", "expand", "relight", "erase", "video_edit", "video_reframe", "video_remove_bg"])
def test_regions_are_refused_on_every_capability_but_edit(db, cap):
    p = {"prompt": "x", "source_asset_id": db.src, "regions": [region()]}
    assert "regions does not apply" in problem(db, cap, p)
    assert "region_feather does not apply" in problem(db, cap, {"prompt": "x", "region_feather": 4})


@pytest.mark.parametrize("extra", [{"prompt": "make it nicer"}, {"negative_prompt": "x"}, {"aspect_ratio": "1:1"}, {"resolution": "720p"},
                                   {"seed": 4}, {"style_kit_id": "00000000-0000-4000-8000-000000000001"}, {"duration_s": 4},
                                   {"voice_id": "abc"}, {"factor": 2}, {"language": "en"}, {"audio": True}, {"look": "warm"},
                                   {"target_language": "en"}, {"target_resolution": "4k"}, {"end_asset_id": "00000000-0000-4000-8000-000000000001"}])
def test_every_other_parameter_next_to_regions_is_refused(db, extra):
    msg = problem(db, "edit", P(db, 1, **extra))
    assert msg and "does not apply to an edit with regions" in msg, (extra, msg)


def test_unknown_parameter_keys_are_still_refused_without_regions(db):
    assert problem(db, "edit", {"prompt": "x", "source_asset_id": db.src, "foo": 1}) == "unknown parameter foo"
    assert problem(db, "t2i", {"prompt": "x", "bar": 1}) == "unknown parameter bar"
    assert problem(db, "edit", P(db, 1, foo=1)) == "unknown parameter foo"


@pytest.mark.parametrize("feather", [1, 9, 0, -1, 4.5, "4", None, True, [4], 100])
def test_feather_outside_two_to_eight_or_not_a_whole_number_is_refused(db, feather):
    assert "region_feather must be a whole number from 2 to 8" == problem(db, "edit", P(db, 1, region_feather=feather))


def test_feather_without_regions_is_refused(db):
    assert problem(db, "edit", {"source_asset_id": db.src, "region_feather": 4}) == "region_feather needs regions"


def test_a_region_edit_has_no_prompt_of_its_own_and_an_ordinary_edit_still_needs_one(db):
    assert problem(db, "edit", {"source_asset_id": db.src}) == "prompt is required"
    assert problem(db, "edit", {"source_asset_id": db.src, "prompt": "x"}) is None
    assert problem(db, "edit", P(db, 1, prompt="x")) == "prompt does not apply to an edit with regions"


def test_the_source_picture_is_still_required_for_a_region_edit(db):
    assert "source_asset_id" in problem(db, "edit", {"regions": [region()]})
    assert "source_asset_id" in problem(db, "edit", {"source_asset_id": "nope", "regions": [region()]})


@pytest.mark.parametrize("mutate,why", [
    (lambda r: r.pop("id"), "id must be"),
    (lambda r: r.pop("name"), "name must be"),
    (lambda r: r.pop("prompt"), "words are required"),
    (lambda r: r.pop("rect"), "rect must be"),
    (lambda r: r.update(brush="00000000-0000-4000-8000-000000000001"), "unknown field brush"),
    (lambda r: r.update(mask="x"), "unknown field mask"),
    (lambda r: r.update(id="R1"), "id must be"),
    (lambda r: r.update(id=""), "id must be"),
    (lambda r: r.update(id="a" * 33), "id must be"),
    (lambda r: r.update(id="a b"), "id must be"),
    (lambda r: r.update(id=7), "id must be"),
    (lambda r: r.update(id=None), "id must be"),
    (lambda r: r.update(name=""), "name must be"),
    (lambda r: r.update(name="   "), "name must be"),
    (lambda r: r.update(name="x" * 61), "name must be"),
    (lambda r: r.update(name="two\nlines"), "name must be"),
    (lambda r: r.update(name="tab\there"), "name must be"),
    (lambda r: r.update(name="nel\u0085x"), "name must be"),
    (lambda r: r.update(name=5), "name must be"),
    (lambda r: r.update(prompt=""), "words are required"),
    (lambda r: r.update(prompt="    "), "words are required"),
    (lambda r: r.update(prompt="  \t "), "plain text on one line"),
    (lambda r: r.update(prompt=None), "words are required"),
    (lambda r: r.update(prompt=3), "words are required"),
    (lambda r: r.update(prompt="x" * 1001), "plain text on one line"),
    (lambda r: r.update(prompt="line one\nline two"), "plain text on one line"),
    (lambda r: r.update(prompt="sep arated"), "plain text on one line"),
    (lambda r: r.update(prompt="sep arated"), "plain text on one line"),
    (lambda r: r.update(prompt="bell\u0007x"), "plain text on one line"),
    (lambda r: r.update(rect=None), "rect must be"),
    (lambda r: r.update(rect=[1, 2, 3, 4]), "rect must be"),
    (lambda r: r.update(rect={"x": 1, "y": 1, "w": 40}), "whole pixels"),
    (lambda r: r.update(rect={"x": 1, "y": 1, "w": 40, "h": 30, "z": 1}), "rect has x, y, w and h only"),
    (lambda r: r.update(rect={"x": -1, "y": 0, "w": 40, "h": 30}), "whole pixels"),
    (lambda r: r.update(rect={"x": 0, "y": -5, "w": 40, "h": 30}), "whole pixels"),
    (lambda r: r.update(rect={"x": 0, "y": 0, "w": 15, "h": 30}), "whole pixels"),
    (lambda r: r.update(rect={"x": 0, "y": 0, "w": 40, "h": 0}), "whole pixels"),
    (lambda r: r.update(rect={"x": 0.5, "y": 0, "w": 40, "h": 30}), "whole pixels"),
    (lambda r: r.update(rect={"x": "0", "y": 0, "w": 40, "h": 30}), "whole pixels"),
    (lambda r: r.update(rect={"x": None, "y": 0, "w": 40, "h": 30}), "whole pixels"),
    (lambda r: r.update(rect={"x": 0, "y": 0, "w": 32769, "h": 30}), "whole pixels"),
    (lambda r: r.update(rect={"x": 32760, "y": 0, "w": 100, "h": 30}), "larger than any picture"),
    (lambda r: r.update(rect={"x": 0, "y": 32760, "w": 40, "h": 100}), "larger than any picture"),
    (lambda r: r.update(rect={"x": 32753, "y": 0, "w": 16, "h": 16}), "larger than any picture"),
    (lambda r: r.update(rect={"x": 0, "y": 32753, "w": 16, "h": 16}), "larger than any picture"),
])
def test_a_malformed_region_is_refused_with_its_reason(db, mutate, why):
    p = P(db, 2)
    mutate(p["regions"][1])
    msg = problem(db, "edit", p)
    assert msg and why in msg and msg.startswith("region 2"), (msg, why)


def test_a_non_object_region_and_a_duplicate_id_are_refused(db):
    p = P(db, 2)
    p["regions"][1] = "not an object"
    assert problem(db, "edit", p) == "region 2 must be an object"
    p = P(db, 2)
    p["regions"][1]["id"] = p["regions"][0]["id"]
    assert problem(db, "edit", p) == "region 2: id is used twice"


def test_the_edges_of_the_closed_shape_are_accepted(db):
    r = region(1, id="a" * 32, name="n" * 60, prompt="p" * 1000, rect={"x": 0, "y": 0, "w": 16, "h": 16})
    assert problem(db, "edit", {"source_asset_id": db.src, "regions": [r]}) is None
    r = region(1, id="0-_", rect={"x": 32768 - 16, "y": 32768 - 16, "w": 16, "h": 16})
    assert problem(db, "edit", {"source_asset_id": db.src, "regions": [r]}) is None


# ── without the new keys nothing changed ─────────────────────────────────────

def _old_bodies(db):
    def body(path, name):
        m = re.search(r"create or replace function public\.%s\(.*?\n\$\$;\n" % name, path.read_text(), re.S)
        return m.group(0).replace(f"public.{name}(", f"public.zz_old_{name}(", 1)
    db.su(body(M0100, "creative_params_problem"))
    db.su(body(M0099, "creative_quantity"))


def test_a_request_without_the_new_keys_is_judged_and_priced_as_before_0126(db):
    _old_bodies(db)
    caps = ["t2i", "t2v", "i2v", "tts", "sfx", "music", "edit", "upscale", "remove_bg", "voice_change", "dub", "video_upscale", "describe",
            "captions", "expand", "relight", "erase", "video_edit", "video_reframe", "video_remove_bg", "bogus", ""]
    keys = {"prompt": ["x", "", "  ", 4, "a" * 4001, "line\nbreak"], "negative_prompt": ["n", 3], "aspect_ratio": ["16:9", "bad", 1],
            "resolution": ["720p", "9p"], "duration_s": [4, 0, 61, 2.5], "voice_id": ["abc", "A" * 20], "seed": [1, -1],
            "source_asset_id": [SRC, "x"], "factor": [2, 3, 4], "style_kit_id": [SRC], "target_language": ["uz", "xx"],
            "target_resolution": ["4k", "5k"], "end_asset_id": [SRC], "language": ["en", "zz"], "quality": ["low", "ultra"],
            "audio": [True, "yes"], "look": ["warm", "neon"], "foo": [1], "regions_": [1]}
    corpus = [{}]
    for k, vals in keys.items():
        for v in vals:
            corpus.append({k: v})
            corpus.append({"prompt": "x", "source_asset_id": SRC, k: v})
            corpus.append({"prompt": "x", "source_asset_id": SRC, "duration_s": 5, "aspect_ratio": "16:9", k: v})
    corpus += [None, [], "x", 5]
    diffs = []
    for cap in caps:
        for p in corpus:
            new = db.su("select public.creative_params_problem(%s, %s::jsonb)", [cap, json.dumps(p)])[0][0]
            old = db.su("select public.zz_old_creative_params_problem(%s, %s::jsonb)", [cap, json.dumps(p)])[0][0]
            if new != old:
                diffs.append((cap, p, old, new))
            qn = db.su("select public.creative_quantity(%s, %s::jsonb)", [cap, json.dumps(p)])[0][0] if isinstance(p, dict) and (
                cap != "tts" or isinstance(p.get("prompt"), str)) and (cap not in ("t2v", "sfx", "music", "i2v") or isinstance(p.get("duration_s"), (int, float))) and (
                cap != "upscale" or isinstance(p.get("factor"), (int, float))) else None
            if qn is not None:
                qo = db.su("select public.zz_old_creative_quantity(%s, %s::jsonb)", [cap, json.dumps(p)])[0][0]
                if qn != qo:
                    diffs.append((cap, p, "qty", qo, qn))
    assert not diffs, diffs[:5]


# ── the price, the hold ──────────────────────────────────────────────────────

def test_one_region_costs_exactly_what_an_ordinary_edit_costs(db):
    ordinary = quote(db, UA, ORG_A, "rimg", {"prompt": "x", "source_asset_id": db.src})
    one = quote(db, UA, ORG_A, "rimg", P(db, 1))
    assert (one["credits"], one["quantity"], one["unit"]) == (ordinary["credits"], 1, ordinary["unit"]) == (3, 1, "model_rimg_image")


@pytest.mark.parametrize("n", [1, 2, 3, 4, 5])
def test_n_regions_are_n_units_of_the_models_edit_price(db, n):
    q = quote(db, UA, ORG_A, "rimg", P(db, n))
    assert (q["credits"], q["quantity"]) == (3 * n, n)


def test_the_tier_prices_each_region_and_the_default_is_medium_for_a_model_without_that_tier(db):
    low = quote(db, UA, ORG_A, "rtier", P(db, 3, quality="low"))
    high = quote(db, UA, ORG_A, "rtier", P(db, 3, quality="high"))
    assert (low["credits"], high["credits"], low["quantity"]) == (3, 15, 3)


def test_the_hold_is_the_quote_and_a_replayed_key_holds_nothing_more(db):
    drain(db)
    p = P(db, 3)
    before = account(db, ORG_A)
    j = create(db, UA, ORG_A, "rimg", p, maxc=9, key="region-hold-1")["job"]
    assert (j["quoted_credits"], j["status"], j["params"]["regions"][2]["id"]) == (9, "queued", "r3")
    held = db.su("select amount from public.credit_reservations where job_id=%s", [f"cj:{j['id']}"])
    assert held == [(Decimal("9.00"),)]
    assert account(db, ORG_A) == (before[0], before[1] + 9)
    again = create(db, UA, ORG_A, "rimg", p, maxc=9, key="region-hold-1")
    assert again["replay"] is True and again["job"]["id"] == j["id"]
    assert account(db, ORG_A) == (before[0], before[1] + 9)
    # The same key for other regions is a different request, not a replay.
    st, word, _ = err(lambda: create(db, UA, ORG_A, "rimg", P(db, 2), maxc=9, key="region-hold-1"))
    assert (st, word) == ("NS409", "idempotency_conflict")
    drain(db)
    assert account(db, ORG_A) == before


def test_a_price_above_the_confirmed_maximum_is_refused_and_holds_nothing(db):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "rimg", P(db, 3), maxc=8.99))
    assert (st, word) == ("NS409", "price_changed")
    assert footprint(db, ORG_A) == before


@pytest.mark.parametrize("bad", [lambda d: P(d, 6), lambda d: P(d, 1, prompt="x"), lambda d: P(d, 1, foo=2), lambda d: {"source_asset_id": d.src, "regions": []},
                                 lambda d: P(d, 1, region_feather=99)])
def test_a_refused_request_holds_and_charges_nothing(db, bad):
    drain(db)
    before = (footprint(db, ORG_A), account(db, ORG_A))
    for fn in (quote, create):
        st, word, _ = err(lambda: fn(db, UA, ORG_A, "rimg", bad(db)))
        assert (st, word) == ("NS400", "invalid_params")
    assert (footprint(db, ORG_A), account(db, ORG_A)) == before


def test_another_organizations_picture_is_refused_before_any_hold_even_with_regions(db):
    drain(db)
    before = (footprint(db, ORG_A), account(db, ORG_A))
    st, word, _ = err(lambda: create(db, UA, ORG_A, "rimg", params(2, source=db.src_b)))
    assert (st, word) == ("NS400", "source_unavailable")
    assert (footprint(db, ORG_A), account(db, ORG_A)) == before


def test_regions_on_another_capability_are_refused_by_the_quote_too(db):
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "rimg", {"prompt": "x", "regions": [region()]}, cap="t2i"))
    assert (st, word) == ("NS400", "invalid_params")


# ── settlement per region ────────────────────────────────────────────────────

def _settle(db, n, statuses, *, charge=None, model="rimg", **kw):
    p = P(db, n, **kw)
    drain(db)
    org_before = account(db, ORG_A)
    j, w, asset = run_to_processing(db, p, model=model)
    ref = f"cj:{j['id']}"
    out = finish(db, j, w, {**outcomes(p, statuses), "storage": "library", "asset_ids": [asset] if asset else []}, charge)
    return j, p, out, ref, org_before, asset


def test_all_regions_applied_charges_the_whole_hold(db):
    j, p, out, ref, before, _ = _settle(db, 3, ["applied"] * 3)
    assert (out["status"], out["charged_credits"], out["quoted_credits"]) == ("completed", 9, 9)
    assert [r["status"] for r in out["result"]["regions"]] == ["applied"] * 3
    assert account(db, ORG_A) == (before[0] - 9, before[1])
    assert [k for k, _a in ledger(db, ref)] == ["reserve", "capture"]


@pytest.mark.parametrize("statuses,charged", [
    (["applied", "applied", "failed"], 6),
    (["applied", "failed", "applied"], 6),
    (["failed", "applied", "refused"], 3),
    (["refused", "refused", "applied"], 3),
])
def test_only_the_applied_regions_are_charged_and_the_rest_is_released_once(db, statuses, charged):
    j, p, out, ref, before, _ = _settle(db, 3, statuses)
    assert (out["status"], out["charged_credits"]) == ("completed", charged)
    assert [r["status"] for r in out["result"]["regions"]] == statuses
    assert account(db, ORG_A) == (before[0] - charged, before[1])
    kinds = ledger(db, ref)
    assert [k for k, _a in kinds] == ["reserve", "capture", "release"]
    assert abs(Decimal(kinds[1][1])) == charged
    assert abs(Decimal(kinds[2][1])) == 9 - charged


def test_the_cent_arithmetic_rounds_the_share_up_and_never_exceeds_the_hold(db):
    # 3 regions at 0.0333 = 0.0999 -> 0.10 held; a share of one region is 0.0333.. -> 0.04, of two 0.0666.. -> 0.07
    q = quote(db, UA, ORG_A, "rcents", P(db, 3))
    assert q["credits"] == Decimal("0.10") or float(q["credits"]) == 0.10
    seen = {}
    for k in (1, 2, 3):
        st = ["applied"] * k + ["failed"] * (3 - k)
        j, p, out, ref, before, _ = _settle(db, 3, st, model="rcents")
        seen[k] = Decimal(str(out["charged_credits"]))
        assert seen[k] <= Decimal(str(out["quoted_credits"]))
        assert account(db, ORG_A)[0] == before[0] - seen[k]
    assert seen == {1: Decimal("0.04"), 2: Decimal("0.07"), 3: Decimal("0.10")}


def test_one_region_one_applied_is_the_ordinary_price(db):
    j, p, out, ref, before, _ = _settle(db, 1, ["applied"])
    assert (out["charged_credits"], out["status"]) == (3, "completed")


@pytest.mark.parametrize("status", ["failed", "refused"])
def test_when_no_region_is_applied_nothing_is_charged_and_the_whole_hold_is_released(db, status):
    p = P(db, 3)
    drain(db)
    before = account(db, ORG_A)
    j, w, _ = run_to_processing(db, p, stored=False)
    ref = f"cj:{j['id']}"
    out = finish(db, j, w, outcomes(p, [status] * 3, {"r1": "policy", "r2": "pixel_lock_failed", "r3": "region_out_of_bounds"}))
    assert (out["status"], out["error_code"], out["charged_credits"]) == ("failed", "no_region_applied", 0)
    assert [(r["id"], r["status"], r["code"]) for r in out["result"]["regions"]] == [
        ("r1", status, "policy"), ("r2", status, "pixel_lock_failed"), ("r3", status, "region_out_of_bounds")]
    assert account(db, ORG_A) == before
    assert [k for k, _a in ledger(db, ref)] == ["reserve", "release"]
    assert db.su("select status from public.credit_reservations where job_id=%s", [ref]) == [("released",)]


def test_finishing_again_moves_no_credit_a_second_time(db):
    p = P(db, 3)
    j, w, asset = run_to_processing(db, p)
    ref = f"cj:{j['id']}"
    first = finish(db, j, w, {**outcomes(p, ["applied", "failed", "failed"])})
    after = (account(db, ORG_A), ledger(db, ref))
    for _ in range(3):
        again = finish(db, j, w, {**outcomes(p, ["applied", "applied", "applied"])})
        assert again["charged_credits"] == first["charged_credits"] == 3
        assert [r["status"] for r in again["result"]["regions"]] == ["applied", "failed", "failed"]
    assert (account(db, ORG_A), ledger(db, ref)) == after
    # …nor do a later failure report, an expiry sweep or a cancel.
    svc(db, "select public.finish_creative_job(%s,%s,false,null,null,'late','late')", [j["id"], w])
    svc(db, "select public.expire_creative_jobs()")
    assert (account(db, ORG_A), ledger(db, ref)) == after


def test_an_all_failed_job_is_not_released_a_second_time_by_any_later_call(db):
    p = P(db, 2)
    j, w, _ = run_to_processing(db, p, stored=False)
    ref = f"cj:{j['id']}"
    finish(db, j, w, outcomes(p, ["failed", "failed"]))
    after = (account(db, ORG_A), ledger(db, ref))
    finish(db, j, w, outcomes(p, ["applied", "applied"]))
    svc(db, "select public.finish_creative_job(%s,%s,false,null,null,'late','late')", [j["id"], w])
    svc(db, "select public.expire_creative_jobs()")
    db.act("authenticated", UA, "select public.cancel_creative_job(%s)", [j["id"]])
    assert (account(db, ORG_A), ledger(db, ref)) == after
    assert [k for k, _a in after[1]] == ["reserve", "release"]


def test_a_job_level_failure_is_the_ordinary_full_release(db):
    p = P(db, 3)
    drain(db)
    before = account(db, ORG_A)
    j, w, _ = run_to_processing(db, p, stored=False)
    out = svc(db, "select public.finish_creative_job(%s,%s,false,null,null,'model_not_available','not sellable')", [j["id"], w])[0][0]
    assert (out["status"], out["error_code"], out["charged_credits"]) == ("failed", "model_not_available", 0)
    assert account(db, ORG_A) == before


# ── the worker's report is closed ────────────────────────────────────────────

def _try(db, p, report, **kw):
    j, w, asset = run_to_processing(db, p, **kw)
    ref = f"cj:{j['id']}"
    before = (account(db, ORG_A), ledger(db, ref))
    st, word, _ = err(lambda: finish(db, j, w, report))
    row = db.su("select status, charged_credits from public.creative_jobs where id=%s", [j["id"]])[0]
    assert (account(db, ORG_A), ledger(db, ref)) == before
    assert row[0] == "processing" and row[1] is None, row
    return st, word


@pytest.mark.parametrize("make", [
    lambda p: {},
    lambda p: {"storage": "library"},
    lambda p: {"regions": "applied"},
    lambda p: {"regions": []},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "applied"}, {"id": "r3", "status": "applied"}]},
    lambda p: {"regions": [{"id": "r2", "status": "applied"}, {"id": "r1", "status": "applied"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "zz", "status": "applied"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "ok"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "APPLIED"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": None}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "failed"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "failed", "code": "the vendor said: your key sk-123 is bad"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "failed", "code": "nope"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied", "code": "policy"}, {"id": "r2", "status": "applied"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied", "message": "hi"}, {"id": "r2", "status": "applied"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "ok", "code": "policy"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "charged", "code": "policy"}]},
    lambda p: {"regions": [{"id": "r1", "status": "applied", "charge": 99}, {"id": "r2", "status": "applied"}]},
    lambda p: {"regions": [1, 2]},
    lambda p: {"regions": [None, None]},
])
def test_a_report_that_is_not_one_closed_outcome_per_region_in_order_is_refused_and_nothing_moves(db, make):
    p = P(db, 2)
    assert _try(db, p, make(p))[0] == "22023"


def test_words_over_the_sixteen_kilobyte_params_cap_are_refused_with_the_databases_own_sentence(db):
    # 5 regions of 1000 CJK characters (3 bytes each) pass every per-field rule and still exceed the 16 KB the database stores
    p = P(db, 5)
    for r in p["regions"]:
        r["prompt"] = "日" * 1000
        r["name"] = "日" * 60
    assert problem(db, "edit", p) == "params are too large"
    st, word, _ = err(lambda: create(db, UA, ORG_A, "rimg", p))
    assert (st, word) == ("NS400", "invalid_params")


def test_the_stored_result_is_built_from_an_allow_list_so_no_free_text_survives(db):
    p = P(db, 2)
    j, w, asset = run_to_processing(db, p)
    sha = "ab" * 32
    report = {**outcomes(p, ["applied", "failed"]), "feather": 6, "storage": "library", "asset_ids": [asset],
              "files": [{"name": "output_0.png", "mime": "image/png", "bytes": 1234, "sha256": sha, "path": "/srv/secret/x.png", "note": "hi"}],
              "note": "free text for every member to read", "error": "sk-live-SECRET", "style": {"a": ["b"]},
              "regions_extra": 1}
    report["regions"][1]["code"] = "policy"
    out = finish(db, j, w, report)
    assert sorted(out["result"]) == ["asset_ids", "feather", "files", "regions", "storage"], out["result"]
    assert out["result"]["files"] == [{"name": "output_0.png", "mime": "image/png", "bytes": 1234, "sha256": sha}]
    assert out["result"]["feather"] == 6 and out["result"]["asset_ids"] == [asset] and out["result"]["storage"] == "library"
    stored = db.su("select result::text from public.creative_jobs where id=%s", [j["id"]])[0][0]
    for leak in ("secret", "free text", "sk-live", "regions_extra", "/srv"):
        assert leak not in stored, leak


@pytest.mark.parametrize("extra", [
    {"feather": 99}, {"feather": "4"}, {"feather": 1.5}, {"storage": "somewhere else"}, {"storage": 1},
    {"asset_ids": "x"}, {"asset_ids": ["not an id"]}, {"asset_ids": [str(uuid.uuid4())] * 17},
    {"files": "x"}, {"files": [{"name": "a b", "mime": "image/png", "bytes": 1, "sha256": "ab" * 32}]},
    {"files": [{"name": "a.png", "mime": "image/png", "bytes": -1, "sha256": "ab" * 32}]},
    {"files": [{"name": "a.png", "mime": "image/png", "bytes": 1, "sha256": "zz"}]},
    {"files": [{"name": "a.png", "mime": "text with spaces", "bytes": 1, "sha256": "ab" * 32}]},
    {"files": [{"name": "a.png", "mime": "image/png", "sha256": "ab" * 32}]},
    {"files": ["x"]}, {"files": [{"name": "a.png", "mime": "image/png", "bytes": 1, "sha256": "ab" * 32}] * 17},
])
def test_a_report_with_a_malformed_allow_listed_key_is_refused_and_nothing_moves(db, extra):
    p = P(db, 1)
    assert _try(db, p, {**outcomes(p, ["applied"]), **extra})[0] == "22023"


def test_every_closed_reason_is_accepted_and_nothing_else(db):
    p = P(db, 2)
    for code in CODES:
        j, w, _ = run_to_processing(db, p)
        out = finish(db, j, w, {"regions": [{"id": "r1", "status": "applied"}, {"id": "r2", "status": "failed", "code": code}]})
        assert out["result"]["regions"][1]["code"] == code and out["charged_credits"] == 3, code


def test_a_charge_the_worker_names_cannot_differ_from_what_the_regions_make(db):
    p = P(db, 3)
    ok = ["applied", "failed", "failed"]
    j, w, _ = run_to_processing(db, p)
    ref = f"cj:{j['id']}"
    before = (account(db, ORG_A), ledger(db, ref))
    for charge in (9, 0, 0.01, 3.01, 2.99, 6, 100, -1):
        st, word, _ = err(lambda c=charge: finish(db, j, w, outcomes(p, ok), charge=c))
        assert st == "22023", charge
    assert (account(db, ORG_A), ledger(db, ref)) == before
    out = finish(db, j, w, outcomes(p, ok), charge=3)
    assert (out["status"], out["charged_credits"]) == ("completed", 3)


def test_nothing_is_charged_for_a_result_that_was_never_stored(db):
    p = P(db, 2)
    assert _try(db, p, outcomes(p, ["applied", "applied"]), stored=False)[0] == "22023"


def test_the_stored_result_must_be_exactly_one_picture(db):
    p = P(db, 2)
    j, w, first = run_to_processing(db, p)
    second = reg_asset(db, ORG_A, "image", "image/png", job=j["id"], parent=p["source_asset_id"])
    assert svc(db, "select public.attach_creative_job_assets(%s,%s,%s::uuid[])", [j["id"], w, [first, second]])[0][0]
    st, word, _ = err(lambda: finish(db, j, w, outcomes(p, ["applied", "applied"])))
    assert st == "22023"


def test_a_quote_that_does_not_match_its_params_charges_nothing(db):
    # The hold was made for 3 regions; the params are tampered (as the superuser) to carry 2: the settlement refuses to charge on that quote.
    p = P(db, 3)
    drain(db)
    before = account(db, ORG_A)
    j, w, _ = run_to_processing(db, p)
    ref = f"cj:{j['id']}"
    db.su("update public.creative_jobs set quantity = 2 where id=%s", [j["id"]])
    out = finish(db, j, w, outcomes(p, ["applied", "applied", "applied"]))
    assert (out["status"], out["error_code"], out["charged_credits"]) == ("failed", "region_quote_mismatch", 0)
    assert account(db, ORG_A) == before
    assert [k for k, _a in ledger(db, ref)] == ["reserve", "release"]


def test_another_worker_cannot_settle_the_job(db):
    p = P(db, 1)
    j, w, _ = run_to_processing(db, p)
    st, word, _ = err(lambda: finish(db, j, "w-other", outcomes(p, ["applied"])))
    assert st == "42501"


def test_an_ordinary_edit_is_settled_exactly_as_before(db):
    drain(db)
    before = account(db, ORG_A)
    j = create(db, UA, ORG_A, "rimg", {"prompt": "x", "source_asset_id": db.src})["job"]
    svc(db, "select id from public.claim_creative_job('w-plain')")
    svc(db, "select public.advance_creative_job(%s,'w-plain','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w-plain','submitted','task-1')", [j["id"]])
    out = svc(db, "select public.finish_creative_job(%s,'w-plain',true,null,%s::jsonb)", [j["id"], json.dumps({"files": []})])[0][0]
    assert (out["status"], out["charged_credits"]) == ("completed", 3) and out["result"] == {"files": []}
    assert account(db, ORG_A) == (before[0] - 3, before[1])
    # an ordinary edit may still be charged less than the hold by the worker, as before
    j2 = create(db, UA, ORG_A, "rimg", {"prompt": "x", "source_asset_id": db.src})["job"]
    svc(db, "select id from public.claim_creative_job('w-plain')")
    svc(db, "select public.advance_creative_job(%s,'w-plain','submitting')", [j2["id"]])
    svc(db, "select public.advance_creative_job(%s,'w-plain','submitted','task-2')", [j2["id"]])
    out = svc(db, "select public.finish_creative_job(%s,'w-plain',true,1.5)", [j2["id"]])[0][0]
    assert out["charged_credits"] == Decimal("1.5") or float(out["charged_credits"]) == 1.5


# ── the doors ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA)])
def test_no_api_role_reaches_the_new_functions_or_the_settlement(db, role, uid):
    for q, a in [("select public.creative_regions_problem(%s::jsonb)", [json.dumps(P(db, 1))]),
                 ("select public.creative_region_outcomes(%s::jsonb, %s::jsonb)", [json.dumps(P(db, 1)), json.dumps(outcomes(P(db, 1), ["applied"]))]),
                 ("select public.finish_creative_job(%s,'w',true)", [str(uuid.uuid4())]),
                 ("select public.creative_params_problem('edit', %s::jsonb)", [json.dumps(P(db, 1))]),
                 ("select public.creative_quantity('edit', %s::jsonb)", [json.dumps(P(db, 1))])]:
        st, word, _ = err(lambda q=q, a=a: db.act(role, uid, q, a))
        assert st == "42501", (q, st, word)


def test_the_grants_are_what_0036_and_0075_left(db):
    rows = db.su("""select p.oid::regprocedure::text,
                           has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                           has_function_privilege('service_role', p.oid, 'EXECUTE')
                      from pg_proc p where p.oid in ('public.creative_regions_problem(jsonb)'::regprocedure,
                        'public.creative_region_outcomes(jsonb,jsonb)'::regprocedure, 'public.creative_params_problem(text,jsonb)'::regprocedure,
                        'public.creative_quantity(text,jsonb)'::regprocedure,
                        'public.finish_creative_job(uuid,text,boolean,numeric,jsonb,text,text)'::regprocedure) order by 1""")
    got = {r[0]: r[1:] for r in rows}
    assert len(got) == 5
    for name, (anon, auth, service) in got.items():
        assert (anon, auth) == (False, False), name
        assert service == name.startswith("finish_creative_job"), name


# ── the file itself: drift guard, replay, rollback ───────────────────────────

def _fresh(admin, label):
    name = f"ns_region_{label}_{uuid.uuid4().hex[:6]}"
    return name, Db(sec_db.build(admin, name))


def _md5s(d):
    return {r[0]: r[1] for r in d.su(
        """select p.proname, md5(regexp_replace(p.prosrc, '\\s+', ' ', 'g')) from pg_proc p
            where p.oid in ('public.creative_params_problem(text,jsonb)'::regprocedure, 'public.creative_quantity(text,jsonb)'::regprocedure,
                            'public.finish_creative_job(uuid,text,boolean,numeric,jsonb,text,text)'::regprocedure)""")}


def test_a_replay_changes_nothing_and_a_foreign_body_is_refused(db):
    admin = db.admin
    name, d = _fresh(admin, "guard")
    try:
        text = MIGRATION.read_text(encoding="utf-8")
        mine = _md5s(d)  # the lab applied 0126 already
        d.su(text)
        assert _md5s(d) == mine
        # Something applied by hand after 0100: the file must refuse, naming the function, and change nothing.
        d.su("create or replace function public.creative_quantity(p_capability text, p_params jsonb) returns numeric "
             "language sql immutable as $$ select 1::numeric $$")
        with pytest.raises(psycopg.Error) as e:
            d.su(text)
        assert "creative_quantity() that is neither 0099's body nor 0126's" in str(e.value)
        assert _md5s(d)["creative_params_problem"] == mine["creative_params_problem"]
    finally:
        sec_db.drop_database(admin, name)


def test_the_rollback_restores_the_three_bodies_refuses_while_a_region_edit_is_in_flight_and_0126_applies_again(db):
    admin = db.admin
    name, d = _fresh(admin, "roll")
    try:
        mine = _md5s(d)
        rb = ROLLBACK.read_text(encoding="utf-8")
        text = MIGRATION.read_text(encoding="utf-8")
        d.su("insert into auth.users (id, email) values (%s,'r5@x.io')", [UA])
        d.su("insert into public.organizations (id, name, slug) values (%s,'R5','org-r5')", [ORG_A])
        d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'r5@x.io','owner')", [ORG_A, UA])
        d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
        d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps([{"id": "rm-edit", "display_name": "rm",  "provider": "acme", "adapter": "image.acme",
             "capabilities": ["edit"], "credit_unit": "model_m_image", "entitlement": "any", "spec": {"vendor_model": "acme-m", "output": "image"}}])])
        d.su("select public.record_model_probe('rm-edit','image.acme','acme-m','edit',true,null,null,10,100,'security-lab')")
        d.su("update public.model_registry set availability='beta' where id='rm-edit'")
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_m_image', 1, 0), ('job_minimum', 0.01, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit")
        src = reg_asset(d, ORG_A, "image", "image/png")
        job = d.act("authenticated", UA, "select public.create_creative_job(%s,'edit','rm-edit',%s::jsonb,'exact',null,10)",
                    [ORG_A, json.dumps(params(2, source=src))])[0][0]["job"]
        with pytest.raises(psycopg.Error) as e:
            d.su(rb)
        assert "a region edit is still in flight" in str(e.value)
        assert _md5s(d) == mine
        d.act("authenticated", UA, "select public.cancel_creative_job(%s)", [job["id"]])
        d.su(rb)
        before = {"creative_params_problem": "8f5525f8a44442ab477c412c3d013fee", "creative_quantity": "e6e1d85bcd4a4cde42f94546a697e352",
                  "finish_creative_job": "37e306c9def112dd53d83d9eba0a1c49"}
        assert _md5s(d) == before
        assert d.su("select to_regprocedure('public.creative_regions_problem(jsonb)') is null")[0][0]
        # The rolled-back database refuses regions again, and 0126 applies on it once more.
        assert d.su("select public.creative_params_problem('edit', %s::jsonb)", [json.dumps(params(1, source=src))])[0][0] == "unknown parameter regions"
        d.su(text)
        assert _md5s(d) == mine
    finally:
        sec_db.drop_database(admin, name)
