-- 0164_public_site_stats.sql — live public counters for the marketing site, built but HIDDEN until the owner turns them on with
-- one command. docs/PUBLIC_STATS.md, docs/MIGRATIONS.md "0164".
--
-- *** LIVE ON APPLY, and still invisible: the switch it adds starts OFF, and while it is off the public read answers
-- *** {"visible": false} and nothing else. Nothing is shown on the site until a platform owner/admin runs
-- ***   select public.set_public_stats_visible(true);
--
-- WHY. The owner's decision: build the counters now, show them when real user traffic grows, and showing them must need no
-- redeploy. The site reads with the ANON key only, and every table these numbers come from is closed to anon (videos, intents,
-- jobs: per-tenant rows), so the numbers are computed by one SECURITY DEFINER function that hands out aggregates and nothing else.
--
-- WHAT IT ADDS (one table, three functions; it replaces nothing and alters no existing table)
--   site_settings                     one row (id is the constant true). public_stats_visible boolean NOT NULL DEFAULT false: the
--                                     switch. stats / stats_at: the last measurement and when it was taken (a five-minute snapshot,
--                                     see "COST" below). updated_by / updated_at: who last turned the switch. No API role may read or
--                                     write it (RLS on, no policy, every grant revoked): only the functions below touch it. A missing
--                                     row reads as hidden.
--   public_site_stats()               anon and authenticated. The site's read. Hidden: {"visible": false} and nothing else, so a
--                                     hidden number cannot be read off the API either. Visible: the measurement below plus
--                                     "visible": true and "as_of" (when the numbers were measured, never "now" for an older snapshot).
--                                     The SQL editor (a session with no API claims and no API role) and a signed-in platform
--                                     owner/admin are also given the numbers while hidden, with "visible": false, so the owner can see
--                                     what turning it on would show before doing it.
--   set_public_stats_visible(boolean) authenticated (the function itself refuses everyone but a platform owner/admin, through
--                                     owner_guard(), 0107: 42501 before anything is read, the second factor, 10 calls per 10 minutes)
--                                     and the SQL editor (the database owner's own door, which already holds every power this
--                                     grants). Not anon, not the service key. A change writes ONE security_events row
--                                     ('site.public_stats', from, to, via admin | sql_editor) in the same transaction, so a change that
--                                     cannot be audited does not happen; the owner's Security page lists it (owner_security_events,
--                                     0107). A call that changes nothing writes nothing (0116's switch does the same).
--   public_site_stats_measure()       internal (no API role): the measurement itself.
--
-- WHAT IS MEASURED (every value is a count of rows that exist, or null: nothing is a constant, an estimate, or a default)
--   videos_rendered          videos rows that hold a finished cut: a recorded master hash (cut_sha256, 0112) or an upload
--                            (published_at, or publish_state 'uploaded', 0016). A held row a gate stopped before the render has
--                            neither and is not counted. A lower bound: a held cut recorded before 0112 has no hash.
--   videos_uploaded_private  uploaded videos that went to YouTube as private: their recorded privacy is 'private', or a read-back
--                            of YouTube before a "publish when approved" request (video_visibility_requests.before_privacy, 0116)
--                            said 'private' (they were private, then a person's approval made them public). An upload that went
--                            public straight away (a channel with auto publish on) is not counted.
--   videos_approved          distinct videos a person approved: review_intents rows of action 'approve' that carry the approved
--                            cut's hash and the approver (written only by approve_video_publish, 0112; intents are never edited or
--                            deleted, so a later repair that cleared the video's approval columns does not erase the count).
--   studio_generations       creative_jobs (0036) with status 'completed'.
--   last_run_at              when the newest queue run finished: render_jobs (0017) of kind 'daily' or 'repair' with status
--                            'succeeded', its finished_at. Null when there is none, never a made-up time.
--   A count is a number (0 is a measured zero); last_run_at is null when nothing has finished. No rate, ratio or percentage is
--   computed here: a small sample would make one meaningless, and none is needed.
--
-- WHAT IS LEFT OUT: the operator's own and internal workspaces. A row counts only when it belongs to an organization that is NOT
--   (a) the operator's own workspace, public.default_org_id() (0018; credit-exempt by design, the rule 0138's Customers page uses), and
--   NOT (b) a workspace one of whose members is a bound account on the platform staff roster (org_members.user_id = app_members.user_id,
--   0007): the operator's staff test from their own workspaces. A row with no organization (a channel that is gone, a channel with
--   no org) is not counted either: it cannot be shown not to be ours. Matched by user id only, never by a typed e-mail, so a customer
--   cannot exclude or include a workspace by naming an address.
--
-- WHAT IT NEVER RETURNS: an organization, user, channel, video id, title, topic, e-mail, or any per-tenant row. Only the keys named
--   above (visible, as_of, videos_rendered, videos_uploaded_private, videos_approved, studio_generations, last_run_at).
--
-- COST. public_site_stats() is executable by anon, so it must not run five counts for every call: while visible it serves the stored
--   measurement when it is under five minutes old, and otherwise the one caller that takes a transaction-level advisory lock measures
--   and stores; the rest are served the previous measurement (or, when there is none yet, measure without storing). Hidden, it reads
--   one row and returns. The Command Center keeps the answer five minutes too (lib/server/public-stats.ts), so a switch change shows
--   on the site within about five minutes and a measurement is at most about ten minutes old.
--
-- WHAT IT DOES NOT CHANGE. No existing table, policy, grant or function. No publishing, privacy, approval, credit or job path reads it.
--
-- REQUIRES 0007 (app_members), 0016 (videos.publish_state), 0017 (render_jobs), 0018 (organizations, org_members, default_org_id,
-- is_platform_admin), 0036 (creative_jobs), 0107 (owner_guard, security_event_log), 0112 (videos.cut_sha256,
-- review_intents.approved_cut_sha256) and 0116 (video_visibility_requests). Additive and idempotent: create table if not exists, one
-- insert ... on conflict do nothing, create-or-replace of three functions that did not exist, revoke then grant. A replay changes
-- nothing (the switch keeps its value). Undo: docs/sql/rollback_0164_public_site_stats.sql (owner-applied).
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
      ['public.public_site_stats_measure()', '892be486e3390fd65bebe24af4bc5fc1'],
      ['public.public_site_stats()', 'c2ab909184b3d57d3220cb0186d6e172'],
      ['public.set_public_stats_visible(boolean)', '9433f15941b0f1280a7a8f17e7fdc030']] loop
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
  'The public site''s switches (0164). One row. public_stats_visible (default false) shows the live counters; changed only by set_public_stats_visible(), which refuses anyone but a platform owner/admin or the SQL editor and writes a security_events row. stats/stats_at: the last measurement public_site_stats() served. No API role reads or writes this table.';
