"""Workflow runs that wait (BR-L-011) and the confirmer's platform roles (LENS-4), in a real database.

BR-L-011: between two steps, the plan's parallel-run limit (another member's Studio
press holds the one slot) or a balance short for the next step used to fail the
run for good, after the earlier steps were already charged. Both are temporary:
the step now stays pending with the reason on record, holds nothing, and starts
on a later advance once the slot or the credits are back. The 24 h confirmation
still bounds the wait, and a refusal that is not temporary still fails the run.

LENS-4 test gap: 0074's workflow_confirmer_may_spend had no test of its platform
branches (operator organization, a platform admin confirming in a customer
organization, an invited platform row, the empty-roster bootstrap). They are
attacked here, end to end and against the routes' own rule for every user.

Its own scratch database (the db fixture of test_sec_workflows.py, module scoped),
because it changes the platform roster.
"""
import json
import threading
import uuid
from decimal import Decimal

import psycopg
import pytest

from test_sec_workflows import (  # noqa: F401  (db: this module's own scratch database)
    INPUTS,
    STEP_IMG,
    STEP_VOICE,
    TOTAL,
    VALUES,
    claims,
    db,
    err,
    flow,
    start_ok,
)

DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"


def studio(db, o, who=None):
    """An ordinary Studio generation by another member: it takes the plan's one parallel slot."""
    out = db.one("authenticated", who or o.owner,
                 "select public.create_creative_job(%s, 't2i', 'img-a', %s::jsonb, 'exact', %s, 4)",
                 [o.org, json.dumps({"prompt": "a studio press"}), f"studio-{uuid.uuid4()}"])
    return out["job"]["id"]


def run_holds(db, run):
    """Open holds of this run's own step jobs."""
    return db.su("select count(*), coalesce(sum(r.amount), 0) from public.credit_reservations r "
                 "join public.creative_jobs j on j.credit_ref = r.job_id "
                 "where j.idempotency_key like %s and r.status = 'open'", [f"wf:{run}:%"])[0]


def run_jobs(db, run):
    return db.su("select count(*) from public.creative_jobs where idempotency_key like %s", [f"wf:{run}:%"])[0][0]


def statuses(out):
    return [s["status"] for s in out["steps"]]


def waiting_on_the_slot(db, o):
    """A run whose first step is paid for (4) and whose second waits: a Studio job holds the slot."""
    wf, run, _ = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4)
    other = studio(db, o)
    out = db.advance(o.editor, run)
    return wf, run, other, out


def race(calls):
    """Run the calls at once; return (results, errors)."""
    barrier = threading.Barrier(len(calls))
    results, errors = [], []

    def go(fn):
        barrier.wait()
        try:
            results.append(fn())
        except psycopg.Error as e:
            errors.append(e)

    ts = [threading.Thread(target=go, args=(fn,)) for fn in calls]
    [t.start() for t in ts]
    [t.join(timeout=60) for t in ts]
    return results, errors


# ── BR-L-011: a temporary refusal between steps is a wait, not a failed paid run ──

def test_the_plans_parallel_limit_between_steps_makes_the_run_wait_not_fail(db):
    o = db.new_org()
    start_balance = db.acct(o.org)[0]
    wf, run, other, out = waiting_on_the_slot(db, o)
    # The page keeps polling (whoever has it open): the run waits, nothing fails, nothing is held.
    for who in (o.editor, o.owner, o.editor):
        out = db.advance(who, run)
        assert out["run"]["status"] == "running" and out["run"]["error_code"] is None
        assert statuses(out) == ["completed", "pending", "pending"]
        assert out["steps"][1]["error_code"] == "run_limit_reached" and out["steps"][1]["job_id"] is None
        assert "limit=1" in out["steps"][1]["error"]
        # What the run has cost so far is what step 1 was charged, and only that.
        assert out["run"]["charged_credits"] == 4 and out["steps"][1]["charged_credits"] is None
        assert run_holds(db, run) == (0, 0) and run_jobs(db, run) == 1
    assert db.holds(o.org) == (1, 4)  # the Studio job's own hold, nothing else
    # The slot frees: the next advance starts the waiting step, and its reason is cleared.
    db.worker(other, charge=4)
    out = db.advance(o.editor, run)
    assert statuses(out) == ["completed", "running", "pending"]
    assert out["steps"][1]["error_code"] is None and out["steps"][1]["error"] is None
    assert run_holds(db, run) == (1, 10)
    db.worker(out["steps"][1]["job_id"], charge=10)
    out = db.advance(o.editor, run)
    db.worker(out["steps"][2]["job_id"], charge=1.9)
    out = db.advance(o.editor, run)
    assert out["run"]["status"] == "completed" and out["run"]["charged_credits"] == TOTAL
    assert db.acct(o.org) == (start_balance - 4 - Decimal(str(TOTAL)), 0) and db.holds(o.org) == (0, 0)


