-- 0080_repurpose.sql — one finished master, up to five vertical clips: priced,
-- confirmed, held and paid for only for the clips that were actually made.
--
-- Until now a video made ONE Short (modules/shorts.py: the hook, cut from the
-- master) and only when a channel switched Shorts on; the moment-ranking
-- library (modules/remix_segments.py) was imported by nothing. This migration
-- is the database half of "Repurpose": the person picks up to five clips from
-- the ones Nightshift proposes (scene boundaries, ranked by measured retention
-- when the video has any) and presses one priced, confirmed button.
--
--   quote_repurpose(video, clips)
--       what making these clips costs, computed HERE from the video's own
--       Video IR (videos.manifest, written only by the pipeline) and the price
--       list — never from anything the browser sends. 'priced' with a number,
--       'unpriced' (the price unit is not set: never 0), 'included' (the
--       operator's own organization) or 'unavailable' with the reason (the
--       master is not on file, the gate blocked it, a window crosses a scene,
--       a clip is too short or too long, two clips overlap, ...). Read-only;
--       any member who can read the video may ask. A clip is named by its
--       first and last scene ({"first": "s002", "last": "s004"}): the database
--       derives the window from the Video IR's own scene times, so a browser
--       cannot ask for an arbitrary second.
--   request_repurpose(video, clips, max_credits, idem)
--       the priced press, in one transaction: who (an admin of the channel's
--       organization — the Run now rule; reserve_credits checks it again),
--       idempotency (the same key and the same request return the same row
--       and hold nothing more; the same key with another request is refused),
--       one request at a time per video, the re-quote, max_credits (a price
--       above what the person confirmed is price_changed and nothing is held),
--       the hold (= the quote, reserve_credits: balance and platform floor)
--       and the request with one row per clip. Any refusal rolls all of it
--       back. No render_jobs row is made: clips are cut from a finished file
--       by the queue worker between render jobs (like paid downloads, 0030),
--       so this migration leaves the render queue's billing rules untouched.
--
-- THE WINDOWS (repurpose_plan, a pure function the quote and the press share)
--   A clip is a run of WHOLE scenes. The Video IR's scene times are the audio
--   mixer's measured section timeline, so a boundary between two scenes is
--   between two narration sections: a clip never starts or ends inside a
--   scene, and so never inside a word. Rules: every scene of the run has real
--   times; the run is at most 12 scenes; its length is 15..60 seconds (the
--   Shorts window of modules/shorts.py); it ends inside the narration audio;
--   two clips of one request share no scene. The ranking that PROPOSES clips
--   (modules/repurpose.py, lib/repurpose.ts) is advisory and is not trusted
--   here: whatever is pressed is re-derived and re-checked.
--
-- THE MONEY (0020's functions, called as they are; their internals untouched)
--   price   = max( n x round_up(repurpose_clip x (1 + margin)),
--                  round_up(job_minimum) )          n = clips in the request
--           'repurpose_clip' is a row of credit_prices the owner sets. A
--           missing unit is 'unpriced' and the press is refused — never a 0.
--           None is inserted here: an unset price blocks the feature by design.
--   hold    = the price, under the reference 'rp-<request id>', placed by the
--           press.
--   capture = for the clips that were made: min(price, max(k x clip price,
--           job_minimum)) for k made clips (capture_credits never exceeds the
--           hold, and a CHECK keeps charged_credits <= quoted_credits). The
--           unused part of the hold goes back in the same call.
--   release = the whole hold when no clip was made — a master that is not on
--           the worker, one that changed since the quote, a worker that died.
--           A failed clip is never charged.
--
-- WHAT A CLIP NEVER DOES
--   Every clip is its own videos row, written by the worker's settle function
--   only: held, private and ungated — publish_state 'held', published_at and
--   privacy NULL (0016's CHECK), review_state 'pending', video_format 'short'
--   and parent_video_id = the master (0003), hold_detail naming it a
--   repurposed clip with NO gate verdict (so every page reads "no gate verdict
--   is recorded", never "passed"). Nothing here uploads, publishes or changes
--   privacy. A held row cannot be cross-posted: publish_request_refusal (0029)
--   refuses it as not_uploaded, so a clip reaches an audience only through the
--   gate and the approvals, as every other video does. The source of a clip
--   is the MASTER file on the worker (videos.local_path under output/), never
--   the 480p review copy: the worker refuses a source whose short side is
--   below 720 pixels.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser via the anon key)
--   repurpose_requests, repurpose_clips
--                         select: members of the channel's organization ·
--                         insert / update / delete: nobody directly
--   quote_repurpose        authenticated, reads only what the caller may read
--   request_repurpose      authenticated; admin of the channel's organization
--   claim_ / heartbeat_ / record_ / finish_ / expire_  (repurpose ...)
--                         service role only (tools/queue_worker.py)
--   repurpose_plan, repurpose_price, repurpose_master_state, repurpose_settle
--                         internal; no API role calls them
--   anon gets nothing.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps,
-- command-center/lib/repurpose.ts)
--   42501 forbidden (not signed in / not an admin here / no such video)
--   22023 invalid_clips | invalid_idempotency_key | price_required
--   NS400 clips_unavailable (detail: the reason) | unpriced
--   NS409 in_progress | price_changed | idempotency_conflict
--   NS402 from reserve_credits (insufficient credits)
--
-- REQUIRES 0003 (videos.video_format, parent_video_id), 0013 (videos.manifest),
-- 0016 (videos.publish_state), 0018 (organizations), 0020 (credits). Optional:
-- 0030 (download_masters: a master recorded below 720 pixels is refused).
-- Additive and idempotent: guarded creates, create-or-replace functions,
-- drop-then-create policies, triggers and constraints. Nothing is dropped and
-- no existing function, policy or constraint is replaced.

do $$
begin
  if to_regprocedure('public.accessible_channel_ids(text)') is null
     or to_regprocedure('public.channel_org(text)') is null then
    raise exception '0080 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.reserve_credits(uuid,text,numeric)') is null
     or to_regprocedure('public.capture_credits(text,numeric,boolean)') is null
     or to_regprocedure('public.release_credits(text)') is null
     or to_regprocedure('public.start_credit_reservation(text,uuid)') is null
     or to_regprocedure('public.credits_round_up(numeric)') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null
     or to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0080 needs the credit ledger: apply 0020_credits.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'manifest')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'videos' and column_name = 'publish_state')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'videos' and column_name = 'parent_video_id')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'videos' and column_name = 'video_format') then
    raise exception '0080 needs videos.manifest, publish_state, video_format and parent_video_id: apply 0003, 0013 and 0016 first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. One row per press, and one per clip
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.repurpose_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  channel_id       text not null,
  video_id         text not null,
  slug             text not null,
  clip_count       integer not null,
  unit_credits     numeric(14,2),
  floor_credits    numeric(14,2),
  quoted_credits   numeric(14,2),
  credit_ref       text,
  charged_credits  numeric(14,2),
  status           text not null default 'queued',
  idempotency_key  text not null,
  request_hash     text not null,
  attempts         integer not null default 0,
  worker_id        text,
  heartbeat_at     timestamptz,
  error_code       text,
  error            text,
  requested_by     uuid,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

