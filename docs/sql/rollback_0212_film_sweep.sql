-- rollback_0212_film_sweep.sql — takes migration 0212 (the recorded film sweep, its status and its pg_cron job) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the record of when each runner last swept (film_sweep_runs). Nothing a customer owns, and no money: 0212 only
-- called 0171's film_expire_segments, which is untouched and stays. After this, .github/workflows/film_sweep.yml fails (film_sweep
-- is missing: disable the workflow, or apply 0212 again), and tools/film_worker.py goes back to calling film_expire_segments
-- directly, unrecorded, as before 0212.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if either function is not 0212's body (a later change would be undone).
--   1. Unschedules the pg_cron job, if pg_cron exists and the job does.
--   2. Drops the two functions and the table.
--   3. Asserts the end state: all three are gone, and film_expire_segments is still there.

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.film_sweep(text)', '10dcda57c382fd7f3f2ed4a32fb62e44'),
      ('public.film_sweep_status()', 'ac6b8f6a210ebb7ad092e1f23b78438c')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception 'rollback 0212: % is not 0212''s body (md5 %): a later change would be undone; read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

do $$
begin
  if to_regprocedure('cron.unschedule(text)') is not null and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-film-sweep') then
      perform cron.unschedule('nightshift-film-sweep');
    end if;
  end if;
exception when others then
  raise notice 'rollback 0212: the pg_cron job was not removed (%); remove it by hand: select cron.unschedule(''nightshift-film-sweep'');', sqlerrm;
end $$;

drop function if exists public.film_sweep_status();
drop function if exists public.film_sweep(text);
drop table if exists public.film_sweep_runs;

do $$
begin
  if to_regprocedure('public.film_sweep(text)') is not null
     or to_regprocedure('public.film_sweep_status()') is not null
     or to_regclass('public.film_sweep_runs') is not null then
    raise exception 'rollback 0212 end state: something of 0212 is still there';
  end if;
  if to_regprocedure('public.film_expire_segments()') is null then
    raise exception 'rollback 0212 end state: film_expire_segments (0171) is missing; it is not 0212''s to drop';
  end if;
end $$;

commit;
