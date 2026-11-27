"""Migration 0231 (a workflow step's job is cancelled by the run's own rule; every cancel is recorded in the database; a browser
writes no cancel row of its own), attacked in the shared lab. Breach 0226-R3-1 (medium) and 0226-R3-2 (low).

Breach found both attacking 0226's round 3, whose cancel_workflow_run records who stopped a run: a run's running step is an ordinary
creative job, and 0198's cancel_creative_job let any seat (a viewer's) cancel it, stopping the run around cancel_workflow_run's
editor rule and leaving no row in the database; and 0087 let a browser write a workflow.cancel row itself. What would break without
each pin is in its name:

  * a viewer stops a member's run through its step's job (refused now, forbidden, the run untouched);
  * a seatless platform admin stops it the same way and nobody is recorded (allowed, and named now);
  * any cancel that happened leaves no database row naming the actor, the job and the organization;
  * a viewer's cancel of an ordinary job changes (it must not: allowed, now recorded);
  * a browser writes its own workflow.cancel or creative.cancel row (refused by the restrictive policy), while the definer's own
    insert still lands;
  * the migration: a replay changes nothing, the drift guard refuses a body that is neither 0198's nor its own and a policy that is
    not its own, it refuses without 0226, the rollback puts 0198's body back and drops the policy, sec_db's chain goes through it.

Breach's round-3 tests on 0226's bodies (the workflow.cancel row's actor, refused cancels, consent and plan pins) live here too.
Every test runs in one rolled-back transaction of the shared lab (conn, sc): nothing is committed.
"""

from __future__ import annotations

import json
import uuid

import psycopg
import pytest

import sec_cancel_audit_0231 as audit0231
import sec_db
import test_sec_series_tables as st
from sec_db import user
from test_sec_breach_org_spender_0226 import (  # noqa: F401  (w is the fixture)
    DECIDE, _audit, _consent_request, _grants, _run_confirmed_by, _seat, as_, base, become, money, not_a_member, staff_user, w,
)

MIGRATION = sec_db.MIGRATION_0231
ROLLBACK = sec_db.ROLLBACK_0231



# ── Breach round 3 (27 Nov): the six round-3 bodies, attacked ──

def _person(s, tag):
    become(s, None)
    p = user(tag, f"{tag}-{uuid.uuid4().hex[:8]}@nightshift.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [p.uid, p.email])
    sec_db.attest_adults(s, p.uid)
    return p


def _run_state(s, run):
    become(s, None)
    return s.rows("select status, error_code from public.workflow_runs where id = %s", [run])[0]


def _step_job(s, run, index=0):
    become(s, None)
    return s.value("select job_id from public.workflow_run_steps where run_id = %s and step_index = %s", [run, index])


def test_held_the_workflow_cancel_row_names_the_session_not_a_forged_email_claim(w):
    """The row cancel_workflow_run writes takes its actor from auth.uid() and its email from app_audit_log_stamp (the confirmed email
    of the signed-in person), never from request.jwt.claims' email: a member who puts someone else's address in the claims is still
    recorded as themselves. Seatless staff are recorded as themselves too (pinned above)."""
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    forged = w.member.claims()
    forged["email"] = "ceo@victim.test"
    become(s, None)
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(forged)])
    s.conn.execute("set local role authenticated")
    out = s.run("select public.cancel_workflow_run(%s)", [run])
    become(s, None)
    assert out.ok, out
    rows = s.rows("select actor_user_id, actor_email, detail ->> 'org_id' from public.app_audit_log "
                  "where action = 'workflow.cancel' and target = %s", [run])
    assert [(str(a), e, o) for a, e, o in rows] == [(w.member.uid, w.member.email, str(w.org))], rows


def test_held_a_refused_cancel_writes_no_workflow_cancel_row(w):
    """A viewer (forbidden) and another organization's member (not_found) neither stop the run nor leave a row in its name."""
    s = w.su
    viewer = _person(s, "viewer-r3")
    _seat(s, w.org, viewer, "viewer")
    run = _run_confirmed_by(s, w, w.member)
    out = as_(s, viewer, "select public.cancel_workflow_run(%s)", [run])
    assert not out.ok and out.sqlstate == "42501", out
    out = as_(s, w.foreign, "select public.cancel_workflow_run(%s)", [run])
    assert not out.ok and out.sqlstate == "P0002", out
    assert _audit(s, "workflow.cancel", run) == []
    assert _run_state(s, run)[0] == "running"


