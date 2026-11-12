-- rollback_0135_character_studio.sql — takes migration 0135 (Character Studio) out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If Character Studio's tables and functions must be withdrawn. To only STOP swaps, take both models off sale (no deploy,
-- nothing lost):   update public.character_swap_models set credits_per_usd = null;   To only HIDE the studio, switch
-- NIGHTSHIFT_CHARACTER_STUDIO off (the page, the routes and the worker then do nothing).
--
-- READ THIS FIRST: 0135 replaced nothing, so there is no earlier body to put back; this file only DROPS what 0135 added. Jobs and consents
-- are things people asked for and declared (a job may have been paid for, a consent is evidence), and a sample cost a paid call, so the
-- file REFUSES (changes nothing) while any of those three tables holds a row, or while a job is still requested or running (its hold would
-- be left open and a vendor task may be running), unless you say in the same transaction that the rows may go:
--     set local nightshift.character_swap_rollback_delete_rows = 'yes';
-- (right after `begin;` below; a job in flight still refuses: let the worker finish it, or fail it with fail_character_swap first). Copy
-- the rows out first, the consent trail above all:   select * from public.character_swap_consents; select * from public.character_swap_jobs;
-- Outputs the worker stored stay in the media library (they are labelled AI-made there), and the samples' files stay in their buckets. No
-- credit moves: a captured job stays captured. The security_events rows of the settings trail stay.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES if a function of 0135 does not hold 0135's body (a later migration changed it), if a job is in flight, or if a table holds a
--      row people made and the line above was not set. A function that is already gone is skipped (a second run changes nothing).
--   1. Drops the eight callable functions.  2. Drops the six tables.  3. Drops the twelve internal functions.  4. Asserts nothing is left.
--
-- tests/security/test_sec_character_swap.py applies this file to the lab database inside a transaction and re-applies 0135.

begin;
set local lock_timeout = '5s';

do $$
declare
  r    record;
  got  text;
  t    text;
  n    bigint;
  rows bigint := 0;
begin
  for r in
    select * from (values
      ('public.character_swap_prompt_patterns()', '56d65ed5c0f40fe8cba6322ab1a008f6'),
      ('public.character_swap_norm(text)', '77daf6b06c31903d7749e128ea7d6e6c'),
      ('public.character_swap_prompt_problem(text)', 'f04a84afb9fb9e24163f55405d71de99'),
      ('public.character_swap_declarations_problem(jsonb)', '754abba4458f3102ec111ba6685e9e99'),
      ('public.character_swap_settings_guard()', 'a6d0eef455902fdeb530a2292d1f50b2'),
      ('public.character_swap_settings_trail()', 'ea80decbe4672917d765a966c2259c3a'),
      ('public.character_swap_append_only()', '304d7d15844f07c1cb5821dd473c22ff'),
      ('public.character_swap_charge(text, text, numeric)', 'a7fb5589674ddc84898810769d594c6f'),
      ('public.character_swap_hold(numeric)', '0c4cc9d1627fd3bf0a2bc07f348465c7'),
      ('public.character_swap_input_problem(uuid, text, uuid, uuid[])', '82bddbc3d809fdb5d886669634f017c9'),
      ('public.character_swap_end_locked(uuid, text, text)', '053cd01eb5919a57974f207459a3b0aa'),
      ('public.character_swap_sweep(uuid)', '8c9a1bc2f944692aebb21e9d2ae70b30'),
      ('public.quote_character_swap(uuid, uuid, text)', 'd08810be5286a526885183d2b7bfb030'),
      ('public.record_character_swap_consent(uuid, text, uuid, uuid[], jsonb, text)', '228dfbc6e7c7d7005f83fd8f341f22ce'),
      ('public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text)', '8b25050c082a66baf873ff871380ebc3'),
      ('public.cancel_character_swap(uuid)', '2f4b3fdc5aea42e39dffa3f3f701b412'),
      ('public.claim_character_swap(text)', '1645d8eec46cd4af9a4e00ca12d082e4'),
      ('public.record_character_swap_task(uuid, text, text)', 'a1238623579e2c1a8c2f9a8ae6536e4b'),
      ('public.finish_character_swap(uuid, text, uuid)', '552621b43552e9fc6992eb10a2bd1c3b'),
      ('public.fail_character_swap(uuid, text, text)', 'c094ba98581dc1e95ba17d364b5e1551')
    ) v(sig, want)
  loop
    select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into got from pg_proc where oid = to_regprocedure(r.sig);
    if got is not null and got <> r.want then
      raise exception 'rollback 0135: % is not 0135''s body (md5 %): a later change would be undone; read the live body first', r.sig, got;
    end if;
  end loop;
  if to_regclass('public.character_swap_jobs') is not null then
    execute 'select count(*) from public.character_swap_jobs where status in (''requested'', ''running'')' into n;
    if n > 0 then
      raise exception 'rollback 0135: a character swap is still requested or running (its credit hold is open); let it finish or fail it first';
    end if;
  end if;
  foreach t in array array['character_swap_jobs', 'character_swap_consents', 'character_swap_template_samples'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      rows := rows + n;
    end if;
  end loop;
  if rows > 0 and coalesce(current_setting('nightshift.character_swap_rollback_delete_rows', true), '') <> 'yes' then
    raise exception 'rollback 0135: the character studio tables hold % row(s) that people made or paid for; copy them out, then set local nightshift.character_swap_rollback_delete_rows = ''yes'' in this transaction to delete them', rows;
  end if;
end $$;

-- 1. The functions an API role could call.
drop function if exists public.quote_character_swap(uuid, uuid, text);
drop function if exists public.record_character_swap_consent(uuid, text, uuid, uuid[], jsonb, text);
drop function if exists public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text);
drop function if exists public.cancel_character_swap(uuid);
drop function if exists public.claim_character_swap(text);
drop function if exists public.record_character_swap_task(uuid, text, text);
drop function if exists public.finish_character_swap(uuid, text, uuid);
drop function if exists public.fail_character_swap(uuid, text, text);

-- 2. The tables (children first; no cascade). The consent trail and the settings rows refuse DELETE and TRUNCATE (their triggers); DROP
-- TABLE is neither, and takes the triggers with it.
drop table if exists public.character_swap_template_samples;
drop table if exists public.character_swap_templates;
drop table if exists public.character_swap_jobs;
drop table if exists public.character_swap_consents;
drop table if exists public.character_swap_settings;
drop table if exists public.character_swap_models;

-- 3. The internal functions (nothing uses them now).
drop function if exists public.character_swap_sweep(uuid);
drop function if exists public.character_swap_end_locked(uuid, text, text);
drop function if exists public.character_swap_input_problem(uuid, text, uuid, uuid[]);
drop function if exists public.character_swap_hold(numeric);
drop function if exists public.character_swap_charge(text, text, numeric);
drop function if exists public.character_swap_append_only();
drop function if exists public.character_swap_settings_trail();
drop function if exists public.character_swap_settings_guard();
drop function if exists public.character_swap_declarations_problem(jsonb);
drop function if exists public.character_swap_prompt_problem(text);
drop function if exists public.character_swap_norm(text);
drop function if exists public.character_swap_prompt_patterns();

-- 4. The end state.
do $$
begin
  if exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'character\_swap\_%') then
    raise exception 'rollback 0135 end state: a table of 0135 is still there';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%character\_swap%') then
    raise exception 'rollback 0135 end state: a function of 0135 is still there';
  end if;
end $$;

commit;
