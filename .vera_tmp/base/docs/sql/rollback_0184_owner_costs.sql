-- rollback_0184_owner_costs.sql — takes migration 0184 (the owner analytics hub's costs) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the owner's monthly cost entries (owner_cost_entries). Keep a copy first if they matter:
--   select * from public.owner_cost_entries order by month, id;
-- The owner's typed balances (owner_manual_balances) are lost too: select * from public.owner_manual_balances;
-- After this, the costs tab says it needs migration 0184; revenue and the rest of the hub (0182) are unaffected.

begin;
set local lock_timeout = '5s';

drop function if exists public.owner_analytics_model_activity(timestamptz, timestamptz);
drop function if exists public.owner_analytics_costs(date, date);
drop function if exists public.owner_analytics_cost_delete(bigint);
drop function if exists public.owner_analytics_cost_add(date, text, numeric, text);
drop function if exists public.owner_analytics_balance_enter(text, text, double precision, text);
drop function if exists public.owner_analytics_balances();
drop function if exists public.owner_analytics_provider_spend(timestamptz, timestamptz);
drop function if exists public.owner_costs_write_guard();
drop table if exists public.owner_cost_entries;
drop table if exists public.owner_manual_balances;

do $$
begin
  if to_regclass('public.owner_cost_entries') is not null
     or to_regprocedure('public.owner_analytics_provider_spend(timestamptz, timestamptz)') is not null then
    raise exception 'rollback 0184 end state: an 0184 object is still there';
  end if;
end $$;

commit;
