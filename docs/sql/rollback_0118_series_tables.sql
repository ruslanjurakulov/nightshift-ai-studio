-- rollback_0118_series_tables.sql — takes migration 0118 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the series functions or the new queue kind must be withdrawn. Nothing in the application calls them until slice S3, so
-- before that there is rarely a reason; after S3 the series page stops working (its functions are gone), which is why this is a deliberate act.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any 'series_plan' job or any run that carries a `series` is queued or running: let them finish, or cancel
--      them, first. A running job whose row the old validator would refuse could not be finished by the worker (the CHECK is evaluated again
--      on every UPDATE of the row), and a queued episode run still holds credits.
--   1. Deletes the finished 'series_plan' queue rows (they carry no payment; their plans stay) and strips the `series` key from the params of
--      finished runs, with render_jobs_terms_frozen switched off for that one statement and on again after it, so the 0029 validator accepts
--      every row that is left (a CHECK is evaluated on any later update of a row). The series of a past run is still recorded by
--      series_episodes.render_job_id and by the run itself.
--   2. Puts render_jobs_kind_check back to ('daily', 'repair') and drops render_jobs.series_plan_id with its check and index.
--   3. Puts render_job_params_valid() back to 0029's body, and render_jobs_payment_guard() back to 0111's body, byte for byte.
--   4. Drops every callable function 0118 added.
--
-- WHAT IT KEEPS, on purpose: the two tables (series_plans, series_episodes) with their rows, RLS, privileges and their immutability / no-delete
-- triggers. They are the record of every plan and of every paid episode start (the hold's reference lives in series_episodes.credit_ref);
-- dropping them is a decision about records, not a rollback. To remove them as well, drop the tables by hand.
--
-- CHECK BEFORE YOU RUN IT: step 3 puts two functions back to the text they had before 0118. If a later migration has redefined either, running
-- this would silently undo that later change; the script therefore compares both live bodies with 0118's and refuses on any other text.
-- Compare by hand too:
--     select pg_get_functiondef('public.render_job_params_valid(jsonb,text)'::regprocedure);
--     select pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure);
-- The only differences from this file's text should be the lines marked 0118.
--
-- tests/security/test_sec_series_tables.py applies this file to a copy of the lab database and re-applies 0118.

begin;
set local lock_timeout = '5s';

do $$
declare
  v text;
  g text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into v
    from pg_proc p where p.oid = 'public.render_job_params_valid(jsonb, text)'::regprocedure;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into g
    from pg_proc p where p.oid = 'public.render_jobs_payment_guard()'::regprocedure;
  if v is distinct from '0518e8198f65f86e62b762dd065ac378' then
    raise exception 'rollback 0118: render_job_params_valid() is not 0118''s body (md5 %): a later change would be undone; read the live body first', v;
  end if;
  if g is distinct from '4aba81ca04a52a6b03733bf925e4ed1c' then
    raise exception 'rollback 0118: render_jobs_payment_guard() is not 0118''s body (md5 %): a later change would be undone; read the live body first', g;
  end if;
  if exists (select 1 from public.render_jobs
              where status in ('queued', 'running') and (kind = 'series_plan' or params ? 'series')) then
    raise exception 'rollback 0118: a series_plan job or a run with a series is still queued or running: finish or cancel it first';
  end if;
end $$;

-- 1. The rows the old rules would refuse.
delete from public.render_jobs where kind = 'series_plan';
alter table public.render_jobs disable trigger render_jobs_terms_frozen;
update public.render_jobs set params = params - 'series' where params ? 'series';
alter table public.render_jobs enable trigger render_jobs_terms_frozen;

-- 2. The kind and the link.
alter table public.render_jobs drop constraint if exists render_jobs_series_plan_check;
drop index if exists public.render_jobs_series_plan_key;
alter table public.render_jobs drop column if exists series_plan_id;
alter table public.render_jobs drop constraint if exists render_jobs_kind_check;
alter table public.render_jobs add constraint render_jobs_kind_check
  check (kind in ('daily', 'repair'));

