-- Chronos Command Center — Supabase (Postgres) schema
-- ============================================================================
-- Apply this ONCE to a fresh Supabase project (SQL Editor -> paste -> Run),
-- then set SUPABASE_URL + SUPABASE_SERVICE_KEY as GitHub Actions secrets so the
-- Python bot (modules/supabase_sync.py) mirrors its state here, and set the URL
-- + anon key in the Command Center app so it can read/subscribe. See
-- docs/SUPABASE.md for the full walkthrough.
--
-- These tables mirror modules/state_store.py's SQLite schema 1:1 (plus an
-- event_key on system_events for idempotent re-sync). Column names and the
-- UNIQUE constraints match the on_conflict targets in supabase_sync.py exactly
-- — do not rename without updating that module.
--
-- Security (brief §24): Row Level Security is ON for every table with NO public
-- policy, so the anon key alone can read NOTHING. The bot writes with the
-- service-role key (which bypasses RLS). The Command Center reads only for a
-- logged-in Supabase user via the "authenticated read" policies below — so the
-- monitoring data is never publicly accessible.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.videos (
    video_id     text primary key,
    topic        text,
    title        text,
    slug         text,
    published_at text,
    privacy      text,
    category_id  text,
    local_path   text
);

create table if not exists public.metrics_snapshots (
    video_id                       text not null,
    snapshot_date                  text not null,
    views                          integer,
    likes                          integer,
    comment_count                  integer,
    watch_time_minutes             double precision,
    average_view_duration_seconds  double precision,
    unique (video_id, snapshot_date)
);
create index if not exists idx_metrics_video_date on public.metrics_snapshots (video_id, snapshot_date);

create table if not exists public.competitor_snapshots (
    video_id       text not null,
    channel_id     text not null,
    title          text,
    view_count     integer,
    like_count     integer,
    comment_count  integer,
    published_at   text,
    polled_date    text not null,
    view_velocity  double precision,
    unique (video_id, polled_date)
);
create index if not exists idx_competitor_channel_date on public.competitor_snapshots (channel_id, polled_date);

create table if not exists public.trending_snapshots (
    video_id       text not null,
    title          text,
    view_count     integer,
    like_count     integer,
    comment_count  integer,
    published_at   text,
    region_code    text,
    category_id    text,
    polled_date    text not null,
    unique (video_id, polled_date, region_code)
);
create index if not exists idx_trending_date on public.trending_snapshots (polled_date);

create table if not exists public.demand_signals (
    id                  bigint generated always as identity primary key,
    topic_phrase        text not null,
    mention_count       integer not null,
    example_comment_ids text,
    polled_date         text not null
);
create index if not exists idx_demand_date on public.demand_signals (polled_date);

create table if not exists public.feedback_signals (
    video_id         text not null,
    topic            text,
    signal           text not null,
    metric_value     double precision,
    channel_baseline double precision,
    detail           text,
    analyzed_date    text not null,
    unique (video_id, signal, analyzed_date)
);
create index if not exists idx_feedback_date on public.feedback_signals (analyzed_date);

create table if not exists public.topic_performance (
    topic             text primary key,
    score             double precision not null,
    videos_analyzed   integer not null,
    avg_views_per_day double precision,
    reason            text,
    updated_at        text not null
);

create table if not exists public.system_events (
    event_key    text primary key,
    event        text not null,
    ts           text not null,
    video_id     text,
    job_id       text,
    agent        text,
    status       text,
    duration_ms  double precision,
    metadata     jsonb
);
create index if not exists idx_events_ts on public.system_events (ts desc);
create index if not exists idx_events_video on public.system_events (video_id);

-- ---------------------------------------------------------------------------
-- Operational state mirrored for observability (Phase 4, step 1)
-- ---------------------------------------------------------------------------
-- These two tables mirror state the bot already keeps on disk under history/
-- (restored between workflow runs via actions/cache) so the Command Center can
-- *see* it. They are read-only observability: nothing reads them back into the
-- pipeline, and the publish path is unaffected.

