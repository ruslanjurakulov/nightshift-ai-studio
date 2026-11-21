"""Breach, PR #842 round 4 (0196: a run that uses Google needs an adult answer): every way a person with no answer could still get a
Google run started, and the doors' answers.

HOLES (failing on purpose until fixed; both FAIL at HEAD 5de1fcf6 and pass with the route change being made in the worktree, which
reads the answer through lib/age.ts runAgeRefusal before the quote, the hold and the dispatch):

  * A storyboard approved on the GitHub Actions backend (NIGHTSHIFT_RUN_BACKEND unset = "actions", the default) writes no render_jobs
    row: approve_storyboard(..., 'actions') takes the hold and returns, and /api/storyboards/[id]/approve then calls
    dispatchDailyVideo(resume: true). The resumed run fact-checks the approved script with Gemini (main.py, fact_check_claims runs on
    a loaded script, an approved storyboard included) and renders it, so it uses Google. The run gate never sees it, the hold gate
    refuses only a minor, and neither the function nor the route reads the person's answer. 0196's header and LEDGER BR-832-03 say an
    approved storyboard meets the run gate; that is true of the queue backend only (the same gap r3 found for Run now).
      test_a_storyboard_approved_on_actions_by_a_member_without_an_answer_is_refused                       FAILS  (medium)
  * The same route in the credits-exempt (operator's) workspace: approve_storyboard skips the hold there, so a person who said "under
    18" gets a dispatched run too (BR-832-03's class, which r3 closed for Run now only).
      test_a_storyboard_approved_on_actions_in_the_exempt_workspace_refuses_a_minor                        FAILS  (low)

Every other test is a regression pin and passes. What each one says would break:

  a kind or params shape the stage rule reads as "no Google"                    test_no_kind_or_params_shape_reads_as_no_google
  a person's insert passing as sessionless (claims with no sub; anon)           test_a_person_cannot_make_an_insert_look_sessionless
  an insert on an adult colleague's hold                                        test_a_colleagues_hold_does_not_carry_their_answer
  an UPDATE path round the INSERT gate                                          test_no_api_role_may_update_a_render_job
  the scheduler or the service role refused                                     test_the_scheduler_and_the_service_role_are_never_refused
  an approved storyboard, a series episode or a key on the queue let through    test_the_session_doors_on_the_queue_are_asked
  the API door's 428 an existence oracle, ahead of 404/400, or holding          test_the_key_door_answers_404_and_400_before_428_and_holds_nothing
  a key whose creator is gone acting as "nobody" (sessionless)                  test_a_key_with_no_creator_cannot_start_a_google_run
  a 428 cached against the idempotency key, so "answer, then retry" never works test_a_428_is_not_replayed_after_the_person_answers
"""

from __future__ import annotations

import json
import uuid

import sec_db
from sec_db import ANON, SERVICE, as_superuser, user
from sec_api_refund_lab import call, customer, topup
from sec_api_refund_lab import ok as api_ok

TERMS = "2026-11-20"
DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"   # the operator's workspace: credits-exempt in the lab
STORYBOARD_ROUTE = sec_db.REPO / "command-center" / "app" / "api" / "storyboards" / "[id]" / "approve" / "route.ts"
ASKS = ("readAgeState(", "readAgeAnswer(", "runAgeRefusal(", "my_adult_attestation")


def _prices(s):
    s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 1, 0), ('video_minute', 2, 0) "
           "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 returning 1")


def _storyboard(s, channel, seconds=300):
    scenes = [{"n": 1, "name": "Scene 1", "type": "story", "narration": "Line.", "visual": "harbour", "duration_s": seconds}]
    return str(s.value(
        "insert into public.storyboards (channel_id, slug, topic, title, scenes, script, duration_s) "
        "values (%s, %s, 'A topic', 'A title', %s::jsonb, %s::jsonb, %s) returning id",
        [channel, "sb-" + uuid.uuid4().hex[:10], json.dumps(scenes),
         json.dumps({"topic": "t", "title": "T", "sections": [{"name": "s", "narration": "Line."}]}), seconds]))


