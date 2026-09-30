-- 0033_roles_cleanup.sql — self-serve customers have no role; the operator's
-- data is the platform admin's alone.
--
-- Owner decision: a self-serve customer does not deal with owner / admin /
-- editor / viewer. The person who creates a workspace owns it
-- (create_organization, 0018), and that is the whole story they see. The
-- platform owner/admin (app_members, 0007) stays. Team roles stay in the
-- database — about 130 policy and function checks read them, and a future
-- Business/Teams plan will switch them back on — but no policy may hand
-- anything to "any signed-in user" by way of a default role.
--
-- AUDIT (final state after 0001–0032; the security lab in tests/security
-- enumerates every RLS table and checks this against a live database)
--
--   object                         final check (before)                         exposed?            after
--   current_app_role()             platform role, else 'viewer'                 'viewer' for every   platform role, else NULL
--                                                                               signup (callers
--                                                                               only used it for
--                                                                               >= admin today)
--   app_members select             member of the DEFAULT org, or own row         every default-org   platform admin, or own row
--                                                                               member
--   app_members insert/update/     current_app_role() in (owner, admin)          no                  unchanged (same answer)
--     delete, bootstrap
--   provider_balances select       member of the default org                    every default-org   platform admin
--   provider_billing_settings      select: default-org member;                   select: yes         platform admin
--                                  write: rank(current_app_role()) >= admin      write: no
--   provider_topups                select: default-org member;                   select: yes         platform admin
--                                  insert: rank(current_app_role()) >= admin     insert: no
--   topic_performance select       member of the default org                    every default-org   platform admin
--   system_events select           channel rows by org; channel-less rows to     global rows: yes    channel rows by org;
--                                  any default-org member                                            global rows platform admin
--   alert_events select / insert   same shape                                    global rows: yes    same, platform admin
--   app_audit_log select / insert  same shape                                    global rows: yes    same, platform admin
--   review_intents insert          editor of the channel's org; video_id         another org's       video must be on that
--                                  unchecked                                     video id accepted   same channel
--   every other RLS table          org-scoped (accessible_org_ids /              no                  unchanged
--                                  accessible_channel_ids / is_org_member)
--   tenancy helper functions       executable by anon (channel_org names any     enumeration         authenticated and
--                                  channel's organization to the internet)                            service_role only
--
-- "Every default-org member" is not a hypothetical: 0018 made every account
-- that existed when it ran a viewer of the default organization, and anyone
-- invited to the operator's organization since is one too. Those accounts read
-- the operator's provider balances, top-ups and billing settings, the global
-- event, alert and audit streams, and the platform roster, without being
-- platform admins.
--
-- Nothing here weakens a check: every rewritten policy grants the platform
-- admin exactly what it did before (is_platform_admin() implied default-org
-- membership), and grants no one else anything new. Function signatures are
-- unchanged. The render_jobs policy and the api_* functions are not touched
-- here (they belong to other migrations).
--
-- LOCKOUT CHECK before applying: the operator must be on the platform roster.
--   select role, email from public.app_members where role in ('owner','admin');
-- An empty result means nobody can read the operator tables after this runs.
-- The Verify block at the end raises a WARNING in that case.
--
-- Additive and idempotent: drop-then-create policies, create-or-replace
-- functions, revoke/grant. Safe to re-run.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. current_app_role(): no default role for someone not on the roster
-- ───────────────────────────────────────────────────────────────────────────
-- Same signature, same answer for everyone on app_members. A signed-in user
-- who is not on the roster used to get 'viewer', which is what made "the
-- caller's role is at least viewer" true of every signup. Now it is NULL, and
-- NULL passes no role comparison (app_role_rank(null) = 0).
create or replace function public.current_app_role() returns text
  language sql stable security definer set search_path = public as $$
  select public.platform_role()
$$;

comment on function public.current_app_role() is
  'The caller''s platform role (app_members), or NULL when they are not on the platform roster. Kept for 0007-era callers; new code uses platform_role() / is_platform_admin().';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Operator-only tables: the platform admin, not the default org's members
-- ───────────────────────────────────────────────────────────────────────────

drop policy if exists app_members_select on public.app_members;
create policy app_members_select on public.app_members
  for select to authenticated
  using ((select public.is_platform_admin()) or user_id = (select auth.uid()));

drop policy if exists provider_balances_select on public.provider_balances;
create policy provider_balances_select on public.provider_balances
  for select to authenticated using ((select public.is_platform_admin()));

drop policy if exists provider_billing_settings_select on public.provider_billing_settings;
create policy provider_billing_settings_select on public.provider_billing_settings
  for select to authenticated using ((select public.is_platform_admin()));

drop policy if exists provider_billing_settings_update on public.provider_billing_settings;
create policy provider_billing_settings_update on public.provider_billing_settings
  for update to authenticated
  using ((select public.is_platform_admin()))
  with check ((select public.is_platform_admin()));

drop policy if exists provider_billing_settings_write on public.provider_billing_settings;
create policy provider_billing_settings_write on public.provider_billing_settings
  for insert to authenticated with check ((select public.is_platform_admin()));

drop policy if exists provider_topups_select on public.provider_topups;
create policy provider_topups_select on public.provider_topups
  for select to authenticated using ((select public.is_platform_admin()));

drop policy if exists provider_topups_insert on public.provider_topups;
create policy provider_topups_insert on public.provider_topups
  for insert to authenticated with check ((select public.is_platform_admin()));

drop policy if exists topic_performance_auth_read on public.topic_performance;
create policy topic_performance_auth_read on public.topic_performance
  for select to authenticated using ((select public.is_platform_admin()));

-- Mixed streams: a row with a channel is that channel's organization's; a row
-- with no channel is the operator's own infrastructure.
drop policy if exists system_events_auth_read on public.system_events;
create policy system_events_auth_read on public.system_events
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer'))
         or (select public.is_platform_admin()));

