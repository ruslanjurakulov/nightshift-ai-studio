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
| Keys | `nsk_live_` + 32 random bytes in base62 (43 chars). Generated **in the admin's browser**; only the SHA-256 reaches the database — no part of the key (0040 retired the 8-character display prefix 0031 kept). Shown once, in that browser. Listed by name, id, created and last-used time. Max 10 active per organization. Optional monthly spend limit per key. |
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
  the request id finds the key's id in `api_requests`. The key itself never
  leaves the browser that made it or the program that holds it.

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

`POST /videos` needs `NIGHTSHIFT_RUN_BACKEND=queue` (API jobs are render-queue
jobs); downloads need the host's downloads volume, as on the site.

## Developer console (`/{channel}/developers`, owners/admins)

Overview (balance, tier, month-to-date spend, limits) · API keys (create /
show once / revoke / per-key limit) · Usage (requests and spend per day,
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
