-- 0096_user_handles.sql — a unique, visible @username ("handle") per person.
--
-- The owner chose "visible @handle only, sign-in stays by email": the handle
-- is a label shown in Settings, never a way to sign in and never a way to
-- find an account. Nothing here reads or writes auth.users except the
-- foreign key.
--
-- WHAT IT ADDS
--   user_handles      one row per person: user_id (primary key, cascades with
--                     the account), handle (stored lowercase), changed_at,
--                     created_at. A UNIQUE index on lower(handle) makes two
--                     people picking "Ana_K" and "ana_k" a constraint
--                     violation, not a race the app has to win.
--   handle_format_ok  pure: 3-30 characters from a-z 0-9 . _ ; no leading,
--                     trailing or doubled dot; at least one letter or digit.
--   handle_reserved   pure: words that read as the platform (admin, support,
--                     billing, api, mcp, security ...) and anything starting
--                     with "nightshift". Dots and underscores are ignored for
--                     this test, so "a.d.m.i.n" is the same word as "admin".
--   handle_valid      both of the above; the table's CHECK uses it, so even a
--                     write that skipped the RPCs cannot store a bad handle.
--   handle_available(handle)         signed in. true / false, or NULL when this
--                                    person asked too often just now.
--   handle_available_public(handle)  signed out (sign-up form). Same answer
--                                    shape, a platform-wide ceiling instead of
--                                    a per-person one.
--   set_handle(handle)               signed in. Sets or changes MY handle and
--                                    answers with a code, never SQL text.
--
-- WHO MAY DO WHAT
--   user_handles has RLS on and exactly one policy: a signed-in person may
--   SELECT their OWN row. No API role has INSERT, UPDATE or DELETE; set_handle
--   is the only way to write. anon has no privilege on the table at all.
--   Every function is SECURITY DEFINER (or pure) with search_path pinned, with
--   explicit grants: the two signed-in RPCs go to authenticated only, the
--   signed-out check to anon and authenticated, the pure helpers to nobody
--   (the CHECK runs them as the table's owner).
--
-- WHAT AN OUTSIDER CAN LEARN
--   handle_available* answer a boolean and nothing else: not who owns a
--   handle, not whether a refusal is "taken" or "reserved", not when it was
--   set. A handle says nothing about an e-mail address, so asking is not a way
--   to find out who has an account. Asking is rate-limited all the same
--   (take_web_rate, 0042/0087, for a person; one platform-wide counter in the
--   same table for the signed-out form): handle names are not secret, but a
--   dictionary walk over them should not be free either. NULL ("ask again in
--   a minute") is never "available": the sign-up form lets the person go on,
--   and set_handle is the one that decides.
--
-- THE RULES set_handle ENFORCES
--   * first set: free, any time. Changing it afterwards: ONE change per 30
--     days. The set itself does not start that clock (changed_at = created_at
--     until the first change), so a typo seen a minute later can be fixed
--     once; after a change the next one waits 30 days.
--   * setting the handle you already have is a no-op ('same'), not a change.
--   * a person's calls are serialized (advisory lock on the user), so two tabs
--     cannot race the cooldown; two PEOPLE racing for one handle meet at the
--     unique index, and the loser gets 'taken' (never the raw SQL error).
--   * the old handle is free the moment it is replaced.
--
-- Additive and idempotent (guarded creates, create-or-replace functions,
-- repeatable revokes). Requires 0042/0087 (take_web_rate, web_rate_counters).
-- Safe to run twice. Applied by the operator after review, not by CI.

do $$
begin
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null
     or to_regclass('public.web_rate_counters') is null then
    raise exception '0096 needs 0042/0087 (take_web_rate): apply 0042_web_api_hardening.sql and 0087_audit_and_rate_hardening.sql first';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The rules, as pure functions (callable by nobody through the API)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.handle_format_ok(p text) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select p is not null
     and char_length(p) between 3 and 30
     and p ~ '^[a-z0-9._]+$'
     and p !~ '(^\.|\.$|\.\.)'
     and p ~ '[a-z0-9]'
$$;

create or replace function public.handle_reserved(p text) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select p is null
      or regexp_replace(p, '[._]', '', 'g') like 'nightshift%'
      or regexp_replace(p, '[._]', '', 'g') = any (array[
           'admin', 'administrator', 'root', 'superuser', 'sysadmin', 'support', 'help', 'helpdesk',
           'billing', 'payments', 'payment', 'invoice', 'api', 'mcp', 'oauth', 'auth', 'security',
           'system', 'staff', 'team', 'moderator', 'mod', 'operator', 'owner', 'official',
           'null', 'undefined', 'none', 'true', 'false', 'nan', 'void', 'anonymous', 'unknown',
           'login', 'logout', 'signin', 'signout', 'signup', 'register', 'account', 'accounts',
           'settings', 'profile', 'dashboard', 'console', 'app', 'www', 'web', 'mail', 'email',
           'noreply', 'postmaster', 'webmaster', 'hostmaster', 'abuse', 'info', 'contact', 'sales',
           'press', 'legal', 'privacy', 'terms', 'pricing', 'docs', 'blog', 'about', 'status',
           'channel', 'channels', 'everyone', 'here', 'all', 'me', 'you', 'user', 'users'
         ])
$$;

create or replace function public.handle_valid(p text) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select public.handle_format_ok(p) and not public.handle_reserved(p)
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The table
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.user_handles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  handle     text not null,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint user_handles_stored_lowercase check (handle = lower(handle)),
  constraint user_handles_rules check (public.handle_valid(handle))
);
create unique index if not exists user_handles_handle_lower_key on public.user_handles (lower(handle));
comment on table public.user_handles is
  'One @username per person (0096), stored lowercase and unique case-insensitively. A person reads their own row; every write goes through set_handle(), which enforces the format, the reserved words and one change per 30 days.';
alter table public.user_handles enable row level security;
revoke all on public.user_handles from public, anon, authenticated;
grant select on public.user_handles to authenticated;

drop policy if exists user_handles_select_own on public.user_handles;
create policy user_handles_select_own on public.user_handles
  for select to authenticated using (user_id = (select auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Is this handle free? (a boolean, never an owner)
-- ─────────────────────────────────────────────────────────────────────────

-- Signed in: 60 asks a minute per person. NULL when that is spent.
create or replace function public.handle_available(p_handle text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  h text := lower(coalesce(p_handle, ''));
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if not public.handle_valid(h) then
    return false;
  end if;
  if not public.take_web_rate('handle.check', 60, 60) then
    return null;
  end if;
  return not exists (select 1 from public.user_handles where lower(handle) = h);
end
$$;

-- Signed out (the sign-up form). The caller has no identity to count, and the
-- anon key is public, so the hard limit lives here: one platform-wide counter
-- (300 asks a minute, in web_rate_counters under a fixed nil user id, the way
-- take_web_rate keys a window). The Node route in front of it adds a per-address
-- limit for the page's own traffic; this ceiling is what holds when someone
-- skips the route. A malformed or reserved handle is answered without touching
-- the counter or the table.
create or replace function public.handle_available_public(p_handle text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  h       text := lower(coalesce(p_handle, ''));
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / 60) * 60);
  v_used  integer;
begin
  if not public.handle_valid(h) then
    return false;
  end if;
  insert into public.web_rate_counters as c (user_id, bucket, window_start, count)
  values ('00000000-0000-0000-0000-000000000000', 'handle.anon@60', v_start, 1)
  on conflict (user_id, bucket, window_start) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.web_rate_counters c
     where c.user_id = '00000000-0000-0000-0000-000000000000'
       and c.bucket = 'handle.anon@60' and c.window_start < v_start;
  end if;
  if v_used > 300 then
    return null;
  end if;
  return not exists (select 1 from public.user_handles where lower(handle) = h);
end
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Set or change MY handle
-- ─────────────────────────────────────────────────────────────────────────

-- Answers {"code": ...}: ok | same | invalid | taken | cooldown | rate_limited
-- (+ "handle" on ok / same, + "next_change_at" on cooldown). Reserved words
-- and handles somebody holds both read 'taken'. A business refusal is a code,
-- not an error, so the page never has to read SQL text.
create or replace function public.set_handle(p_handle text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid  uuid := auth.uid();
  h    text := lower(coalesce(p_handle, ''));
  cur  public.user_handles;
  had  boolean;
  due  timestamptz;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if not public.take_web_rate('handle.set', 10, 3600) then
    return jsonb_build_object('code', 'rate_limited');
  end if;
  if not public.handle_format_ok(h) then
    return jsonb_build_object('code', 'invalid');
  end if;
  if public.handle_reserved(h) then
    return jsonb_build_object('code', 'taken');
  end if;

  -- One call per person at a time: the cooldown below cannot be raced by two tabs.
  perform pg_advisory_xact_lock(hashtextextended('user_handle:' || uid::text, 0));
  select * into cur from public.user_handles where user_id = uid;
  had := found;

  if had then
    if cur.handle = h then
      return jsonb_build_object('code', 'same', 'handle', cur.handle);
    end if;
    -- changed_at = created_at until the first change: the first set is free.
    if cur.changed_at > cur.created_at then
      due := cur.changed_at + interval '30 days';
      if due > now() then
        return jsonb_build_object('code', 'cooldown', 'next_change_at', due);
      end if;
    end if;
  end if;

  begin
    if had then
      -- clock_timestamp(), not now(): a change must read as later than
      -- created_at even inside the transaction that made the row.
      update public.user_handles
         set handle = h, changed_at = greatest(clock_timestamp(), created_at + interval '1 microsecond')
       where user_id = uid;
    else
      insert into public.user_handles (user_id, handle) values (uid, h);
    end if;
  exception when unique_violation then
    -- Somebody else holds it (or took it a moment ago). This subtransaction is undone.
    return jsonb_build_object('code', 'taken');
  end;
  return jsonb_build_object('code', 'ok', 'handle', h);
end
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Grants (explicit; nothing is left to the default PUBLIC execute)
-- ─────────────────────────────────────────────────────────────────────────

revoke all on function public.handle_format_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.handle_reserved(text) from public, anon, authenticated, service_role;
revoke all on function public.handle_valid(text) from public, anon, authenticated, service_role;

revoke all on function public.handle_available(text) from public, anon, service_role;
grant execute on function public.handle_available(text) to authenticated;

revoke all on function public.set_handle(text) from public, anon, service_role;
grant execute on function public.set_handle(text) to authenticated;

revoke all on function public.handle_available_public(text) from public, service_role;
grant execute on function public.handle_available_public(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every row should read true)
-- ─────────────────────────────────────────────────────────────────────────
--   select (select relrowsecurity from pg_class where oid = 'public.user_handles'::regclass) as rls_on,
--          has_table_privilege('authenticated', 'public.user_handles', 'SELECT')
--            and not has_table_privilege('authenticated', 'public.user_handles', 'INSERT')
--            and not has_table_privilege('authenticated', 'public.user_handles', 'UPDATE')
--            and not has_table_privilege('authenticated', 'public.user_handles', 'DELETE')
--            and not has_table_privilege('anon', 'public.user_handles', 'SELECT') as table_closed,
--          has_function_privilege('authenticated', 'public.set_handle(text)', 'EXECUTE')
--            and not has_function_privilege('anon', 'public.set_handle(text)', 'EXECUTE') as set_handle_acl,
--          has_function_privilege('anon', 'public.handle_available_public(text)', 'EXECUTE')
--            and not has_function_privilege('anon', 'public.handle_available(text)', 'EXECUTE') as availability_acl,
--          public.handle_valid('ana.k_01') and not public.handle_valid('Ana')
--            and not public.handle_valid('a.d.m.i.n') and not public.handle_valid('nightshift_team') as rules;
