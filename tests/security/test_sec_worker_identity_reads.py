"""A worker's identity (its id: the host name and the process id by default, tools/*_worker.py) never reaches a member of an
organization, through a column or through an event's detail. Attacked in a real database.

  * BR-0036-01  0036 grants the whole creative_jobs table to members, so a viewer reads worker_id directly: the film worker's
                (film_take_job writes it on a take's job) and the credit worker's;
  * BR-0036-02  the rows 0036 / 0171 / 0198 wrote before 0215 still carry detail.worker in creative_job_events and film_events,
                both member-readable and append-only; 0215 changed what new rows record and what film_read hands out, not them;
  * BR-S-030    the same whole-table grant on eleven more worker-claimed tables;
  * BR-S-031    creative_jobs.provider_task_id, which 0171 withholds on film_takes, is readable on the same take's job.

Runs in the money lab's own scratch database (test_sec_films_money's fixtures, imported as they are), as 0215's tests do.
"""

from __future__ import annotations

import hashlib
import json

import psycopg
import pytest

import sec_db
from test_sec_films_money import Db, a, b, db, err, no_live_segment  # noqa: F401 — the money lab, as it is

HOST = "worker-host-secret-9c2e-4242"   # what a worker id defaults to: the host name and the pid
REF = hashlib.md5(HOST.encode()).hexdigest()[:12]
# What the app reads of a job (command-center/lib/creative/operations.ts JOB_COLUMNS), and 0037's creative_economics: still readable.
JOB_COLUMNS = ("id,org_id,kind,capability,mode,requested_model,routed_model,fallback_from,fallback_reason,params,status,payer,"
               "quoted_credits,charged_credits,error_code,error,result,result_asset_ids,expires_at,created_at,updated_at,started_at,"
               "finished_at")


def film_take_job(db, o):
    """A film take's creative job, claimed by the film worker as tools/film_worker.py runs it."""
    fid = db.film(o)
    seg = db.quoted_start(o, fid)
    assert db.claim(HOST)["id"] == seg["id"]
    tid = str(db.takes(seg["id"])[0][0])
    db.begin(tid, HOST)
    job = db.svc("select public.film_take_job(%s, %s)", [tid, HOST])
    assert job["ok"] is True
    # The precondition: there is a worker id to leak.
    assert db.su("select worker_id from public.creative_jobs where id = %s", [job["job_id"]]) == [(HOST,)]
    return fid, seg, job["job_id"]


def refused(db, who, q, p=None):
    with pytest.raises(psycopg.Error) as e:
        db.act("authenticated", who, q, p)
    return e.value.sqlstate


def replay_history_redaction(db):
    """The fix's history redaction (a migration marked BR-0036-02), replayed over rows seeded after the lab was built, as
    test_sec_breach_leaks replays 0088 over its seeded rows (0225)."""
    # 0235 replaces 0215's film_resume_precheck, and 0215's replay refuses its body: off for the replay, on again after.
    with psycopg.connect(db.dsn, autocommit=True) as c:
        sec_db.take_off_0235(c)
    for f in sec_db.migration_files():
        text = f.read_text(encoding="utf-8")
        if "BR-0036-02" in text:
            db.su(text)
    with psycopg.connect(db.dsn, autocommit=True) as c:
        sec_db.put_back_0235(c)
        assert sec_db.has_0235(c)


# ── BR-0036-01 ───────────────────────────────────────────────────────────────

def test_BR_0036_01_no_member_reads_a_creative_jobs_worker_id(db, a):
    _fid, _seg, jid = film_take_job(db, a)
    assert db.su("select has_table_privilege('authenticated', 'public.creative_jobs', 'SELECT')") == [(False,)], \
        "a table-level grant answers every column: a column revoke under it changes nothing"
    for who in (a.viewer, a.editor, a.admin, a.owner):
        assert refused(db, who, "select worker_id from public.creative_jobs where id = %s", [jid]) == "42501", who
        assert refused(db, who, "select * from public.creative_jobs where id = %s", [jid]) == "42501", who
        assert refused(db, who, "select to_jsonb(j) from public.creative_jobs j where id = %s", [jid]) == "42501", who


def test_what_the_app_reads_of_a_creative_job_stays_readable(db, a):
    """The control (passes before and after the fix): the column grant names every column the Command Center reads."""
    _fid, _seg, jid = film_take_job(db, a)
    row = db.one("authenticated", a.viewer, f"select to_jsonb(x) from (select {JOB_COLUMNS} from public.creative_jobs "
                                            "where id = %s) x", [jid])
    assert row["id"] == jid and HOST not in json.dumps(row)
    assert db.one("authenticated", a.viewer, "select count(*) from public.creative_jobs where org_id = %s", [a.org]) >= 1
    assert db.act("authenticated", a.viewer, "select count(*) from public.creative_economics") == [(0,)]  # platform-only view
    assert db.one("authenticated", a.viewer, "select count(*) from public.creative_jobs where id = %s and status = 'running'",
                  [jid]) == 1


