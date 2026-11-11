# Sonilo on the Sonilo API: music from words, and music scored to a video

Status: adapter shipped DARK and REGISTRY-ONLY, 2026-11-10. Internal notes. Nothing here makes a model available or for sale. No key was used and no generation was made while building this.

| Registry id | Vendor model (endpoint) | Adapter | Key | Gate | Capability | What it does |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `sonilo-music` | `text-to-music` | `audio.sonilo` | `SONILO_API_KEY` | `terms_review_required` | `music` (new) | a track of 10-120 s from a prompt, one MP3 |
| `sonilo-video-music` | `video-to-music` | `audio.sonilo` | `SONILO_API_KEY` | `terms_review_required` | `video_music` (new) | music as long as an uploaded MP4 (6 minutes at most), one MP3; the video is not changed |

Both: `api_exposure: web_only`, no `credit_prices` row, prices dated 2026-11-10 and marked ESTIMATE / `confirmed: false`, `attribution: null`. Both are **registry-only** (see "The schema decision"): they are not copied into the database, `tools/probe_models.py` never probes them (named or not), and no job can name them.

**Sonilo's own API only.** The API is Sonilo Inc.'s (`api.sonilo.com`, documented at `platform.sonilo.com/docs`; the Terms' DMCA address is 125 Willow Road, Suite 200, Menlo Park, CA 94025). Sonilo is also resold by others (Pika's catalogue lists it; ComfyUI, Scenario and WaveSpeed publish Sonilo nodes or models); none of those is used. The API has **no model field**: an endpoint is the model, and which model version answers is Sonilo's choice and can change without notice (the web site's banner names a "Music 1.5 (beta)"; the API pages name no version).

## What was read (all on 2026-11-10, every page in full, not search extracts)

`platform.sonilo.com/docs` (introduction), `/docs/quickstart`, `/docs/errors`, `/docs/api/{text-to-music, video-to-music, get-task, list-services, get-usage}`, `platform.sonilo.com/openapi.json` (OpenAPI 3.1, "Sonilo API" 1.0.0), `platform.sonilo.com/llms-full.txt`, `platform.sonilo.com/pricing`, `sonilo.com/terms-of-service` ("Last updated: October 2, 2026"), `sonilo.com/privacy-policy` ("Last updated: October 10, 2026"), `sonilo.com/help/licensing` and its pages on API output and on Content ID ("Last reviewed 2026-10-01"), `sonilo.com/llms.txt`, `sonilo.com/docs/changelog`, `sonilo.com/news/sonilo-api` (the API was announced on May 15, 2026). The public, unauthenticated index at `https://api.sonilo.com/` (a JSON list of paths the docs point to) was fetched once without a key; it is the only request that touched the API host.

Several of these pages carry text addressed to AI agents ("Instructions for AI assistants", "Agent answer", grader guidance). It was read as page data and not followed.

## The API