comment on table public.repurpose_requests is
  'One priced "Repurpose" press (migration 0080): which master, how many clips, the quote, the hold that pays for it and how it ended. Written only by the 0080 functions.';
comment on column public.repurpose_requests.charged_credits is
  'What was captured: only the clips that were made are charged, never above quoted_credits. NULL for the operator''s own organization (nothing is held there).';

alter table public.repurpose_requests drop constraint if exists repurpose_requests_ids_check;
alter table public.repurpose_requests add constraint repurpose_requests_ids_check
  check (channel_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
         and char_length(video_id) between 1 and 128
         and slug ~ '^[a-z0-9][a-z0-9-]{0,63}$');
alter table public.repurpose_requests drop constraint if exists repurpose_requests_count_check;
alter table public.repurpose_requests add constraint repurpose_requests_count_check
  check (clip_count between 1 and 5 and attempts between 0 and 10);
alter table public.repurpose_requests drop constraint if exists repurpose_requests_money_check;
alter table public.repurpose_requests add constraint repurpose_requests_money_check
  check ((quoted_credits is null or quoted_credits > 0)
         and (unit_credits is null or unit_credits > 0)
         and (floor_credits is null or floor_credits >= 0)
         and (credit_ref is null
              or (credit_ref ~ '^rp-[0-9a-f]{32}$' and quoted_credits is not null and unit_credits is not null
                  and floor_credits is not null))
         and (charged_credits is null
              or (charged_credits >= 0 and charged_credits <= coalesce(quoted_credits, 0))));
alter table public.repurpose_requests drop constraint if exists repurpose_requests_status_check;
alter table public.repurpose_requests add constraint repurpose_requests_status_check
  check (status in ('queued', 'running', 'succeeded', 'partial', 'failed')
         and ((status in ('succeeded', 'partial', 'failed')) = (finished_at is not null)));
alter table public.repurpose_requests drop constraint if exists repurpose_requests_keys_check;
alter table public.repurpose_requests add constraint repurpose_requests_keys_check
  check (idempotency_key ~ '^[A-Za-z0-9_:.-]{8,128}$' and request_hash ~ '^[0-9a-f]{32}$');
alter table public.repurpose_requests drop constraint if exists repurpose_requests_outcome_check;
alter table public.repurpose_requests add constraint repurpose_requests_outcome_check
  check ((error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,47}$')
         and (error is null or char_length(error) <= 500)
         and (worker_id is null or char_length(worker_id) between 1 and 128));

-- One key, one press: a replay finds the first row instead of a second hold.
create unique index if not exists repurpose_requests_idem_key
  on public.repurpose_requests (org_id, idempotency_key);
-- One request at a time per video: two presses (two tabs, two admins) would
-- cut the same master twice. A database rule, not a button.
create unique index if not exists repurpose_requests_one_active_per_video
  on public.repurpose_requests (video_id) where status in ('queued', 'running');
create index if not exists repurpose_requests_video_idx
  on public.repurpose_requests (video_id, created_at desc);
create index if not exists repurpose_requests_queue_idx
  on public.repurpose_requests (status, created_at) where status in ('queued', 'running');

create table if not exists public.repurpose_clips (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.repurpose_requests (id) on delete restrict,
  org_id         uuid not null references public.organizations (id) on delete restrict,
  channel_id     text not null,
  master_id      text not null,
  ordinal        integer not null,
  first_scene    text not null,
  last_scene     text not null,
  scene_ids      text[] not null,
  start_s        numeric(10,3) not null,
  end_s          numeric(10,3) not null,
  duration_s     numeric(10,3) not null,
  status         text not null default 'queued',
  clip_video_id  text,
  local_path     text,
  width          integer,
  height         integer,
  bytes          bigint,
  sha256         text,
  captions       jsonb,
  error_code     text,
  error          text,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);

comment on table public.repurpose_clips is
  'One clip of a Repurpose press (migration 0080): the scenes it is made of and the window the database derived from the Video IR, and, once made, the held videos row that is the clip. Written only by the 0080 functions.';
comment on column public.repurpose_clips.captions is
  'Per-platform captions built by the worker from the master''s own title and the clip''s own narration, deterministically (modules/social_captions.py). Nothing here is posted anywhere.';

