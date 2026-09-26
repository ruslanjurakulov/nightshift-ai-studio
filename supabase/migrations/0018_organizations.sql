-- 0018_organizations.sql — organizations and tenant isolation (SaaS phase C1).
--
-- Until now Nightshift was one operator's system: anyone signed in could read
-- every channel, and `app_members` (0007) held one global role. This migration
-- puts every channel inside an ORGANIZATION and makes Row Level Security
-- answer "which organizations is this user in, at what role?" before it
-- answers anything else. A user who signs up tomorrow sees nothing but the
-- organizations they create or are invited to.
--
-- WHAT IT ADDS
--   organizations   id, name, slug (unique), created_by, created_at
--   org_members     org_id, user_id, email, role owner|admin|editor|viewer —
--                   the invited-by-email / bound-by-user_id pattern of
--                   app_members, per organization
--   channels.org_id every existing channel backfilled into ONE default org,
--                   "Nightshift" (fixed id 00000000-0000-0000-0000-000000000001)
--   functions       default_org_id(), platform_role(), is_platform_admin(),
--                   in_default_org_roster(), accessible_org_ids(min_role),
--                   accessible_channel_ids(min_role), accessible_video_ids(),
--                   is_org_member(org, min_role), org_role(org),
--                   channel_org(channel_id), my_organizations(),
--                   create_organization(name), invite_org_member(org, email,
--                   role), bind_org_memberships()
--
-- LOCKOUT-SAFE BY DESIGN
--   * The default org is created once, and in the same statement every
--     current app_members row becomes a default-org membership with the SAME
--     role, and every account that already exists in auth.users (and is not
--     on the roster) becomes a default-org viewer — which is exactly what
--     0007 made an unlisted signed-in user. Nobody who can sign in today loses
--     the channels they can see today.
--   * app_members stays authoritative for the default org: a user's
--     app_members role counts as their role in the default org, so the old
--     Team page keeps working unchanged.
--   * app_members owners and admins keep GLOBAL platform access: they act as
--     owner/admin in every organization, and also see rows whose channel_id
--     names no channel at all. The operator cannot be locked out of anything.
--   * While app_members is still empty (0007's bootstrap), everyone who was
--     already able to sign in is still the effective owner. What changes is
--     that an account created AFTER this migration is not — a new sign-up can
--     no longer claim the whole platform through the bootstrap rule. It gets
--     its own organization instead.
--
-- WHAT CHANGES FOR THE `authenticated` ROLE (service role unchanged — the
-- pipeline writes with the service key, which bypasses RLS):
--
--   Scoped to the channel's organization (read at viewer; writes at the role
--   0007/0009/0014 already required, now checked IN THAT ORGANIZATION):
--     channels                  select viewer · insert/update editor (org_id)
--     channel_credentials       select viewer
--     channel_topic_performance select viewer
--     videos                    select viewer
--     feedback_signals          select viewer
--     competitor_snapshots      select viewer (via chronos_channel_id)
--     demand_signals            select viewer
--     content_queue             select viewer
--     pipeline_runs             select viewer
--     video_costs               select viewer
--     review_intents            select viewer · insert editor
--     content_series            select viewer · insert/update editor
--     publish_approvals         select viewer · insert editor (as self) ·
--                               update admin (two-person rule unchanged)
--     learnings                 select viewer · decide admin (as self)
--     storage.objects           previews bucket: read viewer (path = <channel>/…)
--   Scoped through the video's channel:
--     metrics_snapshots, retention_points   select viewer
--   Mixed streams — channel rows scoped as above, channel_id NULL (global
--   infrastructure) visible to members of the default org:
--     system_events             select
--     alert_events              select · insert
--     app_audit_log             select · insert (actor = self, unchanged)
--   Operator-level (the platform's own providers and legacy default-channel
--   scores) — visible to members of the default org only:
--     provider_balances, provider_billing_settings, provider_topups (select;
--       their admin write policies are unchanged), topic_performance (select)
--   The roster itself:
--     app_members               select: default-org members (and your own
--                               row); bootstrap claim: only an account that
--                               existed before this migration, only for itself
--   Deliberately NOT changed:
--     trending_snapshots — region-wide public YouTube data, owned by no channel.
--
-- Additive and idempotent: guarded creates, drop-then-create policies,
-- create-or-replace functions. Safe to re-run; the backfill runs only on the
-- run that creates the default org. No drop of any table or column, no delete.

