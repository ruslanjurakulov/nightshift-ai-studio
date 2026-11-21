-- 0048_creative_style_inputs.sql — style kits and @characters (0047) in
-- creative generations (0036 / 0046): a generation may name one of the
-- organization's style kits, and its prompt may address the organization's
-- characters by @name. 0047 built them as configuration only ("NOT WIRED
-- INTO GENERATION YET"); this is the wiring.
--
-- WHAT IT CHANGES (create-or-replace; nothing dropped)
--   creative_params_problem   one new key:
--       style_kit_id   optional for t2i, t2v, edit and i2v, refused for every
--                      other capability: the uuid of a style kit. Text-only
--                      audio and the picture tools that keep their input
--                      (upscale, remove_bg) have no look to steer.
--     Every other rule is 0046's.
--   creative_style_problem(org, capability, params)   NEW, internal
--       The kit must exist AND belong to the job's organization. Another
--       organization's kit reads exactly like an id that never existed (one
--       sentence for both): ids confirm nothing across organizations.
--   creative_price            + the style check, right after 0046's source
--       check, so quote_creative_job AND create_creative_job (inside its
--       transaction, before any hold) refuse it. Refused with NS400
--       'style_unavailable'; nothing is held and no job row is written.
--       THE PRICE IS UNCHANGED: a style kit or a character adds no credits
--       (the quantity and the unit are 0046's).
--   creative_job_style(job, worker)   NEW, service role only
--       What the worker builds the provider request from, for a job it holds
--       while 'running' and before 'submitting' (the paid call), always in
--       the JOB's organization — the worker never names one:
--         kit         the job's style kit, re-checked NOW (it may have been
--                     deleted since the job was created -> {ok:false}), with
--                     its description and its usable reference images in
--                     order (live images of the job's organization that a
--                     provider takes: JPEG / PNG / WebP, HEIC / HEIF only
--                     with their JPEG 'display' copy);
--         characters  the job's organization's characters whose @name the
--                     prompt mentions (at most 16 names, in order of first
--                     mention; matched case-insensitively), each with its
--                     description and usable references. A @name that is
--                     not one of them is simply not returned — the prompt
--                     keeps it as typed.
--       Every kit, character and reference carries its org_id, so the worker
--       checks the organization again in code (modules/creative_style.py).
--       Answers {ok, org_id, kit, characters} or {ok:false, problem}.
--
-- @NAMES ARE NEVER REWRITTEN HERE. The prompt is stored as typed; the worker
-- appends the descriptions to the request it sends (never to the row).
--
-- MONEY: UNCHANGED. Hold at create (= the quote), capture <= the hold on
-- success, full release on every failure — 0036's functions, untouched. A kit
-- deleted before the run fails the job ('style_unavailable') and releases its
-- hold like any other failure.
--
-- WHO MAY DO WHAT: as 0036 / 0046. quote / create / cancel: signed-in members
-- of the organization. creative_job_style: service role. creative_style_problem:
-- nobody through the API. anon: nothing.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps,
-- lib/creative/operations.ts mapCreativeError):
--   NS400 style_unavailable   the kit is not this organization's, or does not
--                             exist (detail: one sentence for both)
--   NS400 invalid_params      style_kit_id is not a uuid, or does not apply
--                             to the capability
--   everything else as 0036 / 0046.
--
-- REQUIRES 0036 (creative_jobs), 0046 (media inputs) and 0047 (style kits,
-- characters). Additive and idempotent: create-or-replace functions,
-- revoke-then-grant.

do $$
begin
  if to_regprocedure('public.creative_source_problem(uuid, text, jsonb)') is null then
    raise exception '0048 needs 0046_creative_media_inputs.sql: apply it first';
  end if;
  if to_regclass('public.style_kits') is null or to_regclass('public.characters') is null then
    raise exception '0048 needs 0047_style_kits_characters.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Params: style_kit_id
-- ───────────────────────────────────────────────────────────────────────────

-- 0046's rules plus style_kit_id (header). Pure: whether the kit may be used
-- is creative_style_problem's question (it needs the organization).
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
  -- The capabilities a look can steer.
  styled   boolean := p_capability in ('t2i', 't2v', 'edit', 'i2v');
begin
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    return 'params must be a JSON object';
  end if;
  if octet_length(p_params::text) > 16384 then
    return 'params are too large';
  end if;
  for k in select jsonb_object_keys(p_params) loop
    if k not in ('prompt', 'negative_prompt', 'aspect_ratio', 'resolution', 'duration_s',
                 'voice_id', 'seed', 'source_asset_id', 'factor', 'style_kit_id') then
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
  if p_params ? 'style_kit_id' then
    if not styled then
      return format('style_kit_id does not apply to %s', p_capability);
    end if;
    -- Absent means "no style"; a present key must name one (never null).
    if jsonb_typeof(p_params -> 'style_kit_id') is distinct from 'string'
       or (p_params ->> 'style_kit_id')
          !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      return 'style_kit_id must be the id of a style kit';
    end if;
  end if;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The style check and the price
-- ───────────────────────────────────────────────────────────────────────────