alter table public.repurpose_clips drop constraint if exists repurpose_clips_window_check;
alter table public.repurpose_clips add constraint repurpose_clips_window_check
  check (ordinal between 1 and 5
         and first_scene ~ '^s[0-9]{3,4}$' and last_scene ~ '^s[0-9]{3,4}$'
         and cardinality(scene_ids) between 1 and 12
         and scene_ids[1] = first_scene and scene_ids[cardinality(scene_ids)] = last_scene
         and start_s >= 0 and end_s > start_s
         and abs((end_s - start_s) - duration_s) < 0.002
         and duration_s between 15 and 60);
alter table public.repurpose_clips drop constraint if exists repurpose_clips_status_check;
alter table public.repurpose_clips add constraint repurpose_clips_status_check
  check (status in ('queued', 'rendered', 'failed')
         and ((status = 'queued') = (finished_at is null))
         and ((status = 'rendered') = (clip_video_id is not null and sha256 is not null
                                       and bytes is not null and local_path is not null)));
alter table public.repurpose_clips drop constraint if exists repurpose_clips_file_check;
alter table public.repurpose_clips add constraint repurpose_clips_file_check
  check ((sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
         and (bytes is null or bytes > 0)
         and (width is null or (width between 16 and 16384 and height between 16 and 16384 and height > width))
         and (local_path is null or local_path ~ '^output/[a-z0-9][a-z0-9-]{0,63}/repurpose/[0-9a-f]{8}/clip-[0-9]{2}[.]mp4$')
         and (captions is null or (jsonb_typeof(captions) = 'object' and octet_length(captions::text) <= 8192)));
alter table public.repurpose_clips drop constraint if exists repurpose_clips_outcome_check;
alter table public.repurpose_clips add constraint repurpose_clips_outcome_check
  check ((error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,47}$')
         and (error is null or char_length(error) <= 500)
         and (status <> 'rendered' or (error_code is null and error is null)));

create unique index if not exists repurpose_clips_position_key
  on public.repurpose_clips (request_id, ordinal);
create unique index if not exists repurpose_clips_video_key
  on public.repurpose_clips (clip_video_id) where clip_video_id is not null;
create index if not exists repurpose_clips_master_idx
  on public.repurpose_clips (master_id, created_at desc);

-- A press's terms are what was priced and held. Only how it ends moves.
create or replace function public.repurpose_requests_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.org_id is distinct from old.org_id
     or new.channel_id is distinct from old.channel_id
     or new.video_id is distinct from old.video_id
     or new.slug is distinct from old.slug
     or new.clip_count is distinct from old.clip_count
     or new.unit_credits is distinct from old.unit_credits
     or new.floor_credits is distinct from old.floor_credits
     or new.quoted_credits is distinct from old.quoted_credits
     or new.credit_ref is distinct from old.credit_ref
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_hash is distinct from old.request_hash
     or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at
     or old.status in ('succeeded', 'partial', 'failed') then
    raise exception 'a repurpose request''s terms are fixed when it is requested, and an ended one is final'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists repurpose_requests_terms_frozen on public.repurpose_requests;
create trigger repurpose_requests_terms_frozen
  before update on public.repurpose_requests
  for each row execute function public.repurpose_requests_terms_frozen();

create or replace function public.repurpose_clips_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.request_id is distinct from old.request_id
     or new.org_id is distinct from old.org_id
     or new.channel_id is distinct from old.channel_id
     or new.master_id is distinct from old.master_id
     or new.ordinal is distinct from old.ordinal
     or new.first_scene is distinct from old.first_scene
     or new.last_scene is distinct from old.last_scene
     or new.scene_ids is distinct from old.scene_ids
     or new.start_s is distinct from old.start_s
     or new.end_s is distinct from old.end_s
     or new.duration_s is distinct from old.duration_s
     or new.created_at is distinct from old.created_at
     or old.status in ('rendered', 'failed') then
    raise exception 'a repurposed clip''s window is fixed when it is requested, and an ended clip is final'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists repurpose_clips_terms_frozen on public.repurpose_clips;
create trigger repurpose_clips_terms_frozen
  before update on public.repurpose_clips
  for each row execute function public.repurpose_clips_terms_frozen();

create or replace function public.repurpose_no_delete() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'a repurpose request is a record of a paid press and is never deleted'
    using errcode = '42501';
end
$$;

drop trigger if exists repurpose_requests_no_delete on public.repurpose_requests;
create trigger repurpose_requests_no_delete
  before delete on public.repurpose_requests
  for each row execute function public.repurpose_no_delete();
drop trigger if exists repurpose_clips_no_delete on public.repurpose_clips;
create trigger repurpose_clips_no_delete
  before delete on public.repurpose_clips
  for each row execute function public.repurpose_no_delete();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The windows, the master's state and the price
-- ───────────────────────────────────────────────────────────────────────────

-- The clips a request names, as windows of whole scenes of a Video IR
-- (modules/video_ir.py): {"ok": true, "clips": [{position, first, last,
-- scene_ids, start_s, end_s, duration_s}]} or {"ok": false, "reason": ...}.
-- Pure. The limits are modules/repurpose.py's (MIN/MAX_CLIP_SECONDS,
-- MAX_CLIPS, MAX_CLIP_SCENES); tests/test_repurpose_migration.py pins that
-- the two agree.
create or replace function public.repurpose_plan(p_manifest jsonb, p_clips jsonb) returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  c        jsonb;
  sc       jsonb;
  pos      integer;
  n        integer;
  ids      text[] := '{}';
  starts   numeric[] := '{}';
  ends     numeric[] := '{}';
  fos      integer[] := '{}';
  los      integer[] := '{}';
  f        text;
  l        text;
  fo       integer;
  lo       integer;
  k        integer;
  j        integer;
  w_start  numeric;
  w_end    numeric;
  w_dur    numeric;
  a_dur    numeric;
  sids     text[];
  out_     jsonb := '[]'::jsonb;
