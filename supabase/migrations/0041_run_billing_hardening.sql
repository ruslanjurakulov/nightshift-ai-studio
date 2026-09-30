-- 0041_run_billing_hardening.sql — a paid queue run is paid for, and for the
-- length it runs.
--
-- Two findings of the internal code review (C1, C2) and two of the roles
-- audit, all on the render_jobs queue (0017) and the credit ledger (0020):
--
--   C1  The video length was priced when the credit hold was placed, but read
--       again when the run started. "Run now" priced the requested length or,
--       with none, the channel's target_duration_seconds — and then queued the
--       job WITHOUT that length when none was requested. The worker passed no
--       --duration, so main.py read the channel's target at run time. Raise the
--       target after the hold (or queue a job whose length the hold never
--       priced) and a 60-minute video ran on a 5-minute hold; the worker's
--       floor check only knew job_minimum when params had no duration.
--   C2  "Only the operator may start an unpaid run" lived only in the web
--       route. With NIGHTSHIFT_CREDITS_ENFORCE off and the queue backend, a
--       customer organization's render job with no credit hold ran for free:
--       the insert policy accepted it and the worker ran it.
--   (a) A browser could set render_jobs.api_hold_ref on insert (the 0031 API
--       hold column): the insert policy never mentioned it.
--   (b) A browser could name any credit hold as credit_ref — another
--       organization's, a released one, one already paying for a running job,
--       or the Actions dispatch's own "gh-" hold — so one hold paid twice.
--
-- WHAT THIS CHANGES
--   render_jobs_payment_guard   BEFORE INSERT on render_jobs, for EVERY writer
--       (browser, API functions, service key, SQL editor). A trigger, not only
--       a policy: a second permissive insert policy added later cannot open it,
--       and the rule holds for the service key too. For a channel of the
--       operator's own (credits-exempt, 0020) organization it does nothing —
--       the operator's runs are exactly as before. For any other organization:
--         * someone pays: exactly one of credit_ref (site credits) or
--           api_hold_ref (API balance, 0031) — independent of any env flag;
--         * credit_ref names an OPEN hold of THIS channel's organization, with
--           a queue reference ("rj-…"), never started, not expired (3 hours,
--           0020's own limit), and big enough for this run (below);
--         * api_hold_ref names an OPEN API hold of this organization that is
--           not yet bound to a job or a download (0031's api_create_video
--           binds it right after this insert);
--         * the length is FROZEN into params.duration: the job's own duration
--           when it has one (0017's check keeps it 30..3600), else the
--           channel's target_duration_seconds as it stands at insert, rounded
--           and capped to 30..3600. No length at all is a refusal naming the
--           fix. The worker runs the frozen value and nothing else;
--         * the hold covers that length: at least max(job_minimum, the
--           video_minute price of the frozen length) — the same floor as
--           modules/credits.minimum_reservation and the per-minute estimate
--           the Command Center reserves (lib/credits.ts).
--       A signed-in caller who is not an admin of the channel's organization
--       gets the insert policy's own refusal before any of that is looked at,
--       so these messages are no oracle for another tenant's holds.
--   render_jobs_terms_frozen    BEFORE UPDATE: channel_id, kind, params,
--       credit_ref, api_hold_ref and requested_by never change after insert
--       (the worker and claim_render_job only move status/attempts/heartbeat).
--   render_jobs_insert policy   0032's, verbatim, plus `api_hold_ref is null`:
--       only the API's own functions attach an API hold.
--
-- NOT CHANGED: reserve_credits and every other 0020/0031 function (0034 may
-- change credit lot selection inside reserve_credits; nothing here depends on
-- its internals), claim_render_job, render_job_params_valid, the Actions path
-- (daily_video.yml, tools/credits_settle.py), publishing and privacy.
-- Rows already queued are not rewritten: the worker (tools/queue_worker.py)
-- refuses a customer job without a credit hold or a frozen length.
--
-- REQUIRES 0017/0019/0032 (render_jobs and its policy), 0018 (organizations),
-- 0020 (credit ledger), 0031 (api_hold_ref, api_holds). Stops with the remedy
-- if one is missing. Additive and idempotent: create-or-replace functions,
-- drop-then-create triggers and policy. Safe to re-run. Nothing is dropped.

do $$
begin
  if to_regclass('public.render_jobs') is null then
    raise exception '0041 needs public.render_jobs: apply 0017_render_jobs.sql first';
  end if;
  if to_regprocedure('public.accessible_channel_ids(text)') is null then
    raise exception '0041 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.credit_reservations') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null then
    raise exception '0041 needs the credit ledger: apply 0020_credits.sql first';
  end if;
  if to_regclass('public.api_holds') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'render_jobs'
                       and column_name = 'api_hold_ref') then
    raise exception '0041 needs render_jobs.api_hold_ref: apply 0031_public_api.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Insert: who pays, and for how long
