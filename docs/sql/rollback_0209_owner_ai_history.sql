-- rollback_0209_owner_ai_history.sql — takes migration 0209 (the owner's Nightshift AI conversation history) out again.
-- Dropping the tables DELETES the owner's stored conversations (questions and answers); export them first if they are wanted.
-- After this, /api/brain/owner/turn still answers (0203 is untouched) and reports the history as needing migration 0209.
-- Also removes the functions of the earlier, never-merged 0209 draft (free append/create, soft delete) if a lab database has them.
set local lock_timeout = '5s';

drop function if exists public.owner_ai_session_delete(uuid);
drop function if exists public.owner_ai_session_rename(uuid, text);
drop function if exists public.owner_ai_turn_save(bigint, uuid, text, text, timestamptz, text);
drop function if exists public.owner_ai_message_append(uuid, text, text, timestamptz, text);
drop function if exists public.owner_ai_session_messages(uuid);
drop function if exists public.owner_ai_session_list(integer, timestamptz, uuid);
drop function if exists public.owner_ai_session_list(integer, timestamptz);
drop function if exists public.owner_ai_session_create(text);
drop table if exists public.owner_ai_messages;
drop table if exists public.owner_ai_sessions;

do $$
begin
  if to_regclass('public.owner_ai_messages') is not null
     or to_regclass('public.owner_ai_sessions') is not null
     or to_regprocedure('public.owner_ai_turn_save(bigint,uuid,text,text,timestamptz,text)') is not null
     or to_regprocedure('public.owner_ai_session_create(text)') is not null
     or to_regprocedure('public.owner_ai_session_list(integer,timestamptz,uuid)') is not null
     or to_regprocedure('public.owner_ai_session_list(integer,timestamptz)') is not null
     or to_regprocedure('public.owner_ai_session_messages(uuid)') is not null
     or to_regprocedure('public.owner_ai_message_append(uuid,text,text,timestamptz,text)') is not null
     or to_regprocedure('public.owner_ai_session_rename(uuid,text)') is not null
     or to_regprocedure('public.owner_ai_session_delete(uuid)') is not null then
    raise exception 'rollback 0209 end state: an 0209 object is still there';
  end if;
end $$;
