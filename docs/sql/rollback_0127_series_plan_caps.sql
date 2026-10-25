-- rollback_0127_series_plan_caps.sql — takes migration 0127 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app
-- runs it.
--
-- WHEN YOU NEED IT. If the person and platform caps must be withdrawn. The caps need no rollback to be changed: to move a number run
--     update public.series_plan_cap_settings set user_daily_cap = 5, global_daily_cap = 50;
-- (0 refuses every request, a pause). This file is for taking the whole thing out. It is a clean undo while request_series_plan is granted to
-- nobody (0120, 0122, 0127), and it REFUSES once the function is executable by an API role: putting 0122's body back would lift the
-- caps from a live callable that spends the shared model key, which is a decision for a person, not a side effect of a rollback.
--
-- READ THIS FIRST: this file DROPS series_plan_cap_settings, so the owner's numbers are gone with it (the defaults 3 and 30 return if 0127 is
-- applied again). Copy them out first if they were changed:   select * from public.series_plan_cap_settings;   The security_events rows that
-- recorded changes of the numbers (kind series.plan.caps) stay. No plan row is touched.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if the live request_series_plan() is not 0127's body (a later change would be undone), or if it is executable
--      by public or an API role.
--   1. Puts request_series_plan() back to 0122's body, byte for byte (create or replace keeps its privileges: granted to nobody).
--   2. Drops the two triggers, the two trigger functions and the table series_plan_cap_settings.
--   3. Asserts the end state: 0122's hash, the table gone, still executable by nobody.
-- ORDER. Run this BEFORE docs/sql/rollback_0122_series_template_carrier.sql, which refuses a request_series_plan() that is not 0122's body.
--
-- tests/security/test_sec_series_plan_caps.py applies this file to a copy of the lab database and re-applies 0127.

begin;
set local lock_timeout = '5s';

do $$
declare
  r  text;
  fn oid := to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)');
begin
  if fn is null then
    raise exception 'rollback 0127: the eight-argument request_series_plan() is not there: 0122 is not applied';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r from pg_proc p where p.oid = fn;
  if r is distinct from '1053b80a2f37ebe4fabf52f7fba270c6' then
    raise exception 'rollback 0127: request_series_plan() is not 0127''s body (md5 %): a later change would be undone; read the live body first', r;
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = fn
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select o.oid from pg_roles o where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception 'rollback 0127: request_series_plan() is executable by public or an API role: removing the caps from a live callable is a decision for a person';
  end if;
end $$;

