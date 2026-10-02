insert into public.credit_prices (unit, credits_per_unit, margin, note) values
  ('job_minimum', 1, 0, 'Smallest hold of any creative job (margin ignored).'),
  ('model_openai_gpt_image_2_image',             25,   1.5, 'OpenAI list: default quality ≈ $0.21–0.25 per 1024px image (token-billed).'),
  ('model_openai_gpt_image_2_5_flare_image',     25,   1.5, 'OpenAI list: same token rate as gpt-image-2; default quality.'),
  ('model_openai_gpt_image_2_5_sunburst_image',  25,   1.5, 'OpenAI list: same token rate as gpt-image-2; default quality.'),
  ('model_gemini_2_5_flash_image_image',         3.9,  1.5, 'Gemini API list: $0.039 per image.'),
  ('model_gemini_3_1_flash_image_image',         6.7,  1.5, 'Gemini API list: $0.067 per 1K image (default size).'),
  ('model_gemini_3_1_flash_lite_image_image',    3.4,  1.5, 'Gemini API list: $0.034 per 1K image.'),
  ('model_gemini_3_pro_image_image',             13.4, 1.5, 'Gemini API list: $0.134 per 1K/2K image.'),
  ('model_flux_2_pro_image',                     3,    1.5, 'BFL list: from $0.03 per MP; our images ≈ 1 MP.'),
  ('model_flux_2_max_image',                     7,    1.5, 'BFL list: from $0.07 per MP.'),
  ('model_flux_2_flex_image',                    6,    1.5, 'BFL list: from $0.06 per MP.'),
  ('model_ideogram_3_image',                     6,    1.5, 'Ideogram API list: $0.06 per image (default speed).'),
  ('model_ideogram_4_image',                     8,    1.5, 'est.: no public figure found; set above 3.0. Review after the first jobs.'),
  ('model_ideogram_upscale_image',               6,    1.5, 'est.: Ideogram upscale ≈ $0.06 per image; 2x = 1 unit, 4x = 4 units.'),
  ('model_veo_3_1_second',                       40,   1.5, 'Gemini API list: $0.40/s at 720p/1080p with audio.'),
  ('model_veo_3_1_fast_second',                  10,   1.5, 'Gemini API list: $0.10/s at 720p.'),
  ('model_veo_3_1_lite_second',                  5,    1.5, 'Gemini API list: $0.05/s at 720p.'),
  ('model_kling_v2_6_second',                    8.4,  1.5, 'est.: Kling std 720p ≈ $0.084/s (search extract, unconfirmed).'),
  ('model_kling_v3_second',                      10,   1.5, 'est.: Kling v3 std ≈ $0.10/s (search extract, unconfirmed).'),
  ('model_minimax_hailuo_2_3_second',            4.7,  1.5, 'MiniMax list: $0.28 per 768p 6 s clip ≈ $0.047/s.'),
  ('model_runway_gen4_5_second',                 12,   1.5, 'Runway list: 12 credits/s at $0.01.'),
  ('model_runway_gen4_turbo_second',             5,    1.5, 'Runway list: 5 credits/s at $0.01.'),
  ('model_luma_ray_3_2_second',                  6,    1.5, 'Luma list: $0.30 per 720p 5 s clip = $0.06/s.'),
  ('model_seedance_1_0_pro_second',              5.4,  1.5, 'est.: $2.50/1M tokens, 720p 24 fps ≈ 21.6K tokens/s ≈ $0.054/s.'),
  ('model_seedance_1_5_pro_second',              10.4, 1.5, 'est.: ModelArk 720p with audio $0.104/s (search extract).'),
  ('model_wan_2_7_second',                       15,   1.5, 'est.: $9/min = $0.15/s (search extract).'),
  ('model_wan_3_0_second',                       10,   1.5, 'Alibaba list: $0.10/s at 720p.'),
  ('model_flux_3_video_second',                  17,   1.5, 'BFL list: from $0.17/s.'),
  ('model_runway_video_upscale_second',          42,   0.5, 'Runway list: $0.007/frame → $0.42/s at 60 fps (base row; targets priced below).'),
  ('model_runway_video_upscale_second_720p',     42,   0.5, 'Runway list: $0.007/frame at 720p → $0.42/s at 60 fps.'),
  ('model_runway_video_upscale_second_1k',       42,   0.5, 'Runway list: $0.007/frame at 1k → $0.42/s at 60 fps.'),
  ('model_runway_video_upscale_second_2k',       54,   0.5, 'Runway list: $0.009/frame at 2k → $0.54/s at 60 fps.'),
  ('model_runway_video_upscale_second_4k',       72,   0.5, 'Runway list: $0.012/frame at 4k → $0.72/s at 60 fps.'),
  ('model_elevenlabs_v4_character',              0.008, 2.0, 'ElevenLabs API list: $0.08 per 1K chars (regular price; promo $0.022 until Oct 12).'),
  ('model_elevenlabs_v3_character',              0.008, 2.0, 'ElevenLabs API list: $0.08 per 1K chars.'),
  ('model_elevenlabs_multilingual_v2_character', 0.008, 2.0, 'ElevenLabs API list: $0.08 per 1K chars.'),
  ('model_elevenlabs_flash_v2_5_character',      0.004, 2.0, 'ElevenLabs API list: $0.04 per 1K chars.'),
  ('model_elevenlabs_sfx_second',                0.2,   2.0, 'ElevenLabs API list: $0.12 per minute.'),
  ('model_elevenlabs_voice_changer_second',      0.2,   2.0, 'ElevenLabs API list: $0.12 per minute of audio.'),
  ('model_elevenlabs_dubbing_v2_second',         3.67,  1.5, 'ElevenLabs API list: $2.20 per minute per language.'),
  ('model_elevenlabs_dubbing_v1_second',         0.84,  1.5, 'ElevenLabs API list: $0.50 per minute (no watermark).'),
  ('model_gemini_3_6_flash_request',             0.3,   2.0, 'est.: ≈1.5K input + 200 output tokens ≈ $0.003 per request; the job floor applies.')
on conflict (unit) do nothing;

with u as (
  select m.id, m.credit_unit as unit from public.model_registry m
  union all
  select m.id, m.credit_unit || '_' || regexp_replace(lower(t), '[^a-z0-9]', '_', 'g')
    from public.model_registry m, jsonb_array_elements_text(m.spec -> 'upscale_targets') t
   where m.spec -> 'pricing' -> 'variants' ->> 'by' = 'upscale_target'
)
select u.id, u.unit,
       coalesce(round(p.credits_per_unit * (1 + p.margin), 3)::text, 'UNPRICED') as credits_per_unit_sold,
       p.margin
  from u left join public.credit_prices p on p.unit = u.unit
 order by u.id, u.unit;
