-- 0022_channel_tokens.sql — customer channels keep their YouTube refresh token
-- encrypted in Supabase Vault (SaaS phase C3).
--
-- Until now every channel's upload token was a GitHub Actions secret in the
-- operator's repository (CHRONOS_YT_TOKEN_<REF>), written by a platform
-- owner/admin. That is right for the operator's own channels and wrong for a
-- customer organization: its admin cannot write the operator's repository
-- secrets, and should not have to ask. This migration gives a customer
-- organization's admin a WRITE-ONLY place to put their channel's refresh
-- token, encrypted at rest by Vault, readable only by the platform's own
-- runner (the service key).
--
-- WHAT IT ADDS
--   channel_token_refs  one row per channel that has ever been connected this
--                       way: the Vault secret's id (never the token), the
--                       YouTube channel the token was granted for, the scopes
--                       Google granted, which OAuth client minted it, who
--                       connected it and when, and when it was revoked.
--   store_channel_token(channel_id, refresh_token, meta)
--                       org owner/admin of the channel's organization, signed
--                       in (authenticated). Creates or replaces the Vault
--                       secret. Returns status only — never the token, never
--                       the Vault id.
--   channel_token_status(channel_id | null)
--                       org viewer+: non-secret metadata for one channel, or
--                       for every channel the caller can view (null).
--   revoke_channel_token(channel_id)
--                       org owner/admin (or the platform): destroys the Vault
--                       secret and stamps revoked_at. Google-side access must
--                       still be removed at myaccount.google.com/permissions —
--                       the Command Center says so.
--   read_channel_token(channel_id)
--                       service role only (the queue worker, the Actions
--                       workflow): the refresh token of an ACTIVE connection.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * No function returns the token, or the Vault id, to a browser. There is
--     no "read back" for authenticated at all: connecting is write-only.
--   * The default organization (the operator's own channels) is refused by
--     store_channel_token. Those channels keep today's GitHub-secret path,
--     unchanged, so the operator's flow cannot be altered by this file.
--   * A token granted for a DIFFERENT YouTube channel than the one the channel
--     row was verified against (credential_ref.youtube_channel_id) is refused:
--     otherwise a video made for one channel could upload to another account.
--   * Only the four YouTube scopes the connect flow requests are accepted.
--   * No table privileges for anon/authenticated/service_role on
--     channel_token_refs, and RLS on with no policy (deny-all) as a second
--     lock: nobody reads the Vault id through the API, in any organization.
--
-- REQUIRES
--   0018 (organizations helpers) and Supabase Vault (the supabase_vault
--   extension: Dashboard → Database → Extensions → "vault"; enabled by default
--   on new projects). Stops with the remedy if either is missing.
--
-- Additive and idempotent: guarded creates, create-or-replace functions,
-- revoke-then-grant. Safe to re-run. Nothing existing is dropped or changed.

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.channel_org(text)') is null
     or to_regprocedure('public.default_org_id()') is null then
    raise exception '0022 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('vault.create_secret(text, text, text, uuid)') is null
     or to_regprocedure('vault.update_secret(uuid, text, text, text, uuid)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception '0022 needs Supabase Vault: enable the "vault" extension (Dashboard -> Database -> Extensions -> supabase_vault), then run this file again';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The reference table
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.channel_token_refs (
  channel_id            text primary key
                        references public.channels (channel_id) on update cascade,
  provider              text not null default 'youtube' check (provider = 'youtube'),
  -- The Vault secret holding the refresh token. Null once revoked: the secret
  -- is destroyed, not merely flagged.
  vault_secret_id       uuid,
  -- Display only. The connect flow requests no email scope, so this stays
  -- null unless a later flow is granted one; the channel title is what the
  -- dashboard shows.
  google_account_email  text check (google_account_email is null or char_length(google_account_email) <= 320),
  youtube_channel_id    text check (youtube_channel_id is null or youtube_channel_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  youtube_channel_title text check (youtube_channel_title is null or char_length(youtube_channel_title) <= 200),
  scopes                text[] not null default '{}',
  -- Which OAuth client minted the token. Not a secret (it is in every consent
  -- URL); the runner needs it to pair the refresh token with the right client.
  oauth_client_id       text check (oauth_client_id is null or char_length(oauth_client_id) <= 200),
  connected_by          uuid,
  connected_by_email    text,
  connected_at          timestamptz,
  revoked_at            timestamptz,
  revoked_by            uuid,
  updated_at            timestamptz not null default now(),
  -- Active (connected_at set, not revoked) exactly when a secret exists.
  constraint channel_token_refs_active_has_secret
    check ((revoked_at is null) = (vault_secret_id is not null))
);

comment on table public.channel_token_refs is
  'Customer channels'' YouTube refresh tokens, BY REFERENCE: the token itself is encrypted in Supabase Vault (vault_secret_id). Written only by store_channel_token / revoke_channel_token; the token is readable only by the service role through read_channel_token. No API role has table privileges (migration 0022).';

alter table public.channel_token_refs enable row level security;
-- No policy on purpose: deny-all for every role that does not bypass RLS,
-- should a privilege ever be granted by mistake.
revoke all on public.channel_token_refs from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The only scopes the connect flow requests (lib/server/google-oauth.ts
-- YOUTUBE_OAUTH_SCOPES = config.YOUTUBE_SCOPES). A token claiming anything
-- else was not minted by that flow.
create or replace function public.channel_token_allowed_scopes() returns text[]
  language sql immutable set search_path = '' as $$
  select array[
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/yt-analytics.readonly'
  ]::text[]
$$;

-- The platform's own runner (service key), or a direct database session with
-- no API claims (the SQL editor). A browser always carries claims.
create or replace function public.channel_token_trusted_caller() returns boolean
  language sql stable set search_path = '' as $$
  select coalesce(auth.role(), '') = 'service_role'
      or coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. store_channel_token — write-only, org admin of the channel's org
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.store_channel_token(
  p_channel_id text, p_refresh_token text, p_meta jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(p_meta, '{}'::jsonb);
  ch record;
  cur public.channel_token_refs;
  tok text := p_refresh_token;
  yt_id text;
  yt_title text;
  email text;
  client text;
  granted text[];
  sid uuid;
  reconnected boolean := false;
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'sign in to connect a channel' using errcode = '42501';
  end if;

  select c.channel_id, c.org_id, c.credential_ref into ch
    from public.channels c where c.channel_id = p_channel_id;
  -- An unknown channel and a channel the caller may not administer read the
  -- same: an admin of one organization learns nothing about another's ids.
  if ch.channel_id is null or not public.is_org_member(ch.org_id, 'admin') then
    raise exception 'only an owner or admin of this channel''s organization may connect it'
      using errcode = '42501';
  end if;
  if ch.org_id = public.default_org_id() then
    raise exception 'the operator''s channels keep their token in GitHub Actions secrets'
      using errcode = '22023';
  end if;

  -- A refresh token is one printable token with no whitespace. Anything else
  -- is not what Google returned, and must not be stored as if it were.
  if tok is null or char_length(tok) < 10 or char_length(tok) > 2048 or tok !~ '^[\x21-\x7e]+$' then
    raise exception 'invalid refresh token' using errcode = '22023';
  end if;

  if jsonb_typeof(meta) <> 'object' then
    raise exception 'meta must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(meta) k
     where k not in ('youtube_channel_id', 'youtube_channel_title', 'google_account_email',
                     'scopes', 'oauth_client_id')
  ) then
    raise exception 'meta has an unknown key' using errcode = '22023';
  end if;

  yt_id := nullif(btrim(coalesce(meta ->> 'youtube_channel_id', '')), '');
  yt_title := nullif(left(btrim(coalesce(meta ->> 'youtube_channel_title', '')), 200), '');
  email := nullif(lower(btrim(coalesce(meta ->> 'google_account_email', ''))), '');
  client := nullif(btrim(coalesce(meta ->> 'oauth_client_id', '')), '');

  if yt_id is null or yt_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'the YouTube channel this token was granted for is required' using errcode = '22023';
  end if;
  -- The token must be for the channel this row was verified against.
  if coalesce(ch.credential_ref ->> 'youtube_channel_id', '') <> ''
     and ch.credential_ref ->> 'youtube_channel_id' <> yt_id then
    raise exception 'wrong_youtube_channel: this Google account''s channel is not the one this channel was verified against'
      using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(meta -> 'scopes', '[]'::jsonb)) <> 'array' then
    raise exception 'scopes must be an array' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct s order by s), '{}') into granted
    from jsonb_array_elements_text(coalesce(meta -> 'scopes', '[]'::jsonb)) s;
  if not granted <@ public.channel_token_allowed_scopes() then
    raise exception 'scopes outside the connect flow''s request' using errcode = '22023';
  end if;

  -- Serialise two connects of one channel on its row (a first connect racing
  -- another first connect fails the second insert on the primary key, and
  -- its Vault secret rolls back with it).
  select * into cur from public.channel_token_refs r where r.channel_id = ch.channel_id for update;

  if cur.channel_id is not null and cur.vault_secret_id is not null then
    perform vault.update_secret(cur.vault_secret_id, tok, null,
                                'Nightshift: YouTube refresh token for channel ' || ch.channel_id);
    sid := cur.vault_secret_id;
    reconnected := true;
  else
    sid := vault.create_secret(
      tok,
      -- Unique per connection, so a secret left behind by a revoke that could
      -- not delete it never blocks the next connect.
      'nightshift_yt_refresh:' || ch.channel_id || ':' || gen_random_uuid()::text,
      'Nightshift: YouTube refresh token for channel ' || ch.channel_id);
  end if;

  insert into public.channel_token_refs as r (
    channel_id, vault_secret_id, google_account_email, youtube_channel_id, youtube_channel_title,
    scopes, oauth_client_id, connected_by, connected_by_email, connected_at, revoked_at, revoked_by,
    updated_at)
  values (
    ch.channel_id, sid, email, yt_id, yt_title, granted, client, me,
    nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''), now(), null, null, now())
  on conflict (channel_id) do update set
    vault_secret_id       = excluded.vault_secret_id,
    google_account_email  = excluded.google_account_email,
    youtube_channel_id    = excluded.youtube_channel_id,
    youtube_channel_title = excluded.youtube_channel_title,
    scopes                = excluded.scopes,
    oauth_client_id       = excluded.oauth_client_id,
    connected_by          = excluded.connected_by,
    connected_by_email    = excluded.connected_by_email,
    connected_at          = excluded.connected_at,
    revoked_at            = null,
    revoked_by            = null,
    updated_at            = now();

  return jsonb_build_object(
    'channel_id', ch.channel_id,
    'connected', true,
    'reconnected', reconnected,
    'youtube_channel_id', yt_id,
    'scopes', to_jsonb(granted));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. channel_token_status — non-secret metadata, org viewer+
