-- 0112_approve_video_publish.sql — "Approve" on the review panel becomes a real, safe DECISION (Phase 1a of the
-- approve-and-publish design). NOTHING IN THIS FILE TOUCHES YOUTUBE: no video changes privacy because of it. What it
-- adds is the record of who looked at which exact cut and said yes, bound to that cut, time-limited, audited, and
-- the one place a browser can no longer write that decision directly.
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it
-- *** automatically, and an applied migration is never edited: fix by a new forward
-- *** migration (docs/MIGRATIONS.md).
--
-- WHY. The panel's "Approve" button inserted a review_intents row that nothing read (only scene repair reads its own
-- regenerate_scene rows), so a video's review_state stayed 'pending' forever on a channel with auto publish off, the
-- "Publish to platforms" rail refused every cross-post with not_approved (publish_request_refusal, 0029), and the panel
-- stuck on "Asked for: approve" with no way out. Approval is now an RPC, modelled on approve_reply (0081) and
-- owner_marketing_approve (0108).
--
-- WHAT IT ADDS (additive; every column nullable, so an older pipeline and an older app keep working)
--  1. videos.cut_sha256            sha256 of the final master as it was when the review copy was recorded. Written by the
--                                  pipeline (modules/video_review.py record(), modules/held_video.py), NULL on older rows.
--     videos.gate_verdict          the publish gate's own verdict for that cut {allowed, blocks, warnings, checks_run},
--                                  written next to the hash. NULL = unknown, never a pass (CLAUDE.md rule 5): the gate
--                                  events are emitted before the video exists and do not carry its id.
--     videos.approved_cut_sha256, decided_by, decided_by_email, decided_at, approval_expires_at
--                                  who approved which cut, when, and until when. Written only by approve_video_publish().
--     review_intents.approved_cut_sha256   the same hash on the immutable "who asked" record.
--  2. approve_video_publish(p_video_id, p_cut_sha256, p_ack)   SIGNED-IN, NOT anon, NOT the service key.
--       * the video is read, and its organization derived, from the VIDEO row (never from the caller);
--       * a caller who cannot see the video gets not_found, as approve_reply does (no answer about other tenants);
--       * role: admin or owner of THE CHANNEL'S ORGANIZATION. A platform owner/admin acting on a CUSTOMER channel must be a
--         real, bound member of that organization (video_real_member below, the rule of inbox_real_member, 0081, which a database built
--         from 0081 as first merged may lack): public speech under a customer's name is the
--         customer's team's. In the operator's own organization the old rule stays (any platform owner/admin).
--         All three are one function, video_approve_access(), which the panel also asks so that its key is disabled with a
--         reason for exactly the people the function would refuse (the page may not read org_members itself).
--       * a per-person rate limit (take_web_rate, 20 per 10 minutes, the owner_guard pattern);
--       * the acknowledgement {"rights_and_labels": true} is required and goes into the audit row;
--       * video_approve_refusal() must return NULL: the video is uploaded (a YouTube id, published), has a preview, a stored
--         gate verdict that is allowed with no blocks, is not rejected, is not already public (privacy), has a recorded cut, and the cut the reviewer saw
--         (p_cut_sha256) is the stored one. A held, blocked or never-uploaded run is refused with its own word.
--       * on success, in one transaction under a row lock: videos.review_state = 'approved', approved_cut_sha256, decided_by,
--         decided_by_email, decided_at, approval_expires_at (24 hours); one review_intents row (action 'approve', consumed
--         at once, outcome 'recorded'); older unconsumed approve intents (the stuck rows of the dead button) are consumed as
--         'superseded_by_approval'; one app_audit_log row 'video.approve'.
--       * replay: the same cut again while its approval is valid returns {ok, already: true} and changes nothing, writes
--         no second intent and no second audit row. An EXPIRED approval can be given again.
--       * answers: {ok: true, ...} or {ok: false, error: <closed word>}. Authorization failures raise (42501 / P0002).
--  3. video_publish_refusal(p_video_id, p_cut_sha256)   SERVICE ONLY. The one rule for "may this approval be acted on now",
--       for the visibility worker of Phase 1b (not built): the eligibility words of video_approve_refusal() plus
--       not_approved, cut_changed (the approval was for another cut) and approval_expired. Returns a closed
--       word or NULL. Nothing calls it yet.
--     video_approve_refusal(p_video_id, p_cut_sha256)   internal (no API role): the eligibility half both use.
--  3a. video_real_member(org, role)   internal (no API role): inbox_real_member's rule under its own name.
--  3b. video_approve_access(p_video_id)   SIGNED-IN. A word for the caller and THIS video: ok | not_admin | not_member | not_found.
--       Read-only; approve_video_publish() calls it, the panel calls it to decide whether to offer the key.
--  4. review_intents insert policy: 0033's policy with TWO more conditions, action <> 'approve' and approved_cut_sha256 is null. A browser can no longer
--     insert an approve intent directly, nor write approved_cut_sha256 on any row (only the function does); regenerate,
--     regenerate_script and regenerate_scene are exactly as they were.
--  5. finish_scene_regeneration()   0085's body verbatim except the statement that returns an approved video to pending also
--     clears the approval's columns (hash, who, when, expiry): a repaired cut is not the cut that was approved.
--  6. audit_action_allowed()   0110's list verbatim plus video.approve.
--
-- WHAT IT DOES NOT DO. It does not make any video public, does not call YouTube, does not change publish_request_refusal
-- (0029): the cross-post rail keeps reading review_state = 'approved', which is now reachable on a channel with auto
-- publish off. An approval stays in review_state 'approved' after its 24 hours; video_publish_refusal reports it as
-- approval_expired, and the panel shows it as expired. Videos uploaded before this migration have no recorded cut or
-- verdict, so they are refused with cut_unknown / gate_unknown ("make it public in YouTube Studio").
--
-- Additive and idempotent: add column if not exists, guarded constraint adds, create or replace (bodies copied from the
-- latest migration that defines each), drop policy / create policy, revoke then grant. Rollback:
-- docs/sql/rollback_0112_approve_video_publish.sql.
-- REQUIRES 0004 (videos.review_state, review_intents), 0016 (videos.publish_state), 0033 (the insert policy this narrows),
-- 0085 (finish_scene_regeneration), 0087 (take_web_rate, the audit stamp), 0110 (the audit list).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.videos') is null or to_regclass('public.review_intents') is null or to_regclass('public.app_audit_log') is null then
    raise exception '0112 needs 0004_review.sql and 0008_audit_log.sql (videos, review_intents, app_audit_log): apply them first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'publish_state') then
    raise exception '0112 needs videos.publish_state: apply 0016_held_videos.sql first';
  end if;
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null
     or to_regprocedure('public.audit_action_allowed(text)') is null then
    raise exception '0112 needs 0087_audit_and_rate_hardening.sql (take_web_rate, audit_action_allowed): apply it first';
  end if;
  if to_regprocedure('public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)') is null then
    raise exception '0112 needs 0085_scene_regen_followups.sql (finish_scene_regeneration): apply it first';
  end if;
  if to_regprocedure('public.is_org_member(uuid, text)') is null or to_regprocedure('public.channel_org(text)') is null
     or to_regprocedure('public.accessible_channel_ids(text)') is null or to_regprocedure('public.my_confirmed_email()') is null
     or to_regprocedure('public.default_org_id()') is null or to_regprocedure('public.app_role_rank(text)') is null then
    raise exception '0112 needs 0018_organizations.sql and 0043_invites_accept.sql (is_org_member, channel_org, my_confirmed_email): apply them first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The columns (all nullable; no default, so adding them rewrites nothing)
