-- 0139_operator_preview.sql — the platform operator may try a hidden model in the site's own Studio before it is offered to anyone.
--
-- *** LIVE ON APPLY, and dark until the registry says so. *** Merging this file applies it to the live database. It replaces ONE function
-- that exists there (creative_price, on 0125's body plus the hunks listed below) and adds two: creative_operator_preview (internal) and
-- operator_preview_models (signed-in users). Nothing changes for anyone until a model's registry entry carries `"operator_preview": true`
-- and `tools/probe_models.py --sync` has copied it into model_registry.spec. No entry carries it in this pull request.
--
-- WHY. A model the owner has not opened to customers is hidden: it may still be terms-gated (0035 forbids beta or ga while
-- spec.terms_gate is set) and unpriced (no credit_prices row), and creative_price quotes only beta or ga models with a price. So the
-- operator could not use such a model even in the operator's own organization, which the platform pays for anyway. This file lets
-- exactly that one case through, and nothing else.
--
-- THE RULE. creative_price accepts a model that is not beta or ga ONLY when ALL of these hold (creative_operator_preview):
--   1. the model is `hidden` (never `disabled`: that is the owner's off, or a model removed from the file);
--   2. its spec says `"operator_preview": true` (the JSON value true; any other value is false);
--   3. the caller is a platform owner or admin (is_platform_admin(), the JWT's own user: a worker or the service key never is);
--   4. the organization is the credits-exempt one (credits_exempt(p_org): the operator's own) and the caller is its member.
-- Every other check of the quote still runs, in the same order: the model must be verified by a real probe (verified_at), not past an
-- announced shutdown date (0125), not switched off by the owner (0124's model_is_available), and the capability, the inputs and the
-- options must be ones the registry lists. A customer, and a platform admin acting in any other organization, are answered exactly as
-- before: `model_not_sellable`, with the same words.
--
-- MONEY: the normal path, no bypass. quote_creative_job and create_creative_job are NOT replaced: they call creative_price as they did.
-- create_creative_job already lets only a platform admin start a generation in the exempt organization, and already skips the hold there:
-- creative_platform_reserve -> reserve_credits answers {"exempt": true} for that organization, the job's credit_ref is NULL, and the
-- finish captures nothing. A preview is that same path. reserve_credits, capture_credits, release_credits and job_minimum are untouched.
-- A preview of a model that HAS a credit_prices row is quoted at that row. One that has none (the usual case: nothing is on sale) is
-- quoted at the vendor's own cost from the reviewed registry figure (spec.pricing.provider_usd_per_unit x 100: 1 credit = 1 US cent of
-- cost, the convention of docs/sql/prices_2026_10_01.sql; no margin), rounded up to the cent and floored at job_minimum like every
-- quote. That number is the job's record (quoted_credits), never a charge, and NO credit_prices row is written: no price goes on sale. A
-- model priced by variant, or with no stated figure, or one over $100 a unit, stays `unpriced`. The quote says `"preview": true`.
-- A plan entitlement (`models_image:basic` ...) is what a customer's plan buys; it is not asked of a preview (the exempt organization
-- has no plan). The `paid` entitlement was already not asked of the exempt organization.
--
-- WHAT THE STUDIO SEES. operator_preview_models(p_org) lists the same models, with the public half of their spec (sellable_models'
-- keys), and returns NO ROWS for anyone the rule above refuses (not an error: a customer's Studio loads exactly as before). The Command
-- Center reads it only for the platform operator in the exempt organization and marks those models "Preview". sellable_models, the
-- API's model check (api_creative_model_ok asks sellable_models) and the router's candidates are unchanged, so a preview model is never
-- offered by the API, MCP or an automatic pick.
--
-- THE HUNKS (tests/test_operator_preview_migration.py undoes each one and compares the rest with 0125's body byte for byte):
--   declare            m_avail text, preview boolean := false
--   the lookup         reads r.availability too; `availability in ('beta', 'ga')` becomes `(... or creative_operator_preview(...))`
--   after the refusal  preview := m_avail not in ('beta', 'ga')
--   entitlement        `if not preview and ...`
--   unpriced           the vendor-cost rate for a preview with no credit_prices row
--   the answer         `|| {"preview": true}` for a preview
-- The 0124 switch line and the 0125 shutdown line are kept (tests/test_model_shutdown.py checks every later creative_price for both).
--
-- LOCKS AND GRANTS: unchanged. creative_price takes no lock (it is stable); create_creative_job still takes the credit account lock
-- first. creative_price stays revoked from every API role. creative_operator_preview is revoked from every API role (both callers are
-- security definer and run it as their owner). operator_preview_models is granted to `authenticated` only.
--
-- NUMBER AND ORDER. 0139: the highest on main is 0138. It is written on 0125's body of creative_price, so it REFUSES to apply without 0125
-- (and 0124), and its drift guard accepts only 0125's body or its own. 0125's rollback refuses a body that is not 0125's or 0124's: run
-- docs/sql/rollback_0139_operator_preview.sql FIRST (the security lab does: sec_db.take_off_0139).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = 'e0c4a7806642086398558cf322c95a0d' as creative_price_is_0125s,
--          to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)') is null as helper_is_new,
--          to_regprocedure('public.operator_preview_models(uuid)') is null as list_is_new
--     from pg_proc where oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- assumes it, and the last block asserts the end state. Additive and idempotent: create or replace, revoke then grant.
-- Rollback: docs/sql/rollback_0139_operator_preview.sql (owner-applied; refuses a body that is neither 0139's nor 0125's; puts 0125's
-- creative_price back byte for byte and drops the two functions). Docs: docs/MIGRATIONS.md, "Operator preview of a hidden model (0139)".

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.model_past_shutdown(jsonb)') is null
     or to_regprocedure('public.model_is_available(text)') is null then
    raise exception '0139 needs 0125_model_shutdown.sql (and 0124): apply them first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null or to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null then
    raise exception '0139 needs 0018_organizations.sql and 0020_credits.sql: apply them first';
  end if;
end $$;

-- The live body must be 0125's or this file's (a replay). Anything else was changed by hand since, and replacing it would silently undo
-- that change (the 0064/0103 lesson). md5 of prosrc with every run of white space read as one space; the test recomputes every hash.
do $$
declare
  c text;
  h text;
  l text;
begin
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into c from pg_proc x where x.oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure;
  if c is null or c <> all (array['e0c4a7806642086398558cf322c95a0d', 'ae28b700503542701ee0ac63a67df36e']) then
    raise exception '0139 found a creative_price() that is neither 0125''s body nor 0139''s (md5 %): read the live body first', c;
  end if;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into h from pg_proc x where x.oid = to_regprocedure('public.creative_operator_preview(uuid, text, jsonb)');
  if h is not null and h <> 'ca8654e202cf46029350aaa3111c4c5d' then
    raise exception '0139 found a creative_operator_preview() that is not 0139''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(x.prosrc, '\s+', ' ', 'g')) into l from pg_proc x where x.oid = to_regprocedure('public.operator_preview_models(uuid)');
  if l is not null and l <> '525ba27b989bcb7d3d005f4a4972448f' then
    raise exception '0139 found an operator_preview_models() that is not 0139''s (md5 %): read the live body first', l;
  end if;
end $$;

-- The rule (see the header). JSON true only: `"yes"`, `1` or a string "true" is not a preview. Never errors: a spec nobody can read is no.
create or replace function public.creative_operator_preview(p_org uuid, p_availability text, p_spec jsonb) returns boolean
  language sql stable set search_path = public, pg_temp as $$
  select coalesce(p_availability = 'hidden'
                  and p_spec -> 'operator_preview' = 'true'::jsonb
                  and public.is_platform_admin()
                  and public.credits_exempt(p_org)
                  and public.is_org_member(p_org), false)
$$;

-- What the operator may preview in this organization: nothing at all for anyone else. The public half of spec, as sellable_models gives it.
create or replace function public.operator_preview_models(p_org uuid)
  returns table (id text, display_name text, provider text, capabilities text[], spec jsonb)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or p_org is null then
    return;
  end if;
  return query
    select m.id, m.display_name, m.provider, m.capabilities,
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
     where public.creative_operator_preview(p_org, m.availability, m.spec)
       -- The same proofs creative_price asks for: a real call worked, the owner has not switched it off, no shutdown date has come.
       and m.verified_at is not null
       and m.verified_probe_id is not null
       and public.model_is_available(m.id)
       and not public.model_past_shutdown(m.spec)
     order by m.provider, m.id;
end
$$;

-- 0125's quote with the operator preview (the hunks in the header).
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
  -- sale. A figure the registry does not state, or prices by variant, stays unpriced.
  if preview and m_unit is not null and rate.unit is null
     and jsonb_typeof(m_spec -> 'pricing') = 'object'
     and not (m_spec -> 'pricing' ? 'variants')
     and jsonb_typeof(m_spec -> 'pricing' -> 'provider_usd_per_unit') = 'number'
     and (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric > 0
     and (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric <= 100 then
    rate.unit := m_unit;
    rate.credits_per_unit := (m_spec -> 'pricing' ->> 'provider_usd_per_unit')::numeric * 100;
    rate.margin := 0;
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

revoke all on function public.creative_operator_preview(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.operator_preview_models(uuid) from public, anon, service_role;
grant execute on function public.operator_preview_models(uuid) to authenticated;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r   record;
  fn  oid;
  got text;
begin
  for r in
    select * from (values
      ('public.creative_price(uuid, text, text, jsonb)', 'ae28b700503542701ee0ac63a67df36e', ''),
      ('public.creative_operator_preview(uuid, text, jsonb)', 'ca8654e202cf46029350aaa3111c4c5d', ''),
      ('public.operator_preview_models(uuid)', '525ba27b989bcb7d3d005f4a4972448f', 'authenticated')
    ) v(sig, want, grantee)
  loop
    fn := to_regprocedure(r.sig);
    if fn is null then
      raise exception '0139 end state: % does not exist', r.sig;
    end if;
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
    if got <> r.want then
      raise exception '0139 end state: % does not hold this file''s body (md5 %)', r.sig, got;
    end if;
    -- Exactly the one API role named, or none. A NULL ACL would mean "default privileges", and the default includes public.
    if exists (select 1 from pg_proc p
                where p.oid = fn
                  and (p.proacl is null
                       or exists (select 1 from aclexplode(p.proacl) a
                                   where a.grantee = 0
                                      or a.grantee in (select o.oid from pg_roles o
                                                        where o.rolname in ('anon', 'authenticated', 'service_role')
                                                          and o.rolname <> r.grantee)))) then
      raise exception '0139 end state: % is executable by a role that must not call it', r.sig;
    end if;
    if r.grantee <> '' and not has_function_privilege(r.grantee, fn, 'execute') then
      raise exception '0139 end state: % is not executable by %', r.sig, r.grantee;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = fn and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0139 end state: % has no pinned search_path', r.sig;
    end if;
  end loop;
  -- The two guards every creative_price keeps (0124's switch, 0125's date), and the preview reached only through the rule.
  if position('model_is_available' in pg_get_functiondef('public.creative_price(uuid, text, text, jsonb)'::regprocedure)) = 0
     or position('model_past_shutdown' in pg_get_functiondef('public.creative_price(uuid, text, text, jsonb)'::regprocedure)) = 0
     or position('creative_operator_preview' in pg_get_functiondef('public.creative_price(uuid, text, text, jsonb)'::regprocedure)) = 0 then
    raise exception '0139 end state: creative_price lost a guard';
  end if;
  -- Nothing is on sale because of this file: it writes no price and changes no availability.
  if exists (select 1 from public.model_registry where availability in ('beta', 'ga') and coalesce(spec ->> 'terms_gate', '') <> '') then
    raise exception '0139 end state: a terms-gated model is on sale';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   not public.creative_operator_preview(public.default_org_id(), 'hidden', '{"operator_preview": true}'::jsonb) as nobody_signed_in_previews,
--   not public.creative_operator_preview(public.default_org_id(), 'hidden', '{"operator_preview": "true"}'::jsonb)
--     and not public.creative_operator_preview(public.default_org_id(), 'disabled', '{"operator_preview": true}'::jsonb) as only_json_true_and_hidden,
--   (select count(*) from public.operator_preview_models(public.default_org_id())) = 0 as the_editor_lists_nothing,
--   position('creative_operator_preview' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0
--     and position('model_past_shutdown' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0
--     and position('model_is_available' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0 as guards_kept,
--   not has_function_privilege('authenticated', 'public.creative_operator_preview(uuid,text,jsonb)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.creative_operator_preview(uuid,text,jsonb)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.operator_preview_models(uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.operator_preview_models(uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE') as functions_scoped;
