"""Breach on migration 0215 (archive a paused or cancelled film; resume one; re-run a failed assembly), attacked for money and reach
in the lab's scratch database. test_sec_film_resume_0215.py is the builder's suite; this file holds only what it does not already
pin. A test named test_breach_hole_* is a hole Breach found and is left FAILING until the product is fixed; every other test here is
an attack that held, pinned so it keeps holding.

Holes (failing until fixed):
  * the per-film credit cap (org_film_settings.max_credits_per_film, "no film whose total is above it may start") is asked of each
    segment's total alone: a paused film that is resumed costs the first segment's capture PLUS the resume total, so one film can
    cost well above its cap (a rate that rose, or a made take whose file was deleted and is made and paid again);
  * a resume that is cancelled before it made anything new leaves the film `cancelled` (its carried takes count as made, so
    film_settle_locked takes the charged-cancel branch): a terminal state, never resumable, the paid takes stranded. 0215's own
    header says a resume that made nothing leaves the film paused again;
  * the worker reference (left(md5(worker id), 12), unsalted) is a dictionary oracle: a member who guesses the host name recovers
    the full worker id (host name and pid) from film_json in well under a second.

Runs in the money lab's own scratch database (test_sec_films_money's fixtures, imported as they are).
"""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from decimal import Decimal

import psycopg
import pytest

from test_sec_films_money import Db, Org, a, b, claims, db, err, no_live_segment, one_hour, refused  # noqa: F401
from test_sec_film_resume_0215 import (LEFT, PAID_FIRST, assembly_failed, finish, lines_of, paused, rerun, resume, resumed,  # noqa: F401
                                       rquote)

FILM_PRICE = PAID_FIRST + LEFT   # 49: what the money lab's film costs, once
from test_sec_films_money import SCENES as SCENES_EXEMPT, SETTINGS as SETTINGS_EXEMPT  # noqa: E402


# ── helpers ───────────────────────────────────────────────────────────────────

def archive(db, who, fid):
    return db.one("authenticated", who, "select public.archive_film(%s::uuid)", [fid])


def fail_twice(db, tid, worker="w-1"):
    db.begin(tid, worker)
    retry = db.fail(tid, "provider_error", worker)["retry_take_id"]
    db.begin(retry, worker)
    db.fail(retry, "provider_error", worker)


def captures_of(db, fid):
    """Every credit a film's segments captured, from the ledger's own holds (not from the segment rows)."""
    return db.su("select coalesce(sum(r.captured), 0) from public.credit_reservations r "
                 "join public.film_segments g on g.credit_ref = r.job_id where g.film_id = %s", [fid])[0][0]


def open_holds(db, org):
    return [h for h in db.holds(org) if h[2] == "open"]


def call(fn):
    """('ok', answer) or (sqlstate, first line of the error)."""
    try:
        return ("ok", fn())
    except psycopg.Error as e:
        return (e.sqlstate, str(e).splitlines()[0])


def platform_user(db, role):
    u = str(uuid.uuid4())
    email = f"platform-{role}-{u[:8]}@money.lab"
    db.su("insert into auth.users (id, email) values (%s, %s)", [u, email])
    db.su("insert into public.app_members (user_id, email, role) values (%s, %s, %s)", [u, email, role])
    return u


# ── money: get paid work for free, or be charged twice ───────────────────────

