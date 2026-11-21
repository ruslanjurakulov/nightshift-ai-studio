-- 0115_operator_channel_token.sql — the operator's own channels (Chronos, `default`, and the rest of the
-- default organization) can be connected to YouTube from the Command Center, with one button, and keep their
-- refresh token in Supabase Vault like a customer's — no GitHub secret to paste, no "Deploy web".
--
-- WHAT WAS MISSING
--   0022 gave a customer organization's admin a write-only place for the channel's refresh token
--   (store_channel_token -> Vault -> channel_token_refs), and the runner reads it with the service key
--   (read_channel_token). store_channel_token REFUSES the operator's organization on purpose ("the operator's
--   channels keep their token in GitHub Actions secrets"), so the operator's channels could only be connected
--   by pasting a token into a GitHub secret.
--
-- WHAT THIS ADDS (one function; nothing existing is replaced)
--   store_operator_channel_token(channel_id, refresh_token, meta)
--       Signed in AND a platform owner/admin (is_platform_admin(), the same gate the Command Center's
--       requireRole("admin") asks) AND the channel belongs to the operator's own organization
--       (channels.org_id = default_org_id()). Anything else is the one 42501 answer: an unknown channel, a
--       customer's channel, a viewer/editor, anon read the same. Same token / scope / YouTube-channel checks as
--       store_channel_token, same Vault secret and the same channel_token_refs row, so channel_token_status,
--       revoke_channel_token and read_channel_token (service role only) work for it unchanged.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * store_channel_token is NOT touched: it still refuses the operator's organization, and a customer admin
--     still cannot reach an operator channel through it (is_org_member is checked against the channel's own org).
--   * No function returns a token or a Vault id to a browser. read_channel_token is still service role only.
--   * The key is the channel's OWN id, checked against its organization inside the function. A customer's
--     credential_ref.ref is never consulted, so a customer row cannot name an operator channel's token
--     (BR-L-080 / BR-G-002). The runner (modules/channel_tokens.py) reads by the channel's own id too.
--   * channel_stamp_from_connection (0086) still stamps customer channels only; an operator channel's
--     confirmation stays the operator's own (the default channel is exempt from 0005's rule).
--   * Not callable by anon or the service key (a person signs in to connect).
--
-- REQUIRES 0018 (organizations), 0022 (channel_token_refs, Supabase Vault). Additive and idempotent
-- (create or replace, revoke-then-grant); safe to re-run. Rollback: docs/sql/rollback_0115_operator_channel_token.sql.

do $$
begin
  if to_regprocedure('public.is_platform_admin()') is null
     or to_regprocedure('public.default_org_id()') is null then
    raise exception '0115 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.channel_token_refs') is null
     or to_regprocedure('public.channel_token_allowed_scopes()') is null then
    raise exception '0115 needs 0022_channel_tokens.sql (and Supabase Vault): apply it first';
  end if;
end $$;

create or replace function public.store_operator_channel_token(
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
  -- One answer for "no such channel", "a customer's channel" and "not a platform admin": nothing is learned
  -- about another organization's ids, and a customer's admin (an org admin, not on the platform roster) is refused.
  if ch.channel_id is null
     or ch.org_id is distinct from public.default_org_id()
     or not public.is_platform_admin() then
    raise exception 'only the platform owner or an admin may connect an operator channel'
      using errcode = '42501';
  end if;

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
  -- A channel the operator already pinned to a YouTube channel keeps it.
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

  select * into cur from public.channel_token_refs r where r.channel_id = ch.channel_id for update;

  if cur.channel_id is not null and cur.vault_secret_id is not null then
    perform vault.update_secret(cur.vault_secret_id, tok, null,
                                'Nightshift: YouTube refresh token for channel ' || ch.channel_id);
    sid := cur.vault_secret_id;
    reconnected := true;
  else
    sid := vault.create_secret(
      tok,
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

revoke all on function public.store_operator_channel_token(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.store_operator_channel_token(text, text, jsonb) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     has_function_privilege('authenticated', 'public.store_operator_channel_token(text,text,jsonb)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.store_operator_channel_token(text,text,jsonb)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.store_operator_channel_token(text,text,jsonb)', 'EXECUTE')
--       as callable_by_signed_in_only,
--     not has_function_privilege('authenticated', 'public.read_channel_token(text)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.read_channel_token(text)', 'EXECUTE') as read_still_service_only,
--     (select p.prosecdef and array_to_string(p.proconfig, ',') like 'search_path=%'
--        from pg_proc p where p.oid = 'public.store_operator_channel_token(text,text,jsonb)'::regprocedure)
--       as definer_with_pinned_search_path,
--     position('operator''s channels keep their token' in
--              pg_get_functiondef('public.store_channel_token(text,text,jsonb)'::regprocedure)) > 0
--       as customer_function_still_refuses_the_operator_org;
