-- 0040_api_keys_no_prefix.sql — API keys keep no part of the key.
--
-- WHY
--   0031 stored, for each API key, "the first 8 characters of its random
--   part" (api_keys.prefix) and showed it as `nsk_live_AbCd1234…`. Those 8
--   characters are not the constant `nsk_live_` marker: they are 8 of the 43
--   random base62 characters the key's secrecy rests on. CLAUDE.md
--   non-negotiable #1 forbids storing or showing any part of a secret, "not
--   its prefix". The same fragment was also copied into app_audit_log (every
--   API call's audit row, key creation and revocation) and returned by
--   GET /v1/me.
--
-- WHAT CHANGES
--   * api_keys.prefix is emptied for every existing key and can hold nothing
--     from now on (NOT NULL dropped, CHECK (prefix is null)); signed-in users
--     can no longer select it. The column itself is kept (always null) so a
--     re-run of 0031 — whose grant names the column — still applies cleanly.
--   * Keys are told apart by what is not secret: their name (label), their id,
--     when they were created and when they were last used.
--   * create_api_key(uuid, text, text, text, bigint) — which took the
--     fragment — is dropped; create_api_key(uuid, text, text, bigint) takes
--     only the key's SHA-256. An old browser still sending p_prefix gets
--     "function not found", never a stored fragment.
--   * api_begin() no longer puts the fragment in the request context,
--     api_audit() / revoke_api_key() no longer write it to app_audit_log, and
--     api_auth() (GET /v1/me) returns the key's id and name instead.
--   * The fragment is removed from app_audit_log rows 0031 already wrote
--     (detail.api_key_prefix, and detail.prefix of api_key.create /
--     api_key.revoke). Only that key is removed; every other field of those
--     rows is unchanged.
--
-- NOT CHANGED: the key format (nsk_live_ + 43 base62), the SHA-256 lookup,
-- who may create / revoke / use a key, limits, prices, grants to anon.
--
-- REQUIRES 0031. Idempotent: every statement can run again.

do $$
begin
  if to_regclass('public.api_keys') is null
     or to_regprocedure('public.api_finish(jsonb,jsonb,bigint)') is null then
    raise exception '0040 needs the public API: apply 0031_public_api.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The stored fragment: emptied, and never storable again
-- ───────────────────────────────────────────────────────────────────────────

alter table public.api_keys drop constraint if exists api_keys_prefix_check;
alter table public.api_keys alter column prefix drop not null;
update public.api_keys set prefix = null where prefix is not null;
alter table public.api_keys drop constraint if exists api_keys_prefix_retired;
alter table public.api_keys add constraint api_keys_prefix_retired check (prefix is null);
comment on column public.api_keys.prefix is
  'Retired by 0040: always null. 0031 kept 8 random characters of the key here; no part of a key is stored.';
comment on table public.api_keys is
  'API keys (migrations 0031, 0040). Only the SHA-256 of a key is stored — no part of the key itself. Keys are told apart by name, id, created_at and last_used_at. A key acts as its creator inside its organization; revoked_at set = refused.';

revoke select (prefix) on public.api_keys from authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. What 0031 already copied into the audit trail
-- ───────────────────────────────────────────────────────────────────────────

update public.app_audit_log set detail = detail - 'api_key_prefix'
 where detail ? 'api_key_prefix';
update public.app_audit_log set detail = detail - 'prefix'
 where action in ('api_key.create', 'api_key.revoke') and detail ? 'prefix';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Functions that carried the fragment
-- ───────────────────────────────────────────────────────────────────────────

-- api_begin: 0031's body, less the fragment in the context.
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
    'rpm', lim.rpm, 'concurrency', lim.concurrency,
    'cap_cents', case when v_exempt then null
                      else least(lim.monthly_cap_cents, coalesce(s.monthly_limit_cents, lim.monthly_cap_cents)) end,
    'key_limit_cents', k.monthly_limit_cents,
    'remaining', greatest(0, lim.rpm - v_used), 'reset', v_reset,
    'endpoint', coalesce(p_endpoint, 'unknown'), 'request_id', p_request_id);

  if v_used > lim.rpm then
    return public.api_finish(ctx, public.api_err(429, 'rate_limit_exceeded',
      format('This key is limited to %s requests per minute on usage tier %s.', lim.rpm, v_tier),
      jsonb_build_object('retry_after', v_reset)));
  end if;

  perform public.api_act_as(k.created_by);
  if not public.is_org_member(k.org_id, 'admin') then
    return public.api_finish(ctx, public.api_err(403, 'key_owner_not_admin',
      'The person who created this key is no longer an owner or admin of its organization. An admin must create a new key.'));
  end if;

  update public.api_keys set last_used_at = now()
   where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return ctx;
end
$$;

-- One audit row, as the key's creator (0008). The key's id only.
create or replace function public.api_audit(p_ctx jsonb, p_action text, p_target text, p_channel text, p_detail jsonb)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail, channel_id)
  values ((p_ctx ->> 'created_by')::uuid, nullif(auth.jwt() ->> 'email', ''), p_action, p_target,
          coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('via', 'api', 'api_key_id', p_ctx ->> 'key_id'),
          p_channel);
end
$$;

