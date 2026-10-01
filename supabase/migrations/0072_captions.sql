-- 0072_captions.sql — "Auto-captions": a recording the organization already
-- has in its media library -> a subtitle track (words with their own times),
-- priced like any creative job and kept as DATA the editor turns into burned-in
-- captions and the person exports as SRT or WebVTT (Creative OS plan §3.3 / PR 11).
--
--   captions   a recording (+ an optional spoken language) -> a caption track
--
-- A captions job is an ordinary creative job: quote -> the price on the button
-- -> max_credits -> one idempotency key per press -> hold at create, capture
-- <= the hold on success, full release on every failure (no speech found, a
-- refused file, a provider outage: the customer pays nothing). The input is a
-- media_assets row named by its id — never a URL or a path — and the DATABASE
-- decides whether it may be used (0050's recording check, with a captions
-- limit of 30 minutes) and what it costs: the recording's length in seconds,
-- as the database measured it (creative_source_seconds), at the model's
-- credit price. Unpriced -> refused 'unpriced', never 0.
--
-- WHERE THE RESULT LIVES
--   public.caption_tracks (NEW): one row per finished job — the words the
--   provider heard, each with its start and end second — written only by
--   store_caption_track (service role, for the job its worker holds, in the
--   JOB's organization). The job row keeps only {"track_id": ...} (a small
--   result: 0036 caps creative_jobs.result at 16 KB, a transcript is larger).
--   A track is visible to its organization's members only once its job has
--   completed, so a worker that stored a track and then failed to settle
--   never hands out a transcript nobody paid for. Cues (lines on screen),
--   their style and the SRT / WebVTT files are made from the words in the
--   browser, free; editing them never touches this table.
--
-- WHAT IT CHANGES (create-or-replace / drop-then-add; nothing dropped)
--   model_registry / model_probe_runs   the capability CHECKs accept
--                        'captions' (at most 13 per model).
--   sellable_models      0060's (0055's with the quality tiers), accepting 'captions'.
--   creative_capability_supported   + captions.
--   creative_params_problem          0060's rules (0055's plus the quality key)
--                        plus, for captions:
--       source_asset_id  required (a recording; creative_source_problem decides);
--       language         optional, one of 'en', 'ru', 'uz' (the explicit
--                        allow-list; absent = the provider detects it).
--     prompt, negative_prompt, aspect_ratio, resolution, seed, duration_s,
--     voice_id, factor, target_language and style_kit_id are refused: the
--     recording is the whole input.
--   creative_source_problem   0055's; captions take 0050's recording check
--                        (another organization's file, a deleted one and an id
--                        that never existed read EXACTLY alike) and refuse a
--                        recording over 30 minutes.
--   creative_price       0060's (0052's with the quality tier), pricing captions
--                        by the recording's seconds (like a dub), and refusing a
--                        language the model was not proven and listed for
--                        (spec.languages).
--   creative_jobs        NEW CHECK creative_jobs_captions_check: a captions
--                        job never has library assets, and its result, once
--                        there, names its track.
--   creative_quantity, creative_job_source, creative_picture_problem,
--   creative_source_seconds, model_registry_guard: unchanged — they reach the
--   new rules through the functions above (the guard already re-opens a
--   model's proof when its spec.languages change).
--
-- BUILT ON 0060 / 0055 / 0052. Every function replaced here is the latest body
-- (sellable_models, creative_params_problem and creative_price: 0060's, the
-- picture-quality change; creative_source_problem and
-- creative_capability_supported: 0055's) with the captions lines added:
-- applying 0072 keeps the quality tiers, describe, the voice tools, the video
-- upscale and the i2v end frame exactly as they were (tests pin every string
-- literal).
--
-- ORDER. 0072 applies after 0060 (the numbers say so) and contains 0060's
-- bodies, so the quality tiers survive it. Any migration numbered above 0072
-- that replaces one of these functions must carry the captions lines too, or
-- its bodies would take the capability away again (sellable_models would
-- refuse the capability, a captions quote would be refused 'invalid_params' —
-- never a wrong price, nothing held). tests/test_captions.py fails when one
-- does.
--
-- MONEY: UNCHANGED. 0036's hold / capture / release, untouched.
--
-- WHO MAY DO WHAT
--   quote / create / cancel: signed-in members, as 0036.
--   caption_tracks   select: members of the organization (viewers included,
--                    like its jobs), once the job is completed; nobody writes
--                    directly.
--   delete_caption_track   editors and above of the organization; soft delete.
--   store_caption_track    service role only (the creative worker).
--   anon: nothing.
--
-- REQUIRES 0018, 0020, 0035, 0036, 0038, 0050, 0052, 0055 and 0060.
-- Additive and idempotent: guarded creates, drop-then-add constraints,
-- create-or-replace functions, drop-then-create policies, revoke-then-grant.

do $$
begin
  if to_regprocedure('public.creative_source_seconds(uuid, jsonb)') is null
     or to_regprocedure('public.creative_picture_problem(uuid, uuid, text)') is null then
    raise exception '0072 needs 0050 and 0052: apply 0050_voice_tools.sql and 0052_video_tools.sql first';
  end if;
  if to_regprocedure('public.creative_quantity(text, jsonb)') is null
     or not exists (select 1 from pg_constraint where conname = 'creative_jobs_describe_text_check') then
    raise exception '0072 needs 0055_describe_image.sql: apply it first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0072 needs the media library: apply 0038_media_assets.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The registry knows the new capability
-- ───────────────────────────────────────────────────────────────────────────

alter table public.model_registry drop constraint if exists model_registry_capabilities_check;
alter table public.model_registry add constraint model_registry_capabilities_check
  check (cardinality(capabilities) between 1 and 13
         and capabilities <@ array['t2i','edit','t2v','i2v','tts','sfx','upscale','remove_bg',
                                   'voice_change','dub','video_upscale','describe','captions']::text[]);

alter table public.model_probe_runs drop constraint if exists model_probe_runs_capability_check;
alter table public.model_probe_runs add constraint model_probe_runs_capability_check
  check (capability in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg',
                        'voice_change', 'dub', 'video_upscale', 'describe', 'captions'));

-- 0060's sellable_models, accepting 'captions'. Every other line is 0060's.
create or replace function public.sellable_models(p_capability text default null, p_surface text default 'web')
  returns table (
    id text, display_name text, provider text, capabilities text[], availability text,
    verified_at timestamptz, credit_unit text, entitlement text,
    credits_per_unit numeric, margin numeric, spec jsonb)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_surface is null or p_surface not in ('web', 'api', 'mcp') then
    raise exception 'unknown surface %', p_surface using errcode = '22023';
  end if;
  if p_capability is not null
     and p_capability not in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg',
                              'voice_change', 'dub', 'video_upscale', 'describe', 'captions') then
    raise exception 'unknown capability %', p_capability using errcode = '22023';
  end if;
  return query
    select m.id, m.display_name, m.provider, m.capabilities, m.availability, m.verified_at,
           m.credit_unit, m.entitlement, cp.credits_per_unit, cp.margin,
           -- The public half of spec: what a person choosing a model needs.
           -- Never provider costs, evidence, notes, the probe or the vendor id.
           jsonb_strip_nulls(jsonb_build_object(
             'output', m.spec -> 'output', 'inputs', m.spec -> 'inputs',
             'aspect_ratios', m.spec -> 'aspect_ratios',
             'aspect_ratios_by_capability', m.spec -> 'aspect_ratios_by_capability',
             'image_sizes', m.spec -> 'image_sizes', 'resolutions', m.spec -> 'resolutions',
             'durations_s', m.spec -> 'durations_s', 'audio_out', m.spec -> 'audio_out',
             'upscale_factors', m.spec -> 'upscale_factors', 'languages', m.spec -> 'languages',
             'upscale_targets', m.spec -> 'upscale_targets', 'end_frame', m.spec -> 'end_frame',
             'async', m.spec -> 'async', 'unit', m.spec -> 'pricing' -> 'unit',
             'qualities', m.spec -> 'qualities',
             'attribution', m.spec -> 'attribution', 'api_exposure', m.spec -> 'api_exposure',
             'limits', m.spec -> 'limits', 'quality_tier', m.spec -> 'quality_tier',
             'speed_tier', m.spec -> 'speed_tier'))
      from public.model_registry m
      join public.credit_prices cp on cp.unit = m.credit_unit
     where m.availability in ('beta', 'ga')
       and m.verified_at is not null
       and m.verified_probe_id is not null
       and coalesce(m.spec ->> 'terms_gate', '') = ''
       and cp.credits_per_unit > 0
       -- A model sold by quality is shown only when at least one of its tiers
       -- has a price: a tier without a row is unpriced, never free.
       and (m.spec -> 'pricing' -> 'variants' ->> 'by' is distinct from 'quality'
            or exists (select 1
                         from jsonb_array_elements_text(coalesce(m.spec -> 'qualities', '[]'::jsonb)) as tiers(tier)
                         join public.credit_prices qp on qp.unit = m.credit_unit || '_' || tiers.tier
                        where qp.credits_per_unit > 0))
       and (p_capability is null or p_capability = any (m.capabilities))
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') <> 'web_only')
     order by m.provider, m.id;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The job row: a caption track is data elsewhere, never a library asset
