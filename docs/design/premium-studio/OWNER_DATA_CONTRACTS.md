# Owner financial and operational data contracts

Planning only, Phases A–C. Audited 2026-11-15 against `/workspace/nightshift-premium-ui-plan`, main baseline `f985b3afd371c0677357670da436ef2074fdb036`. All seven owner mockups were visually inspected. Mockup business figures, companies, invoice/card data, infrastructure clusters and compliance claims are fictional references and must not be imported. No application/schema/configuration changes, runtime calls, provider requests, production database reads or secret inspection were performed. Source presence is not evidence that a migration is deployed, a flag is enabled or a provider is connected.

Paths below are relative to that canonical checkout; `:line` is the source evidence anchor. The original `/workspace/nightshift-ai-studio` checkout is stale and was excluded. Pending remediation branches are dependencies to reconcile before implementation, not represented as merged main.

## 1. Outcome and boundaries

Reuse the existing operational data paths and components. The current owner provider ledger is substantially more complete than the mockups imply: it separates pipeline, Studio and probe use; distinguishes reported and estimated balances; propagates missing prices and truncated history; and already supports external provider checkout followed by manual top-up confirmation. Premium styling must preserve these semantics.

A reconciled financial reporting layer is missing. Current customer payment totals are Paddle-only gross receipts, not net revenue. Neither an asserted net profit nor platform-wide MRR follows safely from current tables. Proposed provider spend, balance and revenue cards must expose their provenance and completeness.

The new Owner Command Center is owner-only, server-enforced. Existing code often authorizes platform owner **or admin**; this is a real contract delta, not an existing guarantee. Customer organization administrators are not platform owners. The owner-in-Personal-Studio must use the same customer creative implementation, with no cross-tenant impersonation or duplicate credits/project store. No investor role is introduced.

Evidence:

- `CLAUDE.md:18` secrets rule; `:76` unknown/default distinction; `:154` end-to-end completion requirements.
- `command-center/lib/auth/org-roles.ts:14` platform versus organization boundary; `:35` owner decision prohibits switching into customer workspaces; `:160` cached operator check; `:218` page authorization before credential-backed reads.
- `command-center/lib/server/owner-reads.ts:15` signed-in-user reads and `ok/unsupported/failed`; `:53` provider-spend RPC; no service key in browser.
- `supabase/migrations/0033_roles_cleanup.sql:86` provider balance/settings/top-up SELECT policies use `is_platform_admin()`.

## 2. Seven-screen source map and functional controls

The URL prefix is the existing channel context (`/{channel}`), normally the authorized aggregate scope for owner reporting. Owner operational routing needs a consistent namespace decision; no new route is claimed to exist. Navigation evidence: `command-center/lib/navigation.ts:35` current home `/command-center`; `:97` Customers/Billing links; `:495` operator-only section filtering.

### 01 — Executive Overview

**Reuse:** `/{channel}/command-center`, `app/(app)/[channel]/command-center/page.tsx:87`; `components/dashboard/OwnerGlance.tsx`; `components/SystemStatus.tsx`; current owner strips, alerts and scoped activity. The page uses authorized scope, bounded reads and honest failures. Provider balances and worker reports are read at `:172–193`; current event/video reads at `:145–169`. `/{channel}/home` is a customer channel home, not an owner revenue report.

**Mockup blocks → contract:** revenue/net profit → proposed FinanceSummary, unavailable until reconciled; AI expenses → CostCoverage totals, separately actual/estimated; paid customers → SubscriptionSummary with explicit definition; provider monitor/forecast → existing ProviderLedger projection; customer preview → existing operator_customer_*; P&L → new reconciled layer, never client arithmetic over copied demo cards.

**Controls:** date range changes all query windows consistently; refresh revalidates server reads only; export is a new owner-authorized filtered export, not an existing verified endpoint. Provider selector uses stable account/provider ID. External billing opens an allowlisted URL. History opens recorded snapshots/top-ups/cost detail. “All customers” navigates to existing Customers. Top-up requires the explicit external-payment/manual-confirmation flow below. Forecast confidence percentage has no current calibrated source; show coverage/sample window and uncertainty rather than a fabricated probability.

