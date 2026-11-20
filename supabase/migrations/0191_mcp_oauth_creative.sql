-- 0191_mcp_oauth_creative.sql — the Studio's generations for an AI assistant the person connected with OAuth (0093): a quote the
-- database keeps, a create that spends exactly that quote, and a per-model switch that is off unless a reviewed registry change
-- turns it on (the first: Recraft V4.1 / Flash, on the vendor's written permission).
--
-- WHY A MIGRATION. A connected app reaches the database only through oauth_ctx (0093/0147), whose endpoint list is the whole surface
-- ("a new api_* endpoint ships closed to tokens"). The creative API (0062's api_creative_quote / api_creative_create, 0162's list and
-- files) is keyed by an API key: its idempotency record, its link table api_creative_jobs and its monthly ceiling all need a key id,
-- which an access token has none of, and its model set is the API's (sellable_models(…, 'api')). A connection also has its own
-- monthly spending limit (oauth_grants.monthly_limit_credits), which only oauth_create_video counts today. So the person's assistant
-- has no door to the Studio at all, and none of the API's doors is the right one.
--
-- WHAT IT ADDS
--   * A permission, `studio:create` ("generate pictures and clips with the models that allow it; each spends credits"), shown on the
--     consent screen on its own line. Not folded into videos:create: a person who allowed "make videos" never agreed to anything else
--     being made with their credits, so no existing connection gains generation. oauth_scopes_supported() lists it and the grants'
--     check accepts it (the one constraint change; widened, nothing existing fails it).
--   * A per-model switch, OFF unless the registry turns it on: spec.mcp_oauth_exposure (the registry file's `mcp_oauth_exposure`, synced into spec
--     like every other key). Only the JSON value `true` turns a model on for connected assistants; absent, false, "true" or anything
--     else is off. It is separate from api_exposure on purpose: api_exposure is about handing a vendor's model to a developer's own
--     code (an API key), this is about the same end user generating through their own assistant, and a vendor's terms can answer the
--     two differently. Nothing in this file sets it, and tests/test_mcp_oauth_creative_migration.py fails if the registry file turns
--     any model on, so turning one on is a reviewed registry change with the vendor's terms cited, never a default.
--     oauth_creative_model_state() is the one judgement, used by the list, the quote and the create alike: the model must be one the
--     Studio sells today (sellable_models(capability, 'web'): verified, probed, priced, switched on, not past its shutdown, no terms
--     gate), with one of the capabilities the API generates (no captions: a web tool), switched on for assistants, with no
--     blocked_countries (an assistant's request carries no address to check, 0142), and needing no rights acknowledgement (PR #780,
--     0174: spec.requires_acknowledgement or the model_registry.requires_acknowledgement column, read without naming the column so
--     this file applies with or without 0174). An acknowledgement is refused with its own word: it is the person's act in the
--     Studio, and no assistant may give it for them.
--   * oauth_creative_quotes: what one quote priced (capability, model, params, credits, the price's own answer) for ONE connection,
--     for 15 minutes. The quote is creative_price's, never computed outside the database.
--   * oauth_creative_jobs: which connection started which generation, from which quote, under which idempotency key, holding what.
--   * oauth_creative_rate_counters: two buckets of their own per connection (quotes and creates per minute) on top of the
--     connection's 120 requests a minute, so an assistant in a loop cannot quote or start without end.
--   * Five API entry points (anon, a token hash, like oauth_create_video): oauth_creative_models, oauth_media_list,
--     oauth_creative_quote, oauth_creative_create, oauth_creative_get. Each opens with oauth_ctx DIRECTLY (not api_begin), so an API
--     key's hash is refused as unknown here: these are a connection's doors only, and an API key keeps the API's own.
--
-- THE MONEY. oauth_creative_create takes only (quote id, idempotency key): the capability, model and params are the stored quote's,
--   so nothing the assistant sends at create can differ from what the person was shown. It refuses an expired quote, another
--   connection's quote (the same 404 as an unknown id), a quote already used by another key, and a price that is not EXACTLY the
--   quoted one (price_changed, nothing held). It then calls create_creative_job (0075, or 0174's body) — the Studio's own function,
--   as the person who connected the app — with the quoted credits as max_credits, so membership, the model, the price, the hold and
--   the job are decided there, atomically, exactly as in the Studio; and it refuses (undoing the hold) if the job holds anything but
--   the quote. Under the credit account's lock it first checks the connection's monthly limit, which now counts creative holds
--   alongside videos (oauth_grant_month_credits, one added branch). The worker's capture and refund are create_creative_job's and
--   finish_creative_job's, unchanged. Every create writes the same rows the API path writes: an api_requests row (api_finish) and an
--   app_audit_log row 'creative.generate' (via mcp_oauth, with the grant id, like oauth_create_video's 'agent.run').
--
-- REPLACES (md5 drift guards: 0093's bodies, or this file's own on a replay; whitespace runs read as one space):
--   oauth_scopes_supported (0093), oauth_endpoint_scope (0093), oauth_grant_month_credits (0093), oauth_begin_authorization (0147:
--   a client that asks for nothing gets 0093's three). Signatures, SECURITY DEFINER where it was, the pinned search_path and the
--   grants stay as 0093 and 0147 made them. ADDS oauth_drop_requested_scope (authenticated): the consent page's unticked Studio
--   choice takes studio:create off the pending request; it only removes.
-- ALTERS: the check on oauth_grants.scopes (oauth_grants_scopes_check), from 1-3 of the three to 1-4 of the four.
-- NOT CHANGED: create_creative_job (0075; 0174 replaces it), creative_price (0159), sellable_models (0125), api_creative_* (0062,
--   0075, 0124, 0162), oauth_ctx and oauth_check (0147), every price, hold, capture and refund rule, every other table.
--
-- NUMBER. 0191. 0171 is on main; 0172-0175 are held by open pull requests (0174 is #780, 0175 the failed-job cap after it); migrations apply to the live database in ascending
--   order on merge. Needs 0036, 0038, 0062, 0075, 0093, 0124, 0125 and 0147; names nothing of 0148-0170 but the functions above.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where p.oid in ('public.oauth_scopes_supported()'::regprocedure, 'public.oauth_endpoint_scope(text)'::regprocedure,
--                    'public.oauth_grant_month_credits(uuid)'::regprocedure);
--   expected BEFORE b1cdcf014109e5902d0e6d9f05767186, ade9dedd7a1058b4938e9df7e8bd1b87, 6329f5ed73f203e67e31e885238fa1ab (0093),
--   AFTER 3ef7e3154b00584e7625225d20dfa705, 39be9da597b74684494d55e8547e3eae, 6d345abdb50d6c85a4c1276c6e255a14 (this file).
-- Undo: docs/sql/rollback_0191_mcp_oauth_creative.sql (owner-applied; it keeps the record tables).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.oauth_ctx(text, text, text)') is null or to_regclass('public.oauth_grants') is null then
    raise exception '0191 needs 0093_mcp_oauth.sql: apply it first';
  end if;
  if to_regprocedure('public.oauth_check_credit_take(uuid, text)') is null then
    raise exception '0191 needs 0147_mcp_free_tier.sql: apply it first';
  end if;
  if to_regprocedure('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)') is null
     or to_regprocedure('public.creative_route_quote(uuid, text, text, jsonb, text)') is null then
    raise exception '0191 needs 0075_model_router.sql: apply it first';
  end if;
  if to_regprocedure('public.api_creative_refusal(text, text, text)') is null or to_regclass('public.api_creative_jobs') is null then
    raise exception '0191 needs 0062_api_creative.sql: apply it first';
  end if;
  if to_regprocedure('public.model_is_available(text)') is null then
    raise exception '0191 needs 0124_model_switch.sql: apply it first';
  end if;
  if to_regprocedure('public.model_past_shutdown(jsonb)') is null then
    raise exception '0191 needs 0125_model_shutdown.sql: apply it first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0191 needs 0038_media_assets.sql: apply it first';
  end if;
  if not public.audit_action_allowed('creative.generate') then
    raise exception '0191 needs creative.generate in audit_action_allowed (0087 onwards): read the live list first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_scopes_supported()');
  if h is null or h <> all (array['b1cdcf014109e5902d0e6d9f05767186', '3ef7e3154b00584e7625225d20dfa705']) then
    raise exception '0191 found public.oauth_scopes_supported() with a body that is neither 0093''s nor 0191''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text)');
  if h is null or h <> all (array['1d77b561efdb9347dc9465e66fa87e8c', 'c385018bae2e55e8c7d4d67013618146']) then
    raise exception '0191 found public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) with a body that is neither 0147''s nor 0191''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_endpoint_scope(text)');
  if h is null or h <> all (array['ade9dedd7a1058b4938e9df7e8bd1b87', '39be9da597b74684494d55e8547e3eae']) then
    raise exception '0191 found public.oauth_endpoint_scope(text) with a body that is neither 0093''s nor 0191''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_grant_month_credits(uuid)');
  if h is null or h <> all (array['6329f5ed73f203e67e31e885238fa1ab', '6d345abdb50d6c85a4c1276c6e255a14']) then
    raise exception '0191 found public.oauth_grant_month_credits(uuid) with a body that is neither 0093''s nor 0191''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The permission: studio:create
-- ───────────────────────────────────────────────────────────────────────────

-- 0093's list, plus studio:create.
create or replace function public.oauth_scopes_supported() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['videos:read', 'videos:create', 'videos:publish', 'studio:create']::text[]
$$;

-- 0147's oauth_begin_authorization, with one marked hunk: "nothing asked for" still means 0093's three permissions.
create or replace function public.oauth_begin_authorization(
  p_client_id uuid, p_redirect_uri text, p_code_challenge text, p_method text, p_state text,
  p_scope text, p_resource text, p_secret_hash text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user   uuid := auth.uid();
  c        public.oauth_clients;
  v_org    uuid;
  v_scopes text[];
  lim      jsonb := public.oauth_limits();
  v_plan   text;
  v_name   text;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into c from public.oauth_clients where client_id = p_client_id;
  if c.client_id is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_client');
  end if;
  -- Exact string match against what the client registered; until it matches,
  -- nothing is ever sent to the URI.
  if p_redirect_uri is null or not (p_redirect_uri = any (c.redirect_uris)) then
    return jsonb_build_object('ok', false, 'error', 'redirect_mismatch');
  end if;
  if coalesce(p_method, '') <> 'S256' then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'invalid_request',
      'description', 'PKCE with code_challenge_method=S256 is required.');
  end if;
  if coalesce(p_code_challenge, '') !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'invalid_request',
      'description', 'code_challenge must be the base64url SHA-256 of the verifier.');
  end if;
  if p_state is not null and (char_length(p_state) > 512 or p_state ~ '[[:cntrl:]]') then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'invalid_request', 'description', 'state is too long.');
  end if;
  if coalesce(p_resource, '') !~ '^https?://[^[:space:]#]{1,255}$' then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'invalid_target', 'description', 'resource must be the MCP server URL.');
  end if;
  if coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end if;

  -- Unknown scope words are ignored (RFC 6749 3.3: the server may grant less);
  -- nothing asked for means everything the server offers.
  v_scopes := array(select s from unnest(public.oauth_scopes_supported()) s
                     where p_scope is not null and s = any (string_to_array(btrim(p_scope), ' ')));
  if cardinality(v_scopes) = 0 then
    -- 0191: everything but studio:create. Spending on Studio generations is its own consent, so a client gets it only by
    -- asking for it by name; one that asks for nothing (or only words this server does not know) gets 0093's three.
    v_scopes := array(select s from unnest(public.oauth_scopes_supported()) s where s <> 'studio:create');
  end if;

  v_org := public.oauth_workspace(v_user);
  if v_org is null then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'no_workspace');
  end if;
  select o.name into v_name from public.organizations o where o.id = v_org;
  v_plan := public.org_plan_internal(v_org);

  -- 0147: every plan may approve, Free included. `entitled` below stays true for the consent page's shape.

  delete from public.oauth_auth_requests where expires_at < now();
  delete from public.oauth_auth_requests where id in (
    select id from public.oauth_auth_requests where user_id = v_user order by created_at desc
     offset (lim ->> 'max_pending_requests')::int - 1);
  insert into public.oauth_auth_requests
    (secret_hash, user_id, org_id, client_id, redirect_uri, code_challenge, state, scopes, resource)
  values (p_secret_hash, v_user, v_org, c.client_id, p_redirect_uri, p_code_challenge, p_state, v_scopes, p_resource);

  return jsonb_build_object('ok', true, 'entitled', true, 'client_name', c.client_name,
    'redirect_uri', p_redirect_uri, 'workspace_name', v_name, 'plan', v_plan, 'scopes', to_jsonb(v_scopes),
    'default_limit_credits', (lim ->> 'default_limit_credits')::numeric,
    'max_limit_credits', (lim ->> 'max_limit_credits')::numeric,
    'exempt', public.credits_exempt(v_org));
