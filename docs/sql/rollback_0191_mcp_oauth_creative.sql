-- rollback_0191_mcp_oauth_creative.sql — takes migration 0191 (the Studio's generations for a connected assistant) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS KEPT: the record. oauth_creative_quotes and oauth_creative_jobs (which connection started which generation, from which
-- quote, holding what) stay, unreadable by any API role as before; oauth_creative_rate_counters stays too (it holds nothing of
-- value; drop it by hand if you want). A generation already started finishes, is captured or refunded by the worker as usual.
--
-- WHAT IS LOST: the five doors. After this, a connected app's quote_creative / create_creative / get_creative_job /
-- list_creative_models / list_media answer 503 api_unavailable naming migration 0191, and nothing new can be started. The
-- connection's monthly spend goes back to counting videos only (0093), which is safe because no new generation can be started.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if a replaced function is not 0191's body (a later change would be undone), or if any connection
--      holds the studio:create permission: 0093's check cannot hold such a row, and taking a permission away from a person's
--      connection is their decision. Disconnect those connections first (Developers → Connected apps), then run this again.
--   1. Drops the five doors and 0191's helpers.
--   2. Puts back 0093's oauth_scopes_supported, oauth_endpoint_scope and oauth_grant_month_credits, byte for byte, and 0093's check.
--   3. Asserts the end state.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_scopes_supported()');
  if h is distinct from '3ef7e3154b00584e7625225d20dfa705' then
    raise exception 'rollback 0191: public.oauth_scopes_supported() is not 0191''s body (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_endpoint_scope(text)');
  if h is distinct from '39be9da597b74684494d55e8547e3eae' then
    raise exception 'rollback 0191: public.oauth_endpoint_scope(text) is not 0191''s body (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_grant_month_credits(uuid)');
  if h is distinct from '6d345abdb50d6c85a4c1276c6e255a14' then
    raise exception 'rollback 0191: public.oauth_grant_month_credits(uuid) is not 0191''s body (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text)');
  if h is distinct from 'c385018bae2e55e8c7d4d67013618146' then
    raise exception 'rollback 0191: public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) is not 0191''s body (md5 %): read the live body first', h;
  end if;
  if exists (select 1 from public.oauth_grants g where 'studio:create' = any (g.scopes)) then
    raise exception 'rollback 0191: % connection(s) hold the studio:create permission; disconnect them first (Developers → Connected apps)',
      (select count(*) from public.oauth_grants g where 'studio:create' = any (g.scopes));
  end if;
end $$;

-- A pending consent request (minutes-long) that holds studio:create would fail 0093's check at decide time with a server error:
-- it goes, and the person starts the connection again.
delete from public.oauth_auth_requests where 'studio:create' = any (scopes);

drop function if exists public.oauth_drop_requested_scope(text, text);
drop function if exists public.oauth_creative_models(text, text, text);
drop function if exists public.oauth_media_list(text, text, integer, text);
drop function if exists public.oauth_creative_quote(text, text, text, jsonb, text);
drop function if exists public.oauth_creative_create(text, uuid, text, text);
drop function if exists public.oauth_creative_get(text, uuid, text);
drop function if exists public.oauth_creative_quote_json(public.oauth_creative_quotes);
drop function if exists public.oauth_creative_rate_refusal(uuid, text);
drop function if exists public.oauth_creative_rate_take(uuid, text);
drop function if exists public.oauth_creative_state_refusal(text, text);
drop function if exists public.oauth_creative_model_state(text, text);
drop function if exists public.oauth_creative_limits();
drop function if exists public.oauth_creative_capabilities();

-- oauth_begin_authorization: 0147's body, verbatim (0147_mcp_free_tier.sql).
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

revoke all on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_begin_authorization(uuid, text, text, text, text, text, text, text) to authenticated;

create or replace function public.oauth_scopes_supported() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['videos:read', 'videos:create', 'videos:publish']::text[]
$$;

alter table public.oauth_grants drop constraint if exists oauth_grants_scopes_check;
alter table public.oauth_grants add constraint oauth_grants_scopes_check
  check (cardinality(scopes) between 1 and 3
         and scopes <@ array['videos:read', 'videos:create', 'videos:publish']::text[]);

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

revoke all on function public.oauth_scopes_supported() from public, anon, authenticated, service_role;
revoke all on function public.oauth_endpoint_scope(text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_grant_month_credits(uuid) from public, anon, authenticated, service_role;

do $$
declare
  h text;
begin
  if to_regprocedure('public.oauth_creative_create(text, uuid, text, text)') is not null
     or to_regprocedure('public.oauth_creative_quote(text, text, text, jsonb, text)') is not null
     or to_regprocedure('public.oauth_creative_model_state(text, text)') is not null then
    raise exception 'rollback 0191 end state: a 0191 function is still there';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_endpoint_scope(text)');
  if h is distinct from 'ade9dedd7a1058b4938e9df7e8bd1b87' then
    raise exception 'rollback 0191 end state: oauth_endpoint_scope is not 0093''s body (md5 %)', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_grant_month_credits(uuid)');
  if h is distinct from '6329f5ed73f203e67e31e885238fa1ab' then
    raise exception 'rollback 0191 end state: oauth_grant_month_credits is not 0093''s body (md5 %)', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.oauth_scopes_supported()');
  if h is distinct from 'b1cdcf014109e5902d0e6d9f05767186' then
    raise exception 'rollback 0191 end state: oauth_scopes_supported is not 0093''s body (md5 %)', h;
  end if;
end $$;

commit;

-- Verify (every column should read true)
-- select to_regprocedure('public.oauth_creative_create(text, uuid, text, text)') is null as doors_gone,
--        not ('studio:create' = any (public.oauth_scopes_supported())) as permission_gone,
--        to_regclass('public.oauth_creative_jobs') is not null as record_kept;
