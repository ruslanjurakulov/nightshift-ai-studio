"""Breach on migration 0226 (only a member spends an organization's credits, on every path), in the shared lab.

0226 asks 0215's is_org_spender on sixteen spend paths. What is left here is the one place where spending power still comes from 0043's
platform arm rather than from a seat: workflow_confirmer_may_spend (0074), which a later workflow step asks before it is made as its
confirmer. It answers yes for any platform owner or admin in any organization, whatever their seat says. For a confirmer with no seat at
all that does not matter (create_creative_job then refuses not_a_member, 0226's own pin), but a platform admin whose seat is a VIEWER
passes both: workflow_confirmer_may_spend through the platform arm, create_creative_job through is_org_spender(org, 'viewer'). So a
later step keeps spending the organization's credits on the confirmation of someone the organization itself would no longer let run a
workflow; an ordinary member demoted the same way gets confirmation_revoked and nothing is held.

Every test runs in one rolled-back transaction (the fixture of test_sec_org_spender_0226): nothing is committed.
"""

from __future__ import annotations

import json
import uuid

from test_sec_org_spender_0226 import (  # noqa: F401  (w is the fixture)
    START, VALUES, as_, become, money, staff_user, total, w, workflow,
)
from sec_db import user
import sec_db


def _seat(s, org, who, role):
    """A bound org_members seat, written the way the service (or a pre-0091 workspace) writes one: org_members_one_person only stops a
    signed-in caller from adding a second person."""
    become(s, None)
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
           [org, who.uid, who.email, role])


def _demote(s, org, who, role):
    become(s, None)
    s.rows("update public.org_members set role = %s where org_id = %s and user_id = %s returning 1", [role, org, who.uid])


def _finish_first_step(s, run):
    """The first step's picture is made: the next advance starts step two, as its confirmer."""
    become(s, None)
    s.rows("update public.workflow_run_steps set status = 'completed' where run_id = %s and step_index = 0 returning 1", [run])
    s.rows("update public.creative_jobs set status = 'completed', result_asset_ids = array[gen_random_uuid()] "
           "where id = (select job_id from public.workflow_run_steps where run_id = %s and step_index = 0) returning 1", [run])


def _second_step(s, run):
    become(s, None)
    return s.rows("select status, error_code, job_id from public.workflow_run_steps where run_id = %s and step_index = 1", [run])[0]


def _run_confirmed_by(s, w, confirmer):
    wf, ver = workflow(s, w.member, w.org)
    run = str(uuid.uuid4())
    out = as_(s, confirmer, START, [run, wf, ver, json.dumps(VALUES), total(s, w.member, wf)])
    assert out.ok, out
    return run


def test_control_a_member_demoted_to_viewer_after_run_now_starts_no_later_step(w):
    """The rule the attack below is measured against (BR-L-006): a confirmer who may no longer run workflows here spends nothing more."""
    s = w.su
    become(s, None)
    editor = user("demoted-editor", f"demoted-editor-{uuid.uuid4().hex[:8]}@nightshift.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [editor.uid, editor.email])
    sec_db.attest_adults(s, editor.uid)
    _seat(s, w.org, editor, "editor")
    run = _run_confirmed_by(s, w, editor)
    _demote(s, w.org, editor, "viewer")
    _finish_first_step(s, run)
    held = money(s, w.org)
    assert as_(s, w.member, "select public.advance_workflow_run(%s)", [run]).ok
    status, code, job = _second_step(s, run)
    assert (status, code, job) == ("failed", "confirmation_revoked", None)
    assert money(s, w.org) == held


def test_a_platform_admin_whose_seat_is_now_a_viewer_starts_no_later_step_and_holds_nothing(w):
    """BREACH 0226-1. The same confirmer, but also a platform admin: workflow_confirmer_may_spend says yes through the platform arm, and
    create_creative_job's is_org_spender(org, 'viewer') says yes through the viewer seat, so step two is made and its price held on the
    organization's account. Fails until workflow_confirmer_may_spend asks for a seat of editor or above (is_org_spender(org, 'editor')
    for the confirmer), as 0226 does on every other path."""
    s = w.su
    staff = staff_user(s, "admin")
    _seat(s, w.org, staff, "editor")
    run = _run_confirmed_by(s, w, staff)
    _demote(s, w.org, staff, "viewer")
    _finish_first_step(s, run)
    held = money(s, w.org)
    assert as_(s, w.member, "select public.advance_workflow_run(%s)", [run]).ok
    status, code, job = _second_step(s, run)
    assert money(s, w.org) == held, "a later step spent the organization's credits on a viewer-seat platform admin's confirmation"
    assert job is None and status == "failed" and code in ("confirmation_revoked", "not_a_member"), (status, code, job)


def test_the_confirmer_rule_itself_answers_for_the_seat_not_the_platform_role(w):
    """The same hole read directly off the helper: for a platform admin with no seat, or only a viewer seat, in a customer's
    organization, workflow_confirmer_may_spend must say no (it says yes today). In the exempt organization it still says yes."""
    s = w.su
    staff = staff_user(s, "admin")
    become(s, None)
    may = "select public.workflow_confirmer_may_spend(%s, %s)"
    assert s.value(may, [staff.uid, w.exempt]) is True
    no_seat = s.value(may, [staff.uid, w.org])
    _seat(s, w.org, staff, "viewer")
    viewer_seat = s.value(may, [staff.uid, w.org])
    assert (no_seat, viewer_seat) == (False, False)
