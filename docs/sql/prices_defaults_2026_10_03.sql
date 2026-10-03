-- prices_defaults_2026_10_03.sql — starting values for every chargeable unit
-- that has NO credit_prices row after the other price files. OWNER-APPLY: paste
-- into the Supabase SQL editor. Nothing in the app runs it, and the app never
-- writes a price on its own.
--
-- WHY. The Credit prices page showed units without a value: a unit nobody
-- priced is "unpriced" (CLAUDE.md #5), and the feature that needs it is blocked
-- (a model is not sold, a regeneration cannot be pressed). This file gives each
-- of them a starting figure, derived from the vendor list prices already
-- written down in prices_2026_10_01.sql, prices_corrections_2026_10_01.sql and
-- schemas/model_registry.json, so the owner edits a number instead of
-- inventing one.
--
-- APPLY ORDER (all idempotent, none overwrites a price the owner set):
--   1. migrations 0020 .. latest        (the tables and functions)
--   2. docs/sql/prices_2026_10_01.sql
--   3. docs/sql/prices_corrections_2026_10_01.sql
--   4. docs/sql/prices_defaults_2026_10_03.sql      <- this file
-- It is safe to run before 2 and 3 as well: it only inserts units they do not
-- seed, and `on conflict (unit) do nothing` keeps any row that already exists.
--
-- CONVENTION (the one prices_2026_10_01.sql uses). credits_per_unit = the
-- vendor's cost in US cents, so 1 credit = 1 cent of cost ($0.039 per image =
-- 3.9). The customer pays credits_per_unit x (1 + margin): margin 1.5 for
-- image and video, 2.0 for voice and the product-level units. A note that starts
-- 'est.:' is a guess or an assumption the owner should look at; every other note
-- cites a figure that is written down in this repository.
--
-- WHAT THIS FILE PRICES (18 units)
--   Picture quality tiers (0060 sells these three models by tier; the tier row
--   is what a quote reads, the flat row only opens the catalog):
--     model_openai_gpt_image_2_image_{low,medium,high}
--     model_openai_gpt_image_2_5_flare_image_{low,medium,high}
--     model_openai_gpt_image_2_5_sunburst_image_{low,medium,high}
--   Captions:   model_elevenlabs_scribe_v2_second
--   Product:    video_minute, scene_regenerate,
--               scene_regenerate_clip_{kling,veo,seedance,wan},
--               repurpose_clip, reply_draft
--
-- WHAT IT DELIBERATELY LEAVES UNPRICED (never free, never guessed)
--   * scene_regenerate_clip_minimax, scene_regenerate_clip_higgsfield: the
--     default model of each (MiniMax-H3, higgsfield-dop) has no price in this
--     repository, and a clip unit is charged per provider whatever model made
--     the scene. Pricing it at another model's rate would silently
--     undercharge. Set them once the vendor figure is read.
--   * model_seedance_1_5_pro_second_{480p_silent,480p_audio,1080p_silent}: the
--     registry marks those settings "no price read", so they are not sold.
--   * The cost-ledger units (gemini_input_tokens, gemini_output_tokens,
--     tts_characters, render_seconds, pexels_requests, upload_bytes,
--     video_gen_clips, image_generations, vision_calls) and `usd`. Pricing one
--     of them changes how a finished run is settled: with every ledger entry
--     priced the customer is charged the metered sum, with any one unpriced
--     they are charged the hold (video_minute x length). That is a policy
--     decision, not a default; until it is made every run settles at its hold.
--   * job_minimum, download_720p_minute, download_1080p_minute,
--     download_minimum: already seeded (prices_2026_10_01.sql, migration 0030).
--
-- Only inserts into public.credit_prices; no function, policy or grant changes.
-- credit_prices_note_check allows 300 characters per note.

