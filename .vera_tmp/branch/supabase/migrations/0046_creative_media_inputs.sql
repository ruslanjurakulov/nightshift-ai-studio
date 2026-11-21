-- 0046_creative_media_inputs.sql — generations that start from a picture the
-- organization already has in its media library (Creative OS, plan §3.3):
--
--   edit       an image + what to change, typed       -> image
--   i2v        an image (+ an optional prompt), a length -> video
--   upscale    an image, 2x or 4x                       -> image
--   remove_bg  an image                                 -> image (cut-out)
--
-- 0036 held these back on purpose ("a URL typed by a browser is not an input
-- the worker may fetch"). The input is now a media_assets row (0038) named by
-- its id, never a URL or a path, and the database decides whether it may be
-- used — the browser, the Command Center and the worker do not.
--
-- WHAT IT CHANGES (create-or-replace / drop-then-add; nothing dropped)
--   model_registry / model_probe_runs   the capability CHECKs accept 'upscale'
--                        and 'remove_bg' (at most 8 per model); a change of
--                        spec.upscale_factors clears verification like a
--                        change of capabilities does (model_registry_guard).
--   sellable_models      accepts the new capabilities; the public spec shows
--                        upscale_factors.
--   creative_capability_supported   + edit, i2v, upscale, remove_bg.
--   creative_params_problem          two new keys:
--       source_asset_id  required for the four, refused for every other
--                        capability: the uuid of a media asset;
--       factor           upscale only, required: 2 or 4.
--     prompt is optional for i2v and upscale, refused for remove_bg; i2v
--     needs duration_s like t2v. Settings that would be silently ignored
--     (aspect ratio, resolution, seed, negative prompt on upscale /
--     remove_bg) are refused, as 0036 refuses unknown keys.
--   creative_quantity    the measure each new capability is priced in:
--       edit, remove_bg  1 image
--       i2v              duration_s seconds of output (as t2v)
--       upscale          (factor / 2)^2 — 1 at 2x, 4 at 4x: a 4x output has
--                        four times the pixels of a 2x one
--     priced by the model's model_registry.credit_unit exactly as 0036
--     prices everything (credits_per_unit x (1 + margin), job_minimum floor,
--     unpriced -> refused, never 0). THE PRICE IS COMPUTED HERE, never taken
--     from the client.
--   creative_price       + the source check (below) and, for upscale, the
--                        factor must be one the model lists in
--                        spec.upscale_factors. Everything else is 0036's body.
--
-- THE SOURCE CHECK — creative_source_problem(org, capability, params)
--   Called by creative_price, so by quote_creative_job AND create_creative_job
--   (inside its transaction, before any hold). The asset must:
--     * exist AND belong to the job's organization (org_id = p_org) — another
--       organization's asset reads exactly like an id that does not exist
--       ("no image in this organization"): ids confirm nothing across orgs;
--     * be live (not soft-deleted, not purged);
--     * be an image of a type a provider takes (JPEG, PNG, WebP; a HEIC /
--       HEIF photo only once its JPEG 'display' copy exists — 0044). GIF is
--       refused.
--   Refused with NS400 'source_unavailable' (detail: the sentence). Nothing is
--   held and no job row is written.
--
-- THE WORKER'S SIDE (service role only)
--   creative_job_source(job, worker)   the job's source asset — re-checked
--       NOW (it may have been deleted since the job was created), and only
--       for the worker that holds the job while it is 'running' (before the
--       paid call). Answers {ok, asset_id, storage_key, mime, variants, …} or
--       {ok:false, problem}. The worker builds the file path from the asset
--       id alone (modules/media_library.py) — never from a row's text.
--   attach_creative_job_assets(job, worker, asset ids)   records the library
--       assets a job produced in creative_jobs.result_asset_ids: only while
--       the worker holds the job in 'processing', and only assets of the
--       job's organization that the worker registered as this job's
--       generated output (source 'generated', provenance.job_id = the job).
--
-- MONEY: UNCHANGED. Hold at create (= the quote), capture <= the hold on
-- success, full release on every failure — 0036's functions, untouched. A
-- source that disappears before the run fails the job ('source_unavailable')
-- and releases its hold like any other failure.
--
-- WHO MAY DO WHAT: as 0036. quote / create / cancel: signed-in members of the
-- organization. creative_job_source, attach_creative_job_assets: service role.
-- creative_source_problem: nobody through the API. anon: nothing.
--
-- REQUIRES 0035 (model_registry), 0036 (creative_jobs) and 0038
-- (media_assets). Additive and idempotent: drop-then-add constraints,
-- create-or-replace functions, revoke-then-grant.

do $$
begin
  if to_regclass('public.model_registry') is null then
    raise exception '0046 needs 0035_model_registry.sql: apply it first';
  end if;
  if to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null then
    raise exception '0046 needs 0036_creative_jobs.sql: apply it first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0046 needs 0038_media_assets.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The registry knows the new capabilities
-- ───────────────────────────────────────────────────────────────────────────

alter table public.model_registry drop constraint if exists model_registry_capabilities_check;
alter table public.model_registry add constraint model_registry_capabilities_check
  check (cardinality(capabilities) between 1 and 8
         and capabilities <@ array['t2i','edit','t2v','i2v','tts','sfx','upscale','remove_bg']::text[]);

alter table public.model_probe_runs drop constraint if exists model_probe_runs_capability_check;
alter table public.model_probe_runs add constraint model_probe_runs_capability_check
  check (capability in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg'));

-- 0035's guard, plus: the upscale factors a model is sold for are part of
-- what was proven. Offering 4x after a 2x probe is a new claim.
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
      or new.spec -> 'upscale_factors' is distinct from old.spec -> 'upscale_factors') then
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

-- 0035's sellable_models with the two new capabilities and upscale_factors in
-- the public half of spec.
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
     and p_capability not in ('t2i', 'edit', 't2v', 'i2v', 'tts', 'sfx', 'upscale', 'remove_bg') then
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
             'upscale_factors', m.spec -> 'upscale_factors',
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
-- 2. Params, the source, the quantity
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.creative_capability_supported(p_capability text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_capability in ('t2i', 't2v', 'tts', 'sfx', 'music', 'edit', 'i2v', 'upscale', 'remove_bg')
$$;

-- 0036's rules for the text-only capabilities are unchanged; see the header
-- for the new ones. Pure: whether the source asset may be used is
-- creative_source_problem's question (it needs the organization).
create or replace function public.creative_params_problem(p_capability text, p_params jsonb)
  returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k        text;
  timed    boolean := p_capability in ('t2v', 'sfx', 'music', 'i2v');
  sourced  boolean := p_capability in ('edit', 'i2v', 'upscale', 'remove_bg');
  -- The output keeps the source's shape: framing settings would be ignored.
  reshaped boolean := p_capability in ('upscale', 'remove_bg');
  prompted boolean := p_capability not in ('i2v', 'upscale', 'remove_bg');
begin
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    return 'params must be a JSON object';
  end if;
  if octet_length(p_params::text) > 16384 then
    return 'params are too large';
  end if;
  for k in select jsonb_object_keys(p_params) loop
    if k not in ('prompt', 'negative_prompt', 'aspect_ratio', 'resolution', 'duration_s',
                 'voice_id', 'seed', 'source_asset_id', 'factor') then
      return format('unknown parameter %s', k);
    end if;
  end loop;
  if p_capability = 'remove_bg' and p_params ? 'prompt' then
    return 'prompt does not apply to remove_bg';
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
    if reshaped then
      return format('negative_prompt does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'negative_prompt') <> 'string'
       or char_length(p_params ->> 'negative_prompt') > 2000 then
      return 'negative_prompt must be text of at most 2000 characters';
    end if;
  end if;
  if p_params ? 'aspect_ratio' then
    if reshaped then
      return format('aspect_ratio does not apply to %s: the result keeps the image''s shape', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'aspect_ratio') <> 'string'
       or (p_params ->> 'aspect_ratio') !~ '^[1-9][0-9]?:[1-9][0-9]?$' then
      return 'aspect_ratio must look like 16:9';
    end if;
  end if;
  if p_params ? 'resolution' then
    if reshaped then
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
    return format('duration_s does not apply to %s', p_capability);
  end if;
  if p_params ? 'voice_id' then
    if p_capability <> 'tts' then
      return format('voice_id does not apply to %s', p_capability);
    end if;
    if jsonb_typeof(p_params -> 'voice_id') <> 'string'
       or (p_params ->> 'voice_id') !~ '^[A-Za-z0-9_-]{1,64}$' then
      return 'voice_id must be 1-64 letters, digits, _ or -';
    end if;
  end if;
  if p_params ? 'seed' then
    if reshaped then
      return format('seed does not apply to %s', p_capability);
    end if;
    if not public.creative_json_int(p_params -> 'seed', 0, 2147483647) then
      return 'seed must be a whole number from 0 to 2147483647';
    end if;
  end if;
  if sourced then
    if jsonb_typeof(p_params -> 'source_asset_id') is distinct from 'string'
       or (p_params ->> 'source_asset_id')
          !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
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
  return null;
end
$$;

-- Why the source asset cannot be used by p_org for this capability, or null
-- (also null for capabilities without a source). Runs after
-- creative_params_problem, so source_asset_id is a well-formed uuid here.
-- Another organization's asset, a deleted one and an id that never existed
-- all get the SAME sentence: the answer never tells one org what another has.
create or replace function public.creative_source_problem(p_org uuid, p_capability text, p_params jsonb)
  returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  a public.media_assets;
begin
  if p_capability not in ('edit', 'i2v', 'upscale', 'remove_bg') then
    return null;
  end if;
  select * into a from public.media_assets
   where id = (p_params ->> 'source_asset_id')::uuid
     and org_id = p_org
     and deleted_at is null and purged_at is null;
  if not found then
    return 'source_asset_id names no image in this organization''s library';
  end if;
  if a.kind <> 'image' then
    return 'the source must be an image';
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

-- How many units of the capability's measure these params ask for (header).
create or replace function public.creative_quantity(p_capability text, p_params jsonb) returns numeric
  language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_capability in ('t2i', 'edit', 'remove_bg') then 1::numeric
    when p_capability in ('t2v', 'sfx', 'music', 'i2v') then (p_params ->> 'duration_s')::numeric
    when p_capability = 'tts' then char_length(p_params ->> 'prompt')::numeric
    when p_capability = 'upscale' then power((p_params ->> 'factor')::numeric / 2, 2)
  end
$$;

-- 0036's quote, with the source check and the model's upscale factors. Every
-- other line is 0036's.
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
  -- The input picture must be this organization's, live, and usable.
  problem := public.creative_source_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('source_unavailable', problem);
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

  if m_unit is not null then
    select * into rate from public.credit_prices where unit = m_unit;
  end if;
  if m_unit is null or rate.unit is null then
    perform public.creative_refuse('unpriced',
      format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
  end if;

  qty := public.creative_quantity(cap, p_params);
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
-- 3. The worker's calls (service role)
-- ───────────────────────────────────────────────────────────────────────────

-- The source of a job this worker holds, re-checked now. The organization is
-- the JOB's — the worker never names one.
create or replace function public.creative_job_source(p_job uuid, p_worker text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  j       public.creative_jobs;
  a       public.media_assets;
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  problem text;
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
    return jsonb_build_object('ok', false, 'problem', 'the job has no source image');
  end if;
  problem := public.creative_source_problem(j.org_id, j.capability, j.params);
  if problem is not null then
    return jsonb_build_object('ok', false, 'problem', problem);
  end if;
  select * into a from public.media_assets
   where id = (j.params ->> 'source_asset_id')::uuid and org_id = j.org_id;
  return jsonb_build_object(
    'ok', true, 'asset_id', a.id, 'storage_key', a.storage_key, 'mime', a.mime,
    'variants', to_jsonb(a.variants), 'bytes', a.bytes, 'width', a.width, 'height', a.height);
end
$$;

-- The library assets a job produced. Only its own organization's, only what
-- the worker registered as this job's generated output.
create or replace function public.attach_creative_job_assets(p_job uuid, p_worker text, p_assets uuid[])
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j public.creative_jobs;
  w text := left(btrim(coalesce(p_worker, '')), 120);
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  if p_assets is null or cardinality(p_assets) not between 1 and 16 or array_position(p_assets, null) is not null then
    raise exception 'between 1 and 16 asset ids are required' using errcode = '22023';
  end if;
  select * into j from public.creative_jobs where id = p_job for update;
  if not found or j.worker_id is distinct from w or j.status <> 'processing' then
    return false;
  end if;
  if exists (select 1 from unnest(p_assets) x(id)
              where not exists (select 1 from public.media_assets a
                                 where a.id = x.id and a.org_id = j.org_id and a.source = 'generated'
                                   and a.provenance ->> 'job_id' = j.id::text)) then
    raise exception 'an asset is not this job''s output' using errcode = '42501';
  end if;
  update public.creative_jobs
     set result_asset_ids = (select array_agg(distinct x) from unnest(p_assets) x), updated_at = now()
   where id = p_job;
  perform public.creative_job_log(p_job, j.org_id, 'assets_attached', j.status,
    jsonb_build_object('assets', cardinality(p_assets)));
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges (the replaced functions keep 0035 / 0036's)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.model_registry_guard() from public, anon, authenticated;
revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

revoke all on function public.creative_capability_supported(text) from public, anon, authenticated, service_role;
revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_source_problem(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_quantity(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

revoke all on function public.creative_job_source(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.attach_creative_job_assets(uuid, text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.creative_job_source(uuid, text) to service_role;
grant execute on function public.attach_creative_job_assets(uuid, text, uuid[]) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.creative_capability_supported('edit') and public.creative_capability_supported('remove_bg')
--     as new_capabilities_on,
--   not has_function_privilege('authenticated', 'public.creative_source_problem(uuid,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_job_source(uuid,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.attach_creative_job_assets(uuid,text,uuid[])', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_job_source(uuid,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.creative_job_source(uuid,text)', 'EXECUTE')
--     as functions_scoped,
--   has_function_privilege('authenticated',
--       'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)', 'EXECUTE') as members_still_create;
