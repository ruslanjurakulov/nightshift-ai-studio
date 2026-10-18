# Marketing posts: the brand channel (Telegram first)

Status: **designed, and the first two slices are built but dormant** (migration 0108, `docs/news/`). Nothing
posts anything today. "(unverified)" marks a fact that was not confirmed in the repository or in the official
documentation.

## What the owner decided

- **Every post needs a person's explicit approval.** Never automatic, no timer, no "auto-approve" setting.
- Three kinds: real **news** (a shipped change), **showcase** (a video the owner marked public), **price**
  (the plans, from the database).
- Texts in **Uzbek, Russian and English**, in **one Telegram message with three labelled blocks**.
- At most **2 posts in any rolling 7 days**, enforced in the database.
- **Telegram channel first.** Instagram is deferred.

## Findings that shape the design

1. **There is no "public showcase" flag for videos.** The videos on `/studio` and the landing are Pexels stock
   (`lib/site/media.ts` says so). They must never be posted as "made with Nightshift". A showcase post needs a
   new, explicit owner action on a video of the operator's own organization (a later slice).
2. **No money price is in the database.** `plans` holds credits and entitlements; currency amounts come only from
   Paddle's price preview or the owner-typed `NEXT_PUBLIC_PRICE_DISPLAY_*`. Version 1 has **no currency amount**.
3. **There is no changelog.** Commit titles are developer and security language, so news is a curated file
   (below), not generated from git.
4. **The operator bot must not approve.** It stays read-only (`docs/operator-bot.md`). A Telegram "Approve" button
   would replace password plus authenticator code with "whoever holds the allow-listed Telegram account", and would
   need a service-key write path. Recommended: an alert with a count and an "Open" link only.

## Architecture

```
docs/news/<date>-<slug>.json ──► marketing worker ──► marketing_draft_upsert ──► marketing_posts (draft)
plans / plan_entitlements   ──►  (later slices)                                        │
                                                                              owner page (later)
                                              owner_marketing_edit / approve / reject / kill
                                                                                       │ approved
marketing worker ◄── claim_marketing_post (one post, under a lock) ◄──────────────────┘
      │ sendMessage to the one configured channel
      └──► complete_marketing_post (sent | failed | dead | retry)
```

### Source of truth for news: a reviewed file, not a model

One file per announceable change in `docs/news/`, added in the pull request that ships it
([format and rules](news/README.md)). Claude drafts the three texts in that pull request and the owner merges it,
so every claim is a reviewed diff line. The worker image contains the deployed commit's `docs/` (the Dockerfile
copies the repository and `.dockerignore` does not exclude `docs/`; that every merge rebuilds the image is
unverified), so only what is deployed can be announced. `public: true` is a human decision per file; security work
is never news by default. **No language model in phase 1**: templates plus Claude-written pull request text remove a
whole class of invented claims. Mechanical checks (`tests/test_news_format.py`): three languages, a short paragraph
each in its own script, the same numbers in all three, no placeholder or URL, and the banned-claims list.

### Tables (migration `0108_marketing_posts.sql`)

- `marketing_posts`: kind `news | showcase | price`, `target` (`telegram` only; a column so Instagram later is a new
  sender and token, not a redesign), the status, `texts` (exactly `uz`, `ru`, `en`), `media_path` (public `showcase/`
  bucket only), `source_ref` (`pr:#N`, `plan:<ids>`, `asset:<uuid>`), `facts` with `facts_as_of`, the approval
  (`approved_by`, `approved_at`, `approved_hash`, `expires_at`), the send record, and a unique `idempotency_key`
  (`news:<slug>`, `price:<plan-set>:<yyyy-mm>`, `showcase:<asset id>`), so the same thing is never drafted twice.
- `marketing_settings`: one row. `enabled` (false), `max_per_7d` (2, `CHECK` 0..2), `facts_max_age_hours` (24),
  `approval_ttl_hours` (72).
- `showcase_assets`: the explicit "this video is public" list, limited by a `CHECK` to the operator's own
  organization. Closed; its owner functions come later.

Row-level security is on for all three and every API role's table grants are revoked. Only a platform admin may
`SELECT` `marketing_posts` (one policy). Every write is a `SECURITY DEFINER` function with a pinned `search_path`.
The browser never holds the service key.

### Status machine (a trigger, so it holds for every writer)

```
draft ─► approved ─► sending ─► sent | failed | dead
  │         │  ▲         └─► approved   (only a request that never left: rate limit, refused connection)
  │         └─► draft    (an edit voids the approval)
  ├─► rejected
  └─► expired      (draft or approved)
```

- **Approval** needs the approver, the time, an expiry and a hash equal to the hash of the content as it stands.
  `owner_marketing_approve(id, content_hash)` takes the hash the owner was looking at and refuses if the post
  changed since (`content_changed`), if a price post's facts are older than 24 h, or if the week's slots are already
  used or promised.
- **Edit after approval** returns the post to draft and clears the approval (`owner_marketing_edit`, and the trigger
  for any other writer). What goes out is exactly what the owner saw.
- **Claim** (`claim_marketing_post`, service key only) takes one advisory lock, then: settles lost leases and
  expired approvals; returns nothing if `enabled` is false; returns nothing if sent, sending and dead posts in the
  last 7 days already reach `max_per_7d`; otherwise hands out the oldest approved post whose approval has not
  expired, is under 72 h old, and whose `approved_hash` equals the recomputed hash. So the cap and the kill switch
  hold even if the worker or the app is buggy.
