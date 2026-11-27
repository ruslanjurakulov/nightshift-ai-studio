"""Breach, round 2 on migration 0215: only what commit 5fad38bb2 (the review fixes) changed. test_sec_breach_film_resume_0215.py is
round 1 and test_sec_film_resume_0215.py the builder's suite; nothing either already pins is repeated here.

Attacked: is_org_spender and the not_a_member refusal in start_film / start_film_resume / rerun_film_assembly; the whole-film cap
(captured so far + this segment <= org_film_settings.max_credits_per_film); film_settle_locked's two new rules (M1: a resume that made
nothing new goes back to paused; M3: an assembly recorded completed settles completed); M2 (deadline, worker_lost and assembly_failed
are retryable); the FOR SHARE lock on the carried files.

A test named test_breach_hole_* is a hole and stays FAILING until the product is fixed; every other test is an attack that held.

Holes (failing until fixed):
  * BR-0215-R2-01 (low). The whole-film cap is asked only on the resume path. A paused film whose resume makes nothing (all its made
    files were deleted, so nothing was carried) goes back to DRAFT with the first segment's capture still on it; start_film and
    quote_film then ask the cap of the new total alone, so one film costs the cap plus what it had captured.
  * BR-0215-R2-02 (low, latent). is_org_spender(org, NULL) answers NULL for any member, and every caller asks
    `if not is_org_spender(...)`: NOT NULL is NULL, the IF does not fire, and a viewer passes. Today's callers pass a literal
    'admin'; the function is documented as the standalone check later spend paths reuse (0226).
  * BR-0215-R2-03 (info). M1 copies the pause reason of the segment the cancelled resume continued; when that segment was itself a
    cancelled resume its settle_reason is 'cancelled', and a paused, resumable film reads pause_reason 'cancelled' (rule 5).
  * BR-0215-R2-04 (low, plausible). M2 makes a lost-word assembly failure retryable with no bound: each re-run holds the assembly line,
    re-renders up to max_attempts times, fails at 0 and releases. A film whose render reliably kills the worker (the runner's
    exit 143 is a known ceiling) is re-rendered for free without end, bounded only by starts_per_hour (10 per person).
"""

from __future__ import annotations

import json
import threading
import uuid
from decimal import Decimal

import psycopg
import pytest

from test_sec_films_money import SCENES, Db, a, b, claims, db, err, no_live_segment, one_hour, refused  # noqa: F401
from test_sec_film_resume_0215 import (LEFT, PAID_FIRST, assembly_failed, assembly_lost, finish, paused, rerun, resume,  # noqa: F401
                                       resumed, rquote, spender)

FILM_PRICE = PAID_FIRST + LEFT  # 49


# ── helpers ───────────────────────────────────────────────────────────────────

def open_holds(db, org):
    return [h for h in db.holds(org) if h[2] == "open"]


def captures_of(db, fid):
    return db.su("select coalesce(sum(r.captured), 0) from public.credit_reservations r "
                 "join public.film_segments g on g.credit_ref = r.job_id where g.film_id = %s", [fid])[0][0]


def committed(db, o, fid):
    """What one film has taken or holds: its captures plus every open hold of its segments."""
    held = db.su("select coalesce(sum(r.amount), 0) from public.credit_reservations r join public.film_segments g "
                 "on g.credit_ref = r.job_id where g.film_id = %s and r.status = 'open'", [fid])[0][0]
    return captures_of(db, fid) + held


def set_cap(db, org, cap):
    db.su("insert into public.org_film_settings (org_id, max_credits_per_film) values (%s, %s) "
          "on conflict (org_id) do update set max_credits_per_film = excluded.max_credits_per_film", [org, cap])


def platform_user(db, role):
    u = str(uuid.uuid4())
    email = f"r2-platform-{role}-{u[:8]}@money.lab"
    db.su("insert into auth.users (id, email) values (%s, %s)", [u, email])
    db.su("insert into public.app_members (user_id, email, role) values (%s, %s, %s)", [u, email, role])
    return u


def as_claims(db, raw_claims, q, p=None, role="authenticated"):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        try:
            c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(raw_claims)])
            c.execute(f"set local role {role}")
            out = c.execute(q, p).fetchone()[0]
            c.commit()
            return out
        except psycopg.Error:
            c.rollback()
            raise


