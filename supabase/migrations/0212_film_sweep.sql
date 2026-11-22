-- 0212_film_sweep.sql — Film Studio switch-on gate G2: film_expire_segments (0171) runs at least every 15 minutes whether or not the
-- film worker is up, and every run is recorded, so "it ran" is a measurement and not an assumption. docs/FILM_STUDIO.md
-- ("Switch-on gates"), docs/studio/S2_GAPS.md (G2), docs/MIGRATIONS.md "0212".
--
-- WHY. Until now the sweep ran only on a thread inside tools/film_worker.py, and only while NIGHTSHIFT_FILM_WORKER=on and the
-- process was alive. A stopped, crashed or redeploying worker meant no sweep: a segment past its deadline and grace kept its credit
-- hold open until 0020's 24 hours, and a queued one nobody could claim was never settled at 0. pg_cron is NOT installed on the live
-- project (docs/MIGRATIONS.md, 0111 D15), so no database schedule existed either. And nothing recorded when a sweep last ran, so
-- "at most 15 minutes" could not be shown, only assumed (CLAUDE.md rule 5).
--
-- WHAT IT ADDS (one table, two functions, one pg_cron job when pg_cron is installed; it replaces nothing and alters no existing
-- table or function; film_expire_segments is called, never changed)
--   film_sweep_runs(runner)   one row per runner that ever swept: 'pg_cron' (this file's job, every 5 minutes, only where pg_cron
--                             is installed: the primary schedule), 'server' (the film-sweep service on our own server,
--                             tools/film_sweep.py --loop, every 5 minutes while NIGHTSHIFT_FILM_SWEEP=on: the fallback), 'worker'
--                             (tools/film_worker.py's own thread, while it runs) and 'actions' (kept for a one-off sweep from
--                             GitHub; no workflow sweeps any more: .github/workflows/film_sweep_watchdog.yml only READS the status
--                             once an hour). last_at / last_settled: the last sweep that completed and how many
--                             segments it moved. last_error / last_error_at: the last sweep that failed, by SQLSTATE only (a message
--                             body can carry a film id or a detail; a SQLSTATE cannot). RLS on, no policy; no API role writes it,
--                             service_role may read it.
--   film_sweep(runner)        service_role only. Runs film_expire_segments() and records the run under that runner. Answers
--                             {"ok": true, "runner", "settled", "at"}. When the sweep itself fails (not one segment: 0171 already
--                             skips a bad segment in its own subtransaction and records film.segment_skipped), its work is rolled
--                             back, the SQLSTATE is recorded and it answers {"ok": false, "runner", "error": <SQLSTATE>, "at"}.
--                             It answers rather than raising on purpose: a raise would roll the record of the failure back with
--                             it (PostgreSQL has no autonomous transaction). Every caller treats ok:false as a failure (the
--                             service logs a warning, the worker logs a warning, the pg_cron command raises: THE SCHEDULES).
--                             NOT EVERY FAILURE IS RECORDED. PL/pgSQL's "when others" does not catch query_canceled (57014: a
--                             statement_timeout, PostgREST's included, or a cancel) or assert_failure. Such a call raises out of
--                             film_sweep and records nothing: the service logs it (HTTP 5xx), pg_cron marks the run failed,
--                             and "overdue" below trips once last_at is older than the overdue line. So the record is "the last
--                             sweep that completed", never "every attempt". A per-pass bound on film_expire_segments, so a pass
--                             finishes inside the timeout, is a follow-up (docs/studio/S2_GAPS.md, G2b).
--   film_sweep_status()       service_role only (the operator alerts, G4, read it). Counts and times only, never an id. Per runner
--                             its row or null (never ran); the newest completed sweep; open_segments (queued / running / draining,
--                             0171's open statuses); stuck_segments: open segments already past their settle point by 0171's own
--                             rules and constants (film_money_limits: a hold that is no longer open, queued past unclaimed_hours,
--                             or past deadline + grace_hours), with oldest_stuck_minutes (null when none); overdue_after_minutes
--                             (30, the one overdue line, declared once in the function and returned with the answer); and
--                             "overdue":
--                               true  when a segment has been stuck longer than the line (sweeps "complete" while 0171 skips a
--                                     segment it cannot settle: a completed call is not a settled segment), or when a segment is
--                                     open and no runner completed a sweep within the line;
--                               null  otherwise, when no runner has ever recorded anything: unknown is not "fine" (rule 5);
--                               false otherwise.
--
-- THE SCHEDULES (any one is enough; they may run at once: film_expire_segments takes every row it touches with
-- "for update skip locked", so two sweeps never settle the same segment twice)
--   pg_cron   PRIMARY. 'nightshift-film-sweep' '*/5 * * * *', only where pg_cron is installed. It is NOT installed today on the
--             live project: this file then prints a NOTICE and creates nothing, exactly as 0111 and 0164 do. To turn it on, the
--             owner enables pg_cron in the Supabase dashboard (Database -> Extensions -> pg_cron) and then applies this file
--             again, or runs once, in the SQL editor:
--               select cron.schedule('nightshift-film-sweep', '*/5 * * * *', 'select case when (r ->> ''ok'')::boolean then 1 else (''film_sweep failed with SQLSTATE '' || coalesce(r ->> ''error'', ''none''))::integer end from (select public.film_sweep(''pg_cron'') as r) s');
--             (the same command section 4 schedules). Where pg_cron IS installed, the job must
--             exist when the file ends (the end-state block asserts it; a failed schedule fails the file, it is not a notice).
--             pg_cron marks a run "succeeded" whenever the command returns, and film_sweep returns {ok:false} on a failed sweep,
--             so the command raises on ok:false (a cast of "film_sweep failed with SQLSTATE <code>" to integer: the run is
--             marked failed in cron.job_run_details and the SQLSTATE is in its message). The raise rolls back film_sweep's own
--             record of that failure, so on pg_cron a failed sweep is found in cron.job_run_details, not in last_error.
--   server    FALLBACK. The film-sweep service (deploy/docker-compose.yml, tools/film_sweep.py --loop), every 300 s as runner
--             'server', while NIGHTSHIFT_FILM_SWEEP=on; independent of NIGHTSHIFT_FILM_WORKER, so the sweep runs with the worker off.
--   worker    tools/film_worker.py, every FILM_EXPIRE_EVERY_SECONDS (300 by default, never more than 900), while it runs.
--   Actions   does NOT sweep (a 10-minute schedule would cost about 4,300 runner-minutes a month). The hourly
--             .github/workflows/film_sweep_watchdog.yml reads film_sweep_status() and turns red when "overdue" is true.
--   The overdue line is 30 minutes: six missed 5-minute passes.
--
-- WHAT IT DOES NOT CHANGE. No credit, film, take, segment or job function; no grant of any existing object. It spends nothing:
--   film_expire_segments only settles segments by 0171's rules (capture what was made, release the rest).
--
-- REQUIRES 0171 (film_segments, film_expire_segments, film_money_limits). Additive and idempotent: create table if not exists (a
-- film_sweep_runs of another shape is refused, not reused), create-or-replace of
-- two functions that did not exist (under an md5 drift guard), revoke then grant, unschedule-then-schedule of this file's cron job.
-- A replay changes nothing (the recorded runs are kept). Undo: docs/sql/rollback_0212_film_sweep.sql (owner-applied).
--
-- NUMBER. 0212, provisional: assigned to claude/nsai-s2-sweep. docs/studio/S2_GAPS.md also pencils 0212 in for the archive branch
-- (claude/nsai-s2-archive-resume); whichever merges second renumbers.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select to_regclass('public.film_sweep_runs') is null as table_is_new,
--          to_regprocedure('public.film_sweep(text)') is null as sweep_is_new,
--          to_regprocedure('public.film_expire_segments()') is not null as has_0171;
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regclass('public.film_segments') is null or to_regprocedure('public.film_expire_segments()') is null
     or to_regprocedure('public.film_money_limits()') is null then
    raise exception '0212 needs 0171_films_money.sql (film_segments, film_expire_segments, film_money_limits): apply it first';
  end if;
  -- A film_sweep_runs that is already there is this file's (a replay), or "create table if not exists" would quietly keep a
  -- table whose rows the status then misreads.
  if to_regclass('public.film_sweep_runs') is not null then
    if (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
          from pg_attribute a where a.attrelid = 'public.film_sweep_runs'::regclass and a.attnum > 0 and not a.attisdropped)
       is distinct from 'runner text, last_at timestamp with time zone, last_settled integer, last_error text, '
                        'last_error_at timestamp with time zone'
       or not exists (select 1 from pg_constraint c where c.conrelid = 'public.film_sweep_runs'::regclass and c.contype = 'c'
                        and pg_get_constraintdef(c.oid) like '%last_error ~ ''^[0-9A-Z]{5}$''::text%')
       or not exists (select 1 from pg_constraint c where c.conrelid = 'public.film_sweep_runs'::regclass and c.contype = 'c'
                        and pg_get_constraintdef(c.oid) like '%runner%''worker''%''actions''%''pg_cron''%''server''%')
       or not exists (select 1 from pg_constraint c where c.conrelid = 'public.film_sweep_runs'::regclass and c.contype = 'p') then
      raise exception '0212 found public.film_sweep_runs that is not this file''s (its columns or checks differ): read it first';
    end if;
  end if;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.film_sweep(text)', '7246795c29051c51a35e75ab58b38bd0'),
      ('public.film_sweep_status()', '1f042f5c52babd1797232818231624aa')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0212 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The record: one row per runner
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.film_sweep_runs (
  runner        text primary key check (runner in ('worker', 'actions', 'pg_cron', 'server')),
  last_at       timestamptz,
  last_settled  integer check (last_settled is null or last_settled >= 0),
  last_error    text check (last_error is null or last_error ~ '^[0-9A-Z]{5}$'),
  last_error_at timestamptz,
  check ((last_at is null) = (last_settled is null)),
  check ((last_error is null) = (last_error_at is null))
);

comment on table public.film_sweep_runs is
  'Film sweep runs (0212): one row per runner (worker, actions, pg_cron, server), written only by film_sweep(). last_at = the last completed '
  'sweep; last_error = the SQLSTATE of the last failed one. No API role writes it; service_role reads it.';

alter table public.film_sweep_runs enable row level security;
revoke all on table public.film_sweep_runs from public, anon, authenticated, service_role;
grant select on table public.film_sweep_runs to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The sweep, recorded
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.film_sweep(p_runner text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  who text := btrim(coalesce(p_runner, ''));
  n   integer;
  st  text;
  t_at timestamptz;
begin
  if who not in ('worker', 'actions', 'pg_cron', 'server') then
    raise exception 'unknown_runner' using errcode = '22023', detail = 'runner is one of worker, actions, pg_cron, server';
  end if;
  begin
    n := public.film_expire_segments();
  exception when others then
    -- The block's subtransaction undid whatever the failed pass had done; the next pass starts again from the rows themselves.
    st := sqlstate;
  end;
  t_at := clock_timestamp();
  if st is not null then
    insert into public.film_sweep_runs (runner, last_error, last_error_at) values (who, st, t_at)
      on conflict (runner) do update set last_error = excluded.last_error, last_error_at = excluded.last_error_at;
    return jsonb_build_object('ok', false, 'runner', who, 'error', st, 'at', t_at);
  end if;
  insert into public.film_sweep_runs (runner, last_at, last_settled) values (who, t_at, coalesce(n, 0))
    on conflict (runner) do update set last_at = excluded.last_at, last_settled = excluded.last_settled;
  return jsonb_build_object('ok', true, 'runner', who, 'settled', coalesce(n, 0), 'at', t_at);
end
$$;

comment on function public.film_sweep(text) is
  'Film sweep (0212): runs film_expire_segments() and records the run under the runner (worker, actions, pg_cron, server). '
  '{ok:true, settled, at} or, when the sweep itself failed, {ok:false, error: SQLSTATE, at} with the failure recorded. Service role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Did a sweep run? (the measurement G2 and the overdue alert, G4, read)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.film_sweep_status() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  -- The one overdue line: used below and returned as overdue_after_minutes, so a reader never carries a second copy.
  line      constant integer := 30;
  lim       jsonb := public.film_money_limits();
  grace     interval := make_interval(hours => (lim ->> 'grace_hours')::integer);
  unclaimed interval := make_interval(hours => (lim ->> 'unclaimed_hours')::integer);
  ever      boolean := exists (select 1 from public.film_sweep_runs);
  newest    timestamptz := (select max(last_at) from public.film_sweep_runs);
  open_n    integer;
  stuck_n   integer;
  oldest    timestamptz;
  stuck_min integer;
  runs      jsonb := '{}'::jsonb;
  w         text;
  f         public.film_sweep_runs;
begin
  -- Since when each open segment could have been settled by 0171's sweep rules (null: not yet). A hold that is gone counts from
  -- when 0020 settled it, or from the segment's start when its row is missing.
  select count(*), count(*) filter (where x.since <= now()), min(x.since) filter (where x.since <= now())
    into open_n, stuck_n, oldest
    from (select least(
                   case when s.credit_ref is not null
                             and not exists (select 1 from public.credit_reservations r
                                              where r.job_id = s.credit_ref and r.status = 'open')
                        then coalesce((select r.settled_at from public.credit_reservations r where r.job_id = s.credit_ref),
                                      s.created_at) end,
                   case when s.status = 'queued' then s.created_at + unclaimed end,
                   case when s.deadline_at is not null then s.deadline_at + grace end) as since
            from public.film_segments s
           where s.status in ('queued', 'running', 'draining')) x;
  stuck_min := case when oldest is null then null else floor(extract(epoch from now() - oldest) / 60)::integer end;
  foreach w in array array['worker', 'actions', 'pg_cron', 'server'] loop
    select * into f from public.film_sweep_runs where runner = w;
    runs := runs || jsonb_build_object(w, case when not found then null else jsonb_build_object(
      'last_at', f.last_at, 'last_settled', f.last_settled, 'last_error', f.last_error, 'last_error_at', f.last_error_at) end);
  end loop;
  return jsonb_build_object(
    'runners', runs,
    'last_at', newest,
    'open_segments', open_n,
    'stuck_segments', stuck_n,
    'oldest_stuck_minutes', stuck_min,
    'overdue_after_minutes', line,
    -- A segment stuck past the line is measured whether or not a sweep was ever recorded. Otherwise: never recorded is unknown,
    -- not "fine"; recorded but never completed counts as overdue while a segment is open.
    'overdue', case when stuck_min > line then true
                    when not ever then null
                    else open_n > 0 and (newest is null or newest < now() - make_interval(mins => line)) end,
    'at', now());
end
$$;

comment on function public.film_sweep_status() is
  'Film sweep status (0212): per runner its last run (null: never), the newest completed sweep, open segments, and overdue '
  '(a segment stuck past its settle point longer than overdue_after_minutes, or one open and no completed sweep within it; '
  'null when no sweep was ever recorded and none is stuck). Counts only. Service role only.';

revoke all on function public.film_sweep(text) from public, anon, authenticated, service_role;
revoke all on function public.film_sweep_status() from public, anon, authenticated, service_role;
grant execute on function public.film_sweep(text) to service_role;
grant execute on function public.film_sweep_status() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Every 5 minutes, when pg_cron is enabled (as 0111 and 0164 schedule theirs)
-- ───────────────────────────────────────────────────────────────────────────

-- Unlike 0164, a failed schedule where pg_cron exists is not a notice: the end state below would refuse it, so it fails here, with
-- pg_cron's own error. The command raises on {ok:false} (see THE SCHEDULES), so pg_cron never reports a failed sweep as succeeded.
do $$
begin
  if to_regprocedure('cron.schedule(text, text, text)') is not null
     and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-film-sweep') then
      perform cron.unschedule('nightshift-film-sweep');
    end if;
    perform cron.schedule('nightshift-film-sweep', '*/5 * * * *',
      'select case when (r ->> ''ok'')::boolean then 1 '
      || 'else (''film_sweep failed with SQLSTATE '' || coalesce(r ->> ''error'', ''none''))::integer end '
      || 'from (select public.film_sweep(''pg_cron'') as r) s');
  else
    raise notice '%', '0212: pg_cron is not enabled, so the 5-minute film sweep was NOT scheduled. To schedule it: enable pg_cron in the '
      || 'Supabase dashboard (Database -> Extensions -> pg_cron), then apply 0212 again, or run the one-line cron.schedule in 0212''s '
      || 'header (docs/MIGRATIONS.md, 0212). Until then only the film-sweep service (NIGHTSHIFT_FILM_SWEEP=on) and the film worker sweep';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. End state (raises, and so rolls the whole file back, when anything above did not land as written)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
  h text;
  role_ text;
  jobs bigint;
  p text;
begin
  for r in select * from (values
      ('public.film_sweep(text)', '7246795c29051c51a35e75ab58b38bd0'),
      ('public.film_sweep_status()', '1f042f5c52babd1797232818231624aa')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception '0212 end state: % does not hold this file''s body (md5 %)', r.sig, h;
    end if;
    if not (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')
              from pg_proc p where p.oid = to_regprocedure(r.sig)) then
      raise exception '0212 end state: % is not a security definer with a pinned search_path', r.sig;
    end if;
    foreach role_ in array array['anon', 'authenticated'] loop
      if has_function_privilege(role_, r.sig, 'execute') then
        raise exception '0212 end state: % may execute %', role_, r.sig;
      end if;
    end loop;
    if not has_function_privilege('service_role', r.sig, 'execute') then
      raise exception '0212 end state: service_role may not execute %', r.sig;
    end if;
  end loop;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.film_sweep_runs'::regclass) then
    raise exception '0212 end state: film_sweep_runs has row level security off';
  end if;
  foreach role_ in array array['anon', 'authenticated', 'service_role'] loop
    foreach p in array array['insert', 'update', 'delete', 'truncate'] loop
      if has_table_privilege(role_, 'public.film_sweep_runs', p) then
        raise exception '0212 end state: % may % on film_sweep_runs', role_, p;
      end if;
    end loop;
  end loop;
  -- Dynamic, because cron.job is not there to be planned against where pg_cron is not installed.
  if to_regprocedure('cron.schedule(text, text, text)') is not null and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    execute 'select count(*) from cron.job where jobname = ''nightshift-film-sweep'' and schedule = ''*/5 * * * *'' '
            'and command like ''%public.film_sweep(''''pg_cron'''')%'' and command like ''%::integer%''' into jobs;
    if jobs <> 1 then
      raise exception '0212 end state: pg_cron is installed but the job nightshift-film-sweep is not this file''s, once';
    end if;
  end if;
  if has_table_privilege('anon', 'public.film_sweep_runs', 'select')
     or has_table_privilege('authenticated', 'public.film_sweep_runs', 'select')
     or not has_table_privilege('service_role', 'public.film_sweep_runs', 'select') then
    raise exception '0212 end state: film_sweep_runs is not readable by service_role alone';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only, run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     to_regclass('public.film_sweep_runs') is not null as table_exists,
--     (select c.relrowsecurity from pg_class c where c.oid = 'public.film_sweep_runs'::regclass) as rls_on,
--     not has_table_privilege('anon', 'public.film_sweep_runs', 'select')
--       and not has_table_privilege('authenticated', 'public.film_sweep_runs', 'select') as table_closed,
--     has_function_privilege('service_role', 'public.film_sweep(text)', 'execute')
--       and not has_function_privilege('anon', 'public.film_sweep(text)', 'execute')
--       and not has_function_privilege('authenticated', 'public.film_sweep(text)', 'execute') as sweep_service_only,
--     has_function_privilege('service_role', 'public.film_sweep_status()', 'execute')
--       and not has_function_privilege('anon', 'public.film_sweep_status()', 'execute')
--       and not has_function_privilege('authenticated', 'public.film_sweep_status()', 'execute') as status_service_only;
--
-- Is it running? (after the first scheduled pass: pg_cron or the film-sweep service within about 5 minutes)
--   select public.film_sweep_status();
--   select runner, last_at, last_settled, last_error, last_error_at from public.film_sweep_runs order by runner;
--
-- And, only if pg_cron is on (a failed sweep shows here as a failed run whose message names its SQLSTATE):
--   select jobname, schedule, command from cron.job where jobname = 'nightshift-film-sweep';
--   select status, return_message, start_time from cron.job_run_details d join cron.job j using (jobid)
--    where j.jobname = 'nightshift-film-sweep' order by start_time desc limit 5;
