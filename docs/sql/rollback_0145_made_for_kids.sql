-- rollback_0145_made_for_kids.sql — takes migration 0145 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs
-- it.
--
-- WHEN YOU NEED IT. If the per-video "made for kids" switch or the run's made_for_kids must be withdrawn. The pipeline keeps declaring the
-- audience without it (modules/made_for_kids.py decides from the channel, the series and the look; a database without the columns only
-- loses the record), so withdrawing this never makes an upload declare a kids video "not for kids".
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if a live body is not 0145's (a later change would be undone), or if a render_jobs row that has not
--      finished carries a `made_for_kids` param (0122's validator would refuse the row on its next UPDATE: a CHECK is evaluated again on
--      every update, and the worker updates a job it runs).
--   1. Puts render_job_params_valid() back to 0122's body, audit_action_allowed() back to 0117's and approve_video_publish() back to
--      0116's, byte for byte, and render_jobs_insert back to 0076's policy. Approving then no longer asks for the audience answer.
--   2. Drops set_video_made_for_kids() (both signatures).
--
-- WHAT IT KEEPS, on purpose: the seven videos columns and their checks. They are a record of what each video declared and of who confirmed
-- "not made for kids" for a kids video; a rollback does not erase that. Nothing writes the person's columns once the function is gone.
--
-- CHECK BEFORE YOU RUN IT: compare the live bodies with this file's (the only differences should be the lines marked 0145):
--     select pg_get_functiondef('public.render_job_params_valid(jsonb,text)'::regprocedure);
--     select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure);
--
-- tests/security/test_sec_made_for_kids.py applies this file to the lab database and re-applies 0145.

begin;
set local lock_timeout = '5s';

do $$
declare
  v text;
  a text;
  p text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into v
    from pg_proc p where p.oid = to_regprocedure('public.render_job_params_valid(jsonb, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into a
    from pg_proc p where p.oid = to_regprocedure('public.audit_action_allowed(text)');
  if v is distinct from 'f6a858e8b279acad752d069f893d84ed' then
    raise exception 'rollback 0145: render_job_params_valid() is not 0145''s body (md5 %): read the live body first', v;
  end if;
  if a is distinct from 'b29589ccc124c05b32097d5cfe989434' then
    raise exception 'rollback 0145: audit_action_allowed() is not 0145''s body (md5 %): read the live body first', a;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into p
    from pg_proc p where p.oid = to_regprocedure('public.approve_video_publish(text, text, jsonb)');
  if p is distinct from 'f9baef42b10c920d9c5b1086ac206c30' then
    raise exception 'rollback 0145: approve_video_publish() is not 0145''s body (md5 %): read the live body first', p;
  end if;
  if exists (select 1 from public.render_jobs where params ? 'made_for_kids' and status in ('queued', 'running')) then
    raise exception 'rollback 0145: a queued or running job carries made_for_kids; let it finish (or cancel it) first';
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

-- 0116's approve_video_publish, byte for byte (create or replace keeps its grants: authenticated only).
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
  v_switch boolean;   -- 0116
  v_req    bigint;    -- 0116
  v_out    jsonb;     -- 0116
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

  -- 0116: on a channel whose "publish when approved" switch is ON, this approval act is queued for the worker, once (the key is
  -- the act: video, cut and the decision's own time). With the switch off nothing below runs and the answer is 0112's.
  select c.publish_on_approve into v_switch from public.channels c where c.channel_id = v.channel_id;
  if v_switch is true then
    insert into public.video_visibility_requests
      (org_id, channel_id, video_id, intent_id, approved_cut_sha256, decided_by, decided_at, expires_at)
    values (public.channel_org(v.channel_id), v.channel_id, v.video_id, i.id, p_cut_sha256, uid, now(), v_exp)
    on conflict (video_id, approved_cut_sha256, decided_at) do nothing
    returning id into v_req;
    if v_req is not null then
      insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
      values (uid, 'video.publish_queued', v.video_id,
              jsonb_build_object('video_id', v.video_id, 'cut_sha256', p_cut_sha256, 'request_id', v_req, 'expires_at', v_exp),
              v.channel_id);
    end if;
  end if;
  v_out := jsonb_build_object('ok', true, 'already', false, 'video_id', v.video_id, 'cut_sha256', p_cut_sha256,
                              'decided_at', now(), 'expires_at', v_exp, 'intent_id', i.id);
  if v_req is not null then
    v_out := v_out || jsonb_build_object('queued', true, 'request_id', v_req);
  end if;
  return v_out;
end
$$;

drop function if exists public.set_video_made_for_kids(text, boolean, boolean, text);
drop function if exists public.set_video_made_for_kids(text, boolean, boolean);

commit;
