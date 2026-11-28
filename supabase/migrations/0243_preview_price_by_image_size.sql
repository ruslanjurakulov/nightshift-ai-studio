-- 0243_preview_price_by_image_size.sql — an operator preview of a picture model priced by size is quoted at that size's vendor cost.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces ONE function that exists there (creative_price,
-- on 0228's body plus the two hunks listed below) and adds nothing. It writes no row and grants nothing. It changes an answer only for
-- the case 0139 already lets through (the platform operator, in the operator's own credits-exempt organization, previewing a hidden
-- model the registry marks operator_preview) and only when that model is priced by picture size. Every other quote is answered exactly
-- as 0228 answers it.
--
-- EVIDENCE (lab, 2026-11-28, docs/MIGRATIONS.md "Why not an operator preview" under 0238). 0208 sells a model priced by size
--   (spec.pricing.variants.by = image_size) only at the size the request names, by the unit model_<id>_<unit>_<size>. 0139's preview
--   fallback (vendor cost when that unit has no credit_prices row) reads one flat figure, 0149 added the quoted resolution's and 0153
--   the quoted tier's, but none reads a size's. With operator_preview set on gemini-3-pro-image and gemini-nano-banana-2.1 in the lab,
--   the operator's quote at image_size 1K answered NS400 unpriced for both: two dead ends in the operator's Studio.
-- DIAGNOSIS. The registry already states one reviewed figure per size, in the place 0149 and 0153 read theirs: pricing.variants.prices,
--   keyed by the sizes in spec.image_sizes (modules/model_registry.py accepts only listed sizes as keys; tools/probe_models.py --sync
--   copies pricing and image_sizes into model_registry.spec unchanged). No new field is needed; creative_price just never read it.
-- THE RULE. The preview rate is the vendor's figure for exactly what is quoted. 0149's and 0153's sources are unchanged; one more:
--   * variants.by = 'image_size': variants.prices[vsize], where vsize is the size 0208's hunk already settled on for t2i and edit: the
--     request's image_size, and nothing else. 0208 refuses, before this, a quote of such a model that names no size (invalid_params,
--     "name image_size") and a size the model does not list (invalid_params). A listed size with no figure of its own (absent, null, not
--     a JSON number, 0, or over 100) is refused `unpriced`: never another size's figure, never the largest size's, never
--     provider_usd_per_unit (CLAUDE.md #4 and #5). A price table that is not an object gives no figure: `unpriced`.
--   * any other variants.by (audio, resolution_audio, upscale_target): `unpriced`, as before.
-- The conversion is 0139's: 1 credit = 1 US cent of cost, no margin, rounded up to the cent and floored at job_minimum like every
-- quote. A credit_prices row for the size's unit still wins (the preview rate is read only when there is none), read through 0224's
-- credits_per_unit_now as before, and no credit_prices row is written: nothing goes on sale. Who may preview is 0139's
-- creative_operator_preview, not replaced. The country gate (0208 / 0230) still acts on the job a preview creates.
--
-- THE HUNKS (tests/test_preview_price_by_image_size_migration.py undoes each one and compares the rest with 0228's body byte for byte):
--   the comment        over the preview rate: four lines say what 0243 reads
--   the preview rate   one more WHEN in 0153's CASE: by image_size, with a settled size, the size's figure. The cast, the
--                      0 < figure <= 100 test and the rate (figure x 100, margin 0) are 0149's lines, unchanged.
-- No variable is added: vsize is the one 0208's size settings already set. The 0124 switch line, the 0125 shutdown line, 0139's
-- creative_operator_preview call, 0218's prompt checks, 0224's dated rate and 0228's music quantity are kept.
--
-- REPLACES (md5 drift guard, white space folded; this file accepts ONLY this body, or its own on a replay):
--   creative_price (0228)   before 33bb0ea77aedd1ffc3df339034adc6d3, after 9268c201fd930c1f7519cc601118661e
--   So 0243 applies only after 0228 (which needs 0224, on 0218): on any other body it refuses, by name.
-- NUMBER. 0243 (assigned by Atlas for stream S10). Needs 0139, 0208, 0224 and 0228. Stacked on 0238 (#977), which it does not touch.
-- Backslash-free: the body of creative_price carries 0218's prompt regexes, written as @@0243_BACKSLASH@@ and put back with chr(92)
--   (0224's and 0228's technique), so the live apply path cannot rewrite them; the end state checks the md5 of what results.
-- LOCKS AND GRANTS: unchanged. creative_price takes no lock (it is stable) and stays revoked from every API role.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, true.
--   select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) = '33bb0ea77aedd1ffc3df339034adc6d3' as creative_price_is_0228s
--     from pg_proc where oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
--
-- Rollback: docs/sql/rollback_0243_preview_price_by_image_size.sql (owner-applied; puts 0228's creative_price back byte for byte).
-- Docs: docs/MIGRATIONS.md, "Operator preview priced by picture size (0243)".

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is null
     or to_regprocedure('public.credits_per_unit_now(text)') is null
     or to_regprocedure('public.model_past_shutdown(jsonb)') is null
     or to_regprocedure('public.model_is_available(text)') is null then
    raise exception '0243 needs 0139 (creative_operator_preview), 0224 (credits_per_unit_now), 0125 and 0124: apply them first';
  end if;
  select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)');
  if h is null or h <> all (array['33bb0ea77aedd1ffc3df339034adc6d3', '9268c201fd930c1f7519cc601118661e']) then
    raise exception '0243 found a creative_price() that is neither 0228''s body nor 0243''s (md5 %): apply 0228 first, or read the live body', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- creative_price: 0228's body, two marked hunks (0243)
-- ───────────────────────────────────────────────────────────────────────────

do $cp$
begin
  execute replace($cp0243$create or replace function public.creative_price(
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
  -- 0139: whether this quote is an operator preview (see creative_operator_preview).
  m_avail text;
  preview boolean := false;
  -- 0149: the vendor's figure for exactly the setting a preview is quoted at, and that figure as a number.
  vusd    jsonb;
  vcost   numeric;
  -- 0208: the picture size this quote is for (spec.pricing.variants.by = image_size).
  vsize   text;
  -- 0218: a limit from the model's spec, and the prompt's length in the worker's units.
  lim     numeric;
  units   integer;
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
  select true, r.credit_unit, r.entitlement, r.spec, r.availability
    into m_found, m_unit, m_ent, m_spec, m_avail
    from public.model_registry r
   where r.id = mdl
     -- 0139: or a hidden model the registry marks operator_preview, for a platform admin in the operator's own credits-exempt
     -- organization only (creative_operator_preview). Everyone else is answered exactly as before: model_not_sellable.
     and (r.availability in ('beta', 'ga') or public.creative_operator_preview(p_org, r.availability, r.spec))
     and r.verified_at is not null
     -- 0125: the same date, so a model named directly is not quoted either.
     and not public.model_past_shutdown(r.spec)
     and cap = any (r.capabilities);
  if not coalesce(m_found, false) then
    perform public.creative_refuse('model_not_sellable',
      format('%s is not available for %s', mdl, cap));
  end if;
  -- 0139: a model that is not beta or ga got here only through creative_operator_preview.
  preview := m_avail not in ('beta', 'ga');
  -- 0124: the owner temporarily switched this model (or its provider) off. Refused before anything is priced, held or charged,
  -- and never answered with another model: the person chooses. model_is_available is TRUE for every model until the switches
  -- are put in force.
  if not public.model_is_available(mdl) then
    perform public.creative_refuse('model_temporarily_off',
      format('%s is temporarily unavailable', mdl));
  end if;
  -- 0139: a plan entitlement is what a customer's plan buys; the operator's own organization has no plan, and its preview is not a sale.
  if not preview and coalesce(m_ent, 'any') not in ('any', 'paid') then
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
  -- 0155: nor any shape the model does not list for this capability: spec.aspect_ratios_by_capability[cap] when it names
  -- some, else spec.aspect_ratios, the same list the worker checks before it calls the vendor (ModelEntry.aspects_for). An
  -- empty list is a model that makes its own shape, so any shape is refused. Refused here, before anything is held, rather
  -- than by the worker after the job was queued. Each branch casts nothing: the CASE decides the order, not an `and`.
  if p_params ? 'aspect_ratio'
     and not coalesce(case
                        when jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> cap) = 'array'
                             and m_spec -> 'aspect_ratios_by_capability' -> cap <> '[]'::jsonb
                          then (m_spec -> 'aspect_ratios_by_capability' -> cap) @> jsonb_build_array(p_params ->> 'aspect_ratio')
                        when jsonb_typeof(m_spec -> 'aspect_ratios') = 'array'
                          then (m_spec -> 'aspect_ratios') @> jsonb_build_array(p_params ->> 'aspect_ratio')
                      end, false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s shape for %s', mdl, p_params ->> 'aspect_ratio', cap));
  end if;
  -- 0159: nor a clip length the model does not list (spec.durations_s), the list the worker checks before it calls the vendor
  -- (ModelEntry.problems: "duration <n>s is not offered by <model>"). A spec with no list, or an empty one, refuses every length (never
  -- "any length is fine"). Only when the request names one: creative_params_problem requires it for t2v, i2v, sfx and music and refuses
  -- it on every other tool. Refused here, before anything is held, rather than by the worker after the job was queued.
  if p_params ? 'duration_s'
     and not coalesce(jsonb_typeof(m_spec -> 'durations_s') = 'array'
                      and (m_spec -> 'durations_s') @> jsonb_build_array(p_params -> 'duration_s'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer a %s-second clip for %s', mdl, p_params ->> 'duration_s', cap));
  end if;
  -- Nor an ending on a model that would drop it.
  if p_params ? 'end_asset_id' and coalesce(m_spec -> 'end_frame', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('invalid_params',
      format('%s cannot end a clip on a chosen picture', mdl));
  end if;
  -- 0218: nor a setting the model's adapter would drop, nor a prompt longer than the model takes. Before 0218 each was quoted, held and
  -- queued, and then either refused by the worker after the hold (the length) or sent without the setting while the person paid for
  -- it (CLAUDE.md #4). Refused here, before anything is held, on every path that prices through this function (the Studio, the API,
  -- MCP, the router, Film).
  -- A seed never gets here: creative_params_problem refuses it, seed_not_supported, before any model is read (and before routing).
  -- A negative prompt only for a model whose adapter puts it in the vendor's request: the registry's takes_negative_prompt, which the
  -- sync copies into spec and modules/model_registry.py checks against the adapter. No statement = does not take one. Blank text is no
  -- negative prompt: only white space, every character Python's str.strip() removes (the worker's test), counts as blank.
  if coalesce(p_params ->> 'negative_prompt', '') ~ '[^@@0243_BACKSLASH@@t@@0243_BACKSLASH@@n@@0243_BACKSLASH@@u000b@@0243_BACKSLASH@@f@@0243_BACKSLASH@@r@@0243_BACKSLASH@@u001c-@@0243_BACKSLASH@@u001f @@0243_BACKSLASH@@u0085@@0243_BACKSLASH@@u00a0@@0243_BACKSLASH@@u1680@@0243_BACKSLASH@@u2000-@@0243_BACKSLASH@@u200a@@0243_BACKSLASH@@u2028@@0243_BACKSLASH@@u2029@@0243_BACKSLASH@@u202f@@0243_BACKSLASH@@u205f@@0243_BACKSLASH@@u3000]'
     and coalesce(m_spec -> 'takes_negative_prompt', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('negative_prompt_not_supported',
      format('%s does not take a negative prompt; remove it or choose a model that does', mdl), 'NS400');
  end if;
  -- The prompt against the model's own limits.max_prompt_chars, in UTF-16 code units, the worker's unit (model_registry.prompt_units):
  -- one per character, two for a character outside the Basic Multilingual Plane (an emoji). A spec that states no positive number is
  -- held to creative_params_problem's 4000 only (every registry entry states one; the Verify block lists any row that does not).
  lim := case when jsonb_typeof(m_spec -> 'limits' -> 'max_prompt_chars') = 'number'
              then (m_spec -> 'limits' ->> 'max_prompt_chars')::numeric end;
  if lim > 0 and jsonb_typeof(p_params -> 'prompt') = 'string' then
    units := 2 * char_length(p_params ->> 'prompt')
             - char_length(regexp_replace(p_params ->> 'prompt', '[@@0243_BACKSLASH@@U00010000-@@0243_BACKSLASH@@U0010FFFF]', '', 'g'));
    if units > lim then
      perform public.creative_refuse('prompt_too_long',
        format('%s character%s over this model''s limit of %s; shorten the prompt', units - lim,
               case when units - lim = 1 then '' else 's' end, lim), 'NS400');
    end if;
  end if;
  -- The negative prompt against limits.max_negative_prompt_chars where the adapter has one of its own (Krea: 1024), in characters
  -- (code points), the way that adapter counts it.
  lim := case when jsonb_typeof(m_spec -> 'limits' -> 'max_negative_prompt_chars') = 'number'
              then (m_spec -> 'limits' ->> 'max_negative_prompt_chars')::numeric end;
  if lim > 0 and char_length(p_params ->> 'negative_prompt') > lim then
    perform public.creative_refuse('prompt_too_long',
      format('%s character%s over this model''s limit of %s for a negative prompt; shorten it',
             char_length(p_params ->> 'negative_prompt') - lim,
             case when char_length(p_params ->> 'negative_prompt') - lim = 1 then '' else 's' end, lim), 'NS400');
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
  -- 0208: a picture size only on a model whose price follows it (spec.pricing.variants.by = image_size) and that lists the size
  -- (spec.image_sizes, the list the worker checks: ModelEntry.problems "image size <s> is not offered by <model>"). On any other
  -- model the size would reach a vendor that bills its own way under a price that was not read for it: refused, never ignored.
  if p_params ? 'image_size'
     and (coalesce(m_spec -> 'pricing' -> 'variants' ->> 'by', '') <> 'image_size'
          or not coalesce(jsonb_typeof(m_spec -> 'image_sizes') = 'array'
                          and (m_spec -> 'image_sizes') @> jsonb_build_array(p_params ->> 'image_size'), false)) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s size', mdl, p_params ->> 'image_size'));
  end if;
  -- 0208: one price per size when the registry prices the sizes apart (model_registry.credit_unit_for: model_<id>_<unit>_<size>).
  -- The size must be named: the worker sends it as the vendor's imageSize, and with none the vendor makes (and bills) its own
  -- default under a price read for no size. A size without its own row is unpriced: never another size's rate, never the base row.
  if cap in ('t2i', 'edit') and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'image_size' then
    vsize := p_params ->> 'image_size';
    if vsize is null then
      perform public.creative_refuse('invalid_params',
        format('%s is sold by picture size: name image_size', mdl));
    end if;
    m_unit := m_unit || '_' || regexp_replace(lower(vsize), '[^a-z0-9]', '_', 'g');
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
  -- 0156: creative_params_problem now takes every resolution name the registry can list, and the video settings above refused one the
  -- model does not list. A name it refused before 0156 (anything but 480p 540p 720p 1080p 1440p 2160p) is sold ONLY at its own
  -- variant's price, the unit model_<id>_<unit>_<resolution> the settings above chose: never by a base row whose figure was read for
  -- another resolution (Veo 3.1 pins no resolution, so 0070 sells it by its base row, and its 4k costs the vendor more), never at one
  -- flat price, never on a capability that has no resolution variants. Refused before any rate is read, the preview's included.
  if p_params ? 'resolution' and (p_params ->> 'resolution') !~ '^(480|540|720|1080|1440|2160)p$'
     and not (variant ? 'resolution') then
    if cap not in ('t2v', 'i2v') then
      perform public.creative_refuse('invalid_params', format('%s does not offer %s', mdl, p_params ->> 'resolution'));
    end if;
    perform public.creative_refuse('unpriced',
      format('%s is not sold at %s yet: that resolution has no price of its own', mdl, p_params ->> 'resolution'));
  end if;
  if m_unit is not null then
    select * into rate from public.credit_prices where unit = m_unit;
    rate.credits_per_unit := public.credits_per_unit_now(rate.unit);  -- 0224: a dated price (credit_price_schedule) once it is in force
  end if;
  -- 0139: a preview with no credit price is priced at the vendor's own cost (1 credit = 1 US cent, the convention of
  -- docs/sql/prices_2026_10_01.sql, no margin) from the reviewed registry figure, for the job's record only: the exempt
  -- organization holds and pays nothing (reserve_credits answers exempt). No credit_prices row is written, so nothing goes on
  -- sale. A figure the registry does not state stays unpriced.
  -- 0149: the figure is the one for exactly what is quoted. A model without variants states one (provider_usd_per_unit). A
  -- model priced by resolution states one per resolution (pricing.variants.prices), and the figure is vres's: the resolution the
  -- video settings above settled on (the request's, else the model's pinned default_resolution), which the job then carries and
  -- the worker sends. A resolution without its own figure is unpriced: never another resolution's figure, never
  -- provider_usd_per_unit. Any other variants.by (audio, resolution_audio, upscale_target ...) stays unpriced.
  -- 0153: a model priced by quality states one figure per tier (pricing.variants.prices), and the figure is tier's: the tier the
  -- quality settings above settled on (the request's, else medium when it names none), the one the quote names, the job carries and
  -- the worker sends. A tier without its own figure is unpriced: never another tier's figure, never provider_usd_per_unit.
  -- 0243: a model priced by picture size states one figure per size (pricing.variants.prices, keyed by spec.image_sizes), and the
  -- figure is vsize's: the size the request named (0208 above refuses a quote of such a model that names none, or one it does not
  -- list), the one the quote names, the job carries and the worker sends as imageSize. A size without its own figure is unpriced:
  -- never another size's figure, never the largest size's, never provider_usd_per_unit.
  if preview and m_unit is not null and rate.unit is null
     and jsonb_typeof(m_spec -> 'pricing') = 'object' then
    vusd := case
              when not (m_spec -> 'pricing' ? 'variants') then m_spec -> 'pricing' -> 'provider_usd_per_unit'
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'resolution' and vres is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vres
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' and tier is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> tier
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'image_size' and vsize is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vsize
            end;
    -- A figure that is not a JSON number is never cast: the CASE decides the order, not an `and`.
    vcost := case when jsonb_typeof(vusd) = 'number' then (vusd #>> '{}')::numeric end;
    if vcost > 0 and vcost <= 100 then
      rate.unit := m_unit;
      rate.credits_per_unit := vcost * 100;
      rate.margin := 0;
    end if;
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
  -- 0228: a MUSIC model the registry prices per request (spec.pricing.unit = request) is quoted for one request: Lyria 3.5 is
  -- billed "per song" and has no duration. Music only (BR-0228-01/02): any other capability keeps its own quantity and every check
  -- after this one, so a region edit is still one request per region and a video op still meets its longest input. A music model
  -- priced any other way still needs its duration, named as the fix (hunk 3).
  if cap = 'music' and m_spec -> 'pricing' ->> 'unit' = 'request' then
    qty := 1;
  elsif cap = 'music' and not p_params ? 'duration_s' then
    perform public.creative_refuse('invalid_params',
      format('%s is sold by the second: duration_s (a whole number of seconds from 1 to 60) is required', mdl));
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
    -- 0208: the picture size this price is for.
    || case when vsize is null then '{}'::jsonb else jsonb_build_object('image_size', vsize) end
    -- The resolution and soundtrack this price is for (0070).
    || variant
    -- 0139: a preview says so, and the Studio shows it as the operator's record, never as a price on sale.
    || case when preview then jsonb_build_object('preview', true) else '{}'::jsonb end;
end
$$$cp0243$, '@@0243_BACKSLASH@@', chr(92));
end
$cp$;

revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  fn  oid := 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
  def text;
  r   record;
begin
  if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = fn) <> '9268c201fd930c1f7519cc601118661e' then
    raise exception '0243 end state: creative_price is not 0243''s body';
  end if;
  for r in select * from unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_function_privilege(r.role_, 'public.creative_price(uuid, text, text, jsonb)', 'EXECUTE') then
      raise exception '0243 end state: % can call creative_price', r.role_;
    end if;
  end loop;
  if exists (select 1 from pg_proc p where p.oid = fn and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
    raise exception '0243 end state: creative_price is executable by public';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = fn and p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) then
    raise exception '0243 end state: creative_price is not security definer with a pinned search_path';
  end if;
  -- The guards every creative_price keeps (0124's switch, 0125's date, 0224's dated rate) and the preview reached only through 0139's rule.
  def := pg_get_functiondef(fn);
  if position('model_is_available' in def) = 0 or position('model_past_shutdown' in def) = 0
     or position('creative_operator_preview' in def) = 0 or position('credits_per_unit_now' in def) = 0 then
    raise exception '0243 end state: creative_price lost a guard';
  end if;
  -- Nothing is on sale because of this file: it writes no price and changes no availability.
  if exists (select 1 from public.model_registry where availability in ('beta', 'ga') and coalesce(spec ->> 'terms_gate', '') <> '') then
    raise exception '0243 end state: a terms-gated model is on sale';
  end if;
end $$;

-- Verify (the SQL editor, after applying; every column should read true):
--   select
--     (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--       where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure) = '9268c201fd930c1f7519cc601118661e' as price_is_0243s,
--     position('creative_operator_preview' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0
--       and position('model_past_shutdown' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0
--       and position('model_is_available' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0 as guards_kept,
--     not has_function_privilege('authenticated', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE') as functions_scoped,
--     not exists (select 1 from public.credit_prices
--                  where unit like 'model!_gemini!_3!_pro!_image!_image!_%' escape '!'
--                     or unit like 'model!_gemini!_nano!_banana!_2!_1!_image!_%' escape '!') as nothing_new_on_sale;
