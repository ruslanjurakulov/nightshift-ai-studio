-- rollback_0174_rights_acknowledgement.sql — takes migration 0174 (the rights acknowledgement step) out of the job start path.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK: 0075's create_creative_job, 0073's workflow_quote_steps and start_workflow_run and 0124's api_creative_refusal,
--   none of which asks for an acknowledgement. A model that requires one then starts without it: apply this only while no such
--   model is on sale (today runway-gen4.5 and runway-gen4-turbo require likeness_photo and are not sold).
-- WHAT IS KEPT: the record. rights_acknowledgements (its rows and its append-only triggers), rights_acknowledgement_kinds and the
--   model_registry.requires_acknowledgement column stay as they are: who took responsibility for what must outlive a rollback.
--   Applying 0174 again picks them up as its own.
-- WHAT IS LOST: acknowledge_rights, rights_acknowledgement_status, the two helpers, and model_registry_requirement_guard with its
--   trigger (the column can then be lowered again). The Studio's acknowledgement dialog then answers "not available".
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the four bodies is not 0174's (a later change would be undone).
--   1. Puts the four earlier bodies back, verbatim, with their grants.
--   2. Drops the five 0174 functions and the requirement guard trigger.
--   3. Asserts the end state.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  -- 0179 calls rights_acknowledgement_missing and rights_acknowledgement_required from reroute_creative_job, start_film,
  -- workflow_quote_steps and creative_job_style: dropping them under it would break every film start and failover.
  if to_regprocedure('public.rights_acknowledgement_subjects(uuid, jsonb)') is not null then
    raise exception 'rollback 0174: 0179 is applied on top of it; apply docs/sql/rollback_0179_rights_acknowledgement_inputs.sql first';
  end if;
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88107b00b0a8c143606ed17f5898c98d'),
      ('public.workflow_quote_steps(public.workflows, jsonb)', '8f9f42da9844571a18a285d87bcffc84'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '8b3c4b4afbc19e6f336c09b4692ad7ed'),
      ('public.api_creative_refusal(text, text, text)', 'e6ec45d0d912389a05eb2d40261c2c2a')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0174: % is not 0174''s body (md5 %): a later change would be undone; read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- create_creative_job: 0075's body, verbatim (0075_model_router.sql).
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

-- workflow_quote_steps: 0073's body, verbatim (0073_workflow_apps.sql).
create or replace function public.workflow_quote_steps(p_wf public.workflows, p_values jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  st      record;
  params  jsonb;
  stand   text;
  q       jsonb;
  steps_  jsonb := '[]'::jsonb;
  total   numeric := 0;
  bad     integer[] := '{}';
  chained boolean;
  acc     public.credit_accounts;
begin
  for st in select v, ord from jsonb_array_elements(p_wf.steps) with ordinality as t(v, ord) loop
    chained := exists (select 1 from jsonb_each(st.v -> 'params') e
                        where jsonb_typeof(e.value) = 'object' and e.value ? '$step');
    stand := null;
    if chained then
      select a.id::text into stand
        from public.media_assets a
       where a.org_id = p_wf.org_id and a.kind = 'image'
         and a.deleted_at is null and a.purged_at is null
         and public.creative_picture_problem(p_wf.org_id, a.id, 'source_asset_id') is null
       order by a.created_at desc, a.id
       limit 1;
    end if;
    params := public.workflow_fill_params(st.v -> 'params', p_values, stand);
    begin
      if chained and stand is null then
        raise exception 'source_unavailable' using errcode = 'NS400';
      end if;
      q := public.creative_price(p_wf.org_id, st.v ->> 'capability', st.v ->> 'model', params);
      steps_ := steps_ || jsonb_build_array(jsonb_build_object(
        'step_index', st.ord - 1, 'capability', st.v ->> 'capability', 'model', st.v ->> 'model',
        'priced', true, 'credits', (q ->> 'credits')::numeric, 'unit', q ->> 'unit',
        'quantity', (q ->> 'quantity')::numeric, 'chained', chained));
      total := total + (q ->> 'credits')::numeric;
    exception when others then
      -- Never a zero: the step is unpriced and carries the database's own
      -- machine word (unpriced, model_not_sellable, source_unavailable, …).
      steps_ := steps_ || jsonb_build_array(jsonb_build_object(
        'step_index', st.ord - 1, 'capability', st.v ->> 'capability', 'model', st.v ->> 'model',
        'priced', false, 'credits', null,
        'reason', case when sqlerrm ~ '^[a-z0-9_]{1,64}$' then sqlerrm else 'unpriced' end,
        'chained', chained));
      bad := bad || (st.ord - 1)::integer;
    end;
  end loop;
  select * into acc from public.credit_accounts where org_id = p_wf.org_id;
  return jsonb_build_object(
    'workflow_id', p_wf.id, 'version', p_wf.version, 'steps', steps_,
    'priced', cardinality(bad) = 0,
    'total', case when cardinality(bad) = 0 then total end,
    'unpriced_steps', to_jsonb(bad),
    'exempt', public.credits_exempt(p_wf.org_id),
    'available', case when public.credits_exempt(p_wf.org_id) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;
revoke all on function public.workflow_quote_steps(public.workflows, jsonb) from public, anon, authenticated, service_role;

-- start_workflow_run: 0073's body, verbatim (0073_workflow_apps.sql).
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

-- api_creative_refusal: 0124's body, verbatim (0124_model_switch.sql).
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

drop trigger if exists model_registry_requirement_guard on public.model_registry;
drop function if exists public.model_registry_requirement_guard();
drop function if exists public.acknowledge_rights(text, text, text, text);
drop function if exists public.rights_acknowledgement_status(uuid, text, text[]);
drop function if exists public.rights_acknowledgement_missing(uuid, uuid, text, jsonb);
drop function if exists public.rights_acknowledgement_required(text);

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '4c74918fd9d938c8fe4f5a3d26a09d84'),
      ('public.workflow_quote_steps(public.workflows, jsonb)', '48250650e93a951c6b64cad1e73e8a24'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', 'c60ad7a487f7f11bf080ef92629c436e'),
      ('public.api_creative_refusal(text, text, text)', '2253296a9c1ac2e5de3c25a2a726398e')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception 'rollback 0174 end state: % is not its earlier body', r.sig;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.workflow_quote_steps(public.workflows, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_creative_refusal(text, text, text)', 'EXECUTE') then
    raise exception 'rollback 0174 end state: the grants are not the earlier ones';
  end if;
  if to_regprocedure('public.acknowledge_rights(text, text, text, text)') is not null
     or to_regprocedure('public.rights_acknowledgement_status(uuid, text, text[])') is not null
     or to_regprocedure('public.model_registry_requirement_guard()') is not null then
    raise exception 'rollback 0174 end state: a 0174 function is still there';
  end if;
  if to_regclass('public.rights_acknowledgements') is null then
    raise exception 'rollback 0174 end state: the record (rights_acknowledgements) is gone';
  end if;
end $$;

commit;
