-- 0164_public_site_stats.sql — live public counters for the marketing site, built but HIDDEN until the owner turns them on with
-- one command. docs/PUBLIC_STATS.md, docs/MIGRATIONS.md "0164".
--
-- *** LIVE ON APPLY, and still invisible: the switch it adds starts OFF, and while it is off the public read answers
-- *** {"visible": false} and nothing else. Nothing is shown on the site until a platform owner/admin runs
-- ***   select public.set_public_stats_visible(true);
-- *** and, even then, not until at least 5 customer workspaces are counted (the k rule below).
--
-- WHY. The owner's decision: build the counters now, show them when real user traffic grows, and showing them must need no
-- redeploy. The site reads with the ANON key only, and every table these numbers come from is closed to anon (videos, intents,
-- jobs: per-tenant rows), so the numbers are computed by SECURITY DEFINER functions that hand out aggregates and nothing else.
--
-- WHAT IT ADDS (one table, four functions, one pg_cron job when pg_cron is installed; it replaces nothing and alters no existing
-- table)
--   site_settings                     one row (id is the constant true). public_stats_visible boolean NOT NULL DEFAULT false: the
--                                     switch. stats / stats_at: the last stored measurement and when it was taken (see "COST").
--                                     updated_by / updated_at: who last turned the switch. No API role may read or write it (RLS on,
--                                     no policy, every grant revoked): only the functions below touch it. A missing row reads as
--                                     hidden.
--   public_site_stats()               anon and authenticated. The site's read. It answers {"visible": false} and nothing else when
--                                     the switch is off, when no measurement has been stored yet, or when fewer than 5 customer
--                                     workspaces are counted (k rule). Otherwise: the stored measurement plus "visible": true and
--                                     "as_of" (when it was measured, never "now" for an older one). The SQL editor (a session with no
--                                     API claims and no API role) and a signed-in platform owner/admin get a fresh measurement at any
--                                     time (the preview), with "visible" saying whether the site would show it and two keys only the
--                                     preview carries: counted_orgs and min_counted_orgs.
--   set_public_stats_visible(boolean) authenticated (the function itself refuses everyone but a platform owner/admin, through
--                                     owner_guard(), 0107: 42501 before anything is read, the second factor, 10 calls per 10 minutes)
--                                     and the SQL editor (the database owner's own door, which already holds every power this
--                                     grants). Not anon, not the service key. A change writes ONE security_events row
--                                     ('site.public_stats', from, to, via admin | sql_editor) in the same transaction, so a change that
--                                     cannot be audited does not happen; the owner's Security page lists it (owner_security_events,
--                                     0107). A call that changes nothing writes no event. Turning it on stores the first measurement.
--   public_site_stats_refresh()       internal (no API role; pg_cron runs it as the database owner): while the switch is on, measure
--                                     and store. Returns whether it measured.
--   public_site_stats_measure()       internal (no API role): the measurement itself.
--
-- WHAT IS MEASURED (every value is a count of rows that exist, or null: nothing is a constant, an estimate, or a default)
--   videos_rendered          videos rows that hold a finished cut: a recorded master hash (cut_sha256, 0112) or an upload
--                            (published_at, or publish_state 'uploaded', 0016). A held row a gate stopped before the render has
--                            neither and is not counted. A LOWER BOUND, and labelled "at least": a held cut recorded before 0112
--                            has no hash.
--   videos_uploaded_private  uploaded videos that went to YouTube as private: their recorded privacy is 'private', or a read-back
--                            of YouTube before a "publish when approved" request (video_visibility_requests.before_privacy, 0116)
--                            said 'private' (they were private, then a person's approval made them public). An upload that went
--                            public straight away (a channel with auto publish on) is not counted.
--   videos_approved          distinct videos (channel, video) a person approved: review_intents rows of action 'approve' that carry
--                            the approved cut's hash and the approver (written only by approve_video_publish, 0112; intents are
--                            never edited or deleted, so a later repair that cleared the video's approval columns does not erase it).
--   studio_generations       creative_jobs (0036) with status 'completed'.
--   last_run_at              the hour (UTC, truncated) in which the newest queue run finished: render_jobs (0017) of kind 'daily'
--                            or 'repair' with status 'succeeded'. Null when there is none, never a made-up time. An hour, not a
--                            minute, so a tenant cannot match the time to its own run.
--   counted_orgs             (stored and shown to the preview only) distinct customer organizations with at least one row in any
--                            of the counts above.
--   A count is a number (0 is a measured zero); last_run_at is null when nothing has finished. No rate, ratio or percentage is
--   computed here: a small sample would make one meaningless, and none is needed.
--
-- THE K RULE (inference by difference). A customer knows its own counts; with one or two other counted workspaces, the totals
--   minus its own would be another tenant's numbers. So the public read shows nothing until counted_orgs >= 5, whatever the switch
--   says. The preview shows counted_orgs, so the owner can see why the strip is still hidden.
--
-- WHAT IS LEFT OUT: the operator's own and internal workspaces. A row counts only when it belongs to an organization that is NOT
--   (a) the operator's own workspace, public.default_org_id() (0018; credit-exempt by design, the rule 0138's Customers page uses), and
--   NOT (b) a workspace one of whose members is a bound account on the platform staff roster (org_members.user_id = app_members.user_id,
--   0007): the operator's staff test from their own workspaces. A row with no organization (a channel that is gone, a channel with
--   no org) is not counted either: it cannot be shown not to be ours. Matched by user id only, never by a typed e-mail, so a customer
--   cannot exclude or include a workspace by naming an address.
--
-- WHAT IT NEVER RETURNS (publicly): an organization, user, channel, video id, title, topic, e-mail, any per-tenant row, or
--   counted_orgs. Only visible, as_of, videos_rendered, videos_uploaded_private, videos_approved, studio_generations, last_run_at.
--
-- COST AND FRESHNESS. public_site_stats() is executable by anon, so anon does not measure on demand. A measurement is stored when
--   the switch is turned on, and refreshed every 10 minutes by pg_cron ('nightshift-public-site-stats') where pg_cron is installed.
--   Without pg_cron, once the stored one is older than 15 minutes, the one caller that takes a transaction-level advisory lock
--   measures and stores it (the others are given the older one); in a read-only transaction (a GET) the store is skipped, never an
--   error. Anon never measures when nothing is stored yet: it is told hidden. The Command Center keeps an answer 5 minutes
--   (lib/server/public-stats.ts), so a switch change shows on the site within about 5 minutes, and a number on the page was measured
--   at most about 15 minutes earlier with pg_cron, about 20 without; its "as of" says exactly when.
--
-- WHAT IT DOES NOT CHANGE. No existing table, policy, grant or function. No publishing, privacy, approval, credit or job path reads it.
--
-- REQUIRES 0007 (app_members), 0016 (videos.publish_state), 0017 (render_jobs), 0018 (organizations, org_members, default_org_id,
-- is_platform_admin), 0036 (creative_jobs), 0107 (owner_guard, security_event_log), 0112 (videos.cut_sha256,
-- review_intents.approved_cut_sha256) and 0116 (video_visibility_requests). Additive and idempotent: create table if not exists, one
-- insert ... on conflict do nothing, create-or-replace of four functions that did not exist, revoke then grant,
-- unschedule-then-schedule of this file's cron job. A replay changes nothing (the switch keeps its value). Undo:
-- docs/sql/rollback_0164_public_site_stats.sql (owner-applied).
--
-- NUMBER. 0164, assigned to this branch. 0163 is held by an unmerged branch (#736) and is not reused; this file names nothing of it.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select to_regclass('public.site_settings') is null as table_is_new,
--          to_regprocedure('public.public_site_stats()') is null as read_is_new,
--          to_regprocedure('public.owner_guard(text, integer)') is not null as has_0107,
--          to_regclass('public.video_visibility_requests') is not null as has_0116;
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  pair text[];
  h text;
begin
  if to_regclass('public.app_members') is null then
    raise exception '0164 needs 0007_rbac.sql (app_members): apply it first';
  end if;
  if to_regclass('public.organizations') is null or to_regclass('public.org_members') is null
     or to_regprocedure('public.default_org_id()') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0164 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regclass('public.render_jobs') is null then
    raise exception '0164 needs 0017_render_jobs.sql: apply it first';
  end if;
  if to_regclass('public.creative_jobs') is null then
    raise exception '0164 needs 0036_creative_jobs.sql: apply it first';
  end if;
  if to_regprocedure('public.owner_guard(text, integer)') is null
     or to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0164 needs 0107_owner_safety.sql (owner_guard, security_event_log): apply it first';
  end if;
  if to_regclass('public.video_visibility_requests') is null then
    raise exception '0164 needs 0116_visibility_requests.sql: apply it first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'publish_state') then
    raise exception '0164 needs videos.publish_state: apply 0016_held_videos.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'cut_sha256')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'review_intents' and column_name = 'approved_cut_sha256') then
    raise exception '0164 needs videos.cut_sha256 and review_intents.approved_cut_sha256: apply 0112_approve_video_publish.sql first';
  end if;
  -- Every function this file creates: absent, or this file's own body (a replay).
  foreach pair slice 1 in array array[
      ['public.public_site_stats_measure()', 'e1fa900daf83fb55af871d3e118f8a31'],
      ['public.public_site_stats_refresh()', '022ce0de3feaebde13aadd1432fcc626'],
      ['public.public_site_stats()', 'fe0dfed7b1abb856b161b35d8cfd6abb'],
      ['public.set_public_stats_visible(boolean)', '0b1793721bf2bb7aaad4c0eb248704e6']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is not null and h <> pair[2] then
      raise exception '0164 found % with a body that is not this file''s (md5 %): read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The switch (one row, OFF)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.site_settings (
  id                   boolean primary key default true check (id),
  public_stats_visible boolean not null default false,
  stats                jsonb check (stats is null or jsonb_typeof(stats) = 'object'),
  stats_at             timestamptz,
  updated_by           uuid,
  updated_at           timestamptz not null default now()
);
insert into public.site_settings (id) values (true) on conflict (id) do nothing;

comment on table public.site_settings is
  'The public site''s switches (0164). One row. public_stats_visible (default false) shows the live counters; changed only by set_public_stats_visible(), which refuses anyone but a platform owner/admin or the SQL editor and writes a security_events row. stats/stats_at: the last stored measurement (with counted_orgs, which only the preview shows). No API role reads or writes this table.';
comment on column public.site_settings.public_stats_visible is
  'Show the "Live from our pipeline" counters on the site. false (the default) = public_site_stats() answers {"visible": false} and nothing else. On, they still show only once at least 5 customer workspaces are counted.';

alter table public.site_settings enable row level security;
revoke all on public.site_settings from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The measurement (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- Every count is over rows of organizations that are neither the operator's own nor a staff member's (the header says why).
create or replace function public.public_site_stats_measure() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with internal as (
    select public.default_org_id() as org_id
    union
    select m.org_id from public.org_members m join public.app_members a on a.user_id = m.user_id
  ),
  counted as (
    select c.channel_id, c.org_id
      from public.channels c
     where c.org_id is not null
       and not exists (select 1 from internal x where x.org_id = c.org_id)
  ),
  rendered as (
    select k.org_id
      from public.videos v join counted k on k.channel_id = v.channel_id
     where v.cut_sha256 is not null or v.published_at is not null or v.publish_state = 'uploaded'
  ),
  private_uploads as (
    select k.org_id
      from public.videos v join counted k on k.channel_id = v.channel_id
     where v.privacy = 'private'
        or exists (select 1 from public.video_visibility_requests r
                    where r.video_id = v.video_id and r.channel_id = v.channel_id and r.before_privacy = 'private')
  ),
  approvals as (
    select i.channel_id, i.video_id, k.org_id
      from public.review_intents i join counted k on k.channel_id = i.channel_id
     where i.action = 'approve' and i.approved_cut_sha256 is not null and i.created_by is not null and i.video_id is not null
  ),
  generations as (
    select j.org_id
      from public.creative_jobs j
     where j.status = 'completed'
       and not exists (select 1 from internal x where x.org_id = j.org_id)
  ),
  runs as (
    select r.finished_at, k.org_id
      from public.render_jobs r join counted k on k.channel_id = r.channel_id
     where r.status = 'succeeded' and r.kind in ('daily', 'repair') and r.finished_at is not null
  )
  select jsonb_build_object(
    'videos_rendered',
      (select count(*) from rendered),
    'videos_uploaded_private',
      (select count(*) from private_uploads),
    'videos_approved',
      (select count(distinct (a.channel_id, a.video_id)) from approvals a),
    'studio_generations',
      (select count(*) from generations),
    'last_run_at',
      (select date_trunc('hour', max(u.finished_at) at time zone 'UTC') at time zone 'UTC' from runs u),
    'counted_orgs',
      (select count(distinct o.org_id) from (select org_id from rendered union all select org_id from private_uploads
                                             union all select org_id from approvals union all select org_id from generations
                                             union all select org_id from runs) o))
$$;

comment on function public.public_site_stats_measure() is
  'Live public counters (0164): videos_rendered (a lower bound), videos_uploaded_private, videos_approved, studio_generations (counts), last_run_at (the UTC hour, null when none) and counted_orgs (customer organizations with any counted row), over organizations that are neither default_org_id() nor a platform staff member''s. Internal: no API role.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The stored measurement's writer (internal; pg_cron and the switch call it)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.public_site_stats_refresh() returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not coalesce((select st.public_stats_visible from public.site_settings st where st.id), false) then
    return false;
  end if;
  update public.site_settings set stats = public.public_site_stats_measure(), stats_at = now() where id;
  return true;
end
$$;

comment on function public.public_site_stats_refresh() is
  'Live public counters (0164): while the switch is on, measure and store (site_settings.stats, stats_at). pg_cron runs it every 10 minutes where installed; set_public_stats_visible(true) runs it once. Internal: no API role.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The public read
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.public_site_stats() returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k_min   constant integer := 5;
  s       public.site_settings;
  shown   boolean;
  preview boolean;
  invoker text;
  v       jsonb;
  v_at    timestamptz;
begin
  select * into s from public.site_settings where id;
  shown := coalesce(s.public_stats_visible, false);
  -- The SQL editor and a signed-in platform owner/admin: a fresh measurement at any time, with what the site would do with it and
  -- the number of counted workspaces. Never stored from here. The editor is an ALLOW-list: no API claims, and the role the call
  -- runs as (the SET ROLE, else the login) is not an API role and is a member of postgres. A role that merely inherits
  -- authenticated and carries no claims is not the editor.
  invoker := case when coalesce(current_setting('role', true), 'none') = 'none' then session_user::text
                  else current_setting('role', true) end;
  preview := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
              and invoker not in ('anon', 'authenticated', 'service_role', 'authenticator')
              and pg_has_role(invoker::name, 'postgres', 'member'))
             or (auth.uid() is not null and public.is_platform_admin());
  if preview then
    v := public.public_site_stats_measure();
    return v || jsonb_build_object('visible', shown and coalesce((v ->> 'counted_orgs')::integer, 0) >= k_min,
                                   'as_of', now(), 'min_counted_orgs', k_min);
  end if;
  -- Everyone else: hidden while the switch is off, and never a measurement on demand when none is stored yet.
  if not shown or s.stats is null or s.stats_at is null then
    return jsonb_build_object('visible', false);
  end if;
  v := s.stats;
  v_at := s.stats_at;
  -- Without pg_cron the stored one ages: past 15 minutes, one caller measures again; the others are given the older one.
  if v_at <= now() - interval '15 minutes' and pg_try_advisory_xact_lock(hashtext('public.public_site_stats')) then
    v := public.public_site_stats_measure();
    v_at := now();
    begin
      update public.site_settings set stats = v, stats_at = v_at where id;
    exception when read_only_sql_transaction then
      null;  -- a GET runs read-only: answer with the fresh numbers, store nothing
    end;
  end if;
  -- The k rule: below 5 counted workspaces, the totals minus a customer's own would be another tenant's numbers.
  if coalesce((v ->> 'counted_orgs')::integer, 0) < k_min then
    return jsonb_build_object('visible', false);
  end if;
  return (v - 'counted_orgs') || jsonb_build_object('visible', true, 'as_of', v_at);
end
$$;

comment on function public.public_site_stats() is
  'Live public counters (0164). {"visible": false} only while the switch is off, while nothing is stored yet, or while fewer than 5 customer workspaces are counted. Otherwise the stored counts with visible and as_of (when they were measured). Aggregates only: no organization, user, channel, video or title, and not counted_orgs. The SQL editor and a platform owner/admin get a fresh measurement with counted_orgs. Anyone may call it.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The switch's one writer
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_public_stats_visible(p_visible boolean) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  invoker text := case when coalesce(current_setting('role', true), 'none') = 'none' then session_user::text
                       else current_setting('role', true) end;
  -- The SQL editor, as an ALLOW-list (as public_site_stats() reads it): no API claims, and the role the call runs as is not an
  -- API role and is a member of postgres.
  editor  boolean := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
                     and invoker not in ('anon', 'authenticated', 'service_role', 'authenticator')
                     and pg_has_role(invoker::name, 'postgres', 'member');
  g       jsonb;
  was     boolean;
begin
  if not editor then
    -- Signed in and a platform owner/admin, else 42501 before anything is read; then the second factor and a rate limit.
    g := public.owner_guard('public_stats', 10);
    if g is not null then
      return g;
    end if;
  end if;
  if p_visible is null then
    raise exception 'set_public_stats_visible takes true or false' using errcode = '22023';
  end if;
  insert into public.site_settings (id) values (true) on conflict (id) do nothing;
  select st.public_stats_visible into was from public.site_settings st where st.id for update;
  if was is distinct from p_visible then
    update public.site_settings
       set public_stats_visible = p_visible, updated_by = auth.uid(), updated_at = now()
     where id;
    -- Not swallowed: a change that cannot be audited rolls back with it.
    perform public.security_event_log('site.public_stats', 'notice', 'public_stats_visible',
      jsonb_build_object('from', was, 'to', p_visible, 'via', case when editor then 'sql_editor' else 'admin' end));
  end if;
  -- On: the first measurement is taken here, so no anonymous caller ever has to measure.
  if p_visible then
    perform public.public_site_stats_refresh();
  end if;
  return jsonb_build_object('ok', true, 'visible', p_visible, 'changed', was is distinct from p_visible);
end
$$;

comment on function public.set_public_stats_visible(boolean) is
  'Turn the site''s live counters on or off (0164). A platform owner/admin (owner_guard: second factor, 10 calls per 10 minutes) or the SQL editor; everyone else 42501. A change writes one security_events row (site.public_stats); turning it on stores the first measurement. No redeploy: the site picks it up within about five minutes, once at least 5 customer workspaces are counted.';

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.public_site_stats_measure() from public, anon, authenticated, service_role;
revoke all on function public.public_site_stats_refresh() from public, anon, authenticated, service_role;
revoke all on function public.public_site_stats() from public, anon, authenticated, service_role;
revoke all on function public.set_public_stats_visible(boolean) from public, anon, authenticated, service_role;
grant execute on function public.public_site_stats() to anon, authenticated;
grant execute on function public.set_public_stats_visible(boolean) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Refresh every 10 minutes, when pg_cron is enabled (as 0111 schedules its sweep)
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regprocedure('cron.schedule(text, text, text)') is not null
     and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-public-site-stats') then
      perform cron.unschedule('nightshift-public-site-stats');
    end if;
    perform cron.schedule('nightshift-public-site-stats', '*/10 * * * *', 'select public.public_site_stats_refresh()');
  else
    raise notice '0164: pg_cron is not enabled, so no schedule was created; the public read measures again once its numbers are 15 minutes old';
  end if;
exception when others then
  -- All or nothing: a failed schedule undoes the unschedule above (this block is one subtransaction).
  raise notice '0164: pg_cron schedule not created (%); the public read measures again once its numbers are 15 minutes old', sqlerrm;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. End state (raises, and so rolls the whole file back, when anything above did not land as written)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  pair text[];
  h text;
  r text;
  p text;
begin
  foreach pair slice 1 in array array[
      ['public.public_site_stats_measure()', 'e1fa900daf83fb55af871d3e118f8a31'],
      ['public.public_site_stats_refresh()', '022ce0de3feaebde13aadd1432fcc626'],
      ['public.public_site_stats()', 'fe0dfed7b1abb856b161b35d8cfd6abb'],
      ['public.set_public_stats_visible(boolean)', '0b1793721bf2bb7aaad4c0eb248704e6']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception '0164 end state: % has md5 %, not this file''s', pair[1], h;
    end if;
    if not (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')
              from pg_proc p where p.oid = to_regprocedure(pair[1])) then
      raise exception '0164 end state: % is not a security definer with a pinned search_path', pair[1];
    end if;
    if (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = to_regprocedure(pair[1])) is distinct from 'postgres' then
      raise exception '0164 end state: % is not owned by postgres', pair[1];
    end if;
  end loop;
  if (select count(*) from public.site_settings) <> 1 then
    raise exception '0164 end state: site_settings does not hold exactly one row';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.site_settings'::regclass) then
    raise exception '0164 end state: site_settings has row level security off';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    foreach p in array array['select', 'insert', 'update', 'delete'] loop
      if has_table_privilege(r, 'public.site_settings', p) then
        raise exception '0164 end state: % may % on site_settings', r, p;
      end if;
    end loop;
  end loop;
  if not has_function_privilege('anon', 'public.public_site_stats()', 'execute')
     or not has_function_privilege('authenticated', 'public.public_site_stats()', 'execute')
     or has_function_privilege('anon', 'public.set_public_stats_visible(boolean)', 'execute')
     or has_function_privilege('service_role', 'public.set_public_stats_visible(boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.set_public_stats_visible(boolean)', 'execute')
     or has_function_privilege('anon', 'public.public_site_stats_measure()', 'execute')
     or has_function_privilege('authenticated', 'public.public_site_stats_measure()', 'execute')
     or has_function_privilege('service_role', 'public.public_site_stats_measure()', 'execute')
     or has_function_privilege('anon', 'public.public_site_stats_refresh()', 'execute')
     or has_function_privilege('authenticated', 'public.public_site_stats_refresh()', 'execute')
     or has_function_privilege('service_role', 'public.public_site_stats_refresh()', 'execute') then
    raise exception '0164 end state: the execute grants are not anon+authenticated read, authenticated switch, nobody measure or refresh';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select count(*) = 1 and not bool_or(public_stats_visible) from public.site_settings) as one_row_switch_off,
--     has_function_privilege('anon', 'public.public_site_stats()', 'EXECUTE') as anon_reads,
--     not has_function_privilege('anon', 'public.set_public_stats_visible(boolean)', 'EXECUTE') as anon_cannot_switch,
--     not has_table_privilege('anon', 'public.site_settings', 'SELECT') as table_closed;
--
-- What the site would show (the SQL editor gets a fresh measurement at any time; "visible" says whether the site would show it,
-- counted_orgs how many customer workspaces are counted, min_counted_orgs the k rule's minimum):
--   select public.public_site_stats();
--
-- Turn the counters on, and off again (docs/PUBLIC_STATS.md):
--   select public.set_public_stats_visible(true);
--   select public.set_public_stats_visible(false);
--
-- And, only if pg_cron is on:
--   select jobname, schedule, command from cron.job where jobname = 'nightshift-public-site-stats';
