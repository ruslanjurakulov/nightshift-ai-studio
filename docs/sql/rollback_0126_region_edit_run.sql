-- rollback_0126_region_edit_run.sql — takes migration 0126 out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the region-edit run step must be withdrawn. Switch NIGHTSHIFT_REGION_EDITOR off on the Command Center AND the creative
-- worker first, so nothing new is queued.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if any of the three replaced live bodies is not 0126's (a later change would be undone), or if a region edit is
--      still in flight (a creative_jobs row with params.regions whose status is not final): the original finish_creative_job would settle it as
--      an ordinary edit, charging the whole hold whatever the regions did. Let those jobs end (they do on their own, in minutes) or cancel
--      them, then run this.
--   1. Puts creative_params_problem(), creative_quantity() and finish_creative_job() back to 0100's / 0099's / 0075's bodies, byte for byte,
--      and drops the two functions 0126 added. Finished region edits stay as rows (their params are history; no constraint re-reads them).
--
-- WHAT IT KEEPS: everything else. Credits already captured stay captured.
--
-- CHECK BEFORE YOU RUN IT: compare the three live bodies by hand with 0126's (pg_get_functiondef); the only differences from the pre-0126 text
-- should be the lines marked 0126. The script compares md5s itself and refuses on any other text.
--
-- tests/security/test_sec_region_edit_run.py applies this file to a copy of the lab database and re-applies 0126.

begin;
set local lock_timeout = '5s';

do $$
declare
  p text;
  q text;
  f text;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into p from pg_proc x where x.oid = 'public.creative_params_problem(text, jsonb)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into q from pg_proc x where x.oid = 'public.creative_quantity(text, jsonb)'::regprocedure;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into f
    from pg_proc x where x.oid = 'public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)'::regprocedure;
  if p is distinct from '6e815ae544cbb23d7f03845465f8ce6a' then
    raise exception 'rollback 0126: creative_params_problem() is not 0126''s body (md5 %): a later change would be undone; read the live body first', p;
  end if;
  if q is distinct from '02446e3ae600ea3504cdbea5a59829e8' then
    raise exception 'rollback 0126: creative_quantity() is not 0126''s body (md5 %): a later change would be undone; read the live body first', q;
  end if;
  if f is distinct from '6af709d6345f32e8eef6e9dd64d04c44' then
    raise exception 'rollback 0126: finish_creative_job() is not 0126''s body (md5 %): a later change would be undone; read the live body first', f;
  end if;
  if exists (select 1 from public.creative_jobs
              where capability = 'edit' and jsonb_typeof(params -> 'regions') = 'array'
                and status not in ('completed', 'failed', 'cancelled', 'expired')) then
    raise exception 'rollback 0126: a region edit is still in flight; let it end or cancel it first';
  end if;
end $$;

