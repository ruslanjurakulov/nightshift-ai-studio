-- rollback_0108_marketing_posts.sql — takes migration 0108 out again. OWNER-APPLY: paste into the Supabase
-- SQL editor. Nothing in the app runs it. It is the same transaction a forward "undo" migration would be.
--
-- WHEN YOU NEED IT. Almost never: 0108 is dormant (marketing_settings.enabled is false, nothing calls the
-- functions, no trigger sits on an existing table). To stop posting WITHOUT this file:
--     update public.marketing_settings set enabled = false;
-- Use this file only to remove the objects completely. It DELETES every post record, including the memory
-- of which news items were already announced (copy them first: select * from public.marketing_posts;).
-- Audit rows already written with the marketing.* actions stay in app_audit_log and security_events.
--
-- WHAT IT DOES. Drops the three tables (their triggers, indexes and the one policy go with them), every
-- function 0108 added, and puts audit_action_allowed(text) back to 0107's body (the marketing.* and
-- showcase.* actions become unknown again). It touches nothing else: 0108 changed no existing table,
-- policy, grant or function.
--
-- tests/security/test_sec_marketing_posts.py applies this file to the lab database and then re-applies 0108.

begin;

drop table if exists public.marketing_posts;
drop table if exists public.showcase_assets;
drop table if exists public.marketing_settings;

drop function if exists public.owner_marketing_get();
drop function if exists public.owner_marketing_edit(uuid, jsonb);
drop function if exists public.owner_marketing_approve(uuid, text);
drop function if exists public.owner_marketing_reject(uuid, text);
drop function if exists public.owner_marketing_kill(boolean, text);
drop function if exists public.marketing_draft_upsert(text, text, jsonb, text, jsonb, timestamptz, text, text);
drop function if exists public.claim_marketing_post(text, integer, text);
drop function if exists public.complete_marketing_post(uuid, text, text, text, integer, text);
drop function if exists public.marketing_cap_used();
drop function if exists public.marketing_posts_guard();
drop function if exists public.marketing_posts_no_delete();
drop function if exists public.marketing_settings_no_delete();
drop function if exists public.marketing_settings_stamp();
drop function if exists public.marketing_settings_trail();
drop function if exists public.marketing_texts_ok(jsonb, boolean);
drop function if exists public.marketing_post_hash(text, text, jsonb, text);

-- 0107's body, verbatim.
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
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

commit;
