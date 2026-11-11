# Monitoring claims checked against the makers' own pages, 2026-11-10

Status: research plus four registry dates. Internal notes. Nothing here makes a model available or for sale, and no vendor API was called.

Every fact below was read on 2026-11-10 on a page published by the model's maker. Quotes are verbatim. Where a page could not be read, or a fact is not on it, the row says so. Pages rendered by JavaScript were read from the data the site embeds (BytePlus) or from the vendor's own Markdown export (Google `.md`, Ideogram `.md`, Kling `.md`), not from search extracts.

## URGENT

**The daily pipeline's Seedance default is NOT being retired.** `config.SEEDANCE_MODEL` defaults to `seedance-1-0-pro-250528`. BytePlus lists it among the live video models and prices it ($2.5 per 1M tokens); it appears in no deprecation batch. The monitoring note was about a different id.

Three things do need the owner, in this order:

1. **2026-11-11 (today, as this PR opens), 09:00 UTC: `seedance-1-5-pro-251215` stops.** BytePlus: "The seedance-1-5-pro-251215 model will be shut down after 17:00 on November 11, 2026 (UTC+8) and will not be automatically migrated to a new model. Switch models in advance to avoid service disruptions."
   - The pipeline breaks only if the repository variable `SEEDANCE_MODEL` is set to that id. This could not be checked from here (the Actions variables API is not reachable from this session). With the variable empty, the pipeline uses 1.0 Pro and is unaffected.
   - The registry entry `seedance-1.5-pro` has credit prices (migration 0070) and no terms gate, so it can be on sale. It now carries the date. The date is already past on the day this PR opens, so the entry leaves sale and `--all` probing as soon as this is merged and `tools/probe_models.py --sync` has run (the "Probe models" workflow); run it right after merging. Until then the database does not know the date.
   - Replacement BytePlus names: `dreamina-seedance-2-0-mini-260615`. It has no registry entry and no adapter path here, and the Seedance 2.x family is gated (`written_consent_required`). Staying on `seedance-1-0-pro-250528` needs no change.
2. **Already past: the `nano-banana` picture provider's default model.** `modules/image_providers.py` uses `gemini-3.1-flash-image-preview` when `CHRONOS_IMAGE_PROVIDER=nano-banana` and `CHRONOS_IMAGE_MODEL` is empty. Google lists that id under "Deprecated models" with shutdown date June 25, 2026, replacement `gemini-nano-banana-2.1`. Whether the id still answers was not tested (no live calls). It matters only if that provider is selected; the default provider is `pexels`. Options, none applied here: set `CHRONOS_IMAGE_MODEL=gemini-3.1-flash-image` (stable id, "No shutdown date announced", already in the registry), or move to `gemini-nano-banana-2.1` (served in this repository by the Interactions adapter, which the pipeline's client does not use).
3. **2027-02-10: `gpt-image-2` is removed.** It is the `gpt-image` picture provider's default and the registry entry `openai-gpt-image-2`. OpenAI names `gpt-image-2.6-sunburst` or `gpt-image-2.6-flare`.

## Verdicts

