-- rollback_0250_music_in_job_path_lists.sql — takes migration 0250 (music in sellable_models' list of known capabilities) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor, as one transaction. Nothing in the app runs it. Idempotent.
--
-- WHAT COMES BACK: 0192's sellable_models, verbatim (md5 85aaba9a2ec82dc7f276dd2135b4c7cf with comments cut and white space folded,
--   0230's fingerprint; 40f61462ddae2fc0e83a0956f4d8b75b folded only, as 0192 pins it). sellable_models('music', ...) then raises
--   22023 "unknown capability music" again: a routed music quote answers no_model_available (route_model reads the 22023 as no
--   candidates), a routed music job's worker failover raises 22023, and the API answers a music call invalid_params. An exact
--   Studio music job is quoted, held and run as before (that path prices through creative_price, which 0228 owns).
-- WHAT IS KEPT: everything else. 0228's checks and functions, the grants (authenticated and service_role, as 0192's), every row.
-- WHAT IT DOES: 0. REFUSES (changes nothing) if sellable_models is neither 0250's body nor 0192's (a later file changed it: take that
--   out first). 1. Says, in a NOTICE, which music models are on sale (they stay on sale; routing and failover stop finding them).
--   2. Puts 0192's body back. 3. Asserts the end state.
-- No backslash anywhere in this file (0219's header); the pattern is written [-][-] so that no literal holds two dashes in a row.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
  onsale text;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.sellable_models(text, text)');
  if h is null or h <> all (array['c7697dbcd9312d1e4756fbe3997c15a0', '85aaba9a2ec82dc7f276dd2135b4c7cf']) then
    raise exception 'rollback 0250: sellable_models() is neither 0250''s body nor 0192''s (md5 %): a later file changed it; take that file out first', h;
  end if;
  select string_agg(id || ' (' || availability || ')', ', ' order by id) into onsale
    from public.model_registry where 'music' = any (capabilities) and availability in ('beta', 'ga');
  if onsale is not null then
    raise notice 'rollback 0250: these music models stay on sale, but routing finds none of them and a failover raises 22023 until 0250 is applied again: %', onsale;
  end if;
end $$;

-- sellable_models: 0192's body, verbatim (0192_adult_attestation.sql, section 7).
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
             -- 0192: the vendor's terms are 18+: still listed (never hidden), and the app marks it "for adults only".
             'requires_adult', case when public.model_requires_adult(m.spec) then true end,
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
       -- 0188: 'web_mcp' is sold on the web and to the 'mcp' surface (our own signed-in connector), never to 'api' (the public
       -- developer API: a vendor's written permission can stop short of it). Only 'any' opens 'api'; a value this file does not
       -- know opens nothing but the web (fail closed).
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') = 'any'
            or (p_surface = 'mcp' and m.spec ->> 'api_exposure' = 'web_mcp'))
       and (p_surface = 'web' or not ('captions' = any (m.capabilities)))
     order by m.provider, m.id;
end
$$;

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;

do $$
begin
  if (select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc p
       where p.oid = 'public.sellable_models(text, text)'::regprocedure) is distinct from '85aaba9a2ec82dc7f276dd2135b4c7cf' then
    raise exception 'rollback 0250 end state: sellable_models() is not 0192''s body';
  end if;
  if has_function_privilege('anon', 'public.sellable_models(text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.sellable_models(text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.sellable_models(text, text)', 'EXECUTE') then
    raise exception 'rollback 0250 end state: sellable_models() grants are not 0192''s';
  end if;
end $$;

commit;
