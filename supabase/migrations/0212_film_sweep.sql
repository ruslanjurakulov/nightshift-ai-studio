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
--   film_sweep_runs(runner)   one row per runner that ever swept: 'worker' (tools/film_worker.py), 'actions'
--                             (.github/workflows/film_sweep.yml, every 10 minutes) and 'pg_cron' (this file's job, every 5 minutes,
--                             only where pg_cron is installed). last_at / last_settled: the last sweep that completed and how many
--                             segments it moved. last_error / last_error_at: the last sweep that failed, by SQLSTATE only (a message
--                             body can carry a film id or a detail; a SQLSTATE cannot). RLS on, no policy; no API role writes it,
--                             service_role may read it.
--   film_sweep(runner)        service_role only. Runs film_expire_segments() and records the run under that runner. Answers
--                             {"ok": true, "runner", "settled", "at"}. When the sweep itself fails (not one segment: 0171 already
--                             skips a bad segment in its own subtransaction and records film.segment_skipped), its work is rolled
--                             back, the SQLSTATE is recorded and it answers {"ok": false, "runner", "error": <SQLSTATE>, "at"}.
--                             It answers rather than raising on purpose: a raise would roll the record of the failure back with
--                             it (PostgreSQL has no autonomous transaction), and an unrecorded failure is exactly the blind spot
--                             this file closes. Every caller treats ok:false as a failure (the workflow run fails, the worker
--                             logs a warning).
--   film_sweep_status()       service_role only (the operator alerts, G4, read it). Per runner its row or null (never ran), the
--                             newest completed sweep, how many segments are open (queued / running / draining, 0171's open
--                             statuses), and "overdue": true when a segment is open and no runner completed a sweep in the last
--                             20 minutes, false when none is open or one did, and NULL when no runner has ever recorded anything:
--                             unknown is not "fine" (rule 5).
--
-- THE SCHEDULES (any one is enough; all three may run at once: film_expire_segments takes every row it touches with
-- "for update skip locked", so two sweeps never settle the same segment twice)
--   pg_cron   'nightshift-film-sweep' '*/5 * * * *' select public.film_sweep('pg_cron'), only where pg_cron is installed (it is
--             not, today, on the live project: this file then prints a NOTICE and creates nothing, exactly as 0111 and 0164 do).
--   Actions   .github/workflows/film_sweep.yml, '*/10 * * * *': the guaranteed one, independent of the server and the worker.
--             GitHub may run a scheduled workflow late under load; 20 minutes is the overdue line for that reason.
--   worker    tools/film_worker.py, every FILM_EXPIRE_EVERY_SECONDS (300 by default, never more than 900), while it runs.
--
-- WHAT IT DOES NOT CHANGE. No credit, film, take, segment or job function; no grant of any existing object. It spends nothing:
--   film_expire_segments only settles segments by 0171's rules (capture what was made, release the rest).
--
-- REQUIRES 0171 (film_segments, film_expire_segments). Additive and idempotent: create table if not exists, create-or-replace of
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
  if to_regclass('public.film_segments') is null or to_regprocedure('public.film_expire_segments()') is null then
    raise exception '0212 needs 0171_films_money.sql (film_segments, film_expire_segments): apply it first';
  end if;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.film_sweep(text)', '10dcda57c382fd7f3f2ed4a32fb62e44'),
      ('public.film_sweep_status()', 'ac6b8f6a210ebb7ad092e1f23b78438c')) v(sig, want) loop
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
  runner        text primary key check (runner in ('worker', 'actions', 'pg_cron')),
  last_at       timestamptz,
  last_settled  integer check (last_settled is null or last_settled >= 0),
  last_error    text check (last_error is null or last_error ~ '^[0-9A-Z]{5}$'),
  last_error_at timestamptz,
  check ((last_at is null) = (last_settled is null)),
  check ((last_error is null) = (last_error_at is null))
);

