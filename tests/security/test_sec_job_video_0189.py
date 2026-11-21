"""Migration 0189: get_job_status names the video a job made, and list_videos lists newest first.

Attacks and failure modes pinned here:
  * a browser cannot set render_jobs.result_slug (it would point a job at a video it did not make), and the worker writes it once;
  * a job names only a video of ITS OWN channel: a slug that exists in another organization's channel is never answered;
  * no slug recorded = NULL (never a guess from the newest video);
  * a held run (no published_at) is listed by when it was held, newest first, not by its id after every upload;
  * the three helpers are not callable by any API role.

Runs in the scratch database of test_sec_mcp_oauth.py, on test_sec_video_safety's helpers.
"""

from __future__ import annotations

import pytest

from sec_db import ANON, as_superuser, acting
from test_sec_mcp_oauth import KEY_A, connect, db, sha  # noqa: F401  (db is a fixture)
from test_sec_video_safety import CHAN, CUSTOMER, conn, kept, paid_job, queue  # noqa: F401  (conn is a fixture)


def answers(conn, job, token):
    with acting(conn, ANON) as s:
        a = s.value("select public.api_get_job(%s, %s, null)", [sha(KEY_A), job])
        o = s.value("select public.oauth_get_job(%s, %s, null)", [sha(token), job])
    return a["data"]["video_id"], o["data"]["video_id"]


def test_a_browser_cannot_set_the_slug_and_the_worker_writes_it_once(conn):
    with as_superuser(conn, commit=False) as su:
        with kept(conn, CUSTOMER) as s:
            out = queue(s, CHAN, {"duration": 30}, result_slug="someone-elses-video")
        assert not out.ok and out.sqlstate == "42501", out
        job = paid_job(conn, su)
        su.run("update public.render_jobs set result_slug = 'first-slug' where id = %s", [job])
        again = su.run("update public.render_jobs set result_slug = 'second-slug' where id = %s", [job])
        assert not again.ok and "written once" in again.error, again


def test_a_job_names_its_own_video_and_never_another_channels(db, conn):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        job = paid_job(conn, su)
        assert answers(conn, job, token) == (None, None)          # nothing recorded: NULL, not the newest video
        # Another channel (here the operator's own) holds a video of the same slug: never this job's answer.
        su.run("insert into public.videos (video_id, channel_id, slug, held_at, publish_state) "
               "values ('run-elsewhere', 'chan-op', 'the-lost-colony', now(), 'held')")
        # 0207: a job names only a video held or uploaded while it ran, so this job gets a start and an end around now().
        su.run("update public.render_jobs set result_slug = 'the-lost-colony', started_at = now() - interval '1 hour', "
               "finished_at = now() where id = %s", [job])
        assert answers(conn, job, token) == (None, None)
        su.run("insert into public.videos (video_id, channel_id, slug, held_at, publish_state) "
               "values ('run-mine', %s, 'the-lost-colony', now(), 'held')", [CHAN])
        assert answers(conn, job, token) == ("run-mine", "run-mine")
        # Once uploaded, the uploaded row is the answer.
        su.run("insert into public.videos (video_id, channel_id, slug, published_at, privacy, publish_state) "
               "values ('yt-abc123', %s, 'the-lost-colony', (now() - interval '10 minutes')::text, 'private', 'uploaded')", [CHAN])
        assert answers(conn, job, token) == ("yt-abc123", "yt-abc123")


def test_held_runs_are_listed_newest_first_not_by_id(conn):
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.videos where channel_id = %s", [CHAN])
        su.run("insert into public.videos (video_id, channel_id, slug, held_at, publish_state) values "
               "('run-aaa', %s, 'old-held', now() - interval '3 days', 'held'), "
               "('run-zzz', %s, 'new-held', now(), 'held')", [CHAN, CHAN])
        su.run("insert into public.videos (video_id, channel_id, slug, published_at, privacy, publish_state) values "
               "('yt-mid', %s, 'mid-upload', (now() - interval '1 day')::text, 'private', 'uploaded'), "
               "('yt-bad', %s, 'bad-date', 'not a date', 'private', 'uploaded')", [CHAN, CHAN])
        with acting(conn, ANON) as s:
            out = s.value("select public.api_list_videos(%s, %s, 20, 0, null)", [sha(KEY_A), CHAN])
        ids = [v["video_id"] if "video_id" in v else v["id"] for v in out["data"]["videos"]]
        # A text that is not a timestamp is unknown and sorts last, never as a guessed date.
        assert ids == ["run-zzz", "yt-mid", "run-aaa", "yt-bad"], ids


@pytest.mark.parametrize("fn", ["public.video_listed_at(text, timestamptz)", "public.render_job_video_id(public.render_jobs)",
                                "public.render_jobs_result_slug_guard()"])
@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
def test_the_helpers_are_internal(conn, fn, role):
    with as_superuser(conn, commit=False) as su:
        assert su.value("select has_function_privilege(%s, %s, 'EXECUTE')", [role, fn]) is False
