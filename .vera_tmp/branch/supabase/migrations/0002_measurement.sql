-- Chronos migration 0002 — cost, retention and A/B measurement
-- ============================================================================
-- Apply after 0001. Additive only: no drop, no rename, no type change, no
-- delete. Existing rows are untouched — every column added here is NULLABLE
-- with no default, because "not measured" and "measured as zero" are different
-- facts and this schema must be able to tell them apart.

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
