-- 0029_publish_targets.sql — "Making this for:" and "Publish to platforms".
--
-- Two small additions on top of 0028 (connected Instagram / TikTok accounts):
--
-- 1. render_job_params_valid accepts one more OPTIONAL key, `publish_hint`:
--    which connected account the person on the Create page said the video is
--    for ("youtube:<channel_id>", "instagram:<account uuid>",
--    "tiktok:<account uuid>"). A hint only — the pipeline does not read it, and
--    it never publishes anything. The function is 0025's with that key and its
--    check added; nothing else changes.
--
-- 2. publish_requests — "Publish to platforms" on a finished video. The
--    browser inserts ONE ROW PER TICKED ACCOUNT and stops (CLAUDE.md #3: a
--    dashboard button writes a row; the worker acts). The queue worker
--    (tools/queue_worker.py → modules/social_publish.py) claims queued rows
--    with the service key, uploads with the platform adapter, and records the
--    result or the error on the row.
--
--    A target is EITHER a connected Instagram / TikTok account (account_id,
--    0028) OR one of the organization's YouTube channels (target_channel_id):
--    exactly one of the two, and the platform follows from it (youtube ⇔
--    target_channel_id).
--
--    The browser supplies only (video_id, account_id | target_channel_id).
--    Everything else is set by a BEFORE INSERT trigger from the database's own
--    rows: the target's organization and platform, the video's channel, who
--    asked, and — the point of it — whether the video may be cross-posted at
--    all. A video that has not passed the publish gate and its approvals is
--    recorded REFUSED with a reason word, never queued
--    (publish_request_refusal below):
--      not_uploaded          the run was held (gate block, auto-publish off,
--                            awaiting two-person approval, repaired cut) —
--                            it never passed the gate + approvals
--      gate_blocked          the latest gate verdict for the video is a block
--      not_approved          nobody approved the video (review_state pending)
--      rejected              a reviewer rejected it
--      awaiting_two_person   the channel requires a second admin's sign-off
--                            (require_two_person_publish) and no approved
--                            publish_approvals row names this video
--      account_not_connected the account is expired / errored / revoked; for
--                            a YouTube channel: the channel is not ACTIVE or
--                            has no connected token (publish_channel_connected
--                            — the same rule as lib/connectedAccounts.ts)
--      already_on_channel    the YouTube target is the video's OWN channel:
--                            the pipeline already uploaded it there, and this
--                            flow never changes an existing YouTube privacy
--    The worker checks the same functions again right before uploading.
--
--    A YouTube target gets a NEW upload of the master render on that channel,
--    always PRIVATE (privacy = 'private' on the row) — never public from here.
--    Its title, description and tags are built deterministically from the
--    video's own metadata, like the other platforms' captions.
--
--    Uploads cost the platforms nothing, so no credits are reserved or
--    charged (a YouTube upload spends the project's Data API quota; running
--    out is recorded as failed with reason quota_exceeded).
--
-- RLS: organization members read their organization's requests (viewer+);
-- editors+ insert (the trigger checks the role again, from the TARGET's
-- organization, and that the video belongs to that same organization); nobody
-- updates or deletes through the API — the worker's service role does.
--
-- REQUIRES 0016 (videos.publish_state), 0018 (organizations), 0022
-- (channel_token_refs), 0025 (render_job_params_valid with voice_id) and 0028
-- (social_accounts).
--
-- Additive and idempotent. Nothing existing is dropped.

