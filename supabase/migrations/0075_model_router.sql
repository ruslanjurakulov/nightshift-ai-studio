-- 0075_model_router.sql — Model Router v1: the modes auto, cheap, fast and
-- quality pick the model for a creative job (docs/CREATIVE_OS_PLAN.md §3.3,
-- docs/product/GAP_ANALYSIS.md brief B1). exact is unchanged: the model the
-- person picked, never another.
--
-- THE PICK (route_model, pure and deterministic: the same inputs and the same
-- registry and price list give the same model every time, on every surface)
--   Candidates = the models sellable_models lists for the capability on the
--   surface (web | api | mcp: beta/ga, verified by a real probe, not
--   terms-gated, a base price above 0, not kept off the API by its vendor)
--   that creative_price ALSO prices for these exact params and this
--   organization (its plan's entitlement, the settings the model offers, the
--   variant row). A model creative_price refuses for any reason (unpriced,
--   entitlement_required, a setting it does not offer) is not a candidate; a
--   price of 0 is not one either. What does not depend on the model (the
--   prompt, the source picture, the style kit) is checked once first, with
--   creative_price's own refusals.
--   Ranked by the registry's quality_tier / speed_tier (1-5; absent = 0, never
--   assumed good) and the live price, ties broken by the model id:
--     cheap    lowest price, then higher quality, then faster        cheapest
--     fast     faster, then lowest price, then higher quality        fastest
--     quality  higher quality, then lowest price, then faster        best_quality
--     auto     the lowest price among quality tier 4 and above;      best_value
--              without one, the highest tier, lowest price first     best_available
--   One candidate only: only_option. Nothing left: 'no_model_available'.
--   The reason is a short code the app words in en / ru / uz.
--
-- PRICE BEFORE SPEND (unchanged rule, new path)
--   quote_creative_route (members) / api_creative_quote(.., p_mode, ..) (keys)
--   answer the pick: its id, display name (web only), reason and the
--   creative_price quote OF THAT MODEL without the platform's economics
--   (no margin, no credits_per_unit: BR-L-023). The press sends back the mode, the
--   model the quote named and its price as max_credits; create_creative_job
--   asks the router again under the account lock and refuses a different pick
--   ('route_changed', NS409) and a higher price ('price_changed', NS409), and
--   requires both for a routed mode. A routed job is never created from a mode
--   alone.
--
-- THE MONEY (0036's hold / capture / release, unchanged functions)
--   exact and routed alike: the hold is the price of the model at create time
--   (the quote; never the caller's max_credits, which only refuses a higher
--   price: BR-L-020). routed_credits (NEW column, required on every routed
--   job) is the price of the model the job runs — the pick, or after a
--   failover the model it moved to, which costs no more than the hold;
--   finish_creative_job captures at most it (lines added), the rest of the
--   hold is released by capture_credits.
--
-- FAILOVER (reroute_creative_job, the worker only, routed modes only)
--   Never for exact. Only when the submit failed in a way that PROVES the
--   vendor took nothing (BR-L-019): the worker has no adapter or no key for
--   the model (adapter_missing, not_configured), the connection could not
--   even be opened (unreachable), or the vendor refused the first call
--   outright (auth, quota, not_found, rate_limited: HTTP 401/402/403/404/429).
--   NEVER 'unavailable' — a timeout, a connection dropped after sending or a
--   5xx (502 / 504 included): the vendor may have accepted, and be billing, a
--   task we never heard of, so the job keeps its submit_started_at (0036's
--   "never submitted twice") and fails with its hold released. Never after a
--   task id is stored and never for a refusal of the request itself (policy,
--   bad_request). The next candidate stored at create, in rank order, that is
--   still sellable on the job's surface, prices THE JOB'S OWN params (the
--   settings the quote priced, so only a compatible model qualifies), costs no
--   more than the hold (the quote), and for quality is of the same tier
--   (auto: the same or higher). At most two failovers. The job keeps
--   fallback_from / fallback_reason, its params get the new model's priced
--   variant, its credit_unit / quantity describe the new model, and the
--   worker submits a NEW task (no task id crosses models). None qualifies:
--   the worker fails the job and the hold is released in full.
--
-- WHAT IT CHANGES
--   creative_jobs        NEW columns routed_credits, routing ({reason,
--                        surface} only) + a CHECK and a deferred table rule
--                        (a routed job records its route and routed_credits).
--   creative_job_routes  NEW, platform only (no API role reads it: BR-L-022):
--                        the ranked candidates, the pick's tier, the models tried.
--   route_model, creative_route_quote, quote_creative_route,
--   reroute_creative_job, api_creative_quote(text, text, text, jsonb, text, text)   NEW
--   create_creative_job  0070's body (the latest), lines added: the routed path
--                        above. The one changed line: the 'mode_not_supported'
--                        refusal now stands only on a database without
--                        route_model (its text kept).
--   finish_creative_job  0036's body, lines added: the routed_credits cap.
--   creative_job_json    0036's body, plus routed_credits and route_reason.
--   api_creative_create, api_creative_job_json, api_creative_refusal
--                        0062's bodies, lines added: the API surface for the
--                        router, the hold counted against a key's monthly
--                        ceiling, the routed fields, the two new refusals.
--   NOT replaced: creative_price, creative_params_problem, sellable_models,
--   quote_creative_job (0072's / 0036's stand; the router only calls them).
--
-- WHO MAY DO WHAT
--   quote_creative_route            signed-in members of the organization
--   api_creative_quote (6 args)     anon (the key is checked by api_begin first)
--   reroute_creative_job            service role (the creative worker)
--   route_model, creative_route_quote   no API role (called inside the above)
--   creative_jobs.routing / routed_credits: read like the row (members of the
--   organization, 0036's RLS); nobody writes them directly.
--   creative_job_routes: no API role at all (the definer functions only).
--   api_creative_job_json names a failover's reason only as 'unavailable'
--   (BR-L-021): never the platform's vendor-account state (auth, quota, ...).
--
-- BUILT ON the LATEST bodies (tests/test_model_router_migration.py pins every
-- line of each): create_creative_job 0070, finish_creative_job and
-- creative_job_json 0036, api_creative_* 0062.
--
-- REQUIRES 0035, 0036, 0062, 0070 and 0072. Additive and idempotent: guarded
-- columns, drop-then-add constraints, create-or-replace functions,
-- revoke-then-grant.

do $$
begin
  if to_regclass('public.model_registry') is null or to_regclass('public.creative_jobs') is null then
    raise exception '0075 needs 0035_model_registry.sql and 0036_creative_jobs.sql: apply them first';
  end if;
  if to_regprocedure('public.api_creative_create(text, text, text, jsonb, text, numeric, text, text, text)') is null then
    raise exception '0075 needs 0062_api_creative.sql: apply it first';
  end if;
  -- create_creative_job is replaced from 0070's body: anything older would drop
  -- the stored resolution / soundtrack (and 0060's tier).
  if position('jsonb_build_object(''resolution'', q ->> ''resolution'')'
              in pg_get_functiondef('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)'::regprocedure)) = 0 then
    raise exception '0075 needs 0070_video_price_variants.sql (its create_creative_job): apply it first';
  end if;
  -- The router calls creative_price as 0072 left it (captions priced).
  if position('captions' in pg_get_functiondef('public.creative_price(uuid, text, text, jsonb)'::regprocedure)) = 0 then
    raise exception '0075 needs 0072_captions.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. What the job records about its route
-- ───────────────────────────────────────────────────────────────────────────

alter table public.creative_jobs add column if not exists routed_credits numeric(14,2);
alter table public.creative_jobs add column if not exists routing jsonb;

alter table public.creative_jobs drop constraint if exists creative_jobs_routing_check;
alter table public.creative_jobs add constraint creative_jobs_routing_check
  check ((routing is null or (jsonb_typeof(routing) = 'object' and octet_length(routing::text) <= 1024))
         and (routed_credits is null or (routed_credits >= 0 and routed_credits <= quoted_credits))
         -- exact never carries a route: the person's model, never another.
         and (mode <> 'exact' or (routing is null and routed_credits is null and fallback_from is null)));

comment on column public.creative_jobs.routed_credits is
  'Routed modes (0075): the price of the model the job runs (required). The hold (quoted_credits) is the price at create time; at most this is captured.';
comment on column public.creative_jobs.routing is
  'Routed modes (0075): {reason, surface} only — what members may read. The candidates are in creative_job_routes (platform only). Written only by create_creative_job.';

-- The router's working state: the ranked candidates (each with its per-org
-- price and tiers), the pick's quality tier and the models tried. Members
-- never read it (BR-L-022): no API role has any privilege, and RLS is on with
-- no policy. Only create_creative_job and reroute_creative_job write it.
create table if not exists public.creative_job_routes (
  job_id       uuid primary key references public.creative_jobs (id) on delete cascade,
  quality_tier numeric(3,1) not null default 0,
  candidates   jsonb not null default '[]'::jsonb,
  tried        jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);
alter table public.creative_job_routes drop constraint if exists creative_job_routes_shape_check;
alter table public.creative_job_routes add constraint creative_job_routes_shape_check
  check (jsonb_typeof(candidates) = 'array' and jsonb_typeof(tried) = 'array'
         and octet_length(candidates::text) <= 4096 and jsonb_array_length(tried) <= 3);
alter table public.creative_job_routes enable row level security;
revoke all on table public.creative_job_routes from public, anon, authenticated, service_role;
comment on table public.creative_job_routes is
  'Model Router (0075): a routed job''s ranked candidates [{model, credits, quality_tier, speed_tier}], the pick''s quality tier and the models tried. Platform only: no API role reads or writes it.';

-- The table rule a CHECK cannot state (create_creative_job inserts the job,
-- then records its route, in one transaction): at commit, a routed job has
-- its route and routed_credits. Without routed_credits finish_creative_job
-- would cap nothing (BR-L-024).
create or replace function public.creative_jobs_route_recorded() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  -- Deferred: the row as it stands at commit, not as it was inserted.
  select c.mode, c.routing, c.routed_credits into r from public.creative_jobs c where c.id = new.id;
  if found and r.mode <> 'exact' and (r.routing is null or r.routed_credits is null) then
    raise exception 'a routed creative job records its route and the price of its model (0075)'
      using errcode = '23514';
  end if;
  return null;
end
$$;
drop trigger if exists creative_jobs_route_recorded on public.creative_jobs;
create constraint trigger creative_jobs_route_recorded
  after insert or update of mode, routing, routed_credits on public.creative_jobs
  deferrable initially deferred
  for each row execute function public.creative_jobs_route_recorded();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The router
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.route_model(
  p_capability text, p_params jsonb, p_mode text, p_org uuid, p_surface text default 'web'
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap     text := lower(btrim(coalesce(p_capability, '')));
  md      text := lower(btrim(coalesce(p_mode, '')));
  surf    text := coalesce(p_surface, 'web');
  problem text;
  ids     text[];
  m       text;
  sp      jsonb;
  q       jsonb;
  c       numeric;
  cands   jsonb := '[]'::jsonb;
  ranked  jsonb;
  top     jsonb;
  reason  text;
begin
  if md not in ('auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be auto, cheap, fast or quality');
  end if;
  if surf not in ('web', 'api', 'mcp') then
    perform public.creative_refuse('invalid_params', 'unknown surface');
  end if;
  -- What does not depend on the model, once, with creative_price's own
  -- refusals: a bad prompt or another organization's picture reads the same
  -- in every mode (and never as "no model").
  if cap !~ '^[a-z][a-z0-9_]{0,31}$' then
    perform public.creative_refuse('invalid_params', 'capability is required');
  end if;
  if not public.creative_capability_supported(cap) then
    perform public.creative_refuse('capability_not_supported',
      format('%s cannot be generated yet on this deployment', cap));
  end if;
  problem := public.creative_params_problem(cap, p_params);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;
  problem := public.creative_source_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('source_unavailable', problem);
  end if;
  problem := public.creative_style_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('style_unavailable', problem);
  end if;

  -- The models this surface sells for the capability (none: a capability
  -- sellable_models does not know yet).
  begin
    select array_agg(s.id order by s.id) into ids from public.sellable_models(cap, surf) s;
  exception when sqlstate '22023' then
    ids := null;
  end;
  foreach m in array coalesce(ids, '{}'::text[]) loop
    -- Priced for THESE params and THIS organization, or not a candidate.
    begin
      q := public.creative_price(p_org, cap, m, p_params);
    exception when sqlstate 'NS400' then
      continue;
    end;
    c := (q ->> 'credits')::numeric;
    if c is null or c <= 0 then
      continue;
    end if;
    select r.spec into sp from public.model_registry r where r.id = m;
    cands := cands || jsonb_build_array(jsonb_build_object(
      'model', m, 'credits', c,
      'quality_tier', case when jsonb_typeof(sp -> 'quality_tier') = 'number'
                           then least(greatest((sp ->> 'quality_tier')::numeric, 0), 5) else 0 end,
      'speed_tier', case when jsonb_typeof(sp -> 'speed_tier') = 'number'
                         then least(greatest((sp ->> 'speed_tier')::numeric, 0), 5) else 0 end));
  end loop;
  if jsonb_array_length(cands) = 0 then
    perform public.creative_refuse('no_model_available',
      'no available, priced model can make this with these settings');
  end if;

  select jsonb_agg(x.e order by x.k1, x.k2, x.k3, x.k4, x.e ->> 'model') into ranked
    from (select e,
                 case md when 'cheap' then (e ->> 'credits')::numeric
                         when 'fast' then -(e ->> 'speed_tier')::numeric
                         when 'quality' then -(e ->> 'quality_tier')::numeric
                         else case when (e ->> 'quality_tier')::numeric >= 4 then 0 else 1 end end as k1,
                 case md when 'cheap' then -(e ->> 'quality_tier')::numeric
                         when 'fast' then (e ->> 'credits')::numeric
                         when 'quality' then (e ->> 'credits')::numeric
                         else case when (e ->> 'quality_tier')::numeric >= 4 then 0
                                   else -(e ->> 'quality_tier')::numeric end end as k2,
                 case md when 'cheap' then -(e ->> 'speed_tier')::numeric
                         when 'fast' then -(e ->> 'quality_tier')::numeric
                         when 'quality' then -(e ->> 'speed_tier')::numeric
                         else (e ->> 'credits')::numeric end as k3,
                 case md when 'auto' then -(e ->> 'speed_tier')::numeric else 0 end as k4
            from jsonb_array_elements(cands) e) x;
  top := ranked -> 0;
  reason := case when jsonb_array_length(ranked) = 1 then 'only_option'
                 when md = 'cheap' then 'cheapest'
                 when md = 'fast' then 'fastest'
                 when md = 'quality' then 'best_quality'
                 when (top ->> 'quality_tier')::numeric >= 4 then 'best_value'
                 else 'best_available' end;
  return jsonb_build_object(
    'model', top ->> 'model', 'credits', top -> 'credits', 'mode', md, 'reason', reason,
    'quality_tier', top -> 'quality_tier', 'speed_tier', top -> 'speed_tier', 'surface', surf,
    'considered', jsonb_array_length(ranked),
    -- The failover order: at most five, the pick first.
    'candidates', (select jsonb_agg(t.e order by t.n) from jsonb_array_elements(ranked) with ordinality t(e, n)
                    where t.n <= 5));
end
$$;

-- The quote of a routed mode: the pick's own creative_price answer, named.
-- Membership first, like quote_creative_job. Not callable through the API: the
-- two wrappers below are.
create or replace function public.creative_route_quote(
  p_org uuid, p_capability text, p_mode text, p_params jsonb, p_surface text
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  md  text := lower(btrim(coalesce(p_mode, '')));
  rt  jsonb;
  q   jsonb;
  dn  text;
  acc public.credit_accounts;
begin
  if auth.uid() is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if md not in ('auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params',
      'mode must be auto, cheap, fast or quality (exact: quote the model itself)');
  end if;
  rt := public.route_model(p_capability, p_params, md, p_org, p_surface);
  q := public.creative_price(p_org, p_capability, rt ->> 'model', p_params);
  select r.display_name into dn from public.model_registry r where r.id = rt ->> 'model';
  select * into acc from public.credit_accounts where org_id = p_org;
  -- The price, never the platform's economics behind it (BR-G-001 / BR-L-023).
  return (q - 'margin' - 'credits_per_unit') || jsonb_build_object(
    'mode', md, 'routed_model', rt ->> 'model', 'route_reason', rt ->> 'reason',
    'display_name', dn, 'quality_tier', rt -> 'quality_tier', 'speed_tier', rt -> 'speed_tier',
    'available', case when public.credits_exempt(p_org) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;

-- A member's quote of a routed mode (the Studio's "Auto").
create or replace function public.quote_creative_route(
  p_org uuid, p_capability text, p_mode text, p_params jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return public.creative_route_quote(p_org, p_capability, p_mode, p_params, 'web');
end
$$;

-- The worker's failover (header). Null = no failover: the worker fails the job
-- and its hold is released in full.
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
       set fallback_from = j.routed_model, fallback_reason = code, routed_model = m,
           routed_credits = price, params = jparams, submit_started_at = null,
           credit_unit = coalesce(q ->> 'unit', j.credit_unit),
           quantity = coalesce((q ->> 'quantity')::numeric, j.quantity),
           heartbeat_at = now(), updated_at = now()
     where id = p_job;
    update public.creative_job_routes r set tried = r.tried || to_jsonb(m) where r.job_id = p_job;
    perform public.creative_job_log(p_job, j.org_id, 'rerouted', 'running',
      jsonb_build_object('from', j.routed_model, 'to', m, 'code', code, 'credits', price));
    -- The worker sends exactly these params to the new model.
    return jsonb_build_object('model', m, 'credits', price, 'params', jparams);
  end loop;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The job functions, on their latest bodies (lines added)
-- ───────────────────────────────────────────────────────────────────────────

-- 0070's create_creative_job, plus the routed path (header).
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

-- 0036's finish_creative_job, plus the routed_credits cap.
create or replace function public.finish_creative_job(
  p_job uuid, p_worker text, p_ok boolean,
  p_charge numeric default null, p_result jsonb default null,
  p_error_code text default null, p_error text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j       public.creative_jobs;
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  charge  numeric;
  charged numeric := 0;
  code    text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are finished by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.credit_account_lock(j.org_id);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.status in ('completed', 'failed', 'cancelled', 'expired') then
    return public.creative_job_json(j);
  end if;
  if j.worker_id is distinct from w then
    raise exception 'this creative job belongs to another worker' using errcode = '42501';
  end if;

  if not coalesce(p_ok, false) then
    code := case when coalesce(p_error_code, '') ~ '^[a-z0-9_]{1,64}$' then p_error_code
                 else 'provider_error' end;
    perform public.creative_end_locked(p_job, 'failed', code, coalesce(p_error, code));
    select * into j from public.creative_jobs where id = p_job;
    return public.creative_job_json(j);
  end if;

  if j.provider_task_id is null then
    raise exception 'a completed job needs its provider task id' using errcode = '22023';
  end if;
  if p_result is not null and (jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 16384) then
    raise exception 'result must be a JSON object of at most 16 KB' using errcode = '22023';
  end if;
  charge := public.credits_round_up(coalesce(p_charge, j.quoted_credits));
  -- 0075: a routed job is charged at most the price of the model that made
  -- it (after a failover, a model that may cost less than the hold).
  if j.routed_credits is not null and charge > j.routed_credits then
    charge := j.routed_credits;
  end if;
  if charge < 0 or charge > j.quoted_credits then
    raise exception 'a charge of % is not within the hold of %', charge, j.quoted_credits
      using errcode = '22023';
  end if;
  if j.payer = 'credits' and j.credit_ref is not null
     and exists (select 1 from public.credit_reservations where job_id = j.credit_ref) then
    -- 0 when the hold is no longer open (it expired): the job still completes,
    -- and what was charged is what the ledger says.
    charged := coalesce(public.capture_credits(j.credit_ref, charge, false), 0);
  end if;
  update public.creative_jobs
     set status = 'completed', charged_credits = charged, result = p_result,
         error_code = null, error = null, worker_id = null,
         finished_at = now(), updated_at = now()
   where id = p_job
  returning * into j;
  perform public.creative_job_log(p_job, j.org_id, 'completed', 'completed',
    jsonb_build_object('charged', charged));
  return public.creative_job_json(j);
end
$$;

-- 0036's creative_job_json, plus the routed price and reason.
create or replace function public.creative_job_json(j public.creative_jobs) returns jsonb
  language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', j.id, 'org_id', j.org_id, 'kind', j.kind, 'capability', j.capability, 'mode', j.mode,
    'requested_model', j.requested_model, 'routed_model', j.routed_model,
    'fallback_from', j.fallback_from, 'fallback_reason', j.fallback_reason,
    'params', j.params, 'status', j.status, 'payer', j.payer,
    'quoted_credits', j.quoted_credits, 'charged_credits', j.charged_credits,
    'error_code', j.error_code, 'error', j.error, 'result', j.result,
    'result_asset_ids', to_jsonb(j.result_asset_ids),
    'expires_at', j.expires_at, 'created_at', j.created_at, 'updated_at', j.updated_at,
    'finished_at', j.finished_at)
    -- 0075: the price of the model that made it, and why the router picked it.
    || jsonb_build_object('routed_credits', j.routed_credits, 'route_reason', j.routing ->> 'reason')
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The API (0062): the same rules through its own functions
-- ───────────────────────────────────────────────────────────────────────────

-- 0062's api_creative_job_json, plus how the model was chosen.
create or replace function public.api_creative_job_json(j public.creative_jobs) returns jsonb
  language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', j.id, 'capability', j.capability, 'model', j.requested_model, 'status', j.status,
    'quoted_credits', j.quoted_credits, 'charged_credits', j.charged_credits,
    'error_code', j.error_code, 'error', j.error, 'result', j.result,
    'result_asset_ids', to_jsonb(j.result_asset_ids),
    'created_at', j.created_at, 'updated_at', j.updated_at,
    'finished_at', j.finished_at, 'expires_at', j.expires_at)
    -- 0075: how the model was chosen, and a failover if there was one (model
    -- ids and reason codes only, never a provider, a route or a candidate list).
    -- A failover's reason is only ever 'unavailable' here: the platform's
    -- vendor-account state (auth, quota, ...) is not a customer's (BR-L-021).
    || jsonb_build_object('mode', j.mode, 'routed_model', j.routed_model,
                          'fallback_from', j.fallback_from,
                          'fallback_reason', case when j.fallback_reason is null then null else 'unavailable' end,
                          'route_reason', j.routing ->> 'reason')
$$;

-- 0062's api_creative_refusal, plus route_changed and no_model_available.
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

-- 0062's api_creative_create, plus the API surface for the router and the
-- routed hold counted against the key's monthly ceiling.
create or replace function public.api_creative_create(
  p_key_hash text, p_capability text, p_model text, p_params jsonb default '{}'::jsonb,
  p_mode text default 'exact', p_max_credits numeric default null,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx      jsonb := public.api_begin(p_key_hash, 'creative.create', p_request_id);
  v_org    uuid;
  v_key    uuid;
  v_cap    text := lower(btrim(coalesce(p_capability, '')));
  v_model  text := lower(btrim(coalesce(p_model, '')));
  v_p      jsonb := coalesce(p_params, '{}'::jsonb);
  v_idem   text;
  v_limit  numeric;
  v_q      jsonb;
  v_out    jsonb;
  v_job    public.creative_jobs;
  v_replay boolean;
  v_res    jsonb;
  v_msg    text;
  v_detail text;
  v_state  text;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    -- A generation spends credits: a retry must never spend twice, and the
    -- price the caller accepts is part of the request.
    if p_idem_key is null then
      return public.api_finish(ctx, public.api_err(400, 'idempotency_key_required',
        'Send an Idempotency-Key header: a generation spends credits, and a retry must not spend twice.'));
    end if;
    if p_max_credits is null or p_max_credits < 0 then
      return public.api_finish(ctx, public.api_err(400, 'max_credits_required',
        'max_credits is required: the most credits you accept to be charged for this generation (see the quote).'));
    end if;
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;
    v_key := (ctx ->> 'key_id')::uuid;
    -- Namespaced by the key: one organization's keys never see or replay each
    -- other's generations. 'api-' + 64 hex characters fits 0036's key rule.
    v_idem := 'api-' || encode(sha256(convert_to(v_key::text || ':' || p_idem_key, 'UTF8')), 'hex');

    begin
      -- One create at a time per key, so its monthly credit ceiling cannot be
      -- raced past. (Credit account lock order is unchanged: this lock first.)
      perform pg_advisory_xact_lock(hashtextextended('api_creative:' || v_key::text, 0));
      if not public.api_creative_model_ok(v_cap, v_model) then
        perform public.creative_refuse('model_not_sellable', format('%s is not available for %s through the API', v_model, v_cap));
      end if;
      select k.creative_monthly_credits into v_limit from public.api_keys k where k.id = v_key;
      -- A replay of a generation already made costs nothing more.
      if v_limit is not null
         and not exists (select 1 from public.creative_jobs c where c.org_id = v_org and c.idempotency_key = v_idem) then
        v_q := public.creative_price(v_org, v_cap, v_model, v_p);
        if public.api_creative_month_credits(v_key) + (v_q ->> 'credits')::numeric > v_limit then
          v_res := public.api_err(402, 'key_credit_limit_reached',
            'This generation would take this key past its own monthly credit limit.',
            jsonb_build_object('limit_credits', v_limit, 'month_credits', public.api_creative_month_credits(v_key),
                               'price_credits', (v_q ->> 'credits')::numeric));
        end if;
      end if;
      if v_res is null then
        -- The UI's own function, as the key's creator: membership, the model,
        -- the price, max_credits, the hold and the job, atomically.
        -- 0075: a routed job is routed among the models the API sells.
        perform set_config('nightshift.creative_surface', 'api', true);
        v_out := public.create_creative_job(v_org, v_cap, v_model, v_p, coalesce(p_mode, 'exact'), v_idem, p_max_credits);
        perform set_config('nightshift.creative_surface', '', true);
        v_replay := coalesce((v_out ->> 'replay')::boolean, false);
        select * into v_job from public.creative_jobs where id = (v_out -> 'job' ->> 'id')::uuid and org_id = v_org;
        if v_job.id is null then
          raise exception 'job missing after create' using errcode = 'XX000';
        end if;
        insert into public.api_creative_jobs (job_id, key_id, org_id)
        values (v_job.id, v_key, v_org)
        on conflict (job_id) do nothing;
        if not v_replay then
          perform public.api_audit(ctx, 'creative.generate', v_job.id::text, null,
            jsonb_build_object('org_id', v_org, 'capability', v_cap, 'model', v_model,
                               'quoted_credits', v_job.quoted_credits));
        end if;
        v_res := public.api_ok(public.api_creative_job_json(v_job), case when v_replay then 200 else 201 end);
      end if;
    exception when others then
      -- This block is undone: no job, no hold, no link row. The request still
      -- counts, and the Idempotency-Key is released for a retry.
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
      v_state := sqlstate;
      v_res := public.api_creative_refusal(v_state, v_msg, v_detail);
    end;
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- The quote with a mode. exact is 0062's quote itself (it opens and counts the
-- request). A routed mode answers the pick among the models the API sells:
-- its id, the reason code and the quote of that model; never a provider, a
-- display name, a candidate list or the balance. p_model is not read for a
-- routed mode. Every argument is required, so a call without p_mode can only
-- ever reach 0062's five-argument quote (no ambiguity by name or position).
create or replace function public.api_creative_quote(
  p_key_hash text, p_capability text, p_model text, p_params jsonb, p_mode text, p_request_id text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_mode   text := lower(btrim(coalesce(p_mode, 'exact')));
  ctx      jsonb;
  v_q      jsonb;
  v_res    jsonb;
  v_msg    text;
  v_detail text;
  v_state  text;
begin
  if v_mode = 'exact' then
    return public.api_creative_quote(p_key_hash, p_capability, p_model, p_params, p_request_id);
  end if;
  ctx := public.api_begin(p_key_hash, 'creative.quote', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    begin
      -- The organization is the key's, never the request's.
      v_q := public.creative_route_quote((ctx ->> 'org_id')::uuid, lower(btrim(coalesce(p_capability, ''))),
                                         v_mode, coalesce(p_params, '{}'::jsonb), 'api');
      v_res := public.api_ok(jsonb_build_object('quote',
        v_q - 'available' - 'display_name' - 'quality_tier' - 'speed_tier'));
    exception when others then
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
      v_state := sqlstate;
      v_res := public.api_creative_refusal(v_state, v_msg, v_detail);
    end;
    return public.api_finish(ctx, v_res);
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.route_model(text, jsonb, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.creative_route_quote(uuid, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.quote_creative_route(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.reroute_creative_job(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_quote(text, text, text, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.creative_jobs_route_recorded() from public, anon, authenticated, service_role;
grant execute on function public.quote_creative_route(uuid, text, text, jsonb) to authenticated;
grant execute on function public.reroute_creative_job(uuid, text, text) to service_role;
grant execute on function public.api_creative_quote(text, text, text, jsonb, text, text) to anon;

-- The replaced functions keep exactly their grants (stated again).
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;
revoke all on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) to service_role;
revoke all on function public.creative_job_json(public.creative_jobs) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_job_json(public.creative_jobs) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_refusal(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_create(text, text, text, jsonb, text, numeric, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.api_creative_create(text, text, text, jsonb, text, numeric, text, text, text) to anon;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'creative_jobs' and column_name = 'routing') as routing_column,
--   not has_table_privilege('authenticated', 'public.creative_jobs', 'UPDATE')
--     and not has_table_privilege('service_role', 'public.creative_jobs', 'UPDATE') as rows_not_writable,
--   has_function_privilege('authenticated', 'public.quote_creative_route(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.quote_creative_route(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.route_model(text,jsonb,text,uuid,text)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.route_model(text,jsonb,text,uuid,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.reroute_creative_job(uuid,text,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.reroute_creative_job(uuid,text,text)', 'EXECUTE')
--     and has_function_privilege('anon', 'public.api_creative_quote(text,text,text,jsonb,text,text)', 'EXECUTE')
--     as functions_scoped,
--   not has_table_privilege('authenticated', 'public.creative_job_routes', 'SELECT')
--     and not has_table_privilege('service_role', 'public.creative_job_routes', 'SELECT')
--     and not has_table_privilege('anon', 'public.creative_job_routes', 'SELECT') as routes_platform_only,
--   position('route_changed' in pg_get_functiondef(
--     'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)'::regprocedure)) > 0 as create_routes,
--   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.prosecdef
--       and p.proname in ('route_model', 'creative_route_quote', 'quote_creative_route', 'reroute_creative_job',
--                         'creative_jobs_route_recorded')
--       and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 0
--     as definer_functions_pin_search_path;
