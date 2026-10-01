-- 0057_storyboard_review.sql — read the plan before paying for the render.
--
-- A channel can ask for its runs to stop at "Storyboard ready": the script
-- and the scene plan exist (topic, research, script and fact-check are done),
-- and nothing has been spent yet on the narration, the generated footage or
-- the render. A person reads the scene cards, sees ONE price for the render,
-- and either approves it — which places the credit hold for exactly that
-- render and starts it — or discards it. Publishing still goes through the
-- publish gate and the approvals afterwards; this is an earlier checkpoint,
-- never a replacement for one.
--
-- The switch is per channel (channels.agent_config.storyboard_review, no
-- column), off unless explicitly true: scheduled and autopilot runs behave
-- exactly as before unless a channel turns it on. With it on, a run never
-- renders on its own — not even a scheduled one.
--
-- WHAT IT ADDS
--   storyboards              one row per paused run: the channel, the run's
--                            key (slug, as the run checkpoint keys it), the
--                            topic, the scene cards shown to the person
--                            (scenes), the script the render resumes from
--                            (script — data the worker reads, never code), the
--                            length the render is priced for (duration_s,
--                            30..3600 like render_jobs), and where it stands:
--                              ready     waiting for a person
--                              approved  paid for and started (or queued)
--                              rendered  the render finished
--                              discarded a person said no; nothing renders
--                            At most one ready/approved row per channel + slug.
--   approve_storyboard(id, amount, backend)
--                            the priced press. Locks the row, checks it is
--                            still 'ready', reserves the credits for the
--                            render (reserve_credits — the caller's own role
--                            check, balance check and plan limit) under a
--                            reference derived from the storyboard, marks it
--                            approved and, on the queue backend, queues the
--                            render job (resume = true, the storyboard's topic
--                            and frozen length) in the same transaction. Any
--                            refusal rolls all of it back: nothing is held.
--   discard_storyboard(id)   ready -> discarded. Nothing renders, and a ready
--                            storyboard holds nothing (the runner released the
--                            planning run's hold when it paused).
--   storyboard_dispatch_failed(id)
--                            Actions backend only: the route could not
--                            dispatch the approved render, so the hold it
--                            placed is released and the storyboard is ready
--                            again. Refused once the render has claimed its
--                            hold, and after 15 minutes.
--
-- MONEY
--   * The planning run is not charged: the runner (tools/queue_worker.py,
--     tools/credits_settle.py) releases its hold in full when the run stops at
--     the storyboard, exactly as for a run that produced no video.
--   * The render's hold is placed only at approve, priced by the Command Center
--     from the storyboard's own length, and confirmed against the price the
--     person saw (max_credits, 409 price_changed otherwise). It is never below
--     the platform floor for that length — the same floor render_jobs_payment_
--     guard (0041) applies — and the queued job carries that length frozen, so
--     the 0041 rules apply to it unchanged.
--   * One storyboard is approved once: the row lock and the 'ready' check come
--     before the reservation, and the reference is unique per approval, so a
--     double press, a replay or two admins at once hold once.
--   * The operator's own (credits-exempt) organization holds nothing, as
--     everywhere else.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser via the anon key)
--   storyboards              select: members of the channel's organization ·
--                            insert / update / delete: nobody directly
--   approve / discard /
--   dispatch_failed          authenticated; each checks that the caller may
--                            start runs on the channel — an admin of its
--                            organization, the Run now rule (0041's insert
--                            policy, reserve_credits). Another organization's
--                            storyboard and a missing one read the same.
--   service_role             select, insert, and update of status (the
--                            pipeline writes the row when it pauses and marks
--                            it rendered); the content of a row that is no
--                            longer 'ready' is frozen for every writer.
--   anon gets nothing.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps,
-- command-center/lib/storyboardReview.ts)
--   42501 forbidden (not signed in / may not start runs here / no such storyboard)
--   NS409 storyboard_not_ready (already approved, rendered or discarded)
--   22023 invalid_backend | price_required | below_floor | dispatch_window_passed
--   NS402 / NS429 / 23505 from reserve_credits (insufficient credits, plan's
--         run limit, reference already used)
--
-- REQUIRES 0017 (render_jobs), 0018 (organizations), 0020 (credits), 0041
-- (frozen terms). Additive and idempotent: guarded creates, create-or-replace
-- functions, drop-then-create policy, trigger and constraints. Nothing is
-- dropped or rewritten.