**Gaps:** financial summary, multi-source revenue reconciliation, calibrated forecast intervals and owner CSV export are not verified. Do not infer user online presence, business health or profit from page load success.

### 02 — API & Model Intelligence

**Reuse:** `/{channel}/billing`, `/{channel}/providers`, `/{channel}/models`, `/{channel}/model-keys`. `app/(app)/[channel]/billing/page.tsx:65` names balance/pipeline/Studio/probe sources; `:75` guards before credential-backed reads; `:109` suppresses platform provider accounts when tenant scope is selected. `:181–222` paginates probes/Studio and reads model_registry_admin. `components/billing/BillingBoard.tsx:122` refresh handler; `:185` ProviderRow; `:190` BulkPay. `lib/billing.ts:859` providerLedger is the projection to extend.

**Sources:** provider_balances, provider_billing_settings, provider_topups, video_costs, creative_job_costs, model_probe_runs and model_registry_admin. The optional owner_provider_spend RPC is not a complete replacement for the combined ledger. `lib/server/owner-reads.ts:53`; `supabase/migrations/0106_video_costs_idempotent.sql:125` RPC body reads ledger prices and preserves unknown rows at `:180`. Registry presence is a catalog fact, not connected API count or successful production readiness.

**Controls:** selector/arrows switch provider without losing reporting period; billing details/history expand existing records; settings reuse POST `/api/billing/settings`; refresh reuses POST `/api/billing/refresh` and displays “queued” until a new snapshot exists. “Pay” opens provider checkout and only then offers recording of a confirmed top-up; no automatic charge. Model switches/price edits/key controls reuse separate audited routes only after owner/MFA checks, never a generic dashboard action. Existing credential controls are outside financial DTOs; do not return secret values or credential fragments.

**Metrics:** spend in USD is cost, not request-count mix. Provider native credit/character/token quantities remain separate units. Success rate denominator must specify actual execution attempts, period and final/pending outcomes, and include billed failures; probe success is not customer execution reliability. Latency must distinguish queue wait, provider request and total job time. Unmapped provider/account costs appear in an explicit unmatched category, not silently discarded.

**Gaps:** most providers have no implemented verified balance adapter here; model-level actual invoice reconciliation, per-account data, payment receipt verification and standard attempt telemetry are not complete. Local public API-pricing audit artifacts are research references, not production invoices and not customer-visible profit data.

### 03 — Customers

**Reuse:** `/{channel}/customers`, `app/(app)/[channel]/customers/page.tsx:27` operator-only read-only report, `:55` repeated role check and `:63` calls operator_customer_totals/daily/accounts. `components/customers/CustomersReport.tsx`, `lib/customers.ts:78` totals and `:158` account DTO. Search/sort/page already use URL state and server-side paging, up to50rows (`page.tsx:33`, `lib/customers.ts:16`).

**Existing fields:** users versus workspaces, new/active workspaces, credits spent/purchased/granted/reserved, gross Paddle USD receipts, non-USD payment count, plan identity, customer workspace owner email, last activity and job counts. Display these as precisely defined; total users are not paid subscriptions; purchased credits are not invoice count. `lib/customers.ts:175` paidUsd excludes other currencies.

**Controls:** reuse search, sort and pagination. Add plan/status filters only once database filtering/counting supports them. Row overflow can open a read-only workspace support detail; it must not silently switch workspace identity, grant credits, cancel subscription or issue refunds. Privacy-preserving aggregation first; owner emails only in authorized customer detail/list where necessary. Export must reflect the same scope/filters with PII minimization and spreadsheet-formula escaping.

**Gaps:** revenue by plan, per-customer margin, repeat-purchase ratio, upgrade history and churn-risk scoring require new definitions and complete payment/cost attribution. No fabricated customer portraits, organization names or “risk” labels. “Active” means a declared activity rule, not merely subscription status.