-- The key is generated in the admin's browser; only its SHA-256 arrives here.
drop function if exists public.create_api_key(uuid, text, text, text, bigint);
create or replace function public.create_api_key(
  p_org uuid, p_name text, p_key_hash text, p_monthly_limit_cents bigint default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_name   text := btrim(coalesce(p_name, ''));
  v_active integer;
  k        public.api_keys;
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin of this organization may create API keys' using errcode = '42501';
  end if;
  if not exists (select 1 from public.api_settings where org_id = p_org and activated_at is not null) then
    raise exception 'activate the API first' using errcode = 'NS403';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'name the key (1 to 60 characters)' using errcode = '22023';
  end if;
  if coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'malformed key hash' using errcode = '22023';
  end if;
  if p_monthly_limit_cents is not null and (p_monthly_limit_cents < 0 or p_monthly_limit_cents > 100000000) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  -- Two tabs creating the eleventh key at once: one waits for the other.
  perform pg_advisory_xact_lock(hashtextextended('api_keys:' || p_org::text, 0));
  select count(*) into v_active from public.api_keys where org_id = p_org and revoked_at is null;
  if v_active >= 10 then
    raise exception 'this organization already has 10 active API keys; revoke one first' using errcode = 'NS409';
  end if;
  insert into public.api_keys (org_id, name, key_hash, monthly_limit_cents, created_by)
  values (p_org, v_name, p_key_hash, p_monthly_limit_cents, auth.uid())
  returning * into k;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.create', k.id::text,
          jsonb_build_object('org_id', p_org, 'name', v_name));
  return jsonb_build_object('id', k.id, 'name', k.name, 'created_at', k.created_at);
end
$$;

create or replace function public.revoke_api_key(p_key_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k public.api_keys;
begin
  select * into k from public.api_keys where id = p_key_id;
  if k.id is null or auth.uid() is null or not public.is_org_member(k.org_id, 'admin') then
    raise exception 'only an owner or admin of the key''s organization may revoke it' using errcode = '42501';
  end if;
  update public.api_keys set revoked_at = now(), revoked_by = auth.uid()
   where id = p_key_id and revoked_at is null;
  if not found then
    return false;
  end if;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.revoke', k.id::text,
          jsonb_build_object('org_id', k.org_id, 'name', k.name));
  return true;
end
$$;

-- GET /v1/me: the key is named by its id and its label.
create or replace function public.api_auth(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'me', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  return public.api_finish(ctx, public.api_ok(jsonb_build_object(
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name)
                       from public.organizations o where o.id = (ctx ->> 'org_id')::uuid),
    'key', (select jsonb_build_object('id', k.id, 'name', k.name)
              from public.api_keys k where k.id = (ctx ->> 'key_id')::uuid),
    'tier', (ctx ->> 'tier')::int,
    'limits', jsonb_build_object('requests_per_minute', (ctx ->> 'rpm')::int,
                                 'concurrent_videos', (ctx ->> 'concurrency')::int,
                                 'monthly_limit_cents', (ctx ->> 'cap_cents')::bigint,
                                 'key_monthly_limit_cents', (ctx ->> 'key_limit_cents')::bigint))));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Grants (as 0031: internal helpers to nobody, console to authenticated,
--    entry points to anon)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.api_begin(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_audit(jsonb, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.create_api_key(uuid, text, text, bigint) from public, anon, service_role;
revoke all on function public.revoke_api_key(uuid) from public, anon, service_role;
revoke all on function public.api_auth(text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_api_key(uuid, text, text, bigint) to authenticated;
grant execute on function public.revoke_api_key(uuid) to authenticated;
grant execute on function public.api_auth(text, text) to anon;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   not exists (select 1 from public.api_keys where prefix is not null) as no_stored_fragment,
--   not has_column_privilege('authenticated', 'public.api_keys', 'prefix', 'SELECT') as fragment_not_readable,
--   not has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'SELECT') as hash_never_readable,
--   not exists (select 1 from public.app_audit_log
--                where detail ? 'api_key_prefix'
--                   or (action in ('api_key.create', 'api_key.revoke') and detail ? 'prefix')) as audit_scrubbed,
--   to_regprocedure('public.create_api_key(uuid,text,text,text,bigint)') is null as old_create_gone,
--   has_function_privilege('authenticated', 'public.create_api_key(uuid,text,text,bigint)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.create_api_key(uuid,text,text,bigint)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.api_begin(text,text,text)', 'EXECUTE')
--     and has_function_privilege('anon', 'public.api_auth(text,text)', 'EXECUTE') as grants_narrow,
--   position('prefix' in pg_get_functiondef('public.api_begin(text,text,text)'::regprocedure)) = 0
--     and position('prefix' in pg_get_functiondef('public.api_audit(jsonb,text,text,text,jsonb)'::regprocedure)) = 0
--     and position('prefix' in pg_get_functiondef('public.api_auth(text,text)'::regprocedure)) = 0
--     and position('prefix' in pg_get_functiondef('public.revoke_api_key(uuid)'::regprocedure)) = 0 as functions_clean,
--   (public.api_begin(repeat('0', 64), 'me', null) -> 'error' ->> 'code') = 'invalid_api_key' as unknown_key_refused;
