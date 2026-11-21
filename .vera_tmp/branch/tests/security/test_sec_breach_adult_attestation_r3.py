"""Breach, PR #832 round 3 (0192 adult attestation): the mechanisms round 3 added.

  * workflow_advance_locked makes a later step AS the run's confirmer (api_act_as(r.started_by)), then puts the viewer's claims back;
  * start_workflow_run refuses every step's adult problem before step 1 is held;
  * adult_attestation_run_gate, BEFORE INSERT on render_jobs, refuses a row written in the session of a person who said "under 18".

HOLE (failing on purpose, low):
  * Run now on the GitHub Actions backend (NIGHTSHIFT_RUN_BACKEND unset = "actions", the default) writes no render_jobs row, and
    in the credits-exempt operator workspace (or a deployment with credits not enforced, platform admins only) reserveRunCredits
    takes no hold either: neither the hold gate nor the run gate sees it, and the route never reads the person's answer. A person
    who said "under 18" and is an admin there dispatches a paid video run. LEDGER BR-832-03 says Run now "meets the run gate" in
    the exempt workspace; that is true of the queue backend only.
      test_run_now_on_the_actions_backend_reads_the_adult_answer_before_dispatching             FAILS (static: the lab cannot run
                                                                                                the Next.js route)

No new database hole was found this round; every other test here is a regression pin and passes. What each one says would break:

  the confirmer's identity outlives the step it was borrowed for (a chained call in the same transaction)
      test_after_an_advance_that_made_a_step_the_session_is_the_viewers_again
      test_after_the_confirmers_gate_refused_a_step_the_session_is_the_viewers_again
      test_a_non_answerer_who_advanced_an_adults_run_still_gets_no_adults_only_job_of_their_own
  a confirmer who may no longer spend (demoted, removed) still pays for a later step     test_a_demoted_or_removed_confirmer_*
  a run of another workspace can be advanced as its confirmer                           test_another_workspaces_run_is_not_found
  racing pages (a minor's and an adult's) make a step twice or hold twice               test_racing_advances_make_one_step_and_one_hold
  any of the above changes under Supabase's own auth.uid(), which reads request.jwt.claim.sub FIRST (api_act_as sets it and
    creative_platform_reserve does not clear it; the lab's bootstrap auth.uid() reads only request.jwt.claims)
      test_the_same_holds_under_supabases_auth_uid
  the run gate is skipped where no hold is taken (the credits-exempt operator workspace)  test_the_run_gate_refuses_a_minor_in_the_exempt_workspace
  a failed queue row can be re-queued by a member (an UPDATE the INSERT gate never sees) test_a_member_cannot_requeue_a_render_job
"""

from __future__ import annotations

import json
import os
import threading
import uuid

import psycopg
import pytest

import sec_db
import test_sec_workflows as wfl
from sec_db import as_superuser, user
from sec_api_refund_lab import call
from sec_api_refund_lab import ok as api_ok

TERMS = "2026-11-20"
ADULT_TTS = "tts-adult"
STEP_ADULT_VOICE = {"capability": "tts", "model": ADULT_TTS, "params": {"prompt": {"$input": "line"}}}
FLOW3 = [wfl.STEP_IMG, wfl.STEP_ANIMATE, wfl.STEP_VOICE]
DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"

LAB_AUTH_UID = "create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$"
# Supabase's own definition: the legacy per-claim setting first, then the claims object.
SUPABASE_AUTH_UID = (
    "create or replace function auth.uid() returns uuid language sql stable as $$ "
    "select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), "
    "(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$")