-- ───────────────────────────────────────────────────────────────────────────

alter table public.creative_jobs drop constraint if exists creative_jobs_captions_check;
alter table public.creative_jobs add constraint creative_jobs_captions_check
  check (capability <> 'captions'
         or (cardinality(result_asset_ids) = 0
             and (result is null
                  -- coalesce: a CHECK passes on null, and a result without
                  -- a track would otherwise read as null, not false.
                  or coalesce(jsonb_typeof(result -> 'track_id') = 'string'
                              and (result ->> 'track_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                              false))));

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Params, the source, the price (0060's, 0055's latest bodies + captions)
-- ───────────────────────────────────────────────────────────────────────────

-- 0055's, with captions in the list.
create or replace function public.creative_capability_supported(p_capability text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_capability in ('t2i', 't2v', 'tts', 'sfx', 'music', 'edit', 'i2v', 'upscale', 'remove_bg',
                          'voice_change', 'dub', 'video_upscale', 'describe', 'captions')
$$;

-- 0060's rules plus captions (header). Pure: whether the recording may be used
-- is creative_source_problem's question (it needs the organization).
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
  -- describe (0055): a picture is the whole input; the output is text.
  told     boolean := p_capability = 'describe';
  sourced  boolean := p_capability in ('edit', 'i2v', 'upscale', 'remove_bg', 'voice_change', 'dub',
                                       'video_upscale', 'describe', 'captions');
  -- The output keeps the source's shape: framing settings would be ignored.
  reshaped boolean := p_capability in ('upscale', 'remove_bg', 'video_upscale');
  prompted boolean := p_capability not in ('i2v', 'upscale', 'remove_bg', 'voice_change', 'dub', 'video_upscale',
                                           'describe', 'captions');
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
                 'target_resolution', 'end_asset_id', 'language', 'quality') then
      return format('unknown parameter %s', k);
    end if;
  end loop;
  if (p_capability = 'remove_bg' or voiced or filmed or told) and p_params ? 'prompt' then
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
    if reshaped or voiced or told then
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
  if p_params ? 'resolution' then
    if filmed then
      return 'resolution does not apply to video_upscale: name the result''s size as target_resolution';
    end if;
    if reshaped or voiced or told then
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
    if reshaped or voiced or told then
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
      if filmed then
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

-- 0055's, and captions take 0050's recording check (module header).
create or replace function public.creative_source_problem(p_org uuid, p_capability text, p_params jsonb)
  returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  a       public.media_assets;
  problem text;
begin
  if p_capability = 'video_upscale' then
    select * into a from public.media_assets
     where id = (p_params ->> 'source_asset_id')::uuid
       and org_id = p_org
       and deleted_at is null and purged_at is null;
    if not found then
      return 'source_asset_id names no video in this organization''s library';
    end if;
    if a.kind <> 'video' then
      return 'the source must be a video';
    end if;
    if a.mime not in ('video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska') then
      return 'this video type cannot be upscaled; use MP4, MOV, WebM or MKV';
    end if;
    if a.duration_s is null or a.duration_s <= 0 then
      return 'the length of this video is not known, so it cannot be priced; upload it again';
    end if;
    if a.bytes > 209715200 then
      return 'this video is larger than 200 MB; use a smaller copy';
    end if;
    return null;
  end if;

  if p_capability in ('voice_change', 'dub', 'captions') then
    -- 0050's recording check, unchanged.
    select * into a from public.media_assets
     where id = (p_params ->> 'source_asset_id')::uuid
       and org_id = p_org
       and deleted_at is null and purged_at is null;
    if not found then
      return 'source_asset_id names no audio or video file in this organization''s library';
    end if;
    if a.kind not in ('audio', 'video') then
      return 'the source must be an audio or video file';
    end if;
    if a.mime not in ('audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/flac',
                      'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska')
       and not (p_capability in ('dub', 'captions') and a.mime in ('audio/aac', 'audio/webm')) then
      return 'this file type cannot be used here; use MP3, M4A, WAV, OGG, FLAC, MP4, MOV, WebM or MKV';
    end if;
    if a.duration_s is null or a.duration_s <= 0 then
      return 'the length of this file is not known, so it cannot be priced; upload it again';
    end if;
    if p_capability = 'voice_change' and a.duration_s > 300 then
      return 'a voice change takes recordings of up to 5 minutes; trim this one first';
    end if;
    if p_capability = 'dub' and a.duration_s > 1800 then
      return 'a dub takes recordings of up to 30 minutes; trim this one first';
    end if;
    if p_capability = 'captions' and a.duration_s > 1800 then
      return 'captions take recordings of up to 30 minutes; trim this one first';
    end if;
    if a.bytes > 536870912 then
      return 'this file is larger than 512 MB; use a smaller copy';
    end if;
    return null;
  end if;

  -- 0046's picture check, unchanged in what it decides — now also for describe.
  if p_capability not in ('edit', 'i2v', 'upscale', 'remove_bg', 'describe') then
    return null;
  end if;
  problem := public.creative_picture_problem(p_org, (p_params ->> 'source_asset_id')::uuid, 'source_asset_id');
  if problem is not null then
    return problem;
  end if;
  -- describe (0055): the picture travels inline and the provider caps a
  -- whole request at 20 MB (base64 grows it by a third). A HEIC photo is sent
  -- as its JPEG display copy, which is smaller. The asset was just checked
  -- for this organization by creative_picture_problem.
  if p_capability = 'describe' then
    select * into a from public.media_assets
     where id = (p_params ->> 'source_asset_id')::uuid and org_id = p_org;
    if a.mime not in ('image/heic', 'image/heif') and a.bytes > 15728640 then
      return 'a description takes pictures of up to 15 MB; use a smaller copy';
    end if;
    return null;
  end if;
  -- The picture an i2v ends on: the same rules, the same silence about
  -- what another organization has.
  if p_capability = 'i2v' and p_params ? 'end_asset_id' then
    return public.creative_picture_problem(p_org, (p_params ->> 'end_asset_id')::uuid, 'end_asset_id');
  end if;
  return null;
end
$$;

-- 0060's quote, with captions priced by the recording's seconds (from the
-- database, like a dub) and its language checked against the model's list.
-- Every other line is 0060's.
create or replace function public.creative_price(
  p_org uuid, p_capability text, p_model text, p_params jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap     text := lower(btrim(coalesce(p_capability, '')));
  mdl     text := lower(btrim(coalesce(p_model, '')));
  problem text;
  m_unit  text;
  m_ent   text;
  m_spec  jsonb;
  m_found boolean := false;
  rate    public.credit_prices;
  floor_c numeric;
  qty     numeric;
  price   numeric;
  minimum numeric := 0;
  longest numeric;
  tier    text;
begin
  if cap !~ '^[a-z][a-z0-9_]{0,31}$' then
    perform public.creative_refuse('invalid_params', 'capability is required');
  end if;
  if not public.creative_capability_supported(cap) then
    perform public.creative_refuse('capability_not_supported',
      format('%s cannot be generated yet on this deployment', cap));
  end if;
  if mdl !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'model is required');
  end if;
  problem := public.creative_params_problem(cap, p_params);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;
  -- The input picture, recording or video (and an end frame) must be this
  -- organization's, live, and usable.
  problem := public.creative_source_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('source_unavailable', problem);
  end if;
  -- The style kit must be this organization's.
  problem := public.creative_style_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('style_unavailable', problem);
  end if;

  -- Never "allow every model" when the registry is not there (see 0036).
  if to_regclass('public.model_registry') is null then
    perform public.creative_refuse('registry_missing',
      'the model registry (migration 0035) is not applied on this deployment');
  end if;
  select true, r.credit_unit, r.entitlement, r.spec
    into m_found, m_unit, m_ent, m_spec
    from public.model_registry r
   where r.id = mdl
     and r.availability in ('beta', 'ga')
     and r.verified_at is not null
     and cap = any (r.capabilities);
  if not coalesce(m_found, false) then
    perform public.creative_refuse('model_not_sellable',
      format('%s is not available for %s', mdl, cap));
  end if;
  if coalesce(m_ent, 'any') not in ('any', 'paid') then
    perform public.creative_refuse('entitlement_required',
      format('%s needs the %s entitlement', mdl, m_ent));
  end if;
  if m_ent = 'paid' and not public.credits_exempt(p_org)
     and not exists (select 1 from public.credit_transactions t
                      where t.org_id = p_org and t.kind = 'purchase') then
    perform public.creative_refuse('entitlement_required',
      format('%s is available after the organization''s first credit purchase', mdl));
  end if;
  -- A factor the model was not proven (and priced) for is not sold.
  if cap = 'upscale'
     and not coalesce(jsonb_typeof(m_spec -> 'upscale_factors') = 'array'
                      and (m_spec -> 'upscale_factors') @> (p_params -> 'factor'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer a %sx upscale', mdl, p_params ->> 'factor'));
  end if;
  -- Nor a language the model was not proven (and listed) for.
  if cap = 'dub'
     and not coalesce(jsonb_typeof(m_spec -> 'languages') = 'array'
                      and (m_spec -> 'languages') @> jsonb_build_array(p_params ->> 'target_language'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not dub into %s', mdl, p_params ->> 'target_language'));
  end if;
  -- Nor a spoken language the model was not proven (and listed) for. No
  -- language at all is allowed: the provider detects it.
  if cap = 'captions' and p_params ? 'language'
     and not coalesce(jsonb_typeof(m_spec -> 'languages') = 'array'
                      and (m_spec -> 'languages') @> jsonb_build_array(p_params ->> 'language'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not transcribe %s', mdl, p_params ->> 'language'));
  end if;
  -- Nor a video target the model was not proven (and listed) for.
  if cap = 'video_upscale'
     and not coalesce(jsonb_typeof(m_spec -> 'upscale_targets') = 'array'
                      and (m_spec -> 'upscale_targets') @> jsonb_build_array(p_params ->> 'target_resolution'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not upscale a video to %s', mdl, p_params ->> 'target_resolution'));
  end if;
  -- Nor an ending on a model that would drop it.
  if p_params ? 'end_asset_id' and coalesce(m_spec -> 'end_frame', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('invalid_params',
      format('%s cannot end a clip on a chosen picture', mdl));
  end if;

  -- A quality the model does not offer is refused, never ignored: the
  -- provider would bill its own default under the quoted price (0060).
  if p_params ? 'quality'
     and not coalesce(jsonb_typeof(m_spec -> 'qualities') = 'array'
                      and (m_spec -> 'qualities') @> jsonb_build_array(p_params ->> 'quality'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s quality', mdl, p_params ->> 'quality'));
  end if;

  -- One price per target when the registry prices the targets apart
  -- (model_registry.credit_unit_for): a target without its own row is
  -- unpriced, never sold at another target's rate.
  if cap = 'video_upscale' and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'upscale_target' then
    m_unit := m_unit || '_' || regexp_replace(lower(p_params ->> 'target_resolution'), '[^a-z0-9]', '_', 'g');
  end if;
  -- One price per quality tier when the registry prices the tiers apart
  -- (model_registry.credit_unit_for: model_<id>_<unit>_<tier>). No tier named
  -- = medium, the same tier the worker sends; a tier without its own row is
  -- unpriced, never sold at another tier's rate and never at 0.
  if cap in ('t2i', 'edit') and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' then
    tier := coalesce(p_params ->> 'quality', 'medium');
    if not coalesce(jsonb_typeof(m_spec -> 'qualities') = 'array'
                    and (m_spec -> 'qualities') @> jsonb_build_array(tier), false) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer the %s quality', mdl, tier));
    end if;
    m_unit := m_unit || '_' || regexp_replace(lower(tier), '[^a-z0-9]', '_', 'g');
  end if;
  if m_unit is not null then
    select * into rate from public.credit_prices where unit = m_unit;
  end if;
  if m_unit is null or rate.unit is null then
    perform public.creative_refuse('unpriced',
      format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
  end if;

  if cap in ('voice_change', 'dub', 'video_upscale', 'captions') then
    -- The file's measured length, from the database — never the client's.
    qty := public.creative_source_seconds(p_org, p_params);
  else
    qty := public.creative_quantity(cap, p_params);
  end if;
  if qty is null or qty <= 0 then
    -- Unknown is never priced as 0 (CLAUDE.md #5).
    perform public.creative_refuse('source_unavailable', 'the length of the source is not known, so it cannot be priced');
  end if;
  if cap = 'video_upscale' then
    -- The vendor's longest input, as the registry states it: a model that
    -- states none is not sold a length it may refuse after the hold.
    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'
                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;
    if longest is null or longest <= 0 then
      perform public.creative_refuse('model_not_sellable',
        format('%s does not state the longest video it takes', mdl));
    end if;
    if qty > longest then
      perform public.creative_refuse('source_unavailable',
        format('this model upscales videos of up to %s seconds; trim this one first', longest));
    end if;
  end if;
  -- Rounded to 6 places before the upward cent, so numeric division noise
  -- never adds a cent (0030 does the same).
  price := public.credits_round_up(round(qty * rate.credits_per_unit * (1 + rate.margin), 6));
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null then
    minimum := public.credits_round_up(floor_c);
  end if;
  if price > 0 then
    price := greatest(price, minimum);
  end if;

  return jsonb_build_object(
    'credits', price, 'exempt', public.credits_exempt(p_org),
    'model', mdl, 'capability', cap, 'unit', rate.unit, 'quantity', qty,
    'credits_per_unit', rate.credits_per_unit, 'margin', rate.margin, 'minimum', minimum)
    -- The tier this price is for, so what the person confirms names it.
    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The caption tracks
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.caption_tracks (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  -- One track per job: a retried store answers the same row.
  job_id     uuid not null unique references public.creative_jobs (id) on delete cascade,
  -- The recording it was made from; kept only while that file is.
  asset_id   uuid references public.media_assets (id) on delete set null,
  -- The language the words are in: the one asked for, else the one the
  -- provider detected. A base language tag, never free text.
  language   text not null check (language ~ '^[a-z]{2,3}$'),
  duration_s numeric(10,3) not null check (duration_s > 0 and duration_s <= 36000),
  word_count integer not null check (word_count between 1 and 20000),
  -- [{"t": "word", "s": start_seconds, "e": end_seconds}, ...] in time order;
  -- store_caption_track checks every element, this bounds the column.
  words      jsonb not null check (jsonb_typeof(words) = 'array' and pg_column_size(words) <= 2097152),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint caption_tracks_count_check check (jsonb_array_length(words) = word_count)
);

create index if not exists caption_tracks_org_asset_idx
  on public.caption_tracks (org_id, asset_id, created_at desc) where deleted_at is null;

comment on table public.caption_tracks is
  'Word-timed transcripts made by captions jobs (migration 0072). Written only by store_caption_track (service role); members read the tracks of completed jobs of their organization; deleted only through delete_caption_track.';

-- Store the words of the job this worker holds, in the JOB's organization.
-- Idempotent per job. The worker names no organization and no asset.
create or replace function public.store_caption_track(
  p_job uuid, p_worker text, p_language text, p_duration_s numeric, p_words jsonb
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j   public.creative_jobs;
  w   text := left(btrim(coalesce(p_worker, '')), 120);
  src uuid;
  n   integer;
  tid uuid;
begin
  if not public.credits_trusted_caller() then
    raise exception 'caption tracks are stored by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  if not found or j.capability <> 'captions' or j.worker_id is distinct from w
     or j.status not in ('running', 'provider_pending', 'processing') then
    raise exception 'this captions job is not this worker''s to store' using errcode = '55000';
  end if;
  if coalesce(p_language, '') !~ '^[a-z]{2,3}$' then
    raise exception 'language must be a base language tag' using errcode = '22023';
  end if;
  if p_duration_s is null or p_duration_s <= 0 or p_duration_s > 36000 then
    raise exception 'duration must be positive' using errcode = '22023';
  end if;
  if p_words is null or jsonb_typeof(p_words) <> 'array' then
    raise exception 'words must be a JSON array' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_words);
  if n < 1 or n > 20000 or pg_column_size(p_words) > 2097152 then
    raise exception 'a track holds 1 to 20000 words' using errcode = '22023';
  end if;
  -- Every word: text of 1..80 characters, a start and an end that are numbers
  -- with end after start. Each number is read only when it IS one (SQL does
  -- not promise the order a WHERE's terms run in, and a bad cast would
  -- surface as the wrong error).
  if exists (
       select 1
         from (select case when jsonb_typeof(e.v) = 'object' and jsonb_typeof(e.v -> 't') = 'string'
                           then e.v ->> 't' end as t,
                      case when jsonb_typeof(e.v) = 'object' and jsonb_typeof(e.v -> 's') = 'number'
                           then (e.v ->> 's')::numeric end as s,
                      case when jsonb_typeof(e.v) = 'object' and jsonb_typeof(e.v -> 'e') = 'number'
                           then (e.v ->> 'e')::numeric end as en
                 from jsonb_array_elements(p_words) as e(v)) x
        where x.t is null or x.s is null or x.en is null
           or char_length(x.t) not between 1 and 80
           or x.t ~ '[[:cntrl:]]'
           or x.s < 0 or x.en <= x.s or x.en > 36000
     ) then
    raise exception 'a word is malformed' using errcode = '22023';
  end if;
  -- No word starts before the one before it ended (half a millisecond of slack).
  if exists (
       select 1
         from (select (v ->> 's')::numeric as s,
                      lag((v ->> 'e')::numeric) over (order by i) as prev_end
                 from jsonb_array_elements(p_words) with ordinality as e(v, i)) x
        where x.prev_end is not null and x.s < x.prev_end - 0.0005
     ) then
    raise exception 'words are not in time order' using errcode = '22023';
  end if;
  -- The recording, only if it is still this organization's live file.
  select m.id into src from public.media_assets m
   where m.id = (nullif(j.params ->> 'source_asset_id', ''))::uuid
     and m.org_id = j.org_id and m.deleted_at is null;
  insert into public.caption_tracks (org_id, job_id, asset_id, language, duration_s, word_count, words)
  values (j.org_id, j.id, src, p_language, round(p_duration_s, 3), n, p_words)
  on conflict (job_id) do update
     set language = excluded.language, duration_s = excluded.duration_s,
         word_count = excluded.word_count, words = excluded.words, deleted_at = null
  returning id into tid;
  return tid;
end
$$;

-- Hide a track from the organization (editors and above). Another
-- organization's track and a made-up id read exactly alike.
create or replace function public.delete_caption_track(p_track uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t public.caption_tracks;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into t from public.caption_tracks where id = p_track for update;
  if not found or t.deleted_at is not null or not public.is_org_member(t.org_id, 'editor') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.caption_tracks set deleted_at = now() where id = t.id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.caption_tracks enable row level security;

revoke all on public.caption_tracks from public, anon, authenticated, service_role;
grant select on public.caption_tracks to authenticated, service_role;

-- Visible once the job that paid for it has completed (never a transcript of
-- a job that failed or was released), to the members of its organization.
drop policy if exists caption_tracks_select on public.caption_tracks;
create policy caption_tracks_select on public.caption_tracks
  for select to authenticated
  using (deleted_at is null
         and org_id in (select public.accessible_org_ids('viewer'))
         and exists (select 1 from public.creative_jobs j
                      where j.id = caption_tracks.job_id and j.org_id = caption_tracks.org_id
                        and j.status = 'completed'));

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

revoke all on function public.creative_capability_supported(text) from public, anon, authenticated, service_role;
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_source_problem(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

revoke all on function public.store_caption_track(uuid, text, text, numeric, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.delete_caption_track(uuid) from public, anon, authenticated, service_role;
grant execute on function public.store_caption_track(uuid, text, text, numeric, jsonb) to service_role;
grant execute on function public.delete_caption_track(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.creative_capability_supported('captions') as captions_on,
--   public.creative_params_problem('captions',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","language":"uz"}') is null
--     and public.creative_params_problem('captions',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000"}') is null
--     and public.creative_params_problem('captions',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","language":"de"}') is not null
--     and public.creative_params_problem('captions',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","prompt":"x"}') is not null
--     and public.creative_params_problem('t2i', '{"prompt":"x","language":"en"}') is not null
--     as captions_params_checked,
--   public.creative_params_problem('describe',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","language":"uz"}') is null
--     and public.creative_params_problem('dub',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_language":"ru"}') is null
--     and public.creative_params_problem('video_upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_resolution":"4k"}') is null
--     as earlier_tools_kept,
--   exists (select 1 from pg_constraint where conname = 'creative_jobs_captions_check') as captions_never_assets,
--   (select relrowsecurity from pg_class where oid = 'public.caption_tracks'::regclass) as rls_on,
--   has_table_privilege('authenticated', 'public.caption_tracks', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.caption_tracks', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.caption_tracks', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.caption_tracks', 'DELETE')
--     and not has_table_privilege('anon', 'public.caption_tracks', 'SELECT') as table_scoped,
--   has_function_privilege('service_role', 'public.store_caption_track(uuid,text,text,numeric,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.store_caption_track(uuid,text,text,numeric,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.delete_caption_track(uuid)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.delete_caption_track(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_source_problem(uuid,text,jsonb)', 'EXECUTE')
--     as functions_scoped;