-- ───────────────────────────────────────────────────────────────────────────

alter table public.videos
  add column if not exists cut_sha256 text,
  add column if not exists gate_verdict jsonb,
  add column if not exists approved_cut_sha256 text,
  add column if not exists decided_by uuid,
  add column if not exists decided_by_email text,
  add column if not exists decided_at timestamptz,
  add column if not exists approval_expires_at timestamptz;

alter table public.review_intents
  add column if not exists approved_cut_sha256 text;

comment on column public.videos.cut_sha256 is
  'sha256 (hex) of the final master as it was when its review copy was recorded (modules/video_review.py). The preview is a 480p transcode of it. NULL on rows recorded before migration 0112: such a video cannot be approved here.';
comment on column public.videos.gate_verdict is
  'The publish gate''s verdict for the cut in cut_sha256: {"allowed": bool, "blocks": [...], "warnings": [...], "checks_run": [...]}. Never script or claim text. NULL means unknown, never a pass.';
comment on column public.videos.approved_cut_sha256 is
  'The cut a person approved (approve_video_publish). An approval is valid only while review_state = ''approved'', this equals cut_sha256 and approval_expires_at is in the future.';
comment on column public.videos.decided_by is 'Who approved (auth.users id). Written only by approve_video_publish().';
comment on column public.videos.decided_by_email is 'The approver''s confirmed address at the time, for "Approved by ..." on the panel.';
comment on column public.videos.decided_at is 'When the approval was recorded.';
comment on column public.videos.approval_expires_at is 'decided_at + 24 hours. After it the approval no longer counts for acting on it (video_publish_refusal: approval_expired).';
comment on column public.review_intents.approved_cut_sha256 is 'For action = approve (written by approve_video_publish): the exact cut the approver saw.';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.videos'::regclass and conname = 'videos_cut_sha256_shape') then
    alter table public.videos add constraint videos_cut_sha256_shape
      check (cut_sha256 is null or cut_sha256 ~ '^[0-9a-f]{64}$') not valid;
    alter table public.videos validate constraint videos_cut_sha256_shape;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.videos'::regclass and conname = 'videos_approved_cut_sha256_shape') then
    alter table public.videos add constraint videos_approved_cut_sha256_shape
      check (approved_cut_sha256 is null or approved_cut_sha256 ~ '^[0-9a-f]{64}$') not valid;
    alter table public.videos validate constraint videos_approved_cut_sha256_shape;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.videos'::regclass and conname = 'videos_gate_verdict_shape') then
    alter table public.videos add constraint videos_gate_verdict_shape
      check (gate_verdict is null or jsonb_typeof(gate_verdict) = 'object') not valid;
    alter table public.videos validate constraint videos_gate_verdict_shape;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_intents'::regclass and conname = 'review_intents_approved_cut_shape') then
    alter table public.review_intents add constraint review_intents_approved_cut_shape
      check (approved_cut_sha256 is null or approved_cut_sha256 ~ '^[0-9a-f]{64}$') not valid;
    alter table public.review_intents validate constraint review_intents_approved_cut_shape;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. May this video be approved / acted on? (closed vocabulary, NULL = yes)
