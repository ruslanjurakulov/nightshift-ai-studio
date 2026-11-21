-- 0074_workflow_lens2.sql — workflow runs: a step never adopts a job it did not
-- make, advance and cancel take the locks in Run now's order, a transient error
-- is never a failed run, and a later step needs a confirmer who may still spend.
--
-- Security fixes for migration 0073 (independent review LENS-2):
--   BR-L-005  A step "started" by replaying any job that already held its key
--             'wf:<run>:<n>' (run ids and step params are readable by members;
--             a key replay answers before the price check), skipping the step's
--             confirmed price and, if that job cost more, jamming the run on the
--             CHECK charged <= quoted. A replay is now refused as
--             'idempotency_conflict'. Also: Run now's replay took the credit
--             account, then the run; advance and cancel took the run, then the
--             account (inside create/cancel_creative_job): a deadlock, which the
--             step's WHEN OTHERS turned into a committed failed run after earlier
--             steps were already charged. advance and cancel now take the
--             account first, and SQLSTATE class 40 is re-raised.
--   BR-L-006  Steps 2..6 started in the session of whoever had the run page
--             open, even after the member who confirmed the price was removed
--             or lost the right to run things. A later step now starts only
--             while started_by may still spend in the run's organization; else
--             it fails 'confirmation_revoked' and nothing more is held.
--
-- Additive. The three replaced functions are 0073's bodies (the latest; nothing
-- later replaces them) with only the lines above added: every check and string
-- of 0073 stays (pinned by tests/test_workflow_lens2_migration.py).
-- Apply after 0073.

-- May p_user (a run's started_by) still spend in p_org? accessible_org_ids(),
-- platform_role() and is_platform_admin() (0018, 0043) answered for p_user
-- instead of auth.uid(): a platform owner/admin in every organization; any
-- platform role at editor or above in the default organization; else a bound
-- org_members row at editor or above in p_org itself. The operator's
-- organization is paid by the platform, so there only a platform owner/admin
-- (what start_workflow_run requires).
create or replace function public.workflow_confirmer_may_spend(p_user uuid, p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  with pr as (
    select case
      when public.app_members_empty() then
        case when exists (select 1 from public.org_members m
                           where m.org_id = public.default_org_id() and m.user_id = p_user) then 'owner' end
      else coalesce(
        (select a.role from public.app_members a where a.user_id = p_user),
        (select a.role from public.app_members a, auth.users u
          where u.id = p_user and u.email_confirmed_at is not null
            and a.user_id is null
            and nullif(lower(btrim(coalesce(u.email, ''))), '') is not null
            and lower(a.email) = lower(btrim(u.email))
          limit 1))
    end as role
  )
  select p_user is not null and p_org is not null and (
    case when public.credits_exempt(p_org) then
      exists (select 1 from pr where pr.role in ('owner', 'admin'))
    else
      exists (select 1 from pr where pr.role in ('owner', 'admin'))
      or (p_org = public.default_org_id()
          and exists (select 1 from pr where public.app_role_rank(pr.role) >= public.app_role_rank('editor')))
      or exists (select 1 from public.org_members m
                  where m.org_id = p_org and m.user_id = p_user
                    and public.app_role_rank(m.role) >= public.app_role_rank('editor'))
    end)
$$;

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
        why_code := case
          when sqlstate = 'NS402' then 'insufficient_credits'
          when sqlstate = 'NS429' then 'run_limit_reached'
          when sqlstate = '42501' then 'forbidden'
          when sqlstate in ('NS400', 'NS409') and sqlerrm ~ '^[a-z0-9_]{1,64}$' then sqlerrm
          else 'refused' end;
        why := left(coalesce(nullif(detail, ''), sqlerrm), 500);
      end;
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
end
$$;

-- Carry a run forward: settle the step that finished and start the next. Safe to
-- call as often as the page likes — it starts nothing that has started, and a
-- step's job carries the idempotency key 'wf:<run>:<step>'.
create or replace function public.advance_workflow_run(p_run uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.workflow_runs;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.workflow_runs where id = p_run;
  if not found or not public.is_org_member(r.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(r.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if public.credits_exempt(r.org_id) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The account, then the run (inside workflow_advance_locked): the order
  -- Run now takes, so a re-sent Run now and this poll queue instead of
  -- deadlocking (BR-L-005).
  perform public.credit_account_lock(r.org_id);
  perform public.workflow_advance_locked(p_run);
  return public.workflow_run_json(p_run);
end
$$;

-- Stop a run: steps not started are skipped (nothing was held for them), the
-- step being made is cancelled if the provider has not started on it, and
-- otherwise finishes and is charged like any job.
create or replace function public.cancel_workflow_run(p_run uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.workflow_runs;
  s public.workflow_run_steps;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.workflow_runs where id = p_run;
  if not found or not public.is_org_member(r.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(r.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The account, then the run: the order Run now and advance take (BR-L-005).
  perform public.credit_account_lock(r.org_id);
  select * into r from public.workflow_runs where id = p_run for update;
  if r.status = 'running' then
    update public.workflow_runs set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
     where id = p_run;
    select * into s from public.workflow_run_steps where run_id = p_run and status = 'running';
    if found then
      begin
        perform public.cancel_creative_job(s.job_id);
      exception when others then
        -- A transient failure is raised (nothing committed; Stop can be pressed again).
        if sqlstate like '40%' then
          raise;
        end if;
        -- Already with the provider (not_cancellable): it runs to the end.
        null;
      end;
    end if;
    perform public.workflow_advance_locked(p_run);
  end if;
  return public.workflow_run_json(p_run);
end
$$;

-- Grants: as 0073 (restated because the functions were replaced); none for the
-- new internal helper.
revoke all on function public.workflow_confirmer_may_spend(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.workflow_advance_locked(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.advance_workflow_run(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_workflow_run(uuid) from public, anon, authenticated, service_role;
grant execute on function public.advance_workflow_run(uuid) to authenticated;
grant execute on function public.cancel_workflow_run(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   position('idempotency_conflict' in pg_get_functiondef('public.workflow_advance_locked(uuid, boolean)'::regprocedure)) > 0
--     and position('confirmation_revoked' in pg_get_functiondef('public.workflow_advance_locked(uuid, boolean)'::regprocedure)) > 0
--     and position('sqlstate like' in pg_get_functiondef('public.workflow_advance_locked(uuid, boolean)'::regprocedure)) > 0 as advance_fixed,
--   position('credit_account_lock' in pg_get_functiondef('public.advance_workflow_run(uuid)'::regprocedure)) > 0
--     and position('credit_account_lock' in pg_get_functiondef('public.cancel_workflow_run(uuid)'::regprocedure)) > 0 as lock_order_fixed,
--   not has_function_privilege('authenticated', 'public.workflow_confirmer_may_spend(uuid, uuid)', 'execute')
--     and not has_function_privilege('service_role', 'public.workflow_confirmer_may_spend(uuid, uuid)', 'execute')
--     and has_function_privilege('authenticated', 'public.advance_workflow_run(uuid)', 'execute')
--     and not has_function_privilege('anon', 'public.cancel_workflow_run(uuid)', 'execute') as grants_ok,
--   (select bool_and(p.proconfig @> array['search_path=public, pg_temp'])
--      from pg_proc p
--     where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname like '%workflow%') as search_path_pinned;