-- ───────────────────────────────────────────────────────────────────────────

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

drop trigger if exists render_jobs_payment_guard on public.render_jobs;
create trigger render_jobs_payment_guard
  before insert on public.render_jobs
  for each row execute function public.render_jobs_payment_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Update: a job's paid terms are what was inserted
-- ───────────────────────────────────────────────────────────────────────────
-- Only the worker (service key) and claim_render_job update jobs, and only
-- their state. Freezing the terms in the database keeps "the length that was
-- paid for is the length that runs" true even against a bug there.

create or replace function public.render_jobs_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.channel_id is distinct from old.channel_id
     or new.kind is distinct from old.kind
     or new.params is distinct from old.params
     or new.credit_ref is distinct from old.credit_ref
     or new.api_hold_ref is distinct from old.api_hold_ref
     or new.requested_by is distinct from old.requested_by then
    raise exception 'a queued job''s channel, params and payment are fixed when it is queued'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists render_jobs_terms_frozen on public.render_jobs;
create trigger render_jobs_terms_frozen
  before update on public.render_jobs
  for each row execute function public.render_jobs_terms_frozen();

revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated;
revoke all on function public.render_jobs_terms_frozen() from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The insert policy: 0032's, plus no API hold from a browser
-- ───────────────────────────────────────────────────────────────────────────

drop policy if exists render_jobs_insert on public.render_jobs;
create policy render_jobs_insert on public.render_jobs
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('admin'))
    and requested_by = auth.uid()
    and kind = 'daily'
    and status = 'queued'
    and attempts = 0
    and max_attempts = 3
    and worker_id is null
    and heartbeat_at is null
    and started_at is null
    and finished_at is null
    and error is null
    and api_hold_ref is null
    and (params - array['topic','niche','duration','language','visual_style',
                        'video_provider','image_provider',
                        'tts_model','voice_id','publish_hint']) = '{}'::jsonb
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   exists (select 1 from pg_trigger where tgrelid = 'public.render_jobs'::regclass
--            and tgname = 'render_jobs_payment_guard' and not tgisinternal and tgenabled <> 'D')
--     as payment_guard_on,
--   exists (select 1 from pg_trigger where tgrelid = 'public.render_jobs'::regclass
--            and tgname = 'render_jobs_terms_frozen' and not tgisinternal and tgenabled <> 'D')
--     as terms_frozen_on,
--   (select with_check from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and policyname = 'render_jobs_insert') like '%api_hold_ref IS NULL%'
--     as browser_cannot_attach_api_hold,
--   (select with_check from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and policyname = 'render_jobs_insert') like '%voice_id%'
--     and (select with_check from pg_policies
--           where schemaname = 'public' and tablename = 'render_jobs'
--             and policyname = 'render_jobs_insert') not like '%privacy%'
--     as params_list_is_0032s,
--   (select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('render_jobs_payment_guard', 'render_jobs_terms_frozen'))
--     as search_path_pinned,
--   not has_function_privilege('authenticated', 'public.render_jobs_payment_guard()', 'EXECUTE')
--     as guard_not_callable;
