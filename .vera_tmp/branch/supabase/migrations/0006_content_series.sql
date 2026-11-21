-- Nightshift migration 0006 — content series
-- ============================================================================
-- Adds the "Series" object: a recurring content line WITHIN a channel
-- (niche + format + style + cadence + platforms + automation level). The
-- system was channel-only until now; a Series is finer-grained — one channel
-- can run several (e.g. "Ancient Mysteries" long-form and a daily Shorts line)
-- — so it hangs off a channel by `channel_id` rather than replacing it.
--
-- SAFETY (mirrors 0001's contract):
--   * Additive only. One new table, one index, three policies, one publication
--     add. NO drop, NO rename, NO type change, NO delete. Reversible by
--     dropping the table.
--   * Everything is `create ... if not exists` / `drop policy if exists` +
--     `create policy`, so re-running is safe.
--   * `channel_id` defaults to 'default' and references public.channels, so a
--     series always belongs to a real channel; existing deployments (only the
--     default channel) can create series immediately.
--   * Nothing here publishes, renders, or changes any existing table. The
--     pipeline does not read this table yet — wiring a run to a series is a
--     later, separate change.

create table if not exists public.content_series (
    series_id        text primary key,
    channel_id       text not null default 'default' references public.channels (channel_id),
    name             text not null,
    description      text not null default '',
    niche            text not null default '',
    language         text not null default 'English',
    -- Free-text shape of the output, e.g. "8–12 min long video + 5 Shorts".
    format           text not null default '',
    -- long | short | mixed — the dominant deliverable, for filtering.
    content_type     text not null default 'mixed',
    visual_style     text not null default '',
    voice_style      text not null default '',
    -- Structured cadence, e.g. {"long_per_week": 2, "shorts_per_day": 1}.
    cadence          jsonb not null default '{}'::jsonb,
    -- Target platforms, e.g. ["youtube","tiktok","instagram"].
    platforms        jsonb not null default '["youtube"]'::jsonb,
    -- manual | assisted | autopilot_approval | full_autopilot.
    -- full_autopilot is reserved and MUST stay gated behind the publish gate;
    -- nothing in this migration grants autonomous publishing.
    automation_level text not null default 'manual',
    -- ACTIVE | PAUSED | ARCHIVED. A new series is PAUSED; a human activates it,
    -- the same posture the channels table takes.
    status           text not null default 'PAUSED',
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create index if not exists idx_series_channel
    on public.content_series (channel_id, created_at desc);

-- RLS: config data the Command Center reads and writes as an authenticated
-- user, exactly like public.channels. The service key bypasses RLS as usual.
alter table public.content_series enable row level security;

drop policy if exists content_series_select on public.content_series;
create policy content_series_select on public.content_series
    for select to authenticated using (true);

drop policy if exists content_series_auth_insert on public.content_series;
create policy content_series_auth_insert on public.content_series
    for insert to authenticated with check (true);

drop policy if exists content_series_auth_update on public.content_series;
create policy content_series_auth_update on public.content_series
    for update to authenticated using (true) with check (true);

-- Realtime, so the Command Center's Series screen updates live like Channels.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.content_series';
  end if;
exception when duplicate_object then
  null;  -- already in the publication; ignore
end $$;
