-- 0083_workflow_wait.sql — workflow runs: a later step that cannot start for a
-- reason that passes (the plan's parallel runs all in use, or a balance short
-- for that step) waits for the next advance instead of failing a run whose
-- earlier steps were already paid for.
--
-- Security fix for migrations 0073/0074 (independent review LENS-4):
--   BR-L-011  Between two steps, any member's ordinary Studio press (it takes the
--             free plan's one parallel slot) or another spend of the balance made
--             create_creative_job refuse the next step (NS429 / NS402), and the
--             step's handler stored that as a failed step and a failed run: the
--             earlier steps were charged for output the run never used, and any
--             editor could kill another member's run on purpose. Those two
--             refusals now leave the step PENDING with the reason on record
--             (workflow_run_steps.error_code / error, which the run page shows as
--             "waiting"); the creation was rolled back with the handler's
--             subtransaction, so nothing is held for it. The next advance (the run
--             page polls) tries again. The wait is bounded by the existing rule: a
--             step not started within 24 hours of the confirmation fails
--             'confirmation_expired'. Every other refusal still fails the step and
--             the run, as before; Stop still skips what has not started.
--
-- What the run reports while it waits is true: charged_credits is the sum of the
-- steps that completed (unchanged), the waiting step has no job, no hold and no
-- charge, and a step that starts or is skipped carries no stale reason.
--
-- Additive. The one replaced function is 0074's workflow_advance_locked (the
-- latest body; nothing later replaces it) with lines only ADDED: every line,
-- check and string of 0074 stays, in order (pinned by
-- tests/test_workflow_wait_migration.py). advance_workflow_run and
-- cancel_workflow_run (0074) are not replaced. No table, column, constraint or
-- grant changes beyond restating this function's revoke.
-- Apply after 0074 (re-applying 0073 or 0074 later would undo this: re-run 0083).

-- Take a run as far as it can go right now. The caller has taken the credit
-- account (start_workflow_run, advance_workflow_run, cancel_workflow_run) and
-- this locks the run: account, then run, the order every function here takes.
-- The creative functions never touch a run, so they cannot meet it the other
-- way round.
--
-- One call may settle a finished step and start the next. p_strict: a refusal of
-- the FIRST step is raised (the run is not stored, nothing was held) instead of
-- stored as a failed run — "Run now" then answers with the real reason.
create or replace function public.workflow_advance_locked(p_run uuid, p_strict boolean default false)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r        public.workflow_runs;
  s        public.workflow_run_steps;
  j        public.creative_jobs;
  out_     jsonb;
  params   jsonb;
  pr       record;
  src_job  public.creative_jobs;
  asset    uuid;
  committed numeric;
  why_code text;
  why      text;
  detail   text;
  guard    integer := 0;
  -- BR-L-011: the step could not start for a reason that passes; it waits.
  wait_    boolean := false;