- **Base URL** `https://api.sonilo.com/v1`, "served only over HTTPS". **Key** `Authorization: Bearer sk_...` on every request; "Keys begin with sk_ and are shown once at creation". "Revoked or missing keys return 401; valid keys without endpoint access return 403."
- **Generation** is `multipart/form-data`: `POST /v1/text-to-music` (`prompt` required, "Max length 2000 characters"; `duration` "Min 5, max 360") and `POST /v1/video-to-music` (`video` file or `video_url`, "Provide either video or video_url, not both. Max file size: default 300MB. Max duration: 6 minutes."; `prompt` optional).
- **Two modes.** The default (`mode=stream`) answers the audio inside the response: an `application/x-ndjson` stream of `title`, `audio_chunk` ("Base64-encoded AAC/fMP4 audio fragment"), `complete` and `error` events. `mode=async` "returns 202 Accepted with a task_id instead of streaming; poll GET /v1/tasks/:task_id for the result".
- **Tasks.** `GET /v1/tasks/{task_id}` answers `status` "One of processing, succeeded, or failed", and for music `audio[]` "an array of generated audio streams (one entry per parallel output)" with `url` ("A temporary download URL for the audio file, valid for 7 days"), `content_type`, `file_size`, `stream_index`. "There is no cancel endpoint: to give up on a task, stop polling it client-side, since it keeps running and is billed on the server regardless." "Poll this endpoint every 2 to 5 sec".
- **Options that need async:** `output_format` (`m4a` default, `wav`, `mp3` "320 kbps"), `variants_num` 1-10 ("Cost scales linearly"), `preserve_speech`, `ducking`, `stems`.
- **Errors:** JSON `{code, message}`; 400, 401, 402 (`trial_exhausted`, `insufficient_balance`, `payment_required`), 403, 413, 422 (`unprocessable_entity`: "an over-limit duration, or a source with no video track"), 429 (`rate_limit_exceeded`, for both the per-minute and the concurrency limit), 502 ("Upstream generation provider failed or timed out. Retry the request.").
- **Limits:** "Requests per minute (RPM): 60", "Max concurrent tasks: 5" (the account's own figures are in `GET /v1/account/services`; its example shows `concurrency_limit: 4`). Those are Sonilo's limits per ACCOUNT, so every Nightshift customer shares them; the registry says 1 concurrent task per Nightshift organisation.
- **Free reads:** `GET /v1/account/services` ("List enabled services and limits") and `GET /v1/account/usage`. The only DELETE in the OpenAPI document is `/v1/account/keys/self`, which "Revokes the API key presented in the Authorization header".
- "Generated audio carries an inaudible provenance watermark."

Contradictions in Sonilo's own pages, recorded so nobody builds on one side of them:

- The task schema's `status` enum is `processing | succeeded | failed`, but the OpenAPI text of the same route says "Stop on succeeded/completed/failed/canceled". The adapter reads `completed` as `succeeded` and `canceled` / `cancelled` as a failure; any other word is a failure too.
- `available_services` values are written `"video_to_music"` in the example and `"text-to-music"` in the field's description. Nothing here reads the values.
- The introduction says "Max concurrent tasks: 5"; the account example says 4.

## The terms

**Verdict: `terms_review_required`.** Sonilo's own pages say, in plain words, that an application may let its users make and publish API audio commercially, and even name our case. The Terms of Service, which those pages say govern, do not contain that permission and do contain three clauses that can be read against it. A contradiction between a help page and the governing terms is for a person (and a written answer from Sonilo) to settle. Nothing here is legal advice.

What allows it:

- API docs, "Commercial use" (read 2026-11-10): "Audio generated through the Sonilo API can be used commercially — in your own product and by your end users, including ads, client work and monetized channels. The API is billed pay-as-you-go from a prepaid balance on platform.sonilo.com, not through a sonilo.com subscription plan, so no Pro or Premium plan is needed; Enterprise API customers follow their enterprise agreement. For film, TV or broadcast use, or for releasing tracks to Spotify, Apple Music or other streaming services, contact sales first."
- Licensing help, "Can my app's users use audio generated through the Sonilo API commercially?" (last reviewed 2026-10-01): "Your end users. When your users generate audio through your integration, for example by scoring their edits in a video-editing app, they can publish it commercially: paid ads and sponsored posts, client deliverables, and monetized YouTube, TikTok, and Instagram channels." And: "your users do not need a Sonilo account."
- The same page ends: "This page summarises Sonilo's Terms of Service; the Terms govern if anything here differs."

What the Terms of Service (last updated October 2, 2026) say:

- **Commercial rights are granted by plan, and the API is not a plan there.** Section 6.2 "Commercial Use by Plan" lists Free ("personal, experimental, and other non-commercial use only"), Creator, Pro, Premium, Games and Enterprise. Pay-as-you-go API use is not in the list. The help page's permission is therefore not in the document it says it summarises.
- **No competing product.** Section 4: "You may not use the Service or Outputs to build, train, benchmark, or offer a product or service that competes with Sonilo." Section 11 repeats it for AI systems ("develop, train, or improve a competing AI system or service"). Sonilo's own product makes music for a video; a studio that sells music for a video may be read as competing (our reading, not Sonilo's).
- **No resale of rights in the Software, and nothing unlisted without consent.** Section 11: you may not "Assign, sublicense, resell, or otherwise transfer rights in the Software except as expressly authorized by Sonilo"; the licence is "limited, non-exclusive, non-transferable, non-sublicensable". Section 12.2: "Any use of the Service not expressly allowed by these Terms requires our prior written consent and may result in suspension or termination of your access."
- **API Use, section 10:** "You must keep API keys and credentials secure and may not share them except as expressly permitted by Sonilo." "You may not use the API or Service outputs at scale to create datasets, train models, or replicate core Sonilo functionality without our written permission." "You must comply with our API documentation and any additional API terms, policies, or technical requirements we provide." "We may suspend or revoke API access immediately if we believe your use is abusive, insecure, unlawful, or inconsistent with these Terms."
- **Ownership of outputs.** Section 6.1: "As between you and Sonilo, and subject to your compliance with these Terms, applicable law, and any plan-specific restrictions, Sonilo assigns to you any rights we may have in the Outputs generated for your account." Section 8.2: "Output may not be unique, and other users may receive similar or identical results." "Output may not qualify for copyright or other intellectual property protection in all jurisdictions."
- **Sonilo's licence over everything sent and made.** Section 5.2: "you grant Sonilo an irrevocable, non-exclusive, worldwide, perpetual, royalty-free license to host, store, reproduce, modify, adapt, transmit, display, publicly perform, and otherwise use your Inputs". Section 6.3 extends it to all Content (Inputs and Outputs), "sublicensable, and transferable", including to "Train, retrain, fine-tune, test, validate, and improve the Service and related machine learning models, algorithms, and systems ... except to the extent a separate plan, product setting, or written agreement states that particular Content will not be used for such purposes". "You acknowledge that your Content may be used to improve systems that generate outputs for other users".
- **Payments.** Section 9.2: "payments for subscriptions, credits, one-time purchases, promotional offers, and other paid features are final and non-refundable"; credits "are consumed when a generation or other covered action is initiated".
- **Age.** Section 2: "You must be at least 13 years old, or older if the law where you live requires a higher minimum age to use the Service." Section 3.1: "If you are under 18 years old, you may use the Service only with permission from a parent or legal guardian."
- **Free trial.** Section 3.1: "You may not create multiple accounts to avoid limits or obtain additional free usage."
- **Liability, indemnity, forum.** 16.2: total liability "WILL NOT EXCEED THE GREATER OF: (A) THE AMOUNT YOU PAID TO SONILO FOR THE SERVICE IN THE SIX (6) MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM; OR (B) USD $100." 16.3: the customer indemnifies Sonilo for "Your use, publication, distribution, sale, or other exploitation of Outputs". 18: California law. 19: AAA arbitration, class-action waiver; 19.8: claims "within one (1) year after the claim arose".
- **Regions.** No country list. Section 11: "If you access the Service from outside the United States, you are responsible for complying with applicable local laws."