- **A lost lease** ends as `dead` / `unconfirmed` and is **never sent again** (Telegram has no idempotency token; a
  missed post is better than a duplicate: the same rule as migration 0102). A dead post keeps its slot for the week,
  because it may be on the channel. Only a request that never left is retried.
- **Final rows are frozen and no row is deleted**: a deleted row would forget its key and let a news item be drafted
  again.

### Owner actions and audit

`owner_marketing_get / edit / approve / reject / kill` go through `owner_guard()` of migration 0107: signed in,
platform owner/admin, the second factor (`admin_aal_ok()`), a per-person rate limit. Each writes `app_audit_log` and
`security_events` in the same transaction, so a change whose audit cannot be written does not happen. Audit names:
`marketing.edit | approve | reject | send | fail | kill`, and `showcase.mark | revoke` (reserved). The kill switch
(`owner_marketing_kill(true)`) stops claims at once; re-arming (`false`) needs a written reason.

## Safety

- **No auto-publish.** The database allows `sending` only from `approved` with a matching hash and a live approval.
  `marketing_settings.enabled` is false until the owner re-arms it. Later, the app and the worker add their own
  switch (`NIGHTSHIFT_MARKETING_POSTS`, default off); both must be on.
- **Unknown is not a number.** Prices and limits come only from `plans` / `plan_entitlements` at draft time; facts
  carry `facts_as_of`; a failed read produces no draft, not a default. The free entry is "a one-time welcome grant
  of 100 credits" (migration 0027), never "free".
- **No claims we cannot back**: `docs/news/banned-claims.json` (free, unlimited, guaranteed, best, income or views
  promises, certainty words, endorsement, provider and model names). Showcase posts must say the video is a sample
  made with the product and must not imply endorsement by YouTube or any provider. Whether local law or YouTube
  requires an AI-disclosure label is not defined in the repository: ask the owner.
- **Secrets.** A dedicated bot token that appears only inside the request URL held by `TelegramClient`; logs carry
  codes and counts only; a test sends a fake token through every failure path (later slice). Never reuse the
  operator bot's or the customer bot's token: the customer bot would give the customer notify worker the power to
  post publicly.
- **Failures are visible** with a closed code list (`blocked`, `bad_request`, `not_configured`, `rate_limited`,
  `network`, `http_5xx`, `unconfirmed`, `expired`) and the fix named for each on the owner page.

## What is built and what is not

| # | Slice | State |
|---|---|---|
| 1 | `docs/news/` format, banned claims, `tests/test_news_format.py`, this document | built |
| 2 | Migration 0108 and its security-lab tests, rollback `docs/sql/rollback_0108_marketing_posts.sql` | built, dormant |
| 3 | Telegram media sender (`sendPhoto`, `sendVideo`) and the fake server | not started |
| 4 | `tools/marketing_worker.py`, compose service, `.env.marketing.example`, deploy wiring, off by default | not started |
| 5 | News drafting from `docs/news`, price template from the database | not started |
| 6 | Owner page `/{channel}/marketing`, APIs, en/ru/uz strings, confirm sheet, all states, 390 px | not started |
| 7 | Operator-bot alert kind `marketing` (a count and a link only) | not started |
| 8 | Showcase mark/revoke, public bucket, showcase posts (the biggest unknown: where a finished video file lives and how to export it) | not started |
| 9 | A currency amount in price posts (a timestamped capture); Instagram | not decided |

## What the owner does by hand (when the worker exists)

1. In Telegram, @BotFather, `/newbot`, a name and a username ending in `bot`. Copy the token; paste it nowhere
   except step 3.
2. In the channel (`t.me/nightshiftaistudio`), Manage channel, Administrators, add the new bot with only "Post
   messages".
3. GitHub, Settings, Secrets and variables, Actions: secret `TELEGRAM_CHANNEL_BOT_TOKEN`; variable
   `MARKETING_TELEGRAM_CHAT` = `@nightshiftaistudio`.
4. Set variables `NIGHTSHIFT_MARKETING_WORKER` = `on` and `NIGHTSHIFT_MARKETING_POSTS` = `on`, then run Deploy web.
5. Re-arm the database switch on the Marketing page (or `owner_marketing_kill(false, '<reason>')`).
6. There is deliberately **no "send test" button** (a test would be a public post). The first real approved draft
   is the test; delete it by hand in Telegram if it is wrong. A private test channel is an open question.

To stop: set `NIGHTSHIFT_MARKETING_POSTS` to anything but `on`, tap the kill switch, or run
`update public.marketing_settings set enabled = false;` in the SQL editor.

## Instagram: deferred

The official publishing API needs an Instagram professional account, a Meta developer app with the content-publish
permissions (and review, whose scope for a single own account is unverified), public media URLs at publish time,
and a refreshed long-lived token (another secret and another rotation job). Two posts a week is little reach for that
work. Decision: wait until Telegram has run for a few weeks. No scraping, no unofficial APIs, no third-party
reposters. The `target` column keeps the model channel-neutral.

## Open questions for the owner

1. Is "rolling 7 days" right, or the calendar week in `Asia/Tashkent`? (Built as rolling.)
2. Should a price post ever carry a dollar figure, and from which source? May promo discounts be advertised?
3. Required AI-disclosure wording for videos in public marketing (YouTube, local law).
4. Who reads the Russian and Uzbek wording? (The existing notification wording is a machine draft too.)
5. Does the owner want a private test channel first (one more variable)?
6. Is Telegram's 1024-character caption limit and 50 MB bot upload limit current? (The 50 MB figure was confirmed in
   the Bot API FAQ; the caption and URL-fetch figures are from memory: unverified. The texts are kept short enough
   to fit a caption in any case.)
