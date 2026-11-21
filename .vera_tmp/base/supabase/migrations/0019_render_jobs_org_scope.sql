-- 0019_render_jobs_org_scope.sql — the render queue joins the tenant boundary.
--
-- 0017 (render_jobs) and 0018 (organizations) were written side by side, and
-- 0018 re-scoped every channel table except this one. Two gaps were left:
--
--   * render_jobs_select was `to authenticated using (true)`: anyone signed
--     in — a brand-new sign-up included — could read every tenant's job rows
--     (channel, topic, params, timestamps, the scrubbed error). 0018's own
--     verify query (`no_open_select_policy_left`) reads false until this runs.
--   * render_jobs_insert asked for admin through current_app_role(): the
--     PLATFORM role. An admin of one organization was refused on their own
--     channel, and nothing tied the job's channel to an organization at all.
--
-- After this migration, for the `authenticated` role:
--
--   select   the job's channel is in an organization where the caller is at
--            least viewer (accessible_channel_ids('viewer')), or the caller is
--            a platform owner/admin — the same rule as every channel table in
--            0018, which keeps rows whose channel no longer exists visible to
--            the operator.
--   insert   EVERY 0017 restriction, unchanged: kind 'daily', status 'queued',
--            attempts 0 of 3, no worker-owned column set, no privacy (so the
--            worker runs private), no resume, no repair_scenes, only the
--            whitelisted params, filed as the caller (requested_by =
--            auth.uid()). The one change: "admin" is now admin IN THE
--            CHANNEL'S ORGANIZATION (accessible_channel_ids('admin')).
--            Platform owners/admins keep it everywhere through the helper, as
--            in 0018; a channel that does not exist is refused.
--   update / delete / claim   still nobody: no policy, table privileges
--            revoked, and claim_render_job stays service-role only. The worker
--            (service key) is unaffected — it bypasses RLS.
--   anon     still nothing.
--
-- Nothing here lets a browser ask for more publishing or spend than 0017
-- did: the insert is narrower or equal on every column, and the only role
-- that gains anything is an organization admin, on their own organization's
-- channels.
--
-- Requires 0017 and 0018; stops with the remedy if either is missing.
-- Additive and idempotent: drop-then-create policies, revokes, grants. Safe to
-- re-run. No table, column or row is dropped or changed.

do $$
begin
  if to_regclass('public.render_jobs') is null then
    raise exception '0019 needs public.render_jobs: apply 0017_render_jobs.sql first';
  end if;
  if to_regprocedure('public.accessible_channel_ids(text)') is null
     or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0019 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
end $$;

alter table public.render_jobs enable row level security;
revoke all on public.render_jobs from anon;

-- ── select: viewer in the job's channel's organization ─────────────────────
-- `x in (select fn(...))` is computed once per statement (a hashed subplan),
-- and `(select is_platform_admin())` is an init-plan — 0018's pattern.
drop policy if exists render_jobs_select on public.render_jobs;
create policy render_jobs_select on public.render_jobs
  for select to authenticated
  using (
    channel_id in (select public.accessible_channel_ids('viewer'))
    or (select public.is_platform_admin())
  );

-- ── insert: exactly 0017's "Run now" row, by an admin of the channel's org ──
drop policy if exists render_jobs_insert on public.render_jobs;
create policy render_jobs_insert on public.render_jobs
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('admin'))
    and requested_by = auth.uid()
    and kind = 'daily'
    and status = 'queued'
    and attempts = 0
    and max_attempts = 3
    and worker_id is null
    and heartbeat_at is null
    and started_at is null
    and finished_at is null
    and error is null
    and (params - array['topic','niche','duration','language','visual_style',
                        'video_provider','image_provider']) = '{}'::jsonb
  );

-- ── update / delete: the worker's service key only ─────────────────────────
-- 0017 never created these policies; dropping any that were added by hand
-- since, and revoking the privileges, makes "only the worker changes a job"
-- hold even if someone later adds a permissive policy by mistake.
drop policy if exists render_jobs_update on public.render_jobs;
drop policy if exists render_jobs_delete on public.render_jobs;
revoke update, delete, truncate on public.render_jobs from authenticated;
grant select, insert on public.render_jobs to authenticated;

-- The claim stays the worker's. Re-asserted so this file alone states the
-- whole access picture of the table.
revoke all on function public.claim_render_job(text, interval) from public, anon, authenticated;
grant execute on function public.claim_render_job(text, interval) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and cmd = 'SELECT' and qual = 'true') = 0
--     as no_open_select_on_render_jobs,
--   (select qual from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and policyname = 'render_jobs_select') like '%accessible_channel_ids%'
--     as select_is_org_scoped,
--   (select with_check from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and policyname = 'render_jobs_insert') like '%accessible_channel_ids(''admin''%'
--     and (select with_check from pg_policies
--           where schemaname = 'public' and tablename = 'render_jobs'
--             and policyname = 'render_jobs_insert') not like '%current_app_role%'
--     as insert_needs_admin_in_channel_org,
--   (select count(*) from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and cmd in ('UPDATE', 'DELETE', 'ALL')) = 0
--     as no_browser_update_or_delete,
--   not has_table_privilege('authenticated', 'public.render_jobs', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.render_jobs', 'DELETE')
--     as update_delete_revoked,
--   not has_function_privilege('authenticated', 'public.claim_render_job(text, interval)', 'EXECUTE')
--     as claim_is_worker_only,
--   not has_table_privilege('anon', 'public.render_jobs', 'SELECT')
--     as anon_gets_nothing,
--   (select count(*) from pg_policies
--     where schemaname = 'public' and roles::text like '%authenticated%'
--       and cmd = 'SELECT' and qual = 'true'
--       and tablename <> 'trending_snapshots') = 0
--     as no_open_select_policy_left_anywhere;