| # | Claim | Verdict | Source (read 2026-11-10) | Quote |
| :-- | :-- | :-- | :-- | :-- |
| A1 | Seedance 1.5 Pro (`seedance-1-5-pro-251215`) is retired from the API on 2026-11-11 | TRUE | `docs.byteplus.com/en/docs/ModelArk/1350667` ("Model deprecations", page updated 2026-11-09), "Fourth batch of model deprecations (November 11, 2026)" | "The seedance-1-5-pro-251215 model will be shut down after 17:00 on November 11, 2026 (UTC+8) and will not be automatically migrated to a new model." Table row: `seedance-1-5-pro-251215`, recommended replacement `dreamina-seedance-2-0-mini-260615`, automated replacement "Deactivated". Timetable: first notification September 8, 2026; deprecation September 15, 2026; deactivation November 11, 2026 |
| A2 | `seedance-1-0-pro-250528` has a retirement date | FALSE (none announced) | same page; `.../ModelArk/model-list`; `.../ModelArk/model-pricing` (both updated 2026-11-09) | Not in any batch. Listed in the live video tables, outside the "Retiring models" block ("This model is retiring and will be retired on November 11, 2026." lists only `seedance-1-5-pro-251215` for video). A search summary said the opposite; the page does not |
| A3 | `dreamina-seedance-2-0-260128`, `dreamina-seedance-2-5-260628`, `dola-seedream-5-0-pro-260628`, `dola-seedream-5-0-flash-260915`, `seedream-4-5-251128` have a retirement date | FALSE (none announced) | same three pages | All five are in the live tables and in no batch. The only region note is for other ids: "The following models are deactivated on September 10, 2026 for the eu-west-1 region" (`seed-2-0-mini-260215`, `seedream-5-0-lite-260128`) |
| A4 | Seedance 2.5 costs $10.70 per 1M tokens at 480p/720p, $11.70 at 1080p, no 4K | TRUE | `.../ModelArk/model-pricing`, "Input without video" | Row `dreamina-seedance-2-5-260628`: "$10.70" (480p and 720p), "$11.7" (1080p), "Not supported" (4K). Unit: "Token prices are **USD per million tokens**". With video input the row is "$6.40" and "$7.0" |
| B1 | `gpt-image-2.6-flare` and `gpt-image-2.6-sunburst` exist in the official API, released about 2026-11-04 | TRUE | `developers.openai.com/api/docs/changelog` (entry "Nov 4"); `.../docs/models/gpt-image-2.6-flare`, `.../gpt-image-2.6-sunburst` | "Released GPT-Image-2.6 Sunburst and GPT-Image-2.6 Flare for image generation and editing, with adjustable complexity, SVG generation, and animated GIF generation. Added markup-guided editing for supported GPT Image 2.5 and 2.6 models." |
| B2 | Prices: text input $5, image input $8, image output $30 per 1M tokens | TRUE | `developers.openai.com/api/docs/pricing`; both model pages | Pricing table: `gpt-image-2.6-sunburst`, Image, "$8.00" input, "$30.00" output, "$2.00" cached; Text "$5.00" input, "$1.25" cached. Same row for `gpt-image-2.6-flare` |
| B3 | GIF output, SVG output, region editing | TRUE | `developers.openai.com/api/docs/guides/image-generation` | "Both models support complexity control, markup-guided edits, SVG output, and animated GIF output through the Image API." |
| B4 | Transparent background and 4K sizes for 2.6 | UNCONFIRMED for 2.6 specifically | same guide | The size and background rules are written in the paragraph about the 2.5 pair: "neither edge may exceed 3840 pixels. The total pixel count must be between 655,360 and 8,294,400 (4K). Resolutions above 2560x1440 are experimental." and "For transparent backgrounds with either model, set background: "transparent" and use output_format: "png" or "webp"." The guide does not restate them for 2.6 |
| B5 | The 2.5 ids have a retirement date | FALSE (none announced) | `developers.openai.com/api/docs/deprecations` | Neither 2.5 id is on the page as deprecated. What IS there, dated 2026-11-10: "The gpt-image-2 model and gpt-image-2-2026-04-21 snapshot are deprecated and will be removed from the API on February 10, 2027." Replacement: "gpt-image-2.6-sunburst or gpt-image-2.6-flare" |
| C1 | `POST /v2/image/precise-edit/ideogram-4-5` exists; local edit that keeps the rest | TRUE | `developer.ideogram.ai/api-reference/images/precise-edit/ideogram-4-5` | "Edit an image with Ideogram 4.5 and get the result back at that image's exact width and height." and "pixels the edit did not meaningfully change are copied exactly from it" |
| C2 | Precise Edit prices: Very Low $0.008, Low $0.03, Medium $0.06, High $0.22 per image | TRUE | `ideogram.ai/models/4.5/` and `ideogram.ai/tools/precise-edit/` | "Price per image (USD)": Very low "$0.008", Low "$0.03", Medium "$0.06", High "$0.22". "Each image has a fixed price. It does not change with prompt length, the number of reference images, or the output resolution, and no subscription is required." |
| C3 | "Up to 8K" | TRUE with a limit | precise-edit reference | Input: "max 50MB and 67108864 pixels, which 8192x8192 meets exactly". But "Editing the whole image is bounded by 4194304 pixels (the area of a 2048x2048 square), so a larger image comes back scaled down to fit". Full resolution is kept only with `context_window` over a region of at most 4,194,304 pixels |
| C4 | Ideogram Vector 1.0 API: image-to-SVG $0.10, text-to-SVG $0.13 to $0.20, high quality with reference $0.32 | TRUE | `ideogram.ai/models/vector/`; `developer.ideogram.ai/api-reference/vectors/generate-svg` and `.../vectors/image-to-svg` | "Price per SVG (USD)", text to vector: Low "$0.13" / "$0.13", Medium "$0.16" / "$0.16", High "$0.20" prompt only, "$0.32" with references. "Image to vector Convert an existing image $0.10 / image". The page named in the claim is the documentation page; the endpoints are `POST /v2/svg/generate/ideogram-vector-1` and `POST /v2/svg/vectorize/ideogram-vector-1` |
| D1 | An official Gemini API model "Gemini Omni Flash 1.2" exists, with video and audio and 4K | TRUE | `aistudio.google.com/docs/models/gemini-omni-flash`, `.../docs/pricing`, `.../docs/changelog` (November 5, 2026). `ai.google.dev/gemini-api/docs/...` now redirects there | Model code "`gemini-omni-1.2-flash`". "**Output** Video with native Audio, Text". "**Output video** 3s-15s (360p/720p/1080p/4K, 24 FPS; 3s-10s for first and last frame interpolation and per-turn video extension up to 30s total)". Price: input "$1.50 (text / image / video)", output "$9.00 (text)", "$12.00 (video)" per 1M tokens, paid tier only |
| D2 | There are live Veo ids on the Gemini API | FALSE | `aistudio.google.com/docs/video`; `.../docs/deprecations` (Veo section holds only "Deprecated models") | "The Veo 3.1 Preview in the Gemini API has been shut down." and "Veo 3.1 Preview (`veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, and `veo-3.1-lite-generate-preview`) in the Gemini API was shut down on **October 22, 2026**; migrate to Gemini Omni Flash (`gemini-omni-1.2-flash`) or the GA models available through the Gemini Enterprise Agent Platform" |
| E | "Kling 4.0" and "Kling 4.0 Flash" exist in the official Kling developer API | TRUE | `kling.ai/document-api/updates/api`, `.../api/video/4-0/text-to-video`, `.../api/video/4-0-flash/text-to-video`, `.../pricing/base/video` | 10/28/2026: "Kling 4.0 API Is Now Fully Available, with Native Video Generation up to 30s". 11/04/2026: "Kling 4.0 Flash API Is Now Available, with Native Video Generation up to 20s". Prices: Kling 4.0 "1.0 Unit ($0.157) /s" at 720P, "1.5 Units ($0.235) /s" at 1080P; Kling 4.0 Flash "0.6 Units ($0.094) /s" at 720P (no input video) |
| F | Seedream 5.5 has an official first-party API | UNCONFIRMED | `byteplus.com/en/product/Seedream`; `docs.byteplus.com/.../model-list`, `.../model-pricing`, `.../image-generation-api`; `docs.volcengine.com/docs/ark/model-list` and `.../model-pricing` | The BytePlus product page is titled "Seedream 5.5 Official API \| Start for Free", but its "Try now" link opens `dola-seedream-5-0-pro-260628`, and no Seedream 5.5 model id, price or parameter is on the ModelArk model list, pricing page or image API reference (updated 2026-11-09), nor on the Volcengine Ark model list. Volcengine's document tree holds one entry titled "Seedream 5.5 OCR 支持字体" and nothing else |