@pytest.fixture(scope="module")
def wf():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_breach_adult_r3_{uuid.uuid4().hex[:8]}"
    d = wfl.Db(sec_db.build(admin, name))
    models = [*wfl.MODELS, (ADULT_TTS, ["tts"], "audio.acme", "model_tts_a_character", 0.1)]
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], "durations_s": list(range(1, 61)),
                      **({"requires_adult": True} if m == ADULT_TTS else {})}}
            for m, caps, a, unit, _c in models]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, a, _u, _c in models:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {wfl.PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def _attest(d, uid, adult):
    d.act("authenticated", uid, "select public.record_adult_attestation(%s, %s, 'welcome')", [adult, TERMS])


def _run(d, o, who, steps=FLOW3):
    """`who` saves and runs `steps` at the quoted total; step 1 is made and finished by the worker."""
    w = d.save(who, o.org, "Promo", wfl.INPUTS, steps)
    total = d.quote(who, w["id"], wfl.VALUES)["total"]
    run = str(uuid.uuid4())
    d.start(who, run, w["id"], w["version"], wfl.VALUES, total)
    st = d.steps(run)
    assert st[0][1] == "running" and st[1][1] == "pending", st
    d.worker(st[0][2])
    return run


def _session(d, who, statements):
    """Several statements in ONE transaction of one browser session (`who`), each in its own savepoint: what a chained RPC sees."""
    out = []
    with psycopg.connect(d.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [wfl.claims("authenticated", who)])
        c.execute("set local role authenticated")
        for q, p in statements:
            c.execute("savepoint s")
            try:
                cur = c.execute(q, p)
                out.append(cur.fetchall()[0][0] if cur.description else None)
                c.execute("release savepoint s")
            except psycopg.Error as e:
                c.execute("rollback to savepoint s")
                out.append("refused: " + str(e).splitlines()[0])
        c.commit()
    return out


ADVANCE = "select (public.advance_workflow_run(%s::uuid)) is not null"
WHO = "select coalesce(auth.uid()::text, '') || '|' || coalesce(current_setting('request.jwt.claim.sub', true), '<unset>')"


def _create(org, model, cap):
    return ("select public.create_creative_job(%s, %s, %s, %s::jsonb, 'exact', %s, 5)",
            [org, cap, model, json.dumps({"prompt": "chained"}), "chained-" + uuid.uuid4().hex[:8]])


# ── 1. The borrowed identity ends with the step ───────────────────────────

def test_after_an_advance_that_made_a_step_the_session_is_the_viewers_again(wf):
    """A minor editor's page advances an adult's run (step 2 is made as the adult), then, in the same transaction, the minor asks
    for a paid job of their own. Were the adult's claims still in force, the job would be made and held as the adult."""
    o = wf.new_org()
    _attest(wf, o.owner, True)
    _attest(wf, o.editor, False)
    run = _run(wf, o, o.owner)
    holds = wf.holds(o.org)[0]
    advanced, who, own = _session(wf, o.editor, [(ADVANCE, [run]), (WHO, None), _create(o.org, "img-a", "t2i")])
    assert advanced is True
    assert who.split("|")[0] == o.editor and who.split("|")[1] in ("", "<unset>"), f"after the advance the session reads {who}"
    assert str(own).startswith("refused: adult_only_service"), f"the minor's own chained job after the advance: {own}"
    assert wf.steps(run)[1][1] == "running" and wf.holds(o.org)[0] == holds + 1, "exactly the run's step 2 was held"


def test_after_the_confirmers_gate_refused_a_step_the_session_is_the_viewers_again(wf):
    """The refusal path: the confirmer said "under 18" after Run now, so step 2 is refused inside the block (its rollback is what
    puts the claims back). The viewer never answered; a chained adults-only job of theirs must be refused as THEIRS
    (adult_attestation_required), not as the minor confirmer's (adult_only_service)."""
    o = wf.new_org()
    run = _run(wf, o, o.owner)
    _attest(wf, o.owner, False)
    _advanced, who, own = _session(wf, o.editor, [(ADVANCE, [run]), (WHO, None), _create(o.org, ADULT_TTS, "tts")])
    assert who.split("|")[0] == o.editor, who
    assert str(own).startswith("refused: adult_attestation_required"), own
    st = wf.steps(run)
    assert st[1][1] == "failed" and st[1][5] == "adult_only_service", st
    assert wf.holds(o.org) == (0, 0)


def test_a_non_answerer_who_advanced_an_adults_run_still_gets_no_adults_only_job_of_their_own(wf):
    """The adult's run makes an adults-only step 2 as the adult (by design). The non-answerer whose page did it gets nothing of
    their own from the borrowed answer."""
    o = wf.new_org()
    _attest(wf, o.owner, True)
    run = _run(wf, o, o.owner, [wfl.STEP_IMG, STEP_ADULT_VOICE])
    _advanced, own = _session(wf, o.editor, [(ADVANCE, [run]), _create(o.org, ADULT_TTS, "tts")])
    assert str(own).startswith("refused: adult_attestation_required"), own
    jobs = wf.su("select requested_by::text from public.creative_jobs where org_id = %s and requested_model = %s", [o.org, ADULT_TTS])
    assert jobs == [(o.owner,)], f"the only adults-only job is the run's, made as its adult confirmer: {jobs}"


# ── 2. Who the step is made for ───────────────────────────────────────────

@pytest.mark.parametrize("change", ["demoted", "removed"])
def test_a_demoted_or_removed_confirmer_makes_no_later_step(wf, change):
    o = wf.new_org()
    _attest(wf, o.editor, True)
    _attest(wf, o.owner, True)
    run = _run(wf, o, o.editor)
    if change == "demoted":
        wf.su("update public.org_members set role = 'viewer' where org_id = %s and user_id = %s", [o.org, o.editor])
    else:
        wf.su("delete from public.org_members where org_id = %s and user_id = %s", [o.org, o.editor])
    wf.advance(o.owner, run)
    st = wf.steps(run)
    assert st[1][1] == "failed" and st[1][5] == "confirmation_revoked", st
    assert wf.holds(o.org) == (0, 0), "nothing held for a confirmer who may no longer spend"


def test_another_workspaces_run_is_not_found(wf):
    o = wf.new_org()
    _attest(wf, o.owner, True)
    run = _run(wf, o, o.owner)
    x = wf.new_org()
    _attest(wf, x.owner, True)
    with pytest.raises(psycopg.Error) as e:
        wf.advance(x.owner, run)
    assert e.value.sqlstate == "P0002", e.value
    assert wf.steps(run)[1][1] == "pending"


def test_racing_advances_make_one_step_and_one_hold(wf):
    """Four pages at once, a minor's and an adult's alternating: the run's lock serialises them, each acts as the confirmer."""
    o = wf.new_org()
    _attest(wf, o.owner, True)
    _attest(wf, o.editor, False)
    run = _run(wf, o, o.owner)
    errors: list[str] = []

    def press(u):
        try:
            wf.advance(u, run)
        except psycopg.Error as e:  # a serialisation victim is allowed; a second step is not
            errors.append(str(e).splitlines()[0])

    threads = [threading.Thread(target=press, args=(u,)) for u in (o.editor, o.owner, o.editor, o.owner)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    st = wf.steps(run)
    assert [s[1] for s in st] == ["completed", "running", "pending"], (st, errors)
    assert wf.holds(o.org)[0] == 1, wf.holds(o.org)
    assert wf.su("select count(*) from public.creative_jobs where org_id = %s", [o.org])[0][0] == 2
    assert wf.su("select requested_by::text from public.creative_jobs where id = %s", [st[1][2]])[0][0] == o.owner


def test_the_same_holds_under_supabases_auth_uid(wf):
    """Lab fidelity: Supabase's auth.uid() reads request.jwt.claim.sub before the claims object. api_act_as sets claim.sub, and
    creative_platform_reserve clears only the claims, so under the real function the hold gate sees the confirmer during step 2.
    Everything above must hold the same; afterwards claim.sub must not carry the confirmer into the viewer's next call."""
    wf.su(SUPABASE_AUTH_UID)
    try:
        o = wf.new_org()
        _attest(wf, o.owner, True)
        _attest(wf, o.editor, False)
        run = _run(wf, o, o.owner)
        _advanced, who, own = _session(wf, o.editor, [(ADVANCE, [run]), (WHO, None), _create(o.org, "img-a", "t2i")])
        assert who.split("|")[0] == o.editor, who
        assert str(own).startswith("refused: adult_only_service"), own
        assert wf.steps(run)[1][1] == "running" and wf.holds(o.org)[0] == 1

        o2 = wf.new_org()
        run2 = _run(wf, o2, o2.owner)
        _attest(wf, o2.owner, False)
        _attest(wf, o2.editor, True)
        wf.advance(o2.editor, run2)
        st = wf.steps(run2)
        assert st[1][1] == "failed" and st[1][5] == "adult_only_service" and wf.holds(o2.org) == (0, 0), st
    finally:
        wf.su(LAB_AUTH_UID)


# ── 3. The run gate on render_jobs ────────────────────────────────────────

def test_the_run_gate_refuses_a_minor_in_the_exempt_workspace(conn):
    """reserve_credits takes no hold in the operator's (credits-exempt) workspace, so the hold gate never fires there; a queued run
    is the run gate's alone. The adult admin's row is the control."""
    with as_superuser(conn, commit=False) as s:
        out = {}
        for adult in (True, False):
            who = user("exemptadmin", f"exempt-{uuid.uuid4().hex[:6]}@lab.test")
            s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
            s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin') returning 1",
                   [DEFAULT_ORG, who.uid, who.email])
            api_ok(call(s, who, "select public.record_adult_attestation(%s, %s, 'welcome')", [adult, TERMS]))
            out[adult] = call(s, who, "insert into public.render_jobs (channel_id, kind, params, requested_by) "
                                      "values ('default', 'daily', %s::jsonb, %s) returning id",
                              [json.dumps({"topic": "lab", "duration": 60}), who.uid])
        assert out[True].ok, f"control: an adult admin of the exempt workspace queues a run: {out[True]}"
        assert not out[False].ok and out[False].error.startswith("adult_only_service"), out[False]


def test_a_member_cannot_requeue_a_render_job(conn):
    """The run gate is BEFORE INSERT only. A failed job set back to 'queued' (and onto an open hold) would never meet it; no API role
    may UPDATE render_jobs, so the only way back to the queue is a new row."""
    with as_superuser(conn, commit=False) as s:
        who = user("requeue", f"requeue-{uuid.uuid4().hex[:6]}@lab.test")
        s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin') returning 1",
               [DEFAULT_ORG, who.uid, who.email])
        job = s.value("insert into public.render_jobs (channel_id, kind, params, status, requested_by) "
                      "values ('default', 'daily', '{\"duration\": 60}', 'failed', %s) returning id", [who.uid])
        api_ok(call(s, who, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS]))
        out = call(s, who, "update public.render_jobs set status = 'queued', finished_at = null where id = %s returning id", [job])
        assert not out.ok or not out.rows, f"a member re-queued a failed job: {out}"
        assert s.value("select status from public.render_jobs where id = %s", [job]) == "failed"