do $$
begin
  if to_regclass('public.render_jobs') is null then
    raise exception '0057 needs public.render_jobs: apply 0017_render_jobs.sql first';
  end if;
  if to_regprocedure('public.accessible_channel_ids(text)') is null then
    raise exception '0057 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.reserve_credits(uuid,text,numeric)') is null
     or to_regprocedure('public.credit_release_locked(text,text)') is null then
    raise exception '0057 needs the credit ledger: apply 0020_credits.sql first';
  end if;
  if to_regprocedure('public.render_jobs_payment_guard()') is null then
    raise exception '0057 needs the run billing rules: apply 0041_run_billing_hardening.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The scene cards are data with bounds
-- ───────────────────────────────────────────────────────────────────────────
-- One card per scene: its number, the narration line, the visual
-- description, and its length in seconds. Bounded here so a card that would
-- not fit a screen — or a payload pretending to be one — cannot be stored by
-- any writer. Pure, so it can back a CHECK.

create or replace function public.storyboard_scenes_valid(p jsonb) returns boolean
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  s jsonb;
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 1 and 60 then
    return false;
  end if;
  for s in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(s) <> 'object' then
      return false;
    end if;
    for k in select jsonb_object_keys(s) loop
      if not (k = any (array['n', 'name', 'type', 'narration', 'visual', 'duration_s'])) then
        return false;
      end if;
    end loop;
    if jsonb_typeof(s -> 'n') <> 'number' or (s ->> 'n')::numeric not between 1 and 60
       or jsonb_typeof(s -> 'narration') <> 'string' or length(s ->> 'narration') > 4000
       or jsonb_typeof(s -> 'visual') <> 'string' or length(s ->> 'visual') > 1000
       or jsonb_typeof(s -> 'duration_s') <> 'number'
       or (s ->> 'duration_s')::numeric <> trunc((s ->> 'duration_s')::numeric)
       or (s ->> 'duration_s')::numeric not between 1 and 600 then
      return false;
    end if;
    if s ? 'name' and (jsonb_typeof(s -> 'name') <> 'string' or length(s ->> 'name') > 120) then
      return false;
    end if;
    if s ? 'type' and (jsonb_typeof(s -> 'type') <> 'string' or length(s ->> 'type') > 40) then
      return false;
    end if;
  end loop;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The table
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.storyboards (
  id            uuid primary key default gen_random_uuid(),
  channel_id    text not null references public.channels (channel_id) on update cascade,
  slug          text not null,
  topic         text not null,
  title         text,
  scenes        jsonb not null,
  script        jsonb not null,
  hook_variant  text not null default 'A',
  duration_s    integer not null,
  status        text not null default 'ready',
  created_at    timestamptz not null default now(),
  decided_by    uuid,
  decided_at    timestamptz,
  approvals     integer not null default 0,
  backend       text,
  credit_ref    text,
  credits_held  numeric(14, 2),
  render_job_id bigint,
  rendered_at   timestamptz
);

comment on table public.storyboards is
  'A run paused at "Storyboard ready" (channels.agent_config.storyboard_review): the scene cards a person reviews, the script the render resumes from, and the length the render is priced for. Written by the pipeline (service key); approved or discarded only through approve_storyboard / discard_storyboard.';
comment on column public.storyboards.script is
  'The Script JSON the approved render resumes from (modules/storyboard_review.py materialises it as output/<slug>/script.json). Data only: never interpolated into a command.';
comment on column public.storyboards.duration_s is
  'The length the render is priced for and frozen at (render_jobs.params.duration).';

alter table public.storyboards drop constraint if exists storyboards_slug_check;
alter table public.storyboards add constraint storyboards_slug_check
  check (slug ~ '^[a-z0-9][a-z0-9-]{0,49}$');
alter table public.storyboards drop constraint if exists storyboards_topic_check;
alter table public.storyboards add constraint storyboards_topic_check
  check (length(btrim(topic)) between 1 and 300);
