-- 0211_ai_chat_plan_leases.sql — one storyboard plan at a time per Nightshift AI conversation (S1 plan step,
-- command-center/lib/server/brain/plan.ts; docs/studio/NIGHTSHIFT_AI.md "Proposals and the plan step").
--
-- *** NOT APPLIED LIVE. *** One closed table and three functions. Nothing replaced, nothing backfilled. Number provisional: Atlas
-- assigns the final one at merge.
--
-- WHY. Choosing a short outline writes its storyboard in several model calls, each an ordinary 0199 turn. 0199 ties a turn to a
-- conversation and a press (request id), but nothing ties a PLAN to a conversation: a second tab, or a refresh that loses the
-- press id, began a second plan of the same conversation and took every turn again (Breach BR-S1-02, pinned in
-- tests/security/test_sec_brain_plan_breach.py). A lease is the missing tie: one running plan per conversation, granted by the
-- database under the conversation's own row lock, so two tabs or two servers cannot both hold it.
--
-- WHAT A LEASE IS. One row per conversation: which proposal and outline it plans, the attempt number, and running | failed | done.
-- A running lease expires 320 s after it was granted (the route's own budget is 300 s, docs/studio/NIGHTSHIFT_AI.md), so a server
-- that died mid-plan never locks the conversation for good. A failed or expired lease is granted again at once, as attempt + 1.
--
-- WHO. The conversation's author only, and only while they are an editor of its workspace: the same guard as 0199's
-- ai_chat_save_brief. A colleague, a viewer or another tenant reads "session_not_found", the answer an id that does not exist gets.
-- The table has RLS on, an author-only SELECT policy as a second wall, and NO grant to any API role: only these functions touch it.
--
-- THE SWEEP. A plan whose server died leaves its in-flight 0199 calls `pending`, and a pending call counts against the cap forever.
-- When an expired running lease is taken over, that plan's pending calls of this conversation (made while the lease ran, and older
-- than any call can run) are finished as `vendor_error` with unknown tokens: the vendor may have been paid, so it is a failure,
-- never "ok" and never "not_sent".
--
-- NOT CHANGED: every 0199 cap, turn, message and BRIEF rule; every price, hold, credit, film and publish rule. A lease spends
-- nothing and starts nothing.
--
-- REQUIRES 0199 (ai_chat_sessions, ai_chat_calls, ai_chat_settings), is_org_member (0018), creative_refuse (0036). Additive and
-- idempotent. Undo: docs/sql/rollback_0211_ai_chat_plan_leases.sql.
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.ai_chat_sessions') is null or to_regclass('public.ai_chat_calls') is null
     or to_regclass('public.ai_chat_settings') is null then
    raise exception '0211 needs 0199_studio_ai_chat.sql: apply it first';
  end if;
  if to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0211 needs is_org_member (0018)';
  end if;
  if to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0211 needs creative_refuse (0036)';
  end if;
end $$;

