-- rollback_0207_render_job_video_id_own_run.sql — 0189's render_job_video_id back, verbatim.
-- OWNER-APPLY. Brings BR-LIVE-05 back (a job may again name its Short or an earlier run of the same slug). Changes nothing else.
-- Refuses (changes nothing) if the live body is not 0207's.
begin;
set local lock_timeout = '5s';
do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.render_job_video_id(public.render_jobs)');
  if h is distinct from '6d5da2fcd4047b75223bd9ee82bb3299' then
    raise exception 'rollback 0207: public.render_job_video_id(public.render_jobs) is not 0207''s body (md5 %)', h;
  end if;
end $$;

-- render_job_video_id: 0189's body, verbatim.
create or replace function public.render_job_video_id(j public.render_jobs) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select v.video_id from public.videos v
   where j.result_slug is not null and v.channel_id = j.channel_id and v.slug = j.result_slug
   order by (v.published_at is not null) desc, public.video_listed_at(v.published_at, v.held_at) desc nulls last, v.video_id
   limit 1
$$;

revoke all on function public.render_job_video_id(public.render_jobs) from public, anon, authenticated, service_role;
commit;
