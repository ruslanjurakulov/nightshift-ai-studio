-- 0209_owner_ai_history.sql — the owner's Nightshift AI conversation history, owner-only. docs/MIGRATIONS.md "Owner AI history".
--
-- *** LIVE ON APPLY. *** Two closed tables and six functions. Nothing replaced, nothing backfilled.
--
-- WHY. Owner decision (2026-11-21): the owner's conversations with Nightshift AI (/owner/ai) are kept in the database so they are
-- the same on every device. 0203 deliberately stores no question or answer text in its turn log, and stays that way: the history
-- is a separate store with its own gate, so the meter (0203) and the words (0209) can be rolled back or audited apart.
--
-- WHAT IS STORED. A session (title = the first question, cut to 60 characters, or the owner's rename) and its messages: the
-- owner's question (<= 2000 characters, the route's cap) and the AI's answer (<= 12000), the facts' as-of time and the model id.
-- Never the facts themselves, a secret or a vendor cost. Messages are append-only; a session is soft-deleted (deleted_at), and a
-- deleted session is neither listed, read nor appended to.
--
-- WHO. Platform owner only: owner_analytics_is_owner() (0182) first (42501), then 0107's second factor when that gate is on (NS401),
-- and then the session must belong to auth.uid(): a session of another person reads as not found (P0002), the same answer as one
-- that does not exist, so an id is not an oracle. Both tables have RLS on and no policy: only these functions touch them. Execute
-- is granted to `authenticated` only (not anon, not service_role: no worker reads the owner's words).
--
-- REQUIRES 0182, 0107, and creative_refuse() (0036). Additive and idempotent.
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
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'creative_refuse') then
    raise exception '0209 needs creative_refuse() (0036): apply it first';
  end if;
end $$;