begin
  select * into r from public.workflow_runs where id = p_run for update;
  if not found then
    return;
  end if;
  loop
    guard := guard + 1;
    exit when guard > 8;
    exit when r.status <> 'running';

    select * into s from public.workflow_run_steps
     where run_id = r.id and status in ('pending', 'running')
     order by step_index limit 1;

    if not found then
      -- Every step is settled and none failed (a failure ends the run below).
      update public.workflow_runs
         set status = 'completed', finished_at = now(), updated_at = now(),
             charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
       where id = r.id returning * into r;
      exit;
    end if;

    if s.status = 'running' then
      select * into j from public.creative_jobs where id = s.job_id;
      if j.status = 'completed' then
        update public.workflow_run_steps
           set status = 'completed', charged_credits = coalesce(j.charged_credits, 0),
               finished_at = coalesce(j.finished_at, now())
         where run_id = s.run_id and step_index = s.step_index;
        update public.workflow_runs
           set updated_at = now(),
               charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
         where id = r.id returning * into r;
        continue;
      elsif j.status in ('failed', 'cancelled', 'expired') then
        update public.workflow_run_steps
           set status = case when j.status = 'cancelled' then 'cancelled' else 'failed' end,
               charged_credits = 0, error_code = coalesce(j.error_code, j.status), error = left(j.error, 2000),
               finished_at = coalesce(j.finished_at, now())
         where run_id = s.run_id and step_index = s.step_index;
        -- Later steps were never created, so they never held anything.
        update public.workflow_run_steps set status = 'skipped'
         where run_id = r.id and status = 'pending';
        update public.workflow_runs
           set status = case when r.cancel_requested_at is not null then 'cancelled' else 'failed' end,
               error_code = case when r.cancel_requested_at is not null then 'cancelled' else 'step_failed' end,
               error = format('step %s did not finish (%s); later steps were not started and nothing was held for them',
                              s.step_index + 1, coalesce(j.error_code, j.status)),
               finished_at = now(), updated_at = now(),
               charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
         where id = r.id returning * into r;
        exit;
      else
        exit; -- the job is still being made
      end if;
    end if;

    -- s is the next step to start; every step before it has completed.
    if r.cancel_requested_at is not null then
      update public.workflow_run_steps set status = 'skipped' where run_id = r.id and status = 'pending';
      update public.workflow_runs
         set status = 'cancelled', error_code = 'cancelled', finished_at = now(), updated_at = now(),
             charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
       where id = r.id returning * into r;
      exit;
    end if;

    why_code := null;
    wait_ := false;
    if r.created_at < now() - interval '24 hours' then
      why_code := 'confirmation_expired';
      why := 'the price was confirmed more than 24 hours ago; run the workflow again to confirm it afresh';
    end if;

    -- BR-L-006: a later step spends on the confirmation of the member who
    -- pressed Run now, whoever's page carries the run on. Once that member may
    -- no longer run things in the run's organization, nothing more starts.
    if why_code is null and s.step_index > 0
       and not public.workflow_confirmer_may_spend(r.started_by, r.org_id) then
      why_code := 'confirmation_revoked';
      why := 'the member who confirmed this run may no longer run workflows in this organization';
    end if;

    if why_code is null then
      -- Fill in the file an earlier step made.
      params := s.params;
      for pr in select key, value from jsonb_each(s.params) loop
        if jsonb_typeof(pr.value) = 'object' and pr.value ? '$step' then
          asset := null;
          select cj.* into src_job
            from public.workflow_run_steps ss
            join public.creative_jobs cj on cj.id = ss.job_id
           where ss.run_id = r.id and ss.step_index = (pr.value ->> '$step')::integer
             and ss.status = 'completed' and cj.org_id = r.org_id;
          asset := case when found then src_job.result_asset_ids[1] end;
          if asset is null then
            why_code := 'missing_output';
            why := format('step %s made no file for this step to start from', (pr.value ->> '$step')::integer + 1);
          else
            params := params || jsonb_build_object(pr.key, asset::text);
          end if;
        end if;
      end loop;
    end if;

    if why_code is null then
      -- The steps together may not pass what was confirmed.
      select coalesce(sum(quoted_credits), 0) into committed
        from public.workflow_run_steps where run_id = r.id and status in ('running', 'completed');
      if committed + s.quoted_credits > r.max_credits then
        why_code := 'over_confirmed_total';
        why := 'starting this step would pass the total that was confirmed';
      end if;
    end if;

    if why_code is null then
      begin
        out_ := public.create_creative_job(
          r.org_id, s.capability, s.model, params, 'exact',
          'wf:' || r.id::text || ':' || s.step_index::text, s.quoted_credits);
        if out_ is null or (out_ -> 'job' ->> 'id') is null or (out_ -> 'job' ->> 'org_id')::uuid <> r.org_id then
          raise exception 'creative job not created' using errcode = 'NS400';
        end if;
        -- BR-L-005: a step flips to running in the same transaction that creates
        -- its job, so its own start is never a replay. A replay means a job was
        -- made beforehand under this step's key (keys and run ids are readable
        -- by members): it was not priced against this step's confirmed price and
        -- is never adopted.
        if coalesce((out_ ->> 'replay')::boolean, false) then
          raise exception 'idempotency_conflict' using errcode = 'NS409',
            detail = 'a job already holds this step''s idempotency key; it was not made by this run';
        end if;
        update public.workflow_run_steps
           set status = 'running', job_id = (out_ -> 'job' ->> 'id')::uuid, started_at = now()
         where run_id = s.run_id and step_index = s.step_index;
        -- BR-L-011: a step that waited starts with no stale reason on it.
        update public.workflow_run_steps set error_code = null, error = null
         where run_id = s.run_id and step_index = s.step_index and error_code is not null;
        update public.workflow_runs set updated_at = now() where id = r.id;
        continue;
      exception when others then
        get stacked diagnostics detail = pg_exception_detail;
        -- A transient failure (SQLSTATE class 40: deadlock victim, serialization
        -- failure) is not a refusal: raised, nothing is committed, and the step
        -- is still pending for the next poll. Never a failed, already-paid run.
        if sqlstate like '40%' then
          raise;
        end if;
        if p_strict and s.step_index = 0 then
          raise;
        end if;
        -- BR-L-011: the plan's parallel runs all in use (NS429, 0034's hold
        -- trigger) or a balance short for this step (NS402, reserve_credits)
        -- passes: another job finishes, credits are added. The job and its hold
        -- were rolled back with this block, so the step waits, holding nothing.
        wait_ := sqlstate in ('NS429', 'NS402');
        why_code := case
          when sqlstate = 'NS402' then 'insufficient_credits'
          when sqlstate = 'NS429' then 'run_limit_reached'
          when sqlstate = '42501' then 'forbidden'
          when sqlstate in ('NS400', 'NS409') and sqlerrm ~ '^[a-z0-9_]{1,64}$' then sqlerrm
          else 'refused' end;
        why := left(coalesce(nullif(detail, ''), sqlerrm), 500);
      end;
    end if;

    -- BR-L-011: waiting, not failed. The step stays pending with the reason on
    -- record (written only when it changed, so a polling page does not rewrite
    -- it), later steps stay pending, and the run stays running. The next
    -- advance tries again; after 24 hours confirmation_expired (above) ends it.
    if wait_ then
      update public.workflow_run_steps set error_code = why_code, error = why
       where run_id = s.run_id and step_index = s.step_index and status = 'pending'
         and (error_code is distinct from why_code or error is distinct from why);
      exit;
    end if;

    -- This step could not start (or its input is missing): it fails, the run
    -- with it, and the steps after it are skipped without ever being created.
    update public.workflow_run_steps
       set status = 'failed', charged_credits = 0, error_code = why_code, error = why, finished_at = now()
     where run_id = s.run_id and step_index = s.step_index;
    update public.workflow_run_steps set status = 'skipped' where run_id = r.id and status = 'pending';
    update public.workflow_runs
       set status = 'failed', error_code = 'step_failed',
           error = format('step %s could not start (%s); later steps were not started and nothing was held for them',
                          s.step_index + 1, why_code),
           finished_at = now(), updated_at = now(),
           charged_credits = (select coalesce(sum(charged_credits), 0) from public.workflow_run_steps where run_id = r.id)
     where id = r.id returning * into r;
    exit;
  end loop;
  -- BR-L-011: a step that was waiting and is now skipped (Stop, or a step
  -- before it failed) never started; it keeps no waiting reason.
  update public.workflow_run_steps set error_code = null, error = null
   where run_id = r.id and status = 'skipped' and error_code is not null;
