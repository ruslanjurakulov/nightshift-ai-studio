-- 0093_mcp_oauth.sql — connect an AI app to the MCP server without an API key
-- (MCP authorization, spec 2026-07-28): Nightshift is the OAuth authorization
-- server for its own MCP resource. Ledger rows BR-L-179 .. BR-L-198.
--
-- THE MODEL
--   * A person signs in, sees a consent screen and sets a per-connection monthly
--     spend limit in CREDITS. Allowing creates a GRANT (oauth_grants): one
--     person, one workspace, one app, a scope list and that limit. The app gets a
--     short-lived access token (1 hour) and a rotating refresh token (30 days
--     sliding, 90 days absolute). Tokens are opaque 256-bit values minted by the
--     server; ONLY their SHA-256 is stored here (oauth_tokens), never a token.
--   * OAuth-connected MCP is a SUBSCRIPTION feature: entitlement `mcp` (0034, now
--     'enforced') on the workspace's plan. Creator, Pro and Studio have it; Free
--     does not; the operator's own organization is exempt. It is checked at
--     consent, at the token and refresh endpoints and on EVERY call, live.
--   * It spends the workspace's SITE CREDITS (0020/0034 lots, holds, capture,
--     release), exactly as a video made in the app does, never the prepaid USD
--     API balance (0031). The API-key door (nsk_live_ keys, REST /api/v1 and
--     key-based MCP) is untouched and stays on the USD balance. Every create
--     goes through reserve_credits() and the render_jobs payment guard (0041,
--     0076) as the grant's person, with a price computed here from the same
--     credit_prices rows the guard checks; an unpriced video is refused, never free.
--   * The per-connection monthly credit limit is enforced under the credit
--     account's row lock, so concurrent calls cannot jointly exceed it.
--
-- HOW AN ACCESS TOKEN REACHES THE EXISTING ENTRY POINTS
--   Every api_* entry point starts with api_begin(key_hash, endpoint, request).
--   This file replaces api_begin by 0062's body plus ONE change: a hash that is
--   NOT an API key is handed to oauth_ctx() instead of being refused outright.
--   Every path of a real API key is byte-for-byte as before (tests pin that).
--   oauth_ctx checks the token, the grant, the workspace membership, the
--   entitlement, a per-grant request limit and an ALLOW-LIST of endpoints and
--   scopes. The USD-balance endpoints (api_create_video, api_request_download,
--   balance, creative, me) are not on the list: a token can never reach them,
--   even by calling the database directly with the public anon key.
--
-- WHAT IS NOT IN THIS FILE
--   Paid HD downloads are not offered to connected apps (they are priced in USD
--   cents from the API balance and their file route is an API-key route).
--
-- ACCESS (no table-level access for any API role; everything through functions)
--   anon (server route handlers; secrets decide, nothing here trusts a caller):
--     oauth_register_client, oauth_exchange_code, oauth_refresh, oauth_revoke_token,
--     oauth_check, oauth_create_video, oauth_get_job, oauth_get_balance
--     (and the existing api_* reads/publish, now reachable with a token hash)
--   authenticated (the signed-in person, their own rows only):
--     oauth_begin_authorization, oauth_decide_authorization, oauth_my_grants,
--     oauth_revoke_grant, oauth_set_grant_limit, oauth_revoke_all_grants
--   nobody: oauth_ctx and the helpers.
--
-- BUILT ON the LATEST api_begin (0062); tests/test_mcp_oauth_migration.py pins
-- every string literal of it. Additive and replay-safe: guarded creates,
-- drop-then-create constraints, create-or-replace functions, on conflict
-- do nothing seeds. REQUIRES 0018, 0020, 0031, 0034, 0042, 0062.

do $$
begin
  if to_regprocedure('public.api_begin(text, text, text)') is null
     or to_regprocedure('public.api_scopes_valid(text[])') is null then
    raise exception '0093 needs the public API: apply 0031, 0042 and 0062 first';
  end if;
  if to_regprocedure('public.reserve_credits(uuid, text, numeric)') is null
     or to_regprocedure('public.has_entitlement_internal(uuid, text)') is null then
    raise exception '0093 needs credits and plans: apply 0020 and 0034 first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables. RLS on, no policy, no grant: no API role reads or writes any of
--    them; only the functions below (security definer) do.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.oauth_settings (
  id     boolean primary key default true check (id),
  pepper text not null default encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text || gen_random_uuid()::text, 'UTF8')), 'hex')
);
insert into public.oauth_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.oauth_clients (
  client_id          uuid primary key default gen_random_uuid(),
  client_name        text not null check (char_length(client_name) between 1 and 80 and client_name !~ '[[:cntrl:]]'),
  redirect_uris      text[] not null check (cardinality(redirect_uris) between 1 and 5),
  ip_hash            text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  last_authorized_at timestamptz
);
create index if not exists oauth_clients_created_idx on public.oauth_clients (created_at);
create index if not exists oauth_clients_ip_idx on public.oauth_clients (ip_hash, created_at);

