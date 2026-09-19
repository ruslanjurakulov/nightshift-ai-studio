-- 0007_rbac.sql — role-based access for the Command Center.
--
-- Roles, most to least privileged:
--   owner   — everything, including managing members and granting/removing owners
--   admin   — everything except that only an owner may touch an owner row
--   editor  — manage content (channels, series, review decisions); NOT secrets,
--             provider routing, on-demand runs, or members
--   viewer  — read only
--
-- LOCKOUT-SAFE BY DESIGN. While `app_members` is empty the effective role of
-- every signed-in user is 'owner' — exactly today's all-admin behavior — so
-- applying this migration changes nothing until the first member row exists.
-- The first person claims ownership from the Members page; after that, unlisted
-- users fall to 'viewer'.
--
-- Idempotent: guarded creates and drop-then-create policies, safe to re-run.

create extension if not exists pgcrypto;

create table if not exists public.app_members (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null default 'viewer' check (role in ('owner','admin','editor','viewer')),
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index if not exists app_members_email_key on public.app_members (lower(email));
create unique index if not exists app_members_user_key on public.app_members (user_id) where user_id is not null;

comment on table public.app_members is
  'Who may use the Command Center and at what role. Empty = bootstrap: every signed-in user is owner until the first row exists.';

-- The caller's effective role. security definer so it reads app_members under
-- RLS. Empty table -> owner (no lockout on first apply). A row bound by
-- user_id wins; else a row invited by email (user_id still null) matches on the
-- JWT email; else viewer.
create or replace function public.current_app_role() returns text
  language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from public.app_members) then 'owner'
    else coalesce(
      (select role from public.app_members where user_id = auth.uid()),
      (select role from public.app_members
        where user_id is null and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        limit 1),
      'viewer')
  end
$$;

-- Numeric rank for "at least this role" checks.
create or replace function public.app_role_rank(r text) returns int
  language sql immutable as $$
  select case r when 'owner' then 4 when 'admin' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end
$$;

-- Bind an invited-by-email row to the signed-in user on first use, then return
-- the role. security definer so it can update under RLS; it only ever binds the
-- caller's own email, and only a row that has not been bound yet.
create or replace function public.bind_current_member() returns text
  language plpgsql security definer set search_path = public as $$
declare
  em text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if em <> '' then
    update public.app_members
       set user_id = auth.uid()
     where user_id is null and lower(email) = em;
  end if;
  return public.current_app_role();
end
$$;

alter table public.app_members enable row level security;

-- Everyone signed in can see the roster (emails and roles — no secrets here).
drop policy if exists app_members_select on public.app_members;
create policy app_members_select on public.app_members
  for select to authenticated using (true);

-- The very first owner claims themselves while the table is still empty.
drop policy if exists app_members_bootstrap on public.app_members;
create policy app_members_bootstrap on public.app_members
  for insert to authenticated
  with check (role = 'owner' and not exists (select 1 from public.app_members));

-- Owner/admin add members. Only an owner may create an 'owner'.
drop policy if exists app_members_admin_insert on public.app_members;
create policy app_members_admin_insert on public.app_members
  for insert to authenticated
  with check (
    public.current_app_role() in ('owner','admin')
    and (role <> 'owner' or public.current_app_role() = 'owner')
  );

-- Owner/admin change roles. Only an owner may alter a row that IS an owner or
-- promote someone TO owner.
drop policy if exists app_members_admin_update on public.app_members;
create policy app_members_admin_update on public.app_members
  for update to authenticated
  using (
    public.current_app_role() in ('owner','admin')
    and (role <> 'owner' or public.current_app_role() = 'owner')
  )
  with check (
    public.current_app_role() in ('owner','admin')
    and (role <> 'owner' or public.current_app_role() = 'owner')
  );

-- Owner/admin remove members. A non-owner can never remove an owner.
drop policy if exists app_members_admin_delete on public.app_members;
create policy app_members_admin_delete on public.app_members
  for delete to authenticated
  using (
    public.current_app_role() in ('owner','admin')
    and (role <> 'owner' or public.current_app_role() = 'owner')
  );

-- ── Harden the content write policies: editor and up may change content, a
--    viewer cannot. Empty app_members -> role is 'owner' -> behavior unchanged.
--    (The original policies were `with check (true)`; nothing else is lost.)
drop policy if exists channels_auth_insert on public.channels;
create policy channels_auth_insert on public.channels
  for insert to authenticated
  with check (public.app_role_rank(public.current_app_role()) >= public.app_role_rank('editor'));

drop policy if exists channels_auth_update on public.channels;
create policy channels_auth_update on public.channels
  for update to authenticated
  using (public.app_role_rank(public.current_app_role()) >= public.app_role_rank('editor'))
  with check (public.app_role_rank(public.current_app_role()) >= public.app_role_rank('editor'));

drop policy if exists review_intents_insert on public.review_intents;
create policy review_intents_insert on public.review_intents
  for insert to authenticated
  with check (public.app_role_rank(public.current_app_role()) >= public.app_role_rank('editor'));

drop policy if exists content_series_auth_insert on public.content_series;
create policy content_series_auth_insert on public.content_series
  for insert to authenticated
  with check (public.app_role_rank(public.current_app_role()) >= public.app_role_rank('editor'));

drop policy if exists content_series_auth_update on public.content_series;
create policy content_series_auth_update on public.content_series
  for update to authenticated
  using (public.app_role_rank(public.current_app_role()) >= public.app_role_rank('editor'))
  with check (public.app_role_rank(public.current_app_role()) >= public.app_role_rank('editor'));