def test_a_viewer_cannot_stop_a_members_workflow_run_through_its_steps_creative_job(w):
    """BREACH 0226-R3-1 (pre-existing, 0036/0198; found attacking round 3's "no caller can suppress it"). cancel_workflow_run asks
    editor, and now records who stopped a run. But a run's running step is an ordinary creative job, and cancel_creative_job asks
    only is_org_member(org) (any seat, viewer included). A VIEWER cancels the step's job directly; the next advance (any page that
    polls) ends the run failed/step_failed: the run is stopped by someone cancel_workflow_run would refuse, and no workflow.cancel row
    (no database audit row at all) is written; the route's creative.cancel logAudit (channel_id null) is refused by RLS for a
    non-platform caller. Fails until a workflow step's job can only be stopped through cancel_workflow_run (or the same editor rule
    and record apply)."""
    s = w.su
    viewer = _person(s, "viewer-r3")
    _seat(s, w.org, viewer, "viewer")
    run = _run_confirmed_by(s, w, w.member)
    job = _step_job(s, run)
    become(s, None)
    was = s.value("select status from public.creative_jobs where id = %s", [job])
    as_(s, viewer, "select public.cancel_creative_job(%s)", [job])
    assert as_(s, w.member, "select public.advance_workflow_run(%s)", [run]).ok
    become(s, None)
    job_status = s.value("select status from public.creative_jobs where id = %s", [job])
    assert (job_status, _run_state(s, run)[0]) == (was, "running"), (
        "a viewer stopped a member's workflow run through its step's job", job_status, _run_state(s, run))


def test_a_seatless_platform_admin_who_stops_a_customers_run_through_its_steps_job_is_recorded(w):
    """BREACH 0226-R3-1, the staff variant: round 3 keeps cancel open to seatless staff on the ground that the database now records
    who stopped a run, for every caller. Through cancel_creative_job on the run's step the same staff member stops the same run
    (status failed, step_failed) and the database records nothing: no workflow.cancel row, no row naming them at all. Fails until
    stopping a run by any path leaves the database's workflow.cancel row naming the actor (or that path is refused)."""
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    job = _step_job(s, run)
    as_(s, w.staff, "select public.cancel_creative_job(%s)", [job])
    assert as_(s, w.member, "select public.advance_workflow_run(%s)", [run]).ok
    status = _run_state(s, run)[0]
    become(s, None)
    named = s.value("select count(*) from public.app_audit_log where actor_user_id = %s and target in (%s, %s)",
                    [w.staff.uid, run, str(job)])
    assert status == "running" or named >= 1, (
        "a seatless platform admin stopped a customer's run and the database recorded nobody", status, named)


def test_a_browser_cannot_write_a_workflow_cancel_row_itself(w):
    """BREACH 0226-R3-2 (low). The route no longer writes workflow.cancel: only cancel_workflow_run does. But 'workflow.cancel' is
    still in 0087's browser-writable list and app_audit_log_insert lets any signed-in person insert a row on a channel of theirs (a
    platform admin: with channel_id null, the shape the database writes). Measured: Alice (organization A) writes a workflow.cancel row
    for organization B's run with detail.org_id = B, and a seatless platform admin writes one indistinguishable from the database's,
    for a run they never stopped. The actor stays truthful (actor_user_id is pinned), but "the database records who stopped it" can be
    padded with stops that never happened. Fails until a direct insert of workflow.cancel is refused (a definer function's insert
    bypasses RLS, so a policy that refuses that action does not touch cancel_workflow_run's own row)."""
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    detail = json.dumps({"org_id": str(w.org), "status": "running"})
    alice = as_(s, w.foreign, "insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id) "
                              "values (%s, 'workflow.cancel', %s, %s, %s) returning 1", [w.foreign.uid, run, detail, w.sc.alice.channel])
    staff = as_(s, w.staff, "insert into public.app_audit_log (actor_user_id, action, target, detail) "
                            "values (%s, 'workflow.cancel', %s, %s) returning 1", [w.staff.uid, run, detail])
    assert _run_state(s, run)[0] == "running"
    assert _audit(s, "workflow.cancel", run) == [], ("a browser wrote a workflow.cancel row for a run nobody stopped", alice, staff)


