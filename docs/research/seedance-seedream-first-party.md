# Seedance 2.x and Seedream on BytePlus ModelArk (first party)

Status: adapters shipped DARK, 2026-10-24. Internal notes. Nothing here makes a model available or for sale.

Five registry entries use ByteDance's own API through BytePlus ModelArk (international region, `ark.ap-southeast.bytepluses.com`):

| Registry id | Vendor model | Adapter | What it does |
| :-- | :-- | :-- | :-- |
| `seedance-2.0` | `dreamina-seedance-2-0-260128` | `video.seedance2` | t2v, i2v with first and last frame, 480p/720p/1080p, 4-15 s |
| `seedance-2.5` | `dreamina-seedance-2-5-260628` | `video.seedance2` | same, 4-30 s; i2v keeps the picture's own shape |
| `seedream-5.0-pro` | `dola-seedream-5-0-pro-260628` | `image.seedream` | t2i at 1K |
| `seedream-5.0-flash` | `dola-seedream-5-0-flash-260915` | `image.seedream` | t2i at 1K |
| `seedream-4.5` | `seedream-4-5-251128` | `image.seedream` | t2i at 2K |

Seedance 2.5 IS documented by the vendor: the Create-task page says "Dreamina Seedance 2.5 is now fully available" (page updated 2026-10-20). The earlier "disputed" note came from third-party sources.

## Why they are not for sale

Each entry has `terms_gate: written_consent_required`, so `sellable_models()` (migration 0035) never returns it, and no `credit_prices` row exists. Both stay that way until BytePlus agrees in writing. What was read (2026-10-24, `docs.byteplus.com/en/docs/legal/...`):

- **Customer Agreement, effective 2026-09-30, 6.2(1)**: unless BytePlus consents in writing in advance, you may not "hold yourself out as an OEM, SaaS, MaaS provider, service provider, reseller, or distributor of the Services, or engage in any OEM, SaaS, MaaS (or service bureau) ... reseller or other distribution arrangements". Credits-for-generations is such an arrangement. (3.1 does license "End Users", so end-user access is anticipated; the two need BytePlus to reconcile in writing.)
- **Service Specific Terms, Model Services, 4.2 "Platform Customers"** (a customer that integrates the video APIs into its own platform for external enterprises or creators), 4.2.3: you may not "resell or re-integrate the APIs into UGC platforms, including AI content creation tools. If you operate an aggregation platform, end users may only generate video content for their own use; or resell the APIs without our written authorization." The qualifier "without our written authorization" sits on the second bullet. Read plainly, the first bullet needs BytePlus's agreement too. 4.2.2 adds duties (identity verification of end users, incident process, tiered takedowns, rights checks on uploads); 4.2.4(b) sets liquidated damages of 20% of the minimum commitment for unauthorized resale. 4.2 is video-only.
- **Acceptable Use Policy**: no selling or reselling the services; no removing watermarks or identifiers of AI-generated content; no depicting a real person without consent; "provide appropriate notices that ... content is AI generated".
- **General Terms for AI Services, 2.1**: as between you and BytePlus you own the Output to the extent the law allows; BytePlus claims no ownership. 2.4: outputs may not be unique. 2.5: no warranty that output is original or non-infringing. This favours the owner's own channels; it does not touch resale.
- **Availability** (updated 2026-04-21): Uzbekistan is on the list; the Model Services are not available in the United States; final availability is decided at the point of purchase.
- **Seedance 2.x and real people**: reference images or videos with real human faces are rejected (`InputImageSensitiveContentDetected.PrivacyInformation`); BytePlus offers a portrait-asset route (not wired here).

NOT read: any order form or negotiated agreement with BytePlus, the Data Processing Addendum, the Privacy Policy, the "ModelArk AI Playground User Terms". The terms pages are rendered by a JavaScript app; the text above was taken from the page data the site embeds, not from a summary. Not legal advice.

## What the adapters do

Sources: `docs.byteplus.com/en/docs/ModelArk/` pages `1520757` (create task), `get-video-generation-task-api`, `image-generation-api`, `seedance-2-5`, `seedance-2-0`, `model-list`, `model-pricing`, `error-codes`, `seedance-model-activation-usage-and-refund`.

- Video: `POST /api/v3/contents/generations/tasks`, then `GET .../{id}` until `succeeded` (`content.video_url`, valid 24 h) or `failed` / `expired` / `cancelled`. Resolution and duration are required and sent as given (`-1`, "model picks the length", is never sent). `execution_expires_after` is the API's minimum (3600 s), so a task still queued when the worker stops polling (45 min) is ended by the vendor instead of running for its 48 h default. The caller's own deadline is the worker's (45 min) and the probe's (`--timeout`).
- Seedance 2.5 picture-to-video "defaults to and only supports `adaptive`" for the ratio. A job that names a ratio for it is refused before any call.
- Seedream: `POST /api/v3/images/generations`, synchronous, `response_format: b64_json` (no 24 h link). The size is the vendor table's explicit `WIDTHxHEIGHT` for the chosen aspect ratio. 5.0 pro costs $0.045 up to 2.61 MP ("1.5K or lower") and $0.09 above, so only 1K is offered; 4.5 only 2K.
- Result handling (`modules/capabilities/safe_fetch.py`): https only, host allow-list (`volces.com`, `bytepluses.com`; the docs do not name the result host, so a wrong guess fails closed as `bad_response` in the probe), no key sent, redirects refused, byte cap, atomic write, file-type check. Inline images are stored under the type their bytes say.
- A submit whose answer never came back (timeout, dropped connection, 5xx, an unreadable 2xx) raises with `not_accepted` False and a message that starts with `UNCONFIRMED SPEND`. The creative worker then fails the job without moving it to another model, and `submit_started_at` stays set so it is never submitted again.
- Not sent: `watermark` (vendor defaults: Seedance off, Seedream ON "AI-generated"), `service_tier`, `seed`, `draft`, `callback_url`, reference images/videos/audio, 4K, `-fast` / `-mini` models, editing and extension, Seedream editing and layer decomposition.

## Prices (all ESTIMATES, `confirmed: false`)

Source `docs.byteplus.com/en/docs/ModelArk/model-pricing`, 2026-10-24. Video is token-billed; the per-second figures are the vendor's worked example (16:9, 5 s, no video input) divided by 5: Seedance 2.0 $0.07 / $0.152 / $0.374 at 480p / 720p / 1080p; 2.5 $0.103 / $0.231 / $0.569. Other ratios differ slightly. Failed generations are not billed. Images per image: 5.0 pro $0.045, 5.0 flash $0.018, 4.5 $0.04.

## To enable one (owner)

1. Get BytePlus's written authorization for a credits-based creative platform (video: Model Services 4.2; all: Customer Agreement 6.2(1)). Without it, do not continue.
2. Activate the model in the ModelArk console (the Seedance 2.x models need a balance above USD 30 or a resource pack) and set `SEEDANCE_API_KEY` on the worker.
3. `python tools/probe_models.py --dry-run --model seedance-2.0`, then the real probe (about $0.28 for 2.0 and $0.41 for 2.5; about $0.045 / $0.018 / $0.04 for the images).
4. Re-check the price on the vendor's page, set `confirmed: true`, add the `credit_prices` rows, clear `terms_gate` in a reviewed change.
