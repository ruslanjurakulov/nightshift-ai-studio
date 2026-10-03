-- 0091_simple_accounts.sql: a workspace has one person. Ledger BR-L-174 .. BR-L-177.
--
-- Owner decision (repeated, now done): the product has exactly two kinds of
-- people, an ordinary signed-in user who owns and does everything in their own
-- workspace, and the platform operator (is_platform_admin(), app_members), who
-- also sees the operator pages. There is no team, no role picker and no invite
-- on the customer side. 0033 already hid roles from customers; this file takes
-- away the doors behind the screen, so the rule does not depend on a page
-- that is no longer there.
--
-- WHAT STAYS (deliberately)
--   * the `role` column of public.org_members and every RLS policy and function that
--     reads it: about 130 checks, among them
--     is_org_member(), accessible_org_ids(), org_role(), inbox_real_member()
--     and the notification audiences. Nothing here edits one of them, so
--     no earlier check is dropped (and no function body is replaced: this file
--     has no `create or replace` of an older function). create_organization()
--     (0018) still makes the caller the 'owner' of the workspace they create, so
--     every user is the strongest role of their own workspace and of nothing else.
--   * the platform roster (app_members, bind_current_member, platform_role,
--     is_platform_admin): that is the operator, not a customer team.
--   * select on org_members (a person reads their own membership row) and the
--     rename of an organization (organizations_update, 0018).
--
-- WHAT GOES
--   BR-L-174  The invite entry points. invite_org_member, accept_org_invite,
--             decline_org_invite and my_invites lose EXECUTE for public, anon and
--             authenticated (service_role and the database owner keep it). Nobody
--             signed in can invite, accept, decline or list an invitation.
--   BR-L-175  The direct writes. org_members_insert / _update / _delete are
--             dropped and INSERT / UPDATE / DELETE are revoked from anon and
--             authenticated: a member row cannot be added, re-roled or removed
--             from a browser (REST) any more, by an owner either. With RLS on and
--             no policy, a later careless grant still refuses.
--   BR-L-176  Structure, not only privilege: a BEFORE INSERT trigger refuses a
--             second row in a workspace that already has one when a signed-in user
--             (auth.uid() is not null) is the caller. create_organization() adds the
--             first row of a new workspace and passes; a definer function that
--             someone later grants to authenticated cannot add a second person.
--             The SQL editor and the service role (no auth.uid()) can still repair.
--   BR-L-177  Pending invitations already in the database. Every unbound row
--             (user_id is null) is deleted. Since 0043 such a row granted nothing
--             and could only be turned into membership by accept_org_invite(), which
--             is now closed; deleting them leaves no row that could ever be a back
--             door (for example if a later migration re-granted accept_org_invite).
--             The number deleted is raised as a NOTICE.
--
-- EXISTING EXTRA MEMBERS (bound rows beyond the first of a workspace) are NOT
-- touched. Recommended and implemented: keep their access exactly as it is, offer no
-- screen for it. That cannot lock an owner out (it removes nobody), cannot
-- escalate anybody (no role can be changed from any API any more), and is
-- reversible by the operator. The NOTICE below counts them. To remove one on purpose,
-- the operator runs, in the SQL editor (auth.uid() is null there, so the trigger
-- and the last-owner guard stay out of the way, and the guard is checked by hand):
--   delete from public.org_members m
--    where m.org_id = '<workspace id>' and m.user_id = '<user id>' and m.role <> 'owner';
-- The list to review:
--   select o.name, m.email, m.role from public.org_members m join public.organizations o
--     on o.id = m.org_id where m.user_id is not null and m.role <> 'owner'
--    order by o.name, m.created_at;
--
-- DEPLOY ORDER: ship the Command Center build first, then apply this file (an
-- older Command Center would show an invite form whose button fails once this is
-- applied; the new one never calls any of it). Applying this file before the
-- deploy breaks nothing else: the old Settings page shows the failure message of
-- its own invite button, and the old invitation panel renders nothing when
-- my_invites() is refused.
--
-- RE-APPLYING 0018 OR 0043 ALONE AFTER THIS FILE re-creates the three org_members
-- policies, the column grants and the EXECUTE grants of the four functions. Apply
-- 0091 again after them. In a fresh build the order 0018, 0043, 0091 is the filename
-- order. Replay-twice safe: drop policy if exists, revoke, `create or replace` of this
-- file's own trigger function, drop trigger if exists, a delete of rows that no longer
-- exist, and a counting block that only reads.
--
-- REQUIRES 0018, 0043.

-- 1. The invite entry points -----------------------------------------------------------------

revoke all on function public.invite_org_member(uuid, text, text) from public, anon, authenticated;
revoke all on function public.accept_org_invite(uuid) from public, anon, authenticated;
revoke all on function public.decline_org_invite(uuid) from public, anon, authenticated;
revoke all on function public.my_invites() from public, anon, authenticated;

-- 2. No direct write to org_members from a browser -------------------------------------------

drop policy if exists org_members_insert on public.org_members;
drop policy if exists org_members_update on public.org_members;
drop policy if exists org_members_delete on public.org_members;

-- A table-level revoke also removes the column grants 0018 gave (org_id, email,
-- role on insert; role on update). Select stays: a person reads their own row.
revoke insert, update, delete on public.org_members from anon, authenticated;

-- 3. A workspace never gets a second person from a signed-in caller ---------------------------

create or replace function public.org_members_one_person() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null
     and exists (select 1 from public.org_members m where m.org_id = new.org_id) then
    raise exception 'a workspace has one person' using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.org_members_one_person() from public, anon, authenticated;

drop trigger if exists org_members_one_person on public.org_members;
create trigger org_members_one_person
  before insert on public.org_members
  for each row execute function public.org_members_one_person();

-- 4. Pending invitations already in the database ----------------------------------------------

do $$
declare
  dropped int;
  extra   int;
begin
  delete from public.org_members where user_id is null;
  get diagnostics dropped = row_count;

  select count(*) into extra
    from public.org_members m
   where m.user_id is not null
     and m.role <> 'owner';

  raise notice '0091: % pending invitation(s) deleted; % bound non-owner member row(s) left as they are (see this file''s header for the list and the removal statement)',
    dropped, extra;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Verify (run after applying; every column should read true)
-- ---------------------------------------------------------------------------------------------
-- select
--   not has_function_privilege('authenticated', 'public.invite_org_member(uuid,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.accept_org_invite(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.decline_org_invite(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.my_invites()', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.invite_org_member(uuid,text,text)', 'EXECUTE') as invites_closed,
--   not has_table_privilege('authenticated', 'public.org_members', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.org_members', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.org_members', 'DELETE')
--     and has_table_privilege('authenticated', 'public.org_members', 'SELECT') as direct_writes_closed,
--   not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_members'
--                and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')) as no_write_policy,
--   exists (select 1 from pg_trigger where tgrelid = 'public.org_members'::regclass
--            and tgname = 'org_members_one_person' and not tgisinternal) as one_person_trigger,
--   not exists (select 1 from public.org_members where user_id is null) as no_pending_invites,
--   (select prosecdef and p.proconfig::text like '%search_path%' from pg_proc p
--     where p.proname = 'org_members_one_person' and p.pronamespace = 'public'::regnamespace) as definer_pinned;