create extension if not exists pgcrypto;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_by uuid,
  created_at timestamptz not null default now()
);

comment on table public.organizations is
  'A tenant. Every channel belongs to exactly one organization (channels.org_id); RLS scopes channel data to the organizations the caller is a member of. The default organization (id 00000000-0000-0000-0000-000000000001) holds every channel that existed before migration 0018.';

create table if not exists public.org_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid references auth.users (id) on delete cascade,
  -- Lower-cased on write. '' only for a pre-existing account with no email,
  -- which is then matched by user_id alone.
  email      text not null default '',
  role       text not null default 'viewer' check (role in ('owner','admin','editor','viewer')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index if not exists org_members_org_email_key
  on public.org_members (org_id, lower(email)) where email <> '';
create unique index if not exists org_members_org_user_key
  on public.org_members (org_id, user_id) where user_id is not null;
create index if not exists org_members_user_idx on public.org_members (user_id);
create index if not exists org_members_email_idx on public.org_members (lower(email)) where user_id is null;

comment on table public.org_members is
  'Who belongs to which organization, at what role. Invited by email (user_id null) and bound to the account on first sign-in, the same pattern as app_members.';

-- Emails are compared lower-cased everywhere; normalise on the way in so an
-- invite typed as "Ali@Example.com" still matches the account that signs in.
create or replace function public.org_members_normalise_email() returns trigger
  language plpgsql set search_path = public as $$
begin
  new.email := lower(btrim(coalesce(new.email, '')));
  return new;
end
$$;

drop trigger if exists org_members_normalise_email on public.org_members;
create trigger org_members_normalise_email
  before insert or update of email on public.org_members
  for each row execute function public.org_members_normalise_email();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The default organization, and the lockout-safe backfill
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.default_org_id() returns uuid
  language sql immutable set search_path = public as $$
  select '00000000-0000-0000-0000-000000000001'::uuid
$$;

-- One block, so the org and its roster appear together or not at all. The
-- backfill only runs on the run that CREATES the default org: re-running this
-- file later must not quietly make every account created since then a viewer
-- of the operator's channels.
do $$
declare
  created uuid;
begin
  insert into public.organizations (id, name, slug)
  values (public.default_org_id(), 'Nightshift', 'nightshift')
  on conflict (id) do nothing
  returning id into created;

  if created is not null then
    -- Every roster row keeps its role, bound or still invited.
    insert into public.org_members (org_id, user_id, email, role, created_by)
    select public.default_org_id(), am.user_id, lower(am.email), am.role, am.created_by
      from public.app_members am
    on conflict do nothing;

    -- Every account that can sign in today, and is not on the roster, is what
    -- 0007 made it: a viewer (or, while app_members is empty, the effective
    -- owner — platform_role() below still says so).
    insert into public.org_members (org_id, user_id, email, role)
    select public.default_org_id(), u.id, lower(coalesce(u.email, '')), 'viewer'
      from auth.users u
     where not exists (
       select 1 from public.org_members m
        where m.org_id = public.default_org_id()
          and (m.user_id = u.id or (m.email <> '' and m.email = lower(coalesce(u.email, ''))))
     )
    on conflict do nothing;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. channels.org_id
-- ───────────────────────────────────────────────────────────────────────────
-- The column default is the default org, so a writer that does not know about
-- organizations (the pipeline's first-run bootstrap, a deployment whose app is
-- older than this migration) still produces a valid row — and RLS below still
-- refuses such an insert from anyone who is not an editor of the default org.

alter table public.channels
  add column if not exists org_id uuid default '00000000-0000-0000-0000-000000000001'::uuid;
update public.channels set org_id = public.default_org_id() where org_id is null;
alter table public.channels alter column org_id set default '00000000-0000-0000-0000-000000000001'::uuid;
alter table public.channels alter column org_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'channels_org_id_fkey') then
    alter table public.channels
      add constraint channels_org_id_fkey foreign key (org_id)
      references public.organizations (id) on delete restrict;
  end if;
end $$;

create index if not exists idx_channels_org on public.channels (org_id, channel_id);

comment on column public.channels.org_id is
  'The organization that owns this channel. RLS on every channel-scoped table follows it. Defaults to the default organization.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Who the caller is
