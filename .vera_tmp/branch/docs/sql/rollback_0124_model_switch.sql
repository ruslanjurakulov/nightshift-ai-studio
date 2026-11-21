-- rollback_0124_model_switch.sql — takes migration 0124 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If a replaced function misbehaves, or the owner's switches must go for good. The switch itself needs no rollback: to stop
-- it having any effect, and keep the record, run   update public.model_availability_settings set enforced = false;   (every model is
-- available again at once; the log keeps the change).
-- READ THIS FIRST: this file DROPS the four tables, so (1) every switch is gone and every model is available again, (2) the log of who
-- switched what and why is gone with them: before running it, copy it out with
--     select * from public.model_availability_log order by id;
-- and (3) a creative job this migration stopped (status failed, error_code model_temporarily_off) stays failed with its credits returned.
-- The Command Center's Models switch section and the queue worker's gate (NIGHTSHIFT_MODEL_SWITCH) then find the functions missing and
-- say so; leave the variable off (its default).
--
-- WHAT IT DOES, in one transaction:
--   1. Refuses to run if any of the five replaced functions is neither 0124's body nor the earlier migration's (something redefined it
--      since: running this would silently undo that change). Compared as md5 of the body with every run of white space read as one space.
--   2. Puts model_registry_select back to 0035's policy, and the five functions back to the bodies of 0100 (sellable_models,
--      creative_price), 0036 (advance_creative_job), 0062 (api_creative_model_ok) and 0075 (api_creative_refusal), byte for byte, with
--      their grants.
--   3. Drops the alert trigger on creative_jobs, the new functions and the four new tables.
-- It rewrites no row of any older table.
--
-- tests/security/test_sec_model_switch.py applies this file to a lab database and re-applies 0124.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into h from pg_proc x where x.oid = 'public.sellable_models(text, text)'::regprocedure;
  if h is null or h <> all (array['b201b1f412aa3143f75dac75bdaefd4f', '70f1639c6ce5cbf175b2673d8d543d44']) then
    raise exception 'rollback 0124 found a sellable_models() that is neither 0124''s body nor 0100''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into h from pg_proc x where x.oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
  if h is null or h <> all (array['eadab9d3784815c44becebcc6d1f7ec9', 'dc2bdbd68e43c4b85d9dbfd6b5ee83ee']) then
    raise exception 'rollback 0124 found a creative_price() that is neither 0124''s body nor 0100''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into h from pg_proc x where x.oid = 'public.advance_creative_job(uuid, text, text, text, jsonb)'::regprocedure;
  if h is null or h <> all (array['37eb30fb8923c65d97ed386b1ce1b642', '758e3dc731acf7bc6af319d45198873a']) then
    raise exception 'rollback 0124 found a advance_creative_job() that is neither 0124''s body nor 0036''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into h from pg_proc x where x.oid = 'public.api_creative_model_ok(text, text)'::regprocedure;
  if h is null or h <> all (array['53d674624d8ce35d7bed3d005880de7f', '80ab200d384f44306987c88629f103af']) then
    raise exception 'rollback 0124 found a api_creative_model_ok() that is neither 0124''s body nor 0062''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into h from pg_proc x where x.oid = 'public.api_creative_refusal(text, text, text)'::regprocedure;
  if h is null or h <> all (array['16f5c0c0427953bdb2ca574708014cd6', '2253296a9c1ac2e5de3c25a2a726398e']) then
    raise exception 'rollback 0124 found a api_creative_refusal() that is neither 0124''s body nor 0075''s (md5 %): read the live body first', h;
  end if;
end $$;

-- 0035's policy (the function it called is dropped below).
drop policy if exists model_registry_select on public.model_registry;
create policy model_registry_select on public.model_registry
  for select to authenticated
  using (public.is_platform_admin() or (availability in ('beta', 'ga') and verified_at is not null));

-- 0100's body.
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
                              'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg') then
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

