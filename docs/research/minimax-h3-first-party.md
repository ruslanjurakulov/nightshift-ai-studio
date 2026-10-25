# MiniMax H3 on MiniMax's own API (first party)

Status: adapter shipped DARK, 2026-10-25. Internal notes. Nothing here makes a model available or for sale.

Four registry entries use MiniMax's own video API V2 (`https://api.minimax.io`, key `MINIMAX_API_KEY`, the same key and base-URL override as the Hailuo adapter):

| Registry id | Vendor model | What it does |
| :-- | :-- | :-- |
| `minimax-h3` | `MiniMax-H3` | t2v, i2v with first and last frame, 768p or 2k, 4-15 s, native stereo audio |
| `minimax-h3-highspeed` | `MiniMax-H3-Highspeed` | same, 768p only |
| `minimax-h3-lite` | `MiniMax-H3-Lite` | same, 480p or 768p, cheapest |
| `minimax-h3-max` | `MiniMax-H3-Max` | same, 480p or 768p, 5-15 s. **Post-trained by fal.ai** (below) |

The adapter is `video.minimax_h3` (`modules/capabilities/minimax.py`). The older `video.minimax` (Hailuo) cannot serve H3: it sends `/v1/video_generation` with a flat `prompt`, H3 is `POST /v2/video_generation` with a `content[]` array.

## Why they are not for sale

Every entry, and now `minimax-hailuo-2.3` too (same account, same Terms), has `terms_gate: terms_review_required` and `api_exposure: web_only`, so `sellable_models()` (migration 0035) never returns it, and no `credit_prices` row exists.

**What the Terms say** (MiniMax Open Platform Terms of Service, Nanonoble Pte Ltd, effective 2026-03-30, `platform.minimax.io/protocol/terms-of-service`, read 2026-10-25 from the page itself):