do $$
begin
  if to_regclass('public.social_accounts') is null then
    raise exception '0029 needs 0028_social_accounts.sql: apply it first';
  end if;
  if to_regclass('public.channel_token_refs') is null then
    raise exception '0029 needs 0022_channel_tokens.sql: apply it first';
  end if;
  if to_regprocedure('public.accessible_org_ids(text)') is null then
    raise exception '0029 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'publish_state') then
    raise exception '0029 needs videos.publish_state: apply 0016_held_videos.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'review_state') then
    raise exception '0029 needs videos.review_state: apply 0004_review.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. render_job_params_valid — 0025's, plus the optional publish_hint
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','tts_model','voice_id','resume','repair_scenes',
                          'publish_hint'];
  has_repair boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(allowed)) then
      return false;
    end if;
  end loop;

  foreach k in array array['topic','niche','language','visual_style','repair_scenes'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'string' then
      return false;
    end if;
  end loop;
  if length(coalesce(p ->> 'topic', '')) > 300
     or length(coalesce(p ->> 'niche', '')) > 120
     or length(coalesce(p ->> 'language', '')) > 40
     or length(coalesce(p ->> 'visual_style', '')) > 300
     or length(coalesce(p ->> 'repair_scenes', '')) > 120 then
    return false;
  end if;

  if p ? 'duration' then
    if jsonb_typeof(p -> 'duration') <> 'number' then
      return false;
    end if;
    if (p ->> 'duration')::numeric <> trunc((p ->> 'duration')::numeric)
       or (p ->> 'duration')::numeric not between 30 and 3600 then
      return false;
    end if;
  end if;

  if p ? 'privacy' and (jsonb_typeof(p -> 'privacy') <> 'string'
                        or p ->> 'privacy' not in ('private', 'unlisted', 'public')) then
    return false;
  end if;
  if p ? 'video_provider' and (jsonb_typeof(p -> 'video_provider') <> 'string'
      or p ->> 'video_provider' not in ('minimax','higgsfield','kling','veo','seedance','wan')) then
    return false;
  end if;
  if p ? 'image_provider' and (jsonb_typeof(p -> 'image_provider') <> 'string'
      or p ->> 'image_provider' not in ('pexels','leonardo','gpt-image','nano-banana',
                                         'flux','ideogram','fal')) then
    return false;
  end if;
  if p ? 'tts_model' and (jsonb_typeof(p -> 'tts_model') <> 'string'
      or p ->> 'tts_model' not in ('eleven_v3','eleven_multilingual_v2',
                                   'eleven_flash_v2_5','eleven_turbo_v2_5')) then
    return false;
  end if;
  if p ? 'voice_id' and (jsonb_typeof(p -> 'voice_id') <> 'string'
      or p ->> 'voice_id' !~ '^[A-Za-z0-9]{20}$') then
    return false;
  end if;
  -- 0029: which account the video is for — a hint, never an instruction.
  if p ? 'publish_hint' and (jsonb_typeof(p -> 'publish_hint') <> 'string'
      or p ->> 'publish_hint' !~ '^(youtube|instagram|tiktok):[A-Za-z0-9._-]{1,128}$') then
    return false;
  end if;
  if p ? 'resume' and jsonb_typeof(p -> 'resume') <> 'boolean' then
    return false;
  end if;

  has_repair := length(btrim(coalesce(p ->> 'repair_scenes', ''))) > 0;
  if p_kind = 'repair' then
    return has_repair and coalesce((p ->> 'resume')::boolean, false) = false;
  end if;
  return not has_repair;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. publish_requests
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.publish_requests (
  id            bigserial primary key,
  org_id        uuid not null references public.organizations (id) on delete cascade,
  channel_id    text not null,
  video_id      text not null,
  -- Exactly one target: a connected Instagram / TikTok account, or one of
  -- the organization's YouTube channels.
  account_id    uuid references public.social_accounts (id) on delete cascade,
  target_channel_id text references public.channels (channel_id) on delete cascade,
  platform      text not null check (platform in ('instagram', 'tiktok', 'youtube')),
  status        text not null default 'queued'
                check (status in ('queued', 'uploading', 'processing', 'published', 'failed', 'refused')),
  -- A reason WORD (refusals and failures), e.g. not_approved, too_long.
  reason        text check (reason is null or reason ~ '^[a-z0-9_]{1,64}$'),
  -- Worker-written detail: our own words, an HTTP status, a platform error
  -- code. Never a token or a response body.
  error         text check (error is null or char_length(error) <= 500),
  result_id     text check (result_id is null or char_length(result_id) <= 200),
  result_url    text check (result_url is null or (result_url ~ '^https://' and char_length(result_url) <= 2048)),
  -- The caption actually sent (for YouTube: title, description and tags)
  -- and the privacy used (TikTok SELF_ONLY, YouTube private).
  caption       text check (caption is null or char_length(caption) <= 6000),
  privacy       text check (privacy is null or char_length(privacy) <= 40),
  attempts      integer not null default 0,
  worker_id     text,
  heartbeat_at  timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  requested_by  uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint publish_requests_one_target check (
    (account_id is null) <> (target_channel_id is null)
    and (platform = 'youtube') = (target_channel_id is not null)
  )
);

create index if not exists publish_requests_video_idx on public.publish_requests (video_id, created_at desc);
create index if not exists publish_requests_queue_idx on public.publish_requests (status, id) where status = 'queued';
-- One live request per video and target: a double click cannot post twice.
create unique index if not exists publish_requests_one_live
  on public.publish_requests (video_id, account_id)
  where status in ('queued', 'uploading', 'processing') and account_id is not null;
create unique index if not exists publish_requests_one_live_channel
  on public.publish_requests (video_id, target_channel_id)
  where status in ('queued', 'uploading', 'processing') and target_channel_id is not null;

comment on table public.publish_requests is
  'Cross-posting a finished video to a connected Instagram / TikTok account or another of the organization''s YouTube channels (uploaded private). The browser inserts (video_id, account_id | target_channel_id) only; a trigger fills the rest and refuses a video that has not passed the publish gate and approvals. The queue worker (service role) uploads and records the result (migration 0029).';

-- Why a video may NOT be cross-posted, or null when it may. The one rule, used
-- by the insert trigger and by the worker right before it uploads.
create or replace function public.publish_request_refusal(p_video_id text) returns text
  language plpgsql stable security definer set search_path = '' as $$
declare
  v record;
  gate text;
  two_person boolean;
begin
  select vv.video_id, vv.channel_id, vv.slug, vv.topic, vv.published_at, vv.publish_state, vv.review_state
    into v from public.videos vv where vv.video_id = p_video_id;
  if v.video_id is null then
    return 'video_not_found';
  end if;
  -- A held run never uploaded: the gate blocked it, or it is waiting for a
  -- human (auto-publish off), a second admin, or a review of a repaired cut.
  if v.published_at is null or coalesce(v.publish_state, 'uploaded') <> 'uploaded' then
    return 'not_uploaded';
  end if;
  select e.event into gate from public.system_events e
   where e.video_id = v.video_id and e.event in ('publish.blocked', 'publish.allowed')
   order by e.ts desc limit 1;
  if gate = 'publish.blocked' then
    return 'gate_blocked';
  end if;
  if v.review_state = 'rejected' then
    return 'rejected';
  end if;
  if coalesce(v.review_state, '') <> 'approved' then
    return 'not_approved';
  end if;
  select coalesce(c.agent_config ->> 'require_two_person_publish', '') = 'true' into two_person
    from public.channels c where c.channel_id = v.channel_id;
  if coalesce(two_person, false) and not exists (
    select 1 from public.publish_approvals a
     where a.channel_id = v.channel_id
       and a.status = 'approved'
       and a.decided_by is not null
       and a.decided_by is distinct from a.requested_by
       and lower(btrim(coalesce(a.video_ref, ''))) <> ''
       and lower(btrim(a.video_ref)) in (lower(coalesce(v.slug, '')), lower(coalesce(v.topic, '')))
  ) then
    return 'awaiting_two_person';
  end if;
  return null;
end
$$;

-- Whether a YouTube channel has a usable token right now — the rule
-- lib/connectedAccounts.ts (youtubeAccounts) shows in the account panel: a
-- customer channel's Vault reference (0022) decides while it has one (live =
-- connected, revoked = not); otherwise the credential health the bot writes
-- for the operator's GitHub-secret channels (channel_credentials).
create or replace function public.publish_channel_connected(p_channel_id text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select r.vault_secret_id is not null and r.revoked_at is null
       from public.channel_token_refs r where r.channel_id = p_channel_id),
    (select cc.status = 'connected'
       from public.channel_credentials cc
      where cc.channel_id = p_channel_id and cc.provider = 'youtube'),
    false)
