-- rollback_0122_series_template_carrier.sql — takes migration 0122 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app
-- runs it.
--
-- WHEN YOU NEED IT. If the format carrier must be withdrawn. request_series_plan is granted to nobody (0120, 0122), so while that is true no plan
-- can have asked for a format and this is a clean undo. After the grant, plans with a format exist and this REFUSES (below): a record of what
-- a person asked for is not something a rollback may drop.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the four live bodies is not 0122's (a later change would be undone), if any series_plans row has a
--      template_id (the record would be lost), or if any render_jobs row carries a `template` param (the 0120 validator would refuse the row on its
--      next UPDATE: a CHECK is evaluated again on every update, and the worker updates a job it runs).
--   1. Puts render_job_params_valid(), render_jobs_payment_guard() and series_plans_terms_frozen() back to 0120's bodies, byte for byte.
--      This comes BEFORE the column goes: a trigger function that still named the column would fail on every update of series_plans.
--   2. Creates 0120's seven-argument request_series_plan(), revoked from public, anon, authenticated and service_role (granted to nobody, as
--      0120 left it), and drops the eight-argument one.
--   3. Drops series_plans_template_check and the column series_plans.template_id.
--
-- WHAT IT KEEPS: everything 0120 made. It touches nothing else.
--
-- CHECK BEFORE YOU RUN IT: step 1 puts three functions back to the text they had after 0120. If a later migration has redefined any of them,
-- running this would silently undo that later change; the script therefore compares all four live bodies with 0122's and refuses on any other
-- text. Compare by hand too:
--     select pg_get_functiondef('public.render_job_params_valid(jsonb,text)'::regprocedure);
--     select pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure);
--     select pg_get_functiondef('public.series_plans_terms_frozen()'::regprocedure);
-- The only differences from this file's text should be the lines marked 0122.
--
-- tests/security/test_sec_series_template.py applies this file to a copy of the lab database and re-applies 0122.

begin;
set local lock_timeout = '5s';

do $$
declare
  v text;
  g text;
  t text;
  r text;
  new_oid oid := to_regprocedure('public.request_series_plan(text, text, integer, text, integer, text, text, text)');
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into v
    from pg_proc p where p.oid = 'public.render_job_params_valid(jsonb, text)'::regprocedure;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into g
    from pg_proc p where p.oid = 'public.render_jobs_payment_guard()'::regprocedure;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into t
    from pg_proc p where p.oid = 'public.series_plans_terms_frozen()'::regprocedure;
  if v is distinct from 'a9367e46ea79e8d57ce1c876333b5508' then
    raise exception 'rollback 0122: render_job_params_valid() is not 0122''s body (md5 %): a later change would be undone; read the live body first', v;
  end if;
  if g is distinct from '3807936ade6801fa20da292e27fa7f64' then
    raise exception 'rollback 0122: render_jobs_payment_guard() is not 0122''s body (md5 %): a later change would be undone; read the live body first', g;
  end if;
  if t is distinct from '4c3b97a9d5d400a9a8cf900aa23c5ab2' then
    raise exception 'rollback 0122: series_plans_terms_frozen() is not 0122''s body (md5 %): a later change would be undone; read the live body first', t;
  end if;
  if new_oid is null then
    raise exception 'rollback 0122: the eight-argument request_series_plan() is not there: 0122 is not applied';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r from pg_proc p where p.oid = new_oid;
  if r is distinct from 'e38342a6c8511d5eadb1f99ab38fb6aa' then
    raise exception 'rollback 0122: request_series_plan() is not 0122''s body (md5 %): a later change would be undone; read the live body first', r;
  end if;
  if exists (select 1 from public.series_plans where template_id is not null) then
    raise exception 'rollback 0122: a series plan asked for a format (series_plans.template_id is set): dropping the column would lose that record; save it and decide by hand';
  end if;
  if exists (select 1 from public.render_jobs where params ? 'template') then
    raise exception 'rollback 0122: a queue row carries a template param: the 0120 validator would refuse it on its next update; finish or delete it by hand first';
  end if;
end $$;

