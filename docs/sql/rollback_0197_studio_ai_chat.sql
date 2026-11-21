-- Rollback of 0197_studio_ai_chat.sql (owner-applied, one transaction). It drops every Nightshift AI conversation, its BRIEF and the
-- metering: export ai_chat_usage() first if the figures are wanted. Turn the panel off first (NIGHTSHIFT_AI_CHAT=off), or it answers
-- "not set up on this database" until the server restarts. Films a person created from a BRIEF are films like any other: they stay.

drop function if exists public.ai_chat_owner_settings();
drop function if exists public.ai_chat_usage(date, date);
drop function if exists public.ai_chat_set_limits(integer, integer, integer, integer);
drop function if exists public.ai_chat_set_plan_cap(text, integer);
drop function if exists public.ai_chat_set_model(text);
drop function if exists public.ai_chat_quota(uuid);
drop function if exists public.ai_chat_record_handoff(uuid, jsonb);
drop function if exists public.ai_chat_save_brief(uuid, jsonb, text);
drop function if exists public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text, jsonb, jsonb);
drop function if exists public.ai_chat_reserve_turn(uuid, text, boolean);
drop function if exists public.ai_chat_start(uuid, text);
drop function if exists public.ai_chat_used(uuid);
drop function if exists public.ai_chat_cap(uuid);
drop function if exists public.ai_chat_trial_left(uuid);
drop function if exists public.ai_chat_set_pilot(uuid, boolean);
drop table if exists public.ai_chat_calls;
drop table if exists public.ai_chat_messages;
drop table if exists public.ai_chat_sessions;
drop table if exists public.ai_chat_plan_caps;
drop table if exists public.ai_chat_pilot_orgs;
drop table if exists public.ai_chat_settings;

notify pgrst, 'reload schema';
