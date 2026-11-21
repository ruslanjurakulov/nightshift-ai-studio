-- 0197_studio_ai_chat.sql — the Studio's "Nightshift AI" chat: where its conversations live, the per-workspace daily cap that is
-- checked BEFORE any vendor call is made, and the metering the owner reads. The number is provisional (assigned at merge).
--
-- WHY A MIGRATION. The chat is the Command Center's first call to a text LLM, and every call costs the platform money: the person is
-- not charged for it (Atlas/owner, 2026-11-21), so the only brake is a cap the database enforces. A cap kept in the route alone is a
-- cap until someone calls PostgREST directly, and the counter has to survive two server instances and a retried request.
--
-- WHAT IT ADDS
--   * ai_chat_sessions: one conversation of ONE person, in one workspace, about one channel, with one explicit model. The slots the
--     server has filled so far (length, style, platform, language, audience) and the step it is at ('asking' / 'proposing').
--   * ai_chat_messages: what was said. The person's text and the assistant's text are stored as plain text; the assistant's scenarios
--     (with the BACKEND's price, never the model's) are in `payload`. Visible only to the session's own author (stricter than "the
--     workspace's members": a conversation can hold a person's half-formed ideas, and nobody else asked to read them).
--   * ai_chat_limits: one row, the owner's knobs. per_org_daily (40 to start) and max_input_chars (2000).
--   * ai_chat_calls: one row per turn that was allowed to reach a vendor — who, which workspace, which model, the tokens the vendor
--     reported, how it ended. NO TEXT. Closed to every API role; the owner reads it through ai_chat_usage().
--   * Functions (all SECURITY DEFINER, all asking auth.uid() themselves):
--       ai_chat_start(org, channel, model)          a session, for a member of the channel's own workspace;
--       ai_chat_reserve_turn(session, text)         the cap, under the workspace's lock, then the person's message and a pending call;
--       ai_chat_finish_turn(call, …)                the assistant's message, the tokens, the outcome, the session's slots and step;
--       ai_chat_quota(org)                          used / limit in the last 24 hours, for the panel (a member's own workspace);
--       ai_chat_set_limits(per_org_daily, max_chars) the owner only;
--       ai_chat_usage(from, to)                     the owner only: calls and tokens per day and model.
--
-- NOT CHANGED: every price, hold, credit and create rule. The chat never spends: it hands an approved scenario to the existing
--   Run now form, where the person confirms the backend's price (CLAUDE.md rule 3). Nothing here publishes.
--
-- Undo: docs/sql/rollback_0197_studio_ai_chat.sql (owner-applied; it drops the conversations).

-- APPLY AS ONE TRANSACTION.

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0197 needs is_org_member (0018)';
  end if;
  if to_regprocedure('public.owner_analytics_is_owner()') is null then
    raise exception '0197 needs owner_analytics_is_owner (0182)';
  end if;
  if to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0197 needs creative_refuse (0036)';
  end if;
end $$;

create table if not exists public.ai_chat_limits (
  id               boolean primary key default true check (id),
  per_org_daily    integer not null default 40 check (per_org_daily between 0 and 10000),
  max_input_chars  integer not null default 2000 check (max_input_chars between 100 and 4000),
  updated_by       uuid,
  updated_at       timestamptz not null default now()
);
insert into public.ai_chat_limits (id) values (true) on conflict (id) do nothing;

create table if not exists public.ai_chat_sessions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  channel_id  text not null,
  created_by  uuid not null,
  model       text not null check (model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  slots       jsonb not null default '{}'::jsonb check (jsonb_typeof(slots) = 'object'),
  step        text not null default 'asking' check (step in ('asking', 'proposing')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ai_chat_sessions_author on public.ai_chat_sessions (created_by, updated_at desc);

create table if not exists public.ai_chat_messages (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.ai_chat_sessions (id) on delete cascade,
  -- The session's author, on every row (theirs and the assistant's): what RLS and the lab's isolation tests key on.
  created_by  uuid not null,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null check (char_length(content) between 1 and 4000),
  payload     jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  created_at  timestamptz not null default now()
);
create index if not exists ai_chat_messages_session on public.ai_chat_messages (session_id, id);

create table if not exists public.ai_chat_calls (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null,
  session_id  uuid references public.ai_chat_sessions (id) on delete set null,
  model       text not null,
  tokens_in   integer check (tokens_in is null or tokens_in >= 0),
  tokens_out  integer check (tokens_out is null or tokens_out >= 0),
  outcome     text not null default 'pending' check (outcome in ('pending', 'ok', 'vendor_error', 'invalid_output', 'not_configured')),
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ai_chat_calls_org_day on public.ai_chat_calls (org_id, created_at);

alter table public.ai_chat_limits enable row level security;
alter table public.ai_chat_sessions enable row level security;
alter table public.ai_chat_messages enable row level security;
alter table public.ai_chat_calls enable row level security;
revoke all on table public.ai_chat_limits, public.ai_chat_sessions, public.ai_chat_messages, public.ai_chat_calls
  from public, anon, authenticated, service_role;
-- A person reads their own conversations (and nothing else); every write goes through the functions below.
grant select on table public.ai_chat_sessions, public.ai_chat_messages to authenticated;

drop policy if exists ai_chat_sessions_own on public.ai_chat_sessions;
create policy ai_chat_sessions_own on public.ai_chat_sessions for select to authenticated
  using (created_by = (select auth.uid()) and public.is_org_member(org_id, 'viewer'));
drop policy if exists ai_chat_messages_own on public.ai_chat_messages;
create policy ai_chat_messages_own on public.ai_chat_messages for select to authenticated
  using (created_by = (select auth.uid())
         and exists (select 1 from public.ai_chat_sessions s where s.id = session_id and public.is_org_member(s.org_id, 'viewer')));

-- A session, for a member of the channel's own workspace. The model is only recorded here; which models are offered is the server's
-- answer from sellable_models, and the server refuses an unoffered one before it calls anything.
create or replace function public.ai_chat_start(p_org uuid, p_channel text, p_model text) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_org is null or not public.is_org_member(p_org, 'viewer') then
    perform public.creative_refuse('forbidden', 'not a member of this workspace', 'NS403');
  end if;
  if not exists (select 1 from public.channels c where c.channel_id = p_channel and c.org_id = p_org) then
    perform public.creative_refuse('channel_not_found', 'that channel is not in this workspace', 'NS404');
  end if;
  if coalesce(p_model, '') !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'model must be a model id');
  end if;
  insert into public.ai_chat_sessions (org_id, channel_id, created_by, model)
  values (p_org, p_channel, v_user, p_model) returning id into v_id;
  return v_id;
end
$$;

-- The workspace's turns in the last 24 hours, every outcome counted: a call that failed at the vendor may still have cost money.
create or replace function public.ai_chat_used(p_org uuid) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.ai_chat_calls c where c.org_id = p_org and c.created_at > now() - interval '24 hours'
$$;

-- The cap, then the person's message and a pending call. Under the workspace's own lock, so two tabs (or two servers) cannot both
-- take the last turn. Refused turns write nothing.
create or replace function public.ai_chat_reserve_turn(p_session uuid, p_text text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  lim public.ai_chat_limits;
  v_used integer;
  v_call uuid;
  v_text text := btrim(coalesce(p_text, ''));
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user;
  if not found or not public.is_org_member(s.org_id, 'viewer') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  select * into lim from public.ai_chat_limits where id;
  if v_text = '' then
    perform public.creative_refuse('invalid_params', 'say something first');
  end if;
  if char_length(v_text) > coalesce(lim.max_input_chars, 2000) then
    perform public.creative_refuse('message_too_long', format('at most %s characters', coalesce(lim.max_input_chars, 2000)));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_chat:' || s.org_id::text, 0));
  v_used := public.ai_chat_used(s.org_id);
  if v_used >= coalesce(lim.per_org_daily, 40) then
    perform public.creative_refuse('chat_daily_cap',
      format('used=%s limit=%s', v_used, coalesce(lim.per_org_daily, 40)), 'NS429');
  end if;
  insert into public.ai_chat_messages (session_id, created_by, role, content) values (s.id, v_user, 'user', v_text);
  insert into public.ai_chat_calls (org_id, user_id, session_id, model)
  values (s.org_id, v_user, s.id, s.model) returning id into v_call;
  update public.ai_chat_sessions set updated_at = now() where id = s.id;
  return jsonb_build_object('call_id', v_call, 'used', v_used + 1, 'limit', coalesce(lim.per_org_daily, 40));
end
$$;

-- The end of a turn: the assistant's message (when there is one), the tokens and the outcome, the session's slots and step. Only the
-- person who reserved the call, only once.
create or replace function public.ai_chat_finish_turn(p_call uuid, p_outcome text, p_tokens_in integer, p_tokens_out integer,
                                                     p_text text, p_payload jsonb, p_slots jsonb, p_step text) returns void
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
  if p_outcome not in ('ok', 'vendor_error', 'invalid_output', 'not_configured') then
    perform public.creative_refuse('invalid_params', 'unknown outcome');
  end if;
  update public.ai_chat_calls
     set outcome = p_outcome, tokens_in = greatest(p_tokens_in, 0), tokens_out = greatest(p_tokens_out, 0), finished_at = now()
   where id = c.id;
  if p_outcome = 'ok' and c.session_id is not null then
    if coalesce(btrim(p_text), '') <> '' then
      insert into public.ai_chat_messages (session_id, created_by, role, content, payload)
      values (c.session_id, c.user_id, 'assistant', left(btrim(p_text), 4000),
              case when jsonb_typeof(p_payload) = 'object' then p_payload end);
    end if;
    update public.ai_chat_sessions
       set slots = case when jsonb_typeof(p_slots) = 'object' then p_slots else slots end,
           step = case when p_step in ('asking', 'proposing') then p_step else step end,
           updated_at = now()
     where id = c.session_id;
  end if;
end
$$;

-- What the panel shows: the workspace's turns in the last 24 hours and the cap. A member's own workspace only.
create or replace function public.ai_chat_quota(p_org uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  lim public.ai_chat_limits;
begin
  if auth.uid() is null or p_org is null or not public.is_org_member(p_org, 'viewer') then
    perform public.creative_refuse('forbidden', 'not a member of this workspace', 'NS403');
  end if;
  select * into lim from public.ai_chat_limits where id;
  return jsonb_build_object('used', public.ai_chat_used(p_org), 'limit', coalesce(lim.per_org_daily, 40),
                            'max_input_chars', coalesce(lim.max_input_chars, 2000));
end
$$;

create or replace function public.ai_chat_set_limits(p_per_org_daily integer, p_max_input_chars integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  update public.ai_chat_limits
     set per_org_daily = coalesce(p_per_org_daily, per_org_daily),
         max_input_chars = coalesce(p_max_input_chars, max_input_chars),
         updated_by = auth.uid(), updated_at = now()
   where id;
  return (select jsonb_build_object('per_org_daily', per_org_daily, 'max_input_chars', max_input_chars) from public.ai_chat_limits where id);
end
$$;

-- The owner's reading: turns and tokens per Tashkent day and model. No text, no workspace names; a cost is the owner's own
-- arithmetic on the vendor's published rates, never stored here.
create or replace function public.ai_chat_usage(p_from date, p_to date)
  returns table (day date, model text, turns bigint, ok bigint, failed bigint, tokens_in bigint, tokens_out bigint)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    perform public.creative_refuse('invalid_params', 'a range of at most 400 days');
  end if;
  return query
    select (c.created_at at time zone 'Asia/Tashkent')::date, c.model, count(*),
           count(*) filter (where c.outcome = 'ok'), count(*) filter (where c.outcome <> 'ok' and c.outcome <> 'pending'),
           sum(c.tokens_in)::bigint, sum(c.tokens_out)::bigint
      from public.ai_chat_calls c
     where (c.created_at at time zone 'Asia/Tashkent')::date between p_from and p_to
     group by 1, 2 order by 1, 2;
end
$$;

revoke all on function public.ai_chat_start(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_used(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_reserve_turn(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_quota(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_set_limits(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_usage(date, date) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_start(uuid, text, text) to authenticated;
grant execute on function public.ai_chat_reserve_turn(uuid, text) to authenticated;
grant execute on function public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text) to authenticated;
grant execute on function public.ai_chat_quota(uuid) to authenticated;
grant execute on function public.ai_chat_set_limits(integer, integer) to authenticated;
grant execute on function public.ai_chat_usage(date, date) to authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.ai_chat_calls', 'SELECT')
     or has_table_privilege('authenticated', 'public.ai_chat_messages', 'INSERT')
     or has_table_privilege('authenticated', 'public.ai_chat_sessions', 'UPDATE')
     or has_table_privilege('anon', 'public.ai_chat_sessions', 'SELECT') then
    raise exception '0197 end state: an API role can reach a chat table directly';
  end if;
  if has_function_privilege('anon', 'public.ai_chat_reserve_turn(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ai_chat_used(uuid)', 'EXECUTE') then
    raise exception '0197 end state: a chat function is callable by the wrong role';
  end if;
end $$;

notify pgrst, 'reload schema';

-- Verify (read-only): every column should read true.
-- select (select per_org_daily from public.ai_chat_limits) = 40 as cap_set,
--        not has_table_privilege('authenticated', 'public.ai_chat_calls', 'SELECT') as calls_closed,
--        has_function_privilege('authenticated', 'public.ai_chat_reserve_turn(uuid, text)', 'EXECUTE') as reserve_open;