-- ContentPlanner's queue of candidate topics (history/content_calendar.json).
create table if not exists public.content_queue (
    entry_id   text primary key,
    topic      text not null,
    added_at   text not null,
    source     text,
    rationale  text,
    status     text not null default 'queued',
    synced_at  timestamptz not null default now()
);
create index if not exists idx_queue_status on public.content_queue (status);
create index if not exists idx_queue_added on public.content_queue (added_at desc);

-- PipelineStateMachine runs (history/pipeline_runs.json). `human_approved` is
-- the audit-trail flag set by tools/approve_run.py; nothing gates publishing on
-- it, and mirroring it here does not change that.
create table if not exists public.pipeline_runs (
    run_id         text primary key,
    topic          text not null,
    current_stage  text not null,
    human_approved boolean not null default false,
    approved_by    text,
    approved_at    text,
    history        jsonb,
    started_at     text,
    updated_at     text,
    synced_at      timestamptz not null default now()
);
create index if not exists idx_runs_stage on public.pipeline_runs (current_stage);
create index if not exists idx_runs_updated on public.pipeline_runs (updated_at desc);

-- ---------------------------------------------------------------------------
-- Multi-channel architecture (Phase 5)
-- ---------------------------------------------------------------------------
-- Identical to supabase/migrations/0001_multi_channel.sql, inlined so a FRESH
-- project gets everything from this one file. Every statement is idempotent,
-- so re-running schema.sql on a project that already applied the migration is
-- a no-op. See docs/MULTI_CHANNEL.md for what is scoped per channel and why.

-- ---------------------------------------------------------------------------
-- 1. Channels
-- ---------------------------------------------------------------------------
create table if not exists public.channels (
    channel_id      text primary key,
    name            text not null,
    niche           text not null default '',
    -- ACTIVE | PAUSED. A new channel is created PAUSED; a human activates it.
    status          text not null default 'PAUSED',
    agent_config    jsonb not null default '{}'::jsonb,
    schedule_config jsonb not null default '{}'::jsonb,
    -- A *reference* to a credential (provider + env-var ref + public YouTube
    -- channel id) — never a token. See modules/channel_credentials.py.
    credential_ref  jsonb not null default '{}'::jsonb,
    created_at      text,
    updated_at      text
);
create index if not exists idx_channels_status on public.channels (status);

