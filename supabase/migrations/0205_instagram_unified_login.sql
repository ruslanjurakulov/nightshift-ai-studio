-- 0205_instagram_unified_login.sql — Instagram connects through Meta's "Instagram API with Unified Login"; the
-- connections made with the old "Instagram API with Instagram Login" are kept, and read as "reconnect needed".
--
-- EVIDENCE (Scout, Meta's official docs, read 2026-11-21): Unified Login signs in at www.facebook.com/dialog/oauth with a
--   configuration id (config_id) instead of scopes, and the single code exchange at graph.facebook.com returns a Business
--   Integration System User token that does not expire by default and has no refresh endpoint. Its IG account ids come from
--   GET /me/assigned_instagram_accounts, and the client's business portfolio from GET /me?fields=client_business_id. Every
--   publishing call moves from graph.instagram.com to graph.facebook.com. A token stored by the old flow (0028: a 60-day
--   Instagram user token) is not one graph.facebook.com accepts.
-- DIAGNOSIS: 0028's social_accounts cannot tell a Unified Login connection from an old one, and store_social_account refuses
--   any meta key it does not know, so the business portfolio and the configuration a token was issued under cannot be kept.
--
-- CHANGE (additive):
--   social_accounts.auth_flow            'unified_login' for a connection made by the new flow; NULL for every row before
--                                        this file and for TikTok. An Instagram row whose auth_flow is not 'unified_login'
--                                        is an old Instagram Login connection: the Command Center shows it as "reconnect
--                                        needed" and the queue worker refuses to publish with it. NO existing row is
--                                        updated or deleted here (the old records stay until the new connection is
--                                        verified); the marker is the absence of the new value.
--   social_accounts.client_business_id   the client's business portfolio id, as Meta returned it (NULL when it did not).
--   social_accounts.config_id            the Meta configuration the token was issued under.
--                                        Both are ids, not credentials (config_id is a query parameter of a public URL).
--   store_social_account (0028's body, marked 0205 hunks only): accepts the three keys in meta, for Instagram only; an
--                                        Instagram connect must say auth_flow 'unified_login' and name its config_id
--                                        (the old flow's tokens do not work any more, so storing one would be a
--                                        connection that can only fail); the three columns are written on insert and
--                                        on a reconnect.
--   api_list_connected_accounts (0042's body, one marked 0205 hunk): the public API and the MCP tools report an old
--                                        Instagram Login row as connected = false (the same rule as the Command
--                                        Center), not true because its status still reads 'connected'.
--
-- WHAT IT DOES NOT CHANGE
--   * Tokens: still only in Vault through social_put_secret, exactly as 0028. No new function reads or returns one.
--   * Who may connect: an editor+ of the organization, signed in (0028). The binding is per organization: the unique key is
--     (org_id, platform, external_id), so a second organization connecting the same IG account gets ITS OWN row and its
--     own token, and never touches, moves or reads the first organization's row.
--   * Scopes: a Unified Login exchange returns no granted scopes, so the Command Center stores none (an empty array, never
--     a claimed list); social_allowed_scopes is unchanged.
--   * Publishing: nothing here publishes or queues anything.
--   * Grants and RLS: social_accounts keeps 0028's select-by-membership policy and no write privilege for API roles; the
--     new columns are ids an organization member may read, like external_id. store_social_account keeps its grant.
--
-- REQUIRES 0028. Idempotent: guarded column adds, create-or-replace, revoke-then-grant. Safe to re-run.
--
-- REPLACES (md5 drift guard: 0028's body, or this file's own on a replay; whitespace runs read as one space):
--   store_social_account (0028): before ac6b096b2d1eb2db6af1f695b797d173, after 4971ea1fb121bdfb0eb6b94f1954ca57
--   api_list_connected_accounts (0042, which replaced 0031's): before 84514536a7fb15db21bae3c735de942b, after 0e31510702e902f7f03fe9816dd2b5fd

do $$
declare
  h text;
begin
  if to_regclass('public.social_accounts') is null
     or to_regprocedure('public.store_social_account(uuid, text, text, text, jsonb)') is null then
    raise exception '0205 needs 0028_social_accounts.sql: apply it first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = 'public.store_social_account(uuid, text, text, text, jsonb)'::regprocedure;
  if h is null or h <> all (array['ac6b096b2d1eb2db6af1f695b797d173', '4971ea1fb121bdfb0eb6b94f1954ca57']) then
    raise exception '0205 found store_social_account with a body that is neither 0028''s nor 0205''s (md5 %): read the live body first', h;
  end if;
  if to_regprocedure('public.api_list_connected_accounts(text, text)') is not null then
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
      from pg_proc p where p.oid = 'public.api_list_connected_accounts(text, text)'::regprocedure;
    if h <> all (array['84514536a7fb15db21bae3c735de942b', '0e31510702e902f7f03fe9816dd2b5fd']) then
      raise exception '0205 found api_list_connected_accounts with a body that is neither 0042''s nor 0205''s (md5 %): read the live body first', h;
    end if;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The columns
-- ───────────────────────────────────────────────────────────────────────────

alter table public.social_accounts add column if not exists auth_flow text;
alter table public.social_accounts add column if not exists client_business_id text;
alter table public.social_accounts add column if not exists config_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'social_accounts_auth_flow_ok'
                   and conrelid = 'public.social_accounts'::regclass) then
    alter table public.social_accounts add constraint social_accounts_auth_flow_ok
      check (auth_flow is null or (auth_flow = 'unified_login' and platform = 'instagram'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'social_accounts_client_business_id_ok'
                   and conrelid = 'public.social_accounts'::regclass) then
    alter table public.social_accounts add constraint social_accounts_client_business_id_ok
      check (client_business_id is null or client_business_id ~ '^[0-9]{1,64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'social_accounts_config_id_ok'
                   and conrelid = 'public.social_accounts'::regclass) then
    alter table public.social_accounts add constraint social_accounts_config_id_ok
      check (config_id is null or config_id ~ '^[0-9]{1,64}$');
  end if;
end $$;

comment on column public.social_accounts.auth_flow is
  '''unified_login'' for an Instagram connection made through Instagram API with Unified Login (0205). NULL on an Instagram row = an old Instagram Login connection whose token graph.facebook.com does not accept: shown as "reconnect needed", never published with.';
comment on column public.social_accounts.client_business_id is
  'The client''s Meta business portfolio id for a Unified Login connection, as GET /me?fields=client_business_id returned it; NULL when Meta returned none (0205).';
comment on column public.social_accounts.config_id is
  'The Meta Unified Login configuration the connection''s token was issued under (0205). An id, not a credential.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. store_social_account — 0028's body with the 0205 hunks marked
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.store_social_account(
  p_org_id uuid, p_platform text, p_access_token text,
  p_refresh_token text default null, p_meta jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(p_meta, '{}'::jsonb);
  me uuid := auth.uid();
  ext text;
  uname text;
  dname text;
  avatar text;
  granted text[];
  acc public.social_accounts;
  sec public.social_account_secrets;
  a_sid uuid;
  r_sid uuid;
  a_exp timestamptz;
  r_exp timestamptz;
  label text;
  -- 0205
  flow text;
  biz text;
  cfg text;
  -- /0205
begin
  if me is null then
    raise exception 'sign in to connect an account' using errcode = '42501';
  end if;
  -- An unknown organization and one the caller may not edit read the same.
  if p_org_id is null or not public.is_org_member(p_org_id, 'editor') then
    raise exception 'only an owner, admin or editor of this organization may connect an account'
      using errcode = '42501';
  end if;
  if p_platform is null or p_platform not in ('instagram', 'tiktok') then
    raise exception 'unknown platform' using errcode = '22023';
  end if;
  if not public.social_token_ok(p_access_token) then
    raise exception 'invalid access token' using errcode = '22023';
  end if;
  -- TikTok always returns a refresh token; Instagram never does.
  if p_platform = 'tiktok' and not public.social_token_ok(p_refresh_token) then
    raise exception 'invalid refresh token' using errcode = '22023';
  end if;
  if p_platform = 'instagram' and p_refresh_token is not null then
    raise exception 'instagram has no refresh token' using errcode = '22023';
  end if;

  if jsonb_typeof(meta) <> 'object' then
    raise exception 'meta must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(meta) k
     where k not in ('external_id', 'username', 'display_name', 'avatar_url', 'scopes',
                     'access_expires_in', 'refresh_expires_in',
                     'auth_flow', 'client_business_id', 'config_id')  -- 0205: the last three
  ) then
    raise exception 'meta has an unknown key' using errcode = '22023';
  end if;

  -- 0205: an Instagram connection is a Unified Login one, with its configuration; TikTok carries none of the three.
  flow := nullif(btrim(coalesce(meta ->> 'auth_flow', '')), '');
  biz := nullif(btrim(coalesce(meta ->> 'client_business_id', '')), '');
  cfg := nullif(btrim(coalesce(meta ->> 'config_id', '')), '');
  if p_platform = 'instagram' then
    if flow is distinct from 'unified_login' then
      raise exception 'an Instagram connection must come from Unified Login (0205): deploy the Command Center that sends auth_flow'
        using errcode = '22023';
    end if;
    if cfg is null or cfg !~ '^[0-9]{1,64}$' then
      raise exception 'the Unified Login configuration id is required' using errcode = '22023';
    end if;
    if biz is not null and biz !~ '^[0-9]{1,64}$' then
      raise exception 'the business portfolio id is malformed' using errcode = '22023';
    end if;
  elsif flow is not null or biz is not null or cfg is not null then
    raise exception 'auth_flow, client_business_id and config_id are for Instagram only' using errcode = '22023';
  end if;
  -- /0205

  ext := nullif(btrim(coalesce(meta ->> 'external_id', '')), '');
  if ext is null or ext !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'the account id is required' using errcode = '22023';
  end if;
  uname := nullif(left(btrim(coalesce(meta ->> 'username', '')), 100), '');
  dname := nullif(left(btrim(coalesce(meta ->> 'display_name', '')), 200), '');
  avatar := nullif(btrim(coalesce(meta ->> 'avatar_url', '')), '');
  if avatar is not null and (avatar !~ '^https://' or char_length(avatar) > 2048) then
    avatar := null;  -- display only; a bad one is dropped, not stored
  end if;

  if jsonb_typeof(coalesce(meta -> 'scopes', '[]'::jsonb)) <> 'array' then
    raise exception 'scopes must be an array' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct s order by s), '{}') into granted
    from jsonb_array_elements_text(coalesce(meta -> 'scopes', '[]'::jsonb)) s;
  if not granted <@ public.social_allowed_scopes(p_platform) then
    raise exception 'scopes outside the connect flow''s request' using errcode = '22023';
  end if;

  if jsonb_typeof(meta -> 'access_expires_in') = 'number' then
    a_exp := now() + make_interval(secs => least(greatest((meta ->> 'access_expires_in')::numeric, 0), 31536000 * 2)::double precision);
  end if;
  if jsonb_typeof(meta -> 'refresh_expires_in') = 'number' then
    r_exp := now() + make_interval(secs => least(greatest((meta ->> 'refresh_expires_in')::numeric, 0), 31536000 * 2)::double precision);
  end if;

  -- Serialise two connects of one account on its row.
  select * into acc from public.social_accounts a
   where a.org_id = p_org_id and a.platform = p_platform and a.external_id = ext
   for update;
  if acc.id is not null then
    select * into sec from public.social_account_secrets s where s.account_id = acc.id for update;
  end if;

  label := 'Nightshift: ' || p_platform || ' token for account ' || ext;
  a_sid := public.social_put_secret(sec.access_secret_id, p_access_token, label || ' (access)');
  if p_refresh_token is not null then
    r_sid := public.social_put_secret(sec.refresh_secret_id, p_refresh_token, label || ' (refresh)');
  else
    perform public.social_destroy_secret(sec.refresh_secret_id);
    r_sid := null;
  end if;

  insert into public.social_accounts as a (
    org_id, platform, external_id, username, display_name, avatar_url, status, scopes,
    created_by, connected_by_email, connected_at, revoked_at, updated_at,
    auth_flow, client_business_id, config_id)  -- 0205: the last three
  values (
    p_org_id, p_platform, ext, uname, dname, avatar, 'connected', granted,
    me, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''), now(), null, now(),
    flow, biz, cfg)  -- 0205: the last three
  on conflict (org_id, platform, external_id) do update set
    username           = excluded.username,
    display_name       = excluded.display_name,
    avatar_url         = excluded.avatar_url,
    status             = 'connected',
    scopes             = excluded.scopes,
    created_by         = excluded.created_by,
    connected_by_email = excluded.connected_by_email,
    connected_at       = excluded.connected_at,
    revoked_at         = null,
    -- 0205: a reconnect through Unified Login turns an old row into a new one
    auth_flow          = excluded.auth_flow,
    client_business_id = excluded.client_business_id,
    config_id          = excluded.config_id,
    -- /0205
    updated_at         = now()
  returning * into acc;

  insert into public.social_account_secrets as s (
    account_id, access_secret_id, refresh_secret_id, access_expires_at, refresh_expires_at, updated_at)
  values (acc.id, a_sid, r_sid, a_exp, r_exp, now())
  on conflict (account_id) do update set
    access_secret_id   = excluded.access_secret_id,
    refresh_secret_id  = excluded.refresh_secret_id,
    access_expires_at  = excluded.access_expires_at,
    refresh_expires_at = excluded.refresh_expires_at,
    updated_at         = now();

  return jsonb_build_object('id', acc.id, 'platform', p_platform, 'external_id', ext, 'connected', true);
end
$$;

revoke all on function public.store_social_account(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.store_social_account(uuid, text, text, text, jsonb) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. api_list_connected_accounts — 0042's body with one 0205 hunk (only where 0031/0042 are applied)
-- ───────────────────────────────────────────────────────────────────────────

do $outer$
begin
  if to_regprocedure('public.api_list_connected_accounts(text, text)') is null then
    return;  -- the public API (0031/0042) is not on this database: nothing to correct
  end if;
  execute $ddl$
create or replace function public.api_list_connected_accounts(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'accounts.list', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    return public.api_finish(ctx, public.api_ok(jsonb_build_object('accounts',
      coalesce((select jsonb_agg(jsonb_build_object('platform', 'youtube', 'channel_id', c.channel_id,
                  'name', coalesce(nullif(c.credential_ref ->> 'youtube_title', ''), c.name),
                  'connected', public.publish_channel_connected(c.channel_id)) order by c.channel_id)
                  from public.channels c where c.org_id = (ctx ->> 'org_id')::uuid), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('platform', s.platform, 'account_id', s.id,
                  'name', coalesce(s.display_name, s.username, s.platform), 'username', s.username,
                  -- 0205: an old Instagram Login row can never post: not connected (false, never null: auth_flow is null there)
                  'connected', s.status = 'connected' and (s.platform <> 'instagram' or s.auth_flow is not distinct from 'unified_login'))
                  order by s.platform, s.created_at)
                  from public.social_accounts s
                 where s.org_id = (ctx ->> 'org_id')::uuid and s.status <> 'revoked'), '[]'::jsonb))));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;
$ddl$;
  execute 'revoke all on function public.api_list_connected_accounts(text, text) from public, anon, authenticated, service_role';
  execute 'grant execute on function public.api_list_connected_accounts(text, text) to anon';
end
$outer$;

-- End state: fail the apply rather than leave a half-changed function or a widened grant.
do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.store_social_account(uuid, text, text, text, jsonb)'::regprocedure)
     is distinct from '4971ea1fb121bdfb0eb6b94f1954ca57' then
    raise exception '0205 end state: store_social_account is not 0205''s body';
  end if;
  if has_function_privilege('anon', 'public.store_social_account(uuid, text, text, text, jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.store_social_account(uuid, text, text, text, jsonb)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.social_accounts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.social_accounts', 'INSERT') then
    raise exception '0205 end state: store_social_account / social_accounts grants are not 0028''s';
  end if;
  if to_regprocedure('public.api_list_connected_accounts(text, text)') is not null
     and ((select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
            where oid = 'public.api_list_connected_accounts(text, text)'::regprocedure) is distinct from '0e31510702e902f7f03fe9816dd2b5fd'
          or not has_function_privilege('anon', 'public.api_list_connected_accounts(text, text)', 'EXECUTE')
          or has_function_privilege('authenticated', 'public.api_list_connected_accounts(text, text)', 'EXECUTE')) then
    raise exception '0205 end state: api_list_connected_accounts is not 0205''s body with 0042''s grant';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.store_social_account(uuid,text,text,text,jsonb)'::regprocedure) = '4971ea1fb121bdfb0eb6b94f1954ca57' as store_0205,
--   (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'social_accounts'
--     and column_name in ('auth_flow', 'client_business_id', 'config_id'))                                                as columns_added,
--   not has_table_privilege('authenticated', 'public.social_accounts', 'UPDATE')                                          as still_write_only,
--   not has_function_privilege('anon', 'public.store_social_account(uuid, text, text, text, jsonb)', 'EXECUTE')          as anon_cannot_store,
--   (select relrowsecurity from pg_class where oid = 'public.social_accounts'::regclass)                                  as rls_on;
-- How many Instagram connections still need a reconnect (they are kept, and shown as such):
-- select count(*) from public.social_accounts where platform = 'instagram' and status <> 'revoked'
--    and auth_flow is distinct from 'unified_login';
