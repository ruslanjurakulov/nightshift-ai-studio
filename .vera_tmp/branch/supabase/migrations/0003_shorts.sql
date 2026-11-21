-- Chronos migration 0003 — Shorts
-- ============================================================================
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
