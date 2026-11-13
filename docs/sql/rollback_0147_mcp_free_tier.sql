-- rollback_0147_mcp_free_tier.sql — takes migration 0147 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in
-- the app runs it.
--
-- WHEN: only if connecting an AI app must be a paid-plan feature again, or the one-unit rate count misbehaves. It is the whole
-- undo: there is no switch. After it, a Free (or pack-only) workspace's connections are PAUSED again (`subscription_required`
-- on every call, `paused_plan` in Developers -> Connected apps) until it has a plan, Free cannot approve a new one, every OAuth
-- tool call costs two rate units again, and the API key's spend-limit refusals lose their remedy sentence. Nothing is deleted
-- but the rate credits (a few minutes' worth, harmless to lose).
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) when a function of 0147 is not 0147's body (a later change would be undone).
--   1. Puts oauth_ctx, oauth_check, oauth_begin_authorization, oauth_decide_authorization, oauth_exchange_code, oauth_refresh,
--      oauth_my_grants, oauth_limits and oauth_register_client back to 0093's bodies, and api_create_video and api_request_download back to 0042's, byte for byte, with
--      the grants those migrations gave them.
--   2. Drops oauth_check_credit_put, oauth_check_credit_take and oauth_check_credits, and oauth_clients.vendor (with its index)
--      and oauth_vendor_callbacks_only: registrations are counted in one class again (10 an address, 300 an hour, 20 000 rows),
--      so a vendor's shared server is throttled at 10 people an hour again.
--   3. Puts the `mcp` entitlement back as 0093 left it: enforced, default false, Free false (the paid plans keep true).
--   4. Asserts the end state (0093's and 0042's md5s, nothing of 0147 left).
--
-- tests/security/test_sec_mcp_free_tier.py applies this file to a lab database and then re-applies 0147.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.oauth_ctx(text, text, text)', 'fe42c9e4f53a6c9aaba40077ce905cdc'],
      ['public.oauth_check(text, text)', '7b53e3c9b4b6c6c74daa9eff3fe028bc'],
      ['public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text)', '1d77b561efdb9347dc9465e66fa87e8c'],
      ['public.oauth_decide_authorization(text, boolean, numeric, text)', '33d52fcbee5e6b27ed7edcac8be93d15'],
      ['public.oauth_exchange_code(text, uuid, text, text, text, text, text)', '1d682787edc3c06691d537cd65039842'],
      ['public.oauth_refresh(text, uuid, text, text, text)', '3d8ff8c8084563f79ab7d09cfd87a2a6'],
      ['public.oauth_my_grants()', '595922d17683b2e0620612f60c5d10c3'],
      ['public.oauth_limits()', 'e49fb50fbe306e0d727836239baab57a'],
      ['public.oauth_register_client(text, text[], text)', '51d0b4f6ee421aa0fd276b09c108da2f'],
      ['public.oauth_vendor_callbacks_only(text[])', 'ea8f4b03c3eea3db46d3e3210b920def'],
      ['public.api_create_video(text, text, jsonb, text, text, text)', 'cba47be1a674f5cea3b5d7443bc31bab'],
      ['public.api_request_download(text, text, text, text, text, text)', '055003f8a2fb5390bbd1b5f7820e6e2e'],
      ['public.oauth_check_credit_put(uuid, text)', 'b50cfb0cfaa7d8a57512f3381d6b72e3'],
      ['public.oauth_check_credit_take(uuid, text)', '7092b99bdaef02719f247dcd26d77c08']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception 'rollback 0147: % is not 0147''s body (md5 %): read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

-- 1. 0093's and 0042's bodies, as those migrations wrote them.

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

create or replace function public.oauth_limits() returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'default_limit_credits', 500, 'max_limit_credits', 20000,
    'rpm', 120, 'access_ttl_seconds', 3600, 'refresh_ttl_days', 30, 'absolute_days', 90, 'code_ttl_seconds', 60,
    'max_grants_per_user', 20, 'max_pending_requests', 5,
    'register_per_ip_hour', 10, 'register_global_hour', 300, 'max_clients', 20000)
$$;

create or replace function public.oauth_register_client(p_name text, p_redirect_uris text[], p_ip text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim     jsonb := public.oauth_limits();
  v_name  text := public.oauth_visible_name(p_name);
  v_uris  text[];
  u       text;
  v_ip    text;
  v_id    uuid;
begin
  -- A name that shows nothing, is over 80 characters or passes itself off as
  -- Nightshift is refused (RFC 7591 invalid_client_metadata).
  if public.oauth_client_name_problem(p_name) is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_client_metadata',
      'description', 'client_name: 1 to 80 visible characters, and not a name that contains "Nightshift".');
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

