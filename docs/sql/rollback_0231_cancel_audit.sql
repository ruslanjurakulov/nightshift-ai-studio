-- rollback_0231_cancel_audit.sql — takes migration 0231 (a workflow step's job is cancelled by the run's rule, every cancel and
-- every real stop is recorded, a browser writes no cancel row, a member takes no workflow step's key) out. OWNER-APPLY: paste into
-- the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK, verbatim: 0198's cancel_creative_job (any member cancels any job, a workflow step's included; nothing recorded),
--   0226's create_creative_job (a member may take a key beginning wf:), 0192's workflow_advance_locked (no step-key setting) and
--   0226's cancel_workflow_run (a call on a run that already ended writes a workflow.cancel row too); 0087's insert rule for the two
--   cancel actions (a browser may write them again). The rows 0231 wrote stay: they are the record of who cancelled.
-- REFUSES (changes nothing) if any of the four bodies is not 0231's (a later change would be undone).
--
-- The bodies (md5, whitespace runs read as one space; earlier -> 0231):
--   cancel_creative_job      2720d62c17ae26bce439a28280964575 (0198) -> c210f8e4684e154d40f7029b5c94b893
--   create_creative_job      ab939bb64ef626e30c1438c6030d8801 (0226) -> 88c83aa87050731c96ce8a0a5bb28b0a
--   workflow_advance_locked  553dd9f65b62541fd3653ed55288ae46 (0192) -> 37fda6dc6caf182483f10314d166579c
--   cancel_workflow_run      427ead0896b4881c0739b944997c6b50 (0226) -> c09c0dbdd8207bab0fc6d3175276fbf2

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.cancel_creative_job(uuid)', 'c210f8e4684e154d40f7029b5c94b893'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88c83aa87050731c96ce8a0a5bb28b0a'),
      ('public.workflow_advance_locked(uuid, boolean)', '37fda6dc6caf182483f10314d166579c'),
      ('public.cancel_workflow_run(uuid)', 'c09c0dbdd8207bab0fc6d3175276fbf2')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0231: % is not 0231''s body (md5 %): if an older file was re-run over it, apply 0231 again first, then roll back; if a later file changed it, take that file out first', r.sig, h;
    end if;
  end loop;
end $$;

