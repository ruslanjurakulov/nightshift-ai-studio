-- 0070_video_price_variants.sql — a video is priced by the resolution and the
-- soundtrack it is made with, and both are pinned.
--
-- WHY. A video quote was one price per second, but the vendors bill by what is
-- rendered: Seedance 1.5 pro is $0.026/s silent, $0.052/s at 720p with audio and
-- $0.116/s at 1080p with audio; Wan 2.7 is $0.10/s at 720P and $0.15/s at
-- 1080P; Kling 3.0 is $0.084/s without audio and $0.126/s with it. The
-- adapters sent no resolution (Seedance) or no audio flag (Seedance, Kling), so
-- the vendor's own default decided what a job cost under a price quoted for
-- another. Now the worker always sends what was quoted, and the quote prices
-- exactly that.
--
--   resolution  an existing param, now checked against the model: t2v and i2v
--               on a model that lists no such resolution are refused
--               ('invalid_params') before any hold. Absent = the model's
--               spec.default_resolution (720p), in the quote AND in the worker.
--   audio       NEW param, t2v and i2v only, a JSON boolean, accepted only by a
--               model priced by it (spec.pricing.variants.by is 'audio' or
--               'resolution_audio'). Absent = false (silent), in the quote AND
--               in the worker.
--
-- HOW A VIDEO IS PRICED (the 0052 / 0060 mechanism: model_registry.credit_unit_for,
-- model_<id>_<unit>_<variant>). When spec.pricing.variants.by is
--   'resolution'        (only with spec.default_resolution)   <unit>_720p
--   'audio'                                                    <unit>_silent | <unit>_audio
--   'resolution_audio'                                         <unit>_720p_silent | <unit>_1080p_audio ...
-- the quote reads that variant's own credit_prices row. A variant without a
-- row is 'unpriced': never the base row's rate, never another variant's, never
-- 0. A resolution or audio setting the model does not list is refused, never
-- ignored. A model whose variants.by is 'resolution' but which pins no
-- default_resolution (Veo, Wan 3.0) is quoted as before, by its base row.
-- The answer names the variant ({"resolution": "720p", "audio": false}), so
-- what is confirmed says what is made.
--
-- WHAT IT CHANGES (create-or-replace; nothing dropped)
--   creative_params_problem   0060's rules plus the audio key above.
--   creative_price            0060's quote plus the checks and the variant above.
--                             Every other line is 0060's (0052's video_upscale
--                             target price, the quality tier, 0055's describe).
--   sellable_models           0060's, with spec.default_resolution in the public
--                             half, and a model sold by audio or by a pinned
--                             resolution listed only while at least one of its
--                             variants has a price.
--   model_registry_guard      0052's, plus spec.qualities (0060), spec.default_resolution
--                             and spec.pricing.variants.by (0070): what is sent to the
--                             vendor changed, so the old probe proves nothing.
--   credit_prices             starting rows (below), inserted only where no row exists.
--
-- PRICES (provider USD per second x 100 = credits per second, margin 1.5, read
-- from the vendors' pages on 2026-10-01, docs/sql/prices_corrections_2026_10_01.sql):
--   seedance_1_5_pro  720p_silent 2.6   720p_audio 5.2   1080p_audio 11.6
--                     (480p and 1080p silent: not read, so no row: unpriced)
--   wan_2_7           720p 10   1080p 15
--   kling_v3          silent 8.4   audio 12.6
-- `on conflict do nothing`: a row the owner already set is never overwritten.
--
-- MONEY: UNCHANGED. 0036's hold / capture / release, untouched: the hold is
-- the quote, which now names the variant.
--
-- WHO MAY DO WHAT: as 0036. quote / create / cancel: signed-in members of the
-- organization. creative_params_problem, creative_price: nobody through the
-- API directly. anon: nothing. credit_prices keeps 0020's RLS.
--
-- BUILT ON the LATEST bodies: creative_price, creative_params_problem and
-- sellable_models are 0060's (tests/test_video_price_variants.py pins every
-- string literal of them).
--
-- REQUIRES 0020, 0035, 0036, 0052, 0055 and 0060. Additive and idempotent:
-- create-or-replace functions, insert ... on conflict do nothing,
-- revoke-then-grant.