What the Privacy Policy (last updated October 10, 2026) says about training:

- "Sonilo may use uploaded videos, prompts, user instructions, generated outputs, user selections, ratings, edits, reactions, usage/activity data, and related derived data for training, retraining, fine-tuning, testing, evaluation, benchmarking, safety, and general product and model improvement purposes."
- "At present, Sonilo applies this approach by default to all users, and there is no separate opt-out or account-setting control for such use. In addition, the same approach currently applies across beta, free, paid, and all user tiers, unless Sonilo later states otherwise in a separate written agreement or product setting."

So **every customer's video and prompt sent to Sonilo is training material by default, under a perpetual licence, and the API has no way to delete it**. This is the heaviest item for `sonilo-video-music`. A customer must be told and must agree before that is sold; a written agreement with Sonilo is the only way out the Terms name.

YouTube and Content ID (licensing help, last reviewed 2026-10-01):

- "A Content ID claim is still possible. Sonilo says it does not register generated tracks with Content ID, but YouTube also checks uploads against references from other rights holders." "Someone registered a similar generation. Generation is non-exclusive, so another user could receive similar audio."
- Licence certificates are a web-plan feature ("Sonilo's current paid web plans, Pro, Premium and Enterprise, include downloadable license certificates"). "For API output, retain its generation record and applicable API or enterprise terms. Do not describe an API generation as a web-plan generation." So a Nightshift channel that gets a claim has a task id and a date to show, not a certificate.
- Sonilo's own figure, quoted as its claim: "Sonilo reports that none of 2,000 tracks it uploaded to YouTube in September 2026 had received a Content ID claim as of October 2026 ... This is its own reported observation, not a guarantee".
- Royalties: "Sonilo charges by generation through plan credits and takes nothing afterwards: no per-use fees and no royalties on views, sales, or broadcasts."
- Attribution: none for API output in the pages read. The "Music by Sonilo" credit is the Free WEB tier's rule (Terms 6.2). Whether a free TRIAL API call counts as Free-tier, non-commercial output is not stated anywhere read.
- Training data, Sonilo's description: "trained on professionally licensed catalogs, including Shutterstock".
- Not covered by any plan or by the API pages: releasing a track to Spotify, Apple Music or other streaming services; film, TV and broadcast need sales ("contact sales first").

