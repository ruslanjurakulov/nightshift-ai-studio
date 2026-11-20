# Owner analytics hub

`/{channel}/owner-analytics` — revenue, people, usage and retention for the **platform owner** (not an admin), measured from the
platform's own records. Reads: migration 0182 (`supabase/migrations/0182_owner_analytics.sql`). Code: `lib/owner-analytics/*`
(pure), `lib/server/owner-analytics*.ts`, `components/owner-analytics/*`, `app/(app)/[channel]/owner-analytics/*`,
`app/api/owner-analytics/{export,present}`.

This file holds **no values** — no prices, costs or margins. Those live in the database, behind the owner role.

## Data inventory (what exists, and where)

| Question | Source | Notes |
| :-- | :-- | :-- |
| What sold, when, for how much | `payment_events` (0021; Dodo `payment.succeeded`, Paddle `transaction.completed`) | One row per payment after de-duplicating webhook retries. `amount_minor` is the provider's total, tax included, in the payment's currency |
| Plan vs pack vs API top-up | `credit_lots` (subscription lots, 0034), `dodo_checkout_nonces.item` (0146), `credit_transactions` kind `purchase`, `api_ledger` kind `topup` (0031) | A payment none of these describes is "not classified" |
| Which plan / pack | `credit_lots.plan_id`; the nonce's `pack:<id>`; a typed amount is `amount` | Paddle packs carry no pack id: "not recorded" |
| Initial vs renewal | The webhook's note (`(new)` / `(renewal)`, Paddle `origin`), else the order of the subscription's billed periods | Neither → null ("not recorded"), never assumed initial |
| Paid but not credited | `payment_events` status `rejected` with no credited delivery | Its own event (`uncredited`): stated apart, never in gross |
| Refunds, disputes | `payment_events` (Dodo `refund.succeeded`, `dispute.accepted/lost`; Paddle `adjustment.*` + `credit_refunds.reason`) | An amount the provider did not send stays unknown |
| Provider fees | **Not stored** by either webhook | Always "unknown"; net is "before provider fees" |
| Exchange rate / UZS | **Not stored** | Non-USD payments are counted apart, never added as dollars; no UZS figure is shown |
| Customer country | **Not stored** (geo is derived per request, never saved) | No country breakdown |
| MRR / subscribers | Subscription lots' billed periods × their payment | Normalised to a month; measured at the period's end |
| People and signup | `auth.users` (opaque id, `created_at`, `last_sign_in_at`) | No e-mail or name leaves the database |
| Locale | `email_preferences.locale` when `locale_chosen` (0103, 0105) | The column defaults to `en`; an unchosen one is "not recorded", never English |
| Acquisition | `referral_rewards` (0165), `friend_invite_joins` (0092) | No UTM / signup source stored; others "not recorded" |
| Funnel milestones | `editor_projects` (first project), `creative_jobs.requested_by` (first generation), `editor_exports` done (first export), first sale of a workspace the person owns (first payment) | |
| Activity (DAU/WAU/MAU) | `creative_jobs`, `editor_projects`, `editor_exports` | Sign-ins are NOT counted: `auth.users` keeps only the last one, which would rewrite history. Page views are not tied to a person |
| Jobs | `creative_jobs` (kind, capability, routed/requested model, status, payer, charged credits, created/finished) | Time to result on completed jobs only |
| Templates | `creative_templates` | Does not exist yet: "not tracked yet" |
| Internal / test workspaces | `default_org_id()`; workspaces owned by a roster (`app_members`) account; `owner_analytics_internal_orgs` (flagged by the owner, with a reason) | Left out of every figure by default (toggle to include), and the page says how much it left out. Granted credits are never revenue |

Existing operator pages this does **not** duplicate: Margin (`operator_margin_report`, per-model revenue vs provider cost),
Customers (`operator_customer_*`, per-workspace support view with e-mails), Billing (vendor balances and burn). The hub links the
whole business together for one period; slice d will reuse the margin report's cost data rather than re-derive it.

## Rules the hub keeps

