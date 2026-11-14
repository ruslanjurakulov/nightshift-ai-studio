-- rollback_0175_failed_job_cap.sql — takes migration 0175 (at most 5 failed or refused creative jobs per organization per
-- rolling 24 hours) out of the job start path.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK: 0174's create_creative_job, start_workflow_run and api_creative_refusal, and 0083's workflow_advance_locked,
--   none of which counts failures. Applying this re-opens the unbounded loop 0175 closed (a refused job releases its hold, so a
--   customer pays nothing for it while a vendor may bill us): apply it only to undo a broken 0175, and apply 0175 again after.
-- WHAT IS LOST: creative_failed_job_codes(), creative_failed_job_gate() and the index creative_jobs_failed_window_idx. 0175
--   writes no row, so nothing else is undone.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the four bodies is not 0175's (a later change would be undone).
--   1. Puts the four earlier bodies back, verbatim, with their grants.
--   2. Drops the two 0175 functions and the index.
--   3. Asserts the end state.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '1ddd39a69de4153e36d02aa372ed5e60'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '3a7d8eb57e48badff9ab7e321e6c52f6'),
      ('public.workflow_advance_locked(uuid, boolean)', 'b46b5f42927697ebbb8176f8ce527c6d'),
      ('public.api_creative_refusal(text, text, text)', 'a5db9f56ba2e83c285beaace621217d8')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0175: % is not 0175''s body (md5 %): a later change would be undone; read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- create_creative_job: 0174's body, verbatim (0174_rights_acknowledgement.sql).