$$;

create or replace function public.publish_requests_before_insert() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  acc public.social_accounts;
  tgt_id text;
  tgt_status text;
  target_org uuid;
  ch_org uuid;
  ch_id text;
  refusal text;
begin
  -- The worker (service role) never inserts; a browser always goes through here.
  if (new.account_id is null) = (new.target_channel_id is null) then
    raise exception 'name exactly one target: a connected account or a YouTube channel'
      using errcode = '22023';
  end if;
  if new.account_id is not null then
    select * into acc from public.social_accounts a where a.id = new.account_id;
    if acc.id is null or auth.uid() is null or not public.is_org_member(acc.org_id, 'editor') then
      raise exception 'only an owner, admin or editor of the account''s organization may publish to it'
        using errcode = '42501';
    end if;
    target_org := acc.org_id;
  else
    select c.channel_id, c.org_id, c.status into tgt_id, target_org, tgt_status
      from public.channels c where c.channel_id = new.target_channel_id;
    if tgt_id is null or target_org is null or auth.uid() is null
       or not public.is_org_member(target_org, 'editor') then
      raise exception 'only an owner, admin or editor of the channel''s organization may publish to it'
        using errcode = '42501';
    end if;
  end if;
  select c.org_id, c.channel_id into ch_org, ch_id
    from public.videos v join public.channels c on c.channel_id = v.channel_id
   where v.video_id = new.video_id;
  -- The video must belong to the SAME organization as the target: nobody
  -- posts another tenant's video, or to another tenant's account or channel.
  if ch_id is null or ch_org is distinct from target_org then
    raise exception 'that video is not in this organization' using errcode = '42501';
  end if;

  new.org_id       := target_org;
  new.platform     := case when new.account_id is not null then acc.platform else 'youtube' end;
  new.channel_id   := ch_id;
  new.requested_by := auth.uid();
  new.status       := 'queued';
  new.reason       := null;
  new.error        := null;
  new.result_id    := null;
  new.result_url   := null;
  new.caption      := null;
  new.privacy      := null;
  new.attempts     := 0;
  new.worker_id    := null;
  new.heartbeat_at := null;
  new.started_at   := null;
  new.finished_at  := null;
  new.created_at   := now();
  new.updated_at   := now();

  if new.account_id is not null then
    if acc.status <> 'connected' then
      refusal := 'account_not_connected';
    end if;
  elsif new.target_channel_id = ch_id then
    -- Already there: the pipeline uploaded it to its own channel, with the
    -- privacy that channel's rules gave it. Nothing here changes that.
    refusal := 'already_on_channel';
  elsif upper(btrim(coalesce(tgt_status, ''))) <> 'ACTIVE'
        or not public.publish_channel_connected(new.target_channel_id) then
    refusal := 'account_not_connected';
  end if;
  if refusal is null then
    refusal := public.publish_request_refusal(new.video_id);
  end if;
  if refusal is not null then
    new.status := 'refused';
    new.reason := refusal;
    new.finished_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists publish_requests_before_insert on public.publish_requests;
