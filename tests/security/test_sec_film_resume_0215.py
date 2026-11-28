"""Migration 0215 (Film Studio switch-on gate G1: archive a paused or cancelled film, resume a paused one; and the film worker's host
name kept out of what members read), attacked in a real database.

A paused film here is the money lab's two-scene film (key frame 3, clip 20, clip 20, narration 1, assembly 5 = 49) whose second
scene's clip failed twice: 24 captured, the film paused (takes_failed). What would break without each guard (each test names it):

  * archive: a paused or cancelled film may be put away by an editor, never while a segment is open or a refund waits on one of its
    holds, and archiving moves no money and deletes no paid result;
  * the resume quote: only the lines not completed are priced, at today's rates, through 0171's film_price; the earlier segment's
    confirmed price is beside each line, with the difference; one unpriced line makes the total and the quote id null;
  * the resume start: start_film's caller rules and refusal order; a replay answers its first answer; a new key on a resumed film is
    refused; two concurrent resumes make one segment and one hold; NS402 when the credits are short; a completed take is carried at 0
    and never charged again (the table refuses it); the capture is never above the new hold;
  * the assembly re-run (rerun_film_assembly): only a film whose every take is made and whose assembly failed, only for S4's
    retryable words, the assembly line only; two at once, a replay, a race with a resume, another org, a deleted take file;
  * another organization's film reads as a missing one; anon and the service role reach no call;
  * the leak: segment_claimed and the creative job's 'claimed' record an opaque reference, a member's film_json carries no worker id
    (rows written before 0215 included), a start replay carries no worker_id;
  * the migration: a replay changes nothing, the drift guard refuses a body or a check that is not its own, the rollback refuses while
    a resume is open, puts the earlier bodies back and 0215 applies again; sec_db's take-off / put-back chain goes through it.

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

import sec_db
from test_sec_films_money import Db, a, b, db, err, no_live_segment, one_hour, refused  # noqa: F401 — the money lab, as it is

MIGRATION = sec_db.MIGRATION_0215
ROLLBACK = sec_db.ROLLBACK_0215
HOST = "film-host-secret-7f3a"        # what a worker id defaults to: the host name and the pid
PAID_FIRST = Decimal(24)             # key frame 3 + clip 20 + narration 1
LEFT = Decimal(25)                   # scene 2's clip 20 + the assembly 5


# ── a paused film ─────────────────────────────────────────────────────────────

def positions(db, fid):
    return {str(r[0]): r[1] for r in db.su("select id, position from public.film_scenes where film_id = %s", [fid])}


def paused(db, o, worker="w-1", fid=None):
    """Started, claimed, scene 2's clip failed twice, everything else made, settled takes_failed: the film is paused."""
    fid = fid or db.film(o)
    seg = db.quoted_start(o, fid)
    assert db.claim(worker)["id"] == seg["id"]
    pos = positions(db, fid)
    for t in db.takes(seg["id"]):
        tid, kind, scene = str(t[0]), t[1], t[2]
        if kind == "clip" and pos[str(scene)] == 1:
            db.begin(tid, worker)
            retry = db.fail(tid, "provider_error", worker)["retry_take_id"]
            db.begin(retry, worker)
            db.fail(retry, "provider_error", worker)
        else:
            db.make(o, tid, kind, worker)
    out = db.settle(seg["id"], "takes_failed", worker)
    assert out["settled"] is True and Decimal(out["captured_credits"]) == PAID_FIRST, out
    assert db.film_row(fid) == ("paused", "takes_failed")
    return fid, seg


def rquote(db, who, fid, version=None):
    return db.one("authenticated", who, "select public.quote_film_resume(%s::uuid, %s::integer)",
                  [fid, db.version(fid) if version is None else version])


def resume(db, who, fid, quote_id, key=None):
    return db.one("authenticated", who, "select public.start_film_resume(%s::uuid, %s, %s)", [fid, quote_id, key or db.key()])


def resumed(db, o, fid):
    out = resume(db, o.admin, fid, rquote(db, o.admin, fid)["quote_id"])
    assert out.get("ok") is True, out
    return out


def finish(db, o, seg, worker="w-1"):
    """Claim the segment, make every planned take, assemble (18 s: one minute) and settle completed."""
    assert db.claim(worker)["id"] == seg
    db.finish_all(o, seg, worker)
    db.svc("select public.film_begin_assembly(%s, %s)", [seg, worker])
    db.svc("select public.film_record_assembly(%s, %s, true, %s::uuid)", [seg, worker, db.asset(o.org, "video", "video/mp4", duration=18)])
    return db.settle(seg, "completed", worker)


def take_rows(db, seg):
    return db.su("select t.kind, s.position, t.status, t.confirmed_credits, t.charged_credits, t.charge_basis, t.carried_from_take_id, "
                 "t.result_asset_id, t.version from public.film_takes t left join public.film_scenes s on s.id = t.scene_id "
                 "where t.segment_id = %s order by s.position nulls last, t.shot_index, t.attempt", [seg])


# ── archive ───────────────────────────────────────────────────────────────────

def test_a_paused_film_is_archived_by_an_editor_and_nothing_paid_for_moves_or_goes(db, a):
    fid, seg = paused(db, a)
    before = (db.account(a.org), db.holds(a.org), db.ledger(a.org, "capture"))
    results = [r[0] for r in db.su("select result_asset_id from public.film_takes where film_id = %s and result_asset_id is not null",
                                   [fid])]
    assert len(results) == 3
    assert err(lambda: db.one("authenticated", a.viewer, "select public.archive_film(%s::uuid)", [fid]))[:2] == ("42501", "forbidden")
    out = db.one("authenticated", a.editor, "select public.archive_film(%s::uuid)", [fid])
    assert out["film"]["status"] == "archived" and out["film"]["archived_at"] is not None
    assert (db.account(a.org), db.holds(a.org), db.ledger(a.org, "capture")) == before  # no money moved
    assert all(db.live(r) for r in results)  # a paid result is never deleted by archiving
    assert db.su("select count(*) from public.film_takes where film_id = %s", [fid])[0][0] == 5
    ev = db.su("select detail from public.film_events where film_id = %s and event = 'archived'", [fid])
    assert ev == [({"from_status": "paused", "pause_reason": "takes_failed"},)]
    # An archived film is neither resumed nor archived twice (the second answers as it is and writes nothing).
    assert err(lambda: rquote(db, a.admin, fid))[:2] == ("NS409", "film_not_resumable")
    db.one("authenticated", a.editor, "select public.archive_film(%s::uuid)", [fid])
    assert db.events(fid).count("archived") == 1