create table if not exists public.owner_ai_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  title       text not null check (char_length(title) between 1 and 60 and title = btrim(title)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists owner_ai_sessions_user_updated_idx on public.owner_ai_sessions (user_id, updated_at desc) where deleted_at is null;
alter table public.owner_ai_sessions enable row level security;
revoke all on table public.owner_ai_sessions from public, anon, authenticated, service_role;
comment on table public.owner_ai_sessions is
  'Migration 0209: the owner''s Nightshift AI conversations (title, times, soft delete). RLS on, no policy: only the owner_ai_session_* / owner_ai_message_append functions touch it.';

create table if not exists public.owner_ai_messages (
  id          bigserial primary key,
  session_id  uuid not null references public.owner_ai_sessions (id) on delete cascade,
  role        text not null check (role in ('owner', 'ai')),
  -- The owner's question is capped at the route's 2000; an answer (with its draft) at 12000.
  text        text not null check (char_length(text) >= 1
                                   and char_length(text) <= case when role = 'owner' then 2000 else 12000 end),
  as_of       timestamptz,
  model       text check (model is null or model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  created_at  timestamptz not null default now()
);
create index if not exists owner_ai_messages_session_idx on public.owner_ai_messages (session_id, id);
alter table public.owner_ai_messages enable row level security;
revoke all on table public.owner_ai_messages from public, anon, authenticated, service_role;
revoke all on sequence public.owner_ai_messages_id_seq from public, anon, authenticated, service_role;
comment on table public.owner_ai_messages is
  'Migration 0209: the owner''s Nightshift AI messages (owner question <= 2000, AI answer <= 12000, as_of, model). Append-only, RLS on, no policy: only owner_ai_message_append writes and owner_ai_session_messages reads.';

create or replace function public.owner_ai_session_create(p_title text)
  returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_id    uuid;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if char_length(v_title) not between 1 and 60 then
    perform public.creative_refuse('invalid_title', 'a title of 1 to 60 characters', '22023');
  end if;
  insert into public.owner_ai_sessions (user_id, title) values (auth.uid(), v_title) returning id into v_id;
  return v_id;
end
$$;

-- Newest activity first. p_before is the previous page's last updated_at (keyset paging); the limit is clamped to 1..100.
create or replace function public.owner_ai_session_list(p_limit integer default 30, p_before timestamptz default null)
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
     where s.user_id = auth.uid() and s.deleted_at is null
       and (p_before is null or s.updated_at < p_before)
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
  if not exists (select 1 from public.owner_ai_sessions s
                  where s.id = p_session and s.user_id = auth.uid() and s.deleted_at is null) then
    perform public.creative_refuse('not_found', 'no such conversation', 'P0002');
  end if;
  return query
    select m.id, m.role, m.text, m.as_of, m.model, m.created_at
      from (select * from public.owner_ai_messages x where x.session_id = p_session order by x.id desc limit 400) m
     order by m.id;
end
$$;

create or replace function public.owner_ai_message_append(p_session uuid, p_role text, p_text text, p_as_of timestamptz, p_model text)
  returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_id  bigint;
  v_max integer;
begin
  if not public.owner_analytics_is_owner() then
    raise exception 'not available' using errcode = '42501';
  end if;
  if not public.admin_aal_ok() then
    raise exception 'mfa_required' using errcode = 'NS401';
  end if;
  if p_role is null or p_role not in ('owner', 'ai') then
    perform public.creative_refuse('invalid_params', 'role owner or ai', '22023');
  end if;
  v_max := case when p_role = 'owner' then 2000 else 12000 end;
  if p_text is null or char_length(p_text) < 1 or char_length(p_text) > v_max then
    perform public.creative_refuse('message_too_long', format('a message of 1 to %s characters', v_max), '22023');
  end if;
  if p_model is not null and p_model !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'a model id', '22023');
  end if;
  -- The row lock orders an append against a concurrent delete or rename of the same session.
  update public.owner_ai_sessions s set updated_at = now()
   where s.id = p_session and s.user_id = auth.uid() and s.deleted_at is null;
  if not found then
    perform public.creative_refuse('not_found', 'no such conversation', 'P0002');
  end if;
  insert into public.owner_ai_messages (session_id, role, text, as_of, model)
  values (p_session, p_role, p_text, p_as_of, p_model) returning id into v_id;
  return v_id;
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
  if char_length(v_title) not between 1 and 60 then
    perform public.creative_refuse('invalid_title', 'a title of 1 to 60 characters', '22023');
  end if;
  -- A rename is not activity: updated_at stays, so renaming an old chat does not move it to the top.
  update public.owner_ai_sessions s set title = v_title
   where s.id = p_session and s.user_id = auth.uid() and s.deleted_at is null;
  if not found then
    perform public.creative_refuse('not_found', 'no such conversation', 'P0002');
  end if;
end
$$;

-- Soft delete: the session leaves the list and can no longer be read or appended to. Deleting it twice is not an error.
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
  update public.owner_ai_sessions s set deleted_at = coalesce(s.deleted_at, now())
   where s.id = p_session and s.user_id = auth.uid();
  if not found then
    perform public.creative_refuse('not_found', 'no such conversation', 'P0002');
  end if;
end
$$;

comment on function public.owner_ai_session_create(text) is
  'Migration 0209: starts an owner Nightshift AI conversation (title 1..60 characters). Platform owner only, second factor when 0107''s gate is on. Returns the session id.';
comment on function public.owner_ai_session_list(integer, timestamptz) is
  'Migration 0209: the caller''s live owner AI conversations, newest activity first, keyset-paged by updated_at. Owner only.';
comment on function public.owner_ai_session_messages(uuid) is
  'Migration 0209: the last 400 messages of one of the caller''s live conversations, oldest first. Another person''s or a deleted session is P0002 not_found. Owner only.';
comment on function public.owner_ai_message_append(uuid, text, text, timestamptz, text) is
  'Migration 0209: appends one message (owner <= 2000, ai <= 12000 characters) to one of the caller''s live conversations. Append-only. Owner only.';
comment on function public.owner_ai_session_rename(uuid, text) is
  'Migration 0209: renames one of the caller''s live conversations (1..60 characters). Owner only.';
comment on function public.owner_ai_session_delete(uuid) is
  'Migration 0209: soft-deletes one of the caller''s conversations (deleted_at); it is no longer listed, read or appended to. Owner only.';

revoke all on function public.owner_ai_session_create(text) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_session_list(integer, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_session_messages(uuid) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_message_append(uuid, text, text, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_session_rename(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_ai_session_delete(uuid) from public, anon, authenticated, service_role;
grant execute on function public.owner_ai_session_create(text) to authenticated;
grant execute on function public.owner_ai_session_list(integer, timestamptz) to authenticated;
grant execute on function public.owner_ai_session_messages(uuid) to authenticated;
grant execute on function public.owner_ai_message_append(uuid, text, text, timestamptz, text) to authenticated;
grant execute on function public.owner_ai_session_rename(uuid, text) to authenticated;
grant execute on function public.owner_ai_session_delete(uuid) to authenticated;

-- End state.
do $$
declare
  sig text;
  tbl text;
  fn  oid;
begin
  foreach tbl in array array['owner_ai_sessions', 'owner_ai_messages'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || tbl)::regclass) then
      raise exception '0209 end state: % must have RLS on', tbl;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = tbl) then
      raise exception '0209 end state: % must have no policy', tbl;
    end if;
    if has_table_privilege('authenticated', 'public.' || tbl, 'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('anon', 'public.' || tbl, 'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('service_role', 'public.' || tbl, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception '0209 end state: % must not be reachable directly', tbl;
    end if;
  end loop;
  foreach sig in array array['public.owner_ai_session_create(text)',
                             'public.owner_ai_session_list(integer,timestamptz)',
                             'public.owner_ai_session_messages(uuid)',
                             'public.owner_ai_message_append(uuid,text,text,timestamptz,text)',
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