def test_held_nobody_rewrites_or_removes_a_workflow_cancel_row(w):
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    assert as_(s, w.staff, "select public.cancel_workflow_run(%s)", [run]).ok
    for who in (w.member, w.staff):
        assert as_(s, who, "update public.app_audit_log set actor_user_id = %s where target = %s returning 1", [w.member.uid, run]).rows == []
        assert as_(s, who, "delete from public.app_audit_log where target = %s returning 1", [run]).rows == []
    assert [str(r[0]) for r in _audit(s, "workflow.cancel", run)] == [w.staff.uid]


def test_held_staff_cannot_consume_or_answer_someone_elses_pending_consent(w):
    """The delete that oauth_decide_authorization makes before its who-may-call check is keyed on (secret_hash, user_id = auth.uid()):
    a seatless admin's refused approval consumes only their own pending request, which they could equally deny. Another person's
    request stays, and answers 'expired' to anyone else, allowed or denied."""
    s = w.su
    secret = _consent_request(s, w.org, w.member)
    for allow in (True, False):
        out = as_(s, w.staff, "select public.oauth_decide_authorization(%s, %s, 100, %s)", [secret, allow, uuid.uuid4().hex * 2])
        assert out.ok and out.rows[0][0] == {"ok": False, "error": "expired"}, out
    become(s, None)
    assert s.value("select count(*) from public.oauth_auth_requests where secret_hash = %s", [secret]) == 1
    out = as_(s, w.member, DECIDE, [secret, uuid.uuid4().hex * 2])
    assert out.ok and out.rows[0][0]["ok"] is True, out


def test_held_viewer_seat_and_owner_platform_staff_neither_approve_an_app_nor_begin_a_plan(w):
    """The platform arm says admin; the seat (viewer, or none for a platform owner) must win on the round-3 bodies too."""
    s = w.su
    viewer_staff = staff_user(s, "admin")
    _seat(s, w.org, viewer_staff, "viewer")
    owner_staff = staff_user(s, "owner")
    base.chat_ready(s, w.org)
    for who in (viewer_staff, owner_staff):
        before = _grants(s, w.org, who)
        out = as_(s, who, DECIDE, [_consent_request(s, w.org, who), uuid.uuid4().hex * 2])
        assert out.ok and out.rows[0][0] == {"ok": False, "error": "not_a_member"}, out
        assert _grants(s, w.org, who) == before
        session = base.session_of(s, w.org, who, w.channel)
        assert not_a_member(as_(s, who, "select public.ai_chat_plan_begin(%s, 1, 0)", [session]))
        become(s, None)
        assert s.value("select count(*) from public.ai_chat_plan_leases where session_id = %s", [session]) == 0


# ── 0231: every cancel is recorded; a step's job asks the run's rule ─────────

CANCEL = "select public.cancel_creative_job(%s)"


def _job(s, org, who):
    """An ordinary (not a workflow step's) queued creative job of `org`, made by `who` through the Studio's own call."""
    out = as_(s, who, base.CREATE, [org, base.MODEL_SOLD, f"cancel-{uuid.uuid4().hex}"])
    assert out.ok, out
    return out.rows[0][0]["job"]["id"]


def _status(s, job):
    become(s, None)
    return s.value("select status from public.creative_jobs where id = %s", [job])


def test_a_viewer_still_cancels_an_ordinary_job_and_the_database_records_them(w):
    s = w.su
    viewer = _person(s, "viewer-ordinary")
    _seat(s, w.org, viewer, "viewer")
    job = _job(s, w.org, w.member)
    held = money(s, w.org)
    out = as_(s, viewer, CANCEL, [job])
    assert out.ok and out.rows[0][0]["already"] is False, out
    assert _status(s, job) == "cancelled" and money(s, w.org) != held  # the hold went back, as 0036 has it
    become(s, None)
    rows = s.rows("select actor_user_id, detail from public.app_audit_log where action = 'creative.cancel' and target = %s", [job])
    assert [(str(r[0]), r[1]["org_id"]) for r in rows] == [(viewer.uid, str(w.org))], rows


def test_a_seatless_platform_admin_still_cancels_an_ordinary_job_and_is_named(w):
    s = w.su
    job = _job(s, w.org, w.member)
    assert as_(s, w.staff, CANCEL, [job]).ok
    assert [str(r[0]) for r in _audit(s, "creative.cancel", job)] == [w.staff.uid]