create table if not exists public.oauth_auth_requests (
  id             uuid primary key default gen_random_uuid(),
  secret_hash    text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  user_id        uuid not null references auth.users (id) on delete cascade,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  client_id      uuid not null references public.oauth_clients (client_id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state          text check (state is null or char_length(state) <= 512),
  scopes         text[] not null,
  resource       text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '10 minutes'
);
create index if not exists oauth_auth_requests_user_idx on public.oauth_auth_requests (user_id, created_at);

create table if not exists public.oauth_grants (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  org_id                uuid not null references public.organizations (id) on delete cascade,
  client_id             uuid not null references public.oauth_clients (client_id) on delete restrict,
  scopes                text[] not null check (cardinality(scopes) between 1 and 3
                                               and scopes <@ array['videos:read', 'videos:create', 'videos:publish']::text[]),
  resource              text not null,
  monthly_limit_credits numeric(14,2) not null check (monthly_limit_credits between 0 and 20000),
  created_at            timestamptz not null default now(),
  activated_at          timestamptz,
  last_used_at          timestamptz,
  revoked_at            timestamptz,
  revoked_reason        text check (revoked_reason is null or revoked_reason in ('user', 'user_all', 'reuse', 'code_reuse', 'client')),
  absolute_expires_at   timestamptz not null default now() + interval '90 days'
);
create index if not exists oauth_grants_user_idx on public.oauth_grants (user_id, created_at desc);

create table if not exists public.oauth_codes (
  code_hash      text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  grant_id       uuid not null references public.oauth_grants (id) on delete cascade,
  client_id      uuid not null,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '60 seconds',
  used_at        timestamptz
);
create index if not exists oauth_codes_grant_idx on public.oauth_codes (grant_id);

create table if not exists public.oauth_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id   uuid not null references public.oauth_grants (id) on delete cascade,
  kind       text not null check (kind in ('access', 'refresh')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  revoked_at timestamptz
);
create index if not exists oauth_tokens_grant_idx on public.oauth_tokens (grant_id, kind);

create table if not exists public.oauth_runs (
  id             uuid primary key default gen_random_uuid(),
  grant_id       uuid not null references public.oauth_grants (id) on delete cascade,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  idem_key       text not null check (idem_key ~ '^[A-Za-z0-9_:.-]{1,255}$'),
  fingerprint    text not null,
  credit_ref     text unique,
  render_job_id  bigint,
  channel_id     text not null,
  quoted_credits numeric(14,2),
  created_at     timestamptz not null default now(),
  unique (grant_id, idem_key)
);
create index if not exists oauth_runs_grant_idx on public.oauth_runs (grant_id, created_at);

create table if not exists public.oauth_rate_counters (
  grant_id uuid not null references public.oauth_grants (id) on delete cascade,
  minute   timestamptz not null,
  count    integer not null default 0,
  primary key (grant_id, minute)
);

alter table public.oauth_settings enable row level security;
alter table public.oauth_clients enable row level security;
alter table public.oauth_auth_requests enable row level security;
alter table public.oauth_grants enable row level security;
alter table public.oauth_codes enable row level security;
alter table public.oauth_tokens enable row level security;
alter table public.oauth_runs enable row level security;
alter table public.oauth_rate_counters enable row level security;

revoke all on public.oauth_settings, public.oauth_clients, public.oauth_auth_requests, public.oauth_grants,
              public.oauth_codes, public.oauth_tokens, public.oauth_runs, public.oauth_rate_counters
  from public, anon, authenticated, service_role;

comment on table public.oauth_grants is
  '0093: one connected AI app: a person, their workspace, the app, scopes and a monthly credit limit. Tokens live in oauth_tokens as SHA-256 only. No API role has table access.';
comment on table public.oauth_tokens is
  '0093: SHA-256 of opaque access/refresh tokens. A refresh token is single-use; presenting a used one revokes the grant.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The entitlement: `mcp` is enforced from this migration.
-- ───────────────────────────────────────────────────────────────────────────
-- Free: no. Creator, Pro, Studio: yes (the owner: "bought a subscription").
-- It is one row per plan: change it with an UPDATE of plan_entitlements, no code.
-- A workspace with packs but no subscription is on the default (Free) plan and
-- is therefore NOT entitled (org_plan_internal); the operator's organization is
-- exempt (entitlement_keys.exempt_value). `on conflict do nothing`: an edit an
-- admin already made is not overwritten.

update public.entitlement_keys
   set status = 'enforced',
       note = 'May connect an AI app to the MCP server with OAuth (oauth_ctx, oauth_begin_authorization). It spends the workspace''s site credits, capped per connection; the API-key door is separate.'
 where key = 'mcp';

insert into public.plan_entitlements (plan_id, key, value) values
  ('creator', 'mcp', 'true'), ('pro', 'mcp', 'true'), ('studio', 'mcp', 'true'),
  ('free', 'mcp', 'false')
on conflict (plan_id, key) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 2b. The audit trail's action list: 0087's body plus this file's four actions.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.audit_action_allowed(p_action text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_action, '') = any (array[
    'agent.run', 'api.activate', 'api.monthly_limit', 'api.topup_checkout', 'api_key.access', 'api_key.create',
    'api_key.revoke', 'billing.portal', 'billing.refresh', 'billing.settings', 'billing.topup', 'captions.delete',
    'channel.dna.update', 'channel.youtube.connect', 'channel.youtube.connect_failed', 'channel.youtube.disconnect',
    'character.create', 'character.delete', 'character.update', 'creative.cancel', 'creative.generate',
    'editor.export_request', 'editor.project_create', 'editor.project_delete', 'editor.send_asset',
    'media.delete', 'media.folder_create', 'media.folder_delete', 'media.folder_rename', 'media.move',
    'media.upload_request', 'model.availability', 'scene.regenerate', 'secret.write', 'series.create',
    'series.update', 'storyboard.approve', 'storyboard.discard', 'storyboard.edit', 'storyboard.reopen',
    'style_kit.add_library', 'style_kit.attach', 'style_kit.create', 'style_kit.delete', 'style_kit.detach',
    'style_kit.update', 'variable.write', 'video.download_request', 'video.publish_request', 'video.repurpose',
    'workflow.cancel', 'workflow.delete', 'workflow.run', 'workflow.save',
    -- 0093: connecting, disconnecting and re-limiting an AI app (oauth_* functions).
    'mcp.connect', 'mcp.disconnect', 'mcp.disconnect_all', 'mcp.limit',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The numbers in one place. default/max: the consent screen's spend limit (credits).
create or replace function public.oauth_limits() returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'default_limit_credits', 500, 'max_limit_credits', 20000,
    'rpm', 120, 'access_ttl_seconds', 3600, 'refresh_ttl_days', 30, 'absolute_days', 90, 'code_ttl_seconds', 60,
    'max_grants_per_user', 20, 'max_pending_requests', 5,
    'register_per_ip_hour', 10, 'register_global_hour', 300, 'max_clients', 20000)
$$;

create or replace function public.oauth_scopes_supported() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['videos:read', 'videos:create', 'videos:publish']::text[]
$$;

