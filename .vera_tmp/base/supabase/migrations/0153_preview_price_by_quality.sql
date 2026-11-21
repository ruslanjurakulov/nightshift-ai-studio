-- 0153_preview_price_by_quality.sql — an operator preview of a model priced by quality is quoted at that tier's vendor cost.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces ONE function that exists there (creative_price,
-- on 0149's body plus the two hunks listed below) and adds nothing. It changes an answer only for the case 0139 already lets through (the
-- platform operator, in the operator's own credits-exempt organization, previewing a hidden model the registry marks operator_preview)
-- and only when that model is priced by quality. Every other quote is answered exactly as 0149 answers it.
--
-- WHY. 0139 quotes a preview with no credit_prices row at the vendor's own cost from one flat registry figure, and 0149 added the figure
-- of the quoted resolution. An image model priced by quality tier (pricing.variants = {"by": "quality", "prices": {"low": ...,
-- "medium": ..., "high": ...}}: the OpenAI GPT Image entries) still had no figure a preview could read, so every preview quote of it was
-- refused `unpriced`, and such a model could not be marked operator_preview without becoming a dead end in the Studio.
--
-- THE RULE. The preview rate is the vendor's figure for exactly what is quoted. 0149's two sources are unchanged (no variants:
-- provider_usd_per_unit; variants.by = 'resolution': variants.prices[vres]); this file adds a third:
--   * variants.by = 'quality': variants.prices[tier], where tier is the tier the quality settings (0060) already settled on for t2i and
--     edit: the request's quality, else 'medium' ONLY when the request names none. That is the same tier the non-preview path prices by
--     (credit unit model_<id>_<unit>_<tier>), the one the quote names, the one create_creative_job writes into the job and the one the
--     worker sends. A tier the model does not list is refused `invalid_params` before this (0060, unchanged), and so is a request that
--     names none on a model that does not list medium. A listed tier with no figure of its own (null, a figure that is not a JSON
--     number, 0, or over 100) is refused `unpriced`: never another tier's figure and never provider_usd_per_unit (CLAUDE.md #4). A
--     capability other than t2i and edit settles no tier, so no figure: `unpriced`, as before;
--   * any other variants.by (audio, resolution_audio, upscale_target, image_size): `unpriced`, as before.
-- The conversion is 0139's: 1 credit = 1 US cent of cost (docs/sql/prices_2026_10_01.sql), no margin, rounded up to the cent and floored
-- at job_minimum like every quote. A credit_prices row for the tier's unit still wins (the preview rate is read only when there is
-- none), and no credit_prices row is written: nothing goes on sale. Who may preview is 0139's creative_operator_preview, not replaced.
--
-- THE HUNKS (tests/test_preview_price_by_quality_migration.py undoes each one and compares the rest with 0149's body byte for byte):
--   the comment        over the preview rate: "quality" leaves the list of variants that stay unpriced, and four lines say why
--   the preview rate   one more WHEN in 0149's CASE: by quality, with a settled tier, the tier's figure. The cast, the 0 < figure <= 100
--                      test and the rate (figure x 100, margin 0) are 0149's lines, unchanged.
-- No variable is added: tier is the one the quality settings already set. The 0124 switch line, the 0125 shutdown line and 0139's
-- creative_operator_preview call are kept.
--
-- LOCKS AND GRANTS: unchanged. creative_price takes no lock (it is stable) and stays revoked from every API role.
--
-- NUMBER AND ORDER. 0153 (main ends at 0152; 0148 and 0150 are reserved by other work). It is written on 0149's body of creative_price,
-- so it REFUSES to apply without 0149, and its drift guard accepts only 0149's body or its own. 0149's replay and rollback refuse any
-- other body: run docs/sql/rollback_0153_preview_price_by_quality.sql FIRST (the security lab does: sec_db.take_off_0153, called by
-- take_off_0149).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = '728241a09e56f65e19efc460afea7355' as creative_price_is_0149s,
--          to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is not null as preview_rule_is_there
--     from pg_proc where oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- assumes it, and the last block asserts the end state. Additive and idempotent: create or replace, then revoke.
-- Rollback: docs/sql/rollback_0153_preview_price_by_quality.sql (owner-applied; refuses a body that is neither 0153's nor 0149's; puts
-- 0149's creative_price back byte for byte). Docs: docs/MIGRATIONS.md, "Operator preview priced by quality (0153)".

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is null
     or to_regprocedure('public.model_past_shutdown(jsonb)') is null
     or to_regprocedure('public.model_is_available(text)') is null then
    raise exception '0153 needs 0149_preview_price_by_resolution.sql (and 0139, 0125, 0124): apply them first';
  end if;
end $$;

-- The live body must be 0149's or this file's (a replay). Anything else (0139's included: 0149 not applied yet) was not what this file
-- was written on, and replacing it would silently undo or skip a change (the 0064/0103 lesson). md5 of prosrc with every run of white
-- space read as one space; the test recomputes every hash.
do $$
declare
  c text;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into c from pg_proc x where x.oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
  if c is null or c <> all (array['728241a09e56f65e19efc460afea7355', '28130a014027e6ad0b7876a78d69a396']) then
    raise exception '0153 found a creative_price() that is neither 0149''s body nor 0153''s (md5 %): read the live body first (0149 must be applied before 0153)', c;
  end if;
end $$;

-- 0149's quote with the preview rate also taken per quality tier (the hunks in the header).
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
  -- 0139: whether this quote is an operator preview (see creative_operator_preview).
  m_avail text;
  preview boolean := false;
  -- 0149: the vendor's figure for exactly the setting a preview is quoted at, and that figure as a number.
  vusd    jsonb;
  vcost   numeric;
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
  if preview and m_unit is not null and rate.unit is null
     and jsonb_typeof(m_spec -> 'pricing') = 'object' then
    vusd := case
              when not (m_spec -> 'pricing' ? 'variants') then m_spec -> 'pricing' -> 'provider_usd_per_unit'
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'resolution' and vres is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vres
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' and tier is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> tier
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
    || variant
    -- 0139: a preview says so, and the Studio shows it as the operator's record, never as a price on sale.
    || case when preview then jsonb_build_object('preview', true) else '{}'::jsonb end;
end
$$;

revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  fn  oid := 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
  def text;
  got text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
  if got <> '28130a014027e6ad0b7876a78d69a396' then
    raise exception '0153 end state: creative_price does not hold this file''s body (md5 %)', got;
  end if;
  -- No API role at all. A NULL ACL would mean "default privileges", and the default includes public.
  if exists (select 1 from pg_proc p
              where p.oid = fn
                and (p.proacl is null
                     or exists (select 1 from aclexplode(p.proacl) a
                                 where a.grantee = 0
                                    or a.grantee in (select o.oid from pg_roles o
                                                      where o.rolname in ('anon', 'authenticated', 'service_role'))))) then
    raise exception '0153 end state: creative_price is executable by a role that must not call it';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = fn and p.proconfig @> array['search_path=public, pg_temp']) then
    raise exception '0153 end state: creative_price has no pinned search_path';
  end if;
  -- The guards every creative_price keeps (0124's switch, 0125's date) and the preview reached only through 0139's rule.
  def := pg_get_functiondef(fn);
  if position('model_is_available' in def) = 0 or position('model_past_shutdown' in def) = 0
     or position('creative_operator_preview' in def) = 0 then
    raise exception '0153 end state: creative_price lost a guard';
  end if;
  -- Nothing is on sale because of this file: it writes no price and changes no availability.
  if exists (select 1 from public.model_registry where availability in ('beta', 'ga') and coalesce(spec ->> 'terms_gate', '') <> '') then
    raise exception '0153 end state: a terms-gated model is on sale';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure) = '28130a014027e6ad0b7876a78d69a396' as creative_price_is_0153s,
--   position('creative_operator_preview' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0
--     and position('model_past_shutdown' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0
--     and position('model_is_available' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0 as guards_kept,
--   not has_function_privilege('authenticated', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE') as functions_scoped,
--   not exists (select 1 from public.credit_prices
--                where unit like 'model\_openai\_gpt\_image\_2\_5\_%' or unit like 'model\_ideogram\_3\_%'
--                   or unit like 'model\_ideogram\_4\_%') as nothing_new_on_sale;