- User Rights and Obligations 7(c) (the research report labelled it "General Provisions 7(c)"; on the page it sits under the heading "User Rights and Obligations"): you may not "Independently sublicense, resell, or distribute any or all services outside of any integrated applications". Putting generations inside Nightshift's own application is the permitted shape; this is why the gate is not `written_consent_required`.
- But General Provisions item 3: "You agree to use our Service exclusively for your own products or projects", and IP clause 7 bars selling or distributing "any access keys, technical documents, API lists, system usage, applications, developer tools" without MiniMax's permission. The text does not say which of these governs a product that sells generations for credits. **That is the open question, and a clause that needs interpretation is not "clearly satisfied"**, so the gate is `terms_review_required`. Nothing here is legal advice.
- User Rights item 6: you are responsible for all use of the service by end users and must ensure each end user complies; Service item 13: suspend a violating application within 24 hours of a notice.
- IP clause 3: "you retain your ownership rights in Client input and generated content". MiniMax "may use the input and generated content to provide, maintain, develop, and improve" its services (a privacy-notice item for Nightshift's users).
- Under 18: the preamble asks a minor to read the Terms with a guardian and get consent. It binds the account holder; it says nothing about end users.
- No watermark or attribution duty was found.
- **Not read:** the "Service Rules" the Terms incorporate (service usage rules, copyright policy), because no URL for them was found in the text.
- Region: the sanctions clause does not name Uzbekistan; **sign-up and payment from Uzbekistan were not verified.**

The Hailuo 2.3 entry carried "terms could not be read" and an open gate; the Terms are readable, the clause is the same, so it now carries the same notes and the same gate. **This takes `minimax-hailuo-2.3` out of `sellable_models()` once the registry is synced to the database (`tools/probe_models.py --sync`); it has a row in the owner price file (`docs/sql/prices_2026_10_01.sql`) and may be on sale today. Confirm that is wanted before syncing.** Its `api_exposure` is `web_only` for the same reason as the H3 entries: 7(c) is about distributing the service, and a public API that passes it through is that.

### H3 Max and fal.ai

MiniMax's own docs say H3 Max is "jointly released by MiniMax and fal.ai ... a video generation model post-trained by fal.ai on MiniMax H3" (`/docs/guides/video-generation`, `/docs/guides/models-intro`). It is served from MiniMax's API, billed by MiniMax, and covered by MiniMax's Terms. Whether a fal.ai post-train is acceptable is the owner's decision (the "no fal" rule was about the API route). It is registered gated so it can be probed deliberately, and it is not sellable.

## What the adapter does

Sources (`platform.minimax.io`, markdown, read 2026-10-25): `/docs/api-reference/video-generation-v2-{create,query}`, `/docs/guides/{video-generation,models-intro,rate-limits}`, `/docs/pricing/overview`.

- `POST /v2/video_generation` answers `{"task_id"}`; `GET /v2/query/video_generation/{task_id}` answers `{"task": {status, content.url, error}}`, status `queued` / `running` / `succeeded` / `failed` / `cancelled`. Only the last 7 days can be queried; a task outside it is `not_found` (HTTP 400 "invalid task_id"), and the message says a task that finished was billed anyway.
- Resolution and duration are required and sent as given. The vendor's own defaults (Lite and Max: 768P) are never used, because the price is per second of output and differs by resolution. The registry pins `default_resolution` 768p so the database quotes the same tier the adapter sends.
- **2K is labelled `2k`, not `1440p`.** MiniMax prints no pixel size for "2K", so a `1440p` label would state a measurement nobody made. The registry schema's resolution pattern was widened from `^([0-9]{3,4}p|4k)$` to `^([0-9]{3,4}p|[24]k)$` (`2K`, `3k`, `20k` are still refused; a test pins it). The adapter sends `2K` on the wire.
- Text-to-video needs a concrete ratio (the vendor refuses `adaptive`); 16:9 when the job names none. In image-to-video the clip takes the picture's shape, so a job that names a ratio is refused, not ignored. H3 needs words for every mode (the registry treats i2v as wordless; this adapter refuses an empty prompt).
- First and last frame go as `image_url` items with `role` `first_frame` / `last_frame`. At most two pictures are sent, inside the free quota (5 per task; H3 Max 2). Local pictures go inline as data URIs, at most 20 MB each (MiniMax allows 30 MB and a 64 MB body).
- No audio flag exists (H3 always makes a soundtrack and the price does not depend on it), so a job that names one is refused.
- A submit whose answer never came back (timeout, dropped connection, 5xx, an unreadable or id-less 2xx) raises with `not_accepted` False and a message that starts with `UNCONFIRMED SPEND`. The creative worker fails the job without moving it to another model and never submits it again. 401/402/404/429 are proof of refusal (`not_accepted` True).
- Result handling is `modules/capabilities/safe_fetch.py`: https only, no key sent, redirects refused, byte cap, atomic write, mp4 check. **The result host is not named in MiniMax's docs.** Their examples show `video-product.cdn.minimax.io` and `cdn.hailuoai.com`, so the allow-list is the two vendor domains `minimax.io` and `hailuoai.com`. A clip on any other host fails closed after MiniMax said `succeeded`, with `SPEND MAY HAVE OCCURRED` in front; the probe then reports `bad_response` and the host is added in a reviewed change.
- MiniMax does not say whether a failed or moderated task is billed. Every failure message ends with "MiniMax does not say whether a failed task is billed; check its usage page before assuming nothing was spent", and no registry note claims failed tasks are free.
- Not wired: reference-to-video (images, videos, audio), regeneration 768P to 2K, H3-Context-IR, `callback_url`, `extra.prompt_expansion_mode` (Max keeps the vendor default `balanced`), the task list/cancel endpoints. The `end_frame` claim is proven by the probes (all four probe i2v with a drawn first and last frame).
- The caller owns the poll deadline (worker 45 min; probe `--timeout`). A task still queued at the deadline may still run and bill, so the probe reports `timeout` and keeps the task id.

## Prices (all ESTIMATES, `confirmed: false`, as of 2026-10-25)

`platform.minimax.io/docs/pricing/overview`, pay-as-you-go API only (the video packages do not include H3), USD per second of output: H3 2K $0.13, 768P $0.08; Highspeed 768P $0.06; Lite 768P $0.04, 480P $0.025; Max 768P $0.08, 480P $0.05. Input video is billed per second as well and input pictures past the free quota cost $0.02-0.074 each; neither is sent beyond first and last frame. Rate limit (rate-limits page): Video Generation V2 `MiniMax-H3` 300 RPM, 30 tasks in flight; the other variants are not listed, so the registry allows 2 per organization.

`quality_tier` / `speed_tier` are judgement from the research report (H3 4/3, Highspeed 3/4, Lite 3/4, Max 3/4); no benchmark was read.

## To enable one (owner)

1. Decide the resale question in writing: ask MiniMax (`contact.nanonoble@minimax.io`, the Terms' contact address) whether a credits product built on this key is an "integrated application" under 7(c) and "your own product" under item 3; read the Service Rules it points to; decide H3 Max separately.
2. Check Uzbekistan sign-up and payment, set the `MINIMAX_API_KEY` repository secret (never in chat) and a spend cap.
3. `python tools/probe_models.py --dry-run --model minimax-h3-lite`, then the real probe by naming it (`--all` and the probe workflow with an empty model input skip every gated model): Lite 480p 4 s with two frames is about $0.10 (+ nothing for the pictures), H3 768p 4 s about $0.32.
4. Check the real clip host and pixel size of `2k`, re-check the prices, set `confirmed: true`, add the `credit_prices` rows, and clear `terms_gate` in a reviewed change.