## What to build

### GO-DARK (first-party API confirmed, documentation readable)

Dark means what it meant for the earlier adapters: an entry with a terms gate, no credit price, no sale, probed only by name.

**1. OpenAI GPT Image 2.6 (Flare and Sunburst).** Smallest step: the `image.openai` adapter already speaks these endpoints.
- Model ids `gpt-image-2.6-flare`, `gpt-image-2.6-sunburst` (each page lists one snapshot, the same string). Endpoints `POST /v1/images/generations` and `POST /v1/images/edits`. The answer is base64 (`data[0].b64_json`), so there is no result host to allow.
- New request fields:
  - `complexity`: "The supported complexity levels for Sunburst and Flare are low, medium, and high. If you omit complexity, both models use high." "Adjusting complexity has no separate fee."
  - `markup` on `/v1/images/edits` (2.5 and 2.6): a transparent PNG annotation layer the size of the first image. "The first input image and the annotation layer can each contain at most 16,777,216 pixels. The annotation file also has a 50 MB size limit. Do not combine markup with mask."
  - `output_format: "svg"` on generations only: "Set n to 1. SVG output does not support streaming, partial images, or output_compression. The image edit endpoint does not support SVG output". Billing: "you pay the image model's rate for the reference image and the authoring model's rate for the tokens it uses to produce the SVG". The authoring model's rate is not stated, so an SVG has no knowable price before the call.
  - `output_format: "gif"` on both endpoints, with `frame_count` "2–16 frames" (default 9) and `frame_duration_ms` "20–2000 milliseconds per frame, rounded to 10 ms" (default 200). "GIF output does not support streaming, partial images, or custom output_compression."
