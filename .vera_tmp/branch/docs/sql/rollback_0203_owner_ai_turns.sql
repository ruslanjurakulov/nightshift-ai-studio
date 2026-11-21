-- rollback_0203_owner_ai_turns.sql — takes migration 0203 (the owner's Nightshift AI turn log and cap) out again.
-- The table holds only who asked, when, the model, the outcome and counts (never a question or an answer); dropping it loses
-- that history. After this, /api/brain/owner/turn answers that the owner AI needs migration 0203, and calls no model.
set local lock_timeout = '5s';

drop function if exists public.owner_ai_finish_turn(bigint, boolean, text, integer, integer);
drop function if exists public.owner_ai_reserve_turn(integer, text);
drop table if exists public.owner_ai_turns;

do $$
begin
  if to_regclass('public.owner_ai_turns') is not null
     or to_regprocedure('public.owner_ai_reserve_turn(integer,text)') is not null
     or to_regprocedure('public.owner_ai_finish_turn(bigint,boolean,text,integer,integer)') is not null then
    raise exception 'rollback 0203 end state: an 0203 object is still there';
  end if;
end $$;