-- 0100's body.
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
  -- 0100: nor a shape to reframe a video to that the model was not proven (and
  -- listed) for.
  if cap = 'video_reframe'
     and not coalesce(jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> 'video_reframe') = 'array'
                      and (m_spec -> 'aspect_ratios_by_capability' -> 'video_reframe') @> jsonb_build_array(p_params ->> 'aspect_ratio'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not reframe a video to %s', mdl, p_params ->> 'aspect_ratio'));
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

  if cap in ('voice_change', 'dub', 'video_upscale', 'captions', 'video_edit', 'video_reframe', 'video_remove_bg') then
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
  if cap in ('video_edit', 'video_reframe', 'video_remove_bg') then
    -- 0100: the same rule as the upscale's, in the video ops' own words: a model
    -- that states no longest input is not sold a length it may refuse after the hold.
    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'
                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;
    if longest is null or longest <= 0 then
      perform public.creative_refuse('model_not_sellable',
        format('%s does not state the longest video it takes', mdl));
    end if;
    if qty > longest then
      perform public.creative_refuse('source_unavailable',
        format('this model takes videos of up to %s seconds; trim this one first', longest));
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

-- 0036's body.
create or replace function public.advance_creative_job(
  p_job uuid, p_worker text, p_step text,
  p_provider_task_id text default null, p_route jsonb default null
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j public.creative_jobs;
  w text := left(btrim(coalesce(p_worker, '')), 120);
  tid text := nullif(btrim(coalesce(p_provider_task_id, '')), '');
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into j from public.creative_jobs where id = p_job for update;
  if not found or j.worker_id is distinct from w then
    return false;
  end if;
  if p_step = 'submitting' then
    if j.status <> 'running' or j.submit_started_at is not null or j.provider_task_id is not null then
      return false;
    end if;
    update public.creative_jobs
       set submit_started_at = now(), heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'submitted' then
    if j.status <> 'running' or j.submit_started_at is null or j.provider_task_id is not null
       or tid is null or char_length(tid) > 512 then
      return false;
    end if;
    update public.creative_jobs
       set provider_task_id = tid, status = 'provider_pending',
           route = coalesce(p_route, route), heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'processing' then
    if j.status <> 'provider_pending' then
      return false;
    end if;
    update public.creative_jobs
       set status = 'processing', heartbeat_at = now(), updated_at = now()
     where id = p_job;
  elsif p_step = 'requeue' then
    if j.status not in ('running', 'provider_pending', 'processing')
       or (j.submit_started_at is not null and j.provider_task_id is null) then
      return false;
    end if;
    update public.creative_jobs
       set status = 'queued', worker_id = null, attempts = greatest(j.attempts - 1, 0),
           updated_at = now()
     where id = p_job;
  else
    raise exception 'unknown step' using errcode = '22023';
  end if;
  perform public.creative_job_log(p_job, j.org_id, p_step,
    (select status from public.creative_jobs where id = p_job),
    case when p_step = 'submitted' then jsonb_build_object('task', true) end);
  return true;
end
$$;

-- 0062's body.
create or replace function public.api_creative_model_ok(p_capability text, p_model text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.sellable_models(p_capability, 'api') s where s.id = p_model)
$$;

-- 0075's body.
create or replace function public.api_creative_refusal(p_state text, p_msg text, p_detail text)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  word text := btrim(coalesce(p_msg, ''));
  det  text := left(coalesce(p_detail, ''), 300);
  m    text[];
  extra jsonb := case when det <> '' and det <> word then jsonb_build_object('detail', det) else '{}'::jsonb end;
begin
  case p_state
    when '42501' then
      return public.api_err(403, 'forbidden', 'This key may not start generations in this organization.');
    when 'P0002' then
      return public.api_err(404, 'job_not_found', 'No generation with that id for this key.');
    when '22023' then
      return public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.');
    when 'NS402' then
      m := regexp_match(coalesce(p_detail, ''), 'available=(-?[0-9.]+)\s+needed=([0-9.]+)');
      return public.api_err(402, 'insufficient_credits',
        'The organization does not have enough credits for this generation. Nothing was held.',
        case when m is null then '{}'::jsonb
             else jsonb_build_object('available_credits', m[1]::numeric, 'needed_credits', m[2]::numeric) end);
    when 'NS429' then
      m := regexp_match(coalesce(p_detail, ''), 'active=([0-9]+)\s+limit=([0-9]+)');
      return public.api_err(429, 'run_limit_reached',
        'All of the plan''s parallel runs are in use. Wait for one to finish.',
        jsonb_build_object('retry_after', 60) || case when m is null then '{}'::jsonb
             else jsonb_build_object('active', m[1]::int, 'limit', m[2]::int) end);
    when 'NS409' then
      if word = 'price_changed' then
        return public.api_err(409, 'price_changed',
          'The price is now above max_credits. Quote again and confirm the new price.', extra);
      elsif word = 'idempotency_conflict' then
        return public.api_err(422, 'idempotency_key_reused',
          'This Idempotency-Key was already used for a different generation.');
      -- 0075: the router's pick changed since the quote.
      elsif word = 'route_changed' then
        return public.api_err(409, 'route_changed',
          'The automatic choice changed since the quote. Quote again and confirm the new choice.', extra);
      end if;
    when 'NS400' then
      return case word
        when 'registry_missing' then public.api_err(503, 'registry_missing', 'The model registry is not set up on this deployment.')
        when 'model_not_sellable' then public.api_err(422, 'model_not_sellable', 'That model is not available for this capability through the API.', extra)
        when 'entitlement_required' then public.api_err(403, 'entitlement_required', 'The organization''s plan does not include this model.', extra)
        when 'unpriced' then public.api_err(422, 'unpriced', 'That model has no price yet, so it cannot be sold.')
        when 'capability_not_supported' then public.api_err(422, 'capability_not_supported', 'That capability cannot be generated on this deployment.', extra)
        when 'source_unavailable' then public.api_err(422, 'source_unavailable', 'A media-library file in the request is not available to this organization.', extra)
        when 'style_unavailable' then public.api_err(422, 'style_unavailable', 'The style kit in the request is not available to this organization.')
        when 'mode_not_supported' then public.api_err(422, 'mode_not_supported', 'Only mode "exact" (the model you named) is available.')
        -- 0075: no available, priced model of this plan takes these settings.
        when 'no_model_available' then public.api_err(422, 'no_model_available', 'No available, priced model can make this with these settings.', extra)
        when 'invalid_idempotency_key' then public.api_err(400, 'invalid_idempotency_key', 'Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -')
        else public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.', extra)
      end;
    else
      null;
  end case;
  return public.api_err(500, 'internal_error',
    'The request failed inside the database. Nothing was created or charged; retry with backoff.');
end
$$;

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;
revoke all on function public.advance_creative_job(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.advance_creative_job(uuid, text, text, text, jsonb) to service_role;
revoke all on function public.api_creative_model_ok(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_creative_refusal(text, text, text) from public, anon, authenticated, service_role;

drop trigger if exists model_switch_note_quota on public.creative_jobs;
drop function if exists public.model_switch_note_quota();
drop function if exists public.owner_model_alert_dismiss(bigint);
drop function if exists public.owner_set_model_switch(text, text, boolean, text, text, boolean);
drop function if exists public.owner_model_switch_preview(text, text);
drop function if exists public.owner_model_switches();
drop function if exists public.model_switch_stop_jobs(text[]);
drop function if exists public.model_switch_counts(text[]);
drop function if exists public.model_switch_target_models(text, text);
drop function if exists public.model_switch_job_model(public.creative_jobs);
drop function if exists public.model_switch_state();
drop function if exists public.models_switched_off();
drop function if exists public.model_is_available(text);

drop table if exists public.model_availability_alerts;
drop table if exists public.model_availability_log;
drop table if exists public.model_availability;
drop table if exists public.model_availability_settings;
drop function if exists public.model_availability_settings_trail();
drop function if exists public.model_availability_settings_guard();
drop function if exists public.model_availability_log_append_only();

commit;