**Material limitation:** `supabase/migrations/0138_operator_customers.sql:132–138` and `:320–326` restrict receipts to Paddle transaction.completed, processed/duplicate, deduplicated by transaction ID; source comments at `:23` explicitly describe gross before refunds/tax/fees. Dodo payments added in0146 are not included by these functions. Do not relabel these existing figures as all-provider revenue or net receipts.

### 04 — Subscriptions & Payments

**Reuse:** customer-facing `/{channel}/credits` and its plan/credit purchase controls; do not turn the owner's own tenant credit page into a cross-customer admin view. Evidence: `app/(app)/[channel]/credits/page.tsx:87` parallel plan/ledger reads, `:117` raw prices/margins owner-admin only, `:139` provider selection and `:142` Dodo test-org restrictions. `lib/server/payments.ts:16` provider selection. Existing customer billing portal `/api/billing/portal` and Dodo invoice `/api/billing/dodo/invoice` are scoped customer services, not global merchant dashboards.

**Sources:** subscriptions, plans, credit_lots, credit_transactions, payment_events, credit_refunds. `supabase/migrations/0034_plans_entitlements.sql:272` subscription state stores period/status/IDs, not a complete historical recurring-price ledger; `:298` credit lots. `0146_dodo_payments.sql:137` provider-neutral subscription contract; `:146` stale-event/idempotency handling. Webhook entrypoints exist under `supabase/functions/paddle-webhook/index.ts` and `dodo-webhook/index.ts`; existence does not prove live webhooks.

**Controls:** date and provider/environment/status filters, typed invoice detail and failure reasons, read-only customer subscription detail, allowlisted merchant billing link, export. Unknown invoice receipt/card brand/last4 must stay unavailable; current subscription schema intentionally has no card data (`0034:292`). “View all failures” must query a defined payment-attempt source, not count every webhook event as an attempt. Renewal state is subscription scheduling, not proof a payment succeeded. Cancellation/refund/retry controls are separate future scopes with recent MFA, reason, idempotency, preview, audit and explicit confirmation; no action should be implied by a status card.

**Gaps:** owner merchant invoice/settlement feed, normalized live/test dimension, reconciled fees/tax/refund amounts, historical contracted price/interval/discount data, failure attempt ledger and all-provider MRR trend. Stripe in the mockup is not evidence of a Stripe integration: current code selects Paddle or Dodo.

### 05 — Finance & Profit

**Reuse:** `components/billing/UnitEconomicsCard.tsx` and `ProviderSpendPanel.tsx` for their existing narrower operational meaning; existing cost and credit ledgers remain authoritative for their own units. `supabase/migrations/0037_provider_costs.sql:37` creative_job_costs and `:46–61` estimate/source fields; append-only protection at `:69`; `modules/cost_ledger.py:1` consumption ledger, `:126` optional caller estimate, `:180` unknown-total propagation. No standalone complete accounting ledger or deployed P&L report was verified.

**Contracts:** see financial definitions below. Period selection must keep accounting basis and currency explicit, with prior period equally covered. Net revenue, gross profit and net profit cannot use customer credits × today's retail price. Revenue and expense charts must not mix cash receipts with accrual COGS. Any incomplete P&L displays known components and “Net profit unavailable: missing …”, not a partial sum labeled net profit.

**Controls:** period/basis/currency selector, source drilldown, owner export, reconciliation exceptions. “Target margin” is a proposed configurable business goal, not a mockup default or measured result. No automatic provider top-up or finance operation. Customer view never receives COGS, margins, settlement amounts, internal provider balances or research estimates.

**Gaps:** authorized bookkeeping/invoice import, historical revenue recognition, provider invoice/task reconciliation, OPEX/infrastructure bills, payment commission/FX/chargeback data, tax treatment, refunds allocation and reporting close status.

### 06 — Infrastructure