begin
  if p_clips is null or jsonb_typeof(p_clips) <> 'array'
     or jsonb_array_length(p_clips) < 1 or jsonb_array_length(p_clips) > 5 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_clips');
  end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
     or jsonb_typeof(p_manifest -> 'scenes') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'reason', 'no_manifest');
  end if;
  for sc in select s from jsonb_array_elements(p_manifest -> 'scenes') s loop
    if jsonb_typeof(sc) = 'object' and jsonb_typeof(sc -> 'id') = 'string'
       and (sc ->> 'id') ~ '^s[0-9]{3,4}$' then
      ids := ids || (sc ->> 'id');
      starts := starts || case when jsonb_typeof(sc -> 'start_s') = 'number' then (sc -> 'start_s')::numeric end;
      ends := ends || case when jsonb_typeof(sc -> 'end_s') = 'number' then (sc -> 'end_s')::numeric end;
    else
      ids := ids || null::text;
      starts := starts || null::numeric;
      ends := ends || null::numeric;
    end if;
  end loop;
  if (select count(x) <> count(distinct x) from unnest(ids) x) then
    return jsonb_build_object('ok', false, 'reason', 'scene_ids_not_unique');
  end if;
  a_dur := case when jsonb_typeof(p_manifest -> 'audio' -> 'duration_s') = 'number'
                then (p_manifest -> 'audio' -> 'duration_s')::numeric end;

  pos := 0;
  for c in select e from jsonb_array_elements(p_clips) e loop
    pos := pos + 1;
    if jsonb_typeof(c) <> 'object' or jsonb_typeof(c -> 'first') is distinct from 'string'
       or jsonb_typeof(c -> 'last') is distinct from 'string'
       or (c ->> 'first') !~ '^s[0-9]{3,4}$' or (c ->> 'last') !~ '^s[0-9]{3,4}$' then
      return jsonb_build_object('ok', false, 'reason', 'invalid_clips');
    end if;
    f := c ->> 'first';
    l := c ->> 'last';
    fo := array_position(ids, f);
    lo := array_position(ids, l);
    if fo is null or lo is null then
      return jsonb_build_object('ok', false, 'reason', 'scene_not_found', 'position', pos);
    end if;
    if fo > lo then
      return jsonb_build_object('ok', false, 'reason', 'invalid_range', 'position', pos);
    end if;
    if lo - fo + 1 > 12 then
      return jsonb_build_object('ok', false, 'reason', 'too_many_scenes', 'position', pos);
    end if;
    sids := '{}';
    for k in fo .. lo loop
      if ids[k] is null or starts[k] is null or ends[k] is null or starts[k] < 0 or ends[k] <= starts[k]
         or (k > fo and starts[k] < ends[k - 1] - 0.001) then
        return jsonb_build_object('ok', false, 'reason', 'scene_timing_unknown', 'position', pos);
      end if;
      sids := sids || ids[k];
    end loop;
    w_start := round(starts[fo], 3);
    w_end := round(ends[lo], 3);
    w_dur := round(w_end - w_start, 3);
    if w_dur < 15 then
      return jsonb_build_object('ok', false, 'reason', 'clip_too_short', 'position', pos);
    end if;
    if w_dur > 60 then
      return jsonb_build_object('ok', false, 'reason', 'clip_too_long', 'position', pos);
    end if;
    if a_dur is not null and w_end > a_dur + 0.5 then
      return jsonb_build_object('ok', false, 'reason', 'beyond_audio', 'position', pos);
    end if;
    for j in 1 .. coalesce(cardinality(fos), 0) loop
      if not (lo < fos[j] or fo > los[j]) then
        return jsonb_build_object('ok', false, 'reason', 'clips_overlap', 'position', pos);
      end if;
    end loop;
    fos := fos || fo;
    los := los || lo;
    out_ := out_ || jsonb_build_array(jsonb_build_object(
      'position', pos, 'first', f, 'last', l, 'scene_ids', to_jsonb(sids),
      'start_s', w_start, 'end_s', w_end, 'duration_s', w_dur));
  end loop;
  return jsonb_build_object('ok', true, 'clips', out_);
end
$$;

-- Why this video cannot be repurposed, or NULL when it can. The master must be
-- a real, finished render of a run of this channel: not a clip or a Short, not
-- blocked by the publish gate, not rejected by a reviewer, with its Video IR
-- and the file the worker cuts from. Leans to refusing.
create or replace function public.repurpose_master_state(v public.videos) returns text
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_side integer;
begin
  if coalesce(v.video_format, 'long') <> 'long' or v.parent_video_id is not null
     or coalesce(v.hold_detail ->> 'reason', '') = 'repurposed_clip' then
    return 'is_a_clip';
  end if;
  if coalesce(v.publish_state, '') = 'blocked' then
    return 'gate_blocked';
  end if;
  if coalesce(v.review_state, 'pending') = 'rejected' then
    return 'rejected';
  end if;
  if coalesce(v.slug, '') !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    return 'no_run';
  end if;
  if v.manifest is null then
    return 'no_manifest';
  end if;
  if nullif(btrim(coalesce(v.local_path, '')), '') is null then
    return 'no_master';
  end if;
  -- 0030 records the master's frame size when its worker has probed it. A
  -- recorded master below 720 pixels is a review copy, never a source.
  if to_regclass('public.download_masters') is not null then
    -- Dynamic, so this function compiles without 0030 applied.
    execute 'select least(width, height) from public.download_masters where video_id = $1'
       into v_side using v.video_id;
    if v_side is not null and v_side < 720 then
      return 'master_too_small';
    end if;
  end if;
  return null;
end
$$;

-- The price of n clips from the platform price list. 'unpriced' when the unit
-- is not set; a price is never invented and never 0.
create or replace function public.repurpose_price(p_n integer) returns jsonb
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  base    public.credit_prices;
  jm      numeric;
  v_unit  numeric;
  v_floor numeric;
  total   numeric;
