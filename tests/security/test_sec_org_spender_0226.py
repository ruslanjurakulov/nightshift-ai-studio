"""Migration 0226 (only a member spends an organization's credits, on every path), attacked in the shared lab.

0043's accessible_org_ids makes a platform owner or admin an admin of every organization, so before 0226 every spend path below let
one who holds no seat spend a customer's credits (only the film paths asked 0215's is_org_spender). The owner's decision (22 Nov):
platform staff read an organization (support access) but never spend its credits; in the exempt organization, whose credits are the
platform's own, they may. Each path is pinned for four callers, and what would break without each pin is in its name:

  * a member with the role the path asks: allowed, as before (and a replay still answers its first answer, holding nothing twice);
  * a platform admin with no seat, in a customer's organization: refused not_a_member (NS400; 403 for the API and connected apps)
    BEFORE anything is locked, counted, priced, held or written: the balance, the holds and the ledger are unchanged, no row is made;
  * the same platform admin in the exempt organization: allowed, as before;
  * a member of another organization: refused exactly as before, with the earlier word (the new check never answers first).

Then the migration itself: each body asks is_org_spender before its first lock, hold or write; a replay changes nothing; the drift
guard refuses a body that is neither the earlier file's nor 0226's; the rollback puts every earlier body back and 0226 applies again;
sec_db's take-off / put-back chains go through it.

Every test runs in one rolled-back transaction of the shared lab (conn, sc): nothing is committed.
"""

from __future__ import annotations

import json
import re
import uuid
from types import SimpleNamespace

import psycopg
import pytest
from psycopg import sql

import sec_db
import sec_org_spender_0226 as spender
import test_sec_brand_scan as bs
import test_sec_character_swap as cs
import test_sec_editor_hires_export as hx
import test_sec_repurpose as rp
import test_sec_scene_regenerate as sr
import test_sec_series_tables as st
from sec_db import SERVICE, as_superuser, user
from sec_editor_0054 import PROJECT
from sec_scenario import DEFAULT_ORG, MODEL_SOLD
from sec_storyboard_0057 import insert as insert_storyboard

MIGRATION = sec_db.MIGRATIONS / "0226_org_spender_everywhere.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0226_org_spender_everywhere.sql"


# ── the transaction, its callers, its ground truth ───────────────────────────

def become(s, who):
    """Continue the same transaction as another API caller; the database owner (no claims) when ``who`` is None."""
    s.conn.execute("reset role")
    if who is None:
        s.conn.execute("select set_config('request.jwt.claims', '', true)")
        return s
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def as_(s, who, q, p=None):
    become(s, who)
    out = s.run(q, p)
    become(s, None)
    return out


def not_a_member(out) -> bool:
    return not out.ok and out.sqlstate == "NS400" and out.error == "not_a_member"


def money(s, org):
    """What a refused call must leave exactly as it was: the account, every hold and every ledger row of the organization."""
    become(s, None)
    return (s.rows("select balance, reserved from public.credit_accounts where org_id = %s", [org]),
            s.rows("select job_id, amount, status from public.credit_reservations where org_id = %s order by job_id", [org]),
            s.value("select count(*) from public.credit_transactions where org_id = %s", [org]))


def staff_user(s, role="admin"):
    """A platform owner or admin on the roster (app_members) with no seat in any organization."""
    become(s, None)
    who = user(f"staff-{role}", f"staff-{role}-{uuid.uuid4().hex[:8]}@nightshift.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
    s.rows("insert into public.app_members (user_id, email, role) values (%s, %s, %s) returning 1", [who.uid, who.email, role])
    sec_db.attest_adults(s, who.uid)
    return who


@pytest.fixture()
def w(conn, sc):
    """A rolled-back transaction: Bob's organization (B) is the one spent, Bob (its owner) the member, Alice the other organization's
    member, a platform admin with no seat anywhere, and the exempt organization with its own channel."""
    with as_superuser(conn, commit=False) as su:
        x = SimpleNamespace(su=su, sc=sc)
        x.member, x.org, x.channel = sc.bob.actor, sc.bob.org, sc.bob.channel
        x.foreign = sc.alice.actor
        x.staff = staff_user(su, "admin")
        x.exempt = DEFAULT_ORG
        x.exempt_channel = su.value("select channel_id from public.channels where org_id = public.default_org_id() limit 1")
        # Every plan holds ten runs at once here, so a pin about who may call is never refused for the seed's open holds.
        hx.many_parallel_runs(su)
        become(su, SERVICE)
        for ref in ("job-b", "rj-seed-b"):
            su.value("select public.release_credits(%s)", [ref])
        become(su, None)
        su.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('job_minimum', 5, 0) "
                "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit returning 1")
        # The lab's sellable model on every plan (it asks models_image:basic, which Bob's plan does not carry): who may spend is the
        # question here, not the plan.
        su.rows("update public.model_registry set entitlement = 'any' where id = %s returning 1", [MODEL_SOLD])
        yield x


def test_the_platform_admin_here_is_an_admin_of_every_organization_by_0043_and_a_seat_of_none(w):
    """The premise every pin below stands on: without 0226, is_org_member says yes for a non-member platform admin."""
    s = w.su
    become(s, w.staff)
    s.conn.execute("reset role")
    assert s.value("select public.is_org_member(%s, 'admin')", [w.org]) is True
    assert s.value("select public.is_org_spender(%s, 'admin')", [w.org]) is False
    assert s.value("select public.is_org_spender(%s, 'admin')", [w.exempt]) is True
    become(s, None)


# ── reserve_credits (admin) ──────────────────────────────────────────────────

RESERVE = "select public.reserve_credits(%s, %s, 60)"


