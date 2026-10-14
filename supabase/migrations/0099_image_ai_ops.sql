-- 0099_image_ai_ops.sql — three more picture tools, priced like any creative job
-- and sold only once the owner has proven a model and set its price
-- (AI-edit wave 2, track F2a; the pattern of 0046's upscale / remove_bg):
--
--   expand    a library picture -> the same picture extended to a chosen shape
--             (16:9, 9:16, 1:1, 4:3 or 3:4), the new edges filled in   -> image
--   relight   a library picture -> the same picture in another light, named
--             by a choice (soft, warm, cool, golden_hour, dramatic, studio) OR
--             by a short prompt, never both                             -> image
--   erase     a library picture + the name of ONE object (a short prompt; no
--             mask) -> the picture without it                           -> image
--
-- Each is an ordinary creative job: quote -> the price on the button ->
-- max_credits -> one idempotency key per press -> hold at create, capture <=
-- the hold on success, full release on every failure. The input is a
-- media_assets row named by its id — never a URL or a path — and the DATABASE
-- decides whether it may be used (0046's picture check: the SAME organization's,
-- live, a JPEG / PNG / WebP / HEIC-with-a-display-copy, plus a 15 MB limit
-- because the picture travels inline) and what it costs: ONE picture at the
-- model's credit price, from the registry and credit_prices. A model with no
-- price row answers 'unpriced', a model that is not probed answers
-- 'model_not_sellable' — never a zero.
--
-- WHAT IT CHANGES (create-or-replace / drop-then-add; nothing dropped)
--   model_registry / model_probe_runs   the capability CHECKs accept 'expand',
--                        'relight' and 'erase' (at most 16 per model).
--   model_registry_guard 0070's, plus: a change of spec.relight_looks or of
--                        spec.aspect_ratios_by_capability.expand clears the
--                        model's proof like a change of its capabilities does.
--   sellable_models      0084's (the rate as charged, no margin), accepting the
--                        new capabilities; the public spec shows relight_looks
--                        (aspect_ratios_by_capability was already public).
--   creative_capability_supported   + expand, relight, erase.
--   creative_params_problem          0072's rules, one new key and the closed lists:
--       source_asset_id  required for the three (an image of the library);
--       aspect_ratio     expand only, REQUIRED, one of 16:9 9:16 1:1 4:3 3:4;
--       look             relight only: soft warm cool golden_hour dramatic studio;
--       prompt           expand: optional, relight: instead of a look, erase: required
--                        (the object) — plain text on one line, 300 / 300 / 200 characters at most.
--     relight takes EXACTLY ONE of look / prompt. Settings that would be silently
--     ignored (negative prompt, resolution, seed, a factor, a duration, a voice,
--     a style) are refused, as 0036 refuses unknown keys; aspect_ratio is refused
--     on relight and erase (the picture keeps its own shape).
--   creative_source_problem   0072's; the three take 0046's picture check and
--                        refuse a picture over 15 MB (another organization's
--                        picture, a deleted one and an id that never existed
--                        read EXACTLY alike).
--   creative_quantity    + expand, relight, erase = 1 picture.
--   creative_price       0084's, plus: a shape the model does not list in
--                        spec.aspect_ratios_by_capability.expand, or a look it
--                        does not list in spec.relight_looks, is refused
--                        'invalid_params' before any hold — the provider would
--                        otherwise render (and bill) something else under the
--                        quoted price.
--   creative_job_source, attach_creative_job_assets, create_creative_job,
--   quote_creative_route and the router: unchanged — they reach the new rules through
--   the functions above.
--
-- BUILT ON 0072 / 0084 / 0070 / 0055. Every function replaced here is the
-- latest body (sellable_models and creative_price: 0084's; creative_capability_supported,
-- creative_params_problem and creative_source_problem: 0072's; creative_quantity: 0055's;
-- model_registry_guard: 0070's) with the picture ops' lines added; tests pin every
-- string literal of every one. Applying 0099 keeps captions, the video upscale, the
-- voice tools, describe, the quality tiers, the video price variants and the private
-- margin exactly as they were.
--
-- ORDER. 0099 refuses to apply without 0070, 0072 and 0084 (below): on older
-- bodies it would silently take their lines away. Any migration numbered above
-- 0099 that replaces one of these functions must carry these lines too
-- (tests/test_image_ai_ops.py fails when one does not).
--
-- NOT SOLD UNTIL THE OWNER SAYS SO. This file adds no model, no price and no
-- availability. The registry entries that ship with it (schemas/model_registry.json)
-- are 'hidden' with terms_gate terms_review_required, no probe and no credit_prices row:
-- until the owner clears the gate, a probe succeeds against the real provider with
-- the owner's key, and a credit_prices row is set, sellable_models() lists nothing
-- for these capabilities and a quote answers model_not_sellable / unpriced.
--
-- MONEY: UNCHANGED. 0036's hold / capture / release, untouched.
--
-- WHO MAY DO WHAT: as 0036. quote / create / cancel: signed-in members of the
-- organization. creative_params_problem, creative_source_problem,
-- creative_quantity, creative_price: nobody through the API. anon: nothing.
--
-- REQUIRES 0035, 0036, 0038, 0046, 0055, 0070, 0072 and 0084. Additive and
-- idempotent: drop-then-add constraints, create-or-replace functions,
-- revoke-then-grant.

do $$
begin
  if to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.creative_quantity(text, jsonb)') is null
     or to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0099 needs 0036_creative_jobs.sql and 0055_describe_image.sql: apply them first';
  end if;
  -- creative_params_problem / creative_price carry 0070's video price variants.
  if position('audio must be true or false' in pg_get_functiondef('public.creative_params_problem(text, jsonb)'::regprocedure)) = 0
     or position('default_resolution' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) = 0 then
    raise exception '0099 needs 0070_video_price_variants.sql: apply it first';
  end if;
  -- 0072 added captions to every one of them.
  if position('captions' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) = 0
     or position('captions' in pg_get_functiondef('public.creative_price(uuid, text, text, jsonb)'::regprocedure)) = 0
     or position('captions' in pg_get_functiondef('public.creative_params_problem(text, jsonb)'::regprocedure)) = 0
     or position('captions' in pg_get_functiondef('public.creative_source_problem(uuid, text, jsonb)'::regprocedure)) = 0
     or position('captions' in pg_get_functiondef('public.creative_capability_supported(text)'::regprocedure)) = 0 then
    raise exception '0099 needs 0072_captions.sql: apply it first';
  end if;
  -- 0084 took the margin out of sellable_models and every quote.
  if position('null::numeric' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) = 0
     or position('rate.credits_per_unit * (1 + rate.margin)' in pg_get_functiondef('public.creative_price(uuid, text, text, jsonb)'::regprocedure)) = 0 then
    raise exception '0099 needs 0084_margin_private.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The registry knows the new capabilities
-- ───────────────────────────────────────────────────────────────────────────

alter table public.model_registry drop constraint if exists model_registry_capabilities_check;
alter table public.model_registry add constraint model_registry_capabilities_check
  check (cardinality(capabilities) between 1 and 16
         and capabilities <@ array['t2i','edit','t2v','i2v','tts','sfx','upscale','remove_bg',
                                   'voice_change','dub','video_upscale','describe','captions',
                                   'expand','relight','erase']::text[]);

alter table public.model_probe_runs drop constraint if exists model_probe_runs_capability_check;
alter table public.model_probe_runs add constraint model_probe_runs_capability_check
  check (capability in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg',
                        'voice_change', 'dub', 'video_upscale', 'describe', 'captions',
                        'expand', 'relight', 'erase'));

-- 0070's guard, plus the two spec fields 0099 sells by: a change of the lights
-- or of the shapes a model is sold for is a new claim, so the old proof stops
-- standing (the model is hidden until it is probed again).
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
      or new.spec -> 'pricing' -> 'variants' -> 'by' is distinct from old.spec -> 'pricing' -> 'variants' -> 'by'
      -- 0099: the lights a model relights with and the shapes it extends a picture to.
      or new.spec -> 'relight_looks' is distinct from old.spec -> 'relight_looks'
      or new.spec -> 'aspect_ratios_by_capability' -> 'expand' is distinct from old.spec -> 'aspect_ratios_by_capability' -> 'expand') then
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

