-- 0052_video_tools.sql — two video tools on providers the platform already
-- integrates (Creative OS, plan §3.3):
--
--   video_upscale   a video of the organization's library -> the same video at
--                   a higher resolution (registry adapter video.runway_upscale:
--                   Runway's POST /v1/video_upscale). The vendor takes a TARGET
--                   resolution (720p | 1k | 2k | 4k), not a factor, so the
--                   param is target_resolution and each model lists the
--                   targets it is sold at (spec.upscale_targets).
--   i2v end frame   an optional end_asset_id on image-to-video: the clip ends
--                   on that picture. Only for a model whose spec.end_frame is
--                   true (Veo 3.1 / Fast / Lite lastFrame, Kling v3 image_tail,
--                   Luma Ray 3.2 end_frame, Seedance 1.0 / 1.5 pro last_frame).
--
-- As for 0046's pictures and 0050's recordings, the input is a media_assets
-- row named by its id — never a URL or a path — and the DATABASE decides
-- whether it may be used.
--
-- WHAT IT CHANGES (create-or-replace / drop-then-add; nothing dropped)
--   model_registry / model_probe_runs   the capability CHECKs accept
--                        'video_upscale' (at most 11 per model); a change of
--                        spec.upscale_targets or spec.end_frame clears
--                        verification like a change of capabilities does
--                        (model_registry_guard): selling a new target, or an
--                        ending, after a probe of something else is a new claim.
--   sellable_models      accepts video_upscale; the public spec shows
--                        upscale_targets and end_frame.
--   creative_capability_supported   + video_upscale.
--   creative_params_problem          0050's rules plus:
--       target_resolution  NEW key, video_upscale only, required: one of
--                        '720p', '1k', '2k', '4k' (the model must list it too);
--       end_asset_id     NEW key, i2v only, optional: the uuid of a picture;
--     video_upscale requires source_asset_id (a video) and refuses prompt,
--     negative_prompt, aspect_ratio, resolution, seed, duration_s, factor and
--     style_kit_id: the video is the whole input and keeps its own shape.
--   creative_picture_problem(org, asset, what)   NEW, internal: 0046's
--                        picture rules for one asset id (the first frame AND
--                        the end frame use them).
--   creative_source_problem   + the video check and the end-frame check
--                        (below); 0046's and 0050's checks are unchanged.
--   creative_price       0050's quote, with:
--       the quantity of video_upscale = creative_source_seconds (the length
--       the media worker measured when the file was stored, NEVER a number
--       from the client); refused above the model's spec.limits.
--       max_source_seconds (and refused when the model states none);
--       the target must be one the model lists in spec.upscale_targets;
--       when spec.pricing.variants.by = 'upscale_target' the credit unit is
--       <credit_unit>_<target> (model_registry.credit_unit_for) — a target
--       without its own price row is 'unpriced', never priced at another's;
--       an end_asset_id needs spec.end_frame = true (nothing is added to the
--       price: the vendors bill a framed clip like any i2v second).
--     Every other line is 0050's.
--   creative_job_source  0050's, plus {end_frame: {asset_id, mime, variants}}
--                        when the job names one (re-checked with the source).
--
-- THE VIDEO CHECK — creative_source_problem(org, 'video_upscale', params)
--   Called by creative_price (so by quote AND create, before any hold) and by
--   creative_job_source before the paid call. The asset must:
--     * exist AND belong to the job's organization — another organization's
--       video reads exactly like an id that does not exist;
--     * be live (not soft-deleted, not purged), and a VIDEO (never audio);
--     * be MP4, MOV, WebM or MKV (what Runway's video inputs document);
--     * have a measured length (duration_s): unknown is refused, not guessed;
--     * be at most 200 MB (Runway's ephemeral upload maximum).
--   The model's longest input (Runway: 30 s) is creative_price's check.
--   Runway bills per OUTPUT FRAME; the frame rate is not in the database, so
--   the worker reads it before the upload and refuses one above the rate the
--   per-second price assumes (modules/capabilities/video.py) — hold released.
--
-- THE END-FRAME CHECK — for an i2v that names end_asset_id: the same picture
--   rules as the first frame, and another organization's picture reads like a
--   made-up id ("end_asset_id names no image in this organization's library").
--
-- MONEY: UNCHANGED. Hold at create (= the quote), capture <= the hold on
-- success, full release on every failure — 0036's functions, untouched.
--
-- WHO MAY DO WHAT: as 0050. quote / create / cancel: signed-in members of the
-- organization. creative_job_source: service role. creative_source_problem,
-- creative_picture_problem, creative_source_seconds: nobody through the API.
-- anon: nothing.
--
-- REQUIRES 0035, 0036, 0038, 0046, 0048 and 0050. Additive and idempotent:
-- drop-then-add constraints, create-or-replace functions, revoke-then-grant.
-- (0051 is another change's number; this one does not depend on it.)

do $$
begin
  if to_regprocedure('public.creative_source_seconds(uuid, jsonb)') is null then
    raise exception '0052 needs 0050_voice_tools.sql: apply it first';
  end if;
  if to_regprocedure('public.creative_style_problem(uuid, text, jsonb)') is null then
    raise exception '0052 needs 0048_creative_style_inputs.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The registry knows the new capability and the new claims
-- ───────────────────────────────────────────────────────────────────────────

alter table public.model_registry drop constraint if exists model_registry_capabilities_check;
alter table public.model_registry add constraint model_registry_capabilities_check
  check (cardinality(capabilities) between 1 and 11
         and capabilities <@ array['t2i','edit','t2v','i2v','tts','sfx','upscale','remove_bg',
                                   'voice_change','dub','video_upscale']::text[]);

alter table public.model_probe_runs drop constraint if exists model_probe_runs_capability_check;
alter table public.model_probe_runs add constraint model_probe_runs_capability_check
  check (capability in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg',
                        'voice_change', 'dub', 'video_upscale'));

-- 0050's guard, plus: the targets a video is upscaled to, and whether a clip
-- can end on a chosen picture, are part of what was proven.
create or replace function public.model_registry_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.model_probe_runs;
begin
  new.updated_at := now();
  -- What is called changed → the old probe proves nothing about the new call.
  if tg_op = 'UPDATE' and (new.adapter is distinct from old.adapter
      or new.capabilities is distinct from old.capabilities
      or new.spec -> 'vendor_model' is distinct from old.spec -> 'vendor_model'
      or new.spec -> 'vendor_model_by_capability' is distinct from old.spec -> 'vendor_model_by_capability'
      or new.spec -> 'upscale_factors' is distinct from old.spec -> 'upscale_factors'
      or new.spec -> 'languages' is distinct from old.spec -> 'languages'
      or new.spec -> 'upscale_targets' is distinct from old.spec -> 'upscale_targets'
      or new.spec -> 'end_frame' is distinct from old.spec -> 'end_frame') then
    if new.verified_probe_id is not distinct from old.verified_probe_id then
      new.verified_at := null;
      new.verified_by := null;
      new.verified_probe_id := null;
      if new.availability in ('beta', 'ga') then
        new.availability := 'hidden';
      end if;
    end if;
  end if;
  -- A (new) proof must be a successful probe of THIS model as it is now.
  if new.verified_probe_id is not null
     and (tg_op = 'INSERT' or new.verified_probe_id is distinct from old.verified_probe_id
          or new.verified_at is distinct from old.verified_at) then
    select * into p from public.model_probe_runs where id = new.verified_probe_id;
    if not found or not p.ok or p.model_id <> new.id or p.adapter <> new.adapter
       or not (p.vendor_model = new.spec ->> 'vendor_model'
               or p.vendor_model in (select jsonb_each_text.value
                                       from jsonb_each_text(coalesce(new.spec -> 'vendor_model_by_capability', '{}'::jsonb)))) then
      raise exception 'model %: verified_probe_id must be a successful probe of this model, adapter and vendor model', new.id
        using errcode = '23514';
    end if;
    new.verified_at := p.created_at;
  end if;
  if new.verified_probe_id is null and new.verified_at is not null then
    raise exception 'model %: verified_at is set only from a probe run', new.id using errcode = '23514';
  end if;
  return new;
end
$$;

-- 0050's sellable_models with video_upscale, and upscale_targets / end_frame
-- in the public half of spec.
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
                              'voice_change', 'dub', 'video_upscale') then
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
       and (p_capability is null or p_capability = any (m.capabilities))
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') <> 'web_only')
     order by m.provider, m.id;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Params, the inputs, the quantity
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.creative_capability_supported(p_capability text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_capability in ('t2i', 't2v', 'tts', 'sfx', 'music', 'edit', 'i2v', 'upscale', 'remove_bg',
                          'voice_change', 'dub', 'video_upscale')
$$;

-- 0050's rules plus the video tools (header). Pure: whether the video or the
-- end frame may be used is creative_source_problem's question.
create or replace function public.creative_params_problem(p_capability text, p_params jsonb)
  returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k        text;
  timed    boolean := p_capability in ('t2v', 'sfx', 'music', 'i2v');
  -- The voice tools: a recording is the whole input.
  voiced   boolean := p_capability in ('voice_change', 'dub');
  -- The video tools (0052): a video is the whole input.
  filmed   boolean := p_capability = 'video_upscale';
  sourced  boolean := p_capability in ('edit', 'i2v', 'upscale', 'remove_bg', 'voice_change', 'dub',
                                       'video_upscale');
  -- The output keeps the source's shape: framing settings would be ignored.
  reshaped boolean := p_capability in ('upscale', 'remove_bg', 'video_upscale');
  prompted boolean := p_capability not in ('i2v', 'upscale', 'remove_bg', 'voice_change', 'dub', 'video_upscale');
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
                 'target_resolution', 'end_asset_id') then
      return format('unknown parameter %s', k);
    end if;
  end loop;
  if (p_capability = 'remove_bg' or voiced or filmed) and p_params ? 'prompt' then
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
    if reshaped or voiced then
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
    if voiced then
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
    if reshaped or voiced then
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
    if reshaped or voiced then
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

-- 0046's picture rules for ONE asset id, worded for the param that named it
-- ('source_asset_id' or 'end_asset_id'). Another organization's picture, a
-- deleted one and an id that never existed all get the SAME sentence.
create or replace function public.creative_picture_problem(p_org uuid, p_asset uuid, p_param text)
  returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  a public.media_assets;
begin
  select * into a from public.media_assets
   where id = p_asset
     and org_id = p_org
     and deleted_at is null and purged_at is null;
  if not found then
    return format('%s names no image in this organization''s library', p_param);
  end if;
  if a.kind <> 'image' then
    return case when p_param = 'end_asset_id' then 'the end frame must be an image' else 'the source must be an image' end;
  end if;
  if a.mime = 'image/gif' then
    return 'a GIF cannot be a source; use a PNG, JPEG or WebP image';
  end if;
  if a.mime in ('image/heic', 'image/heif') and not ('display' = any (a.variants)) then
    return 'this photo has no shareable copy yet; upload it again or use a PNG, JPEG or WebP image';
  end if;
  if a.mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif') then
    return 'this image type cannot be a source; use a PNG, JPEG or WebP image';
  end if;
  return null;
end
$$;

-- Why the job's inputs cannot be used by p_org for this capability, or null.
-- Runs after creative_params_problem, so every id is a well-formed uuid here.
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

  if p_capability in ('voice_change', 'dub') then
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
       and not (p_capability = 'dub' and a.mime in ('audio/aac', 'audio/webm')) then
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
    if a.bytes > 536870912 then
      return 'this file is larger than 512 MB; use a smaller copy';
    end if;
    return null;
  end if;

  -- 0046's picture check, unchanged in what it decides.
  if p_capability not in ('edit', 'i2v', 'upscale', 'remove_bg') then
    return null;
  end if;
  problem := public.creative_picture_problem(p_org, (p_params ->> 'source_asset_id')::uuid, 'source_asset_id');
  if problem is not null then
    return problem;
  end if;
  -- The picture an i2v ends on: the same rules, the same silence about
  -- what another organization has.
  if p_capability = 'i2v' and p_params ? 'end_asset_id' then
    return public.creative_picture_problem(p_org, (p_params ->> 'end_asset_id')::uuid, 'end_asset_id');
  end if;
  return null;
end
$$;

-- 0050's quote, with the video tool's quantity (the video's seconds, from the
-- database), its target and longest input checked against the model, a
-- per-target price, and the end frame checked against the model. Every other
-- line is 0050's.
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

  -- One price per target when the registry prices the targets apart
  -- (model_registry.credit_unit_for): a target without its own row is
  -- unpriced, never sold at another target's rate.
  if cap = 'video_upscale' and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'upscale_target' then
    m_unit := m_unit || '_' || regexp_replace(lower(p_params ->> 'target_resolution'), '[^a-z0-9]', '_', 'g');
  end if;
  if m_unit is not null then
    select * into rate from public.credit_prices where unit = m_unit;
  end if;
  if m_unit is null or rate.unit is null then
    perform public.creative_refuse('unpriced',
      format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
  end if;

  if cap in ('voice_change', 'dub', 'video_upscale') then
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
    'credits_per_unit', rate.credits_per_unit, 'margin', rate.margin, 'minimum', minimum);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The worker's call (service role)
-- ───────────────────────────────────────────────────────────────────────────

-- 0050's: the inputs of a job this worker holds, re-checked now (a video or an
-- end frame deleted since is refused), plus the end frame when the job names
-- one. The organization is the JOB's; the worker never names one.
create or replace function public.creative_job_source(p_job uuid, p_worker text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  j       public.creative_jobs;
  a       public.media_assets;
  e       public.media_assets;
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  problem text;
  out     jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  if not found or j.worker_id is distinct from w or j.status <> 'running' then
    return jsonb_build_object('ok', false, 'problem', 'the job is not this worker''s to start');
  end if;
  if coalesce(j.params ->> 'source_asset_id', '')
     !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return jsonb_build_object('ok', false, 'problem', 'the job has no source');
  end if;
  problem := public.creative_source_problem(j.org_id, j.capability, j.params);
  if problem is not null then
    return jsonb_build_object('ok', false, 'problem', problem);
  end if;
  select * into a from public.media_assets
   where id = (j.params ->> 'source_asset_id')::uuid and org_id = j.org_id;
  out := jsonb_build_object(
    'ok', true, 'asset_id', a.id, 'storage_key', a.storage_key, 'mime', a.mime, 'kind', a.kind,
    'variants', to_jsonb(a.variants), 'bytes', a.bytes, 'width', a.width, 'height', a.height,
    'duration_s', a.duration_s);
  if j.capability = 'i2v' and j.params ? 'end_asset_id' then
    -- creative_source_problem has just checked it for the job's organization.
    select * into e from public.media_assets
     where id = (j.params ->> 'end_asset_id')::uuid and org_id = j.org_id;
    out := out || jsonb_build_object('end_frame', jsonb_build_object(
      'asset_id', e.id, 'mime', e.mime, 'kind', e.kind, 'variants', to_jsonb(e.variants)));
  end if;
  return out;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges (the replaced functions keep 0035 / 0036 / 0046 / 0048 / 0050's)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.model_registry_guard() from public, anon, authenticated;
revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

revoke all on function public.creative_capability_supported(text) from public, anon, authenticated, service_role;
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_picture_problem(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.creative_source_problem(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_source_seconds(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

revoke all on function public.creative_job_source(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.creative_job_source(uuid, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.creative_capability_supported('video_upscale') as video_upscale_on,
--   public.creative_params_problem('video_upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_resolution":"4k"}') is null
--     and public.creative_params_problem('video_upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_resolution":"8k"}') is not null
--     and public.creative_params_problem('video_upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_resolution":"4k","duration_s":1}') is not null
--     as video_params_checked,
--   public.creative_params_problem('i2v',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","duration_s":5,"end_asset_id":"00000000-0000-4000-8000-000000000001"}') is null
--     and public.creative_params_problem('t2v',
--       '{"prompt":"x","duration_s":5,"end_asset_id":"00000000-0000-4000-8000-000000000001"}') is not null
--     as end_frame_params_checked,
--   not has_function_privilege('authenticated', 'public.creative_picture_problem(uuid,uuid,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_picture_problem(uuid,uuid,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_source_problem(uuid,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_job_source(uuid,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.creative_job_source(uuid,text)', 'EXECUTE')
--     as functions_scoped,
--   has_function_privilege('authenticated',
--       'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)', 'EXECUTE') as members_still_create;