-- cancel_creative_job: 0198's body, verbatim.
create or replace function public.cancel_creative_job(p_job uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j public.creative_jobs;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  -- Another organization's job reads as missing, not as forbidden: ids never
  -- confirm what exists elsewhere.
  -- 0198: a film take's job is cancelled with its film (film_cancel_segment), never by a member here: it reads as missing.
  if not found or not public.is_org_member(j.org_id) or j.payer = 'film' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.credit_account_lock(j.org_id);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.status in ('cancelled', 'failed', 'expired', 'completed') then
    return jsonb_build_object('job', public.creative_job_json(j), 'released', 0,
                              'already', true);
  end if;
  if not (j.status = 'queued' and j.provider_task_id is null and j.submit_started_at is null)
     and not (j.status = 'running' and j.submit_started_at is null) then
    perform public.creative_refuse('not_cancellable',
      'the provider is already working on this job', 'NS409');
  end if;
  perform public.creative_end_locked(p_job, 'cancelled', 'cancelled', 'cancelled by a member');
  select * into j from public.creative_jobs where id = p_job;
  return jsonb_build_object('job', public.creative_job_json(j), 'already', false);
end
$$;

-- create_creative_job: 0226's body, verbatim.
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
  -- 0226 (the owner's decision, 22 Nov; 0215's is_org_spender): spending an organization's credits takes a seat in it. 0043's
  -- accessible_org_ids makes a platform owner or admin an admin of every organization; that stays read-only support access. In the
  -- exempt organization the credits are the platform's own, so its platform owner or admin may, as before. Asked of the session's person, an API key's or a connected app's (api_act_as) and a workflow's confirmer
  -- (workflow_advance_locked acts as them), before the account is locked, a replay answered or anything priced or held.
  if not public.is_org_spender(p_org, 'viewer') then
    perform public.creative_refuse('not_a_member', 'you are not a member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
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
  -- 0192: after the price and before 0174's acknowledgement, the ceiling, the hold and the job row: a person who said they are
  -- under 18 is refused every model (adult_only_service), and a requires_adult model is refused to a person without an adult
  -- attestation (adult_attestation_required). The person is auth.uid(): the session, or the key's / grant's person for the API
  -- and MCP (api_act_as). A replay of a job already created was answered above; a routed pick was made without such a model.
  perform public.adult_attestation_gate(uid, q ->> 'model');
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

-- workflow_advance_locked: 0192's body, verbatim.
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
  -- 0192: the session's claims while a later step is made as the member who confirmed the run (see below).
  saved_c  text;  -- 0192
  saved_s  text;  -- 0192
  saved_e  text;  -- 0192
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
        -- 0192: a step spends on the confirmation of the member who pressed Run now (BR-L-006), so it is made AS that member:
        -- create_creative_job's gates (the adult answer, membership, rights acknowledgements) read the confirmer, never whoever's
        -- page carries the run on. A minor viewer neither fails an adult's paid run nor, as an adult viewer, makes an adults-only
        -- step for a member without an answer (or a paid one for a member who answered "under 18" after Run now). Only this
        -- internal function acts as the confirmer, and only for a run of theirs; a direct create_creative_job is still the caller's.
        saved_c := current_setting('request.jwt.claims', true);
        saved_s := current_setting('request.jwt.claim.sub', true);
        saved_e := current_setting('request.jwt.claim.email', true);
        perform public.api_act_as(r.started_by);
        out_ := public.create_creative_job(
          r.org_id, s.capability, s.model, params, 'exact',
          'wf:' || r.id::text || ':' || s.step_index::text, s.quoted_credits);
        -- 0192: the session is the viewer's again (on a refusal the block's rollback puts the claims back by itself).
        perform set_config('request.jwt.claims', coalesce(saved_c, ''), true);
        perform set_config('request.jwt.claim.sub', coalesce(saved_s, ''), true);
        perform set_config('request.jwt.claim.email', coalesce(saved_e, ''), true);
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

-- cancel_workflow_run: 0226's body, verbatim.
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
  -- 0226 (Atlas, 27 Nov): platform staff may stop a run in any organization (they may restrict, never widen), so who stopped it is
  -- recorded here, in the database, for every caller (a direct call never passed the route's own log): the audit row names the
  -- actor (app_audit_log_stamp writes the signed-in person) and the run's organization. Nothing else changes.
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'workflow.cancel', p_run::text,
          jsonb_build_object('org_id', r.org_id, 'status', r.status));
  return public.workflow_run_json(p_run);
end
$$;

revoke all on function public.cancel_creative_job(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_creative_job(uuid) to authenticated;
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;
revoke all on function public.workflow_advance_locked(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.cancel_workflow_run(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_workflow_run(uuid) to authenticated;

drop policy if exists app_audit_log_no_cancel_rows on public.app_audit_log;

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.cancel_creative_job(uuid)', '2720d62c17ae26bce439a28280964575'),
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'ab939bb64ef626e30c1438c6030d8801'),
      ('public.workflow_advance_locked(uuid, boolean)', '553dd9f65b62541fd3653ed55288ae46'),
      ('public.cancel_workflow_run(uuid)', '427ead0896b4881c0739b944997c6b50')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0231 end state: % is not the earlier body (md5 %)', r.sig, h;
    end if;
  end loop;
  if exists (select 1 from pg_policy where polrelid = 'public.app_audit_log'::regclass and polname = 'app_audit_log_no_cancel_rows') then
    raise exception 'rollback 0231 end state: the policy app_audit_log_no_cancel_rows is still there';
  end if;
end $$;

commit;
