-- 0064_notifications.sql — in-app notifications for the customer: the bell in
-- the shell, its unread count, and the five things worth interrupting someone
-- for.
--
-- WHAT IT ADDS
--   notifications            one row per person per event: which organization
--                            it is about (org_id), who it is FOR (user_id),
--                            what happened (kind), what it is about (ref — the
--                            job, storyboard or export id, or a UTC day for
--                            low credits), a few numbers and ids (data), and
--                            when the person read it (read_at).
--   mark_notification_read(id)
--   mark_all_notifications_read(org)
--                            the only writes a browser can make, and only on
--                            its own rows.
--   five triggers            the only way a row is created (see EVENTS).
--
-- EVENTS (kind → who is told → when)
--   creative_job_completed   the person who started the job → a generation
--                            finished (data: capability, credits_charged).
--   creative_job_failed      the person who started it → it failed or expired
--                            and the hold was released (data: capability,
--                            code, credits_returned).
--   storyboard_ready         every member of the channel's organization → a
--                            run stopped at "Storyboard ready" and waits for a
--                            person (0057). Nothing renders or is charged
--                            until someone approves.
--   editor_export_done       the person who asked → a finished export is in
--                            the library (0054).
--   credits_low              every member of the organization → available
--                            credits (balance - reserved) CROSSED below the
--                            low-credits line; at most once per UTC day, and
--                            never for the platform's own organization, which
--                            is exempt from credits.
--   Cancelled jobs tell nobody: the person did it. Ingest jobs tell nobody:
--   they are the library's own plumbing, not something anyone asked for.
--
-- NO PII, NO CROSS-ORG LEAK
--   A notification carries ids, a capability word, a machine code and numbers
--   — never a prompt, a title, a file name, an email or provider text. The
--   words the person reads are written by the app in en / ru / uz from kind +
--   data, so a language switch re-words old notifications too.
--   Recipients are checked at write time against org_members: a person who
--   left the organization is not told about it, and an id is never delivered
--   to someone outside the org it belongs to.
--
-- WHO MAY DO WHAT
--   notifications   select: the person it is for, and only while still a
--                   member of its organization (user_id = auth.uid() AND
--                   is_org_member(org_id)). Not another member of the same
--                   organization, not the organization's owner, not a
--                   platform admin: it is the person's own inbox.
--                   insert / update / delete: nobody (no grant). Rows appear
--                   through the triggers and change through the two functions.
--   mark_*          authenticated; they touch only the caller's own rows. Any
--                   other id — another user's, another org's, made up — reads
--                   the same: false / 0, no error that says it exists.
--   anon and service_role get nothing: the workers do not read or write an
--   inbox, they only change the rows that raise events.
--
-- A NOTIFICATION NEVER BREAKS THE THING IT REPORTS
--   Each trigger swallows its own failure (RAISE WARNING): a job finishing, a
--   refund, a hold or an export must never roll back because a bell row could
--   not be written. The inbox is bounded the same way: 200 rows per person,
--   nothing older than 90 days.
--
-- Nothing here spends, renders, publishes or changes a price, and no existing
-- function is replaced. Additive and idempotent: guarded creates,
-- drop-then-create policy and triggers.
--
-- REQUIRES 0018 (organizations), 0020 (credit_accounts), 0036 (creative_jobs),
-- 0054 (editor_exports), 0057 (storyboards).

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0064 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.credit_accounts') is null or to_regprocedure('public.credits_exempt(uuid)') is null then
    raise exception '0064 needs the credit accounts: apply 0020_credits.sql first';
  end if;
  if to_regclass('public.creative_jobs') is null then
    raise exception '0064 needs the creative jobs: apply 0036_creative_jobs.sql first';
  end if;
  if to_regclass('public.editor_exports') is null then
    raise exception '0064 needs the editor exports: apply 0054_editor_projects.sql first';
  end if;
  if to_regclass('public.storyboards') is null then
    raise exception '0064 needs the storyboards: apply 0057_storyboard_review.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The table
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  ref        text not null,
  data       jsonb not null default '{}'::jsonb,
  -- clock_timestamp(), not now(): several events in one transaction keep
  -- their order, which the 200-row bound below trims by.
  created_at timestamptz not null default clock_timestamp(),
  read_at    timestamptz
);

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('creative_job_completed', 'creative_job_failed', 'storyboard_ready',
                  'editor_export_done', 'credits_low'));
alter table public.notifications drop constraint if exists notifications_ref_check;
alter table public.notifications add constraint notifications_ref_check
  check (char_length(ref) between 1 and 80 and ref !~ '[[:cntrl:]]');
alter table public.notifications drop constraint if exists notifications_data_check;
alter table public.notifications add constraint notifications_data_check
  check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 2048);