- Quality: "For GPT Image 2.6 and 2.5 Sunburst and Flare, the quality options are low, medium, high, xhigh, and max." The registry lists low, medium, high for the 2.5 pair.
- Price: token-billed ($5 text in, $8 image in, $30 image out per 1M). There is still no per-image list price; the guide's calculator shows one example (823 output tokens, "$0.02469") without naming its quality and size in the text that could be read.
- Not read: OpenAI's terms for a credits-based product (the existing OpenAI entries carry no gate; nothing new was checked), and whether transparent backgrounds and 4K apply to 2.6 (B4).

**2. Ideogram 4.5 Precise Edit.**
- `POST https://api.ideogram.ai/v2/image/precise-edit/ideogram-4-5`, `multipart/form-data`, header `Api-Key`.
- Fields: `prompt` (required, 1 to 10,000 characters), `image` (required; JPEG, PNG or WEBP, max 50 MB and 67,108,864 pixels), `reference_images` (max 4; max 3 with a mask), `mask` ("Black marks the area to edit and white the area to keep"; same size as the image), `context_window` (`none` default, `auto` with a mask, or `y_min,x_min,y_max,x_max`: at least 256 px a side, aspect between 1:6 and 6:1, at most 4,194,304 pixels), `quality` (`very_low`, `low`, `medium`, `high`; default `medium`; "This is the only field that affects the price"), `seed`, `num_images` (1 to 8), `enable_copyright_detection`, `async`, `webhook_url`.
- Synchronous by default: the answer carries `data[]` with `url`, `prompt`, `resolution`, `seed`, `is_image_safe` ("If false, `url` is empty"). With `async` or `webhook_url` it returns a `generation_id`; poll `GET /v2/generations/{generation_id}` until `status` is `completed` or `failed` (`pending` meanwhile); a 429 on polling carries `Retry-After`. Webhooks are signed with Ed25519 (keys at `https://api.ideogram.ai/v1/.well-known/jwks.json`).
- `?dry_run=true` returns a `PriceQuote`: "nothing is generated, stored, or billed". A builder can pin the price from the vendor without spending.
- Result delivery: a link, and "Image and video links created by the Ideogram API expire." **The documentation does not name the host of result links** (the OpenAPI file lists only `https://api.ideogram.ai` as a server). An allow-list has to be pinned from the first probe and must fail closed until then.
- Limits: "the default rate limit of 10 in-flight requests". Errors: 402 and 429 carry `reject_reason` (`insufficient_funds`, `inflight_limit`, ...); 422 "The prompt did not pass safety checks."
- Billing is prepaid in the API dashboard; "Your balance can't exceed $300" for self-serve.