def test_reserve_credits_a_member_holds_a_non_member_platform_admin_holds_nothing(w):
    s = w.su
    ref = f"rj-spend-{uuid.uuid4().hex[:12]}"
    ok = as_(s, w.member, RESERVE, [w.org, ref])
    assert ok.ok and float(ok.rows[0][0]["reserved"]) == 60, ok
    # The same reference again is still the duplicate it always was (23505), never a second hold.
    again = as_(s, w.member, RESERVE, [w.org, ref])
    assert not again.ok and again.sqlstate == "23505", again
    before = money(s, w.org)
    out = as_(s, w.staff, RESERVE, [w.org, f"rj-spend-{uuid.uuid4().hex[:12]}"])
    assert not_a_member(out), out
    assert money(s, w.org) == before


def test_reserve_credits_platform_staff_in_the_exempt_organization_and_the_platforms_own_caller_still_reserve(w):
    s = w.su
    out = as_(s, w.staff, RESERVE, [w.exempt, f"rj-spend-{uuid.uuid4().hex[:12]}"])
    assert out.ok and out.rows[0][0]["exempt"] is True, out
    # The service key (the worker, creative_platform_reserve) is the platform's own caller: not asked.
    svc = as_(s, SERVICE, RESERVE, [w.org, f"rj-spend-{uuid.uuid4().hex[:12]}"])
    assert svc.ok, svc


def test_reserve_credits_another_organizations_member_is_refused_as_before(w):
    s = w.su
    before = money(s, w.org)
    out = as_(s, w.foreign, RESERVE, [w.org, f"rj-spend-{uuid.uuid4().hex[:12]}"])
    assert not out.ok and out.sqlstate == "42501", out
    assert money(s, w.org) == before


# ── create_creative_job (viewer: any member) ─────────────────────────────────

CREATE = "select public.create_creative_job(%s, 't2i', %s, '{\"prompt\": \"a lighthouse\"}'::jsonb, 'exact', %s, 1000)"


def creative_jobs(s, org):
    become(s, None)
    return s.value("select count(*) from public.creative_jobs where org_id = %s", [org])


def test_create_creative_job_a_member_creates_and_a_replay_answers_the_first_job(w):
    s = w.su
    key = f"spend-{uuid.uuid4().hex}"
    first = as_(s, w.member, CREATE, [w.org, MODEL_SOLD, key])
    assert first.ok and first.rows[0][0]["replay"] is False, first
    held = money(s, w.org)
    again = as_(s, w.member, CREATE, [w.org, MODEL_SOLD, key])
    assert again.ok and again.rows[0][0]["replay"] is True, again
    assert again.rows[0][0]["job"]["id"] == first.rows[0][0]["job"]["id"]
    assert money(s, w.org) == held  # held once


def test_create_creative_job_a_non_member_platform_admin_is_refused_before_anything_is_held(w):
    s = w.su
    before, jobs = money(s, w.org), creative_jobs(s, w.org)
    out = as_(s, w.staff, CREATE, [w.org, MODEL_SOLD, f"spend-{uuid.uuid4().hex}"])
    assert not_a_member(out), out
    assert money(s, w.org) == before and creative_jobs(s, w.org) == jobs


def test_create_creative_job_platform_staff_in_the_exempt_organization_creates(w):
    s = w.su
    out = as_(s, w.staff, CREATE, [w.exempt, MODEL_SOLD, f"spend-{uuid.uuid4().hex}"])
    assert out.ok, out
    become(s, None)
    assert s.value("select credit_ref from public.creative_jobs where id = %s", [out.rows[0][0]["job"]["id"]]) is None  # the platform pays


def test_create_creative_job_another_organizations_member_is_refused_as_before(w):
    s = w.su
    out = as_(s, w.foreign, CREATE, [w.org, MODEL_SOLD, f"spend-{uuid.uuid4().hex}"])
    assert not out.ok and (out.sqlstate, out.error) == ("42501", "forbidden"), out


# ── workflows: start_workflow_run and advance_workflow_run (editor) ──────────

STEP = {"capability": "t2i", "model": MODEL_SOLD, "params": {"prompt": {"$input": "idea"}}}
INPUTS = [{"name": "idea", "kind": "text"}]
VALUES = {"idea": "a lighthouse at dusk"}


def workflow(s, who, org):
    out = as_(s, who, "select public.save_workflow(%s::uuid, null, 'Two pictures', %s::jsonb, %s::jsonb)",
              [org, json.dumps(INPUTS), json.dumps([STEP, STEP])])
    assert out.ok, out
    wf = out.rows[0][0]
    return wf["id"], wf["version"]


def total(s, who, wf):
    q = as_(s, who, "select public.quote_workflow(%s, %s::jsonb)", [wf, json.dumps(VALUES)])
    assert q.ok, q
    return q.rows[0][0]["total"]


START = "select public.start_workflow_run(%s::uuid, %s::uuid, %s::integer, %s::jsonb, %s::numeric)"


def runs(s, org):
    become(s, None)
    return s.value("select count(*) from public.workflow_runs where org_id = %s", [org])


def test_workflows_a_member_runs_and_a_replayed_run_id_answers_the_first_run(w):
    s = w.su
    wf, ver = workflow(s, w.member, w.org)
    run = str(uuid.uuid4())
    t = total(s, w.member, wf)
    first = as_(s, w.member, START, [run, wf, ver, json.dumps(VALUES), t])
    assert first.ok and first.rows[0][0].get("replay") is not True, first
    held = money(s, w.org)
    again = as_(s, w.member, START, [run, wf, ver, json.dumps(VALUES), t])
    assert again.ok and again.rows[0][0]["replay"] is True, again
    assert money(s, w.org) == held
    adv = as_(s, w.member, "select public.advance_workflow_run(%s)", [run])
    assert adv.ok, adv


