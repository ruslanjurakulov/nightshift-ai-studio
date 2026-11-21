-- 0203 (placeholder number; the final one is assigned at merge) — the audit row of a switch between the accounts kept in
-- one browser (command-center/lib/device-accounts.ts, app/api/account/accounts/switch).
--
-- WHY: the switch route recorded `account.switch` by inserting into app_audit_log as the account switched TO, and the row
-- could never be written: 0087's app_audit_log_stamp refuses any action outside audit_action_allowed() (0145 has no
-- `account.switch`), and 0033's insert policy refuses `channel_id is null` to anyone who is not a platform admin. Found in
-- review (Lens H1, Breach M1) before release.
--
-- WHAT:
-- 1. audit_action_allowed(): 0145's list verbatim, plus 'account.switch'. Nothing else is added or removed.
-- 2. audit_account_switch(p_from uuid): the one way to write that row. SECURITY DEFINER, so 0033's policy does not apply
--    to it; the caller can name only the account it switched FROM. The account switched TO is always the caller
--    (auth.uid()), so nobody can write a row about another person's arrival. p_from is recorded, never used to grant or
--    look anything up. A switch to the same account is refused. At most 60 rows an hour per person (take_web_rate, 0042/
--    0087), so the call cannot be used to flood the log.
--    The stamp trigger still runs on the insert (the session role is still `authenticated`): it checks the action against
--    the list above and stamps actor_email and at, as on every other row.
-- 3. EXECUTE to authenticated only; revoked from public and anon.
--
-- NOT CHANGED: app_audit_log, its policies, app_audit_log_stamp, logAudit, every other audit action.
-- Additive: re-running restores the same end state. Rollback: drop function public.audit_account_switch(uuid), and re-run
-- 0145's audit_action_allowed definition.

begin;

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
    -- 0203: a person switches between the accounts kept in one browser (audit_account_switch).
    'account.switch',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

create or replace function public.audit_account_switch(p_from uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_from is not null and p_from = uid then
    raise exception 'a switch is between two accounts' using errcode = '22023';
  end if;
  if not public.take_web_rate('account_switch', 60, 3600) then
    raise exception 'too many account switches' using errcode = '54000';
  end if;
  insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
  values (uid, 'account.switch', uid::text, jsonb_build_object('from', p_from, 'to', uid), null);
end
$$;

revoke all on function public.audit_account_switch(uuid) from public, anon;
grant execute on function public.audit_account_switch(uuid) to authenticated;

-- The end state, asserted: a later edit that drops any of it fails here instead of in production.
do $$
begin
  if not public.audit_action_allowed('account.switch') or not public.audit_action_allowed('video.made_for_kids') then
    raise exception '0203: audit_action_allowed() must keep 0145''s list and add account.switch';
  end if;
  if has_function_privilege('anon', 'public.audit_account_switch(uuid)', 'execute') then
    raise exception '0203: anon must not execute audit_account_switch';
  end if;
  if not has_function_privilege('authenticated', 'public.audit_account_switch(uuid)', 'execute') then
    raise exception '0203: authenticated must execute audit_account_switch';
  end if;
end
$$;

commit;
