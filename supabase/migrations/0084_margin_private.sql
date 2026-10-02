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
--             `margin` key of quote_creative_job() (0036; the public API's
--             creative quote is the same jsonb). The base credits_per_unit
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
--   quote_creative_job() 0036's body plus two lines: the quote names the rate
--                        as charged and carries no margin key. credits (what
--                        is held), unit, quantity and minimum are unchanged;
--                        create_creative_job prices with creative_price
--                        directly, so no hold or charge moves.
--
-- MONEY: UNCHANGED. Every function that charges (reserve_credits,
-- request_download, download_credits_price, creative_price,
-- render_jobs_payment_guard, approve_storyboard) is SECURITY DEFINER and reads
-- credit_prices as its owner, past RLS: none is replaced here. The worker
-- reads the table with the service key (RLS does not apply to it).
--
-- WHO MAY DO WHAT
--   credit_prices    select / insert / update / delete: platform owner/admin.
--   credit_rates     execute: authenticated (refuses no one signed in; empty
--                    for a session without a user). anon: nothing.
--   sellable_models, quote_creative_job: as before (0072 / 0036).
--
-- DEPLOY ORDER: the Command Center first (it reads credit_rates() and falls
-- back to the table while the function is missing), then this file. The other
-- way round, a member's estimate reads an empty price list until the deploy
-- and is refused as unpriced (never priced at 0).
--
-- REQUIRES 0020, 0035, 0036 and 0072. Built on the latest bodies:
-- sellable_models = 0072's, quote_creative_job = 0036's (tests pin every
-- string literal). Additive and idempotent: drop-then-create policy,
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
  -- sellable_models is replaced from 0072's body: on an older one this file
  -- would take captions, the quality tiers and the video variants away.
  if to_regprocedure('public.sellable_models(text, text)') is null
     or position('captions' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) = 0 then
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
-- 3. The catalog and the quote: the rate as charged, no margin
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

-- 0036's quote_creative_job (the only body it has had), plus the rate as charged.
create or replace function public.quote_creative_job(
  p_org uuid, p_capability text, p_model text, p_params jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q   jsonb;
  acc public.credit_accounts;
begin
  if auth.uid() is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  q := public.creative_price(p_org, p_capability, p_model, p_params);
  -- 0084: a member (or an API key) is told the rate as charged, never the
  -- platform's base rate and margin apart. credits, unit, quantity and
  -- minimum are creative_price's own, unchanged.
  q := (q - 'margin') || jsonb_build_object('credits_per_unit',
         (q ->> 'credits_per_unit')::numeric * (1 + coalesce((q ->> 'margin')::numeric, 0)));
  select * into acc from public.credit_accounts where org_id = p_org;
  return q || jsonb_build_object(
    'available', case when public.credits_exempt(p_org) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Grants (revoke-then-grant, as 0036 / 0072)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.credit_rates() from public, anon, authenticated, service_role;
grant execute on function public.credit_rates() to authenticated;
revoke all on function public.sellable_models(text, text) from public, anon;
grant execute on function public.sellable_models(text, text) to authenticated, service_role;
revoke all on function public.quote_creative_job(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.quote_creative_job(uuid, text, text, jsonb) to authenticated;

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
--   position('(q - ''margin'')' in pg_get_functiondef('public.quote_creative_job(uuid,text,text,jsonb)'::regprocedure)) > 0
--     as quote_has_no_margin,
--   not has_function_privilege('anon', 'public.sellable_models(text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.quote_creative_job(uuid,text,text,jsonb)', 'EXECUTE')
--     as anon_nothing;
