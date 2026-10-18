-- rollback_0110_marketing_promo_custom.sql — takes migration 0110 out again. OWNER-APPLY: paste into the Supabase
-- SQL editor. Nothing in the app runs it. It is the same transaction a forward "undo" migration would be.
--
-- WHEN YOU NEED IT. Almost never: 0110 is dormant (nothing calls owner_marketing_create or marketing_draft_upsert_v2).
-- To stop posting WITHOUT this file:  update public.marketing_settings set enabled = false where id;
--
-- WHAT IT DOES.
--   1. Drops owner_marketing_create(text, jsonb, text, text) and marketing_draft_upsert_v2(...). The 0108 functions
--      (marketing_draft_upsert with 9 arguments, claim_marketing_post, complete_marketing_post, the owner_marketing_*
--      five) were never changed by 0110 and are left alone.
--   2. Puts audit_action_allowed(text) back to 0108's body (marketing.create becomes unknown again).
--   3. Narrows kind, source_ref and the key shape back to 0108's rules, BUT ONLY while no promo or custom post exists.
--      A post is never deleted (its key is what stops a repeat), and the narrow CHECK would refuse a table that holds
--      one, so when such a row exists the three CHECKs are left as 0110 made them and a NOTICE says so. Nothing is lost
--      and nothing breaks: the rows stay readable and finish their life (expire, reject) as before.
--      To remove the rows themselves an owner would have to disable the guard trigger, which this file will not do.
--
-- CHECK BEFORE YOU RUN IT: this file puts audit_action_allowed(text) back to 0108's body. If a later migration has
-- redefined that function (it is redefined whole in each migration that adds an action), running this file would
-- silently undo that later list. Compare first:
--     select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure);
-- If the list there holds names beyond 0108's and marketing.create, edit the body below to that list minus
-- marketing.create, or do not run this file.
--
-- tests/security/test_sec_marketing_promo.py applies this file to the lab database (with and without a promo row)
-- and then re-applies 0110.

begin;

drop function if exists public.owner_marketing_create(text, jsonb, text, text);
drop function if exists public.marketing_draft_upsert_v2(text, text, jsonb, text, jsonb, timestamptz, text, text, text);

do $$
begin
  if exists (select 1 from public.marketing_posts where kind in ('promo', 'custom')) then
    raise notice 'rollback 0110: promo or custom posts exist and are never deleted, so the kind, source_ref and key checks stay widened';
  else
    alter table public.marketing_posts drop constraint if exists marketing_posts_key_shape_check;
    alter table public.marketing_posts drop constraint if exists marketing_posts_kind_check;
    alter table public.marketing_posts add constraint marketing_posts_kind_check check (kind in ('news', 'showcase', 'price'));
    alter table public.marketing_posts drop constraint if exists marketing_posts_source_check;
    alter table public.marketing_posts add constraint marketing_posts_source_check
      check ((kind = 'news' and source_ref ~ '^pr:#[0-9]{1,7}$')
          or (kind = 'price' and source_ref ~ '^plan:[a-z0-9_.:,-]{1,100}$')
          or (kind = 'showcase' and source_ref ~ '^asset:[0-9a-f-]{36}$'));
  end if;
end $$;

-- 0108's body, verbatim.
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
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

commit;