def test_a_film_paused_twice_and_resumed_twice_is_charged_its_price_once(db, a):
    """The resume of a resume carries the carried copies again (at 0) and never re-prices a take any segment completed."""
    fid, seg1 = paused(db, a)
    s2 = resumed(db, a, fid)
    assert db.claim()["id"] == s2["id"]
    planned = [t for t in db.takes(s2["id"]) if t[4] == "planned"]
    assert [(t[1], t[5]) for t in planned] == [("clip", Decimal(20))]
    fail_twice(db, planned[0][0])
    out = db.settle(s2["id"], "takes_failed")
    assert out["settled"] is True and Decimal(out["captured_credits"]) == 0
    assert db.film_row(fid) == ("paused", "takes_failed")
    q = rquote(db, a.admin, fid)
    assert q["resumed_from"] == s2["id"] and Decimal(str(q["total"])) == LEFT
    assert {c["take_id"] for c in q["carried"]} <= {str(t[0]) for t in db.takes(s2["id"])}
    s3 = resume(db, a.admin, fid, q["quote_id"])
    assert s3["ok"] is True and s3["carried"] == 3
    settled = finish(db, a, s3["id"])
    assert Decimal(settled["captured_credits"]) == LEFT
    assert db.ledger(a.org, "capture") == [-PAID_FIRST, -LEFT]
    assert captures_of(db, fid) == FILM_PRICE
    holds = {h[0]: h for h in db.holds(a.org)}
    assert holds[s2["credit_ref"]][2] == "released" and holds[s3["credit_ref"]][2] == "captured"
    charged = db.su("select (select coalesce(sum(charged_credits), 0) from public.film_takes where film_id = %s) "
                    "+ (select coalesce(sum(assembly_charged_credits), 0) from public.film_segments where film_id = %s)", [fid, fid])
    assert charged[0][0] == FILM_PRICE


def test_a_carried_take_swapped_to_another_organizations_file_is_never_carried_or_started(db, a, b):
    """The worker is the only writer of a take's result; if one were swapped to another organization's file, before the quote the
    line is priced again (never carried free), after it the start is refused film_changed and nothing is held."""
    fid, seg = paused(db, a)
    kf = db.su("select id, result_asset_id from public.film_takes where segment_id = %s and kind = 'keyframe'", [seg["id"]])[0]
    foreign = db.asset(b.org)
    db.su("update public.film_takes set result_asset_id = %s where id = %s", [foreign, kf[0]])
    try:
        q = rquote(db, a.admin, fid)
        assert ("keyframe", 0) in lines_of(q) and all(c["line"] != "keyframe" for c in q["carried"])
        assert Decimal(str(q["total"])) == LEFT + 3
    finally:
        db.su("update public.film_takes set result_asset_id = %s where id = %s", [kf[1], kf[0]])
    q = rquote(db, a.admin, fid)
    db.su("update public.film_takes set result_asset_id = %s where id = %s", [foreign, kf[0]])
    try:
        assert err(lambda: resume(db, a.admin, fid, q["quote_id"]))[:2] == ("NS409", "film_changed")
    finally:
        db.su("update public.film_takes set result_asset_id = %s where id = %s", [kf[1], kf[0]])
    assert open_holds(db, a.org) == [] and db.film_row(fid)[0] == "paused"


def test_a_quote_of_another_film_or_another_organization_never_resumes_this_film(db, a, b):
    f1, _ = paused(db, a)
    f2, _ = paused(db, a)
    fb, _ = paused(db, b)
    q1 = rquote(db, a.admin, f1)["quote_id"]
    qb = rquote(db, b.admin, fb)["quote_id"]
    # Another film's quote, same organization: answered as a quote that is not this film's (counted), nothing held.
    assert refused(resume(db, a.admin, f2, q1)) == ("price_changed", "NS409")
    assert refused(resume(db, a.admin, f2, qb)) == ("price_changed", "NS409")
    # Another organization's admin with this film's own quote: the film reads as a missing one.
    assert err(lambda: resume(db, b.admin, f1, q1))[:2] == ("P0002", "not_found")
    assert err(lambda: rerun(db, b.admin, f1, q1))[:2] == ("P0002", "not_found")
    assert open_holds(db, a.org) == [] and open_holds(db, b.org) == []
    assert [db.film_row(f)[0] for f in (f1, f2)] == ["paused", "paused"]