-- The default channel: every pre-multi-channel row backfills to this id, so it
-- must exist before anything references it. Insert-only — if a row is already
-- there (e.g. the bot bootstrapped it, or this file ran before), it is left
-- exactly as-is rather than reset to these values.
insert into public.channels (channel_id, name, niche, status)
values ('default', 'Chronos', 'history mysteries', 'ACTIVE')
on conflict (channel_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Credential health — status ONLY
-- ---------------------------------------------------------------------------
-- SECURITY: this table has no column that can hold a token, and never will.
-- Access tokens and refresh tokens stay server-side (a GitHub Actions secret
-- materialized into a token file for the life of one job). What is stored here
-- is what an operator needs to see — is it connected, which YouTube channel,
-- when does it expire, when was it last verified — and nothing else.
create table if not exists public.channel_credentials (
    channel_id         text not null references public.channels (channel_id) on update cascade,
    provider           text not null default 'youtube',
    -- connected | not_connected | expired | error
    status             text not null default 'not_connected',
    youtube_channel_id text,
    expires_at         text,
    last_verified_at   text,
    detail             text,
    synced_at          timestamptz not null default now(),
    primary key (channel_id, provider)
);

-- ---------------------------------------------------------------------------
-- 3. Channel-scoped topic scores
-- ---------------------------------------------------------------------------
-- Same columns as public.topic_performance, keyed by (channel_id, topic) so a
-- Finance score and a History score for the same topic string cannot collide —
-- the isolation the single-key table structurally cannot provide.
create table if not exists public.channel_topic_performance (
    channel_id        text not null references public.channels (channel_id) on update cascade,
    topic             text not null,
    score             double precision not null,
    videos_analyzed   integer not null,
    avg_views_per_day double precision,
    reason            text,
    updated_at        text not null,
    primary key (channel_id, topic)
);
create index if not exists idx_ctp_channel_score
    on public.channel_topic_performance (channel_id, score desc);

-- ---------------------------------------------------------------------------
-- 4. channel_id on the existing tables (additive + backfilled by the default)
-- ---------------------------------------------------------------------------
-- Scoped per channel: what the channel made, what its audience did, and what
-- it is working on. NOT scoped: trending_snapshots (region-wide YouTube data,
-- genuinely global) and metrics_snapshots (reached through its video's
-- channel_id — duplicating it would give two places to disagree).
alter table public.videos               add column if not exists channel_id text not null default 'default';
alter table public.feedback_signals     add column if not exists channel_id text not null default 'default';
-- NOTE: competitor_snapshots.channel_id already exists and holds the
-- COMPETITOR's YouTube channel id. Ours needs a distinct name.
alter table public.competitor_snapshots add column if not exists chronos_channel_id text not null default 'default';
alter table public.demand_signals       add column if not exists channel_id text not null default 'default';
alter table public.content_queue        add column if not exists channel_id text not null default 'default';
alter table public.pipeline_runs        add column if not exists channel_id text not null default 'default';
-- system_events is a mixed stream: infrastructure events are global, channel
-- work is not. Nullable, and null MEANS global — a default would make every
-- system heartbeat look like the default channel's doing.
alter table public.system_events        add column if not exists channel_id text;

create index if not exists idx_videos_channel        on public.videos (channel_id, published_at desc);
create index if not exists idx_feedback_channel      on public.feedback_signals (channel_id, analyzed_date desc);
create index if not exists idx_competitor_chronos  on public.competitor_snapshots (chronos_channel_id, polled_date desc);
create index if not exists idx_demand_channel        on public.demand_signals (channel_id, polled_date desc);
create index if not exists idx_queue_channel         on public.content_queue (channel_id, added_at desc);
create index if not exists idx_runs_channel          on public.pipeline_runs (channel_id, updated_at desc);
create index if not exists idx_events_channel        on public.system_events (channel_id, ts desc);

-- ---------------------------------------------------------------------------
-- 5. Realtime
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.channels';
    execute 'alter publication supabase_realtime add table public.channel_topic_performance';
  end if;
exception when duplicate_object then
  null;  -- already in the publication; ignore
end $$;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------------
-- Read stays exactly as it is everywhere else: RLS on, logged-in users only,
-- the anon key alone still reads nothing.
do $$
declare t text;
begin
  foreach t in array array['channels','channel_credentials','channel_topic_performance']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_auth_read', t
    );
  end loop;
end $$;

-- Channel MANAGEMENT is the one place the Command Center writes. The grant is
-- deliberately narrow:
--   * `channels` only — no policy is added to any data table, so a logged-in
--     user still cannot insert a video, an event, a metric or a score.
--   * insert + update only — no delete. A channel is retired by setting its
--     status to PAUSED, which keeps its history intact and reversible.
--   * `channels` holds no secret by construction (credential_ref is a
--     reference), so this cannot expose a token.
-- This adds a capability; it does not weaken any existing policy.
drop policy if exists channels_auth_insert on public.channels;
create policy channels_auth_insert on public.channels
    for insert to authenticated with check (true);

drop policy if exists channels_auth_update on public.channels;
create policy channels_auth_update on public.channels
    for update to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Measurement: cost, retention, A/B (Phase 6)
-- ---------------------------------------------------------------------------
-- Identical to supabase/migrations/0002_measurement.sql, inlined so a FRESH
-- project gets everything from this one file. Every statement is idempotent.
-- Note the NULLABLE columns: "not measured" and "measured as zero" are
-- different facts and this schema keeps them apart.

