-- rollback_0183_creative_templates.sql — takes migration 0183 (trend templates) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the creative_templates rows (the ten seeded formats and any edits since). Keep a copy first if they were edited:
--   select * from public.creative_templates order by sort, id;
-- The preview files are app files (command-center/public/templates/) and are not touched. After this, /api/templates answers 503
-- "not_enabled" and the Trends page says it is not available here; nothing else reads the table. Credits, jobs and publishing are
-- unaffected.

begin;
set local lock_timeout = '5s';

drop table if exists public.creative_templates;
drop function if exists public.creative_templates_touch();

do $$
begin
  if to_regclass('public.creative_templates') is not null
     or to_regprocedure('public.creative_templates_touch()') is not null then
    raise exception 'rollback 0183 end state: an 0183 object is still there';
  end if;
end $$;

commit;