# ── 4. Run now on the Actions backend: no row, no hold, no answer read ───────────────────────────

RUN_ROUTE = sec_db.REPO / "command-center" / "app" / "api" / "agent" / "run" / "route.ts"


def test_run_now_on_the_actions_backend_reads_the_adult_answer_before_dispatching():
    """Static, because the lab runs SQL and not the Next.js route. The Actions dispatch is the one Run now path with no database
    write of its own (the route's comment: "the Actions dispatch has no database check of its own"); in the exempt workspace
    reserveRunCredits returns {exempt: true} before any reserve_credits call (lib/server/credits.ts), so a declared minor admin
    there reaches dispatchDailyVideo unasked. The route (or a database function it must call first) has to read the answer, as
    the creative screens do with readAgeState / my_adult_attestation, before dispatchDailyVideo."""
    src = RUN_ROUTE.read_text(encoding="utf-8")
    dispatch = src.find("dispatchDailyVideo(channelId")
    assert dispatch > 0, "the route no longer dispatches where this test expects: re-read it"
    before = src[:dispatch]
    asks = any(w in before for w in ("readAgeState", "my_adult_attestation", "adult_only_service", "adult_attestation"))
    assert asks, ("Run now on the Actions backend dispatches a paid run without asking the person's adult answer: in the "
                  "credits-exempt workspace no hold is taken and no render_jobs row is written, so no 0192 gate fires")
