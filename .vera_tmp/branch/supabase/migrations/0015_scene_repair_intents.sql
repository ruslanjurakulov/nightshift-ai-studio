-- 0015_scene_repair_intents.sql — "Regenerate scene" requests (roadmap PR 2.3).
--
-- The Storyboard gains a per-scene "Regenerate scene" button. Like the review
-- panel's "Render it again", it only FILES A REQUEST: a row in review_intents,
-- now with action 'regenerate_scene' and the Video IR scene id it names. Nothing
-- in a browser re-renders, spends or publishes. The repair itself is the
-- daily_video.yml dispatch with `repair_scenes` (modules/scene_repair.py), which
-- consumes the matching requests (consumed_at + outcome) when it has rebuilt
-- the scene, and invalidates the previous cut's approval.
--
-- Unchanged on purpose:
--   * who may file: the insert policy from 0007 (editor and above) applies to
--     this action exactly as it does to 'regenerate';
--   * nobody may edit or delete an intent — there is still no update/delete
--     policy; only the bot (service key) sets consumed_at/outcome.
--
-- Additive and idempotent: a nullable column and a widened check, safe to
-- re-run. A deployment without it keeps working; filing a scene request then
-- fails with the database's own error, shown in the panel.

alter table public.review_intents
  add column if not exists scene_id text;

comment on column public.review_intents.scene_id is
  'For action = regenerate_scene: the Video IR scene id ("s003") to rebuild. Null for every other action.';

alter table public.review_intents
  drop constraint if exists review_intents_action_check;
alter table public.review_intents
  add constraint review_intents_action_check
  check (action in ('approve', 'regenerate', 'regenerate_script', 'regenerate_scene'));

-- A scene request names exactly one well-formed scene; no other action names one.
alter table public.review_intents
  drop constraint if exists review_intents_scene_id_check;
alter table public.review_intents
  add constraint review_intents_scene_id_check
  check (
    (action = 'regenerate_scene' and scene_id ~ '^s[0-9]{3,4}$')
    or (action <> 'regenerate_scene' and scene_id is null)
  );

create index if not exists review_intents_scene_pending_idx
  on public.review_intents (video_id, action, consumed_at)
  where action = 'regenerate_scene';