def test_a_cancelled_film_is_archived_and_is_never_resumed(db, a):
    """0171 leaves a film `cancelled` only after a charge (a cancel that charged nothing goes back to draft): a person stopped it, and
    start_film never restarts it. So 0215 archives it and refuses to resume it."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0]
    assert kf[1] == "keyframe"
    db.make(a, kf[0], "keyframe")
    assert db.cancel(seg["id"])["settled"] is True
    assert db.film_row(fid)[0] == "cancelled"
    code, word, detail = err(lambda: rquote(db, a.admin, fid))
    assert (code, word) == ("NS409", "film_not_resumable") and "cancelled" in detail
    assert err(lambda: resume(db, a.admin, fid, "fq-2-" + "0" * 32))[:2] == ("NS409", "film_not_resumable")
    assert db.one("authenticated", a.editor, "select public.archive_film(%s::uuid)", [fid])["film"]["status"] == "archived"


@pytest.mark.parametrize("status", ["queued", "running", "draining", "ready"])
def test_a_film_that_is_running_or_ready_is_not_archived(db, a, status):
    fid = db.film(a)
    db.su("update public.films set status = %s where id = %s", [status, fid])
    assert err(lambda: db.one("authenticated", a.owner, "select public.archive_film(%s::uuid)", [fid]))[:2] == \
        ("NS409", "film_not_editable")


def test_archive_is_refused_while_a_segment_of_the_film_is_open_whatever_the_film_row_says(db, a):
    """Defence in depth: the film row and its segment are written together, but archive asks the segment too."""
    fid, seg = paused(db, a)
    out = resumed(db, a, fid)
    assert db.film_row(fid)[0] == "queued"
    db.su("update public.films set status = 'paused' where id = %s", [fid])  # a row that disagrees with its open segment
    try:
        code, word, _ = err(lambda: db.one("authenticated", a.owner, "select public.archive_film(%s::uuid)", [fid]))
        assert (code, word) == ("NS409", "segment_open")
    finally:
        db.su("update public.films set status = 'queued' where id = %s", [fid])
    assert db.segment(out["id"])[0] == "queued"


def test_archive_is_refused_while_a_refund_waits_to_collect_from_one_of_its_holds(db, a):
    fid, seg = paused(db, a)
    ref = db.segment(seg["id"])[3]
    rid = f"rf_{uuid.uuid4().hex[:12]}"
    db.su("insert into public.credit_refunds (refund_id, purchase_external_id, org_id, requested, taken, shortfall) "
          "values (%s, 'pay_lab', %s, 10, 0, 10)", [rid, a.org])
    db.su("insert into public.credit_refund_recoveries (refund_id, purchase_external_id, org_id, holds, owed) "
          "values (%s, 'pay_lab', %s, %s, 10)", [rid, a.org, [ref]])
    assert err(lambda: db.one("authenticated", a.owner, "select public.archive_film(%s::uuid)", [fid]))[:2] == \
        ("NS409", "refund_pending")
    db.su("update public.credit_refund_recoveries set collected = owed where refund_id = %s", [rid])
    assert db.one("authenticated", a.owner, "select public.archive_film(%s::uuid)", [fid])["film"]["status"] == "archived"


# ── the resume quote ──────────────────────────────────────────────────────────

def lines_of(q):
    return sorted((ln["line"], ln["position"]) for ln in q["lines"])


def test_the_resume_quote_prices_only_the_lines_not_completed_at_the_confirmed_price(db, a):
    fid, seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    assert lines_of(q) == sorted([("clip", 1), ("assembly", None)]), q["lines"]
    assert sorted((c["line"], c["position"]) for c in q["carried"]) == sorted([("keyframe", 0), ("clip", 0), ("narration", None)])
    assert all(c["credits"] == 0 for c in q["carried"])
    assert Decimal(str(q["total"])) == LEFT and q["priced"] is True and q["quote_id"].startswith("fq-")
    assert Decimal(str(q["original_remaining"])) == LEFT and Decimal(str(q["delta"])) == 0 and q["changed"] is False
    assert q["resumed_from"] == seg["id"] and q["purpose"] == "resume"
    assert q["startable"] is True and q["blocked_by"] == [] and Decimal(str(q["available"])) == Decimal(100) - PAID_FIRST
    for ln in q["lines"]:
        assert ln["original_credits"] == ln["credits"] and ln["changed"] is False
    stored = db.su("select purpose, from_segment, total from public.film_quotes where quote_id = %s", [q["quote_id"]])
    assert stored == [("resume", uuid.UUID(seg["id"]), LEFT)]


def test_a_rate_that_moved_since_the_first_start_is_priced_today_and_the_difference_is_said(db, a):
    fid, _seg = paused(db, a)
    db.su("update public.credit_prices set credits_per_unit = 3 where unit = 'model_vid_clip_second'")
    try:
        q = rquote(db, a.admin, fid)
        clip = [ln for ln in q["lines"] if ln["line"] == "clip"][0]
        assert (Decimal(str(clip["credits"])), Decimal(str(clip["original_credits"])), Decimal(str(clip["delta"])), clip["changed"]) == \
            (Decimal(30), Decimal(20), Decimal(10), True)
        assert Decimal(str(q["total"])) == Decimal(35) and Decimal(str(q["delta"])) == Decimal(10) and q["changed"] is True
    finally:
        db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vid_clip_second'")


def test_one_unpriced_line_makes_the_resume_total_unknown_and_nothing_starts(db, a, one_hour):
    fid, _seg = paused(db, a)
    good = rquote(db, a.admin, fid)["quote_id"]
    rate = db.su("select credits_per_unit from public.credit_prices where unit = 'film_assembly_minute'")[0][0]
    db.su("delete from public.credit_prices where unit = 'film_assembly_minute'")
    try:
        q = rquote(db, a.admin, fid)
        assert q["priced"] is False and q["total"] is None and q["quote_id"] is None and q["startable"] is False
        assert q["delta"] is None and q["changed"] is None
        asm = [ln for ln in q["lines"] if ln["line"] == "assembly"][0]
        assert asm["priced"] is False and asm["credits"] is None and asm["reason"] == "unpriced" and asm["delta"] is None
        assert {r["reason"] for r in q["refusals"]} == {"unpriced"}
        # The quote stored before the price went is still refused: the start prices again and finds the line unpriced.
        assert refused(resume(db, a.admin, fid, good)) == ("unpriced", "NS400")
    finally:
        db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0)", [rate])
    assert db.film_row(fid)[0] == "paused" and db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1


def test_a_made_take_whose_file_was_deleted_since_is_priced_and_made_again_never_carried(db, a):
    """Carrying a take whose result a person deleted from the library would hand the next take (or the cut) a file that is gone,
    and the film could then never finish. So it is a line again, priced and shown, at today's rate."""
    fid, seg = paused(db, a)
    clip0 = [r for r in db.su("select t.id, t.result_asset_id from public.film_takes t join public.film_scenes s on s.id = t.scene_id "
                              "where t.segment_id = %s and t.kind = 'clip' and s.position = 0 and t.status = 'completed'",
                              [seg["id"]])][0]
    db.su("update public.media_assets set deleted_at = now() where id = %s", [clip0[1]])
    q = rquote(db, a.admin, fid)
    assert lines_of(q) == sorted([("clip", 0), ("clip", 1), ("assembly", None)]), q["lines"]
    assert Decimal(str(q["total"])) == LEFT + 20 and str(clip0[0]) not in json.dumps(q["carried"])
    out = resume(db, a.admin, fid, q["quote_id"])
    assert out["ok"] is True and out["carried"] == 2
    assert db.su("select count(*) from public.film_takes where segment_id = %s and carried_from_take_id = %s", [out["id"], clip0[0]]) \
        == [(0,)]


