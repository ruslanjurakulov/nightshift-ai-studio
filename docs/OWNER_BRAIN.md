# Owner Brain — the owner side of Nightshift Brain

The owner's Nightshift AI answers questions about the whole system and drafts (a payment plan, an e-mail to a vendor). It never
pays, changes a price or a plan, or edits anyone's data. This file is the data layer it stands on.

## Facts

`lib/server/owner-brain-facts.ts` → `buildOwnerFacts()` builds one JSON object, server side, for the platform owner only:

| Block | From | Tag |
| :-- | :-- | :-- |
| `people` | `owner_brain_people()` (0197) | measured |
| `health` | `owner_brain_health()` (0197) | measured; CI/deploy `not_in_database` |
| `revenue` | `owner_analytics_money` (0182) → `summarize`, `mrrAt`, `churn` | measured, net before fees |
| `providers` | the provider runway (0184 + the Billing ledger) → `paymentPlan()` | measured (provider's reading) or estimated (top-ups − spend) |

Every figure is `measured`, `estimated` or `unknown` with its reason, and carries `as_of`. Internal and demo workspaces are
excluded. Vendor costs and balances are in this object: it is owner-role output only.

## Payment plan

`lib/owner-analytics/payment-plan.ts`: per provider, what is left (measured or estimated), the 14-day pace, the run-out day, the
provider's own top-up page, and for the next 10 days what to pay and by when. Amount = 10 × the 14-day pace, rounded up to the
provider's minimum top-up when one is known — none is recorded today, so a line says "minimum not recorded". Empty (the newest
job or probe was refused for want of balance) comes first and is due today. Unknown is listed as unknown, never as "nothing to
pay". A provider that recharges itself is not due. The 14-day pace is unknown unless the nightly mirror is fresh (a stale
ledger would divide 14 days into a few days of spend and read as safe), and a provider whose empty check could not run is
listed as unknown, never as fine. Days are UTC calendar days.

## Isolation (an owner-data leak is CRITICAL)

- Database: 0197's functions, 0182's and 0184's all check the platform owner before reading anything; the lab proves a customer,
  a workspace admin, a platform admin, anon and the service key get 42501 (`tests/security/test_sec_owner_brain.py`).
- Code: `buildOwnerFacts()` throws `OwnerOnlyError` unless `ownerAccess()` is "owner", and `SecondFactorRequiredError` when
  0107's second-factor gate refuses the session (`admin_aal_ok()`), both before any read: a stolen password gets no part of it.
- Customer-typed text: workspace and channel names are masked of anything e-mail-shaped, capped, and listed in
  `untrusted_fields`; the owner's AI must quote them as data. The doctor's verdict is read only from the platform's own
  channel-less row and only as `ok` / `fail` (a customer can write alert rows for their own channel), and every alert window
  is bounded by now() (`tests/security/test_sec_breach_owner_brain_r1.py`).
- Import graph: no route outside the owner zones, and nothing under `lib/brain/`, may import the facts, directly or through
  another file, and no file outside the owner zones may even name the module (`tests/owner-brain-facts.test.ts`). The owner's AI route lives under `app/api/brain/owner/`.

## Owner AI (/owner/ai)

`POST /api/brain/owner/turn` answers one owner question from the facts above, with the chat model the owner chose (0198's
`ai_chat_owner_settings`, through S5's `callChatModel`). It is not the Studio's planning chat.

- **Order.** Same-origin POST → signed in → platform owner (404 otherwise, before anything is read) → the chosen model is on sale and
  keyed (409 with the reason otherwise; no other model is tried) → the facts, built server side (401 `second_factor`) → a turn
  reserved under the daily cap (0202, 429) → the model → the turn finished with how it ended.
- **Answers and drafts only.** The model has no tools and the route no action: nothing it says is executed. The rules
  (`lib/owner-console/ai-prompt.ts`) forbid inventing, keep the measured / estimated / unknown tags, and treat customer-typed
  text in the facts as data; a closing tag inside a value is defused so it cannot end the data block.
- **What reaches the browser.** The answer, an optional draft, the facts' time and the model id — never the facts or the raw reply.
  Nothing about the question or the answer is logged or stored; the conversation lives in the tab.
- **Failures name their remedy** (rule 6): a missing key, a model switched off, the provider out of balance, rate limits, a
  timeout, a reply in the wrong shape, the daily cap, a migration not applied.