- **Owner only, checked by the database.** Each 0182 function refuses everyone but `platform_role() = 'owner'` before reading.
  The page asks `owner_analytics_is_owner()` first so a customer typing the URL learns nothing ("not available").
- **The browser uses the anon key and the owner's session only.** No service key, no public cache (`force-dynamic`, `no-store`).
- **Unknown is a word.** A missing amount marks its total incomplete; churn, stickiness and funnel rates below 5 people read
  "not enough data (N)"; MRR with no subscription reads "no subscriptions yet"; LTV is labelled an estimate and is withheld while
  churn is unmeasurable or zero.
- **Period.** Presets today / 7d / 30d / MTD / QTD / YTD / custom, Asia/Tashkent calendar days, half-open `[from, to)`;
  "compare" uses the equal-length window just before.
- **Exports.** CSV (UTF-8 BOM) and XLSX, built server-side from the database with the same builders as the page. POST, same
  origin, owner, a sign-in within 15 minutes, and an audit row (`owner_analytics_exports`) written **before** the file is built —
  no record, no file. Text cells that would run as a formula are neutralised.
- **Presentation mode.** An httpOnly cookie. With it on, no table renders or exports a payment id; people and workspaces are
  never rendered at all (the database returns opaque ids, and the hub shows aggregates).

## Further rules (from review)

- **Every row, not the first 1,000.** PostgREST caps a response at `max_rows`; the reader pages through each function and says
  `truncated` only when the function's own ceiling or the time budget is reached.
- **Second factor.** With 0107's `admin_aal2_required` on, a password-only session can neither take an export nor change the
  internal-workspace list (`NS401` → "enter your authenticator code").
- **MRR** divides each billed period by the months it bills (27–32 days is one month, 360–371 twelve); a period of another
  length, another currency, no amount or a refund of unknown size makes MRR incomplete. A disputed or fully refunded period is
  neither MRR nor a retained subscriber.
- **Churn** is one definition on every tab: subscribers billed 30 days before the period's end who are no longer billed at it.
- **Cohorts** leave a month blank when the activity read did not cover it, and plan cohorts count a month as retained when a paid
  period covers it (a yearly subscriber is retained all year).
- **Signups** count confirmed addresses only.
- **Credits charged** are unknown, not 0, for jobs that carry no charge (running, or paid from the API balance).
- **What the audit does not cover.** The export log records files built by the hub. The owner's own session can still call the
  read functions directly through the API; that is the owner reading their own data, and is not a file leaving the building.

## Costs & profit (slice d, migration 0183)

| Figure | Source | When it is unknown |
| :-- | :-- | :-- |
| Provider spend | `creative_job_costs.usd_estimate` (priced when the job ran), pipeline `video_costs` | A cost row with no price: counted, never added; the total is a floor and profit is unknown |
| Balances | `provider_balances` `api` rows from the balance worker; `owner_manual_balances` for what the owner typed (never written to `provider_balances`, which the operator bot and Billing read as the provider's word) | No row: "no balance on record". A manual row is badged "entered by owner on <date>" |
| Monthly costs | `owner_cost_entries`, typed by the owner per month and category | A month with no entry is "not entered": its operating result is unknown |
| Gross profit | net revenue (before provider fees) − customer provider spend | Either side unknown |
| Operating result | gross profit − internal spend − entered costs, per calendar month | Any part unknown |

Balance APIs, checked against official docs on 2026-11-20 (docs only, not called): a balance endpoint is documented for
ElevenLabs (a character quota, not money), Runway, xAI, BFL, Vidu, Luma (legacy docs), Kling (resource packs), Recraft, Pika and
fal.ai. None is documented for Gemini/AI Studio, OpenAI, BytePlus ModelArk, MiniMax, LTX, Ideogram, Krea or Replicate.
Alibaba exposes only an account-level billing API. Leonardo's reference page could not be re-read. The balance worker
(`modules/provider_balance.py`) reads ElevenLabs, Leonardo and Runway today. For everyone else, the owner enters a balance by
hand. Units stay the provider's own and are never converted.
