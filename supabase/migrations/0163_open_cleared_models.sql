-- 0163_open_cleared_models.sql — put on sale (beta) the nine models whose vendor terms are cleared, that a real probe has verified,
-- that have a working adapter and a vendor price in the registry, at prices that never sell below that vendor price.
--
-- *** LIVE ON APPLY. MONEY. *** Merging this file applies it to the live database. It writes credit_prices rows (20 units), sets
-- model_registry.availability to beta and model_registry.entitlement to NULL for nine models, and replaces no function, policy, grant,
-- trigger or constraint. Everything else in the registry is left exactly as it is: the 68 terms-gated entries stay hidden, and 0035's
-- CHECK (terms_before_sale) would refuse this whole file if it tried to open one.
--
-- WHAT GOES ON SALE (the owner's instruction of 2026-11-13, "open all the models", read against the owner's own gates)
--   A model is opened only when ALL of these hold, and the file REFUSES to apply if one of the nine fails any of them (below):
--     verified_at / verified_probe_id set (a successful model_probe_runs row, 0035), spec.terms_gate empty (the owner's legal gate),
--     the adapter, vendor model and capabilities this file was written for (and no spec.vendor_model_by_capability: one capability
--     calling another vendor model would be sold at this file's figure), a vendor figure in spec.pricing for every priced variant, no
--     blocked_countries (0142), not past an announced shutdown (0125), not `disabled` (the owner's off), api_exposure web_only.
--   ideogram-3            image.ideogram        flat                      US$0.03 / image (Turbo)
--   ideogram-4            image.ideogram_v4     flat                      US$0.03 / image (Turbo, 1K)
--   ideogram-4.5          image.ideogram_v4_5   by quality low/medium/high US$0.03 / 0.06 / 0.10 per image
--   minimax-h3            video.minimax_h3      by resolution 768p / 2k    US$0.08 / 0.13 per second
--   minimax-h3-highspeed  video.minimax_h3      by resolution 480p / 768p  US$0.04 / 0.06 per second
--   minimax-h3-lite       video.minimax_h3      by resolution 480p / 768p  US$0.025 / 0.04 per second
--   minimax-h3-max        video.minimax_h3      by resolution 480p / 768p  US$0.05 / 0.08 per second
--   runway-gen4.5         video.runway          flat                      US$0.12 / second
--   runway-gen4-turbo     video.runway          flat                      US$0.05 / second
--   Every figure is the registry's own (schemas/model_registry.json spec.pricing, `confirmed: false`: list prices the owner read on the
--   vendor's page, not yet matched against a vendor bill). The drift guard compares each one with the number written here, so a
--   registry figure that moved since this file was written stops the apply instead of selling at a price derived from the old one.
--   EACH PROBE PROVED ONE CALL ONLY (the registry's probe entries): MiniMax H3 and H3 Highspeed i2v at 768p, H3 Lite and H3 Max i2v at
--   480p, Runway gen4.5 and gen4_turbo i2v, Ideogram 3 and 4 t2i, Ideogram 4.5 t2i at low. Not proven by any probe so far, yet sold by
--   this file at their own figures: every t2v call (MiniMax, gen4.5), MiniMax H3 2k, H3 Highspeed 480p, H3 Lite 768p, H3 Max 768p, and
--   Ideogram 4.5 medium and high.
--
-- THE PRICE POLICY (docs/sql/prices_2026_10_01.sql and prices_defaults_2026_10_03.sql, the convention every quote reads)
--   credits_per_unit = the vendor's cost in US cents (1 credit = 1 cent of cost); the customer pays credits_per_unit x (1 + margin);
--   margin 1.5 for image and video (2.0 is voice). So every unit THIS FILE WRITES sells at 2.5x its vendor figure, rounded UP to the cent
--   per job (creative_price: credits_round_up), and floored at job_minimum: 1 credit spent buys at most US$0.004 of vendor cost.
--   What that leaves depends on what the credit was bought at: about US$0.01 a credit retail (docs/BILLING_PLANS.md) is 2.5x before
--   fees; a bulk pack at US$0.008 and the Studio plan at US$0.0072 a credit are about 2x and 1.8x before fees, not 2.5x everywhere.
--   An existing row is kept (see THE DRIFT GUARD ON PRICES): on the live database ideogram-3 already has credits_per_unit 6, margin 1.5,
--   so ideogram-3 keeps its existing live row, 6 x 2.5 = 15 credits an image; the owner may lower it to 3 via a docs/sql script.
--   A model priced by variant is charged ONLY by the variant's own row (creative_price: model_<id>_<unit>_<resolution|tier>, 0060 /
--   0070), and a variant without a row is `unpriced`, never another variant's rate. Its base row (the model's credit_unit) is what
--   sellable_models joins to list the model at all, and is the DEFAULT variant's price (768p; Ideogram 4.5's medium), the same figure
--   the registry gives as provider_usd_per_unit, so the catalog never shows a number that no quote charges.
--
-- WHY THE ENTITLEMENT BECOMES NULL (the diagnosis)
--   The nine registry entries carry plan-tier entitlements (models_image:basic, models_video:premium, models_video:ultra ...).
--   0034 seeds plan_entitlements with those tiers (free = basic, creator = premium, pro and studio = all) and a model_tier_allowed()
--   helper, but nothing ever calls it: creative_price refuses EVERY entitlement other than `any` (NULL) and `paid`, for every
--   organization whatever its plan (0072 onwards, unchanged through 0156), and entitlement_keys marks models_* `planned`. Both Studio
--   pages say the same (lib/models-discovery.ts planGate, and the open claude/studio-model-driven branch's modelLock). So:
--     * opening availability alone would let nobody buy (entitlement_required for every customer), and
--     * it would also take the models AWAY from the operator: 0139's preview passes only while a model is `hidden`, and a beta model's
--       quote asks the entitlement even in the credits-exempt organization.
--   Enforcing the tiers the way 0034 meant (creative_price calling model_tier_allowed, the keys flipped to enforced, both Studio gates
--   taught the plan) is a separate change: it replaces creative_price and edits files two open branches are changing, and with no plan
--   purchasable yet (Dodo is not live) it would still open only the two `basic` models to anyone. This file therefore uses the one
--   entitlement the database, the Models page and the Studio already agree is open: NULL. The reviewed file
--   (schemas/model_registry.json) carries the same NULL, so `tools/probe_models.py --sync` keeps it. The tier each model had is kept in
--   the rollback, to be restored when tiers are enforced.
--
-- WHAT THE FREE SIGN-UP CREDITS CAN COST (stated, not capped here)
--   A new account gets 100 welcome credits once per mailbox (0027 / 0042: welcome_credit_claims). Every unit here sells at 2.5x or more
--   (ideogram-3 at 5x), so 100 credits buy at most US$0.40 of vendor cost per account (less after per-job rounding up). An invite reward (0092, off by default) adds 100
--   credits per 5 joined accounts, at most US$0.08 more per account. A FAILED or refused job returns its whole hold (finish_creative_job),
--   so if a vendor bills a failed or moderated task (MiniMax's pricing page does not say; not verified for Runway or Ideogram either),
--   the same 100 credits can be used again and that vendor money is not bounded by the 100 credits. The PR proposes caps; none is applied.
--
-- WHAT IS LEFT TO THE OWNER (the registry's own "before a sale" notes; this file cannot check them)
--   MiniMax and Runway may use inputs and outputs to improve their models (their terms): this PR adds that line to the Privacy Policy's
--   processors. Runway: a photo-consent confirmation on the i2v upload and an export-embargo country decision are still open (a country
--   list would keep it off sale under 0142 until the database checks countries). MiniMax: Uzbekistan billing was not verified.
--
-- THE DRIFT GUARD ON PRICES. A credit_prices row that already exists for one of these units is never overwritten (the convention of every
-- price file: a price the owner set wins). Identical rows are left alone; a row that sells at or above this file's price is kept with a
-- NOTICE; a row that sells BELOW this file's price stops the apply (the exposure figures above would not hold). An empty registry (a fresh
-- deployment, the security lab's build) writes nothing at all; a synced registry without one of the nine stops the apply.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: nine rows, every column true, and no row in the
-- second query (or only rows you mean to keep: they must sell at or above this file's figure).
--   select id, verified_at is not null and verified_probe_id is not null as verified, coalesce(spec ->> 'terms_gate', '') = '' as cleared,
--          availability in ('hidden', 'beta') as openable, not public.model_past_shutdown(spec) as not_shut_down
--     from public.model_registry
--    where id in ('ideogram-3', 'ideogram-4', 'ideogram-4.5', 'minimax-h3', 'minimax-h3-highspeed', 'minimax-h3-lite', 'minimax-h3-max',
--                 'runway-gen4.5', 'runway-gen4-turbo') order by id;
--   select unit, credits_per_unit, margin from public.credit_prices
--    where unit like 'model\_ideogram\_%' or unit like 'model\_minimax\_h3%' or unit like 'model\_runway\_gen4%' order by unit;
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout` assumes
-- it, and the end state is asserted inside the same block that writes. Idempotent: a replay finds its rows and changes nothing.
-- Rollback: docs/sql/rollback_0163_open_cleared_models.sql (owner-applied: hidden again, the tiers back, and only the price rows this file
-- wrote and nobody changed since are deleted). Docs: docs/MIGRATIONS.md, "The nine cleared models on sale (0163)".
--
-- NUMBER. 0163 (first written as 0160, renumbered so 0161 (#744) and 0162 (#743) can land first: the Supabase integration refuses a
-- number below the latest applied one, and this file waits for the owner). Main ends at 0157 (#729, the Dodo purchase history: it writes
-- neither model_registry nor credit_prices); 0158 to 0162 belong to other branches this file was not checked against. A later file
-- that changes one of the nine's figures, call or entitlement makes a replay of this one refuse rather than sell at an old price.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.model_registry') is null or to_regclass('public.credit_prices') is null
     or to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0163 needs 0020 (credit_prices) and 0035 (model_registry, sellable_models): apply them first';
  end if;
end $$;

-- One block: the data is written once, and the writes and the end state are checked in the same place.
do $$
declare
  -- id, the call this file was written for (adapter, vendor model, unit, capabilities), the tier it had (restored by the
  -- rollback), and how it is priced.
  models constant jsonb := $json$[
    {"id": "ideogram-3", "adapter": "image.ideogram", "vendor_model": "TURBO", "credit_unit": "model_ideogram_3_image",
     "caps": ["t2i"], "tier": "models_image:basic", "by": null, "default": null},
    {"id": "ideogram-4", "adapter": "image.ideogram_v4", "vendor_model": "turbo", "credit_unit": "model_ideogram_4_image",
     "caps": ["t2i"], "tier": "models_image:premium", "by": null, "default": null},
    {"id": "ideogram-4.5", "adapter": "image.ideogram_v4_5", "vendor_model": "ideogram-4-5", "credit_unit": "model_ideogram_4_5_image",
     "caps": ["t2i"], "tier": "models_image:premium", "by": "quality", "default": "medium"},
    {"id": "minimax-h3", "adapter": "video.minimax_h3", "vendor_model": "MiniMax-H3", "credit_unit": "model_minimax_h3_second",
     "caps": ["t2v", "i2v"], "tier": "models_video:premium", "by": "resolution", "default": "768p"},
    {"id": "minimax-h3-highspeed", "adapter": "video.minimax_h3", "vendor_model": "MiniMax-H3-Highspeed",
     "credit_unit": "model_minimax_h3_highspeed_second", "caps": ["t2v", "i2v"], "tier": "models_video:premium", "by": "resolution", "default": "768p"},
    {"id": "minimax-h3-lite", "adapter": "video.minimax_h3", "vendor_model": "MiniMax-H3-Lite", "credit_unit": "model_minimax_h3_lite_second",
     "caps": ["t2v", "i2v"], "tier": "models_video:basic", "by": "resolution", "default": "768p"},
    {"id": "minimax-h3-max", "adapter": "video.minimax_h3", "vendor_model": "MiniMax-H3-Max", "credit_unit": "model_minimax_h3_max_second",
     "caps": ["t2v", "i2v"], "tier": "models_video:premium", "by": "resolution", "default": "768p"},
    {"id": "runway-gen4.5", "adapter": "video.runway", "vendor_model": "gen4.5", "credit_unit": "model_runway_gen4_5_second",
     "caps": ["t2v", "i2v"], "tier": "models_video:ultra", "by": null, "default": null},
    {"id": "runway-gen4-turbo", "adapter": "video.runway", "vendor_model": "gen4_turbo", "credit_unit": "model_runway_gen4_turbo_second",
     "caps": ["i2v"], "tier": "models_video:premium", "by": null, "default": null}
  ]$json$::jsonb;
  -- Every unit a quote of the nine can read. variant null = the base row (the default variant's figure for a model priced by variant).
  prices constant jsonb := $json$[
    {"unit": "model_ideogram_3_image", "model": "ideogram-3", "variant": null, "usd": 0.03, "credits": 3,
     "note": "0163: Ideogram 3.0 Turbo list US$0.03/image (registry, as_of 2026-11-13, ESTIMATE). Sold 7.5 credits."},
    {"unit": "model_ideogram_4_image", "model": "ideogram-4", "variant": null, "usd": 0.03, "credits": 3,
     "note": "0163: Ideogram 4.0 Turbo 1K list US$0.03/image (registry, as_of 2026-11-13, ESTIMATE). Sold 7.5 credits."},
    {"unit": "model_ideogram_4_5_image", "model": "ideogram-4.5", "variant": null, "usd": 0.06, "credits": 6,
     "note": "0163: base row (lists the model); quotes read the tier rows. = medium, US$0.06/image. Sold 15 credits."},
    {"unit": "model_ideogram_4_5_image_low", "model": "ideogram-4.5", "variant": "low", "usd": 0.03, "credits": 3,
     "note": "0163: Ideogram 4.5 Low list US$0.03/image (registry, as_of 2026-11-13, ESTIMATE). Sold 7.5 credits."},
    {"unit": "model_ideogram_4_5_image_medium", "model": "ideogram-4.5", "variant": "medium", "usd": 0.06, "credits": 6,
     "note": "0163: Ideogram 4.5 Medium list US$0.06/image (registry, as_of 2026-11-13, ESTIMATE). Sold 15 credits."},
    {"unit": "model_ideogram_4_5_image_high", "model": "ideogram-4.5", "variant": "high", "usd": 0.10, "credits": 10,
     "note": "0163: Ideogram 4.5 High list US$0.10/image (registry, as_of 2026-11-13, ESTIMATE). Sold 25 credits."},
    {"unit": "model_minimax_h3_second", "model": "minimax-h3", "variant": null, "usd": 0.08, "credits": 8,
     "note": "0163: base row (lists the model); quotes read the resolution rows. = 768p, US$0.08/s. Sold 20 credits/s."},
    {"unit": "model_minimax_h3_second_768p", "model": "minimax-h3", "variant": "768p", "usd": 0.08, "credits": 8,
     "note": "0163: MiniMax H3 768p list US$0.08 per output second (registry, as_of 2026-11-13, ESTIMATE). Sold 20 credits/s."},
    {"unit": "model_minimax_h3_second_2k", "model": "minimax-h3", "variant": "2k", "usd": 0.13, "credits": 13,
     "note": "0163: MiniMax H3 2K list US$0.13 per output second (registry, as_of 2026-11-13, ESTIMATE). Sold 32.5 credits/s."},
    {"unit": "model_minimax_h3_highspeed_second", "model": "minimax-h3-highspeed", "variant": null, "usd": 0.06, "credits": 6,
     "note": "0163: base row (lists the model); quotes read the resolution rows. = 768p, US$0.06/s. Sold 15 credits/s."},
    {"unit": "model_minimax_h3_highspeed_second_480p", "model": "minimax-h3-highspeed", "variant": "480p", "usd": 0.04, "credits": 4,
     "note": "0163: MiniMax H3 Highspeed 480p list US$0.04 per output second (registry, ESTIMATE). Sold 10 credits/s."},
    {"unit": "model_minimax_h3_highspeed_second_768p", "model": "minimax-h3-highspeed", "variant": "768p", "usd": 0.06, "credits": 6,
     "note": "0163: MiniMax H3 Highspeed 768p list US$0.06 per output second (registry, ESTIMATE). Sold 15 credits/s."},
    {"unit": "model_minimax_h3_lite_second", "model": "minimax-h3-lite", "variant": null, "usd": 0.04, "credits": 4,
     "note": "0163: base row (lists the model); quotes read the resolution rows. = 768p, US$0.04/s. Sold 10 credits/s."},
    {"unit": "model_minimax_h3_lite_second_480p", "model": "minimax-h3-lite", "variant": "480p", "usd": 0.025, "credits": 2.5,
     "note": "0163: MiniMax H3 Lite 480p list US$0.025 per output second (registry, ESTIMATE). Sold 6.25 credits/s."},
    {"unit": "model_minimax_h3_lite_second_768p", "model": "minimax-h3-lite", "variant": "768p", "usd": 0.04, "credits": 4,
     "note": "0163: MiniMax H3 Lite 768p list US$0.04 per output second (registry, ESTIMATE). Sold 10 credits/s."},
    {"unit": "model_minimax_h3_max_second", "model": "minimax-h3-max", "variant": null, "usd": 0.08, "credits": 8,
     "note": "0163: base row (lists the model); quotes read the resolution rows. = 768p, US$0.08/s. Sold 20 credits/s."},
    {"unit": "model_minimax_h3_max_second_480p", "model": "minimax-h3-max", "variant": "480p", "usd": 0.05, "credits": 5,
     "note": "0163: MiniMax H3 Max 480p list US$0.05 per output second (registry, ESTIMATE). Sold 12.5 credits/s."},
    {"unit": "model_minimax_h3_max_second_768p", "model": "minimax-h3-max", "variant": "768p", "usd": 0.08, "credits": 8,
     "note": "0163: MiniMax H3 Max 768p list US$0.08 per output second (registry, ESTIMATE). Sold 20 credits/s."},
    {"unit": "model_runway_gen4_5_second", "model": "runway-gen4.5", "variant": null, "usd": 0.12, "credits": 12,
     "note": "0163: Runway gen4.5 list 12 Runway credits/s at US$0.01 (registry, as_of 2026-11-13). Sold 30 credits/s."},
    {"unit": "model_runway_gen4_turbo_second", "model": "runway-gen4-turbo", "variant": null, "usd": 0.05, "credits": 5,
     "note": "0163: Runway gen4_turbo list 5 Runway credits/s at US$0.01 (registry, as_of 2026-11-13). Sold 12.5 credits/s."}
  ]$json$::jsonb;
  -- The policy margin for image and video (docs/sql/prices_defaults_2026_10_03.sql). Never 0 here: free credits are spent at this rate.
  c_margin constant numeric := 1.5;
  m       jsonb;
  p       jsonb;
  r       public.model_registry;
  cp      public.credit_prices;
  fig     jsonb;
  moved   boolean;
  have    text[];
  want    text[];
  ids     text[];
  sold    numeric;
begin
  select array_agg(x.v ->> 'id') into ids from jsonb_array_elements(models) as x(v);

  -- 1. This file's own arithmetic: a price is the registry figure in cents, nothing rounded down, and every variant has its row.
  for p in select * from jsonb_array_elements(prices) loop
    if (p ->> 'credits')::numeric <> (p ->> 'usd')::numeric * 100 or (p ->> 'credits')::numeric <= 0 then
      raise exception '0163: % is not its vendor figure in cents (% for US$%)', p ->> 'unit', p ->> 'credits', p ->> 'usd';
    end if;
    if not (p ->> 'model' = any (ids)) then
      raise exception '0163: % prices a model this file does not open (%)', p ->> 'unit', p ->> 'model';
    end if;
  end loop;

  -- 2. The registry is what this file was written against, model by model. An empty registry is a fresh deployment (or the security
  --    lab's build): nothing to open and nothing to price, so the file writes nothing at all.
  if not exists (select 1 from public.model_registry) then
    raise notice '0163: model_registry is empty (not synced yet): nothing opened, no price written';
    return;
  end if;
  -- Asked only here: a scratch sequence that leaves 0124 or 0125 out has an empty registry and never reaches this line.
  if to_regprocedure('public.model_past_shutdown(jsonb)') is null or to_regprocedure('public.model_is_available(text)') is null then
    raise exception '0163 needs 0124 (model_is_available) and 0125 (model_past_shutdown): apply them first';
  end if;
  for m in select * from jsonb_array_elements(models) loop
    select * into r from public.model_registry where id = m ->> 'id';
    if not found then
      raise exception '0163: % is not in model_registry: sync the file (Actions -> Probe models) or take it out of this file', m ->> 'id';
    end if;
    if r.adapter <> m ->> 'adapter' or r.spec ->> 'vendor_model' is distinct from m ->> 'vendor_model'
       or r.credit_unit is distinct from m ->> 'credit_unit' then
      raise exception '0163: % now calls % / % (unit %), not what this file priced: re-derive its prices', r.id, r.adapter,
        r.spec ->> 'vendor_model', r.credit_unit;
    end if;
    -- The same capabilities as written (as sets: the file's order is not the point). A capability a re-sync added was never priced
    -- or proven here, and one served by another vendor model (vendor_model_by_capability, which 0035's guard accepts as proof)
    -- would be sold at this file's figure for a different call.
    want := array(select jsonb_array_elements_text(m -> 'caps'));
    if not (r.capabilities @> want and r.capabilities <@ want) then
      raise exception '0163: % now offers %, not the % this file priced: review the new capability before it is opened', r.id,
        r.capabilities, want;
    end if;
    if r.spec ? 'vendor_model_by_capability' then
      raise exception '0163: % calls another vendor model for some capability (spec.vendor_model_by_capability): this file priced one call', r.id;
    end if;
    if r.availability = 'disabled' then
      raise exception '0163: % is disabled (the owner''s off, or removed from the file): this file does not turn it back on', r.id;
    end if;
    if r.verified_at is null or r.verified_probe_id is null then
      raise exception '0163: % has no successful probe of its current call: run Actions -> Probe models for it, then apply', r.id;
    end if;
    if coalesce(r.spec ->> 'terms_gate', '') <> '' then
      raise exception '0163: % is terms-gated (%): its vendor terms are not cleared, so it is not opened', r.id, r.spec ->> 'terms_gate';
    end if;
    if coalesce(nullif(r.spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb then
      raise exception '0163: % carries blocked_countries, which 0142 keeps off sale', r.id;
    end if;
    if public.model_past_shutdown(r.spec) then
      raise exception '0163: % is past its vendor''s announced shutdown date (0125)', r.id;
    end if;
    -- Ideogram's and Runway's terms forbid passing their API to third parties: only the Studio may sell them.
    if coalesce(r.spec ->> 'api_exposure', '') <> 'web_only' then
      raise exception '0163: % is no longer web_only: its API and MCP exposure needs its own review', r.id;
    end if;
    if r.entitlement is not null and r.entitlement <> m ->> 'tier' then
      raise exception '0163: % now needs %, not the % this file read: review it before it is opened', r.id, r.entitlement, m ->> 'tier';
    end if;
    if (r.spec -> 'pricing' -> 'variants' ->> 'by') is distinct from (m ->> 'by') then
      raise exception '0163: % is now priced by %, not by %: re-derive its prices', r.id,
        coalesce(r.spec -> 'pricing' -> 'variants' ->> 'by', 'one flat figure'), coalesce(m ->> 'by', 'one flat figure');
    end if;
    -- The default a quote settles on must be the variant the base row was set to (creative_price: the pinned default_resolution;
    -- medium when no quality is named).
    if m ->> 'by' = 'resolution' and r.spec ->> 'default_resolution' is distinct from m ->> 'default' then
      raise exception '0163: % now pins %, not %: its base row would show another resolution''s price', r.id,
        r.spec ->> 'default_resolution', m ->> 'default';
    end if;
    if m ->> 'by' = 'quality' and not coalesce(r.spec -> 'qualities' @> jsonb_build_array(m ->> 'default'), false) then
      raise exception '0163: % no longer offers the % quality its base row is priced at', r.id, m ->> 'default';
    end if;
    select coalesce(array_agg(k.key order by k.key), '{}') into have
      from jsonb_object_keys(coalesce(r.spec -> 'pricing' -> 'variants' -> 'prices', '{}'::jsonb)) as k(key);
    select coalesce(array_agg(x.v ->> 'variant' order by x.v ->> 'variant'), '{}') into want
      from jsonb_array_elements(prices) as x(v) where x.v ->> 'model' = r.id and x.v ->> 'variant' is not null;
    if have <> want then
      raise exception '0163: % prices the variants %, this file %: re-derive its prices', r.id, have, want;
    end if;
  end loop;
  for p in select * from jsonb_array_elements(prices) loop
    select * into r from public.model_registry where id = p ->> 'model';
    fig := case when p ->> 'variant' is null then r.spec -> 'pricing' -> 'provider_usd_per_unit'
                else r.spec -> 'pricing' -> 'variants' -> 'prices' -> (p ->> 'variant') end;
    -- A figure that is not a JSON number is never cast: the CASE decides the order, not an `and`.
    moved := case when jsonb_typeof(fig) = 'number' then (fig #>> '{}')::numeric <> (p ->> 'usd')::numeric else true end;
    if moved then
      raise exception '0163: the registry''s figure for % is % now, not US$%: re-derive the price', p ->> 'unit', fig, p ->> 'usd';
    end if;
  end loop;

  -- 3. The prices. Never overwrites a row; refuses one that sells below this file's price.
  for p in select * from jsonb_array_elements(prices) loop
    select * into cp from public.credit_prices where unit = p ->> 'unit';
    if not found then
      insert into public.credit_prices (unit, credits_per_unit, margin, note)
      values (p ->> 'unit', (p ->> 'credits')::numeric, c_margin, p ->> 'note');
    else
      sold := cp.credits_per_unit * (1 + cp.margin);
      if sold < (p ->> 'credits')::numeric * (1 + c_margin) then
        raise exception '0163: % already sells at % credits a unit, below this file''s % (US$% x 100 x 2.5): raise that row or delete it, then apply',
          cp.unit, sold, (p ->> 'credits')::numeric * (1 + c_margin), p ->> 'usd';
      elsif cp.credits_per_unit <> (p ->> 'credits')::numeric or cp.margin <> c_margin then
        raise notice '0163: % keeps the price already set (% credits a unit, not below this file''s %)', cp.unit, sold,
          (p ->> 'credits')::numeric * (1 + c_margin);
      end if;
    end if;
  end loop;

  -- 4. On sale. availability beta (the Studio's "Beta"); a model already beta or ga is left as it is. The entitlement the database
  --    and both Studio gates read as open (see the header): the file carries the same NULL, so a sync keeps it.
  update public.model_registry
     set entitlement = null,
         availability = case when availability = 'hidden' then 'beta' else availability end
   where id = any (ids) and (entitlement is not null or availability = 'hidden');

  -- 5. The end state, read back.
  for p in select * from jsonb_array_elements(prices) loop
    select * into cp from public.credit_prices where unit = p ->> 'unit';
    if not found or cp.credits_per_unit * (1 + cp.margin) < (p ->> 'usd')::numeric * 100 * (1 + c_margin) then
      raise exception '0163 end state: % does not sell at 2.5x its vendor figure', p ->> 'unit';
    end if;
  end loop;
  for m in select * from jsonb_array_elements(models) loop
    select * into r from public.model_registry where id = m ->> 'id';
    if r.availability not in ('beta', 'ga') or r.entitlement is not null or r.verified_at is null then
      raise exception '0163 end state: % is not on sale as this file says (availability %, entitlement %)', r.id, r.availability, r.entitlement;
    end if;
    -- Listed by the Studio's catalog (unless the owner's switch has it off, 0124), and never by the API or MCP.
    if public.model_is_available(r.id) and not exists (select 1 from public.sellable_models(null, 'web') s where s.id = r.id) then
      raise exception '0163 end state: % is on sale but sellable_models does not list it', r.id;
    end if;
    if exists (select 1 from public.sellable_models(null, 'api') s where s.id = r.id)
       or exists (select 1 from public.sellable_models(null, 'mcp') s where s.id = r.id) then
      raise exception '0163 end state: % is offered through the API or MCP', r.id;
    end if;
  end loop;
end $$;

-- Nothing terms-gated is on sale, this file or not (0035's CHECK says the same; this reads it back).
do $$
begin
  if exists (select 1 from public.model_registry where availability in ('beta', 'ga') and coalesce(spec ->> 'terms_gate', '') <> '') then
    raise exception '0163 end state: a terms-gated model is on sale';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from public.model_registry
--     where id in ('ideogram-3', 'ideogram-4', 'ideogram-4.5', 'minimax-h3', 'minimax-h3-highspeed', 'minimax-h3-lite', 'minimax-h3-max',
--                  'runway-gen4.5', 'runway-gen4-turbo')
--       and availability in ('beta', 'ga') and entitlement is null) = 9 as nine_on_sale,
--   (select count(*) from public.sellable_models(null, 'web')
--     where id in ('ideogram-3', 'ideogram-4', 'ideogram-4.5', 'minimax-h3', 'minimax-h3-highspeed', 'minimax-h3-lite', 'minimax-h3-max',
--                  'runway-gen4.5', 'runway-gen4-turbo')) = 9 as nine_listed,
--   not exists (select 1 from public.sellable_models(null, 'api')
--                where id like 'ideogram%' or id like 'minimax-h3%' or id like 'runway-gen4%') as not_on_the_api,
--   not exists (select 1 from public.model_registry
--                where availability in ('beta', 'ga') and coalesce(spec ->> 'terms_gate', '') <> '') as nothing_gated_on_sale;
--
-- What each unit sells at (credits a unit, margin folded in), next to the registry's vendor figure:
--   select cp.unit, cp.credits_per_unit * (1 + cp.margin) as sold, cp.note from public.credit_prices cp
--    where cp.note like '0163:%' order by cp.unit;
