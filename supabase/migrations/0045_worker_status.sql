-- 0045_worker_status.sql — what each background worker is doing, visible in
-- Command Center, and an honest state for customers when the media worker is
-- not running.
--
-- WHY
--   The media worker (tools/media_worker.py) exits with a remedy message when
--   something it needs is missing (env, writable volumes, ffmpeg) and the
--   container restarts, over and over. Uploads then sit in "waiting for the
--   server check" forever, and the reason is only in container logs, which stay
--   on the server by design (the Actions output is public). Workers now report
--   their own state, with the remedy text, through report_worker_status().
--
-- WHAT IT ADDS
--   worker_status          one row per worker: kind, state (starting | running |
--                          failed | stopped), a short scrubbed detail, version,
--                          started_at, updated_at (the heartbeat).
--   report_worker_status   service role only; upserts the caller's row. Clamps
--                          detail to its first 300 characters and removes
--                          control characters. The WORKER scrubs secrets before
--                          sending (the same scrubber as the other workers);
--                          the message names variables, never values.
--   media_pipeline_state   a customer-safe answer for the media library:
--                          {state: ok | stale | failed | unknown, age_seconds}
--                          and nothing else — no detail text, no worker ids, no
--                          organization data. 'stale' = no heartbeat for more
--                          than 120 seconds. 'unknown' = no media worker has
--                          ever reported (an older worker image, or nothing
--                          running yet).
--
-- WHO MAY DO WHAT
--   worker_status          select: platform owner/admin (is_platform_admin()) ·
--                          nobody writes the table directly, not even the
--                          service role · customers and anon: nothing
--   report_worker_status   service role only
--   media_pipeline_state   authenticated (any signed-in user); anon: nothing
--
-- REQUIRES 0018 (is_platform_admin) and 0020 (credits_trusted_caller). It does
-- not need 0038 or any other table. Additive and idempotent: guarded create,
-- create-or-replace functions, drop-then-create policy.

do $$
begin
  if to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0045 needs is_platform_admin(): apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0045 needs credits_trusted_caller(): apply 0020_credits.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The table
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.worker_status (
  worker_id   text primary key check (char_length(worker_id) between 1 and 120),
  kind        text not null check (kind in ('media', 'creative', 'pipeline', 'other')),
  state       text not null check (state in ('starting', 'running', 'failed', 'stopped')),
  detail      text check (detail is null or char_length(detail) <= 300),
  version     text check (version is null or char_length(version) <= 100),
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists worker_status_kind_updated_idx on public.worker_status (kind, updated_at desc);

comment on table public.worker_status is
  'One row per background worker: state, a short scrubbed detail (the remedy when it failed) and the heartbeat. Written only by report_worker_status() (service role); read by the platform owner/admin only (migration 0045).';

alter table public.worker_status enable row level security;

revoke all on public.worker_status from public, anon, authenticated, service_role;
grant select on public.worker_status to authenticated, service_role;

drop policy if exists worker_status_select on public.worker_status;
create policy worker_status_select on public.worker_status
  for select to authenticated
  using ((select public.is_platform_admin()));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The worker's report (service role)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.report_worker_status(
  p_worker_id text, p_kind text, p_state text, p_detail text default null, p_version text default null
) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  wid text := left(btrim(coalesce(p_worker_id, '')), 120);
  det text := nullif(left(btrim(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]+', ' ', 'g')), 300), '');
  ver text := nullif(left(btrim(coalesce(p_version, '')), 100), '');
begin
  if not public.credits_trusted_caller() then
    raise exception 'worker status is reported by the platform''s workers only' using errcode = '42501';
  end if;
  if wid = '' then
    raise exception 'worker_id is required' using errcode = '22023';
  end if;
  -- kind and state are checked by the table's constraints (23514).
  insert into public.worker_status (worker_id, kind, state, detail, version, started_at, updated_at)
  values (wid, p_kind, p_state, det, ver, now(), now())
  on conflict (worker_id) do update
     set kind = excluded.kind,
         state = excluded.state,
         detail = excluded.detail,
         version = excluded.version,
         started_at = case when excluded.state = 'starting' then now() else public.worker_status.started_at end,
         updated_at = now();
  -- Worker ids can include a process id, so a worker that restarts under a new
  -- id leaves its old row behind. Rows nobody has touched for two weeks go.
  delete from public.worker_status where updated_at < now() - interval '14 days';
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. What a customer may know: is file checking running?
-- ───────────────────────────────────────────────────────────────────────────

-- ok       a media worker reported 'running' or 'starting' in the last 120 s
-- failed   none did, but one reported 'failed' in the last 120 s
-- stale    media workers have reported before, but none in the last 120 s (or
--          the last word was a clean stop)
-- unknown  no media worker has ever reported
-- age_seconds: how long ago the most recent media report was (null when unknown).
create or replace function public.media_pipeline_state() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  latest timestamptz;
  age integer;
  fresh constant interval := interval '120 seconds';
  verdict text;
begin
  select max(updated_at) into latest from public.worker_status where kind = 'media';
  if latest is null then
    return jsonb_build_object('state', 'unknown', 'age_seconds', null);
  end if;
  age := greatest(0, floor(extract(epoch from (now() - latest)))::integer);
  if exists (select 1 from public.worker_status
              where kind = 'media' and state in ('running', 'starting') and updated_at > now() - fresh) then
    verdict := 'ok';
  elsif exists (select 1 from public.worker_status
                 where kind = 'media' and state = 'failed' and updated_at > now() - fresh) then
    verdict := 'failed';
  else
    verdict := 'stale';
  end if;
  return jsonb_build_object('state', verdict, 'age_seconds', age);
end
$$;

revoke all on function public.report_worker_status(text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.media_pipeline_state() from public, anon, authenticated, service_role;
grant execute on function public.report_worker_status(text, text, text, text, text) to service_role;
grant execute on function public.media_pipeline_state() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.worker_status'::regclass) as rls_on,
--   not has_table_privilege('anon', 'public.worker_status', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.worker_status', 'INSERT')
--     and not has_table_privilege('service_role', 'public.worker_status', 'INSERT')
--     and not has_table_privilege('service_role', 'public.worker_status', 'UPDATE') as locked,
--   not has_function_privilege('authenticated',
--     'public.report_worker_status(text,text,text,text,text)', 'EXECUTE') as report_is_service_only,
--   not has_function_privilege('anon', 'public.media_pipeline_state()', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.media_pipeline_state()', 'EXECUTE') as state_is_signed_in_only;
