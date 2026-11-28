-- Owner-applied rollback. Restore gates before removing acceptance records.
-- Restore only acceptances for the current vendor identity.
-- Preserve newer gates from the registry and hide any affected model on sale.
-- Audit rows remain in the audit log.
begin;
set local lock_timeout = '5s';

do $$
declare
  body_hash text;
begin
  select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into body_hash
    from pg_proc where oid = to_regprocedure('public.audit_action_allowed(text)');
  if body_hash is null or body_hash not in ('0789d4af8fabee6208c8f6830fa73547') then
    raise exception 'rollback 0227: unexpected audit_action_allowed() body (md5 %)', body_hash;
  end if;
end
$$;

-- Exclude concurrent registry writes while restoring the gates and dropping
-- the mutation functions. The access exclusive lock also blocks the trigger.
lock table public.model_registry in access exclusive mode;
drop trigger model_terms_acceptance_guard on public.model_registry;

update public.model_registry m
   set availability = case when m.availability in ('beta', 'ga') then 'hidden' else m.availability end,
       spec = jsonb_set(m.spec, '{terms_gate}', to_jsonb(coalesce(nullif(m.spec ->> 'terms_gate', ''), a.gate)))
  from public.model_terms_acceptance a
 where a.model_id = m.id
   and a.provider = m.provider and a.adapter = m.adapter
   and a.vendor_model is not distinct from m.spec ->> 'vendor_model'
   and a.used_up_at is null;

drop function public.owner_accept_model_terms(text, text, text);
drop function public.owner_revoke_model_terms(text);
drop function public.model_terms_acceptance_admin();
drop function public.model_terms_acceptance_guard();
drop table public.model_terms_acceptance;

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
    -- 0116: the per-channel switch, a queued request, the worker's results, a person's retry.
    'channel.publish_on_approve', 'video.publish_queued', 'video.visibility_applied', 'video.visibility_refused',
    'video.visibility_failed', 'video.visibility_expired', 'video.visibility_retry',
    -- 0117: a custom voice (request, the worker's result, approve, attach, detach, delete, sample delete, purge).
    'voice.clone_request', 'voice.clone_result', 'voice.approve', 'voice.attach', 'voice.detach', 'voice.delete',
    'voice.sample_delete', 'voice.purge',
    -- 0145: a person sets a video's YouTube "made for kids" declaration (set_video_made_for_kids).
    'video.made_for_kids',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

commit;