-- ───────────────────────────────────────────────────────────────────────────

-- The eligibility half: what must be true of the video and the cut the reviewer saw, before an approval is accepted.
create or replace function public.video_approve_refusal(p_video_id text, p_cut_sha256 text) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v public.videos;
  a jsonb;
begin
  select * into v from public.videos where video_id = p_video_id;
  if not found then
    return 'video_not_found';
  end if;
  -- A held run never uploaded: it has no YouTube id (its id is the stand-in run-<20 hex>), no publish time, and
  -- publish_state says why (blocked, awaiting_approval, held, repaired_awaiting_review). Nothing on YouTube to approve.
  if v.published_at is null or coalesce(v.publish_state, 'uploaded') <> 'uploaded'
     or v.video_id !~ '^[A-Za-z0-9_-]{11}$' then
    return 'not_uploaded';
  end if;
  a := v.gate_verdict -> 'allowed';
  if a = 'false'::jsonb
     or (jsonb_typeof(v.gate_verdict -> 'blocks') = 'array' and jsonb_array_length(v.gate_verdict -> 'blocks') > 0) then
    return 'gate_blocked';
  end if;
  -- No stored verdict is "unknown", never a pass (CLAUDE.md rule 5).
  if a is distinct from 'true'::jsonb then
    return 'gate_unknown';
  end if;
  if v.review_state = 'rejected' then
    return 'rejected';
  end if;
  -- The mirror says it is public already (an auto-publish channel, or a person made it public on YouTube): there is
  -- nothing left to approve, and an approval must not be recorded as if it had let the video out.
  if v.privacy = 'public' then
    return 'already_public';
  end if;
  if v.preview_path is null or btrim(v.preview_path) = '' then
    return 'no_preview';
  end if;
  if v.cut_sha256 is null then
    return 'cut_unknown';
  end if;
  if p_cut_sha256 is distinct from v.cut_sha256 then
    return 'cut_changed';
  end if;
  return null;
end
$$;