create table if not exists public.ai_chat_plan_leases (
  session_id      uuid primary key references public.ai_chat_sessions (id) on delete cascade,
  created_by      uuid not null,
  proposal_id     bigint not null check (proposal_id >= 0),
  scenario_index  smallint not null check (scenario_index between 0 and 2),
  attempt         integer not null default 1 check (attempt >= 1),
  state           text not null check (state in ('running', 'failed', 'done')),
  -- A short machine word (plan_failed's reason, "superseded", ...), never text a person or a model wrote.
  reason          text check (reason is null or reason ~ '^[a-z][a-z0-9_]{0,39}$'),
  started_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  finished_at     timestamptz
);

alter table public.ai_chat_plan_leases enable row level security;
revoke all on table public.ai_chat_plan_leases from public, anon, authenticated, service_role;
drop policy if exists ai_chat_plan_leases_author_read on public.ai_chat_plan_leases;
-- A second wall only: with no grant, no API role reads the table at all. Should a grant ever be added, it is the author's rows.
create policy ai_chat_plan_leases_author_read on public.ai_chat_plan_leases
  for select to authenticated using (created_by = (select auth.uid()));
comment on table public.ai_chat_plan_leases is
  'Migration 0211: one storyboard plan at a time per Nightshift AI conversation (running | failed | done, attempt, expires_at). RLS on, an author-only SELECT policy, no grant: only ai_chat_plan_begin / ai_chat_plan_end / ai_chat_plan_state touch it.';

-- The caller's own conversation, locked, under 0199's ai_chat_save_brief guard: author, still an editor, not handed off.
create or replace function public.ai_chat_plan_session(p_session uuid) returns public.ai_chat_sessions
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
  return s;
end
$$;

-- Begin a plan: refused while another is running; otherwise attempt + 1, running, for 320 s. Returns the attempt (the route
-- derives every call's request id from it), when the lease expires, and the person's own turns left today across workspaces
-- (0199's per_user_daily), so the route can refuse a plan that could not finish before taking its first turn.
create or replace function public.ai_chat_plan_begin(p_session uuid, p_proposal bigint, p_index integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  l public.ai_chat_plan_leases;
  v_attempt integer;
  v_expires timestamptz;
  v_had boolean;
begin
  s := public.ai_chat_plan_session(p_session);
  if p_proposal is null or p_proposal < 0 or p_index is null or p_index not between 0 and 2 then
    perform public.creative_refuse('invalid_params', 'a proposal and an outline index (0 to 2)');
  end if;
  select * into l from public.ai_chat_plan_leases where session_id = s.id for update;
  -- Kept now: the sweep's UPDATE below resets FOUND.
  v_had := found;
  if v_had and l.state = 'running' and l.expires_at > now() then
    -- The detail is the lease's end, so the second tab can say how long to wait and then read the outcome.
    perform public.creative_refuse('plan_running', to_char(l.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'NS409');
  end if;
  if v_had and l.state = 'running' then
    -- The plan before this one ran out of time (its server is gone or stalled): every call it made, from its start to its expiry,
    -- that is still pending is a failure with unknown tokens. The whole lease, up to its last second (Lens L4): a call made just
    -- before the expiry is that dead plan's too, and a late finish of it is then refused (call_not_found), never counted twice.
    -- No turn made after the expiry is touched.
    --
    -- Locks: this function holds the session row (ai_chat_plan_session), then the lease, then these calls; 0199's
    -- ai_chat_finish_turn holds a call, then the session. The two orders are opposite, so the calls are taken SKIP LOCKED: a call a
    -- finish is holding right now is being finished by it and is left alone, and this function never waits on a call lock while it
    -- holds the session, so the two cannot deadlock.
    update public.ai_chat_calls c
       set outcome = 'vendor_error', tokens_in = null, tokens_out = null, finished_at = now()
     where c.id in (select x.id from public.ai_chat_calls x
                     where x.session_id = s.id and x.user_id = v_user and x.outcome = 'pending'
                       and x.created_at >= l.started_at and x.created_at <= l.expires_at
                       for update skip locked);
  end if;
  v_attempt := case when v_had then l.attempt + 1 else 1 end;
  v_expires := now() + interval '320 seconds';
  insert into public.ai_chat_plan_leases (session_id, created_by, proposal_id, scenario_index, attempt, state, reason,
                                          started_at, expires_at, finished_at)
  values (s.id, v_user, p_proposal, p_index, v_attempt, 'running', null, now(), v_expires, null)
  on conflict (session_id) do update
     set created_by = excluded.created_by, proposal_id = excluded.proposal_id, scenario_index = excluded.scenario_index,
         attempt = excluded.attempt, state = 'running', reason = null, started_at = excluded.started_at,
         expires_at = excluded.expires_at, finished_at = null;
  return jsonb_build_object(
    'attempt', v_attempt,
    'expires_at', to_char(v_expires at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'user_left', greatest(0, (select per_user_daily from public.ai_chat_settings where id)
                             - (select count(*)::integer from public.ai_chat_calls c
                                 where c.user_id = v_user and c.created_at > now() - interval '24 hours')));
end
$$;

-- End a plan: only the attempt that is running now, by its number. An older attempt's late finish cannot close a newer one.
create or replace function public.ai_chat_plan_end(p_session uuid, p_attempt integer, p_state text, p_reason text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.ai_chat_sessions;
  l public.ai_chat_plan_leases;
begin
  s := public.ai_chat_plan_session(p_session);
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

-- What the panel needs to follow a plan it did not start in this tab (a refresh, a second tab): the lease's state, never more.
-- An expired running lease reads as `failed` with reason `expired` (nothing will finish it now). No lease: null.
create or replace function public.ai_chat_plan_state(p_session uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  s public.ai_chat_sessions;
  l public.ai_chat_plan_leases;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into s from public.ai_chat_sessions where id = p_session and created_by = v_user;
  if not found or not public.is_org_member(s.org_id, 'viewer') then
    perform public.creative_refuse('session_not_found', 'no such conversation', 'NS404');
  end if;
  select * into l from public.ai_chat_plan_leases where session_id = s.id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'attempt', l.attempt, 'proposal_id', l.proposal_id, 'scenario_index', l.scenario_index,
    'state', case when l.state = 'running' and l.expires_at <= now() then 'failed' else l.state end,
    'reason', case when l.state = 'running' and l.expires_at <= now() then 'expired' else l.reason end,
    'expires_at', to_char(l.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end
$$;

revoke all on function public.ai_chat_plan_session(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_plan_begin(uuid, bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_plan_end(uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.ai_chat_plan_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ai_chat_plan_begin(uuid, bigint, integer) to authenticated;
grant execute on function public.ai_chat_plan_end(uuid, integer, text, text) to authenticated;
grant execute on function public.ai_chat_plan_state(uuid) to authenticated;

-- End state (Verify).
do $$
declare
  sig text;
  r   text;
  fn  oid;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.ai_chat_plan_leases'::regclass) then
    raise exception '0211 end state: ai_chat_plan_leases must have RLS on';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'ai_chat_plan_leases') <> 1
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_chat_plan_leases'
                     and policyname = 'ai_chat_plan_leases_author_read' and cmd = 'SELECT') then
    raise exception '0211 end state: ai_chat_plan_leases must have exactly its author-only SELECT policy';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(r, 'public.ai_chat_plan_leases', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '0211 end state: ai_chat_plan_leases must not be reachable directly by %', r;
    end if;
  end loop;
  fn := to_regprocedure('public.ai_chat_plan_session(uuid)');
  if fn is null or has_function_privilege('authenticated', fn, 'EXECUTE') or has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception '0211 end state: ai_chat_plan_session must exist and be callable by no API role';
  end if;
  foreach sig in array array['public.ai_chat_plan_begin(uuid,bigint,integer)', 'public.ai_chat_plan_end(uuid,integer,text,text)',
                             'public.ai_chat_plan_state(uuid)', 'public.ai_chat_plan_session(uuid)'] loop
    fn := to_regprocedure(sig);
    if fn is null then
      raise exception '0211 end state: % does not exist', sig;
    end if;
    if sig <> 'public.ai_chat_plan_session(uuid)'
       and (not has_function_privilege('authenticated', fn, 'EXECUTE')
            or has_function_privilege('anon', fn, 'EXECUTE') or has_function_privilege('service_role', fn, 'EXECUTE')) then
      raise exception '0211 end state: % has the wrong grants', sig;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0211 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', sig;
    end if;
  end loop;
end $$;