def _route_asks_before_dispatch() -> bool:
    src = STORYBOARD_ROUTE.read_text(encoding="utf-8")
    dispatch = src.find("dispatchDailyVideo(")
    assert dispatch > 0, "the storyboard route no longer dispatches where this test expects: re-read it"
    return any(w in src[:dispatch] for w in ASKS)


def _person(s, org, role="admin", adult=None):
    who = user("r4", f"r4-{uuid.uuid4().hex[:8]}@lab.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
           [org, who.uid, who.email, role])
    if adult is not None:
        api_ok(call(s, who, "select public.record_adult_attestation(%s, %s, 'welcome')", [adult, TERMS]))
    return who


# ── HOLES ──────────────────────────────────────────────────────────────────

def test_a_storyboard_approved_on_actions_by_a_member_without_an_answer_is_refused(conn):
    """Repro: a customer admin who never answered approves a ready storyboard on the Actions backend. approve_storyboard takes the
    hold and writes no render_jobs row, and the route goes straight to dispatchDailyVideo(resume) without reading the answer. Closed
    when EITHER the function refuses adult_attestation_required before the hold (preferred: one place, any caller) OR the route asks
    before it dispatches."""
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        c = customer(s)                                   # never answered
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        sid = _storyboard(s, c.channel)
        # The control: the same press on the queue meets the run gate.
        q = call(s, c.actor, "select public.approve_storyboard(%s, 10, 'queue')", [sid])
        assert not q.ok and q.error.startswith("adult_attestation_required"), f"control (queue): {q}"
        out = call(s, c.actor, "select public.approve_storyboard(%s, 10, 'actions')", [sid])
        held = s.value("select count(*) from public.credit_reservations where org_id = %s and status = 'open'", [c.org])
        rows = s.value("select count(*) from public.render_jobs where channel_id = %s", [c.channel])
        db_refused = (not out.ok) and out.error.startswith("adult_attestation_required") and held == 0
        assert db_refused or _route_asks_before_dispatch(), (
            "a storyboard approved on Actions by a person with no adult answer is dispatched as a Google run: "
            f"approve_storyboard(actions) -> {out}, open holds {held}, render_jobs rows {rows} (nothing for the run gate to see), "
            "and the approve route never reads the answer before dispatchDailyVideo")


def test_a_storyboard_approved_on_actions_in_the_exempt_workspace_refuses_a_minor(conn):
    """Repro: in the operator's exempt workspace approve_storyboard takes no hold (the hold gate never fires) and writes no row on
    Actions; a person who said "under 18" and administers it gets the approval, and the route dispatches."""
    with as_superuser(conn, commit=False) as s:
        minor = _person(s, DEFAULT_ORG, adult=False)
        sid = _storyboard(s, "default")
        out = call(s, minor, "select public.approve_storyboard(%s, null, 'actions')", [sid])
        db_refused = (not out.ok) and out.error.startswith("adult_only_service")
        assert db_refused or _route_asks_before_dispatch(), (
            f"a declared minor's storyboard approval on Actions in the exempt workspace is accepted ({out}) and dispatched unasked")


# ── the rule ───────────────────────────────────────────────────────────────

def test_no_kind_or_params_shape_reads_as_no_google(conn):
    kinds = ["daily", "series_plan", "repair", "", None, "DAILY", "daily ", "x" * 300, "series-plan"]
    shapes = [None, {}, [], "veo", 7, True, {"video_provider": None}, {"video_provider": "minimax"}, {"video_provider": ""},
              {"video_provider": {"x": "veo"}}, {"image_provider": ["nano-banana"]}, {"video_provider": "VEO"}]
    with as_superuser(conn, commit=False) as s:
        for k in kinds:
            for p in shapes:
                g = s.value("select public.render_run_google_stages(%s, %s::jsonb)", [k, None if p is None else json.dumps(p)])
                assert g, (k, p, g)


# ── sessionless spoofing ───────────────────────────────────────────────────

