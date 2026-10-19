-- 0113_visibility_requests.sql — Phase 1b of the approve-and-publish design: the DATABASE half of "a worker may make an
-- already-approved, already-uploaded PRIVATE YouTube video public, ONLY on a channel whose administrators switched that on".
-- NOTHING IN THIS FILE TOUCHES YOUTUBE and nothing here makes a video public. It adds the per-channel switch (default OFF),
-- the worker's queue (one row per approval act), the day's quota ledger, and the hook that queues a request only when the
-- switch is on. Every channel keeps its behaviour on the day this is applied: the switch is false everywhere until an
-- administrator turns it on, and the worker that reads the queue (tools/queue_worker.py, modules/visibility_publish.py) is
-- itself off unless NIGHTSHIFT_VISIBILITY_PUBLISH=on.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it
-- *** automatically, and an applied migration is never edited: fix by a new forward
-- *** migration (docs/MIGRATIONS.md).
--
-- WHAT IT ADDS
--  1. channels.publish_on_approve boolean not null default false     the switch. Written ONLY by
--       set_channel_publish_on_approve(), which an administrator of the channel's organization (a real member of it, as for
--       approving) calls; it audits the change. No browser UPDATE: the browser roles' column grants (0086) do not name the
--       column and stay as they are, and a trigger refuses the API roles (anon, authenticated and the SERVICE KEY) a write
--       outside that function. Turning it off at once refuses the channel's queued requests (not_enabled) EXCEPT one whose
--       write may already be on its way (submitting_at set): that one stays, and the worker records what YouTube reports.
--       A channel moved to another organization comes out switched off (the same trigger).
--  2. video_visibility_requests   one row per approval act: unique (video_id, approved_cut_sha256, decided_at), so a replay
--       never queues twice. status is closed: queued | applied | refused | failed | expired. reason is a closed WORD
--       (visibility_reason_words()), never a provider's text. 'applied' is only possible with after_privacy = 'public', which
--       the worker records from a read-back of YouTube after its call, never from the call's own answer (a CHECK and a trigger
--       keep it so). A finished row is final, except that a person may re-queue a FAILED one (retry_video_visibility) while
--       the approval still holds, at most twice over a request's lifetime (lifetime_attempts, six claims in all). Members read their organization's channels' rows (RLS, columns without worker internals);
--       NOBODY writes it from an API role, the service key included: every write is one of the functions below.
--  3. youtube_quota_ledger        the YouTube units this feature spent, per Pacific-time day (YouTube's quota day), project and
--       organization, with two ceilings the worker passes (youtube_quota_take): the whole day's, and one organization's share of
--       it, so a single tenant cannot use the day up. The claim hands requests out organization by organization (the one served
--       longest ago first). videos.update costs 50 units.
--  4. approve_video_publish()     0112's body verbatim plus ONE block after its audit write: when the channel's switch is on it
--       queues one request for that approval act and writes one 'video.publish_queued' audit row, and the answer gains
--       queued/request_id. With the switch off the function is byte-identical in effect to 0112 (same writes, same answer).
--  5. the worker's functions, SERVICE KEY ONLY: claim_visibility_request (lease, backoff, three attempts, expiry sweep),
--       visibility_request_refusal (the request-level re-check: switch, same approval act, expiry, channel connected),
--       mark_visibility_submitting (the LAST check and the marker "the write may be sent", in one transaction under row locks:
--       the channel row FOR SHARE, the request FOR UPDATE, the video FOR SHARE; it returns 'ok' or the closed word that says no),
--       finish_visibility_request (the only writer of a result; mirrors videos.privacy from the read-back only; accepts a
--       request whose write was marked even if the switch was turned off meanwhile), youtube_quota_take. The video-level
--       re-check is 0112's video_publish_refusal(video_id, cut_sha256), which the worker calls with the cut hash recorded at
--       approval, early (a cheap filter) and again inside mark_visibility_submitting (the one that counts).
--  6. retry_video_visibility()    an administrator re-queues a FAILED request (token reconnected, quota back) while the same
--       approval still holds; never a refused, applied or expired one, never a different approval.
--  7. audit_action_allowed()      0112's list verbatim plus channel.publish_on_approve, video.publish_queued,
--       video.visibility_applied, video.visibility_refused, video.visibility_failed, video.visibility_expired,
--       video.visibility_retry.
--
-- WHAT IT DOES NOT DO. It does not change publish_request_refusal, the gate, channels.auto_publish, any upload path or any
-- existing row. It does not make the worker run. A request that nobody carries out stays 'queued' until its approval ends
-- and then becomes 'expired'; the panel shows that as waiting, never as published.
--
-- Additive and idempotent: add column if not exists, create table if not exists, guarded constraint adds, create or replace
-- (bodies copied from the latest migration that defines each), drop trigger/policy then create, revoke then grant.
-- Rollback: docs/sql/rollback_0113_visibility_requests.sql.
-- REQUIRES 0112 (approve_video_publish, video_publish_refusal, video_approve_access, video_real_member), 0086 (channels column
-- grants), 0087 (take_web_rate, the audit stamp), 0022 (channel_token_refs), 0018 (channel_org, accessible_channel_ids).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.channels') is null or to_regclass('public.videos') is null
     or to_regclass('public.review_intents') is null or to_regclass('public.app_audit_log') is null then
    raise exception '0113 needs channels, videos, review_intents and app_audit_log: apply 0004 and 0008 first';
  end if;
  if to_regprocedure('public.approve_video_publish(text, text, jsonb)') is null
     or to_regprocedure('public.video_publish_refusal(text, text)') is null
     or to_regprocedure('public.video_approve_access(text)') is null
     or to_regprocedure('public.video_real_member(uuid, text)') is null then
    raise exception '0113 needs 0112_approve_video_publish.sql (approve_video_publish, video_publish_refusal): apply it first';
  end if;
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null
     or to_regprocedure('public.audit_action_allowed(text)') is null then
    raise exception '0113 needs 0087_audit_and_rate_hardening.sql (take_web_rate, audit_action_allowed): apply it first';
  end if;
  if to_regclass('public.channel_token_refs') is null or to_regclass('public.channel_credentials') is null then
    raise exception '0113 needs 0022_channel_tokens.sql (channel_token_refs, channel_credentials): apply it first';
  end if;
  if to_regprocedure('public.is_org_member(uuid, text)') is null or to_regprocedure('public.channel_org(text)') is null
     or to_regprocedure('public.accessible_channel_ids(text)') is null or to_regprocedure('public.is_platform_admin()') is null
     or to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0113 needs 0018_organizations.sql and 0020_credits.sql (is_org_member, channel_org, credits_trusted_caller): apply them first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The per-channel switch (default OFF) and the only way to change it
-- ───────────────────────────────────────────────────────────────────────────

alter table public.channels add column if not exists publish_on_approve boolean not null default false;

comment on column public.channels.publish_on_approve is
  'Publish when approved (migration 0113). OFF by default. When on, approving an exact cut of an uploaded video on this channel queues one request that a worker carries out: it re-checks everything, asks YouTube to make the video public, reads the privacy back and records what YouTube reports. Written only by set_channel_publish_on_approve(); never by a browser UPDATE and never by the service key.';

-- The API roles may not write the switch except through the function below (which runs as its owner, so current_user inside it
-- is not an API role: the way 0086 tells its own functions from the browser, here extended to the service key, which holds every
-- table privilege and must not be able to flip it). Security invoker on purpose: current_user is the caller's.
create or replace function public.channels_publish_switch_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  -- A channel that moves to another organization leaves its switch behind: the new organization's administrators have not
  -- chosen it. Whoever moves it (the move itself is guarded by 0018), the switch comes out off.
  if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then
    new.publish_on_approve := false;
    return new;
  end if;
  if current_user not in ('anon', 'authenticated', 'service_role') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.publish_on_approve is distinct from false then
      raise exception 'publish_on_approve is changed through set_channel_publish_on_approve() only'
        using errcode = '42501';
    end if;
  elsif new.publish_on_approve is distinct from old.publish_on_approve then
    raise exception 'publish_on_approve is changed through set_channel_publish_on_approve() only'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists channels_publish_switch_guard on public.channels;
create trigger channels_publish_switch_guard
  before insert or update of publish_on_approve, org_id on public.channels
  for each row execute function public.channels_publish_switch_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The closed vocabulary, the queue, its guard
-- ───────────────────────────────────────────────────────────────────────────

-- One list of the words a request may end with (the table's CHECK and the finishing function use it; the panel has a sentence
-- for each, in three languages: command-center/lib/visibilityRequest.ts).
create or replace function public.visibility_reason_words() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array[
    -- what 0112's video_publish_refusal answers
    'video_not_found', 'not_uploaded', 'gate_blocked', 'gate_unknown', 'rejected', 'already_public', 'no_preview',
    'cut_unknown', 'cut_changed', 'not_approved', 'approval_expired',
    -- the request-level re-check
    'not_enabled', 'approval_superseded', 'channel_not_connected',
    -- YouTube and the token
    'scope_missing', 'token_expired', 'quota_exceeded', 'rate_limited', 'video_not_found_on_youtube', 'channel_mismatch',
    'still_processing', 'rejected_by_youtube', 'privacy_changed', 'platform_refused', 'platform_kept_private',
    'platform_error', 'readback_failed', 'status_unreadable',
    -- ours
    'interrupted', 'worker_error'
  ]::text[]
$$;

create table if not exists public.video_visibility_requests (
  id                  bigint generated always as identity primary key,
  org_id              uuid not null,
  channel_id          text not null,
  video_id            text not null check (video_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  intent_id           bigint,
  approved_cut_sha256 text not null check (approved_cut_sha256 ~ '^[0-9a-f]{64}$'),
  decided_by          uuid,
  decided_at          timestamptz not null,
  expires_at          timestamptz not null,
  status              text not null default 'queued' check (status in ('queued', 'applied', 'refused', 'failed', 'expired')),
  reason              text,
  attempts            integer not null default 0 check (attempts between 0 and 10),
  -- every claim ever made of this request: "try again" resets attempts, never this. Six in all (two rounds of three).
  lifetime_attempts   integer not null default 0 check (lifetime_attempts between 0 and 10),
  next_attempt_at     timestamptz not null default now(),
  claimed_by          text check (claimed_by is null or claimed_by ~ '^[A-Za-z0-9._:-]{1,80}$'),
  claimed_at          timestamptz,
  lease_until         timestamptz,
  submitting_at       timestamptz,
  before_privacy      text check (before_privacy is null or before_privacy in ('private', 'unlisted', 'public')),
  after_privacy       text check (after_privacy is null or after_privacy in ('private', 'unlisted', 'public')),
  quota_units         integer not null default 0 check (quota_units >= 0),
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint video_visibility_requests_one_per_act unique (video_id, approved_cut_sha256, decided_at),
  -- a closed word, never a provider's text
  constraint video_visibility_requests_reason_word check (reason is null or reason = any (public.visibility_reason_words())),
  -- finished exactly when it is no longer queued
  constraint video_visibility_requests_finished check ((status = 'queued') = (finished_at is null)),
  -- the truth rule: 'applied' needs a read-back that said public, and carries no failure word; the other ends carry one
  constraint video_visibility_requests_applied_is_public check (status <> 'applied' or (after_privacy = 'public' and reason is null)),
  constraint video_visibility_requests_ended_has_reason check (status in ('queued', 'applied') or reason is not null)
);

comment on table public.video_visibility_requests is
  'Publish when approved (migration 0113): one row per approval act on a channel whose switch was on. Written only by the database functions (approve_video_publish queues it, the worker''s claim/finish functions end it, retry_video_visibility re-queues a failed one). applied means a read-back of YouTube said public. No provider text is ever stored here.';

create index if not exists video_visibility_requests_claim_idx
  on public.video_visibility_requests (next_attempt_at, id) where status = 'queued';
create index if not exists video_visibility_requests_org_served_idx
  on public.video_visibility_requests (org_id, claimed_at desc);
create index if not exists video_visibility_requests_video_idx
  on public.video_visibility_requests (video_id, created_at desc);
create index if not exists video_visibility_requests_channel_idx
  on public.video_visibility_requests (channel_id, created_at desc);

-- Defence in depth behind "no API role writes this table": a row is never deleted, never re-pointed, and an ended row is final
-- (applied, refused and expired stay as they are; a failed one may only go back to queued, which retry_video_visibility does).
create or replace function public.video_visibility_requests_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a visibility request is never deleted' using errcode = '42501';
  end if;
  if new.org_id is distinct from old.org_id or new.channel_id is distinct from old.channel_id
     or new.video_id is distinct from old.video_id or new.intent_id is distinct from old.intent_id
     or new.approved_cut_sha256 is distinct from old.approved_cut_sha256 or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'a visibility request is never re-pointed' using errcode = '42501';
  end if;
  if old.status in ('applied', 'refused', 'expired') and (new.status, new.reason, new.after_privacy, new.finished_at)
       is distinct from (old.status, old.reason, old.after_privacy, old.finished_at) then
    raise exception 'a finished visibility request is final' using errcode = '42501';
  end if;
  if old.status = 'failed' and new.status not in ('failed', 'queued') then
    raise exception 'a failed visibility request may only be re-queued' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists video_visibility_requests_guard on public.video_visibility_requests;
create trigger video_visibility_requests_guard
  before update or delete on public.video_visibility_requests
  for each row execute function public.video_visibility_requests_guard();

-- The YouTube units this feature spent, per Pacific-time day (YouTube's quota day resets at midnight Pacific), project and
-- organization. The row with the all-zero org_id is the project's whole day; the others are one organization's share of it.
create table if not exists public.youtube_quota_ledger (
  day         date not null,
  project     text not null check (project ~ '^[a-z0-9._-]{1,64}$'),
  source      text not null check (source in ('visibility')),
  org_id      uuid not null,
  units       integer not null default 0 check (units >= 0),
  updated_at  timestamptz not null default now(),
  primary key (day, project, source, org_id)
);

comment on table public.youtube_quota_ledger is
  'Publish when approved (migration 0113): YouTube quota units this feature spent, per Pacific-time day, Google Cloud project and organization (the all-zero org_id row is the whole day). Written only by youtube_quota_take(); read by a platform admin.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The switch: the one place it is written
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_channel_publish_on_approve(p_channel_id text, p_on boolean) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  org     uuid;
  was     boolean;
  v_known boolean;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_channel_id is null or p_channel_id !~ '^[A-Za-z0-9_-]{1,64}$' or p_on is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The organization comes from the CHANNEL row. A caller who cannot see the channel gets the answer a missing one gets.
  select c.org_id, c.publish_on_approve, true into org, was, v_known
    from public.channels c where c.channel_id = p_channel_id for update;
  if v_known is not true or org is null or not public.is_org_member(org) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Public speech under a customer's name is that customer's team's: a platform admin must be a real member of the organization
  -- (in the operator's own organization any platform owner/admin may), the rule approving a video follows.
  if not public.video_real_member(org, 'admin') then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'the switch is set by a member of the channel''s organization';
  end if;
  if not public.take_web_rate('publish_switch', 30, 600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if was is distinct from p_on then
    update public.channels set publish_on_approve = p_on, updated_at = now() where channel_id = p_channel_id;
    insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
    values (uid, 'channel.publish_on_approve', p_channel_id,
            jsonb_build_object('channel_id', p_channel_id, 'from', coalesce(was, false), 'to', p_on), p_channel_id);
    -- Off means off now: what is waiting is refused here, and the worker asks again before it acts anyway. NOT a request whose
    -- write was marked (submitting_at set): the write may be on its way or have landed, and refusing it would leave the database
    -- saying "not published" about a video that is public. That one stays queued; the worker (or the next claim, which reads
    -- YouTube first) records what YouTube reports. The channel row is locked FOR UPDATE above, and mark_visibility_submitting
    -- takes it FOR SHARE, so a request is either marked before this statement or refused by it, never both.
    if p_on is false then
      update public.video_visibility_requests
         set status = 'refused', reason = 'not_enabled', finished_at = now(), updated_at = now(),
             claimed_by = null, lease_until = null
       where channel_id = p_channel_id and status = 'queued' and submitting_at is null;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'channel_id', p_channel_id, 'publish_on_approve', p_on,
                            'changed', was is distinct from p_on);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. THE approval, 0112's body verbatim plus one block
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.approve_video_publish(p_video_id text, p_cut_sha256 text, p_ack jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  v      public.videos;
  access text;
  why    text;
  v_exp  timestamptz := now() + interval '24 hours';
  v_mail text;
  i      public.review_intents;
  v_switch boolean;   -- 0113
  v_req    bigint;    -- 0113
  v_out    jsonb;     -- 0113
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_video_id is null or p_video_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The channel, and with it the organization, come from the VIDEO row. A caller who cannot see the video gets the answer a
  -- missing one gets; a member who is not an administrator, or a platform admin who is not a real member of a customer's
  -- organization, is refused.
  access := public.video_approve_access(p_video_id);
  if access = 'not_found' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if access = 'not_member' then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'a video is approved by a member of the channel''s organization';
  end if;
  if access <> 'ok' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.take_web_rate('video_approve', 20, 600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if p_cut_sha256 is null or p_cut_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_hash');
  end if;
  if jsonb_typeof(p_ack) is distinct from 'object' or (p_ack -> 'rights_and_labels') is distinct from 'true'::jsonb then
    return jsonb_build_object('ok', false, 'error', 'ack_required');
  end if;

  -- Locked only once the caller is known to be allowed; the decision below is read under the lock.
  select * into v from public.videos where video_id = p_video_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Replay: the same cut, approved and not yet expired. Nothing is written twice.
  if v.review_state = 'approved' and v.approved_cut_sha256 is not distinct from p_cut_sha256
     and v.cut_sha256 is not distinct from p_cut_sha256 and v.approval_expires_at > now() then
    return jsonb_build_object('ok', true, 'already', true, 'video_id', v.video_id, 'cut_sha256', p_cut_sha256,
                              'decided_at', v.decided_at, 'expires_at', v.approval_expires_at);
  end if;

  why := public.video_approve_refusal(p_video_id, p_cut_sha256);
  if why is not null then
    return jsonb_build_object('ok', false, 'error', why);
  end if;
  -- Approved with no person behind it: the channel publishes on its own (video_review.record writes 'approved' when
  -- auto publish is on). There is nothing to record, and a human approval must not be forged over it.
  if v.review_state = 'approved' and v.approved_cut_sha256 is null then
    return jsonb_build_object('ok', false, 'error', 'already_approved');
  end if;

  v_mail := public.my_confirmed_email();
  update public.videos
     set review_state = 'approved', approved_cut_sha256 = p_cut_sha256, decided_by = uid, decided_by_email = v_mail,
         decided_at = now(), approval_expires_at = v_exp
   where video_id = v.video_id;
  -- The stuck rows of the old button (filed, never read) are closed; the new approval is the decision of record.
  update public.review_intents set consumed_at = now(), outcome = 'superseded_by_approval'
   where video_id = v.video_id and action = 'approve' and consumed_at is null;
  insert into public.review_intents (channel_id, video_id, action, created_by, approved_cut_sha256, consumed_at, outcome)
  values (v.channel_id, v.video_id, 'approve', uid, p_cut_sha256, now(), 'recorded')
  returning * into i;
  insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
  values (uid, 'video.approve', v.video_id,
          jsonb_build_object('video_id', v.video_id, 'cut_sha256', p_cut_sha256, 'gate_allowed', true,
                             'rights_and_labels', true, 'expires_at', v_exp, 'intent_id', i.id),
          v.channel_id);

  -- 0113: on a channel whose "publish when approved" switch is ON, this approval act is queued for the worker, once (the key is
  -- the act: video, cut and the decision's own time). With the switch off nothing below runs and the answer is 0112's.
  select c.publish_on_approve into v_switch from public.channels c where c.channel_id = v.channel_id;
  if v_switch is true then
    insert into public.video_visibility_requests
      (org_id, channel_id, video_id, intent_id, approved_cut_sha256, decided_by, decided_at, expires_at)
    values (public.channel_org(v.channel_id), v.channel_id, v.video_id, i.id, p_cut_sha256, uid, now(), v_exp)
    on conflict (video_id, approved_cut_sha256, decided_at) do nothing
    returning id into v_req;
    if v_req is not null then
      insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
      values (uid, 'video.publish_queued', v.video_id,
              jsonb_build_object('video_id', v.video_id, 'cut_sha256', p_cut_sha256, 'request_id', v_req, 'expires_at', v_exp),
              v.channel_id);
    end if;
  end if;
  v_out := jsonb_build_object('ok', true, 'already', false, 'video_id', v.video_id, 'cut_sha256', p_cut_sha256,
                              'decided_at', now(), 'expires_at', v_exp, 'intent_id', i.id);
  if v_req is not null then
    v_out := v_out || jsonb_build_object('queued', true, 'request_id', v_req);
  end if;
  return v_out;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The worker's functions (the service key only)
-- ───────────────────────────────────────────────────────────────────────────

-- Is the channel connected to YouTube (a live Vault connection, else a connected credential row)? The rule of
-- publish_channel_connected (0029) under its own name, because a database built from 0029 as first merged lacks that function
-- (it arrived by a later edit: tests/test_migration_prerequisites.py).
create or replace function public.visibility_channel_connected(p_channel_id text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select r.vault_secret_id is not null and r.revoked_at is null
       from public.channel_token_refs r where r.channel_id = p_channel_id),
    (select cc.status = 'connected'
       from public.channel_credentials cc
      where cc.channel_id = p_channel_id and cc.provider = 'youtube'),
    false)
$$;

-- The request-level re-check, asked again right before anything is sent (the video-level one is video_publish_refusal).
-- A closed word, or NULL when this request may be acted on now.
create or replace function public.visibility_request_refusal(p_request_id bigint) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r  public.video_visibility_requests;
  v  public.videos;
  ch public.channels;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may ask this' using errcode = '42501';
  end if;
  select * into r from public.video_visibility_requests where id = p_request_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into ch from public.channels where channel_id = r.channel_id;
  -- A channel that moved to another organization since the request was queued is not the channel it was queued for (its switch
  -- was reset by the move as well).
  if not found or ch.publish_on_approve is not true or ch.org_id is distinct from r.org_id then
    return 'not_enabled';
  end if;
  select * into v from public.videos where video_id = r.video_id and channel_id = r.channel_id;
  -- The approval this request was queued for must still be THE approval: a repaired cut clears it, a new one has its own request.
  if not found or v.decided_at is distinct from r.decided_at or v.approved_cut_sha256 is distinct from r.approved_cut_sha256 then
    return 'approval_superseded';
  end if;
  if r.expires_at <= now() then
    return 'approval_expired';
  end if;
  if upper(coalesce(ch.status, '')) <> 'ACTIVE' or not public.visibility_channel_connected(r.channel_id) then
    return 'channel_not_connected';
  end if;
  return null;
end
$$;

-- The next request to act on, leased to this worker. Waits for its backoff, is taken again after a lease runs out (the worker
-- died), and ends after three claims (six over its lifetime, counting the rounds "try again" starts). Requests whose approval has
-- run out are ended here, as expired, never acted on, EXCEPT one whose write was marked (submitting_at set): that one is handed
-- out again so the worker reads YouTube and records the truth, whatever the clock says.
-- Fair between organizations: the organization served longest ago goes first (never served: first of all), so one tenant's
-- pile of requests cannot keep the others waiting behind it.
create or replace function public.claim_visibility_request(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.video_visibility_requests;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may claim a visibility request' using errcode = '42501';
  end if;
  if coalesce(p_worker, '') !~ '^[A-Za-z0-9._:-]{1,80}$' then
    raise exception 'invalid worker' using errcode = '22023';
  end if;
  for r in
    select * from public.video_visibility_requests
     where status = 'queued' and expires_at <= now() and submitting_at is null order by id for update skip locked
  loop
    update public.video_visibility_requests
       set status = 'expired', reason = 'approval_expired', finished_at = now(), updated_at = now(),
           claimed_by = null, lease_until = null
     where id = r.id;
    insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
    values (null, 'video.visibility_expired', r.video_id,
            jsonb_build_object('request_id', r.id, 'video_id', r.video_id, 'cut_sha256', r.approved_cut_sha256,
                               'status', 'expired', 'reason', 'approval_expired', 'attempts', r.attempts),
            r.channel_id);
  end loop;
  loop
    select * into r from public.video_visibility_requests x
     where x.status = 'queued' and x.next_attempt_at <= now() and (x.lease_until is null or x.lease_until < now())
     order by (select max(y.claimed_at) from public.video_visibility_requests y where y.org_id = x.org_id) asc nulls first,
              x.next_attempt_at, x.id
     limit 1
     for update skip locked;
    if not found then
      return null;
    end if;
    -- Three claims are all a request gets in a round, six in its lifetime: a crash loop ends here instead of going round for ever.
    if r.attempts >= 3 or r.lifetime_attempts >= 6 then
      update public.video_visibility_requests
         set status = 'failed', reason = coalesce(r.reason, 'interrupted'), finished_at = now(), updated_at = now(),
             claimed_by = null, lease_until = null
       where id = r.id;
      insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
      values (null, 'video.visibility_failed', r.video_id,
              jsonb_build_object('request_id', r.id, 'video_id', r.video_id, 'cut_sha256', r.approved_cut_sha256,
                                 'status', 'failed', 'reason', coalesce(r.reason, 'interrupted'), 'attempts', r.attempts),
              r.channel_id);
      continue;
    end if;
    update public.video_visibility_requests
       set claimed_by = p_worker, claimed_at = now(), lease_until = now() + interval '10 minutes',
           attempts = attempts + 1, lifetime_attempts = lifetime_attempts + 1, updated_at = now()
     where id = r.id;
    return jsonb_build_object(
      'id', r.id, 'org_id', r.org_id, 'channel_id', r.channel_id, 'video_id', r.video_id,
      'approved_cut_sha256', r.approved_cut_sha256, 'decided_at', r.decided_at, 'expires_at', r.expires_at,
      'attempts', r.attempts + 1,
      -- the previous worker got as far as sending the write (or may have): the new one reads YouTube first
      'reconcile', r.submitting_at is not null);
  end loop;
end
$$;

-- The LAST check, and the marker "the write may be sent", in one transaction. Under row locks, in this order (the same order
-- retry_video_visibility takes, so the two cannot deadlock): the channel row FOR SHARE (the switch function holds it FOR UPDATE,
-- so a switch turned off is either seen here or waits until the marker is set), the request FOR UPDATE, the video FOR SHARE (an
-- approval or a repair of the cut waits behind this transaction). Inside the locks it asks the two refusal functions again, so a
-- cut change, a repair, an expiry, a privacy change or a switch turned off between the worker's earlier check and this marker is
-- caught here, not after. Answers 'ok' (the marker is set: the worker may send the one write), 'not_holder' (this worker no
-- longer holds the request) or the closed word of the refusal (the worker ends the request with it; nothing was sent).
-- (an earlier draft of this file returned a boolean here and took three arguments in the quota function: a database that has
-- that draft gets the new shapes, a fresh one does nothing)
drop function if exists public.mark_visibility_submitting(bigint, text);
create or replace function public.mark_visibility_submitting(p_request_id bigint, p_worker text) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r   public.video_visibility_requests;
  why text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may mark a visibility request' using errcode = '42501';
  end if;
  select * into r from public.video_visibility_requests where id = p_request_id;
  if not found then
    return 'not_holder';
  end if;
  perform 1 from public.channels c where c.channel_id = r.channel_id for share;
  select * into r from public.video_visibility_requests where id = p_request_id for update;
  if r.status <> 'queued' or r.claimed_by is distinct from p_worker then
    return 'not_holder';
  end if;
  perform 1 from public.videos v where v.video_id = r.video_id and v.channel_id = r.channel_id for share;
  why := public.video_publish_refusal(r.video_id, r.approved_cut_sha256);
  if why is null then
    why := public.visibility_request_refusal(r.id);
  end if;
  if why is not null then
    return why;
  end if;
  update public.video_visibility_requests
     set submitting_at = now(), lease_until = now() + interval '10 minutes', updated_at = now()
   where id = r.id;
  return 'ok';
end
$$;

-- The only writer of a result. p_status: applied | refused | failed | expired | queued (a retry after p_retry_seconds, until the
-- third claim). p_before / p_after are what YouTube reported before and after (the read-back); videos.privacy follows p_after
-- and nothing else. 'applied' without a read-back that said public is refused by the table itself. It does NOT look at the
-- channel's switch: a request whose write was marked (submitting_at set) records what YouTube reports even when an administrator
-- switched the channel off after the marker (the video is public or it is not; the database must say which). The audit row says
-- whether the write was marked ('write_marked'): an applied row with it false never happens, since mark_visibility_submitting
-- precedes the write, and one with it true after a crash is the read-back's finding, not necessarily our write's result.
create or replace function public.finish_visibility_request(
  p_request_id bigint, p_worker text, p_status text, p_reason text, p_before text, p_after text,
  p_units integer, p_retry_seconds integer
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r        public.video_visibility_requests;
  v_reason text;
  v_status text := p_status;
  v_before text := case when p_before in ('private', 'unlisted', 'public') then p_before end;
  v_after  text := case when p_after in ('private', 'unlisted', 'public') then p_after end;
  v_action text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may finish a visibility request' using errcode = '42501';
  end if;
  if v_status is null or v_status not in ('applied', 'refused', 'failed', 'expired', 'queued') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select * into r from public.video_visibility_requests where id = p_request_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- Only the worker that holds it, and only while it is queued: a lease that ran out and was taken by another worker, or a request
  -- the switch or the sweep already ended, is not written over.
  if r.status <> 'queued' or r.claimed_by is distinct from p_worker then
    return jsonb_build_object('ok', false, 'error', 'not_holder', 'status', r.status);
  end if;
  v_reason := case when v_status = 'applied' then null
                   when p_reason = any (public.visibility_reason_words()) then p_reason
                   else 'worker_error' end;
  if v_status = 'applied' and v_after is distinct from 'public' then
    raise exception 'applied_needs_readback' using errcode = '22023',
      detail = 'a request is applied only when YouTube reported the video public';
  end if;
  -- A retry is bounded: the third claim was the last.
  if v_status = 'queued' and r.attempts >= 3 then
    v_status := 'failed';
  end if;

  -- The mirror follows the read-back and nothing else.
  if v_after is not null then
    update public.videos set privacy = v_after
     where video_id = r.video_id and channel_id = r.channel_id and privacy is distinct from v_after;
  end if;

  if v_status = 'queued' then
    update public.video_visibility_requests
       set reason = v_reason, before_privacy = coalesce(v_before, before_privacy),
           quota_units = quota_units + greatest(coalesce(p_units, 0), 0),
           next_attempt_at = now() + make_interval(secs => least(greatest(coalesce(p_retry_seconds, 60), 5), 3600)),
           claimed_by = null, lease_until = null, updated_at = now()
     where id = r.id;
    return jsonb_build_object('ok', true, 'status', 'queued', 'reason', v_reason);
  end if;

  update public.video_visibility_requests
     set status = v_status, reason = v_reason, before_privacy = coalesce(v_before, before_privacy), after_privacy = v_after,
         quota_units = quota_units + greatest(coalesce(p_units, 0), 0), finished_at = now(), updated_at = now(),
         claimed_by = null, lease_until = null
   where id = r.id;
  v_action := 'video.visibility_' || v_status;
  insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
  values (null, v_action, r.video_id,
          jsonb_build_object('request_id', r.id, 'video_id', r.video_id, 'cut_sha256', r.approved_cut_sha256,
                             'status', v_status, 'reason', v_reason, 'before', v_before, 'after', v_after,
                             'units', r.quota_units + greatest(coalesce(p_units, 0), 0), 'attempts', r.attempts,
                             'write_marked', r.submitting_at is not null),
          r.channel_id);
  return jsonb_build_object('ok', true, 'status', v_status, 'reason', v_reason);
end
$$;

-- Take p_units of the day's budget, or answer false when that would pass p_ceiling (the whole day) or p_org_ceiling (this
-- organization's share of it). The day is Pacific time (YouTube's). Serialized per project, so two workers cannot both pass a ceiling.
drop function if exists public.youtube_quota_take(text, integer, integer);
create or replace function public.youtube_quota_take(
  p_project text, p_units integer, p_ceiling integer, p_org uuid, p_org_ceiling integer
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_day   date := (now() at time zone 'America/Los_Angeles')::date;
  v_all   constant uuid := '00000000-0000-0000-0000-000000000000';
  v_total integer;
  v_org   integer;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may spend quota' using errcode = '42501';
  end if;
  if coalesce(p_project, '') !~ '^[a-z0-9._-]{1,64}$' or p_units is null or p_units not between 1 and 200
     or p_ceiling is null or p_ceiling not between 0 and 10000
     or p_org is null or p_org = v_all or p_org_ceiling is null or p_org_ceiling not between 0 and 10000 then
    raise exception 'invalid quota request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('youtube_quota:' || p_project, 0));
  select coalesce(max(l.units) filter (where l.org_id = v_all), 0), coalesce(max(l.units) filter (where l.org_id = p_org), 0)
    into v_total, v_org
    from public.youtube_quota_ledger l
   where l.day = v_day and l.project = p_project and l.source = 'visibility';
  if v_total + p_units > p_ceiling or v_org + p_units > p_org_ceiling then
    return false;
  end if;
  insert into public.youtube_quota_ledger as l (day, project, source, org_id, units)
  values (v_day, p_project, 'visibility', v_all, p_units)
  on conflict (day, project, source, org_id) do update set units = l.units + p_units, updated_at = now();
  insert into public.youtube_quota_ledger as l (day, project, source, org_id, units)
  values (v_day, p_project, 'visibility', p_org, p_units)
  on conflict (day, project, source, org_id) do update set units = l.units + p_units, updated_at = now();
  delete from public.youtube_quota_ledger where day < v_day - 14;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Try again: an administrator re-queues a FAILED request while the same approval holds (and the lifetime cap allows)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.retry_video_visibility(p_request_id bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  r      public.video_visibility_requests;
  v      public.videos;
  ch     public.channels;
  access text;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into r from public.video_visibility_requests where id = p_request_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The same standing as approving: the word the panel asks too.
  access := public.video_approve_access(r.video_id);
  if access = 'not_found' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if access <> 'ok' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.take_web_rate('video_retry', 20, 600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  select * into r from public.video_visibility_requests where id = p_request_id for update;
  if r.status <> 'failed' then
    return jsonb_build_object('ok', false, 'error', 'not_retryable');
  end if;
  if r.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'approval_expired');
  end if;
  -- A request is carried out at most twice over (two rounds of three claims): "try again" is not a way round that.
  if r.lifetime_attempts >= 6 then
    return jsonb_build_object('ok', false, 'error', 'retry_limit');
  end if;
  select * into v from public.videos where video_id = r.video_id and channel_id = r.channel_id for update;
  if not found or v.decided_at is distinct from r.decided_at or v.approved_cut_sha256 is distinct from r.approved_cut_sha256 then
    return jsonb_build_object('ok', false, 'error', 'approval_superseded');
  end if;
  select * into ch from public.channels where channel_id = r.channel_id;
  if not found or ch.publish_on_approve is not true then
    return jsonb_build_object('ok', false, 'error', 'not_enabled');
  end if;
  update public.video_visibility_requests
     set status = 'queued', reason = null, attempts = 0, next_attempt_at = now(), claimed_by = null, lease_until = null,
         finished_at = null, updated_at = now()
   where id = r.id;
  insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
  values (uid, 'video.visibility_retry', r.video_id,
          jsonb_build_object('request_id', r.id, 'video_id', r.video_id, 'cut_sha256', r.approved_cut_sha256), r.channel_id);
  return jsonb_build_object('ok', true, 'request_id', r.id, 'status', 'queued');
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The audit action list: 0112's body verbatim plus the names above
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.audit_action_allowed(p_action text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_action, '') = any (array[
    'agent.run', 'api.activate', 'api.monthly_limit', 'api.topup_checkout', 'api_key.access', 'api_key.create',
    'api_key.revoke', 'billing.portal', 'billing.refresh', 'billing.settings', 'billing.topup', 'captions.delete',
    'channel.dna.update', 'channel.youtube.connect', 'channel.youtube.connect_failed', 'channel.youtube.disconnect',
    'character.create', 'character.delete', 'character.update', 'creative.cancel', 'creative.generate',
    'editor.export_request', 'editor.project_create', 'editor.project_delete', 'editor.send_asset',
    'media.delete', 'media.folder_create', 'media.folder_delete', 'media.folder_rename', 'media.move',
    'media.upload_request', 'model.availability', 'scene.regenerate', 'secret.write', 'series.create',
    'series.update', 'storyboard.approve', 'storyboard.discard', 'storyboard.edit', 'storyboard.reopen',
    'style_kit.add_library', 'style_kit.attach', 'style_kit.create', 'style_kit.delete', 'style_kit.detach',
    'style_kit.update', 'variable.write', 'video.download_request', 'video.publish_request', 'video.repurpose',
    'workflow.cancel', 'workflow.delete', 'workflow.run', 'workflow.save',
    -- 0093: connecting, disconnecting and re-limiting an AI app (oauth_* functions).
    'mcp.connect', 'mcp.disconnect', 'mcp.disconnect_all', 'mcp.limit',
    -- 0107: the owner actions (owner_* functions) and the second-factor gate.
    'credits.grant', 'credits.reverse', 'credits.price', 'member.add', 'member.role', 'member.remove', 'security.gate',
    -- 0108: the brand-channel posts (owner_marketing_*, the poster worker) and the showcase marking (later).
    'marketing.edit', 'marketing.approve', 'marketing.reject', 'marketing.send', 'marketing.fail', 'marketing.kill',
    'showcase.mark', 'showcase.revoke',
    -- 0110: the owner types a post (owner_marketing_create).
    'marketing.create',
    -- 0112: a person approves the exact cut of an uploaded video (approve_video_publish).
    'video.approve',
    -- 0113: the per-channel switch, a queued request, the worker's results, a person's retry.
    'channel.publish_on_approve', 'video.publish_queued', 'video.visibility_applied', 'video.visibility_refused',
    'video.visibility_failed', 'video.visibility_expired', 'video.visibility_retry',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Who may do what
-- ───────────────────────────────────────────────────────────────────────────

alter table public.video_visibility_requests enable row level security;
alter table public.youtube_quota_ledger enable row level security;

-- No API role writes either table, the service key included: every write is one of the functions above.
revoke all on public.video_visibility_requests from public, anon, authenticated, service_role;
revoke all on public.youtube_quota_ledger from public, anon, authenticated, service_role;
-- The queue's own sequence: nobody advances it from an API role (0020 does the same for its ledger's).
revoke all on sequence public.video_visibility_requests_id_seq from public, anon, authenticated, service_role;

-- Members read their organization's rows, without the worker's own columns (who holds it, the lease, the submit marker).
grant select (id, org_id, channel_id, video_id, intent_id, approved_cut_sha256, decided_by, decided_at, expires_at, status, reason,
              attempts, lifetime_attempts, next_attempt_at, before_privacy, after_privacy, quota_units, finished_at, created_at, updated_at)
  on public.video_visibility_requests to authenticated;
grant select on public.youtube_quota_ledger to authenticated;

drop policy if exists video_visibility_requests_select on public.video_visibility_requests;
create policy video_visibility_requests_select on public.video_visibility_requests
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));

-- The day's spend is the operator's.
drop policy if exists youtube_quota_ledger_select on public.youtube_quota_ledger;
create policy youtube_quota_ledger_select on public.youtube_quota_ledger
  for select to authenticated using (public.is_platform_admin());

revoke all on function public.channels_publish_switch_guard() from public, anon, authenticated, service_role;
revoke all on function public.video_visibility_requests_guard() from public, anon, authenticated, service_role;
revoke all on function public.visibility_reason_words() from public, anon, authenticated, service_role;
revoke all on function public.visibility_channel_connected(text) from public, anon, authenticated, service_role;
revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

-- A signed-in caller (each function checks the organization and the role itself): not anon, not the service key.
revoke all on function public.approve_video_publish(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.approve_video_publish(text, text, jsonb) to authenticated;
revoke all on function public.set_channel_publish_on_approve(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_channel_publish_on_approve(text, boolean) to authenticated;
revoke all on function public.retry_video_visibility(bigint) from public, anon, authenticated, service_role;
grant execute on function public.retry_video_visibility(bigint) to authenticated;

-- The worker: the service key only.
revoke all on function public.visibility_request_refusal(bigint) from public, anon, authenticated, service_role;
revoke all on function public.claim_visibility_request(text) from public, anon, authenticated, service_role;
revoke all on function public.mark_visibility_submitting(bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.finish_visibility_request(bigint, text, text, text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.youtube_quota_take(text, integer, integer, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.visibility_request_refusal(bigint) to service_role;
grant execute on function public.claim_visibility_request(text) to service_role;
grant execute on function public.mark_visibility_submitting(bigint, text) to service_role;
grant execute on function public.finish_visibility_request(bigint, text, text, text, text, text, integer, integer) to service_role;
grant execute on function public.youtube_quota_take(text, integer, integer, uuid, integer) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select count(*) = 0 from public.channels where publish_on_approve) as switch_off_everywhere,
--     (select column_default = 'false' and is_nullable = 'NO' from information_schema.columns
--       where table_schema = 'public' and table_name = 'channels' and column_name = 'publish_on_approve') as switch_default_off,
--     (select bool_and(relrowsecurity) from pg_class
--       where oid in ('public.video_visibility_requests'::regclass, 'public.youtube_quota_ledger'::regclass)) as rls_on,
--     not has_table_privilege('authenticated', 'public.video_visibility_requests', 'INSERT')
--       and not has_table_privilege('authenticated', 'public.video_visibility_requests', 'UPDATE')
--       and not has_table_privilege('service_role', 'public.video_visibility_requests', 'UPDATE')
--       and not has_table_privilege('service_role', 'public.youtube_quota_ledger', 'INSERT')
--       and not has_column_privilege('authenticated', 'public.channels', 'publish_on_approve', 'UPDATE') as nobody_writes_directly,
--     has_function_privilege('authenticated', 'public.set_channel_publish_on_approve(text,boolean)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.set_channel_publish_on_approve(text,boolean)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.claim_visibility_request(text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.claim_visibility_request(text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.finish_visibility_request(bigint,text,text,text,text,text,integer,integer)', 'EXECUTE')
--       as functions_scoped,
--     (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--        from pg_proc p where p.pronamespace = 'public'::regnamespace
--         and p.proname in ('set_channel_publish_on_approve', 'retry_video_visibility', 'claim_visibility_request',
--                           'mark_visibility_submitting', 'finish_visibility_request', 'visibility_request_refusal',
--                           'youtube_quota_take', 'approve_video_publish')) as definers_pin_search_path,
--     public.audit_action_allowed('video.approve') and public.audit_action_allowed('video.publish_queued')
--       and public.audit_action_allowed('channel.publish_on_approve') as audit_list,
--     position('video_visibility_requests' in pg_get_functiondef('public.approve_video_publish(text,text,jsonb)'::regprocedure)) > 0
--       as approve_queues_when_switch_on;
