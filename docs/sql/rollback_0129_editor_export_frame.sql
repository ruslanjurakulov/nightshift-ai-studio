-- rollback_0129_editor_export_frame.sql — takes migration 0129 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app
-- runs it.
--
-- WHEN YOU NEED IT. If an export must stop taking a frame other than the project's own. Turn NIGHTSHIFT_MULTI_RATIO_EXPORT off first (web
-- and worker; the picker disappears and the worker refuses a frame row). The Command Center needs no other change: its three-argument call
-- then gets "function not found" and answers "not available" for that frame, and an export without a frame goes through the two-argument
-- function exactly as before 0129.
--
-- READ THIS FIRST. What is NOT undone: videos already exported in another frame stay in the library (media_assets is never touched), and
-- their export rows stay, as finished exports. What IS lost: the record of WHICH frame each of those rows was asked in (the three columns
-- are dropped). That matters for an export still waiting or rendering, which would then be rendered in the project's own frame, so the
-- file REFUSES while one exists.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if the three-argument request_editor_export() or editor_export_frame() is not 0129's body (a later change
--      would be undone), if the two-argument request_editor_export() is not 0054's body, or if an export that is queued or rendering
--      carries a frame.
--   1. Drops the three-argument request_editor_export() and editor_export_frame().
--   2. Drops the check and the columns editor_exports.frame_preset / frame_width / frame_height.
--   3. Asserts the end state: one request_editor_export() left, 0054's hash, its grants as before 0129.
--
-- tests/security/test_sec_editor_export_frame.py applies this file to a copy of the lab database and re-applies 0129.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.request_editor_export(uuid, integer, text)');
  if h is distinct from 'f928b139368bf2e97ddc4c0e098c8fc2' then
    raise exception 'rollback 0129: the three-argument request_editor_export() is missing or is not 0129''s body (md5 %): a later change would be undone; read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.editor_export_frame(text)');
  if h is distinct from '1bcfdbfab6526ce7d0ba07e167f5740c' then
    raise exception 'rollback 0129: editor_export_frame() is missing or is not 0129''s body (md5 %): a later change would be undone; read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.request_editor_export(uuid, integer)');
  if h is distinct from '6d37b4d75092708981c28a56879c89b4' then
    raise exception 'rollback 0129: the two-argument request_editor_export() is not 0054''s body (md5 %); read the live body first', h;
  end if;
  if exists (select 1 from public.editor_exports where frame_preset is not null and status in ('queued', 'rendering')) then
    raise exception 'rollback 0129: an export in flight carries a frame; wait until it is done or failed, then run this again';
  end if;
end $$;

-- 1. The overload and the closed list.
drop function public.request_editor_export(uuid, integer, text);
drop function public.editor_export_frame(text);

-- 2. The check and the columns (finished rows keep everything else; their files are untouched).
alter table public.editor_exports drop constraint if exists editor_exports_frame_shape;
alter table public.editor_exports
  drop column if exists frame_preset,
  drop column if exists frame_width,
  drop column if exists frame_height;

-- 3. End state.
do $$
declare
  req2 regprocedure := 'public.request_editor_export(uuid, integer)'::regprocedure;
begin
  if (select count(*) from pg_proc where proname = 'request_editor_export' and pronamespace = 'public'::regnamespace) <> 1
     or to_regprocedure('public.editor_export_frame(text)') is not null then
    raise exception 'rollback 0129 end state: a function of 0129 is still there';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req2) <> '6d37b4d75092708981c28a56879c89b4' then
    raise exception 'rollback 0129 end state: the two-argument request_editor_export() is not 0054''s body';
  end if;
  if not (has_function_privilege('authenticated', req2, 'EXECUTE')
          and not has_function_privilege('anon', req2, 'EXECUTE')
          and not has_function_privilege('service_role', req2, 'EXECUTE')) then
    raise exception 'rollback 0129 end state: the two-argument request_editor_export() has the wrong grants';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'editor_exports' and column_name like 'frame\_%') then
    raise exception 'rollback 0129 end state: a frame column is still there';
  end if;
end $$;

commit;