def test_a_resume_quote_never_starts_a_film_through_start_film(db, a):
    """A paused film whose made files were all deleted resumes with nothing carried; when that resume makes nothing the film is a
    draft again. The resume quote is still stored at the same version, and start_film's lookup does not ask its purpose: its
    re-pricing must refuse it, or the film would start at the resume total."""
    fid, seg = paused(db, a)
    for (asset,) in db.su("select result_asset_id from public.film_takes where segment_id = %s and result_asset_id is not null",
                          [seg["id"]]):
        db.su("update public.media_assets set deleted_at = now() where id = %s", [asset])
    q = rquote(db, a.admin, fid)
    assert q["carried"] == [] and Decimal(str(q["total"])) == FILM_PRICE
    out = resume(db, a.admin, fid, q["quote_id"])
    assert out["ok"] is True and out["carried"] == 0
    db.su("update public.film_segments set created_at = now() - interval '4 hours' where id = %s", [out["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.film_row(fid)[0] == "draft"
    stored = db.su("select purpose from public.film_quotes where film_id = %s and quote_id = %s", [fid, q["quote_id"]])
    assert stored == [("resume",)]
    assert refused(db.start(a.admin, fid, q["quote_id"])) == ("price_changed", "NS409")
    assert open_holds(db, a.org) == []


def test_a_film_whose_segment_is_still_settling_is_neither_quoted_nor_resumed(db, a):
    """A cancel while a take is at the vendor leaves the segment draining: no resume until it settles, even when the film row is
    made to say paused; once it settles the resume holds only what is left."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0]
    assert kf[1] == "keyframe"
    db.begin(kf[0])
    assert db.cancel(seg["id"], "deadline")["settled"] is False
    assert db.segment(seg["id"])[0] == "draining" and db.film_row(fid)[0] == "draining"
    assert err(lambda: rquote(db, a.admin, fid))[:2] == ("NS409", "film_not_resumable")
    db.su("update public.films set status = 'paused' where id = %s", [fid])
    try:
        code, word, detail = err(lambda: rquote(db, a.admin, fid))
        assert (code, word) == ("NS409", "film_not_resumable") and "running already" in detail
        code, word, detail = err(lambda: resume(db, a.admin, fid, f"fq-{db.version(fid)}-" + "0" * 32))
        assert (code, word) == ("NS409", "film_not_resumable") and "running already" in detail
        assert err(lambda: rerun(db, a.admin, fid, f"fq-{db.version(fid)}-" + "0" * 32))[:2] == ("NS409", "not_assembly_failure")
    finally:
        db.su("update public.films set status = 'draining' where id = %s", [fid])
    assert len([h for h in db.holds(a.org) if h[2] == "open"]) == 1
    db.succeed(kf[0], None, db.output(a.org, kf[0], "image", "image/png"))
    assert db.settle(seg["id"], "deadline")["settled"] is True
    assert db.film_row(fid) == ("paused", "deadline")
    out = resumed(db, a, fid)
    assert Decimal(out["confirmed_credits"]) == FILM_PRICE - 3 and out["carried"] == 1
    assert db.ledger(a.org, "capture") == [Decimal(-3)]


def test_a_resume_waiting_on_the_sweep_that_settles_the_newest_segment_is_refused_and_holds_nothing(db, a):
    """The sweep releases an unclaimed resume while a second resume, with the quote of the FIRST pause, waits on the film's lock:
    when it gets the lock the newest segment is another one, and the old quote is refused (price_changed), never a second segment
    resumed from the first one."""
    fid, seg1 = paused(db, a)
    q1 = rquote(db, a.admin, fid)
    s2 = resume(db, a.admin, fid, q1["quote_id"])
    db.su("update public.film_segments set created_at = now() - interval '4 hours' where id = %s", [s2["id"]])
    result = {}
    with psycopg.connect(db.dsn, autocommit=False) as sweep:
        sweep.execute("select set_config('request.jwt.claims', %s, true)", [claims("service_role")])
        sweep.execute("set local role service_role")
        assert sweep.execute("select public.film_expire_segments()").fetchone()[0] == 1  # the film row is locked until commit
        # A quote now reads the committed film: queued, so nothing to quote.
        assert err(lambda: rquote(db, a.admin, fid))[:2] == ("NS409", "film_not_resumable")
        t = threading.Thread(target=lambda: result.setdefault("r", call(lambda: resume(db, a.admin, fid, q1["quote_id"]))))
        t.start()
        t.join(1.5)
        assert t.is_alive(), "the resume did not wait for the sweep's lock on the film"
        sweep.commit()
    t.join(30)
    state, out = result["r"]
    assert state == "ok" and refused(out) == ("price_changed", "NS409"), result
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 2
    assert open_holds(db, a.org) == [] and db.film_row(fid)[0] == "paused"
    s3 = resumed(db, a, fid)
    assert s3["resumed_from"] == s2["id"] and len(open_holds(db, a.org)) == 1


# ── races: resume x re-run x archive x start_film x claim, at once ───────────

@pytest.mark.parametrize("round_", range(4))
def test_resume_rerun_archive_start_and_claim_at_once_make_at_most_one_hold_and_capture_no_more_than_it(db, round_):
    o = db.new_org()
    fid, seg = assembly_failed(db, o)
    q = rquote(db, o.admin, fid)
    initial = f"fq-{db.version(fid)}-" + "0" * 32
    gate, seen, lock = threading.Barrier(5), {}, threading.Lock()
    calls = {
        "resume": lambda: resume(db, o.admin, fid, q["quote_id"]),
        "rerun": lambda: rerun(db, o.admin, fid, q["quote_id"]),
        "archive": lambda: archive(db, o.editor, fid)["film"]["status"],
        "start_film": lambda: db.start(o.admin, fid, initial),
        "claim": lambda: (db.claim("w-race") or {}).get("id"),
    }

    def go(name):
        gate.wait()
        r = call(calls[name])
        with lock:
            seen[name] = r

    threads = [threading.Thread(target=go, args=(n,)) for n in calls]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert seen["start_film"][:2] == ("NS409", "film_not_startable") or seen["start_film"][0] == "NS409", seen
    resumes = db.su("select id, credit_ref, status from public.film_segments where film_id = %s and purpose = 'resume'", [fid])
    assert len(resumes) <= 1, seen
    status = db.film_row(fid)[0]
    if status == "archived":
        assert resumes == [] and open_holds(db, o.org) == [], seen
        assert db.ledger(o.org, "capture") == [Decimal(-44)]
        return
    assert len(resumes) == 1, seen
    sid, ref, st = str(resumes[0][0]), resumes[0][1], resumes[0][2]
    assert [h[0] for h in open_holds(db, o.org)] == [ref], seen
    assert seen["archive"][0] == "NS409", seen
    if st == "queued":
        assert db.claim("w-race")["id"] == sid
    db.finish_all(o, sid, "w-race")
    db.svc("select public.film_begin_assembly(%s, 'w-race')", [sid])
    db.svc("select public.film_record_assembly(%s, 'w-race', true, %s::uuid)", [sid, db.asset(o.org, "video", "video/mp4", duration=18)])
    out = db.settle(sid, "completed", "w-race")
    hold = [h for h in db.holds(o.org) if h[0] == ref]
    assert len(hold) == 1 and hold[0][2] == "captured" and Decimal(hold[0][3]) <= Decimal(hold[0][1])
    assert Decimal(out["captured_credits"]) == 5 and db.ledger(o.org, "capture") == [Decimal(-44), Decimal(-5)]
    assert captures_of(db, fid) == FILM_PRICE


# ── idempotency ───────────────────────────────────────────────────────────────

def test_one_key_across_resume_and_rerun_replays_and_a_refused_key_is_free_again(db, a, b):
    fb, _ = paused(db, b)  # first: the claim takes the oldest queued segment, and a's resume below is left queued
    fid, _seg = assembly_failed(db, a)
    q = rquote(db, a.admin, fid)
    key = db.key()
    # A refusal that raises before anything is written (a quote of another shape) leaves the key unused ...
    assert err(lambda: resume(db, a.admin, fid, "fq-9-" + "0" * 32, key))[:2] == ("NS409", "film_changed")
    # ... and so does one returned after the count (a quote that is not stored).
    assert refused(resume(db, a.admin, fid, f"fq-{db.version(fid)}-" + "0" * 32, key)) == ("price_changed", "NS409")
    first = rerun(db, a.admin, fid, q["quote_id"], key)
    assert first["ok"] is True and first["replayed"] is False
    again = resume(db, a.admin, fid, q["quote_id"], key)
    assert again["replayed"] is True and again["id"] == first["id"]
    assert len(open_holds(db, a.org)) == 1
    # The same key in another organization is that organization's own: no conflict, no replay of this one.
    other = resume(db, b.admin, fb, rquote(db, b.admin, fb)["quote_id"], key)
    assert other["ok"] is True and other["replayed"] is False and other["id"] != first["id"]


def test_a_quote_id_of_any_other_shape_or_size_is_refused_before_anything_is_counted(db, a):
    fid, _seg = paused(db, a)
    v = db.version(fid)
    used = db.rate_used(a.admin, "start")
    for bad in (None, "", f"fq--{v}-" + "0" * 32, f"fq-{v}-" + "0" * 31, f"fq-{v}-" + "G" * 32, "fq-1234567890-" + "0" * 32,
                f"fq-{v}-" + "0" * 32 + "' or 1=1 --"):
        assert err(lambda: resume(db, a.admin, fid, bad))[:2] == ("NS400", "invalid_params"), bad
        assert err(lambda: rerun(db, a.admin, fid, bad))[:2] in (("NS400", "invalid_params"), ("NS409", "not_assembly_failure")), bad
    assert err(lambda: resume(db, a.admin, fid, "fq-999999999-" + "0" * 32))[:2] == ("NS409", "film_changed")
    for key in (None, "short", "-leading-dash-key", "x" * 129):
        assert err(lambda: db.one("authenticated", a.admin, "select public.start_film_resume(%s::uuid, %s, %s)",
                                  [fid, f"fq-{v}-" + "0" * 32, key]))[:2] == ("NS400", "invalid_idempotency_key"), key
    assert db.rate_used(a.admin, "start") == used and open_holds(db, a.org) == []


# ── reach ─────────────────────────────────────────────────────────────────────

def test_the_service_role_with_a_forged_admin_claim_reaches_no_user_call(db, a):
    fid, _seg = assembly_failed(db, a)
    qid = rquote(db, a.admin, fid)["quote_id"]
    for q, p in (("select public.quote_film_resume(%s::uuid, %s)", [fid, db.version(fid)]),
                 ("select public.start_film_resume(%s::uuid, %s, 'forged-key-01')", [fid, qid]),
                 ("select public.rerun_film_assembly(%s::uuid, %s, 'forged-key-02')", [fid, qid]),
                 ("select public.archive_film(%s::uuid)", [fid])):
        with pytest.raises(psycopg.Error) as e:
            db.act("service_role", a.admin, q, p)  # the service key carrying the admin's sub
        assert e.value.sqlstate == "42501", q
        with pytest.raises(psycopg.Error) as e:
            db.act("anon", a.admin, q, p)
        assert e.value.sqlstate == "42501", q
    # A signed-in session whose claims say service_role is still only the person its sub names: a viewer stays a viewer.
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role", "sub": a.viewer})])
        c.execute("set local role authenticated")
        with pytest.raises(psycopg.Error) as e:
            c.execute("select public.start_film_resume(%s::uuid, %s, 'forged-key-03')", [fid, qid])
        assert e.value.sqlstate == "42501"
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1 and open_holds(db, a.org) == []


def test_members_who_are_not_admins_reach_no_money_call_and_an_editor_only_archives(db, a):
    fid, _seg = assembly_failed(db, a)
    qid = rquote(db, a.admin, fid)["quote_id"]
    for who in (a.editor, a.viewer):
        assert err(lambda: rerun(db, who, fid, qid))[:2] == ("42501", "forbidden")
    assert err(lambda: archive(db, a.viewer, fid))[:2] == ("42501", "forbidden")
    before = (db.account(a.org), db.holds(a.org))
    assert archive(db, a.editor, fid)["film"]["status"] == "archived"
    assert (db.account(a.org), db.holds(a.org)) == before
    assert err(lambda: rerun(db, a.admin, fid, qid))[:2] == ("NS409", "not_assembly_failure") or \
        err(lambda: rerun(db, a.admin, fid, qid))[:2] == ("NS409", "film_not_resumable")
    assert err(lambda: resume(db, a.admin, fid, qid))[:2] == ("NS409", "film_not_resumable")


def test_a_platform_admin_outside_the_organization_quotes_but_never_starts_resumes_or_reruns_on_its_credits(db, a, one_hour):
    """The owner's decision (22 Nov): 0043's accessible_org_ids makes a platform owner or admin an admin of every organization, which
    let platform staff spend a customer's credits on a customer's film (start_film, and the resume, measured here first). Support may
    read the price (a quote holds nothing, and says not_a_member before the press); a start, a resume or a re-run takes an owner or
    admin seat in org_members, and is refused not_a_member with who may call, before anything is counted or held. A platform editor
    or viewer reaches nothing, as before."""
    fid, _seg = paused(db, a)
    staff = platform_user(db, "admin")
    for role in ("editor", "viewer"):
        other = platform_user(db, role)
        assert err(lambda: rquote(db, other, fid))[:2] == ("P0002", "not_found")
        assert err(lambda: resume(db, other, fid, "fq-2-" + "0" * 32))[:2] == ("P0002", "not_found")
        assert err(lambda: archive(db, other, fid))[:2] == ("P0002", "not_found")
    q = rquote(db, staff, fid)
    assert {"reason": "not_a_member"} in q["blocked_by"] and q["startable"] is False and q["may_start"] is False
    holds = db.holds(a.org)
    for fn in (resume, rerun):
        code, word, detail = err(lambda: fn(db, staff, fid, q["quote_id"]))
        assert (code, word) == ("NS400", "not_a_member") and "ask the workspace's owner to add you as a member" in detail
    draft = db.film(a)
    sq = db.quote(staff, draft)
    assert {"reason": "not_a_member"} in sq["blocked_by"] and sq["startable"] is False and sq["may_start"] is False
    assert err(lambda: db.start(staff, draft, sq["quote_id"]))[:2] == ("NS400", "not_a_member")
    assert db.rate_used(staff, "start") == 0 and db.holds(a.org) == holds
    assert db.su("select count(*) from public.film_segments where created_by = %s", [staff])[0][0] == 0
    # A member admin of the same organization still resumes and starts.
    assert resume(db, a.admin, fid, rquote(db, a.admin, fid)["quote_id"])["ok"] is True


def test_in_the_exempt_organization_a_platform_admin_still_starts_and_resumes_on_the_platforms_credits(db):
    """The exempt organization's credits are the platform's own (0020, 0171): its platform owner or admin starts and resumes there
    without a seat in org_members, as before 0215's member rule."""
    platform_user(db, "viewer")
    org = "00000000-0000-0000-0000-000000000001"
    staff = platform_user(db, "admin")
    db.film_org_on(org)
    o = Org(org, staff, staff, staff, staff)
    o.image = db.asset(org)
    f = db.one("authenticated", staff, "select public.create_film_draft(%s::uuid, null, 'topic', 'x', %s::jsonb, %s)",
               [org, json.dumps(SETTINGS_EXEMPT), db.key()])
    fid = f["film"]["id"]
    db.save(staff, fid, 1, {"scenes": SCENES_EXEMPT})
    q = db.quote(staff, fid)
    assert q["exempt"] is True and q["startable"] is True, (q["blocked_by"], q["refusals"])
    seg = db.start(staff, fid, q["quote_id"])
    assert seg["ok"] is True and seg["credit_ref"] is None
    assert db.claim()["id"] == seg["id"]
    for t in db.takes(seg["id"]):
        if t[1] == "clip" and t[3] == 1 and db.su("select position from public.film_scenes where id = %s", [t[2]])[0][0] == 1:
            fail_twice(db, t[0])
        else:
            db.make(o, t[0], t[1])
    db.settle(seg["id"], "takes_failed")
    assert db.film_row(fid)[0] == "paused"
    r = resume(db, staff, fid, rquote(db, staff, fid)["quote_id"])
    assert r["ok"] is True and r["exempt"] is True and r["credit_ref"] is None
    db.cancel(r["id"])


def test_in_the_exempt_organization_only_a_platform_admin_quotes_resumes_or_reruns(db):
    """The platform pays for the exempt (default) organization: its own admin who is not platform staff is refused before anything
    is read, exactly as start_film refuses them."""
    platform_user(db, "viewer")  # the platform roster is not empty, so the default roster is not promoted (0043)
    org = "00000000-0000-0000-0000-000000000001"
    people = [str(uuid.uuid4()) for _ in range(4)]
    for u, role in zip(people, ("owner", "admin", "editor", "viewer")):
        email = f"exempt-{role}-{u[:8]}@money.lab"
        db.su("insert into auth.users (id, email) values (%s, %s)", [u, email])
        db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s)", [org, u, email, role])
    db.film_org_on(org)
    o = Org(org, *people)
    o.image = db.asset(org)
    fid = db.film(o)
    for who in (o.owner, o.admin):
        assert err(lambda: rquote(db, who, fid))[:2] == ("42501", "forbidden")
        assert err(lambda: resume(db, who, fid, "fq-2-" + "0" * 32))[:2] == ("42501", "forbidden")
        assert err(lambda: rerun(db, who, fid, "fq-2-" + "0" * 32))[:2] == ("42501", "forbidden")


# ── the leak ──────────────────────────────────────────────────────────────────

def test_a_member_reads_no_worker_id_in_any_film_event_row_written_after_0215(db, a):
    host = "film-host-secret-9b2c-4242"
    fid, seg = paused(db, a, worker=host)
    out = resumed(db, a, fid)
    finish(db, a, out["id"], worker=host)
    rows = db.one("authenticated", a.viewer, "select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) from public.film_events e "
                                            "where film_id = %s", [fid])
    assert "film-host-secret" not in json.dumps(rows)
    seen = db.one("authenticated", a.viewer, "select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from (select id, status, "
                                            "heartbeat_at, attempts, resumed_from from public.film_segments where film_id = %s) s",
                  [fid])
    assert "film-host-secret" not in json.dumps(seen)
    for fn in ("film_json",):
        assert "film-host-secret" not in json.dumps(db.one("authenticated", a.viewer, f"select public.{fn}(%s::uuid)", [fid]))


@pytest.mark.xfail(strict=True, reason="BR-0215-01 open (info): worker_ref is an unsalted md5")
def test_breach_hole_the_worker_ref_gives_a_member_the_worker_id_back_by_a_dictionary(db, a):
    """HOLE (low). worker_ref is left(md5(worker id), 12) with no secret: the worker id defaults to '<host name>-<pid>'
    (tools/film_worker.py), so a member who guesses the host name (a compose service name, a VPS name, the site's own name)
    confirms the guess and recovers the pid from film_json in well under a second. An opaque reference needs a key the member does
    not have (an HMAC with a server secret, or a random per-lease id)."""
    worker = "nightshift-film-worker-31337"
    fid, _seg = paused(db, a, worker=worker)
    shown = db.one("authenticated", a.viewer, "select public.film_json(%s::uuid)", [fid])
    refs = [e["detail"]["worker_ref"] for e in shown["events"] if e["event"] == "segment_claimed"]
    assert len(refs) == 1
    recovered = None
    for host in ("film-worker", "worker", "nightshift-worker", "nightshift-film-worker"):
        for pid in range(1, 1 << 16):
            cand = f"{host}-{pid}"
            if hashlib.md5(cand.encode()).hexdigest()[:12] == refs[0]:
                recovered = cand
                break
        if recovered:
            break
    assert recovered is None, f"a viewer recovered the worker id {recovered!r} from worker_ref {refs[0]!r}"


# ── the cap and the cancel ────────────────────────────────────────────────────

def test_breach_hole_a_paused_film_resumed_costs_more_than_the_per_film_cap(db):
    """HOLE (medium). org_film_settings.max_credits_per_film: 'Set: no film whose total is above it may start' (0171). start_film
    asks it of the film's total; start_film_resume asks it of the resume total alone, never of what the film already captured. A film
    at its cap (49) pauses after 24; the clip rate rises; the resume (35) is under the cap, so the film costs 59."""
    o = db.new_org(credits=200)
    db.su("insert into public.org_film_settings (org_id, max_credits_per_film) values (%s, 49) "
          "on conflict (org_id) do update set max_credits_per_film = excluded.max_credits_per_film", [o.org])
    fid, _seg = paused(db, o)
    db.su("update public.credit_prices set credits_per_unit = 3 where unit = 'model_vid_clip_second'")
    try:
        q = rquote(db, o.admin, fid)
        assert Decimal(str(q["total"])) == 35
        out = resume(db, o.admin, fid, q["quote_id"])
    finally:
        db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vid_clip_second'")
    committed = captures_of(db, fid) + sum((Decimal(h[1]) for h in open_holds(db, o.org)), Decimal(0))
    assert out.get("ok") is not True and committed <= 49, \
        f"the film's cap is 49 and it has {captures_of(db, fid)} captured and {committed} captured or held after the resume: {out}"


def test_breach_hole_a_resume_cancelled_before_it_made_anything_strands_the_paid_takes(db, a):
    """HOLE (low; latent until a cancel reaches the browser). A resume segment always holds completed takes (the carried ones), so
    film_settle_locked's `ran` is true and a cancel that made nothing new takes the charged-cancel branch: the film is `cancelled`,
    which 0215 never resumes. The person paid 24 for takes they can now only pay for again in a new film. 0215's header: 'a resume
    that made nothing new leaves the film paused again (its carried takes count as made)'."""
    fid, _seg = paused(db, a)
    out = resumed(db, a, fid)
    res = db.cancel(out["id"])
    assert res["settled"] is True and Decimal(res["captured_credits"]) == 0
    assert [h for h in db.holds(a.org) if h[0] == out["credit_ref"]][0][2] == "released"
    status = db.film_row(fid)
    assert status[0] == "paused", f"a resume cancelled before it made anything left the film {status}: its paid takes cannot go on"
    assert rquote(db, a.admin, fid)["startable"] is True


# ── archive ───────────────────────────────────────────────────────────────────

def test_archive_never_moves_money_and_kills_an_outstanding_resume_quote(db, a):
    fid, _seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    before = (db.account(a.org), db.holds(a.org), db.ledger(a.org, "capture"), db.ledger(a.org, "release"))
    assert archive(db, a.editor, fid)["film"]["status"] == "archived"
    assert (db.account(a.org), db.holds(a.org), db.ledger(a.org, "capture"), db.ledger(a.org, "release")) == before
    assert err(lambda: resume(db, a.admin, fid, q["quote_id"]))[:2] == ("NS409", "film_not_resumable")
    assert err(lambda: db.start(a.admin, fid, q["quote_id"]))[:2] == ("NS409", "film_not_startable")
    assert archive(db, a.editor, fid)["film"]["status"] == "archived"  # again: answered as it is, nothing written
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1


def test_archive_while_a_resume_runs_is_refused_and_moves_nothing(db, a):
    fid, _seg = paused(db, a)
    out = resumed(db, a, fid)
    db.claim()
    before = (db.account(a.org), db.holds(a.org))
    assert err(lambda: archive(db, a.owner, fid))[:2] == ("NS409", "film_not_editable")
    assert (db.account(a.org), db.holds(a.org)) == before
    assert db.segment(out["id"])[0] == "running"
