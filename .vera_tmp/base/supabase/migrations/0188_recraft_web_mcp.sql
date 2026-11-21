-- 0188_recraft_web_mcp.sql — Recraft V4.1 and V4.1 Flash: sold on the web and through our own MCP connector, never through the
-- public developer API; and beta only once a real probe of the exact vendor model has passed.
--
-- EVIDENCE:
--   * Written confirmation from Recraft support, email of 2026-11-17/18 (relayed by the owner): our own signed-in users may use the
--     models in the web studio and through our limited MCP connector, paying with our credits; NOT through the public developer API
--     (/api/v1), which needs a reseller agreement. Conditions: a fresh API call for every generation (modules/capabilities/recraft.py
--     caches nothing), Recraft's watermarks and provenance metadata kept (vendor files are stored byte for byte,
--     docs/AI_DISCLOSURE.md), end-user terms at least as protective, the key never leaves our servers (RECRAFT_API_TOKEN is a worker
--     secret), consent before processing a real person's likeness (both models take no input image: inputs.image_refs_max 0).
--     Developer Terms §1.4 (effective 2026-10-20, re-read 2026-11-20): a written agreement with Recraft prevails over them.
--   * Recraft's docs (read 2026-11-20) name the Flash model `recraftv4_1_flash_v2` ("V4.1 Flash V2"); the registry sent
--     `recraftv4_1_flash`, which no current page names. schemas/model_registry.json is corrected in the same pull request.
--
-- DIAGNOSIS: the registry had two exposures, 'any' (web, api, mcp) and 'web_only' (web). A permission for the web and our connector but
--   not the public API had no value, and sellable_models treated 'mcp' exactly like 'api'.
--
-- CHANGE (additive; two function bodies replaced, one marked hunk each; one guarded row update):
--   sellable_models (0125's body): 'web_mcp' is sold to 'web' and 'mcp', never to 'api'. Only 'any' opens 'api'; any other value opens
--     the web alone (before: everything that was not 'web_only' was open to the API).
--   api_creative_model_ok (0124's body): the "temporarily off" word is for 'any' models only.
--   recraft-v4.1 and recraft-v4.1-flash -> availability 'beta' ONLY where the model's verified probe is a successful run of the
--     vendor model the registry names now (model_probe_runs.vendor_model = spec.vendor_model) AND its terms_gate is clear. With no such probe nothing changes;
--     apply this file again after tools/probe_models.py (.github/workflows/probe_models.yml) has recorded one. It never lowers an
--     availability, and it opens nothing by itself: a sale still needs the price rows (credit_prices, set by the owner), a clear
--     terms_gate (the registry file) and the owner's switch, exactly as sellable_models already requires.
-- NOT CHANGED: every other model's sale (the registry holds only 'any' and 'web_only'), every price, hold and gate. Recraft stays
--   refused on /api/v1 (api_creative_model_ok asks sellable_models for 'api'). No MCP tool asks for the 'mcp' surface yet: the
--   connector's creative tools are a separate pull request, and until they land Recraft is a web-only model in practice.
--
-- NUMBER. 0188, assigned by Atlas (renumbered at merge). Needs 0035, 0124 and 0125.
-- REPLAY. Replays onto itself (this is how the beta step is taken after a probe). Re-running 0124 or 0125 after it silently restores
--   the old bodies: apply 0188 again.
-- WHAT TO VERIFY BEFORE YOU APPLY: md5(regexp_replace(prosrc, '\s+', ' ', 'g')) of sellable_models(text, text) is ea8add748052456a6ef8898b4c87d610 (0125)
--   or 0ab9e7da07b4347010a887c5118d5150 (this file); of api_creative_model_ok(text, text) 80ab200d384f44306987c88629f103af (0124) or cbe9f5d42dcdcfddb604d4a30c2f80ae.
-- Undo: docs/sql/rollback_0188_recraft_web_mcp.sql (owner-applied): both bodies back; it does not change availability.

set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.sellable_models(text, text)', 'ea8add748052456a6ef8898b4c87d610', '0ab9e7da07b4347010a887c5118d5150', '0125'),
      ('public.api_creative_model_ok(text, text)', '80ab200d384f44306987c88629f103af', 'cbe9f5d42dcdcfddb604d4a30c2f80ae', '0124')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0188 found % with a body that is neither %''s nor 0188''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
end $$;

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
       -- 0188: 'web_mcp' is sold on the web and to the 'mcp' surface (our own signed-in connector), never to 'api' (the public
       -- developer API: a vendor's written permission can stop short of it). Only 'any' opens 'api'; a value this file does not
       -- know opens nothing but the web (fail closed).
       and (p_surface = 'web' or coalesce(m.spec ->> 'api_exposure', 'any') = 'any'
            or (p_surface = 'mcp' and m.spec ->> 'api_exposure' = 'web_mcp'))
       and (p_surface = 'web' or not ('captions' = any (m.capabilities)))
     order by m.provider, m.id;
end
$$;

create or replace function public.api_creative_model_ok(p_capability text, p_model text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- 0124: a model the owner switched off that the API would otherwise sell is refused with its own word, so a caller is told "temporarily
  -- unavailable" and not "not available through the API". Nothing is held. Every other model is judged as before.
  if not public.model_is_available(p_model)
     and exists (select 1 from public.model_registry r
                  where r.id = p_model and p_capability = any (r.capabilities)
                    and r.availability in ('beta', 'ga') and r.verified_at is not null
                    -- 0188: only a model the API would otherwise sell ('any') gets the "temporarily off" word here.
                    and coalesce(r.spec ->> 'api_exposure', 'any') = 'any'
                    and p_capability <> 'captions') then
    perform public.creative_refuse('model_temporarily_off', format('%s is temporarily unavailable', p_model));
  end if;
  return exists (select 1 from public.sellable_models(p_capability, 'api') s where s.id = p_model);
end
$$;

revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;
revoke all on function public.api_creative_model_ok(text, text) from public, anon, authenticated, service_role;

-- Beta only on a passed probe of the vendor model named now (see CHANGE). Hidden -> beta only; nothing is lowered.
update public.model_registry m
   set availability = 'beta'
 where m.id in ('recraft-v4.1', 'recraft-v4.1-flash')
   and m.availability = 'hidden'
   and m.verified_at is not null
   -- A model whose terms are still under review stays hidden: model_registry_terms_before_sale refuses beta with a terms_gate, and
   -- the first live apply (2026-11-20) stopped on exactly that for recraft-v4.1 (probe passed, terms_gate still set).
   and coalesce(m.spec ->> 'terms_gate', '') = ''
   and exists (select 1 from public.model_probe_runs r
                where r.id = m.verified_probe_id and r.ok and r.model_id = m.id
                  and r.vendor_model = m.spec ->> 'vendor_model');

do $$
begin
  if exists (select 1 from public.model_registry where id in ('recraft-v4.1', 'recraft-v4.1-flash') and availability = 'hidden') then
    raise notice '0188: a Recraft model is still hidden: no passed probe of its current vendor model is recorded yet, or its terms_gate is not clear; run the probe and clear the gate in the registry, then apply 0188 again';
  end if;
end $$;

-- Verify: select id, availability, spec ->> 'vendor_model', spec ->> 'api_exposure',
--   exists (select 1 from public.sellable_models('t2i', 'api') s where s.id = m.id) as on_api   -- must be false
--   from public.model_registry m where id like 'recraft-%';