def call(fn):
    try:
        return ("ok", fn())
    except psycopg.Error as e:
        return (e.sqlstate, str(e).splitlines()[0])


def segments_of(db, fid):
    return db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0]


# ── 1. is_org_spender and not_a_member ───────────────────────────────────────

@pytest.mark.parametrize("seat", ["editor", "viewer"])
def test_a_platform_admin_seated_below_admin_is_refused_not_a_member_on_every_spend_door(db, seat):
    """0043 makes the platform admin an admin of every organization; a seat of editor or viewer in org_members must not turn that
    into a spender. Every spend door refuses not_a_member before anything is counted; the quotes say it."""
    o = db.new_org()
    staff = platform_user(db, "admin")
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s)",
          [o.org, staff, f"seated-{staff[:8]}@money.lab", seat])
    assert spender(db, staff, o.org, "admin") is False
    fid, _ = assembly_failed(db, o)
    q = rquote(db, staff, fid)
    assert {"reason": "not_a_member"} in q["blocked_by"] and q["startable"] is False and q["may_start"] is False
    for fn in (resume, rerun):
        assert err(lambda: fn(db, staff, fid, q["quote_id"]))[:2] == ("NS400", "not_a_member")
    draft = db.film(o)
    sq = db.quote(staff, draft)
    assert {"reason": "not_a_member"} in sq["blocked_by"] and sq["may_start"] is False
    assert err(lambda: db.start(staff, draft, sq["quote_id"]))[:2] == ("NS400", "not_a_member")
    assert db.rate_used(staff, "start") == 0 and open_holds(db, o.org) == [] and segments_of(db, fid) == 1


def test_a_pending_admin_invite_with_the_users_confirmed_email_is_no_seat(db):
    """An org_members row with user_id NULL is an offer (0043), even when its email is the caller's own confirmed one."""
    o = db.new_org()
    fid, _ = paused(db, o)
    qid = rquote(db, o.admin, fid)["quote_id"]
    u = str(uuid.uuid4())
    email = f"invitee-{u[:8]}@money.lab"
    db.su("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [u, email])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, null, %s, 'admin')", [o.org, email])
    assert spender(db, u, o.org, "admin") is False and spender(db, u, o.org, "viewer") is False
    for fn in (resume, rerun):
        assert err(lambda: fn(db, u, fid, qid))[:2] == ("P0002", "not_found")
    assert err(lambda: rquote(db, u, fid))[:2] == ("P0002", "not_found")
    assert open_holds(db, o.org) == [] and segments_of(db, fid) == 1


@pytest.mark.parametrize("change", ["removed", "demoted"])
def test_an_admin_removed_or_demoted_between_the_quote_and_the_start_spends_nothing(db, change):
    o = db.new_org()
    fid, _ = paused(db, o)
    q = rquote(db, o.admin, fid)
    assert q["startable"] is True
    if change == "removed":
        db.su("delete from public.org_members where org_id = %s and user_id = %s", [o.org, o.admin])
        want = ("P0002", "not_found")
    else:
        db.su("update public.org_members set role = 'editor' where org_id = %s and user_id = %s", [o.org, o.admin])
        want = ("42501", "forbidden")
    for fn in (resume, rerun):
        assert err(lambda: fn(db, o.admin, fid, q["quote_id"]))[:2] == want
    assert open_holds(db, o.org) == [] and segments_of(db, fid) == 1 and db.film_row(fid)[0] == "paused"


FORGED = [
    {"role": "authenticated", "app_metadata": {"role": "owner", "platform_role": "owner"}},
    {"role": "authenticated", "user_metadata": {"role": "admin", "org_role": "owner"}, "platform_role": "admin"},
    {"role": "service_role"},
    {"role": "authenticated", "is_platform_admin": True, "org_id": None},
]


