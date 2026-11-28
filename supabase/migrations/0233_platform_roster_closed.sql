-- 0233_platform_roster_closed.sql: nobody is added to the platform roster, re-roled on it or removed from it from a browser.
-- Ledger BR-L-213 (docs/security/LEDGER.md).
--
-- Owner decision (2026-11-28): the site has two kinds of people, the owner/operator and users. Each user owns their own
-- workspace and does everything in it; nobody adds anybody to anything. 0091 already closed the workspace side (org_members:
-- no invite, accept, decline or direct write for a signed-in caller). This file closes the last door the Team page left behind.
--
-- EVIDENCE (the security lab, every migration up to 0230 applied to a fresh database):
--   has_function_privilege('authenticated', 'public.owner_add_member(text,text,text)', 'EXECUTE')          true
--   has_function_privilege('authenticated', 'public.owner_set_member_role(uuid,text,text)', 'EXECUTE')     true
--   has_function_privilege('authenticated', 'public.owner_remove_member(uuid,text)', 'EXECUTE')            true
--   has_table_privilege('authenticated', 'public.app_members', 'INSERT' / 'UPDATE' / 'DELETE')               true
--   and four RLS policies for authenticated on app_members (0007 admin_insert / admin_update / admin_delete, 0018 bootstrap).
--   So a signed-in platform owner or admin could still add a person to the operator's roster at any role, change a role or
--   remove someone, with one REST call or one rpc, after the Command Center lost its Team page (the same PR as this file).
--   The direct writes also skip 0107's last-owner, self-change and owner-only checks (BR-S-024, BR-S-029).
-- DIAGNOSIS. The rule "no team" lived in a screen again; the database still granted the writes.
-- CHANGE. Privileges only:
--   * EXECUTE on owner_add_member, owner_set_member_role and owner_remove_member is revoked from public, anon and authenticated
--     (0107 already revoked it from service_role, so only the database owner, the SQL editor, may call them).
--   * INSERT, UPDATE and DELETE on public.app_members are revoked from anon and authenticated. SELECT stays (a person reads their
--     own row; the operator reads the roster: platform_role, Approvals). service_role keeps its privileges.
-- NOT CHANGED (deliberately): no object is dropped or replaced. The four app_members write policies stay; without the privilege
--   they decide nothing, and RLS stays on. bind_current_member() (0007/0043, security definer) still links a signed-in account to
--   a roster row the operator added in the SQL editor. Every role check in RLS and SQL (is_org_member(org, 'editor'),
--   platform_role(), current_app_role()) is unchanged: every user is the owner of their own workspace. Credits, spend and
--   publishing are untouched. Friend invites (0092) and referrals are a credits program, not membership: untouched.
-- THE OPERATOR'S ROSTER from now on is changed in the SQL editor, where auth.uid() is null:
--     insert into public.app_members (email, role) values ('<address>', 'admin');
--     delete from public.app_members where lower(email) = lower('<address>') and role <> 'owner';
--   (Keep at least one bound owner with a confirmed address; 0107's functions checked that for a caller, the editor does not.)
--   A fresh project with an empty roster no longer lets the first signed-in person claim it from a page (0018's bootstrap
--   policy needed INSERT): the operator inserts their own row the same way.
-- REQUIRES 0007 (app_members), 0091 (org_members closed; checked below) and 0107 (the three functions). The file refuses to apply,
--   naming the missing one, rather than revoking half.
-- Re-applying 0007, 0018 or 0107 alone after this file re-grants what it revokes (Supabase default privileges, 0107's explicit
--   grants); apply 0233 again after them. Replay-twice safe: revokes and a read-only end-state check.
-- Rollback: docs/sql/rollback_0233_platform_roster_closed.sql (owner-applied; re-grants exactly what this file revokes).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
-- No backslash anywhere in this file: the live apply path once rewrote backslash escapes inside SQL text (0219's header).
set local lock_timeout = '5s';

-- 0. Preconditions --------------------------------------------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.app_members') is null then
    raise exception '0233: public.app_members does not exist; apply 0007 first';
  end if;
  if to_regprocedure('public.owner_add_member(text,text,text)') is null
     or to_regprocedure('public.owner_set_member_role(uuid,text,text)') is null
     or to_regprocedure('public.owner_remove_member(uuid,text)') is null then
    raise exception '0233: the roster functions of 0107 are missing; apply 0107 first';
  end if;
end
$$;

-- 1. The roster functions ---------------------------------------------------------------------------------------------------------

revoke all on function public.owner_add_member(text, text, text) from public, anon, authenticated;
revoke all on function public.owner_set_member_role(uuid, text, text) from public, anon, authenticated;
revoke all on function public.owner_remove_member(uuid, text) from public, anon, authenticated;

-- 2. The direct writes ------------------------------------------------------------------------------------------------------------

-- A table-level revoke also removes any column grant of the same privilege.
revoke insert, update, delete on public.app_members from anon, authenticated;

-- 3. End state (refuses the whole transaction if any of it is not so) ---------------------------------------------------------

do $$
declare
  r   text;
  fn  text;
  prv text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach fn in array array['public.owner_add_member(text,text,text)', 'public.owner_set_member_role(uuid,text,text)',
                              'public.owner_remove_member(uuid,text)'] loop
      if has_function_privilege(r, fn, 'EXECUTE') then
        raise exception '0233 end state: % may still execute %', r, fn;
      end if;
    end loop;
    foreach prv in array array['INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(r, 'public.app_members', prv) then
        raise exception '0233 end state: % still has % on public.app_members', r, prv;
      end if;
      -- 0091's half, read again: a re-applied 0018 or 0043 would have re-opened the workspace side.
      if has_table_privilege(r, 'public.org_members', prv) then
        raise exception '0233 end state: % has % on public.org_members; apply 0091 again, then this file', r, prv;
      end if;
    end loop;
    foreach fn in array array['public.invite_org_member(uuid,text,text)', 'public.accept_org_invite(uuid)',
                              'public.decline_org_invite(uuid)', 'public.my_invites()'] loop
      if to_regprocedure(fn) is not null and has_function_privilege(r, fn, 'EXECUTE') then
        raise exception '0233 end state: % may execute %; apply 0091 again, then this file', r, fn;
      end if;
    end loop;
  end loop;
  if not has_table_privilege('authenticated', 'public.app_members', 'SELECT') then
    raise exception '0233 end state: authenticated lost SELECT on public.app_members (platform_role and Approvals read it)';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.app_members'::regclass) then
    raise exception '0233 end state: row level security is off on public.app_members';
  end if;
end
$$;

-- Verify (the SQL editor, after applying; every column should read true):
--   select
--     not has_function_privilege('authenticated', 'public.owner_add_member(text,text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.owner_set_member_role(uuid,text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.owner_remove_member(uuid,text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.owner_add_member(text,text,text)', 'EXECUTE') as roster_functions_closed,
--     not has_table_privilege('authenticated', 'public.app_members', 'INSERT')
--       and not has_table_privilege('authenticated', 'public.app_members', 'UPDATE')
--       and not has_table_privilege('authenticated', 'public.app_members', 'DELETE')
--       and not has_table_privilege('anon', 'public.app_members', 'INSERT') as roster_writes_closed,
--     has_table_privilege('authenticated', 'public.app_members', 'SELECT') as roster_still_readable,
--     not has_table_privilege('authenticated', 'public.org_members', 'INSERT')
--       and not has_function_privilege('authenticated', 'public.accept_org_invite(uuid)', 'EXECUTE') as workspace_side_closed,
--     (select count(*) from public.app_members where role = 'owner' and user_id is not null) >= 1 as operator_still_owner;