-- 0084's sellable_models, accepting the three picture ops and publishing
-- spec.relight_looks. Every other line is 0084's.
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
                              'voice_change', 'dub', 'video_upscale', 'describe', 'captions',
                              'expand', 'relight', 'erase') then
    raise exception 'unknown capability %', p_capability using errcode = '22023';
  end if;
  -- Captions are a web tool (0072): the transcript lives in caption_tracks,
  -- which only a signed-in member's session can read. Sold through the API or
  -- MCP (api_creative_model_ok asks this function for 'api'), a key could pay
  -- for a job whose result it can never fetch. No other surface lists them,
  -- whatever the registry says.
  if p_capability = 'captions' and p_surface <> 'web' then
    return;
  end if;
  return query
    select m.id, m.display_name, m.provider, m.capabilities, m.availability, m.verified_at,
           -- 0084: the rate as charged (margin folded in) and never the margin
           -- itself. The column stays (NULL) so the return type, and every
           -- earlier migration's create-or-replace on a replay, is unchanged.
           m.credit_unit, m.entitlement, cp.credits_per_unit * (1 + cp.margin), null::numeric,
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
             'relight_looks', m.spec -> 'relight_looks',
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
       and (p_surface = 'web' or not ('captions' = any (m.capabilities)))
     order by m.provider, m.id;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Params, the source, the quantity, the price (0072's / 0084's latest bodies + the picture ops)