-- ───────────────────────────────────────────────────────────────────────────
-- A channel with no row, or one the caller may not view, simply has no row
-- in the result: "not connected" and "not yours" are indistinguishable.

create or replace function public.channel_token_status(p_channel_id text default null)
  returns table (
    channel_id text,
    connected boolean,
    youtube_channel_id text,
    youtube_channel_title text,
    google_account_email text,
    scopes text[],
    connected_at timestamptz,
    connected_by_email text,
    revoked_at timestamptz
  )
  language sql stable security definer set search_path = '' as $$
  select r.channel_id,
         r.vault_secret_id is not null and r.revoked_at is null,
         r.youtube_channel_id,
         r.youtube_channel_title,
         r.google_account_email,
         r.scopes,
         r.connected_at,
         r.connected_by_email,
         r.revoked_at
    from public.channel_token_refs r
    join public.channels c on c.channel_id = r.channel_id
   where (p_channel_id is null or r.channel_id = p_channel_id)
     and auth.uid() is not null
     and public.is_org_member(c.org_id, 'viewer')
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. revoke_channel_token — org admin (or the platform)
-- ───────────────────────────────────────────────────────────────────────────
-- Returns true when an active token was revoked, false when there was none.
-- The secret is overwritten first and then deleted, so even where Vault's
-- table refuses the delete, the token is gone.

