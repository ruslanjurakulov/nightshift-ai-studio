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


# ── Round 2 ──────────────────────────────────────────────────────────────────
#
# 0226 now asks is_org_spender(org, 'admin') of set_api_key_access, set_api_key_limit and api_activate, because a key's access, its
# monthly limit and the API's terms decide what keys may spend. The ORGANIZATION'S monthly API limit is the fourth of those settings
# and the one that bounds every key at once (api_begin's cap_cents = least(tier cap, api_settings.monthly_limit_cents)); it is written
# by 0031's api_set_monthly_limit, which still asks only 0043's is_org_member(org, 'admin'). A platform admin with no seat (or only a
# viewer's) in a customer's organization lifts it to the tier ceiling, or clears it, and every member-made key may then spend that much.

import test_sec_org_spender_0226 as base  # noqa: E402
from test_sec_org_spender_0226 import eligible, not_a_member  # noqa: E402

MONTHLY = "select public.api_set_monthly_limit(%s, %s)"


def _activated_with_limit(s, w, org, who, cents):
    eligible(s, org)
    assert as_(s, who, "select public.api_activate(%s, 'v2')", [org]).ok
    assert as_(s, who, MONTHLY, [org, cents]).ok
    become(s, None)


def _org_limit(s, org):
    become(s, None)
    return s.rows("select monthly_limit_cents, updated_by from public.api_settings where org_id = %s", [org])


def test_control_the_organizations_owner_sets_its_monthly_api_limit(w):
    s = w.su
    _activated_with_limit(s, w, w.org, w.member, 1000)
    assert _org_limit(s, w.org) == [(1000, uuid.UUID(w.member.uid))]


def test_a_non_member_platform_admin_cannot_lift_an_organizations_monthly_api_limit(w):
    """BREACH 0226-2. Bob capped his organization's API at 10.00 a month; a platform admin with no seat in it clears the cap (null:
    the tier's own ceiling) and every key Bob's members made may spend up to the tier cap. Fails until api_set_monthly_limit asks
    is_org_spender(p_org, 'admin') as set_api_key_limit now does."""
    s = w.su
    _activated_with_limit(s, w, w.org, w.member, 1000)
    before = _org_limit(s, w.org)
    out = as_(s, w.staff, MONTHLY, [w.org, None])
    assert _org_limit(s, w.org) == before, "a seatless platform admin changed the organization's monthly API limit"
    assert not_a_member(out), out


def test_a_platform_admin_whose_seat_is_a_viewer_cannot_lift_the_monthly_api_limit_either(w):
    """BREACH 0226-2, the viewer-seat variant: the platform arm says admin, the seat says viewer; the seat must win."""
    s = w.su
    staff = staff_user(s, "admin")
    _seat(s, w.org, staff, "viewer")
    _activated_with_limit(s, w, w.org, w.member, 1000)
    before = _org_limit(s, w.org)
    out = as_(s, staff, MONTHLY, [w.org, 100000000])
    assert _org_limit(s, w.org) == before, "a viewer-seat platform admin raised the organization's monthly API limit"
    assert not_a_member(out), out


def test_the_monthly_api_limit_platform_staff_in_the_exempt_organization_and_another_member_as_before(w):
    s = w.su
    _activated_with_limit(s, w, w.exempt, w.staff, 1000)
    assert as_(s, w.staff, MONTHLY, [w.exempt, 2000]).ok
    out = as_(s, w.foreign, MONTHLY, [w.org, 2000])
    assert not out.ok and out.sqlstate == "42501", out


# ── held in round 2: the two bodies rebuilt through EXECUTE still escape what they escaped ──

def test_held_the_rebuilt_brand_scan_still_refuses_an_address_with_a_backslash_before_anything_is_held(w):
    s = w.su
    org = base.scan_org(s)
    before = money(s, org.id)
    for url in ("https://shop.scan.test\\@evil.test/", "https://shop.scan.test/a\\b"):
        out = base.bs.scan(s, org, url, max_credits=2)
        assert not out.ok, (url, out)
    assert money(s, org.id) == before
    become(s, None)
    assert s.value("select count(*) from public.brand_scans where org_id = %s", [org.id]) == 0
    assert base.bs.scan(s, org, "https://shop.scan.test/", max_credits=2).ok