begin
  select * into base from public.credit_prices where unit = 'repurpose_clip';
  if base.unit is null or p_n is null or p_n < 1 then
    return jsonb_build_object('status', 'unpriced', 'credits', null);
  end if;
  v_unit := public.credits_round_up(base.credits_per_unit * (1 + base.margin));
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  v_floor := public.credits_round_up(coalesce(jm, 0));
  total := greatest(v_unit * p_n, v_floor);
  if v_unit is null or v_unit <= 0 or total <= 0 then
    -- A hold must be positive (0020); a price of 0 cannot pay for anything.
    return jsonb_build_object('status', 'unpriced', 'credits', null);
  end if;
  return jsonb_build_object('status', 'priced', 'credits', total, 'unit_credits', v_unit, 'floor_credits', v_floor);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The quote and the press
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.quote_repurpose(p_video text, p_clips jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v        public.videos;
  v_org    uuid;
  v_exempt boolean;
  v_active uuid;
  v_state  text;
  plan     jsonb;
  price    jsonb;
  out_     jsonb;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.videos where video_id = p_video;
  -- Missing and not-yours read the same: no oracle for another tenant's ids.
  if v.video_id is null or not (v.channel_id in (select public.accessible_channel_ids('viewer'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_org := public.channel_org(v.channel_id);
  if v_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_exempt := public.credits_exempt(v_org);
  out_ := jsonb_build_object(
    'video_id', v.video_id, 'exempt', v_exempt,
    'may_start', v.channel_id in (select public.accessible_channel_ids('admin')),
    'credits', null);

  v_state := public.repurpose_master_state(v);
  if v_state is not null then
    return out_ || jsonb_build_object('status', 'unavailable', 'reason', v_state);
  end if;
  select id into v_active from public.repurpose_requests
   where video_id = v.video_id and status in ('queued', 'running') limit 1;
  if v_active is not null then
    return out_ || jsonb_build_object('status', 'unavailable', 'reason', 'in_progress', 'active_id', v_active);
  end if;
  plan := public.repurpose_plan(v.manifest, p_clips);
  if not coalesce((plan ->> 'ok')::boolean, false) then
    return out_ || jsonb_build_object('status', 'unavailable', 'reason', plan ->> 'reason',
                                      'position', plan -> 'position');
  end if;
  out_ := out_ || jsonb_build_object('clip_count', jsonb_array_length(plan -> 'clips'), 'clips', plan -> 'clips');
  if v_exempt then
    -- The operator's own organization holds nothing (0020). Not "0 credits".
    return out_ || jsonb_build_object('status', 'included');
  end if;
  price := public.repurpose_price(jsonb_array_length(plan -> 'clips'));
  -- What a member reads is what is charged: the total and the per-clip price.
  -- Never the base rate, margin or unit name (the operator's, 0084).
  return out_ || jsonb_build_object('status', price ->> 'status', 'credits', price -> 'credits',
                                    'clip_credits', price -> 'unit_credits');
end
$$;

create or replace function public.request_repurpose(
  p_video text, p_clips jsonb, p_max_credits numeric, p_idem text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v        public.videos;
  v_org    uuid;
  v_exempt boolean;
  v_state  text;
  v_hash   text;
  prior    public.repurpose_requests;
  plan     jsonb;
  price    jsonb;
  v_price  numeric;
  v_unit   numeric;
  v_floor  numeric;
  v_id     uuid := gen_random_uuid();
  v_ref    text;
  v_res    jsonb;
  c        jsonb;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.videos where video_id = p_video;
  -- The Run now rule: an admin of the channel's organization. A viewer or
  -- editor, another organization, and a video that does not exist all get
  -- the same refusal before anything is looked at.
  if v.video_id is null or not (v.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_org := public.channel_org(v.channel_id);
  if v_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  plan := public.repurpose_plan(v.manifest, p_clips);
  if plan ->> 'reason' = 'invalid_clips' then
    raise exception 'invalid_clips' using errcode = '22023';
  end if;

  -- Presses on one video take turns: a double click, a second tab or a second
  -- admin waits here, then sees the first one's row.
  perform pg_advisory_xact_lock(hashtextextended('repurpose:' || v.video_id, 0));

  v_hash := md5(jsonb_build_object('video', v.video_id, 'clips', (
    select coalesce(jsonb_agg(jsonb_build_array(e ->> 'first', e ->> 'last')), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(p_clips) = 'array' then p_clips else '[]'::jsonb end) e
     where jsonb_typeof(e) = 'object'))::text);
  select * into prior from public.repurpose_requests
   where org_id = v_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    -- The same press again (a retry, a replay): its row, nothing held twice.
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'clip_count', prior.clip_count,
                              'credits_held', prior.quoted_credits, 'credit_ref', prior.credit_ref,
                              'replayed', true);
  end if;

  v_state := public.repurpose_master_state(v);
  if v_state is not null then
    raise exception 'clips_unavailable' using errcode = 'NS400', detail = v_state;
  end if;
  if exists (select 1 from public.repurpose_requests
              where video_id = v.video_id and status in ('queued', 'running')) then
    raise exception 'in_progress' using errcode = 'NS409';
  end if;
  if not coalesce((plan ->> 'ok')::boolean, false) then
    raise exception 'clips_unavailable' using errcode = 'NS400', detail = plan ->> 'reason';
  end if;

  v_exempt := public.credits_exempt(v_org);
  if not v_exempt then
    price := public.repurpose_price(jsonb_array_length(plan -> 'clips'));
    if price ->> 'status' <> 'priced' then
      raise exception 'unpriced' using errcode = 'NS400';
    end if;
    v_price := (price ->> 'credits')::numeric;
    v_unit := (price ->> 'unit_credits')::numeric;
    v_floor := (price ->> 'floor_credits')::numeric;
    -- The press carries the price the person saw; without one nothing is spent.
    if p_max_credits is null then
      raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);
    end if;
    if v_price > p_max_credits then
      raise exception 'price_changed' using errcode = 'NS409', detail = format('credits=%s', v_price);
    end if;
    v_ref := 'rp-' || replace(v_id::text, '-', '');
    -- The hold is the quote. reserve_credits checks the caller is an admin of
    -- the organization, the balance and the platform floor.
    v_res := public.reserve_credits(v_org, v_ref, v_price);
    if coalesce((v_res ->> 'exempt')::boolean, false) then
      v_ref := null;
      v_price := null;
      v_unit := null;
      v_floor := null;
    end if;
  end if;

  insert into public.repurpose_requests (
    id, org_id, channel_id, video_id, slug, clip_count, unit_credits, floor_credits, quoted_credits,
    credit_ref, idempotency_key, request_hash, requested_by)
  values (
    v_id, v_org, v.channel_id, v.video_id, v.slug, jsonb_array_length(plan -> 'clips'), v_unit, v_floor,
    v_price, v_ref, p_idem, v_hash, auth.uid());
  for c in select e from jsonb_array_elements(plan -> 'clips') e loop
    insert into public.repurpose_clips (
      request_id, org_id, channel_id, master_id, ordinal, first_scene, last_scene, scene_ids,
      start_s, end_s, duration_s)
    values (
      v_id, v_org, v.channel_id, v.video_id, (c ->> 'position')::integer, c ->> 'first', c ->> 'last',
      array(select jsonb_array_elements_text(c -> 'scene_ids')),
      (c ->> 'start_s')::numeric, (c ->> 'end_s')::numeric, (c ->> 'duration_s')::numeric);
  end loop;

  return jsonb_build_object('id', v_id, 'status', 'queued', 'clip_count', jsonb_array_length(plan -> 'clips'),
                            'credits_held', v_price, 'credit_ref', v_ref, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The worker's side (service role only)
-- ───────────────────────────────────────────────────────────────────────────

-- How a request ends, with the money, in one transaction. Charged: the clips
-- that were made, never above the hold. Nothing made: the whole hold is
-- released. A clip the worker never reported is failed here, not charged.
-- Ending twice changes nothing and returns the first answer. Internal: the
-- worker's finish and the expiry sweep call it; no API role does.
create or replace function public.repurpose_settle(p_id uuid, p_code text, p_msg text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r         public.repurpose_requests;
  res       public.credit_reservations;
  v_code    text := case when p_code ~ '^[a-z][a-z0-9_]{0,47}$' then p_code else 'failed' end;
  v_made    integer;
  v_charge  numeric;
  v_charged numeric;
  v_status  text;
  v_first   text;
begin
  select * into r from public.repurpose_requests where id = p_id for update;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if r.status in ('succeeded', 'partial', 'failed') then
    return jsonb_build_object('id', r.id, 'status', r.status, 'charged_credits', r.charged_credits,
                              'replayed', true);
  end if;
  update public.repurpose_clips
     set status = 'failed', finished_at = now(), error_code = v_code, error = left(p_msg, 500)
   where request_id = r.id and status = 'queued';
  select count(*) into v_made from public.repurpose_clips where request_id = r.id and status = 'rendered';
  select error_code into v_first from public.repurpose_clips
   where request_id = r.id and error_code is not null order by ordinal limit 1;

  if v_made = 0 then
    if r.credit_ref is not null then
      select * into res from public.credit_reservations where job_id = r.credit_ref;
      if res.job_id is not null and res.status = 'open' then
        perform public.release_credits(r.credit_ref);
      end if;
    end if;
    update public.repurpose_requests
       set status = 'failed', charged_credits = case when r.credit_ref is null then null else 0 end,
           finished_at = now(), error_code = coalesce(v_first, v_code), error = left(p_msg, 500)
     where id = r.id;
    return jsonb_build_object('id', r.id, 'status', 'failed', 'charged_credits', 0, 'replayed', false);
  end if;

  v_status := case when v_made = r.clip_count then 'succeeded' else 'partial' end;
  if r.credit_ref is not null then
    -- The clips that exist are charged; the rest of the hold goes back inside
    -- capture_credits. The minimum charge applies once anything is delivered.
    v_charge := least(r.quoted_credits, greatest(v_made * r.unit_credits, r.floor_credits));
    v_charged := public.capture_credits(r.credit_ref, v_charge, false);
  end if;
  update public.repurpose_requests
     set status = v_status, charged_credits = case when r.credit_ref is null then null else v_charged end,
         finished_at = now(), error_code = case when v_status = 'partial' then coalesce(v_first, v_code) end,
         error = case when v_status = 'partial' then left(p_msg, 500) end
   where id = r.id;
  return jsonb_build_object('id', r.id, 'status', v_status, 'charged_credits', v_charged, 'replayed', false);
end
$$;

-- The worker's claim: the oldest queued request, or a running one whose worker
-- stopped beating (re-queued at most three times). The hold is claimed
-- (start_credit_reservation) before anything is spent; a request whose hold is
-- no longer open is failed here and nothing runs or is charged. Returns the
-- frozen terms — the master's title and file, and the clips still to make — or
-- null when there is nothing to do.
create or replace function public.claim_repurpose_request(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r      public.repurpose_requests;
  v      public.videos;
  amt    numeric;
  clips  jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_worker is null or char_length(p_worker) not between 1 and 128 then
    raise exception 'invalid_worker' using errcode = '22023';
  end if;
  loop
    select * into r from public.repurpose_requests
     where status = 'queued'
        or (status = 'running' and heartbeat_at < now() - interval '10 minutes' and attempts < 3)
     order by created_at
     limit 1
     for update skip locked;
    if r.id is null then
      return null;
    end if;
    if r.credit_ref is not null then
      amt := public.start_credit_reservation(r.credit_ref, r.org_id);
      if amt is null or amt < r.quoted_credits then
        if amt is not null then
          perform public.release_credits(r.credit_ref);
        end if;
        perform public.repurpose_settle(r.id, 'hold_not_open',
          'The credit hold for this request was no longer open, so nothing ran and nothing was charged.');
        continue;
      end if;
    end if;
    update public.repurpose_requests
       set status = 'running', attempts = attempts + 1, worker_id = p_worker, heartbeat_at = now(),
           started_at = coalesce(started_at, now())
     where id = r.id
    returning * into r;
    select * into v from public.videos where video_id = r.video_id;
    select coalesce(jsonb_agg(jsonb_build_object(
             'position', k.ordinal, 'first', k.first_scene, 'last', k.last_scene,
             'scene_ids', to_jsonb(k.scene_ids), 'start_s', k.start_s, 'end_s', k.end_s,
             'duration_s', k.duration_s,
             'local_path', 'output/' || r.slug || '/repurpose/' || substr(replace(r.id::text, '-', ''), 1, 8)
                           || '/clip-' || lpad(k.ordinal::text, 2, '0') || '.mp4')
             order by k.ordinal), '[]'::jsonb)
      into clips from public.repurpose_clips k where k.request_id = r.id and k.status = 'queued';
    return jsonb_build_object(
      'id', r.id, 'channel_id', r.channel_id, 'video_id', r.video_id, 'slug', r.slug,
      'clip_count', r.clip_count, 'attempt', r.attempts,
      'master', jsonb_build_object('video_id', v.video_id, 'title', v.title, 'topic', v.topic,
                                   'local_path', v.local_path),
      'clips', clips);
  end loop;
end
$$;

-- The worker's beat: this request is still being worked on, by this worker.
create or replace function public.heartbeat_repurpose(p_id uuid, p_worker text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.repurpose_requests set heartbeat_at = now()
   where id = p_id and status = 'running' and worker_id = p_worker;
  get diagnostics n = row_count;
  return n > 0;
end
$$;

-- One clip's outcome. A made clip becomes its own videos row in the same
-- transaction: held, private, not gated, a Short cut from the master (see the
-- header). The row's id, slug and file path are built here from the request,
-- never taken from the worker; the worker supplies only what it measured and
-- the text it built. A clip reported twice changes nothing.
create or replace function public.record_repurpose_clip(
  p_id uuid, p_worker text, p_position integer, p_ok boolean, p_info jsonb
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r      public.repurpose_requests;
  k      public.repurpose_clips;
  m      public.videos;
  info   jsonb := case when jsonb_typeof(p_info) = 'object' then p_info else '{}'::jsonb end;
  id8    text;
  v_slug text;
  v_vid  text;
  v_path text;
  v_title text;
  v_code text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.repurpose_requests where id = p_id for update;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if r.status <> 'running' or r.worker_id is distinct from p_worker then
    raise exception 'not_claimed' using errcode = 'P0002';
  end if;
  select * into k from public.repurpose_clips where request_id = r.id and ordinal = p_position for update;
  if k.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if k.status <> 'queued' then
    return jsonb_build_object('position', k.ordinal, 'status', k.status, 'clip_video_id', k.clip_video_id,
                              'replayed', true);
  end if;

  if not coalesce(p_ok, false) then
    v_code := case when info ->> 'error_code' ~ '^[a-z][a-z0-9_]{0,47}$' then info ->> 'error_code' else 'failed' end;
    update public.repurpose_clips
       set status = 'failed', finished_at = now(), error_code = v_code, error = left(info ->> 'error', 500)
     where id = k.id;
    return jsonb_build_object('position', k.ordinal, 'status', 'failed', 'replayed', false);
  end if;

  v_title := btrim(coalesce(info ->> 'title', ''));
  if coalesce(info ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(info -> 'bytes') is distinct from 'number' or (info -> 'bytes')::numeric <= 0
     or jsonb_typeof(info -> 'width') is distinct from 'number'
     or jsonb_typeof(info -> 'height') is distinct from 'number'
     or char_length(v_title) not between 1 and 100 or v_title ~ '[[:cntrl:]]'
     or jsonb_typeof(info -> 'captions') is distinct from 'object'
     or octet_length((info -> 'captions')::text) > 8192 then
    raise exception 'invalid_clip_info' using errcode = '22023';
  end if;

  select * into m from public.videos where video_id = r.video_id;
  id8 := substr(replace(r.id::text, '-', ''), 1, 8);
  v_slug := left(r.slug, 40) || '-c' || id8 || '-' || lpad(k.ordinal::text, 2, '0');
  v_vid := 'run-' || substr(encode(sha256(convert_to(r.channel_id || E'\n' || v_slug, 'UTF8')), 'hex'), 1, 20);
  v_path := 'output/' || r.slug || '/repurpose/' || id8 || '/clip-' || lpad(k.ordinal::text, 2, '0') || '.mp4';

  insert into public.videos (
    video_id, channel_id, topic, title, slug, local_path, published_at, privacy,
    review_state, publish_state, held_at, hold_detail, video_format, parent_video_id)
  values (
    v_vid, r.channel_id, m.topic, v_title, v_slug, v_path, null, null,
    'pending', 'held', now(),
    jsonb_build_object('reason', 'repurposed_clip', 'master_video_id', r.video_id, 'request_id', r.id,
                       'position', k.ordinal, 'start_s', k.start_s, 'end_s', k.end_s,
                       'scene_ids', to_jsonb(k.scene_ids)),
    'short', r.video_id);

  update public.repurpose_clips
     set status = 'rendered', finished_at = now(), clip_video_id = v_vid, local_path = v_path,
         width = (info ->> 'width')::integer, height = (info ->> 'height')::integer,
         bytes = (info ->> 'bytes')::bigint, sha256 = info ->> 'sha256', captions = info -> 'captions'
   where id = k.id;
  return jsonb_build_object('position', k.ordinal, 'status', 'rendered', 'clip_video_id', v_vid,
                            'replayed', false);
end
$$;

-- The worker is done with the request: settle it (money and statuses).
create or replace function public.finish_repurpose_request(p_id uuid, p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.repurpose_requests;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.repurpose_requests where id = p_id;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if r.status in ('succeeded', 'partial', 'failed') then
    return public.repurpose_settle(p_id, null, null);
  end if;
  if r.status <> 'running' or r.worker_id is distinct from p_worker then
    raise exception 'not_claimed' using errcode = 'P0002';
  end if;
  return public.repurpose_settle(p_id, 'not_rendered',
    'This clip was not made, so it was not charged.');
end
$$;

-- A request the worker never finished (it died on the last attempt, or nothing
-- claimed it within a day) is settled: clips already made are charged, the rest
-- of the hold is released — never left "running" with credits held.
create or replace function public.expire_repurpose_requests() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.repurpose_requests;
  n integer := 0;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for r in
    select s.* from public.repurpose_requests s
     where s.status in ('queued', 'running')
       and (s.created_at < now() - interval '26 hours'
            or (s.status = 'running' and s.attempts >= 3 and s.heartbeat_at < now() - interval '15 minutes'))
     order by s.created_at
     for update skip locked
  loop
    perform public.repurpose_settle(r.id, 'job_ended',
      'The worker stopped before every clip was made; clips that were made are kept, the rest were not charged.');
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.repurpose_requests enable row level security;
alter table public.repurpose_clips enable row level security;
revoke all on public.repurpose_requests from public, anon, authenticated, service_role;
revoke all on public.repurpose_clips from public, anon, authenticated, service_role;
grant select on public.repurpose_requests to authenticated, service_role;
grant select on public.repurpose_clips to authenticated, service_role;

drop policy if exists repurpose_requests_select on public.repurpose_requests;
create policy repurpose_requests_select on public.repurpose_requests
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));
drop policy if exists repurpose_clips_select on public.repurpose_clips;
create policy repurpose_clips_select on public.repurpose_clips
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));

revoke all on function public.repurpose_requests_terms_frozen() from public, anon, authenticated, service_role;
revoke all on function public.repurpose_clips_terms_frozen() from public, anon, authenticated, service_role;
revoke all on function public.repurpose_no_delete() from public, anon, authenticated, service_role;
revoke all on function public.repurpose_plan(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.repurpose_master_state(public.videos) from public, anon, authenticated, service_role;
revoke all on function public.repurpose_price(integer) from public, anon, authenticated, service_role;
revoke all on function public.repurpose_settle(uuid, text, text) from public, anon, authenticated, service_role;

revoke all on function public.quote_repurpose(text, jsonb) from public, anon, service_role;
grant execute on function public.quote_repurpose(text, jsonb) to authenticated;
revoke all on function public.request_repurpose(text, jsonb, numeric, text) from public, anon, service_role;
grant execute on function public.request_repurpose(text, jsonb, numeric, text) to authenticated;

revoke all on function public.claim_repurpose_request(text) from public, anon, authenticated;
revoke all on function public.heartbeat_repurpose(uuid, text) from public, anon, authenticated;
revoke all on function public.record_repurpose_clip(uuid, text, integer, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.finish_repurpose_request(uuid, text) from public, anon, authenticated;
revoke all on function public.expire_repurpose_requests() from public, anon, authenticated;
grant execute on function public.claim_repurpose_request(text) to service_role;
grant execute on function public.heartbeat_repurpose(uuid, text) to service_role;
grant execute on function public.record_repurpose_clip(uuid, text, integer, boolean, jsonb) to service_role;
grant execute on function public.finish_repurpose_request(uuid, text) to service_role;
grant execute on function public.expire_repurpose_requests() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.repurpose_requests'::regclass, 'public.repurpose_clips'::regclass))
--     as rls_on,
--   not has_table_privilege('authenticated', 'public.repurpose_requests', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.repurpose_requests', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.repurpose_requests', 'DELETE')
--     and not has_table_privilege('authenticated', 'public.repurpose_clips', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.repurpose_clips', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.repurpose_clips', 'DELETE')
--     as browser_cannot_write,
--   not has_table_privilege('anon', 'public.repurpose_requests', 'SELECT')
--     and not has_table_privilege('anon', 'public.repurpose_clips', 'SELECT')
--     as anon_gets_nothing,
--   not has_function_privilege('authenticated', 'public.claim_repurpose_request(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.heartbeat_repurpose(uuid, text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.record_repurpose_clip(uuid, text, integer, boolean, jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.finish_repurpose_request(uuid, text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.expire_repurpose_requests()', 'EXECUTE')
--     as worker_functions_are_service_only,
--   not has_function_privilege('anon', 'public.request_repurpose(text, jsonb, numeric, text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.quote_repurpose(text, jsonb)', 'EXECUTE')
--     as anon_cannot_quote_or_press,
--   not exists (select 1 from public.credit_prices where unit = 'repurpose_clip' and credits_per_unit is null)
--     as no_price_invented,
--   (select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('quote_repurpose', 'request_repurpose', 'claim_repurpose_request',
--                         'heartbeat_repurpose', 'record_repurpose_clip', 'finish_repurpose_request',
--                         'expire_repurpose_requests', 'repurpose_plan', 'repurpose_master_state',
--                         'repurpose_price', 'repurpose_settle', 'repurpose_requests_terms_frozen',
--                         'repurpose_clips_terms_frozen', 'repurpose_no_delete'))
--     as search_path_pinned;
