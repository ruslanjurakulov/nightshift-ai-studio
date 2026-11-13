-- rollback_0162_api_creative_models.sql — takes migration 0162 (the MCP Studio tools' two read-only API functions) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: nothing stored. 0162 added two read-only functions and no table, column, row or grant on anything else. After this,
-- the MCP tools list_models and get_generation answer 503 api_unavailable naming migration 0162; quote_generation and
-- create_generation keep working (they call 0062's api_creative_quote and api_creative_create, which 0162 did not touch).
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if either function is not 0162's body (a later change would be undone).
--   1. Drops both functions.
--   2. Asserts the end state: both are gone.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.api_creative_models(text, text, text)');
  if h is not null and h <> 'c71d2d0fe6e76d5ed2cd8975b8ad73c3' then
    raise exception 'rollback 0162: public.api_creative_models(text, text, text) is not 0162''s body (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.api_creative_job_files(text, uuid, text)');
  if h is not null and h <> '010344fe500657f32873d04f6d666b14' then
    raise exception 'rollback 0162: public.api_creative_job_files(text, uuid, text) is not 0162''s body (md5 %): read the live body first', h;
  end if;
end $$;

drop function if exists public.api_creative_models(text, text, text);
drop function if exists public.api_creative_job_files(text, uuid, text);

do $$
begin
  if to_regprocedure('public.api_creative_models(text, text, text)') is not null
     or to_regprocedure('public.api_creative_job_files(text, uuid, text)') is not null then
    raise exception 'rollback 0162 end state: a function is still there';
  end if;
end $$;

commit;

-- Verify (both columns should read true)
-- select to_regprocedure('public.api_creative_models(text, text, text)') is null as models_gone,
--        to_regprocedure('public.api_creative_job_files(text, uuid, text)') is null as files_gone;
