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
| Refunds, disputes | `payment_events` (Dodo `refund.succeeded`, `dispute.accepted/lost`; Paddle `adjustment.*` + `credit_refunds.reason`) | An amount the provider did not send stays unknown |
| Provider fees | **Not stored** by either webhook | Always "unknown"; net is "before provider fees" |
| Exchange rate / UZS | **Not stored** | Non-USD payments are counted apart, never added as dollars; no UZS figure is shown |
| Customer country | **Not stored** (geo is derived per request, never saved) | No country breakdown |
| MRR / subscribers | Subscription lots' billed periods × their payment | Normalised to a month; measured at the period's end |
| People and signup | `auth.users` (opaque id, `created_at`, `last_sign_in_at`) | No e-mail or name leaves the database |
| Locale | `email_preferences.locale` (0103) | Others: "not recorded" |
| Acquisition | `referral_rewards` (0165), `friend_invite_joins` (0092) | No UTM / signup source stored; others "not recorded" |
| Funnel milestones | `editor_projects` (first project), `creative_jobs.requested_by` (first generation), `editor_exports` done (first export), first sale of a workspace the person owns (first payment) | |
| Activity (DAU/WAU/MAU) | `creative_jobs`, `editor_projects`, `editor_exports`, sign-ins | Page views are not tied to a person (`site_page_views` is an aggregate) |
| Jobs | `creative_jobs` (kind, capability, routed/requested model, status, payer, charged credits, created/finished) | Time to result on completed jobs only |
| Templates | `creative_templates` | Does not exist yet: "not tracked yet" |
| Operator's own workspace | `default_org_id()`; roster `app_members` | Left out of every figure, and the page says how much it left out |

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