Ask Sonilo (legal@sonilo.com, info@sonilo.com), in writing: (1) does a credits-based video studio that lets its users make music for their videos through the API compete with Sonilo under section 4, and is it a use "expressly allowed" under 12.2; (2) does the API commercial-use statement of the docs bind Sonilo although section 6.2 does not list the API; (3) can training on our customers' videos, prompts and outputs be switched off for our account, and can a task's media be deleted; (4) are there separate API terms.

## What could NOT be read or verified

- **Any separate API terms, API licence or acceptable-use policy.** Section 10 refers to "any additional API terms". `platform.sonilo.com/terms`, `sonilo.com/api-terms` and `sonilo.com/acceptable-use-policy` answer 404; no other address was found.
- **An enterprise agreement** (the only document that can change the training default).
- **Whether Uzbekistan can sign up and pay.** No country list was found. The pricing page shows a Stripe prepaid top-up ("Secured by Stripe"; $20 the smallest preset; "Auto top-up: When your balance falls below $5, automatically add $20"). Sign-up, card acceptance and any KYC from Uzbekistan were verified for nothing.
- **The result host.** The pages say the file is "hosted on Sonilo storage" and print `cdn.example.com` in every example.
- **Whether a result link needs the key** (assumed not: "A temporary download URL"; the key is never sent to it).
- **What a failed generation costs.** The errors page shows one failed task with `"refunded": true`. No page states a rule.
- **How many `audio[]` entries one `variants_num=1` task returns** ("one entry per parallel output"), and whether more than one is billed more than once.
- **Whether `output_format=mp3` changes the price.** No surcharge is named.
- **Which video containers are accepted.** Only MP4 appears in the examples; the adapter sends nothing else.
- **The task id's format** (the example is `9f5f2f7e-...`; the schema says only "string").
- **Rate limits of the account reads**, and how Sonilo words error bodies beyond the examples quoted.
- **Everything about a live call:** nothing was called with a key, so every request shape above is Sonilo's documentation, not an observation.

## What the adapter does (`modules/capabilities/sonilo.py`)

