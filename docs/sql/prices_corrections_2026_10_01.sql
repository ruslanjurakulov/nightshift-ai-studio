-- Price corrections, 2026-10-01 (Scout). Run AFTER prices_2026_10_01.sql (PR #326).
-- Only rows whose verified provider price differs from the first estimate by more than 10%.
-- credits_per_unit = provider list cost in credits at 1 credit = $0.01. Margins are NOT touched
-- (1.5 packs/tools, 2.0 cheap per-unit, 0.5 video upscale stay as set in prices_2026_10_01.sql).
-- Each update also requires credits_per_unit to still be the old estimate, so a price the owner
-- already set by hand is never overwritten (the 0 rows updated then show in the Verify query).
-- Sources are the vendors' own pages, read 2026-10-01; see the PR for the full table, the rows
-- that are NOT corrected (Seedance 1.0 pro, Ideogram upscale) and what is still unconfirmed.

-- OpenAI GPT Image: output is $30 per 1M image tokens; the studio sends no quality, so the vendor
-- default ("auto") applies. Priced at the worst case, high quality at 1024x1024 = $0.211 (official
-- table), plus up to $0.005 of prompt tokens (4000 chars at $5/M) = $0.216. Medium is $0.053.
update public.credit_prices set credits_per_unit = 21.6,
  note = 'OpenAI list: auto quality priced as high 1024px = $0.211 + prompt <= $0.005. Medium $0.053, low $0.006. Pin quality, then reprice.'
 where unit = 'model_openai_gpt_image_2_image' and credits_per_unit = 25;
update public.credit_prices set credits_per_unit = 21.6,
  note = 'OpenAI list: $30/M image tokens; auto quality priced as max 1024px = $0.211 (calculator formula) + prompt <= $0.005. Medium $0.013, high $0.053.'
 where unit = 'model_openai_gpt_image_2_5_flare_image' and credits_per_unit = 25;
update public.credit_prices set credits_per_unit = 21.6,
  note = 'OpenAI list: $30/M image tokens; auto quality priced as max 1024px = $0.211 (calculator formula) + prompt <= $0.005. Medium $0.013, high $0.053.'
 where unit = 'model_openai_gpt_image_2_5_sunburst_image' and credits_per_unit = 25;

-- Ideogram 4.0 (registry vendor_model TURBO): Turbo $0.03 / Default $0.06 / Quality $0.10 per image.
update public.credit_prices set credits_per_unit = 3,
  note = 'Ideogram 4.0 list: Turbo $0.03 per image (Default $0.06, Quality $0.10).'
 where unit = 'model_ideogram_4_image' and credits_per_unit = 8;

-- Kling (std mode, 720p, no native audio, which is what the adapter sends). 1 unit = $0.14.
update public.credit_prices set credits_per_unit = 4.2,
  note = 'Kling list: v2.6 720p no audio 0.3 units = $0.042/s (1080p $0.07/s). Read from a search extract of the vendor page.'
 where unit = 'model_kling_v2_6_second' and credits_per_unit = 8.4;
update public.credit_prices set credits_per_unit = 8.4,
  note = 'Kling list: v3 720p no native audio 0.6 units = $0.084/s (with audio $0.126/s, 1080p $0.112/s).'
 where unit = 'model_kling_v3_second' and credits_per_unit = 10;

-- Seedance 1.5 pro, 720p 16:9 5 s with audio = $0.26 per video = $0.052/s (silent $0.026/s, 1080p with audio $0.116/s).
update public.credit_prices set credits_per_unit = 5.2,
  note = 'BytePlus list: 1.5 pro 720p with audio $0.26 per 5 s = $0.052/s (silent $0.026/s; 1080p with audio $0.116/s).'
 where unit = 'model_seedance_1_5_pro_second' and credits_per_unit = 10.4;

-- Wan 2.7 (international): 720P $0.10/s, 1080P $0.15/s. The adapter sends 720P unless told otherwise.
update public.credit_prices set credits_per_unit = 10,
  note = 'Alibaba list: wan2.7 international 720P $0.10/s (1080P $0.15/s).'
 where unit = 'model_wan_2_7_second' and credits_per_unit = 15;

-- Describe a picture: tokens priced at $0.75 in / $3.75 out per 1M through 2026-12-31, then $1.50 / $7.50.
-- 1.5K in + 200 out = $0.0019 now, $0.00375 from 2027-01-01. Priced at the 2027 rate; the 1-credit job floor applies anyway.
update public.credit_prices set credits_per_unit = 0.4,
  note = 'Gemini API list: 1.5K in + 200 out tokens = $0.0019 until 2026-12-31, $0.00375 from 2027-01-01 (rates double). Job floor applies.'
 where unit = 'model_gemini_3_6_flash_request' and credits_per_unit = 0.3;

-- Verify (expect 9 rows; a row still showing its old price was set by hand and was left alone):
-- select unit, credits_per_unit, margin, round(credits_per_unit * (1 + margin), 3) as credits_sold, note
--   from public.credit_prices
--  where unit in ('model_openai_gpt_image_2_image','model_openai_gpt_image_2_5_flare_image',
--                 'model_openai_gpt_image_2_5_sunburst_image','model_ideogram_4_image',
--                 'model_kling_v2_6_second','model_kling_v3_second','model_seedance_1_5_pro_second',
--                 'model_wan_2_7_second','model_gemini_3_6_flash_request')
--  order by unit;
