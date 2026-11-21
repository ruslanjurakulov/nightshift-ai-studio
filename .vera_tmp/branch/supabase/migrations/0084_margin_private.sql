-- 0084_margin_private.sql — the platform's margin (credit_prices.margin) is
-- never shown to an organization's members. They see each price AS CHARGED
-- (credits_per_unit x (1 + margin)); the base rate, the margin and the
-- price-list notes stay the platform's.
--
-- Security fix (Breach wave 6, low):
--   BR-G-001  Any signed-in member read the platform's markup three ways:
--             `select margin from credit_prices` (0020 granted the table and
--             its SELECT policy to every signed-in user, every column), the
--             `margin` column of sellable_models() (latest body 0072), and the
--             `margin` key of every creative quote (creative_price's jsonb,
--             latest body 0072, which quote_creative_job, the public API's
--             quote and any routed quote return as is). The base credits_per_unit
--             next to any price shown gave the margin by division too, and the
--             notes carried provider list prices. 0037 states the rule this
--             enforces: "the platform's own margin, never shown to an
--             organization's members".
--
-- WHAT IT CHANGES (no table, column or row is dropped; no price changes)
--   credit_prices        SELECT policy: platform owner/admin only (was: any
--                        signed-in user). The operator's price-list editor
--                        reads and writes exactly as before. A COLUMN grant
--                        cannot do this: the operator and a member are the
--                        same database role (authenticated), so a grant that
--                        hides margin from one hides it from the other — and
--                        from the editor's upsert. RLS decides by person.
--   credit_rates()       NEW. What a signed-in member is charged per unit:
--                        (unit, credits_per_unit AS CHARGED, updated_at).
--                        job_minimum and download_minimum are flat floors
--                        whose margin is ignored (0020 / 0030), so they are
--                        their own credits_per_unit; every other unit is
--                        credits_per_unit x (1 + margin), the formula 0020,
--                        0030 and 0036 charge with. Never the margin, never
--                        the note. The Command Center's estimates (runs,
--                        storyboards, downloads, the pricing and credits
--                        pages) read this instead of the table.
--   sellable_models()    0072's body; ONE line changed: credits_per_unit is
--                        the rate as charged and margin is NULL. The return
--                        type is unchanged on purpose — every earlier
--                        migration's create-or-replace still applies on a
--                        replay, and api_creative_model_ok (0062), the only
--                        API/MCP caller, only asks whether a row exists.
--   creative_price()     0072's body; ONE line changed: the quote's
--                        credits_per_unit is the rate as charged and it has
--                        no margin key. Fixed here, in the one function every
--                        quote is built from (quote_creative_job, the API's
--                        api_creative_quote, workflow quotes, and any later
--                        routed quote), so no caller can pass the margin on.
--                        No caller reads either key: the price itself
--                        (credits = ceil_cent(qty x rate x (1 + margin)),
--                        floored at job_minimum), unit and quantity are
--                        computed exactly as before, so no hold moves.
--
-- MONEY: UNCHANGED. Every function that charges (reserve_credits,
-- request_download, download_credits_price, creative_price,
-- render_jobs_payment_guard, approve_storyboard) is SECURITY DEFINER and reads
-- credit_prices as its owner, past RLS. creative_price is replaced with its
-- arithmetic untouched (tests pin every line but the returned key). The worker
-- reads the table with the service key (RLS does not apply to it).
--
-- WHO MAY DO WHAT
--   credit_prices    select / insert / update / delete: platform owner/admin.
--   credit_rates     execute: authenticated (refuses no one signed in; empty
--                    for a session without a user). anon: nothing.
--   sellable_models: as 0072. creative_price: no API role (as 0036/0072).
--
-- DEPLOY ORDER: the Command Center first (it reads credit_rates() and falls
-- back to the table while the function is missing), then this file. The other
-- way round, a member's estimate reads an empty price list until the deploy
-- and is refused as unpriced (never priced at 0).
--
-- REQUIRES 0020, 0035, 0036, 0060, 0070 and 0072. Built on the latest bodies:
-- sellable_models and creative_price = 0072's (tests pin every line but the
-- one changed in each). Additive and idempotent: drop-then-create policy,
-- create-or-replace functions, revoke-then-grant.

