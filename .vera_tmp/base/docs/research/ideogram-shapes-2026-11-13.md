# Ideogram 4.0 and 4.5 shapes, and the prices next to them, 2026-11-13

Status: both adapters send a shape; the quote refuses a shape the model does not list (migration 0155). No vendor API was called and
no key was used: every vendor fact below comes from Ideogram's public developer documentation, fetched with plain `curl` on 2026-11-13.

## The evidence (live jobs, the operator's organization, 2026-11-13)

| Model | Params | Quote / create | Worker |
| :-- | :-- | :-- | :-- |
| `ideogram-4` t2i | `{"aspect_ratio": "16:9"}` | accepted | `bad_request: aspect ratio 16:9 is not offered for t2i by ideogram-4; Ideogram 4.0 aspect ratios are not wired yet` |
| `ideogram-4.5` t2i | `{"aspect_ratio": "16:9"}` | accepted | `bad_request: aspect ratio 16:9 is not offered for t2i by ideogram-4.5; Ideogram 4.5 shapes are not wired: the vendor picks one from the prompt` |
| `ideogram-3` t2i | `{"aspect_ratio": "16:9"}` | accepted | ran |

## Diagnosis

1. **Both registry entries offered no shape** (`aspect_ratios: []`), and both adapters refused any shape on purpose: 4.0's because only
   `text_prompt` and `rendering_speed` had been confirmed (a search extract; the page was unreachable then), 4.5's because its page names
   its size presets only by example.