def test_a_person_cannot_make_an_insert_look_sessionless(conn):
    """A browser JWT always carries sub; but even claims with the authenticated role and no sub, or the anon role, write no row:
    the insert policy wants requested_by = auth.uid(), which no row satisfies when that is null."""
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        ref = "rj-" + uuid.uuid4().hex[:12]
        api_ok(call(s, c.actor, "select public.reserve_credits(%s, %s, 10)", [c.org, ref]))
        q = ("insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref) "
             "values (%s, 'daily', '{\"duration\": 60}'::jsonb, %s, %s) returning id")
        nosub = sec_db.Actor("nosub", "authenticated")
        for who, req in ((nosub, c.actor.uid), (nosub, None), (ANON, c.actor.uid), (ANON, None)):
            out = call(s, who, q, [c.channel, req, ref])
            assert not out.ok, (who, req, out)
        assert s.value("select count(*) from public.render_jobs where channel_id = %s", [c.channel]) == 0


def test_a_colleagues_hold_does_not_carry_their_answer(conn):
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        adult = _person(s, c.org, adult=True)
        ref = "rj-" + uuid.uuid4().hex[:12]
        api_ok(call(s, adult, "select public.reserve_credits(%s, %s, 10)", [c.org, ref]))
        out = call(s, c.actor, "insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref) "
                               "values (%s, 'daily', '{\"duration\": 60}'::jsonb, %s, %s) returning id", [c.channel, c.actor.uid, ref])
        assert not out.ok and out.error.startswith("adult_attestation_required"), out
        ok = call(s, adult, "insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref) "
                            "values (%s, 'daily', '{\"duration\": 60}'::jsonb, %s, %s) returning id", [c.channel, adult.uid, ref])
        assert ok.ok, f"control: the adult who took the hold queues on it: {ok}"


def test_no_api_role_may_update_a_render_job(conn):
    """The run gate is BEFORE INSERT only; a row an adult (or the scheduler) wrote must not be turned into another run by a person
    with no answer (a Veo provider set on it, or re-queued)."""
    with as_superuser(conn, commit=False) as s:
        who = _person(s, DEFAULT_ORG)                     # an admin of the exempt workspace, never answered
        job = s.value("insert into public.render_jobs (channel_id, kind, params, status) values ('default', 'daily', '{}', 'failed') "
                      "returning id")
        for actor in (who, ANON):
            out = call(s, actor, "update public.render_jobs set params = '{\"video_provider\": \"veo\"}', status = 'queued' "
                                 "where id = %s returning id", [job])
            assert not out.ok or not out.rows, (actor, out)
        assert s.value("select status from public.render_jobs where id = %s", [job]) == "failed"


def test_the_scheduler_and_the_service_role_are_never_refused(conn):
    """No session: the scheduled run, the dispatcher. In the operator's workspace with Veo and Nano Banana named (the Google stages
    all on), and in a customer's on its own hold."""
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        google = json.dumps({"duration": 60, "video_provider": "veo", "image_provider": "nano-banana"})
        q = "insert into public.render_jobs (channel_id, kind, params, credit_ref) values (%s, 'daily', %s::jsonb, %s) returning id"
        assert s.run(q, ["default", google, None]).ok
        assert call(s, SERVICE, q, ["default", google, None]).ok
        for who in (None, SERVICE):
            c = customer(s)
            s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
            ref = "rj-" + uuid.uuid4().hex[:12]
            api_ok(s.run("select public.reserve_credits(%s, %s, 10)", [c.org, ref]))
            out = s.run(q, [c.channel, '{"duration": 60}', ref]) if who is None else call(s, who, q, [c.channel, '{"duration": 60}', ref])
            assert out.ok, (who, out)


# ── the doors on the queue ─────────────────────────────────────────────────

