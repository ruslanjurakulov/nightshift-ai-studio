"""0196: a video run spends on Google (its research and script are always Gemini's), so it needs an adult answer; a failover never picks
an adults-only model for a requester without one; the router says how many it left out.

What would break, and which test says so:
  a member who never answered queues a run, or gets one through a key         test_a_member_without_an_answer_*
  the scheduled run (no session) is refused                                    test_the_scheduled_run_with_no_session_is_never_refused
  an adult (the demo and owner accounts, once they answered) is refused        test_an_adult_*
  the minor rule weakened                                                      test_a_minor_is_still_refused_every_run
  the rule reads a run as "no Google" (an odd provider shape, a repair)        test_which_stages_go_to_google
  a failover hands a job to a model flagged adults-only after it was routed    test_a_failover_skips_an_adults_only_candidate_*
  a quality pick hides that it skipped an adults-only model (rule 5)           test_the_route_says_how_many_it_left_out
"""

from __future__ import annotations

import json
import os
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, as_superuser
from sec_api_refund_lab import call, customer, topup
from sec_api_refund_lab import ok as api_ok

TERMS = "2026-11-20"


def _prices(s):
    s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0), ('video_minute', 2, 0) "
           "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 returning 1")


def _queue(s, who, c, ref):
    return call(s, who, "insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref) "
                        "values (%s, 'daily', %s::jsonb, %s, %s) returning id",
                [c.channel, json.dumps({"topic": "lab", "duration": 60}), who.uid, ref])


def _answer(s, c, adult):
    api_ok(call(s, c.actor, "select public.record_adult_attestation(%s, %s, 'welcome')", [adult, TERMS]))


# ── the rule ───────────────────────────────────────────────────────────────

def test_which_stages_go_to_google(conn):
    with as_superuser(conn, commit=False) as s:
        g = lambda kind, p: s.value("select public.render_run_google_stages(%s, %s::jsonb)", [kind, json.dumps(p)])
        assert g("daily", {}) == ["text"]
        assert g("daily", {"video_provider": "minimax", "image_provider": "pexels"}) == ["text"]
        assert g("daily", {"video_provider": "veo", "image_provider": "nano-banana"}) == ["text", "video", "image"]
        assert g("series_plan", {}) == ["text"]
        assert g("repair", {}) == ["repair"]                                   # not read here: fails closed
        assert g("daily", {"video_provider": 7, "image_provider": ["x"]}) == ["text", "video", "image"]


# ── Run now on the queue (the browser's insert) ───────────────────────────

def test_a_member_without_an_answer_queues_no_run(conn):
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        ref = "rj-" + uuid.uuid4().hex[:12]
        api_ok(call(s, c.actor, "select public.reserve_credits(%s, %s, 10)", [c.org, ref]))
        out = _queue(s, c.actor, c, ref)
        assert not out.ok and out.sqlstate == "NS400" and out.error.startswith("adult_attestation_required"), out
        assert s.value("select count(*) from public.render_jobs where channel_id = %s", [c.channel]) == 0


def test_an_adult_queues_a_run_as_before(conn):
    """The demo and owner accounts, once they answered 18+, run normally."""
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        _answer(s, c, True)
        ref = "rj-" + uuid.uuid4().hex[:12]
        api_ok(call(s, c.actor, "select public.reserve_credits(%s, %s, 10)", [c.org, ref]))
        out = _queue(s, c.actor, c, ref)
        assert out.ok, out


def test_a_minor_is_still_refused_every_run(conn):
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        ref = "rj-" + uuid.uuid4().hex[:12]
        api_ok(call(s, c.actor, "select public.reserve_credits(%s, %s, 10)", [c.org, ref]))
        _answer(s, c, False)
        out = _queue(s, c.actor, c, ref)
        assert not out.ok and out.error.startswith("adult_only_service"), out


def test_the_scheduled_run_with_no_session_is_never_refused(conn):
    """The scheduler, the dispatcher and the worker write with no person's session: a workspace where nobody answered still gets its
    scheduled daily run (it is not a person's request; the owner's own rules for the schedule are unchanged)."""
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        for who in (None, SERVICE):
            c = customer(s)   # nobody here ever answered (one workspace each: a hold is one of the plan's parallel runs)
            s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
            # The scheduler's own hold first (a trusted caller), then its row, exactly as a paid scheduled run.
            ref = "rj-" + uuid.uuid4().hex[:12]
            q_hold = "select public.reserve_credits(%s, %s, 10)"
            q_row = "insert into public.render_jobs (channel_id, kind, params, credit_ref) values (%s, 'daily', '{\"duration\": 60}'::jsonb, %s) returning id"
            if who is None:
                api_ok(s.run(q_hold, [c.org, ref]))
                ok = s.run(q_row, [c.channel, ref])
            else:
                api_ok(call(s, who, q_hold, [c.org, ref]))
                ok = call(s, who, q_row, [c.channel, ref])
            assert ok.ok, (who, ok)


# ── the video API and the MCP connection's video: a typed 428 ─────────────

