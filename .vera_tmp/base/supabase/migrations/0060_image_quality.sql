-- 0060_image_quality.sql — a quality tier for OpenAI picture models.
--
-- WHY. The OpenAI image calls were sent without a `quality` field, so the
-- vendor rendered (and billed) at its own default tier. The Studio now sends
-- one of low / medium / high, medium unless the person picks another, and the
-- price they confirm is the price OF THAT TIER.
--
--   quality   NEW param, t2i and edit only, optional: one of 'low', 'medium',
--             'high' (the explicit allow-list). Absent = 'medium' in the QUOTE only:
--             the tier the quote priced is written into the job's params at
--             create time (create_creative_job), and the worker sends EXACTLY
--             that tier — it has no default of its own, so the registry file
--             and the database copy can never disagree about what was priced.
--
-- WHAT IT CHANGES (create-or-replace; nothing dropped)
--   creative_params_problem   0055's rules plus the quality key above. It is
--                        refused for every other capability.
--   create_creative_job  0036's body (signature unchanged), with one addition: when
--                        the quote carries a quality, the job's params get
--                        {"quality": <the tier priced>} — the hold's tier. The
--                        request hash still covers what the caller sent, so a
--                        replayed idempotency key is still a replay.
--   creative_price       0052's quote, with:
--       a quality the model does not list in spec.qualities is refused
--       ('invalid_params'), never ignored — the vendor would bill its own
--       default under the quoted price;
--       when spec.pricing.variants.by = 'quality' the credit unit is
--       <credit_unit>_<tier> (model_registry.credit_unit_for, i.e.
--       model_<id>_<unit>_<tier>) — a tier without its own credit_prices row
--       is 'unpriced', never priced at another tier's rate and never 0;
--       the answer carries {"quality": "<tier>"} so what is confirmed names it.
--     Every other line is 0052's.
--   sellable_models      0055's, with spec.qualities in the public half, and a
--                        model sold by quality is listed only while at least
--                        one of its tiers has a price.
--   credit_prices        starting rows for the three OpenAI picture models'
--                        tiers (below), inserted only where no row exists.
--
-- PRICES. A starting list, NOT a measurement: each tier row is derived from the
-- model's own flat price row (the one a platform admin already set on the
-- Credits page), so a model with no flat price gets no tier rows and stays
-- unpriced. The flat price is read as the price of the vendor's default
-- (top) tier: high = 1.00x of it, medium = 0.25x, low = 0.07x — the ratios of
-- the vendor's published per-image tiers for its earlier picture models,
-- which the registry has not confirmed for these. The margin is copied.
-- The owner checks all three rows on the Credits page; `on conflict do
-- nothing` means a row that exists is never overwritten.
--
-- ORDER. If 0060 is applied BEFORE a model's flat price exists, no tier rows
-- are created and every tier of that model quotes 'unpriced' (the model is not
-- listed): safe, never wrong. After the flat price is set, run the starting-
-- price insert again (it is idempotent — the block under "Starting prices"
-- below) or set the three tier rows on the Credits page. The Verify query
-- lists the models that still lack tier rows.
--
-- WORKER. A tiered model's job that carries no tier (created before 0060, or
-- by a database whose registry copy was not synced and so quoted a flat
-- price) is refused before the provider call and its hold released: the
-- worker never invents a tier for a price it did not quote. Sync the registry
-- (tools/probe_models.py --sync) together with applying 0060.
--
-- BUILT ON 0036, 0052 AND 0055. Every function replaced here is the LATEST body
-- (create_creative_job: 0036; creative_price: 0052; creative_params_problem
-- and sellable_models: 0055)
-- with the quality lines added, so video_upscale, the i2v end frame, describe
-- and the style / source checks are exactly as they were
-- (tests/test_image_quality.py pins every string literal).
--
-- MONEY: UNCHANGED. 0036's hold / capture / release, untouched: the hold is
-- the quote, which now names the tier.
--
-- WHO MAY DO WHAT: as 0036. quote / create / cancel: signed-in members of the
-- organization. creative_params_problem, creative_price: nobody through the
-- API directly. anon: nothing. credit_prices keeps 0020's RLS (members read,
-- the platform admin writes); this migration only inserts as the table owner.
--
-- REQUIRES 0020, 0035, 0036, 0052 and 0055. Additive and idempotent:
-- create-or-replace functions, insert ... on conflict do nothing,
-- revoke-then-grant.

