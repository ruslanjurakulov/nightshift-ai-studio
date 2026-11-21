-- 0017_render_jobs.sql — a job queue for the pipeline worker (roadmap phase B).
--
-- Until now every video was made by .github/workflows/daily_video.yml: a
-- 6-hour ceiling, an output/ directory that vanishes with the runner, and resume
-- state smuggled between runs through the Actions cache. This table is the
-- alternative: a long-running worker on a VPS (tools/queue_worker.py, packaged
-- by Dockerfile.worker) claims a row, runs exactly the command the workflow
-- runs for that channel, and writes back how it went.
--
-- Opt-in. GitHub Actions stays the default: the Command Center writes here only
-- when its server env NIGHTSHIFT_RUN_BACKEND is 'queue', and the hourly schedule
-- keeps running on Actions either way. With this table absent, "Run now" in
-- queue mode says the queue is unavailable instead of pretending it queued.
--
-- Who may do what:
--   * the browser never touches this table. The Command Center's "Run now" route
--     inserts SERVER-SIDE through the signed-in user's RLS-checked client — the
--     dashboard still never holds the service key (CLAUDE.md rule 3);
--   * that insert is narrowed to exactly what "Run now" already dispatches on
--     Actions: an admin+, a 'daily' job, status 'queued', never a privacy other
--     than private, never resume/repair, filed as themselves. Nothing here lets a
--     browser request more publishing or spend than the button already did;
--   * signed-in operators may read jobs (status, timestamps, a scrubbed error);
--   * nobody but the service key (the worker) may update or delete a job, or
--     claim one: claim_render_job is revoked from anon and authenticated;
--   * anon gets nothing at all.
--
-- Additive and idempotent: guarded creates, drop-then-create policies and
-- constraints, create-or-replace functions. Safe to re-run.

create table if not exists public.render_jobs (
  id            bigserial primary key,
  channel_id    text not null,
  kind          text not null default 'daily',
  params        jsonb not null default '{}'::jsonb,
  status        text not null default 'queued',
  attempts      integer not null default 0,
  max_attempts  integer not null default 3,
  worker_id     text,
  heartbeat_at  timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  requested_by  uuid default auth.uid()
);

comment on table public.render_jobs is
  'Pipeline jobs for the VPS worker (tools/queue_worker.py). One row = one main.py run for one channel, with the same whitelisted inputs daily_video.yml accepts. Written by the Command Center (insert only, RLS-narrowed) and the worker (service key).';
comment on column public.render_jobs.params is
  'The workflow_dispatch inputs for this run, minus channel: topic, niche, privacy, duration, language, visual_style, video_provider, image_provider, resume, repair_scenes. Nothing else is accepted (render_job_params_valid).';
comment on column public.render_jobs.heartbeat_at is
  'Refreshed by the worker while the run is alive. A running job whose heartbeat is stale is re-queued by claim_render_job (bounded by max_attempts).';
comment on column public.render_jobs.error is
  'Why the job failed: exit code and a truncated, secret-scrubbed tail of the run log. Never a key or token.';

