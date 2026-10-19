-- rollback_0112_approve_video_publish.sql — takes migration 0112 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. Rarely. 0112 changes no video's privacy and calls nothing outside the database. What it changes is who
-- can record an approval (only approve_video_publish now; a browser's direct insert of an approve intent is refused) and
-- what a repair clears. Without this file the cheapest undo of the feature is in the app (the panel stops calling the RPC).
--
-- WHAT IT DOES, in one transaction:
--   1. Drops approve_video_publish(text, text, jsonb), video_approve_access(text), video_real_member(uuid, text),
--      video_publish_refusal(text, text) and video_approve_refusal(text, text).
--   2. Puts review_intents_insert back to 0033's policy (an editor may insert an approve intent directly again; nothing reads it).
--   3. Puts finish_scene_regeneration(...) back to 0085's body, byte for byte, with the grants 0085 gave it.
--   4. Puts audit_action_allowed(text) back to 0110's body (video.approve becomes unknown again).
--
-- WHAT IT KEEPS ON PURPOSE. The seven videos columns, review_intents.approved_cut_sha256 and their checks: they are the record
-- of who approved which cut, nothing reads them once the functions are gone, and dropping a column is not undoable.
-- Videos that are in review_state 'approved' stay approved (that column is 0004's); this file never rewrites a decision.
--
-- CHECK BEFORE YOU RUN IT: this file puts two functions back to the text they had before 0112. If a later migration has
-- redefined either, running this would silently undo that later change. Compare first:
--     select pg_get_functiondef('public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)'::regprocedure);
--     select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure);
-- The only differences from this file's text should be the lines marked 0112 (and video.approve in the list).
--
-- tests/security/test_sec_approve_video.py applies this file to the lab database and then re-applies 0112.

begin;
set local lock_timeout = '5s';

drop function if exists public.approve_video_publish(text, text, jsonb);
drop function if exists public.video_approve_access(text);
drop function if exists public.video_real_member(uuid, text);
drop function if exists public.video_publish_refusal(text, text);
drop function if exists public.video_approve_refusal(text, text);

-- 0033's policy.
drop policy if exists review_intents_insert on public.review_intents;
create policy review_intents_insert on public.review_intents
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('editor'))
    and (video_id is null
         or exists (select 1 from public.videos v
                     where v.video_id = review_intents.video_id
                       and v.channel_id = review_intents.channel_id))
  );

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
    update public.videos set review_state = 'pending'
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

revoke all on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) to service_role;

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
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

commit;