def test_held_the_rebuilt_chat_turn_still_reads_invisible_and_odd_whitespace_as_an_empty_message(w):
    s = w.su
    base.chat_ready(s, w.org)
    sid = str(as_(s, w.member, base.START_CHAT, [w.org, w.channel]).rows[0][0])
    before = base.chat_state(s, w.org)
    for text in ("​­﻿", "\t\r\n\f\u000b", " 　⠀ㅤ", "\U000E0041️‮", "\\"[0:0] + "   "):
        out = as_(s, w.member, base.TURN, [sid, text])
        assert not out.ok and out.error == "invalid_params", (repr(text), out)
    assert base.chat_state(s, w.org) == before
    out = as_(s, w.member, base.TURN, [sid, "a\\b"])  # a backslash is an ordinary character in a message
    assert out.ok, out
    become(s, None)
    assert s.value("select content from public.ai_chat_messages where session_id = %s order by id desc limit 1", [sid]) == "a\\b"


# ── 0211's plan leases (in 0226's approved scope; expected gaps on f226d145a) ──
#
# ai_chat_plan_begin / ai_chat_plan_end (through ai_chat_plan_session) ask only 0043's is_org_member(org, 'editor'). Measured: they
# neither add an ai_chat_calls row nor change what ai_chat_used or ai_chat_trial_left count (begin only re-labels a dead lease's
# pending calls vendor_error, which both counters already count), so they do not themselves spend the cap or the trial: every vendor
# call of a plan goes through ai_chat_reserve_turn, which 0226 refuses. What a seatless platform admin still gets is a running lease
# on a customer's conversation (and a dead plan's pending calls closed), i.e. a write in an organization they may only read.
# The pin below is the regression test for adding is_org_spender(s.org_id, 'editor') to ai_chat_plan_session.

def _chat_counters(s, org):
    become(s, None)
    return (s.value("select public.ai_chat_used(%s)", [org]), s.value("select public.ai_chat_trial_left(%s)", [org]),
            s.value("select count(*) from public.ai_chat_calls where org_id = %s", [org]))


def test_a_non_member_platform_admin_neither_begins_nor_ends_a_plan_in_a_customers_conversation(w):
    s = w.su
    base.chat_ready(s, w.org)
    theirs = base.session_of(s, w.org, w.staff, w.channel)
    counters = _chat_counters(s, w.org)
    out = as_(s, w.staff, "select public.ai_chat_plan_begin(%s, 1, 0)", [theirs])
    become(s, None)
    leases = s.value("select count(*) from public.ai_chat_plan_leases where session_id = %s", [theirs])
    assert _chat_counters(s, w.org) == counters  # holds today: no cap or trial is taken by the lease itself
    assert not_a_member(out) and leases == 0, (out, leases)
    out = as_(s, w.staff, "select public.ai_chat_plan_end(%s, 1, 'done', null)", [theirs])
    assert not_a_member(out), out


def test_held_ai_chat_plan_state_is_read_only_and_moves_no_counter(w):
    """ai_chat_plan_state is STABLE (a write inside it would raise) and reads only the lease: whoever calls it, the cap, the trial
    and the calls stay as they were."""
    s = w.su
    become(s, None)
    assert s.value("select provolatile from pg_proc where oid = 'public.ai_chat_plan_state(uuid)'::regprocedure") == "s"
    base.chat_ready(s, w.org)
    theirs = base.session_of(s, w.org, w.staff, w.channel)
    counters = _chat_counters(s, w.org)
    as_(s, w.staff, "select public.ai_chat_plan_state(%s)", [theirs])
    assert _chat_counters(s, w.org) == counters


# ── Round 3 (Atlas, 27 Nov): a connected app's consent, and the record of what staff may still do ──