create trigger publish_requests_before_insert
  before insert on public.publish_requests
  for each row execute function public.publish_requests_before_insert();

-- The worker's claim: the oldest queued request, locked, marked uploading.
create or replace function public.claim_publish_request(p_worker text)
  returns setof public.publish_requests
  language plpgsql volatile security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') <> '' then
    raise exception 'publish requests are claimed by the platform''s worker only' using errcode = '42501';
  end if;
  -- A request whose worker died mid-upload is NOT retried (the platform may
  -- already have the post): it is failed with a reason the panel shows, and
  -- the person can send again after checking the account.
  update public.publish_requests r
     set status = 'failed', reason = 'interrupted', finished_at = now(), updated_at = now(),
         error = 'the worker stopped during the upload; check the account before sending again'
   where r.status in ('uploading', 'processing')
     and coalesce(r.heartbeat_at, r.started_at, r.created_at) < now() - interval '30 minutes';

  return query
    update public.publish_requests r
       set status = 'uploading', worker_id = left(p_worker, 120), started_at = now(),
           heartbeat_at = now(), attempts = r.attempts + 1, updated_at = now()
     where r.id = (select q.id from public.publish_requests q
                    where q.status = 'queued'
                    order by q.id
                    for update skip locked
                    limit 1)
    returning r.*;
