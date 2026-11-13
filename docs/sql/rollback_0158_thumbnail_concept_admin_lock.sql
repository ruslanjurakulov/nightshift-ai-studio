-- rollback_0158_thumbnail_concept_admin_lock.sql — takes migration 0158 out again. OWNER-APPLY: paste into the Supabase
-- SQL editor. Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the lock refuses a write you want to allow. After it, any editor who can write a channel's
-- agent_config can again set thumbnail_mode and thumbnail_concept (switch a channel to paid concept thumbnails on the
-- worker's provider keys, pick the model, allow faces or baked words). A row that carries either key keeps it either way.
--
-- WHAT IT DOES, in one transaction:
--   1. Drops the channels_thumbnail_concept_guard trigger and its function (nothing else calls it).
--   2. Puts channel_admin_controls() back to 0086's four keys, so create_channel() no longer holds the two keys.
--
-- CHECK BEFORE YOU RUN IT: if a later migration has redefined channel_admin_controls(), step 2 would undo that change:
--     select public.channel_admin_controls();
-- It should read 0158's six keys and nothing else.
--
-- tests/security/test_sec_thumbnail_concept_lock.py applies this file to the lab database and re-applies 0158.

begin;
set local lock_timeout = '5s';

drop trigger if exists channels_thumbnail_concept_guard on public.channels;
drop function if exists public.channels_thumbnail_concept_guard();

-- 0086's body.
create or replace function public.channel_admin_controls() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['publish_gate', 'require_two_person_publish', 'storyboard_review', 'auto_publish']::text[]
$$;

revoke all on function public.channel_admin_controls() from public, anon, authenticated, service_role;

commit;