create or replace function public.creative_params_problem(p_capability text, p_params jsonb)
  returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k        text;
  timed    boolean := p_capability in ('t2v', 'sfx', 'music', 'i2v');
  -- The voice tools and captions (0072): a recording is the whole input.
  voiced   boolean := p_capability in ('voice_change', 'dub', 'captions');
  -- The video tools (0052): a video is the whole input.
  filmed   boolean := p_capability = 'video_upscale';
  -- The video ops (0100): a library video is the input, a video the output.
  clipped  boolean := p_capability in ('video_edit', 'video_reframe', 'video_remove_bg');
  -- Their words: video_edit is asked by its prompt alone; the others take none.
  unworded boolean := p_capability in ('video_reframe', 'video_remove_bg');
  -- video_reframe: the SHAPE is the ask (expand's rule for a video).
  reframed boolean := p_capability = 'video_reframe';
  -- describe (0055): a picture is the whole input; the output is text.
  told     boolean := p_capability = 'describe';
  sourced  boolean := p_capability in ('edit', 'i2v', 'upscale', 'remove_bg', 'voice_change', 'dub',
                                       'video_upscale', 'describe', 'captions',
                                       'expand', 'relight', 'erase',
                                       'video_edit', 'video_reframe', 'video_remove_bg');
  -- The output keeps the source's shape: framing settings would be ignored.
  reshaped boolean := p_capability in ('upscale', 'remove_bg', 'video_upscale', 'relight', 'erase',
                                       'video_edit', 'video_remove_bg');
  -- expand (0099): the picture is the whole input, but its SHAPE is the ask.
  grown    boolean := p_capability = 'expand';
  prompted boolean := p_capability not in ('i2v', 'upscale', 'remove_bg', 'voice_change', 'dub', 'video_upscale',
                                           'describe', 'captions', 'expand', 'relight',
                                           'video_reframe', 'video_remove_bg');
  -- The capabilities a look can steer.
  styled   boolean := p_capability in ('t2i', 't2v', 'edit', 'i2v');
  uuid_re  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    return 'params must be a JSON object';
  end if;
  if octet_length(p_params::text) > 16384 then
    return 'params are too large';
  end if;
  for k in select jsonb_object_keys(p_params) loop
    if k not in ('prompt', 'negative_prompt', 'aspect_ratio', 'resolution', 'duration_s',
                 'voice_id', 'seed', 'source_asset_id', 'factor', 'style_kit_id', 'target_language',
                 'target_resolution', 'end_asset_id', 'language', 'quality', 'audio', 'look') then
      return format('unknown parameter %s', k);
    end if;
  end loop;
  if (p_capability = 'remove_bg' or voiced or filmed or told or unworded) and p_params ? 'prompt' then
    return format('prompt does not apply to %s', p_capability);
  end if;
  if prompted or p_params ? 'prompt' then
    if jsonb_typeof(p_params -> 'prompt') is distinct from 'string'
       or char_length(btrim(p_params ->> 'prompt')) = 0 then
      return 'prompt is required';
    end if;
    if char_length(p_params ->> 'prompt') > 4000 then
      return 'prompt is longer than 4000 characters';
    end if;
  end if;
  if p_params ? 'negative_prompt' then
    if reshaped or grown or reframed or voiced or told then
      return format('negative_prompt does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'negative_prompt') <> 'string'
       or char_length(p_params ->> 'negative_prompt') > 2000 then
      return 'negative_prompt must be text of at most 2000 characters';
    end if;
  end if;
  if p_params ? 'aspect_ratio' then
    if reshaped then
      return format('aspect_ratio does not apply to %s: the result keeps the source''s shape', p_capability);
    end if;
    if voiced or told then
      return format('aspect_ratio does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'aspect_ratio') <> 'string'
       or (p_params ->> 'aspect_ratio') !~ '^[1-9][0-9]?:[1-9][0-9]?$' then
      return 'aspect_ratio must look like 16:9';
    end if;
  end if;
  if grown then
    -- expand (0099): required, and one shape of the closed list. The model must
    -- list it too (creative_price).
    if jsonb_typeof(p_params -> 'aspect_ratio') is distinct from 'string'
       or (p_params ->> 'aspect_ratio') not in ('16:9', '9:16', '1:1', '4:3', '3:4') then
      return 'aspect_ratio must be one of 16:9, 9:16, 1:1, 4:3, 3:4 for expand';
    end if;
  end if;
  if reframed then
    -- video_reframe (0100): required, one shape of the closed list (expand's). The
    -- model must list it too (creative_price).
    if jsonb_typeof(p_params -> 'aspect_ratio') is distinct from 'string'
       or (p_params ->> 'aspect_ratio') not in ('16:9', '9:16', '1:1', '4:3', '3:4') then
      return 'aspect_ratio must be one of 16:9, 9:16, 1:1, 4:3, 3:4 for video_reframe';
    end if;
  end if;
  if p_params ? 'resolution' then
    if filmed then
      return 'resolution does not apply to video_upscale: name the result''s size as target_resolution';
    end if;
    if reshaped or grown or reframed or voiced or told then
      return format('resolution does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'resolution') <> 'string'
       or (p_params ->> 'resolution') !~ '^(480|540|720|1080|1440|2160)p$' then
      return 'resolution must be one of 480p 540p 720p 1080p 1440p 2160p';
    end if;
  end if;
  if timed then
    if not public.creative_json_int(p_params -> 'duration_s', 1, 60) then
      return 'duration_s must be a whole number of seconds from 1 to 60';
    end if;
  elsif p_params ? 'duration_s' then
    -- The voice and video tools are priced by the file's own length (the database's).
    return format('duration_s does not apply to %s', p_capability);
  end if;
  if p_capability = 'voice_change' then
    -- Required, and a voice of the account (20 letters and digits), never a
    -- default: the person picks the voice they pay for.
    if jsonb_typeof(p_params -> 'voice_id') is distinct from 'string'
       or (p_params ->> 'voice_id') !~ '^[A-Za-z0-9]{20}$' then
      return 'voice_id (a voice of the account: 20 letters and digits) is required for voice_change';
    end if;
  elsif p_params ? 'voice_id' then
    if p_capability <> 'tts' then
      return format('voice_id does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'voice_id') <> 'string'
       or (p_params ->> 'voice_id') !~ '^[A-Za-z0-9_-]{1,64}$' then
      return 'voice_id must be 1-64 letters, digits, _ or -';
    end if;
  end if;
  if p_params ? 'seed' then
    if reshaped or grown or reframed or voiced or told then
      return format('seed does not apply to %s', p_capability);
    end if;
    if not public.creative_json_int(p_params -> 'seed', 0, 2147483647) then
      return 'seed must be a whole number from 0 to 2147483647';
    end if;
  end if;
  if sourced then
    if jsonb_typeof(p_params -> 'source_asset_id') is distinct from 'string'
       or (p_params ->> 'source_asset_id') !~ uuid_re then
      if voiced then
        return format('source_asset_id (the id of an audio or video file in the media library) is required for %s',
                      p_capability);
      end if;
      if filmed or clipped then
        return format('source_asset_id (the id of a video in the media library) is required for %s', p_capability);
      end if;
      return format('source_asset_id (the id of an image in the media library) is required for %s', p_capability);
    end if;
  elsif p_params ? 'source_asset_id' then
    return format('source_asset_id does not apply to %s', p_capability);
  end if;
  if p_capability = 'upscale' then
    -- Separate statements: the cast only ever sees a whole JSON number.
    if not public.creative_json_int(p_params -> 'factor', 2, 4) then
      return 'factor must be 2 or 4';
    end if;
    if (p_params ->> 'factor')::numeric = 3 then
      return 'factor must be 2 or 4';
    end if;
  elsif p_params ? 'factor' then
    return format('factor does not apply to %s', p_capability);
  end if;
  if filmed then
    -- The explicit allow-list (the vendor's targets); the model must list it too.
    if jsonb_typeof(p_params -> 'target_resolution') is distinct from 'string'
       or (p_params ->> 'target_resolution') not in ('720p', '1k', '2k', '4k') then
      return 'target_resolution must be one of 720p, 1k, 2k, 4k';
    end if;
  elsif p_params ? 'target_resolution' then
    return format('target_resolution does not apply to %s', p_capability);
  end if;
  if p_params ? 'end_asset_id' then
    if p_capability <> 'i2v' then
      return format('end_asset_id does not apply to %s', p_capability);
    end if;
    -- Absent means "no end frame"; a present key must name one (never null).
    if jsonb_typeof(p_params -> 'end_asset_id') is distinct from 'string'
       or (p_params ->> 'end_asset_id') !~ uuid_re then
      return 'end_asset_id must be the id of an image in the media library';
    end if;
  end if;
  if p_capability = 'dub' then
    -- The explicit allow-list: a language nobody offered is never "close enough".
    if jsonb_typeof(p_params -> 'target_language') is distinct from 'string'
       or (p_params ->> 'target_language') not in ('uz', 'ru', 'en') then
      return 'target_language must be one of uz, ru, en';
    end if;
  elsif p_params ? 'target_language' then
    return format('target_language does not apply to %s', p_capability);
  end if;
  if p_params ? 'language' then
    -- describe (0055: absent = English) and captions (0072: the language
    -- spoken in the recording; absent = the provider detects it). The
    -- explicit allow-list either way.
    if not (told or p_capability = 'captions') then
      return format('language does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'language') is distinct from 'string'
       or (p_params ->> 'language') not in ('en', 'ru', 'uz') then
      return 'language must be one of en, ru, uz';
    end if;
  end if;
  if p_params ? 'quality' then
    -- The render quality of a picture model that bills by it (0060): t2i and
    -- edit only, the explicit allow-list. Whether THIS model offers the tier
    -- (and has a price for it) is creative_price's question. Absent = medium.
    if p_capability not in ('t2i', 'edit') then
      return format('quality does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'quality') is distinct from 'string'
       or (p_params ->> 'quality') not in ('low', 'medium', 'high') then
      return 'quality must be one of low, medium, high';
    end if;
  end if;
  if p_params ? 'audio' then
    -- The soundtrack of a video (0070): t2v and i2v only, a JSON boolean.
    -- Whether THIS model offers the choice is creative_price's question.
    -- Absent = silent.
    if p_capability not in ('t2v', 'i2v') then
      return format('audio does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'audio') is distinct from 'boolean' then
      return 'audio must be true or false';
    end if;
  end if;
  if p_params ? 'look' then
    -- relight (0099): the light, from the closed list. The model must list it
    -- too (creative_price).
    if p_capability <> 'relight' then
      return format('look does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'look') is distinct from 'string'
       or (p_params ->> 'look') not in ('soft', 'warm', 'cool', 'golden_hour', 'dramatic', 'studio') then
      return 'look must be one of soft, warm, cool, golden_hour, dramatic, studio';
    end if;
  end if;
  if p_capability = 'relight' and (p_params ? 'look') = (p_params ? 'prompt') then
    -- A choice OR a short prompt, never both and never neither: what is sent
    -- to the provider is exactly one thing the person asked for.
    return 'relight takes a look or a short prompt: send exactly one of them';
  end if;
  if p_capability in ('expand', 'relight', 'erase') and p_params ? 'prompt' then
    -- Short, one line of plain text: it is a few words about the picture, not a brief.
    -- Control characters, the Unicode line / paragraph separators (U+2028, U+2029) and NEL (U+0085).
    if (p_params ->> 'prompt') ~ ('[[:cntrl:]' || chr(133) || chr(8232) || chr(8233) || ']') then
      return format('prompt must be plain text on one line for %s', p_capability);
    end if;
    if p_capability = 'erase' and char_length(p_params ->> 'prompt') > 200 then
      return 'the object to erase is named in at most 200 characters';
    end if;
    if p_capability <> 'erase' and char_length(p_params ->> 'prompt') > 300 then
      return format('prompt is longer than 300 characters for %s', p_capability);
    end if;
  end if;
  if p_capability = 'video_edit' then
    -- 0100: what to change, as a short line of plain text (prompt itself is
    -- required above, as for every capability that is asked by words).
    -- Control characters, the Unicode line / paragraph separators and NEL (as 0099's picture ops).
    if (p_params ->> 'prompt') ~ ('[[:cntrl:]' || chr(133) || chr(8232) || chr(8233) || ']') then
      return 'prompt must be plain text on one line for video_edit';
    end if;
    if char_length(p_params ->> 'prompt') > 500 then
      return 'prompt is longer than 500 characters for video_edit';
    end if;
  end if;
  if p_params ? 'style_kit_id' then
    if not styled then
      return format('style_kit_id does not apply to %s', p_capability);
    end if;
    -- Absent means "no style"; a present key must name one (never null).
    if jsonb_typeof(p_params -> 'style_kit_id') is distinct from 'string'
       or (p_params ->> 'style_kit_id') !~ uuid_re then
      return 'style_kit_id must be the id of a style kit';
    end if;
  end if;
  return null;
end
$$;

drop function if exists public.creative_regions_problem(jsonb);

create or replace function public.finish_creative_job(
  p_job uuid, p_worker text, p_ok boolean,
  p_charge numeric default null, p_result jsonb default null,
  p_error_code text default null, p_error text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j       public.creative_jobs;
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  charge  numeric;
  charged numeric := 0;
  code    text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are finished by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.credit_account_lock(j.org_id);
  select * into j from public.creative_jobs where id = p_job for update;
  if j.status in ('completed', 'failed', 'cancelled', 'expired') then
    return public.creative_job_json(j);
  end if;
  if j.worker_id is distinct from w then
    raise exception 'this creative job belongs to another worker' using errcode = '42501';
  end if;

  if not coalesce(p_ok, false) then
    code := case when coalesce(p_error_code, '') ~ '^[a-z0-9_]{1,64}$' then p_error_code
                 else 'provider_error' end;
    perform public.creative_end_locked(p_job, 'failed', code, coalesce(p_error, code));
    select * into j from public.creative_jobs where id = p_job;
    return public.creative_job_json(j);
  end if;

  if j.provider_task_id is null then
    raise exception 'a completed job needs its provider task id' using errcode = '22023';
  end if;
  if p_result is not null and (jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 16384) then
    raise exception 'result must be a JSON object of at most 16 KB' using errcode = '22023';
  end if;
  charge := public.credits_round_up(coalesce(p_charge, j.quoted_credits));
  -- 0075: a routed job is charged at most the price of the model that made
  -- it (after a failover, a model that may cost less than the hold).
  if j.routed_credits is not null and charge > j.routed_credits then
    charge := j.routed_credits;
  end if;
  if charge < 0 or charge > j.quoted_credits then
    raise exception 'a charge of % is not within the hold of %', charge, j.quoted_credits
      using errcode = '22023';
  end if;
  if j.payer = 'credits' and j.credit_ref is not null
     and exists (select 1 from public.credit_reservations where job_id = j.credit_ref) then
    -- 0 when the hold is no longer open (it expired): the job still completes,
    -- and what was charged is what the ledger says.
    charged := coalesce(public.capture_credits(j.credit_ref, charge, false), 0);
  end if;
  update public.creative_jobs
     set status = 'completed', charged_credits = charged, result = p_result,
         error_code = null, error = null, worker_id = null,
         finished_at = now(), updated_at = now()
   where id = p_job
  returning * into j;
  perform public.creative_job_log(p_job, j.org_id, 'completed', 'completed',
    jsonb_build_object('charged', charged));
  return public.creative_job_json(j);
end
$$;

drop function if exists public.creative_region_outcomes(jsonb, jsonb);

create or replace function public.creative_quantity(p_capability text, p_params jsonb) returns numeric
  language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_capability in ('t2i', 'edit', 'remove_bg') then 1::numeric
    when p_capability in ('t2v', 'sfx', 'music', 'i2v') then (p_params ->> 'duration_s')::numeric
    when p_capability = 'tts' then char_length(p_params ->> 'prompt')::numeric
    when p_capability = 'upscale' then power((p_params ->> 'factor')::numeric / 2, 2)
    when p_capability = 'describe' then 1::numeric
    -- 0099: one picture in, one picture out, whatever the shape or the light.
    when p_capability in ('expand', 'relight', 'erase') then 1::numeric
  end
$$;

revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_quantity(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) to service_role;

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.creative_params_problem(text, jsonb)'::regprocedure) <> '8f5525f8a44442ab477c412c3d013fee'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.creative_quantity(text, jsonb)'::regprocedure) <> 'e6e1d85bcd4a4cde42f94546a697e352'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)'::regprocedure) <> '37e306c9def112dd53d83d9eba0a1c49'
     or to_regprocedure('public.creative_regions_problem(jsonb)') is not null
     or to_regprocedure('public.creative_region_outcomes(jsonb, jsonb)') is not null then
    raise exception 'rollback 0126 end state: a body is not the pre-0126 one, or a 0126 function is still there';
  end if;
end $$;

commit;