def test_workflows_a_non_member_platform_admin_neither_starts_nor_advances_a_run(w):
    s = w.su
    wf, ver = workflow(s, w.member, w.org)
    t = total(s, w.member, wf)
    before, n = money(s, w.org), runs(s, w.org)
    out = as_(s, w.staff, START, [str(uuid.uuid4()), wf, ver, json.dumps(VALUES), t])
    assert not_a_member(out), out
    assert money(s, w.org) == before and runs(s, w.org) == n
    # A member's run, carried on by the staff's page: refused before the account is locked or a step started.
    run = str(uuid.uuid4())
    assert as_(s, w.member, START, [run, wf, ver, json.dumps(VALUES), t]).ok
    held = money(s, w.org)
    adv = as_(s, w.staff, "select public.advance_workflow_run(%s)", [run])
    assert not_a_member(adv), adv
    assert money(s, w.org) == held


def test_workflows_platform_staff_in_the_exempt_organization_start_and_advance(w):
    s = w.su
    wf, ver = workflow(s, w.staff, w.exempt)
    run = str(uuid.uuid4())
    out = as_(s, w.staff, START, [run, wf, ver, json.dumps(VALUES), total(s, w.staff, wf)])
    assert out.ok, out
    assert as_(s, w.staff, "select public.advance_workflow_run(%s)", [run]).ok


def test_workflows_another_organizations_member_is_refused_as_before(w):
    s = w.su
    wf, ver = workflow(s, w.member, w.org)
    t = total(s, w.member, wf)
    out = as_(s, w.foreign, START, [str(uuid.uuid4()), wf, ver, json.dumps(VALUES), t])
    assert not out.ok and (out.sqlstate, out.error) == ("P0002", "not_found"), out
    run = str(uuid.uuid4())
    assert as_(s, w.member, START, [run, wf, ver, json.dumps(VALUES), t]).ok
    adv = as_(s, w.foreign, "select public.advance_workflow_run(%s)", [run])
    assert not adv.ok and (adv.sqlstate, adv.error) == ("P0002", "not_found"), adv


def test_a_later_workflow_step_of_a_confirmer_without_a_seat_is_refused_not_a_member_and_holds_nothing(w):
    """workflow_advance_locked makes a later step as the member who confirmed the run, through create_creative_job: a confirmer who
    is (now) a platform admin without a seat makes the step refuse with not_a_member, never spend."""
    s = w.su
    wf, ver = workflow(s, w.member, w.org)
    run = str(uuid.uuid4())
    assert as_(s, w.member, START, [run, wf, ver, json.dumps(VALUES), total(s, w.member, wf)]).ok
    become(s, None)
    # The confirmer becomes a platform admin and loses the seat (the shape of staff who confirmed, then left).
    s.rows("update public.workflow_runs set started_by = %s where id = %s returning 1", [w.staff.uid, run])
    s.rows("update public.workflow_run_steps set status = 'completed' where run_id = %s and step_index = 0 returning 1", [run])
    s.rows("update public.creative_jobs set status = 'completed', result_asset_ids = array[gen_random_uuid()] "
           "where id = (select job_id from public.workflow_run_steps where run_id = %s and step_index = 0) returning 1", [run])
    held = money(s, w.org)
    assert as_(s, w.member, "select public.advance_workflow_run(%s)", [run]).ok
    become(s, None)
    step = s.rows("select status, error_code from public.workflow_run_steps where run_id = %s and step_index = 1", [run])[0]
    assert step[1] == "not_a_member", step
    assert money(s, w.org) == held


# ── approve_storyboard (admin) ───────────────────────────────────────────────

def storyboard(s, channel):
    become(s, SERVICE)
    out = insert_storyboard(s, channel, f"spend-{uuid.uuid4().hex[:8]}")
    assert out.ok, out
    become(s, None)
    for unit, rate in {"video_minute": 12, "job_minimum": 5}.items():
        s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
               "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 returning 1", [unit, rate])
    return str(out.rows[0][0])


APPROVE = "select public.approve_storyboard(%s, 60, 'queue')"


def sb_status(s, sid):
    become(s, None)
    return s.value("select status from public.storyboards where id = %s", [sid])


def test_approve_storyboard_a_member_approves_once_a_non_member_platform_admin_holds_nothing(w):
    s = w.su
    mine, theirs = storyboard(s, w.channel), storyboard(s, w.channel)
    ok = as_(s, w.member, APPROVE, [mine])
    assert ok.ok and ok.rows[0][0]["credit_ref"].startswith("rj-"), ok
    again = as_(s, w.member, APPROVE, [mine])
    assert not again.ok and again.sqlstate == "NS409", again  # a second press holds nothing (storyboard_not_ready)
    before = money(s, w.org)
    out = as_(s, w.staff, APPROVE, [theirs])
    assert not_a_member(out), out
    assert money(s, w.org) == before and sb_status(s, theirs) == "ready"


def test_approve_storyboard_platform_staff_in_the_exempt_organization_approve(w):
    s = w.su
    sid = storyboard(s, w.exempt_channel)
    out = as_(s, w.staff, APPROVE, [sid])
    assert out.ok and out.rows[0][0]["credit_ref"] is None, out


def test_approve_storyboard_another_organizations_member_is_refused_as_before(w):
    s = w.su
    sid = storyboard(s, w.channel)
    out = as_(s, w.foreign, APPROVE, [sid])
    assert not out.ok and (out.sqlstate, out.error) == ("42501", "forbidden"), out
    assert sb_status(s, sid) == "ready"


# ── request_scene_regenerate (admin) ─────────────────────────────────────────

def regen_video(s, channel, key):
    become(s, None)
    sr._set_prices(s, sr.PRICES)
    return sr._held_video(s, SimpleNamespace(channel=channel, key=key), f"spend-regen-{uuid.uuid4().hex[:6]}")


