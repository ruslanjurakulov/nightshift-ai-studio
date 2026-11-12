# Meta Model API, Muse Image: first-party adapter (dark)

Researched 2026-11-12 from Meta's official pages only: the dev.meta.ai docs (each page read as markdown by appending
`.md`), and the legal pages (Terms of Service updated 2026-10-09, Geographic Use Policy updated 2026-10-12). **No
endpoint was called. There is no key yet.**

Where it lives:

| What | Where |
| :-- | :-- |
| Adapter | `modules/capabilities/meta.py` (`image.meta`, `MuseImageAdapter`) |
| Registry entry | `grounded-image-1.0` in `schemas/model_registry.json`. Provider `meta`, vendor model `muse-image-1.0`, terms-gated, no credit price |
| Key | `META_API_KEY`: `deploy/.env.worker.example`, `deploy_web.yml` (`WORKERENV_META_API_KEY`), `probe_models.yml`, `tools/doctor.py`, and the owner's model-keys page |
| Tests | `tests/test_meta_muse_image.py`, `tests/test_vendor_watermarks.py`, the banned-name lists |

**ToS 7** says: "neither we nor you may use any name or mark owned by or associated with the other". So the
registry id and display name are neutral, and every error message has the maker's names replaced before it can reach
a person. "Meta" and "Muse Image" are on the banned lists for public pages and marketing posts
(`command-center/tests/helpers/brands.ts`, `lib/marketing-banned.ts`, `docs/news/banned-claims.json`). Only the owner's
model-keys page names the vendor, because that is where the key is pasted.

## The API, as documented

Sources: `/docs/image-generation`, `/docs/api-reference/responses/schemas`, `/docs/api-reference/images/schemas`,
`/docs/error-handling`, `/docs/pricing-rate-limits`, `/docs/models`, `/docs/authentication`,
`/docs/api-reference/models/list-models`.

**Basics**

- Base URL: `https://api.meta.ai/v1`.
- Auth: `Authorization: Bearer LLM_<id>_<secret>`. Keys are made in the dashboard's API keys tab.
- Model: `muse-image-1.0`. It does text-to-image, editing, multi-image composition and multi-turn refinement. It is
  "agentic": it runs web and image search and code on its own before it renders.

**Two ways in**

- `POST /v1/responses`, the conversational API.
- The OpenAI-compatible `POST /v1/images/generations` and `/v1/images/edits`.

**Why the adapter uses `/v1/responses`**

