-- 0013_video_manifest.sql — the Video IR (project manifest) behind each video.
--
-- The pipeline now assembles one canonical description of every video it
-- builds — the Video IR v1 (modules/video_ir.py, schema in
-- schemas/video_ir.schema.json): its scenes with their REAL start/end on the
-- narration's audio timeline, each scene's Director shot (recipe, camera,
-- lighting, mood), the Elements it names, the b-roll assets placed under it,
-- and every asset's (partly still unknown) provenance and rights status. The
-- same JSON is written to output/<slug>/project.json on the runner; this
-- column keeps it with the video row so the Command Center, QC, critic and
-- repair stages can read it after the runner is gone.
--
-- Shape: {"version":1, "slug":..., "scenes":[{"id":"s000","start_s":0.0,
--   "end_s":14.2, "shot":{...}, "asset_ids":[...], ...}], "assets":[...], ...}
-- Unknown values are null / empty lists, never invented.
--
-- The bot writes it on the same PATCH that writes script_text and scenes
-- (modules/video_review.record); those scenes entries also gain start_s/end_s.
-- Videos published before this migration simply have manifest = null.
--
-- Additive and idempotent: `add column if not exists`, no data migration, no
-- RLS change (the existing videos policies already govern this row). Safe to
-- re-run.

alter table public.videos
  add column if not exists manifest jsonb;

comment on column public.videos.manifest is
  'The Video IR v1 (modules/video_ir.py) the video was built from: scenes with real audio-timeline start_s/end_s, shots, element/asset/claim ids, and asset provenance. Null for videos published before migration 0013.';