-- ---------------------------------------------------------------------------
-- 1. What each video actually consumed
-- ---------------------------------------------------------------------------
-- `estimated_usd` is NULL unless the operator configured a rate for that unit
-- (CHRONOS_PRICE_*). Quantities are observed facts; unit prices are not, and an
-- invented price quietly becomes "the cost" in someone's spreadsheet. See
-- modules/cost_ledger.py.
create table if not exists public.video_costs (
    id            bigint generated always as identity primary key,
    video_id      text,
    channel_id    text not null default 'default',
    slug          text,
    -- gemini_input_tokens | gemini_output_tokens | tts_characters |
    -- render_seconds | pexels_requests | upload_bytes
    unit          text not null,
    quantity      double precision not null,
    stage         text,
    estimated_usd double precision,
    recorded_at   text not null,
    synced_at     timestamptz not null default now()
);
create index if not exists idx_costs_video on public.video_costs (video_id);
create index if not exists idx_costs_channel_date
    on public.video_costs (channel_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- 2. Audience retention curves
-- ---------------------------------------------------------------------------
-- One row per measured point: `elapsed_ratio` is 0-1 through the video,
-- `watch_ratio` the share of viewers still there. The aggregate
-- averageViewDuration says how long people watched; only this says WHERE they
-- left, which is the part a writer can act on.
create table if not exists public.retention_points (
    video_id      text not null,
    elapsed_ratio double precision not null,
    watch_ratio   double precision,
    measured_date text not null,
    synced_at     timestamptz not null default now(),
    primary key (video_id, elapsed_ratio, measured_date)
);
create index if not exists idx_retention_video
    on public.retention_points (video_id, elapsed_ratio);

-- ---------------------------------------------------------------------------
-- 3. Which A/B arm each video shipped on, and how it performed
-- ---------------------------------------------------------------------------
-- Both thumbnails and both titles have always been generated; until now the A
-- variant shipped every time and B was discarded, so the experiment never ran.
-- These columns are what makes the result readable back.
alter table public.videos add column if not exists thumbnail_variant text;
alter table public.videos add column if not exists title_variant text;

-- Click-through as YouTube reports it. NULLABLE on purpose: a video that has
-- not been polled has UNKNOWN click-through, and defaulting to 0 would make an
-- unmeasured video look like one nobody clicked.
alter table public.metrics_snapshots add column if not exists impressions integer;
alter table public.metrics_snapshots add column if not exists impression_ctr double precision;

create index if not exists idx_videos_variant
    on public.videos (channel_id, thumbnail_variant);

-- ---------------------------------------------------------------------------
-- 4. Row Level Security — unchanged posture
-- ---------------------------------------------------------------------------
-- Same as every other table: RLS on, logged-in read only, no write policy. The
-- anon key alone still reads nothing, and nothing here is writable from the
-- browser.
do $$
declare t text;
begin
  foreach t in array array['video_costs','retention_points']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_auth_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_auth_read', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime — let the Command Center live-subscribe to the activity feed
-- ---------------------------------------------------------------------------
-- Adds the event + score tables to the supabase_realtime publication so the
-- dashboard receives inserts/updates over websockets with no polling.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.system_events';
    execute 'alter publication supabase_realtime add table public.topic_performance';
    execute 'alter publication supabase_realtime add table public.metrics_snapshots';
  end if;
exception when duplicate_object then
  null;  -- already in the publication; ignore
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security — read only for logged-in users; writes via service key
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'videos','metrics_snapshots','competitor_snapshots','trending_snapshots',
    'demand_signals','feedback_signals','topic_performance','system_events',
    'content_queue','pipeline_runs'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    -- Drop-and-recreate so re-running this file is idempotent.
    execute format('drop policy if exists %I on public.%I', t || '_auth_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_auth_read', t
    );
  end loop;
end $$;

-- Note: the service-role key used by the bot bypasses RLS, so no INSERT/UPDATE
-- policies are needed for the sync. The anon key has no policy and therefore no
-- access — the Command Center must authenticate a user to read anything.

-- ---------------------------------------------------------------------------
-- Shorts (migration 0003)
-- ---------------------------------------------------------------------------
-- Apply after 0002. Additive only: two columns, no drop, no rename, no delete.
--
-- A Short is its own YouTube video with its own id, its own metrics and its own
-- retention curve, so it is its own row in `videos`. These two columns are what
-- keep it from being mistaken for a second long video: `video_format` says
-- which it is, and `parent_video_id` says which long video it was cut from.

-- 'long' is not an assumption — every row that exists before this migration
-- runs IS a long video, so the default backfills a fact rather than a guess.
alter table public.videos add column if not exists video_format text not null default 'long';
alter table public.videos add column if not exists parent_video_id text;

create index if not exists idx_videos_format
    on public.videos (channel_id, video_format, published_at desc);
create index if not exists idx_videos_parent
    on public.videos (parent_video_id);