-- ───────────────────────────────────────────────────────────────────────────
-- Every function is security definer with search_path pinned, so it reads the
-- membership tables past their own RLS (no recursion) and cannot be steered
-- by a caller's search_path.

create or replace function public.app_members_empty() returns boolean
  language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.app_members)
$$;

-- Was the caller on the default org's roster — i.e. an account that existed
-- before this migration, or someone later invited to the operator's org?
create or replace function public.in_default_org_roster() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.org_members m
     where m.org_id = public.default_org_id()
       and (m.user_id = auth.uid()
            or (m.user_id is null and m.email <> ''
                and m.email = lower(coalesce(auth.jwt() ->> 'email', ''))))
  )
$$;

-- The caller's PLATFORM role: their app_members role, or null when they are
-- not on that roster. Unlike current_app_role() there is no 'viewer' default —
-- a stranger is not a member of the platform. While app_members is empty,
-- 0007's bootstrap still holds, but only for accounts on the default org's
-- roster (see header).
create or replace function public.platform_role() returns text
  language sql stable security definer set search_path = public as $$
  select case
    when public.app_members_empty() then
      case when public.in_default_org_roster() then 'owner' end
    else coalesce(
      (select role from public.app_members where user_id = auth.uid()),
      (select role from public.app_members
        where user_id is null and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        limit 1))
  end
$$;

create or replace function public.is_platform_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.platform_role() in ('owner','admin'), false)
$$;

-- 0007's function, with one change: the empty-roster bootstrap now applies
-- only to accounts on the default org's roster. Every other answer is the
-- same, so every policy and route that already calls it keeps its meaning —
-- except that a brand-new sign-up can no longer become owner of everything by
-- arriving before the owner claimed the roster.
create or replace function public.current_app_role() returns text
  language sql stable security definer set search_path = public as $$
  select coalesce(public.platform_role(), 'viewer')
$$;

