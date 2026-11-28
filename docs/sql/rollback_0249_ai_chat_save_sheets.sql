-- Owner-applied rollback of 0249_ai_chat_save_sheets.sql.
-- Drops what 0249 added: the keep-sheets trigger on ai_chat_sessions, its trigger function, ai_chat_save_sheets and the internal
-- ai_chat_sheet_problem and ai_chat_sheet_repair; and puts 0199's CHECK on brief back exactly (the whole BRIEF, sheets included,
-- at most 262144 bytes) in place of 0249's (the sheets counted apart). No body of 0199 was replaced, so no body is put back.
-- The sheets and film links already stored stay in each conversation's BRIEF (they are the person's: approvals and paid pictures'
-- job ids). If a conversation holds more than 262144 bytes with its sheets, 0199's CHECK cannot come back: this file refuses with
-- the count and the remedy, and changes nothing.
-- After this the Command Center finds the function missing (PGRST202) and goes back to #980's behaviour at once: the sheets route
-- re-reads and merges before ai_chat_save_brief, and the turn route carries the stored sheets into every BRIEF it writes (the race
-- 0249 closed reopens).
-- No backslash anywhere in this file.
begin;
set local lock_timeout = '5s';

do $$
declare
  n bigint;
begin
  select count(*) into n from public.ai_chat_sessions where octet_length(brief::text) > 262144;
  if n > 0 then
    raise exception 'rollback 0249: % conversation(s) hold more than 262144 bytes with their sheets, which 0199''s CHECK refuses; trim their ref_sheets by hand (or keep 0249), then run this again', n;
  end if;
end
$$;

drop trigger if exists ai_chat_sessions_keep_sheets on public.ai_chat_sessions;
drop function if exists public.ai_chat_sessions_keep_sheets();
drop function if exists public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb);
drop function if exists public.ai_chat_sheet_problem(jsonb);
drop function if exists public.ai_chat_sheet_repair(jsonb);
alter table public.ai_chat_sessions drop constraint if exists ai_chat_sessions_brief_0249;
alter table public.ai_chat_sessions drop constraint if exists ai_chat_sessions_brief_check;
alter table public.ai_chat_sessions add constraint ai_chat_sessions_brief_check
  check (jsonb_typeof(brief) = 'object' and octet_length(brief::text) <= 262144);

do $$
begin
  if to_regprocedure('public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)') is not null
     or to_regprocedure('public.ai_chat_sheet_problem(jsonb)') is not null
     or to_regprocedure('public.ai_chat_sheet_repair(jsonb)') is not null
     or to_regprocedure('public.ai_chat_sessions_keep_sheets()') is not null
     or exists (select 1 from pg_trigger where tgname = 'ai_chat_sessions_keep_sheets')
     or exists (select 1 from pg_constraint where conname = 'ai_chat_sessions_brief_0249') then
    raise exception 'rollback 0249: something of 0249 is still there';
  end if;
  if (select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = 'public.ai_chat_sessions'::regclass and c.conname = 'ai_chat_sessions_brief_check')
     is distinct from 'CHECK (((jsonb_typeof(brief) = ''object''::text) AND (octet_length((brief)::text) <= 262144)))' then
    raise exception 'rollback 0249: ai_chat_sessions_brief_check is not 0199''s';
  end if;
  if to_regprocedure('public.ai_chat_save_brief(uuid, jsonb, text)') is null then
    raise exception 'rollback 0249: 0199''s ai_chat_save_brief is missing (it was never 0249''s to drop)';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