-- 1. 0120's bodies. The triggers stay bound: create or replace keeps them.
create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','tts_model','voice_id','resume','repair_scenes',
                          'publish_hint','series'];
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
  -- 0120: which series an episode's run belongs to. A slug (the shape modules/series.py accepts), so it can name nothing else: no path, no
  -- flag, no line break. Never on a repair, which re-renders scenes of a run that is already made.
  if p ? 'series' and (jsonb_typeof(p -> 'series') <> 'string'
                       or p ->> 'series' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
                       or p_kind = 'repair') then
    return false;
  end if;
  if p ? 'resume' and jsonb_typeof(p -> 'resume') <> 'boolean' then
    return false;
  end if;

  has_repair := length(btrim(coalesce(p ->> 'repair_scenes', ''))) > 0;
  -- 0120: a series-planning job is ONE model call about a topic. It carries the topic, the niche, the language and the series it is for, and
  -- nothing a run takes (no length, provider, voice, resume or repair).
  if p_kind = 'series_plan' then
    return not has_repair
       and (p - array['topic','niche','language','series']) = '{}'::jsonb
       and length(btrim(coalesce(p ->> 'topic', ''))) > 0
       and length(btrim(coalesce(p ->> 'niche', ''))) > 0;
  end if;
  if p_kind = 'repair' then
    return has_repair and coalesce((p ->> 'resume')::boolean, false) = false;
  end if;
  return not has_repair;
end
$$;

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
  sp      public.series_plans;
begin
  -- 0120: a job linked to a series plan is the one job its request queued -- a planning job (one model call, paid by nobody: planning is free
  -- to the customer and capped per organization per day) -- for every organization, the operator's included. Placed before the channel
  -- check below on purpose: an EDITOR requests a plan (request_series_plan checks that), and the browser's own insert policy admits only
  -- kind 'daily', so a signed-in browser cannot insert this row itself whatever it puts in the column.
  if new.series_plan_id is not null then
    select * into sp from public.series_plans where id = new.series_plan_id;
    if sp.id is null or new.kind <> 'series_plan' or sp.channel_id <> new.channel_id
       or sp.status <> 'requested' or sp.render_job_id is not null
       or new.credit_ref is not null or new.api_hold_ref is not null or new.scene_regeneration_id is not null
       or new.params ->> 'topic' is distinct from sp.topic
       or new.params ->> 'niche' is distinct from sp.niche
       or new.params ->> 'language' is distinct from sp.language
       or new.params ->> 'series' is distinct from sp.series_id
       or (new.params - array['topic','niche','language','series']) <> '{}'::jsonb then
      raise exception 'render job refused: it is not the job its series plan queued'
        using errcode = '42501';
    end if;
    return new;
  end if;

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

create or replace function public.series_plans_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.channel_id is distinct from old.channel_id
     or new.series_id is distinct from old.series_id
     or new.topic is distinct from old.topic
     or new.niche is distinct from old.niche
     or new.language is distinct from old.language
     or new.n_episodes is distinct from old.n_episodes
     or new.duration_s is distinct from old.duration_s
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_hash is distinct from old.request_hash
     or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at
     or (old.render_job_id is not null and new.render_job_id is distinct from old.render_job_id)
     or old.status <> 'requested' then
    raise exception 'a series plan''s terms are fixed when it is requested, and an ended plan is final'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.series_plans_terms_frozen() from public, anon, authenticated, service_role;

-- 2. 0120's seven-argument request_series_plan, callable by nobody; the eight-argument one goes.
create or replace function public.request_series_plan(
  p_channel text, p_topic text, p_n integer, p_language text, p_duration_s integer, p_series text, p_idem text
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

  v_hash := md5(jsonb_build_object('channel', ch.channel_id, 'topic', v_topic, 'n', p_n, 'language', v_lang,
                                   'duration', p_duration_s, 'series', v_series)::text);
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

  insert into public.series_plans (id, org_id, channel_id, series_id, topic, niche, language, n_episodes, duration_s,
                                   idempotency_key, request_hash, requested_by)
  values (v_id, v_org, ch.channel_id, v_series, v_topic, v_niche, v_lang, p_n, p_duration_s, p_idem, v_hash, uid);

  -- The planning job: one model call, no length, no provider, no voice, no hold. render_jobs_payment_guard checks it is exactly the job this
  -- plan queued.
  insert into public.render_jobs (channel_id, kind, params, requested_by, series_plan_id)
  values (ch.channel_id, 'series_plan',
          jsonb_strip_nulls(jsonb_build_object('topic', v_topic, 'niche', v_niche, 'language', v_lang, 'series', v_series)),
          uid, v_id)
  returning id into v_job;
  update public.series_plans set render_job_id = v_job where id = v_id;

  return jsonb_build_object('id', v_id, 'status', 'requested', 'render_job_id', v_job, 'replayed', false);
end
$$;

revoke all on function public.request_series_plan(text, text, integer, text, integer, text, text) from public, anon, authenticated, service_role;
drop function if exists public.request_series_plan(text, text, integer, text, integer, text, text, text);

-- 3. The carrier.
alter table public.series_plans drop constraint if exists series_plans_template_check;
alter table public.series_plans drop column if exists template_id;

commit;