do $$
begin
  if to_regprocedure('public.creative_quantity(text, jsonb)') is null
     or to_regprocedure('public.creative_picture_problem(uuid, uuid, text)') is null then
    raise exception '0070 needs 0052_video_tools.sql and 0055_describe_image.sql: apply them first';
  end if;
  if to_regclass('public.credit_prices') is null then
    raise exception '0070 needs 0020_credits.sql: apply it first';
  end if;
  -- 0060's functions carry the quality tier: replacing them from anything older would drop it.
  if position('qualities' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) = 0
     or position('quality' in pg_get_functiondef('public.creative_params_problem(text, jsonb)'::regprocedure)) = 0 then
    raise exception '0070 needs 0060_image_quality.sql: apply it first';
  end if;
  -- The guard below is 0052's plus lines: replacing anything older would drop an earlier check.
  if to_regprocedure('public.model_registry_guard()') is null
     or position('end_frame' in pg_get_functiondef('public.model_registry_guard()'::regprocedure)) = 0 then
    raise exception '0070 needs 0052_video_tools.sql: apply it first';
  end if;
end $$;


-- 0052's guard (0050's, 0046's before it), plus what is now SENT to the vendor
-- because of how a model is priced: the quality tiers (0060, never extended
-- there), the pinned resolution and the way a clip is priced by resolution /
-- soundtrack (0070). Changing any of them re-opens the proof: the model goes
-- back to hidden until a probe of the new call passes. Every earlier check is kept.
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
      or new.spec -> 'end_frame' is distinct from old.spec -> 'end_frame'
      -- 0060: the tiers a picture model is sent a quality for.
      or new.spec -> 'qualities' is distinct from old.spec -> 'qualities'
      -- 0070: the resolution a clip is always sent, and how it is priced by
      -- resolution / soundtrack (the worker then sends resolution / sound).
      or new.spec -> 'default_resolution' is distinct from old.spec -> 'default_resolution'
      or new.spec -> 'pricing' -> 'variants' -> 'by' is distinct from old.spec -> 'pricing' -> 'variants' -> 'by') then
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

revoke all on function public.model_registry_guard() from public, anon, authenticated;

-- 0060's sellable_models, with the pinned resolution and the way a model is priced
-- in the public half of spec, and a model priced by soundtrack (or by a pinned
-- resolution) listed only once one of its variants has a price.
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
             'qualities', m.spec -> 'qualities',
             'default_resolution', m.spec -> 'default_resolution',
             'price_variants_by', m.spec -> 'pricing' -> 'variants' -> 'by',
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
       -- Likewise a model sold by soundtrack, or by a resolution it pins (0070):
       -- shown only while one of its variants has a price (never free).
       and (not (coalesce(m.spec -> 'pricing' -> 'variants' ->> 'by', '') in ('audio', 'resolution_audio')
                 or (coalesce(m.spec -> 'pricing' -> 'variants' ->> 'by', '') = 'resolution'
                     and nullif(m.spec ->> 'default_resolution', '') is not null))
            or exists (select 1
                         from jsonb_object_keys(coalesce(m.spec -> 'pricing' -> 'variants' -> 'prices', '{}'::jsonb)) as vk(variant)
                         join public.credit_prices vp
                           on vp.unit = m.credit_unit || '_' || regexp_replace(lower(vk.variant), '[^a-z0-9]', '_', 'g')
                        where vp.credits_per_unit > 0))
       and (p_capability is null or p_capability = any (m.capabilities))
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') <> 'web_only')
     order by m.provider, m.id;
end
$$;

-- 0060's rules plus audio (header).
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
                 'target_resolution', 'end_asset_id', 'language', 'quality', 'audio') then
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

-- 0060's quote, with the video settings: the resolution and soundtrack checked
-- against the model, the variant's own price row, and the variant echoed in the
-- answer. Every other line is 0060's.
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
  vby     text;
  vres    text;
  vaud    text;
  variant jsonb := '{}'::jsonb;
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
  -- The video settings (0070).
  if cap in ('t2v', 'i2v') then
    vby := m_spec -> 'pricing' -> 'variants' ->> 'by';
    -- A resolution the model does not list is refused, never ignored: the
    -- vendor would render (and bill) something else under the quoted price.
    if p_params ? 'resolution'
       and not coalesce(jsonb_typeof(m_spec -> 'resolutions') = 'array'
                        and (m_spec -> 'resolutions') @> jsonb_build_array(p_params ->> 'resolution'), false) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer %s', mdl, p_params ->> 'resolution'));
    end if;
    -- A soundtrack choice only on a model that prices it apart (the worker
    -- sends the flag for no other), and only if it makes sound at all.
    if p_params ? 'audio'
       and (coalesce(vby, '') not in ('audio', 'resolution_audio')
            or coalesce(m_spec -> 'audio_out', 'false'::jsonb) <> 'true'::jsonb) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer a choice of sound', mdl));
    end if;
    -- One price per setting when the registry prices the settings apart
    -- (model_registry.credit_unit_for: model_<id>_<unit>_<resolution>_<silent|audio>).
    -- No resolution named = the model's pinned one and no audio = silent, the
    -- same the worker sends. A resolution variant counts only for a model that
    -- pins one (Veo and Wan 3.0 are still sold by their base row). A setting
    -- without its own row is unpriced, never another setting's rate, never 0.
    if m_unit is not null
       and (coalesce(vby, '') in ('audio', 'resolution_audio')
            or (coalesce(vby, '') = 'resolution' and nullif(m_spec ->> 'default_resolution', '') is not null)) then
      if vby in ('resolution', 'resolution_audio') then
        vres := coalesce(p_params ->> 'resolution', nullif(m_spec ->> 'default_resolution', ''));
        if vres is null then
          perform public.creative_refuse('unpriced',
            format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
        end if;
      end if;
      if vby in ('audio', 'resolution_audio') then
        vaud := case when coalesce((p_params ->> 'audio')::boolean, false) then 'audio' else 'silent' end;
      end if;
      m_unit := m_unit || '_' || regexp_replace(lower(concat_ws('_', vres, vaud)), '[^a-z0-9]', '_', 'g');
      variant := jsonb_strip_nulls(jsonb_build_object(
        'resolution', vres, 'audio', case when vaud is null then null else vaud = 'audio' end));
    end if;
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
    'credits_per_unit', rate.credits_per_unit, 'margin', rate.margin, 'minimum', minimum)
    -- The tier this price is for, so what the person confirms names it.
    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end
    -- The resolution and soundtrack this price is for (0070).
    || variant;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Starting prices (never overwrites). Provider USD per second x 100 = credits