end
$$;

-- Instagram fetches the video from a public URL (it has no upload endpoint):
-- the worker copies the master here, hands Instagram a short-lived signed URL,
-- and deletes the object when the container is done. Private, and no policy
-- for any API role: only the worker's service key reads or writes it. No
-- per-bucket size limit, so the project's own upload limit applies (Storage
-- settings) — the worker reports a refusal as a clear failure.
insert into storage.buckets (id, name, public)
values ('publish-staging', 'publish-staging', false)
on conflict (id) do nothing;

-- RLS
alter table public.publish_requests enable row level security;
revoke all on public.publish_requests from public, anon, authenticated;
grant select on public.publish_requests to authenticated;
-- Column-level: a browser may name the video and ONE target, nothing else.
grant insert (video_id, account_id, target_channel_id) on public.publish_requests to authenticated;
grant usage on sequence public.publish_requests_id_seq to authenticated;
grant select, insert, update, delete on public.publish_requests to service_role;
grant usage on sequence public.publish_requests_id_seq to service_role;

drop policy if exists publish_requests_select on public.publish_requests;
create policy publish_requests_select on public.publish_requests
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists publish_requests_insert on public.publish_requests;
create policy publish_requests_insert on public.publish_requests
  for insert to authenticated
  with check (
    org_id in (select public.accessible_org_ids('editor'))
    and requested_by = auth.uid()
    and status in ('queued', 'refused')
    and worker_id is null
    and result_url is null
  );

revoke all on function public.publish_request_refusal(text) from public, anon, authenticated, service_role;
revoke all on function public.publish_channel_connected(text) from public, anon, authenticated, service_role;
revoke all on function public.publish_requests_before_insert() from public, anon, authenticated, service_role;
revoke all on function public.claim_publish_request(text) from public, anon, authenticated, service_role;
grant execute on function public.publish_request_refusal(text) to service_role;
grant execute on function public.publish_channel_connected(text) to service_role;
grant execute on function public.claim_publish_request(text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.publish_requests'::regclass) as rls_on,
--   not has_table_privilege('authenticated', 'public.publish_requests', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.publish_requests', 'DELETE') as browser_cannot_change,
--   has_column_privilege('authenticated', 'public.publish_requests', 'video_id', 'INSERT')
--     and has_column_privilege('authenticated', 'public.publish_requests', 'target_channel_id', 'INSERT')
--     and not has_column_privilege('authenticated', 'public.publish_requests', 'status', 'INSERT')
--     and not has_column_privilege('authenticated', 'public.publish_requests', 'privacy', 'INSERT') as insert_is_target_only,
--   not has_function_privilege('authenticated', 'public.claim_publish_request(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.publish_channel_connected(text)', 'EXECUTE') as worker_only,
--   (select count(*) = 2 from pg_indexes where schemaname = 'public'
--      and indexname in ('publish_requests_one_live', 'publish_requests_one_live_channel')) as one_live_per_target,
--   exists (select 1 from pg_constraint where conname = 'publish_requests_one_target') as one_target_check,
--   public.render_job_params_valid('{"publish_hint":"tiktok:3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90"}', 'daily') as hint_ok,
--   not public.render_job_params_valid('{"publish_hint":"myspace:x"}', 'daily') as bad_hint_refused;
