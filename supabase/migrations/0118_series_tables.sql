-- 0118_series_tables.sql — Series Factory, slice S2: the database half of "plan a series, see it priced, start its episodes one at a time".
-- (docs/SERIES_FACTORY.md; the pure planner and price preview are modules/series_planner.py and lib/credits.ts quoteSeries, already on main.)
--
-- WHAT THIS DOES NOT DO. Nothing here calls Gemini or any provider, and nothing in the application calls these functions yet: no UI, no route, no
-- worker job, no workflow. The planner is NOT wired into any live path. request_series_plan() writes a plan row and ONE queue row and stops (CLAUDE.md
-- rule 3); the worker that would read that row is slice S3. Until S3 ships, request_series_plan() is granted to NOBODY (as 0117 did with
-- request_voice_clone): it is created, revoked from every API role and not granted, so no signed-in user can queue a plan job that the live queue
-- worker would only fail. And since an episode exists only after finish_series_plan() (the worker's function), start_series_episode() and
-- quote_series_episode() — which ARE granted to signed-in users — have nothing to act on until then.
--
-- NUMBER. 0118: the highest on main is 0117 (voice_profiles) and no open pull request adds a migration (checked with gh api, 2026-10-24). 0119 is
-- another builder's (channel settings): do not use it here.
--
-- WHAT IT ADDS
--   series_plans        one row per "plan a series" press: the topic, the niche (taken from the SERIES or CHANNEL row, never from the browser),
--                       the language, the number of episodes (3 or 4), the length of each, the state (requested | ready | failed), and — once
--                       the worker finished it — the title, a report and a price preview. The id of the press (idempotency key) and a hash of
--                       what was asked make a replay answer the first press instead of queueing a second.
--   series_episodes     the 3 or 4 episodes of a ready plan: topic, outline (MODEL TEXT, never fact-checked, rule 5: the UI must escape it and
--                       label it), `usable` and `needs_confirmation` from the planner's vetting, and — once started — the hold, the queued run
--                       and who started it. One row per (plan, n).
--   render_jobs.series_plan_id and kind 'series_plan'   the queue row of a planning press. render_jobs_kind_check gains the kind;
--                       render_job_params_valid gains the optional `series` key (a slug) and the rule for the new kind; the payment guard learns
--                       that a planning job is paid by nobody (planning is free to the customer, capped per organization per day: owner decision 3,
--                       the cap is a placeholder below).
--
-- WHO MAY DO WHAT
--   RLS: a member of the organization reads its plans and episodes. NO API role (anon, authenticated, service_role) has INSERT, UPDATE or DELETE
--   on either table: every write is a SECURITY DEFINER function with a pinned search_path (public, pg_temp), EXECUTE revoked from public, anon,
--   authenticated and service_role, then granted narrowly:
--     signed-in member:  quote_series_episode (viewer or above), start_series_episode (an ADMIN of the organization, the rule reserve_credits
--                        applies; the operator's own organization: a platform administrator, as start_workflow_run)
--     NOBODY (dormant):  request_series_plan (editor or above once S3 grants it)
--     service role:      finish_series_plan
--     nobody (internal): series_plan_daily_limit, series_episode_price, series_episode_blocker, series_episode_json and the two trigger functions
--   A user acts only on plans and episodes of organizations they belong to. A missing id, another organization's id and a channel or series that is
--   not in the caller's scope are the SAME answer (SQLSTATE P0002, message `not_found`): no oracle for another tenant's ids.
--
-- THE MONEY (the point of start_series_episode)
--   * THE DATABASE PRICES THE EPISODE. series_episode_price() is the formula render_jobs_payment_guard already enforces for a queued run:
--     max(job_minimum, video_minute x (1 + margin) x seconds / 60), rounded UP to the cent. The browser sends the price it SAW (p_max_credits) and
--     the function refuses (price_changed, NS409) unless it equals the price as computed NOW, in either direction. A browser cannot pick the hold.
--   * UNPRICED REFUSES, never 0. No video_minute rate (or a zero one) is `unpriced` (NS400): nothing is held, nothing is queued. The operator's own
--     organization pays nothing (0020: credits_exempt) and so needs no price.
--   * ONE HOLD PER EPISODE, TAKEN WHEN IT STARTS. reserve_credits(org, 'rj-se-<episode id, no dashes>', price): the reference is derived from the
--     episode id, so no path can hold twice for one episode (reserve_credits refuses a reused reference, even a released one). The run is an
--     ordinary 'daily' render job carrying that hold (credit_ref), so the 0041/0111 payment guard checks it like any queued run, and the worker
--     captures or releases it like any run. Nothing is held for an episode that has not started, so there is no timed hold to expire (reservations
--     expire after 3 hours, 0020).
--   * IDEMPOTENT. The idempotency key of an episode start is `se:<episode id>`: p_idem must be exactly that. The same press again (a retry, a
--     second tab, a second admin) answers the first start with replayed = true and holds nothing more; the same key with another confirmed price
--     is idempotency_conflict (NS409).
--   * ONE EPISODE AT A TIME, IN ORDER. Episode n starts only when every earlier episode of the plan has been started AND its run has succeeded
--     (render_jobs.status = 'succeeded'; a run that stops at its storyboard review ends 'succeeded', 0057). A failed or still-running earlier
--     episode blocks the later ones (earlier_episode_not_finished, NS409). An episode is started ONCE: a retry of a failed episode is a person's
--     decision and a later slice (it needs a fresh hold reference).
--   * AN UNCONFIRMED EPISODE IS NOT STARTED BY ACCIDENT. An episode the planner accepted without confirming its niche (needs_confirmation) starts
--     only when the caller passes p_confirmed = true (the S3 UI's explicit step); an episode the vetting refused (usable = false) never starts.
--
-- PLANNING IS FREE, CAPPED. series_plan_daily_limit() plans per organization per rolling 24 hours (5: a placeholder for owner decision 3, one
-- function to change), one plan in flight per channel, and a plan that was never finished is expired after 2 hours. The cap is checked after the
-- idempotency replay, under an advisory lock per organization, so two concurrent requests cannot both pass it.
--
-- WHAT A READER OF THIS FILE SHOULD CHECK FIRST: the two functions it REPLACES (render_job_params_valid from 0029, render_jobs_payment_guard from
-- 0111, each their latest body verbatim plus marked additions) and the DO block that refuses to replace a body it has not seen.
--
-- Additive and idempotent: create ... if not exists, create or replace, drop trigger / policy then create, revoke then grant. No existing row is
-- rewritten. An applied migration is never edited. Rollback: docs/sql/rollback_0118_series_tables.sql.
-- REQUIRES 0018 (organizations, is_org_member), 0006 (content_series), 0017 (render_jobs), 0020/0034/0094 (reserve_credits, credit_account_lock,
-- credit_prices), 0041/0076/0111 (render_jobs_payment_guard), 0029 (render_job_params_valid).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.channels') is null or to_regclass('public.organizations') is null
     or to_regclass('public.org_members') is null or to_regclass('public.app_members') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.is_platform_admin()') is null
     or to_regprocedure('public.channel_org(text)') is null then
    raise exception '0118 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.content_series') is null then
    raise exception '0118 needs 0006_content_series.sql (content_series): apply it first';
  end if;
  if to_regclass('public.render_jobs') is null or to_regprocedure('public.render_job_params_valid(jsonb, text)') is null then
    raise exception '0118 needs 0017_render_jobs.sql (render_jobs, render_job_params_valid): apply it first';
  end if;
  if to_regclass('public.credit_prices') is null or to_regclass('public.credit_reservations') is null
     or to_regprocedure('public.reserve_credits(uuid, text, numeric)') is null
     or to_regprocedure('public.credit_account_lock(uuid)') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null
     or to_regprocedure('public.credits_round_up(numeric)') is null
     or to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0118 needs the credits migrations (0020, 0034, 0094: reserve_credits, credit_prices): apply them first';
  end if;
  if to_regprocedure('public.render_jobs_payment_guard()') is null or to_regprocedure('public.render_jobs_terms_frozen()') is null
     or to_regclass('public.scene_regenerations') is null then
    raise exception '0118 needs 0041, 0076 and 0111 (render_jobs_payment_guard): apply them first';
  end if;
  -- create or replace keeps a trigger bound; if the 0041 trigger is gone the payment rule would never run.
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.render_jobs'::regclass and tgname = 'render_jobs_payment_guard' and not tgisinternal) then
    raise exception '0118 found no render_jobs_payment_guard trigger on render_jobs: re-apply 0041/0076 first';
  end if;
end $$;

-- The two functions this file replaces are replaced on the bodies the REPO says are latest (0029's render_job_params_valid, 0111's
-- render_jobs_payment_guard). If the live database holds another body (something applied by hand after those migrations: the 0064/0103 drift
-- lesson), replacing it would silently undo that change, so the file refuses. Compared as md5 of the body (prosrc) with every run of white
-- space read as one space, so line endings and indentation cannot cause a false alarm; the second hash of each pair is this file's own body,
-- which is what a replay sees. tests/test_series_tables_migration.py recomputes all four from the migration files.
do $$
declare
  v text;
  g text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into v
    from pg_proc p where p.oid = 'public.render_job_params_valid(jsonb, text)'::regprocedure;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into g
    from pg_proc p where p.oid = 'public.render_jobs_payment_guard()'::regprocedure;
  if v is null or v <> all (array['23acd245bca17f93913ee051de012b6d', '0518e8198f65f86e62b762dd065ac378']) then
    raise exception '0118 found a render_job_params_valid() that is neither 0029''s body nor 0118''s (md5 %): read the live body first', v;
  end if;
  if g is null or g <> all (array['bcf669209b258a92379d2f0d7a2b3d07', '4aba81ca04a52a6b03733bf925e4ed1c']) then
    raise exception '0118 found a render_jobs_payment_guard() that is neither 0111''s body nor 0118''s (md5 %): read the live body first', g;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.series_plans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete restrict,
  channel_id      text not null,
  series_id       text,
  topic           text not null,
  niche           text not null,
  language        text not null,
  n_episodes      smallint not null,
  duration_s      integer not null,
  status          text not null default 'requested',
  title           text,
  report          jsonb,
  quote           jsonb,
  error_code      text,
  error           text,
  render_job_id   bigint,
  idempotency_key text not null,
  request_hash    text not null,
  result_hash     text,
  requested_by    uuid,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

comment on table public.series_plans is
  'One "plan a series" press (migration 0118): what was asked, who asked, and what the planning run produced. Written only by request_series_plan / finish_series_plan. `report` and `quote` are the PLANNER''S words and preview: model text that nobody fact-checked, and a price estimate that start_series_episode never reads.';
comment on column public.series_plans.niche is
  'Taken from the series or the channel by request_series_plan, never typed into the request.';
comment on column public.series_plans.quote is
  'The planner''s price preview (quoteSeries). Display only: the price of an episode is computed by series_episode_price() when it is quoted or started.';

alter table public.series_plans drop constraint if exists series_plans_ids_check;
alter table public.series_plans add constraint series_plans_ids_check
  check (channel_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
         and (series_id is null or series_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'));
alter table public.series_plans drop constraint if exists series_plans_text_check;
alter table public.series_plans add constraint series_plans_text_check
  check (char_length(topic) between 1 and 300 and topic = btrim(topic) and topic !~ '[[:cntrl:]]'
         and char_length(niche) between 1 and 120 and niche = btrim(niche) and niche !~ '[[:cntrl:]]'
         and language ~ '^[A-Za-z][A-Za-z -]{0,39}$');
alter table public.series_plans drop constraint if exists series_plans_shape_check;
alter table public.series_plans add constraint series_plans_shape_check
  check (n_episodes in (3, 4) and duration_s between 30 and 3600);
alter table public.series_plans drop constraint if exists series_plans_status_check;
alter table public.series_plans add constraint series_plans_status_check
  check (status in ('requested', 'ready', 'failed')
         and ((status = 'requested') = (finished_at is null))
         and ((status = 'ready') = (title is not null and report is not null and result_hash is not null))
         and ((status = 'failed') = (error_code is not null))
         and (status = 'ready' or (title is null and report is null and quote is null)));
alter table public.series_plans drop constraint if exists series_plans_payload_check;
alter table public.series_plans add constraint series_plans_payload_check
  check ((title is null or (char_length(title) between 1 and 200 and title = btrim(title) and title !~ '[[:cntrl:]]'))
         and (report is null or (jsonb_typeof(report) = 'object' and octet_length(report::text) <= 16384))
         and (quote is null or (jsonb_typeof(quote) = 'object' and octet_length(quote::text) <= 16384))
         and (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,47}$')
         and (error is null or (char_length(error) <= 500 and error !~ '[[:cntrl:]]'))
         and (result_hash is null or result_hash ~ '^[0-9a-f]{32}$'));
alter table public.series_plans drop constraint if exists series_plans_keys_check;
alter table public.series_plans add constraint series_plans_keys_check
  check (idempotency_key ~ '^[A-Za-z0-9_:.-]{8,128}$' and request_hash ~ '^[0-9a-f]{32}$');

-- One key, one press: a replay finds the first row instead of a second job.
create unique index if not exists series_plans_idem_key on public.series_plans (org_id, idempotency_key);
-- The pair a child row references, so an episode can never name another organization's plan.
create unique index if not exists series_plans_id_org_key on public.series_plans (id, org_id);
create unique index if not exists series_plans_render_job_key on public.series_plans (render_job_id) where render_job_id is not null;
-- One plan in flight per channel: planning is one model call and a channel's queue slot is shared with its video runs.
create unique index if not exists series_plans_one_requested_per_channel on public.series_plans (channel_id) where status = 'requested';
-- The daily cap counts these, newest first.
create index if not exists series_plans_org_idx on public.series_plans (org_id, created_at desc);

create table if not exists public.series_episodes (
  id                 uuid primary key default gen_random_uuid(),
  plan_id            uuid not null,
  org_id             uuid not null,
  n                  smallint not null,
  topic              text not null,
  outline            jsonb not null,
  usable             boolean not null,
  needs_confirmation boolean not null default false,
  duration_s         integer not null,
  status             text not null default 'planned',
  idempotency_key    text,
  request_hash       text,
  credit_ref         text,
  credits_held       numeric(14,2),
  render_job_id      bigint,
  started_by         uuid,
  started_at         timestamptz,
  created_at         timestamptz not null default now(),
  constraint series_episodes_plan_fk
    foreign key (plan_id, org_id) references public.series_plans (id, org_id) on delete restrict
);

comment on table public.series_episodes is
  'The 3 or 4 episodes of a ready series plan (migration 0118). `outline` is model text, not fact-checked. Written only by finish_series_plan (creates them) and start_series_episode (starts one: its hold and its queued run).';

alter table public.series_episodes drop constraint if exists series_episodes_shape_check;
alter table public.series_episodes add constraint series_episodes_shape_check
  check (n between 1 and 4
         and char_length(topic) between 1 and 300 and topic = btrim(topic) and topic !~ '[[:cntrl:]]'
         and jsonb_typeof(outline) = 'object' and octet_length(outline::text) <= 8192
         and duration_s between 30 and 3600
         and (usable or not needs_confirmation));
alter table public.series_episodes drop constraint if exists series_episodes_status_check;
alter table public.series_episodes add constraint series_episodes_status_check
  check (status in ('planned', 'started')
         and ((status = 'started') = (started_at is not null))
         and ((status = 'started') = (render_job_id is not null))
         and ((status = 'started') = (started_by is not null))
         and ((status = 'started') = (idempotency_key is not null))
         and ((status = 'started') = (request_hash is not null))
         and (status = 'started' or (credit_ref is null and credits_held is null))
         and ((credit_ref is null) = (credits_held is null))
         and (credit_ref is null or credit_ref ~ '^rj-se-[0-9a-f]{32}$')
         and (credits_held is null or credits_held > 0)
         and (idempotency_key is null or idempotency_key ~ '^se:[0-9a-f-]{36}$')
         and (request_hash is null or request_hash ~ '^[0-9a-f]{32}$'));

create unique index if not exists series_episodes_plan_n_key on public.series_episodes (plan_id, n);
create unique index if not exists series_episodes_render_job_key on public.series_episodes (render_job_id) where render_job_id is not null;
create unique index if not exists series_episodes_credit_ref_key on public.series_episodes (credit_ref) where credit_ref is not null;
create unique index if not exists series_episodes_idem_key on public.series_episodes (org_id, idempotency_key) where idempotency_key is not null;
create index if not exists series_episodes_org_idx on public.series_episodes (org_id, created_at desc);

-- A plan's terms are what was asked. Only how it ends moves: requested -> ready | failed, once, and an ended plan is final.
create or replace function public.series_plans_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.channel_id is distinct from old.channel_id
     or new.series_id is distinct from old.series_id
     or new.topic is distinct from old.topic
     or new.niche is distinct from old.niche
     or new.language is distinct from old.language
     or new.n_episodes is distinct from old.n_episodes
     or new.duration_s is distinct from old.duration_s
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_hash is distinct from old.request_hash
     or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at
     or (old.render_job_id is not null and new.render_job_id is distinct from old.render_job_id)
     or old.status <> 'requested' then
    raise exception 'a series plan''s terms are fixed when it is requested, and an ended plan is final'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists series_plans_terms_frozen on public.series_plans;
create trigger series_plans_terms_frozen
  before update on public.series_plans
  for each row execute function public.series_plans_terms_frozen();

-- An episode is created planned and starts once; what it was started with never changes.
create or replace function public.series_episodes_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.plan_id is distinct from old.plan_id
     or new.org_id is distinct from old.org_id
     or new.n is distinct from old.n
     or new.topic is distinct from old.topic
     or new.outline is distinct from old.outline
     or new.usable is distinct from old.usable
     or new.needs_confirmation is distinct from old.needs_confirmation
     or new.duration_s is distinct from old.duration_s
     or new.created_at is distinct from old.created_at
     or old.status <> 'planned' then
    raise exception 'a series episode is started once, and what it was started with is final'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists series_episodes_terms_frozen on public.series_episodes;
create trigger series_episodes_terms_frozen
  before update on public.series_episodes
  for each row execute function public.series_episodes_terms_frozen();

-- A plan row is also the count behind the daily cap, and an episode row is the record of a paid start: neither is ever deleted.
create or replace function public.series_rows_no_delete() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'a series plan or episode is a record of a press and is never deleted'
    using errcode = '42501';
end
$$;

drop trigger if exists series_plans_no_delete on public.series_plans;
create trigger series_plans_no_delete
  before delete on public.series_plans
  for each row execute function public.series_rows_no_delete();
drop trigger if exists series_episodes_no_delete on public.series_episodes;
create trigger series_episodes_no_delete
  before delete on public.series_episodes
  for each row execute function public.series_rows_no_delete();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. RLS: a member reads; nobody writes through the API
-- ───────────────────────────────────────────────────────────────────────────

alter table public.series_plans enable row level security;
alter table public.series_episodes enable row level security;

-- Rows change only through the functions below: no direct write for anyone, the service key included (it bypasses RLS, not privileges).
revoke all on public.series_plans, public.series_episodes from public, anon, authenticated, service_role;
grant select on public.series_plans, public.series_episodes to authenticated, service_role;

drop policy if exists series_plans_select on public.series_plans;
create policy series_plans_select on public.series_plans
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists series_episodes_select on public.series_episodes;
create policy series_episodes_select on public.series_episodes
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The queue: the kind, the link, the parameter rule
-- ───────────────────────────────────────────────────────────────────────────

alter table public.render_jobs drop constraint if exists render_jobs_kind_check;
alter table public.render_jobs add constraint render_jobs_kind_check
  check (kind in ('daily', 'repair', 'series_plan'));

-- The planning job of one series plan. Written only by request_series_plan; the browser insert policy (kind = 'daily') cannot carry it, and
-- the check below keeps the two together: a series_plan job has its plan, and no other job has one.
alter table public.render_jobs
  add column if not exists series_plan_id uuid references public.series_plans (id) on delete restrict;
create unique index if not exists render_jobs_series_plan_key
  on public.render_jobs (series_plan_id) where series_plan_id is not null;
alter table public.render_jobs drop constraint if exists render_jobs_series_plan_check;
alter table public.render_jobs add constraint render_jobs_series_plan_check
  check ((kind = 'series_plan') = (series_plan_id is not null));

-- render_job_params_valid: 0029's body (the latest definition) verbatim, plus the three blocks marked 0118. Still IMMUTABLE: it sits in the
-- render_jobs_params_check CHECK and in the api_* functions, so it cannot read a table; it checks only the SHAPE of `series` (a slug). That the
-- series exists, belongs to the channel and is active is checked by start_series_episode() and by main.py (require_runnable_series).
create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','tts_model','voice_id','resume','repair_scenes',
                          'publish_hint','series'];
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
      or p ->> 'image_provider' not in ('pexels','leonardo','gpt-image','nano-banana',
                                         'flux','ideogram','fal')) then
    return false;
  end if;
  if p ? 'tts_model' and (jsonb_typeof(p -> 'tts_model') <> 'string'
      or p ->> 'tts_model' not in ('eleven_v3','eleven_multilingual_v2',
                                   'eleven_flash_v2_5','eleven_turbo_v2_5')) then
    return false;
  end if;
  if p ? 'voice_id' and (jsonb_typeof(p -> 'voice_id') <> 'string'
      or p ->> 'voice_id' !~ '^[A-Za-z0-9]{20}$') then
    return false;
  end if;
  -- 0029: which account the video is for — a hint, never an instruction.
  if p ? 'publish_hint' and (jsonb_typeof(p -> 'publish_hint') <> 'string'
      or p ->> 'publish_hint' !~ '^(youtube|instagram|tiktok):[A-Za-z0-9._-]{1,128}$') then
    return false;
  end if;
  -- 0118: which series an episode's run belongs to. A slug (the shape modules/series.py accepts), so it can name nothing else: no path, no
  -- flag, no line break. Never on a repair, which re-renders scenes of a run that is already made.
  if p ? 'series' and (jsonb_typeof(p -> 'series') <> 'string'
                       or p ->> 'series' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
                       or p_kind = 'repair') then
    return false;
  end if;
  if p ? 'resume' and jsonb_typeof(p -> 'resume') <> 'boolean' then
    return false;
  end if;

  has_repair := length(btrim(coalesce(p ->> 'repair_scenes', ''))) > 0;
  -- 0118: a series-planning job is ONE model call about a topic. It carries the topic, the niche, the language and the series it is for, and
  -- nothing a run takes (no length, provider, voice, resume or repair).
  if p_kind = 'series_plan' then
    return not has_repair
       and (p - array['topic','niche','language','series']) = '{}'::jsonb
       and length(btrim(coalesce(p ->> 'topic', ''))) > 0
       and length(btrim(coalesce(p ->> 'niche', ''))) > 0;
  end if;
  if p_kind = 'repair' then
    return has_repair and coalesce((p ->> 'resume')::boolean, false) = false;
  end if;
  return not has_repair;
end
$$;

-- render_jobs_payment_guard: 0111's body (the latest definition) verbatim, plus the block marked 0118. The trigger itself (before insert,
-- 0041/0076) is not recreated: create or replace keeps it bound.
create or replace function public.render_jobs_payment_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org   uuid;
  v_cfg   jsonb;
  v_secs  numeric;
  r       public.credit_reservations;
  h       public.api_holds;
  jm      numeric;
  vm      public.credit_prices;
  v_need  numeric;
  sr      public.scene_regenerations;
  sp      public.series_plans;
begin
  -- 0118: a job linked to a series plan is the one job its request queued -- a planning job (one model call, paid by nobody: planning is free
  -- to the customer and capped per organization per day) -- for every organization, the operator's included. Placed before the channel
  -- check below on purpose: an EDITOR requests a plan (request_series_plan checks that), and the browser's own insert policy admits only
  -- kind 'daily', so a signed-in browser cannot insert this row itself whatever it puts in the column.
  if new.series_plan_id is not null then
    select * into sp from public.series_plans where id = new.series_plan_id;
    if sp.id is null or new.kind <> 'series_plan' or sp.channel_id <> new.channel_id
       or sp.status <> 'requested' or sp.render_job_id is not null
       or new.credit_ref is not null or new.api_hold_ref is not null or new.scene_regeneration_id is not null
       or new.params ->> 'topic' is distinct from sp.topic
       or new.params ->> 'niche' is distinct from sp.niche
       or new.params ->> 'language' is distinct from sp.language
       or new.params ->> 'series' is distinct from sp.series_id
       or (new.params - array['topic','niche','language','series']) <> '{}'::jsonb then
      raise exception 'render job refused: it is not the job its series plan queued'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- A signed-in browser that may not start runs on this channel gets the
  -- insert policy's refusal here, before anything below can tell it whether
  -- a channel or a hold exists. (The API functions run with the key's anon
  -- role and do their own channel check; the service key is trusted.)
  if coalesce(auth.role(), '') = 'authenticated'
     and not (new.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'new row violates row-level security policy for table "render_jobs"'
      using errcode = '42501';
  end if;

  select c.org_id, c.agent_config into v_org, v_cfg
    from public.channels c where c.channel_id = new.channel_id;
  if v_org is null then
    raise exception 'render job refused: channel % belongs to no organization', new.channel_id
      using errcode = '42501';
  end if;
  -- 0076: a job linked to a scene regeneration is the one job its request
  -- queued — a repair of that scene, with that regeneration's own hold —
  -- for every organization, the operator's included.
  if new.scene_regeneration_id is not null then
    select * into sr from public.scene_regenerations where id = new.scene_regeneration_id;
    if sr.id is null or new.kind <> 'repair' or sr.channel_id <> new.channel_id
       or sr.status <> 'queued' or sr.render_job_id is not null
       or sr.credit_ref is distinct from new.credit_ref or new.api_hold_ref is not null
       or new.params ->> 'repair_scenes' is distinct from sr.scene_id
       or new.params ->> 'topic' is distinct from sr.slug
       or coalesce((new.params ->> 'resume')::boolean, false) then
      raise exception 'render job refused: it is not the job its scene regeneration queued'
        using errcode = '42501';
    end if;
  end if;
  -- The operator's own organization never pays (0020) and its runs keep the
  -- channel's own target length, exactly as before this migration.
  if public.credits_exempt(v_org) then
    return new;
  end if;

  -- 0111 (audit D8): the platform chooses the providers of a customer's run. A run is priced flat
  -- (credit_prices / api_prices), so a customer who named Veo or Kling would spend a funded vendor
  -- key at a price that does not cover it. The routes already refuse both fields (browser, API,
  -- MCP); this is the same rule in the one place no route can be bypassed. A blank or null value is
  -- not a choice and passes here; render_job_params_valid still refuses it as a provider id.
  -- Insert only: a queued job's params are frozen afterwards by render_jobs_terms_frozen.
  if coalesce(nullif(btrim(new.params ->> 'video_provider'), ''),
              nullif(btrim(new.params ->> 'image_provider'), '')) is not null then
    raise exception 'render job refused: video_provider and image_provider cannot be set for this organization'
      using errcode = '42501',
            hint = 'Leave them out: the platform chooses the providers of a paid run.';
  end if;

  -- C2: a customer run is paid for — whatever NIGHTSHIFT_CREDITS_ENFORCE says.
  if new.credit_ref is null and new.api_hold_ref is null then
    raise exception 'render job refused: a run for this organization must carry its credit hold'
      using errcode = '42501',
            hint = 'Start it from the Command Center with credits enforced (NIGHTSHIFT_CREDITS_ENFORCE).';
  end if;
  if new.credit_ref is not null and new.api_hold_ref is not null then
    raise exception 'render job refused: a run is paid by one hold, not two' using errcode = '42501';
  end if;

  -- 0076: a scene regeneration is priced per scene, not per minute of video.
  -- Its hold is its own (the reference the request placed): open, never
  -- started, this organization's, and at least the quote. The whole-video
  -- length floor below does not apply to one scene, and no length is frozen.
  if new.scene_regeneration_id is not null then
    select * into r from public.credit_reservations where job_id = new.credit_ref;
    if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
       or r.started_at is not null or sr.quoted_credits is null or r.amount < sr.quoted_credits then
      raise exception 'render job refused: its credit hold is not this scene regeneration''s open hold'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- C1: freeze the length the hold is for. A job that names its length keeps
  -- it (render_jobs_params_check holds it to whole seconds, 30..3600); one
  -- that does not gets the channel's target as it is NOW, capped the same way.
  new.params := coalesce(new.params, '{}'::jsonb);
  if new.params ? 'duration' then
    if jsonb_typeof(new.params -> 'duration') <> 'number' then
      raise exception 'render job refused: duration must be a whole number of seconds'
        using errcode = '22023';
    end if;
    v_secs := (new.params ->> 'duration')::numeric;
  else
    if jsonb_typeof(v_cfg -> 'target_duration_seconds') = 'number' then
      v_secs := (v_cfg ->> 'target_duration_seconds')::numeric;
    end if;
    if v_secs is null or v_secs <= 0 then
      raise exception 'render job refused: a paid run needs a length'
        using errcode = '22023',
              hint = 'Choose a length, or set the channel''s target length.';
    end if;
    v_secs := least(greatest(round(v_secs), 30), 3600);
    new.params := new.params || jsonb_build_object('duration', v_secs::integer);
  end if;

  if new.api_hold_ref is not null then
    -- (a) is the policy's; here: the hold is this organization's, open, and
    -- not already paying for another job or a download. 0031's
    -- api_create_video priced it for this length in this same transaction.
    select * into h from public.api_holds where ref = new.api_hold_ref;
    if h.ref is null or h.org_id is distinct from v_org or h.status <> 'open'
       or h.started_at is not null or h.render_job_id is not null
       or h.download_request_id is not null then
      raise exception 'render job refused: its API balance hold is not an open, unused hold of this organization'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- (b) the credit hold: this organization's, a queue reference, open, never
  -- started (a started hold is paying for a run already), not expired.
  if new.credit_ref !~ '^rj-' then
    raise exception 'render job refused: a queued run is paid by a queue credit hold (rj-…)'
      using errcode = '42501';
  end if;
  select * into r from public.credit_reservations where job_id = new.credit_ref;
  if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
     or r.started_at is not null or r.created_at < now() - interval '3 hours' then
    raise exception 'render job refused: its credit hold is not an open, unused hold of this organization'
      using errcode = '42501';
  end if;

  -- The hold covers the frozen length: modules/credits.minimum_reservation.
  -- job_minimum is a flat floor (margin ignored, as in reserve_credits);
  -- video_minute is credits per minute with its margin. Unset = no floor.
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  select * into vm from public.credit_prices where unit = 'video_minute';
  v_need := greatest(coalesce(jm, 0),
                     coalesce(vm.credits_per_unit * (1 + vm.margin) * v_secs / 60, 0));
  v_need := public.credits_round_up(v_need);
  if v_need > 0 and r.amount < v_need then
    raise exception 'render job refused: its credit hold does not cover a run of % seconds', v_secs::integer
      using errcode = '22023',
            hint = 'Reserve for the length you run, or choose a shorter one.';
  end if;
  return new;
end
$$;

revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Internal helpers (definer; no API role may execute them)
-- ───────────────────────────────────────────────────────────────────────────

-- Plans per organization per rolling 24 hours. A PLACEHOLDER for owner decision 3 ("is planning free, and what are the cap numbers?"): the
-- only place the number lives, so changing it is one create or replace.
create or replace function public.series_plan_daily_limit() returns integer
  language sql immutable set search_path = public, pg_temp as $$
  select 5
$$;

-- What one episode of this length costs, in credits, or NULL when it cannot be priced. The formula render_jobs_payment_guard enforces for a
-- queued run of that length (modules/credits.minimum_reservation): job_minimum is a flat floor, video_minute is credits per minute with its
-- margin; rounded UP to the cent. No video_minute rate (or a zero one) is "unpriced" -- never 0. A definer: credit_prices is the operator's
-- (0084), a member reads only the rates as charged.
create or replace function public.series_episode_price(p_duration_s integer) returns numeric
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  jm     numeric;
  vm     public.credit_prices;
  amount numeric;
begin
  if p_duration_s is null or p_duration_s not between 30 and 3600 then
    return null;
  end if;
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  select * into vm from public.credit_prices where unit = 'video_minute';
  if vm.unit is null or vm.credits_per_unit is null or vm.credits_per_unit <= 0 or vm.margin is null then
    return null;
  end if;
  amount := public.credits_round_up(greatest(coalesce(jm, 0), vm.credits_per_unit * (1 + vm.margin) * p_duration_s / 60));
  if amount is null or amount <= 0 then
    return null;
  end if;
  -- credits_round_up already lands on a whole cent: round() only fixes the scale shown to the caller (15.00, not 15.0000000000000000).
  return round(amount, 2);
end
$$;

-- Why this episode cannot start now, as a fixed word, or NULL when it can. One place, so the quote and the start cannot disagree.
create or replace function public.series_episode_blocker(p_episode uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  ep public.series_episodes;
  pl public.series_plans;
begin
  select * into ep from public.series_episodes where id = p_episode;
  if ep.id is null then
    return 'not_found';
  end if;
  select * into pl from public.series_plans where id = ep.plan_id;
  if pl.id is null or pl.status <> 'ready' then
    return 'plan_not_ready';
  end if;
  if ep.status <> 'planned' then
    return 'already_started';
  end if;
  if not ep.usable then
    return 'episode_not_usable';
  end if;
  -- In order, one at a time: every earlier episode was started and its run succeeded.
  if exists (select 1
               from public.series_episodes e
               left join public.render_jobs j on j.id = e.render_job_id
              where e.plan_id = ep.plan_id and e.n < ep.n
                and (e.status <> 'started' or j.status is distinct from 'succeeded')) then
    return 'earlier_episode_not_finished';
  end if;
  return null;
end
$$;

-- The shape both start answers and a replay use.
create or replace function public.series_episode_json(p_episode uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
           'id', e.id, 'plan_id', e.plan_id, 'n', e.n, 'status', e.status,
           'render_job_id', e.render_job_id, 'credit_ref', e.credit_ref, 'credits_held', e.credits_held,
           'started_at', e.started_at)
    from public.series_episodes e where e.id = p_episode
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. request_series_plan: one press, one plan row, one queue row (dormant until S3)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.request_series_plan(
  p_channel text, p_topic text, p_n integer, p_language text, p_duration_s integer, p_series text, p_idem text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid      uuid := auth.uid();
  ch       public.channels;
  se       public.content_series;
  v_org    uuid;
  v_topic  text := btrim(coalesce(p_topic, ''));
  v_lang   text := coalesce(nullif(btrim(coalesce(p_language, '')), ''), 'English');
  v_series text := nullif(btrim(coalesce(p_series, '')), '');
  v_niche  text;
  v_hash   text;
  prior    public.series_plans;
  v_id     uuid := gen_random_uuid();
  v_job    bigint;
  v_limit  integer := public.series_plan_daily_limit();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ch from public.channels where channel_id = p_channel;
  -- A channel that does not exist and a channel of another organization are the same answer.
  if ch.channel_id is null or ch.org_id is null or not public.is_org_member(ch.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_org := ch.org_id;
  if not public.is_org_member(v_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if char_length(v_topic) not between 1 and 300 or v_topic ~ '[[:cntrl:]]' then
    raise exception 'invalid_topic' using errcode = '22023';
  end if;
  if p_n is null or p_n not in (3, 4) then
    raise exception 'invalid_episode_count' using errcode = '22023';
  end if;
  if p_duration_s is null or p_duration_s not between 30 and 3600 then
    raise exception 'invalid_duration' using errcode = '22023';
  end if;
  if v_lang !~ '^[A-Za-z][A-Za-z -]{0,39}$' then
    raise exception 'invalid_language' using errcode = '22023';
  end if;

  -- The series, when one is named, is this channel's own (a series id is global; another channel's is not found, not "forbidden").
  if v_series is not null then
    select * into se from public.content_series where series_id = v_series and channel_id = ch.channel_id;
    if se.series_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  -- The niche is the series' or the channel's, from the database; the browser does not choose it. A plan with no niche has no
  -- off-niche screening at all (modules/series_planner: no_niche), so it is refused before anything is queued (rule 6).
  v_niche := left(btrim(regexp_replace(coalesce(nullif(btrim(coalesce(se.niche, '')), ''), ch.niche, ''), '[[:cntrl:]]', ' ', 'g')), 120);
  v_niche := btrim(v_niche);
  if v_niche = '' then
    raise exception 'no_niche' using errcode = '22023';
  end if;

  -- Presses of one organization take turns: a double click, a second tab or a second editor waits here, then sees the first one's row, and two
  -- concurrent requests cannot both pass the cap.
  perform pg_advisory_xact_lock(hashtextextended('series_plan:' || v_org::text, 0));

  v_hash := md5(jsonb_build_object('channel', ch.channel_id, 'topic', v_topic, 'n', p_n, 'language', v_lang,
                                   'duration', p_duration_s, 'series', v_series)::text);
  select * into prior from public.series_plans where org_id = v_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    -- The same press again (a retry, a replay): its plan and job, nothing queued twice.
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'render_job_id', prior.render_job_id, 'replayed', true);
  end if;

  -- A plan that was never finished frees its channel after two hours, and its queue row with it (only if no worker has it).
  with expired as (
    update public.series_plans
       set status = 'failed', error_code = 'expired', error = 'planning did not finish in time', finished_at = now()
     where channel_id = ch.channel_id and status = 'requested' and created_at < now() - interval '2 hours'
    returning id)
  update public.render_jobs j
     set status = 'cancelled', finished_at = now(), error = 'the series plan expired before a worker took it'
   where j.series_plan_id in (select id from expired) and j.status = 'queued';

  if exists (select 1 from public.series_plans where channel_id = ch.channel_id and status = 'requested') then
    raise exception 'plan_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.series_plans
       where org_id = v_org and created_at > now() - interval '24 hours') >= v_limit then
    raise exception 'rate_limited' using errcode = 'NS429', detail = format('limit=%s per 24 hours', v_limit);
  end if;

  insert into public.series_plans (id, org_id, channel_id, series_id, topic, niche, language, n_episodes, duration_s,
                                   idempotency_key, request_hash, requested_by)
  values (v_id, v_org, ch.channel_id, v_series, v_topic, v_niche, v_lang, p_n, p_duration_s, p_idem, v_hash, uid);

  -- The planning job: one model call, no length, no provider, no voice, no hold. render_jobs_payment_guard checks it is exactly the job this
  -- plan queued.
  insert into public.render_jobs (channel_id, kind, params, requested_by, series_plan_id)
  values (ch.channel_id, 'series_plan',
          jsonb_strip_nulls(jsonb_build_object('topic', v_topic, 'niche', v_niche, 'language', v_lang, 'series', v_series)),
          uid, v_id)
  returning id into v_job;
  update public.series_plans set render_job_id = v_job where id = v_id;

  return jsonb_build_object('id', v_id, 'status', 'requested', 'render_job_id', v_job, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. finish_series_plan: the worker's answer (service role only)
-- ───────────────────────────────────────────────────────────────────────────

-- p_ok true: p_title, p_report, p_quote and p_episodes (exactly n_episodes objects with exactly the keys topic, outline, usable,
-- needs_confirmation) are stored and the episodes are created. p_ok false: only p_error_code and p_error are kept. The same answer twice is a
-- replay; a different answer to an ended plan is refused.
create or replace function public.finish_series_plan(
  p_plan uuid, p_ok boolean, p_title text, p_report jsonb, p_quote jsonb, p_episodes jsonb,
  p_error_code text default null, p_error text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  pl      public.series_plans;
  v_title text := btrim(coalesce(p_title, ''));
  v_hash  text;
  e       record;
  k       text;
begin
  -- Belt and braces: the grant is service_role only, and a signed-in browser carries claims that are not the service role's.
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into pl from public.series_plans where id = p_plan for update;
  if pl.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_ok is null then
    raise exception 'invalid_result' using errcode = '22023';
  end if;

  if p_ok then
    if char_length(v_title) not between 1 and 200 or v_title ~ '[[:cntrl:]]' then
      raise exception 'invalid_title' using errcode = '22023';
    end if;
    if p_report is null or jsonb_typeof(p_report) <> 'object' or octet_length(p_report::text) > 16384 then
      raise exception 'invalid_report' using errcode = '22023';
    end if;
    if p_quote is not null and (jsonb_typeof(p_quote) <> 'object' or octet_length(p_quote::text) > 16384) then
      raise exception 'invalid_quote' using errcode = '22023';
    end if;
    if p_episodes is null or jsonb_typeof(p_episodes) <> 'array' or jsonb_array_length(p_episodes) <> pl.n_episodes
       or octet_length(p_episodes::text) > 65536 then
      raise exception 'invalid_episodes' using errcode = '22023';
    end if;
    for e in select v, ord from jsonb_array_elements(p_episodes) with ordinality as t(v, ord) loop
      if jsonb_typeof(e.v) <> 'object' then
        raise exception 'invalid_episodes' using errcode = '22023';
      end if;
      for k in select jsonb_object_keys(e.v) loop
        if k not in ('topic', 'outline', 'usable', 'needs_confirmation') then
          raise exception 'invalid_episodes' using errcode = '22023';
        end if;
      end loop;
      if jsonb_typeof(e.v -> 'topic') is distinct from 'string'
         or char_length(btrim(e.v ->> 'topic')) not between 1 and 300 or (e.v ->> 'topic') ~ '[[:cntrl:]]'
         or jsonb_typeof(e.v -> 'outline') is distinct from 'object' or octet_length((e.v -> 'outline')::text) > 8192
         or jsonb_typeof(e.v -> 'usable') is distinct from 'boolean'
         or jsonb_typeof(e.v -> 'needs_confirmation') is distinct from 'boolean' then
        raise exception 'invalid_episodes' using errcode = '22023';
      end if;
      -- Checked only once both are known to be booleans: an episode that needs confirming is one that may be started.
      if (e.v ->> 'needs_confirmation')::boolean and not (e.v ->> 'usable')::boolean then
        raise exception 'invalid_episodes' using errcode = '22023';
      end if;
    end loop;
    v_hash := md5(jsonb_build_object('ok', true, 'title', v_title, 'report', p_report, 'quote', p_quote, 'episodes', p_episodes)::text);
  else
    if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,47}$' then
      raise exception 'invalid_error_code' using errcode = '22023';
    end if;
    if p_error is not null and (char_length(p_error) > 500 or p_error ~ '[[:cntrl:]]') then
      raise exception 'invalid_error' using errcode = '22023';
    end if;
    v_hash := md5(jsonb_build_object('ok', false, 'code', p_error_code, 'error', p_error)::text);
  end if;

  if pl.status <> 'requested' then
    -- The worker asking twice (a lost answer) gets the first answer; anything else cannot rewrite an ended plan.
    if pl.result_hash is not distinct from v_hash or (pl.status = 'failed' and not p_ok and pl.error_code = p_error_code) then
      return jsonb_build_object('id', pl.id, 'status', pl.status, 'replayed', true);
    end if;
    raise exception 'plan_already_finished' using errcode = 'NS409';
  end if;

  if p_ok then
    insert into public.series_episodes (plan_id, org_id, n, topic, outline, usable, needs_confirmation, duration_s)
    select pl.id, pl.org_id, (t.ord)::smallint, btrim(t.v ->> 'topic'), t.v -> 'outline',
           (t.v ->> 'usable')::boolean, (t.v ->> 'needs_confirmation')::boolean, pl.duration_s
      from jsonb_array_elements(p_episodes) with ordinality as t(v, ord);
    update public.series_plans
       set status = 'ready', title = v_title, report = p_report, quote = p_quote, result_hash = v_hash, finished_at = now()
     where id = pl.id;
  else
    update public.series_plans
       set status = 'failed', error_code = p_error_code, error = p_error, result_hash = v_hash, finished_at = now()
     where id = pl.id;
  end if;
  return jsonb_build_object('id', pl.id, 'status', case when p_ok then 'ready' else 'failed' end, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. quote_series_episode and start_series_episode
-- ───────────────────────────────────────────────────────────────────────────

-- What starting this episode would cost and whether it can start now. Read only; the price is the database's.
create or replace function public.quote_series_episode(p_episode uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  ep      public.series_episodes;
  v_ex    boolean;
  v_price numeric;
  v_block text;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ep from public.series_episodes where id = p_episode;
  if ep.id is null or not public.is_org_member(ep.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_ex := public.credits_exempt(ep.org_id);
  v_block := public.series_episode_blocker(ep.id);
  v_price := case when v_ex then null else public.series_episode_price(ep.duration_s) end;
  return jsonb_build_object(
    'episode_id', ep.id, 'plan_id', ep.plan_id, 'n', ep.n, 'status', ep.status, 'duration_s', ep.duration_s,
    'exempt', v_ex,
    -- Not "0 credits": the operator's own organization holds nothing, and an unpriced episode has no price.
    'price_status', case when v_ex then 'included' when v_price is null then 'unpriced' else 'priced' end,
    'credits', v_price,
    'needs_confirmation', ep.needs_confirmation,
    'blocked_by', v_block,
    'may_start', public.is_org_member(ep.org_id, 'admin') and (not v_ex or public.is_platform_admin()),
    'startable', v_block is null and (v_ex or v_price is not null));
end
$$;

-- Start one episode: take its hold (the database's price, confirmed by the caller) and queue its run. p_idem must be 'se:<episode id>'.
create or replace function public.start_series_episode(
  p_episode uuid, p_max_credits numeric, p_idem text, p_confirmed boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  ep      public.series_episodes;
  pl      public.series_plans;
  v_ex    boolean;
  v_hash  text;
  v_block text;
  v_price numeric;
  v_ref   text;
  v_res   jsonb;
  v_held  numeric;
  v_job   bigint;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ep from public.series_episodes where id = p_episode;
  -- A missing episode and another organization's episode are the same answer.
  if ep.id is null or not public.is_org_member(ep.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The rule reserve_credits applies: an admin of the organization starts a paid run. The operator's own organization is paid by the platform:
  -- only a platform administrator spends there.
  if not public.is_org_member(ep.org_id, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_ex := public.credits_exempt(ep.org_id);
  if v_ex and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idem is distinct from 'se:' || ep.id::text then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_max_credits is not null and (p_max_credits < 0 or p_max_credits > 100000000) then
    raise exception 'invalid_max_credits' using errcode = '22023';
  end if;

  -- The account first: every hold of this organization queues behind it, so a second press waits here and then finds the first one's rows.
  perform public.credit_account_lock(ep.org_id);
  select * into pl from public.series_plans where id = ep.plan_id for update;
  select * into ep from public.series_episodes where id = p_episode for update;

  v_hash := md5(jsonb_build_object('episode', ep.id, 'max', case when v_ex then null else round(p_max_credits, 2)::text end,
                                   'confirmed', coalesce(p_confirmed, false))::text);
  if ep.status = 'started' then
    if ep.request_hash is distinct from v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    return public.series_episode_json(ep.id) || jsonb_build_object('replayed', true);
  end if;

  v_block := public.series_episode_blocker(ep.id);
  if v_block is not null then
    raise exception '%', v_block using errcode = 'NS409';
  end if;
  if ep.needs_confirmation and not coalesce(p_confirmed, false) then
    raise exception 'confirmation_required' using errcode = 'NS400';
  end if;
  -- A series that cannot run stops here, before anything is held (main.py would stop it after the hold was taken).
  if pl.series_id is not null and not exists (
       select 1 from public.content_series s
        where s.series_id = pl.series_id and s.channel_id = pl.channel_id and upper(btrim(s.status)) = 'ACTIVE') then
    raise exception 'series_not_runnable' using errcode = 'NS409';
  end if;

  if not v_ex then
    v_price := public.series_episode_price(ep.duration_s);
    if v_price is null then
      raise exception 'unpriced' using errcode = 'NS400';
    end if;
    if p_max_credits is null then
      raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);
    end if;
    if round(p_max_credits, 2) <> v_price then
      raise exception 'price_changed' using errcode = 'NS409', detail = format('credits=%s', v_price);
    end if;
    v_ref := 'rj-se-' || replace(ep.id::text, '-', '');
    -- The hold is the price. reserve_credits checks the caller is an admin of the organization and the balance (NS402 when short).
    v_res := public.reserve_credits(ep.org_id, v_ref, v_price);
    if coalesce((v_res ->> 'exempt')::boolean, false) then
      v_ref := null;
    else
      v_held := (v_res ->> 'reserved')::numeric;
    end if;
  end if;

  -- The run: an ordinary 'daily' job with an explicit topic, this episode's length and its series. render_jobs_payment_guard checks the hold
  -- covers that length like any queued run.
  insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref)
  values (pl.channel_id, 'daily',
          jsonb_strip_nulls(jsonb_build_object('topic', ep.topic, 'niche', pl.niche, 'language', pl.language,
                                               'duration', ep.duration_s, 'series', pl.series_id)),
          uid, v_ref)
  returning id into v_job;

  update public.series_episodes
     set status = 'started', idempotency_key = p_idem, request_hash = v_hash, credit_ref = v_ref, credits_held = v_held,
         render_job_id = v_job, started_by = uid, started_at = now()
   where id = ep.id;

  return public.series_episode_json(ep.id) || jsonb_build_object('replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Grants: revoke from everyone, then grant narrowly
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.series_plans_terms_frozen() from public, anon, authenticated, service_role;
revoke all on function public.series_episodes_terms_frozen() from public, anon, authenticated, service_role;
revoke all on function public.series_rows_no_delete() from public, anon, authenticated, service_role;
revoke all on function public.series_plan_daily_limit() from public, anon, authenticated, service_role;
revoke all on function public.series_episode_price(integer) from public, anon, authenticated, service_role;
revoke all on function public.series_episode_blocker(uuid) from public, anon, authenticated, service_role;
revoke all on function public.series_episode_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_series_plan(text, text, integer, text, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.finish_series_plan(uuid, boolean, text, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.quote_series_episode(uuid) from public, anon, authenticated, service_role;
revoke all on function public.start_series_episode(uuid, numeric, text, boolean) from public, anon, authenticated, service_role;

-- request_series_plan is deliberately NOT granted (see the header): the grant ships in the migration that ships the worker and the UI.
grant execute on function public.finish_series_plan(uuid, boolean, text, jsonb, jsonb, jsonb, text, text) to service_role;
grant execute on function public.quote_series_episode(uuid) to authenticated;
grant execute on function public.start_series_episode(uuid, numeric, text, boolean) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor on the live project after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select count(*) = 2 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
--        and c.relname in ('series_plans', 'series_episodes')) as rls_on_both,
--     (select count(*) = 0 from information_schema.role_table_grants g
--       where g.table_schema = 'public' and g.table_name in ('series_plans', 'series_episodes')
--         and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') and g.privilege_type <> 'SELECT') as no_api_role_writes,
--     (select count(*) = 0 from information_schema.role_table_grants g
--       where g.table_schema = 'public' and g.table_name in ('series_plans', 'series_episodes')
--         and g.grantee in ('anon', 'PUBLIC')) as anon_has_nothing,
--     not has_function_privilege('anon', 'public.start_series_episode(uuid,numeric,text,boolean)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.start_series_episode(uuid,numeric,text,boolean)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.finish_series_plan(uuid,boolean,text,jsonb,jsonb,jsonb,text,text)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.finish_series_plan(uuid,boolean,text,jsonb,jsonb,jsonb,text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.request_series_plan(text,text,integer,text,integer,text,text)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.request_series_plan(text,text,integer,text,integer,text,text)', 'EXECUTE')
--       as function_grants,
--     (select pg_get_constraintdef(oid) like '%series_plan%' from pg_constraint
--       where conrelid = 'public.render_jobs'::regclass and conname = 'render_jobs_kind_check') as kind_allowed,
--     position('0118' in pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure)) > 0
--       and position('0118' in pg_get_functiondef('public.render_job_params_valid(jsonb,text)'::regprocedure)) > 0 as both_replaced,
--     public.render_job_params_valid('{"topic":"t","series":"my-series"}', 'daily')
--       and not public.render_job_params_valid('{"topic":"t","series":"../x"}', 'daily')
--       and not public.render_job_params_valid('{"topic":"t","series":"my-series"}', 'repair') as series_key_checked;
--
-- Plans that never finished (expected: none older than 2 hours once the worker exists; before S3 nothing can create one):
--   select id, channel_id, created_at from public.series_plans where status = 'requested' and created_at < now() - interval '2 hours';
--
-- Episodes started with a hold that has since been released without the run succeeding (a person's decision, not an error):
--   select e.id, e.credit_ref, r.status, j.status as job_status from public.series_episodes e
--     join public.credit_reservations r on r.job_id = e.credit_ref
--     left join public.render_jobs j on j.id = e.render_job_id where e.status = 'started' and r.status = 'released';