comment on table public.film_sweep_runs is
  'Film sweep runs (0212): one row per runner (worker, actions, pg_cron), written only by film_sweep(). last_at = the last completed '
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
  if who not in ('worker', 'actions', 'pg_cron') then
    raise exception 'unknown_runner' using errcode = '22023', detail = 'runner is one of worker, actions, pg_cron';
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
  'Film sweep (0212): runs film_expire_segments() and records the run under the runner (worker, actions, pg_cron). '
  '{ok:true, settled, at} or, when the sweep itself failed, {ok:false, error: SQLSTATE, at} with the failure recorded. Service role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Did a sweep run? (the measurement G2 and the overdue alert, G4, read)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.film_sweep_status() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  ever   boolean := exists (select 1 from public.film_sweep_runs);
  newest timestamptz := (select max(last_at) from public.film_sweep_runs);
  open_n integer := (select count(*) from public.film_segments where status in ('queued', 'running', 'draining'));
  runs   jsonb := '{}'::jsonb;
  w      text;
  f      public.film_sweep_runs;
begin
  foreach w in array array['worker', 'actions', 'pg_cron'] loop
    select * into f from public.film_sweep_runs where runner = w;
    runs := runs || jsonb_build_object(w, case when not found then null else jsonb_build_object(
      'last_at', f.last_at, 'last_settled', f.last_settled, 'last_error', f.last_error, 'last_error_at', f.last_error_at) end);
  end loop;
  return jsonb_build_object(
    'runners', runs,
    'last_at', newest,
    'open_segments', open_n,
    'overdue_after_minutes', 20,
    -- Never recorded: unknown, not "fine". Recorded but never completed counts as overdue while a segment is open.
    'overdue', case when not ever then null
                    else open_n > 0 and (newest is null or newest < now() - interval '20 minutes') end,
    'at', now());
end
$$;

comment on function public.film_sweep_status() is
  'Film sweep status (0212): per runner its last run (null: never), the newest completed sweep, open segments, and overdue '
  '(a segment open and no completed sweep in 20 minutes; null when no sweep was ever recorded). Service role only.';

revoke all on function public.film_sweep(text) from public, anon, authenticated, service_role;
revoke all on function public.film_sweep_status() from public, anon, authenticated, service_role;
grant execute on function public.film_sweep(text) to service_role;
grant execute on function public.film_sweep_status() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Every 5 minutes, when pg_cron is enabled (as 0111 and 0164 schedule theirs)
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regprocedure('cron.schedule(text, text, text)') is not null
     and to_regprocedure('cron.unschedule(text)') is not null
     and to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'nightshift-film-sweep') then
      perform cron.unschedule('nightshift-film-sweep');
    end if;
    perform cron.schedule('nightshift-film-sweep', '*/5 * * * *', 'select public.film_sweep(''pg_cron'')');
  else
    raise notice '0212: pg_cron is not enabled, so no schedule was created; .github/workflows/film_sweep.yml sweeps every 10 minutes';
  end if;
exception when others then
  -- All or nothing: a failed schedule undoes the unschedule above (this block is one subtransaction).
  raise notice '0212: pg_cron schedule not created (%); .github/workflows/film_sweep.yml sweeps every 10 minutes', sqlerrm;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. End state (raises, and so rolls the whole file back, when anything above did not land as written)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
  h text;
  role_ text;
  p text;
begin
  for r in select * from (values
      ('public.film_sweep(text)', '10dcda57c382fd7f3f2ed4a32fb62e44'),
      ('public.film_sweep_status()', 'ac6b8f6a210ebb7ad092e1f23b78438c')) v(sig, want) loop
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
-- Is it running? (after the first scheduled pass: Actions within about 10 minutes, pg_cron within 5 where installed)
--   select public.film_sweep_status();
--   select runner, last_at, last_settled, last_error, last_error_at from public.film_sweep_runs order by runner;
--
-- And, only if pg_cron is on:
--   select jobname, schedule, command from cron.job where jobname = 'nightshift-film-sweep';
