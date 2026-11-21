-- 0088_router_failover_reason.sql — the vendor account state behind a failover
-- is the platform's, not the organization's (BR-G-005, BR-L-032).
--
-- WHAT WAS WRONG
--   reroute_creative_job (0075) is called with the real reason the first model
--   could not be used: auth, quota, not_configured, rate_limited, not_found,
--   unreachable, adapter_missing. That is the state of the platform's vendor
--   accounts ("the key for that vendor was rejected", "its balance is spent").
--   It was copied into two places every member of the organization reads over
--   PostgREST:
--     * creative_jobs.fallback_reason (the table's SELECT covers the column;
--       also in creative_job_json) — BR-L-032
--     * creative_job_events.detail ->> 'code' (the events SELECT policy is
--       accessible_org_ids('viewer')) — BR-G-005
--   The API already answered 'unavailable' (0075 api_creative_job_json, BR-L-021);
--   the web side did not.
--
-- WHAT THIS CHANGES
--   * creative_job_routes (platform only: no API role has any privilege) gets
--     a `reasons` array, one entry per failover, in the order they happened.
--   * reroute_creative_job is 0075's body with exactly two member-visible
--     values changed: fallback_reason is 'unavailable' and the 'rerouted'
--     event's detail.code is 'unavailable'; the real code is appended to
--     creative_job_routes.reasons. Every other line, check, lock and return
--     value is 0075's (tests/test_router_failover_migration.py pins every
--     string literal of the old and the new body against each other).
--   * Rows written before this migration are brought in line: the real code
--     moves to creative_job_routes.reasons and the job row and the 'rerouted'
--     events say 'unavailable'. creative_job_events is append-only (a trigger
--     refuses UPDATE); the one-off rewrite of those event rows disables that
--     trigger inside this migration's own transaction and puts it back, and
--     touches only event = 'rerouted' rows whose detail.code is not already
--     'unavailable'. Nothing else about the log changes.
--
-- Not changed: scene_regenerations.error and the worker's refusal text
-- (BR-G-006 / BR-L-040), which claude/patch-scene-regen-followups (0085) owns.
--
-- REQUIRES 0075. Additive and idempotent (a second run finds nothing to move).

do $$
begin
  if to_regclass('public.creative_job_routes') is null
     or to_regprocedure('public.reroute_creative_job(uuid, text, text)') is null then
    raise exception '0088 needs 0075_model_router.sql: apply it first';
  end if;
end $$;

alter table public.creative_job_routes add column if not exists reasons jsonb not null default '[]'::jsonb;
alter table public.creative_job_routes drop constraint if exists creative_job_routes_reasons_check;
alter table public.creative_job_routes add constraint creative_job_routes_reasons_check
  check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) <= 3 and octet_length(reasons::text) <= 256);
comment on column public.creative_job_routes.reasons is
  'The real failover codes (0088), in order: the platform''s vendor account state. Platform only; members read ''unavailable''.';

-- Rows written by 0075's version: keep the real code where only the platform
-- reads it, then say 'unavailable' where members read.
update public.creative_job_routes r
   set reasons = jsonb_build_array(j.fallback_reason)
  from public.creative_jobs j
 where j.id = r.job_id and j.fallback_reason is not null and j.fallback_reason <> 'unavailable'
   and r.reasons = '[]'::jsonb;

update public.creative_jobs
   set fallback_reason = 'unavailable'
 where fallback_reason is not null and fallback_reason <> 'unavailable';

do $$
begin
  if exists (select 1 from public.creative_job_events e
              where e.event = 'rerouted' and coalesce(e.detail ->> 'code', 'unavailable') <> 'unavailable') then
    alter table public.creative_job_events disable trigger creative_job_events_append_only;
    update public.creative_job_events e
       set detail = e.detail || jsonb_build_object('code', 'unavailable')
     where e.event = 'rerouted' and coalesce(e.detail ->> 'code', 'unavailable') <> 'unavailable';
    alter table public.creative_job_events enable trigger creative_job_events_append_only;
  end if;
end $$;