-- Every organization in which the caller holds AT LEAST `min_role`. The one
-- source of truth for org access; everything below is defined in terms of it.
--   * explicit membership (bound, or invited by the JWT's email)
--   * platform owner/admin: that role in every organization
--   * any platform role: that role in the default organization
create or replace function public.accessible_org_ids(min_role text default 'viewer')
  returns setof uuid
  language sql stable security definer set search_path = public as $$
  with me as (
    select auth.uid() as uid,
           lower(coalesce(auth.jwt() ->> 'email', '')) as em,
           public.platform_role() as pr
  )
  select o.id
    from public.organizations o, me
   where me.pr in ('owner','admin')
     and public.app_role_rank(me.pr) >= public.app_role_rank(min_role)
  union
  select public.default_org_id()
    from me
   where me.pr is not null
     and public.app_role_rank(me.pr) >= public.app_role_rank(min_role)
  union
  select m.org_id
    from public.org_members m, me
   where (m.user_id = me.uid or (m.user_id is null and m.email <> '' and m.email = me.em))
     and public.app_role_rank(m.role) >= public.app_role_rank(min_role)
$$;

create or replace function public.is_org_member(org uuid, min_role text default 'viewer')
  returns boolean
  language sql stable security definer set search_path = public as $$
  select org is not null and exists (
    select 1 from public.accessible_org_ids(min_role) a where a = org
  )
$$;

-- The caller's effective role in one organization, or null. For the UI; the
-- policies use accessible_org_ids / is_org_member directly.
create or replace function public.org_role(org uuid) returns text
  language sql stable security definer set search_path = public as $$
  select r from (values ('owner'), ('admin'), ('editor'), ('viewer')) v(r)
   where public.is_org_member(org, r)
   order by public.app_role_rank(r) desc
   limit 1
$$;

create or replace function public.channel_org(ch text) returns uuid
  language sql stable security definer set search_path = public as $$
  select org_id from public.channels where channel_id = ch
$$;

create or replace function public.accessible_channel_ids(min_role text default 'viewer')
  returns setof text
  language sql stable security definer set search_path = public as $$
  select c.channel_id from public.channels c
   where c.org_id in (select public.accessible_org_ids(min_role))
$$;

create or replace function public.accessible_video_ids(min_role text default 'viewer')
  returns setof text
  language sql stable security definer set search_path = public as $$
  select v.video_id from public.videos v
   where v.channel_id in (select public.accessible_channel_ids(min_role))
$$;

-- The organization switcher's list: every org the caller can open, with their
-- role in it. The default org first, then oldest first.
create or replace function public.my_organizations()
  returns table (id uuid, name text, slug text, role text, is_default boolean)
  language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug, public.org_role(o.id), o.id = public.default_org_id()
    from public.organizations o
   where o.id in (select public.accessible_org_ids('viewer'))
   order by (o.id = public.default_org_id()) desc, o.created_at, o.name
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Creating organizations, inviting and binding members
-- ───────────────────────────────────────────────────────────────────────────

-- Called at sign-up by a user with no organization: creates it and makes the
-- caller its owner, in one transaction. Ten per account is a spam ceiling,
-- not a product limit.
create or replace function public.create_organization(p_name text) returns uuid
  language plpgsql volatile security definer set search_path = public as $$
declare
  uid    uuid := auth.uid();
  em     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  n      text := btrim(coalesce(p_name, ''));
  base   text;
  s      text;
  tries  int := 0;
  new_id uuid;
begin
  if uid is null then
    raise exception 'sign in to create an organization' using errcode = '42501';
  end if;
  if char_length(n) < 2 or char_length(n) > 80 then
    raise exception 'organization name must be 2 to 80 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.organizations where created_by = uid) >= 10 then
    raise exception 'organization limit reached for this account' using errcode = '54000';
  end if;

  base := left(btrim(regexp_replace(lower(n), '[^a-z0-9]+', '-', 'g'), '-'), 48);
  if char_length(base) < 2 then base := 'org'; end if;
  s := base;
  while exists (select 1 from public.organizations where slug = s) loop
    tries := tries + 1;
    if tries > 8 then
      raise exception 'could not find a free slug for this name' using errcode = '23505';
    end if;
    s := base || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
  end loop;

  insert into public.organizations (name, slug, created_by)
  values (n, s, uid)
  returning id into new_id;

  insert into public.org_members (org_id, user_id, email, role, created_by)
  values (new_id, uid, em, 'owner', uid);

  return new_id;
end
$$;

-- Invite (or re-role) someone by email. Admin+ of that org may invite;
-- only an owner may grant or touch 'owner' — the same rule 0007 set for
-- app_members, and the same rule the table policies below enforce.
create or replace function public.invite_org_member(p_org uuid, p_email text, p_role text)
  returns uuid
  language plpgsql volatile security definer set search_path = public as $$
declare
  em       text := lower(btrim(coalesce(p_email, '')));
  existing public.org_members%rowtype;
  out_id   uuid;
begin
  if p_role not in ('owner','admin','editor','viewer') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;
  if not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin may invite' using errcode = '42501';
  end if;

  select * into existing from public.org_members
   where org_id = p_org and email = em;

  if (p_role = 'owner' or existing.role = 'owner')
     and not public.is_org_member(p_org, 'owner') then
    raise exception 'only an owner may grant or change an owner' using errcode = '42501';
  end if;

  if existing.id is not null then
    update public.org_members set role = p_role where id = existing.id returning id into out_id;
  else
    insert into public.org_members (org_id, email, role, created_by)
    values (p_org, em, p_role, auth.uid())
    returning id into out_id;
  end if;
  return out_id;
end
$$;

-- Bind every invite addressed to the caller's email to their account. Only
-- ever the caller's own email, only unbound rows, and never a second row in an
-- org where the caller is already bound.
create or replace function public.bind_org_memberships() returns int
  language plpgsql volatile security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  em  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  n   int := 0;
begin
  if uid is null or em = '' then
    return 0;
  end if;
  update public.org_members m
     set user_id = uid
   where m.user_id is null
     and m.email = em
     and not exists (
       select 1 from public.org_members b where b.org_id = m.org_id and b.user_id = uid
     );
  get diagnostics n = row_count;
  return n;
end
$$;

-- An organization must keep an owner. Enforced for dashboard users; the SQL
-- editor and the service role (no auth.uid()) can still repair anything.
create or replace function public.org_members_keep_owner() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.org_id <> old.org_id)
     and not exists (
       select 1 from public.org_members o
        where o.org_id = old.org_id and o.role = 'owner' and o.id <> old.id
     ) then
    raise exception 'an organization must keep at least one owner' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

drop trigger if exists org_members_keep_owner on public.org_members;
create trigger org_members_keep_owner
  before update or delete on public.org_members
  for each row execute function public.org_members_keep_owner();

