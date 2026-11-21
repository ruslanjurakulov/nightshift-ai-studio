-- rollback_0205_instagram_unified_login.sql — takes migration 0205 (Instagram through Unified Login) out.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK: 0028's store_social_account and 0042's api_list_connected_accounts, verbatim, with their grants. The Command Center then answers an Instagram
--   connect with "needs a database update (0205)" (0028 refuses the auth_flow / config_id keys), and stores nothing.
-- WHAT IS KEPT: the three columns and their values (auth_flow, client_business_id, config_id). They are ids, not secrets;
--   dropping them would turn every Unified Login connection back into one that reads "reconnect needed". Drop them by
--   hand only if you mean exactly that.
-- REDEPLOYING the old Command Center after this rollback leaves auth_flow = 'unified_login' on the rows reconnected through
--   Unified Login: the old worker would then use those tokens on graph.instagram.com and fail until a 190 marks them expired.
--
-- 0. REFUSES (changes nothing) if store_social_account is not 0205's body.

begin;
set local lock_timeout = '5s';

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = to_regprocedure('public.store_social_account(uuid, text, text, text, jsonb)'))
     is distinct from '4971ea1fb121bdfb0eb6b94f1954ca57' then
    raise exception 'rollback_0205: store_social_account is not 0205''s body; read the live body first';
  end if;
  if to_regprocedure('public.api_list_connected_accounts(text, text)') is not null
     and (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
           where oid = 'public.api_list_connected_accounts(text, text)'::regprocedure) is distinct from '0e31510702e902f7f03fe9816dd2b5fd' then
    raise exception 'rollback_0205: api_list_connected_accounts is not 0205''s body; read the live body first';
  end if;
end $$;

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

revoke all on function public.store_social_account(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.store_social_account(uuid, text, text, text, jsonb) to authenticated;

do $outer$
begin
  if to_regprocedure('public.api_list_connected_accounts(text, text)') is null then
    return;
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
                  'connected', s.status = 'connected') order by s.platform, s.created_at)
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

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.store_social_account(uuid, text, text, text, jsonb)'::regprocedure)
     is distinct from 'ac6b096b2d1eb2db6af1f695b797d173' then
    raise exception 'rollback_0205 end state: store_social_account is not 0028''s body';
  end if;
  if to_regprocedure('public.api_list_connected_accounts(text, text)') is not null
     and (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
           where oid = 'public.api_list_connected_accounts(text, text)'::regprocedure) is distinct from '84514536a7fb15db21bae3c735de942b' then
    raise exception 'rollback_0205 end state: api_list_connected_accounts is not 0042''s body';
  end if;
end $$;

commit;
