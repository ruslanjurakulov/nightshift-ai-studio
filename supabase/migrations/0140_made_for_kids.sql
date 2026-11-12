-- 0140_made_for_kids.sql — YouTube's "made for kids" declaration, per video: recorded, decided by a person with a confirmation, and
-- carried by a run. docs/MIGRATIONS.md "0140". LIVE ON APPLY: it replaces two live functions and one live policy; read "WHAT TO VERIFY
-- BEFORE YOU APPLY" below first.
--
-- WHY. Every upload sent status.selfDeclaredMadeForKids = false (modules/youtube_uploader.py), while the product offers a "Kids story"
-- format, kids looks and kids channels: a children's video declared "not made for kids" breaks YouTube's policy and COPPA. The pipeline
-- now decides the declaration (modules/made_for_kids.py); what it needs from the database is the three things below, and none of them
-- fits a column or a JSON field that exists: `videos` is written by the bot's service key only, and a person's choice must be stored
-- with who made it.
--
-- WHAT THIS ADDS
--   videos.made_for_kids         boolean: what the upload declared, or what a person decided for the video since. NULL = not recorded
--                                (every row before 0140). Written by the pipeline (modules/video_review.py) and set_video_made_for_kids.
--   videos.kids_content          boolean: the run found kids content (the kids format, a kids series, a kids look, a kids channel).
--                                Written by the pipeline only.
--   videos.made_for_kids_off_by  uuid / made_for_kids_off_at timestamptz: the person who confirmed "not made for kids" for kids content,
--                                and when. A CHECK holds the rule for every writer: kids content is declared not for kids ONLY with them,
--                                and they exist only for that.
--   set_video_made_for_kids(p_video_id, p_made_for_kids, p_confirm_off) -> jsonb   SIGNED-IN, NOT anon, NOT the service key.
--       The review panel's switch. The approver's rule (video_approve_access, 0112: an administrator who is a real member of the
--       video's organization), rate limited (take_web_rate 'video_made_for_kids', 20 per 10 minutes), the row locked. Refuses:
--       bad_value (NULL), rate_limited, already_public (YouTube holds the declaration; change it in YouTube Studio), approval_live
--       (a live approval was given for the video as declared), confirm_required (kids content to "not for kids" without
--       p_confirm_off = true). Audited as video.made_for_kids (who, the video, the old and new value, kids content, confirmed).
--
-- WHAT THIS REPLACES (each is its latest body, character for character, plus lines marked `-- 0140`)
--   render_job_params_valid(jsonb, text)   0122's body + `made_for_kids` in the allowed list and one block: only `true`, never on a repair.
--   audit_action_allowed(text)             0117's body + 'video.made_for_kids'.
--   policy render_jobs_insert              0076's policy + 'made_for_kids' in the list of keys a browser's "Run now" row may carry (its
--                                          value is held to true by render_job_params_valid in render_jobs_params_check).
--
-- WHAT THIS DOES NOT DO. It writes no row and rewrites no row (four nullable columns, no default). It does not change who may approve,
-- publish or make anything public, privacy, the publish gate's rules, credits, holds or prices. A run's `made_for_kids` can only turn
-- the declaration ON. Nothing calls YouTube.
--
-- NUMBER. 0140: the highest on main is 0139 (the operator's preview of a hidden model, #694), which replaces creative_price only and
-- names nothing of this file's. 0135 is unused.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only, the SQL editor on the live project). md5 of each body with every run of white space read
-- as one space; the file checks them itself and raises on any other value:
--     select 'render_job_params_valid' as fn, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) as md5
--       from pg_proc where oid = 'public.render_job_params_valid(jsonb, text)'::regprocedure
--     union all select 'audit_action_allowed', md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.audit_action_allowed(text)'::regprocedure;
--   expected BEFORE (0122 and 0117 applied, 0140 not):
--     render_job_params_valid      a9367e46ea79e8d57ce1c876333b5508
--     audit_action_allowed         d622e052a695fef125d3b2b621cdda27
--   expected AFTER (the last block of this file asserts the same, inside the transaction):
--     render_job_params_valid      641805f6dfa3ff6764a56f257ef91ade
--     audit_action_allowed         cb71f41c2a8fe645508c757f4c6f3af7
--     set_video_made_for_kids      7bc41789e7c3b3255ac25a3f2af246ca
--   If a live value is anything else, STOP: something was applied by hand, and replacing the body would silently undo it.
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1). Additive and
-- idempotent: a second run finds this file's bodies and changes nothing. Rollback: docs/sql/rollback_0140_made_for_kids.sql.
-- REQUIRES 0076 (render_jobs_insert), 0087 (take_web_rate, the audit stamp), 0112 (video_approve_access, the approval columns),
-- 0117 (audit_action_allowed's latest body) and 0122 (render_job_params_valid's latest body).

