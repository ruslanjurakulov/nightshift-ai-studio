-- 0043_invites_accept.sql — an invite is an offer: confirmed email, explicit accept.
--
-- Two holes in how email invites worked since 0007 / 0018 (security audit P1,
-- C6):
--
--   P1  An invite was claimed by whoever presented the invited address in the
--       JWT's `email` claim. The claim is not proof of the address: an account
--       whose email is not confirmed carries it too (Supabase with "Confirm
--       email" off; an OAuth identity whose provider did not verify the
--       address). Signing up as ceo@victim.test was enough to join the org
--       that invited ceo@victim.test — at the invited role, owner included —
--       and, for the platform roster, to become platform admin.
--
--   C6  A pending invite already WAS membership: accessible_org_ids() matched
--       unbound rows by email, and the dashboard called
--       bind_org_memberships() on every page load, which bound every invite
--       addressed to the caller. Anyone could put anyone into their
--       organization, without being asked.
--
-- WHAT CHANGES
--   * my_confirmed_email(): the caller's address from auth.users, and only
--     when auth.users.email_confirmed_at is set. It replaces the JWT claim
--     everywhere an address grants something.
--   * Org access (accessible_org_ids, hence is_org_member, org_role,
--     my_organizations, every org-scoped policy) comes from BOUND membership
--     only (org_members.user_id = auth.uid()). A pending invite grants
--     nothing until it is accepted.
--   * my_invites(), accept_org_invite(id), decline_org_invite(id): the
--     invitee sees the invites addressed to their confirmed address and
--     chooses. Accepting binds that one row; declining deletes it.
--   * bind_org_memberships() keeps its signature and does nothing (returns
--     0): an older dashboard still calling it on page load must not bind.
--   * The platform roster (app_members, the operator's own team) keeps its
--     bind-on-sign-in, but only for a confirmed address; so does
--     in_default_org_roster(), which now counts bound members only.
--
-- Nobody already bound loses anything: every membership bound before this
-- migration keeps working. Pending invites stay pending and now show up for
-- the invitee to accept. Function signatures are unchanged; three are new.
--
-- Additive and idempotent: create-or-replace functions, revoke/grant.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The caller's CONFIRMED address
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.my_confirmed_email() returns text
  language sql stable security definer set search_path = public as $$
  select nullif(lower(btrim(coalesce(u.email, ''))), '')
    from auth.users u
   where u.id = auth.uid()
     and u.email_confirmed_at is not null
$$;

comment on function public.my_confirmed_email() is
  'The signed-in user''s email from auth.users, lower-cased, only when it is confirmed; else NULL. Use it wherever an email address grants something — never the JWT claim.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Access comes from bound membership only
-- ───────────────────────────────────────────────────────────────────────────

-- 0018's definition with the email branch removed: an unbound invite row is
-- an offer, not a membership.
create or replace function public.accessible_org_ids(min_role text default 'viewer')
  returns setof uuid
  language sql stable security definer set search_path = public as $$
  with me as (
    select auth.uid() as uid, public.platform_role() as pr
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
   where me.uid is not null
     and m.user_id = me.uid
     and public.app_role_rank(m.role) >= public.app_role_rank(min_role)
$$;

-- Bound default-org members only (it decides 0007's empty-roster bootstrap).
create or replace function public.in_default_org_roster() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.org_members m
     where m.org_id = public.default_org_id()
       and m.user_id = auth.uid()
  )
$$;

-- The platform roster: a row bound to the caller, or one invited to their
-- CONFIRMED address (bound on first use by bind_current_member).
create or replace function public.platform_role() returns text
  language sql stable security definer set search_path = public as $$
  select case
    when public.app_members_empty() then
      case when public.in_default_org_roster() then 'owner' end
    else coalesce(
      (select role from public.app_members where user_id = auth.uid()),
      (select role from public.app_members
        where user_id is null
          and public.my_confirmed_email() is not null
          and lower(email) = public.my_confirmed_email()
        limit 1))
  end
$$;

create or replace function public.bind_current_member() returns text
  language plpgsql security definer set search_path = public as $$
declare
  em text := public.my_confirmed_email();
begin
  if em is not null then
    update public.app_members
       set user_id = auth.uid()
     where user_id is null and lower(email) = em;
  end if;
  return public.current_app_role();
end
$$;

-- Kept for older dashboards that call it on every page load; it no longer
-- binds anything. Accepting is accept_org_invite().
create or replace function public.bind_org_memberships() returns int
  language sql stable security definer set search_path = public as $$
  select 0
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Invites the invitee accepts or declines
-- ───────────────────────────────────────────────────────────────────────────

-- The invites addressed to the caller's confirmed address, for orgs they are
-- not already in. The org's name is all the invitee learns about it.
create or replace function public.my_invites()
  returns table (id uuid, org_id uuid, org_name text, role text, invited_at timestamptz)
  language sql stable security definer set search_path = public as $$
  select m.id, m.org_id, o.name, m.role, m.created_at
    from public.org_members m
    join public.organizations o on o.id = m.org_id
   where m.user_id is null
     and public.my_confirmed_email() is not null
     and m.email = public.my_confirmed_email()
     and not exists (select 1 from public.org_members b
                      where b.org_id = m.org_id and b.user_id = auth.uid())
   order by m.created_at
$$;

create or replace function public.accept_org_invite(p_invite uuid) returns uuid
  language plpgsql volatile security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  em  text := public.my_confirmed_email();
  inv public.org_members;
begin
  if uid is null or em is null then
    raise exception 'confirm your email address to accept an invitation' using errcode = '42501';
  end if;
  select * into inv from public.org_members
   where id = p_invite and user_id is null and email = em
   for update;
  if inv.id is null then
    raise exception 'no such invitation for this account' using errcode = '42501';
  end if;
  if exists (select 1 from public.org_members b where b.org_id = inv.org_id and b.user_id = uid) then
    -- Already a member (bound some other way): the offer is spent.
    delete from public.org_members where id = inv.id;
    return inv.org_id;
  end if;
  update public.org_members set user_id = uid where id = inv.id;
  return inv.org_id;
end
$$;

create or replace function public.decline_org_invite(p_invite uuid) returns boolean
  language plpgsql volatile security definer set search_path = public as $$
declare
  em text := public.my_confirmed_email();
  n  int;
begin
  if auth.uid() is null or em is null then
    raise exception 'confirm your email address to answer an invitation' using errcode = '42501';
  end if;
  delete from public.org_members
   where id = p_invite and user_id is null and email = em;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'no such invitation for this account' using errcode = '42501';
  end if;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Grants: signed-in callers only
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.my_confirmed_email()',
    'public.my_invites()',
    'public.accept_org_invite(uuid)',
    'public.decline_org_invite(uuid)',
    'public.accessible_org_ids(text)',
    'public.in_default_org_roster()',
    'public.platform_role()',
    'public.bind_current_member()',
    'public.bind_org_memberships()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  f text;
begin
  -- No function that grants access may still read the address from the JWT.
  foreach f in array array['accessible_org_ids', 'in_default_org_roster', 'platform_role',
                           'bind_current_member', 'bind_org_memberships'] loop
    if exists (select 1 from pg_proc
                where proname = f and pronamespace = 'public'::regnamespace
                  and prosrc ~ 'jwt\(\)') then
      raise exception '0043 verify: %() still reads the JWT', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.accept_org_invite(uuid)', 'execute') then
    raise exception '0043 verify: anon can call accept_org_invite()';
  end if;
end $$;
