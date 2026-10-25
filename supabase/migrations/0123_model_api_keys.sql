-- 0123_model_api_keys.sql — the owner's API key per model vendor, verified against the vendor and kept in Supabase Vault
-- (docs/MODEL_API_KEYS.md). DORMANT: nothing in the app calls these functions unless the server switch NIGHTSHIFT_MODEL_KEYS is `on`.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it automatically, and an applied migration is never
-- *** edited: fix by a new forward migration. It needs an independent security review BEFORE it is applied (docs/MODEL_API_KEYS.md,
-- *** "What the reviewer must verify").
--
-- NUMBER. 0123. The highest on main is 0121 (0113 and 0118 are unused). 0122 is taken by the branch claude/series-template-carrier
-- (0122_series_template_carrier.sql, no pull request open when this was written, 2026-10-25), so this file does not use it. No open pull
-- request adds a migration (gh api, 2026-10-25).
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. The lock_timeout below is
-- `set local`, and a half-applied file (the table without its policy, the functions without their revokes) is not a state anyone designed
-- for. Every statement is create-if-not-exists, create-or-replace, revoke or grant: a replay changes nothing.
--
-- WHAT IT ADDS
--   model_api_key_status  one row per vendor that has a stored key: provider (a closed set, model_key_provider_ok), status
--                         (`verified` = the vendor answered a free, non-generating request with the key and accepted it; `format_only` =
--                         the vendor has no free endpoint we could verify and the owner saved the key after confirming that), last4 (the
--                         last four characters of the key, the one fragment the owner asked to see), verified_at, checked_by,
--                         checked_by_email. RLS on, ONE select policy (the platform OWNER, not merely an admin), no write privilege for any
--                         API role: only the definer functions below write it.
--   model_api_key_refs    provider -> the Vault secret's id. RLS on, NO policy, every privilege revoked from every API role (deny-all, as
--                         channel_token_refs in 0022): nobody reads the Vault id through the API, in any role.
--   owner_model_key_store(provider, secret, status)
--                         the platform OWNER only. Creates or replaces the Vault secret and the status row, in the caller's transaction,
--                         and writes an audit row (action `secret.write`, detail: provider, status, store `vault`; never the key, never
--                         last4). Returns {ok, provider, status} or a refusal document; never the key, never the Vault id.
--   owner_model_key_remove(provider)
--                         the platform OWNER only. Overwrites the Vault secret with random text, deletes it, deletes both rows, audits it.
--   owner_model_key_status()
--                         the platform OWNER only. {ok, keys: [{provider, status, last4, verified_at, checked_by_email}]}.
--   model_key_provider_ok(text), model_key_owner_gate(text)
--                         internal (no API role may execute them).
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * No function returns a key, or a Vault id, to anyone. There is NO read function for the key at all: not for the owner, not for the
--     service role. The workers keep reading their keys from the environment exactly as today; letting them read Vault is a separate,
--     separately reviewed change (docs/MODEL_API_KEYS.md, "Follow-up: workers reading Vault").
--   * It cannot verify a key against a vendor. The Command Center route does that (a free request to a fixed vendor host) BEFORE it calls
--     owner_model_key_store, and passes the status it found. The database only guarantees WHO may store, that the value is one printable token,
--     and that every store and removal is audited. A compromised owner session could therefore store an unverified key as `verified`; the owner
--     is the owner, and the audit row records who did it and when.
--   * It replaces NO existing function, trigger, policy or table (audit_action_allowed is NOT touched: the existing action `secret.write`
--     is reused, with detail.store = `vault`, so no drift guard is needed and no other migration's body is changed).
--   * It rewrites no row of any existing table, other than the audit rows it adds itself.
--
-- A key reaches the database as an argument of a function call. A validation refusal is therefore RETURNED as a document (ok=false), never
-- raised, so an expected failure does not write the statement and its parameters to the Postgres error log. An unexpected failure (Vault
-- unavailable, a lock timeout) still raises; whether the project's logs record statement parameters on error is part of what the reviewer
-- must check (docs/MODEL_API_KEYS.md).
--
-- REQUIRES 0007/0033/0043 (app_members, is_platform_admin, platform_role, my_confirmed_email), 0008/0087 (app_audit_log), 0107 (owner_guard,
-- owner_audit, owner_err), and Supabase Vault (the supabase_vault extension: Dashboard -> Database -> Extensions -> "vault"). It stops with
-- the remedy if one is missing.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.app_members') is null or to_regclass('public.app_audit_log') is null then
    raise exception '0123 needs the roster and the audit trail: apply 0007, 0008 and 0087 first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null or to_regprocedure('public.platform_role()') is null
     or to_regprocedure('public.my_confirmed_email()') is null then
    raise exception '0123 needs 0018 / 0043 (is_platform_admin, platform_role, my_confirmed_email): apply them first';
  end if;
  if to_regprocedure('public.owner_guard(text, integer)') is null or to_regprocedure('public.owner_audit(text, text, jsonb, text)') is null
     or to_regprocedure('public.owner_err(text, text, jsonb)') is null then
    raise exception '0123 needs 0107_owner_safety.sql (owner_guard, owner_audit, owner_err): apply it first';
  end if;
  if to_regprocedure('public.audit_action_allowed(text)') is null or not public.audit_action_allowed('secret.write') then
    raise exception '0123 reuses the audit action secret.write, which audit_action_allowed() does not allow here: read the live body first';
  end if;
  if to_regprocedure('vault.create_secret(text, text, text, uuid)') is null
     or to_regprocedure('vault.update_secret(uuid, text, text, text, uuid)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception '0123 needs Supabase Vault: enable the "vault" extension (Dashboard -> Database -> Extensions -> supabase_vault), then run this file again';
  end if;
  -- A function of one of these names with another argument list would become an overload next to ours. Nothing of the kind is expected.
  if exists (
    select 1 from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and ((p.proname = 'owner_model_key_store' and p.oid <> coalesce(to_regprocedure('public.owner_model_key_store(text, text, text)'), 0::oid))
         or (p.proname = 'owner_model_key_remove' and p.oid <> coalesce(to_regprocedure('public.owner_model_key_remove(text)'), 0::oid))
         or (p.proname = 'owner_model_key_status' and p.oid <> coalesce(to_regprocedure('public.owner_model_key_status()'), 0::oid))
         or (p.proname = 'model_key_provider_ok' and p.oid <> coalesce(to_regprocedure('public.model_key_provider_ok(text)'), 0::oid))
         or (p.proname = 'model_key_owner_gate' and p.oid <> coalesce(to_regprocedure('public.model_key_owner_gate(text)'), 0::oid)))
  ) then
    raise exception '0123 found a function of one of its names with another signature: read the live schema first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The closed set of vendors
-- ───────────────────────────────────────────────────────────────────────────

-- The SAME list is MODEL_KEY_PROVIDER_IDS in command-center/lib/model-keys.ts (command-center/tests/model-keys-registry.test.ts compares
-- them from the two files). A vendor is added by a new migration that replaces this function and the CHECK below, never by data.
create or replace function public.model_key_provider_ok(p text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p, '') = any (array[
    'alibaba', 'assemblyai', 'bfl', 'bytedance', 'elevenlabs', 'google', 'ideogram', 'kling', 'luma', 'minimax', 'openai', 'runway', 'xai'
  ]::text[])
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.model_api_key_refs (
  provider        text primary key check (public.model_key_provider_ok(provider)),
  -- The Vault secret holding the key. Never selected by any API role.
  vault_secret_id uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.model_api_key_refs is
  'The Vault secret id of each vendor key the owner stored (migration 0123). No API role has any privilege on it and it has no policy; written only by owner_model_key_store / owner_model_key_remove.';

create table if not exists public.model_api_key_status (
  provider         text primary key check (public.model_key_provider_ok(provider)),
  -- verified: the vendor accepted the key on a free request. format_only: no free endpoint exists; the owner confirmed the weaker claim.
  status           text not null check (status in ('verified', 'format_only')),
  -- The last four characters of the key (display only, to the owner).
  last4            text not null check (last4 ~ '^[\x21-\x7e]{4}$'),
  verified_at      timestamptz not null default now(),
  checked_by       uuid not null,
  checked_by_email text check (checked_by_email is null or char_length(checked_by_email) <= 320),
  updated_at       timestamptz not null default now()
);

comment on table public.model_api_key_status is
  'Which vendors have a stored key, how it was checked, when, and its last four characters (migration 0123). The platform owner reads it (one select policy); nobody writes it except owner_model_key_store / owner_model_key_remove.';

alter table public.model_api_key_refs enable row level security;
alter table public.model_api_key_status enable row level security;

-- Deny-all, with no policy as the second lock, should a privilege ever be granted by mistake.
revoke all on public.model_api_key_refs from public, anon, authenticated, service_role;
revoke all on public.model_api_key_status from public, anon, authenticated, service_role;

drop policy if exists model_api_key_status_select on public.model_api_key_status;
create policy model_api_key_status_select on public.model_api_key_status
  for select to authenticated using ((select public.platform_role()) = 'owner');

grant select on public.model_api_key_status to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The front door of the three owner functions
-- ───────────────────────────────────────────────────────────────────────────

-- Signed in and a platform owner/admin (42501 otherwise, as everywhere in this schema), then the OWNER (an admin is refused with a
-- document), then, for the two writers, the second factor and the per-person rate limit of 0107's owner_guard.
-- Returns null to go on, or the refusal document to hand back.
create or replace function public.model_key_owner_gate(p_action text) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  g jsonb;
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'only the platform owner may do this' using errcode = '42501';
  end if;
  if public.platform_role() is distinct from 'owner' then
    return public.owner_err('owner_required', 'Only the platform owner can store or remove a vendor key.');
  end if;
  if p_action is not null then
    g := public.owner_guard(p_action, 20);
    if g is not null then return g; end if;
  end if;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. owner_model_key_store — create or replace the key of one vendor
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_model_key_store(p_provider text, p_secret text, p_status text) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  g        jsonb;
  cur      public.model_api_key_refs;
  sid      uuid;
  replaced boolean := false;
  me       uuid := auth.uid();
begin
  g := public.model_key_owner_gate('model_key');
  if g is not null then return g; end if;

  if not public.model_key_provider_ok(p_provider) then
    return public.owner_err('unknown_provider', 'That vendor is not in the list.');
  end if;
  if p_status is null or p_status not in ('verified', 'format_only') then
    return public.owner_err('bad_status', 'The status must be verified or format_only.');
  end if;
  -- One printable token: no whitespace, no control character, and nothing a deploy file or a shell reads as syntax ($ ` " ' \).
  -- Refused with a document that says nothing about the value.
  if p_secret is null or char_length(p_secret) not between 16 and 512 or p_secret !~ '^[\x21-\x7e]+$' or p_secret ~ '[$`"''\\]' then
    return public.owner_err('bad_key', 'That is not a key shape this page stores.');
  end if;

  -- One writer per vendor at a time.
  perform pg_advisory_xact_lock(hashtext('nightshift.model_key'), hashtext(p_provider));

  select * into cur from public.model_api_key_refs r where r.provider = p_provider for update;
  -- A reference whose secret was deleted by hand is not an error to carry forever: a new secret replaces it.
  if cur.provider is not null and exists (select 1 from vault.secrets v where v.id = cur.vault_secret_id) then
    perform vault.update_secret(cur.vault_secret_id, p_secret, null, 'Nightshift: ' || p_provider || ' API key');
    sid := cur.vault_secret_id;
    replaced := true;
  else
    sid := vault.create_secret(
      p_secret,
      -- Unique per storing, so a secret left behind by a removal that could not delete it never blocks the next one.
      'nightshift_model_key:' || p_provider || ':' || gen_random_uuid()::text,
      'Nightshift: ' || p_provider || ' API key');
  end if;

  insert into public.model_api_key_refs as r (provider, vault_secret_id, created_at, updated_at)
  values (p_provider, sid, now(), now())
  on conflict (provider) do update set vault_secret_id = excluded.vault_secret_id, updated_at = now();

  insert into public.model_api_key_status as s (provider, status, last4, verified_at, checked_by, checked_by_email, updated_at)
  values (p_provider, p_status, right(p_secret, 4), now(), me, public.my_confirmed_email(), now())
  on conflict (provider) do update set
    status           = excluded.status,
    last4            = excluded.last4,
    verified_at      = excluded.verified_at,
    checked_by       = excluded.checked_by,
    checked_by_email = excluded.checked_by_email,
    updated_at       = now();

  -- The audit row names the vendor and how it was checked. Never the key, never its last four characters.
  perform public.owner_audit('secret.write', p_provider,
    jsonb_build_object('store', 'vault', 'op', case when replaced then 'replace' else 'store' end,
                       'provider', p_provider, 'status', p_status), 'notice');

  return jsonb_build_object('ok', true, 'provider', p_provider, 'status', p_status, 'replaced', replaced);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. owner_model_key_remove — destroy the key of one vendor
-- ───────────────────────────────────────────────────────────────────────────

-- The secret is overwritten first and then deleted, so even where Vault's table refuses the delete the key is gone (as 0022).
create or replace function public.owner_model_key_remove(p_provider text) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  g   jsonb;
  cur public.model_api_key_refs;
  had boolean;
begin
  g := public.model_key_owner_gate('model_key');
  if g is not null then return g; end if;

  if not public.model_key_provider_ok(p_provider) then
    return public.owner_err('unknown_provider', 'That vendor is not in the list.');
  end if;

  perform pg_advisory_xact_lock(hashtext('nightshift.model_key'), hashtext(p_provider));

  select * into cur from public.model_api_key_refs r where r.provider = p_provider for update;
  had := cur.provider is not null or exists (select 1 from public.model_api_key_status s where s.provider = p_provider);
  if not had then
    return jsonb_build_object('ok', true, 'provider', p_provider, 'removed', false);
  end if;

  if cur.provider is not null and exists (select 1 from vault.secrets v where v.id = cur.vault_secret_id) then
    perform vault.update_secret(cur.vault_secret_id, gen_random_uuid()::text || gen_random_uuid()::text, null, 'removed');
    begin
      delete from vault.secrets s where s.id = cur.vault_secret_id;
    exception when insufficient_privilege then
      null;  -- overwritten above; the reference is deleted below either way
    end;
  end if;
  delete from public.model_api_key_refs r where r.provider = p_provider;
  delete from public.model_api_key_status s where s.provider = p_provider;

  perform public.owner_audit('secret.write', p_provider,
    jsonb_build_object('store', 'vault', 'op', 'remove', 'provider', p_provider), 'notice');

  return jsonb_build_object('ok', true, 'provider', p_provider, 'removed', true);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. owner_model_key_status — what the page shows
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.owner_model_key_status() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  g jsonb;
begin
  g := public.model_key_owner_gate(null);
  if g is not null then return g; end if;
  return jsonb_build_object('ok', true, 'keys', coalesce((
    select jsonb_agg(jsonb_build_object(
             'provider', s.provider, 'status', s.status, 'last4', s.last4,
             'verified_at', s.verified_at, 'checked_by_email', s.checked_by_email) order by s.provider)
      from public.model_api_key_status s), '[]'::jsonb));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.model_key_provider_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.model_key_owner_gate(text) from public, anon, authenticated, service_role;
revoke all on function public.owner_model_key_store(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_model_key_remove(text) from public, anon, authenticated, service_role;
revoke all on function public.owner_model_key_status() from public, anon, authenticated, service_role;

-- Signed-in callers; each function refuses everyone but the platform owner itself. service_role is deliberately NOT granted anything here.
grant execute on function public.owner_model_key_store(text, text, text) to authenticated;
grant execute on function public.owner_model_key_remove(text) to authenticated;
grant execute on function public.owner_model_key_status() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor on the live project after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select relrowsecurity from pg_class where oid = 'public.model_api_key_status'::regclass)
--       and (select relrowsecurity from pg_class where oid = 'public.model_api_key_refs'::regclass) as rls_on,
--     (select count(*) from pg_policies where schemaname = 'public' and tablename = 'model_api_key_refs') = 0 as refs_has_no_policy,
--     (select count(*) from pg_policies where schemaname = 'public' and tablename = 'model_api_key_status') = 1 as status_has_one_policy,
--     not has_table_privilege('anon', 'public.model_api_key_status', 'SELECT')
--       and not has_table_privilege('authenticated', 'public.model_api_key_refs', 'SELECT')
--       and not has_table_privilege('service_role', 'public.model_api_key_refs', 'SELECT')
--       and not has_table_privilege('authenticated', 'public.model_api_key_status', 'INSERT')
--       and not has_table_privilege('authenticated', 'public.model_api_key_status', 'UPDATE')
--       and not has_table_privilege('authenticated', 'public.model_api_key_status', 'DELETE') as tables_closed,
--     has_function_privilege('authenticated', 'public.owner_model_key_store(text,text,text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.owner_model_key_store(text,text,text)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.owner_model_key_store(text,text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.model_key_owner_gate(text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.model_key_provider_ok(text)', 'EXECUTE') as functions_scoped,
--     (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))
--        from pg_proc p where p.pronamespace = 'public'::regnamespace
--         and p.proname in ('owner_model_key_store', 'owner_model_key_remove', 'owner_model_key_status', 'model_key_owner_gate')) as definer_pins_search_path;