-- One notification per person per thing: a job that is updated twice, a
-- storyboard re-opened, a balance that dips twice in a day tell the person once.
create unique index if not exists notifications_user_kind_ref_key
  on public.notifications (user_id, kind, ref);
create index if not exists notifications_inbox_idx
  on public.notifications (user_id, org_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id, org_id) where read_at is null;

comment on table public.notifications is
  'In-app notifications (migration 0064): one row per person per event, private to user_id. Created only by the triggers of 0064; changed only by mark_notification_read / mark_all_notifications_read. Carries ids and numbers, never text a person typed.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Internal helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The line below which available credits count as low. The number is shown to
-- the person as measured (the actual available credits travel in the
-- notification), never as a price; the operator tunes it by redefining this
-- function.
create or replace function public.notification_low_credits_threshold() returns numeric
  language sql immutable set search_path = public, pg_temp as $$
  select 20::numeric
$$;

-- Tell one person, if they are a member of the organization. Returns whether a
-- row was written (false: not a member, or already told about this ref).
create or replace function public.notification_emit(
  p_org uuid, p_user uuid, p_kind text, p_ref text, p_data jsonb
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  wrote boolean := false;
begin
  if p_org is null or p_user is null then
    return false;
  end if;
  if not exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = p_user) then
    return false;
  end if;
  insert into public.notifications (org_id, user_id, kind, ref, data)
  values (p_org, p_user, p_kind, p_ref, coalesce(p_data, '{}'::jsonb))
  on conflict (user_id, kind, ref) do nothing;
  wrote := found;
  if wrote then
    -- A bounded inbox: nothing older than 90 days, never more than 200.
    delete from public.notifications
     where user_id = p_user and created_at < now() - interval '90 days';
    delete from public.notifications
     where id in (select id from public.notifications
                   where user_id = p_user
                   order by created_at desc, id desc
                   offset 200);
  end if;
  return wrote;
end
$$;

-- Tell every member of the organization who has an account.
create or replace function public.notification_emit_org(
  p_org uuid, p_kind text, p_ref text, p_data jsonb
) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  m record;
  n integer := 0;
begin
  if p_org is null then
    return 0;
  end if;
  for m in select distinct user_id from public.org_members where org_id = p_org and user_id is not null loop
    if public.notification_emit(p_org, m.user_id, p_kind, p_ref, p_data) then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Events
-- ───────────────────────────────────────────────────────────────────────────

-- A generation ended. Completed, or failed / expired with its hold released
-- (creative_end_locked sets charged_credits = 0 and releases the hold in the
-- same transaction). credits_returned is the held amount, and only for a job
-- paid in credits with a hold — for anything else it is absent, never 0.
create or replace function public.notify_creative_job_ended() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  begin
    if new.kind = 'ingest' or new.requested_by is null then
      return new;
    end if;
    if new.status = 'completed' then
      perform public.notification_emit(new.org_id, new.requested_by, 'creative_job_completed', new.id::text,
        jsonb_strip_nulls(jsonb_build_object(
          'job_id', new.id,
          'capability', new.capability,
          'credits_charged', case when new.payer = 'credits' then new.charged_credits end)));
    elsif new.status in ('failed', 'expired') then
      perform public.notification_emit(new.org_id, new.requested_by, 'creative_job_failed', new.id::text,
        jsonb_strip_nulls(jsonb_build_object(
          'job_id', new.id,
          'capability', new.capability,
          'code', new.error_code,
          'credits_returned', case when new.payer = 'credits' and new.credit_ref is not null
                                   then new.quoted_credits end)));
    end if;
  exception when others then
    raise warning 'notify_creative_job_ended: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end
$$;

drop trigger if exists creative_jobs_notify on public.creative_jobs;
create trigger creative_jobs_notify
  after update of status on public.creative_jobs
  for each row
  when (new.status in ('completed', 'failed', 'expired') and old.status is distinct from new.status)
  execute function public.notify_creative_job_ended();

-- A run stopped at "Storyboard ready" and waits for a person.
create or replace function public.notify_storyboard_ready() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org uuid;
begin
  begin
    select c.org_id into org from public.channels c where c.channel_id = new.channel_id;
    perform public.notification_emit_org(org, 'storyboard_ready', new.id::text,
      jsonb_build_object('storyboard_id', new.id, 'scenes', jsonb_array_length(new.scenes)));
  exception when others then
    raise warning 'notify_storyboard_ready: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end
$$;

drop trigger if exists storyboards_notify on public.storyboards;
create trigger storyboards_notify
  after insert on public.storyboards
  for each row
  when (new.status = 'ready')
  execute function public.notify_storyboard_ready();

-- An editor export finished and is a file in the library.
create or replace function public.notify_editor_export_done() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  begin
    perform public.notification_emit(new.org_id, new.requested_by, 'editor_export_done', new.id::text,
      jsonb_strip_nulls(jsonb_build_object('export_id', new.id, 'project_id', new.project_id,
                                           'asset_id', new.asset_id)));
  exception when others then
    raise warning 'notify_editor_export_done: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end
