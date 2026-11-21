-- Rollback of 0197_studio_ai_chat.sql (owner-applied, one transaction). It drops every Nightshift AI conversation and the metering:
-- export ai_chat_usage() first if the figures are wanted. Turn the chat off first (NIGHTSHIFT_AI_CHAT=off), or the panel answers
-- "not available here" until the server restarts.

drop function if exists public.ai_chat_usage(date, date);
drop function if exists public.ai_chat_set_limits(integer, integer);
drop function if exists public.ai_chat_quota(uuid);
drop function if exists public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text);
drop function if exists public.ai_chat_reserve_turn(uuid, text);
drop function if exists public.ai_chat_used(uuid);
drop function if exists public.ai_chat_start(uuid, text, text);
drop table if exists public.ai_chat_calls;
drop table if exists public.ai_chat_messages;
drop table if exists public.ai_chat_sessions;
drop table if exists public.ai_chat_limits;

notify pgrst, 'reload schema';