alter table public.storyboards drop constraint if exists storyboards_title_check;
alter table public.storyboards add constraint storyboards_title_check
  check (title is null or length(title) <= 300);
alter table public.storyboards drop constraint if exists storyboards_scenes_check;
alter table public.storyboards add constraint storyboards_scenes_check
  check (public.storyboard_scenes_valid(scenes));
alter table public.storyboards drop constraint if exists storyboards_script_check;
alter table public.storyboards add constraint storyboards_script_check
  check (jsonb_typeof(script) = 'object' and pg_column_size(script) <= 262144);
alter table public.storyboards drop constraint if exists storyboards_hook_check;
alter table public.storyboards add constraint storyboards_hook_check
  check (hook_variant in ('A', 'B'));
alter table public.storyboards drop constraint if exists storyboards_duration_check;
alter table public.storyboards add constraint storyboards_duration_check
  check (duration_s between 30 and 3600);
alter table public.storyboards drop constraint if exists storyboards_status_check;
alter table public.storyboards add constraint storyboards_status_check
  check (status in ('ready', 'approved', 'rendered', 'discarded'));
alter table public.storyboards drop constraint if exists storyboards_backend_check;
alter table public.storyboards add constraint storyboards_backend_check
  check (backend is null or backend in ('queue', 'actions'));
alter table public.storyboards drop constraint if exists storyboards_approvals_check;
alter table public.storyboards add constraint storyboards_approvals_check
  check (approvals between 0 and 1000);

-- One run waits, or renders, once: a second planning run of the same topic
-- finds this row and waits on it instead of adding another.
create unique index if not exists storyboards_one_active
  on public.storyboards (channel_id, slug) where status in ('ready', 'approved');