REGEN = "select public.request_scene_regenerate(%s, 's000', null, 'same', %s::numeric, %s)"


def regens(s, vid):
    become(s, None)
    return s.value("select count(*) from public.scene_regenerations where video_id = %s", [vid])


def test_scene_regenerate_a_member_presses_and_a_replay_answers_the_first_press(w):
    s = w.su
    vid = regen_video(s, w.channel, "b")
    key = f"press-{uuid.uuid4().hex}"
    first = as_(s, w.member, REGEN, [vid, sr.GEN, key])
    assert first.ok and not first.rows[0][0].get("replayed"), first
    held = money(s, w.org)
    again = as_(s, w.member, REGEN, [vid, sr.GEN, key])
    assert again.ok and again.rows[0][0]["replayed"] is True and again.rows[0][0]["id"] == first.rows[0][0]["id"], again
    assert money(s, w.org) == held


def test_scene_regenerate_a_non_member_platform_admin_is_refused_before_anything_is_held(w):
    s = w.su
    vid = regen_video(s, w.channel, "b")
    before = money(s, w.org)
    out = as_(s, w.staff, REGEN, [vid, sr.GEN, f"press-{uuid.uuid4().hex}"])
    assert not_a_member(out), out
    assert money(s, w.org) == before and regens(s, vid) == 0


def test_scene_regenerate_platform_staff_in_the_exempt_organization_press(w):
    s = w.su
    vid = regen_video(s, w.exempt_channel, "op")
    out = as_(s, w.staff, REGEN, [vid, None, f"press-{uuid.uuid4().hex}"])
    assert out.ok, out


def test_scene_regenerate_another_organizations_member_is_refused_as_before(w):
    s = w.su
    vid = regen_video(s, w.channel, "b")
    out = as_(s, w.foreign, REGEN, [vid, sr.GEN, f"press-{uuid.uuid4().hex}"])
    assert not out.ok and (out.sqlstate, out.error) == ("42501", "forbidden"), out


# ── request_repurpose (admin) ────────────────────────────────────────────────

def master(s, channel, key):
    become(s, None)
    rp._set_prices(s, rp.PRICES)
    return rp._master(s, SimpleNamespace(channel=channel, key=key), f"spend-master-{uuid.uuid4().hex[:6]}")


REPURPOSE = "select public.request_repurpose(%s, %s::jsonb, %s::numeric, %s)"


def test_repurpose_a_member_presses_and_a_replay_answers_the_first_press(w):
    s = w.su
    vid = master(s, w.channel, "b")
    key = f"press-{uuid.uuid4().hex}"
    first = as_(s, w.member, REPURPOSE, [vid, rp.cj(rp.A), rp.ONE, key])
    assert first.ok, first
    held = money(s, w.org)
    again = as_(s, w.member, REPURPOSE, [vid, rp.cj(rp.A), rp.ONE, key])
    assert again.ok and again.rows[0][0]["id"] == first.rows[0][0]["id"], again
    assert money(s, w.org) == held


def test_repurpose_a_non_member_platform_admin_is_refused_before_anything_is_held(w):
    s = w.su
    vid = master(s, w.channel, "b")
    before = money(s, w.org)
    out = as_(s, w.staff, REPURPOSE, [vid, rp.cj(rp.A), rp.ONE, f"press-{uuid.uuid4().hex}"])
    assert not_a_member(out), out
    assert money(s, w.org) == before
    become(s, None)
    assert s.value("select count(*) from public.repurpose_requests where video_id = %s", [vid]) == 0


def test_repurpose_platform_staff_in_the_exempt_organization_press(w):
    s = w.su
    vid = master(s, w.exempt_channel, "op")
    out = as_(s, w.staff, REPURPOSE, [vid, rp.cj(rp.A), None, f"press-{uuid.uuid4().hex}"])
    assert out.ok, out


def test_repurpose_another_organizations_member_is_refused_as_before(w):
    s = w.su
    vid = master(s, w.channel, "b")
    out = as_(s, w.foreign, REPURPOSE, [vid, rp.cj(rp.A), rp.ONE, f"press-{uuid.uuid4().hex}"])
    assert not out.ok and (out.sqlstate, out.error) == ("42501", "forbidden"), out


# ── start_series_episode (admin) ─────────────────────────────────────────────

def episode(s, who, channel):
    become(s, None)
    st.set_prices(s)
    s.rows("update public.channels set niche = 'tech' where channel_id = %s returning 1", [channel])
    if s.value("select to_regclass('public.series_plan_cap_settings') is not null"):
        s.rows("update public.series_plan_cap_settings set user_daily_cap = 1000, global_daily_cap = 10000 returning 1")
    _plan, eps = st.ready_plan(s, who, channel)
    become(s, None)
    return eps[0]


def test_series_a_member_starts_an_episode_and_a_replay_answers_the_first_start(w):
    s = w.su
    ep = episode(s, w.member, w.channel)
    first = st.start(s, w.member, ep)
    assert first.ok, first
    held = money(s, w.org)
    again = st.start(s, w.member, ep)
    assert again.ok and again.rows[0][0]["replayed"] is True, again
    assert money(s, w.org) == held


def test_series_a_non_member_platform_admin_is_refused_before_anything_is_held(w):
    s = w.su
    ep = episode(s, w.member, w.channel)
    before = money(s, w.org)
    out = st.start(s, w.staff, ep)
    assert not_a_member(out), out
    assert money(s, w.org) == before and st.episode_row(s, ep)[0] == "planned"


def test_series_platform_staff_in_the_exempt_organization_start(w):
    s = w.su
    ep = episode(s, w.sc.operator, w.exempt_channel)
    out = st.start(s, w.staff, ep, None)
    assert out.ok and out.rows[0][0]["credit_ref"] is None, out


