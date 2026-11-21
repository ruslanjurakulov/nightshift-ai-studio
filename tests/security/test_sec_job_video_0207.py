"""Migration 0207 (BR-LIVE-05): a job's video id names the job's OWN long video.

What would break without it (0189's render_job_video_id matched channel + slug only and preferred an uploaded row):
  * a run's Short, which shares the slug and is uploaded after the long video, is answered as the job's video;
  * a later run of the same topic (same slug, modules/run_slug.py) is answered with the EARLIER run's upload;
  * a repaired cut of the same slug, re-held "now", is answered instead of the run's own held row;
  * a job with no end yet is answered with whatever the slug matches (a guess, rule 5).
Also pinned: the 2-minute tail and no further, a held row a person let upload later is still the job's, the drift guard refuses
a body that is neither 0189's nor 0207's, and the rollback puts 0189's body back.

Answers are read through both doors a customer uses (api_get_job, oauth_get_job -> MCP get_job_status). Runs in the scratch
database of test_sec_mcp_oauth.py, on test_sec_video_safety's helpers (as test_sec_job_video_0189.py does). CI-only on Windows.
"""

from __future__ import annotations

from pathlib import Path

from sec_db import as_superuser
from test_sec_job_video_0189 import answers
from test_sec_mcp_oauth import connect, db  # noqa: F401  (db is a fixture)
from test_sec_video_safety import CHAN, conn, paid_job  # noqa: F401  (conn is a fixture)

REPO = Path(__file__).resolve().parents[2]
MIGRATION = REPO / "supabase" / "migrations" / "0207_render_job_video_id_own_run.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0207_render_job_video_id_own_run.sql"
FN = "public.render_job_video_id(public.render_jobs)"
MD5_0189, MD5_0207 = "09646e55258e153d277f40e7bf03f1c3", "6d5da2fcd4047b75223bd9ee82bb3299"
SLUG = "the-lost-colony"


def ran(su, conn, *, started="now() - interval '30 minutes'", finished="now() - interval '5 minutes'"):
    """A job that ran (and recorded its slug) between `started` and `finished`; now() is fixed for the whole transaction."""
    job = paid_job(conn, su)
    su.run(f"update public.render_jobs set started_at = {started}, finished_at = {finished}, result_slug = %s where id = %s",
           [SLUG, job])
    return job


def uploaded(su, vid, at, **cols):
    row = {"video_id": vid, "channel_id": CHAN, "slug": SLUG, "privacy": "private", "publish_state": "uploaded", **cols}
    names = ", ".join([*row, "published_at"])
    su.run(f"insert into public.videos ({names}) values ({', '.join(['%s'] * len(row))}, ({at})::text)", list(row.values()))


def held(su, vid, at, state="held"):
    su.run(f"insert into public.videos (video_id, channel_id, slug, publish_state, held_at) values (%s, %s, %s, %s, {at})",
           [vid, CHAN, SLUG, state])


def md5(su):
    return su.value("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = %s::regprocedure", [FN])


def test_the_job_names_its_long_video_not_its_short_uploaded_after_it(db, conn):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.videos where channel_id = %s", [CHAN])
        job = ran(su, conn)
        uploaded(su, "yt-long0001", "now() - interval '12 minutes'")
        # main.py _publish_short: the Short of the same run, same slug, uploaded later (the newest uploaded row).
        uploaded(su, "yt-short001", "now() - interval '8 minutes'", video_format="short", parent_video_id="yt-long0001")
        assert answers(conn, job, token) == ("yt-long0001", "yt-long0001")


def test_a_second_run_of_the_same_topic_never_names_the_first_runs_upload(db, conn):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.videos where channel_id = %s", [CHAN])
        uploaded(su, "yt-first-run", "now() - interval '2 days'")         # the earlier run of this topic, uploaded
        job = ran(su, conn)
        assert answers(conn, job, token) == (None, None)                   # this run's row not readable yet: unknown, not the old one
        held(su, "run-second", "now() - interval '10 minutes'")            # this run, held for review
        assert answers(conn, job, token) == ("run-second", "run-second")


def test_a_repaired_cut_of_the_same_slug_rehold_now_is_not_the_jobs_video(db, conn):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.videos where channel_id = %s", [CHAN])
        job = ran(su, conn)
        held(su, "run-mine", "now() - interval '20 minutes'")
        held(su, "run-repaired", "now() - interval '6 minutes'", state="repaired_awaiting_review")
        assert answers(conn, job, token) == ("run-mine", "run-mine")


def test_the_window_has_a_two_minute_tail_and_no_more(db, conn):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.videos where channel_id = %s", [CHAN])
        job = ran(su, conn, finished="now() - interval '10 minutes'")
        uploaded(su, "yt-too-late", "now() - interval '7 minutes'")       # 3 minutes after the job ended
        assert answers(conn, job, token) == (None, None)
        uploaded(su, "yt-in-tail", "now() - interval '9 minutes'")        # 1 minute after: clock skew, still this run
        assert answers(conn, job, token) == ("yt-in-tail", "yt-in-tail")


def test_a_held_row_a_person_let_upload_later_is_still_the_jobs(db, conn):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.videos where channel_id = %s", [CHAN])
        job = ran(su, conn, started="now() - interval '3 days'", finished="now() - interval '3 days' + interval '40 minutes'")
        # held_video.promote re-keys the run's held row on upload: held_at stays, published_at is the (later) upload.
        su.run("insert into public.videos (video_id, channel_id, slug, privacy, publish_state, held_at, published_at) "
               "values ('yt-promoted', %s, %s, 'private', 'uploaded', now() - interval '3 days' + interval '20 minutes', "
               "(now() - interval '1 day')::text)", [CHAN, SLUG])
        assert answers(conn, job, token) == ("yt-promoted", "yt-promoted")


def test_a_job_with_no_end_names_no_video(db, conn):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.videos where channel_id = %s", [CHAN])
        job = ran(su, conn, finished="null")
        held(su, "run-mine", "now() - interval '10 minutes'")
        assert answers(conn, job, token) == (None, None)


def test_replay_is_a_no_op_and_the_rollback_puts_0189_back(conn):
    text, rollback = MIGRATION.read_text(encoding="utf-8"), ROLLBACK.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        assert md5(su) == MD5_0207
        acl = su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [FN])
        assert su.run(text).ok
        assert md5(su) == MD5_0207
        assert su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [FN]) == acl
        assert su.run("\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))).ok
        assert md5(su) == MD5_0189
        assert su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [FN]) == acl
        assert su.run(text).ok                                              # and 0207 applies again on 0189's body
        assert md5(su) == MD5_0207


def test_the_drift_guards_refuse_a_body_they_do_not_know(conn):
    text, rollback = MIGRATION.read_text(encoding="utf-8"), ROLLBACK.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        su.run("create or replace function public.render_job_video_id(j public.render_jobs) returns text "
               "language sql stable security definer set search_path = public, pg_temp as $$ select null::text $$")
        out = su.run(text)
        assert not out.ok and "neither 0189's nor 0207's" in out.error, out
        out = su.run("\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;")))
        assert not out.ok and "is not 0207's body" in out.error, out