do $$
begin
  if to_regclass('public.credit_prices') is null
     or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0084 needs 0020_credits.sql: apply it first';
  end if;
  if to_regprocedure('public.quote_creative_job(uuid, text, text, jsonb)') is null then
    raise exception '0084 needs 0036_creative_jobs.sql: apply it first';
  end if;
  -- sellable_models and creative_price are replaced from 0072's bodies: on
  -- older ones this file would take captions, the quality tiers and the
  -- video variants away.
  if to_regprocedure('public.sellable_models(text, text)') is null
     or position('captions' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) = 0
     or position('captions' in pg_get_functiondef('public.creative_price(uuid, text, text, jsonb)'::regprocedure)) = 0 then
    raise exception '0084 needs 0072_captions.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The price list: the operator's (RLS by person, not a column grant)
-- ───────────────────────────────────────────────────────────────────────────

drop policy if exists credit_prices_select on public.credit_prices;
create policy credit_prices_select on public.credit_prices
  for select to authenticated
  using ((select public.is_platform_admin()));

comment on table public.credit_prices is
  'Platform price list. credits = quantity * credits_per_unit * (1 + margin). Units: video_minute (the Run now estimate), usd (per USD of priced ledger cost), job_minimum (smallest hold; margin ignored), or a cost-ledger unit name (used before usd). An unset unit is unpriced — never 0. Read and written by a platform owner/admin only (0084): members read the rates as charged through credit_rates(), never the margin or the notes.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. What a member is charged per unit
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credit_rates()
  returns table (unit text, credits_per_unit numeric, updated_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
  select cp.unit,
         -- Flat floors ignore their margin (0020 reserve_credits, 0030
         -- request_download); every other unit is charged with it.
         case when cp.unit in ('job_minimum', 'download_minimum') then cp.credits_per_unit
              else cp.credits_per_unit * (1 + cp.margin) end,
         cp.updated_at
    from public.credit_prices cp
   where (select auth.uid()) is not null
   order by cp.unit
$$;

comment on function public.credit_rates() is
  'The price list as charged (0084): unit, credits per unit with the margin folded in (job_minimum / download_minimum: flat), updated_at. Never the margin or the note. Signed-in users only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The catalog and every quote: the rate as charged, no margin
-- ───────────────────────────────────────────────────────────────────────────

-- 0072's sellable_models (captions, 0070's video variants, 0060's quality
-- tiers). Every line is 0072's except the one that returned cp.margin.
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
                              'voice_change', 'dub', 'video_upscale', 'describe', 'captions') then
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

-- 0072's creative_price (captions, 0070's video variants, 0060's quality
-- tiers). Every line is 0072's except the one that returned rate.margin.
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

  if cap in ('voice_change', 'dub', 'video_upscale', 'captions') then
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
    -- 0084: the rate as charged, never the platform's base rate and margin
    -- apart (every quote, the API's and the routed ones included).
    'credits_per_unit', rate.credits_per_unit * (1 + rate.margin), 'minimum', minimum)
    -- The tier this price is for, so what the person confirms names it.
    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end
    -- The resolution and soundtrack this price is for (0070).
    || variant;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Grants (revoke-then-grant, as 0036 / 0072)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.credit_rates() from public, anon, authenticated, service_role;
grant execute on function public.credit_rates() to authenticated;
revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;
revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select qual from pg_policies where schemaname = 'public' and tablename = 'credit_prices'
--     and policyname = 'credit_prices_select') like '%is_platform_admin%' as prices_operator_only,
--   (select relrowsecurity from pg_class where oid = 'public.credit_prices'::regclass) as rls_on,
--   has_function_privilege('authenticated', 'public.credit_rates()', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.credit_rates()', 'EXECUTE') as rates_signed_in_only,
--   (select prosecdef from pg_proc where oid = 'public.credit_rates()'::regprocedure) as rates_definer,
--   position('null::numeric' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) > 0
--     and position('captions' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) > 0
--     as catalog_has_no_margin,
--   position('''margin''' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) = 0
--     and position('captions' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0
--     and not has_function_privilege('authenticated', 'public.creative_price(uuid,text,text,jsonb)', 'EXECUTE')
--     as quote_has_no_margin,
--   not has_function_privilege('anon', 'public.sellable_models(text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.quote_creative_job(uuid,text,text,jsonb)', 'EXECUTE')
--     as anon_nothing;