-- Moving a channel to another organization takes admin in BOTH — editor is
-- enough to edit a channel, not to hand it (and its history) to someone else.
create or replace function public.channels_org_guard() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and new.org_id is distinct from old.org_id
     and not (public.is_org_member(old.org_id, 'admin') and public.is_org_member(new.org_id, 'admin')) then
    raise exception 'moving a channel between organizations requires admin in both' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists channels_org_guard on public.channels;
create trigger channels_org_guard
  before update of org_id on public.channels
  for each row execute function public.channels_org_guard();

-- Nobody signed out may call the write helpers; the read helpers answer
-- "nothing" to an anonymous caller anyway.
revoke execute on function public.create_organization(text) from public, anon;
revoke execute on function public.invite_org_member(uuid, text, text) from public, anon;
revoke execute on function public.bind_org_memberships() from public, anon;
grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.invite_org_member(uuid, text, text) to authenticated;
grant execute on function public.bind_org_memberships() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. RLS on the new tables
-- ───────────────────────────────────────────────────────────────────────────

alter table public.organizations enable row level security;
alter table public.org_members enable row level security;

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using (id in (select public.accessible_org_ids('viewer')));

-- Renaming is the only direct write; creation goes through
-- create_organization(), and nothing deletes an organization from a browser.
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update to authenticated
  using (id in (select public.accessible_org_ids('admin')))
  with check (id in (select public.accessible_org_ids('admin')));

revoke insert, update, delete on public.organizations from anon, authenticated;
grant select on public.organizations to authenticated;
grant update (name) on public.organizations to authenticated;

drop policy if exists org_members_select on public.org_members;
create policy org_members_select on public.org_members
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')) or user_id = auth.uid());

-- Owner/admin manage members; only an owner may create, alter or remove an
-- owner row, or promote someone to owner. Mirrors app_members (0007).
drop policy if exists org_members_insert on public.org_members;
create policy org_members_insert on public.org_members
  for insert to authenticated
  with check (
    org_id in (select public.accessible_org_ids('admin'))
    and (role <> 'owner' or org_id in (select public.accessible_org_ids('owner')))
  );

drop policy if exists org_members_update on public.org_members;
create policy org_members_update on public.org_members
  for update to authenticated
  using (
    org_id in (select public.accessible_org_ids('admin'))
    and (role <> 'owner' or org_id in (select public.accessible_org_ids('owner')))
  )
  with check (
    org_id in (select public.accessible_org_ids('admin'))
    and (role <> 'owner' or org_id in (select public.accessible_org_ids('owner')))
  );

drop policy if exists org_members_delete on public.org_members;
create policy org_members_delete on public.org_members
  for delete to authenticated
  using (
    org_id in (select public.accessible_org_ids('admin'))
    and (role <> 'owner' or org_id in (select public.accessible_org_ids('owner')))
  );

-- Column grants: a browser may set who and at what role, never bind a row to
-- an account (bind_org_memberships() does that, for the caller only) or
-- rewrite the audit fields.
revoke insert, update on public.org_members from anon, authenticated;
grant select, delete on public.org_members to authenticated;
grant insert (org_id, email, role) on public.org_members to authenticated;
grant update (role) on public.org_members to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. RLS on the existing tables
-- ───────────────────────────────────────────────────────────────────────────
-- Pattern: `x in (select fn(...))` — the set is computed once per statement
-- (a hashed subplan), not once per row. `(select public.is_platform_admin())`
-- is likewise an init-plan. The platform-admin clause is what keeps rows whose
-- channel_id names no channel visible to the operator, exactly as today.

-- 7a. channels
drop policy if exists channels_auth_read on public.channels;
create policy channels_auth_read on public.channels
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists channels_auth_insert on public.channels;
create policy channels_auth_insert on public.channels
  for insert to authenticated
  with check (org_id in (select public.accessible_org_ids('editor')));

drop policy if exists channels_auth_update on public.channels;
create policy channels_auth_update on public.channels
  for update to authenticated
  using (org_id in (select public.accessible_org_ids('editor')))
  with check (org_id in (select public.accessible_org_ids('editor')));

-- 7b. read-only channel-scoped tables (their only authenticated policy is a
-- select named <table>_auth_read, from schema.sql / 0001 / 0002).
do $$
declare
  t   text;
  col text;