def test_a_member_without_an_answer_gets_a_typed_428_through_a_key(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        topup(s, c, 5000)
        body = api_ok(call(s, ANON, "select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                           [c.key_hash, c.channel, json.dumps({"topic": "lab", "duration": 60})]))
        assert body["status"] == 428 and body["error"]["code"] == "adult_attestation_required", body
        assert "Confirm you are 18 or older on Create" in body["error"]["message"]
        assert '"google_stages": ["text"]' in json.dumps(body), body
        assert s.value("select count(*) from public.api_holds where org_id = %s", [c.org]) == 0
        assert s.value("select count(*) from public.render_jobs where channel_id = %s", [c.channel]) == 0


def test_an_adult_gets_the_video_through_a_key(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        topup(s, c, 5000)
        _answer(s, c, True)
        body = api_ok(call(s, ANON, "select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                           [c.key_hash, c.channel, json.dumps({"topic": "lab", "duration": 60})]))
        assert body["status"] == 201, body


# ── the failover and the router (a lab of their own; it commits) ──────────

ORG = "aaaaaaaa-0000-0000-0000-000000000196"
U_NONE = str(uuid.UUID(int=0x196A))
U_ADULT = str(uuid.UUID(int=0x196B))
MODELS = [("img-first", {"quality_tier": 3, "speed_tier": 5}, 1), ("img-second", {"quality_tier": 3, "speed_tier": 3}, 1),
          ("img-best-adult", {"quality_tier": 5, "speed_tier": 5, "requires_adult": True}, 1)]


def _claims(role, uid=None):
    return json.dumps({"role": role, **({"sub": uid} if uid else {})})


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [_claims(role, uid)])
            c.execute(f"set local role {role}")
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
    name = f"ns_adult_google_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s, 'none@g196.io'), (%s, 'adult@g196.io')", [U_NONE, U_ADULT])
    d.su("insert into public.organizations (id, name, slug) values (%s, 'G', 'org-g196')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'none@g196.io', 'owner'), "
         "(%s, %s, 'adult@g196.io', 'admin')", [ORG, U_NONE, ORG, U_ADULT])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": f"model_{m.replace('-', '_')}_image", "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": "image", **extra}} for m, extra, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, _x, credits in MODELS:
        d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'security-lab')", [m, "acme-" + m])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) on conflict (unit) do nothing",
             [f"model_{m.replace('-', '_')}_image", credits])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit")
    d.act("authenticated", U_ADULT, "select public.record_adult_attestation(true, %s, 'welcome')", [TERMS])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


PARAMS = {"prompt": "a lighthouse at dusk"}


def _routed_job(d, uid):
    route = d.act("authenticated", uid, "select public.quote_creative_route(%s, 't2i', 'auto', %s::jsonb)", [ORG, json.dumps(PARAMS)])[0][0]
    job = d.act("authenticated", uid, "select public.create_creative_job(%s::uuid, 't2i', %s, %s::jsonb, 'auto', null, %s::numeric)",
                [ORG, route["model"], json.dumps(PARAMS), route["credits"]])[0][0]["job"]
    got = d.act("service_role", None, "select id::text from public.claim_creative_job('g196-w')")
    assert got and got[0][0] == job["id"], got
    return job


def _drain(d, job):
    d.act("service_role", None, "select public.finish_creative_job(%s, 'g196-w', false, null, null, 'test_drain', 'drained')", [job])


def test_the_route_says_how_many_it_left_out(db):
    for mode in ("quality", "auto"):
        out = db.act("authenticated", U_NONE, "select public.quote_creative_route(%s, 't2i', %s, %s::jsonb)",
                     [ORG, mode, json.dumps(PARAMS)])[0][0]
        assert out["model"] != "img-best-adult" and out.get("adult_skipped") == 1, (mode, out)
    out = db.act("authenticated", U_ADULT, "select public.quote_creative_route(%s, 't2i', 'quality', %s::jsonb)", [ORG, json.dumps(PARAMS)])[0][0]
    assert out["model"] == "img-best-adult" and out.get("adult_skipped") == 0, out


def test_a_failover_moves_on_when_the_candidate_is_allowed(db):
    """The control: the same job's failover reaches the second model."""
    job = _routed_job(db, U_NONE)
    moved = db.act("service_role", None, "select public.reroute_creative_job(%s, 'g196-w', 'unreachable')", [job["id"]])[0][0]
    _drain(db, job["id"])
    assert moved and moved.get("model") == "img-second", moved


def test_a_failover_skips_an_adults_only_candidate_for_a_requester_without_an_answer(db):
    """The second model is flagged adults-only after the job was routed (the registry sync, #830): the failover must not hand the
    no-answer requester's job to it, as create_creative_job would have refused it."""
    job = _routed_job(db, U_NONE)
    db.su("update public.model_registry set spec = spec || '{\"requires_adult\": true}'::jsonb where id = 'img-second'")
    try:
        moved = db.act("service_role", None, "select public.reroute_creative_job(%s, 'g196-w', 'unreachable')", [job["id"]])[0][0]
        _drain(db, job["id"])
        assert moved is None or moved.get("model") != "img-second", moved
    finally:
        db.su("update public.model_registry set spec = spec - 'requires_adult' where id = 'img-second'")
