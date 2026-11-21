-- Review before publish: see the video, its title and its script, then decide.
--
-- Nothing here changes how the pipeline publishes. It cannot: the bot has
-- always uploaded with privacyStatus "private" (config.YOUTUBE_PRIVACY
-- defaults to private, and both the schedule and the dispatch default to it),
-- so no video has ever gone public on its own. This migration adds the place
-- to keep what a human needs in order to say yes, and the record of that yes.
--
-- Additive only. Every column is nullable or defaulted, so a deployment that
-- has not applied this keeps working exactly as before.

-- ── Which channels publish without asking ───────────────────────────────────
-- FALSE is the deliberate default: a channel does not go public on its own
-- until someone turns this on for that channel, one channel at a time.
alter table public.channels
  add column if not exists auto_publish boolean not null default false;

comment on column public.channels.auto_publish is
  'When false (default) a rendered video stays private until a human approves it. When true the pipeline may set it public — still only after the publish gate passes. The gate is in front of both paths.';

-- ── What the reviewer needs to see ──────────────────────────────────────────
alter table public.videos
  add column if not exists preview_path text,
  add column if not exists script_text text,
  add column if not exists review_state text not null default 'pending';

comment on column public.videos.preview_path is
  'Object path in the "previews" storage bucket, or null when the render was not kept. Never a public URL — the dashboard mints a short-lived signed URL.';
comment on column public.videos.script_text is
  'The narration this video was built from, as it was spoken. What the reviewer is actually approving.';
comment on column public.videos.review_state is
  'pending | approved | rejected. "pending" is the honest default: nobody has looked yet.';

alter table public.videos
  drop constraint if exists videos_review_state_check;
alter table public.videos
  add constraint videos_review_state_check
  check (review_state in ('pending', 'approved', 'rejected'));

create index if not exists videos_review_state_idx
  on public.videos (channel_id, review_state, published_at desc);

-- ── What the reviewer asked for ─────────────────────────────────────────────
-- An intent is a request, not an action. The dashboard writes one; the next
-- workflow run reads it and acts. Nothing in the browser can publish, re-render
-- or spend a token by itself.
create table if not exists public.review_intents (
  id           bigserial primary key,
  channel_id   text not null,
  video_id     text,
  action       text not null check (action in ('approve', 'regenerate', 'regenerate_script')),
  note         text,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  consumed_at  timestamptz,
  outcome      text
);

comment on table public.review_intents is
  'A reviewer''s request, waiting for the bot to pick it up. consumed_at is set by the run that acted on it; outcome records what happened.';

create index if not exists review_intents_pending_idx
  on public.review_intents (channel_id, consumed_at, created_at);

alter table public.review_intents enable row level security;

-- Signed-in operators may see and file intents. Nobody may edit or delete one:
-- an intent is a record of what was asked, and rewriting it would rewrite the
-- reason a video went out.
drop policy if exists review_intents_select on public.review_intents;
create policy review_intents_select on public.review_intents
  for select to authenticated using (true);

drop policy if exists review_intents_insert on public.review_intents;
create policy review_intents_insert on public.review_intents
  for insert to authenticated with check (true);

-- ── The bucket the previews live in ─────────────────────────────────────────
-- 50 MB is the free tier's own per-object ceiling for the whole project, so
-- this is the largest value the bucket will accept there. What goes in is a
-- 480p review copy (see modules/video_review.py), not the master render, which
-- is routinely bigger than this on its own.
insert into storage.buckets (id, name, public, file_size_limit)
values ('previews', 'previews', false, 52428800)
on conflict (id) do nothing;

-- Private bucket: signed-in operators can read (which is what lets the
-- dashboard mint a signed URL). Writing and pruning is the bot's job, and the
-- bot holds the service key, which bypasses RLS.
drop policy if exists previews_read on storage.objects;
create policy previews_read on storage.objects
  for select to authenticated using (bucket_id = 'previews');