create or replace function public.revoke_channel_token(p_channel_id text) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := public.channel_org(p_channel_id);
  cur public.channel_token_refs;
begin
  if not public.channel_token_trusted_caller()
     and (auth.uid() is null or org is null or not public.is_org_member(org, 'admin')) then
    raise exception 'only an owner or admin of this channel''s organization may disconnect it'
      using errcode = '42501';
  end if;

  select * into cur from public.channel_token_refs r where r.channel_id = p_channel_id for update;
  if cur.channel_id is null or cur.vault_secret_id is null then
    return false;
  end if;

  perform vault.update_secret(cur.vault_secret_id,
                              gen_random_uuid()::text || gen_random_uuid()::text,
                              null, 'revoked');
  begin
    delete from vault.secrets s where s.id = cur.vault_secret_id;
  exception when insufficient_privilege then
    null;  -- overwritten above; the reference below is cleared either way
  end;

  update public.channel_token_refs r
     set vault_secret_id = null,
         revoked_at = now(),
         revoked_by = auth.uid(),
         updated_at = now()
   where r.channel_id = p_channel_id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. read_channel_token — the runner's one read, service role only
-- ───────────────────────────────────────────────────────────────────────────
-- No row when the channel has no active connection (never connected, or
-- revoked): the runner then falls back to the channel's GitHub secret, as
-- before this migration.

