-- rollback_0141_youtube_channel_one_org.sql — takes migration 0141 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the
-- app runs it.
--
-- WHEN YOU NEED IT. If the one-organization rule refuses a connection it should not. Afterwards a YouTube channel can again be connected
-- under several organizations at once, exactly as before 0141.
--
-- WHAT IT DOES, in one transaction:
--   1. Refuses to run if one of 0141's three functions is not 0141's body (something redefined it since: dropping it would silently undo
--      that change). Compared as md5 of the body with every run of white space read as one space.
--   2. Drops the two triggers (channel_token_refs_one_org on channel_token_refs, channels_youtube_one_org on channels) and the three
--      functions (channel_token_refs_one_org(), channels_youtube_one_org(), youtube_channel_one_org_check(text, uuid, text[])).
-- 0141 replaced no existing function, altered no table and rewrote no row, so there is no earlier body to put back: every other object
-- is exactly as 0141 found it (its drift guard pinned them, and tests/security/test_sec_youtube_one_org.py compares the whole catalogue
-- before 0141 and after this file). Connections made while 0141 was in place stay as they are.
-- DROP TRIGGER takes an ACCESS EXCLUSIVE lock on each table for the instant of the drop: lock_timeout keeps it from queueing behind a
-- long transaction.

begin;
set local lock_timeout = '5s';

do $$
declare
  r   record;
  got text;
begin
  for r in
    select * from (values
      ('public.youtube_channel_one_org_check(text, uuid, text[])', '8a63db3a3ba1c4d82913a73143ee7ac1'),
      ('public.channel_token_refs_one_org()', 'af871aaa21f80887949ffb58cb04e1ac'),
      ('public.channels_youtube_one_org()', '86f8bc74da482ad80177cf54484d0bd6')
    ) v(sig, want)
  loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = to_regprocedure(r.sig);
    if got is not null and got <> r.want then
      raise exception 'rollback 0141 found a % that is not 0141''s body (md5 %): read the live body first', r.sig, got;
    end if;
  end loop;
end $$;

drop trigger if exists channel_token_refs_one_org on public.channel_token_refs;
drop trigger if exists channels_youtube_one_org on public.channels;
drop function if exists public.channel_token_refs_one_org();
drop function if exists public.channels_youtube_one_org();
drop function if exists public.youtube_channel_one_org_check(text, uuid, text[]);

commit;

-- Verify (every column should read true):
--   select to_regprocedure('public.youtube_channel_one_org_check(text, uuid, text[])') is null as check_gone,
--          to_regprocedure('public.channel_token_refs_one_org()') is null
--            and to_regprocedure('public.channels_youtube_one_org()') is null as trigger_functions_gone,
--          not exists (select 1 from pg_trigger where tgname in ('channel_token_refs_one_org', 'channels_youtube_one_org')) as triggers_gone;
