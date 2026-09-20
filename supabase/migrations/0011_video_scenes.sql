-- 0011_video_scenes.sql — the structured scene plan behind each video.
--
-- Until now the Command Center only stored a video's narration as one flat
-- string (videos.script_text). The pipeline actually builds the video from a
-- STRUCTURED script — an ordered list of sections, each with a type (hook /
-- story), its narration, an intended duration and the b-roll keywords that
-- drove its footage (see modules/script_engine.Script). This column keeps that
-- structure, so the Storyboard can show the real scene plan (durations, shot
-- keywords, section type) instead of guessing scenes from paragraph breaks.
--
-- Shape: a JSON array of objects, e.g.
--   [{"name":"Hook","type":"hook","narration":"...","duration_hint":15,
--     "keywords":["storm","lighthouse"]}, ...]
-- The bot writes it on the same PATCH that already writes script_text
-- (modules/video_review.record). Nothing reads it that isn't ready for it to be
-- absent: every video published before this migration simply has scenes = null,
-- and the Storyboard falls back to parsing script_text, exactly as before.
--
-- Additive and idempotent: `add column if not exists`, no data migration, no RLS
-- change (the existing videos policies already govern this row). Safe to re-run.

alter table public.videos
  add column if not exists scenes jsonb;

comment on column public.videos.scenes is
  'The structured scene plan the video was built from: an ordered JSON array of {name, type, narration, duration_hint, keywords}. Null for videos published before migration 0011 — the Storyboard then falls back to splitting script_text on blank lines.';