-- Redirect URIs a client may register (RFC 8252 / the MCP spec): https with a
-- real lower-case DNS name, or http to a loopback address, nothing else. The
-- one private-use scheme is the Cursor editor's own callback, matched exactly.
-- No fragment, no userinfo ('@'), no whitespace, backslash or control
-- character, no wildcard, no IP-literal or single-label host over https.
create or replace function public.oauth_redirect_uri_ok(p text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p is not null
     and char_length(p) <= 300
     and p !~ '[[:space:][:cntrl:]\\#@*]'
     and (
       p ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](:[0-9]{1,5})?(/[^?#]*)?(\?[^#]*)?$'
       or p ~ '^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?(/[^?#]*)?(\?[^#]*)?$'
       or p ~ '^cursor://anysphere\.cursor-retrieval/oauth/[A-Za-z0-9._~/-]{1,200}$'
     )
$$;

create or replace function public.oauth_month_start() returns timestamptz
  language sql stable set search_path = public, pg_temp as $$
  select date_trunc('month', now() at time zone 'utc') at time zone 'utc'
$$;

-- Credits this connection has started this calendar month (UTC): what each
-- run was charged, or what it holds while it runs; a released hold used none.
create or replace function public.oauth_grant_month_credits(p_grant uuid) returns numeric
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(case cr.status
                        when 'open' then cr.amount
                        when 'captured' then coalesce(cr.captured, cr.amount)
                        else 0 end), 0)
    from public.oauth_runs r
    join public.credit_reservations cr on cr.job_id = r.credit_ref
   where r.grant_id = p_grant and r.created_at >= public.oauth_month_start()
$$;

-- The workspace of a person: the organization they own (the earliest).
create or replace function public.oauth_workspace(p_user uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select m.org_id from public.org_members m
   where m.user_id = p_user and m.role = 'owner'
   order by m.created_at, m.id limit 1
$$;

-- Revoke one grant and every token of it, at once.
create or replace function public.oauth_revoke_grant_locked(p_grant uuid, p_reason text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  update public.oauth_grants set revoked_at = now(), revoked_reason = p_reason
   where id = p_grant and revoked_at is null;
  get diagnostics n = row_count;
  update public.oauth_tokens set revoked_at = now() where grant_id = p_grant and revoked_at is null;
  delete from public.oauth_codes where grant_id = p_grant and used_at is null;
  return n > 0;
end
$$;

-- Housekeeping, a little on every registration / exchange: expired requests and
-- codes, pending grants nobody redeemed, dead tokens, never-used clients.
create or replace function public.oauth_gc() returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  delete from public.oauth_auth_requests where ctid in (
    select ctid from public.oauth_auth_requests where expires_at < now() limit 200);
  delete from public.oauth_grants where ctid in (
    select ctid from public.oauth_grants
     where (activated_at is null and created_at < now() - interval '1 hour')
        or (revoked_at is not null and revoked_at < now() - interval '30 days')
        or absolute_expires_at < now() - interval '30 days'
     limit 200);
  delete from public.oauth_tokens where ctid in (
    select ctid from public.oauth_tokens where expires_at < now() - interval '1 day' limit 500);
  delete from public.oauth_clients c where c.ctid in (
    select c2.ctid from public.oauth_clients c2
     where c2.created_at < now() - interval '24 hours'
       and coalesce(c2.last_authorized_at, c2.created_at) < now() - case when c2.last_authorized_at is null then interval '24 hours' else interval '30 days' end
       and not exists (select 1 from public.oauth_grants g where g.client_id = c2.client_id)
     limit 200);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. oauth_ctx: what api_begin does for a hash that is an access token
-- ───────────────────────────────────────────────────────────────────────────

-- Endpoint -> scope for a connected app. An endpoint not listed is refused:
-- the list is the whole surface, so a new api_* endpoint ships closed to tokens.
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
         end
$$;

-- The state of an access token: null unless it is a live access token of a live
-- grant. One definition for oauth_ctx and oauth_check.
create or replace function public.oauth_token_state(p_hash text) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('grant_id', g.id, 'user_id', g.user_id, 'org_id', g.org_id, 'client_id', g.client_id,
                            'scopes', to_jsonb(g.scopes), 'resource', g.resource,
                            'limit_credits', g.monthly_limit_credits)
    from public.oauth_tokens t join public.oauth_grants g on g.id = t.grant_id
   where t.token_hash = p_hash and t.kind = 'access'
     and t.revoked_at is null and t.expires_at > now()
     and g.revoked_at is null and g.activated_at is not null and g.absolute_expires_at > now()
     and exists (select 1 from auth.users u where u.id = g.user_id)
$$;

-- One request counted against a connection's per-minute limit; the count so far.
create or replace function public.oauth_rate_take(p_grant uuid) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
begin
  insert into public.oauth_rate_counters as c (grant_id, minute, count)
  values (p_grant, v_minute, 1)
  on conflict (grant_id, minute) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.oauth_rate_counters c where c.grant_id = p_grant and c.minute < v_minute;
  end if;
  return v_used;
end
$$;

create or replace function public.oauth_ctx(p_hash text, p_endpoint text, p_request_id text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st       jsonb := public.oauth_token_state(p_hash);
  v_scope  text;
  v_grant  uuid;
  v_org    uuid;
  v_user   uuid;
  v_exempt boolean;
  v_rpm    integer := (public.oauth_limits() ->> 'rpm')::integer;
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
  v_reset  integer;
  ctx      jsonb;
begin
  if st is null then
    -- Exactly what an unknown API key gets, so the two doors answer alike.
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  v_grant := (st ->> 'grant_id')::uuid;
  v_org := (st ->> 'org_id')::uuid;
  v_user := (st ->> 'user_id')::uuid;
  v_exempt := public.credits_exempt(v_org);

  v_reset := greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
  v_used := public.oauth_rate_take(v_grant);

  ctx := jsonb_build_object('ok', true, 'key_id', null, 'grant_id', v_grant, 'oauth', true, 'org_id', v_org,
    'created_by', v_user, 'exempt', v_exempt, 'rpm', v_rpm, 'scopes', st -> 'scopes',
    'limit_credits', st -> 'limit_credits',
    'remaining', greatest(0, v_rpm - v_used), 'reset', v_reset,
    'endpoint', coalesce(p_endpoint, 'unknown'), 'request_id', p_request_id);

  if v_used > v_rpm then
    return public.api_finish(ctx, public.api_err(429, 'rate_limit_exceeded',
      format('This connection is limited to %s requests per minute.', v_rpm),
      jsonb_build_object('retry_after', v_reset)));
  end if;

  begin
    v_scope := public.oauth_endpoint_scope(p_endpoint);
    if v_scope is null then
      return public.api_finish(ctx, public.api_err(403, 'not_available_for_connected_apps',
        'This action is not available to connected apps. It needs an API key.'));
    end if;

    -- MCP over OAuth is a subscription feature, checked live on every call.
    if not public.has_entitlement_internal(v_org, 'mcp') then
      return public.api_finish(ctx, public.api_err(403, 'subscription_required',
        'Connected apps need a paid plan. This connection is paused until the workspace has one.'));
    end if;

    perform public.api_act_as(v_user);
    if not public.is_org_member(v_org, 'admin') then
      return public.api_finish(ctx, public.api_err(403, 'workspace_access_lost',
        'The person who connected this app no longer has access to its workspace. Reconnect the app.'));
    end if;

    if v_scope <> 'any' and not (v_scope = any (array(select jsonb_array_elements_text(st -> 'scopes')))) then
      return public.api_finish(ctx, public.api_err(403, 'insufficient_scope',
        format('This connection was not given the %s permission.', v_scope),
        jsonb_build_object('required_scope', v_scope)));
    end if;

    update public.oauth_grants set last_used_at = now()
     where id = v_grant and (last_used_at is null or last_used_at < now() - interval '1 minute');
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
  return ctx;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. api_begin: 0062's body, with ONE change (the unknown-hash branch)
-- ───────────────────────────────────────────────────────────────────────────

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
  -- 0093: a hash that is no API key may be a connected app's access token: it
  -- gets its own checks (oauth_ctx) and an allow-list of endpoints.
  if k.id is null then
    return public.oauth_ctx(p_key_hash, p_endpoint, p_request_id);
  end if;
  if k.revoked_at is not null then
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

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Registration (RFC 7591, public clients only). Unauthenticated: hostile.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.oauth_register_client(p_name text, p_redirect_uris text[], p_ip text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim     jsonb := public.oauth_limits();
  v_name  text := btrim(coalesce(p_name, ''));
  v_uris  text[];
  u       text;
  v_ip    text;
  v_id    uuid;
begin
  if char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'error', 'invalid_client_metadata', 'description', 'client_name: 1 to 80 printable characters.');
  end if;
  if p_redirect_uris is null or cardinality(p_redirect_uris) not between 1 and 5 then
    return jsonb_build_object('ok', false, 'error', 'invalid_redirect_uri', 'description', 'Register 1 to 5 redirect URIs.');
  end if;
  foreach u in array p_redirect_uris loop
    if not public.oauth_redirect_uri_ok(u) then
      return jsonb_build_object('ok', false, 'error', 'invalid_redirect_uri',
        'description', 'Redirect URIs must be https, or http on localhost / 127.0.0.1 / [::1], with no fragment, userinfo or wildcard.');
    end if;
  end loop;
  v_uris := array(select distinct x from unnest(p_redirect_uris) x order by 1);

  v_ip := encode(sha256(convert_to(left(coalesce(p_ip, ''), 80) || ':' || (select pepper from public.oauth_settings), 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('oauth_register', 0));
  -- The two hourly counts are index probes; a refused call stops here. The
  -- collector (scans of the token and grant tables) runs only for a call that
  -- is about to be accepted, so a flood of refused calls cannot make the
  -- database scan those tables once per call (Lens-386A).
  if (select count(*) from public.oauth_clients where ip_hash = v_ip and created_at > now() - interval '1 hour')
       >= (lim ->> 'register_per_ip_hour')::int
     or (select count(*) from public.oauth_clients where created_at > now() - interval '1 hour')
       >= (lim ->> 'register_global_hour')::int then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'description', 'Too many registrations; try again later.');
  end if;
  perform public.oauth_gc();
  if (select count(*) from public.oauth_clients) >= (lim ->> 'max_clients')::int then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'description', 'Registration is closed for now; try again later.');
  end if;

  insert into public.oauth_clients (client_name, redirect_uris, ip_hash)
  values (v_name, v_uris, v_ip) returning client_id into v_id;
  return jsonb_build_object('ok', true, 'client_id', v_id, 'client_name', v_name, 'redirect_uris', to_jsonb(v_uris));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Authorization: begin (consent screen data) and decide (Allow / Deny)
-- ───────────────────────────────────────────────────────────────────────────

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
    v_scopes := public.oauth_scopes_supported();
  end if;

  v_org := public.oauth_workspace(v_user);
  if v_org is null then
    return jsonb_build_object('ok', false, 'redirect_ok', true, 'error', 'no_workspace');
  end if;
  select o.name into v_name from public.organizations o where o.id = v_org;
  v_plan := public.org_plan_internal(v_org);

  if not public.has_entitlement_internal(v_org, 'mcp') then
    -- Free: no screen to approve and no code, ever.
    return jsonb_build_object('ok', true, 'entitled', false, 'client_name', c.client_name,
                              'workspace_name', v_name, 'plan', v_plan);
  end if;

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

create or replace function public.oauth_decide_authorization(p_secret_hash text, p_allow boolean, p_limit numeric, p_code_hash text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user  uuid := auth.uid();
  r       public.oauth_auth_requests;
  lim     jsonb := public.oauth_limits();
  g       uuid;
  v_limit numeric := p_limit;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  -- Single use: the row is taken (and deleted) by the person it was made for.
  delete from public.oauth_auth_requests
   where secret_hash = p_secret_hash and user_id = v_user
  returning * into r;
  if r.id is null or r.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if not coalesce(p_allow, false) then
    return jsonb_build_object('ok', true, 'allowed', false, 'redirect_uri', r.redirect_uri, 'state', r.state,
                              'client_id', r.client_id);
  end if;

  if v_limit is null or v_limit < 0 or v_limit > (lim ->> 'max_limit_credits')::numeric or v_limit <> trunc(v_limit) then
    return jsonb_build_object('ok', false, 'error', 'invalid_limit', 'max_limit_credits', (lim ->> 'max_limit_credits')::numeric);
  end if;
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end if;
  if not public.has_entitlement_internal(r.org_id, 'mcp') then
    return jsonb_build_object('ok', false, 'error', 'subscription_required');
  end if;
  perform public.api_act_as(v_user);
  if not public.is_org_member(r.org_id, 'admin') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if (select count(*) from public.oauth_grants where user_id = v_user and revoked_at is null
         and absolute_expires_at > now()) >= (lim ->> 'max_grants_per_user')::int then
    return jsonb_build_object('ok', false, 'error', 'too_many_connections');
  end if;

  insert into public.oauth_grants (user_id, org_id, client_id, scopes, resource, monthly_limit_credits)
  values (v_user, r.org_id, r.client_id, r.scopes, r.resource, v_limit)
  returning id into g;
  insert into public.oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource)
  values (p_code_hash, g, r.client_id, r.redirect_uri, r.code_challenge, r.resource);
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (v_user, nullif(auth.jwt() ->> 'email', ''), 'mcp.connect', g::text,
          jsonb_build_object('org_id', r.org_id, 'client_id', r.client_id, 'scopes', to_jsonb(r.scopes), 'limit_credits', v_limit));
  return jsonb_build_object('ok', true, 'allowed', true, 'redirect_uri', r.redirect_uri, 'state', r.state,
                            'client_id', r.client_id);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Token endpoint: authorization_code and refresh_token (RFC 6749 / 7636)
-- ───────────────────────────────────────────────────────────────────────────
-- The caller (the server route) mints the tokens and passes only their SHA-256.

-- PKCE is checked HERE, from the verifier itself: this function is callable with
-- the public anon key, so a digest handed in by a caller (the route used to pass
-- the challenge) would let anyone who saw a code and the authorization URL's
-- challenge redeem the code without the verifier (Lens-386A). The first line
-- drops the earlier signature of this file's draft (the parameter was named
-- p_challenge), which `create or replace` cannot rename.
drop function if exists public.oauth_exchange_code(text, uuid, text, text, text, text, text);
create or replace function public.oauth_exchange_code(
  p_code_hash text, p_client_id uuid, p_redirect_uri text, p_verifier text, p_resource text,
  p_access_hash text, p_refresh_hash text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim  jsonb := public.oauth_limits();
  cd   public.oauth_codes;
  g    public.oauth_grants;
  bad  jsonb := jsonb_build_object('ok', false, 'error', 'invalid_grant');
  -- RFC 7636 4.2: base64url (no padding) of SHA-256(verifier). A SHA-256 is 44
  -- base64 characters, so no line break is ever inserted.
  v_challenge text;
begin
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_access_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_refresh_hash, '') !~ '^[0-9a-f]{64}$' or p_access_hash = p_refresh_hash
     or coalesce(p_verifier, '') !~ '^[A-Za-z0-9._~-]{43,128}$' then
    return bad;
  end if;
  v_challenge := translate(rtrim(encode(sha256(convert_to(p_verifier, 'UTF8')), 'base64'), '='), '+/', '-_');
  select * into cd from public.oauth_codes where code_hash = p_code_hash for update;
  if cd.code_hash is null then
    return bad;
  end if;
  select * into g from public.oauth_grants where id = cd.grant_id for update;
  -- A code redeemed twice means it leaked: whatever it already produced dies.
  if cd.used_at is not null then
    perform public.oauth_revoke_grant_locked(cd.grant_id, 'code_reuse');
    return bad;
  end if;
  if cd.expires_at < now() or g.id is null or g.revoked_at is not null then
    return bad;
  end if;
  -- Bound to client + redirect_uri + resource + the PKCE challenge. Digests are
  -- compared, so the comparison time says nothing about the secret. A wrong
  -- verifier or redirect burns the code (the one holding it is not the client).
  if cd.client_id is distinct from p_client_id
     or cd.redirect_uri is distinct from p_redirect_uri
     or sha256(convert_to(v_challenge, 'UTF8')) <> sha256(convert_to(cd.code_challenge, 'UTF8')) then
    update public.oauth_codes set used_at = now() where code_hash = p_code_hash;
    perform public.oauth_revoke_grant_locked(cd.grant_id, 'client');
    return bad;
  end if;
  if p_resource is not null and p_resource is distinct from cd.resource then
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;
  if not public.has_entitlement_internal(g.org_id, 'mcp') then
    return jsonb_build_object('ok', false, 'error', 'subscription_required');
  end if;

  update public.oauth_codes set used_at = now() where code_hash = p_code_hash;
  update public.oauth_grants set activated_at = now() where id = g.id;
  update public.oauth_clients set last_authorized_at = now() where client_id = g.client_id;
  insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values
    (p_access_hash, g.id, 'access', now() + make_interval(secs => (lim ->> 'access_ttl_seconds')::int)),
    (p_refresh_hash, g.id, 'refresh',
     least(now() + make_interval(days => (lim ->> 'refresh_ttl_days')::int), g.absolute_expires_at));
  return jsonb_build_object('ok', true, 'scope', array_to_string(g.scopes, ' '),
                            'expires_in', (lim ->> 'access_ttl_seconds')::int, 'resource', g.resource);
end
$$;

create or replace function public.oauth_refresh(
  p_refresh_hash text, p_client_id uuid, p_resource text, p_new_access_hash text, p_new_refresh_hash text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim  jsonb := public.oauth_limits();
  t    public.oauth_tokens;
  g    public.oauth_grants;
  bad  jsonb := jsonb_build_object('ok', false, 'error', 'invalid_grant');
begin
  if coalesce(p_refresh_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_new_access_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_new_refresh_hash, '') !~ '^[0-9a-f]{64}$' or p_new_access_hash = p_new_refresh_hash then
    return bad;
  end if;
  select * into t from public.oauth_tokens where token_hash = p_refresh_hash and kind = 'refresh' for update;
  if t.token_hash is null then
    return bad;
  end if;
  select * into g from public.oauth_grants where id = t.grant_id for update;
  if g.id is null or g.client_id is distinct from p_client_id then
    return bad;
  end if;
  -- Rotation with reuse detection: a refresh token is good once. Seeing a spent
  -- one means two parties hold it, so the whole grant (every token) is revoked.
  if t.used_at is not null then
    perform public.oauth_revoke_grant_locked(g.id, 'reuse');
    return bad;
  end if;
  if t.revoked_at is not null or g.revoked_at is not null or t.expires_at < now() or g.absolute_expires_at < now()
     or g.activated_at is null then
    return bad;
  end if;
  if p_resource is not null and p_resource is distinct from g.resource then
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;
  -- A lapsed plan cannot refresh. The token is not spent: renewing the plan and
  -- trying again works without reconnecting.
  if not public.has_entitlement_internal(g.org_id, 'mcp') then
    return jsonb_build_object('ok', false, 'error', 'subscription_required');
  end if;

  update public.oauth_tokens set used_at = now() where token_hash = p_refresh_hash;
  update public.oauth_tokens set revoked_at = now() where grant_id = g.id and kind = 'access' and revoked_at is null;
  insert into public.oauth_tokens (token_hash, grant_id, kind, expires_at) values
    (p_new_access_hash, g.id, 'access', now() + make_interval(secs => (lim ->> 'access_ttl_seconds')::int)),
    (p_new_refresh_hash, g.id, 'refresh',
     least(now() + make_interval(days => (lim ->> 'refresh_ttl_days')::int), g.absolute_expires_at));
  if random() < 0.05 then
    perform public.oauth_gc();
  end if;
  return jsonb_build_object('ok', true, 'scope', array_to_string(g.scopes, ' '),
                            'expires_in', (lim ->> 'access_ttl_seconds')::int, 'resource', g.resource);
end
$$;

-- RFC 7009. Revoking either token of a grant revokes the grant: a connection
-- is one thing. Always succeeds from the caller's side (no oracle).
create or replace function public.oauth_revoke_token(p_token_hash text, p_client_id uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t public.oauth_tokens;
  g public.oauth_grants;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select * into t from public.oauth_tokens where token_hash = p_token_hash;
  if t.token_hash is null then
    return;
  end if;
  select * into g from public.oauth_grants where id = t.grant_id for update;
  if g.id is not null and g.client_id is not distinct from p_client_id then
    perform public.oauth_revoke_grant_locked(g.id, 'client');
  end if;
end
$$;

-- The MCP endpoint's check of a bearer token: is it a live access token, for
-- which resource and scopes, and is the plan entitled right now. Counted like a
-- request. A paused plan is NOT an invalid token (the person can fix it).
create or replace function public.oauth_check(p_token_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st jsonb := public.oauth_token_state(p_token_hash);
begin
  if st is null then
    return public.api_err(401, 'invalid_token', 'The access token is missing, expired, revoked or unknown. Reconnect the app.');
  end if;
  if public.oauth_rate_take((st ->> 'grant_id')::uuid) > (public.oauth_limits() ->> 'rpm')::integer then
    return public.api_err(429, 'rate_limit_exceeded', 'This connection is sending too many requests.',
                          jsonb_build_object('retry_after', 30));
  end if;
  return public.api_ok(jsonb_build_object('resource', st -> 'resource', 'scopes', st -> 'scopes',
    'entitled', public.has_entitlement_internal((st ->> 'org_id')::uuid, 'mcp')));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. What a connected app does that is not a plain read: make a video (site
--    credits), read a job with its credit charge, read the credit balance.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.oauth_create_video(
  p_token_hash text, p_channel_id text, p_params jsonb,
  p_idem_key text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_token_hash, 'oauth.videos.create', p_request_id);
  v_org   uuid;
  v_grant uuid;
  ch      public.channels;
  v_p     jsonb := coalesce(p_params, '{}'::jsonb);
  v_secs  numeric;
  v_idem  text;
  v_fp    text;
  prior   public.oauth_runs;
  jm      numeric;
  vm      public.credit_prices;
  v_price numeric;
  v_limit numeric;
  v_spent numeric;
  acc     public.credit_accounts;
  v_ref   text;
  v_job   bigint;
  v_res   jsonb;
  v_hold  jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    v_grant := (ctx ->> 'grant_id')::uuid;
    if p_idem_key is not null and p_idem_key !~ '^[A-Za-z0-9_:.-]{1,255}$' then
      return public.api_finish(ctx, public.api_err(400, 'invalid_idempotency_key',
        'idempotency_key: 1-255 characters of A-Z a-z 0-9 _ : . -'));
    end if;
    v_idem := coalesce(p_idem_key, 'auto-' || gen_random_uuid()::text);
    v_fp := md5(jsonb_build_object('c', p_channel_id, 'p', v_p)::text);

    -- A retry of the same request waits here, then finds the first one's job.
    perform pg_advisory_xact_lock(hashtextextended('oauth_run:' || v_grant::text || ':' || v_idem, 0));
    select * into prior from public.oauth_runs where grant_id = v_grant and idem_key = v_idem;
    if prior.id is not null then
      if prior.fingerprint <> v_fp then
        return public.api_finish(ctx, public.api_err(422, 'idempotency_key_reused',
          'This idempotency_key was already used with a different request.'));
      end if;
      return public.api_finish(ctx, public.api_ok(jsonb_build_object('job_id', prior.render_job_id,
        'channel_id', prior.channel_id, 'status', 'queued', 'price_credits', prior.quoted_credits), 200)
        || jsonb_build_object('replayed', true));
    end if;

    select * into ch from public.channels c where c.channel_id = p_channel_id;
    if ch.channel_id is null or ch.org_id is distinct from v_org then
      return public.api_finish(ctx, public.api_err(404, 'channel_not_found', 'No channel with that id in this workspace.'));
    elsif upper(btrim(coalesce(ch.status, ''))) <> 'ACTIVE' then
      return public.api_finish(ctx, public.api_err(409, 'channel_not_active',
        'That channel is not active. Connect it to YouTube and activate it in the Command Center first.'));
    elsif jsonb_typeof(v_p) <> 'object'
       or (v_p - array['topic','niche','duration','language','visual_style','video_provider','image_provider']) <> '{}'::jsonb
       or not public.render_job_params_valid(v_p, 'daily') then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params',
        'Allowed: topic (<=300 chars), niche (<=120), duration (whole seconds, 30-3600), language (<=40), visual_style (<=300), video_provider, image_provider.'));
    end if;

    -- A limit of 0 is a read-only connection, whoever pays: the operator's exempt
    -- workspace spends nothing, so nothing below would ever count against the
    -- limit; zero is the one limit that needs no counting (Lens-386A).
    if (ctx ->> 'exempt')::boolean and (ctx ->> 'limit_credits')::numeric <= 0 then
      return public.api_finish(ctx, public.api_err(402, 'connection_limit_reached',
        'This connection is read-only: its monthly spending limit is 0.',
        jsonb_build_object('limit_credits', 0, 'spent_credits', 0, 'price_credits', 0)));
    end if;

    if not (ctx ->> 'exempt')::boolean then
      -- The length the video renders at, frozen the way the payment guard
      -- (0041) freezes it, so what is held is what runs.
      v_secs := coalesce((v_p ->> 'duration')::numeric,
                         case when jsonb_typeof(ch.agent_config -> 'target_duration_seconds') = 'number'
                              then (ch.agent_config ->> 'target_duration_seconds')::numeric end);
      if v_secs is null or v_secs <= 0 then
        return public.api_finish(ctx, public.api_err(400, 'duration_required',
          'Pass duration (seconds): this channel has no target length to price the video by.'));
      end if;
      v_secs := least(greatest(round(v_secs), 30), 3600);
      v_p := v_p || jsonb_build_object('duration', v_secs::integer);

      -- The price: the same rows and formula the render_jobs payment guard
      -- demands the hold cover. No per-minute price = unpriced = refused.
      select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
      select * into vm from public.credit_prices where unit = 'video_minute';
      if vm.unit is null or vm.credits_per_unit is null then
        return public.api_finish(ctx, public.api_err(503, 'pricing_unavailable',
          'Video pricing is not set up on this deployment; nothing was held or charged.'));
      end if;
      v_price := public.credits_round_up(greatest(coalesce(jm, 0), vm.credits_per_unit * (1 + vm.margin) * v_secs / 60));
      if v_price is null or v_price <= 0 then
        return public.api_finish(ctx, public.api_err(503, 'pricing_unavailable',
          'Video pricing is not set up on this deployment; nothing was held or charged.'));
      end if;

      -- Everything below runs under the credit account's row lock, so two calls
      -- of one connection cannot each pass the limit and jointly exceed it.
      acc := public.credit_account_lock(v_org);
      v_limit := (ctx ->> 'limit_credits')::numeric;
      v_spent := public.oauth_grant_month_credits(v_grant);
      if v_spent + v_price > v_limit then
        return public.api_finish(ctx, public.api_err(402, 'connection_limit_reached',
          'This video would take this connection past its monthly spending limit.',
          jsonb_build_object('limit_credits', v_limit, 'spent_credits', v_spent, 'price_credits', v_price)));
      end if;

      v_ref := 'rj-oa-' || replace(gen_random_uuid()::text, '-', '');
      begin
        v_hold := public.reserve_credits(v_org, v_ref, v_price);
      exception
        when sqlstate 'NS402' then
          select * into acc from public.credit_accounts where org_id = v_org;
          return public.api_finish(ctx, public.api_err(402, 'insufficient_credits',
            'The workspace does not have enough credits for this video.',
            jsonb_build_object('available_credits', greatest(acc.balance - acc.reserved, 0),
                               'held_credits', acc.reserved, 'price_credits', v_price)));
        when sqlstate 'NS429' then
          return public.api_finish(ctx, public.api_err(429, 'run_limit_reached',
            'The plan\''s limit of videos in progress at once is reached.',
            jsonb_build_object('retry_after', 60,
                               'active_runs', (select count(*) from public.credit_reservations r where r.org_id = v_org and r.status = 'open'),
                               'run_limit', public.entitlement_int_internal(v_org, 'concurrency'))));
      end;
    end if;

    insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref)
    values (ch.channel_id, 'daily', v_p, (ctx ->> 'created_by')::uuid, v_ref)
    returning id into v_job;

    insert into public.oauth_runs (grant_id, org_id, idem_key, fingerprint, credit_ref, render_job_id, channel_id, quoted_credits)
    values (v_grant, v_org, v_idem, v_fp, v_ref, v_job, ch.channel_id, v_price);

    insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail, channel_id)
    values ((ctx ->> 'created_by')::uuid, nullif(auth.jwt() ->> 'email', ''), 'agent.run', ch.channel_id,
            v_p || jsonb_build_object('via', 'mcp_oauth', 'grant_id', v_grant, 'job_id', v_job,
                                      'credit_ref', v_ref, 'price_credits', v_price), ch.channel_id);

    v_res := public.api_ok(jsonb_build_object('job_id', v_job, 'channel_id', ch.channel_id, 'status', 'queued',
                                              'price_credits', v_price), 201);
    return public.api_finish(ctx, v_res, 0);
  exception when others then
    -- Only this block is undone (the hold with it): nothing is held or queued.
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.oauth_get_job(p_token_hash text, p_job_id bigint, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_token_hash, 'oauth.jobs.get', p_request_id);
  j   public.render_jobs;
  cr  public.credit_reservations;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select jj.* into j from public.render_jobs jj join public.channels c on c.channel_id = jj.channel_id
     where jj.id = p_job_id and c.org_id = (ctx ->> 'org_id')::uuid;
    if j.id is null then
      return public.api_finish(ctx, public.api_err(404, 'job_not_found', 'No job with that id in this workspace.'));
    end if;
    select * into cr from public.credit_reservations where job_id = j.credit_ref;
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'id', j.id, 'channel_id', j.channel_id, 'status', j.status, 'params', j.params,
      'created_at', j.created_at, 'started_at', j.started_at, 'finished_at', j.finished_at, 'error', j.error,
      'charge', case when cr.job_id is null then null
                     else jsonb_build_object('status', cr.status, 'held_credits', cr.amount, 'charged_credits', cr.captured) end)));
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.oauth_get_balance(p_token_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx   jsonb := public.api_begin(p_token_hash, 'oauth.balance', p_request_id);
  v_org uuid;
  acc   public.credit_accounts;
  v_spent numeric;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    if (ctx ->> 'exempt')::boolean then
      return public.api_finish(ctx, public.api_ok(jsonb_build_object('exempt', true)));
    end if;
    select * into acc from public.credit_accounts where org_id = v_org;
    v_spent := public.oauth_grant_month_credits((ctx ->> 'grant_id')::uuid);
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'credits', jsonb_build_object('available', greatest(coalesce(acc.balance, 0) - coalesce(acc.reserved, 0), 0),
                                    'held', coalesce(acc.reserved, 0)),
      'plan', public.org_plan_internal(v_org),
      'videos_in_progress', (select count(*) from public.credit_reservations r where r.org_id = v_org and r.status = 'open'),
      'videos_at_once_limit', public.entitlement_int_internal(v_org, 'concurrency'),
      'this_connection', jsonb_build_object('monthly_limit_credits', (ctx ->> 'limit_credits')::numeric,
                                            'spent_this_month_credits', v_spent,
                                            'left_this_month_credits', greatest((ctx ->> 'limit_credits')::numeric - v_spent, 0)))));
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. The person's own connections (Developers -> Connected apps)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.oauth_my_grants() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', g.id, 'client_name', c.client_name, 'redirect_uris', to_jsonb(c.redirect_uris),
             'scopes', to_jsonb(g.scopes), 'created_at', g.created_at, 'last_used_at', g.last_used_at,
             'monthly_limit_credits', g.monthly_limit_credits,
             'spent_this_month_credits', public.oauth_grant_month_credits(g.id),
             'status', case when public.has_entitlement_internal(g.org_id, 'mcp') then 'active' else 'paused_plan' end)
           order by g.created_at desc)
      from public.oauth_grants g join public.oauth_clients c on c.client_id = g.client_id
     where g.user_id = v_user and g.activated_at is not null and g.revoked_at is null
       and g.absolute_expires_at > now()), '[]'::jsonb);
