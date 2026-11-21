-- 0203_owner_ai_turns.sql — the owner's Nightshift AI: a turn log and its daily cap. docs/OWNER_BRAIN.md "Owner AI".
--
-- *** LIVE ON APPLY. *** One closed table and two functions. Nothing replaced, nothing backfilled.
--
-- WHY. The owner's Nightshift AI (/owner/ai, /api/brain/owner/turn) sends the owner's facts and question to the chat model the
-- owner chose (0198's ai_chat_settings). Every call is real vendor spend, so a turn is reserved in the database BEFORE the vendor is
-- called, under a lock, against a rolling 24-hour cap — the same rule as the customer chat (0198), owner-scoped: 0198's
-- ai_chat_reserve_turn is a workspace session's meter and must not be reused for platform data. A stolen owner session, a stuck
-- client or a retry loop meets the cap, not an open tap.
--
-- WHAT IS STORED. Who asked, when, which model, how it ended, the length of the question and the token counts. NOT the question,
-- the answer or the facts: those are the owner's figures and stay in the request. No secret, no vendor cost.
--
-- WHO. Platform owner only: owner_analytics_is_owner() (0182) first (42501), then 0107's second factor when that gate is on (NS401).
-- The table has RLS on and no policy: only these two functions touch it. Execute is granted to `authenticated` only.
--
-- REQUIRES 0182, 0107, and creative_refuse() (0036). Additive and idempotent.
-- Undo: docs/sql/rollback_0203_owner_ai_turns.sql.
-- NUMBER. 0203 is provisional; the final number is assigned at merge.
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.owner_analytics_is_owner()') is null then
    raise exception '0203 needs 0182_owner_analytics.sql: apply it first';
  end if;
  if to_regprocedure('public.admin_aal_ok()') is null then
    raise exception '0203 needs 0107_owner_safety.sql (admin_aal_ok): apply it first';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'creative_refuse') then
    raise exception '0203 needs creative_refuse() (0036): apply it first';
  end if;
end $$;

create table if not exists public.owner_ai_turns (
  id           bigserial primary key,
  user_id      uuid not null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  model        text check (model is null or model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  outcome      text not null default 'reserved' check (outcome in ('reserved', 'answered', 'failed')),
  -- A fixed code from the route (vendor_quota, not_configured, bad_answer…), never free text or a vendor's message.
  error        text check (error is null or error ~ '^[a-z_]{1,40}$'),
  chars_in     integer not null check (chars_in between 1 and 2000),
  tokens_in    integer check (tokens_in is null or tokens_in >= 0),
  tokens_out   integer check (tokens_out is null or tokens_out >= 0)
);
create index if not exists owner_ai_turns_created_idx on public.owner_ai_turns (created_at desc);
alter table public.owner_ai_turns enable row level security;
revoke all on table public.owner_ai_turns from public, anon, authenticated, service_role;
revoke all on sequence public.owner_ai_turns_id_seq from public, anon, authenticated, service_role;
comment on table public.owner_ai_turns is
  'Migration 0203: one row per owner Nightshift AI turn — who, when, model, outcome, question length and token counts; never the question, answer or facts. RLS on, no policy: only owner_ai_reserve_turn/owner_ai_finish_turn touch it.';

-- The cap. 200 owner questions in a rolling 24 hours: far above a person's use, low enough that a loop is a bounded bill.
create or replace function public.owner_ai_reserve_turn(p_chars integer, p_model text)
  returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_cap  constant integer := 200;
  v_used integer;
  v_id   bigint;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if p_chars is null or p_chars < 1 or p_chars > 2000 then
    perform public.creative_refuse('message_too_long', 'a question of 1 to 2000 characters', '22023');
  end if;
  if p_model is null or p_model !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'a model id', '22023');
  end if;
  -- One lock for the whole platform: two tabs cannot both take the last turn.
  perform pg_advisory_xact_lock(hashtextextended('owner_ai_turns', 0));
  select count(*) into v_used from public.owner_ai_turns where created_at > now() - interval '24 hours';
  if v_used >= v_cap then
    perform public.creative_refuse('owner_ai_daily_cap', format('used=%s limit=%s', v_used, v_cap), 'NS429');
  end if;
  insert into public.owner_ai_turns (user_id, model, chars_in) values (auth.uid(), p_model, p_chars) returning id into v_id;
  return v_id;
end
$$;

create or replace function public.owner_ai_finish_turn(p_turn bigint, p_ok boolean, p_error text, p_tokens_in integer, p_tokens_out integer)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if p_error is not null and p_error !~ '^[a-z_]{1,40}$' then
    perform public.creative_refuse('invalid_params', 'an error code', '22023');
  end if;
  -- Only a reserved turn of this person can be finished, once: a finished row is a record, never edited after.
  update public.owner_ai_turns
     set finished_at = now(),
         outcome = case when p_ok then 'answered' else 'failed' end,
         error = case when p_ok then null else coalesce(p_error, 'unknown') end,
         tokens_in = case when p_tokens_in is null or p_tokens_in < 0 then null else p_tokens_in end,
         tokens_out = case when p_tokens_out is null or p_tokens_out < 0 then null else p_tokens_out end
   where id = p_turn and user_id = auth.uid() and outcome = 'reserved';
end
$$;

comment on function public.owner_ai_reserve_turn(integer, text) is
  'Migration 0203: reserves one owner Nightshift AI turn before the vendor is called — platform owner only, second factor when 0107''s gate is on, 200 per rolling 24 hours under a lock (NS429 owner_ai_daily_cap). Returns the turn id.';
comment on function public.owner_ai_finish_turn(bigint, boolean, text, integer, integer) is
  'Migration 0203: records how a reserved owner AI turn ended (answered / failed with a code) and its token counts. Owner only; a turn is finished once.';

revoke all on function public.owner_ai_reserve_turn(integer, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_finish_turn(bigint, boolean, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.owner_ai_reserve_turn(integer, text) to authenticated;
grant execute on function public.owner_ai_finish_turn(bigint, boolean, text, integer, integer) to authenticated;

-- End state.
do $$
declare
  sig text;
  fn  oid;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.owner_ai_turns'::regclass) then
    raise exception '0203 end state: owner_ai_turns must have RLS on';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'owner_ai_turns') then
    raise exception '0203 end state: owner_ai_turns must have no policy';
  end if;
  if has_table_privilege('authenticated', 'public.owner_ai_turns', 'SELECT')
     or has_table_privilege('anon', 'public.owner_ai_turns', 'SELECT')
     or has_table_privilege('service_role', 'public.owner_ai_turns', 'SELECT') then
    raise exception '0203 end state: owner_ai_turns must not be readable directly';
  end if;
  foreach sig in array array['public.owner_ai_reserve_turn(integer,text)', 'public.owner_ai_finish_turn(bigint,boolean,text,integer,integer)'] loop
    fn := to_regprocedure(sig);
    if fn is null then
      raise exception '0203 end state: % does not exist', sig;
    end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0203 end state: % has the wrong grants', sig;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0203 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', sig;
    end if;
  end loop;
end $$;
