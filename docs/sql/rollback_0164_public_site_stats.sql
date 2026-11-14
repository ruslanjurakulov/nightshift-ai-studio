-- rollback_0164_public_site_stats.sql — takes migration 0164 (the site's live public counters and their switch) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the switch's value and the last stored measurement (site_settings). Nothing a customer owns: 0164 only read other
-- tables. The security_events rows a switch change wrote stay (that trail is append-only). After this the site shows no counters
-- (the read is missing, which lib/server/public-stats.ts treats as hidden), exactly as before 0164.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the four functions is not 0164's body (a later change would be undone).
--   1. Unschedules the pg_cron job, if pg_cron exists and the job does.
--   2. Drops the four functions and the table.
--   3. Asserts the end state: all five are gone.

begin;
set local lock_timeout = '5s';

do $$
declare
  pair text[];
  h text;
begin
  foreach pair slice 1 in array array[
      ['public.public_site_stats_measure()', 'e1fa900daf83fb55af871d3e118f8a31'],
      ['public.public_site_stats_refresh()', '022ce0de3feaebde13aadd1432fcc626'],
      ['public.public_site_stats()', 'fe0dfed7b1abb856b161b35d8cfd6abb'],
      ['public.set_public_stats_visible(boolean)', '0b1793721bf2bb7aaad4c0eb248704e6']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is not null and h <> pair[2] then
      raise exception 'rollback 0164: % is not 0164''s body (md5 %): a later change would be undone; read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

do $$
begin
  if to_regprocedure('cron.unschedule(text)') is not null and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-public-site-stats') then
      perform cron.unschedule('nightshift-public-site-stats');
    end if;
  end if;
exception when others then
  raise notice 'rollback 0164: the pg_cron job was not removed (%); remove it by hand: select cron.unschedule(''nightshift-public-site-stats'');', sqlerrm;
end $$;

drop function if exists public.set_public_stats_visible(boolean);
drop function if exists public.public_site_stats();
drop function if exists public.public_site_stats_refresh();
drop function if exists public.public_site_stats_measure();
drop table if exists public.site_settings;

do $$
begin
  if to_regprocedure('public.set_public_stats_visible(boolean)') is not null
     or to_regprocedure('public.public_site_stats()') is not null
     or to_regprocedure('public.public_site_stats_refresh()') is not null
     or to_regprocedure('public.public_site_stats_measure()') is not null
     or to_regclass('public.site_settings') is not null then
    raise exception 'rollback 0164 end state: something of 0164 is still there';
  end if;
end $$;

commit;
