-- rollback_0200_owner_brain_facts.sql — takes migration 0200 (the owner's facts for Nightshift Brain) out again.
-- Two read-only functions; no data is stored by 0200, so nothing is lost. After this, the owner's AI and the Owner Console say
-- that people-and-plans and system health need migration 0200; revenue and providers keep working (0182, 0184).
set local lock_timeout = '5s';

drop function if exists public.owner_brain_health();
drop function if exists public.owner_brain_people();

do $$
begin
  if to_regprocedure('public.owner_brain_people()') is not null or to_regprocedure('public.owner_brain_health()') is not null then
    raise exception 'rollback 0200 end state: an 0200 function is still there';
  end if;
end $$;
