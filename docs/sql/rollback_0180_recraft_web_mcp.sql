-- rollback_0180_recraft_web_mcp.sql — 0125's sellable_models and 0124's api_creative_model_ok back, verbatim. OWNER-APPLY.
-- A 'web_mcp' model then reads as open to the API again (everything that is not 'web_only' was): apply this only after the registry
-- no longer names 'web_mcp' (set Recraft back to 'web_only'), or the public API would sell it. Availability is not changed here.
begin;
set local lock_timeout = '5s';
do $$
declare
  h text;
begin
  if exists (select 1 from public.model_registry where spec ->> 'api_exposure' = 'web_mcp') then
    raise exception 'rollback 0180: a model is still web_mcp; set it to web_only in the registry and sync first';
  end if;
  select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into h from pg_proc where oid = 'public.sellable_models(text, text)'::regprocedure;
  if h is distinct from 'b7ec750de4aea6c412cb73d55cfe9c99' then raise exception 'rollback 0180: sellable_models is not 0180''s body (md5 %)', h; end if;
  select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into h from pg_proc where oid = 'public.api_creative_model_ok(text, text)'::regprocedure;
  if h is distinct from '38ce3440be2e9107ca877a9bede14dc8' then raise exception 'rollback 0180: api_creative_model_ok is not 0180''s body (md5 %)', h; end if;
end $$;
-- sellable_models: 0125's body, verbatim.
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
       -- 0124: the owner's switch (model_is_available is TRUE for every model until it is put in force).
       and public.model_is_available(m.id)
       -- 0125: a shutdown date the vendor announced (spec.shutdown.on) that has come ends the sale.
       and not public.model_past_shutdown(m.spec)
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

-- api_creative_model_ok: 0124's body, verbatim.
create or replace function public.api_creative_model_ok(p_capability text, p_model text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- 0124: a model the owner switched off that the API would otherwise sell is refused with its own word, so a caller is told "temporarily
  -- unavailable" and not "not available through the API". Nothing is held. Every other model is judged as before.
  if not public.model_is_available(p_model)
     and exists (select 1 from public.model_registry r
                  where r.id = p_model and p_capability = any (r.capabilities)
                    and r.availability in ('beta', 'ga') and r.verified_at is not null
                    and coalesce(r.spec ->> 'api_exposure', 'any') <> 'web_only'
                    and p_capability <> 'captions') then
    perform public.creative_refuse('model_temporarily_off', format('%s is temporarily unavailable', p_model));
  end if;
  return exists (select 1 from public.sellable_models(p_capability, 'api') s where s.id = p_model);
end
$$;

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;
revoke all on function public.api_creative_model_ok(text, text) from public, anon, authenticated, service_role;
commit;