def test_the_session_doors_on_the_queue_are_asked(conn):
    """An approved storyboard on the queue and a key's video: refused for a person with no answer, nothing held or queued."""
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        c = customer(s)
        s.rows("select public.grant_credits(%s, 100, 'lab')", [c.org])
        topup(s, c, 5000)
        sid = _storyboard(s, c.channel)
        out = call(s, c.actor, "select public.approve_storyboard(%s, 10, 'queue')", [sid])
        assert not out.ok and out.error.startswith("adult_attestation_required"), out
        body = api_ok(call(s, ANON, "select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                           [c.key_hash, c.channel, json.dumps({"duration": 60, "video_provider": "veo"})]))
        assert body["status"] == 428 and body["error"]["code"] == "adult_attestation_required", body
        assert s.value("select count(*) from public.credit_reservations where org_id = %s and status = 'open'", [c.org]) == 0
        assert s.value("select count(*) from public.api_holds where org_id = %s", [c.org]) == 0
        assert s.value("select count(*) from public.render_jobs where channel_id = %s", [c.channel]) == 0


def test_the_key_door_answers_404_and_400_before_428_and_holds_nothing(conn):
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        other = customer(s)
        topup(s, c, 5000)
        q = "select public.api_create_video(%s, %s, %s::jsonb, null, null, null)"
        p = json.dumps({"duration": 60})
        theirs = api_ok(call(s, ANON, q, [c.key_hash, other.channel, p]))
        missing = api_ok(call(s, ANON, q, [c.key_hash, "chan-does-not-exist", p]))
        bad = api_ok(call(s, ANON, q, [c.key_hash, c.channel, json.dumps({"duration": 60, "privacy": "public"})]))
        assert theirs["status"] == missing["status"] == 404 and theirs["error"] == missing["error"], (theirs, missing)
        assert bad["status"] == 400, bad
        assert s.value("select count(*) from public.api_holds where org_id = %s", [c.org]) == 0


def test_a_key_with_no_creator_cannot_start_a_google_run(conn):
    """api_act_as(null) leaves auth.uid() null: the door itself must still read that as "no answer" (state 'none'), not as the
    scheduler. api_keys.created_by is NOT NULL today; this pins the door's own check in case that ever changes."""
    with as_superuser(conn, commit=False) as s:
        c = customer(s)
        topup(s, c, 5000)
        dropped = s.run("alter table public.api_keys alter column created_by drop not null")
        assert dropped.ok, dropped
        s.rows("update public.api_keys set created_by = null where key_hash = %s returning 1", [c.key_hash])
        out = call(s, ANON, "select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                   [c.key_hash, c.channel, json.dumps({"duration": 60})])
        body = out.rows[0][0] if out.ok else None
        assert body is None or body.get("status") != 201, body
        assert s.value("select count(*) from public.render_jobs where channel_id = %s", [c.channel]) == 0


def test_a_428_is_not_replayed_after_the_person_answers(conn):
    """The 428 says "confirm, then retry": a client that retries with the same Idempotency-Key must get the video, not the old 428."""
    with as_superuser(conn, commit=False) as s:
        _prices(s)
        c = customer(s)
        topup(s, c, 5000)
        q = "select public.api_create_video(%s, %s, %s::jsonb, %s, %s, null)"
        args = [c.key_hash, c.channel, json.dumps({"duration": 60}), "idem-r4", "a" * 64]
        first = api_ok(call(s, ANON, q, args))
        assert first["status"] == 428, first
        api_ok(call(s, c.actor, "select public.record_adult_attestation(true, %s, 'welcome')", [TERMS]))
        second = api_ok(call(s, ANON, q, args))
        assert second["status"] == 201 and not second.get("replayed"), second


# ── the failover (0196's own lab: it commits) ──────────────────────────────

from test_sec_adult_attestation_google_runs import ORG, U_ADULT, U_NONE, _drain, _routed_job  # noqa: E402
from test_sec_adult_attestation_google_runs import db  # noqa: E402,F401  (the module's fixture, a lab of its own here)


def _flag(d, model, on):
    d.su("update public.model_registry set spec = " + ("spec || '{\"requires_adult\": true}'::jsonb" if on else "spec - 'requires_adult'")
         + " where id = %s", [model])


def test_a_failover_of_a_job_with_no_requester_never_reaches_an_adults_only_model(db):
    """requested_by null (a person deleted, a platform-made job): nobody answered, so an adults-only candidate is skipped."""
    job = _routed_job(db, U_NONE)
    db.su("update public.creative_jobs set requested_by = null where id = %s", [job["id"]])
    _flag(db, "img-second", True)
    try:
        moved = db.act("service_role", None, "select public.reroute_creative_job(%s, 'g196-w', 'unreachable')", [job["id"]])[0][0]
        _drain(db, job["id"])
        assert moved is None or moved.get("model") != "img-second", moved
    finally:
        _flag(db, "img-second", False)


def test_a_failover_for_an_adult_requester_still_reaches_an_adults_only_model(db):
    """The control: an adult's job fails over to a candidate flagged adults-only after routing (0196 must not skip it)."""
    route = db.act("authenticated", U_ADULT, "select public.quote_creative_route(%s, 't2i', 'cheap', %s::jsonb)",
                   [ORG, json.dumps({"prompt": "a lighthouse at dusk"})])[0][0]
    job = db.act("authenticated", U_ADULT, "select public.create_creative_job(%s::uuid, 't2i', %s, %s::jsonb, 'cheap', null, %s::numeric)",
                 [ORG, route["model"], json.dumps({"prompt": "a lighthouse at dusk"}), route["credits"]])[0][0]["job"]
    got = db.act("service_role", None, "select id::text from public.claim_creative_job('g196-w')")
    assert got and got[0][0] == job["id"], got
    cands = db.su("select candidates from public.creative_job_routes where job_id = %s", [job["id"]])[0][0]
    nxt = [c["model"] for c in cands if c["model"] != route["model"]]
    assert nxt, cands
    _flag(db, nxt[0], True)
    try:
        moved = db.act("service_role", None, "select public.reroute_creative_job(%s, 'g196-w', 'unreachable')", [job["id"]])[0][0]
        _drain(db, job["id"])
        assert moved and moved.get("model") == nxt[0], (route, moved)
    finally:
        _flag(db, nxt[0], False)


# ── the MCP connection's video: 404 and 400 before 428, nothing held ───────

import os  # noqa: E402

import pytest  # noqa: E402

import test_sec_mcp_oauth_creative as occ  # noqa: E402


@pytest.fixture(scope="module")
def mcp():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_r4_mcp_{uuid.uuid4().hex[:8]}"
    d = occ.Db(sec_db.build(admin, name))
    occ.setup(d)
    for ch, org in (("chan-r4-a", occ.ORG_A), ("chan-r4-b", occ.ORG_B)):
        d.su("insert into public.channels (channel_id, name, niche, status, org_id, agent_config, credential_ref) values "
             "(%s, 'R4', 'tech', 'ACTIVE', %s, '{}', '{\"verified_at\":\"2026-09-01\"}')", [ch, org])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def test_the_connection_door_answers_404_and_400_before_428_and_holds_nothing(mcp):
    tok, _g = occ.connection(mcp, occ.UA, occ.ORG_A)        # org A's owner never answered
    q = "select public.oauth_create_video(%s, %s, %s::jsonb, %s, null)"
    p = json.dumps({"topic": "lab", "duration": 60})
    foot = lambda: (mcp.su("select count(*) from public.render_jobs")[0][0],
                    mcp.su("select count(*) from public.credit_reservations where status = 'open'")[0][0],
                    mcp.su("select count(*) from public.oauth_runs")[0][0])
    before = foot()
    theirs = mcp.act("anon", None, q, [tok, "chan-r4-b", p, "r4-1"])[0][0]
    missing = mcp.act("anon", None, q, [tok, "chan-r4-zzz", p, "r4-2"])[0][0]
    bad = mcp.act("anon", None, q, [tok, "chan-r4-a", json.dumps({"duration": 60, "privacy": "public"}), "r4-3"])[0][0]
    refused = mcp.act("anon", None, q, [tok, "chan-r4-a", p, "r4-4"])[0][0]
    again = mcp.act("anon", None, q, [tok, "chan-r4-a", p, "r4-4"])[0][0]
    assert theirs["status"] == missing["status"] == 404 and theirs["error"] == missing["error"], (theirs, missing)
    assert bad["status"] == 400, bad
    assert refused["status"] == 428 and occ.code(refused) == "adult_attestation_required", refused
    assert again["status"] == 428 and not again.get("replayed"), again     # a refusal is not stored against the key
    assert foot() == before