create or replace function public.api_create_video(
  p_key_hash text, p_channel_id text, p_params jsonb,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'videos.create', p_request_id);
  v_org   uuid;
  ch      public.channels;
  v_p     jsonb := coalesce(p_params, '{}'::jsonb);
  v_busy  integer;
  v_secs  numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_job   bigint;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;

    select * into ch from public.channels c where c.channel_id = p_channel_id;
    if ch.channel_id is null or ch.org_id is distinct from v_org then
      v_res := public.api_err(404, 'channel_not_found', 'No channel with that id in this key''s organization.');
    elsif upper(btrim(coalesce(ch.status, ''))) <> 'ACTIVE' then
      v_res := public.api_err(409, 'channel_not_active',
        'That channel is not active. Connect it to YouTube and activate it in the Command Center first.');
    elsif jsonb_typeof(v_p) <> 'object'
       or (v_p - array['topic','niche','duration','language','visual_style',
                       'video_provider','image_provider']) <> '{}'::jsonb
       or not public.render_job_params_valid(v_p, 'daily') then
      v_res := public.api_err(400, 'invalid_params',
        'Allowed: topic (<=300 chars), niche (<=120), duration (whole seconds, 30-3600), language (<=40), visual_style (<=300), video_provider, image_provider.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    -- Concurrency, under a per-organization lock so two creates cannot both
    -- take the last slot.
    perform pg_advisory_xact_lock(hashtextextended('api_render_jobs:' || v_org::text, 0));
    select count(*) into v_busy
      from public.render_jobs j join public.channels c on c.channel_id = j.channel_id
     where c.org_id = v_org and j.status in ('queued', 'running');
    if v_busy >= (ctx ->> 'concurrency')::int then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(429, 'concurrency_limit_exceeded',
        format('Usage tier %s runs at most %s videos at once. Wait for one to finish.', ctx ->> 'tier', ctx ->> 'concurrency'),
        jsonb_build_object('retry_after', 60))));
    end if;

    if not (ctx ->> 'exempt')::boolean then
      v_secs := coalesce((v_p ->> 'duration')::numeric,
                         case when jsonb_typeof(ch.agent_config -> 'target_duration_seconds') = 'number'
                              then (ch.agent_config ->> 'target_duration_seconds')::numeric end);
      if v_secs is null or v_secs <= 0 then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(400, 'duration_required',
          'Pass duration (seconds): this channel has no target length to price the video by.')));
      end if;
      -- 0041 freezes the length a paid run renders at, whole seconds 30..3600
      -- (render_jobs_payment_guard). Freeze it here, in the same way, BEFORE
      -- pricing, so the hold is for the length that runs: a 10-second target
      -- renders 30 seconds and is priced as 30, and a target read again
      -- inside the insert cannot differ from the one priced.
      v_secs := least(greatest(round(v_secs), 30), 3600);
      v_p := v_p || jsonb_build_object('duration', v_secs::integer);
      v_price := public.api_video_price(v_secs);
      if v_price is null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
          'The API price list is not set up on this deployment; nothing was charged.')));
      end if;

      acc := public.api_account_lock(v_org);
      perform public.api_expire_holds_locked(v_org);
      select * into acc from public.api_accounts where org_id = v_org;
      v_spend := public.api_month_spend(v_org);
      if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'monthly_limit_reached',
          'This video would take the organization past its monthly API spend limit.',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend,
                             'price_cents', v_price))));
      end if;
      if ctx ->> 'key_limit_cents' is not null
         and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'key_limit_reached',
          'This video would take this key past its own monthly spend limit.',
          jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price))));
      end if;
      if acc.balance_cents - acc.reserved_cents < v_price then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'insufficient_balance',
          'Your API balance does not cover this video. Top up in the Developer console.',
          jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents))));
      end if;

      v_ref := 'ah-' || gen_random_uuid()::text;
      insert into public.api_holds (ref, org_id, key_id, amount_cents)
      values (v_ref, v_org, (ctx ->> 'key_id')::uuid, v_price);
      update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
       where org_id = v_org;
      perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                             format('%s seconds on %s', v_secs, ch.channel_id));
    end if;

    -- 0019's insert policy, stated as the row itself: a daily job, queued, no
    -- privacy/resume/repair, filed as the key's creator.
    insert into public.render_jobs (channel_id, kind, params, requested_by, api_hold_ref)
    values (ch.channel_id, 'daily', v_p, (ctx ->> 'created_by')::uuid, v_ref)
    returning id into v_job;
    if v_ref is not null then
      update public.api_holds set render_job_id = v_job where ref = v_ref;
    end if;

    perform public.api_audit(ctx, 'agent.run', ch.channel_id, ch.channel_id,
      v_p || jsonb_build_object('backend', 'queue', 'job_id', v_job, 'api_hold_ref', v_ref, 'price_cents', v_price));

    v_res := public.api_ok(jsonb_build_object('job_id', v_job, 'channel_id', ch.channel_id, 'status', 'queued',
                                              'price_cents', v_price), 201);
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_request_download(
  p_key_hash text, p_video_id text, p_quality text,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'downloads.create', p_request_id);
  v_org   uuid;
  v_ch    text;
  q       text := btrim(coalesce(p_quality, ''));
  m       public.download_masters;
  r       public.download_requests;
  why     text;
  until_  timestamptz;
  credits numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;
    select c.channel_id into v_ch from public.videos v join public.channels c on c.channel_id = v.channel_id
     where v.video_id = p_video_id and c.org_id = v_org;
    if q not in ('720p', '1080p') then
      v_res := public.api_err(400, 'invalid_params', 'quality must be 720p or 1080p.');
    elsif v_ch is null then
      v_res := public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    -- 0030's lock: the site and the API decide one (org, video, quality) at a time.
    perform pg_advisory_xact_lock(hashtextextended(format('download:%s:%s:%s', v_org, p_video_id, q), 0));
    select * into r from public.download_requests d
     where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
       and (d.status in ('queued', 'processing') or (d.status = 'ready' and d.expires_at > now()))
     order by d.id desc limit 1;
    if r.id is not null then
      v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', r.quality,
                                                'price_cents', 0, 'reused', true, 'expires_at', r.expires_at));
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    select * into m from public.download_masters where video_id = p_video_id;
    if m.video_id is null or least(m.width, m.height) < public.download_quality_side(q) then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(404, 'no_master',
        format('No full-quality master for this video at %s. Only videos rendered on the queue worker keep one.', q))));
    end if;

    if exists (select 1 from public.download_requests d
                where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
                  and d.paid_until > now() and d.status <> 'failed') then
      why := 'redownload';
      until_ := (select max(d.paid_until) from public.download_requests d
                  where d.org_id = v_org and d.video_id = p_video_id and d.quality = q and d.status <> 'failed');
    elsif (ctx ->> 'exempt')::boolean then
      why := 'exempt';
      until_ := now() + interval '7 days';
    else
      credits := public.download_credits_price(m.duration_seconds, q);
      select ceil(credits * p.cents)::bigint into v_price from public.api_prices p where p.unit = 'download_cents_per_credit';
      if v_price is null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
          format('Downloads in %s are not priced on this deployment; nothing was charged.', q))));
      end if;
      until_ := now() + interval '7 days';
    end if;

    if v_price is not null and v_price > 0 then
      acc := public.api_account_lock(v_org);
      perform public.api_expire_holds_locked(v_org);
      select * into acc from public.api_accounts where org_id = v_org;
      v_spend := public.api_month_spend(v_org);
      if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
        v_res := public.api_err(402, 'monthly_limit_reached',
          'This download would take the organization past its monthly API spend limit.',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend, 'price_cents', v_price));
      elsif ctx ->> 'key_limit_cents' is not null
            and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        v_res := public.api_err(402, 'key_limit_reached', 'This download would take this key past its own monthly spend limit.',
          jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price));
      elsif acc.balance_cents - acc.reserved_cents < v_price then
        v_res := public.api_err(402, 'insufficient_balance',
          'Your API balance does not cover this download. Top up in the Developer console.',
          jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents));
      end if;
      if v_res is not null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
      end if;
    end if;

    -- 0030's row, as the site writes it, filed as the key's creator; credits
    -- charged 0 (the API balance pays, below).
    insert into public.download_requests
      (org_id, channel_id, video_id, quality, status, charged, free_reason, paid_until, minutes, requested_by)
    values
      (v_org, v_ch, p_video_id, q, 'queued', 0, why, until_, round(m.duration_seconds / 60.0, 4),
       (ctx ->> 'created_by')::uuid)
    returning * into r;

    if v_price is not null and v_price > 0 then
      v_ref := 'ah-' || gen_random_uuid()::text;
      insert into public.api_holds (ref, org_id, key_id, download_request_id, amount_cents)
      values (v_ref, v_org, (ctx ->> 'key_id')::uuid, r.id, v_price);
      update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
       where org_id = v_org;
      perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                             format('download %s of %s', q, p_video_id));
    end if;
    perform public.api_audit(ctx, 'video.download', p_video_id, v_ch,
      jsonb_build_object('download_id', r.id, 'quality', q, 'price_cents', v_price, 'free_reason', why));

    v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', q,
                                              'price_cents', coalesce(v_price, 0), 'free_reason', why,
                                              'reused', false), 201);
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