- The brief requires `store: false`, and `store` is a Responses field ("Whether to persist the generated response...
  default: true").
- The images endpoints do not list `store`, and "an unknown top-level field... returns 400". So `store` cannot be sent
  there.

**Request the adapter sends** (the minimal subset the guide shows working):

```json
{"model": "muse-image-1.0", "store": false,
 "input": "a red fox..." | [{"role": "user", "content": [{"type": "input_text", "text": "..."},
                                                           {"type": "input_image", "image_url": "data:image/png;base64,..."}]}],
 "tools": [{"type": "image_generation", "size": "1024x576"}],
 "safety_identifier": "<opaque end-user id, <= 64 chars>"}
```

- `tools` is sent only when the job names an aspect ratio.
- `size` "sets the aspect ratio, not the exact pixel size". We send the exact ratio, scaled so the long side is at
  least 1024. "Aspect ratios beyond 16:1 return 400", and the adapter refuses them before any call.
- `output_format` is not sent, so the vendor default (webp) applies. The stored type is whatever the bytes say.

**Response the adapter reads**

- From `output[]`, every `image_generation_call` item. Each one carries base64 in `result`.
- `reasoning` and `message` items are ignored.
- A response with `status` `failed`, `cancelled` or `incomplete` is mapped through `error.code`.

**Pictures**

- At most 10 per call, all files from the library (no URLs), PNG, JPEG or WebP by their bytes.
- Each picture is at most 15 MB, so its data URL stays under the 20,971,520-character `image_url` limit.
- All pictures together are at most 36 MB (our bound under the "50 MB inline" limit).
- The "1–10 items" bound is documented for `/v1/images/edits`. The Responses pages state no number. See open
  questions.

**Errors** use an OpenAI-style envelope `{"error": {"type", "code", "param", "message"}}`:

| Answer | Our code |
| :-- | :-- |
| 400 `content_policy_violation` | `policy` |
| 401 `invalid_api_key` / `authentication_error` | `auth` |
| 402 `billing_error` | `quota` |
| 403 | `auth` (the key lacks the model) |
| 404 `model_not_found`, or a 404 with an empty body | `not_found` |
| 413 `payload_too_large`, 415 `unsupported_media_type` | `bad_request` |
| 429 `rate_limit_exceeded` | `rate_limited` |
| 500 and 503 (`service_overloaded`, `backend_unavailable`, `server_shutting_down`) | `unavailable` |

A lost answer (a read timeout, a dropped connection, any 5xx, or a 2xx with no picture) is reported as UNCONFIRMED
SPEND, as for every adapter.

**Price and limits**

- "a flat $0.01 per generated image", with built-in search included.
- "images that fail to generate, or that are removed by safety filtering before they're returned, aren't counted".
- `n` images are billed `n` times. So every picture in an answer is handed back, never only the first.
- Rate limit: 150 requests per minute per team.

**Not wired**

- multi-turn refinement (replaying an `image_generation_call` with `store: false`; jobs have no conversation)
- `previous_response_id` (needs `store: true`)
- the Files API
- `reasoning_strength`
- `tool_enablement`, the per-tool switches
- `n`
- streaming
- background mode
- `output_format`
- the images endpoints

## Terms: what this entry carries

- **Integrated Product, not resale.** ToS 1 allows apps that let End Users use the service. ToS 10.1(i) bars resale,
  any proxy or API gateway, and access "on a standalone basis".
  - The entry is `api_exposure: web_only`, so it is never on the public API.
  - The key is server-side only (ToS 3.1: never shared).
- **18+.** ToS 10.1: "You and your End Users must be at least 18". The sign-up age gate is PR #689. It must be live
  before the terms gate opens.
- **Provenance.** The AUP bars removing or altering "any watermark, label, metadata, or other provenance signal", and
  distributing outputs without them.
  - Nothing is sent that could switch or replace a mark: no such field exists on this call.
  - The picture is stored byte for byte. See `docs/AI_DISCLOSURE.md`, "Vendor watermarks and provenance".
  - The docs do not say whether a watermark or C2PA is applied.
- **Real people.** The AUP bars the "likeness of a real, identifiable person without their consent" and "deepfake"
  depictions.
  - The adapter refuses, before any call, a prompt that matches the keyword screen Character Studio already enforces
    (`modules.character_swap.PROMPT_PATTERNS`, migration 0137).
  - The screen covers real or famous people, deepfakes and lookalikes, and children.
  - It is keyword-weak by design, and reference pictures are not screened.
- **No Meta name or mark.** ToS 7. See the note on ToS 7 at the top.
- **Training.** ToS 10.1(ix): outputs may not train a competing model. ToS 5.1: Meta does not train on Standard
  Services content.

## Geography: the gap

The Geographic Use Policy has two lists:

- 2.2: Muse Image is unavailable in **India**.
- 3: the Restricted Territories are Afghanistan, Belarus, Cambodia, China / Hong Kong / Macau, Cuba, Eritrea,
  Ethiopia, Haiti, Iran, Iraq, Libya, Myanmar, Nicaragua, North Korea, Pakistan, Russia, Somalia, Syria,
  Crimea / Donetsk / Luhansk, Venezuela and Western Sahara.

Uzbekistan is on neither list.

**The repository has no signal of the requester's country**, so nothing can block these countries for this model.
What was checked, all 2026-11-12:

- no GeoIP database or lookup;
- no CDN country header: Caddy sets none and nothing reads `CF-IPCountry` or similar;
- no country on the user, the organization or the billing record. Paddle localises prices in the browser, and
  nothing is stored.

The only "country" fields are the YouTube channel's own `snippet.country`, which says where a channel claims to be,
not where the requester is, and the operator's legal country (`NEXT_PUBLIC_LEGAL_COUNTRY`).

As instructed, no GeoIP was built. The entry stays terms-gated, so it cannot be sold, until a person decides how to
meet 2.2 and 3. Two possible ways:

- a CDN or reverse-proxy country header, checked by the database function that quotes a job;
- a country recorded on the account and checked at quote time.

Either one needs its own PR, and probably a migration.

## Operator-only first run

The owner wants the first real run to be the platform operator making pictures in the site's own image studio, while
the model stays hidden from customers. Migration 0139 (`docs/MIGRATIONS.md`) built that path, and this entry now
carries `"operator_preview": true`:

- **Who.** Only a platform owner or admin, in the operator's own credits-exempt organization. Every other caller is
  answered `model_not_sellable`, as before. The model is not offered through the API, MCP, the Assistant or an
  automatic pick, and `sellable_models` does not list it.
- **Money.** The exempt organization holds and pays nothing. With no `credit_prices` row the job is recorded at the
  vendor's cost ($0.01 an image, an estimate from the vendor's page). The vendor bills the owner's key for every
  picture.
- **Before the first picture.** The entry must be synced and verified by one real probe: Actions, then "Probe
  models", naming `grounded-image-1.0` (one paid call, about $0.01). `--all` skips it because the terms gate is open.
  Until a probe has succeeded the preview is refused like any unverified model.
- **What stays closed.** `availability` is `hidden`, the terms gate is open and there is no credit price: no
  customer can see, quote or run the model. The gate's conditions in `terms_notes` are unchanged.

## Open questions

1. **Responses API vs. the images endpoints.** The adapter uses `/v1/responses` because of `store: false`. The
   Responses reference schema (`/docs/api-reference/responses/schemas`) does not list the `image_generation` tool or
   the `image_generation_call` item. Only the image-generation guide shows them. Confirm with the first probe.
2. How many `input_image` parts the Responses API takes for Muse Image (10 is the images-edit bound).
3. Whether the answer can carry several images for one prompt (nothing sets `n` there), and whether each is billed.
4. The native pixel resolution. It is not documented, so no image size is offered or priced.
5. Whether outputs carry a watermark or C2PA. Nothing is stripped either way.
6. Whether Uzbekistan can sign up and be billed. It is not restricted, but this can only be confirmed by signing up.
7. Should `enable_image_search` be turned off? The model's own image search pulls "reference imagery from the web"
   for real places, products, logos and styles, which may bring in a real likeness or a brand.
8. Geography: see "Geography: the gap" above.
9. The owner-only model-keys page shows "Meta (Model API)". Is naming the vendor to the owner acceptable under ToS 7,
   or should that label be neutral too?
