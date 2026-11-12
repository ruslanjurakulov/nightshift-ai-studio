-- rollback_0140_made_for_kids.sql — takes migration 0140 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs
-- it.
--
-- WHEN YOU NEED IT. If the per-video "made for kids" switch or the run's made_for_kids must be withdrawn. The pipeline keeps declaring the
-- audience without it (modules/made_for_kids.py decides from the channel, the series and the look; a database without the columns only
-- loses the record), so withdrawing this never makes an upload declare a kids video "not for kids".
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if a live body is not 0140's (a later change would be undone), or if a render_jobs row that has not
--      finished carries a `made_for_kids` param (0122's validator would refuse the row on its next UPDATE: a CHECK is evaluated again on
--      every update, and the worker updates a job it runs).
--   1. Puts render_job_params_valid() back to 0122's body and audit_action_allowed() back to 0117's, byte for byte, and render_jobs_insert
--      back to 0076's policy.
--   2. Drops set_video_made_for_kids().
--
-- WHAT IT KEEPS, on purpose: the four videos columns and their check. They are a record of what each video declared and of who confirmed
-- "not made for kids" for a kids video; a rollback does not erase that. Nothing writes the person's columns once the function is gone.
--
-- CHECK BEFORE YOU RUN IT: compare the live bodies with this file's (the only differences should be the lines marked 0140):
--     select pg_get_functiondef('public.render_job_params_valid(jsonb,text)'::regprocedure);
--     select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure);
--
-- tests/security/test_sec_made_for_kids.py applies this file to the lab database and re-applies 0140.

begin;
set local lock_timeout = '5s';

do $$
declare
  v text;
  a text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into v
    from pg_proc p where p.oid = to_regprocedure('public.render_job_params_valid(jsonb, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into a
    from pg_proc p where p.oid = to_regprocedure('public.audit_action_allowed(text)');
  if v is distinct from '641805f6dfa3ff6764a56f257ef91ade' then
    raise exception 'rollback 0140: render_job_params_valid() is not 0140''s body (md5 %): read the live body first', v;
  end if;
  if a is distinct from 'cb71f41c2a8fe645508c757f4c6f3af7' then
    raise exception 'rollback 0140: audit_action_allowed() is not 0140''s body (md5 %): read the live body first', a;
  end if;
  if exists (select 1 from public.render_jobs where params ? 'made_for_kids' and status in ('queued', 'running')) then
    raise exception 'rollback 0140: a queued or running job carries made_for_kids; let it finish (or cancel it) first';
  end if;
end $$;

create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','tts_model','voice_id','resume','repair_scenes',
                          'publish_hint','series','template'];
  has_repair boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(allowed)) then
      return false;
    end if;
  end loop;

  foreach k in array array['topic','niche','language','visual_style','repair_scenes'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'string' then
      return false;
    end if;
  end loop;
  if length(coalesce(p ->> 'topic', '')) > 300
     or length(coalesce(p ->> 'niche', '')) > 120
     or length(coalesce(p ->> 'language', '')) > 40
     or length(coalesce(p ->> 'visual_style', '')) > 300
     or length(coalesce(p ->> 'repair_scenes', '')) > 120 then
    return false;
  end if;

  if p ? 'duration' then
    if jsonb_typeof(p -> 'duration') <> 'number' then
      return false;
    end if;
    if (p ->> 'duration')::numeric <> trunc((p ->> 'duration')::numeric)
       or (p ->> 'duration')::numeric not between 30 and 3600 then
      return false;
    end if;
  end if;

  if p ? 'privacy' and (jsonb_typeof(p -> 'privacy') <> 'string'
                        or p ->> 'privacy' not in ('private', 'unlisted', 'public')) then
    return false;
  end if;
  if p ? 'video_provider' and (jsonb_typeof(p -> 'video_provider') <> 'string'
      or p ->> 'video_provider' not in ('minimax','higgsfield','kling','veo','seedance','wan')) then
    return false;
  end if;
  if p ? 'image_provider' and (jsonb_typeof(p -> 'image_provider') <> 'string'
      or p ->> 'image_provider' not in ('pexels','leonardo','gpt-image','nano-banana',
                                         'flux','ideogram','fal')) then
    return false;
  end if;
  if p ? 'tts_model' and (jsonb_typeof(p -> 'tts_model') <> 'string'
      or p ->> 'tts_model' not in ('eleven_v3','eleven_multilingual_v2',
                                   'eleven_flash_v2_5','eleven_turbo_v2_5')) then
    return false;
  end if;
  if p ? 'voice_id' and (jsonb_typeof(p -> 'voice_id') <> 'string'
      or p ->> 'voice_id' !~ '^[A-Za-z0-9]{20}$') then
    return false;
  end if;
  -- 0029: which account the video is for — a hint, never an instruction.
  if p ? 'publish_hint' and (jsonb_typeof(p -> 'publish_hint') <> 'string'
      or p ->> 'publish_hint' !~ '^(youtube|instagram|tiktok):[A-Za-z0-9._-]{1,128}$') then
    return false;
  end if;
  -- 0120: which series an episode's run belongs to. A slug (the shape modules/series.py accepts), so it can name nothing else: no path, no
  -- flag, no line break. Never on a repair, which re-renders scenes of a run that is already made.
  if p ? 'series' and (jsonb_typeof(p -> 'series') <> 'string'
                       or p ->> 'series' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
                       or p_kind = 'repair') then
    return false;
  end if;
  -- 0122: the format of a planning job. A string, one of the closed list, and only on a series_plan job (an ordinary run, a repair and
  -- the API functions take none). `is distinct from`, so a NULL kind cannot slip past.
  if p ? 'template' and (jsonb_typeof(p -> 'template') <> 'string'
                         or p ->> 'template' not in ('myth_vs_fact', 'top5_countdown', 'one_question_one_answer')
                         or p_kind is distinct from 'series_plan') then
    return false;
  end if;
  if p ? 'resume' and jsonb_typeof(p -> 'resume') <> 'boolean' then
    return false;
  end if;

  has_repair := length(btrim(coalesce(p ->> 'repair_scenes', ''))) > 0;
  -- 0120: a series-planning job is ONE model call about a topic. It carries the topic, the niche, the language and the series it is for, and
  -- nothing a run takes (no length, provider, voice, resume or repair). 0122 adds the format it was asked for.
  if p_kind = 'series_plan' then
    return not has_repair
       and (p - array['topic','niche','language','series','template']) = '{}'::jsonb
       and length(btrim(coalesce(p ->> 'topic', ''))) > 0
       and length(btrim(coalesce(p ->> 'niche', ''))) > 0;
  end if;
  if p_kind = 'repair' then
    return has_repair and coalesce((p ->> 'resume')::boolean, false) = false;
  end if;
  return not has_repair;
end
$$;

drop policy if exists render_jobs_insert on public.render_jobs;
create policy render_jobs_insert on public.render_jobs
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('admin'))
    and requested_by = auth.uid()
    and kind = 'daily'
    and status = 'queued'
    and attempts = 0
    and max_attempts = 3
    and worker_id is null
    and heartbeat_at is null
    and started_at is null
    and finished_at is null
    and error is null
    and api_hold_ref is null
    and scene_regeneration_id is null
    and (params - array['topic','niche','duration','language','visual_style',
                        'video_provider','image_provider',
                        'tts_model','voice_id','publish_hint']) = '{}'::jsonb
  );

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
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;
drop function if exists public.set_video_made_for_kids(text, boolean, boolean);

commit;