revoke all on function public.oauth_ctx(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_limits() from public, anon, authenticated, service_role;
revoke all on function public.oauth_register_client(text, text[], text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_register_client(text, text[], text) to anon;
revoke all on function public.oauth_check(text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_exchange_code(text, uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_refresh(text, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_create_video(text, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_request_download(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_check(text, text) to anon;
grant execute on function public.oauth_exchange_code(text, uuid, text, text, text, text, text) to anon;
grant execute on function public.oauth_refresh(text, uuid, text, text, text) to anon;
grant execute on function public.api_create_video(text, text, jsonb, text, text, text) to anon;
grant execute on function public.api_request_download(text, text, text, text, text, text) to anon;
revoke all on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_decide_authorization(text, boolean, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_my_grants() from public, anon, authenticated, service_role;
grant execute on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.oauth_decide_authorization(text, boolean, numeric, text) to authenticated;
grant execute on function public.oauth_my_grants() to authenticated;

-- 2. The rate credits: nothing calls the helpers any more.
drop function if exists public.oauth_check_credit_put(uuid, text);
drop function if exists public.oauth_check_credit_take(uuid, text);
drop table if exists public.oauth_check_credits;
-- The registration class: 0093's oauth_register_client (restored above) no longer reads the column.
alter table public.oauth_clients drop column if exists vendor;
drop function if exists public.oauth_vendor_callbacks_only(text[]);

-- 3. The entitlement as 0093 left it.
update public.entitlement_keys
   set status = 'enforced', default_value = 'false'::jsonb,
       note = 'May connect an AI app to the MCP server with OAuth (oauth_ctx, oauth_begin_authorization). It spends the workspace''s site credits, capped per connection; the API-key door is separate.'
 where key = 'mcp';
update public.plan_entitlements set value = 'false'::jsonb where key = 'mcp' and plan_id = 'free';

-- 4. End state.
do $$
declare
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.oauth_ctx(text, text, text)', 'bcd7e88f9a62af2ebdf3623dca73c014'],
      ['public.oauth_check(text, text)', '43271cf097d7e56cada31febe5eb0efe'],
      ['public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text)', 'df8f5a04ee8ee2188502ad3c69382d52'],
      ['public.oauth_decide_authorization(text, boolean, numeric, text)', '84227fee357456de62c5b22e7a4d30d6'],
      ['public.oauth_exchange_code(text, uuid, text, text, text, text, text)', '991015aa1d7bf75ad9396382b55c9e07'],
      ['public.oauth_refresh(text, uuid, text, text, text)', '5e6602cf0b679ccc06b151a1c3c2c7f4'],
      ['public.oauth_my_grants()', '1ce7826facd2f15a241d594bbed9768c'],
      ['public.oauth_limits()', '26991d89b0f198dd4016b5156a8b0be1'],
      ['public.oauth_register_client(text, text[], text)', '4ca23a05570337e930413dd109b7c78c'],
      ['public.api_create_video(text, text, jsonb, text, text, text)', 'c054107143ba7bbfaaaff861d5575ecb'],
      ['public.api_request_download(text, text, text, text, text, text)', 'b89909c57a27a5ab7d0fa3368f1a3677']] loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(pair[1])) is distinct from pair[2] then
      raise exception 'rollback 0147 end state: % is not its earlier body', pair[1];
    end if;
  end loop;
  if to_regprocedure('public.oauth_check_credit_put(uuid, text)') is not null
     or to_regprocedure('public.oauth_check_credit_take(uuid, text)') is not null
     or to_regclass('public.oauth_check_credits') is not null
     or to_regprocedure('public.oauth_vendor_callbacks_only(text[])') is not null
     or exists (select 1 from pg_attribute where attrelid = 'public.oauth_clients'::regclass and attname = 'vendor' and not attisdropped) then
    raise exception 'rollback 0147 end state: an object of 0147 is still there';
  end if;
  if (select status from public.entitlement_keys where key = 'mcp') is distinct from 'enforced'
     or (select value from public.plan_entitlements where key = 'mcp' and plan_id = 'free') is distinct from 'false'::jsonb then
    raise exception 'rollback 0147 end state: the mcp entitlement is not back as 0093 left it';
  end if;
end $$;

commit;
