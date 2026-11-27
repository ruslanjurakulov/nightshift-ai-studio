-- rollback_0211_ai_chat_plan_leases.sql — takes migration 0211 (one storyboard plan at a time per Nightshift AI conversation) out.
-- Dropping the table forgets which plans were running; nothing else is lost (the conversations, turns and BRIEFs are 0199's).
-- After this, POST /api/brain/turn `choose` on a short outline answers `plan_unavailable` and writes no storyboard (it never plans
-- without a lease); proposing, long videos and re-reading an already planned draft keep working.
set local lock_timeout = '5s';

drop function if exists public.ai_chat_plan_state(uuid);
drop function if exists public.ai_chat_plan_end(uuid, integer, text, text);
drop function if exists public.ai_chat_plan_begin(uuid, bigint, integer);
drop function if exists public.ai_chat_plan_session(uuid);
drop table if exists public.ai_chat_plan_leases;

do $$
begin
  if to_regclass('public.ai_chat_plan_leases') is not null
     or to_regprocedure('public.ai_chat_plan_begin(uuid,bigint,integer)') is not null
     or to_regprocedure('public.ai_chat_plan_end(uuid,integer,text,text)') is not null
     or to_regprocedure('public.ai_chat_plan_state(uuid)') is not null
     or to_regprocedure('public.ai_chat_plan_session(uuid)') is not null then
    raise exception 'rollback 0211 end state: an 0211 object is still there';
  end if;
end $$;
