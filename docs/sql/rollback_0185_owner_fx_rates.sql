-- rollback_0185_owner_fx_rates.sql — takes migration 0185 (the owner's frozen exchange rates) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
-- WHAT IS LOST: the frozen rates (keep a copy: select * from public.owner_fx_rates order by rate_date, currency). After this
-- the income register lists payments in their own currency and says UZS needs migration 0185.
begin;
set local lock_timeout = '5s';
drop function if exists public.owner_analytics_fx_rates(date, date);
drop function if exists public.owner_analytics_fx_delete(date, text);
drop function if exists public.owner_analytics_fx_set(date, text, numeric, text);
drop table if exists public.owner_fx_rates;
do $$
begin
  if to_regclass('public.owner_fx_rates') is not null then
    raise exception 'rollback 0185 end state: owner_fx_rates is still there';
  end if;
end $$;
commit;
