# Nightshift Brain dashboard: design note

The customer's `/{channel}/brain`: their channel, their credits and how long the credits last, what they made, and what the
Brain remembers, on one screen. One page, so the decision is visible: what is happening, what it costs, what to do next.

## What we took from the best dashboards (principles, not pixels)

We studied how Linear, Vercel, Stripe, PostHog and Raycast lay out an overview. We copied no layout, icon or colour from
them. The habits we kept:

| Habit | Where it shows up there | How we apply it |
| :-- | :-- | :-- |
| **One big number per card, the label above it** | Vercel usage, Stripe home | `t-label` over `t-figure`; one figure leads each card, and the rest are small muted lines |
| **Charts are quiet** | Linear insights, Vercel analytics | One 1.5 px stroke and an 8% fill, with no axes or gridlines. A quiet fortnight stays a flat line and is never rescaled to look busy |
| **Freshness travels with the number** | PostHog "computed N min ago" | "fetched N min ago" beside every number read from elsewhere. The clock ticks while the page is open |
| **Estimates are labelled** | Stripe's forecasts | An "estimate" chip on the credit forecast, the method in one line ("from the last 14 days"), and what it leaves out ("scheduled runs are not included") |
| **Calm empty states with one next step** | Linear | A sentence that says what will appear and from where. No illustration wall, no fake rows |
| **Fast** | Raycast | A single server read (`brain_org_facts`) and no client fetch on load. The page is fully rendered HTML |

## Our rules on top (CLAUDE.md)

- **Unknown is "unknown"**, a hidden subscriber count is "hidden", and a failed read is a sentence plus "Try again". None of these is ever a 0.
- **The browser never spends.** The only button that asks for anything is the channel refresh, which writes a request row (S10's `research_request_refresh`) and stops.
- **Costs stay private.** The page and `GET /api/brain/facts` show only credits charged to this workspace. They never show a vendor cost, a price list or a margin, and a lab test pins this.

## Layout

| Width | Layout |
| :-- | :-- |
| 1440 | Two columns: Channel / Credits, then Projects / Memory, then a full-width retention note |
| 390 | One column in the same order, 44 px keys, no horizontal scroll |

Tokens are the app's own: `--color-*`, `--ns-r-*`, `t-label`, `t-figure`, `.panel`. It is the same panel as Usage and Library, in light and dark.

## The figures, and where each comes from

| Figure | Source | Honest edge |
| :-- | :-- | :-- |
| Available now, renewal | `usage_summary` (0094) via `brain_org_facts` | An exempt workspace says it is not charged |
| Spend by tool | ledger captures, grouped by reference: `cj:` + capability, `rj:`/`gh:`, `fm-`, `ee:` | Chat reads "free within your plan" |
| Lasts until | the 14-day calendar average, quiet days included | No date on no spend, an unknown balance or a short history |
| 70% warning | plan credits spent / granted this period | No warning when either figure is unknown |
| Channel | S10's `research_own_channel` / `research_comment_themes` | Their statuses are shown as they come. Analytics runs about 48 h behind, and the page says so |
| Projects | the org's videos and their latest snapshot | "no statistics yet" instead of 0 views |
| Memory | counts of characters, style kits, brand domains | Edit and delete happen on the existing Brand look page |

## Screenshots

`shots/` holds the page at 390 and 1440 px, in light and dark: a full workspace, an empty one, and the read-failed state.