**Reuse:** `/{channel}/integrations` and `components/workers/WorkerStatusPanel.tsx:33`; reads `worker_status` at `app/(app)/[channel]/integrations/page.tsx:73`, rendered at`:120`. Command Center shares the heartbeat source. `supabase/migrations/0045_worker_status.sql:55` table, `:84` trusted-worker reporting, `:111`14-day cleanup. `lib/workers.ts:21` exact columns and `:73` freshness-aware display; stale starting/running becomes “not reporting”, not offline proof. `/{channel}/jobs`, `logs`, `alerts`, plus actual job tables provide drilldowns; Jobs derives historical execution groups from events (`jobs/page.tsx:45`) and is not by itself an authoritative queue-backlog counter.

**Controls:** worker-kind/status filter, bounded period filter, fresh read, job drilldown, incident detail. Read-only infrastructure view must not expose SSH, root console, Docker socket, deploy/restart/migration or secret actions. Recent incidents may reflect stored alert_events/system_events; do not claim resolution without a recorded recovery signal or human resolution record.

**Gaps:** actual CPU/RAM/disk/network/GPU metrics, durable historical worker inventory, per-environment resource monitoring, uptime probes, p95 provider latencies, scheduler run history and verified backup/recovery tests are not supplied by worker_status. Do not fabricate GPU utilization on the user's CPU-only server. A Compose resource limit is configuration, not observed usage. No infrastructure billing or telemetry collection is authorized by this plan. The mockup's cluster/region/environment inventory must not become seed data.

### 07 — Security & Audit

**Reuse:** `/{channel}/security`, `components/security/SecurityBoard.tsx` for Supabase MFA; owner panel `OwnerSecurityPanel`. `security/page.tsx:23` owner reads are gated by NIGHTSHIFT_OWNER_RPC; `:30–45` separate security/event states. `lib/server/owner-reads.ts:44` owner_security_get and `:49` owner_security_events. `/{channel}/audit` reads app_audit_log (`audit/page.tsx:40`) with authorized scope, while `/{channel}/alerts` handles operational warnings. `0107_owner_safety.sql:180` append-only security events and `:212` credit-price history; `lib/owner-reads.ts:81` safe event DTO does not expose arbitrary detail blobs.

**Controls:** severity/type/actor/time filters, cursor-paged read-only event detail, sensitive export with recent MFA and audit. “Manage permissions” points to the existing authorized team flow; do not introduce mock Manager/Admin roles into the desired owner/customer product model without a separate compatibility decision. Billing risks link to subscription/provider evidence. Existing MFA enrollment must remain functional. Database safety-gate state is read-only in the existing owner panel; no casual toggle in the redesign (`security/page.tsx:25`).

**Gaps:** failed-login/security-session/device counts, location risk, audit-coverage percentage, compliance certification, backup integrity and recovery test status are not proven by these sources. State unavailable until an authorized trustworthy feed exists. Never display SOC2-ready/certified because the reference does. “No audit events” is valid only after a successful complete read, not when a feature is disabled or unavailable.

### Shared shell controls across 01–07

Follow the master brief over the reference header: Personal Studio/Owner Command selection exists only inside the top-right N avatar menu, with Settings, compact theme controls and sign out. Do not retain the large dual-mode header control from the pictures. Owner identity/badge is sourced from authorization, never a graphic claim of verified business identity. Sidebar links map to actual authorized screens; collapse is local presentation state. Alerts bell routes to the existing Alerts view with a known bounded count; a red dot is not synthesized. Global search needs a real scoped search contract or an explicitly unavailable control; it is not complete merely because an input animates. Date ranges, refresh, overflow menus and chart drilldowns need keyboard labels, meaningful focus/disabled states and an authorized handler. Empty/unavailable charts should preserve usable navigation without inventing percentages.

## 3. Shared provenance envelope (draft, not implemented)

Use one reusable server-owned contract for every financial metric/chart/row; extend existing OwnerRead rather than replacing its honest states.