-- The same inputs the workflow accepts, with the same choice lists, and the
-- same repair rules modules/scene_repair.py validates (repair needs scenes and
-- excludes resume). plpgsql, so each key is checked only after its type is —
-- a CHECK expression gives no evaluation-order guarantee.
create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','resume','repair_scenes'];
  has_repair boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(allowed)) then
      return false;
    end if;
  end loop;

  foreach k in array array['topic','niche','language','visual_style','repair_scenes'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'string' then
      return false;
    end if;
  end loop;
  if length(coalesce(p ->> 'topic', '')) > 300
     or length(coalesce(p ->> 'niche', '')) > 120
     or length(coalesce(p ->> 'language', '')) > 40
     or length(coalesce(p ->> 'visual_style', '')) > 300
     or length(coalesce(p ->> 'repair_scenes', '')) > 120 then
    return false;
  end if;

  if p ? 'duration' then
    if jsonb_typeof(p -> 'duration') <> 'number' then
      return false;
    end if;
    if (p ->> 'duration')::numeric <> trunc((p ->> 'duration')::numeric)
       or (p ->> 'duration')::numeric not between 30 and 3600 then
      return false;
    end if;
  end if;

  if p ? 'privacy' and (jsonb_typeof(p -> 'privacy') <> 'string'
                        or p ->> 'privacy' not in ('private', 'unlisted', 'public')) then
    return false;
  end if;
  if p ? 'video_provider' and (jsonb_typeof(p -> 'video_provider') <> 'string'
      or p ->> 'video_provider' not in ('minimax','higgsfield','kling','veo','seedance','wan')) then
    return false;
  end if;
  if p ? 'image_provider' and (jsonb_typeof(p -> 'image_provider') <> 'string'
      or p ->> 'image_provider' not in ('pexels','leonardo')) then
    return false;
  end if;
  if p ? 'resume' and jsonb_typeof(p -> 'resume') <> 'boolean' then
    return false;
  end if;

  has_repair := length(btrim(coalesce(p ->> 'repair_scenes', ''))) > 0;
  if p_kind = 'repair' then
    return has_repair and coalesce((p ->> 'resume')::boolean, false) = false;
  end if;
  return not has_repair;
end
$$;

alter table public.render_jobs drop constraint if exists render_jobs_channel_id_check;
alter table public.render_jobs add constraint render_jobs_channel_id_check
  check (channel_id ~ '^[a-z0-9][a-z0-9-]{0,63}$');

alter table public.render_jobs drop constraint if exists render_jobs_kind_check;
alter table public.render_jobs add constraint render_jobs_kind_check
  check (kind in ('daily', 'repair'));

alter table public.render_jobs drop constraint if exists render_jobs_status_check;
alter table public.render_jobs add constraint render_jobs_status_check
  check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled'));

alter table public.render_jobs drop constraint if exists render_jobs_attempts_check;
alter table public.render_jobs add constraint render_jobs_attempts_check
  check (attempts >= 0 and max_attempts between 1 and 10);

alter table public.render_jobs drop constraint if exists render_jobs_error_check;
alter table public.render_jobs add constraint render_jobs_error_check
  check (error is null or length(error) <= 2000);

alter table public.render_jobs drop constraint if exists render_jobs_params_check;
alter table public.render_jobs add constraint render_jobs_params_check
  check (public.render_job_params_valid(params, kind));

-- The claim: oldest queued first.
create index if not exists render_jobs_queue_idx
  on public.render_jobs (created_at, id) where status = 'queued';
-- The dashboard: a channel's recent jobs.
create index if not exists render_jobs_channel_idx
  on public.render_jobs (channel_id, created_at desc);
-- The stale-heartbeat sweep.
create index if not exists render_jobs_running_idx
  on public.render_jobs (heartbeat_at) where status = 'running';
-- One running job per channel. Two concurrent runs of one channel would share
-- its output/ resume ledgers and upload-attempt state — a database rule, so a
-- second worker cannot break it by racing the first.
create unique index if not exists render_jobs_one_running_per_channel
  on public.render_jobs (channel_id) where status = 'running';

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.render_jobs enable row level security;
revoke all on public.render_jobs from anon;

drop policy if exists render_jobs_select on public.render_jobs;
create policy render_jobs_select on public.render_jobs
  for select to authenticated using (true);

-- Exactly what "Run now" dispatches on Actions, and nothing more. Starting a
-- run is an admin action (the route checks it too; this is the guarantee).
drop policy if exists render_jobs_insert on public.render_jobs;
create policy render_jobs_insert on public.render_jobs
  for insert to authenticated
  with check (
    public.app_role_rank(public.current_app_role()) >= public.app_role_rank('admin')
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
-- No update or delete policy: only the worker's service key changes a job.

-- ── The claim ──────────────────────────────────────────────────────────────
-- Called by the worker (service key) in a loop. First returns crashed jobs to
-- the queue: a running job whose heartbeat is older than p_stale_after lost its
-- worker (VPS reboot, OOM kill, kill -9). It is re-queued while it has attempts
-- left and failed, with the reason, once it has none — a job that kills its
-- worker every time must not loop forever. Then claims the oldest queued job
-- whose channel has nothing running, with FOR UPDATE SKIP LOCKED so two workers
-- never claim the same row.
create or replace function public.claim_render_job(
  p_worker text,
  p_stale_after interval default interval '10 minutes'
)
  returns setof public.render_jobs
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_id bigint;
begin
  if coalesce(btrim(p_worker), '') = '' then
    raise exception 'claim_render_job: p_worker is required';
  end if;

  update public.render_jobs j
     set status      = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
         finished_at = case when j.attempts >= j.max_attempts then now() else null end,
         error       = case when j.attempts >= j.max_attempts
                            then 'worker lost (no heartbeat) on the last of ' || j.max_attempts || ' attempts'
                            else 'worker lost (no heartbeat); re-queued' end,
         worker_id   = null
   where j.id in (
           select s.id from public.render_jobs s
            where s.status = 'running'
              and coalesce(s.heartbeat_at, s.started_at, s.created_at) < now() - p_stale_after
            for update skip locked);

  select q.id into v_id
    from public.render_jobs q
   where q.status = 'queued'
     and not exists (select 1 from public.render_jobs r
                      where r.channel_id = q.channel_id and r.status = 'running')
   order by q.created_at, q.id
   for update skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  begin
    return query
      update public.render_jobs j
         set status       = 'running',
             worker_id    = p_worker,
             attempts     = j.attempts + 1,
             started_at   = now(),
             heartbeat_at = now(),
             finished_at  = null
       where j.id = v_id
      returning j.*;
  exception when unique_violation then
    -- Another worker started this channel's job in the same instant. Nothing
    -- claimed; the caller polls again.
    return;
  end;
end
$$;

revoke all on function public.claim_render_job(text, interval) from public, anon, authenticated;
grant execute on function public.claim_render_job(text, interval) to service_role;