-- 1. 0122's body, verbatim.
create or replace function public.request_series_plan(
  p_channel text, p_topic text, p_n integer, p_language text, p_duration_s integer, p_series text, p_idem text,
  p_template text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid      uuid := auth.uid();
  ch       public.channels;
  se       public.content_series;
  v_org    uuid;
  v_topic  text := btrim(coalesce(p_topic, ''));
  v_lang   text := coalesce(nullif(btrim(coalesce(p_language, '')), ''), 'English');
  v_series text := nullif(btrim(coalesce(p_series, '')), '');
  v_niche  text;
  v_hash   text;
  prior    public.series_plans;
  v_id     uuid := gen_random_uuid();
  v_job    bigint;
  v_limit  integer := public.series_plan_daily_limit();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ch from public.channels where channel_id = p_channel;
  -- A channel that does not exist and a channel of another organization are the same answer.
  if ch.channel_id is null or ch.org_id is null or not public.is_org_member(ch.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_org := ch.org_id;
  if not public.is_org_member(v_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if char_length(v_topic) not between 1 and 300 or v_topic ~ '[[:cntrl:]]' then
    raise exception 'invalid_topic' using errcode = '22023';
  end if;
  if p_n is null or p_n not in (3, 4) then
    raise exception 'invalid_episode_count' using errcode = '22023';
  end if;
  if p_duration_s is null or p_duration_s not between 30 and 3600 then
    raise exception 'invalid_duration' using errcode = '22023';
  end if;
  if v_lang !~ '^[A-Za-z][A-Za-z -]{0,39}$' then
    raise exception 'invalid_language' using errcode = '22023';
  end if;
  -- 0122: the format is NULL (none asked for) or exactly one of the closed list. Not trimmed, not lower-cased, not defaulted: an empty string, another
  -- case or an unknown word is refused, never read as "no format" (the same list is in series_plans_template_check and render_job_params_valid).
  if p_template is not null and p_template not in ('myth_vs_fact', 'top5_countdown', 'one_question_one_answer') then
    raise exception 'invalid_template' using errcode = '22023';
  end if;

  -- The series, when one is named, is this channel's own (a series id is global; another channel's is not found, not "forbidden").
  if v_series is not null then
    select * into se from public.content_series where series_id = v_series and channel_id = ch.channel_id;
    if se.series_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  -- The niche is the series' or the channel's, from the database; the browser does not choose it. A plan with no niche has no
  -- off-niche screening at all (modules/series_planner: no_niche), so it is refused before anything is queued (rule 6).
  v_niche := left(btrim(regexp_replace(coalesce(nullif(btrim(coalesce(se.niche, '')), ''), ch.niche, ''), '[[:cntrl:]]', ' ', 'g')), 120);
  v_niche := btrim(v_niche);
  if v_niche = '' then
    raise exception 'no_niche' using errcode = '22023';
  end if;

  -- Presses of one organization take turns: a double click, a second tab or a second editor waits here, then sees the first one's row, and two
  -- concurrent requests cannot both pass the cap.
  perform pg_advisory_xact_lock(hashtextextended('series_plan:' || v_org::text, 0));

  -- 0122: the format is part of what was asked, so a replay with another format is idempotency_conflict. With NO format the object is exactly
  -- 0120's, so the hash of a request without a format is the one 0120 computed (a plan made before this migration still replays).
  v_hash := md5((jsonb_build_object('channel', ch.channel_id, 'topic', v_topic, 'n', p_n, 'language', v_lang,
                                    'duration', p_duration_s, 'series', v_series)
                 || case when p_template is null then '{}'::jsonb else jsonb_build_object('template', p_template) end)::text);
  select * into prior from public.series_plans where org_id = v_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    -- The same press again (a retry, a replay): its plan and job, nothing queued twice.
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'render_job_id', prior.render_job_id, 'replayed', true);
  end if;

  -- A plan that was never finished frees its channel after two hours, and its queue row with it (only if no worker has it).
  with expired as (
    update public.series_plans
       set status = 'failed', error_code = 'expired', error = 'planning did not finish in time', finished_at = now()
     where channel_id = ch.channel_id and status = 'requested' and created_at < now() - interval '2 hours'
    returning id)
  update public.render_jobs j
     set status = 'cancelled', finished_at = now(), error = 'the series plan expired before a worker took it'
   where j.series_plan_id in (select id from expired) and j.status = 'queued';

  if exists (select 1 from public.series_plans where channel_id = ch.channel_id and status = 'requested') then
    raise exception 'plan_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.series_plans
       where org_id = v_org and created_at > now() - interval '24 hours') >= v_limit then
    raise exception 'rate_limited' using errcode = 'NS429', detail = format('limit=%s per 24 hours', v_limit);
  end if;

  insert into public.series_plans (id, org_id, channel_id, series_id, topic, niche, language, n_episodes, duration_s, template_id,
                                   idempotency_key, request_hash, requested_by)
  values (v_id, v_org, ch.channel_id, v_series, v_topic, v_niche, v_lang, p_n, p_duration_s, p_template, p_idem, v_hash, uid);

  -- The planning job: one model call, no length, no provider, no voice, no hold. render_jobs_payment_guard checks it is exactly the job this
  -- plan queued (0122: the format included; a NULL format is stripped, so the job then carries none).
  insert into public.render_jobs (channel_id, kind, params, requested_by, series_plan_id)
  values (ch.channel_id, 'series_plan',
          jsonb_strip_nulls(jsonb_build_object('topic', v_topic, 'niche', v_niche, 'language', v_lang, 'series', v_series,
                                               'template', p_template)),
          uid, v_id)
  returning id into v_job;
  update public.series_plans set render_job_id = v_job where id = v_id;

  return jsonb_build_object('id', v_id, 'status', 'requested', 'render_job_id', v_job, 'replayed', false);
end
$$;

revoke all on function public.request_series_plan(text, text, integer, text, integer, text, text, text) from public, anon, authenticated, service_role;

-- 2. What 0127 added. The triggers go first: they call the functions.
drop trigger if exists series_plan_cap_settings_trail on public.series_plan_cap_settings;
drop trigger if exists series_plan_cap_settings_no_truncate on public.series_plan_cap_settings;
drop trigger if exists series_plan_cap_settings_guard on public.series_plan_cap_settings;
drop function if exists public.series_plan_cap_settings_trail();
drop function if exists public.series_plan_cap_settings_guard();
drop table if exists public.series_plan_cap_settings;

-- 3. The end state.
do $$
declare
  fn oid := to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)');
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = fn) is distinct from 'e38342a6c8511d5eadb1f99ab38fb6aa' then
    raise exception 'rollback 0127 end state: request_series_plan() does not hold 0122''s body';
  end if;
  if to_regclass('public.series_plan_cap_settings') is not null
     or to_regprocedure('public.series_plan_cap_settings_guard()') is not null
     or to_regprocedure('public.series_plan_cap_settings_trail()') is not null then
    raise exception 'rollback 0127 end state: something of 0127 is still there';
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = fn
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select o.oid from pg_roles o where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception 'rollback 0127 end state: request_series_plan() is executable by public or an API role';
  end if;
end $$;

commit;
