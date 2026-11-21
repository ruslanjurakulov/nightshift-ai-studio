# Owner Brain — the owner side of Nightshift Brain

The owner's Nightshift AI answers questions about the whole system and drafts (a payment plan, an e-mail to a vendor). It never
pays, changes a price or a plan, or edits anyone's data. This file is the data layer it stands on.

## Facts

`lib/server/owner-brain-facts.ts` → `buildOwnerFacts()` builds one JSON object, server side, for the platform owner only:

| Block | From | Tag |
| :-- | :-- | :-- |
| `people` | `owner_brain_people()` (0196) | measured |
| `health` | `owner_brain_health()` (0196) | measured; CI/deploy `not_in_database` |
| `revenue` | `owner_analytics_money` (0182) → `summarize`, `mrrAt`, `churn` | measured, net before fees |
| `providers` | the provider runway (0184 + the Billing ledger) → `paymentPlan()` | measured (provider's reading) or estimated (top-ups − spend) |

Every figure is `measured`, `estimated` or `unknown` with its reason, and carries `as_of`. Internal and demo workspaces are
excluded. Vendor costs and balances are in this object: it is owner-role output only.

## Payment plan

`lib/owner-analytics/payment-plan.ts`: per provider, what is left (measured or estimated), the 14-day pace, the run-out day, the
provider's own top-up page, and for the next 10 days what to pay and by when. Amount = 10 × the 14-day pace, rounded up to the
provider's minimum top-up when one is known — none is recorded today, so a line says "minimum not recorded". Empty (the newest
job or probe was refused for want of balance) comes first and is due today. Unknown is listed as unknown, never as "nothing to
pay". A provider that recharges itself is not due.

## Isolation (an owner-data leak is CRITICAL)

- Database: 0196's functions, 0182's and 0184's all check the platform owner before reading anything; the lab proves a customer,
  a workspace admin, a platform admin, anon and the service key get 42501 (`tests/security/test_sec_owner_brain.py`).
- Code: `buildOwnerFacts()` throws `OwnerOnlyError` unless `ownerAccess()` is "owner", before any read.
- Import graph: no route outside the owner zones, and nothing under `lib/brain/`, may import the facts, directly or through
  another file (`tests/owner-brain-facts.test.ts`). The owner's AI route lives under `app/api/brain/owner/`.