-- per second; margin 1.5 as the other video rows; read 2026-10-01.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.credit_prices (unit, credits_per_unit, margin, note) values
  ('model_seedance_1_5_pro_second_720p_silent', 2.6, 1.5,
   'BytePlus list 2026-10-01: 720p silent $0.026/s (migration 0070).'),
  ('model_seedance_1_5_pro_second_720p_audio', 5.2, 1.5,
   'BytePlus list 2026-10-01: 720p with audio $0.26 per 5 s = $0.052/s (migration 0070).'),
  ('model_seedance_1_5_pro_second_1080p_audio', 11.6, 1.5,
   'BytePlus list 2026-10-01: 1080p with audio $0.116/s (migration 0070). 480p and 1080p silent: not read, unpriced.'),
  ('model_wan_2_7_second_720p', 10, 1.5,
   'Alibaba international list 2026-10-01: 720P $0.10/s (migration 0070).'),
  ('model_wan_2_7_second_1080p', 15, 1.5,
   'Alibaba international list 2026-10-01: 1080P $0.15/s (migration 0070).'),
  ('model_kling_v3_second_silent', 8.4, 1.5,
   'Kling list 2026-10-01: v3 720p without audio 0.6 units = $0.084/s (migration 0070).'),
  ('model_kling_v3_second_audio', 12.6, 1.5,
   'Kling list 2026-10-01: v3 720p with audio $0.126/s (migration 0070).')
on conflict (unit) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- Privileges (the replaced functions keep 0035 / 0036 / 0052 / 0055 / 0060's)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.creative_params_problem('t2v', '{"prompt":"x","duration_s":5,"audio":true}') is null
--     and public.creative_params_problem('t2v', '{"prompt":"x","duration_s":5,"audio":"yes"}') is not null
--     and public.creative_params_problem('t2i', '{"prompt":"x","audio":true}') is not null
--     as audio_param_checked,
--   public.creative_params_problem('t2i', '{"prompt":"x","quality":"high"}') is null
--     and public.creative_params_problem('video_upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_resolution":"4k"}') is null
--     as earlier_capabilities_kept,
--   position('default_resolution' in pg_get_functiondef('public.model_registry_guard()'::regprocedure)) > 0
--     and position('qualities' in pg_get_functiondef('public.model_registry_guard()'::regprocedure)) > 0
--     and position('vendor_model_by_capability' in pg_get_functiondef('public.model_registry_guard()'::regprocedure)) > 0
--     as guard_reopens_proof,
--   (select count(*) from public.credit_prices
--     where unit in ('model_seedance_1_5_pro_second_720p_silent', 'model_seedance_1_5_pro_second_720p_audio',
--                    'model_seedance_1_5_pro_second_1080p_audio', 'model_wan_2_7_second_720p',
--                    'model_wan_2_7_second_1080p', 'model_kling_v3_second_silent',
--                    'model_kling_v3_second_audio')) as variant_rows_present,   -- 7
--   not has_function_privilege('authenticated', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_params_problem(text,jsonb)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.sellable_models(text,text)', 'EXECUTE')
--     as functions_scoped,
--   has_function_privilege('authenticated',
--       'public.quote_creative_job(uuid,text,text,jsonb)', 'EXECUTE') as members_still_quote;
