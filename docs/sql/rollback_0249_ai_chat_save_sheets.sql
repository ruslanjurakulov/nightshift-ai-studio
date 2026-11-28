-- Owner-applied rollback of 0249_ai_chat_save_sheets.sql.
-- Drops what 0249 added: the keep-sheets trigger on ai_chat_sessions, its trigger function, ai_chat_save_sheets and the internal
-- ai_chat_sheet_problem. No body of 0199 was replaced, so nothing is put back. The sheets and film links already stored stay in each
-- conversation's BRIEF (they are the person's: approvals and paid pictures' job ids). After this the Command Center finds the
-- function missing (PGRST202) and goes back to #980's behaviour at once: the sheets route re-reads and merges before
-- ai_chat_save_brief, and the turn route carries the stored sheets into every BRIEF it writes (the race 0249 closed reopens).
-- No backslash anywhere in this file.
begin;
set local lock_timeout = '5s';

drop trigger if exists ai_chat_sessions_keep_sheets on public.ai_chat_sessions;
drop function if exists public.ai_chat_sessions_keep_sheets();
drop function if exists public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb);
drop function if exists public.ai_chat_sheet_problem(jsonb);

do $$
begin
  if to_regprocedure('public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)') is not null
     or to_regprocedure('public.ai_chat_sheet_problem(jsonb)') is not null
     or to_regprocedure('public.ai_chat_sessions_keep_sheets()') is not null
     or exists (select 1 from pg_trigger where tgname = 'ai_chat_sessions_keep_sheets') then
    raise exception 'rollback 0249: something of 0249 is still there';
  end if;
  if to_regprocedure('public.ai_chat_save_brief(uuid, jsonb, text)') is null then
    raise exception 'rollback 0249: 0199''s ai_chat_save_brief is missing (it was never 0249''s to drop)';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