def test_a_short_balance_between_steps_waits_and_carries_on_after_a_top_up(db):
    o = db.new_org(credits=17)
    wf, run, _ = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4)  # 13 left
    db.su("select public.reserve_credits(%s, 'wait-drain', 12)", [o.org])  # another spend holds 12
    out = db.advance(o.editor, run)
    assert out["run"]["status"] == "running" and statuses(out) == ["completed", "pending", "pending"]
    assert out["steps"][1]["error_code"] == "insufficient_credits"
    # The other spend is charged: the slot is free again but 1 credit is left, short of step 2's 10.
    db.act("service_role", None, "select public.capture_credits('wait-drain', 12)")
    out = db.advance(o.editor, run)
    assert out["run"]["status"] == "running" and out["steps"][1]["error_code"] == "insufficient_credits"
    assert "needed=10" in out["steps"][1]["error"]
    assert db.acct(o.org) == (1, 0) and db.holds(o.org) == (0, 0) and run_jobs(db, run) == 1
    # Credits are added: the step starts, held at its confirmed price, and the run goes on.
    db.su("select public.grant_credits(%s, 20, 'top-up')", [o.org])
    out = db.advance(o.editor, run)
    assert statuses(out) == ["completed", "running", "pending"] and out["steps"][1]["error_code"] is None
    assert run_holds(db, run) == (1, 10) and db.acct(o.org) == (21, 10)


def test_a_waiting_run_still_stops_when_its_confirmation_is_a_day_old(db):
    o = db.new_org()
    start_balance = db.acct(o.org)[0]
    wf, run, other, out = waiting_on_the_slot(db, o)
    assert out["steps"][1]["error_code"] == "run_limit_reached" and out["run"]["status"] == "running"
    db.su("update public.workflow_runs set created_at = now() - interval '25 hours' where id = %s", [run])
    out = db.advance(o.editor, run)
    assert out["run"]["status"] == "failed" and out["run"]["error_code"] == "step_failed"
    assert statuses(out) == ["completed", "failed", "skipped"]
    assert out["steps"][1]["error_code"] == "confirmation_expired" and out["steps"][1]["charged_credits"] == 0
    assert out["steps"][2]["error_code"] is None and out["steps"][2]["job_id"] is None
    assert "step 2 could not start (confirmation_expired)" in out["run"]["error"]
    # The run says what it cost: step 1's 4, and it holds nothing.
    assert out["run"]["charged_credits"] == 4 and run_holds(db, run) == (0, 0) and run_jobs(db, run) == 1
    # Once the slot is free, an expired run still starts nothing.
    db.worker(other, charge=4)
    out = db.advance(o.editor, run)
    assert out["run"]["status"] == "failed" and run_jobs(db, run) == 1
    assert db.acct(o.org) == (start_balance - 8, 0) and db.holds(o.org) == (0, 0)


def test_stopping_a_waiting_run_skips_the_rest_and_holds_nothing(db):
    o = db.new_org()
    wf, run, other, out = waiting_on_the_slot(db, o)
    out = db.cancel(o.owner, run)
    assert out["run"]["status"] == "cancelled" and statuses(out) == ["completed", "skipped", "skipped"]
    assert out["steps"][1]["error_code"] is None and out["run"]["charged_credits"] == 4
    assert run_holds(db, run) == (0, 0) and run_jobs(db, run) == 1
    db.worker(other, charge=4)
    assert db.advance(o.editor, run)["run"]["status"] == "cancelled" and run_jobs(db, run) == 1


def test_a_refusal_that_is_not_temporary_still_fails_the_run_and_holds_nothing(db):
    # Only the parallel limit and a short balance wait: a price that moved past the confirmed
    # one fails the step and the run, as before.
    o = db.new_org()
    wf, run, other, out = waiting_on_the_slot(db, o)
    db.worker(other, charge=4)
    db.su("update public.credit_prices set credits_per_unit = 3 where unit = 'model_vid_i2v_second'")
    try:
        out = db.advance(o.editor, run)
    finally:
        db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vid_i2v_second'")
    assert out["run"]["status"] == "failed" and statuses(out) == ["completed", "failed", "skipped"]
    assert out["steps"][1]["error_code"] == "price_changed"
    assert run_holds(db, run) == (0, 0) and db.holds(o.org) == (0, 0) and out["run"]["charged_credits"] == 4


