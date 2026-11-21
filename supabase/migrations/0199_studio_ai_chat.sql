-- 0199_studio_ai_chat.sql — Nightshift AI (the Studio's assistant; its server side is "Nightshift Brain", docs/studio/NIGHTSHIFT_AI.md):
-- where its conversations and their BRIEF live, who may use it and how much, the model the owner chose, and the metering the owner
-- reads. Number 0199, assigned at merge (after 0198, the film switch per organization).
--
-- WHY A MIGRATION. The Brain is the Command Center's first call to a text LLM, and every call costs the platform money: the person is
-- not charged for it (the owner's decision, 2026-11-21), so the only brakes are who may use it (paid plans) and a daily cap per
-- workspace by plan. A cap kept in the route alone is a cap until someone calls PostgREST directly, and the counter has to survive two
-- server instances and a retried request.
--
-- WHAT IT ADDS
--   * ai_chat_sessions: one conversation of ONE person, in one workspace (and, for a long video, one channel). The server's slots, the
--     step it is at, the BRIEF so far (the JSON the canvas draws, docs/studio/NIGHTSHIFT_AI.md), the open question card, and — after
--     the person's Create — the handoff (a film id, or a channel run). Visible only to its author.
--   * ai_chat_messages: what was said, plain text, the author's own; the assistant's server-built extras in `payload`.
--   * ai_chat_settings: one row, the owner's knobs: the model the Brain runs (customers never pick one), the longest message.
--   * ai_chat_plan_caps: the daily message cap per plan (creator = Plus 30, pro = Pro 100, studio = Business 300). A plan without a
--     row (free) has no Nightshift AI; the operator's own workspace (credits_exempt) uses Business's cap.
--   * ai_chat_calls: one row per turn allowed to reach a vendor: who, which workspace, which model, the tokens reported, how it ended.
--     NO TEXT. Closed to every API role; the owner reads it through ai_chat_usage().
--   * Functions (SECURITY DEFINER, each asking auth.uid() itself):
--       ai_chat_start(org, channel)                  a session, for a member of a workspace on a plan that has the Brain;
--       ai_chat_reserve_turn(session, text)          the plan's cap, under the workspace's lock, then the message and a pending call;
--       ai_chat_finish_turn(call, …)                 the assistant's message, tokens, outcome, slots, step, BRIEF and card — once;
--       ai_chat_save_brief(session, brief, step)      the person's choice of a proposed scenario, stored as their draft BRIEF;
--       ai_chat_record_handoff(session, handoff)     the author's own record of what their Create opened (never starts anything);
--       ai_chat_quota(org)                           plan, used, limit, the longest message — for the panel;
--       ai_chat_set_model / ai_chat_set_plan_cap / ai_chat_set_limits      the owner only;
--       ai_chat_usage(from, to)                      the owner only: turns and tokens per day and model;
--       ai_chat_used(org), ai_chat_cap(org)          internal.
--
-- NOT CHANGED: every price, hold, credit, create, film and publish rule. The Brain never spends: a long video opens the existing
--   Run now form; a short one is saved as a film DRAFT (create_film_draft / save_film, 0166) and priced and started only by the
--   person through the film routes (quote_film / start_film, 0171). Nothing here publishes.
--
-- Undo: docs/sql/rollback_0199_studio_ai_chat.sql (owner-applied; it drops the conversations).

-- APPLY AS ONE TRANSACTION.

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0199 needs is_org_member (0018)';
  end if;
  if to_regprocedure('public.owner_analytics_is_owner()') is null then
    raise exception '0199 needs owner_analytics_is_owner (0182)';
  end if;
  if to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0199 needs creative_refuse (0036)';
  end if;
  if to_regprocedure('public.org_plan_internal(uuid)') is null or to_regprocedure('public.credits_exempt(uuid)') is null then
    raise exception '0199 needs org_plan_internal (0034) and credits_exempt (0020)';
  end if;
end $$;

create table if not exists public.ai_chat_settings (
  id               boolean primary key default true check (id),
  model            text not null default 'anthropic-claude-sonnet-5-5' check (model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  max_input_chars  integer not null default 2000 check (max_input_chars between 100 and 4000),
  -- Beyond the plan's cap per workspace (Breach on 0199: one account can belong to several workspaces): a person's own turns across
  -- every workspace, and the whole platform's, in a rolling 24 hours. The last brake on the platform's LLM spend.
  per_user_daily   integer not null default 300 check (per_user_daily between 0 and 100000),
  global_daily     integer not null default 5000 check (global_daily between 0 and 1000000),
  sessions_per_user_daily integer not null default 50 check (sessions_per_user_daily between 0 and 10000),
  -- A workspace on a plan without the Brain (free) gets this many messages in its whole life, then the upgrade (the owner,
  -- 2026-11-21): enough to see questions and a priced scenario. Creating anything still needs the normal paid path.
  trial_messages   integer not null default 3 check (trial_messages between 0 and 100),
  updated_by       uuid,
  updated_at       timestamptz not null default now()
);
insert into public.ai_chat_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.ai_chat_plan_caps (
  plan_id     text primary key references public.plans (id) on delete cascade,
  per_day     integer not null check (per_day between 0 and 10000),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
-- Plus 30, Pro 100, Business 300 (the owner, 2026-11-21). Only plans that exist get a row; free gets none.
insert into public.ai_chat_plan_caps (plan_id, per_day)
select v.plan_id, v.per_day from (values ('creator', 30), ('pro', 100), ('studio', 300)) v(plan_id, per_day)
 where exists (select 1 from public.plans p where p.id = v.plan_id)
on conflict (plan_id) do nothing;

-- Workspaces the owner pilots the Brain in (the demo and his own): Business's cap whatever their plan, while they are listed. The
-- owner lists one with ai_chat_set_pilot(); no workspace id is written in this file.
create table if not exists public.ai_chat_pilot_orgs (
  org_id      uuid primary key references public.organizations (id) on delete cascade,
  added_by    uuid,
  added_at    timestamptz not null default now()
);

create table if not exists public.ai_chat_sessions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  channel_id  text,
  created_by  uuid not null,
  model       text not null check (model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  slots       jsonb not null default '{}'::jsonb check (jsonb_typeof(slots) = 'object' and octet_length(slots::text) <= 4096),
  step        text not null default 'asking' check (step in ('asking', 'proposing', 'ready', 'created')),
  brief       jsonb not null default '{}'::jsonb check (jsonb_typeof(brief) = 'object' and octet_length(brief::text) <= 262144),
  card        jsonb check (card is null or (jsonb_typeof(card) = 'object' and octet_length(card::text) <= 8192)),
  handoff     jsonb check (handoff is null or jsonb_typeof(handoff) = 'object'),
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
  payload     jsonb check (payload is null or (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 131072)),
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
  -- not_sent: failed before any vendor call. vendor_refused / refused: the vendor's or the plan's own safety refusal. The paid plan's
  -- daily cap forgives all three (and not_configured); the Free trial and the per-person and platform caps count every outcome.
  outcome     text not null default 'pending' check (outcome in ('pending', 'ok', 'vendor_error', 'invalid_output', 'not_configured',
                                                            'not_sent', 'vendor_refused', 'refused', 'output_too_long')),
  -- The browser's id for one press: a network retry of the same press is refused as a duplicate, never a second message or turn.
  request_id  text check (request_id is null or request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ai_chat_calls_org_day on public.ai_chat_calls (org_id, created_at);
create unique index if not exists ai_chat_calls_request on public.ai_chat_calls (user_id, request_id) where request_id is not null;

alter table public.ai_chat_settings enable row level security;
alter table public.ai_chat_plan_caps enable row level security;
alter table public.ai_chat_pilot_orgs enable row level security;
alter table public.ai_chat_sessions enable row level security;
alter table public.ai_chat_messages enable row level security;
alter table public.ai_chat_calls enable row level security;
revoke all on table public.ai_chat_settings, public.ai_chat_plan_caps, public.ai_chat_pilot_orgs, public.ai_chat_sessions,
  public.ai_chat_messages, public.ai_chat_calls from public, anon, authenticated, service_role;
-- A person reads their own conversations (and nothing else); every write goes through the functions below.
-- Not the model column: the owner's model is not a member's to read (its id names the vendor). The server reads a reference to it
-- through ai_chat_quota (model_ref) and maps it to its own list.
grant select (id, org_id, channel_id, created_by, slots, step, brief, card, handoff, created_at, updated_at)
  on table public.ai_chat_sessions to authenticated;
grant select on table public.ai_chat_messages to authenticated;

drop policy if exists ai_chat_sessions_own on public.ai_chat_sessions;
create policy ai_chat_sessions_own on public.ai_chat_sessions for select to authenticated
  using (created_by = (select auth.uid()) and public.is_org_member(org_id, 'viewer'));
drop policy if exists ai_chat_messages_own on public.ai_chat_messages;
create policy ai_chat_messages_own on public.ai_chat_messages for select to authenticated
  using (created_by = (select auth.uid())
         and exists (select 1 from public.ai_chat_sessions s where s.id = session_id and public.is_org_member(s.org_id, 'viewer')));

-- The workspace's daily cap by its plan: Business's for the operator's own (uncharged) workspace and for a piloted one, NULL for a
-- plan without the Brain (its lifetime trial is ai_chat_trial_left).
create or replace function public.ai_chat_cap(p_org uuid) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select c.per_day from public.ai_chat_plan_caps c
   where c.plan_id = case when public.credits_exempt(p_org) or exists (select 1 from public.ai_chat_pilot_orgs p where p.org_id = p_org)
                          then 'studio' else public.org_plan_internal(p_org) end
$$;

-- The Free plan (plans.is_default): the trial messages left in the workspace's whole life (every turn it ever took counts). Only Free:
-- a paid plan without a cap row (a new plan nobody priced the Brain for) is refused as "not on this plan", never handed Free's trial,
-- and never unlimited. A subscription to an unknown plan id cannot exist (0034's foreign key on subscriptions.plan_id).
create or replace function public.ai_chat_trial_left(p_org uuid) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.org_plan_internal(p_org) is distinct from (select p.id from public.plans p where p.is_default limit 1) then 0
              else greatest(0, (select trial_messages from public.ai_chat_settings where id)
                               - (select count(*)::integer from public.ai_chat_calls c where c.org_id = p_org
                                    -- Every outcome uses the trial: a refusal on Free is a paid vendor call, and a call a member
                                    -- finishes by hand as not_sent still stores their message (Breach on 0199: both kept the trial).
                                    )) end
$$;

-- The workspace's turns in the last 24 hours. A failure at the vendor counts (it may have cost money); a turn that never reached the
-- vendor (not_sent) or that a safety rule refused does not: the person is not charged a turn for those (Lens on 0199).
create or replace function public.ai_chat_used(p_org uuid) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.ai_chat_calls c where c.org_id = p_org and c.created_at > now() - interval '24 hours'
     and c.outcome not in ('not_sent', 'not_configured', 'vendor_refused', 'refused')
$$;

-- A session, for a member of a workspace whose plan has the Brain. The channel is optional (a short film needs none) but, when given,
-- must be one of that workspace's own. The model is the owner's choice at this moment, recorded for the metering.
create or replace function public.ai_chat_start(p_org uuid, p_channel text) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_cap integer;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- Planning a video is a maker's act: an editor or above, as creating one is (a viewer cannot spend the workspace's turns).
  if p_org is null or not public.is_org_member(p_org, 'editor') then
    perform public.creative_refuse('forbidden', 'an editor of this workspace can use Nightshift AI', 'NS403');
  end if;
  if (select count(*) from public.ai_chat_sessions x where x.created_by = v_user and x.created_at > now() - interval '24 hours')
     >= (select sessions_per_user_daily from public.ai_chat_settings where id) then
    perform public.creative_refuse('chat_daily_cap', 'too many new conversations today', 'NS429');
  end if;
  if p_channel is not null and not exists (select 1 from public.channels c where c.channel_id = p_channel and c.org_id = p_org) then
    perform public.creative_refuse('channel_not_found', 'that channel is not in this workspace', 'NS404');
  end if;
  v_cap := public.ai_chat_cap(p_org);
  if (v_cap is null and public.ai_chat_trial_left(p_org) = 0) or v_cap = 0 then
    perform public.creative_refuse('chat_plan_required', 'Nightshift AI is on the Plus, Pro and Business plans', 'NS402');
  end if;
  insert into public.ai_chat_sessions (org_id, channel_id, created_by, model)
  values (p_org, p_channel, v_user, (select model from public.ai_chat_settings where id)) returning id into v_id;
  return v_id;
end
$$;

-- The cap, then the person's message and a pending call. Under the workspace's own lock, so two tabs (or two servers) cannot both
-- take the last turn. Refused turns write nothing. The plan is read now, not at the session's start: a downgrade takes effect at once.
-- p_retry: the same message again after a failed answer (Lens on 0199: a retry stored the message twice). It takes a turn (the
-- vendor is called again) but adds no message: the last one must be the person's own, unanswered.
create or replace function public.ai_chat_reserve_turn(p_session uuid, p_text text, p_retry boolean default false,
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
                         E'[\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uFE00-\uFE0F\U000E0000-\U000E007F]', '', 'g'),
                       E' \t\r\n\f\u0085\u00A0\u115F\u1160\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u2800\u3000\u3164\uFFA0' || chr(11));
  st public.ai_chat_settings;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
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
$$;

-- The end of a turn: only the person who reserved the call, only once. The BRIEF and card are the server's validated output
-- (lib/brain); the database bounds their size and shape, and the canvas renders them as plain text.
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

-- The person's own choice of a proposed scenario (no LLM call, so no turn): the server stores the BRIEF it built from it. Author only,
-- never on a handed-off session. It can only ever change the author's own draft, which prices nothing and starts nothing.
create or replace function public.ai_chat_save_brief(p_session uuid, p_brief jsonb, p_step text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user for update;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  if s.step = 'created' then
    perform public.creative_refuse('session_closed', 'this plan was handed off; start a new conversation', 'NS409');
  end if;
  if jsonb_typeof(p_brief) <> 'object' or p_step is null or p_step not in ('proposing', 'ready') then
    perform public.creative_refuse('invalid_params', 'a brief and a step');
  end if;
  update public.ai_chat_sessions set brief = p_brief, step = p_step, card = null, updated_at = now() where id = s.id;
end
$$;

-- What the person's Create opened, recorded on their own session so the canvas can follow it. It STARTS nothing: the film was started
-- by start_film and the run by the Run now form, each as the person; this only remembers which. A film must be the workspace's own.
create or replace function public.ai_chat_record_handoff(p_session uuid, p_handoff jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  v_kind text := p_handoff ->> 'kind';
  v_credit text;
  v_map jsonb;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user for update;
  if not found or not public.is_org_member(s.org_id, 'editor') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  if jsonb_typeof(p_handoff) <> 'object' or v_kind is null or v_kind not in ('film', 'run') then
    perform public.creative_refuse('invalid_params', 'a handoff is a film or a run');
  end if;
  if v_kind = 'film' and not exists (select 1 from public.films f
                                      where f.id::text = p_handoff ->> 'film_id' and f.org_id = s.org_id) then
    perform public.creative_refuse('invalid_params', 'that film is not in this workspace');
  end if;
  if v_kind = 'run' and not exists (select 1 from public.channels c
                                     where c.channel_id = p_handoff ->> 'channel_id' and c.org_id = s.org_id) then
    perform public.creative_refuse('invalid_params', 'that channel is not in this workspace');
  end if;
  -- What the canvas needs (S6b), read here rather than taken from the browser: a run's hold reference from its own queued job, and a
  -- film's {brief scene id: film_scenes.id} by position (the draft was saved from the brief's scenes in order). A job or a film of
  -- another workspace gives nothing.
  if v_kind = 'run' then
    select j.credit_ref into v_credit from public.render_jobs j
     where j.id::text = p_handoff ->> 'job_id' and j.channel_id = p_handoff ->> 'channel_id';
  else
    select jsonb_object_agg(b.scene ->> 'id', f.id) into v_map
      from (select e.scene, row_number() over (order by e.n) as k
              from jsonb_array_elements(case when jsonb_typeof(s.brief -> 'scenes') = 'array' then s.brief -> 'scenes' else '[]'::jsonb end)
                   with ordinality as e(scene, n)
             where jsonb_typeof(e.scene -> 'id') = 'string') b
      join (select fs.id, row_number() over (order by fs.position) as k
              from public.film_scenes fs where fs.film_id::text = p_handoff ->> 'film_id' and fs.org_id = s.org_id) f using (k);
  end if;
  update public.ai_chat_sessions
     set handoff = jsonb_strip_nulls(jsonb_build_object(
           'kind', v_kind, 'film_id', p_handoff ->> 'film_id', 'channel_id', p_handoff ->> 'channel_id',
           'dispatched_at', left(p_handoff ->> 'dispatched_at', 40), 'job_id', left(p_handoff ->> 'job_id', 80),
           'credit_ref', v_credit, 'scene_map', v_map)),
         step = 'created', card = null, updated_at = now()
   where id = s.id;
end
$$;

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

create or replace function public.ai_chat_set_model(p_model text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  -- A text model the registry knows. Whether it is on sale right now is asked on every turn (sellable_models), never assumed here.
  if not exists (select 1 from public.model_registry m where m.id = p_model and 'describe' = any (m.capabilities)) then
    perform public.creative_refuse('invalid_params', 'not a text model the registry knows');
  end if;
  update public.ai_chat_settings set model = p_model, updated_by = auth.uid(), updated_at = now() where id;
  return (select jsonb_build_object('model', model, 'max_input_chars', max_input_chars) from public.ai_chat_settings where id);
end
$$;

create or replace function public.ai_chat_set_plan_cap(p_plan text, p_per_day integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  if p_per_day is null or p_per_day < 0 or p_per_day > 10000 or not exists (select 1 from public.plans p where p.id = p_plan) then
    perform public.creative_refuse('invalid_params', 'a known plan and a cap between 0 and 10000');
  end if;
  insert into public.ai_chat_plan_caps (plan_id, per_day, updated_by, updated_at) values (p_plan, p_per_day, auth.uid(), now())
  on conflict (plan_id) do update set per_day = excluded.per_day, updated_by = excluded.updated_by, updated_at = now();
  return (select jsonb_object_agg(plan_id, per_day) from public.ai_chat_plan_caps);
end
$$;

-- The owner's pilot list: a listed workspace has Business's cap whatever its plan.
create or replace function public.ai_chat_set_pilot(p_org uuid, p_on boolean) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    perform public.creative_refuse('invalid_params', 'a workspace that exists');
  end if;
  if coalesce(p_on, false) then
    insert into public.ai_chat_pilot_orgs (org_id, added_by) values (p_org, auth.uid()) on conflict (org_id) do nothing;
  else
    delete from public.ai_chat_pilot_orgs where org_id = p_org;
  end if;
  return jsonb_build_object('pilot', coalesce(p_on, false));
end
$$;

-- The owner's other knobs; a NULL leaves that one as it is. The table's checks bound every value.
create or replace function public.ai_chat_set_limits(p_max_input_chars integer, p_per_user_daily integer, p_global_daily integer,
                                                    p_sessions_per_user_daily integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  update public.ai_chat_settings
     set max_input_chars = coalesce(p_max_input_chars, max_input_chars),
         per_user_daily = coalesce(p_per_user_daily, per_user_daily),
         global_daily = coalesce(p_global_daily, global_daily),
         sessions_per_user_daily = coalesce(p_sessions_per_user_daily, sessions_per_user_daily),
         updated_by = auth.uid(), updated_at = now()
   where id;
  return public.ai_chat_owner_settings();
end
$$;

-- The owner's reading: turns and tokens per Tashkent day and model. No text, no workspace names; a cost is the owner's own arithmetic
-- on the vendor's published rates, never stored here. Tokens are what the Command Center reported for each turn; a member calling the
-- database directly can misreport their own turns' tokens (never above the per-turn bound), so reconcile with the vendor's dashboard.
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

create or replace function public.ai_chat_owner_settings() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'model', (select model from public.ai_chat_settings where id),
    'max_input_chars', (select max_input_chars from public.ai_chat_settings where id),
    'per_user_daily', (select per_user_daily from public.ai_chat_settings where id),
    'global_daily', (select global_daily from public.ai_chat_settings where id),
    'trial_messages', (select trial_messages from public.ai_chat_settings where id),
    'pilots', coalesce((select jsonb_agg(org_id) from public.ai_chat_pilot_orgs), '[]'::jsonb),
    'caps', coalesce((select jsonb_object_agg(plan_id, per_day) from public.ai_chat_plan_caps), '{}'::jsonb));
end
$$;

revoke all on function public.ai_chat_cap(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_trial_left(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_set_pilot(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_set_pilot(uuid, boolean) to authenticated;
revoke all on function public.ai_chat_used(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_start(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_reserve_turn(uuid, text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_record_handoff(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_save_brief(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_quota(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_set_model(text) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_set_plan_cap(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_set_limits(integer, integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_usage(date, date) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_owner_settings() from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_start(uuid, text) to authenticated;
grant execute on function public.ai_chat_reserve_turn(uuid, text, boolean, text) to authenticated;
grant execute on function public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text, jsonb, jsonb) to authenticated;
grant execute on function public.ai_chat_record_handoff(uuid, jsonb) to authenticated;
grant execute on function public.ai_chat_save_brief(uuid, jsonb, text) to authenticated;
grant execute on function public.ai_chat_quota(uuid) to authenticated;
grant execute on function public.ai_chat_set_model(text) to authenticated;
grant execute on function public.ai_chat_set_plan_cap(text, integer) to authenticated;
grant execute on function public.ai_chat_set_limits(integer, integer, integer, integer) to authenticated;
grant execute on function public.ai_chat_usage(date, date) to authenticated;
grant execute on function public.ai_chat_owner_settings() to authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.ai_chat_calls', 'SELECT')
     or has_table_privilege('authenticated', 'public.ai_chat_messages', 'INSERT')
     or has_table_privilege('authenticated', 'public.ai_chat_sessions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.ai_chat_plan_caps', 'SELECT')
     or has_table_privilege('authenticated', 'public.ai_chat_settings', 'SELECT')
     or has_table_privilege('anon', 'public.ai_chat_sessions', 'SELECT') then
    raise exception '0199 end state: an API role can reach a chat table directly';
  end if;
  if has_function_privilege('anon', 'public.ai_chat_reserve_turn(uuid, text, boolean, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ai_chat_used(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ai_chat_cap(uuid)', 'EXECUTE') then
    raise exception '0199 end state: a chat function is callable by the wrong role';
  end if;
end $$;

notify pgrst, 'reload schema';

-- Verify (read-only): every column should read true.
-- select (select model from public.ai_chat_settings) = 'anthropic-claude-sonnet-5-5' as default_model,
--        (select per_day from public.ai_chat_plan_caps where plan_id = 'creator') = 30 as plus_cap,
--        not exists (select 1 from public.ai_chat_plan_caps where plan_id = 'free') as free_has_none,
--        not has_table_privilege('authenticated', 'public.ai_chat_calls', 'SELECT') as calls_closed;