**3. Ideogram Vector 1.0.**
- Text to SVG: `POST https://api.ideogram.ai/v2/svg/generate/ideogram-vector-1`, multipart, `Api-Key`. Fields: `prompt` (required, up to 9,500 characters), `images` (optional references), `aspect_ratio` (`auto`, `1x1`, `16x9`, `9x16`, ... 18 values), `quality` (`low`, `medium`, `high`; default `medium`), `num_images` (1 to 8), `seed`, `private`, `webhook_url`.
- Image to SVG: `POST https://api.ideogram.ai/v2/svg/vectorize/ideogram-vector-1`. Fields: `image` ("JPEG, PNG or WEBP source; at most 50 MB"), `mode` (`simple`, `detailed`, `auto`).
- Both are always asynchronous: the answer is only `generation_id`. The poll result item has `object_type: svg.generation` with `asset_id`, `width`, `height`, mime type `image/svg+xml` and `url` ("Signed download URL for the original SVG"). Same unnamed result host as above. An SVG is markup: treat it as untrusted before it is shown in a browser.

**Ideogram's Developer API Agreement** (`ideogram.ai/legal/api-tos`, "Last revised: August 14, 2024"; sections 1 to 8 read, section 9 only to its first clause). Not legal advice.
- Use inside an application is the licensed purpose. 2.1: a licence "(a) for its internal use and (b) to develop integrations whereby users of the Developer Application can interface with the Ideogram AI Model from within the Developer Application."
- Nothing read forbids charging the application's users, and nothing permits passing the API on. 2.3.3: "Developer shall not provide the Ideogram API or access to the Ideogram AI Model to any third parties". Selling generations for credits inside our own application fits 2.1(b) on a plain reading; exposing Ideogram through our own public API would not. The existing Ideogram entries are `api_exposure: any`; that deserves a second look against 2.3.3.
- Attribution is a duty. 2.3.1: "identify on the Developer Application that any User Output ... was created by the Ideogram AI Model (e.g., via a “Powered by Ideogram” tagline), and to display the Company's Marks (in a form approved by Company) on each page within the Developer Application where Developer enables access", and link Ideogram's Usage Policies from our own guidelines. The registry already records the tagline.
- Training. 2.2: "the Company agrees that it shall not use any User Input or User Output to train the Ideogram AI Model, except if any such User Input or User Output is flagged as violating the Company's Usage Policies". But 4.3: "Ideogram has the right to use in any manner all User data received by the Company via the Ideogram API."
- No competing use. 2.3.6(A): no using inputs or outputs "to develop any product, service, or technology that competes with the Company". Whether a creative studio that also offers other makers' image models "competes" is a question for the owner's lawyer.
- Ideogram's v2 API also resells other makers' models (GPT Image, Nano Banana, Seedance, MiniMax, Kling, Topaz). Those are not first party and stay out; only `ideogram-*` models qualify.

**4. Gemini Omni 1.2 Flash.** The `video.gemini_omni` adapter already speaks the Interactions API; this is a new entry plus the differences.
- Model id `gemini-omni-1.2-flash`, `POST https://generativelanguage.googleapis.com/v1beta/interactions`, GA on the paid tier ("Free Tier: Not available").
- Differences from 1.1: a real duration setting ("You can set the video `duration` in `response_format` to any whole second from 3 to 15 seconds (for example, `"15s"`). When you don't set the duration, the model defaults to 10 seconds."), "character consistency across up to 6 reference images", video output $12.00 per 1M tokens instead of $17.50. The model page gives 1.2's output as "Video with native Audio, Text" and 1.1's as "Video".
- Price per second, Google's own arithmetic: "approximately $0.07 per second (~$0.70 for a 10s clip, ~$1.04 for a 15s clip; $0.023/s for 360p at 1,931 tokens/s; $0.104/s for 1080p with upsampling at 8,688 tokens/s; and $0.209/s for 4K with upsampling at 17,376 tokens/s)". The 1.1 entry had no price for 360p, 1080p and 4K; 1.2 has all four.
- The gate on the 1.1 entry (Gemini API Additional Terms: 18+, "not for consumer use"; Google APIs Terms 4(a)) applies unchanged. Those terms were not re-read today.