comment on column public.site_settings.public_stats_visible is
  'Show the "Live from our pipeline" counters on the site. false (the default) = public_site_stats() answers {"visible": false} and nothing else.';

alter table public.site_settings enable row level security;
revoke all on public.site_settings from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The measurement (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- Every count is over rows of organizations that are neither the operator's own nor a staff member's (the header says why).
create or replace function public.public_site_stats_measure() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with counted as (
    select c.channel_id, c.org_id
      from public.channels c
     where c.org_id is not null
       and c.org_id is distinct from public.default_org_id()
       and not exists (select 1 from public.org_members m join public.app_members a on a.user_id = m.user_id
                        where m.org_id = c.org_id)
  )
  select jsonb_build_object(
    'videos_rendered',
      (select count(*) from public.videos v
        where v.channel_id in (select k.channel_id from counted k)
          and (v.cut_sha256 is not null or v.published_at is not null or v.publish_state = 'uploaded')),
    'videos_uploaded_private',
      (select count(*) from public.videos v
        where v.channel_id in (select k.channel_id from counted k)
          and (v.privacy = 'private'
               or exists (select 1 from public.video_visibility_requests r
                           where r.video_id = v.video_id and r.channel_id = v.channel_id and r.before_privacy = 'private'))),
    'videos_approved',
      (select count(distinct i.video_id) from public.review_intents i
        where i.action = 'approve' and i.approved_cut_sha256 is not null and i.created_by is not null
          and i.video_id is not null
          and i.channel_id in (select k.channel_id from counted k)),
    'studio_generations',
      (select count(*) from public.creative_jobs j
        where j.status = 'completed'
          and j.org_id is distinct from public.default_org_id()
          and not exists (select 1 from public.org_members m join public.app_members a on a.user_id = m.user_id
                           where m.org_id = j.org_id)),
    'last_run_at',
      (select max(r.finished_at) from public.render_jobs r
        where r.status = 'succeeded' and r.kind in ('daily', 'repair') and r.finished_at is not null
          and r.channel_id in (select k.channel_id from counted k)))
$$;

comment on function public.public_site_stats_measure() is
  'Live public counters (0164): videos_rendered, videos_uploaded_private, videos_approved, studio_generations (counts) and last_run_at (null when none), over organizations that are neither default_org_id() nor a platform staff member''s. Internal: no API role.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The public read
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.public_site_stats() returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s       public.site_settings;
  shown   boolean;
  preview boolean;
  locked  boolean;
  v       jsonb;
  v_at    timestamptz;
begin
  select * into s from public.site_settings where id;
  shown := coalesce(s.public_stats_visible, false);
  -- The SQL editor (no API claims, no API role) and a signed-in platform owner/admin may see the numbers while they are hidden.
  preview := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
              and coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated', 'service_role'))
             or (auth.uid() is not null and public.is_platform_admin());
  if not shown and not preview then
    return jsonb_build_object('visible', false);
  end if;
  if not preview and s.stats is not null and s.stats_at > now() - interval '5 minutes' then
    return s.stats || jsonb_build_object('visible', true, 'as_of', s.stats_at);
  end if;
  -- One caller measures; while it does, the others are given the previous measurement.
  locked := pg_try_advisory_xact_lock(hashtext('public.public_site_stats'));
  if not locked and not preview and s.stats is not null then
    return s.stats || jsonb_build_object('visible', true, 'as_of', s.stats_at);
  end if;
  v_at := now();
  v := public.public_site_stats_measure();
  if locked then
    update public.site_settings set stats = v, stats_at = v_at where id;
  end if;
  return v || jsonb_build_object('visible', shown, 'as_of', v_at);
end
$$;

comment on function public.public_site_stats() is
  'Live public counters (0164). Hidden (site_settings.public_stats_visible false): {"visible": false} only. Visible: the counts of public_site_stats_measure() with visible and as_of (when they were measured; a snapshot of at most five minutes). Aggregates only: no organization, user, channel, video or title. Anyone may call it.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The switch's one writer
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_public_stats_visible(p_visible boolean) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  editor boolean := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
                    and coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated', 'service_role');
  g      jsonb;
  was    boolean;
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
  return jsonb_build_object('ok', true, 'visible', p_visible, 'changed', was is distinct from p_visible);
end
$$;

comment on function public.set_public_stats_visible(boolean) is
  'Turn the site''s live counters on or off (0164). A platform owner/admin (owner_guard: second factor, 10 calls per 10 minutes) or the SQL editor; everyone else 42501. A change writes one security_events row (site.public_stats). No redeploy: the site picks it up within about five minutes.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.public_site_stats_measure() from public, anon, authenticated, service_role;
revoke all on function public.public_site_stats() from public, anon, authenticated, service_role;
revoke all on function public.set_public_stats_visible(boolean) from public, anon, authenticated, service_role;
grant execute on function public.public_site_stats() to anon, authenticated;
grant execute on function public.set_public_stats_visible(boolean) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. End state (raises, and so rolls the whole file back, when anything above did not land as written)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  pair text[];
  h text;
begin
  foreach pair slice 1 in array array[
      ['public.public_site_stats_measure()', '892be486e3390fd65bebe24af4bc5fc1'],
      ['public.public_site_stats()', 'c2ab909184b3d57d3220cb0186d6e172'],
      ['public.set_public_stats_visible(boolean)', '9433f15941b0f1280a7a8f17e7fdc030']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception '0164 end state: % has md5 %, not this file''s', pair[1], h;
    end if;
    if not (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')
              from pg_proc p where p.oid = to_regprocedure(pair[1])) then
      raise exception '0164 end state: % is not a security definer with a pinned search_path', pair[1];
    end if;
  end loop;
  if (select count(*) from public.site_settings) <> 1 then
    raise exception '0164 end state: site_settings does not hold exactly one row';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.site_settings'::regclass) then
    raise exception '0164 end state: site_settings has row level security off';
  end if;
  if has_table_privilege('anon', 'public.site_settings', 'select') or has_table_privilege('authenticated', 'public.site_settings', 'select')
     or has_table_privilege('authenticated', 'public.site_settings', 'update') or has_table_privilege('service_role', 'public.site_settings', 'update') then
    raise exception '0164 end state: an API role can reach site_settings directly';
  end if;
  if not has_function_privilege('anon', 'public.public_site_stats()', 'execute')
     or not has_function_privilege('authenticated', 'public.public_site_stats()', 'execute')
     or has_function_privilege('anon', 'public.set_public_stats_visible(boolean)', 'execute')
     or has_function_privilege('service_role', 'public.set_public_stats_visible(boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.set_public_stats_visible(boolean)', 'execute')
     or has_function_privilege('anon', 'public.public_site_stats_measure()', 'execute')
     or has_function_privilege('authenticated', 'public.public_site_stats_measure()', 'execute')
     or has_function_privilege('service_role', 'public.public_site_stats_measure()', 'execute') then
    raise exception '0164 end state: the execute grants are not anon+authenticated read, authenticated switch, nobody measure';
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
-- What the site would show (the SQL editor sees the numbers while they are hidden; "visible" says whether the site shows them):
--   select public.public_site_stats();
--
-- Turn the counters on, and off again (docs/PUBLIC_STATS.md):
--   select public.set_public_stats_visible(true);
--   select public.set_public_stats_visible(false);