```ts
type EvidenceMetric<T> = {
  state: 'available' | 'partial' | 'unsupported' | 'unavailable' | 'failed';
  value: T | null; // zero only for a successful complete observed empty result
  provenance: 'provider_reported' | 'invoice_reconciled' | 'worker_usage'
    | 'operator_confirmed' | 'catalog_estimate' | 'derived' | 'mixed';
  sourceRefs: Array<{ kind: string; recordId: string; version?: string }>;
  observedAt: string | null;
  refreshedAt: string; // response time is NOT source freshness
  window: { start: string; endExclusive: string; timezone: string };
  coverage: {
    complete: boolean; coveredFrom: string | null; coveredThrough: string | null;
    receivedRows: number | null; expectedRows: number | null; truncated: boolean;
    unpricedRows: number | null; unmatchedRows: number | null;
    missingSources: string[]; excludedSources: string[];
  };
  currency?: string; unit?: string;
  environment: 'live' | 'test' | 'mixed' | 'unknown';
  reasons: string[]; // typed/sanitized codes; no raw provider errors/secrets
};
```

Return decimal money as strings in explicit currency, or integer minor units with currency exponent; use decimal arithmetic server-side. Credits, provider credits, USD and subscription allowance are distinct units. Native non-USD amounts stay native until a dated FX rate/source exists; never sum unlike currencies. USD cents conversion applies to USD only, not every currency. Returns must not infer connected status from a configured key name, model registry entry or successful DB read.

For aggregates with missing costs, expose `knownAmount` separately and keep `totalAmount=null`. A percentage needs a known nonzero denominator, matching scope and complete inclusion rule. Truncated list length is a lower bound, not total. A malformed row must be counted as invalid evidence, not silently removed before claiming coverage. Zero baseline percent change is undefined; display unavailable. Exports carry the same source timestamps, basis, currency and completeness as the UI.

Existing useful contracts: `lib/owner-reads.ts:152` SpendRow; `lib/server/owner-reads.ts:23` OwnerRead; `lib/billing.ts:619` source-state distinctions, `:640` estimates; `app/(app)/[channel]/billing/page.tsx:93` capped ledger handling and `:170` covered-from; `:218` Studio/probe horizon; `lib/workers.ts:36` age/freshness.

## 4. Financial definitions and reconciliation rules

### Provider accounts, top-ups and use

A provider account must be keyed by `(provider_id, account_ref, environment, currency, native_unit)`, not display name alone. Existing provider-only rows do not safely distinguish multiple accounts, projects or regional billing. Initial UI can explicitly say “single configured provider account; account attribution unavailable” until this is extended.

- **Reported balance:** provider snapshot with metric/unit/checked_at, account scope and expiry/reset. Existing `provider_balances` fields are in `0012_billing.sql:22`. `modules/provider_balance.py:8` implements ElevenLabs, Leonardo and Runway adapters; this is the adapter list in source, not a claim every other vendor lacks an API forever. ElevenLabs allowance/character balance is not cash USD.
- **Estimated balance:** confirmed usable funding/opening balance less matched usage and adjustments over complete coverage. `lib/billing.ts:368` coverage guard; `:859` combined ledger; provider-reported data takes precedence, estimates remain labeled. Top-up histories may omit initial balance, out-of-platform use, promotional credits, tax, expiry and refunds; never certify inferred remainder as verified vendor cash.
- **Provider payment:** `provider_topups` records an operator confirmation (`0012:48`, `/api/billing/topup/route.ts:13`). It currently lacks verified receipt ID, external transaction ID, currency/fee allocation and financial idempotency evidence. Show “operator recorded”, not “provider verified”. Setting card_saved/auto_recharge records an operator assertion, not a remote control of vendor payment settings.
- **Prepaid asset versus expense:** cash paid for usable provider credit increases prepaid service asset; consumption decreases that asset and recognizes usage expense. Do not add both top-up cash flow and usage to P&L. Cash-flow view can show provider top-ups as cash outflow, clearly separate from usage-cost reporting. Account for nonrefundable subscriptions, expiration, tax and FX according to an approved accounting policy; free/promotional units are not cash asset at face value automatically.
- **Usage:** retain job/attempt/vendor request IDs, model and exact settings, timestamp, quantity/unit, rate version, invoice amount if known, estimated amount and source. Actual provider-invoiced charge replaces/reconciles an estimate for the same attempt; it is not another additive cost. Retries, failed billed attempts, probes and internal owner work are real cost categories; customer credits refunded are not automatically provider cost refunded.
- **Coverage:** pipeline video_costs plus creative_job_costs plus model_probe_runs are different source families; reconcile identifiers before addition to prevent duplicate mirroring. `0106:150` row-key deduplication covers mirrored pipeline rows; it does not prove universal cross-source deduplication. Existing owner_provider_spend consumes estimated_usd: its function comment “billed” does not make it invoice actual.

