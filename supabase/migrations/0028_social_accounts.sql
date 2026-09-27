-- 0028_social_accounts.sql — an organization connects its Instagram and TikTok
-- accounts; their tokens are encrypted in Supabase Vault.
--
-- The YouTube half of "connect your accounts" already exists (0022: a
-- channel's refresh token in Vault). This file adds the other two platforms
-- the owner asked for, the same way:
--
--   * Instagram — "Instagram API with Instagram Login" (Business / Creator
--     accounts). The connect flow keeps a LONG-LIVED Instagram user token (60
--     days, refreshable while valid). There is no separate refresh token.
--     https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
--     https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/
--   * TikTok — Login Kit + Content Posting API. An access token (24 h) and a
--     refresh token (365 days) that TikTok may rotate on refresh.
--     https://developers.tiktok.com/doc/oauth-user-access-token-management
--
-- WHAT IT ADDS
--   social_accounts          one row per connected account of an organization:
--                            platform, the platform's own account id, username,
--                            display name, avatar, status, who connected it.
--                            NO token column. Readable by the organization's
--                            members (RLS, viewer+); written only through the
--                            functions below.
--   social_account_secrets   the Vault secret ids (never the tokens) and the
--                            token expiries. No API role has any privilege on
--                            it, and RLS is on with no policy (deny-all).
--   store_social_account(org, platform, access_token, refresh_token, meta)
--                            org EDITOR+ of that organization, signed in.
--                            Write-only: returns the account id and status,
--                            never a token or a Vault id.
--   revoke_social_account(account_id)
--                            org editor+ (or the platform's runner): destroys
--                            both Vault secrets, marks the row revoked.
--   read_social_token(account_id)
--                            service role only (the queue worker): the tokens
--                            of an ACTIVE connection.
--   rotate_social_token(account_id, access, refresh, expiries)
--                            service role only: the worker stores a refreshed
--                            token pair (Instagram returns a new long-lived
--                            token; TikTok may return a new refresh token).
--   set_social_account_status(account_id, status)
--                            service role only: 'expired' / 'error' when a
--                            refresh is refused, so the page asks to reconnect.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * No function returns a token, or a Vault id, to a browser. Connecting is
--     write-only; the Command Center never reads a token back.
--   * No insert/update/delete policy on social_accounts: a browser cannot
--     invent, move or re-point an account row; only store/revoke can.
--   * Only the scopes each connect flow requests are accepted.
--   * Nothing here publishes. Publishing is a separate, gated request the
--     worker carries out (a later migration).
--
-- REQUIRES
--   0018 (organizations helpers) and Supabase Vault (the supabase_vault
--   extension; see 0022). Stops with the remedy if either is missing.
--
-- Additive and idempotent: guarded creates, create-or-replace functions,
-- revoke-then-grant. Safe to re-run. Nothing existing is dropped or changed.

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regclass('public.organizations') is null then
    raise exception '0028 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('vault.create_secret(text, text, text, uuid)') is null
     or to_regprocedure('vault.update_secret(uuid, text, text, text, uuid)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception '0028 needs Supabase Vault: enable the "vault" extension (Dashboard -> Database -> Extensions -> supabase_vault), then run this file again';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The accounts (no secrets) and their secret references
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.social_accounts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete cascade,
  platform           text not null check (platform in ('instagram', 'tiktok')),
  -- Instagram: the professional account's IG user id. TikTok: the open_id.
  external_id        text not null check (external_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  username           text check (username is null or char_length(username) <= 100),
  display_name       text check (display_name is null or char_length(display_name) <= 200),
  avatar_url         text check (avatar_url is null
                                 or (avatar_url ~ '^https://' and char_length(avatar_url) <= 2048)),
  status             text not null default 'connected'
                     check (status in ('connected', 'expired', 'error', 'revoked')),
  scopes             text[] not null default '{}',
  created_by         uuid,
  connected_by_email text,
  connected_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint social_accounts_unique_per_org unique (org_id, platform, external_id)
);

create index if not exists social_accounts_org_idx on public.social_accounts (org_id, platform);

comment on table public.social_accounts is
  'An organization''s connected Instagram / TikTok accounts. No token column: tokens are in Supabase Vault, referenced from social_account_secrets. Written only by store_social_account / revoke_social_account and the runner''s rotate/status functions (migration 0028).';

create table if not exists public.social_account_secrets (
  account_id         uuid primary key references public.social_accounts (id) on delete cascade,
  access_secret_id   uuid,
  refresh_secret_id  uuid,
  access_expires_at  timestamptz,
  refresh_expires_at timestamptz,
  updated_at         timestamptz not null default now()
);

comment on table public.social_account_secrets is
  'Vault secret ids for social_accounts tokens (never the tokens). No API role has privileges; RLS on with no policy (migration 0028).';

-- RLS: members of the account's organization read it; nobody writes directly.
alter table public.social_accounts enable row level security;
revoke all on public.social_accounts from public, anon, authenticated;
grant select on public.social_accounts to authenticated;
grant select, insert, update, delete on public.social_accounts to service_role;

drop policy if exists social_accounts_select on public.social_accounts;
create policy social_accounts_select on public.social_accounts
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

alter table public.social_account_secrets enable row level security;
-- No policy on purpose: deny-all for every role that does not bypass RLS.
revoke all on public.social_account_secrets from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The only scopes each connect flow requests (command-center/lib/server/
-- social-oauth.ts INSTAGRAM_SCOPES / TIKTOK_SCOPES).
create or replace function public.social_allowed_scopes(p_platform text) returns text[]
  language sql immutable set search_path = '' as $$
  select case p_platform
    when 'instagram' then array['instagram_business_basic', 'instagram_business_content_publish']::text[]
    when 'tiktok'    then array['user.info.basic', 'video.publish', 'video.upload']::text[]
    else '{}'::text[]
  end
$$;

-- The platform's own runner (service key), or a direct database session with
-- no API claims (the SQL editor). A browser always carries claims.
create or replace function public.social_trusted_caller() returns boolean
  language sql stable set search_path = '' as $$
  select coalesce(auth.role(), '') = 'service_role'
      or coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
$$;

-- A token is one printable token with no whitespace.
create or replace function public.social_token_ok(tok text) returns boolean
  language sql immutable set search_path = '' as $$
  select tok is not null and char_length(tok) between 10 and 4096 and tok ~ '^[\x21-\x7e]+$'
$$;

-- Destroy one Vault secret: overwrite first, then delete, so even where
-- Vault's table refuses the delete the token is gone.
create or replace function public.social_destroy_secret(sid uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
begin
  if sid is null then
    return;
  end if;
  perform vault.update_secret(sid, gen_random_uuid()::text || gen_random_uuid()::text, null, 'revoked');
  begin
    delete from vault.secrets s where s.id = sid;
  exception when insufficient_privilege then
    null;
  end;
end
$$;

-- Create or overwrite one Vault secret; returns its id.
create or replace function public.social_put_secret(sid uuid, tok text, label text) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
begin
  if sid is not null then
    perform vault.update_secret(sid, tok, null, label);
    return sid;
  end if;
  return vault.create_secret(tok, 'nightshift_social:' || gen_random_uuid()::text, label);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. store_social_account — write-only, org editor+
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
                     'access_expires_in', 'refresh_expires_in')
  ) then
    raise exception 'meta has an unknown key' using errcode = '22023';
  end if;

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
    created_by, connected_by_email, connected_at, revoked_at, updated_at)
  values (
    p_org_id, p_platform, ext, uname, dname, avatar, 'connected', granted,
    me, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''), now(), null, now())
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. revoke_social_account — org editor+ (or the platform's runner)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.revoke_social_account(p_account_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
declare
  acc public.social_accounts;
  sec public.social_account_secrets;
begin
  select * into acc from public.social_accounts a where a.id = p_account_id for update;
  if not public.social_trusted_caller()
     and (auth.uid() is null or acc.id is null or not public.is_org_member(acc.org_id, 'editor')) then
    raise exception 'only an owner, admin or editor of this organization may disconnect it'
      using errcode = '42501';
  end if;
  if acc.id is null or acc.status = 'revoked' then
    return false;
  end if;

  select * into sec from public.social_account_secrets s where s.account_id = acc.id for update;
  perform public.social_destroy_secret(sec.access_secret_id);
  perform public.social_destroy_secret(sec.refresh_secret_id);
  delete from public.social_account_secrets s where s.account_id = acc.id;

  update public.social_accounts a
     set status = 'revoked', revoked_at = now(), updated_at = now()
   where a.id = acc.id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The runner's functions — service role only
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.read_social_token(p_account_id uuid)
  returns table (
    account_id uuid,
    org_id uuid,
    platform text,
    external_id text,
    access_token text,
    refresh_token text,
    access_expires_at timestamptz,
    refresh_expires_at timestamptz,
    connected_at timestamptz
  )
  language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.social_trusted_caller() then
    raise exception 'social tokens are read by the platform''s runner only' using errcode = '42501';
  end if;
  return query
    select a.id, a.org_id, a.platform, a.external_id,
           da.decrypted_secret::text, dr.decrypted_secret::text,
           s.access_expires_at, s.refresh_expires_at, a.connected_at
      from public.social_accounts a
      join public.social_account_secrets s on s.account_id = a.id
      join vault.decrypted_secrets da on da.id = s.access_secret_id
      left join vault.decrypted_secrets dr on dr.id = s.refresh_secret_id
     where a.id = p_account_id
       and a.status <> 'revoked';
end
$$;

create or replace function public.rotate_social_token(
  p_account_id uuid, p_access_token text, p_refresh_token text default null,
  p_access_expires_at timestamptz default null, p_refresh_expires_at timestamptz default null
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
declare
  acc public.social_accounts;
  sec public.social_account_secrets;
  label text;
begin
  if not public.social_trusted_caller() then
    raise exception 'social tokens are rotated by the platform''s runner only' using errcode = '42501';
  end if;
  if not public.social_token_ok(p_access_token)
     or (p_refresh_token is not null and not public.social_token_ok(p_refresh_token)) then
    raise exception 'invalid token' using errcode = '22023';
  end if;
  select * into acc from public.social_accounts a where a.id = p_account_id for update;
  if acc.id is null or acc.status = 'revoked' then
    return false;
  end if;
  select * into sec from public.social_account_secrets s where s.account_id = acc.id for update;
  if sec.account_id is null then
    return false;
  end if;
  label := 'Nightshift: ' || acc.platform || ' token for account ' || acc.external_id;
  update public.social_account_secrets s
     set access_secret_id   = public.social_put_secret(sec.access_secret_id, p_access_token, label || ' (access)'),
         refresh_secret_id  = case when p_refresh_token is null then sec.refresh_secret_id
                                   else public.social_put_secret(sec.refresh_secret_id, p_refresh_token, label || ' (refresh)') end,
         access_expires_at  = coalesce(p_access_expires_at, sec.access_expires_at),
         refresh_expires_at = coalesce(p_refresh_expires_at, sec.refresh_expires_at),
         updated_at         = now()
   where s.account_id = acc.id;
  update public.social_accounts a set status = 'connected', updated_at = now() where a.id = acc.id;
  return true;
end
$$;

create or replace function public.set_social_account_status(p_account_id uuid, p_status text) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.social_trusted_caller() then
    raise exception 'only the platform''s runner sets an account''s status' using errcode = '42501';
  end if;
  if p_status not in ('connected', 'expired', 'error') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  update public.social_accounts a
     set status = p_status, updated_at = now()
   where a.id = p_account_id and a.status <> 'revoked';
  return found;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.social_allowed_scopes(text) from public, anon, authenticated, service_role;
revoke all on function public.social_trusted_caller() from public, anon, authenticated, service_role;
revoke all on function public.social_token_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.social_destroy_secret(uuid) from public, anon, authenticated, service_role;
revoke all on function public.social_put_secret(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.store_social_account(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.revoke_social_account(uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_social_token(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rotate_social_token(uuid, text, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.set_social_account_status(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.store_social_account(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.revoke_social_account(uuid) to authenticated, service_role;
grant execute on function public.read_social_token(uuid) to service_role;
grant execute on function public.rotate_social_token(uuid, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.set_social_account_status(uuid, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.social_accounts'::regclass) as accounts_rls_on,
--   (select relrowsecurity from pg_class where oid = 'public.social_account_secrets'::regclass) as secrets_rls_on,
--   not has_table_privilege('authenticated', 'public.social_account_secrets', 'SELECT')
--     and not has_table_privilege('anon', 'public.social_account_secrets', 'SELECT') as secrets_unreadable,
--   not has_table_privilege('authenticated', 'public.social_accounts', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.social_accounts', 'UPDATE') as accounts_write_only_by_functions,
--   not has_function_privilege('authenticated', 'public.read_social_token(uuid)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.read_social_token(uuid)', 'EXECUTE') as read_is_service_only,
--   not has_function_privilege('anon', 'public.store_social_account(uuid, text, text, text, jsonb)', 'EXECUTE')
--     as anon_cannot_store;
