"""The adult attestation (0192) on the doors that do not go through the Studio's own quote: a connected assistant's Studio (0191),
the connection's video (0094's oauth_create_video) and the paid downloads (request_download, api_request_download).

The owner's rule is "under 18 gets nothing", and a model whose vendor's terms are 18+ needs an adult answer. What would break, and
which test says so:

  a minor's assistant gets a Studio quote or a job                             test_a_minor_gets_no_connector_*
  an adults-only model is quoted for an assistant whose person never answered  test_an_adults_only_model_needs_an_adult_answer_*
  the refusal comes back as a 500, or after a quote is stored or a hold taken  (each test checks the typed code and the footprint)
  an adult is refused                                                           test_an_adult_quotes_and_starts_the_adults_only_model
  the connector hides an adults-only model instead of marking it               test_the_connector_lists_the_adults_only_model_marked
  a quote made before the answer still spends after "under 18"                 test_a_quote_made_before_the_answer_does_not_spend_after_it
  a minor's connection starts a video (it used to answer a 500)                test_a_minor_connection_gets_a_typed_403_for_a_video
  a minor buys a download on the site or through a key                         test_a_minor_buys_no_download_*
"""

from __future__ import annotations

import json
import os
import uuid

import psycopg
import pytest

import sec_db
import test_sec_mcp_oauth_creative as occ
from sec_db import ANON, as_superuser
from sec_api_refund_lab import call, customer, topup
from sec_api_refund_lab import ok as api_ok

#: command-center/lib/age.ts AGE_TERMS_VERSION, the one version record_adult_attestation accepts.
TERMS = "2026-11-20"
U_ADULT = str(uuid.UUID(int=0xAD192))   # an admin of org A who confirmed 18+
U_LATE = str(uuid.UUID(int=0xAD193))    # an owner of org B who quotes first and answers "under 18" after
#: On for assistants, as img-on, and its vendor's terms are 18+.
ADULT_MODEL = ("img-adult", ["t2i"], {"api_exposure": "web_mcp", "mcp_oauth_exposure": True, "requires_adult": True})


def attest(db, uid, adult):
    db.act("authenticated", uid, "select public.record_adult_attestation(%s, %s, 'welcome')", [adult, TERMS])


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_adult_doors_{uuid.uuid4().hex[:8]}"
    d = occ.Db(sec_db.build(admin, name))
    # 0191's own lab seed, with one more model: setup() reads its module's MODELS, so it is swapped for the call only.
    models = occ.MODELS
    occ.MODELS = [*models, ADULT_MODEL]
    try:
        occ.setup(d)
    finally:
        occ.MODELS = models
    d.su("insert into auth.users (id, email) values (%s, 'adult@d192.io'), (%s, 'late@d192.io')", [U_ADULT, U_LATE])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'adult@d192.io', 'admin'), "
         "(%s, %s, 'late@d192.io', 'admin')", [occ.ORG_A, U_ADULT, occ.ORG_B, U_LATE])
    attest(d, U_ADULT, True)
    attest(d, occ.UB, False)   # org B's owner said they are under 18; org A's owner (UA) never answered
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def footprint(db, org):
    """What a refused quote or start could leave behind: stored quotes, jobs, open holds, the account."""
    return (db.su("select count(*) from public.oauth_creative_quotes where org_id = %s", [org])[0][0],
            db.su("select count(*) from public.creative_jobs where org_id = %s", [org])[0][0],
            db.su("select count(*) from public.credit_reservations where org_id = %s and status = 'open'", [org])[0][0],
            occ.credits(db, org))


# ── the connector's list: marked, never hidden ─────────────────────────────

def test_the_connector_lists_the_adults_only_model_marked(db):
    tok, _g = occ.connection(db, occ.UA, occ.ORG_A)
    out = occ.models(db, tok, "t2i")
    listed = {m["id"]: m for m in out["data"]["models"]}
    assert "img-adult" in listed, "an adults-only model is listed, never hidden"
    assert listed["img-adult"]["spec"].get("requires_adult") is True
    assert "requires_adult" not in listed["img-on"]["spec"]


# ── the quote: typed refusals, nothing stored ──────────────────────────────

def test_an_adults_only_model_needs_an_adult_answer_at_the_connector_quote(db):
    tok, _g = occ.connection(db, occ.UA, occ.ORG_A)
    before = footprint(db, occ.ORG_A)
    out = occ.quote(db, tok, model="img-adult")
    assert out["status"] == 428 and occ.code(out) == "adult_attestation_required", out
    assert "Confirm you are 18 or older in the app" in out["error"]["message"]
    assert footprint(db, occ.ORG_A) == before
    # The control: the same person, a model without the flag.
    assert occ.quote(db, tok)["status"] == 201