def test_presses_racing_between_steps_start_the_waiting_step_exactly_once(db):
    for _ in range(4):
        o = db.new_org()
        wf, run, other, out = waiting_on_the_slot(db, o)
        presses = [lambda: db.advance(o.editor, run), lambda: db.advance(o.owner, run),
                   lambda: db.start(o.editor, run, wf["id"], wf["version"], VALUES, TOTAL)]
        # While the slot is taken: everyone pressing at once starts nothing and fails nothing.
        results, errors = race(presses)
        assert not errors, [e.sqlstate for e in errors]
        steps = db.steps(run)
        assert [s[1] for s in steps] == ["completed", "pending", "pending"] and steps[1][5] == "run_limit_reached"
        assert run_jobs(db, run) == 1 and run_holds(db, run) == (0, 0)
        # The slot frees and they race again: exactly one starts step 2, held once.
        db.worker(other, charge=4)
        results, errors = race(presses)
        assert not errors, [e.sqlstate for e in errors]
        assert [s[1] for s in db.steps(run)] == ["completed", "running", "pending"]
        assert run_jobs(db, run) == 2 and run_holds(db, run) == (1, 10) and db.holds(o.org) == (1, 10)
        assert db.su("select status from public.workflow_runs where id = %s", [run])[0][0] == "running"


def test_a_studio_press_racing_the_waiting_step_for_the_freed_slot_leaves_one_holder(db):
    for _ in range(4):
        o = db.new_org()
        wf, run, other, out = waiting_on_the_slot(db, o)
        db.worker(other, charge=4)
        results, errors = race([lambda: db.advance(o.editor, run), lambda: studio(db, o)])
        # The run never errors; the Studio press may lose the slot (NS429), like any second press.
        assert all(e.sqlstate == "NS429" for e in errors), [e.sqlstate for e in errors]
        assert db.holds(o.org)[0] == 1
        steps = db.steps(run)
        assert db.su("select status from public.workflow_runs where id = %s", [run])[0][0] == "running"
        if errors:  # the run won the slot
            assert [s[1] for s in steps] == ["completed", "running", "pending"] and run_holds(db, run) == (1, 10)
        else:  # the Studio won it: the run waits again, holding nothing
            assert [s[1] for s in steps] == ["completed", "pending", "pending"] and steps[1][5] == "run_limit_reached"
            assert run_holds(db, run) == (0, 0)


# ── LENS-4 test gap: workflow_confirmer_may_spend's platform branches ────────

_n = [0]


def person(db, email=None, confirmed=True, platform=None, bound=True):
    """A signed-up account; optionally on the platform roster (bound by id, or invited by email)."""
    _n[0] += 1
    u = str(uuid.UUID(int=0x7500 + _n[0]))
    email = email or f"plat{_n[0]}@x.io"
    db.su("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, %s)",
          [u, email, "2026-01-01" if confirmed else None])
    if platform:
        db.su("insert into public.app_members (user_id, email, role) values (%s, %s, %s)",
              [u if bound else None, email, platform])
    return u


def may(db, user, org):
    return db.su("select public.workflow_confirmer_may_spend(%s::uuid, %s::uuid)", [user, org])[0][0]


def set_platform_role(db, user, role):
    db.su("update public.app_members set role = %s where user_id = %s", [role, user])


def test_with_no_platform_roster_the_operators_own_members_are_platform_owners(db):
    # 0018/0043's bootstrap: while app_members is empty, a bound member of the operator's
    # organization is platform owner (everywhere); nobody else has a platform role.
    assert db.su("select public.app_members_empty()")[0][0] is True
    c = db.new_org()
    boot, stranger = person(db), person(db)
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'boot@x.io', 'viewer')",
          [DEFAULT_ORG, boot])
    try:
        assert may(db, boot, c.org) is True and may(db, boot, DEFAULT_ORG) is True
        assert may(db, stranger, c.org) is False and may(db, stranger, DEFAULT_ORG) is False
        assert may(db, c.editor, c.org) is True and may(db, c.viewer, c.org) is False
        assert may(db, c.editor, DEFAULT_ORG) is False
    finally:
        db.su("delete from public.org_members where org_id = %s and user_id = %s", [DEFAULT_ORG, boot])


@pytest.fixture(scope="module")
def roster(db):
    """The platform roster is in use from here on (a keeper owner, so it is never empty)."""
    return person(db, platform="owner")