$$;

drop trigger if exists editor_exports_notify on public.editor_exports;
create trigger editor_exports_notify
  after update of status on public.editor_exports
  for each row
  when (new.status = 'done' and old.status is distinct from new.status)
  execute function public.notify_editor_export_done();

-- Available credits crossed below the line. Crossing, not "is below": a
-- balance that stays low does not nag, and an account that was never above the
-- line (a new one) is not told it is poor.
create or replace function public.notify_credits_low() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  line   numeric := public.notification_low_credits_threshold();
  was    numeric := old.balance - old.reserved;
  now_   numeric := new.balance - new.reserved;
begin
  begin
    if was >= line and now_ < line and not public.credits_exempt(new.org_id) then
      perform public.notification_emit_org(new.org_id, 'credits_low',
        'low:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'),
        jsonb_build_object('available', now_));
    end if;
  exception when others then
    raise warning 'notify_credits_low: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end
$$;

drop trigger if exists credit_accounts_notify on public.credit_accounts;
create trigger credit_accounts_notify
  after update of balance, reserved on public.credit_accounts
  for each row
  when (old.balance is distinct from new.balance or old.reserved is distinct from new.reserved)
  execute function public.notify_credits_low();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The browser's writes: mark read
-- ───────────────────────────────────────────────────────────────────────────

-- True when the caller's own unread notification was marked. Another person's
-- id, another organization's, an already-read one and a made-up one all read
-- false: the answer never says a row exists.
create or replace function public.mark_notification_read(p_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.notifications
     set read_at = now()
   where id = p_id and user_id = auth.uid() and read_at is null;
  return found;
end
$$;

-- Mark every unread notification of the caller's, in one organization when
-- p_org is given (the bell shows the current organization), else all of
-- theirs. Returns how many. Never touches anyone else's.
create or replace function public.mark_all_notifications_read(p_org uuid default null) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.notifications
     set read_at = now()
   where user_id = auth.uid() and read_at is null
     and (p_org is null or org_id = p_org);
  get diagnostics n = row_count;
  return n;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Access: RLS on, one select policy, no direct writes
-- ───────────────────────────────────────────────────────────────────────────

alter table public.notifications enable row level security;

revoke all on public.notifications from public, anon, authenticated, service_role;
grant select on public.notifications to authenticated;

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = auth.uid() and public.is_org_member(org_id));

revoke all on function public.notification_low_credits_threshold() from public, anon, authenticated, service_role;
revoke all on function public.notification_emit(uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.notification_emit_org(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.notify_creative_job_ended() from public, anon, authenticated, service_role;
revoke all on function public.notify_storyboard_ready() from public, anon, authenticated, service_role;
revoke all on function public.notify_editor_export_done() from public, anon, authenticated, service_role;
revoke all on function public.notify_credits_low() from public, anon, authenticated, service_role;

revoke all on function public.mark_notification_read(uuid) from public, anon, authenticated, service_role;
revoke all on function public.mark_all_notifications_read(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated;

-- The bell updates live: Realtime delivers a row only to a session whose own
-- select policy lets it read that row, so this is the person's own inbox too.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.notifications'::regclass) as rls_on,
--   has_table_privilege('authenticated', 'public.notifications', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.notifications', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.notifications', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.notifications', 'DELETE')
--     and not has_table_privilege('anon', 'public.notifications', 'SELECT')
--     and not has_table_privilege('service_role', 'public.notifications', 'SELECT')
--     and not has_table_privilege('service_role', 'public.notifications', 'INSERT') as table_scoped,
--   has_function_privilege('authenticated', 'public.mark_notification_read(uuid)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.mark_all_notifications_read(uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.mark_notification_read(uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.mark_all_notifications_read(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.notification_emit(uuid,uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.notification_emit_org(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.notify_credits_low()', 'EXECUTE') as functions_scoped,
--   (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('notification_emit', 'notification_emit_org', 'notify_creative_job_ended',
--                         'notify_storyboard_ready', 'notify_editor_export_done', 'notify_credits_low',
--                         'mark_notification_read', 'mark_all_notifications_read'))
--     as definer_functions_pin_search_path,
--   (select count(*) = 4 from pg_trigger
--     where tgname in ('creative_jobs_notify', 'storyboards_notify', 'editor_exports_notify', 'credit_accounts_notify')
--       and not tgisinternal) as triggers_on,
--   exists (select 1 from pg_policies
--            where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications_select'
--              and cmd = 'SELECT') and (select count(*) = 1 from pg_policies
--            where schemaname = 'public' and tablename = 'notifications') as only_the_own_inbox_policy;
