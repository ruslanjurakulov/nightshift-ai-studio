---
name: check-balance-and-costs
description: Read the Nightshift API balance, holds, month spend and limits, and explain what a job was held and charged. Use when checking funds before spending, when asked what something cost, or when a spend limit or insufficient-balance error appears.
---

# Check balance and costs

Everything here is read-only and free.

## The balance

```bash
nightshift balance
nightshift balance --json
```

| Field | Meaning |
| :-- | :-- |
| Available (`available_cents`) | What a new job can use now: balance minus holds |
| Balance (`balance_cents`) | Money in the account |
| On hold (`reserved_cents`) | Held for jobs that have not finished. Released if they fail, charged if they succeed |
| Spent this month (`month_spend_cents`) | Captured charges plus holds still open |
| Monthly limit (`monthly_limit_cents`) | The organization's cap this calendar month |
| Tier | The usage tier; sets requests per minute and videos at once |

Amounts are US cents in JSON; the CLI prints dollars. If a number is missing the CLI prints `unknown` or `none reported`. Report it that way. Do not turn it into `$0.00`.

Limits for the key in hand:

```bash
nightshift whoami
```

shows requests per minute, videos at once, the monthly limit and the key's own monthly limit if one is set.

## What a job cost

```bash
nightshift jobs get 123
```

The `Charge` line is one of:

- `held $X, not charged yet`: the job is still running. It is charged only if it succeeds.
- `charged $X (held $Y)`: it succeeded. That is the final cost.
- `nothing charged (the $Y hold was released)`: it failed or was cancelled.

A video is charged the price for the length that was requested, never more than the hold.

Downloads: `nightshift download request` prints `Price: $X` and charges when the file is ready. Ordering the same video and quality again within 7 days is free (`Reusing an existing download (free)`). Publishing is free.

## Two different pots

- **Videos and downloads:** the USD API balance (`nightshift balance`).
- **Generations (`nightshift generate`):** the organization's credits. The API only tells you the price of one generation (`nightshift quote`) and what was held and charged for it. The credit balance is in the web app.

## Prices

Prices are a live list that an operator can change, so never state one from memory or from an old transcript. The list is at `https://nightshift-ai.studio/docs/api#pricing`. Actual numbers come from the command output (`price_cents`, `Held`, `Price`).

## Topping up

Top-ups are made by a person in **Developers > Billing**. You cannot top up from the CLI or MCP.

## When something is blocked

- `insufficient_balance`: Available is below the price. Nothing was charged. A person tops up.
- `monthly_limit_reached`: the organization's limit. An owner or admin raises it in **Developers > Limits**.
- `key_limit_reached`: this key's own limit. Raise it or use another key in **Developers > API keys**.