- **Async, not the default stream.** The stream returns the track inside the submit's own response, so a worker that dies mid-stream has paid for a track nobody can fetch again; an async task has an id the worker stores before the first poll, and its file lives 7 days. The price of that choice is the unknown result host (next point).
- **Result host unknown, so none is allowed.** `RESULT_HOSTS` is empty: every `audio[].url` is refused before any request, with the host it names and `SPEND MAY HAVE OCCURRED`. The first real probe ends that way on purpose. A person reads the host, checks it is Sonilo's, pins that EXACT host (never a parent domain other customers' buckets share) and probes again. No code path fetches the first probe's task again, so its spend (or free-trial call) is lost.
- **Key only to the API host.** `Authorization: Bearer` on `api.sonilo.com`; `follow_redirects = False` on every call (pinned in `tests/test_bfl_polling_link.py`); a result download carries no header of ours and follows no redirect.
- **What is priced is sent, never defaulted.** `duration` is required for text-to-music and sent as given (left out, Sonilo infers one from the prompt, "90 sec only when it cannot be"); `variants_num=1`, `mode=async` and `output_format=mp3` are sent on every call. A text-to-music duration under 10 s is refused: "a 4-second text-to-music clip is billed as 10 seconds", so a shorter track would cost more than seconds x rate. A boolean is not a duration.
- **MP3, not the default m4a.** Sonilo's m4a is fragmented MP4; the media library reads an MP4 whose brand is not an audio one as a video, and the job would fail after it was paid for. MP3 is recognised by its first bytes (`ID3`, or an MPEG audio frame), and `safe_fetch` now knows that type: a file that is not one is not stored.
- **A video is uploaded as bytes, never as `video_url`.** A link from a job row is not handed to a vendor to fetch. Before anything is sent the file must be a regular local `.mp4` of at most 300 MB (the size is checked on the open descriptor before the read) whose first bytes are an MP4 `ftyp` box and not an audio-only brand. It is sent as `source.mp4`, not under the uploader's file name.
- **Nothing can be deleted.** The adapter sends no DELETE at all (the API's only one revokes the calling key). A test pins that.
- **Lost answers.** A submit whose answer never came back (a timeout, a dropped connection, any 5xx whatever word its body carries, a 2xx without a usable `task_id`, a body that is not JSON) raises `UNCONFIRMED SPEND` with `not_accepted` False: no retry, no other model. 401 / 402 / 403 / 404 / 429 are proven refusals; 400, 413 and 422 are the vendor's refusal of the request.
- **Task status.** `processing` is pending; `succeeded` (and `completed`) hand back one link; `failed` is typed by `error.code` and carries `SPEND UNKNOWN`, with "refunded" quoted as Sonilo's statement only when the task says it; `canceled` / `cancelled` and every other word (or none) is a failure with the same note, logged and counted, never a task still running.
- **After completion.** A succeeded task without a link, a link off the allowed hosts, a reported `file_size` over 64 MB, a download that fails, redirects, is over the cap or is not an MP3: each starts with `SPEND MAY HAVE OCCURRED`.
- **Task id** must match `^[A-Za-z0-9_-]{1,100}$` before it is put into the poll path (no ".", "/", "?" or ":").
- **`Accept-Encoding: identity`** rides every API call and an answer that comes back with another `Content-Encoding` is not used (at submit: `UNCONFIRMED SPEND`). This refuses the answer; it does not bound memory, because the HTTP library has decoded a non-streamed body before the header is read. The other capability adapters do not send it; the social publishers do.
- **What the probe will print:** the `duration_seconds` and the number of audio streams Sonilo reported, to compare with seconds x the estimate.

Not wired, so nobody can reach them: the stream mode, `video_url`, `segments`, `prompt_influence`, `preserve_speech`, `ducking`, `stems`, more than one variant, WAV and m4a output, video-to-video (a new video with the music mixed in), sound effects, combined sound, audio ducking, video analysis, proofread and dubbing.

## The schema decision

The registry had no capability for music. The smallest extension that lets a music entry exist was two enum values:

- `music`: text → music. Not new to the database's job functions: `creative_capability_supported`, `creative_params_problem` (it is "timed": it needs `duration_s`) and `creative_quantity` have named it since 0036, and `creative_worker.OUTPUT_KIND` maps it to audio. It was never in the registry's capability list.
- `video_music`: a library video → music scored to it (audio out). New everywhere. It joins `VIDEO_INPUT`, so the registry and the bridge treat its one input as a video file, and `PROMPT_OPTIONAL`.

A new capability cannot simply be added to the file, because of how the file reaches the database: `sync_model_registry` is one statement over every row, and migration 0100's `model_registry_capabilities_check` is a closed list. One row with `music` would fail the sync of every model. No migration is added here. Instead:

- `base.REGISTRY_ONLY_CAPABILITIES = {music, video_music}`: the capabilities the database does not list yet.
- `ModelEntry.registry_only` is true for an entry that lists one. `model_registry.sync_rows` leaves such an entry out, so the database never sees it: no row, so no price, no `sellable_models()` result, no job, no probe row.
- The registry refuses a registry-only entry that is not dark by its own fields (`terms_gate` set, `api_exposure: web_only`, price unconfirmed) or that mixes a registry-only capability with one the database knows (the sync would drop both silently).
- `tools/probe_models.py` never probes one, named or not: `record_model_probe` could not store the result, and a probe that is not recorded is money spent for nothing. `--all` reports it with the gated models (`gated <id>`); a named one prints why it is skipped (`skipped <id>` in the public log).
- `tests/test_sonilo.py` reads the newest migration that defines `model_registry_capabilities_check` and requires `CAPABILITIES - REGISTRY_ONLY_CAPABILITIES` to equal its list: the migration that teaches the database a capability is also the change that must take it out of the set.

Consequences: the customer UI does not change (`command-center/lib/models-discovery.ts` mirrors the database's list, not the file's); the only front-end change is the owner-only model-keys card (the keys page must have a card for every registry provider). `creative_adapters.resolve()` answers None for a registry-only id, so even a job row that named one (which the database cannot create) would end as `adapter_missing` before any call.

## To make it live (every place a later change must touch)

Database, one additive migration (REQUIRES 0126; nothing below is in this change):

1. `model_registry_capabilities_check`: add `music` and `video_music`, and raise the cardinality bound (today `between 1 and 19`).
2. `model_probe_runs_capability_check`: the same two words.
3. `sellable_models(p_capability, p_surface)` (newest body: 0125): its `p_capability` allow-list.
4. `creative_capability_supported` (0100): `music` is there; add `video_music`.
5. `creative_params_problem` (newest body: 0126): `music` is already "timed"; `video_music` needs the video-tool branch (the video is the whole input, a prompt of at most 2000 characters is optional, no duration).
6. `creative_source_problem` (0100): a `video_music` source must be an MP4 of at most 360 s and 300 MB.
7. `creative_quantity` / `creative_price` (0126 / 0125): `music` is priced by `duration_s`; `video_music` by the source's seconds, as `video_upscale` is. **Both need Sonilo's 10-second billing floor** (a 4 s video is billed as 10 s).
8. `model_registry_guard` (0100) if a spec field of these entries must reset a proof.
9. The `credit_prices` rows for `model_sonilo_music_second` and `model_sonilo_video_music_second`, and their removal from `UNPRICED_ON_PURPOSE` in `tests/test_price_defaults.py`.

Python:

10. `modules/capabilities/base.py`: empty `REGISTRY_ONLY_CAPABILITIES` (the test in point 5 of the schema decision forces this).
11. `modules/creative_worker.py`: `video_music` in `SOURCE_CAPABILITIES`, `MEDIA_SOURCE_CAPABILITIES`, `VIDEO_SOURCE_CAPABILITIES` and `OUTPUT_KIND` (`music` is in `OUTPUT_KIND` already).
12. `modules/capabilities/sonilo.py`: `RESULT_HOSTS`, after the first probe named the host.
13. `schemas/model_registry.schema.json`: a duration is capped at 120 there; to sell up to Sonilo's 360 s the maximum must rise. `schemas/model_registry.json`: `confirmed: true` and `terms_gate: null` in a reviewed change.

Dashboard:

14. `command-center/lib/models-discovery.ts` (`REGISTRY_CAPABILITIES`, `TASKS`, the per-capability input and source tables, `linkFor`) and `command-center/lib/creative/registry.ts` (`CAPABILITIES`); the Studio composer's tool list; a place in the Editor for the track (the timeline already has a `music` role).
15. `lib/i18n/{en,ru,uz}.ts`: a music task. `tests/models-discovery.test.ts` today asserts that no task label says "music" ("`sfx` makes sound effects (nothing makes music)"): that assertion must change with it.
16. Every state of the Definition of Done for the new tool, and the consent text for sending a video to a vendor that trains on it.
17. If the vendor must never be named on public pages: `command-center/tests/helpers/brands.ts`, `command-center/lib/marketing-banned.ts` and `docs/news/banned-claims.json` do not list "sonilo" today.

18. `tests/test_agent_skills.py` treats every registry `vendor_model` as a name a skill must not contain. `text-to-music` and `video-to-music` are ordinary words: a skill that describes a music tool will trip that test, and the answer then is a decision (rename, or allow the words), not a quiet edit.

Operations and legal:

19. The terms gate (the four questions above), the account (sign-up and payment from Uzbekistan), the secret `SONILO_API_KEY` in GitHub Actions (never in chat), a prepaid balance and a spend cap.
20. Keep each track's generation record (task id, time, account) with the asset: it is what Sonilo says to show in a Content ID dispute.

## Prices (all ESTIMATES, `confirmed: false`)

`platform.sonilo.com/pricing`, read 2026-11-10, each card with "Per-second metering": text-to-music **$0.135 / min ($0.00225 / sec)**, video-to-music **$0.54 / min ($0.009 / sec)**. `llms-full.txt`: "Every generating product has a minimum billable duration (a billing floor)", 10 seconds for both. The account's `discount_factor` ("Multiplier applied to the published per-second cost. 1.0 means no discount") changes it. So a 10 s track is about $0.0225, a 60 s track $0.135, music for a 60 s video $0.54, for a 6-minute video $3.24. "Start with 17 free trials (1-2 per endpoint)": text-to-music "2 calls free, no credit card required", video-to-music "1 call free" (Sonilo's statement). The quality and speed tiers in the registry are placeholders, not a benchmark.

## To enable one (owner)

1. Settle the terms (the four questions), in writing.
2. Create the account, set the repository secret `SONILO_API_KEY`, verify it on the model-keys page (a free account read; nothing is generated).
3. Write and apply the migration (the list above), take the capability out of `REGISTRY_ONLY_CAPABILITIES`.
4. `python tools/probe_models.py --dry-run --model sonilo-music`, then the real probe by name. **The first one is expected to fail** with `SPEND MAY HAVE OCCURRED` and the result host in its message: about $0.02 (a 10 s track) if the free trial call is used up, nothing otherwise by Sonilo's statement. The video probe sends a 2-second test pattern and is billed at the 10 s floor, about $0.09.
5. Pin the exact host in `RESULT_HOSTS`, probe again, compare the reported `duration_seconds` and the usage page with the estimate, then set `confirmed: true`, add the `credit_prices` rows and clear `terms_gate` in a reviewed change.
