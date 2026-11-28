-- Owner-applied rollback of 0249_ai_chat_save_sheets.sql.
-- Drops what 0249 added: the keep-sheets trigger on ai_chat_sessions, its trigger function, ai_chat_save_sheets and the internal
-- ai_chat_sheet_problem and ai_chat_sheet_repair; and puts 0199's CHECK on brief back exactly (the whole BRIEF, sheets included,
-- at most 262144 bytes) in place of 0249's (the sheets counted apart), 0199's ai_chat_finish_turn back verbatim and the call outcomes
-- as 0199 had them (a call ended brief_too_large is recorded output_too_long, the closest paid outcome 0199 has).
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

-- 0199's ai_chat_finish_turn back verbatim, and the call outcomes as 0199 had them. A call 0249 ended brief_too_large (paid,
-- answered, its plan not stored) is recorded output_too_long, the closest outcome 0199 has (also paid, also counted).
create or replace function public.ai_chat_finish_turn(p_call uuid, p_outcome text, p_tokens_in integer, p_tokens_out integer,
                                                     p_text text, p_payload jsonb, p_slots jsonb, p_step text,
                                                     p_brief jsonb, p_card jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  c public.ai_chat_calls;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into c from public.ai_chat_calls where id = p_call and user_id = v_user for update;
  if not found or c.outcome <> 'pending' then
    perform public.creative_refuse('call_not_found', 'no such pending turn', 'NS404');
  end if;
  if p_outcome is null or p_outcome not in ('ok', 'vendor_error', 'invalid_output', 'not_configured', 'not_sent', 'vendor_refused',
                                             'refused', 'output_too_long') then
    perform public.creative_refuse('invalid_params', 'unknown outcome');
  end if;
  -- not_sent means no vendor was called: it carries no tokens, and only a call just reserved can be it (a member finishing their own
  -- call by hand gains nothing: the server, not the member, calls the vendor).
  if p_outcome = 'not_sent' and (p_tokens_in is not null or p_tokens_out is not null or c.created_at < now() - interval '2 minutes') then
    perform public.creative_refuse('invalid_params', 'not_sent is a call that never reached the vendor');
  end if;
  update public.ai_chat_calls
     -- An unreported count stays unknown (rule 5: GREATEST would turn NULL into 0), and a count no single turn could reach is
     -- refused rather than stored. The figures are what the server reported, not the vendor's own bill (see ai_chat_usage).
     set outcome = p_outcome,
         tokens_in = case when p_tokens_in is null then null else least(greatest(p_tokens_in, 0), 1000000) end,
         tokens_out = case when p_tokens_out is null then null else least(greatest(p_tokens_out, 0), 100000) end,
         finished_at = now()
   where id = c.id;
  if p_outcome = 'ok' and c.session_id is not null then
    if coalesce(btrim(p_text), '') <> '' then
      insert into public.ai_chat_messages (session_id, created_by, role, content, payload)
      values (c.session_id, c.user_id, 'assistant', left(btrim(p_text), 4000),
              case when jsonb_typeof(p_payload) = 'object' then p_payload end);
    end if;
    -- A handed-off session is never reopened by a turn (the handoff is the person's record of their own Create).
    update public.ai_chat_sessions
       set slots = case when jsonb_typeof(p_slots) = 'object' then p_slots else slots end,
           step = case when p_step in ('asking', 'proposing', 'ready') then p_step else step end,
           brief = case when jsonb_typeof(p_brief) = 'object' then p_brief else brief end,
           card = case when jsonb_typeof(p_card) = 'object' then p_card when p_card is null then null else card end,
           updated_at = now()
     where id = c.session_id and step <> 'created';
  end if;
end
$$;

revoke all on function public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text, jsonb, jsonb) to authenticated;
update public.ai_chat_calls set outcome = 'output_too_long' where outcome = 'brief_too_large';
alter table public.ai_chat_calls drop constraint if exists ai_chat_calls_outcome_check;
alter table public.ai_chat_calls add constraint ai_chat_calls_outcome_check
  check (outcome in ('pending', 'ok', 'vendor_error', 'invalid_output', 'not_configured', 'not_sent', 'vendor_refused', 'refused', 'output_too_long'));

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
  if (select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc p
       where p.oid = to_regprocedure('public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text, jsonb, jsonb)'))
     is distinct from 'b0420b460b7717b7d084f7a9bdc3e809' then
    raise exception 'rollback 0249: ai_chat_finish_turn is not 0199''s body';
  end if;
  if exists (select 1 from pg_constraint where conname = 'ai_chat_calls_outcome_check'
               and pg_get_constraintdef(oid) like '%brief_too_large%') then
    raise exception 'rollback 0249: the call outcomes still name brief_too_large';
  end if;
  if to_regprocedure('public.ai_chat_save_brief(uuid, jsonb, text)') is null then
    raise exception 'rollback 0249: 0199''s ai_chat_save_brief is missing (it was never 0249''s to drop)';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