create index if not exists storyboards_channel_idx
  on public.storyboards (channel_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. What was approved is what renders
-- ───────────────────────────────────────────────────────────────────────────
-- For every writer, the service key included: the content of a storyboard
-- that is no longer waiting cannot change (the hold priced THAT length and
-- the person read THOSE scenes), and status moves only forward —
-- ready -> approved | discarded, approved -> rendered, and approved -> ready
-- for an Actions dispatch that never left (storyboard_dispatch_failed).

create or replace function public.storyboards_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.channel_id is distinct from old.channel_id
     or new.slug is distinct from old.slug
     or new.created_at is distinct from old.created_at then
    raise exception 'a storyboard''s channel and run are fixed' using errcode = '42501';
  end if;
  if old.status <> 'ready'
     and (new.topic is distinct from old.topic
          or new.title is distinct from old.title
          or new.scenes is distinct from old.scenes
          or new.script is distinct from old.script
          or new.hook_variant is distinct from old.hook_variant
          or new.duration_s is distinct from old.duration_s) then
    raise exception 'a storyboard that is no longer waiting cannot be changed' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not ((old.status = 'ready' and new.status in ('approved', 'discarded'))
              or (old.status = 'approved' and new.status in ('rendered', 'ready'))) then
    raise exception 'a storyboard cannot go from % to %', old.status, new.status using errcode = '42501';
  end if;
  if new.approvals < old.approvals then
    raise exception 'a storyboard''s approval count only grows' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists storyboards_guard on public.storyboards;
create trigger storyboards_guard
  before update on public.storyboards
  for each row execute function public.storyboards_guard();

-- A new storyboard starts waiting, with nothing decided and nothing held.
create or replace function public.storyboards_insert_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status <> 'ready' or new.decided_by is not null or new.decided_at is not null
     or new.approvals <> 0 or new.backend is not null or new.credit_ref is not null
     or new.credits_held is not null or new.render_job_id is not null
     or new.rendered_at is not null then
    raise exception 'a storyboard starts ready, undecided and unpaid' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists storyboards_insert_guard on public.storyboards;
create trigger storyboards_insert_guard
  before insert on public.storyboards
  for each row execute function public.storyboards_insert_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The decisions
-- ───────────────────────────────────────────────────────────────────────────

-- The row, locked, if the caller may start runs on its channel. Missing and
-- not-yours are the same refusal: no oracle for another tenant's ids.
create or replace function public.storyboard_lock_for_runner(p_storyboard uuid)
  returns public.storyboards
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  sb public.storyboards;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into sb from public.storyboards where id = p_storyboard for update;
  if sb.id is null or not (sb.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return sb;
end
$$;

create or replace function public.approve_storyboard(p_storyboard uuid, p_amount numeric, p_backend text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  sb      public.storyboards;
  v_org   uuid;
  v_ref   text;
  v_held  numeric;
  v_job   bigint;
  v_res   jsonb;
  jm      numeric;
  vm      public.credit_prices;
  v_need  numeric;
begin
  sb := public.storyboard_lock_for_runner(p_storyboard);
  if p_backend is null or p_backend not in ('queue', 'actions') then
    raise exception 'invalid_backend' using errcode = '22023';
  end if;
  -- Before anything is held: a second press, a replay or a second admin
  -- waits on the lock above and stops here.
  if sb.status <> 'ready' then
    raise exception 'storyboard_not_ready' using errcode = 'NS409', detail = sb.status;
  end if;

  v_org := public.channel_org(sb.channel_id);
  if v_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not public.credits_exempt(v_org) then
    if p_amount is null then
      raise exception 'price_required' using errcode = '22023';
    end if;
    -- The floor for THIS storyboard's length — what render_jobs_payment_guard
    -- (0041) requires of a queued run of that length, and what the Actions
    -- runner checks (modules/credits.minimum_reservation). A browser can call
    -- this function directly with any amount; it cannot buy a render below it.
    select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
    select * into vm from public.credit_prices where unit = 'video_minute';
    v_need := public.credits_round_up(greatest(
      coalesce(jm, 0),
      coalesce(vm.credits_per_unit * (1 + vm.margin) * sb.duration_s / 60, 0)));
    if v_need > 0 and public.credits_round_up(p_amount) < v_need then
      raise exception 'below_floor' using errcode = '22023', detail = format('needed=%s', v_need);
    end if;
    -- One reference per approval of this storyboard: reserve_credits refuses a
    -- reused one (23505), so no path holds twice for the same press.
    v_ref := case p_backend when 'queue' then 'rj-' else 'gh-' end
             || 'sb' || (sb.approvals + 1)::text || '-' || replace(sb.id::text, '-', '');
    v_res := public.reserve_credits(v_org, v_ref, p_amount);
    if coalesce((v_res ->> 'exempt')::boolean, false) then
      v_ref := null;
    else
      v_held := (v_res ->> 'reserved')::numeric;
    end if;
  end if;

  update public.storyboards
     set status = 'approved', decided_by = auth.uid(), decided_at = now(),
         approvals = approvals + 1, backend = p_backend,
         credit_ref = v_ref, credits_held = v_held
   where id = sb.id;

  if p_backend = 'queue' then
    -- The render resumes this run from its approved script: the topic names
    -- the run (its slug), and the length is the one just priced. The 0041
    -- trigger checks the hold against that length like any queued run.
    insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref)
    values (sb.channel_id, 'daily',
            jsonb_build_object('topic', sb.topic, 'duration', sb.duration_s, 'resume', true),
            auth.uid(), v_ref)
    returning id into v_job;
    update public.storyboards set render_job_id = v_job where id = sb.id;
  end if;

  return jsonb_build_object(
    'id', sb.id, 'status', 'approved', 'backend', p_backend,
    'credit_ref', v_ref, 'credits_held', v_held, 'render_job_id', v_job,
    'topic', sb.topic, 'duration_s', sb.duration_s, 'channel_id', sb.channel_id);
end
$$;

create or replace function public.discard_storyboard(p_storyboard uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  sb public.storyboards;
begin
  sb := public.storyboard_lock_for_runner(p_storyboard);
  if sb.status <> 'ready' then
    raise exception 'storyboard_not_ready' using errcode = 'NS409', detail = sb.status;
  end if;
  -- A waiting storyboard holds nothing: its planning run's hold was released
  -- when the run paused, and an Actions approval that never dispatched was
  -- put back by storyboard_dispatch_failed, which releases its hold.
  update public.storyboards
     set status = 'discarded', decided_by = auth.uid(), decided_at = now()
   where id = sb.id;
  return jsonb_build_object('id', sb.id, 'status', 'discarded');
end
$$;

create or replace function public.storyboard_dispatch_failed(p_storyboard uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  sb public.storyboards;
  r  public.credit_reservations;
  v_released numeric := 0;
begin
  sb := public.storyboard_lock_for_runner(p_storyboard);
  if sb.status <> 'approved' or sb.backend is distinct from 'actions' then
    raise exception 'storyboard_not_ready' using errcode = 'NS409', detail = sb.status;
  end if;
  -- Only the person who approved it, right after: this undoes a dispatch the
  -- route saw fail, it is not a way to re-open a render.
  if sb.decided_by is distinct from auth.uid() or sb.decided_at < now() - interval '15 minutes' then
    raise exception 'dispatch_window_passed' using errcode = '22023';
  end if;
  if sb.credit_ref is not null then
    select * into r from public.credit_reservations where job_id = sb.credit_ref for update;
    -- A started hold is paying for a render that is running.
    if r.job_id is not null and r.started_at is not null then
      raise exception 'dispatch_window_passed' using errcode = '22023';
    end if;
    if r.job_id is not null then
      perform public.credit_account_lock(r.org_id);
      v_released := public.credit_release_locked(sb.credit_ref, 'render was not dispatched');
    end if;
  end if;
  update public.storyboards
     set status = 'ready', decided_by = null, decided_at = null,
         backend = null, credit_ref = null, credits_held = null
   where id = sb.id;
  return jsonb_build_object('id', sb.id, 'status', 'ready', 'released', v_released);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.storyboards enable row level security;
revoke all on public.storyboards from public, anon, authenticated, service_role;
grant select on public.storyboards to authenticated;
-- The pipeline writes the row when it pauses and marks it rendered.
grant select, insert on public.storyboards to service_role;
grant update (status, rendered_at) on public.storyboards to service_role;

drop policy if exists storyboards_select on public.storyboards;
create policy storyboards_select on public.storyboards
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));

revoke all on function public.storyboard_scenes_valid(jsonb) from public, anon;
grant execute on function public.storyboard_scenes_valid(jsonb) to authenticated, service_role;
revoke all on function public.storyboards_guard() from public, anon, authenticated, service_role;
revoke all on function public.storyboards_insert_guard() from public, anon, authenticated, service_role;
revoke all on function public.storyboard_lock_for_runner(uuid) from public, anon, authenticated, service_role;
revoke all on function public.approve_storyboard(uuid, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.discard_storyboard(uuid) from public, anon, authenticated, service_role;
revoke all on function public.storyboard_dispatch_failed(uuid) from public, anon, authenticated, service_role;
grant execute on function public.approve_storyboard(uuid, numeric, text) to authenticated;
grant execute on function public.discard_storyboard(uuid) to authenticated;
grant execute on function public.storyboard_dispatch_failed(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.storyboards'::regclass) as rls_on,
--   has_table_privilege('authenticated', 'public.storyboards', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.storyboards', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.storyboards', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.storyboards', 'DELETE')
--     and not has_table_privilege('anon', 'public.storyboards', 'SELECT') as browser_read_only,
--   not has_table_privilege('service_role', 'public.storyboards', 'DELETE')
--     and not has_column_privilege('service_role', 'public.storyboards', 'script', 'UPDATE')
--     and has_column_privilege('service_role', 'public.storyboards', 'status', 'UPDATE')
--     as pipeline_scoped,
--   has_function_privilege('authenticated', 'public.approve_storyboard(uuid,numeric,text)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.discard_storyboard(uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.approve_storyboard(uuid,numeric,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.storyboard_lock_for_runner(uuid)', 'EXECUTE')
--     as functions_scoped,
--   (select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('approve_storyboard', 'discard_storyboard', 'storyboard_dispatch_failed',
--                         'storyboard_lock_for_runner', 'storyboards_guard', 'storyboards_insert_guard'))
--     as search_path_pinned,
--   exists (select 1 from pg_trigger where tgname = 'storyboards_guard' and not tgisinternal)
--     and exists (select 1 from pg_trigger where tgname = 'storyboards_insert_guard' and not tgisinternal)
--     as guards_on,
--   exists (select 1 from pg_indexes where indexname = 'storyboards_one_active') as one_active_per_run;
