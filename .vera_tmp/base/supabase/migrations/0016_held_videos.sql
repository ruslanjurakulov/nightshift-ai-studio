-- 0016_held_videos.sql — a videos row for a run that did NOT upload.
--
-- Until now a `videos` row appeared only after a successful YouTube upload. A
-- run the publish gate blocked, one held because auto-publish is off, one
-- waiting on two-person approval, and a scene repair's new cut had no row —
-- so no Command Center detail page, and no Storyboard "Regenerate scene"
-- button for the only videos a repair can actually act on.
--
-- modules/held_video.py now upserts a row for such a run. Its video_id is a
-- deterministic stand-in derived from (channel_id, slug) — "run-" + 20 hex —
-- because the YouTube id does not exist yet; when the run later uploads, the
-- same row is re-keyed to the YouTube id, so one run never has two rows.
--
-- What this migration adds is the row's state, when it was held, and why:
--   publish_state  blocked | awaiting_approval | held | repaired_awaiting_review
--                  | uploaded. NULL for every row written before this migration.
--   held_at        when the run was (last) held. NULL for an uploaded-only row.
--   hold_detail    the reason and the gate's own verdict (block/warning names,
--                  checks run). Never script or claim text.
--
-- A held row never claims to be published: published_at and privacy stay NULL
-- until a real upload writes them, and the check below makes that a database
-- rule rather than a convention.
--
-- Unchanged on purpose: no RLS change (the existing videos policies already
-- govern these columns: signed-in users read, only the bot's service key
-- writes), no change to publishing, privacy, approvals or the gate.
--
-- Additive and idempotent: nullable columns and re-creatable constraints, safe
-- to re-run. Without it the pipeline still writes the held row (minus these
-- three columns) and the dashboard tells held from uploaded by the absence of
-- published_at and privacy.

alter table public.videos
  add column if not exists publish_state text,
  add column if not exists held_at timestamptz,
  add column if not exists hold_detail jsonb;

comment on column public.videos.publish_state is
  'blocked | awaiting_approval | held | repaired_awaiting_review | uploaded. A held state means the run did not upload: published_at, privacy and the YouTube id are null. Null for rows written before migration 0016.';
comment on column public.videos.held_at is
  'When the run was last held without uploading. Null for rows that were never held.';
comment on column public.videos.hold_detail is
  'Why the run is held: {"reason": ..., "gate": {"allowed", "blocks", "warnings", "checks_run"}} or, for a repair, the repaired scene ids. Never script or claim text.';

alter table public.videos
  drop constraint if exists videos_publish_state_check;
alter table public.videos
  add constraint videos_publish_state_check
  check (publish_state is null or publish_state in
         ('blocked', 'awaiting_approval', 'held', 'repaired_awaiting_review', 'uploaded'));

-- A held row is not published, and says so with NULLs — never a placeholder.
alter table public.videos
  drop constraint if exists videos_held_not_published_check;
alter table public.videos
  add constraint videos_held_not_published_check
  check (
    publish_state is null
    or publish_state = 'uploaded'
    or (published_at is null and privacy is null)
  );

create index if not exists videos_held_idx
  on public.videos (channel_id, held_at desc)
  where published_at is null;