-- Why the style kit cannot be used by p_org, or null (also null when the
-- params name none). Runs after creative_params_problem, so style_kit_id is a
-- well-formed uuid here. Another organization's kit and an id that never
-- existed get the SAME sentence.
create or replace function public.creative_style_problem(p_org uuid, p_capability text, p_params jsonb)
  returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_params is null or not (p_params ? 'style_kit_id') then
    return null;
  end if;
  if p_capability not in ('t2i', 't2v', 'edit', 'i2v') then
    return format('style_kit_id does not apply to %s', p_capability);
  end if;
  if not exists (select 1 from public.style_kits k
                  where k.id = (p_params ->> 'style_kit_id')::uuid and k.org_id = p_org) then
    return 'style_kit_id names no style kit in this organization';
  end if;
  return null;
end
$$;

-- 0046's quote, with the style check after the source check. Every other line
-- is 0046's: a style adds no credits.
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
-- 3. The worker's call (service role)
-- ───────────────────────────────────────────────────────────────────────────

-- The style a job this worker holds asks for, read now, in the JOB's
-- organization (header). References are filtered to what a provider can take
-- exactly as 0046's source check filters a source.
create or replace function public.creative_job_style(p_job uuid, p_worker text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  j       public.creative_jobs;
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  problem text;
  kit     jsonb := null;
  chars   jsonb := '[]'::jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job;
  -- Read before the paid call only: once 'submitting' is recorded the request
  -- has been built, and nothing is handed out again.
  if not found or j.worker_id is distinct from w or j.status <> 'running'
     or j.submit_started_at is not null then
    return jsonb_build_object('ok', false, 'problem', 'the job is not this worker''s to start');
  end if;
  if j.capability not in ('t2i', 't2v', 'edit', 'i2v') then
    return jsonb_build_object('ok', true, 'org_id', j.org_id, 'kit', null, 'characters', '[]'::jsonb);
  end if;

  if j.params ? 'style_kit_id' then
    problem := public.creative_style_problem(j.org_id, j.capability, j.params);
    if problem is not null then
      return jsonb_build_object('ok', false, 'problem', problem);
    end if;
    select jsonb_build_object(
             'id', k.id, 'org_id', k.org_id, 'description', k.description,
             'references', coalesce((
               select jsonb_agg(jsonb_build_object('asset_id', a.id, 'org_id', a.org_id, 'mime', a.mime,
                                                   'variants', to_jsonb(a.variants))
                                order by r.position)
                 from public.style_kit_references r
                 join public.media_assets a on a.id = r.asset_id
                where r.kit_id = k.id and r.org_id = j.org_id and a.org_id = j.org_id
                  and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
                  and (a.mime in ('image/jpeg', 'image/png', 'image/webp')
                       or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants)))
             ), '[]'::jsonb))
      into kit
      from public.style_kits k
     where k.id = (j.params ->> 'style_kit_id')::uuid and k.org_id = j.org_id;
  end if;

  -- @names, as the worker reads them (modules/creative_style.py MENTION_RE):
  -- '@' not preceded by a letter, digit, '_' or '@', then 2-32 of [A-Za-z0-9_]
  -- not followed by another. Lower-cased: 0047 stores names lower-case.
  with mentioned as (
    select lower(m.x[1]) as name, min(m.o) as first_at
      from regexp_matches(coalesce(j.params ->> 'prompt', ''),
                          '(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{2,32})(?![A-Za-z0-9_])', 'g')
           with ordinality as m(x, o)
     group by lower(m.x[1])
     order by min(m.o)
     limit 16
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'org_id', c.org_id, 'name', c.name, 'description', c.description,
           'references', coalesce((
             select jsonb_agg(jsonb_build_object('asset_id', a.id, 'org_id', a.org_id, 'mime', a.mime,
                                                 'variants', to_jsonb(a.variants))
                              order by r.position)
               from public.character_references r
               join public.media_assets a on a.id = r.asset_id
              where r.character_id = c.id and r.org_id = j.org_id and a.org_id = j.org_id
                and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
                and (a.mime in ('image/jpeg', 'image/png', 'image/webp')
                     or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants)))
           ), '[]'::jsonb))
         order by mentioned.first_at), '[]'::jsonb)
    into chars
    from mentioned
    join public.characters c on c.name = mentioned.name and c.org_id = j.org_id;

  return jsonb_build_object('ok', true, 'org_id', j.org_id, 'kit', kit, 'characters', chars);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges (the replaced functions keep 0036 / 0046's)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_style_problem(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_job_style(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.creative_job_style(uuid, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.creative_params_problem('t2i', '{"prompt":"x","style_kit_id":"00000000-0000-4000-8000-000000000000"}') is null
--     and public.creative_params_problem('tts', '{"prompt":"x","style_kit_id":"00000000-0000-4000-8000-000000000000"}') is not null
--     as style_param_on,
--   not has_function_privilege('authenticated', 'public.creative_style_problem(uuid,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_job_style(uuid,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_job_style(uuid,text)', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.creative_job_style(uuid,text)', 'EXECUTE')
--     as functions_scoped,
--   has_function_privilege('authenticated',
--       'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)', 'EXECUTE') as members_still_create;
