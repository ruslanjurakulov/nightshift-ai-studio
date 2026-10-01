-- 0055_describe_image.sql — "Describe image": a picture the organization
-- already has in its media library -> a generation prompt for it, as TEXT
-- (Creative OS, plan §3.3). The person reads it, edits it, and may press
-- "Make similar", which only fills the text-to-image form (nothing in this
-- file, nor in the browser, generates from it on its own).
--
--   describe   an image (+ an optional output language)  -> text
--
-- A describe job is an ordinary creative job: quote -> the price on the
-- button -> max_credits -> one idempotency key per press -> hold at create,
-- capture <= the hold on success, full release on every failure. The input is
-- a media_assets row named by its id — never a URL or a path — and, as for
-- 0046's pictures, the DATABASE decides whether it may be used. The result is
-- stored on the job row (creative_jobs.result, 0036's jsonb) as
--   {"text": "<at most 600 characters>", "language": "en"|"ru"|"uz", ...}
-- and NEVER as a media asset (the CHECK below).
--
-- WHAT IT CHANGES (create-or-replace / drop-then-add; nothing dropped)
--   model_registry / model_probe_runs   the capability CHECKs accept
--                        'describe' (at most 12 per model).
--   sellable_models      0052's, accepting 'describe'.
--   creative_capability_supported   + describe.
--   creative_params_problem          0052's rules plus:
--       source_asset_id  required for describe: the uuid of an image in the
--                        media library (creative_source_problem decides);
--       language         NEW key, describe only, optional: one of 'en', 'ru',
--                        'uz' (the explicit allow-list) — the language the
--                        description is written in. Absent = English.
--     prompt, negative_prompt, aspect_ratio, resolution, seed, duration_s,
--     voice_id, factor, target_language and style_kit_id are refused for
--     describe: the picture is the whole input.
--   creative_source_problem   0052's, and describe takes 0046's picture check
--                        (creative_picture_problem, 0052)
--                        (another organization's image, a deleted one and an
--                        id that never existed read EXACTLY alike) plus a
--                        size cap: at most 15 MiB, because the picture is
--                        sent inline and the provider caps a whole request at
--                        20 MB (base64 grows it by a third).
--   creative_quantity    0046's, + describe = 1 request. Priced by the model's
--                        credit_unit exactly as everything else
--                        (credits_per_unit x (1 + margin), job_minimum floor,
--                        unpriced -> refused 'unpriced', never 0). The price
--                        is set by the platform admin on the Credits page;
--                        until a credit_prices row exists for the model's
--                        unit nothing can be quoted, so nothing is held.
--   creative_jobs        NEW CHECK creative_jobs_describe_text_check: a describe
--                        job never has library assets (result_asset_ids is
--                        empty), and its result, once there, carries a text of
--                        1..600 characters. Tightening only: no row before this
--                        migration is a describe job.
--   creative_price, creative_job_source, creative_picture_problem,
--   model_registry_guard: unchanged (0052's) — they reach the new rules through
--   the functions above.
--
-- BUILT ON 0052. Every function replaced here is 0052's latest body with the
-- describe lines added: applying 0055 after 0052 keeps video_upscale and the
-- i2v end frame exactly as 0052 left them (tests/security pins it).
--
-- MONEY: UNCHANGED. 0036's hold / capture / release, untouched.
--
-- WHO MAY DO WHAT: as 0036 / 0046 / 0050. quote / create / cancel: signed-in
-- members of the organization. creative_job_source: service role.
-- creative_source_problem, creative_quantity, creative_params_problem,
-- creative_capability_supported: nobody through the API. anon: nothing. RLS on
-- creative_jobs is unchanged: a member reads only their own organization's
-- jobs, so another organization's description is never visible.
--
-- REQUIRES 0035, 0036, 0038, 0046, 0048, 0050 and 0052 (apply 0052 first).
-- Additive and idempotent: drop-then-add constraints, create-or-replace
-- functions, revoke-then-grant. (0053 and 0054 are other changes' numbers;
-- this one does not depend on them.)

do $$
begin
  if to_regprocedure('public.creative_picture_problem(uuid, uuid, text)') is null then
    raise exception '0055 needs 0052_video_tools.sql: apply it first';
  end if;
  if to_regprocedure('public.creative_style_problem(uuid, text, jsonb)') is null then
    raise exception '0055 needs 0048_creative_style_inputs.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The registry knows the new capability
-- ───────────────────────────────────────────────────────────────────────────

alter table public.model_registry drop constraint if exists model_registry_capabilities_check;
alter table public.model_registry add constraint model_registry_capabilities_check
  check (cardinality(capabilities) between 1 and 12
         and capabilities <@ array['t2i','edit','t2v','i2v','tts','sfx','upscale','remove_bg',
                                   'voice_change','dub','video_upscale','describe']::text[]);

alter table public.model_probe_runs drop constraint if exists model_probe_runs_capability_check;
alter table public.model_probe_runs add constraint model_probe_runs_capability_check
  check (capability in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg',
                        'voice_change', 'dub', 'video_upscale', 'describe'));

-- 0052's sellable_models, accepting 'describe'. Every other line is 0052's.
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
                              'voice_change', 'dub', 'video_upscale', 'describe') then
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
-- 2. The job row: a description is text, never a library asset
-- ───────────────────────────────────────────────────────────────────────────

