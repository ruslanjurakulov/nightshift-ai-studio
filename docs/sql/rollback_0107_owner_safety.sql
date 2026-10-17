-- rollback_0107_owner_safety.sql — takes migration 0107 out again. OWNER-APPLY: paste into the Supabase
-- SQL editor. Nothing in the app runs it. It is the same transaction a forward "undo" migration would be.
--
-- WHEN YOU NEED IT. Almost never: 0107 is dormant (the gate flag is false, no screen calls the owner
-- functions, and the three logging triggers only write a row). Switching it off WITHOUT this file:
--     update public.owner_security_settings set admin_aal2_required = false;
-- Use this file only to remove the objects completely. It DELETES the security trail and the price
-- history (copy them first if you want them: select * from public.security_events;).
--
-- WHAT IT DOES. Drops the two triggers 0107 put on app_members and credit_prices, the three tables
-- (their own triggers go with them), every function 0107 added, and puts audit_action_allowed(text) back
-- to 0093's body (the credits.* / member.* / security.gate actions become unknown again; rows already
-- written with them stay). It touches nothing else: no policy, grant or other function was changed by 0107.
--
-- tests/security/test_sec_owner_safety.py applies this file to the lab database and then re-applies 0107.

begin;

drop trigger if exists app_members_security_trail on public.app_members;
drop trigger if exists credit_prices_security_trail on public.credit_prices;

drop index if exists public.credit_transactions_grant_created_idx;
drop table if exists public.credit_price_history;
drop table if exists public.security_events;
drop table if exists public.owner_security_settings;

drop function if exists public.owner_err(text, text, jsonb);
drop function if exists public.owner_security_append_only();
drop function if exists public.owner_security_settings_no_delete();
drop function if exists public.owner_security_settings_stamp();
drop function if exists public.security_event_log(text, text, text, jsonb);
drop function if exists public.owner_audit(text, text, jsonb, text);
drop function if exists public.admin_mfa_state(boolean);
drop function if exists public.owner_guard(text, integer);
drop function if exists public.owner_admin_factors();
drop function if exists public.owner_price_write(text, numeric, numeric, text, boolean, boolean, text, text, boolean, bigint);
drop function if exists public.app_members_security_trail();
drop function if exists public.credit_prices_security_trail();
drop function if exists public.owner_security_settings_trail();
drop function if exists public.admin_aal_ok();
drop function if exists public.owner_security_get();
drop function if exists public.enable_admin_mfa();
drop function if exists public.disable_admin_mfa();
drop function if exists public.owner_security_events(integer);
drop function if exists public.owner_grant_credits(uuid, numeric, text, text);
drop function if exists public.owner_reverse_grant(bigint, text);
drop function if exists public.owner_set_credit_price(text, numeric, numeric, text, text, boolean);
drop function if exists public.owner_delete_credit_price(text, text, boolean);
drop function if exists public.owner_restore_credit_price(bigint, text, boolean);
drop function if exists public.owner_add_member(text, text, text);
drop function if exists public.owner_set_member_role(uuid, text, text);
drop function if exists public.owner_remove_member(uuid, text);

-- 0093's body, verbatim.
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
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

commit;