end
$$;

-- The consent page offers studio:create as its own, unticked choice (Lens and Breach on 0191: the MCP server's 401 challenge names
-- every permission it supports, so every client asks for this one, and a person who wanted videos only would have had to grant
-- Studio spending too). Unless the person ticks it, the decision route calls this first. It only REMOVES, only this permission,
-- only from the signed-in person's own live request, and never empties it: it can narrow a connection, never widen one.
-- A request that holds studio:create and nothing else cannot be narrowed (Breach re-run on 0191: it answered false, the route went
-- on, and the unticked permission was granted). That is refused by name, so the approval stops and the page says the remedy: tick
-- Studio, or deny.
create or replace function public.oauth_drop_requested_scope(p_secret_hash text, p_scope text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_scope is distinct from 'studio:create' or coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  if exists (select 1 from public.oauth_auth_requests r
              where r.secret_hash = p_secret_hash and r.user_id = v_user and r.expires_at >= now()
                and r.scopes = array[p_scope]) then
    raise exception 'studio_only' using errcode = '22023',
      hint = 'this app asked only for Studio generations: tick that choice to allow it, or deny';
  end if;
  update public.oauth_auth_requests r
     set scopes = array_remove(r.scopes, p_scope)
   where r.secret_hash = p_secret_hash and r.user_id = v_user and r.expires_at >= now()
     and p_scope = any (r.scopes) and cardinality(r.scopes) > 1;
  return found;
end
$$;

-- 0093's check, widened to the fourth permission. Every existing row passes it (it held 1-3 of the first three).
alter table public.oauth_grants drop constraint if exists oauth_grants_scopes_check;
alter table public.oauth_grants add constraint oauth_grants_scopes_check
  check (cardinality(scopes) between 1 and 4
         and scopes <@ array['videos:read', 'videos:create', 'videos:publish', 'studio:create']::text[]);

-- 0093's allow-list, plus the five Studio doors, every one behind studio:create. Still no `else`: an unlisted endpoint is refused.
create or replace function public.oauth_endpoint_scope(p_endpoint text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case p_endpoint
           when 'oauth.check' then 'any'
           when 'channels.list' then 'videos:read'
           when 'accounts.list' then 'videos:read'
           when 'videos.list' then 'videos:read'
           when 'videos.get' then 'videos:read'
           when 'oauth.jobs.get' then 'videos:read'
           when 'oauth.balance' then 'videos:read'
           when 'oauth.videos.create' then 'videos:create'
           when 'videos.publish' then 'videos:publish'
           -- 0191: the Studio's generations for a connected assistant.
           when 'oauth.creative.models' then 'studio:create'
           when 'oauth.media.list' then 'studio:create'
           when 'oauth.creative.quote' then 'studio:create'
           when 'oauth.creative.create' then 'studio:create'
           when 'oauth.creative.get' then 'studio:create'
         end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The records
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.oauth_creative_quotes (
  id         uuid primary key default gen_random_uuid(),
  grant_id   uuid not null references public.oauth_grants (id) on delete cascade,
  org_id     uuid not null references public.organizations (id) on delete cascade,
  capability text not null,
  model      text not null,
  params     jsonb not null check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 16384),
  credits    numeric(14,2) not null check (credits >= 0),
  -- creative_price's answer, as the quote showed it (the tier, resolution and soundtrack it priced).
  quote      jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- The one generation this quote paid for, once it did.
  job_id     uuid unique,
  check (expires_at > created_at)
);
create index if not exists oauth_creative_quotes_grant_idx on public.oauth_creative_quotes (grant_id, created_at);

create table if not exists public.oauth_creative_jobs (
  job_id         uuid primary key references public.creative_jobs (id) on delete cascade,
  grant_id       uuid not null references public.oauth_grants (id) on delete cascade,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  quote_id       uuid not null unique references public.oauth_creative_quotes (id) on delete restrict,
  idem_key       text not null check (idem_key ~ '^[A-Za-z0-9_:.-]{1,255}$'),
  credit_ref     text,
  quoted_credits numeric(14,2) not null check (quoted_credits >= 0),
  created_at     timestamptz not null default now(),
  unique (grant_id, idem_key)
);
create index if not exists oauth_creative_jobs_grant_idx on public.oauth_creative_jobs (grant_id, created_at);
create index if not exists oauth_creative_jobs_credit_ref_idx on public.oauth_creative_jobs (credit_ref);

create table if not exists public.oauth_creative_rate_counters (
  grant_id uuid not null references public.oauth_grants (id) on delete cascade,
  bucket   text not null check (bucket in ('quote', 'create')),
  minute   timestamptz not null,
  count    integer not null default 0,
  primary key (grant_id, bucket, minute)
);

alter table public.oauth_creative_quotes enable row level security;
alter table public.oauth_creative_jobs enable row level security;
alter table public.oauth_creative_rate_counters enable row level security;
-- No API role reads or writes a row (like every OAuth table): the functions below are the only way in.
revoke all on table public.oauth_creative_quotes from public, anon, authenticated, service_role;
revoke all on table public.oauth_creative_jobs from public, anon, authenticated, service_role;
revoke all on table public.oauth_creative_rate_counters from public, anon, authenticated, service_role;

comment on table public.oauth_creative_quotes is
  '0191: a price creative_price gave one OAuth connection for one exact generation, usable once, for 15 minutes.';
comment on table public.oauth_creative_jobs is
  '0191: a Studio generation an OAuth connection started: which quote, which idempotency key, which hold.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The connection's monthly spend counts its generations
-- ───────────────────────────────────────────────────────────────────────────

-- 0093's sum, plus the holds of this connection's Studio generations (0191). A released hold used none, as before.
create or replace function public.oauth_grant_month_credits(p_grant uuid) returns numeric
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(case cr.status
                        when 'open' then cr.amount
                        when 'captured' then coalesce(cr.captured, cr.amount)
                        else 0 end), 0)
    from (select r.credit_ref from public.oauth_runs r
           where r.grant_id = p_grant and r.created_at >= public.oauth_month_start()
          union all
          -- 0191: a Studio generation this connection started.
          select c.credit_ref from public.oauth_creative_jobs c
           where c.grant_id = p_grant and c.created_at >= public.oauth_month_start()) x
    join public.credit_reservations cr on cr.job_id = x.credit_ref
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The per-model switch, and the numbers
-- ───────────────────────────────────────────────────────────────────────────

