-- rollback_0143_country_block_before_sale.sql — takes migration 0143 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- READ THIS FIRST: after it, a model whose registry entry carries blocked_countries can be put on sale (beta or ga) again, while the
-- country check still runs only in the Next.js routes and a signed-in user can reach create_creative_job, start_workflow_run and
-- advance_workflow_run directly (docs/GEO_BLOCK.md "What it cannot do"). Run it only once the database refuses by country itself, or
-- with no such model meant for sale.
--
-- WHAT IT DOES, in one transaction: drops the CHECK model_registry_countries_before_sale. No row is rewritten.
--
-- tests/security/test_sec_country_block.py applies this file to the lab database and re-applies 0143.

begin;
set local lock_timeout = '5s';

alter table public.model_registry drop constraint if exists model_registry_countries_before_sale;

do $$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.model_registry'::regclass and conname = 'model_registry_countries_before_sale') then
    raise exception 'rollback 0143: model_registry_countries_before_sale is still there';
  end if;
end $$;

commit;

-- Verify (should read true):
--   select not exists (select 1 from pg_constraint
--                       where conrelid = 'public.model_registry'::regclass and conname = 'model_registry_countries_before_sale');