def test_series_another_organizations_member_is_refused_as_before(w):
    s = w.su
    ep = episode(s, w.member, w.channel)
    assert st.not_found(st.start(s, w.foreign, ep))


# ── request_editor_export, the paid one (editor) ─────────────────────────────

REQ4 = "select public.request_editor_export(%s, %s, 'vertical_2160p', %s::numeric)"


def paid_quote(s, who, project):
    q = as_(s, who, "select public.quote_editor_export(%s, %s, 'vertical_2160p')", [project, 1])
    assert q.ok, q
    return q.rows[0][0]["credits"]


def test_paid_editor_export_a_member_asks_a_non_member_platform_admin_holds_nothing(w):
    s = w.su
    hx.clear(s, w.org)
    hx.price(s, 4.5, 12.25)
    credits = paid_quote(s, w.member, PROJECT["b"])
    ok = as_(s, w.member, REQ4, [PROJECT["b"], 1, credits])
    assert ok.ok, ok
    before, n = money(s, w.org), hx.exports_of(s, w.org)
    out = as_(s, w.staff, REQ4, [PROJECT["b"], 1, credits])
    assert not_a_member(out), out
    assert money(s, w.org) == before and hx.exports_of(s, w.org) == n


def test_paid_editor_export_platform_staff_in_the_exempt_organization_ask(w):
    s = w.su
    hx.price(s, 4.5, 12.25)
    become(s, SERVICE)
    video = str(s.value("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 1000, %s, 'generated', "
                        "p_duration_s => 20) ->> 'id'", [w.exempt, uuid.uuid4().hex * 2]))
    from sec_editor_0054 import doc
    made = as_(s, w.staff, "select public.create_editor_project(%s, 'Exempt edit', %s::jsonb)", [w.exempt, json.dumps(doc(video))])
    assert made.ok, made
    project = str(made.rows[0][0])
    out = as_(s, w.staff, REQ4, [project, 1, paid_quote(s, w.staff, project)])
    assert out.ok, out


def test_paid_editor_export_another_organizations_member_is_refused_as_before(w):
    s = w.su
    hx.price(s, 4.5, 12.25)
    out = as_(s, w.foreign, REQ4, [PROJECT["b"], 1, 12.25])
    assert not out.ok and (out.sqlstate, out.error) == ("P0002", "not_found"), out


# ── request_brand_scan (editor) ──────────────────────────────────────────────

def scan_org(s):
    """bs.Org: a fresh organization (owner, editor, viewer, 100 credits) with a verified shop.scan.test; scans at 2 credits."""
    become(s, None)
    s.conn.execute("update public.brand_domain_checks set finished_at = now(), ok = false, code = 'expired' where finished_at is null")
    org = bs.Org(s)
    bs.domain(s, org, "shop.scan.test")
    bs.price(s, 2)
    return org


def test_brand_scan_a_member_scans_and_a_replay_answers_the_first_scan(w):
    s = w.su
    org = scan_org(s)
    key = bs.key()
    first = bs.scan(s, org, "https://shop.scan.test/", idem=key, max_credits=2)
    assert first.ok, first
    held = money(s, org.id)
    again = bs.scan(s, org, "https://shop.scan.test/", idem=key, max_credits=2)
    assert again.ok and again.rows[0][0]["replayed"] is True, again
    assert money(s, org.id) == held


def test_brand_scan_a_non_member_platform_admin_is_refused_before_anything_is_held(w):
    s = w.su
    org = scan_org(s)
    before = money(s, org.id)
    out = bs.scan(s, org, "https://shop.scan.test/", max_credits=2, who=w.staff)
    become(s, None)
    assert not_a_member(out), out
    assert money(s, org.id) == before
    assert s.value("select count(*) from public.brand_scans where org_id = %s", [org.id]) == 0


def test_brand_scan_platform_staff_in_the_exempt_organization_scan(w):
    s = w.su
    become(s, None)
    s.conn.execute("update public.brand_domain_checks set finished_at = now(), ok = false, code = 'expired' where finished_at is null")
    exempt = SimpleNamespace(id=w.exempt, ed=w.staff)
    bs.domain(s, exempt, "exempt.scan.test")
    bs.price(s, 2)
    out = bs.scan(s, exempt, "https://exempt.scan.test/", max_credits=2, who=w.staff)
    assert out.ok, out


def test_brand_scan_another_organizations_member_is_refused_as_before(w):
    s = w.su
    org = scan_org(s)
    out = bs.scan(s, org, "https://shop.scan.test/", max_credits=2, who=w.foreign)
    assert not out.ok and (out.sqlstate, out.error) == ("42501", "forbidden"), out


# ── request_character_swap (editor) ──────────────────────────────────────────

def swap_org(s):
    become(s, None)
    s.conn.execute("update public.character_swap_jobs set status = 'failed', error_code = 'lab', finished_at = now() "
                   "where status in ('requested', 'running')")
    cs.job_minimum(s, 30)
    org = cs.Org(s)
    cs.price(s, 10)
    return org


def test_character_swap_a_member_asks_and_a_replay_answers_the_first_swap(w):
    s = w.su
    org = swap_org(s)
    c = cs.consent(s, org)
    assert c.ok, c
    key = cs.key()
    first = cs.swap(s, org, consent_id=c.rows[0][0]["id"], idem=key)
    assert first.ok, first
    held = money(s, org.id)
    again = cs.swap(s, org, consent_id=c.rows[0][0]["id"], idem=key)
    assert again.ok and again.rows[0][0]["replayed"] is True, again
    assert money(s, org.id) == held


def test_character_swap_a_non_member_platform_admin_is_refused_before_anything_is_held(w):
    s = w.su
    org = swap_org(s)
    c = cs.consent(s, org)  # the editor's consent: only the request is the staff's
    assert c.ok, c
    before = money(s, org.id)
    out = cs.swap(s, org, who=w.staff, consent_id=c.rows[0][0]["id"])
    become(s, None)
    assert not_a_member(out), out
    assert money(s, org.id) == before
    assert s.value("select count(*) from public.character_swap_jobs where org_id = %s", [org.id]) == 0


