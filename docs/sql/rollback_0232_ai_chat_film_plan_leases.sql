-- rollback_0232_ai_chat_film_plan_leases.sql — takes migration 0232 (one storyboard plan per film, its turns reserved at begin) out.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT COMES BACK, verbatim: ai_chat_reserve_turn and ai_chat_plan_end as 0226 wrote them and ai_chat_quota as 0199 wrote it, with
--   their grants. A plan's turns are again counted as they are taken, with nothing reserved (BR-FILM-03 open again), and two
--   conversations can again plan one film at once (BR-FILM-01/02 open again; the route's own per-person yield stays).
-- WHAT GOES: ai_chat_film_plan_begin, ai_chat_film_plan_max_turns, ai_chat_reserved, ai_chat_reserved_until, ai_chat_reserved_by,
--   ai_chat_reserved_by_until and
--   the ai_chat_film_plan_leases table. Dropped, not kept: it references films, and a kept table would stop 0166's own rollback.
--   Nothing else depends on it (no view, function or foreign key of another file names it). Plans RUNNING when this is applied lose
--   their lease and their reservation at once: their remaining turns are then counted as they are taken, as before 0232, and may meet
--   the cap part-way. Apply it when no storyboard is being written if that matters. Turns, calls, conversations and BRIEFs are 0199's
--   and are kept. The app degrades by itself: without ai_chat_film_plan_begin (PGRST202 / 42883) both routes plan as before 0232 and
--   claim no reservation, and the panel reads no `reserved` from ai_chat_quota (shown as none).
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the three bodies is not 0232's (a later change would be undone).
--   1. Puts the earlier bodies back, verbatim, with their grants.
--   2. Drops what 0232 added.
--   3. Asserts the end state.
--
-- The bodies (md5, whitespace runs read as one space; 0232 -> earlier):
--   ai_chat_reserve_turn   3a54f4b6d57d159d18b5ba8b33e2183b -> e105fa9373fac86e9a36cf4a945a21b4 (0226)
--   ai_chat_plan_end       71c2feb9b1b12295bef680822ab80c91 -> 4df6a1c4054bcacedf971a0b79f997d6 (0226)
--   ai_chat_quota          09b69b04c1073ad8e79bbc8107e92f81 -> 7c17f9749127303a53d039bbdc15e8c2 (0199)
--
-- NO BACKSLASH in this file: ai_chat_reserve_turn's two E'' character lists are written as 0226 writes them, an EXECUTE whose
-- backslashes are a token that replace() turns back into chr(92).

begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.ai_chat_reserve_turn(uuid, text, boolean, text)', '3a54f4b6d57d159d18b5ba8b33e2183b'),
      ('public.ai_chat_plan_end(uuid, integer, text, text)', '71c2feb9b1b12295bef680822ab80c91'),
      ('public.ai_chat_quota(uuid)', '09b69b04c1073ad8e79bbc8107e92f81')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0232: % is not 0232''s body (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- What the panel shows: the plan's cap, what is used, the longest message. A member's own workspace only. `limit` null = no Brain on
-- this plan (the panel shows the upgrade), never 0 read as "used up".
create or replace function public.ai_chat_quota(p_org uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or p_org is null or not public.is_org_member(p_org, 'viewer') then
    perform public.creative_refuse('forbidden', 'not a member of this workspace', 'NS403');
  end if;
  -- The model is the owner's and its id names the vendor: a member gets only a reference the server maps to its own list
  -- (lib/server/brain/session modelFromRef), never the id itself. This keeps the id out of every answer and screen; it is not a secret
  -- against a member who hashes the few public candidate ids: the web server reads as the member (anon key only, CLAUDE.md rule 3),
  -- so nothing it can read is hidden from them (Lens and Breach on 0199).
  return jsonb_build_object('used', public.ai_chat_used(p_org), 'limit', public.ai_chat_cap(p_org),
                            'trial_left', case when public.ai_chat_cap(p_org) is null then public.ai_chat_trial_left(p_org) end,
                            'max_input_chars', (select max_input_chars from public.ai_chat_settings where id),
                            'model_ref', (select md5('nightshift-chat-model:' || model) from public.ai_chat_settings where id));
end
$$;

-- This body holds a backslash. A backslash can be rewritten on its way through an apply tool, so this file holds none:
-- the statement is run through EXECUTE, each backslash spelled <0226:backslash> and turned back into chr(92). Its source is unchanged.
do $bs0226$
begin
  execute replace($fn0226$create or replace function public.ai_chat_reserve_turn(p_session uuid, p_text text, p_retry boolean default false,
                                                      p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  v_max integer;
  v_cap integer;
  v_used integer;
  v_call uuid;
  -- Every whitespace a person can type, not only spaces (Breach: a message of tabs and newlines took a turn), and the invisible ones
  -- (zero-width, word joiner, BOM) removed first, so a message of NBSPs or zero-width spaces is empty (Lens on 0199).
  -- Breach on 0199 added the rest that render as nothing: soft hyphen, joiners, bidi marks, variation selectors, tags, fillers.
  v_text text := btrim(regexp_replace(coalesce(p_text, ''),
                         E'[<0226:backslash>u00AD<0226:backslash>u034F<0226:backslash>u180E<0226:backslash>u200B-<0226:backslash>u200F<0226:backslash>u202A-<0226:backslash>u202E<0226:backslash>u2060-<0226:backslash>u2064<0226:backslash>uFEFF<0226:backslash>uFE00-<0226:backslash>uFE0F<0226:backslash>U000E0000-<0226:backslash>U000E007F]', '', 'g'),
                       E' <0226:backslash>t<0226:backslash>r<0226:backslash>n<0226:backslash>f<0226:backslash>u0085<0226:backslash>u00A0<0226:backslash>u115F<0226:backslash>u1160<0226:backslash>u1680<0226:backslash>u2000<0226:backslash>u2001<0226:backslash>u2002<0226:backslash>u2003<0226:backslash>u2004<0226:backslash>u2005<0226:backslash>u2006<0226:backslash>u2007<0226:backslash>u2008<0226:backslash>u2009<0226:backslash>u200A<0226:backslash>u2028<0226:backslash>u2029<0226:backslash>u202F<0226:backslash>u205F<0226:backslash>u2800<0226:backslash>u3000<0226:backslash>u3164<0226:backslash>uFFA0' || chr(11));
  st public.ai_chat_settings;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  -- 0226 (the owner's decision, 22 Nov; 0215's is_org_spender): spending an organization's credits takes a seat in it. 0043's
  -- accessible_org_ids makes a platform owner or admin an admin of every organization; that stays read-only support access. In the
  -- exempt organization the credits are the platform's own, so its platform owner or admin may, as before. Before the turn is checked, the organization's lock is taken, or the cap or the trial is counted.
  if not public.is_org_spender(s.org_id, 'editor') then
    perform public.creative_refuse('not_a_member', 'you are not an owner, admin or editor member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  if s.step = 'created' then
    perform public.creative_refuse('session_closed', 'this plan was handed off; start a new conversation', 'NS409');
  end if;
  if p_request_id is not null and p_request_id !~ '^[A-Za-z0-9_-]{8,64}$' then
    perform public.creative_refuse('invalid_params', 'a request id is 8 to 64 letters, digits, - or _');
  end if;
  select * into st from public.ai_chat_settings where id;
  v_max := st.max_input_chars;
  if coalesce(p_retry, false) then
    if (select m.role from public.ai_chat_messages m where m.session_id = s.id order by m.id desc limit 1) is distinct from 'user' then
      perform public.creative_refuse('nothing_to_retry', 'the last message was answered', 'NS409');
    end if;
  elsif v_text = '' then
    perform public.creative_refuse('invalid_params', 'say something first');
  end if;
  if char_length(v_text) > coalesce(v_max, 2000) then
    perform public.creative_refuse('message_too_long', format('at most %s characters', coalesce(v_max, 2000)));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_chat:' || s.org_id::text, 0));
  -- The same press again (a network retry): answered as a duplicate, with nothing written (under the lock: two copies racing find
  -- each other, and the unique index is the last word).
  -- The refusal names the conversation the first copy went to: a retried Start finds its own (Lens on 0199).
  if p_request_id is not null and exists (select 1 from public.ai_chat_calls c where c.user_id = v_user and c.request_id = p_request_id) then
    perform public.creative_refuse('duplicate_request',
      coalesce((select c.session_id::text from public.ai_chat_calls c where c.user_id = v_user and c.request_id = p_request_id), ''), 'NS409');
  end if;
  v_cap := public.ai_chat_cap(s.org_id);
  v_used := public.ai_chat_used(s.org_id);
  if v_cap is null then
    -- The lifetime trial, counted under the same workspace lock as the cap (two tabs cannot both take the last one).
    if public.ai_chat_trial_left(s.org_id) = 0 then
      perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
    end if;
  elsif v_cap = 0 then
    perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
  elsif v_used >= v_cap then
    perform public.creative_refuse('chat_daily_cap', format('used=%s limit=%s', v_used, v_cap), 'NS429');
  end if;
  -- The person's own turns everywhere, and the platform's: under their own locks, after the workspace's, always in this order.
  perform pg_advisory_xact_lock(hashtextextended('ai_chat_user:' || v_user::text, 0));
  -- Every outcome counts here, not_sent too: a member can reserve and finish their own calls by hand, and each writes rows
  -- (Lens and Breach on 0199: not_sent passed every cap). The plan cap is the one that forgives what was not their doing.
  if (select count(*) from public.ai_chat_calls c where c.user_id = v_user and c.created_at > now() - interval '24 hours')
     >= st.per_user_daily then
    perform public.creative_refuse('chat_daily_cap', 'your own daily limit across workspaces is reached', 'NS429');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_chat_global', 0));
  if (select count(*) from public.ai_chat_calls c where c.created_at > now() - interval '24 hours') >= st.global_daily then
    perform public.creative_refuse('chat_unavailable', 'Nightshift AI has reached its daily limit; try again later', 'NS503');
  end if;
  if not coalesce(p_retry, false) then
    insert into public.ai_chat_messages (session_id, created_by, role, content) values (s.id, v_user, 'user', v_text);
  end if;
  insert into public.ai_chat_calls (org_id, user_id, session_id, model, request_id)
  values (s.org_id, v_user, s.id, (select model from public.ai_chat_settings where id), p_request_id) returning id into v_call;
  update public.ai_chat_sessions set updated_at = now() where id = s.id;
  return jsonb_build_object('call_id', v_call, 'used', v_used + 1, 'limit', v_cap,
                            'trial_left', case when v_cap is null then public.ai_chat_trial_left(s.org_id) end);
end
$$$fn0226$, '<0226:backslash>', chr(92));
end $bs0226$;

create or replace function public.ai_chat_plan_end(p_session uuid, p_attempt integer, p_state text, p_reason text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.ai_chat_sessions;
  l public.ai_chat_plan_leases;
begin
  s := public.ai_chat_plan_session(p_session);
  -- 0226 (the owner's decision, 22 Nov; 0215's is_org_spender): spending an organization's credits takes a seat in it. 0043's
  -- accessible_org_ids makes a platform owner or admin an admin of every organization; that stays read-only support access. In the
  -- exempt organization the credits are the platform's own, so its platform owner or admin may, as before. ai_chat_plan_session above asks it already (its own hunk); asked again here, where the lease is written, so this
  -- function refuses on its own if that helper ever changes. Before the lease is read or written.
  if not public.is_org_spender(s.org_id, 'editor') then
    perform public.creative_refuse('not_a_member', 'you are not an owner, admin or editor member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  if p_state is null or p_state not in ('failed', 'done') then
    perform public.creative_refuse('invalid_params', 'a plan ends failed or done');
  end if;
  if p_reason is not null and p_reason !~ '^[a-z][a-z0-9_]{0,39}$' then
    perform public.creative_refuse('invalid_params', 'a reason is a short machine word');
  end if;
  select * into l from public.ai_chat_plan_leases where session_id = s.id for update;
  if not found or l.attempt is distinct from p_attempt or l.state <> 'running' then
    perform public.creative_refuse('plan_not_current', 'that plan is no longer the running one', 'NS409');
  end if;
  update public.ai_chat_plan_leases set state = p_state, reason = p_reason, finished_at = now() where session_id = s.id;
end
$$;

revoke all on function public.ai_chat_quota(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_quota(uuid) to authenticated;
revoke all on function public.ai_chat_reserve_turn(uuid, text, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_reserve_turn(uuid, text, boolean, text) to authenticated;
revoke all on function public.ai_chat_plan_end(uuid, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_plan_end(uuid, integer, text, text) to authenticated;

drop function if exists public.ai_chat_film_plan_begin(uuid, uuid, integer);
drop function if exists public.ai_chat_film_plan_max_turns(integer);
drop function if exists public.ai_chat_reserved_by_until(uuid);
drop function if exists public.ai_chat_reserved_by(uuid);
drop function if exists public.ai_chat_reserved_until(uuid);
drop function if exists public.ai_chat_reserved(uuid);
drop table if exists public.ai_chat_film_plan_leases;

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.ai_chat_reserve_turn(uuid, text, boolean, text)', 'e105fa9373fac86e9a36cf4a945a21b4'),
      ('public.ai_chat_plan_end(uuid, integer, text, text)', '4df6a1c4054bcacedf971a0b79f997d6'),
      ('public.ai_chat_quota(uuid)', '7c17f9749127303a53d039bbdc15e8c2')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0232 end state: % is not the earlier body (md5 %)', r.sig, h;
    end if;
  end loop;
  if to_regclass('public.ai_chat_film_plan_leases') is not null
     or to_regprocedure('public.ai_chat_film_plan_begin(uuid, uuid, integer)') is not null
     or to_regprocedure('public.ai_chat_film_plan_max_turns(integer)') is not null
     or to_regprocedure('public.ai_chat_reserved(uuid)') is not null
     or to_regprocedure('public.ai_chat_reserved_until(uuid)') is not null
     or to_regprocedure('public.ai_chat_reserved_by(uuid)') is not null
     or to_regprocedure('public.ai_chat_reserved_by_until(uuid)') is not null then
    raise exception 'rollback 0232 end state: an 0232 object is still there';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
