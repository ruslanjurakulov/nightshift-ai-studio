update public.credit_prices set credits_per_unit = 21.6,
  note = 'OpenAI list: auto quality priced as high 1024px = $0.211 + prompt <= $0.005. Medium $0.053, low $0.006. Pin quality, then reprice.'
 where unit = 'model_openai_gpt_image_2_image' and credits_per_unit = 25;
update public.credit_prices set credits_per_unit = 21.6,
  note = 'OpenAI list: $30/M image tokens; auto quality priced as max 1024px = $0.211 (calculator formula) + prompt <= $0.005. Medium $0.013, high $0.053.'
 where unit = 'model_openai_gpt_image_2_5_flare_image' and credits_per_unit = 25;
update public.credit_prices set credits_per_unit = 21.6,
  note = 'OpenAI list: $30/M image tokens; auto quality priced as max 1024px = $0.211 (calculator formula) + prompt <= $0.005. Medium $0.013, high $0.053.'
 where unit = 'model_openai_gpt_image_2_5_sunburst_image' and credits_per_unit = 25;

update public.credit_prices set credits_per_unit = 3,
  note = 'Ideogram 4.0 list: Turbo $0.03 per image (Default $0.06, Quality $0.10).'
 where unit = 'model_ideogram_4_image' and credits_per_unit = 8;

update public.credit_prices set credits_per_unit = 4.2,
  note = 'Kling list: v2.6 720p no audio 0.3 units = $0.042/s (1080p $0.07/s). Read from a search extract of the vendor page.'
 where unit = 'model_kling_v2_6_second' and credits_per_unit = 8.4;
update public.credit_prices set credits_per_unit = 8.4,
  note = 'Kling list: v3 720p no native audio 0.6 units = $0.084/s (with audio $0.126/s, 1080p $0.112/s).'
 where unit = 'model_kling_v3_second' and credits_per_unit = 10;

update public.credit_prices set credits_per_unit = 5.2,
  note = 'BytePlus list: 1.5 pro 720p with audio $0.26 per 5 s = $0.052/s (silent $0.026/s; 1080p with audio $0.116/s).'
 where unit = 'model_seedance_1_5_pro_second' and credits_per_unit = 10.4;

update public.credit_prices set credits_per_unit = 10,
  note = 'Alibaba list: wan2.7 international 720P $0.10/s (1080P $0.15/s).'
 where unit = 'model_wan_2_7_second' and credits_per_unit = 15;

update public.credit_prices set credits_per_unit = 0.4,
  note = 'Gemini API list: 1.5K in + 200 out tokens = $0.0019 until 2026-12-31, $0.00375 from 2027-01-01 (rates double). Job floor applies.'
 where unit = 'model_gemini_3_6_flash_request' and credits_per_unit = 0.3;