def test_a_cancel_of_a_job_that_already_ended_writes_no_row(w):
    s = w.su
    job = _job(s, w.org, w.member)
    assert as_(s, w.member, CANCEL, [job]).ok
    again = as_(s, w.member, CANCEL, [job])
    assert again.ok and again.rows[0][0]["already"] is True, again
    assert len(_audit(s, "creative.cancel", job)) == 1


def test_an_editor_cancels_a_steps_job_and_a_viewers_refusal_comes_before_any_lock_or_write(w):
    s = w.su
    viewer = _person(s, "viewer-step")
    _seat(s, w.org, viewer, "viewer")
    run = _run_confirmed_by(s, w, w.member)
    job = _step_job(s, run)
    held = money(s, w.org)
    out = as_(s, viewer, CANCEL, [job])
    assert not out.ok and (out.sqlstate, out.error) == ("42501", "forbidden"), out
    assert money(s, w.org) == held and _audit(s, "creative.cancel", str(job)) == []
    assert as_(s, w.member, CANCEL, [job]).ok
    assert [str(r[0]) for r in _audit(s, "creative.cancel", str(job))] == [w.member.uid]


def test_another_organizations_member_still_reads_the_job_as_missing_and_writes_nothing(w):
    s = w.su
    job = _job(s, w.org, w.member)
    out = as_(s, w.foreign, CANCEL, [job])
    assert not out.ok and (out.sqlstate, out.error) == ("P0002", "not_found"), out
    assert _audit(s, "creative.cancel", job) == [] and _status(s, job) == "queued"


def test_stopping_a_run_records_the_run_and_its_steps_job_by_the_same_person(w):
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    job = _step_job(s, run)
    assert as_(s, w.staff, "select public.cancel_workflow_run(%s)", [run]).ok
    assert [str(r[0]) for r in _audit(s, "workflow.cancel", run)] == [w.staff.uid]
    assert [str(r[0]) for r in _audit(s, "creative.cancel", str(job))] == [w.staff.uid]


def test_a_browser_cannot_write_a_creative_cancel_row_and_every_other_action_is_as_before(w):
    s = w.su
    job = _job(s, w.org, w.member)
    for who, channel in ((w.member, w.channel), (w.staff, None)):
        out = as_(s, who, "insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id) "
                          "values (%s, 'creative.cancel', %s, '{}'::jsonb, %s) returning 1", [who.uid, job, channel])
        assert not out.ok and out.sqlstate == "42501", out
    # 0087's rule for any other action is untouched: a member still writes a listed action on a channel of theirs.
    out = as_(s, w.member, "insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id) "
                           "values (%s, 'workflow.run', 'lab', '{}'::jsonb, %s) returning 1", [w.member.uid, w.channel])
    assert out.ok, out
    assert _audit(s, "creative.cancel", job) == []


# ── the migration ────────────────────────────────────────────────────────────

def md5_of(c, sig):
    return c.execute("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)",
                     [sig]).fetchone()[0]


def _policy(c):
    return c.execute("select polcmd, polpermissive, polroles::regrole[]::text, pg_get_expr(polwithcheck, polrelid) from pg_policy "
                     "where polrelid = 'public.app_audit_log'::regclass and polname = %s", [audit0231.POLICY]).fetchall()


def _body(path):
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def _state(c):
    return tuple(md5_of(c, sig) for sig, *_ in audit0231.BODIES), _policy(c)


NOWS = tuple(now_ for *_, now_ in audit0231.BODIES)
WASES = tuple(was for _sig, _src, was, _now in audit0231.BODIES)
#: A drifted body: the live one with a comment line added (prosrc keeps comments, so the md5 moves; signature and defaults stay).
TAMPER = ("do $t$ begin execute replace(pg_get_functiondef(to_regprocedure(%s)), 'AS $function$', "
          "'AS $function$' || chr(10) || '-- drifted'); end $t$")
FAKES = {sig: sig for sig, *_ in audit0231.BODIES}


def _tamper(c, sig):
    c.execute(TAMPER.replace("%s", "'" + sig + "'"))


def test_the_live_bodies_and_policy_are_the_files(conn):
    assert _state(conn) == (NOWS, [("a", False, "{authenticated}",
                                    "(action <> ALL (ARRAY['workflow.cancel'::text, 'creative.cancel'::text]))")])