def test_character_swap_platform_staff_in_the_exempt_organization_ask(w):
    s = w.su
    swap_org(s)
    exempt = SimpleNamespace(id=w.exempt, ed=w.staff, video=cs.asset(s, w.exempt, "video", seconds=10),
                             pics=[cs.asset(s, w.exempt, "image")])
    out = cs.swap(s, exempt, who=w.staff)
    assert out.ok, out


def test_character_swap_another_organizations_member_is_refused_as_before(w):
    s = w.su
    org = swap_org(s)
    c = cs.consent(s, org)
    assert c.ok, c
    out = cs.swap(s, org, who=w.foreign, consent_id=c.rows[0][0]["id"])
    assert not out.ok and (out.sqlstate, out.error) == ("42501", "forbidden"), out


# ── request_download (editor) ────────────────────────────────────────────────

def download_video(s, org, channel):
    become(s, None)
    vid = f"vid-spend-{uuid.uuid4().hex[:10]}"
    s.rows("insert into public.videos (video_id, channel_id, title, slug, review_state) values (%s, %s, 'V', %s, 'pending') returning 1",
           [vid, channel, vid])
    s.rows("insert into public.download_masters (video_id, org_id, width, height, duration_seconds, bytes) "
           "values (%s, %s, 1920, 1080, 60, 1000) returning 1", [vid, org])
    return vid


DOWNLOAD = "select public.request_download(%s, '1080p', null)"


def downloads(s, vid):
    become(s, None)
    return s.value("select count(*) from public.download_requests where video_id = %s", [vid])


def test_download_a_member_buys_and_asking_again_reuses_it_charging_nothing_more(w):
    s = w.su
    vid = download_video(s, w.org, w.channel)
    first = as_(s, w.member, DOWNLOAD, [vid])
    assert first.ok, first
    paid = money(s, w.org)
    again = as_(s, w.member, DOWNLOAD, [vid])
    assert again.ok and again.rows[0][0]["reused"] is True and again.rows[0][0]["charged"] == 0, again
    assert money(s, w.org) == paid


def test_download_a_non_member_platform_admin_is_refused_before_anything_is_charged(w):
    s = w.su
    vid = download_video(s, w.org, w.channel)
    before = money(s, w.org)
    out = as_(s, w.staff, DOWNLOAD, [vid])
    assert not_a_member(out), out
    assert money(s, w.org) == before and downloads(s, vid) == 0


def test_download_platform_staff_in_the_exempt_organization_buy(w):
    s = w.su
    vid = download_video(s, w.exempt, w.exempt_channel)
    out = as_(s, w.staff, DOWNLOAD, [vid])
    assert out.ok, out


def test_download_another_organizations_member_is_refused_as_before(w):
    s = w.su
    vid = download_video(s, w.org, w.channel)
    out = as_(s, w.foreign, DOWNLOAD, [vid])
    assert not out.ok and out.sqlstate == "42501", out
    assert downloads(s, vid) == 0


# ── render_jobs_payment_guard: a browser's own queue row (admin) ─────────────

QUEUE = ("insert into public.render_jobs (channel_id, kind, params, status, requested_by, credit_ref) "
         "values (%s, 'daily', '{\"duration\": 300}', 'queued', %s, %s) returning id")


def queue_hold(s, org):
    """A queue hold placed by the platform (a hold that exists is not what the guard is asked here; who inserts the row is)."""
    become(s, None)
    s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('video_minute', 12, 0) "
           "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 returning 1")
    ref = f"rj-spend-{uuid.uuid4().hex[:12]}"
    assert as_(s, SERVICE, "select public.reserve_credits(%s, %s, 60)", [org, ref]).ok
    return ref


def queued(s, channel):
    become(s, None)
    return s.value("select count(*) from public.render_jobs where channel_id = %s", [channel])


def test_render_guard_a_members_queue_row_goes_in_a_non_member_platform_admins_does_not(w):
    s = w.su
    ok = as_(s, w.member, QUEUE, [w.channel, w.member.uid, queue_hold(s, w.org)])
    assert ok.ok, ok
    ref = queue_hold(s, w.org)
    before, n = money(s, w.org), queued(s, w.channel)
    out = as_(s, w.staff, QUEUE, [w.channel, w.staff.uid, ref])
    assert not_a_member(out), out
    assert money(s, w.org) == before and queued(s, w.channel) == n


def test_render_guard_platform_staff_in_the_exempt_organization_queue(w):
    s = w.su
    out = as_(s, w.staff, QUEUE, [w.exempt_channel, w.staff.uid, None])
    assert out.ok, out


def test_render_guard_another_organizations_member_is_refused_as_before(w):
    s = w.su
    out = as_(s, w.foreign, QUEUE, [w.channel, w.foreign.uid, queue_hold(s, w.org)])
    assert not out.ok and out.sqlstate == "42501", out


# ── create_api_key (admin) ───────────────────────────────────────────────────

KEY = "select (public.create_api_key(%s, 'spend lab', null) ->> 'id')"


def keys(s, org):
    become(s, None)
    return (s.value("select count(*) from public.api_keys where org_id = %s", [org]),
            s.value("select count(*) from public.app_audit_log where action = 'api_key.create'"))