alter table public.creative_jobs drop constraint if exists creative_jobs_describe_text_check;
alter table public.creative_jobs add constraint creative_jobs_describe_text_check
  check (capability <> 'describe'
         or (cardinality(result_asset_ids) = 0
             and (result is null
                  -- coalesce: a CHECK passes on null, and a result without
                  -- a text would otherwise read as null, not false.
                  or coalesce(jsonb_typeof(result -> 'text') = 'string'
                              and char_length(result ->> 'text') between 1 and 600, false))));

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Params, the source, the quantity
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.creative_capability_supported(p_capability text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_capability in ('t2i', 't2v', 'tts', 'sfx', 'music', 'edit', 'i2v', 'upscale', 'remove_bg',
                          'voice_change', 'dub', 'video_upscale', 'describe')
$$;

-- 0052's rules plus describe (header). Pure: whether the picture may be used
-- is creative_source_problem's question (it needs the organization).
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
  -- describe (0055): a picture is the whole input; the output is text.
  told     boolean := p_capability = 'describe';
  sourced  boolean := p_capability in ('edit', 'i2v', 'upscale', 'remove_bg', 'voice_change', 'dub',
                                       'video_upscale', 'describe');
  -- The output keeps the source's shape: framing settings would be ignored.
  reshaped boolean := p_capability in ('upscale', 'remove_bg', 'video_upscale');
  prompted boolean := p_capability not in ('i2v', 'upscale', 'remove_bg', 'voice_change', 'dub', 'video_upscale',
                                           'describe');
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
                 'target_resolution', 'end_asset_id', 'language') then
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
    -- describe only (0055), optional (absent = English); the explicit allow-list.
    if not told then
      return format('language does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'language') is distinct from 'string'
       or (p_params ->> 'language') not in ('en', 'ru', 'uz') then
      return 'language must be one of en, ru, uz';
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

-- 0046's measure of each capability, + describe: one request.
create or replace function public.creative_quantity(p_capability text, p_params jsonb) returns numeric
  language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_capability in ('t2i', 'edit', 'remove_bg') then 1::numeric
    when p_capability in ('t2v', 'sfx', 'music', 'i2v') then (p_params ->> 'duration_s')::numeric
    when p_capability = 'tts' then char_length(p_params ->> 'prompt')::numeric
    when p_capability = 'upscale' then power((p_params ->> 'factor')::numeric / 2, 2)
    when p_capability = 'describe' then 1::numeric
  end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges (the replaced functions keep 0035 / 0036 / 0046 / 0050 / 0052's)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

revoke all on function public.creative_capability_supported(text) from public, anon, authenticated, service_role;
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_source_problem(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_quantity(text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.creative_capability_supported('describe') as describe_on,
--   public.creative_params_problem('describe',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","language":"uz"}') is null
--     and public.creative_params_problem('describe',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","language":"de"}') is not null
--     and public.creative_params_problem('describe',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","prompt":"x"}') is not null
--     and public.creative_params_problem('t2i', '{"prompt":"x","language":"en"}') is not null
--     as describe_params_checked,
--   public.creative_quantity('describe', '{}') = 1 as describe_is_one_request,
--   public.creative_capability_supported('video_upscale')
--     and public.creative_params_problem('video_upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_resolution":"4k"}') is null
--     and public.creative_params_problem('i2v',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","duration_s":5,"end_asset_id":"00000000-0000-4000-8000-000000000001"}') is null
--     as video_tools_of_0052_kept,
--   exists (select 1 from pg_constraint
--            where conname = 'creative_jobs_describe_text_check') as describe_text_only,
--   not has_function_privilege('authenticated', 'public.creative_source_problem(uuid,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_quantity(text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_job_source(uuid,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.creative_job_source(uuid,text)', 'EXECUTE')
--     as functions_scoped,
--   has_function_privilege('authenticated',
--       'public.quote_creative_job(uuid,text,text,jsonb)', 'EXECUTE') as members_still_quote;