@pytest.mark.parametrize("extra", FORGED)
def test_forged_claims_make_no_one_a_spender(db, extra):
    """Every role the database grants comes from org_members / app_members by auth.uid(), never from a claim: an outsider stays a
    missing film, an editor stays forbidden, whatever the token says about roles."""
    o, x = db.new_org(), db.new_org()
    fid, _ = paused(db, o)
    qid = rquote(db, o.admin, fid)["quote_id"]
    for who, want in ((x.admin, ("P0002", "not_found")), (o.editor, ("42501", "forbidden"))):
        c = {**extra, "role": extra.get("role", "authenticated"), "sub": who}
        if "org_id" in c:
            c["org_id"] = o.org
        for q in ("select public.start_film_resume(%s::uuid, %s, 'forged-r2-key-1')",
                  "select public.rerun_film_assembly(%s::uuid, %s, 'forged-r2-key-2')"):
            assert err(lambda: as_claims(db, c, q, [fid, qid]))[:2] == want, (c, q)
        out = as_claims(db, c, "select public.is_org_spender(%s::uuid, 'admin')", [o.org], role="postgres")
        assert out is False, c
    assert open_holds(db, o.org) == [] and segments_of(db, fid) == 1


def test_a_role_string_that_is_not_one_of_the_four_is_never_a_seat(db, a):
    for bad in ("OWNER", "owner ", " admin", "Admin", "superadmin"):
        with pytest.raises(psycopg.errors.CheckViolation):
            db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, null, %s, %s)",
                  [a.org, f"bad-{uuid.uuid4().hex[:6]}@money.lab", bad])
        assert spender(db, a.owner, a.org, bad) is False, bad


def test_breach_hole_is_org_spender_with_a_null_role_answers_null_which_an_if_not_lets_through(db, a):
    """HOLE BR-0215-R2-02 (low, latent). `p_min_role in (...)` is NULL for a NULL role and app_role_rank(NULL) is 0, so for a member
    the whole AND is NULL, not false. Every caller writes `if not public.is_org_spender(org, role) then refuse`: NOT NULL is NULL, the
    refusal never fires, and a viewer is a spender. Harmless while each caller passes the literal 'admin'; the function is the
    standalone check later spend paths are meant to reuse, so the first one that passes a role from a parameter or a column fails
    open. The fix is a coalesce(..., false) (or `is not true` at the callers)."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", a.viewer)])
        c.execute("select set_config('lab.org', %s, true)", [a.org])
        try:
            c.execute("do $$ begin if not public.is_org_spender(current_setting('lab.org')::uuid, null) then "
                      "raise exception 'refused' using errcode = 'P0001'; end if; end $$")
            fired = False
        except psycopg.Error:
            fired = True
        c.rollback()
    assert fired, "a caller's `if not is_org_spender(org, NULL) then refuse` let a viewer through"
    assert spender(db, a.viewer, a.org, None) is False, "is_org_spender(org, NULL) answers NULL, not false, for a viewer"


def test_not_a_member_is_said_only_to_someone_who_already_reads_the_film(db, a, b):
    """not_a_member comes after 'not_found' (no viewer seat) and 'forbidden' (no admin): an outsider gets the same answer for a real
    film and for none, and the quote's blocked_by is never reachable to them."""
    fid, _ = assembly_failed(db, a)
    qid = rquote(db, a.admin, fid)["quote_id"]
    missing = str(uuid.uuid4())
    for fn in (resume, rerun):
        assert err(lambda: fn(db, b.admin, fid, qid)) == err(lambda: fn(db, b.admin, missing, qid))
    v = db.version(fid)
    assert err(lambda: rquote(db, b.admin, fid, v)) == err(lambda: rquote(db, b.admin, missing, v))
    assert err(lambda: db.quote(b.admin, fid, v)) == err(lambda: db.quote(b.admin, missing, v))
    # Platform staff read every organization already: the word tells them nothing they cannot read.
    staff = platform_user(db, "admin")
    assert err(lambda: resume(db, staff, missing, qid))[:2] == ("P0002", "not_found")
    assert err(lambda: resume(db, staff, fid, qid))[:2] == ("NS400", "not_a_member")


# ── 2. the whole-film cap ─────────────────────────────────────────────────────