-- 0075's reroute_creative_job, two member-visible values changed (header).
create or replace function public.reroute_creative_job(p_job uuid, p_worker text, p_code text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w     text := left(btrim(coalesce(p_worker, '')), 120);
  code  text := lower(btrim(coalesce(p_code, '')));
  org   uuid;
  j     public.creative_jobs;
  tried jsonb;
  rr    public.creative_job_routes;
  surf  text;
  q0    numeric;
  cq    numeric;
  cand  jsonb;
  m     text;
  q     jsonb;
  price numeric;
  jparams jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  -- Only a failure that PROVES no vendor task exists (header, BR-L-019):
  -- never 'unavailable' (a timeout or a 5xx: the vendor may be billing), never
  -- a refusal of the request itself (policy, bad_request). Anything else
  -- returns before the row is touched: its submit_started_at stands.
  if code not in ('unreachable', 'rate_limited', 'quota', 'auth', 'not_configured', 'not_found',
                  'adapter_missing') then
    return null;
  end if;
  select org_id into org from public.creative_jobs where id = p_job;
  if org is null then
    return null;
  end if;
  perform public.credit_account_lock(org);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.worker_id is distinct from w or j.status <> 'running' or j.provider_task_id is not null then
    return null;
  end if;
  -- exact never fails over: the person's model, or nothing.
  if j.mode = 'exact' or j.routing is null then
    return null;
  end if;
  select * into rr from public.creative_job_routes where job_id = p_job for update;
  if not found then
    return null;
  end if;
  tried := rr.tried;
  if jsonb_array_length(tried) >= 3 then
    return null;
  end if;
  surf := coalesce(j.routing ->> 'surface', 'web');
  q0 := coalesce(rr.quality_tier, 0);
  for cand in select t.e from jsonb_array_elements(rr.candidates)
                             with ordinality t(e, n) order by t.n loop
    m := cand ->> 'model';
    continue when m is null or tried ? m;
    cq := coalesce((cand ->> 'quality_tier')::numeric, 0);
    continue when j.mode = 'quality' and cq <> q0;
    continue when j.mode = 'auto' and cq < q0;
    continue when not exists (select 1 from public.sellable_models(j.capability, surf) s where s.id = m);
    begin
      -- The job's own params: the settings the person's quote priced.
      q := public.creative_price(j.org_id, j.capability, m, j.params);
    exception when sqlstate 'NS400' then
      continue;
    end;
    price := (q ->> 'credits')::numeric;
    continue when price is null or price <= 0 or price > j.quoted_credits;
    -- No dearer than the hold, which is the quote (BR-L-020).
    -- The variant this model is priced at is what the worker sends (0060 / 0070).
    jparams := j.params;
    if q ? 'quality' then
      jparams := jparams || jsonb_build_object('quality', q ->> 'quality');
    end if;
    if q ? 'resolution' then
      jparams := jparams || jsonb_build_object('resolution', q ->> 'resolution');
    end if;
    if q ? 'audio' then
      jparams := jparams || jsonb_build_object('audio', (q ->> 'audio')::boolean);
    end if;
    -- The row describes the model that runs now: its price, unit and quantity
    -- (BR-L-024). submit_started_at is cleared ONLY here, where no task can
    -- exist: the worker submits a new one to the new model.
    update public.creative_jobs
       set fallback_from = j.routed_model, fallback_reason = 'unavailable', routed_model = m,
           routed_credits = price, params = jparams, submit_started_at = null,
           credit_unit = coalesce(q ->> 'unit', j.credit_unit),
           quantity = coalesce((q ->> 'quantity')::numeric, j.quantity),
           heartbeat_at = now(), updated_at = now()
     where id = p_job;
    -- The real reason is the platform's: it stays in the platform-only route
    -- row, and the member-readable row and log say only 'unavailable'.
    update public.creative_job_routes r
       set tried = r.tried || to_jsonb(m), reasons = r.reasons || to_jsonb(code)
     where r.job_id = p_job;
    perform public.creative_job_log(p_job, j.org_id, 'rerouted', 'running',
      jsonb_build_object('from', j.routed_model, 'to', m, 'code', 'unavailable', 'credits', price));
    -- The worker sends exactly these params to the new model.
    return jsonb_build_object('model', m, 'credits', price, 'params', jparams);
  end loop;
  return null;
end
$$;

revoke all on function public.reroute_creative_job(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.reroute_creative_job(uuid, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every row should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select not exists (select 1 from public.creative_jobs where fallback_reason is not null and fallback_reason <> 'unavailable')
--      as no_real_code_on_jobs,
--     not exists (select 1 from public.creative_job_events where event = 'rerouted' and detail ->> 'code' <> 'unavailable')
--      as no_real_code_in_events,
--     (select tgenabled = 'O' from pg_trigger where tgname = 'creative_job_events_append_only'
--         and tgrelid = 'public.creative_job_events'::regclass) as append_only_trigger_on,
--     has_function_privilege('service_role', 'public.reroute_creative_job(uuid,text,text)', 'EXECUTE')
--      and not has_function_privilege('authenticated', 'public.reroute_creative_job(uuid,text,text)', 'EXECUTE') as acl;