**5. Kling 4.0 and Kling 4.0 Flash.**
- New-style API: the model is in the path, there is no `model_name`. `POST https://api-singapore.klingai.com/text-to-video/kling-4.0` (also `/image-to-video/kling-4.0`, `/omni-video/kling-4.0`, and the same three with `kling-4.0-flash`). Poll `GET /tasks?task_ids=...`; statuses `submitted`, `processing`, `succeeded`, `failed`; result in `data[].outputs[].url` ("Generated results are retained for 30 days").
- Auth is a plain key, not the JWT the current adapter builds: "API Key (for all models) ... Authorization = "Bearer XXX"". The AccessKey/SecretKey JWT is "only applicable to legacy version design standards". The legacy API stays: "The legacy API will continue to be available with no current plans for deprecation." (07/15/2026).
- Body: `prompt` (text to video) or `contents[]` with `type` `prompt`, `first_frame`, `middle_frame`, `last_frame` (image to video); `settings.resolution` (`720p`, `1080p`; Flash `720p` only), `settings.aspect_ratio` (`21:9`, `16:9`, `9:16`, `1:1`), `settings.duration` (3 to 30; Flash 3 to 20; default 10); `options.callback_url`, `options.external_task_id`, `options.watermark_info.enabled`.
- Billing is on `usage.output_duration`, and doubles with a video input: "When input video duration ≤ output video duration: Unit price × Output video duration × 2". No 4K: the 4.0 rows show "-" ("10-bit 4K coming soon").
- Terms of API Paid Service (effective 2026-04-21): the licence is "non-exclusive, non-transferable or sublicensable" (3.3), which is why the existing Kling entries are gated; that stands. New since the registry note: 5.1 "We will not use, or authorize any person or entity to use, your data to train, retrain, or otherwise improve the Services", and 4.1 a service may be ended with "at **least 30 days**" notice.

### WAIT (no first-party API confirmed)

- **Seedream 5.5.** A marketing title, no model id, no price, no parameters (F). Re-check the ModelArk model list; build nothing on a guess of the id.
- **Seedance 2.0 Mini** (`dreamina-seedance-2-0-mini-260615`), BytePlus's replacement for 1.5 Pro. It is documented and priced ($3.5 per 1M tokens, 480p and 720p only), but the Seedance 2.x family needs BytePlus's written authorization (see `seedance-seedream-first-party.md`). Technically ready, commercially waiting.
- **GA Veo.** Google points to the "Gemini Enterprise Agent Platform". That is a different Google API with its own terms and pricing; none of it was read today.

### SKIP

- **GPT Image 2.6 SVG output** as a priced product: the cost depends on an "authoring model" whose rate OpenAI does not state. Ideogram Vector has a fixed per-SVG price; use that if vectors are wanted.
- **Non-Ideogram models through Ideogram's API**, and any other route to a model that is not its maker's own.

## Risk to what runs today

| What uses it | Vendor id | Announced | Replacement the vendor names | Source |
| :-- | :-- | :-- | :-- | :-- |
| Registry `seedance-1.5-pro` (priced, ungated); the pipeline only if `SEEDANCE_MODEL` is set to it | `seedance-1-5-pro-251215` | shut down after 17:00 UTC+8 on 2026-11-11, no automatic migration | `dreamina-seedance-2-0-mini-260615` | BytePlus "Model deprecations" |
| Registry `gemini-omni-1.1-flash` (gated, dark) | `gemini-omni-1.1-flash` | 2026-12-03 | `gemini-omni-1.2-flash` | Google deprecations and pricing pages |
| Registry `openai-gpt-image-2`; pipeline default of the `gpt-image` picture provider | `gpt-image-2`, `gpt-image-2-2026-04-21` | removed 2027-02-10 | `gpt-image-2.6-sunburst` or `gpt-image-2.6-flare` | OpenAI deprecations page, entry dated 2026-11-10 |
| Registry `gemini-2.5-flash-image-expand`, `-relight`, `-erase` | `gemini-2.5-flash-image` | 2027-03-15 (unchanged, already in the registry) | `gemini-3.1-flash-lite-image` | Google deprecations page |
| Registry `veo-3.1`, `veo-3.1-fast`, `veo-3.1-lite` | the three Veo 3.1 previews | 2026-10-22 (unchanged); Google now writes "was shut down" | now `gemini-omni-1.2-flash` (was 1.1) | Google video and deprecations pages |
| Pipeline default of the `nano-banana` picture provider (not a registry entry) | `gemini-3.1-flash-image-preview` | listed as deprecated, shutdown date June 25, 2026 | `gemini-nano-banana-2.1` | Google deprecations page |