# ── BR-0036-02 ───────────────────────────────────────────────────────────────

def test_BR_0036_02_rows_written_before_0215_carry_no_worker_id_for_a_member(db, a):
    fid, seg, jid = film_take_job(db, a)
    # As 0171's / 0198's film_claim_segment and 0036's / 0198's claim_creative_job wrote them (insert is allowed: append-only).
    db.su("insert into public.film_events (film_id, org_id, actor_role, event, detail) values (%s, %s, 'service', 'segment_claimed', "
          "%s::jsonb)", [fid, a.org, json.dumps({"segment_id": seg["id"], "worker": HOST, "attempt": 1, "status": "running"})])
    db.su("insert into public.creative_job_events (job_id, org_id, event, status, detail) values (%s, %s, 'claimed', 'running', "
          "%s::jsonb)", [jid, a.org, json.dumps({"worker": HOST})])
    for _ in range(2):  # a replay finds nothing more to do
        replay_history_redaction(db)
        for who in (a.viewer, a.editor, a.admin, a.owner):
            film = db.one("authenticated", who, "select coalesce(jsonb_agg(detail), '[]') from public.film_events where film_id = %s",
                          [fid])
            job = db.one("authenticated", who, "select coalesce(jsonb_agg(detail), '[]') from public.creative_job_events "
                                               "where job_id = %s", [jid])
            assert HOST not in json.dumps(film) and HOST not in json.dumps(job), who
    # The same reference 0215 writes on a new row, so an old and a new claim by one worker still read as one worker.
    assert db.su("select detail from public.creative_job_events where job_id = %s and event = 'claimed'", [jid]) \
        == [({"worker_ref": REF},)]
    assert {"segment_id": seg["id"], "worker_ref": REF, "attempt": 1, "status": "running"} in \
        [r[0] for r in db.su("select detail from public.film_events where film_id = %s and event = 'segment_claimed'", [fid])]
    # Both trails are append-only again.
    for table, trigger in (("film_events", "film_events_append_only"), ("creative_job_events", "creative_job_events_append_only")):
        assert db.su("select tgenabled from pg_trigger where tgname = %s and tgrelid = %s::regclass",
                     [trigger, "public." + table]) == [("O",)]
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.film_events set event = event where film_id = %s", [fid])
    assert e.value.sqlstate == "42501"
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.creative_job_events set event = event where job_id = %s", [jid])
    assert e.value.sqlstate == "42501"


# ── BR-S-030 / BR-S-031 ──────────────────────────────────────────────────────

WORKER_CLAIMED = [  # (table, column, migration that granted the whole table to members)
    ("render_jobs", "worker_id", "0019"), ("publish_requests", "worker_id", "0029"), ("download_requests", "worker_id", "0030"),
    ("media_uploads", "worker_id", "0038"), ("editor_exports", "worker_id", "0054"), ("repurpose_requests", "worker_id", "0080"),
    ("reply_drafts", "worker_id", "0081"), ("reply_posts", "worker_id", "0081"), ("brand_domain_checks", "worker_id", "0133"),
    ("brand_scans", "worker_id", "0133"), ("character_swap_jobs", "worker_id", "0137"),
]


@pytest.mark.parametrize("table,column,src", WORKER_CLAIMED, ids=[t for t, _c, _s in WORKER_CLAIMED])
@pytest.mark.xfail(strict=True, reason="BR-S-030 open")
def test_BR_S_030_no_member_may_select_a_worker_claimed_tables_worker_id(db, table, column, src):
    assert db.su("select has_column_privilege('authenticated', %s, %s, 'SELECT')", ["public." + table, column]) == [(False,)], \
        f"{table}.{column} is member-readable ({src}'s whole-table grant)"


def test_the_tables_that_already_withhold_a_worker_id_still_do(db):
    """The held side (passes today): a regression on any of them reopens the same leak."""
    for table, column in (("film_segments", "worker_id"), ("video_visibility_requests", "claimed_by"),
                          ("voice_clone_jobs", "worker_id"), ("notification_outbox", "claimed_by"),
                          ("email_deliveries", "claimed_by"), ("research_requests", "claimed_by")):
        assert db.su("select has_column_privilege('authenticated', %s, %s, 'SELECT')", ["public." + table, column]) == [(False,)], table


def test_BR_S_031_a_film_takes_provider_task_id_is_not_readable_on_its_creative_job(db, a):
    _fid, _seg, jid = film_take_job(db, a)
    assert refused(db, a.viewer, "select provider_task_id from public.creative_jobs where id = %s", [jid]) == "42501"