-- ───────────────────────────────────────────────────────────────────────────

-- 0072's, with the three picture ops in the list.
create or replace function public.creative_capability_supported(p_capability text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_capability in ('t2i', 't2v', 'tts', 'sfx', 'music', 'edit', 'i2v', 'upscale', 'remove_bg',
                          'voice_change', 'dub', 'video_upscale', 'describe', 'captions',
                          'expand', 'relight', 'erase')
$$;

-- 0072's rules plus expand / relight / erase (header). Pure: whether the picture may be
-- used is creative_source_problem's question (it needs the organization).
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
                                       'video_upscale', 'describe', 'captions',
                                       'expand', 'relight', 'erase');
  -- The output keeps the source's shape: framing settings would be ignored.
  reshaped boolean := p_capability in ('upscale', 'remove_bg', 'video_upscale', 'relight', 'erase');
  -- expand (0099): the picture is the whole input, but its SHAPE is the ask.
  grown    boolean := p_capability = 'expand';
  prompted boolean := p_capability not in ('i2v', 'upscale', 'remove_bg', 'voice_change', 'dub', 'video_upscale',
                                           'describe', 'captions', 'expand', 'relight');
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
    if reshaped or grown or voiced or told then
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
  if p_params ? 'resolution' then
    if filmed then
      return 'resolution does not apply to video_upscale: name the result''s size as target_resolution';
    end if;
    if reshaped or grown or voiced or told then
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
    if reshaped or grown or voiced or told then
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
    -- Control characters and the Unicode line / paragraph separators (U+2028, U+2029) and NEL (U+0085).
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