def test_create_api_key_a_member_makes_one_a_non_member_platform_admin_makes_none(w):
    s = w.su
    ok = as_(s, w.member, KEY, [w.org])
    assert ok.ok and ok.rows[0][0], ok
    before = keys(s, w.org)
    out = as_(s, w.staff, KEY, [w.org])
    assert not_a_member(out), out
    assert keys(s, w.org) == before
    # create_scoped_api_key calls it before writing anything: refused the same way, nothing written.
    scoped = as_(s, w.staff, "select public.create_scoped_api_key(%s, 'spend lab', null, array['videos:read'], null, null)", [w.org])
    assert not_a_member(scoped), scoped
    assert keys(s, w.org) == before


def test_create_api_key_platform_staff_in_the_exempt_organization_make_one(w):
    s = w.su
    become(s, None)
    s.rows("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1') "
           "on conflict (org_id) do update set activated_at = now() returning 1", [w.exempt, w.staff.uid])
    out = as_(s, w.staff, KEY, [w.exempt])
    assert out.ok and out.rows[0][0], out


def test_create_api_key_another_organizations_member_is_refused_as_before(w):
    s = w.su
    out = as_(s, w.foreign, KEY, [w.org])
    assert not out.ok and out.sqlstate == "42501", out


# ── api_begin: a key spends as the person who made it (admin) ────────────────

def api_key(s, org, maker):
    become(s, None)
    h = uuid.uuid4().hex + uuid.uuid4().hex
    s.rows("insert into public.api_keys (org_id, name, key_hash, created_by) values (%s, 'spend lab', %s, %s) returning 1",
           [org, h, maker.uid])
    s.rows("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1') "
           "on conflict (org_id) do update set activated_at = now() returning 1", [org, maker.uid])
    return h


def api_state(s, org, h):
    become(s, None)
    return (s.value("select count(*) from public.api_requests where org_id = %s", [org]),
            s.value("select coalesce(sum(count), 0) from public.api_rate_counters c join public.api_keys k on k.id = c.key_id "
                    "where k.key_hash = %s", [h]),
            s.rows("select amount_cents, status from public.api_holds where org_id = %s order by ref", [org]))


def api_call(s, q, p):
    out = as_(s, sec_db.ANON, q, p)
    assert out.ok, out
    return out.rows[0][0]


LIST = "select public.api_list_channels(%s, null)"
CREATE_VIDEO = "select public.api_create_video(%s, %s, '{\"topic\": \"a lighthouse\", \"duration\": 60}'::jsonb, %s, null, null)"


def test_api_a_members_key_is_answered_a_key_a_non_member_platform_admin_made_is_refused_uncounted(w):
    s = w.su
    mine = api_key(s, w.org, w.member)
    assert api_call(s, LIST, [mine]).get("ok") is not False
    theirs = api_key(s, w.org, w.staff)
    before, credits = api_state(s, w.org, theirs), money(s, w.org)
    for q, p in ((LIST, [theirs]), (CREATE_VIDEO, [theirs, w.channel, f"idem-{uuid.uuid4().hex}"])):
        out = api_call(s, q, p)
        assert out["ok"] is False and out["status"] == 403 and out["error"]["code"] == "not_a_member", out
    assert api_state(s, w.org, theirs) == before and money(s, w.org) == credits


def test_api_a_key_platform_staff_made_in_the_exempt_organization_is_answered(w):
    s = w.su
    h = api_key(s, w.exempt, w.staff)
    assert api_call(s, LIST, [h]).get("ok") is not False


def test_api_a_key_whose_maker_is_no_admin_at_all_is_refused_as_before(w):
    s = w.su
    h = api_key(s, w.org, w.foreign)
    out = api_call(s, LIST, [h])
    assert out["ok"] is False and out["error"]["code"] == "key_owner_not_admin", out


# ── oauth_ctx: a connected app spends as the person who connected it (admin) ─

def grant(s, org, person):
    become(s, None)
    client = s.value("insert into public.oauth_clients (client_name, redirect_uris, ip_hash) "
                     "values ('Spend lab', array['https://claude.ai/api/mcp/auth_callback'], %s) returning client_id",
                     [uuid.uuid4().hex * 2])
    g = s.value("insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits, activated_at) "
                "values (%s, %s, %s, array['videos:read', 'videos:create'], 'https://nightshift-ai.studio/api/mcp', 100, now()) "
                "returning id", [person.uid, org, client])
    h = uuid.uuid4().hex + uuid.uuid4().hex
    s.rows("insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values (%s, %s, 'access', now() + interval '1 hour') "
           "returning 1", [h, g])
    return h, g


def oauth_counted(s, g):
    become(s, None)
    return s.value("select coalesce(sum(count), 0) from public.oauth_rate_counters where grant_id = %s", [g])


BALANCE = "select public.oauth_get_balance(%s, null)"
OAUTH_VIDEO = "select public.oauth_create_video(%s, %s, '{\"topic\": \"a lighthouse\", \"duration\": 60}'::jsonb, %s, null)"


def test_oauth_a_members_connection_is_answered_one_a_non_member_platform_admin_holds_is_refused_uncounted(w):
    s = w.su
    mine, _ = grant(s, w.org, w.member)
    assert api_call(s, BALANCE, [mine]).get("ok") is not False
    theirs, g = grant(s, w.org, w.staff)
    before, credits = oauth_counted(s, g), money(s, w.org)
    for q, p in ((BALANCE, [theirs]), (OAUTH_VIDEO, [theirs, w.channel, f"idem-{uuid.uuid4().hex}"])):
        out = api_call(s, q, p)
        assert out["ok"] is False and out["status"] == 403 and out["error"]["code"] == "not_a_member", out
    assert oauth_counted(s, g) == before and money(s, w.org) == credits


def test_oauth_a_connection_platform_staff_hold_in_the_exempt_organization_is_answered(w):
    s = w.su
    h, _ = grant(s, w.exempt, w.staff)
    assert api_call(s, BALANCE, [h]).get("ok") is not False


