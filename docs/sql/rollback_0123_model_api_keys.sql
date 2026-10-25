-- rollback_0123_model_api_keys.sql — takes migration 0123 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the vendor-key store misbehaves or the review finds a hole in it. Switch the server switch NIGHTSHIFT_MODEL_KEYS off first
-- (the page and the route then answer "off" and 404), then run this.
-- READ THIS FIRST: it DESTROYS every vendor key stored in Vault through this feature (the Vault secrets are overwritten with random text and
-- deleted), and the status table with it. Nothing else reads those keys (the workers read their keys from the environment), so no run is
-- affected; the owner pastes the keys again when the feature comes back. The audit rows the feature wrote (action `secret.write`, detail.store
-- `vault`) stay: the audit trail is append-only.
--
-- WHAT IT DOES, in one transaction:
--   1. Overwrites and deletes the Vault secret of every row of model_api_key_refs.
--   2. Drops the policy, the three owner functions and the two helpers, then the two tables.
-- It replaces and restores no function body (0123 replaced none), so there is no drift guard to compare.
--
-- tests/security/test_sec_model_api_keys.py applies this file to the lab database and re-applies 0123.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
begin
  if to_regclass('public.model_api_key_refs') is not null then
    for r in select vault_secret_id from public.model_api_key_refs loop
      perform vault.update_secret(r.vault_secret_id, gen_random_uuid()::text || gen_random_uuid()::text, null, 'removed');
      begin
        delete from vault.secrets s where s.id = r.vault_secret_id;
      exception when insufficient_privilege then
        null;  -- overwritten above
      end;
    end loop;
  end if;
end $$;

drop function if exists public.owner_model_key_store(text, text, text);
drop function if exists public.owner_model_key_remove(text);
drop function if exists public.owner_model_key_status();
drop function if exists public.model_key_owner_gate(text);

drop policy if exists model_api_key_status_select on public.model_api_key_status;
drop table if exists public.model_api_key_status;
drop table if exists public.model_api_key_refs;

-- The CHECK constraints of the two tables used this function; it goes last.
drop function if exists public.model_key_provider_ok(text);

commit;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     to_regclass('public.model_api_key_status') is null and to_regclass('public.model_api_key_refs') is null as tables_gone,
--     to_regprocedure('public.owner_model_key_store(text,text,text)') is null
--       and to_regprocedure('public.owner_model_key_remove(text)') is null
--       and to_regprocedure('public.owner_model_key_status()') is null
--       and to_regprocedure('public.model_key_owner_gate(text)') is null
--       and to_regprocedure('public.model_key_provider_ok(text)') is null as functions_gone,
--     not exists (select 1 from vault.secrets where name like 'nightshift_model_key:%') as no_vault_secret_left;