set local lock_timeout = '5s';

do $$
declare
  v text;
  a text;
  s text;
begin
  if to_regprocedure('public.video_approve_access(text)') is null
     or not exists (select 1 from pg_attribute where attrelid = 'public.videos'::regclass and attname = 'approved_cut_sha256' and not attisdropped) then
    raise exception '0140 needs 0112_approve_video_publish.sql (video_approve_access, the approval columns): apply it first';
  end if;
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null then
    raise exception '0140 needs take_web_rate (0087): apply it first';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'render_jobs' and policyname = 'render_jobs_insert'
                    and with_check like '%scene_regeneration_id IS NULL%') then
    raise exception '0140 needs 0076''s render_jobs_insert policy: apply 0076 first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into v
    from pg_proc p where p.oid = to_regprocedure('public.render_job_params_valid(jsonb, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into a
    from pg_proc p where p.oid = to_regprocedure('public.audit_action_allowed(text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into s
    from pg_proc p where p.oid = to_regprocedure('public.set_video_made_for_kids(text, boolean, boolean)');
  if v is null or v <> all (array['a9367e46ea79e8d57ce1c876333b5508', '641805f6dfa3ff6764a56f257ef91ade']) then
    raise exception '0140 found a render_job_params_valid() that is neither 0122''s body nor 0140''s (md5 %): read the live body first', v;
  end if;
  if a is null or a <> all (array['d622e052a695fef125d3b2b621cdda27', 'cb71f41c2a8fe645508c757f4c6f3af7']) then
    raise exception '0140 found an audit_action_allowed() that is neither 0117''s body nor 0140''s (md5 %): read the live body first', a;
  end if;
  if s is not null and s <> '7bc41789e7c3b3255ac25a3f2af246ca' then
    raise exception '0140 found a set_video_made_for_kids() that is not this file''s body (md5 %): read the live body first', s;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The record: four nullable columns on videos
-- ───────────────────────────────────────────────────────────────────────────

alter table public.videos
  add column if not exists made_for_kids boolean,
  add column if not exists kids_content boolean,
  add column if not exists made_for_kids_off_by uuid,
  add column if not exists made_for_kids_off_at timestamptz;

comment on column public.videos.made_for_kids is
  'YouTube''s status.selfDeclaredMadeForKids for this video (migration 0140): what the upload declared, or what a person decided since (set_video_made_for_kids). NULL = not recorded (rows before 0140).';
comment on column public.videos.kids_content is
  'The run found kids content: the kids format, a kids series, a kids Style Library look or a kids channel (modules/made_for_kids.py). Written by the pipeline only. NULL = not recorded.';
comment on column public.videos.made_for_kids_off_by is
  'The person who confirmed "not made for kids" for kids content (set_video_made_for_kids with p_confirm_off). Set only for that, and required for it.';
comment on column public.videos.made_for_kids_off_at is
  'When made_for_kids_off_by confirmed it.';

-- Kids content is declared "not made for kids" only with a person's confirmation, and a confirmation exists only for that. Every row
-- before 0140 has all four NULL and passes, so the check is validated at once.
alter table public.videos drop constraint if exists videos_made_for_kids_confirmed_check;
alter table public.videos
  add constraint videos_made_for_kids_confirmed_check check (
    (made_for_kids_off_by is null) = (not coalesce(kids_content is true and made_for_kids is false, false))
    and (made_for_kids_off_by is null) = (made_for_kids_off_at is null)
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 2. A person's decision: set_video_made_for_kids
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_video_made_for_kids(p_video_id text, p_made_for_kids boolean, p_confirm_off boolean)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  v      public.videos;
  access text;
  v_kids boolean;
  v_off  boolean;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_video_id is null or p_video_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The approver's rule (0112): the channel, and with it the organization, come from the VIDEO row; an administrator who is a real
  -- member of that organization may decide, nobody else (a platform admin is not one of a customer's).
  access := public.video_approve_access(p_video_id);
  if access = 'not_found' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if access <> 'ok' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_made_for_kids is null then
    return jsonb_build_object('ok', false, 'error', 'bad_value');
  end if;
  if not public.take_web_rate('video_made_for_kids', 20, 600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into v from public.videos where video_id = p_video_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- Public already: YouTube holds what it holds, and a record that said otherwise would be a lie. Changed in YouTube Studio.
  if v.privacy = 'public' then
    return jsonb_build_object('ok', false, 'error', 'already_public');
  end if;
  -- A live approval was given for the video as it was declared; the publish-when-approved worker sends that declaration.
  if v.review_state = 'approved' and v.approved_cut_sha256 is not null and v.approved_cut_sha256 is not distinct from v.cut_sha256
     and v.approval_expires_at > now() then
    return jsonb_build_object('ok', false, 'error', 'approval_live');
  end if;
  v_kids := coalesce(v.kids_content, false);
  v_off := v_kids and not p_made_for_kids;
  -- Kids content declared "not made for kids": only in so many words. The column check holds the same rule for every writer.
  if v_off and p_confirm_off is distinct from true then
    return jsonb_build_object('ok', false, 'error', 'confirm_required');
  end if;
  if v.made_for_kids is not distinct from p_made_for_kids and (v.made_for_kids_off_by is not null) = v_off then
    return jsonb_build_object('ok', true, 'already', true, 'video_id', v.video_id, 'made_for_kids', p_made_for_kids,
                              'kids_content', v_kids, 'confirmed_off', v_off);
  end if;
  update public.videos
     set made_for_kids = p_made_for_kids,
         made_for_kids_off_by = case when v_off then uid end,
         made_for_kids_off_at = case when v_off then now() end
   where video_id = v.video_id;
  insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
  values (uid, 'video.made_for_kids', v.video_id,
          jsonb_build_object('video_id', v.video_id, 'made_for_kids', p_made_for_kids, 'was', v.made_for_kids,
                             'kids_content', v_kids, 'confirmed_off', v_off),
          v.channel_id);
  return jsonb_build_object('ok', true, 'already', false, 'video_id', v.video_id, 'made_for_kids', p_made_for_kids,
                            'kids_content', v_kids, 'confirmed_off', v_off);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. A run's made_for_kids: the params validator and the browser's insert policy
-- ───────────────────────────────────────────────────────────────────────────

-- render_job_params_valid: 0122's body verbatim, plus the lines marked 0140 (one key in the allowed list, one block). Still IMMUTABLE: it sits
-- in the render_jobs_params_check CHECK.

create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','tts_model','voice_id','resume','repair_scenes',
                          'publish_hint','series','template','made_for_kids'];
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
  -- 0140: YouTube's "made for kids" for this run (the Kids story format, the Create form's switch). Only true: a run can turn the
  -- declaration on and never off (modules/made_for_kids.py); never on a repair, which re-renders a run that is already made. A planning
  -- job takes no such key (the series_plan rule below lists what it may carry).
  if p ? 'made_for_kids' and (p -> 'made_for_kids' is distinct from 'true'::jsonb or p_kind = 'repair') then
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

-- 0076's insert policy, verbatim, plus 'made_for_kids' in the keys a browser's row may carry.
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
                        'tts_model','voice_id','publish_hint','made_for_kids']) = '{}'::jsonb
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The audit action list: 0117's body verbatim plus video.made_for_kids
-- ───────────────────────────────────────────────────────────────────────────

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
    -- 0140: a person sets a video's YouTube "made for kids" declaration (set_video_made_for_kids).
    'video.made_for_kids',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Who may do what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;
revoke all on function public.set_video_made_for_kids(text, boolean, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_video_made_for_kids(text, boolean, boolean) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
-- If any of this is false the whole file rolls back. It restates the pins above.
do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.render_job_params_valid(jsonb, text)'::regprocedure) <> '641805f6dfa3ff6764a56f257ef91ade'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.audit_action_allowed(text)'::regprocedure) <> 'cb71f41c2a8fe645508c757f4c6f3af7'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.set_video_made_for_kids(text, boolean, boolean)'::regprocedure) <> '7bc41789e7c3b3255ac25a3f2af246ca' then
    raise exception '0140 end state: a function does not hold this file''s body';
  end if;
  if not has_function_privilege('authenticated', 'public.set_video_made_for_kids(text, boolean, boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_video_made_for_kids(text, boolean, boolean)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.set_video_made_for_kids(text, boolean, boolean)', 'EXECUTE') then
    raise exception '0140 end state: set_video_made_for_kids() must be executable by authenticated only';
  end if;
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid = 'public.set_video_made_for_kids(text, boolean, boolean)'::regprocedure and a.grantee = 0) then
    raise exception '0140 end state: set_video_made_for_kids() is executable by public';
  end if;
  if (select count(*) from pg_attribute
       where attrelid = 'public.videos'::regclass and not attisdropped and not attnotnull
         and ((attname in ('made_for_kids', 'kids_content') and atttypid = 'boolean'::regtype)
              or (attname = 'made_for_kids_off_by' and atttypid = 'uuid'::regtype)
              or (attname = 'made_for_kids_off_at' and atttypid = 'timestamptz'::regtype))) <> 4 then
    raise exception '0140 end state: the four videos columns are not there with their types';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.videos'::regclass and conname = 'videos_made_for_kids_confirmed_check' and convalidated) then
    raise exception '0140 end state: videos_made_for_kids_confirmed_check is missing or not validated';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'render_jobs' and policyname = 'render_jobs_insert'
                    and with_check like '%made_for_kids%' and with_check like '%scene_regeneration_id IS NULL%') then
    raise exception '0140 end state: render_jobs_insert does not carry made_for_kids';
  end if;
  if not public.render_job_params_valid('{"topic":"t","made_for_kids":true}', 'daily')
     or public.render_job_params_valid('{"topic":"t","made_for_kids":false}', 'daily')
     or public.render_job_params_valid('{"topic":"t","made_for_kids":"true"}', 'daily')
     or public.render_job_params_valid('{"repair_scenes":"s001","made_for_kids":true}', 'repair')
     or not public.audit_action_allowed('video.made_for_kids') then
    raise exception '0140 end state: made_for_kids is not checked as this file says';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (the SQL editor on the live project, after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     has_function_privilege('authenticated', 'public.set_video_made_for_kids(text,boolean,boolean)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.set_video_made_for_kids(text,boolean,boolean)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.set_video_made_for_kids(text,boolean,boolean)', 'EXECUTE') as callable_by_users_only,
--     public.render_job_params_valid('{"made_for_kids":true}', 'daily')
--       and not public.render_job_params_valid('{"made_for_kids":false}', 'daily') as run_param_true_only,
--     (select count(*) from public.videos where made_for_kids_off_by is not null) >= 0 as columns_there;
--
-- Kids videos a person declared not made for kids (with who confirmed it):
--   select video_id, channel_id, made_for_kids_off_by, made_for_kids_off_at from public.videos where made_for_kids_off_by is not null;
