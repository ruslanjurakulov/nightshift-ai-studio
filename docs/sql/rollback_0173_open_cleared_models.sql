-- rollback_0173_open_cleared_models.sql — takes the nine models of migration 0173 off sale again. OWNER-APPLY: paste into the Supabase
-- SQL editor. Nothing in the app runs it.
--
-- WHAT IT DOES, in one transaction:
--   * availability back to `hidden` for the nine (beta or ga). Hidden is what 0139's operator preview needs, so the operator keeps
--     trying them in the credits-exempt organization exactly as before 0173.
--   * entitlement back to the plan tier each one had before 0173 (models_image:basic ...). Note: schemas/model_registry.json carries
--     NULL since 0173, so the next `tools/probe_models.py --sync` writes NULL again. That is harmless while the model is hidden (hidden
--     is never sold); revert the file's entitlements too if you want the two to agree.
--   * deletes ONLY the credit_prices rows 0173 wrote (note starting '0173:') whose rate and margin nobody changed since. A row that
--     existed before 0173, or one the owner edited after it, is left in place: a price on a hidden model sells nothing.
-- It changes no function, policy, grant or constraint. Price deletes are written to credit_price_history by 0107's trigger.
--
-- tests/security/test_sec_open_cleared_models.py applies this file to the lab database and re-applies 0173.

begin;
set local lock_timeout = '5s';

do $$
declare
  tiers constant jsonb := $json${
    "ideogram-3": "models_image:basic", "ideogram-4": "models_image:premium", "ideogram-4.5": "models_image:premium",
    "minimax-h3": "models_video:premium", "minimax-h3-highspeed": "models_video:premium", "minimax-h3-lite": "models_video:basic",
    "minimax-h3-max": "models_video:premium", "runway-gen4.5": "models_video:ultra", "runway-gen4-turbo": "models_video:premium"
  }$json$::jsonb;
  -- unit -> the rate 0173 wrote (margin 1.5 throughout)
  rates constant jsonb := $json${
    "model_ideogram_3_image": 3, "model_ideogram_4_image": 3, "model_ideogram_4_5_image": 6,
    "model_ideogram_4_5_image_low": 3, "model_ideogram_4_5_image_medium": 6, "model_ideogram_4_5_image_high": 10,
    "model_minimax_h3_second": 8, "model_minimax_h3_second_768p": 8, "model_minimax_h3_second_2k": 13,
    "model_minimax_h3_highspeed_second": 6, "model_minimax_h3_highspeed_second_480p": 4, "model_minimax_h3_highspeed_second_768p": 6,
    "model_minimax_h3_lite_second": 4, "model_minimax_h3_lite_second_480p": 2.5, "model_minimax_h3_lite_second_768p": 4,
    "model_minimax_h3_max_second": 8, "model_minimax_h3_max_second_480p": 5, "model_minimax_h3_max_second_768p": 8,
    "model_runway_gen4_5_second": 12, "model_runway_gen4_turbo_second": 5
  }$json$::jsonb;
begin
  update public.model_registry r
     set availability = case when r.availability in ('beta', 'ga') then 'hidden' else r.availability end,
         entitlement = tiers ->> r.id
   where r.id in (select jsonb_object_keys(tiers));

  delete from public.credit_prices cp
   where cp.unit in (select jsonb_object_keys(rates))
     and cp.note like '0173:%'
     and cp.margin = 1.5
     and cp.credits_per_unit = (rates ->> cp.unit)::numeric;

  if exists (select 1 from public.model_registry where id in (select jsonb_object_keys(tiers)) and availability in ('beta', 'ga')) then
    raise exception 'rollback 0173: one of the nine is still on sale';
  end if;
end $$;

commit;

-- Verify (should read true):
--   select not exists (select 1 from public.model_registry
--                       where id in ('ideogram-3', 'ideogram-4', 'ideogram-4.5', 'minimax-h3', 'minimax-h3-highspeed', 'minimax-h3-lite',
--                                    'minimax-h3-max', 'runway-gen4.5', 'runway-gen4-turbo')
--                         and availability in ('beta', 'ga')) as nine_off_sale;