def test_a_platform_admin_confirms_in_a_customer_org_only_while_still_admin(db, roster):
    c = db.new_org()
    p = person(db, platform="admin")  # no org_members row in c at all
    assert may(db, p, c.org) is True
    wf = flow(db, c)
    run = str(uuid.uuid4())
    out = db.start(p, run, wf["id"], wf["version"], VALUES, TOTAL)
    assert out["run"]["started_by"] == p
    db.worker(db.steps(run)[0][2], charge=4)
    # Still admin: a member of c carries the run on.
    out = db.advance(c.owner, run)
    assert statuses(out) == ["completed", "running", "pending"]
    db.worker(out["steps"][1]["job_id"], charge=10)
    # Demoted to platform editor: no organization role in c, so no longer allowed to spend there.
    set_platform_role(db, p, "editor")
    assert may(db, p, c.org) is False
    out = db.advance(c.owner, run)
    assert statuses(out) == ["completed", "completed", "failed"]
    assert out["steps"][2]["error_code"] == "confirmation_revoked" and out["steps"][2]["job_id"] is None
    assert out["run"]["status"] == "failed" and out["run"]["charged_credits"] == 14
    assert run_holds(db, run) == (0, 0)


def test_in_the_operators_org_only_a_platform_owner_or_admin_is_a_confirmer(db, roster):
    # The operator's organization is paid by the platform: there the confirmer must still be a
    # platform owner/admin, whatever their org_members role (this is the branch that, if it
    # answered true, would let a demoted operator's confirmation keep spending).
    flow3 = [STEP_IMG, STEP_VOICE, {**STEP_IMG, "params": {"prompt": "a poster"}}]
    p = person(db, platform="admin")
    q = person(db, platform="admin")
    e = person(db, platform="editor")
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'op-owner@x.io', 'owner')",
          [DEFAULT_ORG, p])
    assert may(db, p, DEFAULT_ORG) is True and may(db, e, DEFAULT_ORG) is False
    wf = db.save(p, DEFAULT_ORG, "Operator flow", INPUTS, flow3)
    total = db.quote(p, wf["id"], VALUES)["total"]
    run = str(uuid.uuid4())
    db.start(p, run, wf["id"], wf["version"], VALUES, total)
    db.worker(db.steps(run)[0][2], charge=4)
    # A plain platform editor cannot carry an operator run on at all.
    assert err(lambda: db.advance(e, run))[0] == "42501"
    out = db.advance(q, run)  # p is still admin
    assert statuses(out) == ["completed", "running", "pending"]
    db.worker(out["steps"][1]["job_id"], charge=1.9)
    # p is demoted to platform editor but still owner in org_members of the operator's org.
    set_platform_role(db, p, "editor")
    assert may(db, p, DEFAULT_ORG) is False
    out = db.advance(q, run)
    assert statuses(out) == ["completed", "completed", "failed"]
    assert out["steps"][2]["error_code"] == "confirmation_revoked" and out["run"]["status"] == "failed"
    assert run_jobs(db, run) == 2


def test_an_invited_platform_row_counts_only_for_a_confirmed_email(db, roster):
    c = db.new_org()
    u = person(db, email="Invited.Admin@x.io", confirmed=False, platform="admin", bound=False)
    assert may(db, u, c.org) is False and may(db, u, DEFAULT_ORG) is False
    db.su("update auth.users set email_confirmed_at = now() where id = %s", [u])
    assert may(db, u, c.org) is True and may(db, u, DEFAULT_ORG) is True
    db.su("update public.app_members set role = 'viewer' where lower(email) = 'invited.admin@x.io'")
    assert may(db, u, c.org) is False and may(db, u, DEFAULT_ORG) is False
    assert may(db, None, c.org) is False and may(db, c.editor, None) is False


def test_the_helper_answers_exactly_what_the_routes_check_for_that_member(db, roster):
    # Differential: for every account and every organization in this database, the helper with
    # the user passed in equals the start/advance rule evaluated in that user's own session:
    # editor in the org (platform roles included) and, in the operator's org, a platform admin.
    person(db, platform="editor")
    person(db, platform="viewer")
    pe = person(db, platform="editor")
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'pe@x.io', 'owner')",
          [DEFAULT_ORG, pe])
    person(db, confirmed=False, platform="admin", bound=False)
    users = [r[0] for r in db.su("select id::text from auth.users order by id")]
    diffs, checked = [], 0
    with psycopg.connect(db.dsn, autocommit=True) as c:
        for u in users:
            c.execute("select set_config('request.jwt.claims', %s, false)", [claims("authenticated", u)])
            for org, helper, route in c.execute(
                    "select o.id::text, public.workflow_confirmer_may_spend(%s::uuid, o.id), "
                    "public.is_org_member(o.id, 'editor') and (not public.credits_exempt(o.id) or public.is_platform_admin()) "
                    "from public.organizations o", [u]).fetchall():
                checked += 1
                if helper is not route:
                    diffs.append((u, org, helper, route))
    assert checked > 100 and not diffs, diffs[:10]