drop policy if exists alert_events_select on public.alert_events;
create policy alert_events_select on public.alert_events
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer'))
         or (select public.is_platform_admin()));

drop policy if exists alert_events_insert on public.alert_events;
create policy alert_events_insert on public.alert_events
  for insert to authenticated
  with check (channel_id in (select public.accessible_channel_ids('viewer'))
              or (channel_id is null and (select public.is_platform_admin())));

drop policy if exists app_audit_log_select on public.app_audit_log;
create policy app_audit_log_select on public.app_audit_log
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer'))
         or (select public.is_platform_admin()));

drop policy if exists app_audit_log_insert on public.app_audit_log;
create policy app_audit_log_insert on public.app_audit_log
  for insert to authenticated
  with check (actor_user_id = (select auth.uid())
              and (channel_id in (select public.accessible_channel_ids('viewer'))
                   or (channel_id is null and (select public.is_platform_admin()))));

-- ───────────────────────────────────────────────────────────────────────────
-- 3. review_intents: an intent names a video on its own channel
-- ───────────────────────────────────────────────────────────────────────────
-- The policy checked only the channel, so an editor of org B could file
-- "approve" / "regenerate" against org A's video id under B's channel. The
-- dashboard always sends the video's own channel (ReviewPanel,
-- RegenerateSceneButton), so this refuses nothing it does. The videos lookup
-- runs under the caller's own RLS: a video they cannot see does not match.
drop policy if exists review_intents_insert on public.review_intents;
create policy review_intents_insert on public.review_intents
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('editor'))
    and (video_id is null
         or exists (select 1 from public.videos v
                     where v.video_id = review_intents.video_id
                       and v.channel_id = review_intents.channel_id))
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Tenancy helpers: signed-in callers only
-- ───────────────────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE on every new function to anon. For these that let
-- the internet ask channel_org('<any id>') which organization owns a channel,
-- or whether the roster is still unclaimed. No policy evaluated for anon
-- calls them (every policy that does is `to authenticated`), and the api_*
-- entry points anon calls run as their owner, so nothing anon does needs them.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.accessible_channel_ids(text)',
    'public.accessible_org_ids(text)',
    'public.accessible_video_ids(text)',
    'public.app_members_empty()',
    'public.bind_current_member()',
    'public.channel_org(text)',
    'public.current_app_role()',
    'public.in_default_org_roster()',
    'public.is_org_member(uuid, text)',
    'public.is_platform_admin()',
    'public.my_organizations()',
    'public.org_role(uuid)',
    'public.platform_role()'
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
  admins int;
  loose  text;
begin
  -- A caller with no claims (the SQL editor) is on no roster: NULL, not 'viewer'.
  if public.current_app_role() is not null then
    raise exception '0033 verify: current_app_role() still defaults to a role';
  end if;

  if has_function_privilege('anon', 'public.channel_org(text)', 'execute') then
    raise exception '0033 verify: anon can still call channel_org()';
  end if;

  -- No policy on an operator table may still admit a default-org member.
  select string_agg(tablename || '.' || policyname, ', ') into loose
    from pg_policies
   where schemaname = 'public'
     and tablename in ('app_members', 'provider_balances', 'provider_billing_settings',
                       'provider_topups', 'topic_performance', 'system_events',
                       'alert_events', 'app_audit_log')
     and (coalesce(qual, '') || coalesce(with_check, '')) like '%default_org_id%';
  if loose is not null then
    raise exception '0033 verify: operator tables still admit default-org members: %', loose;
  end if;

  -- An empty roster is 0007's bootstrap (the default org's roster are owners
  -- until someone claims it); a claimed roster needs an owner or admin.
  select count(*) into admins from public.app_members where role in ('owner', 'admin');
  if admins = 0 and not public.app_members_empty() then
    raise warning '0033: app_members has no owner or admin — the operator tables are now unreadable from the dashboard until one exists (see the LOCKOUT CHECK in this file''s header)';
  end if;
end $$;
