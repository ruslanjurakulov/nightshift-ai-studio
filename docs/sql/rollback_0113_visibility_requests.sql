-- rollback_0113_visibility_requests.sql — takes migration 0113 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. To switch the whole feature off for good, in one transaction. The cheaper undo is the data: the per-channel
-- switch (a channel's administrators turn "Publish when approved" off in the Command Center; its queued requests are refused at
-- once) and the worker's own switch (NIGHTSHIFT_VISIBILITY_PUBLISH unset). 0113 changes no video's privacy by itself.
--
-- ORDER. If you also roll back 0112, run THIS file first: 0113 redefines approve_video_publish and audit_action_allowed from
-- 0112's text, and rollback_0112 restores the versions before 0112.
--
-- WHAT IT DOES, in one transaction:
--   1. Refuses every request that is still queued and was never marked for a write (reason not_enabled) and switches every
--      channel's publish_on_approve off, so nothing can be acted on after this file, whatever is applied again later. (The
--      switch's guard trigger stays; this file runs as the database owner, which it lets through.)
--      A request whose write was MARKED (submitting_at set: a YouTube write may be on its way or have landed) is NOT refused,
--      because refusing it would leave the database saying "not published" about a video that may be public:
--        - if such a write may be in flight right now (marked within the last 10 minutes) the file stops with an error and
--          changes nothing: wait ten minutes and run it again, so the worker can record what YouTube reports first;
--        - older ones stay queued as a record (nothing can finish them once the functions below are dropped): the file prints
--          how many, and each is to be checked in YouTube Studio by a person.
--   2. Drops set_channel_publish_on_approve, retry_video_visibility, claim_visibility_request, mark_visibility_submitting,
--      finish_visibility_request, visibility_request_refusal, visibility_channel_connected, youtube_quota_take and youtube_quota_refund: no API role
--      can write the queue, change the switch or spend quota any more.
--   3. Puts approve_video_publish(text, text, jsonb) back to 0112's body, byte for byte, with the grant 0112 gave it: it queues nothing.
--   4. Puts audit_action_allowed(text) back to 0112's body (the seven 0113 action names become unknown again).
--
-- WHAT IT KEEPS ON PURPOSE. The tables video_visibility_requests and youtube_quota_ledger with every row (the record of what was
-- asked and what YouTube reported; deleting history is not undoable), the column channels.publish_on_approve (now false
-- everywhere), and the three internal functions those need: channels_publish_switch_guard(), video_visibility_requests_guard()
-- and visibility_reason_words(). Applying 0113 again keeps them all (create if not exists / create or replace).
--
-- CHECK BEFORE YOU RUN IT: this file puts two functions back to the text they had in 0112. If a later migration has redefined
-- either, running this would silently undo that later change. Compare first:
--     select pg_get_functiondef('public.approve_video_publish(text, text, jsonb)'::regprocedure);
--     select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure);
-- The only differences from this file's text should be the lines marked 0113 (and the seven action names in the list).
--
-- tests/security/test_sec_visibility.py applies this file to the lab database and then re-applies 0113.

begin;
set local lock_timeout = '5s';

do $$
declare
  n_flight integer;
  n_marked integer;
begin
  select count(*) into n_flight from public.video_visibility_requests
   where status = 'queued' and submitting_at is not null and submitting_at > now() - interval '10 minutes';
  if n_flight > 0 then
    raise exception 'rollback 0113: % request(s) have a YouTube write that may be in flight (marked in the last 10 minutes); wait and run this again, so the worker can record what YouTube reports', n_flight
      using errcode = '55000';
  end if;
  update public.video_visibility_requests
     set status = 'refused', reason = 'not_enabled', finished_at = now(), updated_at = now(), claimed_by = null, lease_until = null
   where status = 'queued' and submitting_at is null;
  select count(*) into n_marked from public.video_visibility_requests where status = 'queued' and submitting_at is not null;
  if n_marked > 0 then
    raise notice 'rollback 0113: % request(s) stay queued because a write was marked for them: check those videos in YouTube Studio', n_marked;
  end if;
end $$;
update public.channels set publish_on_approve = false where publish_on_approve;

drop function if exists public.set_channel_publish_on_approve(text, boolean);
drop function if exists public.retry_video_visibility(bigint);
drop function if exists public.claim_visibility_request(text);
drop function if exists public.mark_visibility_submitting(bigint, text);
drop function if exists public.finish_visibility_request(bigint, text, text, text, text, text, integer, integer);
drop function if exists public.visibility_request_refusal(bigint);
drop function if exists public.youtube_quota_take(text, integer, integer, uuid, integer);
drop function if exists public.youtube_quota_refund(text, integer, uuid);
drop function if exists public.youtube_quota_take(text, integer, integer);
drop function if exists public.visibility_channel_connected(text);

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

revoke all on function public.approve_video_publish(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.approve_video_publish(text, text, jsonb) to authenticated;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

commit;