def test_the_file_replaces_exactly_these_four_bodies_and_names_them_in_its_header():
    text = MIGRATION.read_text(encoding="utf-8")
    replaced = sorted(ln.split("(")[0].split(".")[1] for ln in text.splitlines() if ln.startswith("create or replace function public."))
    assert replaced == sorted(sig.split("(")[0].split(".")[1] for sig, *_ in audit0231.BODIES)
    for sig, src, was, now_ in audit0231.BODIES:
        assert f"{was} ({src}) -> {now_}" in text, sig


def test_neither_the_file_nor_its_rollback_holds_a_backslash():
    for path in (MIGRATION, ROLLBACK):
        assert "\\" not in path.read_text(encoding="utf-8"), path.name


def test_a_replay_changes_nothing(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        before = _state(c)
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _state(c) == before
        c.rollback()


@pytest.mark.parametrize("sig", list(FAKES))
def test_the_drift_guard_refuses_a_body_that_is_not_its_own(conn, sig):
    src = dict((b[0], b[1]) for b in audit0231.BODIES)[sig]
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        _tamper(c, sig)
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert f"0231 found {sig} with a body that is neither {src}'s nor 0231's" in str(e.value), str(e.value)
        c.rollback()


def test_the_drift_guard_refuses_a_policy_that_is_not_its_own(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute("drop policy app_audit_log_no_cancel_rows on public.app_audit_log; create policy app_audit_log_no_cancel_rows on "
                  "public.app_audit_log as restrictive for insert to authenticated with check (true)")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "0231 found a policy app_audit_log_no_cancel_rows on public.app_audit_log that is not this file's" in str(e.value)
        c.rollback()


@pytest.mark.parametrize("dropped", ["creative.cancel", "workflow.cancel"])
def test_it_refuses_to_apply_when_a_cancel_action_is_off_the_audit_list(conn, dropped):
    """Breach's note on round 4: with either action off 0087's list app_audit_log_stamp refuses the definer's own insert, so every
    cancel would fail, and cancel_workflow_run's step cancel swallows that in its when others. The file refuses to apply instead."""
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute("create or replace function public.audit_action_allowed(p_action text) returns boolean language sql immutable "
                  "set search_path = public, pg_temp as $$ select coalesce(p_action, '') <> '" + dropped + "' $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "0231 needs creative.cancel and workflow.cancel on audit_action_allowed's list (0087)" in str(e.value), str(e.value)
        c.rollback()


def test_it_refuses_to_apply_without_0226(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        sec_db.take_off_0226(c)
        assert not sec_db.has_0231(c)
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        message = str(e.value)
        # 0215 (is_org_spender) may still be on: then the body guard names 0226's create_creative_job or cancel_workflow_run.
        assert ("0231 needs 0226" in message or "neither 0226's nor 0231's" in message), message
        c.rollback()


def test_the_rollback_puts_the_four_earlier_bodies_back_drops_the_policy_and_0231_applies_again(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute(_body(ROLLBACK))
        assert _state(c) == (WASES, [])
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _state(c)[0] == NOWS and len(_policy(c)) == 1
        c.rollback()


@pytest.mark.parametrize("sig", list(FAKES))
def test_the_rollback_refuses_a_body_that_is_not_0231s(conn, sig):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        _tamper(c, sig)
        with pytest.raises(psycopg.Error) as e:
            c.execute(_body(ROLLBACK))
        assert f"rollback 0231: {sig} is not 0231's body" in str(e.value), str(e.value)
        c.rollback()


def test_sec_dbs_take_off_and_put_back_chain_goes_through_0231(conn):
    """0198's, 0192's and 0226's rollbacks refuse 0231's bodies, and 0231 asks for 0226: take_off_0226 (reached from take_off_0215,
    take_off_0198 and take_off_0192) takes 0231 off first, put_back_0226 puts it back."""
    for off, back in ((sec_db.take_off_0231, sec_db.put_back_0231), (sec_db.take_off_0226, sec_db.put_back_0226),
                      (sec_db.take_off_0198, sec_db.put_back_0198), (sec_db.take_off_0192, sec_db.put_back_0192)):
        with psycopg.connect(st._dsn(conn), autocommit=False) as c:
            off(c)
            assert not sec_db.has_0231(c), off.__name__
            back(c)
            assert sec_db.has_0231(c) and _state(c)[0] == NOWS and len(_policy(c)) == 1, back.__name__
            c.rollback()


# ── Breach round 4 (27 Nov, on bec25b2c2): 0231 attacked ─────────────────────

from test_sec_breach_org_spender_0226 import _finish_first_step, _second_step  # noqa: E402
from sec_db import ANON  # noqa: E402


def test_a_viewer_cannot_stop_a_members_run_by_taking_its_next_steps_idempotency_key(w):
    """BREACH 0231-R4-1 (medium; pre-existing since 0073/BR-L-005, and it defeats 0231's "a viewer who could not stop the run cannot
    stop it through its step either"). workflow_advance_locked makes step N's job with the idempotency key 'wf:<run>:<N>', and
    create_creative_job's key is unique per organization, not per caller. A VIEWER may create creative jobs (0226 asks
    is_org_spender(org, 'viewer')) and reads run ids (workflow_runs_select). So the viewer creates an ordinary job under the NEXT
    step's key and cancels it at once (nothing spent, the hold goes back). When step 1 is due, create_creative_job answers
    idempotency_conflict (or a replay, which advance refuses as BR-L-005), the step fails and the run ends failed/step_failed: a
    member's paid run stopped by someone cancel_workflow_run refuses, with no workflow.cancel row; the only row is a creative.cancel
    on the viewer's own ordinary job, which names no run. Measured on bec25b2c2: run ('failed', 'step_failed'), step 1
    ('failed', 'idempotency_conflict'). Fails until a caller cannot take a key in the 'wf:' namespace (reserved to
    workflow_advance_locked), or the step's key is one no member can know or pre-empt."""
    s = w.su
    viewer = _person(s, "viewer-squat")
    _seat(s, w.org, viewer, "viewer")
    run = _run_confirmed_by(s, w, w.member)
    held = money(s, w.org)
    squat = as_(s, viewer, base.CREATE, [w.org, base.MODEL_SOLD, f"wf:{run}:1"])
    if squat.ok:
        assert as_(s, viewer, CANCEL, [squat.rows[0][0]["job"]["id"]]).ok
        assert money(s, w.org)[0] == held[0]  # the squat cost the organization nothing
    _finish_first_step(s, run)
    assert as_(s, w.member, "select public.advance_workflow_run(%s)", [run]).ok
    step = _second_step(s, run)
    assert (_run_state(s, run)[0], step[0]) == ("running", "running"), (
        "a viewer stopped a member's workflow run by taking its next step's idempotency key", squat, _run_state(s, run), step)


def test_a_cancel_of_a_run_that_already_ended_writes_no_workflow_cancel_row(w):
    """BREACH 0231-R4-2 (low; 0226's cancel_workflow_run, next to 0231's "an answer that the job had already ended writes nothing").
    cancel_workflow_run writes its workflow.cancel row whatever the run's status: after staff stopped a run, any editor (or any
    seatless platform admin, in any organization) may call it again and again, and each call adds a workflow.cancel row naming them
    for a stop that never happened. Only detail.status ('cancelled', not 'running') tells the rows apart; 0231 closed the same padding
    for a browser's own insert (R3-2) and for cancel_creative_job's already-ended answer, not for this one. Measured on bec25b2c2:
    three rows (staff 'running', member 'cancelled' twice). Fails until a call on a run that is not running writes no row."""
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    assert as_(s, w.staff, "select public.cancel_workflow_run(%s)", [run]).ok
    for _ in range(2):
        assert as_(s, w.member, "select public.cancel_workflow_run(%s)", [run]).ok
    assert [str(r[0]) for r in _audit(s, "workflow.cancel", run)] == [w.staff.uid], _audit(s, "workflow.cancel", run)


def test_held_the_creative_cancel_row_names_the_session_not_a_forged_email_claim(w):
    s = w.su
    job = _job(s, w.org, w.member)
    forged = w.member.claims()
    forged["email"] = "ceo@victim.test"
    become(s, None)
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(forged)])
    s.conn.execute("set local role authenticated")
    assert s.run(CANCEL, [job]).ok
    become(s, None)
    assert [(str(a), e) for a, e in _audit(s, "creative.cancel", job)] == [(w.member.uid, w.member.email)]


def test_held_no_browser_path_writes_a_cancel_row_anon_upsert_or_update(w):
    """anon has no permissive insert policy; an upsert onto an existing row needs an update policy, which app_audit_log has none of;
    a plain update of another action into a cancel one is refused the same way."""
    s = w.su
    job = _job(s, w.org, w.member)
    assert as_(s, w.member, CANCEL, [job]).ok
    become(s, None)
    row = s.value("select id from public.app_audit_log where action = 'creative.cancel' and target = %s", [job])
    for action in ("creative.cancel", "workflow.cancel"):
        out = as_(s, ANON, "insert into public.app_audit_log (action, target, detail) values (%s, %s, '{}') returning 1", [action, job])
        assert not out.ok and out.sqlstate == "42501", out
        out = as_(s, w.member, "insert into public.app_audit_log (id, actor_user_id, action, target, detail, channel_id) "
                               "values (%s, %s, 'workflow.run', 'x', '{}', %s) on conflict (id) do update set action = %s returning 1",
                  [row, w.member.uid, w.channel, action])
        assert not out.ok, out
    other = as_(s, w.member, "insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id) "
                             "values (%s, 'workflow.run', 'lab', '{}', %s) returning id", [w.member.uid, w.channel])
    assert other.ok, other
    out = as_(s, w.member, "update public.app_audit_log set action = 'creative.cancel' where id = %s returning 1", [other.rows[0][0]])
    assert out.ok and out.rows == [], out
    assert len(_audit(s, "creative.cancel", job)) == 1


def test_held_a_viewer_cannot_end_a_steps_job_by_any_member_callable_function(w):
    """The member-callable functions that end a creative job: cancel_creative_job (editor for a step, 0231) and cancel_workflow_run
    (editor). The others (expire_creative_jobs, claim/finish/advance/reroute, film_*, model_switch_stop_jobs behind
    owner_set_model_switch) are service-only or platform-owner. create_creative_job's creative_expire_locked(org) ends only jobs past
    their expires_at, which the sweep would end anyway."""
    s = w.su
    viewer = _person(s, "viewer-any")
    _seat(s, w.org, viewer, "viewer")
    run = _run_confirmed_by(s, w, w.member)
    job = _step_job(s, run)
    for q, p in ((CANCEL, [job]), ("select public.cancel_workflow_run(%s)", [run]), ("select public.advance_workflow_run(%s)", [run]),
                 ("select public.expire_creative_jobs()", None)):
        assert not as_(s, viewer, q, p).ok, q
    assert _status(s, job) == "queued" and _run_state(s, run)[0] == "running"


# ── 0231-R4-1 and R4-2, pinned ───────────────────────────────────────────────

MARK = "nightshift.workflow_step_key"


def _jobs_under(s, org, key):
    become(s, None)
    return s.value("select count(*) from public.creative_jobs where org_id = %s and idempotency_key = %s", [org, key])


@pytest.mark.parametrize("seat", ["viewer", "editor", "admin"])
def test_no_member_takes_a_key_in_a_workflow_runs_namespace_and_the_refusal_holds_nothing(w, seat):
    """Any seat, not only a viewer: the key is the run's, whoever could have started it. NS400 invalid_idempotency_key before anything
    is locked, held or written; the detail names the remedy."""
    s = w.su
    person = _person(s, f"{seat}-wf")
    _seat(s, w.org, person, seat)
    run = _run_confirmed_by(s, w, w.member)
    before = money(s, w.org)
    for key in (f"wf:{run}:1", f"wf:{run}:0", "wf:anything", "wf:"):
        out = as_(s, person, base.CREATE, [w.org, base.MODEL_SOLD, key])
        assert not out.ok and out.sqlstate == "NS400" and "invalid_idempotency_key" in out.error, (key, out)
        assert _jobs_under(s, w.org, key) == (1 if key == f"wf:{run}:0" else 0), key  # step 0's own job, made by the run
    assert money(s, w.org) == before


def test_the_refusal_names_the_remedy(w):
    s = w.su
    become(s, w.member)
    with pytest.raises(psycopg.Error) as e:
        s.conn.execute("savepoint k")
        try:
            s.conn.execute(base.CREATE, [w.org, base.MODEL_SOLD, "wf:mine"])
        finally:
            s.conn.execute("rollback to savepoint k")
    become(s, None)
    assert e.value.diag.message_primary == "invalid_idempotency_key"
    assert "choose a key that does not begin with wf:" in (e.value.diag.message_detail or ""), e.value.diag.message_detail


def test_keys_that_only_look_like_the_namespace_are_still_a_members_own(w):
    """Only the exact prefix wf: is the run's: wf-..., wf_..., WF:... and a key with wf: further in stay as 0036 has them."""
    s = w.su
    for key in (f"wf-{uuid.uuid4().hex}", f"wf_{uuid.uuid4().hex}", f"WF:{uuid.uuid4().hex}", f"x-wf:{uuid.uuid4().hex}"):
        assert as_(s, w.member, base.CREATE, [w.org, base.MODEL_SOLD, key]).ok, key


def test_the_marker_admits_only_the_one_key_it_names(w):
    """Even with the setting in hand (it is not: see the next test) a caller gets exactly that one key, never another of the run's or
    another run's."""
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    become(s, w.member)
    s.conn.execute("select set_config(%s, %s, true)", [MARK, f"wf:{run}:1"])
    for key in (f"wf:{run}:2", f"wf:{uuid.uuid4()}:1"):
        out = s.run(base.CREATE, [w.org, base.MODEL_SOLD, key])
        assert not out.ok and out.sqlstate == "NS400" and "invalid_idempotency_key" in out.error, (key, out)
    s.conn.execute("select set_config(%s, '', true)", [MARK])
    become(s, None)


def test_no_function_a_browser_may_call_sets_a_setting_it_is_handed(conn):
    """The marker is sound only while a browser cannot set nightshift.workflow_step_key. set_config is pg_catalog's (PostgREST exposes
    the public schema only), and no function anon or authenticated may execute calls set_config with anything but a literal name, or
    carries the marker in its own SET clause. workflow_advance_locked, which sets it, is executable by neither."""
    exposed = conn.execute(
        "select p.oid::regprocedure::text, p.prosrc, coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p "
        "join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') "
        "and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))").fetchall()
    import re
    for sig, src, config in exposed:
        for arg in re.findall(r"set_config\s*\(\s*([^,]*),", src or ""):
            assert re.fullmatch(r"'[a-z_.]+'", arg.strip()), (sig, arg)
            assert arg.strip() != f"'{MARK}'", sig
        assert MARK not in config, sig
    for role in ("anon", "authenticated"):
        assert not conn.execute("select has_function_privilege(%s, 'public.workflow_advance_locked(uuid, boolean)', 'execute')",
                                [role]).fetchone()[0], role


def test_the_only_callers_of_create_creative_job_make_their_own_keys(conn):
    """The browser is the one caller that chooses a raw key. The API's and connected apps' keys are 'api-'/'oa-' + a hash, so a
    caller's 'wf:...' never reaches the refusal; the workflow's own is the only wf: key."""
    callers = dict(conn.execute(
        "select p.oid::regprocedure::text, p.prosrc from pg_proc p where p.prosrc ~ 'create_creative_job[(]' "
        "and p.pronamespace = 'public'::regnamespace and p.proname <> 'create_creative_job'").fetchall())
    assert sorted(callers) == sorted(["workflow_advance_locked(uuid,boolean)",
                                      "api_creative_create(text,text,text,jsonb,text,numeric,text,text,text)",
                                      "oauth_creative_create(text,uuid,text,text)"]), sorted(callers)
    assert "v_idem := 'api-' || encode(sha256(" in callers["api_creative_create(text,text,text,jsonb,text,numeric,text,text,text)"]
    assert "v_key := 'oa-' || encode(sha256(" in callers["oauth_creative_create(text,uuid,text,text)"]


def test_a_workflow_still_makes_each_steps_job_under_its_key_and_leaves_no_marker(w):
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    _finish_first_step(s, run)
    become(s, w.member)
    assert s.run("select public.advance_workflow_run(%s)", [run]).ok
    assert s.value("select current_setting(%s, true)", [MARK]) in ("", None)
    become(s, None)
    assert _run_state(s, run)[0] == "running" and _second_step(s, run)[0] == "running"
    assert _jobs_under(s, w.org, f"wf:{run}:1") == 1


def test_a_cancel_of_a_running_run_still_writes_its_one_row(w):
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    assert as_(s, w.member, "select public.cancel_workflow_run(%s)", [run]).ok
    assert as_(s, w.member, "select public.cancel_workflow_run(%s)", [run]).ok
    assert [str(r[0]) for r in _audit(s, "workflow.cancel", run)] == [w.member.uid]