def test_a_minor_gets_no_connector_quote(db):
    tok, _g = occ.connection(db, occ.UB, occ.ORG_B)
    before = footprint(db, occ.ORG_B)
    for model in ("img-on", "img-adult"):
        out = occ.quote(db, tok, model=model)
        assert out["status"] == 403 and occ.code(out) == "adult_only_service", (model, out)
    assert footprint(db, occ.ORG_B) == before


def test_an_adult_quotes_and_starts_the_adults_only_model(db):
    tok, _g = occ.connection(db, U_ADULT, occ.ORG_A)
    q = occ.quote(db, tok, model="img-adult")
    assert q["status"] == 201, q
    out = occ.create(db, tok, q["data"]["quote_id"], f"adult-{uuid.uuid4().hex[:8]}")
    assert out["status"] == 201, out


def test_a_quote_made_before_the_answer_does_not_spend_after_it(db):
    """create spends a stored quote; create_creative_job asks again, and its refusal comes back typed, with nothing held."""
    tok, _g = occ.connection(db, U_LATE, occ.ORG_B)
    q = occ.quote(db, tok)
    assert q["status"] == 201, q
    attest(db, U_LATE, False)
    before = footprint(db, occ.ORG_B)
    out = occ.create(db, tok, q["data"]["quote_id"], f"late-{uuid.uuid4().hex[:8]}")
    assert out["status"] == 403 and occ.code(out) == "adult_only_service", out
    assert footprint(db, occ.ORG_B) == before
    assert db.su("select job_id from public.oauth_creative_quotes where id = %s", [q["data"]["quote_id"]])[0][0] is None


# ── the connection's video (0094): a typed 403, not the 500 it used to be ──

def test_a_minor_connection_gets_a_typed_403_for_a_video(db):
    db.su("insert into public.channels (channel_id, name, niche, status, org_id, agent_config, credential_ref) values "
          "('chan-d192', 'D', 'tech', 'ACTIVE', %s, '{}', '{\"verified_at\":\"2026-09-01\"}') on conflict do nothing", [occ.ORG_B])
    tok, _g = occ.connection(db, occ.UB, occ.ORG_B)
    before = (footprint(db, occ.ORG_B), db.su("select count(*) from public.render_jobs where channel_id = 'chan-d192'")[0][0])
    out = db.act("anon", None, "select public.oauth_create_video(%s, 'chan-d192', %s::jsonb, %s, null)",
                 [tok, json.dumps({"topic": "lab", "duration": 60}), f"v-{uuid.uuid4().hex[:8]}"])[0][0]
    assert out["status"] == 403 and occ.code(out) == "adult_only_service", out
    assert (footprint(db, occ.ORG_B), db.su("select count(*) from public.render_jobs where channel_id = 'chan-d192'")[0][0]) == before


# ── the paid downloads (the owner's decision: a minor buys none) ───────────

def _download_prices(s):
    s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('download_1080p_minute', 1, 0), "
           "('download_minimum', 1, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit returning 1")


def test_a_minor_buys_no_download_on_the_site(conn):
    with as_superuser(conn, commit=False) as s:
        _download_prices(s)
        minor, adult = customer(s), customer(s)
        for c in (minor, adult):
            s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        api_ok(call(s, minor.actor, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS]))
        ledger = s.value("select count(*) from public.credit_transactions where org_id = %s", [minor.org])
        out = call(s, minor.actor, "select public.request_download(%s, '1080p', null)", [minor.video])
        assert not out.ok and out.sqlstate == "NS400" and out.error.startswith("adult_only_service"), out
        assert s.value("select count(*) from public.download_requests where org_id = %s", [minor.org]) == 0
        assert s.value("select count(*) from public.credit_transactions where org_id = %s", [minor.org]) == ledger
        # The control: an account that never answered buys it (downloads name no adults-only model).
        got = api_ok(call(s, adult.actor, "select public.request_download(%s, '1080p', null)", [adult.video]))
        assert got["status"] == "queued" and got["charged"] > 0, got


def test_a_minor_buys_no_download_through_a_key(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        api_ok(call(s, c.actor, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS]))
        topup(s, c, 5000)
        body = api_ok(call(s, ANON, "select public.api_request_download(%s, %s, '1080p', null, null, null)", [c.key_hash, c.video]))
        assert body["status"] == 403 and body["error"]["code"] == "adult_only_service", body
        assert s.value("select count(*) from public.api_holds where org_id = %s", [c.org]) == 0
        assert s.value("select count(*) from public.download_requests where org_id = %s", [c.org]) == 0