2. **The database never read the model's list for t2i.** `creative_params_problem` checks that a shape looks like `16:9`, and
   `creative_price` read the model's own list for `expand` (0099) and `video_reframe` (0100) only. The first place that read it for
   `t2i`, `t2v`, `edit` and `i2v` was the worker (`ModelEntry.problems`), after the quote, the job row and the hold (CLAUDE.md #6).
3. **Ideogram 4.0 called a legacy path.** v1's page for `POST /v1/ideogram-v4/generate` now opens "Legacy: use
   `POST /v2/image/generate/ideogram-4` instead".

## What the official pages say (fetched 2026-11-13)

| Page | What it says |
| :-- | :-- |
| Generate with Ideogram 4.0, <https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-4.md> | `POST https://api.ideogram.ai/v2/image/generate/ideogram-4`, `Content-Type: application/json`, header `Api-Key`. Body: `prompt` (required), `magic_prompt`, `seed`, `num_images` (default 1), `resolution` ("Optional. When supplied, the images are generated at this resolution. When omitted, an aspect ratio is picked automatically based on the prompt."), `rendering_speed` (`turbo`, `default`, `quality`; default `default`), `enable_copyright_detection`, `async`, `webhook_url`. Synchronous 200 with `data[]` (`url`, `resolution`, `is_image_safe`, `seed`). Errors: 400, 401, 402 / 429 with `reject_reason`, 422 safety, 500, 503. |
| OpenAPI, <https://developer.ideogram.ai/openapi/ideogram-api-v2.json> | `ResolutionV4`, "The 1K and 2K resolutions supported for Ideogram 4.0 image generation": 38 exact `WIDTHxHEIGHT` values (pinned verbatim in `tests/test_ideogram_shapes.py`). `GenerateImageIdeogramV4RequestRenderingSpeed`: `turbo`, `default`, `quality`. |
| Generate with Ideogram 4.5, <https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-4-5.md> | Multipart. `size`: "auto", "source" or an exact "WIDTHxHEIGHT". "Without source images, an exact size must be one of the supported 1K/2K presets (for example 1024x1024, 2048x2048 or 1440x2880)". "An exact size must have both sides a multiple of 32 and at least 256px, a total of at most 2048x2048 pixels, and an aspect ratio of at most 6:1." "Pricing is tiered by the resolved output pixels: up to 1024x1024 bills as 1K, above that as 2K. An "auto" size bills as 2K." The full 4.5 preset list is not given anywhere in the docs (also asked of the docs' own search, `https://developer.ideogram.ai/_mcp/server`, `searchDocs`: "The documentation does not enumerate every individual preset"). |
| v1 Ideogram 4.0, <https://developer.ideogram.ai/v1/api-reference/generate-images/generate-v4.md> | "Legacy: use `POST /v2/image/generate/ideogram-4` instead." |
| API overview, <https://developer.ideogram.ai/v2/ideogram-api/api-overview.md> | "Moving from v1": `POST /v1/ideogram-v4/generate` -> `POST /v2/image/generate/ideogram-4`; "v1's `text_prompt` is v2's `prompt`". |

## What was built, and why each choice

- **Ideogram 4.0 moves to v2.** JSON body `prompt`, `rendering_speed`, `num_images: 1`, `resolution`. The registry's `vendor_model`
  becomes `turbo` (v2's enum is lower case; v1 took `TURBO`). Changing `vendor_model` clears the model's verification (0035's guard):
  the old probe proved the v1 call, not this one, so `ideogram-4` is hidden until it is probed again.
- **4.0 shapes are 1K sizes from `ResolutionV4`, exact ratios only.** 1:1 1024x1024, 16:9 1280x720, 9:16 720x1280, 4:3 1152x864,
  3:4 864x1152, 3:2 1248x832, 2:3 832x1248, 5:4 1120x896, 4:5 896x1120, 2:1 1440x720, 1:2 720x1440, 3:1 1536x512, 1:3 512x1536,
  16:10 1280x800, 10:16 800x1280. 1K because the owner's price reading for 4.0 (Turbo) names no size and the docs do not say
  whether 2K costs the same: sending 2K could bill more than the quote. `resolution` is always sent (1:1 when the request names none, as
  the Ideogram 3 adapter does), so the vendor never picks a size that might bill as 2K. The 2K-only ratios (23:9, 8:3, 12:5, 22:9) are not
  offered; 21:9 has no exact size at all and is refused, never rounded to 2:1.
- **4.5 shapes are 2K sizes from `ResolutionV4` that meet every rule 4.5 states.** 1:1 2048x2048, 16:9 2560x1440, 9:16 1440x2560,
  4:3 2304x1728, 3:4 1728x2304, 3:2 2496x1664, 2:3 1664x2496, 5:4 2240x1792, 4:5 1792x2240, 2:1 2880x1440, 1:2 1440x2880,
  3:1 3072x1024, 1:3 1024x3072, 16:10 2560x1600, 10:16 1600x2560. Why from that list: it is the only enumerated 1K/2K list Ideogram
  publishes, and it holds all three of 4.5's examples. Why these: both sides multiples of 32 (4.0's 1280x720 is not: 720/32 = 22.5),
  at most 2048x2048 pixels, at most 6:1. Why 2K: the owner's reading gives 4.5 one figure for 1K and 2K, and the vendor's default
  (`auto`, what ran until now) bills as 2K, so the quoted figure is unchanged. A request that names no shape still sends no `size`.
- **The registry lists exactly the adapters' shapes** (`tests/test_ideogram_shapes.py` pins it), and a shape outside them is refused
  by the adapter before anything is sent, by the worker's registry check, and now by the quote (0155).
- **The probes ask for 16:9** (4.0 at Turbo; 4.5 at `low`): the shape that failed live, and for 4.5 the proof that a non-example
  preset is accepted.

## The prices: ideogram-3 quoted 15 per image, ideogram-4.5 high 10. Not a bug in the SQL; a different kind of number

Evidence: the two quotes (`credits_per_unit` 15 with `minimum` 30, and 10), `schemas/model_registry.json`, `docs/sql/prices_2026_10_01.sql`,
`docs/sql/prices_corrections_2026_10_01.sql`, `creative_price` as 0153 left it, `tests/test_price_defaults.py`.

- `creative_price` reads a `credit_prices` row for the unit first; 0139's preview rate (vendor cost converted to credits, no margin)
  is used **only when there is no row** ("A credit_prices row for the tier's unit still wins", 0153's header).
- **ideogram-3 has a row.** `docs/sql/prices_2026_10_01.sql`: `model_ideogram_3_image`, with a margin and a note quoting the
  Ideogram API list price at default speed. The quote's `credits_per_unit` is the rate as charged, `credits_per_unit x (1 + margin)` (0084):
  **15**. That is a sale price with margin, not the vendor's cost.
- **ideogram-4.5 has no row** (`model_ideogram_4_5_image_*` are unpriced on purpose, `tests/test_price_defaults.py`), so 0153's preview
  rate applies: `pricing.variants.prices.high` converted to credits, no margin. That is the vendor's cost, as 0153 intends.
- In cost terms the order is right: 4.5 High costs more than Ideogram 3 Turbo. The comparison set a margin-inclusive sale price
  against a no-margin cost record.
- `minimum` 30 is `credits_round_up(job_minimum)`: the live `job_minimum` row is 30 (the seed file says 1, so it was raised on the
  Credits page). Every one-image quote of either model is floored at it: both settle at 30 credits. The operator's organization is
  credits-exempt, so neither holds anything.
- **One stale figure, left for the owner:** the `model_ideogram_3_image` row's base (the default-speed list price) predates the
  adapter sending `TURBO` (cheaper, per the registry). `docs/sql/prices_corrections_2026_10_01.sql` lowered `model_ideogram_4_image`
  for the same reason, and did not touch Ideogram 3. The row overprices (it never sells below cost), and a price is the owner's
  decision on the Credits page, so this change does not touch it.

## What is not verified

- No call has been made. The probes (`ideogram-4` at 16:9 Turbo, `ideogram-4.5` at 16:9 low) are the first real calls of these bodies.
- That 4.5 accepts these exact 2K presets is read from its rules and the family's list, not seen. A size it refused would return 400
  ("Invalid input provided"; the worker reads it as `bad_request`). The docs do not say in so many words that a 400 is not billed.
- Whether 4.0 bills 2K above Turbo's 1K price: not stated. This is why 4.0 sends 1K. A free check exists: the same request with
  `?dry_run=true` returns Ideogram's own `PriceQuote` (needs the key; not done here).