end
$$;

create or replace function public.oauth_revoke_grant(p_grant uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  g      public.oauth_grants;
  done   boolean;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into g from public.oauth_grants where id = p_grant and user_id = v_user for update;
  if g.id is null then
    return false;
  end if;
  done := public.oauth_revoke_grant_locked(g.id, 'user');
  if done then
    insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
    values (v_user, nullif(auth.jwt() ->> 'email', ''), 'mcp.disconnect', g.id::text, jsonb_build_object('org_id', g.org_id));
  end if;
  return done;
end
$$;

create or replace function public.oauth_revoke_all_grants() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  g      uuid;
  n      integer := 0;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  for g in select id from public.oauth_grants where user_id = v_user and revoked_at is null for update loop
    if public.oauth_revoke_grant_locked(g, 'user_all') then
      n := n + 1;
    end if;
  end loop;
  if n > 0 then
    insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
    values (v_user, nullif(auth.jwt() ->> 'email', ''), 'mcp.disconnect_all', v_user::text, jsonb_build_object('count', n));
  end if;
  return n;
end
$$;

-- Only the person raises or lowers a connection's limit; the assistant cannot.
create or replace function public.oauth_set_grant_limit(p_grant uuid, p_limit numeric) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  lim    jsonb := public.oauth_limits();
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 0 or p_limit > (lim ->> 'max_limit_credits')::numeric or p_limit <> trunc(p_limit) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  update public.oauth_grants set monthly_limit_credits = p_limit
   where id = p_grant and user_id = v_user and revoked_at is null;
  if not found then
    return false;
  end if;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (v_user, nullif(auth.jwt() ->> 'email', ''), 'mcp.limit', p_grant::text, jsonb_build_object('limit_credits', p_limit));
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 11. Grants: explicit, nothing by default
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.oauth_limits() from public, anon, authenticated, service_role;
revoke all on function public.oauth_scopes_supported() from public, anon, authenticated, service_role;
revoke all on function public.oauth_redirect_uri_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_month_start() from public, anon, authenticated, service_role;
revoke all on function public.oauth_grant_month_credits(uuid) from public, anon, authenticated, service_role;
revoke all on function public.oauth_workspace(uuid) from public, anon, authenticated, service_role;
revoke all on function public.oauth_revoke_grant_locked(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_gc() from public, anon, authenticated, service_role;
revoke all on function public.oauth_endpoint_scope(text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_token_state(text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_ctx(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_rate_take(uuid) from public, anon, authenticated, service_role;

revoke all on function public.oauth_register_client(text, text[], text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_exchange_code(text, uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_refresh(text, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_revoke_token(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.oauth_check(text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_create_video(text, text, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_get_job(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_get_balance(text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_register_client(text, text[], text) to anon;
grant execute on function public.oauth_exchange_code(text, uuid, text, text, text, text, text) to anon;
grant execute on function public.oauth_refresh(text, uuid, text, text, text) to anon;
grant execute on function public.oauth_revoke_token(text, uuid) to anon;
grant execute on function public.oauth_check(text, text) to anon;
grant execute on function public.oauth_create_video(text, text, jsonb, text, text) to anon;
grant execute on function public.oauth_get_job(text, bigint, text) to anon;
grant execute on function public.oauth_get_balance(text, text) to anon;

revoke all on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_decide_authorization(text, boolean, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_my_grants() from public, anon, authenticated, service_role;
revoke all on function public.oauth_revoke_grant(uuid) from public, anon, authenticated, service_role;
revoke all on function public.oauth_revoke_all_grants() from public, anon, authenticated, service_role;
revoke all on function public.oauth_set_grant_limit(uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.oauth_decide_authorization(text, boolean, numeric, text) to authenticated;
grant execute on function public.oauth_my_grants() to authenticated;
grant execute on function public.oauth_revoke_grant(uuid) to authenticated;
grant execute on function public.oauth_revoke_all_grants() to authenticated;
grant execute on function public.oauth_set_grant_limit(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Verify (run after applying; every column should read true)
-- ---------------------------------------------------------------------------------------------
-- select
--   not exists (select 1 from information_schema.role_table_grants
--                where table_schema = 'public' and table_name like 'oauth\_%' and grantee in ('anon', 'authenticated', 'service_role')) as no_table_access,
--   (select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'oauth\_%' and c.relkind = 'r') as rls_on,
--   not has_function_privilege('anon', 'public.oauth_ctx(text,text,text)', 'EXECUTE') as ctx_internal,
--   has_function_privilege('anon', 'public.oauth_exchange_code(text,uuid,text,text,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.oauth_exchange_code(text,uuid,text,text,text,text,text)', 'EXECUTE') as token_anon_only,
--   has_function_privilege('authenticated', 'public.oauth_decide_authorization(text,boolean,numeric,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.oauth_decide_authorization(text,boolean,numeric,text)', 'EXECUTE') as consent_signed_in_only,
--   (select status = 'enforced' from public.entitlement_keys where key = 'mcp') as mcp_enforced,
--   (select count(*) = 3 from public.plan_entitlements where key = 'mcp' and value = 'true') as paid_plans_have_mcp;
