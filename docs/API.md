# Nightshift public API

The REST API under `/api/v1` lets a customer's own code make videos, follow
them, cross-post them and download them. The human-facing reference is the
public page **/docs/api**; the machine-readable one is
**/docs/api/openapi.json** (OpenAPI 3.1). This file is the design record:
how it is paid for, what protects it, and why.

Migration: `supabase/migrations/0031_public_api.sql` (needs 0017–0030).

## The model: a prepaid developer console

| | |
| :-- | :-- |
| Off by default | An organization that has bought **any** credit pack (a `purchase` row in the credit ledger — the rule `derivePlan` uses), or the operator's own exempt organization, can activate it. An owner/admin clicks **Activate API** in **Developers** and accepts the Terms. Before that no key can be created and no key works (`api_not_activated`). |
| Its own balance | US cents in `api_accounts`, not site credits. Top-ups $5–$5,000 per payment through Paddle; append-only `api_ledger` (topup / hold / usage / release / refund / adjustment). |
| Keys | `nsk_live_` + 43 base62 chars (256 bits). Minted **by the database** (`create_api_key`, 0042), which stores only the SHA-256 — no part of the key (0040 retired the 8-character display prefix 0031 kept) — and returns the key once. A browser cannot register a key or hash it chose. Shown once, in the admin's browser. Listed by name, id, created and last-used time. Max 10 active per organization. Optional monthly spend limit per key. |
| Who a key is | Its creator, inside the key's organization only. If the creator leaves or is no longer owner/admin, the key stops (`key_owner_not_admin`). |

## Pricing (api_prices, editable by a platform owner/admin)

| Unit | Default | Meaning |
| :-- | --: | :-- |
| `video_minute` | 120 ¢ | per minute of **requested** video length |
| `job_minimum` | 60 ¢ | smallest charge of one video |
| `publish` | 0 ¢ | cross-posting is free |
| `download_cents_per_credit` | 1.5 ¢ | HD download = the site's credit price for it × 1.5 ¢ |

The math. The site sells a finished video minute for about 60 credits, and a
credit is about $0.01 retail (Starter: 1,000 credits for $10), so **~$0.60 per
minute retail** against **~$0.20 per minute of cost**. The API charges **2×
site retail: $1.20 per minute** (6× cost), with a $0.60 floor per video so a
30-second Short still covers a run's fixed work. An HD download is priced by
0030's own credit formula (`download_720p_minute` / `download_1080p_minute` /
`download_minimum`) and converted at $0.01 per credit × 1.5 — e.g. a 3:15 video
is 17 credits in 1080p on the site and **26 ¢** through the API.

How money moves:

