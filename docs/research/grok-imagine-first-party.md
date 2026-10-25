# Grok Imagine on xAI's own API (first party)

Status: adapters shipped DARK, 2026-10-24. Internal notes. Nothing here makes a model available or for sale.

Three registry entries use xAI's own API (`https://api.x.ai/v1`, key `XAI_API_KEY`):

| Registry id | Vendor model | Adapter | What it does |
| :-- | :-- | :-- | :-- |
| `grok-imagine-video-1.5` | `grok-imagine-video-1.5` | `video.xai` | t2v, i2v, 480p/720p/1080p, 1-15 s, native audio |
| `grok-imagine-video-1.5-lite` | `grok-imagine-video-1.5-lite` | `video.xai` | same, cheapest per second; 1080p is upscaled from 720p |
| `grok-imagine-image-2.0` | `grok-imagine-image-2.0` | `image.xai` | t2i at 1K, quality `low` or `medium` |

## Why they are not for sale

Each entry has `terms_gate: terms_review_required`, so `sellable_models()` (migration 0035) never returns it, and no `credit_prices` row exists.

**The xAI terms were NOT read.** `x.ai/legal`, `x.ai/legal/terms-of-service-enterprise` (the Enterprise Terms of Service), `x.ai/legal/terms-of-service`, `x.ai/legal/enterprise/terms-of-service`, `x.ai/legal/acceptable-use-policy` and `x.ai/legal/usage-policy` answered HTTP 403 (a Cloudflare block page) to every automated fetch on 2026-10-24, by both curl and the web-fetch tool. No attempt was made to get around the block. So nothing is known from the source about:

- resale of generations, or building a service whose end users spend our credits;
- commercial use of Output (YouTube monetisation included) and who owns it under the API terms;
- end-user duties (age, verification, acceptable-use flow-down), AI-content labelling, attribution;
- whether the owner's country and account may use the Imagine API ("model access might vary ... geographical location", pricing page).

Only secondary text exists: a search listing shows the Enterprise Terms of Service were last updated 2026-05-12, and snippets of EARLIER versions say the customer owns Output and may not present it as human-made. That is not the current text and it is silent on resale. The documentation that could be read says: inputs and outputs are stored 30 days for abuse audit and not used for training without permission (`docs.x.ai/developers/faq/security`); a request deemed to violate the usage guidelines is still charged, plus a $0.05 fee when caught before generation in the Responses API (`docs.x.ai/developers/pricing`).

A person must read the Enterprise Terms (and the Data Processing Addendum, which the FAQ points to) before the gate is cleared. Not legal advice.

## What the adapters do

Sources (all `docs.x.ai`, as markdown): `/developers/model-capabilities/video/{generation,overview,image-to-video}`, `/developers/model-capabilities/images/generation`, `/developers/rest-api-reference/inference/{videos,images}`, `/developers/{models,pricing,rate-limits}`, `/developers/migration/imagine-image-quality-nov-2`, `/developers/faq/security`.

- Video: `POST /v1/videos/generations` answers `{"request_id"}`; `GET /v1/videos/{request_id}` answers `pending` / `done` / `failed` / `expired`. `done` carries `video.url` (a temporary link; the docs show `vidgen.x.ai`) and `video.respect_moderation`; false means the link is empty and the pricing page says it is still charged, so it is reported as `policy` with that warning. Resolution and duration are required and sent as given (the vendor defaults are 480p and 8 s). Image-to-video keeps the picture's shape; a ratio for it is refused. `generate_audio` is sent only when the job names it. The opaque per-organization id goes in `user`.
- Image: `POST /v1/images/generations`, synchronous, `response_format: b64_json` (no link fetched). `quality` is always sent (`auto` bills the tier xAI picks; it "currently uses low" for generation). Only `1k` is sent (2K is priced apart and not stated).
- Every policy / moderation refusal (a filtered video, a failed job blocked by moderation, a synchronous HTTP 400) starts with `xAI MAY STILL CHARGE for this refusal (its pricing page: ...)`: a vendor claim, unverified, but never presented as free. Every failure after xAI said `done` (link refused, bad file, download error) starts with `SPEND MAY HAVE OCCURRED: ...`, and a refused download (403, 410, expired link) is `not_found`, never `auth`.
- Result handling is `modules/capabilities/safe_fetch.py`: https only, hosts under `x.ai`, no key sent, redirects refused, byte cap, atomic write, file-type check.
- A submit whose answer never came back (timeout, dropped connection, 5xx, an unreadable 2xx) raises with `not_accepted` False and a message that starts with `UNCONFIRMED SPEND`. The creative worker fails the job without moving it to another model and never submits it again.
- The caller owns the poll deadline (worker 45 min; probe `--timeout`). The video API has no task-expiry parameter (unlike ModelArk), so a job that is still queued at the deadline may still run and bill; the probe reports `timeout` and keeps the request id for that reason.
- Not wired: image editing, multi-image editing, reference-to-video (images and voices), first/last frame and keyframes, video editing and extension, the classic `grok-imagine-video` / `grok-imagine-image` models, 2K images, storage options, batch, deferred image requests. `usage.cost_in_usd_ticks` (the real cost, 10^10 ticks per dollar) is in every answer and is not recorded yet.

## Prices (all ESTIMATES, `confirmed: false`)

`docs.x.ai/developers/models` and `/developers/pricing`, 2026-10-24: 1.5 $0.080/s, 1.5 Lite $0.020/s, image 2.0 $0.04 per image. The overview page says "From $0.08 / sec" and "both duration and resolution affect the total cost" but prints one figure per model, so it is taken as the 480p base and 720p / 1080p are left unpriced. Image: the migration page says `low` is $0.01 cheaper than the retired image-quality model ($0.05), so `low` = $0.04; `medium` and 2K have no stated price. Rate limits are per team and tiered; model pages show 6 requests/s (image) and 10 requests/s (video).

## To enable one (owner)

1. Read the xAI Enterprise Terms and decide whether a credits-based creative platform is allowed; if needed, ask xAI sales (`sales@x.ai`, named in the docs FAQ) in writing.
2. Create a team API key in the xAI console, set the `XAI_API_KEY` repository secret (never in chat), set a spend cap.
3. `python tools/probe_models.py --dry-run --model grok-imagine-video-1.5-lite`, then the real probe (a gated model is probed only when named; `--all` skips it once the probe-gating change in the Seedance PR is on main) (about $0.04 for Lite, $0.16 for 1.5, $0.04 for the image).
4. Re-check the prices on the vendor's pages, set `confirmed: true`, add the `credit_prices` rows, clear `terms_gate` in a reviewed change. The video entries pin `default_resolution` 480p (the vendor default and the price base); the database only prices a video by resolution when that is set, and the adapter refuses a job that names none.