create or replace function public.create_creative_job(
  p_org uuid,
  p_capability text,
  p_model text,
  p_params jsonb default '{}'::jsonb,
  p_mode text default 'exact',
  p_idempotency_key text default null,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid   uuid := auth.uid();
  md    text := lower(btrim(coalesce(p_mode, 'exact')));
  idem  text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  hash_ text;
  prior public.creative_jobs;
  q     jsonb;
  price numeric;
  jid   uuid := gen_random_uuid();
  ref   text;
  res   jsonb;
  j     public.creative_jobs;
  jparams jsonb;
  -- 0075: the router's pick and the surface it was made for.
  surf  text;
  rt    jsonb;
  -- 0174: the first input this person has not acknowledged, for a model that requires an acknowledgement.
  ack   jsonb;
begin
  if uid is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The exempt organization's generations are paid by the platform itself,
  -- and every account that existed before 0018 is a member of it: only a
  -- platform owner/admin may spend there (reserve_credits asks for its admins
  -- too, before answering exempt).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'generations in the operator''s organization are started by a platform admin';
  end if;
  if md not in ('exact', 'auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be exact, auto, cheap, fast or quality');
  end if;
  -- Router modes need route_model() and failover, which are not built yet: a
  -- job only ever runs the model the person picked.
  -- 0075: they are built (route_model): this refusal now stands only for a
  -- database without the router.
  if md <> 'exact' and to_regprocedure('public.route_model(text, jsonb, text, uuid, text)') is null then
    perform public.creative_refuse('mode_not_supported',
      'only exact mode (the model you picked) is available on this deployment');
  end if;
  if idem is not null and idem !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    perform public.creative_refuse('invalid_idempotency_key',
      'idempotency key: 1-255 characters of A-Z a-z 0-9 _ : . -');
  end if;

  -- The org's credit account, locked for the rest of this transaction: every
  -- create (and reserve_credits itself) for this org queues behind it, so two
  -- concurrent creates cannot both spend the same available credits, and a
  -- replay of the same idempotency key finds the first one's committed row.
  perform public.credit_account_lock(p_org);

  hash_ := md5(jsonb_build_object('capability', lower(btrim(coalesce(p_capability, ''))),
                                  'model', lower(btrim(coalesce(p_model, ''))),
                                  'mode', md, 'params', coalesce(p_params, 'null'::jsonb))::text);
  if idem is not null then
    select * into prior from public.creative_jobs
     where org_id = p_org and idempotency_key = idem;
    if found then
      if prior.request_hash is distinct from hash_ then
        perform public.creative_refuse('idempotency_conflict',
          'this idempotency key was used for a different request', 'NS409');
      end if;
      return jsonb_build_object('job', public.creative_job_json(prior), 'replay', true);
    end if;
  end if;

  -- Holds of this org's jobs that nobody will run give their credits back
  -- before this one is checked against the balance.
  perform public.creative_expire_locked(p_org);

  -- 0075: a routed job (auto / cheap / fast / quality) runs the model its quote
  -- named, at the price it showed, and nothing else. Both come back with the
  -- press; the router is asked again here, under the account lock, and a
  -- different pick (a price, a probe or a plan changed since the quote) is
  -- refused for a new quote, never run in its place. The surface is the web
  -- unless api_creative_create said otherwise for this transaction (it can
  -- only narrow the list: the API sells a subset of the web's models).
  if md <> 'exact' then
    if nullif(btrim(coalesce(p_model, '')), '') is null or p_max_credits is null then
      perform public.creative_refuse('invalid_params',
        'a routed job names the model and the price its quote showed: quote first, then confirm both');
    end if;
    surf := coalesce(nullif(current_setting('nightshift.creative_surface', true), ''), 'web');
    if surf not in ('web', 'api', 'mcp') then
      surf := 'web';
    end if;
    rt := public.route_model(p_capability, p_params, md, p_org, surf);
    if (rt ->> 'model') is distinct from lower(btrim(p_model)) then
      perform public.creative_refuse('route_changed',
        'the automatic choice changed since the quote; quote again and confirm the new choice', 'NS409');
    end if;
  end if;

  q := public.creative_price(p_org, p_capability, p_model, p_params);
  price := (q ->> 'credits')::numeric;
  -- 0174: a model whose provider (or the law) makes the person confirm their rights to an input refuses here: after the
  -- price (a model refused anyway never asks) and before the ceiling, the hold and the job row, unless THIS person
  -- acknowledged THIS input in THIS organization at the CURRENT text version (rights_acknowledgement_missing). A replay of
  -- a job already created was answered above.
  ack := public.rights_acknowledgement_missing(p_org, uid, q ->> 'model', p_params);
  if ack is not null then
    perform public.creative_refuse('acknowledgement_required',
      format('kind=%s version=%s subject=%s', ack ->> 'kind', coalesce(ack ->> 'text_version', 'none'), ack ->> 'subject'));
  end if;
  if p_max_credits is not null and price > p_max_credits then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', price, p_max_credits), 'NS409');
  end if;

  -- The tier the quote priced is the tier the job carries (0060): stored in
  -- the job's params so the worker sends EXACTLY it and never a default of its
  -- own. Absent from the request = the quote's default, written down here.
  jparams := p_params;
  if q ? 'quality' then
    jparams := coalesce(p_params, '{}'::jsonb) || jsonb_build_object('quality', q ->> 'quality');
  end if;
  -- Likewise the resolution and soundtrack of a video (0070): written down as
  -- priced, so the worker sends exactly them and never a default of its own.
  if q ? 'resolution' then
    jparams := coalesce(jparams, '{}'::jsonb) || jsonb_build_object('resolution', q ->> 'resolution');
  end if;
  if q ? 'audio' then
    jparams := coalesce(jparams, '{}'::jsonb) || jsonb_build_object('audio', (q ->> 'audio')::boolean);
  end if;

  ref := 'cj:' || jid::text;
  if price > 0 then
    -- NS402 'insufficient credits' (available=… needed=…) comes from here.
    res := public.creative_platform_reserve(p_org, ref, price);
    if coalesce((res ->> 'exempt')::boolean, false) then
      ref := null;
    end if;
  else
    ref := null;
  end if;

  insert into public.creative_jobs
    (id, org_id, kind, capability, mode, requested_model, routed_model, params, status,
     payer, credit_ref, credit_unit, quantity, quoted_credits, idempotency_key, request_hash,
     requested_by, expires_at)
  values
    (jid, p_org, 'generate', q ->> 'capability', md, q ->> 'model', q ->> 'model',
     jparams, 'queued', 'credits', ref, q ->> 'unit', (q ->> 'quantity')::numeric, price,
     idem, hash_, uid, now() + interval '2 hours')
  returning * into j;
  -- 0075: what the router decided, written by this function only. The
  -- hold is the pick's price, like exact (BR-L-020): max_credits only
  -- refused a higher one. Members read the reason; the candidates are
  -- the platform's (creative_job_routes, BR-L-022).
  if md <> 'exact' then
    update public.creative_jobs
       set routed_credits = price,
           routing = jsonb_build_object('reason', rt ->> 'reason', 'surface', surf)
     where id = jid
    returning * into j;
    insert into public.creative_job_routes (job_id, quality_tier, candidates, tried)
    values (jid, coalesce((rt ->> 'quality_tier')::numeric, 0), coalesce(rt -> 'candidates', '[]'::jsonb),
            jsonb_build_array(rt ->> 'model'));
    perform public.creative_job_log(jid, p_org, 'routed', 'queued',
      jsonb_build_object('mode', md, 'model', rt ->> 'model', 'reason', rt ->> 'reason',
                         'credits', price));
  end if;
  perform public.creative_job_log(jid, p_org, 'created', 'queued',
    jsonb_build_object('quoted_credits', price, 'held', ref is not null));

  return jsonb_build_object('job', public.creative_job_json(j), 'replay', false);
end
$$;
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;

-- start_workflow_run: 0174's body, verbatim.
create or replace function public.start_workflow_run(
  p_run uuid,
  p_workflow uuid,
  p_version integer,
  p_inputs jsonb default '{}'::jsonb,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  w       public.workflows;
  prior   public.workflow_runs;
  vals    jsonb;
  hash_   text;
  q       jsonb;
  total   numeric;
  acc     public.credit_accounts;
  st      record;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_run is null then
    perform public.creative_refuse('invalid_params', 'a run id is required');
  end if;
  select * into w from public.workflows where id = p_workflow;
  if not found or w.archived_at is not null or not public.is_org_member(w.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(w.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid by the platform: only a platform admin
  -- spends there (create_creative_job asks the same of every step).
  if public.credits_exempt(w.org_id) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'runs in the operator''s organization are started by a platform admin';
  end if;
  if p_max_credits is null or p_max_credits < 0 then
    perform public.creative_refuse('confirm_price', 'the confirmed total is required');
  end if;

  -- The account first: every create (and reserve) for this organization queues
  -- behind it, so a replay of the same run finds the first one's committed rows.
  perform public.credit_account_lock(w.org_id);

  hash_ := md5(jsonb_build_object('workflow', p_workflow, 'inputs', coalesce(p_inputs, '{}'::jsonb),
                                  'max', round(p_max_credits, 2)::text)::text);
  select * into prior from public.workflow_runs where id = p_run;
  if found then
    -- The same id under another organization, another workflow, other inputs or
    -- another confirmed total is a different request: refused without saying
    -- anything about what it collided with.
    if prior.org_id <> w.org_id or prior.request_hash is distinct from hash_ then
      perform public.creative_refuse('idempotency_conflict',
        'this run id was used for a different request', 'NS409');
    end if;
    perform public.workflow_advance_locked(prior.id);
    return public.workflow_run_json(prior.id) || jsonb_build_object('replay', true);
  end if;

  if p_version is distinct from w.version then
    perform public.creative_refuse('workflow_changed',
      format('the workflow is now version %s, not %s', w.version, p_version), 'NS409');
  end if;

  vals := public.workflow_bind_inputs(w, p_inputs);
  q := public.workflow_quote_steps(w, vals);
  -- 0174: named, before the generic 'unpriced': which steps need the Studio's acknowledgement (workflow_quote_steps).
  if exists (select 1 from jsonb_array_elements(q -> 'steps') e where e.value ->> 'reason' = 'acknowledgement_required') then
    perform public.creative_refuse('acknowledgement_required',
      format('step(s) %s use a model that asks you to confirm your rights to its input; make them in the Studio',
             (select string_agg(((e.value ->> 'step_index')::integer + 1)::text, ', ') from jsonb_array_elements(q -> 'steps') e
               where e.value ->> 'reason' = 'acknowledgement_required')));
  end if;
  if not (q ->> 'priced')::boolean then
    perform public.creative_refuse('unpriced',
      format('step(s) %s cannot be priced, so the workflow has no price',
             (select string_agg((u.x::integer + 1)::text, ', ') from jsonb_array_elements_text(q -> 'unpriced_steps') u(x))));
  end if;
  total := (q ->> 'total')::numeric;
  if round(p_max_credits, 2) <> round(total, 2) then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', total, round(p_max_credits, 2)), 'NS409');
  end if;
  if not public.credits_exempt(w.org_id) then
    select * into acc from public.credit_accounts where org_id = w.org_id;
    if coalesce(acc.balance - acc.reserved, 0) < total then
      perform public.creative_refuse('insufficient_credits',
        format('available=%s needed=%s', coalesce(acc.balance - acc.reserved, 0), total), 'NS402');
    end if;
  end if;

  insert into public.workflow_runs
    (id, org_id, workflow_id, workflow_name, workflow_version, inputs, max_credits, request_hash, started_by)
  values
    (p_run, w.org_id, w.id, w.name, w.version, vals, round(total, 2), hash_, uid);
  for st in select v, ord from jsonb_array_elements(w.steps) with ordinality as t(v, ord) loop
    insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, quoted_credits)
    values (p_run, st.ord - 1, w.org_id, st.v ->> 'capability', st.v ->> 'model',
            public.workflow_fill_params(st.v -> 'params', vals),
            (q -> 'steps' -> (st.ord - 1)::integer ->> 'credits')::numeric);
  end loop;

  perform public.workflow_advance_locked(p_run, true);
  return public.workflow_run_json(p_run) || jsonb_build_object('replay', false);
end
$$;
revoke all on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) from public, anon, authenticated, service_role;
grant execute on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated;

-- workflow_advance_locked: 0083's body, verbatim (0083_workflow_wait.sql).
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
revoke all on function public.workflow_advance_locked(uuid, boolean) from public, anon, authenticated, service_role;

-- api_creative_refusal: 0174's body, verbatim.
create or replace function public.api_creative_refusal(p_state text, p_msg text, p_detail text)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  word text := btrim(coalesce(p_msg, ''));
  det  text := left(coalesce(p_detail, ''), 300);
  m    text[];
  extra jsonb := case when det <> '' and det <> word then jsonb_build_object('detail', det) else '{}'::jsonb end;
begin
  case p_state
    when '42501' then
      return public.api_err(403, 'forbidden', 'This key may not start generations in this organization.');
    when 'P0002' then
      return public.api_err(404, 'job_not_found', 'No generation with that id for this key.');
    when '22023' then
      return public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.');
    when 'NS402' then
      m := regexp_match(coalesce(p_detail, ''), 'available=(-?[0-9.]+)\s+needed=([0-9.]+)');
      return public.api_err(402, 'insufficient_credits',
        'The organization does not have enough credits for this generation. Nothing was held.',
        case when m is null then '{}'::jsonb
             else jsonb_build_object('available_credits', m[1]::numeric, 'needed_credits', m[2]::numeric) end);
    when 'NS429' then
      m := regexp_match(coalesce(p_detail, ''), 'active=([0-9]+)\s+limit=([0-9]+)');
      return public.api_err(429, 'run_limit_reached',
        'All of the plan''s parallel runs are in use. Wait for one to finish.',
        jsonb_build_object('retry_after', 60) || case when m is null then '{}'::jsonb
             else jsonb_build_object('active', m[1]::int, 'limit', m[2]::int) end);
    when 'NS409' then
      if word = 'price_changed' then
        return public.api_err(409, 'price_changed',
          'The price is now above max_credits. Quote again and confirm the new price.', extra);
      elsif word = 'idempotency_conflict' then
        return public.api_err(422, 'idempotency_key_reused',
          'This Idempotency-Key was already used for a different generation.');
      -- 0075: the router's pick changed since the quote.
      elsif word = 'route_changed' then
        return public.api_err(409, 'route_changed',
          'The automatic choice changed since the quote. Quote again and confirm the new choice.', extra);
      end if;
    when 'NS400' then
      return case word
        when 'registry_missing' then public.api_err(503, 'registry_missing', 'The model registry is not set up on this deployment.')
        when 'model_not_sellable' then public.api_err(422, 'model_not_sellable', 'That model is not available for this capability through the API.', extra)
        when 'entitlement_required' then public.api_err(403, 'entitlement_required', 'The organization''s plan does not include this model.', extra)
        when 'unpriced' then public.api_err(422, 'unpriced', 'That model has no price yet, so it cannot be sold.')
        when 'capability_not_supported' then public.api_err(422, 'capability_not_supported', 'That capability cannot be generated on this deployment.', extra)
        when 'source_unavailable' then public.api_err(422, 'source_unavailable', 'A media-library file in the request is not available to this organization.', extra)
        -- 0174: the model needs the person to confirm their rights to an input file; the API has no call for that.
        when 'acknowledgement_required' then public.api_err(428, 'acknowledgement_required', 'This model needs a person to confirm, in the Studio, their rights to the input file (for example the consent of every person shown). Confirm it there, then retry. Nothing was held or charged.', extra)
        when 'style_unavailable' then public.api_err(422, 'style_unavailable', 'The style kit in the request is not available to this organization.')
        when 'mode_not_supported' then public.api_err(422, 'mode_not_supported', 'Only mode "exact" (the model you named) is available.')
        -- 0075: no available, priced model of this plan takes these settings.
        when 'no_model_available' then public.api_err(422, 'no_model_available', 'No available, priced model can make this with these settings.', extra)
        -- 0124: the owner switched this model off for now. Nothing was held or charged; the caller chooses another or waits.
        when 'model_temporarily_off' then public.api_err(503, 'model_temporarily_off', 'That model is temporarily unavailable. Nothing was held or charged. Choose another model, or try again later.', extra)
        when 'invalid_idempotency_key' then public.api_err(400, 'invalid_idempotency_key', 'Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -')
        else public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.', extra)
      end;
    else
      null;
  end case;
  return public.api_err(500, 'internal_error',
    'The request failed inside the database. Nothing was created or charged; retry with backoff.');
end
$$;
revoke all on function public.api_creative_refusal(text, text, text) from public, anon, authenticated, service_role;

drop function if exists public.creative_failed_job_gate(uuid);
drop function if exists public.creative_failed_job_codes();
drop index if exists public.creative_jobs_failed_window_idx;

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88107b00b0a8c143606ed17f5898c98d'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '8b3c4b4afbc19e6f336c09b4692ad7ed'),
      ('public.workflow_advance_locked(uuid, boolean)', '2d63f9fb091efa71d8ae466cba0b42db'),
      ('public.api_creative_refusal(text, text, text)', 'e6ec45d0d912389a05eb2d40261c2c2a')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception 'rollback 0175 end state: % is not its earlier body', r.sig;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.workflow_advance_locked(uuid, boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_creative_refusal(text, text, text)', 'EXECUTE') then
    raise exception 'rollback 0175 end state: the grants are not the earlier ones';
  end if;
  if to_regprocedure('public.creative_failed_job_gate(uuid)') is not null
     or to_regprocedure('public.creative_failed_job_codes()') is not null
     or to_regclass('public.creative_jobs_failed_window_idx') is not null then
    raise exception 'rollback 0175 end state: a 0175 function or the index is still there';
  end if;
end $$;

commit;