def test_breach_hole_a_film_back_at_draft_after_a_paid_segment_is_started_again_above_the_whole_film_cap(db):
    """HOLE BR-0215-R2-01 (low). The cap is the whole film's on the resume path only. Cap 73. The film pauses at 24 captured; the
    admin deletes its made files (soft_delete_asset, any member may), so the resume carries nothing and is priced 49: 24 + 49 = 73,
    under the cap. The resume makes nothing (here: nobody claims it in 3 hours; any run that makes nothing does the same) and the
    film is a DRAFT again, its 24 still captured. In the draft the editor adds a scene (69 now) and start_film asks the cap of 69
    alone: the film holds 69 more, 93 in all, above its 73."""
    o = db.new_org(credits=300)
    set_cap(db, o.org, 73)
    fid, seg = paused(db, o)
    for (asset,) in db.su("select result_asset_id from public.film_takes where segment_id = %s and result_asset_id is not null",
                          [seg["id"]]):
        assert db.one("authenticated", o.admin, "select public.soft_delete_asset(%s::uuid)", [asset]) is True
    q = rquote(db, o.admin, fid)
    assert q["carried"] == [] and Decimal(str(q["total"])) == FILM_PRICE and q["startable"] is True, q["blocked_by"]
    out = resume(db, o.admin, fid, q["quote_id"])
    assert out["ok"] is True
    db.su("update public.film_segments set created_at = now() - interval '4 hours' where id = %s", [out["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.film_row(fid)[0] == "draft" and captures_of(db, fid) == PAID_FIRST
    third = {"title": "Middle", "narration": "It goes on.", "planned_seconds": 10, "first_frame": "previous"}
    kept = [{"id": str(i)} for (i,) in db.su("select id from public.film_scenes where film_id = %s order by position", [fid])]
    db.save(o.editor, fid, db.version(fid), {"scenes": [*kept, third]})
    sq = db.quote(o.editor, fid)
    total = Decimal(str(sq["total"]))
    assert PAID_FIRST + total > 73 >= total, sq["total"]
    started = db.start(o.admin, fid, sq["quote_id"])
    assert started.get("ok") is not True and committed(db, o, fid) <= 73, \
        f"the film's cap is 73; it captured {captures_of(db, fid)} and now holds {committed(db, o, fid)} in all: {started}"


def test_a_cap_lowered_between_the_quote_and_the_start_refuses_the_resume_and_holds_nothing(db):
    o = db.new_org()
    set_cap(db, o.org, 100)
    fid, _ = paused(db, o)
    q = rquote(db, o.admin, fid)
    assert q["startable"] is True
    set_cap(db, o.org, PAID_FIRST + LEFT - 1)
    assert refused(resume(db, o.admin, fid, q["quote_id"])) == ("cap_exceeded", "NS400")
    q2 = rquote(db, o.admin, fid)
    assert any(r["reason"] == "cap_exceeded" and Decimal(str(r["captured"])) == PAID_FIRST for r in q2["blocked_by"])
    assert open_holds(db, o.org) == [] and segments_of(db, fid) == 1


def test_resumes_and_a_rerun_raced_at_a_tight_cap_commit_at_most_the_cap(db):
    """Cap 49 = 44 captured (every take) + 5 (the assembly). Each racer alone fits; together they would not. One start lock per
    organization and the paused-only refusal make one winner; the film never holds more than its cap."""
    for _ in range(3):
        o = db.new_org(credits=200)
        set_cap(db, o.org, 49)
        fid, _ = assembly_failed(db, o)
        q = rquote(db, o.admin, fid)
        assert q["startable"] is True
        gate, seen, lock = threading.Barrier(4), [], threading.Lock()

        def go(fn):
            gate.wait()
            r = call(lambda: fn(db, o.admin, fid, q["quote_id"]))
            with lock:
                seen.append(r)

        ts = [threading.Thread(target=go, args=(f,)) for f in (resume, resume, rerun, rerun)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(60)
        assert len([r for r in seen if r[0] == "ok" and r[1].get("ok")]) == 1, seen
        assert committed(db, o, fid) <= 49 and len(open_holds(db, o.org)) == 1, seen
        for (sid,) in db.su("select id from public.film_segments where status in ('queued', 'running', 'draining')"):
            db.cancel(sid)


def test_a_refund_recorded_later_never_lowers_what_the_cap_counts(db):
    """0167's recovery collects from a RELEASED hold, never a captured one, and writes no film row: the captured_credits the cap sums
    stay what the film took. A purchase refunded in full after the first segment is still 24 against the cap."""
    o = db.new_org(credits=0)
    ext = "paddle-r2-" + uuid.uuid4().hex[:8]
    db.su("select public.add_purchased_credits(%s, 100, %s, 'lab')", [o.org, ext])
    fid, _ = paused(db, o)
    set_cap(db, o.org, PAID_FIRST + LEFT - 1)
    out = db.su("select public.refund_purchased_credits(%s, %s, 100, 'lab', 'refund')", [ext, "rf-" + uuid.uuid4().hex[:8]])[0][0]
    assert out["duplicate"] is False and Decimal(str(out["requested"])) == 100, out
    assert db.su("select coalesce(sum(captured_credits), 0) from public.film_segments where film_id = %s", [fid])[0][0] == PAID_FIRST
    q = rquote(db, o.admin, fid)
    assert any(r["reason"] == "cap_exceeded" and Decimal(str(r["captured"])) == PAID_FIRST for r in q["blocked_by"])


# ── 3. film_settle_locked's new rules ────────────────────────────────────────

def test_breach_hole_a_chain_of_cancelled_resumes_leaves_a_paused_film_reading_cancelled(db, a):
    """HOLE BR-0215-R2-03 (info). M1 takes the pause reason from the settle_reason of the segment the cancelled resume continued. The
    first cancel reads the paused segment's takes_failed, correctly. The second cancel continues the FIRST cancelled resume, whose
    settle_reason is 'cancelled': the film is paused, resumable, and says pause_reason 'cancelled' (rule 5: the reason a person reads
    must be why it stopped, and a paused film was never cancelled). Walking back to the first non-cancel settle reason fixes it."""
    fid, _ = paused(db, a)
    s2 = resumed(db, a, fid)
    assert Decimal(db.cancel(s2["id"])["captured_credits"]) == 0
    assert db.film_row(fid) == ("paused", "takes_failed")
    s3 = resumed(db, a, fid)
    assert Decimal(db.cancel(s3["id"])["captured_credits"]) == 0
    assert db.film_row(fid)[0] == "paused" and rquote(db, a.admin, fid)["startable"] is True
    assert db.film_row(fid) == ("paused", "takes_failed"), f"a paused film after two cancelled resumes reads {db.film_row(fid)}"


def test_a_resume_that_made_nothing_releases_its_hold_and_frees_its_run_slot_every_time(db):
    """M1 abuse: a resume cancelled (or never claimed) with 0 captured goes back to paused, again and again. Each round's hold is
    released, so nothing stays reserved, the run slot is free, the start lock is only transaction-long, and each round is a counted
    start (starts_per_hour) by the person who pays."""
    o = db.new_org()
    fid, _ = paused(db, o)
    used = db.rate_used(o.admin, "start")
    for _ in range(4):
        s = resumed(db, o, fid)
        db.cancel(s["id"])
        assert open_holds(db, o.org) == [] and db.account(o.org)[1] == 0
        assert db.film_row(fid)[0] == "paused"
    assert db.rate_used(o.admin, "start") == used + 4
    assert db.ledger(o.org, "capture") == [-PAID_FIRST]
    q = rquote(db, o.admin, fid)
    assert not any(r["reason"] in ("run_slots_full", "limit_reached") for r in q["blocked_by"]), q["blocked_by"]


def test_an_assembly_is_never_recorded_completed_while_a_take_is_not_and_a_cancel_after_it_captures_once(db, a):
    """M3 reads 'assembly completed' as 'every take completed'. The worker cannot record a completed assembly that never began, nor
    begin one with a take still planned; a cancel that lands after a completed assembly makes the film ready and captures what was
    charged, once, never above what was confirmed."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    assert db.claim()["id"] == seg["id"]
    video = db.asset(a.org, "video", "video/mp4", duration=18)
    assert err(lambda: db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)", [seg["id"], video]))[:2] == \
        ("NS409", "not_running")
    assert err(lambda: db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]]))[:2] == ("NS409", "not_complete")
    db.finish_all(a, seg["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)",
           [seg["id"], db.asset(a.org, "video", "video/mp4", duration=18)])
    out = db.cancel(seg["id"])
    assert out["settled"] is True and Decimal(out["captured_credits"]) == FILM_PRICE
    assert db.film_row(fid) == ("ready", None)
    assert db.cancel(seg["id"])["status"] in ("settled",)  # again: answered as it is
    assert db.ledger(a.org, "capture") == [-FILM_PRICE]


def test_breach_hole_a_failed_assembly_whose_word_is_lost_is_re_rendered_for_free_without_end(db):
    """HOLE BR-0215-R2-04 (low, plausible). M2 makes worker_lost (and deadline, assembly_failed) retryable and keeps no count. A film
    whose render kills the worker every time (exit 143 is the runner's known ceiling) is lost after max_attempts claims, settles
    worker_lost at 0, and is re-run again: here five re-runs, fifteen renders, nothing captured beyond the takes. Nothing bounds it
    but starts_per_hour. A per-film bound on consecutive lost-word re-runs (then: ask support) closes it."""
    o = db.new_org(credits=200)
    fid, _ = assembly_lost(db, o, "worker_lost")
    renders = 1
    reruns = 0
    for _ in range(5):
        q = rquote(db, o.admin, fid)
        if not q["startable"]:
            break
        out = rerun(db, o.admin, fid, q["quote_id"])
        if out.get("ok") is not True:
            break
        reruns += 1
        for _attempt in range(3):
            c = db.claim("w-r2")
            if c is None:
                break
            renders += 1
            db.svc("select public.film_begin_assembly(%s, 'w-r2')", [out["id"]])
            db.su("update public.film_segments set heartbeat_at = now() - interval '1 hour' where id = %s", [out["id"]])
        assert db.claim("w-r2") is None
        assert db.film_row(fid) == ("paused", "worker_lost"), db.film_row(fid)
        assert open_holds(db, o.org) == []
    assert db.ledger(o.org, "capture") == [Decimal(-44)]
    assert reruns <= 3, f"{reruns} free re-runs ({renders} renders) of an assembly that never finished, and it is still startable"


# ── 4. the FOR SHARE lock on the carried files ───────────────────────────────

def test_the_carried_files_lock_never_deadlocks_against_a_delete_the_orphan_discard_or_the_sweep(db):
    """start_film_resume locks: the start lock, the film (FOR NO KEY UPDATE), then the carried files (FOR SHARE, by id). 0200's
    discard and the sweep take the film first too (the sweep with SKIP LOCKED); soft_delete_asset takes only the file. No cycle: each
    either waits for the resume's commit or runs before it, never 40P01, and the outcome is one of the two orders."""
    for _ in range(3):
        o = db.new_org()
        fid, seg = paused(db, o)
        q = rquote(db, o.admin, fid)
        kf = db.su("select result_asset_id from public.film_takes where segment_id = %s and kind = 'keyframe'", [seg["id"]])[0][0]
        orphan = db.asset(o.org, "video", "video/mp4", duration=18, provenance={"film_segment_id": str(seg["id"])})
        gate, seen, lock = threading.Barrier(4), {}, threading.Lock()
        calls = {
            "resume": lambda: resume(db, o.admin, fid, q["quote_id"])["ok"],
            "delete": lambda: db.one("authenticated", o.viewer, "select public.soft_delete_asset(%s::uuid)", [kf]),
            "discard": lambda: db.svc("select public.film_discard_unrecorded_assembly(%s, %s::uuid)", [seg["id"], orphan]),
            "sweep": lambda: db.svc("select public.film_expire_segments()"),
        }

        def go(name):
            gate.wait()
            r = call(calls[name])
            with lock:
                seen[name] = r

        ts = [threading.Thread(target=go, args=(n,)) for n in calls]
        for t in ts:
            t.start()
        for t in ts:
            t.join(60)
        assert all(r[0] != "40P01" for r in seen.values()), seen
        assert seen["delete"] == ("ok", True), seen
        if seen["resume"][0] == "ok":
            # The resume won the file: its carried copy names it (deleted after the commit, which the next run's precheck sees).
            assert db.su("select count(*) from public.film_takes where carried_from_take_id is not null and result_asset_id = %s",
                         [kf])[0][0] == 1
        else:
            assert seen["resume"][0] == "NS409" and "film_changed" in seen["resume"][1], seen
            assert open_holds(db, o.org) == []