-- The capabilities a connected assistant may generate: the API's (0162; command-center/lib/api/operations.ts
-- API_CREATIVE_CAPABILITIES), never captions (a web tool, 0072).
create or replace function public.oauth_creative_capabilities() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg', 'voice_change', 'dub', 'video_upscale',
               'describe', 'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg']::text[]
$$;

create or replace function public.oauth_creative_limits() returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('quote_ttl_seconds', 900, 'quotes_per_minute', 30, 'creates_per_minute', 10, 'open_quotes_max', 50,
                            'media_list_max', 100)
$$;

-- Whether a connected assistant may generate with this model for this capability, in one word:
--   ok | not_offered | acknowledgement_required | temporarily_off
-- The list, the quote and the create all ask this, so the three can never disagree.
create or replace function public.oauth_creative_model_state(p_capability text, p_model text) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap  text := lower(btrim(coalesce(p_capability, '')));
  mdl  text := lower(btrim(coalesce(p_model, '')));
  r    public.model_registry;
  ack  jsonb;
begin
  if not (cap = any (public.oauth_creative_capabilities())) then
    return 'not_offered';
  end if;
  select * into r from public.model_registry m where m.id = mdl;
  if r.id is null or not (cap = any (r.capabilities)) or 'captions' = any (r.capabilities) then
    return 'not_offered';
  end if;
  -- The switch: only JSON true. Absent is off, and so is every other value.
  if (r.spec -> 'mcp_oauth_exposure') is distinct from 'true'::jsonb then
    return 'not_offered';
  end if;
  -- A vendor's country list cannot be checked for an assistant's request (no address): never offered.
  if r.spec ? 'blocked_countries' then
    return 'not_offered';
  end if;
  -- 0174 (PR #780): the registry file's list or the column, whichever exists. Read through to_jsonb so this applies without 0174.
  ack := coalesce(r.spec -> 'requires_acknowledgement', '[]'::jsonb);
  if jsonb_typeof(ack) <> 'array' or jsonb_array_length(ack) > 0
     or coalesce(jsonb_array_length(case when jsonb_typeof(to_jsonb(r) -> 'requires_acknowledgement') = 'array'
                                         then to_jsonb(r) -> 'requires_acknowledgement' end), 0) > 0
     or (to_jsonb(r) ? 'requires_acknowledgement'
         and jsonb_typeof(to_jsonb(r) -> 'requires_acknowledgement') not in ('array', 'null')) then
    return 'acknowledgement_required';
  end if;
  -- The owner's switch (0124): a model otherwise on sale says "temporarily", not "not offered".
  if not public.model_is_available(r.id)
     and r.availability in ('beta', 'ga') and r.verified_at is not null then
    return 'temporarily_off';
  end if;
  -- Everything else the Studio requires to sell it: verified, probed, priced, not past its shutdown, no terms gate.
  -- The 'mcp' surface (0188): a vendor's web-only model is never offered here, whatever the switch says; 'web_mcp' and 'any' are.
  if not exists (select 1 from public.sellable_models(cap, 'mcp') s where s.id = r.id) then
    return 'not_offered';
  end if;
  return 'ok';
end
$$;

-- The refusal of a model state that is not ok (never called with 'ok').
create or replace function public.oauth_creative_state_refusal(p_state text, p_model text) returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select case p_state
    when 'acknowledgement_required' then public.api_err(428, 'acknowledgement_required',
      'This model needs the person''s own confirmation of their rights to the inputs, which is given in the Studio, not through a connected app.',
      jsonb_build_object('model', p_model))
    when 'temporarily_off' then public.api_err(503, 'model_temporarily_off',
      'That model is temporarily unavailable. Nothing was held or charged. Choose another model, or try again later.',
      jsonb_build_object('model', p_model))
    else public.api_err(422, 'model_not_offered',
      'That model is not offered to connected apps for this capability. Nothing was held or charged.',
      jsonb_build_object('model', p_model))
  end
$$;

-- One request of a bucket counted for this connection this minute; the count so far (0093's oauth_rate_take, per bucket).
create or replace function public.oauth_creative_rate_take(p_grant uuid, p_bucket text) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
begin
  insert into public.oauth_creative_rate_counters as c (grant_id, bucket, minute, count)
  values (p_grant, p_bucket, v_minute, 1)
  on conflict (grant_id, bucket, minute) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.oauth_creative_rate_counters c
     where c.grant_id = p_grant and c.bucket = p_bucket and c.minute < v_minute;
  end if;
  return v_used;
end
$$;

-- The 429 of a spent bucket, or null.
create or replace function public.oauth_creative_rate_refusal(p_grant uuid, p_bucket text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_lim  integer := (public.oauth_creative_limits() ->> case p_bucket when 'quote' then 'quotes_per_minute' else 'creates_per_minute' end)::integer;
  v_wait integer := greatest(1, ceil(extract(epoch from (date_trunc('minute', now()) + interval '1 minute' - now())))::integer);
begin
  if public.oauth_creative_rate_take(p_grant, p_bucket) > v_lim then
    return public.api_err(429, 'rate_limit_exceeded',
      format('This connection may %s at most %s times a minute.', case p_bucket when 'quote' then 'quote' else 'start a generation' end, v_lim),
      jsonb_build_object('retry_after', v_wait));
  end if;
  return null;
end
$$;

-- What one quote answers: the generation it prices and the price, never the platform's own figures.
create or replace function public.oauth_creative_quote_json(q public.oauth_creative_quotes) returns jsonb
  language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('quote_id', q.id, 'capability', q.capability, 'model', q.model, 'params', q.params,
                            'credits', q.credits, 'expires_at', q.expires_at)
         || jsonb_strip_nulls(jsonb_build_object('unit', q.quote -> 'unit', 'quantity', q.quote -> 'quantity',
                                                 'quality', q.quote -> 'quality', 'resolution', q.quote -> 'resolution',
                                                 'audio', q.quote -> 'audio'))
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The five doors (anon with a token hash; oauth_ctx decides who it is)
-- ───────────────────────────────────────────────────────────────────────────

-- The models this connection's workspace can generate with now: the switch above, narrowed by creative_price's entitlement rule
-- (0156: `any`, or `paid` once the workspace bought credits or is credits-exempt), like 0162's list. No price: the quote is the price.
create or replace function public.oauth_creative_models(p_token_hash text, p_capability text default null, p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx    jsonb;
  v_org  uuid;
  v_cap  text := nullif(lower(btrim(coalesce(p_capability, ''))), '');
  v_paid boolean;
  v_list jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.models', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    if v_cap is not null and not (v_cap = any (public.oauth_creative_capabilities())) then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params',
        format('capability must be one of: %s.', array_to_string(public.oauth_creative_capabilities(), ', '))), 0);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;
    v_paid := public.credits_exempt(v_org)
              or exists (select 1 from public.credit_transactions t where t.org_id = v_org and t.kind = 'purchase');
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.display_name,
             'capabilities', to_jsonb(array(select c from unnest(s.capabilities) c
                                             where public.oauth_creative_model_state(c, s.id) = 'ok' order by c)),
             'availability', s.availability,
             'spec', s.spec - 'api_exposure') order by s.id), '[]'::jsonb)
      into v_list
      from public.sellable_models(v_cap, 'mcp') s
     where (coalesce(s.entitlement, 'any') = 'any' or (s.entitlement = 'paid' and v_paid))
       and exists (select 1 from unnest(s.capabilities) c
                    where (v_cap is null or c = v_cap) and public.oauth_creative_model_state(c, s.id) = 'ok');
    return public.api_finish(ctx, public.api_ok(jsonb_build_object('capability', v_cap, 'models', v_list)), 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;

-- The workspace's own media library, newest first: the ids a picture-to-clip or an edit takes as source_asset_id. Only live files
-- of this workspace; never a path, a storage key or another workspace's file.
create or replace function public.oauth_media_list(p_token_hash text, p_kind text default null, p_limit integer default null,
                                                   p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx    jsonb;
  v_kind text := nullif(lower(btrim(coalesce(p_kind, ''))), '');
  v_lim  integer;
  v_list jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.media.list', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    if v_kind is not null and v_kind not in ('image', 'video', 'audio') then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params', 'kind must be image, video or audio.'), 0);
    end if;
    v_lim := least(greatest(coalesce(p_limit, 30), 1), (public.oauth_creative_limits() ->> 'media_list_max')::integer);
    select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_list
      from (select m.id, m.created_at,
                   jsonb_build_object('asset_id', m.id, 'kind', m.kind, 'mime', m.mime, 'width', m.width, 'height', m.height,
                                      -- No file name (Breach on 0191): any member may upload and name a file, and the name would reach
                                      -- the admin's assistant as tool output, verbatim. The id, type and size are enough to use it.
                                      'duration_s', m.duration_s, 'source', m.source,
                                      'created_at', m.created_at) as j
              from public.media_assets m
             where m.org_id = (ctx ->> 'org_id')::uuid
               and m.deleted_at is null and m.purged_at is null
               and m.kind in ('image', 'video', 'audio')
               and (v_kind is null or m.kind = v_kind)
             order by m.created_at desc, m.id
             limit v_lim) x;
    return public.api_finish(ctx, public.api_ok(jsonb_build_object('kind', v_kind, 'media', v_list)), 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;

-- The price of one exact generation, kept for this connection for 15 minutes. Free: nothing is held.
create or replace function public.oauth_creative_quote(p_token_hash text, p_capability text, p_model text, p_params jsonb,
                                                       p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx      jsonb;
  v_org    uuid;
  v_grant  uuid;
  v_cap    text := lower(btrim(coalesce(p_capability, '')));
  v_model  text := lower(btrim(coalesce(p_model, '')));
  v_p      jsonb := coalesce(p_params, '{}'::jsonb);
  v_state  text;
  v_q      jsonb;
  v_row    public.oauth_creative_quotes;
  v_res    jsonb;
  v_spent  numeric;
  v_msg    text;
  v_detail text;
  v_sql    text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.quote', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    v_grant := (ctx ->> 'grant_id')::uuid;
    v_res := public.oauth_creative_rate_refusal(v_grant, 'quote');
    if v_res is not null then
      return public.api_finish(ctx, v_res, 0);
    end if;
    if jsonb_typeof(v_p) <> 'object' or pg_column_size(v_p) > 16384 then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params', 'params must be a JSON object (at most 16 KB).'), 0);
    end if;
    v_state := public.oauth_creative_model_state(v_cap, v_model);
    if v_state <> 'ok' then
      return public.api_finish(ctx, public.oauth_creative_state_refusal(v_state, v_model), 0);
    end if;
    begin
      -- The Studio's own price for this workspace: the model, the settings, the source file (this workspace's, live), the
      -- entitlement. Computed nowhere else.
      v_q := public.creative_price(v_org, v_cap, v_model, v_p);
      -- A connection's own quotes that ran out are of no use to anyone; a connection holds at most a few live ones (storage is a
      -- ceiling: 30 quotes a minute of up to 16 KB each would otherwise pile up).
      delete from public.oauth_creative_quotes q
       where q.grant_id = v_grant and q.job_id is null and q.expires_at < now();
      if (select count(*) from public.oauth_creative_quotes q where q.grant_id = v_grant and q.job_id is null)
         >= (public.oauth_creative_limits() ->> 'open_quotes_max')::integer then
        return public.api_finish(ctx, public.api_err(429, 'too_many_quotes',
          'This connection has too many open quotes. Create from one, or wait for them to expire.',
          jsonb_build_object('retry_after', 60)), 0);
      end if;
      -- The tier, resolution and soundtrack the price is for are written into the params, the way create_creative_job writes
      -- them into the job: what runs is what was shown, even if a model's default changes before create.
      v_p := v_p || (v_q - array(select k from jsonb_object_keys(v_q) k where k not in ('quality', 'resolution', 'audio')));
      insert into public.oauth_creative_quotes (grant_id, org_id, capability, model, params, credits, quote, expires_at)
      values (v_grant, v_org, v_cap, v_model, v_p, (v_q ->> 'credits')::numeric, v_q - 'exempt' - 'preview',
              now() + make_interval(secs => (public.oauth_creative_limits() ->> 'quote_ttl_seconds')::integer))
      returning * into v_row;
      v_spent := public.oauth_grant_month_credits(v_grant);
      v_res := public.api_ok(public.oauth_creative_quote_json(v_row)
        || jsonb_build_object('this_connection', jsonb_build_object(
             'monthly_limit_credits', (ctx ->> 'limit_credits')::numeric)
           -- Only where create applies the limit: on the credits-exempt workspace it is not a ceiling, so no number is shown as one.
           || case when public.credits_exempt(v_org) then '{}'::jsonb
                   else jsonb_build_object('left_this_month_credits', greatest((ctx ->> 'limit_credits')::numeric - v_spent, 0)) end), 201);
    exception when others then
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
      v_sql := sqlstate;
      v_res := public.api_creative_refusal(v_sql, v_msg, v_detail);
    end;
    return public.api_finish(ctx, v_res, 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;

-- Start the generation one quote priced, at exactly that price, once per idempotency key.
create or replace function public.oauth_creative_create(p_token_hash text, p_quote_id uuid, p_idem_key text,
                                                        p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx      jsonb;
  v_org    uuid;
  v_grant  uuid;
  v_idem   text := btrim(coalesce(p_idem_key, ''));
  v_key    text;
  prior    public.oauth_creative_jobs;
  q        public.oauth_creative_quotes;
  j        public.creative_jobs;
  acc      public.credit_accounts;
  v_state  text;
  v_price  numeric;
  v_limit  numeric;
  v_spent  numeric;
  v_out    jsonb;
  v_res    jsonb;
  v_msg    text;
  v_detail text;
  v_sql    text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.create', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    v_grant := (ctx ->> 'grant_id')::uuid;
    if v_idem = '' then
      return public.api_finish(ctx, public.api_err(400, 'idempotency_key_required',
        'Send an idempotency_key: a generation spends credits, and a retry must not spend twice.'), 0);
    end if;
    if v_idem !~ '^[A-Za-z0-9_:.-]{1,255}$' then
      return public.api_finish(ctx, public.api_err(400, 'invalid_idempotency_key',
        'idempotency_key: 1-255 characters of A-Z a-z 0-9 _ : . -'), 0);
    end if;
    if p_quote_id is null then
      return public.api_finish(ctx, public.api_err(400, 'quote_required',
        'Send the quote_id of a quote this connection made: a generation runs only at a price the person was shown.'), 0);
    end if;

    -- One create at a time per connection, so its monthly limit cannot be raced past and a retry finds the first one's row.
    -- (Lock order as in api_creative_create: this lock first, then the credit account inside.)
    perform pg_advisory_xact_lock(hashtextextended('oauth_creative:' || v_grant::text, 0));

    -- A replay of the same key answers the first generation and costs nothing more (no rate unit either).
    select * into prior from public.oauth_creative_jobs where grant_id = v_grant and idem_key = v_idem;
    if prior.job_id is not null then
      if prior.quote_id is distinct from p_quote_id then
        return public.api_finish(ctx, public.api_err(422, 'idempotency_key_reused',
          'This idempotency_key was already used for a different quote.'), 0);
      end if;
      select * into j from public.creative_jobs where id = prior.job_id and org_id = v_org;
      return public.api_finish(ctx, public.api_ok(public.api_creative_job_json(j) || jsonb_build_object('replayed', true), 200), 0);
    end if;

    v_res := public.oauth_creative_rate_refusal(v_grant, 'create');
    if v_res is not null then
      return public.api_finish(ctx, v_res, 0);
    end if;

    -- Only this connection's own quote: another connection's, even in the same workspace, reads exactly like an unknown id.
    select * into q from public.oauth_creative_quotes where id = p_quote_id and grant_id = v_grant and org_id = v_org for update;
    if q.id is null then
      return public.api_finish(ctx, public.api_err(404, 'quote_not_found',
        'No quote with that id for this connection. Quote again (quote_creative).'), 0);
    end if;
    if q.job_id is not null then
      return public.api_finish(ctx, public.api_err(409, 'quote_used',
        'That quote already paid for a generation. Quote again for another one.', jsonb_build_object('job_id', q.job_id)), 0);
    end if;
    if q.expires_at <= now() then
      return public.api_finish(ctx, public.api_err(409, 'quote_expired',
        'That quote has expired. Quote again, tell the person the price, and create only if they agree.',
        jsonb_build_object('expired_at', q.expires_at)), 0);
    end if;
    -- The model may have been switched off since the quote.
    v_state := public.oauth_creative_model_state(q.capability, q.model);
    if v_state <> 'ok' then
      return public.api_finish(ctx, public.oauth_creative_state_refusal(v_state, q.model), 0);
    end if;
    -- A limit of 0 is a read-only connection, whoever pays: a generation can be priced at 0, so `spent + 0 > 0` would let one
    -- through on a paying workspace too (Lens).
    if (ctx ->> 'limit_credits')::numeric <= 0 then
      return public.api_finish(ctx, public.api_err(402, 'connection_limit_reached',
        'This connection is read-only: its monthly spending limit is 0.',
        -- What was spent is counted, never assumed to be 0: the limit may have been lowered after spending.
        jsonb_build_object('limit_credits', 0, 'spent_credits', public.oauth_grant_month_credits(v_grant),
                           'price_credits', q.credits)), 0);
    end if;

    begin
      -- The price now, for exactly what was quoted: anything but the same number is refused, never charged.
      v_price := (public.creative_price(v_org, q.capability, q.model, q.params) ->> 'credits')::numeric;
      if v_price is distinct from q.credits then
        v_res := public.api_err(409, 'price_changed',
          'The price changed since the quote. Nothing was held. Quote again and confirm the new price with the person.',
          jsonb_build_object('quoted_credits', q.credits, 'price_credits', v_price));
      end if;
      if v_res is null and not (ctx ->> 'exempt')::boolean then
        acc := public.credit_account_lock(v_org);
        v_limit := (ctx ->> 'limit_credits')::numeric;
        v_spent := public.oauth_grant_month_credits(v_grant);
        if v_spent + q.credits > v_limit then
          v_res := public.api_err(402, 'connection_limit_reached',
            'This generation would take this connection past its monthly spending limit.',
            jsonb_build_object('limit_credits', v_limit, 'spent_credits', v_spent, 'price_credits', q.credits));
        end if;
      end if;
      if v_res is null then
        -- Namespaced by the connection: no other connection or key of the workspace can replay it. 'oa-' + 64 hex fits 0036's rule.
        v_key := 'oa-' || encode(sha256(convert_to(v_grant::text || ':' || v_idem, 'UTF8')), 'hex');
        -- The Studio's own function, as the person who connected the app (oauth_ctx acted as them): membership, the model, the price,
        -- max_credits (the quote), the hold and the job, atomically.
        v_out := public.create_creative_job(v_org, q.capability, q.model, q.params, 'exact', v_key, q.credits);
        select * into j from public.creative_jobs where id = (v_out -> 'job' ->> 'id')::uuid and org_id = v_org;
        if j.id is null then
          raise exception 'job missing after create' using errcode = 'XX000';
        end if;
        -- What is held is what the person was shown, or nothing at all (this raise undoes the hold and the job).
        if j.quoted_credits is distinct from q.credits then
          perform public.creative_refuse('price_changed', format('price=%s confirmed=%s', j.quoted_credits, q.credits), 'NS409');
        end if;
        insert into public.oauth_creative_jobs (job_id, grant_id, org_id, quote_id, idem_key, credit_ref, quoted_credits)
        values (j.id, v_grant, v_org, q.id, v_idem, j.credit_ref, j.quoted_credits);
        update public.oauth_creative_quotes set job_id = j.id where id = q.id;
        insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail, channel_id)
        values ((ctx ->> 'created_by')::uuid, nullif(auth.jwt() ->> 'email', ''), 'creative.generate', j.id::text,
                jsonb_build_object('org_id', v_org, 'capability', q.capability, 'model', q.model,
                                   'quoted_credits', j.quoted_credits, 'credit_ref', j.credit_ref,
                                   'via', 'mcp_oauth', 'grant_id', v_grant, 'quote_id', q.id), null);
        v_res := public.api_ok(public.api_creative_job_json(j), 201);
      end if;
    exception when others then
      -- This block is undone: no job, no hold, no link row, the quote still unused. The request still counts.
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
      v_sql := sqlstate;
      if v_sql = 'NS402' then
        select * into acc from public.credit_accounts where org_id = v_org;
        v_res := public.api_err(402, 'insufficient_credits',
          'The workspace does not have enough credits for this generation. Nothing was held.',
          jsonb_build_object('available_credits',
                               case when coalesce(acc.use_extra_credits, true)
                                    then greatest(coalesce(acc.balance, 0) - coalesce(acc.reserved, 0), 0)
                                    else public.credit_spendable_internal(v_org) end,
                             'held_credits', coalesce(acc.reserved, 0), 'price_credits', q.credits)
          || case when coalesce(acc.use_extra_credits, true) then '{}'::jsonb
                  else jsonb_build_object('extra_credits_off', true) end);
      elsif v_sql = 'NS409' and btrim(coalesce(v_msg, '')) = 'price_changed' then
        v_res := public.api_err(409, 'price_changed',
          'The price changed since the quote. Nothing was held. Quote again and confirm the new price with the person.',
          jsonb_build_object('quoted_credits', q.credits));
      elsif btrim(coalesce(v_msg, '')) = 'acknowledgement_required' then
        -- 0174's refusal inside create_creative_job, should a model need it after all: the person confirms in the Studio.
        v_res := public.oauth_creative_state_refusal('acknowledgement_required', q.model);
      else
        v_res := public.api_creative_refusal(v_sql, v_msg, v_detail);
      end if;
    end;
    return public.api_finish(ctx, v_res, 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;

-- A generation THIS connection started, with its result files once it completed (0162's rule, BR-0162-1: never an uncharged result).
create or replace function public.oauth_creative_get(p_token_hash text, p_job_id uuid, p_request_id text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb;
  j       public.creative_jobs;
  v_files jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  ctx := public.oauth_ctx(p_token_hash, 'oauth.creative.get', p_request_id);
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select c.* into j
      from public.creative_jobs c
      join public.oauth_creative_jobs o on o.job_id = c.id
     where c.id = p_job_id
       and o.grant_id = (ctx ->> 'grant_id')::uuid
       and o.org_id = c.org_id
       and c.org_id = (ctx ->> 'org_id')::uuid;
    if j.id is null then
      return public.api_finish(ctx, public.api_err(404, 'job_not_found', 'No generation with that id for this connection.'), 0);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
             'asset_id', m.id, 'kind', m.kind, 'mime', m.mime, 'variants', to_jsonb(m.variants),
             'width', m.width, 'height', m.height, 'duration_s', m.duration_s)
             order by array_position(j.result_asset_ids, m.id)), '[]'::jsonb)
      into v_files
      from public.media_assets m
     where j.status = 'completed'
       and m.id = any (j.result_asset_ids)
       and m.org_id = j.org_id
       and m.deleted_at is null
       and m.storage = 'local';
    return public.api_finish(ctx, public.api_ok(public.api_creative_job_json(j) || jsonb_build_object('files', v_files)), 0);
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'), 0);
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Privileges: the five doors to anon (the server's session-less client), like every oauth_* entry point; the rest to nobody
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.oauth_scopes_supported() from public, anon, authenticated, service_role;
revoke all on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) to authenticated;
revoke all on function public.oauth_drop_requested_scope(text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_drop_requested_scope(text, text) to authenticated;
revoke all on function public.oauth_endpoint_scope(text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_grant_month_credits(uuid) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_capabilities() from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_limits() from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_model_state(text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_state_refusal(text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_rate_take(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_rate_refusal(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_quote_json(public.oauth_creative_quotes) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_models(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_media_list(text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_quote(text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_create(text, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_creative_get(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_creative_models(text, text, text) to anon;
grant execute on function public.oauth_media_list(text, text, integer, text) to anon;
grant execute on function public.oauth_creative_quote(text, text, text, jsonb, text) to anon;
grant execute on function public.oauth_creative_create(text, uuid, text, text) to anon;
grant execute on function public.oauth_creative_get(text, uuid, text) to anon;

-- End state: refuse to finish with the wrong shape.
do $$
declare
  fn regprocedure;
begin
  foreach fn in array array['public.oauth_creative_models(text, text, text)'::regprocedure,
                            'public.oauth_media_list(text, text, integer, text)'::regprocedure,
                            'public.oauth_creative_quote(text, text, text, jsonb, text)'::regprocedure,
                            'public.oauth_creative_create(text, uuid, text, text)'::regprocedure,
                            'public.oauth_creative_get(text, uuid, text)'::regprocedure] loop
    if not has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0191 end state: % has the wrong grants', fn;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0191 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', fn;
    end if;
  end loop;
  foreach fn in array array['public.oauth_creative_model_state(text, text)'::regprocedure,
                            'public.oauth_creative_rate_take(uuid, text)'::regprocedure,
                            'public.oauth_creative_rate_refusal(uuid, text)'::regprocedure,
                            'public.oauth_grant_month_credits(uuid)'::regprocedure,
                            'public.oauth_endpoint_scope(text)'::regprocedure,
                            'public.oauth_scopes_supported()'::regprocedure] loop
    if has_function_privilege('anon', fn, 'EXECUTE') or has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0191 end state: % may be called by an API role', fn;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.oauth_creative_quotes', 'SELECT')
     or has_table_privilege('authenticated', 'public.oauth_creative_jobs', 'SELECT')
     or has_table_privilege('authenticated', 'public.oauth_creative_quotes', 'INSERT')
     or has_table_privilege('service_role', 'public.oauth_creative_jobs', 'UPDATE') then
    raise exception '0191 end state: an API role can reach a record table';
  end if;
  if public.oauth_endpoint_scope('creative.quote') is not null or public.oauth_endpoint_scope('creative.create') is not null then
    raise exception '0191 end state: the API key''s creative endpoints reached the token allow-list';
  end if;
  if not ('studio:create' = any (public.oauth_scopes_supported())) then
    raise exception '0191 end state: studio:create is not a supported permission';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select 'studio:create' = any (public.oauth_scopes_supported()) as permission_listed,
--        public.oauth_endpoint_scope('oauth.creative.create') = 'studio:create' as create_needs_it,
--        public.oauth_endpoint_scope('creative.create') is null as api_key_doors_stay_closed,
--        not exists (select 1 from public.model_registry where spec -> 'mcp_oauth_exposure' = 'true'::jsonb
--                     and id not in ('recraft-v4.1', 'recraft-v4.1-flash')) as only_reviewed_models_on,
--        public.oauth_creative_quote(repeat('0', 64), 't2i', 'x', '{}'::jsonb, null) ->> 'status' = '401' as quote_refuses_unknown_token,
--        public.oauth_creative_create('not-a-token', gen_random_uuid(), 'k', null) ->> 'status' = '401' as create_refuses_bad_token,
--        not has_table_privilege('authenticated', 'public.oauth_creative_quotes', 'SELECT') as quotes_private;
