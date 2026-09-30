-- 0036_creative_jobs.sql — durable creative generation jobs, paid in credits
-- (Creative OS phase 1, docs/CREATIVE_OS_PLAN.md §3.4 and §4).
--
-- WHY A NEW TABLE, NOT render_jobs
--   render_jobs is channel-bound (channel_id NOT NULL), validated per pipeline
--   kind, runs main.py, and carries 0031's API-hold triggers. A generation has
--   no channel. What is reused is the SHAPE: claim with FOR UPDATE SKIP LOCKED,
--   a heartbeat, stale re-queue bounded by max_attempts, and 0020's hold.
--
-- WHAT IT ADDS
--   creative_jobs        one generation (image / video / speech / sound):
--                        who asked, which model, the validated params, the
--                        quote, the hold that pays for it, the provider task,
--                        the result and the error. Written ONLY by the
--                        functions below — never directly by a browser, the
--                        service key, or anyone else.
--   creative_job_events  the append-only status log of each job (nothing may
--                        update or delete a row; a trigger refuses).
--
-- THE MONEY (0020's functions, called as they are; their internals untouched)
--   quote_creative_job(org, capability, model, params)
--       credits = max( ceil_cent(quantity x credits_per_unit x (1 + margin)),
--                      ceil_cent(job_minimum) )
--       where the rate is the credit_prices row named by the model's
--       model_registry.credit_unit (0035). The price is computed HERE, never
--       taken from the client. quantity is the capability's measure:
--         t2i          1 image
--         t2v sfx music duration_s seconds of output
--         tts          characters of text
--       No credit_unit, or no credit_prices row for it: 'unpriced' — never 0.
--       job_minimum is included because reserve_credits refuses any hold
--       below it (0020): the quote is exactly what can be held.
--   create_creative_job(org, capability, model, params, mode, idem_key, max)
--       one transaction: lock the org's credit account, re-quote, refuse a
--       price above what the person confirmed (max_credits), reserve_credits
--       (org, 'cj:<job id>', quote) — the hold equals the quote — and insert
--       the job. Two concurrent creates for one org serialise on the account
--       lock, so they can never hold more than the org has. The operator's
--       organization is exempt (reserve_credits answers exempt; nothing held).
--       A quote of 0 (an admin priced the unit at 0) holds nothing either.
--       In the exempt organization only a platform owner/admin may create:
--       the platform pays there, and 0018 made every older account a member.
--   worker: start_credit_reservation(credit_ref, org) after the claim (the
--       worker applies NIGHTSHIFT_CREDITS_ENFORCE, as for render_jobs);
--   finish_creative_job: success -> capture_credits(credit_ref, charge) with
--       charge <= the hold (default: the quote); failure -> release_credits.
--       In the SAME transaction as the status change.
--   cancel / expire / a lost worker -> release_credits, same transaction.
--
-- THE MODEL MUST BE SELLABLE (model_registry, migration 0035)
--   availability in ('beta','ga') AND verified_at IS NOT NULL AND the model
--   lists the capability. When 0035 is not applied, quote and create refuse
--   with 'registry_missing' — never "allow every model". model_registry is
--   referenced only inside plpgsql bodies behind to_regclass(), so this file
--   applies on a database without 0035. entitlement: 'any' (or unset) is open;
--   'paid' needs a purchase in the org's credit ledger (0031's rule); any
--   other value is refused ('entitlement_required') until something can check
--   it.
--
-- WHO MAY DO WHAT (no customer roles: "member of this organization")
--   creative_jobs / creative_job_events
--       select: members of the job's organization (and platform admins, who
--       0018 makes members of every organization) · no insert / update /
--       delete for anyone
--   quote_creative_job, create_creative_job, cancel_creative_job
--       signed-in members of the organization (authenticated)
--   claim_creative_job, heartbeat_creative_job, advance_creative_job,
--   finish_creative_job, expire_creative_jobs
--       service role only (the creative worker)
--   anon gets nothing at all.
--
--   reserve_credits (0020) still requires an org owner/admin from a browser,
--   and release_credits the platform. A generation is open to every member,
--   so create / cancel call them as the platform (creative_platform_reserve /
--   creative_platform_release: the caller's JWT claims are cleared for that
--   one call and put back) AFTER checking membership themselves, with an
--   amount and a job reference the function computed — never the caller's.
--   Those two helpers are executable by no API role.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps):
--   42501 forbidden (not signed in / not a member) · P0002 not_found
--   NS400 registry_missing | model_not_sellable | entitlement_required |
--         unpriced | invalid_params | capability_not_supported |
--         mode_not_supported | invalid_idempotency_key
--   NS409 price_changed | idempotency_conflict | not_cancellable
--   NS402 insufficient credits (raised by reserve_credits, 0020)
--
-- DURABILITY (the worker's side, modules/creative_worker.py)
--   The worker marks 'submitting' BEFORE the billable provider call and
--   stores provider_task_id right after it, BEFORE polling. A job whose worker
--   died is re-queued with its provider_task_id, and the next claim polls that
--   task — it never submits twice. A job that died between 'submitting' and
--   the stored id is failed ('submit_interrupted') and its hold released: the
--   provider may have charged the platform, never the customer twice.
--   Statuses: queued -> running -> provider_pending -> processing ->
--   completed | failed | cancelled | expired. ('planning' and 'rendering' are
--   reserved for agent and render jobs.) 'expired' = never claimed within its
--   TTL (2 hours, below 0020's 3-hour unstarted-hold expiry).
--
-- REQUIRES 0018 (organizations) and 0020 (credits). Additive and idempotent:
-- guarded creates, drop-then-create policies and triggers, create-or-replace
-- functions. Nothing existing is dropped or changed.

do $$
begin
  if to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0036 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.reserve_credits(uuid, text, numeric)') is null
     or to_regprocedure('public.release_credits(text)') is null
     or to_regprocedure('public.capture_credits(text, numeric, boolean)') is null
     or to_regprocedure('public.credit_account_lock(uuid)') is null
     or to_regclass('public.credit_prices') is null then
    raise exception '0036 needs the credits ledger: apply 0020_credits.sql first';
  end if;
end $$;

create extension if not exists pgcrypto;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.creative_jobs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete restrict,
  kind              text not null default 'generate',
  capability        text not null,
  mode              text not null default 'exact',
  requested_model   text not null,
  routed_model      text,
  route             jsonb,
  fallback_from     text,
  fallback_reason   text,
  params            jsonb not null default '{}'::jsonb,
  status            text not null default 'queued',
  provider_task_id  text,
  submit_started_at timestamptz,
  attempts          integer not null default 0,
  max_attempts      integer not null default 3,
  worker_id         text,
  heartbeat_at      timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  expires_at        timestamptz not null default now() + interval '2 hours',
  payer             text not null default 'credits',
  credit_ref        text,
  credit_unit       text,
  quantity          numeric(14,4),
  quoted_credits    numeric(14,2) not null default 0,
  charged_credits   numeric(14,2),
  error_code        text,
  error             text,
  result            jsonb,
  result_asset_ids  uuid[] not null default '{}',
  parent_job_id     uuid references public.creative_jobs (id) on delete restrict,
  idempotency_key   text,
  request_hash      text,
  requested_by      uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.creative_jobs drop constraint if exists creative_jobs_kind_check;
alter table public.creative_jobs add constraint creative_jobs_kind_check
  check (kind in ('generate', 'ingest', 'render', 'agent'));
alter table public.creative_jobs drop constraint if exists creative_jobs_capability_check;
alter table public.creative_jobs add constraint creative_jobs_capability_check
  check (capability ~ '^[a-z][a-z0-9_]{0,31}$');
alter table public.creative_jobs drop constraint if exists creative_jobs_mode_check;
alter table public.creative_jobs add constraint creative_jobs_mode_check
  check (mode in ('exact', 'auto', 'cheap', 'fast', 'quality'));
alter table public.creative_jobs drop constraint if exists creative_jobs_model_check;
alter table public.creative_jobs add constraint creative_jobs_model_check
  check (requested_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
         and (routed_model is null or routed_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
         and (fallback_from is null or fallback_from ~ '^[a-z0-9][a-z0-9._-]{0,63}$'));
alter table public.creative_jobs drop constraint if exists creative_jobs_status_check;
alter table public.creative_jobs add constraint creative_jobs_status_check
  check (status in ('queued', 'planning', 'running', 'provider_pending', 'processing',
                    'rendering', 'completed', 'failed', 'cancelled', 'expired'));
alter table public.creative_jobs drop constraint if exists creative_jobs_payer_check;
alter table public.creative_jobs add constraint creative_jobs_payer_check
  check (payer in ('credits', 'api_balance'));
alter table public.creative_jobs drop constraint if exists creative_jobs_credit_ref_check;
alter table public.creative_jobs add constraint creative_jobs_credit_ref_check
  check (credit_ref is null or credit_ref ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$');
alter table public.creative_jobs drop constraint if exists creative_jobs_sizes_check;
alter table public.creative_jobs add constraint creative_jobs_sizes_check
  check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 16384
         and (route is null or octet_length(route::text) <= 4096)
         and (result is null or octet_length(result::text) <= 16384)
         and (provider_task_id is null or char_length(provider_task_id) between 1 and 512)
         and (fallback_reason is null or char_length(fallback_reason) <= 500)
         and (worker_id is null or char_length(worker_id) <= 120)
         and (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_:.-]{1,255}$'));
alter table public.creative_jobs drop constraint if exists creative_jobs_error_check;
alter table public.creative_jobs add constraint creative_jobs_error_check
  check ((error_code is null or error_code ~ '^[a-z0-9_]{1,64}$')
         and (error is null or char_length(error) <= 2000));
alter table public.creative_jobs drop constraint if exists creative_jobs_credits_check;
alter table public.creative_jobs add constraint creative_jobs_credits_check
  check (quoted_credits >= 0
         and (charged_credits is null or (charged_credits >= 0 and charged_credits <= quoted_credits)));
alter table public.creative_jobs drop constraint if exists creative_jobs_attempts_check;
alter table public.creative_jobs add constraint creative_jobs_attempts_check
  check (attempts >= 0 and max_attempts between 1 and 10);

-- One hold pays for one job; one idempotency key names one job per org.
create unique index if not exists creative_jobs_credit_ref_key
  on public.creative_jobs (credit_ref) where credit_ref is not null;
create unique index if not exists creative_jobs_idem_key
  on public.creative_jobs (org_id, idempotency_key) where idempotency_key is not null;
create index if not exists creative_jobs_org_idx
  on public.creative_jobs (org_id, created_at desc);
create index if not exists creative_jobs_queue_idx
  on public.creative_jobs (status, created_at)
  where status in ('queued', 'running', 'provider_pending', 'processing', 'rendering');

comment on table public.creative_jobs is
  'One creative generation (migration 0036): the model, validated params, quote, the credit hold that pays for it (credit_ref), the provider task, result and error. Written only by the 0036 functions; read by members of the organization.';
comment on column public.creative_jobs.provider_task_id is
  'The provider''s id for the submitted (paid) task. Stored before polling, so a worker that dies resumes by polling it instead of submitting again.';
comment on column public.creative_jobs.submit_started_at is
  'Set just before the billable provider call. Set with no provider_task_id after a crash = the provider may have the task: the job is failed and released, never re-submitted.';
comment on column public.creative_jobs.credit_ref is
  'The credit_reservations.job_id (cj:<id>) that pays for this job (0020). Null for the exempt organization or a zero quote.';

create table if not exists public.creative_job_events (
  id         bigserial primary key,
  job_id     uuid not null references public.creative_jobs (id) on delete restrict,
  org_id     uuid not null references public.organizations (id) on delete restrict,
  event      text not null,
  status     text not null,
  detail     jsonb,
  actor      uuid,
  created_at timestamptz not null default now()
);

alter table public.creative_job_events drop constraint if exists creative_job_events_event_check;
alter table public.creative_job_events add constraint creative_job_events_event_check
  check (event ~ '^[a-z][a-z_]{0,39}$'
         and (detail is null or octet_length(detail::text) <= 4096));

create index if not exists creative_job_events_job_idx
  on public.creative_job_events (job_id, id);

comment on table public.creative_job_events is
  'Append-only status log of creative_jobs (migration 0036). Written only by the 0036 functions; nobody may update or delete a row.';

create or replace function public.creative_job_events_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'creative_job_events is append-only' using errcode = '42501';
end
$$;

drop trigger if exists creative_job_events_append_only on public.creative_job_events;
create trigger creative_job_events_append_only
  before update or delete on public.creative_job_events
  for each row execute function public.creative_job_events_append_only();

drop trigger if exists creative_job_events_no_truncate on public.creative_job_events;
create trigger creative_job_events_no_truncate
  before truncate on public.creative_job_events
  for each statement execute function public.creative_job_events_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.creative_refuse(p_code text, p_detail text default null,
                                                  p_state text default 'NS400')
  returns void
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception '%', p_code using errcode = p_state, detail = coalesce(p_detail, p_code);
end
$$;

create or replace function public.creative_job_log(
  p_job uuid, p_org uuid, p_event text, p_status text, p_detail jsonb default null
) returns void
  language sql security definer set search_path = public, pg_temp as $$
  insert into public.creative_job_events (job_id, org_id, event, status, detail, actor)
  values (p_job, p_org, p_event, p_status, p_detail, auth.uid())
$$;

-- reserve_credits as the platform: see the header. The claims are cleared for
-- this one call only and put back before returning — and before re-raising
-- when the call fails (a caller that catches the error, in a savepoint or a
-- plpgsql exception block, must not go on as the platform; the rollback of
-- that savepoint restores the setting too, this does not rely on it). Every
-- setting is transaction-local.
create or replace function public.creative_platform_reserve(p_org uuid, p_ref text, p_amount numeric)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  saved text := current_setting('request.jwt.claims', true);
  out_  jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    out_ := public.reserve_credits(p_org, p_ref, p_amount);
  exception when others then
    perform set_config('request.jwt.claims', coalesce(saved, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claims', coalesce(saved, ''), true);
  return out_;
end
$$;

-- release_credits as the platform, for a hold that exists. Returns what was
-- released (0 when there was no open hold).
create or replace function public.creative_platform_release(p_ref text) returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  saved text := current_setting('request.jwt.claims', true);
  out_  numeric;
begin
  if p_ref is null or not exists (select 1 from public.credit_reservations where job_id = p_ref) then
    return 0;
  end if;
  perform set_config('request.jwt.claims', '', true);
  begin
    out_ := public.release_credits(p_ref);
  exception when others then
    perform set_config('request.jwt.claims', coalesce(saved, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claims', coalesce(saved, ''), true);
  return coalesce(out_, 0);
end
$$;

-- Capabilities a job may be created for today. The ones that take an input
-- image or clip (edit, i2v, v2v, upscale, …) arrive with the media library
-- (0038): a URL typed by a browser is not an input the worker may fetch.
create or replace function public.creative_capability_supported(p_capability text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_capability in ('t2i', 't2v', 'tts', 'sfx', 'music')
$$;

-- A JSON whole number within [lo, hi]. Separate statements, so the cast only
-- ever sees a JSON number (OR does not promise an evaluation order).
create or replace function public.creative_json_int(p jsonb, lo numeric, hi numeric) returns boolean
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  n numeric;
begin
  if p is null or jsonb_typeof(p) <> 'number' then
    return false;
  end if;
  n := (p #>> '{}')::numeric;
  return n = trunc(n) and n between lo and hi;
end
$$;

-- Why these params cannot be sent, or null. Unknown keys are refused, not
-- ignored: a typo must never silently become a default.
create or replace function public.creative_params_problem(p_capability text, p_params jsonb)
  returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k text;
  timed boolean := p_capability in ('t2v', 'sfx', 'music');
begin
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    return 'params must be a JSON object';
  end if;
  if octet_length(p_params::text) > 16384 then
    return 'params are too large';
  end if;
  for k in select jsonb_object_keys(p_params) loop
    if k not in ('prompt', 'negative_prompt', 'aspect_ratio', 'resolution', 'duration_s',
                 'voice_id', 'seed') then
      return format('unknown parameter %s', k);
    end if;
  end loop;
  if jsonb_typeof(p_params -> 'prompt') is distinct from 'string'
     or char_length(btrim(p_params ->> 'prompt')) = 0 then
    return 'prompt is required';
  end if;
  if char_length(p_params ->> 'prompt') > 4000 then
    return 'prompt is longer than 4000 characters';
  end if;
  if p_params ? 'negative_prompt' and (jsonb_typeof(p_params -> 'negative_prompt') <> 'string'
                                       or char_length(p_params ->> 'negative_prompt') > 2000) then
    return 'negative_prompt must be text of at most 2000 characters';
  end if;
  if p_params ? 'aspect_ratio' and (jsonb_typeof(p_params -> 'aspect_ratio') <> 'string'
                                    or (p_params ->> 'aspect_ratio') !~ '^[1-9][0-9]?:[1-9][0-9]?$') then
    return 'aspect_ratio must look like 16:9';
  end if;
  if p_params ? 'resolution' and (jsonb_typeof(p_params -> 'resolution') <> 'string'
                                  or (p_params ->> 'resolution') !~ '^(480|540|720|1080|1440|2160)p$') then
    return 'resolution must be one of 480p 540p 720p 1080p 1440p 2160p';
  end if;
  if timed then
    if not public.creative_json_int(p_params -> 'duration_s', 1, 60) then
      return 'duration_s must be a whole number of seconds from 1 to 60';
    end if;
  elsif p_params ? 'duration_s' then
    return format('duration_s does not apply to %s', p_capability);
  end if;
  if p_params ? 'voice_id' then
    if p_capability <> 'tts' then
      return format('voice_id does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'voice_id') <> 'string'
       or (p_params ->> 'voice_id') !~ '^[A-Za-z0-9_-]{1,64}$' then
      return 'voice_id must be 1-64 letters, digits, _ or -';
    end if;
  end if;
  if p_params ? 'seed' and not public.creative_json_int(p_params -> 'seed', 0, 2147483647) then
    return 'seed must be a whole number from 0 to 2147483647';
  end if;
  return null;
end
$$;

-- How many units of the capability's measure these params ask for.
create or replace function public.creative_quantity(p_capability text, p_params jsonb) returns numeric
  language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_capability = 't2i' then 1::numeric
    when p_capability in ('t2v', 'sfx', 'music') then (p_params ->> 'duration_s')::numeric
    when p_capability = 'tts' then char_length(p_params ->> 'prompt')::numeric
  end
$$;

-- The quote, computed from the registry and the price list only. Raises the
-- refusal codes of the header. Returns
--   {credits, exempt, model, capability, unit, quantity, credits_per_unit,
--    margin, minimum}
create or replace function public.creative_price(
  p_org uuid, p_capability text, p_model text, p_params jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap     text := lower(btrim(coalesce(p_capability, '')));
  mdl     text := lower(btrim(coalesce(p_model, '')));
  problem text;
  m_unit  text;
  m_ent   text;
  m_found boolean := false;
  rate    public.credit_prices;
  floor_c numeric;
  qty     numeric;
  price   numeric;
  minimum numeric := 0;
begin
  if cap !~ '^[a-z][a-z0-9_]{0,31}$' then
    perform public.creative_refuse('invalid_params', 'capability is required');
  end if;
  if not public.creative_capability_supported(cap) then
    perform public.creative_refuse('capability_not_supported',
      format('%s cannot be generated yet on this deployment', cap));
  end if;
  if mdl !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'model is required');
  end if;
  problem := public.creative_params_problem(cap, p_params);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;

  -- Never "allow every model" when the registry is not there (see header).
  if to_regclass('public.model_registry') is null then
    perform public.creative_refuse('registry_missing',
      'the model registry (migration 0035) is not applied on this deployment');
  end if;
  select true, r.credit_unit, r.entitlement
    into m_found, m_unit, m_ent
    from public.model_registry r
   where r.id = mdl
     and r.availability in ('beta', 'ga')
     and r.verified_at is not null
     and cap = any (r.capabilities);
  if not coalesce(m_found, false) then
    perform public.creative_refuse('model_not_sellable',
      format('%s is not available for %s', mdl, cap));
  end if;
  if coalesce(m_ent, 'any') not in ('any', 'paid') then
    perform public.creative_refuse('entitlement_required',
      format('%s needs the %s entitlement', mdl, m_ent));
  end if;
  if m_ent = 'paid' and not public.credits_exempt(p_org)
     and not exists (select 1 from public.credit_transactions t
                      where t.org_id = p_org and t.kind = 'purchase') then
    perform public.creative_refuse('entitlement_required',
      format('%s is available after the organization''s first credit purchase', mdl));
  end if;

  if m_unit is not null then
    select * into rate from public.credit_prices where unit = m_unit;
  end if;
  if m_unit is null or rate.unit is null then
    perform public.creative_refuse('unpriced',
      format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
  end if;

  qty := public.creative_quantity(cap, p_params);
  -- Rounded to 6 places before the upward cent, so numeric division noise
  -- never adds a cent (0030 does the same).
  price := public.credits_round_up(round(qty * rate.credits_per_unit * (1 + rate.margin), 6));
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null then
    minimum := public.credits_round_up(floor_c);
  end if;
  if price > 0 then
    price := greatest(price, minimum);
  end if;

  return jsonb_build_object(
    'credits', price, 'exempt', public.credits_exempt(p_org),
    'model', mdl, 'capability', cap, 'unit', rate.unit, 'quantity', qty,
    'credits_per_unit', rate.credits_per_unit, 'margin', rate.margin, 'minimum', minimum);
end
$$;

-- The job as the app shows it (never the params' internals beyond what the
-- member sent, never the worker's id).
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
$$;

-- End a job that has not finished (failed / cancelled / expired) and give its
-- hold back, in the caller's transaction. Returns the credits released.
create or replace function public.creative_end_locked(
  p_job uuid, p_status text, p_code text, p_error text
) returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j public.creative_jobs;
  org uuid;
  released numeric := 0;
begin
  -- The account first, then the job: the order every function here and in
  -- 0020 takes, so two of them never wait on each other.
  select org_id into org from public.creative_jobs where id = p_job;
  if org is null then
    return 0;
  end if;
  perform public.credit_account_lock(org);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.status in ('completed', 'failed', 'cancelled', 'expired') then
    return 0;
  end if;
  update public.creative_jobs
     set status = p_status, error_code = p_code, error = left(p_error, 2000),
         charged_credits = 0, worker_id = null, finished_at = now(), updated_at = now()
   where id = p_job;
  if j.payer = 'credits' then
    released := public.creative_platform_release(j.credit_ref);
  end if;
  perform public.creative_job_log(p_job, j.org_id, p_status, p_status,
    jsonb_build_object('code', p_code, 'released', released));
  return released;
end
$$;

-- Queued jobs nobody claimed within their TTL (optionally one org's).
create or replace function public.creative_expire_locked(p_org uuid) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s record;
  n integer := 0;
begin
  for s in
    select id, org_id from public.creative_jobs
     where status = 'queued' and started_at is null and expires_at <= now()
       and (p_org is null or org_id = p_org)
     -- Accounts are locked in one order by every sweep, so two sweeps over
     -- several organizations never wait on each other.
     order by org_id, id
  loop
    -- Account first, then the job, re-checked under its lock: a job a worker
    -- claimed a moment ago is left alone.
    perform public.credit_account_lock(s.org_id);
    perform 1 from public.creative_jobs
      where id = s.id and status = 'queued' and started_at is null
      for update skip locked;
    if found then
      perform public.creative_end_locked(s.id, 'expired', 'not_picked_up',
        'no worker picked the job up in time; the credits were released');
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The browser's calls (signed-in members, through the Command Center)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.quote_creative_job(
  p_org uuid, p_capability text, p_model text, p_params jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q   jsonb;
  acc public.credit_accounts;
begin
  if auth.uid() is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  q := public.creative_price(p_org, p_capability, p_model, p_params);
  select * into acc from public.credit_accounts where org_id = p_org;
  return q || jsonb_build_object(
    'available', case when public.credits_exempt(p_org) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;

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
  if md <> 'exact' then
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

  q := public.creative_price(p_org, p_capability, p_model, p_params);
  price := (q ->> 'credits')::numeric;
  if p_max_credits is not null and price > p_max_credits then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', price, p_max_credits), 'NS409');
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
     p_params, 'queued', 'credits', ref, q ->> 'unit', (q ->> 'quantity')::numeric, price,
     idem, hash_, uid, now() + interval '2 hours')
  returning * into j;
  perform public.creative_job_log(jid, p_org, 'created', 'queued',
    jsonb_build_object('quoted_credits', price, 'held', ref is not null));

  return jsonb_build_object('job', public.creative_job_json(j), 'replay', false);
end
$$;

-- A member stops a job that has not reached the provider yet; its hold is
-- released in the same transaction. Once the provider has the task it is
-- being paid for, so it runs to the end (not_cancellable).
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
  if not found or not public.is_org_member(j.org_id) then
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The worker's calls (service role)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.expire_creative_jobs() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are expired by the platform only' using errcode = '42501';
  end if;
  return public.creative_expire_locked(null);
end
$$;

-- First returns crashed jobs to the queue, then claims the oldest queued job
-- (a job with a provider task first: it is already being paid for). A lost
-- job keeps its provider_task_id, and claiming it puts it straight back in
-- provider_pending, so the worker polls instead of submitting.
create or replace function public.claim_creative_job(
  p_worker text, p_stale_after interval default interval '10 minutes'
) returns setof public.creative_jobs
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c record;
  s record;
  v_id uuid;
  w text := left(btrim(coalesce(p_worker, '')), 120);
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are claimed by the platform''s worker only' using errcode = '42501';
  end if;
  if w = '' then
    raise exception 'p_worker is required' using errcode = '22023';
  end if;

  for c in
    select id, org_id from public.creative_jobs
     where status in ('running', 'provider_pending', 'processing', 'rendering')
       and coalesce(heartbeat_at, started_at, created_at) < now() - p_stale_after
     order by org_id, id
  loop
    -- Account first, then the job, re-checked under its lock (a heartbeat
    -- may have arrived since the scan).
    perform public.credit_account_lock(c.org_id);
    select id, attempts, max_attempts, provider_task_id, submit_started_at into s
      from public.creative_jobs
     where id = c.id
       and status in ('running', 'provider_pending', 'processing', 'rendering')
       and coalesce(heartbeat_at, started_at, created_at) < now() - p_stale_after
     for update skip locked;
    if not found then
      continue;
    end if;
    if s.submit_started_at is not null and s.provider_task_id is null then
      perform public.creative_end_locked(s.id, 'failed', 'submit_interrupted',
        'the worker stopped while submitting to the provider; it is never submitted twice, and the credits were released');
    elsif s.attempts >= s.max_attempts then
      perform public.creative_end_locked(s.id, 'failed', 'worker_lost',
        format('worker lost (no heartbeat) on the last of %s attempts; the credits were released', s.max_attempts));
    else
      update public.creative_jobs
         set status = 'queued', worker_id = null, updated_at = now()
       where id = s.id;
      perform public.creative_job_log(s.id, c.org_id,
        'requeued', 'queued', jsonb_build_object('reason', 'no heartbeat'));
    end if;
  end loop;

  perform public.creative_expire_locked(null);

  select q.id into v_id
    from public.creative_jobs q
   where q.status = 'queued'
   order by (q.provider_task_id is null), q.created_at, q.id
   for update skip locked
   limit 1;
  if v_id is null then
    return;
  end if;

  return query
    update public.creative_jobs j
       set status = case when j.provider_task_id is not null then 'provider_pending' else 'running' end,
           worker_id = w, attempts = j.attempts + 1,
           started_at = coalesce(j.started_at, now()), heartbeat_at = now(), updated_at = now()
     where j.id = v_id
    returning j.*;
  perform public.creative_job_log(v_id, (select org_id from public.creative_jobs where id = v_id),
    'claimed', (select status from public.creative_jobs where id = v_id),
    jsonb_build_object('worker', w));
end
$$;

create or replace function public.heartbeat_creative_job(p_job uuid, p_worker text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  update public.creative_jobs
     set heartbeat_at = now()
   where id = p_job and worker_id = left(btrim(coalesce(p_worker, '')), 120)
     and status in ('running', 'provider_pending', 'processing', 'rendering');
  return found;
end
$$;

-- The worker's steps between claim and finish. False = do not proceed (the
-- job is no longer this worker's, or the step would repeat a paid call):
--   submitting  before the billable provider call; only once per job
--   submitted   the provider's task id, stored BEFORE any polling
--   processing  the provider finished; downloading / storing the output
--   requeue     a shutdown hands the job back (only when nothing is in doubt:
--               not yet submitting, or the task id is stored); the attempt is
--               given back
create or replace function public.advance_creative_job(
  p_job uuid, p_worker text, p_step text,
  p_provider_task_id text default null, p_route jsonb default null
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j public.creative_jobs;
  w text := left(btrim(coalesce(p_worker, '')), 120);
  tid text := nullif(btrim(coalesce(p_provider_task_id, '')), '');
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job for update;
  if not found or j.worker_id is distinct from w then
    return false;
  end if;
  if p_step = 'submitting' then
    if j.status <> 'running' or j.submit_started_at is not null or j.provider_task_id is not null then
      return false;
    end if;
    update public.creative_jobs
       set submit_started_at = now(), heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'submitted' then
    if j.status <> 'running' or j.submit_started_at is null or j.provider_task_id is not null
       or tid is null or char_length(tid) > 512 then
      return false;
    end if;
    update public.creative_jobs
       set provider_task_id = tid, status = 'provider_pending',
           route = coalesce(p_route, route), heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'processing' then
    if j.status <> 'provider_pending' then
      return false;
    end if;
    update public.creative_jobs
       set status = 'processing', heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'requeue' then
    if j.status not in ('running', 'provider_pending', 'processing')
       or (j.submit_started_at is not null and j.provider_task_id is null) then
      return false;
    end if;
    update public.creative_jobs
       set status = 'queued', worker_id = null, attempts = greatest(j.attempts - 1, 0),
           updated_at = now()
     where id = p_job;
  else
    raise exception 'unknown step' using errcode = '22023';
  end if;
  perform public.creative_job_log(p_job, j.org_id, p_step,
    (select status from public.creative_jobs where id = p_job),
    case when p_step = 'submitted' then jsonb_build_object('task', true) end);
  return true;
end
$$;

-- Settle a job: success captures at most the hold (default: the quote),
-- failure releases it in full — in the same transaction as the status.
-- Finishing twice (a retried call) changes nothing and returns the job.
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

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.creative_jobs enable row level security;
alter table public.creative_job_events enable row level security;

-- Rows change only through the functions above: no direct write for anyone,
-- the service key included (it bypasses RLS, not privileges).
revoke all on public.creative_jobs, public.creative_job_events
  from public, anon, authenticated, service_role;
revoke all on sequence public.creative_job_events_id_seq from public, anon, authenticated, service_role;
grant select on public.creative_jobs, public.creative_job_events to authenticated, service_role;

drop policy if exists creative_jobs_select on public.creative_jobs;
create policy creative_jobs_select on public.creative_jobs
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists creative_job_events_select on public.creative_job_events;
create policy creative_job_events_select on public.creative_job_events
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

revoke all on function public.creative_job_events_append_only() from public, anon, authenticated, service_role;
revoke all on function public.creative_refuse(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.creative_job_log(uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_platform_reserve(uuid, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.creative_platform_release(text) from public, anon, authenticated, service_role;
revoke all on function public.creative_capability_supported(text) from public, anon, authenticated, service_role;
revoke all on function public.creative_json_int(jsonb, numeric, numeric) from public, anon, authenticated, service_role;
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_quantity(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_job_json(public.creative_jobs) from public, anon, authenticated, service_role;
revoke all on function public.creative_end_locked(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.creative_expire_locked(uuid) from public, anon, authenticated, service_role;

revoke all on function public.quote_creative_job(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.cancel_creative_job(uuid) from public, anon, authenticated, service_role;
grant execute on function public.quote_creative_job(uuid, text, text, jsonb) to authenticated;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;
grant execute on function public.cancel_creative_job(uuid) to authenticated;

revoke all on function public.expire_creative_jobs() from public, anon, authenticated, service_role;
revoke all on function public.claim_creative_job(text, interval) from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_creative_job(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.advance_creative_job(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.expire_creative_jobs() to service_role;
grant execute on function public.claim_creative_job(text, interval) to service_role;
grant execute on function public.heartbeat_creative_job(uuid, text) to service_role;
grant execute on function public.advance_creative_job(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.creative_jobs'::regclass, 'public.creative_job_events'::regclass)) as rls_on,
--   not has_table_privilege('authenticated', 'public.creative_jobs', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.creative_jobs', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.creative_jobs', 'DELETE')
--     and not has_table_privilege('service_role', 'public.creative_jobs', 'UPDATE')
--     and not has_table_privilege('anon', 'public.creative_jobs', 'SELECT')
--     and not has_table_privilege('anon', 'public.creative_job_events', 'SELECT') as rows_not_writable,
--   has_function_privilege('authenticated',
--       'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)', 'EXECUTE')
--     and not has_function_privilege('anon',
--       'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.claim_creative_job(text,interval)', 'EXECUTE')
--     and not has_function_privilege('authenticated',
--       'public.finish_creative_job(uuid,text,boolean,numeric,jsonb,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_platform_reserve(uuid,text,numeric)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.creative_platform_release(text)', 'EXECUTE')
--     as functions_scoped,
--   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.prosecdef and p.proname like '%creative%'
--       and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 0
--     as definer_functions_pin_search_path;
