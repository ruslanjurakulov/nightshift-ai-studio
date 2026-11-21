-- 0209_owner_ai_history.sql — the owner's Nightshift AI conversation history, owner-only. docs/MIGRATIONS.md "Owner AI history".
--
-- *** LIVE ON APPLY. *** Two closed tables and five functions. Nothing replaced, nothing backfilled.
--
-- WHY. Owner decision (2026-11-21): the owner's conversations with Nightshift AI (/owner/ai) are kept in the database so they are
-- the same on every device. 0203 deliberately stores no question or answer text in its turn log, and stays that way: the history
-- is a separate store with its own gate, so the meter (0203) and the words (0209) can be rolled back or audited apart.
--
-- WHAT IS STORED, said plainly. The owner's questions and the AI's answers ARE stored, as plain text, until the owner deletes the
-- conversation. An answer is written from the platform's live figures, so a stored answer can contain revenue and other business
-- figures and customer names or emails. Per conversation: a title (the first question, cut to 60 characters, or the owner's
-- rename), and per answered turn exactly two messages: the question (<= 2000 characters) and the answer (<= 12000), the facts'
-- as-of time and the model id. Never the facts document itself, a secret or a vendor cost. Only the owner who wrote them can read
-- them (below); "Delete" removes the conversation and its messages from the database (a real DELETE, not a hidden flag).
--
-- WHY ONE SAVE FUNCTION. History is written only by owner_ai_turn_save, and only for a 0203 turn of the caller that ended
-- 'answered' and was not saved before (unique turn_id). So storage grows by at most one question and one answer per paid turn,
-- bounded by 0203's 200 per 24 hours, and the question and the answer land together or not at all (one transaction) — a free
-- append function would let any owner session write unbounded text, and two separate calls could store a question without its
-- answer.
--
-- WHO. Platform owner only: owner_analytics_is_owner() (0182) first (42501), then 0107's second factor when that gate is on (NS401),
-- and then the session must belong to auth.uid(): a session of another person reads as not found (P0002), the same answer as one
-- that does not exist, so an id is not an oracle. A save naming a session that is not the caller's (or no longer exists) starts a
-- new conversation rather than losing the paid turn, and never writes into the other one. Both tables have RLS on and no policy:
-- only these functions touch them. Execute is granted to `authenticated` only (not anon, not service_role: no worker reads the
-- owner's words).
--
-- REQUIRES 0182, 0107, 0203 (owner_ai_turns), and creative_refuse() (0036). Additive and idempotent.
-- Undo: docs/sql/rollback_0209_owner_ai_history.sql.
-- NUMBER. 0209 is provisional; the final number is assigned at merge.
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.owner_analytics_is_owner()') is null then
    raise exception '0209 needs 0182_owner_analytics.sql: apply it first';
  end if;
  if to_regprocedure('public.admin_aal_ok()') is null then
    raise exception '0209 needs 0107_owner_safety.sql (admin_aal_ok): apply it first';
  end if;
  if to_regclass('public.owner_ai_turns') is null then
    raise exception '0209 needs 0203_owner_ai_turns.sql (owner_ai_turns): apply it first';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'creative_refuse') then
    raise exception '0209 needs creative_refuse() (0036): apply it first';
  end if;
  -- An earlier draft of this file (soft delete, free append, no turn_id) was never merged, but a lab or dev database may hold it:
  -- "create table if not exists" would keep its shape silently, so stop and name the remedy instead.
  if to_regclass('public.owner_ai_messages') is not null
     and not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'owner_ai_messages' and column_name = 'turn_id') then
    raise exception '0209: an earlier draft of 0209 is applied here; run docs/sql/rollback_0209_owner_ai_history.sql, then apply 0209 again';
  end if;
end $$;