-- The rule for ACTING on an approval (Phase 1b's worker, right before it would change anything): the same eligibility,
-- then the approval itself must exist for this very cut and be unexpired.
create or replace function public.video_publish_refusal(p_video_id text, p_cut_sha256 text) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v public.videos;
  why text;
begin
  why := public.video_approve_refusal(p_video_id, p_cut_sha256);
  if why is not null then
    return why;
  end if;
  select * into v from public.videos where video_id = p_video_id;
  if v.review_state is distinct from 'approved' or v.approved_cut_sha256 is null then
    return 'not_approved';
  end if;
  if v.approved_cut_sha256 is distinct from p_cut_sha256 then
    return 'cut_changed';
  end if;
  if v.approval_expires_at is null or v.approval_expires_at <= now() then
    return 'approval_expired';
  end if;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. THE approval
-- ───────────────────────────────────────────────────────────────────────────

-- Is the caller a REAL member of the organization (an org_members row bound to their user id, of at least this role)? Platform
-- owners and admins are members of every organization through accessible_org_ids, which is right for support and wrong for
-- public speech under a customer's name. The rule of inbox_real_member (0081), copied under its own name because a
-- migration may not rely on an object an earlier one gained only by an edit after it was merged (tests/test_migration_prerequisites.py).
create or replace function public.video_real_member(p_org uuid, p_min text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_org = public.default_org_id() then public.is_org_member(p_org, p_min)
    else exists (
      select 1 from public.org_members m
       where m.org_id = p_org
         -- Bound membership only (0043): an unbound e-mail invite is an offer, and an e-mail claim in a token grants nothing.
         and m.user_id = auth.uid()
         and public.app_role_rank(m.role) >= public.app_role_rank(p_min))
  end
$$;

-- May the caller approve THIS video? The organization comes from the video's channel, never from an argument. A caller who
-- cannot see the video (another organization's, or none) gets the answer a missing one gets. A platform owner/admin is an
-- administrator of every organization for support (is_org_member), but approves in a customer's organization only as a real
-- member of it (video_real_member); in the operator's own organization the old rule stays.
create or replace function public.video_approve_access(p_video_id text) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_channel text;
  org       uuid;
begin
  if auth.uid() is null or p_video_id is null or p_video_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    return 'not_found';
  end if;
  select v.channel_id into v_channel from public.videos v where v.video_id = p_video_id;
  if found then
    org := public.channel_org(v_channel);
  end if;
  if not found or org is null or not public.is_org_member(org) then
    return 'not_found';
  end if;
  if not public.is_org_member(org, 'admin') then
    return 'not_admin';
  end if;
  if not public.video_real_member(org, 'admin') then
    return 'not_member';
  end if;
  return 'ok';
end
$$;

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
  return jsonb_build_object('ok', true, 'already', false, 'video_id', v.video_id, 'cut_sha256', p_cut_sha256,
                            'decided_at', now(), 'expires_at', v_exp, 'intent_id', i.id);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. A browser can no longer write an approval directly
-- ───────────────────────────────────────────────────────────────────────────
-- 0033's policy (editor of the channel's organization; the video must be on that channel) plus action <> 'approve'.

drop policy if exists review_intents_insert on public.review_intents;
create policy review_intents_insert on public.review_intents
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('editor'))
    and action <> 'approve'
    and approved_cut_sha256 is null
    and (video_id is null
         or exists (select 1 from public.videos v
                     where v.video_id = review_intents.video_id
                       and v.channel_id = review_intents.channel_id))
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 5. A repaired cut voids the approval's columns too (0085's body, one statement extended)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.finish_scene_regeneration(
  p_id uuid, p_job bigint, p_ok boolean, p_error_code text, p_error text, p_result jsonb
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r         public.scene_regenerations;
  res       public.credit_reservations;
  v_charged numeric := 0;
  v_code    text;
  v_result  jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.scene_regenerations where id = p_id for update;
  if r.id is null or r.render_job_id is distinct from p_job then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if r.status in ('succeeded', 'failed') then
    return jsonb_build_object('id', r.id, 'status', r.status, 'charged_credits', r.charged_credits,
                              'replayed', true);
  end if;
  v_result := case when p_result is not null and jsonb_typeof(p_result) = 'object'
                        and octet_length(p_result::text) <= 8192 then p_result end;

  if coalesce(p_ok, false) then
    if r.credit_ref is not null then
      v_charged := public.capture_credits(r.credit_ref, r.quoted_credits, false);
    end if;
    -- The approved cut is not the cut that now exists (modules/scene_repair
    -- invalidate_approvals does the same from the pipeline): re-approval is
    -- needed, through the normal review. Nothing here publishes.
    -- 0112: the approval goes with the state: its hash, who decided, when and until when.
    update public.videos set review_state = 'pending', approved_cut_sha256 = null, decided_by = null,
           decided_by_email = null, decided_at = null, approval_expires_at = null
     where video_id = r.video_id and review_state = 'approved';
    update public.review_intents set consumed_at = now(), outcome = 'superseded_by_repair'
     where video_id = r.video_id and action = 'approve' and consumed_at is null;
    update public.review_intents set consumed_at = now(), outcome = 'repaired'
     where video_id = r.video_id and action = 'regenerate_scene' and scene_id = r.scene_id
       and consumed_at is null;
    update public.scene_regenerations
       set status = 'succeeded', charged_credits = case when r.credit_ref is null then null else v_charged end,
           result = v_result, finished_at = now(), error_code = null, error = null
     where id = r.id;
    return jsonb_build_object('id', r.id, 'status', 'succeeded', 'charged_credits', v_charged, 'replayed', false);
  end if;

  if r.credit_ref is not null then
    select * into res from public.credit_reservations where job_id = r.credit_ref;
    if res.job_id is not null and res.status = 'open' then
      perform public.release_credits(r.credit_ref);
    end if;
  end if;
  v_code := case when p_error_code ~ '^[a-z][a-z0-9_]{0,47}$' then p_error_code else 'failed' end;
  -- 0085 (BR-L-040): the member-readable row carries the code and one fixed
  -- sentence. The worker's own text (a provider's name, its configuration, a
  -- refusal copied from a vendor) goes to the service-only details table.
  if nullif(btrim(p_error), '') is not null then
    insert into public.scene_regeneration_details (regeneration_id, detail)
    values (r.id, left(p_error, 500))
    on conflict (regeneration_id) do nothing;
  end if;
  update public.scene_regenerations
     set status = 'failed', charged_credits = case when r.credit_ref is null then null else 0 end,
         result = v_result, finished_at = now(), error_code = v_code,
         error = 'The regeneration did not finish; the previous take was kept and nothing was charged.'
   where id = r.id;
  return jsonb_build_object('id', r.id, 'status', 'failed', 'charged_credits', 0, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The audit action list: 0110's body verbatim plus video.approve
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
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Who may do what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;
revoke all on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) to service_role;