-- 0072's, and the three picture ops take 0046's picture check plus a 15 MB limit (header).
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
  if p_capability not in ('edit', 'i2v', 'upscale', 'remove_bg', 'describe', 'expand', 'relight', 'erase') then
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
  -- expand / relight / erase (0099): the picture travels inline to the provider
  -- (a whole request is capped at 20 MB; base64 grows it by a third), so the
  -- limit is the description's. A HEIC photo is sent as its JPEG display
  -- copy, which is smaller. The asset was just checked for this organization.
  if p_capability in ('expand', 'relight', 'erase') then
    select * into a from public.media_assets
     where id = (p_params ->> 'source_asset_id')::uuid and org_id = p_org;
    if a.mime not in ('image/heic', 'image/heif') and a.bytes > 15728640 then
      return 'this picture is larger than 15 MB; use a smaller copy';
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

-- 0055's, with the three picture ops priced as one picture.
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

-- 0084's quote, with the shape (expand) and the light (relight) checked against the
-- model's own lists. Every other line is 0084's.
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
  -- 0099: nor a shape to extend a picture to, or a light, that the model was
  -- not proven (and listed) for. A free prompt for a relight needs no list.
  if cap = 'expand'
     and not coalesce(jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> 'expand') = 'array'
                      and (m_spec -> 'aspect_ratios_by_capability' -> 'expand') @> jsonb_build_array(p_params ->> 'aspect_ratio'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not extend a picture to %s', mdl, p_params ->> 'aspect_ratio'));
  end if;
  if cap = 'relight' and p_params ? 'look'
     and not coalesce(jsonb_typeof(m_spec -> 'relight_looks') = 'array'
                      and (m_spec -> 'relight_looks') @> jsonb_build_array(p_params ->> 'look'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s light', mdl, p_params ->> 'look'));
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
    -- 0084: the rate as charged, never the platform's base rate and margin
    -- apart (every quote, the API's and the routed ones included).
    'credits_per_unit', rate.credits_per_unit * (1 + rate.margin), 'minimum', minimum)
    -- The tier this price is for, so what the person confirms names it.
    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end
    -- The resolution and soundtrack this price is for (0070).
    || variant;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Privileges (the replaced functions keep their earlier grants)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.model_registry_guard() from public, anon, authenticated;
revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

revoke all on function public.creative_capability_supported(text) from public, anon, authenticated, service_role;
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_source_problem(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_quantity(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.creative_capability_supported('expand')
--     and public.creative_capability_supported('relight')
--     and public.creative_capability_supported('erase') as picture_ops_on,
--   public.creative_params_problem('expand',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","aspect_ratio":"16:9"}') is null
--     and public.creative_params_problem('expand',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","aspect_ratio":"21:9"}') is not null
--     and public.creative_params_problem('expand',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000"}') is not null
--     and public.creative_params_problem('relight',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","look":"warm"}') is null
--     and public.creative_params_problem('relight',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","look":"warm","prompt":"x"}') is not null
--     and public.creative_params_problem('relight',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000"}') is not null
--     and public.creative_params_problem('erase',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","prompt":"the red car"}') is null
--     and public.creative_params_problem('erase',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000"}') is not null
--     as picture_params_checked,
--   public.creative_quantity('expand', '{}') = 1
--     and public.creative_quantity('relight', '{}') = 1
--     and public.creative_quantity('erase', '{}') = 1 as one_picture_each,
--   public.creative_params_problem('captions',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","language":"uz"}') is null
--     and public.creative_params_problem('upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","factor":2}') is null
--     and public.creative_params_problem('video_upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_resolution":"4k"}') is null
--     and public.creative_params_problem('t2i', '{"prompt":"x","look":"warm"}') is not null
--     as earlier_tools_kept,
--   -- Nothing became sellable by applying this file: no model lists the new capabilities yet.
--   not exists (select 1 from public.sellable_models() s
--                where s.capabilities && array['expand', 'relight', 'erase']) as nothing_sold_yet,
--   not has_function_privilege('authenticated', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_source_problem(uuid,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.sellable_models(text,text)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.sellable_models(text,text)', 'EXECUTE')
--     and has_function_privilege('authenticated',
--       'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)', 'EXECUTE') as functions_scoped;
