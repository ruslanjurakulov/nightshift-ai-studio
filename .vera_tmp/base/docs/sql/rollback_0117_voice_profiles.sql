-- rollback_0117_voice_profiles.sql — takes migration 0117 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the voice ownership rule refuses a write you must allow, or the custom-voice feature is being withdrawn.
-- READ THIS FIRST: after it, a cloned voice id is protected by NOTHING again (any id of the right shape passes, as before 0117),
-- so DELETE EVERY CLONE FIRST (delete_voice for each profile, and let the worker remove the provider copies), or accept that
-- anyone who knows a cloned voice's id can use it.
--
-- WHAT IT DOES, in one transaction:
--   1. Drops the two BEFORE INSERT triggers 0117 added (creative_jobs_voice_guard on creative_jobs, render_jobs_voice_guard on render_jobs).
--   2. Puts channels_config_guard() back to 0114's body, byte for byte (the trigger is neither dropped nor re-created: 0117 never touched it).
--   3. Puts audit_action_allowed() back to 0116's body, byte for byte (the voice.* names go; an audit row already written stays).
--   4. Drops every callable function 0117 added and the two trigger functions of step 1.
--   5. Drops the five voice_samples_* policies on storage.objects and voice_sample_slot_free() (nobody can upload a sample; the
--      bucket and its files stay).
--
-- WHAT IT KEEPS, on purpose: the six tables (user_voice_refs, voice_profiles, voice_consents, voice_deletion_records,
-- voice_clone_jobs, voice_channel_attachments) with their rows and their append-only / immutability triggers, and the
-- voice-samples bucket. They are the consent and deletion record; dropping them is a legal decision, not a rollback.
-- To remove them as well, after counsel agrees, drop the tables by hand.
--
-- CHECK BEFORE YOU RUN IT: step 2 and 3 put two functions back to the text they had before 0117. If a later migration has
-- redefined either, running this would silently undo that later change. Compare first:
--     select pg_get_functiondef('public.channels_config_guard()'::regprocedure);
--     select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure);
-- The only differences from this file's text should be the lines marked 0117 (and the voice.* line of the audit list).
--
-- tests/security/test_sec_voice_profiles.py applies this file to the lab database and re-applies 0117.

begin;
set local lock_timeout = '5s';

drop trigger if exists creative_jobs_voice_guard on public.creative_jobs;
drop trigger if exists render_jobs_voice_guard on public.render_jobs;

-- 0114's body.
create or replace function public.channels_config_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  controls constant text[] := array['publish_gate', 'require_two_person_publish', 'storyboard_review', 'auto_publish'];
  k        text;
  changed  text[] := '{}';
  org      uuid;
  o        jsonb;
  n        jsonb := case when jsonb_typeof(new.agent_config) = 'object' then new.agent_config else '{}'::jsonb end;
  lowering text[];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    o := '{}'::jsonb;
    org := new.org_id;
    if new.auto_publish is true then
      changed := changed || 'auto_publish'::text;
    end if;
    if coalesce(new.credential_ref, '{}'::jsonb) <> '{}'::jsonb or new.status is distinct from 'PAUSED' then
      raise exception 'a channel is created paused with no credential: use create_channel()'
        using errcode = '42501';
    end if;
  else
    o := case when jsonb_typeof(old.agent_config) = 'object' then old.agent_config else '{}'::jsonb end;
    org := old.org_id;
    if new.auto_publish is distinct from old.auto_publish then
      changed := changed || 'auto_publish'::text;
    end if;
    if new.credential_ref is distinct from old.credential_ref
       or new.status is distinct from old.status
       or new.channel_id is distinct from old.channel_id then
      raise exception 'a channel''s credential, status and id are changed through the channel functions only'
        using errcode = '42501';
    end if;
  end if;
  foreach k in array controls loop
    if (o -> k) is distinct from (n -> k) and not k = any (changed) then
      changed := changed || k;
    end if;
  end loop;
  if cardinality(changed) > 0 and not public.is_org_member(org, 'admin') then
    raise exception 'only an administrator of this organization may change: %', array_to_string(changed, ', ')
      using errcode = '42501';
  end if;
  -- 0114: the two keys that lower the platform label are a PLATFORM administrator's. A key is refused only when
  -- this write SETS it to a value the reader treats as lowering and the stored value was not already that exact
  -- value, so an unrelated edit of a channel that already has one (or a write that raises the label) still passes.
  lowering := '{}';
  foreach k in array public.channel_label_lowering(n) loop
    if (o -> k) is distinct from (n -> k) then
      lowering := lowering || k;
    end if;
  end loop;
  if cardinality(lowering) > 0 and not public.is_platform_admin() then
    raise exception 'ai_disclosure_lock: only a platform administrator may set: %', array_to_string(lowering, ', ')
      using errcode = '42501', hint = 'ai_disclosure_lock';
  end if;
  return new;
end
$$;

revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;
-- 0116's body.
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
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

drop policy if exists voice_samples_insert_own on storage.objects;
drop policy if exists voice_samples_closed_select on storage.objects;
drop policy if exists voice_samples_closed_update on storage.objects;
drop policy if exists voice_samples_closed_delete on storage.objects;
drop policy if exists voice_samples_closed_insert on storage.objects;
drop function if exists public.voice_sample_slot_free(text);

drop function if exists public.creative_jobs_voice_guard();
drop function if exists public.render_jobs_voice_guard();
drop function if exists public.channel_voice_config_problem(text, uuid, jsonb, jsonb);
drop function if exists public.voice_usable_by(uuid, text, uuid, text, text, text);
drop function if exists public.request_voice_clone(text, jsonb, text, boolean, text, uuid);
drop function if exists public.approve_voice(uuid);
drop function if exists public.attach_voice_to_channel(uuid, text, text);
drop function if exists public.detach_voice_from_channel(uuid, text);
drop function if exists public.delete_voice(uuid);
drop function if exists public.delete_voice_sample(uuid);
drop function if exists public.claim_voice_job(text);
drop function if exists public.finish_voice_clone(uuid, text, text, text, text, text, text);
drop function if exists public.finish_voice_task(uuid, text, boolean, text);
drop function if exists public.purge_voice_records(uuid);
drop function if exists public.my_voice_ref();
drop function if exists public.voice_caller_member(uuid, text);
drop function if exists public.voice_user_org_admin(uuid, uuid);
drop function if exists public.voice_owner_ref_for(uuid);
drop function if exists public.voice_id_norm(jsonb);
drop function if exists public.voice_phrase_hash(text);
drop function if exists public.voice_phrase_new();
drop function if exists public.voice_phrase_words();
drop function if exists public.voice_declarations_problem(jsonb);
drop function if exists public.voice_name_problem(text);
drop function if exists public.voice_name_norm(text);
drop function if exists public.voice_real_person_patterns();


commit;
