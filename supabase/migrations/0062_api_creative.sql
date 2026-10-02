-- 0062_api_creative.sql — creative generations through the public API
-- (Creative OS, plan §3.9): quote, start and read a generation with an API
-- key, on the credits the UI path already uses.
--
--   POST /api/v1/creative/quote        api_creative_quote   (scope creative:quote)
--   POST /api/v1/creative/jobs         api_creative_create  (scope creative:create)
--   GET  /api/v1/creative/jobs/{id}    api_creative_get     (scope creative:read)
--
-- THE MONEY IS THE UI'S MONEY, NOT A SECOND LEDGER
--   A generation started with a key is the SAME generation as one started in
--   the Studio: api_creative_create calls 0036's create_creative_job (the
--   latest function bodies, by name), which re-quotes, refuses a price above
--   the confirmed max_credits, holds the quote with reserve_credits and queues
--   the job in one transaction. The worker then captures (finish_creative_job)
--   or releases (failure, expiry, loss) exactly as for a Studio job; nothing in
--   this file moves a credit itself. Unlike videos (0031) this is NOT paid
--   from the separate USD API balance: the organization's credits pay.
--   A key may therefore be given its own monthly credit ceiling
--   (api_keys.creative_monthly_credits), and every request names the most it
--   accepts to pay (max_credits).
--
-- WHAT A KEY MAY DO (new: scopes)
--   api_keys.scopes lists them: account:read, videos:read, videos:write,
--   creative:quote, creative:create, creative:read. A key made before this
--   file (scopes null) keeps exactly the first three — it gains nothing, and
--   in particular cannot spend credits on generations. api_begin, which every
--   entry point starts from, refuses a call whose endpoint is outside the
--   key's scopes (403 insufficient_scope); an endpoint that maps to no scope is
--   refused as well (fail closed), only /me is open to every valid key.
--   Per-key request limit: api_keys.rpm_limit can only LOWER the usage tier's
--   requests per minute, never raise it.
--
-- WHAT MAKES IT SAFE
--   * the organization is the KEY's (api_begin); a request cannot name another.
--     The key acts as its creator (0031), so create_creative_job's own
--     membership, source-asset (0046) and style-kit (0048) checks apply as
--     they do in the browser: another organization's picture or kit answers
--     exactly like one that does not exist.
--   * a model reaches the API only if sellable_models(capability, 'api')
--     lists it: verified, priced, not terms-gated and not 'web_only' (a vendor
--     that forbids third-party API exposure). The web path offers those on the
--     web surface only; this surface is stricter on purpose.
--   * Idempotency-Key is REQUIRED on create and max_credits is REQUIRED: a
--     retry never pays twice, and a price that moved is refused, not charged.
--     The job's own idempotency key is namespaced by the API key, so two keys
--     of one organization can never replay or collide with each other's jobs.
--   * a key reads only the jobs it created (api_creative_jobs): another key,
--     another organization, a Studio job and a missing id all read as 404.
--   * every refusal is a structured answer; the database's own error text
--     never reaches the client (api_creative_refusal maps the codes).
--
-- THIS FILE REPLACES TWO FUNCTIONS, each on the latest body (0042), with
-- the additions named here and nothing dropped (tests/test_api_creative_migration.py
-- pins both to 0042's text, minus the listed changes):
--   api_begin  per-key request limit; the key's scopes in its context; the
--              scope check
--   api_auth   the key's scopes in /me
--
-- ERRORS (api_creative_refusal): 402 insufficient_credits, key_credit_limit_reached
--   · 403 forbidden, entitlement_required, insufficient_scope (api_begin)
--   · 404 job_not_found · 409 price_changed · 422 model_not_sellable, unpriced,
--   capability_not_supported, source_unavailable, style_unavailable,
--   mode_not_supported, idempotency_key_reused · 429 run_limit_reached
--   · 400 invalid_params, invalid_idempotency_key, idempotency_key_required,
--   max_credits_required · 503 registry_missing
--
-- REQUIRES 0018, 0020, 0031, 0034-0036, 0040, 0042, 0046-0048, 0052, 0055.
-- Additive and idempotent: guarded creates, drop-then-create constraints and
-- policies, create-or-replace functions. Nothing existing is dropped.

do $$
begin
  if to_regprocedure('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)') is null
     or to_regprocedure('public.quote_creative_job(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0062 needs the creative jobs: apply 0036_creative_jobs.sql first';
  end if;
  if to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0062 needs the model registry: apply 0035_model_registry.sql first';
  end if;
  if to_regprocedure('public.api_begin(text, text, text)') is null
     or to_regprocedure('public.api_idem_begin(jsonb, text, text)') is null
     or to_regprocedure('public.create_api_key(uuid, text, bigint)') is null then
    raise exception '0062 needs the public API: apply 0031 and 0042 first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Scopes, per-key limits, and which key started which job
-- ───────────────────────────────────────────────────────────────────────────

-- The names a key's scopes may hold. A new scope is a new migration, which
-- replaces this and the constraint below together.
create or replace function public.api_scopes_valid(p text[]) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p is null
      or (cardinality(p) between 1 and 6
          and not exists (select 1 from unnest(p) s
                           where s is null
                              or s not in ('account:read', 'videos:read', 'videos:write',
                                           'creative:quote', 'creative:create', 'creative:read')))
$$;

-- What a key made before 0062 may do: what it could always do.
create or replace function public.api_legacy_scopes() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['account:read', 'videos:read', 'videos:write']::text[]
$$;

-- The scope an entry point needs. null = none (/me, open to every valid key,
-- so a client can read its own scopes); anything unlisted is 'none', a scope
-- no key can hold, so a new endpoint is closed until it is mapped here.
create or replace function public.api_endpoint_scope(p_endpoint text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case p_endpoint
           when 'me' then null
           when 'balance' then 'account:read'
           when 'channels.list' then 'account:read'
           when 'accounts.list' then 'account:read'
           when 'videos.list' then 'videos:read'
           when 'videos.get' then 'videos:read'
           when 'jobs.get' then 'videos:read'
           when 'downloads.get' then 'videos:read'
           when 'videos.create' then 'videos:write'
           when 'videos.publish' then 'videos:write'
           when 'downloads.create' then 'videos:write'
           when 'creative.quote' then 'creative:quote'
           when 'creative.create' then 'creative:create'
           when 'creative.get' then 'creative:read'
           else 'none'
         end
$$;

alter table public.api_keys add column if not exists scopes text[];
alter table public.api_keys add column if not exists rpm_limit integer;
alter table public.api_keys add column if not exists creative_monthly_credits numeric(14,2);

alter table public.api_keys drop constraint if exists api_keys_scopes_check;
alter table public.api_keys add constraint api_keys_scopes_check check (public.api_scopes_valid(scopes));
alter table public.api_keys drop constraint if exists api_keys_rpm_limit_check;
alter table public.api_keys add constraint api_keys_rpm_limit_check
  check (rpm_limit is null or rpm_limit between 1 and 300);
alter table public.api_keys drop constraint if exists api_keys_creative_credits_check;
alter table public.api_keys add constraint api_keys_creative_credits_check
  check (creative_monthly_credits is null or creative_monthly_credits between 0 and 100000000);

comment on column public.api_keys.scopes is
  'What the key may do (0062). Null = a key made before 0062: account:read, videos:read, videos:write and nothing else.';
comment on column public.api_keys.rpm_limit is
  'Requests per minute for this key (0062). Can only lower the usage tier''s limit.';
comment on column public.api_keys.creative_monthly_credits is
  'Most credits this key may start generations for in a calendar month (0062). Null = no ceiling of its own.';

-- Which key started which generation. A key reads only its own jobs.
create table if not exists public.api_creative_jobs (
  job_id     uuid primary key references public.creative_jobs (id) on delete restrict,
  key_id     uuid not null references public.api_keys (id) on delete cascade,
  org_id     uuid not null references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists api_creative_jobs_key_idx on public.api_creative_jobs (key_id, created_at desc);

comment on table public.api_creative_jobs is
  'Generations started through the public API (0062): which key started which creative_jobs row. Written only by api_creative_create; a key reads only its own.';


-- ───────────────────────────────────────────────────────────────────────────
-- 2. api_begin and api_auth: 0042's bodies, with the additions in the header
-- ───────────────────────────────────────────────────────────────────────────

-- api_begin: 0042's body, with (1) the key's own request limit, which can only
-- lower the tier's; (2) the key's scopes in its context; (3) the scope check,
-- after the creator is confirmed an admin and before the key counts as used.
create or replace function public.api_begin(p_key_hash text, p_endpoint text, p_request_id text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k        public.api_keys;
  s        public.api_settings;
  acc      public.api_accounts;
  v_exempt boolean;
  v_tier   integer;
  lim      record;
  v_rpm    integer;
  v_scope  text;
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
  v_reset  integer;
  ctx      jsonb;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  select * into k from public.api_keys where key_hash = p_key_hash;
  if k.id is null or k.revoked_at is not null then
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  select * into s from public.api_settings where org_id = k.org_id;
  if s.activated_at is null then
    return public.api_err(403, 'api_not_activated',
      'The API is not activated for this organization. An owner or admin can activate it in the Developer console.');
  end if;

  v_exempt := public.credits_exempt(k.org_id);
  select * into acc from public.api_accounts where org_id = k.org_id;
  v_tier := public.api_tier_for(coalesce(acc.paid_total_cents, 0), v_exempt);
  select * into lim from public.api_tier_limits(v_tier);
  v_rpm := least(lim.rpm, coalesce(k.rpm_limit, lim.rpm));

  v_reset := greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
  insert into public.api_rate_counters as c (key_id, minute, count)
  values (k.id, v_minute, 1)
  on conflict (key_id, minute) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.api_rate_counters c where c.key_id = k.id and c.minute < v_minute;
  end if;

  ctx := jsonb_build_object('ok', true, 'key_id', k.id, 'org_id', k.org_id,
    'created_by', k.created_by, 'tier', v_tier, 'exempt', v_exempt,
    'rpm', v_rpm, 'concurrency', lim.concurrency,
    'scopes', to_jsonb(coalesce(k.scopes, public.api_legacy_scopes())),
    'cap_cents', case when v_exempt then null
                      else least(lim.monthly_cap_cents, coalesce(s.monthly_limit_cents, lim.monthly_cap_cents)) end,
    'key_limit_cents', k.monthly_limit_cents,
    'remaining', greatest(0, v_rpm - v_used), 'reset', v_reset,
    'endpoint', coalesce(p_endpoint, 'unknown'), 'request_id', p_request_id);

  if v_used > v_rpm then
    return public.api_finish(ctx, public.api_err(429, 'rate_limit_exceeded',
      format('This key is limited to %s requests per minute on usage tier %s.', v_rpm, v_tier),
      jsonb_build_object('retry_after', v_reset)));
  end if;

  begin
    perform public.api_act_as(k.created_by);
    if not public.is_org_member(k.org_id, 'admin') then
      return public.api_finish(ctx, public.api_err(403, 'key_owner_not_admin',
        'The person who created this key is no longer an owner or admin of its organization. An admin must create a new key.'));
    end if;

    -- 0062: what this key may do. A key made before 0062 (scopes null) keeps
    -- the three scopes it always had and nothing new; an endpoint with no
    -- scope of its own is refused, never allowed.
    v_scope := public.api_endpoint_scope(p_endpoint);
    if v_scope is not null and not (v_scope = any (coalesce(k.scopes, public.api_legacy_scopes()))) then
      return public.api_finish(ctx, public.api_err(403, 'insufficient_scope',
        format('This key does not have the %s scope.', v_scope),
        jsonb_build_object('required_scope', v_scope)));
    end if;

    update public.api_keys set last_used_at = now()
     where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
  return ctx;
end
$$;

-- api_auth: 0042's body, with the key's scopes in the answer.
create or replace function public.api_auth(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'me', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'organization', (select jsonb_build_object('id', o.id, 'name', o.name)
                         from public.organizations o where o.id = (ctx ->> 'org_id')::uuid),
      'key', (select jsonb_build_object('id', k.id, 'name', k.name, 'scopes', ctx -> 'scopes')
                from public.api_keys k where k.id = (ctx ->> 'key_id')::uuid),
      'tier', (ctx ->> 'tier')::int,
      'limits', jsonb_build_object('requests_per_minute', (ctx ->> 'rpm')::int,
                                   'concurrent_videos', (ctx ->> 'concurrency')::int,
                                   'monthly_limit_cents', (ctx ->> 'cap_cents')::bigint,
                                   'key_monthly_limit_cents', (ctx ->> 'key_limit_cents')::bigint))));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- Credits this key has started generations for this calendar month: what each
-- job was charged, or what it holds while it is still running; a job that
-- failed, was cancelled or expired used none.
create or replace function public.api_creative_month_credits(p_key uuid) returns numeric
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(coalesce(c.charged_credits, c.quoted_credits)), 0)
    from public.api_creative_jobs a
    join public.creative_jobs c on c.id = a.job_id
   where a.key_id = p_key
     and c.created_at >= date_trunc('month', now())
     and c.status not in ('failed', 'cancelled', 'expired')
$$;

-- May the API sell this model for this capability? sellable_models is the
-- list the registry offers on the 'api' surface: verified, priced, not
-- terms-gated, and not a model whose vendor forbids third-party API exposure.
create or replace function public.api_creative_model_ok(p_capability text, p_model text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.sellable_models(p_capability, 'api') s where s.id = p_model)
$$;

-- A creative generation as the API shows it: no worker, no provider task, no
-- route, no params (the caller knows what it sent).
create or replace function public.api_creative_job_json(j public.creative_jobs) returns jsonb
  language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', j.id, 'capability', j.capability, 'model', j.requested_model, 'status', j.status,
    'quoted_credits', j.quoted_credits, 'charged_credits', j.charged_credits,
    'error_code', j.error_code, 'error', j.error, 'result', j.result,
    'result_asset_ids', to_jsonb(j.result_asset_ids),
    'created_at', j.created_at, 'updated_at', j.updated_at,
    'finished_at', j.finished_at, 'expires_at', j.expires_at)
$$;

-- A database refusal -> the API's structured error. The message text is the
-- machine code 0036 raises (never a secret); anything unrecognised is a 500
-- that says nothing of the database.
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The entry points (anon, like every API entry point: the key is checked
--    by api_begin, the first thing each one does)
-- ───────────────────────────────────────────────────────────────────────────

-- The price of one generation. Nothing is held and nothing is charged.
create or replace function public.api_creative_quote(
  p_key_hash text, p_capability text, p_model text, p_params jsonb default '{}'::jsonb,
  p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'creative.quote', p_request_id);
  v_cap   text := lower(btrim(coalesce(p_capability, '')));
  v_model text := lower(btrim(coalesce(p_model, '')));
  v_q     jsonb;
  v_res   jsonb;
  v_msg   text;
  v_detail text;
  v_state text;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    begin
      if not public.api_creative_model_ok(v_cap, v_model) then
        perform public.creative_refuse('model_not_sellable', format('%s is not available for %s through the API', v_model, v_cap));
      end if;
      -- The organization is the key's, never the request's.
      v_q := public.quote_creative_job((ctx ->> 'org_id')::uuid, v_cap, v_model, coalesce(p_params, '{}'::jsonb));
      -- The organization's balance is not part of a quote.
      v_res := public.api_ok(jsonb_build_object('quote', v_q - 'available'));
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

-- Quote, hold and queue one generation, in one transaction (create_creative_job).
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
        v_out := public.create_creative_job(v_org, v_cap, v_model, v_p, coalesce(p_mode, 'exact'), v_idem, p_max_credits);
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

-- One generation this key started: its status, and what it was held and
-- charged. Another key's, another organization's and a missing id are all 404.
create or replace function public.api_creative_get(
  p_key_hash text, p_job_id uuid, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'creative.get', p_request_id);
  j   public.creative_jobs;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select c.* into j
      from public.creative_jobs c
      join public.api_creative_jobs a on a.job_id = c.id
     where c.id = p_job_id
       and a.key_id = (ctx ->> 'key_id')::uuid
       and a.org_id = c.org_id
       and c.org_id = (ctx ->> 'org_id')::uuid;
    if j.id is null then
      return public.api_finish(ctx, public.api_err(404, 'job_not_found', 'No generation with that id for this key.'));
    end if;
    return public.api_finish(ctx, public.api_ok(public.api_creative_job_json(j)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The Developer console's calls (owners and admins of the organization)
-- ───────────────────────────────────────────────────────────────────────────

-- A key with its scopes and limits chosen up front. create_api_key (0042)
-- does the minting and its checks; the scopes are set in the same transaction,
-- so a key never exists, even for a moment, with more than the admin chose.
create or replace function public.create_scoped_api_key(
  p_org uuid, p_name text, p_monthly_limit_cents bigint, p_scopes text[],
  p_rpm_limit integer, p_creative_monthly_credits numeric
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_scopes text[];
  v_made   jsonb;
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin of this organization may create API keys' using errcode = '42501';
  end if;
  v_scopes := array(select distinct s from unnest(coalesce(p_scopes, '{}'::text[])) s order by s);
  if cardinality(v_scopes) = 0 or not public.api_scopes_valid(v_scopes) then
    raise exception 'choose at least one valid scope' using errcode = '22023';
  end if;
  if p_rpm_limit is not null and p_rpm_limit not between 1 and 300 then
    raise exception 'requests per minute: 1 to 300' using errcode = '22023';
  end if;
  if p_creative_monthly_credits is not null and p_creative_monthly_credits not between 0 and 100000000 then
    raise exception 'credit limit out of range' using errcode = '22023';
  end if;
  v_made := public.create_api_key(p_org, p_name, p_monthly_limit_cents);
  update public.api_keys
     set scopes = v_scopes, rpm_limit = p_rpm_limit, creative_monthly_credits = p_creative_monthly_credits
   where id = (v_made ->> 'id')::uuid;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.access', v_made ->> 'id',
          jsonb_build_object('org_id', p_org, 'scopes', to_jsonb(v_scopes), 'rpm_limit', p_rpm_limit,
                             'creative_monthly_credits', p_creative_monthly_credits));
  return v_made;
end
$$;

-- Change what an existing (not revoked) key may do. Takes effect on its next request.
create or replace function public.set_api_key_access(
  p_key_id uuid, p_scopes text[], p_rpm_limit integer, p_creative_monthly_credits numeric
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k        public.api_keys;
  v_scopes text[];
begin
  select * into k from public.api_keys where id = p_key_id;
  if k.id is null or auth.uid() is null or not public.is_org_member(k.org_id, 'admin') then
    raise exception 'only an owner or admin of the key''s organization may change it' using errcode = '42501';
  end if;
  if k.revoked_at is not null then
    raise exception 'this key is revoked' using errcode = '22023';
  end if;
  v_scopes := array(select distinct s from unnest(coalesce(p_scopes, '{}'::text[])) s order by s);
  if cardinality(v_scopes) = 0 or not public.api_scopes_valid(v_scopes) then
    raise exception 'choose at least one valid scope' using errcode = '22023';
  end if;
  if p_rpm_limit is not null and p_rpm_limit not between 1 and 300 then
    raise exception 'requests per minute: 1 to 300' using errcode = '22023';
  end if;
  if p_creative_monthly_credits is not null and p_creative_monthly_credits not between 0 and 100000000 then
    raise exception 'credit limit out of range' using errcode = '22023';
  end if;
  update public.api_keys
     set scopes = v_scopes, rpm_limit = p_rpm_limit, creative_monthly_credits = p_creative_monthly_credits
   where id = p_key_id;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.access', p_key_id::text,
          jsonb_build_object('org_id', k.org_id, 'scopes', to_jsonb(v_scopes), 'rpm_limit', p_rpm_limit,
                             'creative_monthly_credits', p_creative_monthly_credits));
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.api_creative_jobs enable row level security;
revoke all on public.api_creative_jobs from public, anon, authenticated, service_role;
grant select on public.api_creative_jobs to authenticated, service_role;
drop policy if exists api_creative_jobs_select on public.api_creative_jobs;
create policy api_creative_jobs_select on public.api_creative_jobs for select to authenticated
  using (org_id in (select public.accessible_org_ids('admin')));

-- The key list shows the new columns (never the hash).
grant select (scopes, rpm_limit, creative_monthly_credits) on public.api_keys to authenticated, service_role;

revoke all on function public.api_scopes_valid(text[]) from public, anon, authenticated, service_role;
revoke all on function public.api_legacy_scopes() from public, anon, authenticated, service_role;
revoke all on function public.api_endpoint_scope(text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_month_credits(uuid) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_model_ok(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_job_json(public.creative_jobs) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_refusal(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_begin(text, text, text) from public, anon, authenticated, service_role;

revoke all on function public.api_auth(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_quote(text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_create(text, text, text, jsonb, text, numeric, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_get(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.api_auth(text, text) to anon;
grant execute on function public.api_creative_quote(text, text, text, jsonb, text) to anon;
grant execute on function public.api_creative_create(text, text, text, jsonb, text, numeric, text, text, text) to anon;
grant execute on function public.api_creative_get(text, uuid, text) to anon;

revoke all on function public.create_scoped_api_key(uuid, text, bigint, text[], integer, numeric) from public, anon, service_role;
revoke all on function public.set_api_key_access(uuid, text[], integer, numeric) from public, anon, service_role;
grant execute on function public.create_scoped_api_key(uuid, text, bigint, text[], integer, numeric) to authenticated;
grant execute on function public.set_api_key_access(uuid, text[], integer, numeric) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.api_creative_jobs'::regclass) as rls_on,
--   not has_table_privilege('authenticated', 'public.api_creative_jobs', 'INSERT')
--     and not has_table_privilege('anon', 'public.api_creative_jobs', 'SELECT') as link_table_closed,
--   not has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'SELECT') as hash_never_readable,
--   has_function_privilege('anon', 'public.api_creative_create(text,text,text,jsonb,text,numeric,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.api_creative_create(text,text,text,jsonb,text,numeric,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.api_begin(text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.create_scoped_api_key(uuid,text,bigint,text[],integer,numeric)', 'EXECUTE')
--     as grants_narrow,
--   public.api_endpoint_scope('creative.create') = 'creative:create'
--     and public.api_endpoint_scope('me') is null
--     and public.api_endpoint_scope('something.new') = 'none' as scopes_fail_closed,
--   (public.api_begin(repeat('0', 64), 'creative.get', null) -> 'error' ->> 'code') = 'invalid_api_key' as unknown_key_refused,
--   (select count(*) from public.api_keys where scopes is null) as legacy_keys_unchanged;