create or replace function public.read_channel_token(p_channel_id text)
  returns table (
    refresh_token text,
    scopes text[],
    oauth_client_id text,
    youtube_channel_id text,
    connected_at timestamptz
  )
  language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.channel_token_trusted_caller() then
    raise exception 'channel tokens are read by the platform''s runner only' using errcode = '42501';
  end if;
  return query
    select d.decrypted_secret::text, r.scopes, r.oauth_client_id, r.youtube_channel_id, r.connected_at
      from public.channel_token_refs r
      join vault.decrypted_secrets d on d.id = r.vault_secret_id
     where r.channel_id = p_channel_id
       and r.revoked_at is null
       and r.vault_secret_id is not null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.channel_token_allowed_scopes() from public, anon, authenticated, service_role;
revoke all on function public.channel_token_trusted_caller() from public, anon, authenticated, service_role;
revoke all on function public.store_channel_token(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.channel_token_status(text) from public, anon, authenticated, service_role;
revoke all on function public.revoke_channel_token(text) from public, anon, authenticated, service_role;
revoke all on function public.read_channel_token(text) from public, anon, authenticated, service_role;

grant execute on function public.store_channel_token(text, text, jsonb) to authenticated;
grant execute on function public.channel_token_status(text) to authenticated;
grant execute on function public.revoke_channel_token(text) to authenticated, service_role;
grant execute on function public.read_channel_token(text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   to_regclass('public.channel_token_refs') is not null as table_exists,
--   (select relrowsecurity from pg_class where oid = 'public.channel_token_refs'::regclass)
--     as rls_on,
--   (select count(*) from pg_policies
--     where schemaname = 'public' and tablename = 'channel_token_refs') = 0
--     as no_policy_deny_all,
--   not has_table_privilege('authenticated', 'public.channel_token_refs', 'SELECT')
--     and not has_table_privilege('anon', 'public.channel_token_refs', 'SELECT')
--     as no_direct_read,
--   has_function_privilege('authenticated', 'public.store_channel_token(text, text, jsonb)', 'EXECUTE')
--     as store_is_callable_signed_in,
--   not has_function_privilege('anon', 'public.store_channel_token(text, text, jsonb)', 'EXECUTE')
--     as anon_cannot_store,
--   not has_function_privilege('authenticated', 'public.read_channel_token(text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.read_channel_token(text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.read_channel_token(text)', 'EXECUTE')
--     as read_is_service_only,
--   (select bool_and(p.prosecdef and array_to_string(p.proconfig, ',') like 'search_path=%')
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('store_channel_token', 'channel_token_status',
--                         'revoke_channel_token', 'read_channel_token'))
--     as definer_with_pinned_search_path,
--   to_regclass('vault.decrypted_secrets') is not null as vault_enabled;
