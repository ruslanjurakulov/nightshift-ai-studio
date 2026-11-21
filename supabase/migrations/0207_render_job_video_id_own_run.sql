-- 0207_render_job_video_id_own_run.sql — a job's video id names the job's OWN long video, never its Short or an earlier run's.
--
-- EVIDENCE (docs/security/LEDGER.md BR-LIVE-05): render_job_video_id (0189) matches videos on channel + render_jobs.result_slug only
--   and prefers an uploaded row. A slug is per channel and topic (modules/run_slug.py), so a second run of the same topic reuses it
--   and its job answered the FIRST run's upload. A run's Short shares the slug and is uploaded after the long video (main.py
--   _publish_short: video_format 'short', parent_video_id set), so with Shorts on, the job could answer the Short. api_get_job and
--   oauth_get_job (0189) return it, and the MCP tool get_job_status shows it to a customer.
-- DIAGNOSIS: a slug identifies a topic, not a run. The Studio's reader (command-center/lib/server/run-video.ts) already tells this
--   run's row apart: long, no parent, not a repaired cut, held or uploaded inside the run's window. This function did none of it.
--
-- CHANGE (one function body replaced, same signature, language, volatility, security definer, search_path and grants as 0189):
--   render_job_video_id(job) additionally requires
--     v.video_format = 'long' and v.parent_video_id is null       not the run's Short, not a repurpose clip (0080);
--     publish_state is not 'repaired_awaiting_review'             a repaired cut of an older video is re-held "now" (0016);
--     held_at or published_at inside started_at .. finished_at + 2 minutes   not an earlier (or later) run of the same slug.
--   A job without started_at or finished_at answers NULL (the worker records the slug just before it ends the job; for that moment,
--   and for a job a dead worker never finished, the answer is "not known yet", never a guess).
-- NOT CHANGED: api_get_job, oauth_get_job, api_list_videos, who may see a job or a video, any price, hold or publish rule.
--
-- WHY EITHER TIME, NOT ONLY coalesce(published_at, held_at): a run held for review keeps its held_at when a person later lets it
--   upload (held_video.promote re-keys the same row and sets published_at then). Its published_at is then after the job ended, but
--   the video is still this job's; its held_at is inside the window. An earlier run's row has both times before this job started.
-- WHY A 2-MINUTE TAIL: finished_at is written by the worker's clock (tools/queue_worker.py _now()), published_at by the run's
--   (main.py utcnow) and held_at by the held-row writer's; the row is written before the job ends, so the tail only absorbs clock
--   skew between them. It is the Studio's TAIL_MS (app/api/agent/runs/[id]/route.ts), so both readers name the same video. It
--   cannot reach the next run of the slug: that run spends far longer than 2 minutes on research, script, voice and render before
--   it holds or uploads anything. No tail before started_at: a run writes its video many minutes after it starts.
--
-- NUMBER. 0207, reserved by Atlas. Needs 0189 (render_job_video_id, video_listed_at), 0003 (video_format, parent_video_id), 0016.
-- REPLAY. Replays onto itself. Re-running 0189 after it refuses (0189's guard reads this body as drift): roll 0207 back first.
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--    where oid = 'public.render_job_video_id(public.render_jobs)'::regprocedure;
--   expected BEFORE 09646e55258e153d277f40e7bf03f1c3 (0189); AFTER 6d5da2fcd4047b75223bd9ee82bb3299 (this file).
-- Undo: docs/sql/rollback_0207_render_job_video_id_own_run.sql (owner-applied).

-- APPLY AS ONE TRANSACTION.
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.render_job_video_id(public.render_jobs)') is null
     or to_regprocedure('public.video_listed_at(text, timestamp with time zone)') is null then
    raise exception '0207 needs 0189 (render_job_video_id, video_listed_at): apply 0189 first';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'videos'
         and column_name in ('video_format', 'parent_video_id', 'publish_state', 'held_at')) <> 4 then
    raise exception '0207 needs videos.video_format, parent_video_id (0003), publish_state and held_at (0016): apply them first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.render_job_video_id(public.render_jobs)');
  if h is null or h <> all (array['09646e55258e153d277f40e7bf03f1c3', '6d5da2fcd4047b75223bd9ee82bb3299']) then
    raise exception '0207 found public.render_job_video_id(public.render_jobs) with a body that is neither 0189''s nor 0207''s (md5 %): read the live body first', h;
  end if;
end $$;

-- The video row a job made: same channel, the slug the worker recorded, the run's own long video (not its Short, a clip or a
-- repaired cut), held or uploaded while the job ran; an uploaded row before a held one. NULL when the worker has not recorded a
-- slug or the job has no start or end yet (0207, BR-LIVE-05).
create or replace function public.render_job_video_id(j public.render_jobs) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select v.video_id from public.videos v
   where j.result_slug is not null and v.channel_id = j.channel_id and v.slug = j.result_slug
     and v.video_format = 'long' and v.parent_video_id is null
     and v.publish_state is distinct from 'repaired_awaiting_review'
     and j.started_at is not null and j.finished_at is not null
     and (v.held_at between j.started_at and j.finished_at + interval '2 minutes'
          or public.video_listed_at(v.published_at, null) between j.started_at and j.finished_at + interval '2 minutes')
   order by (v.published_at is not null) desc, public.video_listed_at(v.published_at, v.held_at) desc nulls last, v.video_id
   limit 1
$$;

revoke all on function public.render_job_video_id(public.render_jobs) from public, anon, authenticated, service_role;

-- Verify (both should read true):
-- select (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--          where oid = 'public.render_job_video_id(public.render_jobs)'::regprocedure) = '6d5da2fcd4047b75223bd9ee82bb3299' as own_run,
--        not has_function_privilege('anon', 'public.render_job_video_id(public.render_jobs)', 'EXECUTE') as helper_internal;
