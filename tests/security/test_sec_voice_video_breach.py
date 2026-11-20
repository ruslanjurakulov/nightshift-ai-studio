"""Breach on 0176 (voice to video): the money path attacked in the lab, past what test_sec_voice_video pins.

One hold per job (an idempotency key replayed with another recording, and two creates racing on one key), a crash between
'submitting' and 'submitted', a capture above the hold, a capture after the hold was released, and a hold that expired while
the job waited for the one render slot. Uses test_sec_voice_video's scratch database and fixtures (it commits).
"""
import json
import threading

import psycopg
import pytest

from test_sec_creative_media_inputs import claims, err, footprint, svc
from test_sec_video_tools import drain, media
from test_sec_voice_video import ORG_A, UA, db, vv  # noqa: F401  (db is the module fixture)


def _create(d, params, key, maxc=10000):
    return d.act("authenticated", UA, "select public.create_creative_job(%s,'voice_explainer','vx',%s::jsonb,'exact',%s,%s)",
                 [ORG_A, json.dumps(params), key, maxc])[0][0]


def _holds(d, jid):
    return d.su("select status, amount::float, coalesce(captured, 0)::float from public.credit_reservations where job_id=%s",
                ["cj:" + jid])


def test_an_idempotency_key_replayed_with_another_recording_is_refused_and_holds_nothing_more(db):
    drain(db)
    short = media(db, ORG_A, "audio", "audio/mpeg", 5)
    long_ = media(db, ORG_A, "audio", "audio/mpeg", 500)
    first = _create(db, vv(short), "breach-idem-1")["job"]
    before = footprint(db, ORG_A)
    # Same key, a longer recording: the replay must not be served the short job's price for the long recording.
    st, word, _ = err(lambda: _create(db, vv(long_), "breach-idem-1"))
    assert (st, word) == ("NS409", "idempotency_conflict")
    # Same key, same request: the same job, no second hold.
    again = _create(db, vv(short), "breach-idem-1")["job"]
    assert again["id"] == first["id"]
    assert footprint(db, ORG_A) == before


def test_two_creates_racing_on_one_key_make_one_job_and_one_hold(db):
    drain(db)
    rec = media(db, ORG_A, "audio", "audio/mpeg", 20)
    before = footprint(db, ORG_A)
    barrier, out, errs = threading.Barrier(2), [], []

    def go():
        try:
            with psycopg.connect(db.dsn, autocommit=False) as c:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", UA)])
                c.execute("set local role authenticated")
                barrier.wait()
                r = c.execute("select public.create_creative_job(%s,'voice_explainer','vx',%s::jsonb,'exact','breach-race-1',10000)",
                              [ORG_A, json.dumps(vv(rec))]).fetchone()[0]
                c.commit()
                out.append(r["job"]["id"])
        except psycopg.Error as e:
            errs.append(e.sqlstate)

    ts = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in ts]
    [t.join(30) for t in ts]
    after = footprint(db, ORG_A)
    assert after[0] == before[0] + 1, (out, errs)
    assert after[1][0] == before[1][0] + 1
    assert len(set(out)) == 1


def test_a_worker_that_dies_between_submitting_and_submitted_releases_the_hold_and_never_resubmits(db):
    drain(db)
    rec = media(db, ORG_A, "audio", "audio/mpeg", 30)
    before = footprint(db, ORG_A)
    j = _create(db, vv(rec), None)["job"]
    svc(db, "select public.claim_creative_job('w-dead')")
    svc(db, "select public.advance_creative_job(%s,'w-dead','submitting')", [j["id"]])
    # The worker is gone mid-render (the Scribe call may have been paid): age its heartbeat past the stale window.
    db.su("update public.creative_jobs set heartbeat_at = now() - interval '1 hour' where id=%s", [j["id"]])
    again = svc(db, "select id::text from public.claim_creative_job('w-next', interval '10 minutes')")
    assert not again or again[0][0] != j["id"], "a job that may have been sent was handed out for a second submit"
    row = db.su("select status, error_code, charged_credits::float from public.creative_jobs where id=%s", [j["id"]])[0]
    assert row == ("failed", "submit_interrupted", 0.0)
    assert _holds(db, j["id"])[0][0] == "released"
    assert footprint(db, ORG_A)[2] == before[2]


def test_a_capture_above_the_hold_is_refused(db):
    drain(db)
    rec = media(db, ORG_A, "audio", "audio/mpeg", 10)
    j = _create(db, vv(rec), None)["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','sync:00000000000000000000000000000171')", [j["id"]])
    st, _w, _d = err(lambda: svc(db, "select public.finish_creative_job(%s,'w1',true,%s::numeric,%s::jsonb,null,null)",
                                 [j["id"], float(j["quoted_credits"]) + 1, json.dumps({})]))
    assert st == "22023"
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_a_hold_that_expired_while_the_job_waited_for_the_render_slot_is_never_started(db):
    """A parked voice video (one render slot per process) can wait longer than the 3 h an unstarted hold lives. When the slot
    frees, start_credit_reservation must answer null, so the enforcing worker refuses hold_not_open before decode or Scribe."""
    drain(db)
    rec = media(db, ORG_A, "audio", "audio/mpeg", 10)
    j = _create(db, vv(rec), None)["job"]
    svc(db, "select public.claim_creative_job('w-park')")
    db.su("update public.credit_reservations set created_at = now() - interval '4 hours' where job_id=%s", ["cj:" + j["id"]])
    svc(db, "select public.expire_credit_reservations()")
    assert svc(db, "select public.start_credit_reservation(%s,%s)", ["cj:" + j["id"], ORG_A])[0][0] is None
    svc(db, "select public.finish_creative_job(%s,'w-park',false,null,null,'hold_not_open','x')", [j["id"]])
    assert db.su("select charged_credits::float from public.creative_jobs where id=%s", [j["id"]])[0][0] == 0.0

