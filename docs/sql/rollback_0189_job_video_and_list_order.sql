-- rollback_0189_job_video_and_list_order.sql — 0042's api_list_videos and 0111's api_get_job / oauth_get_job back, verbatim.
-- OWNER-APPLY. KEEPS render_jobs.result_slug and its values (a record of which run made which video); drops the guard trigger and
-- the two helpers. Refuses (changes nothing) if a body is not 0189's.
begin;
set local lock_timeout = '5s';
do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.api_list_videos(text, text, integer, integer, text)', '778e6a8aafe8d861be3bf3dead601790'),
      ('public.api_get_job(text, bigint, text)', '47f4ae660b9fc3ea43379ebe5bfd1ef3'),
      ('public.oauth_get_job(text, bigint, text)', '5375c98dadc5a68aa0ddf61a4c75f3bf')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0189: % is not 0189''s body (md5 %)', r.sig, h;
    end if;
  end loop;
end $$;

-- api_list_videos: 0042's body, verbatim.
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
      'videos', coalesce((select jsonb_agg(public.api_video_json(v) order by v.published_at desc nulls last, v.video_id)
                            from (select vv.* from public.videos vv
                                    join public.channels c on c.channel_id = vv.channel_id
                                   where c.org_id = (ctx ->> 'org_id')::uuid
                                     and (p_channel_id is null or vv.channel_id = p_channel_id)
                                   order by vv.published_at desc nulls last, vv.video_id
                                   limit lim offset off) v), '[]'::jsonb),
      'limit', lim, 'offset', off)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- api_get_job: 0111's body, verbatim.
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

-- oauth_get_job: 0111's body, verbatim.
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

revoke all on function public.api_list_videos(text, text, integer, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.api_list_videos(text, text, integer, integer, text) to anon;
revoke all on function public.api_get_job(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_get_job(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.api_get_job(text, bigint, text) to anon;
grant execute on function public.oauth_get_job(text, bigint, text) to anon;
drop trigger if exists render_jobs_result_slug_guard on public.render_jobs;
drop function if exists public.render_jobs_result_slug_guard();
drop function if exists public.render_job_video_id(public.render_jobs);
drop function if exists public.video_listed_at(text, timestamptz);
commit;