def test_oauth_a_connection_whose_person_is_no_admin_at_all_is_refused_as_before(w):
    s = w.su
    h, _ = grant(s, w.org, w.foreign)
    out = api_call(s, BALANCE, [h])
    assert out["ok"] is False and out["error"]["code"] == "workspace_access_lost", out


# ── the migration ────────────────────────────────────────────────────────────

def md5_of(c, sig):
    return c.execute("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0]


def _bodies() -> dict:
    """Each replaced function's body as the file writes it, by name (request_editor_export: the four-argument one, the only one here)."""
    text = MIGRATION.read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?\bas \$\$(.*?)\$\$;", text, re.S):
        out[m.group(1)] = m.group(2)
    return out


def test_the_file_replaces_exactly_the_sixteen_paths_and_each_body_asks_is_org_spender_with_its_role(conn):
    bodies = _bodies()
    assert sorted(bodies) == sorted(sig.split("(")[0].removeprefix("public.") for sig, *_ in spender.PATHS)
    for sig, role, _src, _was, now_ in spender.PATHS:
        name = sig.split("(")[0].removeprefix("public.")
        assert f"is_org_spender(" in bodies[name] and f"'{role}')" in bodies[name].split("is_org_spender(", 1)[1].split("\n", 1)[0], name
        assert "not_a_member" in bodies[name], name
        assert md5_of(conn, sig) == now_, sig


#: The first thing in a body that locks, holds, counts or writes: the spender question must come before it.
FIRST_EFFECT = re.compile(r"credit_account_lock|reserve_credits\(|creative_platform_reserve\(|pg_advisory_xact_lock|"
                          r"insert into|update public\.|for update|api_rate_counters|oauth_check_credit_take|oauth_rate_take|"
                          r"download_fail_locked|creative_expire_locked")


@pytest.mark.parametrize("sig", [p[0] for p in spender.PATHS])
def test_each_path_asks_before_its_first_lock_hold_count_or_write(sig):
    name = sig.split("(")[0].removeprefix("public.")
    body = "\n".join(ln for ln in _bodies()[name].splitlines() if not ln.strip().startswith("--"))
    asked = body.index("is_org_spender(")
    effect = FIRST_EFFECT.search(body)
    if name == "approve_storyboard":
        # storyboard_lock_for_runner takes the row lock (FOR UPDATE, nothing written) to ask who may call: asked right after it.
        assert body.index("storyboard_lock_for_runner") < asked < body.index("reserve_credits(")
        return
    if name == "request_editor_export":
        # 0054's row lock on the project (FOR UPDATE, nothing written) answers who may read it: asked after it, before any hold.
        assert asked < body.index("editor_export_money(") and asked < body.index("insert into")
        return
    assert effect is None or asked < effect.start(), (name, effect.group(0) if effect else None)


SNAPSHOT = """
select md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(array_to_string(p.proacl, ','), ''), ',' order by p.oid))
  from pg_proc p where p.pronamespace = 'public'::regnamespace
"""


def test_a_replay_changes_nothing(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        before = c.execute(SNAPSHOT).fetchone()[0]
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute(SNAPSHOT).fetchone()[0] == before
        c.rollback()


@pytest.mark.parametrize("sig", ["public.request_download(text, text, numeric)", "public.oauth_ctx(text, text, text)"])
def test_the_drift_guard_refuses_a_body_that_is_neither_the_earlier_files_nor_its_own(conn, sig):
    name = sig.split("(")[0]
    args = {"public.request_download": "p_video_id text, p_quality text, p_max_credits numeric default null",
            "public.oauth_ctx": "p_hash text, p_endpoint text, p_request_id text"}[name]
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute(f"create or replace function {name}({args}) returns jsonb language plpgsql "
                  "security definer set search_path = public, pg_temp as $$ begin return '{}'::jsonb; end $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert f"0226 found {sig} with a body that is neither" in str(e.value), str(e.value)
        c.rollback()


def _rollback_text():
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_the_rollback_puts_every_earlier_body_back_then_0226_applies_again(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        grants = {sig: c.execute("select proacl::text from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0]
                  for sig, *_ in spender.PATHS}
        c.execute(_rollback_text())
        for sig, _role, src, was, _now in spender.PATHS:
            assert md5_of(c, sig) == was, (sig, src)
            assert c.execute("select proacl::text from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0] == grants[sig], sig
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        for sig, _role, _src, _was, now_ in spender.PATHS:
            assert md5_of(c, sig) == now_, sig
            assert c.execute("select proacl::text from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0] == grants[sig], sig
        c.rollback()


def test_the_rollback_refuses_a_body_that_is_not_0226s(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute("create or replace function public.advance_workflow_run(p_run uuid) returns jsonb language plpgsql "
                  "security definer set search_path = public, pg_temp as $$ begin return '{}'::jsonb; end $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(_rollback_text())
        assert "rollback 0226: public.advance_workflow_run(uuid) is not 0226's body" in str(e.value), str(e.value)
        c.rollback()


def test_sec_dbs_take_off_and_put_back_chain_goes_through_0226(conn):
    """Other labs roll back or replay the files whose bodies 0226 replaced (0192 among them, through 0215's chain): each take-off
    must take 0226 off first (their rollbacks and guards refuse its bodies), and the matching put-back must put it back."""
    for off, back in ((sec_db.take_off_0226, sec_db.put_back_0226), (sec_db.take_off_0215, sec_db.put_back_0215),
                      (sec_db.take_off_0192, sec_db.put_back_0192)):
        with psycopg.connect(st._dsn(conn), autocommit=False) as c:
            off(c)
            assert not sec_db.has_0226(c), off.__name__
            back(c)
            assert sec_db.has_0226(c), back.__name__
            for sig, *_rest, now_ in spender.PATHS:
                assert md5_of(c, sig) == now_, (back.__name__, sig)
            c.rollback()
