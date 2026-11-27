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
SIG, _SRC, WAS, NOW = audit0231.BODIES[0]



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


def test_the_live_body_and_policy_are_the_files(conn):
    assert md5_of(conn, SIG) == NOW
    assert _policy(conn) == [("a", False, "{authenticated}", "(action <> ALL (ARRAY['workflow.cancel'::text, 'creative.cancel'::text]))")]


def test_neither_the_file_nor_its_rollback_holds_a_backslash():
    for path in (MIGRATION, ROLLBACK):
        assert "\\" not in path.read_text(encoding="utf-8"), path.name


def test_a_replay_changes_nothing(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        before = (md5_of(c, SIG), _policy(c))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert (md5_of(c, SIG), _policy(c)) == before
        c.rollback()


@pytest.mark.parametrize("tamper,message", [
    ("create or replace function public.cancel_creative_job(p_job uuid) returns jsonb language plpgsql security definer "
     "set search_path = public, pg_temp as $$ begin return '{}'::jsonb; end $$",
     "0231 found public.cancel_creative_job(uuid) with a body that is neither 0198's nor 0231's"),
    ("drop policy app_audit_log_no_cancel_rows on public.app_audit_log; create policy app_audit_log_no_cancel_rows on "
     "public.app_audit_log as restrictive for insert to authenticated with check (true)",
     "0231 found a policy app_audit_log_no_cancel_rows on public.app_audit_log that is not this file's"),
])
def test_the_drift_guard_refuses_a_body_or_a_policy_that_is_not_its_own(conn, tamper, message):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute(tamper)
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert message in str(e.value), str(e.value)
        c.rollback()


def test_it_refuses_to_apply_without_0226s_cancel_workflow_run(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        sec_db.take_off_0226(c)
        assert not sec_db.has_0231(c)
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "0231 needs 0226's cancel_workflow_run" in str(e.value), str(e.value)
        c.rollback()


def test_the_rollback_puts_0198s_body_back_drops_the_policy_and_0231_applies_again(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute(_body(ROLLBACK))
        assert md5_of(c, SIG) == WAS and _policy(c) == []
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert md5_of(c, SIG) == NOW and len(_policy(c)) == 1
        c.rollback()


def test_the_rollback_refuses_a_body_that_is_not_0231s(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute("create or replace function public.cancel_creative_job(p_job uuid) returns jsonb language plpgsql security definer "
                  "set search_path = public, pg_temp as $$ begin return '{}'::jsonb; end $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(_body(ROLLBACK))
        assert "rollback 0231: public.cancel_creative_job(uuid) is not 0231's body" in str(e.value), str(e.value)
        c.rollback()


def test_sec_dbs_take_off_and_put_back_chain_goes_through_0231(conn):
    """0198's rollback refuses 0231's cancel_creative_job, and 0231 asks for 0226: take_off_0226 (reached from take_off_0215,
    take_off_0198 and take_off_0192) takes 0231 off first, put_back_0226 puts it back."""
    for off, back in ((sec_db.take_off_0231, sec_db.put_back_0231), (sec_db.take_off_0226, sec_db.put_back_0226),
                      (sec_db.take_off_0198, sec_db.put_back_0198), (sec_db.take_off_0192, sec_db.put_back_0192)):
        with psycopg.connect(st._dsn(conn), autocommit=False) as c:
            off(c)
            assert not sec_db.has_0231(c), off.__name__
            back(c)
            assert sec_db.has_0231(c) and md5_of(c, SIG) == NOW and len(_policy(c)) == 1, back.__name__
            c.rollback()