### Revenue, refunds, commissions, VAT and profit

- **Customer cash receipts:** unique verified settled provider transactions, scoped live environment, currency, transaction identity and event version. Deduplicate `(provider, merchant_account, environment, transaction_id)`, not event count. Processed/duplicate webhook rows can describe the same transaction. Test/sandbox events and rejected/ignored/failed events are excluded from real receipts, but retained in a separate diagnostics view. Current payment_events (`0021_credit_refunds.sql:56`) has amount/currency/status and identity, not sufficient environment/settlement/fee detail.
- **Recognized net revenue:** gross service consideration less discounts and customer refunds/returns, excluding taxes collected on behalf of tax authorities, recognized under a documented policy. Credit-pack receipt is not necessarily earned revenue on the purchase date; prepaid customer service may be a liability until fulfilled/expired under that policy. Subscription MRR is not cash receipts and not recognized monthly revenue.
- **Money refunds:** reconcile provider-confirmed cash refunds/chargebacks by original transaction and unique refund/adjustment IDs; failed-generation credit refunds and owner grants are internal entitlement changes, not cash outflow. `0021:28` explicitly records unrecovered credit shortfall; `credit_refunds.shortfall` is a credit-unit exposure, not directly USD loss. Keep hold release, capture reversal, cash refund and debt/shortfall categories separate. Later recovery0167/0168 must not create a second cash refund.
- **Commissions/FX:** provider settlement fee, processing fee, nonreturned refund fee, chargeback fee, FX loss/gain and payout fee require settlement/invoice evidence. If reporting net settlement receipts, do not subtract included fees again. Merchant-of-record remittances require gross-to-net reconciliation; do not assume a universal fee percentage or tax liability from catalog prices.
- **VAT/sales tax:** distinguish output tax collected/remitted, recoverable input VAT, nonrecoverable input tax and income/profit tax. VAT remittance is not always a P&L expense; income tax is not a percentage inferred from VAT. Currency conversion and tax jurisdiction need explicit evidence/policy.
- **Gross profit:** recognized net revenue minus attributable COGS, with a stable declared allocation of provider usage/render/storage. **Operating profit:** gross profit minus OPEX. **Net profit:** operating profit adjusted for financing/other items and income tax according to bookkeeping policy. Shared infrastructure costs belong once, either COGS or OPEX by allocation; no double subtraction. Show complete net profit only when required inputs reconcile; otherwise expose a clearly labeled contribution estimate.
- **MRR:** contracted recurring net service amount normalized by billing interval, including documented discounts and declared treatment of past_due/trial/paused/cancel-at-period-end. Exclude one-off credits, taxes and trial/free plans from paid MRR. Current subscriptions stores plan and provider price ID, not historical amount/interval; today's public price cannot reconstruct an old contract. Renewal forecast is distinct from collected revenue.
- **Customer counts/churn:** count unique customer workspace, person and subscription separately. A paid workspace has a qualifying live payment/paid entitlement under an explicit time rule; “active subscription” alone is not that proof. Churn requires historical paid cohort/window and excludes the operator internal organization consistently. Risk predictions need a documented evidence-based model, not arbitrary labels.

## 5. Minimal draft read contracts and schema gaps