1. `POST /videos` computes `max(ceil(seconds × 120 / 60), 60)` cents from the
   requested `duration` (or the channel's target length) and **holds** it from
   the available balance, then queues the `render_jobs` row with
   `api_hold_ref`.
2. The worker (`tools/queue_worker.py`) runs an API job only after
   `api_hold_start(ref, job_id)` confirms the hold is open and bound to that
   job — a browser can insert `render_jobs` rows, so the column alone proves
   nothing. It never reserves credits for it.
3. When the job ends, a trigger on `render_jobs` **captures** the hold
   (succeeded) or **releases** it in full (failed / cancelled). Holds that can
   no longer settle (never started or never settled within 24 h, job already
   failed) are released lazily.
4. Downloads reuse 0030's rows, worker and file serving; the hold is captured
   when the file is `ready` and released if it fails. A re-download within 7
   days is free, as on the site.

A job is not linked to the video it produced, so a video is charged the price
quoted for the requested length — never more than the hold.

## Usage tiers (by cumulative paid top-ups, net of refunds)

| Tier | Paid | Requests/min | Videos at once | Monthly cap |
| --: | --: | --: | --: | --: |
| 0 | activated | 10 | 1 | $0 |
| 1 | ≥ $5 | 30 | 2 | $100 |
| 2 | ≥ $50 | 60 | 3 | $500 |
| 3 | ≥ $250 | 120 | 5 | $2,000 |
| 4 | ≥ $1,000 | 300 | 10 | $10,000 |

The exempt operator organization is tier 4, uncapped and never charged. An
organization can set a lower monthly limit; each key can have its own. Spend
this month = captured usage + holds still open. `lib/api/pricing.ts` is the
TypeScript twin of the SQL; `tests/api-pricing.test.ts` pins them together.

## Security

* **No service key in the Command Center** (CLAUDE.md #3). `/api/v1` calls
  0031's `api_*` functions with the **anon** key and no session. Each is
  security definer, takes the key's hash, and starts with `api_begin()`:
  key lookup (one unique-index probe on a SHA-256), revoked/unknown refused,
  activation, tier, per-minute rate limit (`api_rate_counters`, upsert on
  (key, minute)), then acting as the creator and checking they are still an
  owner/admin.
* **Acting as the creator.** `api_act_as()` sets this transaction's JWT claims
  (`sub`, `email`) to the key's creator, leaving `role` as `anon`. That is what
  lets 0029's `publish_requests` insert trigger — editor of the target's
  organization, video in the same organization, publish gate, approvals,
  connected account — run **unchanged**, instead of a second copy of those
  rules that could drift. `requested_by` is the creator, and every action is
  written to `app_audit_log` with the key's id (never any part of the key).
* **Same validation as the site.** `POST /videos` accepts exactly the params
  0019's insert policy lets a browser queue (topic, niche, duration, language,
  visual_style, video_provider, image_provider), checked by the same
  `render_job_params_valid()`; the channel must be in the key's organization and
  ACTIVE. Privacy is never a parameter: runs are private and the channel's own
  publish rules apply.
* **Entry points return, never raise,** so the rate counter's increment and the
  request log commit even for a refused call.
* **Grants.** Entry points: `anon` only. Console functions: `authenticated`.
  `api_add_topup` / `api_refund_topup` / `api_hold_start`: `service_role`.
  Everything else: nobody. The key hash column is readable by no role.
* **Logging.** No part of a key is ever logged, stored or shown after
  creation: server log lines carry the request id, status and error code, and
  the request id finds the key's id in `api_requests`. After `create_api_key`
  returns it to the admin's browser, the key lives only there and in the
  program that holds it.

## Wire format

* `Authorization: Bearer nsk_live_…` on every call.
* Errors: `{"error": {"type", "code", "message", "request_id", …details}}`.
  Types: `invalid_request_error` 400/422, `authentication_error` 401,
  `billing_error` 402, `permission_error` 403, `not_found_error` 404,
  `conflict_error` 409, `idempotency_error`, `rate_limit_error` 429,
  `api_error` 5xx.
* Every response: `x-request-id`; after the key is known,
  `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (seconds);
  429: `Retry-After`.
* `Idempotency-Key` on POST: stored per key for 24 h with a SHA-256 of the
  parsed body; the same key + body replays the first success
  (`idempotent-replayed: true`), a different body is 422, a request still in
  flight is 409. Refusals are not stored, so they can be retried.

## Endpoints

| Method | Path | |
| :-- | :-- | :-- |
| GET | `/me` | organization, tier, limits |
| GET | `/balance` | balance, hold, month spend (cents) |
| GET | `/channels` | channels (ids for POST /videos) |
| GET | `/accounts` | publish targets |
| POST | `/videos` | make a video |
| GET | `/videos` | list videos |
| GET | `/videos/{id}` | one video + its publish requests |
| POST | `/videos/{id}/publish` | cross-post (free) |
| POST | `/videos/{id}/downloads` | order a 720p / 1080p download |
| GET | `/downloads/{id}` | download status |
| GET | `/downloads/{id}/file` | the MP4 |
| GET | `/jobs/{id}` | job status + charge |
| POST | `/creative/quote` | the price of one generation, in credits |
| POST | `/creative/jobs` | start a generation (hold the quote) |
| GET | `/creative/jobs/{id}` | a generation this key started |

`POST /videos` needs `NIGHTSHIFT_RUN_BACKEND=queue` (API jobs are render-queue
jobs); downloads need the host's downloads volume, as on the site.

## Key scopes and per-key limits (migration 0062)

Every key has scopes; `api_begin()` refuses a call outside them with
`403 insufficient_scope` (the body names `required_scope`) after the key and its
creator are checked and before anything is created or charged. The refusal still
counts against the key's rate limit and is logged.

| Scope | Endpoints |
| :-- | :-- |
| `account:read` | `GET /balance`, `/channels`, `/accounts` |
| `videos:read` | `GET /videos`, `/videos/{id}`, `/jobs/{id}`, `/downloads/{id}` (+ `/file`) |
| `videos:write` | `POST /videos`, `/videos/{id}/publish`, `/videos/{id}/downloads` |
| `creative:quote` | `POST /creative/quote` |
| `creative:create` | `POST /creative/jobs` (spends credits) |
| `creative:read` | `GET /creative/jobs/{id}` |

`GET /me` needs no scope (it is how a client reads its own). A key made before
0062 has `scopes = null`, which means the first three and nothing else: it
cannot spend credits on generations until an admin makes a new key (or
`set_api_key_access`) with a creative scope. An endpoint missing from
`api_endpoint_scope()` is closed (`'none'`), so a new endpoint ships closed.
`api_keys.rpm_limit` (1-300) can only **lower** the usage tier's requests per
minute; `api_keys.creative_monthly_credits` caps the credits a key may start
generations for in a calendar month. `lib/api/scopes.ts` is the TypeScript
twin; `tests/api-scopes.test.ts` pins them together.

## Generations (`/creative`, migration 0062)

The Studio's generation, with a key instead of a session. **Paid in the
organization's credits, not the USD API balance**, and the same job: a key's
`POST /creative/jobs` calls 0036's `create_creative_job` (as the key's creator,
so its membership, source-asset and style-kit checks apply as in the browser),
which re-quotes, refuses a price above `max_credits`, holds the quote with
`reserve_credits` and queues the job in one transaction. The worker captures
(`finish_creative_job`) or releases (failure, expiry, lost worker) exactly as
for a Studio job; 0062 moves no credit itself (`tests/test_api_creative_migration.py`
pins that). `tests/security/test_sec_api_creative.py` proves the ledger rows for
an API job equal a Studio job's.

* `Idempotency-Key` header and `max_credits` in the body are **required**. The
  job's own idempotency key is namespaced by the API key (`api-` + SHA-256 of
  `key id:header`), so two keys of one organization never replay or collide.
  The API's own 24-hour record replays the stored answer (`201` +
  `idempotent-replayed`); after it expires the job's own record answers `200`
  with the same job and holds nothing more.
* Body: `capability`, `model`, `params`, optional `mode` (only `exact`),
  `max_credits`. Parsed by the Studio's own `parseGenerationInput`; unknown
  fields (including `org_id` and `idempotency_key`) are refused. **The
  organization is the key's**; no request can name one.
* **Stricter than the web:** the model must be listed by
  `sellable_models(capability, 'api')`. A model whose vendor forbids
  third-party API exposure (`spec.api_exposure = 'web_only'`), or that is
  unverified, terms-gated or unpriced, is `422 model_not_sellable`.
* A key reads only the generations **it** started (`api_creative_jobs`): another
  key's, another organization's, a Studio job and a missing id are all
  `404 job_not_found`. The status shows the job, quoted and charged credits and
  the result (asset ids in the organization's media library); never the worker,
  provider task, route or params. Fetching the files themselves is not part of
  this API yet.
* Refusals hold nothing: `402 insufficient_credits`
  (`available_credits`, `needed_credits`), `402 key_credit_limit_reached`,
  `409 price_changed`, `429 run_limit_reached` (the plan's parallel runs),
  `422 mode_not_supported | unpriced | source_unavailable | style_unavailable`,
  `403 entitlement_required`, `503 registry_missing`. Anything the database
  raises that is not one of these is a structured `500 internal_error`; its text
  never reaches the client, and the job, hold and idempotency record are rolled
  back.
* Without 0062 applied: `503 api_unavailable` naming the migration.

## Developer console (`/{channel}/developers`, owners/admins)

Overview (balance, tier, month-to-date spend, limits) · API keys (create with
scopes, a request limit and a credit ceiling / show once / revoke / per-key
limit) · Usage (requests and spend per day,
per-endpoint breakdown, from `api_requests`, kept ~90 days) · Billing (top-up
with a custom amount, payment history with Paddle invoice links) · Limits
(organization monthly limit).

## Owner setup

See `docs/PADDLE_SETUP.md` → "8. API balansi". In short: apply 0031; create a
Paddle product "Nightshift API balance top-up"; set `PADDLE_API_KEY` (secret)
and `PADDLE_API_TOPUP_PRODUCT_ID` (variable) for the web app, and
`PADDLE_API_TOPUP_PRODUCT_ID` on the `paddle-webhook` Edge Function; redeploy
the function. Adjust prices with `update public.api_prices set cents = … where
unit = 'video_minute'` (platform owner/admin). Correct a balance with
`select public.api_adjust_balance('<org>', <cents>, '<why>')`.

## MCP

The same keys, limits and prices are available to AI assistants through the
remote MCP server at `/api/mcp` — see `docs/MCP.md`.

## CLI and Agent Skills

The same keys, limits and prices are available from a terminal through the
`nightshift` command-line client (`packages/cli`, `docs/CLI.md`), and AI agents
can be taught to use it, or the MCP server, with the Agent Skills in `skills/`.
