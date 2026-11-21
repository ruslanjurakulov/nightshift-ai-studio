-- 0193_open_openai_image.sql — put on sale (beta) the OpenAI GPT Image models that a real probe has verified and the owner has priced.
--
-- *** LIVE ON APPLY. *** It sets model_registry.availability to beta and model_registry.entitlement to NULL for the OpenAI GPT Image
-- models that pass every gate below, and writes NOTHING else: no credit_prices row, no function, policy, grant, trigger or constraint.
--
-- WHY NO PRICE IS WRITTEN HERE. Prices live only in the database (credit_prices), set by the owner from the owner's private notes in the
-- SQL editor before this file is applied. This file only reads them: a model with no price row for its base unit and for every
-- quality it sells (low / medium / high) is left hidden, because sellable_models would not list it and a quote would answer `unpriced`.
--
-- THE GATES (each model is opened only when ALL hold; a model that fails one is left exactly as it is, with a NOTICE that names the fix):
--   * in model_registry with the adapter, vendor model and credit unit this file was written for, offering exactly t2i + edit, and
--     no spec.vendor_model_by_capability (a capability that calls another vendor model was never probed here);
--   * verified_at and verified_probe_id set: a successful real call through image.openai recorded by tools/probe_models.py (0035).
--     CLAUDE.md: a model appears to users only after a real call through its adapter has succeeded;
--   * spec.terms_gate empty (0035's CHECK refuses beta otherwise in any case). OpenAI's terms were read for this file on 2026-11-20
--     (openai.com/policies/services-agreement): "This includes the right to use OpenAI's API to integrate the Services into Customer
--     Applications and to make Customer Applications available to End Users", with "Customer may not resell or lease access to its
--     Account or any End User Account" and no use of Output to develop competing models. In-app generation for our users fits that:
--     no key and no account access is ever exposed. Names are shown as plain text only (§10 No Publicity: no logo, no "powered by");
--   * spec.api_exposure web_only: the Studio only, until the web+MCP exposure (stream S5) lands and is reviewed for these models;
--   * not past its announced shutdown (0125): gpt-image-2 leaves OpenAI's API on 2027-02-10 per the registry's shutdown entry;
--   * not `disabled` (the owner's off) and no blocked_countries (0142);
--   * a credit_prices row for the base unit and for each quality variant (see above).
--
-- WHY THE ENTITLEMENT BECOMES NULL: the diagnosis in 0173's header. creative_price refuses every plan-tier entitlement for every
-- organization (tiers are `planned`), so a beta model with models_image:premium could be bought by nobody. The reviewed file
-- (schemas/model_registry.json) carries the same NULL, so `tools/probe_models.py --sync` keeps it.
--
-- Idempotent: a replay finds the models already beta and changes nothing. Rollback: docs/sql/rollback_0193_open_openai_image.sql
-- (owner-applied: hidden again). NUMBER: reserved 0193 for the investor sprint (stream S10); Atlas may renumber it.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.model_registry') is null or to_regclass('public.credit_prices') is null
     or to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0193 needs 0020 (credit_prices) and 0035 (model_registry, sellable_models): apply them first';
  end if;
end $$;

do $$
declare
  models constant jsonb := $json$[
    {"id": "openai-gpt-image-2",            "vendor_model": "gpt-image-2",            "credit_unit": "model_openai_gpt_image_2_image"},
    {"id": "openai-gpt-image-2.5-flare",    "vendor_model": "gpt-image-2.5-flare",    "credit_unit": "model_openai_gpt_image_2_5_flare_image"},
    {"id": "openai-gpt-image-2.5-sunburst", "vendor_model": "gpt-image-2.5-sunburst", "credit_unit": "model_openai_gpt_image_2_5_sunburst_image"},
    {"id": "openai-gpt-image-2.6-flare",    "vendor_model": "gpt-image-2.6-flare",    "credit_unit": "model_openai_gpt_image_2_6_flare_image"},
    {"id": "openai-gpt-image-2.6-sunburst", "vendor_model": "gpt-image-2.6-sunburst", "credit_unit": "model_openai_gpt_image_2_6_sunburst_image"}
  ]$json$::jsonb;
  caps constant text[] := array['t2i', 'edit'];
  qualities constant text[] := array['low', 'medium', 'high'];
  m       jsonb;
  r       public.model_registry;
  q       text;
  why     text;
  opened  text[] := '{}';
begin
  if not exists (select 1 from public.model_registry) then
    raise notice '0193: model_registry is empty (not synced yet): nothing opened';
    return;
  end if;
  if to_regprocedure('public.model_past_shutdown(jsonb)') is null or to_regprocedure('public.model_is_available(text)') is null then
    raise exception '0193 needs 0124 (model_is_available) and 0125 (model_past_shutdown): apply them first';
  end if;

  for m in select * from jsonb_array_elements(models) loop
    why := null;
    select * into r from public.model_registry where id = m ->> 'id';
    if not found then
      why := 'not in model_registry: sync the file (Actions -> Probe models)';
    elsif r.adapter <> 'image.openai' or r.spec ->> 'vendor_model' is distinct from m ->> 'vendor_model'
          or r.credit_unit is distinct from m ->> 'credit_unit' then
      why := format('calls %s / %s (unit %s), not what this file was written for', r.adapter, r.spec ->> 'vendor_model', r.credit_unit);
    elsif not (r.capabilities @> caps and r.capabilities <@ caps) or r.spec ? 'vendor_model_by_capability' then
      why := format('offers %s, not exactly t2i + edit on one vendor model: review it first', r.capabilities);
    elsif r.availability = 'disabled' then
      why := 'disabled by the owner: this file does not turn it back on';
    elsif r.verified_at is null or r.verified_probe_id is null then
      why := 'no successful probe yet: run Actions -> Probe models for it (needs the OPENAI_API_KEY secret), then apply again';
    elsif coalesce(r.spec ->> 'terms_gate', '') <> '' then
      why := format('terms-gated (%s)', r.spec ->> 'terms_gate');
    elsif coalesce(r.spec ->> 'api_exposure', '') <> 'web_only' then
      why := 'not web_only: its API and MCP exposure needs a reading of OpenAI''s terms first';
    elsif coalesce(nullif(r.spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb then
      why := 'carries blocked_countries (0142)';
    elsif public.model_past_shutdown(r.spec) then
      why := 'past its announced shutdown date (0125)';
    elsif not exists (select 1 from public.credit_prices where unit = r.credit_unit and credits_per_unit > 0) then
      why := format('no credit_prices row above 0 for %s: the owner sets the price first', r.credit_unit);
    else
      foreach q in array qualities loop
        if why is null and not exists (select 1 from public.credit_prices where unit = r.credit_unit || '_' || q and credits_per_unit > 0) then
          why := format('no credit_prices row above 0 for %s_%s: the owner sets the price first', r.credit_unit, q);
        end if;
      end loop;
    end if;

    if why is not null then
      raise notice '0193: % left as it is: %', m ->> 'id', why;
      continue;
    end if;

    update public.model_registry
       set entitlement = null,
           availability = case when availability = 'hidden' then 'beta' else availability end
     where id = r.id and (entitlement is not null or availability = 'hidden');
    opened := opened || r.id;
  end loop;

  raise notice '0193: on sale (beta or already ga): %', case when opened = '{}' then 'none' else array_to_string(opened, ', ') end;

  -- End state: every model opened here is listed by the Studio's catalog (unless the owner's switch has it off, 0124), and never by
  -- the API or MCP.
  foreach q in array opened loop
    select * into r from public.model_registry where id = q;
    if r.availability not in ('beta', 'ga') or r.entitlement is not null then
      raise exception '0193 end state: % is not on sale as this file says', q;
    end if;
    if public.model_is_available(q) and not exists (select 1 from public.sellable_models(null, 'web') s where s.id = q) then
      raise exception '0193 end state: % is on sale but sellable_models does not list it', q;
    end if;
    if exists (select 1 from public.sellable_models(null, 'api') s where s.id = q)
       or exists (select 1 from public.sellable_models(null, 'mcp') s where s.id = q) then
      raise exception '0193 end state: % is offered through the API or MCP', q;
    end if;
  end loop;
end $$;

-- Verify (read-only, after applying):
--   select id, availability, entitlement, verified_at is not null as verified from public.model_registry
--    where id like 'openai-gpt-image-%' order by id;
--   select id from public.sellable_models(null, 'web') where id like 'openai-%';
