-- rollback_0151_model_probe_seconds.sql — takes migration 0151 (the probe seed of the Studio's "~N%") out again. OWNER-APPLY: paste
-- into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: nothing stored. 0151 added one read-only function and no table, column, row or grant on anything else. After this, a
-- model with fewer than 3 finished jobs in a workspace shows the seconds since the job started again (the Command Center reads the
-- missing function as "no seed").
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if public.model_probe_seconds(text[]) is not 0151's body (a later change would be undone).
--   1. Drops the function.
--   2. Asserts the end state: it is gone.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.model_probe_seconds(text[])');
  if h is not null and h <> '1a05990e1840630725b4b8dd87a13b20' then
    raise exception 'rollback 0151: public.model_probe_seconds(text[]) is not 0151''s body (md5 %): a later change would be undone; read the live body first', h;
  end if;
end $$;

drop function if exists public.model_probe_seconds(text[]);

do $$
begin
  if to_regprocedure('public.model_probe_seconds(text[])') is not null then
    raise exception 'rollback 0151 end state: public.model_probe_seconds(text[]) is still there';
  end if;
end $$;

commit;
