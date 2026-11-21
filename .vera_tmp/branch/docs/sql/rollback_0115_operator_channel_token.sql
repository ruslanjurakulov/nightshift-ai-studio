-- rollback_0115_operator_channel_token.sql — takes migration 0115 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHAT IT DOES, in one transaction: drops store_operator_channel_token(text, text, jsonb). The Command Center then
-- falls back to the GitHub-secret write for the operator's channels, exactly as before 0115.
--
-- WHAT IT KEEPS ON PURPOSE. A connection already made (a channel_token_refs row and its Vault secret) stays, and the
-- runner keeps preferring it over the GitHub secret. To remove the operator's stored token as well, disconnect it first
-- (select public.revoke_channel_token('default'); as a platform admin or the SQL editor), then run this file.
--
-- tests/security/test_sec_operator_channel_token.py applies this file to the lab database and then re-applies 0115.

begin;
set local lock_timeout = '5s';

drop function if exists public.store_operator_channel_token(text, text, jsonb);

commit;

-- Verify (every column should read true):
--   select to_regprocedure('public.store_operator_channel_token(text,text,jsonb)') is null as function_gone,
--          to_regprocedure('public.store_channel_token(text,text,jsonb)') is not null as customer_function_untouched;