-- 3. 0029's body.
create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','tts_model','voice_id','resume','repair_scenes',
                          'publish_hint'];
  has_repair boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(allowed)) then
      return false;
    end if;
  end loop;

  foreach k in array array['topic','niche','language','visual_style','repair_scenes'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'string' then
      return false;
    end if;
  end loop;
  if length(coalesce(p ->> 'topic', '')) > 300
     or length(coalesce(p ->> 'niche', '')) > 120
     or length(coalesce(p ->> 'language', '')) > 40
     or length(coalesce(p ->> 'visual_style', '')) > 300
     or length(coalesce(p ->> 'repair_scenes', '')) > 120 then
    return false;
  end if;

  if p ? 'duration' then
    if jsonb_typeof(p -> 'duration') <> 'number' then
      return false;
    end if;
    if (p ->> 'duration')::numeric <> trunc((p ->> 'duration')::numeric)
       or (p ->> 'duration')::numeric not between 30 and 3600 then
      return false;
    end if;
  end if;

  if p ? 'privacy' and (jsonb_typeof(p -> 'privacy') <> 'string'
                        or p ->> 'privacy' not in ('private', 'unlisted', 'public')) then
    return false;
  end if;
  if p ? 'video_provider' and (jsonb_typeof(p -> 'video_provider') <> 'string'
      or p ->> 'video_provider' not in ('minimax','higgsfield','kling','veo','seedance','wan')) then
    return false;
  end if;
  if p ? 'image_provider' and (jsonb_typeof(p -> 'image_provider') <> 'string'
      or p ->> 'image_provider' not in ('pexels','leonardo','gpt-image','nano-banana',
                                         'flux','ideogram','fal')) then
    return false;
  end if;
  if p ? 'tts_model' and (jsonb_typeof(p -> 'tts_model') <> 'string'
      or p ->> 'tts_model' not in ('eleven_v3','eleven_multilingual_v2',
                                   'eleven_flash_v2_5','eleven_turbo_v2_5')) then
    return false;
  end if;
  if p ? 'voice_id' and (jsonb_typeof(p -> 'voice_id') <> 'string'
      or p ->> 'voice_id' !~ '^[A-Za-z0-9]{20}$') then
    return false;
  end if;
  -- 0029: which account the video is for — a hint, never an instruction.
  if p ? 'publish_hint' and (jsonb_typeof(p -> 'publish_hint') <> 'string'
      or p ->> 'publish_hint' !~ '^(youtube|instagram|tiktok):[A-Za-z0-9._-]{1,128}$') then
    return false;
  end if;
  if p ? 'resume' and jsonb_typeof(p -> 'resume') <> 'boolean' then
    return false;
  end if;

  has_repair := length(btrim(coalesce(p ->> 'repair_scenes', ''))) > 0;
  if p_kind = 'repair' then
    return has_repair and coalesce((p ->> 'resume')::boolean, false) = false;
  end if;
  return not has_repair;
end
$$;

-- 0111's body.
create or replace function public.render_jobs_payment_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org   uuid;
  v_cfg   jsonb;
  v_secs  numeric;
  r       public.credit_reservations;
  h       public.api_holds;
  jm      numeric;
  vm      public.credit_prices;
  v_need  numeric;
  sr      public.scene_regenerations;
begin
  -- A signed-in browser that may not start runs on this channel gets the
  -- insert policy's refusal here, before anything below can tell it whether
  -- a channel or a hold exists. (The API functions run with the key's anon
  -- role and do their own channel check; the service key is trusted.)
  if coalesce(auth.role(), '') = 'authenticated'
     and not (new.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'new row violates row-level security policy for table "render_jobs"'
      using errcode = '42501';
  end if;

  select c.org_id, c.agent_config into v_org, v_cfg
    from public.channels c where c.channel_id = new.channel_id;
  if v_org is null then
    raise exception 'render job refused: channel % belongs to no organization', new.channel_id
      using errcode = '42501';
  end if;
  -- 0076: a job linked to a scene regeneration is the one job its request
  -- queued — a repair of that scene, with that regeneration's own hold —
  -- for every organization, the operator's included.
  if new.scene_regeneration_id is not null then
    select * into sr from public.scene_regenerations where id = new.scene_regeneration_id;
    if sr.id is null or new.kind <> 'repair' or sr.channel_id <> new.channel_id
       or sr.status <> 'queued' or sr.render_job_id is not null
       or sr.credit_ref is distinct from new.credit_ref or new.api_hold_ref is not null
       or new.params ->> 'repair_scenes' is distinct from sr.scene_id
       or new.params ->> 'topic' is distinct from sr.slug
       or coalesce((new.params ->> 'resume')::boolean, false) then
      raise exception 'render job refused: it is not the job its scene regeneration queued'
        using errcode = '42501';
    end if;
  end if;
  -- The operator's own organization never pays (0020) and its runs keep the
  -- channel's own target length, exactly as before this migration.
  if public.credits_exempt(v_org) then
    return new;
  end if;

  -- 0111 (audit D8): the platform chooses the providers of a customer's run. A run is priced flat
  -- (credit_prices / api_prices), so a customer who named Veo or Kling would spend a funded vendor
  -- key at a price that does not cover it. The routes already refuse both fields (browser, API,
  -- MCP); this is the same rule in the one place no route can be bypassed. A blank or null value is
  -- not a choice and passes here; render_job_params_valid still refuses it as a provider id.
  -- Insert only: a queued job's params are frozen afterwards by render_jobs_terms_frozen.
  if coalesce(nullif(btrim(new.params ->> 'video_provider'), ''),
              nullif(btrim(new.params ->> 'image_provider'), '')) is not null then
    raise exception 'render job refused: video_provider and image_provider cannot be set for this organization'
      using errcode = '42501',
            hint = 'Leave them out: the platform chooses the providers of a paid run.';
  end if;

  -- C2: a customer run is paid for — whatever NIGHTSHIFT_CREDITS_ENFORCE says.
  if new.credit_ref is null and new.api_hold_ref is null then
    raise exception 'render job refused: a run for this organization must carry its credit hold'
      using errcode = '42501',
            hint = 'Start it from the Command Center with credits enforced (NIGHTSHIFT_CREDITS_ENFORCE).';
  end if;
  if new.credit_ref is not null and new.api_hold_ref is not null then
    raise exception 'render job refused: a run is paid by one hold, not two' using errcode = '42501';
  end if;

  -- 0076: a scene regeneration is priced per scene, not per minute of video.
  -- Its hold is its own (the reference the request placed): open, never
  -- started, this organization's, and at least the quote. The whole-video
  -- length floor below does not apply to one scene, and no length is frozen.
  if new.scene_regeneration_id is not null then
    select * into r from public.credit_reservations where job_id = new.credit_ref;
    if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
       or r.started_at is not null or sr.quoted_credits is null or r.amount < sr.quoted_credits then
      raise exception 'render job refused: its credit hold is not this scene regeneration''s open hold'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- C1: freeze the length the hold is for. A job that names its length keeps
  -- it (render_jobs_params_check holds it to whole seconds, 30..3600); one
  -- that does not gets the channel's target as it is NOW, capped the same way.
  new.params := coalesce(new.params, '{}'::jsonb);
  if new.params ? 'duration' then
    if jsonb_typeof(new.params -> 'duration') <> 'number' then
      raise exception 'render job refused: duration must be a whole number of seconds'
        using errcode = '22023';
    end if;
    v_secs := (new.params ->> 'duration')::numeric;
  else
    if jsonb_typeof(v_cfg -> 'target_duration_seconds') = 'number' then
      v_secs := (v_cfg ->> 'target_duration_seconds')::numeric;
    end if;
    if v_secs is null or v_secs <= 0 then
      raise exception 'render job refused: a paid run needs a length'
        using errcode = '22023',
              hint = 'Choose a length, or set the channel''s target length.';
    end if;
    v_secs := least(greatest(round(v_secs), 30), 3600);
    new.params := new.params || jsonb_build_object('duration', v_secs::integer);
  end if;

  if new.api_hold_ref is not null then
    -- (a) is the policy's; here: the hold is this organization's, open, and
    -- not already paying for another job or a download. 0031's
    -- api_create_video priced it for this length in this same transaction.
    select * into h from public.api_holds where ref = new.api_hold_ref;
    if h.ref is null or h.org_id is distinct from v_org or h.status <> 'open'
       or h.started_at is not null or h.render_job_id is not null
       or h.download_request_id is not null then
      raise exception 'render job refused: its API balance hold is not an open, unused hold of this organization'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- (b) the credit hold: this organization's, a queue reference, open, never
  -- started (a started hold is paying for a run already), not expired.
  if new.credit_ref !~ '^rj-' then
    raise exception 'render job refused: a queued run is paid by a queue credit hold (rj-…)'
      using errcode = '42501';
  end if;
  select * into r from public.credit_reservations where job_id = new.credit_ref;
  if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
     or r.started_at is not null or r.created_at < now() - interval '3 hours' then
    raise exception 'render job refused: its credit hold is not an open, unused hold of this organization'
      using errcode = '42501';
  end if;

  -- The hold covers the frozen length: modules/credits.minimum_reservation.
  -- job_minimum is a flat floor (margin ignored, as in reserve_credits);
  -- video_minute is credits per minute with its margin. Unset = no floor.
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  select * into vm from public.credit_prices where unit = 'video_minute';
  v_need := greatest(coalesce(jm, 0),
                     coalesce(vm.credits_per_unit * (1 + vm.margin) * v_secs / 60, 0));
  v_need := public.credits_round_up(v_need);
  if v_need > 0 and r.amount < v_need then
    raise exception 'render job refused: its credit hold does not cover a run of % seconds', v_secs::integer
      using errcode = '22023',
            hint = 'Reserve for the length you run, or choose a shorter one.';
  end if;
  return new;
end
$$;

revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated;

-- 4. The functions 0118 added (the three trigger functions of the kept tables stay with them).
drop function if exists public.request_series_plan(text, text, integer, text, integer, text, text);
drop function if exists public.finish_series_plan(uuid, boolean, text, jsonb, jsonb, jsonb, text, text);
drop function if exists public.quote_series_episode(uuid);
drop function if exists public.start_series_episode(uuid, numeric, text, boolean);
drop function if exists public.series_plan_daily_limit();
drop function if exists public.series_episode_price(integer);
drop function if exists public.series_episode_blocker(uuid);
drop function if exists public.series_episode_json(uuid);

commit;
