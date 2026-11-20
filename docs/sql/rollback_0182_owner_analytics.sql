-- rollback_0182_owner_analytics.sql — takes migration 0182 (the owner analytics hub's reads and export log) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the export log (owner_analytics_exports: who exported which table, when) and the owner's list of internal / test
-- workspaces (owner_analytics_internal_orgs; keep a copy: select * from public.owner_analytics_internal_orgs). Nothing else was stored: 0182's other
-- objects are read-only functions over existing tables. After this, every page of the hub says it needs migration 0182, and
-- exports are refused (an export that cannot be recorded is not produced). Payments, credits and publishing are unaffected.
--
-- Keep a copy of the export log first if it matters:  select * from public.owner_analytics_exports order by created_at;

begin;
set local lock_timeout = '5s';

drop function if exists public.owner_analytics_export_log(integer);
drop function if exists public.owner_analytics_record_export(text, text, timestamptz, timestamptz, boolean);
drop function if exists public.owner_analytics_jobs(timestamptz, timestamptz);
drop function if exists public.owner_analytics_activity(timestamptz, timestamptz);
drop function if exists public.owner_analytics_people();
drop function if exists public.owner_analytics_money(timestamptz, timestamptz);
drop function if exists public.owner_analytics_sales_all();
drop function if exists public.owner_analytics_internal_list();
drop function if exists public.owner_analytics_set_internal(uuid, boolean, text);
drop function if exists public.owner_analytics_internal_org_ids();
drop function if exists public.owner_analytics_is_owner();
drop table if exists public.owner_analytics_exports;
drop table if exists public.owner_analytics_internal_orgs;

do $$
begin
  if to_regprocedure('public.owner_analytics_money(timestamptz, timestamptz)') is not null
     or to_regclass('public.owner_analytics_exports') is not null then
    raise exception 'rollback 0182 end state: an 0182 object is still there';
  end if;
end $$;

commit;