end
$$;

-- Grants: as 0073/0074 (restated because the function was replaced): no API role.
revoke all on function public.workflow_advance_locked(uuid, boolean) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   position('wait_ := sqlstate in (''NS429'', ''NS402'')' in pg_get_functiondef('public.workflow_advance_locked(uuid, boolean)'::regprocedure)) > 0
--     and position('idempotency_conflict' in pg_get_functiondef('public.workflow_advance_locked(uuid, boolean)'::regprocedure)) > 0
--     and position('confirmation_revoked' in pg_get_functiondef('public.workflow_advance_locked(uuid, boolean)'::regprocedure)) > 0
--     and position('confirmation_expired' in pg_get_functiondef('public.workflow_advance_locked(uuid, boolean)'::regprocedure)) > 0 as waits_not_fails,
--   not has_function_privilege('authenticated', 'public.workflow_advance_locked(uuid, boolean)', 'execute')
--     and not has_function_privilege('service_role', 'public.workflow_advance_locked(uuid, boolean)', 'execute')
--     and not has_function_privilege('anon', 'public.workflow_advance_locked(uuid, boolean)', 'execute') as grants_ok,
--   (select bool_and(p.proconfig @> array['search_path=public, pg_temp'])
--      from pg_proc p
--     where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname like '%workflow%') as search_path_pinned;
