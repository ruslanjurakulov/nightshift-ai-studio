-- 0189_job_video_and_list_order.sql — get_job_status names the video a job made, and list_videos lists newest first.
--
-- EVIDENCE (the live MCP connector, 2026-11-20, read-only calls): get_job_status answered no video id at all, and list_videos
--   answered five held runs (published_at NULL, review pending) in video_id order. api_list_videos (0042) sorts by
--   published_at desc nulls last, video_id: an upload is written with published_at (main.py, held_video.promote), a run held for
--   review is not (held_video.py), so every held run sorts after every upload, by its id. A video made through the MCP connector is
--   held for review, so "poll get_job_status, then list_videos to find the video" (the MCP server's own instructions) did not find it.
--
-- CHANGE (additive; three function bodies replaced with marked hunks; one column, one trigger, three functions added):
--   render_jobs.result_slug   the slug of the video the run made, written by the queue worker (service key) from the run's result file
--     when the run succeeded (tools/queue_worker.py). A browser's insert must leave it empty; it is written once (trigger).
--   render_job_video_id(job)  the video row of that slug in the job's channel (an uploaded row before a held one), or NULL.
--   video_listed_at(published_at, held_at)   the instant a video is listed by: its upload, else when it was held.
--   api_get_job and oauth_get_job (0111's bodies, one marked hunk each): answer 'video_id' (NULL until recorded, never a guess).
--   api_list_videos (0042's body, two marked hunks): ordered by video_listed_at desc nulls last, video_id.
-- NOT CHANGED: what a job, a video or a key may see (the same org filter), every price, hold and publish rule. Nothing publishes.
--
-- NUMBER. 0189, assigned by Atlas (renumbered at merge to the next free number). Needs 0017, 0042, 0093, 0111 and 0016 (held_at).
-- REPLAY. Replays onto itself. Re-running 0042 or 0111 after it silently restores the old bodies: apply 0189 again.
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where p.oid in ('public.api_list_videos(text, text, integer, integer, text)'::regprocedure,
--                    'public.api_get_job(text, bigint, text)'::regprocedure, 'public.oauth_get_job(text, bigint, text)'::regprocedure);
--   expected BEFORE 4803ede01cc912947476fa3ce1483d23 (0042), 78ae3cced2dd36788edb22bbddcedad5 (0111), f7cc9e39c1a3859e40e501677811f14d (0111);
--   AFTER 778e6a8aafe8d861be3bf3dead601790, 47f4ae660b9fc3ea43379ebe5bfd1ef3, 5375c98dadc5a68aa0ddf61a4c75f3bf (this file).
-- Undo: docs/sql/rollback_0189_job_video_and_list_order.sql (owner-applied). It keeps render_jobs.result_slug (a record).

-- APPLY AS ONE TRANSACTION.
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regclass('public.render_jobs') is null or to_regprocedure('public.oauth_get_job(text, bigint, text)') is null then
    raise exception '0189 needs the render queue and the MCP OAuth API: apply 0017, 0093 and 0111 first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'held_at') then
    raise exception '0189 needs videos.held_at: apply 0016 first';
  end if;
  for r in select * from (values
      ('public.api_list_videos(text, text, integer, integer, text)', '4803ede01cc912947476fa3ce1483d23', '778e6a8aafe8d861be3bf3dead601790', '0042'),
      ('public.api_get_job(text, bigint, text)', '78ae3cced2dd36788edb22bbddcedad5', '47f4ae660b9fc3ea43379ebe5bfd1ef3', '0111'),
      ('public.oauth_get_job(text, bigint, text)', 'f7cc9e39c1a3859e40e501677811f14d', '5375c98dadc5a68aa0ddf61a4c75f3bf', '0111')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0189 found % with a body that is neither %''s nor 0189''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  for r in select * from (values
      ('public.video_listed_at(text, timestamp with time zone)', '5e215de03ed696bfd64fbdb012def0bc'),
      ('public.render_job_video_id(public.render_jobs)', '09646e55258e153d277f40e7bf03f1c3'),
      ('public.render_jobs_result_slug_guard()', '1af4b331cdc9dd6c7c55c18b2814b449')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0189 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

alter table public.render_jobs add column if not exists result_slug text;
alter table public.render_jobs drop constraint if exists render_jobs_result_slug_check;
alter table public.render_jobs add constraint render_jobs_result_slug_check
  check (result_slug is null or result_slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$');
comment on column public.render_jobs.result_slug is
  'The slug of the video this run made, written once by the queue worker when the run succeeded (0189). NULL: not recorded.';

-- When a video was uploaded, or else when it was held: the instant list_videos sorts by. published_at is text (0001); a value
-- that is not an ISO timestamp reads as unknown (NULL), never as a guessed date, and the held time is used instead.
create or replace function public.video_listed_at(p_published_at text, p_held_at timestamptz) returns timestamptz
  language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_published_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$' then
    begin
      return p_published_at::timestamptz;
    exception when others then
      return p_held_at;
    end;
  end if;
  return p_held_at;
end
$$;

-- The video row a job made: same channel, the slug the worker recorded, an uploaded row before a held one. NULL when the worker
-- has not recorded a slug (a job still running, failed, or run by a worker older than this file).
create or replace function public.render_job_video_id(j public.render_jobs) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select v.video_id from public.videos v
   where j.result_slug is not null and v.channel_id = j.channel_id and v.slug = j.result_slug
   order by (v.published_at is not null) desc, public.video_listed_at(v.published_at, v.held_at) desc nulls last, v.video_id
   limit 1
$$;

-- Only the worker writes result_slug (the service key, which owns no browser path): a browser's insert must leave it empty, and it
-- is written once.
create or replace function public.render_jobs_result_slug_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.result_slug is not null then
    raise exception 'result_slug is written by the worker only' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.result_slug is not null and new.result_slug is distinct from old.result_slug then
    raise exception 'result_slug is written once' using errcode = '42501';
  end if;
  return new;
end
$$;

create or replace function public.api_list_videos(
  p_key_hash text, p_channel_id text default null, p_limit integer default 20, p_offset integer default 0,
  p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'videos.list', p_request_id);
  lim integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  off integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'videos', coalesce((select jsonb_agg(public.api_video_json(v) order by public.video_listed_at(v.published_at, v.held_at) desc nulls last, v.video_id)
                            from (select vv.* from public.videos vv
                                    join public.channels c on c.channel_id = vv.channel_id
                                   where c.org_id = (ctx ->> 'org_id')::uuid
                                     and (p_channel_id is null or vv.channel_id = p_channel_id)
                                   -- 0189: newest first by when the video was uploaded OR held, so a held run (no published_at) is
                                   -- not sorted by its id after every upload; a row with neither sorts last.
                                   order by public.video_listed_at(vv.published_at, vv.held_at) desc nulls last, vv.video_id
                                   limit lim offset off) v), '[]'::jsonb),
      'limit', lim, 'offset', off)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_get_job(p_key_hash text, p_job_id bigint, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'jobs.get', p_request_id);
  j   public.render_jobs;
  h   public.api_holds;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select jj.* into j from public.render_jobs jj join public.channels c on c.channel_id = jj.channel_id
     where jj.id = p_job_id and c.org_id = (ctx ->> 'org_id')::uuid;
    if j.id is null then
      return public.api_finish(ctx, public.api_err(404, 'job_not_found', 'No job with that id in this key''s organization.'));
    end if;
    select * into h from public.api_holds where ref = j.api_hold_ref;
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'id', j.id, 'channel_id', j.channel_id, 'status', j.status, 'params', j.params,
      -- 0189: the video this job made, once the worker recorded it (render_jobs.result_slug); null until then, never a guess.
      'video_id', public.render_job_video_id(j),
      'attempts', j.attempts, 'created_at', j.created_at, 'started_at', j.started_at,
      'finished_at', j.finished_at, 'error', public.render_job_public_error(j.status, j.error) -> 'error',
      'error_code', public.render_job_public_error(j.status, j.error) -> 'error_code',
      'charge', case when h.ref is null then null
                     else jsonb_build_object('status', h.status, 'held_cents', h.amount_cents,
                                             'captured_cents', h.captured_cents) end)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.oauth_get_job(p_token_hash text, p_job_id bigint, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_token_hash, 'oauth.jobs.get', p_request_id);
  j   public.render_jobs;
  cr  public.credit_reservations;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select jj.* into j from public.render_jobs jj join public.channels c on c.channel_id = jj.channel_id
     where jj.id = p_job_id and c.org_id = (ctx ->> 'org_id')::uuid;
    if j.id is null then
      return public.api_finish(ctx, public.api_err(404, 'job_not_found', 'No job with that id in this workspace.'));
    end if;
    select * into cr from public.credit_reservations where job_id = j.credit_ref;
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'id', j.id, 'channel_id', j.channel_id, 'status', j.status, 'params', j.params,
      -- 0189: the video this job made, once the worker recorded it (render_jobs.result_slug); null until then, never a guess.
      'video_id', public.render_job_video_id(j),
      'created_at', j.created_at, 'started_at', j.started_at, 'finished_at', j.finished_at, 'error', public.render_job_public_error(j.status, j.error) -> 'error',
      'error_code', public.render_job_public_error(j.status, j.error) -> 'error_code',
      'charge', case when cr.job_id is null then null
                     else jsonb_build_object('status', cr.status, 'held_credits', cr.amount, 'charged_credits', cr.captured) end)));
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

drop trigger if exists render_jobs_result_slug_guard on public.render_jobs;
create trigger render_jobs_result_slug_guard
  before insert or update on public.render_jobs
  for each row execute function public.render_jobs_result_slug_guard();

revoke all on function public.video_listed_at(text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.render_job_video_id(public.render_jobs) from public, anon, authenticated, service_role;
revoke all on function public.render_jobs_result_slug_guard() from public, anon, authenticated, service_role;
revoke all on function public.api_list_videos(text, text, integer, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.api_list_videos(text, text, integer, integer, text) to anon;
revoke all on function public.api_get_job(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_get_job(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.api_get_job(text, bigint, text) to anon;
grant execute on function public.oauth_get_job(text, bigint, text) to anon;

-- Verify (every column should read true):
-- select (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--          where oid = 'public.api_list_videos(text,text,integer,integer,text)'::regprocedure) = '778e6a8aafe8d861be3bf3dead601790' as list_order,
--        (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--          where oid = 'public.oauth_get_job(text,bigint,text)'::regprocedure) = '5375c98dadc5a68aa0ddf61a4c75f3bf' as job_names_video,
--        not has_function_privilege('anon', 'public.render_job_video_id(public.render_jobs)', 'EXECUTE') as helper_internal;