begin
  for t, col in
    select * from (values
      ('channel_credentials',       'channel_id'),
      ('channel_topic_performance', 'channel_id'),
      ('videos',                    'channel_id'),
      ('feedback_signals',          'channel_id'),
      ('competitor_snapshots',      'chronos_channel_id'),
      ('demand_signals',            'channel_id'),
      ('content_queue',             'channel_id'),
      ('pipeline_runs',             'channel_id'),
      ('video_costs',               'channel_id')
    ) v(t, col)
  loop
    execute format('drop policy if exists %I on public.%I', t || '_auth_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || '%I in (select public.accessible_channel_ids(''viewer'')) '
      || 'or (select public.is_platform_admin()))',
      t || '_auth_read', t, col
    );
  end loop;
end $$;

-- 7c. reached through the video's channel
do $$
declare t text;
begin
  foreach t in array array['metrics_snapshots', 'retention_points']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_auth_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || 'video_id in (select public.accessible_video_ids(''viewer'')) '
      || 'or (select public.is_platform_admin()))',
      t || '_auth_read', t
    );
  end loop;
end $$;

-- 7d. mixed streams: NULL channel_id is global infrastructure, which belongs
-- to the operator — the default org.
drop policy if exists system_events_auth_read on public.system_events;
create policy system_events_auth_read on public.system_events
  for select to authenticated
  using (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (channel_id is null and (select public.is_org_member(public.default_org_id(), 'viewer')))
    or (select public.is_platform_admin())
  );

drop policy if exists alert_events_select on public.alert_events;
create policy alert_events_select on public.alert_events
  for select to authenticated
  using (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (channel_id is null and (select public.is_org_member(public.default_org_id(), 'viewer')))
    or (select public.is_platform_admin())
  );

-- 0010 let any signed-in operator append; still any role, now only within
-- the caller's own channels (or the global feed, for the operator's org).
drop policy if exists alert_events_insert on public.alert_events;
create policy alert_events_insert on public.alert_events
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (channel_id is null and (select public.is_org_member(public.default_org_id(), 'viewer')))
  );

drop policy if exists app_audit_log_select on public.app_audit_log;
create policy app_audit_log_select on public.app_audit_log
  for select to authenticated
  using (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (channel_id is null and (select public.is_org_member(public.default_org_id(), 'viewer')))
    or (select public.is_platform_admin())
  );

drop policy if exists app_audit_log_insert on public.app_audit_log;
create policy app_audit_log_insert on public.app_audit_log
  for insert to authenticated
  with check (
    actor_user_id = auth.uid()
    and (
      channel_id in (select public.accessible_channel_ids('viewer'))
      or (channel_id is null and (select public.is_org_member(public.default_org_id(), 'viewer')))
    )
  );

-- 7e. review intents — editor files, in the channel's org (0007's rule).
drop policy if exists review_intents_select on public.review_intents;
create policy review_intents_select on public.review_intents
  for select to authenticated
  using (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (select public.is_platform_admin())
  );

drop policy if exists review_intents_insert on public.review_intents;
create policy review_intents_insert on public.review_intents
  for insert to authenticated
  with check (channel_id in (select public.accessible_channel_ids('editor')));

-- 7f. content series — editor writes (0007), and a series cannot be moved
-- onto a channel of an org where the caller is not an editor.
drop policy if exists content_series_select on public.content_series;
create policy content_series_select on public.content_series
  for select to authenticated
  using (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (select public.is_platform_admin())
  );

drop policy if exists content_series_auth_insert on public.content_series;
create policy content_series_auth_insert on public.content_series
  for insert to authenticated
  with check (channel_id in (select public.accessible_channel_ids('editor')));

drop policy if exists content_series_auth_update on public.content_series;
create policy content_series_auth_update on public.content_series
  for update to authenticated
  using (channel_id in (select public.accessible_channel_ids('editor')))
  with check (channel_id in (select public.accessible_channel_ids('editor')));

-- 7g. publish approvals — the two-person rule is unchanged; the roles are now
-- checked in the channel's organization.
drop policy if exists publish_approvals_select on public.publish_approvals;
create policy publish_approvals_select on public.publish_approvals
  for select to authenticated
  using (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (select public.is_platform_admin())
  );

