-- 0194_open_llm_describe.sql — put on sale (beta) the Studio's "Describe" on Claude Sonnet 5.5 and on GPT-6 Luna, once each has been
-- verified by a real probe and priced by the owner.
--
-- *** LIVE ON APPLY. *** It sets model_registry.availability to beta (entitlement NULL) for the two describe models below when they
-- pass every gate, and writes NOTHING else: no credit_prices row, no function, policy, grant, trigger or constraint.
--
-- WHY DESCRIBE. The Studio's one live, metered text feature is the `describe` creative job (picture -> generation prompt, 0055): quote,
-- hold, capture and refund already run through creative_price / finish_creative_job, and the Studio's Describe tool lists whatever
-- sellable_models offers for it. "Improve with AI" and the prompt director make no model call, and the series planner is granted to
-- nobody yet (0122 / 0127), so this is where Claude and GPT can work inside the product today. Adapters: image.anthropic_describe and
-- image.openai_describe (modules/capabilities/describe_llm.py). Neither falls back to another vendor when its call fails.
--
-- WHY NO PRICE IS WRITTEN HERE. Prices live only in the database, set by the owner in the SQL editor before this file is applied. A
-- model with no credit_prices row for its unit is left hidden: sellable_models would not list it and a quote would answer `unpriced`.
--
-- THE GATES (each model is opened only when ALL hold; one that fails is left exactly as it is, with a NOTICE that names the fix):
--   * in model_registry with the adapter, vendor model and credit unit below, offering exactly `describe`;
--   * verified_at and verified_probe_id set (a successful real call through its adapter, recorded by tools/probe_models.py, 0035);
--   * spec.terms_gate empty. Terms read 2026-11-20: Anthropic Commercial Terms A.1 ("to power products and services Customer makes
--     available to its own customers and end users"; D.4 no competing models, no reselling the Services: the Studio sells its own
--     Describe feature, never raw API access; D.3 accuracy notice: the Studio shows "Written by AI ... check it" under every
--     description) and the OpenAI Services Agreement ("to make Customer Applications available to End Users"; no reselling account
--     access). Names are plain text only, no logo (Anthropic trademark guidelines; OpenAI §10 No Publicity);
--   * spec.api_exposure web_only (the Studio only); not past a shutdown (0125); not `disabled`; no blocked_countries (0142);
--   * a credit_prices row for the model's unit.
--
-- Idempotent. Rollback: docs/sql/rollback_0194_open_llm_describe.sql (owner-applied: hidden again). NUMBER: 0194 for the investor
-- sprint (stream S10); Atlas may renumber it.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.model_registry') is null or to_regclass('public.credit_prices') is null
     or to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0194 needs 0020 (credit_prices) and 0035 (model_registry, sellable_models): apply them first';
  end if;
end $$;

do $$
declare
  models constant jsonb := $json$[
    {"id": "anthropic-claude-sonnet-5-5", "adapter": "image.anthropic_describe", "vendor_model": "claude-sonnet-5-5",
     "credit_unit": "model_anthropic_claude_sonnet_5_5_request"},
    {"id": "openai-gpt-6-luna", "adapter": "image.openai_describe", "vendor_model": "gpt-6-luna",
     "credit_unit": "model_openai_gpt_6_luna_request"}
  ]$json$::jsonb;
  caps constant text[] := array['describe'];
  m       jsonb;
  r       public.model_registry;
  q       text;
  why     text;
  opened  text[] := '{}';
begin
  if not exists (select 1 from public.model_registry) then
    raise notice '0194: model_registry is empty (not synced yet): nothing opened';
    return;
  end if;
  if to_regprocedure('public.model_past_shutdown(jsonb)') is null or to_regprocedure('public.model_is_available(text)') is null then
    raise exception '0194 needs 0124 (model_is_available) and 0125 (model_past_shutdown): apply them first';
  end if;

  for m in select * from jsonb_array_elements(models) loop
    why := null;
    select * into r from public.model_registry where id = m ->> 'id';
    if not found then
      why := 'not in model_registry: sync the file (Actions -> Probe models)';
    elsif r.adapter <> m ->> 'adapter' or r.spec ->> 'vendor_model' is distinct from m ->> 'vendor_model'
          or r.credit_unit is distinct from m ->> 'credit_unit' then
      why := format('calls %s / %s (unit %s), not what this file was written for', r.adapter, r.spec ->> 'vendor_model', r.credit_unit);
    elsif not (r.capabilities @> caps and r.capabilities <@ caps) or r.spec ? 'vendor_model_by_capability' then
      why := format('offers %s, not exactly describe: review it first', r.capabilities);
    elsif r.availability = 'disabled' then
      why := 'disabled by the owner: this file does not turn it back on';
    elsif r.verified_at is null or r.verified_probe_id is null then
      why := 'no successful probe yet: run Actions -> Probe models for it (needs its API key secret), then apply again';
    elsif coalesce(r.spec ->> 'terms_gate', '') <> '' then
      why := format('terms-gated (%s)', r.spec ->> 'terms_gate');
    elsif coalesce(r.spec ->> 'api_exposure', '') <> 'web_only' then
      why := 'not web_only: its API and MCP exposure needs its own review';
    elsif coalesce(nullif(r.spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb then
      why := 'carries blocked_countries (0142)';
    elsif public.model_past_shutdown(r.spec) then
      why := 'past its announced shutdown date (0125)';
    elsif not exists (select 1 from public.credit_prices where unit = r.credit_unit and credits_per_unit > 0) then
      why := format('no credit_prices row above 0 for %s: the owner sets the price first', r.credit_unit);
    end if;

    if why is not null then
      raise notice '0194: % left as it is: %', m ->> 'id', why;
      continue;
    end if;

    update public.model_registry
       set entitlement = null,
           availability = case when availability = 'hidden' then 'beta' else availability end
     where id = r.id and (entitlement is not null or availability = 'hidden');
    opened := opened || r.id;
  end loop;

  raise notice '0194: on sale (beta or already ga): %', case when opened = '{}' then 'none' else array_to_string(opened, ', ') end;

  foreach q in array opened loop
    select * into r from public.model_registry where id = q;
    if r.availability not in ('beta', 'ga') or r.entitlement is not null then
      raise exception '0194 end state: % is not on sale as this file says', q;
    end if;
    if public.model_is_available(q) and not exists (select 1 from public.sellable_models(null, 'web') s where s.id = q) then
      raise exception '0194 end state: % is on sale but sellable_models does not list it', q;
    end if;
    if exists (select 1 from public.sellable_models(null, 'api') s where s.id = q)
       or exists (select 1 from public.sellable_models(null, 'mcp') s where s.id = q) then
      raise exception '0194 end state: % is offered through the API or MCP', q;
    end if;
  end loop;
end $$;

-- Verify (read-only, after applying):
--   select id, availability, entitlement, verified_at is not null as verified from public.model_registry
--    where id in ('anthropic-claude-sonnet-5-5', 'openai-gpt-6-luna');
--   select id from public.sellable_models(null, 'web') where id in ('anthropic-claude-sonnet-5-5', 'openai-gpt-6-luna');