-- A signed-in caller (the function checks the organization and the role itself): not anon, not the service key.
revoke all on function public.approve_video_publish(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.approve_video_publish(text, text, jsonb) to authenticated;

-- The panel asks it too (read-only; a caller learns only their own standing for a video they can see).
revoke all on function public.video_approve_access(text) from public, anon, authenticated, service_role;
grant execute on function public.video_approve_access(text) to authenticated;

-- The worker's rule (Phase 1b): the service key only. The eligibility half is internal to the definer functions.
revoke all on function public.video_publish_refusal(text, text) from public, anon, authenticated, service_role;
grant execute on function public.video_publish_refusal(text, text) to service_role;
revoke all on function public.video_approve_refusal(text, text) from public, anon, authenticated, service_role;
revoke all on function public.video_real_member(uuid, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select count(*) = 7 from information_schema.columns where table_schema = 'public' and table_name = 'videos'
--        and column_name in ('cut_sha256', 'gate_verdict', 'approved_cut_sha256', 'decided_by', 'decided_by_email', 'decided_at', 'approval_expires_at'))
--       as video_columns,
--     has_function_privilege('authenticated', 'public.approve_video_publish(text,text,jsonb)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.approve_video_publish(text,text,jsonb)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.approve_video_publish(text,text,jsonb)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.video_approve_access(text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.video_approve_access(text)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.video_publish_refusal(text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.video_publish_refusal(text,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.video_approve_refusal(text,text)', 'EXECUTE')
--       as functions_scoped,
--     (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--        from pg_proc p where p.pronamespace = 'public'::regnamespace
--         and p.proname in ('approve_video_publish', 'video_publish_refusal', 'video_approve_refusal', 'video_approve_access', 'video_real_member')) as definers_pin_search_path,
--     (select pg_get_expr(polwithcheck, polrelid) like '%''approve''%' from pg_policy
--       where polrelid = 'public.review_intents'::regclass and polname = 'review_intents_insert') as direct_approve_closed,
--     public.audit_action_allowed('video.approve') and public.audit_action_allowed('marketing.create') as audit_list,
--     position('approval_expires_at = null' in pg_get_functiondef('public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)'::regprocedure)) > 0
--       as repair_clears_approval;
