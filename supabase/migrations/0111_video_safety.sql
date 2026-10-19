-- 0111_video_safety.sql — three follow-ups of the independent audit of the paid-API video pipeline (D8, D12, D15):
-- the database half of "a customer does not choose the provider", the job answer of the API and MCP without the worker's
-- log, and a pg_cron sweep of stale credit holds. NO TABLE, COLUMN, POLICY, TRIGGER OR AUDIT ACTION IS ADDED OR CHANGED.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it
-- *** automatically, and an applied migration is never edited: fix by a new forward
-- *** migration (docs/MIGRATIONS.md).
--
-- WHAT IT CHANGES (three functions redefined, one helper added, one schedule)
--  1. render_jobs_payment_guard()   0076's body verbatim plus ONE block, after the operator's early return: for an
--       organization that pays (not credits_exempt), a new job whose params carry a NON-BLANK video_provider or
--       image_provider is refused (SQLSTATE 42501, "render job refused: video_provider and image_provider cannot be set
--       for this organization"). It is the same rule the browser route, the public API and MCP already apply
--       (#535, lib/api/operations.ts, app/api/agent/run/route.ts), enforced where a direct caller cannot bypass it:
--       the one before-insert trigger that every insert path goes through (Run now, storyboard approval, scene
--       regeneration, api_create_video, oauth_create_video).
--       * The operator's own organization is untouched (the check sits after the credits_exempt early return).
--       * A blank or null value is tolerated by the trigger, as the REST route tolerates it. The table's own CHECK
--         (render_job_params_valid) still refuses a blank as a provider id, as it always did; nothing changes there.
--       * Update paths: the trigger is BEFORE INSERT only. A queued job's params cannot change afterwards
--         (render_jobs_terms_frozen), so there is nothing to guard on update.
--       * Jobs already queued, and jobs that ran, keep whatever they carry; only a new insert is checked.
--       * A direct api_create_video / oauth_create_video call that names a provider is now answered 500 internal_error
--         ("nothing was created or charged"): their exception block rolls the hold back with the refused insert. The
--         routes refuse it earlier with a 400 and never get there.
--  2. api_get_job() (0042) and oauth_get_job() (0093)   verbatim except ONE line: `error` was the raw render_jobs.error
--       (the worker's header and up to 60 log lines, with vendor names and operator remedies). Now:
--         error       one fixed sentence for the code, or null
--         error_code  credits | voice | provider_quota | media | render | timeout | unknown, or null
--       The code is read from the `[code:xxx] ` prefix the worker writes (modules/render_error.py). A failed job whose
--       error has no prefix reads `unknown`, so does a prefix this list does not know, and a job that did
--       not FAIL (queued, running, succeeded, cancelled) reads null/null, because the worker also writes `error` on a
--       re-queue. Every other field, the shape, the grants and the rate/idempotency handling are 0042's and 0093's.
--       The sentences are the Create page's (lib/i18n/en.ts create.jobError); the TypeScript layer
--       (withPublicJobError in lib/api/operations.ts) already maps the same way and now passes an already-coded answer
--       through, so the two layers agree. tests/test_video_safety_migration.py compares the sentences with en.ts.
--     New helper render_job_public_error(status, error) -> jsonb {error, error_code}: pure, no table access, callable by
--     nobody but the two definer functions.
--     DEPLOY ORDER: apply this file and deploy the web app of the same commit together. An app older than this commit
--     would re-read the sentence as an uncoded error and answer `unknown` (never the log); nothing is lost.
--  3. pg_cron   expire_credit_reservations() every 10 minutes (job 'nightshift-expire-credit-reservations'), only when
--       pg_cron is installed (cron.schedule and cron.job exist, as 0034 checks for its hourly lot expiry). Unscheduled
--       first if it exists, so a replay leaves one job. Without pg_cron nothing is created and the file still applies:
--       the worker's own sweep (tools/queue_worker.py) keeps releasing holds while it runs. The function is not changed.
--       Why it is safe beside the worker: every settlement (capture_credits, release_credits, start_credit_reservation,
--       this sweep) takes the organization's account lock first and the hold row second, and the release re-reads the
--       hold under both locks and only acts on `open`; a hold the worker captured a moment earlier is left alone, and
--       two sweeps cannot deadlock (they walk the organizations in the same order). A pg_cron session carries no JWT
--       claims, which credits_trusted_caller() accepts like the SQL editor, so the function's own gate passes.
--       Known limit, unchanged: a hold that was never started is released 3 hours after it was reserved even if its job
--       is still queued (worker down); the job then fails "reservation not open" and the customer is charged nothing.
--       Before this schedule that happened when the worker came back; now it happens on time.
--
-- Additive and idempotent: create or replace (bodies copied from the latest migration that defines each), revoke then
-- grant (a replay leaves the same ACL), unschedule-then-schedule for the cron job. Rollback:
-- docs/sql/rollback_0111_video_safety.sql.
-- REQUIRES 0041 (render_jobs_payment_guard and its trigger), 0076 (scene_regenerations: the guard's latest body names it),
-- 0042 (api_get_job), 0093 (oauth_get_job), 0020 (expire_credit_reservations).

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.render_jobs_payment_guard()') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null
     or to_regprocedure('public.credits_round_up(numeric)') is null
     or to_regclass('public.render_jobs') is null then
    raise exception '0111 needs 0041_run_billing_hardening.sql (render_jobs_payment_guard, credits_exempt): apply it first';
  end if;
  if to_regclass('public.scene_regenerations') is null then
    raise exception '0111 needs 0076_scene_regenerate.sql (scene_regenerations): apply it first';
  end if;
  if to_regprocedure('public.api_get_job(text, bigint, text)') is null then
    raise exception '0111 needs 0042_web_api_hardening.sql (api_get_job): apply it first';
  end if;
  if to_regprocedure('public.oauth_get_job(text, bigint, text)') is null then
    raise exception '0111 needs 0093_mcp_oauth.sql (oauth_get_job): apply it first';
  end if;
  if to_regprocedure('public.expire_credit_reservations(uuid, interval, interval)') is null then
    raise exception '0111 needs 0020_credits.sql (expire_credit_reservations): apply it first';
  end if;
  -- create or replace keeps the trigger bound; if it is gone the new check would never run.
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.render_jobs'::regclass and tgname = 'render_jobs_payment_guard' and not tgisinternal) then
    raise exception '0111 found no render_jobs_payment_guard trigger on render_jobs: re-apply 0041/0076 first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. D8 in the database: a customer's job never carries a provider
-- ───────────────────────────────────────────────────────────────────────────
-- 0076's body (the latest definition) verbatim, plus the block marked 0111. The trigger itself
-- (before insert, 0041/0076) is not recreated: create or replace keeps it bound.

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

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The API and MCP answer for a job: a code and one fixed sentence, never the worker's log
-- ───────────────────────────────────────────────────────────────────────────

-- The one place the mapping lives. Pure. The sentences are lib/i18n/en.ts create.jobError, word for word; the code list is
-- JOB_ERROR_CODES in lib/runBackend.ts and modules/render_error.py. Same rule as parseJobError(): the prefix is
-- `[code:` lower-case letters and underscores `]`, optionally one space or tab; anything else is `unknown`.
create or replace function public.render_job_public_error(p_status text, p_error text) returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_code text;
begin
  -- Only a failed job has a failure to explain. The worker also writes `error` on a re-queue
  -- ("worker stopping before the run started"): operator text that says nothing a caller needs.
  if p_status is distinct from 'failed' or p_error is null or p_error = '' then
    return jsonb_build_object('error', null, 'error_code', null);
  end if;
  v_code := coalesce((regexp_match(p_error, '^\[code:([a-z_]+)\][ \t]?'))[1], 'unknown');
  if v_code not in ('credits', 'voice', 'provider_quota', 'media', 'render', 'timeout') then
    v_code := 'unknown';
  end if;
  return jsonb_build_object(
    'error', case v_code
      when 'credits' then 'Your credits could not be reserved, so the video was not started. Nothing was charged.'
      when 'voice' then 'The narration could not be produced, so the video was not made.'
      when 'provider_quota' then 'A service that helps make the video has reached its limit. Try again later.'
      when 'media' then 'The footage and pictures for this video could not be gathered, so it was not made.'
      when 'render' then 'The video could not be put together.'
      when 'timeout' then 'The video took too long to make and was stopped.'
      else 'Something went wrong and the video was not made.'
    end,
    'error_code', v_code);
end
$$;

revoke all on function public.render_job_public_error(text, text) from public, anon, authenticated, service_role;

-- 0042's api_get_job, verbatim, except the `error` line (now `error` and `error_code`).
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

-- 0093's oauth_get_job, verbatim, except the same line.
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

-- Grants as 0042 and 0093 made them (create or replace keeps them; restated so a partial earlier run cannot leave one wider).
revoke all on function public.api_get_job(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_get_job(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.api_get_job(text, bigint, text) to anon;
grant execute on function public.oauth_get_job(text, bigint, text) to anon;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Sweep stale credit holds every 10 minutes, when pg_cron is enabled (D15)
-- ───────────────────────────────────────────────────────────────────────────
-- Until now only a live worker swept (queue_worker._sweep_credit_holds). With the worker down, holds of failed starts stay
-- locked past their 3 hours. All defaults: unstarted 3 hours, unsettled 24 hours, every organization.

do $$
begin
  if to_regprocedure('cron.schedule(text, text, text)') is not null
     and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-expire-credit-reservations') then
      perform cron.unschedule('nightshift-expire-credit-reservations');
    end if;
    perform cron.schedule('nightshift-expire-credit-reservations', '*/10 * * * *',
                          'select public.expire_credit_reservations()');
  else
    raise notice '0111: pg_cron is not enabled, so no schedule was created; the worker''s sweep still releases stale credit holds';
  end if;
exception when others then
  -- All or nothing: a failed schedule undoes the unschedule above (this block is one subtransaction).
  raise notice '0111: pg_cron schedule not created (%); the worker''s sweep still releases stale credit holds', sqlerrm;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   position('video_provider' in pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure)) > 0
--     as guard_refuses_a_customer_provider,
--   exists (select 1 from pg_trigger where tgrelid = 'public.render_jobs'::regclass
--            and tgname = 'render_jobs_payment_guard' and not tgisinternal and tgenabled <> 'D')
--     as guard_trigger_on,
--   public.render_job_public_error('failed', '[code:voice] main.py exited with code 1') ->> 'error_code' = 'voice'
--     and public.render_job_public_error('running', '[code:voice] x') ->> 'error' is null
--     as job_error_mapping_works,
--   position('render_job_public_error' in pg_get_functiondef('public.api_get_job(text, bigint, text)'::regprocedure)) > 0
--     and position('render_job_public_error' in pg_get_functiondef('public.oauth_get_job(text, bigint, text)'::regprocedure)) > 0
--     as both_job_answers_use_it,
--   has_function_privilege('anon', 'public.api_get_job(text, bigint, text)', 'EXECUTE')
--     and has_function_privilege('anon', 'public.oauth_get_job(text, bigint, text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.api_get_job(text, bigint, text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.render_job_public_error(text, text)', 'EXECUTE')
--     as grants_unchanged;
-- -- and, only if pg_cron is on:
-- select jobname, schedule, command from cron.job where jobname = 'nightshift-expire-credit-reservations';