drop policy if exists publish_approvals_insert on public.publish_approvals;
create policy publish_approvals_insert on public.publish_approvals
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('editor'))
    and requested_by = auth.uid()
  );

drop policy if exists publish_approvals_update on public.publish_approvals;
create policy publish_approvals_update on public.publish_approvals
  for update to authenticated
  using (channel_id in (select public.accessible_channel_ids('admin')))
  with check (
    channel_id in (select public.accessible_channel_ids('admin'))
    and decided_by = auth.uid()
    and decided_by <> requested_by
  );

-- 7h. learnings — admin decides, as themselves, in the channel's org. The
-- column grants from 0014 (decision columns only) are untouched.
drop policy if exists learnings_select on public.learnings;
create policy learnings_select on public.learnings
  for select to authenticated
  using (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (select public.is_platform_admin())
  );

drop policy if exists learnings_decide on public.learnings;
create policy learnings_decide on public.learnings
  for update to authenticated
  using (channel_id in (select public.accessible_channel_ids('admin')))
  with check (
    channel_id in (select public.accessible_channel_ids('admin'))
    and decided_by = auth.uid()
    and status in ('approved', 'rejected')
  );

-- 7i. operator-level tables: the platform's own provider accounts and the
-- legacy default-channel score table. Visible to the operator's org only.
-- (The provider write policies from 0012 already require admin via
-- current_app_role(), whose bootstrap is tightened above.)
drop policy if exists provider_balances_select on public.provider_balances;
create policy provider_balances_select on public.provider_balances
  for select to authenticated
  using ((select public.is_org_member(public.default_org_id(), 'viewer')));

drop policy if exists provider_billing_settings_select on public.provider_billing_settings;
create policy provider_billing_settings_select on public.provider_billing_settings
  for select to authenticated
  using ((select public.is_org_member(public.default_org_id(), 'viewer')));

drop policy if exists provider_topups_select on public.provider_topups;
create policy provider_topups_select on public.provider_topups
  for select to authenticated
  using ((select public.is_org_member(public.default_org_id(), 'viewer')));

drop policy if exists topic_performance_auth_read on public.topic_performance;
create policy topic_performance_auth_read on public.topic_performance
  for select to authenticated
  using ((select public.is_org_member(public.default_org_id(), 'viewer')));

-- 7j. the platform roster. Its write policies from 0007 are unchanged (they
-- call current_app_role(), tightened above); reading it, and the bootstrap
-- claim, are narrowed to the operator's own people.
drop policy if exists app_members_select on public.app_members;
create policy app_members_select on public.app_members
  for select to authenticated
  using (
    (select public.is_org_member(public.default_org_id(), 'viewer'))
    or user_id = auth.uid()
  );

drop policy if exists app_members_bootstrap on public.app_members;
create policy app_members_bootstrap on public.app_members
  for insert to authenticated
  with check (
    role = 'owner'
    and user_id = auth.uid()
    and public.app_members_empty()
    and public.in_default_org_roster()
  );

-- 7k. review previews: objects are stored as <channel_id>/<video_id>.mp4.
drop policy if exists previews_read on storage.objects;
create policy previews_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'previews'
    and (
      (storage.foldername(name))[1] in (select public.accessible_channel_ids('viewer'))
      or (select public.is_platform_admin())
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every row should read true / the expected value)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from public.organizations where id = public.default_org_id()) = 1
--     as default_org_exists,
--   (select count(*) from public.channels where org_id is null) = 0
--     as every_channel_has_an_org,
--   (select count(*) from public.channels where org_id <> public.default_org_id()) = 0
--     as every_existing_channel_in_default_org,
--   (select count(*) from public.app_members am
--     where not exists (select 1 from public.org_members m
--                        where m.org_id = public.default_org_id()
--                          and lower(m.email) = lower(am.email) and m.role = am.role)) = 0
--     as roster_mapped_with_same_roles,
--   (select count(*) from auth.users u
--     where not exists (select 1 from public.org_members m
--                        where m.org_id = public.default_org_id()
--                          and (m.user_id = u.id or m.email = lower(coalesce(u.email, ''))))) = 0
--     as every_existing_account_on_default_roster,
--   (select count(*) from pg_policies
--     where schemaname = 'public' and roles::text like '%authenticated%'
--       and cmd = 'SELECT' and qual = 'true'
--       and tablename <> 'trending_snapshots') = 0
--     as no_open_select_policy_left;