def _consent_request(s, org, who):
    """A pending consent of `who` for `org`, as oauth_begin_authorization writes one, with a fresh client."""
    become(s, None)
    client = s.value("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) "
                     "values ('Spend lab app', array['https://claude.ai/api/mcp/auth_callback'], %s) returning client_id",
                     [uuid.uuid4().hex * 2])
    secret = uuid.uuid4().hex + uuid.uuid4().hex
    s.rows("insert into public.oauth_auth_requests (secret_hash, user_id, org_id, client_id, redirect_uri, code_challenge, scopes, resource) "
           "values (%s, %s, %s, %s, 'https://claude.ai/api/mcp/auth_callback', %s, array['videos:read', 'videos:create'], "
           "'https://nightshift-ai.studio/api/mcp') returning 1", [secret, who.uid, org, client, "A" * 43])
    return secret


DECIDE = "select public.oauth_decide_authorization(%s, true, 100, %s)"


def _grants(s, org, who):
    become(s, None)
    return (s.value("select count(*) from public.oauth_grants where org_id = %s", [org]),
            s.value("select count(*) from public.oauth_grants where user_id = %s", [who.uid]),
            s.value("select count(*) from public.oauth_codes c join public.oauth_grants g on g.id = c.grant_id where g.org_id = %s", [org]))


def test_a_non_member_platform_admin_cannot_approve_a_connected_app_on_a_customers_workspace(w):
    """BREACH 0226-3 (Atlas): oauth_decide_authorization is create_api_key's counterpart for connected apps, and asked only 0043's
    is_org_member(org, 'admin'): a seatless platform admin's consent wrote a grant (and a code) that then spends the customer's
    credits, and used one of the workspace's connections for the day. Fails until it asks is_org_spender(r.org_id, 'admin')."""
    s = w.su
    secret = _consent_request(s, w.org, w.staff)
    before = _grants(s, w.org, w.staff)
    out = as_(s, w.staff, DECIDE, [secret, uuid.uuid4().hex + uuid.uuid4().hex])
    assert out.ok, out
    assert _grants(s, w.org, w.staff) == before, "a seatless platform admin's consent wrote a grant on a customer's workspace"
    assert out.rows[0][0] == {"ok": False, "error": "not_a_member"}, out


def test_control_a_member_approves_a_connected_app_and_platform_staff_do_in_the_exempt_workspace(w):
    s = w.su
    for org, who in ((w.org, w.member), (w.exempt, w.staff)):
        secret = _consent_request(s, org, who)
        before = _grants(s, org, who)
        out = as_(s, who, DECIDE, [secret, uuid.uuid4().hex + uuid.uuid4().hex])
        assert out.ok and out.rows[0][0]["ok"] is True and out.rows[0][0]["allowed"] is True, out
        assert _grants(s, org, who)[0] == before[0] + 1


def test_another_organizations_member_approving_on_a_workspace_is_refused_as_before(w):
    s = w.su
    secret = _consent_request(s, w.org, w.foreign)
    out = as_(s, w.foreign, DECIDE, [secret, uuid.uuid4().hex + uuid.uuid4().hex])
    assert out.ok and out.rows[0][0] == {"ok": False, "error": "forbidden"}, out


def _audit(s, action, target):
    become(s, None)
    return s.rows("select actor_user_id, actor_email from public.app_audit_log where action = %s and target = %s", [action, target])


def test_a_seatless_platform_admin_still_cancels_a_customers_run_and_the_database_records_who(w):
    """Staff may restrict, never widen: a cancel stays open to them, and the database (not only the route) writes the workflow.cancel
    row naming the person, for every caller. Fails on f226d145a: the row came only from the route's logAudit."""
    s = w.su
    run = _run_confirmed_by(s, w, w.member)
    out = as_(s, w.staff, "select public.cancel_workflow_run(%s)", [run])
    assert out.ok, out
    rows = _audit(s, "workflow.cancel", run)
    assert [str(r[0]) for r in rows] == [w.staff.uid], rows


def test_a_seatless_platform_admin_still_revokes_a_customers_key_and_it_names_them(w):
    """Already so before 0226: revoke_api_key writes revoked_by and its api_key.revoke row with the signed-in person."""
    s = w.su
    key = base.key_row(s, w.org)
    out = as_(s, w.staff, "select public.revoke_api_key(%s)", [key])
    assert out.ok and out.rows[0][0] is True, out
    become(s, None)
    assert str(s.value("select revoked_by from public.api_keys where id = %s", [key])) == w.staff.uid
    assert [str(r[0]) for r in _audit(s, "api_key.revoke", key)] == [w.staff.uid]
