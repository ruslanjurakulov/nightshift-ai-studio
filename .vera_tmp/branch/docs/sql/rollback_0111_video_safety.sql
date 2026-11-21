-- rollback_0111_video_safety.sql — takes migration 0111 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. Rarely. The three behaviours are separate and each has a cheaper undo than this file:
--   * the provider refusal (render_jobs_payment_guard) only ever refuses a customer insert that named a provider, which
--     no screen or route sends;
--   * the job answer (api_get_job, oauth_get_job) is read-only;
--   * the sweep is the same function the worker already calls: to stop only the schedule,
--     select cron.unschedule('nightshift-expire-credit-reservations');
--
-- WHAT IT DOES, in one transaction:
--   1. Puts render_jobs_payment_guard() back to 0076's body, api_get_job(text, bigint, text) to 0042's and
--      oauth_get_job(text, bigint, text) to 0093's, byte for byte, with the grants those migrations gave them.
--      After this the API and MCP return the raw render_jobs.error again (the TypeScript layer still maps it to a
--      code and a sentence, so the callers see no difference).
--   2. Drops render_job_public_error(text, text), once nothing calls it.
--   3. Unschedules the pg_cron job, if pg_cron exists and the job does.
--
-- CHECK BEFORE YOU RUN IT: this file puts those three functions back to the text they had before 0111. If a later
-- migration has redefined one of them, running this would silently undo that later change. Compare first:
--     select pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure);
--     select pg_get_functiondef('public.api_get_job(text, bigint, text)'::regprocedure);
--     select pg_get_functiondef('public.oauth_get_job(text, bigint, text)'::regprocedure);
-- The only differences from this file's text should be the lines marked 0111 / render_job_public_error.
--
-- tests/security/test_sec_video_safety.py applies this file to the lab database and then re-applies 0111.

begin;
set local lock_timeout = '5s';

-- 1. The three functions back to the text they had before 0111 (0076, 0042, 0093), verbatim.

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
      'finished_at', j.finished_at, 'error', j.error,
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
      'created_at', j.created_at, 'started_at', j.started_at, 'finished_at', j.finished_at, 'error', j.error,
      'charge', case when cr.job_id is null then null
                     else jsonb_build_object('status', cr.status, 'held_credits', cr.amount, 'charged_credits', cr.captured) end)));
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

revoke all on function public.api_get_job(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_get_job(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.api_get_job(text, bigint, text) to anon;
grant execute on function public.oauth_get_job(text, bigint, text) to anon;

-- 2. The helper, now that nothing calls it.
drop function if exists public.render_job_public_error(text, text);

-- 3. The sweep schedule.
do $$
begin
  if to_regprocedure('cron.unschedule(text)') is not null and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-expire-credit-reservations') then
      perform cron.unschedule('nightshift-expire-credit-reservations');
    end if;
  end if;
exception when others then
  raise notice 'rollback 0111: the pg_cron job was not removed (%); remove it by hand: select cron.unschedule(''nightshift-expire-credit-reservations'');', sqlerrm;
end $$;

commit;