These are proposed server service names, not implemented APIs or migration authorization. Prefer owner-only RPCs or server loaders over client access to raw financial tables. No new competing billing ledger.

| Draft contract | Inputs | Backing source and output | Missing extension |
|---|---|---|---|
| OwnerExecutiveRead | period, timezone, currency | Compose providers/customers/subscription/finance metrics with independent completeness | Consistent period envelope and finance reconciliation |
| OwnerProviderRead | provider/account/environment, period, cursor | Existing providerLedger + latest snapshots/top-ups; costs by source/model/settings | Account dimension, freshness, unmatched attribution, reconciled invoices |
| OwnerSubscriptionRead | customer/provider/environment/status, period, cursor | Existing subscriptions/plans; paid lots only as entitlement evidence | Historical price/interval/discount, provider merchant invoices and real/test provenance |
| OwnerPaymentRead | provider/environment/customer/status, period, cursor | Unique transactions/refunds and settlement records; append-only event evidence | Normalized financial transaction projection; no raw webhook JSON/card data |
| OwnerFinanceRead | period, basis, currency | Recognized revenue/COGS/OPEX/tax lines with linked evidence | Bookkeeping import and approved recognition/allocation policy |
| OwnerInfrastructureRead | worker kind/environment, period, cursor | Worker heartbeats, actual job/queue tables and scrubbed alerts | Authorized resource/uptime/latency/scheduler/backup telemetry; history retention |
| OwnerSecurityRead | type/severity/actor, period, cursor | owner_security_get/events plus scoped app audit | Owner-only policy delta, consistent filters/pagination, auth/backup evidence |

Schema extensions, only if later approved: add source-linked account/environment dimensions and typed reconciliation metadata to existing ledgers or companion projections; signed/imported invoice/settlement metadata with unique source IDs; historical subscription price/period snapshots; OPEX/import references; telemetry snapshots with collection timestamp. A minimal read-only phase may ship premium layouts with missing widgets honestly unavailable before these extensions. Never add invented rows to make charts look populated.

## 6. Action contract reuse and safe disabled states

| Visible control | Existing endpoint/handler | Required display/authorization behavior |
|---|---|---|
| Refresh balances | POST `/api/billing/refresh`; `route.ts:16–26`, BillingBoard:122 | Existing signed-in admin/origin/MFA guard; future owner-only boundary; “refresh queued”, not “verified refreshed”; no new secret-reading dashboard handler |
| Provider settings | POST `/api/billing/settings`; `route.ts:18–23`,`:62` | Existing validated provider/rates; save/re-read; rates operator-defined estimates, never vendor bill |
| Record top-up | POST `/api/billing/topup`; `route.ts:21–54` | External checkout first, manual confirm; no card data; audit; duplicate-click/idempotency/receipt enhancement needed for financial verification |
| External billing | BILLED_PROVIDERS `lib/billing.ts:223–250`, BillingBoard:453, TopupControls:387 | Registered official link, no arbitrary URL from model output; verify endpoint/account applicability before claiming official billing; noopener/noreferrer |
| Grant/reverse credits | `/api/owner/credits/grant`, `/reverse`; owner RPC helpers | Existing caps/reason/idempotency/privileged gate preserved; reverse grant != cash refund |
| Edit retail price | `/api/owner/prices`, credit_price_history | Existing audited policy/caps/MFA; never silently alter quoted plan or expose margin to customer |
| Switch model / key configuration | `/api/owner/model-switch`, `/api/owner/model-keys` | Explicit separate privilege; no silent substitution or secret read-back; not needed to style provider metrics |
| Search/filter/date/paging | Existing Customers URL/server RPCs; other read contracts proposed | Server reauthorization, stable filters, bounded queries; refresh retains filters |
| CSV/PDF export | New owner reporting capability, not verified existing | Same scope/filters/provenance; recent MFA for sensitive PII; formula escaping, download audit; no raw secrets/card/webhook payload |
| Refund/cancel/retry payment | No global owner merchant action verified | Disabled with explanation or read-only provider link; no fake success or automatic financial operation |
| Infrastructure restart/deploy | No control in this approved plan | Omit; do not wire SSH/Docker/admin APIs |