def test_when_only_the_assembly_is_left_only_the_assembly_is_priced(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    db.finish_all(a, seg["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    db.svc("select public.film_record_assembly(%s, 'w-1', false, null)", [seg["id"]])
    db.settle(seg["id"], "assembly_failed")
    assert db.film_row(fid) == ("paused", "assembly_failed")
    q = rquote(db, a.admin, fid)
    assert lines_of(q) == [("assembly", None)] and Decimal(str(q["total"])) == Decimal(5) and len(q["carried"]) == 4


def test_only_an_admin_quotes_or_starts_a_resume_and_only_a_paused_film_at_its_version(db, a):
    fid, _seg = paused(db, a)
    for who in (a.editor, a.viewer):
        assert err(lambda: rquote(db, who, fid))[:2] == ("42501", "forbidden")
        assert err(lambda: resume(db, who, fid, "fq-2-" + "0" * 32))[:2] == ("42501", "forbidden")
    assert rquote(db, a.owner, fid)["startable"] is True
    assert err(lambda: rquote(db, a.admin, fid, db.version(fid) + 1))[:2] == ("NS409", "film_changed")
    draft = db.film(a)
    code, word, _ = err(lambda: rquote(db, a.admin, draft))
    assert (code, word) == ("NS409", "film_not_resumable")
    # An initial quote never resumes a film, and a resume quote never starts one.
    assert err(lambda: resume(db, a.admin, draft, db.quote(a.editor, draft)["quote_id"]))[:2] == ("NS409", "film_not_resumable")


# ── the resume start ──────────────────────────────────────────────────────────

def test_a_resume_takes_a_new_segment_and_a_new_hold_of_what_is_left_and_carries_the_made_takes_at_zero(db, a):
    fid, seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    key = db.key()
    out = resume(db, a.admin, fid, q["quote_id"], key)
    assert out["ok"] is True and out["replayed"] is False and out["purpose"] == "resume" and out["n"] == 2
    assert out["resumed_from"] == seg["id"] and out["carried"] == 3 and "worker_id" not in out
    assert Decimal(str(out["confirmed_credits"])) == LEFT and out["status"] == "queued"
    assert db.film_row(fid) == ("queued", None)
    hold = [h for h in db.holds(a.org) if h[0] == out["credit_ref"]]
    assert out["credit_ref"] == "fm-" + out["id"].replace("-", "") and hold == [(out["credit_ref"], LEFT, "open", None)]
    rows = take_rows(db, out["id"])
    made_before = {r[0]: r[7] for r in take_rows(db, seg["id"]) if r[2] == "completed"}
    carried = [r for r in rows if r[6] is not None]
    assert sorted((r[0], r[1]) for r in carried) == sorted([("keyframe", 0), ("clip", 0), ("narration", None)])
    for r in carried:
        assert (r[2], r[3], r[4], r[5]) == ("completed", 0, 0, "carried_not_charged"), r
    assert {r[7] for r in carried} == set(made_before.values())  # the same results, not new files
    planned = [r for r in rows if r[6] is None]
    assert [(r[0], r[1], r[2], r[3]) for r in planned] == [("clip", 1, "planned", Decimal(20))]
    # One version per scene in the segment (the assembly cuts one), past every take of an earlier segment.
    assert {r[8] for r in rows if r[1] == 0} == {2} and {r[8] for r in rows if r[1] == 1} == {2}
    ev = db.su("select detail from public.film_events where film_id = %s and event = 'resumed'", [fid])[0][0]
    assert ev["resumed_from"] == seg["id"] and ev["carried"] == 3 and ev["takes"] == 1 and Decimal(str(ev["credits"])) == LEFT


def test_a_replayed_resume_answers_its_first_answer_and_holds_nothing_more(db, a):
    fid, _seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    key = db.key()
    first = resume(db, a.admin, fid, q["quote_id"], key)
    holds = db.holds(a.org)
    again = resume(db, a.admin, fid, q["quote_id"], key)
    assert again["ok"] is True and again["replayed"] is True and again["id"] == first["id"]
    assert db.holds(a.org) == holds
    # The same key with another quote is a conflict, and a start's key never replays as a resume.
    assert err(lambda: resume(db, a.admin, fid, "fq-2-" + "1" * 32, key))[:2] == ("NS409", "idempotency_conflict")
    start_key = db.su("select idempotency_key from public.film_segments where film_id = %s and n = 1", [fid])[0][0]
    assert err(lambda: resume(db, a.admin, fid, q["quote_id"], start_key))[:2] == ("NS409", "idempotency_conflict")


def test_a_new_key_on_a_film_that_already_resumed_is_refused(db, a):
    fid, _seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    resume(db, a.admin, fid, q["quote_id"])
    code, word, _ = err(lambda: resume(db, a.admin, fid, q["quote_id"]))
    assert (code, word) == ("NS409", "film_not_resumable")
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 2


def test_two_concurrent_resumes_make_one_segment_and_one_hold(db, a):
    fid, _seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    keys = [db.key() for _ in range(4)]
    gate, seen, lock = threading.Barrier(4), [], threading.Lock()

    def go(key):
        gate.wait()
        try:
            r = ("ok", resume(db, a.admin, fid, q["quote_id"], key)["ok"])
        except psycopg.Error as e:
            r = (e.sqlstate, str(e).splitlines()[0])
        with lock:
            seen.append(r)

    threads = [threading.Thread(target=go, args=(k,)) for k in keys]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(seen) == sorted([("ok", True)] + [("NS409", "film_not_resumable")] * 3), seen
    assert db.su("select count(*) from public.film_segments where film_id = %s and purpose = 'resume'", [fid])[0][0] == 1
    assert len([h for h in db.holds(a.org) if h[2] == "open"]) == 1


def test_a_resume_the_credits_cannot_pay_is_refused_ns402_counted_and_nothing_is_held(db, one_hour):
    o = db.new_org(credits=49)  # exactly the first start; 25 are left after it captures 24
    fid, _seg = paused(db, o)
    db.su("update public.credit_prices set credits_per_unit = 3 where unit = 'model_vid_clip_second'")  # what is left is now 35
    try:
        q = rquote(db, o.admin, fid)
        assert {"reason": "insufficient_credits", "available": 25.0, "needed": 35.0} in \
            [{k: (float(v) if isinstance(v, (int, float)) else v) for k, v in b.items()} for b in q["blocked_by"]], q["blocked_by"]
        used = db.rate_used(o.admin, "start")
        out = resume(db, o.admin, fid, q["quote_id"])
        assert refused(out) == ("insufficient_credits", "NS402") and "needed=35" in out["detail"]
        assert db.rate_used(o.admin, "start") == used + 1  # the refusal is counted (BR-0171-01)
    finally:
        db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vid_clip_second'")
    assert [h for h in db.holds(o.org) if h[2] == "open"] == [] and db.film_row(fid)[0] == "paused"
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1


def test_a_completed_take_is_never_charged_twice_and_the_capture_is_never_above_the_new_hold(db, a):
    fid, seg = paused(db, a)
    balance = db.account(a.org)[0]
    out = resumed(db, a, fid)
    settled = finish(db, a, out["id"])
    assert settled["settled"] is True and db.film_row(fid) == ("ready", None)
    captured = Decimal(settled["captured_credits"])
    assert captured == LEFT <= Decimal(out["confirmed_credits"])  # the clip 20 and the assembly 5: nothing carried is in it
    hold = [h for h in db.holds(a.org) if h[0] == out["credit_ref"]][0]
    assert hold[2] == "captured" and Decimal(hold[3]) == captured <= Decimal(hold[1])
    assert db.account(a.org) == (balance - captured, 0)
    assert db.ledger(a.org, "capture") == [-PAID_FIRST, -LEFT]  # one capture a segment, 49 in all: the film's price, once
    for kind in ("keyframe", "narration"):
        assert db.su("select sum(charged_credits) from public.film_takes where film_id = %s and kind = %s", [fid, kind])[0][0] == \
            {"keyframe": 3, "narration": 1}[kind]
    assert db.su("select coalesce(sum(charged_credits), 0) from public.film_takes where segment_id = %s and carried_from_take_id is not null",
                 [out["id"]])[0][0] == 0


def test_no_path_charges_a_carried_take(db, a):
    fid, _seg = paused(db, a)
    out = resumed(db, a, fid)
    db.claim()
    kf = [r for r in db.su("select id, result_asset_id from public.film_takes where segment_id = %s and kind = 'keyframe'", [out["id"]])][0]
    assert err(lambda: db.begin(kf[0]))[:2] == ("NS409", "take_not_planned")
    assert err(lambda: db.fail(kf[0], "provider_error"))[:2] == ("NS409", "take_not_running")
    other = db.output(a.org, kf[0], "image", "image/png")
    assert err(lambda: db.succeed(kf[0], None, other))[:2] == ("NS409", "take_not_running")
    again = db.succeed(kf[0], None, str(kf[1]))  # its own result handed in again answers as it is, at 0
    assert again["accepted"] is True and again["charged_credits"] == 0
    # And the table itself refuses a charge on a carried take, whoever writes it.
    with pytest.raises(psycopg.errors.CheckViolation):
        db.su("update public.film_takes set charged_credits = 3, confirmed_credits = 3 where id = %s", [kf[0]])


def test_a_resume_that_makes_nothing_leaves_the_film_paused_and_resumable_never_back_at_draft(db, a):
    """Nobody claims the resume within 3 hours: the sweep releases its hold at 0. Its carried takes are made takes, so the film is
    paused again with its paid results (0171 sends a film that made nothing back to draft, where start_film would price it all)."""
    fid, _seg = paused(db, a)
    out = resumed(db, a, fid)
    db.su("update public.film_segments set created_at = now() - interval '4 hours' where id = %s", [out["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.segment(out["id"])[:2] == ("released", Decimal(0))
    assert db.film_row(fid) == ("paused", "worker_unavailable")
    assert [h for h in db.holds(a.org) if h[0] == out["credit_ref"]][0][2] == "released"
    q = rquote(db, a.admin, fid)
    assert q["resumed_from"] == out["id"] and lines_of(q) == sorted([("clip", 1), ("assembly", None)])


# ── a failed assembly made again (rerun_film_assembly) ────────────────────────

RETRYABLE = {"assembly_crashed", "render_failed", "render_timed_out", "render_degraded", "store_failed", "disk_low", "output_mismatch",
             "captions_failed", "captions_unavailable"}
NOT_RETRYABLE = ["review_copy_too_large", "review_copy_missing", "missing_take", "take_failed", "asset_unavailable",
                 "continuity_broken", "aspect_mismatch", "too_many_audio_clips", "film_too_long", "narration_segments_missing",
                 "caption_overlap", "scene_not_shot", "narration_missing", "film_unavailable", "assembly_not_enabled",
                 "cancelled", "takes_failed", None]
# The settle reasons that replace the assembly's own word (the sweep, the last lease, the worker's generic one): an unknown cause.
WORD_LOST = {"deadline", "worker_lost", "assembly_failed"}


def assembly_failed(db, o, word="render_failed"):
    """Every take made; the assembly ran and failed with ``word``, which the worker settles the segment with (its settle_reason)."""
    fid = db.film(o)
    seg = db.quoted_start(o, fid)
    assert db.claim()["id"] == seg["id"]
    db.finish_all(o, seg["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    db.svc("select public.film_record_assembly(%s, 'w-1', false, null)", [seg["id"]])
    db.settle(seg["id"], word)
    assert db.film_row(fid) == ("paused", word)
    return fid, seg


def rerun(db, who, fid, quote_id, key=None):
    return db.one("authenticated", who, "select public.rerun_film_assembly(%s::uuid, %s, %s)", [fid, quote_id, key or db.key()])


def test_the_retryable_words_are_exactly_s4s_list_and_the_three_lost_words(db):
    got = {w for (w,) in db.su("select w from unnest(%s::text[]) w where public.film_assembly_retryable(w)",
                                [sorted(RETRYABLE | WORD_LOST) + [w for w in NOT_RETRYABLE if w]])}
    assert got == RETRYABLE | WORD_LOST
    assert db.su("select public.film_assembly_retryable(null)")[0][0] is False


def test_a_failed_assembly_is_made_again_for_its_line_only_and_no_take_is_charged_again(db, a):
    fid, seg = assembly_failed(db, a, "render_failed")
    balance = db.account(a.org)[0]
    q = rquote(db, a.admin, fid)
    assert lines_of(q) == [("assembly", None)] and q["rerun"] is True and q["previous_failure"] == "render_failed"
    assert q["assembly_retryable"] is True and q["startable"] is True and Decimal(str(q["total"])) == 5
    out = rerun(db, a.admin, fid, q["quote_id"])
    assert out["ok"] is True and out["rerun"] is True and out["carried"] == 4 and Decimal(out["confirmed_credits"]) == 5
    ev = db.su("select detail from public.film_events where film_id = %s and event = 'assembly_rerun'", [fid])[0][0]
    assert ev["previous_failure"] == "render_failed" and ev["resumed_from"] == seg["id"] and ev["takes"] == 0
    assert "resumed" not in db.events(fid)
    settled = finish(db, a, out["id"])
    assert Decimal(settled["captured_credits"]) == 5 and db.film_row(fid) == ("ready", None)
    assert db.account(a.org)[0] == balance - 5
    assert db.ledger(a.org, "capture") == [-(TOTAL_TAKES), Decimal(-5)]


TOTAL_TAKES = Decimal(44)   # 49 less the assembly, which failed at 0


@pytest.mark.parametrize("word", ["continuity_broken", "review_copy_too_large", "missing_take"])
def test_a_failure_the_same_takes_cannot_cure_is_not_made_again(db, a, word):
    fid, _seg = assembly_failed(db, a, word)
    q = rquote(db, a.admin, fid)
    assert q["rerun"] is True and q["startable"] is False
    assert {"reason": "assembly_not_retryable", "word": word} in q["blocked_by"]
    for call in (rerun, resume):
        code, w, detail = err(lambda: call(db, a.admin, fid, q["quote_id"]))
        assert (code, w, detail) == ("NS409", "assembly_not_retryable", f"word={word}")
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1


def assembly_lost(db, o, how):
    """Every take made; the assembly ran, and its own word never reached the settle: the sweep past the deadline and grace
    (deadline), the claim after the last lease (worker_lost), or the worker's generic word after recording the failure."""
    fid = db.film(o)
    seg = db.quoted_start(o, fid)
    assert db.claim()["id"] == seg["id"]
    db.finish_all(o, seg["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    if how == "deadline":
        db.su("update public.film_segments set deadline_at = now() - interval '3 hours' where id = %s", [seg["id"]])
        assert db.svc("select public.film_expire_segments()") == 1
    elif how == "worker_lost":
        db.su("update public.film_segments set heartbeat_at = now() - interval '1 hour', attempts = max_attempts where id = %s",
              [seg["id"]])
        assert db.claim("w-2") is None
    else:
        db.svc("select public.film_record_assembly(%s, 'w-1', false, null)", [seg["id"]])
        db.settle(seg["id"], "assembly_failed")
    assert db.film_row(fid) == ("paused", how)
    assert db.su("select assembly_status from public.film_segments where id = %s", [seg["id"]])[0][0] == "failed"
    return fid, seg


@pytest.mark.parametrize("how", sorted(WORD_LOST))
def test_a_failed_assembly_whose_word_was_lost_may_be_made_again(db, a, how):
    """M2: the takes are fully paid; with the word replaced by the sweep, the last lease or the generic one, the cause is unknown,
    never proven deterministic, and a failed assembly is charged 0: refusing the re-run would strand them for good."""
    fid, _seg = assembly_lost(db, a, how)
    q = rquote(db, a.admin, fid)
    assert q["rerun"] is True and q["previous_failure"] == how and q["assembly_retryable"] is True and q["startable"] is True
    out = rerun(db, a.admin, fid, q["quote_id"])
    assert out["ok"] is True and out["rerun"] is True and Decimal(out["confirmed_credits"]) == 5
    assert db.su("select detail ->> 'previous_failure' from public.film_events where film_id = %s and event = 'assembly_rerun'",
                 [fid])[0][0] == how
    assert Decimal(finish(db, a, out["id"])["captured_credits"]) == 5 and db.film_row(fid) == ("ready", None)


def test_two_re_runs_that_lose_their_word_in_a_row_are_the_last_free_ones_and_the_third_is_refused_holding_nothing(db, a, one_hour):
    """BR-0215-R2-04: a lost word is an unknown cause, so it may be re-run, but not without end: after two re-runs that ended with a
    lost word, the quote says assembly_not_retryable (reruns 2) and both doors refuse it before anything is counted or held."""
    fid, _seg = assembly_lost(db, a, "deadline")
    for _ in range(2):
        q = rquote(db, a.admin, fid)
        assert q["startable"] is True and q["assembly_retryable"] is True
        out = rerun(db, a.admin, fid, q["quote_id"])
        assert out["ok"] is True
        db.claim()
        db.svc("select public.film_begin_assembly(%s, 'w-1')", [out["id"]])
        db.su("update public.film_segments set deadline_at = now() - interval '3 hours' where id = %s", [out["id"]])
        assert db.svc("select public.film_expire_segments()") == 1
        assert db.film_row(fid) == ("paused", "deadline")
    q = rquote(db, a.admin, fid)
    assert q["lost_reruns"] == 2 and q["startable"] is False
    assert {"reason": "assembly_not_retryable", "word": "deadline", "reruns": 2} in q["blocked_by"]
    holds, used = db.holds(a.org), db.rate_used(a.admin, "start")
    for door in (rerun, resume):
        assert err(lambda: door(db, a.admin, fid, q["quote_id"])) == ("NS409", "assembly_not_retryable", "word=deadline reruns=2")
    assert db.holds(a.org) == holds and db.rate_used(a.admin, "start") == used
    assert db.ledger(a.org, "capture") == [Decimal(-44)]  # the takes, once; every failed assembly at 0


def test_an_assembly_recorded_completed_is_a_ready_film_even_when_the_sweep_settles_it_at_the_deadline(db, a):
    """M3: the assembly completed, the worker died before its settle, and the sweep settles past the deadline and grace. Before 0215
    the film was left paused (deadline) with nothing to resume; it is ready, and its price is captured once."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    db.finish_all(a, seg["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)",
           [seg["id"], db.asset(a.org, "video", "video/mp4", duration=18)])
    db.su("update public.film_segments set deadline_at = now() - interval '3 hours' where id = %s", [seg["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.film_row(fid) == ("ready", None)
    assert db.segment(seg["id"])[:3] == ("settled", Decimal(49), "completed")
    assert db.ledger(a.org, "capture") == [Decimal(-49)]
    assert err(lambda: rquote(db, a.admin, fid))[:2] == ("NS409", "film_not_resumable")


def test_a_resume_of_a_resume_says_what_each_carried_take_was_charged_by_the_take_that_was_made(db, a):
    """Rule 5: a carried copy is charged 0, and the quote must not read that 0 as what the take cost: it follows the copy to the
    take that was made."""
    fid, _seg = paused(db, a)
    out = resumed(db, a, fid)
    assert db.claim()["id"] == out["id"]
    clip = [r for r in db.takes(out["id"]) if r[4] == "planned"][0][0]
    db.begin(clip)
    retry = db.fail(clip, "provider_error")["retry_take_id"]
    db.begin(retry)
    db.fail(retry, "provider_error")
    db.settle(out["id"], "takes_failed")
    assert db.film_row(fid) == ("paused", "takes_failed")
    q = rquote(db, a.admin, fid)
    assert q["resumed_from"] == out["id"]
    charged = {c["line"] + str(c["position"]): Decimal(str(c["charged_earlier"])) for c in q["carried"]}
    assert charged == {"keyframe0": Decimal(3), "clip0": Decimal(20), "narrationNone": Decimal(1)}, q["carried"]


def test_the_carried_files_are_locked_from_the_check_to_the_copy(db, a):
    """L3: between the carried check and the copies, no carried file can be soft-deleted: start_film_resume holds them FOR SHARE
    to its commit, so a delete waits (here: times out) instead of landing in the window."""
    fid, seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    kf = db.su("select result_asset_id from public.film_takes where segment_id = %s and kind = 'keyframe'", [seg["id"]])[0][0]
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "authenticated", "sub": a.admin})])
        c.execute("set local role authenticated")
        assert c.execute("select public.start_film_resume(%s::uuid, %s, %s)", [fid, q["quote_id"], db.key()]).fetchone()[0]["ok"]
        with psycopg.connect(db.dsn, autocommit=False) as d:
            d.execute("set local lock_timeout = '300ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                d.execute("update public.media_assets set deleted_at = now() where id = %s", [kf])
            d.rollback()
        c.rollback()


def test_a_rerun_of_a_film_whose_takes_did_not_all_complete_is_not_an_assembly_failure(db, a):
    fid, _seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    assert q["rerun"] is False
    assert err(lambda: rerun(db, a.admin, fid, q["quote_id"]))[:2] == ("NS409", "not_assembly_failure")
    draft = db.film(a)
    assert err(lambda: rerun(db, a.admin, draft, "fq-2-" + "0" * 32))[:2] == ("NS409", "not_assembly_failure")


def test_two_reruns_at_once_make_one_segment_and_one_hold_and_a_double_rerun_replays(db, a):
    fid, _seg = assembly_failed(db, a)
    q = rquote(db, a.admin, fid)
    keys = [db.key() for _ in range(4)]
    gate, seen, lock = threading.Barrier(4), [], threading.Lock()

    def go(key):
        gate.wait()
        try:
            r = ("ok", rerun(db, a.admin, fid, q["quote_id"], key)["id"])
        except psycopg.Error as e:
            r = (e.sqlstate, str(e).splitlines()[0])
        with lock:
            seen.append(r)

    threads = [threading.Thread(target=go, args=(k,)) for k in keys]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    oks = [r for r in seen if r[0] == "ok"]
    assert len(oks) == 1 and sorted(r for r in seen if r[0] != "ok") == [("NS409", "film_not_resumable")] * 3, seen
    assert len([h for h in db.holds(a.org) if h[2] == "open"]) == 1
    sid = oks[0][1]
    key = db.su("select idempotency_key from public.film_segments where id = %s", [sid])[0][0]
    again = rerun(db, a.admin, fid, q["quote_id"], key)
    assert again["replayed"] is True and again["id"] == sid
    assert len([h for h in db.holds(a.org) if h[2] == "open"]) == 1


def test_a_rerun_racing_a_resume_gives_one_segment(db, a):
    fid, _seg = assembly_failed(db, a)
    q = rquote(db, a.admin, fid)
    gate, seen, lock = threading.Barrier(2), [], threading.Lock()

    def go(call, key):
        gate.wait()
        try:
            r = ("ok", call(db, a.admin, fid, q["quote_id"], key)["ok"])
        except psycopg.Error as e:
            r = (e.sqlstate, str(e).splitlines()[0])
        with lock:
            seen.append(r)

    threads = [threading.Thread(target=go, args=(c, db.key())) for c in (rerun, resume)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(seen) == sorted([("ok", True), ("NS409", "film_not_resumable")]), seen
    assert db.su("select count(*) from public.film_segments where film_id = %s and purpose = 'resume'", [fid])[0][0] == 1


def test_a_rerun_of_another_organizations_film_reads_as_a_missing_one(db, a, b):
    fid, _seg = assembly_failed(db, a)
    qid = rquote(db, a.admin, fid)["quote_id"]
    for who in (b.owner, b.admin, b.editor, b.viewer):
        assert err(lambda: rerun(db, who, fid, qid)) == err(lambda: rerun(db, who, str(uuid.uuid4()), qid)) == \
            ("P0002", "not_found", "")
    for who in (a.editor, a.viewer):
        assert err(lambda: rerun(db, who, fid, qid))[:2] == ("42501", "forbidden")


@pytest.mark.parametrize("when", ["before_the_quote", "after_the_quote"])
def test_a_rerun_after_a_takes_result_was_deleted_is_refused_film_changed(db, a, when):
    fid, seg = assembly_failed(db, a)
    clip = db.su("select result_asset_id from public.film_takes where segment_id = %s and kind = 'clip' and status = 'completed' "
                 "limit 1", [seg["id"]])[0][0]
    if when == "before_the_quote":
        db.su("update public.media_assets set deleted_at = now() where id = %s", [clip])
        q = rquote(db, a.admin, fid)
        assert q["rerun"] is False  # the clip is a line again: resuming makes it, re-running never does
        assert err(lambda: rerun(db, a.admin, fid, q["quote_id"]))[:2] == ("NS409", "film_changed")
    else:
        q = rquote(db, a.admin, fid)
        db.su("update public.media_assets set deleted_at = now() where id = %s", [clip])
        for call in (rerun, resume):
            assert err(lambda: call(db, a.admin, fid, q["quote_id"]))[:2] == ("NS409", "film_changed")
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1
    assert [h for h in db.holds(a.org) if h[2] == "open"] == []


def test_a_carried_take_that_changed_since_the_quote_is_refused_film_changed(db, a):
    fid, seg = paused(db, a)
    q = rquote(db, a.admin, fid)
    kf = db.su("select id from public.film_takes where segment_id = %s and kind = 'keyframe'", [seg["id"]])[0][0]
    other = db.asset(a.org)
    db.su("update public.film_takes set result_asset_id = %s where id = %s", [other, kf])  # what the quote carried moved
    assert err(lambda: resume(db, a.admin, fid, q["quote_id"]))[:2] == ("NS409", "film_changed")


# ── who may spend: is_org_spender (the owner's decision, 22 Nov) ─────────────

def spender(db, uid, org, role):
    """is_org_spender as the database asks it inside a spend call: under the caller's own claims (it is no API role's to call)."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)",
                  [json.dumps({"role": "authenticated", **({"sub": uid} if uid else {})})])
        out = c.execute("select public.is_org_spender(%s::uuid, %s)", [org, role]).fetchone()[0]
        c.rollback()
        return out


def staff_user(db, role):
    u = str(uuid.uuid4())
    email = f"spender-{role}-{u[:8]}@money.lab"
    db.su("insert into auth.users (id, email) values (%s, %s)", [u, email])
    db.su("insert into public.app_members (user_id, email, role) values (%s, %s, %s)", [u, email, role])
    return u


def test_is_org_spender_is_a_seat_of_the_role_in_org_members_or_platform_staff_in_the_exempt_organization_only(db, a, b):
    exempt = "00000000-0000-0000-0000-000000000001"
    staff = staff_user(db, "admin")
    assert spender(db, a.owner, a.org, "admin") is True and spender(db, a.admin, a.org, "admin") is True
    assert spender(db, a.editor, a.org, "admin") is False and spender(db, a.editor, a.org, "editor") is True
    assert spender(db, a.viewer, a.org, "editor") is False
    assert spender(db, b.admin, a.org, "admin") is False          # another organization's admin
    assert spender(db, staff, a.org, "admin") is False            # platform staff with no seat: reads, never spends
    assert spender(db, staff, exempt, "admin") is True            # the exempt organization's credits are the platform's own
    assert spender(db, a.admin, exempt, "admin") is False
    assert spender(db, None, a.org, "admin") is False and spender(db, a.admin, None, "admin") is False
    assert spender(db, a.admin, a.org, "superuser") is False      # an unknown role is never a seat


# ── another organization, anon, the service role ─────────────────────────────

def test_another_organizations_film_reads_as_a_missing_one(db, a, b):
    fid, _seg = paused(db, a)
    qid = rquote(db, a.admin, fid)["quote_id"]
    missing = str(uuid.uuid4())
    for who in (b.owner, b.admin, b.editor, b.viewer):
        assert err(lambda: rquote(db, who, fid, 1)) == err(lambda: rquote(db, who, missing, 1)) == ("P0002", "not_found", "")
        assert err(lambda: resume(db, who, fid, qid)) == err(lambda: resume(db, who, missing, qid)) == ("P0002", "not_found", "")
        assert err(lambda: db.one("authenticated", who, "select public.archive_film(%s::uuid)", [fid]))[:2] == ("P0002", "not_found")
    assert db.film_row(fid)[0] == "paused"


@pytest.mark.parametrize("role", ["anon", "service_role"])
def test_neither_the_anon_key_nor_the_service_role_reaches_a_resume(db, a, role):
    fid, _seg = paused(db, a)
    for q, p in (("select public.quote_film_resume(%s::uuid, 2)", [fid]),
                 ("select public.start_film_resume(%s::uuid, %s, 'service-key-01')", [fid, "fq-2-" + "0" * 32]),
                 ("select public.film_resume_price(f) from public.films f where id = %s", [fid]),
                 ("select public.film_resume_precheck(f, null) from public.films f where id = %s", [fid]),
                 ("select public.film_resume_done(t) from public.film_takes t where film_id = %s", [fid]),
                 ("select public.rerun_film_assembly(%s::uuid, 'fq-2-x', 'service-key-02')", [fid]),
                 ("select public.is_org_spender(%s::uuid, 'admin')", [a.org]),
                 ("select public.film_assembly_retryable('render_failed')", [])):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, None, q, p)
        assert e.value.sqlstate == "42501", q


def test_a_signed_in_caller_reaches_only_the_two_calls_and_needs_a_user(db, a):
    fid, _seg = paused(db, a)
    for q in ("select public.quote_film_resume(%s::uuid, 2)", "select public.start_film_resume(%s::uuid, 'fq-2-x', 'nobody-key-01')"):
        with pytest.raises(psycopg.Error) as e:
            db.act("authenticated", None, q, [fid])
        assert e.value.sqlstate == "42501", q
    for q in ("select public.film_resume_price(f) from public.films f where id = %s",
              "select public.film_resume_precheck(f, null) from public.films f where id = %s"):
        with pytest.raises(psycopg.Error) as e:
            db.act("authenticated", a.owner, q, [fid])
        assert e.value.sqlstate == "42501" and "permission denied" in str(e.value), q
    with pytest.raises(psycopg.Error) as e:
        db.act("authenticated", a.owner, "select carried_from_take_id from public.film_takes")
    assert e.value.sqlstate == "42501"
    assert db.one("authenticated", a.viewer, "select count(resumed_from) from public.film_segments where film_id = %s", [fid]) == 0


# ── the worker's id ──────────────────────────────────────────────────────────

def test_a_members_film_json_never_carries_the_worker_id_old_rows_included(db, a):
    fid, seg = paused(db, a, worker=HOST)
    claimed = db.su("select detail from public.film_events where film_id = %s and event = 'segment_claimed'", [fid])
    assert claimed == [({"segment_id": seg["id"], "worker_ref": hashlib.md5(HOST.encode()).hexdigest()[:12], "attempt": 1,
                         "status": "running"},)]
    # A row written before 0215 (0171's and 0198's shape), as the owner's database still holds them.
    db.su("insert into public.film_events (film_id, org_id, actor_role, event, detail) "
          "values (%s, %s, 'service', 'segment_claimed', %s::jsonb)",
          [fid, a.org, json.dumps({"segment_id": seg["id"], "worker": HOST, "attempt": 1, "status": "running"})])
    for who in (a.viewer, a.editor, a.owner):
        shown = db.one("authenticated", who, "select public.film_json(%s::uuid)", [fid])
        assert HOST not in json.dumps(shown), who
        assert all("worker" not in (e["detail"] or {}) for e in shown["events"])
    # The calls that answer with the film (archive_film) carry none either.
    assert HOST not in json.dumps(db.one("authenticated", a.editor, "select public.archive_film(%s::uuid)", [fid]))
    # A member never reads the segment's worker id directly (0171's column grant).
    with pytest.raises(psycopg.Error):
        db.act("authenticated", a.viewer, "select worker_id from public.film_segments where film_id = %s", [fid])


def test_a_start_replayed_after_the_claim_answers_without_the_worker_id(db, a):
    fid = db.film(a)
    q = db.quote(a.editor, fid)
    key = db.key()
    first = db.start(a.admin, fid, q["quote_id"], key)
    db.claim(HOST)
    again = db.start(a.admin, fid, q["quote_id"], key)
    assert again["replayed"] is True and again["id"] == first["id"] and "worker_id" not in again
    assert HOST not in json.dumps(again)


def test_the_creative_jobs_claimed_event_records_a_reference_not_the_worker_id(db, a):
    job = db.one("authenticated", a.admin, "select public.create_creative_job(%s, 't2i', 'img-key', %s::jsonb, 'exact', %s)",
                 [a.org, json.dumps({"prompt": "a lighthouse"}), db.key()])
    jid = job["job"]["id"] if "job" in job else job["id"]
    assert db.svc("select count(*) from public.claim_creative_job(%s)", [HOST]) == 1
    detail = db.su("select detail from public.creative_job_events where job_id = %s and event = 'claimed'", [jid])
    assert detail == [({"worker_ref": hashlib.md5(HOST.encode()).hexdigest()[:12]},)]
    events = db.one("authenticated", a.viewer, "select coalesce(jsonb_agg(detail), '[]'::jsonb) from public.creative_job_events "
                                               "where job_id = %s", [jid])
    assert HOST not in json.dumps(events)
    # What the app reads of a job (lib/creative/operations.ts JOB_COLUMNS) names no worker.
    cols = ("id,org_id,kind,capability,mode,requested_model,routed_model,fallback_from,fallback_reason,params,status,payer,"
            "quoted_credits,charged_credits,error_code,error,result,result_asset_ids,expires_at,created_at,updated_at,started_at,finished_at")
    row = db.one("authenticated", a.viewer, f"select to_jsonb(x) from (select {cols} from public.creative_jobs where id = %s) x", [jid])
    assert HOST not in json.dumps(row)
    # 0225 (BR-0036-01) closed what was measured here: members hold named columns of creative_jobs, not worker_id, so a direct
    # select of it is refused rather than answered.
    assert err(lambda: db.one("authenticated", a.viewer, "select worker_id from public.creative_jobs where id = %s", [jid]))[0] \
        == "42501"
    db.svc("select public.finish_creative_job(%s, %s, false, p_error_code => 'provider_error', p_error => 'lab: never sent')",
           [jid, HOST])


# ── the migration ─────────────────────────────────────────────────────────────

SNAPSHOT = """
select jsonb_build_object(
  'functions', (select jsonb_agg(p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(array_to_string(p.proacl, ','), '')
                                 order by p.oid::regprocedure::text)
                  from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and (p.proname like 'film\\_%%' or p.proname in ('archive_film', 'start_film', 'quote_film_resume', 'start_film_resume',
                                                                   'claim_creative_job'))),
  'constraints', (select jsonb_agg(conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) order by 1)
                    from pg_constraint where conrelid in ('public.film_segments'::regclass, 'public.film_takes'::regclass,
                                                          'public.film_quotes'::regclass)),
  'columns', (select jsonb_agg(table_name || '.' || column_name || ' ' || data_type || ' ' || coalesce(column_default, '')
                               order by table_name, column_name)
                from information_schema.columns where table_schema = 'public'
                 and table_name in ('film_segments', 'film_takes', 'film_quotes')),
  'column_grants', (select jsonb_agg(grantee || ' ' || table_name || '.' || column_name || ' ' || privilege_type
                                     order by grantee, table_name, column_name, privilege_type)
                      from information_schema.column_privileges where table_schema = 'public'
                       and table_name in ('film_segments', 'film_takes', 'film_quotes')),
  'rows', (select jsonb_build_array((select count(*) from public.film_segments), (select count(*) from public.film_takes),
                                    (select count(*) from public.film_quotes),
                                    (select md5(string_agg(to_jsonb(s)::text, ',' order by id)) from public.film_segments s))))
"""


def md5_of(c, sig):
    return c.execute("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()[0]


def test_a_replay_changes_nothing(db, a):
    fid, _seg = paused(db, a)
    resumed(db, a, fid)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0244(c)  # 0244 replaces 0215's two film starts, which 0215's guard and rollback refuse: off first, in this rolled-back transaction
        before = c.execute(SNAPSHOT).fetchone()[0]
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute(SNAPSHOT).fetchone()[0] == before
        c.rollback()


@pytest.mark.parametrize("tamper,message", [
    ("create or replace function public.archive_film(p_film uuid) returns jsonb language sql "
     "security definer set search_path = public, pg_temp as $$ select '{}'::jsonb $$",
     "archive_film(uuid) with a body that is neither 0166's nor 0215's"),
    ("create or replace function public.start_film_resume(p_film uuid, p_quote_id text, p_idempotency_key text) returns jsonb "
     "language sql security definer set search_path = public, pg_temp as $$ select '{}'::jsonb $$",
     "start_film_resume(uuid, text, text) with a body that is not this file's"),
    ("alter table public.film_segments drop constraint film_segments_state_check; "
     "alter table public.film_segments add constraint film_segments_state_check check (purpose in ('initial', 'resume', 'free'))",
     "film_segments_state_check that is not 0171's or this file's"),
    ("alter table public.film_takes drop column carried_from_take_id cascade; "
     "alter table public.film_takes add column carried_from_take_id text",
     "public.film_takes.carried_from_take_id that is not this file's"),
])
def test_the_drift_guard_refuses_a_body_a_check_or_a_column_that_is_not_its_own(db, tamper, message):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0244(c)  # 0244 replaces 0215's two film starts, which 0215's guard and rollback refuse: off first, in this rolled-back transaction
        c.execute(tamper)
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert message in str(e.value), str(e.value)
        c.rollback()


def _rollback_text():
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_the_rollback_refuses_while_a_resume_is_open_then_puts_the_earlier_bodies_back_and_0215_applies_again(db, a):
    fid, _seg = paused(db, a)
    out = resumed(db, a, fid)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0244(c)  # 0244 replaces 0215's two film starts, which 0215's guard and rollback refuse: off first, in this rolled-back transaction
        with pytest.raises(psycopg.Error) as e:
            c.execute(_rollback_text())
        assert "resume segment(s) are open" in str(e.value)
        c.rollback()
    finish(db, a, out["id"])
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0244(c)  # 0244 replaces 0215's two film starts, which 0215's guard and rollback refuse: off first, in this rolled-back transaction
        c.execute(_rollback_text())
        for sig, was in (("public.film_read(uuid)", "92f02292981b366f817bd37881e20a0f"),
                         ("public.archive_film(uuid)", "9ca4e793fd81bbd4a0aecdebd59d6dc6"),
                         ("public.start_film(uuid, text, text)", "7971355d754165affaf3e08904b4b078"),
                         ("public.film_claim_segment(text, interval)", "40db385bb4e3893e1085ee38dcd6f49b"),
                         ("public.claim_creative_job(text, interval)", "3ca4da96aabe145b34a0275ed4d1c841"),
                         ("public.film_settle_locked(uuid, uuid, text)", "7caa68e2b6698c81e34c4f965950adf9"),
                         ("public.quote_film(uuid, integer)", "99d01240ed2df7fb002f674df8891608")):
            assert md5_of(c, sig) == was, sig
        assert c.execute("select to_regprocedure('public.start_film_resume(uuid, text, text)')").fetchone()[0] is None
        # The record stays: the resumed segment, its carried takes, and the check that allows them (a resume row exists).
        assert c.execute("select count(*) from public.film_takes where carried_from_take_id is not null").fetchone()[0] >= 3
        assert c.execute("select pg_get_constraintdef(oid) like '%%''resume''%%' from pg_constraint "
                         "where conname = 'film_segments_state_check'").fetchone()[0] is True
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert md5_of(c, "public.archive_film(uuid)") != "9ca4e793fd81bbd4a0aecdebd59d6dc6"
        c.rollback()
    assert db.film_row(fid) == ("ready", None)


def test_the_rollback_puts_0171s_state_check_back_only_when_no_segment_ever_resumed(db, a):
    """0171's replay (another lab's) compares 0171's own check: with no resume row it is back exactly (the money lab's replay test
    pins the text); with one, the superset stays, since 0171's check would refuse that row."""
    fid, _seg = paused(db, a)
    db.cancel(resumed(db, a, fid)["id"])  # settled: the rollback refuses an open resume
    state = "select pg_get_constraintdef(oid) from pg_constraint where conname = 'film_segments_state_check'"
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0215(c)
        assert "'resume'" in c.execute(state).fetchone()[0]
        c.rollback()
    with psycopg.connect(db.dsn, autocommit=False) as c:
        # The same database as if nobody had resumed (inside this transaction only).
        c.execute("delete from public.film_quotes where purpose = 'resume'")
        c.execute("update public.film_segments set purpose = 'initial', resumed_from = null where purpose = 'resume'")
        sec_db.take_off_0215(c)
        d = c.execute(state).fetchone()[0]
        assert "'resume'" not in d and "'initial'" in d
        c.rollback()


def test_sec_dbs_take_off_and_put_back_chain_goes_through_0215(db):
    """Other labs roll back or replay 0198, 0192, 0187 and 0171: each take-off must take 0215 off first (their rollbacks refuse its
    bodies), and the matching put-back must put it back."""
    for off, back in ((sec_db.take_off_0198, sec_db.put_back_0198), (sec_db.take_off_0192, sec_db.put_back_0192),
                      (sec_db.take_off_0187, sec_db.put_back_0187)):
        with psycopg.connect(db.dsn, autocommit=False) as c:
            off(c)
            assert not sec_db.has_0215(c) and not sec_db.has_0198(c), off.__name__
            back(c)
            assert sec_db.has_0215(c) and sec_db.has_0198(c), back.__name__
            assert md5_of(c, "public.archive_film(uuid)") != "9ca4e793fd81bbd4a0aecdebd59d6dc6"
            c.rollback()