create table if not exists public.owner_ai_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  -- No control or bidi-override characters: a title is drawn in a list, and U+202E would make it read backwards there.
  title       text not null check (char_length(title) between 1 and 60 and title = btrim(title)
                                   and title !~ '[\u0001-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists owner_ai_sessions_user_updated_idx on public.owner_ai_sessions (user_id, updated_at desc, id desc);
alter table public.owner_ai_sessions enable row level security;
revoke all on table public.owner_ai_sessions from public, anon, authenticated, service_role;
comment on table public.owner_ai_sessions is
  'Migration 0209: the owner''s Nightshift AI conversations (title, times). Deleted for real by owner_ai_session_delete (messages cascade). RLS on, no policy: only the 0209 functions touch it.';

create table if not exists public.owner_ai_messages (
  id          bigserial primary key,
  session_id  uuid not null references public.owner_ai_sessions (id) on delete cascade,
  -- The 0203 turn this message belongs to. No foreign key on purpose: 0203 can be rolled back apart from the history.
  turn_id     bigint not null,
  role        text not null check (role in ('owner', 'ai')),
  -- The owner's question is capped at the route's 2000; an answer (with its draft) at 12000.
  text        text not null check (char_length(text) >= 1
                                   and char_length(text) <= case when role = 'owner' then 2000 else 12000 end),
  as_of       timestamptz,
  model       text check (model is null or model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  created_at  timestamptz not null default now(),
  -- One question and one answer per turn: a turn saved twice would be storage the 0203 cap no longer bounds.
  unique (turn_id, role),
  -- The as-of time and the model describe an answer; on a question they would be a claim nobody made.
  check (role = 'ai' or (as_of is null and model is null))
);
create index if not exists owner_ai_messages_session_idx on public.owner_ai_messages (session_id, id);
alter table public.owner_ai_messages enable row level security;
revoke all on table public.owner_ai_messages from public, anon, authenticated, service_role;
revoke all on sequence public.owner_ai_messages_id_seq from public, anon, authenticated, service_role;
comment on table public.owner_ai_messages is
  'Migration 0209: the owner''s Nightshift AI messages, one question and one answer per answered 0203 turn (owner <= 2000, ai <= 12000 characters, as_of, model). RLS on, no policy: only owner_ai_turn_save writes and owner_ai_session_messages reads.';

-- The earlier draft's free writers. Nothing may write history without a paid, answered turn.
drop function if exists public.owner_ai_message_append(uuid, text, text, timestamptz, text);
drop function if exists public.owner_ai_session_create(text);
drop function if exists public.owner_ai_session_list(integer, timestamptz);

-- Saves one answered turn: the question and the answer, together, into the caller's conversation (or a new one). Returns the
-- conversation's id, which the route hands back so the next question continues it.
create or replace function public.owner_ai_turn_save(p_turn bigint, p_session uuid, p_question text, p_answer text,
                                                     p_as_of timestamptz, p_model text)
  returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_model text;
  v_sid   uuid;
  v_title text;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if p_question is null or char_length(p_question) not between 1 and 2000 then
    perform public.creative_refuse('message_too_long', 'a question of 1 to 2000 characters', '22023');
  end if;
  if p_answer is null or char_length(p_answer) not between 1 and 12000 then
    perform public.creative_refuse('message_too_long', 'an answer of 1 to 12000 characters', '22023');
  end if;
  -- The facts' time is the moment the route read them, seconds ago: a date far from now is not a measurement (rule 5).
  if p_as_of is not null and (p_as_of < now() - interval '1 day' or p_as_of > now() + interval '1 day') then
    perform public.creative_refuse('invalid_params', 'an as-of time within a day of now', '22023');
  end if;
  -- The row lock serialises two saves of the same turn (a double submit, two tabs): the second sees the first's rows.
  select t.model into v_model from public.owner_ai_turns t
   where t.id = p_turn and t.user_id = auth.uid() and t.outcome = 'answered'
   for update;
  if not found then
    perform public.creative_refuse('turn_not_answered', 'an answered turn of yours', 'P0002');
  end if;
  -- The answer is stored under the model the turn was metered for, never a different claim.
  if p_model is distinct from v_model then
    perform public.creative_refuse('invalid_params', 'the model of the turn', '22023');
  end if;
  if exists (select 1 from public.owner_ai_messages m where m.turn_id = p_turn) then
    perform public.creative_refuse('turn_already_saved', 'this turn is already saved', '23505');
  end if;
  -- The row lock orders a save against a concurrent delete or rename of the same session.
  if p_session is not null then
    update public.owner_ai_sessions s set updated_at = now()
     where s.id = p_session and s.user_id = auth.uid()
    returning s.id into v_sid;
  end if;
  -- No session, a deleted one, or another person's: a new conversation, so the paid turn is kept and nothing is written into a
  -- conversation that is not the caller's.
  if v_sid is null then
    v_title := btrim(left(regexp_replace(regexp_replace(p_question, '[\u0001-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]', ' ', 'g'),
                                         '\s+', ' ', 'g'), 60));
    -- A question made only of stripped characters still needs a title; the owner can rename it.
    if v_title = '' then
      v_title := '…';
    end if;
    insert into public.owner_ai_sessions (user_id, title) values (auth.uid(), v_title) returning id into v_sid;
  end if;
  insert into public.owner_ai_messages (session_id, turn_id, role, text, as_of, model)
  values (v_sid, p_turn, 'owner', p_question, null, null),
         (v_sid, p_turn, 'ai', p_answer, p_as_of, v_model);
  return v_sid;
end
$$;

-- Newest activity first. (p_before, p_before_id) is the previous page's last row (keyset paging on the same order as the sort, so
-- two sessions with the same updated_at are neither skipped nor repeated); the limit is clamped to 1..100.
create or replace function public.owner_ai_session_list(p_limit integer default 30, p_before timestamptz default null,
                                                        p_before_id uuid default null)
  returns table (id uuid, title text, created_at timestamptz, updated_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  return query
    select s.id, s.title, s.created_at, s.updated_at
      from public.owner_ai_sessions s
     where s.user_id = auth.uid()
       and (p_before is null
            or (p_before_id is null and s.updated_at < p_before)
            or (p_before_id is not null and (s.updated_at, s.id) < (p_before, p_before_id)))
     order by s.updated_at desc, s.id desc
     limit greatest(1, least(coalesce(p_limit, 30), 100));
end
$$;

-- Oldest first, the order a conversation is read in. The last 400 messages (200 turns): a page, not an unbounded dump.
create or replace function public.owner_ai_session_messages(p_session uuid)
  returns table (id bigint, role text, text text, as_of timestamptz, model text, created_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if not exists (select 1 from public.owner_ai_sessions s where s.id = p_session and s.user_id = auth.uid()) then
    perform public.creative_refuse('not_found', 'no such conversation', 'P0002');
  end if;
  return query
    select m.id, m.role, m.text, m.as_of, m.model, m.created_at
      from (select * from public.owner_ai_messages x where x.session_id = p_session order by x.id desc limit 400) m
     order by m.id;
end
$$;

create or replace function public.owner_ai_session_rename(p_session uuid, p_title text)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if char_length(v_title) not between 1 and 60 or v_title ~ '[\u0001-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]' then
    perform public.creative_refuse('invalid_title', 'a title of 1 to 60 characters, without control or direction characters', '22023');
  end if;
  -- A rename is not activity: updated_at stays, so renaming an old chat does not move it to the top.
  update public.owner_ai_sessions s set title = v_title
   where s.id = p_session and s.user_id = auth.uid();
  if not found then
    perform public.creative_refuse('not_found', 'no such conversation', 'P0002');
  end if;
end
$$;

-- A real delete: the session row goes and its messages with it (on delete cascade), so "Delete" in the panel is true. A second
-- delete of the same id is P0002, the same answer as another person's id.
create or replace function public.owner_ai_session_delete(p_session uuid)
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
  delete from public.owner_ai_sessions s where s.id = p_session and s.user_id = auth.uid();
  if not found then
    perform public.creative_refuse('not_found', 'no such conversation', 'P0002');
  end if;
end
$$;

comment on function public.owner_ai_turn_save(bigint, uuid, text, text, timestamptz, text) is
  'Migration 0209: stores one answered 0203 turn of the caller (question <= 2000, answer <= 12000 characters) in one transaction, once per turn, into the caller''s conversation or a new one. Returns the conversation id. Owner only.';
comment on function public.owner_ai_session_list(integer, timestamptz, uuid) is
  'Migration 0209: the caller''s owner AI conversations, newest activity first, keyset-paged by (updated_at, id). Owner only.';
comment on function public.owner_ai_session_messages(uuid) is
  'Migration 0209: the last 400 messages of one of the caller''s conversations, oldest first. Another person''s or a deleted session is P0002 not_found. Owner only.';
comment on function public.owner_ai_session_rename(uuid, text) is
  'Migration 0209: renames one of the caller''s conversations (1..60 characters, no control or bidi characters). Owner only.';
comment on function public.owner_ai_session_delete(uuid) is
  'Migration 0209: deletes one of the caller''s conversations and its messages (a real DELETE). Owner only.';

revoke all on function public.owner_ai_turn_save(bigint, uuid, text, text, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_session_list(integer, timestamptz, uuid) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_session_messages(uuid) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_session_rename(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_session_delete(uuid) from public, anon, authenticated, service_role;
grant execute on function public.owner_ai_turn_save(bigint, uuid, text, text, timestamptz, text) to authenticated;
grant execute on function public.owner_ai_session_list(integer, timestamptz, uuid) to authenticated;
grant execute on function public.owner_ai_session_messages(uuid) to authenticated;
grant execute on function public.owner_ai_session_rename(uuid, text) to authenticated;
grant execute on function public.owner_ai_session_delete(uuid) to authenticated;

-- End state.
do $$
declare
  sig  text;
  tbl  text;
  r    text;
  fn   oid;
begin
  foreach tbl in array array['owner_ai_sessions', 'owner_ai_messages'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || tbl)::regclass) then
      raise exception '0209 end state: % must have RLS on', tbl;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = tbl) then
      raise exception '0209 end state: % must have no policy', tbl;
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_table_privilege(r, 'public.' || tbl, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception '0209 end state: % must not be reachable directly by %', tbl, r;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_sequence_privilege(r, 'public.owner_ai_messages_id_seq', 'USAGE,SELECT,UPDATE') then
      raise exception '0209 end state: owner_ai_messages_id_seq must not be reachable by %', r;
    end if;
  end loop;
  foreach sig in array array['public.owner_ai_message_append(uuid,text,text,timestamptz,text)',
                             'public.owner_ai_session_create(text)',
                             'public.owner_ai_session_list(integer,timestamptz)'] loop
    if to_regprocedure(sig) is not null then
      raise exception '0209 end state: % must not exist (history is written only by owner_ai_turn_save)', sig;
    end if;
  end loop;
  foreach sig in array array['public.owner_ai_turn_save(bigint,uuid,text,text,timestamptz,text)',
                             'public.owner_ai_session_list(integer,timestamptz,uuid)',
                             'public.owner_ai_session_messages(uuid)',
                             'public.owner_ai_session_rename(uuid,text)',
                             'public.owner_ai_session_delete(uuid)'] loop
    fn := to_regprocedure(sig);
    if fn is null then
      raise exception '0209 end state: % does not exist', sig;
    end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE')
       or has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception '0209 end state: % has the wrong grants', sig;
    end if;
    if exists (select 1 from pg_proc p where p.oid = fn
                and (not p.prosecdef or p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
      raise exception '0209 end state: % is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it', sig;
    end if;
  end loop;
end $$;