Two details that change what a date means:

- **Google does not switch Omni 1.1 off; it swaps it.** "Effective December 3, 2026, all API requests to `gemini-omni-1.1-flash` automatically route to `gemini-omni-1.2-flash` and are billed at `gemini-omni-1.2-flash` rates." A call would keep working with another model at another price, which is exactly the silent substitution CLAUDE.md rule 4 forbids. Ending the sale on that day is the honest reading.
- **Google's dates are "the earliest possible".** "The shutdown dates listed in the table indicate the earliest possible dates on which a model might be retired." BytePlus's and OpenAI's are stated as the day itself.

Checked and clear: `gemini-3.6-flash` (the pipeline's `GEMINI_MODEL` default: "No shutdown date announced"), `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-nano-banana-2.1`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, the Seedance 1.0 / 2.0 / 2.5 and Seedream ids in A2 and A3. Kling publishes no retirement list; its update log holds no retirement notice for `kling-v2-6` or `kling-v3`.

Not checked today: MiniMax, Runway, Luma, Alibaba (Wan, Qwen), Black Forest Labs, Recraft, xAI, ElevenLabs, AssemblyAI, Krea, LTX, Vidu, Pika. No claim was made about them.

## What this change does to the registry

Four dates, each with its page and the day it was read, in the `shutdown` field the Veo entries already use:

| Registry id | `on` | Change |
| :-- | :-- | :-- |
| `seedance-1.5-pro` | 2026-11-11 | new |
| `gemini-omni-1.1-flash` | 2026-12-03 | new |
| `openai-gpt-image-2` | 2027-02-10 | new |
| `veo-3.1`, `veo-3.1-fast`, `veo-3.1-lite` | 2026-10-22 | date unchanged; `replacement` is now `gemini-omni-1.2-flash` and `as_of` 2026-11-10, so the Veo client's stop message no longer points at a model that is itself retiring |

The effect, and its limits:

- From its date (the UTC day, so 00:00 UTC), a model is no longer offered by `sellable_models()` nor quoted by `creative_price()` (migration 0125). For Seedance 1.5 Pro that is nine hours before BytePlus's own cut-off. **The database reads the date from the copy `tools/probe_models.py --sync` writes**; until that has run after this merge, the database does not know it.
- `tools/probe_models.py --all` skips a model past its date and says so (`SKIP <id>: past its announced shutdown date ...`). A probe by name still goes through, which is how one learns whether an id still answers.
- **Only the Veo adapter refuses a past-date id before sending.** The Seedance, OpenAI and Omni adapters have no such check, so a job quoted before the date and carried out after it would still reach the vendor: BytePlus would reject it, Google would serve Omni 1.1 with 1.2. That is unchanged here and is a candidate for a follow-up.
- The daily pipeline does not read these dates. `modules/video_providers.py` consults the registry for Veo only, and `modules/image_providers.py` not at all. No default model, provider or behaviour of the pipeline was changed.

## Not verified

- Whether the repository variables `SEEDANCE_MODEL`, `CHRONOS_IMAGE_PROVIDER` and `CHRONOS_IMAGE_MODEL` are set, and to what.
- Whether any retired id still answers. No vendor was called.
- Ideogram's API price table at `ideogram.ai/pricing/?pricing_tab=api`: it loads its prices with a script that could not be read ("Loading current prices."). The prices in C2 and C4 are from Ideogram's model and tool pages. The agreement names `about.ideogram.ai/api-pricing` as the binding pricing page; that address redirects to the same table.
- The host Ideogram serves result links from.
- For GPT Image 2.6: transparent background, 4K sizes, and the year on the changelog entry (the page prints "Nov 4" between "Nov 5" and "Nov 2").
- OpenAI's, Google's and BytePlus's terms were not re-read today; the notes already in the registry stand as they were.
- Kling 4.0's Omni endpoint, element and voice pages were listed but not read.