do $$
begin
  if to_regprocedure('public.creative_quantity(text, jsonb)') is null
     or to_regprocedure('public.creative_picture_problem(uuid, uuid, text)') is null then
    raise exception '0060 needs 0052_video_tools.sql and 0055_describe_image.sql: apply them first';
  end if;
  if to_regclass('public.credit_prices') is null then
    raise exception '0060 needs 0020_credits.sql: apply it first';
  end if;
end $$;


-- 0055's sellable_models, with the quality tiers in the public half of spec and
-- a quality-priced model listed only once one of its tiers has a price.
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

-- 0055's rules plus quality (header).
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

-- 0036's create, storing the tier that was priced in the job's params (header).
create or replace function public.create_creative_job(
  p_org uuid,
  p_capability text,
  p_model text,
  p_params jsonb default '{}'::jsonb,
  p_mode text default 'exact',
  p_idempotency_key text default null,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid   uuid := auth.uid();
  md    text := lower(btrim(coalesce(p_mode, 'exact')));
  idem  text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  hash_ text;
  prior public.creative_jobs;
  q     jsonb;
  price numeric;
  jid   uuid := gen_random_uuid();
  ref   text;
  res   jsonb;
  j     public.creative_jobs;
  jparams jsonb;
begin
  if uid is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The exempt organization's generations are paid by the platform itself,
  -- and every account that existed before 0018 is a member of it: only a
  -- platform owner/admin may spend there (reserve_credits asks for its admins
  -- too, before answering exempt).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'generations in the operator''s organization are started by a platform admin';
  end if;
  if md not in ('exact', 'auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be exact, auto, cheap, fast or quality');
  end if;
  -- Router modes need route_model() and failover, which are not built yet: a
  -- job only ever runs the model the person picked.
  if md <> 'exact' then
    perform public.creative_refuse('mode_not_supported',
      'only exact mode (the model you picked) is available on this deployment');
  end if;
  if idem is not null and idem !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    perform public.creative_refuse('invalid_idempotency_key',
      'idempotency key: 1-255 characters of A-Z a-z 0-9 _ : . -');
  end if;

  -- The org's credit account, locked for the rest of this transaction: every
  -- create (and reserve_credits itself) for this org queues behind it, so two
  -- concurrent creates cannot both spend the same available credits, and a
  -- replay of the same idempotency key finds the first one's committed row.
  perform public.credit_account_lock(p_org);

  hash_ := md5(jsonb_build_object('capability', lower(btrim(coalesce(p_capability, ''))),
                                  'model', lower(btrim(coalesce(p_model, ''))),
                                  'mode', md, 'params', coalesce(p_params, 'null'::jsonb))::text);
  if idem is not null then
    select * into prior from public.creative_jobs
     where org_id = p_org and idempotency_key = idem;
    if found then
      if prior.request_hash is distinct from hash_ then
        perform public.creative_refuse('idempotency_conflict',
          'this idempotency key was used for a different request', 'NS409');
      end if;
      return jsonb_build_object('job', public.creative_job_json(prior), 'replay', true);
    end if;
  end if;

  -- Holds of this org's jobs that nobody will run give their credits back
  -- before this one is checked against the balance.
  perform public.creative_expire_locked(p_org);

  q := public.creative_price(p_org, p_capability, p_model, p_params);
  price := (q ->> 'credits')::numeric;
  if p_max_credits is not null and price > p_max_credits then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', price, p_max_credits), 'NS409');
  end if;

  -- The tier the quote priced is the tier the job carries (0060): stored in
  -- the job's params so the worker sends EXACTLY it and never a default of its
  -- own. Absent from the request = the quote's default, written down here.
  jparams := p_params;
  if q ? 'quality' then
    jparams := coalesce(p_params, '{}'::jsonb) || jsonb_build_object('quality', q ->> 'quality');
  end if;

  ref := 'cj:' || jid::text;
  if price > 0 then
    -- NS402 'insufficient credits' (available=… needed=…) comes from here.
    res := public.creative_platform_reserve(p_org, ref, price);
    if coalesce((res ->> 'exempt')::boolean, false) then
      ref := null;
    end if;
  else
    ref := null;
  end if;

  insert into public.creative_jobs
    (id, org_id, kind, capability, mode, requested_model, routed_model, params, status,
     payer, credit_ref, credit_unit, quantity, quoted_credits, idempotency_key, request_hash,
     requested_by, expires_at)
  values
    (jid, p_org, 'generate', q ->> 'capability', md, q ->> 'model', q ->> 'model',
     jparams, 'queued', 'credits', ref, q ->> 'unit', (q ->> 'quantity')::numeric, price,
     idem, hash_, uid, now() + interval '2 hours')
  returning * into j;
  perform public.creative_job_log(jid, p_org, 'created', 'queued',
    jsonb_build_object('quoted_credits', price, 'held', ref is not null));

  return jsonb_build_object('job', public.creative_job_json(j), 'replay', false);
end
$$;

-- 0052's quote, with the quality tier: its allow-list against the model, its own
-- price row, and the tier echoed in the answer. Every other line is 0052's.
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
    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Starting prices (never overwrites; derived from an existing flat price).
-- Re-run this statement after setting a flat price that did not exist yet.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.credit_prices (unit, credits_per_unit, margin, note)
select b.unit || '_' || t.tier,
       round(b.credits_per_unit * t.ratio, 8),
       b.margin,
       left('Quality tier ' || t.tier || ': ' || t.ratio || 'x the flat price; a starting value to confirm (migration 0060).', 300)
  from public.credit_prices b
 cross join (values ('low', 0.07::numeric), ('medium', 0.25::numeric), ('high', 1.00::numeric)) as t(tier, ratio)
 where b.unit in ('model_openai_gpt_image_2_image',
                  'model_openai_gpt_image_2_5_flare_image',
                  'model_openai_gpt_image_2_5_sunburst_image')
   and b.credits_per_unit > 0
on conflict (unit) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- Privileges (the replaced functions keep 0035 / 0036 / 0052 / 0055's)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
-- create_creative_job keeps 0036's grant (signed-in members only; anon nothing), restated so it cannot drift.
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.creative_params_problem('t2i', '{"prompt":"x","quality":"high"}') is null
--     and public.creative_params_problem('edit',
--       '{"prompt":"x","source_asset_id":"00000000-0000-4000-8000-000000000000","quality":"low"}') is null
--     and public.creative_params_problem('t2i', '{"prompt":"x","quality":"ultra"}') is not null
--     and public.creative_params_problem('t2i', '{"prompt":"x","quality":1}') is not null
--     and public.creative_params_problem('t2v', '{"prompt":"x","duration_s":5,"quality":"low"}') is not null
--     as quality_params_checked,
--   public.creative_params_problem('video_upscale',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","target_resolution":"4k"}') is null
--     and public.creative_params_problem('describe',
--       '{"source_asset_id":"00000000-0000-4000-8000-000000000000","language":"uz"}') is null
--     as earlier_capabilities_kept,
--   (select count(*) from public.credit_prices
--     where unit in (select u || '_' || t
--                      from unnest(array['model_openai_gpt_image_2_image',
--                                        'model_openai_gpt_image_2_5_flare_image',
--                                        'model_openai_gpt_image_2_5_sunburst_image']) as u,
--                           unnest(array['low','medium','high']) as t)) as tier_rows_present,   -- 9 once the flat prices exist
--   -- no model with a flat price lacks tier rows (else re-run the starting-price insert above)
--   (select coalesce(array_agg(b.unit order by b.unit), '{}')
--      from public.credit_prices b
--     where b.unit in ('model_openai_gpt_image_2_image', 'model_openai_gpt_image_2_5_flare_image',
--                      'model_openai_gpt_image_2_5_sunburst_image')
--       and b.credits_per_unit > 0
--       and exists (select 1 from unnest(array['low','medium','high']) t
--                    where not exists (select 1 from public.credit_prices q where q.unit = b.unit || '_' || t))
--   ) = '{}' as no_flat_price_without_tier_rows,
--   pg_get_functiondef('public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)'::regprocedure)
--     like '%jsonb_build_object(''quality'', q ->> ''quality'')%' as job_stores_the_priced_tier,
--   not has_function_privilege('authenticated', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_params_problem(text,jsonb)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.sellable_models(text,text)', 'EXECUTE')
--     as functions_scoped,
--   has_function_privilege('authenticated',
--       'public.quote_creative_job(uuid,text,text,jsonb)', 'EXECUTE') as members_still_quote;