The common POST guard is `lib/server/admin-post-guard.ts:7` (same-origin and MFA decision). Existing MFA supports off/warn/enforce (`org-roles.ts:190–198`), and0107 safety gates are feature/config dependent. Therefore “MFA enforced” is not a runtime claim. The new sensitive-action acceptance condition requires verified recent AAL2 enforcement at server/database boundaries; enabling it requires a separately approved implementation/configuration scope. Owner-only is stronger than the current admin guard, so plan a shared server owner authorization primitive and SQL owner predicate rather than relying on route hiding.

## 7. Implementation dependencies, acceptance evidence and risks

1. Reconcile current main and pending P0 financial/security remediation before touching the UI data layer. Specifically preserve paid-run quote/hold/capture/release, thumbnail/input pricing, API holds, refund recovery0167/0168, and terminal webhook rejection semantics. This document does not certify pending fixes as merged or deployed.
2. Decide the product-owner identity mapping while preserving existing customer organizational roles and authenticated APIs. No new investor/manager product role; do not delete historical admin rows or weaken authorization in a styling PR.
3. First integration scope can reuse OwnerGlance, BillingBoard/ProviderLedger, CustomersReport, WorkerStatusPanel, SecurityBoard/OwnerSecurityPanel and existing read-error components. Keep financial schema/reconciliation work separate from a visual shell change.
4. Before exposing complete revenue: address Paddle-only0138 aggregation, provider+environment identity, unique transaction/refund semantics, live/test evidence and missing money fees/tax inputs. Before complete profit: reconcile actual provider costs and OPEX. Until then do not advertise those cards as available.
5. Every screen needs loading, observed empty, unavailable/not-enabled, partial coverage, stale source, failed read with retry and unauthorized states. No zero-valued skeletons, seeded demo charts, or “connected/healthy” based only on a configured integration.

Meaningful acceptance checks for the later implementation:

- Ordinary customer, org administrator, non-owner platform administrator and anonymous direct route/RPC/export attempts receive no owner finance/provider data. Owner switching to Personal Studio returns only the intended tenant data. Recent-MFA challenge must occur before sensitive writes, not just before rendering a button.
- Failed/unsupported reads, missing migrations/flags, malformed rows, truncated pages, empty unsynced ledger and stale snapshots stay distinct; prior-window comparisons cannot hide missing coverage.
- A top-up followed by usage appears once as asset/cash flow and once as consumption expense in the appropriate reports, never twice in P&L; provider invoice replaces an estimate without duplicate cost. Paid retry costs count even if customer credits were refunded.
- Duplicate webhook delivery, multiple providers with similar IDs, test/live events, partial cash refund, credit refund, reserved credit and recovery after hold release do not inflate receipts, customer counts or losses. Dodo and Paddle totals reconcile separately before combination; non-USD remains separate without FX evidence.
- Subscription cancellation at period end, trial/past_due, annual billing and historical discounts follow declared MRR/cohort rules; current public price changes do not rewrite history.
- Native provider units never become USD implicitly. Token-based image generation includes prompt/thinking/referral context as applicable; a catalog research price is not vendor invoice actual.
- Source drilldown and CSV agree with visible period/basis/currency/coverage. Export rows are bounded/paginated, scrubbed and formula-safe; no sensitive data appears in ordinary client payload/cache.
- Worker stale heartbeat is “not reporting”; unknown CPU/GPU/storage/uptime and unverified backups/compliance are unavailable. No restart/deploy/payment occurs from a read/refresh/export.

Risks remain semantic and authorization-related as well as visual: the mockup collapses cash, allowance, usage and profit into similar cards; current mixed estimates must remain explicit. Preserve mobile readability by showing provenance/freshness next to each amount, not only in a desktop-only tooltip. Finance definitions and provider telemetry scopes need owner review before implementation; no business rates, targets, thresholds or subscription counts are proposed as hardcoded values here.
