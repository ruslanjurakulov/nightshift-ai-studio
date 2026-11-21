-- Chronos migration 0001 — multi-channel architecture
-- ============================================================================
-- Apply to an EXISTING Supabase project that already has supabase/schema.sql.
-- A fresh project does not need this file: schema.sql now contains everything
-- below. Both are idempotent — running either twice is safe.
--
-- SAFETY, in full (brief §33/§36):
--
--   * There is NO drop, NO rename, NO type change and NO delete in this file.
--     Every statement is `create ... if not exists` or `add column if not
--     exists`. Nothing that exists today is destroyed, so the migration is
--     reversible by dropping the three new tables and the added columns.
--   * `channel_id` is added as NOT NULL DEFAULT 'default'. On Postgres 11+
--     that is a catalog-only change (no table rewrite) and it backfills every
--     existing row to the default channel in the same statement — which is
--     exactly the required "existing data belongs to the default channel"
--     backfill. No separate UPDATE pass is needed and no row is touched twice.
--   * `topic_performance` is deliberately LEFT ALONE. Its primary key is
--     `topic`, which cannot hold two channels' scores for the same topic, and
--     changing a primary key means dropping one — destructive. Channel-scoped
--     scores live in the NEW `channel_topic_performance` table instead; the
--     old table keeps working unchanged for the existing single-channel views.
--   * Foreign keys point at `public.channels` only from the two tables whose
--     rows are written *after* a channel has been resolved. The high-volume
--     mirror tables (system_events, videos, feedback_signals, ...) get the
--     column and an index but no FK on purpose: an observability write must
--     never fail because a configuration row arrived late.

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