insert into public.credit_prices (unit, credits_per_unit, margin, note) values
  -- Picture quality tiers. OpenAI list: $30 per 1M image output tokens; a
  -- 1024px image is $0.211 at the top setting, $0.053 and $0.006 at the lower
  -- ones (corrections file). +0.5 credit = the same prompt allowance (<= $0.005)
  -- the flat gpt-image-2 row already carries.
  ('model_openai_gpt_image_2_image_low',    1.1,  1.5, 'OpenAI list: gpt-image-2 low 1024px $0.006 + prompt <= $0.005.'),
  ('model_openai_gpt_image_2_image_medium', 5.8,  1.5, 'OpenAI list: gpt-image-2 medium 1024px $0.053 + prompt <= $0.005. The tier a quote uses when none is named.'),
  ('model_openai_gpt_image_2_image_high',   21.6, 1.5, 'OpenAI list: gpt-image-2 high 1024px $0.211 + prompt <= $0.005 (same as the flat row).'),
  -- 2.5 flare / sunburst: the corrections file reads medium $0.013 and high
  -- $0.053 (the $0.211 one is the unlisted max setting). No low figure was read.
  ('model_openai_gpt_image_2_5_flare_image_low',    0.7, 1.5, 'est.: no low-tier figure read. 0.113x the medium image cost (gpt-image-2 low/medium ratio) + prompt <= $0.005.'),
  ('model_openai_gpt_image_2_5_flare_image_medium', 1.8, 1.5, 'OpenAI list: 2.5 medium 1024px $0.013 + prompt <= $0.005.'),
  ('model_openai_gpt_image_2_5_flare_image_high',   5.8, 1.5, 'OpenAI list: 2.5 high 1024px $0.053 + prompt <= $0.005.'),
  ('model_openai_gpt_image_2_5_sunburst_image_low',    0.7, 1.5, 'est.: no low-tier figure read. 0.113x the medium image cost (gpt-image-2 low/medium ratio) + prompt <= $0.005.'),
  ('model_openai_gpt_image_2_5_sunburst_image_medium', 1.8, 1.5, 'OpenAI list: 2.5 medium 1024px $0.013 + prompt <= $0.005.'),
  ('model_openai_gpt_image_2_5_sunburst_image_high',   5.8, 1.5, 'OpenAI list: 2.5 high 1024px $0.053 + prompt <= $0.005.'),

  -- Captions (a transcript of the video's own audio, quantity = seconds of
  -- source). The vendor bills speech-to-text per audio hour by plan and the
  -- registry records no per-second figure, so this is an assumption.
  -- $0.40/h = $0.000111/s = 0.0111 cents/s; rounded up to 0.0112.
  ('model_elevenlabs_scribe_v2_second', 0.0112, 2.0, 'est.: speech-to-text is billed per audio hour by plan, no figure read; assumed $0.40/h = 0.0112 cr/s. Confirm on the vendor plan page.'),

  -- Product-level units. A finished video minute: docs/BILLING_PLANS.md and
  -- docs/API.md say the site sells a minute for about 60 credits and a minute
  -- costs about $0.20 (= 20 credits) to make: 20 x (1 + 2.0) = 60 charged.
  ('video_minute', 20, 2.0, 'Docs: a finished minute costs ~$0.20 (20 cr) and sells for ~60 cr (BILLING_PLANS, API.md): 20 x (1 + 2.0). Run now holds minutes x this.'),

  -- Regenerate scene (0076): price = scene_regenerate + n new clips x
  -- scene_regenerate_clip_<provider>, at least job_minimum.
  ('scene_regenerate', 3, 2.0, 'est.: re-cut and re-encode one video + preview upload, no vendor call; ~15% of the 20-cr cost of a finished minute. Clips are priced by the _clip_ rows.'),
  -- Per generated clip = the provider's default model, 5 s (the scene share the
  -- worker falls back to), silent, 720p, at the list price in the registry and
  -- the corrections file. Longer clips are covered by the margin up to ~2.5x
  -- the assumed length (Veo snaps 5 s to 4 s: 4 x $0.40).
  ('scene_regenerate_clip_kling',    21,  1.5, 'est.: 5 s clip, default Kling v2.6 720p silent $0.042/s (corrections file) = $0.21. Real clips are 5 or 10 s.'),
  ('scene_regenerate_clip_veo',      160, 1.5, 'est.: 4 s clip (a 5 s scene snaps to 4), default Veo 3.1 $0.40/s with audio (registry) = $1.60. Clips are 4, 6 or 8 s.'),
  ('scene_regenerate_clip_seedance', 27,  1.5, 'est.: 5 s clip, default Seedance 1.0 pro 720p ~$0.054/s (est. in prices_2026_10_01.sql) = $0.27.'),
  ('scene_regenerate_clip_wan',      50,  1.5, 'est.: 5 s clip, default Wan 2.7 720p $0.10/s (corrections file) = $0.50. Clips run 2-15 s; a 15 s clip costs more than it charges.'),

  -- Repurpose (0080): one price per clip cut from a master. A clip is one
  -- ffmpeg cut of 15-60 s on the worker with deterministic captions: no model
  -- or vendor call.
  ('repurpose_clip', 2, 2.0, 'est.: one ffmpeg cut of 15-60 s on the worker, captions are deterministic (no model call); ~10% of the 20-cr cost of a finished minute.'),

  -- Comment replies (0081): one drafting-model request per draft, a comment
  -- plus the video title and tone line in, a short reply out: the same request
  -- shape and rate as model_gemini_3_6_flash_request after the correction (0.4
  -- cr = the 2027 rate). The job_minimum floor applies on top.
  ('reply_draft', 0.4, 2.0, 'est.: one drafting request, same shape and rate as model_gemini_3_6_flash_request (1.5K in + 200 out, 0.4 cr at the 2027 rate). job_minimum floors it.')
on conflict (unit) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying). Every column should read as the comment says.
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from public.credit_prices
--     where unit in ('video_minute', 'scene_regenerate', 'repurpose_clip', 'reply_draft',
--                    'scene_regenerate_clip_kling', 'scene_regenerate_clip_veo',
--                    'scene_regenerate_clip_seedance', 'scene_regenerate_clip_wan',
--                    'model_elevenlabs_scribe_v2_second')) as product_and_captions_rows,   -- 9
--   (select count(*) from public.credit_prices
--     where unit ~ '^model_openai_gpt_image_2(_5_(flare|sunburst))?_image_(low|medium|high)$') as quality_tier_rows,   -- 9
--   (select count(*) from public.credit_prices where credits_per_unit <= 0) as nonpositive_rates,   -- 0
--   (select string_agg(unit, ', ' order by unit) from public.credit_prices
--     where note like 'est.:%') as estimates_to_review;
